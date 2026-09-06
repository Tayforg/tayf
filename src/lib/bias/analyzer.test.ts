import { describe, it, expect } from "vitest";
import { emptyBiasDistribution } from "./analyzer";
import type { BiasCategory } from "@/types";

describe("emptyBiasDistribution", () => {
  it("returns a distribution with every BiasCategory key set to 0", () => {
    const d = emptyBiasDistribution();
    const expectedKeys: BiasCategory[] = [
      "pro_government",
      "gov_leaning",
      "state_media",
      "center",
      "opposition_leaning",
      "opposition",
      "nationalist",
      "islamist_conservative",
      "pro_kurdish",
      "international",
    ];
    for (const key of expectedKeys) {
      expect(d[key]).toBe(0);
    }
    expect(Object.keys(d).sort()).toEqual(expectedKeys.slice().sort());
  });

  it("returns a fresh object each call (no shared mutable state)", () => {
    const a = emptyBiasDistribution();
    const b = emptyBiasDistribution();
    a.pro_government = 5;
    expect(b.pro_government).toBe(0);
    expect(a).not.toBe(b);
  });
});
