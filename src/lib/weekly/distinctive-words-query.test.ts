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
  /** How many times the sources table was read. */
  sourcesReads: 0,
  /** When set, the sources read settles only after this promise does (parallelism test). */
  sourcesGate: null as null | Promise<void>,
  /** The builder state of every weekly_words_sample read, in call order. */
  sampleStates: [] as unknown[],
  /**
   * Answers every weekly_words_sample read. It returns `{ data, error }` where
   * error may be `{ message, code }` (a PostgREST error). Unset means an empty
   * table, so the pooled-fallback tests keep their meaning.
   */
  sampleResolver: null as null | ((state: unknown) => unknown),
  /** The options object each `createClient(url, key, opts)` call received. */
  clientOpts: [] as unknown[],
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      sources: (state: unknown) => {
        fixture.sourcesState = state;
        fixture.sourcesReads += 1;
        const result = { data: fixture.sourcesData, error: fixture.sourcesError };
        if (fixture.sourcesGate) return fixture.sourcesGate.then(() => result) as never;
        return result;
      },
      weekly_words_sample: (state: unknown) => {
        fixture.sampleStates.push(state);
        if (fixture.sampleResolver) return fixture.sampleResolver(state) as never;
        return { data: [], error: null };
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

// ---------------------------------------------------------------------------
// weekly_words_sample table fake (migration 143). One row per (day, zone,
// article); `zone` is stored and ordered on but never selected, as in the query.
// ---------------------------------------------------------------------------

interface SampleTableRow {
  day: string;
  zone: string;
  article_id: string;
  source_id: string;
  title: string | null;
  url: string | null;
  created_at: string;
}

const codeUnitCompare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * PostgREST emulation for the sample table: gte/lte on `day`, order by
 * (day, zone, article_id) ascending, `.range(from, to)` inclusive, and only the
 * selected columns come back.
 */
function sampleTableResolver(rows: readonly SampleTableRow[]) {
  return (stateRaw: unknown) => {
    const state = stateRaw as BuilderState;
    const gte = state.gte.find((p) => p.col === "day")?.val as string | undefined;
    const lte = state.lte.find((p) => p.col === "day")?.val as string | undefined;
    const from = state.range?.from ?? 0;
    const to = state.range?.to ?? Number.MAX_SAFE_INTEGER;
    const data = rows
      .filter((r) => (gte === undefined || r.day >= gte) && (lte === undefined || r.day <= lte))
      .sort(
        (a, b) =>
          codeUnitCompare(a.day, b.day) ||
          codeUnitCompare(a.zone, b.zone) ||
          codeUnitCompare(a.article_id, b.article_id),
      )
      .slice(from, to + 1)
      .map((r) => ({
        day: r.day,
        article_id: r.article_id,
        source_id: r.source_id,
        title: r.title,
        url: r.url,
        created_at: r.created_at,
      }));
    return { data, error: null };
  };
}

/** A PostgREST error envelope (`code` omitted for a client-side failure such as an abort). */
function sampleFailure(message: string, code?: string) {
  return () => ({ data: null, error: code === undefined ? { message } : { message, code } });
}

function sampleRow(day: string, i: number, zone = "iktidar"): SampleTableRow {
  return {
    day,
    zone,
    article_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    source_id: "gov-1",
    title: `başlık ${i}`,
    url: `https://example.com/${i}`,
    created_at: `${day}T09:00:00.000Z`,
  };
}

/** A capped client is built with a custom `global.fetch`; a plain one is not. */
function isCappedClientOpts(opts: unknown): boolean {
  const g = (opts as { global?: { fetch?: unknown } } | undefined)?.global;
  return typeof g?.fetch === "function";
}

import { cacheLife, cacheTag } from "next/cache";
import {
  fetchWeeklyDistinctiveWords,
  getWeeklyDistinctiveWords,
  istanbulDayKeys,
  istanbulDayWindow,
  WEEKLY_WORDS_DAYS,
  WEEKLY_WORDS_PER_ZONE_PER_DAY,
  WEEKLY_WORDS_READ_CONCURRENCY,
  WEEKLY_WORDS_SAMPLE_MAX_PAGES,
  WEEKLY_WORDS_SAMPLE_TABLE,
} from "./distinctive-words-query";
import { BIAS_TO_ZONE, VOTING_SOURCE_KINDS } from "@/lib/bias/config";
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
  fixture.sourcesReads = 0;
  fixture.sourcesGate = null;
  fixture.sampleStates = [];
  fixture.sampleResolver = null;
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
// h14-perf-1 (second step): the 21 (zone x day) samples are precomputed hourly
// into public.weekly_words_sample (migration 143). The fill reads that table
// (<= WEEKLY_WORDS_SAMPLE_MAX_PAGES pages) and falls back to the pooled article
// reads only for the Istanbul days the table has no row for.
// ---------------------------------------------------------------------------

describe("istanbulDayKeys / istanbulDayWindow", () => {
  it("names the Istanbul calendar day of the clock, newest first", () => {
    const keys = istanbulDayKeys(Date.parse("2026-11-01T22:30:00Z"), 7);
    expect(keys[0]).toBe("2026-11-02");
    expect(keys).toEqual([
      "2026-11-02",
      "2026-11-01",
      "2026-10-31",
      "2026-10-30",
      "2026-10-29",
      "2026-10-28",
      "2026-10-27",
    ]);
  });

  it("flips at 21:00 UTC, the Istanbul midnight", () => {
    expect(istanbulDayKeys(Date.parse("2026-11-01T20:59:59.999Z"), 1)).toEqual(["2026-11-01"]);
    expect(istanbulDayKeys(Date.parse("2026-11-01T21:00:00.000Z"), 1)).toEqual(["2026-11-02"]);
  });

  it("walks back across month and year ends, and returns nothing for zero days", () => {
    expect(istanbulDayKeys(Date.parse("2026-03-01T10:00:00Z"), 3)).toEqual(["2026-03-01", "2026-02-28", "2026-02-27"]);
    expect(istanbulDayKeys(Date.parse("2027-01-01T00:30:00Z"), 2)).toEqual(["2027-01-01", "2026-12-31"]);
    expect(istanbulDayKeys(Date.parse("2026-11-01T10:00:00Z"), 0)).toEqual([]);
  });

  it("agrees with the Europe/Istanbul calendar (Turkiye has no DST since 2016)", () => {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Istanbul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    // Both sides of the EU clock changes and of the old Turkish ones.
    for (const iso of [
      "2026-03-28T23:30:00Z",
      "2026-03-29T00:30:00Z",
      "2026-10-24T21:00:00Z",
      "2026-10-25T20:59:59Z",
      "2026-10-25T21:00:00Z",
      "2026-12-31T21:00:00Z",
    ]) {
      expect(istanbulDayKeys(Date.parse(iso), 1)[0], iso).toBe(fmt.format(new Date(iso)));
    }
  });

  it("builds the window of a day as [00:00, next 00:00) Istanbul, in UTC ISO strings", () => {
    expect(istanbulDayWindow("2026-11-02")).toEqual({
      gte: "2026-11-01T21:00:00.000Z",
      lt: "2026-11-02T21:00:00.000Z",
    });
  });

  it("every window is exactly 24 h wide, also on the days the EU changes its clocks", () => {
    for (const key of ["2026-03-29", "2026-10-25", "2026-12-31", "2028-02-29"]) {
      const { gte, lt } = istanbulDayWindow(key);
      expect(Date.parse(lt) - Date.parse(gte), key).toBe(24 * 60 * 60 * 1000);
    }
  });

  it("consecutive windows touch with no gap and no overlap", () => {
    const keys = istanbulDayKeys(Date.parse("2026-11-01T12:00:00Z"), 7);
    for (let i = 0; i < keys.length - 1; i++) {
      expect(istanbulDayWindow(keys[i + 1]!).lt).toBe(istanbulDayWindow(keys[i]!).gte);
    }
  });
});

describe("fetchWeeklyDistinctiveWords: precomputed sample table", () => {
  const NOW = Date.parse("2026-11-01T12:00:00.000Z");
  const KEYS = istanbulDayKeys(NOW, WEEKLY_WORDS_DAYS);
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    vi.setSystemTime(NOW);
  });

  /** One table row for every day, except the (newest-first) indexes in `skip`. */
  const oneRowPerDay = (skip: readonly number[] = []) =>
    KEYS.flatMap((key, d) => (skip.includes(d) ? [] : [sampleRow(key, d)]));

  const windowsOf = (states: unknown[]) =>
    (states as BuilderState[]).map((s) => ({ gte: s.gte[0]!.val, lt: s.lt[0]!.val }));

  it("names the sample table", () => {
    expect(WEEKLY_WORDS_SAMPLE_TABLE).toBe("weekly_words_sample");
    expect(WEEKLY_WORDS_SAMPLE_MAX_PAGES).toBe(8);
  });

  it("all 7 days present: one sources read, one table page, no article read", async () => {
    fixture.sampleResolver = sampleTableResolver(oneRowPerDay());

    await fetchWeeklyDistinctiveWords();

    expect(fixture.sourcesReads).toBe(1);
    expect(fixture.articleStates).toHaveLength(0);
    expect(fixture.sampleStates).toHaveLength(1);
    const state = fixture.sampleStates[0] as BuilderState;
    expect(state.table).toBe("weekly_words_sample");
    expect(state.selectArgs[0]).toBe("day, article_id, source_id, title, url, created_at");
    expect(state.gte).toEqual([{ col: "day", val: KEYS[6] }]);
    expect(state.lte).toEqual([{ col: "day", val: KEYS[0] }]);
    // Unique per row (the primary key), ascending: the pages never skip or repeat a row.
    expect(state.order.map((o) => o.col)).toEqual(["day", "zone", "article_id"]);
    for (const o of state.order) {
      expect((o.opts as { ascending?: boolean } | undefined)?.ascending ?? true).toBe(true);
    }
    expect(state.range).toEqual({ from: 0, to: 999 });
  });

  it("starts the sources read and the table read together", async () => {
    let release!: () => void;
    fixture.sourcesGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.sampleResolver = sampleTableResolver(oneRowPerDay());

    const run = fetchWeeklyDistinctiveWords();
    await tick();
    // The sources read is still open, and the table read has already been issued.
    expect(fixture.sourcesReads).toBe(1);
    expect(fixture.sampleStates).toHaveLength(1);
    release();
    await run;
    expect(fixture.articleStates).toHaveLength(0);
  });

  it("days 2 and 5 missing: exactly those two days fall back, 3 zone reads each", async () => {
    fixture.sampleResolver = sampleTableResolver(oneRowPerDay([2, 5]));

    await fetchWeeklyDistinctiveWords();

    const states = fixture.articleStates as BuilderState[];
    expect(states).toHaveLength(6);
    const w2 = istanbulDayWindow(KEYS[2]!);
    const w5 = istanbulDayWindow(KEYS[5]!);
    expect(windowsOf(states)).toEqual([w2, w2, w2, w5, w5, w5]);
    expect(states.map((s) => s.in[0]!.vals)).toEqual([
      ["gov-1"], ["ind-1"], ["opp-1"],
      ["gov-1"], ["ind-1"], ["opp-1"],
    ]);
    for (const s of states) {
      expect(s.table).toBe("articles");
      expect(s.in[0]!.col).toBe("source_id");
      expect(s.order).toEqual([{ col: "id", opts: { ascending: true } }]);
      expect(s.limit).toBe(WEEKLY_WORDS_PER_ZONE_PER_DAY);
    }
  });

  it("the newest day missing (today's rows lag): only today is read from articles", async () => {
    fixture.sampleResolver = sampleTableResolver(oneRowPerDay([0]));
    await fetchWeeklyDistinctiveWords();
    const w0 = istanbulDayWindow(KEYS[0]!);
    expect(windowsOf(fixture.articleStates)).toEqual([w0, w0, w0]);
  });

  it("a day counts as present when it has any row: a missing zone does not trigger a fallback", async () => {
    fixture.sampleResolver = sampleTableResolver(KEYS.map((key, d) => sampleRow(key, d, "bagimsiz")));
    await fetchWeeklyDistinctiveWords();
    expect(fixture.articleStates).toHaveLength(0);
  });

  it("an empty table is every day missing: 21 reads, newest Istanbul day first, zones in order", async () => {
    await fetchWeeklyDistinctiveWords();

    expect(fixture.sampleStates).toHaveLength(1);
    const expected = KEYS.flatMap((key) => {
      const w = istanbulDayWindow(key);
      return [w, w, w];
    });
    expect(windowsOf(fixture.articleStates)).toEqual(expected);
  });

  it("windows are the Istanbul days, not rolling 24 h slices of the clock", async () => {
    await fetchWeeklyDistinctiveWords();
    const [first] = windowsOf(fixture.articleStates);
    // NOW is 12:00 UTC (15:00 Istanbul): today's window opens at the previous 21:00 UTC and runs a full day.
    expect(first).toEqual({ gte: "2026-10-31T21:00:00.000Z", lt: "2026-11-01T21:00:00.000Z" });
  });

  it.each([["PGRST205"], ["42P01"]])(
    "a missing table (%s, migration 143 not applied yet): falls back for every day and warns once",
    async (code) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      fixture.sampleResolver = sampleFailure(
        "Could not find the table 'public.weekly_words_sample' in the schema cache",
        code,
      );

      const result = await fetchWeeklyDistinctiveWords();

      expect(result.status).toBe("insufficient");
      expect(fixture.sampleStates).toHaveLength(1);
      expect(fixture.articleStates).toHaveLength(21);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("weekly_words_sample");
    },
  );

  it("any other table error rejects with the [weekly-words] prefix and reads no article", async () => {
    fixture.sampleResolver = sampleFailure("AbortError: Supabase request exceeded 4000 ms");

    const outcome = fetchWeeklyDistinctiveWords();
    await expect(outcome).rejects.toThrow(
      "[weekly-words] sample table query failed: AbortError: Supabase request exceeded 4000 ms",
    );
    expect(fixture.articleStates).toHaveLength(0);
  });

  it.each([["57014"], ["PGRST301"], ["42501"]])(
    "an error with code %s is not a missing table: it rejects instead of hiding behind the fallback",
    async (code) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      fixture.sampleResolver = sampleFailure("boom", code);
      await expect(fetchWeeklyDistinctiveWords()).rejects.toThrow(/^\[weekly-words\] /);
      expect(fixture.articleStates).toHaveLength(0);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it("a table timeout resolves null from the public entry and caches for minutes, once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.sampleResolver = sampleFailure("AbortError: Supabase request exceeded 4000 ms");

    await expect(getWeeklyDistinctiveWords()).resolves.toBeNull();

    // cached attempt (cacheLife) + live retry (uncached, no cacheLife)
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("weekly-words");
    expect(fixture.sampleStates).toHaveLength(2);
    expect(fixture.articleStates).toHaveLength(0);
  });

  it("a missing table still succeeds through the public entry (6 h cache, fallback data)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fixture.sampleResolver = sampleFailure("relation does not exist", "42P01");

    await expect(getWeeklyDistinctiveWords()).resolves.not.toBeNull();
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("weekly-words");
  });

  it("pages the table by 1,000: 2,500 rows are three requests, ranges 0-999, 1000-1999, 2000-2999", async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => sampleRow(KEYS[i % KEYS.length]!, i, ["iktidar", "bagimsiz", "muhalefet"][i % 3]!));
    fixture.sampleResolver = sampleTableResolver(rows);

    await fetchWeeklyDistinctiveWords();

    expect((fixture.sampleStates as BuilderState[]).map((s) => s.range)).toEqual([
      { from: 0, to: 999 },
      { from: 1000, to: 1999 },
      { from: 2000, to: 2999 },
    ]);
    expect(fixture.articleStates).toHaveLength(0);
  });

  it("a full week of samples (21 cells x 300 rows) fits the page cap with room to spare", () => {
    const rowsNeeded = WEEKLY_WORDS_DAYS * 3 * WEEKLY_WORDS_PER_ZONE_PER_DAY;
    expect(Math.ceil(rowsNeeded / 1000)).toBeLessThan(WEEKLY_WORDS_SAMPLE_MAX_PAGES);
  });

  it("truncation (8 full pages) rejects instead of reading a partial week", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows = Array.from({ length: 8000 }, (_, i) => sampleRow(KEYS[i % KEYS.length]!, i));
    fixture.sampleResolver = sampleTableResolver(rows);

    await expect(fetchWeeklyDistinctiveWords()).rejects.toThrow(/^\[weekly-words\] .*truncated/);
    expect(fixture.sampleStates).toHaveLength(WEEKLY_WORDS_SAMPLE_MAX_PAGES);
    expect(fixture.articleStates).toHaveLength(0);
  });

  it("a sources error rejects without waiting on anything else", async () => {
    fixture.sourcesError = { message: "boom" };
    fixture.sampleResolver = sampleTableResolver(oneRowPerDay());
    await expect(fetchWeeklyDistinctiveWords()).rejects.toThrow("boom");
    expect(fixture.articleStates).toHaveLength(0);
  });

  it("a fallback read error still names the zone and the day index", async () => {
    fixture.sampleResolver = sampleTableResolver(oneRowPerDay([3]));
    fixture.articlesError = { message: "articles boom" };
    await expect(fetchWeeklyDistinctiveWords()).rejects.toThrow(
      /\[weekly-words\] articles query failed \(zone=iktidar, day=3\): articles boom/,
    );
  });

  it("no voting source: nothing is read from articles even when every day is missing", async () => {
    fixture.sourcesData = [{ id: "niche-1", name: "Niche", bias: "opposition", kind: "niche", active: true }];
    await fetchWeeklyDistinctiveWords();
    expect(fixture.articleStates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Output parity. Fixture: 3 zones x 7 Istanbul days x 350 rows per zone per day
// (more than the 300-row limit, ids shuffled by a seeded generator so id order
// is not insertion order). The articles resolver emulates PostgREST exactly:
// filter by `in(source_id)` and the created_at window, sort by id ascending,
// slice to the limit. The expected rows are derived independently (group by
// zone and Istanbul calendar day, sort, take 300) and fed to the pure builder.
// The sample table is filled by an in-test emulation of the SQL rule of
// migration 143, and both read paths must return the same thing.
// ---------------------------------------------------------------------------

describe("fetchWeeklyDistinctiveWords: output parity with the pure builder", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const NOW_MS = Date.parse("2026-11-01T12:00:00.000Z");
  const DAY_KEYS = istanbulDayKeys(NOW_MS, WEEKLY_WORDS_DAYS);
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
    // An English-language outlet: the sample keeps its rows, the builder drops them.
    { id: "eng-a", name: "English A", slug: "a-news", bias: "center", kind: "outlet", active: true },
    // Never sampled: a non-voting kind and an inactive source.
    { id: "niche-a", name: "Niche A", slug: "niche-a", bias: "center", kind: "niche", active: true },
    { id: "off-a", name: "Off A", slug: "off-a", bias: "opposition", kind: "outlet", active: false },
  ];

  const ZONES = [
    { zone: "iktidar", sources: ["gov-a", "gov-b", "gov-c"], vocab: ["yatırım", "hizmet", "kalkınma", "proje", "istikrar", "zafer"] },
    { zone: "bagimsiz", sources: ["ind-a", "ind-b", "ind-c"], vocab: ["analiz", "tartışma", "rapor", "uzman", "değerlendirme", "dengeli"] },
    { zone: "muhalefet", sources: ["opp-a", "opp-b", "opp-c"], vocab: ["enflasyon", "yoksulluk", "itiraz", "hak", "zam", "eleştiri"] },
  ] as const;

  /** Independent calendar: Intl knows Europe/Istanbul, the module under test only adds 3 hours. */
  const istanbulDayFormat = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const istanbulDayOf = (iso: string) => istanbulDayFormat.format(new Date(iso));

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
      const dayStartMs = Date.parse(`${DAY_KEYS[d]}T00:00:00+03:00`);
      for (const { zone, sources, vocab } of ZONES) {
        for (let i = 0; i < ROWS_PER_ZONE_PER_DAY; i++) {
          // Inside the Istanbul day: the first row sits exactly on the opening
          // instant (inclusive bound), the last of a past day on its last millisecond.
          let createdMs = dayStartMs + (i + 1) * 2 * 60_000;
          if (i === 0) createdMs = dayStartMs;
          if (i === ROWS_PER_ZONE_PER_DAY - 1 && d > 0) createdMs = dayStartMs + DAY_MS - 1;

          let title: string | null = `${vocab[i % vocab.length]} ${vocab[(i * 5 + d) % vocab.length]} gelişmesi ${zone} ${d} ${i}`;
          // Every word meets every source (the builder wants >= 3 sources per term).
          let sourceId: string = sources[(i + Math.floor(i / vocab.length)) % sources.length]!;
          // Rows the sample keeps and the builder drops later.
          if (i % 53 === 7) title = "";
          if (i % 53 === 11) title = "Koç burcu haftalık yorum";
          if (zone === "bagimsiz" && i % 53 === 13) sourceId = "eng-a";

          rows.push({
            id: `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(8)}${hex(4)}`,
            title,
            url: `https://example.com/${zone}/${d}/${i}`,
            source_id: sourceId,
            created_at: new Date(createdMs).toISOString(),
          });
        }
      }
    }
    // Rows from sources that must never be sampled, inside today's window.
    const todayStartMs = Date.parse(`${DAY_KEYS[0]}T00:00:00+03:00`);
    for (let i = 0; i < 40; i++) {
      rows.push({
        id: `ffff${String(i).padStart(4, "0")}-0000-0000-0000-000000000000`,
        title: `niş kaynak haberi ${i}`,
        url: null,
        source_id: i % 2 === 0 ? "niche-a" : "off-a",
        created_at: new Date(todayStartMs + 60_000 + i * 1000).toISOString(),
      });
    }
    // One instant just outside the week: the last millisecond before the oldest day opens.
    const oldestStartMs = Date.parse(`${DAY_KEYS[WEEKLY_WORDS_DAYS - 1]}T00:00:00+03:00`);
    rows.push({
      id: "00000000-0000-0000-0000-00000000dead",
      title: "haftadan önce yatırım hizmet",
      url: null,
      source_id: "gov-a",
      created_at: new Date(oldestStartMs - 1).toISOString(),
    });
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
        .sort((a, b) => codeUnitCompare(a.id, b.id))
        .slice(0, state.limit ?? Infinity);
      return { data, error: null };
    };
  }

  const zoneOfSource = new Map<string, string>([["eng-a", "bagimsiz"]]);
  for (const z of ZONES) for (const id of z.sources) zoneOfSource.set(id, z.zone);

  /** Independent expectation: the first 300 ids of every (zone, Istanbul day) cell inside the week. */
  function expectedRows(table: WeeklyWordsArticleRow[]): WeeklyWordsArticleRow[] {
    const cells = new Map<string, WeeklyWordsArticleRow[]>();
    for (const row of table) {
      const zone = zoneOfSource.get(row.source_id);
      if (!zone) continue;
      const day = istanbulDayOf(row.created_at);
      if (!DAY_KEYS.includes(day)) continue;
      const key = `${zone}|${day}`;
      const cell = cells.get(key) ?? [];
      cell.push(row);
      cells.set(key, cell);
    }
    const out: WeeklyWordsArticleRow[] = [];
    for (const cell of cells.values()) {
      cell.sort((a, b) => codeUnitCompare(a.id, b.id));
      out.push(...cell.slice(0, WEEKLY_WORDS_PER_ZONE_PER_DAY));
    }
    return out;
  }

  /**
   * The rule of public.weekly_words_sample_refresh (migration 143), restated in
   * TypeScript: per Istanbul day and zone the 300 smallest article ids among the
   * articles created inside [00:00, next 00:00) Istanbul whose source is active,
   * votes (outlet or wire) and has a bias the zone map knows. English-outlet,
   * empty-title and horoscope rows stay in.
   */
  function emulateSampleSql(
    table: WeeklyWordsArticleRow[],
    sources: readonly WeeklyWordsSourceRow[],
    dayKeys: readonly string[],
  ): SampleTableRow[] {
    const sourceById = new Map(sources.map((s) => [s.id, s]));
    const out: SampleTableRow[] = [];
    for (const day of dayKeys) {
      const gte = Date.parse(`${day}T00:00:00+03:00`);
      const lt = gte + DAY_MS;
      const cells = new Map<string, WeeklyWordsArticleRow[]>();
      for (const a of table) {
        const ms = Date.parse(a.created_at);
        if (ms < gte || ms >= lt) continue;
        const s = sourceById.get(a.source_id);
        if (!s || !s.active) continue;
        if (!(VOTING_SOURCE_KINDS as readonly string[]).includes(s.kind ?? "")) continue;
        const zone = s.bias ? (BIAS_TO_ZONE as Record<string, string>)[s.bias] : undefined;
        if (!zone) continue;
        const cell = cells.get(zone) ?? [];
        cell.push(a);
        cells.set(zone, cell);
      }
      for (const [zone, cell] of cells) {
        cell.sort((a, b) => codeUnitCompare(a.id, b.id));
        for (const a of cell.slice(0, 300)) {
          out.push({
            day,
            zone,
            article_id: a.id,
            source_id: a.source_id,
            title: a.title,
            url: a.url,
            created_at: a.created_at,
          });
        }
      }
    }
    return out;
  }

  beforeEach(() => {
    vi.setSystemTime(NOW_MS);
    fixture.sourcesData = PARITY_SOURCES;
  });

  it("the fixture really oversamples: 350 rows per zone per day against a limit of 300", () => {
    const table = buildTable();
    // 3 zones x 7 days x 350, 40 niche/inactive rows, 1 row before the week.
    expect(table.length).toBe(3 * WEEKLY_WORDS_DAYS * ROWS_PER_ZONE_PER_DAY + 40 + 1);
    expect(expectedRows(table)).toHaveLength(3 * WEEKLY_WORDS_DAYS * WEEKLY_WORDS_PER_ZONE_PER_DAY);
  });

  it("the fixture's rows sit on the Istanbul calendar days of the keys, boundaries included", () => {
    const table = buildTable();
    const perCell = new Map<string, number>();
    for (const row of table) {
      const zone = zoneOfSource.get(row.source_id);
      if (!zone) continue;
      const key = `${zone}|${istanbulDayOf(row.created_at)}`;
      perCell.set(key, (perCell.get(key) ?? 0) + 1);
    }
    for (const day of DAY_KEYS) {
      for (const { zone } of ZONES) expect(perCell.get(`${zone}|${day}`), `${zone} ${day}`).toBe(ROWS_PER_ZONE_PER_DAY);
    }
    // The opening instant of each day is in that day, the instant before it is in the day before.
    const opening = Date.parse(`${DAY_KEYS[1]}T00:00:00+03:00`);
    expect(istanbulDayOf(new Date(opening).toISOString())).toBe(DAY_KEYS[1]);
    expect(istanbulDayOf(new Date(opening - 1).toISOString())).toBe(DAY_KEYS[2]);
  });

  it("the SQL emulation keeps 300 per zone-day and never samples niche or inactive sources", () => {
    const sample = emulateSampleSql(buildTable(), PARITY_SOURCES, DAY_KEYS);
    expect(sample).toHaveLength(3 * WEEKLY_WORDS_DAYS * 300);
    expect(sample.some((r) => r.source_id === "niche-a" || r.source_id === "off-a")).toBe(false);
    // English-outlet, empty-title and horoscope rows stay in the sample.
    expect(sample.some((r) => r.source_id === "eng-a")).toBe(true);
    expect(sample.some((r) => r.title === "")).toBe(true);
    expect(sample.some((r) => r.title === "Koç burcu haftalık yorum")).toBe(true);
  });

  it("returns exactly buildWeeklyDistinctiveWords over the first 300 ids of every zone-day (pooled fallback)", async () => {
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

  it("table path = pooled path = the pure builder on the same articles", async () => {
    const table = buildTable();

    // Table path: the sample table holds the SQL rule's output; no article is read.
    fixture.sampleResolver = sampleTableResolver(emulateSampleSql(table, PARITY_SOURCES, DAY_KEYS));
    fixture.articlesResolver = () => {
      throw new Error("the table path must not read articles");
    };
    const viaTable = await fetchWeeklyDistinctiveWords();
    expect(fixture.articleStates).toHaveLength(0);

    // Pooled path: an empty table and the PostgREST emulation over the same articles.
    fixture.sampleResolver = null;
    fixture.articlesResolver = postgrestResolver(table);
    const viaPool = await fetchWeeklyDistinctiveWords();
    expect(fixture.articleStates).toHaveLength(21);

    const expected = buildWeeklyDistinctiveWords(expectedRows(table), PARITY_SOURCES);
    expect(expected.status).toBe("ok");
    expect(viaTable).toEqual(viaPool);
    expect(viaTable).toEqual(expected);
  });

  it("a mixed fill (days 2 and 5 from the pool, the rest from the table) returns the same result", async () => {
    const table = buildTable();
    const sample = emulateSampleSql(table, PARITY_SOURCES, DAY_KEYS).filter(
      (r) => r.day !== DAY_KEYS[2] && r.day !== DAY_KEYS[5],
    );
    fixture.sampleResolver = sampleTableResolver(sample);
    fixture.articlesResolver = postgrestResolver(table);

    const result = await fetchWeeklyDistinctiveWords();

    expect(fixture.articleStates).toHaveLength(6);
    expect(result).toEqual(buildWeeklyDistinctiveWords(expectedRows(table), PARITY_SOURCES));
  });

  it("is unchanged by the order the table rows arrive in (the builder sorts by id itself)", async () => {
    const table = buildTable();
    const sample = emulateSampleSql(table, PARITY_SOURCES, DAY_KEYS);
    fixture.sampleResolver = sampleTableResolver(sample);
    const ordered = await fetchWeeklyDistinctiveWords();

    fixture.sampleResolver = (state) => {
      const page = sampleTableResolver(sample)(state);
      return { data: [...page.data].reverse(), error: null };
    };
    const reversed = await fetchWeeklyDistinctiveWords();

    expect(reversed).toEqual(ordered);
  });

  it("re-filters the table rows with the live sources: a source deactivated since the refresh drops out", async () => {
    const table = buildTable();
    const sample = emulateSampleSql(table, PARITY_SOURCES, DAY_KEYS);
    const live = PARITY_SOURCES.map((s) => (s.id === "opp-c" ? { ...s, active: false } : s));
    fixture.sourcesData = live;
    fixture.sampleResolver = sampleTableResolver(sample);

    const result = await fetchWeeklyDistinctiveWords();

    // Same rows through the pure builder with the live list = what the page must show.
    const asRows: WeeklyWordsArticleRow[] = sample.map((r) => ({
      id: r.article_id,
      title: r.title,
      url: r.url,
      source_id: r.source_id,
      created_at: r.created_at,
    }));
    expect(result).toEqual(buildWeeklyDistinctiveWords(asRows, live));
    expect(result).not.toEqual(buildWeeklyDistinctiveWords(asRows, PARITY_SOURCES));
  });
});
