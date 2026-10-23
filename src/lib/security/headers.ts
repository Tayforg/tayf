/**
 * Security headers for next.config.ts `headers()`. Dependency-free on
 * purpose: next.config.ts imports this file by relative path, and the config
 * loader cannot resolve the '@/' alias (same constraint as
 * src/lib/seo/html-limited-bots.ts).
 *
 * The site is NOT frameable by third parties: every path carries CSP
 * `frame-ancestors 'self'` plus `X-Frame-Options: SAMEORIGIN` (rule A). The
 * one deliberate exception is the script-less /embed/ widget (rule B), which
 * exists to be put in someone else's <iframe>.
 *
 * Why this is safe to relax for /embed/ only:
 *   - /embed/* is served by a route handler that returns a static HTML
 *     document with no <script>. Rule B's CSP has `default-src 'none'` and no
 *     `script-src`, so even an injection could not run script.
 *   - there is no cookie, form, auth state or action on those pages, so
 *     clickjacking has nothing to hijack.
 *   - `X-Frame-Options` is omitted there on purpose: it has no "allow all"
 *     value, and a browser that sees both uses the stricter one.
 *
 * The two `source` patterns are disjoint and together cover every path:
 *   A: /:path((?!embed/).*)  -- everything except paths that start with "embed/"
 *   B: /embed/:path+         -- at least one segment under /embed/
 * so no path gets two conflicting frame policies and none gets none (the bare
 * "/embed" falls to A: the lookahead only rejects "embed/"). Guarded by
 * tests/guards/frame-headers.test.ts, which runs both through Next's own
 * path matcher.
 */

export interface SecurityHeader {
  key: string;
  value: string;
}

export interface SecurityHeaderRule {
  source: string;
  headers: SecurityHeader[];
}

/** Everything except /embed/ -- the pre-split policy, unchanged. */
export const SITE_HEADERS_SOURCE = "/:path((?!embed/).*)";

/** The frameable widget namespace. */
export const EMBED_HEADERS_SOURCE = "/embed/:path+";

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
