import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  clusterTextLang,
  ENGLISH_SOURCE_NAMES,
  ENGLISH_SOURCE_SLUGS,
  headlineLang,
  sourceLang,
} from "./source-language";

// h17-a11y-2 (WCAG 3.1.2 Language of Parts): the English-language outlets
// render inside <html lang="tr">, so a screen reader pronounces their
// headlines with Turkish phonetics. sourceLang() is a code constant -- no DB
// column -- and cards only carry the source NAME (their `sources (...)`
// projection has no slug), so the name fallback matters as much as the slug.
// h43-sources-2 added the sixth outlet, MFA Turkey (kind niche): its items
// reach cluster pages and /source/mfa-turkey with English titles.

const ENGLISH_SLUGS = [
  "a-news",
  "daily-sabah",
  "hurriyet-daily-news",
  "mfa-turkey",
  "trt-world",
  "turkiye-today",
] as const;

// The five outlets h17-a11y-2 named, kept apart so a regression on the
// original set cannot hide behind the new sixth entry.
const ORIGINAL_FIVE_SLUGS = [
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
  "MFA Turkey",
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
    expect(sourceLang({ slug: "mfa-turkey-x" })).toBeUndefined();
    expect(sourceLang({ slug: "mfa" })).toBeUndefined();
  });

  it("returns 'en' for the mfa-turkey slug (h43-sources-2)", () => {
    expect(sourceLang({ slug: "mfa-turkey" })).toBe("en");
    expect(sourceLang({ slug: " mfa-turkey\n" })).toBe("en");
  });

  it.each(ORIGINAL_FIVE_SLUGS)("still returns 'en' for the original outlet %s", (slug) => {
    expect(sourceLang({ slug })).toBe("en");
  });

  it("still returns undefined for Turkish outlets after the sixth slug was added", () => {
    for (const slug of ["sozcu", "sabah", "hurriyet", "anadolu-ajansi", "disisleri"]) {
      expect(sourceLang({ slug })).toBeUndefined();
    }
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

  // h43-sources-2: the production name is 'MFA Turkey'; 'MFA Türkiye' is the
  // outlet's own newer spelling. Both go through foldName.
  it.each([
    "MFA Turkey",
    "MFA Türkiye",
    "mfa turkey",
    "mfa türkiye",
    "MFA TURKEY",
    "MFA TÜRKİYE", // dotted İ: needs the tr-TR fold
    "  MFA   Turkey ",
  ])("returns 'en' for the MFA Turkey name variant %j", (name) => {
    expect(sourceLang({ name })).toBe("en");
  });

  it("does not match a name that merely contains the MFA Turkey name", () => {
    expect(sourceLang({ name: "MFA Turkey Türkçe" })).toBeUndefined();
    expect(sourceLang({ name: "MFA" })).toBeUndefined();
    expect(sourceLang({ name: "Dışişleri Bakanlığı" })).toBeUndefined();
  });

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

describe("sourceLang: the cluster-page call shapes (h23-a11y-1)", () => {
  it("returns 'en' for the daily-sabah slug", () => {
    expect(sourceLang({ slug: "daily-sabah" })).toBe("en");
  });

  it("returns undefined for the Turkish 'sabah' slug (not a prefix match)", () => {
    expect(sourceLang({ slug: "sabah" })).toBeUndefined();
  });

  it("returns 'en' for the Daily Sabah display name alone", () => {
    expect(sourceLang({ name: "Daily Sabah" })).toBe("en");
  });

  it("returns undefined for the Turkish 'Sabah' display name", () => {
    expect(sourceLang({ name: "Sabah" })).toBeUndefined();
  });
});

describe("clusterTextLang", () => {
  const english = ENGLISH_SLUGS.map((slug) => ({ slug }));

  it("returns 'en' when every source is English (all six slugs)", () => {
    expect(clusterTextLang(english)).toBe("en");
  });

  it.each(ENGLISH_SLUGS)("returns 'en' for a single %s source", (slug) => {
    expect(clusterTextLang([{ slug }])).toBe("en");
  });

  it("returns 'en' for name-only English sources", () => {
    expect(
      clusterTextLang(PROD_NAMES.map((name) => ({ name }))),
    ).toBe("en");
  });

  it("accepts the same source more than once (one outlet, several articles)", () => {
    expect(
      clusterTextLang([{ slug: "daily-sabah" }, { slug: "daily-sabah" }]),
    ).toBe("en");
  });

  it("returns undefined for an empty list (no member, nothing to claim)", () => {
    expect(clusterTextLang([])).toBeUndefined();
  });

  it("returns undefined when a single Turkish source is mixed in", () => {
    expect(
      clusterTextLang([...english, { slug: "sozcu", name: "Sözcü" }]),
    ).toBeUndefined();
    expect(
      clusterTextLang([{ slug: "sozcu" }, { slug: "daily-sabah" }]),
    ).toBeUndefined();
  });

  it("returns undefined when the only source is Turkish", () => {
    expect(clusterTextLang([{ slug: "sozcu" }])).toBeUndefined();
  });

  it("returns undefined when any entry is null or undefined", () => {
    expect(clusterTextLang([{ slug: "daily-sabah" }, null])).toBeUndefined();
    expect(clusterTextLang([undefined, { slug: "daily-sabah" }])).toBeUndefined();
    expect(clusterTextLang([null])).toBeUndefined();
  });

  it("returns undefined when an entry carries neither a slug nor a name", () => {
    expect(clusterTextLang([{ slug: "daily-sabah" }, {}])).toBeUndefined();
    expect(
      clusterTextLang([{ slug: "daily-sabah" }, { slug: null, name: null }]),
    ).toBeUndefined();
  });

  it("decides each entry the way sourceLang does: a Turkish slug beats an English name", () => {
    expect(
      clusterTextLang([{ slug: "sozcu", name: "Daily Sabah" }]),
    ).toBeUndefined();
    expect(
      clusterTextLang([{ slug: "", name: "Daily Sabah" }]),
    ).toBe("en");
  });

  it("never throws on a non-array smuggled past the types", () => {
    expect(() =>
      clusterTextLang(null as unknown as Parameters<typeof clusterTextLang>[0]),
    ).not.toThrow();
    expect(
      clusterTextLang(null as unknown as Parameters<typeof clusterTextLang>[0]),
    ).toBeUndefined();
  });

  it("handles a large mega-cluster (10k members)", () => {
    const big = Array.from({ length: 10_000 }, () => ({ slug: "trt-world" }));
    expect(clusterTextLang(big)).toBe("en");
    expect(clusterTextLang([...big, { slug: "sozcu" }])).toBeUndefined();
  });
});

// h27/h29: a story card's <h2> is the cluster headline, and an extractive
// headline IS one member's own title. When that member is an English outlet the
// h2 reads English inside <html lang="tr">. headlineLang answers 'en' only when
// the headline can be traced to an English member and to no Turkish one.
describe("headlineLang", () => {
  const EN = "Turkish President Erdogan arrives in South Korea for official visit";
  const TR = "Cumhurbaşkanı Erdoğan Güney Kore'ye gitti";

  it("returns 'en' when the headline is an English member's title verbatim", () => {
    expect(
      headlineLang(EN, [
        { title: TR, lang: undefined },
        { title: EN, lang: "en" },
      ]),
    ).toBe("en");
  });

  it("returns undefined for a Turkish neutral title that no member carries", () => {
    expect(
      headlineLang("Erdoğan Güney Kore'de", [
        { title: EN, lang: "en" },
        { title: TR, lang: undefined },
      ]),
    ).toBeUndefined();
  });

  it("returns undefined when a Turkish source carries the same title (a tie is not English)", () => {
    expect(
      headlineLang(EN, [
        { title: EN, lang: "en" },
        { title: EN, lang: undefined },
      ]),
    ).toBeUndefined();
    // Order does not matter.
    expect(
      headlineLang(EN, [
        { title: EN, lang: undefined },
        { title: EN, lang: "en" },
      ]),
    ).toBeUndefined();
  });

  it("returns undefined when the only identical title is a Turkish source's", () => {
    expect(headlineLang(TR, [{ title: TR, lang: undefined }])).toBeUndefined();
  });

  it("still matches when the two sides differ only in whitespace", () => {
    expect(
      headlineLang(`  ${EN}\n`, [{ title: EN.replace(/ /g, "  "), lang: "en" }]),
    ).toBe("en");
    expect(
      headlineLang("Drone strike\thits   power station", [
        { title: " Drone strike hits power station ", lang: "en" },
      ]),
    ).toBe("en");
  });

  it("does not match a title that merely contains or extends the headline", () => {
    expect(headlineLang("Drone strike", [{ title: "Drone strike hits power station", lang: "en" }])).toBeUndefined();
    expect(headlineLang("Drone strike hits power station", [{ title: "Drone strike", lang: "en" }])).toBeUndefined();
  });

  it("is case-sensitive: only an identical title counts", () => {
    expect(headlineLang(EN, [{ title: EN.toUpperCase(), lang: "en" }])).toBeUndefined();
  });

  it("returns undefined for an empty member list", () => {
    expect(headlineLang(EN, [])).toBeUndefined();
  });

  it("returns undefined for an empty or blank headline, even against an empty English title", () => {
    expect(headlineLang("", [{ title: "", lang: "en" }])).toBeUndefined();
    expect(headlineLang("   \t ", [{ title: "  ", lang: "en" }])).toBeUndefined();
    expect(headlineLang("", [{ title: EN, lang: "en" }])).toBeUndefined();
  });

  it("only ever returns 'en' or undefined", () => {
    for (const lang of ["en", undefined] as const) {
      const out = headlineLang(EN, [{ title: EN, lang }]);
      expect(out === "en" || out === undefined).toBe(true);
    }
  });

  it("never throws on null, non-string or non-array input smuggled past the types", () => {
    const call = (h: unknown, m: unknown) =>
      headlineLang(h as string, m as Parameters<typeof headlineLang>[1]);
    expect(() => call(null, null)).not.toThrow();
    expect(call(null, [{ title: EN, lang: "en" }])).toBeUndefined();
    expect(call(EN, null)).toBeUndefined();
    expect(call(EN, [null, undefined, { title: 42, lang: "en" }, { lang: "en" }])).toBeUndefined();
    expect(call(EN, [null, { title: EN, lang: "en" }])).toBe("en");
  });

  it("handles a large mega-cluster (10k members) with one English match", () => {
    const members = Array.from({ length: 10_000 }, (_, i) => ({
      title: `Başlık ${i}`,
      lang: undefined as "en" | undefined,
    }));
    members.push({ title: EN, lang: "en" });
    expect(headlineLang(EN, members)).toBe("en");
    members.push({ title: EN, lang: undefined });
    expect(headlineLang(EN, members)).toBeUndefined();
  });

  it("copes with special characters and emoji in a title", () => {
    const title = "Fire at ‘Café Ünal’ — “10,000” evacuated 🔥 <b>&amp;</b>";
    expect(headlineLang(title, [{ title, lang: "en" }])).toBe("en");
  });
});

describe("ENGLISH_SOURCE_SLUGS / ENGLISH_SOURCE_NAMES", () => {
  it("ENGLISH_SOURCE_SLUGS has exactly the six English slugs, mfa-turkey included", () => {
    expect([...ENGLISH_SOURCE_SLUGS].sort()).toEqual([...ENGLISH_SLUGS].sort());
    expect(ENGLISH_SOURCE_SLUGS.size).toBe(6);
    expect(ENGLISH_SOURCE_SLUGS.has("mfa-turkey")).toBe(true);
  });

  it("ENGLISH_SOURCE_NAMES holds the folded MFA Turkey spellings", () => {
    expect(ENGLISH_SOURCE_NAMES.has("mfa turkey")).toBe(true);
    expect(ENGLISH_SOURCE_NAMES.has("mfa türkiye")).toBe(true);
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
      // h48-ingest-1: the excerpt is the description with a leading style sheet off.
      /<p\s+lang=\{articleLang\}[^>]*>\s*\{excerpt\}\s*<\/p>/,
    );
    // No other lang= attribute on the page (source name, time-ago, headings stay Turkish).
    expect(page.match(/\blang=/g)).toHaveLength(2);
  });
});
