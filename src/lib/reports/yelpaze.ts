// "Yelpaze Raporu" (fan/spectrum report) data assembly — pure, no JSX, no
// DOM. Builds the per-cluster admin report the founder prints/copies for a
// client (R-01 pilot). Every number here that could be misread as a
// coverage claim carries its denominator (or an explicit "unknown") right
// alongside it — see pack D's acceptance criteria: a share with no visible
// denominator must never be producible by this module.
//
// Everything below reuses existing, tested primitives instead of
// re-deriving cluster/zone/ownership logic:
//   - getClusterDetail()      @/lib/clusters/cluster-detail-query
//   - groupMembersByZone()    @/lib/clusters/framing
//   - zoneOf() / zoneCountsOf() @/lib/bias/config, @/lib/bias/zone-summary
//   - getZoneFeedHealth() / shouldSuppressBlindspot() / degradedSilentZone()
//                             @/lib/clusters/feed-health
//   - wireSignalOf()          @/lib/clusters/wire
//   - partitionByVote()       @/lib/sources/kind
//   - groupByOwner()          @/lib/sources/ownership

import { zoneOf } from "@/lib/bias/config";
import { zoneCountsOf } from "@/lib/bias/zone-summary";
import type {
  ClusterDetail,
  ClusterDetailMember,
} from "@/lib/clusters/cluster-detail-query";
import { getClusterDetail } from "@/lib/clusters/cluster-detail-query";
import {
  degradedSilentZone,
  getZoneFeedHealth,
  zoneYieldDenominator,
  type ZoneFeedHealth,
  type ZoneHealth,
} from "@/lib/clusters/feed-health";
import type { MembersByZone } from "@/lib/clusters/framing";
import { groupMembersByZone } from "@/lib/clusters/framing";
import { wireSignalOf, type WireSignal } from "@/lib/clusters/wire";
import { partitionByVote } from "@/lib/sources/kind";
import { groupByOwner } from "@/lib/sources/ownership";
import type { BiasCategory, BiasDistribution, MediaDnaZone, Source } from "@/types";

const ZONE_ORDER: MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];

// Lowercase Turkish zone names for mid-sentence use (mirrors
// src/lib/clusters/share.ts's own ZONE_LABEL_LOWER — kept local here since
// it's a 3-entry table and share.ts's copy isn't exported).
const ZONE_LABEL_TR: Record<MediaDnaZone, string> = {
  iktidar: "iktidar",
  bagimsiz: "bağımsız",
  muhalefet: "muhalefet",
};

// ---------------------------------------------------------------------------
// Section 01 — coverage
// ---------------------------------------------------------------------------

export interface CoverageZoneRow {
  zone: MediaDnaZone;
  /** Distinct outlets covering this zone for this cluster. */
  outlets: number;
  /** null when the denominator itself is unknown OR is a knowable zero
   *  (division would be meaningless either way — never printed as a share). */
  denominator: number | null;
  /** Raw fraction (outlets / denominator), unrounded. null unless both
   *  outlets and a positive denominator are known AND outlets <=
   *  denominator (see denominatorBelowOutlets below — the two counts come
   *  from different populations and can disagree). */
  share: number | null;
  denominatorKnown: boolean;
  /** true when the denominator is known but smaller than the outlet count
   *  — the numerator (covering outlets, any time in the cluster's life)
   *  and the denominator (currently-healthy feeds) are different
   *  populations, so a share here would read as a nonsensical >100%. When
   *  true, `share` is always null; render the raw counts with a basis
   *  note instead of a percentage. */
  denominatorBelowOutlets: boolean;
}

export interface CoverageSection {
  rows: CoverageZoneRow[];
  // Resolved (pack A merge): the denominator is `zoneYieldDenominator()`
  // (src/lib/clusters/feed-health.ts) — active, RSS-backed sources that
  // actually DELIVERED into the trailing yield window, the honest
  // denominator per D's pack.md — rather than the status-only `healthy`
  // count this branch used before pack A landed. Note: pack A's
  // /kaynaklar/durum page (linked from the coverage section's basis
  // footnote in yelpaze-report.tsx) doesn't exist on this branch yet —
  // that link currently points at /sources instead; out of this pack's
  // scope to restore (see must-fix-merge.md item 4).
  denominatorBasis: "status" | "yield" | null;
}

