import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createSupabaseFake } from "../../../tests/_helpers/supabase-fake";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";
import {
  fetchLanguageIsolatedIds,
  ISOLATION_CHUNK_SIZE,
  ISOLATION_MAX_MEMBERS,
  ISOLATION_MIN_MEMBERS,
} from "./language-isolation-read";

// ---------------------------------------------------------------------------
// h118-english-1: which clusters formed among English-language outlets only?
// The helper reads the member sources of the small clusters in a list
// (cluster_articles -> articles -> sources) and answers with the ids whose
// every member is English (isLanguageIsolatedCluster). The count guard (group
// size === article_count) means a truncated or partial read can only ever drop
// an id, never add one. It never throws: a failure is today's behaviour (an
// empty set).
// ---------------------------------------------------------------------------

type Src = { slug: string | null; name: string | null };

const A_NEWS: Src = { slug: "a-news", name: "A News" };
const TRT_WORLD: Src = { slug: "trt-world", name: "TRT World" };
const DAILY_SABAH: Src = { slug: "daily-sabah", name: "Daily Sabah" };
const A_HABER: Src = { slug: "a-haber", name: "A Haber" };
const SOZCU: Src = { slug: "sozcu", name: "Sözcü" };

function member(clusterId: string, source: Src | null) {
  return {
    cluster_id: clusterId,
    articles: source === null ? null : { sources: source },
  };
}

const fixture = {
  rows: [] as unknown[],
  error: null as { message: string } | null,
  throws: false,
  /** Rows to return per read, in call order (overrides `rows` when set). */
  perRead: null as unknown[][] | null,
  /** Which read (0-based) fails, when set. */
  failRead: null as number | null,
  states: [] as BuilderState[],
};

function makeClient(): SupabaseClient {
  const { client } = createSupabaseFake({
    tables: {
      cluster_articles: (state) => {
        const index = fixture.states.length;
        fixture.states.push(state);
        if (fixture.throws) throw new Error("isolation boom");
        if (fixture.error || fixture.failRead === index) {
          return { data: null, error: fixture.error ?? { message: "chunk failed" } };
        }
        const data = fixture.perRead ? (fixture.perRead[index] ?? []) : fixture.rows;
        return { data, error: null };
      },
    },
  });
  return client as unknown as SupabaseClient;
}

