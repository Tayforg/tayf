import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Uses the shared proxy-based Supabase fake (tests/_helpers/supabase-fake.ts).
// Each `.from(table)` call gets its own fresh builder/state, so per-table
// fixture functions below push every call's accumulated state onto an
// array the tests can introspect (predicate shape, `.in()` order, etc).
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const fixture = vi.hoisted(() => ({
  predictionRows: [] as Array<{ article_id: string | null }>,
  predictionError: null as { message: string } | null,
  articleRows: [] as unknown[],
  articlesError: null as { message: string } | null,
  versionRows: [] as Array<{ article_id: string }>,
  predictionCalls: [] as unknown[],
  articleCalls: [] as unknown[],
  versionCalls: [] as unknown[],
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      jev_shadow_predictions: (state) => {
        fixture.predictionCalls.push(state);
        if (fixture.predictionError) return { data: null, error: fixture.predictionError };
        return { data: fixture.predictionRows, error: null };
      },
      articles: (state) => {
        fixture.articleCalls.push(state);
        if (fixture.articlesError) return { data: null, error: fixture.articlesError };
        return { data: fixture.articleRows, error: null };
      },
      article_title_versions: (state) => {
        fixture.versionCalls.push(state);
        return { data: fixture.versionRows, error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

const { fetchDailyPuzzle, getDailyPuzzle } = await import("./daily-query");
const { dailyHash, puzzleWindow } = await import("./daily-set");
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";

const DATE_KEY = "2026-10-05";
const WINDOW = puzzleWindow(DATE_KEY);

const ZONE_BIAS = {
  iktidar: "pro_government",
  bagimsiz: "center",
  muhalefet: "opposition",
} as const;

function articleRow(i: number, zone: keyof typeof ZONE_BIAS, overrides: Record<string, unknown> = {}) {
  return {
    id: `article-${i}`,
    title: `Siyasi gündemde bugün ${i}. önemli bir gelişme yaşandı bu haberde`,
    url: `https://ornek.com/haber/${i}`,
    published_at: WINDOW.startIso,
    created_at: WINDOW.startIso,
    source_id: `source-${i}`,
    sources: {
      id: `source-${i}`,
      name: `Kaynak ${i}`,
      slug: `kaynak-${i}`,
      bias: ZONE_BIAS[zone],
      kind: "outlet",
      active: true,
    },
    cluster_articles: [{ cluster_id: `cluster-${i}` }],
    ...overrides,
  };
}

// 6 candidates spread across the 3 zones — one extra beyond the minimum 5
// so a single edited-title exclusion still leaves a full playable set.
function sixEligibleRows() {
  const zones: Array<keyof typeof ZONE_BIAS> = [
    "iktidar",
    "bagimsiz",
    "muhalefet",
    "iktidar",
    "bagimsiz",
    "muhalefet",
  ];
  return zones.map((zone, i) => articleRow(i, zone));
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.predictionRows = [];
  fixture.predictionError = null;
  fixture.articleRows = [];
  fixture.articlesError = null;
  fixture.versionRows = [];
  fixture.predictionCalls = [];
  fixture.articleCalls = [];
  fixture.versionCalls = [];
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

describe("fetchDailyPuzzle — predictions paging", () => {
  it("records the exact predicate/paging shape and stops on a short page", async () => {
    fixture.predictionRows = [{ article_id: "article-0" }, { article_id: "article-1" }];
    fixture.articleRows = sixEligibleRows();

    await getDailyPuzzle(DATE_KEY);

    expect(fixture.predictionCalls).toHaveLength(1);
    const state = fixture.predictionCalls[0] as BuilderState;
    expect(state.eq).toContainEqual({ col: "task", val: "politics" });
    expect(state.gte).toContainEqual({ col: "jev_prob", val: 0.7 });
    expect(state.gte).toContainEqual({ col: "created_at", val: WINDOW.startIso });
    expect(state.lt).toContainEqual({ col: "created_at", val: WINDOW.endIso });
    expect(state.not).toContainEqual({ col: "article_id", op: "is", val: null });
    expect(state.range).toEqual({ from: 0, to: 999 });
    expect(state.order).toContainEqual({ col: "created_at", opts: { ascending: true } });
    expect(state.order).toContainEqual({ col: "id", opts: { ascending: true } });
  });
});

describe("fetchDailyPuzzle — article fetch order", () => {
  it("requests articles with .in in dailyHash order", async () => {
    fixture.predictionRows = [
      { article_id: "article-0" },
      { article_id: "article-1" },
      { article_id: "article-2" },
      { article_id: "article-3" },
      { article_id: "article-4" },
      { article_id: "article-5" },
    ];
    fixture.articleRows = sixEligibleRows();

    await getDailyPuzzle(DATE_KEY);

    expect(fixture.articleCalls.length).toBeGreaterThan(0);
    const state = fixture.articleCalls[0] as BuilderState;
    const requestedIds = state.in[0]?.vals as string[];

    const expectedIds = [
      "article-0",
      "article-1",
      "article-2",
      "article-3",
      "article-4",
      "article-5",
    ].sort((a, b) => dailyHash(DATE_KEY, a) - dailyHash(DATE_KEY, b));

    expect(requestedIds).toEqual(expectedIds);
  });
});

describe("fetchDailyPuzzle — edited-title exclusion", () => {
  it("excludes an article with a row in article_title_versions", async () => {
    fixture.predictionRows = [
      { article_id: "article-0" },
      { article_id: "article-1" },
      { article_id: "article-2" },
      { article_id: "article-3" },
      { article_id: "article-4" },
      { article_id: "article-5" },
    ];
    fixture.articleRows = sixEligibleRows();
    fixture.versionRows = [{ article_id: "article-0" }];

    const puzzle = await fetchDailyPuzzle(DATE_KEY);

    expect(puzzle.headlines).toHaveLength(5);
    expect(puzzle.headlines.some((h) => h.articleId === "article-0")).toBe(false);
  });
});

describe("fetchDailyPuzzle — error handling", () => {
  it("rejects on a Supabase error, and getDailyPuzzle fails open to null", async () => {
    fixture.predictionError = { message: "connection reset" };

    await expect(fetchDailyPuzzle(DATE_KEY)).rejects.toThrow();
    await expect(getDailyPuzzle(DATE_KEY)).resolves.toBeNull();
  });

  it("logs the failure with the [gunun-tayfi] prefix and the date key", async () => {
    fixture.predictionError = { message: "connection reset" };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await getDailyPuzzle(DATE_KEY);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining(`[gunun-tayfi] puzzle unavailable for ${DATE_KEY}`));
    spy.mockRestore();
  });
});

describe("fetchDailyPuzzle — incomplete set", () => {
  it("rejects when fewer than 5 eligible candidates exist", async () => {
    fixture.predictionRows = [
      { article_id: "article-0" },
      { article_id: "article-1" },
      { article_id: "article-2" },
    ];
    fixture.articleRows = [
      articleRow(0, "iktidar"),
      articleRow(1, "bagimsiz"),
      articleRow(2, "muhalefet"),
    ];

    await expect(fetchDailyPuzzle(DATE_KEY)).rejects.toThrow();
    await expect(getDailyPuzzle(DATE_KEY)).resolves.toBeNull();
  });
});
