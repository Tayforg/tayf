import { describe, expect, it } from "vitest";

import { MAX_SEARCH_TERMS, canonicalSearchQuery } from "@/lib/clusters/turkish-query";
import { ENGINE_STOP_WORDS, relaxedSearchWords } from "./relaxed-search";

// h185-roadmap2-1: the archive search ANDs every typed word, so a long question
// such as 'emekli bayram ikramiyesi ne zaman' finds nothing while each of its
// words has results. The empty-search card offers one chip per word; this is the
// pure choice of those words. canonicalSearchQuery is the only tokeniser: what
// the card offers is what the archive searched, never a second parser's idea of
// a word.

describe("relaxedSearchWords: the chips of a multi-word search", () => {
  it("offers every word of the headline example, 'ne' dropped as too short", () => {
    expect(relaxedSearchWords("emekli bayram ikramiyesi ne zaman")).toEqual([
      "emekli",
      "bayram",
      "ikramiyesi",
      "zaman",
    ]);
  });

  it("offers both words of a two-word search", () => {
    expect(relaxedSearchWords("kripto vergisi")).toEqual(["kripto", "vergisi"]);
  });

  it("lower-cases with the Turkish rules and de-duplicates, keeping typed order", () => {
    expect(relaxedSearchWords("Kripto KRİPTO para")).toEqual(["kripto", "para"]);
    expect(relaxedSearchWords("IŞIK ışık Işık hızı")).toEqual(["ışık", "hızı"]);
    expect(relaxedSearchWords("para kripto para")).toEqual(["para", "kripto"]);
  });

  it("keeps the words of a quoted phrase, without the quotes", () => {
    expect(relaxedSearchWords('"kripto para" vergisi')).toEqual(["kripto", "para", "vergisi"]);
  });

  it("strips a quote anywhere in a word, not just at its edge", () => {
    for (const q of ['"kripto para', 'kripto" para"', 'kr"ipto pa"ra"']) {
      const words = relaxedSearchWords(q);
      expect(words.length, q).toBeGreaterThan(0);
      for (const w of words) expect(w, q).not.toContain('"');
    }
    expect(relaxedSearchWords('kr"ipto para')).toEqual(["kripto", "para"]);
  });

  it("drops a negated term (a chip for '-vergi' would invert the meaning)", () => {
    expect(relaxedSearchWords("kripto -vergi")).toEqual(["kripto"]);
    expect(relaxedSearchWords("-vergi kripto para")).toEqual(["kripto", "para"]);
    expect(relaxedSearchWords("-kripto -vergi")).toEqual([]);
    expect(relaxedSearchWords('kripto -"vergi"')).toEqual(["kripto"]);
  });

  it("drops words shorter than 3 code points ('ne', 'mi')", () => {
    expect(relaxedSearchWords("okullar ne zaman açılacak mi")).toEqual(["okullar", "zaman", "açılacak"]);
    expect(relaxedSearchWords("ab abc")).toEqual(["abc"]);
  });

  it("counts code points, not UTF-16 units: an astral character is one", () => {
    // Deseret small letters (U+10428...): two UTF-16 units each, and NFKC and Turkish lower-casing leave them be.
    // Two code points (four UTF-16 units): too short, so it goes.
    expect(relaxedSearchWords("\u{10428}\u{10429} kripto")).toEqual(["kripto"]);
    // Three code points (six UTF-16 units): kept.
    expect(relaxedSearchWords("\u{10428}\u{10429}\u{1042A} kripto")).toEqual([
      "\u{10428}\u{10429}\u{1042A}",
      "kripto",
    ]);
  });

  it("returns [] when every word is too short", () => {
    expect(relaxedSearchWords("a b")).toEqual([]);
    expect(relaxedSearchWords("ne mi")).toEqual([]);
  });

  it("returns [] for a single word: there is nothing to widen", () => {
    expect(relaxedSearchWords("emekli")).toEqual([]);
    expect(relaxedSearchWords("zzqxkv")).toEqual([]);
    expect(relaxedSearchWords("  emekli  ")).toEqual([]);
    expect(relaxedSearchWords("EMEKLİ!")).toEqual([]);
  });

  it("returns [] for empty, blank and punctuation-only input", () => {
    for (const q of ["", " ", "   \t\n ", "!!", "?! ...", "\u{1F600} \u{1F600}", "- -- ---"]) {
      expect(relaxedSearchWords(q), JSON.stringify(q)).toEqual([]);
    }
  });

  it("cuts the edge punctuation of each word, as the search does", () => {
    expect(relaxedSearchWords("Erdoğan! Bahçeli?")).toEqual(["erdoğan", "bahçeli"]);
    expect(relaxedSearchWords("“kripto” (para)")).toEqual(["kripto", "para"]);
  });

  it("cuts a Turkish apostrophe suffix, as the search does", () => {
    expect(relaxedSearchWords("Erdoğan'ın Bahçeli’yi")).toEqual(["erdoğan", "bahçeli"]);
  });

  it("splits a slash between two letters into two words, as the search does", () => {
    expect(relaxedSearchWords("erdoğan/bahçeli")).toEqual(["erdoğan", "bahçeli"]);
  });

  it("offers at most MAX_SEARCH_TERMS (6) words, the ones the archive searched", () => {
    const eight = "birinci ikinci ucuncu dorduncu besinci altinci yedinci sekizinci";
    const words = relaxedSearchWords(eight);
    expect(words).toHaveLength(MAX_SEARCH_TERMS);
    expect(words).toEqual(["birinci", "ikinci", "ucuncu", "dorduncu", "besinci", "altinci"]);
  });

  it("never offers a word the 64-character cut dropped, nor a fragment of one", () => {
    const typed = Array.from({ length: 6 }, (_, i) => `${String.fromCharCode(97 + i).repeat(12)}`);
    const q = typed.join(" "); // 6 x 12 + 5 spaces = 77 characters
    const words = relaxedSearchWords(q);
    expect(words).toEqual(typed.slice(0, 5));
    // Every word is one the canonical query holds whole.
    const canonical = canonicalSearchQuery(q).split(" ");
    for (const w of words) expect(canonical).toContain(w);
  });

  it("is built from canonicalSearchQuery's terms only (no second tokeniser)", () => {
    for (const q of [
      "emekli bayram ikramiyesi ne zaman",
      "Kripto KRİPTO para",
      "Erdoğan'ın Bahçeli’yi sert eleştirdi",
      '"kripto para" vergisi',
      "kripto -vergi",
    ]) {
      const canonical = canonicalSearchQuery(q).split(" ");
      for (const w of relaxedSearchWords(q)) {
        expect(canonical.map((t) => t.split('"').join("")), q).toContain(w);
      }
    }
  });

  it("is idempotent on its own words: a chip's target is itself a canonical query", () => {
    for (const w of relaxedSearchWords("Kripto KRİPTO para vergisi yasası")) {
      expect(canonicalSearchQuery(w)).toBe(w);
    }
  });

  it("returns plain strings for markup: no HTML is produced here (React escapes at render)", () => {
    const words = relaxedSearchWords("<script>alert(1)</script> x");
    expect(Array.isArray(words)).toBe(true);
    for (const w of words) {
      expect(typeof w).toBe("string");
      expect(w).not.toContain(" ");
      expect(w).not.toContain('"');
      expect(Array.from(w).length).toBeGreaterThanOrEqual(3);
    }
    // 'x' is too short, so nothing but the one word the markup became survives.
    expect(words.length).toBeLessThanOrEqual(1);
  });

  it("returns plain words for quote, SQL and control characters too", () => {
    for (const q of ["kripto'; drop table users;-- para", "kripto\u0000 para\u0007", "kripto​ para"]) {
      const words = relaxedSearchWords(q);
      for (const w of words) {
        for (const ch of w) {
          expect(ch <= " " || ch === '"', `${JSON.stringify(q)} -> ${JSON.stringify(w)}`).toBe(false);
        }
      }
      expect(words, JSON.stringify(q)).toContain("para");
    }
  });

  it("reads only the first 6 terms of a very long query (20k words), so the cost never follows its size", () => {
    const long = Array.from({ length: 20_000 }, (_, i) => `kelime${i}`).join(" ");
    expect(relaxedSearchWords(long)).toEqual(["kelime0", "kelime1", "kelime2", "kelime3", "kelime4", "kelime5"]);
  });
});

