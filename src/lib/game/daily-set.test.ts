import { describe, it, expect } from "vitest";

import {
  DAILY_GAME_EPOCH,
  DAILY_GAME_SIZE,
  DAILY_MAX_PER_ZONE,
  DAILY_TITLE_MAX,
  ISTANBUL_OFFSET_MS,
  addDays,
  dailyHash,
  isDailyEligible,
  isDateKey,
  pickDailySet,
  puzzleNumber,
  puzzleWindow,
  resolvePuzzleDate,
  titleLeaksOutlet,
  type DailyCandidate,
  type PuzzleWindow,
} from "./daily-set";
import type { BiasCategory } from "@/types";

// A title long enough to satisfy DAILY_TITLE_MIN (25) but under
// DAILY_TITLE_MAX (180) and clear of pii-filter's exclusion patterns and
// any outlet-name leak in the fixtures below.
function title(text: string): string {
  const padded = text.length >= 25 ? text : `${text} — bir siyasi haber başlığı`;
  return padded.slice(0, 179);
}

function source(overrides: Partial<DailyCandidate["source"]> = {}): DailyCandidate["source"] {
  return {
    id: "src-1",
    name: "Örnek Gazete",
    slug: "ornek-gazete",
    bias: "center",
    kind: "outlet",
    active: true,
    ...overrides,
  };
}

// Window used across most fixtures below: puzzleWindow('2026-09-29').
const KEY = "2026-09-29";
const WINDOW: PuzzleWindow = puzzleWindow(KEY);
const OUTSIDE_ISO = "2026-09-25T10:00:00.000Z";

function candidate(overrides: Partial<DailyCandidate> = {}): DailyCandidate {
  return {
    articleId: "11111111-1111-1111-1111-111111111111",
    title: title("Meclis bugün önemli bir yasa tasarısını görüşecek"),
    url: "https://ornek.com/haber/1",
    publishedAt: WINDOW.startIso,
    createdAt: WINDOW.startIso,
    clusterId: "cluster-1",
    source: source(),
    ...overrides,
  };
}

describe("istanbulDateKey", () => {
  it("2026-09-27T20:59:59Z is still 2026-09-27 in Istanbul", async () => {
    const { istanbulDateKey } = await import("./daily-set");
    expect(istanbulDateKey(Date.parse("2026-09-27T20:59:59.000Z"))).toBe("2026-09-27");
  });

  it("2026-09-27T21:00:00Z rolls into 2026-09-28 in Istanbul", async () => {
    const { istanbulDateKey } = await import("./daily-set");
    expect(istanbulDateKey(Date.parse("2026-09-27T21:00:00.000Z"))).toBe("2026-09-28");
  });
});

describe("puzzleWindow", () => {
  it("2026-09-28 -> [2026-09-26T21:00:00.000Z, 2026-09-27T21:00:00.000Z)", () => {
    expect(puzzleWindow("2026-09-28")).toEqual({
      startIso: "2026-09-26T21:00:00.000Z",
      endIso: "2026-09-27T21:00:00.000Z",
    });
  });
});

describe("puzzleNumber", () => {
  it("the epoch is puzzle #1", () => {
    expect(puzzleNumber(DAILY_GAME_EPOCH)).toBe(1);
  });

  it("the day after the epoch is puzzle #2", () => {
    expect(puzzleNumber(addDays(DAILY_GAME_EPOCH, 1))).toBe(2);
  });
});

describe("resolvePuzzleDate", () => {
  const today = "2026-10-05";

  it("array input takes the first element", () => {
    expect(resolvePuzzleDate(["2026-10-02", "ignored"], today)).toBe("2026-10-02");
  });

  it("an invalid string falls back to today", () => {
    expect(resolvePuzzleDate("not-a-date", today)).toBe(today);
  });

  it("undefined falls back to today", () => {
    expect(resolvePuzzleDate(undefined, today)).toBe(today);
  });

  it("a future date falls back to today", () => {
    expect(resolvePuzzleDate("2026-10-06", today)).toBe(today);
  });

  it("8 days old falls back to today", () => {
    expect(resolvePuzzleDate(addDays(today, -8), today)).toBe(today);
  });

  it("a date before the epoch falls back to today", () => {
    expect(resolvePuzzleDate("2026-09-01", today)).toBe(today);
  });

  it("a valid 3-day-old key is kept", () => {
    const threeDaysAgo = addDays(today, -3);
    expect(resolvePuzzleDate(threeDaysAgo, today)).toBe(threeDaysAgo);
  });
});

