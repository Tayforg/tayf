import { cacheLife, cacheTag } from "next/cache";

import { zoneOf } from "@/lib/bias/config";
import { zoneCountsOf, zonePercents } from "@/lib/bias/zone-summary";
import { resolveCachedOrRetry } from "@/lib/cache-resilience";
import {
  shouldSuppressBlindspot,
  type ZoneFeedHealth,
} from "@/lib/clusters/feed-health";
import { applyRecallVeto } from "@/lib/clusters/recall-veto";
import { POSTGREST_MAX_ROWS, readAllPages } from "@/lib/db/paging";
import { dedupeByTitle } from "@/lib/weekly/dedupe-titles";
import { createReaderClient } from "@/lib/supabase/server";
import type { BiasCategory, BiasDistribution, MediaDnaZone } from "@/types";

// Data layer for /hafta (P-07, "Medya Hava Durumu") — the trailing-7-day
// read of what each Medya DNA zone led with, which stories drew the widest
// spectrum, which ones only one side covered, and which source labels moved.
//
// Two bounded reads, both cached, both fail-soft:
//
//   * `getWeeklyClusters` — the window on `clusters` (>=2 members, not
//     archived, first_published inside the trailing week), read EVERY row in
//     pages of POSTGREST_MAX_ROWS (PostgREST cuts any response at 1,000 rows
//     whatever `.limit()` asks for, which used to drop ~21% of the week's
//     votes silently). The order is deterministic (article_count desc, then
//     id) so page boundaries never skip or repeat a cluster, and the read is
//     bounded at WEEKLY_CLUSTER_LIMIT rows: only a read that actually hit
//     that ceiling is reported `truncated`. The window is computed from a
//     single `Date.now()` so the bounds can never straddle a tick.
//   * `getWeeklyLabelChanges` — the last WEEKLY_LABEL_CHANGE_LIMIT rows of
//     `source_zone_history` inside the same window, inner-joined to an
//     *active* source so the read mirrors migration 055's public policy
//     (orphan/inactive rows are archival-only) and the source name is
//     embedded so the page never has to fan out a second query.
//
// Never throws (mirrors src/lib/quality/snapshots.ts and
// src/lib/clusters/feed-health.ts verbatim): a throw inside "use cache"
// fails the whole prerender, so a Supabase error resolves to `null` and
// the page renders its honest "unavailable" state instead of fabricating a
// week. `null` and `[]` are deliberately different answers — "we could not
// read the week" vs "the week produced nothing".
//
// All aggregation lives in the pure `summariseWeek` below so the page is a
// renderer and the arithmetic is unit-testable without a Supabase round
// trip.

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Hard row ceiling on the weekly cluster window (bounded query, risk note),
 * read in pages of POSTGREST_MAX_ROWS. A full week is about 2,000 clusters
 * today; this is a safety bound, not a sample size.
 */
export const WEEKLY_CLUSTER_LIMIT = 5000;

/** Requests the paged cluster read may issue before it reports `truncated`. */
const WEEKLY_CLUSTER_MAX_PAGES = WEEKLY_CLUSTER_LIMIT / POSTGREST_MAX_ROWS;

/** Hard row cap on the weekly label-change window. */
export const WEEKLY_LABEL_CHANGE_LIMIT = 50;

/** A cluster needs at least this many members to enter the weekly window. */
export const WEEKLY_MIN_ARTICLES = 2;

/** How many rows each of the two weekly lists shows. */
export const WEEKLY_LIST_SIZE = 5;

const ZONE_ORDER: readonly MediaDnaZone[] = [
  "iktidar",
  "bagimsiz",
  "muhalefet",
];

const CLUSTER_SELECT =
  "id, title_tr, title_tr_neutral, bias_distribution, is_blindspot, blindspot_side, blindspot_recall_veto, article_count, first_published";

// `!inner` (plus the `source.active` filter below) is what keeps this read
// inside migration 055's public policy: orphan history rows (source_id null
// after an ON DELETE SET NULL) and rows pointing at an inactive source are
// dropped by PostgREST, server-side, before the row limit applies.
const LABEL_CHANGE_SELECT =
  "source_slug, old_bias, new_bias, reason, changed_at, source:sources!inner ( name, active )";

export interface WeeklyClusterRow {
  id: string;
  title_tr: string;
  title_tr_neutral: string | null;
  /** Nullable in the DB — `safeZoneCounts` is the live guard, not dead code. */
  bias_distribution: BiasDistribution | null;
  is_blindspot: boolean;
  blindspot_side: BiasCategory | null;
  /** Migration 071 recall veto; `true` withdraws the blindspot claim. */
  blindspot_recall_veto?: boolean | null;
  article_count: number;
  first_published: string;
}

