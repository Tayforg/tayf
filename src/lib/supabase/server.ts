import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Fail-fast budget for user-facing reads. PostgREST's `statement_timeout` is
 * 8 s; on the Micro compute tier (256 MB shared_buffers against a 5.2 GB
 * database) a cold read routinely runs into it, and a visitor then waits the
 * full 8 s for an error. 4 s leaves the retry/fallback paths (live retry,
 * "Tekrar dene") room to act inside a request instead of after it.
 */
export const READER_TIMEOUT_MS = 4000;

/**
 * Budget for the "slow reader" set (see `createSlowReaderClient`): just above
 * PostgREST's 8 s `statement_timeout`, so a black-holed connection is bounded
 * without cutting a statement Postgres would still have finished.
 */
export const READER_SLOW_TIMEOUT_MS = 9000;

export interface ServerClientOptions {
  /** Abort any single Supabase HTTP request that takes longer than this. */
  timeoutMs?: number;
}

// Statuses whose response can never carry a body (fetch spec "null body
// status", plus 101): withFetchTimeout returns those untouched.
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304]);

/**
 * How far past its deadline a timeout may fire before it counts as a STALLED
 * timer (a frozen or blocked event loop) rather than a slow request. 1.5 s is
 * well above the few ms of ordinary timer jitter and well below the 6 s to
 * 267 s of the late timers seen in production (h83-runtimeerrors-1).
 */
export const STALLED_TIMER_SLACK_MS = 1500;

/**
 * True when a timeout that was armed for `timeoutMs` fired only after
 * `elapsedMs`, more than `STALLED_TIMER_SLACK_MS` late. Pure: the clock is the
 * caller's. A NaN or negative elapsed is never stalled.
 */
export function isStalledTimeout(elapsedMs: number, timeoutMs: number): boolean {
  return elapsedMs > timeoutMs + STALLED_TIMER_SLACK_MS;
}

/** Test seam for `withFetchTimeout`: the monotonic clock. */
export interface FetchTimeoutDeps {
  /** Milliseconds on a monotonic clock. Defaults to `performance.now()`. */
  now?: () => number;
}

/**
 * Whether a request may be issued a second time after its first attempt was
 * aborted by a stalled timer: GET or HEAD only (the method is `init.method`,
 * else the `Request`'s own, else GET; compared case-insensitively) and with no
 * body anywhere, so no body stream can be consumed twice. A GET/HEAD cannot
 * legally carry one, so the body checks are a guard, not a limitation.
 */
function isReplayableRead(input: RequestInfo | URL, init: RequestInit | undefined): boolean {
  const request = input instanceof Request ? input : undefined;
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  if (init?.body != null) return false;
  if (request && (request.body !== null || request.bodyUsed)) return false;
  return true;
}

