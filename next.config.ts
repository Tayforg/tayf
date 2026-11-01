import type { NextConfig } from "next";
// @sentry/nextjs 11 moved the build wrapper to the "/config" subpath; the
// package root no longer exports withSentryConfig (TS2305).
import { withSentryConfig } from "@sentry/nextjs/config";
// Relative path on purpose: the config loader cannot resolve the '@/' alias.
import { HTML_LIMITED_BOTS } from "./src/lib/seo/html-limited-bots";
import { IMAGE_REMOTE_PATTERNS } from "./src/lib/images/remote-image-hosts";
import { SITE_REDIRECTS } from "./src/lib/seo/redirects";
import { buildSecurityHeaders } from "./src/lib/security/headers";

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
 *   - images.remotePatterns       (stable since 12.3; a generated https-only allowlist, see note below)
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
 * iasbh.tmgrup.com.tr, static.daktilo.com, imgrosetta.mynet.com.tr, etc.), so
 * the optimizer needs a host allowlist that tracks them.
 *
 * Why the list is generated and not a catch-all: this file used to allow
 * every https and http host, on the premise that image URLs only enter the
 * pipeline through our RSS normalizer writing `articles.image_url`, never
 * from untrusted input. That premise was false. /_next/image takes
 * `?url=<anything>` from the request itself, so a catch-all made the endpoint
 * an open proxy: anyone could make our origin fetch, resize and re-serve any
 * image on the internet, over plain http too (api-1).
 *
 * `images.remotePatterns` is now IMAGE_REMOTE_PATTERNS: an https-only list
 * generated from the hosts `articles.image_url` really uses
 * (scripts/gen-image-hosts.mjs; the regeneration runbook is in its header, run
 * it monthly and whenever a source is added), plus the Google S2 favicon path
 * behind every source logo. An unlisted host never reaches the optimizer: the
 * render boundaries filter with isAllowedRemoteImageUrl, so the image falls
 * back to the next candidate, then the logo tier, then the placeholder. Next
 * validates at most 50 patterns (fatal under `images`), so the generated hosts
 * are packed into brace groups; see src/lib/images/remote-image-hosts.ts and
 * tests/guards/image-remote-patterns.test.ts, which keeps a catch-all from
 * coming back. We keep the optimizer (automatic resizing, lazy loading, WebP
 * conversion) instead of falling back to `unoptimized: true`.
 */
const nextConfig: NextConfig = {
  cacheComponents: true,
  // Under cacheComponents, generateMetadata output streams into <body> for
  // humans, which lets Google ignore the canonical and the noindex-on-error
  // hardening. Next's default htmlLimitedBots list omits Googlebot and
  // GoogleOther, so we extend it (see src/lib/seo/html-limited-bots.ts).
  // Trade-off: matching bots bypass the PPR shell, so every crawl is a full
  // dynamic render and generateMetadata latency lands in their TTFB.
  // Details: docs/architecture.md, "Metadata for crawlers".
  htmlLimitedBots: HTML_LIMITED_BOTS,
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
    // Public /durum snapshot. Every age on that page is measured against the
    // snapshot's own `generated_at`, so a stale entry would read "all fine"
    // long after the pipeline stalled. The built-in `minutes` profile keeps an
    // entry for an hour and serves it stale-while-revalidate; here it is
    // refreshed after 1 minute and can never be served older than 3 minutes
    // (expire forces a synchronous regeneration).
    'status': {
      stale: 30,
      revalidate: 60,
      expire: 180,
    },
  },
  images: {
    remotePatterns: IMAGE_REMOTE_PATTERNS,
    minimumCacheTTL: 86400,
    qualities: [50, 75, 90],
    contentDispositionType: "inline",
    // A `sizes` value with no `vw` term (e.g. the desktop thumbnail's fixed
    // "160px") makes next/image emit every configured width as a srcset
    // candidate instead of scaling by viewport, so the device-size list has
    // to include something near that slot (160/320 land inside imageSizes
    // below) — and our 100vw mobile slots never need anything above the
    // layout's max-w-5xl, so the top end (2048/3840) is dead weight.
    deviceSizes: [384, 640, 750, 828, 1080, 1200, 1920],
    imageSizes: [32, 48, 64, 96, 128, 160, 256, 320],
  },
  logging: {
    fetches: {
      fullUrl: false,
    },
    incomingRequests: {
      ignore: [/^\/_next\//, /\/__nextjs_/],
    },
  },
  // Frame policy split: everything is SAMEORIGIN-only except the script-less
  // /embed/ widget. All header literals live in src/lib/security/headers.ts
  // (guarded by tests/guards/frame-headers.test.ts).
  async headers() {
    return buildSecurityHeaders(process.env.NODE_ENV);
  },
  // Permanent (308) site redirects; the list lives in src/lib/seo/redirects.ts.
  async redirects() {
    return [...SITE_REDIRECTS];
  },
};

/**
 * `withSentryConfig` (B8 / observability), imported from `@sentry/nextjs/config`
 * since @sentry/nextjs 11, injects the build plugin so client-bundle source
 * maps are uploaded at build time and the `instrumentation.ts` server/edge
 * bootstraps are wired into the build graph. `redirects()` and `headers()`
 * above stay inside the wrapped config.
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
 *     CDN while still landing them in Sentry. (Replaces the legacy
 *     `hideSourceMaps` flag; unchanged in 11.)
 *   - `bundleSizeOptimizations.excludeDebugStatements: true` strips Sentry's
 *     verbose debug logger from production bundles. (11 replacement for the
 *     removed `disableLogger` flag; it also covers Turbopack builds.)
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
  bundleSizeOptimizations: {
    excludeDebugStatements: true,
  },
});
