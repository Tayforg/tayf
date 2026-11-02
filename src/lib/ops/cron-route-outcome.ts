import { after, connection } from "next/server";
import { checkBearer } from "@/lib/api/bearer";
import { createServerClient } from "@/lib/supabase/server";

/**
 * App-side outcome record for the Vercel cron routes (h12-ops-1, migration 136).
 *
 * `ops_health_report()` used to read only the database. On 2026-10-31 and
 * 11-01 the headline route answered 500 for 18+ hours (189 statement timeouts
 * on its pick query) and every row stayed green, because a Vercel cron route
 * that fails leaves no trace in pg_cron, pg_net or ingest_cycles.
 * `withCronOutcome` closes that gap: it wraps a route handler and, once the
 * response is on its way, writes one row (route, status, duration) through the
 * service-role RPC `ops_cron_route_run_record`. Row 15 of `ops_health_report()`
 * (`cron_route_failures_30m`) reads `public.ops_cron_route_runs`.
 *
 * Rules it keeps (tests/lib/ops/cron-route-outcome.test.ts):
 *  - Only AUTHENTICATED requests are recorded: `CRON_SECRET` set and a
 *    matching bearer, the same check `requireCronBearer` makes. A public
 *    caller (a 401, or a 503 because the secret is unset) cannot grow the
 *    table or fake a failure.
 *  - The write is scheduled with `after()`, so it can neither delay nor break
 *    the response. It runs on a client with a 2 s cap
 *    (`CRON_OUTCOME_TIMEOUT_MS`); an error, a rejection or a missing
 *    `after()` scope (vitest, scripts) is swallowed.
 *  - A failing write is logged at most once per instance, with the route and an
 *    error code only: never a header, a token or an error message.
 *  - `await connection()` comes first, so no clock is read while Next prerenders
 *    the route (cacheComponents).
 *  - A run that answers below 500 but swallowed a failed sub-step is recorded as
 *    599 (h18-jobs-1, below).
 *
 * 599 = "200 with a failed sub-step". A route can log a failed database call and
 * still answer 200 on purpose (the headline route's re-pick must not undo the
 * writes it already made). On 2026-11-01 23:15-23:55 UTC the re-pick RPC failed
 * with 42501 on 9 ticks in a row, each tick was recorded as 200, and row 15 of
 * `ops_health_report()` (`status >= 500`) stayed green. Such a route now counts its
 * swallowed database failures and sets the internal response header
 * `x-cron-substep-errors: <n>`. When n > 0 and the response is below 500, the
 * wrapper records `CRON_SUBSTEP_FAILURE_STATUS` (599) instead of the real status;
 * row 15 counts it as a failure: the first one makes the row warn, and it fails
 * once the failures are at least 2 and at least half of the route's runs in the
 * 30 minute window (for a 5 minute cron that is the 3rd consecutive bad tick, or
 * the 4th when the window holds 7 runs). The caller (Vercel cron) still gets the real status, normally 200: the
 * header is stripped from every response that carries it, whether or not the run
 * is recorded, so it never leaves the server. A real 5xx keeps its own status.
 * The table accepts 100-599 (migration 136), so no schema change is needed.
 *
 * What each of the five routes counts (the guard in
 * tests/guards/cron-route-outcome.test.ts pins every `if (<name>) {` branch):
 *  - headline: the swallowed database failures of the pick (`memberErr`,
 *    `writeErr`, `rejectErr`, `repickErr`). LLM vendor failures, empty or
 *    rejected rewrites and pick throws are not counted.
 *  - fact-checks: the cluster search (`clusterErr`), member titles
 *    (`memberErr`), existing links (`existingErr`), the promote update
 *    (`promoteErr`) and the new-links upsert (`insertErr`). A publisher feed that
 *    fails to fetch is a vendor failure and is not counted.
 *  - alerts-webhooks: the fresh blindspot re-read (`freshError`), the enqueue
 *    upsert (`upsertError`), the exhausted-delivery update (`exhaustedError`),
 *    the unknown-keys read (`extraError`), the delivery-outcome update
 *    (`updateError`) and the webhook-health update (`hookUpdateError`). A webhook
 *    POST that fails is the subscriber's endpoint, not ours, and is not counted.
 *  - social: the fresh re-read (`freshError`), the ledger read (`ledgerError`,
 *    which also fails closed with a "ledger unavailable" skip), the claim rpc
 *    (`claimError`) and every `social_post_finish` rpc (`finishError`, one local
 *    helper). A Telegram or Bluesky post that fails is not counted.
 *  - digest: the `last_sent_at` write after a successful send (`updateError`) and
 *    a failed rights-gated summary member lookup (`memberLookupFailed`: the
 *    summaries are hidden, fail closed, but the run is degraded). A Resend send
 *    that fails is not counted.
 * A route builds its response init with `substepErrorsInit(count, init)` and puts
 * `substepErrors: <n>` in the body, plus a success flag of `substepErrors === 0`
 * where the body already had one. Status codes do not change (still 200).
 *
 * Wrap OUTSIDE `withApiErrors`: that turns a thrown error into a 500 response,
 * which is the status this records. Every `/api/cron/<name>/route.ts` must do
 * `export const GET = withCronOutcome("<name>", withApiErrors(...))`
 * (tests/guards/cron-route-outcome.test.ts).
 */

/** Per-request cap of the outcome write; the work after the response must stay short. */
export const CRON_OUTCOME_TIMEOUT_MS = 2000;

