import { describe, it, expect } from "vitest";

import { roundPercents } from "./round-percents";

// Largest-remainder (Hamilton) rounding: integer percents that sum to exactly
// 100 whenever the total is positive. Naive Math.round() per segment can total
// 101 (e.g. 7/1 -> 88 + 13) or 99 (e.g. 1/1/1 -> 33 x 3).

describe("roundPercents", () => {
  it("never lets a naive Math.round() overshoot: [7,1] -> [88,12]", () => {
    expect(roundPercents([7, 1])).toEqual([88, 12]);
  });

  it("hands the leftover point to the first of equal remainders: [1,1,1] -> [34,33,33]", () => {
    expect(roundPercents([1, 1, 1])).toEqual([34, 33, 33]);
  });

  it("hands the leftover point to the largest remainder: [1,2] -> [33,67]", () => {
    expect(roundPercents([1, 2])).toEqual([33, 67]);
  });

  it("never gives a zero segment a point: [7,0,1] -> [88,0,12]", () => {
    expect(roundPercents([7, 0, 1])).toEqual([88, 0, 12]);
  });

  it("keeps the zone-summary tie-break (lowest index first): [1,1,4] -> [17,17,66]", () => {
    expect(roundPercents([1, 1, 4])).toEqual([17, 17, 66]);
  });

  it("returns zeros when every count is zero", () => {
    expect(roundPercents([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it("returns an empty array for an empty input", () => {
    expect(roundPercents([])).toEqual([]);
  });

  it("gives a single segment the whole 100", () => {
    expect(roundPercents([5])).toEqual([100]);
  });

  it("treats negative, NaN and infinite entries as 0", () => {
    expect(roundPercents([-3, 5, Number.NaN])).toEqual([0, 100, 0]);
    expect(roundPercents([Number.POSITIVE_INFINITY, 1, 1])).toEqual([0, 50, 50]);
    expect(roundPercents([-1, Number.NaN])).toEqual([0, 0]);
  });

  it("does not mutate its input", () => {
    const input = [1, 1, 1] as const;
    roundPercents(input);
    expect(input).toEqual([1, 1, 1]);
  });

  it("sums to 100 and stays within 1 of the exact share for every triple in 0..12", () => {
    let checked = 0;
    for (let a = 0; a <= 12; a++) {
      for (let b = 0; b <= 12; b++) {
        for (let c = 0; c <= 12; c++) {
          if (a + b + c === 0) continue;
          const counts = [a, b, c];
          const total = a + b + c;
          const out = roundPercents(counts);

          expect(out).toHaveLength(3);
          expect(out[0]! + out[1]! + out[2]!).toBe(100);
          counts.forEach((count, i) => {
            const exact = (count * 100) / total;
            expect(Number.isInteger(out[i])).toBe(true);
            expect(Math.abs(out[i]! - exact)).toBeLessThan(1);
            // A segment with no sources never receives a point.
            if (count === 0) expect(out[i]).toBe(0);
          });
          checked++;
        }
      }
    }
    expect(checked).toBe(13 ** 3 - 1);
  });

  it("sums to 100 for wider splits of 10 segments", () => {
    const counts = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3];
    const out = roundPercents(counts);
    expect(out.reduce((s, n) => s + n, 0)).toBe(100);
    expect(out).toHaveLength(10);
  });
});
