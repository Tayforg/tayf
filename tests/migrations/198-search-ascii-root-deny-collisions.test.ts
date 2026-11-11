import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { foldTr, turkishQueryVariants } from "@/lib/clusters/turkish-query";
import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Contract test for migration 198 ("ASCII roots that collide with other words"), h130-searchpost-1 (hunt 131).
//
// 196's helper public.tayf_ascii_inflection_expand(tsquery) ORs every [a-z] lexeme of the stem-fold arm's query with the closed
// suffix-strip roots its ending can only mean. A base-form word or a name that ends like an inflection reaches, through R1 or R2, the
// stem of a DIFFERENT, more frequent word: mardin -> mardi -> (d -> t) mart, yorgun -> yorgu -> (g -> k) york, kurti -> kurt,
// karasu -> kara, baski -> bask, toplu -> topl, karsi -> kars. On production (2026-11-11) 'mardin kaza' listed an unrelated 190-day-old
// story, 'yorgun' listed New York rows, 'Kurti' put Kurtulmus and Kurt first, 'baski' and 'toplu' pulled in 'baskin' and 'sivil toplum'.
//
// 198 replaces ONLY the helper: its text is 196's byte for byte except ONE literal, the closed deny set (ilisk, turk, sevk of 196, and
// mart, york, kurt, kara, bask, topl, kars of 198). search_cluster_ids is not touched. This file pins, without a database: the file,
// ledger and transaction, that the helper is 196's with one literal changed (md5 of 196's text pinned), the deny set, a model of the
// helper's rules (which proves what each lexeme keeps with 196's deny set and with 198's), that search_cluster_ids is not redefined
// (its 196 md5 is recomputed), the header, the docs section, the dry-run and the live-manifest entry. The opt-in live block (TAYF_PSQL)
// runs 196's two functions (as pg_temp copies made from the text of 196's file) and the installed 198 function side by side on
// fixtures inside a rolled-back transaction, and pins the helper's output text.
//
// No regular expression is applied to quoted SQL literals in this file (CodeQL js/redos): the SQL is scanned with indexOf and
// character loops. The few regular expressions below read short constant lexemes, never SQL text.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const FILE_198 = "198_search_ascii_root_deny_collisions.sql";
const MIGRATION_198 = resolve(MIGRATIONS_DIR, FILE_198);
const MIGRATION_196 = resolve(MIGRATIONS_DIR, "196_search_ascii_inflection_roots.sql");
const DRYRUN_198 = resolve(ROOT, "tests", "migrations", "sql", "198-search-ascii-root-deny-collisions-dryrun.sql");
const MANIFEST = resolve(ROOT, "tests", "migrations", "sql", "live-manifest.txt");
const DOC_MIGRATION_GUIDE = resolve(ROOT, "docs", "migration-guide.md");

/** md5 and length of 196's helper text (the base of 198, and what production runs: read-only, 2026-11-11). */
const HELPER_196_MD5 = "bcd7b393693a64a5f6123b0ebd855e3d";
const HELPER_196_LENGTH = 5077;
/** md5 and length of 196's search_cluster_ids body: it stays as it is (198 does not touch it). */
const FN_196_MD5 = "c384c1f3a0dc337e5243b5a3e55985c0";
const FN_196_LENGTH = 19562;
const PROD_PROACL = "{postgres=X/postgres,service_role=X/postgres}";

const LEDGER_STMT =
  "insert into supabase_migrations.schema_migrations (version, name) values ('198', '198_search_ascii_root_deny_collisions') on conflict do nothing;";
const REVOKE_HELPER = "revoke all on function public.tayf_ascii_inflection_expand(tsquery) from public, anon, authenticated;";
const GRANT_HELPER = "grant execute on function public.tayf_ascii_inflection_expand(tsquery) to service_role;";

const HELPER_HEADER =
  "create or replace function public.tayf_ascii_inflection_expand(p tsquery) returns tsquery language plpgsql immutable strict parallel safe set search_path = ''";

/** The deny literal of 196 and of 198: the ONLY text that differs between the two helpers. */
const OLD_DENY = "array['ilisk', 'turk', 'sevk']::pg_catalog.text[]";
const NEW_ROOTS = ["mart", "york", "kurt", "kara", "bask", "topl", "kars"] as const;
const OLD_ROOTS = ["ilisk", "turk", "sevk"] as const;
const NEW_DENY = "array['ilisk', 'turk', 'sevk', 'mart', 'york', 'kurt', 'kara', 'bask', 'topl', 'kars']::pg_catalog.text[]";

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

/** The `## <number> ` section of the guide, up to the next `## ` heading. */
function sectionOf(guide: string, number: string): string {
  const start = guide.indexOf(`\n## ${number} `);
  if (start < 0) return "";
  const next = guide.indexOf("\n## ", start + 1);
  return guide.slice(start, next < 0 ? guide.length : next);
}

/**
 * A model of the helper's rules, for ONE lexeme: the roots it keeps for a given deny set. It mirrors the text of 196's helper (R1 with the
 * geminate skip and the soft-letter copy, R2, R3, the 4-letter floor, once, in the order found, not on the deny set). The live block checks
 * the model against Postgres, so a drift of either side fails there.
 */
function modelRoots(lexeme: string, deny: readonly string[]): string[] {
  const roots: string[] = [];
  if (/^[a-z]{3,}[b-df-hj-np-tv-z][iu]$/.test(lexeme)) {
    const root = lexeme.slice(0, -1);
    if (root.at(-1) !== root.at(-2)) {
      roots.push(root);
      const alt = ({ g: "k", b: "p", d: "t" } as Record<string, string>)[root.at(-1) as string];
      if (alt !== undefined) roots.push(root.slice(0, -1) + alt);
    }
  }
  if (/^[a-z]{2,}[aeiou]s[iu]$/.test(lexeme)) roots.push(lexeme.slice(0, -2));
  if (/^[a-z]{3,}l[ae]r[iu]$/.test(lexeme)) roots.push(lexeme.slice(0, -4));
  if (/^[a-z]{3,}l[ae]r[iu]n$/.test(lexeme)) roots.push(lexeme.slice(0, -5));
  const keep: string[] = [];
  for (const r of roots) {
    if (r.length >= 4 && r !== lexeme && !keep.includes(r) && !deny.includes(r)) keep.push(r);
  }
  return keep;
}

/** The text the helper prints for ONE lexeme with these kept roots. */
function modelText(lexeme: string, roots: readonly string[]): string {
  return roots.length === 0 ? `'${lexeme}'` : [lexeme, ...roots].map((r) => `'${r}'`).join(" | ");
}

const DENY_196: readonly string[] = [...OLD_ROOTS];
const DENY_198: readonly string[] = [...OLD_ROOTS, ...NEW_ROOTS];

