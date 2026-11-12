import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// h154-hub-trend. The reader of /gundem/[key]'s daily chart: ONE call of migration 206's entity_cluster_days with the
// hub's own arrays. Same layering as rising-query.ts: an uncached throwing fetch inside attemptCached, a "use cache"
// body that picks the lifetime after the outcome, and a getter that never throws and never retries live.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  clients: 0,
  clientThrows: false,
}));

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createReaderClient: () => {
    mocks.clients += 1;
    if (mocks.clientThrows) throw new Error("missing service role key");
    return { rpc: mocks.rpc };
  },
}));

import { cacheLife, cacheTag } from "next/cache";

import { entityByKey, entityHubHeadlineOnly, entityHubPatterns, entityHubQueries } from "./entity-hub";
import { getHubTrend } from "./hub-trend-query";

const DAYS = [
  "2026-10-30",
  "2026-10-31",
  "2026-11-01",
  "2026-11-02",
  "2026-11-03",
  "2026-11-04",
  "2026-11-05",
  "2026-11-06",
  "2026-11-07",
  "2026-11-08",
  "2026-11-09",
  "2026-11-10",
  "2026-11-11",
  "2026-11-12",
] as const;
const COUNTS = [6, 4, 5, 7, 11, 9, 9, 8, 12, 7, 5, 2, 4, 3] as const; // ozgur-ozel: 92 + 5 earlier

/** What PostgREST hands back for entity_cluster_days: 14 dated rows and the earlier row. */
function goodRows(): Array<{ day: string | null; clusters: number }> {
  return [...DAYS.map((day, i) => ({ day, clusters: COUNTS[i] as number })), { day: null, clusters: 5 }];
}

const GOOD = {
  status: "ok",
  days: DAYS.map((day, i) => ({ day, clusters: COUNTS[i] })),
  earlier: 5,
};

const lifeCalls = () => vi.mocked(cacheLife).mock.calls.map((c) => c[0]);

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.clients = 0;
  mocks.clientThrows = false;
  vi.mocked(cacheLife).mockClear();
  vi.mocked(cacheTag).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getHubTrend: the RPC call", () => {
  it("calls entity_cluster_days once with entityHubQueries, entityHubPatterns and the hub's headline-only flag (akp true, erdogan false) and no p_since", async () => {
    for (const [key, headlineOnly] of [
      ["akp", true],
      ["erdogan", false],
      ["ozgur-ozel", false],
    ] as const) {
      mocks.rpc.mockReset();
      mocks.rpc.mockResolvedValue({ data: goodRows(), error: null });
      const entity = entityByKey(key)!;
      expect(entityHubHeadlineOnly(entity), key).toBe(headlineOnly);

      await getHubTrend(key);

      expect(mocks.rpc, key).toHaveBeenCalledTimes(1);
      const [name, args] = mocks.rpc.mock.calls[0] as [string, Record<string, unknown>];
      expect(name).toBe("entity_cluster_days");
      expect(args).toEqual({
        p_queries: entityHubQueries(entity),
        p_patterns: entityHubPatterns(entity),
        p_headline_only: headlineOnly,
      });
      expect(Object.keys(args).sort()).toEqual(["p_headline_only", "p_patterns", "p_queries"]);
      expect(args.p_queries as string[]).not.toHaveLength(0);
      expect(args.p_patterns as string[]).not.toHaveLength(0);
    }
  });

  it("makes one client and one call per read, never a live retry after a failure", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "statement timeout", code: "57014" } });
    await expect(getHubTrend("erdogan")).resolves.toBeNull();
    expect(mocks.clients).toBe(1);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
});

describe("getHubTrend: a good read", () => {
  it("a good read resolves the parsed trend; cacheTag('clusters-entity') comes first and cacheLife('cluster-feed') is chosen after the attempt", async () => {
    // the rows arrive in any order: the earlier row first, then the days newest first
    mocks.rpc.mockResolvedValue({ data: [...goodRows()].reverse(), error: null });

    const trend = await getHubTrend("ozgur-ozel");

    expect(trend).toEqual(GOOD);
    expect(vi.mocked(cacheTag).mock.calls).toEqual([["clusters-entity"]]);
    expect(lifeCalls()).toEqual(["cluster-feed"]);

    const tagAt = vi.mocked(cacheTag).mock.invocationCallOrder[0] as number;
    const rpcAt = mocks.rpc.mock.invocationCallOrder[0] as number;
    const lifeAt = vi.mocked(cacheLife).mock.invocationCallOrder[0] as number;
    expect(tagAt).toBeLessThan(rpcAt);
    expect(rpcAt).toBeLessThan(lifeAt);
  });

  it("reads bigint counts that arrive as strings", async () => {
    mocks.rpc.mockResolvedValue({
      data: goodRows().map((r) => ({ day: r.day, clusters: String(r.clusters) })),
      error: null,
    });
    await expect(getHubTrend("ozgur-ozel")).resolves.toEqual(GOOD);
  });
});

