import { BIAS_ORDER, BLINDSPOT, tallyZones } from "@/lib/bias/config";
import { buildRssXml, withUtm } from "@/lib/feeds/rss-builder";
import { formatZoneLine } from "@/lib/feeds/zone-line";
import { siteUrl } from "@/lib/site-url";
import type { BiasCategory, MediaDnaZone } from "@/types";

/**
 * Pure building blocks for the keyed alert feed (`/api/v1/alerts/blindspots`)
 * and the signed webhook payloads (`/api/cron/alerts-webhooks`): the
 * one-zone-silent rule, the wire record, and the RSS rendering. No I/O and
 * no clock, so it is safe from any context.
 *
 * Copy discipline: "silent" always means "Tayf could not match a story from
 * that zone", never "the zone chose not to write". The RSS wording below
 * must never accuse; a test pins that.
 */

export type AlertType = "blindspot" | "one_zone_silent";

export const ALERT_TYPES: readonly AlertType[] = ["blindspot", "one_zone_silent"];

/** Voting-source floor for one-zone-silent: same as the blindspot contract. */
export const SILENT_MIN_SOURCES = BLINDSPOT.minSources;
/** A cluster must be at least this old before a zone may be called silent. */
export const SILENT_MIN_AGE_H = 6;

const ZONES: readonly MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];

const ZONE_LABEL_TR: Record<MediaDnaZone, string> = {
  iktidar: "İktidar",
  bagimsiz: "Bağımsız",
  muhalefet: "Muhalefet",
};

export type ZoneCounts = Record<MediaDnaZone, number>;

export interface AlertItem {
  type: AlertType;
  clusterId: string;
  title: string;
  firstPublished: string;
  updatedAt: string;
  /**
   * ISO 8601: the moment the alert qualified, see `alertAtOf`. `since`, the
   * sort order and the webhook rule are all defined on this, not on
   * `updatedAt`.
   */
  alertAt: string;
  /** Voting-source total (bias_distribution sum). */
  sourceCount: number;
  zoneCounts: ZoneCounts;
  /** Blindspot only; null for one_zone_silent. */
  dominantZone: MediaDnaZone | null;
  silentZones: MediaDnaZone[];
}

export interface V1AlertRecord {
  id: string;
  type: AlertType;
  cluster_id: string;
  title: string;
  url: string;
  first_published: string;
  updated_at: string;
  /** The moment the alert qualified; `since`, ordering and webhooks use it. */
  alert_at: string;
  source_count: number;
  zone_counts: ZoneCounts;
  dominant_zone: MediaDnaZone | null;
  silent_zones: MediaDnaZone[];
}

/** Narrow `bias_distribution` jsonb to finite non-negative counts per bias key. */
export function normalizeDistribution(raw: unknown): Partial<Record<BiasCategory, number>> {
  const out: Partial<Record<BiasCategory, number>> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const obj = raw as Record<string, unknown>;
  for (const key of BIAS_ORDER) {
    const v = obj[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[key] = v;
  }
  return out;
}

export interface OneZoneSilent {
  silentZone: MediaDnaZone;
  total: number;
  counts: ZoneCounts;
}

/**
 * The voting total is at least SILENT_MIN_SOURCES and EXACTLY one zone has
 * a zero count. Two silent zones is a blindspot (a different rule); zero
 * silent zones is ordinary coverage. Malformed input yields null.
 */
export function oneZoneSilentOf(dist: unknown): OneZoneSilent | null {
  const tally = tallyZones(normalizeDistribution(dist));
  if (tally.total < SILENT_MIN_SOURCES) return null;
  const silent = ZONES.filter((z) => tally.counts[z] === 0);
  if (silent.length !== 1) return null;
  return { silentZone: silent[0]!, total: tally.total, counts: { ...tally.counts } };
}

/**
 * The moment an alert qualified (became visible under its rule):
 *   blindspot        max(updated_at, first_published + BLINDSPOT.feedDelayHours h)
 *   one_zone_silent  max(updated_at, first_published + SILENT_MIN_AGE_H h)
 * A blindspot is listed on /blindspots only once its cluster is
 * `feedDelayHours` old, and a silent zone only after SILENT_MIN_AGE_H, so
 * `updated_at` alone is usually EARLIER than the moment a consumer could first
 * have seen the alert; a later update moves it forward again.
 *
 * Pure (no clock). An unparsable timestamp is ignored in favour of the other;
 * null when neither parses. Always a UTC ISO string.
 */
export function alertAtOf(type: AlertType, firstPublished: string, updatedAt: string): string | null {
  const delayH = type === "blindspot" ? BLINDSPOT.feedDelayHours : SILENT_MIN_AGE_H;
  const qualifiedMs = Date.parse(firstPublished) + delayH * 3600 * 1000;
  const updatedMs = Date.parse(updatedAt);
  const ms = Math.max(
    Number.isFinite(qualifiedMs) ? qualifiedMs : -Infinity,
    Number.isFinite(updatedMs) ? updatedMs : -Infinity,
  );
  // Out-of-range sums (a year-275760 first_published) yield an Invalid Date.
  const out = new Date(ms);
  return Number.isNaN(out.getTime()) ? null : out.toISOString();
}

export function toV1AlertRecord(item: AlertItem): V1AlertRecord {
  return {
    id: `${item.type}:${item.clusterId}`,
    type: item.type,
    cluster_id: item.clusterId,
    title: item.title,
    url: `${siteUrl()}/cluster/${item.clusterId}`,
    first_published: item.firstPublished,
    updated_at: item.updatedAt,
    alert_at: item.alertAt,
    source_count: item.sourceCount,
    zone_counts: { ...item.zoneCounts },
    dominant_zone: item.dominantZone,
    silent_zones: [...item.silentZones],
  };
}

function rssItemFor(alert: V1AlertRecord) {
  const counts = formatZoneLine(alert.zone_counts);
  let title: string;
  let description = `${alert.source_count} kaynak · ${counts}.`;
  if (alert.type === "blindspot") {
    const zone = ZONE_LABEL_TR[alert.dominant_zone ?? "iktidar"];
    const pct = Math.round(BLINDSPOT.dominantShare * 100);
    title = `Kör nokta · ${zone} ağırlıklı: ${alert.title}`;
    description += ` Kaynakların en az %${pct}'i ${zone} bölgesinden.`;
  } else {
    const zone = ZONE_LABEL_TR[alert.silent_zones[0] ?? "muhalefet"];
    title = `Sessiz bölge · ${zone}: ${alert.title}`;
    description += ` Tayf, ${zone} bölgesindeki kaynaklardan bu kümeye eşleşen haber bulamadı.`;
  }
  return {
    title,
    link: withUtm(alert.url, { source: "api", medium: "alerts", campaign: "alerts" }),
    guid: alert.url,
    pubDate: alert.alert_at,
    description,
  };
}

export function buildAlertRss(alerts: readonly V1AlertRecord[], base: string = siteUrl()): string {
  return buildRssXml({
    title: "Tayf — Kör nokta ve sessiz bölge uyarıları",
    link: `${base}/blindspots`,
    selfUrl: `${base}/api/v1/alerts/blindspots?format=rss`,
    description:
      "Tayf'ın kör nokta ve tek bölgenin sessiz kaldığı haber kümeleri. Sessiz, Tayf'ın eşleştiremediği anlamına gelir.",
    items: alerts.map(rssItemFor),
  });
}
