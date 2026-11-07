import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { foldTr } from "@/lib/clusters/turkish-query";
import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Contract test for migration 172 ("search exempt-word tier"), h58-postship-1 (hunt 58 follow-up to 166).
//
// 166 guards a typed word whose Turkish stem over-cuts it (burdur -> bur) and EXEMPTS the words that are a 3-4 letter
// root plus a case or plural suffix (irakta = irak + ta, zamlar = zam + lar), because demanding 'irakt' of a row that
// says "Irak'ta" emptied the archive. The exemption also lets name-shaped words through: miller = mil + ler,
// bartin = bart + in, saniye = sani + ye. For those the stem collisions (Milli Enerji, Bart De Wever, Ronen Bar,
// Al Sani) are candidates and fill the page: 'miller' showed 15 'mil/milli' rows with the three real rows at ranks 1, 16
// and 18, 'bartin' pushed 2 of its 18 stories out of the 24, 'saniye' showed 9 'Al Sani' rows of 24.
//
// 172 replaces search_cluster_ids(text[], text, integer) with 166's body plus ONE ranking tier and no row filter:
//   * ge: the distinct folded words that 166's g step exempts (the same split, stem, predicate and pattern: the
//     exemption is evaluated once, in the column ex of the new CTE gx; g reads ex = false, ge reads ex = true);
//   * hits.lit_ok: every ge word starts a word of the title + neutral title + summary (apostrophes deleted, folded),
//     computed only when ge is not empty, else true;
//   * ORDER BY starts with (case when lit_ok then 0 else 1 end), then 166's score expression byte for byte.
// Recall is unchanged (rows are re-ordered, never dropped), a query with no exempt word is in one tier and returns 166's
// order, and the guard, cand, kept and top text is 166's. A row-dropping rule was REJECTED (it regresses the inflected
// roots 166 documents).
//
// This file pins, without a database: the file, ledger and transaction, that 166's body is production's (md5 pinned),
// a derive-and-compare of 172's body against 166's, every detail of gx / g / ge / lit_ok / the ORDER BY, the header, the
// docs section, the dry-run and the live-manifest entry. The opt-in live block (TAYF_PSQL) runs 166's body and 172's
// function side by side on fixtures and checks 172 = a stable partition of 166 by the tier.
//
// No regular expression is applied to quoted SQL literals in this file (CodeQL js/redos): the SQL is scanned with
// indexOf and character loops.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const FILE_172 = "172_search_exempt_word_tier.sql";
const MIGRATION_172 = resolve(MIGRATIONS_DIR, FILE_172);
const MIGRATION_166 = resolve(MIGRATIONS_DIR, "166_search_overstem_guard.sql");
const DRYRUN_172 = resolve(ROOT, "tests", "migrations", "sql", "172-search-exempt-word-tier-dryrun.sql");
const MANIFEST = resolve(ROOT, "tests", "migrations", "sql", "live-manifest.txt");
const DOC_MIGRATION_GUIDE = resolve(ROOT, "docs", "migration-guide.md");

/** md5 and length of production's prosrc for search_cluster_ids(text[], text, integer), read-only 2026-11-07 (= 166's body). */
const BASE_MD5 = "d7f4b4223730e06db8479f42776d8040";
const BASE_LENGTH = 9680;
const BASE_PROACL = "{postgres=X/postgres,service_role=X/postgres}";

const LEDGER_STMT =
  "insert into supabase_migrations.schema_migrations (version, name) values ('172', '172_search_exempt_word_tier') on conflict do nothing;";
const REVOKE_STMT = "revoke all on function public.search_cluster_ids(text[], text, integer) from public, anon, authenticated;";
const GRANT_STMT = "grant execute on function public.search_cluster_ids(text[], text, integer) to service_role;";

/** The tier the ORDER BY starts with. */
const TIER = "(case when h.lit_ok then 0 else 1 end), ";
/** The word-start test of ge.w in the folded text x: the cheap probe, then the exact test only where the word occurs at all (the 166 idiom). */
const WS = (x: string): string =>
  `(pg_catalog.strpos(' ' || ${x}, ' ' || ge.w) > 0 or (pg_catalog.strpos(${x}, ge.w) > 0 and pg_catalog.strpos(' ' || pg_catalog.regexp_replace(${x}, '[^a-z0-9]+', ' ', 'g'), ' ' || ge.w) > 0))`;
/** a.t: the folded title + neutral title with the apostrophes (U+0027, U+2019) deleted; b.s: the folded summary, same. */
const LIT_OK = `not exists (select 1 from ge where not (${WS("a.t")} or ${WS("b.s")})) as lit_ok`;
const LATERAL_A0 =
  "cross join lateral (select public.tayf_search_fold(coalesce(c.title_tr_neutral, '') || ' ' || coalesce(c.title_tr, '')) as f offset 0) a0";
const LATERAL_A =
  "cross join lateral (select case when exists (select 1 from ge) then pg_catalog.replace(pg_catalog.replace(a0.f, pg_catalog.chr(39), ''), pg_catalog.chr(8217), '') else '' end as t offset 0) a";
const LATERAL_B =
  `cross join lateral ( select case when exists (select 1 from ge where not ${WS("a.t")}) ` +
  "then public.tayf_search_fold(pg_catalog.replace(pg_catalog.replace(coalesce(c.summary_tr, ''), pg_catalog.chr(39), ''), pg_catalog.chr(8217), '')) " +
  "else '' end as s offset 0) b";

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

/** Every parenthesised group of `src` that opens with `opener`, balanced, string literals skipped. */
function groupsOpeningWith(src: string, opener: string): string[] {
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

/** The text of `s` from the first `from` up to (not including) the next `to`. */
function between(s: string, from: string, to: string): string {
  const a = s.indexOf(from);
  const b = s.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`cannot cut ${from} .. ${to}`);
  return s.slice(a, b);
}

function md5(s: string): string {
  return createHash("md5").update(s, "utf8").digest("hex");
}

/** Postgres length(): characters, not UTF-16 units. */
function pgLength(s: string): number {
  return [...s].length;
}

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "_" || ch === ".");
}

/** The `## <number> ` section of the guide, up to the next `## ` heading. */
function sectionOf(guide: string, number: string): string {
  const start = guide.indexOf(`\n## ${number} `);
  if (start < 0) return "";
  const next = guide.indexOf("\n## ", start + 1);
  return guide.slice(start, next < 0 ? guide.length : next);
}

let sql = "";
let code = "";
let head = "";
let fn172 = "";
let body172 = "";
let cb172 = "";
/** The body as the database stores it (prosrc): comments included. */
let raw172 = "";
let sql166 = "";
let cb166 = "";
let raw166 = "";
let fn166 = "";

if (existsSync(MIGRATION_172)) {
  sql = readFileSync(MIGRATION_172, "utf8");
  code = stripComments(sql);
  head = sql.slice(0, sql.indexOf("\nbegin;"));
  fn172 = functionBlock(code, "search_cluster_ids");
  body172 = fnBody(fn172);
  cb172 = collapse(body172);
  raw172 = fnBody(functionBlock(sql, "search_cluster_ids"));
}
{
  sql166 = readFileSync(MIGRATION_166, "utf8");
  fn166 = functionBlock(stripComments(sql166), "search_cluster_ids");
  cb166 = collapse(fnBody(fn166));
  raw166 = fnBody(functionBlock(sql166, "search_cluster_ids"));
}

// 166's g CTE cut into the pieces 172's gx must carry verbatim.
/** The constant allowlist pattern of the exemption in 172's body: the literal after ` ~ '`, cut at its closing quote. */
const exemptionPattern = (): string => {
  const at = cb172.indexOf(" ~ '");
  expect(at, "the body has no `~ '<pattern>'`").toBeGreaterThan(-1);
  return cb172.slice(at + 4, cb172.indexOf("'", at + 4));
};

