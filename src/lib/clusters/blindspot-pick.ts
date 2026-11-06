import type { MediaDnaZone } from "@/types";

// Which blindspot claims get a full card on /blindspots (and lead the RSS
// feeds). Pure: no query, no clock, no I/O.
//
// h53-consistency-1: the list used to be "the 30 most lopsided of the 50 most
// recently updated claims". On 2026-11-06 the week held 41 Iktidar and 9
// Muhalefet claims; the cut printed 28 : 2 and 7 of the 9 Muhalefet claims were
// unreachable. Lopsidedness alone favours the side with more outlets: Iktidar
// has more of them, so its claims clear 86-100% far more often than a
// Muhalefet claim does (80-83%).
//
// The pick is therefore side-balanced:
//   1. claims are grouped by `dominantZone`;
//   2. inside a group they are ordered by `dominantPct` desc, then
//      `cluster.updated_at` desc (then cluster id, so input order never leaks);
//   3. sides are ordered by their best share, ties going iktidar, muhalefet,
//      bagimsiz;
//   4. cards are taken round-robin across the sides until `size` are chosen
//      (a side that runs out simply drops out of the rotation);
//   5. the chosen cards are ordered by the same comparator as step 2.
//
// Nothing here is hidden: the claims that do not get a card are listed by the
// caller as compact rows, in the same order (`sortBlindspotClaims`).

/** The fields the pick reads; a `BlindspotBundle` satisfies it as is. */
export interface PickableClaim {
  cluster: { id: string; updated_at: string };
  dominantZone: MediaDnaZone;
  /** The dominant zone's share of the voting sources, in [0.8, 1]. */
  dominantPct: number;
}

/**
 * Length of the list's trailing window, in days (first_published >= now - this).
 * Lives here, with the rest of the list's definition, so the page can name the
 * window without importing the query module; blindspots-query re-exports it.
 */
export const BLINDSPOT_LIST_LOOKBACK_DAYS = 7;

/** Tie order between sides whose best claims share the same percent. */
const SIDE_TIE_ORDER: readonly MediaDnaZone[] = ["iktidar", "muhalefet", "bagimsiz"];

/** Size of a full-card list unless the caller says otherwise. */
export const DEFAULT_PICK_SIZE = 30;

function shareOf(c: PickableClaim): number {
  return Number.isFinite(c.dominantPct) ? c.dominantPct : 0;
}

function updatedMsOf(c: PickableClaim): number {
  const ms = Date.parse(c.cluster.updated_at);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * The list order: most lopsided first, newest activity breaks ties, the
 * cluster id settles the rest. A non-finite share or an unparseable timestamp
 * ranks last instead of throwing or poisoning the sort.
 */
function compareClaims(a: PickableClaim, b: PickableClaim): number {
  return (
    shareOf(b) - shareOf(a) ||
    updatedMsOf(b) - updatedMsOf(a) ||
    (a.cluster.id < b.cluster.id ? -1 : a.cluster.id > b.cluster.id ? 1 : 0)
  );
}

/** A sorted copy in list order (see `compareClaims`); the input is untouched. */
export function sortBlindspotClaims<T extends PickableClaim>(
  claims: readonly T[],
): T[] {
  return [...claims].sort(compareClaims);
}

function sideRank(zone: MediaDnaZone): number {
  const i = SIDE_TIE_ORDER.indexOf(zone);
  return i === -1 ? SIDE_TIE_ORDER.length : i;
}

/**
 * The `size` claims that get a full card: round-robin across the sides, then
 * in list order. Returns `[]` for `size < 1` (or NaN); a fractional size is
 * floored. Deterministic, and independent of the input order.
 */
export function pickBlindspotList<T extends PickableClaim>(
  claims: readonly T[],
  size: number = DEFAULT_PICK_SIZE,
): T[] {
  if (!(size >= 1) || claims.length === 0) return [];
  const limit = Math.floor(size);

  const groups = new Map<MediaDnaZone, T[]>();
  for (const claim of sortBlindspotClaims(claims)) {
    const group = groups.get(claim.dominantZone);
    if (group) group.push(claim);
    else groups.set(claim.dominantZone, [claim]);
  }

  // Each group is already best-first, so its head is the side's top share.
  const sides = [...groups.entries()].sort(
    ([zoneA, a], [zoneB, b]) =>
      shareOf(b[0]!) - shareOf(a[0]!) || sideRank(zoneA) - sideRank(zoneB),
  );

  const picked: T[] = [];
  for (let round = 0; picked.length < limit; round += 1) {
    let tookAny = false;
    for (const [, group] of sides) {
      if (picked.length >= limit) break;
      const next = group[round];
      if (next === undefined) continue;
      picked.push(next);
      tookAny = true;
    }
    if (!tookAny) break;
  }

  return picked.sort(compareClaims);
}
