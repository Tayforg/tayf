import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Uses the shared proxy-based Supabase fake (tests/_helpers/supabase-fake.ts),
// mirroring src/lib/clusters/search-query.test.ts's next/cache mock + fixture
// shape.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const fixture = vi.hoisted(() => ({
  data: [] as unknown[],
  error: null as { message: string } | null,
  throwOnQuery: false,
  lastState: null as unknown,
  clientBuilds: 0,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      cluster_fact_checks: (state: unknown) => {
        fixture.lastState = state;
        if (fixture.throwOnQuery) throw new Error("connection reset");
        return { data: fixture.error ? null : fixture.data, error: fixture.error };
      },
    },
  });
});

// Every `createClient(url, key, options)` call, so a test can prove the read
// goes through createSlowReaderClient() (9 s cap, no postgrest-js retry).
const clientArgs = vi.hoisted(() => [] as unknown[][]);

vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => {
    fixture.clientBuilds += 1;
    clientArgs.push(args);
    return supabaseFake.client;
  },
}));

import { cacheLife, cacheTag } from "next/cache";
import { getClusterFactChecks } from "./cluster-fact-checks-query";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";

const ORIGINAL_ENV = { ...process.env };

/**
 * Asserts a captured `createClient(url, key, options)` call came from
 * `createSlowReaderClient()`: postgrest-js retries off and a fetch wrapper
 * that caps every request at READER_SLOW_TIMEOUT_MS (9 s).
 */
