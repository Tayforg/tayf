import { NextResponse } from "next/server";
import {
  ALLOW_GET_ONLY,
  apiError,
  apiMethodNotAllowed,
  apiOptionsAllow,
  apiTooManyRequests,
  withApiErrors,
} from "@/lib/api/errors";
import { toTimelineHead } from "@/lib/clusters/timeline-head";
import { getRecentClusters } from "@/lib/clusters/timeline-query";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";

/**
 * GET /api/timeline/head -- the probe behind the /timeline "N yeni küme ·
 * Yenile" pill (realtime-lite, no Supabase Realtime). Returns the id and
 * first_published of the newest 50 clusters, nothing else: titles and counts
 * stay out of this public, CDN-cached answer.
 *
 * It reuses `getRecentClusters()`, the SAME "use cache" entry (tag `clusters`,
 * cacheLife `cluster-feed`) that renders the page, called with NO argument.
 * Polling therefore adds zero database reads beyond the page's own
 * revalidation, and the head can never show a cluster the refreshed page
 * cannot. This handler never reads the URL for the same reason as
 * /api/sources: a `?cb=<random>` cache-buster must not mint a cache entry.
 *
 * Cache-Control is set on the response (60 s at the CDN, 60 s stale) rather than
 * through a segment config export, which cacheComponents does not allow. A failed
 * read is a 503 with `no-store` and `Retry-After: 120`, never a cached empty
 * list. The route is dynamic (the limiter reads the client headers), so it is
 * not prerendered.
 */
const HEAD_HEADERS = {
  "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=60",
  "Content-Type": "application/json; charset=utf-8",
};

const timelineHeadLimit = createRateLimiter("timeline-head", {
  capacity: 30,
  refillPerSecond: 0.5,
});

export const GET = withApiErrors(async (request: Request) => {
  const rl = timelineHeadLimit(clientKey(request));
  if (!rl.allowed) return apiTooManyRequests(rl.retryAfterMs);

  const recent = await getRecentClusters();
  if (recent === null) {
    return apiError(
      503,
      "Timeline unavailable",
      {},
      { headers: { "Cache-Control": "no-store", "Retry-After": "120" } },
    );
  }

  return NextResponse.json(
    { clusters: toTimelineHead(recent.rows) },
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
