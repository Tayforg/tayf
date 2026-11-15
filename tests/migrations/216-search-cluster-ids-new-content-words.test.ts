import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Contract test for migration 216 ("search_cluster_ids_new_content_words"), h192 (hunt 192, on h191's "En yeni" order).
//
// 215's "En yeni" search (search_cluster_ids_new) keeps a row only when EVERY typed word, as a word-start prefix, starts a word of the display
// title (lit_d). So a natural query returns a short list under a complete-looking count: 'iran ile abd' requires the standalone word 'ile' (6 rows,
// the ranked order has 24), and 'zamlar' requires a title word that starts with 'zaml' (5 rows: 'zam' itself is missing, the title word built on
// the stem). 216 is a CREATE OR REPLACE of that one function with edits ONLY in the lw CTE (and a new sw CTE before it) and in the lit_d
// expression of hits:
//   1. sw: the STOP WORDS of the typed query, read from the TURKISH-lettered p_variants[1] (ts_lexize of turkish_stem gives '{}' for ile, için, ve,
//      ne; the ASCII fold 'icin' is {iç}, so p_folded cannot be used), each folded;
//   2. lw drops the words present in sw, EXCEPT when that would leave no word at all (a query of stop words only keeps 215's behaviour);
//   3. lw gets a second column pre2, the FOLDED turkish stem of the word, only for a conservative stem (a proper prefix of the word, 5 letters or
//      more, or gx's `ex` test: 3-4 letters AND a case or plural suffix): zamlar -> zam, vergiler -> vergi, kararnamelerinin -> kararname, and
//      NOT iran -> ira (so Irak never passes for iran);
//   4. lit_d accepts a title word that starts with pre OR with pre2; for a SHORT pre2 (3-4 letters) the title word must be the stem itself or the stem plus a
//      case, plural or possessive tail (an allow-list), because a bare word-start test meets 'kazandı' and 'Kazakistan' for kazalar and 'yaşam' for yasalar (db-1).
// This file pins, without a database: the file, ledger and transaction, additive-only SQL, 215's body is production's (md5 and length), 216's body
// is 215's with exactly those edits (the three unchanged spans pinned by md5 and length), the attributes and grants, the comment, the header, the
// docs section, the dry-run and the manifest entry. The live block (TAYF_PSQL) seeds clusters inside rolled-back transactions and checks the
// contract on a real Postgres, against a pg_temp copy of 215's body.
//
// SQL is scanned with indexOf and character loops, never with a nested-quantifier regular expression (CodeQL).
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const FILE_204 = "204_search_single_letter_compounds.sql";
const FILE_211 = "211_search_cluster_ids_v2_offset.sql";
const FILE_214 = "214_neutral_title_repick_fast.sql";
const FILE_215 = "215_search_cluster_ids_new.sql";
const FILE_216 = "216_search_cluster_ids_new_content_words.sql";
const MIGRATION_204 = resolve(MIGRATIONS_DIR, FILE_204);
const MIGRATION_211 = resolve(MIGRATIONS_DIR, FILE_211);
const MIGRATION_215 = resolve(MIGRATIONS_DIR, FILE_215);
const MIGRATION_216 = resolve(MIGRATIONS_DIR, FILE_216);
const DRYRUN_216 = resolve(ROOT, "tests", "migrations", "sql", "216-search-cluster-ids-new-content-words-dryrun.sql");
const MANIFEST = resolve(ROOT, "tests", "migrations", "sql", "live-manifest.txt");
const DOC_MIGRATION_GUIDE = resolve(ROOT, "docs", "migration-guide.md");
const SEARCH_QUERY_SOURCE = resolve(ROOT, "src", "lib", "clusters", "search-query.ts");

/** Production, read-only, 2026-11-15: md5(prosrc) and length(prosrc) of search_cluster_ids(text[], text, integer) (204's body) and of v2 (211's). */
const V1_MD5 = "32b42ca06d6b0c2a3ba8bf1264d353f7";
const V1_LENGTH = 22892;
const V2_MD5 = "c91d45d81b53a71b007aa6de2d1a5ed7";
const V2_LENGTH = 22945;
/** Production, read-only, 2026-11-15: the LIVE search_cluster_ids_new, i.e. 215's body: the body 216 starts from. */
const LIVE_215_MD5 = "c500964284801f3c83be9f4b73ec398a";
const LIVE_215_LENGTH = 23628;
const PROD_PROACL = "{postgres=X/postgres,service_role=X/postgres}";

/** 215's body cut at 216's edit points: the three spans 216 leaves untouched (md5 and length, pinned from the 215 file), and the two it replaces. */
const SPAN_A = { md5: "d618dee22312dec6c923f72aac5e787d", length: 15528 }; // from the start through the `top` CTE
const SPAN_LW_215 = { md5: "043c05350b1194775687b6c9928246b0", length: 2180 }; // 215's lw CTE (replaced by sw + lw)
const SPAN_B = { md5: "791b2cf19427372961d780285d7b2ab6", length: 2794 }; // hits, up to 194's lit_d expression
const SPAN_C = { md5: "9fd100604ceabd21ddbf11fda90ccaf6", length: 2995 }; // after the lit_d expression: the end of hits and the final select

const FN = "public.search_cluster_ids_new";
const FN_SIG = `${FN}(text[], text, integer, integer)`;

const LEDGER_STMT =
  "insert into supabase_migrations.schema_migrations (version, name) values ('216', '216_search_cluster_ids_new_content_words') on conflict do nothing;";
const REVOKE_STMT = `revoke all on function ${FN_SIG} from public, anon, authenticated;`;
const GRANT_STMT = `grant execute on function ${FN_SIG} to service_role;`;

const LW_OPEN = "  ), lw as (\n";
const SW_OPEN = "  ), sw as (\n";
const HITS_OPEN = "  ), hits as materialized (\n";
/** 215's lit_d expression line, and 216's (preceded in 216 by comment lines that start with "-- 216"). */
const LITD_215 =
  "           (exists (select 1 from lw) and not exists (select 1 from lw where pg_catalog.strpos(dn.n, ' ' || lw.pre) = 0)) as lit_d\n";
/**
 * 216's lit_d, the SHORT-stem allow-list (db-1): the tail a display-title word may carry after a 3-4 letter pre2, a constant with no backslash:
 * an optional plural (lar, ler), an optional possessive (i, u, si, su, in, un, sin, sun) and an optional case suffix (a, e, ya, ye, na, ne, i, u, yi, yu, in, un, nin, nun,
 * da, de, ta, te, dan, den, tan, ten, daki, deki, taki, teki, nda ..., la, le, yla, yle, ki). Its subject is only the title word's tail; the stem never enters a pattern.
 */
const TAIL_T = "^(l[ae]r)?(s?[iu]|s?[iu]n)?(y?[ae]|n[ae]|y?[iu]|n?[iu]n|[dt][ae](n|ki)?|n[dt][ae](n|ki)?|y?l[ae]|ki)?$";
/** The bare word-start test of pre2 that 216 had before db-1 (and that is still the test for a pre2 of 5 letters or more). */
const BARE_PRE2 = "pg_catalog.strpos(dn.n, ' ' || lw.pre2) = 0";
const CASE_OPEN = "case when pg_catalog.length(lw.pre2) >= 5 then ";
const LITD_216_CODE =
  "(exists (select 1 from lw) and not exists (select 1 from lw where pg_catalog.strpos(dn.n, ' ' || lw.pre) = 0 and (lw.pre2 is null or " +
  `${CASE_OPEN}${BARE_PRE2} else not exists (select 1 from pg_catalog.regexp_split_to_table(dn.n, ' ') as tw(x) where tw.x = lw.pre2 ` +
  "or (pg_catalog.left(tw.x, pg_catalog.length(lw.pre2)) = lw.pre2 " +
  `and (pg_catalog.substr(tw.x, pg_catalog.length(lw.pre2) + 1) ~ '${TAIL_T}' ` +
  "or (pg_catalog.right(lw.pre2, 1) !~ '[aeiou]' and pg_catalog.length(tw.x) > pg_catalog.length(lw.pre2) + 1 " +
  "and pg_catalog.substr(tw.x, pg_catalog.length(lw.pre2) + 1, 1) = pg_catalog.right(lw.pre2, 1) " +
  `and pg_catalog.substr(tw.x, pg_catalog.length(lw.pre2) + 2) ~ '${TAIL_T}')))) end))) as lit_d`;
/** gx's case and plural suffix pattern, which 216's pre2 reuses. */
const SUFFIX_RE = "'^(y?[ae]|n[ae]|y?[iu]|n?[iu]n|[dt][ae](n|ki)?|n[dt][ae](n|ki)?|y?l[ae]|l[ae]r[a-z]*)$'";

// -- plain-text helpers (no regular expression runs over quoted SQL) ----------------------------

/** Removes `--` comments to the end of the line (no `--` appears inside a string literal of these files). */
function stripComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const at = line.indexOf("--");
      return at < 0 ? line : line.slice(0, at);
    })
    .join("\n");
}

