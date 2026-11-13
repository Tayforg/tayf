import { NextResponse } from "next/server";
import {
  ALLOW_GET_ONLY,
  apiError,
  apiMethodNotAllowed,
  apiOptionsAllow,
  apiTooManyRequests,
  withApiErrors,
} from "@/lib/api/errors";
import { toHomeHead } from "@/lib/clusters/home-head";
import {
  getPoliticsClusters,
  splitHomeFeed,
  type PoliticsClustersResult,
} from "@/lib/clusters/politics-query";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";

/**
 * GET /api/home/head -- the probe behind the home page's "N yeni son dakika
 * haberi · Yenile" pill (h170-roadmap-2; realtime-lite, no Supabase Realtime).
 * Returns the id and first_published of the stories in the Son Dakika strip (at
 * most 6), nothing else: titles and counts stay out of this public, CDN-cached
 * answer.
 *
 * It reads `getPoliticsClusters()`, the SAME "use cache" entry (cacheLife
 * `cluster-feed`: revalidate 300 s) that feeds the home page, called with NO
 * argument, and takes the strip from `splitHomeFeed`, the helper HomeFeed itself
 * uses. Polling therefore adds zero database reads beyond that entry's own
 * revalidation, and the head can never name a story the strip does not hold. This
 * handler never reads the URL for the same reason as /api/timeline/head: a
 * `?cb=<random>` cache-buster must not mint a cache entry.
 *
 * Cache-Control is set on the response (60 s at the CDN, 60 s stale; the same
 * header as /api/timeline/head) rather than through a segment config export,
 * which cacheComponents does not allow. A story entering the strip therefore
 * reaches an open tab in about 8 minutes at worst: 300 s entry + 60 s CDN + a 120 s
 * poll. A null or failed read is a 503 with `no-store` and `Retry-After: 120`,
 * never a cached empty list (a failed read is the cached read throwing after its
 * own live retry: a sustained outage). The route is dynamic (the limiter reads the
 * client headers), so it is not prerendered.
 */
const HEAD_HEADERS = {
  "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=60",
  "Content-Type": "application/json; charset=utf-8",
};

const homeHeadLimit = createRateLimiter("home-head", {
  capacity: 30,
  refillPerSecond: 0.5,
});

export const GET = withApiErrors(async (request: Request) => {
  const rl = homeHeadLimit(clientKey(request));
  if (!rl.allowed) return apiTooManyRequests(rl.retryAfterMs);

  let feed: PoliticsClustersResult | null;
  try {
    feed = await getPoliticsClusters();
  } catch (err) {
    console.warn("[home-head] feed unavailable:", err);
    feed = null;
  }
  if (feed === null) {
    return apiError(
      503,
      "Home feed unavailable",
      {},
      { headers: { "Cache-Control": "no-store", "Retry-After": "120" } },
    );
  }

  const { filteredBreaking } = splitHomeFeed(feed);
  return NextResponse.json(
    { breaking: toHomeHead(filteredBreaking.map((b) => b.cluster)) },
    { headers: HEAD_HEADERS },
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
