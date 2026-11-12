import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { foldTr, turkishQueryVariants } from "@/lib/clusters/turkish-query";
import { assertLiveReady } from "../_helpers/live-db";
import { expectLinear, rep } from "../_helpers/linear-time";

// ---------------------------------------------------------------------------
// Contract test for migration 204 ("single-letter hyphen compounds in archive search"), h144-search-2. 197 is held on another
// branch, 202 is reserved on a held branch and 203 is the price_at worker of the same batch; this file takes 204.
//
// A query with a single-letter hyphen compound (e-okul, e-devlet, e-ticaret, e-imza, e-spor, e-nabız) was answered by the folded arm
// and the stem arm of search_cluster_ids with the compound split in two words ('e-okul' -> e & okul), and 'e' is stored for every
// apostrophe dative (MEB'e), so /?q=e-okul listed 24 stories led by an Italian school-threat story and /?q=e-imza listed 24 although
// no story holds the word. 204 replaces public.search_cluster_ids(text[], text, integer) with 196's body (the live one) and THREE
// edits: (1) the f CTE gets a column cmp, the AND of the compound lexemes the Turkish text-search config stores for the folded
// query; (2) q.qf is `qf && cmp` and the stem query qs is built from the compound-free query, then `&& cmp`; (3) the literal tier
// (lw) ignores one-letter words, but only for a compound query (review: s-400 keeps its ORDER). This file pins, without a database: the file, ledger and transaction, that 196's body is the base (md5
// pinned), a derive-and-compare of 204's body against 196's (only the f, q, qs and lw CTEs differ, and by exactly the pinned
// statements), the regex constant, the header, the docs section, the dry-run and the live-manifest entry. The opt-in live block
// (TAYF_PSQL) runs 196's body and 204's function side by side on fixtures inside a rolled-back transaction.
//
// No regular expression is applied to quoted SQL literals in this file (CodeQL js/redos): the SQL is scanned with indexOf and
// character loops, and a string pattern is replaced with replaceAll, never replace.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const FILE_204 = "204_search_single_letter_compounds.sql";
const MIGRATION_204 = resolve(MIGRATIONS_DIR, FILE_204);
const MIGRATION_196 = resolve(MIGRATIONS_DIR, "196_search_ascii_inflection_roots.sql");
const DRYRUN_204 = resolve(ROOT, "tests", "migrations", "sql", "204-search-single-letter-compounds-dryrun.sql");
const MANIFEST = resolve(ROOT, "tests", "migrations", "sql", "live-manifest.txt");
const DOC_MIGRATION_GUIDE = resolve(ROOT, "docs", "migration-guide.md");

/** md5 and length of 196's function body: the base of 204, and what production runs (read-only, 2026-11-12). 198 replaced only the helper. */
const BASE_MD5 = "c384c1f3a0dc337e5243b5a3e55985c0";
const BASE_LENGTH = 19562;
/** The helper as 198 left it (production, 2026-11-12): 204 calls it by name and does not touch it. */
const HELPER_MD5 = "e282da4628010153155d3bd8986db77f";
const HELPER_LENGTH = 5133;
const PROD_PROACL = "{postgres=X/postgres,service_role=X/postgres}";

const LEDGER_STMT =
  "insert into supabase_migrations.schema_migrations (version, name) values ('204', '204_search_single_letter_compounds') on conflict do nothing;";
const REVOKE_FN = "revoke all on function public.search_cluster_ids(text[], text, integer) from public, anon, authenticated;";
const GRANT_FN = "grant execute on function public.search_cluster_ids(text[], text, integer) to service_role;";

/** The compound regex: a constant. A single letter at the start of a word, a hyphen, then at least two letters or digits. */
const COMPOUND_RE = "'(?:^|[^a-z0-9])([a-z]-[a-z0-9]{2,})'";

// The four statements that differ from 196, comments stripped and whitespace collapsed (the old text, then the new text).
// Edit 1: the f CTE gets cmp.
const OLD_F =
  "), f as ( select pg_catalog.regexp_replace(f0.ff, '\"|(?<=[a-z0-9])-(?=[a-z0-9])', ' ', 'g') as s, pg_catalog.btrim(pg_catalog.regexp_replace(f0.ff, '[^a-z0-9]+', ' ', 'g')) as lit from f0 ), q as (";
const NEW_F =
  "), f as ( select pg_catalog.regexp_replace(f0.ff, '\"|(?<=[a-z0-9])-(?=[a-z0-9])', ' ', 'g') as s, pg_catalog.btrim(pg_catalog.regexp_replace(f0.ff, '[^a-z0-9]+', ' ', 'g')) as lit, " +
  "(select pg_catalog.string_agg('''' || u.lexeme || '''', ' & ' order by u.lexeme)::pg_catalog.tsquery from (select distinct c.lexeme from pg_catalog.regexp_matches(f0.ff, " +
  COMPOUND_RE +
  ", 'g') as x(m) cross join lateral pg_catalog.unnest(pg_catalog.to_tsvector('pg_catalog.turkish'::pg_catalog.regconfig, x.m[1])) as c(lexeme, positions, weights) " +
  "where pg_catalog.strpos(c.lexeme, '-') > 1) u) as cmp from f0 ), q as (";
// Edit 2a: q.qf is the 196 expression, then `&& cmp`; qb is the 196 expression alone; cmp rides along for qs.
const OLD_Q =
  "case when pg_catalog.strpos(x.w::pg_catalog.text, '<') > 0 then pg_catalog.plainto_tsquery('pg_catalog.turkish'::pg_catalog.regconfig, f.s) else x.w end as qf, f.lit from f cross join lateral (select pg_catalog.websearch_to_tsquery('pg_catalog.turkish'::pg_catalog.regconfig, f.s) as w) x ), qs as (";
const NEW_Q =
  "case when f.cmp is null then y.b else y.b && f.cmp end as qf, y.b as qb, f.cmp, f.lit from f cross join lateral (select pg_catalog.websearch_to_tsquery('pg_catalog.turkish'::pg_catalog.regconfig, f.s) as w) x " +
  "cross join lateral (select case when pg_catalog.strpos(x.w::pg_catalog.text, '<') > 0 then pg_catalog.plainto_tsquery('pg_catalog.turkish'::pg_catalog.regconfig, f.s) else x.w end as b) y ), qs as (";
// Edit 2b: qs is built from qb (no compound), then `&& cmp` (folded).
const OLD_QS =
  "), qs as ( select case when pg_catalog.numnode(q.qf) = 0 then null else public.tayf_ascii_inflection_expand(pg_catalog.to_tsquery('pg_catalog.simple'::pg_catalog.regconfig, public.tayf_search_fold(q.qf::pg_catalog.text))) end as qs from q ), cand as (";
const NEW_QS =
  "), qs as ( select case when pg_catalog.numnode(q.qb) = 0 then null else (select case when q.cmp is null then t.s else t.s && public.tayf_search_fold(q.cmp::pg_catalog.text)::pg_catalog.tsquery end " +
  "from (select public.tayf_ascii_inflection_expand(pg_catalog.to_tsquery('pg_catalog.simple'::pg_catalog.regconfig, public.tayf_search_fold(q.qb::pg_catalog.text))) as s) t) end as qs from q ), cand as (";
