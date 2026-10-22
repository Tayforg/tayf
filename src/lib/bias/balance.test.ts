import { describe, expect, it } from "vitest";

import { emptyBiasDistribution } from "@/lib/bias/analyzer";
import { BLINDSPOT, zoneOf } from "@/lib/bias/config";
import type { BiasCategory, BiasDistribution, MediaDnaZone } from "@/types";

import {
  BALANCE_BALANCED_MIN,
  BALANCE_INSUFFICIENT_LABEL,
  BALANCE_LABELS,
  BALANCE_MIN_SOURCES,
  BALANCE_ONE_SIDED_MAX,
  balanceAriaLabel,
  balanceFromDistribution,
  balanceFromZoneCounts,
  balanceTier,
} from "./balance";

function zones(
  iktidar: number,
  bagimsiz: number,
  muhalefet: number,
): Record<MediaDnaZone, number> {
  return { iktidar, bagimsiz, muhalefet };
}

describe("balance constants", () => {
  it("pins the tier thresholds and the source floor to the blindspot contract", () => {
    expect(BALANCE_BALANCED_MIN).toBe(67);
    expect(BALANCE_ONE_SIDED_MAX).toBe(33);
    expect(BALANCE_MIN_SOURCES).toBe(BLINDSPOT.minSources);
    expect(BALANCE_MIN_SOURCES).toBe(5);
  });

  it("keeps the Turkish tier labels exact", () => {
    expect(BALANCE_LABELS).toEqual({
      dengeli: "Dengeli kapsama",
      yakin: "Tek tarafa yakın",
      tek: "Tek tarafta",
    });
    expect(BALANCE_INSUFFICIENT_LABEL).toBe("Az kaynak");
  });
});

describe("balanceFromZoneCounts — normalised Shannon entropy", () => {
  it("scores a single zone 0 and labels it Tek tarafta", () => {
    const b = balanceFromZoneCounts(zones(5, 0, 0));
    expect(b).toEqual({
      score: 0,
      tier: "tek",
      label: "Tek tarafta",
      total: 5,
    });
  });

  it("scores an even three-way split 100 and labels it Dengeli kapsama", () => {
    const b = balanceFromZoneCounts(zones(2, 2, 2));
    expect(b).toEqual({
      score: 100,
      tier: "dengeli",
      label: "Dengeli kapsama",
      total: 6,
    });
  });

  it("scores an even two-way split 63 (100 * ln 2 / ln 3) as Tek tarafa yakın", () => {
    expect(balanceFromZoneCounts(zones(3, 3, 0))).toEqual({
      score: 63,
      tier: "yakin",
      label: "Tek tarafa yakın",
      total: 6,
    });
  });

  it("does not care which two zones split the coverage", () => {
    expect(balanceFromZoneCounts(zones(0, 3, 3))?.score).toBe(63);
    expect(balanceFromZoneCounts(zones(3, 0, 3))?.score).toBe(63);
    expect(balanceFromZoneCounts(zones(3, 3, 0))?.score).toBe(63);
  });

  it("does not care which zone carries which count (permutation invariant)", () => {
    const a = balanceFromZoneCounts(zones(4, 1, 0));
    const b = balanceFromZoneCounts(zones(0, 4, 1));
    const c = balanceFromZoneCounts(zones(1, 0, 4));
    expect(a?.score).toBe(46);
    expect(b?.score).toBe(46);
    expect(c?.score).toBe(46);
  });

  it("matches hand-computed values for skewed splits", () => {
    // p = (.8, .2): H = .5004 nats -> 100 * .5004 / 1.0986 = 45.55 -> 46
    expect(balanceFromZoneCounts(zones(4, 1, 0))?.score).toBe(46);
    // p = (.9, .1): H = .3251 nats -> 29.59 -> 30
    const nineToOne = balanceFromZoneCounts(zones(9, 1, 0));
    expect(nineToOne?.score).toBe(30);
    expect(nineToOne?.tier).toBe("tek");
    // p = (.4, .4, .2): H = 1.0549 nats -> 96.02 -> 96
    expect(balanceFromZoneCounts(zones(2, 2, 1))?.score).toBe(96);
  });

  it("is scale invariant: doubling every count leaves the score unchanged", () => {
    expect(balanceFromZoneCounts(zones(8, 2, 0))?.score).toBe(
      balanceFromZoneCounts(zones(4, 1, 0))?.score,
    );
  });

  it("reports the vote total it was computed from", () => {
    expect(balanceFromZoneCounts(zones(7, 2, 1))?.total).toBe(10);
  });
});

describe("balanceFromZoneCounts — source floor", () => {
  it("returns null below the minimum source count", () => {
    expect(balanceFromZoneCounts(zones(2, 1, 1))).toBeNull(); // N = 4
    expect(balanceFromZoneCounts(zones(0, 0, 0))).toBeNull();
    expect(balanceFromZoneCounts(zones(1, 0, 0))).toBeNull();
  });

  it("scores exactly at the floor", () => {
    const b = balanceFromZoneCounts(zones(3, 1, 1)); // N = 5
    expect(b).not.toBeNull();
    expect(b?.total).toBe(BALANCE_MIN_SOURCES);
  });
});

