import { describe, expect, it } from "vitest";

import { expectLinear, rep } from "../../../tests/_helpers/linear-time";
import {
  MAX_OUTLET_TERMS,
  OUTLET_QUALIFIER,
  OUTLET_WORD_DENY,
  TICKER_INTENT_SHAPE,
  TICKER_WORD_DENY,
  foldWord,
  matchOutlet,
  outletNameWords,
  outletQueryWords,
  resolveSearchIntent,
  searchIntentLink,
  tickerCandidate,
  type IntentSource,
} from "./search-intent";

// h153: the home search offers one link row to /ekonomi/<TICKER> or
// /source/<slug> when the whole query is a traded BIST code or an active
// outlet's name. These are the pure rules; the lookups are search-intent-query.

// In production's order (the registry reads by name), so "first in input order
// wins" is testable.
const SOURCES: IntentSource[] = [
  { slug: "hurriyet", name: "Hürriyet" },
  { slug: "hurriyet-daily-news", name: "Hürriyet Daily News" },
  { slug: "sozcu", name: "Sözcü" },
  { slug: "ntv", name: "NTV" },
  { slug: "ntv-spor", name: "NTV Spor" },
  { slug: "halk-tv", name: "Halk TV" },
  { slug: "sabah", name: "Sabah" },
  { slug: "daily-sabah", name: "Daily Sabah" },
  { slug: "birgun", name: "BirGün" },
  { slug: "odatv", name: "OdaTV" },
  { slug: "turkiye-gazetesi", name: "Türkiye Gazetesi" },
  { slug: "karar", name: "Karar" },
  { slug: "cumhuriyet", name: "Cumhuriyet" },
  { slug: "haberler-com", name: "Haberler.com" },
  { slug: "yenicag", name: "Yeniçağ" },
  { slug: "gercek-gundem", name: "Gerçek Gündem" },
  { slug: "iha", name: "İHA" },
];

const slugOf = (q: string, sources: IntentSource[] | null = SOURCES): string | null => {
  const words = outletQueryWords(q);
  if (words === null) return null;
  return matchOutlet(words, sources)?.slug ?? null;
};

describe("tickerCandidate", () => {
  it.each([
    ["THYAO", "THYAO"],
    ["thyao", "THYAO"],
    ["Thyao", "THYAO"],
    [" kchol ", "KCHOL"],
  ])("%j gives %s", (q, code) => {
    expect(tickerCandidate(q)).toBe(code);
  });

  it("folds the Turkish dotted and dotless I", () => {
    for (const q of ["İSCTR", "ısctr", "isctr", "ISCTR", "İsctr"]) {
      expect(tickerCandidate(q), q).toBe("ISCTR");
    }
  });

  it("cuts a Turkish apostrophe suffix", () => {
    expect(tickerCandidate("THYAO'nun")).toBe("THYAO");
    expect(tickerCandidate("THYAO’nun")).toBe("THYAO");
    expect(tickerCandidate("thyao'da")).toBe("THYAO");
  });

  it("strips edge punctuation such as a hashtag or a cashtag", () => {
    expect(tickerCandidate("#THYAO")).toBe("THYAO");
    expect(tickerCandidate("$THYAO")).toBe("THYAO");
    expect(tickerCandidate("THYAO!")).toBe("THYAO");
  });

  it("refuses a code that is too short, too long or has a digit", () => {
    expect(tickerCandidate("THY")).toBeNull();
    expect(tickerCandidate("THYAOXX")).toBeNull();
    expect(tickerCandidate("ASELS2")).toBeNull();
    expect(tickerCandidate("2THYAO")).toBeNull();
  });

  it("refuses more than one term", () => {
    expect(tickerCandidate("THYAO hisse")).toBeNull();
    expect(tickerCandidate("THYAO KCHOL")).toBeNull();
  });

  it("refuses search operators and empty input", () => {
    expect(tickerCandidate('"thyao"')).toBeNull();
    expect(tickerCandidate("-thyao")).toBeNull();
    expect(tickerCandidate("thyao or kchol")).toBeNull();
    expect(tickerCandidate("")).toBeNull();
    expect(tickerCandidate("   ")).toBeNull();
    expect(tickerCandidate("!!")).toBeNull();
  });

  it("refuses a code with a non-ASCII letter that is not a Turkish fold", () => {
    expect(tickerCandidate("thyaé")).toBeNull();
    // 'ß' upper-cases to 'SS', which would make four letters out of two.
    expect(tickerCandidate("ßß")).toBeNull();
    expect(tickerCandidate("kaßa")).toBeNull();
  });

  it.each(["deva", "DEVA", "Deva", "MAVİ", "mavi", "konya", "altın", "denge", "aksa", "uşak", "dağı"])(
    "refuses the everyday word %j",
    (q) => {
      expect(tickerCandidate(q)).toBeNull();
    },
  );

  it("refuses every TICKER_WORD_DENY entry, in upper and lower case", () => {
    expect(TICKER_WORD_DENY.size).toBeGreaterThan(40);
    for (const word of TICKER_WORD_DENY) {
      expect(tickerCandidate(word), word).toBeNull();
      expect(tickerCandidate(word.toLowerCase()), word.toLowerCase()).toBeNull();
    }
  });

  it("keeps every TICKER_WORD_DENY entry in the shape of a ticker (an entry that could never match is dead)", () => {
    for (const word of TICKER_WORD_DENY) {
      expect(TICKER_INTENT_SHAPE.test(word), word).toBe(true);
    }
  });

  it("keeps company brands allowed: there the reader means the company", () => {
    for (const code of ["SASA", "ULKER", "VAKKO", "KOTON", "AYGAZ", "SANKO", "ASTOR", "PENTA"]) {
      expect(TICKER_WORD_DENY.has(code), code).toBe(false);
      expect(tickerCandidate(code), code).toBe(code);
    }
  });

  it("records the measured collisions (Step 0, 2026-11-12) in the deny list", () => {
    for (const code of ["EKIM", "HEDEF", "SOKE", "BIZIM", "AFYON", "TERA", "FENER", "ISKUR", "YIGIT", "CIMSA"]) {
      expect(TICKER_WORD_DENY.has(code), code).toBe(true);
    }
  });

  it("is linear in a long input", () => {
    for (const gen of [rep("a"), rep("-"), rep("ab'")]) {
      expectLinear(gen, (q) => tickerCandidate(q), { n: 200_000, ceilingMs: 4000 });
    }
  });
});

