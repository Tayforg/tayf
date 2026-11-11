import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { WIRE_UNIQUE_HASH_RATIO, wireSignalOf } from "@/lib/clusters/wire";
import { ALLOWED_RPCS, ALLOWED_RPC_IDENTITIES } from "../_helpers/anon-rpc-allowlist";
import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Static SQL-contract test (and live parity test) for migration 192 ("saved-clusters-v4"), h112-follows-3.
//
// /saved printed the raw stored clusters.article_count ("6 kaynak" for cluster 1e801e36: 6 outlets, 3 distinct
// content hashes) and its "+N yeni kaynak" badge diffed that raw count, while the cards, the cluster page and
// /api/takip print the wire-collapsed count ("3 kaynak"). 192 adds saved_clusters_v4: v3's text with ONE more
// output column, effective_article_count, the number the cluster page header prints as "N kaynak" (one article
// per source, the earliest; a cluster of three or more such members whose distinct content hashes are at most half
// of them counts those hashes; a NULL hash is its own text; NULL when the cluster has no member rows). v3 stays
// (the deployed app between the migration and the deploy, and the client's fallback while 192 is not applied).
//
// A new anon-executable SECURITY DEFINER function also changes what ops_health_report() row 17 (anon_surface,
// migration 145) counts as exposed: its allowlist is an array of FULL IDENTITIES, so v4 would read as `fail` the
// moment 192 is applied. 192 therefore re-creates ops_health_report() with 173's text verbatim except six spots
// that name the allowlisted RPCs (the identity array gains 'saved_clusters_v4(uuid[])', "six" becomes "seven",
// "(6 izinli RPC hariç)" becomes "(7 ...") and the function comment). Pinned here against 173's raw text; the
// guards that scan every migration (tests/guards/anon-surface.test.ts, ops-health-checks.test.ts,
// tests/migrations/zone-parity.test.ts) and the browser client's allowlist move in the same change.
//
// This file pins: the production fingerprints of what 192 builds on (v3: md5 of the body between the $fn$ markers
// == 158's; the report: == 173's), v4 = v3 + effective_article_count, the rule's constants against
// src/lib/clusters/wire.ts, the grants (exactly v3's shape), v3 untouched, the ops_health_report() diff against
// 173, the allowlist (tests/_helpers/anon-rpc-allowlist.ts), the ledger pattern, the docs and the dry run. The live
// block at the end runs the real objects through psql when TAYF_PSQL is set (tests/migrations/sql/live-manifest.txt
// builds the database) and compares the SQL answer with wireSignalOf on the same fixtures: the parity test.
//
// SQL is scanned by character or by plain substring, never with a nested-quantifier regex (CodeQL).
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const MIGRATION_192 = resolve(MIGRATIONS_DIR, "192_saved_clusters_v4.sql");
const MIGRATION_173 = resolve(MIGRATIONS_DIR, "173_ops_sources_dark_persistent.sql");
const MIGRATION_158 = resolve(MIGRATIONS_DIR, "158_saved_clusters_v3.sql");
const WIRE_TS = resolve(ROOT, "src", "lib", "clusters", "wire.ts");
const DOC_MIGRATION_GUIDE = resolve(ROOT, "docs", "migration-guide.md");
const DRYRUN = resolve(__dirname, "sql", "192-saved-clusters-v4-dryrun.sql");
const MANIFEST = resolve(__dirname, "sql", "live-manifest.txt");

/** What production's saved_clusters_v3 and ops_health_report() were on 2026-11-11 (read-only, pg_proc). */
const PROD_V3_MD5 = "2964f03d7a434b67dc00ddeecf833131";
const PROD_V3_LENGTH = 393;
const PROD_V3_ACL = "{postgres=X/postgres,service_role=X/postgres,anon=X/postgres}";
const PROD_OPS_MD5 = "55fa63d2f5d876feed93eb9f7b263b27";
const PROD_OPS_LENGTH = 52432;

const OPS_CREATE = "create or replace function public.ops_health_report()";
const OPS_GRANT = "grant execute on function public.ops_health_report() to service_role;";
const OPS_REVOKE = "revoke all on function public.ops_health_report() from public, anon, authenticated;";
const V4_REVOKE = "revoke all on function public.saved_clusters_v4(uuid[]) from public, anon, authenticated;";
const V4_GRANT = "grant execute on function public.saved_clusters_v4(uuid[]) to anon, service_role;";

