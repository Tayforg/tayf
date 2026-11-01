import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// S-18 (/duzeltmeler). Mirrors src/lib/quality/snapshots.test.ts: the shared
// chainable Supabase fake (tests/_helpers/supabase-fake.ts) plus a mocked
// next/cache so the "use cache" directive's cacheLife/cacheTag calls don't
// throw outside a real Next.js request scope.
//
// The privacy contract is the point of this suite: the reader's `message`
// and `email` columns must never leave the database, so the select string is
// pinned both as a constant and as the value the fake actually recorded.
//
// The log names WHAT each correction was about (a cluster, a source label, or
// nothing specific) without ever publishing the reader's submitted `url`: the
// url is selected for server-side derivation only, and the "privacy pin"
// block asserts that the shaped objects carry a closed key set and that no
// submitted url string survives into the serialised result.
//
// 2026-10-24 /sources '—' incident: a failed read used to be cached for the
// full 1 h `source-directory` life (cacheLife ran before the query). The
// "cache lifetime" block at the end pins the fix: a failure is memoised for
// `minutes` only.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const fixture = vi.hoisted(() => ({
  data: [] as unknown[],
  error: null as { message: string } | null,
  lastState: null as unknown,
  throwOnQuery: false,
  // Lookup tables for url-derived subjects (rows whose cluster_id is null).
  sources: [] as Array<{ slug: string; name: string }>,
  clusters: [] as Array<{
    id: string;
    title_tr: string | null;
    title_tr_neutral: string | null;
  }>,
  sourcesError: null as { message: string } | null,
  clustersError: null as { message: string } | null,
  sourcesState: null as unknown,
  clustersState: null as unknown,
  // Every table the SUT awaited, in order — proves lookups are skipped.
  tablesQueried: [] as string[],
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      corrections: (state) => {
        fixture.tablesQueried.push("corrections");
        fixture.lastState = state;
        if (fixture.throwOnQuery) throw new Error("connection reset");
        if (fixture.error) return { data: null, error: fixture.error };
        return { data: fixture.data, error: null };
      },
      // select 'slug, name', honouring .in('slug', [...]).
      sources: (state) => {
        fixture.tablesQueried.push("sources");
        fixture.sourcesState = state;
        if (fixture.sourcesError) return { data: null, error: fixture.sourcesError };
        const wanted = state.in.find((f) => f.col === "slug")?.vals ?? [];
        return {
          data: fixture.sources
            .filter((r) => wanted.includes(r.slug))
            .map(({ slug, name }) => ({ slug, name })),
          error: null,
        };
      },
      // select 'id, title_tr, title_tr_neutral', honouring .in('id', [...]).
      clusters: (state) => {
        fixture.tablesQueried.push("clusters");
        fixture.clustersState = state;
        if (fixture.clustersError) return { data: null, error: fixture.clustersError };
        const wanted = state.in.find((f) => f.col === "id")?.vals ?? [];
        return {
          data: fixture.clusters.filter((r) => wanted.includes(r.id)),
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
  clusterIdFromUrl,
  deriveSubject,
  getPublicCorrections,
  PUBLIC_LOG_SELECT,
  shapePublicCorrections,
  sourceSlugFromUrl,
  type PublicLogLookups,
} from "./public-log";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.data = [];
  fixture.error = null;
  fixture.lastState = null;
  fixture.throwOnQuery = false;
  fixture.sources = [];
  fixture.clusters = [];
  fixture.sourcesError = null;
  fixture.clustersError = null;
  fixture.sourcesState = null;
  fixture.clustersState = null;
  fixture.tablesQueried = [];
  vi.mocked(cacheLife).mockClear();
  vi.mocked(cacheTag).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
  vi.restoreAllMocks();
});

function state(): BuilderState {
  return fixture.lastState as BuilderState;
}

describe("PUBLIC_LOG_SELECT", () => {
  it("never selects the reader's email or message", () => {
    expect(PUBLIC_LOG_SELECT).not.toMatch(/email|message/);
  });

  it("selects only the public columns plus the cluster embed", () => {
    expect(PUBLIC_LOG_SELECT).toContain("id");
    expect(PUBLIC_LOG_SELECT).toContain("cluster_id");
    expect(PUBLIC_LOG_SELECT).toContain("created_at");
    expect(PUBLIC_LOG_SELECT).toContain("reviewed_at");
    expect(PUBLIC_LOG_SELECT).toContain("clusters");
  });

  it("selects `url` (server-side subject derivation only) and still never email or message", () => {
    expect(PUBLIC_LOG_SELECT).toMatch(/\burl\b/);
    expect(PUBLIC_LOG_SELECT).not.toMatch(/email|message/);
  });
});

