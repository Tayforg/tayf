import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

/**
 * W4-Q7 Next.js 16 config review (2026-04-06)
 * Verified against bundled docs in node_modules/next/dist/docs/01-app/...:
 *   - 05-config/01-next-config-js/index.md          (general shape, NextConfig type)
 *   - 05-config/01-next-config-js/typedRoutes.md    (now top-level, stable)
 *   - 05-config/01-next-config-js/cacheComponents.md (top-level, unifies ppr/useCache/dynamicIO)
 *   - 05-config/01-next-config-js/logging.md        (v16.2 moved browserToTerminal out of experimental)
 *   - 02-components/image.md                        (remotePatterns, minimumCacheTTL, qualities,
 *                                                    contentDispositionType all still current in 16)
 *   - 02-guides/upgrading/version-16.md             (defaults changes + deprecations list)
 *
 * Verified keys (all still valid in 16):
 *   - images.remotePatterns       (stable since 12.3; wildcard form intentional, see note below)
 *   - images.minimumCacheTTL      (16 default is 14400s; we override to 86400s)
 *   - images.qualities            (16 default narrowed to [75]; we allow 50/75/90)
 *   - images.contentDispositionType (still supported; "inline" needed for direct /_next/image hits)
 *
 * Considered but NOT added:
 *   - typedRoutes: true  -> design pages link to /sources and /blindspots which are not real
 *     routes in this repo; enabling would break `tsc --noEmit`. Revisit after those routes exist.
 *   - cacheComponents: true  -> Next 16 flag that replaces experimental.dynamicIO and unifies PPR.
 *     Requires adopting `use cache` across Server Components and would change navigation semantics
 *     (React <Activity> preserves state across routes). Too invasive for a config-only pass.
 *   - experimental.* flags -> none needed; all desired features are already top-level stable in 16.
 *
 * Confirmed absent (good — nothing to remove):
 *   - images.unoptimized (we want the optimizer)
 *   - images.domains     (deprecated in 16; we already use remotePatterns)
 *   - experimental.dynamicIO / experimental.ppr / experimental.turbopack (all promoted or renamed in 16)
 *   - AMP, next lint, serverRuntimeConfig, publicRuntimeConfig (all removed in 16)
 *
 * Added this pass:
 *   - logging.fetches.fullUrl: false  (explicit; quieter dev server fetch lines)
 *   - logging.incomingRequests.ignore: filters RSC/_next noise so cron polling
 *     and prefetches don't drown out real requests in the dev terminal.
 *
 * Tayf aggregates RSS feeds from 144 Turkish news outlets. Each outlet
 * serves cover images from its own CDN (i.sabah.com.tr, cdn.ahaber.com.tr,
 * iasbh.tmgrup.com.tr, static.daktilo.com, imgrosetta.mynet.com.tr, etc.),
 * producing hundreds of distinct hostnames — too many to whitelist by hand.
 *
 * Trade-off: we use a wildcard `remotePatterns` so the Next.js image
 * optimizer will fetch ANY https/http URL. This is acceptable here because
 * image URLs only enter the pipeline through our RSS normalizer writing
 * `articles.image_url`, never from untrusted user input. We keep the
 * optimizer (automatic resizing, lazy loading, WebP conversion) instead of
 * falling back to `unoptimized: true`.
 */
const nextConfig: NextConfig = {
  cacheComponents: true,
  cacheLife: {
    // Cluster-worker cycles every 15-60s (adaptive), so a 5-min revalidate
    // window keeps the homepage at most ~5 min stale while cutting Supabase
    // egress on this path ~10x vs the previous 30s window.
    'cluster-feed': {
      stale: 60,
      revalidate: 300,
      expire: 3600,
    },
    // Source directory shifts weekly; 5-minute cache is plenty fresh.
    'source-directory': {
      stale: 60,
      revalidate: 300,
      expire: 3600,
    },
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**" },
      { protocol: "http", hostname: "**" },
    ],
    minimumCacheTTL: 86400,
    qualities: [50, 75, 90],
    contentDispositionType: "inline",
  },
  logging: {
    fetches: {
      fullUrl: false,
    },
    incomingRequests: {
      ignore: [/^\/_next\//, /\/__nextjs_/],
    },
  },
  async headers() {
    // Dev HMR needs eval; drop it in production since Vercel Web Analytics
    // loads same-origin from /_vercel/insights/script.js (no host to add).
    const scriptSrc =
      process.env.NODE_ENV === "production"
        ? "script-src 'self' 'unsafe-inline'"
        : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              scriptSrc,
              "style-src 'self' 'unsafe-inline'",
              // Permissive img-src: Tayf renders favicons via Google S2 plus cover
              // images from ~144 Turkish news CDNs (see images.remotePatterns note).
              "img-src 'self' data: blob: https:",
              "font-src 'self' data:",
              // connect-src allows local Supabase (54321) plus arbitrary https/ws for
              // RSS-driven previews and dev HMR sockets.
              "connect-src 'self' https: http://127.0.0.1:54321 ws: wss:",
              "frame-ancestors 'self'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

/**
 * `withSentryConfig` (B8 / observability) injects the @sentry/nextjs webpack
 * plugin so client-bundle source maps are uploaded at build time and the
 * `instrumentation.ts` server/edge bootstraps are wired into the build graph.
 *
 * Build-time uploads only run when `SENTRY_AUTH_TOKEN` is set, so local `next
 * build` without a token still completes (the plugin no-ops the upload step).
 * Compile-time options are intentionally narrow:
 *   - `silent` quiets the plugin in CI logs when there's no token to use.
 *   - `widenClientFileUpload: true` includes Next 16's `_next/static/chunks`
 *     output so stack traces in the browser resolve to original sources.
 *   - `tunnelRoute` is left undefined; we'll only enable it if an ad-blocker
 *     starts swallowing Sentry events in the wild.
 *   - `sourcemaps.deleteSourcemapsAfterUpload: true` deletes generated .map
 *     files from the build output after upload, keeping them off the public
 *     CDN while still landing them in Sentry. (Sentry 10.x replacement for the
 *     legacy `hideSourceMaps` flag.)
 *   - `disableLogger: true` strips Sentry's verbose client logger from
 *     production bundles.
 */
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  widenClientFileUpload: true,
  sourcemaps: {
    deleteSourcemapsAfterUpload: true,
  },
  disableLogger: true,
});
