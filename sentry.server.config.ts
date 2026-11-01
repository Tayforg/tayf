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
 *   - `dataCollection: SENTRY_DATA_COLLECTION` — @sentry/nextjs 11 removed
 *     `sendDefaultPii` and now collects the client IP, cookies, request bodies
 *     (the /admin/login POST carries the plaintext admin password) and DB query
 *     data unless told otherwise. The shared block in
 *     `src/lib/sentry/data-collection.ts` switches all of that off, and
 *     tests/guards/sentry-data-collection.test.ts keeps it off.
 *   - `beforeSend` / `beforeSendSpan` / `beforeBreadcrumb` (and
 *     `beforeSendTransaction`, which only runs under `traceLifecycle: "static"`)
 *     scrub credential headers and the /rapor/<token> share URL via
 *     `src/lib/sentry/redact.ts`; tests/guards/sentry-data-collection.test.ts
 *     feeds each hook a token-bearing payload.
 *   - `debug` is wired to an env flag rather than `NODE_ENV` so an operator
 *     can flip it at runtime via Vercel env vars without redeploying.
 */
import * as Sentry from "@sentry/nextjs";
import { SENTRY_DATA_COLLECTION } from "./src/lib/sentry/data-collection";
import {
  scrubSentryBreadcrumb,
  scrubSentryEvent,
  scrubSentrySpan,
} from "./src/lib/sentry/redact";

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
  dataCollection: SENTRY_DATA_COLLECTION,

  // The SDK attaches every incoming request header to route-handler events;
  // scrubSentryEvent drops the cron bearer and cookies before they leave the
  // process. The /rapor/<token> share capability secret travels in the URL
  // PATH, so every channel that carries a URL is redacted too (src/lib/sentry/
  // redact.ts; tests/guards/sentry-data-collection.test.ts feeds each hook):
  //   - beforeSend: error events (request.url, Referer, transaction,
  //     breadcrumbs, trace context).
  //   - beforeSendSpan: @sentry/nextjs 11 defaults to traceLifecycle "stream",
  //     where spans (name, url.* attributes, links) ship individually and this
  //     is the effective tracing hook.
  //   - beforeSendTransaction: runs ONLY under traceLifecycle "static"; ignored
  //     by the default "stream", and removed in SDK v12. Kept so a switch to
  //     "static" cannot silently reopen the leak.
  //   - beforeBreadcrumb: navigation and fetch breadcrumbs, as they are added.
  beforeSend: scrubSentryEvent,
  beforeSendTransaction: scrubSentryEvent,
  beforeSendSpan: scrubSentrySpan,
  beforeBreadcrumb: scrubSentryBreadcrumb,
});
