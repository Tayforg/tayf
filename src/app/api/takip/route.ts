import { NextResponse } from "next/server";

import { apiTooManyRequests, withApiErrors } from "@/lib/api/errors";
import { searchClusters } from "@/lib/clusters/search-query";
import type { ClusterBundle } from "@/lib/clusters/politics-query";
import { getTopicClusters, isTopicSlug } from "@/lib/clusters/topic-query";
import { getEntityHub } from "@/lib/entities/entity-hub-query";
import {
  formatZoneLine,
  sourceCountHead,
  votingZoneCounts,
} from "@/lib/feeds/zone-line";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import {
  FOLLOW_ITEMS_MAX,
  isFollowGundemKey,
  normalizeKeyword,
  RAW_MAX,
} from "@/lib/follows/follows";
import {
  ENGLISH_ONLY_ZONE_LINE,
  headlineLang,
  isLanguageIsolatedCluster,
  sourceLang,
} from "@/lib/sources/source-language";
import { repairEntityResidue } from "../../../../supabase/functions/_shared/rss/entities";

/**
 * GET /api/takip?q=<keyword> | ?konu=<slug> | ?gundem=<key> -- the read side of
 * "Takip ettiklerim". Follows are client-only (localStorage); this answers for
 * ONE follow at a time by reusing the readers the site already has:
 *   q      -> searchClusters   (the same path /?q= renders)
 *   konu   -> getTopicClusters (the same path /konu/[slug] renders)
 *   gundem -> getEntityHub     (the same path /gundem/[key] renders)
 * No database access of its own, no writes, no auth.
 *
 * Why gundem exists: a hub's "Takip et" used to follow the bare label as a
 * keyword, and the keyword search is a generic stemmed archive search -- it
 * lists "devam" under DEVA, Polish courts under Anayasa Mahkemesi and
 * municipal councils under Meclis, all of which the hub's matcher (curated
 * aliases, excludes, word boundaries; migration 125) filters out. The key is
 * checked against the RISING_ENTITIES key set before anything is read, so
 * request input never reaches the hub RPC as text.
 *
 * Ordering: a topic read already comes back newest-first (updated_at inside a
 * 7-day window), and so does a hub read (first_published desc inside the RPC's
 * 14-day window) -- both keep the reader's order. A keyword search is neither:
 * since migration 129 search_cluster_ids ranks its (up to 24) hits by relevance
 * (title literal, ts_rank, recency; article_count is only a tie-break) with no
 * date window. The caption above a keyword list promises "the most-corroborated
 * matches, newest first", so the route re-ranks the hits by effective source
 * count into a KEYWORD_POOL (12) of stories, shows that pool newest-first
 * (first_published), and only then applies the FOLLOW_ITEMS_MAX cap -- the cap
 * drops the oldest of the pool, never the best-sourced story.
 * The pool is chosen with a stable sort, so equal counts keep the RPC's
 * relevance order. That surfaces the freshest of the best-corroborated hits,
 * but it cannot add a fresh low-corroboration story the search never returned
 * or ranked into the pool: for a keyword follow the client's "yeni" count is a
 * lower bound, and the UI says the list is "most-corroborated matches" rather
 * than "latest". A truly recency-ordered keyword read would need its own RPC
 * (new migration); until then the copy stays honest instead.
 *
 * Caching: only the 200 is publicly cacheable (a follow's answer is the same
 * for every visitor, and both readers sit behind "use cache" anyway). Every
 * error answer is `no-store`, so a CDN can never pin a 400/429/503.
 *
 * Language (h118-english-1, WCAG 3.1.2): an item whose headline is an English
 * outlet's own article title carries `lang: 'en'` (the key is absent otherwise, so
 * a Turkish item's JSON is unchanged), and the zone line of a cluster whose every
 * member is an English outlet says it was not compared with Turkish sources
 * instead of printing coverage counts nobody could have earned.
 *
 * Privacy: the keyword is reader-typed input. It is never logged here (the
 * readers do not log it either) -- see tests/guards/no-pii-logging.
 */

const OK_CACHE_CONTROL =
  "public, max-age=60, s-maxage=300, stale-while-revalidate=600";

/**
 * How many of a keyword search's hits make the pool that is shown newest-first.
 * 12 is the pre-129 search page size ("ranks by article_count desc ... at most
 * 12 ids") the caption "En çok kaynaklı eşleşmeler" was written for; migration
 * 129 widened the RPC to 24 relevance-ranked hits, and this keeps the caption
 * true by taking the 12 best-corroborated of them.
 */
const KEYWORD_POOL = 12;

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

/** Source count printed on the row: wire-collapsed when the reader has it. */
function effectiveCount(b: ClusterBundle): number {
  return b.effectiveArticleCount ?? b.cluster.article_count;
}

