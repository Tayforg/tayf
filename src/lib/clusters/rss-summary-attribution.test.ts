import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// getRssSummaryMembers is shared by /rss.xml (user-facing, 4 s reader cap) and
// the weekly digest cron (batch, uncapped). Its cached body must never throw
// across the "use cache" boundary, must pick its cache lifetime from the
// outcome ("minutes" for a failure), and the public entry retries live once
// before reporting `lookupFailed` (which the RSS route turns into "hide every
// excerpt" - the BL-13 rights gate fails closed).
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

type PgError = { message: string; hint?: string; code?: string };

const fixture = vi.hoisted(() => ({
  /** One envelope per query, consumed in order; the last one repeats. */
  responses: [] as Array<{ data: unknown; error: PgError | null }>,
  queryCount: 0,
  lastState: null as unknown,
  /** The options object each `createClient(url, key, opts)` call received. */
  clientOpts: [] as unknown[],
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      cluster_articles: (state: unknown) => {
        fixture.lastState = state;
        const i = Math.min(fixture.queryCount, fixture.responses.length - 1);
        fixture.queryCount += 1;
        return fixture.responses[i] ?? { data: [], error: null };
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

import { cacheLife, cacheTag } from "next/cache";
import { getRssSummaryMembers } from "./rss-summary-attribution";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";

const ORIGINAL_ENV = { ...process.env };

/** A capped client is built with a custom `global.fetch`; a plain one is not. */
function isCappedClientOpts(opts: unknown): boolean {
  const g = (opts as { global?: { fetch?: unknown } } | undefined)?.global;
  return typeof g?.fetch === "function";
}

const TIMEOUT_ENVELOPE = {
  data: null,
  error: {
    message: "AbortError: Supabase request exceeded 4000 ms",
    hint: "Request was aborted (timeout or manual cancellation)",
    code: "",
  },
};

function articleRow(
  clusterId: string,
  sourceId: string,
  publishedAt: string,
  overrides: { excerpt_allowed?: boolean; description?: string | null } = {},
) {
  return {
    cluster_id: clusterId,
    articles: {
      source_id: sourceId,
      published_at: publishedAt,
      content_hash: `h-${clusterId}-${sourceId}`,
      description: overrides.description ?? `desc ${sourceId}`,
      sources: {
        name: `Kaynak ${sourceId}`,
        bias: "center",
        excerpt_allowed: overrides.excerpt_allowed,
      },
    },
  };
}

const OK_ROWS = [
  articleRow("c1", "s1", "2026-01-01T10:00:00.000Z"),
  articleRow("c1", "s2", "2026-01-01T09:00:00.000Z"),
  articleRow("c2", "s3", "2026-01-01T11:00:00.000Z"),
];

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.responses = [{ data: OK_ROWS, error: null }];
  fixture.queryCount = 0;
  fixture.lastState = null;
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

describe("getRssSummaryMembers empty input", () => {
  it("returns an empty, not-failed result for no ids without building a client or querying", async () => {
    const result = await getRssSummaryMembers([]);
    expect(result).toEqual({ members: {}, lookupFailed: false });
    expect(fixture.clientOpts).toHaveLength(0);
    expect(fixture.queryCount).toBe(0);
    expect(cacheLife).not.toHaveBeenCalled();
  });

  it("the batch profile does not query for empty ids either", async () => {
    const result = await getRssSummaryMembers([], { profile: "batch" });
    expect(result).toEqual({ members: {}, lookupFailed: false });
    expect(fixture.queryCount).toBe(0);
  });
});

describe("getRssSummaryMembers read profile", () => {
  it("defaults to the capped reader client (/rss.xml)", async () => {
    await getRssSummaryMembers(["c1", "c2"]);
    expect(fixture.clientOpts).toHaveLength(1);
    expect(isCappedClientOpts(fixture.clientOpts[0])).toBe(true);
  });

  it("an explicit reader profile gets the capped client", async () => {
    await getRssSummaryMembers(["c1"], { profile: "reader" });
    expect(fixture.clientOpts).toHaveLength(1);
    expect(isCappedClientOpts(fixture.clientOpts[0])).toBe(true);
  });

  it("the batch profile (digest cron) gets the plain, uncapped client", async () => {
    await getRssSummaryMembers(["c1"], { profile: "batch" });
    expect(fixture.clientOpts).toHaveLength(1);
    expect(isCappedClientOpts(fixture.clientOpts[0])).toBe(false);
  });

  it("the batch live retry after a failed cache attempt is uncapped too", async () => {
    fixture.responses = [TIMEOUT_ENVELOPE];
    vi.spyOn(console, "error").mockImplementation(() => {});
    await getRssSummaryMembers(["c1"], { profile: "batch" });
    // cached attempt + live retry
    expect(fixture.clientOpts).toHaveLength(2);
    expect(fixture.clientOpts.some(isCappedClientOpts)).toBe(false);
  });
});

describe("getRssSummaryMembers query + projection", () => {
  it("queries cluster_articles for exactly the requested ids", async () => {
    await getRssSummaryMembers(["c1", "c2"]);
    const state = fixture.lastState as BuilderState;
    expect(state.table).toBe("cluster_articles");
    expect(state.in).toEqual([{ col: "cluster_id", vals: ["c1", "c2"] }]);
    expect(String(state.selectArgs[0])).toContain("excerpt_allowed");
  });

  it("groups rows by cluster and keeps the earliest article per source", async () => {
    fixture.responses = [
      {
        data: [
          articleRow("c1", "s1", "2026-01-01T12:00:00.000Z", { description: "later" }),
          articleRow("c1", "s1", "2026-01-01T08:00:00.000Z", { description: "earlier" }),
          articleRow("c1", "s2", "2026-01-01T09:00:00.000Z"),
          { cluster_id: "c2", articles: null },
        ],
        error: null,
      },
    ];
    const { members, lookupFailed } = await getRssSummaryMembers(["c1", "c2"]);
    expect(lookupFailed).toBe(false);
    expect(Object.keys(members)).toEqual(["c1"]);
    expect(members["c1"]).toHaveLength(2);
    expect(members["c1"]?.[0]?.article.description).toBe("earlier");
    expect(members["c1"]?.[0]?.source.name).toBe("Kaynak s1");
  });

  it("an id with no rows is simply absent and is NOT a lookup failure", async () => {
    fixture.responses = [{ data: [], error: null }];
    await expect(getRssSummaryMembers(["c1"])).resolves.toEqual({
      members: {},
      lookupFailed: false,
    });
  });
});

describe("getRssSummaryMembers cache lifetime and tags", () => {
  it("success calls cacheLife exactly once with cluster-feed and tags clusters-politics", async () => {
    await getRssSummaryMembers(["c1"]);
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
    expect(cacheTag).toHaveBeenCalledWith("clusters-politics");
  });

  it("an empty-but-successful lookup is still cached as cluster-feed (empty is not a failure)", async () => {
    fixture.responses = [{ data: [], error: null }];
    await getRssSummaryMembers(["c1"]);
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
  });

  it("a failed cached attempt is cached for minutes only, and the live retry (outside the cache) heals the request", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.responses = [TIMEOUT_ENVELOPE, { data: OK_ROWS, error: null }];

    const result = await getRssSummaryMembers(["c1", "c2"]);

    expect(fixture.queryCount).toBe(2);
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(result.lookupFailed).toBe(false);
    expect(Object.keys(result.members).sort()).toEqual(["c1", "c2"]);
  });
});

describe("getRssSummaryMembers failure", () => {
  it("reports lookupFailed with empty members when the cached attempt AND the live retry both fail", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.responses = [TIMEOUT_ENVELOPE];

    const result = await getRssSummaryMembers(["c1"]);

    expect(result).toEqual({ members: {}, lookupFailed: true });
    expect(fixture.queryCount).toBe(2);
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("never throws, even when the client cannot be built", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const result = await getRssSummaryMembers(["c1"]);

    expect(result).toEqual({ members: {}, lookupFailed: true });
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });
});
