/**
 * Sentry SDK init for the Node serverless runtime (B8).
 *
 * Loaded exactly once at process boot via `instrumentation.ts`'s `register()`
 * hook, gated on `NEXT_RUNTIME === "nodejs"`. The Vercel serverless functions
 * for `/api/*` and Server Component renders both run in this bundle, so any
 * unhandled rejection or thrown error inside `withApiErrors` ends up here.
 *
 * Configuration choices:
 *   - `enabled` is gated on the DSN being present so local `next dev` without
 *     a DSN doesn't spam initialisation warnings. Sentry's own `init()` will
 *     also no-op when the DSN is empty, but the explicit gate keeps the intent
 *     legible.
 *   - `tracesSampleRate` defaults to 0.1 in production to keep volume below
 *     the free-tier quota; tweak via env without a redeploy.
 *   - `sendDefaultPii: false` (the default) — tayf is a news aggregator with
 *     no user-PII surface, but explicit-default avoids accidentally shipping
 *     IPs/UAs the day someone adds an auth flow.
 *   - `debug` is wired to an env flag rather than `NODE_ENV` so an operator
 *     can flip it at runtime via Vercel env vars without redeploying.
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
  beforeSend(event) {
    const h = event.request?.headers;
    if (h) { delete h.authorization; delete h.cookie; }
    return event;
  },
});
