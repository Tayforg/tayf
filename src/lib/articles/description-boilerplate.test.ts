import { describe, expect, it } from "vitest";

import { isBoilerplateDescription } from "./description-boilerplate";

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
