import { describe, it, expect } from "vitest";

import {
  BASELINE_DAYS,
  BASELINE_FLOOR,
  MAX_ITEMS,
  MIN_BASELINE_DAYS_PRESENT,
  MIN_COUNT,
  MIN_LIFT,
  MIN_RATIO,
  MIN_Z,
  NEW_BASELINE_MAX,
  computeRising,
  formatRatio,
  shiftDayKey,
  type RisingResult,
} from "./rising";
import {
  RISING_ENTITIES,
  RISING_FOLD_FROM,
  RISING_FOLD_TO,
  foldTitleGrams,
} from "./rising-entities";

// ---------------------------------------------------------------------------
// "Yükselen Konular" (migration 112): pure ranking over per-entity daily
// article counts. A day is "present" when the rollup has ANY row for it (the
// refresh function writes a row for every vocabulary entity, zero included),
// so a missing entity row on a present day means zero.
// ---------------------------------------------------------------------------

const TODAY = "2026-10-23";

type Row = { day: string; entity: string; count: number };

/** Baseline rows for D-1..D-7 of `todayKey`, `perDay` articles each. */
function baselineRows(
  entity: string,
  perDay: number | number[],
  todayKey = TODAY,
  offsets: number[] = [1, 2, 3, 4, 5, 6, 7],
): Row[] {
  return offsets.map((off, i) => ({
    day: shiftDayKey(todayKey, -off),
    entity,
    count: Array.isArray(perDay) ? (perDay[i] as number) : perDay,
  }));
}

function todayRow(entity: string, count: number, todayKey = TODAY): Row {
  return { day: todayKey, entity, count };
}

function okItems(r: RisingResult) {
  if (r.status !== "ok") throw new Error(`expected ok, got ${r.status}`);
  return r.items;
}

describe("constants", () => {
  it("pins the spec thresholds", () => {
    expect(MIN_COUNT).toBe(12);
    expect(MIN_LIFT).toBe(8);
    expect(MIN_RATIO).toBe(2);
    expect(MIN_Z).toBe(3);
    expect(BASELINE_FLOOR).toBe(2);
    expect(BASELINE_DAYS).toBe(7);
    expect(MIN_BASELINE_DAYS_PRESENT).toBe(6);
    expect(MAX_ITEMS).toBe(8);
    expect(NEW_BASELINE_MAX).toBe(1);
  });
});

