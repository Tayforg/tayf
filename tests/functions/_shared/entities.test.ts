import { describe, expect, it } from "vitest";
import {
  INVALID_XML_CHARS_RE,
  codePointToString,
  isXmlCodePoint,
  stripInvalidXmlChars,
} from "../../../supabase/functions/_shared/rss/entities.ts";
import { stripInvalidXmlChars as builderStripInvalidXmlChars } from "../../../src/lib/feeds/rss-builder";

// ---------------------------------------------------------------------------
// supabase/functions/_shared/rss/entities.ts is the ONE place that turns a
// numeric character reference into a string. String.fromCodePoint throws a
// RangeError for anything above U+10FFFF (and for NaN / negatives / fractions),
// and one throw used to drop a whole source's items. This module never throws
// and only ever returns characters that are legal in an XML 1.0 document.
// ---------------------------------------------------------------------------

describe("codePointToString", () => {
  it.each([
    ["NUL", 0],
    ["SOH", 0x1],
    ["BS (last control before TAB)", 0x8],
    ["VT", 0xb],
    ["FF", 0xc],
    ["US (last C0 control)", 0x1f],
    ["first high surrogate", 0xd800],
    ["last low surrogate", 0xdfff],
    ["U+FFFE non-character", 0xfffe],
    ["U+FFFF non-character", 0xffff],
    ["one past U+10FFFF", 0x110000],
    ["negative", -1],
    ["NaN", Number.NaN],
    ["fraction", 1.5],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["overflowing decimal reference", Number("99999999999999999999")],
  ])("returns '' for %s", (_label, cp) => {
    expect(codePointToString(cp)).toBe("");
  });

  it.each([
    ["TAB", 0x9, "\t"],
    ["LF", 0xa, "\n"],
    ["CR", 0xd, "\r"],
    ["SPACE (first legal after the controls)", 0x20, " "],
    ["ş", 0x15f, "ş"],
    ["last char before the surrogates", 0xd7ff, "퟿"],
    ["first char after the surrogates", 0xe000, ""],
    ["U+FFFD replacement char", 0xfffd, "�"],
    ["first astral code point", 0x10000, "\u{10000}"],
    ["emoji", 0x1f600, "😀"],
    ["last Unicode code point", 0x10ffff, "\u{10ffff}"],
  ])("returns the character for %s", (_label, cp, expected) => {
    expect(codePointToString(cp)).toBe(expected);
  });

  it("never throws, whatever it is handed", () => {
    for (const cp of [
      0,
      -0,
      1e308,
      -1e308,
      Number.MAX_SAFE_INTEGER,
      Number.MIN_SAFE_INTEGER,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(() => codePointToString(cp)).not.toThrow();
    }
  });
});

describe("isXmlCodePoint", () => {
  it("accepts exactly the XML 1.0 Char ranges", () => {
    const legal = [0x9, 0xa, 0xd, 0x20, 0x41, 0xd7ff, 0xe000, 0xfffd, 0x10000, 0x10ffff];
    for (const cp of legal) expect(isXmlCodePoint(cp), `U+${cp.toString(16)}`).toBe(true);
  });

  it("rejects everything around those ranges", () => {
    const illegal = [
      0, 0x8, 0xb, 0xc, 0xe, 0x1f, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xfffe, 0xffff,
      0x110000, -1,
    ];
    for (const cp of illegal) expect(isXmlCodePoint(cp), `U+${cp.toString(16)}`).toBe(false);
  });

  it("rejects non-integers", () => {
    expect(isXmlCodePoint(Number.NaN)).toBe(false);
    expect(isXmlCodePoint(1.5)).toBe(false);
    expect(isXmlCodePoint(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("agrees with the XML 1.0 spec for every code point from 0 to 0x110000", () => {
    // Independent oracle: the Char production written as a plain predicate.
    const oracle = (cp: number): boolean =>
      cp === 0x9 ||
      cp === 0xa ||
      cp === 0xd ||
      (cp >= 0x20 && cp <= 0xd7ff) ||
      (cp >= 0xe000 && cp <= 0xfffd) ||
      (cp >= 0x10000 && cp <= 0x10ffff);
    const mismatches: number[] = [];
    for (let cp = 0; cp <= 0x110000; cp++) {
      if (isXmlCodePoint(cp) !== oracle(cp)) mismatches.push(cp);
    }
    expect(mismatches).toEqual([]);
  });
});

describe("stripInvalidXmlChars", () => {
  const everyBmpCodeUnit = Array.from({ length: 0x10000 }, (_, i) =>
    String.fromCharCode(i),
  ).join("");

  it("matches rss-builder's version on a string of every BMP code unit, an emoji and lone surrogates", () => {
    const input = `${everyBmpCodeUnit}😀\ud800x\udc00y😀\ud83d`;
    expect(stripInvalidXmlChars(input)).toBe(builderStripInvalidXmlChars(input));
  });

  it("removes controls, U+FFFE/U+FFFF and lone surrogates but keeps legal text", () => {
    expect(stripInvalidXmlChars("a\u0001b￾c\ud800d\udc00e")).toBe("abcde");
    expect(stripInvalidXmlChars("a\tb\nc\rd")).toBe("a\tb\nc\rd");
    expect(stripInvalidXmlChars("Şişli 😀 haber")).toBe("Şişli 😀 haber");
  });

  it("leaves nothing XML-illegal behind, even from the all-code-units string", () => {
    const nonGlobal = new RegExp(INVALID_XML_CHARS_RE.source);
    expect(nonGlobal.test(stripInvalidXmlChars(everyBmpCodeUnit))).toBe(false);
  });

  it("is idempotent", () => {
    const once = stripInvalidXmlChars(everyBmpCodeUnit);
    expect(stripInvalidXmlChars(once)).toBe(once);
  });
});
