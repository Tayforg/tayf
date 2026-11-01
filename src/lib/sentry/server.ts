/**
 * Server-side Sentry wrapper (B8).
 *
 * Re-exports the subset of `@sentry/nextjs` that server-side code in tayf is
 * allowed to touch, so callers don't have to import the SDK directly. This
 * means we can swap implementations later (or no-op them in tests) without a
 * project-wide refactor.
 *
 * Importing this module from a client component is a TypeScript error because
 * `@sentry/nextjs`'s server entry pulls in `@sentry/node`, which references
 * `node:http` etc. Browser code gets the SDK only through the DSN-gated `instrumentation-client.ts` (see `browser-init.ts`); never import `@sentry/*` in client components.
 */
import * as Sentry from "@sentry/nextjs";

/**
 * Capture an exception in Sentry. Safe to call when Sentry is disabled — the
 * SDK no-ops if `init` saw no DSN.
 *
 * The optional `context` is mixed into the event's `extra` payload so route
 * handlers can attach the article id / queue name / etc. that caused the
 * failure without polluting the message string.
 */
export function captureServerException(
  err: unknown,
  context?: Record<string, unknown>
): void {
  if (context) {
    Sentry.captureException(err, { extra: context });
    return;
  }
  Sentry.captureException(err);
}

/**
 * Emit a structured breadcrumb. Useful inside long-running route handlers
 * (cron drainers) where we want a trail of "what happened just before the
 * exception" without flushing a full event for each step.
 */
export function addServerBreadcrumb(
  message: string,
  data?: Record<string, unknown>
): void {
  Sentry.addBreadcrumb({
    category: "server",
    message,
    level: "info",
    data,
  });
}

export { Sentry };
