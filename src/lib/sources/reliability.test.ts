import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const fixture = vi.hoisted(() => ({
  data: null as unknown,
  error: null as { message: string } | null,
  /** Fail this many calls with a "boom" error, then serve `data`. */
  failFirst: 0,
  calls: 0,
  /** Every table name `from()` was asked for. */
  tables: [] as string[],
  readerClients: 0,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      source_reliability_30d: () => {
        fixture.calls += 1;
        fixture.tables.push("source_reliability_30d");
        if (fixture.failFirst > 0) {
          fixture.failFirst -= 1;
          return { data: null, error: { message: "boom" } };
        }
        return { data: fixture.data, error: fixture.error };
      },
    },
  });
});

vi.mock("@/lib/supabase/server", () => ({
  createReaderClient: () => {
    fixture.readerClients += 1;
    return supabaseFake.client;
  },
}));

import { cacheLife, cacheTag } from "next/cache";
import { BALANCE_MIN_SOURCES } from "@/lib/bias/balance";
import {
  KARNE_MIN_CLUSTERS,
  KARNE_MIN_MULTI_FOR_ZONES,
  KARNE_WINDOW_DAYS,
  toSourceKarne,
  type SourceKarne,
} from "./karne";
import {
  RELIABILITY_MIN_CLUSTERS,
  RELIABILITY_MIN_DIVERSITY_CLUSTERS,
  RELIABILITY_WINDOW_DAYS,
  buildReliabilityView,
  diversityFromZoneMix,
  getSourceReliability,
  insufficient,
  istanbulDateSpan,
  reliabilityCountLine,
  toSourceReliability,
  type SourceReliability,
} from "./reliability";

const ID = "9236e05a-56d9-47b0-a378-02ec8e880180";

function raw(over: Record<string, unknown> = {}) {
  return {
    source_id: ID,
    window_days: 30,
    // Istanbul-midnight aligned (2026-08-30 00:00 -> 2026-09-29 00:00 +03:00),
    // so the window spans exactly 30 calendar dates. Production windows are
    // rolling and almost never aligned; the h41 tests below use those shapes.
    window_start: "2026-08-29T21:00:00Z",
    window_end: "2026-09-28T21:00:00Z",
    n_articles: 600,
    active_days: 30,
    n_clusters: 100,
    n_wire_copy: 12,
    zone_mix: [
      [2, 2, 1, 10],
      [0, 5, 0, 5],
    ],
    computed_at: "2026-09-29T00:00:00Z",
    ...over,
  };
}

function rel(over: Partial<SourceReliability> = {}): SourceReliability {
  return { ...toSourceReliability(raw())!, ...over };
}

function karneRow(over: Record<string, unknown> = {}): SourceKarne {
  return toSourceKarne({
    source_id: ID,
    window_days: 30,
    window_start: "2026-08-30T00:00:00Z",
    window_end: "2026-09-29T00:00:00Z",
    n_clusters: 120,
    n_multi: 60,
    co_iktidar: 30,
    co_bagimsiz: 45,
    co_muhalefet: 15,
    n_blindspot: 6,
    n_blindspot_same_side: 2,
    computed_at: "2026-09-29T00:00:00Z",
    ...over,
  })!;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.data = null;
  fixture.error = null;
  fixture.failFirst = 0;
  fixture.calls = 0;
  fixture.tables = [];
  fixture.readerClients = 0;
  vi.mocked(cacheLife).mockClear();
  vi.mocked(cacheTag).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe("constants alias the shared thresholds", () => {
  it("are the karne window / floors, not copies", () => {
    expect(RELIABILITY_WINDOW_DAYS).toBe(KARNE_WINDOW_DAYS);
    expect(RELIABILITY_MIN_CLUSTERS).toBe(KARNE_MIN_CLUSTERS);
    expect(RELIABILITY_MIN_DIVERSITY_CLUSTERS).toBe(KARNE_MIN_MULTI_FOR_ZONES);
    expect([RELIABILITY_WINDOW_DAYS, RELIABILITY_MIN_CLUSTERS, RELIABILITY_MIN_DIVERSITY_CLUSTERS]).toEqual([
      30, 20, 10,
    ]);
  });
});

describe("toSourceReliability", () => {
  it("maps a valid row", () => {
    expect(toSourceReliability(raw())).toEqual({
      windowDays: 30,
      windowStart: "2026-08-29T21:00:00Z",
      windowEnd: "2026-09-28T21:00:00Z",
      nArticles: 600,
      activeDays: 30,
      nClusters: 100,
      nWireCopy: 12,
      zoneMix: [
        [2, 2, 1, 10],
        [0, 5, 0, 5],
      ],
      computedAt: "2026-09-29T00:00:00Z",
    });
  });

  it("accepts the boundary values: active_days = window_days + 1, wire = clusters, empty mix, zero counts", () => {
    expect(toSourceReliability(raw({ active_days: 31 }))?.activeDays).toBe(31);
    expect(toSourceReliability(raw({ n_wire_copy: 100 }))?.nWireCopy).toBe(100);
    expect(toSourceReliability(raw({ zone_mix: [] }))?.zoneMix).toEqual([]);
    expect(
      toSourceReliability(raw({ n_articles: 0, active_days: 0, n_clusters: 0, n_wire_copy: 0 })),
    ).not.toBeNull();
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "row"],
    ["a number", 42],
    ["an array", [1, 2]],
  ])("rejects a non-object input (%s)", (_n, input) => {
    expect(toSourceReliability(input)).toBeNull();
  });

  it.each([
    ["window_days 0", { window_days: 0 }],
    ["window_days 91", { window_days: 91 }],
    ["window_days fractional", { window_days: 30.5 }],
    ["window_days a string", { window_days: "30" }],
    ["window_days missing", { window_days: undefined }],
    ["n_articles negative", { n_articles: -1 }],
    ["n_articles fractional", { n_articles: 1.5 }],
    ["n_articles a string", { n_articles: "600" }],
    ["n_articles null", { n_articles: null }],
    ["n_articles NaN", { n_articles: Number.NaN }],
    ["n_clusters negative", { n_clusters: -3 }],
    ["n_clusters Infinity", { n_clusters: Number.POSITIVE_INFINITY }],
    ["active_days negative", { active_days: -1 }],
    ["active_days above window_days + 1", { active_days: 32 }],
    ["n_wire_copy above n_clusters", { n_wire_copy: 101 }],
    ["n_wire_copy negative", { n_wire_copy: -1 }],
    ["window_start unparseable", { window_start: "not a date" }],
    ["window_start empty", { window_start: "" }],
    ["window_end missing", { window_end: undefined }],
    ["computed_at not a string", { computed_at: 1759104000000 }],
  ])("rejects an invariant break: %s", (_name, over) => {
    expect(toSourceReliability(raw(over))).toBeNull();
  });

  it.each([
    ["not an array (object)", {}],
    ["not an array (string)", "[[1,2,3,4]]"],
    ["null", null],
    ["missing", undefined],
    ["an entry that is not an array", [{ a: 1 }]],
    ["an entry with 3 numbers", [[1, 2, 3]]],
    ["an entry with 5 numbers", [[1, 2, 3, 4, 5]]],
    ["a negative count", [[1, -1, 0, 1]]],
    ["a fractional count", [[1.5, 0, 0, 1]]],
    ["a string count", [["1", 0, 0, 1]]],
    ["a null count", [[null, 0, 0, 1]]],
    ["one bad entry among good ones", [[2, 2, 1, 10], [1, 2]]],
  ])("rejects a malformed zone_mix: %s", (_name, zoneMix) => {
    expect(toSourceReliability(raw({ zone_mix: zoneMix }))).toBeNull();
  });
});