/**
 * Wrap `fetch` so a request that outlives `timeoutMs` is aborted.
 *
 * Capped clients (`createServerClient({ timeoutMs })`) are built with
 * `db: { retry: false }`, so postgrest-js's `fetchWithRetry`
 * (node_modules/@supabase/postgrest-js/dist/index.cjs, ~l.199-235) never
 * retries them: it would otherwise retry GET/HEAD up to 3 times with 1 s /
 * 2 s / 4 s backoff (or the response's `Retry-After`, uncapped) on a 503 or
 * 520 and on any fetch rejection that is not an abort, which turned a
 * Supabase outage into about 7 s per request under a 4 s cap.
 *
 * The re-throw as an `AbortError` below stays as a SECOND guard (belt and
 * braces if a client is ever built without `retry: false`): a `TimeoutError`
 * (what `AbortSignal.timeout()` rejects with) only counts as an abort for
 * `fetchWithRetry` when the BUILDER's own signal aborted, and ours is a
 * different signal. Without the rename a retrying client's 4 s cap silently
 * becomes about 4 + 1 + 4 + 2 + 4 + 4 + 4 = 23 s.
 *
 * A caller-supplied `init.signal` is combined with the timeout, and a
 * caller abort propagates with the caller's own reason (never relabelled
 * as a timeout). `globalThis.fetch` is resolved at call time so tests can
 * stub it.
 *
 * BODY PHASE (h28-errors-2). `AbortSignal.timeout()` stays attached to the
 * response body after `fetch` has resolved with the headers. A timer that
 * fires while `res.text()` is still reading rejects the body stream with a
 * `TimeoutError` DOMException OUTSIDE the try/catch above; postgrest-js then
 * surfaced `{ message: "TimeoutError: The operation was aborted due to
 * timeout", code: "", status: 0 }`, which `isUpstreamUnavailable` did not
 * recognise, so the keyed /api/v1 routes answered a 500 for what is an outage.
 * The body is therefore re-wrapped: a pull-based `ReadableStream` that reads
 * the original body and, when a read rejects because OUR timer fired (and the
 * caller's signal did not), errors with the same relabelled `AbortError` as the
 * header phase. Any other body error (a caller abort, a reset connection) is
 * passed through untouched, and `cancel(reason)` is forwarded so a consumer
 * that stops early still releases the connection. Nothing is buffered
 * (`highWaterMark: 0`: a chunk is read only when the consumer asks for one), so
 * streaming and backpressure are preserved. The wrap is skipped, and the very
 * same `Response` returned, when there is no body to wrap (`res.body === null`,
 * i.e. a HEAD answer or `new Response(null)`) or the status forbids one (101,
 * 204, 205, 304). The rebuilt `Response` carries `status`, `statusText` and
 * `headers`; `url` and `redirected` are NOT carried over (a constructed
 * `Response` cannot set them), which is fine because postgrest-js and
 * supabase-js read neither.
 *
 * Each relabel logs ONE line, `[supabase] request exceeded <ms> ms (phase:
 * headers|body, elapsed: <n> ms)`, so a stall can be told apart from a slow
 * query in the logs. The URL and headers are never logged (they can carry
 * filters and keys). The clock is `performance.now()`, not `Date.now()`:
 * Next 16 cacheComponents treats `Date.now()` as prerender IO and fails the
 * build when an uncached prerender path reads it; `performance.now()` is the
 * monotonic interval clock the Next docs point to for measuring durations.
 *
 * STALLED TIMERS (h83-runtimeerrors-1). Most `request exceeded 4000 ms` lines in
 * production carried an elapsed far past the timer (6 s to 267 s), not ~4 s:
 * the event loop was frozen or blocked, and Node runs expired timers before I/O
 * callbacks, so the abort can win even when the response has already arrived.
 * A late timer means the request was PROBABLY stalled, not proven: a genuinely
 * slow query that is still running while the loop is blocked for more than
 * `STALLED_TIMER_SLACK_MS` is classified the same way and re-issued once, and
 * the first statement keeps running in Postgres until it finishes or hits
 * `statement_timeout`. In a `use cache: remote` entry such a failure was stored
 * as a failed read for every instance. `isStalledTimeout(elapsed, timeoutMs)`
 * (elapsed more than `STALLED_TIMER_SLACK_MS` past the budget) separates the
 * two as a heuristic:
 *   - HEADER phase, stalled, and a GET/HEAD with no body (`isReplayableRead`):
 *     log ONE line `[supabase] stalled timer (phase: headers, elapsed: <n> ms,
 *     timeout: <t> ms), retrying once` and issue the request exactly once more,
 *     with a fresh `AbortSignal.timeout(timeoutMs)` combined with the caller's
 *     signal through `AbortSignal.any`, a fresh clock reading and the same body
 *     wrapping. A `Request` input is cloned for the retry. The first attempt's
 *     timer has already fired, so nothing of it is left running. If the retry
 *     also times out it is relabelled exactly as above (the `request exceeded`
 *     line and the `AbortError`), and there is never a third attempt.
 *   - HEADER phase on a POST (rpc) or any request with a body, or an on-time
 *     timeout: unchanged, whatever the elapsed.
 *   - BODY phase, stalled: no retry (part of the body may already be consumed);
 *     the log line is `[supabase] stalled timer (phase: body, elapsed: <n> ms,
 *     timeout: <t> ms)` instead of the `request exceeded` one, and the stream
 *     errors with the same relabelled `AbortError`, so `isUpstreamUnavailable`
 *     and the callers are unchanged.
 * `deps.now` is a test seam (default `performance.now()`, never `Date.now()`);
 * it is read once when an attempt starts and once when that attempt's timeout is
 * observed. Elapsed is per attempt, so a retry is judged by its own clock.
 */
