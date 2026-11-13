import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
  // When set, the Nth search_cluster_ids call (0-based, in call order, a PGRST202
  // fallback call counts) returns the Nth list; a missing entry is an empty result.
  // null: every call returns `rpcIds`.
  rpcIdsPerCall: null as string[][] | null,
  // An error returned ONLY to the calls whose 0-based index is listed (the sibling call).
  rpcErrorAtCalls: null as { indexes: number[]; error: { message: string; code?: string } } | null,
  rpcError: null as { message: string; code?: string } | null,
  // Error returned ONLY to the 3-arg call (the one carrying p_folded), so a
  // test can model "migration 129 not applied yet" without failing the
  // 2-arg fallback.
  rpcErrorThreeArg: null as { message: string; code?: string } | null,
  rpcThrows: false,
  rpcCalls: [] as unknown[],
  // h170-roadmap-1: the later archive pages call search_cluster_ids_v2 (migration 211). Its calls are
  // recorded apart from `rpcCalls`, so every existing assertion on the page-1 function stays as it was.
  v2Calls: [] as unknown[],
  v2Ids: [] as string[],
  v2Error: null as { message: string; code?: string } | null,
  v2Throws: false,
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
        if (fixture.rpcErrorAtCalls?.indexes.includes(fixture.rpcCalls.length - 1)) {
          return { data: null, error: fixture.rpcErrorAtCalls.error };
        }
        const ids = fixture.rpcIdsPerCall
          ? (fixture.rpcIdsPerCall[fixture.rpcCalls.length - 1] ?? [])
          : fixture.rpcIds;
        return {
          data: ids.map((id) => ({ id })),
          error: null,
        };
      },
      search_cluster_ids_v2: (args: unknown) => {
        fixture.v2Calls.push(args);
        if (fixture.hold) {
          return new Promise<{ data: unknown; error: null }>((resolve, reject) => {
            fixture.deferreds.push({
              args,
              succeed: () => resolve({ data: fixture.v2Ids.map((id) => ({ id })), error: null }),
              fail: (err) => reject(err),
            });
          });
        }
        if (fixture.v2Throws) throw new Error("rpc connection reset");
        if (fixture.v2Error) return { data: null, error: fixture.v2Error };
        return { data: fixture.v2Ids.map((id) => ({ id })), error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

import { cacheLife, cacheTag } from "next/cache";
import { ARCHIVE_MAX_PAGE, ARCHIVE_PAGE_SIZE } from "../seo/home-canonical";
import {
  MAX_IN_FLIGHT_SEARCHES,
  SEARCH_LIMIT,
  searchClusters,
} from "./search-query";
import {
  MAX_SEARCH_QUERY_LENGTH,
  MAX_QUERY_VARIANTS,
  MAX_SEARCH_TERMS,
  canonicalSearchQuery,
  foldTr,
  normaliseSearchQuery,
  searchFoldedSibling,
  searchSiblingQuery,
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
  fixture.rpcIdsPerCall = null;
  fixture.rpcErrorAtCalls = null;
  fixture.rpcError = null;
  fixture.rpcErrorThreeArg = null;
  fixture.rpcThrows = false;
  fixture.rpcCalls = [];
  fixture.v2Calls = [];
  fixture.v2Ids = [];
  fixture.v2Error = null;
  fixture.v2Throws = false;
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
  summary_tr?: string;
  category?: string;
  bias_distribution?: unknown;
  is_blindspot?: boolean;
  blindspot_side?: unknown;
  first_published?: string;
  members: Array<{ id: string; sourceId: string; content_hash?: string | null }>;
}) {
  return {
    id: opts.id,
    title_tr: opts.title_tr ?? `Cluster ${opts.id}`,
    title_tr_neutral: opts.title_tr_neutral ?? null,
    summary_tr: opts.summary_tr ?? "summary",
    bias_distribution: opts.bias_distribution ?? {},
    is_blindspot: opts.is_blindspot ?? false,
    blindspot_side: opts.blindspot_side ?? null,
    article_count: opts.members.length,
    first_published: opts.first_published ?? "2026-04-18T10:00:00.000Z",
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

    // The typed call is the first one. 'şişli' ends in a vowel, so a short page also makes the
    // second call with its locative folded text (h144-search-1; its own tests are below).
    expect(fixture.rpcCalls[0]).toEqual({
      p_variants: turkishQueryVariants(normalised),
      p_folded: foldTr(normalised),
      p_limit: 24,
    });
    expect(Object.keys(fixture.rpcCalls[0] as object).sort()).toEqual([
      "p_folded",
      "p_limit",
      "p_variants",
    ]);
  });

  it("ASCII typing reaches the RPC as the folded Turkish form's key (sisli, cumhurbaskani)", async () => {
    await searchClusters("sisli");
    await searchClusters("Cumhurbaşkanı");
    // Both end in a vowel and the fixture's typed page is empty, so each search makes the second
    // call too (h144-search-1): the locative is BOTH its variants and its folded text, so the 166
    // guard (which reads p_folded only) covers the words the variants arm searches.
    expect(fixture.rpcCalls).toEqual([
      { p_variants: ["sisli"], p_folded: "sisli", p_limit: 24 },
      { p_variants: ["sislide"], p_folded: "sislide", p_limit: 24 },
      {
        p_variants: turkishQueryVariants("Cumhurbaşkanı"),
        p_folded: "cumhurbaskani",
        p_limit: 24,
      },
      {
        p_variants: turkishQueryVariants("cumhurbaşkanıda"),
        p_folded: "cumhurbaskanida",
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
      // The first call is the typed one; a vowel-final word (ŞİŞLİ) adds the h144-search-1 second call.
      expect(fixture.rpcCalls[0], q).toEqual({
        p_variants: turkishQueryVariants(normaliseSearchQuery(q)),
        p_folded: foldTr(normaliseSearchQuery(q)),
        p_limit: 24,
      });
      // Every call after the first folds its own variants: the locative of the typed words.
      const canonical = canonicalSearchQuery(q);
      const second = searchSiblingQuery(canonical) ?? searchFoldedSibling(canonical);
      for (const extra of fixture.rpcCalls.slice(1) as Array<{ p_variants: string[]; p_folded: string }>) {
        expect(second, q).not.toBeNull();
        expect(extra.p_variants, q).toEqual(turkishQueryVariants(second as string));
        expect(extra.p_folded, q).toBe(foldTr(second as string));
      }
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
// h42-search-1: AKP and AK Parti are one party. The cache key stays the
// canonical query; only the RPC arguments carry the alias disjunction.
// ---------------------------------------------------------------------------

describe("searchClusters alias expansion (AKP <-> AK Parti)", () => {
  const EXPANDED = {
    p_variants: turkishQueryVariants('akp or "ak parti"'),
    p_folded: "akp or ak parti",
    p_limit: 24,
  };

  it("'AKP' sends the websearch disjunction, folded arm unquoted", async () => {
    await searchClusters("AKP");
    expect(fixture.rpcCalls).toEqual([EXPANDED]);
    expect(EXPANDED.p_variants).toEqual(['akp or "ak parti"']);
  });

  it("'AK Parti' sends byte-identical RPC arguments to 'AKP'", async () => {
    await searchClusters("AKP");
    await searchClusters("AK Parti");
    expect(fixture.rpcCalls).toHaveLength(2);
    expect(fixture.rpcCalls[1]).toEqual(fixture.rpcCalls[0]);
    expect(JSON.stringify(fixture.rpcCalls[1])).toBe(JSON.stringify(fixture.rpcCalls[0]));
  });

  it("every spelling of the query ('AK PARTİ', 'ak partı', \"AKP'nin\") reaches the same arguments", async () => {
    for (const q of ["AK PARTİ", "Ak Partı", "AKP'nin", " akp. "]) {
      fixture.rpcCalls = [];
      await searchClusters(q);
      expect(fixture.rpcCalls, q).toEqual([EXPANDED]);
    }
  });

  it("keeps the rest of the query in both disjuncts", async () => {
    await searchClusters("AKP İstanbul");
    expect(fixture.rpcCalls).toEqual([
      {
        p_variants: turkishQueryVariants('akp istanbul or "ak parti" istanbul'),
        p_folded: "akp istanbul or ak parti istanbul",
        p_limit: 24,
      },
    ]);
  });

  it("a Turkish-letter term beside the alias keeps its letters on the variants arm and folds on the other", async () => {
    await searchClusters("AKP Şişli");
    const args = fixture.rpcCalls[0] as { p_variants: string[]; p_folded: string };
    expect(args.p_folded).toBe("akp sisli or ak parti sisli");
    expect(args.p_variants.some((v) => v.includes("şişli"))).toBe(true);
    expect(args.p_variants.every((v) => v.includes('"ak parti"'))).toBe(true);
  });

  it("'Erdoğan' reaches the RPC byte-identical to before", async () => {
    await searchClusters("Erdoğan");
    expect(fixture.rpcCalls).toEqual([
      { p_variants: ["erdoğan"], p_folded: "erdogan", p_limit: 24 },
    ]);
    expect(JSON.stringify(fixture.rpcCalls[0])).toBe(
      '{"p_variants":["erdoğan"],"p_folded":"erdogan","p_limit":24}',
    );
  });

  it.each(["akşener", "ak", "chp", "akparti", '"ak parti"', "akp -chp", "akp or chp"])(
    "%j is not expanded (arguments identical to the plain canonical query)",
    async (q) => {
      await searchClusters(q);
      const canonical = canonicalSearchQuery(q);
      // The typed call is first. A vowel-final word ('akparti', 'afyonlu') adds the second call of
      // h144-search-1, which folds its own variants (the locative of the typed words): nothing is expanded.
      expect(fixture.rpcCalls[0]).toEqual({
        p_variants: turkishQueryVariants(canonical),
        p_folded: foldTr(canonical),
        p_limit: 24,
      });
      const second = searchSiblingQuery(canonical) ?? searchFoldedSibling(canonical);
      for (const extra of fixture.rpcCalls.slice(1) as Array<{ p_variants: string[]; p_folded: string }>) {
        expect(second).not.toBeNull();
        expect(extra.p_variants).toEqual(turkishQueryVariants(second as string));
        expect(extra.p_folded).toBe(foldTr(second as string));
      }
    },
  );

  it("the single-flight key is still the canonical query (one RPC for a burst of AKP spellings)", async () => {
    fixture.hold = true;
    const a = searchClusters("AKP");
    const b = searchClusters("akp!");
    const c = searchClusters(" AKP ");
    await tick();
    expect(fixture.rpcCalls).toHaveLength(1);
    fixture.hold = false;
    for (const d of fixture.deferreds) d.succeed();
    await Promise.all([a, b, c]);
  });

  it("a phrase-making term ('covid_19') keeps the folded arm as it was before the alias: no standalone 'or' in p_folded (h42 review)", async () => {
    // 129 turns a leftover phrase (<->) into plainto_tsquery, which is all AND: an 'or' in p_folded would then be a
    // required lexeme and the folded arm would match nothing. The variants arm still expands.
    for (const q of ["AKP covid_19", "AK Parti covid_19", "akp covid--19"]) {
      fixture.rpcCalls = [];
      await searchClusters(q);
      const canonical = canonicalSearchQuery(q);
      const args = fixture.rpcCalls[0] as { p_variants: string[]; p_folded: string; p_limit: number };
      expect(args.p_folded, q).toBe(foldTr(canonical));
      expect(args.p_folded.split(" "), q).not.toContain("or");
      expect(args.p_variants.some((v) => v.includes('"ak parti"')), q).toBe(true);
    }
    // And a plain query still expands on the folded arm.
    fixture.rpcCalls = [];
    await searchClusters("AKP covid-19");
    expect((fixture.rpcCalls[0] as { p_folded: string }).p_folded).toBe("akp covid-19 or ak parti covid-19");
  });

  it("falls back to the two-argument function with the expanded variants when 129 is missing", async () => {
    fixture.rpcErrorThreeArg = { message: "not found", code: "PGRST202" };
    await searchClusters("AKP");
    expect(fixture.rpcCalls).toEqual([
      EXPANDED,
      { p_variants: EXPANDED.p_variants, p_limit: 24 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// h58-postship-4: 'afyon', 'urfa' and 'antep' also search the official name, one
// way only. On production (2026-11-07) 'afyon' returned 8 ids while the 79 live
// multi-member clusters spelling 'Afyonkarahisar' were out of reach: FTS stems
// 'afyon' to 'afyo' but leaves 'afyonkarahisar' whole, so there is no prefix match.
// ---------------------------------------------------------------------------

describe("searchClusters one-way alias expansion (afyon / urfa / antep)", () => {
  it.each([
    ["afyon", "afyon or afyonkarahisar"],
    ["Urfa", "urfa or sanliurfa"],
    ["ANTEP", "antep or gaziantep"],
    ["Afyon'da", "afyon or afyonkarahisar"],
    ["afyon chp", "afyon chp or afyonkarahisar chp"],
  ])("%j sends the websearch disjunction %j on both arms", async (q, expanded) => {
    await searchClusters(q);
    expect(fixture.rpcCalls).toEqual([
      { p_variants: turkishQueryVariants(expanded), p_folded: expanded, p_limit: 24 },
    ]);
  });

  it("keeps the typed spelling first, so its own results still rank in the disjunction", async () => {
    await searchClusters("afyon");
    const args = fixture.rpcCalls[0] as { p_variants: string[]; p_folded: string };
    expect(args.p_folded.split(" or ")).toEqual(["afyon", "afyonkarahisar"]);
    expect(args.p_variants[0]!.split(" or ")).toEqual(["afyon", "afyonkarahisar"]);
  });

  it.each(["afyonkarahisar", "şanlıurfa", "gaziantep", "maraş", "kahramanmaraş", "afyonlu", '"afyon"', "afyon -chp", "afyon or urfa"])(
    "%j is not expanded (arguments identical to the plain canonical query)",
    async (q) => {
      await searchClusters(q);
      const canonical = canonicalSearchQuery(q);
      // The typed call is first. A vowel-final word ('akparti', 'afyonlu') adds the second call of
      // h144-search-1, which folds its own variants (the locative of the typed words): nothing is expanded.
      expect(fixture.rpcCalls[0]).toEqual({
        p_variants: turkishQueryVariants(canonical),
        p_folded: foldTr(canonical),
        p_limit: 24,
      });
      const second = searchSiblingQuery(canonical) ?? searchFoldedSibling(canonical);
      for (const extra of fixture.rpcCalls.slice(1) as Array<{ p_variants: string[]; p_folded: string }>) {
        expect(second).not.toBeNull();
        expect(extra.p_variants).toEqual(turkishQueryVariants(second as string));
        expect(extra.p_folded).toBe(foldTr(second as string));
      }
    },
  );

  it("a phrase-making term keeps the folded arm as it was, the variants arm still expands", async () => {
    await searchClusters("afyon covid_19");
    const args = fixture.rpcCalls[0] as { p_variants: string[]; p_folded: string };
    expect(args.p_folded).toBe("afyon covid_19");
    expect(args.p_variants).toEqual(turkishQueryVariants("afyon covid_19 or afyonkarahisar covid_19"));
  });

  it("the AKP pair still sends the arguments it always did", async () => {
    await searchClusters("AKP");
    expect(fixture.rpcCalls).toEqual([
      { p_variants: turkishQueryVariants('akp or "ak parti"'), p_folded: "akp or ak parti", p_limit: 24 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// h96-search-1: the headline form of an everyday noun. 'elektrik zammı' found
// nothing on production (2026-11-09) while 'elektrik zam' found 9 stories, because
// the Turkish stemmer gives 'zammı' and 'vergisi' their own lexemes.
//
// The sibling spellings are NEVER merged into the typed call: migration 172 reads
// p_variants[1..3] and ORs them with equal rank, so a merged call let unrelated
// 'kara' rows push real 'karasu' rows off the page (CORR-2). The typed call goes
// first with at most three variants; only when it leaves slots of the page empty
// (fewer than SEARCH_LIMIT ids) does a second call ask for the sibling's spellings,
// and its new ids are appended after the typed ids. h124-postship-1: the typed call
// sends p_folded = foldTr(typed) and the sibling call sends p_folded = foldTr(sibling),
// so the sibling call's own guard and tiers read the sibling words ('asgari ucret zammi'
// found 0 stories because the sibling call kept the typed 'zammi' as p_folded). The
// cache key stays canonical.
// ---------------------------------------------------------------------------

describe("searchClusters sibling variants (h96-search-1)", () => {
  type RpcArgs = { p_variants: string[]; p_folded?: string; p_limit: number };
  const argsOf = (i: number) => fixture.rpcCalls[i] as RpcArgs;
  const ids = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => `${prefix}${i}`);

  it("'elektrik zammı' with no typed hit: typed call, then the sibling call folds the sibling", async () => {
    await searchClusters("elektrik zammı");
    expect(fixture.rpcCalls).toEqual([
      { p_variants: ["elektrik zammı", "elektrik zammi"], p_folded: "elektrik zammi", p_limit: 24 },
      { p_variants: ["elektrik zam"], p_folded: "elektrik zam", p_limit: 24 },
    ]);
  });

  it.each([
    // The sibling path keeps HEAD's call: the sibling's spellings as variants and the sibling folded, with
    // no locative (the typed call already searched the typed stems; h144-search-1 review TS-1).
    ["emlak vergisi", ["emlak vergisi"], "emlak vergisi", ["emlak vergi"], "emlak vergi"],
    ["doğal gaz zammı", ["doğal gaz zammı", "doğal gaz zammi"], "dogal gaz zammi", ["doğal gaz zam"], "dogal gaz zam"],
    ["Asgari Ücret Zammı", ["asgari ücret zammı", "asgari ücret zammi"], "asgari ucret zammi", ["asgari ücret zam"], "asgari ucret zam"],
    ["trafik cezası", ["trafik cezası", "trafik cezasi"], "trafik cezasi", ["trafik ceza"], "trafik ceza"],
  ])(
    "%j with no typed hit: the typed call sends %j with p_folded %j, the sibling call %j with p_folded %j",
    async (q, typed, typedFolded, sibling, siblingFolded) => {
      await searchClusters(q);
      expect(fixture.rpcCalls).toEqual([
        { p_variants: typed, p_folded: typedFolded, p_limit: 24 },
        { p_variants: sibling, p_folded: siblingFolded, p_limit: 24 },
      ]);
    },
  );

  // h124-postship-1: the ASCII spelling of a possessive. Both calls come back empty here (the fixture's default),
  // so the page makes exactly two calls: the typed words, then the sibling's spellings folded as the sibling.
  // Before the fix the sibling call carried the typed 'zammi' as p_folded and found 0 stories on production
  // ('asgari ucret zam' as p_folded found 7, 'dogal gaz zam' found 4).
  it.each([
    ["asgari ucret zammi", "asgari ucret zam"],
    ["dogal gaz zammi", "dogal gaz zam"],
  ])("%j (ASCII, empty typed result): exactly two calls, the second folds the sibling %j", async (typed, sibling) => {
    await searchClusters(typed);
    expect(fixture.rpcCalls).toEqual([
      { p_variants: turkishQueryVariants(typed), p_folded: typed, p_limit: 24 },
      { p_variants: turkishQueryVariants(sibling), p_folded: sibling, p_limit: 24 },
    ]);
  });

  it("the ASCII possessive's sibling ids fill the empty page, typed ids first: 'asgari ucret zammi' lists the 7 sibling stories", async () => {
    const sib = ids(7, "z");
    fixture.rpcIdsPerCall = [[], sib];
    fixture.data = sib.map((id) => mkRow({ id, members: [{ id: `a-${id}`, sourceId: "s1" }] }));
    const result = await searchClusters("asgari ucret zammi");
    expect(fixture.rpcCalls).toHaveLength(2);
    if (!result.ok) throw new Error("expected ok");
    expect(result.bundles.map((b) => b.cluster.id)).toEqual(sib);
    expect(result.capped).toBe(false);
  });

  it("a full typed page (24 ids): 'trafik cezası' makes exactly one call, so the sibling never displaces a typed hit", async () => {
    fixture.rpcIdsPerCall = [ids(24, "t")];
    fixture.data = ids(24, "t").map((id) => mkRow({ id, members: [{ id: `a-${id}`, sourceId: "s1" }] }));
    const result = await searchClusters("trafik cezası");
    expect(fixture.rpcCalls).toEqual([
      { p_variants: ["trafik cezası", "trafik cezasi"], p_folded: "trafik cezasi", p_limit: 24 },
    ]);
    if (!result.ok) throw new Error("expected ok");
    expect(result.capped).toBe(true);
    expect(result.bundles.map((b) => b.cluster.id)).toEqual(ids(24, "t"));
  });

  it("a short typed page (2 ids): a second call follows with ['trafik ceza']; typed ids first, then the new sibling ids, deduplicated", async () => {
    fixture.rpcIdsPerCall = [["t1", "t2"], ["s1", "t2", "s2", "t1", "s1"]];
    fixture.data = [
      mkRow({ id: "s2", members: [{ id: "a-s2", sourceId: "s3" }] }),
      mkRow({ id: "t2", members: [{ id: "a-t2", sourceId: "s2" }] }),
      mkRow({ id: "s1", members: [{ id: "a-s1", sourceId: "s1" }] }),
      mkRow({ id: "t1", members: [{ id: "a-t1", sourceId: "s1" }] }),
    ];
    const result = await searchClusters("trafik cezası");
    expect(fixture.rpcCalls).toEqual([
      { p_variants: ["trafik cezası", "trafik cezasi"], p_folded: "trafik cezasi", p_limit: 24 },
      { p_variants: ["trafik ceza"], p_folded: "trafik ceza", p_limit: 24 },
    ]);
    const state = fixture.lastState as BuilderState;
    expect(state.in).toEqual([{ col: "id", vals: ["t1", "t2", "s1", "s2"] }]);
    if (!result.ok) throw new Error("expected ok");
    expect(result.bundles.map((b) => b.cluster.id)).toEqual(["t1", "t2", "s1", "s2"]);
    expect(result.capped).toBe(false);
  });

  it("the merged page never exceeds SEARCH_LIMIT: 20 typed ids, then only the first 4 new sibling ids, and capped is true", async () => {
    fixture.rpcIdsPerCall = [ids(20, "t"), [...ids(2, "t"), ...ids(10, "s")]];
    const result = await searchClusters("trafik cezası");
    const state = fixture.lastState as BuilderState;
    const expected = [...ids(20, "t"), ...ids(4, "s")];
    expect(expected).toHaveLength(SEARCH_LIMIT);
    expect(state.in).toEqual([{ col: "id", vals: expected }]);
    if (!result.ok) throw new Error("expected ok");
    expect(result.capped).toBe(true);
  });

  it("a sibling call that adds nothing new leaves the typed result exactly as it was", async () => {
    fixture.rpcIdsPerCall = [["t1", "t2"], ["t2", "t1"]];
    fixture.data = [
      mkRow({ id: "t1", members: [{ id: "a-t1", sourceId: "s1" }] }),
      mkRow({ id: "t2", members: [{ id: "a-t2", sourceId: "s2" }] }),
    ];
    const result = await searchClusters("emlak vergisi");
    if (!result.ok) throw new Error("expected ok");
    expect(result.bundles.map((b) => b.cluster.id)).toEqual(["t1", "t2"]);
    expect(result.capped).toBe(false);
  });

  it("'karasu' has no root sibling (the -su compound is not a possessive): the typed call, then a second call that folds the locative 'karasuda' as variants and folded text (h144-search-1)", async () => {
    await searchClusters("karasu");
    expect(fixture.rpcCalls).toEqual([
      { p_variants: ["karasu"], p_folded: "karasu", p_limit: 24 },
      { p_variants: ["karasuda"], p_folded: "karasuda", p_limit: 24 },
    ]);
    expect(searchSiblingQuery("karasu")).toBeNull();
  });

  it.each(["kayısı", "sarısu", "ılısu", "Karasu"])(
    "%j has no root sibling: the typed call, then the locative as variants and folded text, never the root of a possessive",
    async (q) => {
      await searchClusters(q);
      const canonical = canonicalSearchQuery(q);
      expect(searchSiblingQuery(canonical)).toBeNull();
      expect(fixture.rpcCalls[0]).toEqual({
        p_variants: turkishQueryVariants(canonical),
        p_folded: foldTr(canonical),
        p_limit: 24,
      });
      const locative = searchFoldedSibling(canonical) as string;
      expect(locative).not.toBeNull();
      expect(fixture.rpcCalls.slice(1)).toEqual([
        { p_variants: turkishQueryVariants(locative), p_folded: foldTr(locative), p_limit: 24 },
      ]);
    },
  );

  it("the sibling call folds the sibling: p_folded is foldTr(typed) in the typed call and foldTr(sibling) in the sibling call", async () => {
    for (const q of ["elektrik zammı", "emlak vergisi", "hakkı", "Soruşturması", "asgari ucret zammi"]) {
      fixture.rpcCalls = [];
      await searchClusters(q);
      const canonical = canonicalSearchQuery(q);
      const sibling = searchSiblingQuery(canonical);
      expect(sibling, q).not.toBeNull();
      expect(fixture.rpcCalls.length, q).toBe(2);
      expect(argsOf(0).p_folded, q).toBe(foldTr(canonical));
      // The sibling path folds the sibling exactly, with no locative (HEAD's call).
      expect(argsOf(1).p_folded, q).toBe(foldTr(sibling as string));
      expect(argsOf(1).p_folded, q).not.toBe(argsOf(0).p_folded);
      expect(argsOf(0).p_variants, q).toEqual(turkishQueryVariants(canonical));
      expect(argsOf(1).p_variants, q).toEqual(turkishQueryVariants(sibling as string));
    }
  });

  it("every call carries at most three variants: a word with three typed and three sibling spellings sends them in two calls", async () => {
    await searchClusters("ışık vergisi");
    expect(fixture.rpcCalls).toHaveLength(2);
    expect(argsOf(0).p_variants).toEqual(turkishQueryVariants("ışık vergisi"));
    expect(argsOf(1).p_variants).toEqual(turkishQueryVariants("ışık vergi"));
    expect(argsOf(0).p_variants).toHaveLength(MAX_QUERY_VARIANTS);
    expect(argsOf(1).p_variants).toHaveLength(MAX_QUERY_VARIANTS);
  });

  it("no call carries more than three variants or a repeat, whatever the query", async () => {
    for (const q of [
      "IŞIK VERGİSİ",
      "ışık zammı",
      "Işık Cezası",
      "vergisi zammı cezası hakkı affı sırrı",
      "ışık işık vergisi zammı",
    ]) {
      fixture.rpcCalls = [];
      await searchClusters(q);
      for (const call of fixture.rpcCalls as RpcArgs[]) {
        expect(call.p_variants.length, q).toBeLessThanOrEqual(MAX_QUERY_VARIANTS);
        expect(new Set(call.p_variants).size, q).toBe(call.p_variants.length);
      }
    }
  });

  it("every variant of both calls keeps the term count and the 64-character bound of the canonical query", async () => {
    await searchClusters("emlak vergisi zammı trafik cezası yeni");
    expect(fixture.rpcCalls).toHaveLength(2);
    for (const call of fixture.rpcCalls as RpcArgs[]) {
      for (const v of call.p_variants) {
        expect(v.split(" ")).toHaveLength(6);
        expect(v.length).toBeLessThanOrEqual(MAX_SEARCH_QUERY_LENGTH);
      }
    }
    expect(argsOf(1).p_variants).toEqual(["emlak vergi zam trafik ceza yeni"]);
  });

  it.each(["Erdoğan", "burdur", "miller", "elektrik zam", "seçim", "iran"])(
    "%j has no sibling: one call, the arguments are exactly what they were before",
    async (q) => {
      await searchClusters(q);
      const canonical = canonicalSearchQuery(q);
      expect(fixture.rpcCalls).toEqual([
        {
          p_variants: turkishQueryVariants(canonical),
          p_folded: foldTr(canonical),
          p_limit: 24,
        },
      ]);
    },
  );

  it.each(['"emlak vergisi"', "-vergisi", "emlak -vergisi", "vergisi or zammı", "akp or chp"])(
    "%j uses websearch syntax: no sibling, one call with the plain canonical query",
    async (q) => {
      await searchClusters(q);
      const canonical = canonicalSearchQuery(q);
      expect(fixture.rpcCalls).toEqual([
        {
          p_variants: turkishQueryVariants(canonical),
          p_folded: foldTr(canonical),
          p_limit: 24,
        },
      ]);
    },
  );

  it("an alias query ('AKP vergisi') is expanded as before and gets no sibling call", async () => {
    await searchClusters("AKP vergisi");
    expect(fixture.rpcCalls).toEqual([
      {
        p_variants: turkishQueryVariants('akp vergisi or "ak parti" vergisi'),
        p_folded: "akp vergisi or ak parti vergisi",
        p_limit: 24,
      },
    ]);
  });

  it("the cache key stays canonical: spellings of one query run one search, typed call then sibling call", async () => {
    fixture.hold = true;
    const a = searchClusters("elektrik zammı");
    const b = searchClusters("ELEKTRİK ZAMMI!");
    const c = searchClusters(" Elektrik Zammı ");
    await tick();
    expect(fixture.rpcCalls).toHaveLength(1);
    expect(argsOf(0).p_variants).not.toContain("elektrik zam");
    fixture.hold = false;
    for (const d of fixture.deferreds) d.succeed();
    await Promise.all([a, b, c]);
    expect(fixture.rpcCalls).toHaveLength(2);
    expect(argsOf(1).p_variants).toEqual(["elektrik zam"]);
  });

  it("falls back to 083's two-argument function for both calls (it reads the first three variants)", async () => {
    fixture.rpcErrorThreeArg = { message: "not found", code: "PGRST202" };
    await searchClusters("elektrik zammı");
    const typed = ["elektrik zammı", "elektrik zammi"];
    expect(fixture.rpcCalls).toEqual([
      { p_variants: typed, p_folded: "elektrik zammi", p_limit: 24 },
      { p_variants: typed, p_limit: 24 },
      { p_variants: ["elektrik zam"], p_limit: 24 },
    ]);
  });

  it("an error on the sibling call fails the attempt like any RPC error: the live retry runs both calls again", async () => {
    fixture.rpcErrorAtCalls = { indexes: [1], error: { message: "statement timeout" } };
    const result = await searchClusters("elektrik zammı");
    // attempt: typed (ok), sibling (error); live retry: typed (ok), sibling (ok)
    expect(fixture.rpcCalls).toHaveLength(4);
    expect(result.ok).toBe(true);
  });

  it("a persistent error on the sibling call is { ok: false }", async () => {
    fixture.rpcErrorAtCalls = { indexes: [1, 3], error: { message: "statement timeout" } };
    const result = await searchClusters("elektrik zammı");
    expect(fixture.rpcCalls).toHaveLength(4);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// h144-search-1: two more things the SECOND call asks for, and only when the typed
// call left the page short (fewer than SEARCH_LIMIT ids), after the typed ids.
//
//   * a case suffix typed without an apostrophe ('imamoğluna', 'suriyede') is
//     searched as its root ('imamoğlu', 'suriye'), the rule C of searchSiblingQuery;
//   * a bare vowel-final noun ('bolu kaza' with no root sibling) is asked again with its
//     locative ('boluda kazada'), because the stemmer cuts 'kaza' to 'kaz' but 'kazada'
//     to 'kaza', so the headlines that inflect the noun were never found.
//
// Every call folds its OWN variants (review TS-1): the 166 over-stem guard reads p_folded
// only, so a second call whose variants differ from its folded text searches stems the guard
// does not cover ('tarla' as variants with 'tarlada' folded appended 6 rows with no 'tarl'
// word). The locative path sends the locative as BOTH arguments; the sibling path (a root
// such as 'imamoğlu') sends HEAD's call, the sibling as both, with no locative: the typed call
// has already searched the typed stems, and a locative of a proper noun finds less
// ('boluda kazada' 0 against 7 for 'bolu kaza').
//
// A full typed page makes no second call, so typed ranks never move.
// ---------------------------------------------------------------------------

describe("searchClusters: case-suffix sibling and folded locative (h144-search-1)", () => {
  type RpcArgs = { p_variants: string[]; p_folded?: string; p_limit: number };
  const argsOf = (i: number) => fixture.rpcCalls[i] as RpcArgs;
  const ids = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => `${prefix}${i}`);

  it("'bolu kaza' with a short typed page (7 ids): the second call sends the locative as variants and folded text", async () => {
    fixture.rpcIdsPerCall = [ids(7, "t")];
    await searchClusters("bolu kaza");
    expect(fixture.rpcCalls).toEqual([
      { p_variants: turkishQueryVariants("bolu kaza"), p_folded: "bolu kaza", p_limit: 24 },
      { p_variants: turkishQueryVariants("boluda kazada"), p_folded: "boluda kazada", p_limit: 24 },
    ]);
  });

  // TS-1 (review): the second call used to send the TYPED spellings as variants with the locative as the
  // folded text. 'tarla' stems to 'tar' and 'tarlada' to 'tarla': the 166 guard read the locative's 'tarla'
  // while the variants arm searched 'tar', and 6 of the 13 appended rows held no 'tarl' word.
  it("'tarla' with a short typed page: the second call is the locative as variants AND folded text", async () => {
    fixture.rpcIdsPerCall = [ids(11, "t")];
    await searchClusters("tarla");
    expect(searchSiblingQuery("tarla")).toBeNull();
    expect(fixture.rpcCalls).toEqual([
      { p_variants: turkishQueryVariants("tarla"), p_folded: "tarla", p_limit: 24 },
      { p_variants: turkishQueryVariants("tarlada"), p_folded: "tarlada", p_limit: 24 },
    ]);
  });

  // The sibling path of the same hole: 'tarlası' -> sibling 'tarla'. Its second call is HEAD's sibling call, with
  // no locative: the locative of a proper noun finds less ('boluda kazada' 0 against 7 for 'bolu kaza').
  it("'tarlası' (sibling 'tarla'): the second call is the sibling as variants AND folded text, no locative", async () => {
    fixture.rpcIdsPerCall = [ids(3, "t")];
    await searchClusters("tarlası");
    expect(searchSiblingQuery("tarlası")).toBe("tarla");
    expect(fixture.rpcCalls).toEqual([
      { p_variants: turkishQueryVariants("tarlası"), p_folded: "tarlasi", p_limit: 24 },
      { p_variants: turkishQueryVariants("tarla"), p_folded: "tarla", p_limit: 24 },
    ]);
  });

  it("every RPC call after the first folds its own variants: p_folded === foldTr(p_variants[0])", async () => {
    const queries = [
      "tarla",
      "tarlası",
      "bolu kaza",
      "imamoğluna",
      "suriyede",
      "netanyahu bloğu ilk oylama",
      "sisli",
      "Cumhurbaşkanı",
      "zammına",
    ];
    for (const q of queries) {
      fixture.rpcCalls = [];
      fixture.rpcIdsPerCall = [ids(2, "t")];
      await searchClusters(q);
      expect(fixture.rpcCalls.length, q).toBeGreaterThan(1);
      for (const call of fixture.rpcCalls.slice(1) as RpcArgs[]) {
        expect(call.p_folded, q).toBe(foldTr(call.p_variants[0] as string));
      }
    }
  });

  it("'imamoğluna' with no typed hit: the second call is HEAD's sibling call, 'imamoğlu' as variants and folded text", async () => {
    fixture.rpcIdsPerCall = [[]];
    await searchClusters("imamoğluna");
    expect(fixture.rpcCalls).toEqual([
      { p_variants: turkishQueryVariants("imamoğluna"), p_folded: "imamogluna", p_limit: 24 },
      { p_variants: turkishQueryVariants("imamoğlu"), p_folded: "imamoglu", p_limit: 24 },
    ]);
  });

  it("'netanyahu bloğu ilk oylama': the typed words, then the locative of every word as variants and folded text", async () => {
    await searchClusters("Netanyahu bloğu ilk oylama");
    expect(fixture.rpcCalls).toEqual([
      {
        p_variants: turkishQueryVariants("netanyahu bloğu ilk oylama"),
        p_folded: "netanyahu blogu ilk oylama",
        p_limit: 24,
      },
      {
        p_variants: turkishQueryVariants("netanyahuda bloğuda ilk oylamada"),
        p_folded: "netanyahuda bloguda ilk oylamada",
        p_limit: 24,
      },
    ]);
  });

  it.each([
    ["suriyede", "suriye"],
    ["Adanada", "adana"],
    ["abdye", "abd"],
    ["çinde", "çin"],
  ])("%j (no typed hit): the second call asks for %j, folded as itself", async (q, sibling) => {
    await searchClusters(q);
    expect(fixture.rpcCalls).toHaveLength(2);
    expect(argsOf(1).p_variants).toEqual(turkishQueryVariants(sibling));
    expect(argsOf(1).p_folded).toBe(foldTr(sibling));
  });

  it("a full typed page (24 ids) makes no second call, whatever the query holds", async () => {
    for (const q of ["bolu kaza", "imamoğluna", "suriyede", "netanyahu bloğu ilk oylama"]) {
      fixture.rpcCalls = [];
      fixture.rpcIdsPerCall = [ids(24, "t")];
      fixture.data = ids(24, "t").map((id) => mkRow({ id, members: [{ id: `a-${id}`, sourceId: "s1" }] }));
      const result = await searchClusters(q);
      expect(fixture.rpcCalls, q).toHaveLength(1);
      if (!result.ok) throw new Error("expected ok");
      expect(result.capped, q).toBe(true);
      expect(result.bundles.map((b) => b.cluster.id), q).toEqual(ids(24, "t"));
    }
  });

  it("typed ids first, then the second call's new ids, deduplicated, up to SEARCH_LIMIT", async () => {
    // 'bolu kaza': 7 typed hits, the second call returns 2 of them again plus 30 new ones.
    fixture.rpcIdsPerCall = [ids(7, "t"), ["t3", "t0", ...ids(30, "s")]];
    const result = await searchClusters("bolu kaza");
    const state = fixture.lastState as BuilderState;
    const expected = [...ids(7, "t"), ...ids(17, "s")];
    expect(expected).toHaveLength(SEARCH_LIMIT);
    expect(state.in).toEqual([{ col: "id", vals: expected }]);
    if (!result.ok) throw new Error("expected ok");
    expect(result.capped).toBe(true);
  });

  it("an empty typed page is filled by the second call's ids: 'imamoğluna' lists the 'imamoğlu' stories", async () => {
    const sib = ids(5, "i");
    fixture.rpcIdsPerCall = [[], sib];
    fixture.data = sib.map((id) => mkRow({ id, members: [{ id: `a-${id}`, sourceId: "s1" }] }));
    const result = await searchClusters("imamoğluna");
    expect(fixture.rpcCalls).toHaveLength(2);
    if (!result.ok) throw new Error("expected ok");
    expect(result.bundles.map((b) => b.cluster.id)).toEqual(sib);
    expect(result.capped).toBe(false);
  });

  it("a second call that adds nothing new leaves the typed page exactly as it was", async () => {
    fixture.rpcIdsPerCall = [["t1", "t2"], ["t2", "t1"]];
    fixture.data = [
      mkRow({ id: "t1", members: [{ id: "a-t1", sourceId: "s1" }] }),
      mkRow({ id: "t2", members: [{ id: "a-t2", sourceId: "s2" }] }),
    ];
    const result = await searchClusters("bolu kaza");
    if (!result.ok) throw new Error("expected ok");
    expect(result.bundles.map((b) => b.cluster.id)).toEqual(["t1", "t2"]);
    expect(result.capped).toBe(false);
  });

  it.each([
    ["messi", "messide"],
    ["emlak vergi", "emlak vergide"],
  ])("%j has no root sibling: the second call sends the locative %j as variants and folded text", async (q, locative) => {
    await searchClusters(q);
    const canonical = canonicalSearchQuery(q);
    expect(searchSiblingQuery(canonical)).toBeNull();
    expect(fixture.rpcCalls).toEqual([
      { p_variants: turkishQueryVariants(canonical), p_folded: foldTr(canonical), p_limit: 24 },
      { p_variants: turkishQueryVariants(locative), p_folded: foldTr(locative), p_limit: 24 },
    ]);
  });

  it("'zammına' reads as zammı + na (rule C): the second call asks for 'zammı', folded as itself (no locative)", async () => {
    await searchClusters("zammına");
    expect(fixture.rpcCalls).toEqual([
      { p_variants: turkishQueryVariants("zammına"), p_folded: "zammina", p_limit: 24 },
      { p_variants: turkishQueryVariants("zammı"), p_folded: "zammi", p_limit: 24 },
    ]);
  });

  it("a query with a case suffix AND a possessive sends one sibling that holds both roots", async () => {
    await searchClusters("trafik cezası imamoğluna");
    expect(fixture.rpcCalls).toHaveLength(2);
    expect(argsOf(1).p_variants).toEqual(turkishQueryVariants("trafik ceza imamoğlu"));
    expect(argsOf(1).p_folded).toBe(foldTr("trafik ceza imamoğlu"));
  });

  it("every call keeps at most three variants and the term count of the canonical query", async () => {
    for (const q of ["bolu kaza", "imamoğluna", "Işık kaza", "netanyahu bloğu ilk oylama", "vergisi kaza imamoğluna"]) {
      fixture.rpcCalls = [];
      await searchClusters(q);
      const termCount = canonicalSearchQuery(q).split(" ").length;
      for (const call of fixture.rpcCalls as RpcArgs[]) {
        expect(call.p_variants.length, q).toBeLessThanOrEqual(MAX_QUERY_VARIANTS);
        expect(call.p_folded!.split(" "), q).toHaveLength(termCount);
        expect(call.p_variants.every((v) => v.split(" ").length === termCount), q).toBe(true);
      }
    }
  });

  it.each(["Erdoğan", "iran", "seçim", "deprem", "istanbul", "2026", "%50", "TCMB", "ab"])(
    "%j holds nothing to inflect: exactly one call, the typed arguments",
    async (q) => {
      await searchClusters(q);
      const canonical = canonicalSearchQuery(q);
      expect(fixture.rpcCalls).toEqual([
        { p_variants: turkishQueryVariants(canonical), p_folded: foldTr(canonical), p_limit: 24 },
      ]);
    },
  );

  it.each(['"bolu kaza"', "-kaza", "bolu -kaza", "bolu kaza or imamoğluna", "akp or chp"])(
    "%j uses websearch syntax: no folded sibling, one call",
    async (q) => {
      await searchClusters(q);
      expect(fixture.rpcCalls).toHaveLength(1);
      expect(argsOf(0).p_folded).toBe(foldTr(canonicalSearchQuery(q)));
    },
  );

  it("an alias query ('AKP kaza') is expanded as before and gets no second call", async () => {
    await searchClusters("AKP kaza");
    expect(fixture.rpcCalls).toEqual([
      {
        p_variants: turkishQueryVariants('akp kaza or "ak parti" kaza'),
        p_folded: "akp kaza or ak parti kaza",
        p_limit: 24,
      },
    ]);
  });

  it("falls back to 083's two-argument function for the second call too (no p_folded in it)", async () => {
    fixture.rpcErrorThreeArg = { message: "not found", code: "PGRST202" };
    await searchClusters("bolu kaza");
    const typed = turkishQueryVariants("bolu kaza");
    expect(fixture.rpcCalls).toEqual([
      { p_variants: typed, p_folded: "bolu kaza", p_limit: 24 },
      { p_variants: typed, p_limit: 24 },
      { p_variants: turkishQueryVariants("boluda kazada"), p_limit: 24 },
    ]);
  });

  it("an error on the second call fails the attempt: the live retry runs both calls again", async () => {
    fixture.rpcErrorAtCalls = { indexes: [1], error: { message: "statement timeout" } };
    const result = await searchClusters("bolu kaza");
    expect(fixture.rpcCalls).toHaveLength(4);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// h157-search-1: the stemmer cuts 'kaza' to 'kaz' but 'kazada', 'kazayı' AND 'kazandı' to 'kaza', so the
// locative second call of '<il> kaza' appended election and court rows that hold 'kazandı' only ('tokat
// kaza' showed 5 such cards out of 6). A row that ONLY the locative call found is dropped when its text
// (title_tr_neutral, title_tr, summary_tr: the columns of search_tsv, already in the embed) holds the typed
// term only as 'term + n...'. Typed rows and the rows of the root-sibling call are never touched, and the
// RPC arguments do not change.
// ---------------------------------------------------------------------------

describe("searchClusters: the locative witness filter (h157-search-1)", () => {
  type RpcArgs = { p_variants: string[]; p_folded?: string; p_limit: number };
  const ids = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  const row = (id: string, title: string, extra: { neutral?: string | null; summary?: string } = {}) =>
    mkRow({
      id,
      title_tr: title,
      title_tr_neutral: extra.neutral ?? null,
      summary_tr: extra.summary ?? "ozet",
      members: [{ id: `a-${id}`, sourceId: "s1" }],
    });
  const idsOf = (result: Awaited<ReturnType<typeof searchClusters>>) => {
    if (!result.ok) throw new Error("expected ok");
    return result.bundles.map((b) => b.cluster.id);
  };

  it("'tokat kaza': the rows that hold only 'kazandı' are dropped, the typed row and the 'kazada' row stay", async () => {
    fixture.rpcIdsPerCall = [["t0"], ["l1", "l2", "l3"]];
    fixture.data = [
      row("t0", "Kaza sonrası kaybolan Esma Nur'u arama çalışmaları Tokat'a uzandı"),
      row("l1", "Tokat'ta ara seçim: 4 Belde sonuçları belli oldu", { summary: "AK Parti 3 beldeyi kazandı" }),
      row("l2", "Tokat'ta Zafer Kazandı"),
      row("l3", "Tokat'ta kazada 2 yaralı"),
    ];
    const result = await searchClusters("tokat kaza");
    expect(idsOf(result)).toEqual(["t0", "l3"]);
    expect(result.ok && result.capped).toBe(false);
    // The arguments of both calls are exactly what they were before the filter existed.
    expect(fixture.rpcCalls).toEqual([
      { p_variants: turkishQueryVariants("tokat kaza"), p_folded: "tokat kaza", p_limit: 24 },
      { p_variants: turkishQueryVariants("tokat kazada"), p_folded: "tokat kazada", p_limit: 24 },
    ]);
    // The embed still reads every id the RPCs listed (no extra DB call, no narrower select).
    expect((fixture.lastState as BuilderState).in).toEqual([{ col: "id", vals: ["t0", "l1", "l2", "l3"] }]);
  });

  it("reads all three texts of search_tsv: the neutral title and the summary count as a witness too", async () => {
    fixture.rpcIdsPerCall = [["t0"], ["l1", "l2", "l3", "l4"]];
    fixture.data = [
      row("t0", "Kaza sonrası arama"),
      row("l1", "Seçimi kazandı", { neutral: "Tokat'ta kazada 2 yaralı" }),
      row("l2", "Seçimi kazandı", { summary: "Sürücü kazaya karıştı." }),
      row("l3", "Seçimi kazandı", { neutral: "Zafer kazandı", summary: "Kazanan belli oldu" }),
      row("l4", "Kaza haberi: trafik kazası"),
    ];
    expect(idsOf(await searchClusters("tokat kaza"))).toEqual(["t0", "l1", "l2", "l4"]);
  });

  it("a row with a null neutral title and no witness anywhere is dropped without a throw", async () => {
    fixture.rpcIdsPerCall = [["t0"], ["l1"]];
    fixture.data = [row("t0", "Kaza sonrası arama"), row("l1", "Seçim", { neutral: null })];
    expect(idsOf(await searchClusters("tokat kaza"))).toEqual(["t0"]);
  });

  it("the genitive is kept: 'meclis oylama' keeps a locative row that holds only 'oylamanın'", async () => {
    fixture.rpcIdsPerCall = [["t0"], ["l1", "l2", "l3"]];
    fixture.data = [
      row("t0", "Meclis oylama yaptı"),
      row("l1", "Meclis'te oylamanın ardından kriz"),
      row("l2", "Genel Kurul oylamada bir araya geldi"),
      row("l3", "Meclis oyladı"),
    ];
    expect(idsOf(await searchClusters("meclis oylama"))).toEqual(["t0", "l1", "l2"]);
  });

  it("a typed id that the locative call also returned is a typed row: kept even with no witness", async () => {
    fixture.rpcIdsPerCall = [["t1", "t2"], ["t2", "l1", "t1"]];
    fixture.data = [
      row("t1", "Zafer Kazandı"),
      row("t2", "Seçimi kazanan aday"),
      row("l1", "Maçı kazandı"),
    ];
    expect(idsOf(await searchClusters("tokat kaza"))).toEqual(["t1", "t2"]);
  });

  it("a typed row is never judged, whatever it holds", async () => {
    fixture.rpcIdsPerCall = [["t0"], []];
    fixture.data = [row("t0", "Zafer Kazandı")];
    expect(idsOf(await searchClusters("tokat kaza"))).toEqual(["t0"]);
  });

  it("the sibling path ('tarlası' -> 'tarla') is not filtered: rows with no witness stay", async () => {
    fixture.rpcIdsPerCall = [["t0"], ["s1", "s2"]];
    fixture.data = [row("t0", "Tarlası yandı"), row("s1", "Bakan Yumaklı açıkladı"), row("s2", "Çiftçi destek")];
    const result = await searchClusters("tarlası");
    expect(searchSiblingQuery("tarlası")).toBe("tarla");
    expect(idsOf(result)).toEqual(["t0", "s1", "s2"]);
    expect(fixture.rpcCalls).toEqual([
      { p_variants: turkishQueryVariants("tarlası"), p_folded: "tarlasi", p_limit: 24 },
      { p_variants: turkishQueryVariants("tarla"), p_folded: "tarla", p_limit: 24 },
    ]);
  });

  it("the rule-C sibling path ('imamoğluna') is not filtered either", async () => {
    fixture.rpcIdsPerCall = [[], ["i1", "i2"]];
    fixture.data = [row("i1", "Seçim gündemi"), row("i2", "Başka haber")];
    expect(idsOf(await searchClusters("imamoğluna"))).toEqual(["i1", "i2"]);
  });

  it("typed 20 + locative 4 with 2 failing: 22 bundles and capped false (it was 24 and true)", async () => {
    const typed = ids(20, "t");
    const loc = ids(4, "l");
    fixture.rpcIdsPerCall = [typed, loc];
    fixture.data = [
      ...typed.map((id) => row(id, "Trafik kazası")),
      row("l0", "Tokat'ta kazada 2 yaralı"),
      row("l1", "Seçimi kazandı"),
      row("l2", "Zafer Kazandı"),
      row("l3", "Kazaya karışan araç"),
    ];
    const result = await searchClusters("tokat kaza");
    expect(idsOf(result)).toEqual([...typed, "l0", "l3"]);
    expect(idsOf(result)).toHaveLength(22);
    expect(result.ok && result.capped).toBe(false);
  });

  it("typed 20 + locative 4, none failing: 24 bundles and capped true (nothing changes when nothing is junk)", async () => {
    const typed = ids(20, "t");
    const loc = ids(4, "l");
    fixture.rpcIdsPerCall = [typed, loc];
    fixture.data = [...typed, ...loc].map((id) => row(id, "Tokat'ta kazada yaralı"));
    const result = await searchClusters("tokat kaza");
    expect(idsOf(result)).toHaveLength(24);
    expect(result.ok && result.capped).toBe(true);
  });

  it("a locative page longer than the room left: the appended ids stop at SEARCH_LIMIT, then the filter runs on those", async () => {
    const typed = ids(20, "t");
    const loc = ids(10, "l");
    fixture.rpcIdsPerCall = [typed, loc];
    fixture.data = [...typed, ...ids(4, "l")].map((id, i) =>
      row(id, i === 21 ? "Seçimi kazandı" : "Trafik kazası"),
    );
    const result = await searchClusters("tokat kaza");
    expect((fixture.lastState as BuilderState).in).toEqual([{ col: "id", vals: [...typed, ...ids(4, "l")] }]);
    expect(idsOf(result)).toHaveLength(23);
    // l4..l9 were never considered, so the list is not complete: capped stays true.
    expect(result.ok && result.capped).toBe(true);
  });

  it("typed 0 + a full locative page of 24 with 2 failing: 22 bundles and capped true (the RPC was limited)", async () => {
    const loc = ids(24, "l");
    fixture.rpcIdsPerCall = [[], loc];
    fixture.data = loc.map((id, i) =>
      row(id, i === 3 || i === 11 ? "Seçimi kazandı" : "Tokat'ta kazada yaralı"),
    );
    const result = await searchClusters("tokat kaza");
    expect(idsOf(result)).toHaveLength(22);
    expect(result.ok && result.capped).toBe(true);
  });

  it("typed 20 + a locative page whose tail is typed duplicates, one new id failing: 23 bundles and capped false", async () => {
    const typed = ids(20, "t");
    fixture.rpcIdsPerCall = [typed, ["l0", "l1", "l2", "l3", "t0", "t1"]];
    fixture.data = [
      ...typed.map((id) => row(id, "Trafik kazası")),
      row("l0", "Tokat'ta kazada 2 yaralı"),
      row("l1", "Seçimi kazandı"),
      row("l2", "Tokat'ta kazada 3 yaralı"),
      row("l3", "Kazaya karışan araç"),
    ];
    const result = await searchClusters("tokat kaza");
    expect(idsOf(result)).toHaveLength(23);
    expect(result.ok && result.capped).toBe(false);
  });

  it("every id dropped: { bundles: [], capped: false }", async () => {
    fixture.rpcIdsPerCall = [[], ["l1", "l2"]];
    fixture.data = [row("l1", "Seçimi kazandı"), row("l2", "Zafer Kazandı")];
    const result = await searchClusters("tokat kaza");
    expect(result).toEqual({ ok: true, bundles: [], capped: false });
  });

  it("a two-term locative ('bolu kaza') drops a row that lacks either term's witness", async () => {
    fixture.rpcIdsPerCall = [["t0"], ["l1", "l2", "l3"]];
    fixture.data = [
      row("t0", "Bolu'da kaza"),
      row("l1", "Bolu'da kazada 2 yaralı"),
      row("l2", "Bolu'da seçimi kazandı"),
      row("l3", "Ankara'da kazada 3 yaralı"),
    ];
    expect(idsOf(await searchClusters("bolu kaza"))).toEqual(["t0", "l1"]);
  });

  it("a full typed page makes no second call and no row is dropped", async () => {
    const typed = ids(24, "t");
    fixture.rpcIdsPerCall = [typed];
    fixture.data = typed.map((id) => row(id, "Zafer Kazandı"));
    const result = await searchClusters("tokat kaza");
    expect(fixture.rpcCalls).toHaveLength(1);
    expect(idsOf(result)).toEqual(typed);
    expect(result.ok && result.capped).toBe(true);
  });

  it("a query with websearch syntax has no locative call and so no filter", async () => {
    fixture.rpcIdsPerCall = [["t0", "t1"]];
    fixture.data = [row("t0", "Zafer Kazandı"), row("t1", "Seçimi kazandı")];
    expect(idsOf(await searchClusters('"tokat kaza"'))).toEqual(["t0", "t1"]);
    expect(fixture.rpcCalls).toHaveLength(1);
  });

  it("a query whose terms the locative does not change ('tokat') has no filter to run", async () => {
    fixture.rpcIdsPerCall = [["t0", "t1"]];
    fixture.data = [row("t0", "Zafer Kazandı"), row("t1", "Seçimi kazandı")];
    expect(idsOf(await searchClusters("tokat"))).toEqual(["t0", "t1"]);
    expect(fixture.rpcCalls).toHaveLength(1);
  });

  it("the locative second call keeps sending the locative as p_variants AND p_folded (the 166 guard reads p_folded only)", async () => {
    fixture.rpcIdsPerCall = [["t0"], ["l1"]];
    fixture.data = [row("t0", "Kaza"), row("l1", "Kazada ölü")];
    await searchClusters("tokat kaza");
    const second = fixture.rpcCalls[1] as RpcArgs;
    expect(second.p_variants).toEqual(turkishQueryVariants("tokat kazada"));
    expect(second.p_folded).toBe("tokat kazada");
  });
});

// h157-search-3: a one-letter hyphen compound gets the locative second call too.
describe("searchClusters: 'e-posta' and the locative of a hyphen compound (h157-search-3)", () => {
  type RpcArgs = { p_variants: string[]; p_folded?: string; p_limit: number };
  const row = (id: string, title: string) =>
    mkRow({ id, title_tr: title, members: [{ id: `a-${id}`, sourceId: "s1" }] });

  it("'e-posta' with a short typed page: the typed call, then the locative 'e-postada' as variants AND folded text", async () => {
    fixture.rpcIdsPerCall = [["t0"]];
    await searchClusters("e-posta");
    expect(searchSiblingQuery("e-posta")).toBeNull();
    expect(fixture.rpcCalls).toEqual([
      { p_variants: turkishQueryVariants("e-posta"), p_folded: "e-posta", p_limit: 24 },
      { p_variants: turkishQueryVariants("e-postada"), p_folded: "e-postada", p_limit: 24 },
    ]);
  });

  it("'e-okul' (consonant-final) with a short typed page makes ONE call", async () => {
    fixture.rpcIdsPerCall = [["t0"]];
    await searchClusters("e-okul");
    expect(fixture.rpcCalls).toEqual([
      { p_variants: turkishQueryVariants("e-okul"), p_folded: "e-okul", p_limit: 24 },
    ]);
  });

  it.each(["e-devlet", "f-16", "s-400", "ab-cdef", "e-po"])("%j makes one call", async (q) => {
    fixture.rpcIdsPerCall = [["t0"]];
    await searchClusters(q);
    expect(fixture.rpcCalls).toHaveLength(1);
  });

  it("the appended 'e-postayla' rows are kept (witness 'posta'), a row with no 'posta' word is dropped", async () => {
    fixture.rpcIdsPerCall = [["t0"], ["l1", "l2", "l3"]];
    fixture.data = [
      row("t0", "300 okul tahliye edildi"),
      row("l1", "Meloni, anonim e-postayla yapılan okul tehdidine tepki gösterdi"),
      row("l2", "Pentagon'un e-postaları"),
      row("l3", "Okul tehdidi"),
    ];
    const result = await searchClusters("e-posta");
    if (!result.ok) throw new Error("expected ok");
    expect(result.bundles.map((b) => b.cluster.id)).toEqual(["t0", "l1", "l2"]);
    expect(fixture.rpcCalls[1] as RpcArgs).toEqual({
      p_variants: turkishQueryVariants("e-postada"),
      p_folded: "e-postada",
      p_limit: 24,
    });
  });
});

// ---------------------------------------------------------------------------
// In-flight cap + single-flight (per instance). Cache entries are not modelled
// by the vitest build ("use cache" is a no-op there), so every call that is not
// de-duplicated by single-flight reaches the RPC; held RPCs make the overlap
// visible.
// ---------------------------------------------------------------------------

describe("searchClusters in-flight cap", () => {
  // Consonant-final words: a vowel-final word of 4 letters would add the second call of h144-search-1
  // and double every call count below, which these tests read one search at a time.
  const DISTINCT = ["alfan", "betan", "gaman", "deltan"];

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
    await expect(searchClusters("zetan")).resolves.toEqual({ ok: false });
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
    const queries = ["alfan", "betan", "gaman", "deltan", "epsilon", "zetan"];
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
    await searchClusters("alfan");
    await searchClusters("alfan");
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
    const running = ["alfan", "betan", "gaman", "deltan"].map((q) => searchClusters(q));
    const twin = searchClusters("ALFAN!");
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
    const a = searchClusters("alfan");
    const b = searchClusters("ALFAN");
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
    await expect(searchClusters("alfan")).resolves.toMatchObject({ ok: true });
    expect(fixture.rpcCalls).toHaveLength(1);
  });
});

describe("searchClusters live retry under load", () => {
  it("control: a lone failing search still does the live retry (2 RPC calls)", async () => {
    fixture.rpcThrows = true;
    await expect(searchClusters("alfan")).resolves.toEqual({ ok: false });
    expect(fixture.rpcCalls).toHaveLength(2);
  });

  it("skips the retry while saturated: A fails with ONE RPC, B/C/D unaffected", async () => {
    fixture.hold = true;
    const a = searchClusters("alfan");
    const others = ["betan", "gaman", "deltan"].map((q) => searchClusters(q));
    await tick();
    expect(fixture.rpcCalls).toHaveLength(4);

    fixture.deferreds[0]!.fail(new Error("rpc connection reset"));
    await expect(a).resolves.toEqual({ ok: false });

    const forA = (fixture.rpcCalls as Array<{ p_folded?: string }>).filter(
      (c) => c.p_folded === "alfan",
    );
    expect(forA).toHaveLength(1);
    expect(fixture.rpcCalls).toHaveLength(4);

    fixture.hold = false;
    for (const d of fixture.deferreds) d.succeed();
    for (const r of await Promise.all(others)) expect(r.ok).toBe(true);
  });

  it("retries again once a slot is free (3 in flight + the failing one is below the cap)", async () => {
    fixture.hold = true;
    const a = searchClusters("alfan");
    const others = ["betan", "gaman"].map((q) => searchClusters(q));
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

  it("holds back a flagged claim first published 1 h ago, like the home feed (h37-content-1)", async () => {
    feedHealth.getZoneFeedHealth.mockResolvedValue(null);
    fixture.rpcIds = ["young", "old"];
    const flagged = {
      is_blindspot: true,
      blindspot_side: "pro_government",
      bias_distribution: { pro_government: 9, opposition: 1 },
      members: [
        { id: "a1", sourceId: "s1" },
        { id: "a2", sourceId: "s2" },
      ],
    };
    fixture.data = [
      mkRow({ id: "young", first_published: new Date(Date.now() - 3_600_000).toISOString(), ...flagged }),
      mkRow({ id: "old", ...flagged }),
    ];
    const result = await searchClusters("deprem");
    if (!result.ok) throw new Error("expected ok");
    const byId = new Map(result.bundles.map((b) => [b.cluster.id, b.cluster]));
    expect(byId.get("young")?.is_blindspot).toBe(false);
    expect(byId.get("young")?.blindspot_side).toBeNull();
    expect(byId.get("old")?.is_blindspot).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// h170-roadmap-1: the archive can be paged to its 96 best matches (4 pages of 24).
// Page 1 is the search it always was; a later page is ONE call to migration 211's
// search_cluster_ids_v2 with page 1's typed arguments and p_offset (page - 1) * 24.
// ---------------------------------------------------------------------------

describe("searchClusters: archive pages (h170-roadmap-1)", () => {
  type V2Args = { p_variants: string[]; p_folded: string; p_limit: number; p_offset: number };
  const v2At = (i: number) => fixture.v2Calls[i] as V2Args;
  const ids = (n: number, prefix = "c") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  const rowsFor = (list: string[]) =>
    list.map((id) => mkRow({ id, members: [{ id: `a-${id}`, sourceId: "s1" }] }));

  it("the page constants the home page prints and parses are the ones this module serves", () => {
    expect(ARCHIVE_PAGE_SIZE).toBe(SEARCH_LIMIT);
    expect(ARCHIVE_MAX_PAGE).toBe(4);
  });

  describe("page 1 is untouched", () => {
    it("an explicit page 1 makes today's calls and never touches search_cluster_ids_v2", async () => {
      await searchClusters("IŞIK", 1);
      expect(fixture.rpcCalls).toEqual([{ p_variants: ["ışık", "işik", "işık"], p_folded: "isik", p_limit: 24 }]);
      expect(fixture.v2Calls).toEqual([]);
    });

    it("omitting the page and passing 1 are the same search: same calls, same result", async () => {
      fixture.rpcIdsPerCall = [["c1"], ["c1"]];
      fixture.data = rowsFor(["c1"]);
      const implicit = await searchClusters("trafik cezası");
      const callsImplicit = [...fixture.rpcCalls];
      fixture.rpcCalls = [];
      const explicit = await searchClusters("trafik cezası", 1);
      expect(fixture.rpcCalls).toEqual(callsImplicit);
      expect(explicit).toEqual(implicit);
      expect(fixture.v2Calls).toEqual([]);
    });

    it("a page that is not a whole number from 1 up is page 1 (the typed call, no v2 call)", async () => {
      for (const page of [0, -1, -24, Number.NaN, 1.5, 2.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MIN_SAFE_INTEGER]) {
        fixture.rpcCalls = [];
        await searchClusters("deprem", page);
        expect(fixture.rpcCalls, String(page)).toHaveLength(1);
        expect(fixture.v2Calls, String(page)).toEqual([]);
      }
    });

    it("keeps the one literal cacheLife per invocation: cluster-feed on a read", async () => {
      fixture.rpcIds = [];
      await searchClusters("merhaba", 1);
      expect(cacheLife).toHaveBeenCalledTimes(1);
      expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
      expect(cacheTag).toHaveBeenCalledWith("clusters-search");
    });

    it("typedFull: the typed call alone returned 24 ids", async () => {
      fixture.rpcIdsPerCall = [ids(24, "t")];
      fixture.data = rowsFor(ids(24, "t"));
      const result = await searchClusters("trafik cezası");
      if (!result.ok) throw new Error("expected ok");
      expect(result.typedFull).toBe(true);
      expect(result.capped).toBe(true);
      // a full typed page never makes the sibling call
      expect(fixture.rpcCalls).toHaveLength(1);
    });

    it("typedFull is not set when the sibling call filled the page, though the page is capped", async () => {
      fixture.rpcIdsPerCall = [ids(10, "t"), ids(24, "s")];
      fixture.data = rowsFor([...ids(10, "t"), ...ids(14, "s")]);
      const result = await searchClusters("trafik cezası");
      if (!result.ok) throw new Error("expected ok");
      expect(fixture.rpcCalls).toHaveLength(2);
      expect(result.capped).toBe(true);
      expect(result.bundles).toHaveLength(24);
      expect(result.typedFull).not.toBe(true);
    });

    it("typedFull is not set when the locative call filled the page", async () => {
      fixture.rpcIdsPerCall = [ids(5, "t"), ids(24, "l")];
      fixture.data = rowsFor([...ids(5, "t"), ...ids(19, "l")]);
      const result = await searchClusters("tarla");
      if (!result.ok) throw new Error("expected ok");
      expect(fixture.rpcCalls).toHaveLength(2);
      expect(result.typedFull).not.toBe(true);
    });

    it("typedFull is not set for fewer than 24 ids, and not for an empty result", async () => {
      for (const n of [0, 1, 23]) {
        fixture.rpcIds = ids(n);
        fixture.data = rowsFor(ids(n));
        const result = await searchClusters("deprem");
        if (!result.ok) throw new Error("expected ok");
        expect(result.typedFull, String(n)).not.toBe(true);
      }
    });
  });

  describe("a later page is one call to search_cluster_ids_v2", () => {
    it("page 2: ONE call with page 1's typed variants and folded text, p_limit 24 and p_offset 24", async () => {
      await searchClusters("IŞIK", 2);
      expect(fixture.v2Calls).toEqual([
        { p_variants: ["ışık", "işik", "işık"], p_folded: "isik", p_limit: 24, p_offset: 24 },
      ]);
      expect(fixture.rpcCalls).toEqual([]);
    });

    it("sends exactly page 1's typed arguments: the same p_variants and p_folded as the page-1 call", async () => {
      for (const q of ["Özel'den  Şişli", "Erdoğan’ın", "enflasyon", "AKP", "afyon"]) {
        fixture.rpcCalls = [];
        fixture.v2Calls = [];
        await searchClusters(q, 1);
        const typed = fixture.rpcCalls[0] as { p_variants: string[]; p_folded: string };
        await searchClusters(q, 2);
        expect(fixture.v2Calls, q).toHaveLength(1);
        expect(v2At(0).p_variants, q).toEqual(typed.p_variants);
        expect(v2At(0).p_folded, q).toBe(typed.p_folded);
      }
    });

    it("makes no sibling call for a possessive and no locative call for a bare vowel-final noun", async () => {
      for (const q of ["elektrik zammı", "emlak vergisi", "tarla", "bolu kaza", "imamoğluna"]) {
        fixture.rpcCalls = [];
        fixture.v2Calls = [];
        await searchClusters(q, 2);
        expect(fixture.rpcCalls, q).toEqual([]);
        expect(fixture.v2Calls, q).toHaveLength(1);
        // the typed words only: the sibling's words never reach a later page
        expect(v2At(0).p_folded, q).toBe(foldTr(canonicalSearchQuery(q)));
      }
    });

    it("page 3 sends p_offset 48 and page 4 sends p_offset 72", async () => {
      await searchClusters("deprem", 3);
      await searchClusters("deprem", 4);
      expect(fixture.v2Calls.map((c) => (c as V2Args).p_offset)).toEqual([48, 72]);
      expect(fixture.v2Calls.map((c) => (c as V2Args).p_limit)).toEqual([24, 24]);
    });

    it("a page past the last is the last page: 5, 9 and a huge page all send p_offset 72, never a larger one", async () => {
      for (const page of [5, 9, 1000, Number.MAX_SAFE_INTEGER]) {
        fixture.v2Calls = [];
        await searchClusters("deprem", page);
        expect(fixture.v2Calls, String(page)).toHaveLength(1);
        expect(v2At(0).p_offset, String(page)).toBe(72);
      }
    });

    it("the alias expansion reaches a later page as it reaches page 1: AKP and AK Parti send one expanded call", async () => {
      await searchClusters("AKP", 2);
      await searchClusters("AK Parti", 2);
      expect(fixture.v2Calls).toHaveLength(2);
      expect(v2At(0).p_variants).toEqual(v2At(1).p_variants);
      expect(v2At(0).p_folded).toBe(v2At(1).p_folded);
    });

    it("a too-short query is no search on any page: no call, no slot, no cache entry", async () => {
      for (const q of ["", "a", "!!", "  "]) {
        await expect(searchClusters(q, 2), q).resolves.toEqual({ ok: true, bundles: [] });
      }
      expect(fixture.v2Calls).toEqual([]);
      expect(fixture.rpcCalls).toEqual([]);
      expect(cacheLife).not.toHaveBeenCalled();
      expect(cacheTag).not.toHaveBeenCalled();
    });

    it("hydrates the ids in the RPC's order with the embed select, as page 1 does", async () => {
      fixture.v2Ids = ["b", "c", "a"];
      fixture.data = rowsFor(["a", "b", "c"]);
      const result = await searchClusters("deprem", 2);
      const state = fixture.lastState as BuilderState;
      expect(state.table).toBe("clusters");
      expect(state.in).toEqual([{ col: "id", vals: ["b", "c", "a"] }]);
      if (!result.ok) throw new Error("expected ok");
      expect(result.bundles.map((b) => b.cluster.id)).toEqual(["b", "c", "a"]);
    });

    it("drops a cluster with no visible member exactly as page 1 does", async () => {
      fixture.v2Ids = ["a", "empty", "b"];
      fixture.data = [
        mkRow({ id: "a", members: [{ id: "a-a", sourceId: "s1" }] }),
        mkRow({ id: "empty", members: [] }),
        mkRow({ id: "b", members: [{ id: "a-b", sourceId: "s1" }] }),
      ];
      fixture.rpcIds = ["a", "empty", "b"];
      const later = await searchClusters("deprem", 2);
      const first = await searchClusters("deprem", 1);
      if (!later.ok || !first.ok) throw new Error("expected ok");
      expect(later.bundles.map((b) => b.cluster.id)).toEqual(["a", "b"]);
      expect(later.bundles.map((b) => b.cluster.id)).toEqual(first.bundles.map((b) => b.cluster.id));
    });

    it("applies the feed-health gate to a later page like page 1 (one health read per page)", async () => {
      fixture.v2Ids = ["a"];
      fixture.data = rowsFor(["a"]);
      await searchClusters("deprem", 2);
      expect(feedHealth.getZoneFeedHealth).toHaveBeenCalledTimes(1);
    });

    it("capped is true when the v2 call returned a full page of 24 ids, false for fewer", async () => {
      fixture.v2Ids = ids(24);
      fixture.data = rowsFor(ids(24));
      const full = await searchClusters("deprem", 2);
      if (!full.ok) throw new Error("expected ok");
      expect(full.capped).toBe(true);
      expect(full.bundles).toHaveLength(24);

      fixture.v2Ids = ids(23);
      fixture.data = rowsFor(ids(23));
      const short = await searchClusters("enflasyon", 3);
      if (!short.ok) throw new Error("expected ok");
      expect(short.capped).toBe(false);
    });

    it("capped counts the ids, not the rows left after the visibility filter", async () => {
      fixture.v2Ids = ids(24);
      fixture.data = [...rowsFor(ids(23)), mkRow({ id: "c23", members: [] })];
      const result = await searchClusters("deprem", 2);
      if (!result.ok) throw new Error("expected ok");
      expect(result.capped).toBe(true);
      expect(result.bundles).toHaveLength(23);
    });

    it("a page past the end (no ids) is ok with no bundles, capped false, and no embed read", async () => {
      fixture.v2Ids = [];
      await expect(searchClusters("deprem", 4)).resolves.toEqual({ ok: true, bundles: [], capped: false });
      expect(fixture.lastState).toBeNull();
    });
  });

  describe("migration 211 not applied (PGRST202)", () => {
    it("page 2 resolves { ok: false, unavailablePage: true } without throwing, after ONE call and no live retry", async () => {
      fixture.v2Error = { message: "Could not find the function public.search_cluster_ids_v2", code: "PGRST202" };
      await expect(searchClusters("deprem", 2)).resolves.toEqual({ ok: false, unavailablePage: true });
      expect(fixture.v2Calls).toHaveLength(1);
      expect(fixture.rpcCalls).toEqual([]);
    });

    it("the unavailable page is memoised for 'minutes' only, so applying 211 heals it soon", async () => {
      fixture.v2Error = { message: "missing", code: "PGRST202" };
      await searchClusters("deprem", 3);
      expect(cacheLife).toHaveBeenCalledTimes(1);
      expect(cacheLife).toHaveBeenCalledWith("minutes");
      expect(cacheLife).not.toHaveBeenCalledWith("cluster-feed");
      expect(cacheTag).toHaveBeenCalledWith("clusters-search");
    });

    it("page 1 is unaffected: it never calls v2 and answers with its results", async () => {
      fixture.v2Error = { message: "missing", code: "PGRST202" };
      fixture.rpcIds = ["c1"];
      fixture.data = rowsFor(["c1"]);
      const result = await searchClusters("deprem", 1);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.bundles.map((b) => b.cluster.id)).toEqual(["c1"]);
      expect(result).not.toHaveProperty("unavailablePage");
      expect(fixture.v2Calls).toEqual([]);
      expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
    });

    it("page 1 stays healthy after a later page was unavailable (separate entries)", async () => {
      fixture.v2Error = { message: "missing", code: "PGRST202" };
      await searchClusters("deprem", 2);
      fixture.rpcIds = ["c1"];
      fixture.data = rowsFor(["c1"]);
      const first = await searchClusters("deprem");
      expect(first.ok).toBe(true);
    });

    it("any other error on v2 is the plain { ok: false } (no unavailablePage), with one live retry", async () => {
      fixture.v2Error = { message: "statement timeout", code: "57014" };
      const result = await searchClusters("deprem", 2);
      expect(result).toEqual({ ok: false });
      expect(result).not.toHaveProperty("unavailablePage");
      // the cached attempt and the live retry
      expect(fixture.v2Calls).toHaveLength(2);
      expect(cacheLife).toHaveBeenCalledTimes(1);
      expect(cacheLife).toHaveBeenCalledWith("minutes");
    });

    it("an error without a code, a throwing RPC and a failing embed are { ok: false } too, never a throw", async () => {
      fixture.v2Error = { message: "db down" };
      await expect(searchClusters("deprem", 2)).resolves.toEqual({ ok: false });
      fixture.v2Error = null;
      fixture.v2Throws = true;
      await expect(searchClusters("enflasyon", 2)).resolves.toEqual({ ok: false });
      fixture.v2Throws = false;
      fixture.v2Ids = ["c1"];
      fixture.error = { message: "embed down" };
      await expect(searchClusters("seçim", 2)).resolves.toEqual({ ok: false });
    });

    it("a successful later page keeps the cluster-feed window (one literal cacheLife per invocation)", async () => {
      fixture.v2Ids = ["c1"];
      fixture.data = rowsFor(["c1"]);
      await searchClusters("deprem", 2);
      expect(cacheLife).toHaveBeenCalledTimes(1);
      expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
      expect(cacheTag).toHaveBeenCalledWith("clusters-search");
    });
  });

  describe("cache key and load shape", () => {
    const SOURCE = readFileSync(resolve(__dirname, "search-query.ts"), "utf8");

    it("page 1 keeps its cache function and its one-argument key; a later page has a cache function of its own with the page in its key", () => {
      expect(SOURCE).toContain("async function cachedSearchClusters(key: string) {");
      expect(SOURCE).toContain("async function cachedSearchClustersPage(key: string, page: number) {");
      expect(SOURCE).toContain("cachedSearchClusters(key)");
      expect(SOURCE).toContain("cachedSearchClustersPage(key, page)");
    });

    it("each cached function keeps exactly one literal cacheLife per outcome, after the attempt, and cacheTag first", () => {
      expect(SOURCE.split('cacheLife("cluster-feed")').length - 1).toBe(2);
      expect(SOURCE.split('cacheLife("minutes")').length - 1).toBe(2);
      expect(SOURCE.split("cacheTag(\"clusters-search\")").length - 1).toBe(2);
      for (const name of ["cachedSearchClusters(key: string)", "cachedSearchClustersPage(key: string, page: number)"]) {
        const at = SOURCE.indexOf(name);
        const end = SOURCE.indexOf("\n}\n", at);
        const body = SOURCE.slice(at, end);
        expect(body.indexOf("cacheTag(")).toBeLessThan(body.indexOf("attemptCached("));
        expect(body.indexOf("attemptCached(")).toBeLessThan(body.indexOf("cacheLife("));
      }
    });

    it("the same canonical query on two pages is two searches; the same page twice is one (single-flight per page)", async () => {
      fixture.hold = true;
      fixture.rpcIds = ["c1"];
      fixture.v2Ids = ["c2"];
      fixture.data = rowsFor(["c1", "c2"]);
      const running = [
        searchClusters("deprem", 1),
        searchClusters("DEPREM!", 2),
        searchClusters("deprem", 2),
        searchClusters("deprem", 3),
        searchClusters("deprem", 3),
      ];
      await tick();
      expect(fixture.rpcCalls).toHaveLength(1);
      expect(fixture.v2Calls.map((c) => (c as V2Args).p_offset)).toEqual([24, 48]);
      fixture.hold = false;
      for (const d of fixture.deferreds) d.succeed();
      const results = await Promise.all(running);
      expect(results.every((r) => r.ok)).toBe(true);
    });

    it("a canonical query never holds the NUL that separates a later page's flight key, so no page-1 key can equal one", () => {
      for (const q of ["deprem\u00002", "deprem\u0000", "\u0000\u0000deprem", "deprem\u00002\u0000", "deprem\u0000\u0000"]) {
        expect(canonicalSearchQuery(q), JSON.stringify(q)).not.toContain("\u0000");
      }
    });

    it("'deprem' on page 2 and 'deprem 2' on page 1 are two searches, neither shared with the other", async () => {
      fixture.hold = true;
      const running = [searchClusters("deprem", 2), searchClusters("deprem 2", 1), searchClusters("deprem\u00002", 1)];
      await tick();
      // 'deprem' page 2 is the one v2 call; 'deprem 2' (and the NUL spelling of it, the same canonical key) one page-1 call
      expect(fixture.v2Calls).toHaveLength(1);
      expect(fixture.rpcCalls).toHaveLength(1);
      fixture.hold = false;
      for (const d of fixture.deferreds) d.succeed();
      await Promise.all(running);
    });

    it("MAX_IN_FLIGHT_SEARCHES applies to later pages: the 5th concurrent distinct search is shed with no RPC", async () => {
      fixture.hold = true;
      const running = ["alfan", "betan", "gaman", "deltan"].map((q) => searchClusters(q, 2));
      await tick();
      expect(fixture.v2Calls).toHaveLength(4);
      const tagCalls = vi.mocked(cacheTag).mock.calls.length;
      await expect(searchClusters("epsilon", 2)).resolves.toEqual({ ok: false });
      await expect(searchClusters("epsilon", 3)).resolves.toEqual({ ok: false });
      await expect(searchClusters("epsilon", 1)).resolves.toEqual({ ok: false });
      expect(fixture.v2Calls).toHaveLength(4);
      expect(fixture.rpcCalls).toEqual([]);
      // the shed never entered the cache boundary, so it can never be memoised
      expect(vi.mocked(cacheTag).mock.calls).toHaveLength(tagCalls);
      fixture.hold = false;
      for (const d of fixture.deferreds) d.succeed();
      await Promise.all(running);
    });

    it("page 1 and later pages share the same slots (3 page-1 searches and 1 page-2 search fill the cap)", async () => {
      fixture.hold = true;
      const running = [
        searchClusters("alfan", 1),
        searchClusters("betan", 1),
        searchClusters("gaman", 1),
        searchClusters("deltan", 2),
      ];
      await tick();
      expect(fixture.rpcCalls).toHaveLength(3);
      expect(fixture.v2Calls).toHaveLength(1);
      await expect(searchClusters("epsilon", 4)).resolves.toEqual({ ok: false });
      await expect(searchClusters("epsilon", 1)).resolves.toEqual({ ok: false });
      fixture.hold = false;
      for (const d of fixture.deferreds) d.succeed();
      await Promise.all(running);
    });

    it("releases the slot of a later page after success and after a failure", async () => {
      fixture.v2Throws = true;
      for (const q of ["alfan", "betan", "gaman", "deltan", "epsilon", "zetan"]) {
        await expect(searchClusters(q, 2), q).resolves.toEqual({ ok: false });
      }
      fixture.v2Throws = false;
      await expect(searchClusters("eta", 2)).resolves.toMatchObject({ ok: true });
    });
  });
});