describe("getPublicCorrections", () => {
  it("queries only reviewed corrections, newest review first, capped at 100", async () => {
    await getPublicCorrections();

    expect(state().table).toBe("corrections");
    expect(state().eq).toEqual([{ col: "status", val: "reviewed" }]);
    expect(state().order).toEqual([
      { col: "reviewed_at", opts: { ascending: false, nullsFirst: false } },
      { col: "created_at", opts: { ascending: false } },
    ]);
    expect(state().limit).toBe(100);
  });

  it("sorts un-stamped (pre-042) reviewed rows last, not first", async () => {
    // Postgres defaults DESC to NULLS FIRST; without nullsFirst: false a
    // pre-042 row with a null `reviewed_at` would head the page.
    await getPublicCorrections();

    const reviewedAt = state().order.find((o) => o.col === "reviewed_at");
    expect(
      (reviewedAt?.opts as { nullsFirst?: boolean } | undefined)?.nullsFirst,
    ).toBe(false);
    // ...and the tiebreak keeps the order stable for equal stamps.
    expect(state().order[1]?.col).toBe("created_at");
  });

  it("honours an explicit limit", async () => {
    await getPublicCorrections(5);

    expect(state().limit).toBe(5);
  });

  it("never sends email or message over the wire", async () => {
    await getPublicCorrections();

    const recorded = String(state().selectArgs[0]);
    expect(recorded).toBe(PUBLIC_LOG_SELECT);
    expect(recorded).not.toMatch(/email|message/);
  });

  it("maps rows when the cluster embed comes back as an object", async () => {
    fixture.data = [
      {
        id: "c1",
        cluster_id: "k1",
        url: "https://www.tayfhaber.com/cluster/k1",
        created_at: "2026-09-10T08:00:00.000Z",
        reviewed_at: "2026-09-11T09:30:00.000Z",
        cluster: {
          id: "k1",
          title_tr: "Ham başlık",
          title_tr_neutral: "Nötr başlık",
        },
      },
    ];

    const rows = await getPublicCorrections();

    expect(rows).toEqual([
      {
        id: "c1",
        subject: { kind: "cluster", clusterId: "k1", title: "Nötr başlık" },
        createdAt: "2026-09-10T08:00:00.000Z",
        reviewedAt: "2026-09-11T09:30:00.000Z",
      },
    ]);
  });

  it("maps rows when the cluster embed comes back as a one-element array", async () => {
    fixture.data = [
      {
        id: "c2",
        cluster_id: "k2",
        url: "https://www.tayfhaber.com/cluster/k2",
        created_at: "2026-09-10T08:00:00.000Z",
        reviewed_at: null,
        cluster: [{ id: "k2", title_tr: "Ham başlık", title_tr_neutral: null }],
      },
    ];

    const rows = await getPublicCorrections();

    expect(rows).toEqual([
      {
        id: "c2",
        subject: { kind: "cluster", clusterId: "k2", title: "Ham başlık" },
        createdAt: "2026-09-10T08:00:00.000Z",
        reviewedAt: null,
      },
    ]);
  });

  it("reports cluster_gone when cluster_id is set but the embed is null", async () => {
    fixture.data = [
      {
        id: "c3",
        cluster_id: "k3",
        url: "https://www.tayfhaber.com/cluster/k3",
        created_at: "2026-09-10T08:00:00.000Z",
        reviewed_at: "2026-09-12T10:00:00.000Z",
        cluster: null,
      },
    ];

    const rows = await getPublicCorrections();

    expect(rows).toEqual([
      {
        id: "c3",
        subject: { kind: "cluster_gone" },
        createdAt: "2026-09-10T08:00:00.000Z",
        reviewedAt: "2026-09-12T10:00:00.000Z",
      },
    ]);
  });

  it("drops the reader's message and email even if PostgREST returns them", async () => {
    fixture.data = [
      {
        id: "c4",
        cluster_id: "k4",
        url: "https://www.tayfhaber.com/cluster/k4",
        created_at: "2026-09-10T08:00:00.000Z",
        reviewed_at: "2026-09-12T10:00:00.000Z",
        message: "başlık yanlış, kaynak şu",
        email: "okur@example.com",
        cluster: { id: "k4", title_tr: "Ham", title_tr_neutral: "Nötr" },
      },
    ];

    const rows = await getPublicCorrections();

    expect(JSON.stringify(rows)).not.toMatch(/okur@example\.com|yanlış/);
    expect(Object.keys(rows![0])).toEqual([
      "id",
      "subject",
      "createdAt",
      "reviewedAt",
    ]);
  });

  it("returns an empty array when there is nothing reviewed yet", async () => {
    fixture.data = [];

    await expect(getPublicCorrections()).resolves.toEqual([]);
  });

  it("returns an empty array when PostgREST returns null data without an error", async () => {
    fixture.data = [];
    fixture.error = null;

    await expect(getPublicCorrections()).resolves.toEqual([]);
  });

  it("returns null (never throws) when the query errors", async () => {
    fixture.error = { message: "permission denied for table corrections" };

    await expect(getPublicCorrections()).resolves.toBeNull();
    expect(console.error).toHaveBeenCalled();
  });

  it("returns null (never throws) when the client blows up", async () => {
    fixture.throwOnQuery = true;

    await expect(getPublicCorrections()).resolves.toBeNull();
    expect(console.error).toHaveBeenCalled();
  });
});