/** Whitespace runs to one space, parentheses hugged, ends trimmed (character scan, no regular expression). */
function collapse(s: string): string {
  let out = "";
  let pendingSpace = false;
  for (const ch of s) {
    if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r") {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      if (ch !== ")") out += " ";
      pendingSpace = false;
    }
    out += ch;
    if (ch === "(") pendingSpace = false;
  }
  return out;
}

/** A comment block read as prose: `--` markers at the start of a line dropped, whitespace collapsed. */
function flat(text: string): string {
  return collapse(text.split("\n").map((l) => (l.startsWith("--") ? l.slice(2) : l)).join("\n"));
}

const md5 = (text: string): string => createHash("md5").update(text).digest("hex");
const len = (text: string): number => [...text].length;

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** The text between the first two dollar-quote markers: Postgres' prosrc. Comments in the file header are not part of it. */
function functionBody(sql: string): string {
  const open = sql.indexOf("$fn$");
  const close = sql.indexOf("$fn$", open + 4);
  expect(open, "an opening dollar quote").toBeGreaterThanOrEqual(0);
  expect(close, "a closing dollar quote").toBeGreaterThan(open);
  return sql.slice(open + 4, close);
}

/** `create or replace function ... as ` up to and including the opening dollar quote. */
function functionHeader(sql: string): string {
  const at = sql.indexOf("create or replace function");
  const open = sql.indexOf("$fn$", at);
  expect(at, "create or replace function").toBeGreaterThanOrEqual(0);
  return sql.slice(at, open + 4);
}

/** Top-level statements: split on ';' outside single-quoted strings, `--` comments and dollar-quoted bodies; comments dropped. */
function splitStatements(code: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  while (i < code.length) {
    const ch = code.charAt(i);
    if (code.startsWith("--", i)) {
      const newline = code.indexOf("\n", i);
      i = newline === -1 ? code.length : newline;
    } else if (code.startsWith("$fn$", i)) {
      const close = code.indexOf("$fn$", i + 4);
      const stop = close === -1 ? code.length : close + 4;
      cur += code.slice(i, stop);
      i = stop;
    } else if (ch === "'") {
      let j = i + 1;
      while (j < code.length) {
        if (code.charAt(j) === "'") {
          if (code.charAt(j + 1) === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      cur += code.slice(i, j + 1);
      i = j + 1;
    } else if (ch === ";") {
      out.push(cur.trim());
      cur = "";
      i++;
    } else {
      cur += ch;
      i++;
    }
  }
  out.push(cur.trim());
  return out.filter((stmt) => stmt !== "");
}

/** Statements with the dollar-quoted body replaced by a marker and whitespace collapsed. */
function statements(code: string): string[] {
  return splitStatements(code).map((stmt) => {
    const open = stmt.indexOf("$fn$");
    const close = open === -1 ? -1 : stmt.indexOf("$fn$", open + 4);
    const shown = open !== -1 && close !== -1 ? `${stmt.slice(0, open)}$fn$ body $fn$${stmt.slice(close + 4)}` : stmt;
    return collapse(shown);
  });
}

function statementStartingWith(code: string, prefix: string): string {
  const found = statements(code).find((stmt) => stmt.toLowerCase().startsWith(prefix));
  if (found === undefined) throw new Error(`no statement starting with "${prefix}"`);
  return found;
}

/** The `## <num>` section of the migration guide, through the next `## ` heading. */
function sectionOf(md: string, num: string): string {
  const at = md.indexOf(`\n## ${num} `);
  expect(at, `the ## ${num} section`).toBeGreaterThan(0);
  const next = md.indexOf("\n## ", at + 1);
  return md.slice(at, next < 0 ? md.length : next);
}

/** The tail pattern constants of lit_d (the two `~ '...'` subjects after the stem and after the doubled consonant), read from a body, not retyped. */
function tailPatterns(body: string): string[] {
  const out: string[] = [];
  for (const marker of ["pg_catalog.substr(tw.x, pg_catalog.length(lw.pre2) + 1) ~ '", "pg_catalog.substr(tw.x, pg_catalog.length(lw.pre2) + 2) ~ '"]) {
    const at = body.indexOf(marker);
    if (at < 0) {
      out.push("");
      continue;
    }
    const end = body.indexOf("'", at + marker.length);
    out.push(body.slice(at + marker.length, end));
  }
  return out;
}

/**
 * The SHORT-stem test of lit_d, in JavaScript: the title word (folded, a-z0-9) meets the stem when it IS the stem or the stem plus an allowed tail, or, for a stem that ends
 * in a consonant, the stem plus the same consonant doubled and an allowed tail (zam + mi: zammi, hak + ki: hakki). The pattern has no nested quantifier, so a JS RegExp over
 * the title word's tail is equivalent to the Postgres one (anchored on both sides, no backtracking difference: a match exists or it does not).
 */
function shortStemMeets(tail: RegExp, pre2: string, word: string): boolean {
  if (word === pre2) return true;
  if (!word.startsWith(pre2)) return false;
  if (tail.test(word.slice(pre2.length))) return true;
  const last = pre2.slice(-1);
  return !"aeiou".includes(last) && word.length > pre2.length + 1 && word.charAt(pre2.length) === last && tail.test(word.slice(pre2.length + 1));
}

/** True when lit_d meets a 5+ letter pre2 by the word-start prefix and a SHORT pre2 only through the allow-list: the bare test appears once, as the `then` branch of the case. */
function shortStemsAreAllowListed(litdCode: string): boolean {
  const at = litdCode.indexOf(CASE_OPEN);
  if (at < 0) return false;
  const afterCase = at + CASE_OPEN.length;
  const elseBranch = `${BARE_PRE2} else not exists (select 1 from pg_catalog.regexp_split_to_table(dn.n, ' ') as tw(x) where `;
  return litdCode.startsWith(elseBranch, afterCase) && countOf(litdCode, BARE_PRE2) === 1;
}

/** 216's lit_d with the case removed: the bare word-start test for EVERY pre2, the defect db-1 fixed (restored, as a mutation). */
function withBarePre2(body: string): string {
  const start = body.indexOf(CASE_OPEN);
  const stop = body.indexOf("end)", start);
  // unchanged when there is no case to remove (the mutation test asserts that it changed the body, so a missing case fails there, not while the file is collected)
  return start < 0 || stop < start ? body : body.slice(0, start) + BARE_PRE2 + body.slice(stop + 3);
}

const sql204 = readFileSync(MIGRATION_204, "utf8");
const body204 = functionBody(sql204);
const sql211 = readFileSync(MIGRATION_211, "utf8");
const body211 = functionBody(sql211);
const sql215 = readFileSync(MIGRATION_215, "utf8");
const body215 = functionBody(sql215);
const sql216 = existsSync(MIGRATION_216) ? readFileSync(MIGRATION_216, "utf8") : "";
const header216 = (): string => {
  expect(existsSync(MIGRATION_216), `${FILE_216} must exist`).toBe(true);
  return sql216.split("\nbegin;")[0] as string;
};
const body216 = (): string => {
  expect(existsSync(MIGRATION_216), `${FILE_216} must exist`).toBe(true);
  return functionBody(sql216);
};

/** The pieces of 215's body 216 does not replace, and of 216's body around its edits. */
function spans215() {
  const lw = body215.indexOf(LW_OPEN);
  const hits = body215.indexOf(HITS_OPEN);
  const litd = body215.indexOf(LITD_215);
  expect(lw, "215's lw CTE").toBeGreaterThan(0);
  expect(hits, "215's hits CTE").toBeGreaterThan(lw);
  expect(litd, "215's lit_d line").toBeGreaterThan(hits);
  return { a: body215.slice(0, lw), lw: body215.slice(lw, hits), b: body215.slice(hits, litd), litd: LITD_215, c: body215.slice(litd + LITD_215.length) };
}
function spans216() {
  const body = body216();
  const sw = body.indexOf(SW_OPEN);
  const lw = body.indexOf(LW_OPEN);
  const hits = body.indexOf(HITS_OPEN);
  const litdAt = body.indexOf("           -- 216");
  const litdEnd = body.indexOf(" as lit_d\n", litdAt);
  expect(sw, "216's sw CTE").toBeGreaterThan(0);
  expect(lw, "216's lw CTE after sw").toBeGreaterThan(sw);
  expect(hits, "216's hits CTE").toBeGreaterThan(lw);
  expect(litdAt, "216's lit_d comment").toBeGreaterThan(hits);
  expect(litdEnd, "216's lit_d line").toBeGreaterThan(litdAt);
  const end = litdEnd + " as lit_d\n".length;
  return { a: body.slice(0, sw), sw: body.slice(sw, lw), lw: body.slice(lw, hits), b: body.slice(hits, litdAt), litd: body.slice(litdAt, end), c: body.slice(end) };
}

describe("216 search_cluster_ids_new_content_words: the file, ledger and transaction", () => {
  it("exists, with the exact name, after 215, and no other file claims the number 216 (197 and 202 are held on other branches and are not used)", () => {
    expect(existsSync(MIGRATION_216)).toBe(true);
    expect(readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("216_"))).toEqual([FILE_216]);
    expect(FILE_216 > FILE_215).toBe(true);
    expect(FILE_215 > FILE_214).toBe(true);
    expect(readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("197_") || f.startsWith("202_"))).toEqual([]);
  });

  it("only 215 and 216 define search_cluster_ids_new (216 is a create or replace of the function 215 created)", () => {
    const definers = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => collapse(stripComments(readFileSync(resolve(MIGRATIONS_DIR, f), "utf8"))).includes("function public.search_cluster_ids_new("));
    expect(definers).toEqual([FILE_215, FILE_216]);
  });

  it("runs in one transaction with a bounded lock wait", () => {
    const stmts = statements(sql216);
    expect(stmts[0]).toBe("begin");
    expect(stmts[stmts.length - 1]).toBe("commit");
    expect(stmts).toContain("set local lock_timeout = '5s'");
    expect(countOf(sql216, "\nbegin;")).toBe(1);
    expect(countOf(sql216, "\ncommit;")).toBe(1);
  });

  it("records version 216 in the schema_migrations ledger, idempotently, as the last statement before commit", () => {
    const code = collapse(stripComments(sql216));
    expect(code).toContain(LEDGER_STMT);
    expect(countOf(code, "schema_migrations")).toBe(1);
    expect(code.slice(code.indexOf("begin;")).endsWith(`${LEDGER_STMT} commit;`)).toBe(true);
  });

  it("notifies pgrst to reload its schema cache (the function comment changes)", () => {
    expect(statements(sql216)).toContain("notify pgrst, 'reload schema'");
  });
});

