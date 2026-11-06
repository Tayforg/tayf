import { cacheLife, cacheTag } from "next/cache";

import { balanceFromZoneCounts, type BalanceScore } from "@/lib/bias/balance";
import { BLINDSPOT } from "@/lib/bias/config";
import { attemptCached, resolveCachedOrRetry } from "@/lib/cache-resilience";
import {
  dedupeBySource,
  passesFeedFilters,
  zoneTallyOf,
  type EmbeddedArticle,
} from "@/lib/clusters/blindspot-feed";
import {
  EMBED_BATCH_SIZE,
  fetchEmbedBatch,
  type EmbeddedClusterRow,
} from "@/lib/clusters/blindspots-query";
import {
  getZoneFeedHealth,
  shouldSuppressBlindspot,
  type ZoneFeedHealth,
} from "@/lib/clusters/feed-health";
import {
  NEAR_BLINDSPOT_CANDIDATE_SAFETY_CAP,
  NEAR_BLINDSPOT_DISPLAY_LIMIT,
  NEAR_BLINDSPOT_LOOKBACK_DAYS,
  NEAR_BLINDSPOT_SURVIVOR_CAP,
  isNearBlindspotTally,
  storedDistributionMayBeNear,
} from "@/lib/clusters/near-blindspot-rule";
import { createReaderClient } from "@/lib/supabase/server";
import type { MediaDnaZone } from "@/types";

// Fetcher for the "Kör noktaya yakın" section of /blindspots: stories where one
// zone owns [NEAR_BLINDSPOT_MIN_SHARE, BLINDSPOT.dominantShare) of the voting
// sources. Display-only: nothing is written, no flag is read, and the
// BLINDSPOT contract / its Deno mirror / the parity tests are not touched.
//
// Same two-step shape as blindspots-query.ts (see its header for why): a lean
// Step A, then the embed fetched in EMBED_BATCH_SIZE batches through
// blindspots-query's own `fetchEmbedBatch`, so the embed select, the rights
// columns and the error prefix stay in one place. Every live check mirrors
// /blindspots (same-source dedupe, the feed quality filter, voting kinds only,
// the 24 h feed delay, the feed-health suppression gate), only with the
// share band swapped.
//
// h50-biasmath-1: the share band is tested BEFORE any cap. Step A used to take
// the 100 most recently updated of ~377 candidates and only then re-tally, so
// 26 of the 34 stories that qualified on 2026-11-06 (ranks 111-376 by
// updated_at) were never embedded, and the section covered ~1.3 days of the 7
// that /metodoloji promises. Step A now also selects the stored
// `bias_distribution` (voting kinds only, written by cluster-consumer), the
// band is tested on it in code (+-NEAR_BLINDSPOT_PREFILTER_TOLERANCE for
// stored-vs-live drift), and only the survivors are embedded and re-tallied
// live. Step A is bounded by NEAR_BLINDSPOT_CANDIDATE_SAFETY_CAP, a safety
// bound rather than a sample.
//
// Step A plan -- `EXPLAIN` (no ANALYZE) against production, 2026-10-22:
//
//   Limit (cost=194.47..194.48 rows=3)
//     -> Sort (Sort Key: updated_at DESC)
//        -> Bitmap Heap Scan on clusters
//           Recheck Cond: updated_at >= now() - 7 days AND article_count >= 2/3
//           Filter: NOT is_blindspot AND NOT is_archived AND article_count >= 5
//                   AND first_published < now() - 24 h
//                   AND first_published >= now() - 7 days
//           -> BitmapAnd
//              -> Bitmap Index Scan on idx_clusters_active_updated_at
//                 (updated_at >= now() - 7 days, ~1.2k rows)
//              -> Bitmap Index Scan on clusters_neutral_eligible_idx
//
// i.e. it is driven by the updated_at range, served by the partial
// updated_at DESC index idx_clusters_active_updated_at (the planner prefers it
// to the unfiltered idx_clusters_updated_at), at about the cost of the
// /blindspots Step A (cost ~172). The `first_published >= lookback` bound is
// a plain heap Filter: the plan with and without it is identical, so it adds
// no index risk and is kept for its meaning (a story first published within
// the lookback AND still updated within it).
//
// h50-biasmath-1 widened that select from `id` / limit 100 to
// `id, bias_distribution` / limit NEAR_BLINDSPOT_CANDIDATE_SAFETY_CAP (the
// filters and order are unchanged). EXPLAIN (ANALYZE, BUFFERS) against
// production, 2026-11-06, read-only:
//
//   Limit (actual time=7.358..7.429 rows=376)
//     -> Bitmap Heap Scan on clusters (rows=376, Rows Removed by Filter: 1226)
//        Filter: NOT is_blindspot AND NOT is_archived AND article_count >= 5
//        -> BitmapAnd
//           -> Bitmap Index Scan on idx_clusters_active_updated_at (rows=1848)
//           -> Bitmap Index Scan on idx_clusters_first_published (rows=6251)
//   Execution Time: 7.6 ms warm (37 ms on the cold first run)
//
// The plan is the same bitmap plan the old `select id ... limit 100` gets
// (identical cost, identical scan), so widening the select adds no index risk:
// 376 rows of id + a small jsonb instead of 100 ids. The planner now ANDs
// idx_clusters_first_published where October's plan above used
// clusters_neutral_eligible_idx; the driving index is unchanged.

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export type NearBlindspotItem = {
  id: string;
  /** title_tr_neutral ?? title_tr, the same coalesce every list surface uses. */
  title: string;
  dominantZone: MediaDnaZone;
  /** Dominant zone's share of the VOTING sources, in [0.70, 0.80). */
  dominantShare: number;
  /** Members after same-source dedupe, every kind (the cluster page's "N kaynak"). */
  memberCount: number;
  /** Voting sources (outlet, wire) after same-source dedupe. */
  votingTotal: number;
  balance: BalanceScore | null;
  updatedAt: string;
};

