import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Contract test for migration 185 ("search sibling variants"), h96-search-1 (hunt 96). 185 is numbered after 184, which
// another branch holds.
//
// The Turkish stemmer gives the possessive ('vergisi' -> 'vergis') and the doubled-consonant form ('zammı' -> 'zammı')
// their own lexemes, so 'elektrik zammı' matched nothing on production while 'elektrik zam' found 9 stories. The app
// (turkish-query.ts searchSiblingQuery, search-query.ts) now sends the typed spellings first and the root's spellings
// after them as p_variants (at most six). 185 replaces search_cluster_ids(text[], text, integer) with 172's body and ONE
// changed expression: q.qv ORs p_variants[1..6] instead of [1..3], a missing element falling back to the first spelling
// (an OR of the first spelling with itself changes nothing). p_folded, 166's guard and 172's tier are untouched.
//
// This file pins, without a database: the file, ledger and transaction, that 172's body is production's (md5 pinned), a
// derive-and-compare of 185's body against 172's (byte for byte but the three added terms), the header, the docs section,
// the dry-run and the live-manifest entry. The opt-in live block (TAYF_PSQL) runs 172's body and 185's function side by
// side on fixtures: a call with at most three variants returns the same list, a fourth to sixth variant is read by 185
// only.
//
// No regular expression is applied to quoted SQL literals in this file (CodeQL js/redos): the SQL is scanned with
// indexOf and character loops.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const FILE_185 = "185_search_sibling_variants.sql";
const MIGRATION_185 = resolve(MIGRATIONS_DIR, FILE_185);
const MIGRATION_172 = resolve(MIGRATIONS_DIR, "172_search_exempt_word_tier.sql");
const DRYRUN_185 = resolve(ROOT, "tests", "migrations", "sql", "185-search-sibling-variants-dryrun.sql");
const MANIFEST = resolve(ROOT, "tests", "migrations", "sql", "live-manifest.txt");
const DOC_MIGRATION_GUIDE = resolve(ROOT, "docs", "migration-guide.md");

/** md5 and length of production's prosrc for search_cluster_ids(text[], text, integer), read-only 2026-11-09 (= 172's body). */
const BASE_MD5 = "192218b7b6a56b3c8fcc48d5e0610a2c";
const BASE_LENGTH = 12913;
const BASE_PROACL = "{postgres=X/postgres,service_role=X/postgres}";

const LEDGER_STMT =
  "insert into supabase_migrations.schema_migrations (version, name) values ('185', '185_search_sibling_variants') on conflict do nothing;";
const REVOKE_STMT = "revoke all on function public.search_cluster_ids(text[], text, integer) from public, anon, authenticated;";
const GRANT_STMT = "grant execute on function public.search_cluster_ids(text[], text, integer) to service_role;";

/** The third spelling's term of q.qv, as 172 has it (followed by ` as qv,`), and the three terms 185 adds after it. */
const TERM = (k: number): string =>
  `|| pg_catalog.websearch_to_tsquery('pg_catalog.turkish'::pg_catalog.regconfig, coalesce(p_variants[${k}], p_variants[1], ''))`;

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

