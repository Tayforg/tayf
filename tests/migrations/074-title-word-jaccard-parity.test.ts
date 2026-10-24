import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  SQL_SPLIT_EXTRA_CHARS,
  SQL_TRANSLATE_FROM,
  SQL_TRANSLATE_TO,
  TITLE_SPLIT_RE,
  TITLE_TWIN_MIN_JACCARD,
  titleWordJaccard,
} from "../../supabase/functions/_shared/rss/title-jaccard.ts";

// ---------------------------------------------------------------------------
// Parity: `titleWordJaccard` (Deno, supabase/functions/_shared/rss/
// title-jaccard.ts) must give the same number as SQL `public.title_word_jaccard`
// (migration 074, section 4). The ingest twin drop uses the TS copy to decide
// whether a re-used CMS id carries the same story; the SQL copy gates the
// headline write-back with the same 0.2.
//
//   (i)   the literals in the SQL function are read out of the migration and
//         compared with the exported constants, so the two cannot drift;
//   (ii)  a table of pairs whose expected values were produced by Postgres
//         (see "where the numbers come from" below);
//   (iii) every BMP code point is checked against the set prod's regexp split
//         treats as a separator.
//
// Where the numbers come from (2026-10-24). The function block of 074 was
// created on a throwaway local Postgres 15 (initdb --locale=en_US.UTF-8
// --encoding=UTF8, run twice, same output) and on prod (Postgres 17.6, ICU
// locale provider, datcollate = datctype = en_US.UTF-8) with read-only
// SELECTs. The two agree on every pair below except the ones marked PROD-ONLY:
// the local server is macOS libc, which also counts the ASCII symbols
// $ + < = > ^ ` | ~ as [:punct:] and has no ICU final-sigma rule. The TS
// function mirrors PROD, so a PROD-ONLY value is the prod one.
//
// Two facts the migration comment gets wrong, both measured on prod:
//   - lower() is NOT a no-op on non-ASCII. lower('CAFÉ') = 'café', so
//     CAFÉ vs café is 1, and lower() on the whole string applies the Greek
//     final-sigma rule (ICU u_strToLower). translate() is still needed: it
//     turns the Turkish capitals into the lower-case letters ICU's root rules
//     would not (I -> i, not ı; İ -> i, not "i" + U+0307).
//   - [:space:] / [:punct:] are ICU u_isspace / u_ispunct, i.e. Unicode
//     White_Space (plus U+001C..U+001F) and general category P*. They are not
//     the ASCII classes: NBSP and the middle dot split, the symbols
//     $ + < = > ^ ` | ~ do not.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATION = resolve(REPO_ROOT, "supabase", "migrations", "074_ingest_fixes.sql");