const g166 = (): string => cb166.slice(cb166.indexOf("), g as ("), cb166.indexOf("), f as ("));
const PRE166 = (): string => between(g166(), "pg_catalog.left(x.w, least(", " from ( select s.w").trim();
const INNER166 = (): string => {
  const g = g166();
  const a = g.indexOf("from ( select s.w,");
  return g.slice(a, g.indexOf(") x where x.st is not null") + ") x".length);
};
const OVERCUT166 = "where x.st is not null and pg_catalog.length(x.st) < pg_catalog.length(x.w) and pg_catalog.length(x.st) <= 4";
const EXEMPT_CORE166 = (): string => {
  const g = g166();
  const from = g.indexOf("and not (pg_catalog.length(x.st) between 3 and 4") + "and not (".length;
  const to = g.indexOf(" and not exists (select 1 from g0");
  return g.slice(from, to - 1); // minus the closing parenthesis of `not ( ... )`
};
const SWITCHES166 = (): string => {
  const g = g166();
  return g.slice(g.indexOf("and not exists (select 1 from g0")).trim();
};

describe("172 file, ledger and structure", () => {
  it("exists with the exact name, and no other migration claims the number 172", () => {
    expect(existsSync(MIGRATION_172)).toBe(true);
    const claimed = readdirSync(MIGRATIONS_DIR).filter((n) => n.startsWith("172_"));
    expect(claimed).toEqual([FILE_172]);
  });

  it("contains the ledger insert for '172' with on conflict do nothing, the last statement before commit", () => {
    const c = collapse(code);
    expect(c).toContain(LEDGER_STMT);
    expect(c.endsWith(`${LEDGER_STMT} commit;`)).toBe(true);
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

describe("172 search_cluster_ids(text[], text, integer)", () => {
  it("is the only definition and has 166's signature (create or replace, no drop, no new overload)", () => {
    expect(fn172.startsWith("create or replace function public.search_cluster_ids(p_variants text[], p_folded text, p_limit integer default 12)")).toBe(true);
    expect(countOf(code.toLowerCase(), "create or replace function")).toBe(1);
    expect(countOf(code.toLowerCase(), "create function")).toBe(0);
  });

  it("has exactly 166's header: returns table (id uuid), language sql, stable, security definer, search_path ''", () => {
    expect(collapse(fnHeader(fn172))).toBe(collapse(fnHeader(fn166)));
    const h = collapse(fnHeader(fn172));
    expect(h).toContain("returns table (id uuid)");
    expect(h).toContain("language sql");
    expect(h).toContain("stable");
    expect(h).toContain("security definer");
    expect(h).toContain("set search_path = ''");
    expect(h).not.toContain("volatile");
  });

  it("is revoked from public, anon and authenticated and granted to service_role only", () => {
    const c = collapse(code);
    expect(c).toContain(REVOKE_STMT);
    expect(c).toContain(GRANT_STMT);
    expect(countOf(c, "grant ")).toBe(1);
    expect(c.indexOf("revoke all")).toBeLessThan(c.indexOf("grant execute"));
  });

  it("has a function comment that names the tier, the exempt words and the three migrations it builds on", () => {
    const c = collapse(code);
    const at = c.indexOf("comment on function public.search_cluster_ids(text[], text, integer) is");
    expect(at).toBeGreaterThan(-1);
    const comment = c.slice(at, c.indexOf("revoke all", at));
    for (const word of ["172", "166", "129", "tier", "exempt", "irakta", "miller"]) expect(comment.toLowerCase(), word).toContain(word);
    expect(comment.toLowerCase()).toContain("guard");
    expect(comment.toLowerCase()).toContain("re-order");
  });

  it("touches only the three-argument function: 083's two-argument overload (the PGRST202 fallback) is not defined, replaced or granted", () => {
    let from = 0;
    let seen = 0;
    for (;;) {
      const at = code.indexOf("search_cluster_ids(", from);
      if (at < 0) break;
      seen++;
      const rest = code.slice(at + "search_cluster_ids(".length);
      const ok = rest.startsWith("p_variants text[], p_folded text, p_limit integer") || rest.startsWith("text[], text, integer)");
      expect(ok, rest.slice(0, 40)).toBe(true);
      from = at + 1;
    }
    expect(seen).toBe(4); // create or replace, comment on, revoke, grant
    expect(head).toContain("083");
    expect(head).toContain("PGRST202");
  });

  it("every catalog function the body calls is schema-qualified (empty search_path), every cast names pg_catalog", () => {
    const bare = sansStrings(cb172);
    // least / greatest / coalesce / extract are SQL syntax, not functions: 166 leaves them bare too.
    const catalog = [
      "left",
      "length",
      "strpos",
      "lower",
      "translate",
      "replace",
      "chr",
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
        from = at + name.length;
        // `regexp_replace(` is not a call of `replace(`: the name must start the identifier
        if (isIdentChar(bare[at - 1]) && bare.slice(at - 11, at) !== "pg_catalog.") continue;
        expect(at, `${name}( at ${at}`).toBeGreaterThanOrEqual(11);
        expect(bare.slice(at - 11, at), `${name}( at ${at}`).toBe("pg_catalog.");
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

describe("172 body = 166's body plus the exempt-word tier, nothing else", () => {
  it("166's body is production's body: its md5 and length are the recorded prosrc (read-only, 2026-11-07)", () => {
    expect(md5(raw166)).toBe(BASE_MD5);
    expect(pgLength(raw166)).toBe(BASE_LENGTH);
  });

  it("removing gx / g / ge, the hits CTE and the tier gives 166's body with its g and hits CTEs removed, character for character", () => {
    let b = cb172;
    b = excise(b, "), gx as (", "), f as (");
    b = excise(b, "), hits as (", "select h.id");
    expect(b.includes(TIER)).toBe(true);
    b = b.replace(TIER, "");
    let a = cb166;
    a = excise(a, "), g as (", "), f as (");
    a = excise(a, "), hits as (", "select h.id");
    expect(b).toBe(a);
  });

  it("g0, f0, f, q, cand, kept and top are 166's text, and the ORDER BY after the tier through the limit clause is byte-identical", () => {
    for (const [from, to] of [
      ["with f0 as (", "), g0 as ("],
      ["), g0 as (", "), g"],
      ["), f as (", "), q as ("],
      ["), q as (", "), cand as ("],
      ["), cand as (", "), kept as ("],
      ["), kept as (", "), top as ("],
      ["), top as (", "), hits as ("],
    ] as Array<[string, string]>) {
      const slice = (s: string): string => s.slice(s.indexOf(from), s.indexOf(to, s.indexOf(from) + from.length));
      expect(slice(cb172), from).toBe(slice(cb166));
    }
    const order = "order by ";
    const tail172 = cb172.slice(cb172.lastIndexOf(order) + order.length + TIER.length);
    const tail166 = cb166.slice(cb166.lastIndexOf(order) + order.length);
    expect(tail172).toBe(tail166);
    expect(cb172).toContain("limit greatest(1, least(coalesce(p_limit, 12), 50));");
  });

  it("the CTE order is f0, g0, gx, g, ge, f, q, cand, kept, top, hits", () => {
    const order = [
      "with f0 as (",
      "), g0 as (",
      "), gx as (",
      "), g as (",
      "), ge as (",
      "), f as (",
      "), q as (",
      "), cand as (",
      "), kept as (",
      "), top as (",
      "), hits as (",
    ];
    let last = -1;
    for (const marker of order) {
      const at = cb172.indexOf(marker);
      expect(at, marker).toBeGreaterThan(last);
      last = at;
    }
  });

  it("gx carries 166's g step verbatim: the word split, the stem, the over-cut test, the exemption predicate and both switches", () => {
    const gx = between(cb172, "), gx as (", "), g as (");
    const expected = `), gx as ( select x.w, x.st, (${EXEMPT_CORE166()}) as ex ${INNER166()} ${OVERCUT166} ${SWITCHES166()}`;
    expect(gx.trim()).toBe(expected);
    expect(gx).toContain("(pg_catalog.ts_lexize('pg_catalog.turkish_stem'::pg_catalog.regdictionary, s.w))[1] as st");
    expect(gx).toContain("pg_catalog.regexp_split_to_table(g0.tok, '[^a-z0-9]+') as s(w)");
    expect(gx).toContain("and pg_catalog.left(x.w, pg_catalog.length(x.st)) = public.tayf_search_fold(x.st)");
    expect(gx).toContain("and (pg_catalog.length(x.st) = 4 or pg_catalog.length(x.w) - pg_catalog.length(x.st) >= 3)");
  });

  it("g keeps 166's prefix expression and reads the NOT exempt rows of gx; ge is the distinct exempt words of the same rows", () => {
    const g = between(cb172, "), g as (", "), ge as (");
    expect(g.trim()).toBe(`), g as ( select distinct ${PRE166()} from gx x where not x.ex`);
    expect(PRE166()).toBe(
      "pg_catalog.left(x.w, least(pg_catalog.length(x.w), greatest(4, pg_catalog.length(x.st) + 1))) as pre",
    );
    const ge = between(cb172, "), ge as (", "), f as (");
    expect(ge.trim()).toBe("), ge as ( select distinct x.w from gx x where x.ex");
    // gx is read by exactly these two CTEs
    expect(countOf(cb172, "from gx ")).toBe(2);
  });

  it("the exemption is ONE text: the predicate, its constant pattern and the `~` appear once, and g and ge only read the flag", () => {
    const pattern = exemptionPattern();
    expect(pattern.startsWith("^(") && pattern.endsWith(")$")).toBe(true);
    expect(countOf(cb172, "between 3 and 4")).toBe(1);
    expect(countOf(cb172, pattern)).toBe(1);
    expect(countOf(sansStrings(cb172), "~")).toBe(1);
    expect(countOf(cb172, " as ex ")).toBe(1);
    expect(countOf(cb172, "x.ex")).toBe(2);
    // and it is 166's pattern
    expect(countOf(cb166, pattern)).toBe(1);
    // neither g nor ge restates the over-cut test, the pattern or a switch
    const g = between(cb172, "), g as (", "), f as (");
    for (const piece of ["between 3 and 4", "~ '", "regexp_split_to_table", "from g0", "from f0", "ts_lexize"]) {
      expect(g.includes(piece), piece).toBe(false);
    }
  });

  it("both switches that empty g empty ge too: they sit in gx's WHERE, ahead of the flag split", () => {
    const gx = between(cb172, "), gx as (", "), g as (");
    expect(gx).toContain("and not exists (select 1 from g0 where pg_catalog.regexp_replace(g0.tok, '[^a-z0-9]+', '', 'g') = 'or')");
    expect(gx).toContain("and not exists (select 1 from f0 where pg_catalog.strpos(f0.ff, '-\"') > 0)");
    expect(countOf(cb172, "= 'or')")).toBe(1);
    expect(countOf(cb172, "'-\"') > 0)")).toBe(1);
  });

  it("hits keeps 166's columns (ftitle is 166's expression, folded once), joins top to clusters and adds lit_ok through fenced lateral subqueries", () => {
    const hits = between(cb172, "), hits as (", "select h.id");
    expect(hits).toContain(
      `select c.id, c.updated_at, c.article_count, a0.f as ftitle, ${LIT_OK} from top t join public.clusters c on c.id = t.id ${LATERAL_A0} ${LATERAL_A} ${LATERAL_B}`,
    );
    // ftitle is 166's expression, character for character
    const ftitle166 = "public.tayf_search_fold(coalesce(c.title_tr_neutral, '') || ' ' || coalesce(c.title_tr, ''))";
    expect(cb166).toContain(`${ftitle166} as ftitle`);
    expect(hits).toContain(`${ftitle166} as f offset 0) a0`);
    // two folds per hit at most: ftitle, and the summary (only for a hit whose title does not already hold every exempt word)
    expect(countOf(hits, "tayf_search_fold(")).toBe(2);
    // no fold inside a subquery that reads ge (it would run once per (hit, ge row))
    const readers = groupsOpeningWith(hits, "(select 1 from ge");
    expect(readers.length).toBe(3);
    for (const r of readers) expect(r.includes("tayf_search_fold("), r).toBe(false);
    // ge is read by hits only, never by kept or top
    expect(cb172.indexOf("from ge")).toBeGreaterThan(cb172.indexOf("), hits as ("));
    expect(countOf(cb172, "from ge")).toBe(3);
  });

  it("lit_ok costs nothing when ge is empty (no title edit, no summary fold) and folds the summary only for a hit whose title lacks an exempt word", () => {
    expect(LATERAL_A).toContain("case when exists (select 1 from ge) then");
    expect(LATERAL_B).toContain("case when exists (select 1 from ge where not (");
    expect(cb172).toContain(LATERAL_A);
    expect(cb172).toContain(LATERAL_B);
    // an empty ge: `not exists (select 1 from ge where ...)` is true for every row, whatever a.t and b.s are
    expect(cb172).toContain(LIT_OK);
    // the summary fold sits in the THEN branch only
    expect(cb172.indexOf("then public.tayf_search_fold(pg_catalog.replace(pg_catalog.replace(coalesce(c.summary_tr, '')")).toBeGreaterThan(cb172.indexOf(LATERAL_B.slice(0, 40)));
  });

  it("the ORDER BY starts with the tier and the tier is never a filter: lit_ok appears once as a column and once in the ORDER BY", () => {
    const at = cb172.lastIndexOf("order by ");
    expect(cb172.slice(at, at + "order by ".length + TIER.length)).toBe(`order by ${TIER}`);
    expect(countOf(cb172, "lit_ok")).toBe(2);
    expect(countOf(cb172, " as lit_ok")).toBe(1);
    expect(countOf(cb172, "h.lit_ok")).toBe(1);
    // recall is 166's: the same candidate cap, the same limit, no new where on hits
    expect(cb172).toContain("select k.id from kept k order by k.updated_at desc, k.id limit 1000");
    expect(cb172.slice(cb172.indexOf("select h.id"), at)).toBe("select h.id from hits h cross join q ");
  });

  it("puts no user text inside a regex pattern: constant patterns only, strpos for matching the words", () => {
    const splitPatterns = new Set(["'[[:space:]]+'", "'[^a-z0-9]+'"]);
    const replacePatterns = new Set(["'[^a-z0-9]+'", "'\"|(?<=[a-z0-9])-(?=[a-z0-9])'"]);
    const splits = callArgs(cb172, "pg_catalog.regexp_split_to_table");
    expect(splits.length).toBe(2);
    for (const args of splits) expect(splitPatterns.has(args[1] as string), `split pattern ${args[1]}`).toBe(true);
    const replaces = callArgs(cb172, "pg_catalog.regexp_replace");
    expect(replaces.length).toBeGreaterThan(0);
    for (const args of replaces) expect(replacePatterns.has(args[1] as string), `replace pattern ${args[1]}`).toBe(true);
    const bare = sansStrings(cb172);
    expect(bare).not.toMatch(/\bsimilar\s+to\b/i);
    expect(bare).not.toMatch(/\b(i?like)\b/i);
    expect(bare).not.toMatch(/regexp_match(es)?\s*\(/i);
    expect(bare).not.toMatch(/phraseto_tsquery|<->/i);
    // the one `~` is 166's exemption suffix allowlist, a constant pattern with no backslash
    expect(countOf(bare, "~")).toBe(1);
    const at = cb172.indexOf(" ~ '");
    const pattern = cb172.slice(at + 4, cb172.indexOf("'", at + 4));
    expect(pattern.includes("\\")).toBe(false);
    expect(pattern.startsWith("^(") && pattern.endsWith(")$")).toBe(true);
    // the words of ge reach only strpos
    expect(countOf(cb172, "ge.w")).toBe(9); // three word-start tests (title in lit_ok, summary in lit_ok, title in the summary case), three uses each
    expect(cb172).toContain("pg_catalog.strpos(' ' || a.t, ' ' || ge.w) > 0");
    expect(cb172).toContain("pg_catalog.strpos(' ' || b.s, ' ' || ge.w) > 0");
  });

  it("models the exemption: miller, bartin and saniye are exempt (the new tier), irakta and zamlar still are, tarla, putin and burdur are not", () => {
    const suffix = new RegExp(exemptionPattern());
    // st is what ts_lexize('turkish_stem', word) returned (production and PG15, read-only, 2026-11-07)
    const exempt = (w: string, st: string): boolean => {
      const folded = foldTr(st);
      const n = folded.length;
      return n >= 3 && n <= 4 && w.slice(0, n) === folded && (n === 4 || w.length - n >= 3) && suffix.test(w.slice(n));
    };
    const overCut = (w: string, st: string): boolean => st.length < w.length && st.length <= 4;
    const NEW_TIER: Array<[string, string]> = [
      ["miller", "mil"], // mil + ler (3-letter stem, 3-letter suffix)
      ["bartin", "bart"], // bart + in
      ["saniye", "sani"], // sani + ye
    ];
    const OLD_EXEMPT: Array<[string, string]> = [
      ["irakta", "irak"],
      ["kirada", "kira"],
      ["natonun", "nato"],
      ["faize", "faiz"],
      ["okulda", "okul"],
      ["zamlar", "zam"],
      ["ilaci", "ilaç"],
      ["atesi", "ates"],
    ];
    for (const [w, st] of [...NEW_TIER, ...OLD_EXEMPT]) {
      expect(overCut(w, st), `${w} is over-cut`).toBe(true);
      expect(exempt(w, st), `${w} (${st}) is exempt`).toBe(true);
    }
    const GUARDED: Array<[string, string]> = [
      ["burdur", "bur"],
      ["tarla", "tar"],
      ["putin", "put"],
      ["iran", "ira"],
      ["secim", "seç"],
      ["ilhan", "ilha"],
      ["ersan", "er"],
      ["igdir", "igi"],
      ["yolda", "yol"],
    ];
    for (const [w, st] of GUARDED) {
      expect(overCut(w, st), `${w} is over-cut`).toBe(true);
      expect(exempt(w, st), `${w} (${st}) is guarded, not exempt`).toBe(false);
    }
  });

  it("models lit_ok: an apostrophe is deleted (Miller'ı, Irak'ta, Bartın'da, Irak\u2019ta), a prefix at a word start counts, a stem collision does not", () => {
    // the pieces the body builds: a = title + neutral title, b = summary, each folded with the apostrophes deleted
    const piece = (s: string): string => foldTr(s.replaceAll("'", "").replaceAll("\u2019", ""));
    const probe = (x: string, w: string): boolean =>
      (" " + x).includes(" " + w) || (x.includes(w) && (" " + x.replace(/[^a-z0-9]+/g, " ")).includes(" " + w));
    const litOk = (title: string, summary: string, ge: string[]): boolean =>
      ge.every((w) => probe(piece(title), w) || probe(piece(summary), w));
    expect(litOk("Eski Başkan Miller'ın ziyareti", "", ["miller"])).toBe(true);
    expect(litOk("Irak'ta saldırı", "", ["irakta"])).toBe(true);
    expect(litOk("Irak\u2019ta saldırı", "", ["irakta"])).toBe(true);
    expect(litOk("Bartın'da fırtına", "", ["bartin"])).toBe(true);
    expect(litOk("Ziyaret", "Bay Miller\u2019ı karşıladı.", ["miller"])).toBe(true);
    // the title (with the neutral title) and the summary count together
    expect(litOk("Fırtına Haber", "Bartın kıyıları", ["bartin"])).toBe(true);
    // stem collisions and a word that only holds the stem
    expect(litOk("Milli Enerji 2040", "", ["miller"])).toBe(false);
    expect(litOk("Bart De Wever istifa etti", "Belçika.", ["bartin"])).toBe(false);
    expect(litOk("Ronen Bar görevden alındı", "", ["bartin"])).toBe(false);
    expect(litOk("Al Sani ile görüştü", "Katar.", ["saniye"])).toBe(false);
    expect(litOk("Irak Başbakanı açıklama yaptı", "Başbakan.", ["irakta"])).toBe(false);
    // a word start only: a word that merely holds the letters does not count
    expect(litOk("Gümüller sokağı", "", ["miller"])).toBe(false);
    // a word start after punctuation counts (the exact test), a word inside a word does not
    expect(litOk("Ankara-Miller hattı", "", ["miller"])).toBe(true);
    expect(litOk("\u201cMiller\u201d konuştu", "", ["miller"])).toBe(true);
    // every exempt word has to be there
    expect(litOk("Miller Irak'ta konuştu", "", ["miller", "irakta"])).toBe(true);
    expect(litOk("Miller konuştu", "", ["miller", "irakta"])).toBe(false);
    expect(litOk("Miller konuştu", "Irak'ta kaldı", ["miller", "irakta"])).toBe(true);
    // no exempt word: every row is in the same tier
    expect(litOk("Burdur'da kar", "", [])).toBe(true);
    expect(litOk("", "", [])).toBe(true);
  });

  it("the piecewise, probe-first test equals the test on the one joined, collapsed text (the spec's x), over 4000 random texts", () => {
    // spec: x = collapse(fold(replace(replace(neutral || ' ' || title || ' ' || summary)))), lit_ok = every w: ' ' || x contains ' ' || w
    const del = (s: string): string => s.replaceAll("'", "").replaceAll("\u2019", "");
    const spec = (neutral: string, title: string, summary: string, w: string): boolean => {
      const x = foldTr(del(`${neutral} ${title} ${summary}`)).replace(/[^a-z0-9]+/g, " ");
      return (" " + x).includes(" " + w);
    };
    const probe = (x: string, w: string): boolean =>
      (" " + x).includes(" " + w) || (x.includes(w) && (" " + x.replace(/[^a-z0-9]+/g, " ")).includes(" " + w));
    const body = (neutral: string, title: string, summary: string, w: string): boolean => {
      const a = del(foldTr(`${neutral} ${title}`));
      if (probe(a, w)) return true;
      return probe(foldTr(del(summary)), w);
    };
    const tokens = ["miller", "Miller", "M\u0130LLER", "mil", "milli", "mill\u0131", "bir", "e1", "ba", "g\u00fcmiller", "1miller", "mi"];
    const separators = [" ", " ", " ", "-", "'", "\u2019", ".", "\u201c", ""];
    // mulberry32: a small deterministic generator, so the 4000 texts are the same on every run
    let state = 172;
    const next = (n: number): number => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
    };
    const text = (): string => {
      let t = "";
      for (let i = 0, n = 1 + next(3); i < n; i++) t += (i > 0 ? (separators[next(separators.length)] as string) : "") + (tokens[next(tokens.length)] as string);
      return t;
    };
    let hits = 0;
    for (let i = 0; i < 4000; i++) {
      const neutral = text();
      const title = text();
      const summary = text();
      const w = ["mil", "mill", "miller", "bir", "e1", "ba"][next(6)] as string;
      const joined = spec(neutral, title, summary, w);
      expect(body(neutral, title, summary, w), JSON.stringify({ neutral, title, summary, w })).toBe(joined);
      if (joined) hits++;
    }
    expect(hits).toBeGreaterThan(400);
    expect(hits).toBeLessThan(3600);
  });
});

describe("172 header", () => {
  it("documents WHY, WHAT, KNOWN LIMITS, the production fingerprint, REPLAY, COST, LEDGER, VERIFY and ROLLBACK", () => {
    for (const word of ["WHY", "WHAT", "KNOWN LIMITS", "PRODUCTION FINGERPRINT", "REPLAY", "COST", "LEDGER", "VERIFY", "ROLLBACK"]) {
      expect(head, word).toContain(word);
    }
  });

  it("records 166's md5, length and ACL as the fingerprint the replace was based on, read-only", () => {
    const fp = head.slice(head.indexOf("PRODUCTION FINGERPRINT"), head.indexOf("REPLAY"));
    expect(fp).toContain(BASE_MD5);
    expect(fp).toContain(`length ${BASE_LENGTH}`);
    expect(fp).toContain(BASE_PROACL);
    expect(fp).toContain("166_search_overstem_guard.sql");
    expect(fp).toContain("SECURITY DEFINER");
    expect(fp).toContain("STABLE");
  });

  it("records the md5 and length of the NEW body, and they match this file (the test recomputes it)", () => {
    const marker = "new md5(prosrc): ";
    const at = head.indexOf(marker);
    expect(at, "header has no `new md5(prosrc): ` line").toBeGreaterThan(-1);
    const hash = head.slice(at + marker.length, at + marker.length + 32);
    expect(hash).toBe(md5(raw172));
    const len = ` (length ${pgLength(raw172)})`;
    expect(head.slice(at + marker.length + 32, at + marker.length + 32 + len.length)).toBe(len);
    expect(hash).not.toBe(BASE_MD5);
  });

  it("the VERIFY step names the same md5 and length as the `new md5(prosrc)` line", () => {
    const marker = "new md5(prosrc): ";
    const at = head.indexOf(marker);
    const hash = head.slice(at + marker.length, at + marker.length + 32);
    const verify = head.slice(head.indexOf("VERIFY"), head.indexOf("ROLLBACK"));
    expect(verify).toContain(`expect ${hash}, ${pgLength(raw172)}.`);
    expect(verify).toContain("false, true");
  });

  it("WHY names the three queries with the production evidence, and why the guard did not cover them", () => {
    const why = head.slice(head.indexOf("WHY"), head.indexOf("WHAT"));
    for (const word of ["miller", "bartın", "saniye", "mil + ler", "bart + in", "sani + ye", "Al Sani", "Ronen Bar", "De Wever", "ranks 16 and 18"]) {
      expect(why, word).toContain(word);
    }
    // the variants arm stems bartın to 'bar' and is never guarded: the guard reads p_folded only
    expect(why).toContain("'bar'");
    expect(why).toContain("p_folded");
  });

  it("WHAT describes gx / ge / lit_ok / the ORDER BY tier, order only, recall unchanged", () => {
    const what = head.slice(head.indexOf("WHAT"), head.indexOf("KNOWN LIMITS"));
    for (const word of ["gx", "ge", "lit_ok", "ORDER BY", "RE-ORDER", "never dropped", "apostrophe", "166"]) {
      expect(what, word).toContain(word);
    }
    expect(what).toContain("same tier");
  });

  it("KNOWN LIMITS: the stem-collision tail stays when fewer real rows exist, hamidi and the 4-letter prefix floor are out of scope, a row-dropping rule is rejected with its regression numbers", () => {
    const limits = head.slice(head.indexOf("KNOWN LIMITS"), head.indexOf("PRODUCTION FINGERPRINT"));
    expect(limits).toContain("miller keeps 15 after its 3");
    expect(limits).toContain("hamidi");
    expect(limits).toContain("4-letter prefix");
    expect(limits).toContain("REJECTED");
    expect(limits).toContain("row-dropping");
    for (const row of ["natonun 24 -> 1", "atesi 24 -> 6", "faize 24 -> 14", "ilaci 24 -> 19", "zamlar 24 -> 19"]) {
      expect(limits, row).toContain(row);
    }
  });

  it("KNOWN LIMITS (6): the tier is a word-start prefix test, so irakta also lifts Irak'tan rows and iranda lifts Irak/İran'dan rows", () => {
    const limits = head.slice(head.indexOf("KNOWN LIMITS"), head.indexOf("PRODUCTION FINGERPRINT"));
    expect(limits).toContain("Irak'tan");
    expect(limits).toContain("word-start prefix");
    expect(limits).toContain("İran'dan");
    // the old wording promised that only rows spelling the typed form rank first
    expect(limits).not.toContain("the rows that spell the typed form come first");
  });

  it("REPLAY: p_limit 50 is the RPC's own cap, the app sends SEARCH_LIMIT (24), and the 24-row page can still change", () => {
    const replay = head.slice(head.indexOf("REPLAY"), head.indexOf("COST"));
    expect(replay).not.toContain("as the app asks");
    expect(replay).toContain("SEARCH_LIMIT");
    expect(replay).toContain("src/lib/clusters/search-query.ts");
    expect(replay).toContain("in this 50-row replay");
  });

  /** The header line that starts with `--   <word> ` (a REPLAY or COST table row), or "". */
  const tableLine = (word: string): string => head.split("\n").find((l) => l.startsWith(`--   ${word} `)) ?? "";

  it("the REPLAY table has a row for each exempt query it names and for each query that must stay identical", () => {
    for (const w of ["miller", "bartın", "bartin", "saniye"]) expect(tableLine(w), `no REPLAY row for ${w}`).not.toBe("");
    for (const w of ["zamlar", "irakta", "kirada", "natonun", "faize", "okulda", "karsta", "ilaci", "atesi"]) {
      expect(tableLine(w), `no REPLAY row for ${w}`).not.toBe("");
    }
    const replay = head.slice(head.indexOf("REPLAY"), head.indexOf("COST"));
    for (const w of ["burdur", "iran", "seçim", "şişli", "erdoğan", "imamoğlu", "igdir"]) expect(replay, w).toContain(w);
    expect(replay).toContain("identical top 24");
  });

  it("COST: warm EXPLAIN (ANALYZE, BUFFERS) on production against 166's body in the same session, iran and seçim within 1.3x", () => {
    const cost = head.slice(head.indexOf("COST"), head.indexOf("LEDGER:"));
    expect(cost).toContain("EXPLAIN (ANALYZE, BUFFERS)");
    for (const w of ["miller", "bartin", "zamlar", "irakta", "saniye", "iran", "seçim"]) expect(cost, w).toContain(w);
    expect(cost).toContain("1.3x");
  });

  it("the ROLLBACK is 166's function text again plus deleting the ledger row 172, and names the 083 fallback as untouched", () => {
    const rb = head.slice(head.indexOf("ROLLBACK"));
    expect(rb).toContain("166_search_overstem_guard.sql");
    expect(rb).toContain(BASE_MD5);
    // create or replace keeps the function's oid and so 172's comment: the rollback must restore 166's comment too
    expect(rb).toContain("comment on function");
    expect(collapse(rb)).toContain("delete from supabase_migrations.schema_migrations where version = '172'");
    expect(head).toContain("083");
  });
});

describe("172 docs/migration-guide.md", () => {
  const guide = readFileSync(DOC_MIGRATION_GUIDE, "utf8");
  const section = guide.includes("\n## 172 ") ? sectionOf(guide, "172") : "";

  it("sits directly after section 171 (a later section may follow)", () => {
    expect(guide.indexOf("\n## 172 ")).toBeGreaterThan(guide.indexOf("\n## 171 "));
    expect(guide.indexOf("\n## ", guide.indexOf("\n## 171 ") + 1)).toBe(guide.indexOf("\n## 172 "));
  });

  it("has Why, What, an md5 table, Cost, Order, Verify and Rollback", () => {
    for (const word of ["**Why:**", "**What 172 does**", "| md5(prosrc) | length |", "**Cost**", "**Order:**", "**Verify**", "**Rollback:**"]) {
      expect(section, word).toContain(word);
    }
    expect(section).toContain(BASE_MD5);
    expect(section).toContain(String(BASE_LENGTH));
    expect(section).toContain(md5(raw172));
    expect(section).toContain(String(pgLength(raw172)));
  });

  it("states the evidence for the three queries, the tier, and that order only changes (recall is unchanged)", () => {
    for (const word of ["miller", "bartın", "saniye", "lit_ok", "mil + ler", "bart + in", "sani + ye", "166"]) {
      expect(section, word).toContain(word);
    }
    expect(section.toLowerCase()).toContain("re-order");
    expect(section.toLowerCase()).toContain("recall");
  });

  it("records the rejected row-dropping rule with the regression numbers, and the known limit", () => {
    expect(section).toContain("row-dropping");
    for (const row of ["natonun 24 -> 1", "atesi 24 -> 6", "faize 24 -> 14", "ilaci 24 -> 19", "zamlar 24 -> 19"]) {
      expect(section, row).toContain(row);
    }
    expect(section).toContain("miller keeps 15 after its 3");
  });

  it("Cost: iran and seçim stay within 1.3x of 166 on production", () => {
    const cost = section.slice(section.indexOf("**Cost**"), section.indexOf("**Order:**"));
    expect(cost).toContain("iran");
    expect(cost).toContain("seçim");
    expect(cost).toContain("1.3x");
  });

  it("states the order: APPLY 172 only, no deploy-order constraint, no app change", () => {
    const order = section.slice(section.indexOf("**Order:**"), section.indexOf("**Verify**"));
    expect(order).toContain("172_search_exempt_word_tier.sql");
    expect(order.toLowerCase()).toContain("no app");
  });

  it("verifies the fingerprint, the privileges, the ledger and the three queries", () => {
    const verify = section.slice(section.indexOf("**Verify**"), section.indexOf("**Rollback:**"));
    expect(verify).toContain("'public.search_cluster_ids(text[], text, integer)'::regprocedure");
    expect(verify).toContain(md5(raw172));
    expect(verify).toContain("has_function_privilege");
    expect(verify).toContain("version = '172'");
    for (const q of ["miller", "bartın", "saniye"]) expect(verify, q).toContain(q);
  });

  it("has a rollback that re-runs 166's function and deletes only the 172 ledger row", () => {
    const rb = section.slice(section.indexOf("**Rollback:**"));
    expect(rb).toContain("166_search_overstem_guard.sql");
    expect(rb).toContain(BASE_MD5);
    // create or replace keeps the function's oid and so 172's comment: the rollback must restore 166's comment too
    expect(rb).toContain("comment on function");
    expect(rb).toContain("delete from supabase_migrations.schema_migrations where version = '172'");
  });

  it("Replay says the RPC cap is 50 and the app asks for 24 (SEARCH_LIMIT), so the app's 24-row page can differ from the 50-row replay", () => {
    const replay = section.slice(section.indexOf("**Replay**"), section.indexOf("**Cost**"));
    expect(replay).toContain("SEARCH_LIMIT");
    expect(replay).toContain("24");
    expect(section).toContain("SEARCH_LIMIT");
  });

  it("states the tier test honestly: a word-start prefix, so irakta also lifts Irak'tan rows", () => {
    expect(section).toContain("Irak'tan");
    expect(section).toContain("word-start prefix");
    expect(section).not.toContain("the rows that spell it come first");
  });

  it("uses no fenced sql block (tests/guards/docs-sql-snippets.test.ts scans those)", () => {
    expect(section).not.toContain("```");
  });
});

describe("172 dry-run and live manifest", () => {
  const dry = existsSync(DRYRUN_172) ? readFileSync(DRYRUN_172, "utf8") : "";

  it("builds 172's database with its own dry-run script: one run entry, that script as the only setup file", () => {
    const lines = readFileSync(MANIFEST, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("run | 172-search-exempt-word-tier.test.ts"));
    expect(lines).toEqual([
      "run | 172-search-exempt-word-tier.test.ts | tests/migrations/sql/172-search-exempt-word-tier-dryrun.sql | - | 0",
    ]);
  });

  it("the dry-run builds 166's state (the 129 setup, then 166 itself, gated on its production md5), applies 172 twice and ends with its OK line", () => {
    expect(existsSync(DRYRUN_172)).toBe(true);
    const ir = dry
      .split("\n")
      .filter((l) => l.startsWith("\\ir "))
      .map((l) => l.slice(4).trim());
    expect(ir).toEqual([
      "166-search-overstem-guard-setup.sql",
      "../../../supabase/migrations/166_search_overstem_guard.sql",
      "../../../supabase/migrations/172_search_exempt_word_tier.sql",
      "../../../supabase/migrations/172_search_exempt_word_tier.sql",
    ]);
    expect(dry).toContain(BASE_MD5);
    expect(dry).toContain(String(BASE_LENGTH));
    expect(dry).toContain(md5(raw172));
    expect(dry.trimEnd().endsWith("\\echo DRYRUN 172 OK")).toBe(true);
    // the header lines tests/migrations/live-harness.test.ts requires of every dry-run
    expect(dry).toContain("-f tests/migrations/sql/stub.sql");
    expect(dry).toContain("D=$(mktemp -d)");
    expect(dry).toContain("-- or: bash tests/migrations/sql/run-live.sh");
  });

  it("the dry-run shows the defect on 166's body, then 172: the real rows lead, the other queries keep 166's order, the timing bound is stated", () => {
    for (const q of ["miller", "bartin", "saniye", "irakta", "zamlar"]) expect(dry, q).toContain(`'${q}'`);
    for (const q of ["burdur", "iran", "secim", "sisli"]) expect(dry, q).toContain(`'${q}'`);
    expect(dry).toContain("baseline: 166");
    expect(dry).toContain("stable partition");
    expect(dry).toContain("explain (analyze)");
    expect(dry).toContain("1.3");
    expect(dry).toContain("rollback;");
  });
});

// ---------------------------------------------------------------------------
// Live block (opt-in). TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/PGDATABASE point at a THROWAWAY database
// that the dry-run script left behind with 129, 166 and 172 applied (tests/migrations/sql/live-manifest.txt). Every
// scenario runs inside begin ... rollback: it seeds clusters, runs 166's body (as a pg_temp function made from the text of
// 166's migration file) and the installed 172 function side by side, and checks the two contracts of 172:
//   (1) a query with no exempt word returns exactly 166's ordered list;
//   (2) a query with exempt words returns 166's ids (fewer than 50 rows, so the cap is not reached) as a STABLE
//       PARTITION by the tier: the rows whose text has every exempt word at a word start, in 166's order, then the rest.
// ---------------------------------------------------------------------------

interface Seed {
  key: string;
  title: string;
  summary: string;
  neutral?: string;
  hoursAgo: number;
}

const SEEDS: Seed[] = [
  // miller (mil + ler): collisions are newer and rank first on 166, the real rows older
  { key: "milMili", title: "Mili Eğitim Bakanlığı toplantısı", summary: "Toplantı yapıldı.", hoursAgo: 1 },
  { key: "milMil", title: "70 mil teklifi açıklandı", summary: "Teklif sunuldu.", hoursAgo: 2 },
  { key: "milMilden", title: "Milden projesi tamamlandı", summary: "Proje bitti.", hoursAgo: 3 },
  { key: "millerTitle", title: "Miller açıklama yaptı", summary: "Açıklama geldi.", hoursAgo: 10 },
  { key: "millerApos", title: "Eski Başkan Miller'ın ziyareti", summary: "Ziyaret edildi.", hoursAgo: 20 },
  { key: "millerSummary", title: "Ziyaret gerçekleşti", summary: "Bay Miller’ı karşıladı.", hoursAgo: 30 },
  { key: "millerNeutral", title: "Yurtta ziyaret", neutral: "Miller yurdu ziyaret etti", summary: "Ziyaret sürdü.", hoursAgo: 40 },
  // bartin (bart + in): the variants arm stems bartın to 'bar'
  { key: "bartDeWever", title: "Bart De Wever istifa etti", summary: "Belçika.", hoursAgo: 1 },
  { key: "ronenBar", title: "Ronen Bar görevden alındı", summary: "Şin Bet.", hoursAgo: 2 },
  { key: "bartinTitle", title: "Bartın'da fırtına", summary: "Hava kötü.", hoursAgo: 10 },
  { key: "bartinSummary", title: "Fırtına vurdu", summary: "Bartın'ın sahili zarar gördü.", hoursAgo: 20 },
  { key: "bartinPlain", title: "Amasra", summary: "Bartin kıyıları.", hoursAgo: 25 },
  // saniye (sani + ye)
  { key: "alSani", title: "Al Sani ile görüştü", summary: "Katar.", hoursAgo: 1 },
  { key: "saniyeTitle", title: "Saniye Hanım açıklama yaptı", summary: "Haber.", hoursAgo: 25 },
  { key: "saniyeSummary", title: "Maç sona erdi", summary: "Gol son saniye atıldı.", hoursAgo: 26 },
  // irakta / zamlar (166's inflected roots, exempt too): the title without the typed word is newer
  { key: "irakBasbakan", title: "Irak Başbakanı açıklama yaptı", summary: "Başbakan basın toplantısı düzenledi.", hoursAgo: 11.8 },
  { key: "irakTitle", title: "Irak'ta saldırı", summary: "Saldırıda can kaybı yaşandı.", hoursAgo: 11.9 },
  { key: "irakSummary", title: "Orta Doğu gerginliği", summary: "Irak'ta yeni bir saldırı oldu.", hoursAgo: 60 },
  { key: "zamBare", title: "Emekli maaşına zam", summary: "Zam oranı açıklandı.", hoursAgo: 12 },
  { key: "zamlarTitle", title: "Zamlar sürüyor", summary: "Fiyatlar arttı.", hoursAgo: 50 },
  { key: "zamlarSummary", title: "Maaşlar", summary: "Zamlar belli oldu.", hoursAgo: 55 },
  // guarded words and queries 172 must not change
  { key: "burdurTitle", title: "Burdur'da yurt zehirlenmesi", summary: "Öğrenciler hastaneye kaldırıldı.", hoursAgo: 1 },
  { key: "bursa", title: "Bursa'da deprem uyarısı", summary: "Uzmanlar uyardı.", hoursAgo: 2 },
  { key: "ersan", title: "Bakanlıktan Ersan açıklaması", summary: "Açıklama yapıldı.", hoursAgo: 3 },
  { key: "erkenSecim", title: "Erken seçim anketi", summary: "Anket sonuçları.", hoursAgo: 4 },
  { key: "ilhan", title: "İlhan Kesici hayır diyecek", summary: "Konuşma yapacak.", hoursAgo: 6 },
  { key: "ilham", title: "İlham Aliyev Ankara'da", summary: "Ziyaret edecek.", hoursAgo: 7 },
  { key: "igdir", title: "Iğdır'da şehit", summary: "Şehit töreni yapıldı.", hoursAgo: 8 },
  { key: "sisli", title: "Şişli'de yol çalışması", summary: "Belediye açıklama yaptı.", hoursAgo: 12 },
  { key: "secim", title: "Seçim sonuçları açıklandı", summary: "Kurul sonuçları duyurdu.", hoursAgo: 13 },
  { key: "putin", title: "Putin Moskova'da konuştu", summary: "Kremlin açıklama yaptı.", hoursAgo: 14 },
  { key: "akp", title: "AKP'den açıklama", summary: "Parti sözcüsü konuştu.", hoursAgo: 15 },
  { key: "akParti", title: "AK Parti toplantısı", summary: "Grup toplantısı yapıldı.", hoursAgo: 16 },
  { key: "chp", title: "CHP kurultay kararı", summary: "Parti meclisi toplandı.", hoursAgo: 17 },
  { key: "erdogan", title: "Erdoğan kabine toplantısı sonrası konuştu", summary: "Açıklama yaptı.", hoursAgo: 23 },
  // rows that hold an exempt word next to a guarded word, a normal word, a negated word, or a second exempt word
  { key: "millerIrak", title: "Miller Irak'ta konuştu", summary: "Ziyaret sürdü.", hoursAgo: 70 },
  { key: "millerBurdur", title: "Miller Burdur'da konuştu", summary: "Ziyaret sürdü.", hoursAgo: 71 },
  { key: "millerAnkara", title: "Miller Ankara'da konuştu", summary: "Ziyaret sürdü.", hoursAgo: 72 },
  { key: "millerErsan", title: "Miller Ersan ile görüştü", summary: "Görüşme sürdü.", hoursAgo: 73 },
];

const seedId = (i: number): string => `00000000-0000-4000-8000-${String(172000 + i).padStart(12, "0")}`;
const KEY_BY_ID = new Map(SEEDS.map((s, i) => [seedId(i), s.key]));
const SEED_BY_KEY = new Map(SEEDS.map((s) => [s.key, s]));

const lit = (s: string): string => `'${s.replaceAll("'", "''")}'`;

interface LiveQuery {
  name: string;
  variants: string[];
  folded: string;
  /** The exempt words (ge) the query has; [] when it has none or an OR / negated phrase switches the tier off. */
  ge: string[];
}

const LIVE_QUERIES: LiveQuery[] = [
  // the defects of h58-postship-1
  { name: "miller", variants: ["miller"], folded: "miller", ge: ["miller"] },
  { name: "bartin", variants: ["bartın", "bartin"], folded: "bartin", ge: ["bartin"] },
  { name: "bartin ascii", variants: ["bartin"], folded: "bartin", ge: ["bartin"] },
  { name: "saniye", variants: ["saniye"], folded: "saniye", ge: ["saniye"] },
  // 166's inflected roots: exempt as well, so they are tiered too
  { name: "irakta", variants: ["irakta"], folded: "irakta", ge: ["irakta"] },
  { name: "zamlar", variants: ["zamlar"], folded: "zamlar", ge: ["zamlar"] },
  // two exempt words
  { name: "miller irakta", variants: ["miller irakta"], folded: "miller irakta", ge: ["miller", "irakta"] },
  // an exempt word next to a guarded one and next to a normal one
  { name: "miller burdur", variants: ["miller burdur"], folded: "miller burdur", ge: ["miller"] },
  { name: "miller ankara", variants: ["miller ankara"], folded: "miller ankara", ge: ["miller"] },
  // the two switches that empty g empty ge too
  { name: "miller or burdur", variants: ["miller or burdur"], folded: "miller or burdur", ge: [] },
  { name: "negated phrase", variants: ['miller -"x y"'], folded: 'miller -"x y"', ge: [] },
  // a negated word is no word of the query
  { name: "miller -ersan", variants: ["miller -ersan"], folded: "miller -ersan", ge: ["miller"] },
  // not exempt: guarded or not over-cut, one tier, 166's order
  { name: "burdur", variants: ["burdur"], folded: "burdur", ge: [] },
  { name: "ersan", variants: ["ersan"], folded: "ersan", ge: [] },
  { name: "ilhan", variants: ["ilhan"], folded: "ilhan", ge: [] },
  { name: "igdir", variants: ["ığdır", "iğdir", "iğdır"], folded: "igdir", ge: [] },
  { name: "sisli", variants: ["şişli"], folded: "sisli", ge: [] },
  { name: "secim", variants: ["seçim"], folded: "secim", ge: [] },
  { name: "putin", variants: ["putin"], folded: "putin", ge: [] },
  { name: "chp", variants: ["chp"], folded: "chp", ge: [] },
  { name: "erdogan", variants: ["erdoğan"], folded: "erdogan", ge: [] },
  { name: "akp alias", variants: ['akp or "ak parti"'], folded: "akp or ak parti", ge: [] },
  { name: "empty", variants: [""], folded: "", ge: [] },
];

/** The folded text lit_ok reads, for a seed: apostrophes deleted, folded, runs of non-[a-z0-9] one space. */
function litText(seed: Seed): string {
  const text = [seed.neutral ?? "", seed.title, seed.summary].join(" ").replaceAll("'", "").replaceAll("’", "");
  return foldTr(text).replace(/[^a-z0-9]+/g, " ");
}
const litOk = (seed: Seed, ge: string[]): boolean => ge.every((w) => (" " + litText(seed)).includes(" " + w));

describe.runIf(Boolean(process.env.TAYF_PSQL))("172 search exempt-word tier against a live Postgres (129, 166 and 172 applied)", () => {
  assertLiveReady("172", {
    ledger: ["129", "166", "172"],
    relations: ["public.clusters_search_tsv_live_idx", "public.clusters_search_fold_live_idx"],
    functions: ["public.search_cluster_ids(text[],text,integer)", "public.tayf_search_fold(text)"],
  });

  function runPsql(input: string): string {
    return execFileSync(process.env.TAYF_PSQL as string, ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      input,
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8", PGOPTIONS: "-c client_min_messages=warning" },
      maxBuffer: 16 * 1024 * 1024,
    });
  }

  const arr = (variants: string[]): string => `array[${variants.map(lit).join(", ")}]::text[]`;

  /** 166's function, from the text of 166's migration file, as a pg_temp function of the same shape. */
  const FN_166 =
    "create function pg_temp.f166(p_variants text[], p_folded text, p_limit integer default 12) returns table (id uuid) " +
    `language sql stable set search_path = '' as $fn$${raw166}$fn$;`;

  const rows = SEEDS.map(
    (s, i) =>
      `(${lit(seedId(i))}, ${lit(s.title)}, ${s.neutral === undefined ? "null" : lit(s.neutral)}, ${lit(s.summary)}, 2, false, now() - interval '${s.hoursAgo} hours')`,
  ).join(",\n");

  const list = (fn: string, q: LiveQuery): string =>
    `select ${lit(`${q.name}|${fn === "pg_temp.f166" ? "166" : "172"}|`)} || coalesce((select string_agg(t.id::text, ',' order by t.n) ` +
    `from ${fn}(${arr(q.variants)}, ${lit(q.folded)}, 50) with ordinality as t(id, n)), '');`;

  const script = [
    "begin;",
    FN_166,
    `insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at) values\n${rows};`,
    "analyze public.clusters;",
    ...LIVE_QUERIES.flatMap((q) => [list("pg_temp.f166", q), list("public.search_cluster_ids", q)]),
    "rollback;",
  ].join("\n");

  const ids166 = new Map<string, string[]>();
  const ids172 = new Map<string, string[]>();
  let ran = false;
  const run = (): void => {
    if (ran) return;
    ran = true;
    for (const line of runPsql(script).split("\n")) {
      if (line === "") continue;
      const [name, which, ids] = line.split("|") as [string, string, string];
      const keys = ids === "" ? [] : ids.split(",").map((id) => KEY_BY_ID.get(id) ?? `?${id}`);
      (which === "166" ? ids166 : ids172).set(name, keys);
    }
  };

  const keysOf = (m: Map<string, string[]>, name: string): string[] => {
    run();
    const v = m.get(name);
    expect(v, `no result for ${name}`).toBeDefined();
    return v as string[];
  };

  it("the fixture reproduces the defects on 166's body: the stem collisions rank above real rows", () => {
    const m = keysOf(ids166, "miller");
    expect(m.indexOf("milMili")).toBeLessThan(m.indexOf("millerSummary"));
    expect(m.indexOf("milMilden")).toBeLessThan(m.indexOf("millerSummary"));
    const b = keysOf(ids166, "bartin");
    expect(b.indexOf("bartDeWever")).toBeLessThan(b.indexOf("bartinSummary"));
    expect(b.indexOf("ronenBar")).toBeLessThan(b.indexOf("bartinPlain"));
    const s = keysOf(ids166, "saniye");
    expect(s.indexOf("alSani")).toBeLessThan(s.indexOf("saniyeSummary"));
    const i = keysOf(ids166, "irakta");
    expect(i.indexOf("irakBasbakan")).toBeLessThan(i.indexOf("irakSummary"));
    const z = keysOf(ids166, "zamlar");
    expect(z.indexOf("zamBare")).toBeLessThan(z.indexOf("zamlarSummary"));
  });

  it("'miller': every real row precedes every stem collision, and the same ids come back", () => {
    const got = keysOf(ids172, "miller");
    const real = ["millerTitle", "millerApos", "millerSummary", "millerNeutral", "millerIrak", "millerBurdur", "millerAnkara", "millerErsan"];
    expect([...got.slice(0, real.length)].sort()).toEqual([...real].sort());
    expect([...got].sort()).toEqual([...keysOf(ids166, "miller")].sort());
    for (const collision of ["milMili", "milMil", "milMilden"]) expect(got).toContain(collision);
  });

  it("'bartın' (both spellings): the Bartın rows, with the apostrophe forms and the summary-only rows, precede Bart De Wever and Ronen Bar", () => {
    // with both spellings the variants arm stems bartın to 'bar' (Ronen Bar is a candidate); the ASCII spelling alone gives 'bart'
    const collisions: Record<string, string[]> = { bartin: ["bartDeWever", "ronenBar"], "bartin ascii": ["bartDeWever"] };
    for (const name of ["bartin", "bartin ascii"]) {
      const got = keysOf(ids172, name);
      const real = ["bartinTitle", "bartinSummary", "bartinPlain"];
      expect(got.slice(0, real.length).sort(), name).toEqual([...real].sort());
      expect(got.slice(real.length).sort(), name).toEqual(collisions[name]);
    }
  });

  it("'saniye': the rows that hold the word precede Al Sani", () => {
    const got = keysOf(ids172, "saniye");
    expect(got.slice(0, 2).sort()).toEqual(["saniyeSummary", "saniyeTitle"]);
    expect(got[2]).toBe("alSani");
    expect(got).toHaveLength(3);
  });

  it("'irakta' and 'zamlar' (166's inflected roots) put the rows with the typed word first and keep every other row", () => {
    const irak = keysOf(ids172, "irakta");
    expect(irak.slice(0, 3).sort()).toEqual(["irakSummary", "irakTitle", "millerIrak"].sort());
    expect(irak).toContain("irakBasbakan");
    expect(irak.indexOf("irakSummary")).toBeLessThan(irak.indexOf("irakBasbakan"));
    const zam = keysOf(ids172, "zamlar");
    expect(zam.slice(0, 2).sort()).toEqual(["zamlarSummary", "zamlarTitle"].sort());
    expect(zam).toContain("zamBare");
    expect([...zam].sort()).toEqual([...keysOf(ids166, "zamlar")].sort());
  });

  it.each(LIVE_QUERIES.map((q) => [q.name, q] as [string, LiveQuery]))(
    "'%s': 172 is the stable partition of 166's list by the tier (no exempt word: 166's list itself), same ids, nothing dropped",
    (_name, q) => {
      const before = keysOf(ids166, q.name);
      const after = keysOf(ids172, q.name);
      const inTier = (key: string): boolean => litOk(SEED_BY_KEY.get(key) as Seed, q.ge);
      const expected = [...before.filter(inTier), ...before.filter((k) => !inTier(k))];
      expect(after).toEqual(expected);
      expect(before.length, "below the 50-row cap, so no row can be pushed out").toBeLessThan(50);
      if (q.ge.length === 0) expect(after).toEqual(before);
    },
  );

  it("the queries that must stay identical returned something to compare (the fixture is not empty for them)", () => {
    for (const name of ["burdur", "ersan", "ilhan", "igdir", "sisli", "secim", "putin", "chp", "erdogan", "akp alias"]) {
      expect(keysOf(ids166, name).length, name).toBeGreaterThan(0);
      expect(keysOf(ids172, name), name).toEqual(keysOf(ids166, name));
    }
    expect(keysOf(ids172, "empty")).toEqual([]);
  });

  it("an OR or a negated phrase switches the tier off: 166's list, order included", () => {
    expect(keysOf(ids172, "miller or burdur")).toEqual(keysOf(ids166, "miller or burdur"));
    expect(keysOf(ids172, "negated phrase")).toEqual(keysOf(ids166, "negated phrase"));
    expect(keysOf(ids166, "miller or burdur").length).toBeGreaterThan(3);
  });

  it("is applied once: one ledger row for 172 after two applications, one overload, 166's attributes and ACL, the body of the file", () => {
    const out = runPsql(`
select (select count(*) from supabase_migrations.schema_migrations where version = '172'),
       (select count(*) from pg_catalog.pg_proc where proname = 'search_cluster_ids' and pronamespace = 'public'::regnamespace and pg_get_function_identity_arguments(oid) = 'p_variants text[], p_folded text, p_limit integer'),
       p.prosecdef, p.provolatile, (p.proconfig = array['search_path=""']), p.proacl::text, md5(p.prosrc), length(p.prosrc),
       has_function_privilege('anon', p.oid, 'execute'), has_function_privilege('authenticated', p.oid, 'execute'),
       has_function_privilege('service_role', p.oid, 'execute'),
       (select l.lanname from pg_catalog.pg_language l where l.oid = p.prolang),
       obj_description(p.oid, 'pg_proc') like '%172%'
  from pg_catalog.pg_proc p
 where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
`).trim();
    const f = out.split("|");
    expect(f[0]).toBe("1"); // ledger rows for 172
    expect(f[1]).toBe("1"); // one three-argument overload
    expect(f[2]).toBe("t"); // security definer
    expect(f[3]).toBe("s"); // stable
    expect(f[4]).toBe("t"); // search_path = ''
    expect(f[5]).toBe(BASE_PROACL);
    expect(f[6]).toBe(md5(raw172)); // the function in the database is the body of the file
    expect(f[7]).toBe(String(pgLength(raw172)));
    expect(f[8]).toBe("f"); // anon
    expect(f[9]).toBe("f"); // authenticated
    expect(f[10]).toBe("t"); // service_role
    expect(f[11]).toBe("sql");
    expect(f[12]).toBe("t"); // the comment names 172
  });
});
