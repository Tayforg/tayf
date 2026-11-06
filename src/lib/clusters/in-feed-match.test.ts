import { describe, it, expect } from "vitest";

import {
  archiveHeading,
  searchTokenAlternatives,
  searchTokens,
  titleMatchesTokens,
} from "./in-feed-match";
import { canonicalSearchQuery } from "./turkish-query";

// In-feed filter for the home search: every query token must occur at a word
// start in the cluster title. The matching is order-free, ignores quotes and
// websearch operators, and is insensitive to Turkish casing, dotted/dotless i
// and diacritics: keys are folded like the archive RPC's tayf_search_fold
// (migration 129), so ASCII "erdogan" finds "Erdoğan" in the feed too and the
// in-feed and archive sections agree on what a query means.

const matches = (q: string, title: string) =>
  titleMatchesTokens(title, searchTokens(q));

// A card matches when ANY alternative token list matches (page.tsx does the same).
const matchesAlt = (q: string, title: string) =>
  searchTokenAlternatives(q).some((alt) => titleMatchesTokens(title, alt));

describe("searchTokens", () => {
  it("splits on whitespace and lowercases the Turkish way", () => {
    expect(searchTokens("Seçim ISTANBUL")).toEqual(["secim", "istanbul"]);
    expect(searchTokens("  seçim \t erdoğan\n")).toEqual(["secim", "erdogan"]);
  });

  it("folds dotted and dotless i to the same key", () => {
    expect(searchTokens("İstanbul")).toEqual(["istanbul"]);
    expect(searchTokens("ISTANBUL")).toEqual(["istanbul"]);
    expect(searchTokens("ıstanbul")).toEqual(["istanbul"]);
  });

  it("folds Turkish diacritics to ASCII (ğ ş ç ö ü ı İ -> g s c o u i i)", () => {
    expect(searchTokens("Erdoğan")).toEqual(["erdogan"]);
    expect(searchTokens("ÇİĞDEM ŞÖYLE ÜZÜM")).toEqual(["cigdem", "soyle", "uzum"]);
    expect(searchTokens("cumhurbaşkanı")).toEqual(["cumhurbaskani"]);
  });

  it("folds the circumflex vowels like the archive fold (imkân -> imkan)", () => {
    expect(searchTokens("imkânı")).toEqual(["imkani"]);
    expect(searchTokens("hükûmet")).toEqual(["hukumet"]);
  });

  it("dedupes after folding (diacritic and ASCII spellings are one key)", () => {
    expect(searchTokens("Erdoğan erdogan")).toEqual(["erdogan"]);
    expect(searchTokens("ERDOĞAN Erdogan ERDOGAN")).toEqual(["erdogan"]);
    expect(searchTokens("seçim secim SEÇİM")).toEqual(["secim"]);
  });

  it("strips double quotes", () => {
    // Keys are fold-normalised: dotless ı becomes i, diacritics go ASCII.
    expect(searchTokens('"Cumhurbaşkanı Erdoğan"')).toEqual([
      "cumhurbaskani",
      "erdogan",
    ]);
    expect(searchTokens('"seçim"')).toEqual(["secim"]);
  });

  it("drops a standalone or / OR operator", () => {
    expect(searchTokens("seçim or erdoğan")).toEqual(["secim", "erdogan"]);
    expect(searchTokens("seçim OR erdoğan")).toEqual(["secim", "erdogan"]);
  });

  it("keeps words that merely contain or", () => {
    expect(searchTokens("orhan ordu")).toEqual(["orhan", "ordu"]);
  });

  it("drops -negated tokens", () => {
    expect(searchTokens("erdoğan -bahçeli")).toEqual(["erdogan"]);
    expect(searchTokens("-bahçeli -özel")).toEqual([]);
    expect(searchTokens('seçim -"bahçeli"')).toEqual(["secim"]);
  });

  it("strips an apostrophe suffix of any apostrophe variant", () => {
    expect(searchTokens("Erdoğan'ın")).toEqual(["erdogan"]);
    expect(searchTokens("Erdoğan’ın")).toEqual(["erdogan"]);
    expect(searchTokens("Erdoğanʼın")).toEqual(["erdogan"]);
    expect(searchTokens("Erdoğan‘ın")).toEqual(["erdogan"]);
    expect(searchTokens("İstanbul'da")).toEqual(["istanbul"]);
    expect(searchTokens("Erdoğan'")).toEqual(["erdogan"]);
  });

  it("trims leading and trailing non-letter/digit characters", () => {
    expect(searchTokens("(seçim), erdoğan!")).toEqual(["secim", "erdogan"]);
    expect(searchTokens("...seçim...")).toEqual(["secim"]);
    expect(searchTokens("2024!")).toEqual(["2024"]);
  });

  it("drops keys shorter than 2 characters and dedupes", () => {
    expect(searchTokens("a")).toEqual([]);
    expect(searchTokens("a b ak")).toEqual(["ak"]);
    expect(searchTokens("seçim Seçim SEÇİM seçim")).toEqual(["secim"]);
    expect(searchTokens("ISTANBUL İstanbul ıstanbul")).toEqual(["istanbul"]);
  });

  it("returns [] for empty, whitespace, and punctuation-only input", () => {
    expect(searchTokens("")).toEqual([]);
    expect(searchTokens("   ")).toEqual([]);
    expect(searchTokens('"" - \' ?!')).toEqual([]);
    expect(searchTokens("or OR")).toEqual([]);
  });

  it("keeps emoji and other non-letter symbols out of the keys", () => {
    expect(searchTokens("seçim 🗳️ erdoğan")).toEqual(["secim", "erdogan"]);
  });
});

