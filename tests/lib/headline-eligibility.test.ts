import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  chunkClusterIds,
  decideEligibility,
  fetchHeadlineEligibility,
  type HeadlineMemberScore,
} from "@/lib/headline/eligibility";
import { estimateCallUsd, headlineLlmDailyCapUsd } from "@/lib/headline/budget";

// ---------------------------------------------------------------------------
// Unit tests for the pure headline-eligibility gate (src/lib/headline/
// eligibility.ts) and the pure budget helpers it shares a test file with
// per W1.md (headlineLlmDailyCapUsd / estimateCallUsd live in
// src/lib/headline/budget.ts but are exercised here alongside the gate
// they feed). No Supabase I/O except fetchHeadlineEligibility's rpc calls,
// which use the shared proxy fake.
// ---------------------------------------------------------------------------

function score(politicsProb: number | null, clickbaitProb: number | null = null): HeadlineMemberScore {
  return { politicsProb, clickbaitProb };
}

describe("decideEligibility", () => {
  it("two members at politics 0.7 and no clickbait scores -> eligible, politicsN 2, clickbaitShare 0", () => {
    const result = decideEligibility({
      articleCount: 4,
      members: [score(0.7), score(0.7), score(null)],
    });
    expect(result).toEqual({ eligible: true, politicsN: 2, clickbaitShare: 0 });
  });

  it("one member at politics 0.95 with articleCount 1 -> eligible", () => {
    const result = decideEligibility({
      articleCount: 1,
      members: [score(0.95)],
    });
    expect(result.eligible).toBe(true);
    expect(result.politicsN).toBe(1);
  });

  it("one member at politics 0.95 with articleCount 3 -> ineligible (solo rule needs articleCount 1)", () => {
    const result = decideEligibility({
      articleCount: 3,
      members: [score(0.95)],
    });
    expect(result.eligible).toBe(false);
    expect(result.politicsN).toBe(1);
  });

  it("politics 0.69 never counts (threshold is inclusive at 0.7)", () => {
    const result = decideEligibility({
      articleCount: 5,
      members: [score(0.69), score(0.69), score(0.69)],
    });
    expect(result.politicsN).toBe(0);
    expect(result.eligible).toBe(false);

    const atThreshold = decideEligibility({
      articleCount: 5,
      members: [score(0.7), score(0.7)],
    });
    expect(atThreshold.politicsN).toBe(2);
    expect(atThreshold.eligible).toBe(true);
  });

  it("half the clickbait-scored members at 0.5 -> ineligible (share must be strictly under 0.5)", () => {
    const result = decideEligibility({
      articleCount: 4,
      members: [
        score(0.7, 0.5),
        score(0.7, 0.5),
        score(null, 0.1),
        score(null, 0.1),
      ],
    });
    // politically eligible (politicsN = 2) but exactly half the
    // clickbait-scored members (2 of 4) hit >= 0.5 -> share = 0.5, not < 0.5.
    expect(result.politicsN).toBe(2);
    expect(result.clickbaitShare).toBe(0.5);
    expect(result.eligible).toBe(false);
  });

  it("members with no scores at all -> ineligible, fail-safe toward extractive", () => {
    const result = decideEligibility({
      articleCount: 4,
      members: [score(null, null), score(null, null)],
    });
    expect(result).toEqual({ eligible: false, politicsN: 0, clickbaitShare: 0 });
  });

  it("clickbaitShare is rounded to 3 decimals like the SQL", () => {
    // 1 of 3 clickbait-scored members hits >= 0.5 -> 0.333333... -> 0.333.
    const result = decideEligibility({
      articleCount: 4,
      members: [
        score(0.7),
        score(0.7),
        score(null, 0.6),
        score(null, 0.1),
        score(null, 0.1),
      ],
    });
    expect(result.clickbaitShare).toBe(0.333);
  });
});

describe("chunkClusterIds", () => {
  it("splits 450 ids into 200/200/50 and never emits an empty chunk", () => {
    const ids = Array.from({ length: 450 }, (_, i) => `id-${i}`);
    const chunks = chunkClusterIds(ids);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(200);
    expect(chunks[1]).toHaveLength(200);
    expect(chunks[2]).toHaveLength(50);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
    }
  });
});

describe("fetchHeadlineEligibility", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("returns an empty map (never throws) when the rpc errors", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } }),
    };
    const result = await fetchHeadlineEligibility(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase as any,
      ["c1", "c2"],
    );
    expect(result.size).toBe(0);
    expect(errorSpy).toHaveBeenCalledWith(
      "[headline-cron] eligibility rpc failed",
      expect.anything(),
    );
    errorSpy.mockRestore();
  });

  it("issues one rpc per 200-id chunk and merges the rows by cluster_id", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `c-${i}`);
    const rpc = vi.fn().mockImplementation(async (_name: string, args: { p_cluster_ids: string[] }) => ({
      data: args.p_cluster_ids.map((id) => ({
        cluster_id: id,
        eligible: true,
        politics_n: 2,
        clickbait_share: 0,
      })),
      error: null,
    }));
    const supabase = { rpc };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchHeadlineEligibility(supabase as any, ids);

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(result.size).toBe(250);
    expect(result.get("c-0")).toEqual({
      cluster_id: "c-0",
      eligible: true,
      politics_n: 2,
      clickbait_share: 0,
    });
    expect(result.get("c-249")).toBeDefined();
  });
});

describe("headlineLlmDailyCapUsd", () => {
  const ORIGINAL = process.env.HEADLINE_LLM_DAILY_USD_CAP;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.HEADLINE_LLM_DAILY_USD_CAP;
    else process.env.HEADLINE_LLM_DAILY_USD_CAP = ORIGINAL;
  });

  it("falls back to 2.00 for unset, NaN, zero and negative HEADLINE_LLM_DAILY_USD_CAP", () => {
    delete process.env.HEADLINE_LLM_DAILY_USD_CAP;
    expect(headlineLlmDailyCapUsd()).toBe(2.0);

    process.env.HEADLINE_LLM_DAILY_USD_CAP = "not-a-number";
    expect(headlineLlmDailyCapUsd()).toBe(2.0);

    process.env.HEADLINE_LLM_DAILY_USD_CAP = "0";
    expect(headlineLlmDailyCapUsd()).toBe(2.0);

    process.env.HEADLINE_LLM_DAILY_USD_CAP = "-5";
    expect(headlineLlmDailyCapUsd()).toBe(2.0);

    process.env.HEADLINE_LLM_DAILY_USD_CAP = "3.50";
    expect(headlineLlmDailyCapUsd()).toBe(3.5);
  });
});

describe("estimateCallUsd", () => {
  it("prices input and output tokens separately", () => {
    // 1000 input tokens @ 1/1_000_000 + 200 output tokens @ 5/1_000_000
    const usd = estimateCallUsd(1000, 200);
    expect(usd).toBeCloseTo(1000 / 1_000_000 + 200 * (5 / 1_000_000), 10);

    expect(estimateCallUsd(1_000_000, 0)).toBeCloseTo(1, 10);
    expect(estimateCallUsd(0, 1_000_000)).toBeCloseTo(5, 10);
    expect(estimateCallUsd(0, 0)).toBe(0);
  });
});
