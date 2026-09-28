import { describe, it, expect } from "vitest";

import {
  MAX_QUERY_VARIANTS,
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
