import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Pack B2 "Metodoloji regresyonu" (migration 066), W2. Mirrors
// src/lib/game/agreement.test.ts (fixture functions record the builder
// `state` so the query shape is pinned) and
// src/lib/admin/jev-shadow-status.test.ts (env vars set/restored,
// vi.resetModules() in afterEach). getJevRegressionStatus fires three
// `count: "exact", head: true` reads against jev_regression_items
// (kind=article / kind=pair / in_gold=true) plus one jev_regression_runs
// select, all in one Promise.all. No next/cache mock here — this fetcher
// is a plain async function on purpose (the /admin page is cookie-gated
// and dynamic, so it must never opt into the RSC cache directive).

const fixture = vi.hoisted(() => ({
  articleCount: 400,
  pairCount: 100,
  goldCount: 280,
  runs: [] as unknown[],
  itemsError: null as { message: string } | null,
  runsError: null as { message: string } | null,
  itemStates: [] as unknown[],
  runStates: [] as unknown[],
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      jev_regression_items: (state) => {
        fixture.itemStates.push(state);
        if (fixture.itemsError) return { data: null, error: fixture.itemsError };
        const wantsPair = state.eq.some((e) => e.col === "kind" && e.val === "pair");
        const wantsArticle = state.eq.some((e) => e.col === "kind" && e.val === "article");
        const wantsGold = state.eq.some((e) => e.col === "in_gold" && e.val === true);
        const count = wantsPair
          ? fixture.pairCount
          : wantsGold
            ? fixture.goldCount
            : wantsArticle
              ? fixture.articleCount
              : 0;
        return { data: null, error: null, count };
      },
      jev_regression_runs: (state) => {
        fixture.runStates.push(state);
        if (fixture.runsError) return { data: null, error: fixture.runsError };
        return { data: fixture.runs, error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

import {
  getJevRegressionStatus,
  toRegressionRunView,
  JEV_REGRESSION_RUN_LIMIT,
} from "./jev-regression";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";

function itemStates(): BuilderState[] {
  return fixture.itemStates as BuilderState[];
}

function runStates(): BuilderState[] {
  return fixture.runStates as BuilderState[];
}

const ORIGINAL_ENV = { ...process.env };

// The literal wire shape from shared_contract §C, byte for byte — pins
// this file to the same deltas shape W1's tests write.
const CONTRACT_DELTAS = {
  tasks: {
    politics: { n: 400, flips: 3, mean_abs_delta: 0.012, max_abs_delta: 0.21 },
    topic: { n: 400, flips: 5, mean_abs_delta: null, max_abs_delta: null },
    opinion: { n: 400, flips: 1, mean_abs_delta: 0.008, max_abs_delta: 0.13 },
    clickbait: { n: 400, flips: 0, mean_abs_delta: 0.004, max_abs_delta: 0.05 },
    framing: { n: 400, flips: 7, mean_abs_delta: null, max_abs_delta: null },
    sensational: { n: 400, flips: 2, mean_abs_delta: 0.09, max_abs_delta: 1.4 },
    pair_negative: { n: 100, flips: 1, mean_abs_delta: 0.004, max_abs_delta: 0.09 },
  },
  overall: { items: 500, tasks: 7, flip_rate: 0.008 },
  gold: {
    politics: { n: 280, correct_050: 265, correct_070: 241 },
    topic: { n: 240, correct: 212 },
  },
};

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.articleCount = 400;
  fixture.pairCount = 100;
  fixture.goldCount = 280;
  fixture.runs = [];
  fixture.itemsError = null;
  fixture.runsError = null;
  fixture.itemStates = [];
  fixture.runStates = [];
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
  vi.resetModules();
});

describe("getJevRegressionStatus", () => {
  it("getJevRegressionStatus returns item counts and the last five runs", async () => {
    fixture.runs = [
      {
        id: 12,
        question_set: "2026-09-21.2",
        started_at: "2026-09-21T04:20:00.000Z",
        finished_at: "2026-09-21T04:25:00.000Z",
        status: "ok",
        items: 500,
        calls: 410,
        deltas: CONTRACT_DELTAS,
      },
    ];

    const result = await getJevRegressionStatus();

    expect(result).not.toBeNull();
    expect(result!.counts).toEqual({ articles: 400, pairs: 100, inGold: 280 });
    expect(result!.runs).toHaveLength(1);
    expect(result!.runs[0]).toEqual({
      id: 12,
      questionSet: "2026-09-21.2",
      startedAt: "2026-09-21T04:20:00.000Z",
      finishedAt: "2026-09-21T04:25:00.000Z",
      status: "ok",
      items: 500,
      calls: 410,
      flipRate: 0.008,
      firstRun: false,
      flips: { politics: 3, topic: 5, pair: 1, topic7: null },
      goldPolitics070: 241 / 280,
      goldTopic7: null,
      provisional: null,
    });
  });

  it("getJevRegressionStatus asks for kind=article, kind=pair and in_gold=true counts, and orders runs by id desc limit 5", async () => {
    await getJevRegressionStatus();

    const eqPairs = itemStates().flatMap((s) => s.eq);
    expect(eqPairs.some((e) => e.col === "kind" && e.val === "article")).toBe(true);
    expect(eqPairs.some((e) => e.col === "kind" && e.val === "pair")).toBe(true);
    expect(eqPairs.some((e) => e.col === "in_gold" && e.val === true)).toBe(true);

    expect(runStates()).toHaveLength(1);
    const runState = runStates()[0];
    expect(runState).toBeDefined();
    expect(runState!.order).toEqual([{ col: "id", opts: { ascending: false } }]);
    expect(runState!.limit).toBe(JEV_REGRESSION_RUN_LIMIT);
    expect(JEV_REGRESSION_RUN_LIMIT).toBe(5);
  });

  it("getJevRegressionStatus returns null and logs exactly once when any query errors", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.runsError = { message: "relation \"jev_regression_runs\" does not exist" };

    const result = await getJevRegressionStatus();

    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[admin] jev regression status unavailable: "),
    );

    errorSpy.mockRestore();
  });

  it("getJevRegressionStatus returns null and never throws when the env vars are missing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    await expect(getJevRegressionStatus()).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});

describe("toRegressionRunView", () => {
  it("toRegressionRunView reads flip_rate, per-task flips and the 0.7 gold rate out of the contract deltas shape", () => {
    const view = toRegressionRunView({
      id: 12,
      question_set: "2026-09-21.2",
      started_at: "2026-09-21T04:20:00.000Z",
      finished_at: "2026-09-21T04:25:00.000Z",
      status: "ok",
      items: 500,
      calls: 410,
      deltas: CONTRACT_DELTAS,
    });

    expect(view).toEqual({
      id: 12,
      questionSet: "2026-09-21.2",
      startedAt: "2026-09-21T04:20:00.000Z",
      finishedAt: "2026-09-21T04:25:00.000Z",
      status: "ok",
      items: 500,
      calls: 410,
      flipRate: 0.008,
      firstRun: false,
      flips: { politics: 3, topic: 5, pair: 1, topic7: null },
      goldPolitics070: 241 / 280,
      goldTopic7: null,
      provisional: null,
    });
  });

  it("toRegressionRunView reports firstRun and null rates for a { first_run: true } deltas", () => {
    const view = toRegressionRunView({
      id: 1,
      question_set: "2026-09-21.2",
      started_at: "2026-09-21T04:20:00.000Z",
      finished_at: null,
      status: "ok",
      items: 500,
      calls: 410,
      deltas: { first_run: true },
    });

    expect(view.firstRun).toBe(true);
    expect(view.flipRate).toBeNull();
    expect(view.flips).toEqual({ politics: null, topic: null, pair: null, topic7: null });
    expect(view.goldPolitics070).toBeNull();
    expect(view.goldTopic7).toBeNull();
    expect(view.provisional).toBeNull();
    expect(view.finishedAt).toBeNull();
  });

  it("toRegressionRunView degrades to nulls for null, malformed and partial deltas without throwing", () => {
    const base = {
      id: 2,
      question_set: "2026-09-21.2",
      started_at: "2026-09-21T04:20:00.000Z",
      finished_at: null,
      status: "partial",
      items: 120,
      calls: 126,
    };

    for (const deltas of [null, "not-json", {}, { tasks: {} }, { gold: {} }, undefined]) {
      expect(() => toRegressionRunView({ ...base, deltas })).not.toThrow();
      const view = toRegressionRunView({ ...base, deltas });
      expect(view.flipRate).toBeNull();
      expect(view.flips).toEqual({ politics: null, topic: null, pair: null, topic7: null });
      expect(view.goldPolitics070).toBeNull();
      expect(view.goldTopic7).toBeNull();
      expect(view.provisional).toBeNull();
      expect(Number.isNaN(view.id)).toBe(false);
      expect(Number.isNaN(view.items)).toBe(false);
      expect(Number.isNaN(view.calls)).toBe(false);
    }

    // A non-object row (null, a string, a number) must also survive.
    for (const row of [null, undefined, "nope", 42]) {
      expect(() => toRegressionRunView(row)).not.toThrow();
    }
  });

  it("toRegressionRunView returns null for goldPolitics070 when gold.politics.n is 0 rather than NaN", () => {
    const view = toRegressionRunView({
      id: 3,
      question_set: "2026-09-21.2",
      started_at: "2026-09-21T04:20:00.000Z",
      finished_at: "2026-09-21T04:25:00.000Z",
      status: "ok",
      items: 500,
      calls: 410,
      deltas: {
        tasks: {},
        overall: { flip_rate: 0 },
        gold: { politics: { n: 0, correct_050: 0, correct_070: 0 } },
      },
    });

    expect(view.goldPolitics070).toBeNull();
    expect(Number.isNaN(view.goldPolitics070 as unknown as number)).toBe(false);
  });

  it("088: parses goldTopic7, flips.topic7 and the provisional dev/heldout split", () => {
    const view = toRegressionRunView({
      id: 20,
      question_set: "2026-09-24.1",
      started_at: "2026-09-28T04:20:00.000Z",
      finished_at: "2026-09-28T04:30:00.000Z",
      status: "ok",
      items: 660,
      calls: 600,
      deltas: {
        tasks: { topic7: { n: 400, flips: 12, mean_abs_delta: null, max_abs_delta: null } },
        overall: { flip_rate: 0.02 },
        gold: {
          politics: { n: 280, correct_050: 260, correct_070: 241 },
          topic7: { n: 280, correct: 250 },
          provisional: {
            dev: { politics: { n: 356, correct_050: 300 }, topic7: { n: 356, correct: 310 } },
            heldout: { politics: { n: 304, correct_050: 280 }, topic7: { n: 304, correct: 290 } },
          },
        },
      },
    });

    expect(view.flips.topic7).toBe(12);
    expect(view.goldTopic7).toBe(250 / 280);
    expect(view.provisional).toEqual({
      dev: { n: 356, politics050: 300 / 356, topic7: 310 / 356 },
      heldout: { n: 304, politics050: 280 / 304, topic7: 290 / 304 },
    });
  });

  it("088: goldTopic7 is null when n is 0, and provisional is null when the block is absent -- never NaN, never throws", () => {
    const view = toRegressionRunView({
      id: 21,
      question_set: "2026-09-24.1",
      started_at: "2026-09-28T04:20:00.000Z",
      finished_at: "2026-09-28T04:30:00.000Z",
      status: "ok",
      items: 0,
      calls: 0,
      deltas: { gold: { topic7: { n: 0, correct: 0 } } },
    });

    expect(view.goldTopic7).toBeNull();
    expect(Number.isNaN(view.goldTopic7 as unknown as number)).toBe(false);
    expect(view.provisional).toBeNull();
  });

  it("088: a malformed provisional block degrades to null fields without throwing", () => {
    expect(() =>
      toRegressionRunView({
        id: 22,
        deltas: { gold: { provisional: "not-an-object" } },
      }),
    ).not.toThrow();
    const view = toRegressionRunView({ id: 22, deltas: { gold: { provisional: "not-an-object" } } });
    expect(view.provisional).toBeNull();

    const view2 = toRegressionRunView({ id: 23, deltas: { gold: { provisional: {} } } });
    expect(view2.provisional).toEqual({
      dev: { n: 0, politics050: null, topic7: null },
      heldout: { n: 0, politics050: null, topic7: null },
    });
  });
});
