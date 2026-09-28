import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  aggregateAttention,
  countsTowardAttention,
  fetchLowRelevanceSince,
  fetchRelevanceScores,
  filterFeedTickers,
  isHiddenMatch,
  istanbulDay,
  relevanceKey,
  RELEVANCE_CHUNK,
  TICKER_ATTENTION_MIN,
  TICKER_HIDE_BELOW,
} from "./ticker-relevance";

describe("ticker-relevance constants", () => {
  it("matches the documented thresholds", () => {
    expect(TICKER_HIDE_BELOW).toBe(0.2);
    expect(TICKER_ATTENTION_MIN).toBe(0.5);
    expect(RELEVANCE_CHUNK).toBe(100);
  });
});

describe("relevanceKey", () => {
  it("joins articleId and ticker with a colon", () => {
    expect(relevanceKey("a1", "THYAO")).toBe("a1:THYAO");
  });
});

describe("isHiddenMatch boundaries", () => {
  it("hides just below 0.2", () => {
    expect(isHiddenMatch(0.199)).toBe(true);
  });
  it("shows exactly at 0.2", () => {
    expect(isHiddenMatch(0.2)).toBe(false);
  });
  it("shows when the score is undefined (fail-open)", () => {
    expect(isHiddenMatch(undefined)).toBe(false);
  });
});

describe("countsTowardAttention boundaries", () => {
  it("does not count just below 0.5", () => {
    expect(countsTowardAttention(0.499)).toBe(false);
  });
  it("counts exactly at 0.5", () => {
    expect(countsTowardAttention(0.5)).toBe(true);
  });
  it("counts when the score is undefined (fail-open)", () => {
    expect(countsTowardAttention(undefined)).toBe(true);
  });
});

describe("filterFeedTickers", () => {
  it("drops a hidden ticker and drops an item left with zero tickers", () => {
    const items = [
      { id: "a1", tickers: ["DEVA", "THYAO"] },
      { id: "a2", tickers: ["EREGL"] },
      { id: "a3", tickers: ["ASELS"] },
    ];
    const scores = new Map<string, number>([
      ["a1:DEVA", 0.1], // hidden
      ["a2:EREGL", 0.05], // hidden, and EREGL is a2's only ticker
    ]);
    const out = filterFeedTickers(items, scores);
    expect(out).toEqual([
      { id: "a1", tickers: ["THYAO"] },
      { id: "a3", tickers: ["ASELS"] },
    ]);
  });
});

describe("istanbulDay", () => {
  it("rolls 21:30 UTC into the next Istanbul calendar day", () => {
    expect(istanbulDay("2026-09-13T21:30:00.000Z")).toBe("2026-09-14");
  });
  it("keeps an early-UTC timestamp on the same Istanbul day", () => {
    expect(istanbulDay("2026-09-13T05:00:00.000Z")).toBe("2026-09-13");
  });
});