describe("titleMatchesTokens", () => {
  it("matches a prefix at a word start", () => {
    expect(matches("ak", "AK Parti açıklama yaptı")).toBe(true);
    expect(matches("ak", "Akşener açıklama yaptı")).toBe(true);
  });

  it("does not match in the middle of a word", () => {
    expect(matches("ak", "Başbakan dakikaya kadar bekledi")).toBe(false);
    expect(matches("ak", "Başbakan açıklama yaptı")).toBe(false);
    expect(matches("kan", "Başbakan açıkladı")).toBe(false);
  });

  it("matches after punctuation, but not after a digit or letter", () => {
    expect(matches("ak", "Gündem: AK Parti")).toBe(true);
    expect(matches("ak", '"AK Parti" açıkladı')).toBe(true);
    expect(matches("ak", "(AK) Parti")).toBe(true);
    expect(matches("ak", "3ak parti")).toBe(false);
  });

  it("finds a later word-start occurrence after an earlier mid-word one", () => {
    expect(matches("ak", "dakika ak parti")).toBe(true);
    expect(matches("ak", "dakika bakan")).toBe(false);
  });

  it("is insensitive to Turkish casing and dotted/dotless i", () => {
    expect(matches("ISTANBUL", "İstanbul'da yağış bekleniyor")).toBe(true);
    expect(matches("istanbul", "İSTANBUL'DA yağış")).toBe(true);
    expect(matches("İstanbul", "ISTANBUL'da yağış")).toBe(true);
    expect(matches("ıspanak", "İspanak fiyatları")).toBe(true);
  });

  it("finds diacritic titles from ASCII queries (and the reverse)", () => {
    expect(matches("erdogan", "Cumhurbaşkanı Erdoğan Güney Kore'ye gitti")).toBe(
      true,
    );
    expect(
      matches("cumhurbaskani ozel", "Özel ile Cumhurbaşkanı Erdoğan görüştü"),
    ).toBe(true);
    expect(matches("Erdoğan", "ERDOGAN SEUL YOLUNDA")).toBe(true);
    expect(matches("ERDOĞAN", "erdogan seul yolunda")).toBe(true);
    expect(matches("guney kore", "Güney Kore'ye gitti")).toBe(true);
    expect(matches("sampiyon", "Şampiyon Galatasaray")).toBe(true);
  });

  it("returns the same in-feed cards for 'erdogan' as for 'Erdoğan'", () => {
    const titles = [
      "Cumhurbaşkanı Erdoğan Güney Kore'ye gitti",
      "ERDOGAN SEUL YOLUNDA",
      "Erdoğan'ın açıklaması sonrası borsa yükseldi",
      "Bahçeli: seçim tarihi belli oldu",
      "Başbakan açıklama yaptı",
    ];
    const ascii = titles.filter((t) => matches("erdogan", t));
    const diacritic = titles.filter((t) => matches("Erdoğan", t));
    expect(ascii).toEqual(diacritic);
    expect(ascii).toHaveLength(3);
  });

  it("keeps ISTANBUL and istanbul matching 'İstanbul'", () => {
    expect(matches("ISTANBUL", "İstanbul'da deprem")).toBe(true);
    expect(matches("istanbul", "İstanbul'da deprem")).toBe(true);
  });

  it("folds circumflex vowels in the title (imkan finds imkânı)", () => {
    expect(matches("imkan", "BES birikimlerinden kısmi ödeme imkânı geliyor")).toBe(
      true,
    );
  });

  it("keeps the word-start rule after folding", () => {
    expect(matches("ak", "Akşener açıklama yaptı")).toBe(true);
    expect(matches("ak", "Başbakan açıklama yaptı")).toBe(false);
    // Folding must not create a mid-word hit: 'gan' sits inside Erdoğan.
    expect(matches("gan", "Erdoğan konuştu")).toBe(false);
    expect(matches("dogan", "Erdoğan konuştu")).toBe(false);
  });

  it("treats decomposed (NFD) text the same as precomposed text", () => {
    const nfd = "Şeker fiyatları".normalize("NFD");
    expect(nfd).not.toBe("Şeker fiyatları");
    expect(matches("şeker", nfd)).toBe(true);
    expect(matches(nfd, "Şeker fiyatları")).toBe(true);
  });

  it("is order-free", () => {
    expect(
      matches("Erdoğan Cumhurbaşkanı", "Cumhurbaşkanı Erdoğan açıkladı"),
    ).toBe(true);
    expect(
      matches("Cumhurbaşkanı Erdoğan", "Erdoğan: Cumhurbaşkanı olarak"),
    ).toBe(true);
  });

  it("requires every token to match", () => {
    expect(matches("erdoğan bahçeli", "Erdoğan konuştu")).toBe(false);
    expect(matches("erdoğan bahçeli", "Bahçeli ve Erdoğan görüştü")).toBe(true);
  });

  it("ignores quotes", () => {
    expect(
      matches('"Cumhurbaşkanı Erdoğan"', "Cumhurbaşkanı Erdoğan açıkladı"),
    ).toBe(true);
    expect(
      matches('"Cumhurbaşkanı Erdoğan"', "Erdoğan Cumhurbaşkanı olarak"),
    ).toBe(true);
  });

  it("ignores negated tokens and the or operator", () => {
    expect(matches("erdoğan -bahçeli", "Erdoğan konuştu")).toBe(true);
    expect(matches("erdoğan or bahçeli", "Erdoğan konuştu")).toBe(false);
  });

  it("matches through an apostrophe suffix typed by the reader", () => {
    expect(matches("Erdoğan'ın", "Erdoğan açıkladı")).toBe(true);
    expect(matches("Erdoğan’ın", "Erdoğan açıkladı")).toBe(true);
  });

  it("matches a stem against an inflected title word", () => {
    expect(matches("seçim", "Seçimler yaklaşıyor")).toBe(true);
  });

  it("returns false for an empty token list", () => {
    expect(titleMatchesTokens("Erdoğan konuştu", [])).toBe(false);
    expect(matches("a", "Erdoğan konuştu")).toBe(false);
    expect(matches("", "Erdoğan konuştu")).toBe(false);
  });

  it("returns false for an empty title", () => {
    expect(titleMatchesTokens("", ["ak"])).toBe(false);
  });

  it("treats regex metacharacters in a query as plain text", () => {
    expect(matches("(.*)", "Erdoğan konuştu")).toBe(false);
    expect(matches("a+b", "A+B planı açıklandı")).toBe(true);
    expect(matches("[ak", "AK Parti")).toBe(true);
    expect(matches("ak|bi", "AK Parti")).toBe(false);
  });

  it("is not tripped by astral characters before a match", () => {
    expect(matches("ak", "🗳️AK Parti")).toBe(true);
    expect(matches("ak", "𝒜ak Parti")).toBe(false);
  });

  it("copes with a very long query without hanging", () => {
    const q = Array.from({ length: 2000 }, (_, i) => `kelime${i}`).join(" ");
    expect(matches(q, "Erdoğan konuştu")).toBe(false);
  });
});