describe("216 search_cluster_ids_new_content_words: the fingerprints it was built from", () => {
  it("215's function body is production's live search_cluster_ids_new: its md5 and length are the recorded prosrc (STEP 0, read-only)", () => {
    expect(md5(body215)).toBe(LIVE_215_MD5);
    expect(len(body215)).toBe(LIVE_215_LENGTH);
  });

  it("204's and 211's bodies are production's search_cluster_ids and search_cluster_ids_v2, which 216 leaves alone", () => {
    expect(md5(body204)).toBe(V1_MD5);
    expect(len(body204)).toBe(V1_LENGTH);
    expect(md5(body211)).toBe(V2_MD5);
    expect(len(body211)).toBe(V2_LENGTH);
  });

  it("the header records STEP 0: 215's fingerprints, the attributes and the two untouched functions", () => {
    const header = header216();
    expect(header).toContain("STEP 0");
    expect(header).toContain(LIVE_215_MD5);
    expect(header).toContain(String(LIVE_215_LENGTH));
    expect(header).toContain(V1_MD5);
    expect(header).toContain(V2_MD5);
    expect(header).toContain(`proacl ${PROD_PROACL}`);
    expect(flat(header)).toContain("215_search_cluster_ids_new.sql");
  });

  it("the header names the evidence, the rule, the replay and cost numbers, the apply order, the rollback and the numbering", () => {
    const header = flat(header216());
    for (const word of [
      "h192",
      "h191",
      "REPLAY",
      "COST",
      "THE RULE",
      "stop word",
      "ts_lexize",
      "p_variants[1]",
      "pre2",
      "iran ile abd",
      "zamlar",
      "vergiler",
      "kararnamelerinin",
      "deprem için bakan",
      "faiz ve enflasyon",
      "Irak",
      "force_generic_plan",
      "NOT MATERIALIZED",
      "ROLLBACK",
      "NUMBER",
      "197",
      "202",
      "APPLY 216",
      "no deploy",
      "VERIFY",
      "kazalar",
      "yasalar",
      "haklar",
      "hakkında",
      "yaşatan",
    ]) {
      expect(header, word).toContain(word);
    }
    // the added rows do not all read as the query for a short stem: the header states what was measured, with the residual homographs
    expect(header.includes("The titles read as the query")).toBe(false);
    expect(header.includes("the added rows read as the query")).toBe(false);
    expect(header).toContain("residual");
    expect(header).toContain("version = '216'");
    expect(header.startsWith("216_search_cluster_ids_new_content_words.sql")).toBe(true);
  });

  it("the header says the stop words are read from the Turkish-lettered p_variants[1], not from p_folded ('icin' is {iç})", () => {
    const header = flat(header216());
    expect(header).toContain("not from p_folded");
    expect(header).toContain("'icin'");
    expect(header).toContain("{iç}");
  });

  it("VERIFY carries the md5 and the length of THIS file's function body", () => {
    const body = body216();
    expect(header216()).toContain(`${md5(body)}, ${len(body)}`);
    expect(md5(body)).not.toBe(LIVE_215_MD5);
    expect(md5(body)).not.toBe(V1_MD5);
    expect(md5(body)).not.toBe(V2_MD5);
  });

  it("VERIFY checks the grants (false, false, true) and one stop-word query that returns a full page", () => {
    const header = header216();
    const at = header.indexOf("-- VERIFY");
    const end = header.indexOf("-- ROLLBACK", at);
    expect(at, "the VERIFY block").toBeGreaterThanOrEqual(0);
    expect(end, "the ROLLBACK block after it").toBeGreaterThan(at);
    const verify = flat(header.slice(at, end));
    expect(verify).toContain("has_function_privilege('anon'");
    expect(verify).toContain("has_function_privilege('service_role'");
    expect(verify).toContain("false, false, true");
    expect(verify).toContain("search_cluster_ids_new(array['iran ile abd']");
  });
});

