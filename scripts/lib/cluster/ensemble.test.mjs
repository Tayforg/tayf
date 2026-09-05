import { describe, it, expect } from "vitest";
import { score, isMatch, MATCH_THRESHOLD } from "./ensemble.mjs";
import {
  TFIDF_WEIGHT,
  ENTITY_WEIGHT,
  ENTITY_DENOM_MIN,
  ENTITY_FRESHNESS_HOURS,
  TIME_WINDOW_HOURS,
  MINHASH_SOFT_ACCEPT_JACCARD,
} from "./constants.mjs";

// Helper: build a synthetic fingerprint bundle with a Uint32Array signature
// where `matching` slots match the baseline. Lets us drive the ensemble with
// an exact Jaccard fraction.
function mkFpPair(k, matching, strictA = "a", strictB = "b") {
  const a = new Uint32Array(k);
  const b = new Uint32Array(k);
  for (let i = 0; i < k; i++) {
    a[i] = 1000 + i;
    b[i] = i < matching ? a[i] : 9000 + i;
  }
  return [
    { strict: strictA, shingles: new Set(), signature: a },
    { strict: strictB, shingles: new Set(), signature: b },
  ];
}

describe("score — strict fingerprint auto-accept", () => {
  it("returns score=1.0 and autoAccept=true for identical strict fingerprints", () => {
    const [fpA, fpB] = mkFpPair(64, 0, "same_hash", "same_hash");
    const r = score(fpA, fpB, ["x"], ["y"], 0.5, 1.0);
    expect(r.score).toBe(1.0);
    expect(r.components.autoAccept).toBe(true);
  });

  it("does NOT auto-accept when strict is null on either side", () => {
    const [fpA, fpB] = mkFpPair(64, 0);
    fpA.strict = null;
    fpB.strict = null;
    const r = score(fpA, fpB, [], [], 0, 0);
    expect(r.components.autoAccept).toBe(false);
    expect(r.score).toBeLessThan(1.0);
  });

  it("applies source penalty even to auto-accepted wire copy (A8 fix)", () => {
    const [fpA, fpB] = mkFpPair(64, 0, "same_hash", "same_hash");
    const r = score(fpA, fpB, [], [], 0, 0, {
      aSourceSlug: "haberler-com",
    });
    // haberler-com → penalty 0.85, applied to the 1.0 auto-accept score.
    expect(r.score).toBeCloseTo(0.85, 10);
    expect(r.components.autoAccept).toBe(true);
    expect(r.components.sourcePenalty).toBe(0.85);
  });
});

describe("score — MinHash Jaccard lane", () => {
  it("computes Jaccard from signatures — 48/64 → 0.75", () => {
    const [fpA, fpB] = mkFpPair(64, 48);
    const r = score(fpA, fpB, [], [], 0, 0);
    expect(r.components.jaccard).toBeCloseTo(0.75, 10);
  });

  it("applies the soft-accept ceiling shape above the threshold", () => {
    // At J=0.75 ≥ MINHASH_SOFT_ACCEPT_JACCARD (0.5), jaccardScore = 0.6 + 0.4*J = 0.9.
    const [fpA, fpB] = mkFpPair(64, 48); // J = 0.75
    const r = score(fpA, fpB, [], [], 0, 0);
    expect(r.components.jaccardScore).toBeCloseTo(0.6 + 0.4 * 0.75, 10);
  });

  it("applies the 0.5*J fallback below the soft-accept floor", () => {
    // MINHASH_SOFT_ACCEPT_JACCARD is 0.5 in the current tuning. Pick J=0.25
    // which is strictly below to land in the fallback branch.
    const [fpA, fpB] = mkFpPair(64, 16); // J = 16/64 = 0.25
    const r = score(fpA, fpB, [], [], 0, 0);
    expect(r.components.jaccard).toBeCloseTo(0.25, 10);
    expect(MINHASH_SOFT_ACCEPT_JACCARD).toBeGreaterThan(0.25);
    expect(r.components.jaccardScore).toBeCloseTo(0.5 * 0.25, 10);
  });

  it("jaccard=0 yields jaccardScore=0 in the fallback branch", () => {
    const [fpA, fpB] = mkFpPair(64, 0);
    const r = score(fpA, fpB, [], [], 0, 0);
    expect(r.components.jaccard).toBe(0);
    expect(r.components.jaccardScore).toBe(0);
  });

  it("MinHash lane wins via max() when primary is weaker", () => {
    // J=1.0 → jaccardScore = 0.6 + 0.4 = 1.0; tfidf=0, entities disjoint → primary ≈ 0.
    const [fpA, fpB] = mkFpPair(64, 64); // J = 1.0
    const r = score(fpA, fpB, ["x"], ["y"], 0, 0);
    expect(r.components.jaccardScore).toBeCloseTo(1.0, 10);
    expect(r.components.raw).toBeCloseTo(1.0, 10);
    // timeDecay = 1 at Δt=0, sourcePenalty = 1 (no opts) → final = 1.0.
    expect(r.score).toBeCloseTo(1.0, 10);
  });
});

