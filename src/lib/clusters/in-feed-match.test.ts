import { describe, it, expect } from "vitest";

import {
  archiveHeading,
  searchTokens,
  titleMatchesTokens,
} from "./in-feed-match";

// In-feed filter for the home search: every query token must occur at a word
// start in the cluster title. The matching is order-free, ignores quotes and
// websearch operators, and is insensitive to Turkish casing and dotted/dotless
// i. Diacritic folding (ASCII "erdogan" for "Erdoğan") is NOT done here; the
// archive RPC covers ASCII input meanwhile.

const matches = (q: string, title: string) =>
  titleMatchesTokens(title, searchTokens(q));

describe("searchTokens", () => {
  it("splits on whitespace and lowercases the Turkish way", () => {
    expect(searchTokens("Seçim ISTANBUL")).toEqual(["seçim", "istanbul"]);
    expect(searchTokens("  seçim \t erdoğan\n")).toEqual(["seçim", "erdoğan"]);
  });

  it("folds dotted and dotless i to the same key", () => {
    expect(searchTokens("İstanbul")).toEqual(["istanbul"]);
    expect(searchTokens("ISTANBUL")).toEqual(["istanbul"]);
    expect(searchTokens("ıstanbul")).toEqual(["istanbul"]);
  });

  it("strips double quotes", () => {
    // Keys are fold-normalised: dotless ı becomes i.
    expect(searchTokens('"Cumhurbaşkanı Erdoğan"')).toEqual([
      "cumhurbaşkani",
      "erdoğan",
    ]);
    expect(searchTokens('"seçim"')).toEqual(["seçim"]);
  });

  it("drops a standalone or / OR operator", () => {
    expect(searchTokens("seçim or erdoğan")).toEqual(["seçim", "erdoğan"]);
    expect(searchTokens("seçim OR erdoğan")).toEqual(["seçim", "erdoğan"]);
  });

  it("keeps words that merely contain or", () => {
    expect(searchTokens("orhan ordu")).toEqual(["orhan", "ordu"]);
  });

  it("drops -negated tokens", () => {
    expect(searchTokens("erdoğan -bahçeli")).toEqual(["erdoğan"]);
    expect(searchTokens("-bahçeli -özel")).toEqual([]);
    expect(searchTokens('seçim -"bahçeli"')).toEqual(["seçim"]);
  });

  it("strips an apostrophe suffix of any apostrophe variant", () => {
    expect(searchTokens("Erdoğan'ın")).toEqual(["erdoğan"]);
    expect(searchTokens("Erdoğan’ın")).toEqual(["erdoğan"]);
    expect(searchTokens("Erdoğanʼın")).toEqual(["erdoğan"]);
    expect(searchTokens("Erdoğan‘ın")).toEqual(["erdoğan"]);
    expect(searchTokens("İstanbul'da")).toEqual(["istanbul"]);
    expect(searchTokens("Erdoğan'")).toEqual(["erdoğan"]);
  });

  it("trims leading and trailing non-letter/digit characters", () => {
    expect(searchTokens("(seçim), erdoğan!")).toEqual(["seçim", "erdoğan"]);
    expect(searchTokens("...seçim...")).toEqual(["seçim"]);
    expect(searchTokens("2024!")).toEqual(["2024"]);
  });

  it("drops keys shorter than 2 characters and dedupes", () => {
    expect(searchTokens("a")).toEqual([]);
    expect(searchTokens("a b ak")).toEqual(["ak"]);
    expect(searchTokens("seçim Seçim SEÇİM seçim")).toEqual(["seçim"]);
    expect(searchTokens("ISTANBUL İstanbul ıstanbul")).toEqual(["istanbul"]);
  });

  it("returns [] for empty, whitespace, and punctuation-only input", () => {
    expect(searchTokens("")).toEqual([]);
    expect(searchTokens("   ")).toEqual([]);
    expect(searchTokens('"" - \' ?!')).toEqual([]);
    expect(searchTokens("or OR")).toEqual([]);
  });

  it("keeps emoji and other non-letter symbols out of the keys", () => {
    expect(searchTokens("seçim 🗳️ erdoğan")).toEqual(["seçim", "erdoğan"]);
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
