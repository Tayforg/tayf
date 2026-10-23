/**
 * Security headers for next.config.ts `headers()`. Dependency-free on
 * purpose: next.config.ts imports this file by relative path, and the config
 * loader cannot resolve the '@/' alias (same constraint as
 * src/lib/seo/html-limited-bots.ts).
 *
 * The site is NOT frameable by third parties: every path carries CSP
 * `frame-ancestors 'self'` plus `X-Frame-Options: SAMEORIGIN` (rule A). The
 * one deliberate exception is the script-less widget at exactly
 * /embed/cluster/<id> (rule B), which exists to be put in someone else's
 * <iframe>.
 *
 * Why this is safe to relax for that one path only:
 *   - /embed/cluster/<one segment> is served by a route handler that returns a
 *     static HTML document with no <script>; for a bad id the same handler
 *     returns its own 'Haber bulunamadı' shell, still script-less. Rule B's
 *     CSP has `default-src 'none'` and no `script-src`, so even an injection
 *     could not run script.
 *   - there is no cookie, form, auth state or action on those pages, so
 *     clickjacking has nothing to hijack.
 *   - `X-Frame-Options` is omitted there on purpose: it has no "allow all"
 *     value, and a browser that sees both uses the stricter one.
 *
 * Every OTHER /embed/... path (/embed/foo, /embed/cluster, /embed/cluster/<id>/x,
 * ...) gets rule A, i.e. the site policy, plus the script-less 404 shell from
 * app/embed/[...rest], so it is neither frameable nor script-carrying.
 *
 * The two `source` patterns are disjoint and together cover every path:
 *   A: /:path((?!embed/cluster/[^/]+/?$).*)  -- everything except exactly
 *      embed/cluster/<one segment>, with or without a trailing slash
 *   B: /embed/cluster/:id                    -- exactly that one-segment shape
 * so no path gets two conflicting frame policies and none gets none. The bare
 * "/embed" and "/embed/" fall to A. The `/?` in A's lookahead is load-bearing:
 * Next compiles every `source` with an optional trailing slash appended
 * (`(?:/)?$`), so B also matches /embed/cluster/<id>/, and a lookahead ending
 * in a bare `$` would not exclude that path from A. Guarded by
 * tests/guards/frame-headers.test.ts, which runs both through Next's own path
 * matcher and through the regex `buildCustomRoute` ships for production.
 *
 * Residual (documented, deferred): header matching is case-insensitive while
 * app routing is not, so /EMBED/cluster/<x> gets rule B but is answered by
 * app/not-found.tsx. B's CSP (default-src 'none', no script-src) lets none of
 * that page's scripts, styles or fonts load, so it renders unstyled and inert
 * rather than exploitable. Closing it needs middleware lowercasing.
 */

export interface SecurityHeader {
  key: string;
  value: string;
}

export interface SecurityHeaderRule {
  source: string;
  headers: SecurityHeader[];
}

/**
 * Everything except exactly /embed/cluster/<one segment> (optionally followed by
 * one trailing slash) -- the pre-split policy, unchanged.
 */
export const SITE_HEADERS_SOURCE = "/:path((?!embed/cluster/[^/]+/?$).*)";

/** The one frameable path: the widget at /embed/cluster/<id>. */
export const EMBED_HEADERS_SOURCE = "/embed/cluster/:id";

/** No script-src: nothing can execute. `frame-ancestors *` is the point. */
export const EMBED_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors *",
].join("; ");

export function buildSecurityHeaders(nodeEnv: string | undefined): SecurityHeaderRule[] {
  const isProduction = nodeEnv === "production";
  // Dev HMR needs eval; drop it in production since Vercel Web Analytics
  // loads same-origin from /_vercel/insights/script.js (no host to add).
  const scriptSrc = isProduction
    ? "script-src 'self' 'unsafe-inline'"
    : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";
  // connect-src allows local Supabase (54321) only outside production --
  // that origin is dev-only (`supabase start`) and has no reason to be
  // in the production CSP.
  const connectSrc = isProduction
    ? "connect-src 'self' https: ws: wss:"
    : "connect-src 'self' https: http://127.0.0.1:54321 ws: wss:";

  const siteCsp = [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    // Permissive img-src: Tayf renders favicons via Google S2 plus cover
    // images from ~144 Turkish news CDNs (see images.remotePatterns note).
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    // connect-src allows arbitrary https/ws for RSS-driven previews and
    // dev HMR sockets; local Supabase (54321) is added only outside
    // production (see `connectSrc` above).
    connectSrc,
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");

  const hsts: SecurityHeader = {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  };
  const nosniff: SecurityHeader = { key: "X-Content-Type-Options", value: "nosniff" };
  const referrerPolicy: SecurityHeader = {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  };
  const permissionsPolicy: SecurityHeader = {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  };

  return [
    {
      source: SITE_HEADERS_SOURCE,
      headers: [
        { key: "Content-Security-Policy", value: siteCsp },
        hsts,
        nosniff,
        { key: "X-Frame-Options", value: "SAMEORIGIN" },
        referrerPolicy,
        permissionsPolicy,
      ],
    },
    {
      source: EMBED_HEADERS_SOURCE,
      headers: [
        { key: "Content-Security-Policy", value: EMBED_CSP },
        hsts,
        nosniff,
        referrerPolicy,
        permissionsPolicy,
      ],
    },
  ];
}
