import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { publicBlindspotClaim } from "@/lib/clusters/recall-veto";
// 158 is frozen text: it names the six RPCs that existed when it was written. Migration 192 added a seventh
// (saved_clusters_v4), so this file pins the set BEFORE 192, not the current one.
import {
  ALLOWED_RPCS_BEFORE_192 as ALLOWED_RPCS,
  ALLOWED_RPC_IDENTITIES_BEFORE_192 as ALLOWED_RPC_IDENTITIES,
} from "../_helpers/anon-rpc-allowlist";
import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 158 ("saved-clusters-v3"), h38-saved-1.
//
// /saved is a browser component that calls the anon RPC saved_clusters_v2 (124, veto in 138).
// v2 returns no first_published, so the client could not apply the BLINDSPOT.feedDelayHours
// wait that #199 (h37-content-1) put on every other surface, and /saved showed the "Kor nokta"
// pill at once. 158 adds saved_clusters_v3: v2's text with ONE more output column,
// first_published, and the client maps every row through publicBlindspotClaim. v2 stays (the
// deployed app between the migration and the deploy, and the client's fallback while 158 is
// not applied).
//
// A new anon-executable SECURITY DEFINER function also changes what ops_health_report() row 17
// (anon_surface, migration 145) counts as exposed: its allowlist is an array of FULL IDENTITIES,
// so v3 would read as `fail` the moment 158 is applied. 158 therefore re-creates
// ops_health_report() with 157's text verbatim except three spots in row 17 (the identity array
// gains 'saved_clusters_v3(uuid[])', "five" becomes "six", "(5 izinli RPC hariç)" becomes
// "(6 ...") and its comment. Pinned here against 157's raw text.
//
// This file pins: the production fingerprint of v2 the header records (md5 of the body between
// the $fn$ markers == the latest migration's, 138), v3 = v2 + first_published, the grants
// (exactly v2's shape), v2 untouched, the ops_health_report() diff against 157, the allowlist
// (tests/_helpers/anon-rpc-allowlist.ts), the ledger pattern, the docs and the dry run. It is
// static; the live block at the end runs the real objects through psql when TAYF_PSQL is set
// (tests/migrations/sql/live-manifest.txt builds the database).
//
// SQL is scanned by character, never with a nested-quantifier regex (CodeQL).
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const MIGRATION_158 = resolve(MIGRATIONS_DIR, "158_saved_clusters_v3.sql");
const MIGRATION_157 = resolve(MIGRATIONS_DIR, "157_ingest_poll_stale.sql");
const MIGRATION_138 = resolve(MIGRATIONS_DIR, "138_saved_clusters_veto.sql");
const DOC_MIGRATION_GUIDE = resolve(ROOT, "docs", "migration-guide.md");
const DRYRUN = resolve(__dirname, "sql", "158-saved-clusters-v3-dryrun.sql");
const MANIFEST = resolve(__dirname, "sql", "live-manifest.txt");

/** What production's saved_clusters_v2 was on 2026-11-05 (read-only, pg_proc) and what 158's header records. */
const PROD_V2_MD5 = "8ad5bfef58acd7c79d238c6feee06a6d";
const PROD_V2_LENGTH = 365;
const PROD_V2_ACL = "{postgres=X/postgres,service_role=X/postgres,anon=X/postgres}";

const OPS_CREATE = "create or replace function public.ops_health_report()";
const OPS_GRANT = "grant execute on function public.ops_health_report() to service_role;";
const OPS_REVOKE = "revoke all on function public.ops_health_report() from public, anon, authenticated;";
const V3_REVOKE = "revoke all on function public.saved_clusters_v3(uuid[]) from public, anon, authenticated;";
const V3_GRANT = "grant execute on function public.saved_clusters_v3(uuid[]) to anon, service_role;";

/** 157's section, turned into 158's: each pair is one spot, present exactly once in 157. */
const SWAPS_157_TO_158: ReadonlyArray<readonly [string, string]> = [
  // row 17's own comment
  ["outside the five allowlisted RPCs", "outside the six allowlisted RPCs"],
  // row 17's identity array: the sixth entry, appended
  ["'saved_clusters_v2(uuid[])'])", "'saved_clusters_v2(uuid[])', 'saved_clusters_v3(uuid[])'])"],
  // row 17's detail text: the size of the allowlist
  ["' (5 izinli RPC hariç)'", "' (6 izinli RPC hariç)'"],
  // the function comment
  ["136, 145, 150, 157): 20 fixed rows", "136, 145, 150, 157, 158): 20 fixed rows"],
  ["other than the five'", "other than the six'"],
  [
    "source_slug_exists and'\n  ' saved_clusters_v2, each exempt",
    "source_slug_exists,'\n  ' saved_clusters_v2 and saved_clusters_v3, each exempt",
  ],
];

// -- character-scan helpers (no regular expression runs over SQL text) ----------

