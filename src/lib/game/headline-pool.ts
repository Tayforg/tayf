import { cacheLife, cacheTag } from "next/cache";

import { zoneOf } from "@/lib/bias/config";
import { sourceKindOf } from "@/lib/sources/kind";
// No server imports in source-language.ts, so this stays client-bundle safe.
import { ENGLISH_SOURCE_SLUGS } from "@/lib/sources/source-language";
import { createReaderClient } from "@/lib/supabase/server";
import type { BiasCategory, MediaDnaZone, SourceKind } from "@/types";
import { titleNamesOutlet } from "./outlet-leak";
import { isGameEligibleTitle } from "./pii-filter";
// The round and session sizes live in round-size.ts, a module with no server
// imports, because the client game needs GAME_ROUND_SIZE and must not pull this
// file (next/cache, "use cache") into the client bundle. Import them from there.
import { GAME_ROUND_SIZE } from "./round-size";
import { crossZoneTwinKeys, twinKey, type TwinKeyVersion } from "./title-twin";

// /oyun's headline pool — the pick. Mirrors the embedded-select shape
// blindspots-query.ts / politics-query.ts already use (clusters →
// cluster_articles → articles → sources in one round-trip) rather than
// inventing a different query shape for this one surface.
//
// All EIGHT filter rules (48h window, article_count >= 3, one headline per
// outlet per cluster, outlet-only sources, Turkish-language sources, PII
// filter, no headline that names its own outlet, no headline whose text an
// outlet or wire of another zone ran too) live in the pure
// `selectGameHeadlines` below — same "fetch broad, filter in JS" split
// blindspots-query.ts uses, so this is unit-testable without Supabase and
// the async wrapper stays a thin fetch + delegate.
//
// Four of those rules are what make the question fair. /oyun asks "which camp
// is this outlet in?", which is only a real question for an outlet whose zone
// is an editorial call: an aggregator or niche source carries a placeholder
// zone and a wire source republishes someone else's copy, so only
// `kind === "outlet"` passes (the same rule the daily mode applies). An
// English-language outlet gives its zone away through its language alone, so
// the slugs in ENGLISH_SOURCE_SLUGS are dropped too. And a headline that names
// its own outlet ("CNN TÜRK'te ...") gives the answer away by name, so
// outlet-leak.ts's `titleNamesOutlet` drops it. Last, a headline whose text an
// outlet or wire of ANOTHER zone ran word for word in the same story has two
// correct answers ("İlke TV", "Aydınlık" and AA all ran "Cumhurbaşkanı Erdoğan,
// ABD Başkanı Trump ile telefonda görüştü"), so title-twin.ts's `twinKey` drops
// it, on both sides (a "Son dakika..." lead-in does not hide the copy). These
// rules shrink the pool; GAME_ROUND_SIZE is deliberately NOT lowered to
// compensate.
//
// The outlet rule is per cluster: an outlet keeps ONE headline in each cluster
// it covers, not one in the whole window. A pool-wide rule left the pool with
// 21 candidates in 21 clusters (every /oyun session was 21 headlines, the last
// round 1, and 52% of them from the independent zone); per cluster it holds a
// thousand-odd candidates over ~190 clusters.
//
// What a single draw looks like is decided in `sampleHeadlines`, not here: the
// draw balances the three zones, holds at most one headline per cluster (per
// story) and at most MAX_HEADLINES_PER_OUTLET per outlet. It is a per-draw
// choice on purpose: the cached pool keeps every outlet's headline in every
// cluster, and each request picks at random.

export interface GameHeadline {
  articleId: string;
  /** The cluster (story) the headline belongs to; `sampleHeadlines` keeps one
   * headline per cluster. */
  clusterId: string;
  sourceId: string;
  title: string;
  sourceName: string;
  sourceSlug: string;
  bias: BiasCategory;
  zone: MediaDnaZone;
}

export interface GameSourceRow {
  id: string;
  name: string;
  slug: string;
  bias: BiasCategory;
  kind?: SourceKind | null;
  active: boolean;
}

export interface GameArticleRow {
  id: string;
  title: string;
  published_at: string;
  source_id: string;
  sources: GameSourceRow | null;
}

export interface GameClusterArticleRow {
  articles: GameArticleRow | null;
}

export interface GameClusterRow {
  id: string;
  article_count: number;
  cluster_articles: GameClusterArticleRow[] | null;
}

const WINDOW_HOURS = 48;
const DEFAULT_LIMIT = GAME_ROUND_SIZE;
// Broad DB-side candidate window — same order of magnitude as
// blindspots-query.ts's CANDIDATE_LIMIT — so a cheap `article_count >= 3`
// prefilter doesn't drag in the entire clusters table.
const CANDIDATE_LIMIT = 200;

