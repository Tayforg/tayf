import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  MIN_QUERY_LENGTH,
  SEARCH_QUERY_DISPLAY_MAX,
  archivePagePhrase,
  displayQuery,
  isTooShortQuery,
  resultCountPhrase,
  searchStatusText,
  searchTitle,
} from "./search-status";

// h10-a11y-2: the live-region sentence a screen-reader user hears after the
// debounced router.replace swaps the feed, and the <title> of /?q=. Pure and
// string-only: the callers render the text as a React child (escaped), and
// Next escapes metadata titles, so nothing here may build HTML.

const base = { q: "seçim", count: 0, capped: false, unavailable: false };

const here = dirname(fileURLToPath(import.meta.url));

describe("resultCountPhrase (h50-search-3)", () => {
  it("says 'en ilgili N sonuç' when the archive hit its cap", () => {
    expect(resultCountPhrase(24, true)).toBe("en ilgili 24 sonuç");
  });

  it("says 'N sonuç' when it did not", () => {
    expect(resultCountPhrase(2, false)).toBe("2 sonuç");
    expect(resultCountPhrase(1, false)).toBe("1 sonuç");
    expect(resultCountPhrase(0, false)).toBe("0 sonuç");
  });

  it("formats the count in tr-TR, capped or not (dot grouping via formatCountTr)", () => {
    expect(resultCountPhrase(1234, true)).toBe("en ilgili 1.234 sonuç");
    expect(resultCountPhrase(1234, false)).toBe("1.234 sonuç");
    expect(resultCountPhrase(12_345, false)).toBe("12.345 sonuç");
  });

  it("treats a non-finite count like zero (formatCountTr does)", () => {
    expect(resultCountPhrase(Number.NaN, false)).toBe("0 sonuç");
    expect(resultCountPhrase(Number.POSITIVE_INFINITY, true)).toBe("en ilgili 0 sonuç");
  });
});

