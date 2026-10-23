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
  /**
   * False for a toplayıcı / niş (non-voting) source: plotted on the axis for
   * context, but never the first mover and never a zone's join.
   */
  voting: boolean;
}

export interface StoryZoneJoin {
  t: number;
  lagMs: number;
  lagMin: number;
}

/** One zone's first voting report — a row of the "İlk haber" list. */
export interface StoryZoneFirst {
  zone: MediaDnaZone;
  label: string;
  /** Istanbul clock of the zone's first voting report. */
  clock: string;
  /** Null for the earliest zone; else "aynı dakikada" or "+28 dk". */
  lag: string | null;
}

export interface StoryTimeline {
  /** Voting AND non-voting points, merged and sorted by time then name. */
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
  /** Whether the plotted axis (all points) spans an Istanbul midnight. */
  crossesMidnight: boolean;
  summary: string;
  /** One entry per zone with a dated voting point, ordered by join time. */
  zoneFirsts: StoryZoneFirst[];
  /** `zoneFirsts` as one shareable line: "İlk haber: İktidar 09:12 · …". */
  zoneLine: string;
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

/**
 * Position of `t` on the axis, 0..100. The axis runs first → last, padded by
 * `AXIS_PADDING` of the span (half on each side) so no dot sits on an edge.
 * A zero/negative span or any non-finite input has no meaningful axis: centre.
 */
export function timelineOffsetPct(t: number, firstT: number, lastT: number): number {
  if (!Number.isFinite(t) || !Number.isFinite(firstT) || !Number.isFinite(lastT)) return 50;
  const span = lastT - firstT;
  if (!(span > 0)) return 50;
  const axisStart = firstT - (span * AXIS_PADDING) / 2;
  const axisLength = span * (1 + AXIS_PADDING);
  const pct = ((t - axisStart) / axisLength) * 100;
  return Math.min(100, Math.max(0, pct));
}

interface DatedEntry {
  m: StoryTimelineMember;
  t: number;
}

/** One entry per source: its earliest effective article. Undated rows drop out. */
function earliestPerSource(
  members: readonly StoryTimelineMember[],
  seenAt: Readonly<Record<string, string>> | null,
): DatedEntry[] {
  const bySource = new Map<string, DatedEntry>();
  for (const m of members) {
    const t = effectiveTime(m, seenAt);
    if (t === null) continue;
    const prev = bySource.get(m.sourceId);
    if (!prev || t < prev.t) bySource.set(m.sourceId, { m, t });
  }
  return [...bySource.values()];
}

function byTimeThenName(a: DatedEntry, b: DatedEntry): number {
  return a.t - b.t || a.m.sourceName.localeCompare(b.m.sourceName, "tr");
}

function crossesIstanbulMidnight(firstT: number, lastT: number): boolean {
  return ISTANBUL_DAY.format(new Date(firstT)) !== ISTANBUL_DAY.format(new Date(lastT));
}

function firstMoverLabel(names: readonly string[]): string {
  if (names.length <= MAX_TIE_NAMES) return names.join(" ve ");
  const shown = names.slice(0, MAX_TIE_NAMES);
  return `${shown.join(", ")} ve ${names.length - MAX_TIE_NAMES} kaynak daha`;
}

/**
 * Builds the timeline, or `null` when fewer than
 * `STORY_TIMELINE_MIN_SOURCES` distinct VOTING sources carry a valid time.
 *
 * `members` must be voting members only. `seenAt` maps article id → the
 * article's `created_at` (when Tayf first saw it); it caps a source-supplied
 * future pubDate (CNN Türk runs ~2.84 h ahead) but never moves a point
 * later. `health` only explains an absent zone; null means unknown and
 * never marks anything degraded.
 *
 * `nonVoting` (toplayıcı / niş sources) are plotted as context only: they
 * widen the axis and appear in `points` with `voting: false`, but never
 * count toward the source floor, the first mover, a zone's join, absence,
 * the summary or `zoneFirsts` — an aggregator reposting first must not read
 * as a zone "joining". Clocks inside the summary / zone line follow the
 * VOTING span's midnight crossing (so a niche source can't rewrite them);
 * the point clocks follow the plotted axis's.
 */
export function buildStoryTimeline(
  members: readonly StoryTimelineMember[],
  seenAt: Readonly<Record<string, string>> | null,
  health: ZoneFeedHealth | null,
  nonVoting: readonly StoryTimelineMember[] = [],
): StoryTimeline | null {
  const votingOrdered = earliestPerSource(members, seenAt).sort(byTimeThenName);
  const votingFirst = votingOrdered[0];
  const votingLast = votingOrdered[votingOrdered.length - 1];
  if (votingOrdered.length < STORY_TIMELINE_MIN_SOURCES || !votingFirst || !votingLast) {
    return null;
  }
  const firstT = votingFirst.t;

  const nonVotingOrdered = earliestPerSource(nonVoting, seenAt).sort(byTimeThenName);
  const all = [
    ...votingOrdered.map((e) => ({ ...e, voting: true })),
    ...nonVotingOrdered.map((e) => ({ ...e, voting: false })),
  ].sort(byTimeThenName);
  const axisFirst = all[0] ?? votingFirst;
  const axisLast = all[all.length - 1] ?? votingLast;

  const votingCrossesMidnight = crossesIstanbulMidnight(firstT, votingLast.t);
  const axisCrossesMidnight = crossesIstanbulMidnight(axisFirst.t, axisLast.t);

  const points: StoryTimelinePoint[] = all.map(({ m, t, voting }) => ({
    sourceName: m.sourceName,
    zone: zoneOf(m.bias),
    t,
    clock: formatStoryClock(t, axisCrossesMidnight),
    offsetPct: timelineOffsetPct(t, axisFirst.t, axisLast.t),
    title: m.title,
    url: m.url,
    voting,
  }));

  // Everything below is voting-only: first mover, joins, ties, summary.
  const votingPoints = points.filter((p) => p.voting);
  const votingClock = (t: number) => formatStoryClock(t, votingCrossesMidnight);

  const zoneJoin: Record<MediaDnaZone, StoryZoneJoin | null> = {
    iktidar: null,
    bagimsiz: null,
    muhalefet: null,
  };
  const zoneFirsts: StoryZoneFirst[] = [];
  for (const p of votingPoints) {
    if (zoneJoin[p.zone]) continue;
    const lagMs = p.t - firstT;
    zoneJoin[p.zone] = { t: p.t, lagMs, lagMin: Math.floor(lagMs / 60_000) };
    zoneFirsts.push({
      zone: p.zone,
      label: ZONE_META[p.zone].label,
      clock: votingClock(p.t),
      lag:
        zoneFirsts.length === 0
          ? null
          : lagMs < STORY_TIE_MS
            ? "aynı dakikada"
            : `+${formatLag(lagMs)}`,
    });
  }
  const zoneLine = `İlk haber: ${zoneFirsts.map((z) => `${z.label} ${z.lag ?? z.clock}`).join(" · ")}`;

  // Absence is judged over every voting member passed in, dated or not: a
  // member whose times are both unparseable is still coverage, just not
  // placeable. Non-voting members are never coverage.
  const absentZones = missingZones(members);
  const degradedAbsentZones = absentZones.filter((z) => health?.[z].degraded === true);

  const tied = votingPoints.filter((p) => p.t - firstT < STORY_TIE_MS);
  const head = votingPoints[0];
  if (!head) return null; // unreachable: votingOrdered.length >= STORY_TIMELINE_MIN_SOURCES
  const first = {
    sourceName: head.sourceName,
    zone: head.zone,
    t: head.t,
    clock: votingClock(head.t),
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
    crossesMidnight: axisCrossesMidnight,
    summary: parts.join(" — "),
    zoneFirsts,
    zoneLine,
  };
}
