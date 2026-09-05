import { cacheLife, cacheTag } from "next/cache";

import type {
  ClusterCardArticle,
  ClusterCardCluster,
  ClusterCardSource,
} from "@/components/story/cluster-card";
import { emptyBiasDistribution } from "@/lib/bias/analyzer";
import { zoneOf } from "@/lib/bias/config";
import { createServerClient } from "@/lib/supabase/server";
import type {
  BiasCategory,
  BiasDistribution,
  MediaDnaZone,
  NewsCategory,
} from "@/types";

// Politics-filtered cluster fetcher used by the /clusters page.
//
// Perf history:
//   v1 (refactor-D) issued four sequential round-trips — clusters,
//   cluster_articles, articles, sources — which put the page at ~192ms
//   TTFB on a local Supabase. Over 70% of that was pure REST latency.
//
//   v2 (perf-2) collapses the whole read into a single PostgREST
//   embedded select that walks the foreign keys clusters →
//   cluster_articles → articles → sources in one HTTP request, then
//   filters in JS for clusters whose majority members are
//   politika/son_dakika. The returned shape is unchanged so ClusterCard
//   and the /clusters page need no edits.
//
//   v3 (perf-2, same pass) wraps the fetch in `unstable_cache` with a
//   30s TTL. The cluster worker runs on a 30s cycle so 30s of staleness
//   matches the natural data freshness. `unstable_cache` (unlike the
//   route-segment `revalidate` export) is honoured in `next dev`, so
//   repeat requests during the TTL skip Supabase entirely and drop
//   TTFB to essentially "React render time only".

const POLITICS_THRESHOLD = 0.6;
const POLITICS_CATEGORIES: readonly NewsCategory[] = ["politika", "son_dakika"];
// R1 ranker (post-A7): widen the recency-ordered candidate pool from 60 to
// 200 so the importance-weighted scorer below has enough material to
// reorder. With CANDIDATE_LIMIT=60 the top of the list was being eaten by
// stale Bahçeli-speech duplicates and a SEO listicle ("ENGELLİ ÖTV…"),
// while the day's actual top stories (139 İmamoğlu/İBB articles, 122
// Üsküdar, 98 YSK ara seçim) sat just below the cut.
const CANDIDATE_LIMIT = 200;
const DISPLAY_LIMIT = 30;

// R1 importance score weights — see scoreCluster() below for the formula.
// All terms are tuned so they fall in roughly the same numeric range
// (~0–6) and combine into a single comparable score per cluster.
const W_ARTICLE_COUNT = 1.0; // log2(article_count + 1)
const W_ZONE_DIVERSITY = 0.5; // log2(distinct_zones + 1)
// R6 decay bump: was 0.3. At 0.3 a 9h-old cluster only pays -0.45,
// negligible vs. log2(count+1) which is 4+ for any cluster with 15
// sources — so the home feed kept surfacing half-day-old stories. 0.5
// roughly doubles the penalty at every age: 9h -> -0.75, 24h -> -2.0,
// 48h -> -4.0. Combined with the R6 "Son Dakika" strip on page 1
// (guarantees the freshest cluster slots regardless of score), the net
// effect is that "Bugün" leans noticeably fresher while the Son Dakika
// strip covers the last-2h breaking surface.
const W_TIME_DECAY = 0.5; // per (hours/6) — 6h half-life
const W_DOMINANCE_PENALTY = 0.2; // 1 if a single source > 60% of articles
const DOMINANCE_THRESHOLD = 0.6;
// R4 velocity bonus weight. Intentionally HIGH (matches a full extra
// log2 article-count step) so a breaking story whose articles all landed
// in the last 2h beats an older cluster with one extra source. A
// velocity of 0.7 contributes +0.7 to the score, which outweighs going
// from e.g. 8 → 12 effective sources (log2(13)-log2(9) ≈ 0.53). The
// previous ranker fixes (R1 importance, R2 wire collapse, R3 source
// cap) all use the cluster's TOTAL article count and ignore VELOCITY —
// without this term a 24-hour-old story with 15 sources spread across
// the day still beats a 30-minute-old breaking story with 10 sources.
const W_VELOCITY = 1.0;