/** 173's section, turned into 192's: each pair is one spot, present exactly once in 173. */
const SWAPS_173_TO_192: ReadonlyArray<readonly [string, string]> = [
  // row 17's own comment
  ["outside the six allowlisted RPCs", "outside the seven allowlisted RPCs"],
  // row 17's identity array: the seventh entry, appended
  ["'saved_clusters_v3(uuid[])'])", "'saved_clusters_v3(uuid[])', 'saved_clusters_v4(uuid[])'])"],
  // row 17's detail text: the size of the allowlist
  ["' (6 izinli RPC hariç)'", "' (7 izinli RPC hariç)'"],
  // the function comment
  ["157, 158, 159, 161, 167, 173): 22 fixed rows", "157, 158, 159, 161, 167, 173, 192): 22 fixed rows"],
  ["other than the six'", "other than the seven'"],
  [
    "saved_clusters_v2 and saved_clusters_v3, each exempt",
    "saved_clusters_v2, saved_clusters_v3 and saved_clusters_v4, each exempt",
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

/** The text between the `$fn$` markers of the last definition of `public.<fn>(` (what pg_proc.prosrc holds). */
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

/** Everything from the create line to `as $fn$` of the last definition: signature, return shape, attributes. */
function header(sql: string, fn: string): string {
  const at = sql.lastIndexOf(`create or replace function public.${fn}(`);
  expect(at, `create line of ${fn}`).toBeGreaterThanOrEqual(0);
  return sql.slice(at, sql.indexOf("as $fn$", at));
}

/** `select <list> from ...` -> normalised select list. */
function selectList(body: string): string {
  const n = norm(body);
  const end = n.indexOf(" from public.clusters c");
  if (!n.startsWith("select ") || end < 0) throw new Error("no select list");
  return n.slice("select ".length, end);
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

describe("migration 192_saved_clusters_v4.sql (SQL contract)", () => {
  let raw = "";
  let code = "";
  let statements: string[] = [];
  let raw158 = "";
  let raw173 = "";
  let v3Body = "";
  let v4Body = "";

  beforeAll(() => {
    expect(existsSync(MIGRATION_192), "192_saved_clusters_v4.sql must exist").toBe(true);
    raw = readFileSync(MIGRATION_192, "utf8");
    code = stripComments(raw);
    statements = splitStatements(code);
    raw158 = readFileSync(MIGRATION_158, "utf8");
    raw173 = readFileSync(MIGRATION_173, "utf8");
    v3Body = prosrc(raw158, "saved_clusters_v3");
    v4Body = prosrc(code, "saved_clusters_v4");
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
      "insert into supabase_migrations.schema_migrations (version, name) values ('192', '192_saved_clusters_v4') on conflict do nothing",
    );
    expect(statements).toContain("notify pgrst, 'reload schema'");
    expect(statements.indexOf("notify pgrst, 'reload schema'")).toBeLessThan(statements.length - 2);
  });

  it("runs exactly these statements, in this order", () => {
    const shape = statements.map((s) => collapse(s).split(" ").slice(0, 2).join(" "));
    expect(shape).toEqual([
      "begin",
      "set local",
      "create or", // saved_clusters_v4
      "comment on", // saved_clusters_v4
      "revoke all", // saved_clusters_v4
      "grant execute", // saved_clusters_v4
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
      "public.saved_clusters_v4",
      "public.ops_health_report",
    ]);
  });

  it("is additive: nothing dropped, altered, truncated or written, no table, policy, view, index or trigger, no table or sequence grant", () => {
    const outside = statements.filter((s) => !s.startsWith(OPS_CREATE));
    const words = wordsOf(blankStrings(outside.join(";\n")));
    for (const forbidden of ["drop", "alter", "truncate", "update", "delete", "policy", "view", "index", "trigger", "default", "privileges", "concurrently", "sequence", "vacuum"]) {
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

  it("grants exactly 124/138/158's shape on v4 (revoke from public, anon, authenticated; execute to anon and service_role, never authenticated) and 173's on the report", () => {
    const revokes = statements.filter((s) => s.startsWith("revoke")).map(collapse);
    const grants = statements.filter((s) => s.startsWith("grant")).map(collapse);
    expect(revokes).toEqual([V4_REVOKE.slice(0, -1), OPS_REVOKE.slice(0, -1)]);
    expect(grants).toEqual([V4_GRANT.slice(0, -1), OPS_GRANT.slice(0, -1)]);
    expect(grants.join(" ")).not.toMatch(/authenticated/i);
    // the v4 statements are the v3 statements of 158 with the name changed
    const v3Revoke = "revoke all on function public.saved_clusters_v3(uuid[]) from public, anon, authenticated;";
    const v3Grant = "grant execute on function public.saved_clusters_v3(uuid[]) to anon, service_role;";
    expect(raw158).toContain(v3Revoke);
    expect(raw158).toContain(v3Grant);
    expect(V4_REVOKE).toBe(v3Revoke.replace("saved_clusters_v3", "saved_clusters_v4"));
    expect(V4_GRANT).toBe(v3Grant.replace("saved_clusters_v3", "saved_clusters_v4"));
    // and the report's two statements are the ones 173 ends with
    expect(raw173).toContain(OPS_REVOKE);
    expect(raw173).toContain(OPS_GRANT);
  });

  it("never touches saved_clusters_v3, v2 or saved_clusters (v1): no create, drop, alter, comment, revoke or grant on them", () => {
    // string literals are blanked: the ops allowlist array and the comment texts name them as text
    for (const s of statements) {
      const executable = blankStrings(s);
      expect(executable, s.slice(0, 80)).not.toMatch(/saved_clusters_v3/);
      expect(executable, s.slice(0, 80)).not.toMatch(/saved_clusters_v2/);
      expect(executable, s.slice(0, 80)).not.toMatch(/saved_clusters\s*\(/);
    }
    expect(code).not.toMatch(/\bdrop\b/i);
  });

  // ---- v4 = the latest v3 plus effective_article_count -----------------------------------------

  it("the latest migration that defines saved_clusters_v3 is 158 (the file the header and this test compare against)", () => {
    const defining = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{3}_.+\.sql$/.test(f))
      .filter((f) => stripComments(readFileSync(resolve(MIGRATIONS_DIR, f), "utf8")).includes("function public.saved_clusters_v3("))
      .map((f) => parseInt(f, 10))
      .sort((a, b) => a - b);
    expect(defining).toEqual([158]);
  });

  it("the body of 158's saved_clusters_v3 is the production body: md5 and length recorded in the header", () => {
    expect(v3Body.length).toBe(PROD_V3_LENGTH);
    expect(md5(v3Body)).toBe(PROD_V3_MD5);
    expect(raw).toContain(PROD_V3_MD5);
    expect(raw).toContain(`length ${PROD_V3_LENGTH}`);
    expect(raw).toContain(PROD_V3_ACL);
    expect(raw).toContain("select md5(prosrc)");
  });

  it("the migration that re-creates ops_health_report() right before 192 is 173, and its body is the production body: md5 and length recorded in the header", () => {
    const withReport = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{3}_.+\.sql$/.test(f))
      .filter((f) => stripComments(readFileSync(resolve(MIGRATIONS_DIR, f), "utf8")).includes(OPS_CREATE))
      .map((f) => parseInt(f, 10))
      .sort((a, b) => a - b);
    expect(withReport).toContain(192);
    expect(withReport[withReport.indexOf(192) - 1]).toBe(173);
    const body173 = prosrc(raw173, "ops_health_report");
    expect(body173.length).toBe(PROD_OPS_LENGTH);
    expect(md5(body173)).toBe(PROD_OPS_MD5);
    expect(raw).toContain(PROD_OPS_MD5);
    expect(raw).toContain(`length ${PROD_OPS_LENGTH}`);
  });

  it("keeps v3's header: p_ids uuid[], language sql, stable, security definer, set search_path = '' (the production attributes)", () => {
    const v3 = header(raw158, "saved_clusters_v3");
    const v4 = header(code, "saved_clusters_v4");
    expect(v4).toMatch(/function\s+public\.saved_clusters_v4\s*\(\s*p_ids\s+uuid\[\]\s*\)/i);
    expect(v4).toMatch(/\blanguage\s+sql\b/i);
    expect(v4).toMatch(/\bstable\b/i);
    expect(v4).not.toMatch(/\b(volatile|immutable|strict|leakproof|parallel|rows|cost)\b/i);
    expect(v4).toMatch(/\bsecurity\s+definer\b/i);
    expect(v4).toMatch(/\bset\s+search_path\s*=\s*''/i);
    // everything but the name and the extra return column is v3's header
    expect(norm(v4)).toBe(
      norm(v3)
        .replace("saved_clusters_v3", "saved_clusters_v4")
        .replace("first_published timestamptz )", "first_published timestamptz, effective_article_count integer )"),
    );
  });

  it("returns v3's 8 columns in order, then exactly one more: effective_article_count integer", () => {
    const h = norm(header(code, "saved_clusters_v4"));
    expect(h).toContain(
      "returns table ( id uuid, title_tr text, title_tr_neutral text, article_count integer, bias_distribution jsonb, updated_at timestamptz, is_blindspot boolean, first_published timestamptz, effective_article_count integer )",
    );
    const cols = /returns\s+table\s*\(([\s\S]*?)\)\s*language/i.exec(header(code, "saved_clusters_v4"))?.[1] ?? "";
    expect(cols.split(",").map((c) => c.trim().split(/\s+/)[0])).toEqual([
      "id",
      "title_tr",
      "title_tr_neutral",
      "article_count",
      "bias_distribution",
      "updated_at",
      "is_blindspot",
      "first_published",
      "effective_article_count",
    ]);
  });

  it("selects v3's list (the veto expression and first_published included) plus e.effective_article_count, last", () => {
    const v3 = selectList(v3Body);
    const v4 = selectList(v4Body);
    expect(v4).toBe(`${v3}, e.effective_article_count`);
    expect(v3.endsWith("(c.is_blindspot and not coalesce(c.blindspot_recall_veto, false)) as is_blindspot, c.first_published")).toBe(true);
  });

  it("keeps v3's where / order / limit (200-id truncation, newest update first, 200 rows, no archived filter) after the join, plus one guard: p_ids must be one-dimensional", () => {
    const n3 = norm(v3Body);
    const n4 = norm(v4Body);
    const v3Tail = n3.slice(n3.indexOf(" where "));
    expect(v3Tail).toBe(" where c.id = any (coalesce(p_ids[1:200], '{}'::uuid[])) order by c.updated_at desc limit 200");
    // h113 database-192-2d-array-bound-bypass: p_ids[1:200] slices only the OUTER dimension, so a 2-D
    // array keeps every inner element and `= any` iterates all of them. The one difference from v3's where.
    expect(n4.slice(n4.lastIndexOf(" where "))).toBe(
      " where c.id = any (coalesce(p_ids[1:200], '{}'::uuid[])) and array_ndims(p_ids) = 1 order by c.updated_at desc limit 200",
    );
    expect(n4.endsWith(v3Tail)).toBe(false);
    expect(n4.endsWith(v3Tail.replace(" order by", " and array_ndims(p_ids) = 1 order by"))).toBe(true);
    expect(v4Body).toMatch(/from\s+public\.clusters\s+c\b/i);
    expect(v4Body).not.toMatch(/is_archived/i);
    expect(v4Body).not.toMatch(/\braise\b/i);
    expect(v4Body.match(/blindspot_recall_veto/gi)).toHaveLength(1);
    expect(v4Body.match(/first_published/gi)).toHaveLength(1);
    expect(v4Body.match(/array_ndims/gi)).toHaveLength(1);
  });

  it("the header and the guide say the guard is the one difference from v3's where, and that v1, v2 and v3 keep the 2-D gap", () => {
    expect(raw).toContain("array_ndims(p_ids) = 1");
    expect(raw).toMatch(/the one difference from v3's where/);
    const guide = readFileSync(DOC_MIGRATION_GUIDE, "utf8");
    const at = guide.indexOf("\n## 192");
    const next = guide.indexOf("\n## ", at + 1);
    const section = guide.slice(at, next < 0 ? undefined : next);
    expect(section).toContain("array_ndims(p_ids) = 1");
    expect(section).toMatch(/saved_clusters v1, v2 and v3 keep the 2-D gap/);
    // the fingerprint of v4 as written in the file is the one in the header and the guide
    const fingerprint = `${md5(v4Body)}`;
    expect(raw, "header md5 of v4").toContain(fingerprint);
    expect(raw, "header length of v4").toContain(`${v4Body.length} characters`);
    expect(section, "guide md5 of v4").toContain(fingerprint);
    expect(section, "guide length of v4").toContain(`\`${fingerprint}\` | ${v4Body.length} |`);
  });

  it("the whole body is v3's with the column spliced in and a per-cluster lateral subquery (no other difference in the select, where, order or limit)", () => {
    const n3 = norm(v3Body);
    const n4 = norm(v4Body);
    const head3 = n3.slice(0, n3.indexOf(" from public.clusters c"));
    expect(n4.startsWith(`${head3}, e.effective_article_count from public.clusters c left join lateral (`)).toBe(true);
    expect(n4).toContain(") e on true where c.id = any");
    expect(n4).not.toBe(n3);
  });

  // ---- the rule: what the cluster page header prints as "N kaynak" ------------------------------

  it("reads only schema-qualified relations of the cluster tree: clusters, cluster_articles, articles (search_path is empty)", () => {
    // `join lateral (` is a keyword pair, not a relation
    const rels = Array.from(v4Body.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_.]*)/gi), (m) => m[1]).filter((r) => r !== "lateral");
    expect(rels).toEqual(["public.clusters", "public.cluster_articles", "public.articles"]);
    expect(v4Body).not.toMatch(/blindspot_side|merged_into|summary_tr|blindspot_veto_reason/i);
  });

  it("dedupes to one article per source, the earliest by published_at (the cluster page's server-side dedupe), before it counts hashes", () => {
    const n = norm(v4Body);
    expect(n).toContain("select distinct on (a.source_id) a.id, a.content_hash from public.cluster_articles ca join public.articles a on a.id = ca.article_id where ca.cluster_id = c.id order by a.source_id, a.published_at, a.id");
    // the hash count runs over the deduped rows, one level up
    expect(n.indexOf("count(distinct")).toBeGreaterThan(n.indexOf("distinct on (a.source_id)") - 200);
    expect(n.indexOf(") m")).toBeGreaterThan(n.indexOf("distinct on (a.source_id)"));
  });

  it("counts a NULL content_hash as its own text, per article, exactly as detectWireRedistribution does", () => {
    const n = norm(v4Body);
    expect(n).toContain("count(distinct coalesce(m.content_hash, '__null__:' || m.id::text)) as texts");
    expect(readFileSync(WIRE_TS, "utf8")).toContain("`__null__:${m.id}`");
  });

  it("applies wire.ts's thresholds: fewer than 3 members never collapse, and distinct hashes / members <= WIRE_UNIQUE_HASH_RATIO do", () => {
    const n = norm(v4Body);
    expect(WIRE_UNIQUE_HASH_RATIO).toBe(0.5);
    expect(readFileSync(WIRE_TS, "utf8")).toContain("members.length < 3");
    expect(n).toContain(`when t.members >= 3 and t.texts::numeric / t.members <= ${WIRE_UNIQUE_HASH_RATIO} then t.texts`);
    expect(n).toContain("else t.members end::integer as effective_article_count");
    // no cluster tree at all: NULL, so the client falls back to the stored article_count instead of printing 0
    expect(n).toContain("when t.members = 0 then null");
  });

  it("comments on v4: the same lookup as v3 plus effective_article_count (what the cluster page prints), v3 / v2 / v1 kept", () => {
    const stmt = statements.find((s) => s.startsWith("comment on function public.saved_clusters_v4")) as string;
    expect(stmt).toBeDefined();
    expect(stmt).toMatch(/^comment on function public\.saved_clusters_v4\s*\(\s*uuid\[\]\s*\)\s+is\s+'/);
    expect(stmt).toMatch(/effective_article_count/);
    expect(stmt).toMatch(/saved_clusters_v3/);
    expect(stmt).toMatch(/saved-list\.tsx/);
    expect(stmt).toMatch(/bookmark-snapshots\.ts/);
    expect(stmt).toMatch(/wire/i);
    // h113: the comment promises the 200-id cap, so it also says a multi-dimensional array reads nothing
    expect(stmt).toMatch(/one-dimensional/);
  });

  // ---- ops_health_report(): 173's text, six spots ----------------------------------------------

  it("re-creates ops_health_report() as 173's text from the create line through the grant, with exactly the documented spots changed", () => {
    const from173 = opsSection(raw173);
    let expected = from173;
    for (const [from, to] of SWAPS_173_TO_192) {
      expect(from173.split(from).length - 1, `173 has ${JSON.stringify(from)} exactly once`).toBe(1);
      expected = expected.replace(from, to);
    }
    expect(expected).not.toBe(from173);
    const actual = opsSection(raw);
    expect(actual.length).toBe(expected.length);
    expect(actual).toBe(expected);
    expect(from173.length).toBeGreaterThan(50000);
  });

  it("row 17's identity array lists exactly the seven ALLOWED_RPC_IDENTITIES (tests/_helpers/anon-rpc-allowlist.ts), in order, by full identity", () => {
    const section = opsSection(raw);
    const expr = "p.proname::text || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' <> all (";
    const at = section.indexOf(expr);
    expect(at, "the exclusion compares name + argument types").toBeGreaterThan(0);
    expect(section.indexOf(expr, at + 1)).toBe(-1);
    expect(quotedEntriesAfter(section, at)).toEqual([...ALLOWED_RPC_IDENTITIES]);
    expect(ALLOWED_RPC_IDENTITIES).toHaveLength(7);
    expect(ALLOWED_RPC_IDENTITIES).toContain("saved_clusters_v4(uuid[])");
    expect(section).not.toContain("p.proname <> all");
    // the count in the detail is the size of the allowlist
    expect(section).toContain(`' (${ALLOWED_RPCS.length} izinli RPC hariç)'`);
    expect(section).not.toContain("(6 izinli RPC hariç)");
  });

  it("the function comment names all seven allowlisted RPCs and lists migration 192 after 173, still 22 fixed rows", () => {
    const section = opsSection(raw);
    const at = section.indexOf("comment on function public.ops_health_report() is");
    expect(at).toBeGreaterThan(0);
    const comment = section.slice(at);
    expect(comment).toContain("(migrations 077, 100, 103, 108, 114, 115, 119, 122, 136, 145, 150, 157, 158, 159, 161, 167, 173, 192): 22 fixed rows");
    for (const name of ALLOWED_RPCS) expect(comment, name).toContain(name);
    expect(comment).toContain(
      "other than the seven'\n  ' allowlisted RPCs saved_clusters, merged_cluster_map, source_slugs, source_slug_exists,'\n  ' saved_clusters_v2, saved_clusters_v3 and saved_clusters_v4, each exempt by its full signature",
    );
    expect(comment).toContain("service_role only");
    expect(comment).toContain("docs/ops-heartbeat.md");
  });

  it("the report still has 173's 22 literal checks in 173's order", () => {
    const names = (sql: string): string[] =>
      [...stripComments(opsSection(sql)).matchAll(/check_name\s*:=\s*'([a-z0-9_]+)'\s*;/gi)].map((m) => m[1] as string);
    expect(names(raw)).toEqual(names(raw173));
    // 19 literal names; the three per-zone freshness rows are built in a loop and are 22 - 19 = 3 more rows
    expect(names(raw).length).toBeGreaterThanOrEqual(19);
    expect(names(raw)).toContain("anon_surface");
    expect(names(raw)[names(raw).length - 1]).toBe("sources_dark_persistent");
  });

  it("net_response_heap_mb and the edge_http_errors_30m reader are untouched (migration 193 owns that function; 192 only copies the report)", () => {
    const section = opsSection(raw);
    expect(section).toContain("'uyarı >= 64 MB, hata > 200 MB; 15 dakikada bir küçültülür (ops_net_response_compact)'");
    expect(section).toContain("where r.created >= pg_catalog.now() - interval '30 minutes'");
  });

  // ---- header and docs -------------------------------------------------------------------------

  it("header documents why, the evidence, Step 0 (prod fingerprints), what changes, the ops row, deploy order, verify and rollback", () => {
    expect(raw).toMatch(/^-- 192_saved_clusters_v4\.sql/);
    for (const needle of [
      "h112-follows-3",
      "1e801e36",
      "effective_article_count",
      "wire",
      "content_hash",
      "STEP 0",
      "158_saved_clusters_v3.sql",
      "173_ops_sources_dark_persistent.sql",
      "proacl",
      "ops_health_report",
      "anon_surface",
      "tests/guards/anon-surface.test.ts",
      "DEPLOY",
      "PGRST202",
      "42883",
      "VERIFY",
      "ROLLBACK",
      "drop function public.saved_clusters_v4(uuid[])",
      "delete from supabase_migrations.schema_migrations where version = '192'",
      "DRY RUN",
      "DRYRUN 192 OK",
      "REPLAY",
    ]) {
      expect(raw, needle).toContain(needle);
    }
  });

  it("the rollback of the header re-runs 173's report section and drops v4 only", () => {
    const at = raw.indexOf("ROLLBACK");
    expect(at).toBeGreaterThan(0);
    const rollback = raw.slice(at);
    expect(rollback).toContain("173_ops_sources_dark_persistent.sql");
    expect(rollback).toContain("drop function public.saved_clusters_v4(uuid[])");
    expect(rollback).not.toMatch(/drop function public\.saved_clusters_v3/);
  });

  it("docs/migration-guide.md has a '## 192' section: why, what, order (apply 192 before the Vercel deploy), verify and rollback", () => {
    const guide = readFileSync(DOC_MIGRATION_GUIDE, "utf8");
    const at = guide.indexOf("\n## 192");
    expect(at, "## 192 heading").toBeGreaterThan(0);
    const next = guide.indexOf("\n## ", at + 1);
    const section = guide.slice(at, next < 0 ? undefined : next);
    expect(section).toMatch(/^\n## 192 — .*saved_clusters_v4/);
    for (const needle of ["**Why:**", "**What 192 does**", "**Order:**", "**Verify", "**Rollback", "effective_article_count", "ops_health_report", "anon_surface", "PGRST202", "1e801e36"]) {
      expect(section, needle).toContain(needle);
    }
    expect(section.toLowerCase()).toContain("apply 192 before the vercel deploy");
    expect(section).toContain("drop function public.saved_clusters_v4(uuid[])");
    expect(section).toContain(PROD_V3_MD5);
    expect(section).toContain(PROD_OPS_MD5);
    // 193 follows 192 in the guide
    expect(guide.indexOf("\n## 193")).toBeGreaterThan(at);
  });

  it("ships a local PG15 dry run that applies the chain, 192 twice, and ends with DRYRUN 192 OK", () => {
    expect(existsSync(DRYRUN), "192 dry-run sql must exist").toBe(true);
    const dry = readFileSync(DRYRUN, "utf8");
    expect(dry).toMatch(/124_saved_clusters_v2\.sql/);
    expect(dry).toMatch(/138_saved_clusters_veto\.sql/);
    expect(dry).toMatch(/158_saved_clusters_v3\.sql/);
    expect(dry).toMatch(/173_ops_sources_dark_persistent\.sql/);
    expect(dry.match(/192_saved_clusters_v4\.sql/g)!.length).toBeGreaterThanOrEqual(2);
    expect(dry).toMatch(/has_function_privilege/);
    expect(dry).toMatch(/set role anon/i);
    expect(dry).toMatch(/DRYRUN 192 OK/);
  });

  it("the live manifest builds this test's database (dry run as setup, zero allowed skips)", () => {
    const lines = readFileSync(MANIFEST, "utf8").split("\n");
    const entry = lines.find((l) => l.startsWith("run | 192-saved-clusters-v4.test.ts"));
    expect(entry, "run | 192-saved-clusters-v4.test.ts entry").toBeDefined();
    expect(entry).toContain("tests/migrations/sql/192-saved-clusters-v4-dryrun.sql");
    expect((entry as string).trim().endsWith("| 0")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Live block (opt-in): needs the database tests/migrations/sql/live-manifest.txt builds for this file
// (the chain up to 173 with 124, 138 and 158 on the way, then 192 applied twice by the dry-run script);
// TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/PGDATABASE select the server. Every scenario that
// writes sits inside one transaction that is rolled back.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))("migration 192: public.saved_clusters_v4() and ops_health_report() (live Postgres)", () => {
  assertLiveReady("192", {
    ledger: ["124", "138", "158", "173", "192"],
    functions: [
      "public.saved_clusters_v3(uuid[])",
      "public.saved_clusters_v4(uuid[])",
      "public.ops_health_report()",
    ],
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

  // -- fixtures: member rows as the cluster page loads them (article id, source id, published_at, content_hash) --

  interface Member {
    id: string;
    source: number;
    /** minutes after the base time: the earliest article of a source is the one the page keeps */
    at: number;
    hash: string | null;
  }
  interface Fixture {
    key: string;
    id: string;
    /** the stored (raw) clusters.article_count */
    stored: number;
    members: Member[];
    /** what the cluster page prints as "N kaynak"; null = no member rows */
    want: number | null;
  }

  const uuid = (kind: number, n: number): string => `00000000-0000-4000-8000-${String(kind * 10000 + n).padStart(12, "0")}`;
  let memberSeq = 0;
  const mk = (source: number, at: number, hash: string | null): Member => ({ id: uuid(2, ++memberSeq), source, at, hash });

  const FIXTURES: Fixture[] = [
    {
      // the production example, cluster 1e801e36: 6 members from 6 sources, 3 distinct content hashes
      key: "wire-6-members-3-hashes",
      id: uuid(1, 1),
      stored: 6,
      members: [mk(1, 1, "A"), mk(2, 2, "A"), mk(3, 3, "B"), mk(4, 4, "B"), mk(5, 5, "C"), mk(6, 6, "C")],
      want: 3,
    },
    { key: "pair-same-hash", id: uuid(1, 2), stored: 2, members: [mk(1, 1, "A"), mk(2, 2, "A")], want: 2 },
    {
      key: "four-distinct-hashes",
      id: uuid(1, 3),
      stored: 4,
      members: [mk(1, 1, "A"), mk(2, 2, "B"), mk(3, 3, "C"), mk(4, 4, "D")],
      want: 4,
    },
    {
      key: "three-members-two-hashes",
      id: uuid(1, 4),
      stored: 3,
      members: [mk(1, 1, "A"), mk(2, 2, "A"), mk(3, 3, "B")],
      want: 3,
    },
    {
      key: "four-members-two-hashes-boundary",
      id: uuid(1, 5),
      stored: 4,
      members: [mk(1, 1, "A"), mk(2, 2, "A"), mk(3, 3, "B"), mk(4, 4, "B")],
      want: 2,
    },
    {
      key: "three-null-hashes",
      id: uuid(1, 6),
      stored: 3,
      members: [mk(1, 1, null), mk(2, 2, null), mk(3, 3, null)],
      want: 3,
    },
    {
      // 5 articles, 3 from one source: the earliest of that source (hash A) is kept, so the page counts 3 members with
      // one hash and prints 1; counting the 5 raw rows (hashes A B C A A) would not collapse and print 5
      key: "duplicate-source-before-hash-count",
      id: uuid(1, 7),
      stored: 5,
      members: [mk(1, 1, "A"), mk(1, 2, "B"), mk(1, 3, "C"), mk(2, 4, "A"), mk(3, 5, "A")],
      want: 1,
    },
    {
      key: "seven-members-four-hashes",
      id: uuid(1, 8),
      stored: 7,
      members: [mk(1, 1, "A"), mk(2, 2, "A"), mk(3, 3, "B"), mk(4, 4, "B"), mk(5, 5, "C"), mk(6, 6, "D"), mk(7, 7, "D")],
      want: 7,
    },
    {
      key: "seven-members-three-hashes",
      id: uuid(1, 9),
      stored: 7,
      members: [mk(1, 1, "A"), mk(2, 2, "A"), mk(3, 3, "A"), mk(4, 4, "B"), mk(5, 5, "B"), mk(6, 6, "C"), mk(7, 7, "C")],
      want: 3,
    },
    { key: "no-member-rows", id: uuid(1, 10), stored: 3, members: [], want: null },
    {
      key: "two-nulls-and-a-pair",
      id: uuid(1, 11),
      stored: 4,
      members: [mk(1, 1, "A"), mk(2, 2, "A"), mk(3, 3, null), mk(4, 4, null)],
      want: 4,
    },
    {
      key: "five-copies-of-one-text",
      id: uuid(1, 12),
      stored: 5,
      members: [mk(1, 1, "A"), mk(2, 2, "A"), mk(3, 3, "A"), mk(4, 4, "A"), mk(5, 5, "A")],
      want: 1,
    },
  ];

  /** What the cluster page does with a fixture's members, then wireSignalOf: the number printed as "N kaynak". */
  function pageCount(f: Fixture): number | null {
    const sorted = [...f.members].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    const seen = new Set<number>();
    const deduped: Member[] = [];
    for (const m of sorted) {
      if (seen.has(m.source)) continue;
      seen.add(m.source);
      deduped.push(m);
    }
    if (deduped.length === 0) return null;
    return wireSignalOf(deduped.map((m) => ({ id: m.id, content_hash: m.hash }))).effectiveArticleCount;
  }

  const sourceIds = [...new Set(FIXTURES.flatMap((f) => f.members.map((m) => m.source)))].sort((a, b) => a - b);
  const idArray = `array[${FIXTURES.map((f) => `'${f.id}'`).join(", ")}]::uuid[]`;
  const insertFixtures = `
insert into public.sources (id, slug, name, bias, kind, active)
values
  ${sourceIds.map((s) => `('${uuid(3, s)}', 'src-${s}', 'Source ${s}', 'center', 'outlet', true)`).join(",\n  ")};
insert into public.clusters
  (id, title_tr, title_tr_neutral, article_count, bias_distribution, is_blindspot, blindspot_side,
   blindspot_recall_veto, first_published, updated_at)
values
  ${FIXTURES.map(
    (f, i) =>
      `('${f.id}', 'fixture ${f.key}', 'fixture ${f.key}', ${f.stored}, '{"center": 3, "gov_leaning": 1}'::jsonb, ${i % 2 === 0}, ${
        i % 2 === 0 ? "'pro_government'" : "null"
      }, ${i % 4 === 0}, '2026-11-05T11:00:00Z'::timestamptz, now() - interval '${i + 1} minutes')`,
  ).join(",\n  ")};
insert into public.articles (id, source_id, title, url, published_at, content_hash)
values
  ${FIXTURES.flatMap((f) =>
    f.members.map(
      (m) =>
        `('${m.id}', '${uuid(3, m.source)}', 'title ${m.id}', 'https://example.test/${m.id}', '2026-11-05T12:00:00Z'::timestamptz + interval '${m.at} minutes', ${
          m.hash === null ? "null" : `'${f.key}:${m.hash}'`
        })`,
    ),
  ).join(",\n  ")};
insert into public.cluster_articles (cluster_id, article_id)
values
  ${FIXTURES.flatMap((f) => f.members.map((m) => `('${f.id}', '${m.id}')`)).join(",\n  ")};`;

  it("fixtures are consistent: the literal expectation of each case equals what wireSignalOf prints for the page's deduped members (6 members, 3 hashes -> 3)", () => {
    for (const f of FIXTURES) expect(pageCount(f), f.key).toBe(f.want);
    const example = FIXTURES.find((f) => f.key === "wire-6-members-3-hashes")!;
    expect(example.members).toHaveLength(6);
    expect(new Set(example.members.map((m) => m.hash)).size).toBe(3);
    expect(example.stored).toBe(6);
    expect(pageCount(example)).toBe(3);
  });

  it("parity: effective_article_count equals the cluster page's count (wireSignalOf over the earliest article per source) for every fixture, and article_count stays the stored raw count", () => {
    const out = runPsql(`
begin;
${insertFixtures}
select 'ROW|' || id || '|' || article_count || '|' || coalesce(effective_article_count::text, 'null')
  from public.saved_clusters_v4(${idArray}) order by id;
rollback;
`);
    const rows = new Map(lines(out, "ROW").map((l) => l.split("|") as [string, string, string]).map(([id, stored, eff]) => [id, { stored, eff }]));
    expect(rows.size).toBe(FIXTURES.length);
    for (const f of FIXTURES) {
      const row = rows.get(f.id);
      expect(row, f.key).toBeDefined();
      expect(row!.stored, `${f.key}: stored article_count`).toBe(String(f.stored));
      expect(row!.eff, `${f.key}: effective_article_count`).toBe(pageCount(f) === null ? "null" : String(pageCount(f)));
      expect(row!.eff, `${f.key}: literal`).toBe(f.want === null ? "null" : String(f.want));
    }
    // the production example: stored 6, effective 3
    expect(rows.get(uuid(1, 1))).toEqual({ stored: "6", eff: "3" });
  });

  it("returns v3's eight columns unchanged plus effective_article_count (the veto still applies), for every fixture", () => {
    const out = runPsql(`
begin;
${insertFixtures}
select 'ROW|' || v4.id || '|' || (to_jsonb(v4) - 'effective_article_count' = to_jsonb(v3))::text
       || '|' || v4.is_blindspot::text
  from public.saved_clusters_v4(${idArray}) v4
  join public.saved_clusters_v3(${idArray}) v3 using (id)
 order by v4.id;
select 'ORDER4|' || string_agg(title_tr, ',' order by ord) from (select title_tr, row_number() over () as ord from public.saved_clusters_v4(${idArray})) s;
select 'ORDER3|' || string_agg(title_tr, ',' order by ord) from (select title_tr, row_number() over () as ord from public.saved_clusters_v3(${idArray})) s;
rollback;
`);
    const rows = lines(out, "ROW").map((l) => l.split("|") as [string, string, string]);
    expect(rows).toHaveLength(FIXTURES.length);
    for (const [id, same, flag] of rows) {
      const i = FIXTURES.findIndex((f) => f.id === id);
      expect(same, `${FIXTURES[i]!.key}: v4 minus effective_article_count equals the v3 row`).toBe("true");
      // flagged on even rows, vetoed on every fourth: the veto rule is v3's
      expect(flag, `${FIXTURES[i]!.key}: is_blindspot`).toBe(String(i % 2 === 0 && i % 4 !== 0));
    }
    // newest update first, the same order as v3
    expect(lines(out, "ORDER4")).toEqual(lines(out, "ORDER3"));
    expect(lines(out, "ORDER4")[0]!.split(",")[0]).toBe("fixture wire-6-members-3-hashes");
  });

  it("is callable by anon (the browser role), keeps the 200-id truncation and the null / empty input behaviour, and reads the member tree as definer", () => {
    const out = runPsql(`
begin;
${insertFixtures}
set local role anon;
select 'ANON|' || count(*) from public.saved_clusters_v4(${idArray});
select 'EXAMPLE|' || article_count || '|' || effective_article_count from public.saved_clusters_v4(array['${uuid(1, 1)}']::uuid[]);
select 'NULLIN|' || count(*) from public.saved_clusters_v4(null);
select 'EMPTYIN|' || count(*) from public.saved_clusters_v4('{}'::uuid[]);
select 'TRUNC201|' || count(*) from public.saved_clusters_v4(array(select gen_random_uuid() from generate_series(1, 200)) || '${uuid(1, 1)}'::uuid);
select 'TRUNC1|' || count(*) from public.saved_clusters_v4('${uuid(1, 1)}'::uuid || array(select gen_random_uuid() from generate_series(1, 199)));
-- h113 database-192-2d-array-bound-bypass: a 2-D array is refused whole (p_ids[1:200] cuts only the outer dimension)
select 'TWOD|' || count(*) from public.saved_clusters_v4(array[['${uuid(1, 1)}'::uuid, gen_random_uuid()], [gen_random_uuid(), gen_random_uuid()]]);
select 'TWOD201|' || count(*) from public.saved_clusters_v4((select ('{' || string_agg('{"' || (case when g = 201 then '${uuid(1, 1)}'::uuid else gen_random_uuid() end) || '","' || gen_random_uuid() || '"}', ',' order by g) || '}')::uuid[] from generate_series(1, 201) g));
select 'TWOD1|' || count(*) from public.saved_clusters_v4((select ('{' || string_agg('{"' || (case when g = 1 then '${uuid(1, 1)}'::uuid else gen_random_uuid() end) || '","' || gen_random_uuid() || '"}', ',' order by g) || '}')::uuid[] from generate_series(1, 201) g));
select 'ONED|' || count(*) from public.saved_clusters_v4(array['${uuid(1, 1)}'::uuid, gen_random_uuid()]);
select 'TABLE|' || has_table_privilege('anon', 'public.cluster_articles', 'select') || '|' || has_table_privilege('anon', 'public.articles', 'select');
reset role;
rollback;
`);
    expect(lines(out, "ANON")).toEqual([String(FIXTURES.length)]);
    expect(lines(out, "EXAMPLE")).toEqual(["6|3"]);
    expect(lines(out, "NULLIN")).toEqual(["0"]);
    expect(lines(out, "EMPTYIN")).toEqual(["0"]);
    expect(lines(out, "TRUNC201")).toEqual(["0"]);
    expect(lines(out, "TRUNC1")).toEqual(["1"]);
    // a 2-D array reads nothing, wherever the fixture sits (the outer position 201, 1, or a 2x2 array), while the 1-D one finds it
    expect(lines(out, "TWOD")).toEqual(["0"]);
    expect(lines(out, "TWOD201")).toEqual(["0"]);
    expect(lines(out, "TWOD1")).toEqual(["0"]);
    expect(lines(out, "ONED")).toEqual(["1"]);
    // anon has no table privilege on the member tables: the function reads them as its owner
    expect(lines(out, "TABLE")).toEqual(["false|false"]);
  });

  it("has v3's privileges and attributes: anon and service_role execute, authenticated not, owner-only table access, the production ACL shape", () => {
    const out = runPsql(`
select 'PRIV|' || has_function_privilege('anon', 'public.saved_clusters_v4(uuid[])', 'execute')
       || '|' || has_function_privilege('authenticated', 'public.saved_clusters_v4(uuid[])', 'execute')
       || '|' || has_function_privilege('service_role', 'public.saved_clusters_v4(uuid[])', 'execute')
       || '|' || has_table_privilege('anon', 'public.clusters', 'select')
       || '|' || has_table_privilege('authenticated', 'public.clusters', 'select');
select 'ACL|' || (select string_agg(a::text, ',' order by a::text) from unnest(proacl) a)
  from pg_proc where oid = 'public.saved_clusters_v4(uuid[])'::regprocedure;
select 'V3ACL|' || (select string_agg(a::text, ',' order by a::text) from unnest(proacl) a)
  from pg_proc where oid = 'public.saved_clusters_v3(uuid[])'::regprocedure;
select 'GRANTEES|' || string_agg(g, ',' order by g) || '|' || current_user
  from (select distinct case when a.grantee = 0 then 'public' else a.grantee::regrole::text end as g
          from pg_proc p, aclexplode(p.proacl) a
         where p.oid = 'public.saved_clusters_v4(uuid[])'::regprocedure) s;
select 'ATTR|' || provolatile::text || '|' || prosecdef || '|' || proconfig::text || '|' || prorows || '|' || procost
       || '|' || (select lanname from pg_language where oid = prolang) || '|' || proleakproof || '|' || proparallel::text
  from pg_proc where oid = 'public.saved_clusters_v4(uuid[])'::regprocedure;
select 'V3ATTR|' || provolatile::text || '|' || prosecdef || '|' || proconfig::text || '|' || prorows || '|' || procost
       || '|' || (select lanname from pg_language where oid = prolang) || '|' || proleakproof || '|' || proparallel::text
  from pg_proc where oid = 'public.saved_clusters_v3(uuid[])'::regprocedure;
select 'RESULT|' || pg_get_function_result('public.saved_clusters_v4(uuid[])'::regprocedure);
select 'V3RESULT|' || pg_get_function_result('public.saved_clusters_v3(uuid[])'::regprocedure);
select 'COUNT|' || count(*) from pg_proc where proname like 'saved_clusters%' and pronamespace = 'public'::regnamespace;
`);
    expect(lines(out, "PRIV")).toEqual(["true|false|true|false|false"]);
    // the grants are v3's, name for name
    expect(lines(out, "ACL")).toEqual(lines(out, "V3ACL"));
    expect(lines(out, "ACL")[0]).toContain("service_role=X/");
    expect(lines(out, "ACL")[0]).toContain("anon=X/");
    // the production shape: anon, service_role and the owner, nobody else (no PUBLIC, no authenticated)
    const [grantees, owner] = lines(out, "GRANTEES")[0]!.split("|") as [string, string];
    expect(grantees.split(",")).toEqual([...new Set(["anon", owner, "service_role"])].sort());
    // volatility, security definer, search_path, row estimate, cost, language, leakproof, parallel: v3's
    expect(lines(out, "ATTR")).toEqual(lines(out, "V3ATTR"));
    // proconfig::text prints the array element quoted: {"search_path=\"\""} is search_path = ''
    expect(lines(out, "ATTR")[0]).toBe('s|true|{"search_path=\\"\\""}|1000|100|sql|false|u');
    // the return shape is v3's plus effective_article_count, and v3's own shape did not move
    expect(lines(out, "V3RESULT")).toEqual([
      "TABLE(id uuid, title_tr text, title_tr_neutral text, article_count integer, bias_distribution jsonb, updated_at timestamp with time zone, is_blindspot boolean, first_published timestamp with time zone)",
    ]);
    expect(lines(out, "RESULT")).toEqual([
      lines(out, "V3RESULT")[0]!.replace("first_published timestamp with time zone)", "first_published timestamp with time zone, effective_article_count integer)"),
    ]);
    // v1 (if present in this database), v2, v3 and v4: no overload came from the create or replace
    expect(Number(lines(out, "COUNT")[0])).toBeLessThanOrEqual(4);
  });

  it("applied twice leaves one ledger row and exactly the definitions in the file (md5 of prosrc)", () => {
    const sql = readFileSync(MIGRATION_192, "utf8");
    const out = runPsql(`
select 'LEDGER|' || count(*) || '|' || min(name) from supabase_migrations.schema_migrations where version = '192';
select 'V4MD5|' || md5(prosrc) || '|' || length(prosrc) from pg_proc where oid = 'public.saved_clusters_v4(uuid[])'::regprocedure;
select 'OPSMD5|' || md5(prosrc) || '|' || length(prosrc) from pg_proc where oid = 'public.ops_health_report()'::regprocedure;
`);
    expect(lines(out, "LEDGER")).toEqual(["1|192_saved_clusters_v4"]);
    const v4 = prosrc(sql, "saved_clusters_v4");
    expect(lines(out, "V4MD5")).toEqual([`${md5(v4)}|${v4.length}`]);
    const ops = prosrc(sql, "ops_health_report");
    expect(lines(out, "OPSMD5")).toEqual([`${md5(ops)}|${ops.length}`]);
  });

  it("ops_health_report(): 22 rows in 173's order, and anon_surface passes with the seven allowlisted RPCs", () => {
    const out = runPsql(`
select 'N|' || count(*) from public.ops_health_report();
select 'NAMES|' || string_agg(check_name, ',') from public.ops_health_report();
select 'ANON|' || status || '|' || detail from public.ops_health_report() where check_name = 'anon_surface';
select 'ACL|' || has_function_privilege('anon', 'public.ops_health_report()', 'execute')
       || '|' || has_function_privilege('authenticated', 'public.ops_health_report()', 'execute')
       || '|' || has_function_privilege('service_role', 'public.ops_health_report()', 'execute');
`);
    expect(lines(out, "N")).toEqual(["22"]);
    const names = lines(out, "NAMES")[0]!.split(",");
    expect(names).toHaveLength(22);
    expect(names[16]).toBe("anon_surface");
    expect(names[21]).toBe("sources_dark_persistent");
    // the throwaway database has no auth schema, so the tail is `auth.users okunamadı` here and `auth.users 0` on Supabase
    expect(lines(out, "ANON")).toHaveLength(1);
    expect(lines(out, "ANON")[0]).toMatch(
      /^pass\|anon\/authenticated yetkisi yok: tablo\/dizi 0, definer fonksiyon 0, invoker fonksiyon 0 \(7 izinli RPC hariç\) · auth\.users /,
    );
    expect(lines(out, "ACL")).toEqual(["false|false|true"]);
  });

  it("anon_surface still catches a real leak: an eighth anon-executable definer RPC (v5) or a v4 overload fails the check, by full identity (rolled back)", () => {
    const out = runPsql(`
begin;
create function public.saved_clusters_v5(p_ids uuid[]) returns integer language sql security definer set search_path = '' as $f$ select 1 $f$;
select 'V5|' || status || '|' || observed from public.ops_health_report() where check_name = 'anon_surface';
rollback;
begin;
create function public.saved_clusters_v4(p_ids text[]) returns integer language sql security definer set search_path = '' as $f$ select 1 $f$;
select 'OVERLOAD|' || status || '|' || observed from public.ops_health_report() where check_name = 'anon_surface';
rollback;
select 'AFTER|' || status from public.ops_health_report() where check_name = 'anon_surface';
`);
    expect(lines(out, "V5")).toEqual(["fail|1"]);
    expect(lines(out, "OVERLOAD")).toEqual(["fail|1"]);
    expect(lines(out, "AFTER")).toEqual(["pass"]);
  });

  it("left nothing behind (the fixture transactions were rolled back)", () => {
    const ids = FIXTURES.map((f) => `'${f.id}'`).join(", ");
    const out = runPsql(`
select 'CLUSTERS|' || count(*) from public.clusters where id in (${ids});
select 'MEMBERS|' || count(*) from public.cluster_articles where cluster_id in (${ids});
select 'SOURCES|' || count(*) from public.sources where slug like 'src-%';
`);
    expect(lines(out, "CLUSTERS")).toEqual(["0"]);
    expect(lines(out, "MEMBERS")).toEqual(["0"]);
    expect(lines(out, "SOURCES")).toEqual(["0"]);
  });
});
