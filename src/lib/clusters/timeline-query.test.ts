import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// getRecentClusters was extracted out of src/app/timeline/page.tsx into this
// module. Harness mirrors search-query.test.ts. The fake `clusters` resolver
// tells the two reads apart by the select string: `"id"` is the head/exact
// count read, anything else is the row read.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const fixture = vi.hoisted(() => ({
  data: [] as unknown[],
  error: null as { message: string } | null,
  /** The head/exact count the count read reports (null = no Content-Range total). */
  count: null as number | null,
  countError: null as { message: string } | null,
  countThrows: false,
  /** Builder state of the last ROW read. */
  lastState: null as unknown,
  /** Builder state of the last COUNT read. */
  countState: null as unknown,
  /** The options object each `createClient(url, key, opts)` call received. */
  clientOpts: [] as unknown[],
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      clusters: (state) => {
        if (state.selectArgs[0] === "id") {
          fixture.countState = state;
          if (fixture.countThrows) throw new Error("count boom");
          if (fixture.countError) {
            return { data: null, error: fixture.countError, count: null };
          }
          return { data: null, error: null, count: fixture.count };
        }
        fixture.lastState = state;
        return { data: fixture.data, error: fixture.error };
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
import { getRecentClusters, TIMELINE_LIMIT } from "./timeline-query";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";

const ORIGINAL_ENV = { ...process.env };

function mkRow(id: string, firstPublished = "2026-09-18T10:00:00.000Z") {
  return {
    id,
    title_tr: `Küme ${id}`,
    title_tr_neutral: null,
    article_count: 3,
    first_published: firstPublished,
  };
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.data = [];
  fixture.error = null;
  fixture.count = null;
  fixture.countError = null;
  fixture.countThrows = false;
  fixture.lastState = null;
  fixture.countState = null;
  fixture.clientOpts = [];
  vi.mocked(cacheLife).mockClear();
  vi.mocked(cacheTag).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

describe("TIMELINE_LIMIT", () => {
  it("is 200 (covers ~20 h of a ~234-clusters-per-24-h day; the copy names the real total for the rest)", () => {
    expect(TIMELINE_LIMIT).toBe(200);
  });
});

describe("getRecentClusters row read shape", () => {
  it("keeps only real clusters (article_count >= 2, not archived) in the 24h window, newest first, capped at TIMELINE_LIMIT", async () => {
    await getRecentClusters();

    const state = fixture.lastState as BuilderState;
    expect(state.table).toBe("clusters");
    expect(state.eq).toEqual([{ col: "is_archived", val: false }]);
    expect(state.gte).toContainEqual({ col: "article_count", val: 2 });
    expect(state.gt[0]?.col).toBe("first_published");
    expect(state.order).toEqual([
      { col: "first_published", opts: { ascending: false } },
    ]);
    expect(state.limit).toBe(TIMELINE_LIMIT);
    expect(state.limit).toBe(200);
  });
});

describe("getRecentClusters count read shape", () => {
  it("is a head/exact count with the same filters and the SAME first_published bound as the row read", async () => {
    await getRecentClusters();

    const rowState = fixture.lastState as BuilderState;
    const countState = fixture.countState as BuilderState;
    expect(countState).not.toBeNull();
    expect(countState.table).toBe("clusters");
    expect(countState.selectArgs[0]).toBe("id");
    expect(countState.selectArgs[1]).toEqual({ count: "exact", head: true });
    expect(countState.eq).toEqual(rowState.eq);
    expect(countState.eq).toEqual([{ col: "is_archived", val: false }]);
    expect(countState.gte).toContainEqual({ col: "article_count", val: 2 });
    expect(countState.gt[0]?.col).toBe("first_published");
    // One clock read: both reads must count the exact same window.
    expect(countState.gt[0]?.val).toBe(rowState.gt[0]?.val);
  });
});

const TIMEOUT_MESSAGE = "AbortError: Supabase request exceeded 4000 ms";

describe("getRecentClusters read profile", () => {
  it("builds only capped reader clients", async () => {
    await getRecentClusters();
    expect(fixture.clientOpts.length).toBeGreaterThanOrEqual(1);
    expect(fixture.clientOpts.every(isCappedClientOpts)).toBe(true);
  });

  it("shares ONE reader client between the row read and the count read", async () => {
    fixture.count = 5;
    await getRecentClusters();
    expect(fixture.lastState).not.toBeNull();
    expect(fixture.countState).not.toBeNull();
    expect(fixture.clientOpts).toHaveLength(1);
  });
});

describe("getRecentClusters result + cache lifetime", () => {
  it("returns { rows, total } on success and caches them for cluster-feed, once", async () => {
    fixture.data = [mkRow("c1")];
    fixture.count = 234;

    const result = await getRecentClusters();

    expect(result).toEqual({ rows: fixture.data, total: 234 });
    expect(cacheTag).toHaveBeenCalledWith("clusters");
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
  });

  it("returns empty rows (not null) when the window legitimately matched nothing", async () => {
    fixture.data = [];
    fixture.count = 0;

    await expect(getRecentClusters()).resolves.toEqual({ rows: [], total: 0 });
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
  });

  it("a count error leaves total null but keeps the rows, still cluster-feed, exactly one cacheLife", async () => {
    fixture.data = [mkRow("c1"), mkRow("c2")];
    fixture.countError = { message: "count timed out" };

    const result = await getRecentClusters();

    expect(result).toEqual({ rows: fixture.data, total: null });
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
  });

  it("a count read that throws leaves total null and never fails the attempt", async () => {
    fixture.data = [mkRow("c1")];
    fixture.countThrows = true;

    const result = await getRecentClusters();

    expect(result).toEqual({ rows: fixture.data, total: null });
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
  });

  it("a null count (no Content-Range total) leaves total null rather than inventing a number", async () => {
    fixture.data = [mkRow("c1")];
    fixture.count = null;

    await expect(getRecentClusters()).resolves.toEqual({
      rows: fixture.data,
      total: null,
    });
  });

  it("clamps a count smaller than the rows read up to rows.length (the two reads are not one snapshot)", async () => {
    fixture.data = [mkRow("c1"), mkRow("c2"), mkRow("c3")];
    fixture.count = 2;

    const result = await getRecentClusters();

    expect(result?.rows).toHaveLength(3);
    expect(result?.total).toBe(3);
  });

  it("returns null on a row-read Supabase error and never throws into the prerender", async () => {
    fixture.error = { message: "relation missing" };
    fixture.count = 10;

    await expect(getRecentClusters()).resolves.toBeNull();
  });

  it("a row-read timeout resolves null and is cached for minutes only (exactly one cacheLife)", async () => {
    fixture.error = { message: TIMEOUT_MESSAGE };

    await expect(getRecentClusters()).resolves.toBeNull();

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("cluster-feed");
  });

  it("a row-read error wins over a failing count read: still null, still minutes", async () => {
    fixture.error = { message: TIMEOUT_MESSAGE };
    fixture.countError = { message: TIMEOUT_MESSAGE };

    await expect(getRecentClusters()).resolves.toBeNull();
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("tags the entry before the fetch (cacheTag precedes cacheLife)", async () => {
    await getRecentClusters();
    expect(vi.mocked(cacheTag).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(cacheLife).mock.invocationCallOrder[0]!,
    );
  });

  it("does not retry live: a failed attempt builds exactly one client (static route, the clock read stays inside the cache scope)", async () => {
    fixture.error = { message: TIMEOUT_MESSAGE };

    await getRecentClusters();

    // One fetch = one createReaderClient() = one createClient(), shared by
    // the row read and the count read.
    expect(fixture.clientOpts).toHaveLength(1);
  });
});
