import { describe, expect, it } from "vitest";

import { expectLinear, rep } from "../../../tests/_helpers/linear-time";

import { ENTITY_HUB_MIN_INDEXABLE, ENTITY_HUB_WINDOW_DAYS } from "./entity-hub";
import {
  HUB_TREND_CAPTION,
  HUB_TREND_DAYS,
  HUB_TREND_HEADING,
  HUB_TREND_TABLE_TOGGLE,
  hubTrendAriaLabel,
  hubTrendEarlierNote,
  hubTrendSparseEarlierNote,
  hubTrendSparseLine,
  hubTrendState,
  hubTrendSum,
  hubTrendTableCaption,
  hubTrendTableRows,
  hubTrendTotalLine,
  parseHubTrendRows,
  type HubTrendDay,
} from "./hub-trend";

// ---------------------------------------------------------------------------
// h154-hub-trend. The pure half of the /gundem/[key] daily chart: it validates the 15 rows of migration 206's
// entity_cluster_days (14 Istanbul days, oldest first, plus one row with day null for clusters first published
// earlier) and writes every line of Turkish copy. No I/O, no clock.
// ---------------------------------------------------------------------------

// 30 Eki -> 12 Kas 2026, 14 consecutive days.
const DAYS = [
  "2026-10-30",
  "2026-10-31",
  "2026-11-01",
  "2026-11-02",
  "2026-11-03",
  "2026-11-04",
  "2026-11-05",
  "2026-11-06",
  "2026-11-07",
  "2026-11-08",
  "2026-11-09",
  "2026-11-10",
  "2026-11-11",
  "2026-11-12",
] as const;

// erdogan, as measured on 2026-11-12: 416 in the window, 41 earlier.
const ERDOGAN = [34, 26, 11, 29, 30, 19, 19, 27, 19, 32, 49, 58, 51, 12] as const;

type Row = { day: unknown; clusters: unknown };

/** The 15-row RPC answer: 14 dated rows (oldest first) and the earlier row last. */
function rpcRows(counts: readonly unknown[] = ERDOGAN, earlier: unknown = 41, days: readonly unknown[] = DAYS): Row[] {
  const dated: Row[] = days.map((day, i) => ({ day, clusters: counts[i] }));
  return [...dated, { day: null, clusters: earlier }];
}

function days14(counts: readonly number[] = ERDOGAN): HubTrendDay[] {
  return DAYS.map((day, i) => ({ day, clusters: counts[i] as number }));
}

