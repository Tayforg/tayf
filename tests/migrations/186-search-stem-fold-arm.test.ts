import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { foldTr } from "@/lib/clusters/turkish-query";
import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Contract test for migration 186 ("search stem-fold arm"), h96-search-2 (hunt 96). 186 is numbered after 185 (h96-search-1);
// 184 is another branch's.
//
// The folded arm of 129 stems ASCII text and the Turkish stemmer cannot inflect ASCII, while the stored stems keep their Turkish
// letters, so 'siginak' found 6 stories on production against 14 for 'sığınak' (yurt disi 69 against 215). 186 adds, all additive:
//   * public.tayf_search_stem_fold(tsvector): the stored stems folded to ASCII (IMMUTABLE, PARALLEL SAFE, search_path '',
//     service_role only), the helper the index calls;
//   * clusters_search_stemfold_live_idx: a partial GIN over it, on the literal live predicate of 083 and 129;
//   * search_cluster_ids(text[], text, integer) replaced with 185's body plus ONE CTE (qs, the stem query) and ONE UNION arm in
//     cand. The guard, the tier, the 1000-row cap and the ORDER BY are 185's, byte for byte.
//
// This file pins, without a database: the file, ledger and transaction, the helper and the index text, that 185's body is the base
// (md5 pinned), a derive-and-compare of 186's body against 185's, the header (including the measured sizes and counts), the docs
// section, the dry-run and the live-manifest entry. The opt-in live block (TAYF_PSQL) runs 185's body and 186's function side by
// side on fixtures: an ASCII query gets the rows of its Turkish twin, everything else keeps 185's list.
//
// No regular expression is applied to quoted SQL literals in this file (CodeQL js/redos): the SQL is scanned with indexOf and
// character loops.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const FILE_186 = "186_search_stem_fold_arm.sql";
const MIGRATION_186 = resolve(MIGRATIONS_DIR, FILE_186);
const MIGRATION_185 = resolve(MIGRATIONS_DIR, "185_search_sibling_variants.sql");
const DRYRUN_186 = resolve(ROOT, "tests", "migrations", "sql", "186-search-stem-fold-arm-dryrun.sql");
const MANIFEST = resolve(ROOT, "tests", "migrations", "sql", "live-manifest.txt");
const DOC_MIGRATION_GUIDE = resolve(ROOT, "docs", "migration-guide.md");

/** md5 and length of 185's function body: the base of 186 (185 is not on production yet; production still runs 172's). */
const BASE_MD5 = "b8d0aa3035e001d17750d94f5a08c9c2";
const BASE_LENGTH = 13324;
/** md5 and length of production's prosrc today (172's body, read-only 2026-11-09). */
const PROD_MD5 = "192218b7b6a56b3c8fcc48d5e0610a2c";
const PROD_LENGTH = 12913;
const PROD_PROACL = "{postgres=X/postgres,service_role=X/postgres}";

const LEDGER_STMT =
  "insert into supabase_migrations.schema_migrations (version, name) values ('186', '186_search_stem_fold_arm') on conflict do nothing;";
const REVOKE_FN = "revoke all on function public.search_cluster_ids(text[], text, integer) from public, anon, authenticated;";
const GRANT_FN = "grant execute on function public.search_cluster_ids(text[], text, integer) to service_role;";
const REVOKE_HELPER = "revoke all on function public.tayf_search_stem_fold(tsvector) from public, anon, authenticated;";
const GRANT_HELPER = "grant execute on function public.tayf_search_stem_fold(tsvector) to service_role;";
const INDEX_STMT =
  "create index if not exists clusters_search_stemfold_live_idx on public.clusters using gin ( public.tayf_search_stem_fold(search_tsv)) where not is_archived and article_count >= 2;";
const HELPER_HEADER =
  "create or replace function public.tayf_search_stem_fold(p tsvector) returns tsvector language sql immutable parallel safe set search_path = ''";
const QS_CTE =
  "), qs as ( select case when pg_catalog.numnode(q.qf) = 0 then null else pg_catalog.to_tsquery('pg_catalog.simple'::pg_catalog.regconfig, public.tayf_search_fold(q.qf::pg_catalog.text)) end as qs from q ), cand as (";
const ARM3 =
  "union select c.id, c.updated_at from public.clusters c where public.tayf_search_stem_fold(c.search_tsv) @@ (select qs from qs) and not c.is_archived and c.article_count >= 2 ), kept as (";

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
let fn186 = "";
let body186 = "";
let cb186 = "";
/** The body as the database stores it (prosrc): comments included. */
let raw186 = "";

if (existsSync(MIGRATION_186)) {
  sql = readFileSync(MIGRATION_186, "utf8");
  code = stripComments(sql);
  head = sql.slice(0, sql.indexOf("\nbegin;"));
  fn186 = functionBlock(code, "search_cluster_ids");
  body186 = fnBody(fn186);
  cb186 = collapse(body186);
  raw186 = fnBody(functionBlock(sql, "search_cluster_ids"));
}
const sql185 = readFileSync(MIGRATION_185, "utf8");
const fn185 = functionBlock(stripComments(sql185), "search_cluster_ids");
const cb185 = collapse(fnBody(fn185));
const raw185 = fnBody(functionBlock(sql185, "search_cluster_ids"));

/** The helper's statement as the migration has it, without comments. */
const helperBlock = (): string => functionBlock(code, "tayf_search_stem_fold");