/**
 * Internal response header: how many database calls a cron route swallowed on a
 * run it answered below 500. Read and stripped by `withCronOutcome`.
 */
export const CRON_SUBSTEP_ERRORS_HEADER = "x-cron-substep-errors";

/** The status recorded for a below-500 run that carried a positive sub-step error count. */
export const CRON_SUBSTEP_FAILURE_STATUS = 599;

/** Same shape as the CHECK on `ops_cron_route_runs.route` (migration 136). */
const ROUTE_PATTERN = /^[a-z0-9-]{1,40}$/;

let warned = false;

/** Logs at most once per module instance; callers pass a route and a short code, never a message. */
function warnOnce(message: string, context: { route: string; code: string }): void {
  if (warned) return;
  warned = true;
  console.warn(message, context);
}

/** `error.code` of a PostgREST error object, or a fixed word. Never its message. */
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_-]{1,20}$/.test(code) ? code : "unknown";
}

/** The class name of a thrown value (`TypeError`, `AbortError`), or a fixed word. */
function errorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z0-9_]{1,40}$/.test(error.name) ? error.name : "unknown";
}

/**
 * The sub-step error count a route set on its response: 1 to 6 plain digits and
 * more than zero, else 0 (a missing, empty, signed, fractional or non-numeric
 * header counts as no failure).
 */
export function substepErrorCount(response: Response): number {
  const value = response.headers.get(CRON_SUBSTEP_ERRORS_HEADER);
  return value !== null && /^\d{1,6}$/.test(value) ? Number(value) : 0;
}

/** The largest count the header carries; `substepErrorCount` reads 1 to 6 digits. */
const MAX_SUBSTEP_ERRORS = 999_999;

/**
 * The `ResponseInit` of a cron route that counted `count` swallowed failures: the
 * caller's `init` plus the internal header `x-cron-substep-errors: <count>`. A count
 * that is not a positive finite integer (0, NaN, negative, fractional, infinite)
 * adds nothing and returns `init` itself (possibly `undefined`). The count is
 * clamped to 999999, the largest value `substepErrorCount` accepts. The caller's
 * `init` and its headers are not mutated.
 */
export function substepErrorsInit(count: number, init?: ResponseInit): ResponseInit | undefined {
  if (!Number.isInteger(count) || count < 1) return init;
  const headers = new Headers(init?.headers);
  headers.set(CRON_SUBSTEP_ERRORS_HEADER, String(Math.min(count, MAX_SUBSTEP_ERRORS)));
  return { ...init, headers };
}

/** The same response without the internal header; a response that never had it is returned as is. */
function withoutSubstepHeader(response: Response): Response {
  if (!response.headers.has(CRON_SUBSTEP_ERRORS_HEADER)) return response;
  const headers = new Headers(response.headers);
  headers.delete(CRON_SUBSTEP_ERRORS_HEADER);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function authorizationOf(request: unknown): string | null {
  const headers = (request as { headers?: { get?: unknown } } | null | undefined)?.headers;
  return headers && typeof headers.get === "function" ? (headers as Headers).get("authorization") : null;
}

async function record(route: string, status: number, durationMs: number): Promise<void> {
  try {
    const { error } = await createServerClient({ timeoutMs: CRON_OUTCOME_TIMEOUT_MS }).rpc(
      "ops_cron_route_run_record",
      { p_route: route, p_status: status, p_duration_ms: durationMs },
    );
    if (error) warnOnce("[cron-outcome] kayıt yazılamadı", { route, code: errorCode(error) });
  } catch (err) {
    warnOnce("[cron-outcome] kayıt yazılamadı", { route, code: errorName(err) });
  }
}

/** Schedules the write for an authenticated request. Never throws. */
function schedule(route: string, request: unknown, status: number, startedAt: number): void {
  try {
    const secret = process.env.CRON_SECRET;
    if (typeof secret !== "string" || secret.length === 0) return;
    if (!checkBearer(authorizationOf(request), secret)) return;
    const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
    // `after()` throws outside a request scope (vitest, scripts): then there is nothing to record.
    after(() => record(route, status, durationMs));
  } catch (err) {
    warnOnce("[cron-outcome] kayıt zamanlanamadı", { route, code: errorName(err) });
  }
}

/**
 * Wraps a cron route handler (same signature) so that every authenticated run
 * leaves a row in `public.ops_cron_route_runs`. `route` is the folder name under
 * `src/app/api/cron/` and must match `/^[a-z0-9-]{1,40}$/`, like the table
 * check; a bad literal throws when the module loads, not on the first request.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withCronOutcome<T extends (...args: any[]) => Promise<Response>>(
  route: string,
  handler: T,
): T {
  if (!ROUTE_PATTERN.test(route)) {
    throw new Error(`withCronOutcome: invalid route ${JSON.stringify(route)}; expected ${ROUTE_PATTERN}`);
  }
  return (async (...args: Parameters<T>) => {
    await connection();
    const startedAt = performance.now();
    // A throw that escapes the handler is a 500 for the heartbeat.
    let status = 500;
    try {
      const response = await handler(...args);
      const substeps = substepErrorCount(response);
      status =
        substeps > 0 && response.status < 500 ? CRON_SUBSTEP_FAILURE_STATUS : response.status;
      return withoutSubstepHeader(response);
    } finally {
      schedule(route, args[0], status, startedAt);
    }
  }) as T;
}