describe("parseHubTrendRows", () => {
  it("accepts the 15-row RPC shape in any order and returns 14 days oldest first plus earlier", () => {
    const expected = { days: days14(), earlier: 41 };
    expect(parseHubTrendRows(rpcRows())).toEqual(expected);

    // the earlier row first, then the days newest first
    const reversed = [...rpcRows()].reverse();
    expect(reversed[0]).toEqual({ day: null, clusters: 41 });
    expect(parseHubTrendRows(reversed)).toEqual(expected);

    // earlier row in the middle, days shuffled by a fixed permutation
    const dated = rpcRows().slice(0, 14);
    const shuffled = [3, 11, 0, 7, 13, 5, 1, 9, 12, 2, 8, 4, 10, 6].map((i) => dated[i] as Row);
    shuffled.splice(6, 0, { day: null, clusters: 41 });
    expect(shuffled).toHaveLength(15);
    expect(parseHubTrendRows(shuffled)).toEqual(expected);

    // the parsed days are oldest first and fresh objects, not the input rows
    const parsed = parseHubTrendRows(rpcRows());
    expect(parsed?.days.map((d) => d.day)).toEqual([...DAYS]);
    expect(parsed?.days[0]).not.toBe(rpcRows()[0]);
    expect(Object.keys(parsed?.days[0] as object).sort()).toEqual(["clusters", "day"]);
  });

  it("accepts zeros and an empty window (every count 0, earlier 0)", () => {
    const zeros = new Array<number>(14).fill(0);
    expect(parseHubTrendRows(rpcRows(zeros, 0))).toEqual({ days: days14(zeros), earlier: 0 });
    // a negative zero from a JSON parser reads as 0
    const parsed = parseHubTrendRows(rpcRows(zeros, -0));
    expect(Object.is(parsed?.earlier, 0)).toBe(true);
  });

  it("parseHubTrendRows reads bigint counts sent as strings", () => {
    const asStrings = ERDOGAN.map((n) => String(n));
    expect(parseHubTrendRows(rpcRows(asStrings, "41"))).toEqual({ days: days14(), earlier: 41 });
    // mixed numbers and strings
    expect(parseHubTrendRows(rpcRows([...asStrings.slice(0, 7), ...ERDOGAN.slice(7)], 41))).toEqual({
      days: days14(),
      earlier: 41,
    });
    // the largest safe integer survives as a string
    const big = String(Number.MAX_SAFE_INTEGER);
    expect(parseHubTrendRows(rpcRows(ERDOGAN, big))?.earlier).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("parseHubTrendRows rejects a missing or doubled earlier row, 13 or 15 dated rows, a gap, a repeated day, an impossible date, a malformed key, a negative, fractional or non-numeric count, and a non-array", () => {
    const rejects = (label: string, input: unknown) => expect(parseHubTrendRows(input), label).toBeNull();
    const good = rpcRows();

    // earlier row: missing, doubled, or replaced by a dated row
    rejects("no earlier row", good.slice(0, 14));
    rejects("no earlier row, 14 + a dated 15th", [...good.slice(0, 14), { day: "2026-11-13", clusters: 1 }]);
    rejects("two earlier rows", [...good, { day: null, clusters: 3 }]);
    rejects("earlier twice, 13 dated", [...good.slice(0, 13), { day: null, clusters: 3 }, { day: null, clusters: 41 }]);

    // dated rows: 13 or 15
    rejects("13 dated rows + earlier", [...good.slice(0, 13), good[14]]);
    rejects("15 dated rows + earlier", [...good, { day: "2026-11-13", clusters: 1 }]);
    rejects("empty array", []);
    rejects("one row", [{ day: null, clusters: 0 }]);

    // a gap or a repeat in the day sequence
    const gap = DAYS.map((d, i) => (i === 7 ? "2026-11-07" : d)); // 06 -> 07 -> 07
    rejects("a repeated day", rpcRows(ERDOGAN, 41, gap));
    const skipped = [...DAYS.slice(0, 7), ...DAYS.slice(8), "2026-11-13"]; // 07 missing, 13 added
    rejects("a gap", rpcRows(ERDOGAN, 41, skipped));
    const twoDayStep = DAYS.map((_, i) => `2026-11-${String(i * 2 + 1).padStart(2, "0")}`);
    rejects("two-day steps", rpcRows(ERDOGAN, 41, twoDayStep.slice(0, 14)));

    // an impossible date and malformed keys
    const impossible = [...DAYS];
    impossible[3] = "2026-02-30";
    rejects("2026-02-30", rpcRows(ERDOGAN, 41, impossible));
    for (const bad of ["2026-13-01", "2026-00-10", "2026-11-00", "2026-11-31", "2025-02-29", "2026-11-32"]) {
      const days = [...DAYS];
      days[5] = bad;
      rejects(bad, rpcRows(ERDOGAN, 41, days));
    }
    for (const bad of ["2026-1-05", "26-11-05", "2026/11/05", "2026-11-05 ", " 2026-11-05", "2026-11-05T00:00:00Z", "2026-11-05\n", "", "x", "٢٠٢٦-١١-٠٥"]) {
      const days = [...DAYS];
      days[5] = bad;
      rejects(JSON.stringify(bad), rpcRows(ERDOGAN, 41, days));
    }
    for (const bad of [20261105, true, undefined, {}, []] as unknown[]) {
      const days: unknown[] = [...DAYS];
      days[5] = bad;
      rejects(`day ${JSON.stringify(bad)}`, rpcRows(ERDOGAN, 41, days));
    }

    // counts
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2, "-1", "1.5", "abc", "", " ", "1e3", "0x10", "+5", "5 ", null, undefined, true, {}, [], [5]] as unknown[]) {
      const counts: unknown[] = [...ERDOGAN];
      counts[4] = bad;
      rejects(`day count ${String(bad)}`, rpcRows(counts, 41));
      // not rpcRows(ERDOGAN, bad): a default parameter would turn `undefined` into 41
      rejects(`earlier count ${String(bad)}`, [...rpcRows().slice(0, 14), { day: null, clusters: bad }]);
    }

    // not an array, rows that are not objects, a missing day key
    for (const bad of [null, undefined, 15, "15", {}, { length: 15 }, new Set(good)] as unknown[]) {
      rejects(`input ${String(bad)}`, bad);
    }
    for (const bad of [null, 5, "x", [], undefined] as unknown[]) {
      const rows: unknown[] = [...good];
      rows[2] = bad;
      rejects(`row ${JSON.stringify(bad)}`, rows);
    }
    const noDayKey: unknown[] = [...good];
    noDayKey[2] = { clusters: 5 };
    rejects("a row without a day key", noDayKey);
    const noCount: unknown[] = [...good];
    noCount[2] = { day: "2026-11-01" };
    rejects("a row without a count", noCount);
  });

  it("does not mutate its input", () => {
    const input = rpcRows();
    const copy = JSON.parse(JSON.stringify(input)) as unknown;
    parseHubTrendRows(input);
    expect(JSON.parse(JSON.stringify(input))).toEqual(copy);
  });

  it("accepts a window that crosses a month, a year and a leap day", () => {
    const run = (start: string): string[] => {
      const [y, m, d] = start.split("-").map(Number) as [number, number, number];
      return Array.from({ length: 14 }, (_, i) => new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10));
    };
    for (const start of ["2026-12-25", "2028-02-20", "2026-02-20", "2026-03-01"]) {
      const days = run(start);
      const parsed = parseHubTrendRows(rpcRows(ERDOGAN, 0, days));
      expect(parsed?.days.map((x) => x.day), start).toEqual(days);
    }
    expect(run("2028-02-20")).toContain("2028-02-29");
  });

  it("the day-key check is linear", () => {
    // One day key of n characters among 15 rows. A backtracking pattern would blow up on these shapes.
    const shapes: Array<[string, (n: number) => string]> = [
      ["digits", rep("1", "2026-11-")],
      ["digits then x", rep("1", "2026-11-", "x")],
      ["dashes", rep("-", "2026")],
      ["long year", rep("9", "", "-11-05")],
      ["newlines", rep("\n", "2026-11-05")],
    ];
    for (const [, gen] of shapes) {
      expectLinear(
        gen,
        (key) => {
          const days: unknown[] = [...DAYS];
          days[4] = key;
          return parseHubTrendRows(rpcRows(ERDOGAN, 41, days));
        },
        { n: 250_000, ceilingMs: 4_000 },
      );
    }
  });
});