/** The seven collisions (the ASCII lexeme the stem query holds, then 196's roots, then 198's) and what 198 does to them. */
const COLLISION_LEXEMES: Array<[string, string[], string[]]> = [
  ["mardi", ["mard", "mart"], ["mard"]], // mardin: the soft letter d -> t reaches the stem mart (the month)
  ["yorgu", ["yorg", "york"], ["yorg"]], // yorgun: the soft letter g -> k reaches the stem york (New York)
  ["kurti", ["kurt"], []], // Kurti: kurt (the wolf, Kurt, Kurtlar Vadisi)
  ["karasu", ["karas", "kara"], ["karas"]], // Karasu: R2 reaches kara (black, ashore)
  ["baski", ["bask"], []], // baski: bask is the stem of baskin (raid)
  ["toplu", ["topl"], []], // toplu: topl is the stem of toplum (society)
  ["karsi", ["kars"], []], // karsi: kars is the province
];
/** The widenings 196 exists for, and the roots that stay on a real inflection: identical under both deny sets. */
const KEPT_LEXEMES: Array<[string, string[]]> = [
  ["maasi", ["maas"]],
  ["siginagi", ["siginag", "siginak"]],
  ["maaslari", ["maaslar", "maas"]],
  ["cocugu", ["cocug", "cocuk"]],
  ["guvenligi", ["guvenlig", "guvenlik"]],
  ["sonuclari", ["sonuclar", "sonuc"]],
  ["vergisi", ["vergis", "vergi"]],
  ["cezasi", ["cezas", "ceza"]],
  ["kitabi", ["kitab", "kitap"]],
  ["tokadi", ["tokad", "tokat"]], // tokadi is the real inflection of tokat (the slap)
  ["tehdidi", ["tehdid", "tehdit"]], // tehdidi is wanted: the soft d of tehdit
  ["parti", ["part"]], // KNOWN LIMITS 2 of 196: bounded by the AND with the other words
  ["kenti", ["kent"]], // no page change measured
  ["sevgi", ["sevg"]],
  ["zammi", []],
  ["hakki", []],
  ["iliski", []],
  ["turku", []],
];

let sql = "";
let code = "";
let head = "";
let helperRaw = "";
let helperBlockCode = "";
let helperCode = "";

if (existsSync(MIGRATION_198)) {
  sql = readFileSync(MIGRATION_198, "utf8");
  code = stripComments(sql);
  head = sql.slice(0, sql.indexOf("\nbegin;"));
  helperRaw = fnBody(functionBlock(sql, "tayf_ascii_inflection_expand"));
  helperBlockCode = functionBlock(code, "tayf_ascii_inflection_expand");
  helperCode = collapse(fnBody(helperBlockCode));
}
const sql196 = readFileSync(MIGRATION_196, "utf8");
const helper196Raw = fnBody(functionBlock(sql196, "tayf_ascii_inflection_expand"));
const fn196Raw = fnBody(functionBlock(sql196, "search_cluster_ids"));
const helper196Code = collapse(fnBody(functionBlock(stripComments(sql196), "tayf_ascii_inflection_expand")));

describe("198 file, ledger and structure", () => {
  it("exists with the exact name, and no other migration claims the number 198", () => {
    expect(existsSync(MIGRATION_198)).toBe(true);
    const claimed = readdirSync(MIGRATIONS_DIR).filter((n) => n.startsWith("198_"));
    expect(claimed).toEqual([FILE_198]);
  });

  it("contains the ledger insert for '198' with on conflict do nothing, the last statement before commit", () => {
    const c = collapse(code);
    expect(c).toContain(LEDGER_STMT);
    expect(c.endsWith(`${LEDGER_STMT} commit;`)).toBe(true);
  });

  it("is wrapped in a single begin/commit, sets lock_timeout 5s first, and the helper is its first statement", () => {
    const c = collapse(code);
    expect(countOf(c, "begin;")).toBe(1);
    expect(countOf(c, "commit;")).toBe(1);
    expect(c.startsWith("begin; set local lock_timeout = '5s'; create or replace function public.tayf_ascii_inflection_expand(")).toBe(true);
    expect(c.endsWith("commit;")).toBe(true);
  });

  it("is additive only: one function replace (the helper), one comment, the ledger row; no drop, alter, truncate, update, delete, table, index or trigger", () => {
    const bare = sansStrings(code).toLowerCase();
    for (const bad of ["drop ", "alter ", "truncate", "delete ", "update ", "create table", "create unique", "create index", "create trigger", "create view", "create extension", "create function"]) {
      expect(bare.includes(bad), bad).toBe(false);
    }
    expect(countOf(bare, "create or replace function")).toBe(1);
    expect(countOf(bare, "insert into ")).toBe(1);
    expect(countOf(bare, "comment on ")).toBe(1);
    expect(bare).toContain("insert into supabase_migrations.schema_migrations");
  });

  it("does not define, replace, comment, revoke or grant search_cluster_ids: that function (and 083's overload) is not touched", () => {
    expect(code).not.toContain("create or replace function public.search_cluster_ids");
    expect(code).not.toContain("on function public.search_cluster_ids");
    // (the helper's comment string names the function in prose; the statements and the helper text never do)
    expect(countOf(sansStrings(code), "search_cluster_ids")).toBe(0);
    // the header says so
    expect(head).toContain("search_cluster_ids is NOT redefined");
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
    expect(c).toContain(REVOKE_HELPER);
    expect(c).toContain(GRANT_HELPER);
    expect(c.indexOf(REVOKE_HELPER)).toBeLessThan(c.indexOf(GRANT_HELPER));
  });

  it("reloads the PostgREST schema cache after the grant and before the ledger insert", () => {
    const c = collapse(code);
    expect(c).toContain("notify pgrst, 'reload schema';");
    expect(c.indexOf("notify pgrst")).toBeLessThan(c.indexOf("insert into supabase_migrations"));
    expect(c.indexOf("notify pgrst")).toBeGreaterThan(c.indexOf(GRANT_HELPER));
  });

  it("single-quote characters balance once comments are stripped (no string literal holds two dashes)", () => {
    expect(countOf(code, "'") % 2).toBe(0);
  });

  it("takes the number 198 and leaves 197 (a held migration of another branch) and 191 (reserved) alone: it writes neither ledger row and no file of either number is claimed", () => {
    expect(code).not.toContain("'197'");
    expect(code).not.toContain("'191'");
    expect(head).toContain("197");
    expect(head).toContain("191");
    expect(head).toContain("196");
    expect(existsSync(resolve(MIGRATIONS_DIR, "191_trends_entity_rollup_minister_forms.sql"))).toBe(true);
    expect(readdirSync(MIGRATIONS_DIR).filter((n) => n.startsWith("191_"))).toEqual(["191_trends_entity_rollup_minister_forms.sql"]);
    // the number gap is deliberate: the head says why no guard needs a contiguous chain
    expect(head).toContain("197 is reserved");
  });
});

