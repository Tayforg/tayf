import { describe, it, expect } from "vitest";

import { BLINDSPOT } from "@/lib/bias/config";
import {
  NEAR_BLINDSPOT_CANDIDATE_LIMIT,
  NEAR_BLINDSPOT_DISPLAY_LIMIT,
  NEAR_BLINDSPOT_LOOKBACK_DAYS,
  NEAR_BLINDSPOT_MIN_SHARE,
  isNearBlindspotTally,
  nearSharePercent,
} from "./near-blindspot-rule";

function tally(
  overrides: Partial<Parameters<typeof isNearBlindspotTally>[0]> = {},
): Parameters<typeof isNearBlindspotTally>[0] {
  return { total: 5, dominantZone: "iktidar", dominantShare: 0.75, ...overrides };
}

describe("near-blindspot constants", () => {
  it("pins the band, the display cap, the candidate cap and the lookback", () => {
    expect(NEAR_BLINDSPOT_MIN_SHARE).toBe(0.7);
    expect(NEAR_BLINDSPOT_DISPLAY_LIMIT).toBe(10);
    expect(NEAR_BLINDSPOT_CANDIDATE_LIMIT).toBe(100);
    expect(NEAR_BLINDSPOT_LOOKBACK_DAYS).toBe(7);
  });

  it("keeps the band strictly below the blindspot threshold", () => {
    expect(NEAR_BLINDSPOT_MIN_SHARE).toBeLessThan(BLINDSPOT.dominantShare);
  });
});

describe("isNearBlindspotTally", () => {
  it("excludes a share just under the lower bound (0.69)", () => {
    expect(isNearBlindspotTally(tally({ total: 5, dominantShare: 0.69 }))).toBe(false);
  });

  it("includes the lower bound itself (0.70, inclusive)", () => {
    expect(isNearBlindspotTally(tally({ total: 5, dominantShare: 0.7 }))).toBe(true);
  });

  it("includes a share just under the blindspot threshold (0.79)", () => {
    expect(isNearBlindspotTally(tally({ total: 5, dominantShare: 0.79 }))).toBe(true);
  });

  it("excludes the blindspot threshold itself (0.80 is a blindspot, not a near one)", () => {
    expect(isNearBlindspotTally(tally({ total: 5, dominantShare: 0.8 }))).toBe(false);
  });

  it("excludes shares above the blindspot threshold", () => {
    expect(isNearBlindspotTally(tally({ total: 5, dominantShare: 1 }))).toBe(false);
  });

  it("excludes a tally below BLINDSPOT.minSources even inside the band", () => {
    expect(
      isNearBlindspotTally(tally({ total: BLINDSPOT.minSources - 1, dominantShare: 0.75 })),
    ).toBe(false);
  });

  it("includes a tally at exactly BLINDSPOT.minSources", () => {
    expect(
      isNearBlindspotTally(tally({ total: BLINDSPOT.minSources, dominantShare: 0.75 })),
    ).toBe(true);
  });

  it("excludes a tally with no dominant zone", () => {
    expect(isNearBlindspotTally(tally({ dominantZone: null, dominantShare: 0.75 }))).toBe(
      false,
    );
  });

  it("excludes an empty tally", () => {
    expect(
      isNearBlindspotTally({ total: 0, dominantZone: null, dominantShare: 0 }),
    ).toBe(false);
  });

  it("uses the real fractions of the boundary clusters (9/13, 7/10, 11/14, 8/10)", () => {
    expect(isNearBlindspotTally(tally({ total: 13, dominantShare: 9 / 13 }))).toBe(false);
    expect(isNearBlindspotTally(tally({ total: 10, dominantShare: 7 / 10 }))).toBe(true);
    expect(isNearBlindspotTally(tally({ total: 14, dominantShare: 11 / 14 }))).toBe(true);
    expect(isNearBlindspotTally(tally({ total: 10, dominantShare: 8 / 10 }))).toBe(false);
  });
});

describe("nearSharePercent", () => {
  it("renders 0.7 as 70", () => {
    expect(nearSharePercent(0.7)).toBe(70);
  });

  it("floors 11/14 (78.57%) to 78, never rounding up", () => {
    expect(nearSharePercent(11 / 14)).toBe(78);
  });

  it("floors 0.799 to 79: a sub-80 share never displays as the 80 threshold", () => {
    expect(nearSharePercent(0.799)).toBe(79);
  });

  it("is not thrown by float error on exact hundredths (0.57 -> 57)", () => {
    expect(nearSharePercent(0.57)).toBe(57);
  });

  it("keeps 7/10 at 70 despite 0.7 * 100 float noise", () => {
    expect(nearSharePercent(7 / 10)).toBe(70);
  });
});