// ts-1: the search engine's own Turkish stop words (websearch_to_tsquery('turkish', w) is empty) are not
// searched, so a chip for one would land on the same empty card.
describe("relaxedSearchWords: the engine's own stop words are never offered", () => {
  it("(a) 'kripto neden düştü' offers 'kripto' and 'düştü', not 'neden'", () => {
    expect(relaxedSearchWords("kripto neden düştü")).toEqual(["kripto", "düştü"]);
  });

  it("(b) 'emekli ile zam' offers 'emekli' and 'zam', not 'ile'", () => {
    expect(relaxedSearchWords("emekli ile zam")).toEqual(["emekli", "zam"]);
  });

  it("(c) a query of stop words only offers nothing", () => {
    expect(relaxedSearchWords("neden ile gibi")).toEqual([]);
  });

  it("(d) 'zaman' is a real lexeme ('zama'), not a stop word: the headline example keeps it", () => {
    expect(relaxedSearchWords("emekli bayram ikramiyesi ne zaman")).toEqual([
      "emekli",
      "bayram",
      "ikramiyesi",
      "zaman",
    ]);
  });

  it("(e) every stop word is skipped wherever it sits", () => {
    for (const w of ENGINE_STOP_WORDS) {
      expect(relaxedSearchWords(`kripto ${w} para`), w).toEqual(["kripto", "para"]);
      expect(relaxedSearchWords(`${w} kripto para`), w).toEqual(["kripto", "para"]);
      expect(relaxedSearchWords(`kripto para ${w}`), w).toEqual(["kripto", "para"]);
    }
  });

  it("(f) the set is exactly 51 lower-case Turkish words", () => {
    expect(ENGINE_STOP_WORDS.size).toBe(51);
    for (const w of ENGINE_STOP_WORDS) expect(w).toBe(w.toLocaleLowerCase("tr"));
  });

  it("holds the 38 stop words of 3 or more code points and the 13 shorter ones", () => {
    const long = [...ENGINE_STOP_WORDS].filter((w) => Array.from(w).length >= 3);
    const short = [...ENGINE_STOP_WORDS].filter((w) => Array.from(w).length < 3);
    expect(long).toHaveLength(38);
    expect(short.sort()).toEqual(["bu", "da", "de", "en", "ki", "mı", "mu", "mü", "ne", "o", "şu", "ve", "ya"].sort());
  });

  it("does not fold ASCII spellings: 'icin', 'nasil' and 'mi' are real lexemes to the engine", () => {
    for (const w of ["icin", "nasil", "mi", "ab", "zaman"]) expect(ENGINE_STOP_WORDS.has(w), w).toBe(false);
    expect(relaxedSearchWords("kripto icin para")).toEqual(["kripto", "icin", "para"]);
    expect(relaxedSearchWords("kripto nasil para")).toEqual(["kripto", "nasil", "para"]);
  });

  it("matches the stop word on the Turkish-lower-cased term (an upper-case 'NEDEN', a dotted 'İLE')", () => {
    expect(relaxedSearchWords("KRİPTO NEDEN DÜŞTÜ")).toEqual(["kripto", "düştü"]);
    expect(relaxedSearchWords("EMEKLİ İLE ZAM")).toEqual(["emekli", "zam"]);
  });

  it("matches a stop word inside a quoted phrase, after the quotes are stripped", () => {
    expect(relaxedSearchWords('"kripto neden düştü"')).toEqual(["kripto", "düştü"]);
  });
});