describe("198 helper public.tayf_ascii_inflection_expand(tsquery)", () => {
  it("is plpgsql, IMMUTABLE, STRICT, PARALLEL SAFE, search_path '' and not security definer: 196's attributes, same signature", () => {
    expect(collapse(fnHeader(helperBlockCode))).toBe(HELPER_HEADER);
    expect(collapse(fnHeader(helperBlockCode))).not.toContain("security definer");
    expect(collapse(fnHeader(functionBlock(stripComments(sql196), "tayf_ascii_inflection_expand")))).toBe(collapse(fnHeader(helperBlockCode)));
    expect(countOf(code, "create or replace function public.tayf_ascii_inflection_expand(")).toBe(1);
  });

  it("196's helper text is the base: its md5 and length are the recorded ones (production runs it, read-only, 2026-11-11)", () => {
    expect(md5(helper196Raw)).toBe(HELPER_196_MD5);
    expect(pgLength(helper196Raw)).toBe(HELPER_196_LENGTH);
  });

  it("the helper text is 196's byte for byte, comments included, except ONE literal: the closed deny set", () => {
    expect(countOf(helper196Raw, OLD_DENY)).toBe(1);
    expect(countOf(helperRaw, OLD_DENY)).toBe(0);
    expect(countOf(helperRaw, NEW_DENY)).toBe(1);
    expect(helper196Raw.replace(OLD_DENY, NEW_DENY)).toBe(helperRaw);
    expect(helperRaw).not.toBe(helper196Raw);
    // the collapsed code (comments stripped) differs by that literal too, and by nothing else
    expect(helper196Code.replace(OLD_DENY, NEW_DENY)).toBe(helperCode);
    expect(md5(helperRaw)).not.toBe(HELPER_196_MD5);
  });

  it("the deny set is a closed literal in the keep loop: 196's three roots first, then the seven new ones, each once, none shorter than 4 letters", () => {
    const at = helperCode.indexOf("array['");
    expect(at).toBeGreaterThan(helperCode.indexOf("foreach v_root in array v_roots loop"));
    expect(countOf(helperCode, "array['")).toBe(1);
    expect(helperCode).toContain(`and not (v_root = any (${NEW_DENY}))`);
    const list = [...DENY_198];
    expect(list).toEqual(["ilisk", "turk", "sevk", "mart", "york", "kurt", "kara", "bask", "topl", "kars"]);
    expect(new Set(list).size).toBe(list.length);
    for (const r of list) expect(r.length, r).toBeGreaterThanOrEqual(4);
    for (const r of NEW_ROOTS) expect(countOf(NEW_DENY, `'${r}'`), r).toBe(1);
  });

  it("no root a wanted widening needs is on the deny set (maas, siginag, siginak, cocuk, guvenlik, sonuc, vergi, ceza, kitap, tokat, tehdit, part, kent, sevg)", () => {
    for (const r of ["maas", "maaslar", "siginag", "siginak", "cocug", "cocuk", "guvenlig", "guvenlik", "sonuc", "sonuclar", "vergi", "vergis", "ceza", "cezas", "kitab", "kitap", "tokad", "tokat", "tehdid", "tehdit", "part", "kent", "sevg"]) {
      expect(DENY_198, r).not.toContain(r);
    }
  });

  it("the model of the rules: with 196's deny set each colliding lexeme keeps its colliding root, with 198's it does not (the seven collisions)", () => {
    for (const [lex, before, after] of COLLISION_LEXEMES) {
      expect(modelRoots(lex, DENY_196), `${lex} under 196`).toEqual(before);
      expect(modelRoots(lex, DENY_198), `${lex} under 198`).toEqual(after);
      // the roots 198 removed are exactly the seven it denies, one per lexeme here
      const removed = before.filter((r) => !after.includes(r));
      expect(removed.length, lex).toBe(1);
      expect(NEW_ROOTS as readonly string[], lex).toContain(removed[0]);
    }
    // every new root is the one root some colliding lexeme loses
    expect(COLLISION_LEXEMES.map(([, before, after]) => before.filter((r) => !after.includes(r))[0]).sort()).toEqual([...NEW_ROOTS].sort());
  });

  it("the model of the rules: the wanted widenings and the real inflections keep every root, under both deny sets", () => {
    for (const [lex, roots] of KEPT_LEXEMES) {
      expect(modelRoots(lex, DENY_196), `${lex} under 196`).toEqual(roots);
      expect(modelRoots(lex, DENY_198), `${lex} under 198`).toEqual(roots);
    }
  });

  it("the cost of the closed list is the plural-possessive form of a denied root: kurtlari no longer reaches kurt, karalari no longer reaches kara (documented, KNOWN LIMITS)", () => {
    expect(modelRoots("kurtlari", DENY_196)).toEqual(["kurtlar", "kurt"]);
    expect(modelRoots("kurtlari", DENY_198)).toEqual(["kurtlar"]);
    expect(modelRoots("karalari", DENY_196)).toEqual(["karalar", "kara"]);
    expect(modelRoots("karalari", DENY_198)).toEqual(["karalar"]);
    expect(head).toContain("kurtlari");
    expect(head).toContain("karalari");
  });

  it("is a closed list on purpose, not a data rule: the helper reads no table, so it can stay IMMUTABLE", () => {
    const lower = helperCode.toLowerCase();
    for (const bad of ["public.", " from public", "pg_stats", "ts_stat", "pg_class", "clusters", "execute", "exception", "ts_rewrite"]) {
      expect(lower.includes(bad), bad).toBe(false);
    }
  });

  it("has a function comment that names 198 and 196, the ten roots, the seven collisions, the ASCII stemmer limit and service_role", () => {
    const c = collapse(code);
    const at = c.indexOf("comment on function public.tayf_ascii_inflection_expand(tsquery) is");
    expect(at).toBeGreaterThan(-1);
    const comment = c.slice(at, c.indexOf("revoke all", at));
    for (const word of [
      "198", "196", "R1", "R2", "R3", "4 letters", "k, p or t", "maasi", "siginag", "maaslari", "Turkish stemmer", "186", "unchanged", "IMMUTABLE", "STRICT", "service_role only",
      "ilisk, turk, sevk", "mart, york, kurt, kara, bask, topl, kars", "mardin -> mart", "yorgun -> york", "kurti -> kurt", "karasu -> kara", "baski -> bask", "toplu -> topl", "karsi -> kars",
    ]) {
      expect(comment, word).toContain(word);
    }
  });
});

describe("198 leaves search_cluster_ids alone", () => {
  it("196's body, which calls the helper by name, is the body production runs: its md5 and length are recomputed from 196's file", () => {
    expect(md5(fn196Raw)).toBe(FN_196_MD5);
    expect(pgLength(fn196Raw)).toBe(FN_196_LENGTH);
    expect(countOf(fn196Raw, "public.tayf_ascii_inflection_expand(")).toBe(1);
  });

  it("the header records that md5 as unchanged, and the verify block expects it again", () => {
    expect(head).toContain(FN_196_MD5);
    expect(head).toContain(String(FN_196_LENGTH));
    const at = head.indexOf("\n-- VERIFY");
    expect(at).toBeGreaterThan(-1);
    expect(head.slice(at, head.indexOf("\n-- Safe to re-apply", at))).toContain(`expect ${FN_196_MD5}, ${FN_196_LENGTH}`);
  });
});