describe("searchStatusText is built from resultCountPhrase (h50-search-3)", () => {
  it.each([1, 2, 24, 1234, 12_345])("count %i: the capped, uncapped and unavailable sentences carry the same phrase", (count) => {
    expect(searchStatusText({ ...base, count, capped: true })).toBe(
      `“seçim” için ${resultCountPhrase(count, true)} gösteriliyor.`,
    );
    expect(searchStatusText({ ...base, count, capped: false })).toBe(
      `“seçim” için ${resultCountPhrase(count, false)} bulundu.`,
    );
    expect(searchStatusText({ ...base, count, unavailable: true })).toBe(
      `“seçim” için ${resultCountPhrase(count, false)} bulundu; arşiv araması şu an yanıt vermiyor.`,
    );
  });

  it("formats the number in exactly one place: the helper", () => {
    const source = readFileSync(resolve(here, "search-status.ts"), "utf8");
    const calls = source.match(/formatCountTr\(/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(source).toMatch(/export function resultCountPhrase\(/);
    expect(source.match(/resultCountPhrase\(/g)?.length).toBeGreaterThanOrEqual(4);
  });
});

describe("searchStatusText", () => {
  it.each([undefined, "", "   ", "\t\n "])("is empty when q is %j (nothing to announce)", (q) => {
    expect(searchStatusText({ ...base, q, count: 5 })).toBe("");
    expect(searchStatusText({ ...base, q, unavailable: true })).toBe("");
    expect(searchStatusText({ ...base, q, count: 50, capped: true })).toBe("");
  });

  it("says the search is unresponsive when it is unavailable and nothing was found", () => {
    expect(searchStatusText({ ...base, unavailable: true })).toBe(
      "Arama şu an yanıt vermiyor.",
    );
  });

  it("says nothing was found for the query when the count is 0", () => {
    expect(searchStatusText(base)).toBe("“seçim” için sonuç bulunamadı.");
  });

  it("announces a single result", () => {
    expect(searchStatusText({ ...base, count: 1 })).toBe(
      "“seçim” için 1 sonuç bulundu.",
    );
  });

  it("formats the count in tr-TR (dot grouping via formatCountTr)", () => {
    expect(searchStatusText({ ...base, count: 1234 })).toBe(
      "“seçim” için 1.234 sonuç bulundu.",
    );
    expect(searchStatusText({ ...base, count: 12_345 })).toBe(
      "“seçim” için 12.345 sonuç bulundu.",
    );
  });

  it("says the most relevant N are shown when the archive hit its cap", () => {
    expect(searchStatusText({ ...base, count: 50, capped: true })).toBe(
      "“seçim” için en ilgili 50 sonuç gösteriliyor.",
    );
  });

  it("keeps the in-feed matches when only the archive is unavailable", () => {
    expect(searchStatusText({ ...base, count: 3, unavailable: true })).toBe(
      "“seçim” için 3 sonuç bulundu; arşiv araması şu an yanıt vermiyor.",
    );
  });

  it("lets unavailable win over capped (a failed search is never 'capped')", () => {
    expect(
      searchStatusText({ ...base, count: 3, capped: true, unavailable: true }),
    ).toBe("“seçim” için 3 sonuç bulundu; arşiv araması şu an yanıt vermiyor.");
  });

  it("treats a non-finite or negative count like zero results", () => {
    expect(searchStatusText({ ...base, count: Number.NaN })).toBe(
      "“seçim” için sonuç bulunamadı.",
    );
    expect(searchStatusText({ ...base, count: -4 })).toBe(
      "“seçim” için sonuç bulunamadı.",
    );
  });

  it("quotes the trimmed, whitespace-collapsed query", () => {
    expect(searchStatusText({ ...base, q: "  seçim   sonuçları ", count: 2 })).toBe(
      "“seçim sonuçları” için 2 sonuç bulundu.",
    );
  });

  it("returns a q containing markup verbatim as plain text (no HTML building)", () => {
    const q = "<script>alert(1)</script>";
    const text = searchStatusText({ ...base, q, count: 2 });
    expect(text).toBe("“<script>alert(1)</script>” için 2 sonuç bulundu.");
    expect(typeof text).toBe("string");
    expect(text).not.toContain("&lt;");
  });

  it("caps a very long query so the announcement stays short", () => {
    const text = searchStatusText({ ...base, q: "a".repeat(500), count: 2 });
    expect(text).toBe(`“${"a".repeat(59)}…” için 2 sonuç bulundu.`);
  });
});

describe("displayQuery", () => {
  it("exports the 60 code point cap", () => {
    expect(SEARCH_QUERY_DISPLAY_MAX).toBe(60);
  });

  it("is empty for undefined, empty and blank input", () => {
    expect(displayQuery(undefined)).toBe("");
    expect(displayQuery("")).toBe("");
    expect(displayQuery(" \t\n ")).toBe("");
  });

  it("trims and collapses runs of whitespace (tabs and newlines included)", () => {
    expect(displayQuery("  seçim \t\n  erdoğan  ")).toBe("seçim erdoğan");
  });

  it("keeps a query of exactly 60 code points untouched", () => {
    const q = "b".repeat(60);
    expect(displayQuery(q)).toBe(q);
  });

  it("truncates a 61 character query to 60 code points: 59 characters plus an ellipsis", () => {
    const out = displayQuery("c".repeat(61));
    expect(Array.from(out)).toHaveLength(60);
    expect(out).toBe(`${"c".repeat(59)}…`);
  });

  it("measures the cap after trimming and collapsing whitespace", () => {
    const q = `  ${"d".repeat(30)}      ${"e".repeat(29)}  `; // 30 + 1 + 29 = 60 once collapsed
    expect(displayQuery(q)).toBe(`${"d".repeat(30)} ${"e".repeat(29)}`);
  });

  it("never splits a surrogate pair at the boundary (emoji at code point 59)", () => {
    // 58 ASCII + emoji + 5 ASCII = 64 code points; a UTF-16 slice(0, 59)
    // would cut the emoji in half and leave a lone high surrogate.
    const q = `${"a".repeat(58)}😀${"b".repeat(5)}`;
    const out = displayQuery(q);
    expect(out).toBe(`${"a".repeat(58)}😀…`);
    expect(Array.from(out)).toHaveLength(60);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("counts an emoji as one code point when deciding whether to truncate", () => {
    const q = "😀".repeat(60); // 120 UTF-16 units, 60 code points: fits
    expect(displayQuery(q)).toBe(q);
    expect(displayQuery("😀".repeat(61))).toBe(`${"😀".repeat(59)}…`);
  });

  it("returns markup verbatim", () => {
    expect(displayQuery("<b>x</b> & \"y\"")).toBe("<b>x</b> & \"y\"");
  });
});

describe("MIN_QUERY_LENGTH", () => {
  it("is 2", () => {
    expect(MIN_QUERY_LENGTH).toBe(2);
  });

  // search-query.ts is a 'use cache' server module (Supabase, next/cache), so
  // it is read as text instead of imported: the two constants must not drift,
  // or the page would announce 'at least N characters' for a number the
  // search does not actually enforce.
  it("matches the floor searchClusters enforces (src/lib/clusters/search-query.ts)", () => {
    const source = readFileSync(
      resolve(here, "../clusters/search-query.ts"),
      "utf8",
    );
    const m = /const MIN_QUERY_LENGTH = (\d+);/.exec(source);
    expect(m, "MIN_QUERY_LENGTH declaration in search-query.ts").not.toBeNull();
    expect(Number(m![1])).toBe(MIN_QUERY_LENGTH);
  });
});

describe("isTooShortQuery", () => {
  it.each(["a", " a ", "ş", "\ta\n", "9", "-"])(
    "is true for the one-character query %j",
    (q) => {
      expect(isTooShortQuery(q)).toBe(true);
    },
  );

  it.each(["ak", "a b", "--", "seçim", "Erdoğan'ın", "  ak  "])(
    "is false for %j (reaches the search floor)",
    (q) => {
      expect(isTooShortQuery(q)).toBe(false);
    },
  );

  it.each([undefined, "", "   ", "\t\n "])(
    "is false for the blank query %j (no search is not a too-short search)",
    (q) => {
      expect(isTooShortQuery(q)).toBe(false);
    },
  );

  it.each(["O'Brien", "Kur'an", "L'Oréal", "Kur\u2019an", "Ma'in"])(
    "is false for %j (an apostrophe in a name is not a suffix, h50-search-2)",
    (q) => {
      expect(isTooShortQuery(q)).toBe(false);
    },
  );

  it("still judges a one-letter name plus a Turkish suffix as too short", () => {
    expect(isTooShortQuery("a'ın")).toBe(true);
    expect(isTooShortQuery("O'")).toBe(true);
  });

  it("cleans the Unicode first: a zero-width character is no character, full-width letters count", () => {
    expect(isTooShortQuery("\u200ba")).toBe(true);
    expect(isTooShortQuery("a\u200bb")).toBe(false);
    expect(isTooShortQuery("\u200b")).toBe(true);
    expect(isTooShortQuery("Ａ")).toBe(true);
    expect(isTooShortQuery("ＡＢ")).toBe(false);
  });

  it("judges the NORMALISED query, like searchClusters does", () => {
    // A control character becomes a space and is trimmed away; an apostrophe
    // suffix after a letter is dropped: both leave a single character.
    expect(isTooShortQuery("\u0001a")).toBe(true);
    expect(isTooShortQuery("a\u0000")).toBe(true);
    expect(isTooShortQuery("a'ın")).toBe(true);
    // Whitespace inside the query still counts as one separator character.
    expect(isTooShortQuery("a\u0001b")).toBe(false);
  });
});

describe("searchStatusText: a too-short query", () => {
  it("says 'En az 2 karakter yazın.' instead of claiming there are no results", () => {
    expect(
      searchStatusText({ q: "a", count: 0, capped: false, unavailable: false }),
    ).toBe("En az 2 karakter yazın.");
    expect(
      searchStatusText({ q: " a ", count: 0, capped: false, unavailable: false }),
    ).toBe("En az 2 karakter yazın.");
  });

  it("never says 'sonuç bulunamadı' or 'yanıt vermiyor' for it", () => {
    for (const unavailable of [false, true]) {
      const text = searchStatusText({ ...base, q: "a", unavailable });
      expect(text).not.toContain("sonuç bulunamadı");
      expect(text).not.toContain("yanıt vermiyor");
    }
  });

  it("wins over a failed archive search and over a stale count", () => {
    expect(
      searchStatusText({ q: "a", count: 0, capped: false, unavailable: true }),
    ).toBe("En az 2 karakter yazın.");
    expect(
      searchStatusText({ q: "a", count: 7, capped: true, unavailable: false }),
    ).toBe("En az 2 karakter yazın.");
  });

  it("stays empty for a blank q (nothing to announce)", () => {
    expect(searchStatusText({ ...base, q: "  " })).toBe("");
  });

  it("does not touch a query that reaches the floor", () => {
    expect(searchStatusText({ ...base, q: "ak" })).toBe(
      "“ak” için sonuç bulunamadı.",
    );
    expect(searchStatusText({ ...base, q: "a b", count: 2 })).toBe(
      "“a b” için 2 sonuç bulundu.",
    );
  });
});

describe("searchTitle", () => {
  it("quotes the trimmed query and adds the 'araması' suffix (the layout adds ' — Tayf')", () => {
    expect(searchTitle("  seçim  ")).toBe("“seçim” araması");
    expect(searchTitle("seçim erdoğan")).toBe("“seçim erdoğan” araması");
  });

  it("collapses inner whitespace", () => {
    expect(searchTitle(" a   b ")).toBe("“a b” araması");
  });

  it("caps a long query at 60 code points", () => {
    const title = searchTitle("x".repeat(200));
    expect(title).toBe(`“${"x".repeat(59)}…” araması`);
  });

  it("returns a q containing markup verbatim as a plain string", () => {
    expect(searchTitle("<script>")).toBe("“<script>” araması");
  });

  it("keeps quoting a one-character query (the title is not a status claim)", () => {
    expect(searchTitle("a")).toBe("“a” araması");
  });

  it("falls back to a plain 'Arama' for a blank query rather than an empty quote pair", () => {
    expect(searchTitle("   ")).toBe("Arama");
    expect(searchTitle("")).toBe("Arama");
  });
});

// ---------------------------------------------------------------------------
// h170-roadmap-1: archive pages (?arsiv=N). The live region and the visible line name the page, not a count,
// and the title of a later page says which page it is.
// ---------------------------------------------------------------------------

describe("archivePagePhrase (h170-roadmap-1)", () => {
  it("names the page of the best matches", () => {
    expect(archivePagePhrase(2)).toBe("en ilgili sonuçların 2. sayfası");
    expect(archivePagePhrase(4)).toBe("en ilgili sonuçların 4. sayfası");
  });
});

describe("searchStatusText on a later archive page (h170-roadmap-1)", () => {
  const page = { q: "enflasyon", count: 24, capped: true, unavailable: false };

  it("says which page of the best matches is shown, whatever the count", () => {
    expect(searchStatusText({ ...page, archivePage: 2 })).toBe("“enflasyon” için en ilgili sonuçların 2. sayfası gösteriliyor.");
    expect(searchStatusText({ ...page, archivePage: 4, count: 3, capped: false })).toBe(
      "“enflasyon” için en ilgili sonuçların 4. sayfası gösteriliyor.",
    );
  });

  it("page 1, given or omitted, is today's sentence", () => {
    expect(searchStatusText({ ...page, archivePage: 1 })).toBe(searchStatusText(page));
    expect(searchStatusText(page)).toBe("“enflasyon” için en ilgili 24 sonuç gösteriliyor.");
  });

  it("an unavailable later page says so (the page, not the whole search)", () => {
    expect(searchStatusText({ ...page, archivePage: 2, unavailable: true, pageUnavailable: true })).toBe(
      "Bu sayfa şu an gösterilemiyor.",
    );
  });

  it("a plain failure on a later page is today's 'not responding' sentence", () => {
    expect(searchStatusText({ ...page, archivePage: 2, count: 0, unavailable: true })).toBe("Arama şu an yanıt vermiyor.");
  });

  it("a blank or too-short query still announces nothing or the floor, on any page", () => {
    expect(searchStatusText({ ...page, q: "", archivePage: 2 })).toBe("");
    expect(searchStatusText({ ...page, q: "a", archivePage: 2 })).toBe("En az 2 karakter yazın.");
  });

  it("quotes the query as text, never as markup", () => {
    expect(searchStatusText({ ...page, q: "<b>x</b>", archivePage: 3 })).toBe(
      "“<b>x</b>” için en ilgili sonuçların 3. sayfası gösteriliyor.",
    );
  });
});

describe("searchTitle on a later archive page (h170-roadmap-1)", () => {
  it("adds the page to the title for page 2 and later", () => {
    expect(searchTitle("enflasyon", 2)).toBe("“enflasyon” araması — 2. sayfa");
    expect(searchTitle("enflasyon", 4)).toBe("“enflasyon” araması — 4. sayfa");
  });

  it("page 1, given or omitted, is today's title", () => {
    expect(searchTitle("enflasyon", 1)).toBe("“enflasyon” araması");
    expect(searchTitle("enflasyon")).toBe("“enflasyon” araması");
  });

  it("a blank query is 'Arama' on any page", () => {
    expect(searchTitle("", 3)).toBe("Arama");
    expect(searchTitle(undefined, 2)).toBe("Arama");
  });
});
