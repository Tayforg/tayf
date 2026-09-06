import type { Source, MediaDnaZone } from "@/types";
import { zoneOf, BLINDSPOT, SURPRISE } from "./config";

/**
 * Result of the "unexpected cross-spectrum coverage" detector.
 *
 * `dominantZone` is `null` when no zone reaches the dominance threshold,
 * in which case the cluster is considered mixed and nothing is flagged.
 */
export interface CrossSpectrumResult {
  dominantZone: MediaDnaZone | null; // null if no clear dominant
  dominantPct: number; // 0..1
  surpriseOutlets: Source[]; // sources whose zone is OPPOSITE to dominant
  blindspotCandidate: boolean; // true when dominantPct >= BLINDSPOT.dominantShare (contract)
}

/**
 * The opposite-zone map. `bagimsiz` intentionally has no opposite — an
 * independent outlet covering a partisan story is not a "surprise".
 */
const OPPOSITE: Record<MediaDnaZone, MediaDnaZone | null> = {
  iktidar: "muhalefet",
  muhalefet: "iktidar",
  bagimsiz: null,
};

/**
 * Given a cluster's member sources, find the dominant Medya DNA zone and
 * any members whose baseline bias sits in the OPPOSITE zone. Those members
 * are the "cross-spectrum surprises" — outlets that usually take the other
 * side but showed up on this story.
 */
export function detectCrossSpectrum(
  memberSources: Source[],
  // Contract default (SURPRISE.dominantShare in the bias-zone contract):
  // 0.55 fired 98× in 14 days of production data vs 48× at 0.65, the extra
  // firings being 55–64% majority splits rather than real surprises.
  dominantThreshold = SURPRISE.dominantShare,
): CrossSpectrumResult {
  // Contract minimum-source-count guard (SURPRISE.minSources). Clusters
  // below this floor where a single opposite voice flips verdicts are too
  // noisy to be trusted.
  if (memberSources.length < SURPRISE.minSources) {
    return {
      dominantZone: null,
      dominantPct: 0,
      surpriseOutlets: [],
      blindspotCandidate: false,
    };
  }

  // Count members per zone.
  const counts: Record<MediaDnaZone, number> = {
    iktidar: 0,
    bagimsiz: 0,
    muhalefet: 0,
  };
  for (const s of memberSources) counts[zoneOf(s.bias)]++;

  // Find dominant zone — must clear the threshold AND be the largest.
  const total = memberSources.length;
  let dominantZone: MediaDnaZone | null = null;
  let dominantPct = 0;
  for (const zone of Object.keys(counts) as MediaDnaZone[]) {
    const pct = counts[zone] / total;
    if (pct >= dominantThreshold && pct > dominantPct) {
      dominantZone = zone;
      dominantPct = pct;
    }
  }

  if (!dominantZone) {
    return {
      dominantZone: null,
      dominantPct: 0,
      surpriseOutlets: [],
      blindspotCandidate: false,
    };
  }

  // Members in the opposite zone are the surprises.
  const opposite = OPPOSITE[dominantZone];
  const surpriseOutlets = opposite
    ? memberSources.filter((s) => zoneOf(s.bias) === opposite)
    : [];

  // Contract minimum-margin guard (SURPRISE.minMargin). Even after the
  // threshold + size floor, kill anything where the dominant zone only
  // barely outnumbers the opposite zone — most 4-vs-2 / 3-vs-1 firings in
  // production were noise (wire copy, nationalist mis-zoning, or
  // self-reporting).
  const dominantCount = counts[dominantZone];
  const oppositeCount = opposite ? counts[opposite] : 0;
  if (dominantCount - oppositeCount < SURPRISE.minMargin) {
    return {
      dominantZone: null,
      dominantPct: 0,
      surpriseOutlets: [],
      blindspotCandidate: false,
    };
  }

  // "Kör nokta" candidate: a single zone owns >= BLINDSPOT.dominantShare of
  // the cluster (the same share the DB-level is_blindspot flag uses), so
  // the opposite half of the spectrum is essentially absent. The DB flag
  // itself is owned elsewhere; this is just a hint for the UI/caption
  // layer.
  const blindspotCandidate = dominantPct >= BLINDSPOT.dominantShare;

  return { dominantZone, dominantPct, surpriseOutlets, blindspotCandidate };
}

/**
 * Render human-readable Turkish blurbs for the surprise outlets, capped at
 * `max`. Returns `[]` when there is nothing to show so callers can
 * `if (lines.length)` without special-casing.
 */
export function summarizeSurprises(
  result: CrossSpectrumResult,
  _clusterTitle: string,
  max = 2,
): string[] {
  if (!result.dominantZone || result.surpriseOutlets.length === 0) return [];

  const oppositeShort = {
    iktidar: "iktidar",
    muhalefet: "muhalefet",
    bagimsiz: "bağımsız",
  }[result.dominantZone === "iktidar" ? "muhalefet" : "iktidar"];

  return result.surpriseOutlets.slice(0, max).map((s) => {
    return `${s.name} (${oppositeShort}) ${deDa(s.name)} bu habere yer verdi`;
  });
}

// Turkish "de/da" clitic vowel harmony: the clitic agrees with the last
// vowel of the word it attaches to (the outlet name here) — back vowels
// (a, ı, o, u) take "da", front vowels (e, i, ö, ü) take "de": Sabah, Star,
// Akşam, Posta take "da"; Habertürk, Cumhuriyet, BirGün take "de".
// Hardcoding "de" reads as a typo to any Turkish reader. Names ending in
// "TV" are read "te-ve", so they take "de" regardless of the spelling;
// other acronym-style names with no vowel match default to "de".
const BACK_VOWEL = /[aıou][^aeıioöuü]*$/i;
const READ_AS_TE_VE = /tv$/i;
function deDa(name: string): "da" | "de" {
  if (READ_AS_TE_VE.test(name)) return "de";
  return BACK_VOWEL.test(name) ? "da" : "de";
}
