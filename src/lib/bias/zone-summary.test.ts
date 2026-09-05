import { describe, it, expect } from "vitest";

import { dominantZone, zoneCountsOf, zonePercents } from "./zone-summary";
import { emptyBiasDistribution } from "@/lib/bias/analyzer";
import type { BiasDistribution } from "@/types";

function dist(partial: Partial<BiasDistribution>): BiasDistribution {
  return { ...emptyBiasDistribution(), ...partial };
}

describe("zoneCountsOf", () => {
  it("sums bias categories into their Medya DNA zones", () => {
    const counts = zoneCountsOf(
      dist({ pro_government: 3, nationalist: 1, center: 2, opposition: 4 }),
    );
    expect(counts).toEqual({ iktidar: 4, bagimsiz: 2, muhalefet: 4 });
  });

  it("returns all zeros for an empty distribution", () => {
    expect(zoneCountsOf(emptyBiasDistribution())).toEqual({
      iktidar: 0,
      bagimsiz: 0,
      muhalefet: 0,
    });
  });
});

describe("zonePercents", () => {
  it("applies largest-remainder rounding on a 1/1/1 split (34/33/33)", () => {
    const percents = zonePercents({ iktidar: 1, bagimsiz: 1, muhalefet: 1 });
    expect(percents).toEqual({ iktidar: 34, bagimsiz: 33, muhalefet: 33 });
  });

  it("gives the leftover point to the zone with the largest remainder", () => {
    expect(zonePercents({ iktidar: 2, bagimsiz: 1, muhalefet: 3 })).toEqual({
      iktidar: 33,
      bagimsiz: 17,
      muhalefet: 50,
    });
  });

  it("breaks a tied remainder in ZONE_ORDER (iktidar, bagimsiz, muhalefet)", () => {
    expect(
      zonePercents({ iktidar: 1, bagimsiz: 1, muhalefet: 4 }),
    ).toEqual({ iktidar: 17, bagimsiz: 17, muhalefet: 66 });
  });

  it("always sums to exactly 100 when total > 0", () => {
    for (const counts of [
      { iktidar: 1, bagimsiz: 1, muhalefet: 1 },
      { iktidar: 7, bagimsiz: 2, muhalefet: 1 },
      { iktidar: 5, bagimsiz: 3, muhalefet: 2 },
      { iktidar: 1, bagimsiz: 0, muhalefet: 0 },
    ]) {
      const percents = zonePercents(counts);
      expect(percents.iktidar + percents.bagimsiz + percents.muhalefet).toBe(
        100,
      );
    }
  });

  it("is deterministic across repeated calls with the same input", () => {
    const counts = { iktidar: 1, bagimsiz: 1, muhalefet: 1 };
    expect(zonePercents(counts)).toEqual(zonePercents(counts));
  });

  it("returns all zeros when the total is 0", () => {
    expect(zonePercents({ iktidar: 0, bagimsiz: 0, muhalefet: 0 })).toEqual({
      iktidar: 0,
      bagimsiz: 0,
      muhalefet: 0,
    });
  });
});

describe("dominantZone", () => {
  it("picks the zone with the most members", () => {
    expect(dominantZone({ iktidar: 1, bagimsiz: 5, muhalefet: 2 })).toBe(
      "bagimsiz",
    );
  });

  it("breaks a three-way tie toward iktidar", () => {
    expect(dominantZone({ iktidar: 3, bagimsiz: 3, muhalefet: 3 })).toBe(
      "iktidar",
    );
  });

  it("breaks a tie between bagimsiz and muhalefet toward bagimsiz", () => {
    expect(dominantZone({ iktidar: 0, bagimsiz: 3, muhalefet: 3 })).toBe(
      "bagimsiz",
    );
  });

  it("returns null when every zone is empty", () => {
    expect(dominantZone({ iktidar: 0, bagimsiz: 0, muhalefet: 0 })).toBeNull();
  });
});
