import { zoneOf } from "@/lib/bias/config";
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
 * largest-remainder rounding (Hamilton's method): floor each zone's exact
 * share, then hand out the leftover percentage points one at a time to
 * the zones with the largest fractional remainder. Ties in the remainder
 * are broken by `ZONE_ORDER` (stable sort keeps iktidar/bagimsiz/muhalefet
 * order), so the result is deterministic across calls. All zeros when the
 * total is 0.
 */
export function zonePercents(
  counts: Record<MediaDnaZone, number>,
): Record<MediaDnaZone, number> {
  const percents: Record<MediaDnaZone, number> = {
    iktidar: 0,
    bagimsiz: 0,
    muhalefet: 0,
  };

  const total = counts.iktidar + counts.bagimsiz + counts.muhalefet;
  if (total <= 0) return percents;

  const shares = ZONE_ORDER.map((zone) => {
    const scaled = counts[zone] * 100;
    return {
      zone,
      floor: Math.floor(scaled / total),
      remainder: scaled % total,
    };
  });

  let assigned = 0;
  for (const { zone, floor } of shares) {
    percents[zone] = floor;
    assigned += floor;
  }

  // 100 - assigned is always a small non-negative integer (< ZONE_ORDER.length)
  // since we only floored fractional shares of a total that sums to 100%.
  let remaining = 100 - assigned;
  for (const { zone } of [...shares].sort((a, b) => b.remainder - a.remainder)) {
    if (remaining <= 0) break;
    percents[zone] += 1;
    remaining -= 1;
  }

  return percents;
}

/**
 * The zone with the most members. Ties resolve in `ZONE_ORDER` (iktidar,
 * bagimsiz, muhalefet — first strictly-greater wins). Null when every
 * zone is empty.
 */
export function dominantZone(
  counts: Record<MediaDnaZone, number>,
): MediaDnaZone | null {
  let best: MediaDnaZone | null = null;
  let bestCount = 0;
  for (const zone of ZONE_ORDER) {
    if (counts[zone] > bestCount) {
      best = zone;
      bestCount = counts[zone];
    }
  }
  return best;
}