describe("archiveHeading", () => {
  it("reads 'Arşivden: N sonuç' when the RPC did not hit its cap", () => {
    expect(archiveHeading(5, false)).toBe("Arşivden: 5 sonuç");
    expect(archiveHeading(1, false)).toBe("Arşivden: 1 sonuç");
  });

  it("reads 'Arşivden: en ilgili N sonuç' when the RPC hit its cap", () => {
    expect(archiveHeading(22, true)).toBe("Arşivden: en ilgili 22 sonuç");
  });
});

// h42-search-1: the archive treats AKP and AK Parti as one party (search-aliases.ts),
// so the in-feed filter has to as well, or the cards above the archive section
// would disagree with the archive about what the query means.
describe("searchTokenAlternatives", () => {
  it("is just searchTokens(q) when the query holds no alias", () => {
    expect(searchTokenAlternatives("Erdoğan")).toEqual([["erdogan"]]);
    expect(searchTokenAlternatives("ak")).toEqual([["ak"]]);
    expect(searchTokenAlternatives("akşener")).toEqual([["aksener"]]);
    expect(searchTokenAlternatives("")).toEqual([[]]);
  });

  it("adds the 'ak parti' tokens for 'AKP', own tokens first", () => {
    expect(searchTokenAlternatives("AKP")).toEqual([["akp"], ["ak", "parti"]]);
  });

  it("adds the 'akp' token for 'AK Parti'", () => {
    expect(searchTokenAlternatives("AK Parti")).toEqual([
      ["ak", "parti"],
      ["akp"],
    ]);
  });

  it("keeps the other tokens in the substituted list", () => {
    expect(searchTokenAlternatives("AKP İstanbul")).toEqual([
      ["akp", "istanbul"],
      ["ak", "parti", "istanbul"],
    ]);
  });

  it("agrees with the archive: no alternative once the query uses quotes, a negation or 'or'", () => {
    expect(searchTokenAlternatives('"ak parti"')).toEqual([["ak", "parti"]]);
    expect(searchTokenAlternatives("akp -chp")).toEqual([["akp"]]);
    expect(searchTokenAlternatives("akp or chp")).toEqual([["akp", "chp"]]);
  });

  it("is consistent with the archive's input: the canonical query gives the same lists", () => {
    expect(searchTokenAlternatives("akp'nin")).toEqual(searchTokenAlternatives("akp"));
    expect(searchTokenAlternatives("AK PARTİ")).toEqual(
      searchTokenAlternatives("ak parti"),
    );
  });
});