describe("foldWord", () => {
  it("keeps a-z and 0-9, folds Turkish letters and drops separators", () => {
    expect(foldWord("Hürriyet")).toBe("hurriyet");
    expect(foldWord("HALK-TV")).toBe("halktv");
    expect(foldWord("haberler.com")).toBe("haberlercom");
    expect(foldWord("a_b&c+d'e’f")).toBe("abcdef");
    expect(foldWord("Haber3")).toBe("haber3");
  });

  it("returns null for any other character", () => {
    expect(foldWord("Café")).toBeNull();
    expect(foldWord("a b")).toBeNull();
    expect(foldWord("a/b")).toBeNull();
    expect(foldWord("日本")).toBeNull();
  });

  it("returns an empty string for a word made only of separators", () => {
    expect(foldWord("...")).toBe("");
    expect(foldWord("")).toBe("");
  });
});

describe("outletQueryWords", () => {
  it.each(["Hürriyet", "hurriyet", "HÜRRİYET", "HURRIYET", "Hürriyet'in"])("%j gives [hurriyet]", (q) => {
    expect(outletQueryWords(q)).toEqual(["hurriyet"]);
  });

  it("keeps the words of a multi-word name", () => {
    expect(outletQueryWords("Halk TV")).toEqual(["halk", "tv"]);
    expect(outletQueryWords("hürriyet daily news")).toEqual(["hurriyet", "daily", "news"]);
  });

  it("drops separators inside a word", () => {
    expect(outletQueryWords("halktv")).toEqual(["halktv"]);
    expect(outletQueryWords("HALK-TV")).toEqual(["halktv"]);
    expect(outletQueryWords("haberler.com")).toEqual(["haberlercom"]);
  });

  it("refuses a non-ASCII letter that is left after folding", () => {
    expect(outletQueryWords("Café")).toBeNull();
  });

  it("refuses more than MAX_OUTLET_TERMS terms", () => {
    expect(MAX_OUTLET_TERMS).toBe(4);
    expect(outletQueryWords("a1 b2 c3 d4")).toEqual(["a1", "b2", "c3", "d4"]);
    expect(outletQueryWords("a1 b2 c3 d4 e5")).toBeNull();
    expect(outletQueryWords("asgari ücret zammı ne zaman açıklanacak")).toBeNull();
  });

  it("refuses operators, empty input and a length outside 2..40", () => {
    expect(outletQueryWords('"sözcü"')).toBeNull();
    expect(outletQueryWords("-sözcü")).toBeNull();
    expect(outletQueryWords("sözcü or ntv")).toBeNull();
    expect(outletQueryWords("")).toBeNull();
    expect(outletQueryWords("!!")).toBeNull();
    expect(outletQueryWords("a")).toBeNull();
    expect(outletQueryWords("ab")).toEqual(["ab"]);
    expect(outletQueryWords("a".repeat(40))).toEqual(["a".repeat(40)]);
    expect(outletQueryWords("a".repeat(41))).toBeNull();
  });

  it("is linear in a long input", () => {
    for (const gen of [rep("a"), rep("-"), rep("ab'")]) {
      expectLinear(gen, (q) => outletQueryWords(q), { n: 200_000, ceilingMs: 4000 });
    }
  });
});

