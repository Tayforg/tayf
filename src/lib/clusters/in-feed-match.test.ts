import { describe, it, expect } from "vitest";

import {
  archiveHeading,
  searchTokens,
  titleMatchesTokens,
} from "./in-feed-match";

// In-feed filter for the home search: every query token must occur at a word
// start in the cluster title. The matching is order-free, ignores quotes and
// websearch operators, and is insensitive to Turkish casing, dotted/dotless i
// and diacritics: keys are folded like the archive RPC's tayf_search_fold
// (migration 129), so ASCII "erdogan" finds "Erdoğan" in the feed too and the
// in-feed and archive sections agree on what a query means.

const matches = (q: string, title: string) =>
  titleMatchesTokens(title, searchTokens(q));

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
