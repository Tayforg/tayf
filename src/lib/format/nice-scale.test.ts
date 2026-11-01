import { describe, it, expect } from "vitest";

import { niceScale } from "./nice-scale";

describe("niceScale — concrete scales", () => {
  it.each([
    // [input, step, max, ticks]
    [8791, 2500, 10000, [0, 2500, 5000, 7500, 10000]],
    [2198, 1000, 3000, [0, 1000, 2000, 3000]],
    [4396, 2000, 6000, [0, 2000, 4000, 6000]],
    [7, 2, 8, [0, 2, 4, 6, 8]],
    [100, 25, 100, [0, 25, 50, 75, 100]],
    [10000, 2500, 10000, [0, 2500, 5000, 7500, 10000]],
    [10001, 5000, 15000, [0, 5000, 10000, 15000]],
    [1, 1, 1, [0, 1]],
  ] as const)("niceScale(%d) -> step %d, max %d", (input, step, max, ticks) => {
    const scale = niceScale(input);
    expect(scale.step).toBe(step);
    expect(scale.max).toBe(max);
    expect(scale.ticks).toEqual(ticks);
  });

  it("never yields a fractional step at the unit scale (2.5 is skipped below 10)", () => {
    // 2.5 x 10^0 would make 10 -> 2.5/5/7.5/10; the unit scale uses 1/2/5 only.
    const scale = niceScale(10);
    expect(scale.ticks.every(Number.isInteger)).toBe(true);
    expect(scale.step).toBe(5);
    expect(scale.max).toBe(10);
  });

  it("treats 0, NaN, negatives and infinities like 1", () => {
    const one = niceScale(1);
    for (const bad of [0, NaN, -5, Infinity, -Infinity]) {
      expect(niceScale(bad)).toEqual(one);
    }
  });

  it("honours a custom maxIntervals", () => {
    const two = niceScale(8791, 2);
    expect(two.step).toBe(5000);
    expect(two.max).toBe(10000);
    expect(two.ticks).toEqual([0, 5000, 10000]);

    const ten = niceScale(8791, 10);
    expect(ten.ticks.length).toBeLessThanOrEqual(11);
    expect(ten.max).toBeGreaterThanOrEqual(8791);
  });

  it("clamps a nonsensical maxIntervals to at least one interval", () => {
    for (const bad of [0, -3, NaN]) {
      const scale = niceScale(8791, bad);
      expect(scale.max).toBeGreaterThanOrEqual(8791);
      expect(scale.ticks[0]).toBe(0);
      expect(scale.ticks.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("niceScale — invariants", () => {
  // A dense sweep around every order of magnitude plus awkward values.
  const inputs: number[] = [];
  for (let v = 1; v <= 3000; v++) inputs.push(v);
  for (let v = 3000; v <= 2_000_000; v += 997) inputs.push(v);
  inputs.push(0.5, 1.5, 99, 100, 101, 249, 250, 251, 999, 1000, 1001, 24_999, 25_000, 25_001);

  it.each([2, 3, 4, 5, 8])("holds for maxIntervals = %d", (maxIntervals) => {
    for (const input of inputs) {
      const { max, step, ticks } = niceScale(input, maxIntervals);

      expect(Number.isInteger(step), `step for ${input}`).toBe(true);
      expect(ticks.every(Number.isInteger), `ticks for ${input}`).toBe(true);
      expect(ticks[0], `first tick for ${input}`).toBe(0);
      expect(ticks.at(-1), `last tick for ${input}`).toBe(max);
      expect(max, `max for ${input}`).toBeGreaterThanOrEqual(input);
      expect(ticks.length, `length for ${input}`).toBeGreaterThanOrEqual(2);
      expect(ticks.length, `length for ${input}`).toBeLessThanOrEqual(maxIntervals + 1);
      for (let i = 1; i < ticks.length; i++) {
        expect(ticks[i]).toBeGreaterThan(ticks[i - 1]!);
        expect(ticks[i]! - ticks[i - 1]!).toBe(step);
      }
    }
  });

  it("is tight: the next smaller candidate step would need too many intervals", () => {
    // 8791 -> 2500 because 2000 needs ceil(4.3955) = 5 intervals.
    expect(Math.ceil(8791 / 2000)).toBeGreaterThan(4);
    // 10001 -> 5000 because 2500 needs ceil(4.0004) = 5 intervals.
    expect(Math.ceil(10001 / 2500)).toBeGreaterThan(4);
  });
});
