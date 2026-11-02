import { describe, expect, it } from "vitest";

import {
  BOILERPLATE_PHRASES,
  isBoilerplateDescription,
  TRAILING_CTA_PHRASES,
} from "./description-boilerplate";

describe("BOILERPLATE_PHRASES", () => {
  it("is exported and holds the known call-to-action phrases", () => {
    expect(BOILERPLATE_PHRASES.has("devamı için tıklayınız")).toBe(true);
    expect(BOILERPLATE_PHRASES.has("read more")).toBe(true);
    expect(BOILERPLATE_PHRASES.has("ayrıntılar birazdan")).toBe(true);
    expect(BOILERPLATE_PHRASES.size).toBe(9);
  });

  it("stores every entry lower-case and trimmed (the matchers fold the input, not the Set)", () => {
    for (const phrase of BOILERPLATE_PHRASES) {
      expect(phrase, phrase).toBe(phrase.trim());
      expect(phrase, phrase).toBe(phrase.toLowerCase());
      expect(phrase, phrase).toBe(phrase.toLocaleLowerCase("tr-TR"));
      expect(phrase.length, phrase).toBeGreaterThan(0);
    }
  });
});

describe("TRAILING_CTA_PHRASES (h22-editorial-2, h23-live-1)", () => {
  it("holds the six sentence-style tails and leaves the rest of BOILERPLATE_PHRASES alone", () => {
    expect([...TRAILING_CTA_PHRASES].sort()).toEqual([
      "detaylar haberimizde",
      "işte ayrıntılar",
      "işte detaylar",
      "işte merak edilen tüm detaylar",
      "işte merak edilenler",
      "işte tüm detaylar",
    ]);
    expect(BOILERPLATE_PHRASES.size).toBe(9);
    for (const phrase of TRAILING_CTA_PHRASES) expect(BOILERPLATE_PHRASES.has(phrase), phrase).toBe(false);
  });

  it("stores every entry tr-TR lower-case and trimmed", () => {
    for (const phrase of TRAILING_CTA_PHRASES) {
      expect(phrase, phrase).toBe(phrase.trim());
      expect(phrase, phrase).toBe(phrase.toLocaleLowerCase("tr-TR"));
      expect(phrase, phrase).not.toMatch(/\s{2,}/);
    }
  });
});