/**
 * The twin-key version Bölge compares texts with (title-twin.ts): 2, so a
 * breaking-news lead-in of any punctuation ("Son dakika...", "SON DAKİKA…") does
 * not hide a copy another zone ran. Bölge has no replay contract (its pool is a
 * 5-minute cache, not a served-and-replayable set), so it never needs version 1;
 * the daily mode picks its version per puzzle key instead.
 */
const POOL_TWIN_KEY_VERSION: TwinKeyVersion = 2;

/**
 * A drawn list holds at most this many headlines from one outlet. It is 1
 * because /api/oyun's per-outlet throttle (THROTTLE_POLICY.oyunSourceLimit, 3
 * guesses per client per outlet per day) drops every guess past 3 silently:
 * one headline per outlet per 30-headline load keeps a player who reloads under
 * it for three loads a day, where 2 per load would start losing guesses on the
 * second reload.
 */
export const MAX_HEADLINES_PER_OUTLET = 1;

/**
 * The members of `cluster` that count as evidence for the twin-text rule: every
 * article whose source is present and an outlet or a wire (`sourceKindOf`, so a
 * legacy null kind is an outlet), with the zone of that source. No window,
 * `active` or language rule here.
 */
function* twinEvidence(
  cluster: GameClusterRow,
): Generator<{ title: string; zone: MediaDnaZone }> {
  for (const clusterArticle of cluster.cluster_articles ?? []) {
    const article = clusterArticle.articles;
    const source = article?.sources;
    if (!article || !source) continue;
    const kind = sourceKindOf({ kind: source.kind ?? undefined });
    if (kind !== "outlet" && kind !== "wire") continue;
    yield { title: article.title, zone: zoneOf(source.bias) };
  }
}

/**
 * PURE. Applies every /oyun eligibility rule — 48h window, article_count >=
 * 3, source.active, outlet-only kind (aggregator, niche and wire are
 * excluded), Turkish-language sources only (ENGLISH_SOURCE_SLUGS are
 * excluded), one headline per outlet PER CLUSTER, the PII filter (per
 * pii-filter.ts's "before sampling" ordering rule), the outlet-name rule
 * (a headline that names its own outlet is dropped), and the twin-text rule
 * (a headline whose text an outlet or wire of another zone ran in the same
 * cluster is dropped) — and
 * returns the FULL eligible candidate list, unshuffled and uncapped. No
 * Supabase dependency, so it's unit-testable with plain fixtures.
 *
 * One headline per outlet per cluster: two articles of the same outlet in one
 * cluster give one candidate (the first that passes every other rule), while
 * an outlet that covers two clusters has a candidate in each. The rule is NOT
 * pool-wide: that kept one headline per outlet across the whole 48 h window
 * and shrank the pool to about 20 candidates.
 *
 * The twin-text rule compares texts within ONE cluster, against EVERY member
 * whose source is an outlet or a wire, whatever its age, its `active` flag or
 * its language: the zone a reader would name for the text is not unique as soon
 * as such a member of another zone ran it, even if that member is not itself a
 * candidate (a wire never is). Aggregator and niche members are never evidence:
 * they republish and carry a placeholder zone. Two outlets of ONE zone with the
 * same text are not twins. The twin check runs before the outlet is marked seen,
 * so an outlet whose first headline is a twin can still offer a later, clean
 * one.
 *
 * Deliberately does NOT shuffle or cap: this runs inside the cached
 * `getGameHeadlines` call graph (5-minute `cacheLife`), so randomising here
 * would freeze the same draw for every visitor for the whole cache window.
 * Use `sampleHeadlines` per-request instead — see that function's doc
 * comment.
 */
