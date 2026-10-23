import { NextResponse } from "next/server";

import { apiTooManyRequests, withApiErrors } from "@/lib/api/errors";
import { searchClusters } from "@/lib/clusters/search-query";
import type { ClusterBundle } from "@/lib/clusters/politics-query";
import { getTopicClusters, isTopicSlug } from "@/lib/clusters/topic-query";
import { formatZoneLine, votingZoneCounts } from "@/lib/feeds/zone-line";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import {
  FOLLOW_ITEMS_MAX,
  normalizeKeyword,
  RAW_MAX,
} from "@/lib/follows/follows";

/**
 * GET /api/takip?q=<keyword> | ?konu=<slug> -- the read side of "Takip
 * ettiklerim". Follows are client-only (localStorage); this answers for ONE
 * follow at a time by reusing the readers the site already has:
 *   q    -> searchClusters   (the same path /?q= renders)
 *   konu -> getTopicClusters (the same path /konu/[slug] renders)
 * No database access of its own, no writes, no auth.
 *
 * Ordering: a topic read already comes back newest-first (updated_at inside a
 * 7-day window). A keyword search does NOT -- search_cluster_ids ranks by
 * article_count desc with no date window and returns at most 12 ids -- so a
 * keyword answer is re-ordered newest-first (first_published) before the cap.
 * That surfaces the freshest of what the search returned, but it cannot add a
 * fresh low-corroboration story the search never returned: for a keyword follow
 * the client's "yeni" count is a lower bound, and the UI says the list is
 * "most-corroborated matches" rather than "latest". A truly recency-ordered
 * keyword read would need its own RPC (new migration); until then the copy
 * stays honest instead.
 *
 * Caching: only the 200 is publicly cacheable (a follow's answer is the same
 * for every visitor, and both readers sit behind "use cache" anyway). Every
 * error answer is `no-store`, so a CDN can never pin a 400/429/503.
 *
 * Privacy: the keyword is reader-typed input. It is never logged here (the
 * readers do not log it either) -- see tests/guards/no-pii-logging.
 */

const OK_CACHE_CONTROL =
  "public, max-age=60, s-maxage=300, stale-while-revalidate=600";

const takipGetLimit = createRateLimiter("takip-get", {
  capacity: 40,
  refillPerSecond: 0.5,
});

// NextResponse.json with explicit headers for the 400/503 answers. The 429 goes
// through the shared apiTooManyRequests (Retry-After + no-store + canonical body).
function errorResponse(
  status: number,
  message: string,
  extraHeaders: Record<string, string> = {},
) {
  return NextResponse.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store", ...extraHeaders } },
  );
}

/** Instant for ordering; an unparseable date sorts after every real one. */
function publishedMs(b: ClusterBundle): number {
  const ms = Date.parse(b.cluster.first_published);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

// Newest first_published first. Array.prototype.toSorted copies (the readers
// sit behind "use cache", so their arrays must never be mutated) and is
// stable, so ties keep the reader's order. Compared as instants: PostgREST
// returns "+00:00" offsets, which a string comparison would mis-order.
function newestFirst(bundles: readonly ClusterBundle[]): ClusterBundle[] {
  return bundles.toSorted((a, b) => {
    const x = publishedMs(a);
    const y = publishedMs(b);
    if (x === y) return 0;
    return x < y ? 1 : -1;
  });
}

function toItems(bundles: readonly ClusterBundle[]) {
  return bundles.slice(0, FOLLOW_ITEMS_MAX).map((b) => ({
    id: b.cluster.id,
    title: b.cluster.title_tr,
    firstPublished: b.cluster.first_published,
    updatedAt: b.cluster.updated_at,
    sourceCount: b.effectiveArticleCount ?? b.cluster.article_count,
    isBlindspot: b.cluster.is_blindspot === true,
    // Voting basis, like the card the reader clicks through to: aggregators and
    // niche feeds are listed on it but never counted in its zone tally.
    zoneLine: formatZoneLine(votingZoneCounts(b.sources)),
  }));
}

function okResponse(bundles: readonly ClusterBundle[], opts: { recencySort: boolean }) {
  return NextResponse.json(
    { items: toItems(opts.recencySort ? newestFirst(bundles) : bundles) },
    { headers: { "Cache-Control": OK_CACHE_CONTROL } },
  );
}

export const GET = withApiErrors(async (request: Request) => {
  const rl = takipGetLimit(clientKey(request));
  if (!rl.allowed) {
    return apiTooManyRequests(rl.retryAfterMs, { message: "Çok fazla istek" });
  }

  const params = new URL(request.url).searchParams;
  const qAll = params.getAll("q");
  const konuAll = params.getAll("konu");

  // Exactly one parameter, exactly once.
  if (qAll.length + konuAll.length !== 1) {
    return errorResponse(400, "Geçersiz istek");
  }

  if (qAll.length === 1) {
    const raw = qAll[0] as string;
    const keyword = raw.length > RAW_MAX ? null : normalizeKeyword(raw);
    if (keyword === null) return errorResponse(400, "Geçersiz anahtar kelime");

    const result = await searchClusters(keyword);
    if (!result.ok) {
      return errorResponse(503, "Şu an yüklenemedi", { "Retry-After": "60" });
    }
    return okResponse(result.bundles, { recencySort: true });
  }

  const slug = konuAll[0] as string;
  if (!isTopicSlug(slug)) return errorResponse(400, "Geçersiz konu");

  const page = await getTopicClusters(slug, 1);
  if (page === null) {
    return errorResponse(503, "Şu an yüklenemedi", { "Retry-After": "60" });
  }
  return okResponse(page.bundles, { recencySort: false });
});
