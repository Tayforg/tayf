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
 *
 * Wrap OUTSIDE `withApiErrors`: that turns a thrown error into a 500 response,
 * which is the status this records. Every `/api/cron/<name>/route.ts` must do
 * `export const GET = withCronOutcome("<name>", withApiErrors(...))`
 * (tests/guards/cron-route-outcome.test.ts).
 */

/** Per-request cap of the outcome write; the work after the response must stay short. */
export const CRON_OUTCOME_TIMEOUT_MS = 2000;

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
      status = response.status;
      return response;
    } finally {
      schedule(route, args[0], status, startedAt);
    }
  }) as T;
}
