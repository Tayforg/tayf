import { ZONE_META, zoneOf } from "@/lib/bias/config";
import type { ClusterDetailMember } from "@/lib/clusters/cluster-detail-query";
import type { ZoneFeedHealth } from "@/lib/clusters/feed-health";
import type { BiasCategory, MediaDnaZone } from "@/types";

// "Kim önce yazdı?" — the per-story timeline under the cluster page's
// spectrum. Pure: no I/O, no clock. The axis runs from the first point to
// the last one (never to "now"), so rendering it adds no dynamic API under
// cacheComponents and the same inputs always give the same markup.
//
// Keep this PER STORY. Across clusters, iktidar outlets publish first far
// more often, but that is confounded by source counts and the ~3-minute
// poll cadence — never aggregate this into an "X hep önce yazar" claim.
//
// Absence wording is deliberately "bu kümede haber yok", never "yazmadı":
// a zone with no member here may have covered the story in a cluster the
// matcher split off (see the blindspot recall veto), so the page must not
// assert silence.

/** Spectrum order — the order zones are listed in the summary sentence. */
const ZONE_ORDER: readonly MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];

/** A timeline needs at least this many distinct sources with a valid time. */
export const STORY_TIMELINE_MIN_SOURCES = 3;

/** Two times closer than this read as "the same minute". */
export const STORY_TIE_MS = 60_000;

/** Share of the first→last span added as padding (half on each side). */
const AXIS_PADDING = 0.1;

/** Tied first movers named before collapsing into "ve N kaynak daha". */
const MAX_TIE_NAMES = 2;

export interface StoryTimelineMember {
  articleId: string;
  sourceId: string;
  sourceName: string;
  bias: BiasCategory;
  title: string;
  url: string;
  publishedAt: string;
}

export interface StoryTimelinePoint {
  sourceName: string;
  zone: MediaDnaZone;
  /** Effective time, epoch ms: min(published_at, Tayf's created_at). */
  t: number;
  /** Istanbul clock label, with the day when the span crosses midnight. */
  clock: string;
  /** Position on the axis, 0..100 (padded so no dot sits on an edge). */
  offsetPct: number;
  title: string;
  url: string;
}

export interface StoryZoneJoin {
  t: number;
  lagMs: number;
  lagMin: number;
}

export interface StoryTimeline {
  points: StoryTimelinePoint[];
  first: {
    sourceName: string;
    zone: MediaDnaZone;
    t: number;
    clock: string;
    tie: boolean;
    /** Other sources within `STORY_TIE_MS` of the first mover, in order. */
    tiedWith: string[];
  };
  zoneJoin: Record<MediaDnaZone, StoryZoneJoin | null>;
  /** Zones with no voting member in this cluster at all. */
  absentZones: MediaDnaZone[];
  /** The subset of `absentZones` whose feeds are currently degraded. */
  degradedAbsentZones: MediaDnaZone[];
  crossesMidnight: boolean;
  summary: string;
}

/** Adapter from the cluster page's member rows (voting members only). */
export function timelineMembersFrom(
  members: readonly ClusterDetailMember[],
): StoryTimelineMember[] {
  return members.map((m) => ({
    articleId: m.article.id,
    sourceId: m.source.id,
    sourceName: m.source.name,
    bias: m.source.bias,
    title: m.article.title,
    url: m.article.url,
    publishedAt: m.article.published_at,
  }));
}

/** Distinct sources in `members` — the page's cheap pre-check before any fetch. */
export function votingSourceCount(members: readonly StoryTimelineMember[]): number {
  return new Set(members.map((m) => m.sourceId)).size;
}

/** Zones (spectrum order) with no member at all. */
export function missingZones(members: readonly StoryTimelineMember[]): MediaDnaZone[] {
  const present = new Set(members.map((m) => zoneOf(m.bias)));
  return ZONE_ORDER.filter((z) => !present.has(z));
}

