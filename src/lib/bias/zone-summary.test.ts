import { describe, it, expect } from "vitest";

import {
  dominantZonePercent,
  isOnlyZone,
  zoneCountsOf,
  zonePercents,
} from "./zone-summary";
import { emptyBiasDistribution } from "@/lib/bias/analyzer";
import type { BiasDistribution, MediaDnaZone } from "@/types";

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

const ZONES: MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];

describe("dominantZonePercent", () => {
  it("reads 84 (not Math.round's 85) for 11/1/1: the chip must match the bar", () => {
    // 11/13 = 84.6: Math.round gives 85, largest remainder gives 84/8/8.
    expect(
      dominantZonePercent({ iktidar: 11, bagimsiz: 1, muhalefet: 1 }, "iktidar"),
    ).toBe(84);
  });

  it("equals zonePercents(counts)[zone] for every zone of a table of splits (ties, zeros, all-zero)", () => {
    const table: Array<Record<MediaDnaZone, number>> = [
      { iktidar: 11, bagimsiz: 1, muhalefet: 1 },
      { iktidar: 1, bagimsiz: 1, muhalefet: 1 },
      { iktidar: 1, bagimsiz: 1, muhalefet: 4 },
      { iktidar: 2, bagimsiz: 1, muhalefet: 3 },
      { iktidar: 5, bagimsiz: 0, muhalefet: 0 },
      { iktidar: 250, bagimsiz: 1, muhalefet: 0 },
      { iktidar: 4, bagimsiz: 1, muhalefet: 0 },
      { iktidar: 0, bagimsiz: 0, muhalefet: 0 },
    ];
    for (const counts of table) {
      const percents = zonePercents(counts);
      for (const zone of ZONES) {
        expect(dominantZonePercent(counts, zone)).toBe(percents[zone]);
      }
    }
  });

  it("returns 0 for every zone when nothing voted", () => {
    const counts = { iktidar: 0, bagimsiz: 0, muhalefet: 0 };
    for (const zone of ZONES) {
      expect(dominantZonePercent(counts, zone)).toBe(0);
    }
  });

  it("sums to 100 across the three zones whenever total > 0", () => {
    for (const counts of [
      { iktidar: 11, bagimsiz: 1, muhalefet: 1 },
      { iktidar: 1, bagimsiz: 1, muhalefet: 1 },
      { iktidar: 250, bagimsiz: 1, muhalefet: 0 },
      { iktidar: 0, bagimsiz: 0, muhalefet: 3 },
    ]) {
      const sum = ZONES.reduce(
        (acc, zone) => acc + dominantZonePercent(counts, zone),
        0,
      );
      expect(sum).toBe(100);
    }
  });
});

describe("isOnlyZone", () => {
  it("is true when the zone has sources and the other two have exactly none", () => {
    expect(isOnlyZone({ iktidar: 5, bagimsiz: 0, muhalefet: 0 }, "iktidar")).toBe(true);
    expect(isOnlyZone({ iktidar: 0, bagimsiz: 0, muhalefet: 2 }, "muhalefet")).toBe(true);
    expect(isOnlyZone({ iktidar: 0, bagimsiz: 1, muhalefet: 0 }, "bagimsiz")).toBe(true);
  });

  it("is false at 250/1/0 although the rounded share reads 100", () => {
    const counts = { iktidar: 250, bagimsiz: 1, muhalefet: 0 };
    expect(dominantZonePercent(counts, "iktidar")).toBe(100);
    expect(isOnlyZone(counts, "iktidar")).toBe(false);
  });

  it("is false when nobody voted", () => {
    expect(isOnlyZone({ iktidar: 0, bagimsiz: 0, muhalefet: 0 }, "iktidar")).toBe(false);
  });

  it("is false for a zone with no sources even when the others have", () => {
    expect(isOnlyZone({ iktidar: 5, bagimsiz: 0, muhalefet: 0 }, "muhalefet")).toBe(false);
  });

  it("is false when two other zones are split", () => {
    expect(isOnlyZone({ iktidar: 3, bagimsiz: 0, muhalefet: 2 }, "iktidar")).toBe(false);
  });
});
