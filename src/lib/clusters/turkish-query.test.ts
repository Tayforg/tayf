import { describe, it, expect } from "vitest";

import { RISING_FOLD_FROM, RISING_FOLD_TO } from "@/lib/trends/rising-entities";
import {
  MAX_QUERY_VARIANTS,
  MAX_SEARCH_QUERY_LENGTH,
  MAX_SEARCH_TERMS,
  SEARCH_FOLD_FROM,
  SEARCH_FOLD_TO,
  canonicalSearchQuery,
  foldTr,
  normaliseSearchQuery,
  pgLower,
  searchQueryCut,
  searchQueryWasShortened,
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
    // No apostrophes: normaliseSearchQuery's apostrophe rule peels one
    // apostrophe per pass from a stacked run ("ş''z" -> "ş'z" -> "ş"), so it is
    // not idempotent on that input. That predates this function and does not
    // matter for the key (searchClusters applies it once), but it would make
    // this property fail for a reason unrelated to the canonical form.
    const alphabet = [
      "a", "b", "z", "I", "İ", "ı", "ş", "Ğ", "1", " ", " ", " ", ".", ",", "!", "?",
      "“", "-", '"', "(", ")", "$", "\u{1F600}", "\u{1F525}", "\u0000", "\ud83d", "\t",
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
