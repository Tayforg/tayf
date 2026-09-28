import { describe, it, expect } from "vitest";
import {
  TR_STOPWORDS,
  tokenizeHeadline,
  isContentTerm,
  headlineTerms,
  headlineKey,
} from "./tokenize-tr";

describe("tokenizeHeadline", () => {
  it("lowercases İSTANBUL'da to istanbul (apostrophe suffix stripped)", () => {
    const tokens = tokenizeHeadline("İSTANBUL'da");
    expect(tokens.map((t) => t.term)).toEqual(["istanbul"]);
  });

  it("Turkish-lowercases IRAK to ırak, not irak", () => {
    const tokens = tokenizeHeadline("IRAK");
    expect(tokens.map((t) => t.term)).toEqual(["ırak"]);
  });

  it("strips a right single quotation mark suffix: Kılıçdaroğlu’nun → kılıçdaroğlu", () => {
    const tokens = tokenizeHeadline("Kılıçdaroğlu’nun");
    expect(tokens.map((t) => t.term)).toEqual(["kılıçdaroğlu"]);
  });

  it("NFC-normalizes a decomposed I + U+0307 + stanbul to istanbul", () => {
    const decomposed = "İstanbul";
    const tokens = tokenizeHeadline(decomposed);
    expect(tokens.map((t) => t.term)).toEqual(["istanbul"]);
  });

  it("never produces a term containing U+0307", () => {
    const tokens = tokenizeHeadline("İSTANBUL İZMİR ANKARA");
    for (const t of tokens) {
      expect(t.term).not.toContain("̇");
    }
  });

  it("splits on smart quotes and punctuation: “Kayyum” atandı!", () => {
    const tokens = tokenizeHeadline("“Kayyum” atandı!");
    expect(tokens.map((t) => t.term)).toEqual(["kayyum", "atandı"]);
  });
});

describe("isContentTerm", () => {
  it("drops stopwords, digits and 1-letter tokens", () => {
    expect(isContentTerm("ve")).toBe(false);
    expect(isContentTerm("123")).toBe(false);
    expect(isContentTerm("a")).toBe(false);
    expect(isContentTerm("gözaltı")).toBe(true);
  });

  it("TR_STOPWORDS contains the documented function words", () => {
    expect(TR_STOPWORDS.has("ve")).toBe(true);
    expect(TR_STOPWORDS.has("dakika")).toBe(true);
    expect(TR_STOPWORDS.has("ocak")).toBe(true);
  });
});

describe("headlineTerms", () => {
  it("a stopword between two content words breaks the bigram", () => {
    const terms = headlineTerms("Fidan ile Safedi görüştü");
    expect([...terms.keys()].sort()).toEqual(
      ["fidan", "safedi", "safedi görüştü", "görüştü"].sort(),
    );
    expect(terms.has("fidan safedi")).toBe(false);
    expect(terms.has("fidan ile")).toBe(false);
  });

  it("keeps the bigram surface form", () => {
    const terms = headlineTerms("Fidan ile Safedi görüştü");
    expect(terms.get("safedi görüştü")).toBe("Safedi görüştü");
  });

  it("drops stopwords/digits from the unigram set and includes the adjacent bigram", () => {
    const terms = headlineTerms("“Kayyum” atandı!");
    expect([...terms.keys()]).toEqual(["kayyum", "kayyum atandı", "atandı"]);
  });
});

describe("headlineKey", () => {
  it("is equal for two casings of the same headline", () => {
    const a = headlineKey("İstanbul'da Kayyum Atandı");
    const b = headlineKey("istanbul'DA kayyum ATANDI");
    expect(a).toBe(b);
  });

  it("includes stopwords (unlike headlineTerms)", () => {
    const key = headlineKey("Fidan ile Safedi görüştü");
    expect(key).toBe("fidan ile safedi görüştü");
  });
});
