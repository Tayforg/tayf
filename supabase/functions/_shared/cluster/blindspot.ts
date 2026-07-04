// Zone-based blindspot detection for the DB-level `clusters.is_blindspot`
// flag (rendered as the "Kör nokta" badge on homepage cards).
//
// Replaces the old rule — "exactly one of the 10 bias categories is
// non-zero" — which was broken on both axes:
//   * over-sensitive: fired with no minimum source count, so a 1-2 source
//     cluster got the badge (at that N, one-sided coverage is sampling
//     noise, not a coverage gap);
//   * under-sensitive: counted raw categories, so pro_government +
//     gov_leaning + state_media (100% iktidar zone) was NOT flagged even
//     though every other surface in the app calls that a blindspot.
//
// The new rule matches the /blindspots page semantics: every participating
// source falls in a single Medya DNA zone AND there are at least
// MIN_BLINDSPOT_SOURCES distinct sources. The consumer's duplicate-source
// guard ensures one article per source, so the distribution total IS the
// distinct-source count.

export const BIAS_KEYS = [
  "pro_government", "gov_leaning", "state_media", "center",
  "opposition_leaning", "opposition", "nationalist",
  "islamist_conservative", "pro_kurdish", "international",
] as const;
export type BiasKey = (typeof BIAS_KEYS)[number];

export type MediaDnaZone = "iktidar" | "bagimsiz" | "muhalefet";

// MUST mirror BIAS_TO_ZONE in src/lib/bias/config.ts (the Next.js side) —
// including the A6 rezoning of nationalist → iktidar (MHP is a Cumhur
// İttifakı ally). If the app-side map changes, change this one too.
export const BIAS_TO_ZONE: Record<BiasKey, MediaDnaZone> = {
  pro_government: "iktidar",
  gov_leaning: "iktidar",
  state_media: "iktidar",
  islamist_conservative: "iktidar",
  nationalist: "iktidar",
  center: "bagimsiz",
  international: "bagimsiz",
  pro_kurdish: "bagimsiz",
  opposition_leaning: "muhalefet",
  opposition: "muhalefet",
};

// Below 5 distinct sources, "the other side ignored it" is indistinguishable
// from "the story is too small for anyone to have picked up yet". Matches
// the floor the /blindspots page and the cross-spectrum detector use.
export const MIN_BLINDSPOT_SOURCES = 5;

export interface BlindspotResult {
  is_blindspot: boolean;
  // Kept as a bias *category* (not a zone) for schema/UI compatibility:
  // the dominant category within the flagged zone.
  blindspot_side: BiasKey | null;
}

export function detectBlindspot(
  dist: Record<BiasKey, number>,
): BlindspotResult {
  let total = 0;
  const zoneCounts: Record<MediaDnaZone, number> = {
    iktidar: 0,
    bagimsiz: 0,
    muhalefet: 0,
  };
  let dominantCategory: BiasKey | null = null;
  let dominantCount = 0;

  for (const key of BIAS_KEYS) {
    const n = dist[key] ?? 0;
    if (n <= 0) continue;
    total += n;
    zoneCounts[BIAS_TO_ZONE[key]] += n;
    if (n > dominantCount) {
      dominantCount = n;
      dominantCategory = key;
    }
  }

  if (total < MIN_BLINDSPOT_SOURCES) {
    return { is_blindspot: false, blindspot_side: null };
  }

  const activeZones = (
    Object.values(zoneCounts) as number[]
  ).filter((n) => n > 0).length;
  if (activeZones !== 1) {
    return { is_blindspot: false, blindspot_side: null };
  }

  // Single zone at/above the floor: dominantCategory is by construction a
  // member of that zone (it's the largest bucket and all buckets share it).
  return { is_blindspot: true, blindspot_side: dominantCategory };
}
