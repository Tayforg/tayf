// The bias-zone contract: the one place that defines the Medya DNA zone
// map and the two editorial rules built on it (blindspot, cross-spectrum
// surprise).
//
// Consumers:
//   * Deno: cluster-consumer imports this file directly (relative .ts).
//   * Next: src/lib/bias/config.ts re-exports BIAS_TO_ZONE / BLINDSPOT /
//     SURPRISE, so every page, card and share surface reads the same values.
//   * SQL: migrations 023 (trends view) and 032 (blindspot recompute) carry a
//     hand-written copy of the zone CASE and the thresholds;
//     tests/migrations/zone-parity.test.ts fails if they drift from here.
//
// Keep this module dependency-free — it has to compile under tsc (Next,
// vitest) and deno with no import map.

export const BIAS_KEYS = [
  "pro_government", "gov_leaning", "state_media", "center",
  "opposition_leaning", "opposition", "nationalist",
  "islamist_conservative", "pro_kurdish", "international",
] as const;
export type BiasKey = (typeof BIAS_KEYS)[number];

export const ZONE_KEYS = ["iktidar", "bagimsiz", "muhalefet"] as const;
export type MediaDnaZone = (typeof ZONE_KEYS)[number];

// nationalist → iktidar per the A6 finding: MHP is a Cumhur İttifakı ally,
// so nationalist outlets covering MHP positively are not a cross-spectrum
// surprise.
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

export function zoneOfKey(key: BiasKey): MediaDnaZone {
  return BIAS_TO_ZONE[key];
}

// Blindspot ("kör nokta"): one zone owns at least `dominantShare` of the
// participating sources, and there are at least `minSources` of them.
//
// Measured on production, 2026-08-22 → 2026-09-05 (540 clusters, 230 with
// ≥5 distinct sources): a strict single-zone rule flagged 2 clusters in 14
// days; ≥80% flagged 22. Below 5 sources "the other side ignored it" is
// indistinguishable from "nobody has picked it up yet". `feedDelayHours` is
// how long /blindspots waits for the absent side before listing a story;
// the DB flag itself is immediate.
export const BLINDSPOT = {
  minSources: 5,
  dominantShare: 0.8,
  feedDelayHours: 24,
} as const;

// Cross-spectrum surprise: an outlet from the OPPOSITE zone showing up on a
// story one zone dominates. A6 raised the share from 0.45 to 0.65 and added
// the size and margin guards; at 0.55 the detector fires on twice as many
// clusters, almost all of them 55–64% majority splits rather than real
// surprises (same 14-day measurement: 98 firings at 0.55 vs 48 at 0.65).
export const SURPRISE = {
  dominantShare: 0.65,
  minSources: 5,
  minMargin: 3,
} as const;

export const MIN_BLINDSPOT_SOURCES = BLINDSPOT.minSources;

export interface ZoneTally {
  counts: Record<MediaDnaZone, number>;
  total: number;
  dominantZone: MediaDnaZone | null;
  dominantShare: number;
  // Largest category inside the dominant zone; ties break by BIAS_KEYS order.
  dominantCategory: BiasKey | null;
}

export function tallyZones(
  dist: Partial<Record<BiasKey, number>>,
): ZoneTally {
  const counts: Record<MediaDnaZone, number> = {
    iktidar: 0,
    bagimsiz: 0,
    muhalefet: 0,
  };
  let total = 0;
  for (const key of BIAS_KEYS) {
    const n = dist[key] ?? 0;
    if (n <= 0) continue;
    total += n;
    counts[BIAS_TO_ZONE[key]] += n;
  }

  let dominantZone: MediaDnaZone | null = null;
  for (const zone of ZONE_KEYS) {
    if (counts[zone] > 0 && (dominantZone === null || counts[zone] > counts[dominantZone])) {
      dominantZone = zone;
    }
  }

  let dominantCategory: BiasKey | null = null;
  if (dominantZone) {
    let best = 0;
    for (const key of BIAS_KEYS) {
      const n = dist[key] ?? 0;
      if (BIAS_TO_ZONE[key] === dominantZone && n > best) {
        best = n;
        dominantCategory = key;
      }
    }
  }

  return {
    counts,
    total,
    dominantZone,
    dominantShare: dominantZone && total > 0 ? counts[dominantZone] / total : 0,
    dominantCategory,
  };
}

export interface BlindspotResult {
  is_blindspot: boolean;
  // Kept as a bias *category* (not a zone) for schema/UI compatibility.
  blindspot_side: BiasKey | null;
}

export function detectBlindspot(
  dist: Partial<Record<BiasKey, number>>,
): BlindspotResult {
  const tally = tallyZones(dist);
  if (
    tally.total < BLINDSPOT.minSources ||
    tally.dominantZone === null ||
    tally.dominantShare < BLINDSPOT.dominantShare
  ) {
    return { is_blindspot: false, blindspot_side: null };
  }
  return { is_blindspot: true, blindspot_side: tally.dominantCategory };
}
