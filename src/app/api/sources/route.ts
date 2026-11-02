import { NextResponse } from "next/server";
import {
  ALLOW_GET_ONLY,
  apiMethodNotAllowed,
  apiOptionsAllow,
  apiTooManyRequests,
  withApiErrors,
} from "@/lib/api/errors";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import { registryEnvelope, toRegistryRecord } from "@/lib/sources/registry";
import { getRegistryRows } from "@/lib/sources/registry-query";

/**
 * GET /api/sources — the public, attribution-licensed registry JSON (S-20 +
 * M-04). No auth (this is the surface `/llms.txt` points crawlers at), but
 * rate limited (B-SEC-05): a 60-token bucket refilling at 1/sec is generous
 * for a crawler/legit consumer while still bounding a scraping burst.
 *
 * The rows come from `getRegistryRows()` (src/lib/sources/registry-query.ts):
 * cached, 4 s-capped, and called with NO argument, so the cache key cannot
 * depend on the query string. This handler never reads the URL for that
 * reason: a `?cb=<random>` cache-buster must not mint a cache entry or a
 * Supabase read. A sustained read failure throws and `withApiErrors` answers
 * 500; it is never a 200 with an empty list.
 *
 * Cache-Control is set explicitly on the `NextResponse` rather than via a
 * route-segment `revalidate` export — this is a Route Handler, not a
 * cached page, so the segment config wouldn't apply to the CDN response at
 * all and the header would silently do nothing.
 */
const REGISTRY_HEADERS = {
  "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
  "Content-Type": "application/json; charset=utf-8",
};

const sourcesJsonLimit = createRateLimiter("sources-json", {
  capacity: 60,
  refillPerSecond: 1,
});

export const GET = withApiErrors(async (request: Request) => {
  const rl = sourcesJsonLimit(clientKey(request));
  if (!rl.allowed) return apiTooManyRequests(rl.retryAfterMs);

  const rows = await getRegistryRows();
  const sources = rows.map((row) => toRegistryRecord(row));

  return NextResponse.json(
    registryEnvelope({ count: sources.length, sources }),
    { headers: REGISTRY_HEADERS },
  );
});

// Every other method gets the JSON 405 with `Allow` (RFC 9110 15.5.6) instead of
// Next's bodyless default, and OPTIONS is explicit: without it Next's automatic
// OPTIONS would advertise POST, PUT, PATCH and DELETE. HEAD is derived from GET.
// The refusals read no request state, so they cost no rate-limit token.
const refuse = async () => apiMethodNotAllowed(ALLOW_GET_ONLY);
export const POST = refuse;
export const PUT = refuse;
export const PATCH = refuse;
export const DELETE = refuse;

export function OPTIONS(): Response {
  return apiOptionsAllow(ALLOW_GET_ONLY);
}
