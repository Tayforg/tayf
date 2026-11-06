import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { expandAliasQuery } from "@/lib/clusters/search-aliases";
import { canonicalSearchQuery, foldTr, turkishQueryVariants } from "@/lib/clusters/turkish-query";
import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Contract test for migration 166 ("search over-stem guard"), h50-search-1, modelled on
// 129-search-fold-rank.test.ts.
//
// The Turkish snowball stemmer cuts some words down to two or three letters, so a rare word's stem is
// shared with unrelated common words: burdur -> 'bur' (Bursa, Bulgaristan, 'burun buruna'), ersan -> 'er'
// ('erken secim', 'sona erdi', 'Ersin Tatar'), ilhan -> 'ilha' (Ilham Aliyev), iğdır -> 'ık'/'ik'/'igi'.
// 129 made every stem hit a candidate and let the literal word-start tier only RE-ORDER, so
// LIMIT 24 was filled from the stem-only tail ('burdur': 14 Bursa stories among the 24).
//
// 166 replaces search_cluster_ids(text[], text, integer) with 129's body plus one guard: a typed word whose
// stem over-cuts it (the stem is shorter than the word and at most 4 characters long) must have its prefix
// (one letter past the stem, at least 4 letters) at a word start in the title or summary of every kept row.
// Everything else is 129's text, byte for byte.
//
// Two review fixes are pinned here as well. (1) A word whose 3-4 letter stem is its own root followed by a case or
// plural suffix (irakta -> irak, kirada -> kira, natonun -> nato, faize -> faiz, zamlar -> zam, ilaci -> ilaç) is NOT
// guarded: the root is the word, the suffix is only grammar, and guarding it emptied the archive for normal
// apostrophe-less queries. (2) Each candidate folds its title once and its summary plus neutral title at most once,
// whatever the number of guard words (SEC-h50-1: a repeated word used to multiply the folds).
//
// This file pins, without a database: the ledger row, the single transaction, additive-only SQL, that the
// replaced function keeps 129's signature, language, volatility, security and grants (and that 129's body is
// the production body, by md5), that the new body is 129's body with exactly the two guard CTEs added
// and `top` re-pointed, every detail of the guard, the dry-run and the live-manifest entry. The opt-in
// live block (TAYF_PSQL) runs the function before and after applying 166 on a throwaway Postgres.
//
// No regular expression is applied to quoted SQL literals in this file: CodeQL's js/redos flags nested
// repetition over them even in tests, so the SQL is scanned with indexOf and character loops.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATION_166 = resolve(ROOT, "supabase", "migrations", "166_search_overstem_guard.sql");
const MIGRATION_129 = resolve(ROOT, "supabase", "migrations", "129_search_fold_rank.sql");
const DRYRUN_166 = resolve(ROOT, "tests", "migrations", "sql", "166-search-overstem-guard-dryrun.sql");
const SETUP_166 = resolve(ROOT, "tests", "migrations", "sql", "166-search-overstem-guard-setup.sql");
const MANIFEST = resolve(ROOT, "tests", "migrations", "sql", "live-manifest.txt");

/** md5 and length of production's prosrc for search_cluster_ids(text[], text, integer), read-only 2026-11-06. */
const PROD_BODY_MD5 = "cb7fee8680c50e8f20bafab3e29fef39";
const PROD_BODY_LENGTH = 3426;

// --- plain-text SQL helpers (indexOf and character loops, no regular expression over SQL) ----------

/** Strip `--` line comments so prose can never satisfy a code guard. */
function stripComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const at = line.indexOf("--");
      return at < 0 ? line : line.slice(0, at);
    })
    .join("\n");
}

