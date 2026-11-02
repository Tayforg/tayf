import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ENGLISH_SOURCE_NAMES,
  ENGLISH_SOURCE_SLUGS,
  sourceLang,
} from "./source-language";

// h17-a11y-2 (WCAG 3.1.2 Language of Parts): the five English-language
// outlets render inside <html lang="tr">, so a screen reader pronounces their
// headlines with Turkish phonetics. sourceLang() is a code constant -- no DB
// column -- and cards only carry the source NAME (their `sources (...)`
// projection has no slug), so the name fallback matters as much as the slug.

const ENGLISH_SLUGS = [
  "a-news",
  "daily-sabah",
  "hurriyet-daily-news",
  "trt-world",
  "turkiye-today",
] as const;

// Exactly what production `public.sources.name` returns for those slugs.
const PROD_NAMES = [
  "A News",
  "Daily Sabah",
  "Hürriyet Daily News",
  "TRT World",
  "Türkiye Today",
] as const;

describe("sourceLang: slug lookup", () => {
  it.each(ENGLISH_SLUGS)("returns 'en' for %s", (slug) => {
    expect(sourceLang({ slug })).toBe("en");
  });

  it("returns undefined for a Turkish-language source", () => {
    expect(sourceLang({ slug: "sozcu" })).toBeUndefined();
  });

  it("trims the slug before matching", () => {
    expect(sourceLang({ slug: "  daily-sabah\n" })).toBe("en");
  });

  it("does not match a slug that merely contains an English slug", () => {
    expect(sourceLang({ slug: "daily-sabah-turkce" })).toBeUndefined();
    expect(sourceLang({ slug: "trt-world-x" })).toBeUndefined();
  });
});

describe("sourceLang: name-only lookup (cards carry no slug)", () => {
  it.each(PROD_NAMES)("returns 'en' for the production name %s", (name) => {
    expect(sourceLang({ name })).toBe("en");
  });

  it("returns 'en' for Daily Sabah by name", () => {
    expect(sourceLang({ name: "Daily Sabah" })).toBe("en");
  });

  it.each([
    "  daily sabah ",
    "TRT WORLD",
    "HÜRRİYET DAILY NEWS", // dotted İ: needs the tr-TR fold, and DAILY's I folds to ı under tr-TR
    "daily   sabah",
    "a news",
    "TÜRKİYE TODAY",
  ])("returns 'en' for the case/spacing variant %j", (name) => {
    expect(sourceLang({ name })).toBe("en");
  });

  it.each(["Hurriyet Daily News", "Turkiye Today", "HURRIYET DAILY NEWS"])(
    "returns 'en' for the ASCII spelling %j",
    (name) => {
      expect(sourceLang({ name })).toBe("en");
    },
  );

  it("returns undefined for a Turkish outlet name", () => {
    expect(sourceLang({ name: "Sözcü" })).toBeUndefined();
    expect(sourceLang({ name: "Hürriyet" })).toBeUndefined();
    expect(sourceLang({ name: "Cumhuriyet" })).toBeUndefined();
  });

  it("does not match a name that merely contains an English name", () => {
    expect(sourceLang({ name: "Daily Sabah Türkçe" })).toBeUndefined();
  });
});

describe("sourceLang: precedence and fallbacks", () => {
  it("slug wins over name when the slug is non-empty", () => {
    expect(sourceLang({ slug: "sozcu", name: "Daily Sabah" })).toBeUndefined();
    expect(sourceLang({ slug: "daily-sabah", name: "Sözcü" })).toBe("en");
  });

  it.each([
    ["empty", ""],
    ["whitespace", "   \t "],
    ["null", null],
    ["undefined", undefined],
  ])("an %s slug falls back to the name", (_label, slug) => {
    expect(sourceLang({ slug, name: "Daily Sabah" })).toBe("en");
    expect(sourceLang({ slug, name: "Sözcü" })).toBeUndefined();
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty object", {}],
    ["null slug and name", { slug: null, name: null }],
    ["empty strings", { slug: "", name: "" }],
    ["whitespace strings", { slug: "  ", name: "  " }],
  ])("returns undefined for %s", (_label, input) => {
    expect(sourceLang(input)).toBeUndefined();
  });

  it("never throws on a non-string slug or name smuggled past the types", () => {
    const bad = { slug: 42, name: { toString: () => "Daily Sabah" } };
    expect(() =>
      sourceLang(bad as unknown as Parameters<typeof sourceLang>[0]),
    ).not.toThrow();
    expect(
      sourceLang(bad as unknown as Parameters<typeof sourceLang>[0]),
    ).toBeUndefined();
  });
});

describe("ENGLISH_SOURCE_SLUGS / ENGLISH_SOURCE_NAMES", () => {
  it("ENGLISH_SOURCE_SLUGS has exactly the five English slugs", () => {
    expect([...ENGLISH_SOURCE_SLUGS].sort()).toEqual([...ENGLISH_SLUGS].sort());
    expect(ENGLISH_SOURCE_SLUGS.size).toBe(5);
  });

  it("ENGLISH_SOURCE_NAMES holds only folded (lower-case, trimmed) names", () => {
    expect(ENGLISH_SOURCE_NAMES.size).toBeGreaterThanOrEqual(5);
    for (const n of ENGLISH_SOURCE_NAMES) {
      expect(n).toBe(n.trim());
      expect(n).toBe(n.toLowerCase());
      expect(n).not.toMatch(/\s{2,}/);
    }
  });

  it("every production name folds into ENGLISH_SOURCE_NAMES", () => {
    for (const name of PROD_NAMES) {
      const folded = name.toLowerCase();
      const foldedTr = name.toLocaleLowerCase("tr-TR");
      expect(
        ENGLISH_SOURCE_NAMES.has(folded) || ENGLISH_SOURCE_NAMES.has(foldedTr),
      ).toBe(true);
    }
  });
});

describe("source/[slug]/page.tsx wiring (source guard)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pagePath = join(
    here,
    "..",
    "..",
    "app",
    "source",
    "[slug]",
    "page.tsx",
  );
  const raw = readFileSync(pagePath, "utf8");
  // Blank comments (offsets kept) so prose cannot satisfy or trip a pattern.
  const page = raw
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) =>
      p1 + " ".repeat(m.length - p1.length),
    );

  function count(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
  }

  it("imports sourceLang from @/lib/sources/source-language", () => {
    expect(page).toMatch(
      /import\s*\{[^}]*\bsourceLang\b[^}]*\}\s*from\s*["']@\/lib\/sources\/source-language["']/,
    );
  });

  it("computes articleLang once from the source slug and name", () => {
    expect(count(page, "const articleLang = sourceLang(")).toBe(1);
    expect(page).toMatch(
      /const articleLang = sourceLang\(\s*\{\s*slug: source\.slug,\s*name: source\.name\s*\}\s*\)/,
    );
  });

  it("puts lang={articleLang} on exactly two elements (title and excerpt)", () => {
    expect(count(page, "lang={articleLang}")).toBe(2);
  });

  it("marks the title <p> and the excerpt <p>, and nothing else, with a lang", () => {
    expect(page).toMatch(
      /<p\s+lang=\{articleLang\}[^>]*>\s*\{article\.title\}\s*<\/p>/,
    );
    expect(page).toMatch(
      /<p\s+lang=\{articleLang\}[^>]*>\s*\{article\.description\}\s*<\/p>/,
    );
    // No other lang= attribute on the page (source name, time-ago, headings stay Turkish).
    expect(page.match(/\blang=/g)).toHaveLength(2);
  });
});