export function selectGameHeadlines(
  rows: readonly GameClusterRow[],
): GameHeadline[] {
  const cutoffMs = Date.now() - WINDOW_HOURS * 3_600_000;
  const candidates: GameHeadline[] = [];

  for (const cluster of rows) {
    if (cluster.article_count < 3) continue;

    // Texts that members of two or more zones ran in this cluster. Built from
    // every outlet or wire member (before any window, active or language rule),
    // because those rules choose candidates, not what a reader has already seen
    // the other camp print.
    const twins = crossZoneTwinKeys(twinEvidence(cluster), POOL_TWIN_KEY_VERSION);

    // One outlet, one headline, per cluster.
    const seenSourceIds = new Set<string>();

    for (const clusterArticle of cluster.cluster_articles ?? []) {
      const article = clusterArticle.articles;
      if (!article) continue;

      const source = article.sources;
      if (!source) continue;
      if (!source.active) continue;
      // Uses the shared normalization helper (never a raw comparison on the
      // un-normalized column) so legacy/null `kind` values fall back to
      // "outlet" the same way every other reader consistently does. Only an
      // outlet's zone is a guessable fact: an aggregator's or niche source's
      // is a placeholder and a wire republishes (same rule as the daily mode).
      if (sourceKindOf({ kind: source.kind ?? undefined }) !== "outlet") continue;
      // An English-language outlet gives the answer away through its language.
      if (ENGLISH_SOURCE_SLUGS.has(source.slug)) continue;

      const publishedMs = new Date(article.published_at).getTime();
      if (!Number.isFinite(publishedMs) || publishedMs < cutoffMs) continue;

      if (seenSourceIds.has(source.id)) continue;

      // PII filter runs before this headline ever enters the candidate
      // pool that gets sampled from — never after.
      if (!isGameEligibleTitle(article.title)) continue;

      // A headline that names its own outlet gives the answer away. Dropped
      // before the outlet is marked seen, so a later clean headline of the
      // same outlet in this cluster still counts.
      if (titleNamesOutlet(article.title, source)) continue;

      // Another zone's outlet or wire ran the same text: the question would
      // have two right answers. Also dropped before the outlet is marked seen.
      if (twins.has(twinKey(article.title, POOL_TWIN_KEY_VERSION))) continue;

      seenSourceIds.add(source.id);
      candidates.push({
        articleId: article.id,
        clusterId: cluster.id,
        sourceId: source.id,
        title: article.title,
        sourceName: source.name,
        sourceSlug: source.slug,
        bias: source.bias,
        zone: zoneOf(source.bias),
      });
    }
  }

  return candidates;
}

/** In-place Fisher-Yates. `rng` must return a number in [0, 1); a value of
 * exactly 1 is clamped so a misbehaving rng cannot index past the end. */
function shuffleInPlace<T>(items: T[], rng: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rng() * (i + 1)));
    [items[i], items[j]] = [items[j] as T, items[i] as T];
  }
  return items;
}

/**
 * PURE. Draws up to `limit` headlines from the full eligible candidate list,
 * balanced across the three zones. Call this OUTSIDE the cached call graph —
 * per request, not per cache window — so every visitor (and every replay
 * within a 5-minute cache window) gets their own draw instead of the whole
 * window sharing one `rng` call. No cryptographic requirement; `rng` defaults
 * to `Math.random` and is a parameter so tests can seed it.
 *
 * How the draw is made:
 *   1. The candidates are split by zone and each zone's list is shuffled
 *      (Fisher-Yates) on its own.
 *   2. The zones are visited in rotation, starting at a random zone. From the
 *      zone whose turn it is, the next candidate is taken whose cluster is not
 *      in the draw yet and whose outlet has fewer than MAX_HEADLINES_PER_OUTLET
 *      headlines in it. A zone with no such candidate left drops out of the
 *      rotation for good.
 *   3. The draw stops at `limit` headlines or when no zone is left, and the
 *      picked list is shuffled once more so the zones are not in rotation
 *      order. The rotation balances the whole draw (exactly 10/10/10 when every
 *      zone has enough usable candidates); the final shuffle mixes the whole
 *      list, so a 10-headline round is balanced only on average (each zone about
 *      a third). A single round can come out 2/3/5 or more lopsided.
 *
 * Why a rotation and not one shuffle of the whole pool: with the outlet rule
 * per cluster, a uniform pick weights each zone by its outlet count (23 iktidar,
 * 22 bağımsız, 15 muhalefet outlets drew 46.5 / 23.0 / 30.5 %). Rotating over
 * the zones gives each the same share whatever its outlet count.
 *
 * Why one per cluster: the candidate list keeps every outlet's headline in every
 * cluster, so one story covered by four outlets would otherwise fill four slots
 * of a ten-headline round. Which outlet represents a cluster is random. The
 * key is the cluster id, falling back to the article id for a pool cached
 * before clusterId existed (or a row without one).
 *
 * Why at most MAX_HEADLINES_PER_OUTLET (1) per outlet: an outlet that covers
 * many clusters must not take a session over, and /api/oyun's per-outlet
 * throttle (THROTTLE_POLICY.oyunSourceLimit, 3 per client per outlet per day)
 * silently drops guesses past 3, so one headline per outlet per 30-headline load
 * keeps a player under it for three loads a day.
 *
 * With fewer usable clusters than `limit` the result is shorter: it is never
 * padded with a second headline of a cluster already in the list, nor with a
 * second headline of an outlet. A zone with a single cluster still appears,
 * once.
 */