// Edit 3: the literal tier ignores one-letter words OF A COMPOUND QUERY (f.cmp is not null). A letter-digit query (s-400, u-19, f-35) has no
// compound lexeme, so its cmp is null and its literal tier is 196's: h145 review (db-204-lw-unscoped-one-letter).
const OLD_LW = "where s.w <> '' and not exists (select 1 from g0 o where";
const NEW_LW = "where s.w <> '' and (pg_catalog.length(s.w) >= 2 or (select f.cmp from f) is null) and not exists (select 1 from g0 o where";

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

/**
 * The second argument of every regexp_replace( / regexp_split_to_table( / regexp_matches( call, read with a quote- and paren-aware
 * splitter. The pattern of such a call must be a plain quoted constant: that is how "no user value reaches a regex" is checked.
 */
function regexPatterns(sql: string): string[] {
  const out: string[] = [];
  for (const fnName of ["regexp_replace(", "regexp_split_to_table(", "regexp_matches("]) {
    let from = 0;
    for (;;) {
      const at = sql.indexOf(fnName, from);
      if (at < 0) break;
      from = at + fnName.length;
      let depth = 0;
      let inStr = false;
      let arg = 0;
      let cur = "";
      for (let i = from; i < sql.length; i++) {
        const ch = sql[i] as string;
        if (inStr) {
          cur += ch;
          if (ch === "'") {
            if (sql[i + 1] === "'") {
              cur += "'";
              i++;
            } else {
              inStr = false;
            }
          }
          continue;
        }
        if (ch === "'") {
          inStr = true;
          cur += ch;
          continue;
        }
        if (ch === "(") depth++;
        if (ch === ")") {
          if (depth === 0) {
            if (arg === 1) out.push(cur.trim());
            break;
          }
          depth--;
        }
        if (ch === "," && depth === 0) {
          if (arg === 1) {
            out.push(cur.trim());
            break;
          }
          arg++;
          cur = "";
          continue;
        }
        cur += ch;
      }
    }
  }
  return out;
}