describe("getPublicCorrections cache lifetime", () => {
  it("a Supabase error resolves null and is cached for minutes only (exactly one cacheLife)", async () => {
    fixture.error = { message: "permission denied for table corrections" };

    await expect(getPublicCorrections()).resolves.toBeNull();

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("source-directory");
  });

  it("a thrown query resolves null and is cached for minutes only (exactly one cacheLife)", async () => {
    fixture.throwOnQuery = true;

    await expect(getPublicCorrections()).resolves.toBeNull();

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("source-directory");
  });

  it("missing Supabase env resolves null and is cached for minutes only", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    await expect(getPublicCorrections()).resolves.toBeNull();

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("logs a failed attempt once through attemptCached, without the reader's message or email", async () => {
    fixture.error = { message: "connection refused" };

    await getPublicCorrections();

    expect(console.error).toHaveBeenCalledTimes(1);
    const logged = String(vi.mocked(console.error).mock.calls[0]![0]);
    expect(logged).toMatch(/^\[[a-z-]+\] error: .*connection refused/);
    expect(logged).not.toMatch(/email|message/i);
  });

  it("success returns the rows and is cached for source-directory, once", async () => {
    fixture.data = [
      {
        id: "c1",
        cluster_id: "k1",
        created_at: "2026-09-10T08:00:00.000Z",
        reviewed_at: "2026-09-11T09:30:00.000Z",
        cluster: { id: "k1", title_tr: "Ham", title_tr_neutral: "Nötr" },
      },
    ];

    const rows = await getPublicCorrections();

    expect(rows).toHaveLength(1);
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("source-directory");
    expect(cacheLife).not.toHaveBeenCalledWith("minutes");
    expect(console.error).not.toHaveBeenCalled();
  });

  it("an empty successful log returns [] (not null) and keeps source-directory", async () => {
    fixture.data = [];

    await expect(getPublicCorrections()).resolves.toEqual([]);

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("source-directory");
  });

  it("tags the entry 'corrections' before cacheLife runs (cacheTag precedes cacheLife), on success and failure", async () => {
    await getPublicCorrections();
    expect(cacheTag).toHaveBeenCalledWith("corrections");
    expect(vi.mocked(cacheTag).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(cacheLife).mock.invocationCallOrder[0]!,
    );

    vi.mocked(cacheTag).mockClear();
    vi.mocked(cacheLife).mockClear();
    fixture.error = { message: "boom" };
    await getPublicCorrections();
    expect(cacheTag).toHaveBeenCalledWith("corrections");
    expect(vi.mocked(cacheTag).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(cacheLife).mock.invocationCallOrder[0]!,
    );
  });

  it("the limit stays an argument of the cached read (an explicit limit reaches the query on both outcomes)", async () => {
    await getPublicCorrections(7);
    expect(state().limit).toBe(7);

    fixture.error = { message: "boom" };
    await expect(getPublicCorrections(7)).resolves.toBeNull();
    expect(state().limit).toBe(7);
    expect(cacheLife).toHaveBeenLastCalledWith("minutes");
  });
});

// ---------------------------------------------------------------------------
// Subject derivation. `url` is the reader's submitted page address; it is used
// here, server-side, to work out WHAT the correction was about, and is then
// discarded. Only tayfhaber.com / www.tayfhaber.com addresses are trusted for
// this; anything else is "general".
// ---------------------------------------------------------------------------

const UUID = "11111111-2222-3333-4444-555555555555";
const UUID_2 = "99999999-8888-7777-6666-555555555555";

const NO_LOOKUPS: PublicLogLookups = {
  sources: new Map(),
  clusters: new Map(),
};

function lookups(partial: {
  sources?: Array<[string, string]>;
  clusters?: Array<[string, string | null]>;
}): PublicLogLookups {
  return {
    sources: new Map(partial.sources ?? []),
    clusters: new Map(partial.clusters ?? []),
  };
}

function rawRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "r1",
    cluster_id: null,
    url: "https://www.tayfhaber.com/metodoloji",
    created_at: "2026-09-10T08:00:00.000Z",
    reviewed_at: "2026-09-11T09:30:00.000Z",
    cluster: null,
    ...overrides,
  };
}