async function expectSlowReaderBuild(args: unknown[]): Promise<void> {
  const opts = args[2] as
    | { db?: { retry?: boolean }; global?: { fetch?: typeof fetch } }
    | undefined;
  expect(opts?.db?.retry).toBe(false);
  expect(typeof opts?.global?.fetch).toBe("function");

  const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
  vi.stubGlobal("fetch", async () => new Response("[]"));
  try {
    await opts!.global!.fetch!("https://example.supabase.co/rest/v1/t");
    expect(timeoutSpy).toHaveBeenCalledWith(9000);
  } finally {
    vi.unstubAllGlobals();
    timeoutSpy.mockRestore();
  }
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  delete process.env.FACT_CHECK_BOX;
  fixture.data = [];
  clientArgs.length = 0;
  fixture.error = null;
  fixture.throwOnQuery = false;
  fixture.lastState = null;
  fixture.clientBuilds = 0;
  vi.mocked(cacheLife).mockClear();
  vi.mocked(cacheTag).mockClear();
  // A failed read logs once from attemptCached (console.error) and once from
  // the wrapper (console.warn); keep the output clean.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.mocked(console.error).mockRestore();
  vi.mocked(console.warn).mockRestore();
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "FACT_CHECK_BOX"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

const OBJECT_ROW = {
  score: 0.7,
  fact_checks: {
    id: "fc-1",
    publisher: "teyit",
    url: "https://teyit.org/analiz/x",
    title: "Bir iddianın analizi",
    published_at: "2026-09-27T10:00:00Z",
    is_published: true,
  },
};

const ARRAY_ROW = {
  score: 0.65,
  fact_checks: [
    {
      id: "fc-2",
      publisher: "malumatfurus",
      url: "https://www.malumatfurus.org/bir-yazi/",
      title: "Başka bir analiz",
      published_at: "2026-09-26T10:00:00Z",
      is_published: true,
    },
  ],
};

describe("getClusterFactChecks", () => {
  it("records eq(is_published,true) on both sides and limit(6) (3 are kept after filtering)", async () => {
    fixture.data = [OBJECT_ROW];
    await getClusterFactChecks("c1");
    const state = fixture.lastState as BuilderState;
    expect(state.eq).toEqual(
      expect.arrayContaining([
        { col: "cluster_id", val: "c1" },
        { col: "is_published", val: true },
        { col: "fact_checks.is_published", val: true },
      ]),
    );
    expect(state.limit).toBe(6);
  });

  it("maps the object embed shape", async () => {
    fixture.data = [OBJECT_ROW];
    const result = await getClusterFactChecks("c1");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "fc-1",
      publisher: "teyit",
      publisherLabel: "Teyit",
      url: "https://teyit.org/analiz/x",
      title: "Bir iddianın analizi",
      score: 0.7,
    });
    expect(result[0]!.dateLabel).toMatch(/2026/);
  });

  it("maps the array embed shape", async () => {
    fixture.data = [ARRAY_ROW];
    const result = await getClusterFactChecks("c1");
    expect(result).toHaveLength(1);
    expect(result[0]!.publisher).toBe("malumatfurus");
  });

  it("drops a disallowed url at read time (defence in depth)", async () => {
    fixture.data = [
      {
        score: 0.8,
        fact_checks: {
          id: "fc-bad",
          publisher: "teyit",
          url: "https://evil.example.com/x",
          title: "Kötü url",
          published_at: "2026-09-27T10:00:00Z",
          is_published: true,
        },
      },
    ];
    const result = await getClusterFactChecks("c1");
    expect(result).toHaveLength(0);
  });

  it("throws inside the cached fn on error, while the wrapper returns []", async () => {
    fixture.error = { message: "relation \"cluster_fact_checks\" does not exist" };
    const result = await getClusterFactChecks("c1");
    expect(result).toEqual([]);
  });

  it("swallows an unexpected throw (e.g. connection reset) to []", async () => {
    fixture.throwOnQuery = true;
    const result = await getClusterFactChecks("c1");
    expect(result).toEqual([]);
  });

  it("FACT_CHECK_BOX=off returns [] with no from() call", async () => {
    process.env.FACT_CHECK_BOX = "off";
    fixture.data = [OBJECT_ROW];
    fixture.lastState = null;
    const result = await getClusterFactChecks("c1");
    expect(result).toEqual([]);
    expect(fixture.lastState).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// h206-story-1: legacy keyword-v1 auto links the v2 name-span rule rejects are
// hidden at read time (the cron never demotes a published row, and nothing is
// written). Titles and matched_terms are the real audited rows
// (docs/fact-checks.md, post-launch precision audit).
// ---------------------------------------------------------------------------

const FIDAN_FACT_CHECK = {
  id: "fc-fidan",
  publisher: "teyit",
  url: "https://teyit.org/analiz/hakan-fidan-almanca",
  title: "Hakan Fidan'ın Almanca konuştuğu video gerçek mi?",
  published_at: "2026-10-13T10:00:00Z",
  is_published: true,
};

const FIDAN_MATCHED = ["hakan", "fidan", "konus"];

const NASA_FACT_CHECK = {
  id: "fc-nasa",
  publisher: "teyit",
  url: "https://teyit.org/analiz/nasa-deniz-burnham",
  title: "NASA astronotu Deniz Burnham’ın Türkçe konuştuğu video gerçek",
  published_at: "2026-10-09T10:00:00Z",
  is_published: true,
};

function linkRow(
  fc: typeof FIDAN_FACT_CHECK,
  over: { score?: number; method?: string; decided_by?: string; matched_terms?: string[] | null },
) {
  return {
    score: over.score ?? 0.667,
    method: over.method ?? "keyword-v1",
    decided_by: over.decided_by ?? "auto",
    matched_terms: over.matched_terms === undefined ? FIDAN_MATCHED : over.matched_terms,
    fact_checks: fc,
  };
}

describe("getClusterFactChecks hides rejected legacy links (h206-story-1)", () => {
  it("selects method, decided_by and matched_terms next to the embed", async () => {
    fixture.data = [OBJECT_ROW];
    await getClusterFactChecks("c1");
    const state = fixture.lastState as BuilderState;
    const select = String(state.selectArgs[0]);
    expect(select).toContain("method");
    expect(select).toContain("decided_by");
    expect(select).toContain("matched_terms");
    expect(select).toContain("score");
    expect(select).toContain("fact_checks!inner ( id, publisher, url, title, published_at, is_published )");
  });

  it("drops a keyword-v1 / auto Fidan row (name + one claim verb is one distinct term)", async () => {
    fixture.data = [linkRow(FIDAN_FACT_CHECK, {})];
    await expect(getClusterFactChecks("c1")).resolves.toEqual([]);
  });

  it("keeps the same row when decided_by = 'admin' (an operator's decision is never overridden)", async () => {
    fixture.data = [linkRow(FIDAN_FACT_CHECK, { decided_by: "admin" })];
    const result = await getClusterFactChecks("c1");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "fc-fidan", publisher: "teyit", score: 0.667 });
  });

  it("keeps the same terms on a keyword-v2 / auto row (v2 already gated it at write time)", async () => {
    fixture.data = [linkRow(FIDAN_FACT_CHECK, { method: "keyword-v2" })];
    const result = await getClusterFactChecks("c1");
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("fc-fidan");
  });

  it("keeps an on-topic keyword-v1 / auto row (NASA / Deniz Burnham)", async () => {
    fixture.data = [
      linkRow(NASA_FACT_CHECK, {
        score: 0.7,
        matched_terms: ["nasa", "astro", "deniz", "burnh"],
      }),
    ];
    const result = await getClusterFactChecks("c1");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "fc-nasa", score: 0.7 });
  });

  it("drops a keyword-v1 / auto row whose matched_terms is null or empty", async () => {
    fixture.data = [
      linkRow(NASA_FACT_CHECK, { matched_terms: null }),
      linkRow(NASA_FACT_CHECK, { matched_terms: [] }),
    ];
    await expect(getClusterFactChecks("c1")).resolves.toEqual([]);
  });

  it("keeps a keyword-v1 / admin or keyword-v2 row even with no matched_terms", async () => {
    fixture.data = [
      linkRow(NASA_FACT_CHECK, { decided_by: "admin", matched_terms: [] }),
      linkRow(FIDAN_FACT_CHECK, { method: "keyword-v2", matched_terms: null }),
    ];
    const result = await getClusterFactChecks("c1");
    expect(result.map((r) => r.id)).toEqual(["fc-nasa", "fc-fidan"]);
  });

  it("evaluates the rule on an array-shaped embed too", async () => {
    fixture.data = [
      {
        score: 0.667,
        method: "keyword-v1",
        decided_by: "auto",
        matched_terms: FIDAN_MATCHED,
        fact_checks: [FIDAN_FACT_CHECK],
      },
    ];
    await expect(getClusterFactChecks("c1")).resolves.toEqual([]);
  });

  it("four rows with one dropped yield the other three, in the stored score order", async () => {
    fixture.data = [
      linkRow(NASA_FACT_CHECK, { score: 0.9, matched_terms: ["nasa", "astro", "deniz", "burnh"] }),
      linkRow(FIDAN_FACT_CHECK, { score: 0.8 }),
      { ...OBJECT_ROW, score: 0.7, method: "keyword-v2", decided_by: "auto", matched_terms: ["a", "b", "c"] },
      { ...ARRAY_ROW, score: 0.65, method: "keyword-v1", decided_by: "admin", matched_terms: [] },
    ];
    const result = await getClusterFactChecks("c1");
    expect(result.map((r) => r.id)).toEqual(["fc-nasa", "fc-1", "fc-2"]);
    expect(result).toHaveLength(3);
  });

  it("dropped legacy rows cannot starve the box: 6 rows, 3 dropped, 3 kept", async () => {
    fixture.data = [
      linkRow(FIDAN_FACT_CHECK, { score: 0.9 }),
      linkRow(FIDAN_FACT_CHECK, { score: 0.85 }),
      linkRow(FIDAN_FACT_CHECK, { score: 0.8 }),
      linkRow(NASA_FACT_CHECK, { score: 0.7, matched_terms: ["nasa", "astro", "deniz", "burnh"] }),
      { ...OBJECT_ROW, score: 0.65, method: "keyword-v2", decided_by: "auto", matched_terms: ["a", "b", "c"] },
      { ...ARRAY_ROW, score: 0.6, method: "keyword-v2", decided_by: "auto", matched_terms: ["a", "b", "c"] },
    ];
    const result = await getClusterFactChecks("c1");
    expect(result.map((r) => r.id)).toEqual(["fc-nasa", "fc-1", "fc-2"]);
  });

  it("never returns more than 3 even when the wider limit(6) read returns 6 passing rows", async () => {
    fixture.data = Array.from({ length: 6 }, (_, i) => ({
      ...OBJECT_ROW,
      score: 0.9 - i * 0.05,
      method: "keyword-v2",
      decided_by: "auto",
      matched_terms: ["a", "b", "c"],
      fact_checks: { ...OBJECT_ROW.fact_checks, id: `fc-${i}` },
    }));
    const result = await getClusterFactChecks("c1");
    expect(result.map((r) => r.id)).toEqual(["fc-0", "fc-1", "fc-2"]);
  });

  it("FACT_CHECK_BOX=off still returns [] with no query (kill switch unchanged)", async () => {
    process.env.FACT_CHECK_BOX = "off";
    fixture.data = [linkRow(NASA_FACT_CHECK, { decided_by: "admin" })];
    fixture.lastState = null;
    await expect(getClusterFactChecks("c1")).resolves.toEqual([]);
    expect(fixture.lastState).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// cached-failure-sweep: cacheLife follows the outcome. An empty list from a
// SUCCESSFUL query (the overwhelming majority of clusters) is legitimately
// cached for the full 'cluster-feed' window; a failed read resolves [] and is
// memoised for 'minutes' only, so a one-off blip (or a deploy that shipped
// before migration 080) cannot hide the box for the whole window.
// ---------------------------------------------------------------------------

describe("getClusterFactChecks cache lifetime", () => {
  it("flag off: [] with zero queries, no client, and no cache entry at all", async () => {
    process.env.FACT_CHECK_BOX = "off";
    fixture.data = [OBJECT_ROW];

    await expect(getClusterFactChecks("c1")).resolves.toEqual([]);

    expect(fixture.lastState).toBeNull();
    expect(fixture.clientBuilds).toBe(0);
    expect(cacheLife).not.toHaveBeenCalled();
    expect(cacheTag).not.toHaveBeenCalled();
  });

  it("success with rows: cached for 'cluster-feed', tagged before the lifetime", async () => {
    fixture.data = [OBJECT_ROW];

    const result = await getClusterFactChecks("c1");

    expect(result).toHaveLength(1);
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
    expect(cacheTag).toHaveBeenCalledWith("fact-checks", "fact-checks:c1");
    expect(vi.mocked(cacheTag).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(cacheLife).mock.invocationCallOrder[0]!,
    );
  });

  it("success with an empty list is still a success: 'cluster-feed', not 'minutes'", async () => {
    fixture.data = [];

    await expect(getClusterFactChecks("c1")).resolves.toEqual([]);

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
  });

  it("a rows-all-dropped read (disallowed url) is also a success", async () => {
    fixture.data = [
      {
        score: 0.8,
        fact_checks: {
          id: "fc-bad",
          publisher: "teyit",
          url: "https://evil.example.com/x",
          title: "Kötü url",
          published_at: "2026-09-27T10:00:00Z",
          is_published: true,
        },
      },
    ];

    await expect(getClusterFactChecks("c1")).resolves.toEqual([]);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
  });

  it("a Supabase error resolves [] and is cached for 'minutes' only", async () => {
    fixture.error = { message: 'relation "cluster_fact_checks" does not exist' };

    await expect(getClusterFactChecks("c1")).resolves.toEqual([]);

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("cluster-feed");
  });

  it("a thrown query (connection reset) resolves [] and is cached for 'minutes' only", async () => {
    fixture.throwOnQuery = true;

    await expect(getClusterFactChecks("c1")).resolves.toEqual([]);

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("a failed read keeps the warn log, so an outage is visible", async () => {
    fixture.error = { message: "boom" };

    await getClusterFactChecks("c1");

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("[fact-checks] cluster-fact-checks-query failed:"),
      expect.anything(),
    );
  });

  it("does not retry live: the null contract has no second read", async () => {
    fixture.error = { message: "boom" };

    await getClusterFactChecks("c1");

    expect(fixture.clientBuilds).toBe(1);
  });
});

describe("getClusterFactChecks is bounded (hunt-27 resilience-1)", () => {
  it("builds its client with the slow-reader cap and no retry", async () => {
    await getClusterFactChecks("11111111-1111-4111-8111-111111111111");
    expect(clientArgs.length).toBeGreaterThan(0);
    for (const args of clientArgs) await expectSlowReaderBuild(args);
  });
});