describe("216 search_cluster_ids_new_content_words: the function", () => {
  it("is 215's function: the same create or replace header, arguments, attributes (language sql stable security definer, empty search_path)", () => {
    const h216 = collapse(functionHeader(stripComments(sql216)));
    const h215 = collapse(functionHeader(stripComments(sql215)));
    expect(h216).toBe(h215);
    expect(h216.toLowerCase()).toContain("language sql stable security definer set search_path = ''");
    expect(h216).toContain("p_limit integer default 24, p_offset integer default 0");
  });

  it("the body is 215's body with edits only in lw (and the new sw before it) and in the lit_d expression: the three other spans are 215's byte for byte, pinned by md5 and length", () => {
    const a215 = spans215();
    const a216 = spans216();
    // 215's own spans are what they were (so the pins below are 215's)
    expect([md5(a215.a), len(a215.a)]).toEqual([SPAN_A.md5, SPAN_A.length]);
    expect([md5(a215.lw), len(a215.lw)]).toEqual([SPAN_LW_215.md5, SPAN_LW_215.length]);
    expect([md5(a215.b), len(a215.b)]).toEqual([SPAN_B.md5, SPAN_B.length]);
    expect([md5(a215.c), len(a215.c)]).toEqual([SPAN_C.md5, SPAN_C.length]);
    expect(md5(a215.a + a215.lw + a215.b + a215.litd + a215.c)).toBe(LIVE_215_MD5);
    // 216 leaves the three spans alone
    expect([md5(a216.a), len(a216.a)]).toEqual([SPAN_A.md5, SPAN_A.length]);
    expect([md5(a216.b), len(a216.b)]).toEqual([SPAN_B.md5, SPAN_B.length]);
    expect([md5(a216.c), len(a216.c)]).toEqual([SPAN_C.md5, SPAN_C.length]);
    // and puts back together as a body of the same shape: the pieces tile the whole body, nothing sits between them
    expect(a216.a + a216.sw + a216.lw + a216.b + a216.litd + a216.c).toBe(body216());
    // reversing the three edits gives 215's body, whose md5 is production's
    expect(md5(a216.a + a215.lw + a216.b + a215.litd + a216.c)).toBe(LIVE_215_MD5);
  });

  it("sw (new): the words of p_variants[1] split on non-alphanumerics, the ones ts_lexize of turkish_stem reads as '{}', folded; p_folded is not read there", () => {
    const sw = collapse(stripComments(spans216().sw));
    expect(sw).toBe(
      "), sw as ( select distinct public.tayf_search_fold(s.w) as w " +
        "from pg_catalog.regexp_split_to_table(coalesce(p_variants[1], ''), '[^[:alnum:]]+') as s(w) " +
        "where s.w <> '' " +
        "and pg_catalog.ts_lexize('pg_catalog.turkish_stem'::pg_catalog.regdictionary, s.w) = '{}'::pg_catalog.text[]",
    );
    expect(sw.includes("p_folded")).toBe(false);
    expect(sw.includes("f0")).toBe(false);
    // no pattern holds a backslash, and the words only go into ts_lexize, never into a pattern
    expect(sw.includes("\\")).toBe(false);
  });

  it("lw keeps 215's switches (empty for an `or`, alias or negated-phrase query; one-letter words of a compound query) and its cut, and adds the stop-word drop and pre2", () => {
    const lw = collapse(stripComments(spans216().lw));
    // 215's conditions, unchanged
    expect(lw).toContain("and (pg_catalog.length(s.w) >= 2 or (select f.cmp from f) is null)");
    expect(lw).toContain("and not exists (select 1 from g0 o where pg_catalog.regexp_replace(o.tok, '[^a-z0-9]+', '', 'g') = 'or')");
    expect(lw).toContain("and not exists (select 1 from f0 where pg_catalog.strpos(f0.ff, '-\"') > 0)");
    expect(lw).toContain("pg_catalog.regexp_split_to_table(g0.tok, '[^a-z0-9]+') as s(w)");
    expect(lw).toContain("where s.w <> ''");
    // 194's cut: the word itself up to 4 letters, else all but its last two
    expect(lw).toContain("pg_catalog.left(x.w, greatest(least(pg_catalog.length(x.w), 4), pg_catalog.length(x.w) - 2)) as pre");
    // the stop words are dropped, unless that would leave no word
    expect(lw).toContain("exists (select 1 from sw where sw.w = s.w)");
    expect(lw).toContain("where not t.stop or t.all_stop");
    expect(lw).toContain("pg_catalog.bool_and(");
    // pre2 is the folded turkish stem, for a stem that is a proper prefix of the word and either 5+ letters or gx's own `ex` test
    expect(lw).toContain("(pg_catalog.ts_lexize('pg_catalog.turkish_stem'::pg_catalog.regdictionary, s.w))[1]");
    expect(lw).toContain("public.tayf_search_fold(x.st)");
    expect(lw).toContain("pg_catalog.length(x.st) < pg_catalog.length(x.w)");
    expect(lw).toContain("pg_catalog.left(x.w, pg_catalog.length(x.st)) = public.tayf_search_fold(x.st)");
    expect(lw).toContain("pg_catalog.length(x.st) >= 5");
    expect(lw).toContain("pg_catalog.length(x.st) between 3 and 4");
    expect(lw).toContain("(pg_catalog.length(x.st) = 4 or pg_catalog.length(x.w) - pg_catalog.length(x.st) >= 3)");
    expect(lw).toContain(`pg_catalog.substr(x.w, pg_catalog.length(x.st) + 1) ~ ${SUFFIX_RE}`);
    expect(lw).toContain("select distinct t.pre, t.pre2");
    // the suffix pattern is gx's own, character for character (the same constant, twice in the body)
    const gx = collapse(stripComments(body216()));
    expect(countOf(gx, SUFFIX_RE)).toBe(2);
    expect(countOf(collapse(stripComments(body215)), SUFFIX_RE)).toBe(1);
    // no blanket stem prefix: the stem is only ever used through pre2, as a whole-word prefix of the title word
    expect(lw.includes("p_folded")).toBe(false);
    expect(lw.includes("\\")).toBe(false);
  });

  it("lit_d accepts a title word that starts with pre OR with pre2 (a 5+ letter pre2 as a word-start prefix, a 3-4 letter one only through the allow-list), and still needs every kept word; the final select is 215's", () => {
    const { litd } = spans216();
    expect(collapse(stripComments(litd))).toBe(LITD_216_CODE);
    expect(shortStemsAreAllowListed(collapse(stripComments(litd)))).toBe(true);
    expect(litd.split("\n")[0]?.startsWith("           -- 216")).toBe(true);
    const body = collapse(stripComments(body216()));
    expect(countOf(body, "as lit_d")).toBe(1);
    expect(body.endsWith(
      "select h.id from hits h where h.lit_d or not exists (select 1 from lw) order by h.updated_at desc, h.id " +
        "limit least(greatest(coalesce(p_limit, 24), 1), 24) offset greatest(0, least(coalesce(p_offset, 0), 72));",
    )).toBe(true);
  });

  it("keeps every other 215 edit: kept NOT MATERIALIZED, hits MATERIALIZED, top 150, the clamps, one read of p_limit and p_offset", () => {
    const body = collapse(stripComments(body216()));
    expect(countOf(body, "), kept as not materialized (")).toBe(1);
    expect(countOf(body, "), hits as materialized (")).toBe(1);
    expect(countOf(body, "not materialized")).toBe(1);
    expect(body).toContain("select k.id from kept k order by k.updated_at desc, k.id limit 150), sw as (");
    expect(body.includes("limit 1000")).toBe(false);
    expect(countOf(body, "p_limit")).toBe(1);
    expect(countOf(body, "p_offset")).toBe(1);
    expect(body215.includes("hits as materialized")).toBe(true);
    expect(body216().includes("the planner (the function is not inlined and is planned with p_limit and p_offset unbound)")).toBe(true);
    // p_folded is read where 215 read it (f0 only); p_variants once more than 215 (sw)
    const b215 = collapse(stripComments(body215));
    expect(countOf(body, "p_folded")).toBe(countOf(b215, "p_folded"));
    expect(countOf(body, "p_variants")).toBe(countOf(b215, "p_variants") + 1);
  });

  it("reads no ranking and creates no new relation: no ts_rank_cd, no join to q, nothing but select in the body", () => {
    const body = collapse(stripComments(body216()));
    expect(body.includes("ts_rank_cd")).toBe(false);
    expect(body.includes("cross join q")).toBe(false);
    for (const word of ["insert into", "update ", "delete from", "create ", "drop ", "alter "]) expect(body.includes(word), word).toBe(false);
  });

  it("every function and relation in the new text is schema-qualified (the search_path is empty)", () => {
    const { sw, lw } = spans216();
    const code = collapse(stripComments(sw + lw));
    // no unqualified call of a pg_catalog function: the allowed bare words are syntax (coalesce, greatest, least, exists, distinct ...)
    for (const bare of [" length(", " left(", " substr(", " strpos(", " ts_lexize(", " regexp_split_to_table(", " bool_and(", " tayf_search_fold("]) {
      expect(code.includes(bare), `bare${bare}`).toBe(false);
    }
  });

  it("the function comment names 216, h192, stop words and the stem prefix, keeps 215's wording, and ends 'service_role only.'", () => {
    const comment = statementStartingWith(sql216, "comment on function");
    expect(comment.startsWith(`comment on function ${FN_SIG} is '`)).toBe(true);
    expect(comment.endsWith("service_role only.'")).toBe(true);
    for (const word of ["216", "h192", "h191", "stop words", "stem", "search_cluster_ids", "150", "0..72", "PGRST202", "literal"]) {
      expect(comment, word).toContain(word);
    }
    // 215's comment is the base: its first sentence is kept
    const c215 = statementStartingWith(sql215, "comment on function");
    expect(c215).toContain("Newest-first archive search, one page at a time (migration 215, h191).");
    expect(comment).toContain("Newest-first archive search, one page at a time (migration 215, h191; 216, h192).");
  });
});

describe("216 search_cluster_ids_new_content_words: lit_d's short-stem allow-list (no database)", () => {
  const tailOf = (): RegExp => {
    const [t1, t2] = tailPatterns(body216());
    expect(t1, "the tail pattern after the stem").toBe(TAIL_T);
    expect(t2, "the tail pattern after the doubled consonant is the same constant").toBe(TAIL_T);
    return new RegExp(t1 as string);
  };
  // [pre2 of the typed word, the folded display-title word]
  const ACCEPT: Array<[string, string]> = [
    ["zam", "zam"],
    ["zam", "zamlar"],
    ["zam", "zamlari"],
    ["zam", "zammi"],
    ["zam", "zammin"],
    ["kaza", "kaza"],
    ["kaza", "kazada"],
    ["kaza", "kazasinda"],
    ["kaza", "kazalari"],
    ["kaza", "kazayi"],
    ["kaza", "kazanin"],
    ["yasa", "yasasi"],
    ["yasa", "yasalar"],
    ["vergi", "vergisi"],
    ["hak", "hakki"],
    ["hak", "haklar"],
  ];
  const REJECT: Array<[string, string]> = [
    ["kaza", "kazandi"],
    ["kaza", "kazan"],
    ["kaza", "kazakistan"],
    ["kaza", "kazanc"],
    ["yasa", "yasam"],
    ["yasa", "yasandi"],
    ["yasa", "yasal"],
    ["zam", "zaman"],
    ["hak", "hakem"],
    ["hak", "hakan"],
    ["kamp", "kampanya"],
    ["kamp", "kampus"],
    ["kaza", "kaz"],
    ["zam", "zamk"],
  ];

  it("the tail pattern is a constant with no backslash, the same twice, and the stem is never part of a pattern", () => {
    const [t1, t2] = tailPatterns(body216());
    expect(t1).toBe(TAIL_T);
    expect(t2).toBe(TAIL_T);
    expect(TAIL_T.includes("\\")).toBe(false);
    expect(countOf(collapse(stripComments(body216())), TAIL_T)).toBe(2);
  });

  it("accepts the stem and the stem plus a plural, possessive or case tail, with the doubled consonant (zam, zamlar, zammi, kazada, kazasinda, kazalari, kazayi, yasasi, vergisi, hakki)", () => {
    const tail = tailOf();
    for (const [pre2, word] of ACCEPT) expect(shortStemMeets(tail, pre2, word), `${pre2} meets ${word}`).toBe(true);
  });

  it("rejects the homographs the bare word-start test let in (kazandi, kazan, kazakistan, kazanc, yasam, yasandi, zaman, hakem, hakan, kampanya, kampus)", () => {
    const tail = tailOf();
    for (const [pre2, word] of REJECT) expect(shortStemMeets(tail, pre2, word), `${pre2} meets ${word}`).toBe(false);
  });

  it("documents the residual homographs of a tail-only test: hakkinda (haklar) and yasatan (yasalar) still pass, because they ARE the stem plus a tail", () => {
    const tail = tailOf();
    expect(shortStemMeets(tail, "hak", "hakkinda")).toBe(true);
    expect(shortStemMeets(tail, "yasa", "yasatan")).toBe(true);
  });

  it("mutation: restoring the bare `strpos(dn.n, ' ' || lw.pre2) = 0` test for short stems is caught (the allow-list check fails, the lit_d pin fails)", () => {
    const real = body216();
    expect(shortStemsAreAllowListed(collapse(stripComments(spans216().litd)))).toBe(true);
    const mutated = withBarePre2(real);
    expect(mutated).not.toBe(real);
    const mutatedLitd = collapse(stripComments(mutated.slice(mutated.indexOf("           -- 216", mutated.indexOf(HITS_OPEN)), mutated.indexOf(" as lit_d\n", mutated.indexOf(HITS_OPEN)) + " as lit_d\n".length)));
    expect(mutatedLitd.includes(`(lw.pre2 is null or ${BARE_PRE2})`)).toBe(true);
    expect(shortStemsAreAllowListed(mutatedLitd)).toBe(false);
    expect(mutatedLitd).not.toBe(LITD_216_CODE);
    // the mutation also lets the homographs through, which the static cases above reject
    expect(countOf(mutatedLitd, "regexp_split_to_table")).toBe(0);
  });

  it("every call in lit_d is schema-qualified (the search_path is empty), and no user text reaches a pattern", () => {
    const code = collapse(stripComments(spans216().litd));
    for (const bare of [" length(", " left(", " right(", " substr(", " strpos(", " regexp_split_to_table("]) {
      expect(code.includes(bare), `bare${bare}`).toBe(false);
    }
    expect(code.includes("\\")).toBe(false);
    // the only patterns are the two constants, and the vowel class
    expect(countOf(code, " ~ '")).toBe(2);
    expect(countOf(code, " !~ '")).toBe(1);
  });

  it("the lit_d comment says a 3-4 letter pre2 is met only by the stem or the stem plus a tail, and a 5+ letter pre2 is still a word-start prefix", () => {
    const text = flat(spans216().litd.split("\n").filter((l) => l.trimStart().startsWith("--")).join("\n").replaceAll("           --", "--"));
    expect(text).toContain("3-4 letter pre2");
    expect(text).toContain("word-start prefix");
    expect(text).toContain("kazalar");
    expect(text).toContain("yasalar");
    expect(text).toContain("tail");
  });
});