export interface WeeklyLabelChange {
  slug: string;
  name: string;
  oldBias: BiasCategory | null;
  newBias: BiasCategory;
  reason: string | null;
  changedAt: string;
}

export interface WeeklyTopCluster {
  id: string;
  title: string;
  articleCount: number;
  zonesCovered: number;
  zoneCounts: Record<MediaDnaZone, number>;
}

export interface WeeklyBlindspot {
  id: string;
  title: string;
  articleCount: number;
  side: MediaDnaZone;
  /**
   * The stored side's share of the row's zone-attributed articles, 0..1; `null`
   * when the row has no zone evidence at all (a stored side with no
   * distribution). Exactly 1 is the only value that earns a "sadece" claim.
   */
  share: number | null;
  /**
   * `share` as the integer the zone bar prints (same largest-remainder
   * rounding), clamped to 99 while `share` is below 1 so a near-total share
   * never reads %100. `null` exactly when `share` is.
   */
  sharePct: number | null;
}

/**
 * One paged read of a week's clusters. `truncated` is true only when the read
 * stopped at its own page ceiling with a full last page (rows may be missing);
 * a short last page is the whole window.
 */
export interface WeeklyClusterRead {
  rows: WeeklyClusterRow[];
  truncated: boolean;
}

export interface WeeklySummary {
  zoneCounts: Record<MediaDnaZone, number>;
  topClusters: WeeklyTopCluster[];
  blindspots: WeeklyBlindspot[];
}

function emptyZoneCounts(): Record<MediaDnaZone, number> {
  return { iktidar: 0, bagimsiz: 0, muhalefet: 0 };
}

/**
 * `zoneCountsOf` walks `Object.entries(distribution)`, which throws on
 * `null`/`undefined`. `bias_distribution` is nullable in the DB and this
 * module casts PostgREST output rather than validating it, so a missing
 * distribution must degrade to "no zones covered" — not a prerender crash.
 */
function safeZoneCounts(
  distribution: BiasDistribution | null | undefined,
): Record<MediaDnaZone, number> {
  if (!distribution || typeof distribution !== "object") {
    return emptyZoneCounts();
  }
  return zoneCountsOf(distribution);
}

function titleOf(row: WeeklyClusterRow): string {
  return row.title_tr_neutral ?? row.title_tr;
}

/**
 * The zone with the most articles; ties break in ZONE_ORDER order. `null`
 * when the row carries no zone evidence at all (missing/empty
 * `bias_distribution`): seeding with ZONE_ORDER[0] would publish "only the
 * iktidar side covered this" from zero counts, which is a fabricated
 * editorial claim, not a default.
 */
function dominantZoneOf(
  counts: Record<MediaDnaZone, number>,
): MediaDnaZone | null {
  if (counts.iktidar + counts.bagimsiz + counts.muhalefet === 0) return null;
  let best: MediaDnaZone = ZONE_ORDER[0]!;
  for (const zone of ZONE_ORDER) {
    if (counts[zone] > counts[best]) best = zone;
  }
  return best;
}

/**
 * How much of a row's zone-attributed coverage sits on `side`. `sharePct` uses
 * the bar's own largest-remainder rounding, so the row and the bar never
 * disagree; it is clamped to 99 while the share is below 1, because a rounded
 * 100 would read as the unqualified "only this side" claim the data does not
 * support (199 : 1 is 99.5%, not "sadece").
 */
function sideShareOf(
  counts: Record<MediaDnaZone, number>,
  side: MediaDnaZone,
): { share: number | null; sharePct: number | null } {
  const total = counts.iktidar + counts.bagimsiz + counts.muhalefet;
  if (total <= 0) return { share: null, sharePct: null };

  const share = counts[side] / total;
  let sharePct = zonePercents(counts)[side];
  if (share < 1 && sharePct >= 100) sharePct = 99;
  return { share, sharePct };
}

/**
 * Pure weekly aggregation. `health` is the read-path blindspot gate: a zone
 * whose feeds are degraded cannot be said to have *chosen* silence, so
 * `shouldSuppressBlindspot` drops those claims (null health = fail open,
 * suppress nothing — see feed-health.ts).
 */
