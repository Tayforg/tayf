import { BIAS_ORDER, BLINDSPOT, tallyZones } from "@/lib/bias/config";
import type { BiasCategory, MediaDnaZone } from "@/types";

// "Kör noktaya yakın" (near-blindspot) rule. A DISPLAY-ONLY band under the
// real blindspot contract: stories where one zone clearly dominates the
// voting sources but stays below BLINDSPOT.dominantShare. Nothing here
// changes what a blindspot is -- the contract lives in
// supabase/functions/_shared/cluster/blindspot.ts (re-exported through
// src/lib/bias/config.ts) and this module only reads BLINDSPOT from it.

/** Inclusive lower bound of the dominant zone's share of voting sources. */
export const NEAR_BLINDSPOT_MIN_SHARE = 0.7;

/** Maximum rows rendered in the section. */
export const NEAR_BLINDSPOT_DISPLAY_LIMIT = 10;

/**
 * Step-A row cap: a safety bound, not a sample: the band is pre-tested on the
 * stored distribution. Step A selects `id, bias_distribution` for every active
 * cluster of the lookback window (about 400 on production, 2026-11-06), so the
 * cap sits well above any real window and only guards a runaway read.
 */
export const NEAR_BLINDSPOT_CANDIDATE_SAFETY_CAP = 1000;

/**
 * Slack, in share points, around the band when it is tested on the STORED
 * distribution. The live re-tally (earliest article per source, voting kinds)
 * can differ slightly from what cluster-consumer stored, so a row within this
 * distance of the band is still embedded and judged live.
 */
export const NEAR_BLINDSPOT_PREFILTER_TOLERANCE = 0.05;

/**
 * Most pre-filter survivors that are embedded. The band test leaves a few
 * dozen stories (34 of 377 on 2026-11-06); this only bounds the embed cost if
 * a bad distribution write ever made most of the window look in band. The
 * newest survivors win.
 */
export const NEAR_BLINDSPOT_SURVIVOR_CAP = 200;

/** Only stories first published AND updated within this many days. */
export const NEAR_BLINDSPOT_LOOKBACK_DAYS = 7;

/**
 * True when a voting-source tally sits in the near-blindspot band: enough
 * voting sources, a dominant zone, and a dominant share in
 * [NEAR_BLINDSPOT_MIN_SHARE, BLINDSPOT.dominantShare). A tally at or above
 * BLINDSPOT.dominantShare is a blindspot (shown above), never a near one.
 */
export function isNearBlindspotTally(t: {
  total: number;
  dominantZone: MediaDnaZone | null;
  dominantShare: number;
}): boolean {
  return (
    t.dominantZone !== null &&
    t.total >= BLINDSPOT.minSources &&
    t.dominantShare >= NEAR_BLINDSPOT_MIN_SHARE &&
    t.dominantShare < BLINDSPOT.dominantShare
  );
}

/** Float slack for comparing a share against a tolerance-widened bound. */
const SHARE_EPSILON = 1e-9;

/**
 * Finite numeric entries of a stored `bias_distribution` jsonb, by bias
 * category. Same reading as blindspots-query.ts's private normalizeDistribution
 * (non-object -> nothing; non-finite or non-number entries are skipped), but
 * only the usable entries are returned.
 */
function usableDistribution(raw: unknown): Partial<Record<BiasCategory, number>> {
  const out: Partial<Record<BiasCategory, number>> = {};
  if (!raw || typeof raw !== "object") return out;
  const obj = raw as Record<string, unknown>;
  for (const key of BIAS_ORDER) {
    const v = obj[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
  }
  return out;
}

/**
 * Step-A pre-filter: could this cluster's STORED bias_distribution be in the
 * near-blindspot band? Tested on the stored (voting-kinds-only) counts before
 * any cap, so every qualifying story of the window reaches the embed step.
 *
 * Keeps the row when the stored tally has at least BLINDSPOT.minSources and a
 * dominant share in [MIN_SHARE - tolerance, BLINDSPOT.dominantShare +
 * tolerance); the tolerance absorbs stored-vs-live drift. A distribution with
 * no usable entry (null, a string, `{}`, non-numeric values) is kept: nothing
 * can be said about it, so the live embed decides. The live tally in
 * near-blindspots-query.ts stays the authority; this only chooses who is worth
 * embedding.
 */
export function storedDistributionMayBeNear(raw: unknown): boolean {
  const tally = tallyZones(usableDistribution(raw));
  if (tally.total <= 0) return true;
  if (tally.dominantZone === null || tally.total < BLINDSPOT.minSources) return false;
  const lower = NEAR_BLINDSPOT_MIN_SHARE - NEAR_BLINDSPOT_PREFILTER_TOLERANCE;
  const upper = BLINDSPOT.dominantShare + NEAR_BLINDSPOT_PREFILTER_TOLERANCE;
  return (
    tally.dominantShare + SHARE_EPSILON >= lower &&
    tally.dominantShare + SHARE_EPSILON < upper
  );
}

/**
 * Whole-percent display of a share, FLOORED so a sub-threshold share can never
 * read as the threshold itself (0.799 -> 79, never %80). The 1e-9 absorbs
 * float noise on exact hundredths (0.57 * 100 = 56.99999999999999).
 */
export function nearSharePercent(share: number): number {
  return Math.floor(share * 100 + 1e-9);
}