describe("216 search_cluster_ids_new_content_words: the other search functions stay as they are", () => {
  it("does not create, replace, drop, alter, comment on, revoke or grant search_cluster_ids or search_cluster_ids_v2", () => {
    const stmts = statements(sql216).map((s) => s.toLowerCase());
    for (const stmt of stmts) {
      for (const other of ["function public.search_cluster_ids(", "function public.search_cluster_ids (", "function public.search_cluster_ids_v2("]) {
        expect(stmt.includes(other), `${other} in ${stmt.slice(0, 80)}`).toBe(false);
      }
    }
    const commentAt = sql216.indexOf("comment on function");
    const commentEnd = sql216.indexOf(";\n", commentAt);
    expect(commentAt).toBeGreaterThan(0);
    const code = collapse(stripComments(sql216.slice(0, commentAt) + sql216.slice(commentEnd + 1)));
    expect(code.includes("search_cluster_ids_v2")).toBe(false);
    expect(code.includes("function public.search_cluster_ids(")).toBe(false);
    expect(code.includes("drop function")).toBe(false);
    expect(code.includes("alter function")).toBe(false);
  });

  it("is additive: one create or replace of the one function 215 created, its comment, grants, the notify and the ledger row; no table, column, index, trigger, cron job or data change", () => {
    const stmts = statements(sql216).map((s) => s.toLowerCase());
    const allowed = ["begin", "set local lock_timeout", "create or replace function", "comment on function", "revoke all on function", "grant execute on function", "notify pgrst", "insert into supabase_migrations.schema_migrations", "commit"];
    for (const stmt of stmts) {
      expect(
        allowed.some((a) => stmt.startsWith(a)),
        stmt.slice(0, 80),
      ).toBe(true);
    }
    expect(stmts.filter((s) => s.startsWith("create or replace function"))).toHaveLength(1);
    expect(stmts.filter((s) => s.startsWith("insert into"))).toHaveLength(1);
    expect(stmts).toHaveLength(9);
  });
});

describe("216 search_cluster_ids_new_content_words: access", () => {
  it("revokes execute from public, anon and authenticated and grants it to service_role only, for this signature (exactly 215's grants)", () => {
    const stmts = statements(sql216);
    expect(stmts).toContain(REVOKE_STMT.slice(0, -1));
    expect(stmts).toContain(GRANT_STMT.slice(0, -1));
    expect(countOf(collapse(stripComments(sql216)), "grant ")).toBe(1);
    expect(collapse(stripComments(sql216)).includes("to anon")).toBe(false);
    expect(collapse(stripComments(sql216)).includes("to authenticated")).toBe(false);
    const s215 = statements(sql215);
    expect(s215).toContain(REVOKE_STMT.slice(0, -1));
    expect(s215).toContain(GRANT_STMT.slice(0, -1));
  });

  it("is not an anon RPC: the anon surface allowlist is untouched and the function needs no ops_health_report identity", () => {
    expect(collapse(stripComments(sql216)).includes("ops_health_report")).toBe(false);
  });
});

describe("216 search_cluster_ids_new_content_words: the app is not changed", () => {
  it("the app still calls search_cluster_ids_new(p_variants, p_folded, p_limit, p_offset), with p_variants[1] the Turkish-lettered lower-cased query", () => {
    const source = readFileSync(SEARCH_QUERY_SOURCE, "utf8");
    const at = source.indexOf('rpc("search_cluster_ids_new"');
    expect(at, "the app's call").toBeGreaterThan(0);
    const call = source.slice(at, source.indexOf("});", at));
    expect(call).toContain("p_variants: typed");
    expect(call).toContain("p_folded: folded");
    expect(call).toContain("p_limit: SEARCH_LIMIT");
    expect(call).toContain("p_offset: (page - 1) * SEARCH_LIMIT");
    // typed = turkishQueryVariants(base): its first element is t.toLocaleLowerCase("tr")
    const turkish = readFileSync(resolve(ROOT, "src", "lib", "clusters", "turkish-query.ts"), "utf8");
    expect(turkish).toContain('t.toLocaleLowerCase("tr"),');
    expect(source).toContain("typed: turkishQueryVariants(base)");
    expect(source).toContain("folded: foldTr(");
  });
});

describe("216 search_cluster_ids_new_content_words: the migration guide", () => {
  const guide = readFileSync(DOC_MIGRATION_GUIDE, "utf8");

  it("has a ## 216 section whose title carries the function name, the stop words and the apply rule, after 215", () => {
    const at = guide.indexOf("\n## 216 ");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeGreaterThan(guide.indexOf("\n## 215 "));
    const title = guide.slice(at + 1, guide.indexOf("\n", at + 1));
    expect(title).toContain("search_cluster_ids_new");
    expect(title).toContain("stop words");
    expect(title).toContain("APPLY 216");
    expect(title).toContain("no deploy");
  });

  it("the section carries the fingerprints (215's and 216's), the replay words, the apply order and the rollback", () => {
    const section = sectionOf(guide, "216");
    expect(section).toContain(LIVE_215_MD5);
    expect(section).toContain(String(LIVE_215_LENGTH));
    const body = body216();
    expect(section).toContain(md5(body));
    expect(section).toContain(String(len(body)));
    for (const word of ["iran ile abd", "zamlar", "vergiler", "kararnamelerinin", "Irak", "force_generic_plan", "p_variants[1]", "**Rollback:**", "**Order:**", "**Verify**", "kazalar", "yasalar", "haklar", "hakkında", "yaşatan"]) {
      expect(section, word).toContain(word);
    }
    expect(section.includes("the added rows read as the query")).toBe(false);
    expect(section).toContain("residual");
    expect(section).toContain("215_search_cluster_ids_new.sql");
    expect(section).toContain("version = '216'");
  });
});

