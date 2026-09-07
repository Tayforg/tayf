// scripts/lib/cluster/blindspot.mjs
//
// Plain-JS mirror of supabase/functions/_shared/cluster/blindspot.ts — the
// bias-zone contract (Medya DNA zone map + the blindspot rule built on top
// of it). Ported so scripts/audit-clusters.mjs's blindspot_flip_rate probe
// can call detectBlindspot() outside the Deno/Next runtimes.
//
// Keep in sync with the .ts original by hand — blindspot.test.mjs asserts
// parity against it directly (imports the .ts module and cross-checks
// BIAS_TO_ZONE / tallyZones / detectBlindspot on shared fixtures).

export const BIAS_KEYS = [
  "pro_government", "gov_leaning", "state_media", "center",
  "opposition_leaning", "opposition", "nationalist",
  "islamist_conservative", "pro_kurdish", "international",
];

export const ZONE_KEYS = ["iktidar", "bagimsiz", "muhalefet"];

// nationalist → iktidar per the A6 finding: MHP is a Cumhur İttifakı ally,
// so nationalist outlets covering MHP positively are not a cross-spectrum
// surprise.
export const BIAS_TO_ZONE = {
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

export function zoneOfKey(key) {
  return BIAS_TO_ZONE[key];
}

// Blindspot ("kör nokta"): one zone owns at least `dominantShare` of the
// participating sources, and there are at least `minSources` of them. See
// the .ts original for the production measurement behind these numbers.
export const BLINDSPOT = {
  minSources: 5,
  dominantShare: 0.8,
  feedDelayHours: 24,
};

// Cross-spectrum surprise — not used by the audit script today, but kept
// alongside BLINDSPOT so this file stays a complete mirror of the .ts
// contract rather than a partial one that silently drops fields.
export const SURPRISE = {
  dominantShare: 0.65,
  minSources: 5,
  minMargin: 3,
};

export const MIN_BLINDSPOT_SOURCES = BLINDSPOT.minSources;

export function tallyZones(dist) {
  const counts = { iktidar: 0, bagimsiz: 0, muhalefet: 0 };
  let total = 0;
  for (const key of BIAS_KEYS) {
    const n = dist?.[key] ?? 0;
    if (n <= 0) continue;
    total += n;
    counts[BIAS_TO_ZONE[key]] += n;
  }

  let dominantZone = null;
  for (const zone of ZONE_KEYS) {
    if (counts[zone] > 0 && (dominantZone === null || counts[zone] > counts[dominantZone])) {
      dominantZone = zone;
    }
  }

  let dominantCategory = null;
  if (dominantZone) {
    let best = 0;
    for (const key of BIAS_KEYS) {
      const n = dist?.[key] ?? 0;
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

export function detectBlindspot(dist) {
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
