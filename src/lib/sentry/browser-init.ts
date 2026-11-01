/**
 * Sentry SDK init for the browser runtime (B8).
 *
 * Loaded ONLY by `instrumentation-client.ts`, through a dynamic `import()` that
 * runs only when `NEXT_PUBLIC_SENTRY_DSN` was set at build time. That keeps
 * the browser SDK (~54 KB gzipped) in its own lazily fetched chunk instead of
 * the main bundle of every page: this module and `@sentry/nextjs` must never be
 * imported statically from anything on the critical path (the entry point
 * included). tests/guards/sentry-data-collection.test.ts fails if that happens,
 * and also pins the options below.
 *
 * tayf has no user accounts and no PII collection, so we keep the client init
 * minimal: no Session Replay, no BrowserTracing, just unhandled-error capture.
 * If we add an authenticated surface later, opt into Replay + tracing
 * integrations here rather than on the server side.
 *
 * `dataCollection: SENTRY_DATA_COLLECTION` keeps `infer_ip`, cookies and request
 * bodies off (@sentry/nextjs 11 collects them by default; see
 * `src/lib/sentry/data-collection.ts`). The before* hooks redact the
 * /rapor/<token> share URL from events, spans and breadcrumbs (see
 * `src/lib/sentry/redact.ts`).
 *
 * The DSN arrives as a parameter, read by the caller from the literal
 * `process.env.NEXT_PUBLIC_SENTRY_DSN`: it must be embedded in the client
 * bundle, and `SENTRY_DSN` (server-only) is intentionally NOT read anywhere in
 * browser code to avoid leaking a non-public DSN into the browser. The other
 * `NEXT_PUBLIC_SENTRY_*` options below are read here, as literal member
 * accesses, so the bundler inlines them.
 */
import * as Sentry from "@sentry/nextjs";
import { SENTRY_DATA_COLLECTION } from "./data-collection";
import {
  scrubSentryBreadcrumb,
  scrubSentryEvent,
  scrubSentrySpan,
} from "./redact";

/** Initialises the browser SDK. `dsn` is `process.env.NEXT_PUBLIC_SENTRY_DSN`. */
export function initBrowserSentry(dsn: string | undefined): void {
  Sentry.init({
    dsn,
    enabled: Boolean(dsn),
    environment:
      process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ??
      process.env.NEXT_PUBLIC_VERCEL_ENV ??
      process.env.NODE_ENV ??
      "development",
    release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
    tracesSampleRate: Number(
      process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? 0.1
    ),
    debug: process.env.NEXT_PUBLIC_SENTRY_DEBUG === "1",
    dataCollection: SENTRY_DATA_COLLECTION,

    // The /rapor/<token> share page is a public, capability-URL page, so a
    // client-side error on it would ship the token in request.url, the Referer
    // header and the navigation / fetch breadcrumbs. Redact every channel that
    // carries a URL (src/lib/sentry/redact.ts; the same hooks as the Node and
    // Edge inits, pinned by tests/guards/sentry-data-collection.test.ts):
    //   - beforeSend: error events. Also drops authorization / cookie headers.
    //   - beforeSendSpan: the effective tracing hook under the default
    //     traceLifecycle "stream" (name, url.* attributes, links).
    //   - beforeSendTransaction: runs ONLY under traceLifecycle "static"; ignored
    //     by the default "stream", and removed in SDK v12. Kept so a switch to
    //     "static" cannot silently reopen the leak.
    //   - beforeBreadcrumb: navigation and fetch breadcrumbs, as they are added.
    beforeSend: scrubSentryEvent,
    beforeSendTransaction: scrubSentryEvent,
    beforeSendSpan: scrubSentrySpan,
    beforeBreadcrumb: scrubSentryBreadcrumb,
  });
}

/**
 * The SDK's `onRouterTransitionStart` handler, re-exported so the entry point
 * can call it without ever importing `@sentry/nextjs` itself.
 */
export { captureRouterTransitionStart } from "@sentry/nextjs";