describe("216 dry-run and live manifest", () => {
  const dry = existsSync(DRYRUN_216) ? readFileSync(DRYRUN_216, "utf8") : "";

  it("builds 216's database with its own dry-run script: one run entry, that script as the only setup file", () => {
    const lines = readFileSync(MANIFEST, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("run | 216-search-cluster-ids-new-content-words.test.ts"));
    expect(lines).toEqual([
      "run | 216-search-cluster-ids-new-content-words.test.ts | tests/migrations/sql/216-search-cluster-ids-new-content-words-dryrun.sql | - | 0",
    ]);
  });

  it("the dry-run builds production's state (the 129 setup, 166 ... 211 and 215, gated on their md5), applies 216 twice and ends with its OK line", () => {
    expect(existsSync(DRYRUN_216)).toBe(true);
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
      "../../../supabase/migrations/211_search_cluster_ids_v2_offset.sql",
      "../../../supabase/migrations/215_search_cluster_ids_new.sql",
      "../../../supabase/migrations/216_search_cluster_ids_new_content_words.sql",
      "../../../supabase/migrations/216_search_cluster_ids_new_content_words.sql",
    ]);
    for (const word of [V1_MD5, String(V1_LENGTH), V2_MD5, String(V2_LENGTH), LIVE_215_MD5, String(LIVE_215_LENGTH), md5(body216()), String(len(body216()))]) {
      expect(dry, word).toContain(word);
    }
    expect(dry.trimEnd().endsWith("\\echo DRYRUN 216 OK")).toBe(true);
    expect(dry).toContain("-f tests/migrations/sql/stub.sql");
    expect(dry).toContain("D=$(mktemp -d)");
    expect(dry).toContain("-- or: bash tests/migrations/sql/run-live.sh");
  });

  it("the dry-run checks the contract: a pg_temp copy of 215's body, stop words, the stem prefix, the Irak guard, an all-stop-word query, an alias and a negated phrase, the grants and the untouched functions", () => {
    for (const w of [
      "old215",
      "iran ile abd",
      "zamlar",
      "vergiler",
      "kararnamelerinin",
      "Irak",
      "ile ve",
      "akp or ak parti",
      "has_function_privilege",
      "insufficient_privilege",
      "search_cluster_ids_v2",
      "'icin'",
      "rollback;",
    ]) {
      expect(dry, w).toContain(w);
    }
  });
});

// ---------------------------------------------------------------------------
// Live block (opt-in). TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/PGDATABASE point at a THROWAWAY database that the dry-run script left
// behind with 129, 166, 172, 185, 186, 194, 196, 198, 204, 211, 215 and 216 applied (tests/migrations/sql/live-manifest.txt). Every scenario runs
// inside begin ... rollback: it seeds clusters, creates pg_temp.old215 (215's body, read from the 215 file), and calls both the installed
// search_cluster_ids_new (216) and old215 the way the app does (typed variants, folded text, p_limit 24, p_offset 0), then checks:
//   (1) 'iran ile abd' lists 'ABD ile İran müzakereleri' AND 'İran ABD müzakereleri' AND 'İran ve ABD gerilimi sürüyor' (old215: the one with 'ile');
//   (2) 'zamlar' lists a title with 'zam' and one with 'zamları'; 'vergiler' and 'kararnamelerinin' list the stem-form titles;
//   (3) 'iran' does NOT list a title 'Irak ...' whose summary holds 'İran' (the stem 'ira' is not a prefix of the title word 'irak'), and neither does 'tarla'
//       list 'Tarım ...' (a 3-letter stem needs a suffix of 3 letters);
//   (4) a query of stop words only ('ile ve') and the ASCII spelling 'icin' (p_variants[1] holds 'icin') behave as in 215; 'ile bir' drops only 'ile';
//   (5) an alias query and a negated phrase still list their newest rows (lw empty), the same ids as 215;
//   (6) no regression: queries without a stop word or a stem widening list exactly 215's ids in the same order (deprem, burdur, tarla);
//   (7) the short-stem allow-list (db-1): 'kazalar' lists '... kazasında yaralandı' and neither '... sandalye kazandı' (its summary holds 'kaza') nor 'Kazakistan ...',
//       'yasalar' lists a title with 'yasa' and not 'Sağlıklı Yaşam Merkezi açıldı', 'zamlar' lists both 'zam' and 'zammı'; a pg_temp copy with the bare strpos test for
//       short stems (the mutation) lists the unrelated titles, so the fixtures bite.
// ---------------------------------------------------------------------------

const seedId = (n: number): string => `00000000-0000-4000-8000-${String(216000 + n).padStart(12, "0")}`;
const lit = (s: string | null): string => (s === null ? "null" : `'${s.replaceAll("'", "''")}'`);
const arr = (variants: string[]): string => `array[${variants.map(lit).join(", ")}]::text[]`;

