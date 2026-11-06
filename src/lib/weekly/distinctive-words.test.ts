import { describe, it, expect } from "vitest";
import { FW_DEFAULTS } from "@/lib/text/fightin-words";
import {
  buildWeeklyDistinctiveWords,
  EN_FUNCTION_WORDS,
  EN_MIN_FUNCTION_WORDS,
  ENGLISH_SOURCE_SLUGS,
  isHoroscopeHeadline,
  isLikelyEnglishHeadline,
  WEEKLY_WORDS_MIN_HEADLINES_PER_ZONE,
  type WeeklyWordsArticleRow,
  type WeeklyWordsSourceRow,
} from "./distinctive-words";

const SOURCES: WeeklyWordsSourceRow[] = [
  { id: "src-gov-1", name: "Gov Outlet 1", bias: "pro_government", kind: "outlet", active: true },
  { id: "src-gov-2", name: "Gov Outlet 2", bias: "pro_government", kind: "outlet", active: true },
  { id: "src-gov-3", name: "Gov Outlet 3", bias: "pro_government", kind: "outlet", active: true },
  { id: "src-ind-1", name: "Center Outlet 1", bias: "center", kind: "outlet", active: true },
  { id: "src-ind-2", name: "Center Outlet 2", bias: "center", kind: "outlet", active: true },
  { id: "src-ind-3", name: "Center Outlet 3", bias: "center", kind: "outlet", active: true },
  { id: "src-opp-1", name: "Opp Outlet 1", bias: "opposition", kind: "outlet", active: true },
  { id: "src-opp-2", name: "Opp Outlet 2", bias: "opposition", kind: "outlet", active: true },
  { id: "src-opp-3", name: "Opp Outlet 3", bias: "opposition", kind: "outlet", active: true },
  // Sources that must be dropped:
  { id: "src-inactive", name: "Inactive", bias: "opposition", kind: "outlet", active: false },
  { id: "src-nonvoting", name: "Niche", bias: "opposition", kind: "niche", active: true },
  { id: "src-nobias", name: "No Bias", bias: null, kind: "outlet", active: true },
];

/** Generates `n` filler rows for `zoneSourceIds`, each with a unique title so headlineKey dedupe doesn't collapse them. */
function fillerRows(
  n: number,
  zoneSourceIds: string[],
  idPrefix: string,
): WeeklyWordsArticleRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${idPrefix}-${String(i).padStart(4, "0")}`,
    title: `Ekonomi haberi ${idPrefix} ${i}`,
    url: `https://example.com/${idPrefix}-${i}`,
    source_id: zoneSourceIds[i % zoneSourceIds.length]!,
    created_at: "2026-09-20T10:00:00.000Z",
  }));
}

const MIN = WEEKLY_WORDS_MIN_HEADLINES_PER_ZONE;

function baselineRows(): WeeklyWordsArticleRow[] {
  return [
    ...fillerRows(MIN, ["src-gov-1", "src-gov-2", "src-gov-3"], "gov"),
    ...fillerRows(MIN, ["src-ind-1", "src-ind-2", "src-ind-3"], "ind"),
    ...fillerRows(MIN, ["src-opp-1", "src-opp-2", "src-opp-3"], "opp"),
  ];
}

