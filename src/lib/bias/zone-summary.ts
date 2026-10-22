import { zoneOf } from "@/lib/bias/config";
import { roundPercents } from "@/lib/bias/round-percents";
import type { BiasDistribution, MediaDnaZone } from "@/types";

// Pure helpers for collapsing a cluster's 10-category `BiasDistribution`
// into the 3 Medya DNA zone counts, percentages, and dominant-zone calls.
// Extracted from `opengraph-image.tsx` (which needs it for the ribbon +
// chip math) and shared with `buildShareText` (src/lib/clusters/share.ts)
// so both consumers agree on the same rounding and tie-break rules.

const ZONE_ORDER: MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];

export function zoneCountsOf(
  distribution: BiasDistribution,
): Record<MediaDnaZone, number> {
  const counts: Record<MediaDnaZone, number> = {
    iktidar: 0,
    bagimsiz: 0,
    muhalefet: 0,
  };
  for (const [bias, count] of Object.entries(distribution)) {
    counts[zoneOf(bias as keyof BiasDistribution)] += count;
  }
  return counts;
}

/**
 * Integer percents that sum to exactly 100 when total > 0, via
 * largest-remainder rounding (Hamilton's method) -- see `roundPercents`.
 * Ties in the remainder are broken by `ZONE_ORDER`
 * (iktidar, bagimsiz, muhalefet), so the result is deterministic across
 * calls. All zeros when the total is 0.
 */
export function zonePercents(
  counts: Record<MediaDnaZone, number>,
): Record<MediaDnaZone, number> {
  const [iktidar = 0, bagimsiz = 0, muhalefet = 0] = roundPercents(
    ZONE_ORDER.map((zone) => counts[zone]),
  );
  return { iktidar, bagimsiz, muhalefet };
}