describe("186 file, ledger and structure", () => {
  it("exists with the exact name, and no other migration claims the number 186", () => {
    expect(existsSync(MIGRATION_186)).toBe(true);
    const claimed = readdirSync(MIGRATIONS_DIR).filter((n) => n.startsWith("186_"));
    expect(claimed).toEqual([FILE_186]);
  });

  it("contains the ledger insert for '186' with on conflict do nothing, the last statement before commit", () => {
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

  it("is additive only: two function replaces, one index, one guard, the ledger row; no drop, alter, truncate, update, delete, table or trigger", () => {
    const bare = sansStrings(code).toLowerCase();
    for (const bad of ["drop ", "alter ", "truncate", "delete ", "update ", "create table", "create unique", "create trigger", "create view", "create extension"]) {
      expect(bare.includes(bad), bad).toBe(false);
    }
    expect(countOf(bare, "create or replace function")).toBe(2);
    expect(countOf(bare, "create function")).toBe(0);
    expect(countOf(bare, "create index")).toBe(1);
    expect(countOf(bare, "insert into ")).toBe(1);
    expect(bare).toContain("insert into supabase_migrations.schema_migrations");
  });

  it("grants no table, sequence or schema privilege, and exactly two function grants, both to service_role", () => {
    const bare = sansStrings(code).toLowerCase();
    expect(bare).not.toContain("on table");
    expect(bare).not.toContain("on all tables");
    expect(bare).not.toContain("on sequence");
    expect(bare).not.toContain("on schema");
    const c = collapse(code);
    expect(countOf(c, "grant ")).toBe(2);
    expect(c).toContain(GRANT_HELPER);
    expect(c).toContain(GRANT_FN);
    expect(c).toContain(REVOKE_HELPER);
    expect(c).toContain(REVOKE_FN);
    expect(c.indexOf(REVOKE_HELPER)).toBeLessThan(c.indexOf(GRANT_HELPER));
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

  it("orders its objects: the invalid-index guard, the helper, the index, then the function (the index needs the helper, the function needs the index)", () => {
    const c = collapse(code);
    const at = (needle: string): number => {
      const i = c.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    expect(at("do $guard$")).toBeLessThan(at(HELPER_HEADER));
    expect(at(HELPER_HEADER)).toBeLessThan(at(INDEX_STMT));
    expect(at(INDEX_STMT)).toBeLessThan(at("create or replace function public.search_cluster_ids("));
  });
});

describe("186 invalid-index guard", () => {
  it("raises, before anything is created, when a CREATE INDEX CONCURRENTLY left the index invalid, and says how to repair it", () => {
    const c = collapse(code);
    const at = c.indexOf("do $guard$");
    const guard = c.slice(at, c.indexOf("$guard$;", at + 10));
    expect(guard).toContain("i.indisvalid = false");
    expect(guard).toContain("c.relname = 'clusters_search_stemfold_live_idx'");
    expect(guard).toContain("raise exception '186: invalid index left by an aborted CREATE INDEX CONCURRENTLY: %.");
    expect(guard).toContain("drop index concurrently <name>");
    expect(guard).toContain("186_search_stem_fold_arm.sql");
  });
});

describe("186 helper public.tayf_search_stem_fold(tsvector)", () => {
  it("is IMMUTABLE, PARALLEL SAFE, language sql, search_path '', not security definer, and returns tsvector", () => {
    const block = helperBlock();
    expect(collapse(fnHeader(block))).toBe(HELPER_HEADER);
    const h = collapse(fnHeader(block));
    expect(h).toContain("immutable");
    expect(h).toContain("parallel safe");
    expect(h).toContain("set search_path = ''");
    expect(h).not.toContain("security definer");
    expect(h).not.toContain("stable");
    expect(h).not.toContain("volatile");
  });

  it("folds the whole vector ONCE with 129's fold (the lexemes joined by chr(1)), splits, de-duplicates, drops an empty result, and builds the vector with array_to_tsvector", () => {
    const b = collapse(fnBody(helperBlock()));
    expect(b).toBe(
      "select pg_catalog.array_to_tsvector(array( select distinct x from pg_catalog.unnest(pg_catalog.string_to_array(public.tayf_search_fold(pg_catalog.array_to_string(pg_catalog.tsvector_to_array(p), pg_catalog.chr(1))), pg_catalog.chr(1))) as x where x <> ''))",
    );
    // database-1: the first body folded every lexeme twice (once to test it, once to keep it): one fold call, not two
    expect(countOf(b, "public.tayf_search_fold(")).toBe(1);
  });

  it("calls every catalog function with its schema (empty search_path)", () => {
    const bare = sansStrings(collapse(fnBody(helperBlock())));
    for (const name of ["array_to_tsvector", "unnest", "tsvector_to_array", "string_to_array", "array_to_string", "chr"]) {
      const at = bare.indexOf(`${name}(`);
      expect(at, name).toBeGreaterThanOrEqual(11);
      expect(bare.slice(at - 11, at), name).toBe("pg_catalog.");
    }
    expect(bare).toContain("public.tayf_search_fold(");
  });

  it("has a comment that names 186 and the index", () => {
    const c = collapse(code);
    const at = c.indexOf("comment on function public.tayf_search_stem_fold(tsvector) is");
    expect(at).toBeGreaterThan(-1);
    const comment = c.slice(at, c.indexOf("revoke all", at)).toLowerCase();
    for (const word of ["186", "clusters_search_stemfold_live_idx", "immutable", "service_role", "siginak"]) expect(comment, word).toContain(word);
  });
});

describe("186 index clusters_search_stemfold_live_idx", () => {
  it("is exactly: partial GIN over the helper of search_tsv, if not exists (a pre-built one is left alone)", () => {
    expect(collapse(code)).toContain(INDEX_STMT);
    // CREATE INDEX CONCURRENTLY cannot run in a transaction: the header's pre-build does it
    expect(countOf(sansStrings(code).toLowerCase(), "concurrently")).toBe(0);
  });

  it("its predicate is the literal predicate of the third arm and of the other two arms", () => {
    const predicate = "not is_archived and article_count >= 2";
    expect(INDEX_STMT).toContain(`where ${predicate};`);
    const withAlias = predicate.replaceAll("is_archived", "c.is_archived").replaceAll("article_count", "c.article_count");
    expect(ARM3).toContain(`and ${withAlias} ), kept as (`);
    const cand = cb186.slice(cb186.indexOf("), cand as ("), cb186.indexOf("), kept as ("));
    expect(countOf(cand, "and not c.is_archived and c.article_count >= 2")).toBe(3);
    expect(countOf(cand, "select c.id, c.updated_at from public.clusters c where")).toBe(3);
  });

  it("the header's pre-build runs the same helper and the same index, the dry-run too, with concurrently added", () => {
    const strip = (text: string): string => collapse(text.split("\n").map((l) => (l.startsWith("--") ? l.slice(2) : l)).join("\n"));
    const pre = head.slice(head.indexOf("-- (1) the helper"), head.indexOf("-- (3) the invalid-index check"));
    const flat = strip(pre);
    const helperAt = flat.indexOf("create or replace function public.tayf_search_stem_fold(");
    expect(helperAt).toBeGreaterThan(-1);
    const helperStmt = flat.slice(helperAt, flat.indexOf("$fn$;", flat.indexOf("$fn$", helperAt) + 4) + 5);
    expect(helperStmt).toBe(collapse(helperBlock()));
    expect(flat).toContain("begin; create or replace function public.tayf_search_stem_fold");
    expect(flat).toContain(`${REVOKE_HELPER} ${GRANT_HELPER} commit;`);
    const oneLine = INDEX_STMT.replace("( public.", "(public.").replace("create index if not exists", "create index concurrently if not exists");
    expect(flat).toContain(oneLine);
    const dry = collapse(readFileSync(DRYRUN_186, "utf8"));
    expect(dry).toContain(oneLine);
    expect(dry).toContain(helperStmt);
    expect(dry).toContain(`${REVOKE_HELPER} ${GRANT_HELPER} commit;`);
  });
});

describe("186 search_cluster_ids(text[], text, integer)", () => {
  it("is the only definition of it and has 185's (and 172's) signature: create or replace, no drop, no new overload", () => {
    expect(fn186.startsWith("create or replace function public.search_cluster_ids(p_variants text[], p_folded text, p_limit integer default 12)")).toBe(true);
    expect(countOf(code, "create or replace function public.search_cluster_ids(")).toBe(1);
  });

  it("has exactly 185's header: returns table (id uuid), language sql, stable, security definer, search_path ''", () => {
    expect(collapse(fnHeader(fn186))).toBe(collapse(fnHeader(fn185)));
    const h = collapse(fnHeader(fn186));
    expect(h).toContain("returns table (id uuid)");
    expect(h).toContain("language sql");
    expect(h).toContain("stable");
    expect(h).toContain("security definer");
    expect(h).toContain("set search_path = ''");
  });

  it("has a function comment that names the stem-fold arm and the migrations it builds on", () => {
    const c = collapse(code);
    const at = c.indexOf("comment on function public.search_cluster_ids(text[], text, integer) is");
    expect(at).toBeGreaterThan(-1);
    const comment = c.slice(at, c.indexOf("revoke all", at)).toLowerCase();
    for (const word of ["186", "185", "172", "166", "129", "stem-fold", "three separate index scans", "siginak", "p_folded"]) expect(comment, word).toContain(word);
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
    const bare = sansStrings(cb186);
    const catalog = [
      "left", "length", "strpos", "lower", "translate", "replace", "chr", "regexp_replace", "regexp_split_to_table", "substr",
      "ts_lexize", "ts_rank_cd", "to_tsvector", "websearch_to_tsquery", "plainto_tsquery", "to_tsquery", "numnode", "now", "btrim",
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

describe("186 body = 185's body plus the qs CTE and the third arm, nothing else", () => {
  it("185's body is the base: its md5 and length are the recorded ones, and production still runs 172's body (read-only, 2026-11-09)", () => {
    expect(md5(raw185)).toBe(BASE_MD5);
    expect(pgLength(raw185)).toBe(BASE_LENGTH);
    const at = head.indexOf("\n-- BASE AND ORDER");
    const base = head.slice(at, head.indexOf("\n-- STEP 0", at));
    for (const word of [BASE_MD5, String(BASE_LENGTH), PROD_MD5, String(PROD_LENGTH), "Apply 185 first"]) expect(base, word).toContain(word);
  });

  it("removing the qs CTE and the third arm, and restoring the comment line, gives 185's body character for character (comments included)", () => {
    const qsAt = raw186.indexOf("  ), qs as (\n");
    const candAt = raw186.indexOf("  ), cand as (\n");
    expect(qsAt, "qs CTE").toBeGreaterThan(-1);
    expect(candAt, "cand CTE").toBeGreaterThan(qsAt);
    let restored = raw186.slice(0, qsAt) + raw186.slice(candAt);
    const three = "    -- Three independent arms (the third is 186's), so a phrase in the variants arm (a quoted query)\n";
    const two = "    -- Two independent arms, so a phrase in the variants arm (a quoted query)\n";
    expect(restored.split(three).length).toBe(2);
    restored = restored.replace(three, two);
    const armAt = restored.indexOf("    union\n    -- 186: the stored stems folded to ASCII");
    const keptAt = restored.indexOf("  ), kept as (\n");
    expect(armAt, "third arm").toBeGreaterThan(-1);
    expect(keptAt).toBeGreaterThan(armAt);
    restored = restored.slice(0, armAt) + restored.slice(keptAt);
    expect(restored).toBe(raw185);
  });

  it("the qs CTE and the third arm are exactly these statements (comments stripped), in this place", () => {
    expect(cb186).toContain(QS_CTE);
    expect(cb186).toContain(ARM3);
    expect(countOf(cb186, "qs as (")).toBe(1);
    expect(cb186.indexOf("), q as (")).toBeLessThan(cb186.indexOf("), qs as ("));
    expect(cb186.indexOf("), qs as (")).toBeLessThan(cb186.indexOf("), cand as ("));
  });

  it("q (the variants, the folded query qf, lit), the first two arms, the guard, the tier and the ORDER BY are 185's text byte for byte", () => {
    // everything before the qs CTE, q included, is everything before 185's cand
    expect(cb186.slice(0, cb186.indexOf("), qs as ("))).toBe(cb185.slice(0, cb185.indexOf("), cand as (")));
    // the first two arms of cand are 185's cand (comment stripped), followed by the third
    const cand185 = cb185.slice(cb185.indexOf("), cand as ("), cb185.indexOf("), kept as ("));
    const cand186 = cb186.slice(cb186.indexOf("), cand as ("), cb186.indexOf("), kept as ("));
    expect(cand186).toBe(cand185 + ARM3.slice(0, ARM3.indexOf("), kept as (")));
    // everything from `kept` on (the 166 guard, top, the 172 tier, the ORDER BY and the limit)
    expect(cb186.slice(cb186.indexOf("), kept as ("))).toBe(cb185.slice(cb185.indexOf("), kept as (")));
  });

  it("q is untouched: six variants (185) and the phrase-free qf (129); qs reads qf and nothing else", () => {
    expect(countOf(cb186, "p_variants")).toBe(11);
    expect(countOf(cb186, "p_folded")).toBe(countOf(cb185, "p_folded"));
    expect(countOf(cb186, "p_limit")).toBe(countOf(cb185, "p_limit"));
    const qs = cb186.slice(cb186.indexOf("), qs as ("), cb186.indexOf("), cand as ("));
    expect(qs).not.toContain("p_variants");
    expect(qs).not.toContain("p_folded");
    expect(qs).toContain("q.qf");
    expect(qs).toContain("numnode(q.qf) = 0 then null");
    expect(qs).toContain("'pg_catalog.simple'::pg_catalog.regconfig");
  });

  it("puts no user text inside a regex pattern: the patterns are 185's constants (the new CTE and arm use none)", () => {
    const patterns = (s: string): string[] => {
      const out: string[] = [];
      for (const fnName of ["regexp_replace", "regexp_split_to_table"]) {
        let from = 0;
        for (;;) {
          const at = s.indexOf(`${fnName}(`, from);
          if (at < 0) break;
          out.push(s.slice(at, at + 160));
          from = at + 1;
        }
      }
      return out;
    };
    expect(patterns(cb186)).toEqual(patterns(cb185));
    const added = cb186.slice(cb186.indexOf("), qs as ("), cb186.indexOf("), cand as (")) + ARM3;
    expect(added).not.toContain("regexp");
    expect(added).not.toContain(" ~ ");
  });

  it("the guard still reads p_folded only and the tier is unchanged: the stem arm adds candidates, never a guard word", () => {
    expect(cb186).toContain("select public.tayf_search_fold(coalesce(p_folded, '')) as ff");
    expect(cb186).toContain("order by (case when h.lit_ok then 0 else 1 end),");
    expect(cb186).toContain("limit greatest(1, least(coalesce(p_limit, 12), 50));");
    expect(cb186).toContain("select k.id from kept k order by k.updated_at desc, k.id limit 1000");
  });
});

describe("186 header", () => {
  const section = (from: string, to: string): string => {
    const at = head.indexOf(`\n-- ${from}`);
    expect(at, from).toBeGreaterThan(-1);
    return head.slice(at, head.indexOf(`\n-- ${to}`, at + 5));
  };

  it("documents WHY, WHAT, BASE AND ORDER, STEP 0, INDEX SIZE, the pre-build, WRITE COST, KNOWN LIMITS, REPLAY, COST, LEDGER, VERIFY and ROLLBACK", () => {
    for (const s of ["WHY", "WHAT", "BASE AND ORDER", "STEP 0", "INDEX SIZE", "ORCHESTRATOR PRE-BUILD", "WRITE COST", "KNOWN LIMITS", "REPLAY", "COST", "LEDGER", "VERIFY", "ROLLBACK"]) {
      expect(head, s).toContain(`\n-- ${s}`);
    }
    expect(head).toContain("184 is another branch");
    expect(head).toContain("h96-search-2");
  });

  it("records the md5 and length of the NEW body, and they match this file (the test recomputes it)", () => {
    const newMd5 = md5(raw186);
    expect(newMd5).not.toBe(BASE_MD5);
    expect(newMd5).not.toBe(PROD_MD5);
    const verify = section("VERIFY", "Safe to re-apply");
    expect(verify).toContain(`expect ${newMd5}, ${pgLength(raw186)}.`);
  });

  it("WHY names the stemmer facts and the six Turkish-against-ASCII counts of production", () => {
    const why = section("WHY", "WHAT");
    for (const word of ["guvenligi -> guvenligi", "güvenliği -> güvenlik", "sığınak 14 vs siginak 6", "yurt dışı 215 vs yurt disi 69", "iç savaş 64 vs ic savas 24", "hırsızlık 38 vs hirsizlik 25", "güvenlik 1501 vs guvenlik 1134", "çocuk 872 vs cocuk 734", "57014"]) {
      expect(why, word).toContain(word);
    }
  });

  it("WHAT describes the helper, the index, qs, the third arm with the literal predicate, and that no Turkish-typed query gets a new row", () => {
    const what = section("WHAT", "BASE AND ORDER");
    for (const word of ["tayf_search_stem_fold", "IMMUTABLE", "PARALLEL SAFE", "service_role only", "clusters_search_stemfold_live_idx", "numnode(qf) = 0", "to_tsquery('simple'", "third arm", "copied literally", "166's guard", "a subset of arm 1", "U+0307"]) {
      expect(what, word).toContain(word);
    }
  });

  it("STEP 0 records the fingerprint of production, the sizes, the live row counts, the writer roles and the folding sample", () => {
    const s = section("STEP 0", "INDEX SIZE");
    for (const word of [PROD_MD5, String(PROD_LENGTH), PROD_PROACL, "8,224,768", "9,969,664", "49 MB", "32,552 of", "265,592", "7,114,640,531", "6785 MB", "postgres and service_role", "69,006", "68,907", "0.9986"]) {
      expect(s, word).toContain(word);
    }
  });

  it("INDEX SIZE states the estimate that decides the apply: about 7 MB (8 to 9 MB aged), 0.1% of the database, with the local basis", () => {
    const s = section("INDEX SIZE", "ORCHESTRATOR PRE-BUILD");
    for (const word of ["about 7 MB when built", "8 to 9 MB", "0.1% of the database", "375 MB", "6,938,624", "7,069,696", "7,430,144", "0.9 s there with the fold-once helper", "3.0 s with the first body", "about 4 s on production", "needs no extra disk"]) {
      expect(s, word).toContain(word);
    }
  });

  it("the pre-build has the three steps in order: the helper, the index CONCURRENTLY in autocommit, the invalid-index check", () => {
    const s = section("ORCHESTRATOR PRE-BUILD", "WRITE COST");
    const one = s.indexOf("-- (1) the helper");
    const two = s.indexOf("-- (2) the index");
    const three = s.indexOf("-- (3) the invalid-index check");
    expect(one).toBeGreaterThan(-1);
    expect(two).toBeGreaterThan(one);
    expect(three).toBeGreaterThan(two);
    expect(s).toContain("create index concurrently if not exists clusters_search_stemfold_live_idx");
    expect(s).toContain("not i.indisvalid");
    expect(s).toContain("57014");
    expect(s).toContain("55P03");
  });

  it("WRITE COST gives the cost per updated live row measured on production (read-only, inline body) and scaled, and the cue for the rollback (database-1)", () => {
    // the header wraps its lines: compare the prose with the comment markers removed and the whitespace collapsed
    const s = collapse(section("WRITE COST", "KNOWN LIMITS").split("\n").map((l) => (l.startsWith("--") ? l.slice(2) : l)).join(" "));
    for (const word of [
      "EVERY non-HOT update",
      "Measured on production, read-only",
      "the scan alone 0.37 s",
      "the first body (a fold per lexeme, twice) 12.4 s",
      "the fold-once body of this file 2.4 s",
      "about 370 microseconds per row against about 63 microseconds",
      "0 differ, 0 fold to an empty vector",
      "1,061,044 lexemes become 1,059,209",
      "281 ms without the index, 422 ms with it on this helper, 625 ms on the first body",
      "about 47 microseconds more per updated live row (115 with the first body)",
      "about 4 times slower",
      "about 190 microseconds more per updated live row",
      "about 540 for the first body",
      "about 4 s",
      "about 14 s with the first body",
      "VERIFY 7",
      "ROLLBACK block",
    ]) {
      expect(s, word).toContain(word);
    }
    // the first draft's local-only figures are gone
    expect(s).not.toContain("about 82 microseconds");
    expect(s).not.toContain("600 ms with the index, 355 ms without");
  });

  it("the helper description says the whole vector is folded ONCE (database-1)", () => {
    const at = head.indexOf("\n-- WHAT");
    const what = collapse(head.slice(at, head.indexOf("\n-- BASE AND ORDER", at)).split("\n").map((l) => (l.startsWith("--") ? l.slice(2) : l)).join(" "));
    for (const word of ["folds the whole vector ONCE", "joined with chr(1)", "one call of 129's fold", "A first body folded every lexeme twice", "about 6x slower on production", "the same vector on every live row"]) {
      expect(what, word).toContain(word);
    }
  });

  it("KNOWN LIMITS: base-form ASCII only, the folded-stem collisions (bürün, Ağı) with their numbers, the cap, no tier", () => {
    // the header wraps lines at 125 columns: compare the text with the comment markers removed and the whitespace collapsed
    const s = collapse(section("KNOWN LIMITS", "REPLAY").split("\n").map((l) => (l.startsWith("--") ? l.slice(2) : l)).join(" "));
    for (const word of ["base-form ASCII query only", "guvenligi", "bürün", "342 candidates instead of 341", "34 rows", "'Ağı' is stored as", "4 extra weak candidates", "1000-row candidate cap", "WRITE COST", "no tier"]) {
      expect(s, word).toContain(word);
    }
  });

  it("REPLAY: the six queries with their three arms, the Turkish twins, the ranked counts, and the controls identical", () => {
    const s = section("REPLAY", "COST");
    for (const row of [
      "siginak          0 /    6 /   14       6 ->   14",
      "yurt disi        0 /   69 /  215      69 ->  215",
      "ic savas         0 /   24 /   64      24 ->   64",
      "hirsizlik        0 /   25 /   38      25 ->   38",
      "guvenlik         0 / 1134 / 1501    1134 -> 1501",
      "cocuk            0 /  734 /  872     734 ->  872",
    ]) {
      expect(s, row).toContain(row);
    }
    for (const word of ["p_limit 50", "24 (SEARCH_LIMIT)", "16 id-range slices", "siginak 6 -> 14", "hirsizlik 25 -> 38", "identical top 24 AND identical 50-row list", "burdur 34", "miller 18", "bartın 32", "erdogan", "akp"]) {
      expect(s, word).toContain(word);
    }
  });

  it("COST: the local real-data measurement, 1.3x gate, the plan with the bitmap index scans, the worst case and the growth explained", () => {
    const s = section("COST", "LEDGER");
    for (const word of ["1.3x", "Bitmap Index Scan on clusters_search_stemfold_live_idx", "iran 36.45 -> 39.18 (1.07x)", "erdogan 29.74 -> 31.69 (1.07x)", "-qwxz", "78.49 -> 99.89 (1.27x)", "siginak 0.50 -> 0.78 (1.56x", "yurt disi 3.26 -> 9.39 (2.88x", "VERIFY 5"]) {
      expect(s, word).toContain(word);
    }
  });

  it("VERIFY checks the fingerprint, the helper's attributes and ACL, the index, the counts, the plan, the guard and the write cost", () => {
    const v = section("VERIFY", "Safe to re-apply");
    for (const word of ["has_function_privilege", "indisvalid", "clusters_search_stemfold_live_idx", "about 14", "about 215", "explain (analyze, buffers)", "Bitmap Index Scan", "burdur", "pg_stat_statements", "GET /?q=siginak"]) {
      expect(v, word).toContain(word);
    }
    expect(v).toContain("expect i, s, false, false, false, true");
  });

  it("ROLLBACK: the previous body and comment again, the index dropped CONCURRENTLY outside a transaction, then the helper, then the ledger row", () => {
    const r = section("ROLLBACK", "See tests/");
    expect(r.indexOf("185_search_sibling_variants.sql")).toBeGreaterThan(-1);
    expect(r).toContain("172_search_exempt_word_tier.sql");
    expect(r).toContain(BASE_MD5);
    expect(r).toContain(PROD_MD5);
    const idx = r.indexOf("drop index concurrently if exists public.clusters_search_stemfold_live_idx;");
    const fn = r.indexOf("drop function if exists public.tayf_search_stem_fold(tsvector);");
    const ledger = r.indexOf("delete from supabase_migrations.schema_migrations where version = '186';");
    expect(idx).toBeGreaterThan(-1);
    expect(fn).toBeGreaterThan(idx);
    expect(ledger).toBeGreaterThan(fn);
    expect(r).toContain("outside a transaction block");
    expect(r).toContain("notify pgrst, 'reload schema';");
  });
});

describe("186 docs/migration-guide.md", () => {
  const guide = readFileSync(DOC_MIGRATION_GUIDE, "utf8");
  const sec = sectionOf(guide, "186");

  it("has a 186 section, after section 185", () => {
    expect(sec).not.toBe("");
    expect(sectionOf(guide, "185")).not.toBe("");
    expect(guide.indexOf("\n## 186 ")).toBeGreaterThan(guide.indexOf("\n## 185 "));
    expect(sec.split("\n")[1]).toContain("APPLY 186");
  });

  it("has Why, What, an md5 table, the index size, the pre-build, Replay, Cost, Order, Verify and Rollback", () => {
    for (const label of ["**Why:**", "**What 186 does**", "| | md5(prosrc) | length |", "**Index size**", "**Pre-build**", "**Replay**", "**Cost**", "**Order:**", "**Verify**", "**Rollback:**"]) {
      expect(sec, label).toContain(label);
    }
  });

  it("records the md5 of production's body, of 185's (the base) and of 186, matching the file", () => {
    expect(sec).toContain(`\`${PROD_MD5}\` | ${PROD_LENGTH}`);
    expect(sec).toContain(`\`${BASE_MD5}\` | ${BASE_LENGTH}`);
    expect(sec).toContain(`\`${md5(raw186)}\` | ${pgLength(raw186)}`);
  });

  it("states the evidence, the three objects, and that the Turkish-typed queries are unchanged", () => {
    for (const word of ["siginak", "6 -> 14", "yurt disi", "69 -> 215", "`tayf_search_stem_fold`", "`clusters_search_stemfold_live_idx`", "third arm", "`p_folded`"]) {
      expect(sec, word).toContain(word);
    }
  });

  it("Index size: about 7 MB, 0.1% of the database, and the measurements behind it (so the operator can decide to apply)", () => {
    const s = sec.slice(sec.indexOf("**Index size**"), sec.indexOf("**Pre-build**"));
    for (const word of ["about 7 MB", "8 to 9 MB", "0.1%", "6785 MB", "7 GiB", "383 MB", "375 MB", "32,552", "6,938,624", "8,224,768", "9,969,664", "0.9986"]) expect(s, word).toContain(word);
  });

  it("Pre-build: the helper, the index CONCURRENTLY outside a transaction, the invalid-index check, and what happens if it is skipped", () => {
    const s = sec.slice(sec.indexOf("**Pre-build**"), sec.indexOf("**Replay**"));
    for (const word of ["CREATE INDEX CONCURRENTLY", "outside any transaction block", "tayf_search_stem_fold", "indisvalid", "57014", "55P03", "about 4 s on production", "0.9 s locally", "about 190 microseconds", "SHARE"]) expect(s, word).toContain(word);
  });

  it("Replay: the six counts with their three arms, the ranked counts and the controls", () => {
    const s = sec.slice(sec.indexOf("**Replay**"), sec.indexOf("**Cost**"));
    for (const word of ["siginak", "14", "yurt disi", "215", "ic savas", "64", "hirsizlik", "38", "guvenlik", "1501", "cocuk", "872", "burdur", "34", "akp", "16 id-range slices"]) expect(s, word).toContain(word);
  });

  it("Cost: the gate of 1.3x, the measured ratios, the worst case and the write cost", () => {
    const s = sec.slice(sec.indexOf("**Cost**"), sec.indexOf("**Order:**"));
    for (const word of ["1.3x", "1.07x", "1.27x", "-qwxz", "1.56x", "Bitmap Index Scan", "about 63 microseconds per row", "about 370 microseconds of fold per row", "281 ms without the index, 422 ms with it", "about 190 microseconds more per updated live row"]) expect(s, word).toContain(word);
    expect(s).not.toContain("82 microseconds");
  });

  it("states the order: 185, then the pre-build, then 186; no app change", () => {
    const s = sec.slice(sec.indexOf("**Order:**"), sec.indexOf("**Verify**"));
    for (const word of ["APPLY `185_search_sibling_variants.sql` first", "pre-build", "186_search_stem_fold_arm.sql", "no app change", "Number 184"]) expect(s, word).toContain(word);
  });

  it("verifies the fingerprint, the helper, the index, the counts, the plan, the guard and the live query", () => {
    const v = sec.slice(sec.indexOf("**Verify**"), sec.indexOf("**Rollback:**"));
    for (const word of [md5(raw186), "has_function_privilege", "indisvalid", "version = '186'", "explain (analyze, buffers)", "/?q=siginak", "burdur"]) expect(v, word).toContain(word);
  });

  it("has a rollback in order: the previous body and comment, the index drop CONCURRENTLY, the helper drop, the ledger row", () => {
    const r = sec.slice(sec.indexOf("**Rollback:**"));
    expect(r).toContain("185_search_sibling_variants.sql");
    expect(r).toContain("172_search_exempt_word_tier.sql");
    const idx = r.indexOf("drop index concurrently if exists public.clusters_search_stemfold_live_idx");
    const fn = r.indexOf("drop function if exists public.tayf_search_stem_fold(tsvector)");
    const ledger = r.indexOf("delete from supabase_migrations.schema_migrations where version = '186'");
    expect(idx).toBeGreaterThan(-1);
    expect(fn).toBeGreaterThan(idx);
    expect(ledger).toBeGreaterThan(fn);
  });

  it("uses no fenced sql block (tests/guards/docs-sql-snippets.test.ts scans those)", () => {
    expect(sec).not.toContain("```");
  });
});

describe("186 dry-run and live manifest", () => {
  const dry = existsSync(DRYRUN_186) ? readFileSync(DRYRUN_186, "utf8") : "";

  it("builds 186's database with its own dry-run script: one run entry, that script as the only setup file", () => {
    const lines = readFileSync(MANIFEST, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("run | 186-search-stem-fold-arm.test.ts"));
    expect(lines).toEqual(["run | 186-search-stem-fold-arm.test.ts | tests/migrations/sql/186-search-stem-fold-arm-dryrun.sql | - | 0"]);
  });

  it("the dry-run builds 185's state (the 129 setup, 166, 172, 185, gated on 185's md5), applies 186 three times (twice, then after the pre-build) and ends with its OK line", () => {
    expect(existsSync(DRYRUN_186)).toBe(true);
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
      "../../../supabase/migrations/186_search_stem_fold_arm.sql",
      "../../../supabase/migrations/186_search_stem_fold_arm.sql",
    ]);
    expect(dry).toContain(BASE_MD5);
    expect(dry).toContain(String(BASE_LENGTH));
    expect(dry).toContain(md5(raw186));
    expect(dry).toContain(String(pgLength(raw186)));
    expect(dry.trimEnd().endsWith("\\echo DRYRUN 186 OK")).toBe(true);
    expect(dry).toContain("-f tests/migrations/sql/stub.sql");
    expect(dry).toContain("D=$(mktemp -d)");
    expect(dry).toContain("-- or: bash tests/migrations/sql/run-live.sh");
  });

  it("the dry-run shows the defect on 185's body, then 186: the ASCII queries gain the Turkish twin's rows, the controls and the guard keep 185's list, the plan uses the new index, hostile strings do not raise", () => {
    for (const q of ["siginak", "sığınak", "yurt disi", "guvenlik", "cocuk", "guvenligi", "burdur", "miller", "iran"]) expect(dry, q).toContain(`'${q}'`);
    expect(dry).toContain("baseline: 185");
    expect(dry).toContain("explain (analyze)");
    expect(dry).toContain("clusters_search_stemfold_live_idx");
    expect(dry).toContain("Fuzz");
    expect(dry).toContain("create index concurrently");
    expect(dry).toContain("the migration left the pre-built index alone");
    expect(dry).toContain("1.5");
    expect(dry).toContain("rollback;");
  });
});

// ---------------------------------------------------------------------------
// Live block (opt-in). TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/PGDATABASE point at a THROWAWAY database that the
// dry-run script left behind with 129, 166, 172, 185 and 186 applied (tests/migrations/sql/live-manifest.txt). Every scenario runs
// inside begin ... rollback: it seeds clusters, runs 185's body (as a pg_temp function made from the text of 185's migration
// file) and the installed 186 function side by side, and checks the contracts of 186:
//   (1) 186's list contains 185's, and is 185's list itself for every call that has nothing new to find;
//   (2) an ASCII-typed base form finds exactly the rows of its Turkish spelling;
//   (3) a Turkish-typed query, the guard (burdur) and the tier (miller) are unchanged.
// ---------------------------------------------------------------------------

interface Seed {
  key: string;
  title: string;
  summary: string;
  hoursAgo: number;
}

const SEEDS: Seed[] = [
  { key: "sig1", title: "Sığınağı vuruldu", summary: "Sivil sığınağa saldırı oldu.", hoursAgo: 1 },
  { key: "sig2", title: "Sığınak yapımı hızlandı", summary: "Yeni sığınaklar inşa edilecek.", hoursAgo: 2 },
  { key: "sig3", title: "Sığınaktaki aileler tahliye edildi", summary: "Tahliye sürüyor.", hoursAgo: 3 },
  { key: "yurt1", title: "Yurt dışına çıkış yasağı", summary: "Seyahat kısıtlaması.", hoursAgo: 4 },
  { key: "yurt2", title: "Yurt dışında eğitim fırsatı", summary: "Burs verilecek.", hoursAgo: 5 },
  { key: "yurt3", title: "Yurt dışı seyahat başladı", summary: "Tatilciler yola çıktı.", hoursAgo: 6 },
  { key: "guv1", title: "Güvenliği artırıldı", summary: "Önlemler alındı.", hoursAgo: 7 },
  { key: "guv2", title: "Güvenlik toplantısı yapıldı", summary: "Karar çıktı.", hoursAgo: 8 },
  { key: "coc1", title: "Çocuğu kurtardılar", summary: "İtfaiye müdahale etti.", hoursAgo: 9 },
  { key: "coc2", title: "Çocuk bayramı kutlandı", summary: "Törenler yapıldı.", hoursAgo: 10 },
  { key: "burdur", title: "Burdur'da yurt zehirlenmesi", summary: "Öğrenciler hastaneye kaldırıldı.", hoursAgo: 1 },
  { key: "bursa", title: "Bursa'da deprem uyarısı", summary: "Uzmanlar uyardı.", hoursAgo: 2 },
  { key: "burun", title: "Hak hukuk tanımazlığın ete kemiğe büründüğü bir gün", summary: "Tepki büyüdü.", hoursAgo: 3 },
  { key: "miller", title: "Miller açıklama yaptı", summary: "Açıklama geldi.", hoursAgo: 10 },
  { key: "milMili", title: "Mili Eğitim Bakanlığı toplantısı", summary: "Toplantı yapıldı.", hoursAgo: 11 },
  { key: "iran", title: "İran açıklama yaptı", summary: "Tahran'dan.", hoursAgo: 13 },
  { key: "erdogan", title: "Erdoğan kabine toplantısı sonrası konuştu", summary: "Açıklama yaptı.", hoursAgo: 14 },
];

const seedId = (i: number): string => `00000000-0000-4000-8000-${String(186000 + i).padStart(12, "0")}`;
const KEY_BY_ID = new Map(SEEDS.map((s, i) => [seedId(i), s.key]));

const lit = (s: string): string => `'${s.replaceAll("'", "''")}'`;

interface LiveQuery {
  name: string;
  variants: string[];
  folded: string;
  /** The Turkish twin of an ASCII query: the same set of rows after 186. */
  twin?: string;
  /** True when 186 finds rows that 185 did not. */
  gains?: boolean;
}

const LIVE_QUERIES: LiveQuery[] = [
  { name: "siginak", variants: ["siginak"], folded: foldTr("siginak"), twin: "sığınak", gains: true },
  { name: "sığınak", variants: ["sığınak"], folded: foldTr("sığınak") },
  { name: "yurt disi", variants: ["yurt disi"], folded: foldTr("yurt disi"), twin: "yurt dışı", gains: true },
  { name: "yurt dışı", variants: ["yurt dışı", "yurt dişi"], folded: foldTr("yurt dışı") },
  { name: "guvenlik", variants: ["guvenlik"], folded: foldTr("guvenlik"), twin: "güvenlik", gains: true },
  { name: "güvenlik", variants: ["güvenlik"], folded: foldTr("güvenlik") },
  { name: "cocuk", variants: ["cocuk"], folded: foldTr("cocuk"), twin: "çocuk", gains: true },
  { name: "çocuk", variants: ["çocuk"], folded: foldTr("çocuk") },
  { name: "guvenligi", variants: ["guvenligi"], folded: "guvenligi" },
  { name: "burdur", variants: ["burdur"], folded: "burdur" },
  { name: "miller", variants: ["miller"], folded: "miller" },
  { name: "iran", variants: ["iran"], folded: "iran" },
  { name: "erdogan", variants: ["erdogan"], folded: "erdogan" },
  { name: "phrase", variants: ['"yurt dışı"'], folded: '"yurt disi"' },
  { name: "negated", variants: ["-siginak"], folded: "-siginak" },
  { name: "empty", variants: [""], folded: "" },
];

describe.runIf(Boolean(process.env.TAYF_PSQL))("186 search stem-fold arm against a live Postgres (129, 166, 172, 185 and 186 applied)", () => {
  assertLiveReady("186", {
    ledger: ["129", "166", "172", "185", "186"],
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

  /** 185's function, from the text of 185's migration file, as a pg_temp function of the same shape. */
  const FN_185 =
    "create function pg_temp.f185(p_variants text[], p_folded text, p_limit integer default 12) returns table (id uuid) " +
    `language sql stable set search_path = '' as $fn$${raw185}$fn$;`;

  const rows = SEEDS.map(
    (s, i) => `(${lit(seedId(i))}, ${lit(s.title)}, null, ${lit(s.summary)}, 2, false, now() - interval '${s.hoursAgo} hours')`,
  ).join(",\n");

  const list = (fn: string, q: LiveQuery): string =>
    `select ${lit(`${q.name}|${fn === "pg_temp.f185" ? "185" : "186"}|`)} || coalesce((select string_agg(t.id::text, ',' order by t.n) ` +
    `from ${fn}(${arr(q.variants)}, ${lit(q.folded)}, 50) with ordinality as t(id, n)), '');`;

  const script = [
    "begin;",
    FN_185,
    `insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at) values\n${rows};`,
    "analyze public.clusters;",
    ...LIVE_QUERIES.flatMap((q) => [list("pg_temp.f185", q), list("public.search_cluster_ids", q)]),
    "rollback;",
  ].join("\n");

  const ids185 = new Map<string, string[]>();
  const ids186 = new Map<string, string[]>();
  let ran = false;
  const run = (): void => {
    if (ran) return;
    ran = true;
    for (const line of runPsql(script).split("\n")) {
      if (line === "") continue;
      const [name, which, ids] = line.split("|") as [string, string, string];
      const keys = ids === "" ? [] : ids.split(",").map((id) => KEY_BY_ID.get(id) ?? `?${id}`);
      (which === "185" ? ids185 : ids186).set(name, keys);
    }
  };

  const keysOf = (m: Map<string, string[]>, name: string): string[] => {
    run();
    const v = m.get(name);
    expect(v, `no result for ${name}`).toBeDefined();
    return v as string[];
  };

  it("the fixture reproduces the defect on 185's body: the ASCII query misses the row whose inflection softens the g, the Turkish one does not", () => {
    expect(keysOf(ids185, "siginak")).not.toContain("sig1");
    expect([...keysOf(ids185, "sığınak")].sort()).toEqual(["sig1", "sig2", "sig3"]);
    expect(keysOf(ids185, "guvenlik")).toEqual(["guv2"]);
    expect(keysOf(ids185, "cocuk")).toEqual(["coc2"]);
  });

  it.each(LIVE_QUERIES.map((q) => [q.name, q] as [string, LiveQuery]))(
    "'%s': 186's list contains 185's, and is 185's list itself when there is nothing new to find",
    (_name, q) => {
      const before = keysOf(ids185, q.name);
      const after = keysOf(ids186, q.name);
      for (const k of before) expect(after, q.name).toContain(k);
      if (!q.gains) expect(after, q.name).toEqual(before);
      expect(before.length, "below the 50-row cap").toBeLessThan(50);
    },
  );

  it("an ASCII base form finds exactly the rows of its Turkish spelling, and gains rows", () => {
    for (const q of LIVE_QUERIES.filter((x) => x.twin !== undefined)) {
      expect([...keysOf(ids186, q.name)].sort(), q.name).toEqual([...keysOf(ids186, q.twin as string)].sort());
      expect(keysOf(ids186, q.name).length, q.name).toBeGreaterThan(keysOf(ids185, q.name).length);
    }
    expect([...keysOf(ids186, "siginak")].sort()).toEqual(["sig1", "sig2", "sig3"]);
  });

  it("the 166 guard stays: burdur keeps the Burdur row, not Bursa, and not the bürün row that folds onto the same stem", () => {
    expect(keysOf(ids186, "burdur")).toEqual(["burdur"]);
  });

  it("the 172 tier stays: the Miller row comes before the stem collision", () => {
    expect(keysOf(ids186, "miller")[0]).toBe("miller");
  });

  it("an inflected ASCII word is not a stem and finds what it found (a documented limit)", () => {
    expect(keysOf(ids186, "guvenligi")).toEqual(keysOf(ids185, "guvenligi"));
  });

  it("aborts with the repair instruction when a CONCURRENTLY build left the index invalid (the connection ends, so nothing is kept)", () => {
    const bad = `begin;\nupdate pg_catalog.pg_index set indisvalid = false where indexrelid = 'public.clusters_search_stemfold_live_idx'::regclass;\n${sql}`;
    let message = "";
    try {
      runPsql(bad);
    } catch (e) {
      message = String((e as { stderr?: unknown; message?: unknown }).stderr ?? (e as Error).message);
    }
    expect(message).toContain("186: invalid index left by an aborted CREATE INDEX CONCURRENTLY: clusters_search_stemfold_live_idx");
    expect(runPsql("select indisvalid from pg_catalog.pg_index where indexrelid = 'public.clusters_search_stemfold_live_idx'::regclass;").trim()).toBe("t");
  });

  it("is applied once: one ledger row for 186, one overload, the body of the file, the helper and the index as the file says", () => {
    const out = runPsql(`
select (select count(*) from supabase_migrations.schema_migrations where version = '186'),
       (select count(*) from pg_catalog.pg_proc where proname = 'search_cluster_ids' and pronamespace = 'public'::regnamespace and pg_get_function_identity_arguments(oid) = 'p_variants text[], p_folded text, p_limit integer'),
       p.prosecdef, p.provolatile, (p.proconfig = array['search_path=""']), p.proacl::text, md5(p.prosrc), length(p.prosrc),
       has_function_privilege('anon', p.oid, 'execute'), has_function_privilege('authenticated', p.oid, 'execute'),
       has_function_privilege('service_role', p.oid, 'execute'),
       obj_description(p.oid, 'pg_proc') like '%186%',
       h.provolatile, h.proparallel, h.prosecdef, (h.proconfig = array['search_path=""']), h.proacl::text,
       has_function_privilege('anon', h.oid, 'execute'), has_function_privilege('authenticated', h.oid, 'execute'),
       has_function_privilege('service_role', h.oid, 'execute'),
       (select i.indisvalid from pg_catalog.pg_index i where i.indexrelid = 'public.clusters_search_stemfold_live_idx'::regclass),
       (select pg_get_indexdef(i.indexrelid) from pg_catalog.pg_index i where i.indexrelid = 'public.clusters_search_stemfold_live_idx'::regclass) like '%USING gin (tayf_search_stem_fold(search_tsv)) WHERE ((NOT is_archived) AND (article_count >= 2))'
  from pg_catalog.pg_proc p, pg_catalog.pg_proc h
 where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure
   and h.oid = 'public.tayf_search_stem_fold(tsvector)'::regprocedure;
`).trim();
    const f = out.split("|");
    expect(f[0]).toBe("1"); // ledger rows for 186
    expect(f[1]).toBe("1"); // one three-argument overload
    expect(f[2]).toBe("t"); // security definer
    expect(f[3]).toBe("s"); // stable
    expect(f[4]).toBe("t"); // search_path = ''
    expect(f[5]).toBe(PROD_PROACL);
    expect(f[6]).toBe(md5(raw186)); // the function in the database is the body of the file
    expect(f[7]).toBe(String(pgLength(raw186)));
    expect(f[8]).toBe("f"); // anon
    expect(f[9]).toBe("f"); // authenticated
    expect(f[10]).toBe("t"); // service_role
    expect(f[11]).toBe("t"); // the comment names 186
    expect(f[12]).toBe("i"); // helper: immutable
    expect(f[13]).toBe("s"); // parallel safe
    expect(f[14]).toBe("f"); // not security definer
    expect(f[15]).toBe("t"); // search_path = ''
    expect(f[16]).toBe(PROD_PROACL);
    expect(f[17]).toBe("f"); // anon
    expect(f[18]).toBe("f"); // authenticated
    expect(f[19]).toBe("t"); // service_role
    expect(f[20]).toBe("t"); // the index is valid
    expect(f[21]).toBe("t"); // and is the one the file defines
  });
});
