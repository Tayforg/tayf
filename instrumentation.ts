/**
 * Next.js 16 instrumentation hook (B8 / observability).
 *
 * The `register` function is invoked exactly once per runtime when the server
 * boots — Vercel calls it for both the Node serverless runtime and the Edge
 * runtime. It is the documented place to wire up the @sentry/nextjs SDK for
 * server-side bootstrapping. The client-side init lives in
 * `instrumentation-client.ts`, which Next loads natively (not through
 * `withSentryConfig`: the legacy `sentry.client.config.ts` is ignored under
 * Turbopack).
 *
 * We branch on `process.env.NEXT_RUNTIME` because the Node and Edge SDKs
 * resolve to different bundles — the Edge build is intentionally trimmed and
 * cannot pull in @sentry/node's auto-instrumentations. The two configs are
 * therefore kept in separate files so each can import only what its runtime
 * supports.
 *
 * `onRequestError` is exported so Next 16's request-error pipeline reports
 * uncaught render/route errors to Sentry with full request context. Without
 * this hook, errors that bubble out of Server Components or Route Handlers
 * are only logged to stderr by the framework.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

/**
 * Next.js 16 request-error hook. The framework forwards uncaught errors from
 * Server Components, Route Handlers, and middleware here before rendering the
 * platform error UI. We forward them to Sentry with the same request context
 * the framework already gathered, so we don't have to thread `captureException`
 * calls through every route.
 *
 * Wrapped in a dynamic import so the Edge bundle doesn't pay the cost of
 * loading @sentry/nextjs when it isn't initialised.
 */
export async function onRequestError(
  err: unknown,
  request: {
    path: string;
    method: string;
    headers: { [key: string]: string };
  },
  context: {
    routerKind: "Pages Router" | "App Router";
    routePath: string;
    routeType: "render" | "route" | "action" | "middleware";
    renderSource:
      | "react-server-components"
      | "react-server-components-payload"
      | "server-rendering";
    revalidateReason: "on-demand" | "stale" | undefined;
    renderType: "dynamic" | "dynamic-resume";
  }
): Promise<void> {
  const Sentry = await import("@sentry/nextjs");
  Sentry.captureRequestError(err, request, context);
}