describe("buildWeeklyDistinctiveWords", () => {
  it("drops rows from non-voting, inactive or unknown-bias sources", () => {
    const rows: WeeklyWordsArticleRow[] = [
      ...baselineRows(),
      { id: "z-1", title: "Bir haber", url: null, source_id: "src-inactive", created_at: "x" },
      { id: "z-2", title: "Bir haber 2", url: null, source_id: "src-nonvoting", created_at: "x" },
      { id: "z-3", title: "Bir haber 3", url: null, source_id: "src-nobias", created_at: "x" },
      { id: "z-4", title: "Bir haber 4", url: null, source_id: "unknown-source", created_at: "x" },
    ];
    const result = buildWeeklyDistinctiveWords(rows, SOURCES);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.sample.iktidar).toBe(MIN);
      expect(result.sample.bagimsiz).toBe(MIN);
      expect(result.sample.muhalefet).toBe(MIN);
    }
  });

  it("a zone below the minimum returns insufficient with the sample counts", () => {
    const rows: WeeklyWordsArticleRow[] = [
      ...fillerRows(MIN, ["src-gov-1", "src-gov-2", "src-gov-3"], "gov"),
      ...fillerRows(MIN, ["src-ind-1", "src-ind-2", "src-ind-3"], "ind"),
      ...fillerRows(50, ["src-opp-1", "src-opp-2", "src-opp-3"], "opp"),
    ];
    const result = buildWeeklyDistinctiveWords(rows, SOURCES);
    expect(result.status).toBe("insufficient");
    if (result.status === "insufficient") {
      expect(result.sample).toEqual({ iktidar: MIN, bagimsiz: MIN, muhalefet: 50 });
    }
  });

  it("a duplicate headline counts once within a zone, but counts in every zone it appears in", () => {
    const rows: WeeklyWordsArticleRow[] = [
      ...baselineRows(),
      // The same headline, twice, in muhalefet: should dedupe to 1 kept doc.
      { id: "dup-a", title: "AYNI BAŞLIK", url: null, source_id: "src-opp-1", created_at: "x" },
      { id: "dup-b", title: "aynı başlık", url: null, source_id: "src-opp-2", created_at: "x" },
      // The same headline text also appears once in iktidar — a different
      // zone, so it counts there too.
      { id: "dup-c", title: "AYNI BAŞLIK", url: null, source_id: "src-gov-1", created_at: "x" },
    ];
    const result = buildWeeklyDistinctiveWords(rows, SOURCES);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      // muhalefet gained 1 kept doc (deduped from 2), iktidar gained 1.
      expect(result.sample.muhalefet).toBe(MIN + 1);
      expect(result.sample.iktidar).toBe(MIN + 1);
    }
  });

  it("the display form prefers Gözaltı/gözaltı over GÖZALTI but keeps CHP", () => {
    const rows: WeeklyWordsArticleRow[] = [
      ...fillerRows(MIN, ["src-ind-1", "src-ind-2", "src-ind-3"], "ind"),
      ...fillerRows(MIN, ["src-opp-1", "src-opp-2", "src-opp-3"], "opp"),
      ...fillerRows(MIN - 40, ["src-gov-1", "src-gov-2", "src-gov-3"], "gov"),
      // muhalefet: "gözaltı" as a strongly distinctive term, mostly
      // all-caps but with one lowercase occurrence and CHP alongside.
      ...Array.from({ length: 40 }, (_, i) => ({
        id: `gz-${String(i).padStart(3, "0")}`,
        title:
          i === 0
            ? "CHP'li isimler hakkında gözaltı kararı"
            : `GÖZALTI kararı CHP ${i}`,
        url: null,
        source_id: ["src-gov-1", "src-gov-2", "src-gov-3"][i % 3]!,
        created_at: "x",
      })),
    ];
    const result = buildWeeklyDistinctiveWords(rows, SOURCES);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const gozalti = result.zones.iktidar.find((t) => t.term === "gözaltı");
      expect(gozalti?.display).toBe("gözaltı");
      const chp = result.zones.iktidar.find((t) => t.term === "chp");
      expect(chp?.display).toBe("CHP");
    }
  });

  it("an example url of 'javascript:alert(1)' becomes null", () => {
    const rows: WeeklyWordsArticleRow[] = [
      ...fillerRows(MIN, ["src-ind-1", "src-ind-2", "src-ind-3"], "ind"),
      ...fillerRows(MIN, ["src-opp-1", "src-opp-2", "src-opp-3"], "opp"),
      ...fillerRows(MIN - 40, ["src-gov-1", "src-gov-2", "src-gov-3"], "gov"),
      ...Array.from({ length: 40 }, (_, i) => ({
        id: `xz-${String(i).padStart(3, "0")}`,
        title: `Skandal haberi ${i}`,
        url: "javascript:alert(1)",
        source_id: ["src-gov-1", "src-gov-2", "src-gov-3"][i % 3]!,
        created_at: "x",
      })),
    ];
    const result = buildWeeklyDistinctiveWords(rows, SOURCES);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const skandal = result.zones.iktidar.find((t) => t.term === "skandal");
      expect(skandal?.example?.url).toBeNull();
    }
  });
});

/** Rows with a shared title template, spread over `sourceIds`, unique ids per `idPrefix`. */
function templateRows(
  n: number,
  sourceIds: string[],
  idPrefix: string,
  title: (i: number) => string,
): WeeklyWordsArticleRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${idPrefix}-${String(i).padStart(4, "0")}`,
    title: title(i),
    url: `https://example.com/${idPrefix}-${i}`,
    source_id: sourceIds[i % sourceIds.length]!,
    created_at: "2026-09-20T10:00:00.000Z",
  }));
}

const GOV_IDS = ["src-gov-1", "src-gov-2", "src-gov-3"];
const OPP_IDS = ["src-opp-1", "src-opp-2", "src-opp-3"];