describe("the window", () => {
  it("HUB_TREND_DAYS equals ENTITY_HUB_WINDOW_DAYS", () => {
    expect(HUB_TREND_DAYS).toBe(14);
    expect(HUB_TREND_DAYS).toBe(ENTITY_HUB_WINDOW_DAYS);
    expect(DAYS).toHaveLength(HUB_TREND_DAYS);
  });
});

describe("hubTrendSum and hubTrendState", () => {
  it("sums the 14 days (earlier is not part of it)", () => {
    expect(hubTrendSum(days14())).toBe(416);
    expect(hubTrendSum([])).toBe(0);
  });

  it("hubTrendState is sparse below ENTITY_HUB_MIN_INDEXABLE clusters and chart from 3", () => {
    expect(ENTITY_HUB_MIN_INDEXABLE).toBe(3);
    const withSum = (sum: number): HubTrendDay[] => days14(DAYS.map((_, i) => (i === 13 ? sum : 0)));
    expect(hubTrendState(withSum(0))).toBe("sparse");
    expect(hubTrendState(withSum(1))).toBe("sparse");
    expect(hubTrendState(withSum(2))).toBe("sparse");
    expect(hubTrendState(withSum(3))).toBe("chart");
    expect(hubTrendState(withSum(4))).toBe("chart");
    expect(hubTrendState(days14())).toBe("chart");
    // spread over several days: the SUM decides, not the busiest day
    expect(hubTrendState(days14(DAYS.map((_, i) => (i < 3 ? 1 : 0))))).toBe("chart");
    expect(hubTrendState(days14(DAYS.map((_, i) => (i < 2 ? 1 : 0))))).toBe("sparse");
  });
});