describe("insufficient", () => {
  it("groups both numbers with the tr-TR dot", () => {
    expect(insufficient(19, 20)).toBe("Yeterli örnek yok (n = 19, en az 20).");
    expect(insufficient(1234, 2000)).toBe("Yeterli örnek yok (n = 1.234, en az 2.000).");
  });
});

describe("diversityFromZoneMix", () => {
  it("is the cluster-weighted mean Denge puanı and skips entries below the vote floor", () => {
    // [5,0,0] scores 0 (n 2), [2,2,2] scores 100 (n 1), [1,1,0] has 2 votes < 5 -> skipped.
    expect(
      diversityFromZoneMix([
        [5, 0, 0, 2],
        [2, 2, 2, 1],
        [1, 1, 0, 9],
      ]),
    ).toEqual({ meanScore: 33, n: 3 });
  });

  it("returns null for an empty mix, for a mix of only sub-floor entries and for zero weights", () => {
    expect(diversityFromZoneMix([])).toBeNull();
    expect(diversityFromZoneMix([[1, 1, 1, 4]])).toBeNull();
    expect(diversityFromZoneMix([[2, 2, 2, 0]])).toBeNull();
  });

  it("floors at exactly BALANCE_MIN_SOURCES votes", () => {
    expect(BALANCE_MIN_SOURCES).toBe(5);
    expect(diversityFromZoneMix([[2, 2, 0, 1]])).toBeNull();
    expect(diversityFromZoneMix([[3, 1, 1, 1]])).not.toBeNull();
  });

  it("rounds the weighted mean to a whole number", () => {
    // 100 * 2 + 0 * 1 = 200 / 3 = 66.67 -> 67
    expect(
      diversityFromZoneMix([
        [2, 2, 2, 2],
        [5, 0, 0, 1],
      ]),
    ).toEqual({ meanScore: 67, n: 3 });
  });

  it("weights by cluster count, not by entry", () => {
    expect(
      diversityFromZoneMix([
        [2, 2, 2, 10],
        [5, 0, 0, 10],
      ]),
    ).toEqual({ meanScore: 50, n: 20 });
    expect(
      diversityFromZoneMix([
        [2, 2, 2, 30],
        [5, 0, 0, 10],
      ]),
    ).toEqual({ meanScore: 75, n: 40 });
  });
});

describe("reliabilityCountLine", () => {
  it("is the shared count line over the reliability row's own window and n", () => {
    expect(
      reliabilityCountLine(
        rel({ nClusters: 244, windowEnd: "2026-11-01T06:45:00.000Z" }),
      ),
    ).toBe(
      "Son 30 gün · 01.11.2026 09:45 itibarıyla · bu kaynağın en az bir haberinin bulunduğu 244 haber kümesi",
    );
  });

  it("uses the row's windowDays and groups thousands", () => {
    expect(
      reliabilityCountLine(
        rel({ windowDays: 14, nClusters: 1689, windowEnd: "2026-11-01T22:45:00.000Z" }),
      ),
    ).toBe(
      "Son 14 gün · 02.11.2026 01:45 itibarıyla · bu kaynağın en az bir haberinin bulunduğu 1.689 haber kümesi",
    );
  });
});