describe("buildWeeklyDistinctiveWords: English and horoscope headlines", () => {
  it("drops English-language headlines (>= 2 function words) before they count or score", () => {
    const rows: WeeklyWordsArticleRow[] = [
      ...baselineRows(),
      ...templateRows(
        40,
        GOV_IDS,
        "en",
        (i) => `Erdogan meets Biden in New York to discuss trade ${i}`,
      ),
    ];
    const result = buildWeeklyDistinctiveWords(rows, SOURCES);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.sample.iktidar).toBe(MIN);
      const terms = result.zones.iktidar.map((t) => t.term);
      for (const banned of ["in", "to", "biden"]) {
        expect(terms).not.toContain(banned);
      }
    }
  });

  it("drops every row from an allow-listed English outlet, even with a single function word", () => {
    const sources: WeeklyWordsSourceRow[] = [
      ...SOURCES,
      {
        id: "src-anews",
        name: "A News",
        slug: "a-news",
        bias: "pro_government",
        kind: "outlet",
        active: true,
      },
    ];
    const rows: WeeklyWordsArticleRow[] = [
      ...baselineRows(),
      ...templateRows(
        40,
        ["src-anews"],
        "anews",
        (i) => `Besiktas, Anadolu Efes claim EuroLeague wins in Round 6 ${i}`,
      ),
    ];
    const result = buildWeeklyDistinctiveWords(rows, sources);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.sample.iktidar).toBe(MIN);
      const terms = result.zones.iktidar.map((t) => t.term);
      expect(terms).not.toContain("euroleague");
      expect(terms).not.toContain("in");
    }
  });

  it("control: the same one-function-word headlines from a non-allow-listed source are kept", () => {
    const rows: WeeklyWordsArticleRow[] = [
      ...baselineRows(),
      ...templateRows(
        40,
        GOV_IDS,
        "ctl",
        (i) => `Besiktas, Anadolu Efes claim EuroLeague wins in Round 6 ${i}`,
      ),
    ];
    const result = buildWeeklyDistinctiveWords(rows, SOURCES);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.sample.iktidar).toBe(MIN + 40);
    }
  });

  it("drops horoscope headlines (burç / astroloji / '<sign> burcu')", () => {
    const rows: WeeklyWordsArticleRow[] = [
      ...baselineRows(),
      ...templateRows(20, OPP_IDS, "hor-a", (i) => `Günlük Burç Yorumları ${i}`),
      ...templateRows(20, OPP_IDS, "hor-b", (i) => `Koç burcu haftalık yorum ${i}`),
    ];
    const result = buildWeeklyDistinctiveWords(rows, SOURCES);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.sample.muhalefet).toBe(MIN);
      const terms = result.zones.muhalefet.map((t) => t.term);
      expect(terms).not.toContain("burç");
      expect(terms).not.toContain("günlük");
    }
  });

  it("keeps Turkish headlines that merely contain 'on' or the name Burcu", () => {
    const rows: WeeklyWordsArticleRow[] = [
      ...fillerRows(MIN, ["src-ind-1", "src-ind-2", "src-ind-3"], "ind"),
      ...fillerRows(MIN, OPP_IDS, "opp"),
      ...fillerRows(MIN - 40, GOV_IDS, "gov"),
      ...templateRows(20, GOV_IDS, "tr-a", (i) => `On binlerin katıldığı miting ${i}`),
      ...templateRows(20, GOV_IDS, "tr-b", (i) => `Burcu Köksal miting açıklaması ${i}`),
    ];
    const result = buildWeeklyDistinctiveWords(rows, SOURCES);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.sample.iktidar).toBe(MIN);
      expect(result.zones.iktidar.map((t) => t.term)).toContain("miting");
    }
  });

  it("filters before dedupe: a dropped English title never shadows a kept title with the same headlineKey", () => {
    // headlineKey folds "İstanbul" and "istanbul" together, so these two
    // collide on key. The ASCII one sorts first by id and is English (in,
    // the); the dotted-İ one is Turkish and must survive.
    const rows: WeeklyWordsArticleRow[] = [
      ...baselineRows(),
      { id: "a-1", title: "istanbul in the rain", url: null, source_id: "src-gov-1", created_at: "x" },
      { id: "b-1", title: "İstanbul in the rain", url: null, source_id: "src-gov-1", created_at: "x" },
    ];
    const result = buildWeeklyDistinctiveWords(rows, SOURCES);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.sample.iktidar).toBe(MIN + 1);
    }
  });
});

// ---------------------------------------------------------------------------
// Per-source share cap (h24-pages-1): one outlet's template wording is not how
// a zone writes. The fixtures mirror the live /hafta bagimsiz list of
// 2026-11-02: Haberport's "coşkusu" event copy and Haber.com's "dakikada"
// match reports, each carried by a handful of stray headlines from other
// outlets (enough to pass minSources 3).
// ---------------------------------------------------------------------------

function centerOutlet(slug: string, name: string): WeeklyWordsSourceRow {
  return { id: `src-${slug}`, name, slug, bias: "center", kind: "outlet", active: true };
}

const CAP_SOURCES: WeeklyWordsSourceRow[] = [
  ...SOURCES,
  centerOutlet("haberport", "Haberport"),
  centerOutlet("haber-com", "Haber.com"),
  centerOutlet("karar", "Karar"),
  centerOutlet("dijital-gaste", "Dijital Gaste"),
  centerOutlet("dokuz8-haber", "Dokuz8 Haber"),
  centerOutlet("turkiye-haber-ajansi", "Türkiye Haber Ajansı"),
];

const IND_IDS = ["src-ind-1", "src-ind-2", "src-ind-3"];

/** True when some listed term (a unigram or a bigram) contains `token`. */
function listsToken(
  list: ReadonlyArray<{ term: string }>,
  token: string,
): boolean {
  return list.some((t) => t.term.split(" ").includes(token));
}

/**
 * A week with every zone at or above the minimum. bagimsiz = 150 filler
 * headlines + 60 'enflasyon' headlines evenly over three outlets (so the zone
 * always has a non-empty, spread list) + `extra`.
 */
function capWeek(extra: WeeklyWordsArticleRow[]): WeeklyWordsArticleRow[] {
  return [
    ...fillerRows(MIN, GOV_IDS, "gov"),
    ...fillerRows(MIN, OPP_IDS, "opp"),
    ...fillerRows(150, IND_IDS, "ind"),
    ...templateRows(60, IND_IDS, "infl", (i) => `Enflasyon bugün ${i}`),
    ...extra,
  ];
}

