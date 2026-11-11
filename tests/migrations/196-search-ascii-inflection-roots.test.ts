import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { foldTr, turkishQueryVariants } from "@/lib/clusters/turkish-query";
import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Contract test for migration 196 ("ASCII inflection roots in the stem-fold arm"), h124-postship-1 (hunt 125). 191 is reserved (not
// applied), 192 to 195 are applied; this file takes the next free number.
//
// 186's stem-fold arm matches the stored stems folded to ASCII with the stem of the ASCII-folded query, and that stem comes from the
// Turkish stemmer, which cannot strip a suffix from an ASCII word: ts_lexize('turkish_stem') leaves maasi, siginagi, cocugu, guvenligi
// and maaslari whole while the Turkish spellings stem to maaş, sığınak, çocuk, güvenlik. On production (2026-11-11) the ASCII
// spelling of such a word shared 8 to 17 of the 24 slots of its Turkish spelling, and siginagi returned 8 rows against 15.
//
// 196 adds a helper, public.tayf_ascii_inflection_expand(tsquery), that ORs each [a-z] lexeme with the closed suffix-strip roots its
// ending can only mean, and replaces public.search_cluster_ids(text[], text, integer) with 194's body except ONE CTE (qs). This file
// pins, without a database: the file, ledger and transaction, that 194's body is the base (md5 pinned), the helper (attributes, rules,
// constants only), a derive-and-compare of 196's body against 194's (only the qs CTE differs), the header, the docs section, the dry-run
// and the live-manifest entry. The opt-in live block (TAYF_PSQL) runs 194's body and 196's function side by side on fixtures inside a
// rolled-back transaction, and pins the helper's output text.
//
// No regular expression is applied to quoted SQL literals in this file (CodeQL js/redos): the SQL is scanned with indexOf and
// character loops.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const FILE_196 = "196_search_ascii_inflection_roots.sql";
const MIGRATION_196 = resolve(MIGRATIONS_DIR, FILE_196);
const MIGRATION_194 = resolve(MIGRATIONS_DIR, "194_search_rank_display_title.sql");
const DRYRUN_196 = resolve(ROOT, "tests", "migrations", "sql", "196-search-ascii-inflection-roots-dryrun.sql");
const MANIFEST = resolve(ROOT, "tests", "migrations", "sql", "live-manifest.txt");
const DOC_MIGRATION_GUIDE = resolve(ROOT, "docs", "migration-guide.md");

/** md5 and length of 194's function body: the base of 196, and what production runs (read-only, 2026-11-11). */
const BASE_MD5 = "53eddcee85dc444ef0e24ad7087f5b00";
const BASE_LENGTH = 18894;
const PROD_PROACL = "{postgres=X/postgres,service_role=X/postgres}";

const LEDGER_STMT =
  "insert into supabase_migrations.schema_migrations (version, name) values ('196', '196_search_ascii_inflection_roots') on conflict do nothing;";
const REVOKE_FN = "revoke all on function public.search_cluster_ids(text[], text, integer) from public, anon, authenticated;";
const GRANT_FN = "grant execute on function public.search_cluster_ids(text[], text, integer) to service_role;";
const REVOKE_HELPER = "revoke all on function public.tayf_ascii_inflection_expand(tsquery) from public, anon, authenticated;";
const GRANT_HELPER = "grant execute on function public.tayf_ascii_inflection_expand(tsquery) to service_role;";

const HELPER_HEADER =
  "create or replace function public.tayf_ascii_inflection_expand(p tsquery) returns tsquery language plpgsql immutable strict parallel safe set search_path = ''";

/** 194's qs CTE and 196's, comments stripped, between q and cand: the only text that differs. */
const OLD_QS =
  "), qs as ( select case when pg_catalog.numnode(q.qf) = 0 then null else pg_catalog.to_tsquery('pg_catalog.simple'::pg_catalog.regconfig, public.tayf_search_fold(q.qf::pg_catalog.text)) end as qs from q ), cand as (";
const NEW_QS =
  "), qs as ( select case when pg_catalog.numnode(q.qf) = 0 then null else public.tayf_ascii_inflection_expand(pg_catalog.to_tsquery('pg_catalog.simple'::pg_catalog.regconfig, public.tayf_search_fold(q.qf::pg_catalog.text))) end as qs from q ), cand as (";

/** The three rules of the helper, as the constant patterns the body must hold. */
const R1 = "'^[a-z]{3,}[b-df-hj-np-tv-z][iu]$'";
const R2 = "'^[a-z]{2,}[aeiou]s[iu]$'";
const R3A = "'^[a-z]{3,}l[ae]r[iu]$'";
const R3B = "'^[a-z]{3,}l[ae]r[iu]n$'";

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

/** The right operand of every ` ~ ` in the SQL (comments stripped): the pattern, which must start with a quote. */
function tildeOperands(sql: string): Array<{ left: string; right: string }> {
  const out: Array<{ left: string; right: string }> = [];
  let from = 0;
  for (;;) {
    const at = sql.indexOf(" ~ ", from);
    if (at < 0) return out;
    from = at + 3;
    let l = at;
    while (l > 0 && isIdentChar(sql[l - 1])) l--;
    out.push({ left: sql.slice(l, at), right: sql.slice(at + 3, at + 3 + 40) });
  }
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
let fn196 = "";
let cb196 = "";
let helperRaw = "";
let helperCode = "";
/** The body as the database stores it (prosrc): comments included. */
let raw196 = "";

if (existsSync(MIGRATION_196)) {
  sql = readFileSync(MIGRATION_196, "utf8");
  code = stripComments(sql);
  head = sql.slice(0, sql.indexOf("\nbegin;"));
  fn196 = functionBlock(code, "search_cluster_ids");
  cb196 = collapse(fnBody(fn196));
  raw196 = fnBody(functionBlock(sql, "search_cluster_ids"));
  helperRaw = fnBody(functionBlock(sql, "tayf_ascii_inflection_expand"));
  helperCode = collapse(fnBody(functionBlock(code, "tayf_ascii_inflection_expand")));
}
const sql194 = readFileSync(MIGRATION_194, "utf8");
const fn194 = functionBlock(stripComments(sql194), "search_cluster_ids");
const cb194 = collapse(fnBody(fn194));
const raw194 = fnBody(functionBlock(sql194, "search_cluster_ids"));

describe("196 file, ledger and structure", () => {
  it("exists with the exact name, and no other migration claims the number 196", () => {
    expect(existsSync(MIGRATION_196)).toBe(true);
    const claimed = readdirSync(MIGRATIONS_DIR).filter((n) => n.startsWith("196_"));
    expect(claimed).toEqual([FILE_196]);
  });

  it("contains the ledger insert for '196' with on conflict do nothing, the last statement before commit", () => {
    const c = collapse(code);
    expect(c).toContain(LEDGER_STMT);
    expect(c.endsWith(`${LEDGER_STMT} commit;`)).toBe(true);
  });

  it("is wrapped in a single begin/commit and sets lock_timeout 5s first, the helper before the function that reads it", () => {
    const c = collapse(code);
    expect(countOf(c, "begin;")).toBe(1);
    expect(countOf(c, "commit;")).toBe(1);
    expect(c.startsWith("begin; set local lock_timeout = '5s'; create or replace function public.tayf_ascii_inflection_expand(")).toBe(true);
    expect(c.endsWith("commit;")).toBe(true);
    expect(c.indexOf("create or replace function public.tayf_ascii_inflection_expand(")).toBeLessThan(c.indexOf("create or replace function public.search_cluster_ids("));
  });

  it("is additive only: two function replaces, two comments, the ledger row; no drop, alter, truncate, update, delete, table, index or trigger", () => {
    const bare = sansStrings(code).toLowerCase();
    for (const bad of ["drop ", "alter ", "truncate", "delete ", "update ", "create table", "create unique", "create index", "create trigger", "create view", "create extension", "create function"]) {
      expect(bare.includes(bad), bad).toBe(false);
    }
    expect(countOf(bare, "create or replace function")).toBe(2);
    expect(countOf(bare, "insert into ")).toBe(1);
    expect(countOf(bare, "comment on ")).toBe(2);
    expect(bare).toContain("insert into supabase_migrations.schema_migrations");
  });

  it("grants no table, sequence or schema privilege, and exactly one function grant per function, to service_role, each after its revoke", () => {
    const bare = sansStrings(code).toLowerCase();
    expect(bare).not.toContain("on table");
    expect(bare).not.toContain("on all tables");
    expect(bare).not.toContain("on sequence");
    expect(bare).not.toContain("on schema");
    const c = collapse(code);
    expect(countOf(c, "grant ")).toBe(2);
    expect(countOf(c, "revoke ")).toBe(2);
    for (const [revoke, grant] of [
      [REVOKE_HELPER, GRANT_HELPER],
      [REVOKE_FN, GRANT_FN],
    ] as const) {
      expect(c).toContain(revoke);
      expect(c).toContain(grant);
      expect(c.indexOf(revoke)).toBeLessThan(c.indexOf(grant));
    }
  });

  it("reloads the PostgREST schema cache, after both functions and before the ledger insert", () => {
    const c = collapse(code);
    expect(c).toContain("notify pgrst, 'reload schema';");
    expect(c.indexOf("notify pgrst")).toBeLessThan(c.indexOf("insert into supabase_migrations"));
    expect(c.indexOf("notify pgrst")).toBeGreaterThan(c.indexOf(GRANT_FN));
  });

  it("single-quote characters balance once comments are stripped (no string literal holds two dashes)", () => {
    expect(countOf(code, "'") % 2).toBe(0);
  });

  it("does not claim the reserved number 191, and names the migrations it builds on", () => {
    expect(head).toContain("191");
    expect(existsSync(resolve(MIGRATIONS_DIR, "191_trends_entity_rollup_minister_forms.sql"))).toBe(true);
    expect(readdirSync(MIGRATIONS_DIR).filter((n) => n.startsWith("191_"))).toEqual(["191_trends_entity_rollup_minister_forms.sql"]);
    for (const n of ["194", "186", "129", "083", "PGRST202"]) expect(head, n).toContain(n);
  });
});

describe("196 helper public.tayf_ascii_inflection_expand(tsquery)", () => {
  const helperBlockCode = (): string => functionBlock(code, "tayf_ascii_inflection_expand");

  it("is plpgsql, IMMUTABLE, STRICT, PARALLEL SAFE, search_path '' and not security definer", () => {
    expect(collapse(fnHeader(helperBlockCode()))).toBe(HELPER_HEADER);
    expect(collapse(fnHeader(helperBlockCode()))).not.toContain("security definer");
    expect(countOf(code, "create or replace function public.tayf_ascii_inflection_expand(")).toBe(1);
  });

  it("holds the three closed rules as constant patterns, the 4-letter floor, and the soft-letter hardening g -> k, b -> p, d -> t", () => {
    for (const p of [R1, R2, R3A, R3B]) expect(helperCode, p).toContain(`v_lex ~ ${p} then`);
    expect(helperCode).toContain("pg_catalog.left(v_lex, -1)");
    expect(helperCode).toContain("pg_catalog.left(v_lex, -2)");
    expect(helperCode).toContain("pg_catalog.left(v_lex, -4)");
    expect(helperCode).toContain("pg_catalog.left(v_lex, -5)");
    expect(helperCode).toContain("when 'g' then 'k' when 'b' then 'p' when 'd' then 't'");
    expect(helperCode).toContain("pg_catalog.length(v_root) >= 4 and v_root <> v_lex");
    expect(helperCode).toContain("not (v_root = any (v_keep))");
  });

  it("R1 skips a root that ends in a doubled consonant (and its softened copy), and a closed deny set keeps the roots that are the stem of another word out", () => {
    // geminate: zamm, hakk, hiss, hatt, sirr, redd (the GEMINATE_ROOTS of src/lib/clusters/turkish-query.ts); the stemmer leaves zammi, hakki, hissi whole
    expect(helperCode).toContain("v_root := pg_catalog.left(v_lex, -1); if pg_catalog.right(v_root, 1) <> pg_catalog.substr(v_root, pg_catalog.length(v_root) - 1, 1) then v_roots := v_roots || v_root;");
    // the deny set: a literal, closed list in the keep loop (ilisk is the stem of ilişkin, turk of türk, sevk of sevk), mirroring NO_SIBLING_TERMS
    expect(helperCode).toContain("and not (v_root = any (array['ilisk', 'turk', 'sevk']::pg_catalog.text[]))");
    const keepAt = helperCode.indexOf("foreach v_root in array v_roots loop");
    expect(keepAt).toBeGreaterThan(-1);
    expect(helperCode.indexOf("array['ilisk', 'turk', 'sevk']")).toBeGreaterThan(keepAt);
    expect(countOf(helperCode, "array['")).toBe(1);
  });

  it("returns the argument unchanged, before the loop, when the query text holds two adjacent quotes (a lexeme with an apostrophe inside it: a.com/x'maasi)", () => {
    const guard = "if pg_catalog.strpos(v_txt, v_q || v_q) > 0 then return p; end if;";
    expect(countOf(helperCode, guard)).toBe(1);
    expect(helperCode.indexOf(guard)).toBeGreaterThan(helperCode.indexOf("begin"));
    expect(helperCode.indexOf(guard)).toBeLessThan(helperCode.indexOf("for v_lex in"));
    // no EXCEPTION block: it would make the function PARALLEL UNSAFE and break the pinned proparallel 's'
    expect(helperCode.toLowerCase()).not.toContain("exception");
    expect(helperCode.toLowerCase()).not.toContain("ts_rewrite");
    // the comment says why (the pattern could match inside an escaped lexeme and the rewritten text would not parse)
    expect(helperRaw).toContain("two adjacent quotes");
  });

  it("visits the lexemes in sorted order, replaces the exact quoted token, returns p when nothing has a root, and reads the text back as a simple query", () => {
    expect(helperCode).toContain("select distinct x.m[1] from pg_catalog.regexp_matches(v_txt, '''([a-z]+)''', 'g') as x(m) order by 1");
    expect(helperCode).toContain("pg_catalog.replace( v_out, v_q || v_lex || v_q,");
    expect(helperCode).toContain("if not v_any then return p; end if;");
    expect(helperCode).toContain("return pg_catalog.to_tsquery('pg_catalog.simple'::pg_catalog.regconfig, v_out);");
    expect(helperCode).toContain("v_q pg_catalog.text := pg_catalog.chr(39);");
    // a lexeme that carries a suffix marker (':*', a weight) is left whole: a group cannot take one
    expect(helperCode).toContain("continue when pg_catalog.strpos(v_txt, v_q || v_lex || v_q || ':') > 0;");
  });

  it("puts no user text inside a regex pattern and builds no dynamic SQL: every pattern is a quoted constant, the lexeme is only the subject", () => {
    const patterns = regexPatterns(helperCode);
    expect(patterns).toEqual(["'''([a-z]+)'''"]);
    const tildes = tildeOperands(helperCode);
    expect(tildes.map((t) => t.left)).toEqual(["v_lex", "v_lex", "v_lex", "v_lex"]);
    for (const t of tildes) expect(t.right.startsWith("'"), t.right).toBe(true);
    for (const bad of ["execute", "format(", "quote_literal", "quote_ident", "similar to", " like ", "p_variants", "p_folded"]) {
      expect(helperCode.toLowerCase().includes(bad), bad).toBe(false);
    }
  });

  it("every catalog function it calls is schema-qualified (empty search_path), every cast names pg_catalog", () => {
    const bare = sansStrings(helperCode);
    const catalog = ["regexp_matches", "strpos", "left", "right", "substr", "length", "cardinality", "replace", "string_agg", "unnest", "chr", "to_tsquery"];
    for (const name of catalog) {
      let from = 0;
      let seen = 0;
      for (;;) {
        const at = bare.indexOf(`${name}(`, from);
        if (at < 0) break;
        from = at + name.length;
        if (isIdentChar(bare[at - 1]) && bare.slice(at - 11, at) !== "pg_catalog.") continue;
        seen++;
        expect(at, `${name}( at ${at}`).toBeGreaterThanOrEqual(11);
        expect(bare.slice(at - 11, at), `${name}( at ${at}`).toBe("pg_catalog.");
      }
      expect(seen, `${name} is called`).toBeGreaterThan(0);
    }
    let from = 0;
    for (;;) {
      const at = bare.indexOf("::", from);
      if (at < 0) break;
      from = at + 2;
      const rest = bare.slice(at + 2);
      expect(rest.startsWith("pg_catalog.") || rest.startsWith("''"), bare.slice(at, at + 24)).toBe(true);
    }
  });

  it("has a function comment that names 196, the three rules, the ASCII stemmer limit and service_role", () => {
    const c = collapse(code);
    const at = c.indexOf("comment on function public.tayf_ascii_inflection_expand(tsquery) is");
    expect(at).toBeGreaterThan(-1);
    const comment = c.slice(at, c.indexOf("revoke all", at));
    for (const word of ["196", "R1", "R2", "R3", "4 letters", "k, p or t", "maasi", "siginag", "maaslari", "maas", "Turkish stemmer", "186", "unchanged", "IMMUTABLE", "STRICT", "service_role only"]) {
      expect(comment, word).toContain(word);
    }
  });
});

describe("196 search_cluster_ids(text[], text, integer)", () => {
  it("is the only definition of it and has 194's signature: create or replace, no drop, no new overload", () => {
    expect(fn196.startsWith("create or replace function public.search_cluster_ids(p_variants text[], p_folded text, p_limit integer default 12)")).toBe(true);
    expect(countOf(code, "create or replace function public.search_cluster_ids(")).toBe(1);
  });

  it("has exactly 194's header: returns table (id uuid), language sql, stable, security definer, search_path ''", () => {
    expect(collapse(fnHeader(fn196))).toBe(collapse(fnHeader(fn194)));
    const h = collapse(fnHeader(fn196));
    expect(h).toContain("returns table (id uuid)");
    expect(h).toContain("language sql");
    expect(h).toContain("stable");
    expect(h).toContain("security definer");
    expect(h).toContain("set search_path = ''");
  });

  it("has a function comment that names the ASCII roots and the migrations it builds on", () => {
    const c = collapse(code);
    const at = c.indexOf("comment on function public.search_cluster_ids(text[], text, integer) is");
    expect(at).toBeGreaterThan(-1);
    const comment = c.slice(at, c.indexOf("revoke all", at)).toLowerCase();
    for (const word of ["196", "194", "186", "185", "172", "166", "129", "display title", "three separate index scans", "p_folded", "recall", "14-day", "tayf_ascii_inflection_expand", "maasi -> maas", "siginag and siginak", "ascii inflection roots"]) {
      expect(comment, word).toContain(word);
    }
  });

  it("touches only the three-argument function: 083's two-argument overload (the PGRST202 fallback) is not defined, replaced or granted", () => {
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
    expect(head).toContain("083");
    expect(head).toContain("PGRST202");
  });

  it("every catalog function the body calls is schema-qualified (empty search_path), every cast names pg_catalog, and the helper is public.-qualified", () => {
    const bare = sansStrings(cb196);
    const catalog = [
      "left", "length", "strpos", "lower", "translate", "replace", "chr", "regexp_replace", "regexp_split_to_table", "substr",
      "ts_lexize", "ts_rank_cd", "to_tsvector", "websearch_to_tsquery", "plainto_tsquery", "to_tsquery", "numnode", "now", "btrim", "ln",
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
    expect(countOf(cb196, "tayf_ascii_inflection_expand(")).toBe(1);
    expect(countOf(cb196, "public.tayf_ascii_inflection_expand(")).toBe(1);
  });
});

describe("196 body = 194's body with the qs CTE changed, nothing else", () => {
  it("194's body is the base: its md5 and length are the recorded ones, and production runs it (read-only, 2026-11-11)", () => {
    expect(md5(raw194)).toBe(BASE_MD5);
    expect(pgLength(raw194)).toBe(BASE_LENGTH);
    const at = head.indexOf("\n-- BASE");
    expect(at).toBeGreaterThan(-1);
    const base = head.slice(at, head.indexOf("\n-- STEP 0", at));
    for (const word of [BASE_MD5, String(BASE_LENGTH), "production"]) expect(base, word).toContain(word);
  });

  it("everything before the qs CTE and everything from cand on is 194's text byte for byte, comments included", () => {
    const qsAt196 = raw196.indexOf("  ), qs as (\n");
    const qsAt194 = raw194.indexOf("  ), qs as (\n");
    const candAt196 = raw196.indexOf("  ), cand as (\n");
    const candAt194 = raw194.indexOf("  ), cand as (\n");
    expect(qsAt196).toBeGreaterThan(5000);
    expect(raw196.slice(0, qsAt196)).toBe(raw194.slice(0, qsAt194));
    expect(raw196.slice(candAt196)).toBe(raw194.slice(candAt194));
    expect(raw196.slice(candAt196).length).toBeGreaterThan(8000);
    expect(qsAt196).toBeLessThan(candAt196);
  });

  it("the qs CTE is exactly this statement (comments stripped): the else branch is the helper applied to 194's query", () => {
    expect(cb196).toContain(NEW_QS);
    expect(cb194).toContain(OLD_QS);
    expect(cb196).not.toContain(OLD_QS);
    expect(countOf(cb196, "), qs as (")).toBe(1);
    expect(cb196.indexOf("), q as (")).toBeLessThan(cb196.indexOf("), qs as ("));
    expect(cb196.indexOf("), qs as (")).toBeLessThan(cb196.indexOf("), cand as ("));
    // the whole 196 body is 194's with that one statement swapped
    expect(cb196.replace(NEW_QS, OLD_QS)).toBe(cb194);
  });

  it("derive-and-compare: exactly one CTE differs (qs), the other CTEs and the final select are 194's, in the same order", () => {
    const a = splitCtes(raw194);
    const b = splitCtes(raw196);
    expect(b.map(([n]) => n)).toEqual(a.map(([n]) => n));
    expect(a.map(([n]) => n)).toEqual(["f0", "g0", "gx", "g", "ge", "f", "q", "qs", "cand", "kept", "top", "lw", "hits", "<final select>"]);
    const differing = b.filter(([, t], i) => t !== (a[i] as [string, string])[1]).map(([n]) => n);
    expect(differing).toEqual(["qs"]);
  });

  it("the third arm of cand is still a literal copy of the stem-fold index predicate and reads qs; the ORDER BY reads q.qf, not qs", () => {
    expect(cb196).toContain("union select c.id, c.updated_at from public.clusters c where public.tayf_search_stem_fold(c.search_tsv) @@ (select qs from qs) and not c.is_archived and c.article_count >= 2 ), kept as (");
    const tail = cb196.slice(cb196.indexOf("select h.id from hits h cross join q"));
    expect(tail).not.toContain("qs");
    expect(tail).toContain("q.qf");
    expect(cb196.endsWith("limit greatest(1, least(coalesce(p_limit, 12), 50));")).toBe(true);
    expect(cb196).toContain("select k.id from kept k order by k.updated_at desc, k.id limit 1000");
  });

  it("adds no regex to the body: the patterns are 194's, p_variants, p_folded and p_limit are read exactly where they were", () => {
    expect([...regexPatterns(cb196)].sort()).toEqual([...regexPatterns(cb194)].sort());
    expect(regexPatterns(cb196).length).toBeGreaterThan(8);
    for (const p of regexPatterns(cb196)) {
      expect(p.startsWith("'") && p.endsWith("'"), p).toBe(true);
      expect(p.includes("||"), p).toBe(false);
    }
    expect(countOf(cb196, "p_variants")).toBe(countOf(cb194, "p_variants"));
    expect(countOf(cb196, "p_folded")).toBe(countOf(cb194, "p_folded"));
    expect(countOf(cb196, "p_limit")).toBe(countOf(cb194, "p_limit"));
  });
});

describe("196 header", () => {
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
    expect(head).toContain("h124-postship-1");
    expect(head).toContain("191");
  });

  it("records the md5 and length of the NEW body and of the helper, and they match this file (the test recomputes them)", () => {
    const newMd5 = md5(raw196);
    expect(newMd5).not.toBe(BASE_MD5);
    const verify = section("VERIFY", "Safe to re-apply");
    expect(verify).toContain(`expect ${newMd5}, ${pgLength(raw196)}.`);
    expect(verify).toContain(`expect ${md5(helperRaw)}, ${pgLength(helperRaw)}, i, s, true, false, false, false, true, ${PROD_PROACL}.`);
  });

  it("WHY names the live evidence: the stemmer cannot strip an ASCII suffix, the five words, the overlap and the read-only feasibility", () => {
    const why = prose(section("WHY", "WHAT"));
    for (const word of ["ts_lexize('turkish_stem')", "maasi", "siginagi", "cocugu", "guvenligi", "maaslari", "maaş", "sığınak", "çocuk", "güvenlik", "emekli maasi 15 of 24", "siginagi returned 8 rows against 15", "186", "h96-search-2"]) {
      expect(why, word).toContain(word);
    }
  });

  it("WHAT names the three rules, the 4-letter floor, the soft-letter hardening, the pinned output, the suffix marker and that the roots only add", () => {
    const what = prose(section("WHAT", "BASE"));
    for (const word of [
      "IMMUTABLE, STRICT, PARALLEL SAFE", "R1", "R2", "R3", "at least 4 letters long", "softened to k, p or t", "kitabi -> kitab and kitap",
      "emekli & maasi gives ( 'emekli' | 'emekl' ) & ( 'maasi' | 'maas' )", "'siginagi' | 'siginag' | 'siginak'", "'maaslari' | 'maaslar' | 'maas'", "'kar' is shorter than 4",
      "maasi:*", "sorted order", "ONE CTE", "qs", "reads q.qf, not qs", "no row of the other two arms leaves",
      // the review fixes: the geminate skip, the closed deny set, the doubled-quote guard
      "doubled consonant", "zamm, hakk, hiss, hatt, sirr and redd", "GEMINATE_ROOTS", "closed deny set", "ilisk, turk and sevk", "sevgi gives 'sevgi' | 'sevg'",
      "two adjacent quotes", "42601", "no EXCEPTION block", "PARALLEL UNSAFE", "ts_rewrite", "a.com/x'maasi",
    ]) {
      expect(what, word).toContain(word);
    }
  });

  it("BASE records 194's fingerprint and that production runs it; STEP 0 records the prod md5 of the helpers it reads", () => {
    const base = section("BASE", "STEP 0");
    for (const word of [BASE_MD5, String(BASE_LENGTH), PROD_PROACL, "production"]) expect(base, word).toContain(word);
    const step0 = section("STEP 0", "REPLAY");
    for (const word of [BASE_MD5, "18894", "709be5df31d85ac692729f673e7e7900", "77a0656fab6d06f5fb86f75afdfb6391", "aabf54347c8f929090419335d5d48f19"]) expect(step0, word).toContain(word);
  });

  it("REPLAY holds the measured rows: candidates, page overlap, ages, the controls and the two limits found (the akp cap, the zamm row)", () => {
    const replay = prose(section("REPLAY", "COST"));
    for (const word of [
      "emekli maasi 40 -> 89", "siginagi 8 -> 15", "maaslari 24 -> 157", "cocugu 161 -> 894", "guvenligi 480 -> 1000", "secim sonuclari 97 -> 264", "15 -> 24", "17 -> 24",
      "0 rows older than 60 days", "23.0 days", "198.2 days", "EQUALS", "no Turkish spelling loses an id", "Controls", "deprem 438", "burdur 34", "miller 18",
      "2 ids change at the 1000-row cap", "'parti' has the root 'part'", "guvenligi loses 166", "asgari ucret zammi 0 -> 7 rows", "dogal gaz zammi 0 -> 4 rows",
      // the review fixes: hakkı, umut hakkı, ilişki, elektrik zammı keep 194's id sets and page order; the zamm story is not returned any more; the quote query
      "hakkı and hakki 197 -> 197", "umut hakkı and umut hakki 5 -> 5", "ilişki and iliski 566 -> 566", "sevgi 49 -> 49", "id set AND its page order", "1,996 candidates",
      "elektrik zammı, elektrik zammi, dogal gaz zammi, doğal gaz zammı and asgari ucret zammi is 0 -> 0", "elektrik zammı 9 rows", "a.com/x'maasi and x.com/a'kitabi", "42601",
    ]) {
      expect(replay, word).toContain(word);
    }
  });

  it("COST says what the measurement is, that the helper is free, and what grows (the scored rows), with the equal-recall comparison", () => {
    const cost = prose(section("COST", "KNOWN LIMITS"));
    for (const word of ["EXPLAIN (ANALYZE)", "same arguments", "InitPlan", "microseconds", "clusters_search_stemfold_live_idx", "scored", "1000", "guvenligi", "196 on the ASCII spelling", "194 on its Turkish spelling"]) {
      expect(cost, word).toContain(word);
    }
  });

  it("KNOWN LIMITS says the list is closed, that Turkish spellings widen too, the junk roots, the negation and the cost in proportion", () => {
    const limits = prose(section("KNOWN LIMITS", "LEDGER"));
    for (const word of [
      "closed on purpose", "never used", "a Turkish spelling widens too", "parti has the root 'part'", "junk", "A negated word excludes its roots too", "in proportion", "parity property",
      // the review fixes: the geminate skip and the deny set replace the old 'zamm row' paragraph
      "the geminate skip", "closed deny set", "ilisk, turk, sevk", "hakki 197 against hakk 1,828", "iliski 566 against ilisk 3,734", "turku 21 against turk 1,349", "sevgi 49 against sevk 452",
      "sonuclari, which must expand, has 20 stored rows and turku 21", "The root sevg of sevgi stays",
    ]) {
      expect(limits, word).toContain(word);
    }
    // the old paragraph (the one 'zamm' story returned by every zammı query, the decision left open) is gone
    expect(limits).not.toContain("is left to a decision");
    expect(limits).not.toContain("would drop it");
  });

  it("ROLLBACK: 194's function statement and comment again, then the helper, the ledger row, in that order", () => {
    const r = section("ROLLBACK", "See tests/");
    expect(r).toContain("194_search_rank_display_title.sql");
    expect(r).toContain(BASE_MD5);
    expect(r).toContain("drop function if exists public.tayf_ascii_inflection_expand(tsquery);");
    expect(r).toContain("delete from supabase_migrations.schema_migrations where version = '196';");
    expect(r).toContain("notify pgrst, 'reload schema';");
    expect(r.indexOf("drop function")).toBeLessThan(r.indexOf("delete from supabase_migrations"));
    expect(r).toContain("the helper goes after the function that calls it");
  });
});

describe("196 docs/migration-guide.md", () => {
  const guide = readFileSync(DOC_MIGRATION_GUIDE, "utf8");
  const sec = sectionOf(guide, "196");

  it("has a 196 section, after section 195", () => {
    expect(sec).not.toBe("");
    expect(sectionOf(guide, "195")).not.toBe("");
    expect(guide.indexOf("\n## 196 ")).toBeGreaterThan(guide.indexOf("\n## 195 "));
    expect(sec.split("\n")[1]).toContain("APPLY 196");
  });

  it("has Why, What, an md5 table, Replay, Cost, Order, Verify and Rollback", () => {
    for (const label of ["**Why:**", "**What 196 does**", "| | md5(prosrc) | length |", "**Replay**", "**Cost**", "**Order:**", "**Verify**", "**Rollback:**"]) {
      expect(sec, label).toContain(label);
    }
  });

  it("records the md5 of 194's body (production's, the base), of 196 and of the helper, matching the file", () => {
    expect(sec).toContain(`\`${BASE_MD5}\` | ${BASE_LENGTH}`);
    expect(sec).toContain(`\`${md5(raw196)}\` | ${pgLength(raw196)}`);
    expect(sec).toContain(`\`${md5(helperRaw)}\` | ${pgLength(helperRaw)}`);
  });

  it("states the order: 194 is applied, 196 needs no deploy order and is independent of the app commit; 191 is not a prerequisite", () => {
    const s = sec.slice(sec.indexOf("**Order:**"), sec.indexOf("**Verify**"));
    for (const word of ["196_search_ascii_inflection_roots.sql", "no deploy order", "191", "194", "sibling call"]) expect(s, word).toContain(word);
  });

  it("verifies the fingerprints, the privileges, the ledger row, the helper output and the live queries; the rollback restores 194", () => {
    const v = sec.slice(sec.indexOf("**Verify**"), sec.indexOf("**Rollback:**"));
    for (const word of [md5(raw196), md5(helperRaw), "has_function_privilege", "version = '196'", "( 'emekli' | 'emekl' ) & ( 'maasi' | 'maas' )", "/?q=emekli%20maasi", "/?q=siginagi", "/?q=maaslari"]) {
      expect(v, word).toContain(word);
    }
    const r = sec.slice(sec.indexOf("**Rollback:**"));
    for (const word of ["194_search_rank_display_title.sql", BASE_MD5, "drop function if exists public.tayf_ascii_inflection_expand(tsquery)", "delete from supabase_migrations.schema_migrations where version = '196'"]) {
      expect(r, word).toContain(word);
    }
  });

  it("says what grows (the scored rows), that the helper is free, and the akp cap and zamm findings", () => {
    const cost = sec.slice(sec.indexOf("**Cost**"), sec.indexOf("**Order:**"));
    for (const word of ["scored", "guvenligi", "same candidates", "InitPlan"]) expect(cost, word).toContain(word);
    const replay = sec.slice(sec.indexOf("**Replay**"), sec.indexOf("**Cost**"));
    for (const word of ["emekli maasi", "40 -> 89", "siginagi", "8 -> 15", "akp", "hakkı", "umut hakkı", "ilişki", "elektrik zammı", "0 -> 0", "page order", "42601"]) expect(replay, word).toContain(word);
    // the old zamm finding (the typed call of every zammı query gains one story) is gone
    expect(replay).not.toContain("returned by the typed call of every");
    expect(replay).not.toContain("so it leads the page");
  });

  it("What 196 does names the geminate skip, the closed deny set and the doubled-quote guard, and the pins of the new cases", () => {
    const what = sec.slice(sec.indexOf("**What 196 does**"), sec.indexOf("| | md5(prosrc) | length |"));
    for (const word of [
      "doubled consonant", "`zamm`, `hakk`, `hiss`, `hatt`, `sirr`, `redd`", "closed deny set", "`ilisk`", "`turk`", "`sevk`", "`sevg`", "two adjacent quotes", "`a.com/x'maasi`", "42601",
      "`sevgi` gives `'sevgi' | 'sevg'`", "`zammi`, `hakki`, `hissi`, `hatti`, `iliski`, `turku`",
    ]) {
      expect(what, word).toContain(word);
    }
  });

  it("uses no fenced sql block (tests/guards/docs-sql-snippets.test.ts scans those)", () => {
    expect(sec).not.toContain("```");
  });
});

describe("196 dry-run and live manifest", () => {
  const dry = existsSync(DRYRUN_196) ? readFileSync(DRYRUN_196, "utf8") : "";

  it("builds 196's database with its own dry-run script: one run entry, that script as the only setup file", () => {
    const lines = readFileSync(MANIFEST, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("run | 196-search-ascii-inflection-roots.test.ts"));
    expect(lines).toEqual(["run | 196-search-ascii-inflection-roots.test.ts | tests/migrations/sql/196-search-ascii-inflection-roots-dryrun.sql | - | 0"]);
  });

  it("the dry-run builds 194's state (the 129 setup, 166, 172, 185, 186, 194, gated on 194's md5), applies 196 twice and ends with its OK line", () => {
    expect(existsSync(DRYRUN_196)).toBe(true);
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
      "../../../supabase/migrations/196_search_ascii_inflection_roots.sql",
    ]);
    expect(dry).toContain(BASE_MD5);
    expect(dry).toContain(String(BASE_LENGTH));
    expect(dry).toContain(md5(raw196));
    expect(dry).toContain(String(pgLength(raw196)));
    expect(dry).toContain(md5(helperRaw));
    expect(dry).toContain(String(pgLength(helperRaw)));
    expect(dry.trimEnd().endsWith("\\echo DRYRUN 196 OK")).toBe(true);
    expect(dry).toContain("-f tests/migrations/sql/stub.sql");
    expect(dry).toContain("D=$(mktemp -d)");
    expect(dry).toContain("-- or: bash tests/migrations/sql/run-live.sh");
  });

  it("the dry-run shows the defect on 194's body, then 196: the five pairs, the pinned helper text, the controls, a negation, hostile strings do not raise, the plan, the timing", () => {
    for (const q of ["emekli maasi", "emekli maaşı", "siginagi", "sığınağı", "maaslari", "maaşları", "cocugu", "çocuğu", "guvenligi", "güvenliği", "negated", "burdur", "miller", "akp alias", "hakki", "hakkı", "iliski"]) {
      expect(dry, q).toContain(`'${q}'`);
    }
    for (const out of [
      "( 'emekli' | 'emekl' ) & ( 'maasi' | 'maas' )",
      "'siginagi' | 'siginag' | 'siginak'",
      "'maaslari' | 'maaslar' | 'maas'",
      "'kitabi' | 'kitab' | 'kitap'",
      "'cildi' | 'cild' | 'cilt'",
      "!( 'maasi' | 'maas' ) & 'x2024'",
      "'a' <-> ( 'maasi' | 'maas' )",
    ]) {
      expect(dry, out).toContain(out);
    }
    for (const w of ["'zam'", "'iran'", "'secim'", "'kari'", "'2024'", "'maasi:*'"]) expect(dry, w).toContain(w);
    // the three review fixes: a geminate root and the deny set stay out, the sevg root stays, a doubled-quote query is returned as it is
    for (const out of ["'zammi'", "'hakki'", "'iliski'", "'turku'", "'hissi'", "'hatti'", "'sevgi' | 'sevg'"]) expect(dry, out).toContain(out);
    for (const c of ["a.com/x''maasi", "x.com/a''kitabi", "haber.com/x''maasi emekli", "x.co/a''cocugu''y", "a.com/''maasi''", "x.co/a''maaslari"]) expect(dry, c).toContain(c);
    expect(dry).toContain("a doubled-quote query must be returned unchanged");
    expect(dry).toContain("'hkB'");
    expect(dry).toContain("'ilB'");
    expect(dry).toContain("baseline: 194");
    expect(dry).toContain("explain (analyze)");
    expect(dry).toContain("clusters_search_stemfold_live_idx");
    expect(dry).toContain("Fuzz");
    expect(dry).toContain("1.5");
    expect(dry).toContain("rollback;");
  });
});

