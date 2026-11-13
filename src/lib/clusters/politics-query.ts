import { cacheLife, cacheTag } from "next/cache";

import type {
  ClusterCardArticle,
  ClusterCardCluster,
  ClusterCardSource,
} from "@/components/story/cluster-card";
import { emptyBiasDistribution } from "@/lib/bias/analyzer";
import { isPoliticsMember, isVotingKind, tallyZones, zoneOf } from "@/lib/bias/config";
import { attemptCached, resolveCachedOrThrow } from "@/lib/cache-resilience";
import { isOptimizableImageUrl, isPlaceholderImageUrl } from "@/lib/images/image-url";
import { isLanguageIsolatedCluster } from "@/lib/sources/source-language";
import {
  createReaderClient,
  createServerClient,
  type ReadProfile,
} from "@/lib/supabase/server";
import { WEEK_MS } from "@/lib/weekly/weekly-query";
import type {
  BiasCategory,
  BiasDistribution,
  MediaDnaZone,
  NewsCategory,
  SourceKind,
} from "@/types";
import {
  degradedSilentZone,
  getZoneFeedHealth,
  shouldSuppressBlindspot,
  type ZoneFeedHealth,
} from "./feed-health";
import { clusterDisplayTitle } from "./display-headline";
import { logRecallVeto, publicBlindspotClaim } from "./recall-veto";
import { detectWireRedistribution } from "./wire";

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
// isPoliticsMember (migration 089, "ADMIT") replaces the local
// POLITICS_CATEGORIES literal: a member counts as politics either by its
// own category (politika/son_dakika) or by a live politics_admitted_at
// stamp. Inert today (nothing is ever stamped while the flag is off).
// R1 ranker (post-A7): widen the recency-ordered candidate pool from 60 to
// 200 so the importance-weighted scorer below has enough material to
// reorder. With CANDIDATE_LIMIT=60 the top of the list was being eaten by
// stale Bahçeli-speech duplicates and a SEO listicle ("ENGELLİ ÖTV…"),
// while the day's actual top stories (139 İmamoğlu/İBB articles, 122
// Üsküdar, 98 YSK ara seçim) sat just below the cut.
const CANDIDATE_LIMIT = 200;
const DISPLAY_LIMIT = 30;
// h71-timebounds-1: the weekly digest keeps its top 5 (route.ts) out of the 40
// biggest clusters of the trailing week. The politics gate drops few of them
// (the week's biggest stories are political), so 40 leaves a wide margin over 5.
// The read has two steps, ids first and then the embed for those ids only,
// because one `order by article_count desc, id limit 40` over the embed made
// Postgres join and aggregate the members of EVERY window cluster before it
// could sort (EXPLAIN ANALYZE on prod, 2026-11-08: 1,700 clusters in the window,
// about 8,300 article rows touched, 4,319 ms partly cold and 335 ms warm,
// against the 8 s batch statement_timeout, and growing with the week's volume).
// The ids-only select with the same filters took about 13 ms, and the embed then
// reads only the 40 chosen clusters.
const DIGEST_CANDIDATE_LIMIT = 40;

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
// reach the fold. Drawn from the same 2+-article politics-majority
// candidate pool as `ranked`, and a candidate must also carry at least
// BREAKING_MIN_VOTING_SOURCES distinct voting outlets (h59-homefeed-3): the
// DB-level floor counts articles, so one outlet plus a Haberler.com echo, or
// a pair of niche and aggregator sources, passed it and took a breaking slot
// although the spectrum has nothing to show for it.
//
// Window: 2 hours. Cap: 6 slots so a major-event burst (e.g. earthquake
// night, election night) doesn't drown out the rest of the feed.
// Exported (h170-roadmap-2) for splitHomeFeed below, which the home page and
// /api/home/head share. The window is applied once, when the cached entry is filled:
// nothing downstream re-tests it against a later clock (knownBreakingIds does not).
export const BREAKING_WINDOW_MS = 2 * 60 * 60 * 1000;
export const BREAKING_LIMIT = 6;
// h59-homefeed-3: the Son Dakika strip needs two voting outlets (kind outlet or
// wire, isVotingKind), counted over distinct source ids.
const BREAKING_MIN_VOTING_SOURCES = 2;

/**
 * A card source plus its `kind`, so consumers outside the card (RSS and
 * social zone lines, via `votingZoneCounts` in feeds/zone-line.ts) can tally
 * on the voting basis. Optional/nullable so existing ClusterCardSource
 * fixtures keep compiling; a missing or null kind counts as voting
 * (`isVotingKind`'s default). ClusterCard itself ignores the extra field.
 */