/** Haberport at ~32% of the zone: 95 of its 100 titles carry the template word, plus 3 stray titles from three other outlets. */
function haberportFixture(): WeeklyWordsArticleRow[] {
  return capWeek([
    ...templateRows(95, ["src-haberport"], "hp-t", (i) => `Cumhuriyet coşkusu ${i}`),
    ...templateRows(5, ["src-haberport"], "hp-o", (i) => `Ekonomi haberi hp ${i}`),
    ...templateRows(
      3,
      ["src-karar", "src-dijital-gaste", "src-dokuz8-haber"],
      "hp-s",
      (i) => `Coşkusu hiç bitmedi ${i}`,
    ),
  ]);
}

/** Haber.com match reports: 88 of 100 titles, plus 14 stray titles from five other outlets (Haberport among them). */
function haberComFixture(): WeeklyWordsArticleRow[] {
  const strays: Array<[string, number]> = [
    ["src-karar", 4],
    ["src-haberport", 4],
    ["src-dijital-gaste", 2],
    ["src-dokuz8-haber", 2],
    ["src-turkiye-haber-ajansi", 2],
  ];
  return capWeek([
    ...templateRows(
      88,
      ["src-haber-com"],
      "hc-t",
      (i) => `Takım${i} - Rakip${i}: Oyuncu${i} ${(i % 90) + 1}. dakikada gol attı`,
    ),
    ...templateRows(12, ["src-haber-com"], "hc-o", (i) => `Ekonomi haberi hc ${i}`),
    ...strays.flatMap(([sourceId, n]) =>
      templateRows(n, [sourceId], `hc-s-${sourceId}`, (i) => `Maçın ${i + 10}. dakikada gol geldi`),
    ),
  ]);
}

function bagimsizList(rows: WeeklyWordsArticleRow[], opts?: { maxSourceShare: number }) {
  const result = buildWeeklyDistinctiveWords(rows, CAP_SOURCES, opts);
  expect(result.status).toBe("ok");
  if (result.status !== "ok") throw new Error("expected an ok result");
  return result.zones.bagimsiz;
}

describe("buildWeeklyDistinctiveWords: one outlet's template wording", () => {
  it("keeps every zone at or above the minimum in the Haberport fixture, with Haberport near a third of bagimsiz", () => {
    const result = buildWeeklyDistinctiveWords(haberportFixture(), CAP_SOURCES);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.sample.bagimsiz).toBe(150 + 60 + 100 + 3);
      expect(result.sample.bagimsiz).toBeGreaterThanOrEqual(MIN);
      expect(100 / result.sample.bagimsiz).toBeGreaterThan(0.3);
      expect(100 / result.sample.bagimsiz).toBeLessThan(0.4);
    }
  });

  it("control: without the cap, the Haberport template word is listed for bagimsiz", () => {
    const list = bagimsizList(haberportFixture(), { maxSourceShare: 1 });
    const hit = list.find((t) => t.term === "coşkusu");
    expect(hit).toBeDefined();
    expect(hit!.count).toBe(98);
  });

  it("drops the Haberport template word 'coşkusu' (95 of 98 headlines from one outlet) from bagimsiz", () => {
    const list = bagimsizList(haberportFixture());
    expect(listsToken(list, "coşkusu")).toBe(false);
    expect(listsToken(list, "cumhuriyet")).toBe(false);
    // The zone's evenly spread vocabulary is still there.
    expect(list.map((t) => t.term)).toContain("enflasyon");
  });

  it("control: without the cap, the Haber.com match-report words are listed for bagimsiz", () => {
    const list = bagimsizList(haberComFixture(), { maxSourceShare: 1 });
    expect(listsToken(list, "dakikada")).toBe(true);
    expect(listsToken(list, "gol")).toBe(true);
  });

  it("drops the Haber.com match-report words 'dakikada' and 'gol' from bagimsiz", () => {
    const list = bagimsizList(haberComFixture());
    expect(listsToken(list, "dakikada")).toBe(false);
    expect(listsToken(list, "gol")).toBe(false);
    expect(list.map((t) => t.term)).toContain("enflasyon");
  });

  it("lists a word spread evenly over three outlets", () => {
    const list = bagimsizList(capWeek([]));
    const hit = list.find((t) => t.term === "enflasyon");
    expect(hit).toBeDefined();
    expect(hit!.count).toBe(60);
  });

  it("lists a word spread evenly over four outlets, the one holding a third of the zone among them", () => {
    // 24 'bütçe' headlines from each of Haberport and three other outlets: the
    // big outlet is allowed to carry a word as long as it is not the only one.
    const list = bagimsizList(
      capWeek([
        ...templateRows(
          96,
          ["src-haberport", "src-ind-1", "src-ind-2", "src-ind-3"],
          "bu",
          (i) => `Bütçe görüşmeleri ${i}`,
        ),
        ...templateRows(60, ["src-haberport"], "hp-f", (i) => `Ekonomi haberi hpf ${i}`),
      ]),
    );
    expect(listsToken(list, "bütçe")).toBe(true);
  });

  it("applies the cap to the zone's own outlets only: the same word stays in a zone where it is spread", () => {
    // 'coşkusu' dominated by Haberport in bagimsiz (dropped there) but spread
    // evenly over the three government outlets (kept in iktidar).
    const rows = [
      ...haberportFixture(),
      ...templateRows(60, GOV_IDS, "gv-c", (i) => `Coşkusu sürüyor ${i}`),
      ...templateRows(60, GOV_IDS, "gv-d", (i) => `Diyanet ödeneği ${i}`),
    ];
    const result = buildWeeklyDistinctiveWords(rows, CAP_SOURCES);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(listsToken(result.zones.iktidar, "coşkusu")).toBe(true);
      expect(listsToken(result.zones.bagimsiz, "coşkusu")).toBe(false);
    }
  });
});

