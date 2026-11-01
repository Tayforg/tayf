import { describe, it, expect } from "vitest";

import { BIAS_ORDER } from "@/lib/bias/config";

import { distributionTotal, sumDistributions } from "./sum-distributions";

// sumDistributions folds the per-cluster `bias_distribution` jsonb of a listed
// page into one spectrum (the /gundem/[key] and /konu/[slug] bars).
// distributionTotal is the "is there anything to draw" test behind the honest
// empty state.

function b(distribution: unknown) {
  return { cluster: { bias_distribution: distribution } };
}

describe("sumDistributions", () => {
  it("returns every one of the 10 BIAS_ORDER keys at 0 for no bundles, and a zero total", () => {
    const sum = sumDistributions([]);

    expect(BIAS_ORDER).toHaveLength(10);
    expect(Object.keys(sum).sort()).toEqual([...BIAS_ORDER].sort());
    for (const key of BIAS_ORDER) expect(sum[key]).toBe(0);
    expect(distributionTotal(sum)).toBe(0);
  });

  it("sums two bundles key by key and leaves the other keys at 0", () => {
    const sum = sumDistributions([
      b({ pro_government: 2, opposition: 1 }),
      b({ opposition: 3, center: 1 }),
    ]);

    expect(sum.pro_government).toBe(2);
    expect(sum.opposition).toBe(4);
    expect(sum.center).toBe(1);
    for (const key of BIAS_ORDER) {
      if (!["pro_government", "opposition", "center"].includes(key)) {
        expect(sum[key]).toBe(0);
      }
    }
    expect(distributionTotal(sum)).toBe(7);
  });

  it("does not mutate the input distributions", () => {
    const first = { opposition: 1 };
    sumDistributions([b(first), b({ opposition: 2 })]);

    expect(first).toEqual({ opposition: 1 });
  });

  describe("malformed input is ignored, never thrown on", () => {
    it.each([
      ["null", null],
      ["undefined", undefined],
      ["an array", [1, 2, 3]],
      ["a string", "opposition"],
      ["a number", 5],
    ])("a distribution that is %s contributes nothing", (_label, bad) => {
      const sum = sumDistributions([b(bad), b({ center: 2 })]);

      expect(sum.center).toBe(2);
      expect(distributionTotal(sum)).toBe(2);
    });

    it.each([
      ["negative", -3],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["a numeric string", "4"],
      ["null", null],
      ["an object", { n: 1 }],
    ])("a value that is %s is skipped for that key only", (_label, bad) => {
      const sum = sumDistributions([b({ opposition: bad, center: 2 })]);

      expect(sum.opposition).toBe(0);
      expect(sum.center).toBe(2);
    });

    it("ignores keys that are not in BIAS_ORDER (including prototype names)", () => {
      const sum = sumDistributions([
        b({ unknown_kind: 9, __proto__x: 4, constructor: 7, center: 1 }),
      ]);

      expect(Object.keys(sum).sort()).toEqual([...BIAS_ORDER].sort());
      expect(distributionTotal(sum)).toBe(1);
    });

    it("ignores inherited keys: only own properties count", () => {
      const inherited = Object.create({ opposition: 5 }) as Record<string, number>;
      inherited.center = 1;

      const sum = sumDistributions([b(inherited)]);

      expect(sum.opposition).toBe(0);
      expect(sum.center).toBe(1);
    });

    it.each([
      ["a missing cluster", {}],
      ["a null cluster", { cluster: null }],
      ["a null bundle", null],
      ["an undefined bundle", undefined],
    ])("%s is skipped", (_label, bad) => {
      const sum = sumDistributions([
        bad as unknown as { cluster: { bias_distribution: unknown } },
        b({ center: 2 }),
      ]);

      expect(sum.center).toBe(2);
      expect(distributionTotal(sum)).toBe(2);
    });
  });
});

describe("distributionTotal", () => {
  it("sums only BIAS_ORDER keys", () => {
    const base = sumDistributions([b({ pro_government: 2, opposition: 1 })]);
    const withExtra = { ...base, not_a_bias_kind: 100 } as typeof base;

    expect(distributionTotal(withExtra)).toBe(3);
  });

  it("is 0 for a record with no positive counts", () => {
    expect(distributionTotal(sumDistributions([b({}), b(null)]))).toBe(0);
  });

  it("skips non-finite or negative values defensively", () => {
    const d = {
      ...sumDistributions([]),
      center: Number.NaN,
      opposition: -2,
      nationalist: 3,
    };

    expect(distributionTotal(d)).toBe(3);
  });
});
