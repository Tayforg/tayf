import { describe, it, expect } from "vitest";

import { RISING_FOLD_FROM, RISING_FOLD_TO } from "@/lib/trends/rising-entities";
import {
  MAX_QUERY_VARIANTS,
  SEARCH_FOLD_FROM,
  SEARCH_FOLD_TO,
  foldTr,
  normaliseSearchQuery,
  pgLower,
  titleCaseTr,
  turkishQueryVariants,
} from "./turkish-query";

describe("turkishQueryVariants", () => {
  it("'IŞIK' gives ['ışık','işik','işık']", () => {
    expect(turkishQueryVariants("IŞIK")).toEqual(["ışık", "işik", "işık"]);
  });

  it("'ışık' gives the same set", () => {
    expect(turkishQueryVariants("ışık")).toEqual(["ışık", "işik", "işık"]);
  });

  it("'İstanbul' gives ['istanbul']", () => {
    expect(turkishQueryVariants("İstanbul")).toEqual(["istanbul"]);
  });

  it("'seçim' gives ['seçim']", () => {
    expect(turkishQueryVariants("seçim")).toEqual(["seçim"]);
  });

  it("'Kılıçdaroğlu' gives ['kılıçdaroğlu','kiliçdaroğlu']", () => {
    expect(turkishQueryVariants("Kılıçdaroğlu")).toEqual([
      "kılıçdaroğlu",
      "kiliçdaroğlu",
    ]);
  });

  it("whitespace-only input gives []", () => {
    expect(turkishQueryVariants("   ")).toEqual([]);
    expect(turkishQueryVariants("")).toEqual([]);
  });

  it("a quoted phrase keeps its quotes", () => {
    const variants = turkishQueryVariants('"seçim sonuçları"');
    expect(variants.length).toBeGreaterThan(0);
    for (const v of variants) {
      expect(v.startsWith('"')).toBe(true);
      expect(v.endsWith('"')).toBe(true);
    }
  });

  it("'ekonomi or enflasyon' gives one variant, with 'or' lower-case", () => {
    const variants = turkishQueryVariants("ekonomi or enflasyon");
    expect(variants).toEqual(["ekonomi or enflasyon"]);
    expect(variants[0]).toContain(" or ");
  });

  it("no input ever yields more than MAX_QUERY_VARIANTS variants", () => {
    const inputs = [
      "IŞIK",
      "ışık",
      "İstanbul",
      "seçim",
      "Kılıçdaroğlu",
      "ekonomi or enflasyon",
      "İZMİR DEPREMİ",
      "Cumhurbaşkanlığı",
    ];
    for (const input of inputs) {
      expect(turkishQueryVariants(input).length).toBeLessThanOrEqual(
        MAX_QUERY_VARIANTS,
      );
    }
  });
});

describe("pgLower", () => {
  it("folds both ASCII I and dotted İ to dotted lowercase i", () => {
    expect(pgLower("IİOÖ")).toBe(pgLower("IİOÖ").toLocaleLowerCase("tr"));
    expect(pgLower("I")).toBe("i");
    expect(pgLower("İ")).toBe("i");
  });

  it("leaves Turkish dotless ı untouched (it is not I/İ)", () => {
    expect(pgLower("Şİşli")).not.toContain("I");
  });
});

describe("titleCaseTr", () => {
  it("keeps a leading '-' before the capitalised letter", () => {
    expect(titleCaseTr("-istanbul")).toBe("-İstanbul");
  });

  it("keeps a leading quote before the capitalised letter", () => {
    expect(titleCaseTr('"istanbul"')).toBe('"İstanbul"');
  });

  it("title-cases every whitespace-separated token", () => {
    expect(titleCaseTr("ekonomi enflasyon")).toBe("Ekonomi Enflasyon");
  });
});

