import {
  SILENT_MIN_AGE_H,
  SILENT_MIN_SOURCES,
  normalizeDistribution,
  oneZoneSilentOf,
  type AlertItem,
} from "@/lib/alerts/alert-feed";
import { tallyZones } from "@/lib/bias/config";
import { getBlindspots } from "@/lib/clusters/blindspots-query";
import type { ZoneFeedHealth } from "@/lib/clusters/feed-health";
import { createServerClient } from "@/lib/supabase/server";
import type { MediaDnaZone } from "@/types";

/**
 * Item source for the alert feed and the webhook cron.
 *
 * Two rules, merged newest-first:
 *   - blindspot: `getBlindspots()` as-is. It already carries the recall veto
 *     (`.eq('blindspot_recall_veto', false)`), the live contract (>=5 voting
 *     sources, >=80% in one zone), the 24h delay and feed-health
 *     suppression, and is capped at 30 like /blindspots.
 *   - one_zone_silent: ONE lean query, then the pure `oneZoneSilentOf`.
 *     "Silent" means Tayf could not match a story from that zone, not that
 *     the zone stayed quiet, so a zone whose feeds are degraded is dropped.
 *     With `health` null the pull fails open, as the site does.
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
  /** Injectable clock for tests; defaults to the request-time clock. */
  nowMs?: number;
}

function isTitle(v: string | null | undefined): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export async function getAlertItems(input: AlertQueryInput): Promise<AlertItem[]> {
  const { sinceIso, limit, health } = input;
  const nowMs = input.nowMs ?? Date.now();
  const sinceMs = Date.parse(sinceIso);

  const items: AlertItem[] = [];

  const { bundles } = await getBlindspots();
  for (const b of bundles.slice(0, BLINDSPOT_CAP)) {
    if (Date.parse(b.cluster.updated_at) < sinceMs) continue;
    const tally = tallyZones(normalizeDistribution(b.cluster.bias_distribution));
    items.push({
      type: "blindspot",
      clusterId: b.cluster.id,
      title: isTitle(b.cluster.title_tr) ? b.cluster.title_tr : "",
      firstPublished: b.cluster.first_published,
      updatedAt: b.cluster.updated_at,
      sourceCount: tally.total,
      zoneCounts: { ...tally.counts },
      dominantZone: b.dominantZone,
      silentZones: ZONES.filter((z) => tally.counts[z] === 0),
    });
  }

  const olderThanIso = new Date(nowMs - SILENT_MIN_AGE_H * 3600 * 1000).toISOString();
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("clusters")
    .select(SILENT_SELECT)
    .eq("is_archived", false)
    .eq("is_blindspot", false)
    .eq("blindspot_recall_veto", false)
    .gte("article_count", SILENT_MIN_SOURCES)
    .gte("updated_at", sinceIso)
    .lte("first_published", olderThanIso)
    .order("updated_at", { ascending: false })
    .limit(SILENT_CANDIDATE_LIMIT)
    .returns<SilentRow[]>();
  if (error) throw new Error(`[alerts] silent candidate select error: ${error.message}`);

  for (const row of data ?? []) {
    const silent = oneZoneSilentOf(row.bias_distribution);
    if (!silent) continue;
    if (health?.[silent.silentZone]?.degraded) continue;
    items.push({
      type: "one_zone_silent",
      clusterId: row.id,
      title: isTitle(row.title_tr_neutral) ? row.title_tr_neutral : row.title_tr,
      firstPublished: row.first_published,
      updatedAt: row.updated_at,
      sourceCount: silent.total,
      zoneCounts: silent.counts,
      dominantZone: null,
      silentZones: [silent.silentZone],
    });
  }

  items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return items.slice(0, limit);
}