describe("score — entity ratio (R2 min-denominator + noise floor)", () => {
  it("returns 0 entityRatio for empty entity sets", () => {
    const [fpA, fpB] = mkFpPair(64, 0);
    const r = score(fpA, fpB, [], [], 0, 0);
    expect(r.components.sharedEntities).toBe(0);
    expect(r.components.entityRatioRaw).toBe(0);
    expect(r.components.entityRatio).toBe(0);
  });

  it("uses min(|A|,|B|) with noise floor 3 as denominator", () => {
    // |A|=3, |B|=3, shared=2. denom = max(3, min(3,3)) = 3. rawRatio = 2/3.
    const [fpA, fpB] = mkFpPair(64, 0);
    const r = score(
      fpA,
      fpB,
      ["mhp", "istanbul", "teskilat"],
      ["mhp", "istanbul", "semih"],
      0,
      0,
    );
    expect(r.components.sharedEntities).toBe(2);
    expect(r.components.entityRatioRaw).toBeCloseTo(2 / 3, 10);
  });

  it("noise floor prevents 2∩2=2 from scoring 1.0 for free", () => {
    // |A|=2, |B|=2, shared=2. Without the floor: 2/min(2,2)=1.0.
    // With floor max(3,2)=3 → 2/3 ≈ 0.667.
    expect(ENTITY_DENOM_MIN).toBe(3);
    const [fpA, fpB] = mkFpPair(64, 0);
    const r = score(fpA, fpB, ["x", "y"], ["x", "y"], 0, 0);
    expect(r.components.sharedEntities).toBe(2);
    expect(r.components.entityRatioRaw).toBeCloseTo(2 / 3, 10);
  });

  it("rewards tight small-set overlap — shared/min not shared/max (R2 fix)", () => {
    // |A|=3, |B|=10, shared=3. Old bug: shared/max(A,B) = 3/10 = 0.3 → gets penalized.
    // R2 fix: shared/max(3, min(3,10)) = 3/3 = 1.0.
    const [fpA, fpB] = mkFpPair(64, 0);
    const small = ["mhp", "istanbul", "teskilat"];
    const big = ["mhp", "istanbul", "teskilat", "a", "b", "c", "d", "e", "f", "g"];
    const r = score(fpA, fpB, small, big, 0, 0);
    expect(r.components.sharedEntities).toBe(3);
    expect(r.components.entityRatioRaw).toBeCloseTo(1.0, 10);
  });

  it("accepts Set as entity input (not just array)", () => {
    const [fpA, fpB] = mkFpPair(64, 0);
    const r = score(
      fpA,
      fpB,
      new Set(["x", "y", "z"]),
      new Set(["x", "y", "z"]),
      0,
      0,
    );
    expect(r.components.sharedEntities).toBe(3);
  });
});

describe("score — entity freshness decay (A1 fix)", () => {
  it("entityFreshness = 1.0 at Δt=0", () => {
    const [fpA, fpB] = mkFpPair(64, 0);
    const r = score(fpA, fpB, ["x", "y", "z"], ["x", "y", "z"], 0, 0);
    expect(r.components.entityFreshness).toBeCloseTo(1.0, 10);
  });

  it("entityFreshness decays linearly until the 0.5 floor", () => {
    // At Δt = ENTITY_FRESHNESS_HOURS/2, freshness = 1 - 0.5 = 0.5 (floor).
    // Actually: max(0.5, 1 - Δt/window). At Δt=window/2: 1 - 0.5 = 0.5 → floor engages.
    // Pick Δt=1h to stay above the floor with window=6h: 1 - 1/6 ≈ 0.833.
    const [fpA, fpB] = mkFpPair(64, 0);
    const r = score(fpA, fpB, ["x", "y", "z"], ["x", "y", "z"], 0, 1);
    expect(r.components.entityFreshness).toBeCloseTo(1 - 1 / ENTITY_FRESHNESS_HOURS, 10);
    expect(r.components.entityFreshness).toBeGreaterThan(0.5);
  });

  it("entityFreshness holds at 0.5 floor for large Δt", () => {
    const [fpA, fpB] = mkFpPair(64, 0);
    const r = score(fpA, fpB, ["x", "y", "z"], ["x", "y", "z"], 0, 1000);
    expect(r.components.entityFreshness).toBeCloseTo(0.5, 10);
  });

  it("entityRatio is entityRatioRaw * entityFreshness (clipped)", () => {
    const [fpA, fpB] = mkFpPair(64, 0);
    const r = score(
      fpA,
      fpB,
      ["x", "y", "z"],
      ["x", "y", "z"], // shared=3, denom=3 → raw=1.0
      0,
      1, // freshness = 1 - 1/6 = 0.833
    );
    expect(r.components.entityRatioRaw).toBeCloseTo(1.0, 10);
    expect(r.components.entityRatio).toBeCloseTo(1 - 1 / ENTITY_FRESHNESS_HOURS, 10);
  });
});

