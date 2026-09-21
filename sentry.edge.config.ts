/**
 * Sentry SDK init for the Edge runtime (B8).
 *
 * Loaded exactly once per Edge isolate at boot via `instrumentation.ts`'s
 * `register()` hook, gated on `NEXT_RUNTIME === "edge"`. This covers any
 * middleware and any route handlers that opt into `runtime = "edge"`.
 *
 * The Edge SDK is a leaner bundle than the Node SDK — no auto-instrumentation
 * of HTTP / Postgres / etc., no Node `require` machinery — so we keep this
 * file deliberately minimal. Everything tracing-heavy should go in the Node
 * config instead.
 *
 * Note: tayf's Supabase Edge Functions (under `supabase/functions/`) are a
 * different runtime (Deno) and are NOT covered by this file. Those functions
 * should be instrumented separately if observability there becomes a
 * requirement; for now they emit Supabase Edge Function logs.
 */
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment:
    process.env.SENTRY_ENVIRONMENT ??
    process.env.VERCEL_ENV ??
    process.env.NODE_ENV ??
    "development",
  release: process.env.SENTRY_RELEASE ?? process.env.VERCEL_GIT_COMMIT_SHA,
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
  debug: process.env.SENTRY_DEBUG === "1",

  // The SDK attaches every incoming request header to route-handler
  // events; drop the cron bearer and cookies before they leave the process.
  // Also redact the /rapor/<token> share capability secret — it travels in
  // the URL PATH, not a header, so a throw inside src/app/rapor/[token]/
  // would otherwise ship a working, unexpired share link to Sentry.
  beforeSend(event) {
    const redact = (s?: string) => s?.replace(/\/rapor\/[0-9a-f]{32}/gi, "/rapor/[token]");
    const h = event.request?.headers;
    if (h) {
      delete h.authorization;
      delete h.cookie;
      // Referrer-Policy strict-origin-when-cross-origin sends the FULL url
      // same-origin, so the page's own "Markdown indir" click puts a live
      // /rapor/<token> capability URL in Referer. Redact every header value,
      // not just referer, so a future header can't reintroduce the leak.
      for (const k of Object.keys(h)) {
        if (typeof h[k] === "string") h[k] = redact(h[k])!;
      }
    }
    if (event.request?.url) event.request.url = redact(event.request.url)!;
    if (event.transaction) event.transaction = redact(event.transaction)!;
    return event;
  },
});