describe("normaliseSearchQuery", () => {
  it("turns every C0 control (U+0000-U+001F) into a space", () => {
    for (let cp = 0x00; cp <= 0x1f; cp++) {
      const ch = String.fromCharCode(cp);
      // Whitespace controls (tab, LF, CR...) collapse like any other space.
      expect(normaliseSearchQuery(`a${ch}b`), `U+${cp.toString(16)}`).toBe("a b");
    }
  });

  it("turns DEL and every C1 control (U+007F-U+009F) into a space", () => {
    for (let cp = 0x7f; cp <= 0x9f; cp++) {
      const ch = String.fromCharCode(cp);
      expect(normaliseSearchQuery(`a${ch}b`), `U+${cp.toString(16)}`).toBe("a b");
    }
  });

  it("'a\u0000b' becomes 'a b'", () => {
    expect(normaliseSearchQuery("a\u0000b")).toBe("a b");
  });

  it("a query of control characters only becomes ''", () => {
    expect(normaliseSearchQuery("\u0000\u0001")).toBe("");
    expect(normaliseSearchQuery("\u0000")).toBe("");
    expect(normaliseSearchQuery("\u007f\u0085\u009f")).toBe("");
  });

  it("collapses whitespace runs and trims", () => {
    expect(normaliseSearchQuery("  seçim   sonuçları \t ")).toBe("seçim sonuçları");
    expect(normaliseSearchQuery("")).toBe("");
    expect(normaliseSearchQuery("   ")).toBe("");
  });

  it("drops an apostrophe suffix: ASCII apostrophe", () => {
    expect(normaliseSearchQuery("Erdoğan'ın")).toBe("Erdoğan");
    expect(normaliseSearchQuery("Özel'den")).toBe("Özel");
    expect(normaliseSearchQuery("Bahçeli'nin")).toBe("Bahçeli");
  });

  it("drops an apostrophe suffix: typographic apostrophes (U+2019, U+02BC, U+2018)", () => {
    expect(normaliseSearchQuery("Erdoğan’ın")).toBe("Erdoğan");
    expect(normaliseSearchQuery("Erdoğanʼın")).toBe("Erdoğan");
    expect(normaliseSearchQuery("Erdoğan‘ın")).toBe("Erdoğan");
  });

  it("only the suffix word is cut, the rest of the query stays", () => {
    expect(normaliseSearchQuery("Erdoğan’ın açıklaması")).toBe("Erdoğan açıklaması");
    expect(normaliseSearchQuery("Özel'den Bahçeli'nin sözleri")).toBe("Özel Bahçeli sözleri");
  });

  it("a dangling apostrophe after a letter is dropped with nothing after it", () => {
    expect(normaliseSearchQuery("Erdoğan'")).toBe("Erdoğan");
  });

  it("keeps an apostrophe that does not follow a letter", () => {
    expect(normaliseSearchQuery("'seçim")).toBe("'seçim");
    expect(normaliseSearchQuery("2024'te")).toBe("2024'te");
  });

  it("keeps the double quotes of a phrase search", () => {
    expect(normaliseSearchQuery('"seçim sonuçları"')).toBe('"seçim sonuçları"');
  });

  it("a control character next to an apostrophe cannot hide the suffix", () => {
    expect(normaliseSearchQuery("Özel'\u0000den")).toBe("Özel den");
    expect(normaliseSearchQuery("Özel\u0000'den")).toBe("Özel 'den");
  });

  it("replaces lone surrogates, which Postgres rejects, with a space", () => {
    expect(normaliseSearchQuery("a\ud83db")).toBe("a b");
    expect(normaliseSearchQuery("a\udc00b")).toBe("a b");
    // A well-formed pair (an emoji) is kept.
    expect(normaliseSearchQuery("a\u{1F600}b")).toBe("a\u{1F600}b");
  });

  it("leaves a plain Turkish query untouched", () => {
    expect(normaliseSearchQuery("Cumhurbaşkanı")).toBe("Cumhurbaşkanı");
  });
});

describe("foldTr", () => {
  it("folds Turkish capitals to ASCII lower case", () => {
    expect(foldTr("İMAMOĞLU")).toBe("imamoglu");
    expect(foldTr("ŞİŞLİ")).toBe("sisli");
    expect(foldTr("İSTANBUL")).toBe("istanbul");
    expect(foldTr("Cumhurbaşkanı")).toBe("cumhurbaskani");
  });

  it("folds ASCII I and dotless ı to i (no Turkish dotless casing)", () => {
    expect(foldTr("IŞIK")).toBe("isik");
    expect(foldTr("ışık")).toBe("isik");
  });

  it("folds the circumflex vowels", () => {
    expect(foldTr("ÂÎÛ âîû")).toBe("aiu aiu");
  });

  it("drops a combining dot above (decomposed İ)", () => {
    expect(foldTr("I\u0307stanbul")).toBe("istanbul");
    expect(foldTr("i\u0307stanbul")).toBe("istanbul");
  });

  it("lower-cases ASCII only and leaves other letters and symbols alone", () => {
    expect(foldTr("ABC xyz 123")).toBe("abc xyz 123");
    expect(foldTr("ÉÀ")).toBe("ÉÀ");
    expect(foldTr('"seçim" -x')).toBe('"secim" -x');
    expect(foldTr("a\u{1F600}b")).toBe("a\u{1F600}b");
  });

  it("is idempotent and total on the empty string", () => {
    expect(foldTr("")).toBe("");
    expect(foldTr(foldTr("ŞİŞLİ Çankaya"))).toBe(foldTr("ŞİŞLİ Çankaya"));
  });

  it("uses the house fold of migrations 112/125/126 (rising-entities)", () => {
    expect(SEARCH_FOLD_FROM).toBe(RISING_FOLD_FROM);
    expect(SEARCH_FOLD_TO).toBe(RISING_FOLD_TO);
  });
});