const CLOCK = new Intl.DateTimeFormat("tr-TR", {
  timeZone: "Europe/Istanbul",
  hour: "2-digit",
  minute: "2-digit",
});
const CLOCK_WITH_DAY = new Intl.DateTimeFormat("tr-TR", {
  timeZone: "Europe/Istanbul",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
const ISTANBUL_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Istanbul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** "09:12", or "27 Eyl 09:12" with `withDay` — always Europe/Istanbul. */
export function formatStoryClock(t: number, withDay: boolean): string {
  return (withDay ? CLOCK_WITH_DAY : CLOCK).format(new Date(t));
}

/** "<1 dk" / "N dk" / "N sa M dk" / "N gün". */
export function formatLag(ms: number): string {
  if (ms < 60_000) return "<1 dk";
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 60) return `${totalMin} dk`;
  const hours = Math.floor(totalMin / 60);
  if (hours < 24) {
    const min = totalMin % 60;
    return min > 0 ? `${hours} sa ${min} dk` : `${hours} sa`;
  }
  return `${Math.floor(hours / 24)} gün`;
}

// "Bağımsız" is an adjective, the pole labels are nouns — so the pole zones
// take the possessive ("Muhalefet kaynaklarından") and bağımsız doesn't
// ("Bağımsız kaynaklardan").
const ABSENT_TEXT: Record<MediaDnaZone, string> = {
  iktidar: "İktidar kaynaklarından bu kümede haber yok",
  bagimsiz: "Bağımsız kaynaklardan bu kümede haber yok",
  muhalefet: "Muhalefet kaynaklarından bu kümede haber yok",
};
const DEGRADED_TEXT: Record<MediaDnaZone, string> = {
  iktidar: "İktidar kaynaklarının akışı şu an sorunlu",
  bagimsiz: "Bağımsız kaynakların akışı şu an sorunlu",
  muhalefet: "Muhalefet kaynaklarının akışı şu an sorunlu",
};

function effectiveTime(
  m: StoryTimelineMember,
  seenAt: Readonly<Record<string, string>> | null,
): number | null {
  const published = Date.parse(m.publishedAt);
  const seenIso = seenAt?.[m.articleId];
  const seen = seenIso ? Date.parse(seenIso) : Number.NaN;
  const candidates = [published, seen].filter(Number.isFinite);
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

function firstMoverLabel(names: readonly string[]): string {
  if (names.length <= MAX_TIE_NAMES) return names.join(" ve ");
  const shown = names.slice(0, MAX_TIE_NAMES);
  return `${shown.join(", ")} ve ${names.length - MAX_TIE_NAMES} kaynak daha`;
}

/**
 * Builds the timeline, or `null` when fewer than
 * `STORY_TIMELINE_MIN_SOURCES` distinct sources carry a valid time.
 *
 * `members` must be voting members only. `seenAt` maps article id → the
 * article's `created_at` (when Tayf first saw it); it caps a source-supplied
 * future pubDate (CNN Türk runs ~2.84 h ahead) but never moves a point
 * later. `health` only explains an absent zone; null means unknown and
 * never marks anything degraded.
 */
export function buildStoryTimeline(
  members: readonly StoryTimelineMember[],
  seenAt: Readonly<Record<string, string>> | null,
  health: ZoneFeedHealth | null,
): StoryTimeline | null {
  // One point per source: its earliest effective article.
  const bySource = new Map<string, { m: StoryTimelineMember; t: number }>();
  for (const m of members) {
    const t = effectiveTime(m, seenAt);
    if (t === null) continue;
    const prev = bySource.get(m.sourceId);
    if (!prev || t < prev.t) bySource.set(m.sourceId, { m, t });
  }
  const ordered = [...bySource.values()].sort(
    (a, b) => a.t - b.t || a.m.sourceName.localeCompare(b.m.sourceName, "tr"),
  );
  const firstEntry = ordered[0];
  const lastEntry = ordered[ordered.length - 1];
  if (ordered.length < STORY_TIMELINE_MIN_SOURCES || !firstEntry || !lastEntry) {
    return null;
  }
  const firstT = firstEntry.t;
  const lastT = lastEntry.t;
  const span = lastT - firstT;
  const crossesMidnight =
    ISTANBUL_DAY.format(new Date(firstT)) !== ISTANBUL_DAY.format(new Date(lastT));

  const axisStart = firstT - (span * AXIS_PADDING) / 2;
  const axisLength = span * (1 + AXIS_PADDING);
  const points: StoryTimelinePoint[] = ordered.map(({ m, t }) => ({
    sourceName: m.sourceName,
    zone: zoneOf(m.bias),
    t,
    clock: formatStoryClock(t, crossesMidnight),
    offsetPct: span === 0 ? 50 : ((t - axisStart) / axisLength) * 100,
    title: m.title,
    url: m.url,
  }));

  const zoneJoin: Record<MediaDnaZone, StoryZoneJoin | null> = {
    iktidar: null,
    bagimsiz: null,
    muhalefet: null,
  };
  for (const p of points) {
    if (zoneJoin[p.zone]) continue;
    const lagMs = p.t - firstT;
    zoneJoin[p.zone] = { t: p.t, lagMs, lagMin: Math.floor(lagMs / 60_000) };
  }

  // Absence is judged over every member passed in, dated or not: a member
  // whose times are both unparseable is still coverage, just not placeable.
  const absentZones = missingZones(members);
  const degradedAbsentZones = absentZones.filter((z) => health?.[z].degraded === true);

  const tied = points.filter((p) => p.t - firstT < STORY_TIE_MS);
  const head = points[0];
  if (!head) return null; // unreachable: ordered.length >= STORY_TIMELINE_MIN_SOURCES
  const first = {
    sourceName: head.sourceName,
    zone: head.zone,
    t: head.t,
    clock: head.clock,
    tie: tied.length > 1,
    tiedWith: tied.slice(1).map((p) => p.sourceName),
  };

  const parts = [
    first.tie
      ? `İlk: ${firstMoverLabel(tied.map((p) => p.sourceName))} aynı dakikada · ${first.clock}`
      : `İlk: ${first.sourceName} · ${first.clock}`,
  ];
  for (const zone of ZONE_ORDER) {
    if (zone === first.zone) continue;
    const join = zoneJoin[zone];
    const label = ZONE_META[zone].label;
    if (join) {
      parts.push(
        join.lagMs < STORY_TIE_MS
          ? `${label} aynı dakikada katıldı`
          : `${label} ${formatLag(join.lagMs)} sonra katıldı`,
      );
    } else if (degradedAbsentZones.includes(zone)) {
      parts.push(DEGRADED_TEXT[zone]);
    } else if (absentZones.includes(zone)) {
      parts.push(ABSENT_TEXT[zone]);
    }
    // Otherwise the zone is present but undated — say nothing about it.
  }

  return {
    points,
    first,
    zoneJoin,
    absentZones,
    degradedAbsentZones,
    crossesMidnight,
    summary: parts.join(" — "),
  };
}
