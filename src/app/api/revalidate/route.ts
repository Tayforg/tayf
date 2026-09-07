import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { requireCronBearer } from "@/lib/api/bearer";
import { apiBadRequest, apiError, withApiErrors } from "@/lib/api/errors";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";

/**
 * On-demand cache revalidation for trusted internal callers (currently the
 * `cluster-consumer` Deno Edge Function, right after it writes clusters).
 * POST { tags: string[] } -> revalidates each tag via Next's `revalidateTag`
 * so readers see fresh data before the `cluster-feed` cacheLife TTL expires.
 *
 * AUTH: same CRON_SECRET bearer gate as /api/cron/headline
 * (`requireCronBearer`) — FAIL-CLOSED 503 when unset, 401 on bad/missing
 * token.
 */

// Only tags this deployment actually tags cached data with — anything else
// is a 400, so a leaked bearer token still can't revalidate arbitrary tags.
const STATIC_TAG_ALLOWLIST = new Set(["clusters", "clusters-politics"]);
const CLUSTER_DETAIL_TAG_RE = /^cluster-detail:[0-9a-f-]{36}$/;

function isAllowedTag(tag: string): boolean {
  return STATIC_TAG_ALLOWLIST.has(tag) || CLUSTER_DETAIL_TAG_RE.test(tag);
}

const MAX_TAGS = 100;

// Process-local token bucket, 30 calls/minute. The one real caller fires
// this once per drain cycle — this just guards a runaway retry loop.
const revalidateLimit = createRateLimiter("revalidate-post", {
  capacity: 30,
  refillPerSecond: 30 / 60,
});

export const POST = withApiErrors(async (request: Request) => {
  const auth = requireCronBearer(request);
  if (!auth.ok) {
    return auth.response;
  }

  const rl = revalidateLimit(clientKey(request));
  if (!rl.allowed) {
    return apiError(429, "Too many requests", {
      details: { retryAfterMs: rl.retryAfterMs },
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiBadRequest("Invalid JSON body");
  }

  if (typeof body !== "object" || body === null) {
    return apiBadRequest("Invalid request body");
  }

  const tags = (body as Record<string, unknown>).tags;
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string")) {
    return apiBadRequest("`tags` must be an array of strings");
  }

  if (tags.length > MAX_TAGS) {
    return apiBadRequest(`Too many tags (max ${MAX_TAGS})`);
  }

  const uniqueTags = Array.from(new Set(tags as string[]));

  for (const tag of uniqueTags) {
    if (!isAllowedTag(tag)) {
      return apiBadRequest(`Tag not allowed: ${tag}`);
    }
  }

  for (const tag of uniqueTags) {
    revalidateTag(tag, "max");
  }

  return NextResponse.json({ revalidated: uniqueTags.length });
});