describe("198 header", () => {
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

  it("documents WHY, WHAT, BASE, STEP 0, REPLAY, COST, KNOWN LIMITS, LEDGER, VERIFY and ROLLBACK, and names the hunt and the numbering", () => {
    for (const s of ["WHY", "WHAT", "BASE", "STEP 0", "REPLAY", "COST", "KNOWN LIMITS", "LEDGER", "VERIFY", "ROLLBACK"]) {
      expect(head, s).toContain(`\n-- ${s}`);
    }
    expect(head).toContain("h130-searchpost-1");
    expect(head).toContain("hunt 131");
    expect(head).toContain("This file takes the number 198");
    expect(head).toContain("197 is reserved");
    expect(head).toContain("no guard requires a contiguous chain");
  });

  it("records the md5 and length of the NEW helper, and they match this file (the test recomputes them)", () => {
    const newMd5 = md5(helperRaw);
    expect(newMd5).not.toBe(HELPER_196_MD5);
    const verify = section("VERIFY", "Safe to re-apply");
    expect(verify).toContain(`expect ${newMd5}, ${pgLength(helperRaw)}, i, s, true, false, false, false, true, ${PROD_PROACL}.`);
  });

  it("WHY names the live evidence: the seven expansions, the stem-fold counts with their date, the live function results and the two GETs", () => {
    const why = prose(section("WHY", "WHAT"));
    for (const word of [
      "2026-11-11", "tayf_ascii_inflection_expand", "'mardi' | 'mard' | 'mart'", "'yorgu' | 'yorg' | 'york'", "'kurti' | 'kurt'", "'karasu' | 'karas' | 'kara'", "'baski' | 'bask'", "'toplu' | 'topl'", "'karsi' | 'kars'",
      "mardi 56 / mart 153", "yorgu 6 / york 268", "kurti 5 / kurt 147", "karasu 27 / kara 53", "baski 200 / bask 150", "toplu 169 / topl 238", "karsi 1,427 / kars 90",
      "64a92b61", "190 d", "59cd0882", "a1cb2b80", "366d9913", "Kurtulmuş", "Kosova Kurti story is rank 7", "karaya oturdu", "Zeydan Karalar", "baskın", "sivil toplum",
      "/?q=mardin%20kaza", "Arşivden: 1 sonuç", "Eylem Tok", "/?q=yorgun", "New York Times", "New York senatörü", "New York Eyalet Senatosu", "196 shipped", "#267",
    ]) {
      expect(why, word).toContain(word);
    }
  });

  it("WHAT states the rule, the ten-root deny literal, what changes and what does not, and the roots considered and NOT denied with their reasons", () => {
    const what = prose(section("WHAT", "BASE"));
    for (const word of [
      "ONE literal", "byte for byte", "IMMUTABLE, STRICT, PARALLEL SAFE", "search_path = ''", "service_role only", "search_cluster_ids is NOT redefined", FN_196_MD5,
      "a base-form word or a name reaches, through R1/R2, the stem of a DIFFERENT, more frequent lemma", "mardin->mart", "yorgun->york", "kurti->kurt", "karasu->kara", "baskı->bask", "toplu->topl", "karşı->kars",
      "ilisk, turk, sevk, mart, york, kurt, kara, bask, topl and kars",
      "NOT denied", "tokat (tokadi is its real inflection)", "tehdit (tehdidi is wanted)", "part (196 KNOWN LIMITS 2, bounded by the AND)", "kent (no page change measured)",
      // the pinned output
      "mardin gives 'mardi' | 'mard'", "yorgun gives 'yorgu' | 'yorg'", "kurti gives 'kurti'", "karasu gives 'karasu' | 'karas'", "baski gives 'baski'", "toplu gives 'toplu'", "karsi gives 'karsi'",
      "emekli & maasi gives ( 'emekli' | 'emekl' ) & ( 'maasi' | 'maas' )", "siginagi gives 'siginagi' | 'siginag' | 'siginak'", "tokadi still carries tokat", "tehdidi still carries tehdit", "parti still carries part",
    ]) {
      expect(what, word).toContain(word);
    }
  });

  it("BASE records 196's helper fingerprint and the unchanged function; STEP 0 records the read-only production check", () => {
    const base = section("BASE", "STEP 0");
    for (const word of [HELPER_196_MD5, String(HELPER_196_LENGTH), FN_196_MD5, String(FN_196_LENGTH), PROD_PROACL, "production", "194"]) expect(base, word).toContain(word);
    const step0 = section("STEP 0", "REPLAY");
    for (const word of [HELPER_196_MD5, "5077", FN_196_MD5, "19562", "2026-11-11", "'196'"]) expect(step0, word).toContain(word);
  });

  it("KNOWN LIMITS says the list is closed, why no data rule works (the live counts), what the denial costs (the R3 forms) and what is deliberately left", () => {
    const limits = prose(section("KNOWN LIMITS", "LEDGER"));
    for (const word of [
      "closed on purpose", "a root is added only with a live count", "IMMUTABLE",
      // the principled rule was tried and rejected, with numbers
      "sonuclari, which must expand, has 20 stored rows", "tehdidi 122", "kurti 5", "yorgu 6", "no threshold", "maasi, siginagi, maaslari, cocugu, guvenligi, vergisi, cezasi and kitabi have 0",
      // the cost
      "kurtlari", "karalari", "R3", "kurt 147", "kara 53",
      "parti has the root 'part'", "tokadi", "tehdidi", "kenti",
    ]) {
      expect(limits, word).toContain(word);
    }
  });

  it("REPLAY holds the measured rows: the seven collisions (candidates 196 -> 198, rows lacking the typed word), the controls that keep their ids and order, and the cost of the closed list", () => {
    const replay = prose(section("REPLAY", "COST"));
    for (const word of [
      "SELECT only", "READ ONLY", "ONE statement", "the live helper", "equals the text 196's helper prints", "all 53 calls",
      // the seven collisions and the pairs, candidates 196 -> 198
      "mardin kaza 1 -> 0", "mardin saldırı 2 -> 0", "mardin belediyesi 7 -> 4", "mardin depremi 3 -> 2", "mardin 209 -> 56", "yorgun 274 -> 6", "kurti 152 -> 5", "karasu 83 -> 32",
      "baskı 345 -> 200", "baski 345 -> 200", "baskı altında 36 -> 25", "toplu 404 -> 169", "karşı çıktı 116 -> 109", "karsi cikti 116 -> 109",
      // the rows lacking the typed word in the page
      "lack 1 of 1 -> 0 of 0", "lack 22 of 24 -> 0 of 6", "lack 22 of 24 -> 0 of 5", "lack 12 of 24 -> 4 of 24", "lack 6 of 24 -> 0 of 24", "lack 2 of 24 -> 0 of 24",
      "64a92b61, 190 d old", "366d9913", "Kosova Kurti stories are ranks 1-3", "karası", "was 24 rows under 196 and is 6 rows under 198",
      // the controls: the same ids in the same order
      "36 of the 53 calls", "emekli maasi and emekli maaşı 89", "siginagi and sığınağı 15", "maaslari and maaşları 158", "cocugu and çocuğu 896", "guvenligi and güvenliği 1000",
      "secim sonuclari and seçim sonuçları 264", "asgari ucret zammi 0 and asgari ucret zam 7", "hakki and hakkı 200", "iliski 568", "turku 21", "sevgi 49", "tehdidi 538", "tokadi 82", "parti 1000",
      "deprem 438", "imamoglu and imamoğlu 603", "burdur 34", "miller 18", "Every 198 id set is contained in 196's (53 of 53)",
      // the cost of the closed list
      "kurtlari 147 -> 1", "karalari 53 -> 0", "kurtları 147 -> 58", "karaları 53 -> 53", "89 hold Kürt", "58 hold kurt",
    ]) {
      expect(replay, word).toContain(word);
    }
  });

  it("KNOWN LIMITS (6) records the one collision left on purpose (karas), why it stays, and the -su names that were not measured", () => {
    const limits = prose(section("KNOWN LIMITS", "LEDGER"));
    for (const word of ["One collision is left on purpose", "karas (R1; 5 live stem rows against karasu 27)", "karası", "'karasi' | 'karas'", "sarisu gives 'sarisu' | 'saris' | 'sari'", "akarsu 'akars'", "ilisu 'ilis'", "rule A", "no live count was taken"]) {
      expect(limits, word).toContain(word);
    }
  });

  it("COST says the helper stays free: a ten-entry array against three, once per call", () => {
    const cost = prose(section("COST", "KNOWN LIMITS"));
    for (const word of ["microseconds", "InitPlan", "ten", "plans", "194", "unchanged"]) expect(cost, word).toContain(word);
  });

  it("ROLLBACK: 196's helper statement and comment again (its md5), and the ledger row, in that order", () => {
    const r = section("ROLLBACK", "See tests/");
    expect(r).toContain("196_search_ascii_inflection_roots.sql");
    expect(r).toContain(HELPER_196_MD5);
    expect(r).toContain("delete from supabase_migrations.schema_migrations where version = '198';");
    expect(r).toContain("notify pgrst, 'reload schema';");
    expect(r).not.toContain("drop function");
  });
});