describe("buildWeeklyDistinctiveWords: the cap leaves evenly spread fixtures unchanged", () => {
  /** The fixtures of the tests above, rebuilt: every word is spread over the zone's three outlets. */
  const fixtures: Array<[string, () => WeeklyWordsArticleRow[]]> = [
    ["baseline filler", () => baselineRows()],
    [
      "gözaltı / CHP in iktidar",
      () => [
        ...fillerRows(MIN, IND_IDS, "ind"),
        ...fillerRows(MIN, OPP_IDS, "opp"),
        ...fillerRows(MIN - 40, GOV_IDS, "gov"),
        ...Array.from({ length: 40 }, (_, i) => ({
          id: `gz-${String(i).padStart(3, "0")}`,
          title: i === 0 ? "CHP'li isimler hakkında gözaltı kararı" : `GÖZALTI kararı CHP ${i}`,
          url: null,
          source_id: GOV_IDS[i % 3]!,
          created_at: "x",
        })),
      ],
    ],
    [
      "miting / Burcu Köksal in iktidar",
      () => [
        ...fillerRows(MIN, IND_IDS, "ind"),
        ...fillerRows(MIN, OPP_IDS, "opp"),
        ...fillerRows(MIN - 40, GOV_IDS, "gov"),
        ...templateRows(20, GOV_IDS, "tr-a", (i) => `On binlerin katıldığı miting ${i}`),
        ...templateRows(20, GOV_IDS, "tr-b", (i) => `Burcu Köksal miting açıklaması ${i}`),
      ],
    ],
    [
      "skandal haberi with a javascript: url",
      () => [
        ...fillerRows(MIN, IND_IDS, "ind"),
        ...fillerRows(MIN, OPP_IDS, "opp"),
        ...fillerRows(MIN - 40, GOV_IDS, "gov"),
        ...Array.from({ length: 40 }, (_, i) => ({
          id: `xz-${String(i).padStart(3, "0")}`,
          title: `Skandal haberi ${i}`,
          url: "javascript:alert(1)",
          source_id: GOV_IDS[i % 3]!,
          created_at: "x",
        })),
      ],
    ],
    [
      "control one-function-word English headlines",
      () => [
        ...baselineRows(),
        ...templateRows(
          40,
          GOV_IDS,
          "ctl",
          (i) => `Besiktas, Anadolu Efes claim EuroLeague wins in Round 6 ${i}`,
        ),
      ],
    ],
  ];

  for (const [name, build] of fixtures) {
    it(`${name}: default options and maxSourceShare 1 give the same payload`, () => {
      const rows = build();
      const capped = buildWeeklyDistinctiveWords(rows, SOURCES);
      const uncapped = buildWeeklyDistinctiveWords(rows, SOURCES, { maxSourceShare: 1 });
      expect(capped.status).toBe("ok");
      expect(capped).toEqual(uncapped);
    });
  }

  it("the gözaltı fixture still lists gözaltı and CHP for iktidar", () => {
    const [, build] = fixtures[1]!;
    const result = buildWeeklyDistinctiveWords(build(), SOURCES);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const terms = result.zones.iktidar.map((t) => t.term);
      expect(terms).toContain("gözaltı");
      expect(terms).toContain("chp");
    }
  });
});

describe("isLikelyEnglishHeadline", () => {
  it("exposes the function-word set and the threshold", () => {
    expect(EN_MIN_FUNCTION_WORDS).toBe(2);
    for (const w of [
      "the", "in", "to", "for", "of", "with", "and", "on",
      "at", "by", "from", "as", "is", "are", "after", "over",
    ]) {
      expect(EN_FUNCTION_WORDS.has(w)).toBe(true);
    }
    expect(EN_FUNCTION_WORDS.size).toBe(16);
  });

  it("is false for a Turkish headline with a single function word ('on' = ten)", () => {
    expect(isLikelyEnglishHeadline("Merkez Bankasi faiz kararini on gun sonra verecek")).toBe(false);
  });

  it("is true for an English headline with several function words", () => {
    expect(isLikelyEnglishHeadline("Turkey's parliament approves the budget in final vote")).toBe(true);
  });

  it("is false when the title contains a Turkish letter, whatever else it says", () => {
    expect(isLikelyEnglishHeadline("İstanbul in the rain")).toBe(false);
    expect(isLikelyEnglishHeadline("Erdoğan meets Biden in New York")).toBe(false);
  });

  it("treats a decomposed Turkish letter (NFD) as a Turkish letter", () => {
    expect(isLikelyEnglishHeadline("I\u0307stanbul in the rain".normalize("NFD"))).toBe(false);
  });

  it("matches function words case-insensitively without Turkish-locale folding ('IN' stays 'in')", () => {
    expect(isLikelyEnglishHeadline("TRUMP IN THE WHITE HOUSE")).toBe(true);
  });

  it("is false for empty, whitespace and punctuation-only titles", () => {
    expect(isLikelyEnglishHeadline("")).toBe(false);
    expect(isLikelyEnglishHeadline("   ")).toBe(false);
    expect(isLikelyEnglishHeadline("!!! ???")).toBe(false);
  });

  it("is false for ASCII-only Turkish with no English function words", () => {
    expect(isLikelyEnglishHeadline("Merkez Bankasi faiz karari aciklandi")).toBe(false);
  });
});

