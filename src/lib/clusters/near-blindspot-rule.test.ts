import { describe, it, expect } from "vitest";

import { BLINDSPOT } from "@/lib/bias/config";
import {
  NEAR_BLINDSPOT_CANDIDATE_SAFETY_CAP,
  NEAR_BLINDSPOT_DISPLAY_LIMIT,
  NEAR_BLINDSPOT_LOOKBACK_DAYS,
  NEAR_BLINDSPOT_MIN_SHARE,
  NEAR_BLINDSPOT_PREFILTER_TOLERANCE,
  NEAR_BLINDSPOT_SURVIVOR_CAP,
  isNearBlindspotTally,
  nearSharePercent,
  storedDistributionMayBeNear,
} from "./near-blindspot-rule";

function tally(
  overrides: Partial<Parameters<typeof isNearBlindspotTally>[0]> = {},
): Parameters<typeof isNearBlindspotTally>[0] {
  return { total: 5, dominantZone: "iktidar", dominantShare: 0.75, ...overrides };
}

describe("near-blindspot constants", () => {
  it("pins the band, the display cap, the safety bounds and the lookback", () => {
    expect(NEAR_BLINDSPOT_MIN_SHARE).toBe(0.7);
    expect(NEAR_BLINDSPOT_DISPLAY_LIMIT).toBe(10);
    // A safety bound on Step A, not a sample: the band is pre-tested on the
    // stored distribution, so every qualifying story of the window is reached.
    expect(NEAR_BLINDSPOT_CANDIDATE_SAFETY_CAP).toBe(1000);
    expect(NEAR_BLINDSPOT_PREFILTER_TOLERANCE).toBe(0.05);
    expect(NEAR_BLINDSPOT_SURVIVOR_CAP).toBe(200);
    expect(NEAR_BLINDSPOT_LOOKBACK_DAYS).toBe(7);
  });

  it("keeps the survivor cap well inside the safety cap", () => {
    expect(NEAR_BLINDSPOT_SURVIVOR_CAP).toBeLessThan(NEAR_BLINDSPOT_CANDIDATE_SAFETY_CAP);
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

// ---------------------------------------------------------------------------
// Step-A pre-filter: the share band is tested on the STORED bias_distribution
// (voting kinds only, written by cluster-consumer) BEFORE any cap, with a
// +-0.05 tolerance for stored-vs-live drift. The live toNearItem re-tally in
// near-blindspots-query.ts stays the authority; this only decides who is worth
// embedding.
// ---------------------------------------------------------------------------

/** iktidar / bagimsiz / muhalefet counts as a stored bias_distribution jsonb. */
function zones(iktidar: number, bagimsiz: number, muhalefet: number) {
  return {
    pro_government: iktidar,
    center: bagimsiz,
    opposition: muhalefet,
  };
}

describe("storedDistributionMayBeNear", () => {
  it("keeps an in-band stored distribution (7/1/1 -> 0.778 of 9)", () => {
    expect(storedDistributionMayBeNear(zones(7, 1, 1))).toBe(true);
  });

  it("keeps the opposition-dominated mirror (0/2/5 -> 0.714 of 7)", () => {
    expect(storedDistributionMayBeNear(zones(0, 2, 5))).toBe(true);
  });

  it("drops clearly out-of-band distributions (9/0/0 and 3/3/3)", () => {
    expect(storedDistributionMayBeNear(zones(9, 0, 0))).toBe(false);
    expect(storedDistributionMayBeNear(zones(3, 3, 3))).toBe(false);
  });

  it("tolerates drift below the band: 13/20 = 0.65 kept, 12/19 = 0.632 dropped", () => {
    expect(storedDistributionMayBeNear(zones(13, 0, 7))).toBe(true);
    expect(storedDistributionMayBeNear(zones(12, 0, 7))).toBe(false);
  });

  it("tolerates drift above the band: 16/20 = 0.80 kept, 17/20 = 0.85 dropped (upper edge exclusive)", () => {
    expect(storedDistributionMayBeNear(zones(16, 0, 4))).toBe(true);
    expect(storedDistributionMayBeNear(zones(17, 0, 3))).toBe(false);
  });

  it("drops a stored total below BLINDSPOT.minSources even inside the band (3/4 = 0.75)", () => {
    expect(BLINDSPOT.minSources).toBe(5);
    expect(storedDistributionMayBeNear(zones(3, 0, 1))).toBe(false);
  });

  it("keeps a stored total of exactly BLINDSPOT.minSources inside the band (4/5 = 0.8 is tolerated)", () => {
    expect(storedDistributionMayBeNear(zones(4, 0, 1))).toBe(true);
  });

  it("zones every bias key through BIAS_TO_ZONE (nationalist counts for iktidar)", () => {
    expect(
      storedDistributionMayBeNear({
        nationalist: 4,
        islamist_conservative: 3,
        international: 1,
        opposition_leaning: 1,
      }),
    ).toBe(true); // 7/9 iktidar
  });

  it("keeps a row whose distribution is unusable, so the live embed decides", () => {
    for (const raw of [
      null,
      undefined,
      "not json",
      42,
      [],
      {},
      { pro_government: "7" },
      { pro_government: Number.NaN, opposition: Number.POSITIVE_INFINITY },
      { unknown_key: 9 },
      { pro_government: -3 },
    ]) {
      expect(storedDistributionMayBeNear(raw)).toBe(true);
    }
  });

  it("ignores non-numeric entries next to usable ones (usable part decides)", () => {
    expect(
      storedDistributionMayBeNear({ pro_government: 9, opposition: "junk" }),
    ).toBe(false); // 9/0/0 -> 1.0, out of band
    expect(
      storedDistributionMayBeNear({ pro_government: 7, center: 1, opposition: 1, nationalist: null }),
    ).toBe(true);
  });
});
