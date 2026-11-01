import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Harness mirrors src/lib/clusters/story-timeline-query.test.ts: next/cache
// is a no-op and the shared chainable Supabase fake stands in for
// PostgREST.

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const SOURCES = [
  { id: "gov-1", name: "Gov 1", bias: "pro_government", kind: "outlet", active: true },
  { id: "ind-1", name: "Center 1", bias: "center", kind: "outlet", active: true },
  { id: "opp-1", name: "Opp 1", bias: "opposition", kind: "outlet", active: true },
];

const fixture = vi.hoisted(() => ({
  sourcesData: [] as unknown[] | null,
  sourcesError: null as { message: string } | null,
  articlesData: [] as unknown[] | null,
  articlesError: null as { message: string } | null,
  articleStates: [] as unknown[],
  /**
   * When set, answers every articles read instead of `articlesData`. It may
   * return a Promise (the fake's thenable adopts it), which is how the
   * concurrency tests hold reads open.
   */
  articlesResolver: null as null | ((state: unknown) => unknown),
  sourcesState: null as unknown,
  /** The options object each `createClient(url, key, opts)` call received. */
  clientOpts: [] as unknown[],
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      sources: (state: unknown) => {
        fixture.sourcesState = state;
        return { data: fixture.sourcesData, error: fixture.sourcesError };
      },
      articles: (state: unknown) => {
        fixture.articleStates.push(state);
        if (fixture.articlesResolver) return fixture.articlesResolver(state) as never;
        return { data: fixture.articlesData, error: fixture.articlesError };
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
import {
  fetchWeeklyDistinctiveWords,
  getWeeklyDistinctiveWords,
  WEEKLY_WORDS_DAYS,
  WEEKLY_WORDS_PER_ZONE_PER_DAY,
  WEEKLY_WORDS_READ_CONCURRENCY,
} from "./distinctive-words-query";
import {
  buildWeeklyDistinctiveWords,
  type WeeklyWordsArticleRow,
  type WeeklyWordsSourceRow,
} from "./distinctive-words";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.sourcesData = SOURCES;
  fixture.sourcesError = null;
  fixture.articlesData = [];
  fixture.articlesError = null;
  fixture.articleStates = [];
  fixture.articlesResolver = null;
  fixture.sourcesState = null;
  fixture.clientOpts = [];
  vi.mocked(cacheLife).mockClear();
  vi.mocked(cacheTag).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

describe("fetchWeeklyDistinctiveWords", () => {
  it("filters sources to active = true", async () => {
    await fetchWeeklyDistinctiveWords();
    const state = fixture.sourcesState as BuilderState;
    expect(state.table).toBe("sources");
    expect(state.eq).toEqual([{ col: "active", val: true }]);
  });

  it("selects slug on sources (the English-outlet allow-list depends on it)", async () => {
    await fetchWeeklyDistinctiveWords();
    const state = fixture.sourcesState as BuilderState;
    expect(state.selectArgs[0]).toBe("id, name, slug, bias, kind, active");
  });

  it("runs exactly 21 article reads (3 zones x 7 days)", async () => {
    await fetchWeeklyDistinctiveWords();
    expect(fixture.articleStates.length).toBe(21);
  });

  it("each article read filters by source_id, created_at window, orders by id, limits to 300", async () => {
    await fetchWeeklyDistinctiveWords();
    for (const s of fixture.articleStates) {
      const state = s as BuilderState;
      expect(state.table).toBe("articles");
      expect(state.in).toHaveLength(1);
      expect(state.in[0]!.col).toBe("source_id");
      expect(state.gte).toHaveLength(1);
      expect(state.gte[0]!.col).toBe("created_at");
      expect(state.lt).toHaveLength(1);
      expect(state.lt[0]!.col).toBe("created_at");
      expect(state.order).toEqual([{ col: "id", opts: { ascending: true } }]);
      expect(state.limit).toBe(WEEKLY_WORDS_PER_ZONE_PER_DAY);
    }
  });

  it("rejects when the sources read errors", async () => {
    fixture.sourcesError = { message: "boom" };
    await expect(fetchWeeklyDistinctiveWords()).rejects.toThrow("boom");
  });

  it("rejects when an articles read errors", async () => {
    fixture.articlesError = { message: "articles boom" };
    await expect(fetchWeeklyDistinctiveWords()).rejects.toThrow("articles boom");
  });
});

describe("getWeeklyDistinctiveWords (never-throws, retry-once wrapper)", () => {
  it("resolves to null when the sources read errors on both the cache attempt and the live retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.sourcesError = { message: "boom" };
    await expect(getWeeklyDistinctiveWords()).resolves.toBeNull();
  });

  it("resolves to null when an articles read errors on both the cache attempt and the live retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.articlesError = { message: "articles boom" };
    await expect(getWeeklyDistinctiveWords()).resolves.toBeNull();
  });

  it("resolves to a value (not null) on success", async () => {
    fixture.articlesData = [];
    const result = await getWeeklyDistinctiveWords();
    expect(result).not.toBeNull();
  });

  it("never throws even when the underlying fetch throws synchronously via a bad Supabase response", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.sourcesError = { message: "connection reset" };
    await expect(getWeeklyDistinctiveWords()).resolves.toBeNull();
  });
});

describe("weekly distinctive words: capped client + cache lifetime", () => {
  it("builds only capped reader clients", async () => {
    await getWeeklyDistinctiveWords();
    expect(fixture.clientOpts.length).toBeGreaterThanOrEqual(1);
    expect(fixture.clientOpts.every(isCappedClientOpts)).toBe(true);
  });

  it("the live retry after a failed cached attempt is capped too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.sourcesError = { message: "AbortError: Supabase request exceeded 4000 ms" };

    await getWeeklyDistinctiveWords();

    // cached attempt + live retry
    expect(fixture.clientOpts).toHaveLength(2);
    expect(fixture.clientOpts.every(isCappedClientOpts)).toBe(true);
  });

  it("success: exactly one cacheLife('weekly-words'), tagged before the fetch", async () => {
    await getWeeklyDistinctiveWords();

    expect(cacheTag).toHaveBeenCalledWith("weekly-words");
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("weekly-words");
    expect(cacheLife).not.toHaveBeenCalledWith("hours");
    expect(vi.mocked(cacheTag).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(cacheLife).mock.invocationCallOrder[0]!,
    );
  });

  it("a timeout resolves null and calls cacheLife('minutes') exactly once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.sourcesError = { message: "AbortError: Supabase request exceeded 4000 ms" };

    await expect(getWeeklyDistinctiveWords()).resolves.toBeNull();

    // cached attempt (cacheLife) + live retry (uncached, no cacheLife)
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("weekly-words");
  });

  it("an articles-read timeout is a failure too, cached for minutes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.articlesError = { message: "AbortError: Supabase request exceeded 4000 ms" };

    await expect(getWeeklyDistinctiveWords()).resolves.toBeNull();
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("weekly-words");
  });
});

