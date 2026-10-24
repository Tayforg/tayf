import { describe, expect, it } from "vitest";

import {
  SQL_SPLIT_EXTRA_CHARS,
  SQL_TRANSLATE_FROM,
  SQL_TRANSLATE_TO,
  TITLE_SPLIT_RE,
  TITLE_TWIN_MIN_JACCARD,
  jaccardOfSets,
  titleTokens,
  titleWordJaccard,
} from "../../../supabase/functions/_shared/rss/title-jaccard.ts";

// ---------------------------------------------------------------------------
// The TS mirror of SQL `public.title_word_jaccard` (migration 074). The twin
// drop in `ingest` uses it to tell "the outlet edited this headline" (kept
// words) from "the CMS reused an article id for a different story" (no shared
// words). Behavioural cases live here; byte-for-byte parity with the SQL
// function (values computed by Postgres, the literals read out of the
// migration) lives in tests/migrations/074-title-word-jaccard-parity.test.ts.
// ---------------------------------------------------------------------------

const TITLE_A = "Bakan Güler'den Mekke ittifakı vurgusu";
const TITLE_B = "Bakan Güler: Husilerle çatışmaya girilmeyecek";
const TITLE_C = "Bakan Güler: üçüncü başlık";

describe("constants", () => {
  it("pins the twin threshold at 0.2 (the SQL write-back gate)", () => {
    expect(TITLE_TWIN_MIN_JACCARD).toBe(0.2);
  });

  it("keeps the translate() literals the same length (char for char)", () => {
    expect([...SQL_TRANSLATE_FROM]).toHaveLength(11);
    expect([...SQL_TRANSLATE_TO]).toHaveLength(11);
  });

  it("exports a split regex that is not global (no lastIndex state between calls)", () => {
    expect(TITLE_SPLIT_RE.global).toBe(false);
    expect(TITLE_SPLIT_RE.sticky).toBe(false);
    for (const ch of SQL_SPLIT_EXTRA_CHARS) expect(TITLE_SPLIT_RE.test(ch)).toBe(true);
  });
});

describe("titleWordJaccard: identity, emptiness, nulls", () => {
  it("is 1 for identical titles", () => {
    expect(titleWordJaccard(TITLE_A, TITLE_A)).toBe(1);
  });

  it("is 0 for two empty strings (empty union is 0, not NaN)", () => {
    expect(titleWordJaccard("", "")).toBe(0);
  });

  it("is 0 for null / undefined in either position", () => {
    expect(titleWordJaccard(null, TITLE_A)).toBe(0);
    expect(titleWordJaccard(TITLE_A, undefined)).toBe(0);
    expect(titleWordJaccard(null, null)).toBe(0);
    expect(titleWordJaccard(undefined, undefined)).toBe(0);
  });

  it("is 0 for one empty side", () => {
    expect(titleWordJaccard("", TITLE_A)).toBe(0);
    expect(titleWordJaccard(TITLE_A, "   ")).toBe(0);
  });

  it("is 0 for punctuation-only input (no tokens survive the split)", () => {
    expect(titleWordJaccard("... --- !!!", "“” «» –—")).toBe(0);
  });

  it("is symmetric", () => {
    expect(titleWordJaccard(TITLE_A, TITLE_B)).toBe(titleWordJaccard(TITLE_B, TITLE_A));
    expect(titleWordJaccard(TITLE_A, TITLE_C)).toBe(titleWordJaccard(TITLE_C, TITLE_A));
  });
});