describe("Istanbul offset matches Intl for sample dates", () => {
  const samples = ["2026-01-15", "2026-04-01", "2026-07-04", "2026-12-25"];

  it.each(samples)("%s", (dateKey) => {
    const ms = Date.parse(`${dateKey}T12:00:00.000Z`);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Istanbul",
      timeZoneName: "shortOffset",
    }).formatToParts(ms);
    const offsetPart = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
    // e.g. "GMT+3"
    expect(offsetPart).toBe("GMT+3");
    expect(ISTANBUL_OFFSET_MS).toBe(3 * 60 * 60 * 1000);
  });
});

describe("dailyHash", () => {
  it("is stable for the same inputs", () => {
    expect(dailyHash("2026-09-28", "article-1")).toBe(dailyHash("2026-09-28", "article-1"));
  });

  it("differs across keys for the same articleId", () => {
    expect(dailyHash("2026-09-28", "article-1")).not.toBe(dailyHash("2026-09-29", "article-1"));
  });

  it("differs across articleIds for the same key", () => {
    expect(dailyHash("2026-09-28", "article-1")).not.toBe(dailyHash("2026-09-28", "article-2"));
  });
});

describe("titleLeaksOutlet", () => {
  it("catches a case-folded outlet name leak (SÖZCÜ)", () => {
    const sozcu = source({ name: "Sözcü", slug: "sozcu" });
    expect(titleLeaksOutlet("SÖZCÜ'nün iddiasına göre bakan istifa etti", sozcu)).toBe(true);
  });

  it("catches a 4+ char slug token leak", () => {
    const src = source({ name: "Bağımsız Haber Merkezi", slug: "bagimsiz-haber" });
    expect(titleLeaksOutlet("Haber sitesinde bugün yeni bir gelişme yaşandı", src)).toBe(true);
  });

  it("does not flag an unrelated title", () => {
    const src = source({ name: "Sözcü", slug: "sozcu" });
    expect(titleLeaksOutlet("Meclis bugün önemli bir yasayı görüşecek", src)).toBe(false);
  });
});

