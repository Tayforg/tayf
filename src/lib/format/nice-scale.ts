// Nice-number y-axis scale for the /trends stacked-bar chart.
//
// Replaces the idea's `niceCeil` (round the maximum up to 1/2/2.5/5/10 x 10^k
// and divide by four): 2198 -> 2500 would give gridlines at 625 / 1250 / 1875,
// which is no better than the raw 549.5 / 1099 / 1648.5 it replaces. Here the
// STEP is the nice number and the axis maximum is a whole multiple of it, so
// every tick is a round number: 8791 -> 0 / 2.500 / 5.000 / 7.500 / 10.000.
//
// step = the smallest of {1, 2, 2.5, 5} x 10^k (k >= 0) that covers the maximum
// in at most `maxIntervals` steps. 2.5 is skipped at k = 0 so the ticks of a
// small chart stay whole numbers (a count of articles has no half units).
// max = step * ceil(value / step), ticks = 0, step, ..., max.
//
// A non-finite or non-positive input behaves like 1, so an empty month still
// draws a sane axis (0, 1) instead of dividing by zero.

const MANTISSAS = [1, 2, 2.5, 5] as const;
const DEFAULT_INTERVALS = 4;

export interface NiceScale {
  /** Axis maximum: `step * ceil(value / step)`, always >= the input. */
  max: number;
  /** Distance between two neighbouring ticks. */
  step: number;
  /** `0, step, 2 * step, ..., max`. */
  ticks: number[];
}

export function niceScale(
  maxValue: number,
  maxIntervals: number = DEFAULT_INTERVALS,
): NiceScale {
  const value = Number.isFinite(maxValue) && maxValue > 0 ? maxValue : 1;
  const intervals = Number.isFinite(maxIntervals)
    ? Math.max(1, Math.floor(maxIntervals))
    : DEFAULT_INTERVALS;

  let step = Math.ceil(value / intervals);
  search: for (let k = 0; k <= 300; k++) {
    const scale = 10 ** k;
    for (const mantissa of MANTISSAS) {
      if (k === 0 && mantissa === 2.5) continue;
      const candidate = mantissa * scale;
      if (Math.ceil(value / candidate) <= intervals) {
        step = candidate;
        break search;
      }
    }
  }

  const count = Math.ceil(value / step);
  const ticks: number[] = [];
  for (let i = 0; i <= count; i++) ticks.push(i * step);
  return { max: step * count, step, ticks };
}
