import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Static SQL-contract test (and live test) for migration 195 ("ops-cron-route-low-cadence"), h118-crons-1.
//
// ops_health_report() row 15 (cron_route_failures_30m, migration 136) fails only for a route with at least two
// failures that are at least half of its runs INSIDE 30 minutes. The hourly fact-checks route (vercel.ts, minute :23)
// never has two runs in that window, the weekly digest has one, and a warn never pages (scripts/lib/ops-heartbeat.mjs
// exits 1 only for a fail), so a fact-checks route that answers 500 on every tick never paged, and a fact-checks cron
// that Vercel stopped invoking left the row at pass while headline kept ticking. 195 re-creates the report with 192's
// text VERBATIM (it is production's body: md5 a2252c75..., length 52463) except row 15 and the two places of the function
// comment that describe it:
//   * the silence list gains ('fact-checks', 130, 250): warn after two missed hourly ticks, fail after four;
//   * a low-cadence rule for the routes fact-checks, social and digest: each route's newest TWO rows within the 7 day
//     retention; both at status >= 500 is a failing route (row 15 fails), only the newest at >= 500 is a warn, even when
//     that row is older than 30 minutes; the detail gets `ardışık başarısız: <route> 2/2` (or 1/2), names and counts only;
//   * headline and alerts-webhooks keep the 30 minute rule and their silence gaps exactly.
//
// This file pins: the production fingerprint of what 195 copies, the statement shape (one transaction, function only),
// the grants (192's two statements), the byte-for-byte copy outside row 15, row 15's two rules and the unchanged 30 minute
// CTE and silence CTE, the schedule facts of vercel.ts the gaps rest on, the docs and the dry run. The live block at the
// end runs the real function through psql when TAYF_PSQL is set (tests/migrations/sql/live-manifest.txt builds the
// database): the five scenarios of the spec, the boundaries of the gaps, and a side-by-side run against 192's function on
// the same fixtures (rows other than 15 are always identical; row 15 is identical wherever the new rules do not apply).
//
// SQL is scanned by character or by plain substring, never with a nested-quantifier regex (CodeQL).
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const MIGRATION_195 = resolve(MIGRATIONS_DIR, "195_ops_cron_route_low_cadence.sql");
const MIGRATION_192 = resolve(MIGRATIONS_DIR, "192_saved_clusters_v4.sql");
const DOC_MIGRATION_GUIDE = resolve(ROOT, "docs", "migration-guide.md");
const DOC_OPS_HEARTBEAT = resolve(ROOT, "docs", "ops-heartbeat.md");
const AGENTS = resolve(ROOT, "AGENTS.md");
const VERCEL_TS = resolve(ROOT, "vercel.ts");
const CRON_DIR = resolve(ROOT, "src", "app", "api", "cron");
const DRYRUN = resolve(__dirname, "sql", "195-ops-cron-route-low-cadence-dryrun.sql");
const MANIFEST = resolve(__dirname, "sql", "live-manifest.txt");

/** What production's ops_health_report() was on 2026-11-11 (read-only, pg_proc): 192's body. */
const PROD_OPS_MD5 = "a2252c75458b9d86a0a536b589d97ceb";
const PROD_OPS_LENGTH = 52463;
const PROD_OPS_ACL = "{postgres=X/postgres,service_role=X/postgres}";

const OPS_CREATE = "create or replace function public.ops_health_report()";
const OPS_GRANT = "grant execute on function public.ops_health_report() to service_role;";
const OPS_REVOKE = "revoke all on function public.ops_health_report() from public, anon, authenticated;";

/** Where row 15 starts and ends inside the function text, and where the function comment's description of it does. */
const ROW15_START = "\n  -- 15. cron_route_failures_30m (";
const ROW16_START = "\n  -- 16. db_size_mb";
const COMMENT15_START = "\n  ' cron_route_failures_30m (";
const COMMENT16_START = "\n  ' db_size_mb (";
const COMMENT_LIST_192 = "157, 158, 159, 161, 167, 173, 192): 22 fixed rows";
const COMMENT_LIST_195 = "157, 158, 159, 161, 167, 173, 192, 195): 22 fixed rows";

const LOW_CADENCE_ROUTES = ["fact-checks", "social", "digest"] as const;

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

/** The raw text from the ops_health_report() create line through its grant statement. */
function opsSection(raw: string): string {
  const at = raw.lastIndexOf(OPS_CREATE);
  expect(at, "ops_health_report create line").toBeGreaterThanOrEqual(0);
  const grantAt = raw.indexOf(OPS_GRANT, at);
  expect(grantAt, "ops_health_report grant").toBeGreaterThan(at);
  return raw.slice(at, grantAt + OPS_GRANT.length);
}

/** The raw text from the create line through the `$fn$;` that closes the function (no comment, no grants). */
function opsFunction(raw: string): string {
  const at = raw.lastIndexOf(OPS_CREATE);
  expect(at, "ops_health_report create line").toBeGreaterThanOrEqual(0);
  const open = raw.indexOf("as $fn$", at);
  const close = raw.indexOf("$fn$;", open + "as $fn$".length);
  expect(close, "function end").toBeGreaterThan(open);
  return raw.slice(at, close + "$fn$;".length);
}

/** [start, end) of the text between two markers inside `text`, the end marker excluded. */
function span(text: string, startMarker: string, endMarker: string): { start: number; end: number; text: string } {
  const start = text.indexOf(startMarker);
  expect(start, `marker ${JSON.stringify(startMarker)}`).toBeGreaterThanOrEqual(0);
  expect(text.indexOf(startMarker, start + 1), `marker ${JSON.stringify(startMarker)} is unique`).toBe(-1);
  const end = text.indexOf(endMarker, start + startMarker.length);
  expect(end, `marker ${JSON.stringify(endMarker)}`).toBeGreaterThan(start);
  return { start, end, text: text.slice(start, end) };
}

/** `text` with the span between the markers replaced by `replacement`. */
function replaceSpan(text: string, startMarker: string, endMarker: string, replacement: string): string {
  const s = span(text, startMarker, endMarker);
  return text.slice(0, s.start) + replacement + text.slice(s.end);
}

const row15Of = (section: string): string => span(section, ROW15_START, ROW16_START).text;
const comment15Of = (section: string): string => span(section, COMMENT15_START, COMMENT16_START).text;