// ---------------------------------------------------------------------------
// Live block (opt-in). TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/PGDATABASE point at a THROWAWAY database that the
// dry-run script left behind with 129, 166, 172, 185, 186, 194 and 196 applied (tests/migrations/sql/live-manifest.txt). Every scenario
// runs inside begin ... rollback: it seeds clusters, runs 194's body (as a pg_temp function made from the text of 194's migration
// file) and the installed 196 function side by side, and checks the contracts of 196:
//   (1) 196's id set contains 194's for every call (the roots only add candidates), and a Turkish spelling and every control keep exactly
//       their ids;
//   (2) the ASCII spelling of an inflected word finds exactly what its Turkish spelling finds, in the same order, and 194 did not;
//   (3) a negation still excludes, the guard (burdur), the tier (miller) and the alias query keep their behaviour;
//   (4) the helper's output text is pinned, it is strict, and a lexeme with a suffix marker is left whole.
// ---------------------------------------------------------------------------

interface Seed {
  key: string;
  /** clusters.title_tr: the original headline. */
  title: string;
  summary: string;
  members: number;
  age: string;
}

const SEEDS: Seed[] = [
  // (a) emekli maaşı: the stored stems are emekli + maaş
  { key: "mA", title: "Emekli maaşları için yeni formül masada", summary: "Hazırlık sürüyor.", members: 6, age: "4 days" },
  { key: "mB", title: "Emekli maaşı zammı açıklandı", summary: "Bakan konuştu.", members: 5, age: "3 days" },
  { key: "mC", title: "Emekliye bayram ikramiyesi müjdesi", summary: "Ödeme tarihi belli oldu.", members: 4, age: "2 days" },
  { key: "mD", title: "Memur maaşları için zam oranı belli oldu", summary: "Toplu sözleşme.", members: 4, age: "3 days" },
  // (b) sığınak, (c) çocuk, (d) güvenlik, (e) kitap, (f) zam, (g) seçim sonuçları
  { key: "sA", title: "Depremzedeler için yeni sığınak kuruldu", summary: "Çalışma sürüyor.", members: 3, age: "2 days" },
  { key: "sB", title: "Sığınağa yerleşen aileler yardım bekliyor", summary: "Ekipler bölgede.", members: 3, age: "3 days" },
  { key: "sC", title: "Sığınaklar denetleniyor", summary: "Valilik açıkladı.", members: 2, age: "5 days" },
  { key: "sD", title: "Sığınmacılar için yeni düzenleme", summary: "Bakanlık açıkladı.", members: 2, age: "1 day" },
  { key: "cA", title: "Çocuğu kaybolan aile aranıyor", summary: "Polis ekipleri çalışıyor.", members: 3, age: "1 day" },
  { key: "cB", title: "Çocuk istismarı davasında karar çıktı", summary: "Mahkeme açıkladı.", members: 4, age: "2 days" },
  { key: "cC", title: "Çocuğun annesi gözaltına alındı", summary: "Soruşturma sürüyor.", members: 2, age: "4 days" },
  { key: "gA", title: "Okulların güvenliği artırıldı", summary: "Bakanlık duyurdu.", members: 3, age: "1 day" },
  { key: "gB", title: "Güvenlik toplantısı yapıldı", summary: "Kurul toplandı.", members: 2, age: "2 days" },
  { key: "gC", title: "Güvenliği sağlamak için yeni kural geldi", summary: "Karar yayımlandı.", members: 3, age: "3 days" },
  { key: "kA", title: "Yazarın kitapları toplatıldı", summary: "Karar çıktı.", members: 2, age: "2 days" },
  { key: "kB", title: "Kitabı yayımlandı", summary: "Yayınevi duyurdu.", members: 2, age: "3 days" },
  { key: "zA", title: "Asgari ücret zammı için masa kuruldu", summary: "Heyet toplanıyor.", members: 5, age: "2 days" },
  { key: "zC", title: "Asgari ücret zam oranı belli oldu", summary: "Beklenti sürüyor.", members: 4, age: "2 days" },
  { key: "zD", title: "Doğal gaza zam geldi", summary: "Tarife değişti.", members: 3, age: "1 day" },
  { key: "secA", title: "Seçim sonuçları açıklandı", summary: "Kurul sonuçları duyurdu.", members: 2, age: "15 hours" },
  { key: "secB", title: "Seçim sonucu kesinleşti", summary: "Yüksek Kurul açıkladı.", members: 3, age: "16 hours" },
  { key: "secC", title: "Seçim kampanyası başladı", summary: "Partiler sahada.", members: 2, age: "17 hours" },
  // controls: names, the guard, the tier, the alias
  { key: "imam1", title: "İmamoğlu davasında yeni gelişme", summary: "Duruşma ertelendi.", members: 5, age: "2 days" },
  { key: "imam2", title: "İmamoğlu'nun avukatları açıklama yaptı", summary: "Savunma konuştu.", members: 3, age: "3 days" },
  { key: "ozel", title: "Özgür Özel miting yaptı", summary: "Kalabalık toplandı.", members: 3, age: "1 day" },
  { key: "erd", title: "Erdoğan açıklama yaptı", summary: "Cumhurbaşkanı konuştu.", members: 3, age: "1 day" },
  { key: "iranA", title: "İran açıklama yaptı", summary: "Bakanlık duyurdu.", members: 2, age: "2 days" },
  { key: "burdur", title: "Burdur'da yurt zehirlenmesi", summary: "Öğrenciler hastaneye kaldırıldı.", members: 2, age: "1 hour" },
  { key: "bursa", title: "Bursa'da deprem uyarısı", summary: "Uzmanlar uyardı.", members: 2, age: "2 hours" },
  { key: "miller", title: "Miller açıklama yaptı", summary: "Açıklama geldi.", members: 2, age: "10 hours" },
  { key: "akp1", title: "AKP'den açıklama", summary: "Parti sözcüsü konuştu.", members: 2, age: "16 hours" },
  { key: "akp2", title: "AK Parti toplantısı", summary: "Grup toplantısı yapıldı.", members: 3, age: "17 hours" },
  // roots that are the stem of another word: the stemmer leaves hakkı and ilişki whole, hakkında stems to hakk and ilişkin to ilişk.
  // hkB is newer than hkA on purpose (recency would put it first). The ASCII spelling must find the hkA / ilA rows only, as 194 does.
  { key: "hkA", title: "Umut hakkı yeniden tartışılıyor", summary: "Tartışma sürüyor.", members: 3, age: "3 days" },
  { key: "hkB", title: "Bakan hakkında soruşturma başlatıldı", summary: "Savcılık açıkladı.", members: 3, age: "1 day" },
  { key: "ilA", title: "Yeni ilişki dönemi başladı", summary: "Taraflar görüştü.", members: 2, age: "2 days" },
  { key: "ilB", title: "Duruma ilişkin açıklama yapıldı", summary: "Sözcü konuştu.", members: 2, age: "1 day" },
];

