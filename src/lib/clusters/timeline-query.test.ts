import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// New coverage — getRecentClusters was extracted out of src/app/timeline/
// page.tsx into this module. Harness mirrors search-query.test.ts.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const fixture = vi.hoisted(() => ({
  data: [] as unknown[],
  error: null as { message: string } | null,
  lastState: null as unknown,
  /** The options object each `createClient(url, key, opts)` call received. */
  clientOpts: [] as unknown[],
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      clusters: (state: unknown) => {
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
import { getRecentClusters } from "./timeline-query";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.data = [];
  fixture.error = null;
  fixture.lastState = null;
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

describe("getRecentClusters query shape", () => {
  it("excludes archived clusters and keeps the documented 24h window/order/limit", async () => {
    await getRecentClusters();

    const state = fixture.lastState as BuilderState;
    expect(state.table).toBe("clusters");
    expect(state.eq).toEqual([{ col: "is_archived", val: false }]);
    expect(state.gt[0]?.col).toBe("first_published");
    expect(state.order).toEqual([
      { col: "first_published", opts: { ascending: false } },
    ]);
    expect(state.limit).toBe(100);
  });
});

const TIMEOUT_MESSAGE = "AbortError: Supabase request exceeded 4000 ms";

describe("getRecentClusters read profile", () => {
  it("builds only capped reader clients", async () => {
    await getRecentClusters();
    expect(fixture.clientOpts.length).toBeGreaterThanOrEqual(1);
    expect(fixture.clientOpts.every(isCappedClientOpts)).toBe(true);
  });
});

describe("getRecentClusters result + cache lifetime", () => {
  it("returns the rows on success and caches them for cluster-feed, once", async () => {
    fixture.data = [
      {
        id: "c1",
        title_tr: "Bir",
        title_tr_neutral: null,
        article_count: 3,
        first_published: "2026-09-18T10:00:00.000Z",
      },
    ];

    const rows = await getRecentClusters();

    expect(rows).toEqual(fixture.data);
    expect(cacheTag).toHaveBeenCalledWith("clusters");
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
  });

  it("returns [] (not null) when the window legitimately matched nothing", async () => {
    fixture.data = [];
    await expect(getRecentClusters()).resolves.toEqual([]);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
  });

  it("returns null on a Supabase error and never throws into the prerender", async () => {
    fixture.error = { message: "relation missing" };

    await expect(getRecentClusters()).resolves.toBeNull();
  });

  it("a timeout resolves null and is cached for minutes only (exactly one cacheLife)", async () => {
    fixture.error = { message: TIMEOUT_MESSAGE };

    await expect(getRecentClusters()).resolves.toBeNull();

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("cluster-feed");
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

    // One fetch = one createReaderClient() = one createClient().
    expect(fixture.clientOpts).toHaveLength(1);
  });
});