describe("ENGLISH_SOURCE_SLUGS", () => {
  it("lists the English-language outlets named in the cluster entities", () => {
    expect([...ENGLISH_SOURCE_SLUGS].sort()).toEqual([
      "a-news",
      "daily-sabah",
      "hurriyet-daily-news",
      "trt-world",
    ]);
  });
});

describe("isHoroscopeHeadline", () => {
  it("is true for burç words, in any case", () => {
    expect(isHoroscopeHeadline("BURÇLAR")).toBe(true);
    expect(isHoroscopeHeadline("Günlük Burç Yorumları")).toBe(true);
    expect(isHoroscopeHeadline("Burçları bekleyen sürpriz")).toBe(true);
    expect(isHoroscopeHeadline("Burçlara özel yorum")).toBe(true);
    expect(isHoroscopeHeadline("Burcunuz bugün ne diyor")).toBe(true);
  });

  it("is true for astroloji-prefixed tokens", () => {
    expect(isHoroscopeHeadline("ASTROLOJİ yorumu")).toBe(true);
    expect(isHoroscopeHeadline("Astrolojide yeni dönem")).toBe(true);
    expect(isHoroscopeHeadline("Astrolog uyardı")).toBe(false);
  });

  it("is true for '<sign> burcu' forms", () => {
    expect(isHoroscopeHeadline("Aslan burcunu bekleyenler")).toBe(true);
    expect(isHoroscopeHeadline("Koç burcu haftalık yorum")).toBe(true);
    expect(isHoroscopeHeadline("Yengeç burcunun haftası")).toBe(true);
    expect(isHoroscopeHeadline("Balık burcuna müjde")).toBe(true);
    expect(isHoroscopeHeadline("YAY BURCU")).toBe(true);
  });

  it("is false for the given name Burcu, alone or after a non-sign", () => {
    expect(isHoroscopeHeadline("Burcu Köksal açıklama yaptı")).toBe(false);
    expect(isHoroscopeHeadline("Belediye Başkanı Burcu Köksal")).toBe(false);
    expect(isHoroscopeHeadline("Burcu")).toBe(false);
  });

  it("is false for a zodiac word without 'burcu', and for empty input", () => {
    expect(isHoroscopeHeadline("Başak Demirtaş sahneye çıktı")).toBe(false);
    expect(isHoroscopeHeadline("Terazi ve kova tartışması")).toBe(false);
    expect(isHoroscopeHeadline("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Quoted headlines (h51-morphology-1): an opening quote is plain punctuation,
// not a suffix apostrophe, so the quoted word is counted, listed and deduped.
// ---------------------------------------------------------------------------

describe("buildWeeklyDistinctiveWords: quoted headlines", () => {
  /** A week with every zone at the minimum and `extra` rows added to muhalefet. */
  function quoteWeek(extra: WeeklyWordsArticleRow[]): WeeklyWordsArticleRow[] {
    return [
      ...fillerRows(MIN, GOV_IDS, "gov"),
      ...fillerRows(MIN, IND_IDS, "ind"),
      ...fillerRows(MIN, OPP_IDS, "opp"),
      ...extra,
    ];
  }

  // These tests are about how quoted headlines are tokenised and counted, on
  // fixtures of 12 to 21 headlines (z about 3.1). They pin the fixed 1.96 cut
  // with nullPermutations 0; the calibrated cut is tested on its own below.
  function muhalefetTerm(rows: WeeklyWordsArticleRow[], term: string) {
    const result = buildWeeklyDistinctiveWords(rows, SOURCES, { nullPermutations: 0 });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected an ok result");
    return { result, hit: result.zones.muhalefet.find((t) => t.term === term) };
  }

  it("counts a headline whose AKP follows an opening quote after a colon", () => {
    // 15 plain AKP headlines + 6 of the form: Tepki yağdı: 'AKP vatandaşa ...'
    const { result, hit } = muhalefetTerm(
      quoteWeek([
        ...templateRows(15, OPP_IDS, "akp-p", (i) => `AKP kongresi sonrası tartışma ${i}`),
        ...templateRows(
          6,
          OPP_IDS,
          "akp-q",
          (i) => `Yeni Parti'den tepki yağdı: 'AKP vatandaşa yeni bir tuzak kuruyor' ${i}`,
        ),
      ]),
      "akp",
    );
    expect(result.status).toBe("ok");
    expect(hit).toBeDefined();
    expect(hit!.count).toBe(21);
    expect(hit!.display).toBe("AKP");
  });

  it("lists a word that only ever appears in opening quotes", () => {
    const { hit } = muhalefetTerm(
      quoteWeek(
        templateRows(12, OPP_IDS, "slg", (i) => `Sokakta slogan: 'Tuzak' diyenler çoğaldı ${i}`),
      ),
      "tuzak",
    );
    expect(hit).toBeDefined();
    expect(hit!.count).toBe(12);
  });

  it("still cuts the Turkish suffix in the same headlines: Erdoğan’ın is counted as erdoğan", () => {
    const { result, hit } = muhalefetTerm(
      quoteWeek(
        templateRows(12, OPP_IDS, "erd", (i) => `Erdoğan’ın 'Reform' paketi sonrası tepki ${i}`),
      ),
      "erdoğan",
    );
    expect(hit).toBeDefined();
    expect(hit!.count).toBe(12);
    const surfaces = result.status === "ok" ? result.zones.muhalefet.map((t) => t.term) : [];
    expect(surfaces).not.toContain("erdoğan’ın");
    expect(surfaces).not.toContain("erdoğanın");
  });

  it("dedupe keeps two headlines that differ only in the quoted word", () => {
    const result = buildWeeklyDistinctiveWords(
      quoteWeek([
        { id: "q-a", title: "'İhmal' iddiası", url: null, source_id: "src-opp-1", created_at: "x" },
        { id: "q-b", title: "'Darbe' iddiası", url: null, source_id: "src-opp-2", created_at: "x" },
      ]),
      SOURCES,
    );
    expect(result.status).toBe("ok");
    expect(result.sample.muhalefet).toBe(MIN + 2);
  });

  it("dedupe folds a quoted and an unquoted copy of the same headline into one", () => {
    const result = buildWeeklyDistinctiveWords(
      quoteWeek([
        { id: "q-a", title: "'AKP' yeni kararı açıkladı", url: null, source_id: "src-opp-1", created_at: "x" },
        { id: "q-b", title: "AKP yeni kararı açıkladı", url: null, source_id: "src-opp-2", created_at: "x" },
      ]),
      SOURCES,
    );
    expect(result.status).toBe("ok");
    expect(result.sample.muhalefet).toBe(MIN + 1);
  });
});

// ---------------------------------------------------------------------------
// The z cut is calibrated by label permutation (h52-weekly-1): ~1,000 candidate
// terms per zone make 1.96 a noise threshold, so the payload carries the cut
// that shuffled zone labels rarely beat and a zone lists only terms above it.
// ---------------------------------------------------------------------------

/** Seeded uniform generator (mulberry32): the fixtures are identical on every run. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOISE_ZONES: Array<{ ids: string[]; prefix: string }> = [
  { ids: GOV_IDS, prefix: "gov" },
  { ids: IND_IDS, prefix: "ind" },
  { ids: OPP_IDS, prefix: "opp" },
];

/**
 * A week of pure noise: `perZone` headlines per zone, each 8 draws from a
 * 300-word Zipf vocabulary, outlet picked at random within the zone. The zone
 * has no influence on the words. `decorate` may append words to chosen titles.
 */
function noiseWeek(
  seed: number,
  perZone = 250,
  decorate: (zonePrefix: string, i: number) => string = () => "",
): WeeklyWordsArticleRow[] {
  const rand = seededRandom(seed);
  const cumulative: number[] = [];
  let total = 0;
  for (let rank = 1; rank <= 300; rank++) {
    total += 1 / rank;
    cumulative.push(total);
  }
  const draw = (): string => {
    const target = rand() * total;
    let lo = 0;
    let hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid]! < target) lo = mid + 1;
      else hi = mid;
    }
    return `kelime${lo}`;
  };

  const rows: WeeklyWordsArticleRow[] = [];
  for (const { ids, prefix } of NOISE_ZONES) {
    for (let i = 0; i < perZone; i++) {
      const words = Array.from({ length: 8 }, draw);
      rows.push({
        id: `${prefix}-${String(i).padStart(4, "0")}`,
        title: `${words.join(" ")} ${decorate(prefix, i)}`.trim(),
        url: `https://example.com/${prefix}-${i}`,
        source_id: ids[Math.floor(rand() * ids.length)]!,
        created_at: "2026-11-02T10:00:00.000Z",
      });
    }
  }
  return rows;
}

function okPayload(rows: WeeklyWordsArticleRow[], opts?: Parameters<typeof buildWeeklyDistinctiveWords>[2]) {
  const result = buildWeeklyDistinctiveWords(rows, SOURCES, opts);
  expect(result.status).toBe("ok");
  if (result.status !== "ok") throw new Error("expected an ok result");
  return result;
}

const NOISE_SEEDS = [101, 202, 303];
const ZONE_KEYS = ["iktidar", "bagimsiz", "muhalefet"] as const;

describe("buildWeeklyDistinctiveWords: calibrated z cut", () => {
  it("carries zCut in the ok payload, a finite number never below FW_DEFAULTS.zMin", () => {
    for (const rows of [baselineRows(), noiseWeek(101)]) {
      const result = okPayload(rows);
      expect(typeof result.zCut).toBe("number");
      expect(Number.isFinite(result.zCut)).toBe(true);
      expect(result.zCut).toBeGreaterThanOrEqual(FW_DEFAULTS.zMin);
    }
  });

  it("on a noise week the cut is well above 1.96", () => {
    for (const seed of NOISE_SEEDS) {
      expect(okPayload(noiseWeek(seed)).zCut, `seed ${seed}`).toBeGreaterThan(2.5);
    }
  });

  it("lists nothing on pure noise, where the fixed 1.96 cut lists chance words (control)", () => {
    for (const seed of NOISE_SEEDS) {
      const rows = noiseWeek(seed);
      const calibrated = okPayload(rows);
      for (const zone of ZONE_KEYS) expect(calibrated.zones[zone], `seed ${seed} ${zone}`).toEqual([]);

      const fixed = okPayload(rows, { nullPermutations: 0 });
      expect(ZONE_KEYS.some((zone) => fixed.zones[zone].length > 0), `seed ${seed} fixed cut`).toBe(true);
    }
  });

  it("nullPermutations 0 turns the calibration off: the cut is zMin, and a caller's zMin is kept", () => {
    const rows = noiseWeek(101);
    expect(okPayload(rows, { nullPermutations: 0 }).zCut).toBe(FW_DEFAULTS.zMin);
    expect(okPayload(rows, { nullPermutations: 0, zMin: 2.5 }).zCut).toBe(2.5);
  });

  it("with the calibration off it lists exactly what the fixed cut listed", () => {
    const rows = noiseWeek(101);
    const off = okPayload(rows, { nullPermutations: 0 });
    // Every listed term clears 1.96 and the lists are longer than the calibrated ones.
    for (const zone of ZONE_KEYS) {
      for (const term of off.zones[zone]) expect(term.z).toBeGreaterThanOrEqual(FW_DEFAULTS.zMin);
    }
    const total = ZONE_KEYS.reduce((n, zone) => n + off.zones[zone].length, 0);
    expect(total).toBeGreaterThan(0);
  });

  it("is deterministic: the same rows give the same payload, in any row order", () => {
    const rows = noiseWeek(202);
    const first = okPayload(rows);
    expect(okPayload(rows)).toEqual(first);
    expect(okPayload([...rows].reverse())).toEqual(first);
    expect(okPayload(noiseWeek(202))).toEqual(first);
  });

  it("two planted words in 40 muhalefet headlines each (and 2 elsewhere) both surface there, above the cut", () => {
    const rows = noiseWeek(303, 250, (prefix, i) => {
      if (prefix === "opp" && i < 40) return "yolsuzluk";
      if (prefix === "opp" && i >= 40 && i < 80) return "zamlar";
      if ((prefix === "gov" || prefix === "ind") && i === 100) return "yolsuzluk zamlar";
      return "";
    });
    const result = okPayload(rows);
    const terms = result.zones.muhalefet.map((t) => t.term);
    expect(terms).toEqual(expect.arrayContaining(["yolsuzluk", "zamlar"]));
    expect(result.zones.iktidar).toEqual([]);
    expect(result.zones.bagimsiz).toEqual([]);
    for (const t of result.zones.muhalefet) expect(t.z).toBeGreaterThanOrEqual(result.zCut);
    expect(result.zCut).toBeGreaterThan(FW_DEFAULTS.zMin);
  });

  it("a zone with fewer than minTermsToShow terms above the cut falls through to an empty list", () => {
    const rows = noiseWeek(303, 250, (prefix, i) => (prefix === "opp" && i < 40 ? "yolsuzluk" : ""));
    const one = okPayload(rows);
    // One word clears the cut; two are needed to list a zone.
    expect(one.zones.muhalefet).toEqual([]);
    const lenient = okPayload(rows, { minTermsToShow: 1 });
    expect(lenient.zones.muhalefet.map((t) => t.term)).toEqual(["yolsuzluk"]);
    expect(lenient.zones.muhalefet[0]!.z).toBeGreaterThanOrEqual(lenient.zCut);
  });

  it("every listed term clears the payload's cut, in every zone", () => {
    const rows = noiseWeek(101, 250, (prefix, i) => {
      if (prefix === "gov" && i < 60) return "gözaltı kararı";
      if (prefix === "opp" && i < 60) return "enflasyon zam";
      return "";
    });
    const result = okPayload(rows);
    expect(ZONE_KEYS.some((zone) => result.zones[zone].length > 0)).toBe(true);
    for (const zone of ZONE_KEYS) {
      for (const t of result.zones[zone]) expect(t.z).toBeGreaterThanOrEqual(result.zCut);
    }
  });

  it("keeps the insufficient payload free of a cut (nothing was scored)", () => {
    const result = buildWeeklyDistinctiveWords(fillerRows(10, GOV_IDS, "gov"), SOURCES);
    expect(result.status).toBe("insufficient");
    expect("zCut" in result).toBe(false);
  });
});
