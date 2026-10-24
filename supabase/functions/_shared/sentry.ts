// supabase/functions/_shared/sentry.ts
//
// Sentry instrumentation for the Deno-runtime Edge Functions.
//
// The Next.js side ships @sentry/nextjs (instrumentation.ts + per-runtime
// sentry config). Edge Functions are a different runtime (Deno 2.x) and the
// Next-side wiring does NOT cover them. The original audit incident was a
// 7-day cluster-cron silent outage that went undetected precisely because
// Deno-side failures route only to Supabase Edge Function logs which are
// not paged. This module closes that gap.
//
// USAGE:
//
//   import { initSentry, withSentry } from "../_shared/sentry.ts";
//   initSentry("cluster-consumer");
//   Deno.serve(withSentry("cluster-consumer", async (req) => {
//     // handler body
//   }));
//
// BEHAVIOUR:
//
//   * `initSentry` is a no-op if `SENTRY_DSN` is unset in the env (so local
//     `supabase functions serve` and CI runs without a Sentry project keep
//     working). If the DSN is present we initialise the SDK at module
//     scope so subsequent `captureException` calls don't pay a cold start.
//
//   * `withSentry` wraps a handler. Any thrown error is captured with the
//     function name as a tag (so the Sentry dashboard can filter cleanly
//     between cluster-consumer / ingest / image-consumer events) BEFORE the
//     error is re-thrown for the outer handler to log + 500.
//
//   * The `npm:` specifier (`npm:@sentry/deno@10.73.0`) is Deno 2.x's
//     compatibility layer for npm packages and is the canonical way to use the
//     Sentry SDK under the Supabase Edge Function runtime. No additional
//     install step is required — `supabase functions deploy` resolves npm:
//     specifiers at bundle time. The specifier stays a LITERAL string inside
//     the dynamic `import()` below so the deploy bundler can see it.
//
//   * The version is an EXACT pin because `deno.lock` is never committed (repo
//     rule): a bare `npm:@sentry/deno` would resolve to whatever is newest at
//     deploy time. tests/guards/edge-deps-pinned.test.ts enforces the pin, and
//     tests/functions/_shared/sentry.test.ts mocks this exact specifier, so
//     bump both together (see the bump procedure in _shared/supabase.ts).

// Minimal surface of the @sentry/deno SDK we actually call. The full SDK
// type is broad and version-volatile; typing only `init` + `captureException`
// keeps the dynamic import honest without dragging in the whole shape.
interface SentryModule {
  init(opts: Record<string, unknown>): void;
  captureException(err: unknown, opts?: Record<string, unknown>): void;
}

// Deno's npm: compatibility layer. The Sentry Deno SDK ships as a standard
// npm package; the `?dts` query hint is unnecessary because Sentry ships its
// own .d.ts. See https://deno.com/manual/node/npm_specifiers.
let Sentry: SentryModule | null = null;

/**
 * Initialise Sentry for this Edge Function instance.
 *
 * Safe to call multiple times (the first init wins; subsequent calls are
 * no-ops). Safe to call without a DSN (no-op). Caller passes the function
 * name so the dashboard can filter by `tag:function:<name>`.
 */
export async function initSentry(functionName: string): Promise<void> {
  if (Sentry !== null) return; // already initialised
  const dsn = Deno.env.get("SENTRY_DSN");
  if (!dsn) return; // graceful no-op when no DSN is configured

  try {
    // Dynamic import so the module load doesn't blow up if @sentry/deno is
    // unavailable for any reason — graceful degradation matters more than
    // strict Sentry coverage on every cold start.
    const mod = (await import("npm:@sentry/deno@10.73.0")) as unknown as SentryModule;
    mod.init({
      dsn,
      // Edge Functions are short-lived; tracing adds latency without much
      // signal. Errors-only keeps the pipe narrow.
      tracesSampleRate: 0,
      // The function name tag is the dashboard filter you want most often;
      // "which of my seven Edge Functions started failing today?".
      initialScope: {
        tags: {
          function: functionName,
          runtime: "deno-edge-function",
        },
      },
    });
    Sentry = mod;
  } catch (err) {
    // Catastrophic SDK load failure — log and proceed without coverage.
    // We deliberately do NOT throw because that would take down the Edge
    // Function over an observability problem.
    console.error(
      `[sentry] init failed for ${functionName}; continuing without coverage:`,
      err,
    );
  }
}

/**
 * Capture an exception explicitly. Use this from inner catch blocks that
 * build a 500 response instead of re-throwing — `withSentry` only sees
 * thrown errors, so a handler that catches and returns 500 would
 * otherwise be invisible to Sentry. Includes the function name as a tag
 * so dashboards can filter by `tag:function:<name>` consistently with
 * events from `withSentry`.
 *
 * No-op when Sentry is unconfigured. Never throws — observability
 * failures must not change the request outcome.
 *
 * Round-6 P1 fix: every Edge Function had a top-level
 * `try { ... } catch (err) { return new Response(500) }` that swallowed
 * the throw before `withSentry` could see it; without an explicit
 * capture call those errors only ever reached the Edge Function logs
 * (which are not paged), which is the same blind-spot pattern that
 * produced the original 7-day-undetected outage.
 */
export function captureException(functionName: string, err: unknown): void {
  if (Sentry === null) return;
  try {
    Sentry.captureException(err, { tags: { function: functionName } });
  } catch (sentryErr) {
    console.error(
      `[sentry] captureException failed for ${functionName}:`,
      sentryErr,
    );
  }
}

/**
 * Wrap a Deno.serve handler so unhandled errors are captured by Sentry
 * (when configured) before being re-thrown to the surrounding error
 * machinery. The function name is included as a tag on every event.
 *
 * Returns the wrapped handler. If Sentry was never initialised the wrapper
 * is functionally a passthrough.
 */
export function withSentry(
  functionName: string,
  handler: (req: Request) => Promise<Response> | Response,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    try {
      return await handler(req);
    } catch (err) {
      if (Sentry !== null) {
        try {
          Sentry.captureException(err, {
            tags: { function: functionName },
          });
        } catch (sentryErr) {
          console.error(
            `[sentry] captureException failed for ${functionName}:`,
            sentryErr,
          );
        }
      }
      // Re-throw so the existing handler-level catch (which renders the
      // generic 500 envelope and logs to console.error) still runs. We
      // don't want Sentry coverage to change the response shape.
      throw err;
    }
  };
}