export type BundleSource = ClusterCardSource & { kind?: SourceKind | null };

export interface ClusterBundle {
  cluster: ClusterCardCluster;
  articles: ClusterCardArticle[];
  sources: BundleSource[];
  /**
   * R2 wire-collapse: true when ≥50% of the cluster's deduped members
   * repeat another member's text (the same `content_hash`, or the same agency
   * lead under a reworded headline), meaning the cluster is one AA/DHA/IHA
   * wire copy amplified by N outlets rather than N independent reports.
   * Optional so the public type stays backward-compatible with consumers
   * that don't care about ranking. The /clusters page can use this to
   * render a small "wire" badge as a follow-up (UI agents own
   * cluster-card.tsx this wave so the badge is deferred — see report).
   */
  isWireRedistribution?: boolean;
  /**
   * h37-content-1: true when the cluster is flagged a blindspot and not
   * vetoed, but is still inside BLINDSPOT.feedDelayHours of its first
   * publication, so `cluster.is_blindspot` is false for this render and the
   * card shows no pill. Readers that gate on the raw claim rather than the
   * card (the social top-story pick) read this to keep treating it as one.
   */
  blindspotPending?: boolean;
  /**
   * R2 wire-collapse: the count to use for ranking. Equals
   * `cluster.article_count` for normal clusters; for wire redistributions
   * it's the number of DISTINCT texts (content_hash or shared agency lead
   * linked) — i.e. the wire copy counts as 1 source instead of 5. R1's scoreCluster reads this so a
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
//
// Exported (with the row/select/builder trio below) so search-query.ts
// can query the same embedded shape and reuse the identical row → bundle
// assembly — full-text search results render through the same ClusterCard
// shape as the politics feed.
export type EmbeddedSource = {
  id: string;
  name: string;
  bias: BiasCategory;
  logo_url: string | null;
  kind: SourceKind | null;
  /**
   * BL-13 per-source rights flags (migration 047). `undefined` (legacy
   * fixtures/rows predating the column) is treated as `true` (allowed)
   * by every gate below — see the `articles` mapping in
   * `buildClusterBundle`.
   */
  image_allowed?: boolean;
  excerpt_allowed?: boolean;
};

export type EmbeddedArticle = {
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
  /**
   * The raw RSS description (the agency lead). A SERVER-SIDE input of the wire
   * signal only (h138-roadmap2-1): outlets that reword the headline over the
   * same AA lead get distinct content_hash values but the same description,
   * and `detectWireRedistribution` links members that share one. It is never
   * copied into `ClusterBundle` (`articles` below is an explicit field-by-field
   * map), so it cannot reach a client component or an RSC prop. Optional so
   * fixtures and rows fetched without the column pass through unchanged.
   */
  description?: string | null;
  /** Migration 089 ("ADMIT"): non-null once Jev has admitted this article
   * into political clustering under a live claim. NULL on every row until
   * a later promotion PR; see isPoliticsMember in src/lib/bias/config.ts. */
  politics_admitted_at?: string | null;
  sources: EmbeddedSource | null;
};

export type EmbeddedClusterArticle = {
  articles: EmbeddedArticle | null;
};

export type EmbeddedClusterRow = {
  id: string;
  title_tr: string;
  /**
   * H2-WORKER neutral-headline pipeline (migration 019 + headline-worker.mjs):
   * the LLM-rewritten neutral version of `title_tr`. NULL until the rewrite
   * worker has processed the cluster. buildClusterBundle shows it as soon as
   * it exists (no destructive overwrite of the original) and, while it is
   * still NULL, the cron's own first pick over the member titles
   * (display-headline.ts), not the raw `title_tr`.
   */
  title_tr_neutral: string | null;
  summary_tr: string;
  bias_distribution: unknown;
  is_blindspot: boolean;
  blindspot_side: BiasCategory | null;
  /**
   * Migration 071 blindspot recall veto. `true` withdraws the blindspot
   * claim for every reader (see recall-veto.ts). Optional so fixtures and
   * rows fetched before 071 pass through unchanged.
   */
  blindspot_recall_veto?: boolean | null;
  article_count: number;
  first_published: string;
  updated_at: string;
  cluster_articles: EmbeddedClusterArticle[] | null;
};