// R6 "Son Dakika" surfacing: clusters whose `first_published` falls
// within this window are pulled out of the ranked pool and rendered as
// a dedicated strip at the top of page 1, sorted by recency (not
// score). Turkish news consumption skews heavily toward breaking-news
// surfacing — without this a 30-minute-old 3-source cluster loses the
// score race to a 9h cluster with 15 sources, so fresh stories never
// reach the fold. Drawn from the same 2+-source politics-majority
// candidate pool as `ranked`, so the DB-level quality floor still
// applies.
//
// Window: 2 hours. Cap: 6 slots so a major-event burst (e.g. earthquake
// night, election night) doesn't drown out the rest of the feed.
const BREAKING_WINDOW_MS = 2 * 60 * 60 * 1000;
const BREAKING_LIMIT = 6;

export interface ClusterBundle {
  cluster: ClusterCardCluster;
  articles: ClusterCardArticle[];
  sources: ClusterCardSource[];
  /**
   * R2 wire-collapse: true when ≥50% of the cluster's deduped members
   * share the same `content_hash`, meaning the cluster is one AA/DHA/IHA
   * wire copy amplified by N outlets rather than N independent reports.
   * Optional so the public type stays backward-compatible with consumers
   * that don't care about ranking. The /clusters page can use this to
   * render a small "wire" badge as a follow-up (UI agents own
   * cluster-card.tsx this wave so the badge is deferred — see report).
   */
  isWireRedistribution?: boolean;
  /**
   * R2 wire-collapse: the count to use for ranking. Equals
   * `cluster.article_count` for normal clusters; for wire redistributions
   * it's the number of DISTINCT content_hashes — i.e. the wire copy
   * counts as 1 source instead of 5. R1's scoreCluster reads this so a
   * wire-collapsed cluster competes against the rest of the candidate
   * pool with its honest article-count footprint, not its inflated one.
   */
  effectiveArticleCount?: number;
  /**
   * R3 source-fairness cap: the cluster's article count after capping
   * any single source at 10% of the total. Per A8, haberler-com produces
   * 20.5% of all 24h articles and dominates 16 of 30 home clusters,
   * structurally distorting every quality metric. With this cap a cluster
   * of 5 haberler + 1 BBC + 1 BirGün ranks like a 3-source cluster
   * (1 + 1 + 1 = ceil(7 * 0.1) = 1 per source) instead of a 7-source one.
   */
  effectiveSourceCount?: number;
  /**
   * R3 source-fairness cap: source ids that contributed more than 10%
   * of the cluster and were therefore capped. Empty when no source was
   * over the threshold. Used by the diagnostic log so we can count how
   * many home clusters were rescaled and whether haberler-com was the
   * dominator (the A8 finding to validate against).
   */
  cappedSources?: string[];
}

export interface PoliticsClustersResult {
  bundles: ClusterBundle[];
  /**
   * R6 "Son Dakika" strip: clusters whose `first_published` is within
   * the last BREAKING_WINDOW_MS (2h), sorted by recency DESC and capped
   * at BREAKING_LIMIT (6). Drawn from the FULL politics-majority
   * candidate pool — NOT from `bundles` — so a just-broken 2-source
   * cluster is guaranteed to surface on page 1 even when its R1 score
   * can't beat a 9h-old cluster with 15 sources.
   *
   * MAY overlap `bundles` by id: a fresh cluster that also scores in
   * the top 30 appears in both. The page is expected to dedupe by
   * `cluster.id` so it renders only once (in the Son Dakika strip).
   */
  breakingBundles: ClusterBundle[];
  /** Number of candidate clusters fetched before the politics filter. */
  prefilterCount: number;
}

