import { tallyZones } from "@/lib/bias/config";
import type { ClusterBundle } from "@/lib/clusters/politics-query";
import { DIET_ZONES, type DietZone } from "./diet";

// Multi-source floor: a bundle whose tallyZones() total is below this many
// voting members isn't "multiple outlets reported this" and is excluded
// from every zone's suggestion list regardless of its zone split.
const MULTI_SOURCE_MIN = 3;
// Cap per zone.
const PER_ZONE_LIMIT = 3;
// First pass requires this many votes IN the target zone (a real presence,
// not one stray vote); the fill pass relaxes to >= 1.
const STRONG_ZONE_MIN = 2;

export interface DietSuggestion {
  id: string;
  title: string;
  zoneCount: number;
  totalCount: number;
}

export type ZoneSuggestions = Record<DietZone, DietSuggestion[]>;

function emptyZoneSuggestions(): ZoneSuggestions {
  return { iktidar: [], bagimsiz: [], muhalefet: [] };
}

interface RankedBundle {
  bundle: ClusterBundle;
  rank: number;
  counts: Record<DietZone, number>;
  total: number;
}

/**
 * Builds, for each zone, up to PER_ZONE_LIMIT suggested clusters from the
 * least-read zone's perspective: multi-source stories (>=3 voting members)
 * where that zone has a meaningful presence.
 *
 * Ranking within a zone:
 *   1. Bundles with `counts[z] >= STRONG_ZONE_MIN`, sorted by the zone's
 *      SHARE of the vote (counts[z]/total) descending, ties broken by
 *      input order (home-page rank).
 *   2. If still short of PER_ZONE_LIMIT, fill with `counts[z] >= 1`
 *      bundles (not already picked) in input order.
 * No duplicates within a zone's list.
 */
export function pickZoneSuggestions(bundles: readonly ClusterBundle[]): ZoneSuggestions {
  const ranked: RankedBundle[] = [];
  bundles.forEach((bundle, rank) => {
    const tally = tallyZones(bundle.cluster.bias_distribution);
    if (tally.total < MULTI_SOURCE_MIN) return;
    ranked.push({
      bundle,
      rank,
      counts: tally.counts,
      total: tally.total,
    });
  });

  const result = emptyZoneSuggestions();

  for (const zone of DIET_ZONES) {
    const picked: RankedBundle[] = [];
    const pickedIds = new Set<string>();

    const strong = ranked
      .filter((r) => r.counts[zone] >= STRONG_ZONE_MIN)
      .sort((a, b) => {
        const shareA = a.counts[zone] / a.total;
        const shareB = b.counts[zone] / b.total;
        if (shareB !== shareA) return shareB - shareA;
        return a.rank - b.rank;
      });
    for (const r of strong) {
      if (picked.length >= PER_ZONE_LIMIT) break;
      picked.push(r);
      pickedIds.add(r.bundle.cluster.id);
    }

    if (picked.length < PER_ZONE_LIMIT) {
      const fill = ranked
        .filter((r) => r.counts[zone] >= 1 && !pickedIds.has(r.bundle.cluster.id))
        .sort((a, b) => a.rank - b.rank);
      for (const r of fill) {
        if (picked.length >= PER_ZONE_LIMIT) break;
        picked.push(r);
        pickedIds.add(r.bundle.cluster.id);
      }
    }

    result[zone] = picked.map((r) => ({
      id: r.bundle.cluster.id,
      title: r.bundle.cluster.title_tr,
      zoneCount: r.counts[zone],
      totalCount: r.total,
    }));
  }

  return result;
}