export function withFetchTimeout(timeoutMs: number, deps: FetchTimeoutDeps = {}): typeof fetch {
  const now = deps.now ?? (() => performance.now());

  return async (input, init) => {
    const callerSignal = init?.signal ?? undefined;
    const replayable = isReplayableRead(input, init);

    /** One attempt. `canRetry` is false on the retry itself: never a third. */
    const attempt = async (attemptInput: RequestInfo | URL, canRetry: boolean): Promise<Response> => {
      const t = AbortSignal.timeout(timeoutMs);
      const signal = callerSignal ? AbortSignal.any([callerSignal, t]) : t;
      const startedAt = now();
      /** True when the abort came from OUR timer, not from the caller. */
      const isOurTimeout = () => t.aborted && !callerSignal?.aborted;
      /** Elapsed ms of THIS attempt, read once per observed timeout. */
      const elapsedMs = () => now() - startedAt;
      const relabel = (phase: "headers" | "body", elapsed: number) => {
        const ms = Math.round(elapsed);
        console.warn(
          phase === "body" && isStalledTimeout(elapsed, timeoutMs)
            ? `[supabase] stalled timer (phase: body, elapsed: ${ms} ms, timeout: ${timeoutMs} ms)`
            : `[supabase] request exceeded ${timeoutMs} ms (phase: ${phase}, elapsed: ${ms} ms)`,
        );
        return new DOMException(`Supabase request exceeded ${timeoutMs} ms`, "AbortError");
      };

      let res: Response;
      try {
        res = await globalThis.fetch(attemptInput, { ...init, signal });
      } catch (err) {
        if (!isOurTimeout()) throw err;
        const elapsed = elapsedMs();
        if (canRetry && replayable && isStalledTimeout(elapsed, timeoutMs)) {
          console.warn(
            `[supabase] stalled timer (phase: headers, elapsed: ${Math.round(elapsed)} ms, timeout: ${timeoutMs} ms), retrying once`,
          );
          return attempt(attemptInput instanceof Request ? attemptInput.clone() : attemptInput, false);
        }
        throw relabel("headers", elapsed);
      }

      if (res.body === null || NULL_BODY_STATUSES.has(res.status)) return res;

      const reader = res.body.getReader();
      const wrapped = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            let chunk: ReadableStreamReadResult<Uint8Array>;
            try {
              chunk = await reader.read();
            } catch (err) {
              controller.error(isOurTimeout() ? relabel("body", elapsedMs()) : err);
              return;
            }
            if (chunk.done) controller.close();
            else controller.enqueue(chunk.value);
          },
          cancel(reason) {
            return reader.cancel(reason);
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(wrapped, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    };

    return attempt(input, true);
  };
}

function createRealServerClient(opts?: ServerClientOptions): SupabaseClient {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. " +
        "Copy .env.local.example to .env.local and fill in your Supabase credentials."
    );
  }

  if (opts?.timeoutMs !== undefined) {
    // `retry: false`: a capped client fails fast; postgrest-js's 3 x (1/2/4 s)
    // loop would multiply the cap. The only in-client retry is
    // withFetchTimeout's single re-issue of a bodyless GET/HEAD whose
    // header-phase timer fired more than STALLED_TIMER_SLACK_MS late (see
    // STALLED TIMERS in the withFetchTimeout doc). Otherwise the caller's own
    // retry (resolveCachedOrRetry's one live retry, the "Tekrar dene" button)
    // is the only retry.
    return createClient(supabaseUrl, supabaseServiceKey, {
      db: { retry: false },
      global: { fetch: withFetchTimeout(opts.timeoutMs) },
    });
  }

  return createClient(supabaseUrl, supabaseServiceKey);
}

