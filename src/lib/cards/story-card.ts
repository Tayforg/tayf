import { zoneOf } from "@/lib/bias/config";
import type { ClusterDetailMember } from "@/lib/clusters/cluster-detail-query";
import {
  zoneYieldDenominator,
  type ZoneFeedHealth,
} from "@/lib/clusters/feed-health";
import { isGameEligibleTitle } from "@/lib/game/pii-filter";
import type { MediaDnaZone } from "@/types";

// Pure data selection for the U-02 "Manşet Kartı" share card
// (/cluster/[id]/kart). Deliberately has no Supabase/next/cache
// dependency of its own — the route handler fetches `ClusterDetail` (via
// `getClusterDetail`) and `ZoneFeedHealth` (via `getZoneFeedHealth`) and
// passes both in here, so this module stays trivially unit-testable and
// the two data-fetch concerns (member selection vs. feed health) stay
// decoupled.

const ZONES: readonly MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];

export interface StoryCardHeadline {
  zone: MediaDnaZone;
  outletName: string;
  title: string;
}

export interface StoryCardZoneCoverage {
  /** Total members in this zone, PII-filtered or not — real coverage for
   *  the share bar and the "N / M kaynak" count even when no single
   *  headline from the zone was eligible to display. */
  count: number;
  /** `zoneYieldDenominator(health, zone)` — null when health is unknown. */
  denominator: number | null;
  /** True when `health` was null, i.e. the denominator above is not a
   *  real number — callers must render the wording-without-numbers
   *  fallback rather than treat `denominator` as 0. */
  denominatorUnknown: boolean;
  /** `health[zone].degraded` — always false (fail-open) when health is
   *  unknown; missing data must never read as a degraded feed. */
  degraded: boolean;
}

export interface StoryCard {
  /** One headline per zone — the earliest-published member in that zone
   *  whose title clears the PII filter (`isGameEligibleTitle`), or `null`
   *  when the zone has no members, or every member's title was filtered. */
  headlines: Record<MediaDnaZone, StoryCardHeadline | null>;
  coverage: Record<MediaDnaZone, StoryCardZoneCoverage>;
}

function emptyCoverage(): StoryCardZoneCoverage {
  return {
    count: 0,
    denominator: null,
    denominatorUnknown: true,
    degraded: false,
  };
}

/**
 * Select the per-zone headline + coverage data the share card renders.
 *
 * `null` for an empty cluster (no members at all) — the route handler
 * must treat that the same as "unknown id" (404), not render an empty
 * card.
 */
export function selectStoryCard(
  members: ClusterDetailMember[],
  health: ZoneFeedHealth | null,
): StoryCard | null {
  if (members.length === 0) return null;

  const byZone: Record<MediaDnaZone, ClusterDetailMember[]> = {
    iktidar: [],
    bagimsiz: [],
    muhalefet: [],
  };
  for (const member of members) {
    byZone[zoneOf(member.source.bias)].push(member);
  }

  const headlines: Record<MediaDnaZone, StoryCardHeadline | null> = {
    iktidar: null,
    bagimsiz: null,
    muhalefet: null,
  };
  const coverage: Record<MediaDnaZone, StoryCardZoneCoverage> = {
    iktidar: emptyCoverage(),
    bagimsiz: emptyCoverage(),
    muhalefet: emptyCoverage(),
  };

  for (const zone of ZONES) {
    const zoneMembers = [...byZone[zone]].sort(
      (a, b) =>
        new Date(a.article.published_at).getTime() -
        new Date(b.article.published_at).getTime(),
    );

    const zoneCoverage = coverage[zone];
    zoneCoverage.count = zoneMembers.length;
    zoneCoverage.denominator = zoneYieldDenominator(health, zone);
    zoneCoverage.denominatorUnknown = health === null;
    zoneCoverage.degraded = health ? health[zone].degraded : false;

    // Earliest-first eligible headline — mirrors the "prefer the outlet
    // with the earliest publication in that zone" instruction, skipping
    // any title the PII filter would exclude (KVKK: false negatives here
    // are acceptable, missing a real private-individual name is not).
    const eligible = zoneMembers.find((member) =>
      isGameEligibleTitle(member.article.title),
    );
    if (eligible) {
      headlines[zone] = {
        zone,
        outletName: eligible.source.name,
        title: eligible.article.title,
      };
    }
  }

  return { headlines, coverage };
}
