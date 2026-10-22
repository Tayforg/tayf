import { BLINDSPOT, tallyZones } from "@/lib/bias/config";
import type { BiasDistribution, MediaDnaZone } from "@/types";

// Denge puanı ("balance score"): one 0-100 number for how evenly a cluster's
// coverage is spread over the three Medya DNA zones.
//
// Basis: the SAME one the card's compact BiasSpectrum bar draws and the
// blindspot / surprise rules vote on -- `cluster.bias_distribution` (voting
// sources only; aggregator / niche kinds never vote) collapsed from the 10
// bias categories onto the 3 zones (iktidar / bagimsiz / muhalefet).
//
// Formula (normalised Shannon entropy over the zone shares):
//
//   c_z   = voting sources in zone z, z in {iktidar, bagimsiz, muhalefet}
//   N     = sum of c_z
//   p_z   = c_z / N
//   H     = -sum over p_z > 0 of  p_z * ln(p_z)          (nats)
//   score = round(100 * H / ln 3), clamped to 0..100
//
// All coverage in one zone is H = 0 -> 0; an even three-way split is
// H = ln 3 -> 100; an even two-way split is H = ln 2 -> ~63. The score is a
// description of breadth, not a quality grade, and it never feeds a sort
// order (home / blindspots / konu ordering is unchanged).
//
// Below BALANCE_MIN_SOURCES voting sources no score is computed: with four
// votes "one side ignored it" and "nobody has picked it up yet" cannot be told
// apart -- the same floor the blindspot rule uses.

/** Score at or above this is "Dengeli kapsama". */
export const BALANCE_BALANCED_MIN = 67;
/** Score at or below this is "Tek tarafta". */
export const BALANCE_ONE_SIDED_MAX = 33;
/** Fewer voting sources than this and no score is computed. */
export const BALANCE_MIN_SOURCES = BLINDSPOT.minSources;

export type BalanceTier = "dengeli" | "yakin" | "tek";

export const BALANCE_LABELS: Record<BalanceTier, string> = {
  dengeli: "Dengeli kapsama",
  yakin: "Tek tarafa yakın",
  tek: "Tek tarafta",
};

/** Label for a cluster with too few classified sources to score. */
export const BALANCE_INSUFFICIENT_LABEL = "Az kaynak";

export interface BalanceScore {
  /** Integer 0..100. */
  score: number;
  tier: BalanceTier;
  /** Turkish tier label, `BALANCE_LABELS[tier]`. */
  label: string;
  /** Voting sources the score was computed from (N). */
  total: number;
}

const ZONES: readonly MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];
const LN_3 = Math.log(3);

export function balanceTier(score: number): BalanceTier {
  if (score >= BALANCE_BALANCED_MIN) return "dengeli";
  if (score <= BALANCE_ONE_SIDED_MAX) return "tek";
  return "yakin";
}

/** Non-finite and negative counts are not votes. */
function sanitize(count: number): number {
  return Number.isFinite(count) && count > 0 ? count : 0;
}

/**
 * Balance score from per-zone voting-source counts, or `null` when fewer than
 * BALANCE_MIN_SOURCES sources voted.
 */
export function balanceFromZoneCounts(
  counts: Record<MediaDnaZone, number>,
): BalanceScore | null {
  const clean = ZONES.map((zone) => sanitize(counts[zone]));
  const total = clean.reduce((sum, c) => sum + c, 0);
  if (total < BALANCE_MIN_SOURCES) return null;

  let entropy = 0;
  for (const c of clean) {
    if (c <= 0) continue;
    const p = c / total;
    entropy -= p * Math.log(p);
  }

  // Math.max(0, ...) also normalises -0 (single-zone coverage: -(1 * ln 1)).
  const score = Math.min(100, Math.max(0, Math.round((100 * entropy) / LN_3)));
  const tier = balanceTier(score);
  return { score, tier, label: BALANCE_LABELS[tier], total };
}

/**
 * Balance score for a cluster's stored `bias_distribution`, collapsed to the
 * 3 zones exactly like the compact BiasSpectrum bar (`tallyZones` sums each
 * category into `BIAS_TO_ZONE[category]`).
 */
export function balanceFromDistribution(
  dist: BiasDistribution,
): BalanceScore | null {
  return balanceFromZoneCounts(tallyZones(dist).counts);
}

/** Text for `aria-label` / `title` on the chip. */
export function balanceAriaLabel(b: BalanceScore | null): string {
  if (b === null) {
    return `Denge puanı yok: ${BALANCE_INSUFFICIENT_LABEL} (en az ${BALANCE_MIN_SOURCES} sınıflandırılmış kaynak gerekir)`;
  }
  return `Denge puanı ${b.score}/100: ${b.label}`;
}