describe("outletNameWords", () => {
  it("folds a source name the way the query is folded", () => {
    expect(outletNameWords("Hürriyet")).toEqual(["hurriyet"]);
    expect(outletNameWords("Halk TV")).toEqual(["halk", "tv"]);
    expect(outletNameWords("BirGün")).toEqual(["birgun"]);
    expect(outletNameWords("Yeniçağ")).toEqual(["yenicag"]);
    expect(outletNameWords("Haberler.com")).toEqual(["haberlercom"]);
    expect(outletNameWords("İnternet Haber")).toEqual(["internet", "haber"]);
  });

  it("returns null for a name with a character it cannot fold", () => {
    expect(outletNameWords("Café Haber")).toBeNull();
  });
});

describe("matchOutlet", () => {
  it("matches the name as typed, folded and with a suffix", () => {
    expect(slugOf("Hürriyet")).toBe("hurriyet");
    expect(slugOf("hurriyet")).toBe("hurriyet");
    expect(slugOf("Hürriyet'in")).toBe("hurriyet");
    expect(slugOf("hürriyet daily news")).toBe("hurriyet-daily-news");
  });

  it("matches Sözcü with or without Turkish letters", () => {
    expect(slugOf("Sözcü")).toBe("sozcu");
    expect(slugOf("sozcu")).toBe("sozcu");
  });

  it("sends NTV to ntv, not ntv-spor", () => {
    expect(slugOf("NTV")).toBe("ntv");
    expect(slugOf("ntv")).toBe("ntv");
    expect(slugOf("NTV'ye")).toBe("ntv");
    expect(slugOf("ntv spor")).toBe("ntv-spor");
  });

  it("matches a two-word name spelled with a space, joined or hyphenated", () => {
    for (const q of ["Halk TV", "halk tv", "halktv", "HALK-TV"]) {
      expect(slugOf(q), q).toBe("halk-tv");
    }
    expect(slugOf("halk")).toBeNull();
    expect(slugOf("oda tv")).toBe("odatv");
    expect(slugOf("odatv")).toBe("odatv");
  });

  it("matches BirGün as one word and refuses the phrase 'bir gün'", () => {
    expect(slugOf("BirGün")).toBe("birgun");
    expect(slugOf("birgün")).toBe("birgun");
    expect(slugOf("bir gün")).toBeNull();
  });

  it("matches Yeniçağ as one word and refuses the phrase 'yeni çağ'", () => {
    expect(slugOf("yeniçağ")).toBe("yenicag");
    expect(slugOf("yeni çağ")).toBeNull();
  });

  it("refuses an outlet name that is an ordinary word unless the reader adds 'gazetesi'", () => {
    expect(slugOf("sabah")).toBeNull();
    expect(slugOf("Sabah")).toBeNull();
    expect(slugOf("sabah gazetesi")).toBe("sabah");
    expect(slugOf("Sabah Gazetesi")).toBe("sabah");
    expect(slugOf("daily sabah")).toBe("daily-sabah");
    expect(slugOf("karar")).toBeNull();
    expect(slugOf("karar gazetesi")).toBe("karar");
    expect(slugOf("cumhuriyet")).toBeNull();
    expect(slugOf("cumhuriyet gazetesi")).toBe("cumhuriyet");
  });

  it("matches a name that itself ends in 'gazetesi' and refuses the bare country", () => {
    expect(slugOf("türkiye gazetesi")).toBe("turkiye-gazetesi");
    expect(slugOf("türkiye")).toBeNull();
  });

  it("refuses a denied phrase even though the name is a source", () => {
    expect(slugOf("gerçek gündem")).toBeNull();
  });

  it("refuses the qualifier alone and a name that is not the whole query", () => {
    expect(OUTLET_QUALIFIER).toBe("gazetesi");
    expect(slugOf("gazetesi")).toBeNull();
    expect(slugOf("Hürriyet Erdoğan")).toBeNull();
    expect(slugOf("erdoğan hürriyet")).toBeNull();
  });

  it("gives null for no sources", () => {
    expect(slugOf("Hürriyet", null)).toBeNull();
    expect(slugOf("Hürriyet", [])).toBeNull();
  });

  it("lets the first source in input order win on one compact key", () => {
    const twins: IntentSource[] = [
      { slug: "first", name: "Halk TV" },
      { slug: "second", name: "HalkTV" },
    ];
    expect(slugOf("halk tv", twins)).toBe("first");
    expect(slugOf("halktv", twins)).toBe("first");
  });

  it("never matches a source whose slug fails SOURCE_SLUG_RE", () => {
    const bad: IntentSource[] = [
      { slug: "bad slug", name: "Hürriyet" },
      { slug: "Hurriyet", name: "Hürriyet" },
      { slug: "../x", name: "Hürriyet" },
      { slug: "", name: "Hürriyet" },
    ];
    expect(slugOf("hürriyet", bad)).toBeNull();
    // A later good source still matches: the bad one is skipped, not fatal.
    expect(slugOf("hürriyet", [...bad, { slug: "hurriyet", name: "Hürriyet" }])).toBe("hurriyet");
  });

  it("skips a source whose name cannot be folded without breaking the others", () => {
    const mixed: IntentSource[] = [
      { slug: "cafe", name: "Café Haber" },
      { slug: "hurriyet", name: "Hürriyet" },
    ];
    expect(slugOf("hürriyet", mixed)).toBe("hurriyet");
  });

  it("returns the source's own name for the link text", () => {
    expect(matchOutlet(["hurriyet"], SOURCES)).toEqual({ slug: "hurriyet", name: "Hürriyet" });
  });
});