describe("sourceSlugFromUrl", () => {
  it.each([
    ["https://www.tayfhaber.com/source/sozcu", "sozcu"],
    ["https://tayfhaber.com/source/sozcu", "sozcu"],
    ["http://www.tayfhaber.com/source/sozcu", "sozcu"],
    ["https://www.tayfhaber.com/source/sozcu/", "sozcu"],
    ["https://www.tayfhaber.com/source/sozcu?utm_source=x#bolum", "sozcu"],
    ["https://www.tayfhaber.com/source/bbc-turkce", "bbc-turkce"],
    ["https://www.tayfhaber.com/source/t24", "t24"],
  ])("extracts the slug from %s", (url, slug) => {
    expect(sourceSlugFromUrl(url)).toBe(slug);
  });

  it.each([
    "https://evil.com/source/sozcu",
    "https://www.tayfhaber.com.evil.com/source/sozcu",
    "https://evil.com/?u=https://www.tayfhaber.com/source/sozcu",
    "https://sub.tayfhaber.com/source/sozcu",
    "https://www.tayfhaber.com:8443/source/sozcu",
    "ftp://www.tayfhaber.com/source/sozcu",
    "https://www.tayfhaber.com/metodoloji",
    "https://www.tayfhaber.com/source/",
    "https://www.tayfhaber.com/source/sozcu/extra",
    "https://www.tayfhaber.com/source/Sozcu",
    "https://www.tayfhaber.com/source/-sozcu",
    "https://www.tayfhaber.com/source/soz_cu",
    `https://www.tayfhaber.com/source/${"a".repeat(65)}`,
    "https://www.tayfhaber.com/cluster/" + UUID,
    "not a url",
    "",
  ])("returns null for %s", (url) => {
    expect(sourceSlugFromUrl(url)).toBeNull();
  });

  it("accepts a 64-character slug (the upper bound)", () => {
    const slug = "a".repeat(64);
    expect(sourceSlugFromUrl(`https://tayfhaber.com/source/${slug}`)).toBe(slug);
  });

  it("returns null for non-string input instead of throwing", () => {
    expect(sourceSlugFromUrl(undefined as unknown as string)).toBeNull();
    expect(sourceSlugFromUrl(null as unknown as string)).toBeNull();
  });
});

describe("clusterIdFromUrl", () => {
  it.each([
    [`https://www.tayfhaber.com/cluster/${UUID}`, UUID],
    [`https://tayfhaber.com/cluster/${UUID}`, UUID],
    [`https://tayfhaber.com/cluster/${UUID}/`, UUID],
    [`https://tayfhaber.com/cluster/${UUID}?utm_source=x#haberler`, UUID],
  ])("extracts the id from %s", (url, id) => {
    expect(clusterIdFromUrl(url)).toBe(id);
  });

  it("lower-cases the id so it matches what Postgres returns", () => {
    expect(
      clusterIdFromUrl(`https://tayfhaber.com/cluster/${UUID.toUpperCase()}`),
    ).toBe(UUID);
  });

  it.each([
    `https://evil.com/cluster/${UUID}`,
    `https://www.tayfhaber.com.evil.com/cluster/${UUID}`,
    `https://www.tayfhaber.com:8443/cluster/${UUID}`,
    `ftp://tayfhaber.com/cluster/${UUID}`,
    "https://tayfhaber.com/cluster/abc",
    "https://tayfhaber.com/cluster/",
    `https://tayfhaber.com/cluster/${UUID}/extra`,
    `https://tayfhaber.com/cluster/${UUID}x`,
    "https://tayfhaber.com/source/sozcu",
    "https://tayfhaber.com/metodoloji",
    "not a url",
    "",
  ])("returns null for %s", (url) => {
    expect(clusterIdFromUrl(url)).toBeNull();
  });

  it("returns null for non-string input instead of throwing", () => {
    expect(clusterIdFromUrl(undefined as unknown as string)).toBeNull();
  });
});