function buildCoverageSection(
  byZone: MembersByZone,
  health: ZoneFeedHealth | null,
): CoverageSection {
  const rows: CoverageZoneRow[] = ZONE_ORDER.map((zone) => {
    const outlets = byZone[zone].length;
    const denominator = zoneYieldDenominator(health, zone);
    const denominatorKnown = denominator !== null;
    // The numerator (covering outlets over the cluster's lifetime) and the
    // denominator (currently-delivering feeds) are different populations —
    // an outlet that covered the story yesterday and stopped delivering an
    // hour ago counts in the numerator but not the denominator. Never
    // print a share when that leaves outlets > denominator (it would read
    // as >100%).
    const denominatorBelowOutlets =
      denominatorKnown && denominator !== null && outlets > denominator;
    // A zero denominator can be NAMED but not divided by — treat it the
    // same as "no share" rather than emitting Infinity/NaN.
    const share =
      denominatorKnown &&
      denominator! > 0 &&
      !denominatorBelowOutlets
        ? outlets / denominator!
        : null;
    return { zone, outlets, denominator, share, denominatorKnown, denominatorBelowOutlets };
  });
  return { rows, denominatorBasis: health ? "yield" : null };
}

// ---------------------------------------------------------------------------
// Section 02 — framing pairs
// ---------------------------------------------------------------------------

export interface FramingArticleRef {
  outlet: string;
  title: string;
  publishedAt: string;
  url: string;
}

export interface FramingZonePair {
  zone: MediaDnaZone;
  first: FramingArticleRef;
  last: FramingArticleRef | null;
}

function toFramingRef(member: ClusterDetailMember): FramingArticleRef {
  // Headline + outlet name + timestamp + the article's own link ONLY.
  // Never thread `article.description` / `article.image_url` through here
  // — reproducing excerpts is the KVKK data-controller risk this whole
  // pack exists to avoid (see pack.md's Board Decision 2021/989 note).
  return {
    outlet: member.source.name,
    title: member.article.title,
    publishedAt: member.article.published_at,
    url: member.article.url,
  };
}

