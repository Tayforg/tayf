import { zoneOf } from "@/lib/bias/config";
import type { BiasCategory, MediaDnaZone } from "@/types";

// Shared "zone line" formatting for the per-topic RSS feeds
// (src/app/rss/[topic]/route.ts) and the owned-channels auto-poster
// (src/lib/social/compose.ts). Both surfaces must describe the same
// cluster's source mix identically, so the tally + formatting live here
// once instead of being re-implemented per caller.

const ZONE_ORDER: readonly MediaDnaZone[] = [
  "iktidar",
  "bagimsiz",
  "muhalefet",
];

const ZONE_LABELS_TR: Record<MediaDnaZone, string> = {
  iktidar: "İktidar",
  bagimsiz: "Bağımsız",
  muhalefet: "Muhalefet",
};

/**
 * Tallies distinct sources into their Medya DNA zone. `sources` is assumed
 * to already be a distinct-per-source list (e.g. ClusterCardSource[] /
 * BlindspotBundle.sources) — this does not itself dedupe by id, it only
 * maps each entry's `bias` to a zone and counts it.
 */
export function zoneCountsFromSources(
  sources: ReadonlyArray<{ bias: BiasCategory }>,
): Record<MediaDnaZone, number> {
  const counts: Record<MediaDnaZone, number> = {
    iktidar: 0,
    bagimsiz: 0,
    muhalefet: 0,
  };
  for (const source of sources) {
    counts[zoneOf(source.bias)] += 1;
  }
  return counts;
}

/** 'İktidar {a} · Bağımsız {b} · Muhalefet {c}' */
export function formatZoneLine(counts: Record<MediaDnaZone, number>): string {
  return ZONE_ORDER.map((zone) => `${ZONE_LABELS_TR[zone]} ${counts[zone]}`).join(
    " · ",
  );
}