// Embedded PostgREST select string: cluster → cluster_articles → articles
// → sources. Exported so search-query.ts's full-text query walks the exact
// same join shape (and therefore can feed its rows through
// `buildClusterBundle` below unchanged).
export const CLUSTER_EMBED_SELECT = `id, title_tr, title_tr_neutral, summary_tr, bias_distribution, is_blindspot, blindspot_side, blindspot_recall_veto, article_count, first_published, updated_at,
         cluster_articles (
           articles (
             id, title, url, image_url, published_at, source_id, category, content_hash, description, politics_admitted_at,
             sources ( id, name, bias, logo_url, kind, image_allowed, excerpt_allowed )
           )
         )`;

// Internal (uncached) implementation. The exported `getPoliticsClusters`
// reads it through the `"use cache: remote"` wrapper below and runs it live
// (uncached) when that attempt failed.
async function fetchPoliticsClusters(
  profile: ReadProfile,
): Promise<PoliticsClustersResult> {
  try {
    // "reader" (pages, RSS) fails fast at 4 s; "batch" (digest + social
    // crons) keeps the plain client so a cold read can use the 8 s
    // statement_timeout instead of skipping the run.
    const supabase =
      profile === "batch" ? createServerClient() : createReaderClient();

    // Feed-health gate (Pack C) + the main select run IN PARALLEL — neither
    // depends on the other, and the audit found this serial await added a
    // full extra round-trip of latency to every fetchPoliticsClusters call
    // (blindspots-query.ts had the identical bug at cluster-detail-query.ts
    // and blindspots-query.ts's own equivalent points; this is the E2 fix).
    // `null` means "health unknown" — buildClusterBundle below treats that
    // identically to "no health data at all" (fail open, no suppression).
    // getZoneFeedHealth never throws (see feed-health.ts's file header). It
    // takes the caller's profile so the cron's health read is uncapped too.
    const [health, { data, error }] = await Promise.all([
      getZoneFeedHealth({ profile }),
      // Single round-trip: cluster → cluster_articles → articles → sources.
      // The nested shape is produced by PostgREST following the foreign
      // keys declared in migrations 001-003. This replaces the previous
      // four sequential queries.
      supabase
        .from("clusters")
        .select(CLUSTER_EMBED_SELECT)
        // Archived (migration 037) clusters are excluded from every reader-facing
        // surface; the detail page still resolves them so shared links never 404.
        .eq("is_archived", false)
        .gte("article_count", 2)
        .order("updated_at", { ascending: false })
        .limit(CANDIDATE_LIMIT)
        .returns<EmbeddedClusterRow[]>(),
    ]);

    if (error) {
      // Throw — never return an empty result for a failed query. The
      // caller is wrapped in `"use cache"`, and a returned empty would be
      // cached as truth for the full cluster-feed window (empty homepage
      // for minutes after one Supabase blip). `attemptCached` turns this
      // throw into a `{ ok: false }` result that the cache body returns and
      // caches for `minutes`, so Next does NOT serve the previous (good)
      // entry past it. The recovery is in `getPoliticsClusters`: one live
      // retry, then the per-instance last-good feed (stale-if-error, at most
      // 60 min old) for reader calls.
      throw new Error(`[clusters] embedded select error: ${error.message}`);
    }
    const clusterRows = data ?? [];
    if (clusterRows.length === 0)
      return { bundles: [], breakingBundles: [], prefilterCount: 0 };

    // ONE clock read for the whole scope (this body only runs inside the
    // "use cache" attempt or after the request scope on the live retry): it
    // ages the blindspot claim of every row below AND cuts the Son Dakika
    // window, so the two can never disagree about "now".
    const nowMs = Date.now();

    const bundles: ClusterBundle[] = [];
    // Side-table: bundle → its post-dedupe member list. Used by
    // scoreCluster() below for velocity, zone-diversity, and dominance
    // signals without leaking the embedded shape into ClusterBundle.
    const scoringMembers = new WeakMap<ClusterBundle, EmbeddedArticle[]>();

    for (const c of clusterRows) {
      // Per-row admission (politics majority, English isolation) and bundle
      // assembly live in admitPoliticsRow, shared with the weekly digest read.
      const admitted = admitPoliticsRow(c, health, nowMs);
      if (!admitted) continue;
      const { bundle, dedupedMembers } = admitted;

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
    // the fold. h59-homefeed-3: a candidate needs BREAKING_MIN_VOTING_SOURCES
    // distinct voting sources; one left out can still rank in `bundles`, and
    // then the page's breakingIds dedupe no longer removes it from the list.
    const breakingBundles = bundles
      .filter(
        (b) =>
          nowMs - new Date(b.cluster.first_published).getTime() <
            BREAKING_WINDOW_MS &&
          countVotingSources(b.sources) >= BREAKING_MIN_VOTING_SOURCES
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

// Flattens one embedded cluster row's nested cluster_articles → articles
// into a plain member list, dropping any null joins (should not happen
// but defensive). Exported so search-query.ts's rows can feed the same
// path into buildClusterBundle below.
export function flattenClusterMembers(
  c: EmbeddedClusterRow
): EmbeddedArticle[] {
  const members: EmbeddedArticle[] = [];
  for (const ca of c.cluster_articles ?? []) {
    if (ca.articles) members.push(ca.articles);
  }
  return members;
}

export interface ClusterBundleBuildResult {
  bundle: ClusterBundle;
  /** Post-dedupe, newest-first member list (used for R1/R4 scoring here). */
  dedupedMembers: EmbeddedArticle[];
}

/**
 * Turns one embedded cluster row + its (already flattened) member list
 * into a ClusterBundle: same-source dedupe (earliest article per source
 * wins), R2 wire-redistribution detection, R3 source-fairness cap, and
 * the ClusterCard-shaped cluster/articles/sources fields.
 *
 * Extracted verbatim from fetchPoliticsClusters's per-row loop (no
 * behaviour change) so search-query.ts can reuse it — full-text search
 * results render through the identical ClusterCard shape. Callers own any
 * pre-filtering (e.g. this file's politics-majority gate below); this
 * function assumes `members` is already the candidate set for the row.
 *
 * `health` (Pack C, feed-health-gated blindspots) may be `null` or
 * `undefined`; both mean "no suppression". When provided, an `is_blindspot`
 * cluster whose silent pole zone is degraded has its blindspot claim
 * withdrawn for this read: the
 * returned bundle's `is_blindspot` is forced `false` and `blindspot_side`
 * `null`. This is READ-PATH ONLY — the underlying `clusters.is_blindspot`
 * / `blindspot_side` columns are never written here or anywhere in this
 * pack.
 *
 * `nowMs` (h37-content-1) is the caller's ONE clock read for its cache
 * scope, required so no caller can forget it: a flagged, unvetoed cluster
 * younger than BLINDSPOT.feedDelayHours has its claim held back exactly like
 * /blindspots holds it back (`publicBlindspotClaim`), and the bundle says so
 * through `blindspotPending`. Never call Date.now() in an uncached render to
 * produce it.
 */
export function buildClusterBundle(
  c: EmbeddedClusterRow,
  members: EmbeddedArticle[],
  health: ZoneFeedHealth | null | undefined,
  nowMs: number,
): ClusterBundleBuildResult {
  // Sort by published_at ASC FIRST so the dedupe pass below
  // deterministically keeps the EARLIEST article per source.
  const sortedMembers = [...members].sort(
    (a, b) =>
      new Date(a.published_at).getTime() - new Date(b.published_at).getTime()
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
      new Date(b.published_at).getTime() - new Date(a.published_at).getTime()
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
        `(${dedupedMembers.length} members → ${wire.uniqueHashes} distinct texts)`
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
  const sourceMap = new Map<string, BundleSource>();
  for (const m of dedupedMembers) {
    if (m.sources && !sourceMap.has(m.sources.id)) {
      sourceMap.set(m.sources.id, {
        id: m.sources.id,
        name: m.sources.name,
        bias: m.sources.bias,
        logo_url: m.sources.logo_url,
        kind: m.sources.kind ?? null,
      });
    }
  }

  const biasDistribution = normalizeDistribution(c.bias_distribution);

  // Pack C feed-health gate — READ PATH ONLY, never writes
  // clusters.is_blindspot / blindspot_side (those columns stay exactly as
  // migrations 023/031/032 computed them). When the cluster is currently
  // flagged a blindspot AND we have live feed health, withdraw the claim
  // for THIS render if the silent pole zone's feeds are too broken for its
  // silence to mean anything. `health` undefined/null (no caller passed
  // it, or getZoneFeedHealth() itself failed open) => never suppress.
  //
  // Migration 071 recall veto runs FIRST: Jev found same-event coverage from
  // the silent side, so the claim is withdrawn as a matching fact, not a
  // feed outage — a vetoed cluster never reaches the feed-health check.
  //
  // h37-content-1: the same claim also waits BLINDSPOT.feedDelayHours after
  // first_published, like /blindspots. A held-back claim is `pending`, not
  // withdrawn: no log line, no feed-health check (nothing left to suppress).
  const veto = publicBlindspotClaim(c, nowMs);
  if (veto.vetoed) logRecallVeto(c.id);
  let isBlindspot = veto.isBlindspot;
  let blindspotSide = veto.blindspotSide;
  if (isBlindspot && health) {
    // Dominant zone derived from the already-normalized bias_distribution
    // via the existing zone-summary helper (tallyZones, re-exported from
    // @/lib/bias/config) — no second tally implementation.
    const dominantZone = tallyZones(biasDistribution).dominantZone;
    if (dominantZone && shouldSuppressBlindspot(dominantZone, health)) {
      const silentZone = degradedSilentZone(dominantZone, health);
      if (silentZone) {
        const { healthy, total } = health[silentZone];
        console.info(
          `[feed-health] suppressed blindspot for cluster ${c.id} (silent zone ${silentZone}: ${healthy}/${total} feeds healthy)`,
        );
      }
      isBlindspot = false;
      blindspotSide = null;
    }
  }

  // H2 neutral-headline coalesce: prefer the stored neutral title once the
  // headline cron has written it (an empty one is junk and counts as missing).
  // h42-latency-1: until that first write (the cron runs every 5 minutes) a
  // cluster of 2+ members used to show the seed article's raw outlet headline,
  // clickbait and all, in the top slots. It now shows the cron's own first pick
  // (`pickNeutralTitle(members, { floor: true })`), computed here from the raw
  // member list the cron also reads (pre-dedupe: a second article of a source
  // still counts), so the heading does not change when the cron writes. Pure,
  // runs inside the caller's `use cache` body, writes nothing. A cluster with
  // fewer than 2 members keeps `title_tr`: the cron never titles it.
  const { title: headline } = clusterDisplayTitle(c, members);

  const bundle: ClusterBundle = {
    cluster: {
      id: c.id,
      title_tr: headline,
      summary_tr: c.summary_tr,
      bias_distribution: biasDistribution,
      is_blindspot: isBlindspot,
      blindspot_side: blindspotSide,
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
      // BL-13 rights gate: a source that has asked Tayf not to reuse its
      // photos gets image_allowed = false — null the URL here so it can
      // never surface as a hero/card image candidate for ANY downstream
      // consumer of this bundle (cluster-card.tsx picks its hero from
      // this exact field). `undefined` (legacy rows/fixtures predating
      // migration 047) is treated as allowed so nothing regresses.
      //
      // gif-filter (http-1): an animated GIF is nulled here too. haber7 /
      // elips-haber ship a 22 MB placeholder GIF that /_next/image passes
      // through unmodified; nulling at the bundle boundary keeps the URL out
      // of the RSC/HTML payload, not just out of the <Image>. Existing rows
      // heal at render time (no backfill).
      // db-4: a publisher logo card / 'son dakika' stand-in is nulled here
      // too, so the hero falls through to the next member's photo or the
      // logo tier.
      image_url:
        m.sources?.image_allowed === false ||
        !isOptimizableImageUrl(m.image_url) ||
        isPlaceholderImageUrl(m.image_url)
          ? null
          : m.image_url,
      published_at: m.published_at,
      source_id: m.source_id,
    })),
    sources: Array.from(sourceMap.values()),
    // R2 wire-collapse fields. effectiveArticleCount is the count
    // R1's scoreCluster reads — equal to the deduped member count
    // for normal clusters, dropped to the unique-hash count for
    // wire redistributions.
    isWireRedistribution: wire.isWire,
    blindspotPending: veto.pending,
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

  return { bundle, dedupedMembers };
}

/**
 * The per-row admission every politics reader of the `clusters` embed applies
 * (h71-timebounds-1: extracted verbatim from fetchPoliticsClusters's loop, so
 * the home feed and the weekly digest cannot drift apart): flatten the nested
 * join, drop an empty cluster, drop a cluster below the politics majority,
 * drop an English-only cluster, then assemble the ClusterBundle. `null` means
 * "not admitted"; callers own which rows they fetch and how they rank them.
 *
 * `health` and `nowMs` are passed straight to buildClusterBundle (see there).
 */
function admitPoliticsRow(
  c: EmbeddedClusterRow,
  health: ZoneFeedHealth | null | undefined,
  nowMs: number,
): ClusterBundleBuildResult | null {
  // Flatten nested cluster_articles → articles into a plain member
  // list, dropping any null joins (should not happen but defensive).
  const members = flattenClusterMembers(c);
  if (members.length === 0) return null;

  // Politics majority filter — must match the old behaviour exactly
  // (≥60% politika/son_dakika members). Runs on the RAW (pre-dedupe)
  // member list, same as before extracting buildClusterBundle above —
  // search-query.ts has no equivalent gate, it searches all clusters.
  const hits = members.filter((m) => isPoliticsMember(m)).length;
  if (hits / members.length < POLITICS_THRESHOLD) return null;

  // h59-english-1: a cluster whose every member (voting or not) is an
  // English-language outlet formed among English articles only, so it
  // carries no Bağımsız or Muhalefet outlet because none could have matched
  // it, not because none covered the event. It leaves the ranked list, the
  // Son Dakika strip and every reader of this fetcher (feeds, digests,
  // social). Search, source pages, cluster pages and sitemaps still list it.
  // The embed has no slug, so the display name decides (sourceLang's
  // name fallback). A member with no source row is unknown, not English.
  if (isLanguageIsolatedCluster(members.map((m) => m.sources))) return null;

  return buildClusterBundle(c, members, health, nowMs);
}

// Distinct voting sources of a bundle (h59-homefeed-3). `bundle.sources` is
// already deduped by source id; the Set keeps that true for any caller. A
// missing kind counts as voting, exactly as isVotingKind decides it.
function countVotingSources(sources: readonly BundleSource[]): number {
  const voting = new Set<string>();
  for (const s of sources) {
    if (isVotingKind(s.kind)) voting.add(s.id);
  }
  return voting.size;
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
    // An aggregator or niche source labelled e.g. "center" must not
    // fabricate a bagimsiz zone for the R1 diversity bonus — it never
    // votes, so it must never widen the diversity count either.
    if (!m.sources || !isVotingKind(m.sources.kind)) continue;
    zones.add(zoneOf(m.sources.bias));
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

// Cached entry point. Cache Components migration (Next.js 16): replaces
// the previous `unstable_cache` wrapper with the `use cache` directive.
// The function's arguments (none here) automatically become part of the
// cache key, and `cacheLife` / `cacheTag` control TTL and on-demand
// invalidation.
//
// Tag: `clusters-politics` — cluster-worker can call
// `revalidateTag("clusters-politics")` after a write cycle to push fresh
// data immediately without waiting for the 30s TTL.
//
// Build-safety: this never throws — `attemptCached` swallows whatever
// `fetchPoliticsClusters` throws and reports `{ ok: false }` instead
// (that sentinel IS cached for the cacheLife window, and it replaces the
// previous good entry under the same key; the public entry's live retry and
// its per-instance last-good feed cover the gap). A
// throw that crosses this `"use cache: remote"` boundary fails `next
// build`'s prerender even though `getPoliticsClusters` below wraps every
// call (see src/lib/cache-resilience.ts's file header for the incident
// this fixes: /trends and /rss.xml, 2026-09-28).
//
// `profile` is an argument on purpose: it becomes part of the cache key, so a
// capped "reader" entry (and its cached `{ ok: false }` sentinel) is never
// served to a "batch" cron, and the cron's own miss runs uncapped.
//
// Exactly ONE `cacheLife` per invocation, chosen after the attempt: a failed
// attempt (typically the 4 s reader abort on a cold database) is memoised for
// `minutes` only, so a blip cannot park the `{ ok: false }` sentinel for a
// whole `cluster-feed` window; a success keeps the normal lifetime.
//
// The one piece of new logic in this body is the `at` stamp: the epoch ms of
// the database read, so a cache hit can be remembered as a last-good value
// without reading the clock on the hit path (cache-resilience.ts, section 4).
async function getPoliticsClustersCached(profile: ReadProfile) {
  "use cache: remote";
  cacheTag("clusters-politics");
  const r = await attemptCached("politics-query", () =>
    fetchPoliticsClusters(profile),
  );
  // One literal per call: Next 16.4 types cacheLife as single-literal overloads.
  if (r.ok) cacheLife("cluster-feed");
  else cacheLife("minutes");
  return r.ok ? { ...r, at: Date.now() } : r;
}

// Public entry point. The page component (and the RSS/cron consumers)
// call this identical signature — the cache layer is invisible from the
// call site. Still THROWS on a sustained failure (same contract as
// getBlindspots): the digest and social crons must not send from empty
// data, rss.xml must not publish an empty 200 feed, and the home page's
// loadFeed catch renders <FeedUnavailable/>. On a cache-attempt failure
// this retries the query live once (the cached `{ ok: false }` sentinel
// is memoised for the cacheLife window, and this retry is what heals it)
// before letting a genuine, still-failing outage propagate.
//
// Reader calls (pages, RSS) are additionally stale-if-error and
// single-flight, keyed "politics:reader": when the attempt AND the live
// retry both fail, the last good feed this instance saw (under 60 min old)
// is served instead of the throw, concurrent live retries share one
// 200-row read, and a failed read cools down for 5 s. Batch calls (the
// crons) pass no key: they never get stale data and never coalesce.
//
// The live retry waits for a request scope first (resolveCachedOrThrow ->
// awaitRequestScope): during a prerender it postpones instead of fetching
// live, which is safe because crons and route handlers already have one.
export async function getPoliticsClusters(
  opts?: { profile?: ReadProfile },
): Promise<PoliticsClustersResult> {
  const profile = opts?.profile ?? "reader";
  return resolveCachedOrThrow(
    {
      label: "politics-query",
      key: profile === "reader" ? "politics:reader" : undefined,
    },
    () => getPoliticsClustersCached(profile),
    () => fetchPoliticsClusters(profile),
  );
}

/**
 * The plain home feed's Son Dakika derivation, written once (h170-roadmap-2).
 * HomeFeed calls it for the strip and the ranked list, and /api/home/head calls it
 * for the strip alone (the probe behind the "yeni son dakika haberi" pill), so the
 * head and the strip can never drift: both are `filteredBreaking`.
 *
 * - `filteredBreaking`: the feed's breakingBundles that pass `keep`, at most
 *   BREAKING_LIMIT of them, in the order the cache fill gave them (newest first).
 *   The window (BREAKING_WINDOW_MS) and the voting-source floor are applied when the
 *   cached entry is filled, not here: both callers read that entry.
 * - `filtered`: the ranked bundles that pass `keep` (the whole matching set, not a
 *   page of it), which the search view reads to avoid listing a story twice.
 * - `ranked`: `filtered` without the stories already in the strip. A cluster that
 *   is both breaking (< 2 h) and in the top-30 ranked set would otherwise render
 *   twice; the strip wins, so each story appears in exactly one place.
 *
 * `keep` narrows the strip and the list alike (an in-feed search on the home page);
 * omitted, it is the plain feed that /api/home/head describes. Pure: the bundles
 * are returned as they are (same objects), the lists are new arrays, and the feed
 * is not mutated.
 */
export function splitHomeFeed(
  feed: Pick<PoliticsClustersResult, "bundles" | "breakingBundles">,
  keep: (b: ClusterBundle) => boolean = () => true,
): { filteredBreaking: ClusterBundle[]; filtered: ClusterBundle[]; ranked: ClusterBundle[] } {
  const filteredBreaking = feed.breakingBundles.filter(keep).slice(0, BREAKING_LIMIT);
  const filtered = feed.bundles.filter(keep);
  const breakingIds = new Set(filteredBreaking.map((b) => b.cluster.id));
  const ranked = filtered.filter((b) => !breakingIds.has(b.cluster.id));
  return { filteredBreaking, filtered, ranked };
}

/**
 * The ids of every story the page lists, in listed order, each once. No clock and no
 * window: the Son Dakika window (BREAKING_WINDOW_MS) is applied ONCE, when the cached
 * entry is filled (the entry is revalidated every 300 s), so the strip can still hold
 * a story that is over 2 h old by the render clock, and a head read from that same
 * entry lists it too. Filtering by the render's clock here made such a story
 * "unknown" to the pill (a false "1 yeni son dakika haberi") and made the page
 * fingerprint change with the clock rather than with the entry. The home page hands
 * this to the pill, which treats a head id outside it as a story that entered the
 * strip after the render. It is at most the 6 strip slots plus the ranked set, 36 ids
 * or about 1.4 KB, so nothing needs trimming.
 */
export function knownBreakingIds(listed: ReadonlyArray<{ id: string }>): string[] {
  const out = new Set<string>();
  for (const item of listed) out.add(item.id);
  return [...out];
}

/**
 * The weekly digest's content read (h71-timebounds-1). The digest used to take
 * its top 5 from getPoliticsClusters, the home-feed pool of the 200 most
 * recently UPDATED clusters (about the last 25 hours), so on a Saturday none of
 * Monday to Thursday's biggest stories could be in a mail titled "Tayf
 * Haftalık Bülteni". This reads the week itself, the same window /hafta uses:
 * unarchived clusters with 2+ articles whose first_published is inside
 * [nowMs - 7 days, nowMs], the DIGEST_CANDIDATE_LIMIT biggest by article_count
 * (ties by id, so the order is deterministic).
 *
 * Two steps (see DIGEST_CANDIDATE_LIMIT for the measurement): step 1 selects
 * only the ids with every filter, both orders and the limit; step 2 embeds
 * exactly those ids. `.in()` returns rows in no order, so the JS sort below is
 * load-bearing: article_count desc, then id asc.
 *
 * Every row goes through the same admission as the home feed
 * (admitPoliticsRow: 60% politics majority, English isolation, bundle
 * assembly), and the result is ordered by the row's article_count, then id, with
 * no home score, velocity or decay: a week's biggest story must not lose to a
 * fresher, smaller one. The callers slice what they render.
 *
 * Not cached (a weekly cron has no use for a cache entry) and "batch" only: the
 * plain client keeps the 8 s statement_timeout instead of the 4 s reader cap.
 * Feed health is not read (health `null` means no blindspot suppression): the
 * digest renders title, summary, article count and spectrum of these bundles,
 * never their blindspot flag. `nowMs` is the caller's one clock read; it bounds
 * the window and ages the blindspot claim like fetchPoliticsClusters does.
 *
 * Each step is run at most twice. The home readers get a live retry from
 * resolveCachedOrThrow when their cached attempt fails; this read has no cache,
 * so it carries its own: a first error logs one warning and the identical query
 * runs once more, live (no `use cache`, no last-good value). A weekly cron has
 * no second chance for seven days.
 *
 * THROWS when a step errors twice, like fetchPoliticsClusters: the cron must
 * not send a digest built from an empty read.
 */
export async function getWeeklyDigestClusters(opts: {
  nowMs: number;
  profile: "batch";
}): Promise<ClusterBundle[]> {
  const { nowMs } = opts;
  const supabase = createServerClient();

  // Step 1: ids only. The same filters the embedded read used to carry.
  const idRows = await selectWithLiveRetry(() =>
    supabase
      .from("clusters")
      .select("id")
      .eq("is_archived", false)
      .gte("article_count", 2)
      .gte("first_published", new Date(nowMs - WEEK_MS).toISOString())
      // Upper bound: a source-controlled future first_published must not pin a
      // cluster into the digest (same guard as /hafta's window).
      .lte("first_published", new Date(nowMs).toISOString())
      // Unique per row: equal article_count tiers are broken by id.
      .order("article_count", { ascending: false })
      .order("id", { ascending: true })
      .limit(DIGEST_CANDIDATE_LIMIT)
      .returns<Array<{ id: string }>>(),
  );
  const candidateIds = (idRows ?? []).map((r) => r.id);
  // Nothing in the window: no second chain, and never an empty `.in()`.
  if (candidateIds.length === 0) return [];

  // Step 2: the embed for exactly those clusters, in step 1's order.
  const data = await selectWithLiveRetry(() =>
    supabase
      .from("clusters")
      .select(CLUSTER_EMBED_SELECT)
      .in("id", candidateIds)
      .returns<EmbeddedClusterRow[]>(),
  );

  const admitted: Array<{ bundle: ClusterBundle; articleCount: number; id: string }> = [];
  for (const c of data ?? []) {
    const row = admitPoliticsRow(c, null, nowMs);
    if (!row) continue;
    admitted.push({ bundle: row.bundle, articleCount: c.article_count, id: c.id });
  }

  // `.in()` gives no order, so this sort IS the contract: article_count desc,
  // then id asc, for any reader of the result.
  return admitted
    .sort((a, b) => b.articleCount - a.articleCount || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((entry) => entry.bundle);
}

/**
 * Runs one Supabase select, and once more when the first attempt returns an
 * error (ts-2): one `console.warn` line, then the identical query again, live.
 * `build` is called per attempt so each attempt gets a fresh query builder.
 * Throws only when the second attempt also errors, with that second error.
 */
async function selectWithLiveRetry<T>(
  build: () => PromiseLike<{ data: T | null; error: { message: string } | null }>,
): Promise<T | null> {
  const first = await build();
  if (!first.error) return first.data;
  console.warn(`[clusters] weekly digest select failed, retrying live: ${first.error.message}`);
  const second = await build();
  if (second.error) {
    throw new Error(`[clusters] weekly digest select error: ${second.error.message}`);
  }
  return second.data;
}
