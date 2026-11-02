import { apiError } from "@/lib/api/errors";

/**
 * /api/unmatched — the target of the fallback rewrite in next.config.ts
 * (src/lib/api/fallback-rewrites.ts: '/api/:path*' -> '/api/unmatched').
 *
 * Next only reaches a `fallback` rewrite after every filesystem and dynamic
 * route has failed to match, so this handler answers exactly the unknown /api
 * paths outside /api/v1 (which has its own catch-all, v1NotFound) and never
 * shadows a real endpoint. Before it, those paths got the site's 44 KB HTML
 * not-found page, which a JSON client cannot parse.
 *
 * One handler bound to every method: an unknown path is a 404 whatever the
 * verb, not a 405. It reads no request, so GET stays prerenderable and the short
 * public cache lets the CDN absorb a scanner's probes (a 404 is not cached by
 * default). Do not turn this into a catch-all directory: see the rewrite file.
 */
const notFound = async () =>
  apiError(
    404,
    "Not found",
    { code: "not_found" },
    { headers: { "Cache-Control": "public, max-age=60, s-maxage=300" } },
  );

export const GET = notFound;
export const HEAD = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const OPTIONS = notFound;