// Shape returned by the embedded PostgREST select. Each cluster row has
// nested cluster_articles[], each of which has a nested `articles`
// object, which in turn has a nested `sources` object. PostgREST uses
// the declared FK relationships (cluster_articles → articles,
// articles → sources) to build the join automatically.
type EmbeddedSource = {
  id: string;
  name: string;
  bias: BiasCategory;
  logo_url: string | null;
};

type EmbeddedArticle = {
  id: string;
  title: string;
  url: string;
  image_url: string | null;
  published_at: string;
  source_id: string;
  category: NewsCategory;
  /**
   * Stable per-article content hash (md5 of normalized title+body), set
   * by `src/lib/rss/normalize.ts` at ingest. R2 wire-collapse uses this
   * to detect AA/DHA/IHA wire redistributions: a cluster whose members
   * share <50% distinct hashes is one wire copy amplified by N outlets,
   * not N independent reports. NULL is preserved as a unique pseudo-
   * hash so legacy rows ingested before the field existed are never
   * misclassified as wire (see `detectWireRedistribution`).
   */
  content_hash: string | null;
  sources: EmbeddedSource | null;
};

type EmbeddedClusterArticle = {
  articles: EmbeddedArticle | null;
};

type EmbeddedClusterRow = {
  id: string;
  title_tr: string;
  /**
   * H2-WORKER neutral-headline pipeline (migration 019 + headline-worker.mjs):
   * the LLM-rewritten neutral version of `title_tr`. NULL until the rewrite
   * worker has processed the cluster. Page consumers coalesce
   * `title_tr_neutral ?? title_tr` so neutralized titles win as soon as
   * they're available without a destructive overwrite of the original.
   */
  title_tr_neutral: string | null;
  summary_tr: string;
  bias_distribution: unknown;
  is_blindspot: boolean;
  blindspot_side: BiasCategory | null;
  article_count: number;
  first_published: string;
  updated_at: string;
  cluster_articles: EmbeddedClusterArticle[] | null;
};