beforeEach(() => {
  fixture.rows = [];
  fixture.error = null;
  fixture.throws = false;
  fixture.perRead = null;
  fixture.failRead = null;
  fixture.states = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("constants", () => {
  it("covers clusters of 2 to 12 members (there are only six English outlets)", () => {
    expect(ISOLATION_MIN_MEMBERS).toBe(2);
    expect(ISOLATION_MAX_MEMBERS).toBe(12);
  });

  it("keeps one read's row limit at or under PostgREST's 1,000-row cap", () => {
    expect(ISOLATION_CHUNK_SIZE * ISOLATION_MAX_MEMBERS).toBeLessThanOrEqual(1000);
  });
});

describe("fetchLanguageIsolatedIds verdicts", () => {
  it("an English-only cluster (a-news + trt-world, article_count 2) is in the set", async () => {
    fixture.rows = [member("c1", A_NEWS), member("c1", TRT_WORLD)];

    const ids = await fetchLanguageIsolatedIds(makeClient(), [
      { id: "c1", article_count: 2 },
    ]);

    expect([...ids]).toEqual(["c1"]);
  });

  it("a mixed cluster (a-haber + daily-sabah) is not", async () => {
    fixture.rows = [member("c1", A_HABER), member("c1", DAILY_SABAH)];

    const ids = await fetchLanguageIsolatedIds(makeClient(), [
      { id: "c1", article_count: 2 },
    ]);

    expect(ids.size).toBe(0);
  });

  it("English rows that are fewer than article_count are not (a truncated read is never a false positive)", async () => {
    // Three members exist, the read returned the two English ones only: the
    // third could be a Turkish article the read never saw.
    fixture.rows = [member("c1", A_NEWS), member("c1", TRT_WORLD)];

    const ids = await fetchLanguageIsolatedIds(makeClient(), [
      { id: "c1", article_count: 3 },
    ]);

    expect(ids.size).toBe(0);
  });

  it("more rows than article_count (a stale count) is not isolated either", async () => {
    fixture.rows = [member("c1", A_NEWS), member("c1", TRT_WORLD), member("c1", DAILY_SABAH)];

    const ids = await fetchLanguageIsolatedIds(makeClient(), [
      { id: "c1", article_count: 2 },
    ]);

    expect(ids.size).toBe(0);
  });

  it("decides per cluster: an English-only one beside a mixed and a Turkish one", async () => {
    fixture.rows = [
      member("en", DAILY_SABAH),
      member("mixed", A_NEWS),
      member("tr", SOZCU),
      member("en", A_NEWS),
      member("mixed", SOZCU),
      member("tr", A_HABER),
    ];

    const ids = await fetchLanguageIsolatedIds(makeClient(), [
      { id: "en", article_count: 2 },
      { id: "mixed", article_count: 2 },
      { id: "tr", article_count: 2 },
    ]);

    expect([...ids]).toEqual(["en"]);
  });

  it("a member with no article embed (null) cannot be shown English, so the cluster is not isolated", async () => {
    fixture.rows = [member("c1", A_NEWS), member("c1", null)];

    const ids = await fetchLanguageIsolatedIds(makeClient(), [
      { id: "c1", article_count: 2 },
    ]);

    expect(ids.size).toBe(0);
  });

  it("a member whose source has no slug is judged by its display name", async () => {
    fixture.rows = [
      member("c1", { slug: null, name: "Daily Sabah" }),
      member("c1", { slug: null, name: "TRT World" }),
      member("c2", { slug: null, name: "Daily Sabah" }),
      member("c2", { slug: null, name: "Sözcü" }),
    ];

    const ids = await fetchLanguageIsolatedIds(makeClient(), [
      { id: "c1", article_count: 2 },
      { id: "c2", article_count: 2 },
    ]);

    expect([...ids]).toEqual(["c1"]);
  });

  it("tolerates array-shaped embeds (articles and sources as one-element arrays)", async () => {
    fixture.rows = [
      { cluster_id: "c1", articles: [{ sources: [A_NEWS] }] },
      { cluster_id: "c1", articles: { sources: [TRT_WORLD] } },
    ];

    const ids = await fetchLanguageIsolatedIds(makeClient(), [
      { id: "c1", article_count: 2 },
    ]);

    expect([...ids]).toEqual(["c1"]);
  });

  it("ignores member rows of a cluster it did not ask about", async () => {
    fixture.rows = [member("other", A_NEWS), member("other", TRT_WORLD)];

    const ids = await fetchLanguageIsolatedIds(makeClient(), [
      { id: "c1", article_count: 2 },
    ]);

    expect(ids.size).toBe(0);
  });
});

describe("fetchLanguageIsolatedIds candidates and read shape", () => {
  it("reads only clusters of 2 to 12 members: 20 (and 1, 13, 0, NaN) are never read", async () => {
    fixture.rows = [member("c2", A_NEWS), member("c2", TRT_WORLD)];

    await fetchLanguageIsolatedIds(makeClient(), [
      { id: "c20", article_count: 20 },
      { id: "c13", article_count: 13 },
      { id: "c12", article_count: 12 },
      { id: "c2", article_count: 2 },
      { id: "c1", article_count: 1 },
      { id: "c0", article_count: 0 },
      { id: "cNaN", article_count: Number.NaN },
    ]);

    expect(fixture.states).toHaveLength(1);
    expect(fixture.states[0]?.in).toEqual([{ col: "cluster_id", vals: ["c12", "c2"] }]);
  });

  it("issues no read at all when no row is a candidate", async () => {
    const ids = await fetchLanguageIsolatedIds(makeClient(), [
      { id: "c20", article_count: 20 },
      { id: "c1", article_count: 1 },
    ]);

    expect(ids.size).toBe(0);
    expect(fixture.states).toHaveLength(0);
  });

  it("an empty list issues no read", async () => {
    const ids = await fetchLanguageIsolatedIds(makeClient(), []);

    expect(ids.size).toBe(0);
    expect(fixture.states).toHaveLength(0);
  });

  it("skips rows with a non-string id or a non-number count, and asks once per distinct id", async () => {
    await fetchLanguageIsolatedIds(makeClient(), [
      { id: "c1", article_count: 3 },
      { id: "c1", article_count: 3 },
      { id: 7 as unknown as string, article_count: 3 },
      { id: "c2", article_count: "3" as unknown as number },
    ]);

    expect(fixture.states).toHaveLength(1);
    expect(fixture.states[0]?.in).toEqual([{ col: "cluster_id", vals: ["c1"] }]);
  });

  it("embeds the member article's source slug and name, and limits the read to 12 rows per asked cluster", async () => {
    await fetchLanguageIsolatedIds(makeClient(), [
      { id: "c1", article_count: 2 },
      { id: "c2", article_count: 4 },
      { id: "c3", article_count: 3 },
    ]);

    const state = fixture.states[0] as BuilderState;
    expect(state.table).toBe("cluster_articles");
    const select = String(state.selectArgs[0]);
    expect(select).toMatch(/\bcluster_id\b/);
    expect(select).toMatch(/articles\s*\(\s*sources\s*\(\s*slug\s*,\s*name\s*\)\s*\)/);
    expect(state.limit).toBe(3 * 12);
  });

  it("splits a long list into reads of at most ISOLATION_CHUNK_SIZE ids, each within PostgREST's cap", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: `c${i}`, article_count: 3 }));

    await fetchLanguageIsolatedIds(makeClient(), rows);

    expect(fixture.states).toHaveLength(Math.ceil(200 / ISOLATION_CHUNK_SIZE));
    const asked = fixture.states.flatMap((s) => s.in[0]?.vals ?? []);
    expect(asked).toEqual(rows.map((r) => r.id));
    for (const state of fixture.states) {
      expect((state.in[0]?.vals ?? []).length).toBeLessThanOrEqual(ISOLATION_CHUNK_SIZE);
      expect(state.limit).toBeLessThanOrEqual(1000);
    }
  });

  it("finds the English-only clusters of every chunk", async () => {
    const rows = Array.from({ length: ISOLATION_CHUNK_SIZE + 2 }, (_, i) => ({
      id: `c${i}`,
      article_count: 2,
    }));
    const first = `c0`;
    const last = `c${ISOLATION_CHUNK_SIZE + 1}`;
    fixture.perRead = [
      [member(first, A_NEWS), member(first, TRT_WORLD)],
      [member(last, DAILY_SABAH), member(last, A_NEWS)],
    ];

    const ids = await fetchLanguageIsolatedIds(makeClient(), rows);

    expect([...ids].sort()).toEqual([first, last].sort());
  });
});

