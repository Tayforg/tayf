import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  JEV_LIVE_POLICY,
  classifyBand,
  decideMarginal,
  liveEnabled,
  budgetAllows,
  buildMarginalRequest,
  buildMarginalRow,
  newJevLiveState,
  sanitizeHeadline,
} from "../../supabase/functions/_shared/cluster/jev-verify.ts";
import { JEV_QUESTION_REGISTRY } from "../../supabase/functions/_shared/jev.ts";

// ---------------------------------------------------------------------------
// Pure-logic contract tests for jev-verify.ts (P3 live marginal verification,
// migration 064) plus one static guard over the sibling jev-client.ts.
//
// jev-verify.ts is pure (no fetch/Deno/supabase-js/console); every test here
// calls the exported functions directly with plain objects -- no mocks, no
// I/O.
// ---------------------------------------------------------------------------

const FLOOR = 0.36;
const THRESHOLD = 0.4;
const HIGH_BAND = JEV_LIVE_POLICY.highBandWidth;

describe("classifyBand", () => {
  it("classifyBand: [0.36,0.40) is low, [0.40,0.44) is high, 0.355 and 0.44 are none", () => {
    const base = { floor: FLOOR, threshold: THRESHOLD, highBand: HIGH_BAND };
    // Low band: [0.36, 0.40)
    expect(classifyBand({ ...base, score: 0.36 })).toBe("low");
    expect(classifyBand({ ...base, score: 0.38 })).toBe("low");
    expect(classifyBand({ ...base, score: 0.399999 })).toBe("low");
    // High band: [0.40, 0.44)
    expect(classifyBand({ ...base, score: 0.4 })).toBe("high");
    expect(classifyBand({ ...base, score: 0.42 })).toBe("high");
    expect(classifyBand({ ...base, score: 0.439999 })).toBe("high");
    // Outside both bands: none
    expect(classifyBand({ ...base, score: 0.355 })).toBe("none");
    expect(classifyBand({ ...base, score: 0.44 })).toBe("none");
    expect(classifyBand({ ...base, score: 0 })).toBe("none");
    expect(classifyBand({ ...base, score: 1 })).toBe("none");
  });
});

describe("decideMarginal", () => {
  it("decideMarginal: band-low joins at p=0.7 and not at 0.699", () => {
    const base = { score: 0.37, floor: FLOOR, threshold: THRESHOLD, highBand: HIGH_BAND };
    expect(decideMarginal({ ...base, probability: 0.7 })).toBe("join");
    expect(decideMarginal({ ...base, probability: 1 })).toBe("join");
    expect(decideMarginal({ ...base, probability: 0.699 })).toBe("unchanged");
  });

  it("decideMarginal: band-high rejects at p=0.299 and not at 0.3", () => {
    const base = { score: 0.41, floor: FLOOR, threshold: THRESHOLD, highBand: HIGH_BAND };
    expect(decideMarginal({ ...base, probability: 0.299 })).toBe("reject");
    expect(decideMarginal({ ...base, probability: 0 })).toBe("reject");
    expect(decideMarginal({ ...base, probability: 0.3 })).toBe("unchanged");
  });

  it("decideMarginal: band none is always unchanged, whatever the probability", () => {
    const belowFloor = { score: 0.1, floor: FLOOR, threshold: THRESHOLD, highBand: HIGH_BAND };
    const aboveHighBand = { score: 0.6, floor: FLOOR, threshold: THRESHOLD, highBand: HIGH_BAND };
    expect(decideMarginal({ ...belowFloor, probability: 0.99 })).toBe("unchanged");
    expect(decideMarginal({ ...belowFloor, probability: 0.01 })).toBe("unchanged");
    expect(decideMarginal({ ...aboveHighBand, probability: 0.99 })).toBe("unchanged");
    expect(decideMarginal({ ...aboveHighBand, probability: 0.01 })).toBe("unchanged");
  });
});

describe("liveEnabled", () => {
  it("liveEnabled is true only for flag '1' with a non-empty api key", () => {
    expect(liveEnabled("1", "some-key")).toBe(true);
    expect(liveEnabled("1", "")).toBe(false);
    expect(liveEnabled("1", undefined)).toBe(false);
    expect(liveEnabled("0", "some-key")).toBe(false);
    expect(liveEnabled("", "some-key")).toBe(false);
    expect(liveEnabled(undefined, "some-key")).toBe(false);
    expect(liveEnabled("true", "some-key")).toBe(false);
    expect(liveEnabled("1", "0")).toBe(true); // non-empty string, even "0", counts as a key
  });
});