export function sampleHeadlines(
  candidates: readonly GameHeadline[],
  limit: number = DEFAULT_LIMIT,
  rng: () => number = Math.random,
): GameHeadline[] {
  const byZone = new Map<MediaDnaZone, GameHeadline[]>();
  for (const headline of candidates) {
    const list = byZone.get(headline.zone);
    if (list) list.push(headline);
    else byZone.set(headline.zone, [headline]);
  }

  // Per zone: its own shuffled list and the index of the next candidate to try.
  const rotation = [...byZone.values()].map((list) => ({
    list: shuffleInPlace(list, rng),
    next: 0,
  }));

  const usedClusters = new Set<string>();
  const perOutlet = new Map<string, number>();
  const picked: GameHeadline[] = [];

  let turn = rotation.length > 0 ? Math.min(rotation.length - 1, Math.floor(rng() * rotation.length)) : 0;
  while (picked.length < limit && rotation.length > 0) {
    const at = turn % rotation.length;
    const zone = rotation[at] as (typeof rotation)[number];

    let choice: GameHeadline | undefined;
    while (zone.next < zone.list.length) {
      const headline = zone.list[zone.next] as GameHeadline;
      zone.next += 1;
      // `|| articleId`: a pool cached before clusterId existed (or a row without
      // an id) still dedupes per article instead of collapsing into one key.
      if (usedClusters.has(headline.clusterId || headline.articleId)) continue;
      if ((perOutlet.get(headline.sourceId) ?? 0) >= MAX_HEADLINES_PER_OUTLET) continue;
      choice = headline;
      break;
    }

    if (!choice) {
      // Nothing usable is left in this zone; the next zone now sits at `at`.
      rotation.splice(at, 1);
      turn = at;
      continue;
    }

    usedClusters.add(choice.clusterId || choice.articleId);
    perOutlet.set(choice.sourceId, (perOutlet.get(choice.sourceId) ?? 0) + 1);
    picked.push(choice);
    turn = at + 1;
  }

  return shuffleInPlace(picked, rng);
}

/**
 * Fetches and filters the eligible pool. NEVER throws, and distinguishes the
 * two "nothing to show" cases the UI must treat differently:
 *   - `[]`   a valid empty pool (the query worked; no cluster qualifies);
 *   - `null` the fetch FAILED (select error, thrown error, missing env).
 */
async function fetchGameHeadlinePool(): Promise<GameHeadline[] | null> {
  try {
    const supabase = createReaderClient();

    const { data, error } = await supabase
      .from("clusters")
      .select(
        `id, article_count,
         cluster_articles (
           articles (
             id, title, published_at, source_id,
             sources ( id, name, slug, bias, kind, active )
           )
         )`,
      )
      .eq("is_archived", false)
      .gte("article_count", 3)
      .order("updated_at", { ascending: false })
      .limit(CANDIDATE_LIMIT)
      .returns<GameClusterRow[]>();

    if (error) {
      // Fail-open, but as `null` rather than `[]`: the caller must be able
      // to tell "the fetch failed" from "no headlines qualify", because
      // `getGameHeadlines` below memoises its return value and gives a
      // failure a much shorter lifetime. Never throw inside `"use cache"`.
      console.error("[oyun] headline pool select error", error.message);
      return null;
    }

    return selectGameHeadlines(data ?? []);
  } catch (err) {
    console.error("[oyun] unexpected headline pool error", err);
    return null;
  }
}

// Cached entry point. Caches the ELIGIBLE POOL (every candidate that passes
// `selectGameHeadlines`'s eight rules: one headline per outlet per cluster),
// not the game's final list. The per-request sample (which headlines, in which
// order; zone-balanced, one per cluster, at most MAX_HEADLINES_PER_OUTLET per
// outlet, never padded) is drawn by the caller via `sampleHeadlines`, so it
// rotates on every request even while this pool stays cached.
//
// The cache lifetime depends on the outcome (Next's "conditional cache
// lifetimes": exactly one `cacheLife` call per invocation). A pool,
// including a valid empty `[]`, reuses the existing "cluster-feed" profile
// (5-minute revalidate) rather than adding a new next.config.ts entry for
// one surface. A failed fetch (`null`) is memoised too, because the return
// value of a `"use cache"` function always is, so it gets the built-in
// "minutes" profile (revalidate 60 s) and heals quickly instead of pinning
// /oyun on "unavailable" for the whole success window.
export async function getGameHeadlines(): Promise<GameHeadline[] | null> {
  "use cache";
  cacheTag("articles");
  const pool = await fetchGameHeadlinePool();
  if (pool === null) {
    cacheLife("minutes");
    return null;
  }
  cacheLife("cluster-feed");
  return pool;
}

/**
 * Uncached entry point for the /oyun page: the cached pool, plus one live
 * retry when the cached value is a failure (`null`). Returns `null` only
 * when both the cached attempt and the live retry failed; `[]` (a valid
 * empty pool) is returned as-is and not retried. Never throws.
 *
 * Call it only after `connection()`: the live retry reads the wall clock
 * (`selectGameHeadlines`' 48 h window), which a static prerender forbids.
 */
export async function loadGameHeadlines(): Promise<GameHeadline[] | null> {
  return (await getGameHeadlines()) ?? (await fetchGameHeadlinePool());
}
