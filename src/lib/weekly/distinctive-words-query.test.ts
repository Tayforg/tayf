import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Harness mirrors src/lib/clusters/story-timeline-query.test.ts: next/cache
// is a no-op and the shared chainable Supabase fake stands in for
// PostgREST.

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const SOURCES = [
  { id: "gov-1", name: "Gov 1", bias: "pro_government", kind: "outlet", active: true },
  { id: "ind-1", name: "Center 1", bias: "center", kind: "outlet", active: true },
  { id: "opp-1", name: "Opp 1", bias: "opposition", kind: "outlet", active: true },
];

const fixture = vi.hoisted(() => ({
  sourcesData: [] as unknown[] | null,
  sourcesError: null as { message: string } | null,
  articlesData: [] as unknown[] | null,
  articlesError: null as { message: string } | null,
  articleStates: [] as unknown[],
  sourcesState: null as unknown,
  /** The options object each `createClient(url, key, opts)` call received. */
  clientOpts: [] as unknown[],
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      sources: (state: unknown) => {
        fixture.sourcesState = state;
        return { data: fixture.sourcesData, error: fixture.sourcesError };
      },
      articles: (state: unknown) => {
        fixture.articleStates.push(state);
        return { data: fixture.articlesData, error: fixture.articlesError };
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

/** A capped client is built with a custom `global.fetch`; a plain one is not. */
function isCappedClientOpts(opts: unknown): boolean {
  const g = (opts as { global?: { fetch?: unknown } } | undefined)?.global;
  return typeof g?.fetch === "function";
}

import { cacheLife, cacheTag } from "next/cache";
import {
  fetchWeeklyDistinctiveWords,
  getWeeklyDistinctiveWords,
  WEEKLY_WORDS_PER_ZONE_PER_DAY,
} from "./distinctive-words-query";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.sourcesData = SOURCES;
  fixture.sourcesError = null;
  fixture.articlesData = [];
  fixture.articlesError = null;
  fixture.articleStates = [];
  fixture.sourcesState = null;
  fixture.clientOpts = [];
  vi.mocked(cacheLife).mockClear();
  vi.mocked(cacheTag).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

describe("fetchWeeklyDistinctiveWords", () => {
  it("filters sources to active = true", async () => {
    await fetchWeeklyDistinctiveWords();
    const state = fixture.sourcesState as BuilderState;
    expect(state.table).toBe("sources");
    expect(state.eq).toEqual([{ col: "active", val: true }]);
  });

  it("selects slug on sources (the English-outlet allow-list depends on it)", async () => {
    await fetchWeeklyDistinctiveWords();
    const state = fixture.sourcesState as BuilderState;
    expect(state.selectArgs[0]).toBe("id, name, slug, bias, kind, active");
  });

  it("runs exactly 21 article reads (3 zones x 7 days)", async () => {
    await fetchWeeklyDistinctiveWords();
    expect(fixture.articleStates.length).toBe(21);
  });

  it("each article read filters by source_id, created_at window, orders by id, limits to 300", async () => {
    await fetchWeeklyDistinctiveWords();
    for (const s of fixture.articleStates) {
      const state = s as BuilderState;
      expect(state.table).toBe("articles");
      expect(state.in).toHaveLength(1);
      expect(state.in[0]!.col).toBe("source_id");
      expect(state.gte).toHaveLength(1);
      expect(state.gte[0]!.col).toBe("created_at");
      expect(state.lt).toHaveLength(1);
      expect(state.lt[0]!.col).toBe("created_at");
      expect(state.order).toEqual([{ col: "id", opts: { ascending: true } }]);
      expect(state.limit).toBe(WEEKLY_WORDS_PER_ZONE_PER_DAY);
    }
  });

  it("rejects when the sources read errors", async () => {
    fixture.sourcesError = { message: "boom" };
    await expect(fetchWeeklyDistinctiveWords()).rejects.toThrow("boom");
  });

  it("rejects when an articles read errors", async () => {
    fixture.articlesError = { message: "articles boom" };
    await expect(fetchWeeklyDistinctiveWords()).rejects.toThrow("articles boom");
  });
});

describe("getWeeklyDistinctiveWords (never-throws, retry-once wrapper)", () => {
  it("resolves to null when the sources read errors on both the cache attempt and the live retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.sourcesError = { message: "boom" };
    await expect(getWeeklyDistinctiveWords()).resolves.toBeNull();
  });

  it("resolves to null when an articles read errors on both the cache attempt and the live retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.articlesError = { message: "articles boom" };
    await expect(getWeeklyDistinctiveWords()).resolves.toBeNull();
  });

  it("resolves to a value (not null) on success", async () => {
    fixture.articlesData = [];
    const result = await getWeeklyDistinctiveWords();
    expect(result).not.toBeNull();
  });

  it("never throws even when the underlying fetch throws synchronously via a bad Supabase response", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.sourcesError = { message: "connection reset" };
    await expect(getWeeklyDistinctiveWords()).resolves.toBeNull();
  });
});

describe("weekly distinctive words: capped client + cache lifetime", () => {
  it("builds only capped reader clients", async () => {
    await getWeeklyDistinctiveWords();
    expect(fixture.clientOpts.length).toBeGreaterThanOrEqual(1);
    expect(fixture.clientOpts.every(isCappedClientOpts)).toBe(true);
  });

  it("the live retry after a failed cached attempt is capped too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.sourcesError = { message: "AbortError: Supabase request exceeded 4000 ms" };

    await getWeeklyDistinctiveWords();

    // cached attempt + live retry
    expect(fixture.clientOpts).toHaveLength(2);
    expect(fixture.clientOpts.every(isCappedClientOpts)).toBe(true);
  });

  it("success: exactly one cacheLife('weekly-words'), tagged before the fetch", async () => {
    await getWeeklyDistinctiveWords();

    expect(cacheTag).toHaveBeenCalledWith("weekly-words");
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("weekly-words");
    expect(cacheLife).not.toHaveBeenCalledWith("hours");
    expect(vi.mocked(cacheTag).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(cacheLife).mock.invocationCallOrder[0]!,
    );
  });

  it("a timeout resolves null and calls cacheLife('minutes') exactly once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.sourcesError = { message: "AbortError: Supabase request exceeded 4000 ms" };

    await expect(getWeeklyDistinctiveWords()).resolves.toBeNull();

    // cached attempt (cacheLife) + live retry (uncached, no cacheLife)
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("weekly-words");
  });

  it("an articles-read timeout is a failure too, cached for minutes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.articlesError = { message: "AbortError: Supabase request exceeded 4000 ms" };

    await expect(getWeeklyDistinctiveWords()).resolves.toBeNull();
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("weekly-words");
  });
});
