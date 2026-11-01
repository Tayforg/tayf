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
 * Data collection: `dataCollection: SENTRY_DATA_COLLECTION` keeps IPs, cookies,
 * request bodies and DB query data off (@sentry/nextjs 11 collects them by
 * default; see `src/lib/sentry/data-collection.ts`). The before* hooks scrub
 * credential headers and the /rapor/<token> share URL (see
 * `src/lib/sentry/redact.ts`).
 *
 * Note: tayf's Supabase Edge Functions (under `supabase/functions/`) are a
 * different runtime (Deno) and are NOT covered by this file. Those functions
 * should be instrumented separately if observability there becomes a
 * requirement; for now they emit Supabase Edge Function logs.
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