describe("score — primary lane weighting", () => {
  it("primary = TFIDF_WEIGHT * tfidf + ENTITY_WEIGHT * entityRatio", () => {
    const [fpA, fpB] = mkFpPair(64, 0); // J=0 → jaccardScore=0
    const r = score(fpA, fpB, ["x", "y", "z"], ["x", "y", "z"], 0.5, 0);
    // entityRatioRaw = 3/3 = 1.0, freshness=1.0 → entityRatio = 1.0
    // tfidfScore = 0.5
    // primary = 0.40*0.5 + 0.60*1.0 = 0.20 + 0.60 = 0.80
    const expected = TFIDF_WEIGHT * 0.5 + ENTITY_WEIGHT * 1.0;
    expect(r.components.primary).toBeCloseTo(expected, 10);
  });

  it("raw = max(jaccardScore, primary)", () => {
    // Primary = 0.8 (as computed above), jaccardScore = 0 → raw = 0.8.
    const [fpA, fpB] = mkFpPair(64, 0);
    const r = score(fpA, fpB, ["x", "y", "z"], ["x", "y", "z"], 0.5, 0);
    expect(r.components.raw).toBeCloseTo(
      Math.max(r.components.jaccardScore, r.components.primary),
      10,
    );
  });
});

describe("score — time decay", () => {
  it("timeDecay = 1.0 at Δt=0", () => {
    const [fpA, fpB] = mkFpPair(64, 0);
    const r = score(fpA, fpB, [], [], 0, 0);
    expect(r.components.timeDecay).toBe(1);
  });

  it("timeDecay = 0.5 at Δt = TIME_WINDOW_HOURS/2 (24h for 48h window)", () => {
    const [fpA, fpB] = mkFpPair(64, 0);
    const r = score(fpA, fpB, [], [], 0, TIME_WINDOW_HOURS / 2);
    expect(r.components.timeDecay).toBeCloseTo(0.5, 10);
  });

  it("timeDecay = 0 at the full window boundary", () => {
    const [fpA, fpB] = mkFpPair(64, 0);
    const r = score(fpA, fpB, [], [], 0, TIME_WINDOW_HOURS);
    expect(r.components.timeDecay).toBeCloseTo(0, 10);
  });

  it("timeDecay is clamped to 0 past the window", () => {
    const [fpA, fpB] = mkFpPair(64, 0);
    const r = score(fpA, fpB, [], [], 0, TIME_WINDOW_HOURS * 10);
    expect(r.components.timeDecay).toBe(0);
    expect(r.score).toBe(0);
  });

  it("negative hoursDelta is treated as 0 (no decay)", () => {
    const [fpA, fpB] = mkFpPair(64, 0);
    const r = score(fpA, fpB, [], [], 0, -100);
    expect(r.components.timeDecay).toBe(1);
  });
});