describe.runIf(Boolean(process.env.TAYF_PSQL))("216 search_cluster_ids_new against a live Postgres (129, 166, 172, 185, 186, 194, 196, 198, 204, 211, 215 and 216 applied)", () => {
  assertLiveReady("216", {
    ledger: ["129", "166", "172", "185", "186", "194", "196", "198", "204", "211", "215", "216"],
    relations: ["public.clusters_search_tsv_live_idx", "public.clusters_search_fold_live_idx", "public.clusters_search_stemfold_live_idx"],
    functions: [
      "public.search_cluster_ids(text[],text,integer)",
      "public.search_cluster_ids_v2(text[],text,integer,integer)",
      "public.search_cluster_ids_new(text[],text,integer,integer)",
      "public.tayf_search_fold(text)",
    ],
  });

  function runPsql(input: string): string {
    return execFileSync(process.env.TAYF_PSQL as string, ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      input,
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8", PGOPTIONS: "-c client_min_messages=warning" },
      maxBuffer: 16 * 1024 * 1024,
    });
  }

  /** 215's function, as a pg_temp function (the body of the 215 file: what production ran before 216). */
  const old215 =
    "create function pg_temp.old215(p_variants text[], p_folded text, p_limit integer default 24, p_offset integer default 0) returns table (id uuid) " +
    `language sql stable set search_path = '' as $old$${body215}$old$;`;

  /** 216's function with the bare word-start test for every pre2 (the mutation db-1 fixed): the unrelated 'kazandı', 'Kazakistan' and 'yaşam' titles come back. */
  const mut216 =
    "create function pg_temp.mut216(p_variants text[], p_folded text, p_limit integer default 24, p_offset integer default 0) returns table (id uuid) " +
    `language sql stable set search_path = '' as $mut$${withBarePre2(body216())}$mut$;`;

  /** One call of a function (the installed one, or pg_temp.old215), the way the app makes it; the output line is `<tag>|<id>,<id>,...`. */
  const callFn = (fn: string, tag: string, variants: string[], folded: string | null, limit = "24", offset = "0"): string =>
    `select ${lit(tag)} || '|' || coalesce((select string_agg(t.id::text, ',' order by t.n) ` +
    `from ${fn}(${arr(variants)}, ${folded === null ? "null" : lit(folded)}, ${limit}, ${offset}) with ordinality as t(id, n)), '');`;
  const now216 = (tag: string, variants: string[], folded: string | null, limit?: string, offset?: string): string =>
    callFn("public.search_cluster_ids_new", tag, variants, folded, limit, offset);
  const was215 = (tag: string, variants: string[], folded: string | null, limit?: string, offset?: string): string =>
    callFn("pg_temp.old215", `old_${tag}`, variants, folded, limit, offset);
  /** The same call on both functions: tags `<tag>` (216) and `old_<tag>` (215). */
  const both = (tag: string, variants: string[], folded: string | null): string[] => [now216(tag, variants, folded), was215(tag, variants, folded)];

  const ids = (out: Map<string, string[]>, tag: string): string[] => {
    const v = out.get(tag);
    expect(v, `no result for ${tag}`).toBeDefined();
    return v as string[];
  };
  const parse = (text: string): Map<string, string[]> => {
    const m = new Map<string, string[]>();
    for (const line of text.split("\n")) {
      if (line === "") continue;
      const bar = line.indexOf("|");
      const tag = line.slice(0, bar);
      const rest = line.slice(bar + 1);
      m.set(tag, rest === "" ? [] : rest.split(","));
    }
    return m;
  };

  const insertRows = (rows: Array<[number, string, string | null, string, number, string]>): string =>
    `insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at) values\n` +
    rows
      .map(([n, title, neutral, summary, count, age]) => `  (${lit(seedId(n))}, ${lit(title)}, ${lit(neutral)}, ${lit(summary)}, ${count}, false, now() - interval '${age}')`)
      .join(",\n") +
    ";";

  const contentScript = [
    "begin;",
    old215,
    mut216,
    insertRows([
      // iran ile abd: the stop word 'ile'
      [101, "ABD ile İran müzakereleri", null, "Görüşme sürdü.", 3, "1 hour"],
      [102, "İran ABD müzakereleri", null, "Heyetler toplandı.", 3, "2 hours"],
      [103, "İran ve ABD gerilimi sürüyor", null, "Taraflar açıklama yaptı.", 3, "3 hours"],
      [104, "Irak ile ABD görüşmesi", null, "İran gelişmeleri de konuşuldu.", 3, "30 minutes"],
      [105, "ABD yaptırımları açıkladı", null, "İran ile ilgili kararlar duyuruldu.", 3, "20 minutes"],
      // zamlar: the title word built on the stem ('zam'), and the plural
      [111, "Elektriğe zam geldi", null, "EPDK açıkladı.", 3, "1 hour"],
      [112, "Doğalgaz zamları yürürlüğe girdi", null, "BOTAŞ duyurdu.", 3, "2 hours"],
      [113, "Zamlar sürüyor", null, "Fiyatlar yükseldi.", 3, "3 hours"],
      [114, "Akaryakıt zammı açıklandı", null, "Pompaya zam geldi.", 3, "4 hours"],
      // vergiler, kararnamelerinin
      [121, "Vergi artışı açıklandı", null, "Maliye duyurdu.", 3, "1 hour"],
      [122, "Yeni vergiler geliyor", null, "Taslak hazır.", 3, "2 hours"],
      [131, "Kararname yayımlandı", null, "Resmi Gazete duyurdu.", 3, "1 hour"],
      [132, "Kararnamelerin ayrıntıları belli oldu", null, "Maddeler açıklandı.", 3, "2 hours"],
      // iran: the title 'Irak ...' whose summary holds 'İran' must not pass for iran
      [141, "İran açıklama yaptı", null, "Bakanlık duyurdu.", 2, "3 hours"],
      [142, "Irak yeni hükümeti kurdu", null, "İran etkisi tartışılıyor.", 2, "5 minutes"],
      // tarla: a 3-letter stem with a 2-letter suffix stays unwidened
      [151, "Tarla sulama projesi başladı", null, "Çiftçiler memnun.", 2, "2 hours"],
      [152, "Tarım destekleri açıklandı", null, "Tarlalar için destek verilecek.", 2, "1 hour"],
      // deprem için bakan: the stop word 'için' (Turkish letters in p_variants[1])
      [161, "Deprem için bakan açıklama yaptı", null, "Bölgede çalışmalar sürüyor.", 3, "1 hour"],
      [162, "Deprem bölgesine bakan gitti", null, "Yardım için ekipler sahada.", 3, "2 hours"],
      [164, "Deprem bakan görüşmesi", null, "Toplantı yapıldı.", 3, "4 hours"],
      [163, "Deprem sonrası borsa düştü", null, "Bakan açıklama yaptı.", 3, "30 minutes"],
      // kazalar (pre2 'kaza'): 181 and 184 hold a word built on the stem; 182 ('kazandı', summary holds 'kaza') and 183 ('Kazakistan') merely start with it
      [181, "Otoyolda zincirleme kazasında üç kişi yaralandı", null, "Kaza sonrası ekipler sevk edildi.", 3, "1 hour"],
      [182, "Demokratlar ara seçimlerde sandalye kazandı", null, "Sayım merkezinde kaza oldu.", 3, "90 minutes"],
      [183, "Kazakistan Cumhurbaşkanı Tokayev görüştü", null, "Trafik kazaları da konuşuldu.", 3, "100 minutes"],
      [184, "Trafik kazaları arttı", null, "Emniyet açıklama yaptı.", 3, "2 hours"],
      // yasalar (pre2 'yasa'): 191 holds 'yasa', 192 holds 'yaşam' (folded: yasam) and 'yasa' only in its summary
      [191, "Yeni yasa Meclis'te kabul edildi", null, "Teklif yasasına ilişkin oylama yapıldı.", 3, "1 hour"],
      [192, "Sağlıklı Yaşam Merkezi açıldı", null, "Yeni yasa kapsamında merkezler hizmete girdi.", 3, "30 minutes"],
      // ile / bir: 'ile' is a stop word, 'bir' is not (ts_lexize gives {bir})
      [171, "Bir ayda ikinci deprem", null, "Uzmanlar uyardı.", 3, "1 hour"],
      [172, "Barış ile bir araya geldiler", null, "Görüşme sürdü.", 3, "2 hours"],
      [173, "Kayıp ile ilgili açıklama", null, "Polis araştırıyor.", 3, "3 hours"],
    ]),
    `insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at)
select ('00000000-0000-4000-8000-' || lpad((216300 + n)::text, 12, '0'))::uuid, 'Deprem haberi ' || n, null, 'Ayrıntılar sürüyor.', 2 + (n % 5), false, now() - make_interval(hours => 10 + n)
  from generate_series(1, 30) n;`,
    "analyze public.clusters;",
    ...both("iran_ile_abd", ["iran ile abd"], "iran ile abd"),
    ...both("iran_abd", ["iran abd"], "iran abd"),
    ...both("zamlar", ["zamlar"], "zamlar"),
    ...both("zam", ["zam"], "zam"),
    ...both("vergiler", ["vergiler"], "vergiler"),
    ...both("kararnamelerinin", ["kararnamelerinin"], "kararnamelerinin"),
    ...both("iran", ["iran"], "iran"),
    ...both("tarla", ["tarla"], "tarla"),
    ...both("deprem_icin_bakan", ["deprem için bakan"], "deprem icin bakan"),
    ...both("deprem_bakan", ["deprem bakan"], "deprem bakan"),
    // the ASCII spelling: p_variants[1] holds 'icin', which the stemmer reads as iç, so it is not a stop word
    ...both("deprem_icin_ascii", ["deprem icin bakan"], "deprem icin bakan"),
    ...both("ile_ve", ["ile ve"], "ile ve"),
    ...both("ile_bir", ["ile bir"], "ile bir"),
    ...both("deprem", ["deprem"], "deprem"),
    // the short-stem allow-list: kazalar, yasalar, and the mutation (the bare strpos test for every pre2)
    ...both("kazalar", ["kazalar"], "kazalar"),
    ...both("yasalar", ["yasalar"], "yasalar"),
    callFn("pg_temp.mut216", "mut_kazalar", ["kazalar"], "kazalar"),
    callFn("pg_temp.mut216", "mut_yasalar", ["yasalar"], "yasalar"),
    // 've' is a stop word too
    ...both("ve", ["deprem ve bakan"], "deprem ve bakan"),
    // the null and empty arguments
    ...both("empty", [""], ""),
    ...both("nullfold", ["okul"], null),
    "select 'nullvariants|' || coalesce((select string_agg(t.id::text, ',') from public.search_cluster_ids_new(null, 'deprem', 24, 0) as t), '');",
    "rollback;",
  ].join("\n");

  let content: Map<string, string[]> | null = null;
  const contentOut = (): Map<string, string[]> => (content ??= parse(runPsql(contentScript)));

  it("'iran ile abd' lists the title with 'ile' AND the titles without it, newest first, and no title that lacks the word iran (215 listed only the first)", () => {
    expect(ids(contentOut(), "old_iran_ile_abd")).toEqual([seedId(101)]);
    expect(ids(contentOut(), "iran_ile_abd")).toEqual([seedId(101), seedId(102), seedId(103)]);
    // the titles of the summary-only rows (Irak ile ABD ..., ABD yaptırımları ...) are not listed
    expect(ids(contentOut(), "iran_ile_abd")).not.toContain(seedId(104));
    expect(ids(contentOut(), "iran_ile_abd")).not.toContain(seedId(105));
  });

  it("'iran ile abd' lists what its stem-form query 'iran abd' lists (the stop word is the only difference)", () => {
    expect(ids(contentOut(), "iran_ile_abd")).toEqual(ids(contentOut(), "iran_abd"));
  });

  it("'zamlar' lists the titles with 'zam' and 'zammı' and the titles with 'zamları' and 'Zamlar' (215 listed only the last two)", () => {
    expect(ids(contentOut(), "old_zamlar")).toEqual([seedId(112), seedId(113)]);
    expect(ids(contentOut(), "zamlar")).toEqual([seedId(111), seedId(112), seedId(113), seedId(114)]);
    expect(ids(contentOut(), "zamlar")).toContain(seedId(111));
    expect(ids(contentOut(), "zamlar")).toContain(seedId(114));
    expect(ids(contentOut(), "zamlar")).toEqual(ids(contentOut(), "zam"));
  });

  it("'kazalar' lists the title with 'kazasında' and not the titles that merely start with 'kaza' ('... sandalye kazandı' with 'kaza' in its summary, 'Kazakistan ...'); the bare strpos test (mutation) lists them", () => {
    expect(ids(contentOut(), "kazalar")).toEqual([seedId(181), seedId(184)]);
    expect(ids(contentOut(), "kazalar")).not.toContain(seedId(182));
    expect(ids(contentOut(), "kazalar")).not.toContain(seedId(183));
    // 215 needed a title word that starts with 'kazal' (kazaları): the title with 'kazasında' was missing
    expect(ids(contentOut(), "old_kazalar")).toEqual([seedId(184)]);
    // restoring the bare word-start test for the short stem brings the unrelated titles back: the fixtures bite
    expect(ids(contentOut(), "mut_kazalar")).toEqual([seedId(181), seedId(182), seedId(183), seedId(184)]);
  });

  it("'yasalar' lists the title with 'yasa' and not 'Sağlıklı Yaşam Merkezi açıldı' (yasam), which the bare strpos test (mutation) lists", () => {
    expect(ids(contentOut(), "yasalar")).toEqual([seedId(191)]);
    expect(ids(contentOut(), "yasalar")).not.toContain(seedId(192));
    expect(ids(contentOut(), "old_yasalar")).toEqual([]);
    expect(ids(contentOut(), "mut_yasalar")).toEqual(expect.arrayContaining([seedId(191), seedId(192)]));
  });

  it("'vergiler' lists 'Vergi artışı' and 'Yeni vergiler'; 'kararnamelerinin' lists 'Kararname yayımlandı' and 'Kararnamelerin ...' (215 listed one each)", () => {
    expect(ids(contentOut(), "old_vergiler")).toEqual([seedId(122)]);
    expect(ids(contentOut(), "vergiler")).toEqual([seedId(121), seedId(122)]);
    expect(ids(contentOut(), "old_kararnamelerinin")).toEqual([seedId(132)]);
    expect(ids(contentOut(), "kararnamelerinin")).toEqual([seedId(131), seedId(132)]);
  });

  it("guard against the stem-prefix over-reach: 'iran' does NOT list the 'Irak ...' title whose summary holds 'İran' (the stem 'ira' is not a prefix of iran plus a suffix), and lists what 215 listed", () => {
    expect(ids(contentOut(), "iran")).not.toContain(seedId(142));
    // the four titles that hold the word iran (the tie of 103 and 141, both 3 hours old, is listed in id order)
    expect(ids(contentOut(), "iran")).toEqual([seedId(101), seedId(102), seedId(103), seedId(141)]);
    expect(ids(contentOut(), "iran")).toEqual(ids(contentOut(), "old_iran"));
  });

  it("guard: 'tarla' (stem 'tar', a 2-letter suffix) does not list 'Tarım destekleri' either, and equals 215", () => {
    expect(ids(contentOut(), "tarla")).toEqual([seedId(151)]);
    expect(ids(contentOut(), "tarla")).toEqual(ids(contentOut(), "old_tarla"));
  });

  it("'deprem için bakan' (Turkish letters) does not require the word 'için': it lists the title without it, in date order (215 listed only the title with 'için')", () => {
    expect(ids(contentOut(), "old_deprem_icin_bakan")).toEqual([seedId(161)]);
    expect(ids(contentOut(), "deprem_icin_bakan")).toEqual([seedId(161), seedId(162)]);
    // the stem-form query also lists the title that holds 'icin' nowhere: the 166 guard (not touched by 216) still wants 'icin' in the title or the summary of a
    // candidate, because the stemmer reads the ASCII fold 'icin' as the stem iç (4 letters or fewer: guarded), unlike ile, ve and ne, which are '{}' either way
    expect(ids(contentOut(), "deprem_bakan")).toEqual([seedId(161), seedId(162), seedId(164)]);
    expect(ids(contentOut(), "deprem_icin_bakan")).not.toContain(seedId(164));
    // the summary-only match (Deprem sonrası borsa düştü: 'bakan' only in the summary) is still left out
    expect(ids(contentOut(), "deprem_icin_bakan")).not.toContain(seedId(163));
  });

  it("the stop words are read from p_variants[1], not from p_folded: the ASCII spelling 'icin' is the stem iç, not a stop word, so the query behaves as in 215", () => {
    expect(ids(contentOut(), "deprem_icin_ascii")).toEqual(ids(contentOut(), "old_deprem_icin_bakan"));
  });

  it("a query of stop words only ('ile ve') keeps 215's behaviour, and 'ile bir' drops only the stop word 'ile' ('bir' stays a required word)", () => {
    expect(ids(contentOut(), "ile_ve")).toEqual(ids(contentOut(), "old_ile_ve"));
    // 'bir' is {bir} for the stemmer, so it is a content word: the titles that start a word with 'bir' ('Bir ayda ...', 'Barış ile bir araya ...' has 'bir' too)
    expect(ids(contentOut(), "ile_bir")).toEqual([seedId(171), seedId(172)]);
    expect(ids(contentOut(), "old_ile_bir")).toEqual([seedId(172)]);
    // 've' is a stop word too: 'deprem ve bakan' lists the two titles that hold deprem and bakan (215 required the word 've' and listed none)
    expect(ids(contentOut(), "old_ve")).toEqual([]);
    expect(ids(contentOut(), "ve")).toEqual([seedId(161), seedId(162), seedId(164)]);
  });

  it("no regression: a query with no stop word and no stem widening lists exactly 215's ids in 215's order (deprem: 31 rows seeded, page 1)", () => {
    expect(ids(contentOut(), "deprem")).toEqual(ids(contentOut(), "old_deprem"));
    expect(ids(contentOut(), "deprem").length).toBeGreaterThan(20);
  });

  it("an empty query, a null folded text and an unmatched query answer without raising", () => {
    expect(ids(contentOut(), "empty")).toEqual([]);
    expect(ids(contentOut(), "old_empty")).toEqual([]);
    expect(contentOut().has("nullfold")).toBe(true);
    expect(contentOut().has("nullvariants")).toBe(true);
  });

  // --- queries with no literal tier: lw is empty, so every kept row is listed, as in 215 -----------------------
  const tierScript = [
    "begin;",
    old215,
    insertRows([
      [401, "AK Parti kongresi toplandı", null, "Delegeler oy kullandı.", 4, "2 hours"],
      [402, "Gündem yoğun", null, "AKP milletvekilleri toplandı.", 3, "1 hour"],
      [403, "Hava durumu açıklandı", null, "Yağış bekleniyor.", 5, "30 minutes"],
      [411, "İran açıklama yaptı", null, "Bakanlık duyurdu.", 2, "3 hours"],
      [412, "İran İsrail saldırısı sürüyor", null, "Saldırı devam ediyor.", 5, "1 hour"],
      [413, "Gündem özeti", null, "İran gelişmeleri konuşuldu.", 2, "2 hours"],
      [421, "Burdur'da yurt zehirlenmesi", null, "Öğrenciler hastaneye kaldırıldı.", 2, "1 hour"],
      [422, "Bursa'da sel uyarısı", null, "Uzmanlar uyardı.", 2, "30 minutes"],
    ]),
    "analyze public.clusters;",
    ...both("akp", ['akp or "ak parti"'], "akp or ak parti"),
    // an alias query with a stop word: lw stays empty
    ...both("akp_ile", ['akp ile or "ak parti"'], "akp ile or ak parti"),
    ...both("neg", ['iran -"israil saldırısı"', 'iran -"israil saldirisi"'], 'iran -"israil saldirisi"'),
    ...both("neg_ile", ['iran ile -"israil saldırısı"'], 'iran ile -"israil saldirisi"'),
    ...both("burdur", ["burdur"], "burdur"),
    ...both("hostile", ["'; drop table public.clusters; --"], "'; drop table public.clusters; --"),
    "rollback;",
  ].join("\n");

  it("an alias query (akp or \"ak parti\") and a negated phrase still list their newest rows, newest first, the same ids as 215 (lw is empty, so no word is required)", () => {
    const out = parse(runPsql(tierScript));
    expect(ids(out, "akp")).toEqual([seedId(402), seedId(401)]);
    expect(ids(out, "akp")).toEqual(ids(out, "old_akp"));
    expect(ids(out, "akp_ile")).toEqual(ids(out, "old_akp_ile"));
    expect(ids(out, "neg")).toEqual(ids(out, "old_neg"));
    expect(ids(out, "neg").length).toBeGreaterThanOrEqual(2);
    expect(ids(out, "neg_ile")).toEqual(ids(out, "old_neg_ile"));
  });

  it("keeps the 166 guard and 215's answer for 'burdur'; a hostile string lists nothing and raises nothing", () => {
    const out = parse(runPsql(tierScript));
    expect(ids(out, "burdur")).toEqual([seedId(421)]);
    expect(ids(out, "burdur")).toEqual(ids(out, "old_burdur"));
    expect(ids(out, "hostile")).toEqual([]);
  });

  // --- applied once, shape, access, the other functions ------------------------------------------
  it("is applied once: one ledger row, one overload, the body of the file, 215's attributes, service_role only, the two other search functions untouched", () => {
    const out = runPsql(`
select (select count(*) from supabase_migrations.schema_migrations where version = '216'),
       (select count(*) from pg_catalog.pg_proc where proname = 'search_cluster_ids_new' and pronamespace = 'public'::regnamespace),
       p.prosecdef, p.provolatile, (p.proconfig = array['search_path=""']), p.proacl::text, md5(p.prosrc), length(p.prosrc),
       has_function_privilege('anon', p.oid, 'execute'), has_function_privilege('authenticated', p.oid, 'execute'),
       has_function_privilege('service_role', p.oid, 'execute'),
       obj_description(p.oid, 'pg_proc') like '%216%', pg_get_function_arguments(p.oid)
  from pg_catalog.pg_proc p
 where p.oid = 'public.search_cluster_ids_new(text[], text, integer, integer)'::regprocedure;
select md5(p.prosrc), length(p.prosrc), p.proacl::text from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
select md5(p.prosrc), length(p.prosrc), p.proacl::text from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids_v2(text[], text, integer, integer)'::regprocedure;
`).trim();
    const [fnLine, v1Line, v2Line] = out.split("\n") as [string, string, string];
    const f = fnLine.split("|");
    const body = body216();
    expect(f[0]).toBe("1");
    expect(f[1]).toBe("1");
    expect(f[2]).toBe("t");
    expect(f[3]).toBe("s");
    expect(f[4]).toBe("t");
    expect(f[5]).toBe(PROD_PROACL);
    expect(f[6]).toBe(md5(body));
    expect(f[7]).toBe(String(len(body)));
    expect(f.slice(8, 11)).toEqual(["f", "f", "t"]);
    expect(f[11]).toBe("t");
    expect(f[12]).toBe("p_variants text[], p_folded text, p_limit integer DEFAULT 24, p_offset integer DEFAULT 0");
    expect(v1Line.split("|").slice(0, 2)).toEqual([V1_MD5, String(V1_LENGTH)]);
    expect(v2Line.split("|").slice(0, 2)).toEqual([V2_MD5, String(V2_LENGTH)]);
  });
});
