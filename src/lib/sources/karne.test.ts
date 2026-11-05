import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const fixture = vi.hoisted(() => ({
  data: null as unknown,
  error: null as { message: string } | null,
  /** Fail this many calls with `error`-like "boom", then serve `data`. */
  failFirst: 0,
  calls: 0,
  /** The options object each `createClient(url, key, opts)` call received. */
  clientOpts: [] as unknown[],
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      source_karne_30d: () => {
        fixture.calls += 1;
        if (fixture.failFirst > 0) {
          fixture.failFirst -= 1;
          return { data: null, error: { message: "boom" } };
        }
        return { data: fixture.data, error: fixture.error };
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

import { cacheLife } from "next/cache";
import {
  KARNE_MIN_CLUSTERS,
  KARNE_MIN_MULTI_FOR_ZONES,
  KARNE_STALE_AFTER_HOURS,
  KARNE_WINDOW_DAYS,
  buildKarneView,
  clusterCountLine,
  formatAsOfTr,
  getSourceKarne,
  karneFreshness,
  pct,
  toSourceKarne,
  type SourceKarne,
} from "./karne";

const ID = "9236e05a-56d9-47b0-a378-02ec8e880180";

function raw(over: Record<string, unknown> = {}) {
  return {
    source_id: ID,
    window_days: 30,
    window_start: "2026-08-30T00:00:00Z",
    window_end: "2026-09-29T00:00:00Z",
    n_clusters: 100,
    n_multi: 60,
    co_iktidar: 40,
    co_bagimsiz: 30,
    co_muhalefet: 20,
    n_blindspot: 5,
    n_blindspot_same_side: 2,
    computed_at: "2026-09-29T00:00:00Z",
    ...over,
  };
}

function karne(over: Partial<SourceKarne> = {}): SourceKarne {
  return { ...toSourceKarne(raw())!, ...over };
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.data = null;
  fixture.error = null;
  fixture.failFirst = 0;
  fixture.calls = 0;
  fixture.clientOpts = [];
  vi.mocked(cacheLife).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

describe("constants", () => {
  it("pins the thresholds", () => {
    expect(KARNE_WINDOW_DAYS).toBe(30);
    expect(KARNE_MIN_CLUSTERS).toBe(20);
    expect(KARNE_MIN_MULTI_FOR_ZONES).toBe(10);
    expect(KARNE_STALE_AFTER_HOURS).toBe(48);
  });
});

describe("toSourceKarne", () => {
  it("maps a valid row and derives nSolo", () => {
    const k = toSourceKarne(raw())!;
    expect(k).toMatchObject({
      windowDays: 30,
      nClusters: 100,
      nMulti: 60,
      nSolo: 40,
      co: { iktidar: 40, bagimsiz: 30, muhalefet: 20 },
      nBlindspot: 5,
      nBlindspotSameSide: 2,
      windowStart: "2026-08-30T00:00:00Z",
      windowEnd: "2026-09-29T00:00:00Z",
      computedAt: "2026-09-29T00:00:00Z",
    });
  });

  it("keeps the v1 profile contract: no freshness fields on the validated row", () => {
    const k = toSourceKarne(raw())!;
    expect(k).not.toHaveProperty("isStale");
    expect(k).not.toHaveProperty("ageDays");
  });

  it.each([
    ["null", null],
    ["string", "x"],
    ["negative count", raw({ n_clusters: -1 })],
    ["NaN", raw({ n_multi: Number.NaN })],
    ["non-integer", raw({ n_multi: 1.5 })],
    ["string count", raw({ n_multi: "3" })],
    ["nMulti > nClusters", raw({ n_multi: 101 })],
    ["co > nMulti", raw({ co_iktidar: 61 })],
    ["same-side > blindspot", raw({ n_blindspot_same_side: 6 })],
    ["missing dates", raw({ window_start: null })],
  ])("rejects %s", (_n, input) => {
    expect(toSourceKarne(input)).toBeNull();
  });
});

describe("karneFreshness", () => {
  const NOW = Date.parse("2026-10-22T12:00:00Z");
  const ago = (ms: number) => new Date(NOW - ms).toISOString();

  it("47 h old is not stale and rounds down to 1 day", () => {
    expect(karneFreshness(ago(47 * HOUR_MS), NOW)).toEqual({ isStale: false, ageDays: 1 });
  });

  it("49 h old is stale and is 2 days", () => {
    expect(karneFreshness(ago(49 * HOUR_MS), NOW)).toEqual({ isStale: true, ageDays: 2 });
  });

  it("is stale strictly after 48 h (exactly 48 h is still fresh)", () => {
    expect(karneFreshness(ago(48 * HOUR_MS), NOW)).toEqual({ isStale: false, ageDays: 2 });
    expect(karneFreshness(ago(48 * HOUR_MS + 1), NOW)).toEqual({ isStale: true, ageDays: 2 });
  });

  it("9 days old gives ageDays 9", () => {
    expect(karneFreshness(ago(9 * DAY_MS), NOW)).toEqual({ isStale: true, ageDays: 9 });
  });

  it("a brand-new row is fresh at 0 days", () => {
    expect(karneFreshness(ago(0), NOW)).toEqual({ isStale: false, ageDays: 0 });
  });

  it("a future computed_at (clock skew) clamps to 0 days and is not stale", () => {
    expect(karneFreshness(new Date(NOW + 3 * DAY_MS).toISOString(), NOW)).toEqual({
      isStale: false,
      ageDays: 0,
    });
  });

  it.each([["garbage"], [""], ["2026-13-45"]])(
    "unparseable input %j is not stale and 0 days",
    (input) => {
      expect(karneFreshness(input, NOW)).toEqual({ isStale: false, ageDays: 0 });
    },
  );
});

describe("formatAsOfTr", () => {
  it("renders dd.mm.yyyy HH:mm in Europe/Istanbul (UTC+3)", () => {
    expect(formatAsOfTr("2026-11-01T22:45:00.000Z")).toBe("02.11.2026 01:45");
    expect(formatAsOfTr("2026-11-01T06:45:00Z")).toBe("01.11.2026 09:45");
  });

  it("uses a 24-hour clock: midnight is 00, not 24", () => {
    expect(formatAsOfTr("2026-11-01T21:05:00Z")).toBe("02.11.2026 00:05");
  });

  it("follows the Istanbul calendar day across the UTC date line", () => {
    expect(formatAsOfTr("2026-12-31T21:30:00Z")).toBe("01.01.2027 00:30");
  });

  it("returns an empty string for unparseable or empty input", () => {
    expect(formatAsOfTr("x")).toBe("");
    expect(formatAsOfTr("")).toBe("");
  });
});

describe("clusterCountLine", () => {
  it("states the window, the as-of instant and exactly what is counted", () => {
    expect(clusterCountLine(30, "2026-11-01T22:45:00.000Z", 1200)).toBe(
      "Son 30 gün · 02.11.2026 01:45 itibarıyla · bu kaynağın en az bir haberinin bulunduğu 1.200 haber kümesi",
    );
  });

  it("groups the count the Turkish way and never writes n =", () => {
    const small = clusterCountLine(30, "2026-11-01T22:45:00.000Z", 149);
    expect(small).toContain("bulunduğu 149 haber kümesi");
    expect(small).not.toContain("n =");
    expect(clusterCountLine(30, "2026-11-01T22:45:00.000Z", 10000)).toContain(
      "bulunduğu 10.000 haber kümesi",
    );
  });

  it("uses the row's own windowDays", () => {
    expect(clusterCountLine(14, "2026-11-01T22:45:00.000Z", 5).startsWith("Son 14 gün · ")).toBe(true);
  });

  it("drops the itibarıyla segment when the date is unparseable", () => {
    expect(clusterCountLine(30, "x", 7)).toBe(
      "Son 30 gün · bu kaynağın en az bir haberinin bulunduğu 7 haber kümesi",
    );
  });
});

describe("pct", () => {
  it("rounds and handles den = 0", () => {
    expect(pct(1, 3)).toBe(33);
    expect(pct(2, 3)).toBe(67);
    expect(pct(0, 0)).toBeNull();
    expect(pct(5, 0)).toBeNull();
  });
});

describe("buildKarneView", () => {
  it("is insufficient at 19 and ok at 20", () => {
    expect(buildKarneView(karne({ nClusters: 19, nMulti: 5, nSolo: 14 }))).toEqual({
      state: "insufficient",
      n: 19,
    });
    expect(
      buildKarneView(karne({ nClusters: 20, nMulti: 10, nSolo: 10 })).state,
    ).toBe("ok");
  });

  it("hides zones at nMulti = 9 and shows them at 10", () => {
    const co = { iktidar: 1, bagimsiz: 1, muhalefet: 1 };
    const low = buildKarneView(karne({ nClusters: 30, nMulti: 9, nSolo: 21, co }));
    const high = buildKarneView(karne({ nClusters: 30, nMulti: 10, nSolo: 20, co }));
    expect(low.state === "ok" && low.zones).toBeNull();
    expect(high.state === "ok" && high.zones).not.toBeNull();
  });

  it("rounds percentages (1/3 gives %33) and orders zones by spectrum", () => {
    const v = buildKarneView(
      karne({
        nClusters: 30,
        nMulti: 10,
        nSolo: 20,
        co: { iktidar: 3, bagimsiz: 5, muhalefet: 10 },
      }),
    );
    if (v.state !== "ok") throw new Error("expected ok");
    expect(v.multiText).toBe("%33 (10/30)");
    expect(v.soloText).toBe("%67 (20/30)");
    expect(v.zones!.map((z) => z.zone)).toEqual(["iktidar", "bagimsiz", "muhalefet"]);
    expect(v.zones!.map((z) => z.text)).toEqual(["%30 (3/10)", "%50 (5/10)", "%100 (10/10)"]);
  });

  it("appends the same-side clause only when nBlindspot > 0", () => {
    const some = buildKarneView(karne({ nBlindspot: 4, nBlindspotSameSide: 1 }));
    const none = buildKarneView(karne({ nBlindspot: 0, nBlindspotSameSide: 0 }));
    if (some.state !== "ok" || none.state !== "ok") throw new Error("expected ok");
    expect(some.blindspotText).toBe(
      "Kör nokta işaretli haberler: 4 · 1 tanesinde haberi ağırlıkla yazan bölgedeydi",
    );
    expect(none.blindspotText).toBe("Kör nokta işaretli haberler: 0");
  });

  // h37-content-2: for aggregator / niche sources migration 106 derives
  // own_zone from the bias label, so "yazan bölgedeydi" would compare the
  // cluster's blindspot side with a zone the source never voted in.
  describe("voting option", () => {
    const haberler = karne({ nClusters: 400, nMulti: 300, nSolo: 100, nBlindspot: 153, nBlindspotSameSide: 129 });

    it("{ voting: false } drops the same-side clause and keeps the count", () => {
      const v = buildKarneView(haberler, { voting: false });
      if (v.state !== "ok") throw new Error("expected ok");
      expect(v.blindspotText).toBe("Kör nokta işaretli haberler: 153");
      expect(v.blindspotText).not.toContain("yazan bölgedeydi");
    });

    it("the default stays byte-identical (the clause is kept)", () => {
      const v = buildKarneView(haberler);
      if (v.state !== "ok") throw new Error("expected ok");
      expect(v.blindspotText).toBe(
        "Kör nokta işaretli haberler: 153 · 129 tanesinde haberi ağırlıkla yazan bölgedeydi",
      );
    });

    it("{ voting: true } and an empty options object equal the default", () => {
      expect(buildKarneView(haberler, { voting: true })).toEqual(buildKarneView(haberler));
      expect(buildKarneView(haberler, {})).toEqual(buildKarneView(haberler));
    });

    it("{ voting: false } changes nothing but blindspotText", () => {
      const voting = buildKarneView(haberler);
      const nonVoting = buildKarneView(haberler, { voting: false });
      if (voting.state !== "ok" || nonVoting.state !== "ok") throw new Error("expected ok");
      expect(nonVoting).toEqual({ ...voting, blindspotText: "Kör nokta işaretli haberler: 153" });
    });

    it("{ voting: false } leaves the insufficient state and a zero-blindspot source alone", () => {
      const small = karne({ nClusters: 19, nMulti: 5, nSolo: 14 });
      expect(buildKarneView(small, { voting: false })).toEqual(buildKarneView(small));
      const none = buildKarneView(karne({ nBlindspot: 0, nBlindspotSameSide: 0 }), { voting: false });
      if (none.state !== "ok") throw new Error("expected ok");
      expect(none.blindspotText).toBe("Kör nokta işaretli haberler: 0");
    });
  });

  // Counts of four digits or more are grouped the way the subtitle already
  // groups the cluster count ("1.749 haber kümesi"); the shares used to print
  // raw "1055/1749" in the same card.
  describe("groups four-digit counts with the tr-TR dot", () => {
    const big = karne({
      nClusters: 1749,
      nMulti: 1055,
      nSolo: 694,
      co: { iktidar: 900, bagimsiz: 500, muhalefet: 1000 },
      nBlindspot: 1048,
      nBlindspotSameSide: 1002,
    });

    it("writes the multi and solo shares as %60 (1.055/1.749) and %40 (694/1.749)", () => {
      const v = buildKarneView(big);
      if (v.state !== "ok") throw new Error("expected ok");
      expect(v.multiText).toBe("%60 (1.055/1.749)");
      expect(v.soloText).toBe("%40 (694/1.749)");
    });

    it("groups the zone shares, header and insufficient text", () => {
      const v = buildKarneView(big);
      if (v.state !== "ok") throw new Error("expected ok");
      expect(v.zones!.map((z) => z.text)).toEqual([
        "%85 (900/1.055)",
        "%47 (500/1.055)",
        "%95 (1.000/1.055)",
      ]);
      expect(v.zoneHeader).toContain("(1.055 çok kaynaklı haber)");
      expect(v.zonesInsufficientText).toContain("n = 1.055");
      expect(v.zonesInsufficientText).toContain("en az 10");
    });

    it("groups both blindspot counts", () => {
      const v = buildKarneView(big);
      if (v.state !== "ok") throw new Error("expected ok");
      expect(v.blindspotText).toBe(
        "Kör nokta işaretli haberler: 1.048 · 1.002 tanesinde haberi ağırlıkla yazan bölgedeydi",
      );
    });

    it("keeps counts below 1.000 ungrouped", () => {
      const v = buildKarneView(karne({ nClusters: 999, nMulti: 500, nSolo: 499 }));
      if (v.state !== "ok") throw new Error("expected ok");
      expect(v.multiText).toBe("%50 (500/999)");
    });
  });
});

describe("getSourceKarne", () => {
  it("maps a hit", async () => {
    fixture.data = raw();
    const k = await getSourceKarne(ID);
    expect(k?.nClusters).toBe(100);
    expect(fixture.calls).toBeGreaterThan(0);
  });

  it("a 9-day-old row is stale with ageDays 9", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T06:00:00Z"));
    fixture.data = raw({ computed_at: "2026-09-29T06:00:00Z" });
    const k = await getSourceKarne(ID);
    expect(k).toMatchObject({ isStale: true, ageDays: 9, nClusters: 100 });
  });

  it("a fresh row is not stale", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-29T18:00:00Z"));
    fixture.data = raw({ computed_at: "2026-09-29T06:00:00Z" });
    const k = await getSourceKarne(ID);
    expect(k).toMatchObject({ isStale: false, ageDays: 0 });
  });

  it("still computes freshness on the live-retry path (cache attempt fails, retry succeeds)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T06:00:00Z"));
    fixture.data = raw({ computed_at: "2026-09-29T06:00:00Z" });
    fixture.failFirst = 1;
    const k = await getSourceKarne(ID);
    expect(fixture.calls).toBe(2);
    expect(k).toMatchObject({ isStale: true, ageDays: 9 });
  });

  it("returns null for a missing row", async () => {
    fixture.data = null;
    expect(await getSourceKarne(ID)).toBeNull();
  });

  it("returns null for an inconsistent row", async () => {
    fixture.data = raw({ n_multi: 999 });
    expect(await getSourceKarne(ID)).toBeNull();
  });

  it("returns null and does not throw when both cache attempt and retry fail", async () => {
    fixture.error = { message: "boom" };
    await expect(getSourceKarne(ID)).resolves.toBeNull();
    expect(fixture.calls).toBe(2);
  });

  it("returns null for a non-uuid id without touching the DB", async () => {
    expect(await getSourceKarne("not-a-uuid")).toBeNull();
    expect(await getSourceKarne("")).toBeNull();
    expect(fixture.calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cold-read resilience: the karne read is a user-facing point lookup, so it
// runs under the 4 s reader cap, and a failed cache attempt is memoised for
// "minutes" only (a success keeps the "hours" lifetime).
//
// `getKarneFreshnessCached` is a second, clock-only "use cache" function that
// also calls cacheLife("hours") when a row exists; the "exactly once"
// assertions below therefore use the cases where it does not run (missing row,
// outage), and the others assert on the call set.
// ---------------------------------------------------------------------------

/** A capped client is built with a custom `global.fetch`; a plain one is not. */
function isCappedClientOpts(opts: unknown): boolean {
  const g = (opts as { global?: { fetch?: unknown } } | undefined)?.global;
  return typeof g?.fetch === "function";
}

describe("getSourceKarne reader cap", () => {
  it("builds a capped reader client", async () => {
    fixture.data = raw();
    await getSourceKarne(ID);
    expect(fixture.clientOpts).toHaveLength(1);
    expect(isCappedClientOpts(fixture.clientOpts[0])).toBe(true);
  });

  it("the live retry after a failed cache attempt is capped too", async () => {
    fixture.data = raw();
    fixture.failFirst = 1;
    await getSourceKarne(ID);
    expect(fixture.clientOpts).toHaveLength(2);
    expect(fixture.clientOpts.every(isCappedClientOpts)).toBe(true);
  });
});

describe("getSourceKarne cache lifetime", () => {
  it("a missing row is a legitimate result: cacheLife hours, exactly once", async () => {
    fixture.data = null;
    await expect(getSourceKarne(ID)).resolves.toBeNull();
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("hours");
  });

  it("a hit never uses the short failure lifetime", async () => {
    fixture.data = raw();
    await getSourceKarne(ID);
    expect(cacheLife).toHaveBeenCalledWith("hours");
    expect(cacheLife).not.toHaveBeenCalledWith("minutes");
  });

  it("a timeout (cache attempt AND retry fail) calls cacheLife exactly once, with minutes, and returns null", async () => {
    fixture.error = {
      message: "AbortError: Supabase request exceeded 4000 ms",
    };
    await expect(getSourceKarne(ID)).resolves.toBeNull();
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("a blip that the live retry heals still caches the failed attempt for minutes only", async () => {
    fixture.data = raw();
    fixture.failFirst = 1;
    const k = await getSourceKarne(ID);
    expect(k?.nClusters).toBe(100);
    expect(vi.mocked(cacheLife).mock.calls.filter((c) => c[0] === "minutes")).toHaveLength(1);
  });

  it("a non-uuid id touches neither the cache nor the database", async () => {
    await expect(getSourceKarne("not-a-uuid")).resolves.toBeNull();
    expect(cacheLife).not.toHaveBeenCalled();
    expect(fixture.clientOpts).toHaveLength(0);
  });
});