/** A header section as prose: the `--` markers removed and the whitespace collapsed (the header wraps its lines). */
function collapseHeader(section: string): string {
  return collapse(
    section
      .split("\n")
      .map((l) => (l.startsWith("--") ? l.slice(2) : l))
      .join(" "),
  );
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
let fn185 = "";
let body185 = "";
let cb185 = "";
/** The body as the database stores it (prosrc): comments included. */
let raw185 = "";

if (existsSync(MIGRATION_185)) {
  sql = readFileSync(MIGRATION_185, "utf8");
  code = stripComments(sql);
  head = sql.slice(0, sql.indexOf("\nbegin;"));
  fn185 = functionBlock(code, "search_cluster_ids");
  body185 = fnBody(fn185);
  cb185 = collapse(body185);
  raw185 = fnBody(functionBlock(sql, "search_cluster_ids"));
}
const sql172 = readFileSync(MIGRATION_172, "utf8");
const fn172 = functionBlock(stripComments(sql172), "search_cluster_ids");
const cb172 = collapse(fnBody(fn172));
const raw172 = fnBody(functionBlock(sql172, "search_cluster_ids"));

describe("185 file, ledger and structure", () => {
  it("exists with the exact name, and no other migration claims the number 185", () => {
    expect(existsSync(MIGRATION_185)).toBe(true);
    const claimed = readdirSync(MIGRATIONS_DIR).filter((n) => n.startsWith("185_"));
    expect(claimed).toEqual([FILE_185]);
  });

  it("contains the ledger insert for '185' with on conflict do nothing, the last statement before commit", () => {
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

  it("is additive only: a function replace and the ledger row, no drop, alter, truncate, update, delete, table, index or trigger", () => {
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

describe("185 search_cluster_ids(text[], text, integer)", () => {
  it("is the only definition and has 172's signature (create or replace, no drop, no new overload)", () => {
    expect(fn185.startsWith("create or replace function public.search_cluster_ids(p_variants text[], p_folded text, p_limit integer default 12)")).toBe(true);
    expect(countOf(code.toLowerCase(), "create or replace function")).toBe(1);
    expect(countOf(code.toLowerCase(), "create function")).toBe(0);
  });

  it("has exactly 172's header: returns table (id uuid), language sql, stable, security definer, search_path ''", () => {
    expect(collapse(fnHeader(fn185))).toBe(collapse(fnHeader(fn172)));
    const h = collapse(fnHeader(fn185));
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

  it("has a function comment that names the sibling variants and the migrations it builds on", () => {
    const c = collapse(code);
    const at = c.indexOf("comment on function public.search_cluster_ids(text[], text, integer) is");
    expect(at).toBeGreaterThan(-1);
    const comment = c.slice(at, c.indexOf("revoke all", at)).toLowerCase();
    for (const word of ["185", "172", "166", "129", "sibling", "six", "tier", "guard", "p_folded"]) expect(comment, word).toContain(word);
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
    const bare = sansStrings(cb185);
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

describe("185 body = 172's body with ONE changed expression, nothing else", () => {
  it("172's body is production's body: its md5 and length are the recorded prosrc (read-only, 2026-11-09)", () => {
    expect(md5(raw172)).toBe(BASE_MD5);
    expect(pgLength(raw172)).toBe(BASE_LENGTH);
  });

  it("removing the three added terms gives 172's body, character for character (comments included)", () => {
    const added = [4, 5, 6].map((k) => `\n              ${TERM(k)}`).join("");
    expect(raw185.split(added).length, "the three terms appear once, in this order, after the third").toBe(2);
    // 172: `... p_variants[3] ... as qv,` -- 185 puts the three terms between the third term and ` as qv,`
    const restored = raw185.replace(`${added} as qv,`, " as qv,");
    expect(restored).toBe(raw172);
    expect(raw185.length - raw172.length).toBe(added.length);
  });

  it("q.qv ORs six websearch queries, each falling back to the first spelling, in the order 1..6", () => {
    const at = cb185.indexOf("), q as (");
    expect(at).toBeGreaterThan(-1);
    const q = cb185.slice(at, cb185.indexOf(" as qv,", at) + " as qv,".length);
    const terms = [
      "select pg_catalog.websearch_to_tsquery('pg_catalog.turkish'::pg_catalog.regconfig, coalesce(p_variants[1], ''))",
      ...[2, 3, 4, 5, 6].map((k) => TERM(k)),
    ];
    expect(q).toBe(`), q as ( ${terms.join(" ")} as qv,`);
    expect(countOf(cb185, "p_variants"), "p_variants is read in the six terms of q.qv and nowhere else").toBe(11);
  });

  it("p_folded and p_limit are read exactly where 172 reads them: the guard, the tier and the folded arm do not see the siblings", () => {
    expect(countOf(cb185, "p_folded")).toBe(countOf(cb172, "p_folded"));
    expect(countOf(cb185, "p_limit")).toBe(countOf(cb172, "p_limit"));
    expect(cb185).toContain("select public.tayf_search_fold(coalesce(p_folded, '')) as ff");
  });

  it("keeps 172's CTE order, the guard (166), the tier (172), the candidate arms and the ORDER BY", () => {
    const ctes = ["with f0 as (", "), g0 as (", "), gx as (", "), g as (", "), ge as (", "), f as (", "), q as (", "), cand as (", "), kept as (", "), top as (", "), hits as ("];
    let last = -1;
    for (const piece of ctes) {
      const at = cb185.indexOf(piece);
      expect(at, piece).toBeGreaterThan(last);
      last = at;
    }
    for (const piece of ["order by (case when h.lit_ok then 0 else 1 end),", "limit greatest(1, least(coalesce(p_limit, 12), 50));", "limit 1000"]) {
      expect(cb185, piece).toContain(piece);
    }
    // everything before q is 172's text byte for byte, and so is the tail from `), cand as (` on
    expect(cb185.slice(0, cb185.indexOf("), q as ("))).toBe(cb172.slice(0, cb172.indexOf("), q as (")));
    expect(cb185.slice(cb185.indexOf("), cand as ("))).toBe(cb172.slice(cb172.indexOf("), cand as (")));
  });

  it("puts no user text inside a regex pattern: the patterns are 172's constants", () => {
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
    expect(patterns(cb185)).toEqual(patterns(cb172));
  });
});

describe("185 header", () => {
  it("documents WHY, WHAT, DEPLOY ORDER, KNOWN LIMITS, the production fingerprint, REPLAY, COST, LEDGER, VERIFY and ROLLBACK", () => {
    for (const section of ["WHY", "WHAT", "DEPLOY ORDER", "KNOWN LIMITS", "PRODUCTION FINGERPRINT", "REPLAY", "COST", "LEDGER", "VERIFY", "ROLLBACK"]) {
      expect(head, section).toContain(`\n-- ${section}`);
    }
    expect(head).toContain("184 is another branch");
  });

  it("records 172's md5, length and ACL as the fingerprint the replace was based on, read-only", () => {
    const at = head.indexOf("PRODUCTION FINGERPRINT");
    const section = head.slice(at, head.indexOf("\n-- REPLAY", at));
    expect(section).toContain(BASE_MD5);
    expect(section).toContain(String(BASE_LENGTH));
    expect(section).toContain(BASE_PROACL);
    expect(section).toContain("172_search_exempt_word_tier.sql");
    expect(section).toContain("2026-11-09");
  });

  it("records the md5 and length of the NEW body, and they match this file (the test recomputes it)", () => {
    const newMd5 = md5(raw185);
    const newLength = pgLength(raw185);
    expect(newMd5).not.toBe(BASE_MD5);
    expect(head).toContain(`new md5(prosrc): ${newMd5} (length ${newLength})`);
  });

  it("the VERIFY step names the same md5 and length as the `new md5(prosrc)` line", () => {
    const at = head.indexOf("\n-- VERIFY");
    const verify = head.slice(at, head.indexOf("\n-- ROLLBACK", at));
    expect(verify).toContain(`expect ${md5(raw185)}, ${pgLength(raw185)}.`);
    expect(verify).toContain("false, true");
  });

  it("WHY names the four defect queries with the production counts, and the stemming that causes them", () => {
    const at = head.indexOf("\n-- WHY");
    const why = head.slice(at, head.indexOf("\n-- WHAT", at));
    for (const word of ["elektrik zammı 0 vs 9", "emlak vergisi 0 vs 2", "doğal gaz zammı 0 vs 4", "asgari ücret zammı 0 vs 6", "trafik cezası 18", "gelir vergisi 7", "zammı -> zammı", "vergisi -> vergis"]) {
      expect(why, word).toContain(word);
    }
  });

  it("WHAT describes both rules, the closed allowlist, the six-variant OR with the fallback to the first spelling, and that p_folded is untouched", () => {
    const at = head.indexOf("\n-- WHAT");
    const what = head.slice(at, head.indexOf("\n-- DEPLOY ORDER", at));
    for (const word of ["searchSiblingQuery", "hasSearchOperator", "GEMINATE_ROOTS", "closed", "messi", "p_variants[4]", "p_variants[5]", "p_variants[6]", "falls back to the first spelling", "p_folded", "166", "172"]) {
      expect(what, word).toContain(word);
    }
  });

  it("DEPLOY ORDER says the app can ship first and 185 is optional for it: the app never sends more than three variants in one call (CORR-2)", () => {
    const at = head.indexOf("\n-- DEPLOY ORDER");
    const order = collapseHeader(head.slice(at, head.indexOf("\n-- KNOWN LIMITS", at)));
    expect(order).toContain("The app can ship first");
    expect(order).toContain("OPTIONAL");
    expect(order).toContain("172's body reads p_variants[1..3] and ignores the rest");
    expect(order).toContain("never sends more than three variants in one call");
    expect(order).toContain("changes nothing the app can observe");
    expect(order).toContain("186");
    expect(order).not.toContain("ısıtma zammı");
  });

  it("the header says the sibling is a SECOND call that only fills empty slots, not an OR into the typed call, with the production evidence (CORR-2)", () => {
    const top = collapseHeader(head.slice(0, head.indexOf("\n-- WHY")));
    expect(top).toContain("asks twice");
    expect(top).toContain("SECOND call");
    expect(top).toContain("OPTIONAL");
    const at = head.indexOf("\n-- WHY");
    const why = collapseHeader(head.slice(at, head.indexOf("\n-- WHAT", at)));
    for (const word of ["must NOT be ORed into the typed call", "'karasu', 'kara'", "13 Karasu rows and 11 unrelated", "24 Karasu rows", "'kayısı'", "second call that can only fill empty slots"]) {
      expect(why, word).toContain(word);
    }
    const w = head.indexOf("\n-- WHAT");
    const what = collapseHeader(head.slice(w, head.indexOf("\n-- DEPLOY ORDER", w)));
    for (const word of ["the -sı / -si ending only", "[aeıioöuü])s[ıi]$/u", "a -su / -sü word is a compound name", "Karasu", "kayısı", "deny set", "fewer than 24 (SEARCH_LIMIT) ids", "second call", "appends the second call's ids"]) {
      expect(what, word).toContain(word);
    }
    expect(what).not.toContain("s[ıiuü]$");
  });

  it("KNOWN LIMITS names the two shapes only, the tesisi false positive, the hakkı first name and the alias query", () => {
    const at = head.indexOf("\n-- KNOWN LIMITS");
    const limits = head.slice(at, head.indexOf("\n-- PRODUCTION FINGERPRINT", at));
    for (const word of ["Two shapes only", "tesisi", "hakkı", "first name", "alias query"]) expect(limits, word).toContain(word);
  });

  it("KNOWN LIMITS (4) says a sibling-only row ranks level with the typed rows inside one call unless the word is an exempt over-cut word, which is why the app asks twice (CORR-2)", () => {
    const at = head.indexOf("\n-- KNOWN LIMITS");
    const limits = collapseHeader(head.slice(at, head.indexOf("\n-- PRODUCTION FINGERPRINT", at)));
    for (const word of ["Inside ONE call the function cannot tell typed from sibling spellings", "a sibling-only row ranks level with the typed rows", "unless the word is an exempt over-cut word", "the app never merges"]) {
      expect(limits, word).toContain(word);
    }
    expect(limits).not.toContain("below a row that holds the typed word");
  });

  it("REPLAY: p_limit 50 is the RPC's cap, the app asks for 24, every cited query has its counts, and the controls are identical", () => {
    const at = head.indexOf("\n-- REPLAY");
    const replay = head.slice(at, head.indexOf("\n-- COST", at));
    expect(replay).toContain("p_limit 50");
    expect(replay).toContain("24 (SEARCH_LIMIT)");
    for (const row of ["elektrik zammı        0 -> 9", "emlak vergisi         0 -> 2", "doğal gaz zammı       0 -> 4", "asgari ücret zammı    0 -> 6", "gelir vergisi         7 -> 22", "trafik cezası        18 -> 38"]) {
      expect(replay, row).toContain(row);
    }
    for (const control of ["burdur", "miller", "bartın", "iran", "seçim", "erdoğan", "akp", "istanbul", "imamoğlu", "messi"]) expect(replay, control).toContain(control);
    expect(replay).toContain("identical top 24 AND identical 50-row list");
    expect(replay).toContain("sırrı");
  });

  it("REPLAY has the shipped app shape (two calls on the live 172 body) with the counts, karasu and kayısı (CORR-2)", () => {
    const at = head.indexOf("\n-- REPLAY");
    const replay = collapseHeader(head.slice(at, head.indexOf("\n-- COST", at)));
    for (const word of ["APP SHAPE, as shipped", "elektrik zammı 0 + 9 = 9 rows (two calls)", "emlak vergisi 0 + 2 = 2", "gelir vergisi 7 + 15 = 22", "trafik cezası 18 + 6 = 24", "karasu 24 rows", "kayısı 2 rows"]) {
      expect(replay, word).toContain(word);
    }
  });

  it("COST: EXPLAIN (ANALYZE) on production against 172's body in the same session, iran and trafik cezası within 1.3x for the body alone", () => {
    const at = head.indexOf("\n-- COST");
    const cost = head.slice(at, head.indexOf("\n-- LEDGER", at));
    expect(cost).toContain("1.3x");
    expect(cost).toContain("trafik cezası");
    expect(cost).toContain("iran");
    expect(cost).toContain("1.05x");
    expect(cost).toContain("1.59x");
    expect(cost).toContain("38 hits where 172 had 18");
  });

  it("the ROLLBACK is 172's function and comment statements again plus deleting the ledger row 185, and names the 083 fallback as untouched", () => {
    const at = head.indexOf("\n-- ROLLBACK");
    const rollback = head.slice(at, head.indexOf("\n-- See tests/", at));
    expect(rollback).toContain("172_search_exempt_word_tier.sql");
    expect(rollback).toContain("comment on function");
    expect(rollback).toContain(BASE_MD5);
    expect(rollback).toContain("delete from supabase_migrations.schema_migrations where version = '185';");
    expect(rollback).toContain("notify pgrst, 'reload schema';");
    expect(rollback).toContain("083");
    expect(rollback).toContain("PGRST202");
  });

  it("the ROLLBACK says to run 186's rollback first when 186 is applied, because 186's body contains 185's change (database-2)", () => {
    const at = head.indexOf("\n-- ROLLBACK");
    const rollback = collapseHeader(head.slice(at, head.indexOf("\n-- See tests/", at)));
    expect(rollback).toContain("If 186 is applied, run 186's ROLLBACK first");
    expect(rollback).toContain("drop index concurrently");
    expect(rollback).toContain("clusters_search_stemfold_live_idx");
    expect(rollback).toContain("drop the helper");
    expect(rollback).toContain("186's body contains 185's change");
    expect(rollback).toContain("silently drop 186's third arm");
    expect(rollback).not.toContain("nothing depends on 185");
    // the instruction comes BEFORE the 172 re-run
    expect(rollback.indexOf("run 186's ROLLBACK first")).toBeLessThan(rollback.indexOf("172_search_exempt_word_tier.sql"));
    expect(rollback).toContain("186");
  });
});

describe("185 docs/migration-guide.md", () => {
  const guide = readFileSync(DOC_MIGRATION_GUIDE, "utf8");
  const section = sectionOf(guide, "185");

  it("has a 185 section, after section 172 (a later section may follow)", () => {
    expect(section).not.toBe("");
    expect(guide.indexOf("\n## 185 ")).toBeGreaterThan(guide.indexOf("\n## 172 "));
    expect(section.split("\n")[1]).toContain("APPLY 185");
  });

  it("has Why, What, an md5 table, Replay, Cost, Order, Verify and Rollback", () => {
    for (const label of ["**Why:**", "**What 185 does**", "| | md5(prosrc) | length |", "**Replay**", "**Cost**", "**Order:**", "**Verify**", "**Rollback:**"]) {
      expect(section, label).toContain(label);
    }
  });

  it("records the md5 of 172 (production) and of 185, matching the file", () => {
    expect(section).toContain(`\`${BASE_MD5}\` | ${BASE_LENGTH}`);
    expect(section).toContain(`\`${md5(raw185)}\` | ${pgLength(raw185)}`);
  });

  it("states the evidence (the four queries with their counts), the two rules, and that p_folded is unchanged", () => {
    for (const word of ["elektrik zammı", "emlak vergisi", "doğal gaz zammı", "asgari ücret zammı", "0 -> 9", "`GEMINATE_ROOTS`", "`p_folded`", "closed"]) {
      expect(section, word).toContain(word);
    }
  });

  it("states the order: the app can ship first, the database any time, and when 185 itself matters", () => {
    const order = section.slice(section.indexOf("**Order:**"), section.indexOf("**Verify**"));
    expect(order).toContain("app can ship first");
    expect(order).toContain("any time");
    expect(order).toContain("optional for the app");
    expect(order).toContain("never sends more than three variants in one call");
  });

  it("What: the sibling is a second call that only fills empty slots, rule A is the -sı / -si ending only, and the merged call's defect is recorded (CORR-2)", () => {
    const what = section.slice(section.indexOf("**What 185 does**"), section.indexOf("| | md5(prosrc) | length |"));
    for (const word of ["`-sı` / `-si` ending only", "`Karasu`", "`kayısı`", "deny set", "SECOND call", "fewer than 24 ids", "never merged into the typed call", "13 Karasu rows and 11 unrelated"]) {
      expect(what, word).toContain(word);
    }
    const replay = section.slice(section.indexOf("**Replay**"), section.indexOf("**Cost**"));
    for (const word of ["`elektrik zammı` 0 + 9 = 9", "`trafik cezası` 18 + 6 = 24", "`karasu` one call and 24 rows"]) expect(replay, word).toContain(word);
  });

  it("Cost: the body alone is within 1.3x, the end-to-end growth of trafik cezası is the extra rows", () => {
    const cost = section.slice(section.indexOf("**Cost**"), section.indexOf("**Order:**"));
    expect(cost).toContain("1.3x");
    expect(cost).toContain("1.05x");
    expect(cost).toContain("1.59x");
    expect(cost).toContain("38");
  });

  it("verifies the fingerprint, the privileges, the ledger, the fourth variant and the live queries", () => {
    const verify = section.slice(section.indexOf("**Verify**"), section.indexOf("**Rollback:**"));
    expect(verify).toContain(md5(raw185));
    expect(verify).toContain("has_function_privilege");
    expect(verify).toContain("version = '185'");
    expect(verify).toContain("zzqx1");
    expect(verify).toContain("/?q=elektrik%20zamm%C4%B1");
  });

  it("has a rollback that re-runs 172's function and comment and deletes only the 185 ledger row", () => {
    const rollback = section.slice(section.indexOf("**Rollback:**"));
    expect(rollback).toContain("172_search_exempt_word_tier.sql");
    expect(rollback).toContain(BASE_MD5);
    expect(rollback).toContain("delete from supabase_migrations.schema_migrations where version = '185'");
    expect(rollback).toContain("notify pgrst, 'reload schema';");
  });

  it("the guide's rollback starts with 186's rollback when 186 is applied, because 186's body contains 185's change (database-2)", () => {
    const rollback = section.slice(section.indexOf("**Rollback:**"));
    expect(rollback.slice(0, 140)).toContain("if 186 is applied, run 186's rollback first");
    expect(rollback).toContain("`drop index concurrently` of `clusters_search_stemfold_live_idx`");
    expect(rollback).toContain("186's body contains 185's change");
    expect(rollback).toContain("186");
    expect(rollback.indexOf("186's rollback first")).toBeLessThan(rollback.indexOf("172_search_exempt_word_tier.sql"));
  });

  it("uses no fenced sql block (tests/guards/docs-sql-snippets.test.ts scans those)", () => {
    expect(section).not.toContain("```");
  });
});

describe("185 dry-run and live manifest", () => {
  const dry = existsSync(DRYRUN_185) ? readFileSync(DRYRUN_185, "utf8") : "";

  it("builds 185's database with its own dry-run script: one run entry, that script as the only setup file", () => {
    const lines = readFileSync(MANIFEST, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("run | 185-search-sibling-variants.test.ts"));
    expect(lines).toEqual([
      "run | 185-search-sibling-variants.test.ts | tests/migrations/sql/185-search-sibling-variants-dryrun.sql | - | 0",
    ]);
  });

  it("the dry-run builds 172's state (the 129 setup, 166, then 172 itself, gated on production's md5), applies 185 twice and ends with its OK line", () => {
    expect(existsSync(DRYRUN_185)).toBe(true);
    const ir = dry
      .split("\n")
      .filter((l) => l.startsWith("\\ir "))
      .map((l) => l.slice(4).trim());
    expect(ir).toEqual([
      "166-search-overstem-guard-setup.sql",
      "../../../supabase/migrations/166_search_overstem_guard.sql",
      "../../../supabase/migrations/172_search_exempt_word_tier.sql",
      "../../../supabase/migrations/185_search_sibling_variants.sql",
      "../../../supabase/migrations/185_search_sibling_variants.sql",
    ]);
    expect(dry).toContain(BASE_MD5);
    expect(dry).toContain(String(BASE_LENGTH));
    expect(dry).toContain(md5(raw185));
    expect(dry.trimEnd().endsWith("\\echo DRYRUN 185 OK")).toBe(true);
    // the header lines tests/migrations/live-harness.test.ts requires of every dry-run
    expect(dry).toContain("-f tests/migrations/sql/stub.sql");
    expect(dry).toContain("D=$(mktemp -d)");
    expect(dry).toContain("-- or: bash tests/migrations/sql/run-live.sh");
  });

  it("the dry-run shows the defect on 172's body, then 185: the typed form finds nothing, the sibling is found, a fourth variant is read by 185 only, the controls keep 172's list", () => {
    for (const q of ["elektrik zammı", "emlak vergisi", "ısıtma zammı", "trafik cezası"]) expect(dry, q).toContain(`'${q}'`);
    for (const q of ["burdur", "iran", "miller", "messi"]) expect(dry, q).toContain(`'${q}'`);
    expect(dry).toContain("baseline: 172");
    expect(dry).toContain("p_variants[4]");
    expect(dry).toContain("explain (analyze)");
    expect(dry).toContain("1.3");
    expect(dry).toContain("rollback;");
  });
});

// ---------------------------------------------------------------------------
// Live block (opt-in). TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/PGDATABASE point at a THROWAWAY database
// that the dry-run script left behind with 129, 166, 172 and 185 applied (tests/migrations/sql/live-manifest.txt). Every
// scenario runs inside begin ... rollback: it seeds clusters, runs 172's body (as a pg_temp function made from the text of
// 172's migration file) and the installed 185 function side by side, and checks the contracts of 185:
//   (1) a call with at most three variants returns exactly 172's ordered list;
//   (2) a fourth, fifth or sixth variant is read by 185 and ignored by 172;
//   (3) the typed spellings first, the sibling's after them, is what the app sends: the sibling rows are found, and the
//       rows 172 found stay.
// ---------------------------------------------------------------------------

interface Seed {
  key: string;
  title: string;
  summary: string;
  hoursAgo: number;
}

const SEEDS: Seed[] = [
  // elektrik zam: the stored stem is 'zam', the typed 'zammı' stem is 'zammı'
  { key: "elektrikZam1", title: "Elektriğe zam geldi", summary: "Zam oranı açıklandı.", hoursAgo: 1 },
  { key: "elektrikZam2", title: "Elektrik tarifesine zam yapıldı", summary: "Yeni tarife yürürlükte.", hoursAgo: 2 },
  { key: "elektrikZammi", title: "Elektrik zammı sonrası tepki", summary: "Tepki çoğaldı.", hoursAgo: 3 },
  { key: "elektrikOnly", title: "Elektrik kesintisi yaşandı", summary: "Kesinti sürdü.", hoursAgo: 4 },
  // emlak vergisi: 'vergisinde' stems to 'vergi', the typed 'vergisi' to 'vergis'
  { key: "emlakVergi", title: "Emlak vergisinde değişiklik", summary: "Yeni oran duyuruldu.", hoursAgo: 5 },
  { key: "emlakVergisi", title: "Emlak vergisi ödemeleri başladı", summary: "Ödemeler sürüyor.", hoursAgo: 6 },
  { key: "gelirVergi", title: "Gelir vergisi dilimleri belli oldu", summary: "Dilimler yenilendi.", hoursAgo: 7 },
  // ısıtma zammı: three typed spellings, the sibling's are the variants 4 to 6
  { key: "isitmaZam", title: "Isıtma zam haberi", summary: "Isıtma giderlerine zam.", hoursAgo: 8 },
  // controls: no sibling, and a doubled consonant that is not listed
  { key: "burdur", title: "Burdur'da yurt zehirlenmesi", summary: "Öğrenciler hastaneye kaldırıldı.", hoursAgo: 1 },
  { key: "bursa", title: "Bursa'da deprem uyarısı", summary: "Uzmanlar uyardı.", hoursAgo: 2 },
  { key: "miller", title: "Miller açıklama yaptı", summary: "Açıklama geldi.", hoursAgo: 10 },
  { key: "milMili", title: "Mili Eğitim Bakanlığı toplantısı", summary: "Toplantı yapıldı.", hoursAgo: 11 },
  { key: "messi", title: "Messi gol attı", summary: "Maç bitti.", hoursAgo: 12 },
  { key: "iran", title: "İran açıklama yaptı", summary: "Tahran'dan.", hoursAgo: 13 },
];

const seedId = (i: number): string => `00000000-0000-4000-8000-${String(185000 + i).padStart(12, "0")}`;
const KEY_BY_ID = new Map(SEEDS.map((s, i) => [seedId(i), s.key]));

const lit = (s: string): string => `'${s.replaceAll("'", "''")}'`;

interface LiveQuery {
  name: string;
  variants: string[];
  folded: string;
}

/** The arguments the app sends before (typed spellings only) and after the sibling change. */
const LIVE_QUERIES: LiveQuery[] = [
  { name: "elektrik typed", variants: ["elektrik zammı", "elektrik zammi"], folded: "elektrik zammi" },
  { name: "elektrik app", variants: ["elektrik zammı", "elektrik zammi", "elektrik zam"], folded: "elektrik zammi" },
  { name: "emlak typed", variants: ["emlak vergisi"], folded: "emlak vergisi" },
  { name: "emlak app", variants: ["emlak vergisi", "emlak vergi"], folded: "emlak vergisi" },
  { name: "isitma typed", variants: ["ısıtma zammı", "isitma zammi", "isıtma zammı"], folded: "isitma zammi" },
  { name: "isitma app", variants: ["ısıtma zammı", "isitma zammi", "isıtma zammı", "ısıtma zam", "isitma zam", "isıtma zam"], folded: "isitma zammi" },
  { name: "fourth only", variants: ["zzqx1", "zzqx2", "zzqx3", "elektrik zam"], folded: "zzqx1" },
  { name: "sixth only", variants: ["zzqx1", "zzqx2", "zzqx3", "zzqx4", "zzqx5", "elektrik zam"], folded: "zzqx1" },
  { name: "burdur", variants: ["burdur"], folded: "burdur" },
  { name: "miller", variants: ["miller"], folded: "miller" },
  { name: "messi", variants: ["messi"], folded: "messi" },
  { name: "iran", variants: ["iran"], folded: "iran" },
  { name: "empty", variants: [""], folded: "" },
];

describe.runIf(Boolean(process.env.TAYF_PSQL))("185 search sibling variants against a live Postgres (129, 166, 172 and 185 applied)", () => {
  assertLiveReady("185", {
    ledger: ["129", "166", "172", "185"],
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

  /** 172's function, from the text of 172's migration file, as a pg_temp function of the same shape. */
  const FN_172 =
    "create function pg_temp.f172(p_variants text[], p_folded text, p_limit integer default 12) returns table (id uuid) " +
    `language sql stable set search_path = '' as $fn$${raw172}$fn$;`;

  const rows = SEEDS.map(
    (s, i) => `(${lit(seedId(i))}, ${lit(s.title)}, null, ${lit(s.summary)}, 2, false, now() - interval '${s.hoursAgo} hours')`,
  ).join(",\n");

  const list = (fn: string, q: LiveQuery): string =>
    `select ${lit(`${q.name}|${fn === "pg_temp.f172" ? "172" : "185"}|`)} || coalesce((select string_agg(t.id::text, ',' order by t.n) ` +
    `from ${fn}(${arr(q.variants)}, ${lit(q.folded)}, 50) with ordinality as t(id, n)), '');`;

  const script = [
    "begin;",
    FN_172,
    `insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at) values\n${rows};`,
    "analyze public.clusters;",
    ...LIVE_QUERIES.flatMap((q) => [list("pg_temp.f172", q), list("public.search_cluster_ids", q)]),
    "rollback;",
  ].join("\n");

  const ids172 = new Map<string, string[]>();
  const ids185 = new Map<string, string[]>();
  let ran = false;
  const run = (): void => {
    if (ran) return;
    ran = true;
    for (const line of runPsql(script).split("\n")) {
      if (line === "") continue;
      const [name, which, ids] = line.split("|") as [string, string, string];
      const keys = ids === "" ? [] : ids.split(",").map((id) => KEY_BY_ID.get(id) ?? `?${id}`);
      (which === "172" ? ids172 : ids185).set(name, keys);
    }
  };

  const keysOf = (m: Map<string, string[]>, name: string): string[] => {
    run();
    const v = m.get(name);
    expect(v, `no result for ${name}`).toBeDefined();
    return v as string[];
  };

  it("the fixture reproduces the defect on 172's body: the typed spellings find nothing, or a different row, than the sibling", () => {
    expect(keysOf(ids172, "elektrik typed")).toEqual(["elektrikZammi"]);
    expect(keysOf(ids172, "emlak typed")).toEqual(["emlakVergisi"]);
    expect(keysOf(ids172, "isitma typed")).toEqual([]);
  });

  it.each(LIVE_QUERIES.filter((q) => q.variants.length <= 3).map((q) => [q.name, q] as [string, LiveQuery]))(
    "'%s' (at most three variants): 185 returns exactly 172's ordered list",
    (_name, q) => {
      expect(keysOf(ids185, q.name)).toEqual(keysOf(ids172, q.name));
    },
  );

  it("'elektrik zammı' as the app sends it: the Zam rows are found and the typed row stays; 172 (first three variants) already finds them", () => {
    const got = keysOf(ids185, "elektrik app");
    expect([...got].sort()).toEqual(["elektrikZam1", "elektrikZam2", "elektrikZammi"]);
    expect(got).toEqual(keysOf(ids172, "elektrik app"));
  });

  it("'emlak vergisi' as the app sends it: the vergisinde row is found next to the typed row", () => {
    const got = keysOf(ids185, "emlak app");
    expect([...got].sort()).toEqual(["emlakVergi", "emlakVergisi"]);
    expect(got).toEqual(keysOf(ids172, "emlak app"));
  });

  it("a sibling that lands at the variants 4 to 6 ('ısıtma zammı'): 185 finds the Zam row and 172 does not", () => {
    expect(keysOf(ids185, "isitma app")).toEqual(["isitmaZam"]);
    expect(keysOf(ids172, "isitma app")).toEqual([]);
  });

  it("the fourth and the sixth variant are read by 185 only", () => {
    for (const name of ["fourth only", "sixth only"]) {
      expect(keysOf(ids172, name), name).toEqual([]);
      expect([...keysOf(ids185, name)].sort(), name).toEqual(["elektrikZam1", "elektrikZam2"]);
    }
  });

  it("controls with one spelling keep 172's list: burdur (guarded), miller (tiered), messi, iran, and the empty query", () => {
    for (const name of ["burdur", "miller", "messi", "iran", "empty"]) expect(keysOf(ids185, name), name).toEqual(keysOf(ids172, name));
    expect(keysOf(ids185, "burdur")).toEqual(["burdur"]);
    expect(keysOf(ids185, "empty")).toEqual([]);
  });

  it("is applied once: one ledger row for 185 after two applications, one overload, 172's attributes and ACL, the body of the file", () => {
    const out = runPsql(`
select (select count(*) from supabase_migrations.schema_migrations where version = '185'),
       (select count(*) from pg_catalog.pg_proc where proname = 'search_cluster_ids' and pronamespace = 'public'::regnamespace and pg_get_function_identity_arguments(oid) = 'p_variants text[], p_folded text, p_limit integer'),
       p.prosecdef, p.provolatile, (p.proconfig = array['search_path=""']), p.proacl::text, md5(p.prosrc), length(p.prosrc),
       has_function_privilege('anon', p.oid, 'execute'), has_function_privilege('authenticated', p.oid, 'execute'),
       has_function_privilege('service_role', p.oid, 'execute'),
       (select l.lanname from pg_catalog.pg_language l where l.oid = p.prolang),
       obj_description(p.oid, 'pg_proc') like '%185%'
  from pg_catalog.pg_proc p
 where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
`).trim();
    const f = out.split("|");
    expect(f[0]).toBe("1"); // ledger rows for 185
    expect(f[1]).toBe("1"); // one three-argument overload
    expect(f[2]).toBe("t"); // security definer
    expect(f[3]).toBe("s"); // stable
    expect(f[4]).toBe("t"); // search_path = ''
    expect(f[5]).toBe(BASE_PROACL);
    expect(f[6]).toBe(md5(raw185)); // the function in the database is the body of the file
    expect(f[7]).toBe(String(pgLength(raw185)));
    expect(f[8]).toBe("f"); // anon
    expect(f[9]).toBe("f"); // authenticated
    expect(f[10]).toBe("t"); // service_role
    expect(f[11]).toBe("sql");
    expect(f[12]).toBe("t"); // the comment names 185
  });
});