describe("balanceFromZoneCounts — hostile input", () => {
  it("treats negative counts as 0", () => {
    // -4 -> 0, leaving {5, 0, 0}
    expect(balanceFromZoneCounts(zones(5, -4, 0))).toEqual({
      score: 0,
      tier: "tek",
      label: "Tek tarafta",
      total: 5,
    });
  });

  it("treats NaN and infinite counts as 0", () => {
    const b = balanceFromZoneCounts(zones(3, Number.NaN, 3));
    expect(b?.score).toBe(63);
    expect(b?.total).toBe(6);
    expect(balanceFromZoneCounts(zones(5, Number.POSITIVE_INFINITY, 0))?.score).toBe(0);
    expect(balanceFromZoneCounts(zones(5, Number.NEGATIVE_INFINITY, 0))?.total).toBe(5);
  });

  it("returns null when sanitising leaves fewer than the floor", () => {
    expect(balanceFromZoneCounts(zones(Number.NaN, -3, 2))).toBeNull();
  });

  it("never returns -0 for a single zone", () => {
    const b = balanceFromZoneCounts(zones(0, 0, 9));
    expect(b).not.toBeNull();
    expect(Object.is(b?.score, 0)).toBe(true);
  });

  it("stays inside 0..100 for large counts", () => {
    const b = balanceFromZoneCounts(zones(1_000_000, 1_000_000, 1_000_000));
    expect(b?.score).toBe(100);
    expect(b?.total).toBe(3_000_000);
  });
});

describe("balanceTier", () => {
  it("cuts at 67 / 34 inclusive", () => {
    expect(balanceTier(100)).toBe("dengeli");
    expect(balanceTier(67)).toBe("dengeli");
    expect(balanceTier(66)).toBe("yakin");
    expect(balanceTier(50)).toBe("yakin");
    expect(balanceTier(34)).toBe("yakin");
    expect(balanceTier(33)).toBe("tek");
    expect(balanceTier(0)).toBe("tek");
  });
});

describe("balanceFromDistribution — same basis as BiasSpectrum's compact bar", () => {
  function dist(partial: Partial<BiasDistribution>): BiasDistribution {
    return { ...emptyBiasDistribution(), ...partial };
  }

  // The loop BiasSpectrum runs for `compact`: collapse the 10 categories
  // onto the 3 zones with zoneOf.
  function spectrumZones(d: BiasDistribution): Record<MediaDnaZone, number> {
    const out = zones(0, 0, 0);
    for (const [bias, count] of Object.entries(d) as Array<[BiasCategory, number]>) {
      out[zoneOf(bias)] += count;
    }
    return out;
  }

  it("equals balanceFromZoneCounts of the zone sums the spectrum shows (mixed 10-category dist)", () => {
    const d = dist({
      pro_government: 2,
      gov_leaning: 1,
      state_media: 1,
      islamist_conservative: 1,
      nationalist: 2,
      center: 3,
      international: 1,
      pro_kurdish: 1,
      opposition_leaning: 2,
      opposition: 1,
    });
    const shown = spectrumZones(d);
    expect(shown).toEqual({ iktidar: 7, bagimsiz: 5, muhalefet: 3 });
    expect(balanceFromDistribution(d)).toEqual(balanceFromZoneCounts(shown));
    expect(balanceFromDistribution(d)).not.toBeNull();
  });

  it("collapses categories inside a zone: 3 + 3 across two iktidar categories is one side", () => {
    const d = dist({ pro_government: 3, nationalist: 3 });
    expect(balanceFromDistribution(d)?.score).toBe(0);
  });

  it("returns null for an empty or under-floor distribution", () => {
    expect(balanceFromDistribution(dist({}))).toBeNull();
    expect(balanceFromDistribution(dist({ pro_government: 2, opposition: 2 }))).toBeNull();
  });

  it("scores a three-zone distribution 100 when each zone has the same weight", () => {
    const d = dist({ gov_leaning: 2, international: 2, opposition: 2 });
    expect(balanceFromDistribution(d)?.score).toBe(100);
  });
});

describe("balanceAriaLabel", () => {
  it("names the score and the tier label", () => {
    expect(balanceAriaLabel(balanceFromZoneCounts(zones(2, 2, 2)))).toBe(
      "Denge puanı 100/100: Dengeli kapsama",
    );
    expect(balanceAriaLabel(balanceFromZoneCounts(zones(9, 1, 0)))).toBe(
      "Denge puanı 30/100: Tek tarafta",
    );
  });

  it("explains the missing score for null", () => {
    expect(balanceAriaLabel(null)).toBe(
      "Denge puanı yok: Az kaynak (en az 5 sınıflandırılmış kaynak gerekir)",
    );
  });
});