describe("titleWordJaccard: values (3 decimals, distinct word sets)", () => {
  it("rounds to three decimals like SQL round(.., 3)", () => {
    // |A n B| = 2 (bakan, güler), |A u B| = 9
    expect(titleWordJaccard(TITLE_A, TITLE_B)).toBe(0.222);
    // 2 / 8
    expect(titleWordJaccard(TITLE_A, TITLE_C)).toBe(0.25);
    // 2 / 7
    expect(titleWordJaccard(TITLE_B, TITLE_C)).toBe(0.286);
  });

  it("compares word SETS: repeats do not count twice", () => {
    expect(titleWordJaccard("a a b", "a b b c")).toBe(0.667);
  });

  it("is order-insensitive", () => {
    expect(titleWordJaccard("2026 bütçesi 15 milyar", "15 milyar 2026 bütçe")).toBe(0.6);
  });

  it("rounds a half-way value up, as numeric round() does (1/16 = 0.0625 -> 0.063)", () => {
    // inter 1, union 8 + 9 - 1 = 16
    expect(titleWordJaccard("w1 w2 w3 w4 w5 w6 w7 w8", "w1 x2 x3 x4 x5 x6 x7 x8 x9")).toBe(0.063);
    // inter 3, union 8 + 11 - 3 = 16: 3/16 = 0.1875 -> 0.188
    expect(
      titleWordJaccard("w1 w2 w3 w4 w5 w6 w7 w8", "w1 w2 w3 x4 x5 x6 x7 x8 x9 x10 x11"),
    ).toBe(0.188);
  });
});

describe("titleWordJaccard: case folding", () => {
  it("lower-cases ASCII", () => {
    expect(titleWordJaccard("BAKAN GÜLER", "bakan güler")).toBe(1);
  });

  it("maps Turkish dotted/dotless I and the capital Turkish letters before lowering", () => {
    expect(titleWordJaccard("İSTANBUL'da", "istanbul'da")).toBe(1);
    expect(titleWordJaccard("IŞIK", "ışık")).toBe(1);
    expect(titleWordJaccard("ÇŞĞÜÖ ÂÎÛ", "çşğüö âîû")).toBe(1);
  });

  it("lower-cases non-ASCII letters too, as prod does (ICU lower(), not a C ctype)", () => {
    // The comment in migration 074 assumes `lower()` is a no-op on non-ASCII
    // under a C ctype. Prod (Postgres 17, ICU provider, en_US.UTF-8) lowers
    // every script: CAFÉ and café match.
    expect(titleWordJaccard("CAFÉ", "café")).toBe(1);
    expect(titleWordJaccard("ΑΘΗΝΑ", "αθηνα")).toBe(1);
    expect(titleWordJaccard("МОСКВА", "москва")).toBe(1);
  });

  it("lowers the whole string, so the Greek final-sigma rule applies like ICU u_strToLower", () => {
    expect(titleWordJaccard("ΟΔΟΣ", "οδος")).toBe(1);
    expect(titleWordJaccard("ΟΔΟΣ", "οδοσ")).toBe(0);
  });
});

describe("titleWordJaccard: separators", () => {
  it("splits on ASCII spaces and punctuation", () => {
    expect(titleWordJaccard("Güler'den, Mekke: ittifak!", "güler den mekke ittifak")).toBe(1);
    expect(titleWordJaccard("Dolar/TL", "dolar tl")).toBe(1);
  });

  it("splits on curly quotes, guillemets, ellipsis and dashes", () => {
    expect(
      titleWordJaccard(
        "«Merhaba» “dünya” – ‘evet’ … hayır — bitti",
        "merhaba dünya evet hayır bitti",
      ),
    ).toBe(1);
  });

  it("splits on a no-break space and a middle dot, which prod's [:space:]/[:punct:] cover", () => {
    expect(titleWordJaccard("Dolar 32 TL", "dolar 32 tl")).toBe(1);
    expect(titleWordJaccard("Ahmet·Mehmet", "ahmet mehmet")).toBe(1);
  });

  it("does NOT split on ASCII symbols that prod's [:punct:] leaves alone ($ + < = > ^ ` | ~)", () => {
    expect(titleWordJaccard("A+B", "a b")).toBe(0);
    expect(titleWordJaccard("$100 | euro", "100 euro")).toBe(0.25);
  });

  it("keeps an emoji inside a token instead of dropping it", () => {
    expect(titleWordJaccard(" 😀 haber 😀", "haber")).toBe(0.5);
  });

  it("is safe on SQL-looking text", () => {
    expect(titleWordJaccard("x'; drop table a;--", "x drop table a")).toBe(1);
  });
});