// h41-derived-3 (2026-11-05): /source/haberport printed "30/30 gün yayın" with
// no article on 2026-10-24 (fayn: 2026-10-11). The window is a rolling 30 x 24 h
// that spans 31 Europe/Istanbul dates, the view clamped 31 -> 30, so a source
// that skipped a whole interior day looked identical to a perfect one. The
// denominator is now the number of dates the window spans.
describe("istanbulDateSpan", () => {
  it("counts the Istanbul dates a rolling window touches, both partial ends included", () => {
    expect(istanbulDateSpan("2026-10-06T15:00:00Z", "2026-11-05T15:00:00Z")).toBe(31);
    // fayn's refresh instant (14:15Z) is the same shape.
    expect(istanbulDateSpan("2026-10-06T14:15:00Z", "2026-11-05T14:15:00Z")).toBe(31);
  });

  it("counts an Istanbul-midnight aligned window as exactly its length", () => {
    expect(istanbulDateSpan("2026-10-05T21:00:00Z", "2026-11-04T21:00:00Z")).toBe(30);
    expect(istanbulDateSpan("2026-10-06T00:00:00+03:00", "2026-11-05T00:00:00+03:00")).toBe(30);
  });

  it("treats windowEnd as exclusive: end - 1 ms decides the last date", () => {
    // 21:00:00.000Z is Istanbul midnight: that instant belongs to the next date.
    expect(istanbulDateSpan("2026-10-05T21:00:00Z", "2026-10-06T21:00:00Z")).toBe(1);
    expect(istanbulDateSpan("2026-10-05T21:00:00Z", "2026-10-06T21:00:00.001Z")).toBe(2);
    // One millisecond before Istanbul midnight is still the previous date.
    expect(istanbulDateSpan("2026-10-05T20:59:59.999Z", "2026-10-05T21:00:00Z")).toBe(1);
    expect(istanbulDateSpan("2026-10-05T20:59:59.999Z", "2026-10-05T21:00:00.001Z")).toBe(2);
  });

  it("handles a single instant-wide window, a year boundary and a leap day", () => {
    expect(istanbulDateSpan("2026-10-06T12:00:00Z", "2026-10-06T12:00:00.001Z")).toBe(1);
    expect(istanbulDateSpan("2026-12-31T20:00:00Z", "2027-01-01T00:00:00Z")).toBe(2);
    expect(istanbulDateSpan("2028-02-27T21:00:00Z", "2028-03-01T21:00:00Z")).toBe(3);
    expect(istanbulDateSpan("2027-02-27T21:00:00Z", "2027-03-01T21:00:00Z")).toBe(2);
  });

  it("uses a fixed UTC+3 (no daylight saving) in summer and winter alike", () => {
    expect(istanbulDateSpan("2026-06-30T21:00:00Z", "2026-07-30T21:00:00Z")).toBe(30);
    expect(istanbulDateSpan("2026-12-14T21:00:00Z", "2027-01-13T21:00:00Z")).toBe(30);
    expect(istanbulDateSpan("2026-03-28T21:00:00Z", "2026-03-30T21:00:00Z")).toBe(2);
    expect(istanbulDateSpan("2026-10-24T21:00:00Z", "2026-10-26T21:00:00Z")).toBe(2);
  });

  it("gives NaN for unparseable input", () => {
    expect(istanbulDateSpan("x", "2026-11-05T15:00:00Z")).toBeNaN();
    expect(istanbulDateSpan("2026-10-06T15:00:00Z", "not a date")).toBeNaN();
    expect(istanbulDateSpan("", "")).toBeNaN();
    expect(istanbulDateSpan(undefined as unknown as string, "2026-11-05T15:00:00Z")).toBeNaN();
    expect(istanbulDateSpan("2026-10-06T15:00:00Z", null as unknown as string)).toBeNaN();
  });

  it("gives NaN for an empty or reversed window (not a window at all)", () => {
    expect(istanbulDateSpan("2026-11-05T15:00:00Z", "2026-11-05T15:00:00Z")).toBeNaN();
    expect(istanbulDateSpan("2026-11-05T15:00:00Z", "2026-10-06T15:00:00Z")).toBeNaN();
  });

  it("agrees with an Intl.DateTimeFormat date enumeration on 300 pseudo-random windows", () => {
    // Independent oracle: walk the window in 15-minute steps (plus end - 1 ms)
    // and count the distinct Europe/Istanbul calendar dates seen.
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Istanbul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    let seed = 41;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const base = Date.parse("2026-01-01T00:00:00Z");
    for (let i = 0; i < 300; i++) {
      const start = base + Math.floor(next() * 365 * 86_400_000);
      const length = 1 + Math.floor(next() * 40 * 86_400_000);
      const end = start + length;
      const seen = new Set<string>();
      for (let t = start; t < end; t += 15 * 60_000) seen.add(fmt.format(t));
      seen.add(fmt.format(end - 1));
      expect(
        istanbulDateSpan(new Date(start).toISOString(), new Date(end).toISOString()),
        `${new Date(start).toISOString()} -> ${new Date(end).toISOString()}`,
      ).toBe(seen.size);
    }
  });
});

