import {
  SILENT_MIN_AGE_H,
  SILENT_MIN_SOURCES,
  alertAtOf,
  normalizeDistribution,
  oneZoneSilentOf,
  type AlertItem,
} from "@/lib/alerts/alert-feed";
import { tallyZones } from "@/lib/bias/config";
import { getBlindspots } from "@/lib/clusters/blindspots-query";
import type { ZoneFeedHealth } from "@/lib/clusters/feed-health";
import { createServerClient, type ReadProfile } from "@/lib/supabase/server";
import type { MediaDnaZone } from "@/types";

/**
 * Item source for the alert feed and the webhook cron.
 *
 * `alertAt` is the moment an alert qualified (see `alertAtOf`):
 *   blindspot        max(updated_at, first_published + BLINDSPOT.feedDelayHours h)
 *   one_zone_silent  max(updated_at, first_published + SILENT_MIN_AGE_H h)
 * `since`, the merged sort order and the webhook `created_at` rule all use
 * it. A blindspot is only listed 24 h after first_published, while its
 * updated_at is typically ~2 h after first_published, so filtering `since` on
 * updated_at hid almost every qualifying blindspot (2 of 111 on 2026-11-01).
 *
 * Two rules, merged by alertAt newest-first (clusterId ascending on a tie):
 *   - blindspot: `getBlindspots()` as-is. It already carries the recall veto
 *     (`.eq('blindspot_recall_veto', false)`), the live contract (>=5 voting
 *     sources, >=80% in one zone), the 24h delay and feed-health
 *     suppression, and is capped at 30 like /blindspots.
 *   - one_zone_silent: ONE lean query, then the pure `oneZoneSilentOf`.
 *     "Silent" means Tayf could not match a story from that zone, not that
 *     the zone stayed quiet, so a zone whose feeds are degraded is dropped.
 *     With `health` null the pull fails open, as the site does. The query
 *     admits `updated_at >= since OR first_published >= since - 6 h` (bounded
 *     by `first_published <= now - 6 h` and the candidate limit), so a cluster
 *     that merely turned 6 h old inside the window is a candidate too.
 */

const SILENT_SELECT =
  "id,title_tr,title_tr_neutral,bias_distribution,article_count,first_published,updated_at";
const SILENT_CANDIDATE_LIMIT = 200;
/** Same cap as /blindspots (blindspots-query DISPLAY_LIMIT), re-applied defensively. */
const BLINDSPOT_CAP = 30;

interface SilentRow {
  id: string;
  title_tr: string;
  title_tr_neutral: string | null;
  bias_distribution: unknown;
  article_count: number;
  first_published: string;
  updated_at: string;
}

const ZONES: readonly MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];

export interface AlertQueryInput {
  sinceIso: string;
  limit: number;
  health?: ZoneFeedHealth | null;
  /**
   * "reader" (default; the public alerts API) reads blindspots with the 4 s
   * fail-fast cap. The alerts-webhooks cron passes "batch" so a cold read
   * keeps the full 8 s statement_timeout instead of aborting the tick.
   */
  profile?: ReadProfile;
  /** Injectable clock for tests; defaults to the request-time clock. */
  nowMs?: number;
}

function isTitle(v: string | null | undefined): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function byAlertAtDescThenId(a: AlertItem, b: AlertItem): number {
  const d = Date.parse(b.alertAt) - Date.parse(a.alertAt);
  if (d !== 0) return d;
  return a.clusterId < b.clusterId ? -1 : a.clusterId > b.clusterId ? 1 : 0;
}

export async function getAlertItems(input: AlertQueryInput): Promise<AlertItem[]> {
  const { sinceIso, limit, health, profile = "reader" } = input;
  const nowMs = input.nowMs ?? Date.now();
  const sinceMs = Date.parse(sinceIso);
  if (!Number.isFinite(sinceMs)) throw new Error("[alerts] sinceIso is not a valid timestamp");

  const items: AlertItem[] = [];

  const { bundles } = await getBlindspots({ profile });
  for (const b of bundles.slice(0, BLINDSPOT_CAP)) {
    const alertAt = alertAtOf("blindspot", b.cluster.first_published, b.cluster.updated_at);
    if (alertAt === null || Date.parse(alertAt) < sinceMs) continue;
    const tally = tallyZones(normalizeDistribution(b.cluster.bias_distribution));
    items.push({
      type: "blindspot",
      clusterId: b.cluster.id,
      title: isTitle(b.cluster.title_tr) ? b.cluster.title_tr : "",
      firstPublished: b.cluster.first_published,
      updatedAt: b.cluster.updated_at,
      alertAt,
      sourceCount: tally.total,
      zoneCounts: { ...tally.counts },
      dominantZone: b.dominantZone,
      silentZones: ZONES.filter((z) => tally.counts[z] === 0),
    });
  }

  const olderThanIso = new Date(nowMs - SILENT_MIN_AGE_H * 3600 * 1000).toISOString();
  // alertAt >= since  <=>  updated_at >= since  OR  first_published + 6 h >= since.
  // Both bounds are re-serialised from the parsed instant: the `.or()` string
  // is a PostgREST logic tree, so nothing but a canonical ISO value goes in.
  const sinceBoundIso = new Date(sinceMs).toISOString();
  const silentFloorIso = new Date(sinceMs - SILENT_MIN_AGE_H * 3600 * 1000).toISOString();
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("clusters")
    .select(SILENT_SELECT)
    .eq("is_archived", false)
    .eq("is_blindspot", false)
    .eq("blindspot_recall_veto", false)
    .gte("article_count", SILENT_MIN_SOURCES)
    .or(`updated_at.gte.${sinceBoundIso},first_published.gte.${silentFloorIso}`)
    .lte("first_published", olderThanIso)
    .order("updated_at", { ascending: false })
    .limit(SILENT_CANDIDATE_LIMIT)
    .returns<SilentRow[]>();
  if (error) throw new Error(`[alerts] silent candidate select error: ${error.message}`);

  for (const row of data ?? []) {
    const alertAt = alertAtOf("one_zone_silent", row.first_published, row.updated_at);
    if (alertAt === null || Date.parse(alertAt) < sinceMs) continue;
    const silent = oneZoneSilentOf(row.bias_distribution);
    if (!silent) continue;
    if (health?.[silent.silentZone]?.degraded) continue;
    items.push({
      type: "one_zone_silent",
      clusterId: row.id,
      title: isTitle(row.title_tr_neutral) ? row.title_tr_neutral : row.title_tr,
      firstPublished: row.first_published,
      updatedAt: row.updated_at,
      alertAt,
      sourceCount: silent.total,
      zoneCounts: silent.counts,
      dominantZone: null,
      silentZones: [silent.silentZone],
    });
  }

  items.sort(byAlertAtDescThenId);
  return items.slice(0, limit);
}