describe("titleWordJaccard vs the twin threshold", () => {
  it("passes at exactly 0.2 (>= is inclusive): 1 shared word of 5", () => {
    const j = titleWordJaccard("a b c", "a d e");
    expect(j).toBe(0.2);
    expect(j >= TITLE_TWIN_MIN_JACCARD).toBe(true);
  });

  it("fails just below it: 1 shared word of 6", () => {
    const j = titleWordJaccard("a b c", "a d e f");
    expect(j).toBe(0.167);
    expect(j >= TITLE_TWIN_MIN_JACCARD).toBe(false);
  });

  it.each([
    [
      "aksam 1708103",
      "Trabzonspor, Hearts maçına hazır",
      "Fenerbahçe'de derbi mesaisi ara vermeden başladı",
    ],
    [
      "odatv 120168027",
      "Eski SPK Başkanı Erman Çete'ye gözaltı kararı",
      "Feridun Geçgel ve Enver Geçgel 5 milyar TL iade etti",
    ],
    [
      "yenicag 1084546",
      "Arnavutköy'de okullara 10 bin parça spor malzemesi desteği",
      "Kartal'da kahkaha fırtınası: Ruh Salatası oyunu",
    ],
  ])("scores a CMS-id reuse (%s) at 0, far below the gate", (_label, a, b) => {
    expect(titleWordJaccard(a, b)).toBe(0);
  });

  it("keeps a real headline edit above the gate (kept words)", () => {
    expect(titleWordJaccard(TITLE_A, TITLE_B)).toBeGreaterThanOrEqual(TITLE_TWIN_MIN_JACCARD);
    expect(titleWordJaccard(TITLE_A, TITLE_C)).toBeGreaterThanOrEqual(TITLE_TWIN_MIN_JACCARD);
    expect(titleWordJaccard(TITLE_B, TITLE_C)).toBeGreaterThanOrEqual(TITLE_TWIN_MIN_JACCARD);
  });
});

describe("titleWordJaccard: size", () => {
  it("handles 10k-word titles quickly", () => {
    const words = Array.from({ length: 10_000 }, (_, i) => `kelime${i}`);
    const a = words.join(" ");
    const b = words.slice(5_000).concat(words.slice(0, 5_000).map((w) => `${w}x`)).join(" ");
    const t0 = performance.now();
    const j = titleWordJaccard(a, b);
    const ms = performance.now() - t0;
    // 5,000 shared words, 15,000 in the union.
    expect(j).toBe(0.333);
    expect(ms).toBeLessThan(500);
  });
});

describe("titleTokens / jaccardOfSets: the pre-tokenized form the ingest gate uses", () => {
  it("titleTokens returns the distinct lower-cased words, translate() applied", () => {
    expect([...titleTokens("Bakan Güler: BAKAN IŞIK, İzmir!")].sort()).toEqual(
      ["bakan", "güler", "işik", "izmir"].sort(),
    );
  });

  it("titleTokens is empty for null, undefined, blank and punctuation-only input", () => {
    for (const v of [null, undefined, "", "   ", "... --- !!!"]) {
      expect(titleTokens(v).size).toBe(0);
    }
  });

  it("jaccardOfSets equals titleWordJaccard for every pair of the fixtures", () => {
    const titles = [TITLE_A, TITLE_B, TITLE_C, "", "Kafe CAFÉ café", "ırmak IRMAK", null, undefined];
    for (const a of titles) {
      for (const b of titles) {
        expect(jaccardOfSets(titleTokens(a), titleTokens(b))).toBe(titleWordJaccard(a, b));
      }
    }
  });

  it("jaccardOfSets is 0 for two empty sets and does not mutate its inputs", () => {
    expect(jaccardOfSets(new Set(), new Set())).toBe(0);
    const a = titleTokens(TITLE_A);
    const b = titleTokens(TITLE_B);
    const before = [[...a], [...b]];
    jaccardOfSets(a, b);
    expect([[...a], [...b]]).toEqual(before);
  });
});