const seedId = (i: number): string => `00000000-0000-4000-8000-${String(196000 + i).padStart(12, "0")}`;
const KEY_BY_ID = new Map(SEEDS.map((s, i) => [seedId(i), s.key]));

const lit = (s: string | null): string => (s === null ? "null" : `'${s.replaceAll("'", "''")}'`);

interface LiveQuery {
  name: string;
  variants: string[];
  folded: string;
}

/** The arguments the app builds for a typed query (turkishQueryVariants, foldTr). */
const typed = (name: string): LiveQuery => ({ name, variants: turkishQueryVariants(name), folded: foldTr(name) });

const PAIRS: Array<[string, string]> = [
  ["emekli maasi", "emekli maaşı"],
  ["siginagi", "sığınağı"],
  ["maaslari", "maaşları"],
  ["cocugu", "çocuğu"],
  ["guvenligi", "güvenliği"],
  ["secim sonuclari", "seçim sonuçları"],
];
/** Queries whose stem query holds a lexeme with an apostrophe inside it (a URL or file token): 194 answers them, 196 must not raise. */
const QUOTE_QUERIES = ["a.com/x'maasi", "x.com/a'kitabi", "haber.com/x'maasi emekli", "x.co/a'cocugu'y", "a.com/'maasi'", "x.co/a'maaslari"];
/** Every Turkish spelling and every control: the ids must not move. */
const UNCHANGED = [
  "emekli maaşı", "sığınağı", "maaşları", "çocuğu", "güvenliği", "seçim sonuçları", "kitabi", "kitabı", "asgari ucret zammi", "asgari ucret zam", "dogal gaz zam",
  "hakki", "hakkı", "iliski", "umut hakki", "zam", "secim", "iran", "erdogan", "burdur", "miller", "imamoglu", "imamoğlu", "ozgur ozel", "özgür özel", "akp alias", "negated phrase", "empty",
  // an apostrophe inside a URL or file token: the stem query holds a lexeme with a doubled quote; 194 answers with no rows, so must 196
  ...QUOTE_QUERIES,
];