export function createServerClient(opts?: ServerClientOptions): SupabaseClient {
  return createRealServerClient(opts);
}

/**
 * Which Supabase client a shared read helper builds:
 *   - "reader": `createReaderClient()`, the fail-fast 4 s cap (user-facing);
 *   - "batch":  `createServerClient()`, no per-request timeout, so the read
 *     may use the full 8 s `statement_timeout` (crons, webhooks).
 *
 * A helper that serves BOTH kinds of caller (`getPoliticsClusters`,
 * `getBlindspots`, `getAlertItems`, `getZoneFeedHealth`,
 * `getRssSummaryMembers`) takes this as an option and defaults to "reader".
 * The cached entry point receives it as an argument, so it is part of the
 * `"use cache"` key: a batch caller never reads (or writes) the entry a capped
 * reader populated, and a 4 s abort is never cached for a cron. Every cron
 * call to one of them must pass `{ profile: "batch" }`
 * (tests/guards/cron-read-profile.test.ts enforces it).
 */
export type ReadProfile = "reader" | "batch";

/**
 * Client for user-facing READERS only (feed, search, politics, blindspots,
 * game pool, trends timeline, sitemaps, finance read pages): every request
 * is aborted after `READER_TIMEOUT_MS` so a cold read fails fast and the
 * caller's retry/fallback path can run.
 *
 * Capped clients skip postgrest-js's retry loop (`db: { retry: false }`): a
 * 503, a 520 or a connection failure surfaces as a single `error` straight
 * away. The one retry per request comes from `resolveCachedOrRetry`'s live
 * retry (src/lib/cache-resilience.ts) or the page's "Tekrar dene" path, so a
 * Supabase outage costs a visitor about one cap, not about 14 s. Capped
 * finance readers (`createFinanceServerClient({ timeoutMs })`) and
 * cron-route-outcome's capped RPC inherit `retry: false`; RPC POSTs were never
 * retried by postgrest-js in the first place.
 *
 * The one exception is the stalled-timer re-issue of a bodyless GET/HEAD (see
 * STALLED TIMERS in the `withFetchTimeout` doc), at most once per call: POST/rpc
 * and writes are never re-issued by the wrapper. A stalled read can therefore
 * cost about 2 x the cap per call (about 8 s for the reader, 18 s for the slow
 * reader), and with `resolveCachedOrRetry`'s live retry up to 4 HTTP requests
 * for one logical read.
 *
 * Crons, admin pages, webhooks and RPC writers must keep plain
 * `createServerClient()`: a write that is aborted client-side may still
 * commit server-side, and long admin scans legitimately need the full 8 s.
 * That rule also applies TRANSITIVELY: a shared fetcher that a cron reaches
 * (politics, blindspots, alerts, feed health, RSS summary members) must
 * expose a `ReadProfile` option instead of hard-wiring this client, and the
 * cron must pass `"batch"`.
 *
 * Note the abort caps USER LATENCY, not database load: the statement keeps
 * running in Postgres until it finishes or hits `statement_timeout`.
 *
 * SCOPE: the cap is per HTTP request, not per route. A page with k
 * sequential reads can still take about k x 4 s, so do not promise an
 * end-to-end ~4.5 s worst case for a route without counting its sequential
 * awaits. The per-request cap can also be paid twice when the stalled-timer
 * GET/HEAD re-issue runs.
 *
 * Now capped: the feed, search, politics, blindspots, game pool, trends
 * timeline, sitemaps and finance read pages above, plus the source profile
 * (`getSourceProfile`), karne (`getSourceKarne`), reader agreement
 * (`getSourceAgreement`), `/ekonomi/[ticker]`'s existence probe
 * (`tickerExistence`) and KAP pickup panel (`getTickerPickup`), the /oyun
 * daily puzzle (`getDailyPuzzle`), the public registry JSON behind
 * `/api/sources*` (`getRegistryRows` / `getRegistryDetail`,
 * src/lib/sources/registry-query.ts), and `getZoneFeedHealth` /
 * `getRssSummaryMembers` (both `ReadProfile`, "reader" by default).
 *
 * Slow readers (`createSlowReaderClient()`, 9 s, no retry): visitor-only
 * widgets whose query legitimately runs close to the 8 s `statement_timeout`
 * on a cold cache: the source feed-status summary (feed-status.ts: /sources,
 * /kaynaklar/durum, /blindspots, /hafta), the footer's active-source count
 * (active-count.ts), the /sources directory page (src/app/sources/page.tsx),
 * the headline status (headline/status.ts: /rss.xml, /metodoloji) and the
 * cluster page's fact-check box (cluster-fact-checks-query.ts). Guarded by
 * tests/guards/user-facing-reads-bounded.test.ts.
 *
 * Deliberately uncapped (keep `createServerClient()`, postgrest-js retries
 * stay on):
 *   - crons, admin pages, webhooks and writers (see above);
 *   - /api/health;
 *   - the remaining low-traffic readers: clickbait.ts, framing-receipt.ts,
 *     corrections/public-log.ts, quality/snapshots.ts;
 *   - /rapor/[token];
 *   - /api/oyun*, the newsletter and corrections routes.
 *
 * (The fact-check box is NOT flag-gated off: `isFactCheckBoxEnabled()` is
 * `FACT_CHECK_BOX !== "off"`, so it is ON by default, which is why its read
 * is a bounded visitor path.)
 */