describe("198 docs/migration-guide.md", () => {
  const guide = readFileSync(DOC_MIGRATION_GUIDE, "utf8");
  const sec = sectionOf(guide, "198");

  it("has a 198 section, after section 196, that says APPLY 198", () => {
    expect(sec).not.toBe("");
    expect(sectionOf(guide, "196")).not.toBe("");
    expect(guide.indexOf("\n## 198 ")).toBeGreaterThan(guide.indexOf("\n## 196 "));
    expect(sec.split("\n")[1]).toContain("APPLY 198");
  });

  it("has Why, What, an md5 table, Replay, Order, Verify and Rollback", () => {
    for (const label of ["**Why:**", "**What 198 does**", "| | md5(prosrc) | length |", "**Replay**", "**Order:**", "**Verify**", "**Rollback:**"]) {
      expect(sec, label).toContain(label);
    }
  });

  it("records the md5 of 196's helper (the base), of 198's helper and of the unchanged function, matching the files", () => {
    expect(sec).toContain(`\`${HELPER_196_MD5}\` | ${HELPER_196_LENGTH}`);
    expect(sec).toContain(`\`${md5(helperRaw)}\` | ${pgLength(helperRaw)}`);
    expect(sec).toContain(`\`${FN_196_MD5}\` | ${FN_196_LENGTH}`);
  });

  it("states the order: apply after 196, no deploy order, no app change; 197 (held) and 191 (reserved) are not prerequisites", () => {
    const s = sec.slice(sec.indexOf("**Order:**"), sec.indexOf("**Verify**"));
    for (const word of ["198_search_ascii_root_deny_collisions.sql", "after 196", "no deploy order", "197", "191", "cached per query key"]) expect(s, word).toContain(word);
  });

  it("What 198 does names the rule, the ten roots, the one literal, and the roots considered and not denied", () => {
    const what = sec.slice(sec.indexOf("**What 198 does**"), sec.indexOf("| | md5(prosrc) | length |"));
    for (const word of [
      "`ilisk`", "`turk`", "`sevk`", "`mart`", "`york`", "`kurt`", "`kara`", "`bask`", "`topl`", "`kars`", "one literal", "`search_cluster_ids`", "not touched",
      "`tokat`", "`tehdit`", "`part`", "`kent`", "`mardin`", "`yorgun`", "`kurti`", "`karasu`",
    ]) {
      expect(what, word).toContain(word);
    }
  });

  it("verifies the fingerprints, the privileges, the ledger row, the helper output and the live pages; the rollback restores 196's helper", () => {
    const v = sec.slice(sec.indexOf("**Verify**"), sec.indexOf("**Rollback:**"));
    for (const word of [md5(helperRaw), FN_196_MD5, "has_function_privilege", "version = '198'", "'mardi' | 'mard'", "/?q=mardin%20kaza", "sonuç bulunamadı", "/?q=Kurti", "/?q=karasu"]) {
      expect(v, word).toContain(word);
    }
    const r = sec.slice(sec.indexOf("**Rollback:**"));
    for (const word of ["196_search_ascii_inflection_roots.sql", HELPER_196_MD5, "delete from supabase_migrations.schema_migrations where version = '198'"]) {
      expect(r, word).toContain(word);
    }
  });

  it("uses no fenced sql block (tests/guards/docs-sql-snippets.test.ts scans those)", () => {
    expect(sec).not.toContain("```");
  });
});

describe("198 dry-run and live manifest", () => {
  const dry = existsSync(DRYRUN_198) ? readFileSync(DRYRUN_198, "utf8") : "";

  it("builds 198's database with its own dry-run script: one run entry, that script as the only setup file", () => {
    const lines = readFileSync(MANIFEST, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("run | 198-search-ascii-root-deny-collisions.test.ts"));
    expect(lines).toEqual(["run | 198-search-ascii-root-deny-collisions.test.ts | tests/migrations/sql/198-search-ascii-root-deny-collisions-dryrun.sql | - | 0"]);
  });

  it("the dry-run builds 196's state (the 129 setup, 166, 172, 185, 186, 194, 196, gated on 196's helper md5), applies 198 twice and ends with its OK line", () => {
    expect(existsSync(DRYRUN_198)).toBe(true);
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
      "../../../supabase/migrations/198_search_ascii_root_deny_collisions.sql",
    ]);
    for (const s of [HELPER_196_MD5, String(HELPER_196_LENGTH), FN_196_MD5, String(FN_196_LENGTH), md5(helperRaw), String(pgLength(helperRaw))]) expect(dry, s).toContain(s);
    expect(dry.trimEnd().endsWith("\\echo DRYRUN 198 OK")).toBe(true);
    expect(dry).toContain("-f tests/migrations/sql/stub.sql");
    expect(dry).toContain("D=$(mktemp -d)");
    expect(dry).toContain("-- or: bash tests/migrations/sql/run-live.sh");
  });

  it("the dry-run shows the defect on 196's text, then 198: the seven collisions and their pairs, the pinned helper text, the wanted widenings, the controls, hostile strings do not raise", () => {
    for (const q of [
      "mardin kaza", "mardin", "yorgun", "kurti", "karasu", "baskı", "baski", "toplu", "karşı çıktı", "karsi cikti",
      "emekli maasi", "emekli maaşı", "siginagi", "sığınağı", "maaslari", "maaşları", "cocugu", "çocuğu", "guvenligi", "güvenliği", "secim sonuclari", "seçim sonuçları",
      "hakki", "iliski", "turku", "sevgi", "tokadi", "tehdidi", "parti", "akp alias", "kurtlari", "karalari",
    ]) {
      expect(dry, q).toContain(`'${q}'`);
    }
    for (const out of [
      "'mardi' | 'mard'", "'yorgu' | 'yorg'", "'karasu' | 'karas'", "( 'mardi' | 'mard' ) & 'kaz'", "'karsi' & 'cik'",
      "( 'emekli' | 'emekl' ) & ( 'maasi' | 'maas' )", "'siginagi' | 'siginag' | 'siginak'", "'maaslari' | 'maaslar' | 'maas'", "'tokadi' | 'tokad' | 'tokat'", "'tehdidi' | 'tehdid' | 'tehdit'", "'parti' | 'part'",
      "'kurtlari' | 'kurtlar'", "'karalari' | 'karalar'",
    ]) {
      expect(dry, out).toContain(out);
    }
    for (const w of ["'kurti'", "'baski'", "'toplu'", "'karsi'", "'zammi'", "'hakki'", "'iliski'", "'turku'", "'sevgi' | 'sevg'"]) expect(dry, w).toContain(w);
    for (const c of ["a.com/x''maasi", "x.co/a''maaslari", "a.com/x''kurti"]) expect(dry, c).toContain(c);
    for (const k of ["'mardM'", "'kurtulmus'", "'baskin'", "'toplum'", "'kars'", "'ny'", "'karaya'"]) expect(dry, k).toContain(k);
    expect(dry).toContain("baseline: 196");
    expect(dry).toContain("Fuzz");
    expect(dry).toContain("pg_temp.h196");
    expect(dry).toContain("pg_temp.f196");
  });
});

