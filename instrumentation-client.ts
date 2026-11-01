/**
 * Browser entry point for Sentry (B8).
 *
 * Next.js 16 loads `instrumentation-client.ts` natively, before the app
 * becomes interactive, in both the Turbopack (`next build` / `next dev`
 * default) and webpack bundlers. It replaces the old `sentry.client.config.ts`:
 * @sentry/nextjs 11 only injects that file through its webpack path ("When
 * using Turbopack sentry.client.config.ts will no longer work"), so under
 * Turbopack the browser SDK, and every scrub hook, never ran.
 * tests/guards/sentry-data-collection.test.ts fails if a `sentry.client.config.*`
 * comes back. The Node and Edge bootstraps live in `sentry.server.config.ts` /
 * `sentry.edge.config.ts` and are wired up by `instrumentation.ts`.
 *
 * This file is part of the main bundle of EVERY page, so it must stay tiny:
 * the SDK and its init options live in `src/lib/sentry/browser-init.ts`, which
 * is pulled in by a dynamic `import()` only when `NEXT_PUBLIC_SENTRY_DSN` is
 * set. Without a DSN (production today) the SDK is inert, so no visitor
 * downloads it; with one, it loads right after startup in its own chunk and
 * the init (dataCollection off, /rapor/<token> redaction hooks) is unchanged.
 *
 * KNOWN TRADE-OFF when a DSN is set: the chunk arrives after the main bundle,
 * usually after hydration has started, so errors in the first moments of a
 * page load (hydration mismatches, first effects) and navigations before the
 * chunk lands are not captured. If early-load errors matter more than ~53 KB
 * gzipped on every page, switch the `import()` below to a DSN-gated
 * synchronous `require("./src/lib/sentry/browser-init")`: without a DSN the
 * SDK is still dropped from the build, with one init runs before hydration.
 * Do NOT add a static import of `@sentry/*` or of `browser-init` here; the
 * guard test fails if one appears.
 *
 * The DSN is read from `NEXT_PUBLIC_SENTRY_DSN` because it must be embedded
 * in the client bundle (the literal `process.env.NEXT_PUBLIC_*` access is what
 * the bundler inlines); `SENTRY_DSN` (server-only) is intentionally NOT read
 * here to avoid leaking a non-public DSN into the browser.
 */
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

/** Set once browser-init has loaded and initialised the SDK; undefined until then (and forever without a DSN). */
let forwardTransition: ((href: string, navigationType: string) => void) | undefined;

if (dsn) {
  import("./src/lib/sentry/browser-init")
    .then((mod) => {
      mod.initBrowserSentry(dsn);
      forwardTransition = mod.captureRouterTransitionStart;
    })
    .catch(() => {
      // The chunk could not be fetched (offline, blocked) or init threw. There
      // is no error reporter to tell, so telemetry just stays off.
    });
}

/**
 * Instruments App Router navigations (Next 16 calls this when one starts).
 * Forwards to the SDK's `captureRouterTransitionStart` once the lazy chunk has
 * loaded; before that, and without a DSN, it does nothing. Never throws:
 * telemetry must not be able to break a navigation.
 */
export function onRouterTransitionStart(href: string, navigationType: string): void {
  try {
    forwardTransition?.(href, navigationType);
  } catch {
    // Swallowed on purpose, see above.
  }
}