describe("getHubTrend: unavailable and failing reads", () => {
  it("PGRST202 resolves { status: 'unavailable' } with cacheLife('minutes') and does not throw", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "PGRST202", message: "Could not find the function public.entity_cluster_days(p_headline_only, p_patterns, p_queries) in the schema cache" },
    });

    await expect(getHubTrend("erdogan")).resolves.toEqual({ status: "unavailable" });

    expect(lifeCalls()).toEqual(["minutes"]);
    expect(vi.mocked(cacheTag).mock.calls).toEqual([["clusters-entity"]]);
    // not an error: nothing was logged
    expect(console.error).not.toHaveBeenCalled();
  });

  it("any other error, a throwing client and malformed rows resolve null with cacheLife('minutes')", async () => {
    const failures: Array<[string, () => void]> = [
      ["another error code", () => mocks.rpc.mockResolvedValue({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } })],
      ["an error without a code", () => mocks.rpc.mockResolvedValue({ data: null, error: { message: "boom" } })],
      ["a rejecting rpc", () => mocks.rpc.mockRejectedValue(new Error("connection reset"))],
      ["a throwing rpc call", () => mocks.rpc.mockImplementation(() => { throw new Error("sync boom"); })],
      ["a client that cannot be created", () => { mocks.clientThrows = true; }],
      ["null data and no error", () => mocks.rpc.mockResolvedValue({ data: null, error: null })],
      ["no rows", () => mocks.rpc.mockResolvedValue({ data: [], error: null })],
      ["14 rows (no earlier row)", () => mocks.rpc.mockResolvedValue({ data: goodRows().slice(0, 14), error: null })],
      ["a gap in the days", () => mocks.rpc.mockResolvedValue({ data: goodRows().map((r, i) => (i === 5 ? { ...r, day: "2026-11-20" } : r)), error: null })],
      ["a negative count", () => mocks.rpc.mockResolvedValue({ data: goodRows().map((r, i) => (i === 2 ? { ...r, clusters: -1 } : r)), error: null })],
      ["an object instead of rows", () => mocks.rpc.mockResolvedValue({ data: { day: null }, error: null })],
    ];
    for (const [label, arrange] of failures) {
      mocks.rpc.mockReset();
      mocks.clientThrows = false;
      vi.mocked(cacheLife).mockClear();
      vi.mocked(cacheTag).mockClear();
      vi.mocked(console.error).mockClear();
      arrange();

      await expect(getHubTrend("erdogan"), label).resolves.toBeNull();

      expect(lifeCalls(), label).toEqual(["minutes"]);
      expect(vi.mocked(cacheTag).mock.calls, label).toEqual([["clusters-entity"]]);
      // the failure is logged once, with the hub-trend label, never thrown across the cache boundary
      expect(console.error, label).toHaveBeenCalledTimes(1);
      expect(String(vi.mocked(console.error).mock.calls[0]?.[0]), label).toContain("[hub-trend] error");
    }
  });

  it("the thrown message '[hub-trend] error: <message>' reaches the log line", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "57014", message: "statement timeout" } });
    await getHubTrend("erdogan");
    expect(String(vi.mocked(console.error).mock.calls[0]?.[0])).toContain("[hub-trend] error: statement timeout");
  });
});

describe("getHubTrend: unknown keys", () => {
  it("an unknown key resolves null without creating a client", async () => {
    for (const key of ["bilinmeyen", "", "ERDOGAN", "__proto__", "erdogan ", "../etc"]) {
      await expect(getHubTrend(key), JSON.stringify(key)).resolves.toBeNull();
    }
    expect(mocks.clients).toBe(0);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(cacheTag).not.toHaveBeenCalled();
    expect(cacheLife).not.toHaveBeenCalled();
  });
});

describe("hub-trend-query.ts source", () => {
  const src = readFileSync(resolve(__dirname, "hub-trend-query.ts"), "utf8");

  it("keeps the cache directive and both lifetimes literal, once each, and reads no clock", () => {
    expect(src.split('"use cache"').length - 1).toBe(1);
    expect(src.split('cacheLife("cluster-feed")').length - 1).toBe(1);
    expect(src.split('cacheLife("minutes")').length - 1).toBe(1);
    expect(src.split("cacheLife(").length - 1).toBe(2);
    expect(src).toContain('cacheTag("clusters-entity")');
    // no clock and no request-scope wait anywhere in the file, comments included
    for (const banned of ["Date.now", "currentTimeMs", "connection(", "resolveCachedOrRetry", "awaitRequestScope", "p_since"]) {
      expect(src.includes(banned), banned).toBe(false);
    }
    expect(src).toContain("createReaderClient()");
  });
});
