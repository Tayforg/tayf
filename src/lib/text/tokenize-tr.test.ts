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

/** The lowercase terms of a headline, as the tokenizer emits them. */
function terms(title: string): string[] {
  return tokenizeHeadline(title).map((t) => t.term);
}

describe("tokenizeHeadline: an opening quote is not a suffix apostrophe", () => {
  it("keeps a single-quoted word at the end of a headline: EŞİNDEN 'İHMAL' İDDİASI", () => {
    expect(terms("EŞİNDEN 'İHMAL' İDDİASI")).toEqual(["eşinden", "ihmal", "iddiası"]);
  });

  it("keeps the quoted word after a real suffix cut: Merkez'den 'ihtiyatlı' faiz mesajı", () => {
    expect(terms("Merkez'den 'ihtiyatlı' faiz mesajı")).toEqual([
      "merkez",
      "ihtiyatlı",
      "faiz",
      "mesajı",
    ]);
  });

  it("keeps a quoted word at the start of the headline: 'Savaş'ta yeni dönem", () => {
    // The opening quote has no letter before it (kept as punctuation); the
    // closing quote follows 'ş' and cuts the locative suffix 'ta'.
    expect(terms("'Savaş'ta yeni dönem")).toEqual(["savaş", "yeni", "dönem"]);
  });

  it("keeps the words of a ‘curly’ quoted question", () => {
    expect(terms("‘Neden evet diyoruz?’")).toEqual(["neden", "evet", "diyoruz"]);
  });

  it("cuts the suffix after a closing curly quote, but keeps the quoted words", () => {
    const out = terms("30 milyon çocuk ‘Yapay zekâlı şantaj’a maruz kaldı");
    expect(out).toContain("yapay");
    expect(out).toContain("şantaj");
    expect(out).not.toContain("a");
    expect(out).toEqual(["30", "milyon", "çocuk", "yapay", "zekâlı", "şantaj", "maruz", "kaldı"]);
  });

  it("keeps a backtick-quoted word: `darbe` iddiası", () => {
    expect(terms("`darbe` iddiası")).toEqual(["darbe", "iddiası"]);
  });

  it("keeps a word quoted after a colon: 'AKP vatandaşa yeni bir tuzak kuruyor'", () => {
    expect(terms("Tepki: 'AKP vatandaşa yeni bir tuzak kuruyor'")).toEqual([
      "tepki",
      "akp",
      "vatandaşa",
      "yeni",
      "bir",
      "tuzak",
      "kuruyor",
    ]);
  });

  it("keeps a quoted word after an opening parenthesis, dash or double quote", () => {
    expect(terms("(‘AKP’)")).toEqual(["akp"]);
    expect(terms("Gündem - 'İmamoğlu' davası")).toEqual(["gündem", "imamoğlu", "davası"]);
    expect(terms("“‘İhmal’ iddiası”")).toEqual(["ihmal", "iddiası"]);
  });

  it("keeps a word after a doubled opening quote", () => {
    expect(terms("''AKP'' kararı")).toEqual(["akp", "kararı"]);
  });

  it("keeps a word quoted with an acute accent or curly single quotes", () => {
    expect(terms("´Reform´ paketi")).toEqual(["reform", "paketi"]);
    expect(terms("Karar ‘ihtiyatlı’ oldu")).toEqual(["karar", "ihtiyatlı", "oldu"]);
  });
});