describe("deriveSubject", () => {
  it("cluster_id set and the embed has a title -> cluster", () => {
    expect(
      deriveSubject(
        rawRow({
          cluster_id: UUID,
          cluster: { id: UUID, title_tr: "Ham", title_tr_neutral: "Nötr" },
        }),
        NO_LOOKUPS,
      ),
    ).toEqual({ kind: "cluster", clusterId: UUID, title: "Nötr" });
  });

  it("prefers the neutral title and falls back to the raw title", () => {
    expect(
      deriveSubject(
        rawRow({
          cluster_id: UUID,
          cluster: { id: UUID, title_tr: "Ham", title_tr_neutral: null },
        }),
        NO_LOOKUPS,
      ),
    ).toEqual({ kind: "cluster", clusterId: UUID, title: "Ham" });
  });

  it("uses a placeholder title when the embed exists but carries no title", () => {
    expect(
      deriveSubject(
        rawRow({
          cluster_id: UUID,
          cluster: { id: UUID, title_tr: null, title_tr_neutral: "" },
        }),
        NO_LOOKUPS,
      ),
    ).toEqual({ kind: "cluster", clusterId: UUID, title: "Başlıksız küme" });
  });

  it("cluster_id set but the embed is null -> cluster_gone", () => {
    expect(
      deriveSubject(rawRow({ cluster_id: UUID, cluster: null }), NO_LOOKUPS),
    ).toEqual({ kind: "cluster_gone" });
  });

  it("cluster_id set but the embed is an empty array -> cluster_gone", () => {
    expect(
      deriveSubject(rawRow({ cluster_id: UUID, cluster: [] }), NO_LOOKUPS),
    ).toEqual({ kind: "cluster_gone" });
  });

  it("cluster_id wins over a source url", () => {
    expect(
      deriveSubject(
        rawRow({
          cluster_id: UUID,
          url: "https://www.tayfhaber.com/source/sozcu",
          cluster: { id: UUID, title_tr: "Ham", title_tr_neutral: null },
        }),
        lookups({ sources: [["sozcu", "Sözcü"]] }),
      ),
    ).toEqual({ kind: "cluster", clusterId: UUID, title: "Ham" });
  });

  it("cluster_id null + source url + the source exists -> source", () => {
    expect(
      deriveSubject(
        rawRow({ url: "https://www.tayfhaber.com/source/sozcu" }),
        lookups({ sources: [["sozcu", "Sözcü"]] }),
      ),
    ).toEqual({ kind: "source", slug: "sozcu", name: "Sözcü" });
  });

  it("cluster_id null + source url + an unknown slug -> general", () => {
    expect(
      deriveSubject(
        rawRow({ url: "https://www.tayfhaber.com/source/sozcu" }),
        NO_LOOKUPS,
      ),
    ).toEqual({ kind: "general" });
  });

  it("cluster_id null + cluster url + the cluster is found -> cluster", () => {
    expect(
      deriveSubject(
        rawRow({ url: `https://tayfhaber.com/cluster/${UUID}` }),
        lookups({ clusters: [[UUID, "Asgari ücret"]] }),
      ),
    ).toEqual({ kind: "cluster", clusterId: UUID, title: "Asgari ücret" });
  });

  it("cluster_id null + cluster url + the cluster is found without a title -> placeholder title", () => {
    expect(
      deriveSubject(
        rawRow({ url: `https://tayfhaber.com/cluster/${UUID}` }),
        lookups({ clusters: [[UUID, null]] }),
      ),
    ).toEqual({ kind: "cluster", clusterId: UUID, title: "Başlıksız küme" });
  });

  it("cluster_id null + cluster url + the cluster is not found -> cluster_gone", () => {
    expect(
      deriveSubject(
        rawRow({ url: `https://tayfhaber.com/cluster/${UUID}` }),
        lookups({ clusters: [[UUID_2, "Başka küme"]] }),
      ),
    ).toEqual({ kind: "cluster_gone" });
  });

  it("an upper-case cluster url still resolves against the lower-case lookup key", () => {
    expect(
      deriveSubject(
        rawRow({ url: `https://tayfhaber.com/cluster/${UUID.toUpperCase()}` }),
        lookups({ clusters: [[UUID, "Asgari ücret"]] }),
      ),
    ).toEqual({ kind: "cluster", clusterId: UUID, title: "Asgari ücret" });
  });

  it.each([
    "https://evil.com/source/x",
    "https://evil.com/source/sozcu",
    `https://evil.com/cluster/${UUID}`,
    "https://www.tayfhaber.com/metodoloji",
    "https://www.tayfhaber.com/",
    "not a url",
    "",
  ])("a third-party or unrelated url (%s) -> general, even if lookups would match", (url) => {
    expect(
      deriveSubject(
        rawRow({ url }),
        lookups({
          sources: [["sozcu", "Sözcü"], ["x", "X"]],
          clusters: [[UUID, "Asgari ücret"]],
        }),
      ),
    ).toEqual({ kind: "general" });
  });

  it("a missing url -> general", () => {
    expect(deriveSubject(rawRow({ url: undefined }), NO_LOOKUPS)).toEqual({
      kind: "general",
    });
  });
});