function functionBlock(sql: string): string {
  const m = sql.match(
    /create\s+or\s+replace\s+function\s+public\.title_word_jaccard\s*\([\s\S]*?\$\$[\s\S]*?\$\$\s*;/i,
  );
  if (!m) throw new Error("public.title_word_jaccard not found in 074");
  return m[0];
}

describe("074 title_word_jaccard: the SQL literals equal the TS constants", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  const block = functionBlock(sql);
  // Prose can never satisfy a code guard: look at the function with `--` comments gone.
  const code = block.replace(/--[^\n]*/g, "");

  it("calls translate() on both titles with exactly SQL_TRANSLATE_FROM / SQL_TRANSLATE_TO", () => {
    const re =
      /pg_catalog\.translate\(\s*coalesce\(\s*p_([ab])\s*,\s*''\s*\)\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/g;
    const calls = [...code.matchAll(re)];
    expect(calls.map((c) => c[1])).toEqual(["a", "b"]);
    for (const c of calls) {
      expect(c[2]).toBe(SQL_TRANSLATE_FROM);
      expect(c[3]).toBe(SQL_TRANSLATE_TO);
    }
  });

  it("applies lower() to the translated text (whole string, translate first)", () => {
    expect(code.match(/pg_catalog\.lower\(\s*pg_catalog\.translate\(/g)).toHaveLength(2);
  });

  it("splits both titles on the same class: [[:space:][:punct:]<SQL_SPLIT_EXTRA_CHARS>]+", () => {
    const re = /pg_catalog\.regexp_split_to_table\(\s*[\s\S]*?\)\s*,\s*'([^']*)'\s*\)/g;
    const classes = [...code.matchAll(re)].map((m) => m[1]);
    expect(classes).toHaveLength(2);
    for (const c of classes) expect(c).toBe(`[[:space:][:punct:]${SQL_SPLIT_EXTRA_CHARS}]+`);
  });

  it("builds the TS regex from the same explicit characters", () => {
    expect(TITLE_SPLIT_RE.source).toContain(SQL_SPLIT_EXTRA_CHARS);
    expect(TITLE_SPLIT_RE.flags).toBe("u");
  });

  it("drops empty tokens, dedups per side and rounds the ratio to 3 decimals", () => {
    expect(code).toMatch(/select\s+distinct\s+t\s+as\s+tok/i);
    expect(code.match(/where\s+t\s*<>\s*''/gi)).toHaveLength(2);
    expect(code).toMatch(/round\(\s*\(select n from inter\)::numeric\s*\/\s*\(select n from uni\)::numeric\s*,\s*3\s*\)/i);
    expect(code).toMatch(/when\s*\(select n from uni\)\s*=\s*0\s*then\s*0/i);
  });

  it("gates the write-back with the same 0.2 the TS twin check uses", () => {
    const gates = [...sql.matchAll(/title_word_jaccard\(i\.old_title,\s*i\.new_title\)\s*>=\s*([0-9.]+)/g)];
    expect(gates.length).toBeGreaterThanOrEqual(1);
    for (const g of gates) expect(Number(g[1])).toBe(TITLE_TWIN_MIN_JACCARD);
  });
});

// ---------------------------------------------------------------------------
// (ii) values produced by Postgres.
// ---------------------------------------------------------------------------

const TITLE_A = "Bakan Güler'den Mekke ittifakı vurgusu";
const TITLE_B = "Bakan Güler: Husilerle çatışmaya girilmeyecek";
const TITLE_C = "Bakan Güler: üçüncü başlık";

type Pair = readonly [label: string, a: string | null, b: string | null, expected: number];

const PAIRS: readonly Pair[] = [
  ["identical", TITLE_B, TITLE_B, 1],
  ["both empty", "", "", 0],
  ["null vs text", null, "Bakan Güler", 0],
  ["both null", null, null, 0],
  ["İSTANBUL'da vs istanbul'da", "İSTANBUL'da", "istanbul'da", 1],
  [
    "guillemets, curly quotes, ellipsis, dashes",
    "«Merhaba» “dünya” – ‘evet’ … hayır — bitti",
    "merhaba dünya evet hayır bitti",
    1,
  ],
  ["digits, order, a shorter word", "2026 bütçesi 15 milyar", "15 milyar 2026 bütçe", 0.6],
  ["ÖZEL vs özel", "ÖZEL", "özel", 1],
  ["CAFÉ vs café (lower() is not ASCII-only on prod)", "CAFÉ", "café", 1],
  ["IŞIK vs ışık (I and ı both become i)", "IŞIK", "ışık", 1],
  ["Turkish capitals", "ÇŞĞÜÖ âîû", "çşğüö âîû", 1],
  ["distinct sets", "a a b", "a b b c", 0.667],
  ["ingest.test TITLE_A / TITLE_B", TITLE_A, TITLE_B, 0.222],
  ["ingest.test TITLE_A / TITLE_C", TITLE_A, TITLE_C, 0.25],
  ["ingest.test TITLE_B / TITLE_C", TITLE_B, TITLE_C, 0.286],
  [
    "reuse: aksam 1708103",
    "Trabzonspor, Hearts maçına hazır",
    "Fenerbahçe'de derbi mesaisi ara vermeden başladı",
    0,
  ],
  [
    "reuse: odatv 120168027",
    "Eski SPK Başkanı Erman Çete'ye gözaltı kararı",
    "Feridun Geçgel ve Enver Geçgel 5 milyar TL iade etti",
    0,
  ],
  [
    "reuse: yenicag 1084546",
    "Arnavutköy'de okullara 10 bin parça spor malzemesi desteği",
    "Kartal'da kahkaha fırtınası: Ruh Salatası oyunu",
    0,
  ],
  ["no-break space is a separator", "Dolar 32 TL", "dolar 32 tl", 1],
  ["middle dot is a separator", "Ahmet·Mehmet", "ahmet mehmet", 1],
  ["slash is a separator", "Dolar/TL", "dolar tl", 1],
  ["Greek", "ΑΘΗΝΑ", "αθηνα", 1],
  ["Cyrillic", "МОСКВА", "москва", 1],
  ["emoji stay inside a token", " 😀 haber 😀", "haber", 0.5],
  ["SQL-looking text", "x'; drop table a;--", "x drop table a", 1],
  ["half-way rounds up: 1/16", "w1 w2 w3 w4 w5 w6 w7 w8", "w1 x2 x3 x4 x5 x6 x7 x8 x9", 0.063],
  ["half-way rounds up: 3/16", "w1 w2 w3 w4 w5 w6 w7 w8", "w1 w2 w3 x4 x5 x6 x7 x8 x9 x10 x11", 0.188],
  ["exactly the 0.2 gate", "a b c", "a d e", 0.2],
  ["just under the gate", "a b c", "a d e f", 0.167],
  // PROD-ONLY (local macOS libc differs, see the header).
  ["PROD-ONLY: $ and | do not split", "$100 | euro", "100 euro", 0.25],
  ["PROD-ONLY: + does not split", "A+B", "a b", 0],
  ["PROD-ONLY: ICU final sigma", "ΟΔΟΣ", "οδοσ", 0],
  ["PROD-ONLY: ICU final sigma, lowered form", "ΟΔΟΣ", "οδος", 1],
];

describe("074 title_word_jaccard: pairs computed by Postgres", () => {
  it("holds a decent number of pairs", () => {
    expect(PAIRS.length).toBeGreaterThanOrEqual(14);
  });

  it.each(PAIRS)("%s", (_label, a, b, expected) => {
    expect(titleWordJaccard(a, b)).toBe(expected);
    // The function is symmetric, so the swapped pair is the same number.
    expect(titleWordJaccard(b, a)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// (iii) the separator set, code point by code point.
//
// `SEPARATORS` is the set of BMP code points for which prod's
//   regexp_split_to_array('a' || chr(cp) || 'b', '[[:space:][:punct:]“”‘’«»…–—]+')
// returned two elements (read-only SELECT, 2026-10-24; 654 code points), as
// hex ranges. It is ICU u_isspace + u_ispunct plus the explicit characters.
// ---------------------------------------------------------------------------

const SEPARATORS =
  "9-d,1c-23,25-2a,2c-2f,3a-3b,3f-40,5b-5d,5f,7b,7d,85,a0-a1,a7,ab,b6-b7,bb,bf,37e,387,55a-55f,589-58a,5be,5c0,5c3,5c6,5f3-5f4,609-60a,60c-60d,61b,61d-61f,66a-66d,6d4,700-70d,7f7-7f9,830-83e,85e,964-965,970,9fd,a76,af0,c77,c84,df4,e4f,e5a-e5b,f04-f12,f14,f3a-f3d,f85,fd0-fd4,fd9-fda,104a-104f,10fb,1360-1368,1400,166e,1680,169b-169c,16eb-16ed,1735-1736,17d4-17d6,17d8-17da,1800-180a,1944-1945,1a1e-1a1f,1aa0-1aa6,1aa8-1aad,1b5a-1b60,1b7d-1b7e,1bfc-1bff,1c3b-1c3f,1c7e-1c7f,1cc0-1cc7,1cd3,2000-200a,2010-2029,202f-2043,2045-2051,2053-205f,207d-207e,208d-208e,2308-230b,2329-232a,2768-2775,27c5-27c6,27e6-27ef,2983-2998,29d8-29db,29fc-29fd,2cf9-2cfc,2cfe-2cff,2d70,2e00-2e2e,2e30-2e4f,2e52-2e5d,3000-3003,3008-3011,3014-301f,3030,303d,30a0,30fb,a4fe-a4ff,a60d-a60f,a673,a67e,a6f2-a6f7,a874-a877,a8ce-a8cf,a8f8-a8fa,a8fc,a92e-a92f,a95f,a9c1-a9cd,a9de-a9df,aa5c-aa5f,aade-aadf,aaf0-aaf1,abeb,fd3e-fd3f,fe10-fe19,fe30-fe52,fe54-fe61,fe63,fe68,fe6a-fe6b,ff01-ff03,ff05-ff0a,ff0c-ff0f,ff1a-ff1b,ff1f-ff20,ff3b-ff3d,ff3f,ff5b,ff5d,ff5f-ff65";

// Code points TS (Node's ICU) splits on that prod's older data does not: Balinese
// punctuation added in Unicode 16 (U+1B4E, U+1B4F, U+1B7F). Skipped, either way.
const UNICODE_VERSION_SKEW = new Set([0x1b4e, 0x1b4f, 0x1b7f]);

function parseRanges(spec: string): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const [lo, hi] = part.split("-");
    const from = parseInt(lo as string, 16);
    const to = parseInt((hi ?? lo) as string, 16);
    for (let cp = from; cp <= to; cp++) out.add(cp);
  }
  return out;
}

describe("074 title_word_jaccard: separator set over the BMP", () => {
  const prod = parseRanges(SEPARATORS);

  it("snapshot has the 654 code points prod reported", () => {
    expect(prod.size).toBe(654);
  });

  it("splits on exactly the code points prod splits on", () => {
    const wrong: string[] = [];
    for (let cp = 1; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue; // lone surrogates
      if (UNICODE_VERSION_SKEW.has(cp)) continue;
      // 'a<c>b' vs 'a b': both are {a, b} when c splits, {a<c>b} vs {a, b} when not.
      const splits = titleWordJaccard(`a${String.fromCodePoint(cp)}b`, "a b") === 1;
      if (splits !== prod.has(cp)) {
        wrong.push(`U+${cp.toString(16).toUpperCase().padStart(4, "0")} ts=${splits} prod=${prod.has(cp)}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