function buildFramingPairs(byZone: MembersByZone): FramingZonePair[] {
  const pairs: FramingZonePair[] = [];
  for (const zone of ZONE_ORDER) {
    const members = byZone[zone];
    if (members.length === 0) continue; // nothing to pair — zone not covered.

    // groupMembersByZone sorts newest-first for display; framing pairs need
    // chronological order (first/last by published_at), so re-sort here.
    const ascending = [...members].sort(
      (a, b) =>
        new Date(a.article.published_at).getTime() -
        new Date(b.article.published_at).getTime(),
    );

    // `members.length === 0` was already excluded above, so index 0 exists;
    // `noUncheckedIndexedAccess` still types it as possibly-undefined.
    const first = toFramingRef(ascending[0]!);
    // A single-article zone gets a null second half rather than a
    // fabricated pair (D1.md section 02).
    const last =
      ascending.length > 1 ? toFramingRef(ascending[ascending.length - 1]!) : null;
    pairs.push({ zone, first, last });
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Section 03 — blindspot
// ---------------------------------------------------------------------------

export type BlindspotHealthStatus =
  | "none" // no blindspot claim at all
  | "suppressed" // claim withdrawn — silent pole's feeds are degraded
  | "healthy" // claim stands — silent pole's feeds are fine
  | "degraded" // claim stands but silent pole is ALSO degraded (defensive;
  // should be unreachable since getClusterDetail suppresses this case, but
  // this module never assumes an upstream invariant it can't verify)
  | "unknown"; // claim stands but the silent pole's feed health is unknown

export interface BlindspotSection {
  isBlindspot: boolean;
  blindspotSide: BiasCategory | null;
  /** The zone that covered the story (derived from blindspotSide, or —
   *  when the claim was suppressed and blindspotSide was nulled — recomputed
   *  from the still-intact bias_distribution). */
  dominantZone: MediaDnaZone | null;
  blindspotSuppressed: boolean;
  /** The pole zone (iktidar/muhalefet) whose silence the claim rests on.
   *  null when there is no claim, or the dominant zone is bagimsiz (no
   *  single opposite pole — see poleOppositeOf below). */
  silentZone: MediaDnaZone | null;
  healthStatus: BlindspotHealthStatus;
  /** Lowercase Turkish sentence FRAGMENT (no leading capital, no trailing
   *  period) describing the feed-health basis for the claim above — written
   *  so the renderer/markdown can splice it into the SAME sentence as the
   *  claim itself. "" when healthStatus is "none". */
  caveat: string;
}

// Only iktidar/muhalefet are meaningful "opposite poles" for a blindspot's
// silent side (mirrors feed-health.ts's own POLE_ZONES comment). bagimsiz
// has no single opposite pole.
function poleOppositeOf(zone: MediaDnaZone): MediaDnaZone | null {
  if (zone === "iktidar") return "muhalefet";
  if (zone === "muhalefet") return "iktidar";
  return null;
}

// Mirrors cluster-detail-query.ts's private `dominantZoneOf` — that module
// doesn't export it, and we need the ORIGINAL dominant zone even after
// suppression has nulled `blindspot_side` on the detail we were handed.
function dominantZoneOfDistribution(
  distribution: BiasDistribution,
): MediaDnaZone | null {
  const counts = zoneCountsOf(distribution);
  let best: MediaDnaZone | null = null;
  for (const zone of ZONE_ORDER) {
    if (counts[zone] > 0 && (best === null || counts[zone] > counts[best])) {
      best = zone;
    }
  }
  return best;
}

function formatHealthFragment(zone: MediaDnaZone, stats: ZoneHealth): string {
  const pct = Math.round(stats.healthyShare * 100);
  const label = stats.degraded ? "düşük" : "yeterli";
  return `${ZONE_LABEL_TR[zone]} kanadının feed sağlığı ${label} (${stats.healthy}/${stats.total} sağlıklı, %${pct})`;
}

const NO_BLINDSPOT_SECTION: BlindspotSection = {
  isBlindspot: false,
  blindspotSide: null,
  dominantZone: null,
  blindspotSuppressed: false,
  silentZone: null,
  healthStatus: "none",
  caveat: "",
};

function buildBlindspotSection(
  detail: ClusterDetail,
  health: ZoneFeedHealth | null,
): BlindspotSection {
  const { cluster, blindspotSuppressed } = detail;
  const isBlindspot = cluster.is_blindspot;
  const blindspotSide = cluster.blindspot_side;

  if (!isBlindspot && !blindspotSuppressed) {
    return NO_BLINDSPOT_SECTION;
  }

  const dominantZone: MediaDnaZone | null =
    isBlindspot && blindspotSide
      ? zoneOf(blindspotSide)
      : dominantZoneOfDistribution(cluster.bias_distribution);

  const silentZoneFromHealth =
    dominantZone && health ? degradedSilentZone(dominantZone, health) : null;
  const silentZone =
    silentZoneFromHealth ?? (dominantZone ? poleOppositeOf(dominantZone) : null);

  if (blindspotSuppressed) {
    const stats = silentZone && health ? health[silentZone] : null;
    return {
      isBlindspot: false,
      blindspotSide: null,
      dominantZone,
      blindspotSuppressed: true,
      silentZone,
      healthStatus: "suppressed",
      caveat: stats
        ? formatHealthFragment(silentZone!, stats)
        : "sessiz kalan kanadın feed sağlığı düşük",
    };
  }

  // isBlindspot true, unsuppressed.
  if (!silentZone) {
    // dominantZone is bagimsiz (or unknown) — no single pole to name.
    return {
      isBlindspot: true,
      blindspotSide,
      dominantZone,
      blindspotSuppressed: false,
      silentZone: null,
      healthStatus: "unknown",
      caveat:
        "baskın taraf bağımsız kaynaklar olduğu için iktidar ve muhalefet kanatlarının feed sağlığı ayrı ayrı değerlendirilmelidir",
    };
  }

  const stats = health ? health[silentZone] : null;
  if (!stats) {
    return {
      isBlindspot: true,
      blindspotSide,
      dominantZone,
      blindspotSuppressed: false,
      silentZone,
      healthStatus: "unknown",
      caveat: `${ZONE_LABEL_TR[silentZone]} kanadının feed sağlığı bilinmiyor, bu iddia doğrulanmadan gösteriliyor`,
    };
  }

  return {
    isBlindspot: true,
    blindspotSide,
    dominantZone,
    blindspotSuppressed: false,
    silentZone,
    healthStatus: stats.degraded ? "degraded" : "healthy",
    caveat: formatHealthFragment(silentZone, stats),
  };
}

// ---------------------------------------------------------------------------
// Section 04 — timeline
// ---------------------------------------------------------------------------

export interface ZoneTimelineRow {
  zone: MediaDnaZone;
  /** null when the zone has no covering members. */
  firstPublishedAt: string | null;
  /** Milliseconds after the cluster's overall first_published. null when
   *  the zone has no members, or either timestamp is unparseable. */
  lagMs: number | null;
  /** Wire-vs-independent signal computed over just this zone's members. */
  wire: WireSignal;
}

export interface TimelineSection {
  clusterFirstPublished: string;
  zones: ZoneTimelineRow[];
  /** Cluster-wide wire signal — reused verbatim from getClusterDetail
   *  (already computed there via wireSignalOf; not recomputed here). */
  overallWire: WireSignal;
  /** Members whose source kind votes in bias_distribution (outlet/wire). */
  votingCount: number;
  /** Members whose source kind does not vote (aggregator/niche). */
  nonVotingCount: number;
}

function buildTimelineSection(
  detail: ClusterDetail,
  byZone: MembersByZone,
): TimelineSection {
  const clusterFirstMs = new Date(detail.cluster.first_published).getTime();

  const zones: ZoneTimelineRow[] = ZONE_ORDER.map((zone) => {
    const members = byZone[zone];
    if (members.length === 0) {
      return {
        zone,
        firstPublishedAt: null,
        lagMs: null,
        wire: wireSignalOf([]),
      };
    }

    const ascending = [...members].sort(
      (a, b) =>
        new Date(a.article.published_at).getTime() -
        new Date(b.article.published_at).getTime(),
    );
    // `members.length === 0` returned above, so index 0 exists.
    const firstPublishedAt = ascending[0]!.article.published_at;
    const firstMs = new Date(firstPublishedAt).getTime();
    const lagMs =
      Number.isNaN(firstMs) || Number.isNaN(clusterFirstMs)
        ? null
        : firstMs - clusterFirstMs;

    const wire = wireSignalOf(
      members.map((m) => ({ id: m.article.id, content_hash: m.article.content_hash })),
    );

    return { zone, firstPublishedAt, lagMs, wire };
  });

  const { voting, nonVoting } = partitionByVote(detail.members);

  return {
    clusterFirstPublished: detail.cluster.first_published,
    zones,
    overallWire: detail.wire,
    votingCount: voting.length,
    nonVotingCount: nonVoting.length,
  };
}

// ---------------------------------------------------------------------------
// Section 05 — ownership
// ---------------------------------------------------------------------------

export interface OwnershipGroupRow {
  ownerGroup: string;
  label: string;
  sourceNames: string[];
}

/** One trusteed (kayyum) source — slug + display name + the DB's
 *  `trustee_since` date (ISO yyyy-mm-dd), verbatim, no note text (the
 *  note is a citation for the operator, not something to print here). */
export interface TrusteedSourceRow {
  slug: string;
  name: string;
  since: string;
}

export interface OwnershipSection {
  groups: OwnershipGroupRow[];
  taggedSourceCount: number;
  totalSourceCount: number;
  /** Raw fraction, unrounded — never round a partial tagging up into a
   *  coverage claim (pack.md acceptance criteria). */
  taggedShare: number;
  dominant: { label: string; sourceCount: number } | null;
  // Resolved (pack B merge): `sources.trustee_since` / `trustee_note`
  // (migration 055) are live DB columns, listed here as `trusteedSources`
  // (deduped by slug, only sources with a set `trustee_since`). Note:
  // cluster-detail-query.ts's member-embed select and the shared `Source`
  // type (src/types/index.ts) don't carry these two columns yet — both
  // are outside this pack's scope (must-fix-merge.md item 4) — so
  // `buildOwnershipSection` below reads them defensively as optional and
  // this list degrades to empty (never throws) until that select lands.
  // The field itself is optional (rather than required) on this interface
  // so pre-existing `OwnershipSection` literals elsewhere in the repo
  // (fixtures that predate this pack) keep compiling; every reader treats
  // an absent field the same as an empty list.
  trusteedSources?: TrusteedSourceRow[];
}

/** Local, optional-field widening of the shared `Source` type — see the
 *  `trusteedSources` doc comment above for why these two columns aren't
 *  on `Source` itself yet. */
type SourceWithTrustee = Source & {
  trustee_since?: string | null;
  trustee_note?: string | null;
};

// Exported (only for yelpaze.test.ts): cluster-detail-query.ts rebuilds
// `ClusterDetailMember.source` field-by-field and doesn't copy through
// `trustee_since` / `trustee_note` (out of this pack's scope — see the
// `trusteedSources` doc comment above), so a trusteed source can never
// reach this function via the full `buildYelpazeReport` pipeline in a
// test built on the supabase fake. Exporting lets the trustee-flag test
// exercise this function directly with a hand-built member array instead.
export function buildOwnershipSection(members: ClusterDetailMember[]): OwnershipSection {
  const sources = members.map((m) => m.source);
  const summary = groupByOwner(sources);

  const bySlug = new Map<string, SourceWithTrustee>();
  for (const source of sources as SourceWithTrustee[]) {
    if (!bySlug.has(source.slug)) bySlug.set(source.slug, source);
  }
  const trusteedSources: TrusteedSourceRow[] = [...bySlug.values()]
    .filter((s): s is SourceWithTrustee & { trustee_since: string } =>
      typeof s.trustee_since === "string" && s.trustee_since.length > 0,
    )
    .map((s) => ({ slug: s.slug, name: s.name, since: s.trustee_since }))
    .sort((a, b) => a.name.localeCompare(b.name, "tr"));

  return {
    groups: summary.groups.map((g) => ({
      ownerGroup: g.ownerGroup,
      label: g.label,
      sourceNames: g.sources.map((s) => s.name),
    })),
    taggedSourceCount: summary.taggedSourceCount,
    totalSourceCount: summary.totalSourceCount,
    taggedShare: summary.taggedShare,
    dominant: summary.dominant
      ? { label: summary.dominant.label, sourceCount: summary.dominant.sources.length }
      : null,
    trusteedSources,
  };
}

// ---------------------------------------------------------------------------
// Header + top-level assembly
// ---------------------------------------------------------------------------

export interface ReportHeader {
  clusterId: string;
  title: string;
  // Deliberately carries NOTHING else. `summary` used to hold
  // `clusters.summary_tr` — the seed article's raw RSS description (see
  // src/lib/clusters/summary-attribution.ts) — which every other surface
  // routes through the BL-13 `resolveSummaryAttribution()` gate before
  // display. This object is handed to a "use client" component and
  // serialized into the RSC flight payload verbatim (visible in
  // view-source), so it must never carry a field that hasn't been
  // gated. `firstPublished` / `updatedAt` / `articleCount` / `isArchived`
  // were also removed: nothing in markdown.ts or yelpaze-report.tsx reads
  // them (grep confirms zero hits) — only print what the report actually
  // uses.
}

export interface YelpazeReport {
  header: ReportHeader;
  coverage: CoverageSection;
  framing: FramingZonePair[];
  blindspot: BlindspotSection;
  timeline: TimelineSection;
  ownership: OwnershipSection;
  generatedAt: string;
}

/**
 * Assembles the full "Yelpaze Raporu" for a cluster. Returns null when the
 * cluster does not exist (mirrors getClusterDetail's own not-found contract
 * so the page can call notFound()).
 */
export async function buildYelpazeReport(
  clusterId: string,
): Promise<YelpazeReport | null> {
  const detail = await getClusterDetail(clusterId);
  if (!detail) return null;

  // Single fetch, reused for both the coverage denominator (section 01) and
  // the blindspot feed-health caveat (section 03) — one honest source of
  // truth per render instead of two independently-timed reads.
  const health = await getZoneFeedHealth();
  const byZone = groupMembersByZone(detail.members);

  return {
    header: {
      clusterId: detail.cluster.id,
      title: detail.cluster.title_tr,
    },
    coverage: buildCoverageSection(byZone, health),
    framing: buildFramingPairs(byZone),
    blindspot: buildBlindspotSection(detail, health),
    timeline: buildTimelineSection(detail, byZone),
    ownership: buildOwnershipSection(detail.members),
    generatedAt: new Date().toISOString(),
  };
}
