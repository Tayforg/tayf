import { describe, it, expect } from "vitest";

import { RISING_FOLD_FROM, RISING_FOLD_TO } from "@/lib/trends/rising-entities";
import { expectLinear, rep } from "../../../tests/_helpers/linear-time";
import {
  MAX_QUERY_VARIANTS,
  MAX_SEARCH_QUERY_LENGTH,
  MAX_SEARCH_TERMS,
  SEARCH_FOLD_FROM,
  SEARCH_FOLD_TO,
  GEMINATE_ROOTS,
  canonicalSearchQuery,
  cleanQueryUnicode,
  foldTr,
  holdsLocativeWitness,
  isTurkishSuffixTail,
  normaliseSearchQuery,
  pgLower,
  searchFoldedSibling,
  searchFoldedSiblingParts,
  searchQueryCut,
  searchQueryCutsWord,
  searchQueryWasShortened,
  searchSiblingQuery,
  searchedWordsAsTyped,
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

// ---------------------------------------------------------------------------
// canonicalSearchQuery: the cache key and RPC input of the home search
// (h30-abuse-1). One key per case/punctuation family, bounded in size, and
// deliberately NOT Turkish-folded (see turkish-query.ts for why).
// ---------------------------------------------------------------------------

/** True when `s` holds a UTF-16 surrogate that is not half of a valid pair (code-unit scan). */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("canonicalSearchQuery", () => {
  it("exports the caps: 6 terms, 64 characters", () => {
    expect(MAX_SEARCH_TERMS).toBe(6);
    expect(MAX_SEARCH_QUERY_LENGTH).toBe(64);
  });

  it.each([
    "Erdoğan",
    "ERDOĞAN!",
    " erdoğan ",
    "erdoğan.",
    "\u201cErdoğan\u201d",
    "Erdoğan\u2019ın",
    "\u00bfErdoğan?",
  ])("%j has the canonical key 'erdoğan'", (q) => {
    expect(canonicalSearchQuery(q)).toBe("erdoğan");
  });

  it("keeps the ASCII spelling apart from the Turkish one (their results differ today)", () => {
    expect(canonicalSearchQuery("ERDOGAN")).toBe("erdogan");
    expect(canonicalSearchQuery("erdogan")).not.toBe(canonicalSearchQuery("erdoğan"));
  });

  it("lower-cases with Turkish rules: IŞIK, Işık and ışık share the key 'ışık'", () => {
    for (const q of ["IŞIK", "Işık", "ışık"]) {
      expect(canonicalSearchQuery(q)).toBe("ışık");
    }
  });

  it("does not fold Turkish letters to ASCII", () => {
    expect(canonicalSearchQuery("Şişli")).toBe("şişli");
    expect(canonicalSearchQuery("ÇAĞRI")).toBe("çağrı");
  });

  it("keeps the double quotes of a phrase search", () => {
    expect(canonicalSearchQuery('"Devlet Bahçeli"')).toBe('"devlet bahçeli"');
  });

  it("keeps a leading '-' (negation) and a trailing quote", () => {
    expect(canonicalSearchQuery("-chp seçim")).toBe("-chp seçim");
    expect(canonicalSearchQuery("seçim -CHP")).toBe("seçim -chp");
  });

  it("strips punctuation at the edge of every term, not only of the query", () => {
    expect(canonicalSearchQuery("a, b; c")).toBe("a b c");
    expect(canonicalSearchQuery("(deprem) [son] {dakika}")).toBe("deprem son dakika");
  });

  it("keeps punctuation inside a term", () => {
    expect(canonicalSearchQuery("ak-parti")).toBe("ak-parti");
    expect(canonicalSearchQuery("1.5 milyon")).toBe("1.5 milyon");
    expect(canonicalSearchQuery("a.b")).toBe("a.b");
  });

  it("strips symbols (\\p{S}) at the edges too, emoji included", () => {
    expect(canonicalSearchQuery("$dolar")).toBe("dolar");
    expect(canonicalSearchQuery("\u{1F525}deprem\u{1F525}")).toBe("deprem");
  });

  it("a query of punctuation only is ''", () => {
    expect(canonicalSearchQuery("!!!")).toBe("");
    expect(canonicalSearchQuery("!!")).toBe("");
    expect(canonicalSearchQuery("\u201c\u201d")).toBe("");
    expect(canonicalSearchQuery("... ,,, ;;;")).toBe("");
    expect(canonicalSearchQuery("\u{1F600}\u{1F600}")).toBe("");
  });

  it("empty, whitespace-only and control-only input is ''", () => {
    expect(canonicalSearchQuery("")).toBe("");
    expect(canonicalSearchQuery("   ")).toBe("");
    expect(canonicalSearchQuery("\u0000\u0001")).toBe("");
  });

  it("applies the existing normalisation first (control chars, apostrophe suffix, whitespace)", () => {
    expect(canonicalSearchQuery("a\u0000b")).toBe("a b");
    expect(canonicalSearchQuery("Özel'den   Bahçeli\u2019nin sözleri")).toBe("özel bahçeli sözleri");
  });

  it("a 40-term query keeps exactly 6 terms", () => {
    const q = Array.from({ length: 40 }, (_, i) => `kelime${i}`).join(" ");
    const out = canonicalSearchQuery(q);
    expect(out.split(" ")).toEqual([
      "kelime0",
      "kelime1",
      "kelime2",
      "kelime3",
      "kelime4",
      "kelime5",
    ]);
  });

  it("terms that are only punctuation do not use up one of the 6 slots", () => {
    const q = "! a ? b , c ; d . e : f + g h";
    expect(canonicalSearchQuery(q)).toBe("a b c d e f");
  });

  it("a 500-character single token is cut to 64 characters", () => {
    const out = canonicalSearchQuery("a".repeat(500));
    expect(out).toHaveLength(MAX_SEARCH_QUERY_LENGTH);
    expect(out).toBe("a".repeat(64));
  });

  it("never exceeds 64 characters for any input shape", () => {
    for (const q of [
      "ab ".repeat(300),
      "\u015f".repeat(500),
      "x-".repeat(200),
      ("kelime ").repeat(6) + "z".repeat(100),
    ]) {
      expect(canonicalSearchQuery(q).length, q.slice(0, 20)).toBeLessThanOrEqual(64);
    }
  });

  it("an emoji straddling the 64-character boundary leaves no lone surrogate", () => {
    // 63 letters, then an emoji (two code units) and a letter: the cut at 64
    // lands between the surrogates.
    const cut = canonicalSearchQuery("a".repeat(63) + "\u{1F600}" + "b");
    expect(hasLoneSurrogate(cut)).toBe(false);
    expect(cut).toBe("a".repeat(63));
    // The emoji still fits whole here (62 + 2 = 64).
    const fits = canonicalSearchQuery("a".repeat(62) + "\u{1F600}" + "b");
    expect(hasLoneSurrogate(fits)).toBe(false);
    expect(fits.length).toBeLessThanOrEqual(64);
    // And with an emoji in every position of a long run.
    for (let pad = 55; pad <= 64; pad++) {
      const out = canonicalSearchQuery("a".repeat(pad) + "\u{1F600}".repeat(5) + "b");
      expect(hasLoneSurrogate(out), `pad ${pad}`).toBe(false);
      expect(out.length, `pad ${pad}`).toBeLessThanOrEqual(64);
    }
  });

  it("a lone surrogate in the input never reaches the key", () => {
    expect(hasLoneSurrogate(canonicalSearchQuery("a\ud83db"))).toBe(false);
    expect(hasLoneSurrogate(canonicalSearchQuery("a\udc00b"))).toBe(false);
  });

  it("is idempotent over every fixture", () => {
    const fixtures = [
      "Erdoğan",
      "ERDOĞAN!",
      " erdoğan ",
      "\u201cErdoğan\u201d",
      "Erdoğan\u2019ın açıklaması",
      "IŞIK",
      "İstanbul",
      '"Devlet Bahçeli"',
      "-chp seçim",
      "a, b; c",
      "!!!",
      "",
      "a",
      "ab",
      Array.from({ length: 40 }, (_, i) => `kelime${i}`).join(" "),
      "a".repeat(500),
      // The 64-character cut can leave punctuation at the end: it is stripped
      // again, so a second pass finds nothing left to do.
      "a".repeat(63) + ".b",
      "a".repeat(62) + "\u{1F600}b",
      "a".repeat(63) + "\u{1F600}b",
      "x ".repeat(100),
    ];
    for (const q of fixtures) {
      const once = canonicalSearchQuery(q);
      expect(canonicalSearchQuery(once), JSON.stringify(q.slice(0, 30))).toBe(once);
    }
  });

  it("is idempotent, bounded and surrogate-safe over 3000 seeded random queries", () => {
    // Small deterministic PRNG (mulberry32): the same inputs on every run.
    let state = 0x9e3779b9;
    const next = () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // h145 review TS-3: the slash, backslash, bar and apostrophe are in the alphabet. An apostrophe that
    // ends a word ("Erdoğan'/Bahçeli") is cut by normaliseSearchQuery AFTER the slash was looked at, so the
    // slash used to sit between two letters only in the output and a second pass split it.
    const alphabet = [
      "a", "b", "z", "I", "İ", "ı", "ş", "Ğ", "1", " ", " ", " ", ".", ",", "!", "?",
      "“", "-", '"', "(", ")", "$", "\u{1F600}", "\u{1F525}", "\u0000", "\ud83d", "\t",
      "/", "\\", "|", "'", "/", "'",
    ];
    for (let n = 0; n < 3000; n++) {
      const len = Math.floor(next() * 140);
      let q = "";
      for (let i = 0; i < len; i++) q += alphabet[Math.floor(next() * alphabet.length)]!;
      const once = canonicalSearchQuery(q);
      const label = JSON.stringify(q);
      expect(canonicalSearchQuery(once), label).toBe(once);
      expect(once.length, label).toBeLessThanOrEqual(MAX_SEARCH_QUERY_LENGTH);
      expect(once.split(" ").filter(Boolean).length, label).toBeLessThanOrEqual(MAX_SEARCH_TERMS);
      expect(hasLoneSurrogate(once), label).toBe(false);
      expect(once, label).toBe(once.trim());
    }
  });

  describe("parity with the uncanonicalised query (the RPC args stay byte-identical)", () => {
    const parity = [
      "IŞIK",
      "Işık",
      "ışık",
      "İstanbul",
      "ISTANBUL",
      "istanbul",
      "Erdoğan",
      "ERDOĞAN",
      "ÇAĞRI",
      "Çağrı",
      "Şişli",
      "ŞİŞLİ",
      "Devlet BAHÇELİ",
    ];

    it.each(parity)("%s: same p_variants and same p_folded", (x) => {
      const canonical = canonicalSearchQuery(x);
      const normalised = normaliseSearchQuery(x);
      expect(turkishQueryVariants(canonical)).toEqual(turkishQueryVariants(normalised));
      expect(foldTr(canonical)).toBe(foldTr(normalised));
    });
  });

  it("is linear: 100k characters of alternating '!a' finish at once", () => {
    const started = performance.now();
    const out = canonicalSearchQuery("!a".repeat(50_000));
    const elapsedMs = performance.now() - started;
    expect(out.length).toBeLessThanOrEqual(MAX_SEARCH_QUERY_LENGTH);
    expect(out.startsWith("a!a")).toBe(true);
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("is linear: 100k punctuation characters and 100k spaces finish at once", () => {
    const started = performance.now();
    expect(canonicalSearchQuery("!".repeat(100_000))).toBe("");
    expect(canonicalSearchQuery("a ".repeat(50_000))).toBe("a a a a a a");
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

// ---------------------------------------------------------------------------
// h42-search-2: the 6-term / 64-character cap is a deliberate cost bound, but a
// reader who typed 7 words used to get results for 6 of them under a heading that
// claimed all 7. searchQueryWasShortened says when the cap changed the search.
// ---------------------------------------------------------------------------

describe("searchQueryWasShortened", () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `kelime${i + 1}`).join(" ");

  it("is false for 6 terms and true for 7", () => {
    expect(searchQueryWasShortened(words(6))).toBe(false);
    expect(searchQueryWasShortened(words(7))).toBe(true);
    expect(searchQueryWasShortened(words(40))).toBe(true);
  });

  it("is false for short, empty and blank queries", () => {
    for (const q of ["", "   ", "\t\n", "erdoğan", "Erdoğan Cumhurbaşkanı", "a"]) {
      expect(searchQueryWasShortened(q), JSON.stringify(q)).toBe(false);
    }
  });

  it("is true for a 70-character 3-term query (the length cap, not the term cap)", () => {
    const q = `${"a".repeat(23)} ${"b".repeat(23)} ${"c".repeat(22)}`;
    expect(q).toHaveLength(70);
    expect(q.split(" ")).toHaveLength(3);
    expect(searchQueryWasShortened(q)).toBe(true);
  });

  it("is true for a 300-character single term", () => {
    expect(searchQueryWasShortened("a".repeat(300))).toBe(true);
  });

  it("treats exactly MAX_SEARCH_QUERY_LENGTH characters as whole and one more as cut", () => {
    expect(searchQueryWasShortened("a".repeat(MAX_SEARCH_QUERY_LENGTH))).toBe(false);
    expect(searchQueryWasShortened("a".repeat(MAX_SEARCH_QUERY_LENGTH + 1))).toBe(true);
    // 6 terms that add up to exactly 64 characters with their spaces.
    const sixAt64 = ["a".repeat(10), "b".repeat(10), "c".repeat(10), "d".repeat(10), "e".repeat(10), "f".repeat(9)].join(" ");
    expect(sixAt64).toHaveLength(64);
    expect(searchQueryWasShortened(sixAt64)).toBe(false);
    expect(searchQueryWasShortened(`${sixAt64}x`)).toBe(true);
  });

  it("gives false for the canonical output passed back in", () => {
    const inputs = [
      words(7),
      words(40),
      `${"a".repeat(23)} ${"b".repeat(23)} ${"c".repeat(22)}`,
      "a".repeat(300),
      "a".repeat(63) + "\u{1F600}" + "b",
      "ERDOĞAN! " + words(9),
    ];
    for (const q of inputs) {
      expect(searchQueryWasShortened(q), q.slice(0, 20)).toBe(true);
      expect(searchQueryWasShortened(canonicalSearchQuery(q)), q.slice(0, 20)).toBe(false);
    }
  });

  it("counts a term only when something is left of it after the cleaning", () => {
    // Six words plus bare punctuation, emoji and a control character: still six terms.
    expect(searchQueryWasShortened(`${words(6)} !!! ?? \u{1F600} \u0000 “”`)).toBe(false);
    // The apostrophe suffix is cut and the case is folded, so this is still 7 terms.
    expect(searchQueryWasShortened("Erdoğan'ın Özel'in a1 b2 c3 d4 e5")).toBe(true);
    // Edge punctuation does not make a term longer for the length check.
    expect(searchQueryWasShortened("(a) (b) (c) (d) (e) (f)")).toBe(false);
  });

  it("is linear: 100k characters finish at once", () => {
    const started = performance.now();
    expect(searchQueryWasShortened("a ".repeat(50_000))).toBe(true);
    expect(searchQueryWasShortened("! ".repeat(50_000))).toBe(false);
    expect(searchQueryWasShortened("!a".repeat(50_000))).toBe(true);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("searchQueryCut", () => {
  it("is null when nothing was cut", () => {
    expect(searchQueryCut("erdoğan")).toBeNull();
    expect(searchQueryCut("a b c d e f")).toBeNull();
    expect(searchQueryCut("")).toBeNull();
  });

  it("says 'terms' when only the term cap applied", () => {
    expect(searchQueryCut("a b c d e f g")).toBe("terms");
  });

  it("says 'length' when the 64-character cap applied, even with fewer than 6 terms", () => {
    expect(searchQueryCut(`${"a".repeat(23)} ${"b".repeat(23)} ${"c".repeat(22)}`)).toBe("length");
    expect(searchQueryCut("a".repeat(300))).toBe("length");
  });

  it("prefers 'length' when both caps apply (the tighter bound is the true one)", () => {
    expect(searchQueryCut(`${"a".repeat(30)} ${"b".repeat(30)} c d e f g h`)).toBe("length");
  });

  it("agrees with searchQueryWasShortened", () => {
    for (const q of ["", "x", "a b c d e f", "a b c d e f g", "a".repeat(80)]) {
      expect(searchQueryWasShortened(q)).toBe(searchQueryCut(q) !== null);
    }
  });
});

// h145 review TS-5: the page words the 64-character cut as "the words that fit". That is wrong for a single
// word longer than the bound, whose first 64 characters are searched as a fragment of one word.
describe("searchQueryCutsWord", () => {
  it("is true for a single word longer than the bound: a fragment of it is searched", () => {
    expect(searchQueryCutsWord("a".repeat(300))).toBe(true);
    expect(searchQueryCutsWord("a".repeat(65))).toBe(true);
    expect(canonicalSearchQuery("a".repeat(300))).toBe("a".repeat(64));
    // Still true when other words follow: the first one is the cut term, nothing before it to fall back to.
    expect(searchQueryCutsWord(`${"a".repeat(70)} bb`)).toBe(true);
    expect(canonicalSearchQuery(`${"a".repeat(70)} bb`)).toBe("a".repeat(64));
  });

  it("is false for a 3-word query of 70 characters: whole words are dropped, none is cut", () => {
    const q = `${"a".repeat(23)} ${"b".repeat(23)} ${"c".repeat(22)}`;
    expect(q).toHaveLength(70);
    expect(searchQueryCut(q)).toBe("length");
    expect(searchQueryCutsWord(q)).toBe(false);
  });

  it("is false when the first word is kept whole: 40 + 40 letters", () => {
    expect(searchQueryCutsWord(`${"a".repeat(40)} ${"b".repeat(40)}`)).toBe(false);
    expect(canonicalSearchQuery(`${"a".repeat(40)} ${"b".repeat(40)}`)).toBe("a".repeat(40));
  });

  it("is false for a first word of exactly the bound, and for a word one short of it", () => {
    expect(searchQueryCutsWord("a".repeat(MAX_SEARCH_QUERY_LENGTH))).toBe(false);
    expect(searchQueryCutsWord(`${"a".repeat(MAX_SEARCH_QUERY_LENGTH)} bb`)).toBe(false);
    expect(searchQueryCutsWord("a".repeat(MAX_SEARCH_QUERY_LENGTH - 1))).toBe(false);
  });

  it("is false for a short query, an empty query and a query of bare punctuation", () => {
    expect(searchQueryCutsWord("deprem")).toBe(false);
    expect(searchQueryCutsWord("a".repeat(40))).toBe(false);
    expect(searchQueryCutsWord("")).toBe(false);
    expect(searchQueryCutsWord("   ")).toBe(false);
    expect(searchQueryCutsWord("!!! ???")).toBe(false);
  });

  it("reads the first TERM, so leading punctuation and apostrophe suffixes do not count", () => {
    expect(searchQueryCutsWord(`!!! ${"a".repeat(300)}`)).toBe(true);
    expect(searchQueryCutsWord(`${"a".repeat(60)}'ın bb`)).toBe(false);
  });

  it("agrees with the single-term cut of canonicalSearchQuery on every length around the bound", () => {
    for (const n of [1, 30, 63, 64, 65, 66, 100, 1000]) {
      const q = "a".repeat(n);
      const cutsWord = canonicalSearchQuery(q).length < n;
      expect(searchQueryCutsWord(q), `n=${n}`).toBe(cutsWord);
    }
  });

  it("is linear in a long input (CPU-time ladder)", () => {
    expectLinear(
      (n) => ({ one: rep("a", "", "")(n), many: rep("ab ", "", "c")(n) }),
      (q) => {
        searchQueryCutsWord(q.one);
        searchQueryCutsWord(q.many);
      },
      { n: 200_000, ceilingMs: 8_000 },
    );
  });
});

describe("searchedWordsAsTyped", () => {
  it("returns the first 6 words with the reader's own casing and punctuation", () => {
    expect(searchedWordsAsTyped("Erdoğan! Özel, Bahçeli (Akşener) Kılıçdaroğlu İmamoğlu zebra")).toBe(
      "Erdoğan! Özel, Bahçeli (Akşener) Kılıçdaroğlu İmamoğlu",
    );
  });

  it("returns the whole query when there are 6 words or fewer", () => {
    expect(searchedWordsAsTyped("Erdoğan Özel")).toBe("Erdoğan Özel");
    expect(searchedWordsAsTyped("")).toBe("");
  });

  it("collapses whitespace and skips terms that are only punctuation, like the search does", () => {
    expect(searchedWordsAsTyped("  a   b !!! c \u{1F600} d  e f g ")).toBe("a b c d e f");
  });

  it("keeps the words in step with the canonical query", () => {
    const q = "ERDOĞAN'ın  Özel!  a1 b2 c3 d4 e5 f6";
    const typed = searchedWordsAsTyped(q);
    expect(typed.split(" ")).toHaveLength(MAX_SEARCH_TERMS);
    expect(canonicalSearchQuery(typed)).toBe(canonicalSearchQuery(q));
  });
});

describe("canonicalSearchQuery keeps its output while sharing the term walk", () => {
  it.each([
    ["Erdoğan'ın  Özel'den", "erdoğan özel"],
    ["  ERDOĞAN!  ", "erdoğan"],
    ["a b c d e f g h", "a b c d e f"],
    ["!!! a ??? b", "a b"],
    ['"Ak Parti" -CHP', '"ak parti" -chp'],
  ])("%j -> %j", (input, expected) => {
    expect(canonicalSearchQuery(input)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// h50-search-2: three inputs the cleanup used to misread.
//   1. a dash BETWEEN words ('Erdoğan - Bahçeli', 'trump <-> iran') is a
//      separator, not websearch's NOT;
//   2. an apostrophe is cut only before a Turkish case or possessive suffix, so
//      Kur'an, O'Brien and L'Oréal keep their name;
//   3. NFD, zero-width and full-width input gets the same fold as NFC input.
// ---------------------------------------------------------------------------

describe("canonicalSearchQuery: a dash between words is a separator (h50-search-2)", () => {
  it.each([
    ["Erdoğan - Bahçeli", "erdoğan bahçeli"],
    ["trump <-> iran", "trump iran"],
    ["a — b", "a b"],
    ["a – b", "a b"],
    ["a -- b", "a b"],
    ["a ‐ b", "a b"],
    ["a − b", "a b"],
    ["a － b", "a b"],
    ["a -> b", "a b"],
    ["a <- b", "a b"],
    ["- - -", ""],
    ["a - ", "a"],
    ['"devlet - bahçeli"', '"devlet bahçeli"'],
  ])("%j -> %j", (input, expected) => {
    expect(canonicalSearchQuery(input)).toBe(expected);
  });

  it("an attached '-word' still negates", () => {
    expect(canonicalSearchQuery("erdoğan -bahçeli")).toBe("erdoğan -bahçeli");
    expect(canonicalSearchQuery("-chp seçim")).toBe("-chp seçim");
    expect(canonicalSearchQuery("-trump")).toBe("-trump");
  });

  it("a separator dash does not use up one of the 6 term slots", () => {
    expect(canonicalSearchQuery("a - b - c - d - e - f - g")).toBe("a b c d e f");
    expect(searchQueryCut("a - b - c - d - e - f")).toBeNull();
    expect(searchQueryWasShortened("a - b - c - d - e - f")).toBe(false);
    expect(searchQueryCut("a - b - c - d - e - f - g")).toBe("terms");
  });

  it("searchedWordsAsTyped skips the separator like the search does", () => {
    expect(searchedWordsAsTyped("Erdoğan - Bahçeli")).toBe("Erdoğan Bahçeli");
  });

  it("keeps a hyphen inside a word", () => {
    expect(canonicalSearchQuery("ak-parti - chp")).toBe("ak-parti chp");
  });
});

describe("isTurkishSuffixTail (h50-search-2)", () => {
  it.each([
    "ın", "in", "un", "ün", "nın", "nin", "nun", "nün",
    "a", "e", "ya", "ye", "na", "ne",
    "ı", "i", "u", "ü", "yı", "yi", "yu", "yü", "nı", "ni", "nu", "nü",
    "da", "de", "ta", "te", "dan", "den", "tan", "ten", "daki", "deki",
    "nda", "nde", "ndan", "nden", "ndaki",
    "la", "le", "yla", "yle",
    "lar", "ler", "ları", "leri", "ların", "lerin", "lardan", "lerden", "liler", "lılar",
    "li", "lı", "lu", "lü",
    "ında", "inde", "ının", "inin", "ımız", "imizin",
    "ca", "ce", "ça", "çe", "dır", "dir", "tur", "tür",
    "si", "sı", "su", "sü", "sın", "sin",
    "cü", "ci", "cı", "çi", "cüler", "ciler", "dekiler", "dakiler", "ndekiler",
  ])("%s is a Turkish suffix tail", (tail) => {
    expect(isTurkishSuffixTail(tail)).toBe(true);
  });

  it.each(["IN", "NİN", "DEN", "LİLER", "İN", "DEKI", "NDAKI", "DEKILER"])("matches upper case with the Turkish rules: %s", (tail) => {
    expect(isTurkishSuffixTail(tail)).toBe(true);
  });

  it.each([
    "an", "brien", "oréal", "neil", "angelo", "hara", "leary", "id", "ba", "min", "golo", "roll", "x", "z",
  ])("%s is not", (tail) => {
    expect(isTurkishSuffixTail(tail)).toBe(false);
  });

  it("is false for the empty tail (the caller drops a dangling apostrophe itself)", () => {
    expect(isTurkishSuffixTail("")).toBe(false);
  });

  it("checks the length first: a 12-letter tail can match, a 13-letter one cannot", () => {
    expect(isTurkishSuffixTail("larlarlarlar")).toBe(true);
    expect("larlarlarlar").toHaveLength(12);
    expect(isTurkishSuffixTail("larlarlarlarl")).toBe(false);
    expect(isTurkishSuffixTail(`la${"r".repeat(100_000)}`)).toBe(false);
  });
});

describe("apostrophes: only a Turkish suffix is cut (h50-search-2)", () => {
  it.each([
    ["Kur'an", "kur'an"],
    ["O'Brien", "o'brien"],
    ["L'Oréal", "l'oréal"],
    ["Kur’an", "kur’an"],
    ["D'Angelo", "d'angelo"],
    ["Qur'an", "qur'an"],
  ])("keeps the name whole: %j -> %j", (input, expected) => {
    expect(canonicalSearchQuery(input)).toBe(expected);
  });

  it.each([
    "Erdoğan'ın",
    "Erdoğan’dan",
    "Özel'den",
    "Bahçeli'nin",
    "İmamoğlu'na",
    "Türkiye'deki",
    "AKP'nin",
    "CHP'liler",
    "Putin'le",
    "Sezai'yi",
    "İstanbul'u",
    "Kılıçdaroğlu'ndan",
    "Gazze'ye",
    "İsrail'in",
    "FETÖ'cüler",
    "AKP'ci",
    "CHP'ciler",
    "Türkiye'dekiler",
    "İstanbul'dakiler",
  ])("cuts the suffix of %j", (input) => {
    const name = canonicalSearchQuery(input);
    expect(name).not.toMatch(/['’]/);
    expect(name).toBe(
      input.split(/['’]/)[0]!.toLocaleLowerCase("tr"),
    );
  });

  it("gives the bare lower-cased name for the listed suffixed forms", () => {
    expect(canonicalSearchQuery("Erdoğan'ın")).toBe("erdoğan");
    expect(canonicalSearchQuery("Kılıçdaroğlu'ndan")).toBe("kılıçdaroğlu");
    expect(canonicalSearchQuery("İmamoğlu'nu")).toBe("imamoğlu");
    expect(canonicalSearchQuery("CHP'liler")).toBe("chp");
  });

  it("cuts only the last suffix of a name that carries an apostrophe itself", () => {
    expect(canonicalSearchQuery("Kur'an'ın")).toBe("kur'an");
    expect(canonicalSearchQuery("O'Brien'a")).toBe("o'brien");
  });

  it("reads the tail in upper case and in ASCII spelling", () => {
    expect(canonicalSearchQuery("ERDOĞAN'IN")).toBe("erdoğan");
    expect(canonicalSearchQuery("AKP'NİN")).toBe("akp");
    expect(canonicalSearchQuery("Erdogan'in")).toBe("erdogan");
    expect(canonicalSearchQuery("Turkiye'deki")).toBe("turkiye");
  });

  it("reads the relative 'ki' after Turkish upper-casing: ASCII 'KI' lower-cases to 'kı' and is still cut", () => {
    expect(canonicalSearchQuery("ABD'DEKI")).toBe("abd");
    expect(canonicalSearchQuery("ANKARA'DAKI")).toBe("ankara");
    expect(canonicalSearchQuery("ABD'DEKILER")).toBe("abd");
  });

  it("still drops a dangling apostrophe after a letter", () => {
    expect(normaliseSearchQuery("Erdoğan'")).toBe("Erdoğan");
    expect(normaliseSearchQuery("Erdoğan''")).toBe("Erdoğan");
    expect(canonicalSearchQuery("Erdoğan'")).toBe("erdoğan");
  });

  it("normaliseSearchQuery keeps a non-suffix tail and cuts a suffix tail", () => {
    expect(normaliseSearchQuery("Kur'an")).toBe("Kur'an");
    expect(normaliseSearchQuery("O'Brien")).toBe("O'Brien");
    expect(normaliseSearchQuery("L’Oréal")).toBe("L’Oréal");
    expect(normaliseSearchQuery("Kur'an'ın")).toBe("Kur'an");
    expect(normaliseSearchQuery("Özel'den Kur'an")).toBe("Özel Kur'an");
  });

  it("the RPC arguments for a kept apostrophe equal those of the uncanonicalised query", () => {
    for (const x of ["Kur'an", "O'Brien", "L'Oréal"]) {
      const canonical = canonicalSearchQuery(x);
      const normalised = normaliseSearchQuery(x);
      expect(turkishQueryVariants(canonical), x).toEqual(turkishQueryVariants(normalised));
      expect(foldTr(canonical), x).toBe(foldTr(normalised));
    }
  });

  it("a stacked apostrophe run is cut or kept as one unit, so a second pass changes nothing", () => {
    for (const q of ["ş''z", "ş'''z", "a''ın", "a'ın'ın", "x'a'b", "x'a'ın", "ab'ın-'a", "kur''an"]) {
      const once = canonicalSearchQuery(q);
      expect(canonicalSearchQuery(once), JSON.stringify(q)).toBe(once);
    }
  });

  it("the 64-character cut cannot leave a suffix tail behind (a second pass would cut it)", () => {
    // 'daxyz' is not a suffix, but the cut at 64 characters keeps only 'da'.
    const q = `${"a".repeat(61)}'daxyz`;
    const once = canonicalSearchQuery(q);
    expect(once).toBe("a".repeat(61));
    expect(canonicalSearchQuery(once)).toBe(once);
  });

  it("the 64-character cut cannot leave a lone '-' behind (it would be a separator next time)", () => {
    // h144-search-3: the partial '-bahçeli' is now dropped whole (more than one term is kept), so no
    // fragment of it, not even a lone '-', reaches the key. The idempotence assertion stays.
    const q = `${"a".repeat(62)} -bahçeli`;
    const once = canonicalSearchQuery(q);
    expect(once).toBe("a".repeat(62));
    expect(canonicalSearchQuery(once)).toBe(once);
    // A single term of 64 dashes and more is the one cut that can still end in a lone '-'.
    const dashes = canonicalSearchQuery(`${"-".repeat(64)}abc`);
    expect(canonicalSearchQuery(dashes)).toBe(dashes);
  });

  it("is linear on the shapes that make a backtracking regex quadratic", () => {
    const started = performance.now();
    canonicalSearchQuery(`a${"'".repeat(100_000)}!`);
    canonicalSearchQuery(`a'${"b".repeat(100_000)}`);
    canonicalSearchQuery("a'ın".repeat(30_000));
    canonicalSearchQuery("'".repeat(100_000));
    canonicalSearchQuery(`a${"'ın".repeat(30_000)}`);
    normaliseSearchQuery(`a${"'".repeat(100_000)}!`);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("Unicode: NFD, zero-width and full-width input gets the NFC fold (h50-search-2)", () => {
  const NFD_SISLI = "şişli";

  it("an NFD 'şişli' has the same key as the NFC one, and folds to 'sisli'", () => {
    expect(NFD_SISLI).not.toBe("şişli");
    expect(canonicalSearchQuery(NFD_SISLI)).toBe("şişli");
    expect(canonicalSearchQuery("şişli")).toBe("şişli");
    expect(foldTr(canonicalSearchQuery(NFD_SISLI))).toBe("sisli");
    expect(normaliseSearchQuery(NFD_SISLI)).toBe("şişli");
  });

  it("'erdoğan' is unchanged, NFC or NFD", () => {
    expect(canonicalSearchQuery("erdoğan")).toBe("erdoğan");
    expect(canonicalSearchQuery("erdoğan")).toBe("erdoğan");
  });

  it("an NFD dotted capital I ends up as the same key as İ", () => {
    expect(canonicalSearchQuery("İstanbul")).toBe(canonicalSearchQuery("İstanbul"));
    expect(canonicalSearchQuery("İstanbul")).toBe("istanbul");
  });

  it.each([
    ["soft hyphen", "tr­ump"],
    ["zero-width space after", "trump​"],
    ["byte order mark before", "﻿trump"],
    ["zero-width joiner", "tr‍ump"],
    ["zero-width non-joiner", "tr‌ump"],
    ["right-to-left override", "‮trump"],
    ["word joiner", "tru⁠mp"],
    ["full-width letters", "ＴＲＵＭＰ"],
    ["full-width lower case", "ｔｒｕｍｐ"],
    ["format characters at both ends", "\u200b\u2060trump\u200f\ufeff"],
  ])("%s: %j has the key 'trump'", (_label, input) => {
    expect(canonicalSearchQuery(input)).toBe("trump");
  });

  it("zero-width removal joins the halves of a word, it does not split it", () => {
    expect(canonicalSearchQuery("a​b")).toBe("ab");
  });

  it("a query of format characters only is ''", () => {
    expect(canonicalSearchQuery("​‌﻿")).toBe("");
    expect(normaliseSearchQuery("​﻿")).toBe("");
  });

  it("NFKC folds full-width digits, ligatures and a full-width apostrophe", () => {
    expect(canonicalSearchQuery("２０２６")).toBe("2026");
    expect(canonicalSearchQuery("ﬁnans")).toBe("finans");
    expect(canonicalSearchQuery("Erdoğan＇ın")).toBe("erdoğan");
    expect(canonicalSearchQuery("Kur＇an")).toBe("kur'an");
  });

  it("a format character hides neither a negation nor a suffix", () => {
    expect(canonicalSearchQuery("​-bahçeli")).toBe("-bahçeli");
    expect(canonicalSearchQuery("－bahçeli")).toBe("-bahçeli");
    expect(canonicalSearchQuery("Erdoğan'​ın")).toBe("erdoğan");
  });

  it("deleting format characters first keeps the result NFKC-stable (a ZWSP between a letter and its accent)", () => {
    const once = canonicalSearchQuery("a​́");
    expect(once).toBe("á");
    expect(canonicalSearchQuery(once)).toBe(once);
  });

  it("cleanQueryUnicode is NFKC without \\p{Cf}, and idempotent", () => {
    expect(cleanQueryUnicode("Ｔr​ump")).toBe("Trump");
    expect(cleanQueryUnicode("")).toBe("");
    const once = cleanQueryUnicode("a​́­ﬁ");
    expect(cleanQueryUnicode(once)).toBe(once);
  });

  it("is linear: 100k characters of format characters and 100k NFD letters finish at once", () => {
    const started = performance.now();
    expect(canonicalSearchQuery("​".repeat(100_000))).toBe("");
    expect(canonicalSearchQuery("ş".repeat(50_000)).length).toBeLessThanOrEqual(MAX_SEARCH_QUERY_LENGTH);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("canonicalSearchQuery is idempotent over the h50-search-2 inputs", () => {
  const fixtures = [
    "Erdoğan - Bahçeli",
    "trump <-> iran",
    "a — b",
    "erdoğan -bahçeli",
    "Kur'an",
    "O'Brien",
    "L'Oréal",
    "Erdoğan'ın",
    "Erdoğan’dan",
    "Özel'den",
    "Bahçeli'nin",
    "İmamoğlu'na",
    "Türkiye'deki",
    "AKP'nin",
    "CHP'liler",
    "Putin'le",
    "Sezai'yi",
    "İstanbul'u",
    "Kılıçdaroğlu'ndan",
    "Gazze'ye",
    "İsrail'in",
    "Kur'an'ın",
    "FETÖ'cüler",
    "AKP'ci",
    "CHP'ciler",
    "Türkiye'dekiler",
    "İstanbul'dakiler",
    "ABD'DEKI",
    "ANKARA'DAKI",
    "şişli",
    "tr­ump",
    "trump​",
    "﻿trump",
    "ＴＲＵＭＰ",
    "a​́",
  ];

  it.each(fixtures)("%j", (q) => {
    const once = canonicalSearchQuery(q);
    expect(canonicalSearchQuery(once)).toBe(once);
  });

  it("is idempotent, bounded and surrogate-safe over 4000 seeded random queries with apostrophes, dashes and format characters", () => {
    let state = 0x51ed270b;
    const next = () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const alphabet = [
      "a", "n", "ı", "d", "e", "l", "r", "I", "İ", "ş", "Ğ", "1", " ", " ", " ",
      "'", "'", "’", "ʼ", "‘", "-", "-", "—", "<", ">", '"', ".", "!",
      "​", "­", "﻿", "́", "̇", "̧", "Ａ", "－", "\u{1F600}", "\ud83d", "\u0000", "\t",
      "/", "\\", "|", "/",
    ];
    for (let n = 0; n < 4000; n++) {
      const len = Math.floor(next() * 120);
      let q = "";
      for (let i = 0; i < len; i++) q += alphabet[Math.floor(next() * alphabet.length)]!;
      const once = canonicalSearchQuery(q);
      const label = JSON.stringify(q);
      expect(canonicalSearchQuery(once), label).toBe(once);
      expect(once.length, label).toBeLessThanOrEqual(MAX_SEARCH_QUERY_LENGTH);
      expect(once.split(" ").filter(Boolean).length, label).toBeLessThanOrEqual(MAX_SEARCH_TERMS);
      expect(hasLoneSurrogate(once), label).toBe(false);
      expect(once, label).toBe(once.trim());
      expect(/(^| )-+( |$)/.test(once), label).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// h96-search-1: the headline form of an everyday noun. The Turkish stemmer gives
// the possessive ('vergisi' -> 'vergis') and the doubled-consonant form ('zammı'
// -> 'zammı') their own lexemes, so 'elektrik zammı' matched nothing while
// 'elektrik zam' found 9 stories. searchSiblingQuery rewrites those two shapes to
// the root; the archive then searches the typed words AND the sibling.
// ---------------------------------------------------------------------------

describe("searchSiblingQuery (h96-search-1)", () => {
  it.each([
    ["elektrik zammı", "elektrik zam"],
    ["elektrik zammi", "elektrik zam"],
    ["emlak vergisi", "emlak vergi"],
    ["doğal gaz zammı", "doğal gaz zam"],
    ["asgari ücret zammı", "asgari ücret zam"],
    ["trafik cezası", "trafik ceza"],
    ["gelir vergisi", "gelir vergi"],
  ])("%j -> %j", (q, sibling) => {
    expect(searchSiblingQuery(q)).toBe(sibling);
  });

  it.each([
    ["soruşturması", "soruşturma"],
    ["sorusturmasi", "sorusturma"],
    ["belediyesi", "belediye"],
    ["cezası", "ceza"],
    ["aşısı", "aşı"],
    ["ekonomisi", "ekonomi"],
    ["üniversitesi", "üniversite"],
  ])("rule A (possessive after a vowel): %j -> %j", (q, root) => {
    expect(searchSiblingQuery(q)).toBe(root);
  });

  // CORR-2: rule A is the -sı / -si ending only. A -su / -sü word is a compound name (Karasu,
  // Sarısu, Ilısu, Akarsu), not a possessive, and its 'root' ('kara', 'sarı') is another word:
  // a sibling call for 'karasu' would fill the page with 'kara' rows. The fruit 'kayısı'
  // matches the shape but its root 'kayı' is unrelated, so it is on a small folded deny set.
  it.each([
    "karasu",
    "Karasu",
    "KARASU",
    "sarısu",
    "ılısu",
    "Ilısu",
    "akarsu",
    "kayısı",
    "Kayısı",
    "KAYISI",
    "kayisi",
    "Kayisi",
  ])("no sibling for a -su compound name or the fruit: %j", (q) => {
    expect(searchSiblingQuery(q)).toBeNull();
  });

  it("the ordinary possessives still return the root after the narrowing", () => {
    expect(searchSiblingQuery("vergisi")).toBe("vergi");
    expect(searchSiblingQuery("cezası")).toBe("ceza");
    expect(searchSiblingQuery("soruşturması")).toBe("soruşturma");
    expect(searchSiblingQuery("belediyesi")).toBe("belediye");
    expect(searchSiblingQuery("Karasu belediyesi")).toBe("Karasu belediye");
  });

  it("the deny set is checked per term: a denied word next to a possessive leaves only the possessive rewritten", () => {
    expect(searchSiblingQuery("kayısı vergisi")).toBe("kayısı vergi");
    expect(searchSiblingQuery("kayısı fiyatı")).toBeNull();
  });

  it.each([
    ["zammı", "zam"],
    ["zammi", "zam"],
    ["zammü", "zam"],
    ["hakkı", "hak"],
    ["affı", "af"],
    ["hissi", "his"],
    ["hattı", "hat"],
    ["sırrı", "sır"],
    ["reddi", "ret"],
  ])("rule B (closed gemination allowlist): %j -> %j", (q, root) => {
    expect(searchSiblingQuery(q)).toBe(root);
  });

  it("GEMINATE_ROOTS is exactly the seven reviewed roots and nothing else", () => {
    expect([...GEMINATE_ROOTS.entries()].sort()).toEqual(
      [
        ["aff", "af"],
        ["hakk", "hak"],
        ["hatt", "hat"],
        ["hiss", "his"],
        ["redd", "ret"],
        ["sırr", "sır"],
        ["zamm", "zam"],
      ].sort(),
    );
  });

  it("compares case-insensitively with Turkish rules and keeps the other terms as typed", () => {
    expect(searchSiblingQuery("ELEKTRİK ZAMMI")).toBe("ELEKTRİK zam");
    expect(searchSiblingQuery("Emlak VERGİSİ")).toBe("Emlak vergi");
    expect(searchSiblingQuery("Trafik Cezası")).toBe("Trafik ceza");
  });

  it("rewrites every term that qualifies and never changes the term count", () => {
    expect(searchSiblingQuery("vergisi zammı cezası")).toBe("vergi zam ceza");
    const q = "a vergisi b zammı c cezası";
    expect(searchSiblingQuery(q)!.split(" ")).toHaveLength(q.split(" ").length);
    const six = "emlak vergisi zammı trafik cezası yeni";
    expect(searchSiblingQuery(six)!.split(" ")).toHaveLength(six.split(" ").length);
    expect(searchSiblingQuery(six)!.split(" ").length).toBeLessThanOrEqual(MAX_SEARCH_TERMS);
  });

  it.each([
    "erdoğan",
    "messi",
    "sisi",
    "burdur",
    "miller",
    "zam",
    "vergi",
    "ceza",
    "elektrik zam",
    "emlak vergi",
    "trafik ceza",
    "zamlar",
    "istanbul",
    "imamoğlu",
    "seçim",
    "",
    "   ",
  ])("returns null when no term qualifies: %j", (q) => {
    expect(searchSiblingQuery(q)).toBeNull();
  });

  it("'zammına' is no longer a miss: rule C (h144-search-1) reads it as zammı + na, so the second call asks for 'zammı'", () => {
    // Before h144 the allowlist rule covered the bare vowel forms only and this was null.
    expect(searchSiblingQuery("zammına")).toBe("zammı");
    expect(searchSiblingQuery("hakkına")).toBe("hakkı");
  });

  it("the allowlist is closed: a doubled consonant that is not listed is left alone", () => {
    for (const q of ["messi", "kuzzi", "mekki", "yakki", "ossi", "allı", "tatlı", "hallı"]) {
      expect(searchSiblingQuery(q), q).toBeNull();
    }
  });

  it("returns null for any query that uses websearch syntax: the reader is in charge", () => {
    for (const q of [
      "akp or chp",
      "vergisi or zammı",
      '"emlak vergisi"',
      '"emlak" vergisi',
      "-vergisi",
      "emlak -vergisi",
      "emlak vergisi -zam",
      "AKP OR vergisi",
    ]) {
      expect(searchSiblingQuery(q), q).toBeNull();
    }
  });

  it("is idempotent: applying it to its own output returns null", () => {
    for (const q of [
      "elektrik zammı",
      "emlak vergisi",
      "doğal gaz zammı",
      "asgari ücret zammı",
      "trafik cezası",
      "soruşturması",
      "vergisi zammı cezası",
      "hakkı affı",
    ]) {
      const once = searchSiblingQuery(q);
      expect(once, q).not.toBeNull();
      expect(searchSiblingQuery(once!), q).toBeNull();
    }
  });

  it("changes terms only: the sibling is never longer than the query and holds no new word", () => {
    for (const q of ["elektrik zammı", "emlak vergisi", "trafik cezası", "vergisi zammı cezası"]) {
      const sib = searchSiblingQuery(q)!;
      expect(sib.length).toBeLessThanOrEqual(q.length);
      expect(sib.split(" ")).toHaveLength(q.split(" ").length);
    }
  });

  it("leaves a term with an edge character alone (the canonical key has already cut punctuation)", () => {
    for (const q of ["vergisi,", "(vergisi)", "vergisi!", "'zammı", "vergisi\u0307"]) {
      expect(searchSiblingQuery(q), q).toBeNull();
    }
  });

  it("scales linearly: a long single term, a long run of terms and a dotless-i run (CPU-time ladder, no wall-clock budget)", () => {
    // Load-robust (tests/_helpers/linear-time.ts): the growth over a size ladder, not an absolute time.
    expectLinear(
      (n) => ({
        longTerm: rep("a", "", "si")(n),
        manyTerms: rep("ab ", "", "vergisi")(n),
        dotless: rep("\u0131", "", "x")(n),
      }),
      (q) => {
        expect(searchSiblingQuery(q.longTerm)).toBeNull();
        expect(searchSiblingQuery(q.manyTerms)).not.toBeNull();
        expect(searchSiblingQuery(q.dotless)).toBeNull();
      },
      { n: 200_000, ceilingMs: 8_000 },
    );
  });
});

// ---------------------------------------------------------------------------
// h144-search-3: a '/', '\' or '|' between two letters separates words, and the
// 64-character cut never keeps half a word when more than one term is kept.
//
// 'Rusya/Ukrayna' was ONE term, so the archive looked for one lexeme 'rusya/ukrayna'
// that no story holds (0 against 50 for 'rusya ukrayna'); 'Dolar/TL' found 1 against 13.
// The 64-character cut kept 'iste' of 'isteyenler': a pasted 14-source headline searched a
// fragment no story holds and answered "sonuç bulunamadı".
// ---------------------------------------------------------------------------

const PASTED_HEADLINE =
  "Cumhurbaşkanı Erdoğan Azerbaycan’da: “Kardeşliğimizi zayıflatmak isteyenler emellerine asla ulaşamayacak”";
const PASTED_CANONICAL = "cumhurbaşkanı erdoğan azerbaycan kardeşliğimizi zayıflatmak";

describe("canonicalSearchQuery: a slash, backslash or bar between letters separates words (h144-search-3)", () => {
  it.each([
    ["Rusya/Ukrayna", "rusya ukrayna"],
    ["Dolar/TL", "dolar tl"],
    ["CHP|AKP", "chp akp"],
    ["Rusya\\Ukrayna", "rusya ukrayna"],
    ["a/b/c", "a b c"],
    ["Rusya/Ukrayna/Belarus", "rusya ukrayna belarus"],
    ["İran/İsrail", "iran israil"],
    ["Ak/Parti seçim", "ak parti seçim"],
    ["ŞİŞLİ/BEŞİKTAŞ", "şişli beşiktaş"],
  ])("%j -> %j", (input, expected) => {
    expect(canonicalSearchQuery(input)).toBe(expected);
  });

  it.each([
    ["24/7", "24/7"],
    ["1/2", "1/2"],
    ["3/4 oy", "3/4 oy"],
    ["a/1", "a/1"],
    ["1/a", "1/a"],
    ["2026|2027", "2026|2027"],
  ])("digits are untouched: %j -> %j", (input, expected) => {
    expect(canonicalSearchQuery(input)).toBe(expected);
  });

  it("a slash that is not between two letters stays out of the way as before", () => {
    expect(canonicalSearchQuery("Rusya/")).toBe("rusya");
    expect(canonicalSearchQuery("/Rusya")).toBe("rusya");
    expect(canonicalSearchQuery("Rusya / Ukrayna")).toBe("rusya ukrayna");
    expect(canonicalSearchQuery("Rusya// Ukrayna")).toBe("rusya ukrayna");
  });

  // h145 review TS-3 / sec-LOW-1: SLASH_BETWEEN_LETTERS ran before normaliseSearchQuery deleted the apostrophe, so
  // "Erdoğan'/Bahçeli" gave 'erdoğan/bahçeli' and a second pass gave 'erdoğan bahçeli': the cache key, the RPC
  // and the in-feed filter then disagreed about the words. The slash is looked at again after the cleanup.
  it.each([
    ["Erdoğan'/Bahçeli", "erdoğan bahçeli"],
    ["Rusya'/Ukrayna", "rusya ukrayna"],
    ["a'/b", "a b"],
    ["a'|b", "a b"],
    ["Rusya\u2019\\Ukrayna", "rusya ukrayna"],
    ["a'/b'/c", "a b c"],
    ["Erdoğan''/Bahçeli", "erdoğan bahçeli"],
    ["Erdoğan'ın/Bahçeli'nin", "erdoğan bahçeli"],
  ])("an apostrophe before the slash is cut first, then the slash separates: %j -> %j", (input, expected) => {
    expect(canonicalSearchQuery(input)).toBe(expected);
    expect(canonicalSearchQuery(expected)).toBe(expected);
  });

  it("the apostrophe-slash pieces are separate terms: the echo has one word per searched term", () => {
    expect(searchedWordsAsTyped("Erdoğan'/Bahçeli").split(" ")).toHaveLength(2);
    expect(canonicalSearchQuery(searchedWordsAsTyped("Erdoğan'/Bahçeli"))).toBe("erdoğan bahçeli");
    expect(searchedWordsAsTyped("Rusya'/Ukrayna Dolar/TL").split(" ")).toHaveLength(4);
    expect(canonicalSearchQuery(searchedWordsAsTyped("Rusya'/Ukrayna Dolar/TL"))).toBe("rusya ukrayna dolar tl");
  });

  it("the apostrophe-slash pieces use up term slots like any other word", () => {
    expect(canonicalSearchQuery("a'/b'/c'/d'/e'/f'/g")).toBe("a b c d e f");
    expect(searchQueryCut("a'/b'/c'/d'/e'/f")).toBeNull();
    expect(searchQueryCut("a'/b'/c'/d'/e'/f'/g")).toBe("terms");
  });

  it("an apostrophe that is not a Turkish-suffix tail still keeps its word: \"O'Brien/Kur'an\"", () => {
    expect(canonicalSearchQuery("O'Brien/Kur'an")).toBe("o'brien kur'an");
  });

  it("a quoted phrase with a slash inside becomes a phrase of two words", () => {
    expect(canonicalSearchQuery('"Rusya/Ukrayna"')).toBe('"rusya ukrayna"');
  });

  it("the split words use up term slots like any other word", () => {
    expect(canonicalSearchQuery("a/b/c/d/e/f/g")).toBe("a b c d e f");
    expect(searchQueryCut("a/b/c/d/e/f")).toBeNull();
    expect(searchQueryCut("a/b/c/d/e/f/g")).toBe("terms");
  });

  it("searchedWordsAsTyped echoes the words, split", () => {
    expect(searchedWordsAsTyped("Rusya/Ukrayna")).toBe("Rusya Ukrayna");
    expect(searchedWordsAsTyped("Dolar/TL")).toBe("Dolar TL");
  });

  it("the RPC arguments of 'Rusya/Ukrayna' are those of 'rusya ukrayna'", () => {
    const slash = canonicalSearchQuery("Rusya/Ukrayna");
    const spaced = canonicalSearchQuery("Rusya Ukrayna");
    expect(slash).toBe(spaced);
    expect(turkishQueryVariants(slash)).toEqual(turkishQueryVariants(spaced));
    expect(foldTr(slash)).toBe("rusya ukrayna");
  });

  it.each([
    "Rusya/Ukrayna",
    "Dolar/TL",
    "CHP|AKP",
    "24/7",
    "a/b/c",
    "Rusya\\Ukrayna",
    '"a/b"',
    "a/b-c/d",
    // h145 review TS-3: the apostrophe goes after the slash was looked at, so the slash ends up between letters.
    "Erdoğan'/Bahçeli",
    "Rusya'/Ukrayna",
    "a'/b",
    "a'|b",
  ])(
    "is idempotent: %j",
    (q) => {
      const once = canonicalSearchQuery(q);
      expect(canonicalSearchQuery(once)).toBe(once);
    },
  );

  it("is linear: a long run of slashes, bars and digit slashes (CPU-time ladder)", () => {
    expectLinear(
      (n) => ({
        slashes: rep("a/", "", "b")(n),
        bars: rep("a|", "", "b")(n),
        digits: rep("1/", "", "2")(n),
        lone: rep("/", "a", "b")(n),
      }),
      (q) => {
        for (const text of Object.values(q)) {
          canonicalSearchQuery(text);
          searchedWordsAsTyped(text);
          searchQueryCut(text);
        }
      },
      { n: 200_000, ceilingMs: 8_000 },
    );
  });
});

describe("canonicalSearchQuery: the 64-character cut keeps whole words (h144-search-3)", () => {
  it("the pasted 14-source headline keeps its first 5 words, not a fragment of the 6th", () => {
    expect(canonicalSearchQuery(PASTED_HEADLINE)).toBe(PASTED_CANONICAL);
    // The 6th term is 'isteyenler': the old cut ended in 'iste'.
    expect(canonicalSearchQuery(PASTED_HEADLINE).endsWith("iste")).toBe(false);
  });

  it("drops the partial last term entirely and trims", () => {
    expect(canonicalSearchQuery(`${"a".repeat(60)} ${"b".repeat(30)}`)).toBe("a".repeat(60));
    expect(canonicalSearchQuery(`${"a".repeat(63)} ${"b".repeat(10)}`)).toBe("a".repeat(63));
    expect(canonicalSearchQuery(`aa ${"b".repeat(61)} ${"c".repeat(20)}`)).toBe(`aa ${"b".repeat(61)}`);
  });

  it("keeps the last term when the cut lands exactly after it (the next character is a space)", () => {
    const q = `${"a".repeat(30)} ${"b".repeat(33)} ccc`;
    expect(canonicalSearchQuery(q)).toBe(`${"a".repeat(30)} ${"b".repeat(33)}`);
    expect(canonicalSearchQuery(q)).toHaveLength(MAX_SEARCH_QUERY_LENGTH);
    // One more letter in the second term and it no longer fits: it is dropped.
    expect(canonicalSearchQuery(`${"a".repeat(30)} ${"b".repeat(34)} ccc`)).toBe("a".repeat(30));
  });

  it("a single term longer than 64 keeps today's cut", () => {
    expect(canonicalSearchQuery("a".repeat(70))).toBe("a".repeat(64));
    expect(canonicalSearchQuery("a".repeat(500))).toBe("a".repeat(64));
    // Still one term when others follow: nothing before it to fall back to.
    expect(canonicalSearchQuery(`${"a".repeat(70)} bb`)).toBe("a".repeat(64));
  });

  it("a single term keeps the surrogate and edge repairs", () => {
    const cut = canonicalSearchQuery("a".repeat(63) + "\u{1F600}" + "b");
    expect(cut).toBe("a".repeat(63));
    expect(hasLoneSurrogate(cut)).toBe(false);
    expect(canonicalSearchQuery("a".repeat(63) + ".b")).toBe("a".repeat(63));
    expect(canonicalSearchQuery(`${"a".repeat(61)}'daxyz`)).toBe("a".repeat(61));
  });

  it("an emoji inside the cut term never leaves a lone surrogate behind", () => {
    const q = `${"a".repeat(30)} ${"b".repeat(32)}\u{1F600}${"x".repeat(10)}`;
    const out = canonicalSearchQuery(q);
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(out).toBe("a".repeat(30));
  });

  it("a dash-only or '-negated' fragment is dropped with the partial term", () => {
    expect(canonicalSearchQuery(`${"a".repeat(62)} -bahçeli`)).toBe("a".repeat(62));
    expect(canonicalSearchQuery(`${"a".repeat(30)} ${"b".repeat(32)} -bahçeli`)).toBe(
      `${"a".repeat(30)} ${"b".repeat(32)}`,
    );
  });

  it("searchQueryCut still says 'length' for a query the cut shortened, and null for the output", () => {
    expect(searchQueryCut(PASTED_HEADLINE)).toBe("length");
    expect(searchQueryCut(`${"a".repeat(60)} ${"b".repeat(30)}`)).toBe("length");
    expect(searchQueryCut(PASTED_CANONICAL)).toBeNull();
    expect(searchQueryWasShortened(PASTED_HEADLINE)).toBe(true);
  });

  it("the pasted headline's RPC arguments hold whole words only", () => {
    const key = canonicalSearchQuery(PASTED_HEADLINE);
    for (const v of turkishQueryVariants(key)) {
      expect(v.split(" ").every((w) => /^\p{L}+$/u.test(w)), v).toBe(true);
    }
    expect(foldTr(key)).toBe("cumhurbaskani erdogan azerbaycan kardesligimizi zayiflatmak");
  });

  it.each([
    PASTED_HEADLINE,
    `${"a".repeat(60)} ${"b".repeat(30)}`,
    `${"a".repeat(30)} ${"b".repeat(33)} ccc`,
    `${"a".repeat(70)} bb`,
    `${"a".repeat(30)} ${"b".repeat(32)}\u{1F600}${"x".repeat(10)}`,
    "Rusya/Ukrayna/Belarus ".repeat(6),
  ])("is idempotent over a cut query: %j", (q) => {
    const once = canonicalSearchQuery(q);
    expect(canonicalSearchQuery(once)).toBe(once);
    expect(once.length).toBeLessThanOrEqual(MAX_SEARCH_QUERY_LENGTH);
  });

  it("is idempotent, bounded and word-whole over 4000 seeded random queries with slashes and long words", () => {
    let state = 0x2f6e2b1;
    const next = () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const letters = ["a", "b", "z", "I", "İ", "ı", "ş", "Ğ", "ü", "1"];
    // h145 review TS-3: an apostrophe before the slash ("a'/b") is in the mix, so the echo check below
    // also covers the pieces the second look at the slash produces.
    const separators = [" ", " ", " ", "/", "|", "\\", " - ", "  ", "/ ", "-", "'/", "'|", "''\\", "\u2019/"];
    for (let n = 0; n < 4000; n++) {
      const words = 1 + Math.floor(next() * 9);
      let q = "";
      for (let w = 0; w < words; w++) {
        const len = 1 + Math.floor(next() * 30);
        for (let i = 0; i < len; i++) q += letters[Math.floor(next() * letters.length)]!;
        q += separators[Math.floor(next() * separators.length)]!;
      }
      const once = canonicalSearchQuery(q);
      const label = JSON.stringify(q);
      expect(canonicalSearchQuery(once), label).toBe(once);
      expect(once.length, label).toBeLessThanOrEqual(MAX_SEARCH_QUERY_LENGTH);
      expect(once.split(" ").filter(Boolean).length, label).toBeLessThanOrEqual(MAX_SEARCH_TERMS);
      expect(once, label).toBe(once.trim());
      // No slash, backslash or bar is left between two letters (digits keep theirs).
      expect(/\p{L}[\/\\|]\p{L}/u.test(once), label).toBe(false);
      // The echo of a cut query re-reads as the same canonical query.
      expect(canonicalSearchQuery(searchedWordsAsTyped(q)), label).toBe(once);
    }
  });
});

describe("searchedWordsAsTyped under a length cut (h144-search-3)", () => {
  it("the pasted headline echoes its first 5 typed words, the ones the search used", () => {
    expect(searchedWordsAsTyped(PASTED_HEADLINE)).toBe(
      "Cumhurbaşkanı Erdoğan Azerbaycan’da: “Kardeşliğimizi zayıflatmak",
    );
    expect(searchedWordsAsTyped(PASTED_HEADLINE).split(" ")).toHaveLength(5);
  });

  it("the echo is searched as the same canonical query and is no longer cut", () => {
    const echo = searchedWordsAsTyped(PASTED_HEADLINE);
    expect(canonicalSearchQuery(echo)).toBe(canonicalSearchQuery(PASTED_HEADLINE));
    expect(searchQueryCut(echo)).toBeNull();
  });

  it("echoes the first k words where k is the number of kept terms", () => {
    expect(searchedWordsAsTyped(`Aa! ${"b".repeat(60)} ${"c".repeat(30)} d`)).toBe(`Aa! ${"b".repeat(60)}`);
    expect(searchedWordsAsTyped(`${"a".repeat(60)} ${"b".repeat(30)}`)).toBe("a".repeat(60));
  });

  it("a single long term is echoed whole, as before (k is 1)", () => {
    expect(searchedWordsAsTyped("a".repeat(70))).toBe("a".repeat(70));
    expect(searchedWordsAsTyped(`${"a".repeat(70)} bb`)).toBe("a".repeat(70));
  });

  it("a term cut and a length cut together: the length cut decides", () => {
    // 7 words, the first 6 already too long for 64 characters: 5 survive.
    expect(searchedWordsAsTyped(`${PASTED_HEADLINE} bir iki`).split(" ")).toHaveLength(5);
  });

  it("is unchanged under a term cut or no cut", () => {
    expect(searchedWordsAsTyped("a b c d e f g")).toBe("a b c d e f");
    expect(searchedWordsAsTyped("Erdoğan Özel")).toBe("Erdoğan Özel");
    expect(searchedWordsAsTyped("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// h144-search-1: the case suffix typed WITHOUT an apostrophe, and the bare vowel-final noun.
//
// The stemmer cuts the bare word and its suffixed form differently (ts_lexize, production,
// 2026-11-12): imamoğlu stays imamoğlu but imamoğluna becomes imamoğl; suriye -> suri but
// suriyede -> suriye; adana -> ada but adanada -> adana; kaza -> kaz but kazada -> kaza;
// oylama -> oyla but oylamada and oylamayı -> oylama. The archive found nothing for
// 'imamoğluna', 'suriyede', 'trumpa' and 'netanyahu bloğu ilk oylama' (0) while the bare
// words found 50 and 'oylamayı' found 2.
//
// Rule C of searchSiblingQuery rewrites a case-suffixed word to its root; searchFoldedSibling
// gives the bare vowel-final noun its locative for the folded arm of the second call.
// ---------------------------------------------------------------------------

describe("searchSiblingQuery rule C: a case suffix typed without an apostrophe (h144-search-1)", () => {
  it.each([
    ["imamoğluna", "imamoğlu"],
    ["imamogluna", "imamoglu"],
    ["kılıçdaroğlunu", "kılıçdaroğlu"],
    ["suriyede", "suriye"],
    ["adanada", "adana"],
    ["ankaradan", "ankara"],
    ["bursada", "bursa"],
    ["yalovada", "yalova"],
    ["niğdede", "niğde"],
    ["boluda", "bolu"],
    ["ispartada", "isparta"],
    ["abdye", "abd"],
    ["chpnin", "chp"],
    ["tbmmde", "tbmm"],
    ["çinde", "çin"],
    ["yskdan", "ysk"],
    ["erdoğan imamoğluna", "erdoğan imamoğlu"],
  ])("%j -> %j", (q, sibling) => {
    expect(searchSiblingQuery(q)).toBe(sibling);
  });

  it.each([
    ["imamoğlunda", "imamoğlu"], // 'nda' is tried before 'da'
    ["kılıçdaroğlundan", "kılıçdaroğlu"],
    ["imamoğlunun", "imamoğlu"],
    ["imamoğlundan", "imamoğlu"],
    ["türkiyenin", "türkiye"],
    ["suriyeyi", "suriye"],
    ["ukraynayı", "ukrayna"],
    ["istanbulda", "istanbul"],
    ["istanbuldan", "istanbul"],
    ["erdoğanda", "erdoğan"],
    ["kitaptan", "kitap"],
    ["çocukta", "çocuk"],
    ["tunada", "tuna"],
    ["kafeye", "kafe"],
  ])("tails, longest first: %j -> %j", (q, root) => {
    expect(searchSiblingQuery(q)).toBe(root);
  });

  it("reads the term with Turkish casing and keeps the other terms as typed", () => {
    expect(searchSiblingQuery("İMAMOĞLUNA")).toBe("imamoğlu");
    expect(searchSiblingQuery("SURİYEDE")).toBe("suriye");
    expect(searchSiblingQuery("ABDYE")).toBe("abd");
    expect(searchSiblingQuery("Erdoğan İmamoğluna")).toBe("Erdoğan imamoğlu");
  });

  it("an ASCII-typed term qualifies: the ASCII i counts as i, and ç, ğ fold", () => {
    expect(searchSiblingQuery("cinde")).toBe("cin");
    expect(searchSiblingQuery("nigdede")).toBe("nigde");
    expect(searchSiblingQuery("kilicdaroglunu")).toBe("kilicdaroglu");
  });

  it.each([
    "adana", // the 'na' root 'ada' ends in a
    "dünya", // root 'dün' is 3 letters
    "rusya", // 'rus' is 3 letters and ends in a consonant
    "antalya", // 'antal' ends in a consonant: 'ya' needs a vowel
    "ukrayna", // 'ukray' does not end in ı i u ü
    "kanada", // fits the shape, the root 'kana' is another word (deny set)
    "hollanda",
    "makine",
    "kabine",
    "kaza", // a bare a / e dative is out of scope
    "bursa",
    "trumpa",
    "erdoğana",
    "imamoğlu",
    "erdoğan",
    "istanbul",
  ])("returns null: %j", (q) => {
    expect(searchSiblingQuery(q)).toBeNull();
  });

  it("an operator query is the reader's own: no sibling", () => {
    expect(searchSiblingQuery('"imamoğluna"')).toBeNull();
    expect(searchSiblingQuery("-imamoğluna")).toBeNull();
    expect(searchSiblingQuery("imamoğluna or suriyede")).toBeNull();
  });

  describe("the gates", () => {
    it("(i) the root is at least 4 letters: a 3-letter root is left alone, a 4-letter one is not", () => {
      expect(searchSiblingQuery("adada")).toBeNull(); // 'ada' + da
      expect(searchSiblingQuery("evde")).toBeNull(); // 'ev' + de
      expect(searchSiblingQuery("boluda")).toBe("bolu");
      expect(searchSiblingQuery("tunada")).toBe("tuna");
    });

    it("(ii) phonotactics: a tail only follows the sound it is made for", () => {
      // da de dan den: a vowel or a voiced consonant
      expect(searchSiblingQuery("çocukda")).toBeNull();
      expect(searchSiblingQuery("kitapdan")).toBeNull();
      // ta te tan ten: a voiceless consonant
      expect(searchSiblingQuery("ankarata")).toBeNull();
      expect(searchSiblingQuery("istanbulta")).toBeNull();
      // na ne nı ni nu nü and nda nde ndan nden: ı i u ü
      expect(searchSiblingQuery("ankarana")).toBeNull();
      expect(searchSiblingQuery("trabzonna")).toBeNull();
      // ya ye yı yi yu yü and nın nin nun nün: a vowel
      expect(searchSiblingQuery("istanbulya")).toBeNull();
      expect(searchSiblingQuery("trabzonnun")).toBeNull();
    });

    it("(iii) vowel harmony with the last vowel of the root", () => {
      expect(searchSiblingQuery("ankarade")).toBeNull(); // a takes da
      expect(searchSiblingQuery("imamoğlude")).toBeNull(); // u takes da
      expect(searchSiblingQuery("niğdeda")).toBeNull(); // e takes de
      expect(searchSiblingQuery("imamoğluni")).toBeNull(); // u takes nu
      expect(searchSiblingQuery("suriyeya")).toBeNull();
      expect(searchSiblingQuery("suriyeyu")).toBeNull(); // e takes yi
      expect(searchSiblingQuery("suriyeyi")).toBe("suriye");
      expect(searchSiblingQuery("kılıçdaroğlunü")).toBeNull(); // u takes nu, not nü
      expect(searchSiblingQuery("kılıçdaroğlunu")).toBe("kılıçdaroğlu");
      // ö and ü take the front forms
      expect(searchSiblingQuery("türküde")).toBe("türkü");
      expect(searchSiblingQuery("türküya")).toBeNull();
    });

    it("the four-way tails follow the four vowel classes", () => {
      expect(searchSiblingQuery("ukraynayı")).toBe("ukrayna"); // a -> ı
      expect(searchSiblingQuery("bahçeliyi")).toBe("bahçeli"); // i -> i
      expect(searchSiblingQuery("davutoğluyu")).toBe("davutoğlu"); // u -> u
      expect(searchSiblingQuery("türküyü")).toBe("türkü"); // ü -> ü
      expect(searchSiblingQuery("bahçeliyı")).toBeNull();
      expect(searchSiblingQuery("türküyu")).toBeNull();
    });

    it("(iv) the deny set: words that fit the shape but whose root is another word or a junk stem", () => {
      // ts_lexize('turkish_stem', ...) on production, 2026-11-12: the word's stem / the root's stem.
      //   kanada    kana  -> 'kana' / 'ka'          granada  grana  -> 'grana' / 'gra'
      //   makine    maki  -> 'mak'  / 'maki'        kabine   kabi   -> 'kap'   / 'kabi'
      //   hazine    hazi  -> 'haz'  / 'hazi'
      // each root stems to a lexeme of its own that no headline of the word holds. The rest are
      // not words as roots, and their stem equals the word's own, so a sibling adds nothing:
      //   hollanda  hollan   -> 'holla' / 'holla'     florida   flori    -> 'flori' / 'flori'
      //   uganda    ugan     -> 'uga'   / 'uga'        ruanda    ruan     -> 'ruan'  / 'ruan'
      //   propaganda propagan -> 'propaga' / 'propaga'  ajanda    ajan     -> 'aja'   / 'aja'
      //   veranda   veran    -> 'vera'  / 'vera'       medine    medi     -> 'medi'  / 'medi'
      // 'suriye' is the root of 'suriyede' and itself fits the shape ('suri' + 'ye', both stem to
      // 'suri'): denied, so the sibling of 'suriyede' is a fixed point.
      // The very common function words whose root stems to a 1-3 letter junk lexeme (6,000 newest
      // headlines, 2026-11-12: yeniden 70, ardından 43, nerede 15, konseyi 11):
      //   yeniden -> yeni 'yeni' / 'ye'   ardından -> ardı 'ardı' / 'ar'   nerede -> nere [] / 'ner'
      //   konseyi -> konse 'konse' / 'ko'  ('yeniden sayım' gained 'Yeni Zelanda ... oy sayım').
      for (const word of [
        "kanada", "hollanda", "florida", "uganda", "ruanda", "propaganda", "ajanda", "veranda",
        "granada", "makine", "kabine", "hazine", "medine", "suriye",
        "yeniden", "ardından", "nerede", "konseyi",
      ]) {
        expect(searchSiblingQuery(word), word).toBeNull();
        expect(searchSiblingQuery(word.toLocaleUpperCase("tr")), word).toBeNull();
      }
      // The deny set is the typed word's: the inflections of a denied word still reach it.
      expect(searchSiblingQuery("kanadada")).toBe("kanada");
      expect(searchSiblingQuery("hollandada")).toBe("hollanda");
      expect(searchSiblingQuery("suriyede")).toBe("suriye");
      expect(searchSiblingQuery("makineye")).toBe("makine");
    });
  });

  describe("SHORT_CASE_ROOTS: acronyms and short names read letter by letter", () => {
    it.each([
      ["abdye", "abd"],
      ["abnin", "ab"],
      ["abye", "ab"],
      ["bmde", "bm"],
      ["çinden", "çin"],
      ["chpnin", "chp"],
      ["mhpnin", "mhp"],
      ["akpye", "akp"],
      ["yskdan", "ysk"],
      ["aymye", "aym"],
      ["tbmmde", "tbmm"],
      ["tcmbnin", "tcmb"],
      ["mebnin", "meb"],
      ["sgkya", "sgk"],
      ["spkya", "spk"],
      ["tuikte", "tuik"],
      ["thyye", "thy"],
      ["natoya", "nato"],
      ["natonun", "nato"],
      ["ABD'NİN".replaceAll("'", ""), "abd"],
    ])("%j -> %j (the harmony and length gates are skipped)", (q, root) => {
      expect(searchSiblingQuery(q)).toBe(root);
    });

    it("a bare a / e dative is accepted for a short root, except 'ab' and 'çin' (Abe, Çine, aba are other words)", () => {
      expect(searchSiblingQuery("tuike")).toBe("tuik");
      expect(searchSiblingQuery("mebe")).toBe("meb");
      expect(searchSiblingQuery("abe")).toBeNull();
      expect(searchSiblingQuery("aba")).toBeNull();
      expect(searchSiblingQuery("çine")).toBeNull();
      expect(searchSiblingQuery("cina")).toBeNull();
    });

    it("the list is closed: the same shape on another root is left alone", () => {
      for (const q of ["xyzye", "abcnin", "tbmnde", "abdulye", "cinsiyetde", "kuzeyye", "nat"]) {
        expect(searchSiblingQuery(q), q).toBeNull();
      }
    });

    it("the acronym alone, and an acronym with an apostrophe, is not rewritten", () => {
      for (const q of ["abd", "chp", "tbmm", "nato", "ysk"]) expect(searchSiblingQuery(q), q).toBeNull();
    });
  });

  describe("rules A and B come first and are unchanged", () => {
    it("a possessive or a listed doubled stem is rewritten by its own rule, not by rule C", () => {
      expect(searchSiblingQuery("belediyesi")).toBe("belediye");
      expect(searchSiblingQuery("zammı")).toBe("zam");
      expect(searchSiblingQuery("cezası")).toBe("ceza");
      expect(searchSiblingQuery("Karasu belediyesi")).toBe("Karasu belediye");
    });

    it("a term that rule A or B rewrites and a term that rule C rewrites live side by side", () => {
      expect(searchSiblingQuery("trafik cezası imamoğluna")).toBe("trafik ceza imamoğlu");
    });

    it("the -su compound names and the fruit keep no sibling", () => {
      for (const q of ["karasu", "sarısu", "kayısı"]) expect(searchSiblingQuery(q), q).toBeNull();
    });
  });

  describe("the shape of a term it will look at", () => {
    it("only letters: a digit, an apostrophe, a hyphen or a dot keeps the term whole", () => {
      for (const q of ["imamoğlu1na", "imamoğlu'na", "imamoğlu-na", "imamoğlu.na", "f16ya", "2026de", "%50de", "imamoğluna!"]) {
        expect(searchSiblingQuery(q), q).toBeNull();
      }
    });

    it("never changes the term count and never rewrites a term twice", () => {
      const q = "imamoğluna suriyede ankaradan kitaptan";
      const sibling = searchSiblingQuery(q)!;
      expect(sibling).toBe("imamoğlu suriye ankara kitap");
      expect(sibling.split(" ")).toHaveLength(q.split(" ").length);
    });

    it("a term longer than the canonical bound is not examined", () => {
      expect(searchSiblingQuery(`${"a".repeat(80)}da`)).toBeNull();
    });
  });

  it("is idempotent: the sibling of a rewritten query is null", () => {
    for (const q of [
      "imamoğluna", "imamogluna", "kılıçdaroğlunu", "suriyede", "adanada", "ankaradan", "bursada",
      "yalovada", "niğdede", "boluda", "ispartada", "abdye", "chpnin", "tbmmde", "çinde", "yskdan",
      "imamoğlunda", "kitaptan", "natoya", "erdoğan imamoğluna", "istanbulda",
    ]) {
      const once = searchSiblingQuery(q);
      expect(once, q).not.toBeNull();
      expect(searchSiblingQuery(once!), q).toBeNull();
    }
  });

  it("a sibling is a prefix of its term: it only removes letters and changes no letter", () => {
    for (const q of ["imamoğluna", "suriyede", "ankaradan", "çinde", "chpnin", "natoya", "kitaptan"]) {
      const sib = searchSiblingQuery(q)!;
      expect(q.startsWith(sib), q).toBe(true);
      expect(sib.length, q).toBeLessThan(q.length);
    }
  });

  it("scales linearly: a long single term, a long run of terms and a run of tails (CPU-time ladder)", () => {
    expectLinear(
      (n) => ({
        longTerm: rep("a", "", "da")(n),
        manyTerms: rep("ab ", "", "imamoğluna")(n),
        tails: rep("nde", "", "x")(n),
        short: rep("abd ", "", "abdye")(n),
      }),
      (q) => {
        expect(searchSiblingQuery(q.longTerm)).toBeNull();
        expect(searchSiblingQuery(q.manyTerms)).not.toBeNull();
        expect(searchSiblingQuery(q.tails)).toBeNull();
        expect(searchSiblingQuery(q.short)).not.toBeNull();
      },
      { n: 200_000, ceilingMs: 8_000 },
    );
  });
});

describe("searchFoldedSibling (h144-search-1)", () => {
  it.each([
    ["bolu kaza", "boluda kazada"],
    ["meclis oylama", "meclis oylamada"],
    ["toplantı", "toplantıda"],
    ["müzakere", "müzakerede"],
    ["netanyahu bloğu ilk oylama", "netanyahuda bloğuda ilk oylamada"],
    ["mardin kaza", "mardin kazada"],
    ["elektrik zammı", "elektrik zammıda"],
  ])("%j -> %j", (q, folded) => {
    expect(searchFoldedSibling(q)).toBe(folded);
  });

  it("the locative follows the harmony of the last vowel: a ı o u take da, e i ö ü take de", () => {
    expect(searchFoldedSibling("kaza")).toBe("kazada");
    expect(searchFoldedSibling("toplantı")).toBe("toplantıda");
    expect(searchFoldedSibling("metro")).toBe("metroda");
    expect(searchFoldedSibling("bolu")).toBe("boluda");
    expect(searchFoldedSibling("müzakere")).toBe("müzakerede");
    expect(searchFoldedSibling("vergi")).toBe("vergide");
    expect(searchFoldedSibling("abcö")).toBe("abcöde");
    expect(searchFoldedSibling("gölü")).toBe("gölüde");
  });

  it("an ASCII-typed term is read the same way (the ASCII i is an i)", () => {
    expect(searchFoldedSibling("imamoglu")).toBe("imamogluda");
    expect(searchFoldedSibling("toplanti")).toBe("toplantide");
    expect(searchFoldedSibling("ankara")).toBe("ankarada");
  });

  it("reads upper case with the Turkish rules and keeps the term as typed", () => {
    expect(searchFoldedSibling("BOLU KAZA")).toBe("BOLUda KAZAda");
    expect(searchFoldedSibling("İSTANBUL KAZA")).toBe("İSTANBUL KAZAda");
  });

  it.each([
    "erdoğan", // ends in a consonant
    "ab", // shorter than 4 letters
    "zam",
    "ada",
    "abd",
    "trump2", // not letters only
    "2026",
    "%50",
    "ak-parti",
    "kur'an",
    "",
    "   ",
  ])("returns null when no term changes: %j", (q) => {
    expect(searchFoldedSibling(q)).toBeNull();
  });

  it("returns null for a query that uses websearch syntax: the reader is in charge", () => {
    for (const q of ["-oylama", '"oylama"', "kaza or oylama", "bolu -kaza", '"bolu kaza"']) {
      expect(searchFoldedSibling(q), q).toBeNull();
    }
  });

  it("keeps the other terms and never changes the term count or the 6-term bound", () => {
    const q = "bolu kaza trump erdoğan zam toplantı";
    const folded = searchFoldedSibling(q)!;
    expect(folded).toBe("boluda kazada trump erdoğan zam toplantıda");
    expect(folded.split(" ")).toHaveLength(q.split(" ").length);
    expect(folded.split(" ").length).toBeLessThanOrEqual(MAX_SEARCH_TERMS);
  });

  it("folds, with foldTr, to the ASCII locative the folded arm reads", () => {
    expect(foldTr(searchFoldedSibling("netanyahu bloğu ilk oylama")!)).toBe("netanyahuda bloguda ilk oylamada");
    expect(foldTr(searchFoldedSibling("imamoğlu")!)).toBe("imamogluda");
  });

  it("works on the sibling of a rule-C query: 'imamoğluna' -> sibling 'imamoğlu' -> folded 'imamoğluda'", () => {
    const sibling = searchSiblingQuery("imamoğluna")!;
    expect(sibling).toBe("imamoğlu");
    expect(searchFoldedSibling(sibling)).toBe("imamoğluda");
  });

  it("a term longer than the canonical bound is kept as it is, and the folded text grows by 2 letters a term at most", () => {
    expect(searchFoldedSibling("a".repeat(80))).toBeNull();
    const q = "bolu kaza toplantı müzakere ankara vergi";
    expect(searchFoldedSibling(q)!.length).toBeLessThanOrEqual(q.length + 2 * MAX_SEARCH_TERMS);
  });

  it("scales linearly: a long single term and a long run of terms (CPU-time ladder)", () => {
    expectLinear(
      (n) => ({ longTerm: rep("a", "", "")(n), manyTerms: rep("ab kaza ", "", "kaza")(n) }),
      (q) => {
        expect(searchFoldedSibling(q.longTerm)).toBeNull();
        expect(searchFoldedSibling(q.manyTerms)).not.toBeNull();
      },
      { n: 200_000, ceilingMs: 8_000 },
    );
  });
});

// h157-search-1: the locative call also finds 'kazandı' rows ('kazada' and 'kazandı' share the stem
// 'kaza'). A row only that call found is kept when its text holds the typed term as a word start that
// is not 'term + n...'; the genitive (kazanın, oylamanın) is kept.
describe("holdsLocativeWitness (h157-search-1)", () => {
  const holds = (text: string, term: string) => holdsLocativeWitness(foldTr(text), term);

  it.each([
    "Mersin'de kazada 11 yaralı",
    "trafik kazası",
    "kaza",
    "kazalar",
    "kazaya",
    "kazayı",
    "Tokat'ta kazada 2 yaralı",
    "kazanın ardından",
    "KAZANIN ardından",
    "Kazakistan", // documented false positive: a word start that is not an inflection
  ])("true for %j (term 'kaza')", (text) => {
    expect(holds(text, "kaza")).toBe(true);
  });

  it.each([
    "Zafer Kazandı",
    "seçimi kazanan",
    "kazanırken",
    "kazan",
    "trafikkaza", // not a word start
    "ödülü kazandık",
    "",
    "   ",
    "seçim sonuçları",
  ])("false for %j (term 'kaza')", (text) => {
    expect(holds(text, "kaza")).toBe(false);
  });

  it("the genitive nin / nun (folded nın nin nun nün) keeps the row, a longer 'n...' tail does not", () => {
    expect(holds("oylamanın ardından", "oylama")).toBe(true);
    expect(holds("meclis oylaması", "oylama")).toBe(true);
    expect(holds("oylamaya katıldı", "oylama")).toBe(true);
    expect(holds("oylamanun", "oylama")).toBe(true);
    expect(holds("oylamanın", "oylama")).toBe(true);
    expect(holds("oylamanız", "oylama")).toBe(false);
    expect(holds("oylamanin", "oylama")).toBe(true);
    expect(holds("oylamaninki", "oylama")).toBe(false);
  });

  it("a word with an apostrophe or punctuation is split on it: Tokat'ta, kaza, (kaza)", () => {
    expect(holds("Tokat'ta kaza, 2 ölü", "kaza")).toBe(true);
    expect(holds("(kaza)", "kaza")).toBe(true);
    expect(holds("kaza-yolu", "kaza")).toBe(true);
    expect(holds("kaza'nın", "kaza")).toBe(true);
    expect(holds("kazan'ın", "kaza")).toBe(false);
  });

  it("one witness word is enough among many that fail", () => {
    expect(holds("Zafer Kazandı; Mersin'de kazada 2 yaralı", "kaza")).toBe(true);
    expect(holds("Zafer Kazandı; seçimi kazanan", "kaza")).toBe(false);
  });

  it("an ASCII-folded text meets the ASCII term (the caller folds both)", () => {
    expect(holds("Toplantıda söz aldı", "toplanti")).toBe(true);
    expect(holds("Toplantının ardından", "toplanti")).toBe(true);
    expect(holds("Müzakereye başladı", "muzakere")).toBe(true);
  });

  it("a term with a hyphen is read from the part after the last hyphen: 'e-posta' -> 'posta'", () => {
    expect(holds("anonim e-postayla yapılan tehdit", "e-posta")).toBe(true);
    expect(holds("Pentagon'un e-postaları", "e-posta")).toBe(true);
    expect(holds("e-posta", "e-posta")).toBe(true);
    expect(holds("300 okul tahliye edildi", "e-posta")).toBe(false);
    expect(holds("e-fatura düzenlendi", "e-fatura")).toBe(true);
    expect(holds("e-faturan", "e-fatura")).toBe(false);
  });

  it("keeps the row when the term cannot be judged (empty tail, a character outside a-z 0-9): never drops on doubt", () => {
    expect(holds("kaza", "")).toBe(true);
    expect(holds("kaza", "e-")).toBe(true);
    expect(holds("seçim", "naïve")).toBe(true);
    expect(holds("", "")).toBe(true);
  });

  it("never throws on odd input and builds no RegExp from the term", () => {
    for (const term of ["(", "[", "a+", ".*", "\\", "kaza)", "a|b", "$"]) {
      expect(() => holdsLocativeWitness("kaza (kaza) [x] a+ b", term), term).not.toThrow();
    }
    expect(holdsLocativeWitness("kaza (kaza)", "(")).toBe(true);
    expect(holdsLocativeWitness("kaza kazan", ".*")).toBe(true);
  });

  it("scales linearly in the text (CPU-time ladder): many words, one long word, many separators", () => {
    expectLinear(
      (n) => ({
        words: "kazan ".repeat(Math.ceil(n / 6)),
        oneWord: rep("n", "kaza", "")(n),
        separators: rep("'-.,; ", "", "kaza")(n),
      }),
      (q) => {
        expect(holdsLocativeWitness(q.words, "kaza")).toBe(false);
        expect(holdsLocativeWitness(q.oneWord, "kaza")).toBe(false);
        expect(holdsLocativeWitness(q.separators, "kaza")).toBe(true);
      },
      { n: 200_000, ceilingMs: 8_000 },
    );
  });
});

describe("searchFoldedSiblingParts (h157-search-1)", () => {
  it("'tokat kaza' gives the query and the one term the locative changed", () => {
    expect(searchFoldedSiblingParts("tokat kaza")).toEqual({ query: "tokat kazada", terms: ["kaza"] });
  });

  it("'bolu kaza' gives both terms, folded", () => {
    expect(searchFoldedSiblingParts("bolu kaza")).toEqual({ query: "boluda kazada", terms: ["bolu", "kaza"] });
  });

  it("'meclis oylama' gives ['oylama'] and keeps the unchanged term out of `terms`", () => {
    expect(searchFoldedSiblingParts("meclis oylama")).toEqual({ query: "meclis oylamada", terms: ["oylama"] });
  });

  it("terms are the folded ORIGINAL terms (the typed spelling, not the locative)", () => {
    expect(searchFoldedSiblingParts("Netanyahu bloğu ilk oylama")).toEqual({
      query: "Netanyahuda bloğuda ilk oylamada",
      terms: ["netanyahu", "blogu", "oylama"],
    });
    expect(searchFoldedSiblingParts("İSTANBUL KAZA")).toEqual({ query: "İSTANBUL KAZAda", terms: ["kaza"] });
    expect(searchFoldedSiblingParts("toplantı")).toEqual({ query: "toplantıda", terms: ["toplanti"] });
  });

  it("is null for a websearch query and when no term changes", () => {
    for (const q of ['"tokat kaza"', "-kaza", "bolu -kaza", "kaza or oylama", "erdoğan", "", "   ", "zam"]) {
      expect(searchFoldedSiblingParts(q), q).toBeNull();
    }
  });

  it("searchFoldedSibling is its `query`, byte for byte, for every shape", () => {
    for (const q of [
      "bolu kaza",
      "meclis oylama",
      "toplantı",
      "netanyahu bloğu ilk oylama",
      "BOLU KAZA",
      "elektrik zammı",
      "e-posta",
      "e-okul",
      '"bolu kaza"',
      "erdoğan",
      "",
    ]) {
      expect(searchFoldedSibling(q), q).toBe(searchFoldedSiblingParts(q)?.query ?? null);
    }
  });

  it("has one term per changed word, in query order, and never more than the 6-term bound", () => {
    const parts = searchFoldedSiblingParts("bolu kaza trump erdoğan zam toplantı")!;
    expect(parts.terms).toEqual(["bolu", "kaza", "toplanti"]);
    expect(parts.terms.length).toBeLessThanOrEqual(MAX_SEARCH_TERMS);
  });
});

// h157-search-3: 'e-posta' is stored as the lexeme 'e-pos' but every inflected form as 'e-posta', so the
// bare compound found 1 story where 7 hold the word. withLocative takes ONE letter, a hyphen and a tail of 3
// letters or more that ends in a vowel, so the second call asks for 'e-postada'.
describe("searchFoldedSibling: a one-letter hyphen compound (h157-search-3)", () => {
  it.each([
    ["e-posta", "e-postada"],
    ["E-Posta", "E-Postada"],
    ["e-fatura", "e-faturada"],
    ["e-vize", "e-vizede"],
    // 'adres' ends in a consonant and is left as typed; 'adresi' is a plain vowel-final word of 6 letters, so it gets its own
    // locative under the existing rule, exactly as 'zammı' does in 'elektrik zammı'.
    ["e-posta adres", "e-postada adres"],
    ["e-posta adresi", "e-postada adreside"],
    ["e-imza", "e-imzada"],
    ["e-ticaret ve e-posta", "e-ticaret ve e-postada"],
  ])("%j -> %j", (q, folded) => {
    expect(searchFoldedSibling(q)).toBe(folded);
  });

  it("the term recorded for the witness is the folded original: 'e-posta'", () => {
    expect(searchFoldedSiblingParts("e-posta")).toEqual({ query: "e-postada", terms: ["e-posta"] });
    expect(searchFoldedSiblingParts("E-Posta adres")).toEqual({ query: "E-Postada adres", terms: ["e-posta"] });
    expect(searchFoldedSiblingParts("E-Posta adresi")).toEqual({
      query: "E-Postada adreside",
      terms: ["e-posta", "adresi"],
    });
  });

  it.each([
    "e-okul", // consonant-final
    "e-devlet", // consonant-final
    "f-16", // digits
    "s-400",
    "ab-cdef", // two letters before the hyphen
    "e-po", // the tail has fewer than 3 letters
    "e-pos",
    "a-b-cd", // a chain
    "e-posta-x1",
    "-e-posta", // a search operator
    "e-", // no tail
    "-posta",
    "e--posta",
    "e-posta-",
  ])("is null for %j", (q) => {
    expect(searchFoldedSibling(q), q).toBeNull();
  });

  it("a hyphen compound keeps every other rule: the plain word, the digits, the 64-character bound", () => {
    expect(searchFoldedSibling("ak-parti")).toBeNull();
    expect(searchFoldedSibling("kaza")).toBe("kazada");
    expect(searchFoldedSibling("e-" + "a".repeat(80))).toBeNull();
  });

  it("is linear in a long run of hyphen compounds (CPU-time ladder)", () => {
    expectLinear(
      (n) => ({ many: rep("e-posta ", "", "e-posta")(n), hyphens: rep("e-", "", "posta")(n) }),
      (q) => {
        expect(searchFoldedSibling(q.many)).not.toBeNull();
        expect(searchFoldedSibling(q.hyphens)).toBeNull();
      },
      { n: 200_000, ceilingMs: 8_000 },
    );
  });
});