describe("budgetAllows", () => {
  it("budgetAllows stops at JEV_LIVE_POLICY.maxCallsPerDrain (40)", () => {
    expect(JEV_LIVE_POLICY.maxCallsPerDrain).toBe(40);
    expect(budgetAllows(0)).toBe(true);
    expect(budgetAllows(39)).toBe(true);
    expect(budgetAllows(40)).toBe(false);
    expect(budgetAllows(41)).toBe(false);
    // Explicit max overrides the policy default.
    expect(budgetAllows(5, 10)).toBe(true);
    expect(budgetAllows(10, 10)).toBe(false);
  });
});

describe("buildMarginalRequest", () => {
  it("buildMarginalRequest emits one p1 boolean whose instructions are byte-identical to the pair_negative registry text with {key} -> p1", () => {
    const req = buildMarginalRequest({ headlineA: "Headline A", headlineB: "Headline B", headlineC: null });
    const expectedInstructions = JEV_QUESTION_REGISTRY.pair_negative.instructions.replace("{key}", "p1");
    expect(req.questions.p1).toEqual({
      type: "boolean",
      instructions: expectedInstructions,
      criteria: { true: "Same concrete event", false: "Different events" },
    });
  });

  it("buildMarginalRequest clamps all three headlines to 300 chars and omits headline_c when null", () => {
    const long = "x".repeat(400);
    const withoutC = buildMarginalRequest({ headlineA: long, headlineB: long, headlineC: null });
    const stateWithoutC = withoutC.state as {
      pairs: { p1: { a: string; b: string } };
      headline_c?: string;
    };
    expect(stateWithoutC.pairs.p1.a.length).toBe(300);
    expect(stateWithoutC.pairs.p1.b.length).toBe(300);
    expect(stateWithoutC).not.toHaveProperty("headline_c");

    // Empty string is also "no third headline" -- omitted, not clamped to "".
    const withEmptyC = buildMarginalRequest({ headlineA: "a", headlineB: "b", headlineC: "" });
    expect(withEmptyC.state as object).not.toHaveProperty("headline_c");

    const withC = buildMarginalRequest({ headlineA: "a", headlineB: "b", headlineC: long });
    const stateWithC = withC.state as { headline_c: string };
    expect(stateWithC.headline_c.length).toBe(300);
    expect(stateWithC.headline_c).toBe(long.slice(0, 300));
  });
});

describe("sanitizeHeadline", () => {
  it("[SEC-064-02] folds an embedded newline, an RLO bidi override and a zero-width joiner into a single clean line", () => {
    // Built from \uXXXX escapes only -- never paste a literal control,
    // zero-width or bidi character into a source file. \n = C0 control,
    // \u202E = RLO (explicit bidi override), \u200D = ZWJ (zero-width joiner).
    const dirty = "Ankara'da\ndeprem\u202Eguvenlik\u200Dartisi var";
    const clean = sanitizeHeadline(dirty);
    expect(clean).toBe("Ankara'da deprem guvenlik artisi var");
    expect(clean).not.toMatch(/[\n\r]/);
    expect(clean).not.toMatch(
      /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/,
    );
  });

  it("leaves an ordinary Turkish headline byte-identical", () => {
    const headline = "Ankara'da deprem sonras\u0131 kurtarma \u00e7al\u0131\u015fmalar\u0131 s\u00fcr\u00fcyor";
    expect(sanitizeHeadline(headline)).toBe(headline);
  });

  it('returns "" for null/undefined, matching clamp()\'s existing null handling', () => {
    expect(sanitizeHeadline(null)).toBe("");
    expect(sanitizeHeadline(undefined)).toBe("");
    expect(sanitizeHeadline("")).toBe("");
  });

  it("buildMarginalRequest routes headlineA/B/C through sanitizeHeadline before clamp", () => {
    const dirty = "Bomba\u202Eharberi\u200D var";
    const req = buildMarginalRequest({ headlineA: dirty, headlineB: "b", headlineC: dirty });
    const state = req.state as { pairs: { p1: { a: string } }; headline_c: string };
    expect(state.pairs.p1.a).toBe(sanitizeHeadline(dirty));
    expect(state.pairs.p1.a).not.toMatch(/[\u200B-\u200F\u202A-\u202E]/);
    expect(state.headline_c).toBe(sanitizeHeadline(dirty));
  });
});

