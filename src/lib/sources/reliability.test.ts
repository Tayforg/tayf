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
  toSourceReliability,
  type SourceReliability,
} from "./reliability";

const ID = "9236e05a-56d9-47b0-a378-02ec8e880180";

function raw(over: Record<string, unknown> = {}) {
  return {
    source_id: ID,
    window_days: 30,
    window_start: "2026-08-30T00:00:00Z",
    window_end: "2026-09-29T00:00:00Z",
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
      windowStart: "2026-08-30T00:00:00Z",
      windowEnd: "2026-09-29T00:00:00Z",
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

    it("clamps active_days = window_days + 1 to the window for display", () => {
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
        buildReliabilityView(rel({ windowDays: 14, nArticles: 28, activeDays: 14 }), null),
      ).cadence!;
      expect(row.value).toBe("2 haber/gün · 14/14 gün yayın");
      expect(row.how).toContain("Son 14 günün");
    });
  });

  describe("Başka kaynaklarla aynı başlık ve özet", () => {
    it("claims only what content_hash measures (title + summary), never identical article text", () => {
      const row = byKey(buildReliabilityView(rel(), karneRow())).wire!;
      expect(row.label).toBe("Başka kaynaklarla aynı başlık ve özet");
      expect(row.how).toContain("başlığı ve özeti");
      expect(row.how).toContain("haber gövdesi karşılaştırılmaz");
      expect(`${row.label} ${row.how}`).not.toMatch(/birebir|aynı metin/i);
    });

    it("is the wire-copy share of clusters", () => {
      const row = byKey(buildReliabilityView(rel(), karneRow())).wire!;
      expect(row.value).toBe("%12 (12/100)");
      expect(row.note).toBeNull();
      expect(row.how).toBe(
        "Ajans dağıtımı sayılan kümelerde başlığı ve özeti başka bir kaynakla aynı olan haberlerin payı (haber gövdesi karşılaştırılmaz); yön belirtmez.",
      );
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

    it("shows 0 blindspot clusters as %0", () => {
      const row = byKey(buildReliabilityView(rel(), karneRow({ n_blindspot: 0, n_blindspot_same_side: 0 }))).blindspot!;
      expect(row.value).toBe("%0 (0/120)");
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