// ---------------------------------------------------------------------------
// Live block (opt-in). TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/PGDATABASE point at a THROWAWAY database that the dry-run
// script left behind with 129, 166, 172, 185, 186, 194, 196 and 198 applied (tests/migrations/sql/live-manifest.txt). Every scenario runs
// inside begin ... rollback: it seeds clusters, runs 196's two functions (pg_temp copies made from the text of 196's migration file: the
// helper and search_cluster_ids with the helper call pointed at the copy) and the installed 198 function side by side, and checks:
//   (1) 198's id set is contained in 196's for every call (denying roots only removes candidates);
//   (2) the seven collisions: 196 returns the unrelated row, 198 does not, and the right row stays, first;
//   (3) the wanted widenings, the Turkish spellings and every control keep EXACTLY 196's ids and order;
//   (4) the helper's output text is pinned and equals the model of the rules above.
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
  // 196's roots that are the stem of another word (geminate and deny set): hkB / ilB are the newer rows of the OTHER word
  { key: "hkA", title: "Umut hakkı yeniden tartışılıyor", summary: "Tartışma sürüyor.", members: 3, age: "3 days" },
  { key: "hkB", title: "Bakan hakkında soruşturma başlatıldı", summary: "Savcılık açıkladı.", members: 3, age: "1 day" },
  { key: "ilA", title: "Yeni ilişki dönemi başladı", summary: "Taraflar görüştü.", members: 2, age: "2 days" },
  { key: "ilB", title: "Duruma ilişkin açıklama yapıldı", summary: "Sözcü konuştu.", members: 2, age: "1 day" },
  // 198's seven collisions: for each, the row the word means (…K / the name) and the unrelated row that the colliding root pulled in
  { key: "mardM", title: "Mart ayında kaza sayısı arttı", summary: "Emniyet verileri açıkladı.", members: 4, age: "2 days" },
  { key: "mardK", title: "Mardin'de kaza: üç yaralı", summary: "Yaralılar hastaneye kaldırıldı.", members: 3, age: "3 days" },
  { key: "ny", title: "New York Times yeni haberini yayımladı", summary: "Gazete açıklama yaptı.", members: 3, age: "1 day" },
  { key: "yorg", title: "Yorgun düşen futbolcu sahadan alındı", summary: "Antrenör konuştu.", members: 3, age: "2 days" },
  { key: "kurtulmus", title: "Kurtulmuş Kürt meselesinde yeni adım dedi", summary: "Meclis toplandı.", members: 3, age: "1 day" },
  { key: "kurti", title: "Kurti Kosova hükümetini açıkladı", summary: "Priştine'de toplantı yapıldı.", members: 3, age: "2 days" },
  { key: "karaya", title: "Gemi karaya oturdu", summary: "Mürettebat kurtarıldı.", members: 3, age: "1 day" },
  { key: "karasu", title: "Karasu'da yangın çıktı", summary: "İtfaiye müdahale etti.", members: 3, age: "2 days" },
  { key: "baskin", title: "Polisten kumarhaneye baskın", summary: "Gözaltılar var.", members: 3, age: "1 day" },
  { key: "baski", title: "Basın üzerindeki baskı artıyor", summary: "Gazeteciler tepki gösterdi.", members: 3, age: "2 days" },
  { key: "toplum", title: "Sivil toplum kuruluşları bildiri yayımladı", summary: "Çağrı yapıldı.", members: 3, age: "1 day" },
  { key: "toplu", title: "Toplu ulaşıma zam geldi", summary: "Tarife değişti.", members: 3, age: "2 days" },
  { key: "kars", title: "Kars'ta yeni vali göreve başladı", summary: "Vali yolculuğa çıktı.", members: 3, age: "1 day" },
  { key: "karsi", title: "Hükümete karşı çıktı", summary: "Muhalefet açıklama yaptı.", members: 3, age: "2 days" },
  { key: "kurtA", title: "Ormanda kurt sürüsü görüldü", summary: "Köylüler uyarıldı.", members: 3, age: "2 days" },
  // roots that stay: tokat (the real inflection of tokadi), tehdit (tehdidi), part (parti)
  { key: "tokat", title: "Gazeteciye tokat attı", summary: "Savcılık soruşturma başlattı.", members: 3, age: "2 days" },
  { key: "tehdit", title: "Avukata tehdit mesajı gönderildi", summary: "Baro açıklama yaptı.", members: 3, age: "2 days" },
  { key: "part", title: "Part zamanlı çalışma düzenlemesi geldi", summary: "Bakanlık duyurdu.", members: 3, age: "2 days" },
];

const seedId = (i: number): string => `00000000-0000-4000-8000-${String(198000 + i).padStart(12, "0")}`;
const KEY_BY_ID = new Map(SEEDS.map((s, i) => [seedId(i), s.key]));

const lit = (s: string | null): string => (s === null ? "null" : `'${s.replaceAll("'", "''")}'`);

interface LiveQuery {
  name: string;
  variants: string[];
  folded: string;
}

/** The arguments the app builds for a typed query (turkishQueryVariants, foldTr). */
const typed = (name: string): LiveQuery => ({ name, variants: turkishQueryVariants(name), folded: foldTr(name) });

/** The seven collisions as typed (the first of each pair is what the report lists), and the pairs that must agree. */
const COLLISION_QUERIES = ["mardin kaza", "mardin", "yorgun", "kurti", "karasu", "baskı", "baski", "toplu", "karşı çıktı", "karsi cikti"];
const COLLISION_PAIRS: Array<[string, string]> = [
  ["baski", "baskı"],
  ["karsi cikti", "karşı çıktı"],
];
/** 196's widenings: the ASCII spelling and its Turkish spelling. */
const PAIRS: Array<[string, string]> = [
  ["emekli maasi", "emekli maaşı"],
  ["siginagi", "sığınağı"],
  ["maaslari", "maaşları"],
  ["cocugu", "çocuğu"],
  ["guvenligi", "güvenliği"],
  ["secim sonuclari", "seçim sonuçları"],
];
/** The plural-possessive form of a denied root: the documented cost of the closed list. */
const R3_COST = ["kurtlari", "kurtları", "karalari", "karaları"];
/** Queries whose stem query holds a lexeme with an apostrophe inside it (a URL or file token): 196 answers them, 198 must not raise. */
const QUOTE_QUERIES = ["a.com/x'maasi", "x.com/a'kitabi", "a.com/x'kurti", "x.co/a'maaslari"];
/** Every widening, Turkish spelling and control: 198 must return exactly 196's ids, in 196's order. */
const UNCHANGED = [
  ...PAIRS.flat(), "asgari ucret zammi", "asgari ucret zam", "kitabi", "kitabı", "hakki", "hakkı", "iliski", "turku", "sevgi", "tokadi", "tehdidi", "parti", "zam", "secim", "iran", "erdogan", "burdur",
  "miller", "imamoglu", "imamoğlu", "deprem", "akp alias", "negated", "negated phrase", "empty", ...QUOTE_QUERIES,
];