/** The check_name literals of a function text, in order. */
function checkNames(sql: string): string[] {
  return [...stripComments(sql).matchAll(/check_name\s*:=\s*'([a-z0-9_]+)'\s*;/gi)].map((m) => m[1] as string);
}

/** The entries of `values ('route'::text, warn::numeric, fail::numeric), ...` of row 15's silence list. */
function silenceList(row15Code: string): Array<{ route: string; warnMin: number; failMin: number }> {
  const list = /with e \(route, warn_min, fail_min\) as \( values (.*?) \)/.exec(collapse(row15Code))?.[1] ?? "";
  return [...list.matchAll(/\('([a-z0-9-]+)'::text, (\d+)::numeric, (\d+)::numeric\)/g)].map((m) => ({
    route: m[1] as string,
    warnMin: Number(m[2]),
    failMin: Number(m[3]),
  }));
}

/** The quoted entries of the first `in (...)` list after `from`. */
function quotedListAfter(text: string, from: number): string[] {
  const open = text.indexOf("in (", from);
  expect(open, "in ( after the marker").toBeGreaterThanOrEqual(0);
  const close = text.indexOf(")", open);
  return [...text.slice(open + "in (".length, close).matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
}

describe("migration 195_ops_cron_route_low_cadence.sql (SQL contract)", () => {
  let raw = "";
  let code = "";
  let statements: string[] = [];
  let raw192 = "";
  let sec192 = "";
  let sec195 = "";
  let row15_192 = "";
  let row15_195 = "";
  let row15Code = "";

  beforeAll(() => {
    expect(existsSync(MIGRATION_195), "195_ops_cron_route_low_cadence.sql must exist").toBe(true);
    raw = readFileSync(MIGRATION_195, "utf8");
    code = stripComments(raw);
    statements = splitStatements(code);
    raw192 = readFileSync(MIGRATION_192, "utf8");
    sec192 = opsSection(raw192);
    sec195 = opsSection(raw);
    row15_192 = row15Of(sec192);
    row15_195 = row15Of(sec195);
    row15Code = stripComments(row15_195);
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
      "insert into supabase_migrations.schema_migrations (version, name) values ('195', '195_ops_cron_route_low_cadence') on conflict do nothing",
    );
    expect(statements).toContain("notify pgrst, 'reload schema'");
    expect(statements.indexOf("notify pgrst, 'reload schema'")).toBeLessThan(statements.length - 2);
  });

  it("runs exactly these statements, in this order: the function, its comment, 192's revoke and grant, the reload, the ledger", () => {
    const shape = statements.map((s) => collapse(s).split(" ").slice(0, 2).join(" "));
    expect(shape).toEqual([
      "begin",
      "set local",
      "create or", // ops_health_report
      "comment on", // ops_health_report
      "revoke all", // ops_health_report
      "grant execute", // ops_health_report
      "notify pgrst,",
      "insert into",
      "commit",
    ]);
    const creates = statements.filter((s) => s.startsWith("create or replace function"));
    expect(creates.map((s) => /function (public\.[a-z_0-9]+)\(/.exec(s)?.[1])).toEqual(["public.ops_health_report"]);
  });

  it("is additive: create or replace function only, no table, column, index, policy, trigger, cron job or data write; the function itself only reads", () => {
    const outside = statements.filter((s) => !s.startsWith(OPS_CREATE));
    const words = wordsOf(blankStrings(outside.join(";\n")));
    for (const forbidden of ["drop", "alter", "truncate", "update", "delete", "policy", "view", "index", "trigger", "default", "privileges", "concurrently", "sequence", "vacuum", "schedule", "table"]) {
      expect(words, forbidden).not.toContain(forbidden);
    }
    expect(outside.filter((s) => s.startsWith("insert"))).toHaveLength(1);
    const ops = statements.find((s) => s.startsWith(OPS_CREATE)) as string;
    const opsWords = wordsOf(blankStrings(ops));
    for (const forbidden of ["drop", "alter", "truncate", "delete", "grant", "revoke", "vacuum", "analyze"]) {
      expect(opsWords, forbidden).not.toContain(forbidden);
    }
    // the only `insert`/`update` words of the function are inside quoted text (the anon_surface privilege names)
    expect(opsWords).not.toContain("insert");
    expect(opsWords).not.toContain("update");
  });

  it("grants exactly 192's shape (revoke from public, anon, authenticated; execute to service_role only), the statements 173 and 192 end with", () => {
    const revokes = statements.filter((s) => s.startsWith("revoke")).map(collapse);
    const grants = statements.filter((s) => s.startsWith("grant")).map(collapse);
    expect(revokes).toEqual([OPS_REVOKE.slice(0, -1)]);
    expect(grants).toEqual([OPS_GRANT.slice(0, -1)]);
    expect(grants.join(" ")).not.toMatch(/\b(anon|authenticated)\b/i);
    expect(raw192).toContain(OPS_REVOKE);
    expect(raw192).toContain(OPS_GRANT);
  });

  // ---- what 195 copies: 192's body, which is the production body ---------------------------------

  it("the migration that re-creates ops_health_report() right before 195 is 192, and its body is the production body: md5 and length recorded in the header", () => {
    const withReport = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{3}_.+\.sql$/.test(f))
      .filter((f) => stripComments(readFileSync(resolve(MIGRATIONS_DIR, f), "utf8")).includes(OPS_CREATE))
      .map((f) => parseInt(f, 10))
      .sort((a, b) => a - b);
    expect(withReport).toContain(195);
    expect(withReport[withReport.indexOf(195) - 1]).toBe(192);
    const body192 = prosrc(raw192, "ops_health_report");
    expect(body192.length).toBe(PROD_OPS_LENGTH);
    expect(md5(body192)).toBe(PROD_OPS_MD5);
    expect(raw).toContain(PROD_OPS_MD5);
    expect(raw).toContain(`length ${PROD_OPS_LENGTH}`);
    expect(raw).toContain(PROD_OPS_ACL);
    expect(raw).toContain("select md5(p.prosrc)");
  });

  it("re-creates the report as 192's text from the create line through the grant, with exactly row 15, its two comment spots and the comment's migration list changed", () => {
    let expected = replaceSpan(sec192, ROW15_START, ROW16_START, row15_195);
    expected = replaceSpan(expected, COMMENT15_START, COMMENT16_START, comment15Of(sec195));
    expect(sec192.split(COMMENT_LIST_192).length - 1, "192's comment lists its migrations once").toBe(1);
    expected = expected.replace(COMMENT_LIST_192, COMMENT_LIST_195);
    expect(expected).not.toBe(sec192);
    expect(sec195.length).toBe(expected.length);
    expect(sec195).toBe(expected);
    expect(sec192.length).toBeGreaterThan(50000);
    // the changed spots really changed
    expect(row15_195).not.toBe(row15_192);
    expect(comment15Of(sec195)).not.toBe(comment15Of(sec192));
  });

  it("everything before and after row 15 is 192's, byte for byte: rows 1-14 and 16-22, the declare block, row 4's BIAS_TO_ZONE copy", () => {
    const before = (s: string): string => s.slice(0, s.indexOf(ROW15_START));
    const after = (s: string): string => s.slice(s.indexOf(ROW16_START));
    // the function comment differs by the two spots above; compare the function bodies only
    const fn192 = opsFunction(raw192);
    const fn195 = opsFunction(raw);
    expect(before(fn195)).toBe(before(fn192));
    expect(after(fn195)).toBe(after(fn192));
    expect(before(fn195).length).toBeGreaterThan(15000);
    expect(after(fn195).length).toBeGreaterThan(25000);
    // the declare block (a nested declare of row 15's own variables must not touch it)
    const declare = (s: string): string => s.slice(s.indexOf("declare"), s.indexOf("begin\n  -- 1."));
    expect(declare(fn195)).toBe(declare(fn192));
  });

  it("keeps the 22 literal check names in 192's order (no check added, dropped or renamed)", () => {
    expect(checkNames(sec195)).toEqual(checkNames(sec192));
    expect(checkNames(sec195)).toContain("cron_route_failures_30m");
    expect(checkNames(sec195)[checkNames(sec195).length - 1]).toBe("sources_dark_persistent");
    expect(checkNames(sec195).length).toBeGreaterThanOrEqual(19);
    expect(row15Code.match(/check_name\s*:=/g)).toHaveLength(1);
  });

  // ---- row 15 --------------------------------------------------------------------------------------

  it("row 15 keeps its name, threshold, the missing-table answer and the exception handler", () => {
    const n = collapse(row15Code);
    expect(n).toContain("check_name := 'cron_route_failures_30m'; threshold := 1; observed := null; detail := null;");
    expect(n).toContain("if pg_catalog.to_regclass('public.ops_cron_route_runs') is null then status := 'unknown'; detail := 'ops_cron_route_runs yok';");
    expect(n).toContain("exception when others then status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200); end; return next;");
  });

  it("the 30 minute rule is 192's text exactly (the `r` CTE and its select), and so is the silence CTE `s` and its select", () => {
    const part = (s: string, a: string, b: string): string => {
      const at = s.indexOf(a);
      expect(at, a).toBeGreaterThanOrEqual(0);
      const end = s.indexOf(b, at);
      expect(end, b).toBeGreaterThan(at);
      return s.slice(at, end + b.length);
    };
    const r192 = part(row15_192, "      with r as (", "        from r;");
    expect(part(row15_195, "      with r as (", "        from r;")).toBe(r192);
    expect(r192).toContain("where x.ran_at >= v_now - interval '30 minutes'");
    expect(r192).toContain("pg_catalog.count(*) filter (where r.failures >= 2 and r.failures * 2 >= r.runs)");
    const s192 = part(row15_192, "      s as (", "        from s;");
    expect(part(row15_195, "      s as (", "        from s;")).toBe(s192);
    // the headline and alerts-webhooks gaps of 136 stay
    const list195 = silenceList(row15Code);
    expect(list195.slice(0, 2)).toEqual(silenceList(stripComments(row15_192)));
    expect(list195.slice(0, 2)).toEqual([
      { route: "headline", warnMin: 15, failMin: 30 },
      { route: "alerts-webhooks", warnMin: 25, failMin: 60 },
    ]);
  });

  it("the silence list gains ('fact-checks'::text, 130::numeric, 250::numeric) after the two it had, and nothing else", () => {
    expect(silenceList(row15Code)).toEqual([
      { route: "headline", warnMin: 15, failMin: 30 },
      { route: "alerts-webhooks", warnMin: 25, failMin: 60 },
      { route: "fact-checks", warnMin: 130, failMin: 250 },
    ]);
    expect(collapse(row15Code)).toContain("('fact-checks'::text, 130::numeric, 250::numeric)");
    // social (daytime only) and digest (weekly) are NOT silence-listed
    expect(silenceList(row15Code).map((e) => e.route)).not.toContain("social");
    expect(silenceList(row15Code).map((e) => e.route)).not.toContain("digest");
  });

  it("the low-cadence rule reads exactly the routes ('fact-checks', 'social', 'digest'), each route's newest two rows within 7 days", () => {
    const n = collapse(row15Code);
    const marker = "with l as (";
    const at = n.indexOf(marker);
    expect(at, "the low-cadence CTE").toBeGreaterThan(0);
    expect(n.indexOf(marker, at + 1)).toBe(-1);
    expect(quotedListAfter(n, at)).toEqual([...LOW_CADENCE_ROUTES]);
    expect(n).toContain("pg_catalog.row_number() over (partition by x.route order by x.ran_at desc, x.id desc) as rn");
    expect(n).toContain("from public.ops_cron_route_runs x where x.route in ('fact-checks', 'social', 'digest') and x.ran_at >= v_now - interval '7 days'");
    expect(n).toContain("where l.rn <= 2");
    // two failing rows (both >= 500) are a failing route, only the newest one a warn
    expect(n).toContain("when pg_catalog.count(*) filter (where l.status >= 500) = 2 then 2");
    expect(n).toContain("when pg_catalog.bool_or(l.rn = 1 and l.status >= 500) then 1");
    expect(n).toContain("else 0 end as streak");
    // the newest row decides: an older failure behind a newer success is not counted (no `rn = 2` alone)
    expect(n).not.toMatch(/bool_or\(l\.rn = 2/);
  });

  it("the failing route counts for 'fail', the newest-failed route for 'warn', regardless of the 30 minute window; the empty-window warn does not hide them", () => {
    const n = collapse(row15Code);
    expect(n).toContain("count(*) filter (where k.streak = 2)::numeric");
    expect(n).toContain("count(*) filter (where k.streak >= 1)::numeric");
    expect(n).toContain("into v_low_fail, v_low_warn, v_low_text");
    expect(n).toContain("v_low_fail := coalesce(v_low_fail, 0); v_low_warn := coalesce(v_low_warn, 0);");
    expect(n).toContain("if v_total = 0 and v_jobs = 0 and v_low_warn = 0 then status := 'warn'; observed := null; detail := 'son 30 dakikada cron rotası kaydı yok';");
    expect(n).toContain("observed := v_n + v_jobs + v_low_warn;");
    expect(n).toContain(
      "status := case when v_zero >= 1 or v_active or v_low_fail >= 1 then 'fail' when v_n >= 1 or v_jobs >= 1 or v_low_warn >= 1 or v_total = 0 then 'warn' else 'pass' end;",
    );
  });

  it("the detail appends `ardışık başarısız: route n/2` last, route names and counts only, still cut at 500 characters", () => {
    const n = collapse(row15Code);
    expect(n).toContain("case when v_low_warn >= 1 then 'ardışık başarısız: ' || v_low_text end), 1, 500);");
    expect(n).toContain("k.route || ' ' || k.streak::text || '/2'");
    // the first two pieces are 192's, in 192's order: the 30 minute text, then the silence text, then the new one
    const at30 = n.indexOf("'son 30 dakikada başarısız: ' || v_text");
    const atSilence = n.indexOf("'kayıt gelmiyor: ' || v_zone");
    const atLow = n.indexOf("'ardışık başarısız: ' || v_low_text");
    expect(at30).toBeGreaterThan(0);
    expect(atSilence).toBeGreaterThan(at30);
    expect(atLow).toBeGreaterThan(atSilence);
    // the text only ever names routes and counts: no column other than route and the streak enters the string
    const lowDetail = n.slice(n.indexOf("with l as ("), n.indexOf("into v_low_fail"));
    expect(lowDetail).not.toMatch(/\b(url|body|message|error|sqlerrm|detail)\b/i);
  });

  it("row 15's own variables are declared in a nested block, so the function's declare block stays 192's", () => {
    const n = collapse(row15Code);
    expect(n).toContain("declare v_low_fail numeric; v_low_warn numeric; v_low_text text; begin v_n := null;");
    const fn195 = opsFunction(raw);
    const fnDeclare = fn195.slice(fn195.indexOf("declare"), fn195.indexOf("begin\n  -- 1."));
    expect(fnDeclare).not.toContain("v_low");
  });

  it("both rules only read: no write keyword in row 15 outside string literals", () => {
    const words = wordsOf(blankStrings(row15Code));
    for (const w of ["insert", "update", "delete", "truncate", "drop", "alter", "create", "perform", "execute"]) {
      expect(words, w).not.toContain(w);
    }
    expect(words).toContain("ops_cron_route_runs");
  });

  // ---- the gaps follow vercel.ts ---------------------------------------------------------------------

  it("every route of the low-cadence list has a cron folder and a schedule in vercel.ts; fact-checks is hourly (minute :23), so 130 / 250 minutes are two and four missed ticks", () => {
    const vercel = readFileSync(VERCEL_TS, "utf8");
    const folders = readdirSync(CRON_DIR);
    for (const route of LOW_CADENCE_ROUTES) {
      expect(folders, `src/app/api/cron/${route}`).toContain(route);
      expect(vercel, `vercel.ts schedule of /api/cron/${route}`).toMatch(new RegExp(`path:\\s*"/api/cron/${route}",\\s*schedule:\\s*"[^"]+"`));
    }
    expect(vercel).toMatch(/path:\s*"\/api\/cron\/fact-checks",\s*schedule:\s*"23 \* \* \* \*"/);
    const fact = silenceList(row15Code).find((e) => e.route === "fact-checks");
    expect(fact).toBeDefined();
    const tick = 60;
    expect(fact!.warnMin).toBeGreaterThanOrEqual(2 * tick);
    expect(fact!.warnMin).toBeLessThan(3 * tick);
    expect(fact!.failMin).toBeGreaterThanOrEqual(4 * tick);
    expect(fact!.failMin).toBeLessThan(5 * tick);
    // digest is weekly (Saturday and Sunday 06:00) and social daytime only: neither has a gap rule here
    expect(vercel).toMatch(/path:\s*"\/api\/cron\/digest",\s*schedule:\s*"0 6 \* \* 6,0"/);
    expect(vercel).toMatch(/path:\s*"\/api\/cron\/social",\s*schedule:\s*"\*\/20 5-20 \* \* \*"/);
  });

  // ---- the function comment and the row comment ----------------------------------------------------------

  it("the function comment lists migration 195 after 192 (still 22 fixed rows) and describes the new row 15", () => {
    const at = sec195.indexOf("comment on function public.ops_health_report() is");
    expect(at).toBeGreaterThan(0);
    const comment = sec195.slice(at);
    expect(comment).toContain("(migrations 077, 100, 103, 108, 114, 115, 119, 122, 136, 145, 150, 157, 158, 159, 161, 167, 173, 192, 195): 22 fixed rows");
    const c15 = collapse(comment15Of(sec195).replace(/\n\s*'/g, " ").replace(/'/g, ""));
    for (const needle of ["fact-checks", "130", "250", "ardışık başarısız", "social", "digest", "two rows within 7 days", "headline", "alerts-webhooks"]) {
      expect(c15, needle).toContain(needle);
    }
    expect(comment).toContain("service_role only");
    expect(comment).toContain("docs/ops-heartbeat.md");
    // the rest of the comment is 192's (the row-15 spot and the list are the only differences)
    expect(comment).toContain("sources_dark_persistent (an active outlet or wire source");
  });

  it("the row-15 code comment says what the rules are: the gap for fact-checks, the low-cadence streak, and what stays out", () => {
    const c = collapse(row15_195.split("\n").filter((l) => l.trimStart().startsWith("--")).join(" "));
    for (const needle of ["h118-crons-1", "migration 195", "fact-checks", "130", "250", "ardışık başarısız", "newest two rows", "social", "digest", "headline", "alerts-webhooks", "30 minute"]) {
      expect(c, needle).toContain(needle);
    }
    // 136's claim that the hourly fact-checks route has too few ticks for a gap rule is gone
    expect(c).not.toContain("Hourly, daytime-only and weekly routes (fact-checks, social, digest)");
  });

  // ---- header ----------------------------------------------------------------------------------------

  it("header documents why, the evidence, the numbering, Step 0 (prod fingerprint), what changes, deploy, verify, replay, dry run and rollback", () => {
    expect(raw).toMatch(/^-- 195_ops_cron_route_low_cadence\.sql/);
    for (const needle of [
      "h118-crons-1",
      "NUMBERING",
      "194",
      "search_rank_display_title",
      "STEP 0",
      "192_saved_clusters_v4.sql",
      "ops_health_report",
      "cron_route_failures_30m",
      "fact-checks",
      "130",
      "250",
      "ardışık başarısız",
      "scripts/lib/ops-heartbeat.mjs",
      "warn never pages",
      "DEPLOY",
      "VERIFY",
      "REPLAY",
      "DRY RUN",
      "DRYRUN 195 OK",
      "ROLLBACK",
      "delete from supabase_migrations.schema_migrations where version = '195'",
      "tests/migrations/195-ops-cron-route-low-cadence.test.ts",
    ]) {
      expect(raw, needle).toContain(needle);
    }
  });

  it("the rollback re-runs 192's report section and deletes ledger row 195 (never 194)", () => {
    const at = raw.indexOf("ROLLBACK");
    expect(at).toBeGreaterThan(0);
    const rollback = raw.slice(at);
    expect(rollback).toContain("192_saved_clusters_v4.sql");
    expect(rollback).toContain("create or replace function public.ops_health_report()");
    expect(rollback).toContain(OPS_GRANT);
    expect(rollback).toContain(PROD_OPS_MD5);
    expect(rollback).toContain("notify pgrst, 'reload schema';");
    expect(rollback).toContain("delete from supabase_migrations.schema_migrations where version = '195'");
    expect(rollback).not.toContain("version = '194'");
  });

  it("records the md5 and length of the body it writes (header and migration guide), recomputed here", () => {
    const body = prosrc(raw, "ops_health_report");
    expect(body).not.toBe(prosrc(raw192, "ops_health_report"));
    const fingerprint = md5(body);
    expect(raw, "header md5 of the new body").toContain(fingerprint);
    expect(raw, "header length of the new body").toContain(`${body.length} characters`);
    const guide = readFileSync(DOC_MIGRATION_GUIDE, "utf8");
    const gat = guide.indexOf("\n## 195");
    const next = guide.indexOf("\n## ", gat + 1);
    const section = guide.slice(gat, next < 0 ? undefined : next);
    expect(section, "guide md5 of the new body").toContain(fingerprint);
    expect(section, "guide length of the new body").toContain(`\`${fingerprint}\` | ${body.length} |`);
    expect(section).toContain(`\`${PROD_OPS_MD5}\` | ${PROD_OPS_LENGTH} |`);
  });

  // ---- docs ------------------------------------------------------------------------------------------

  it("docs/migration-guide.md has a '## 195' section after 193: why, what, order, verify, replay and rollback", () => {
    const guide = readFileSync(DOC_MIGRATION_GUIDE, "utf8");
    const at = guide.indexOf("\n## 195");
    expect(at, "## 195 heading").toBeGreaterThan(0);
    expect(guide.indexOf("\n## 195", at + 1), "one 195 section").toBe(-1);
    expect(guide.indexOf("\n## 193")).toBeGreaterThan(0);
    expect(guide.indexOf("\n## 193")).toBeLessThan(at);
    const next = guide.indexOf("\n## ", at + 1);
    const section = guide.slice(at, next < 0 ? undefined : next);
    expect(section).toMatch(/^\n## 195 — .*cron_route_failures_30m/);
    for (const needle of [
      "**Why:**",
      "**What 195 does**",
      "**Order:**",
      "**Verify",
      "**Rollback",
      "h118-crons-1",
      "fact-checks",
      "130",
      "250",
      "ardışık başarısız",
      "194",
      "ops_health_report",
      "scripts/lib/ops-heartbeat.mjs",
      PROD_OPS_MD5,
      "delete from supabase_migrations.schema_migrations where version = '195'",
    ]) {
      expect(section, needle).toContain(needle);
    }
    // the section says the founder applies it and that nothing but the function changes
    expect(section.toLowerCase()).toContain("no app change");
  });

  it("docs/ops-heartbeat.md row 15 names the fact-checks gap (130 / 250) and the low-cadence streak, and no longer says fact-checks, social and digest stay out", () => {
    const doc = readFileSync(DOC_OPS_HEARTBEAT, "utf8");
    const row = doc.split("\n").find((l) => l.startsWith("| 15 | `cron_route_failures_30m`")) as string;
    expect(row, "table row 15").toBeDefined();
    for (const needle of ["fact-checks", "130", "250", "ardışık başarısız", "social", "digest", "newest two", "migration 195", "h118-crons-1"]) {
      expect(row, needle).toContain(needle);
    }
    expect(row).not.toContain("Hourly, daytime-only and weekly routes (fact-checks, social, digest) have too few ticks");
    const at = doc.indexOf("**Row 15, `cron_route_failures_30m`.**");
    expect(at).toBeGreaterThan(0);
    const section = doc.slice(at, doc.indexOf("\n- **What it cannot see.**", at));
    expect(section).toContain("ardışık başarısız");
    expect(section).toContain("130");
    expect(section).toContain("250");
    // 136 said the hourly fact-checks route had too few ticks for a gap rule: only social and digest are still left out
    expect(section).not.toContain("`fact-checks` (hourly), `social` (daytime only) and `digest`");
    expect(section).toContain("`social` (daytime only) and `digest`");
    expect(section).toContain("`fact-checks`,\n  hourly at :23, warns above 130 and fails above 250");
  });

  it("AGENTS.md points the 'copy the newest ops_health_report definition' note at 195", () => {
    const agents = readFileSync(AGENTS, "utf8");
    expect(agents).toContain("copies the newest definition (currently `195_ops_cron_route_low_cadence.sql`)");
    expect(agents).not.toContain("copies the newest definition (currently `192_saved_clusters_v4.sql`)");
  });

  it("ships a local PG15 dry run that applies the chain, 195 twice, and ends with DRYRUN 195 OK", () => {
    expect(existsSync(DRYRUN), "195 dry-run sql must exist").toBe(true);
    const dry = readFileSync(DRYRUN, "utf8");
    expect(dry).toMatch(/192-saved-clusters-v4-dryrun\.sql/);
    expect(dry.match(/195_ops_cron_route_low_cadence\.sql/g)!.length).toBeGreaterThanOrEqual(2);
    expect(dry).toContain(PROD_OPS_MD5);
    expect(dry).toContain(String(PROD_OPS_LENGTH));
    expect(dry).toMatch(/has_function_privilege/);
    expect(dry).toMatch(/DRYRUN 195 OK/);
  });

  it("the live manifest builds this test's database (dry run as setup, zero allowed skips)", () => {
    const lines = readFileSync(MANIFEST, "utf8").split("\n");
    const entry = lines.find((l) => l.startsWith("run | 195-ops-cron-route-low-cadence.test.ts"));
    expect(entry, "run | 195-ops-cron-route-low-cadence.test.ts entry").toBeDefined();
    expect(entry).toContain("tests/migrations/sql/195-ops-cron-route-low-cadence-dryrun.sql");
    expect((entry as string).trim().endsWith("| 0")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Live block (opt-in): needs the database tests/migrations/sql/live-manifest.txt builds for this file (the chain up to
// 192 by the 192 dry run, then 195 applied twice by this file's dry-run script); TAYF_PSQL is the psql binary and
// PGHOST/PGPORT/PGUSER/PGDATABASE select the server. Every scenario that writes sits inside one transaction that is
// rolled back.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))("migration 195: ops_health_report() row 15 (live Postgres)", () => {
  assertLiveReady("195", {
    ledger: ["136", "173", "192", "195"],
    relations: ["public.ops_cron_route_runs"],
    functions: ["public.ops_health_report()", "public.ops_cron_route_run_record(text,integer,integer)"],
  });

  function runPsql(input: string): string {
    return execFileSync(process.env.TAYF_PSQL as string, ["-X", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      input,
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8" },
      maxBuffer: 16 * 1024 * 1024,
    });
  }
  const lines = (out: string, tag: string): string[] =>
    out.split("\n").filter((l) => l.startsWith(`${tag}|`)).map((l) => l.slice(tag.length + 1));

  /** A fixture row: minutes before now(), route, HTTP status. */
  type Row = readonly [number, string, number];

  /** Every ran_at is now() - minutes, and the report reads pg_catalog.now(): the same transaction clock, so the gaps are exact. */
  const insertRows = (rows: readonly Row[]): string =>
    rows.length === 0
      ? ""
      : `insert into public.ops_cron_route_runs (ran_at, route, status, ok, duration_ms)
  select now() - m * interval '1 minute', r, s, s < 500, 120
    from (values ${rows.map(([m, r, s]) => `(${m}::numeric, '${r}'::text, ${s}::int)`).join(", ")}) as v(m, r, s);`;

  /** 192's function, from its own file, as a temporary function (the side-by-side run). */
  const fn192 = ((): string => {
    const text = opsFunction(readFileSync(MIGRATION_192, "utf8"));
    return text.replace(OPS_CREATE, "create function pg_temp.ops_health_report_192()");
  })();

  interface Answer {
    status: string;
    observed: string;
    detail: string;
  }

  /**
   * Row 15 of 195's function and of 192's on the same fixture, plus whether every other row is identical, whole (status, observed,
   * threshold, detail). db_size_mb is the one row left out: it reads pg_database_size, which moves with any catalogue write, and its
   * text is 192's byte for byte (pinned above).
   */
  function report(rows: readonly Row[]): { now: Answer; old: Answer; othersEqual: boolean; names: string } {
    const out = runPsql(`
begin;
delete from public.ops_cron_route_runs;
${insertRows(rows)}
${fn192}
select 'NEW|' || status || '|' || coalesce(observed::text, '') || '|' || coalesce(detail, '')
  from public.ops_health_report() where check_name = 'cron_route_failures_30m';
select 'OLD|' || status || '|' || coalesce(observed::text, '') || '|' || coalesce(detail, '')
  from pg_temp.ops_health_report_192() where check_name = 'cron_route_failures_30m';
select 'OTHERS|' || (
  (select array_agg(t::text order by t.check_name) from public.ops_health_report() t where t.check_name not in ('cron_route_failures_30m', 'db_size_mb'))
  = (select array_agg(t::text order by t.check_name) from pg_temp.ops_health_report_192() t where t.check_name not in ('cron_route_failures_30m', 'db_size_mb'))
)::text;
select 'NAMES|' || (select string_agg(check_name, ',') from public.ops_health_report());
rollback;
`);
    const answer = (tag: string): Answer => {
      const l = lines(out, tag);
      expect(l, `${tag} line`).toHaveLength(1);
      const [status, observed, ...detail] = (l[0] as string).split("|");
      return { status: status as string, observed: observed as string, detail: detail.join("|") };
    };
    return { now: answer("NEW"), old: answer("OLD"), othersEqual: lines(out, "OTHERS")[0] === "true", names: lines(out, "NAMES")[0] as string };
  }

  /** The healthy base: headline 6 runs and alerts-webhooks 3 runs inside the last 30 minutes, all 200. */
  const base = (): Row[] => [
    ...[1, 6, 11, 16, 21, 26].map((m): Row => [m, "headline", 200]),
    ...[2, 12, 22].map((m): Row => [m, "alerts-webhooks", 200]),
  ];
  /** Production's cadence on 2026-11-11: the base plus fact-checks hourly at :23, social every 20 minutes, one digest. */
  const today = (): Row[] => [
    ...base(),
    [23, "fact-checks", 200],
    [83, "fact-checks", 200],
    [143, "fact-checks", 200],
    [20, "social", 200],
    [40, "social", 200],
    [60, "social", 200],
    [3 * 24 * 60, "digest", 200],
  ];

  const QUIET = "son 30 dakikada 9 çalışma, başarısız yok";

  it("the target database runs 195: one ledger row named 195_ops_cron_route_low_cadence, and the function is the file's text (md5 of prosrc)", () => {
    const out = runPsql(`
select 'LEDGER|' || count(*) || '|' || min(name) from supabase_migrations.schema_migrations where version = '195';
select 'MD5|' || md5(prosrc) || '|' || length(prosrc) from pg_proc where oid = 'public.ops_health_report()'::regprocedure;
select 'ATTR|' || prosecdef || '|' || provolatile::text || '|' || proconfig::text || '|' || (select lanname from pg_language where oid = prolang)
  from pg_proc where oid = 'public.ops_health_report()'::regprocedure;
select 'ACL|' || has_function_privilege('anon', 'public.ops_health_report()', 'execute')
       || '|' || has_function_privilege('authenticated', 'public.ops_health_report()', 'execute')
       || '|' || has_function_privilege('service_role', 'public.ops_health_report()', 'execute');
select 'COUNT|' || count(*) from pg_proc where proname = 'ops_health_report' and pronamespace = 'public'::regnamespace;
`);
    expect(lines(out, "LEDGER")).toEqual(["1|195_ops_cron_route_low_cadence"]);
    const body = prosrc(readFileSync(MIGRATION_195, "utf8"), "ops_health_report");
    expect(lines(out, "MD5")).toEqual([`${md5(body)}|${body.length}`]);
    expect(lines(out, "ATTR")).toEqual(['true|v|{"search_path=\\"\\""}|plpgsql']);
    expect(lines(out, "ACL")).toEqual(["false|false|true"]);
    expect(lines(out, "COUNT")).toEqual(["1"]);
  });

  it("returns 22 rows in 192's order", () => {
    const r = report(today());
    const names = r.names.split(",");
    expect(names).toHaveLength(22);
    expect(names[14]).toBe("cron_route_failures_30m");
    expect(names[16]).toBe("anon_surface");
    expect(names[21]).toBe("sources_dark_persistent");
  });

  it("production's cadence on 2026-11-11 (the replay): pass, with 192's status, observed and detail unchanged", () => {
    const r = report(today());
    expect(r.now.status).toBe("pass");
    expect(r.now.observed).toBe("0");
    expect(r.now.detail).toBe("son 30 dakikada 11 çalışma, başarısız yok");
    expect(r.now).toEqual(r.old);
    expect(r.othersEqual).toBe(true);
  });

  it("healthy data: pass (and 192's answer)", () => {
    const r = report([...base(), [23, "fact-checks", 200]]);
    expect(r.now.status).toBe("pass");
    expect(r.now).toEqual(r.old);
  });

  it("spec 1: the two newest fact-checks rows are 500 (both older than 30 minutes) -> fail, and 192 read pass on the same rows", () => {
    const r = report([...base(), [45, "fact-checks", 500], [105, "fact-checks", 500]]);
    expect(r.now.status).toBe("fail");
    expect(r.now.observed).toBe("1");
    expect(r.now.detail).toBe(`${QUIET} · ardışık başarısız: fact-checks 2/2`);
    expect(r.old.status).toBe("pass");
    expect(r.othersEqual).toBe(true);
  });

  it("spec 1b: the same two failures with the newest one inside the 30 minute window: fail, both rules named", () => {
    const r = report([...base(), [23, "fact-checks", 500], [83, "fact-checks", 500]]);
    expect(r.now.status).toBe("fail");
    expect(r.now.detail).toBe("son 30 dakikada başarısız: fact-checks 1/1 · ardışık başarısız: fact-checks 2/2");
    expect(r.old.status).toBe("warn");
  });

  it("spec 2: the newest fact-checks row is 500 and the previous one is 200 -> warn, 1/2, even though the row is older than 30 minutes", () => {
    const r = report([...base(), [45, "fact-checks", 500], [105, "fact-checks", 200]]);
    expect(r.now.status).toBe("warn");
    expect(r.now.observed).toBe("1");
    expect(r.now.detail).toBe(`${QUIET} · ardışık başarısız: fact-checks 1/2`);
    expect(r.old.status).toBe("pass");
  });

  it("an older failure behind a newer success is not counted: newest 200, previous 500 -> pass", () => {
    const r = report([...base(), [45, "fact-checks", 200], [105, "fact-checks", 500], [165, "fact-checks", 500]]);
    expect(r.now.status).toBe("pass");
    expect(r.now).toEqual(r.old);
  });

  it("only the newest TWO rows count: 500, 200, 500 is a warn (1/2), 500, 500, 200 a fail (2/2)", () => {
    expect(report([...base(), [45, "fact-checks", 500], [105, "fact-checks", 200], [165, "fact-checks", 500]]).now.status).toBe("warn");
    expect(report([...base(), [45, "fact-checks", 500], [105, "fact-checks", 500], [165, "fact-checks", 200]]).now.status).toBe("fail");
  });

  it("a 599 (a 200 with a failed sub-step) is a failure like any status >= 500, and a 499 is not", () => {
    expect(report([...base(), [45, "fact-checks", 599], [105, "fact-checks", 599]]).now.status).toBe("fail");
    expect(report([...base(), [45, "fact-checks", 500], [105, "fact-checks", 499]]).now.status).toBe("warn");
    expect(report([...base(), [45, "fact-checks", 499], [105, "fact-checks", 499]]).now.status).toBe("pass");
  });

  it("spec 4: headline with 2 failures out of 6 in 30 minutes is a warn, as today; 3 of 6 is a fail, as today", () => {
    const failing = (n: number): Row[] =>
      [1, 6, 11, 16, 21, 26].map((m, i): Row => [m, "headline", i < n ? 500 : 200]);
    const two = report([...failing(2), ...[2, 12, 22].map((m): Row => [m, "alerts-webhooks", 200]), [23, "fact-checks", 200]]);
    expect(two.now.status).toBe("warn");
    expect(two.now.detail).toBe("son 30 dakikada başarısız: headline 2/6");
    expect(two.now).toEqual(two.old);
    const three = report([...failing(3), ...[2, 12, 22].map((m): Row => [m, "alerts-webhooks", 200]), [23, "fact-checks", 200]]);
    expect(three.now.status).toBe("fail");
    expect(three.now).toEqual(three.old);
    expect(three.othersEqual).toBe(true);
  });

  it("headline's low-cadence-looking failures are NOT streak-counted: headline 500 at 45 and 105 minutes ago (outside the window) stays pass", () => {
    const r = report([...base(), [23, "fact-checks", 200], [45, "headline", 500], [105, "headline", 500]]);
    expect(r.now.status).toBe("pass");
    expect(r.now).toEqual(r.old);
  });

  it("spec 5: the newest fact-checks row is 260 minutes old -> fail, named as a silent route (192: pass)", () => {
    const r = report([...base(), [260, "fact-checks", 200]]);
    expect(r.now.status).toBe("fail");
    expect(r.now.observed).toBe("1");
    expect(r.now.detail).toBe(`${QUIET} · kayıt gelmiyor: fact-checks 260 dk`);
    expect(r.old.status).toBe("pass");
    expect(r.othersEqual).toBe(true);
  });

  it("the fact-checks gap boundaries: 130 min pass, 131 warn; 250 warn, 251 fail (warn above warn_min, fail above fail_min)", () => {
    const at = (m: number): string => report([...base(), [m, "fact-checks", 200]]).now.status;
    expect([at(129), at(130), at(131), at(190), at(250), at(251)]).toEqual(["pass", "pass", "warn", "warn", "warn", "fail"]);
    const warn = report([...base(), [131, "fact-checks", 200]]).now;
    expect(warn.detail).toBe(`${QUIET} · kayıt gelmiyor: fact-checks 131 dk`);
    expect(warn.observed).toBe("1");
  });

  it("a fact-checks route that has never recorded in 7 days cannot be compared with anything: pass (never recorded is not flagged)", () => {
    const r = report(base());
    expect(r.now.status).toBe("pass");
    expect(r.now).toEqual(r.old);
    // rows older than the 7 day retention do not count either: two failures 8 days ago
    const old = report([...base(), [8 * 24 * 60, "fact-checks", 500], [8 * 24 * 60 + 60, "fact-checks", 500]]);
    expect(old.now.status).toBe("pass");
    expect(old.now).toEqual(old.old);
  });

  it("headline and alerts-webhooks silence is unchanged (15 / 30 and 25 / 60 minutes) while fact-checks is healthy", () => {
    const quiet = (route: string, m: number): string => {
      const rows = base().filter((r) => r[1] !== route);
      return report([...rows, [m, route, 200], [23, "fact-checks", 200]]).now.status;
    };
    expect([quiet("headline", 15), quiet("headline", 16), quiet("headline", 30), quiet("headline", 31)]).toEqual(["pass", "warn", "warn", "fail"]);
    expect([quiet("alerts-webhooks", 25), quiet("alerts-webhooks", 26), quiet("alerts-webhooks", 60), quiet("alerts-webhooks", 61)]).toEqual(["pass", "warn", "warn", "fail"]);
  });

  it("social: two failing rows -> fail (2/2), one -> warn (1/2); social silence is NOT a gap rule (12 hours without a row is pass)", () => {
    expect(report([...base(), [45, "social", 500], [65, "social", 500]]).now.status).toBe("fail");
    const warn = report([...base(), [45, "social", 500], [65, "social", 200]]);
    expect(warn.now.status).toBe("warn");
    expect(warn.now.detail).toBe(`${QUIET} · ardışık başarısız: social 1/2`);
    const overnight = report([...base(), [12 * 60, "social", 200], [12 * 60 + 20, "social", 200]]);
    expect(overnight.now.status).toBe("pass");
    expect(overnight.now).toEqual(overnight.old);
  });

  it("digest: two failing weekend rows -> fail (2/2) until a later run succeeds; one failing row (all the 7 day table holds) -> warn (1/2); a healthy weekly row 6 days old -> pass", () => {
    const day = 24 * 60;
    const two = report([...base(), [3 * day, "digest", 500], [2 * day, "digest", 500]]);
    expect(two.now.status).toBe("fail");
    expect(two.now.detail).toBe(`${QUIET} · ardışık başarısız: digest 2/2`);
    const one = report([...base(), [3 * day, "digest", 500]]);
    expect(one.now.status).toBe("warn");
    expect(one.now.detail).toBe(`${QUIET} · ardışık başarısız: digest 1/2`);
    expect(report([...base(), [6 * day, "digest", 200]]).now.status).toBe("pass");
    // a later success clears it
    expect(report([...base(), [day, "digest", 200], [2 * day, "digest", 500], [3 * day, "digest", 500]]).now.status).toBe("pass");
  });

  it("several low-cadence routes: worst streak first, then by route; the detail carries route names and counts only", () => {
    const r = report([
      ...base(),
      [23, "fact-checks", 200],
      [45, "social", 500],
      [65, "social", 200],
      [3 * 24 * 60, "digest", 500],
      [2 * 24 * 60, "digest", 500],
    ]);
    expect(r.now.status).toBe("fail");
    expect(r.now.observed).toBe("2");
    expect(r.now.detail).toBe("son 30 dakikada 10 çalışma, başarısız yok · ardışık başarısız: digest 2/2, social 1/2");
    // names and counts: nothing but route names, digits, punctuation and the Turkish words
    expect(r.now.detail).toMatch(/^[a-zçğıöşü0-9 ,:/·-]+$/i);
  });

  it("a low-cadence failure shows even when the 30 minute window holds no run at all (the empty-window warn does not hide it)", () => {
    const r = report([[45, "fact-checks", 500], [105, "fact-checks", 500]]);
    expect(r.now.status).toBe("fail");
    expect(r.now.detail).toBe("son 30 dakikada cron rotası kaydı yok · ardışık başarısız: fact-checks 2/2");
    // 192: no run in the window and no silent route -> the plain warn
    expect(r.old.status).toBe("warn");
    // and with nothing at all it is still that plain warn, unchanged
    const none = report([]);
    expect(none.now.status).toBe("warn");
    expect(none.now.observed).toBe("");
    expect(none.now.detail).toBe("son 30 dakikada cron rotası kaydı yok");
    expect(none.now).toEqual(none.old);
  });

  it("a failing low-cadence route does not change any other row (rows 1-14 and 16-22 are 192's on every scenario above)", () => {
    for (const rows of [
      [...base(), [45, "fact-checks", 500], [105, "fact-checks", 500]],
      [...base(), [260, "fact-checks", 200]],
      [...base(), [3 * 24 * 60, "digest", 500], [2 * 24 * 60, "digest", 500]],
    ] as Row[][]) {
      expect(report(rows).othersEqual).toBe(true);
    }
  });

  it("left nothing behind (the fixture transactions were rolled back): no row of the fixture routes with a fixture minute offset", () => {
    const out = runPsql("select 'N|' || count(*) from public.ops_cron_route_runs where duration_ms = 120;");
    expect(lines(out, "N")).toEqual(["0"]);
  });
});
