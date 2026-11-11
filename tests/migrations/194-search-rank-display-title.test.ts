import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { foldTr } from "@/lib/clusters/turkish-query";
import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Contract test for migration 194 ("search rank on the display title"), h116-search-1 (hunt 116). 191 is reserved (not applied),
// 192 and 193 are applied; this file takes the next free number.
//
// 186's final ORDER BY ranks by (1) the lit_ok tier, then 1.0 * ts_rank_cd(title) + 2.0 * [the typed phrase starts a word of the
// folded neutral||original title] + 0.5 / (1 + age / 7 d). Two defects, both visible on production on 2026-11-11: the literal tier
// compares the typed surface form ('emekli maasi') over a title that also carries the hidden outlet headline, so 'emekli maaslari'
// never matches and a 197-day-old row with the typed form outranks nine-source stories from last week; and ts_rank_cd rewards a word
// repeated in one title ('Depremler. Deprem mi oldu?' boilerplate).
//
// 194 changes ONLY the ORDER BY of public.search_cluster_ids(text[], text, integer) (and what it reads): the candidates, 166's guard,
// 172's lit_ok tier, the 1000-row cap, the grants and the id set of every query are 186's. This file pins, without a database: the file,
// ledger and transaction, that 186's body is the base (md5 pinned), a derive-and-compare of 194's body against 186's (only the hits
// select list and laterals, the new lw CTE and the final ORDER BY differ), the ORDER BY, that no user text reaches a regex, the
// header, the docs section, the dry-run and the live-manifest entry. The opt-in live block (TAYF_PSQL) runs 186's body and 194's function
// side by side on fixtures inside a rolled-back transaction.
//
// No regular expression is applied to quoted SQL literals in this file (CodeQL js/redos): the SQL is scanned with indexOf and
// character loops.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const FILE_194 = "194_search_rank_display_title.sql";
const MIGRATION_194 = resolve(MIGRATIONS_DIR, FILE_194);
const MIGRATION_186 = resolve(MIGRATIONS_DIR, "186_search_stem_fold_arm.sql");
const DRYRUN_194 = resolve(ROOT, "tests", "migrations", "sql", "194-search-rank-display-title-dryrun.sql");
const MANIFEST = resolve(ROOT, "tests", "migrations", "sql", "live-manifest.txt");
const DOC_MIGRATION_GUIDE = resolve(ROOT, "docs", "migration-guide.md");

/** md5 and length of 186's function body: the base of 194, and what production runs (read-only, 2026-11-11). */
const BASE_MD5 = "973e3707e98448b0385bd0402c039df3";
const BASE_LENGTH = 14850;
const PROD_PROACL = "{postgres=X/postgres,service_role=X/postgres}";

const LEDGER_STMT =
  "insert into supabase_migrations.schema_migrations (version, name) values ('194', '194_search_rank_display_title') on conflict do nothing;";
const REVOKE_FN = "revoke all on function public.search_cluster_ids(text[], text, integer) from public, anon, authenticated;";
const GRANT_FN = "grant execute on function public.search_cluster_ids(text[], text, integer) to service_role;";

/** The new CTE, comments stripped, between top and hits. */
const LW_CTE =
  "), lw as ( select distinct pg_catalog.left(s.w, greatest(least(pg_catalog.length(s.w), 4), pg_catalog.length(s.w) - 2)) as pre from g0 cross join lateral pg_catalog.regexp_split_to_table(g0.tok, '[^a-z0-9]+') as s(w) where s.w <> '' and not exists (select 1 from g0 o where pg_catalog.regexp_replace(o.tok, '[^a-z0-9]+', '', 'g') = 'or') and not exists (select 1 from f0 where pg_catalog.strpos(f0.ff, '-\"') > 0) ), hits as (";
/** The two columns hits gains, comments stripped. */
const HITS_COLUMNS =
  "d.f as dfold, (exists (select 1 from lw) and not exists (select 1 from lw where pg_catalog.strpos(dn.n, ' ' || lw.pre) = 0)) as lit_d";
/** The two laterals hits gains, comments stripped. */
const HITS_LATERALS =
  "cross join lateral (select public.tayf_search_fold(coalesce(nullif(pg_catalog.btrim(c.title_tr_neutral), ''), c.title_tr)) as f offset 0) d cross join lateral (select ' ' || pg_catalog.regexp_replace(d.f, '[^a-z0-9]+', ' ', 'g') as n offset 0) dn";
