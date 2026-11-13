import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  ALIAS_PRECISION_REPORT_LOW_BELOW,
  aggregateAttention,
  countsTowardAttention,
  fetchLegalNoticeIdsSince,
  fetchLowRelevanceSince,
  fetchRelevanceScores,
  filterFeedTickers,
  isHiddenMatch,
  isLegalNotice,
  isPaidContentUrl,
  istanbulDay,
  LEGAL_NOTICE_LOOKUP_LIMIT,
  relevanceKey,
  RELEVANCE_CHUNK,
  TICKER_ATTENTION_MIN,
  TICKER_HIDE_BELOW,
} from "./ticker-relevance";

describe("ticker-relevance constants", () => {
  it("matches the documented thresholds", () => {
    expect(TICKER_HIDE_BELOW).toBe(0.35);
    expect(TICKER_ATTENTION_MIN).toBe(0.5);
    expect(RELEVANCE_CHUNK).toBe(100);
  });

  it("keeps the alias-precision report's baked-in line at 0.2, apart from the reader gate (migration 179's SQL is applied)", () => {
    expect(ALIAS_PRECISION_REPORT_LOW_BELOW).toBe(0.2);
    expect(ALIAS_PRECISION_REPORT_LOW_BELOW).toBeLessThan(TICKER_HIDE_BELOW);
  });

  it("keeps the hide line under the attention floor (the 0.35-0.5 band is shown but not counted)", () => {
    expect(TICKER_HIDE_BELOW).toBeLessThan(TICKER_ATTENTION_MIN);
  });
});

describe("relevanceKey", () => {
  it("joins articleId and ticker with a colon", () => {
    expect(relevanceKey("a1", "THYAO")).toBe("a1:THYAO");
  });
});

