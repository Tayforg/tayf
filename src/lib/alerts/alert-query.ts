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
 *   - blindspot: EVERY public claim of `getBlindspots()`, the cards (`bundles`,
 *     side-balanced, at most 30) AND the compact rows (`more`), which together
 *     are the whole /blindspots list. It already carries the recall veto
 *     (`.eq('blindspot_recall_veto', false)`), the live contract (>=5 voting
 *     sources, >=80% in one zone), the 24h delay and feed-health suppression.
 *     There is no separate blindspot cap: only `limit` cuts the merged list.
 *     The cards rank by side balance and share, not recency, so a fresh claim on
 *     the larger side lands in `more` and would never have been alerted by the
 *     cards alone (14 of 44 claims on 2026-11-11). A claim keeps the same alert
 *     id (`blindspot:<cluster id>`) whether it is a card or a row, so the
 *     webhook queue's unique (key_id, alert_id) never re-delivers it when it is
 *     promoted or demoted.
 *   - one_zone_silent: ONE lean query, then the pure `oneZoneSilentOf`.
 *     "Silent" means Tayf could not match a story from that zone, not that
 *     the zone stayed quiet, so a zone whose feeds are degraded is dropped.
 *     With `health` null the pull fails open, as the site does. The query
 *     admits `updated_at >= since OR first_published >= since - 6 h` (bounded
 *     by `first_published <= now - 6 h` and the candidate limit), so a cluster
 *     that merely turned 6 h old inside the window is a candidate too.
 *
 * The candidate pull is cut by `updated_at` (newest first) BEFORE the alertAt
 * filter, so a cap that is too small silently drops the OLDEST qualifying
 * alerts of a long `since` window (at 200 a 7-day pull lost 31 of 64 on
 * 2026-11-09). `getAlertItems` therefore returns `{ items, truncated }`:
 * `truncated` is true when the pull came back with exactly
 * SILENT_CANDIDATE_LIMIT rows, i.e. older candidates may not have been read.
 * The blindspot list is not part of `truncated`.
 */

const SILENT_SELECT =
  "id,title_tr,title_tr_neutral,bias_distribution,article_count,first_published,updated_at";
/**
 * Row cap of the one-zone-silent candidate pull (newest `updated_at` first).
 * Today a 7-day window (the `since` clamp) holds about 400 candidates (401 on
 * 2026-11-09), so 1000 leaves about 2.5x headroom. It is also PostgREST's own
 * `max_rows` on Supabase, so the cap cannot silently be lower than the number
 * asked for. The select stays lean (7 columns).
 */
export const SILENT_CANDIDATE_LIMIT = 1000;

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

/** A public /blindspots claim, whether it holds a card or a compact row. */
interface BlindspotClaim {
  id: string;
  title: string;
  firstPublished: string;
  updatedAt: string;
  /** Voting sources: the sum of `counts`. */
  total: number;
  counts: Record<MediaDnaZone, number>;
  dominantZone: MediaDnaZone;
}

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

export interface AlertQueryResult {
  items: AlertItem[];
  /**
   * The one_zone_silent candidate pull returned exactly SILENT_CANDIDATE_LIMIT
   * rows, so older candidates of the window may not have been read. The
   * blindspot list (cards and compact rows) is deliberately not part of this flag.
   */
  truncated: boolean;
}

export async function getAlertItems(input: AlertQueryInput): Promise<AlertQueryResult> {
  const { sinceIso, limit, health, profile = "reader" } = input;
  const nowMs = input.nowMs ?? Date.now();
  const sinceMs = Date.parse(sinceIso);
  if (!Number.isFinite(sinceMs)) throw new Error("[alerts] sinceIso is not a valid timestamp");

  const items: AlertItem[] = [];

  const { bundles, more } = await getBlindspots({ profile });
  // One normalised list for every public claim: the cards first, then the
  // compact rows. A claim is never in both lists; a repeated id keeps its first
  // (card) entry anyway.
  const claims: BlindspotClaim[] = [];
  const seenClaims = new Set<string>();
  for (const b of bundles) {
    if (seenClaims.has(b.cluster.id)) continue;
    seenClaims.add(b.cluster.id);
    const tally = tallyZones(normalizeDistribution(b.cluster.bias_distribution));
    claims.push({
      id: b.cluster.id,
      title: b.cluster.title_tr,
      firstPublished: b.cluster.first_published,
      updatedAt: b.cluster.updated_at,
      total: tally.total,
      counts: tally.counts,
      dominantZone: b.dominantZone,
    });
  }
  for (const row of more ?? []) {
    if (seenClaims.has(row.id)) continue;
    seenClaims.add(row.id);
    claims.push({
      id: row.id,
      title: row.title,
      firstPublished: row.firstPublished,
      updatedAt: row.updatedAt,
      total: ZONES.reduce((sum, z) => sum + row.votingZoneCounts[z], 0),
      counts: row.votingZoneCounts,
      dominantZone: row.dominantZone,
    });
  }
  for (const c of claims) {
    const alertAt = alertAtOf("blindspot", c.firstPublished, c.updatedAt);
    if (alertAt === null || Date.parse(alertAt) < sinceMs) continue;
    items.push({
      type: "blindspot",
      clusterId: c.id,
      title: isTitle(c.title) ? c.title : "",
      firstPublished: c.firstPublished,
      updatedAt: c.updatedAt,
      alertAt,
      sourceCount: c.total,
      zoneCounts: { ...c.counts },
      dominantZone: c.dominantZone,
      silentZones: ZONES.filter((z) => c.counts[z] === 0),
    });
  }

  const olderThanIso = new Date(nowMs - SILENT_MIN_AGE_H * 3600 * 1000).toISOString();
  // alertAt >= since  <=>  updated_at >= since  OR  first_published + 6 h >= since.
  // Both bounds are re-serialised from the parsed instant: the `.or()` string
  // is a PostgREST logic tree, so nothing but a canonical ISO value goes in.
  const sinceBoundIso = new Date(sinceMs).toISOString();
  const silentFloorIso = new Date(sinceMs - SILENT_MIN_AGE_H * 3600 * 1000).toISOString();
  const supabase = createServerClient();
  const { data, error, status } = await supabase
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
  // The PostgREST error and its response status ride along as the cause, so the keyed route's
  // apiServerError can tell a database outage (57014, the reader cap's abort, a gateway 5xx) from
  // a bug: the prefixed message alone hides all three from isUpstreamUnavailable.
  if (error) {
    throw new Error(`[alerts] silent candidate select error: ${error.message}`, {
      cause: { ...error, status },
    });
  }

  const candidates = data ?? [];
  const truncated = candidates.length === SILENT_CANDIDATE_LIMIT;

  for (const row of candidates) {
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
  return { items: items.slice(0, limit), truncated };
}