describe("isBoilerplateDescription", () => {
  it.each([
    "Click to continue",
    "Click to continue.",
    " click to continue… ",
    "CLICK TO CONTINUE",
    "Click here to continue",
    "Read more",
    "Read more »",
    "Continue reading",
    "Devamını oku",
    "Devamını oku...",
    "Devamı için tıklayın",
    "Devamı için tıklayınız!",
    "Haberin devamı için tıklayın",
  ])("flags %j as boilerplate", (s) => {
    expect(isBoilerplateDescription(s)).toBe(true);
  });

  it.each([
    "İşte detaylar...",
    "İşte ayrıntılar",
    "İŞTE AYRINTILAR!",
    "Detaylar haberimizde…",
    "DETAYLAR HABERİMİZDE",
    "  işte   detaylar \n",
  ])("flags the sentence-style tail %j as boilerplate", (s) => {
    expect(isBoilerplateDescription(s)).toBe(true);
  });

  it.each([
    "İşte merak edilen tüm detaylar...",
    "İşte merak edilen tüm detaylar",
    "İŞTE MERAK EDİLEN TÜM DETAYLAR!",
    "İşte tüm detaylar!",
    "işte  tüm   detaylar",
    "İşte merak edilenler",
    "İşte merak edilenler…",
  ])("flags the h23 sentence-style tail %j as boilerplate", (s) => {
    expect(isBoilerplateDescription(s)).toBe(true);
  });

  it.each([
    "Ayrıntılar birazdan...",
    "Ayrıntılar birazdan",
    "AYRINTILAR BİRAZDAN",
    "  ayrıntılar   birazdan…  ",
  ])("flags the placeholder %j as boilerplate", (s) => {
    expect(isBoilerplateDescription(s)).toBe(true);
  });

  it.each([
    "Ayrıntılar birazdan açıklanacak",
    "Ayrıntılar birazdan sonra",
    "Tüm ayrıntılar birazdan",
    "İşte tüm detaylar ve rakamlar",
    "İşte merak edilenleri açıkladı",
    "İşte merak edilen tüm detaylarıyla",
    "Bakan açıkladı: İşte tüm detaylar",
  ])("does not flag %j (exact match only)", (s) => {
    expect(isBoilerplateDescription(s)).toBe(false);
  });

  it.each([
    "İşte detaylarıyla yeni düzenleme",
    "İşte detaylar ve yeni kurallar",
    "Detaylar haberimizde yer alıyor",
    "Yeni kurallar: İşte detaylar",
  ])("does not flag %j (the phrase is not the whole text)", (s) => {
    expect(isBoilerplateDescription(s)).toBe(false);
  });

  it("strips a very long trailing punctuation run in linear time", () => {
    const start = performance.now();
    expect(isBoilerplateDescription("Read more" + "!".repeat(200_000))).toBe(true);
    expect(isBoilerplateDescription(".".repeat(200_000) + "a")).toBe(false);
    expect(isBoilerplateDescription("a" + ".".repeat(200_000) + "b")).toBe(false);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("flags the Turkish uppercase form (dotted capital İ)", () => {
    expect(isBoilerplateDescription("DEVAMI İÇİN TIKLAYIN")).toBe(true);
    expect(isBoilerplateDescription("HABERİN DEVAMI İÇİN TIKLAYIN")).toBe(true);
  });

  it("flags the Turkish uppercase form of a word with dotless ı", () => {
    // "DEVAMINI OKU": plain toLowerCase() gives "devamini oku" (wrong i);
    // toLocaleLowerCase('tr-TR') gives "devamını oku" (the Set entry).
    expect(isBoilerplateDescription("DEVAMINI OKU")).toBe(true);
  });

  it("collapses internal whitespace and newlines", () => {
    expect(isBoilerplateDescription("Click   to\n continue")).toBe(true);
    expect(isBoilerplateDescription("\tDevamını oku\t")).toBe(true);
  });

  it("strips mixed trailing punctuation", () => {
    expect(isBoilerplateDescription("Click to continue ...")).toBe(true);
    expect(isBoilerplateDescription("Read more >")).toBe(true);
    expect(isBoilerplateDescription("Read more ›")).toBe(true);
  });

  it("does not flag a real summary", () => {
    expect(
      isBoilerplateDescription(
        "Bakan, yeni vergi düzenlemesinin ilk aşamasının gelecek ay yürürlüğe gireceğini açıkladı.",
      ),
    ).toBe(false);
  });

  it("uses exact matching: a longer sentence starting with the phrase is not boilerplate", () => {
    expect(
      isBoilerplateDescription(
        "Click to continue reading the minister's statement on ...",
      ),
    ).toBe(false);
    expect(isBoilerplateDescription("Please click to continue")).toBe(false);
    expect(isBoilerplateDescription("Devamını oku ve yorum yap")).toBe(false);
  });

  it("does not flag a leading-punctuation variant (only trailing is stripped)", () => {
    expect(isBoilerplateDescription("» Read more")).toBe(false);
  });

  it("returns false for null, undefined, empty and whitespace-only input", () => {
    expect(isBoilerplateDescription(null)).toBe(false);
    expect(isBoilerplateDescription(undefined)).toBe(false);
    expect(isBoilerplateDescription("")).toBe(false);
    expect(isBoilerplateDescription("   \n\t ")).toBe(false);
  });

  it("returns false for punctuation-only input", () => {
    expect(isBoilerplateDescription("...")).toBe(false);
    expect(isBoilerplateDescription("…")).toBe(false);
  });
});