describe("fetchLanguageIsolatedIds failure", () => {
  it("a Supabase error logs and gives an empty set", async () => {
    fixture.error = { message: "isolation timed out" };

    const ids = await fetchLanguageIsolatedIds(makeClient(), [
      { id: "c1", article_count: 2 },
    ]);

    expect(ids.size).toBe(0);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("isolation timed out"),
    );
  });

  it("a read that throws is contained the same way", async () => {
    fixture.throws = true;

    const ids = await fetchLanguageIsolatedIds(makeClient(), [
      { id: "c1", article_count: 2 },
    ]);

    expect(ids.size).toBe(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("isolation boom"));
  });

  it("one failed chunk empties the whole answer rather than qualifying only part of a list", async () => {
    const rows = Array.from({ length: ISOLATION_CHUNK_SIZE + 2 }, (_, i) => ({
      id: `c${i}`,
      article_count: 2,
    }));
    fixture.failRead = 1;
    fixture.perRead = [
      [member("c0", A_NEWS), member("c0", TRT_WORLD)],
      [],
    ];

    const ids = await fetchLanguageIsolatedIds(makeClient(), rows);

    expect(ids.size).toBe(0);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("never throws, whatever it is handed", async () => {
    await expect(
      fetchLanguageIsolatedIds(makeClient(), null as unknown as []),
    ).resolves.toEqual(new Set());
    await expect(
      fetchLanguageIsolatedIds(makeClient(), [null as unknown as { id: string; article_count: number }]),
    ).resolves.toEqual(new Set());
  });
});