describe("tokenizeHeadline: an apostrophe after a letter or digit still starts a suffix", () => {
  it("cuts İSTANBUL'da to istanbul", () => {
    expect(terms("İSTANBUL'da")).toEqual(["istanbul"]);
  });

  it("cuts Kılıçdaroğlu’nun (U+2019) to kılıçdaroğlu", () => {
    expect(terms("Kılıçdaroğlu’nun")).toEqual(["kılıçdaroğlu"]);
  });

  it("cuts a suffix after digits: 2026'da → 2026", () => {
    expect(terms("2026'da")).toEqual(["2026"]);
  });

  it("cuts a suffix after the modifier letter apostrophe U+02BC: Erdoğanʼdan → erdoğan", () => {
    expect(terms("Erdoğanʼdan")).toEqual(["erdoğan"]);
  });

  it("cuts a suffix after a left single quote, backtick and acute accent used as apostrophes", () => {
    expect(terms("AKP‘nin")).toEqual(["akp"]);
    expect(terms("AKP`nin")).toEqual(["akp"]);
    expect(terms("AKP´nin")).toEqual(["akp"]);
  });

  it("cuts every suffix in a headline with several apostrophe words", () => {
    expect(terms("Erdoğan’ın AKP’nin İstanbul’daki kararı")).toEqual([
      "erdoğan",
      "akp",
      "istanbul",
      "kararı",
    ]);
  });

  it("cuts a chain: each apostrophe that follows a letter of the original text starts a cut", () => {
    expect(terms("AKP'li'ler")).toEqual(["akp"]);
  });

  it("keeps the words after a suffix cut that ends at a space or punctuation", () => {
    expect(terms("Erdoğan’ın, AKP’nin ve CHP’nin")).toEqual(["erdoğan", "akp", "ve", "chp"]);
  });

  it("drops a trailing apostrophe that follows a letter", () => {
    expect(terms("Erdoğan'")).toEqual(["erdoğan"]);
  });
});

describe("tokenizeHeadline: an apostrophe after an abbreviation period or a closing mark that follows a letter or digit starts a suffix", () => {
  it("cuts the suffix after an initials abbreviation: M.B.’nin → m, b", () => {
    expect(terms("M.B.’nin ifadesi")).toEqual(["m", "b", "ifadesi"]);
  });

  it("cuts the suffix after a dotted company abbreviation: A.Ş.'deki → a, ş", () => {
    expect(terms("A.Ş.'deki kirli işler")).toEqual(["a", "ş", "kirli", "işler"]);
  });

  it("cuts the suffix after a single initial and its period: Müge B.'den → müge, b", () => {
    expect(terms("Müge B.'den çocukluk")).toEqual(["müge", "b", "çocukluk"]);
  });

  it("cuts the suffix after a closing curly double quote that follows a letter", () => {
    expect(terms("“Yenidoğan Çetesi”'nin davası")).toEqual(["yenidoğan", "çetesi", "davası"]);
  });

  it("cuts the suffix after a closing parenthesis that follows a letter", () => {
    expect(terms("(AKP)'nin kararı")).toEqual(["akp", "kararı"]);
  });

  it("cuts the suffix after a closing mark that follows a digit", () => {
    expect(terms("(2026)'da seçim")).toEqual(["2026", "seçim"]);
  });

  it("keeps an opening quote after a closing mark whose own predecessor is not a letter or digit", () => {
    expect(terms("Karar ).'AKP' geldi")).toEqual(["karar", "akp", "geldi"]);
  });

  it("does not treat an apostrophe after a lone closing mark at the start as a suffix", () => {
    expect(terms(".'AKP' kararı")).toEqual(["akp", "kararı"]);
  });
});

