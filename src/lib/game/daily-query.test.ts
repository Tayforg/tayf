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
  predictionError: null as { message: string; hint?: string; code?: string } | null,
  articleRows: [] as unknown[],
  articlesError: null as { message: string } | null,
  versionRows: [] as Array<{ article_id: string }>,
  predictionCalls: [] as unknown[],
  articleCalls: [] as unknown[],
  versionCalls: [] as unknown[],
  /** The options object each `createClient(url, key, opts)` call received. */
  clientOpts: [] as unknown[],
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
  createClient: (_url: string, _key: string, opts?: unknown) => {
    fixture.clientOpts.push(opts);
    return supabaseFake.client;
  },
}));

import { cacheLife } from "next/cache";

const { fetchDailyPuzzleCached, getDailyPuzzle } = await import("./daily-query");
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
function sixPredictionRows() {
  return Array.from({ length: 6 }, (_, i) => ({ article_id: `article-${i}` }));
}

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
  fixture.clientOpts = [];
  vi.mocked(cacheLife).mockClear();
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

describe("daily puzzle — predictions paging", () => {
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

describe("daily puzzle — article fetch order", () => {
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

describe("daily puzzle — edited-title exclusion", () => {
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

    const attempt = await fetchDailyPuzzleCached(DATE_KEY);

    expect(attempt.ok).toBe(true);
    if (!attempt.ok) return;
    expect(attempt.data.headlines).toHaveLength(5);
    expect(attempt.data.headlines.some((h) => h.articleId === "article-0")).toBe(false);
  });
});

describe("daily puzzle — error handling", () => {
  it("a Supabase error comes back as { ok: false } (it never rejects), and getDailyPuzzle fails open to null", async () => {
    fixture.predictionError = { message: "connection reset" };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const attempt = await fetchDailyPuzzleCached(DATE_KEY);
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.error).toContain("connection reset");

    await expect(getDailyPuzzle(DATE_KEY)).resolves.toBeNull();
    errSpy.mockRestore();
  });

  it("a reader-cap timeout (AbortError) is a failed attempt, not a rejection", async () => {
    fixture.predictionError = {
      message: "AbortError: Supabase request exceeded 4000 ms",
      hint: "Request was aborted (timeout or manual cancellation)",
      code: "",
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const attempt = await fetchDailyPuzzleCached(DATE_KEY);
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.error).toContain("AbortError");

    await expect(getDailyPuzzle(DATE_KEY)).resolves.toBeNull();
    errSpy.mockRestore();
  });

  it("a missing-env failure is contained too: { ok: false }, never a throw across the cache boundary", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(fetchDailyPuzzleCached(DATE_KEY)).resolves.toMatchObject({ ok: false });
    await expect(getDailyPuzzle(DATE_KEY)).resolves.toBeNull();
    errSpy.mockRestore();
  });

  it("logs the failure with the [gunun-tayfi] prefix and the date key", async () => {
    fixture.predictionError = { message: "connection reset" };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await getDailyPuzzle(DATE_KEY);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining(`[gunun-tayfi] puzzle unavailable for ${DATE_KEY}`));
    spy.mockRestore();
  });
});

describe("daily puzzle — incomplete set", () => {
  it("is a failed attempt ({ ok: false }) when fewer than 5 eligible candidates exist", async () => {
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
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const attempt = await fetchDailyPuzzleCached(DATE_KEY);
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.error).toContain("incomplete daily set");

    await expect(getDailyPuzzle(DATE_KEY)).resolves.toBeNull();
    errSpy.mockRestore();
  });
});

describe("daily puzzle — cache lifetime", () => {
  it("success calls cacheLife exactly once with days", async () => {
    fixture.predictionRows = sixPredictionRows();
    fixture.articleRows = sixEligibleRows();

    const attempt = await fetchDailyPuzzleCached(DATE_KEY);

    expect(attempt.ok).toBe(true);
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("days");
  });

  it("an error calls cacheLife exactly once with minutes (a blip must not park a failure for days)", async () => {
    fixture.predictionError = { message: "connection reset" };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await fetchDailyPuzzleCached(DATE_KEY);

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    errSpy.mockRestore();
  });

  it("an incomplete set calls cacheLife exactly once with minutes", async () => {
    fixture.predictionRows = [{ article_id: "article-0" }];
    fixture.articleRows = [articleRow(0, "iktidar")];
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await fetchDailyPuzzleCached(DATE_KEY);

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    errSpy.mockRestore();
  });

  it("getDailyPuzzle makes exactly one cached call and does NOT retry live (a build is too heavy to repeat per request)", async () => {
    fixture.predictionError = { message: "connection reset" };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(getDailyPuzzle(DATE_KEY)).resolves.toBeNull();

    expect(fixture.predictionCalls).toHaveLength(1);
    expect(fixture.clientOpts).toHaveLength(1);
    expect(cacheLife).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it("getDailyPuzzle returns the puzzle on success", async () => {
    fixture.predictionRows = sixPredictionRows();
    fixture.articleRows = sixEligibleRows();

    const puzzle = await getDailyPuzzle(DATE_KEY);

    expect(puzzle?.dateKey).toBe(DATE_KEY);
    expect(puzzle?.headlines).toHaveLength(5);
  });
});

describe("daily puzzle — reader cap", () => {
  /** A capped client is built with a custom `global.fetch`; a plain one is not. */
  function isCappedClientOpts(opts: unknown): boolean {
    const g = (opts as { global?: { fetch?: unknown } } | undefined)?.global;
    return typeof g?.fetch === "function";
  }

  it("a build creates exactly ONE capped client", async () => {
    fixture.predictionRows = sixPredictionRows();
    fixture.articleRows = sixEligibleRows();

    await getDailyPuzzle(DATE_KEY);

    expect(fixture.clientOpts).toHaveLength(1);
    expect(isCappedClientOpts(fixture.clientOpts[0])).toBe(true);
  });

  it("still exactly one client when the build needs several article chunks and several prediction pages", async () => {
    // 1000-row first page forces a second prediction page; 154 ghost ids
    // (no article row) + the 6 real ones spread across >= 2 chunks of 80.
    const real = ["article-0", "article-1", "article-2", "article-3", "article-4", "article-5"];
    const ghosts = Array.from({ length: 994 }, (_, i) => `ghost-${i}`);
    fixture.predictionRows = [...real, ...ghosts].map((article_id) => ({ article_id }));
    fixture.articleRows = sixEligibleRows();

    const attempt = await fetchDailyPuzzleCached(DATE_KEY);

    expect(fixture.predictionCalls.length).toBeGreaterThanOrEqual(2);
    expect(fixture.articleCalls.length).toBeGreaterThanOrEqual(2);
    expect(attempt.ok).toBe(true);
    expect(fixture.clientOpts).toHaveLength(1);
    expect(isCappedClientOpts(fixture.clientOpts[0])).toBe(true);
  });
});