const LIVE_QUERIES: LiveQuery[] = [
  ...[...COLLISION_QUERIES, ...PAIRS.flat(), ...R3_COST, "kitabi", "kitabı", "asgari ucret zammi", "asgari ucret zam", "hakki", "hakkı", "iliski", "turku", "sevgi", "tokadi", "tehdidi", "parti", "zam", "secim", "iran", "erdogan", "burdur", "miller", "imamoglu", "imamoğlu", "deprem", ...QUOTE_QUERIES].map(typed),
  { name: "akp alias", variants: ['akp or "ak parti"'], folded: "akp or ak parti" },
  { name: "negated", variants: ["maaslari -memur"], folded: "maaslari -memur" },
  { name: "negated phrase", variants: ['iran -"israil saldırısı"'], folded: 'iran -"israil saldirisi"' },
  { name: "empty", variants: [""], folded: "" },
];

describe.runIf(Boolean(process.env.TAYF_PSQL))("198 ASCII root deny set against a live Postgres (129, 166, 172, 185, 186, 194, 196 and 198 applied)", () => {
  assertLiveReady("198", {
    ledger: ["129", "166", "172", "185", "186", "194", "196", "198"],
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

  /** 196's helper and 196's function, from the text of 196's migration file, as pg_temp functions of the same shape (the function calls the copy). */
  const H_196 =
    "create function pg_temp.h196(p tsquery) returns tsquery language plpgsql immutable strict parallel safe set search_path = '' " + `as $fn$${helper196Raw}$fn$;`;
  const F_196 =
    "create function pg_temp.f196(p_variants text[], p_folded text, p_limit integer default 12) returns table (id uuid) " +
    `language sql stable set search_path = '' as $fn$${fn196Raw.replace("public.tayf_ascii_inflection_expand(", "pg_temp.h196(")}$fn$;`;

  const rows = SEEDS.map(
    (s, i) => `(${lit(seedId(i))}, ${lit(s.title)}, null, ${lit(s.summary)}, ${s.members}, false, now() - interval '${s.age}')`,
  ).join(",\n");

  const list = (fn: string, q: LiveQuery): string =>
    `select ${lit(`${q.name}|${fn === "pg_temp.f196" ? "196" : "198"}|`)} || coalesce((select string_agg(t.id::text, ',' order by t.n) ` +
    `from ${fn}(${arr(q.variants)}, ${lit(q.folded)}, 50) with ordinality as t(id, n)), '');`;

  const script = [
    "begin;",
    H_196,
    F_196,
    `insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at) values\n${rows};`,
    "analyze public.clusters;",
    ...LIVE_QUERIES.flatMap((q) => [list("pg_temp.f196", q), list("public.search_cluster_ids", q)]),
    "rollback;",
  ].join("\n");

  const ids196 = new Map<string, string[]>();
  const ids198 = new Map<string, string[]>();
  let ran = false;
  const run = (): void => {
    if (ran) return;
    ran = true;
    for (const line of runPsql(script).split("\n")) {
      if (line === "") continue;
      const [name, which, ids] = line.split("|") as [string, string, string];
      const keys = ids === "" ? [] : ids.split(",").map((id) => KEY_BY_ID.get(id) ?? `?${id}`);
      (which === "196" ? ids196 : ids198).set(name, keys);
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
    "'%s': 198 returns only ids 196 returns (denying a root only removes candidates), no id twice, below the 50-row cap",
    (_name, q) => {
      const old = keysOf(ids196, q.name);
      const now = keysOf(ids198, q.name);
      expect(old, q.name).toEqual(expect.arrayContaining(now));
      expect(now.length, q.name).toBe(new Set(now).size);
      expect(old.length, "below the 50-row cap").toBeLessThan(50);
    },
  );

  it.each(UNCHANGED.map((n) => [n] as [string]))("'%s' keeps exactly 196's ids and order (a widening, a Turkish spelling, a real inflection or a control)", (name) => {
    expect(keysOf(ids198, name)).toEqual(keysOf(ids196, name));
  });

  it("the queries of the fixtures find rows at all (the checks are not vacuous)", () => {
    for (const [, tr] of PAIRS) expect(keysOf(ids198, tr).length, tr).toBeGreaterThan(1);
    for (const name of ["mardin kaza", "mardin", "yorgun", "kurti", "karasu", "baski", "toplu", "karsi cikti", "tokadi", "tehdidi", "parti", "burdur", "miller", "akp alias", "secim", "imamoglu", "zam"]) {
      expect(keysOf(ids198, name).length, name).toBeGreaterThan(0);
    }
    expect(keysOf(ids198, "empty")).toEqual([]);
  });

  it.each([
    // [typed, the unrelated row 196 returned, the rows that stay]
    ["mardin kaza", "mardM", ["mardK"]],
    ["mardin", "mardM", ["mardK"]],
    ["yorgun", "ny", ["yorg"]],
    ["kurti", "kurtulmus", ["kurti"]],
    ["karasu", "karaya", ["karasu"]],
    ["baskı", "baskin", ["baski"]],
    ["baski", "baskin", ["baski"]],
    ["toplu", "toplum", ["mD", "toplu"]],
    ["karşı çıktı", "kars", ["karsi"]],
    ["karsi cikti", "kars", ["karsi"]],
  ] as Array<[string, string, string[]]>)("'%s': 196 returned the unrelated %s row, 198 does not, and the right row stays", (name, unrelated, stay) => {
    expect(keysOf(ids196, name), `${name} on 196`).toContain(unrelated);
    expect(keysOf(ids198, name), `${name} on 198`).not.toContain(unrelated);
    expect(setOf(ids198, name), `${name} on 198`).toEqual([...stay].sort());
  });

  it("a 'Mart' row is not returned for 'mardin kaza'; a 'Kurtulmuş' row is not returned for 'kurti' while a 'Kurti' row is; a 'baskın' row is not returned for 'baskı'", () => {
    expect(keysOf(ids198, "mardin kaza")).not.toContain("mardM");
    expect(keysOf(ids198, "kurti")).not.toContain("kurtulmus");
    expect(keysOf(ids198, "kurti")).toContain("kurti");
    expect(keysOf(ids198, "baskı")).not.toContain("baskin");
    expect(keysOf(ids198, "baskı")).toContain("baski");
  });

  it.each(COLLISION_PAIRS)("the pair '%s' / '%s' finds the same ids in the same order (the stem query is built from p_folded)", (a, b) => {
    expect(keysOf(ids198, a)).toEqual(keysOf(ids198, b));
  });

  it.each(PAIRS)("196's widening '%s' (ASCII) still finds exactly what '%s' finds, in the same order", (ascii, turkish) => {
    expect(setOf(ids198, ascii), ascii).toEqual(setOf(ids198, turkish));
    expect(keysOf(ids198, ascii), ascii).toEqual(keysOf(ids198, turkish));
  });

  it("the rows of the wanted widenings are still the right ones", () => {
    expect(setOf(ids198, "emekli maasi")).toEqual(["mA", "mB"]);
    expect(setOf(ids198, "siginagi")).toEqual(["sA", "sB", "sC"]);
    expect(setOf(ids198, "maaslari")).toEqual(["mA", "mB", "mD"]);
    expect(setOf(ids198, "cocugu")).toEqual(["cA", "cB", "cC"]);
    expect(setOf(ids198, "guvenligi")).toEqual(["gA", "gB", "gC"]);
    expect(setOf(ids198, "secim sonuclari")).toEqual(["secA", "secB"]);
  });

  it("the roots that stay still widen: tokadi finds the tokat row, tehdidi the tehdit row, parti the part row", () => {
    expect(keysOf(ids198, "tokadi")).toContain("tokat");
    expect(keysOf(ids198, "tehdidi")).toContain("tehdit");
    expect(keysOf(ids198, "parti")).toContain("part");
  });

  it("the documented cost: the ASCII plural-possessive of a denied root (kurtlari, karalari) no longer reaches its stem, while the Turkish spelling still does", () => {
    // 196 found the kurt / kara rows from the ASCII spelling; 198 does not (KNOWN LIMITS 2)
    expect(keysOf(ids196, "kurtlari")).toContain("kurtA");
    expect(keysOf(ids198, "kurtlari")).not.toContain("kurtA");
    expect(keysOf(ids196, "karalari")).toContain("karaya");
    expect(keysOf(ids198, "karalari")).not.toContain("karaya");
    // the Turkish spelling reads the stem through the variants arm (kurt, kara), which 198 does not touch; only the Kürt row, a collision itself, leaves
    expect(keysOf(ids198, "kurtları")).toContain("kurtA");
    expect(keysOf(ids198, "kurtları")).not.toContain("kurtulmus");
    expect(keysOf(ids198, "karaları")).toContain("karaya");
  });

  it.each(QUOTE_QUERIES.map((n) => [n] as [string]))("'%s' (an apostrophe inside a URL token) is answered, not raised", (name) => {
    expect(keysOf(ids198, name)).toEqual(keysOf(ids196, name));
  });

  it("the 166 guard stays: burdur keeps the Burdur row, not Bursa; the 172 tier stays: the Miller row comes first; the alias keeps both party rows", () => {
    expect(keysOf(ids198, "burdur")).toEqual(["burdur"]);
    expect(keysOf(ids198, "miller")[0]).toBe("miller");
    expect(keysOf(ids198, "akp alias")).toEqual(expect.arrayContaining(["akp1", "akp2"]));
  });

  it("the helper's output text is pinned for the seven collisions (the app's pipeline) and equals the model of the rules", () => {
    const pipe = (q: string): string =>
      `select ${lit(q)} || '=>' || public.tayf_ascii_inflection_expand(pg_catalog.to_tsquery('pg_catalog.simple', public.tayf_search_fold(pg_catalog.websearch_to_tsquery('pg_catalog.turkish', public.tayf_search_fold(${lit(q)}))::text)))::text;`;
    const cases: Array<[string, string]> = [
      ["mardin", "'mardi' | 'mard'"],
      ["mardin kaza", "( 'mardi' | 'mard' ) & 'kaz'"],
      ["yorgun", "'yorgu' | 'yorg'"],
      ["kurti", "'kurti'"],
      ["karasu", "'karasu' | 'karas'"],
      ["baski", "'baski'"],
      ["baskı", "'baski'"],
      ["toplu", "'toplu'"],
      ["karsi", "'karsi'"],
      ["karşı çıktı", "'karsi' & 'cik'"],
      // 196's pins, unchanged
      ["emekli maasi", "( 'emekli' | 'emekl' ) & ( 'maasi' | 'maas' )"],
      ["siginagi", "'siginagi' | 'siginag' | 'siginak'"],
      ["maaslari", "'maaslari' | 'maaslar' | 'maas'"],
      ["sevgi", "'sevgi' | 'sevg'"],
      ["iliski", "'iliski'"],
      ["turku", "'turku'"],
      ["zammi", "'zammi'"],
      ["tokadi", "'tokadi' | 'tokad' | 'tokat'"],
      ["tehdidi", "'tehdidi' | 'tehdid' | 'tehdit'"],
      ["parti", "'parti' | 'part'"],
      ["kurtlari", "'kurtlari' | 'kurtlar'"],
      ["karalari", "'karalari' | 'karalar'"],
    ];
    const out = runPsql(cases.map(([q]) => pipe(q)).join("\n")).trim().split("\n");
    expect(out).toEqual(cases.map(([q, want]) => `${q}=>${want}`));
  });

  it("the helper's direct output equals the model for every lexeme of the tables above, and 196's helper text prints the old roots", () => {
    const lexemes = [...COLLISION_LEXEMES.map(([l]) => l), ...KEPT_LEXEMES.map(([l]) => l), "kurtlari", "karalari"];
    const text = lexemes
      .map(
        (l) =>
          `select ${lit(l)} || '=>' || public.tayf_ascii_inflection_expand(pg_catalog.to_tsquery('pg_catalog.simple', ${lit(l)}))::text || '|' || pg_temp.h196(pg_catalog.to_tsquery('pg_catalog.simple', ${lit(l)}))::text;`,
      )
      .join("\n");
    const out = runPsql(`${H_196}\n${text}`).trim().split("\n");
    expect(out).toEqual(lexemes.map((l) => `${l}=>${modelText(l, modelRoots(l, DENY_198))}|${modelText(l, modelRoots(l, DENY_196))}`));
    // null in, null out; strict
    expect(runPsql("select public.tayf_ascii_inflection_expand(null::tsquery) is null;").trim()).toBe("t");
  });

  it("is applied once: one ledger row for 198 and for 196, one overload of each function, the helper text of the file, the attributes and grants as the file says, search_cluster_ids unchanged", () => {
    const out = runPsql(`
select (select count(*) from supabase_migrations.schema_migrations where version = '198'),
       (select count(*) from supabase_migrations.schema_migrations where version = '196'),
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
       obj_description(h.oid, 'pg_proc') like '%198%'
  from pg_catalog.pg_proc h
 where h.oid = 'public.tayf_ascii_inflection_expand(tsquery)'::regprocedure;
`).trim();
    const [fnLine, helperLine] = out.split("\n") as [string, string];
    const f = fnLine.split("|");
    expect(f[0]).toBe("1"); // ledger rows for 198
    expect(f[1]).toBe("1"); // ledger rows for 196 (untouched)
    expect(f[2]).toBe("1"); // one three-argument overload
    expect(f[3]).toBe("1"); // one helper
    expect(f[4]).toBe("t"); // security definer
    expect(f[5]).toBe("s"); // stable
    expect(f[6]).toBe("t"); // search_path = ''
    expect(f[7]).toBe(PROD_PROACL);
    expect(f[8]).toBe(FN_196_MD5); // search_cluster_ids is 196's, untouched
    expect(f[9]).toBe(String(FN_196_LENGTH));
    expect(f[10]).toBe("f"); // anon
    expect(f[11]).toBe("f"); // authenticated
    expect(f[12]).toBe("t"); // service_role
    expect(f[13]).toBe("t"); // its comment still names 196
    const h = helperLine.split("|");
    expect(h[0]).toBe("f"); // not security definer
    expect(h[1]).toBe("i"); // immutable
    expect(h[2]).toBe("s"); // parallel safe
    expect(h[3]).toBe("t"); // strict
    expect(h[4]).toBe("t"); // search_path = ''
    expect(h[5]).toBe(PROD_PROACL);
    expect(h[6]).toBe(md5(helperRaw)); // the helper in the database is the text of the file
    expect(h[7]).toBe(String(pgLength(helperRaw)));
    expect(h[8]).toBe("f"); // anon
    expect(h[9]).toBe("f"); // authenticated
    expect(h[10]).toBe("t"); // service_role
    expect(h[11]).toBe("plpgsql");
    expect(h[12]).toBe("t"); // the comment names 198
  });
});
