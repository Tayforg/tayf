import { describe, expect, it } from "vitest";

import { emptyBiasDistribution } from "@/lib/bias/analyzer";
import { BLINDSPOT, SURPRISE, zoneOf } from "@/lib/bias/config";
import type { BiasCategory, BiasDistribution, MediaDnaZone } from "@/types";

import {
  BALANCE_BALANCED_MAX_SHARE,
  BALANCE_BALANCED_MIN,
  BALANCE_INSUFFICIENT_LABEL,
  BALANCE_LABELS,
  BALANCE_MIN_SOURCES,
  BALANCE_ONE_SIDED_MAX,
  BALANCE_TWO_ZONE_MIN_SHARE,
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

  it("pins the smaller-zone share an even two-zone split needs", () => {
    expect(BALANCE_TWO_ZONE_MIN_SHARE).toBe(0.4);
  });

  it("keeps the Turkish tier labels exact", () => {
    expect(BALANCE_LABELS).toEqual({
      dengeli: "Dengeli kapsama",
      iki: "İki tarafa dengeli",
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

  // INTENDED FLIP (hunt-20 numbers-2): an even two-way split used to be called
  // "Tek tarafa yakın" (near one-sided), which is a false claim about coverage
  // spread evenly over two camps. The score is unchanged (63); only the word is.
  it("scores an even two-way split 63 (100 * ln 2 / ln 3) as İki tarafa dengeli", () => {
    expect(balanceFromZoneCounts(zones(3, 3, 0))).toEqual({
      score: 63,
      tier: "iki",
      label: "İki tarafa dengeli",
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

describe("balanceFromZoneCounts — İki tarafa dengeli tier", () => {
  it("labels İktidar 4 / Muhalefet 4 as iki, not Tek tarafa yakın (score stays 63)", () => {
    expect(balanceFromZoneCounts(zones(4, 0, 4))).toEqual({
      score: 63,
      tier: "iki",
      label: "İki tarafa dengeli",
      total: 8,
    });
  });

  it("labels 5 / 0 / 4 as iki (score 63)", () => {
    const b = balanceFromZoneCounts(zones(5, 0, 4));
    expect(b?.tier).toBe("iki");
    expect(b?.label).toBe("İki tarafa dengeli");
    expect(b?.score).toBe(63);
  });

  it("includes the 40% boundary: 0 / 3 / 2 is iki", () => {
    const b = balanceFromZoneCounts(zones(0, 3, 2));
    expect(2 / 5).toBe(BALANCE_TWO_ZONE_MIN_SHARE);
    expect(b?.tier).toBe("iki");
    expect(b?.score).toBe(61);
  });

  it("does not care which two zones split the coverage", () => {
    expect(balanceFromZoneCounts(zones(4, 4, 0))?.tier).toBe("iki");
    expect(balanceFromZoneCounts(zones(0, 4, 4))?.tier).toBe("iki");
    expect(balanceFromZoneCounts(zones(4, 0, 4))?.tier).toBe("iki");
  });

  it("stays Tek tarafa yakın just below the 40% share (8 of 21 = 38%)", () => {
    const b = balanceFromZoneCounts(zones(13, 0, 8));
    expect(8 / 21).toBeLessThan(BALANCE_TWO_ZONE_MIN_SHARE);
    expect(b?.tier).toBe("yakin");
    expect(b?.label).toBe("Tek tarafa yakın");
  });

  it("keeps a lopsided two-zone cluster Tek tarafa yakın: 7 / 1 / 0 (score 34)", () => {
    expect(balanceFromZoneCounts(zones(7, 1, 0))).toEqual({
      score: 34,
      tier: "yakin",
      label: "Tek tarafa yakın",
      total: 8,
    });
  });

  it("keeps 4 / 1 / 0 Tek tarafa yakın (the smaller zone holds 20%)", () => {
    const b = balanceFromZoneCounts(zones(4, 1, 0));
    expect(b?.tier).toBe("yakin");
    expect(b?.score).toBe(46);
  });

  it("keeps a three-zone cluster that scores 34-66 Tek tarafa yakın: 7 / 1 / 1", () => {
    const b = balanceFromZoneCounts(zones(7, 1, 1));
    expect(b?.score).toBeGreaterThan(BALANCE_ONE_SIDED_MAX);
    expect(b?.score).toBeLessThan(BALANCE_BALANCED_MIN);
    expect(b?.tier).toBe("yakin");
  });

  it("keeps 3 / 3 / 3 Dengeli kapsama", () => {
    expect(balanceFromZoneCounts(zones(3, 3, 3))).toEqual({
      score: 100,
      tier: "dengeli",
      label: "Dengeli kapsama",
      total: 9,
    });
  });

  it("keeps 9 / 0 / 0 and 9 / 1 / 0 Tek tarafta", () => {
    expect(balanceFromZoneCounts(zones(9, 0, 0))?.tier).toBe("tek");
    expect(balanceFromZoneCounts(zones(9, 1, 0))?.tier).toBe("tek");
  });

  it("counts a zone as non-zero only after sanitising (NaN / negative are not votes)", () => {
    // 3 / NaN / 3 -> 3 / 0 / 3: two real zones, an even split.
    expect(balanceFromZoneCounts(zones(3, Number.NaN, 3))?.tier).toBe("iki");
    // 4 / -2 / 4 -> 4 / 0 / 4, still two zones.
    expect(balanceFromZoneCounts(zones(4, -2, 4))?.tier).toBe("iki");
    // 6 / -1 / 0 -> single zone.
    expect(balanceFromZoneCounts(zones(6, -1, 0))?.tier).toBe("tek");
  });

  it("is scale invariant: doubling an even two-zone split stays iki", () => {
    expect(balanceFromZoneCounts(zones(8, 0, 8))?.tier).toBe("iki");
    expect(balanceFromZoneCounts(zones(1_000_000, 0, 1_000_000))?.tier).toBe("iki");
  });

  it("never changes a score: iki is a label, not a re-score", () => {
    expect(balanceFromZoneCounts(zones(4, 0, 4))?.score).toBe(63);
    expect(balanceFromZoneCounts(zones(5, 0, 4))?.score).toBe(63);
    expect(balanceFromZoneCounts(zones(0, 3, 2))?.score).toBe(61);
    expect(balanceFromZoneCounts(zones(7, 1, 0))?.score).toBe(34);
    expect(balanceFromZoneCounts(zones(3, 3, 3))?.score).toBe(100);
    expect(balanceFromZoneCounts(zones(9, 0, 0))?.score).toBe(0);
  });
});

// hunt-59 homefeed-2: "Dengeli kapsama" used to print for stories where one
// zone held 65-75% of the voting sources, on the same page where the Sürpriz
// caption (cross-spectrum.ts, SURPRISE.dominantShare) calls that zone dominant.
// A score of 67+ now earns the word only when no zone reaches that same share.
// The score number itself never changes.
describe("balanceFromZoneCounts — Dengeli kapsama needs no dominant zone", () => {
  it("pins the cap to the surprise detector's dominantShare (0.65)", () => {
    expect(BALANCE_BALANCED_MAX_SHARE).toBe(SURPRISE.dominantShare);
    expect(BALANCE_BALANCED_MAX_SHARE).toBe(0.65);
  });

  it("flips 6 / 1 / 1 (score 67, share 75%) to Tek tarafa yakın", () => {
    expect(balanceFromZoneCounts(zones(6, 1, 1))).toEqual({
      score: 67,
      tier: "yakin",
      label: "Tek tarafa yakın",
      total: 8,
    });
  });

  it("flips 21 / 4 / 4 (cluster 691fff02: score 71, share 72%) to Tek tarafa yakın", () => {
    expect(balanceFromZoneCounts(zones(21, 4, 4))).toEqual({
      score: 71,
      tier: "yakin",
      label: "Tek tarafa yakın",
      total: 29,
    });
  });

  it("flips 5 / 1 / 1 (score 72, share 71%) to Tek tarafa yakın", () => {
    const b = balanceFromZoneCounts(zones(5, 1, 1));
    expect(b?.score).toBe(72);
    expect(b?.tier).toBe("yakin");
  });

  it("flips the dominant zone no matter which zone it is", () => {
    expect(balanceFromZoneCounts(zones(1, 6, 1))?.tier).toBe("yakin");
    expect(balanceFromZoneCounts(zones(1, 1, 6))?.tier).toBe("yakin");
  });

  it("keeps 9 / 2 / 3 (score 81, share 64.3%) Dengeli kapsama", () => {
    const b = balanceFromZoneCounts(zones(9, 2, 3));
    expect(9 / 14).toBeLessThan(BALANCE_BALANCED_MAX_SHARE);
    expect(b).toEqual({
      score: 81,
      tier: "dengeli",
      label: "Dengeli kapsama",
      total: 14,
    });
  });

  it("keeps 4 / 3 / 1 (share 50%) Dengeli kapsama", () => {
    const b = balanceFromZoneCounts(zones(4, 3, 1));
    expect(b?.score).toBe(89);
    expect(b?.tier).toBe("dengeli");
  });

  it("keeps an even three-way split (score 100, share 33%) Dengeli kapsama at any size", () => {
    // 1 / 1 / 1 would be the smallest even split but N = 3 is under the floor.
    expect(balanceFromZoneCounts(zones(1, 1, 1))).toBeNull();
    expect(balanceFromZoneCounts(zones(2, 2, 2))?.tier).toBe("dengeli");
    expect(balanceFromZoneCounts(zones(3, 3, 3))?.tier).toBe("dengeli");
    expect(balanceFromZoneCounts(zones(2, 2, 2))?.score).toBe(100);
  });

  it("cuts at exactly the dominant share: 13 / 4 / 3 (65%) flips, 9 / 2 / 3 (64.3%) does not", () => {
    // Same boundary as detectCrossSpectrum: `share >= dominantShare` is dominant.
    const atCut = balanceFromZoneCounts(zones(13, 4, 3));
    expect(13 / 20).toBe(BALANCE_BALANCED_MAX_SHARE);
    expect(atCut?.score).toBeGreaterThanOrEqual(BALANCE_BALANCED_MIN);
    expect(atCut?.tier).toBe("yakin");
    expect(balanceFromZoneCounts(zones(9, 2, 3))?.tier).toBe("dengeli");
  });

  it("is scale invariant: doubling 6 / 1 / 1 and 9 / 2 / 3 keeps each side of the cut", () => {
    expect(balanceFromZoneCounts(zones(12, 2, 2))?.tier).toBe("yakin");
    expect(balanceFromZoneCounts(zones(18, 4, 6))?.tier).toBe("dengeli");
  });

  it("never changes a score: only the word moves", () => {
    expect(balanceFromZoneCounts(zones(6, 1, 1))?.score).toBe(67);
    expect(balanceFromZoneCounts(zones(21, 4, 4))?.score).toBe(71);
    expect(balanceFromZoneCounts(zones(9, 2, 3))?.score).toBe(81);
    expect(balanceFromZoneCounts(zones(6, 2, 0))?.score).toBe(51);
  });

  it("leaves Tek tarafa yakın at the same 75% share unchanged: 6 / 2 / 0 (score 51)", () => {
    // The old inconsistency: (6,1,1) scored 67 "dengeli" while (6,2,0) scored
    // 51 "yakin", both 75% in one zone.
    const b = balanceFromZoneCounts(zones(6, 2, 0));
    expect(b?.tier).toBe("yakin");
    expect(b?.label).toBe("Tek tarafa yakın");
    expect(balanceFromZoneCounts(zones(6, 1, 1))?.label).toBe(b?.label);
  });

  it("leaves the iki and tek rules alone", () => {
    expect(balanceFromZoneCounts(zones(5, 5, 0))?.tier).toBe("iki");
    expect(balanceFromZoneCounts(zones(4, 0, 4))?.tier).toBe("iki");
    expect(balanceFromZoneCounts(zones(9, 1, 0))?.tier).toBe("tek");
    expect(balanceFromZoneCounts(zones(9, 0, 0))?.tier).toBe("tek");
  });

  it("names the new tier in the aria text", () => {
    expect(balanceAriaLabel(balanceFromZoneCounts(zones(21, 4, 4)))).toBe(
      "Denge puanı 71/100: Tek tarafa yakın",
    );
  });

  it("keeps balanceTier score-only: the share rule lives in balanceFromZoneCounts", () => {
    expect(balanceTier(67)).toBe("dengeli");
    expect(balanceTier(71)).toBe("dengeli");
  });

  it("reaches the same verdict through balanceFromDistribution (card and cluster page path)", () => {
    // pro_government 10 + gov_leaning 9 + 2 more iktidar-zone categories = 21,
    // center 4, opposition_leaning 4: the 691fff02 zone vector.
    const d: BiasDistribution = {
      ...emptyBiasDistribution(),
      pro_government: 10,
      gov_leaning: 9,
      state_media: 2,
      center: 4,
      opposition_leaning: 4,
    };
    expect(balanceFromDistribution(d)).toEqual({
      score: 71,
      tier: "yakin",
      label: "Tek tarafa yakın",
      total: 29,
    });
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
  // balanceTier stays score-only: it never returns "iki", which needs the
  // zone counts (see balanceFromZoneCounts).
  it("cuts at 67 / 34 inclusive", () => {
    expect(balanceTier(100)).toBe("dengeli");
    expect(balanceTier(67)).toBe("dengeli");
    expect(balanceTier(66)).toBe("yakin");
    expect(balanceTier(50)).toBe("yakin");
    expect(balanceTier(34)).toBe("yakin");
    expect(balanceTier(33)).toBe("tek");
    expect(balanceTier(0)).toBe("tek");
  });

  it("never returns iki from a score alone", () => {
    for (let score = 0; score <= 100; score += 1) {
      expect(balanceTier(score)).not.toBe("iki");
    }
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
    expect(balanceAriaLabel(balanceFromZoneCounts(zones(4, 0, 4)))).toBe(
      "Denge puanı 63/100: İki tarafa dengeli",
    );
  });

  it("explains the missing score for null", () => {
    expect(balanceAriaLabel(null)).toBe(
      "Denge puanı yok: Az kaynak (en az 5 sınıflandırılmış kaynak gerekir)",
    );
  });
});