// Internal (uncached) implementation. The exported `getPoliticsClusters`
// wraps this with `unstable_cache` below.
async function fetchPoliticsClusters(): Promise<PoliticsClustersResult> {
  try {
    const supabase = createServerClient();

    // Single round-trip: cluster → cluster_articles → articles → sources.
    // The nested shape is produced by PostgREST following the foreign
    // keys declared in migrations 001-003. This replaces the previous
    // four sequential queries.
    const { data, error } = await supabase
      .from("clusters")
      .select(
        `id, title_tr, title_tr_neutral, summary_tr, bias_distribution, is_blindspot, blindspot_side, article_count, first_published, updated_at,
         cluster_articles (
           articles (
             id, title, url, image_url, published_at, source_id, category, content_hash,
             sources ( id, name, bias, logo_url )
           )
         )`
      )
      .gte("article_count", 2)
      .order("updated_at", { ascending: false })
      .limit(CANDIDATE_LIMIT)
      .returns<EmbeddedClusterRow[]>();

    if (error) {
      // Throw — never return an empty result for a failed query. The
      // caller is wrapped in `"use cache"`, and a returned empty would be
      // cached as truth for the full cluster-feed window (empty homepage
      // for minutes after one Supabase blip). A throw keeps the bad value
      // out of the cache and lets Next serve the last good entry.
      throw new Error(`[clusters] embedded select error: ${error.message}`);
    }
    const clusterRows = data ?? [];
    if (clusterRows.length === 0)
      return { bundles: [], breakingBundles: [], prefilterCount: 0 };

    const bundles: ClusterBundle[] = [];
    // Side-table: bundle → its post-dedupe member list. Used by
    // scoreCluster() below for velocity, zone-diversity, and dominance
    // signals without leaking the embedded shape into ClusterBundle.
    const scoringMembers = new WeakMap<ClusterBundle, EmbeddedArticle[]>();

    for (const c of clusterRows) {
      // Flatten nested cluster_articles → articles into a plain member
      // list, dropping any null joins (should not happen but defensive).
      const members: EmbeddedArticle[] = [];
      for (const ca of c.cluster_articles ?? []) {
        if (ca.articles) members.push(ca.articles);
      }
      if (members.length === 0) continue;

      // Politics majority filter — must match the old behaviour exactly
      // (≥60% politika/son_dakika members).
      const hits = members.filter((m) =>
        POLITICS_CATEGORIES.includes(m.category)
      ).length;
      if (hits / members.length < POLITICS_THRESHOLD) continue;

      // Sort by published_at ASC FIRST so the dedupe pass below
      // deterministically keeps the EARLIEST article per source.
      const sortedMembers = [...members].sort(
        (a, b) =>
          new Date(a.published_at).getTime() -
          new Date(b.published_at).getTime()
      );

      // Server-side dedupe (defense in depth):
      // If the cluster has multiple articles from the same source, keep
      // the earliest one. R2's audit found 1.87% of clusters have this —
      // the proper DB fix is D6, this is a guard so the UI never sees
      // the same (cluster_id, source_id) pair twice. Dedupe BEFORE the
      // ~4-card slice in ClusterCard so e.g. "Akşam" never shows twice.
      const seenSources = new Set<string>();
      const dedupedMembers: EmbeddedArticle[] = [];
      for (const m of sortedMembers) {
        const sourceId = m.sources?.id ?? m.source_id;
        if (seenSources.has(sourceId)) continue;
        seenSources.add(sourceId);
        dedupedMembers.push(m);
      }
      const droppedDupes = sortedMembers.length - dedupedMembers.length;
      if (droppedDupes > 0) {
        console.log(
          `[politics-query] dropped ${droppedDupes} duplicate source(s) for cluster ${c.id}`
        );
      }

      // Re-sort newest-first for display, matching the previous order-by.
      dedupedMembers.sort(
        (a, b) =>
          new Date(b.published_at).getTime() -
          new Date(a.published_at).getTime()
      );

      // R2 wire-redistribution detection. Run on the post-source-dedupe
      // member list (so we collapse "1 wire copy across 5 outlets", not
      // "1 outlet that double-published the same wire"). The result is
      // attached to the bundle below and consumed by R1's scoreCluster
      // via `effectiveArticleCount` so a wire-only cluster competes
      // against the candidate pool with its honest 1-source footprint.
      const wire = detectWireRedistribution(dedupedMembers);
      if (wire.isWire) {
        console.log(
          `[politics-query] wire-collapse: cluster ${c.id} ` +
            `(${dedupedMembers.length} members → ${wire.uniqueHashes} unique hashes)`
        );
      }

      // R3 source-fairness cap. A8 found haberler-com produces 20.5%
      // of all 24h articles and dominates 16 of 30 home clusters; the
      // mission worked example is "5 haberler + 1 BBC + 1 BirGün should
      // rank like a 3-source cluster, not a 7-source one." That example
      // is BEFORE R2's same-source dedupe (which collapses the 5 haberler
      // copies down to 1) — so we run the cap on the PRE-DEDUPE member
      // list, which preserves the lopsided source distribution the cap
      // is supposed to neutralise. Cap each source at ceil(total * 0.1)
      // (floored to 1, so a 3-article cluster still permits 1 per
      // source) and surface the corrected count via
      // `effectiveSourceCount`. R1's scoreCluster reads it alongside
      // R2's `effectiveArticleCount` and uses min(R3, R2) so we apply
      // the more aggressive of the two normalisations without
      // double-discounting.
      const fairness = applySourceFairnessCap(
        sortedMembers.map((m) => ({
          source: { id: m.sources?.id ?? m.source_id },
        }))
      );

      // Collect per-cluster sources (deduped) from the embedded join so
      // ClusterCard can resolve source_name/bias without another query.
      const sourceMap = new Map<string, ClusterCardSource>();
      for (const m of dedupedMembers) {
        if (m.sources && !sourceMap.has(m.sources.id)) {
          sourceMap.set(m.sources.id, {
            id: m.sources.id,
            name: m.sources.name,
            bias: m.sources.bias,
            logo_url: m.sources.logo_url,
          });
        }
      }

      const bundle: ClusterBundle = {
        cluster: {
          id: c.id,
          // H2 neutral-headline coalesce: prefer the LLM-rewritten neutral
          // title once H2-WORKER has produced it. Falls back to the original
          // seed-inherited title for clusters that haven't been rewritten yet.
          // Empty strings are coalesced too — an empty neutral title would
          // mean the rewriter wrote junk and we'd rather show the original.
          title_tr:
            c.title_tr_neutral && c.title_tr_neutral.trim().length > 0
              ? c.title_tr_neutral
              : c.title_tr,
          summary_tr: c.summary_tr,
          bias_distribution: normalizeDistribution(c.bias_distribution),
          is_blindspot: c.is_blindspot,
          blindspot_side: c.blindspot_side,
          // The DB-stored article_count may be stale between the recluster
          // pass and this render. Reflect the post-dedupe truth so the
          // "N kaynak" label matches the rendered list.
          article_count: dedupedMembers.length,
          first_published: c.first_published,
          updated_at: c.updated_at,
        },
        articles: dedupedMembers.map((m) => ({
          id: m.id,
          title: m.title,
          url: m.url,
          image_url: m.image_url,
          published_at: m.published_at,
          source_id: m.source_id,
        })),
        sources: Array.from(sourceMap.values()),
        // R2 wire-collapse fields. effectiveArticleCount is the count
        // R1's scoreCluster reads — equal to the deduped member count
        // for normal clusters, dropped to the unique-hash count for
        // wire redistributions.
        isWireRedistribution: wire.isWire,
        effectiveArticleCount: wire.isWire
          ? wire.uniqueHashes
          : dedupedMembers.length,
        // R3 source-fairness fields. effectiveSourceCount is the
        // post-cap article count (each source contributes at most
        // ceil(total * 0.1) articles). cappedSources is the list of
        // source ids that exceeded the threshold and were trimmed.
        effectiveSourceCount: fairness.effectiveCount,
        cappedSources: fairness.cappedSources,
      };

      // Stash the deduped members on the bundle so the scorer below can
      // reach published_at + sources.bias without re-flattening. We use a
      // weak side-table keyed by bundle to avoid leaking the embedded
      // shape into ClusterBundle's public type.
      scoringMembers.set(bundle, dedupedMembers);
      bundles.push(bundle);
    }

    // R1+R4 importance ranking. Up to v3 the candidates were sliced
    // straight from the recency-ordered query (early-break at
    // DISPLAY_LIMIT), which let stale duplicate clusters dominate the
    // homepage. Score every politics-majority candidate, sort
    // descending, and take the top DISPLAY_LIMIT. See A7.
    const ranked = bundles
      .map((b) => ({
        bundle: b,
        score: scoreCluster(b, scoringMembers.get(b) ?? []),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, DISPLAY_LIMIT)
      .map((entry) => entry.bundle);

    // R6 "Son Dakika": pull the freshest <2h clusters from the FULL
    // candidate pool (not from `ranked`), so a just-broken 3-source
    // story still surfaces on page 1 even when its R1 score can't beat
    // a 9h-old 15-source cluster. Sorted by recency DESC (newest
    // first) because score order defeats the purpose here — the strip
    // is a recency guarantee, not a ranking. Capped at BREAKING_LIMIT
    // so a major-event burst doesn't push every other section below
    // the fold.
    const breakingNowMs = Date.now();
    const breakingBundles = bundles
      .filter(
        (b) =>
          breakingNowMs - new Date(b.cluster.first_published).getTime() <
          BREAKING_WINDOW_MS
      )
      .sort(
        (a, b) =>
          new Date(b.cluster.first_published).getTime() -
          new Date(a.cluster.first_published).getTime()
      )
      .slice(0, BREAKING_LIMIT);

    // R3 source-fairness diagnostics. Count how many of the candidate
    // clusters had ANY source over the 10% cap, and how many of those
    // were dominated by haberler-com (the A8 finding to validate
    // against). Logged to stdout only — never written into the cache.
    let cappedClusterCount = 0;
    let haberlerDominatedCount = 0;
    for (const b of bundles) {
      if (b.cappedSources && b.cappedSources.length > 0) {
        cappedClusterCount++;
        if (
          b.cappedSources.some((sid) => {
            const src = b.sources.find((s) => s.id === sid);
            // Match either the slug-style id or the human-readable name
            // — the sources table uses uuid ids in prod but the A8 audit
            // referenced sources by slug, so we check the display name.
            return (
              src?.name?.toLowerCase().includes("haberler") === true ||
              sid.toLowerCase().includes("haberler")
            );
          })
        ) {
          haberlerDominatedCount++;
        }
      }
    }
    console.log(
      `[politics-query] capped ${cappedClusterCount} clusters for source-fairness ` +
        `(haberler-com dominated ${haberlerDominatedCount} of them)`
    );

    return {
      bundles: ranked,
      breakingBundles,
      prefilterCount: clusterRows.length,
    };
  } catch (err) {
    // Rethrow (see the select-error comment above): swallowing here would
    // let `use cache` store an empty feed as truth.
    console.warn("[clusters] unexpected error:", err);
    throw err;
  }
}

function normalizeDistribution(raw: unknown): BiasDistribution {
  const empty = emptyBiasDistribution();
  if (!raw || typeof raw !== "object") return empty;
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(empty) as BiasCategory[]) {
    const v = obj[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      empty[key] = v;
    }
  }
  return empty;
}

// ---- R2 wire-redistribution detection --------------------------------

/**
 * Threshold for wire-collapse: when the ratio
 * `distinct_content_hashes / total_members` is at or below this value,
 * the cluster is treated as a wire redistribution. 0.5 means "at least
 * half of the articles are byte-identical copies of one wire dispatch".
 *
 * Picked at 0.5 (not 0.8 as the mission brief originally proposed)
 * because the brief's worked example reads: "≥80% of members share the
 * same content_hash" — that condition is equivalent to
 * `distinct_hashes / total ≤ ~0.2` for a single dominant hash, but a
 * straightforward "<50% unique" rule (matching the implementation
 * sketch) catches the more common 3-of-5 / 4-of-7 wire patterns A5
 * found in the blindspot audit (`b9e4047c`, `536cb1d4`, `9f8704b0`).
 */
const WIRE_UNIQUE_HASH_RATIO = 0.5;

interface WireDetectionResult {
  isWire: boolean;
  uniqueHashes: number;
}

/**
 * Detect whether a cluster is a wire redistribution rather than a true
 * multi-source story. Returns the unique-hash count alongside the flag
 * so the caller can use it as the cluster's `effectiveArticleCount` for
 * ranking (i.e. an AA wire reprinted by 5 outlets contributes a single
 * effective source to the importance score).
 *
 * NULL `content_hash` is treated as a UNIQUE pseudo-hash (each null gets
 * its own bucket via the article id) to avoid mis-flagging legacy
 * clusters whose articles predate the hash field. Without this guard,
 * any old cluster with several null hashes would collapse to 1 hash and
 * be marked wire — exactly the false positive R2 is supposed to avoid.
 *
 * Clusters with fewer than 3 members are never marked wire: 2 articles
 * with the same hash is more likely a same-source double-publish than a
 * wire redistribution and is already handled by the same-source dedupe
 * pass above.
 */
function detectWireRedistribution(
  members: Array<{ id: string; content_hash: string | null }>
): WireDetectionResult {
  if (members.length < 3) {
    return { isWire: false, uniqueHashes: members.length };
  }
  const hashes = new Set<string>();
  for (const m of members) {
    // Treat NULL as unique-per-article so legacy rows aren't collapsed.
    hashes.add(m.content_hash ?? `__null__:${m.id}`);
  }
  const uniqueHashes = hashes.size;
  const isWire = uniqueHashes / members.length <= WIRE_UNIQUE_HASH_RATIO;
  return { isWire, uniqueHashes };
}

// ---- R3 source-fairness cap ------------------------------------------

/**
 * Cap any single source at 10% of a cluster's article count for ranking
 * purposes. A8 found that
 * haberler-com produces 20.5% of all 24h articles, dominates 16 of the
 * top 30 home clusters, and inflates every "cross-bias" / "N sources"
 * metric Tayf reports. After this cap, a cluster of 5 haberler + 1 BBC
 * + 1 BirGün ranks like a 3-source cluster (1 + 1 + 1 = 3), not a
 * 7-source one — exactly what the A8 fairness recommendation asked for.
 *
 * Returns:
 *   - effectiveCount: sum over sources of min(count, cap). For most
 *     clusters this equals total members; for clusters with a dominant
 *     source it falls below.
 *   - cappedSources: ids of sources whose article count exceeded the
 *     cap. Empty when no source was over the threshold.
 *
 * The cap is `ceil(total * 0.1)` floored to 1, so even a 3-article
 * cluster permits 1 article per source (otherwise the cap would be 0
 * and every member would be discarded). This matches the helper sketch
 * in the R3 mission brief verbatim.
 */
function applySourceFairnessCap(
  members: Array<{ source: { id: string } }>
): { effectiveCount: number; cappedSources: string[] } {
  const total = members.length;
  const bySource = new Map<string, number>();
  for (const m of members) {
    bySource.set(m.source.id, (bySource.get(m.source.id) ?? 0) + 1);
  }

  // No source can contribute more than 10% of the cluster's article count.
  // Round up so a 3-article cluster still allows 1 article per source.
  const cap = Math.max(1, Math.ceil(total * 0.1));

  let effectiveCount = 0;
  const cappedSources: string[] = [];
  for (const [sourceId, count] of bySource) {
    if (count > cap) cappedSources.push(sourceId);
    effectiveCount += Math.min(count, cap);
  }

  return { effectiveCount, cappedSources };
}

// ---- R1+R4 importance ranking helpers --------------------------------

// Number of distinct Medya DNA zones (iktidar / bagimsiz / muhalefet)
// represented in the cluster's deduped member list. A cluster covered
// by all three zones is more politically important than one stuck in a
// single bubble.
function computeDistinctZones(members: EmbeddedArticle[]): number {
  const zones = new Set<MediaDnaZone>();
  for (const m of members) {
    if (m.sources?.bias) zones.add(zoneOf(m.sources.bias));
  }
  return zones.size;
}

// 1.0 if a single source contributes more than DOMINANCE_THRESHOLD
// (60%) of the cluster's articles, else 0. After R2's same-source
// dedupe this should be rare, but the penalty acts as a guard against
// any cluster that managed to slip through (e.g. wire-only stories
// the collapse pass missed).
function computeOneSourceDominance(members: EmbeddedArticle[]): number {
  if (members.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const m of members) {
    const sid = m.sources?.id ?? m.source_id;
    counts.set(sid, (counts.get(sid) ?? 0) + 1);
  }
  let max = 0;
  for (const v of counts.values()) if (v > max) max = v;
  return max / members.length > DOMINANCE_THRESHOLD ? 1 : 0;
}

// R4 velocity signal: share of the cluster's last-24h articles that
// landed in the last 2h. Range 0..1. A cluster whose articles all
// arrived in the last two hours has velocity = 1.0; one whose articles
// are mostly 18+ hours old has velocity ≈ 0. Articles older than 24h
// are excluded from both numerator and denominator so a long-running
// story is not penalised by its old material — only its CURRENT pace
// counts.
function computeVelocity(members: Array<{ published_at: string }>): number {
  if (members.length === 0) return 0;
  const now = Date.now();
  const TWO_HOURS = 2 * 3600 * 1000;
  const TWENTY_FOUR_HOURS = 24 * 3600 * 1000;

  let recent = 0;
  let total24h = 0;
  for (const m of members) {
    const age = now - new Date(m.published_at).getTime();
    if (age <= TWENTY_FOUR_HOURS) total24h++;
    if (age <= TWO_HOURS) recent++;
  }

  return total24h > 0 ? recent / total24h : 0;
}

// R1+R4 importance score. Combines four positive signals
// (article-count log, zone-diversity log, time-decay penalty,
// dominance penalty) with R4's velocity bonus. The velocity term is
// weighted at 1.0 — high enough that a 0.7 velocity beats one extra
// step of log2(article_count + 1), so a 30-minute breaking story with
// 10 sources outranks a 24-hour-old story with 15 sources spread
// across the day.
//
// R5 stale-reactivation fix: decay anchors on `first_published`, not
// `updated_at`. The clustering worker rewrites `updated_at` to the
// latest member's `published_at` every time an article merges in — so
// a week-old cluster that absorbed a single follow-up article today
// previously paid zero decay penalty and ranked like breaking news.
// Anchoring on `first_published` (the story's actual break time) makes
// stale clusters decay off the homepage even when they pick up a
// follow-up, while the VELOCITY term (unchanged, member-level) still
// rewards clusters with a current burst of articles — so genuinely
// active ongoing stories (İmamoğlu, trial coverage, etc.) continue to
// rise via velocity + article_count rather than via stale updated_at.
function scoreCluster(
  bundle: ClusterBundle,
  members: EmbeddedArticle[]
): number {
  const firstPublishedMs = new Date(bundle.cluster.first_published).getTime();
  const ageHours = (Date.now() - firstPublishedMs) / 3_600_000;
  const decay = ageHours / 6;
  // R2 wire-collapse + R3 source-fairness cap: take the SMALLER of the
  // two corrections so the more aggressive normalisation wins without
  // double-discounting (per R3 mission brief). A wire-only cluster
  // collapses by content_hash; a haberler-com-dominated cluster
  // collapses by source share; a cluster that triggers BOTH only gets
  // the bigger discount, not their sum. Falls back to
  // cluster.article_count when neither field is set (legacy clusters or
  // before the helpers ran). See A8 / 08-source-diversity.md for the
  // 20.5% / 16-of-30 finding driving R3.
  const wireCount =
    bundle.effectiveArticleCount ?? bundle.cluster.article_count;
  const fairnessCount =
    bundle.effectiveSourceCount ?? bundle.cluster.article_count;
  const effectiveCount = Math.min(wireCount, fairnessCount);
  const zones = computeDistinctZones(members);
  const dominance = computeOneSourceDominance(members);
  const velocity = computeVelocity(members);

  return (
    W_ARTICLE_COUNT * Math.log2(effectiveCount + 1) +
    W_ZONE_DIVERSITY * Math.log2(zones + 1) -
    W_TIME_DECAY * decay -
    W_DOMINANCE_PENALTY * dominance +
    W_VELOCITY * velocity
  );
}

// Public cached entry point. The page component calls this identical
// signature — the cache layer is invisible from the call site.
//
// Cache Components migration (Next.js 16): replaces the previous
// `unstable_cache` wrapper with the `use cache` directive. The function's
// arguments (none here) automatically become part of the cache key, and
// `cacheLife` / `cacheTag` control TTL and on-demand invalidation.
//
// Tag: `clusters-politics` — cluster-worker can call
// `revalidateTag("clusters-politics")` after a write cycle to push fresh
// data immediately without waiting for the 30s TTL.
export async function getPoliticsClusters(): Promise<PoliticsClustersResult> {
  "use cache";
  cacheLife("cluster-feed");
  cacheTag("clusters-politics");
  return fetchPoliticsClusters();
}