/** The CTEs of a function body, as [name, text] pairs, split at the `), name as (` markers (the first is `with f0 as (`). */
function splitCtes(body: string): Array<[string, string]> {
  const marker = "\n  ), ";
  const out: Array<[string, string]> = [];
  const first = body.indexOf("with ");
  const firstName = body.slice(first + 5, body.indexOf(" as (", first));
  let start = first;
  let name = firstName;
  let from = start;
  for (;;) {
    const at = body.indexOf(marker, from);
    if (at < 0) break;
    out.push([name, body.slice(start, at)]);
    const nameStart = at + marker.length;
    name = body.slice(nameStart, body.indexOf(" as (", nameStart));
    start = at;
    from = at + marker.length;
  }
  const tail = body.indexOf("\n  )\n  select h.id", start);
  out.push([name, body.slice(start, tail)]);
  out.push(["<final select>", body.slice(tail)]);
  return out;
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
let fn204 = "";
let cb204 = "";
/** The body as the database stores it (prosrc): comments included. */
let raw204 = "";

if (existsSync(MIGRATION_204)) {
  sql = readFileSync(MIGRATION_204, "utf8");
  code = stripComments(sql);
  head = sql.slice(0, sql.indexOf("\nbegin;"));
  fn204 = functionBlock(code, "search_cluster_ids");
  cb204 = collapse(fnBody(fn204));
  raw204 = fnBody(functionBlock(sql, "search_cluster_ids"));
}
const sql196 = readFileSync(MIGRATION_196, "utf8");
const fn196 = functionBlock(stripComments(sql196), "search_cluster_ids");
const cb196 = collapse(fnBody(fn196));
const raw196 = fnBody(functionBlock(sql196, "search_cluster_ids"));

describe("204 file, ledger and structure", () => {
  it("exists with the exact name, and no other migration claims the number 204", () => {
    expect(existsSync(MIGRATION_204)).toBe(true);
    const claimed = readdirSync(MIGRATIONS_DIR).filter((n) => n.startsWith("204_"));
    expect(claimed).toEqual([FILE_204]);
  });

  it("contains the ledger insert for '204' with on conflict do nothing, the last statement before commit", () => {
    const c = collapse(code);
    expect(c).toContain(LEDGER_STMT);
    expect(c.endsWith(`${LEDGER_STMT} commit;`)).toBe(true);
  });

  it("is wrapped in a single begin/commit and sets lock_timeout 5s first", () => {
    const c = collapse(code);
    expect(countOf(c, "begin;")).toBe(1);
    expect(countOf(c, "commit;")).toBe(1);
    expect(c.startsWith("begin; set local lock_timeout = '5s'; create or replace function public.search_cluster_ids(")).toBe(true);
    expect(c.endsWith("commit;")).toBe(true);
  });

  it("is function-only: one function replace, one comment, the ledger row; no drop, alter, truncate, update, delete, table, index or trigger", () => {
    const bare = sansStrings(code).toLowerCase();
    for (const bad of ["drop ", "alter ", "truncate", "delete ", "update ", "create table", "create unique", "create index", "create trigger", "create view", "create extension", "create function"]) {
      expect(bare.includes(bad), bad).toBe(false);
    }
    expect(countOf(bare, "create or replace function")).toBe(1);
    expect(countOf(bare, "insert into ")).toBe(1);
    expect(countOf(bare, "comment on ")).toBe(1);
    expect(bare).toContain("insert into supabase_migrations.schema_migrations");
  });

  it("grants no table, sequence or schema privilege, and exactly one function grant, to service_role, after its revoke", () => {
    const bare = sansStrings(code).toLowerCase();
    expect(bare).not.toContain("on table");
    expect(bare).not.toContain("on all tables");
    expect(bare).not.toContain("on sequence");
    expect(bare).not.toContain("on schema");
    const c = collapse(code);
    expect(countOf(c, "grant ")).toBe(1);
    expect(countOf(c, "revoke ")).toBe(1);
    expect(c).toContain(REVOKE_FN);
    expect(c).toContain(GRANT_FN);
    expect(c.indexOf(REVOKE_FN)).toBeLessThan(c.indexOf(GRANT_FN));
  });

  it("reloads the PostgREST schema cache, after the function and before the ledger insert", () => {
    const c = collapse(code);
    expect(c).toContain("notify pgrst, 'reload schema';");
    expect(c.indexOf("notify pgrst")).toBeLessThan(c.indexOf("insert into supabase_migrations"));
    expect(c.indexOf("notify pgrst")).toBeGreaterThan(c.indexOf(GRANT_FN));
  });

  it("single-quote characters balance once comments are stripped (no string literal holds two dashes)", () => {
    expect(countOf(code, "'") % 2).toBe(0);
  });

  it("names the numbers around it (197 held, 202 reserved, 203 taken) and the migrations it builds on", () => {
    for (const n of ["197", "202", "203", "196", "198", "194", "186", "129", "083", "PGRST202", "h144-search-2"]) expect(head, n).toContain(n);
  });
});

describe("204 search_cluster_ids(text[], text, integer)", () => {
  it("is the only definition of it and has 196's signature: create or replace, no drop, no new overload", () => {
    expect(fn204.startsWith("create or replace function public.search_cluster_ids(p_variants text[], p_folded text, p_limit integer default 12)")).toBe(true);
    expect(countOf(code, "create or replace function public.search_cluster_ids(")).toBe(1);
  });

  it("has exactly 196's header: returns table (id uuid), language sql, stable, security definer, search_path ''", () => {
    expect(collapse(fnHeader(fn204))).toBe(collapse(fnHeader(fn196)));
    const h = collapse(fnHeader(fn204));
    expect(h).toContain("returns table (id uuid)");
    expect(h).toContain("language sql");
    expect(h).toContain("stable");
    expect(h).toContain("security definer");
    expect(h).toContain("set search_path = ''");
  });

  it("has a function comment that names the compound rule and the migrations it builds on", () => {
    const c = collapse(code);
    const at = c.indexOf("comment on function public.search_cluster_ids(text[], text, integer) is");
    expect(at).toBeGreaterThan(-1);
    const comment = c.slice(at, c.indexOf("revoke all", at)).toLowerCase();
    for (const word of ["204", "196", "194", "186", "185", "172", "166", "129", "display title", "three separate index scans", "p_folded", "recall", "e-okul", "single-letter", "one-letter", "returns ids only", "service_role only"]) {
      expect(comment, word).toContain(word);
    }
  });

  it("touches only the three-argument function: 083's two-argument overload, the helper and the fold helpers are not defined, replaced or granted", () => {
    let from = 0;
    let seen = 0;
    for (;;) {
      const at = code.indexOf("search_cluster_ids(", from);
      if (at < 0) break;
      seen++;
      const rest = code.slice(at + "search_cluster_ids(".length);
      expect(rest.startsWith("p_variants text[], p_folded text, p_limit integer") || rest.startsWith("text[], text, integer)"), rest.slice(0, 40)).toBe(true);
      from = at + 1;
    }
    expect(seen).toBe(4); // create or replace, comment on, revoke, grant
    for (const other of ["tayf_ascii_inflection_expand(tsquery)", "tayf_search_fold(text)", "tayf_search_stem_fold(tsvector)"]) {
      expect(countOf(code, `function public.${other}`), other).toBe(0);
    }
    expect(head).toContain("083");
    expect(head).toContain("PGRST202");
  });

  it("every catalog function the body calls is schema-qualified (empty search_path), every cast names pg_catalog, and the helpers are public.-qualified", () => {
    const bare = sansStrings(cb204);
    const catalog = [
      "left", "length", "strpos", "lower", "translate", "replace", "chr", "regexp_replace", "regexp_split_to_table", "regexp_matches", "substr",
      "ts_lexize", "ts_rank_cd", "to_tsvector", "websearch_to_tsquery", "plainto_tsquery", "to_tsquery", "numnode", "now", "btrim", "ln", "string_agg", "unnest",
    ];
    for (const name of catalog) {
      let from = 0;
      for (;;) {
        const at = bare.indexOf(`${name}(`, from);
        if (at < 0) break;
        from = at + name.length;
        if (isIdentChar(bare[at - 1]) && bare.slice(at - 11, at) !== "pg_catalog.") continue;
        expect(at, `${name}( at ${at}`).toBeGreaterThanOrEqual(11);
        expect(bare.slice(at - 11, at), `${name}( at ${at}`).toBe("pg_catalog.");
      }
    }
    let from = 0;
    for (;;) {
      const at = bare.indexOf("::", from);
      if (at < 0) break;
      from = at + 2;
      const rest = bare.slice(at + 2);
      expect(rest.startsWith("pg_catalog.") || rest.startsWith("''"), bare.slice(at, at + 24)).toBe(true);
    }
    expect(countOf(cb204, "tayf_ascii_inflection_expand(")).toBe(1);
    expect(countOf(cb204, "public.tayf_ascii_inflection_expand(")).toBe(1);
  });
});

describe("204 body = 196's body with the three edits, nothing else", () => {
  it("196's body is the base: its md5 and length are the recorded ones, and production runs it (read-only, 2026-11-12)", () => {
    expect(md5(raw196)).toBe(BASE_MD5);
    expect(pgLength(raw196)).toBe(BASE_LENGTH);
    const at = head.indexOf("\n-- BASE");
    expect(at).toBeGreaterThan(-1);
    const base = head.slice(at, head.indexOf("\n-- STEP 0", at));
    for (const word of [BASE_MD5, String(BASE_LENGTH), "production", HELPER_MD5, String(HELPER_LENGTH), "198"]) expect(base, word).toContain(word);
  });

  it("derive-and-compare: only the f, q, qs and lw CTEs differ, the others and the final select are 196's text byte for byte, comments included, in the same order", () => {
    const a = splitCtes(raw196);
    const b = splitCtes(raw204);
    expect(b.map(([n]) => n)).toEqual(a.map(([n]) => n));
    expect(a.map(([n]) => n)).toEqual(["f0", "g0", "gx", "g", "ge", "f", "q", "qs", "cand", "kept", "top", "lw", "hits", "<final select>"]);
    const differing = b.filter(([, t], i) => t !== (a[i] as [string, string])[1]).map(([n]) => n);
    expect(differing).toEqual(["f", "q", "qs", "lw"]);
  });

  it("the four statements are exactly these (comments stripped): swapping them back gives 196's body", () => {
    for (const [oldText, newText] of [
      [OLD_F, NEW_F],
      [OLD_Q, NEW_Q],
      [OLD_QS, NEW_QS],
      [OLD_LW, NEW_LW],
    ] as const) {
      expect(cb196, oldText).toContain(oldText);
      expect(countOf(cb196, oldText), oldText).toBe(1);
      expect(cb204, newText).toContain(newText);
      expect(countOf(cb204, newText), newText).toBe(1);
      expect(cb204.includes(oldText), oldText).toBe(false);
    }
    let back = cb204;
    for (const [oldText, newText] of [
      [OLD_F, NEW_F],
      [OLD_Q, NEW_Q],
      [OLD_QS, NEW_QS],
      [OLD_LW, NEW_LW],
    ] as const) {
      back = back.replaceAll(newText, oldText);
    }
    expect(back).toBe(cb196);
  });

  it("edit 1: cmp is the AND of the compound lexemes the Turkish config stores, null without a match, read through the tsquery input cast and never to_tsquery or plainto_tsquery", () => {
    const f = splitCtes(raw204).find(([n]) => n === "f");
    expect(f).toBeDefined();
    const fCode = collapse(stripComments((f as [string, string])[1]));
    expect(countOf(fCode, COMPOUND_RE)).toBe(1);
    expect(fCode).toContain("pg_catalog.string_agg('''' || u.lexeme || '''', ' & ' order by u.lexeme)::pg_catalog.tsquery");
    expect(fCode).toContain("pg_catalog.to_tsvector('pg_catalog.turkish'::pg_catalog.regconfig, x.m[1])");
    expect(fCode).toContain("where pg_catalog.strpos(c.lexeme, '-') > 1");
    // the compound text is the SUBJECT of a match, never a pattern, and never reaches a query parser
    for (const bad of ["to_tsquery(", "plainto_tsquery(", "websearch_to_tsquery(", "phraseto_tsquery(", "execute", "format(", "quote_literal"]) {
      expect(fCode.includes(bad), bad).toBe(false);
    }
    // the only tsquery in the whole body that is built from the compound is the cast; the one to_tsquery still reads the compound-free query
    expect(countOf(cb204, "pg_catalog.to_tsquery(")).toBe(countOf(cb196, "pg_catalog.to_tsquery("));
    expect(countOf(cb204, "pg_catalog.plainto_tsquery(")).toBe(countOf(cb196, "pg_catalog.plainto_tsquery("));
    expect(countOf(cb204, "pg_catalog.websearch_to_tsquery(")).toBe(countOf(cb196, "pg_catalog.websearch_to_tsquery("));
  });

  it("edit 2: qf is the 196 expression, then && cmp; qs is built from the compound-free qb and only then && cmp (folded); qf and qs never read each other", () => {
    expect(cb204).toContain("case when f.cmp is null then y.b else y.b && f.cmp end as qf, y.b as qb, f.cmp, f.lit");
    const qs = splitCtes(raw204).find(([n]) => n === "qs");
    expect(qs).toBeDefined();
    const qsCode = collapse(stripComments((qs as [string, string])[1]));
    expect(qsCode.includes("q.qf")).toBe(false);
    // the compound reaches qs only as a folded tsquery cast, after the helper has run on the compound-free query
    expect(countOf(qsCode, "q.cmp")).toBe(2);
    expect(qsCode).toContain("t.s && public.tayf_search_fold(q.cmp::pg_catalog.text)::pg_catalog.tsquery");
    // (the helper and to_tsquery read qb only: the text between the helper call and the end of its select holds no cmp)
    const helperArg = qsCode.slice(qsCode.indexOf("tayf_ascii_inflection_expand("), qsCode.indexOf(") as s)"));
    expect(helperArg).toContain("public.tayf_search_fold(q.qb::pg_catalog.text)");
    expect(helperArg.includes("cmp")).toBe(false);
    // 196's ORDER BY and the folded arm read q.qf, the third arm reads qs, exactly as before
    expect(cb204).toContain("@@ (select qf from q)");
    expect(cb204).toContain("@@ (select qs from qs)");
    const tail = cb204.slice(cb204.indexOf("select h.id from hits h cross join q"));
    expect(tail).toContain("q.qf");
    expect(tail.includes("q.qb")).toBe(false);
    expect(tail.includes("cmp")).toBe(false);
  });

  it("edit 3: the literal tier ignores a one-letter word only for a compound query (f.cmp is not null), once, inside lw, before the or / negated-phrase switches", () => {
    expect(countOf(cb204, "pg_catalog.length(s.w) >= 2")).toBe(1);
    expect(countOf(cb204, "(select f.cmp from f) is null")).toBe(1);
    const lw = splitCtes(raw204).find(([n]) => n === "lw");
    expect(lw).toBeDefined();
    const lwCode = collapse(stripComments((lw as [string, string])[1]));
    expect(lwCode).toContain(NEW_LW);
    expect(lwCode.indexOf("pg_catalog.length(s.w) >= 2")).toBeLessThan(lwCode.indexOf("not exists"));
    // the one-letter word is kept when cmp is null: a letter-digit query (s-400) and a plain query ('e okul') keep 196's literal tier
    expect(lwCode).toContain("or (select f.cmp from f) is null)");
    expect(lwCode.indexOf("(select f.cmp from f) is null")).toBeLessThan(lwCode.indexOf("not exists"));
    // no other CTE (the guard, the over-cut test) reads that condition
    for (const [n, t] of splitCtes(raw204)) {
      if (n !== "lw") expect(t.includes("pg_catalog.length(s.w) >= 2"), n).toBe(false);
    }
  });

  it("adds one regex to the body, a quoted constant with no concatenation; p_variants, p_folded and p_limit are read exactly where they were", () => {
    const old = regexPatterns(cb196);
    const now = regexPatterns(cb204);
    expect([...now].sort()).toEqual([...old, COMPOUND_RE].sort());
    for (const p of now) {
      expect(p.startsWith("'") && p.endsWith("'"), p).toBe(true);
      expect(p.includes("||"), p).toBe(false);
    }
    expect(countOf(cb204, "p_variants")).toBe(countOf(cb196, "p_variants"));
    expect(countOf(cb204, "p_folded")).toBe(countOf(cb196, "p_folded"));
    expect(countOf(cb204, "p_limit")).toBe(countOf(cb196, "p_limit"));
    expect(cb204.endsWith("limit greatest(1, least(coalesce(p_limit, 12), 50));")).toBe(true);
    expect(cb204).toContain("select k.id from kept k order by k.updated_at desc, k.id limit 1000");
  });

  it("the compound regex is linear (CodeQL js/redos): no nested quantifier, and its JavaScript twin finishes on hostile strings", () => {
    const body = COMPOUND_RE.slice(1, -1);
    expect(body).toBe("(?:^|[^a-z0-9])([a-z]-[a-z0-9]{2,})");
    // one unbounded quantifier, on a character class, nothing after it that can also match the class: no backtracking blow-up
    expect(countOf(body, "{2,}")).toBe(1);
    expect(countOf(body, "+")).toBe(0);
    expect(countOf(body, "*")).toBe(0);
    const twin = /(?:^|[^a-z0-9])([a-z]-[a-z0-9]{2,})/g;
    const want = (s: string): string[] => [...s.matchAll(twin)].map((m) => m[1] as string);
    expect(want("e-okul")).toEqual(["e-okul"]);
    expect(want("okul -e-devlet e-imza")).toEqual(["e-devlet", "e-imza"]);
    expect(want("f-16 s-400")).toEqual(["f-16", "s-400"]);
    for (const none of ["iran-israil", "chp-mhp", "covid-19", "e-o", "e--okul", "ee-okul", "okul"]) expect(want(none), none).toEqual([]);
    // correctness on hostile strings, then the growth over a size ladder (CPU time, load-robust: tests/_helpers/linear-time.ts, no wall-clock budget)
    expect(want("-".repeat(50000))).toEqual([]);
    expect(want("a-".repeat(25000))).toEqual([]);
    expect(want(`e-${"a".repeat(50000)}`)).toEqual([`e-${"a".repeat(50000)}`]);
    expect(want("a-b".repeat(20000))).toEqual(["a-ba"]);
    expect(want(" e-".repeat(20000))).toEqual([]);
    expect(want(" e-ab".repeat(20000)).length).toBe(20000);
    for (const [unit, prefix] of [["-", ""], ["a-", ""], ["a", "e-"], ["a-b", ""], [" e-", ""], [" e-ab", ""]] as const) {
      expectLinear(rep(unit, prefix), (s) => want(s), { n: 200_000, ceilingMs: 4000 });
    }
  });
});

describe("204 header", () => {
  const section = (from: string, to: string): string => {
    const at = head.indexOf(`\n-- ${from}`);
    expect(at, from).toBeGreaterThan(-1);
    return head.slice(at, head.indexOf(`\n-- ${to}`, at + 5));
  };
  const prose = (s: string): string =>
    collapse(
      s
        .split("\n")
        .map((l) => (l.startsWith("--") ? l.slice(2) : l))
        .join(" "),
    );

  it("documents WHY, WHAT, BASE, STEP 0, REPLAY, COST, KNOWN LIMITS, LEDGER, VERIFY and ROLLBACK", () => {
    for (const s of ["WHY", "WHAT", "BASE", "STEP 0", "REPLAY", "COST", "KNOWN LIMITS", "LEDGER", "VERIFY", "ROLLBACK"]) {
      expect(head, s).toContain(`\n-- ${s}`);
    }
    expect(head).toContain("h144-search-2");
  });

  it("records the md5 and length of the NEW body, and they match this file (the test recomputes them)", () => {
    const newMd5 = md5(raw204);
    expect(newMd5).not.toBe(BASE_MD5);
    const verify = section("VERIFY", "Safe to re-apply");
    expect(verify).toContain(`expect ${newMd5}, ${pgLength(raw204)}.`);
  });

  it("WHY names the live evidence: the split compound, the dative e, the two pages, the SQL and the three code lines", () => {
    const why = prose(section("WHY", "WHAT"));
    for (const word of [
      "e-okul", "e-imza", "en ilgili 24 sonuç", "1da586db", "websearch_to_tsquery('turkish','e-okul')", "'e-okul' <-> 'e' <-> 'okul'", "MEB'e",
      "10", "regexp_replace", "qs", "literal tier", "single letter", "196",
    ]) {
      expect(why, word).toContain(word);
    }
  });

  it("WHAT names the three edits, the cast, qs without the compound, the lw guard, the lexeme the parser stores (e-nap, f-16) and that no index changes", () => {
    const what = prose(section("WHAT", "BASE"));
    for (const word of [
      "cmp", "tsquery input cast", "never to_tsquery", "qb", "qs is built from", "&& cmp", "'<'", "length(s.w) >= 2", "one-letter", "e-nap", "f-16", "s-400",
      "no index", "SECURITY DEFINER", "search_path", "grants", "ledger", "to_tsvector", "linear",
    ]) {
      expect(what, word).toContain(word);
    }
  });

  it("BASE records 196's fingerprint, the helper of 198, and that production runs them; STEP 0 records the prod md5 of the pieces it reads", () => {
    const base = section("BASE", "STEP 0");
    for (const word of [BASE_MD5, String(BASE_LENGTH), HELPER_MD5, String(HELPER_LENGTH), PROD_PROACL, "production"]) expect(base, word).toContain(word);
    const step0 = section("STEP 0", "REPLAY");
    for (const word of [BASE_MD5, "19562", HELPER_MD5, "709be5df31d85ac692729f673e7e7900", "77a0656fab6d06f5fb86f75afdfb6391", "aabf54347c8f929090419335d5d48f19"]) expect(step0, word).toContain(word);
  });

  it("REPLAY holds the measured rows: the five compounds, the ordinary queries, the id-set diffs and the page order", () => {
    const replay = prose(section("REPLAY", "COST"));
    for (const word of ["e-okul", "e-devlet", "e-ticaret", "e-imza", "e-nabız", "e-spor", "identical", "id set", "ordinary", "EXPLAIN", "inline", "read-only", "top 24"]) {
      expect(replay, word).toContain(word);
    }
  });

  it("COST says what the measurement is, that the plans keep the three index scans, and the old and new timings of three queries", () => {
    const cost = prose(section("COST", "KNOWN LIMITS"));
    for (const word of ["EXPLAIN (ANALYZE)", "same arguments", "clusters_search_fold_live_idx", "clusters_search_stemfold_live_idx", "ms", "okul", "deprem"]) {
      expect(cost, word).toContain(word);
    }
  });

  it("KNOWN LIMITS says what a compound query no longer finds, the negated compound, the digit tail, and that an alias or OR query ANDs its compounds", () => {
    const limits = prose(section("KNOWN LIMITS", "LEDGER"));
    for (const word of ["e devlet", "negated", "-e-okul", "variants arm", "digit", "f-16", "or", "one-letter word", "literal tier"]) {
      expect(limits, word).toContain(word);
    }
  });

  it("ROLLBACK: re-run 196's function statement and comment, then the ledger row, in that order", () => {
    const r = section("ROLLBACK", "See tests/");
    expect(r).toContain("196_search_ascii_inflection_roots.sql");
    expect(r).toContain(BASE_MD5);
    expect(r).toContain("delete from supabase_migrations.schema_migrations where version = '204';");
    expect(r).toContain("notify pgrst, 'reload schema';");
    expect(r.indexOf("196_search_ascii_inflection_roots.sql")).toBeLessThan(r.indexOf("delete from supabase_migrations"));
    expect(r.includes("drop function")).toBe(false);
  });
});

describe("204 docs/migration-guide.md", () => {
  const guide = readFileSync(DOC_MIGRATION_GUIDE, "utf8");
  const sec = sectionOf(guide, "204");

  it("has a 204 section, after section 199, whose title says APPLY 204", () => {
    expect(sec).not.toBe("");
    expect(sectionOf(guide, "199")).not.toBe("");
    expect(guide.indexOf("\n## 204 ")).toBeGreaterThan(guide.indexOf("\n## 199 "));
    expect(sec.split("\n")[1]).toContain("APPLY 204");
  });

  it("has Why, What, an md5 table, Replay, Cost, Order, Verify and Rollback", () => {
    for (const label of ["**Why:**", "**What 204 does**", "| | md5(prosrc) | length |", "**Replay**", "**Cost**", "**Order:**", "**Verify**", "**Rollback:**"]) {
      expect(sec, label).toContain(label);
    }
  });

  it("records the md5 of 196's body (production's, the base) and of 204, matching the file", () => {
    expect(sec).toContain(`\`${BASE_MD5}\` | ${BASE_LENGTH}`);
    expect(sec).toContain(`\`${md5(raw204)}\` | ${pgLength(raw204)}`);
  });

  it("states the order: 196 and 198 are applied, 204 needs no deploy order and no app change; 197 and 202 are not prerequisites", () => {
    const s = sec.slice(sec.indexOf("**Order:**"), sec.indexOf("**Verify**"));
    for (const word of ["204_search_single_letter_compounds.sql", "no deploy order", "196", "198", "197", "202", "203", "no app change"]) expect(s, word).toContain(word);
  });

  it("verifies the fingerprint, the privileges, the ledger row and the live queries; the rollback restores 196", () => {
    const v = sec.slice(sec.indexOf("**Verify**"), sec.indexOf("**Rollback:**"));
    for (const word of [md5(raw204), "has_function_privilege", "version = '204'", "/?q=e-imza", "sonuç bulunamadı", "/?q=e-okul", "e-Okul"]) {
      expect(v, word).toContain(word);
    }
    const r = sec.slice(sec.indexOf("**Rollback:**"));
    for (const word of ["196_search_ascii_inflection_roots.sql", BASE_MD5, "delete from supabase_migrations.schema_migrations where version = '204'"]) {
      expect(r, word).toContain(word);
    }
  });

  it("What 204 does names the three edits and the deviation from the literal cast (the stored lexeme: e-nap, f-16)", () => {
    const what = sec.slice(sec.indexOf("**What 204 does**"), sec.indexOf("| | md5(prosrc) | length |"));
    for (const word of ["`cmp`", "`qs`", "`lw`", "`e-nap`", "`f-16`", "tsquery input cast", "one-letter"]) expect(what, word).toContain(word);
  });

  it("uses no fenced sql block (tests/guards/docs-sql-snippets.test.ts scans those)", () => {
    expect(sec).not.toContain("```");
  });
});

describe("204 dry-run and live manifest", () => {
  const dry = existsSync(DRYRUN_204) ? readFileSync(DRYRUN_204, "utf8") : "";

  it("builds 204's database with its own dry-run script: one run entry, that script as the only setup file", () => {
    const lines = readFileSync(MANIFEST, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("run | 204-search-single-letter-compounds.test.ts"));
    expect(lines).toEqual(["run | 204-search-single-letter-compounds.test.ts | tests/migrations/sql/204-search-single-letter-compounds-dryrun.sql | - | 0"]);
  });

  it("the dry-run builds production's state (the 129 setup, 166, 172, 185, 186, 194, 196, 198, gated on 196's md5), applies 204 twice and ends with its OK line", () => {
    expect(existsSync(DRYRUN_204)).toBe(true);
    const ir = dry
      .split("\n")
      .filter((l) => l.startsWith("\\ir "))
      .map((l) => l.slice(4).trim());
    expect(ir).toEqual([
      "166-search-overstem-guard-setup.sql",
      "../../../supabase/migrations/166_search_overstem_guard.sql",
      "../../../supabase/migrations/172_search_exempt_word_tier.sql",
      "../../../supabase/migrations/185_search_sibling_variants.sql",
      "../../../supabase/migrations/186_search_stem_fold_arm.sql",
      "../../../supabase/migrations/194_search_rank_display_title.sql",
      "../../../supabase/migrations/196_search_ascii_inflection_roots.sql",
      "../../../supabase/migrations/198_search_ascii_root_deny_collisions.sql",
      "../../../supabase/migrations/204_search_single_letter_compounds.sql",
      "../../../supabase/migrations/204_search_single_letter_compounds.sql",
    ]);
    for (const word of [BASE_MD5, String(BASE_LENGTH), HELPER_MD5, String(HELPER_LENGTH), md5(raw204), String(pgLength(raw204))]) expect(dry, word).toContain(word);
    expect(dry.trimEnd().endsWith("\\echo DRYRUN 204 OK")).toBe(true);
    expect(dry).toContain("-f tests/migrations/sql/stub.sql");
    expect(dry).toContain("D=$(mktemp -d)");
    expect(dry).toContain("-- or: bash tests/migrations/sql/run-live.sh");
  });

  it("the dry-run shows the defect on 196's body, then 204: the compounds, the spec's fixtures, the six regressions, hostile strings, qf and qs without '<', the plan, the timing", () => {
    for (const q of [
      "e-okul", "e-imza", "e-devlet", "e-nabız", "e-nabiz", "e-spor", "e-posta", "e-okulu", "e-okul e-devlet", "okul -e-okul",
      "f-16", "s-400", "iran-israil", "chp-mhp", "okul", "devlet", "erdogan", "deprem", "emekli maasi", "burdur",
    ]) {
      expect(dry, q).toContain(`'${q}'`);
    }
    for (const w of ["baseline: 196", "MEB''e okul çağrısı", "Anıtkabir''e devlet erkânı", "e-Okul sisteminde arıza", "e-Devlet şifresi", "must not contain ''<''", "Fuzz", "explain (analyze)", "clusters_search_fold_live_idx", "clusters_search_stemfold_live_idx", "1.5", "rollback;"]) {
      expect(dry, w).toContain(w);
    }
    // the quote assertion of the spec: an input with a quote never reaches the query text unescaped
    expect(dry).toContain("e-ok''ul");
    expect(dry).toContain("''e-okul''");
  });
});

// ---------------------------------------------------------------------------
// Live block (opt-in). TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/PGDATABASE point at a THROWAWAY database that the
// dry-run script left behind with 129, 166, 172, 185, 186, 194, 196, 198 and 204 applied (tests/migrations/sql/live-manifest.txt). Every
// scenario runs inside begin ... rollback: it seeds clusters, runs 196's body (as a pg_temp function made from the text of 196's
// migration file) and the installed 204 function side by side, and checks the contracts of 204:
//   (1) a query with a single-letter compound finds exactly the clusters whose text holds the compound, and 196 did not;
//   (2) the six regression queries (f-16, s-400, iran-israil, chp-mhp, okul, devlet) and the ordinary ones keep their ids AND order;
//   (3) a negated compound, two compounds, a quote and hostile strings do not raise;
//   (4) the stem query and the folded query of every call hold no phrase operator.
// ---------------------------------------------------------------------------

interface Seed {
  key: string;
  /** clusters.title_tr: the original headline. */
  title: string;
  summary: string;
  members: number;
  age: string;
  archived?: boolean;
}

const SEEDS: Seed[] = [
  // the compounds and the clusters that only hold their two halves (MEB'e = meb + e)
  { key: "eOkul1", title: "e-Okul sisteminde arıza", summary: "Veliler girişte sorun yaşadı.", members: 3, age: "2 days" },
  { key: "meb1", title: "MEB'e okul çağrısı", summary: "Dernekler çağrı yaptı.", members: 3, age: "1 day" },
  { key: "okul1", title: "Okul servisleri denetlendi", summary: "Valilik açıkladı.", members: 2, age: "3 days" },
  { key: "okul2", title: "Okulların onarılması için ödenek ayrıldı", summary: "Bakanlık duyurdu.", members: 2, age: "4 days" },
  { key: "eDevlet1", title: "e-Devlet şifresi nasıl yenilenir", summary: "Adımlar açıklandı.", members: 3, age: "2 days" },
  { key: "eDevlet2", title: "e-Devlet'ten randevu dönemi başlıyor", summary: "Sağlık Bakanlığı duyurdu.", members: 2, age: "3 days" },
  { key: "anit", title: "Anıtkabir'e devlet erkânı çıktı", summary: "Tören yapıldı.", members: 4, age: "1 day" },
  { key: "both", title: "e-Okul ve e-Devlet girişi birleşiyor", summary: "Tek şifre dönemi.", members: 2, age: "5 days" },
  { key: "eNabiz", title: "e-Nabız uygulaması güncellendi", summary: "Yeni özellikler geldi.", members: 3, age: "2 days" },
  { key: "nabizFp", title: "Nabız ölçen saat MEB'e sunuldu", summary: "Prototip tanıtıldı.", members: 2, age: "3 days" },
  { key: "eSpor", title: "e-Spor turnuvası başladı", summary: "Finaller hafta sonu.", members: 2, age: "2 days" },
  { key: "ePosta", title: "Yeni e-posta dolandırıcılığı uyarısı", summary: "Uzmanlar uyardı.", members: 2, age: "2 days" },
  { key: "postaFp", title: "MEB'e posta ile gönderilen evrak", summary: "Okullara dağıtıldı.", members: 2, age: "3 days" },
  { key: "imza1", title: "CHP imza topladı", summary: "Kampanya sürüyor.", members: 3, age: "1 day" },
  { key: "imza2", title: "Sevr'e İmza davası", summary: "Tartışma sürüyor.", members: 2, age: "2 days" },
  { key: "eOkulArch", title: "e-Okul arşiv haberi", summary: "Arşivde.", members: 2, age: "6 days", archived: true },
  { key: "eOkulOne", title: "e-Okul tek kaynaklı haber", summary: "Tek kaynak.", members: 1, age: "6 days" },
  // the regression queries
  { key: "f16", title: "F-16 savaş uçakları teslim edildi", summary: "Anlaşma imzalandı.", members: 3, age: "1 day" },
  { key: "f16fp", title: "Okul F blok 16 öğrenci kaydı", summary: "Kayıtlar sürüyor.", members: 2, age: "2 days" },
  { key: "s400", title: "S-400 sistemi için yeni açıklama", summary: "Bakanlık konuştu.", members: 3, age: "1 day" },
  // review: s400b holds the words s and 400 in its title; s400fp is newer and holds 400 with no word that starts with s (its summary holds
  // the letter). Dropping the one-letter word from the literal tier of EVERY query lifts s400fp above s400b: 196's order must not move.
  { key: "s400b", title: "S-400 teslimatı yeniden başladı", summary: "Teslimat takvimi açıklandı.", members: 2, age: "5 days" },
  { key: "s400fp", title: "Fransa'da polis müdahalesi: 400 gözaltı", summary: "S haberi: ayrıntılar.", members: 4, age: "1 hour" },
  { key: "iranIsrail", title: "İran-İsrail gerilimi artıyor", summary: "Diplomasi trafiği sürüyor.", members: 3, age: "1 day" },
  { key: "iran1", title: "İran açıklama yaptı", summary: "Bakanlık duyurdu.", members: 2, age: "2 days" },
  { key: "chpmhp", title: "CHP-MHP görüşmesi yapıldı", summary: "Heyetler buluştu.", members: 3, age: "1 day" },
  { key: "chp1", title: "CHP toplantı yaptı", summary: "Genel merkez toplandı.", members: 2, age: "2 days" },
  // ordinary controls
  { key: "erd", title: "Erdoğan açıklama yaptı", summary: "Cumhurbaşkanı konuştu.", members: 3, age: "1 day" },
  { key: "dep", title: "Deprem sonrası yardım ulaştırıldı", summary: "Ekipler bölgede.", members: 3, age: "2 days" },
  { key: "maas", title: "Emekli maaşları için yeni formül masada", summary: "Hazırlık sürüyor.", members: 6, age: "4 days" },
  { key: "burdur", title: "Burdur'da yurt zehirlenmesi", summary: "Öğrenciler hastaneye kaldırıldı.", members: 2, age: "1 hour" },
  { key: "bursa", title: "Bursa'da deprem uyarısı", summary: "Uzmanlar uyardı.", members: 2, age: "2 hours" },
];

const seedId = (i: number): string => `00000000-0000-4000-8000-${String(204000 + i).padStart(12, "0")}`;
const KEY_BY_ID = new Map(SEEDS.map((s, i) => [seedId(i), s.key]));

const lit = (s: string | null): string => (s === null ? "null" : `'${s.replaceAll("'", "''")}'`);

interface LiveQuery {
  name: string;
  variants: string[];
  folded: string;
}

/** The arguments the app builds for a typed query (turkishQueryVariants, foldTr). */
const typed = (name: string): LiveQuery => ({ name, variants: turkishQueryVariants(name), folded: foldTr(name) });

/** The compound queries: what 204 must find, and the cluster keys that hold the compound. */
const COMPOUNDS: Array<[string, string[]]> = [
  ["e-okul", ["both", "eOkul1"]],
  ["e-okulu", ["both", "eOkul1"]],
  ["e-devlet", ["both", "eDevlet1", "eDevlet2"]],
  ["e-imza", []],
  ["e-nabız", ["eNabiz"]],
  ["e-nabiz", ["eNabiz"]],
  ["e-spor", ["eSpor"]],
  ["e-posta", ["ePosta"]],
  ["e-okul e-devlet", ["both"]],
  ["e-okul sisteminde", ["eOkul1"]],
];
/** Ids AND order must not move: the six regressions of the spec and the ordinary queries. */
const UNCHANGED = ["f-16", "s-400", "iran-israil", "chp-mhp", "okul", "devlet", "erdogan", "deprem", "emekli maasi", "burdur"];

const LIVE_QUERIES: LiveQuery[] = [
  ...[...COMPOUNDS.map(([q]) => q), ...UNCHANGED, "okul -e-okul", "e-o", "e-okul'", "'e-okul", "e-ok'ul"].map(typed),
];

describe.runIf(Boolean(process.env.TAYF_PSQL))("204 single-letter compounds against a live Postgres (129, 166, 172, 185, 186, 194, 196, 198 and 204 applied)", () => {
  assertLiveReady("204", {
    ledger: ["129", "166", "172", "185", "186", "194", "196", "198", "204"],
    relations: ["public.clusters_search_tsv_live_idx", "public.clusters_search_fold_live_idx", "public.clusters_search_stemfold_live_idx"],
    functions: ["public.search_cluster_ids(text[],text,integer)", "public.tayf_search_fold(text)", "public.tayf_search_stem_fold(tsvector)", "public.tayf_ascii_inflection_expand(tsquery)"],
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

  /** 196's function, from the text of 196's migration file, as a pg_temp function of the same shape. */
  const FN_196 =
    "create function pg_temp.f196(p_variants text[], p_folded text, p_limit integer default 12) returns table (id uuid) " +
    `language sql stable set search_path = '' as $fn$${raw196}$fn$;`;

  const rows = SEEDS.map(
    (s, i) => `(${lit(seedId(i))}, ${lit(s.title)}, null, ${lit(s.summary)}, ${s.members}, ${s.archived === true}, now() - interval '${s.age}')`,
  ).join(",\n");

  const list = (fn: string, q: LiveQuery): string =>
    `select ${lit(`${q.name}|${fn === "pg_temp.f196" ? "196" : "204"}|`)} || coalesce((select string_agg(t.id::text, ',' order by t.n) ` +
    `from ${fn}(${arr(q.variants)}, ${lit(q.folded)}, 50) with ordinality as t(id, n)), '');`;

  const script = [
    "begin;",
    FN_196,
    `insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at) values\n${rows};`,
    "analyze public.clusters;",
    ...LIVE_QUERIES.flatMap((q) => [list("pg_temp.f196", q), list("public.search_cluster_ids", q)]),
    "rollback;",
  ].join("\n");

  const ids196 = new Map<string, string[]>();
  const ids204 = new Map<string, string[]>();
  let ran = false;
  const run = (): void => {
    if (ran) return;
    ran = true;
    for (const line of runPsql(script).split("\n")) {
      if (line === "") continue;
      const [name, which, ids] = line.split("|") as [string, string, string];
      const keys = ids === "" ? [] : ids.split(",").map((id) => KEY_BY_ID.get(id) ?? `?${id}`);
      (which === "196" ? ids196 : ids204).set(name, keys);
    }
  };

  const keysOf = (m: Map<string, string[]>, name: string): string[] => {
    run();
    const v = m.get(name);
    expect(v, `no result for ${name}`).toBeDefined();
    return v as string[];
  };
  const setOf = (m: Map<string, string[]>, name: string): string[] => [...keysOf(m, name)].sort();

  it.each(COMPOUNDS)("'%s' finds exactly the clusters that hold the compound", (name, want) => {
    expect(setOf(ids204, name), name).toEqual([...want].sort());
    expect(keysOf(ids204, name).length, name).toBe(new Set(keysOf(ids204, name)).size);
  });

  it("196 did not: e-okul, e-imza, e-devlet, e-nabiz and e-posta listed clusters that only hold the halves (MEB'e, Sevr'e İmza, Anıtkabir'e devlet)", () => {
    expect(setOf(ids196, "e-okul")).toEqual(expect.arrayContaining(["meb1"]));
    expect(setOf(ids196, "e-imza")).toEqual(expect.arrayContaining(["imza2"]));
    expect(setOf(ids196, "e-devlet")).toEqual(expect.arrayContaining(["anit"]));
    expect(setOf(ids196, "e-nabiz")).toEqual(expect.arrayContaining(["nabizFp"]));
    expect(setOf(ids196, "e-posta")).toEqual(expect.arrayContaining(["postaFp"]));
  });

  it("the archived and the single-article e-Okul clusters are never returned", () => {
    for (const [name] of COMPOUNDS) expect(setOf(ids204, name), name).not.toEqual(expect.arrayContaining(["eOkulArch"]));
    for (const [name] of COMPOUNDS) expect(setOf(ids204, name), name).not.toEqual(expect.arrayContaining(["eOkulOne"]));
  });

  it.each(UNCHANGED.map((n) => [n] as [string]))("'%s' keeps exactly its ids and its order (a regression query or an ordinary one)", (name) => {
    expect(keysOf(ids204, name), name).toEqual(keysOf(ids196, name));
  });

  it("the queries of the fixtures find rows at all (the checks above are not vacuous)", () => {
    for (const name of ["f-16", "s-400", "iran-israil", "chp-mhp", "okul", "devlet", "erdogan", "deprem", "burdur"]) expect(keysOf(ids204, name).length, name).toBeGreaterThan(0);
    // F-16 keeps its false positive: no compound lexeme exists for it (the parser reads F-16 as f and -16), so cmp is null and the call is 196's
    expect(setOf(ids204, "f-16")).toEqual(expect.arrayContaining(["f16", "f16fp"]));
  });

  it("'s-400' keeps 196's id set AND its ORDER: the one-letter word s stays in the literal tier of a query with no compound lexeme", () => {
    const before = keysOf(ids196, "s-400");
    // the fixture is not vacuous: 196 lists the row with the s word above the newer row that only holds 400
    expect(before).toEqual(expect.arrayContaining(["s400", "s400b", "s400fp"]));
    expect(before.indexOf("s400b")).toBeLessThan(before.indexOf("s400fp"));
    expect(keysOf(ids204, "s-400")).toEqual(before);
  });

  it("a negated compound (okul -e-okul) answers without raising and does not list the e-Okul clusters", () => {
    const keys = setOf(ids204, "okul -e-okul");
    expect(keys).not.toEqual(expect.arrayContaining(["eOkul1"]));
    expect(keys).not.toEqual(expect.arrayContaining(["both"]));
    expect(keys).toEqual(expect.arrayContaining(["okul1", "okul2"]));
  });

  it("hostile strings around a compound answer without raising (the whole script ran)", () => {
    for (const name of ["e-o", "e-okul'", "'e-okul", "e-ok'ul"]) expect(ids204.has(name), name).toBe(true);
    expect(setOf(ids204, "e-okul'")).toEqual(setOf(ids204, "e-okul"));
    expect(setOf(ids204, "'e-okul")).toEqual(setOf(ids204, "e-okul"));
    expect(setOf(ids204, "e-o")).toEqual(setOf(ids196, "e-o"));
  });

  it("qf and qs hold no phrase operator and the compound is one quoted lexeme, for every call (a quote in the input never reaches the text unescaped)", () => {
    const out = runPsql(`
begin;
do $do$
declare
  v_src text;
  v_q text;
  r record;
begin
  select p.prosrc into v_src from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
  v_src := left(v_src, position(E'\\n  ), cand as (' in v_src) - 1) || E'\\n  ) select q.qf::text as qf, qs.qs::text as qs, q.cmp::text as cmp from q cross join qs';
  execute format('create function pg_temp.dbg(p_variants text[], p_folded text) returns table (qf text, qs text, cmp text) language sql stable set search_path = %L as %L', '', v_src);
end
$do$;
select string_agg(d.qf || ' ## ' || coalesce(d.qs, '-') || ' ## ' || coalesce(d.cmp, '-'), E'\\n' order by x.f)
  from (values ('e-okul'), ('e-okul e-devlet'), ('e-nabiz'), ('f-16'), ('okul'), ('okul -e-okul'), ('e-okul''; drop table x; --'), ('''e-okul'), ('e-ok''ul'), ('a-b-cd'), ('covid-19')) x(f)
  cross join lateral pg_temp.dbg(array[x.f], x.f) d;
rollback;
`);
    expect(out.includes("<")).toBe(false);
    const byLine = out.trim().split("\n");
    expect(byLine.length).toBeGreaterThan(5);
    const cmps = byLine.map((l) => l.split(" ## ")[2]);
    expect(cmps).toEqual(expect.arrayContaining(["'e-okul'", "'e-devlet' & 'e-okul'", "'e-nap'", "-"]));
    for (const c of cmps) expect(c === "-" || (c as string).startsWith("'"), c).toBe(true);
  });

  it("is applied once: one ledger row for 204, one three-argument overload, the body of the file, 196's attributes and grants, the helper untouched", () => {
    const out = runPsql(`
select (select count(*) from supabase_migrations.schema_migrations where version = '204'),
       (select count(*) from pg_catalog.pg_proc where proname = 'search_cluster_ids' and pronamespace = 'public'::regnamespace and pg_get_function_identity_arguments(oid) = 'p_variants text[], p_folded text, p_limit integer'),
       p.prosecdef, p.provolatile, (p.proconfig = array['search_path=""']), p.proacl::text, md5(p.prosrc), length(p.prosrc),
       has_function_privilege('anon', p.oid, 'execute'), has_function_privilege('authenticated', p.oid, 'execute'),
       has_function_privilege('service_role', p.oid, 'execute'),
       obj_description(p.oid, 'pg_proc') like '%204%'
  from pg_catalog.pg_proc p
 where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
select md5(h.prosrc), length(h.prosrc), h.provolatile, h.proparallel
  from pg_catalog.pg_proc h
 where h.oid = 'public.tayf_ascii_inflection_expand(tsquery)'::regprocedure;
`).trim();
    const [fnLine, helperLine] = out.split("\n") as [string, string];
    const f = fnLine.split("|");
    expect(f[0]).toBe("1"); // ledger rows for 204
    expect(f[1]).toBe("1"); // one three-argument overload
    expect(f[2]).toBe("t"); // security definer
    expect(f[3]).toBe("s"); // stable
    expect(f[4]).toBe("t"); // search_path = ''
    expect(f[5]).toBe(PROD_PROACL);
    expect(f[6]).toBe(md5(raw204)); // the function in the database is the body of the file
    expect(f[7]).toBe(String(pgLength(raw204)));
    expect(f[8]).toBe("f"); // anon
    expect(f[9]).toBe("f"); // authenticated
    expect(f[10]).toBe("t"); // service_role
    expect(f[11]).toBe("t"); // the comment names 204
    expect(helperLine.split("|")).toEqual([HELPER_MD5, String(HELPER_LENGTH), "i", "s"]);
  });
});
