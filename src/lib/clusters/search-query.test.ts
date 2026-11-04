import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Uses the shared proxy-based Supabase fake (tests/_helpers/supabase-fake.ts).
// search-query.ts now resolves ids via the 083 migration's
// `search_cluster_ids` RPC, then fetches the embed with `.in('id', ids)` —
// no `textSearch` call anywhere in this file any more.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

// Feed-health-gated blindspot suppression (Pack C) — mirrors
// politics-query.test.ts's mock exactly: getZoneFeedHealth() is
// stubbed (its own Supabase round-trip against `sources` is covered by
// feed-health.test.ts) while shouldSuppressBlindspot/degradedSilentZone
// stay REAL via importOriginal, so these are integration tests of the
// suppression wiring inside buildClusterBundle, not just of the mock.
const feedHealth = vi.hoisted(() => ({
  getZoneFeedHealth: vi.fn(async () => null as unknown),
}));

vi.mock("./feed-health", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./feed-health")>();
  return {
    ...actual,
    getZoneFeedHealth: feedHealth.getZoneFeedHealth,
  };
});

// Mutable fixture the `clusters` table resolver reads on every embed query,
// plus the last builder state it saw, and a separate mutable fixture for
// the `search_cluster_ids` RPC.
const fixture = vi.hoisted(() => ({
  data: [] as unknown[],
  error: null as { message: string } | null,
  throwOnQuery: false,
  lastState: null as unknown,
  rpcIds: [] as string[],
  rpcError: null as { message: string; code?: string } | null,
  // Error returned ONLY to the 3-arg call (the one carrying p_folded), so a
  // test can model "migration 129 not applied yet" without failing the
  // 2-arg fallback.
  rpcErrorThreeArg: null as { message: string; code?: string } | null,
  rpcThrows: false,
  rpcCalls: [] as unknown[],
  // While `hold` is true every search_cluster_ids call returns a pending
  // promise that the test settles through its deferred (in-flight cap,
  // single-flight and shed tests).
  hold: false,
  deferreds: [] as Array<{
    args: unknown;
    succeed: () => void;
    fail: (err: Error) => void;
  }>,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      clusters: (state: unknown) => {
        fixture.lastState = state;
        if (fixture.throwOnQuery) throw new Error("connection reset");
        return { data: fixture.error ? null : fixture.data, error: fixture.error };
      },
    },
    rpc: {
      search_cluster_ids: (args: unknown) => {
        fixture.rpcCalls.push(args);
        if (fixture.hold) {
          return new Promise<{ data: unknown; error: null }>((resolve, reject) => {
            fixture.deferreds.push({
              args,
              succeed: () =>
                resolve({
                  data: fixture.rpcIds.map((id) => ({ id })),
                  error: null,
                }),
              fail: (err) => reject(err),
            });
          });
        }
        if (fixture.rpcThrows) throw new Error("rpc connection reset");
        if (fixture.rpcErrorThreeArg && "p_folded" in (args as object)) {
          return { data: null, error: fixture.rpcErrorThreeArg };
        }
        if (fixture.rpcError) return { data: null, error: fixture.rpcError };
        return {
          data: fixture.rpcIds.map((id) => ({ id })),
          error: null,
        };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

import { cacheLife, cacheTag } from "next/cache";
import {
  MAX_IN_FLIGHT_SEARCHES,
  SEARCH_LIMIT,
  searchClusters,
} from "./search-query";
import {
  MAX_SEARCH_QUERY_LENGTH,
  MAX_SEARCH_TERMS,
  canonicalSearchQuery,
  foldTr,
  normaliseSearchQuery,
  turkishQueryVariants,
} from "./turkish-query";
import type { ZoneFeedHealth } from "./feed-health";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";

const ORIGINAL_ENV = { ...process.env };

/** Lets every queued microtask and timer callback run. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.data = [];
  fixture.error = null;
  fixture.throwOnQuery = false;
  fixture.lastState = null;
  fixture.rpcIds = [];
  fixture.rpcError = null;
  fixture.rpcErrorThreeArg = null;
  fixture.rpcThrows = false;
  fixture.rpcCalls = [];
  fixture.hold = false;
  fixture.deferreds = [];
  feedHealth.getZoneFeedHealth.mockReset();
  feedHealth.getZoneFeedHealth.mockResolvedValue(null);
  vi.mocked(cacheLife).mockClear();
  vi.mocked(cacheTag).mockClear();
});

afterEach(async () => {
  // A test that failed half-way must not leave RPCs pending: they would keep
  // their in-flight slots for every later test in this file (module state).
  fixture.hold = false;
  for (const d of fixture.deferreds) d.succeed();
  await tick();
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

// ---------------------------------------------------------------------------
// Fixtures — same embedded row shape as politics-query.test.ts's mkCluster.
// ---------------------------------------------------------------------------

function mkRow(opts: {
  id: string;
  title_tr?: string;
  title_tr_neutral?: string | null;
  category?: string;
  bias_distribution?: unknown;
  is_blindspot?: boolean;
  blindspot_side?: unknown;
  members: Array<{ id: string; sourceId: string; content_hash?: string | null }>;
}) {
  return {
    id: opts.id,
    title_tr: opts.title_tr ?? `Cluster ${opts.id}`,
    title_tr_neutral: opts.title_tr_neutral ?? null,
    summary_tr: "summary",
    bias_distribution: opts.bias_distribution ?? {},
    is_blindspot: opts.is_blindspot ?? false,
    blindspot_side: opts.blindspot_side ?? null,
    article_count: opts.members.length,
    first_published: "2026-04-18T10:00:00.000Z",
    updated_at: "2026-04-18T11:00:00.000Z",
    cluster_articles: opts.members.map((m) => ({
      articles: {
        id: m.id,
        title: `Article ${m.id}`,
        url: `https://example.com/${m.id}`,
        image_url: null,
        published_at: "2026-04-18T10:30:00.000Z",
        source_id: m.sourceId,
        category: opts.category ?? "spor", // non-politika on purpose (see below)
        content_hash: m.content_hash === undefined ? `h-${m.id}` : m.content_hash,
        sources: {
          id: m.sourceId,
          name: `Source ${m.sourceId}`,
          bias: "center",
          logo_url: null,
          kind: null,
        },
      },
    })),
  };
}

// ---------------------------------------------------------------------------
// Query shape
// ---------------------------------------------------------------------------

describe("searchClusters query shape", () => {
  it("SEARCH_LIMIT is 24", () => {
    expect(SEARCH_LIMIT).toBe(24);
  });

  it("calls the RPC with the Turkish-aware variants, the folded query and p_limit", async () => {
    fixture.rpcIds = [];
    await searchClusters("IŞIK");

    expect(fixture.rpcCalls).toEqual([
      {
        p_variants: ["ışık", "işik", "işık"],
        p_folded: "isik",
        p_limit: 24,
      },
    ]);
  });

  it("the RPC args are exactly { p_variants, p_folded: foldTr(normalised), p_limit: 24 }", async () => {
    const q = "Özel'den  Şişli";
    const normalised = normaliseSearchQuery(q);
    expect(normalised).toBe("Özel Şişli");
    await searchClusters(q);

    expect(fixture.rpcCalls).toEqual([
      {
        p_variants: turkishQueryVariants(normalised),
        p_folded: foldTr(normalised),
        p_limit: 24,
      },
    ]);
    expect(Object.keys(fixture.rpcCalls[0] as object).sort()).toEqual([
      "p_folded",
      "p_limit",
      "p_variants",
    ]);
  });

  it("ASCII typing reaches the RPC as the folded Turkish form's key (sisli, cumhurbaskani)", async () => {
    await searchClusters("sisli");
    await searchClusters("Cumhurbaşkanı");
    expect(fixture.rpcCalls).toEqual([
      { p_variants: ["sisli"], p_folded: "sisli", p_limit: 24 },
      {
        p_variants: turkishQueryVariants("Cumhurbaşkanı"),
        p_folded: "cumhurbaskani",
        p_limit: 24,
      },
    ]);
  });

  it("drops an apostrophe suffix before building the variants and the folded query", async () => {
    await searchClusters("Erdoğan’ın");
    expect(fixture.rpcCalls).toEqual([
      { p_variants: ["erdoğan"], p_folded: "erdogan", p_limit: 24 },
    ]);
  });

  it("uses .in('id', ids) for the embed, with no textSearch anywhere", async () => {
    fixture.rpcIds = ["c1"];
    fixture.data = [mkRow({ id: "c1", members: [{ id: "a1", sourceId: "s1" }] })];

    await searchClusters("deprem");

    const state = fixture.lastState as BuilderState;
    expect(state.table).toBe("clusters");
    expect(state.textSearch).toEqual([]);
    expect(state.in).toEqual([{ col: "id", vals: ["c1"] }]);
  });

  it("trims and caps the query before building variants", async () => {
    fixture.rpcIds = [];
    await searchClusters("  seçim  ");
    expect(fixture.rpcCalls[0]).toEqual({
      p_variants: ["seçim"],
      p_folded: "secim",
      p_limit: 24,
    });
  });

  it("caps an over-long query at 64 characters", async () => {
    await searchClusters("a".repeat(500));
    const args = fixture.rpcCalls[0] as { p_folded: string };
    expect(args.p_folded).toHaveLength(MAX_SEARCH_QUERY_LENGTH);
    expect(args.p_folded).toHaveLength(64);
  });

  it("never sends half a surrogate pair when the cap lands inside an emoji", async () => {
    await searchClusters("a".repeat(63) + "\u{1F600}" + "b");
    const args = fixture.rpcCalls[0] as { p_folded: string; p_variants: string[] };
    expect(args.p_folded).toBe("a".repeat(63));
    expect(args.p_variants[0]).toBe("a".repeat(63));
    // An emoji that ends the query is edge punctuation (a symbol) and goes too.
    fixture.rpcCalls = [];
    await searchClusters("a".repeat(63) + "\u{1F600}");
    const tail = fixture.rpcCalls[0] as { p_folded: string; p_variants: string[] };
    expect(tail.p_folded).toBe("a".repeat(63));
    expect(tail.p_variants[0]).toBe("a".repeat(63));
  });
});

// ---------------------------------------------------------------------------
// h30-abuse-1: one cache key and one RPC per case/punctuation family, and the
// query is bounded (6 terms, 64 characters) before the key and the RPC.
// ---------------------------------------------------------------------------

describe("searchClusters canonical key", () => {
  it.each(["Erdoğan", "ERDOĞAN!", " erdoğan ", "erdoğan.", "\u201cErdoğan\u201d", "\u00bfErdoğan?"])(
    "%j sends exactly the RPC args of the lower-case query",
    async (q) => {
      await searchClusters(q);
      expect(fixture.rpcCalls).toEqual([
        {
          p_variants: turkishQueryVariants("erdoğan"),
          p_folded: "erdogan",
          p_limit: 24,
        },
      ]);
    },
  );

  it("the canonical spelling is what reaches the RPC for the other Turkish case pairs", async () => {
    for (const q of ["IŞIK", "Işık", "ışık", "İSTANBUL", "ŞİŞLİ"]) {
      fixture.rpcCalls = [];
      await searchClusters(q);
      expect(fixture.rpcCalls, q).toEqual([
        {
          p_variants: turkishQueryVariants(normaliseSearchQuery(q)),
          p_folded: foldTr(normaliseSearchQuery(q)),
          p_limit: 24,
        },
      ]);
    }
  });

  it("a quoted phrase stays a phrase: the variants keep the quotes, the folded arm keeps them too", async () => {
    await searchClusters('"Devlet Bahçeli"');
    expect(fixture.rpcCalls).toEqual([
      {
        p_variants: turkishQueryVariants('"devlet bahçeli"'),
        p_folded: '"devlet bahceli"',
        p_limit: 24,
      },
    ]);
    const args = fixture.rpcCalls[0] as { p_variants: string[] };
    // Turkish letters survive on the search_tsv arm (the key is not folded).
    expect(args.p_variants.some((v) => v.includes("bahçeli"))).toBe(true);
  });

  it("'ERDOGAN' (ASCII) and 'erdoğan' stay different searches on purpose", async () => {
    await searchClusters("ERDOGAN");
    await searchClusters("erdoğan");
    expect(fixture.rpcCalls).toEqual([
      { p_variants: ["erdogan"], p_folded: "erdogan", p_limit: 24 },
      { p_variants: ["erdoğan"], p_folded: "erdogan", p_limit: 24 },
    ]);
  });

  it("a 500-character query reaches the RPC capped at 64 characters", async () => {
    const q = "abc ".repeat(125);
    expect(q.length).toBeGreaterThanOrEqual(500);
    await searchClusters(q);
    const args = fixture.rpcCalls[0] as { p_folded: string; p_variants: string[] };
    expect(args.p_folded).toBe(foldTr(canonicalSearchQuery(q)));
    expect(args.p_folded.length).toBeLessThanOrEqual(MAX_SEARCH_QUERY_LENGTH);
    expect(args.p_folded.split(" ").length).toBeLessThanOrEqual(MAX_SEARCH_TERMS);
    for (const v of args.p_variants) {
      expect(v.length).toBeLessThanOrEqual(MAX_SEARCH_QUERY_LENGTH);
    }
  });

  it("a 40-term query reaches the RPC with 6 terms", async () => {
    const q = Array.from({ length: 40 }, (_, i) => `Kelime${i}`).join(" ");
    await searchClusters(q);
    const args = fixture.rpcCalls[0] as { p_folded: string; p_variants: string[] };
    expect(args.p_folded).toBe(foldTr(canonicalSearchQuery(q)));
    expect(args.p_folded).toBe("kelime0 kelime1 kelime2 kelime3 kelime4 kelime5");
    expect(args.p_folded.split(" ")).toHaveLength(6);
    for (const v of args.p_variants) expect(v.split(" ")).toHaveLength(6);
  });

  it("a query that is only punctuation is 'too short': ok, no RPC, no cache entry", async () => {
    for (const q of ["!!", "!!!", "\u201c\u201d", "a!", "?a?", "...", "\u{1F600}\u{1F600}"]) {
      await expect(searchClusters(q), q).resolves.toEqual({ ok: true, bundles: [] });
    }
    expect(fixture.rpcCalls).toEqual([]);
    expect(cacheLife).not.toHaveBeenCalled();
    expect(cacheTag).not.toHaveBeenCalled();
  });

  it("still searches a two-character canonical query", async () => {
    await searchClusters("!ab!");
    expect(fixture.rpcCalls).toEqual([
      { p_variants: ["ab"], p_folded: "ab", p_limit: 24 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// In-flight cap + single-flight (per instance). Cache entries are not modelled
// by the vitest build ("use cache" is a no-op there), so every call that is not
// de-duplicated by single-flight reaches the RPC; held RPCs make the overlap
// visible.
// ---------------------------------------------------------------------------

describe("searchClusters in-flight cap", () => {
  const DISTINCT = ["alfa", "beta", "gama", "delta"];

  async function startHeld(queries: string[]) {
    fixture.hold = true;
    const running = queries.map((q) => searchClusters(q));
    await tick();
    return running;
  }

  function settleAll() {
    fixture.hold = false;
    for (const d of fixture.deferreds) d.succeed();
  }

  it("allows 4 concurrent searches", () => {
    expect(MAX_IN_FLIGHT_SEARCHES).toBe(4);
  });

  it("sheds the 5th distinct concurrent search at once, without an RPC", async () => {
    fixture.rpcIds = ["c1"];
    fixture.data = [mkRow({ id: "c1", members: [{ id: "a1", sourceId: "s1" }] })];
    const running = await startHeld(DISTINCT);
    expect(fixture.rpcCalls).toHaveLength(4);
    const tagCalls = vi.mocked(cacheTag).mock.calls.length;

    await expect(searchClusters("epsilon")).resolves.toEqual({ ok: false });
    await expect(searchClusters("zeta")).resolves.toEqual({ ok: false });
    expect(fixture.rpcCalls).toHaveLength(4);
    // The shed never entered the cache boundary, so it can never be memoised.
    expect(vi.mocked(cacheTag).mock.calls).toHaveLength(tagCalls);

    settleAll();
    const results = await Promise.all(running);
    for (const r of results) {
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error("expected ok");
      expect(r.bundles.map((b) => b.cluster.id)).toEqual(["c1"]);
    }
  });

  it("releases the slots after success: the next call runs normally", async () => {
    const running = await startHeld(DISTINCT);
    settleAll();
    await Promise.all(running);

    fixture.rpcCalls = [];
    await expect(searchClusters("epsilon")).resolves.toEqual({
      ok: true,
      bundles: [],
      capped: false,
    });
    expect(fixture.rpcCalls).toHaveLength(1);
  });

  it("releases the slots after a throw: more failing searches than slots are all attempted", async () => {
    fixture.rpcThrows = true;
    const queries = ["alfa", "beta", "gama", "delta", "epsilon", "zeta"];
    for (const q of queries) {
      await expect(searchClusters(q), q).resolves.toEqual({ ok: false });
    }
    // Cached attempt + live retry for each: none of the six was shed.
    expect(fixture.rpcCalls).toHaveLength(queries.length * 2);

    fixture.rpcThrows = false;
    fixture.rpcCalls = [];
    await expect(searchClusters("eta")).resolves.toMatchObject({ ok: true });
    expect(fixture.rpcCalls).toHaveLength(1);
  });

  it("releases the slots after concurrent failures too", async () => {
    const running = await startHeld(DISTINCT);
    fixture.hold = false;
    fixture.rpcIds = [];
    for (const d of fixture.deferreds) d.fail(new Error("rpc connection reset"));
    const results = await Promise.all(running);
    // The failures are answered (retry or not); none leaks a slot.
    for (const r of results) expect(typeof r.ok).toBe("boolean");

    fixture.rpcCalls = [];
    await expect(searchClusters("epsilon")).resolves.toMatchObject({ ok: true });
    expect(fixture.rpcCalls).toHaveLength(1);
  });

  it("a too-short query takes no slot even when the instance is saturated", async () => {
    const running = await startHeld(DISTINCT);
    await expect(searchClusters("!!")).resolves.toEqual({ ok: true, bundles: [] });
    await expect(searchClusters("a")).resolves.toEqual({ ok: true, bundles: [] });
    expect(fixture.rpcCalls).toHaveLength(4);
    settleAll();
    await Promise.all(running);
  });

  it("does not remember a finished search: the same query runs again later", async () => {
    await searchClusters("alfa");
    await searchClusters("alfa");
    expect(fixture.rpcCalls).toHaveLength(2);
  });
});

describe("searchClusters single-flight", () => {
  it("5 concurrent identical canonical queries cause 1 RPC and share one ok result", async () => {
    fixture.rpcIds = ["c1"];
    fixture.data = [mkRow({ id: "c1", members: [{ id: "a1", sourceId: "s1" }] })];
    fixture.hold = true;
    const running = ["erdoğan", "ERDOĞAN!", " erdoğan ", "erdoğan.", "\u201cErdoğan\u201d"].map(
      (q) => searchClusters(q),
    );
    await tick();
    expect(fixture.rpcCalls).toHaveLength(1);

    fixture.hold = false;
    for (const d of fixture.deferreds) d.succeed();
    const results = await Promise.all(running);

    expect(fixture.rpcCalls).toHaveLength(1);
    for (const r of results) {
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error("expected ok");
      expect(r.bundles.map((b) => b.cluster.id)).toEqual(["c1"]);
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[4]).toEqual(results[0]);
  });

  it("an identical query is never refused while the instance is saturated", async () => {
    fixture.hold = true;
    const running = ["alfa", "beta", "gama", "delta"].map((q) => searchClusters(q));
    const twin = searchClusters("ALFA!");
    await tick();
    expect(fixture.rpcCalls).toHaveLength(4);

    fixture.hold = false;
    for (const d of fixture.deferreds) d.succeed();
    await expect(twin).resolves.toEqual({ ok: true, bundles: [], capped: false });
    await Promise.all(running);
    expect(fixture.rpcCalls).toHaveLength(4);
  });

  it("a shared failure is answered to every waiter, and the next call tries afresh", async () => {
    fixture.hold = true;
    const a = searchClusters("alfa");
    const b = searchClusters("ALFA");
    await tick();
    expect(fixture.rpcCalls).toHaveLength(1);

    // Let the retry run normally and fail too.
    fixture.hold = false;
    fixture.rpcThrows = true;
    fixture.deferreds[0]!.fail(new Error("rpc connection reset"));
    await expect(a).resolves.toEqual({ ok: false });
    await expect(b).resolves.toEqual({ ok: false });
    // One held attempt + one live retry, shared by both waiters.
    expect(fixture.rpcCalls).toHaveLength(2);

    fixture.rpcThrows = false;
    fixture.rpcCalls = [];
    await expect(searchClusters("alfa")).resolves.toMatchObject({ ok: true });
    expect(fixture.rpcCalls).toHaveLength(1);
  });
});

describe("searchClusters live retry under load", () => {
  it("control: a lone failing search still does the live retry (2 RPC calls)", async () => {
    fixture.rpcThrows = true;
    await expect(searchClusters("alfa")).resolves.toEqual({ ok: false });
    expect(fixture.rpcCalls).toHaveLength(2);
  });

  it("skips the retry while saturated: A fails with ONE RPC, B/C/D unaffected", async () => {
    fixture.hold = true;
    const a = searchClusters("alfa");
    const others = ["beta", "gama", "delta"].map((q) => searchClusters(q));
    await tick();
    expect(fixture.rpcCalls).toHaveLength(4);

    fixture.deferreds[0]!.fail(new Error("rpc connection reset"));
    await expect(a).resolves.toEqual({ ok: false });

    const forA = (fixture.rpcCalls as Array<{ p_folded?: string }>).filter(
      (c) => c.p_folded === "alfa",
    );
    expect(forA).toHaveLength(1);
    expect(fixture.rpcCalls).toHaveLength(4);

    fixture.hold = false;
    for (const d of fixture.deferreds) d.succeed();
    for (const r of await Promise.all(others)) expect(r.ok).toBe(true);
  });

  it("retries again once a slot is free (3 in flight + the failing one is below the cap)", async () => {
    fixture.hold = true;
    const a = searchClusters("alfa");
    const others = ["beta", "gama"].map((q) => searchClusters(q));
    await tick();
    expect(fixture.rpcCalls).toHaveLength(3);

    // Only 3 searches are in flight, so A's retry is allowed; let it succeed.
    fixture.hold = false;
    fixture.deferreds[0]!.fail(new Error("rpc connection reset"));
    await expect(a).resolves.toEqual({ ok: true, bundles: [], capped: false });
    expect(fixture.rpcCalls).toHaveLength(4);

    for (const d of fixture.deferreds) d.succeed();
    await Promise.all(others);
  });
});

describe("searchClusters logging", () => {
  const SECRET = "zzgizliarama";

  it("never writes the query to the console, shed and failure paths included", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      // Failure path: cached attempt + live retry both fail.
      fixture.rpcThrows = true;
      await searchClusters(`${SECRET} ${SECRET.toUpperCase()}`);
      fixture.rpcThrows = false;

      // Shed path: saturate the instance and ask for one more.
      fixture.hold = true;
      const running = ["alfa", "beta", "gama", "delta"].map((q) => searchClusters(q));
      await tick();
      await searchClusters(SECRET);
      // Retry-skipped path.
      fixture.deferreds[0]!.fail(new Error("rpc connection reset"));
      await running[0];
      fixture.hold = false;
      for (const d of fixture.deferreds) d.succeed();
      await Promise.all(running);

      const all = [warn, error, log, info].flatMap((spy) => spy.mock.calls);
      expect(all.length).toBeGreaterThan(0);
      const text = JSON.stringify(all).toLowerCase();
      expect(text).not.toContain(SECRET);
      const warned = warn.mock.calls.map((c) => String(c[0]));
      expect(warned).toContain("[clusters] search-query shed: saturated");
      expect(warned).toContain("[clusters] search-query retry skipped: saturated");
    } finally {
      for (const spy of [warn, error, log, info]) spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Control characters never reach Postgres (a NUL makes the whole RPC fail,
// which used to surface as a false "zaman aşımı").
// ---------------------------------------------------------------------------

describe("searchClusters control characters", () => {
  it("'a\u0000b' is searched as 'a b' and returns ok", async () => {
    fixture.rpcIds = [];
    const result = await searchClusters("a\u0000b");
    expect(result).toEqual({ ok: true, bundles: [], capped: false });
    expect(fixture.rpcCalls).toEqual([
      {
        p_variants: turkishQueryVariants("a b"),
        p_folded: "a b",
        p_limit: 24,
      },
    ]);
  });

  it("no RPC argument ever contains a C0/C1 control character", async () => {
    await searchClusters("x\u0000y\u0008z\u0085w\u007f");
    const serialised = JSON.stringify(fixture.rpcCalls);
    expect(serialised).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(serialised).not.toMatch(/\\u00(0|1|7f|8|9)/i);
  });

  it("a query of control characters only is 'too short': ok, no bundles, no RPC call", async () => {
    const result = await searchClusters("\u0000\u0000");
    expect(result).toEqual({ ok: true, bundles: [] });
    expect(fixture.rpcCalls).toEqual([]);
    expect(fixture.lastState).toBeNull();
    expect(cacheLife).not.toHaveBeenCalled();
  });

  it("a control-only query never becomes { ok: false }, even when the RPC would fail", async () => {
    fixture.rpcError = { message: "invalid byte sequence" };
    await expect(searchClusters("\u0000\u0001")).resolves.toEqual({
      ok: true,
      bundles: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Deploy order: the app may ship before migration 129. PostgREST answers
// PGRST202 (function not in the schema cache) for the 3-arg call; the app
// then falls back ONCE to the 083 two-arg function.
// ---------------------------------------------------------------------------

describe("searchClusters 2-arg fallback (PGRST202)", () => {
  it("falls back to exactly one 2-arg call and uses its ids", async () => {
    fixture.rpcErrorThreeArg = {
      message: "Could not find the function public.search_cluster_ids",
      code: "PGRST202",
    };
    fixture.rpcIds = ["c1"];
    fixture.data = [mkRow({ id: "c1", members: [{ id: "a1", sourceId: "s1" }] })];

    const result = await searchClusters("deprem");

    expect(fixture.rpcCalls).toEqual([
      { p_variants: ["deprem"], p_folded: "deprem", p_limit: 24 },
      { p_variants: ["deprem"], p_limit: 24 },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.bundles.map((b) => b.cluster.id)).toEqual(["c1"]);
  });

  it("does not call a third time when the fallback succeeds with no rows", async () => {
    fixture.rpcErrorThreeArg = { message: "missing", code: "PGRST202" };
    fixture.rpcIds = [];
    await expect(searchClusters("deprem")).resolves.toEqual({
      ok: true,
      bundles: [],
      capped: false,
    });
    expect(fixture.rpcCalls).toHaveLength(2);
  });

  it("falls back only once: a PGRST202 on the 2-arg call too is { ok: false }", async () => {
    fixture.rpcError = { message: "missing", code: "PGRST202" };
    await expect(searchClusters("deprem")).resolves.toEqual({ ok: false });
    // cached attempt (3-arg + 2-arg) and the live retry (3-arg + 2-arg).
    expect(fixture.rpcCalls).toHaveLength(4);
  });

  it("any other error code stays { ok: false } with no 2-arg fallback", async () => {
    fixture.rpcErrorThreeArg = { message: "statement timeout", code: "57014" };
    await expect(searchClusters("deprem")).resolves.toEqual({ ok: false });
    for (const call of fixture.rpcCalls) {
      expect(call).toHaveProperty("p_folded");
    }
  });

  it("an error without a code stays { ok: false } with no fallback", async () => {
    fixture.rpcErrorThreeArg = { message: "db down" };
    await expect(searchClusters("deprem")).resolves.toEqual({ ok: false });
    for (const call of fixture.rpcCalls) {
      expect(call).toHaveProperty("p_folded");
    }
  });
});

// ---------------------------------------------------------------------------
// `capped`: the RPC filled its page, so there may be more archive matches.
// ---------------------------------------------------------------------------

describe("searchClusters capped flag", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `c${i}`);

  it("is true when the RPC returns exactly SEARCH_LIMIT (24) ids", async () => {
    fixture.rpcIds = ids(24);
    const result = await searchClusters("deprem");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.capped).toBe(true);
  });

  it("is false for fewer ids", async () => {
    fixture.rpcIds = ids(23);
    const result = await searchClusters("deprem");
    if (!result.ok) throw new Error("expected ok");
    expect(result.capped).toBe(false);
  });

  it("is false for an empty result", async () => {
    fixture.rpcIds = [];
    const result = await searchClusters("deprem");
    if (!result.ok) throw new Error("expected ok");
    expect(result.capped).toBe(false);
  });

  it("is reported from the 2-arg fallback too", async () => {
    fixture.rpcErrorThreeArg = { message: "missing", code: "PGRST202" };
    fixture.rpcIds = ids(24);
    const result = await searchClusters("deprem");
    if (!result.ok) throw new Error("expected ok");
    expect(result.capped).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Short-query guard
// ---------------------------------------------------------------------------

describe("short query guard", () => {
  it("returns { ok: true, bundles: [] } without any Supabase call for a 0-character query", async () => {
    const result = await searchClusters("");
    expect(result).toEqual({ ok: true, bundles: [] });
    expect(fixture.rpcCalls).toEqual([]);
    expect(fixture.lastState).toBeNull();
  });

  it("returns { ok: true, bundles: [] } for a 1-character (post-trim) query", async () => {
    const result = await searchClusters("  a  ");
    expect(result).toEqual({ ok: true, bundles: [] });
    expect(fixture.rpcCalls).toEqual([]);
  });

  it("calls the RPC once the trimmed length reaches 2 characters", async () => {
    fixture.rpcIds = [];
    const result = await searchClusters(" ab ");
    expect(result).toEqual({ ok: true, bundles: [], capped: false });
    expect(fixture.rpcCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Error handling — never throws, always { ok: false } on failure.
// ---------------------------------------------------------------------------

describe("searchClusters error handling", () => {
  it("returns { ok: false } when the rpc errors", async () => {
    fixture.rpcError = { message: "db down" };
    await expect(searchClusters("merhaba")).resolves.toEqual({ ok: false });
  });

  it("returns { ok: false } when the rpc itself throws", async () => {
    fixture.rpcThrows = true;
    await expect(searchClusters("merhaba")).resolves.toEqual({ ok: false });
  });

  it("returns { ok: false } when the embed select errors", async () => {
    fixture.rpcIds = ["c1"];
    fixture.error = { message: "embed down" };
    await expect(searchClusters("merhaba")).resolves.toEqual({ ok: false });
  });

  it("returns { ok: true, bundles: [] } when the rpc result is empty, with no clusters query", async () => {
    fixture.rpcIds = [];
    const result = await searchClusters("hiçbirşey");
    expect(result).toEqual({ ok: true, bundles: [], capped: false });
    expect(fixture.lastState).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cache lifetime follows the outcome. cacheLife must be called AFTER the
// attempt: calling it first pinned a failed attempt's { ok: false } for the
// whole `cluster-feed` window, so every later hit skipped the cache's
// answer and went live to the DB (the cold-read load amplifier that /takip
// would have made worse). A failure is memoised for `minutes` only, and
// exactly one cacheLife call happens per cached invocation.
// ---------------------------------------------------------------------------

describe("searchClusters cache lifetime", () => {
  it("keeps the cluster-feed window for a successful read", async () => {
    fixture.rpcIds = [];
    await searchClusters("merhaba");

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
    expect(cacheTag).toHaveBeenCalledWith("clusters-search");
  });

  it("keeps the cluster-feed window for a successful read with results", async () => {
    fixture.rpcIds = ["c1"];
    fixture.data = [mkRow({ id: "c1", members: [{ id: "a1", sourceId: "s1" }] })];
    await searchClusters("deprem");

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
  });

  it("caches a failing RPC for 'minutes', never for 'cluster-feed'", async () => {
    fixture.rpcError = { message: "db down" };
    await expect(searchClusters("merhaba")).resolves.toEqual({ ok: false });

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("cluster-feed");
    // The tag is still registered so a revalidate can evict the entry.
    expect(cacheTag).toHaveBeenCalledWith("clusters-search");
  });

  it("caches a throwing RPC for 'minutes'", async () => {
    fixture.rpcThrows = true;
    await expect(searchClusters("merhaba")).resolves.toEqual({ ok: false });

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("cluster-feed");
  });

  it("caches a failing embed select for 'minutes'", async () => {
    fixture.rpcIds = ["c1"];
    fixture.error = { message: "embed down" };
    await expect(searchClusters("merhaba")).resolves.toEqual({ ok: false });

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("cluster-feed");
  });

  it("does not enter the cached function at all for a too-short query", async () => {
    await searchClusters("a");
    expect(cacheLife).not.toHaveBeenCalled();
    expect(cacheTag).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Row -> bundle assembly (reuses politics-query's buildClusterBundle)
// ---------------------------------------------------------------------------

describe("row assembly", () => {
  it("builds a ClusterBundle per row, deduping same-source members", async () => {
    fixture.rpcIds = ["c1"];
    fixture.data = [
      mkRow({
        id: "c1",
        title_tr: "original",
        title_tr_neutral: "neutral version",
        members: [
          { id: "a1", sourceId: "s1" },
          { id: "a2", sourceId: "s1" }, // duplicate source
          { id: "a3", sourceId: "s2" },
        ],
      }),
    ];
    const result = await searchClusters("deprem");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.bundles).toHaveLength(1);
    const b = result.bundles[0]!;
    expect(b.cluster.id).toBe("c1");
    // H2 neutral-headline coalesce reused from politics-query.
    expect(b.cluster.title_tr).toBe("neutral version");
    // Same-source dedupe: s1 contributes once.
    expect(b.articles).toHaveLength(2);
    expect(b.sources.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
  });

  it("follows the RPC's id order even when the embed returns rows shuffled", async () => {
    fixture.rpcIds = ["c2", "c1", "c3"];
    fixture.data = [
      mkRow({ id: "c1", members: [{ id: "a1", sourceId: "s1" }] }),
      mkRow({ id: "c3", members: [{ id: "a3", sourceId: "s3" }] }),
      mkRow({ id: "c2", members: [{ id: "a2", sourceId: "s2" }] }),
    ];
    const result = await searchClusters("deprem");
    if (!result.ok) throw new Error("expected ok");
    expect(result.bundles.map((b) => b.cluster.id)).toEqual(["c2", "c1", "c3"]);
  });

  it("does NOT apply the politics-majority category gate (unlike getPoliticsClusters)", async () => {
    fixture.rpcIds = ["sports-cluster"];
    fixture.data = [
      mkRow({
        id: "sports-cluster",
        category: "spor",
        members: [
          { id: "a1", sourceId: "s1" },
          { id: "a2", sourceId: "s2" },
        ],
      }),
    ];
    const result = await searchClusters("galatasaray");
    if (!result.ok) throw new Error("expected ok");
    expect(result.bundles).toHaveLength(1);
    expect(result.bundles[0]?.cluster.id).toBe("sports-cluster");
  });

  it("drops a row whose every embedded article join is null", async () => {
    fixture.rpcIds = ["empty"];
    fixture.data = [
      {
        id: "empty",
        title_tr: "Empty",
        title_tr_neutral: null,
        summary_tr: "",
        bias_distribution: {},
        is_blindspot: false,
        blindspot_side: null,
        article_count: 1,
        first_published: "2026-04-18T10:00:00.000Z",
        updated_at: "2026-04-18T10:00:00.000Z",
        cluster_articles: [{ articles: null }],
      },
    ];
    const result = await searchClusters("boş");
    if (!result.ok) throw new Error("expected ok");
    expect(result.bundles).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Feed-health-gated blindspot suppression (Pack C) — search results thread
// the same `health` the home feed uses through buildClusterBundle.
// ---------------------------------------------------------------------------

describe("feed-health gated blindspot suppression (search results)", () => {
  function mkHealth(overrides: {
    iktidar?: boolean;
    bagimsiz?: boolean;
    muhalefet?: boolean;
  }): ZoneFeedHealth {
    const healthy = { total: 10, healthy: 10, healthyShare: 1, degraded: false };
    const degraded = { total: 10, healthy: 2, healthyShare: 0.2, degraded: true };
    return {
      iktidar: overrides.iktidar ? degraded : healthy,
      bagimsiz: overrides.bagimsiz ? degraded : healthy,
      muhalefet: overrides.muhalefet ? degraded : healthy,
    };
  }

  it("withdraws is_blindspot/blindspot_side when the silent pole zone is degraded", async () => {
    feedHealth.getZoneFeedHealth.mockResolvedValue(mkHealth({ muhalefet: true }));
    fixture.rpcIds = ["suppressed"];
    fixture.data = [
      mkRow({
        id: "suppressed",
        is_blindspot: true,
        blindspot_side: "pro_government",
        bias_distribution: { pro_government: 9, opposition: 1 },
        members: [
          { id: "a1", sourceId: "s1" },
          { id: "a2", sourceId: "s2" },
        ],
      }),
    ];
    const result = await searchClusters("deprem");
    if (!result.ok) throw new Error("expected ok");
    expect(result.bundles).toHaveLength(1);
    expect(result.bundles[0]?.cluster.is_blindspot).toBe(false);
    expect(result.bundles[0]?.cluster.blindspot_side).toBeNull();
  });

  it("leaves is_blindspot/blindspot_side untouched when feed health is unknown (null passthrough)", async () => {
    feedHealth.getZoneFeedHealth.mockResolvedValue(null);
    fixture.rpcIds = ["unaffected-unknown-health"];
    fixture.data = [
      mkRow({
        id: "unaffected-unknown-health",
        is_blindspot: true,
        blindspot_side: "pro_government",
        bias_distribution: { pro_government: 9, opposition: 1 },
        members: [
          { id: "a1", sourceId: "s1" },
          { id: "a2", sourceId: "s2" },
        ],
      }),
    ];
    const result = await searchClusters("deprem");
    if (!result.ok) throw new Error("expected ok");
    expect(result.bundles).toHaveLength(1);
    expect(result.bundles[0]?.cluster.is_blindspot).toBe(true);
    expect(result.bundles[0]?.cluster.blindspot_side).toBe("pro_government");
  });
});