// h176-ekonomi-1: hunt-176 found that since 2026-11-09 the 28 rows Jev scored 0.20-0.35 were all alias
// matches, about 20 of them false by title (a basketball game, an art show, a singer named Berdan).
// The hide line is TICKER_HIDE_BELOW = 0.35, strict '<'.
describe("isHiddenMatch boundaries", () => {
  it("hides just below 0.2", () => {
    expect(isHiddenMatch(0.199)).toBe(true);
  });
  it("hides exactly at 0.2 (the old line: the 0.20-0.35 band is no longer shown)", () => {
    expect(isHiddenMatch(0.2)).toBe(true);
  });
  it("hides just below 0.35", () => {
    expect(isHiddenMatch(0.349)).toBe(true);
  });
  it("shows exactly at 0.35 (strict '<')", () => {
    expect(isHiddenMatch(0.35)).toBe(false);
  });
  it("shows well above the line, including the attention floor", () => {
    expect(isHiddenMatch(0.36)).toBe(false);
    expect(isHiddenMatch(0.5)).toBe(false);
    expect(isHiddenMatch(1)).toBe(false);
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

  // h176-ekonomi-1: the Karar 'COP31 sponsorları kimler' row carried an LMKDC chip scored 0.29.
  it("drops a ticker scored 0.29 and the item left with no ticker (the Karar COP31 / LMKDC row)", () => {
    const items = [
      { id: "k1", title: "COP31 sponsorları kimler, hangi şirketler yer alıyor", url: "https://www.karar.com/ekonomi/cop31", tickers: ["LMKDC"] },
      { id: "k2", title: "3 SENARYO MASADA", url: "https://x/3-senaryo", tickers: ["ISMEN", "TAC"] },
    ];
    const scores = new Map<string, number>([
      ["k1:LMKDC", 0.29],
      ["k2:ISMEN", 0.9],
      ["k2:TAC", 0.31],
    ]);
    expect(filterFeedTickers(items, scores)).toEqual([
      { id: "k2", title: "3 SENARYO MASADA", url: "https://x/3-senaryo", tickers: ["ISMEN"] },
    ]);
  });

  it("keeps a ticker scored exactly 0.35, and drops one scored 0.349", () => {
    const items = [
      { id: "b1", tickers: ["AAAAA"] },
      { id: "b2", tickers: ["BBBBB"] },
    ];
    const scores = new Map<string, number>([
      ["b1:AAAAA", 0.35],
      ["b2:BBBBB", 0.349],
    ]);
    expect(filterFeedTickers(items, scores)).toEqual([{ id: "b1", tickers: ["AAAAA"] }]);
  });

  it("an unscored ticker is still shown (fail-open is unchanged)", () => {
    const items = [{ id: "u1", tickers: ["UNSCO"] }];
    expect(filterFeedTickers(items, new Map())).toEqual(items);
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
    expect(day13).toEqual({ ticker: "THYAO", day: "2026-09-13", articles: 3, sources: 2, sourceIds: ["s1", "s2"] });
    expect(day14).toEqual({ ticker: "THYAO", day: "2026-09-14", articles: 1, sources: 1, sourceIds: ["s4"] });
  });

  it("carries the distinct source ids of each group, sorted, so callers can union them across days", () => {
    const rows = [
      { ticker: "THYAO", article_id: "a1", published_at: "2026-09-13T10:00:00.000Z", source_id: "s9" },
      { ticker: "THYAO", article_id: "a2", published_at: "2026-09-13T11:00:00.000Z", source_id: "s1" },
      { ticker: "THYAO", article_id: "a3", published_at: "2026-09-13T12:00:00.000Z", source_id: "s9" },
      { ticker: "THYAO", article_id: "a4", published_at: "2026-09-13T13:00:00.000Z", source_id: "s5" },
    ];
    const [row] = aggregateAttention(rows, new Map());
    expect(row!.sourceIds).toEqual(["s1", "s5", "s9"]);
    expect(row!.sources).toBe(row!.sourceIds.length);
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

describe("aggregateAttention: legal-notice exclusion", () => {
  const rows = [
    { ticker: "GARAN", article_id: "n1", published_at: "2026-09-13T10:00:00.000Z", source_id: "s1" },
    { ticker: "GARAN", article_id: "a2", published_at: "2026-09-13T11:00:00.000Z", source_id: "s2" },
    { ticker: "AKBNK", article_id: "n1", published_at: "2026-09-13T10:00:00.000Z", source_id: "s1" },
  ];

  it("skips every row whose article_id is in the exclude set, whatever the ticker", () => {
    const out = aggregateAttention(rows, new Map(), new Set(["n1"]));
    expect(out).toEqual([{ ticker: "GARAN", day: "2026-09-13", articles: 1, sources: 1, sourceIds: ["s2"] }]);
  });

  it("omits a (ticker, day) group left empty by the exclusion", () => {
    const out = aggregateAttention(rows, new Map(), new Set(["n1", "a2"]));
    expect(out).toEqual([]);
  });

  it("is a no-op without a set or with an empty set", () => {
    const baseline = aggregateAttention(rows, new Map());
    expect(aggregateAttention(rows, new Map(), undefined)).toEqual(baseline);
    expect(aggregateAttention(rows, new Map(), new Set())).toEqual(baseline);
    expect(baseline.reduce((s, r) => s + r.articles, 0)).toBe(3);
  });

  it("composes with the relevance gate (both filters apply)", () => {
    const scores = new Map<string, number>([["a2:GARAN", 0.1]]);
    const out = aggregateAttention(rows, scores, new Set(["n1"]));
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fetchRelevanceScores / fetchLowRelevanceSince — chunking + fail-open.
// A tiny hand-rolled fake mirroring the shape of the real chainable
// PostgREST builder used elsewhere in this repo's finance suite.
// ---------------------------------------------------------------------------

interface FakeState {
  select: string | null;
  eq: Array<[string, unknown]>;
  in: Array<[string, unknown[]]>;
  lt: Array<[string, unknown]>;
  gte: Array<[string, unknown]>;
  order: Array<[string, unknown]>;
  range: [number, number] | null;
  limit: number | null;
}

function makeFakeSupabase(resolver: (table: string, state: FakeState) => { data: unknown; error: { message: string } | null }) {
  return {
    from(table: string) {
      const state: FakeState = { select: null, eq: [], in: [], lt: [], gte: [], order: [], range: null, limit: null };
      const builder = {
        select: (cols?: string) => {
          state.select = cols ?? null;
          return builder;
        },
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
        order: (col: string, opts?: unknown) => {
          state.order.push([col, opts]);
          return builder;
        },
        range: (from: number, to: number) => {
          state.range = [from, to];
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

describe("fetchLegalNoticeIdsSince (migration 107)", () => {
  it("reads legal_notice_articles.article_id since the cut-off with limit 5000 and returns the id set", async () => {
    let seenTable = "";
    let seenState: FakeState | null = null;
    const supabase = makeFakeSupabase((table, state) => {
      seenTable = table;
      seenState = state;
      return { data: [{ article_id: "n1" }, { article_id: "n2" }, { article_id: "n1" }], error: null };
    });
    const ids = await fetchLegalNoticeIdsSince(supabase as never, "2026-09-06T00:00:00+03:00");
    expect(seenTable).toBe("legal_notice_articles");
    expect(seenState!.select).toBe("article_id");
    expect(seenState!.gte).toEqual([["published_at", "2026-09-06T00:00:00+03:00"]]);
    expect(seenState!.limit).toBe(5000);
    expect(seenState!.range).toBeNull();
    // Deterministic order, so continuation pages never skip or repeat a row.
    expect(seenState!.order).toEqual([
      ["published_at", { ascending: false }],
      ["article_id", undefined],
    ]);
    expect(LEGAL_NOTICE_LOOKUP_LIMIT).toBe(5000);
    expect(ids).toBeInstanceOf(Set);
    expect([...ids].sort()).toEqual(["n1", "n2"]);
  });

  // PostgREST truncates every response at max_rows (1,000) whatever .limit()
  // asks for. Migration 107 Step 0: about 27 notices a day, so the 30-day set is
  // ~820 rows today and will cross 1,000. A response of exactly 1,000 rows
  // means "cut off": the reader continues with .range() pages.
  describe("PostgREST max_rows (1,000) continuation", () => {
    const ids = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ article_id: `n${from + i}` }));

    it("does not page when the first response is below the 1,000-row cap", async () => {
      let calls = 0;
      const supabase = makeFakeSupabase(() => {
        calls++;
        return { data: ids(0, 999), error: null };
      });
      const out = await fetchLegalNoticeIdsSince(supabase as never, "2026-09-06T00:00:00+03:00");
      expect(calls).toBe(1);
      expect(out.size).toBe(999);
    });

    it("continues with .range() pages while a response comes back full, and stops at the first short page", async () => {
      const seen: Array<{ range: [number, number] | null; limit: number | null }> = [];
      const supabase = makeFakeSupabase((_table, state) => {
        seen.push({ range: state.range, limit: state.limit });
        const from = state.range ? state.range[0] : 0;
        // 2,350 rows exist; the server caps each response at 1,000.
        return { data: ids(from, Math.max(0, Math.min(1000, 2350 - from))), error: null };
      });
      const out = await fetchLegalNoticeIdsSince(supabase as never, "2026-09-06T00:00:00+03:00");
      expect(seen).toEqual([
        { range: null, limit: 5000 },
        { range: [1000, 1999], limit: null },
        { range: [2000, 2999], limit: null },
      ]);
      expect(out.size).toBe(2350);
      expect(out.has("n0") && out.has("n1000") && out.has("n2349")).toBe(true);
    });

    it("never reads past LEGAL_NOTICE_LOOKUP_LIMIT rows (5 pages of 1,000)", async () => {
      let calls = 0;
      const supabase = makeFakeSupabase((_table, state) => {
        calls++;
        const from = state.range ? state.range[0] : 0;
        return { data: ids(from, 1000), error: null };
      });
      const out = await fetchLegalNoticeIdsSince(supabase as never, "2026-09-06T00:00:00+03:00");
      expect(calls).toBe(5);
      expect(out.size).toBe(5000);
    });

    it("keeps the ids read so far and warns when a continuation page fails", async () => {
      let calls = 0;
      const supabase = makeFakeSupabase(() => {
        calls++;
        return calls === 1
          ? { data: ids(0, 1000), error: null }
          : { data: null, error: { message: "canceling statement due to statement timeout" } };
      });
      const warnSpy = vi_spyOnConsoleWarn();
      try {
        const out = await fetchLegalNoticeIdsSince(supabase as never, "2026-09-06T00:00:00+03:00");
        expect(out.size).toBe(1000);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(String(warnSpy.mock.calls[0]![0])).toContain("legal-notice lookup unavailable");
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  it("returns an empty set for no rows or null data", async () => {
    const none = makeFakeSupabase(() => ({ data: [], error: null }));
    expect((await fetchLegalNoticeIdsSince(none as never, "2026-09-06T00:00:00+03:00")).size).toBe(0);
    const nul = makeFakeSupabase(() => ({ data: null, error: null }));
    expect((await fetchLegalNoticeIdsSince(nul as never, "2026-09-06T00:00:00+03:00")).size).toBe(0);
  });

  it("ignores rows without a usable article_id", async () => {
    const supabase = makeFakeSupabase(() => ({
      data: [{ article_id: "n1" }, { article_id: null }, {}, { article_id: 42 }],
      error: null,
    }));
    const ids = await fetchLegalNoticeIdsSince(supabase as never, "2026-09-06T00:00:00+03:00");
    expect([...ids]).toEqual(["n1"]);
  });

  it("fails open (empty set) and warns on a Supabase error, e.g. a statement timeout", async () => {
    const supabase = makeFakeSupabase(() => ({
      data: null,
      error: { message: "canceling statement due to statement timeout" },
    }));
    const warnSpy = vi_spyOnConsoleWarn();
    try {
      const ids = await fetchLegalNoticeIdsSince(supabase as never, "2026-09-06T00:00:00+03:00");
      expect(ids.size).toBe(0);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]![0])).toContain("[finance] legal-notice lookup unavailable:");
      expect(String(warnSpy.mock.calls[0]![0])).toContain("statement timeout");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("fails open and warns when the query throws (table missing before the migration is applied)", async () => {
    const supabase = {
      from() {
        throw new Error('relation "public.legal_notice_articles" does not exist');
      },
    };
    const warnSpy = vi_spyOnConsoleWarn();
    try {
      const ids = await fetchLegalNoticeIdsSince(supabase as never, "2026-09-06T00:00:00+03:00");
      expect(ids.size).toBe(0);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]![0])).toContain("[finance] legal-notice lookup unavailable:");
      expect(String(warnSpy.mock.calls[0]![0])).toContain("does not exist");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("fails open when the awaited builder rejects (network abort), including a non-Error rejection", async () => {
    const supabase = makeFakeSupabase(() => {
      throw "aborted";
    });
    const warnSpy = vi_spyOnConsoleWarn();
    try {
      const ids = await fetchLegalNoticeIdsSince(supabase as never, "2026-09-06T00:00:00+03:00");
      expect(ids.size).toBe(0);
      expect(String(warnSpy.mock.calls[0]![0])).toContain("aborted");
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

describe("filterFeedTickers: legal-notice filter (ingest-hygiene)", () => {
  it("drops an unscored item whose title is a court notice", () => {
    const items = [
      {
        id: "n1",
        tickers: ["GARAN"],
        title: "T.C. SAMSUN 2. SULH HUKUK MAHKEMESİNDEN",
        url: "https://example.com/haber/n1",
      },
      {
        id: "n2",
        tickers: ["GARAN"],
        title: "Garanti BBVA kâr açıkladı",
        url: "https://example.com/haber/n2",
      },
    ];
    const out = filterFeedTickers(items, new Map());
    expect(out.map((i) => i.id)).toEqual(["n2"]);
  });

  it("drops an item whose url path is an /ilan/ section", () => {
    const out = filterFeedTickers(
      [
        {
          id: "n1",
          tickers: ["GARAN"],
          title: "Garanti BBVA satılık",
          url: "https://www.cnnturk.com/ilan/abc",
        },
      ],
      new Map(),
    );
    expect(out).toEqual([]);
  });

  it("keeps an item without a title (fail-open)", () => {
    const out = filterFeedTickers([{ id: "n3", tickers: ["THYAO"] }], new Map());
    expect(out).toEqual([{ id: "n3", tickers: ["THYAO"] }]);
  });

  it("keeps an item whose title/url are not strings (fail-open)", () => {
    const out = filterFeedTickers(
      [{ id: "n4", tickers: ["THYAO"], title: 42, url: { href: "x" } }],
      new Map(),
    );
    expect(out).toHaveLength(1);
  });
});

describe("isLegalNotice re-export", () => {
  it("is exposed from ticker-relevance for finance queries", () => {
    expect(isLegalNotice("BARTIN 2. ASLİYE HUKUK MAHKEMESİ")).toBe(true);
    expect(isLegalNotice("Merkez Bankası faizi sabit tuttu")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// h148-sources-1. A paid advertorial (url section /advertorial/) matched GARAN by
// the alias 'garanti bbva' and showed on /ekonomi/GARAN as Garanti BBVA news.
// filterFeedTickers hides it on read, whatever its relevance score: the rows
// already stored are not rewritten.
// ---------------------------------------------------------------------------

describe("filterFeedTickers: paid content urls (h148-sources-1)", () => {
  const DUNYA_ADV =
    "https://www.dunya.com/advertorial/garanti-bbva-kiraladan-iphonekiralama-ve-dijitalden-ikinci-el-arac-satisi-haberi-846144";

  it("drops an item whose url is a dunya /advertorial/ url even with relevance score 1.0", () => {
    const items = [
      {
        id: "b63a23fd",
        tickers: ["GARAN"],
        title: "GARANTİ BBVA KİRALA'DAN IPHONEKİRALAMA VE DİJİTALDEN İKİNCİ EL ARAÇ SATIŞI",
        url: DUNYA_ADV,
      },
    ];
    const scores = new Map<string, number>([["b63a23fd:GARAN", 1.0]]);
    expect(filterFeedTickers(items, scores)).toEqual([]);
  });

  it("keeps a normal item with the same ticker", () => {
    const items = [
      {
        id: "b63a23fd",
        tickers: ["GARAN"],
        title: "Garanti BBVA kiralama ürünlerini genişletti",
        url: DUNYA_ADV,
      },
      {
        id: "c1",
        tickers: ["GARAN"],
        title: "Garanti BBVA kâr açıkladı",
        url: "https://www.dunya.com/finans/banka/garanti-bbva-kar-acikladi-846200",
      },
    ];
    const scores = new Map<string, number>([
      ["b63a23fd:GARAN", 1.0],
      ["c1:GARAN", 1.0],
    ]);
    expect(filterFeedTickers(items, scores).map((i) => i.id)).toEqual(["c1"]);
  });

  it("drops a /tanitim-bulteni/ item and a second-segment /advertorial/ item", () => {
    const out = filterFeedTickers(
      [
        { id: "p1", tickers: ["GARAN"], title: "Basın bülteni", url: "https://halktv.com.tr/tanitim-bulteni/x-1h" },
        { id: "p2", tickers: ["GARAN"], title: "Reklam", url: "https://x.com/tr/advertorial/y" },
      ],
      new Map(),
    );
    expect(out).toEqual([]);
  });

  it("needs no title: an untitled item with a paid url is still dropped", () => {
    expect(filterFeedTickers([{ id: "p3", tickers: ["GARAN"], url: DUNYA_ADV }], new Map())).toEqual([]);
  });

  it("keeps items whose url is missing or not a string, and lookalike urls (fail-open)", () => {
    const items = [
      { id: "k1", tickers: ["THYAO"], title: "Başlık bir" },
      { id: "k2", tickers: ["THYAO"], title: "Başlık iki", url: { href: DUNYA_ADV } },
      { id: "k3", tickers: ["THYAO"], title: "Başlık üç", url: "https://x.com/haber/advertorial-ajansi-kuruldu-1" },
      { id: "k4", tickers: ["THYAO"], title: "Başlık dört", url: "https://x.com/haber/x?ref=advertorial" },
    ];
    expect(filterFeedTickers(items, new Map()).map((i) => i.id)).toEqual(["k1", "k2", "k3", "k4"]);
  });
});

describe("isPaidContentUrl re-export", () => {
  it("is exposed from ticker-relevance for finance queries", () => {
    expect(isPaidContentUrl("https://www.posta.com.tr/advertorial/x-1")).toBe(true);
    expect(isPaidContentUrl("https://www.posta.com.tr/gundem/x-1")).toBe(false);
  });
});
