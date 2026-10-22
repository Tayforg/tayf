import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Fail-fast budget for user-facing reads. PostgREST's `statement_timeout` is
 * 8 s; on the Micro compute tier (256 MB shared_buffers against a 5.2 GB
 * database) a cold read routinely runs into it, and a visitor then waits the
 * full 8 s for an error. 4 s leaves the retry/fallback paths (live retry,
 * "Tekrar dene") room to act inside a request instead of after it.
 */
export const READER_TIMEOUT_MS = 4000;

export interface ServerClientOptions {
  /** Abort any single Supabase HTTP request that takes longer than this. */
  timeoutMs?: number;
}

/**
 * Wrap `fetch` so a request that outlives `timeoutMs` is aborted.
 *
 * The re-throw as an `AbortError` below is mandatory, not cosmetic.
 * postgrest-js's `fetchWithRetry` (node_modules/@supabase/postgrest-js/dist/
 * index.cjs, ~l.199-235) retries GET/HEAD up to 3 times with 1 s / 2 s / 4 s
 * backoff when `fetch` rejects with anything other than an `AbortError` /
 * `ABORT_ERR`; a `TimeoutError` (what `AbortSignal.timeout()` rejects with)
 * only counts as an abort when the BUILDER's own signal aborted, and ours
 * is a different signal. Without the rename the 4 s cap silently becomes
 * about 4 + 1 + 4 + 2 + 4 + 4 + 4 = 23 s.
 *
 * A caller-supplied `init.signal` is combined with the timeout, and a
 * caller abort propagates with the caller's own reason (never relabelled
 * as a timeout). `globalThis.fetch` is resolved at call time so tests can
 * stub it.
 */
export function withFetchTimeout(timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const t = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, t]) : t;
    try {
      return await globalThis.fetch(input, { ...init, signal });
    } catch (err) {
      if (t.aborted && !init?.signal?.aborted) {
        throw new DOMException(
          `Supabase request exceeded ${timeoutMs} ms`,
          "AbortError",
        );
      }
      throw err;
    }
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
    return createClient(supabaseUrl, supabaseServiceKey, {
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
 * awaits.
 *
 * Now capped: the feed, search, politics, blindspots, game pool, trends
 * timeline, sitemaps and finance read pages above, plus the source profile
 * (`getSourceProfile`), karne (`getSourceKarne`), reader agreement
 * (`getSourceAgreement`), `/ekonomi/[ticker]`'s existence probe
 * (`tickerExistence`) and KAP pickup panel (`getTickerPickup`), the /oyun
 * daily puzzle (`getDailyPuzzle`), and `getZoneFeedHealth` /
 * `getRssSummaryMembers` (both `ReadProfile`, "reader" by default).
 *
 * Deliberately uncapped (keep `createServerClient()`):
 *   - crons, admin pages, webhooks and writers (see above);
 *   - /api/health;
 *   - the /sources directory (feed-status.ts, active-count.ts);
 *   - flag-gated readers: clickbait.ts, framing-receipt.ts,
 *     cluster-fact-checks-query.ts;
 *   - low-traffic readers: corrections/public-log.ts, quality/snapshots.ts,
 *     headline/status.ts;
 *   - /rapor/[token];
 *   - /api/sources*, /api/oyun*, the newsletter and corrections routes.
 */
export function createReaderClient(): SupabaseClient {
  return createServerClient({ timeoutMs: READER_TIMEOUT_MS });
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