export function createReaderClient(): SupabaseClient {
  return createServerClient({ timeoutMs: READER_TIMEOUT_MS });
}

/**
 * Client for the slow-reader set listed on `createReaderClient`: same
 * fail-fast, no-retry behaviour with `READER_SLOW_TIMEOUT_MS` (9 s) so a
 * black-holed connection is bounded but a statement Postgres would finish
 * within its 8 s `statement_timeout` is not cut. Visitor paths only: crons,
 * admin and writers keep plain `createServerClient()`.
 */
export function createSlowReaderClient(): SupabaseClient {
  return createServerClient({ timeoutMs: READER_SLOW_TIMEOUT_MS });
}

let warnedFakeFinance = false;

/**
 * Finance-only client factory (SEC-09/TS-07).
 *
 * TAYF_FAKE_FINANCE=1 in local development serves the /ekonomi pages from
 * fixture rows so the layout can be reviewed before migrations 049-051
 * exist in the database. The gate is `NODE_ENV === 'development'`
 * specifically — not `!== 'production'` — so `NODE_ENV=test` (vitest) can
 * never reach the fixture branch. The fixture module is loaded with a
 * dynamic `import()` inside the branch so it (and the chainable test
 * helper it used to import) leaves the static production bundle graph
 * entirely, rather than sitting behind nothing but this runtime check.
 *
 * Only the finance query layer (lib/finance/queries.ts) should call this;
 * every other caller keeps using the synchronous `createServerClient()`
 * above, which never has a fixture path.
 *
 * `opts` applies to the real branch only (finance READERS pass
 * `{ timeoutMs: READER_TIMEOUT_MS }`); the fixture branch makes no network
 * calls, so it ignores them.
 */
export async function createFinanceServerClient(
  opts?: ServerClientOptions,
): Promise<SupabaseClient> {
  if (process.env.NODE_ENV === "development" && process.env.TAYF_FAKE_FINANCE === "1") {
    if (!warnedFakeFinance) {
      console.warn("[finance] TAYF_FAKE_FINANCE=1 — serving /ekonomi from dev fixtures, not the database.");
      warnedFakeFinance = true;
    }
    const { createFinanceFakeClient } = await import("@/lib/finance/dev-fixtures");
    return createFinanceFakeClient() as SupabaseClient;
  }

  return createRealServerClient(opts);
}