// ---------------------------------------------------------------------------
// h14-perf-1: the 21 article reads (3 zones x 7 days) used to fan out all at
// once. They now run through a small pool (WEEKLY_WORDS_READ_CONCURRENCY), and
// the word-scoring output for the same input rows must not change.
// ---------------------------------------------------------------------------

/** Macrotask hop: lets every pending microtask chain (fake reads, pool workers) settle. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("fetchWeeklyDistinctiveWords: bounded read concurrency", () => {
  it("exports the pool size as 4", () => {
    expect(WEEKLY_WORDS_READ_CONCURRENCY).toBe(4);
  });

  it("keeps at most WEEKLY_WORDS_READ_CONCURRENCY article reads in flight and still runs all 21", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const release: Array<() => void> = [];
    fixture.articlesResolver = () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve) => {
        release.push(() => {
          inFlight -= 1;
          resolve({ data: [], error: null });
        });
      });
    };

    const run = fetchWeeklyDistinctiveWords();
    await tick();
    // The pool is full (not serial, not 21 wide) before any read has finished.
    expect(inFlight).toBe(WEEKLY_WORDS_READ_CONCURRENCY);
    expect(fixture.articleStates).toHaveLength(WEEKLY_WORDS_READ_CONCURRENCY);

    let completed = 0;
    while (release.length > 0) {
      release.shift()!();
      completed += 1;
      await tick();
      expect(inFlight).toBeLessThanOrEqual(WEEKLY_WORDS_READ_CONCURRENCY);
    }
    await run;

    expect(completed).toBe(WEEKLY_WORDS_DAYS * 3);
    expect(fixture.articleStates).toHaveLength(21);
    expect(maxInFlight).toBe(WEEKLY_WORDS_READ_CONCURRENCY);
  });

  it("schedules day-major: the three zone reads of one day are adjacent, newest day first", async () => {
    await fetchWeeklyDistinctiveWords();
    const states = fixture.articleStates as BuilderState[];
    expect(states).toHaveLength(21);

    const zoneIds = [["gov-1"], ["ind-1"], ["opp-1"]];
    let previousGte: string | null = null;
    for (let day = 0; day < WEEKLY_WORDS_DAYS; day++) {
      const group = states.slice(day * 3, day * 3 + 3);
      expect(group.map((s) => s.in[0]!.vals)).toEqual(zoneIds);
      const windows = new Set(group.map((s) => `${s.gte[0]!.val}|${s.lt[0]!.val}`));
      expect(windows.size, `day ${day} shares one window`).toBe(1);
      const gte = String(group[0]!.gte[0]!.val);
      if (previousGte !== null) expect(gte < previousGte).toBe(true);
      previousGte = gte;
    }
  });

  it("stops scheduling further reads after the first error and rejects with it", async () => {
    fixture.articlesError = { message: "articles boom" };
    await expect(fetchWeeklyDistinctiveWords()).rejects.toThrow(/articles boom/);
    expect(fixture.articleStates.length).toBeLessThanOrEqual(WEEKLY_WORDS_READ_CONCURRENCY);
  });

  it("starts no new read once one has failed, even though the other reads in flight succeed", async () => {
    const settle: Array<(result: { data: unknown[] | null; error: { message: string } | null }) => void> = [];
    fixture.articlesResolver = () => new Promise((resolve) => settle.push(resolve));

    const outcome = fetchWeeklyDistinctiveWords().then(
      () => "resolved",
      (error: unknown) => String(error),
    );
    await tick();
    expect(settle).toHaveLength(WEEKLY_WORDS_READ_CONCURRENCY);

    settle[1]!({ data: null, error: { message: "read 1 boom" } });
    await tick();
    // The three healthy reads finish afterwards; their workers must not pick up read 5.
    for (const i of [0, 2, 3]) settle[i]!({ data: [], error: null });
    await tick();

    expect(fixture.articleStates).toHaveLength(WEEKLY_WORDS_READ_CONCURRENCY);
    expect(await outcome).toMatch(/read 1 boom/);
  });

  it("names the zone and day of the failing read", async () => {
    fixture.articlesError = { message: "articles boom" };
    await expect(fetchWeeklyDistinctiveWords()).rejects.toThrow(
      /\[weekly-words\] articles query failed \(zone=iktidar, day=0\): articles boom/,
    );
  });
});

describe("fetchWeeklyDistinctiveWords: no voting sources", () => {
  it("makes no article read when no active voting source maps to a zone", async () => {
    fixture.sourcesData = [
      { id: "niche-1", name: "Niche", bias: "opposition", kind: "niche", active: true },
      { id: "nobias-1", name: "No bias", bias: null, kind: "outlet", active: true },
      { id: "weird-1", name: "Weird", bias: "not_a_bias", kind: "outlet", active: true },
    ];
    const result = await fetchWeeklyDistinctiveWords();
    expect(fixture.articleStates).toHaveLength(0);
    expect(result.status).toBe("insufficient");
  });

  it("reads only the zones that have voting sources", async () => {
    fixture.sourcesData = [
      { id: "gov-1", name: "Gov 1", bias: "pro_government", kind: "outlet", active: true },
      { id: "niche-1", name: "Niche", bias: "center", kind: "niche", active: true },
    ];
    await fetchWeeklyDistinctiveWords();
    const states = fixture.articleStates as BuilderState[];
    expect(states).toHaveLength(WEEKLY_WORDS_DAYS);
    for (const s of states) expect(s.in[0]!.vals).toEqual(["gov-1"]);
  });
});

// ---------------------------------------------------------------------------
// Output parity. Fixture: 3 zones x 7 days x 350 rows per zone per day (more
// than the 300-row limit, ids shuffled by a seeded generator so id order is not
// insertion order). The articles resolver emulates PostgREST exactly: filter by
// `in(source_id)` and the created_at window, sort by id ascending, slice to
// the limit. The expected rows are derived independently (group by zone and
// day, sort, take 300) and fed to the pure builder.
// ---------------------------------------------------------------------------

describe("fetchWeeklyDistinctiveWords: output parity with the pure builder", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const NOW_MS = Date.parse("2026-11-01T12:00:00.000Z");
  const ROWS_PER_ZONE_PER_DAY = 350;

  const PARITY_SOURCES: WeeklyWordsSourceRow[] = [
    { id: "gov-a", name: "Gov A", slug: "gov-a", bias: "pro_government", kind: "outlet", active: true },
    { id: "gov-b", name: "Gov B", slug: "gov-b", bias: "gov_leaning", kind: "wire", active: true },
    { id: "gov-c", name: "Gov C", slug: "gov-c", bias: "state_media", kind: "outlet", active: true },
    { id: "ind-a", name: "Ind A", slug: "ind-a", bias: "center", kind: "outlet", active: true },
    { id: "ind-b", name: "Ind B", slug: "ind-b", bias: "international", kind: "outlet", active: true },
    { id: "ind-c", name: "Ind C", slug: "ind-c", bias: "pro_kurdish", kind: "outlet", active: true },
    { id: "opp-a", name: "Opp A", slug: "opp-a", bias: "opposition", kind: "outlet", active: true },
    { id: "opp-b", name: "Opp B", slug: "opp-b", bias: "opposition_leaning", kind: "outlet", active: true },
    { id: "opp-c", name: "Opp C", slug: "opp-c", bias: "opposition", kind: "wire", active: true },
    // Never read: a non-voting kind and an inactive source.
    { id: "niche-a", name: "Niche A", slug: "niche-a", bias: "center", kind: "niche", active: true },
    { id: "off-a", name: "Off A", slug: "off-a", bias: "opposition", kind: "outlet", active: false },
  ];

  const ZONES = [
    { zone: "iktidar", sources: ["gov-a", "gov-b", "gov-c"], vocab: ["yatırım", "hizmet", "kalkınma", "proje", "istikrar", "zafer"] },
    { zone: "bagimsiz", sources: ["ind-a", "ind-b", "ind-c"], vocab: ["analiz", "tartışma", "rapor", "uzman", "değerlendirme", "dengeli"] },
    { zone: "muhalefet", sources: ["opp-a", "opp-b", "opp-c"], vocab: ["enflasyon", "yoksulluk", "itiraz", "hak", "zam", "eleştiri"] },
  ] as const;

  /** Seeded generator (mulberry32) so ids are random-looking but identical on every run. */
  function seeded(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return (t ^ (t >>> 14)) >>> 0;
    };
  }

  function buildTable(): WeeklyWordsArticleRow[] {
    const next = seeded(20261101);
    const hex = (n: number) => next().toString(16).padStart(8, "0").slice(0, n);
    const rows: WeeklyWordsArticleRow[] = [];
    for (let d = 0; d < WEEKLY_WORDS_DAYS; d++) {
      for (const { zone, sources, vocab } of ZONES) {
        for (let i = 0; i < ROWS_PER_ZONE_PER_DAY; i++) {
          const createdMs = NOW_MS - d * DAY_MS - (i + 1) * 3 * 60_000; // inside [d, d+1) days back
          rows.push({
            id: `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(8)}${hex(4)}`,
            title: `${vocab[i % vocab.length]} ${vocab[(i * 5 + d) % vocab.length]} gelişmesi ${zone} ${d} ${i}`,
            url: `https://example.com/${zone}/${d}/${i}`,
            // Every word meets every source (the builder wants >= 3 sources per term).
            source_id: sources[(i + Math.floor(i / vocab.length)) % sources.length]!,
            created_at: new Date(createdMs).toISOString(),
          });
        }
      }
    }
    // Rows from sources that must never be read.
    for (let i = 0; i < 40; i++) {
      rows.push({
        id: `ffff${String(i).padStart(4, "0")}-0000-0000-0000-000000000000`,
        title: `niş kaynak haberi ${i}`,
        url: null,
        source_id: i % 2 === 0 ? "niche-a" : "off-a",
        created_at: new Date(NOW_MS - 2 * 60_000 - i * 1000).toISOString(),
      });
    }
    return rows;
  }

  /** PostgREST emulation: in(source_id) + gte/lt on created_at + order by id asc + limit. */
  function postgrestResolver(table: WeeklyWordsArticleRow[]) {
    return (stateRaw: unknown) => {
      const state = stateRaw as BuilderState;
      const ids = new Set(state.in[0]!.vals as string[]);
      const gte = String(state.gte[0]!.val);
      const lt = String(state.lt[0]!.val);
      const data = table
        .filter((r) => ids.has(r.source_id) && r.created_at >= gte && r.created_at < lt)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, state.limit ?? Infinity);
      return { data, error: null };
    };
  }

  /** Independent expectation: the first 300 ids of every (zone, day) cell. */
  function expectedRows(table: WeeklyWordsArticleRow[]): WeeklyWordsArticleRow[] {
    const zoneOf = new Map<string, string>();
    for (const z of ZONES) for (const id of z.sources) zoneOf.set(id, z.zone);
    const cells = new Map<string, WeeklyWordsArticleRow[]>();
    for (const row of table) {
      const zone = zoneOf.get(row.source_id);
      if (!zone) continue;
      const day = Math.floor((NOW_MS - Date.parse(row.created_at)) / DAY_MS);
      const key = `${zone}|${day}`;
      const cell = cells.get(key) ?? [];
      cell.push(row);
      cells.set(key, cell);
    }
    const out: WeeklyWordsArticleRow[] = [];
    for (const cell of cells.values()) {
      cell.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      out.push(...cell.slice(0, WEEKLY_WORDS_PER_ZONE_PER_DAY));
    }
    return out;
  }

  beforeEach(() => {
    vi.setSystemTime(NOW_MS);
    fixture.sourcesData = PARITY_SOURCES;
  });

  it("the fixture really oversamples: 350 rows per zone per day against a limit of 300", () => {
    const table = buildTable();
    expect(table.length).toBe(3 * WEEKLY_WORDS_DAYS * ROWS_PER_ZONE_PER_DAY + 40);
    expect(expectedRows(table)).toHaveLength(3 * WEEKLY_WORDS_DAYS * WEEKLY_WORDS_PER_ZONE_PER_DAY);
  });

  it("returns exactly buildWeeklyDistinctiveWords over the first 300 ids of every zone-day", async () => {
    const table = buildTable();
    fixture.articlesResolver = postgrestResolver(table);

    const result = await fetchWeeklyDistinctiveWords();

    const expected = buildWeeklyDistinctiveWords(expectedRows(table), PARITY_SOURCES);
    expect(expected.status).toBe("ok");
    expect(result).toEqual(expected);
    if (result.status === "ok") {
      for (const zone of ["iktidar", "bagimsiz", "muhalefet"] as const) {
        expect(result.sample[zone]).toBeGreaterThanOrEqual(200);
        expect(result.zones[zone].length).toBeGreaterThan(0);
      }
    }
    expect(fixture.articleStates).toHaveLength(21);
  });

  it("is unchanged by the order in which the reads finish", async () => {
    const table = buildTable();
    const immediate = postgrestResolver(table);
    fixture.articlesResolver = immediate;
    const baseline = await fetchWeeklyDistinctiveWords();

    // Same rows, but each read settles after a different, scrambled delay.
    let n = 0;
    fixture.articlesResolver = (state) => {
      const delay = (n++ * 7) % 5;
      return new Promise((resolve) => setTimeout(() => resolve(immediate(state)), delay));
    };
    const scrambled = await fetchWeeklyDistinctiveWords();

    expect(scrambled).toEqual(baseline);
  });
});