export function summariseWeek(
  rows: WeeklyClusterRow[],
  health: ZoneFeedHealth | null,
): WeeklySummary {
  const zoneCounts = emptyZoneCounts();
  const topClusters: WeeklyTopCluster[] = [];
  const blindspots: WeeklyBlindspot[] = [];

  for (const row of rows) {
    const counts = safeZoneCounts(row.bias_distribution);
    for (const zone of ZONE_ORDER) zoneCounts[zone] += counts[zone];

    const zonesCovered = ZONE_ORDER.filter((zone) => counts[zone] > 0).length;
    if (zonesCovered >= 2) {
      topClusters.push({
        id: row.id,
        title: titleOf(row),
        articleCount: row.article_count,
        zonesCovered,
        zoneCounts: counts,
      });
    }

    // Migration 071 recall veto: a withdrawn claim leaves the blindspot
    // list only — the story still counts toward zone totals and topClusters.
    const veto = applyRecallVeto(row);
    if (veto.isBlindspot) {
      const side = row.blindspot_side
        ? zoneOf(row.blindspot_side)
        : dominantZoneOf(counts);
      // No stored side and no zone evidence => nothing to claim; skip the
      // row rather than naming a side the data does not support.
      if (side !== null && !shouldSuppressBlindspot(side, health)) {
        const { share, sharePct } = sideShareOf(counts, side);
        blindspots.push({
          id: row.id,
          title: titleOf(row),
          articleCount: row.article_count,
          side,
          share,
          sharePct,
        });
      }
    }
  }

  const byArticleCountDesc = <T extends { articleCount: number }>(a: T, b: T) =>
    b.articleCount - a.articleCount;

  // browser-qa-15: Jev's clustering can split one real-world story into two
  // clusters with cosmetically different headlines (case, punctuation, an
  // added "!") — de-dupe by folded title AFTER sorting by rank, so "first"
  // (kept) is always the higher-article-count duplicate, then re-slice to
  // the list size from whatever real rows remain.
  return {
    zoneCounts,
    topClusters: dedupeByTitle(
      topClusters.sort(byArticleCountDesc),
      (c) => c.title,
    ).slice(0, WEEKLY_LIST_SIZE),
    blindspots: dedupeByTitle(
      blindspots.sort(byArticleCountDesc),
      (b) => b.title,
    ).slice(0, WEEKLY_LIST_SIZE),
  };
}

/**
 * The trailing-7-day cluster window. `null` = "the week could not be read"
 * (the page renders that as unavailable; one failed page discards the rest,
 * a partial week would be a wrong total shown as the right one); an empty
 * `rows` = "the week is genuinely empty".
 */