// The most-corroborated KEYWORD_POOL of a keyword search's hits, in no
// particular display order (the caller sorts them newest-first). toSorted
// copies -- the cached array is never mutated -- and is stable, so equal
// counts keep the RPC's relevance order.
function mostCorroborated(bundles: readonly ClusterBundle[]): ClusterBundle[] {
  return bundles
    .toSorted((a, b) => effectiveCount(b) - effectiveCount(a))
    .slice(0, KEYWORD_POOL);
}

/** A title for comparing only: HTML entity residue repaired, anything else as it is. */
function comparable(title: unknown): string {
  return typeof title === "string" ? repairEntityResidue(title) : "";
}

/**
 * 'en' when the item's headline is an English outlet's own article title and no
 * Turkish outlet carries the same title: the ClusterCard / related-clusters rule
 * (headlineLang over the members, by source id; the slug decides, the display
 * name is the fallback). A neutral Turkish rewrite matches no member and gets
 * nothing. Never throws: a bundle without articles or sources answers undefined.
 */
function itemLang(b: ClusterBundle): "en" | undefined {
  const sourceById = new Map((b.sources ?? []).map((s) => [s.id, s]));
  return headlineLang(
    comparable(b.cluster.title_tr),
    (b.articles ?? []).map((a) => {
      const src = sourceById.get(a.source_id);
      return {
        title: comparable(a.title),
        lang: sourceLang({ slug: src?.slug, name: a.source_name ?? src?.name }),
      };
    }),
  );
}

function toItems(bundles: readonly ClusterBundle[]) {
  return bundles.slice(0, FOLLOW_ITEMS_MAX).map((b) => {
    // Voting basis, like the card the reader clicks through to: aggregators and
    // niche feeds are listed on it but never counted in its zone tally.
    const counts = votingZoneCounts(b.sources);
    const sourceCount = effectiveCount(b);
    const lang = itemLang(b);
    return {
      id: b.cluster.id,
      title: b.cluster.title_tr,
      firstPublished: b.cluster.first_published,
      updatedAt: b.cluster.updated_at,
      sourceCount,
      isBlindspot: b.cluster.is_blindspot === true,
      zoneLine: isLanguageIsolatedCluster(b.sources)
        ? ENGLISH_ONLY_ZONE_LINE
        : formatZoneLine(counts),
      // The head every other zone-line surface prints in front of it: 'N
      // kaynak', or 'N kaynak (M sınıflandırılmış)' when only M of the N
      // members vote, so the zone line next to it adds up.
      countHead: sourceCountHead(sourceCount, counts),
      // Only when 'en': a Turkish item's JSON keeps exactly its old keys.
      ...(lang === undefined ? {} : { lang }),
    };
  });
}

function okResponse(bundles: readonly ClusterBundle[], opts: { keywordPool: boolean }) {
  // keywordPool marks the keyword path only: pool by corroboration, then
  // newest first, then (in toItems) the cap. Topic and hub reads keep the
  // reader's own order.
  const ordered = opts.keywordPool ? newestFirst(mostCorroborated(bundles)) : bundles;
  return NextResponse.json(
    { items: toItems(ordered) },
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
  const gundemAll = params.getAll("gundem");

  // Exactly one parameter, exactly once (q, konu and gundem never combine).
  if (qAll.length + konuAll.length + gundemAll.length !== 1) {
    return errorResponse(400, "Geçersiz istek");
  }

  if (gundemAll.length === 1) {
    // Exact membership in the curated key set; anything else (a label, a
    // different case, "__proto__") is a 400 and never reaches the reader.
    const key = gundemAll[0] as string;
    if (!isFollowGundemKey(key)) return errorResponse(400, "Geçersiz gündem");

    const hub = await getEntityHub(key);
    if (hub === null) {
      return errorResponse(503, "Şu an yüklenemedi", { "Retry-After": "60" });
    }
    return okResponse(hub.bundles, { keywordPool: false });
  }

  if (qAll.length === 1) {
    const raw = qAll[0] as string;
    const keyword = raw.length > RAW_MAX ? null : normalizeKeyword(raw);
    if (keyword === null) return errorResponse(400, "Geçersiz anahtar kelime");

    const result = await searchClusters(keyword);
    if (!result.ok) {
      return errorResponse(503, "Şu an yüklenemedi", { "Retry-After": "60" });
    }
    return okResponse(result.bundles, { keywordPool: true });
  }

  const slug = konuAll[0] as string;
  if (!isTopicSlug(slug)) return errorResponse(400, "Geçersiz konu");

  const page = await getTopicClusters(slug, 1);
  if (page === null) {
    return errorResponse(503, "Şu an yüklenemedi", { "Retry-After": "60" });
  }
  return okResponse(page.bundles, { keywordPool: false });
});