/** Removes `--` comments (to the end of the line, newline kept); quoted strings are copied verbatim. */
function stripComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql.charAt(i);
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql.charAt(j) === "'") {
          if (sql.charAt(j + 1) === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "-" && sql.charAt(i + 1) === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? sql.length : nl;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** Empties every single-quoted literal. */
function blankStrings(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    if (sql.charAt(i) === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql.charAt(j) === "'") {
          if (sql.charAt(j + 1) === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      out += "''";
      i = j + 1;
    } else {
      out += sql.charAt(i);
      i += 1;
    }
  }
  return out;
}

/** Splits comment-free SQL on `;`, not inside a quoted string or a dollar-quoted body. */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  let dollar: string | null = null;
  while (i < sql.length) {
    const ch = sql.charAt(i);
    if (dollar) {
      if (sql.startsWith(dollar, i)) {
        cur += dollar;
        i += dollar.length;
        dollar = null;
      } else {
        cur += ch;
        i += 1;
      }
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql.charAt(j) === "'") {
          if (sql.charAt(j + 1) === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "$") {
      const end = sql.indexOf("$", i + 1);
      const tag = end > i ? sql.slice(i, end + 1) : "";
      const isTag = tag.length >= 2 && [...tag.slice(1, -1)].every((c) => /[a-z_0-9]/i.test(c));
      if (isTag) {
        dollar = tag;
        cur += tag;
        i += tag.length;
        continue;
      }
    }
    if (ch === ";") {
      if (cur.trim() !== "") out.push(cur.trim());
      cur = "";
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();
const norm = (s: string): string => collapse(s).toLowerCase();
const md5 = (s: string): string => createHash("md5").update(s, "utf8").digest("hex");

/** Identifier-like words of the text, lower case. */
function wordsOf(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of text.toLowerCase()) {
    if ((ch >= "a" && ch <= "z") || ch === "_" || (ch >= "0" && ch <= "9")) {
      cur += ch;
    } else if (cur) {
      out.push(cur);
      cur = "";
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** The text between the `$fn$` markers of the named function's definition (what pg_proc.prosrc holds). */
function prosrc(sql: string, fn: string): string {
  const at = sql.lastIndexOf(`create or replace function public.${fn}(`);
  expect(at, `create line of ${fn}`).toBeGreaterThanOrEqual(0);
  const open = sql.indexOf("as $fn$", at);
  expect(open, `$fn$ opening of ${fn}`).toBeGreaterThan(at);
  const bodyStart = open + "as $fn$".length;
  const close = sql.indexOf("$fn$", bodyStart);
  expect(close, `$fn$ closing of ${fn}`).toBeGreaterThan(bodyStart);
  return sql.slice(bodyStart, close);
}

/** Everything before `as $fn$` of the named function: signature, return shape, attributes. */
function header(sql: string, fn: string): string {
  const at = sql.lastIndexOf(`create or replace function public.${fn}(`);
  expect(at, `create line of ${fn}`).toBeGreaterThanOrEqual(0);
  return sql.slice(at, sql.indexOf("as $fn$", at));
}

/** `select <list> from ...` -> normalised select list. */
function selectList(body: string): string {
  const m = norm(body).match(/^select (.*?) from /);
  if (!m || m[1] === undefined) throw new Error("no select list");
  return m[1];
}

/** Normalised text from `from` on: from / where / order / limit. */
function tail(body: string): string {
  const n = norm(body);
  const idx = n.indexOf(" from ");
  if (idx === -1) throw new Error("no from clause");
  return n.slice(idx + 1);
}

/** The raw text from the ops_health_report() create line through its grant statement. */
function opsSection(raw: string): string {
  const at = raw.lastIndexOf(OPS_CREATE);
  expect(at, "ops_health_report create line").toBeGreaterThanOrEqual(0);
  const grantAt = raw.indexOf(OPS_GRANT, at);
  expect(grantAt, "ops_health_report grant").toBeGreaterThan(at);
  return raw.slice(at, grantAt + OPS_GRANT.length);
}

/** Quoted entries of the first `array[...]` after `from`, in order. */
function quotedEntriesAfter(text: string, from: number): string[] {
  const open = text.indexOf("array[", from);
  expect(open, "array[ after the identity expression").toBeGreaterThanOrEqual(0);
  // the entries end in `[])'`, so the array closes at the first `'])`
  const close = text.indexOf("'])", open) + 1;
  expect(close, "end of the array").toBeGreaterThan(open);
  return [...text.slice(open + "array[".length, close).matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
}

describe("migration 158_saved_clusters_v3.sql (SQL contract)", () => {
  let raw = "";
  let code = "";
  let statements: string[] = [];
  let raw138 = "";
  let raw157 = "";

  beforeAll(() => {
    expect(existsSync(MIGRATION_158), "158_saved_clusters_v3.sql must exist").toBe(true);
    raw = readFileSync(MIGRATION_158, "utf8");
    code = stripComments(raw);
    statements = splitStatements(code);
    raw138 = readFileSync(MIGRATION_138, "utf8");
    raw157 = readFileSync(MIGRATION_157, "utf8");
  });

  it("sanity: comment stripping is non-vacuous (the header says DEPLOY, the code does not)", () => {
    expect(raw).toMatch(/DEPLOY/);
    expect(code).not.toMatch(/DEPLOY/);
  });

  it("is one transaction with a bounded lock wait, the ledger row in the 095 pattern, and a schema-cache reload", () => {
    expect(statements[0]).toBe("begin");
    expect(statements[1]).toBe("set local lock_timeout = '5s'");
    expect(statements[statements.length - 1]).toBe("commit");
    expect(collapse(statements[statements.length - 2] as string)).toBe(
      "insert into supabase_migrations.schema_migrations (version, name) values ('158', '158_saved_clusters_v3') on conflict do nothing",
    );
    expect(statements).toContain("notify pgrst, 'reload schema'");
    expect(statements.indexOf("notify pgrst, 'reload schema'")).toBeLessThan(statements.length - 2);
  });

  it("runs exactly these statements, in this order", () => {
    const shape = statements.map((s) => collapse(s).split(" ").slice(0, 2).join(" "));
    expect(shape).toEqual([
      "begin",
      "set local",
      "create or", // saved_clusters_v3
      "comment on", // saved_clusters_v3
      "revoke all", // saved_clusters_v3
      "grant execute", // saved_clusters_v3
      "create or", // ops_health_report
      "comment on", // ops_health_report
      "revoke all", // ops_health_report
      "grant execute", // ops_health_report
      "notify pgrst,",
      "insert into",
      "commit",
    ]);
    const creates = statements.filter((s) => s.startsWith("create or replace function"));
    expect(creates.map((s) => /function (public\.[a-z_0-9]+)\(/.exec(s)?.[1])).toEqual([
      "public.saved_clusters_v3",
      "public.ops_health_report",
    ]);
  });

  it("is additive: nothing dropped, altered, truncated or written, no table, policy, view, index or trigger, no table or sequence grant", () => {
    const outside = statements.filter((s) => !s.startsWith(OPS_CREATE));
    const words = wordsOf(blankStrings(outside.join(";\n")));
    for (const forbidden of ["drop", "alter", "truncate", "update", "delete", "policy", "view", "index", "trigger", "default", "privileges", "concurrently", "table", "sequence", "schema"]) {
      // `table` appears in `returns table`; `schema` in schema_migrations / pgrst's 'reload schema' (a string, blanked)
      if (forbidden === "table" || forbidden === "schema") continue;
      expect(words, forbidden).not.toContain(forbidden);
    }
    expect(outside.filter((s) => s.startsWith("insert"))).toHaveLength(1);
    // the ops function itself only reads
    const ops = statements.find((s) => s.startsWith(OPS_CREATE)) as string;
    const opsWords = wordsOf(blankStrings(ops));
    for (const forbidden of ["drop", "alter", "truncate", "delete", "grant", "revoke", "vacuum", "analyze"]) {
      expect(opsWords, forbidden).not.toContain(forbidden);
    }
  });

  it("grants exactly 124/138's shape on v3 (revoke from public, anon, authenticated; execute to anon and service_role, never authenticated) and 157's on the report", () => {
    const revokes = statements.filter((s) => s.startsWith("revoke")).map(collapse);
    const grants = statements.filter((s) => s.startsWith("grant")).map(collapse);
    expect(revokes).toEqual([V3_REVOKE.slice(0, -1), OPS_REVOKE.slice(0, -1)]);
    expect(grants).toEqual([V3_GRANT.slice(0, -1), OPS_GRANT.slice(0, -1)]);
    expect(grants.join(" ")).not.toMatch(/authenticated/i);
    // the v3 statements are the v2 statements of 138 with the name changed
    const v2Revoke = "revoke all on function public.saved_clusters_v2(uuid[]) from public, anon, authenticated;";
    const v2Grant = "grant execute on function public.saved_clusters_v2(uuid[]) to anon, service_role;";
    expect(raw138).toContain(v2Revoke);
    expect(raw138).toContain(v2Grant);
    expect(V3_REVOKE).toBe(v2Revoke.replace("saved_clusters_v2", "saved_clusters_v3"));
    expect(V3_GRANT).toBe(v2Grant.replace("saved_clusters_v2", "saved_clusters_v3"));
    // and the report's two statements are the ones 157 ends with
    expect(raw157).toContain(OPS_REVOKE);
    expect(raw157).toContain(OPS_GRANT);
  });

  it("never touches saved_clusters_v2 or saved_clusters (v1): no create, drop, alter, comment, revoke or grant on them", () => {
    // string literals are blanked: the ops allowlist array and the comment texts name v2 and v1 as text
    for (const s of statements) {
      const executable = blankStrings(s);
      expect(executable, s.slice(0, 80)).not.toMatch(/saved_clusters_v2/);
      expect(executable, s.slice(0, 80)).not.toMatch(/saved_clusters\s*\(/);
    }
    expect(code).not.toMatch(/\bdrop\b/i);
  });

  // ---- v3 = the latest v2 plus first_published ------------------------------------------------

  it("the latest migration that defines saved_clusters_v2 is 138 (the file the header and this test compare against)", () => {
    const defining = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{3}_.+\.sql$/.test(f))
      .filter((f) => stripComments(readFileSync(resolve(MIGRATIONS_DIR, f), "utf8")).includes("function public.saved_clusters_v2("))
      .map((f) => parseInt(f, 10))
      .sort((a, b) => a - b);
    expect(defining).toEqual([124, 138]);
  });

  it("the body of 138's saved_clusters_v2 is the production body: md5 and length recorded in the header", () => {
    const body = prosrc(raw138, "saved_clusters_v2");
    expect(body.length).toBe(PROD_V2_LENGTH);
    expect(md5(body)).toBe(PROD_V2_MD5);
    // the header records what production reported, so the comparison can be re-read
    expect(raw).toContain(PROD_V2_MD5);
    expect(raw).toContain(`length ${PROD_V2_LENGTH}`);
    expect(raw).toContain(PROD_V2_ACL);
    expect(raw).toContain("select md5(prosrc)");
  });

  it("keeps v2's header: p_ids uuid[], language sql, stable, security definer, set search_path = '' (the production attributes)", () => {
    const v2 = header(raw138, "saved_clusters_v2");
    const v3 = header(code, "saved_clusters_v3");
    expect(v3).toMatch(/function\s+public\.saved_clusters_v3\s*\(\s*p_ids\s+uuid\[\]\s*\)/i);
    expect(v3).toMatch(/\blanguage\s+sql\b/i);
    expect(v3).toMatch(/\bstable\b/i);
    expect(v3).not.toMatch(/\b(volatile|immutable|strict|leakproof|parallel|rows|cost)\b/i);
    expect(v3).toMatch(/\bsecurity\s+definer\b/i);
    expect(v3).toMatch(/\bset\s+search_path\s*=\s*''/i);
    // everything but the name and the extra return column is v2's header
    expect(norm(v3)).toBe(
      norm(v2)
        .replace("saved_clusters_v2", "saved_clusters_v3")
        .replace("is_blindspot boolean )", "is_blindspot boolean, first_published timestamptz )"),
    );
  });

  it("returns v2's 7 columns in order, then exactly one more: first_published timestamptz", () => {
    const h = norm(header(code, "saved_clusters_v3"));
    expect(h).toContain(
      "returns table ( id uuid, title_tr text, title_tr_neutral text, article_count integer, bias_distribution jsonb, updated_at timestamptz, is_blindspot boolean, first_published timestamptz )",
    );
    const cols = /returns\s+table\s*\(([\s\S]*?)\)\s*language/i.exec(header(code, "saved_clusters_v3"))?.[1] ?? "";
    expect(cols.split(",").map((c) => c.trim().split(/\s+/)[0])).toEqual([
      "id",
      "title_tr",
      "title_tr_neutral",
      "article_count",
      "bias_distribution",
      "updated_at",
      "is_blindspot",
      "first_published",
    ]);
  });

  it("selects v2's list (the veto expression included) plus c.first_published, last", () => {
    const v2 = selectList(prosrc(raw138, "saved_clusters_v2"));
    const v3 = selectList(prosrc(code, "saved_clusters_v3"));
    expect(v3).toBe(`${v2}, c.first_published`);
    expect(v2.endsWith("(c.is_blindspot and not coalesce(c.blindspot_recall_veto, false)) as is_blindspot")).toBe(true);
  });

  it("keeps v2's from / where / order / limit (200-id truncation, newest update first, 200 rows, no archived filter)", () => {
    const v2 = prosrc(raw138, "saved_clusters_v2");
    const v3 = prosrc(code, "saved_clusters_v3");
    expect(tail(v3)).toBe(tail(v2));
    expect(tail(v3)).toContain("limit 200");
    expect(v3).toMatch(/coalesce\s*\(\s*p_ids\[1:200\]\s*,\s*'\{\}'::uuid\[\]\s*\)/i);
    expect(v3).toMatch(/order\s+by\s+c\.updated_at\s+desc/i);
    expect(v3).toMatch(/from\s+public\.clusters\s+c\b/i);
    expect(v3).not.toMatch(/is_archived/i);
    expect(v3).not.toMatch(/\braise\b/i);
  });

  it("the whole body is v2's with the one column spliced in (no other difference)", () => {
    const v2 = norm(prosrc(raw138, "saved_clusters_v2"));
    const v3 = norm(prosrc(code, "saved_clusters_v3"));
    expect(v3).toBe(v2.replace(" as is_blindspot from ", " as is_blindspot, c.first_published from "));
    expect(v3).not.toBe(v2);
  });

  it("reads only schema-qualified relations (search_path is empty) and adds no blindspot_side, merged_into or feed-health gate", () => {
    const body = prosrc(code, "saved_clusters_v3");
    const rels = Array.from(body.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_.]*)/gi), (m) => m[1]);
    expect(rels).toEqual(["public.clusters"]);
    expect(body).not.toMatch(/blindspot_side|merged_into|summary_tr|blindspot_veto_reason/i);
    expect(body.match(/blindspot_recall_veto/gi)).toHaveLength(1);
    expect(body.match(/first_published/gi)).toHaveLength(1);
  });

  it("comments on v3: the same lookup as v2 plus first_published, the client's wait, v2 and v1 kept", () => {
    const stmt = statements.find((s) => s.startsWith("comment on function public.saved_clusters_v3")) as string;
    expect(stmt).toBeDefined();
    expect(stmt).toMatch(/^comment on function public\.saved_clusters_v3\s*\(\s*uuid\[\]\s*\)\s+is\s+'/);
    expect(stmt).toMatch(/first_published/);
    expect(stmt).toMatch(/publicBlindspotClaim/);
    expect(stmt).toMatch(/saved_clusters_v2/);
    expect(stmt).toMatch(/bookmark-snapshots\.ts/);
  });

  // ---- ops_health_report(): 157's text, six spots ----------------------------------------------

  it("re-creates ops_health_report() as 157's text from the create line through the grant, with exactly the documented spots changed", () => {
    const from157 = opsSection(raw157);
    let expected = from157;
    for (const [from, to] of SWAPS_157_TO_158) {
      expect(from157.split(from).length - 1, `157 has ${JSON.stringify(from)} exactly once`).toBe(1);
      expected = expected.replace(from, to);
    }
    expect(expected).not.toBe(from157);
    const actual = opsSection(raw);
    expect(actual.length).toBe(expected.length);
    expect(actual).toBe(expected);
    expect(from157.length).toBeGreaterThan(40000);
  });

  it("row 17's identity array lists exactly the six ALLOWED_RPC_IDENTITIES (tests/_helpers/anon-rpc-allowlist.ts), in order, by full identity", () => {
    const section = opsSection(raw);
    const expr = "p.proname::text || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' <> all (";
    const at = section.indexOf(expr);
    expect(at, "the exclusion compares name + argument types").toBeGreaterThan(0);
    expect(section.indexOf(expr, at + 1)).toBe(-1);
    expect(quotedEntriesAfter(section, at)).toEqual([...ALLOWED_RPC_IDENTITIES]);
    expect(ALLOWED_RPC_IDENTITIES).toHaveLength(6);
    expect(ALLOWED_RPC_IDENTITIES).toContain("saved_clusters_v3(uuid[])");
    expect(section).not.toContain("p.proname <> all");
    // the count in the detail is the size of the allowlist
    expect(section).toContain(`' (${ALLOWED_RPCS.length} izinli RPC hariç)'`);
    expect(section).not.toContain("(5 izinli RPC hariç)");
  });

  it("the function comment names all six allowlisted RPCs and lists migration 158 after 157, still 20 fixed rows", () => {
    const section = opsSection(raw);
    const at = section.indexOf("comment on function public.ops_health_report() is");
    expect(at).toBeGreaterThan(0);
    const comment = section.slice(at);
    expect(comment).toContain("(migrations 077, 100, 103, 108, 114, 115, 119, 122, 136, 145, 150, 157, 158): 20 fixed rows");
    for (const name of ALLOWED_RPCS) expect(comment, name).toContain(name);
    expect(comment).toContain(
      "other than the six'\n  ' allowlisted RPCs saved_clusters, merged_cluster_map, source_slugs, source_slug_exists,'\n  ' saved_clusters_v2 and saved_clusters_v3, each exempt by its full signature",
    );
    expect(comment).toContain("service_role only");
    expect(comment).toContain("docs/ops-heartbeat.md");
  });

  it("the report still has 157's 20 literal checks in 157's order", () => {
    const names = (sql: string): string[] =>
      [...stripComments(opsSection(sql)).matchAll(/check_name\s*:=\s*'([a-z0-9_]+)'\s*;/gi)].map((m) => m[1] as string);
    expect(names(raw)).toEqual(names(raw157));
    expect(names(raw).length).toBeGreaterThanOrEqual(17);
    expect(names(raw)).toContain("anon_surface");
    expect(names(raw)[names(raw).length - 1]).toBe("feed_poll_stale");
  });

  // ---- header and docs -------------------------------------------------------------------------

  it("header documents why, the evidence, Step 0 (prod fingerprint), what changes, the ops row, deploy order, verify and rollback", () => {
    expect(raw).toMatch(/^-- 158_saved_clusters_v3\.sql/);
    for (const needle of [
      "h38-saved-1",
      "#199",
      "h37-content-1",
      "publicBlindspotClaim",
      "BLINDSPOT.feedDelayHours",
      "first_published",
      "STEP 0",
      "138_saved_clusters_veto.sql",
      "proacl",
      "ops_health_report",
      "anon_surface",
      "tests/guards/anon-surface.test.ts",
      "DEPLOY: APPLY 158 BEFORE THE VERCEL DEPLOY",
      "PGRST202",
      "42883",
      "VERIFY",
      "ROLLBACK",
      "drop function public.saved_clusters_v3(uuid[])",
      "delete from supabase_migrations.schema_migrations where version = '158'",
      "DRY RUN",
      "DRYRUN 158 OK",
    ]) {
      expect(raw, needle).toContain(needle);
    }
  });

  it("the rollback of the header re-runs 157's report section and drops v3 only", () => {
    const at = raw.indexOf("ROLLBACK");
    expect(at).toBeGreaterThan(0);
    const rollback = raw.slice(at);
    expect(rollback).toContain("157_ingest_poll_stale.sql");
    expect(rollback).toContain("drop function public.saved_clusters_v3(uuid[])");
    expect(rollback).not.toMatch(/drop function public\.saved_clusters_v2/);
  });

  it("docs/migration-guide.md has a '## 158' section: why, what, order (apply 158 before the Vercel deploy), verify and rollback", () => {
    const guide = readFileSync(DOC_MIGRATION_GUIDE, "utf8");
    const at = guide.indexOf("\n## 158");
    expect(at, "## 158 heading").toBeGreaterThan(0);
    const next = guide.indexOf("\n## ", at + 1);
    const section = guide.slice(at, next < 0 ? undefined : next);
    expect(section).toMatch(/^\n## 158 — .*saved_clusters_v3/);
    for (const needle of ["**Why:**", "**What 158 does**", "**Order:**", "**Verify", "**Rollback", "first_published", "ops_health_report", "anon_surface", "PGRST202"]) {
      expect(section, needle).toContain(needle);
    }
    expect(section.toLowerCase()).toContain("apply 158 before the vercel deploy");
    expect(section).toContain("drop function public.saved_clusters_v3(uuid[])");
    expect(section).toContain(PROD_V2_MD5);
  });

  it("ships a local PG15 dry run that applies the chain, 158 twice, and ends with DRYRUN 158 OK", () => {
    expect(existsSync(DRYRUN), "158 dry-run sql must exist").toBe(true);
    const dry = readFileSync(DRYRUN, "utf8");
    expect(dry).toMatch(/124_saved_clusters_v2\.sql/);
    expect(dry).toMatch(/138_saved_clusters_veto\.sql/);
    expect(dry).toMatch(/157_ingest_poll_stale\.sql/);
    expect(dry.match(/158_saved_clusters_v3\.sql/g)!.length).toBeGreaterThanOrEqual(2);
    expect(dry).toMatch(/has_function_privilege/);
    expect(dry).toMatch(/set role anon/i);
    expect(dry).toMatch(/DRYRUN 158 OK/);
  });

  it("the live manifest builds this test's database (dry run as setup, zero allowed skips)", () => {
    const lines = readFileSync(MANIFEST, "utf8").split("\n");
    const entry = lines.find((l) => l.startsWith("run | 158-saved-clusters-v3.test.ts"));
    expect(entry, "run | 158-saved-clusters-v3.test.ts entry").toBeDefined();
    expect(entry).toContain("tests/migrations/sql/158-saved-clusters-v3-dryrun.sql");
    expect((entry as string).trim().endsWith("| 0")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Live block (opt-in): needs the database tests/migrations/sql/live-manifest.txt builds for this
// file (the chain up to 157, 124 and 138, then 158 applied twice by the dry-run script); TAYF_PSQL
// is the psql binary and PGHOST/PGPORT/PGUSER/PGDATABASE select the server. Every scenario that
// writes sits inside one transaction that is rolled back.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))("migration 158: public.saved_clusters_v3() and ops_health_report() (live Postgres)", () => {
  assertLiveReady("158", {
    ledger: ["124", "138", "158"],
    functions: ["public.saved_clusters_v2(uuid[])", "public.saved_clusters_v3(uuid[])", "public.ops_health_report()"],
  });

  function runPsql(input: string): string {
    return execFileSync(process.env.TAYF_PSQL as string, ["-X", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      input,
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8" },
      maxBuffer: 8 * 1024 * 1024,
    });
  }
  const lines = (out: string, tag: string): string[] =>
    out.split("\n").filter((l) => l.startsWith(`${tag}|`)).map((l) => l.slice(tag.length + 1));

  // Absolute timestamps and a fixed clock, so the SQL rows and the TS rule see the same ages.
  const NOW = Date.parse("2026-11-05T12:00:00.000Z");
  const FIXTURES: ReadonlyArray<{ id: string; flagged: boolean; veto: boolean; firstPublished: string | null }> = [
    { id: "00000000-0000-4000-8000-000000001581", flagged: true, veto: false, firstPublished: "2026-11-05T11:00:00Z" }, // 1 h old
    { id: "00000000-0000-4000-8000-000000001582", flagged: true, veto: false, firstPublished: "2026-11-04T11:00:00Z" }, // 25 h old
    { id: "00000000-0000-4000-8000-000000001583", flagged: true, veto: true, firstPublished: "2026-11-03T12:00:00Z" }, // vetoed
    { id: "00000000-0000-4000-8000-000000001584", flagged: false, veto: false, firstPublished: "2026-11-05T10:00:00Z" },
    { id: "00000000-0000-4000-8000-000000001585", flagged: true, veto: false, firstPublished: null },
  ];
  const idArray = `array[${FIXTURES.map((f) => `'${f.id}'`).join(", ")}]::uuid[]`;
  const insertFixtures = `
insert into public.clusters
  (id, title_tr, title_tr_neutral, article_count, bias_distribution, is_blindspot, blindspot_side,
   blindspot_recall_veto, first_published, updated_at)
values
  ${FIXTURES.map(
    (f, i) =>
      `('${f.id}', 'fixture ${i + 1}', 'fixture ${i + 1}', 6, '{"gov_leaning": 5, "pro_government": 1}'::jsonb, ${f.flagged}, ${
        f.flagged ? "'pro_government'" : "null"
      }, ${f.veto}, ${f.firstPublished === null ? "null" : `'${f.firstPublished}'::timestamptz`}, now() - interval '${i + 1} minutes')`,
  ).join(",\n  ")};`;

  it("returns v2's seven columns unchanged plus first_published, for every fixture (the veto still applies)", () => {
    const out = runPsql(`
begin;
${insertFixtures}
select 'ROW|' || v3.id || '|' || (to_jsonb(v3) - 'first_published' = to_jsonb(v2))::text
       || '|' || v3.is_blindspot::text
       || '|' || coalesce(to_char(v3.first_published at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '')
  from public.saved_clusters_v3(${idArray}) v3
  join public.saved_clusters_v2(${idArray}) v2 using (id)
 order by v3.id;
rollback;
`);
    const rows = lines(out, "ROW").map((l) => l.split("|"));
    expect(rows).toHaveLength(FIXTURES.length);
    for (const f of FIXTURES) {
      const row = rows.find((r) => r[0] === f.id);
      expect(row, f.id).toBeDefined();
      expect(row![1], `${f.id}: v3 minus first_published equals the v2 row`).toBe("true");
      expect(row![2], `${f.id}: is_blindspot is the veto rule (flag and not veto)`).toBe(String(f.flagged && !f.veto));
      expect(row![3], `${f.id}: first_published is the clusters column`).toBe(f.firstPublished ?? "");
    }
  });

  it("with publicBlindspotClaim: the 1 h flagged row shows no pill, the 25 h one does, the vetoed one never, an unknown first_published keeps v2's behaviour", () => {
    const out = runPsql(`
begin;
${insertFixtures}
select 'ROW|' || id || '|' || is_blindspot::text || '|' || coalesce(to_char(first_published at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '')
  from public.saved_clusters_v3(${idArray});
rollback;
`);
    const shown = new Map<string, boolean>();
    for (const l of lines(out, "ROW")) {
      const [id, flag, firstPublished] = l.split("|") as [string, string, string];
      shown.set(
        id,
        publicBlindspotClaim(
          { is_blindspot: flag === "true", blindspot_side: null, first_published: firstPublished === "" ? null : firstPublished },
          NOW,
        ).isBlindspot,
      );
    }
    expect(Object.fromEntries(shown)).toEqual({
      "00000000-0000-4000-8000-000000001581": false, // 1 h old: waits
      "00000000-0000-4000-8000-000000001582": true, // 25 h old: shown
      "00000000-0000-4000-8000-000000001583": false, // vetoed
      "00000000-0000-4000-8000-000000001584": false, // not flagged
      "00000000-0000-4000-8000-000000001585": true, // no first_published: today's behaviour
    });
  });

  it("is callable by anon (the browser role), and keeps the 200-id truncation and the null / empty input behaviour", () => {
    const out = runPsql(`
begin;
${insertFixtures}
set local role anon;
select 'ANON|' || count(*) from public.saved_clusters_v3(${idArray});
select 'NULLIN|' || count(*) from public.saved_clusters_v3(null);
select 'EMPTYIN|' || count(*) from public.saved_clusters_v3('{}'::uuid[]);
select 'TRUNC201|' || count(*) from public.saved_clusters_v3(array(select gen_random_uuid() from generate_series(1, 200)) || '${FIXTURES[1]!.id}'::uuid);
select 'TRUNC1|' || count(*) from public.saved_clusters_v3('${FIXTURES[1]!.id}'::uuid || array(select gen_random_uuid() from generate_series(1, 199)));
reset role;
rollback;
`);
    expect(lines(out, "ANON")).toEqual([String(FIXTURES.length)]);
    expect(lines(out, "NULLIN")).toEqual(["0"]);
    expect(lines(out, "EMPTYIN")).toEqual(["0"]);
    expect(lines(out, "TRUNC201")).toEqual(["0"]);
    expect(lines(out, "TRUNC1")).toEqual(["1"]);
  });

  it("has v2's privileges and attributes: anon and service_role execute, authenticated not, owner-only table access, the production ACL shape", () => {
    const out = runPsql(`
select 'PRIV|' || has_function_privilege('anon', 'public.saved_clusters_v3(uuid[])', 'execute')
       || '|' || has_function_privilege('authenticated', 'public.saved_clusters_v3(uuid[])', 'execute')
       || '|' || has_function_privilege('service_role', 'public.saved_clusters_v3(uuid[])', 'execute')
       || '|' || has_table_privilege('anon', 'public.clusters', 'select')
       || '|' || has_table_privilege('authenticated', 'public.clusters', 'select');
select 'ACL|' || (select string_agg(a::text, ',' order by a::text) from unnest(proacl) a)
  from pg_proc where oid = 'public.saved_clusters_v3(uuid[])'::regprocedure;
select 'V2ACL|' || (select string_agg(a::text, ',' order by a::text) from unnest(proacl) a)
  from pg_proc where oid = 'public.saved_clusters_v2(uuid[])'::regprocedure;
select 'GRANTEES|' || string_agg(g, ',' order by g) || '|' || current_user
  from (select distinct case when a.grantee = 0 then 'public' else a.grantee::regrole::text end as g
          from pg_proc p, aclexplode(p.proacl) a
         where p.oid = 'public.saved_clusters_v3(uuid[])'::regprocedure) s;
select 'ATTR|' || provolatile::text || '|' || prosecdef || '|' || proconfig::text || '|' || prorows || '|' || procost
       || '|' || (select lanname from pg_language where oid = prolang) || '|' || proleakproof || '|' || proparallel::text
  from pg_proc where oid = 'public.saved_clusters_v3(uuid[])'::regprocedure;
select 'V2ATTR|' || provolatile::text || '|' || prosecdef || '|' || proconfig::text || '|' || prorows || '|' || procost
       || '|' || (select lanname from pg_language where oid = prolang) || '|' || proleakproof || '|' || proparallel::text
  from pg_proc where oid = 'public.saved_clusters_v2(uuid[])'::regprocedure;
select 'RESULT|' || pg_get_function_result('public.saved_clusters_v3(uuid[])'::regprocedure);
select 'V2RESULT|' || pg_get_function_result('public.saved_clusters_v2(uuid[])'::regprocedure);
select 'COUNT|' || count(*) from pg_proc where proname like 'saved_clusters%' and pronamespace = 'public'::regnamespace;
`);
    expect(lines(out, "PRIV")).toEqual(["true|false|true|false|false"]);
    // the grants are v2's, name for name (the ACL entries carry the grantor, not the function)
    expect(lines(out, "ACL")).toEqual(lines(out, "V2ACL"));
    // the production shape: anon, service_role and the owner, nobody else (no PUBLIC, no authenticated)
    const [grantees, owner] = lines(out, "GRANTEES")[0]!.split("|") as [string, string];
    expect(grantees.split(",")).toEqual([...new Set(["anon", owner, "service_role"])].sort());
    // volatility, security definer, search_path, row estimate, cost, language, leakproof, parallel: v2's
    expect(lines(out, "ATTR")).toEqual(lines(out, "V2ATTR"));
    // proconfig::text prints the array element quoted: {"search_path=\"\""} is search_path = ''
    expect(lines(out, "ATTR")[0]).toBe('s|true|{"search_path=\\"\\""}|1000|100|sql|false|u');
    // the return shape is v2's plus first_published, and v2's own shape did not move
    expect(lines(out, "V2RESULT")).toEqual([
      "TABLE(id uuid, title_tr text, title_tr_neutral text, article_count integer, bias_distribution jsonb, updated_at timestamp with time zone, is_blindspot boolean)",
    ]);
    expect(lines(out, "RESULT")).toEqual([lines(out, "V2RESULT")[0]!.replace("is_blindspot boolean)", "is_blindspot boolean, first_published timestamp with time zone)")]);
    // v1 (if present in this database), v2 and v3: no overload came from the create or replace
    expect(Number(lines(out, "COUNT")[0])).toBeLessThanOrEqual(3);
  });

  it("applied twice leaves one ledger row and exactly the definition in the file (md5 of prosrc)", () => {
    const sql = readFileSync(MIGRATION_158, "utf8");
    const out = runPsql(`
select 'LEDGER|' || count(*) || '|' || min(name) from supabase_migrations.schema_migrations where version = '158';
select 'V3MD5|' || md5(prosrc) || '|' || length(prosrc) from pg_proc where oid = 'public.saved_clusters_v3(uuid[])'::regprocedure;
select 'OPSMD5|' || md5(prosrc) || '|' || length(prosrc) from pg_proc where oid = 'public.ops_health_report()'::regprocedure;
`);
    expect(lines(out, "LEDGER")).toEqual(["1|158_saved_clusters_v3"]);
    const v3 = prosrc(sql, "saved_clusters_v3");
    expect(lines(out, "V3MD5")).toEqual([`${md5(v3)}|${v3.length}`]);
    const ops = prosrc(sql, "ops_health_report");
    expect(lines(out, "OPSMD5")).toEqual([`${md5(ops)}|${ops.length}`]);
  });

  it("ops_health_report(): 20 rows, rows 1-19 and 20 as 157 named them, and anon_surface passes with the six allowlisted RPCs", () => {
    const out = runPsql(`
select 'N|' || count(*) from public.ops_health_report();
select 'NAMES|' || string_agg(check_name, ',') from public.ops_health_report();
select 'ANON|' || status || '|' || detail from public.ops_health_report() where check_name = 'anon_surface';
select 'ACL|' || has_function_privilege('anon', 'public.ops_health_report()', 'execute')
       || '|' || has_function_privilege('authenticated', 'public.ops_health_report()', 'execute')
       || '|' || has_function_privilege('service_role', 'public.ops_health_report()', 'execute');
`);
    expect(lines(out, "N")).toEqual(["20"]);
    const names = lines(out, "NAMES")[0]!.split(",");
    expect(names).toHaveLength(20);
    expect(names[16]).toBe("anon_surface");
    expect(names[19]).toBe("feed_poll_stale");
    // the throwaway database has no auth schema, so the tail is `auth.users okunamadı` here and `auth.users 0` on Supabase
    expect(lines(out, "ANON")).toHaveLength(1);
    expect(lines(out, "ANON")[0]).toMatch(
      /^pass\|anon\/authenticated yetkisi yok: tablo\/dizi 0, definer fonksiyon 0, invoker fonksiyon 0 \(6 izinli RPC hariç\) · auth\.users /,
    );
    expect(lines(out, "ACL")).toEqual(["false|false|true"]);
  });

  it("anon_surface still catches a real leak: a new anon-executable definer RPC (v4) or a v3 overload fails the check, by full identity (rolled back)", () => {
    const out = runPsql(`
begin;
create function public.saved_clusters_v4(p_ids uuid[]) returns integer language sql security definer set search_path = '' as $f$ select 1 $f$;
select 'V4|' || status || '|' || observed from public.ops_health_report() where check_name = 'anon_surface';
rollback;
begin;
create function public.saved_clusters_v3(p_ids text[]) returns integer language sql security definer set search_path = '' as $f$ select 1 $f$;
select 'OVERLOAD|' || status || '|' || observed from public.ops_health_report() where check_name = 'anon_surface';
rollback;
select 'AFTER|' || status from public.ops_health_report() where check_name = 'anon_surface';
`);
    expect(lines(out, "V4")).toEqual(["fail|1"]);
    expect(lines(out, "OVERLOAD")).toEqual(["fail|1"]);
    expect(lines(out, "AFTER")).toEqual(["pass"]);
  });

  it("left nothing behind (the fixture transactions were rolled back)", () => {
    const ids = FIXTURES.map((f) => `'${f.id}'`).join(", ");
    const out = runPsql(`select 'LEFT|' || count(*) from public.clusters where id in (${ids});`);
    expect(lines(out, "LEFT")).toEqual(["0"]);
  });
});