async function fetchWeeklyClusters(): Promise<WeeklyClusterRead | null> {
  try {
    const supabase = createReaderClient();
    // One clock read: two `Date.now()` calls could straddle a tick and
    // leave the window a millisecond wider than WEEK_MS.
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const weekAgoIso = new Date(nowMs - WEEK_MS).toISOString();

    // A throw from readAllPages (a page error or an invalid page size) lands
    // in the catch below and becomes `null`.
    return await readAllPages(
      (from, to) =>
        supabase
          .from("clusters")
          .select(CLUSTER_SELECT)
          .eq("is_archived", false)
          .gte("article_count", WEEKLY_MIN_ARTICLES)
          .gte("first_published", weekAgoIso)
          // Upper bound: a source-controlled future `published_at` must not
          // drag a cluster into every week forever (same guard as
          // src/lib/sources/feed-status.ts's SEC-01 note).
          .lte("first_published", nowIso)
          // Unique per row: equal article_count tiers are broken by id, so a
          // page boundary inside a tier can neither skip nor repeat a cluster.
          .order("article_count", { ascending: false })
          .order("id", { ascending: true })
          .range(from, to)
          .returns<WeeklyClusterRow[]>(),
      { label: "weekly clusters", maxPages: WEEKLY_CLUSTER_MAX_PAGES },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[weekly] clusters unavailable: ${message}`);
    return null;
  }
}

// This was already build-safe (never throws — see the file header), but a
// `null` "could not read" result still got cached as the answer for the
// whole `cluster-feed` window. `getWeeklyClusters` below retries live once
// on a `null` before falling back, so a transient Supabase blip is not
// pinned for the rest of the window.
//
// Cache lifetime follows the outcome (exactly one `cacheLife` call, after the
// fetch; `cacheTag` first): a read keeps the `cluster-feed` window, a failed
// read (null, e.g. a 4 s reader-cap abort) is memoised for `minutes` only.
async function getWeeklyClustersCached() {
  "use cache";
  cacheTag("clusters-politics");

  const data = await fetchWeeklyClusters();
  // One literal per call: Next 16.4 types cacheLife as single-literal overloads.
  if (data === null) cacheLife("minutes");
  else cacheLife("cluster-feed");
  return data === null
    ? ({ ok: false, error: "weekly clusters unavailable" } as const)
    : ({ ok: true, data } as const);
}

export async function getWeeklyClusters(): Promise<WeeklyClusterRead | null> {
  return resolveCachedOrRetry(
    "weekly-clusters",
    getWeeklyClustersCached,
    fetchWeeklyClusters,
    null,
  );
}

type EmbeddedSource = { name?: string | null; active?: boolean | null };

/** Raw `source_zone_history` row, straight off PostgREST. */
interface WeeklyLabelChangeRawRow {
  source_slug?: string | null;
  old_bias?: BiasCategory | null;
  new_bias?: BiasCategory | null;
  reason?: string | null;
  changed_at?: string | null;
  /**
   * PostgREST returns an embedded to-one relationship as an object on some
   * paths and a one-element array on others (and omits it entirely if the
   * join is not resolvable), so all three shapes are handled.
   */
  source?: EmbeddedSource | EmbeddedSource[] | null;
}

function embeddedSourceOf(
  embed: WeeklyLabelChangeRawRow["source"],
): EmbeddedSource | null {
  if (!embed) return null;
  if (Array.isArray(embed)) return embed[0] ?? null;
  return embed;
}

function shapeLabelChanges(
  rows: WeeklyLabelChangeRawRow[] | null,
): WeeklyLabelChange[] {
  const out: WeeklyLabelChange[] = [];

  for (const row of rows ?? []) {
    const slug = row.source_slug;
    const newBias = row.new_bias;
    const changedAt = row.changed_at;
    if (!slug || !newBias || !changedAt) continue;

    const source = embeddedSourceOf(row.source);
    // Mirror migration 055's public read policy: a row is public only while
    // it still points at an *active* source. An unresolved embed means the
    // join found nothing (orphaned by the ON DELETE SET NULL, or filtered
    // out by the `!inner` join above) — those rows are archival-only and
    // must not be republished under the deleted outlet's slug.
    if (!source || source.active === false) continue;

    out.push({
      slug,
      // `name` is only a fallback for a null `name` column, never for a
      // missing source.
      name: source.name ?? slug,
      oldBias: row.old_bias ?? null,
      newBias,
      reason: row.reason ?? null,
      changedAt,
    });
  }

  return out;
}

async function fetchWeeklyLabelChanges(): Promise<
  WeeklyLabelChange[] | null
> {
  try {
    const supabase = createReaderClient();
    // One clock read, same as getWeeklyClusters: two `Date.now()` calls
    // could straddle a tick and widen the window past WEEK_MS.
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const weekAgoIso = new Date(nowMs - WEEK_MS).toISOString();

    const { data, error } = await supabase
      .from("source_zone_history")
      .select(LABEL_CHANGE_SELECT)
      // Inactive/orphaned sources are dropped server-side, before the row
      // limit, so they can never evict a public row from the window.
      .eq("source.active", true)
      .gte("changed_at", weekAgoIso)
      // Upper bound: a future `changed_at` must not sit in every week
      // forever (same SEC-01 guard as the cluster window above).
      .lte("changed_at", nowIso)
      .order("changed_at", { ascending: false })
      .limit(WEEKLY_LABEL_CHANGE_LIMIT)
      .returns<WeeklyLabelChangeRawRow[]>();

    if (error) {
      console.error(`[weekly] label changes unavailable: ${error.message}`);
      return null;
    }

    return shapeLabelChanges(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[weekly] label changes unavailable: ${message}`);
    return null;
  }
}

// Same outcome-driven lifetime as getWeeklyClustersCached: `source-directory`
// on a read, `minutes` on a failed read.
async function getWeeklyLabelChangesCached() {
  "use cache";
  cacheTag("sources");

  const data = await fetchWeeklyLabelChanges();
  // One literal per call: Next 16.4 types cacheLife as single-literal overloads.
  if (data === null) cacheLife("minutes");
  else cacheLife("source-directory");
  return data === null
    ? ({ ok: false, error: "weekly label changes unavailable" } as const)
    : ({ ok: true, data } as const);
}

/**
 * Public label changes inside the same 7-day window. `null` = the history
 * could not be read; `[]` = nothing moved this week. Retries live once on
 * a cache-attempt `null` before falling back, so a transient Supabase blip
 * is not pinned for the rest of the `source-directory` cacheLife window.
 */
export async function getWeeklyLabelChanges(): Promise<
  WeeklyLabelChange[] | null
> {
  return resolveCachedOrRetry(
    "weekly-label-changes",
    getWeeklyLabelChangesCached,
    fetchWeeklyLabelChanges,
    null,
  );
}
