import { BLINDSPOT } from "@/lib/bias/config";
import type { MediaDnaZone } from "@/types";

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

/** Step-A candidate cap: ids fetched before the embed + live re-tally. */
export const NEAR_BLINDSPOT_CANDIDATE_LIMIT = 100;

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

/**
 * Whole-percent display of a share, FLOORED so a sub-threshold share can never
 * read as the threshold itself (0.799 -> 79, never %80). The 1e-9 absorbs
 * float noise on exact hundredths (0.57 * 100 = 56.99999999999999).
 */
export function nearSharePercent(share: number): number {
  return Math.floor(share * 100 + 1e-9);
}