describe("shapePublicCorrections", () => {
  it("skips rows without an id or a created_at", () => {
    const shaped = shapePublicCorrections(
      [
        rawRow({ id: "", created_at: "2026-09-10T08:00:00.000Z" }),
        rawRow({ id: "ok", created_at: null }),
        rawRow({ id: "kept" }),
      ],
      NO_LOOKUPS,
    );
    expect(shaped.map((r) => r.id)).toEqual(["kept"]);
  });

  it("returns [] for no rows", () => {
    expect(shapePublicCorrections([], NO_LOOKUPS)).toEqual([]);
  });

  it("keeps the reviewedAt stamp, or null when un-stamped", () => {
    const shaped = shapePublicCorrections(
      [rawRow({ id: "a" }), rawRow({ id: "b", reviewed_at: null })],
      NO_LOOKUPS,
    );
    expect(shaped.map((r) => r.reviewedAt)).toEqual([
      "2026-09-11T09:30:00.000Z",
      null,
    ]);
  });
});

describe("privacy pin: the submitted url never leaves the module", () => {
  const SUBMITTED_URLS = [
    "https://www.tayfhaber.com/source/sozcu?utm_source=SECRETQUERY#SECRETHASH",
    `https://tayfhaber.com/cluster/${UUID}?ref=SECRETQUERY#SECRETHASH`,
    "https://evil.com/source/x?token=SECRETQUERY",
    "https://www.tayfhaber.com/metodoloji?next=SECRETQUERY",
    "https://example.org/some/private/path",
  ];

  function allKinds() {
    return shapePublicCorrections(
      [
        // cluster via embed
        rawRow({
          id: "a",
          cluster_id: UUID,
          url: SUBMITTED_URLS[1],
          cluster: { id: UUID, title_tr: "Ham", title_tr_neutral: "Nötr" },
        }),
        // cluster_gone via embed
        rawRow({ id: "b", cluster_id: UUID_2, url: SUBMITTED_URLS[1], cluster: null }),
        // source via url
        rawRow({ id: "c", url: SUBMITTED_URLS[0] }),
        // cluster via url
        rawRow({ id: "d", url: SUBMITTED_URLS[1] }),
        // general: third party, unrelated page, off-site
        rawRow({ id: "e", url: SUBMITTED_URLS[2] }),
        rawRow({ id: "f", url: SUBMITTED_URLS[3] }),
        rawRow({ id: "g", url: SUBMITTED_URLS[4] }),
      ],
      lookups({
        sources: [["sozcu", "Sözcü"]],
        clusters: [[UUID, "Asgari ücret"]],
      }),
    );
  }

  it("every shaped object has exactly the keys id, subject, createdAt, reviewedAt", () => {
    const shaped = allKinds();
    expect(shaped.map((r) => r.subject.kind)).toEqual([
      "cluster",
      "cluster_gone",
      "source",
      "cluster",
      "general",
      "general",
      "general",
    ]);
    for (const row of shaped) {
      expect(Object.keys(row)).toEqual(["id", "subject", "createdAt", "reviewedAt"]);
    }
  });

  it("no submitted url, query or fragment appears in the serialised result", () => {
    const json = JSON.stringify(allKinds());
    for (const url of SUBMITTED_URLS) expect(json).not.toContain(url);
    expect(json).not.toMatch(/SECRETQUERY|SECRETHASH|evil\.com|example\.org|tayfhaber\.com/);
    expect(json).not.toMatch(/https?:\/\//);
  });

  it("a source subject carries only slug and name; a cluster subject only clusterId and title", () => {
    const shaped = allKinds();
    expect(Object.keys(shaped[2]!.subject)).toEqual(["kind", "slug", "name"]);
    expect(Object.keys(shaped[0]!.subject)).toEqual(["kind", "clusterId", "title"]);
    expect(Object.keys(shaped[3]!.subject)).toEqual(["kind", "clusterId", "title"]);
  });

  it("holds end to end through getPublicCorrections, with message and email smuggled in too", async () => {
    fixture.sources = [{ slug: "sozcu", name: "Sözcü" }];
    fixture.clusters = [
      { id: UUID, title_tr: "Ham", title_tr_neutral: "Nötr" },
    ];
    fixture.data = [
      rawRow({
        id: "c",
        url: SUBMITTED_URLS[0],
        message: "SECRETMESSAGE",
        email: "okur@example.com",
      }),
      rawRow({
        id: "d",
        url: SUBMITTED_URLS[1],
        message: "SECRETMESSAGE",
        email: "okur@example.com",
      }),
      rawRow({ id: "e", url: SUBMITTED_URLS[2] }),
    ];

    const rows = await getPublicCorrections();

    expect(rows).toHaveLength(3);
    for (const row of rows!) {
      expect(Object.keys(row)).toEqual(["id", "subject", "createdAt", "reviewedAt"]);
    }
    const json = JSON.stringify(rows);
    for (const url of SUBMITTED_URLS) expect(json).not.toContain(url);
    expect(json).not.toMatch(/SECRETQUERY|SECRETHASH|SECRETMESSAGE|okur@example\.com/);
  });
});

// ---------------------------------------------------------------------------
// Lookups: a url-derived subject needs the sources / clusters tables. At most
// two extra queries, only when some row actually needs them.
// ---------------------------------------------------------------------------

describe("getPublicCorrections subject lookups", () => {
  it("names a source from its /source/<slug> url (one sources lookup, no clusters lookup)", async () => {
    fixture.sources = [
      { slug: "sozcu", name: "Sözcü" },
      { slug: "other", name: "Başka" },
    ];
    fixture.data = [
      rawRow({ id: "s1", url: "https://www.tayfhaber.com/source/sozcu" }),
    ];

    const rows = await getPublicCorrections();

    expect(rows).toEqual([
      {
        id: "s1",
        subject: { kind: "source", slug: "sozcu", name: "Sözcü" },
        createdAt: "2026-09-10T08:00:00.000Z",
        reviewedAt: "2026-09-11T09:30:00.000Z",
      },
    ]);
    expect(fixture.tablesQueried).toEqual(["corrections", "sources"]);
    const st = fixture.sourcesState as BuilderState;
    expect(st.selectArgs).toEqual(["slug, name"]);
    expect(st.in).toEqual([{ col: "slug", vals: ["sozcu"] }]);
  });

  it("de-duplicates slugs across rows into a single .in('slug', ...) filter", async () => {
    fixture.sources = [
      { slug: "sozcu", name: "Sözcü" },
      { slug: "t24", name: "T24" },
    ];
    fixture.data = [
      rawRow({ id: "s1", url: "https://www.tayfhaber.com/source/sozcu" }),
      rawRow({ id: "s2", url: "https://tayfhaber.com/source/sozcu/" }),
      rawRow({ id: "s3", url: "https://tayfhaber.com/source/t24?x=1" }),
    ];

    const rows = await getPublicCorrections();

    expect(fixture.tablesQueried.filter((t) => t === "sources")).toHaveLength(1);
    expect((fixture.sourcesState as BuilderState).in).toEqual([
      { col: "slug", vals: ["sozcu", "t24"] },
    ]);
    expect(rows!.map((r) => r.subject)).toEqual([
      { kind: "source", slug: "sozcu", name: "Sözcü" },
      { kind: "source", slug: "sozcu", name: "Sözcü" },
      { kind: "source", slug: "t24", name: "T24" },
    ]);
  });

  it("an unknown slug resolves to a general subject", async () => {
    fixture.sources = [{ slug: "sozcu", name: "Sözcü" }];
    fixture.data = [
      rawRow({ id: "s1", url: "https://www.tayfhaber.com/source/yok-boyle-kaynak" }),
    ];

    const rows = await getPublicCorrections();

    expect(rows![0]!.subject).toEqual({ kind: "general" });
  });

  it("names a cluster from its /cluster/<uuid> url when cluster_id was lost (one clusters lookup, no sources lookup)", async () => {
    fixture.clusters = [
      { id: UUID, title_tr: "Ham", title_tr_neutral: "Nötr" },
      { id: UUID_2, title_tr: "Başka", title_tr_neutral: null },
    ];
    fixture.data = [
      rawRow({ id: "k1", url: `https://www.tayfhaber.com/cluster/${UUID}` }),
    ];

    const rows = await getPublicCorrections();

    expect(rows![0]!.subject).toEqual({
      kind: "cluster",
      clusterId: UUID,
      title: "Nötr",
    });
    expect(fixture.tablesQueried).toEqual(["corrections", "clusters"]);
    const st = fixture.clustersState as BuilderState;
    expect(st.selectArgs).toEqual(["id, title_tr, title_tr_neutral"]);
    expect(st.in).toEqual([{ col: "id", vals: [UUID] }]);
  });

  it("a cluster url whose cluster no longer exists resolves to cluster_gone", async () => {
    fixture.clusters = [];
    fixture.data = [
      rawRow({ id: "k1", url: `https://www.tayfhaber.com/cluster/${UUID}` }),
    ];

    const rows = await getPublicCorrections();

    expect(rows![0]!.subject).toEqual({ kind: "cluster_gone" });
  });

  it("runs both lookups (at most two extra queries) when rows need both", async () => {
    fixture.sources = [{ slug: "sozcu", name: "Sözcü" }];
    fixture.clusters = [{ id: UUID, title_tr: "Ham", title_tr_neutral: null }];
    fixture.data = [
      rawRow({ id: "s1", url: "https://www.tayfhaber.com/source/sozcu" }),
      rawRow({ id: "k1", url: `https://www.tayfhaber.com/cluster/${UUID}` }),
      rawRow({ id: "g1", url: "https://www.tayfhaber.com/metodoloji" }),
    ];

    const rows = await getPublicCorrections();

    expect(fixture.tablesQueried.filter((t) => t !== "corrections").sort()).toEqual([
      "clusters",
      "sources",
    ]);
    expect(rows!.map((r) => r.subject.kind)).toEqual(["source", "cluster", "general"]);
  });

  it("skips both lookups entirely when no row needs them", async () => {
    fixture.data = [
      // embed-resolved cluster (cluster_id set, url irrelevant)
      rawRow({
        id: "a",
        cluster_id: UUID,
        url: "https://www.tayfhaber.com/source/sozcu",
        cluster: { id: UUID, title_tr: "Ham", title_tr_neutral: null },
      }),
      // cluster_gone via a set-but-unembedded cluster_id
      rawRow({ id: "b", cluster_id: UUID_2, cluster: null }),
      // general: third-party and unrelated pages
      rawRow({ id: "c", url: "https://evil.com/source/x" }),
      rawRow({ id: "d", url: "https://www.tayfhaber.com/metodoloji" }),
      rawRow({ id: "e", url: "not a url" }),
    ];

    const rows = await getPublicCorrections();

    expect(rows).toHaveLength(5);
    expect(fixture.tablesQueried).toEqual(["corrections"]);
  });

  it("skips lookups for an empty log", async () => {
    fixture.data = [];

    await expect(getPublicCorrections()).resolves.toEqual([]);

    expect(fixture.tablesQueried).toEqual(["corrections"]);
  });

  it("never sends the submitted url to a lookup table", async () => {
    fixture.sources = [{ slug: "sozcu", name: "Sözcü" }];
    fixture.clusters = [{ id: UUID, title_tr: "Ham", title_tr_neutral: null }];
    fixture.data = [
      rawRow({ id: "s1", url: "https://www.tayfhaber.com/source/sozcu?q=SECRETQUERY" }),
      rawRow({ id: "k1", url: `https://www.tayfhaber.com/cluster/${UUID}#SECRETHASH` }),
    ];

    await getPublicCorrections();

    const sent = JSON.stringify([fixture.sourcesState, fixture.clustersState]);
    expect(sent).not.toMatch(/SECRETQUERY|SECRETHASH|tayfhaber\.com/);
  });
});

describe("getPublicCorrections lookup failures", () => {
  it("a sources lookup error resolves null and is cached for minutes only (exactly one cacheLife)", async () => {
    fixture.sourcesError = { message: "permission denied for table sources" };
    fixture.data = [
      rawRow({ id: "s1", url: "https://www.tayfhaber.com/source/sozcu" }),
    ];

    await expect(getPublicCorrections()).resolves.toBeNull();

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("source-directory");
    expect(console.error).toHaveBeenCalledTimes(1);
    const logged = String(vi.mocked(console.error).mock.calls[0]![0]);
    expect(logged).toMatch(/permission denied for table sources/);
    expect(logged).not.toMatch(/tayfhaber\.com|email|message/i);
  });

  it("a clusters lookup error resolves null and is cached for minutes only (exactly one cacheLife)", async () => {
    fixture.clustersError = { message: "statement timeout" };
    fixture.data = [
      rawRow({ id: "k1", url: `https://www.tayfhaber.com/cluster/${UUID}` }),
    ];

    await expect(getPublicCorrections()).resolves.toBeNull();

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("source-directory");
  });

  it("a lookup error never degrades to a general label: the whole read fails instead", async () => {
    fixture.sourcesError = { message: "boom" };
    fixture.data = [
      rawRow({ id: "s1", url: "https://www.tayfhaber.com/source/sozcu" }),
      rawRow({ id: "g1", url: "https://www.tayfhaber.com/metodoloji" }),
    ];

    await expect(getPublicCorrections()).resolves.toBeNull();
  });

  it("an error in a lookup that no row needs is irrelevant (it is never called)", async () => {
    fixture.sourcesError = { message: "boom" };
    fixture.clustersError = { message: "boom" };
    fixture.data = [rawRow({ id: "g1" })];

    const rows = await getPublicCorrections();

    expect(rows).toHaveLength(1);
    expect(cacheLife).toHaveBeenCalledWith("source-directory");
  });
});