describe("buildReliabilityView", () => {
  const byKey = (rows: ReturnType<typeof buildReliabilityView>) =>
    Object.fromEntries(rows.map((r) => [r.key, r]));

  it("returns the four rows in order with their Turkish labels", () => {
    const rows = buildReliabilityView(rel(), karneRow());
    expect(rows.map((r) => r.label)).toEqual([
      "Yayın sıklığı",
      "Başka kaynaklarla aynı başlık ve özet",
      "Kör nokta kümelerindeki payı",
      "Bölge çeşitliliği",
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(4);
  });

  it("every row carries a non-empty `how` text", () => {
    for (const r of buildReliabilityView(rel(), karneRow())) {
      expect(r.how.length).toBeGreaterThan(20);
    }
  });

  describe("Yayın sıklığı", () => {
    it("shows articles per day and active days", () => {
      const row = byKey(buildReliabilityView(rel(), karneRow())).cadence!;
      expect(row.value).toBe("20 haber/gün · 30/30 gün yayın");
      expect(row.note).toBeNull();
      expect(row.how).toBe(
        "Son 30 günün haber sayısı 30’a bölünür; etkin gün, en az bir haber yayımlanan gündür (Türkiye saati).",
      );
    });

    it("formats the daily rate with at most one decimal and a Turkish comma", () => {
      const a = byKey(buildReliabilityView(rel({ nArticles: 6, activeDays: 3 }), null)).cadence!;
      expect(a.value).toBe("0,2 haber/gün · 3/30 gün yayın");
      const b = byKey(buildReliabilityView(rel({ nArticles: 8573, activeDays: 30 }), null)).cadence!;
      expect(b.value).toBe("285,8 haber/gün · 30/30 gün yayın");
    });

    it("clamps active_days = window_days + 1 to an aligned window (it spans only 30 dates)", () => {
      // An article stamped exactly at window_end (`<= v_end` in 111) lands on
      // the next Istanbul date, so activeDays can exceed an aligned span.
      const row = byKey(buildReliabilityView(rel({ activeDays: 31 }), null)).cadence!;
      expect(row.value).toBe("20 haber/gün · 30/30 gün yayın");
      expect(row.value).not.toContain("31");
    });

    it("says so when there were no articles", () => {
      const row = byKey(
        buildReliabilityView(rel({ nArticles: 0, activeDays: 0, nClusters: 0, nWireCopy: 0 }), null),
      ).cadence!;
      expect(row.value).toBe("Son 30 günde haber yok");
    });

    it("never rounds a non-zero rate down to 0", () => {
      const row = byKey(buildReliabilityView(rel({ nArticles: 1, activeDays: 1 }), null)).cadence!;
      expect(row.value).toBe("<0,1 haber/gün · 1/30 gün yayın");
    });

    it("is never gated by the cluster floor", () => {
      const row = byKey(
        buildReliabilityView(rel({ nClusters: 0, nWireCopy: 0, zoneMix: [] }), null),
      ).cadence!;
      expect(row.value).not.toBeNull();
    });

    it("uses the row's own window length", () => {
      const row = byKey(
        buildReliabilityView(
          rel({
            windowDays: 14,
            windowStart: "2026-09-14T21:00:00Z",
            windowEnd: "2026-09-28T21:00:00Z",
            nArticles: 28,
            activeDays: 14,
          }),
          null,
        ),
      ).cadence!;
      expect(row.value).toBe("2 haber/gün · 14/14 gün yayın");
      expect(row.how).toContain("Son 14 günün");
    });
  });

  describe("Yayın sıklığı: the denominator is the dates the window spans (h41-derived-3)", () => {
    // The production shape: a rolling 30 x 24 h window ending at a refresh
    // instant (not Istanbul midnight), so it touches 31 calendar dates.
    const ROLLING = {
      windowStart: "2026-10-06T15:00:00Z",
      windowEnd: "2026-11-05T15:00:00Z",
    };
    // The same window, Istanbul-midnight aligned: 30 dates.
    const ALIGNED = {
      windowStart: "2026-10-05T21:00:00Z",
      windowEnd: "2026-11-04T21:00:00Z",
    };
    const HOW_30 =
      "Son 30 günün haber sayısı 30’a bölünür; etkin gün, en az bir haber yayımlanan gündür (Türkiye saati).";
    const HOW_31 =
      "Son 30 günün haber sayısı 30’a bölünür. Etkin gün, en az bir haber yayımlanan takvim günüdür (Türkiye saati); 30 günlük pencere 31 takvim gününe yayılır, ilk ve son gün kısmidir.";
    const cadence = (over: Partial<SourceReliability>) =>
      byKey(buildReliabilityView(rel(over), null)).cadence!;

    it("prints 30/31 for a source that missed one whole interior day (haberport shape)", () => {
      // 15 615 articles = 520,5 per day over 30; 2026-10-24 has none.
      const row = cadence({ ...ROLLING, nArticles: 15_615, activeDays: 30 });
      expect(row.value).toBe("520,5 haber/gün · 30/31 gün yayın");
      expect(row.value).not.toContain("30/30");
    });

    it("prints 30/31 for the fayn shape too (window ends 14:15Z, 2026-10-11 empty)", () => {
      const row = cadence({
        windowStart: "2026-10-06T14:15:00Z",
        windowEnd: "2026-11-05T14:15:00Z",
        nArticles: 9_000,
        activeDays: 30,
      });
      expect(row.value).toBe("300 haber/gün · 30/31 gün yayın");
    });

    it("prints 31/31 for a source active on every date the window touches", () => {
      const row = cadence({ ...ROLLING, activeDays: 31 });
      expect(row.value).toBe("20 haber/gün · 31/31 gün yayın");
    });

    it("keeps 30/30 for an aligned window with 30 active days", () => {
      const row = cadence({ ...ALIGNED, activeDays: 30 });
      expect(row.value).toBe("20 haber/gün · 30/30 gün yayın");
      expect(row.how).toBe(HOW_30);
    });

    it("never prints more days than the window spans, even if the row says so", () => {
      // An aligned window cannot hold 31 dates (an article stamped exactly at
      // window_end is the only way to get there), so it is clamped.
      expect(cadence({ ...ALIGNED, activeDays: 31 }).value).toBe("20 haber/gün · 30/30 gün yayın");
    });

    it("leaves the rate on windowDays, not on the date span", () => {
      // 600 / 30 = 20, not 600 / 31.
      expect(cadence({ ...ROLLING, nArticles: 600, activeDays: 30 }).value).toBe(
        "20 haber/gün · 30/31 gün yayın",
      );
    });

    it("prints a low day count against the full span, not against windowDays", () => {
      expect(cadence({ ...ROLLING, nArticles: 3, activeDays: 1 }).value).toBe(
        "0,1 haber/gün · 1/31 gün yayın",
      );
    });

    it("falls back to windowDays when the window instants are unparseable", () => {
      const bad = cadence({ windowStart: "x", windowEnd: "y", activeDays: 31 });
      expect(bad.value).toBe("20 haber/gün · 30/30 gün yayın");
      expect(bad.how).toBe(HOW_30);
      expect(cadence({ windowStart: "x", windowEnd: "y", activeDays: 29 }).value).toBe(
        "20 haber/gün · 29/30 gün yayın",
      );
    });

    it("falls back to windowDays when the window is shorter than windowDays (inconsistent row)", () => {
      // A windowDays-long window always touches at least windowDays dates; a
      // smaller span means the row disagrees with itself, so do not shrink the
      // denominator below the one the rate divides by.
      const row = cadence({
        windowStart: "2026-11-01T15:00:00Z",
        windowEnd: "2026-11-05T15:00:00Z",
        activeDays: 4,
      });
      expect(row.value).toBe("20 haber/gün · 4/30 gün yayın");
      expect(row.how).toBe(HOW_30);
    });

    it("explains a spanning window in the `how` text, with the exact wording", () => {
      expect(cadence({ ...ROLLING, activeDays: 30 }).how).toBe(HOW_31);
    });

    it("keeps today's `how` text when span === windowDays", () => {
      expect(cadence({ ...ALIGNED, activeDays: 30 }).how).toBe(HOW_30);
    });

    it("uses the row's own window length in both the value and the `how` text", () => {
      const row = cadence({
        windowDays: 14,
        windowStart: "2026-10-22T15:00:00Z",
        windowEnd: "2026-11-05T15:00:00Z",
        nArticles: 28,
        activeDays: 14,
      });
      expect(row.value).toBe("2 haber/gün · 14/15 gün yayın");
      expect(row.how).toBe(
        "Son 14 günün haber sayısı 14’a bölünür. Etkin gün, en az bir haber yayımlanan takvim günüdür (Türkiye saati); 14 günlük pencere 15 takvim gününe yayılır, ilk ve son gün kısmidir.",
      );
    });

    it("says nothing about days when there were no articles", () => {
      const row = cadence({ ...ROLLING, nArticles: 0, activeDays: 0, nClusters: 0, nWireCopy: 0 });
      expect(row.value).toBe("Son 30 günde haber yok");
    });

    it("replays the production shape end to end: per-date articles -> active_days -> the card text", () => {
      // Build each source's article instants (one per Istanbul date of the
      // window, minus the empty day), count distinct Istanbul dates the way
      // 111's `count(distinct (published_at at time zone 'Europe/Istanbul')::date)`
      // does, and feed that count through the validator and the view.
      const fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Istanbul",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      const windowStart = "2026-10-06T15:00:00Z"; // 18:00 Istanbul
      const windowEnd = "2026-11-05T15:00:00Z"; // 18:00 Istanbul
      const dates: string[] = [];
      for (let d = 0; d < 31; d++) {
        dates.push(fmt.format(Date.parse("2026-10-06T12:00:00Z") + d * 86_400_000));
      }
      expect(dates[0]).toBe("2026-10-06");
      expect(dates[30]).toBe("2026-11-05");

      const articlesFor = (emptyDate: string | null): number[] =>
        dates
          .filter((date) => date !== emptyDate)
          .map((date) => {
            // The window opens at 18:00 on the first date and closes at 18:00
            // on the last, so pick a time of day inside it for each.
            const time = date === dates[0] ? "20:00" : date === dates[30] ? "10:00" : "12:00";
            return Date.parse(`${date}T${time}:00+03:00`);
          });

      const cadenceFor = (emptyDate: string | null) => {
        const times = articlesFor(emptyDate);
        for (const t of times) {
          expect(t).toBeGreaterThanOrEqual(Date.parse(windowStart));
          expect(t).toBeLessThanOrEqual(Date.parse(windowEnd));
        }
        const activeDays = new Set(times.map((t) => fmt.format(t))).size;
        const row = toSourceReliability(
          raw({
            window_start: windowStart,
            window_end: windowEnd,
            n_articles: times.length * 100,
            active_days: activeDays,
          }),
        )!;
        return { activeDays, cadence: byKey(buildReliabilityView(row, null)).cadence! };
      };

      const haberport = cadenceFor("2026-10-24");
      expect(haberport.activeDays).toBe(30);
      expect(haberport.cadence.value).toBe("100 haber/gün · 30/31 gün yayın");

      const fayn = cadenceFor("2026-10-11");
      expect(fayn.activeDays).toBe(30);
      expect(fayn.cadence.value).toBe("100 haber/gün · 30/31 gün yayın");

      const perfect = cadenceFor(null);
      expect(perfect.activeDays).toBe(31);
      expect(perfect.cadence.value).toBe("103,3 haber/gün · 31/31 gün yayın");
    });
  });

  describe("Başka kaynaklarla aynı başlık ve özet", () => {
    it("claims only what content_hash measures (title + summary), never identical article text", () => {
      const row = byKey(buildReliabilityView(rel(), karneRow())).wire!;
      expect(row.label).toBe("Başka kaynaklarla aynı başlık ve özet");
      expect(row.how).toContain("başlığı ve özeti");
      expect(row.how).toContain("haber gövdesi karşılaştırılmaz");
      // "birebir aynı" describes the title + summary fingerprint; the article
      // text itself is never claimed to be identical.
      expect(`${row.label} ${row.how}`).not.toMatch(/aynı metin|birebir metin|birebir aynı metin/i);
    });

    it("is the any-cluster copy share: no wire gate in the label, the copy or the value", () => {
      const row = byKey(buildReliabilityView(rel(), karneRow())).wire!;
      expect(row.value).toBe("%12 (12/100)");
      expect(row.note).toBeNull();
      expect(row.how).toBe(
        "Kaynağın yer aldığı haber kümelerinden, ilk haberinin başlığı ve özeti başka bir kaynağın haberiyle birebir aynı (aynı parmak izi) olanların payı. Toplayıcı siteler sayılmaz; haber gövdesi karşılaştırılmaz; kimin kimden aldığını belirtmez.",
      );
      expect(row.how).not.toMatch(/Ajans dağıtımı/);
      expect(row.how).toContain("Toplayıcı siteler sayılmaz");
    });

    it("prints the value through formatShare: a non-zero share is never %0, a partial one never %100", () => {
      const wire = (nClusters: number, nWireCopy: number) =>
        byKey(buildReliabilityView(rel({ nClusters, nWireCopy }), karneRow())).wire!;
      expect(wire(2233, 1).value).toBe("<%1 (1/2.233)");
      expect(wire(1165, 8).value).toBe("%1 (8/1.165)");
      expect(wire(2233, 2232).value).toBe(">%99 (2.232/2.233)");
      expect(wire(50, 0).value).toBe("%0 (0/50)");
      expect(wire(50, 50).value).toBe("%100 (50/50)");
    });

    it("is gated below 20 clusters and open at 20", () => {
      const below = byKey(buildReliabilityView(rel({ nClusters: 19, nWireCopy: 5 }), karneRow())).wire!;
      expect(below.value).toBeNull();
      expect(below.note).toBe("Yeterli örnek yok (n = 19, en az 20).");
      const at = byKey(buildReliabilityView(rel({ nClusters: 20, nWireCopy: 5 }), karneRow())).wire!;
      expect(at.value).toBe("%25 (5/20)");
      expect(at.note).toBeNull();
    });

    it("does not depend on the karne row", () => {
      const row = byKey(buildReliabilityView(rel(), null)).wire!;
      expect(row.value).toBe("%12 (12/100)");
    });

    it("groups four-digit counts: %3 (48/1.749)", () => {
      const row = byKey(buildReliabilityView(rel({ nClusters: 1749, nWireCopy: 48 }), karneRow())).wire!;
      expect(row.value).toBe("%3 (48/1.749)");
    });
  });

  describe("Kör nokta kümelerindeki payı", () => {
    it("comes from the karne row (nBlindspot / nClusters), not from the reliability row", () => {
      const row = byKey(buildReliabilityView(rel({ nClusters: 40 }), karneRow())).blindspot!;
      expect(row.value).toBe("%5 (6/120)");
      expect(row.note).toBeNull();
      expect(row.how).toBe(
        "Kaynağın yer aldığı haber kümelerinden kör nokta olarak işaretlenenlerin payı (Kapsama karnesiyle aynı sayım).",
      );
    });

    it("prints the share through formatShare as well (a non-zero count is never %0)", () => {
      const k = karneRow({ n_clusters: 2233, n_multi: 100, co_iktidar: 10, co_bagimsiz: 10, co_muhalefet: 10, n_blindspot: 1, n_blindspot_same_side: 0 });
      const row = byKey(buildReliabilityView(rel(), k)).blindspot!;
      expect(row.value).toBe("<%1 (1/2.233)");
    });

    it("explains a missing karne row", () => {
      const row = byKey(buildReliabilityView(rel(), null)).blindspot!;
      expect(row.value).toBeNull();
      expect(row.note).toBe("Kapsama karnesi henüz hesaplanmadı.");
    });

    it("is gated on the karne's cluster count: 19 closed, 20 open", () => {
      const below = byKey(buildReliabilityView(rel(), karneRow({ n_clusters: 19, n_multi: 5, co_iktidar: 1, co_bagimsiz: 1, co_muhalefet: 1 }))).blindspot!;
      expect(below.value).toBeNull();
      expect(below.note).toBe("Yeterli örnek yok (n = 19, en az 20).");
      const at = byKey(buildReliabilityView(rel(), karneRow({ n_clusters: 20, n_multi: 5, co_iktidar: 1, co_bagimsiz: 1, co_muhalefet: 1, n_blindspot: 1, n_blindspot_same_side: 0 }))).blindspot!;
      expect(at.value).toBe("%5 (1/20)");
    });

    it("groups the karne's four-digit counts in the share and the basis", () => {
      const row = byKey(
        buildReliabilityView(
          rel(),
          karneRow({ n_clusters: 1749, n_multi: 1055, co_iktidar: 1, co_bagimsiz: 1, co_muhalefet: 1, n_blindspot: 1048, n_blindspot_same_side: 1002 }),
        ),
      ).blindspot!;
      expect(row.value).toBe("%60 (1.048/1.749)");
      expect(row.basis).toContain("1.749 haber kümesi");
    });

    it("shows 0 blindspot clusters as %0", () => {
      const row = byKey(buildReliabilityView(rel(), karneRow({ n_blindspot: 0, n_blindspot_same_side: 0 }))).blindspot!;
      expect(row.value).toBe("%0 (0/120)");
    });

    it("names the karne snapshot it divides by: window_end in Istanbul time and its cluster count", () => {
      const row = byKey(buildReliabilityView(rel(), karneRow())).blindspot!;
      expect(row.basis).toBe(
        "Oran, Kapsama karnesinin 29.09.2026 03:00 itibarıyla saydığı 120 haber kümesi üzerinden hesaplanır.",
      );
    });

    it("uses the karne's own count and window, not the reliability row's (the h18 prod shape)", () => {
      const row = byKey(
        buildReliabilityView(
          rel({ nClusters: 244, windowEnd: "2026-11-01T06:45:00.000Z" }),
          karneRow({ n_clusters: 149, window_end: "2026-11-01T22:45:00.000Z" }),
        ),
      ).blindspot!;
      expect(row.basis).toBe(
        "Oran, Kapsama karnesinin 02.11.2026 01:45 itibarıyla saydığı 149 haber kümesi üzerinden hesaplanır.",
      );
    });

    it("groups a four-digit karne count the Turkish way", () => {
      const row = byKey(buildReliabilityView(rel(), karneRow({ n_clusters: 1200, n_multi: 60 }))).blindspot!;
      expect(row.basis).toContain("saydığı 1.200 haber kümesi üzerinden");
    });

    it("keeps the basis next to the insufficient-sample note (karne present, below the floor)", () => {
      const row = byKey(buildReliabilityView(rel(), karneRow({ n_clusters: 19, n_multi: 5, co_iktidar: 1, co_bagimsiz: 1, co_muhalefet: 1 }))).blindspot!;
      expect(row.value).toBeNull();
      expect(row.basis).toBe(
        "Oran, Kapsama karnesinin 29.09.2026 03:00 itibarıyla saydığı 19 haber kümesi üzerinden hesaplanır.",
      );
    });

    it("drops the itibarıyla segment instead of printing an empty date", () => {
      const row = byKey(
        buildReliabilityView(rel(), { ...karneRow(), windowEnd: "x" }),
      ).blindspot!;
      expect(row.basis).toBe(
        "Oran, Kapsama karnesinin saydığı 120 haber kümesi üzerinden hesaplanır.",
      );
    });

    it("has no basis when the karne row is missing", () => {
      expect(byKey(buildReliabilityView(rel(), null)).blindspot!.basis).toBeNull();
    });
  });

  describe("basis on the other rows", () => {
    it("is null on cadence, wire and diversity, with or without a karne", () => {
      for (const k of [karneRow(), null]) {
        const rows = byKey(buildReliabilityView(rel(), k));
        expect(rows.cadence!.basis).toBeNull();
        expect(rows.wire!.basis).toBeNull();
        expect(rows.diversity!.basis).toBeNull();
      }
    });

    it("every row carries the field explicitly (string or null, never undefined)", () => {
      for (const r of buildReliabilityView(rel(), karneRow())) {
        expect(r.basis === null || typeof r.basis === "string").toBe(true);
      }
    });
  });

  describe("Bölge çeşitliliği", () => {
    it("is the weighted mean Denge puanı with its cluster count", () => {
      const row = byKey(
        buildReliabilityView(
          rel({ zoneMix: [[2, 2, 2, 10]] }),
          karneRow(),
        ),
      ).diversity!;
      expect(row.value).toBe("Ortalama Denge puanı 100/100 (n = 10 küme)");
      expect(row.note).toBeNull();
      expect(row.how).toBe(
        "En az 5 oy veren kaynağı olan kümelerin Denge puanı ortalaması (0 tek bölge, 100 üç bölgeye eşit).",
      );
    });

    it("groups a four-digit cluster count: n = 1.234 küme", () => {
      const row = byKey(buildReliabilityView(rel({ zoneMix: [[2, 2, 2, 1234]] }), null)).diversity!;
      expect(row.value).toBe("Ortalama Denge puanı 100/100 (n = 1.234 küme)");
    });

    it("is gated at 9 clusters and open at 10", () => {
      const below = byKey(buildReliabilityView(rel({ zoneMix: [[2, 2, 2, 9]] }), null)).diversity!;
      expect(below.value).toBeNull();
      expect(below.note).toBe("Yeterli örnek yok (n = 9, en az 10).");
      const at = byKey(buildReliabilityView(rel({ zoneMix: [[2, 2, 2, 10]] }), null)).diversity!;
      expect(at.value).not.toBeNull();
    });

    it("counts only clusters with enough votes toward the gate", () => {
      const row = byKey(
        buildReliabilityView(rel({ zoneMix: [[1, 1, 1, 50], [2, 2, 2, 4]] }), null),
      ).diversity!;
      expect(row.value).toBeNull();
      expect(row.note).toBe("Yeterli örnek yok (n = 4, en az 10).");
    });

    it("an empty mix is n = 0", () => {
      const row = byKey(buildReliabilityView(rel({ zoneMix: [] }), null)).diversity!;
      expect(row.value).toBeNull();
      expect(row.note).toBe("Yeterli örnek yok (n = 0, en az 10).");
    });
  });

  it("every row has either a value or a note, never both", () => {
    for (const r of buildReliabilityView(rel({ nClusters: 5, nWireCopy: 1, zoneMix: [] }), null)) {
      expect((r.value === null) !== (r.note === null)).toBe(true);
    }
  });

  // migration 212 (h174-latency-1): a feed that holds only its newest N items
  // and lost some of them inside the last 7 days publishes MORE than Tayf
  // stored, so the daily rate is a floor, not a measurement. The one row that
  // counts articles says so; with the flag off nothing changes.
  describe("Yayın sıklığı: the feed window overflowed in the last 7 days (migration 212)", () => {
    const NOTE =
      "Bu kaynağın RSS akışı her seferinde yalnızca son haberleri veriyor ve son 7 günde bu sınır aşıldı; bazı haberleri Tayf'a ulaşmadı, bu yüzden sayı en az değerdir.";
    const cadenceOf = (rows: ReturnType<typeof buildReliabilityView>) => rows.find((r) => r.key === "cadence")!;

    it("true: the value is prefixed with 'en az ' and the row carries the note", () => {
      const row = cadenceOf(buildReliabilityView(rel(), karneRow(), { windowOverflowRecent: true }));
      expect(row.value).toBe("en az 20 haber/gün · 30/30 gün yayın");
      expect(row.note).toBe(NOTE);
    });

    it("true: haberport's real shape (518,4 a day) reads 'en az 518,4 haber/gün · 30/31 gün yayın'", () => {
      const row = cadenceOf(
        buildReliabilityView(
          rel({
            nArticles: 15552,
            activeDays: 30,
            windowStart: "2026-10-06T15:00:00Z",
            windowEnd: "2026-11-05T15:00:00Z",
          }),
          null,
          { windowOverflowRecent: true },
        ),
      );
      expect(row.value).toBe("en az 518,4 haber/gün · 30/31 gün yayın");
    });

    it("false: the output is identical to the call without the option, value, note and how", () => {
      const plain = buildReliabilityView(rel(), karneRow());
      expect(buildReliabilityView(rel(), karneRow(), { windowOverflowRecent: false })).toEqual(plain);
      expect(buildReliabilityView(rel(), karneRow(), {})).toEqual(plain);
      expect(buildReliabilityView(rel(), karneRow(), undefined)).toEqual(plain);
      const row = cadenceOf(plain);
      expect(row.value).toBe("20 haber/gün · 30/30 gün yayın");
      expect(row.note).toBeNull();
    });

    it("true changes the cadence row only: the other three rows are the same objects' content", () => {
      const plain = buildReliabilityView(rel(), karneRow());
      const flagged = buildReliabilityView(rel(), karneRow(), { windowOverflowRecent: true });
      expect(flagged.map((r) => r.key)).toEqual(plain.map((r) => r.key));
      expect(flagged.slice(1)).toEqual(plain.slice(1));
      expect(cadenceOf(flagged).label).toBe(cadenceOf(plain).label);
      expect(cadenceOf(flagged).how).toBe(cadenceOf(plain).how);
      expect(cadenceOf(flagged).basis).toBeNull();
    });

    it("true with the tiny-rate floor: 'en az <0,1 haber/gün ...' (a floor of a floor is still a floor)", () => {
      const row = cadenceOf(buildReliabilityView(rel({ nArticles: 1, activeDays: 1 }), null, { windowOverflowRecent: true }));
      expect(row.value).toBe("en az <0,1 haber/gün · 1/30 gün yayın");
    });

    it("true with no articles in the window: nothing to floor, so the 'no articles' line and no note", () => {
      const row = cadenceOf(
        buildReliabilityView(rel({ nArticles: 0, activeDays: 0, nClusters: 0, nWireCopy: 0 }), null, {
          windowOverflowRecent: true,
        }),
      );
      expect(row.value).toBe("Son 30 günde haber yok");
      expect(row.note).toBeNull();
    });

    it("a truthy non-boolean is not the flag: only `true` prefixes", () => {
      for (const v of [1, "true", {}, [] as unknown]) {
        const rows = buildReliabilityView(rel(), karneRow(), { windowOverflowRecent: v as boolean });
        expect(cadenceOf(rows).value, String(v)).toBe("20 haber/gün · 30/30 gün yayın");
      }
    });

    it("the note is one sentence in Turkish that says why the number is a floor, and names no url or time", () => {
      expect(NOTE).toContain("en az değerdir");
      expect(NOTE).toContain("son 7 günde");
      const row = cadenceOf(buildReliabilityView(rel(), karneRow(), { windowOverflowRecent: true }));
      expect(row.note).not.toContain("http");
    });
  });
});

// ---------------------------------------------------------------------------
// Fetcher: a user-facing point lookup under the 4 s reader cap, a failed cache
// attempt memoised for "minutes" only, a success for "hours".
// ---------------------------------------------------------------------------

describe("getSourceReliability", () => {
  it("maps a hit and reads source_reliability_30d through the capped reader client", async () => {
    fixture.data = raw();
    const r = await getSourceReliability(ID);
    expect(r).toMatchObject({ nArticles: 600, nClusters: 100, nWireCopy: 12 });
    expect(fixture.tables.every((t) => t === "source_reliability_30d")).toBe(true);
    expect(fixture.readerClients).toBeGreaterThan(0);
  });

  it("tags the cache entry 'sources'", async () => {
    fixture.data = raw();
    await getSourceReliability(ID);
    expect(cacheTag).toHaveBeenCalledWith("sources");
  });

  it("returns null for a non-uuid id without touching the database or the cache", async () => {
    expect(await getSourceReliability("not-a-uuid")).toBeNull();
    expect(await getSourceReliability("")).toBeNull();
    expect(await getSourceReliability(undefined as unknown as string)).toBeNull();
    expect(fixture.calls).toBe(0);
    expect(fixture.readerClients).toBe(0);
    expect(cacheLife).not.toHaveBeenCalled();
  });

  it("returns null for a missing row", async () => {
    fixture.data = null;
    expect(await getSourceReliability(ID)).toBeNull();
  });

  it("returns null for an inconsistent row", async () => {
    fixture.data = raw({ n_wire_copy: 999 });
    expect(await getSourceReliability(ID)).toBeNull();
  });

  it("returns null and does not throw when both the cache attempt and the live retry fail", async () => {
    fixture.error = { message: "boom" };
    await expect(getSourceReliability(ID)).resolves.toBeNull();
    expect(fixture.calls).toBe(2);
  });

  it("a blip on the cache attempt is healed by the live retry", async () => {
    fixture.data = raw();
    fixture.failFirst = 1;
    const r = await getSourceReliability(ID);
    expect(fixture.calls).toBe(2);
    expect(r?.nClusters).toBe(100);
  });

  it("a 9-day-old row is stale with ageDays 9", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T06:00:00Z"));
    fixture.data = raw({ computed_at: "2026-09-29T06:00:00Z" });
    expect(await getSourceReliability(ID)).toMatchObject({ isStale: true, ageDays: 9 });
  });

  it("a fresh row is not stale", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-29T18:00:00Z"));
    fixture.data = raw({ computed_at: "2026-09-29T06:00:00Z" });
    expect(await getSourceReliability(ID)).toMatchObject({ isStale: false, ageDays: 0 });
  });
});

describe("getSourceReliability cache lifetime", () => {
  it("a missing row is a legitimate result: cacheLife hours, exactly once", async () => {
    fixture.data = null;
    await expect(getSourceReliability(ID)).resolves.toBeNull();
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("hours");
  });

  it("a hit never uses the short failure lifetime", async () => {
    fixture.data = raw();
    await getSourceReliability(ID);
    expect(cacheLife).toHaveBeenCalledWith("hours");
    expect(cacheLife).not.toHaveBeenCalledWith("minutes");
  });

  it("a failed attempt (cache attempt AND retry fail) calls cacheLife exactly once, with minutes, and returns null", async () => {
    fixture.error = { message: "AbortError: Supabase request exceeded 4000 ms" };
    await expect(getSourceReliability(ID)).resolves.toBeNull();
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("a blip that the live retry heals still caches the failed attempt for minutes only", async () => {
    fixture.data = raw();
    fixture.failFirst = 1;
    const r = await getSourceReliability(ID);
    expect(r?.nClusters).toBe(100);
    expect(vi.mocked(cacheLife).mock.calls.filter((c) => c[0] === "minutes")).toHaveLength(1);
  });
});