const LIVE_QUERIES: LiveQuery[] = [
  ...[...PAIRS.flat(), "kitabi", "kitabı", "asgari ucret zammi", "asgari ucret zam", "dogal gaz zam", "hakki", "hakkı", "iliski", "umut hakki", "zam", "secim", "iran", "erdogan", "burdur", "miller", "imamoglu", "imamoğlu", "ozgur ozel", "özgür özel", ...QUOTE_QUERIES].map(typed),
  { name: "akp alias", variants: ['akp or "ak parti"'], folded: "akp or ak parti" },
  { name: "negated", variants: ["maaslari -memur"], folded: "maaslari -memur" },
  { name: "negated phrase", variants: ['iran -"israil saldırısı"'], folded: 'iran -"israil saldirisi"' },
  { name: "empty", variants: [""], folded: "" },
];

describe.runIf(Boolean(process.env.TAYF_PSQL))("196 ASCII inflection roots against a live Postgres (129, 166, 172, 185, 186, 194 and 196 applied)", () => {
  assertLiveReady("196", {
    ledger: ["129", "166", "172", "185", "186", "194", "196"],
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

  /** 194's function, from the text of 194's migration file, as a pg_temp function of the same shape. */
  const FN_194 =
    "create function pg_temp.f194(p_variants text[], p_folded text, p_limit integer default 12) returns table (id uuid) " +
    `language sql stable set search_path = '' as $fn$${raw194}$fn$;`;

  const rows = SEEDS.map(
    (s, i) => `(${lit(seedId(i))}, ${lit(s.title)}, null, ${lit(s.summary)}, ${s.members}, false, now() - interval '${s.age}')`,
  ).join(",\n");

  const list = (fn: string, q: LiveQuery): string =>
    `select ${lit(`${q.name}|${fn === "pg_temp.f194" ? "194" : "196"}|`)} || coalesce((select string_agg(t.id::text, ',' order by t.n) ` +
    `from ${fn}(${arr(q.variants)}, ${lit(q.folded)}, 50) with ordinality as t(id, n)), '');`;

  const script = [
    "begin;",
    FN_194,
    `insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at) values\n${rows};`,
    "analyze public.clusters;",
    ...LIVE_QUERIES.flatMap((q) => [list("pg_temp.f194", q), list("public.search_cluster_ids", q)]),
    "rollback;",
  ].join("\n");

  const ids194 = new Map<string, string[]>();
  const ids196 = new Map<string, string[]>();
  let ran = false;
  const run = (): void => {
    if (ran) return;
    ran = true;
    for (const line of runPsql(script).split("\n")) {
      if (line === "") continue;
      const [name, which, ids] = line.split("|") as [string, string, string];
      const keys = ids === "" ? [] : ids.split(",").map((id) => KEY_BY_ID.get(id) ?? `?${id}`);
      (which === "194" ? ids194 : ids196).set(name, keys);
    }
  };

  const keysOf = (m: Map<string, string[]>, name: string): string[] => {
    run();
    const v = m.get(name);
    expect(v, `no result for ${name}`).toBeDefined();
    return v as string[];
  };
  const setOf = (m: Map<string, string[]>, name: string): string[] => [...keysOf(m, name)].sort();

  it.each(LIVE_QUERIES.map((q) => [q.name, q] as [string, LiveQuery]))(
    "'%s': 196 returns every id 194 returns (the roots only add candidates), no id twice, below the 50-row cap",
    (_name, q) => {
      const old = keysOf(ids194, q.name);
      const now = keysOf(ids196, q.name);
      expect(now, q.name).toEqual(expect.arrayContaining(old));
      expect(now.length, q.name).toBe(new Set(now).size);
      expect(now.length, "below the 50-row cap").toBeLessThan(50);
    },
  );

  it.each(UNCHANGED.map((n) => [n] as [string]))("'%s' keeps exactly its ids (a Turkish spelling, a control, or a word without a suffix root)", (name) => {
    expect(setOf(ids196, name)).toEqual(setOf(ids194, name));
  });

  it("the queries of the fixtures find rows at all (the checks above are not vacuous)", () => {
    for (const [, tr] of PAIRS) expect(keysOf(ids196, tr).length, tr).toBeGreaterThan(1);
    for (const name of ["burdur", "miller", "akp alias", "secim", "imamoglu", "ozgur ozel", "zam", "asgari ucret zam"]) expect(keysOf(ids196, name).length, name).toBeGreaterThan(0);
    expect(keysOf(ids196, "empty")).toEqual([]);
  });

  it.each(PAIRS)("'%s' (ASCII) finds exactly what '%s' finds, in the same order; 194 found only part of it", (ascii, turkish) => {
    expect(setOf(ids196, ascii), ascii).toEqual(setOf(ids196, turkish));
    expect(keysOf(ids196, ascii), ascii).toEqual(keysOf(ids196, turkish));
    const before = setOf(ids194, ascii);
    expect(before.length, `${ascii} on 194`).toBeLessThan(setOf(ids194, turkish).length);
    expect(setOf(ids196, ascii), ascii).toEqual(expect.arrayContaining(before));
  });

  it("the rows are the right ones: only the stem's inflections, not the word with another meaning, not archived or single-article rows", () => {
    expect(setOf(ids196, "emekli maasi")).toEqual(["mA", "mB"]);
    expect(setOf(ids196, "siginagi")).toEqual(["sA", "sB", "sC"]);
    expect(setOf(ids196, "maaslari")).toEqual(["mA", "mB", "mD"]);
    expect(setOf(ids196, "cocugu")).toEqual(["cA", "cB", "cC"]);
    expect(setOf(ids196, "guvenligi")).toEqual(["gA", "gB", "gC"]);
    expect(setOf(ids196, "secim sonuclari")).toEqual(["secA", "secB"]);
  });

  it("a root that is the stem of another word is not added: hakki, hakkı and iliski keep 194's ids and order, the (newer) hakkında and ilişkin rows stay out", () => {
    for (const name of ["hakki", "hakkı", "iliski", "umut hakki"]) {
      expect(keysOf(ids196, name), name).toEqual(keysOf(ids194, name));
      expect(keysOf(ids196, name), name).not.toEqual(expect.arrayContaining(["hkB"]));
      expect(keysOf(ids196, name), name).not.toEqual(expect.arrayContaining(["ilB"]));
    }
    expect(keysOf(ids196, "hakki")).toEqual(["hkA"]);
    expect(keysOf(ids196, "hakkı")).toEqual(["hkA"]);
    expect(keysOf(ids196, "umut hakki")).toEqual(["hkA"]);
    expect(keysOf(ids196, "iliski")).toEqual(["ilA"]);
  });

  it.each(QUOTE_QUERIES.map((n) => [n] as [string]))(
    "'%s' (an apostrophe inside a URL token) is answered, not raised: the whole script ran, and 196 returns what 194 returns",
    (name) => {
      expect(setOf(ids196, name)).toEqual(setOf(ids194, name));
      expect(keysOf(ids196, name), name).toEqual(keysOf(ids194, name));
    },
  );

  it("the sibling call of the app ('asgari ucret zammi' -> 'asgari ucret zam', folded as the sibling) finds the 'zam' rows, and 196 does not change that", () => {
    expect(setOf(ids196, "asgari ucret zam")).toEqual(["zC"]);
    expect(setOf(ids196, "asgari ucret zam")).toEqual(setOf(ids194, "asgari ucret zam"));
  });

  it("a negation still excludes: maaslari -memur has the roots of maaslari and drops the memur row", () => {
    expect(setOf(ids196, "negated")).toEqual(["mA", "mB"]);
    expect(setOf(ids194, "negated")).toEqual(["mA"]);
  });

  it("the 166 guard stays: burdur keeps the Burdur row, not Bursa", () => {
    expect(keysOf(ids196, "burdur")).toEqual(["burdur"]);
  });

  it("the 172 tier stays: the Miller row comes first, and the alias query keeps both party rows", () => {
    expect(keysOf(ids196, "miller")[0]).toBe("miller");
    expect(keysOf(ids196, "akp alias")).toEqual(expect.arrayContaining(["akp1", "akp2"]));
  });

  it("the helper's output text is pinned (the three rules, the soft letters, operators kept, unchanged lexemes, a suffix marker, null)", () => {
    const cases: Array<[string, string]> = [
      ["emekli & maasi", "( 'emekli' | 'emekl' ) & ( 'maasi' | 'maas' )"],
      ["siginagi", "'siginagi' | 'siginag' | 'siginak'"],
      ["maaslari", "'maaslari' | 'maaslar' | 'maas'"],
      ["maaslarin", "'maaslarin' | 'maas'"],
      ["guvenligi", "'guvenligi' | 'guvenlig' | 'guvenlik'"],
      ["cocugu", "'cocugu' | 'cocug' | 'cocuk'"],
      ["kitabi", "'kitabi' | 'kitab' | 'kitap'"],
      ["cildi", "'cildi' | 'cild' | 'cilt'"],
      ["vergisi", "'vergisi' | 'vergis' | 'vergi'"],
      ["!maasi & x2024", "!( 'maasi' | 'maas' ) & 'x2024'"],
      ["a <-> maasi", "'a' <-> ( 'maasi' | 'maas' )"],
      // a geminate root (zamm, hakk, hiss, hatt) and the deny set (ilisk, turk, sevk) stay out; the root sevg stays (it matches no stored stem)
      ["zammi", "'zammi'"],
      ["hakki", "'hakki'"],
      ["hissi", "'hissi'"],
      ["hatti", "'hatti'"],
      ["iliski", "'iliski'"],
      ["turku", "'turku'"],
      ["sevgi", "'sevgi' | 'sevg'"],
      ["parti", "'parti' | 'part'"],
      ["zam", "'zam'"],
      ["iran", "'iran'"],
      ["secim", "'secim'"],
      ["kari", "'kari'"],
      ["2024", "'2024'"],
      ["maasi:*", "'maasi':*"],
    ];
    const sqlText = cases
      .map(([input]) => `select ${lit(input)} || '=>' || public.tayf_ascii_inflection_expand(pg_catalog.to_tsquery('pg_catalog.simple', ${lit(input)}))::text;`)
      .join("\n");
    const out = runPsql(sqlText).trim().split("\n");
    expect(out).toEqual(cases.map(([input, want]) => `${input}=>${want}`));
    const nulls = runPsql("select public.tayf_ascii_inflection_expand(null::tsquery) is null;").trim();
    expect(nulls).toBe("t");
    // a stem query with a doubled quote inside a lexeme (the apostrophe of a URL token) is returned as it is, and never raises
    const quoted = runPsql(
      QUOTE_QUERIES.map(
        (q) =>
          `select v::text = public.tayf_ascii_inflection_expand(v)::text from (select pg_catalog.to_tsquery('pg_catalog.simple', public.tayf_search_fold(pg_catalog.plainto_tsquery('pg_catalog.turkish', ${lit(q)})::text)) as v) x;`,
      ).join("\n"),
    )
      .trim()
      .split("\n");
    expect(quoted).toEqual(QUOTE_QUERIES.map(() => "t"));
  });

  it("is applied once: one ledger row for 196, one overload of each function, the bodies of the file, the attributes and grants as the file says", () => {
    const out = runPsql(`
select (select count(*) from supabase_migrations.schema_migrations where version = '196'),
       (select count(*) from pg_catalog.pg_proc where proname = 'search_cluster_ids' and pronamespace = 'public'::regnamespace and pg_get_function_identity_arguments(oid) = 'p_variants text[], p_folded text, p_limit integer'),
       (select count(*) from pg_catalog.pg_proc where proname = 'tayf_ascii_inflection_expand' and pronamespace = 'public'::regnamespace),
       p.prosecdef, p.provolatile, (p.proconfig = array['search_path=""']), p.proacl::text, md5(p.prosrc), length(p.prosrc),
       has_function_privilege('anon', p.oid, 'execute'), has_function_privilege('authenticated', p.oid, 'execute'),
       has_function_privilege('service_role', p.oid, 'execute'),
       obj_description(p.oid, 'pg_proc') like '%196%'
  from pg_catalog.pg_proc p
 where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
select h.prosecdef, h.provolatile, h.proparallel, h.proisstrict, (h.proconfig = array['search_path=""']), h.proacl::text, md5(h.prosrc), length(h.prosrc),
       has_function_privilege('anon', h.oid, 'execute'), has_function_privilege('authenticated', h.oid, 'execute'),
       has_function_privilege('service_role', h.oid, 'execute'),
       (select l.lanname from pg_catalog.pg_language l where l.oid = h.prolang),
       obj_description(h.oid, 'pg_proc') like '%196%'
  from pg_catalog.pg_proc h
 where h.oid = 'public.tayf_ascii_inflection_expand(tsquery)'::regprocedure;
`).trim();
    const [fnLine, helperLine] = out.split("\n") as [string, string];
    const f = fnLine.split("|");
    expect(f[0]).toBe("1"); // ledger rows for 196
    expect(f[1]).toBe("1"); // one three-argument overload
    expect(f[2]).toBe("1"); // one helper
    expect(f[3]).toBe("t"); // security definer
    expect(f[4]).toBe("s"); // stable
    expect(f[5]).toBe("t"); // search_path = ''
    expect(f[6]).toBe(PROD_PROACL);
    expect(f[7]).toBe(md5(raw196)); // the function in the database is the body of the file
    expect(f[8]).toBe(String(pgLength(raw196)));
    expect(f[9]).toBe("f"); // anon
    expect(f[10]).toBe("f"); // authenticated
    expect(f[11]).toBe("t"); // service_role
    expect(f[12]).toBe("t"); // the comment names 196
    const h = helperLine.split("|");
    expect(h[0]).toBe("f"); // not security definer
    expect(h[1]).toBe("i"); // immutable
    expect(h[2]).toBe("s"); // parallel safe
    expect(h[3]).toBe("t"); // strict
    expect(h[4]).toBe("t"); // search_path = ''
    expect(h[5]).toBe(PROD_PROACL);
    expect(h[6]).toBe(md5(helperRaw));
    expect(h[7]).toBe(String(pgLength(helperRaw)));
    expect(h[8]).toBe("f"); // anon
    expect(h[9]).toBe("f"); // authenticated
    expect(h[10]).toBe("t"); // service_role
    expect(h[11]).toBe("plpgsql");
    expect(h[12]).toBe("t"); // the comment names 196
  });
});