/** Every single-quoted string literal replaced by '' ('' inside a literal is an escaped quote). */
function sansStrings(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    if (sql[i] !== "'") {
      out += sql[i];
      i++;
      continue;
    }
    i++;
    while (i < sql.length) {
      if (sql[i] === "'") {
        if (sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        break;
      }
      i++;
    }
    i++;
    out += "''";
  }
  return out;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** The `create or replace function public.<name>(...) ... $fn$ ... $fn$;` statement. */
function functionBlock(sql: string, name: string): string {
  // case-sensitive on purpose: toLowerCase() changes the length of "İ", which would shift every offset
  const start = sql.indexOf(`create or replace function public.${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  const open = sql.indexOf("$fn$", start);
  const close = sql.indexOf("$fn$", open + 4);
  const end = sql.indexOf(";", close);
  if (open < 0 || close < 0 || end < 0) throw new Error(`function ${name} has no $fn$ body`);
  return sql.slice(start, end + 1);
}

/** Everything before `as $fn$`: signature, return shape, attributes. */
function fnHeader(block: string): string {
  return block.slice(0, block.indexOf("as $fn$"));
}

/** Only the SQL body between the $fn$ quotes. */
function fnBody(block: string): string {
  const open = block.indexOf("$fn$") + 4;
  return block.slice(open, block.indexOf("$fn$", open));
}

/** Split on commas that sit outside any parentheses and string literal. */
function topLevelSplit(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") inStr = !inStr;
    else if (inStr) continue;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.map((p) => p.trim());
}

/** The argument lists of every `<fn>(...)` call in `src`, found with balanced parentheses. */
function callArgs(src: string, fn: string): string[][] {
  const out: string[][] = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf(`${fn}(`, from);
    if (at < 0) return out;
    let depth = 1;
    let inStr = false;
    let i = at + fn.length + 1;
    const start = i;
    for (; i < src.length && depth > 0; i++) {
      const ch = src[i];
      if (ch === "'") inStr = !inStr;
      else if (!inStr && ch === "(") depth++;
      else if (!inStr && ch === ")") depth--;
    }
    out.push(topLevelSplit(src.slice(start, i - 1)));
    from = i;
  }
}

function countOf(haystack: string, needle: string): number {
  let n = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return n;
    n++;
    from = at + needle.length;
  }
}

/** `s` without the text from the first `from` up to (not including) the next `to`. */
function excise(s: string, from: string, to: string): string {
  const a = s.indexOf(from);
  const b = s.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`cannot excise ${from} .. ${to}`);
  return s.slice(0, a) + s.slice(b);
}

function md5(s: string): string {
  return createHash("md5").update(s, "utf8").digest("hex");
}

let sql = "";
let code = "";
let head = "";
let fn166 = "";
let fn129 = "";
let body166 = "";
let body129 = "";
/** The bodies as the database stores them (prosrc): comments included. */
let raw166 = "";
let raw129 = "";
let cb166 = "";
let cb129 = "";

beforeAll(() => {
  sql = readFileSync(MIGRATION_166, "utf8");
  code = stripComments(sql);
  head = sql.slice(0, sql.indexOf("\nbegin;"));
  fn166 = functionBlock(code, "search_cluster_ids");
  const sql129 = readFileSync(MIGRATION_129, "utf8");
  const code129 = stripComments(sql129);
  fn129 = functionBlock(code129, "search_cluster_ids");
  raw166 = fnBody(functionBlock(sql, "search_cluster_ids"));
  raw129 = fnBody(functionBlock(sql129, "search_cluster_ids"));
  body166 = fnBody(fn166);
  body129 = fnBody(fn129);
  cb166 = collapse(body166);
  cb129 = collapse(body129);
});

describe("166 ledger and structure", () => {
  it("contains the ledger insert for '166' with on conflict do nothing, the last statement before commit", () => {
    const c = collapse(code);
    const insert =
      "insert into supabase_migrations.schema_migrations (version, name) values ('166', '166_search_overstem_guard') on conflict do nothing;";
    expect(c).toContain(insert);
    expect(c.endsWith(`${insert} commit;`)).toBe(true);
  });

  it("is wrapped in a single begin/commit and sets lock_timeout 5s / statement_timeout 60s first", () => {
    const c = collapse(code);
    expect(countOf(c, "begin;")).toBe(1);
    expect(countOf(c, "commit;")).toBe(1);
    expect(c.startsWith("begin; set local lock_timeout = '5s'; set local statement_timeout = '60s'; ")).toBe(true);
    expect(c.endsWith("commit;")).toBe(true);
  });

  it("is additive only: no drop, alter, truncate, update, delete, create table or index (outside string literals)", () => {
    const bare = sansStrings(code).toLowerCase();
    for (const bad of [
      "drop ",
      "alter ",
      "truncate",
      "delete ",
      "update ",
      "create table",
      "create index",
      "create unique",
      "create trigger",
      "create view",
      "create extension",
    ]) {
      expect(bare.includes(bad), bad).toBe(false);
    }
    // the only insert is the ledger row
    expect(countOf(bare, "insert into ")).toBe(1);
    expect(bare).toContain("insert into supabase_migrations.schema_migrations");
  });

  it("grants no table, sequence or schema privilege", () => {
    const bare = sansStrings(code).toLowerCase();
    expect(bare).not.toContain("on table");
    expect(bare).not.toContain("on all tables");
    expect(bare).not.toContain("on sequence");
    expect(bare).not.toContain("on schema");
  });

  it("reloads the PostgREST schema cache, before the ledger insert", () => {
    const c = collapse(code);
    expect(c).toContain("notify pgrst, 'reload schema';");
    expect(c.indexOf("notify pgrst")).toBeLessThan(c.indexOf("insert into supabase_migrations"));
  });

  it("single-quote characters balance once comments are stripped (no string literal holds two dashes)", () => {
    expect(countOf(code, "'") % 2).toBe(0);
  });
});

describe("166 search_cluster_ids(text[], text, integer)", () => {
  it("is the only definition and has the 129 signature (create or replace, no drop, no new overload)", () => {
    expect(fn166.startsWith("create or replace function public.search_cluster_ids(p_variants text[], p_folded text, p_limit integer default 12)")).toBe(true);
    expect(countOf(code.toLowerCase(), "create or replace function")).toBe(1);
    expect(countOf(code.toLowerCase(), "create function")).toBe(0);
  });

  it("has exactly 129's header: returns table (id uuid), language sql, stable, security definer, search_path ''", () => {
    expect(collapse(fnHeader(fn166))).toBe(collapse(fnHeader(fn129)));
    const h = collapse(fnHeader(fn166));
    expect(h).toContain("returns table (id uuid)");
    expect(h).toContain("language sql");
    expect(h).toContain("stable");
    expect(h).toContain("security definer");
    expect(h).toContain("set search_path = ''");
    expect(h).not.toContain("volatile");
  });

  it("is revoked from public, anon and authenticated and granted to service_role only", () => {
    const c = collapse(code);
    expect(c).toContain(
      "revoke all on function public.search_cluster_ids(text[], text, integer) from public, anon, authenticated;",
    );
    expect(c).toContain("grant execute on function public.search_cluster_ids(text[], text, integer) to service_role;");
    expect(countOf(c, "grant ")).toBe(1);
    expect(c.indexOf("revoke all")).toBeLessThan(c.indexOf("grant execute"));
  });

  it("has a function comment that mentions the over-stem guard", () => {
    const c = collapse(code);
    const at = c.indexOf("comment on function public.search_cluster_ids(text[], text, integer) is");
    expect(at).toBeGreaterThan(-1);
    const comment = c.slice(at, c.indexOf("revoke all", at));
    expect(comment.toLowerCase()).toContain("guard");
    expect(comment).toContain("166");
    expect(comment).toContain("129");
    // the inflected-root exemption is part of the documented contract
    expect(comment).toContain("irakta");
    expect(comment.toLowerCase()).toContain("suffix");
  });

  it("every catalog function the body calls is schema-qualified (empty search_path), every cast names pg_catalog", () => {
    const bare = sansStrings(cb166);
    // least / greatest / coalesce / extract are SQL syntax, not functions: 129 leaves them bare too.
    const catalog = [
      "left",
      "length",
      "strpos",
      "lower",
      "translate",
      "regexp_replace",
      "regexp_split_to_table",
      "substr",
      "ts_lexize",
      "ts_rank_cd",
      "to_tsvector",
      "websearch_to_tsquery",
      "plainto_tsquery",
      "now",
      "btrim",
    ];
    for (const name of catalog) {
      let from = 0;
      for (;;) {
        const at = bare.indexOf(`${name}(`, from);
        if (at < 0) break;
        expect(at, `${name}( at ${at}`).toBeGreaterThanOrEqual(11);
        expect(bare.slice(at - 11, at), `${name}( at ${at}`).toBe("pg_catalog.");
        from = at + name.length;
      }
    }
    let from = 0;
    for (;;) {
      const at = bare.indexOf("tayf_search_fold(", from);
      if (at < 0) break;
      expect(bare.slice(at - 7, at), "tayf_search_fold( at " + at).toBe("public.");
      from = at + 1;
    }
    // casts: every `::` is followed by pg_catalog.
    from = 0;
    for (;;) {
      const at = bare.indexOf("::", from);
      if (at < 0) break;
      expect(bare.startsWith("::pg_catalog.", at), bare.slice(at, at + 20)).toBe(true);
      from = at + 2;
    }
  });
});

describe("166 body = 129's body plus the guard, nothing else", () => {
  it("129's body is the production body: its md5 and length are the recorded prosrc", () => {
    expect(md5(raw129)).toBe(PROD_BODY_MD5);
    expect(raw129.length).toBe(PROD_BODY_LENGTH);
  });

  it("removing the two guard CTEs and pointing `top` back at cand gives 129's body, character for character", () => {
    let b = cb166;
    b = excise(b, "), g0 as (", "), f as (");
    b = excise(b, "), kept as (", "), top as (");
    expect(b.includes("from kept k order by k.updated_at desc, k.id limit 1000")).toBe(true);
    b = b.replace("from kept k order by", "from cand k order by");
    expect(b).toBe(cb129);
  });

  it("the scoring, the ORDER BY and the limit clause are byte-identical to 129 (from `hits` on)", () => {
    const from = ", hits as (";
    expect(cb166.slice(cb166.indexOf(from))).toBe(cb129.slice(cb129.indexOf(from)));
    expect(cb166).toContain("limit greatest(1, least(coalesce(p_limit, 12), 50));");
  });

  it("the CTE order is f0, g0, g, f, q, cand, kept, top, hits", () => {
    const order = ["with f0 as (", "), g0 as (", "), g as (", "), f as (", "), q as (", "), cand as (", "), kept as (", "), top as (", "), hits as ("];
    let last = -1;
    for (const marker of order) {
      const at = cb166.indexOf(marker);
      expect(at, marker).toBeGreaterThan(last);
      last = at;
    }
  });

  it("`top` (the 1000 most recently updated) selects from the guarded CTE `kept`, never from cand", () => {
    expect(cb166).toContain("), top as ( select k.id from kept k order by k.updated_at desc, k.id limit 1000 )");
    expect(cb166).not.toContain("select k.id from cand k");
    // cand is read exactly once, by kept
    expect(countOf(cb166, "from cand ")).toBe(1);
    expect(cb166.indexOf("from cand ")).toBeGreaterThan(cb166.indexOf("), kept as ("));
    expect(cb166.indexOf("from cand ")).toBeLessThan(cb166.indexOf("), top as ("));
    // 129's cand CTE (the two UNION arms) is untouched
    const cand166 = cb166.slice(cb166.indexOf("), cand as ("), cb166.indexOf("), kept as ("));
    const cand129 = cb129.slice(cb129.indexOf("), cand as ("), cb129.indexOf("), top as ("));
    expect(cand166).toBe(cand129);
  });
});

describe("166 the guard", () => {
  // The guard is the text between `g0` and `f` (the word list) plus the `kept` CTE (the row check).
  const wordList = (): string => {
    const a = cb166.indexOf("), g0 as (");
    return cb166.slice(a, cb166.indexOf("), f as (", a));
  };
  const rowCheck = (): string => {
    const a = cb166.indexOf("), kept as (");
    return cb166.slice(a, cb166.indexOf("), top as (", a));
  };

  it("stems each typed word with the turkish_stem snowball dictionary, schema-qualified", () => {
    expect(wordList()).toContain(
      "(pg_catalog.ts_lexize('pg_catalog.turkish_stem'::pg_catalog.regdictionary, s.w))[1] as st",
    );
  });

  it("splits the folded query into whitespace tokens, dropping '' and every token that starts with '-'", () => {
    const g0 = wordList().slice(0, wordList().indexOf("), g as ("));
    expect(g0).toContain("cross join lateral pg_catalog.regexp_split_to_table(f0.ff, '[[:space:]]+') as t(tok)");
    expect(g0).toContain("where t.tok <> '' and pg_catalog.left(t.tok, 1) <> '-'");
  });

  it("splits each token into [a-z0-9] words, dropping ''", () => {
    expect(wordList()).toContain("cross join lateral pg_catalog.regexp_split_to_table(g0.tok, '[^a-z0-9]+') as s(w)");
    expect(wordList()).toContain("where s.w <> ''");
  });

  const gCte = (): string => wordList().slice(wordList().indexOf("), g as ("));
  /** The constant allowlist pattern of the exemption: the literal after `~ '`, cut at its closing quote. */
  const exemptionPattern = (): string => {
    const g = gCte();
    const at = g.indexOf(" ~ '");
    expect(at, "the exemption has no `~ '<pattern>'`").toBeGreaterThan(-1);
    const from = at + 4;
    return g.slice(from, g.indexOf("'", from));
  };

  it("guards a word only when its stem over-cuts it: length(stem) < length(word) and length(stem) <= 4", () => {
    const g = gCte();
    expect(g).toContain("where x.st is not null");
    expect(g).toContain("and pg_catalog.length(x.st) < pg_catalog.length(x.w)");
    expect(g).toContain("and pg_catalog.length(x.st) <= 4");
  });

  it("exempts a 3-4 letter stem that is the word's own root plus a case or plural suffix, compared FOLDED", () => {
    const g = gCte();
    // the exemption is a negated condition that follows the over-cut test, and precedes the OR / negated-phrase tests
    const cut = g.indexOf("and pg_catalog.length(x.st) <= 4");
    const ex = g.indexOf("and not (pg_catalog.length(x.st) between 3 and 4");
    expect(ex, "no `and not (length(stem) between 3 and 4 ...` exemption").toBeGreaterThan(cut);
    expect(ex).toBeLessThan(g.indexOf("and not exists (select 1 from g0"));
    // ts_lexize returns the stem with Turkish letters ('ilaç' for ilaci, 'seç' for secim): the stem is folded before it
    // is compared with the ASCII word, so ilaci (stem ilaç, folded ilac) is exempt and secim is judged on 'sec'
    expect(g).toContain("and pg_catalog.left(x.w, pg_catalog.length(x.st)) = public.tayf_search_fold(x.st)");
    // a 3-letter stem needs a suffix of 3 or more letters: tarla (tar + la) and putin (put + in) stay guarded
    expect(g).toContain("and (pg_catalog.length(x.st) = 4 or pg_catalog.length(x.w) - pg_catalog.length(x.st) >= 3)");
    // the subject is the folded word's tail and the pattern a constant
    expect(g).toContain("and pg_catalog.substr(x.w, pg_catalog.length(x.st) + 1) ~ '");
  });

  it("the exemption pattern is one anchored constant of suffix alternatives, with no backslash and no user text", () => {
    const pattern = exemptionPattern();
    expect(pattern.startsWith("^(")).toBe(true);
    expect(pattern.endsWith(")$")).toBe(true);
    expect(pattern.includes("\\")).toBe(false);
    expect(pattern.includes("'")).toBe(false);
    // the case, plural and relative suffixes the review named
    for (const alt of ["y?[ae]", "n[ae]", "y?[iu]", "n?[iu]n", "[dt][ae](n|ki)?", "n[dt][ae](n|ki)?", "y?l[ae]", "l[ae]r[a-z]*"]) {
      expect(pattern, alt).toContain(alt);
    }
  });

  it("models the exemption: irakta, kirada, natonun, faize, okulda, zamlar, ilaci and atesi are exempt; tarla, putin, burdur and the known limits stay guarded", () => {
    const suffix = new RegExp(exemptionPattern());
    // st is what ts_lexize('turkish_stem', word) returned on production (read-only, 2026-11-06)
    const exempt = (w: string, st: string): boolean => {
      const folded = foldTr(st);
      const n = folded.length;
      return (
        n >= 3 &&
        n <= 4 &&
        w.slice(0, n) === folded &&
        (n === 4 || w.length - n >= 3) &&
        suffix.test(w.slice(n))
      );
    };
    const overCut = (w: string, st: string): boolean => st.length < w.length && st.length <= 4;
    const guarded = (w: string, st: string): boolean => overCut(w, st) && !exempt(w, st);

    const EXEMPT: Array<[string, string]> = [
      ["irakta", "irak"],
      ["kirada", "kira"],
      ["natonun", "nato"],
      ["faize", "faiz"],
      ["okulda", "okul"],
      ["zamlar", "zam"],
      ["karsta", "kars"],
      // ts_lexize gives 'ilaç': only its FOLDED form 'ilac' is a prefix of the ASCII word 'ilaci'
      ["ilaci", "ilaç"],
      ["atesi", "ates"],
    ];
    for (const [w, st] of EXEMPT) {
      expect(overCut(w, st), `${w} is over-cut`).toBe(true);
      expect(exempt(w, st), `${w} (${st}) is exempt`).toBe(true);
      expect(guarded(w, st), `${w} is not guarded`).toBe(false);
    }
    // the unfolded stem never prefixes the word: the fold is what makes ilaci exempt
    expect("ilaci".startsWith("ilaç")).toBe(false);
    expect("ilaci".startsWith(foldTr("ilaç"))).toBe(true);

    const GUARDED: Array<[string, string]> = [
      ["burdur", "bur"], // suffix 'dur' is not on the list
      ["tarla", "tar"], // 3-letter stem + 2-letter suffix
      ["putin", "put"],
      ["iran", "ira"],
      ["secim", "seç"],
      ["ilhan", "ilha"],
      ["bakan", "baka"],
      ["bakam", "baka"],
      ["igdir", "igi"], // the stem is not a prefix of the word
      ["ersan", "er"], // 2-letter stem
      // the known limits: a stem of 3 letters or fewer followed by a 2-letter suffix
      ["yolda", "yol"],
      ["evde", "ev"],
      ["zamla", "za"],
    ];
    for (const [w, st] of GUARDED) {
      expect(guarded(w, st), `${w} (${st}) stays guarded`).toBe(true);
    }
  });

  it("the guard set is a set: select distinct, so a repeated word is one guard row (SEC-h50-1)", () => {
    expect(gCte()).toContain("select distinct pg_catalog.left(");
  });

  it("the prefix is left(word, least(length(word), greatest(4, length(stem) + 1)))", () => {
    expect(wordList()).toContain(
      "select distinct pg_catalog.left(x.w, least(pg_catalog.length(x.w), greatest(4, pg_catalog.length(x.st) + 1))) as pre",
    );
  });

  it("skips the whole guard when any token is `or` (the alias expansion joins its spellings with ' or ')", () => {
    expect(wordList()).toContain(
      "and not exists (select 1 from g0 where pg_catalog.regexp_replace(g0.tok, '[^a-z0-9]+', '', 'g') = 'or')",
    );
  });

  it("skips the whole guard when the query holds a negated phrase (-\"), whose later words are not required", () => {
    expect(wordList()).toContain("and not exists (select 1 from f0 where pg_catalog.strpos(f0.ff, '-\"') > 0)");
  });

  it("visits the candidates newest first through a sorted, fenced subquery, so `top` can stop after 1000 survivors", () => {
    expect(rowCheck()).toContain(
      "select k.id, k.updated_at from (select s.id, s.updated_at from cand s order by s.updated_at desc, s.id offset 0) k where",
    );
  });

  // WS(x): the prefix is at a word start of the folded text x. The strpos probe first (' ' || x, ' ' || pre); the
  // regexp runs only where the prefix occurs at all. Written out inline in the migration, no helper function.
  const ws = (x: string): string =>
    `(pg_catalog.strpos(' ' || ${x}, ' ' || g.pre) > 0 or (pg_catalog.strpos(${x}, g.pre) > 0 and pg_catalog.strpos(' ' || pg_catalog.regexp_replace(${x}, '[^a-z0-9]+', ' ', 'g'), ' ' || g.pre) > 0))`;

  /** Every parenthesised group of `src` that opens with `opener`, balanced, string literals skipped. */
  const groupsOpeningWith = (src: string, opener: string): string[] => {
    const out: string[] = [];
    let from = 0;
    for (;;) {
      const at = src.indexOf(opener, from);
      if (at < 0) return out;
      let depth = 0;
      let inStr = false;
      let i = at;
      for (; i < src.length; i++) {
        const ch = src[i];
        if (ch === "'") inStr = !inStr;
        else if (!inStr && ch === "(") depth++;
        else if (!inStr && ch === ")" && --depth === 0) break;
      }
      out.push(src.slice(at, i + 1));
      from = at + opener.length;
    }
  };

  it("with no guard word, kept passes every candidate through and never reads a cluster", () => {
    const k = rowCheck();
    expect(k).toContain("where not exists (select 1 from g) or exists (");
    // the pass-through test comes first: OR short-circuits, so no fold runs for an empty guard set
    expect(k.indexOf("not exists (select 1 from g) or")).toBeLessThan(k.indexOf("tayf_search_fold"));
    expect(k.indexOf("not exists (select 1 from g) or")).toBeLessThan(k.indexOf("public.clusters"));
  });

  it("otherwise keeps a row only when EVERY guard prefix is at a word start of its title, or of its summary plus neutral title", () => {
    const k = rowCheck();
    // r: the primary-key read of the cluster, fenced with offset 0 so its plan never depends on the guard-word estimate
    expect(k).toContain(
      "or exists ( select 1 from (select c.title_tr, c.summary_tr, c.title_tr_neutral from public.clusters c where c.id = k.id offset 0) r ",
    );
    // a: the title, folded once per candidate (a lateral subquery, offset 0 fences it)
    expect(k).toContain("cross join lateral (select public.tayf_search_fold(coalesce(r.title_tr, '')) as t offset 0) a ");
    // b: the summary plus the neutral title folded as ONE string, and only when some prefix is not in the title
    expect(k).toContain(
      `cross join lateral ( select case when exists (select 1 from g where not ${ws("a.t")}) ` +
        "then public.tayf_search_fold(coalesce(r.summary_tr, '') || ' ' || coalesce(r.title_tr_neutral, '')) " +
        "else '' end as s offset 0) b ",
    );
    // the drop test: no guard prefix is missing from BOTH texts
    expect(k).toContain(`where not exists (select 1 from g where not ${ws("a.t")} and not ${ws("b.s")}) )`);
    // the old shape (one correlated fold per guard row and per column) is gone
    expect(k.includes("cross join g where")).toBe(false);
    expect(k.includes(") p where")).toBe(false);
  });

  it("each candidate folds its text at most twice, whatever the number of guard words: the folds sit in the lateral subqueries a and b only", () => {
    const k = rowCheck();
    expect(countOf(k, "tayf_search_fold(")).toBe(2);
    // never a fold inside a subquery that reads g: such a subquery runs once per (candidate, guard row)
    const readers = groupsOpeningWith(k, "(select 1 from g");
    expect(readers.length).toBe(3);
    for (const r of readers) {
      expect(r.startsWith("(select 1 from g)") || r.startsWith("(select 1 from g where"), r).toBe(true);
      expect(r.includes("tayf_search_fold("), r).toBe(false);
    }
    // a and b are lateral subqueries that do not read g for their fold, and b's fold is the case branch
    expect(k).toContain("then public.tayf_search_fold(coalesce(r.summary_tr, '') || ' ' || coalesce(r.title_tr_neutral, ''))");
    // the fold of summary || ' ' || neutral equals the fold of each: tayf_search_fold is character-wise (translate + lower)
    const parts = ["Öğrenciler Hastaneye", "İlhan Kesici'nin", ""];
    expect(foldTr(`${parts[0]} ${parts[1]}`)).toBe(`${foldTr(parts[0] as string)} ${foldTr(parts[1] as string)}`);
  });

  it("the two-text word-start test equals 129's one-string test (a model of both, 4000 random texts)", () => {
    // 129's text: the three columns joined by ' ', folded; a word start is ' ' || text with every
    // non-[a-z0-9] run turned into one space, searched for ' ' || pre. 166 tests the title alone, then the
    // summary || ' ' || neutral title folded as one string (a pre holds no space, so it cannot span the joint).
    const exact = (folded: string, pre: string): boolean =>
      (" " + folded.replace(/[^a-z0-9]+/g, " ")).includes(" " + pre);
    // 166's per text: the cheap probe, then the exact test only where the prefix occurs at all.
    const layered = (folded: string, pre: string): boolean =>
      (" " + folded).includes(" " + pre) || (folded.includes(pre) && exact(folded, pre));
    const alphabet = ["a", "b", "u", "r", "d", "i", "1", " ", " ", "-", "'", "\u201c", "\u201d", ".", "\u00e9", "s"];
    // mulberry32: a small deterministic generator, so the 4000 texts are the same on every run
    let state = 166;
    const next = (n: number): number => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
    };
    const text = (): string => {
      let t = "";
      for (let i = 0, n = 1 + next(14); i < n; i++) t += alphabet[next(alphabet.length)];
      return t;
    };
    let hits = 0;
    for (let i = 0; i < 4000; i++) {
      const title = foldTr(text());
      const summary = foldTr(text());
      const neutral = foldTr(text());
      const pre = ["bu", "bur", "ur", "a", "i1", "ab"][next(6)] as string;
      const joined = exact(`${neutral} ${title} ${summary}`, pre);
      const parts = layered(title, pre) || layered(`${summary} ${neutral}`, pre);
      expect(parts, JSON.stringify({ neutral, title, summary, pre })).toBe(joined);
      if (joined) hits++;
    }
    expect(hits).toBeGreaterThan(400);
    expect(hits).toBeLessThan(3600);
    // and the cases the probe alone would get wrong: a prefix after punctuation, a prefix inside a word
    expect(layered("\u201cburdur\u201d", "burd")).toBe(true);
    expect(layered("ankara-burdur hatti", "burd")).toBe(true);
    expect(layered("akburdan olayi", "burd")).toBe(false);
    expect(layered("bursa", "burd")).toBe(false);
  });

  it("puts no user text inside a regex pattern: constant patterns only, strpos for matching", () => {
    const patterns = new Set(["'[[:space:]]+'", "'[^a-z0-9]+'", "'\"|(?<=[a-z0-9])-(?=[a-z0-9])'"]);
    for (const fnName of ["pg_catalog.regexp_split_to_table", "pg_catalog.regexp_replace"]) {
      const calls = callArgs(cb166, fnName);
      expect(calls.length, fnName).toBeGreaterThan(0);
      for (const args of calls) {
        expect(patterns.has(args[1] as string), `${fnName} pattern ${args[1]}`).toBe(true);
      }
    }
    const bare = sansStrings(cb166);
    expect(bare).not.toMatch(/\bsimilar\s+to\b/i);
    expect(bare).not.toMatch(/\b(i?like)\b/i);
    expect(bare).not.toMatch(/regexp_match(es)?\s*\(/i);
    // the one `~` is the exemption's suffix allowlist: a CONSTANT pattern (no backslash) on its right, and on its
    // left only the tail of the folded word (substr of x.w), never the query or a column
    expect(countOf(bare, "~")).toBe(1);
    expect(bare).toContain("pg_catalog.substr(x.w, pg_catalog.length(x.st) + 1) ~ ''");
    const at = cb166.indexOf(" ~ '");
    const pattern = cb166.slice(at + 4, cb166.indexOf("'", at + 4));
    expect(pattern.includes("\\")).toBe(false);
    expect(pattern.startsWith("^(") && pattern.endsWith(")$")).toBe(true);
    expect(bare).not.toMatch(/phraseto_tsquery|<->/i);
  });

  it("is the same words the app sends: the alias expansion joins spellings with a standalone ' or ' token", () => {
    const e = expandAliasQuery("akp");
    expect(e).not.toBeNull();
    expect(e?.variantsQuery).toBe('akp or "ak parti"');
    expect(e?.foldedQuery).toBe("akp or ak parti");
    expect(foldTr(e?.foldedQuery ?? "").split(" ")).toContain("or");
  });

  it("for the typed Iğdır the app sends p_folded 'igdir' and the three spellings whose stems are ık, ik and iğdır", () => {
    const key = canonicalSearchQuery("Iğdır");
    expect(foldTr(key)).toBe("igdir");
    // the three spellings 'I' can take under the database's en_US lower(); the guard replaces their stems
    // (ık, ik) by the folded word's own prefix
    expect([...turkishQueryVariants(key)].sort()).toEqual(["iğdir", "iğdır", "ığdır"].sort());
  });

});

describe("166 header", () => {
  it("documents WHY, the production fingerprint, the REPLAY, VERIFY and ROLLBACK", () => {
    for (const word of ["WHY", "PRODUCTION FINGERPRINT", "REPLAY", "VERIFY", "ROLLBACK", "LEDGER"]) {
      expect(head, word).toContain(word);
    }
    expect(head).toContain(PROD_BODY_MD5);
    expect(head).toContain(`length ${PROD_BODY_LENGTH}`);
  });

  it("records the md5 and length of the NEW body, and they match this file (the test recomputes it)", () => {
    const marker = "new md5(prosrc): ";
    const at = head.indexOf(marker);
    expect(at, "header has no `new md5(prosrc): ` line").toBeGreaterThan(-1);
    const hash = head.slice(at + marker.length, at + marker.length + 32);
    expect(hash).toBe(md5(raw166));
    expect(head.slice(at + marker.length + 32, at + marker.length + 32 + 10 + String(raw166.length).length)).toBe(` (length ${raw166.length})`);
  });

  it("the VERIFY step names the same md5 and length as the `new md5(prosrc)` line", () => {
    const marker = "new md5(prosrc): ";
    const at = head.indexOf(marker);
    const hash = head.slice(at + marker.length, at + marker.length + 32);
    const verify = head.slice(head.indexOf("VERIFY"), head.indexOf("ROLLBACK"));
    expect(verify).toContain(`expect ${hash}, ${raw166.length}.`);
  });

  /** The header line that starts with `--   <word> ` (a REPLAY or COST table row), or "". */
  const tableLine = (word: string): string => {
    const lines = head.split("\n");
    return lines.find((l) => l.startsWith(`--   ${word} `)) ?? "";
  };

  it("the REPLAY table lists the inflected-root queries as identical to 129 (irakta, kirada, natonun, faize, okulda, zamlar)", () => {
    for (const w of ["irakta", "kirada", "natonun", "faize", "okulda", "zamlar"]) {
      const line = tableLine(w);
      expect(line, `no REPLAY row for ${w}`).not.toBe("");
      expect(line, w).toContain("identical to 129");
    }
  });

  it("WHAT describes the inflected-root exemption and KNOWN LIMITS names yolda, evde, zamla and tarla", () => {
    const what = head.slice(head.indexOf("WHAT"), head.indexOf("KNOWN LIMITS"));
    expect(what).toContain("EXEMPT");
    expect(what).toContain("irakta");
    expect(what).toContain("ilaci");
    expect(what.toLowerCase()).toContain("folded");
    const limits = head.slice(head.indexOf("KNOWN LIMITS"), head.indexOf("PRODUCTION FINGERPRINT"));
    for (const w of ["yolda", "evde", "zamla", "tarla"]) expect(limits, w).toContain(w);
  });

  it("BOUNDED WORK says folds per candidate are at most two, whatever the number of guard words", () => {
    const bounded = head.slice(head.indexOf("BOUNDED WORK"), head.indexOf("KNOWN LIMITS"));
    expect(bounded).toContain("at most two folds");
    expect(bounded).toContain("whatever the number of guard words");
  });

  it("does not claim the guard reads about 1000 clusters however broad the query is: a few-survivor broad stem walks every candidate", () => {
    expect(head).not.toContain("however broad the query is");
    const sits = head.slice(head.indexOf("Where it sits"), head.indexOf("BOUNDED WORK"));
    expect(sits).toContain("bakam");
    expect(sits).toContain("every candidate");
  });

  it("the COST table shows the few-survivor worst case (bakam, ayse) above the 1.3x gate, and the adversarial repeated-word rows", () => {
    const cost = head.slice(head.indexOf("COST (production"), head.indexOf("LEDGER:"));
    expect(cost).toContain("bakam");
    expect(cost).toContain("ayse");
    expect(cost.toLowerCase()).toContain("worst case");
    expect(cost).toContain("above the 1.3x gate");
    // 'bakan bakan bakan bakan bakam -x17' and the comma form: 129 -> the draft with a correlated fold per guard row -> now
    expect(cost).toContain("bakan bakan bakan bakan bakam -x17");
    expect(cost).toContain("1,200");
    expect(cost).toContain("445");
    expect(cost).toContain("comma form");
    expect(cost).toContain("1,159");
  });

  it("the ROLLBACK is 129's function text again plus deleting the ledger row 166, and names the 083 fallback as untouched", () => {
    const rb = head.slice(head.indexOf("ROLLBACK"));
    expect(rb).toContain("129_search_fold_rank.sql");
    expect(collapse(rb)).toContain("delete from supabase_migrations.schema_migrations where version = '166'");
    expect(head).toContain("083");
    expect(head).toContain("PGRST202");
  });
});

describe("166 dry-run, setup and live manifest", () => {
  const dry = existsSync(DRYRUN_166) ? readFileSync(DRYRUN_166, "utf8") : "";
  const setup = existsSync(SETUP_166) ? readFileSync(SETUP_166, "utf8") : "";

  it("ships the local PG15 dry-run: the 129 state, 166 twice, ending in DRYRUN 166 OK", () => {
    expect(existsSync(DRYRUN_166)).toBe(true);
    expect(dry).toContain(PROD_BODY_MD5);
    expect(countOf(dry, "\\ir ../../../supabase/migrations/166_search_overstem_guard.sql")).toBe(2);
    expect(dry).toContain("\\ir 166-search-overstem-guard-setup.sql");
    expect(dry.trimEnd().endsWith("\\echo DRYRUN 166 OK")).toBe(true);
    // the replay list and the timing list hold the inflected-root queries
    for (const w of ["irakta", "kirada", "zamlar"]) {
      expect(dry, `replay row for ${w}`).toContain(`('${w}',`);
      expect(dry, `timing row for ${w}`).toContain(`('${w}', `);
    }
    expect(dry).toContain("('iran', 'iran'), ('seçim', 'secim'), ('bakan', 'bakan')");
    // the header lines tests/migrations/live-harness.test.ts requires of every dry-run
    expect(dry).toContain("-f tests/migrations/sql/stub.sql");
    expect(dry).toContain("D=$(mktemp -d)");
    expect(dry).toContain("-- or: bash tests/migrations/sql/run-live.sh");
  });

  it("the dry-run times a repeated guarded word against the same query with each distinct word once, bound 1.3x", () => {
    expect(dry).toContain("each distinct word once");
    expect(dry).toContain("v_ratio > 1.3");
    expect(dry).toContain("'bakan bakan bakan bakan burdur'");
    expect(dry).toContain("'bakan burdur'");
    // the few-survivor broad-stem worst case is printed (informational, never an assertion)
    expect(dry).toContain("few-survivor");
    expect(dry).toContain("raise notice");
  });

  it("the setup builds the 129 state only: search_tsv (035), the 083 index and 129 itself, never 166", () => {
    expect(existsSync(SETUP_166)).toBe(true);
    expect(setup).toContain("add column if not exists search_tsv tsvector");
    expect(setup).toContain("clusters_search_tsv_live_idx");
    expect(countOf(setup, "\\ir ../../../supabase/migrations/129_search_fold_rank.sql")).toBe(1);
    expect(setup.includes("166_search_overstem_guard.sql")).toBe(false);
  });

  it("the live manifest runs this file after the 139 dry-run (the fold) and the setup (search_tsv, 129)", () => {
    const lines = readFileSync(MANIFEST, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("run | 166-search-overstem-guard.test.ts | "));
    expect(lines).toEqual([
      "run | 166-search-overstem-guard.test.ts | tests/migrations/sql/139-content-twin-candidates-dryrun.sql tests/migrations/sql/166-search-overstem-guard-setup.sql | - | 0",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Live block (opt-in). TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/PGDATABASE point at a
// THROWAWAY database in the 129 state (tests/migrations/sql/live-manifest.txt: the 139 dry-run, then
// 166-search-overstem-guard-setup.sql). This block seeds clusters, calls the function BEFORE 166, applies 166
// (twice), calls it AFTER, and compares. The seeds are removed again at the end.
// ---------------------------------------------------------------------------

interface Seed {
  key: string;
  title: string;
  summary: string;
  neutral?: string;
  hoursAgo: number;
}

const SEEDS: Seed[] = [
  // the four defects of h50-search-1
  { key: "burdurTitle", title: "Burdur'da yurt zehirlenmesi", summary: "Öğrenciler hastaneye kaldırıldı.", hoursAgo: 1 },
  { key: "bursa", title: "Bursa'da deprem uyarısı", summary: "Uzmanlar uyardı.", hoursAgo: 2 },
  { key: "ersan", title: "Bakanlıktan Ersan açıklaması", summary: "Açıklama yapıldı.", hoursAgo: 3 },
  { key: "erkenSecim", title: "Erken seçim anketi", summary: "Anket sonuçları.", hoursAgo: 4 },
  { key: "sonaErdi", title: "Sona erdi", summary: "Süreç tamamlandı.", hoursAgo: 5 },
  { key: "ilhan", title: "İlhan Kesici hayır diyecek", summary: "Konuşma yapacak.", hoursAgo: 6 },
  { key: "ilham", title: "İlham Aliyev Ankara'da", summary: "Ziyaret edecek.", hoursAgo: 7 },
  { key: "igdir", title: "Iğdır'da şehit", summary: "Şehit töreni yapıldı.", hoursAgo: 8 },
  // 'ikindi' stems to 'ik', the stem of the typed variant 'iğdir'
  { key: "emekli", title: "Emekli maaşına zam", summary: "Zam oranı ikindi saatlerinde açıklandı.", hoursAgo: 9 },
  // the word only in the summary, not in the title
  { key: "burdurSummary", title: "Turizm sezonu açıldı", summary: "Burdur Gölü çevresinde otel doluluğu arttı.", hoursAgo: 10 },
  // the word only in title_tr_neutral
  { key: "burdurNeutral", title: "Yurtta zehirlenme şüphesi", neutral: "Burdur yurdunda zehirlenme şüphesi", summary: "Kurum inceleme başlattı.", hoursAgo: 11 },
  // the prefix after punctuation, not after a space (the exact test of the guard, not the probe)
  { key: "burdurQuoted", title: "\u201cBurdur\u201d i\u00e7in yeni karar", summary: "Karar a\u00e7\u0131kland\u0131.", hoursAgo: 11.5 },
  { key: "burdurHyphen", title: "Ankara-Burdur hatt\u0131nda kar", summary: "Yollar kapand\u0131.", hoursAgo: 11.6 },
  // a candidate through Bursa whose only 'burd' sits inside a word (akburdan), not at a word start
  { key: "bursaMid", title: "Bursa'da Akburdan olay\u0131", summary: "Polis inceleme ba\u015flatt\u0131.", hoursAgo: 11.7 },
  // inflected roots (review fix): the root is the word and the suffix is only grammar, so the guard must not apply
  { key: "irakTa", title: "Irak'ta saldırı", summary: "Saldırıda can kaybı yaşandı.", hoursAgo: 11.8 },
  { key: "irakBasbakan", title: "Irak Başbakanı açıklama yaptı", summary: "Başbakan basın toplantısı düzenledi.", hoursAgo: 11.9 },
  { key: "kira", title: "Kira artışı açıklandı", summary: "Yeni oran belli oldu.", hoursAgo: 11.91 },
  { key: "nato", title: "NATO zirvesi toplandı", summary: "Liderler bir araya geldi.", hoursAgo: 11.92 },
  { key: "okul", title: "Okula silahlı saldırı", summary: "Polis soruşturma başlattı.", hoursAgo: 11.93 },
  { key: "faiz", title: "Faiz kararı açıklandı", summary: "Merkez bankası toplandı.", hoursAgo: 11.94 },
  // 'tarla' is guarded (tar + la): the Tarım ve Orman rows share its stem 'tar' and must go
  { key: "tarla", title: "Tarla sahipleri destek bekliyor", summary: "Çiftçiler toplandı.", hoursAgo: 11.95 },
  { key: "tarim", title: "Tarım ve Orman Bakanlığı açıklama yaptı", summary: "Yeni destekler duyuruldu.", hoursAgo: 11.96 },
  // queries the guard must not change
  { key: "sisli", title: "Şişli'de yol çalışması", summary: "Belediye açıklama yaptı.", hoursAgo: 12 },
  { key: "secim", title: "Seçim sonuçları açıklandı", summary: "Kurul sonuçları duyurdu.", hoursAgo: 13 },
  { key: "putin", title: "Putin Moskova'da konuştu", summary: "Kremlin açıklama yaptı.", hoursAgo: 14 },
  { key: "akp", title: "AKP'den açıklama", summary: "Parti sözcüsü konuştu.", hoursAgo: 15 },
  { key: "akParti", title: "AK Parti toplantısı", summary: "Grup toplantısı yapıldı.", hoursAgo: 16 },
  { key: "chp", title: "CHP kurultay kararı", summary: "Parti meclisi toplandı.", hoursAgo: 17 },
  { key: "meclis", title: "Meclis tatile girdi", summary: "Genel kurul tatile çıktı.", hoursAgo: 18 },
  { key: "enflasyon", title: "Enflasyon rakamları açıklandı", summary: "Aylık artış belli oldu.", hoursAgo: 19 },
  { key: "istanbul", title: "İstanbul'da kar yağışı", summary: "Valilik uyarı yaptı.", hoursAgo: 20 },
  { key: "ankara", title: "Ankara'da toplantı", summary: "Bakanlar toplandı.", hoursAgo: 21 },
  { key: "imamoglu", title: "İmamoğlu davasında yeni gelişme", summary: "Duruşma ertelendi.", hoursAgo: 22 },
  { key: "erdogan", title: "Erdoğan kabine toplantısı sonrası konuştu", summary: "Açıklama yaptı.", hoursAgo: 23 },
];

const seedId = (i: number): string => `00000000-0000-4000-8000-${String(166001 + i).padStart(12, "0")}`;
const KEY_BY_ID = new Map(SEEDS.map((s, i) => [seedId(i), s.key]));

const lit = (s: string): string => `'${s.replaceAll("'", "''")}'`;

describe.runIf(Boolean(process.env.TAYF_PSQL))("166 search over-stem guard against a live Postgres (129 applied, 166 applied by this block)", () => {
  assertLiveReady("166", {
    ledger: ["129"],
    relations: ["public.clusters_search_tsv_live_idx", "public.clusters_search_fold_live_idx"],
    functions: ["public.search_cluster_ids(text[],text,integer)", "public.tayf_search_fold(text)"],
  });

  function runPsql(input: string): string {
    return execFileSync(process.env.TAYF_PSQL as string, ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      input,
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8" },
      maxBuffer: 8 * 1024 * 1024,
    });
  }
  function applyFile(path: string): string {
    return execFileSync(process.env.TAYF_PSQL as string, ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", path], {
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8" },
      maxBuffer: 8 * 1024 * 1024,
    });
  }

  /** The RPC arguments exactly as src/lib/clusters/search-query.ts builds them for a typed query. */
  function appArgs(typed: string): { variants: string[]; folded: string } {
    const key = canonicalSearchQuery(typed);
    const expansion = expandAliasQuery(key);
    return {
      variants: turkishQueryVariants(expansion ? expansion.variantsQuery : key),
      folded: foldTr(expansion ? expansion.foldedQuery : key),
    };
  }

  /** The seed keys the function returns for these arguments, in result order. */
  function search(variants: string[], folded: string): string[] {
    const arr = `array[${variants.map(lit).join(", ")}]::text[]`;
    const out = runPsql(
      `select t.id from public.search_cluster_ids(${arr}, ${lit(folded)}, 24) with ordinality as t(id, n) order by t.n;`,
    );
    return out
      .split("\n")
      .filter((l) => l !== "")
      .map((id) => KEY_BY_ID.get(id) ?? `?${id}`);
  }

  // typed query -> keys, before and after applying 166
  const QUERIES = [
    "burdur",
    "BURDUR",
    "ersan",
    "ilhan",
    "şişli",
    "seçim",
    "putin",
    "akp",
    "chp",
    "meclis",
    "enflasyon",
    "istanbul",
    "ankara",
    "imamoğlu",
    "erdoğan",
    "irakta",
    "kirada",
    "natonun",
    "okulda",
    "faize",
    "zamlar",
    "tarla",
    "burdur deprem",
    "ersan or burdur",
    "zam -ersan",
    "ersan -yurt",
    'deprem -"x burdur"',
  ];
  // Queries sent to the function as typed arguments, bypassing the app's canonicaliser.
  const RAW_ARGS: Record<string, { variants: string[]; folded: string }> = {
    'deprem -"x burdur"': { variants: ['deprem -"x burdur"'], folded: 'deprem -"x burdur"' },
  };
  const argsFor = (typed: string): { variants: string[]; folded: string } => RAW_ARGS[typed] ?? appArgs(typed);
  const before = new Map<string, string[]>();
  const after = new Map<string, string[]>();
  const IGDIR_VARIANTS = ["ığdır", "iğdir", "iğdır"];
  let igdirBefore: string[] = [];
  let igdirAfter: string[] = [];
  let facts = "";

  beforeAll(() => {
    // Back to the 129 state, so a database that already holds 166 (a re-run) is read as 129 first.
    applyFile(MIGRATION_129);
    runPsql("delete from supabase_migrations.schema_migrations where version = '166';");
    const ids = SEEDS.map((_, i) => `'${seedId(i)}'`).join(", ");
    const rows = SEEDS.map(
      (s, i) =>
        `(${lit(seedId(i))}, ${lit(s.title)}, ${s.neutral === undefined ? "null" : lit(s.neutral)}, ${lit(s.summary)}, 2, false, now() - interval '${s.hoursAgo} hours')`,
    ).join(",\n");
    runPsql(`
delete from public.clusters where id in (${ids});
insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at) values
${rows};
analyze public.clusters;
`);

    for (const q of QUERIES) {
      const a = argsFor(q);
      before.set(q, search(a.variants, a.folded));
    }
    igdirBefore = search(IGDIR_VARIANTS, "igdir");

    applyFile(MIGRATION_166);
    applyFile(MIGRATION_166); // twice: create or replace and the ledger insert are idempotent

    for (const q of QUERIES) {
      const a = argsFor(q);
      after.set(q, search(a.variants, a.folded));
    }
    igdirAfter = search(IGDIR_VARIANTS, "igdir");

    facts = runPsql(`
select (select count(*) from supabase_migrations.schema_migrations where version = '166'),
       (select count(*) from pg_catalog.pg_proc where proname = 'search_cluster_ids' and pronamespace = 'public'::regnamespace and pg_get_function_identity_arguments(oid) = 'p_variants text[], p_folded text, p_limit integer'),
       p.prosecdef, p.provolatile, (p.proconfig = array['search_path=""']), p.proacl::text, md5(p.prosrc), length(p.prosrc),
       has_function_privilege('anon', p.oid, 'execute'), has_function_privilege('authenticated', p.oid, 'execute'),
       has_function_privilege('service_role', p.oid, 'execute'),
       (select l.lanname from pg_catalog.pg_language l where l.oid = p.prolang),
       obj_description(p.oid, 'pg_proc') like '%guard%'
  from pg_catalog.pg_proc p
 where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
`).trim();
  });

  afterAll(() => {
    const ids = SEEDS.map((_, i) => `'${seedId(i)}'`).join(", ");
    runPsql(`delete from public.clusters where id in (${ids});`);
  });

  const sorted = (a: string[] | undefined): string[] => [...(a ?? [])].sort();

  it("the fixture reproduces the defects on the 129 body: stem collisions fill the result", () => {
    expect(sorted(before.get("burdur"))).toEqual(
      sorted(["burdurTitle", "burdurSummary", "burdurNeutral", "burdurQuoted", "burdurHyphen", "bursa", "bursaMid"]),
    );
    expect(sorted(before.get("ersan"))).toEqual(sorted(["ersan", "erkenSecim", "sonaErdi"]));
    expect(sorted(before.get("ilhan"))).toEqual(sorted(["ilhan", "ilham"]));
    expect(sorted(igdirBefore)).toEqual(sorted(["igdir", "emekli"]));
  });

  it("'burdur' keeps the Burdur title row, the neutral-title row, the summary-only row and the rows with the word after punctuation, but not Bursa", () => {
    const got = after.get("burdur") ?? [];
    expect(sorted(got)).toEqual(sorted(["burdurTitle", "burdurNeutral", "burdurQuoted", "burdurHyphen", "burdurSummary"]));
    expect(got).not.toContain("bursa");
    expect(got).not.toContain("bursaMid");
    // the literal word-start title tier of 129 still ranks the summary-only row after both title rows
    expect(got[got.length - 1]).toBe("burdurSummary");
  });

  it.each([
    ["irakta", ["irakBasbakan", "irakTa"]],
    ["kirada", ["kira"]],
    ["natonun", ["nato"]],
    ["okulda", ["okul"]],
    ["faize", ["faiz"]],
    ["zamlar", ["emekli"]],
  ] as Array<[string, string[]]>)(
    "'%s' (a root plus a case or plural suffix) is not guarded: it returns the ids and the order the 129 function returned",
    (q, keys) => {
      expect(sorted(before.get(q)), `fixture has no 129 row for ${q}`).toEqual(sorted(keys));
      expect(after.get(q)).toEqual(before.get(q));
    },
  );

  it("'irakta' keeps both Irak stories: the one with Irak'ta and the one that only has 'Irak Başbakanı'", () => {
    const got = after.get("irakta") ?? [];
    expect(got).toContain("irakTa");
    expect(got).toContain("irakBasbakan");
  });

  it("'tarla' stays guarded: the Tarla row is kept and the Tarım ve Orman Bakanlığı row goes", () => {
    expect(sorted(before.get("tarla"))).toEqual(sorted(["tarla", "tarim"]));
    expect(after.get("tarla")).toEqual(["tarla"]);
  });

  it("typing in capitals gives the same rows as typing in lower case", () => {
    expect(after.get("BURDUR")).toEqual(after.get("burdur"));
  });

  it("'ersan' returns the Ersan row only", () => {
    expect(after.get("ersan")).toEqual(["ersan"]);
  });

  it("'ilhan' returns İlhan, not İlham", () => {
    expect(after.get("ilhan")).toEqual(["ilhan"]);
  });

  it("the three iğdır variants with folded 'igdir' return the Iğdır row and not 'Emekli maaşına zam'", () => {
    expect(igdirAfter).toEqual(["igdir"]);
    expect(igdirAfter).not.toContain("emekli");
  });

  it.each(["şişli", "seçim", "putin", "chp", "meclis", "enflasyon", "istanbul", "ankara", "imamoğlu", "erdoğan"])(
    "'%s' returns exactly the rows (and the order) the 129 function returned",
    (q) => {
      expect(before.get(q)?.length, `fixture has no row for ${q}`).toBeGreaterThan(0);
      expect(after.get(q)).toEqual(before.get(q));
    },
  );

  it("the alias query (akp or \"ak parti\" / akp or ak parti) is unchanged and finds both spellings", () => {
    expect(appArgs("akp")).toEqual({ variants: ["akp or \"ak parti\""], folded: "akp or ak parti" });
    expect(sorted(before.get("akp"))).toEqual(sorted(["akp", "akParti"]));
    expect(after.get("akp")).toEqual(before.get("akp"));
  });

  it("an OR in the query skips the guard: 'ersan or burdur' returns what 129 returned", () => {
    expect(before.get("ersan or burdur")?.length).toBeGreaterThan(3);
    expect(after.get("ersan or burdur")).toEqual(before.get("ersan or burdur"));
  });

  it("a guarded word AND a normal word: 'burdur deprem' matched only Bursa before and now matches nothing", () => {
    expect(before.get("burdur deprem")).toEqual(["bursa"]);
    expect(after.get("burdur deprem")).toEqual([]);
  });

  it("a negated word is not a guard word: 'zam -ersan' keeps 'Emekli maaşına zam'; 'ersan -yurt' still guards ersan", () => {
    expect(before.get("zam -ersan")).toContain("emekli");
    expect(after.get("zam -ersan")).toEqual(before.get("zam -ersan"));
    expect(after.get("ersan -yurt")).toEqual(["ersan"]);
  });

  it("a negated phrase skips the guard: 'deprem -\"x burdur\"' is not narrowed by the burdur inside it", () => {
    expect(before.get('deprem -"x burdur"')).toEqual(["bursa"]);
    expect(after.get('deprem -"x burdur"')).toEqual(["bursa"]);
  });

  it("is applied once: one ledger row for 166 after two applications, one overload, 129's attributes and ACL", () => {
    const f = facts.split("|");
    expect(f[0]).toBe("1"); // ledger rows for 166
    expect(f[1]).toBe("1"); // one three-argument overload
    expect(f[2]).toBe("t"); // security definer
    expect(f[3]).toBe("s"); // stable
    expect(f[4]).toBe("t"); // search_path = ''

    expect(f[5]).toBe("{postgres=X/postgres,service_role=X/postgres}");
    expect(f[8]).toBe("f"); // anon
    expect(f[9]).toBe("f"); // authenticated
    expect(f[10]).toBe("t"); // service_role
    expect(f[11]).toBe("sql");
    expect(f[12]).toBe("t"); // the comment mentions the guard
  });

  it("the function in the database is the body of the file (md5 and length)", () => {
    const f = facts.split("|");
    expect(f[6]).toBe(md5(raw166));
    expect(f[7]).toBe(String(raw166.length));
  });
});