describe("copy", () => {
  it("the copy is exact and every count goes through formatCountTr (1.234)", () => {
    expect(HUB_TREND_HEADING).toBe("Günlere göre küme sayısı");
    expect(HUB_TREND_CAPTION).toBe(
      "Her sütun, bu gündem başlığıyla eşleşen ve ilk haberi o gün çıkan küme sayısıdır (haber sayısı değil). Günler Türkiye saatine göre.",
    );
    expect(HUB_TREND_TABLE_TOGGLE).toBe("Günlük sayıları tablo olarak göster");

    // total line
    expect(hubTrendTotalLine(416)).toBe("Grafikte 416 küme, son 14 gün (son gün dahil, eksik).");
    expect(hubTrendTotalLine(1234)).toBe("Grafikte 1.234 küme, son 14 gün (son gün dahil, eksik).");
    expect(hubTrendTotalLine(1234567)).toBe("Grafikte 1.234.567 küme, son 14 gün (son gün dahil, eksik).");

    // earlier note: null at 0 (and below), the exact line otherwise
    expect(hubTrendEarlierNote(0)).toBeNull();
    expect(hubTrendEarlierNote(-3)).toBeNull();
    expect(hubTrendEarlierNote(41)).toBe("İlk haberi 14 günden önce çıkan 41 küme yukarıdaki sayıya dahil, grafikte yok.");
    expect(hubTrendEarlierNote(1)).toBe("İlk haberi 14 günden önce çıkan 1 küme yukarıdaki sayıya dahil, grafikte yok.");
    expect(hubTrendEarlierNote(1234)).toBe("İlk haberi 14 günden önce çıkan 1.234 küme yukarıdaki sayıya dahil, grafikte yok.");

    // the earlier note of the sparse state (no chart is drawn there): null at 0 and below, never "grafikte yok"
    expect(hubTrendSparseEarlierNote(0)).toBeNull();
    expect(hubTrendSparseEarlierNote(-3)).toBeNull();
    expect(hubTrendSparseEarlierNote(5)).toBe("İlk haberi 14 günden önce çıkan 5 küme bu sayıya girmedi; sayfanın üstündeki toplama dahil.");
    expect(hubTrendSparseEarlierNote(1234)).toBe(
      "İlk haberi 14 günden önce çıkan 1.234 küme bu sayıya girmedi; sayfanın üstündeki toplama dahil.",
    );

    // the three sparse lines
    expect(hubTrendSparseLine(0, 5)).toBe("Bu başlıktaki 5 kümenin ilk haberi 14 günden önce çıktı; günlük grafik çizilmedi.");
    expect(hubTrendSparseLine(0, 1234)).toBe("Bu başlıktaki 1.234 kümenin ilk haberi 14 günden önce çıktı; günlük grafik çizilmedi.");
    expect(hubTrendSparseLine(0, 0)).toBe("Son 14 günde ilk haberi çıkan küme yok.");
    expect(hubTrendSparseLine(1, 0)).toBe("Son 14 günde ilk haberi çıkan 1 küme var; günlük grafik için çok az.");
    expect(hubTrendSparseLine(2, 7)).toBe("Son 14 günde ilk haberi çıkan 2 küme var; günlük grafik için çok az.");

    // aria label and table caption
    expect(hubTrendAriaLabel("Erdoğan", 416)).toBe(
      "Erdoğan: son 14 günde ilk haberin gününe göre küme sayısı, günlük sütun grafiği. Grafikte 416 küme. Son günün sayımı eksik.",
    );
    expect(hubTrendAriaLabel("CHP", 1234)).toBe(
      "CHP: son 14 günde ilk haberin gününe göre küme sayısı, günlük sütun grafiği. Grafikte 1.234 küme. Son günün sayımı eksik.",
    );
    expect(hubTrendTableCaption("Erdoğan")).toBe(
      "Erdoğan: son 14 günde ilk haberin gününe göre günlük küme sayısı (günler Türkiye saatine göre)",
    );
  });
});

describe("hubTrendTableRows", () => {
  it("hubTrendTableRows labels days with dayLabelTr and suffixes only the last ' (eksik)'", () => {
    const rows = hubTrendTableRows(days14());
    expect(rows).toHaveLength(14);
    expect(rows[0]).toEqual({ day: "2026-10-30", label: "30 Ekim", clusters: 34 });
    expect(rows[1]).toEqual({ day: "2026-10-31", label: "31 Ekim", clusters: 26 });
    expect(rows[2]).toEqual({ day: "2026-11-01", label: "1 Kasım", clusters: 11 });
    expect(rows[12]).toEqual({ day: "2026-11-11", label: "11 Kasım", clusters: 51 });
    expect(rows[13]).toEqual({ day: "2026-11-12", label: "12 Kasım (eksik)", clusters: 12 });
    expect(rows.filter((r) => r.label.endsWith(" (eksik)"))).toHaveLength(1);
    expect(rows.map((r) => r.clusters)).toEqual([...ERDOGAN]);
  });

  it("an empty list has no rows; a one-day list marks that one day", () => {
    expect(hubTrendTableRows([])).toEqual([]);
    expect(hubTrendTableRows([{ day: "2026-11-12", clusters: 0 }])).toEqual([
      { day: "2026-11-12", label: "12 Kasım (eksik)", clusters: 0 },
    ]);
  });
});