describe("shiftDayKey", () => {
  it("steps across a month boundary", () => {
    expect(shiftDayKey("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("steps forward across a month and year boundary", () => {
    expect(shiftDayKey("2026-12-31", 1)).toBe("2027-01-01");
  });
  it("honours leap days", () => {
    expect(shiftDayKey("2028-02-28", 1)).toBe("2028-02-29");
    expect(shiftDayKey("2028-03-01", -1)).toBe("2028-02-29");
  });
  it("delta 0 is the identity and large deltas work", () => {
    expect(shiftDayKey("2026-10-23", 0)).toBe("2026-10-23");
    expect(shiftDayKey("2026-10-23", -8)).toBe("2026-10-15");
    expect(shiftDayKey("2026-10-23", -365)).toBe("2025-10-23");
  });
});

describe("formatRatio", () => {
  it("floors to one decimal and uses the Turkish decimal comma", () => {
    expect(formatRatio(2.46)).toBe("2,4");
    expect(formatRatio(5)).toBe("5,0");
    expect(formatRatio(85 / 40)).toBe("2,1");
  });

  it("never rounds up", () => {
    expect(formatRatio(2.99)).toBe("2,9");
    expect(formatRatio(1.999)).toBe("1,9");
  });

  it("is exact for every tenth (no float undershoot such as 5.8 -> 5,7)", () => {
    for (let k = 20; k <= 300; k++) {
      const r = k / 10;
      expect(formatRatio(r)).toBe(`${Math.floor(k / 10)},${k % 10}`);
    }
  });

  it("uses the Turkish thousands separator for big ratios", () => {
    expect(formatRatio(1200)).toBe("1.200,0");
  });
});

describe("computeRising: sufficiency", () => {
  it("no rows gives insufficient", () => {
    expect(computeRising([], TODAY)).toEqual({ status: "insufficient" });
  });

  it("only 5 present baseline days gives insufficient", () => {
    const rows = [
      ...baselineRows("erdogan", 3, TODAY, [1, 2, 3, 4, 5]),
      todayRow("erdogan", 40),
    ];
    expect(computeRising(rows, TODAY)).toEqual({ status: "insufficient" });
  });

  it("6 present baseline days is enough", () => {
    const rows = [
      ...baselineRows("erdogan", 3, TODAY, [1, 2, 3, 4, 5, 6]),
      todayRow("erdogan", 40),
    ];
    const r = computeRising(rows, TODAY);
    expect(r.status).toBe("ok");
  });

  it("a baseline day counts as present even when every row on it is zero", () => {
    const rows = [
      ...baselineRows("erdogan", 0, TODAY, [1, 2, 3, 4, 5, 6, 7]),
      todayRow("erdogan", 14),
    ];
    const items = okItems(computeRising(rows, TODAY));
    expect(items.map((i) => i.key)).toEqual(["erdogan"]);
  });

  it("rows older than D-7 do not make up for missing baseline days", () => {
    const rows = [
      ...baselineRows("erdogan", 3, TODAY, [1, 2, 3, 4, 5]),
      { day: shiftDayKey(TODAY, -8), entity: "erdogan", count: 3 },
      { day: shiftDayKey(TODAY, -9), entity: "erdogan", count: 3 },
      todayRow("erdogan", 40),
    ];
    expect(computeRising(rows, TODAY)).toEqual({ status: "insufficient" });
  });
});

describe("computeRising: thresholds", () => {
  it("baseline 3/day and today 15 rises with ratio 5,0", () => {
    const rows = [...baselineRows("erdogan", 3), todayRow("erdogan", 15)];
    const r = computeRising(rows, TODAY);
    expect(r).toMatchObject({ status: "ok", dayLabel: "Bugün", day: TODAY });
    const [item] = okItems(r);
    expect(item).toMatchObject({
      key: "erdogan",
      label: "Erdoğan",
      count: 15,
      baseline: 3,
      ratio: 5,
      ratioLabel: "5,0",
      ratioIsLowerBound: false,
      isNew: false,
    });
    // Each rising entity links to its /gundem hub (roadmap G2), not to the
    // home-feed search.
    expect(item!.href).toBe("/gundem/erdogan");
    expect(item!.href).toBe(`/gundem/${item!.key}`);
  });

  it("1 -> 3 is excluded (below the minimum count)", () => {
    const rows = [...baselineRows("erdogan", 1), todayRow("erdogan", 3)];
    expect(okItems(computeRising(rows, TODAY))).toEqual([]);
  });

  it("count 11 against a quiet baseline is still below MIN_COUNT", () => {
    const rows = [...baselineRows("erdogan", 0), todayRow("erdogan", 11)];
    expect(okItems(computeRising(rows, TODAY))).toEqual([]);
  });

  it("count exactly MIN_COUNT against a zero baseline rises", () => {
    const rows = [...baselineRows("erdogan", 0), todayRow("erdogan", 12)];
    expect(okItems(computeRising(rows, TODAY)).map((i) => i.key)).toEqual(["erdogan"]);
  });

  it("B=40: T=70 is excluded by the ratio rule, T=85 is included as 2,1", () => {
    const base = baselineRows("borsa", 40);
    expect(okItems(computeRising([...base, todayRow("borsa", 70)], TODAY))).toEqual([]);
    const [item] = okItems(computeRising([...base, todayRow("borsa", 85)], TODAY));
    expect(item).toMatchObject({ key: "borsa", count: 85, baseline: 40, ratioLabel: "2,1" });
  });

  it("B=0 and T=14 is a new topic", () => {
    const rows = [...baselineRows("trump", 0), todayRow("trump", 14)];
    const [item] = okItems(computeRising(rows, TODAY));
    expect(item).toMatchObject({
      key: "trump",
      baseline: 0,
      isNew: true,
      ratio: 7,
      ratioLabel: "7,0",
      ratioIsLowerBound: true,
    });
  });

  it("a baseline of exactly 1 is not 'new' (NEW_BASELINE_MAX is exclusive)", () => {
    const rows = [...baselineRows("trump", 1), todayRow("trump", 14)];
    const [item] = okItems(computeRising(rows, TODAY));
    expect(item).toMatchObject({ baseline: 1, isNew: false });
  });

  it("B=5 and T=12 is excluded by the absolute-lift rule", () => {
    // ratio 2.4 and z 3.13 both pass; only T - B = 7 < 8 fails.
    const rows = [...baselineRows("dolar", 5), todayRow("dolar", 12)];
    expect(okItems(computeRising(rows, TODAY))).toEqual([]);
    // One more article clears the lift: T - B = 8.
    const rows2 = [...baselineRows("dolar", 5), todayRow("dolar", 13)];
    expect(okItems(computeRising(rows2, TODAY)).map((i) => i.key)).toEqual(["dolar"]);
  });

  it("B=8, T=16 is excluded by the z-score alone; T=17 passes", () => {
    // T=16: count ok, lift 8 ok, ratio 2.0 ok, z = 8 / sqrt(8) = 2.83 < 3.
    const base = baselineRows("faiz", 8);
    expect(okItems(computeRising([...base, todayRow("faiz", 16)], TODAY))).toEqual([]);
    const [item] = okItems(computeRising([...base, todayRow("faiz", 17)], TODAY));
    expect(item).toMatchObject({ key: "faiz", ratioLabel: "2,1" });
  });

  it("a baseline below the floor of 2 is clamped for the ratio, and the label is flagged as a lower bound", () => {
    // B = 1 (< BASELINE_FLOOR): ratio = 12 / 2, not 12 / 1. The true multiple
    // is 12x, so "6,0" may only be shown as "at least" (en az).
    const rows = [...baselineRows("hamas", 1), todayRow("hamas", 12)];
    const [item] = okItems(computeRising(rows, TODAY));
    expect(item).toMatchObject({
      key: "hamas",
      baseline: 1,
      ratio: 6,
      ratioLabel: "6,0",
      ratioIsLowerBound: true,
    });
  });

  it("a fractional baseline in [1, 2) is a lower bound too: B = 10/7, T = 13 shows 6,5 (true 9,1)", () => {
    const rows = [...baselineRows("ocalan", [2, 2, 2, 2, 1, 1, 0]), todayRow("ocalan", 13)];
    const [item] = okItems(computeRising(rows, TODAY));
    expect(item!.baseline).toBeCloseTo(10 / 7, 10);
    expect(item!.isNew).toBe(false);
    expect(item).toMatchObject({ ratio: 6.5, ratioLabel: "6,5", ratioIsLowerBound: true });
    // The displayed number never exceeds the true multiple.
    expect(item!.ratio).toBeLessThanOrEqual(item!.count / item!.baseline);
  });

  it("a baseline of exactly the floor (2) is exact, not a lower bound", () => {
    const rows = [...baselineRows("hamas", 2), todayRow("hamas", 15)];
    const [item] = okItems(computeRising(rows, TODAY));
    expect(item).toMatchObject({
      baseline: 2,
      ratio: 7.5,
      ratioLabel: "7,5",
      ratioIsLowerBound: false,
    });
  });

  it("whenever the label is not a lower bound it equals count / baseline", () => {
    for (const per of [2, 3, 5, 40]) {
      const rows = [...baselineRows("borsa", per), todayRow("borsa", per * 3 + 30)];
      const [item] = okItems(computeRising(rows, TODAY));
      expect(item!.ratioIsLowerBound).toBe(false);
      expect(item!.ratio).toBeCloseTo(item!.count / item!.baseline, 10);
    }
  });

  it("an entity with no baseline rows at all is treated as zero there", () => {
    // Baseline days are present because of erdogan; chp has no row on any of
    // them, so B = 0 and its 20 articles today are a new spike.
    const rows = [...baselineRows("erdogan", 3), todayRow("chp", 20)];
    const keys = okItems(computeRising(rows, TODAY)).map((i) => i.key);
    expect(keys).toEqual(["chp"]);
  });
});

describe("computeRising: baseline mean over present days", () => {
  it("a missing baseline day is skipped, not counted as zero", () => {
    // D-4 absent: 6 present days at 3 each. Mean 3 (a divide-by-7 would give
    // 2.57 and ratioLabel "5,8").
    const rows = [
      ...baselineRows("erdogan", 3, TODAY, [1, 2, 3, 5, 6, 7]),
      todayRow("erdogan", 15),
    ];
    const [item] = okItems(computeRising(rows, TODAY));
    expect(item!.baseline).toBe(3);
    expect(item!.ratioLabel).toBe("5,0");
  });

  it("an entity with no row on a present day counts as zero on that day", () => {
    // chp has rows on 3 of the 7 baseline days; the other 4 are present only
    // because of the filler entity, so chp's mean is 28/7 = 4.
    const rows = [
      ...baselineRows("erdogan", 1),
      { day: shiftDayKey(TODAY, -1), entity: "chp", count: 14 },
      { day: shiftDayKey(TODAY, -2), entity: "chp", count: 7 },
      { day: shiftDayKey(TODAY, -3), entity: "chp", count: 7 },
      todayRow("chp", 20),
    ];
    const chp = okItems(computeRising(rows, TODAY)).find((i) => i.key === "chp");
    expect(chp).toBeDefined();
    expect(chp!.baseline).toBe(4);
    expect(chp!.ratio).toBe(5);
  });
});

describe("computeRising: ordering and cap", () => {
  it("keeps at most 8 items, strongest ratio first", () => {
    const keys = RISING_ENTITIES.slice(0, 10).map((e) => e.key);
    const rows: Row[] = [];
    keys.forEach((key, i) => {
      rows.push(...baselineRows(key, 0));
      rows.push(todayRow(key, 14 + i)); // ratios 7.0, 7.5, ... 11.5
    });
    const items = okItems(computeRising(rows, TODAY));
    expect(items).toHaveLength(MAX_ITEMS);
    expect(items.map((i) => i.key)).toEqual([...keys].reverse().slice(0, 8));
    const ratios = items.map((i) => i.ratio);
    expect(ratios).toEqual([...ratios].sort((a, b) => b - a));
  });

  it("breaks ratio ties by count, then by Turkish label order", () => {
    const rows: Row[] = [
      // all ratio 10
      ...baselineRows("faiz", 3),
      todayRow("faiz", 30),
      ...baselineRows("enflasyon", 3),
      todayRow("enflasyon", 30),
      ...baselineRows("dolar", 4),
      todayRow("dolar", 40),
      ...baselineRows("cin", 3),
      todayRow("cin", 30),
    ];
    const items = okItems(computeRising(rows, TODAY));
    // dolar (count 40) first; then count-30 ties by label: Çin, Enflasyon, Faiz.
    expect(items.map((i) => i.label)).toEqual(["Dolar", "Çin", "Enflasyon", "Faiz"]);
  });
});

describe("computeRising: unknown keys", () => {
  it("ignores entity keys that are not in the vocabulary", () => {
    const rows = [
      ...baselineRows("not-a-real-key", 0),
      todayRow("not-a-real-key", 500),
      ...baselineRows("erdogan", 3),
      todayRow("erdogan", 15),
    ];
    const keys = okItems(computeRising(rows, TODAY)).map((i) => i.key);
    expect(keys).toEqual(["erdogan"]);
  });
});

describe("computeRising: yesterday fallback", () => {
  const YESTERDAY = shiftDayKey(TODAY, -1);

  it("an empty today with a spiking yesterday ranks yesterday ('Dün')", () => {
    const rows = [
      // baseline of yesterday: D-2 .. D-8 of today
      ...baselineRows("erdogan", 3, YESTERDAY),
      { day: YESTERDAY, entity: "erdogan", count: 15 },
      { day: TODAY, entity: "erdogan", count: 0 },
    ];
    const r = computeRising(rows, TODAY);
    expect(r).toMatchObject({ status: "ok", dayLabel: "Dün", day: YESTERDAY });
    const [item] = okItems(r);
    expect(item).toMatchObject({ key: "erdogan", count: 15, baseline: 3, ratioLabel: "5,0" });
  });

  it("today with items wins over yesterday", () => {
    const rows = [
      ...baselineRows("erdogan", 3, YESTERDAY),
      { day: YESTERDAY, entity: "erdogan", count: 15 },
      { day: TODAY, entity: "erdogan", count: 20 },
    ];
    const r = computeRising(rows, TODAY);
    expect(r).toMatchObject({ status: "ok", dayLabel: "Bugün", day: TODAY });
  });

  it("nothing rising today or yesterday is ok with no items, labelled 'Bugün'", () => {
    const rows = [
      ...baselineRows("erdogan", 3, YESTERDAY),
      { day: YESTERDAY, entity: "erdogan", count: 3 },
      { day: TODAY, entity: "erdogan", count: 3 },
    ];
    expect(computeRising(rows, TODAY)).toEqual({
      status: "ok",
      dayLabel: "Bugün",
      day: TODAY,
      items: [],
    });
  });

  it("insufficient history for today is insufficient even if yesterday would rank", () => {
    // Only D-1..D-4 present (4 days): today cannot be ranked at all.
    const rows = [
      ...baselineRows("erdogan", 3, TODAY, [2, 3, 4]),
      { day: YESTERDAY, entity: "erdogan", count: 50 },
    ];
    expect(computeRising(rows, TODAY)).toEqual({ status: "insufficient" });
  });

  it("yesterday with too little history is skipped, leaving an empty 'Bugün'", () => {
    // Today has 6 present baseline days (D-1..D-6); yesterday's baseline
    // D-2..D-8 has only D-2..D-6 = 5 present -> insufficient -> not ranked.
    const rows = [
      ...baselineRows("erdogan", 3, TODAY, [2, 3, 4, 5, 6]),
      { day: YESTERDAY, entity: "erdogan", count: 50 },
    ];
    const r = computeRising(rows, TODAY);
    expect(r).toEqual({ status: "ok", dayLabel: "Bugün", day: TODAY, items: [] });
  });
});

describe("RISING_ENTITIES vocabulary", () => {
  it("has unique, slug-shaped keys", () => {
    const keys = RISING_ENTITIES.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[a-z0-9-]+$/);
  });

  it("has unique, folded tokens (unigram >= 3 chars, or a two-word bigram)", () => {
    const all = RISING_ENTITIES.flatMap((e) => [...e.tokens]);
    expect(new Set(all).size).toBe(all.length);
    for (const t of all) {
      expect(t).toMatch(/^(?:[a-z0-9]{3,}|[a-z0-9]{2,} [a-z0-9]{2,})$/);
    }
  });

  it("every entry has a label and at least one token", () => {
    for (const e of RISING_ENTITIES) {
      expect(e.label.trim().length).toBeGreaterThan(0);
      expect(e.tokens.length).toBeGreaterThan(0);
    }
  });

  it("pins the shipped vocabulary size and a few spec entries", () => {
    expect(RISING_ENTITIES).toHaveLength(62);
    const byKey = new Map(RISING_ENTITIES.map((e) => [e.key, e]));
    expect(byKey.get("akp")).toEqual({ key: "akp", label: "AK Parti", tokens: ["akp", "ak parti"] });
    expect(byKey.get("borsa")?.tokens).toEqual(["borsa", "bist"]);
    expect(byKey.get("zelenski")?.tokens).toEqual(["zelenski", "zelenskiy"]);
    expect(byKey.get("simsek")?.tokens).toEqual(["mehmet simsek"]);
  });

  it("excludes the documented ambiguous tokens", () => {
    const all = new Set(RISING_ENTITIES.flatMap((e) => [...e.tokens]));
    for (const banned of [
      "ozel",
      "iyi",
      "tip",
      "gelecek",
      "vatan",
      "adalet",
      "saglik",
      "yilmaz",
      "guler",
      "yavas",
      "simsek",
      "altin",
      "kur",
      "euro",
      "avrupa",
      "turkiye",
      "bakan",
      "secim",
      "ekonomi",
    ]) {
      expect(all.has(banned), banned).toBe(false);
    }
  });

  it("every label folds back onto one of its own tokens (vocabulary self-consistency)", () => {
    for (const e of RISING_ENTITIES) {
      const grams = new Set(foldTitleGrams(e.label));
      expect(
        e.tokens.some((t) => grams.has(t)),
        `${e.key} label '${e.label}' folds to ${[...grams].join("|")}`,
      ).toBe(true);
    }
  });
});

describe("foldTitleGrams / fold constants", () => {
  it("emits unigrams and adjacent bigrams, folding Turkish letters", () => {
    const grams = foldTitleGrams("Özgür Özel'in İYİ Parti ziyareti");
    expect(grams).toContain("ozgur ozel");
    expect(grams).toContain("iyi parti");
    expect(grams).toContain("ozgur");
    expect(grams).toContain("ozel");
    expect(grams).toContain("ziyareti");
  });

  it("splits on every non-alphanumeric character", () => {
    expect(foldTitleGrams("CHP'li vekil!")).toEqual(["chp", "li", "vekil", "chp li", "li vekil"]);
  });

  it("returns [] for empty and punctuation-only titles", () => {
    expect(foldTitleGrams("")).toEqual([]);
    expect(foldTitleGrams("  ... -- ")).toEqual([]);
  });

  it("a single word has no bigram", () => {
    expect(foldTitleGrams("Erdoğan")).toEqual(["erdogan"]);
  });

  it("folds every Turkish letter pair to its ASCII base", () => {
    expect(foldTitleGrams("İIıŞşĞğÜüÖöÇçÂâÎîÛû")).toEqual(["iiissgguuooccaaiiuu"]);
  });

  it("the fold strings have equal code-point length", () => {
    expect([...RISING_FOLD_FROM].length).toBe([...RISING_FOLD_TO].length);
    expect([...RISING_FOLD_FROM]).toHaveLength(19);
  });

  it("the fold strings are exactly the spec literals", () => {
    expect(RISING_FOLD_FROM).toBe("İIıŞşĞğÜüÖöÇçÂâÎîÛû");
    expect(RISING_FOLD_TO).toBe("iiissgguuooccaaiiuu");
  });

  it("the fold target is plain lowercase ASCII", () => {
    expect(RISING_FOLD_TO).toMatch(/^[a-z]+$/);
  });
});
