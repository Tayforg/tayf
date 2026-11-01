import { describe, expect, it } from "vitest";
import { isContentlessTitle } from "../../../supabase/functions/_shared/rss/entities.ts";

// ---------------------------------------------------------------------------
// isContentlessTitle: "no letter or digit after decoding" means the string is
// not a headline. Prod had /cluster/46467982-... titled '&nbsp' (rendered as
// "&amp;nbsp — Tayf" in <title>): a double-encoded "&amp;nbsp;" whose trailing
// semicolon the feed dropped, so `decodeResidualEntities` (which only knows
// `&name;`) left a literal '&nbsp' behind. The predicate therefore also treats
// a bare `&name` / `&#N` (no semicolon) as non-text. benguturk.com /reklam/
// items arrive with U+3164 HANGUL FILLER as their whole title: a Unicode
// LETTER (Lo) that renders as blank, so it is a non-text case too.
// ---------------------------------------------------------------------------

describe("isContentlessTitle: true for strings that are not a headline", () => {
  it.each([
    ["empty string", ""],
    ["spaces", "   "],
    ["one space", " "],
    ["tab and newline", "\t\n"],
    ["bare &nbsp (no semicolon)", "&nbsp"],
    ["&nbsp;", "&nbsp;"],
    ["double-encoded bare &amp;nbsp", "&amp;nbsp"],
    ["double-encoded &amp;nbsp;", "&amp;nbsp;"],
    ["triple-encoded &amp;amp;nbsp", "&amp;amp;nbsp"],
    ["two bare nbsp with a space", "&nbsp &nbsp"],
    ["numeric nbsp &#160;", "&#160;"],
    ["bare numeric &#160 (no semicolon)", "&#160"],
    ["hex nbsp &#xA0;", "&#xA0;"],
    ["double-encoded numeric &amp;#160;", "&amp;#160;"],
    ["zero-width space &#8203;", "&#8203;"],
    ["a raw zero-width space", "\u200B"],
    ["a raw no-break space", "\u00A0"],
    ["hyphen", "-"],
    ["spaced hyphen", " - "],
    ["em dash", "—"],
    ["ellipsis character", "…"],
    ["three dots", "..."],
    ["&hellip;", "&hellip;"],
    ["guillemets", "«»"],
    ["an emoji-only title (no letter or digit)", "😀"],
    ["punctuation and entities only", " - &nbsp; … "],
    ["an unknown but well-formed named entity", "&Foo;"],
    ["HANGUL FILLER U+3164 (benguturk /reklam/ title)", "\u3164"],
    ["several HANGUL FILLERs", "\u3164\u3164\u3164"],
    ["HANGUL CHOSEONG + JUNGSEONG fillers", "\u115F\u1160"],
    ["HALFWIDTH HANGUL FILLER", "\uFFA0"],
    ["HANGUL FILLER as a numeric reference", "&#x3164;"],
  ])("%s", (_label, input) => {
    expect(isContentlessTitle(input)).toBe(true);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["an object", {}],
    ["an array", ["Gol!"]],
    ["a boolean", false],
  ])("non-string input (%s) is contentless", (_label, input) => {
    expect(isContentlessTitle(input)).toBe(true);
  });
});

describe("isContentlessTitle: false for real headlines", () => {
  it.each([
    ["an ampersand inside a company name", "AT&T hisseleri yükseldi"],
    ["R&D", "R&D"],
    ["a named entity that decodes to a letter", "&Ccedil;ok önemli"],
    ["a letter followed by &nbsp;", "Ş&nbsp;"],
    ["a single-encoded headline", "T&uuml;rkiye&amp;nbsp;yükseldi"],
    ["a short exclamation", "Gol!"],
    ["digits only", "2025"],
    ["a single letter", "a"],
    ["a single digit", "7"],
    ["percent and digits", "%50 zam"],
    ["an ordinary Turkish headline", "Merkez Bankası faizi sabit tuttu"],
    ["Hangul text is a real headline", "한국"],
    ["a HANGUL FILLER next to real letters", "\u3164Gol\u3164"],
  ])("%s", (_label, input) => {
    expect(isContentlessTitle(input)).toBe(false);
  });
});

describe("isContentlessTitle: hostile input", () => {
  it("never throws on a 10k-character '&amp;' repeat, and answers quickly", () => {
    const hostile = "&amp;".repeat(2000); // 10,000 characters
    expect(hostile).toHaveLength(10_000);
    const t0 = Date.now();
    let result: unknown;
    expect(() => {
      result = isContentlessTitle(hostile);
    }).not.toThrow();
    expect(typeof result).toBe("boolean");
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("never throws on a long run of lone ampersands or an unterminated entity", () => {
    expect(() => isContentlessTitle("&".repeat(10_000))).not.toThrow();
    expect(() => isContentlessTitle("&#" + "9".repeat(10_000))).not.toThrow();
    expect(() => isContentlessTitle("&a".repeat(5_000))).not.toThrow();
  });

  it("a hostile numeric reference (above U+10FFFF) is contentless, not a throw", () => {
    expect(isContentlessTitle("&#1114112;")).toBe(true);
    expect(isContentlessTitle("&#x110000;")).toBe(true);
  });

  it("is stateless: repeated calls on the same input agree (no /g lastIndex leak)", () => {
    for (let i = 0; i < 4; i++) {
      expect(isContentlessTitle("&nbsp")).toBe(true);
      expect(isContentlessTitle("Gol!")).toBe(false);
    }
  });

  it("a real headline wrapped in a long entity chain still counts as a headline", () => {
    expect(isContentlessTitle("&amp;".repeat(100) + " Gol haberi")).toBe(false);
  });
});
