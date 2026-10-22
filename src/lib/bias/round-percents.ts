/**
 * Integer percents that sum to exactly 100 whenever the total is positive,
 * via largest-remainder rounding (Hamilton's method).
 *
 * Why not `Math.round(count / total * 100)` per segment: independent rounding
 * can total 99 or 101 (7:1 -> 88 + 13 = 101, 1:1:1 -> 33 x 3 = 99), which
 * reads as a bug next to a bar that visibly fills 100%.
 *
 * Method: floor each segment's exact share, then hand the leftover percentage
 * points out one at a time to the segments with the largest fractional
 * remainder. Ties in the remainder are broken by segment index (lowest
 * first), which is deliberately the same rule `zonePercents`
 * (src/lib/bias/zone-summary.ts) has always used, so the zone-summary and
 * share-text outputs do not move. Do NOT add a "larger raw count first"
 * tie-break: it would change {1,1,4} from 17/17/66.
 *
 * - Each count is sanitised first: anything that is not a finite number
 *   greater than zero (negative, NaN, +-Infinity) counts as 0.
 * - A segment whose (sanitised) count is 0 always gets 0 and never a
 *   leftover point.
 * - When every count is 0 (or the input is empty) the result is all zeros.
 * - Pure: the input array is not mutated; the result has the same length.
 */
export function roundPercents(counts: readonly number[]): number[] {
  const clean = counts.map((c) => (Number.isFinite(c) && c > 0 ? c : 0));
  const total = clean.reduce((sum, c) => sum + c, 0);
  if (total <= 0) return clean.map(() => 0);

  const shares = clean.map((count, index) => {
    const scaled = count * 100;
    return {
      index,
      count,
      floor: Math.floor(scaled / total),
      remainder: scaled % total,
    };
  });

  const percents = shares.map((s) => s.floor);
  let remaining = 100 - percents.reduce((sum, p) => sum + p, 0);

  // Largest remainder first; index ascending on ties (explicit, so the result
  // does not depend on the engine's sort stability).
  const byRemainder = shares
    .filter((s) => s.count > 0)
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  for (const { index } of byRemainder) {
    if (remaining <= 0) break;
    percents[index] = (percents[index] ?? 0) + 1;
    remaining -= 1;
  }

  return percents;
}