type Candidate = { id: string; bias_distribution: unknown };

/**
 * Step A: the lean candidate select, newest activity first, with the stored
 * distribution so the share band can be tested before anything is capped.
 */
async function fetchCandidates(): Promise<Candidate[]> {
  const supabase = createReaderClient();
  const now = Date.now();
  const delayCutoffIso = new Date(
    now - BLINDSPOT.feedDelayHours * HOUR_MS,
  ).toISOString();
  const lookbackIso = new Date(
    now - NEAR_BLINDSPOT_LOOKBACK_DAYS * DAY_MS,
  ).toISOString();

  const { data, error } = await supabase
    .from("clusters")
    .select("id, bias_distribution")
    .eq("is_blindspot", false)
    .eq("is_archived", false)
    .gte("article_count", BLINDSPOT.minSources)
    .lt("first_published", delayCutoffIso)
    .gte("first_published", lookbackIso)
    .gte("updated_at", lookbackIso)
    .order("updated_at", { ascending: false })
    .limit(NEAR_BLINDSPOT_CANDIDATE_SAFETY_CAP)
    .returns<Candidate[]>();

  if (error) {
    throw new Error(`[near-blindspots] candidate select error: ${error.message}`);
  }
  return data ?? [];
}

/**
 * The ids worth embedding, still in updated_at order: candidates whose stored
 * distribution can sit in the band (tolerance included) or is unusable. Capped
 * at NEAR_BLINDSPOT_SURVIVOR_CAP, newest first -- survivors are a few dozen,
 * so the cap is only a bound on embed cost against a bad distribution write.
 */
function survivorIds(candidates: Candidate[]): string[] {
  const ids: string[] = [];
  for (const c of candidates) {
    if (ids.length >= NEAR_BLINDSPOT_SURVIVOR_CAP) break;
    if (storedDistributionMayBeNear(c.bias_distribution)) ids.push(c.id);
  }
  return ids;
}

/**
 * Per-row live re-tally against the near-blindspot band. Returns `null` when
 * the cluster does not qualify (or its dominant zone's silent side is a
 * degraded feed, in which case "the other side did not cover it" is not a
 * claim we can stand behind).
 */