describe("alias matching in the feed (AKP <-> AK Parti)", () => {
  it("'AKP' matches 'AK Parti Grup Başkanı ...'", () => {
    expect(matchesAlt("AKP", "AK Parti Grup Başkanı Abdullah Güler açıkladı")).toBe(true);
  });

  it("'AK Parti' matches \"AKP'den açıklama\"", () => {
    expect(matchesAlt("AK Parti", "AKP'den açıklama")).toBe(true);
  });

  it("keeps matching its own spelling", () => {
    expect(matchesAlt("AKP", "AKP'den açıklama")).toBe(true);
    expect(matchesAlt("AK Parti", "AK Parti Grup Başkanı açıkladı")).toBe(true);
  });

  it("carries the rest of the query across the alias", () => {
    expect(matchesAlt("akp istanbul", "AK Parti İstanbul İl Başkanı konuştu")).toBe(true);
    expect(matchesAlt("akp istanbul", "AK Parti Ankara İl Başkanı konuştu")).toBe(false);
  });

  it("does not match an unrelated title", () => {
    expect(matchesAlt("AKP", "CHP Genel Başkanı Özel konuştu")).toBe(false);
    expect(matchesAlt("AK Parti", "Başbakan dakikaya kadar bekledi")).toBe(false);
  });

  it("leaves the 'ak' prefix behaviour unchanged", () => {
    expect(matchesAlt("ak", "AK Parti açıklama yaptı")).toBe(true);
    expect(matchesAlt("ak", "Akşener açıklama yaptı")).toBe(true);
    expect(matchesAlt("ak", "AKP'den açıklama")).toBe(true);
    expect(matchesAlt("ak", "Başbakan dakikaya kadar bekledi")).toBe(false);
    expect(matchesAlt("ak", "dakika bakan")).toBe(false);
  });

  it("matches nothing for an empty or operator-only query (as before)", () => {
    expect(matchesAlt("", "AK Parti")).toBe(false);
    expect(matchesAlt("-akp", "AKP'den açıklama")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// h50-search-2: the in-feed filter reads the same inputs the archive does.
// An apostrophe is cut only before a Turkish suffix, a dash between words is a
// separator, and NFD, zero-width and full-width input gets the NFC fold.
// ---------------------------------------------------------------------------

describe("searchTokens: apostrophes (h50-search-2)", () => {
  it("keeps a name that carries an apostrophe whole", () => {
    expect(searchTokens("Kur'an")).toEqual(["kur'an"]);
    expect(searchTokens("O'Brien")).toEqual(["o'brien"]);
    // foldTr mirrors the SQL fold: Turkish letters only, so é stays é.
    expect(searchTokens("L'Oréal")).toEqual(["l'oréal"]);
  });

  it("maps the typographic apostrophes to one key, so Kur’an and Kur'an agree", () => {
    expect(searchTokens("Kur\u2019an")).toEqual(["kur'an"]);
    expect(searchTokens("Kur\u02bcan")).toEqual(["kur'an"]);
    expect(searchTokens("Kur\u2018an")).toEqual(["kur'an"]);
  });

  it.each([
    ["Erdoğan'ın", "erdogan"],
    ["Erdoğan\u2019dan", "erdogan"],
    ["Özel'den", "ozel"],
    ["Bahçeli'nin", "bahceli"],
    ["İmamoğlu'na", "imamoglu"],
    ["Türkiye'deki", "turkiye"],
    ["AKP'nin", "akp"],
    ["CHP'liler", "chp"],
    ["Putin'le", "putin"],
    ["Sezai'yi", "sezai"],
    ["İstanbul'u", "istanbul"],
    ["Kılıçdaroğlu'ndan", "kilicdaroglu"],
    ["Gazze'ye", "gazze"],
    ["İsrail'in", "israil"],
    ["ERDOĞAN'IN", "erdogan"],
  ])("cuts the Turkish suffix of %j", (q, key) => {
    expect(searchTokens(q)).toEqual([key]);
  });

  it("cuts only the last suffix of a name with an apostrophe", () => {
    expect(searchTokens("Kur'an'ın")).toEqual(["kur'an"]);
  });

  it("cuts the -ci / -cü and the relative -dekiler tails the archive cuts (the card and the archive narrow the same way)", () => {
    expect(searchTokens("FETÖ'cüler")).toEqual(searchTokens("FETÖ"));
    expect(searchTokens("Türkiye'dekiler")).toEqual(searchTokens("Türkiye"));
    expect(searchTokens("FETÖ'cüler")).toEqual(["feto"]);
    expect(searchTokens("Türkiye'dekiler")).toEqual(["turkiye"]);
    expect(searchTokens("ABD'DEKI")).toEqual(["abd"]);
  });

  it("still drops a dangling apostrophe", () => {
    expect(searchTokens("Erdoğan'")).toEqual(["erdogan"]);
    expect(searchTokens("Erdoğan''")).toEqual(["erdogan"]);
  });

  it("keeps a leading apostrophe word (it is edge-trimmed, not cut to nothing)", () => {
    expect(searchTokens("'seçim")).toEqual(["secim"]);
  });

  it("is linear on a long apostrophe run, a long tail and a long punctuation run inside a word", () => {
    const started = performance.now();
    searchTokens(`a${"'".repeat(100_000)}!`);
    searchTokens(`a'${"b".repeat(100_000)}`);
    searchTokens("a'ın ".repeat(30_000));
    // A trailing-run regex retries from every position of the run (quadratic).
    searchTokens(`a${"!".repeat(100_000)}b`);
    searchTokens(`${"!".repeat(100_000)}a${"?".repeat(100_000)}`);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("trims punctuation from both edges of a word and keeps what is inside", () => {
    expect(searchTokens("!!(ak-parti)??")).toEqual(["ak-parti"]);
    expect(searchTokens("\u201cseçim\u201d")).toEqual(["secim"]);
    expect(searchTokens("1.5")).toEqual(["1.5"]);
    expect(searchTokens("\u{1F525}deprem\u{1F525}")).toEqual(["deprem"]);
  });
});

describe("titleMatchesTokens: Kur'an, O'Brien and friends (h50-search-2)", () => {
  it("finds the Kur’an-ı Kerim story (typographic apostrophe in the title)", () => {
    expect(
      titleMatchesTokens(
        "Cumhurbaşkanı Erdoğan, Kur’an-ı Kerim hocası...",
        searchTokens("Kur'an"),
      ),
    ).toBe(true);
  });

  it("finds it with an ASCII apostrophe in the title and a typographic one typed", () => {
    expect(
      titleMatchesTokens("Erdoğan Kur'an kursunu açtı", searchTokens("Kur\u2019an")),
    ).toBe(true);
  });

  it("does not match Kurum, Kurtulmuş or Kürdistan any more (it used to search 'kur')", () => {
    const tokens = searchTokens("Kur'an");
    expect(titleMatchesTokens("Bakan Kurum konuştu", tokens)).toBe(false);
    expect(titleMatchesTokens("Kurtulmuş açıklama yaptı", tokens)).toBe(false);
    expect(titleMatchesTokens("Kürdistan referandumu", tokens)).toBe(false);
    expect(titleMatchesTokens("bağ kurdum dedi", tokens)).toBe(false);
  });

  it("finds O'Brien and L'Oréal", () => {
    expect(titleMatchesTokens("Conan O’Brien Türkiye’ye geliyor", searchTokens("O'Brien"))).toBe(true);
    expect(titleMatchesTokens("L'Oréal hisseleri yükseldi", searchTokens("L'Oréal"))).toBe(true);
    expect(titleMatchesTokens("L’Oréal hisseleri yükseldi", searchTokens("L'Oréal"))).toBe(true);
  });

  it("still finds a name in a suffixed headline: Erdoğan'ın matches 'Erdoğan konuştu' and 'Erdoğan’dan'", () => {
    expect(titleMatchesTokens("Erdoğan konuştu", searchTokens("Erdoğan'ın"))).toBe(true);
    expect(titleMatchesTokens("Özel, Erdoğan’dan yanıt istedi", searchTokens("Erdoğan'ın"))).toBe(true);
  });

  it("the same word with and without the apostrophe typed finds the same title", () => {
    expect(matches("Kur'an", "Kur’an-ı Kerim hocası")).toBe(true);
    expect(matches("Kur’an", "Kur'an-ı Kerim hocası")).toBe(true);
  });
});

describe("searchTokens: dashes (h50-search-2)", () => {
  it("reads 'erdoğan - bahçeli' as two words", () => {
    expect(searchTokens("erdoğan - bahçeli")).toEqual(["erdogan", "bahceli"]);
  });

  it.each(["trump <-> iran", "trump — iran", "trump – iran", "trump -- iran", "trump \u2212 iran"])(
    "reads %j as two words",
    (q) => {
      expect(searchTokens(q)).toEqual(["trump", "iran"]);
    },
  );

  it("an attached -word is still a negation", () => {
    expect(searchTokens("erdoğan -bahçeli")).toEqual(["erdogan"]);
  });

  it("agrees with the canonical query: the page hands searchTokens the canonical form", () => {
    for (const q of ["Erdoğan - Bahçeli", "trump <-> iran", "a — b", "erdoğan -bahçeli", "Kur'an'ın"]) {
      expect(searchTokens(canonicalSearchQuery(q)), q).toEqual(searchTokens(q));
    }
  });
});

describe("Unicode: NFD, zero-width and full-width input (h50-search-2)", () => {
  it("an NFD token matches an NFC title and the other way round", () => {
    expect(titleMatchesTokens("Şişli Belediyesi açıklama yaptı", searchTokens("s\u0327is\u0327li"))).toBe(true);
    expect(titleMatchesTokens("S\u0327is\u0327li Belediyesi", searchTokens("şişli"))).toBe(true);
    expect(searchTokens("s\u0327is\u0327li")).toEqual(["sisli"]);
  });

  it("zero-width characters inside a word are ignored", () => {
    expect(searchTokens("tr\u200bump")).toEqual(["trump"]);
    expect(searchTokens("trump\u200b")).toEqual(["trump"]);
    expect(searchTokens("\ufefftrump")).toEqual(["trump"]);
    expect(searchTokens("tr\u00adump")).toEqual(["trump"]);
    expect(titleMatchesTokens("Trump açıklama yaptı", searchTokens("trump\u200b"))).toBe(true);
  });

  it("a zero-width character in the TITLE does not hide a word", () => {
    expect(titleMatchesTokens("Tr\u200bump açıklama yaptı", searchTokens("trump"))).toBe(true);
  });

  it("full-width letters fold to ASCII", () => {
    expect(searchTokens("ＴＲＵＭＰ")).toEqual(["trump"]);
    expect(titleMatchesTokens("Trump açıklama yaptı", searchTokens("ＴＲＵＭＰ"))).toBe(true);
  });

  it("a zero-width or full-width mark cannot hide a negation", () => {
    expect(searchTokens("\u200b-bahçeli")).toEqual([]);
    expect(searchTokens("erdoğan \uff0dbahçeli")).toEqual(["erdogan"]);
  });

  it("a query of zero-width characters only has no token", () => {
    expect(searchTokens("\u200b\u200c\ufeff")).toEqual([]);
  });
});