describe("aggregateAttention", () => {
  it("counts distinct sources and omits rows below the attention floor", () => {
    const rows = [
      { ticker: "THYAO", article_id: "a1", published_at: "2026-09-13T10:00:00.000Z", source_id: "s1" },
      { ticker: "THYAO", article_id: "a2", published_at: "2026-09-13T11:00:00.000Z", source_id: "s2" },
      { ticker: "THYAO", article_id: "a2", published_at: "2026-09-13T11:00:00.000Z", source_id: "s2" },
      // Below-attention-floor row for the same ticker/day — excluded.
      { ticker: "THYAO", article_id: "a3", published_at: "2026-09-13T12:00:00.000Z", source_id: "s3" },
      // 21:30Z lands on the next Istanbul day.
      { ticker: "THYAO", article_id: "a4", published_at: "2026-09-13T21:30:00.000Z", source_id: "s4" },
    ];
    const scores = new Map<string, number>([["a3:THYAO", 0.3]]);
    const result = aggregateAttention(rows, scores);
    const day13 = result.find((r) => r.day === "2026-09-13");
    const day14 = result.find((r) => r.day === "2026-09-14");
    expect(day13).toEqual({ ticker: "THYAO", day: "2026-09-13", articles: 3, sources: 2 });
    expect(day14).toEqual({ ticker: "THYAO", day: "2026-09-14", articles: 1, sources: 1 });
  });

  it("omits empty groups entirely rather than emitting a zero row", () => {
    const rows = [
      { ticker: "AKSGY", article_id: "a1", published_at: "2026-09-13T10:00:00.000Z", source_id: "s1" },
    ];
    const scores = new Map<string, number>([["a1:AKSGY", 0.1]]);
    const result = aggregateAttention(rows, scores);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fetchRelevanceScores / fetchLowRelevanceSince — chunking + fail-open.
// A tiny hand-rolled fake mirroring the shape of the real chainable
// PostgREST builder used elsewhere in this repo's finance suite.
// ---------------------------------------------------------------------------

interface FakeState {
  eq: Array<[string, unknown]>;
  in: Array<[string, unknown[]]>;
  lt: Array<[string, unknown]>;
  gte: Array<[string, unknown]>;
  limit: number | null;
}

function makeFakeSupabase(resolver: (table: string, state: FakeState) => { data: unknown; error: { message: string } | null }) {
  return {
    from(table: string) {
      const state: FakeState = { eq: [], in: [], lt: [], gte: [], limit: null };
      const builder = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          state.eq.push([col, val]);
          return builder;
        },
        in: (col: string, vals: unknown[]) => {
          state.in.push([col, vals]);
          return builder;
        },
        lt: (col: string, val: unknown) => {
          state.lt.push([col, val]);
          return builder;
        },
        gte: (col: string, val: unknown) => {
          state.gte.push([col, val]);
          return builder;
        },
        limit: (n: number) => {
          state.limit = n;
          return builder;
        },
        then: (onFulfilled: (v: unknown) => unknown) =>
          Promise.resolve(resolver(table, state)).then(onFulfilled),
      };
      return builder;
    },
  };
}

describe("fetchRelevanceScores", () => {
  it("chunks 230 keys into 3 requests of at most 100 each", async () => {
    const keys = Array.from({ length: 230 }, (_, i) => `a${i}:THYAO`);
    const calls: unknown[][] = [];
    const supabase = makeFakeSupabase((table, state) => {
      expect(table).toBe("jev_shadow_predictions");
      const inFilter = state.in.find(([c]) => c === "subject_id");
      calls.push(inFilter?.[1] ?? []);
      const data = (inFilter?.[1] ?? []).map((k) => ({ subject_id: k, jev_prob: 0.42 }));
      return { data, error: null };
    });

    const scores = await fetchRelevanceScores(supabase as never, keys);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toHaveLength(100);
    expect(calls[1]).toHaveLength(100);
    expect(calls[2]).toHaveLength(30);
    expect(scores.get("a0:THYAO")).toBe(0.42);
    expect(scores.size).toBe(230);
  });

  it("returns the partial map built so far when a chunk errors, and warns", async () => {
    const keys = Array.from({ length: 150 }, (_, i) => `a${i}:THYAO`);
    let callIndex = 0;
    const supabase = makeFakeSupabase((_table, state) => {
      callIndex++;
      if (callIndex === 1) {
        const inFilter = state.in.find(([c]) => c === "subject_id");
        const data = (inFilter?.[1] ?? []).map((k) => ({ subject_id: k, jev_prob: 0.1 }));
        return { data, error: null };
      }
      return { data: null, error: { message: "boom" } };
    });

    const warnSpy = vi_spyOnConsoleWarn();
    try {
      const scores = await fetchRelevanceScores(supabase as never, keys);
      expect(scores.size).toBe(100);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("skips non-finite jev_prob values", async () => {
    const supabase = makeFakeSupabase(() => ({
      data: [
        { subject_id: "a1:THYAO", jev_prob: 0.5 },
        { subject_id: "a2:THYAO", jev_prob: null },
        { subject_id: "a3:THYAO", jev_prob: "not-a-number" },
      ],
      error: null,
    }));
    const scores = await fetchRelevanceScores(supabase as never, ["a1:THYAO", "a2:THYAO", "a3:THYAO"]);
    expect(scores.get("a1:THYAO")).toBe(0.5);
    expect(scores.has("a2:THYAO")).toBe(false);
    expect(scores.has("a3:THYAO")).toBe(false);
  });

  it("returns an empty map for an empty key list without querying", async () => {
    let called = false;
    const supabase = makeFakeSupabase(() => {
      called = true;
      return { data: [], error: null };
    });
    const scores = await fetchRelevanceScores(supabase as never, []);
    expect(scores.size).toBe(0);
    expect(called).toBe(false);
  });
});

describe("fetchLowRelevanceSince", () => {
  it("filters task=ticker_relevance, jev_prob<0.5, created_at>=sinceIso, limit 5000", async () => {
    let seenTable = "";
    let seenState: FakeState | null = null;
    const supabase = makeFakeSupabase((table, state) => {
      seenTable = table;
      seenState = state;
      return { data: [{ subject_id: "a1:THYAO", jev_prob: 0.3 }], error: null };
    });
    const rows = await fetchLowRelevanceSince(supabase as never, "2026-09-06T00:00:00+03:00");
    expect(seenTable).toBe("jev_shadow_predictions");
    expect(seenState!.eq).toEqual([["task", "ticker_relevance"]]);
    expect(seenState!.lt).toEqual([["jev_prob", 0.5]]);
    expect(seenState!.gte).toEqual([["created_at", "2026-09-06T00:00:00+03:00"]]);
    expect(seenState!.limit).toBe(5000);
    expect(rows).toEqual([{ subject_id: "a1:THYAO", jev_prob: 0.3 }]);
  });

  it("fails open (returns []) and warns on a Supabase error", async () => {
    const supabase = makeFakeSupabase(() => ({ data: null, error: { message: "boom" } }));
    const warnSpy = vi_spyOnConsoleWarn();
    try {
      const rows = await fetchLowRelevanceSince(supabase as never, "2026-09-06T00:00:00+03:00");
      expect(rows).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

function vi_spyOnConsoleWarn() {
  return vi.spyOn(console, "warn").mockImplementation(() => {});
}

describe("static guard: jev.ts subject_id format (read-only)", () => {
  it("still writes ticker_relevance subject_id as `${article_id}:${ticker}`", () => {
    const jevPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../supabase/functions/_shared/jev.ts",
    );
    const text = readFileSync(jevPath, "utf8");
    expect(text).toContain("subjectId: `${t.article_id}:${t.ticker}`");
    expect(text).toContain('"ticker_relevance"');
  });
});
