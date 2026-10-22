import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// /oyun headline pool -- cache lifetime + failure contract.
//
// `getGameHeadlines` is a "use cache" function, so its RETURN VALUE is
// memoised. A fetch failure must therefore (a) be distinguishable from a
// legitimately empty pool (`null` vs `[]`) and (b) get the short "minutes"
// lifetime instead of the 5-minute "cluster-feed" one. `loadGameHeadlines`
// is the uncached entry point that adds one live retry on top.
// next/cache is mocked (no cache runtime in vitest); "use cache" is a no-op
// string directive here, so every call really executes.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

type Outcome =
  | { kind: "rows"; rows: unknown[] }
  | { kind: "error"; message: string }
  | { kind: "throw"; message: string };

const fixture = vi.hoisted(() => ({
  /** One outcome per clusters query, in order; the last one sticks. */
  outcomes: [] as Outcome[],
  queries: 0,
}));

const supabaseMock = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  const fake = helper.createSupabaseFake({
    tables: {
      clusters: () => {
        const idx = Math.min(fixture.queries, fixture.outcomes.length - 1);
        fixture.queries += 1;
        const outcome = fixture.outcomes[idx];
        if (!outcome) return { data: [], error: null };
        if (outcome.kind === "throw") throw new Error(outcome.message);
        if (outcome.kind === "error") {
          return { data: null, error: { message: outcome.message } };
        }
        return { data: outcome.rows, error: null };
      },
    },
  });
  return { fake, createClient: vi.fn(() => fake.client) };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: supabaseMock.createClient,
}));

import { cacheLife, cacheTag } from "next/cache";

import { getGameHeadlines, loadGameHeadlines } from "./headline-pool";

const ORIGINAL_ENV = { ...process.env };

function eligibleRow(n: number) {
  return {
    article_count: 3,
    cluster_articles: [
      {
        articles: {
          id: `article-${n}`,
          title: "Merkez Bankası faiz kararını bugün açıklayacak",
          published_at: new Date(Date.now() - 3_600_000).toISOString(),
          source_id: `source-${n}`,
          sources: {
            id: `source-${n}`,
            name: `Kaynak ${n}`,
            slug: `kaynak-${n}`,
            bias: "center",
            kind: "outlet",
            active: true,
          },
        },
      },
    ],
  };
}

const rows = (n: number): Outcome => ({
  kind: "rows",
  rows: Array.from({ length: n }, (_, i) => eligibleRow(i + 1)),
});
const failure: Outcome = { kind: "error", message: "canceling statement due to statement timeout" };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.outcomes = [];
  fixture.queries = 0;
  vi.mocked(cacheLife).mockClear();
  vi.mocked(cacheTag).mockClear();
  supabaseMock.createClient.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

describe("getGameHeadlines -- cache lifetime follows the outcome", () => {
  it("success: returns the eligible pool and caches it with 'cluster-feed' (one cacheLife call)", async () => {
    fixture.outcomes = [rows(2)];

    const pool = await getGameHeadlines();

    expect(pool).toHaveLength(2);
    expect(pool?.[0]).toMatchObject({ articleId: "article-1", sourceName: "Kaynak 1" });
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
    expect(cacheTag).toHaveBeenCalledWith("articles");
  });

  it("select error: null (not []) and the short 'minutes' lifetime", async () => {
    fixture.outcomes = [failure];

    await expect(getGameHeadlines()).resolves.toBeNull();

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("the client/resolver throws: null and 'minutes', and it never rejects", async () => {
    fixture.outcomes = [{ kind: "throw", message: "socket hang up" }];

    await expect(getGameHeadlines()).resolves.toBeNull();

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("missing Supabase env vars: null and 'minutes' (createServerClient throws inside the fetch)", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    await expect(getGameHeadlines()).resolves.toBeNull();

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("empty data: a VALID empty pool ([]) keeps the normal 'cluster-feed' lifetime", async () => {
    fixture.outcomes = [{ kind: "rows", rows: [] }];

    await expect(getGameHeadlines()).resolves.toEqual([]);

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
  });

  it("rows that all fail the eligibility rules still count as a valid empty pool", async () => {
    fixture.outcomes = [{ kind: "rows", rows: [{ article_count: 1, cluster_articles: [] }] }];

    await expect(getGameHeadlines()).resolves.toEqual([]);

    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
  });
});

describe("getGameHeadlines -- uses the fail-fast reader client", () => {
  it("builds the Supabase client with a fetch wrapper (the 4 s timeout)", async () => {
    fixture.outcomes = [rows(1)];

    await getGameHeadlines();

    expect(supabaseMock.createClient).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "test-service-role-key",
      expect.objectContaining({
        global: expect.objectContaining({ fetch: expect.any(Function) }),
      }),
    );
  });
});

describe("loadGameHeadlines -- uncached entry with one live retry", () => {
  it("first attempt succeeds: returns the pool without a second query", async () => {
    fixture.outcomes = [rows(2)];

    const pool = await loadGameHeadlines();

    expect(pool).toHaveLength(2);
    expect(fixture.queries).toBe(1);
  });

  it("first attempt errors, the live retry succeeds: returns the pool", async () => {
    fixture.outcomes = [failure, rows(3)];

    const pool = await loadGameHeadlines();

    expect(pool).toHaveLength(3);
    expect(fixture.queries).toBe(2);
  });

  it("both attempts fail: null (so the page shows the retry state, not 'no headlines')", async () => {
    fixture.outcomes = [failure, failure];

    await expect(loadGameHeadlines()).resolves.toBeNull();

    expect(fixture.queries).toBe(2);
  });

  it("a legitimately empty pool is returned as [] and is NOT retried", async () => {
    fixture.outcomes = [{ kind: "rows", rows: [] }];

    await expect(loadGameHeadlines()).resolves.toEqual([]);

    expect(fixture.queries).toBe(1);
  });

  it("never rejects even when both attempts throw", async () => {
    fixture.outcomes = [{ kind: "throw", message: "boom" }];

    await expect(loadGameHeadlines()).resolves.toBeNull();
  });
});
