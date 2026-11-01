/**
 * Sentry SDK init for the browser runtime (B8).
 *
 * @sentry/nextjs picks this file up automatically during the Webpack build via
 * `withSentryConfig` in `next.config.ts`; it ships in the client bundle and
 * runs in the user's browser. The Node and Edge bootstraps live in
 * `sentry.server.config.ts` / `sentry.edge.config.ts` and are wired up by
 * `instrumentation.ts`.
 *
 * tayf has no user accounts and no PII collection, so we keep the client init
 * minimal: no Session Replay, no BrowserTracing, just unhandled-error capture.
 * If we add an authenticated surface later, opt into Replay + tracing
 * integrations here rather than on the server side.
 *
 * `dataCollection: SENTRY_DATA_COLLECTION` keeps `infer_ip`, cookies and request
 * bodies off (@sentry/nextjs 11 collects them by default; see
 * `src/lib/sentry/data-collection.ts`).
 *
 * The DSN is read from `NEXT_PUBLIC_SENTRY_DSN` because it must be embedded
 * in the client bundle; `SENTRY_DSN` (server-only) is intentionally NOT read
 * here to avoid leaking a non-public DSN into the browser.
 */
import * as Sentry from "@sentry/nextjs";
import { SENTRY_DATA_COLLECTION } from "./src/lib/sentry/data-collection";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

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
});