function toNearItem(
  c: EmbeddedClusterRow,
  health: ZoneFeedHealth | null,
): NearBlindspotItem | null {
  const members: EmbeddedArticle[] = [];
  for (const ca of c.cluster_articles ?? []) {
    if (ca.articles) members.push(ca.articles);
  }
  if (members.length === 0) return null;

  const deduped = dedupeBySource(members);
  // Filter on the served headline: the list shows title_tr_neutral ?? title_tr
  // (the item's `title`), so the SEO-explainer gate must judge that, not the
  // stored seed.
  const servedTitle = c.title_tr_neutral ?? c.title_tr;
  if (!passesFeedFilters({ title_tr: servedTitle }, deduped).ok) return null;

  // zoneTallyOf counts voting kinds only (outlet, wire): aggregators and
  // niche sources neither raise nor lower the share.
  const tally = zoneTallyOf(deduped);
  if (!isNearBlindspotTally(tally) || tally.dominantZone === null) return null;
  const dominantZone: MediaDnaZone = tally.dominantZone;

  if (shouldSuppressBlindspot(dominantZone, health)) return null;

  return {
    id: c.id,
    title: servedTitle,
    dominantZone,
    dominantShare: tally.dominantShare,
    memberCount: deduped.length,
    votingTotal: tally.total,
    balance: balanceFromZoneCounts(tally.counts),
    updatedAt: c.updated_at,
  };
}

// Internal (uncached) implementation; throws on any Supabase error.
async function fetchNearBlindspots(): Promise<NearBlindspotItem[]> {
  const ids = survivorIds(await fetchCandidates());
  if (ids.length === 0) return [];

  const order = new Map(ids.map((id, i) => [id, i]));
  const items: NearBlindspotItem[] = [];
  let health: ZoneFeedHealth | null = null;

  // Every survivor is embedded: the display slice below takes the top
  // NEAR_BLINDSPOT_DISPLAY_LIMIT by share across ALL of them, so an early stop
  // at 10 collected items would drop a stronger story from a later batch.
  for (let i = 0; i < ids.length; i += EMBED_BATCH_SIZE) {
    const batchIds = ids.slice(i, i + EMBED_BATCH_SIZE);
    let rows: EmbeddedClusterRow[];
    if (i === 0) {
      // Feed health once, alongside the FIRST batch only (as fetchBlindspots).
      const [fetchedHealth, batchRows] = await Promise.all([
        getZoneFeedHealth({ profile: "reader" }),
        fetchEmbedBatch(batchIds, "reader"),
      ]);
      health = fetchedHealth;
      rows = batchRows;
    } else {
      rows = await fetchEmbedBatch(batchIds, "reader");
    }

    const sortedRows = [...rows].sort(
      (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
    );
    for (const row of sortedRows) {
      const item = toNearItem(row, health);
      if (item) items.push(item);
    }
  }

  // Closest to the blindspot line first; the newest activity breaks ties.
  items.sort(
    (a, b) =>
      b.dominantShare - a.dominantShare ||
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  return items.slice(0, NEAR_BLINDSPOT_DISPLAY_LIMIT);
}

// Build-safety: `attemptCached` keeps a throw from crossing the
// `"use cache: remote"` boundary (see src/lib/cache-resilience.ts). Exactly ONE
// `cacheLife` per invocation, chosen after the attempt: a failure (typically
// the 4 s reader abort on a cold database) is memoised for `minutes` only.
async function getNearBlindspotsCached() {
  "use cache: remote";
  cacheTag("clusters", "clusters-politics");
  const r = await attemptCached("near-blindspots", fetchNearBlindspots);
  // One literal per call: Next 16.4 types cacheLife as single-literal overloads.
  if (r.ok) cacheLife("cluster-feed");
  else cacheLife("minutes");
  return r;
}

/**
 * Public entry point for the /blindspots "Kör noktaya yakın" section. Never
 * throws: a cache-attempt failure retries the query live once, and a still
 * failing outage resolves to `null` (the section is then simply hidden).
 * Not a cron reader, so it takes no ReadProfile option and always uses the
 * capped reader client.
 */
export async function getNearBlindspotsSafe(): Promise<NearBlindspotItem[] | null> {
  return resolveCachedOrRetry<NearBlindspotItem[] | null>(
    "near-blindspots",
    getNearBlindspotsCached,
    fetchNearBlindspots,
    null,
  );
}
