import { describe, it, expect } from "vitest";
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