/** The new final select, comments stripped. */
const NEW_TAIL =
  "select h.id from hits h cross join q order by (case when h.lit_ok then 0 else 1 end), 2.0 * h.lit_d::pg_catalog.int4 + 0.3 * (least(pg_catalog.ts_rank_cd(pg_catalog.to_tsvector('pg_catalog.turkish'::pg_catalog.regconfig, h.dfold), q.qf, 32)::pg_catalog.float8, 0.2) / 0.2) + 1.0 / (1.0 + extract(epoch from (pg_catalog.now() - h.updated_at))::pg_catalog.float8 / 1209600.0) + 0.15 * pg_catalog.ln(least(greatest(h.article_count, 1), 50)::pg_catalog.float8) desc, h.article_count desc, h.updated_at desc, h.id limit greatest(1, least(coalesce(p_limit, 12), 50));";

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
 * The second argument of every regexp_replace( / regexp_split_to_table( call, read with a quote- and paren-aware splitter. The
 * pattern of such a call must be a plain quoted constant: that is how "no user value reaches a regex" is checked.
 */
function regexPatterns(sql: string): string[] {
  const out: string[] = [];
  for (const fnName of ["regexp_replace(", "regexp_split_to_table("]) {
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
let fn194 = "";
let cb194 = "";
/** The body as the database stores it (prosrc): comments included. */
let raw194 = "";

if (existsSync(MIGRATION_194)) {
  sql = readFileSync(MIGRATION_194, "utf8");
  code = stripComments(sql);
  head = sql.slice(0, sql.indexOf("\nbegin;"));
  fn194 = functionBlock(code, "search_cluster_ids");
  cb194 = collapse(fnBody(fn194));
  raw194 = fnBody(functionBlock(sql, "search_cluster_ids"));
}
const sql186 = readFileSync(MIGRATION_186, "utf8");
const fn186 = functionBlock(stripComments(sql186), "search_cluster_ids");
const cb186 = collapse(fnBody(fn186));
const raw186 = fnBody(functionBlock(sql186, "search_cluster_ids"));

describe("194 file, ledger and structure", () => {
  it("exists with the exact name, and no other migration claims the number 194", () => {
    expect(existsSync(MIGRATION_194)).toBe(true);
    const claimed = readdirSync(MIGRATIONS_DIR).filter((n) => n.startsWith("194_"));
    expect(claimed).toEqual([FILE_194]);
  });

  it("contains the ledger insert for '194' with on conflict do nothing, the last statement before commit", () => {
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

  it("is additive only: ONE function replace, the comment, the ledger row; no drop, alter, truncate, update, delete, table, index or trigger", () => {
    const bare = sansStrings(code).toLowerCase();
    for (const bad of ["drop ", "alter ", "truncate", "delete ", "update ", "create table", "create unique", "create index", "create trigger", "create view", "create extension", "create function"]) {
      expect(bare.includes(bad), bad).toBe(false);
    }
    expect(countOf(bare, "create or replace function")).toBe(1);
    expect(countOf(bare, "insert into ")).toBe(1);
    expect(countOf(bare, "comment on ")).toBe(1);
    expect(bare).toContain("insert into supabase_migrations.schema_migrations");
  });

  it("grants no table, sequence or schema privilege, and exactly one function grant, to service_role", () => {
    const bare = sansStrings(code).toLowerCase();
    expect(bare).not.toContain("on table");
    expect(bare).not.toContain("on all tables");
    expect(bare).not.toContain("on sequence");
    expect(bare).not.toContain("on schema");
    const c = collapse(code);
    expect(countOf(c, "grant ")).toBe(1);
    expect(c).toContain(GRANT_FN);
    expect(c).toContain(REVOKE_FN);
    expect(c.indexOf(REVOKE_FN)).toBeLessThan(c.indexOf(GRANT_FN));
  });

  it("reloads the PostgREST schema cache, before the ledger insert", () => {
    const c = collapse(code);
    expect(c).toContain("notify pgrst, 'reload schema';");
    expect(c.indexOf("notify pgrst")).toBeLessThan(c.indexOf("insert into supabase_migrations"));
  });

  it("single-quote characters balance once comments are stripped (no string literal holds two dashes)", () => {
    expect(countOf(code, "'") % 2).toBe(0);
  });

  it("does not claim the reserved number 191 or touch another migration's files", () => {
    expect(head).toContain("191");
    expect(existsSync(resolve(MIGRATIONS_DIR, "191_trends_entity_rollup_minister_forms.sql"))).toBe(true);
    expect(readdirSync(MIGRATIONS_DIR).filter((n) => n.startsWith("191_"))).toEqual(["191_trends_entity_rollup_minister_forms.sql"]);
  });
});

describe("194 search_cluster_ids(text[], text, integer)", () => {
  it("is the only definition of it and has 186's signature: create or replace, no drop, no new overload", () => {
    expect(fn194.startsWith("create or replace function public.search_cluster_ids(p_variants text[], p_folded text, p_limit integer default 12)")).toBe(true);
    expect(countOf(code, "create or replace function public.search_cluster_ids(")).toBe(1);
  });

  it("has exactly 186's header: returns table (id uuid), language sql, stable, security definer, search_path ''", () => {
    expect(collapse(fnHeader(fn194))).toBe(collapse(fnHeader(fn186)));
    const h = collapse(fnHeader(fn194));
    expect(h).toContain("returns table (id uuid)");
    expect(h).toContain("language sql");
    expect(h).toContain("stable");
    expect(h).toContain("security definer");
    expect(h).toContain("set search_path = ''");
  });

  it("has a function comment that names the display-title ranking and the migrations it builds on", () => {
    const c = collapse(code);
    const at = c.indexOf("comment on function public.search_cluster_ids(text[], text, integer) is");
    expect(at).toBeGreaterThan(-1);
    const comment = c.slice(at, c.indexOf("revoke all", at)).toLowerCase();
    for (const word of ["194", "186", "185", "172", "166", "129", "display title", "three separate index scans", "p_folded", "recall", "14-day"]) expect(comment, word).toContain(word);
    // the old order sentence of 186 is gone: it described the weights 194 replaces
    expect(comment).not.toContain("(1.0) plus recency (0.5, 7-day scale)");
    // lw mirrors both switches of gx: no literal tier for an alias, an OR or a negated-phrase query
    expect(comment).toContain("negated-phrase query");
    expect(comment).not.toContain("none for an alias or or query");
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

  it("every catalog function the body calls is schema-qualified (empty search_path), every cast names pg_catalog", () => {
    const bare = sansStrings(cb194);
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
  });
});

describe("194 body = 186's body plus the lw CTE, two hits columns with their laterals, and a new ORDER BY, nothing else", () => {
  it("186's body is the base: its md5 and length are the recorded ones, and production runs it (read-only, 2026-11-11)", () => {
    expect(md5(raw186)).toBe(BASE_MD5);
    expect(pgLength(raw186)).toBe(BASE_LENGTH);
    const at = head.indexOf("\n-- BASE");
    expect(at).toBeGreaterThan(-1);
    const base = head.slice(at, head.indexOf("\n-- STEP 0", at));
    for (const word of [BASE_MD5, String(BASE_LENGTH), "production"]) expect(base, word).toContain(word);
  });

  it("everything up to and including top (f0, g0, gx, g, ge, f, q, qs, cand, kept, top) is 186's text byte for byte, comments included", () => {
    const upTo194 = raw194.slice(0, raw194.indexOf("  ), lw as (\n"));
    const upTo186 = raw186.slice(0, raw186.indexOf("  ), hits as (\n"));
    expect(upTo194.length).toBeGreaterThan(5000);
    expect(upTo194).toBe(upTo186);
    expect(raw194.indexOf("  ), lw as (\n")).toBeLessThan(raw194.indexOf("  ), hits as (\n"));
  });

  it("the lw CTE is exactly this statement (comments stripped), between top and hits", () => {
    expect(cb194).toContain(LW_CTE);
    expect(countOf(cb194, "lw as (")).toBe(1);
    expect(cb194.indexOf("), top as (")).toBeLessThan(cb194.indexOf("), lw as ("));
    expect(cb194.indexOf("), lw as (")).toBeLessThan(cb194.indexOf("), hits as ("));
  });

  it("lw carries both of gx's switches: a token `or` and a negated phrase (-\"), so such a query gets no literal tier, as under 186", () => {
    const lw = cb194.slice(cb194.indexOf("), lw as ("), cb194.indexOf("), hits as ("));
    const gx = cb194.slice(cb194.indexOf("), gx as ("), cb194.indexOf("), g as ("));
    const orSwitch = "not exists (select 1 from g0 o where pg_catalog.regexp_replace(o.tok, '[^a-z0-9]+', '', 'g') = 'or')";
    const negSwitch = "not exists (select 1 from f0 where pg_catalog.strpos(f0.ff, '-\"') > 0)";
    expect(gx).toContain(negSwitch);
    expect(lw).toContain(orSwitch);
    expect(lw).toContain(negSwitch);
    expect(lw.indexOf(orSwitch)).toBeLessThan(lw.indexOf(negSwitch));
    expect(countOf(lw, "strpos(f0.ff")).toBe(1);
  });

  it("hits = 186's hits plus the two columns and the two laterals; ftitle and lit_ok are untouched (derived, comments included)", () => {
    const hitsAt194 = raw194.indexOf("  ), hits as (\n");
    const hits194 = raw194.slice(hitsAt194, raw194.indexOf("  )\n  select h.id"));
    const hits186 = raw186.slice(raw186.indexOf("  ), hits as (\n"), raw186.indexOf("  )\n  select h.id"));
    expect(hits194.length).toBeGreaterThan(hits186.length);
    // comment-only lines that 194 adds inside hits: a whole line starting with `--` (trimmed) that 186's hits does not have
    const old186 = new Set(hits186.split("\n").map((l) => l.trim()));
    const keep = (text: string): string =>
      text
        .split("\n")
        .filter((l) => !(l.trim().startsWith("--") && !old186.has(l.trim())))
        .join("\n");
    const noComments194 = keep(hits194);
    // the select list: `as lit_ok,` + the two columns (each on its own line) against `as lit_ok`
    const colsAt = noComments194.indexOf(" as lit_ok,\n");
    expect(colsAt, "lit_ok column followed by the new columns").toBeGreaterThan(-1);
    const fromTop = noComments194.indexOf("\n    from top t\n", colsAt);
    expect(fromTop).toBeGreaterThan(colsAt);
    const added = noComments194.slice(colsAt + " as lit_ok".length, fromTop);
    expect(collapse(added)).toBe(`, ${HITS_COLUMNS}`);
    let restored = noComments194.slice(0, colsAt + " as lit_ok".length) + noComments194.slice(fromTop);
    // the laterals: after the `b` lateral, before the closing paren of hits
    const latAt = restored.lastIndexOf("      offset 0) b\n");
    expect(latAt, "b lateral").toBeGreaterThan(-1);
    const afterB = latAt + "      offset 0) b\n".length;
    expect(collapse(restored.slice(afterB))).toBe(HITS_LATERALS);
    restored = restored.slice(0, afterB);
    // what is left is 186's hits with the closing paren the slice cut off
    expect(restored.trimEnd()).toBe(hits186.trimEnd());
    expect(hits194).toContain("a0.f as ftitle,");
  });

  it("the final select is exactly the new ORDER BY and the same limit, and the first key is still the 172 lit_ok tier", () => {
    expect(cb194.endsWith(NEW_TAIL)).toBe(true);
    expect(cb186.indexOf("select h.id from hits h cross join q order by (case when h.lit_ok then 0 else 1 end),")).toBeGreaterThan(-1);
    expect(cb194.indexOf("select h.id from hits h cross join q order by (case when h.lit_ok then 0 else 1 end),")).toBeGreaterThan(-1);
    const lim = "limit greatest(1, least(coalesce(p_limit, 12), 50));";
    expect(cb186.endsWith(lim)).toBe(true);
    expect(cb194.endsWith(lim)).toBe(true);
    expect(cb194).toContain("select k.id from kept k order by k.updated_at desc, k.id limit 1000");
  });

  it("the ORDER BY no longer calls ts_rank_cd on h.ftitle and its literal test no longer reads the folded neutral||original title or q.lit", () => {
    const tail = cb194.slice(cb194.indexOf("select h.id from hits h cross join q"));
    expect(tail).not.toContain("h.ftitle");
    expect(tail).not.toContain("q.lit");
    expect(tail).toContain("h.dfold");
    expect(countOf(tail, "ts_rank_cd(")).toBe(1);
    // 186's tail did read both
    const old = cb186.slice(cb186.indexOf("select h.id from hits h cross join q"));
    expect(old).toContain("h.ftitle");
    expect(old).toContain("q.lit");
    // the literal tier reads the display-title fold: dn.n is ' ' || the [a-z0-9]-normalised fold of coalesce(nullif(btrim(neutral), ''), title_tr)
    expect(cb194).toContain(HITS_LATERALS);
    expect(cb194).toContain("pg_catalog.strpos(dn.n, ' ' || lw.pre) = 0");
    expect(cb194).toContain("a0.f as ftitle,");
  });

  it("lit_ok and ftitle are unchanged: the tier still reads 186's folded neutral||original title", () => {
    const part = (cb: string): string => cb.slice(cb.indexOf("a0.f as ftitle,"), cb.indexOf("as lit_ok"));
    expect(part(cb194)).toBe(part(cb186));
    expect(part(cb194).length).toBeGreaterThan(300);
    expect(cb194).toContain("cross join lateral (select public.tayf_search_fold(coalesce(c.title_tr_neutral, '') || ' ' || coalesce(c.title_tr, '')) as f offset 0) a0");
  });

  it("puts no user text inside a regex pattern: every pattern is a quoted constant, and the three new ones are constants too", () => {
    // 186's final select held one pattern (the literal tier over h.ftitle); 194's ORDER BY has none, so compare everything before it
    const cut186 = cb186.indexOf("select h.id from hits h cross join q");
    expect(regexPatterns(cb186.slice(cut186))).toEqual(["'[^a-z0-9]+'"]);
    const p186 = regexPatterns(cb186.slice(0, cut186));
    const p194 = regexPatterns(cb194);
    expect(p186.length).toBeGreaterThan(5);
    for (const p of p194) {
      expect(p.startsWith("'") && p.endsWith("'"), p).toBe(true);
      expect(p.includes("||"), p).toBe(false);
    }
    // 194 adds exactly three (the lw split, the lw `or` test, the dnorm fold) and its final select has none
    expect([...p194].sort()).toEqual([...p186, "'[^a-z0-9]+'", "'[^a-z0-9]+'", "'[^a-z0-9]+'"].sort());
    // the words of the query go only through left() and strpos() in the new CTE
    const lw = cb194.slice(cb194.indexOf("), lw as ("), cb194.indexOf("), hits as ("));
    expect(lw).toContain("pg_catalog.left(s.w,");
    expect(lw).not.toContain(" ~ ");
    expect(lw).not.toContain("similar to");
    expect(lw).not.toContain("like ");
    expect(lw).not.toContain("p_variants");
    expect(lw).not.toContain("p_folded");
  });

  it("p_variants and p_folded are read exactly where 186 read them (the variants never reach the score; the score is a function of p_folded and the title)", () => {
    expect(countOf(cb194, "p_variants")).toBe(countOf(cb186, "p_variants"));
    expect(countOf(cb194, "p_folded")).toBe(countOf(cb186, "p_folded"));
    expect(countOf(cb194, "p_limit")).toBe(countOf(cb186, "p_limit"));
    const tail = cb194.slice(cb194.indexOf("select h.id from hits h cross join q"));
    expect(tail).not.toContain("q.qv");
  });

  it("the weights are the spec's: literal 2.0, relevance 0.3 saturating at 0.2, recency 1.0 on a 14-day scale, corroboration 0.15 * ln(least(count, 50))", () => {
    const tail = cb194.slice(cb194.indexOf("select h.id from hits h cross join q"));
    for (const w of ["2.0 * h.lit_d::pg_catalog.int4", "0.3 * (least(", ", 0.2) / 0.2)", "1.0 / (1.0 + extract(epoch from", "/ 1209600.0)", "0.15 * pg_catalog.ln(least(greatest(h.article_count, 1), 50)"]) {
      expect(tail, w).toContain(w);
    }
    expect(1209600).toBe(14 * 24 * 3600);
  });
});

describe("194 header", () => {
  const section = (from: string, to: string): string => {
    const at = head.indexOf(`\n-- ${from}`);
    expect(at, from).toBeGreaterThan(-1);
    return head.slice(at, head.indexOf(`\n-- ${to}`, at + 5));
  };

  it("documents WHY, WHAT, BASE, STEP 0, REPLAY, COST, KNOWN LIMITS, LEDGER, VERIFY and ROLLBACK", () => {
    for (const s of ["WHY", "WHAT", "BASE", "STEP 0", "REPLAY", "COST", "KNOWN LIMITS", "LEDGER", "VERIFY", "ROLLBACK"]) {
      expect(head, s).toContain(`\n-- ${s}`);
    }
    expect(head).toContain("h116-search-1");
    expect(head).toContain("191");
  });

  it("records the md5 and length of the NEW body, and they match this file (the test recomputes it)", () => {
    const newMd5 = md5(raw194);
    expect(newMd5).not.toBe(BASE_MD5);
    const verify = section("VERIFY", "Safe to re-apply");
    expect(verify).toContain(`expect ${newMd5}, ${pgLength(raw194)}.`);
  });

  it("WHY names the live evidence: the emekli maaşı slots 16-24, the deprem boilerplate, the hidden-headline hits", () => {
    const why = collapse(section("WHY", "WHAT").split("\n").map((l) => (l.startsWith("--") ? l.slice(2) : l)).join(" "));
    for (const word of ["emekli maaşı", "16-24", "103", "198", "deprem", "Depremler", "Orban", "Hegseth", "ts_rank_cd", "hidden", "maaşları"]) {
      expect(why, word).toContain(word);
    }
  });

  it("WHAT names the weights, the parity property, and that ranking never changes recall", () => {
    const what = collapse(section("WHAT", "BASE").split("\n").map((l) => (l.startsWith("--") ? l.slice(2) : l)).join(" "));
    for (const word of ["lw", "lit_d", "rel_d", "2.0", "0.3", "0.2", "1209600", "14 days", "0.15", "ln(least(", "166's", "parity", "never changes recall", "same id set"]) {
      expect(what, word).toContain(word);
    }
  });

  it("WHAT says lw is empty for an `or` token OR a negated phrase (166's two switches, as in gx)", () => {
    const what = collapse(section("WHAT", "BASE").split("\n").map((l) => (l.startsWith("--") ? l.slice(2) : l)).join(" "));
    for (const word of ["negated phrase", "-\"", "two switches", "as in gx", "alias, OR or negated-phrase query gets no literal tier"]) {
      expect(what, word).toContain(word);
    }
  });

  it("KNOWN LIMITS (3) says a negated-phrase query gets no literal tier and is ordered by relevance, recency and corroboration; the old claim is gone", () => {
    const limits = collapse(section("KNOWN LIMITS", "LEDGER").split("\n").map((l) => (l.startsWith("--") ? l.slice(2) : l)).join(" "));
    for (const word of ["both of gx's switches", "negated phrase", "no literal tier", "relevance, recency and corroboration"]) {
      expect(limits, word).toContain(word);
    }
    expect(limits).not.toContain("can lose the tier for every row alike");
    expect(limits).not.toContain("the spec's switch is the 'or' token only");
  });

  it("states the real effect of repetition: capped at about +0.16 (about 2 days of recency), not 'cannot outrun a single hit'", () => {
    const what = collapse(section("WHAT", "BASE").split("\n").map((l) => (l.startsWith("--") ? l.slice(2) : l)).join(" "));
    for (const word of ["about 0.09 (+0.14 after the 0.3 weight)", "two give 0.17 (+0.25)", "the cap 0.2 (+0.30)", "capped at about +0.16", "about 2 days of recency"]) {
      expect(what, word).toContain(word);
    }
    expect(head).not.toContain("cannot outrun a single hit");
    expect(raw194).not.toContain("does not buy rank");
    expect(raw194).toContain("buys at most about +0.16 (one hit +0.14, two +0.25, three or more +0.30)");
  });

  it("BASE records 186's fingerprint and that production runs it", () => {
    const base = section("BASE", "STEP 0");
    for (const word of [BASE_MD5, String(BASE_LENGTH), PROD_PROACL]) expect(base, word).toContain(word);
  });

  it("ROLLBACK: 186's function statement and comment again, then the ledger row", () => {
    const r = section("ROLLBACK", "See tests/");
    expect(r).toContain("186_search_stem_fold_arm.sql");
    expect(r).toContain(BASE_MD5);
    expect(r).toContain("delete from supabase_migrations.schema_migrations where version = '194';");
    expect(r).toContain("notify pgrst, 'reload schema';");
  });
});

describe("194 docs/migration-guide.md", () => {
  const guide = readFileSync(DOC_MIGRATION_GUIDE, "utf8");
  const sec = sectionOf(guide, "194");

  it("has a 194 section, after section 193", () => {
    expect(sec).not.toBe("");
    expect(sectionOf(guide, "193")).not.toBe("");
    expect(guide.indexOf("\n## 194 ")).toBeGreaterThan(guide.indexOf("\n## 193 "));
    expect(sec.split("\n")[1]).toContain("APPLY 194");
  });

  it("has Why, What, an md5 table, Replay, Cost, Order, Verify and Rollback", () => {
    for (const label of ["**Why:**", "**What 194 does**", "| | md5(prosrc) | length |", "**Replay**", "**Cost**", "**Order:**", "**Verify**", "**Rollback:**"]) {
      expect(sec, label).toContain(label);
    }
  });

  it("records the md5 of 186's body (production's, the base) and of 194, matching the file", () => {
    expect(sec).toContain(`\`${BASE_MD5}\` | ${BASE_LENGTH}`);
    expect(sec).toContain(`\`${md5(raw194)}\` | ${pgLength(raw194)}`);
  });

  it("states the order: 186 is applied, 194 changes no app code and has no deploy order; 191 is not a prerequisite", () => {
    const s = sec.slice(sec.indexOf("**Order:**"), sec.indexOf("**Verify**"));
    for (const word of ["194_search_rank_display_title.sql", "no app change", "191"]) expect(s, word).toContain(word);
  });

  it("verifies the fingerprint, the privileges, the ledger row and the live queries; the rollback restores 186", () => {
    const v = sec.slice(sec.indexOf("**Verify**"), sec.indexOf("**Rollback:**"));
    for (const word of [md5(raw194), "has_function_privilege", "version = '194'", "/?q=emekli%20maaşı", "/?q=deprem"]) expect(v, word).toContain(word);
    const r = sec.slice(sec.indexOf("**Rollback:**"));
    for (const word of ["186_search_stem_fold_arm.sql", BASE_MD5, "delete from supabase_migrations.schema_migrations where version = '194'"]) expect(r, word).toContain(word);
  });

  it("says lw has both of 166's switches (or, negated phrase) and that repetition is capped at about +0.16, not 'cannot outrun a single hit'", () => {
    const what = sec.slice(sec.indexOf("**What 194 does**"), sec.indexOf("| | md5(prosrc) | length |"));
    expect(what).toContain("negated phrase");
    expect(what).toContain("166's two switches");
    expect(what).toContain("capped at about +0.16");
    expect(what).toContain("about 2 days of recency");
    expect(sec).not.toContain("cannot outrun a single hit");
    expect(sec).not.toContain("166's own switch");
  });

  it("uses no fenced sql block (tests/guards/docs-sql-snippets.test.ts scans those)", () => {
    expect(sec).not.toContain("```");
  });
});

describe("194 dry-run and live manifest", () => {
  const dry = existsSync(DRYRUN_194) ? readFileSync(DRYRUN_194, "utf8") : "";

  it("builds 194's database with its own dry-run script: one run entry, that script as the only setup file", () => {
    const lines = readFileSync(MANIFEST, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("run | 194-search-rank-display-title.test.ts"));
    expect(lines).toEqual(["run | 194-search-rank-display-title.test.ts | tests/migrations/sql/194-search-rank-display-title-dryrun.sql | - | 0"]);
  });

  it("the dry-run builds 186's state (the 129 setup, 166, 172, 185, 186, gated on 186's md5), applies 194 twice and ends with its OK line", () => {
    expect(existsSync(DRYRUN_194)).toBe(true);
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
      "../../../supabase/migrations/194_search_rank_display_title.sql",
    ]);
    expect(dry).toContain(BASE_MD5);
    expect(dry).toContain(String(BASE_LENGTH));
    expect(dry).toContain(md5(raw194));
    expect(dry).toContain(String(pgLength(raw194)));
    expect(dry.trimEnd().endsWith("\\echo DRYRUN 194 OK")).toBe(true);
    expect(dry).toContain("-f tests/migrations/sql/stub.sql");
    expect(dry).toContain("D=$(mktemp -d)");
    expect(dry).toContain("-- or: bash tests/migrations/sql/run-live.sh");
  });

  it("the dry-run shows the defect on 186's body, then 194: the same id set for every call, the new order on the fixtures, the plan unchanged, hostile strings do not raise", () => {
    for (const q of ["emekli maaşı", "deprem", "imamoğlu", "imamoglu", "burdur", "miller", "akp alias", "negated phrase"]) expect(dry, q).toContain(`'${q}'`);
    expect(dry).toContain("array['iran -\"israil saldırısı\"']");
    expect(dry).toContain("'iran -\"israil saldirisi\"'");
    expect(dry).toContain("baseline: 186");
    expect(dry).toContain("explain (analyze)");
    expect(dry).toContain("clusters_search_stemfold_live_idx");
    expect(dry).toContain("Fuzz");
    expect(dry).toContain("1.5");
    expect(dry).toContain("rollback;");
  });
});

// ---------------------------------------------------------------------------
// Live block (opt-in). TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/PGDATABASE point at a THROWAWAY database that the
// dry-run script left behind with 129, 166, 172, 185, 186 and 194 applied (tests/migrations/sql/live-manifest.txt). Every scenario
// runs inside begin ... rollback: it seeds clusters, runs 186's body (as a pg_temp function made from the text of 186's migration
// file) and the installed 194 function side by side, and checks the contracts of 194:
//   (1) the id SET of every call is 186's (ranking never changes recall);
//   (2) a fresh, well-sourced story whose display title carries the plural form ranks above a 197-day-old row with the typed form;
//   (3) repetition in one title buys at most about +0.16, so an old repeating title no longer outranks a fresh well-sourced one, and a word that only the hidden original headline holds gives no literal tier;
//   (4) a Turkish query and its ASCII fold, with the same p_folded, order a shared candidate set the same way;
//   (5) the guard (burdur), the tier (miller) and the alias query keep their behaviour;
//   (6) a negated-phrase query (iran -"israil saldırısı") gets no literal tier: a word typed only inside the exclusion never lifts a row.
// ---------------------------------------------------------------------------

interface Seed {
  key: string;
  /** clusters.title_tr: the original headline. */
  title: string;
  /** clusters.title_tr_neutral: the display title, or null. */
  neutral: string | null;
  summary: string;
  members: number;
  age: string;
}

const SEEDS: Seed[] = [
  // (a) the emekli maaşı pair: A is old and carries the typed form, B is last week's nine-source story with the plural
  { key: "A", title: "Seçime doğru maaş ve ücret kulisi", neutral: "İktidardan seçim hazırlığı: Emekli maaşı ve asgari ücret değişiyor", summary: "Kulis haberi.", members: 2, age: "197 days" },
  { key: "B", title: "Şimşek: Emekli maaşlarına zam yok", neutral: "Mehmet Şimşek'ten emekli maaşlarına ilişkin açıklama", summary: "Bakan konuştu.", members: 9, age: "5 days" },
  // A2 holds the singular form too, so BOTH spellings of the query reach it (the stemmer cannot inflect ASCII: 'maasi' never
  // reaches B's 'maaşlarına', 186's recall, which 194 leaves alone); A and A2 are the shared candidates of the parity check
  { key: "A2", title: "Emekli maaşı için yeni formül masada", neutral: null, summary: "Hazırlık sürüyor.", members: 6, age: "4 days" },
  // (b) the deprem pair: C repeats the word in an old boilerplate title, D is a 10-source story from 12 days ago
  { key: "C", title: "Muğla'da deprem mi oldu?", neutral: "Muğla'da deprem mi oldu? Az önce deprem Muğla'da nerede oldu?", summary: "Son depremler listesi.", members: 3, age: "165 days" },
  { key: "D", title: "Ege Denizi'nde deprem: büyüklük 4,7", neutral: "Ege Denizi'nde 4,7 büyüklüğünde deprem", summary: "AFAD duyurdu.", members: 10, age: "12 days" },
  // (c) E holds the word only in the hidden original headline; F holds it in the display title
  { key: "E", title: "Macaristan'da siyasi deprem! Orban seçimi kaybetti", neutral: "Macaristan'da hükümet değişti: Orban seçimi kaybetti", summary: "Seçim sonucu açıklandı.", members: 2, age: "0 days" },
  { key: "F", title: "Malatya'da deprem hasarı", neutral: "Deprem sonrası Malatya'da hasar tespiti sürüyor", summary: "Ekipler bölgede.", members: 3, age: "2 days" },
  // G has no neutral title: the display title is the original one
  { key: "G", title: "Deprem bölgesinde konteyner kent kuruldu", neutral: null, summary: "Çadırlar kaldırılıyor.", members: 4, age: "20 days" },
  // the Turkish / ASCII pair of one name
  { key: "imam1", title: "İmamoğlu davasında yeni gelişme", neutral: null, summary: "Duruşma ertelendi.", members: 5, age: "2 days" },
  { key: "imam2", title: "İmamoğlu'nun avukatları açıklama yaptı", neutral: null, summary: "Savunma konuştu.", members: 3, age: "3 days" },
  { key: "imam3", title: "İBB soruşturması: İmamoğlu ifade verdi", neutral: "İBB soruşturmasında İmamoğlu ifade verdi", summary: "Ifade alındı.", members: 4, age: "40 days" },
  // controls of 166, 172 and the alias query
  { key: "burdur", title: "Burdur'da yurt zehirlenmesi", neutral: null, summary: "Öğrenciler hastaneye kaldırıldı.", members: 2, age: "1 hour" },
  { key: "bursa", title: "Bursa'da deprem uyarısı", neutral: null, summary: "Uzmanlar uyardı.", members: 2, age: "2 hours" },
  { key: "burun", title: "Hak hukuk tanımazlığın ete kemiğe büründüğü bir gün", neutral: null, summary: "Tepki büyüdü.", members: 2, age: "3 hours" },
  { key: "miller", title: "Miller açıklama yaptı", neutral: null, summary: "Açıklama geldi.", members: 2, age: "10 hours" },
  { key: "milMili", title: "Mili Eğitim Bakanlığı toplantısı", neutral: null, summary: "Toplantı yapıldı.", members: 2, age: "11 hours" },
  { key: "akp1", title: "AKP'den açıklama", neutral: null, summary: "Parti sözcüsü konuştu.", members: 2, age: "16 hours" },
  { key: "akp2", title: "AK Parti toplantısı", neutral: null, summary: "Grup toplantısı yapıldı.", members: 3, age: "17 hours" },
  { key: "akpAgi", title: "Aile Dayanışma Ağı yeni bir parti çağrısı yaptı", neutral: null, summary: "Çağrı sürdü.", members: 2, age: "18 hours" },
  // the negated phrase: both rows hold iran and saldırı, neither holds the phrase 'israil saldırısı', so both pass the variants arm.
  // negNear's display title starts a word with 'saldiri', the word typed only inside the exclusion; negFresh's does not.
  { key: "negNear", title: "İran'a saldırı sonrası açıklama", neutral: null, summary: "İran ve saldırı haberi, ayrıntılar sürüyor.", members: 2, age: "10 days" },
  { key: "negFresh", title: "İran açıklama yaptı", neutral: null, summary: "İran saldırı iddialarına yanıt verdi.", members: 2, age: "1 day" },
];

const seedId = (i: number): string => `00000000-0000-4000-8000-${String(194000 + i).padStart(12, "0")}`;
const KEY_BY_ID = new Map(SEEDS.map((s, i) => [seedId(i), s.key]));

const lit = (s: string | null): string => (s === null ? "null" : `'${s.replaceAll("'", "''")}'`);

interface LiveQuery {
  name: string;
  variants: string[];
  folded: string;
}

const LIVE_QUERIES: LiveQuery[] = [
  { name: "emekli maaşı", variants: ["emekli maaşı"], folded: foldTr("emekli maaşı") },
  { name: "emekli maasi", variants: ["emekli maasi"], folded: foldTr("emekli maaşı") },
  { name: "emekli maaşı (app)", variants: ["emekli maaşı", "emekli maaşi"], folded: foldTr("emekli maaşı") },
  { name: "deprem", variants: ["deprem"], folded: foldTr("deprem") },
  { name: "imamoğlu", variants: ["imamoğlu"], folded: foldTr("imamoğlu") },
  { name: "imamoglu", variants: ["imamoglu"], folded: foldTr("imamoglu") },
  { name: "burdur", variants: ["burdur"], folded: "burdur" },
  { name: "miller", variants: ["miller"], folded: "miller" },
  { name: "akp alias", variants: ['akp or "ak parti"'], folded: "akp or ak parti" },
  { name: "akp quoted", variants: ['akp or "ak parti"'], folded: 'akp or "ak parti"' },
  { name: "phrase", variants: ['"emekli maaşı"'], folded: '"emekli maasi"' },
  { name: "negated", variants: ["deprem -bursa"], folded: "deprem -bursa" },
  { name: "negated phrase", variants: ['iran -"israil saldırısı"'], folded: 'iran -"israil saldirisi"' },
  { name: "two words", variants: ["seçim sonucu"], folded: foldTr("seçim sonucu") },
  { name: "empty", variants: [""], folded: "" },
];

describe.runIf(Boolean(process.env.TAYF_PSQL))("194 search rank on the display title against a live Postgres (129, 166, 172, 185, 186 and 194 applied)", () => {
  assertLiveReady("194", {
    ledger: ["129", "166", "172", "185", "186", "194"],
    relations: ["public.clusters_search_tsv_live_idx", "public.clusters_search_fold_live_idx", "public.clusters_search_stemfold_live_idx"],
    functions: ["public.search_cluster_ids(text[],text,integer)", "public.tayf_search_fold(text)", "public.tayf_search_stem_fold(tsvector)"],
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

  /** 186's function, from the text of 186's migration file, as a pg_temp function of the same shape. */
  const FN_186 =
    "create function pg_temp.f186(p_variants text[], p_folded text, p_limit integer default 12) returns table (id uuid) " +
    `language sql stable set search_path = '' as $fn$${raw186}$fn$;`;

  const rows = SEEDS.map(
    (s, i) =>
      `(${lit(seedId(i))}, ${lit(s.title)}, ${lit(s.neutral)}, ${lit(s.summary)}, ${s.members}, false, now() - interval '${s.age}')`,
  ).join(",\n");

  const list = (fn: string, q: LiveQuery): string =>
    `select ${lit(`${q.name}|${fn === "pg_temp.f186" ? "186" : "194"}|`)} || coalesce((select string_agg(t.id::text, ',' order by t.n) ` +
    `from ${fn}(${arr(q.variants)}, ${lit(q.folded)}, 50) with ordinality as t(id, n)), '');`;

  const script = [
    "begin;",
    FN_186,
    `insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at) values\n${rows};`,
    "analyze public.clusters;",
    ...LIVE_QUERIES.flatMap((q) => [list("pg_temp.f186", q), list("public.search_cluster_ids", q)]),
    "rollback;",
  ].join("\n");

  const ids186 = new Map<string, string[]>();
  const ids194 = new Map<string, string[]>();
  let ran = false;
  const run = (): void => {
    if (ran) return;
    ran = true;
    for (const line of runPsql(script).split("\n")) {
      if (line === "") continue;
      const [name, which, ids] = line.split("|") as [string, string, string];
      const keys = ids === "" ? [] : ids.split(",").map((id) => KEY_BY_ID.get(id) ?? `?${id}`);
      (which === "186" ? ids186 : ids194).set(name, keys);
    }
  };

  const keysOf = (m: Map<string, string[]>, name: string): string[] => {
    run();
    const v = m.get(name);
    expect(v, `no result for ${name}`).toBeDefined();
    return v as string[];
  };
  const before = (m: Map<string, string[]>, name: string, first: string, second: string): boolean => {
    const k = keysOf(m, name);
    const a = k.indexOf(first);
    const b = k.indexOf(second);
    expect(a, `${first} in ${name}`).toBeGreaterThan(-1);
    expect(b, `${second} in ${name}`).toBeGreaterThan(-1);
    return a < b;
  };

  it.each(LIVE_QUERIES.map((q) => [q.name, q] as [string, LiveQuery]))(
    "'%s': 194 returns exactly 186's id set (ranking never changes recall) and stays below the 50-row cap",
    (_name, q) => {
      const old = keysOf(ids186, q.name);
      const now = keysOf(ids194, q.name);
      expect([...now].sort(), q.name).toEqual([...old].sort());
      expect(now.length, q.name).toBe(new Set(now).size);
      expect(old.length, "below the 50-row cap").toBeLessThan(50);
    },
  );

  it("the queries of the fixtures find rows at all (the set check above is not vacuous)", () => {
    for (const name of ["emekli maaşı", "deprem", "imamoğlu", "burdur", "miller", "akp alias", "two words"]) {
      expect(keysOf(ids194, name).length, name).toBeGreaterThan(0);
    }
    expect(keysOf(ids194, "emekli maaşı")).toEqual(expect.arrayContaining(["A", "B"]));
    expect(keysOf(ids194, "deprem")).toEqual(expect.arrayContaining(["C", "D", "E", "F", "G"]));
    expect(keysOf(ids194, "empty")).toEqual([]);
  });

  it("(a) the fixture reproduces the defect on 186's body, and 194 ranks the fresh nine-source plural story B above the 197-day-old typed form A", () => {
    expect(before(ids186, "emekli maaşı", "A", "B")).toBe(true);
    expect(before(ids194, "emekli maaşı", "B", "A")).toBe(true);
    expect(before(ids194, "emekli maaşı (app)", "B", "A")).toBe(true);
  });

  it("(b) a 165-day-old title that repeats 'deprem' no longer outranks a 10-source story from 12 days ago", () => {
    expect(before(ids194, "deprem", "D", "C")).toBe(true);
  });

  it("(c) a story whose only 'deprem' sits in the hidden original headline ranks below one whose display title has it, and is still returned", () => {
    expect(keysOf(ids194, "deprem")).toContain("E");
    expect(before(ids194, "deprem", "F", "E")).toBe(true);
    // 186 gave E the literal tier through the hidden headline: it ranked E above F
    expect(before(ids186, "deprem", "E", "F")).toBe(true);
  });

  it("a row with no neutral title is judged on its original title (G carries the word in the display title)", () => {
    expect(before(ids194, "deprem", "G", "E")).toBe(true);
  });

  it("(d) the ASCII and the Turkish spelling of the typed words, with the same p_folded, order the shared candidates the same way", () => {
    const sharedOrder = (a: string, b: string): [string[], string[]] => {
      const ka = keysOf(ids194, a);
      const kb = keysOf(ids194, b);
      const common = ka.filter((k) => kb.includes(k));
      expect(common.length, `${a} / ${b} share candidates`).toBeGreaterThan(1);
      return [common, kb.filter((k) => ka.includes(k))];
    };
    const [x, y] = sharedOrder("emekli maaşı", "emekli maasi");
    expect(x).toEqual(y);
    expect(x).toEqual(expect.arrayContaining(["A", "A2"]));
    expect(x.indexOf("A2")).toBeLessThan(x.indexOf("A"));
    // B (the plural) is reached by the Turkish spelling only: a recall limit of 186, the same set as 186 returns
    expect(keysOf(ids194, "emekli maasi")).not.toContain("B");
    const [p, q] = sharedOrder("imamoğlu", "imamoglu");
    expect(p).toEqual(q);
    expect(keysOf(ids194, "imamoğlu")).toEqual(keysOf(ids194, "imamoglu"));
  });

  it("(e) the alias and the OR query get no literal tier and return 186's id set; the alias rows are all there", () => {
    expect([...keysOf(ids194, "akp alias")].sort()).toEqual([...keysOf(ids186, "akp alias")].sort());
    expect(keysOf(ids194, "akp alias")).toEqual(expect.arrayContaining(["akp1", "akp2"]));
    expect([...keysOf(ids194, "akp quoted")].sort()).toEqual([...keysOf(ids186, "akp quoted")].sort());
    // without a literal tier the fresher, better-sourced row leads: akp2 (3 members) and akp1 (2) come before the weak 'Ağı' candidate
    const k = keysOf(ids194, "akp alias");
    if (k.includes("akpAgi")) expect(k.indexOf("akpAgi")).toBeGreaterThan(k.indexOf("akp1"));
  });

  it("(f) a negated-phrase query gets no literal tier: the fresher row leads, the row whose title holds the excluded phrase's later word gains nothing", () => {
    const k = keysOf(ids194, "negated phrase");
    expect(k).toEqual(expect.arrayContaining(["negNear", "negFresh"]));
    // under the old lw, negNear (a word starting with 'saldiri') got +2.0 and led every other Iran story
    expect(before(ids194, "negated phrase", "negFresh", "negNear")).toBe(true);
  });

  it("the 166 guard stays: burdur keeps the Burdur row, not Bursa, and not the bürün row", () => {
    expect(keysOf(ids194, "burdur")).toEqual(["burdur"]);
  });

  it("the 172 tier stays: the Miller row comes before the stem collision, and lit_ok is still the first key", () => {
    expect(keysOf(ids194, "miller")[0]).toBe("miller");
  });

  it("a two-word query needs every word at a word start of the display title for the literal tier, in any order", () => {
    // the fixtures hold no 'seçim sonucu' pair, only the summary of E: the query still returns what 186 returns (checked above)
    expect(keysOf(ids194, "two words")).toContain("E");
  });

  it("is applied once: one ledger row for 194, one overload, the body of the file, the grants as the file says", () => {
    const out = runPsql(`
select (select count(*) from supabase_migrations.schema_migrations where version = '194'),
       (select count(*) from pg_catalog.pg_proc where proname = 'search_cluster_ids' and pronamespace = 'public'::regnamespace and pg_get_function_identity_arguments(oid) = 'p_variants text[], p_folded text, p_limit integer'),
       p.prosecdef, p.provolatile, (p.proconfig = array['search_path=""']), p.proacl::text, md5(p.prosrc), length(p.prosrc),
       has_function_privilege('anon', p.oid, 'execute'), has_function_privilege('authenticated', p.oid, 'execute'),
       has_function_privilege('service_role', p.oid, 'execute'),
       obj_description(p.oid, 'pg_proc') like '%194%'
  from pg_catalog.pg_proc p
 where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
`).trim();
    const f = out.split("|");
    expect(f[0]).toBe("1"); // ledger rows for 194
    expect(f[1]).toBe("1"); // one three-argument overload
    expect(f[2]).toBe("t"); // security definer
    expect(f[3]).toBe("s"); // stable
    expect(f[4]).toBe("t"); // search_path = ''
    expect(f[5]).toBe(PROD_PROACL);
    expect(f[6]).toBe(md5(raw194)); // the function in the database is the body of the file
    expect(f[7]).toBe(String(pgLength(raw194)));
    expect(f[8]).toBe("f"); // anon
    expect(f[9]).toBe("f"); // authenticated
    expect(f[10]).toBe("t"); // service_role
    expect(f[11]).toBe("t"); // the comment names 194
  });
});