describe("score — final score combination and threshold", () => {
  it("unrelated pair scores below 0.1", () => {
    // All signals weak: J=0, entities disjoint, tfidf=0.1.
    // primary = 0.40*0.1 + 0.60*0 = 0.04 → raw = 0.04
    // timeDecay @ 2h = 1 - 2/48 ≈ 0.9583 → final ≈ 0.0383.
    const [fpA, fpB] = mkFpPair(64, 0);
    const r = score(fpA, fpB, ["gala", "fener"], ["btc", "nasdaq"], 0.1, 2);
    expect(r.components.jaccard).toBe(0);
    expect(r.components.entityRatio).toBe(0);
    expect(r.score).toBeLessThan(0.1);
  });

  it("clips tfidfCosine above 1 to 1", () => {
    const [fpA, fpB] = mkFpPair(64, 0);
    const r = score(fpA, fpB, [], [], 5.0, 0);
    expect(r.components.tfidfScore).toBe(1);
  });

  it("clips tfidfCosine below 0 to 0", () => {
    const [fpA, fpB] = mkFpPair(64, 0);
    const r = score(fpA, fpB, [], [], -0.5, 0);
    expect(r.components.tfidfScore).toBe(0);
  });

  it("coerces non-finite tfidf to 0", () => {
    const [fpA, fpB] = mkFpPair(64, 0);
    const r = score(fpA, fpB, [], [], NaN, 0);
    expect(r.components.tfidfScore).toBe(0);
  });

  it("MATCH_THRESHOLD is the configured knob (0.40 in current tuning)", () => {
    expect(MATCH_THRESHOLD).toBe(0.40);
  });

  it("a pair with full Jaccard + aligned time clears MATCH_THRESHOLD", () => {
    const [fpA, fpB] = mkFpPair(64, 64); // J = 1.0 → jaccardScore = 1.0
    const r = score(fpA, fpB, [], [], 0, 0);
    // raw = 1.0, timeDecay = 1.0 → final = 1.0 ≥ threshold.
    expect(r.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  });
});

describe("score — source penalty (A8 haberler-com downweight)", () => {
  it("applies 0.85 penalty when either side is haberler-com", () => {
    const [fpA, fpB] = mkFpPair(64, 64); // raw = 1.0
    const r = score(fpA, fpB, [], [], 0, 0, { aSourceSlug: "haberler-com" });
    expect(r.score).toBeCloseTo(0.85, 10);
    expect(r.components.sourcePenalty).toBe(0.85);
  });

  it("applies penalty when only the b-side is penalised", () => {
    const [fpA, fpB] = mkFpPair(64, 64);
    const r = score(fpA, fpB, [], [], 0, 0, { bSourceSlug: "haberler-com" });
    expect(r.components.sourcePenalty).toBe(0.85);
  });

  it("picks the smaller multiplier when BOTH sides are penalised", () => {
    const [fpA, fpB] = mkFpPair(64, 64);
    const r = score(fpA, fpB, [], [], 0, 0, {
      aSourceSlug: "haberler-com",
      bSourceSlug: "haberler-com",
    });
    // Both = 0.85, min(0.85, 0.85) = 0.85 (not 0.85 * 0.85).
    expect(r.components.sourcePenalty).toBe(0.85);
    expect(r.score).toBeCloseTo(0.85, 10);
  });

  it("defaults to no penalty when no opts bag is passed (back-compat)", () => {
    const [fpA, fpB] = mkFpPair(64, 64);
    const r = score(fpA, fpB, [], [], 0, 0);
    expect(r.components.sourcePenalty).toBe(1);
  });

  it("defaults to no penalty for unknown source slugs", () => {
    const [fpA, fpB] = mkFpPair(64, 64);
    const r = score(fpA, fpB, [], [], 0, 0, {
      aSourceSlug: "some-other-source",
      bSourceSlug: "yet-another",
    });
    expect(r.components.sourcePenalty).toBe(1);
  });
});

describe("score — null / undefined robustness", () => {
  it("treats missing signature as Jaccard=0", () => {
    const fpA = { strict: "a", shingles: new Set(), signature: null };
    const fpB = { strict: "b", shingles: new Set(), signature: null };
    const r = score(fpA, fpB, [], [], 0, 0);
    expect(r.components.jaccard).toBe(0);
    expect(r.components.jaccardScore).toBe(0);
  });

  it("handles missing entity inputs", () => {
    const [fpA, fpB] = mkFpPair(64, 0);
    const r = score(fpA, fpB, null, undefined, 0, 0);
    expect(r.components.sharedEntities).toBe(0);
    expect(r.components.entityRatioRaw).toBe(0);
  });
});

describe("isMatch", () => {
  it("returns true for a number at threshold", () => {
    expect(isMatch(MATCH_THRESHOLD)).toBe(true);
  });

  it("returns true for a number above threshold", () => {
    expect(isMatch(0.99)).toBe(true);
  });

  it("returns false for a number below threshold", () => {
    expect(isMatch(MATCH_THRESHOLD - 0.01)).toBe(false);
  });

  it("accepts a score result object", () => {
    const [fpA, fpB] = mkFpPair(64, 64);
    const r = score(fpA, fpB, [], [], 0, 0);
    expect(isMatch(r)).toBe(true);
  });

  it("returns false for malformed inputs", () => {
    expect(isMatch(null)).toBe(false);
    expect(isMatch(undefined)).toBe(false);
    expect(isMatch({})).toBe(false);
    expect(isMatch({ score: "not a number" })).toBe(false);
  });
});