describe("OUTLET_WORD_DENY", () => {
  it("leaves the four outlets named in the request allowed", () => {
    for (const word of ["hurriyet", "sozcu", "ntv", "halk tv"]) {
      expect(OUTLET_WORD_DENY.has(word), word).toBe(false);
    }
  });

  it("holds spaced folded forms only", () => {
    expect(OUTLET_WORD_DENY.size).toBeGreaterThan(30);
    for (const entry of OUTLET_WORD_DENY) {
      expect(/^[a-z0-9]+(?: [a-z0-9]+)*$/.test(entry), entry).toBe(true);
    }
  });

  it("records the measured collisions (Step 0, 2026-11-12): every outlet name in 10 or more clusters", () => {
    for (const word of ["cumhuriyet", "dunya", "karar"]) {
      expect(OUTLET_WORD_DENY.has(word), word).toBe(true);
    }
  });

  // h157-search-2: 196 of 68,693 article titles of the last 7 days (2026-11-12) hold the drone word İHA and
  // none of them comes from the İHA source, which has never stored an article. The cluster-title count of Q3
  // (iha 4) hid it, so the word is denied from the evidence of the article titles.
  it("denies 'iha': the drone word, not the agency", () => {
    expect(OUTLET_WORD_DENY.has("iha")).toBe(true);
  });
});