describe("buildMarginalRow", () => {
  const baseArgs = {
    articleId: "art-1",
    clusterId: "clu-1",
    stateHash: "deadbeef",
    preview: "preview text",
    latencyMs: 100,
    inputTokens: 42,
  };

  it("buildMarginalRow: band-low baseline is 'false', band-high baseline is 'true', agree follows the 0.5 threshold", () => {
    const lowHighProb = buildMarginalRow({
      ...baseArgs,
      band: "low",
      ensembleScore: 0.37,
      probability: 0.72,
      decision: "joined",
    });
    expect(lowHighProb.baseline_answer).toBe("false");
    // Jev disagrees with the "would not join" baseline when p >= 0.5.
    expect(lowHighProb.agree).toBe(false);

    const lowLowProb = buildMarginalRow({
      ...baseArgs,
      band: "low",
      ensembleScore: 0.37,
      probability: 0.2,
      decision: "unchanged",
    });
    expect(lowLowProb.baseline_answer).toBe("false");
    expect(lowLowProb.agree).toBe(true);

    const highLowProb = buildMarginalRow({
      ...baseArgs,
      band: "high",
      ensembleScore: 0.41,
      probability: 0.2,
      decision: "rejected",
    });
    expect(highLowProb.baseline_answer).toBe("true");
    expect(highLowProb.agree).toBe(false);

    const highHighProb = buildMarginalRow({
      ...baseArgs,
      band: "high",
      ensembleScore: 0.41,
      probability: 0.8,
      decision: "unchanged",
    });
    expect(highHighProb.baseline_answer).toBe("true");
    expect(highHighProb.agree).toBe(true);
  });

  it("buildMarginalRow: subject_id is <articleId>:<clusterId>, run_id is null, jev_prob is rounded to 3dp", () => {
    const row = buildMarginalRow({
      articleId: "art-42",
      clusterId: "clu-7",
      band: "low",
      ensembleScore: 0.3712345,
      probability: 0.123456,
      decision: "unchanged",
      stateHash: "h",
      preview: "p",
      latencyMs: 10,
      inputTokens: 1,
    });
    expect(row.subject_id).toBe("art-42:clu-7");
    expect(row.run_id).toBeNull();
    expect(row.jev_prob).toBe(0.123);
    expect(row.article_id).toBeNull();
    expect(row.cluster_id).toBeNull();
    expect(row.task).toBe("pair_marginal");
    expect(row.subject_type).toBe("pair");
    expect(row.jev_choice).toBeNull();
    expect((row.jev_answer as { ensemble_score: number }).ensemble_score).toBe(0.371);
  });
});

describe("JEV_LIVE_POLICY", () => {
  it("JEV_LIVE_POLICY pins timeoutMs 1500, maxCallsPerDrain 40, 0.7/0.3 and highBandWidth 0.04", () => {
    expect(JEV_LIVE_POLICY.timeoutMs).toBe(1500);
    expect(JEV_LIVE_POLICY.maxCallsPerDrain).toBe(40);
    expect(JEV_LIVE_POLICY.joinMinProbability).toBe(0.7);
    expect(JEV_LIVE_POLICY.rejectMaxProbability).toBe(0.3);
    expect(JEV_LIVE_POLICY.highBandWidth).toBe(0.04);
    expect(JEV_LIVE_POLICY.envFlag).toBe("JEV_LIVE_PAIRS");
    expect(JEV_LIVE_POLICY.enabledValue).toBe("1");
    expect(JEV_LIVE_POLICY.maxRetries).toBe(0);
  });
});

describe("newJevLiveState", () => {
  it("starts every counter at 0 and carries the given enabled flag", () => {
    expect(newJevLiveState(false)).toEqual({
      enabled: false,
      calls: 0,
      joined_by_jev: 0,
      rejected_by_jev: 0,
      errors: 0,
      timeouts: 0,
      budget_skipped: 0,
    });
    expect(newJevLiveState(true).enabled).toBe(true);
  });
});

describe("jev-client.ts static security guard", () => {
  it("jev-client.ts never references console and never interpolates the api key or a response body into an Error", () => {
    const src = readFileSync(
      resolve(__dirname, "../../supabase/functions/_shared/jev-client.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/console\./);

    const errorCalls = src.match(/new (?:Error|JevRateLimitError)\([^)]*\)/g) ?? [];
    // At least the two documented static-string throws must be present.
    expect(errorCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of errorCalls) {
      expect(call).not.toMatch(/\$\{[^}]*\b(key|apiKey|text|json|body)\b[^}]*\}/i);
    }
  });
});
