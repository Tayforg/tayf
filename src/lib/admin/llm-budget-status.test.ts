import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BuilderState } from "../../../tests/_helpers/supabase-fake";

// The /admin "Baslik LLM butcesi" reader. "null" means "could not read" and is
// distinct from a legitimate day with no row yet (the zero struct).

interface Res {
  data: unknown;
  error: { message: string } | null;
}

const log = vi.hoisted(() => ({
  states: [] as BuilderState[],
  throwOnClient: false,
}));

const fx = vi.hoisted(() => ({
  budget: { data: null, error: null } as Res,
}));

const fake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      llm_budget_daily: (s) => {
        log.states.push(s);
        return fx.budget;
      },
    },
  });
});

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: () => {
    if (log.throwOnClient) throw new Error("no env");
    return fake.client;
  },
}));

import { getLlmBudgetStatus } from "./llm-budget-status";

function row(over: Record<string, unknown> = {}) {
  return {
    day: "2026-11-02",
    calls: 10,
    input_tokens: 1000,
    output_tokens: 200,
    usd: 0.5,
    eligible_n: 3,
    ineligible_n: 1,
    ...over,
  };
}

beforeEach(() => {
  vi.setSystemTime(new Date("2026-11-02T12:00:00Z"));
  vi.stubEnv("HEADLINE_LLM_DAILY_USD_CAP", "2");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  log.states.length = 0;
  log.throwOnClient = false;
  fx.budget = { data: null, error: null };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("getLlmBudgetStatus", () => {
  it("returns null on a read error", async () => {
    fx.budget = { data: null, error: { message: "no table" } };
    expect(await getLlmBudgetStatus()).toBeNull();
  });

  it("returns null instead of throwing when the client cannot be built", async () => {
    log.throwOnClient = true;
    await expect(getLlmBudgetStatus()).resolves.toBeNull();
  });

  it("returns the zero struct, with the env cap, when today has no row yet", async () => {
    vi.stubEnv("HEADLINE_LLM_DAILY_USD_CAP", "5");
    fx.budget = { data: null, error: null };
    expect(await getLlmBudgetStatus()).toEqual({
      day: "2026-11-02",
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      usd: 0,
      cap: 5,
      pct: 0,
      exceeded: false,
      eligibleN: 0,
      ineligibleN: 0,
      eligibleShare: null,
    });
  });

  it("coerces numeric strings (PostgREST returns numeric columns as strings)", async () => {
    fx.budget = {
      data: row({
        calls: "12",
        input_tokens: "3400",
        output_tokens: "560",
        usd: "0.75",
        eligible_n: "6",
        ineligible_n: "2",
      }),
      error: null,
    };
    expect(await getLlmBudgetStatus()).toEqual({
      day: "2026-11-02",
      calls: 12,
      inputTokens: 3400,
      outputTokens: 560,
      usd: 0.75,
      cap: 2,
      pct: 38,
      exceeded: false,
      eligibleN: 6,
      ineligibleN: 2,
      eligibleShare: 0.75,
    });
  });

  it("rounds pct = usd / cap * 100 to a whole number", async () => {
    fx.budget = { data: row({ usd: 0.5 }), error: null };
    expect((await getLlmBudgetStatus())?.pct).toBe(25);
    fx.budget = { data: row({ usd: 1.2349 }), error: null };
    expect((await getLlmBudgetStatus())?.pct).toBe(62);
    fx.budget = { data: row({ usd: 3 }), error: null };
    expect((await getLlmBudgetStatus())?.pct).toBe(150);
  });

  it("is exceeded exactly when usd reaches the cap", async () => {
    fx.budget = { data: row({ usd: 1.99 }), error: null };
    expect((await getLlmBudgetStatus())?.exceeded).toBe(false);
    fx.budget = { data: row({ usd: 2 }), error: null };
    expect((await getLlmBudgetStatus())?.exceeded).toBe(true);
    fx.budget = { data: row({ usd: 2.01 }), error: null };
    expect((await getLlmBudgetStatus())?.exceeded).toBe(true);
  });

  it("reports eligibleShare null when both eligible counts are 0", async () => {
    fx.budget = { data: row({ eligible_n: 0, ineligible_n: 0 }), error: null };
    expect((await getLlmBudgetStatus())?.eligibleShare).toBeNull();
  });

  it("reports eligibleShare 0 when only ineligible items exist", async () => {
    fx.budget = { data: row({ eligible_n: 0, ineligible_n: 4 }), error: null };
    expect((await getLlmBudgetStatus())?.eligibleShare).toBe(0);
  });

  it.each(["not-a-number", "0", "-3", ""])(
    "falls back to the default 2.00 USD cap for the invalid env value %j",
    async (value) => {
      vi.stubEnv("HEADLINE_LLM_DAILY_USD_CAP", value);
      fx.budget = { data: row({ usd: 1 }), error: null };
      const out = await getLlmBudgetStatus();
      expect(out?.cap).toBe(2);
      expect(out?.pct).toBe(50);
    },
  );

  it("queries today's UTC day on llm_budget_daily", async () => {
    await getLlmBudgetStatus();
    expect(log.states).toHaveLength(1);
    const [s] = log.states;
    expect(s?.table).toBe("llm_budget_daily");
    expect(s?.eq).toEqual([{ col: "day", val: "2026-11-02" }]);
    expect(String(s?.selectArgs[0])).toBe(
      "day, calls, input_tokens, output_tokens, usd, eligible_n, ineligible_n",
    );
  });
});