describe("the word İHA (h157-search-2)", () => {
  const withIha = SOURCES.filter((s) => s.slug === "iha");

  it("the fixture holds the İHA source, so the tests below can fail", () => {
    expect(withIha).toEqual([{ slug: "iha", name: "İHA" }]);
    expect(outletNameWords("İHA")).toEqual(["iha"]);
  });

  it.each(["İHA", "iha", "Iha", "İha", "IHA", "İHA'", "İHA'nın", "İHA’sı", "i.h.a", "İ-H-A"])(
    "matchOutlet gives null for %j (folded words, with the İHA source in the list)",
    (q) => {
      const words = outletQueryWords(q);
      expect(words, q).toEqual(["iha"]);
      expect(matchOutlet(words as string[], SOURCES), q).toBeNull();
      expect(matchOutlet(words as string[], withIha), q).toBeNull();
    },
  );

  it("the whole intent the page uses returns no outlet intent for 'İHA' (and none for a ticker either)", () => {
    for (const q of ["İHA", "iha", "Iha", "İHA'"]) {
      expect(resolveSearchIntent({ q, sources: SOURCES, tickers: ["THYAO"] }), q).toBeNull();
      expect(resolveSearchIntent({ q, sources: SOURCES, tickers: null }), q).toBeNull();
    }
  });

  it("'iha gazetesi' still resolves to the İHA source: the OUTLET_QUALIFIER path is unchanged", () => {
    expect(slugOf("iha gazetesi")).toBe("iha");
    expect(slugOf("İHA Gazetesi")).toBe("iha");
    expect(resolveSearchIntent({ q: "iha gazetesi", sources: SOURCES, tickers: null })).toEqual({
      kind: "source",
      slug: "iha",
      name: "İHA",
    });
  });

  it("a longer query that merely contains the word is no outlet either: 'iha haberleri', 'rusya iha'", () => {
    expect(slugOf("iha haberleri")).toBeNull();
    expect(slugOf("rusya iha")).toBeNull();
  });

  it("hurriyet, sozcu, ntv and halk tv stay linkable next to the new entry", () => {
    for (const [q, slug] of [
      ["hürriyet", "hurriyet"],
      ["sözcü", "sozcu"],
      ["NTV", "ntv"],
      ["Halk TV", "halk-tv"],
    ] as const) {
      expect(resolveSearchIntent({ q, sources: SOURCES, tickers: null }), q).toMatchObject({ kind: "source", slug });
    }
  });
});

describe("resolveSearchIntent", () => {
  const resolve = (
    q: string,
    tickers: readonly string[] | null,
    sources: IntentSource[] | null = SOURCES,
  ) => resolveSearchIntent({ q, sources, tickers });

  it("resolves a traded ticker", () => {
    expect(resolve("thyao", ["KCHOL", "THYAO"])).toEqual({ kind: "ticker", ticker: "THYAO" });
    expect(resolve("İSCTR", ["ISCTR"])).toEqual({ kind: "ticker", ticker: "ISCTR" });
  });

  it("gives null for a code that is not traded", () => {
    expect(resolve("garan", ["THYAO"])).toBeNull();
  });

  it("gives null when the ticker list is unknown", () => {
    expect(resolve("thyao", null)).toBeNull();
  });

  it("never links a non-equity code", () => {
    expect(resolve("ktest", ["KTEST"])).toBeNull();
  });

  it("still gives the ticker when the sources are unknown", () => {
    expect(resolve("thyao", ["THYAO"], null)).toEqual({ kind: "ticker", ticker: "THYAO" });
  });

  it("still gives the outlet when the tickers are unknown", () => {
    expect(resolve("hürriyet", null)).toEqual({ kind: "source", slug: "hurriyet", name: "Hürriyet" });
  });

  it("asks the outlets first", () => {
    expect(resolve("sözcü", ["SOZCU"])).toEqual({ kind: "source", slug: "sozcu", name: "Sözcü" });
  });

  it("falls through to the ticker when no outlet matches", () => {
    expect(resolve("kchol", ["KCHOL"])).toEqual({ kind: "ticker", ticker: "KCHOL" });
  });

  it("gives null for an ordinary search", () => {
    expect(resolve("asgari ücret", ["THYAO"])).toBeNull();
    expect(resolve("deva", ["DEVA"])).toBeNull();
    // An outlet that is an ordinary word is not linked either (the deny list is about the outlet).
    expect(resolve("sabah", ["THYAO"])).toBeNull();
  });
});

describe("searchIntentLink", () => {
  it("words the ticker link", () => {
    expect(searchIntentLink({ kind: "ticker", ticker: "THYAO" })).toEqual({
      href: "/ekonomi/THYAO",
      lead: "Borsa İstanbul kodu:",
      linkText: "THYAO hisse sayfası",
    });
  });

  it("words the outlet link", () => {
    expect(searchIntentLink({ kind: "source", slug: "hurriyet", name: "Hürriyet" })).toEqual({
      href: "/source/hurriyet",
      lead: "Haber kaynağı:",
      linkText: "Hürriyet kaynak sayfası",
    });
  });
});