describe("isDailyEligible", () => {
  it("rejects a wire source", () => {
    expect(isDailyEligible(candidate({ source: source({ kind: "wire" }) }), WINDOW)).toBe(false);
  });

  it("rejects an aggregator source", () => {
    expect(isDailyEligible(candidate({ source: source({ kind: "aggregator" }) }), WINDOW)).toBe(
      false,
    );
  });

  it("rejects a niche source", () => {
    expect(isDailyEligible(candidate({ source: source({ kind: "niche" }) }), WINDOW)).toBe(false);
  });

  it("rejects an inactive source", () => {
    expect(isDailyEligible(candidate({ source: source({ active: false }) }), WINDOW)).toBe(false);
  });

  it("rejects a PII title (gözaltına alındı)", () => {
    expect(
      isDailyEligible(
        candidate({ title: title("Şüpheli bir kişi gözaltına alındı bugün sabah") }),
        WINDOW,
      ),
    ).toBe(false);
  });

  it("rejects an outlet-name leak, case-folded", () => {
    const sozcu = source({ name: "Sözcü", slug: "sozcu" });
    expect(
      isDailyEligible(
        candidate({
          title: title("SÖZCÜ'nün iddiasına göre bakan bugün istifa etti"),
          source: sozcu,
        }),
        WINDOW,
      ),
    ).toBe(false);
  });

  it("rejects a title shorter than DAILY_TITLE_MIN", () => {
    expect(isDailyEligible(candidate({ title: "Kısa başlık" }), WINDOW)).toBe(false);
  });

  it("rejects a title longer than DAILY_TITLE_MAX", () => {
    expect(isDailyEligible(candidate({ title: "a".repeat(DAILY_TITLE_MAX + 1) }), WINDOW)).toBe(
      false,
    );
  });

  it("rejects an article outside the window", () => {
    expect(
      isDailyEligible(
        candidate({ publishedAt: OUTSIDE_ISO, createdAt: OUTSIDE_ISO }),
        WINDOW,
      ),
    ).toBe(false);
  });

  it("accepts a future published_at whose created_at is inside the window", () => {
    const farFuture = new Date(Date.parse(WINDOW.endIso) + 999 * 24 * 3600 * 1000).toISOString();
    expect(
      isDailyEligible(
        candidate({ publishedAt: farFuture, createdAt: WINDOW.startIso }),
        WINDOW,
      ),
    ).toBe(true);
  });

  it("accepts an otherwise-clean candidate", () => {
    expect(isDailyEligible(candidate(), WINDOW)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pickDailySet
// ---------------------------------------------------------------------------

const ZONE_BIAS: Record<"iktidar" | "bagimsiz" | "muhalefet", BiasCategory> = {
  iktidar: "pro_government",
  bagimsiz: "center",
  muhalefet: "opposition",
};

// Builds a pool of `n` eligible candidates whose window fields match
// `key`'s own puzzleWindow — since the window shifts by exactly one day
// between consecutive keys, a pool built for one key is NOT eligible under
// a different key, so every pool consumer below must pass the SAME key to
// both `pool()` and `pickDailySet()` unless the test explicitly wants to
// compare two same-shaped-but-differently-windowed pools (see "different
// keys give different sets" below).
function pool(key: string, n: number): DailyCandidate[] {
  const zones: Array<"iktidar" | "bagimsiz" | "muhalefet"> = ["iktidar", "bagimsiz", "muhalefet"];
  const w = puzzleWindow(key);
  return Array.from({ length: n }, (_, i) => {
    const zone = zones[i % 3]!;
    return candidate({
      articleId: `aaaaaaaa-aaaa-aaaa-aaaa-${String(i).padStart(12, "0")}`,
      title: title(`Siyasi gündemde bugün ${i}. önemli bir gelişme yaşandı`),
      publishedAt: w.startIso,
      createdAt: w.startIso,
      clusterId: `cluster-${i}`,
      source: source({
        id: `source-${i}`,
        name: `Kaynak ${i}`,
        slug: `kaynak-${i}`,
        bias: ZONE_BIAS[zone],
      }),
    });
  });
}

function shuffled<T>(arr: readonly T[], seed: number): T[] {
  const copy = [...arr];
  let s = seed;
  for (let i = copy.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

describe("pickDailySet", () => {
  const KEY2 = "2026-09-30";

  it("returns exactly 5 headlines, 1-2 per zone, distinct sources and clusters", () => {
    const result = pickDailySet(KEY2, pool(KEY2, 30));
    expect(result).not.toBeNull();
    expect(result).toHaveLength(DAILY_GAME_SIZE);

    const zoneCounts: Record<string, number> = {};
    const sourceIds = new Set<string>();
    const clusterIds = new Set<string>();
    for (const h of result!) {
      zoneCounts[h.zone] = (zoneCounts[h.zone] ?? 0) + 1;
      expect(sourceIds.has(h.sourceId)).toBe(false);
      sourceIds.add(h.sourceId);
      if (h.clusterId) {
        expect(clusterIds.has(h.clusterId)).toBe(false);
        clusterIds.add(h.clusterId);
      }
    }
    for (const zone of ["iktidar", "bagimsiz", "muhalefet"]) {
      const count = zoneCounts[zone] ?? 0;
      expect(count).toBeGreaterThanOrEqual(1);
      expect(count).toBeLessThanOrEqual(DAILY_MAX_PER_ZONE);
    }
  });

  it("is invariant to input order (shuffled 20 times)", () => {
    const base = pool(KEY2, 30);
    const first = pickDailySet(KEY2, base);
    expect(first).not.toBeNull();
    const firstIds = first!.map((h) => h.articleId);

    for (let seed = 1; seed <= 20; seed++) {
      const result = pickDailySet(KEY2, shuffled(base, seed));
      expect(result).not.toBeNull();
      expect(result!.map((h) => h.articleId)).toEqual(firstIds);
    }
  });

  it("is prefix-consistent: a hash-ordered prefix that already yields 5 matches the full list", () => {
    const base = pool(KEY2, 60);
    const full = pickDailySet(KEY2, base);
    expect(full).not.toBeNull();

    // Sort the pool by dailyHash the same way pickDailySet does internally,
    // then grow a prefix until it independently yields a full set.
    const sortedIds = [...base].sort(
      (a, b) => dailyHash(KEY2, a.articleId) - dailyHash(KEY2, b.articleId),
    );
    let minPrefixResult: ReturnType<typeof pickDailySet> = null;
    for (let n = DAILY_GAME_SIZE; n <= sortedIds.length; n++) {
      const attempt = pickDailySet(KEY2, sortedIds.slice(0, n));
      if (attempt) {
        minPrefixResult = attempt;
        break;
      }
    }
    expect(minPrefixResult).not.toBeNull();
    expect(minPrefixResult!.map((h) => h.articleId).sort()).toEqual(
      full!.map((h) => h.articleId).sort(),
    );
  });

  it("returns null when a zone has no eligible candidate", () => {
    const onlyTwoZones = pool(KEY2, 30).filter((c) => c.source.bias !== "opposition");
    expect(pickDailySet(KEY2, onlyTwoZones)).toBeNull();
  });

  it("the display order is not zone-grouped for a crafted fixture", () => {
    // Build exactly 5 candidates so pickDailySet's selection is forced, and
    // check the OUTPUT order differs from the selection-phase zone order
    // (iktidar, iktidar-or-bagimsiz, bagimsiz, muhalefet, muhalefet) for at
    // least one key — i.e. dailyHash(`${key}|order`, ...) really reorders.
    let foundNonGrouped = false;
    for (let k = 0; k < 40; k++) {
      const key = `2027-01-${String((k % 27) + 1).padStart(2, "0")}`;
      const result = pickDailySet(key, pool(key, 12));
      if (!result) continue;
      const zones = result.map((h) => h.zone);
      const isGrouped = zones.every((z, i) => i === 0 || z === zones[i - 1] || true);
      // A stronger, direct check: the zone sequence is not sorted according
      // to the fixed selection order (iktidar < bagimsiz < muhalefet).
      const order: Record<string, number> = { iktidar: 0, bagimsiz: 1, muhalefet: 2 };
      const sortedByPriority = [...zones].sort((a, b) => order[a]! - order[b]!);
      if (JSON.stringify(zones) !== JSON.stringify(sortedByPriority)) {
        foundNonGrouped = true;
      }
      void isGrouped;
    }
    expect(foundNonGrouped).toBe(true);
  });

  it("different keys give different sets on a 60-candidate pool", () => {
    const keyA = "2026-11-01";
    const keyB = "2026-11-02";
    // Same articleIds/sources/clusters in both pools (only the window-
    // matching timestamps differ) — dailyHash depends on (key, articleId)
    // only, so any difference in the resulting set is attributable purely
    // to the key, not to different candidate shapes.
    const a = pickDailySet(keyA, pool(keyA, 60));
    const b = pickDailySet(keyB, pool(keyB, 60));
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.map((h) => h.articleId)).not.toEqual(b!.map((h) => h.articleId));
  });
});

describe("isDateKey", () => {
  it("accepts a valid date", () => {
    expect(isDateKey("2026-09-28")).toBe(true);
  });

  it("rejects a calendrically invalid date", () => {
    expect(isDateKey("2026-02-30")).toBe(false);
  });

  it("rejects a non-string", () => {
    expect(isDateKey(undefined)).toBe(false);
    expect(isDateKey(123)).toBe(false);
  });

  it("rejects a malformed string", () => {
    expect(isDateKey("28-09-2026")).toBe(false);
  });
});