describe("tokenizeHeadline: edge inputs", () => {
  it("returns no tokens for an empty string", () => {
    expect(tokenizeHeadline("")).toEqual([]);
  });

  it("returns no tokens for quotes and punctuation only", () => {
    expect(tokenizeHeadline("'")).toEqual([]);
    expect(tokenizeHeadline("‘’“”`´ ' ' '")).toEqual([]);
    expect(terms("... ?! 'x")).toEqual(["x"]);
  });

  it("keeps the surface form of a quoted word", () => {
    const tokens = tokenizeHeadline("'İHMAL' iddiası");
    expect(tokens.map((t) => t.surface)).toEqual(["İHMAL", "iddiası"]);
  });

  it("walks code points, not UTF-16 units: an emoji is punctuation and an astral letter counts as a letter", () => {
    expect(terms("🔥 'AKP' 🔥")).toEqual(["akp"]);
    // An emoji before the apostrophe is not a letter: the quote stays punctuation.
    expect(terms("AKP🔥'nin")).toEqual(["akp", "nin"]);
    // U+1D400 MATHEMATICAL BOLD CAPITAL A is a letter outside the BMP.
    expect(terms("\u{1D400}'nin")).toEqual(["\u{1D400}"]);
    expect(terms("AKP'\u{1D400}\u{1D401}")).toEqual(["akp"]);
  });

  it("NFC-normalizes before the suffix cut: a decomposed İstanbul'da → istanbul", () => {
    expect(terms("İstanbul'da".normalize("NFD"))).toEqual(["istanbul"]);
  });

  it("is linear on long runs of apostrophes and letters", () => {
    const quotes = "'".repeat(200_000);
    expect(tokenizeHeadline(`${quotes}x`)).toHaveLength(1);
    expect(tokenizeHeadline(`a${"'".repeat(200_000)}`)).toHaveLength(1);
    expect(tokenizeHeadline("a'".repeat(100_000))).toHaveLength(1);
    expect(tokenizeHeadline(`a'${"b".repeat(200_000)}`)).toHaveLength(1);
    expect(tokenizeHeadline(" 'a".repeat(50_000))).toHaveLength(50_000);
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

  it("forms the bigrams around a quoted word and never invents one across it", () => {
    const terms = headlineTerms("Merkez'den 'ihtiyatlı' faiz mesajı");
    expect(terms.has("merkez ihtiyatlı")).toBe(true);
    expect(terms.has("ihtiyatlı faiz")).toBe(true);
    expect(terms.has("merkez faiz")).toBe(false);
    expect(terms.has("ihtiyatlı")).toBe(true);
  });

  it("counts a quoted AKP as a term with its display surface", () => {
    const terms = headlineTerms("Tepki: 'AKP vatandaşa yeni bir tuzak kuruyor'");
    expect(terms.get("akp")).toBe("AKP");
    expect(terms.has("akp vatandaşa")).toBe(true);
  });

  it("does not leak the suffix of an abbreviation into unigrams or bigrams: M.B.’nin → no nin, no 'nin ifadesi'", () => {
    const terms = headlineTerms("M.B.’nin ifadesi ortaya çıktı");
    expect(terms.has("nin")).toBe(false);
    expect(terms.has("nin ifadesi")).toBe(false);
    expect(terms.has("ifadesi")).toBe(true);
  });

  it("keeps ‘Yapay’ from a curly-quoted phrase and drops the one-letter suffix 'a'", () => {
    const terms = headlineTerms("30 milyon çocuk ‘Yapay zekâlı şantaj’a maruz kaldı");
    expect(terms.has("yapay")).toBe(true);
    expect(terms.has("yapay zekâlı")).toBe(true);
    expect(terms.has("şantaj")).toBe(true);
    expect(terms.has("şantaj maruz")).toBe(true);
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

  it("keeps the quoted word, so two headlines differing only in it get different keys", () => {
    expect(headlineKey("'İhmal' iddiası")).toBe("ihmal iddiası");
    expect(headlineKey("'Darbe' iddiası")).toBe("darbe iddiası");
    expect(headlineKey("'İhmal' iddiası")).not.toBe(headlineKey("'Darbe' iddiası"));
  });

  it("still folds a quoted and an unquoted casing of the same headline together", () => {
    expect(headlineKey("'İHMAL' İDDİASI")).toBe(headlineKey("'ihmal' iddiası"));
  });

  it("is empty for an empty or punctuation-only title", () => {
    expect(headlineKey("")).toBe("");
    expect(headlineKey("'‘’`´ '")).toBe("");
  });
});