// ts-3: a quoted '-' term is still a negation to the engine, so it is dropped like an unquoted one.
describe("relaxedSearchWords: a quoted negation is dropped", () => {
  it("'\"-vergi\" kripto' -> ['kripto']", () => {
    expect(relaxedSearchWords('"-vergi" kripto')).toEqual(["kripto"]);
  });

  it("'kripto \"-vergi\"' -> ['kripto']", () => {
    expect(relaxedSearchWords('kripto "-vergi"')).toEqual(["kripto"]);
  });

  it("no offered word ever starts with '-', however the negation is quoted", () => {
    for (const q of ["kripto -vergi", '"-vergi" kripto para', 'kripto "-vergi" para', '-"vergi" kripto']) {
      const words = relaxedSearchWords(q);
      expect(words.length, q).toBeGreaterThan(0);
      for (const w of words) expect(w.startsWith("-"), `${q} -> ${w}`).toBe(false);
      expect(words, q).not.toContain("vergi");
    }
  });

  it("keeps the existing unquoted-and-quoted case 'kripto -\"vergi\"' -> ['kripto']", () => {
    expect(relaxedSearchWords('kripto -"vergi"')).toEqual(["kripto"]);
  });

  it("a lone quote is no word and no widening: it is skipped quietly", () => {
    expect(relaxedSearchWords('kripto "')).toEqual([]);
    expect(relaxedSearchWords('" "')).toEqual([]);
    expect(relaxedSearchWords('kripto " para')).toEqual(["kripto", "para"]);
  });
});

// ts-4: one chip is kept only when it widens the search. A lone survivor of stop words or repeats runs the
// same search as the card that was just shown.
describe("relaxedSearchWords: a lone chip is kept only when it widens the search", () => {
  it("'zzqxkv ne' -> []: 'ne' is an engine stop word, so 'zzqxkv' alone is the same search", () => {
    expect(relaxedSearchWords("zzqxkv ne")).toEqual([]);
  });

  it("'kripto ne' -> []", () => {
    expect(relaxedSearchWords("kripto ne")).toEqual([]);
  });

  it("'Kripto KRİPTO' -> []: only repeats", () => {
    expect(relaxedSearchWords("Kripto KRİPTO")).toEqual([]);
  });

  it("'kripto mi' -> ['kripto']: 'mi' is a real lexeme, dropping it widens the search", () => {
    expect(relaxedSearchWords("kripto mi")).toEqual(["kripto"]);
  });

  it("'kripto ab' -> ['kripto']: a short non-stop word was applied by the archive", () => {
    expect(relaxedSearchWords("kripto ab")).toEqual(["kripto"]);
  });

  it("'kripto -vergi' -> ['kripto']: a dropped negation widens the search", () => {
    expect(relaxedSearchWords("kripto -vergi")).toEqual(["kripto"]);
  });

  it("a stop word next to a short non-stop word still widens: 'kripto ne mi' -> ['kripto']", () => {
    expect(relaxedSearchWords("kripto ne mi")).toEqual(["kripto"]);
  });

  it("two or more survivors are always offered, stop words or not", () => {
    expect(relaxedSearchWords("kripto ne para")).toEqual(["kripto", "para"]);
    expect(relaxedSearchWords("kripto kripto para")).toEqual(["kripto", "para"]);
  });
});
