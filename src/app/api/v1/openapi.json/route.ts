import { methodNotAllowed } from "@/lib/api/keys";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { siteUrl } from "@/lib/site-url";

/**
 * GET /api/v1/openapi.json — static OpenAPI 3.1 description of the keyed
 * `/api/v1` surface, generated from src/lib/api/v1-docs.ts's V1_ENDPOINTS.
 *
 * Deliberately NOT wrapped in `withApiErrors`/`requireApiKey`: this is the
 * one `/api/v1/*` route that needs no key (a consumer must be able to read
 * the contract before it has one) and touches no request state (no
 * headers, no cookies, no Date) — so it prerenders as static output under
 * Next 16 `cacheComponents` instead of opting the route into dynamic
 * rendering. Do NOT add `export const dynamic`/`revalidate` here; either
 * would defeat that.
 *
 * Every non-GET/HEAD/OPTIONS method is bound to the shared JSON-405
 * `methodNotAllowed` like every other /api/v1 route (it reads no request
 * state either, so it does not affect the static GET).
 */
export function GET(): Response {
  const body = JSON.stringify(buildOpenApiDocument(siteUrl()), null, 2);
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "X-Tayf-Tier, Retry-After",
    },
  });
}

// Every other method gets the JSON 405 envelope with an `Allow` header (and
// CORS) rather than Next's bodyless default. HEAD is derived from GET by Next.
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
