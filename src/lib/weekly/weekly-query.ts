import { cacheLife, cacheTag } from "next/cache";

import { zoneOf } from "@/lib/bias/config";
import { zoneCountsOf } from "@/lib/bias/zone-summary";
import {
  shouldSuppressBlindspot,
  type ZoneFeedHealth,
} from "@/lib/clusters/feed-health";
import { createServerClient } from "@/lib/supabase/server";
import type { BiasCategory, BiasDistribution, MediaDnaZone } from "@/types";

// Data layer for /hafta (P-07, "Medya Hava Durumu") — the trailing-7-day
// read of what each Medya DNA zone led with, which stories drew the widest
// spectrum, which ones only one side covered, and which source labels moved.
//
// Two bounded reads, both cached, both fail-soft:
//
//   * `getWeeklyClusters` — one window query on `clusters` (>=2 members,
//     not archived, first_published inside the trailing week), hard-capped
//     at WEEKLY_CLUSTER_LIMIT rows. The window is computed from a single
//     `Date.now()` so the two bounds can never straddle a tick.
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

/** Hard row cap on the weekly cluster window (bounded query, risk note). */
export const WEEKLY_CLUSTER_LIMIT = 2000;

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
  "id, title_tr, title_tr_neutral, bias_distribution, is_blindspot, blindspot_side, article_count, first_published";

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

    if (row.is_blindspot) {
      const side = row.blindspot_side
        ? zoneOf(row.blindspot_side)
        : dominantZoneOf(counts);
      // No stored side and no zone evidence => nothing to claim; skip the
      // row rather than naming a side the data does not support.
      if (side !== null && !shouldSuppressBlindspot(side, health)) {
        blindspots.push({
          id: row.id,
          title: titleOf(row),
          articleCount: row.article_count,
          side,
        });
      }
    }
  }

  const byArticleCountDesc = <T extends { articleCount: number }>(a: T, b: T) =>
    b.articleCount - a.articleCount;

  return {
    zoneCounts,
    topClusters: topClusters.sort(byArticleCountDesc).slice(0, WEEKLY_LIST_SIZE),
    blindspots: blindspots.sort(byArticleCountDesc).slice(0, WEEKLY_LIST_SIZE),
  };
}

/**
 * The trailing-7-day cluster window. `null` = "the week could not be read"
 * (the page renders that as unavailable); `[]` = "the week is genuinely
 * empty".
 */
export async function getWeeklyClusters(): Promise<WeeklyClusterRow[] | null> {
  "use cache";
  cacheLife("cluster-feed");
  cacheTag("clusters-politics");

  try {
    const supabase = createServerClient();
    // One clock read: two `Date.now()` calls could straddle a tick and
    // leave the window a millisecond wider than WEEK_MS.
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const weekAgoIso = new Date(nowMs - WEEK_MS).toISOString();

    const { data, error } = await supabase
      .from("clusters")
      .select(CLUSTER_SELECT)
      .eq("is_archived", false)
      .gte("article_count", WEEKLY_MIN_ARTICLES)
      .gte("first_published", weekAgoIso)
      // Upper bound: a source-controlled future `published_at` must not
      // drag a cluster into every week forever (same guard as
      // src/lib/sources/feed-status.ts's SEC-01 note).
      .lte("first_published", nowIso)
      .order("article_count", { ascending: false })
      .limit(WEEKLY_CLUSTER_LIMIT)
      .returns<WeeklyClusterRow[]>();

    if (error) {
      console.error(`[weekly] clusters unavailable: ${error.message}`);
      return null;
    }

    return data ?? [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[weekly] clusters unavailable: ${message}`);
    return null;
  }
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

/**
 * Public label changes inside the same 7-day window. `null` = the history
 * could not be read; `[]` = nothing moved this week.
 */
export async function getWeeklyLabelChanges(): Promise<
  WeeklyLabelChange[] | null
> {
  "use cache";
  cacheLife("source-directory");
  cacheTag("sources");

  try {
    const supabase = createServerClient();
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
