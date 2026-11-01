import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 136 ("ops-heartbeat-app-side"), h12-ops-1.
//
// 2026-10-31/11-01: the headline cron answered 500 for 18+ hours (189 statement
// timeouts in postgres_logs, 16:10 to 10:30) and nothing alerted: ops_health_
// report() reads only the database (pg_cron, pg_net, ingest tables), and the
// Vercel cron routes leave no trace there. The disk sat at 6252 MB with no
// headroom check at all. 136 adds:
//   * public.ops_cron_route_runs + ops_cron_route_run_record(): an app-side outcome
//     record the cron routes write through withCronOutcome (src/lib/ops/), pruned
//     after 7 days by the pg_cron job ops-cron-route-runs-prune;
//   * ops_health_report() rows 15 (cron_route_failures_30m) and 16 (db_size_mb),
//     with rows 1-14 byte for byte 122's;
//   * ops_db_size_limits(): the warn/fail MB limits, changed with create or replace.
//
// This file pins: the table (RLS on, every anon/authenticated/public privilege
// revoked, the PG17-guarded MAINTAIN revoke), the four service_role-only SECURITY
// DEFINER functions, the cron job (by name, behind an exists guard), the ledger
// row, the byte-identity of rows 1-14 against 122, the two new rows' contracts and
// the function comment. The last block (opt-in, TAYF_PSQL) runs everything on a
// throwaway Postgres with 122 and then 136 applied, including the outage proof.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const MIGRATION_136 = resolve(MIGRATIONS_DIR, "136_ops_heartbeat_app_side.sql");
const MIGRATION_122 = resolve(MIGRATIONS_DIR, "122_ops_ingest_gaps.sql");
const MIGRATION_131 = resolve(MIGRATIONS_DIR, "131_ops_snapshots_archive_catchup.sql");
const WRAPPER_TS = resolve(ROOT, "src", "lib", "ops", "cron-route-outcome.ts");

const CHECK_15 = "cron_route_failures_30m";
const CHECK_16 = "db_size_mb";

const ROW_NAMES_16 = [
  "cron_failed_runs_30m",
  "edge_http_errors_30m",
  "ingest_cycles_30m",
  "ingest_fresh_iktidar_min",
  "ingest_fresh_bagimsiz_min",
  "ingest_fresh_muhalefet_min",
  "jev_shadow_last_run_min",
  "blindspot_veto_cron_min",
  "jev_alerts_unacked_72h",
  "dead_feeds",
  "net_response_heap_mb",
  "jev_shadow_cron_failures_30m",
  "sources_newly_dark",
  "ingest_gaps",
  CHECK_15,
  CHECK_16,
];

const CREATE_LINE = "create or replace function public.ops_health_report()";
const MARKER_15 = "-- 15. cron_route_failures_30m (migration 136).";
const MARKER_16 = "-- 16. db_size_mb (migration 136).";

const DETAIL_NONE = "son 30 dakikada cron rotası kaydı yok";
const DETAIL_FAILED_PREFIX = "son 30 dakikada başarısız: ";
const DETAIL_MISSING_TABLE = "ops_cron_route_runs yok";

const ROUTE_RE_SOURCE = "^[a-z0-9-]{1,40}$";

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** The `create or replace function public.<name>(...) ... $fn$ ... $fn$;` block. */
function functionBlock(sql: string, name: string): string {
  const re = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\([\\s\\S]*?\\$fn\\$[\\s\\S]*?\\$fn\\$\\s*;`,
    "i",
  );
  const m = sql.match(re);
  if (!m) throw new Error(`function ${name} not found`);
  return m[0];
}

/** Everything before `as $fn$`: signature, return shape, attributes. */
function header(block: string): string {
  return block.slice(0, block.search(/\bas\s+\$[a-z]*\$/i));
}

/** Only the SQL body between the $fn$ quotes. */
function body(block: string): string {
  const m = block.match(/\$fn\$([\s\S]*?)\$fn\$/);
  if (!m || m[1] === undefined) throw new Error("no $fn$ body");
  return m[1];
}

/** Comment-free, whitespace-collapsed form. */
function norm(sql: string): string {
  return stripSqlComments(sql).replace(/\s+/g, " ").trim();
}

function declareSection(fnBody: string): string {
  const m = /\bdeclare\b([\s\S]*?)\bbegin\b/i.exec(stripSqlComments(fnBody));
  if (!m) throw new Error("no declare section");
  return norm(m[1] as string);
}

function segments(fnBody: string): string[] {
  return stripSqlComments(fnBody).split(/check_name\s*:=/);
}

function segmentName(seg: string): string {
  const m = /^\s*'([a-z0-9_]+)'\s*;/i.exec(seg);
  return m ? (m[1] as string) : (/^\s*([^;]+);/.exec(seg)?.[1] ?? "").trim();
}

function segmentFor(fnBody: string, name: string): string {
  const seg = segments(fnBody)
    .slice(1)
    .find((s) => segmentName(s) === name);
  if (!seg) throw new Error(`segment ${name} not found`);
  return seg;
}

/** The text of the `comment on function public.<name>(<args>) is '...' '...';` statement (adjacent literals joined). */
function commentText(rawSql: string, name = "ops_health_report", args = ""): string {
  const head = new RegExp(`comment\\s+on\\s+function\\s+public\\.${name}\\(${args}\\)\\s+is\\s*`, "i");
  const start = rawSql.search(head);
  expect(start, `comment on function ${name}`).toBeGreaterThanOrEqual(0);
  let rest = rawSql.slice(start).replace(new RegExp(`^${head.source}`, "i"), "");
  let out = "";
  for (;;) {
    const m = /^'((?:[^']|'')*)'\s*/.exec(rest);
    if (!m) break;
    out += (m[1] as string).replace(/''/g, "'");
    rest = rest.slice(m[0].length);
  }
  expect(rest.startsWith(";"), "the comment statement ends right after its last literal").toBe(true);
  return out;
}

/** Function names created by the file, in order. */
function createdFunctions(code: string): string[] {
  return [...code.matchAll(/\bcreate\s+(?:or\s+replace\s+)?function\s+([a-z_.]+)\s*\(/gi)].map((m) => m[1] as string);
}

let sql = "";
let code = "";
let beginIdx = 0;
let sql122 = "";
let healthBlock = "";
let healthBody = "";
let codeOutsideFns = "";
let block122 = "";
let body122 = "";

beforeAll(() => {
  expect(existsSync(MIGRATION_136), "136_ops_heartbeat_app_side.sql must exist").toBe(true);
  sql = readFileSync(MIGRATION_136, "utf8");
  code = stripSqlComments(sql);
  beginIdx = sql.search(/^\s*begin\s*;/im);
  healthBlock = functionBlock(code, "ops_health_report");
  healthBody = body(healthBlock);
  codeOutsideFns = code.replace(/create\s+or\s+replace\s+function[\s\S]*?\$fn\$[\s\S]*?\$fn\$\s*;/gi, "");
  sql122 = readFileSync(MIGRATION_122, "utf8");
  block122 = functionBlock(stripSqlComments(sql122), "ops_health_report");
  body122 = body(block122);
});

describe("136 ledger, structure and header", () => {
  it("is one transaction: begin, ..., ledger insert, commit", () => {
    expect([...code.matchAll(/^\s*begin\s*;/gim)]).toHaveLength(1);
    expect([...code.matchAll(/^\s*commit\s*;/gim)]).toHaveLength(1);
    const ledger = code.search(/insert\s+into\s+supabase_migrations\.schema_migrations/i);
    expect(ledger).toBeGreaterThan(code.search(/grant\s+execute\s+on\s+function\s+public\.ops_health_report/i));
    expect(ledger).toBeLessThan(code.search(/^\s*commit\s*;/im));
    expect([...code.matchAll(/insert\s+into\s+supabase_migrations\.schema_migrations/gi)]).toHaveLength(1);
  });

  it("records itself as ('136', '136_ops_heartbeat_app_side') in the 095 pattern", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(version,\s*name\)\s*values\s*\(\s*'136'\s*,\s*'136_ops_heartbeat_app_side'\s*\)\s*on\s+conflict\s+do\s+nothing\s*;\s*commit\s*;\s*$/i,
    );
  });

  it("sanity: comment stripping is non-vacuous", () => {
    expect(sql.length).toBeGreaterThan(code.length);
    expect(sql).toMatch(/STEP 0/);
    expect(code).not.toMatch(/STEP 0/);
  });

  it("runs in the order table, record function, prune, limits, report, cron job, ledger", () => {
    const at = (re: RegExp) => code.search(re);
    const table = at(/create\s+table\s+if\s+not\s+exists\s+public\.ops_cron_route_runs\b/i);
    const record = at(/create\s+or\s+replace\s+function\s+public\.ops_cron_route_run_record\b/i);
    const prune = at(/create\s+or\s+replace\s+function\s+public\.ops_cron_route_runs_prune\b/i);
    const limits = at(/create\s+or\s+replace\s+function\s+public\.ops_db_size_limits\b/i);
    const report = at(/create\s+or\s+replace\s+function\s+public\.ops_health_report\b/i);
    const reportComment = at(/comment\s+on\s+function\s+public\.ops_health_report/i);
    const reportGrant = at(/grant\s+execute\s+on\s+function\s+public\.ops_health_report/i);
    const cron = at(/cron\.schedule\s*\(/i);
    const ledger = at(/insert\s+into\s+supabase_migrations\.schema_migrations/i);
    expect(table).toBeGreaterThan(0);
    expect(record).toBeGreaterThan(table);
    expect(prune).toBeGreaterThan(record);
    expect(limits).toBeGreaterThan(prune);
    expect(report).toBeGreaterThan(limits);
    expect(reportComment).toBeGreaterThan(report);
    expect(reportGrant).toBeGreaterThan(reportComment);
    expect(cron).toBeGreaterThan(reportGrant);
    expect(ledger).toBeGreaterThan(cron);
  });

  it("the header documents WHY, WHAT, Step 0 (prod fingerprint, sizes), both dry runs, the outage proof, deploy, verify and rollback", () => {
    const head = sql.slice(0, beginIdx);
    for (const section of ["WHY", "WHAT CHANGES", "STEP 0", "DRY RUNS (×2)", "DEPLOY", "VERIFY", "ROLLBACK"]) {
      expect(head, section).toContain(section);
    }
    expect(head).toMatch(/safe to re-apply/i);
    // the evidence
    expect(head).toContain("189");
    expect(head).toContain("6252");
    expect(head).toContain("jev_shadow_predictions");
    // Step 0: the deployed function is 122's (md5 and length recorded in 122's own header)
    expect(head).toContain("f6548a98c236a3b998fedf8c192e6b7c");
    expect(head).toContain("19,091");
    expect(head).toMatch(/Version 136 is free/i);
    expect(head).toContain("ops-cron-route-runs-prune");
    // dry runs and the outage proof
    expect(head).toContain("pg-aj-c");
    expect(head).toContain("55436");
    expect(head).toMatch(/INSERT 0 0/);
    expect(head).toMatch(/16 rows/);
    expect(head).toContain("headline 6/6");
    // rollback re-applies 122's block and drops what 136 added
    expect(head).toContain("122_ops_ingest_gaps.sql");
    expect(head).toMatch(/ledger row 136|version = '136'/i);
    expect(head).toMatch(/drop table public\.ops_cron_route_runs/i);
    expect(head).toMatch(/cron\.unschedule\('ops-cron-route-runs-prune'\)/);
    // the operator must know it needs the app deploy to start filling the table
    expect(head).toMatch(/CRON_SECRET/);
  });
});

describe("136 the outcome table", () => {
  it("creates public.ops_cron_route_runs with the exact columns and checks", () => {
    const n = norm(code);
    expect(n).toContain("create table if not exists public.ops_cron_route_runs (");
    for (const col of [
      "id bigint generated always as identity primary key",
      "ran_at timestamptz not null default now()",
      `route text not null check (route ~ '${ROUTE_RE_SOURCE}')`,
      "status smallint not null check (status between 100 and 599)",
      "ok boolean not null",
      "duration_ms integer not null check (duration_ms between 0 and 3600000)",
    ]) {
      expect(n, col).toContain(col);
    }
  });

  it("indexes ran_at (plain create index: the table is new and tiny, no PRE-BUILD step)", () => {
    expect(norm(code)).toContain(
      "create index if not exists ops_cron_route_runs_ran_at_idx on public.ops_cron_route_runs (ran_at);",
    );
    expect(code).not.toMatch(/\bconcurrently\b/i);
  });

  it("enables row level security and has no policy", () => {
    expect(norm(code)).toContain("alter table public.ops_cron_route_runs enable row level security;");
    expect(code).not.toMatch(/\bcreate\s+policy\b/i);
    expect(code).not.toMatch(/\bforce\s+row\s+level\b/i);
  });

  it("revokes every privilege on the table and its sequence from anon, authenticated and public", () => {
    const n = norm(code);
    expect(n).toContain("revoke all on public.ops_cron_route_runs from anon, authenticated, public;");
    expect(n).toContain("revoke all on sequence public.ops_cron_route_runs_id_seq from anon, authenticated, public;");
  });

  it("carries 131's PG17-guarded MAINTAIN revoke (the privilege does not exist before PG17)", () => {
    const n = norm(code);
    expect(n).toMatch(/do \$maint\$ begin if current_setting\('server_version_num'\)::int >= 170000 then/);
    expect(n).toContain("execute 'revoke maintain on public.ops_cron_route_runs from anon, authenticated';");
    // the same block as 131's, for 131's table
    const b131 = norm(readFileSync(MIGRATION_131, "utf8"));
    const blockOf = (s: string) => /do \$maint\$[\s\S]*?\$maint\$;/.exec(s)?.[0] ?? "";
    expect(blockOf(norm(code)).replace("ops_cron_route_runs", "ops_health_snapshots")).toBe(blockOf(b131));
  });

  it("nothing is granted on the table or the sequence at all", () => {
    expect(code).not.toMatch(/\bgrant\b[^;]*\b(on\s+(table\s+)?public\.ops_cron_route_runs|on\s+sequence)/i);
    expect(code).not.toMatch(/alter\s+default\s+privileges/i);
  });
});

describe("136 additive shape and privileges", () => {
  it("creates exactly one table and four functions, nothing is altered except the new table's RLS, nothing dropped", () => {
    expect([...code.matchAll(/\bcreate\s+table\b/gi)]).toHaveLength(1);
    expect(createdFunctions(code)).toEqual([
      "public.ops_cron_route_run_record",
      "public.ops_cron_route_runs_prune",
      "public.ops_db_size_limits",
      "public.ops_health_report",
    ]);
    const alters = [...code.matchAll(/\balter\s+[^;]*;/gi)].map((m) => m[0].replace(/\s+/g, " "));
    expect(alters).toEqual(["alter table public.ops_cron_route_runs enable row level security;"]);
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(codeOutsideFns).not.toMatch(/\b(delete|update|vacuum|analyze)\b/i);
    const inserts = [...codeOutsideFns.matchAll(/\binsert\s+into\s+([a-z_.]+)/gi)].map((m) => m[1]);
    expect(inserts).toEqual(["supabase_migrations.schema_migrations"]);
  });

  it("every grant is `grant execute on function ... to service_role`, exactly one per function; nothing reaches anon, authenticated or public", () => {
    const grants = [...code.matchAll(/\bgrant\b[^;]*;/gi)].map((m) => m[0].replace(/\s+/g, " "));
    expect(grants).toEqual([
      "grant execute on function public.ops_cron_route_run_record(text, integer, integer) to service_role;",
      "grant execute on function public.ops_cron_route_runs_prune() to service_role;",
      "grant execute on function public.ops_db_size_limits() to service_role;",
      "grant execute on function public.ops_health_report() to service_role;",
    ]);
    expect(code).not.toMatch(/\bgrant\b[^;]*\bto\b[^;]*\b(anon|authenticated|public)\b/i);
  });

  it("every function is revoked from public, anon and authenticated", () => {
    const n = norm(code);
    for (const sig of [
      "public.ops_cron_route_run_record(text, integer, integer)",
      "public.ops_cron_route_runs_prune()",
      "public.ops_db_size_limits()",
      "public.ops_health_report()",
    ]) {
      expect(n, sig).toContain(`revoke all on function ${sig} from public, anon, authenticated;`);
    }
  });

  it("every function is SECURITY DEFINER with search_path = '' (and ops_health_report keeps volatile plpgsql)", () => {
    for (const name of ["ops_cron_route_run_record", "ops_cron_route_runs_prune", "ops_db_size_limits", "ops_health_report"]) {
      const h = header(functionBlock(code, name));
      expect(h, name).toMatch(/security\s+definer/i);
      expect(h, name).toMatch(/set\s+search_path\s*=\s*''/i);
    }
    const h = header(healthBlock);
    expect(h).toMatch(/\bvolatile\b/i);
    expect(h).toMatch(/language\s+plpgsql/i);
  });

  it("keeps 122's function header and declare block exactly (rows 15 and 16 add no variable)", () => {
    expect(header(healthBlock).replace(/\s+/g, " ").trim()).toBe(header(block122).replace(/\s+/g, " ").trim());
    expect(healthBody).toMatch(/^\s*#variable_conflict use_column\b/);
    expect(declareSection(healthBody)).toBe(declareSection(body122));
  });
});

describe("136 the record RPC, the prune and the limits", () => {
  it("ops_cron_route_run_record(p_route text, p_status integer, p_duration_ms integer) returns void and inserts one row", () => {
    const block = functionBlock(code, "ops_cron_route_run_record");
    expect(norm(header(block))).toContain(
      "create or replace function public.ops_cron_route_run_record(p_route text, p_status integer, p_duration_ms integer) returns void language plpgsql security definer set search_path = ''",
    );
    const b = norm(body(block));
    // raises on a bad route or status
    expect(b).toContain(`p_route is null or p_route !~ '${ROUTE_RE_SOURCE}'`);
    expect(b).toContain("p_status is null or p_status < 100 or p_status > 599");
    expect([...b.matchAll(/\braise exception\b/g)]).toHaveLength(2);
    // clamps the duration, derives ok from the status
    expect(b).toContain("least(greatest(coalesce(p_duration_ms, 0), 0), 3600000)");
    expect(b).toContain("insert into public.ops_cron_route_runs (route, status, ok, duration_ms)");
    expect(b).toContain("p_status::smallint, p_status < 500");
    expect([...b.matchAll(/\binsert\b/g)]).toHaveLength(1);
  });

  it("ops_cron_route_runs_prune() deletes rows older than 7 days and returns the count", () => {
    const block = functionBlock(code, "ops_cron_route_runs_prune");
    expect(norm(header(block))).toContain(
      "create or replace function public.ops_cron_route_runs_prune() returns integer language plpgsql security definer set search_path = ''",
    );
    const b = norm(body(block));
    expect(b).toContain("delete from public.ops_cron_route_runs where ran_at < pg_catalog.now() - interval '7 days'");
    expect(b).toContain("get diagnostics v_n = row_count");
    expect(b).toContain("return v_n;");
    expect([...b.matchAll(/\bdelete\b/g)]).toHaveLength(1);
  });

  it("ops_db_size_limits() is an immutable constant (7000, 7600) with the 70%/85% comment", () => {
    const block = functionBlock(code, "ops_db_size_limits");
    const h = norm(header(block));
    expect(h).toContain(
      "create or replace function public.ops_db_size_limits() returns table (warn_mb numeric, fail_mb numeric) language sql immutable security definer set search_path = ''",
    );
    expect(norm(body(block))).toBe("select 7000::numeric, 7600::numeric");
    const comment = commentText(sql, "ops_db_size_limits");
    expect(comment).toContain("70%/85% of the provisioned disk; change with create or replace");
    expect(comment).toContain("7000 / 7600");
  });

  it("the route literal check is the same regular expression as the TypeScript wrapper's", () => {
    expect(existsSync(WRAPPER_TS), "src/lib/ops/cron-route-outcome.ts").toBe(true);
    const ts = readFileSync(WRAPPER_TS, "utf8");
    expect(ts).toContain(`/${ROUTE_RE_SOURCE}/`);
    expect(ts).toContain('"ops_cron_route_run_record"');
    for (const arg of ["p_route", "p_status", "p_duration_ms"]) expect(ts, arg).toContain(arg);
  });
});

describe("136 rows 1-14 are 122's, byte for byte", () => {
  it("the raw text from the create line through row 14's last `return next;` equals 122's (comments included)", () => {
    const from122 = sql122.slice(sql122.indexOf(CREATE_LINE));
    const end122 = from122.lastIndexOf("return next;") + "return next;".length;
    expect(from122.slice(end122).trim().startsWith("return;"), "122 ends with `return;` after row 14").toBe(true);
    const prefix122 = from122.slice(0, end122);
    expect(prefix122).toContain("-- 14. ingest_gaps (migration 122).");

    const from136 = sql.slice(sql.indexOf(CREATE_LINE, beginIdx));
    expect(from136.startsWith(CREATE_LINE)).toBe(true);
    expect(from136.slice(0, prefix122.length)).toBe(prefix122);
    // and row 15 follows directly
    expect(from136.slice(prefix122.length).trimStart().startsWith(MARKER_15)).toBe(true);
  });

  it("the literal check names are 122's followed by cron_route_failures_30m and db_size_mb, in that order", () => {
    const names = (b: string) => [...stripSqlComments(b).matchAll(/check_name\s*:=\s*'([a-z0-9_]+)'\s*;/gi)].map((m) => m[1]);
    expect(names(healthBody)).toEqual([...names(body122), CHECK_15, CHECK_16]);
    expect(names(healthBody)).toEqual(ROW_NAMES_16.filter((n) => !n.startsWith("ingest_fresh_")));
  });

  it("the segments of rows 1-13 are identical to 122's, and row 14 is too", () => {
    const s136 = segments(healthBody);
    const s122 = segments(body122);
    expect(s136).toHaveLength(s122.length + 2);
    for (let i = 0; i < s122.length - 1; i++) {
      expect(norm(s136[i] as string), `segment ${i}`).toBe(norm(s122[i] as string));
    }
    // row 14 is the last segment of 122 (it ends with `return; end`); in 136 it ends where row 15's comment begins
    const row14of136 = norm(s136[s122.length - 1] as string);
    expect(row14of136).toBe(norm(s122[s122.length - 1] as string).replace(/\s*return;\s*end$/, "").trim());
  });
});

describe("136 row 15: cron_route_failures_30m", () => {
  let segN = "";

  beforeAll(() => {
    segN = norm(segmentFor(healthBody, CHECK_15));
  });

  it("follows ingest_gaps and precedes db_size_mb", () => {
    const parts = segments(healthBody).slice(1);
    const names = parts.map(segmentName);
    expect(names.slice(-3)).toEqual(["ingest_gaps", CHECK_15, CHECK_16]);
    expect([...segN.matchAll(/\breturn next;/g)]).toHaveLength(1);
    expect(segN.endsWith("end; return next;")).toBe(true);
  });

  it("the marker comment names the migration, the table, the wrapper, the 189 timeouts and the fail rule", () => {
    const m = new RegExp(`${MARKER_15.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*`).exec(sql);
    expect(m, "row 15 marker").not.toBeNull();
    const comment = (m as RegExpExecArray)[0];
    for (const word of ["ops_cron_route_runs", "withCronOutcome", "189", "at least 2", "half", "maxDuration", "headline", "alerts-webhooks"]) {
      expect(comment, word).toContain(word);
    }
  });

  it("sets threshold 1, observed null and detail null up front", () => {
    expect(segN.startsWith("'cron_route_failures_30m'; threshold := 1; observed := null; detail := null;")).toBe(true);
  });

  it("a missing table is 'unknown' with the exact Turkish detail, not an error", () => {
    expect(segN).toContain("if pg_catalog.to_regclass('public.ops_cron_route_runs') is null then");
    expect(segN).toContain(`status := 'unknown'; detail := '${DETAIL_MISSING_TABLE}';`);
  });

  it("counts runs and failures (status >= 500) per route in the last 30 minutes of public.ops_cron_route_runs", () => {
    expect(segN).toContain("from public.ops_cron_route_runs x");
    expect(segN).toContain("x.ran_at >= v_now - interval '30 minutes'");
    expect(segN).toContain("group by x.route");
    expect(segN).toContain("pg_catalog.count(*) filter (where x.status >= 500) as failures");
    expect(segN).toContain("into v_total, v_n, v_zero, v_text from r;");
    expect(segN).toContain("v_n := null; v_total := null; v_zero := null; v_text := null;");
  });

  it("fails only when one route has at least 2 failures that are at least half of its runs; warns on any failure", () => {
    expect(segN).toContain("filter (where r.failures >= 2 and r.failures * 2 >= r.runs)");
    expect(segN).toContain(
      "status := case when v_zero >= 1 or v_active then 'fail' when v_n >= 1 or v_jobs >= 1 or v_total = 0 then 'warn' else 'pass' end;",
    );
    expect(segN).toContain("observed := v_n + v_jobs;");
  });

  it("a route that stops recording is stale: the two frequent routes carry a warn and a fail gap in minutes (h12-ops-1 review: a run Vercel kills at maxDuration writes no row)", () => {
    // the expected-routes list: headline */5 (warn 15 = three ticks, fail 30 = six) and alerts-webhooks */10 (25, 60)
    expect(segN).toContain("with e (route, warn_min, fail_min) as ( values ('headline'::text, 15::numeric, 30::numeric), ('alerts-webhooks'::text, 25::numeric, 60::numeric) )");
    // only routes that have recorded within the table's own 7 day retention can be stale
    expect(segN).toContain("join public.ops_cron_route_runs x on x.route = e.route");
    expect(segN).toContain("where x.ran_at >= v_now - interval '7 days'");
    expect(segN).toContain("group by e.route, e.warn_min, e.fail_min");
    expect(segN).toContain("extract(epoch from (v_now - pg_catalog.max(x.ran_at))) / 60.0 as age_min");
    // strictly above the gap: a row exactly warn_min old is still on time
    expect(segN).toContain("pg_catalog.count(*) filter (where s.age_min > s.warn_min)::numeric");
    expect(segN).toContain("pg_catalog.bool_or(s.age_min > s.fail_min)");
    expect(segN).toContain("into v_jobs, v_active, v_zone from s;");
    expect(segN).toContain("v_jobs := null; v_active := null; v_zone := null;");
    // named in the detail with the whole minutes since its newest row, oldest first
    expect(segN).toContain("s.route || ' ' || pg_catalog.floor(s.age_min)::text || ' dk'");
    expect(segN).toContain("order by s.age_min desc, s.route");
    expect(segN).toContain("'kayıt gelmiyor: ' || v_zone");
  });

  it("only the sub-hourly routes are listed: fact-checks (hourly), social (daytime only) and digest (weekly) would warn every night or week", () => {
    const list = /with e \(route, warn_min, fail_min\) as \( values (.*?) \)/.exec(segN)?.[1] ?? "";
    const names = [...list.matchAll(/\('([a-z0-9-]+)'::text/g)].map((m) => m[1]);
    expect(names).toEqual(["headline", "alerts-webhooks"]);
  });

  it("an empty window is a warn with observed null and the exact Turkish detail", () => {
    expect(segN).toContain(
      `if v_total = 0 and v_jobs = 0 then status := 'warn'; observed := null; detail := '${DETAIL_NONE}';`,
    );
    expect(segN).toContain("v_total := coalesce(v_total, 0); v_n := coalesce(v_n, 0); v_zero := coalesce(v_zero, 0);");
    expect(segN).toContain("v_jobs := coalesce(v_jobs, 0); v_active := coalesce(v_active, false);");
  });

  it("lists the failing routes worst first as '<route> <failures>/<runs>' and cuts at 500 characters", () => {
    expect(segN).toContain("r.route || ' ' || r.failures::text || '/' || r.runs::text");
    expect(segN).toContain("order by (r.failures >= 2 and r.failures * 2 >= r.runs) desc, r.failures desc, r.runs, r.route");
    expect(segN).toContain(") filter (where r.failures >= 1)");
    expect(segN).toContain(`substr(pg_catalog.concat_ws(' · ', case when v_n >= 1 then '${DETAIL_FAILED_PREFIX}' || v_text`);
    expect(segN).toContain(`when v_total = 0 then '${DETAIL_NONE}'`);
    expect(segN).toContain("else 'son 30 dakikada ' || v_total::text || ' çalışma, başarısız yok' end,");
    expect(segN).toContain("case when v_jobs >= 1 then 'kayıt gelmiyor: ' || v_zone end), 1, 500);");
  });

  it("answers 'unknown' with the first 200 characters of the error if the query fails", () => {
    expect(segN).toContain(
      "exception when others then status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200); end; return next;",
    );
  });

  it("qualifies every catalogue function and only reads", () => {
    for (const fn of ["count", "sum", "string_agg", "to_regclass", "max", "floor", "bool_or", "concat_ws"]) {
      const bare = new RegExp(`(?<![.\\w])${fn}\\s*\\(`, "g");
      expect([...segN.matchAll(bare)], fn).toEqual([]);
    }
    expect(segN).not.toMatch(/\b(insert|update|delete|truncate|execute)\b/i);
  });
});

describe("136 row 16: db_size_mb", () => {
  let segN = "";

  beforeAll(() => {
    segN = norm(segmentFor(healthBody, CHECK_16));
  });

  it("is the last check: it precedes `return;` and has exactly one `return next;`", () => {
    const parts = segments(healthBody).slice(1);
    expect(segmentName(parts[parts.length - 1] as string)).toBe(CHECK_16);
    expect(norm(healthBody).endsWith("return next; return; end")).toBe(true);
    expect(segN.endsWith("return next; return; end")).toBe(true);
    expect([...segN.matchAll(/\breturn next;/g)]).toHaveLength(1);
  });

  it("the marker comment names the migration, the 6252 MB reading and the limits function", () => {
    const m = new RegExp(`${MARKER_16.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*`).exec(sql);
    expect(m, "row 16 marker").not.toBeNull();
    const comment = (m as RegExpExecArray)[0];
    for (const word of ["6252", "ops_db_size_limits", "70%", "85%"]) {
      expect(comment, word).toContain(word);
    }
  });

  it("reads the limits from public.ops_db_size_limits() and uses the warn limit as the threshold", () => {
    expect(segN.startsWith("'db_size_mb'; threshold := null; observed := null; detail := null;")).toBe(true);
    expect(segN).toContain("select l.warn_mb, l.fail_mb into v_n, v_total from public.ops_db_size_limits() l;");
    expect(segN).toContain("threshold := v_n;");
  });

  it("observed is the database size in whole MB, from pg_database_size(current_database())", () => {
    expect(segN).toContain(
      "observed := round(pg_catalog.pg_database_size(pg_catalog.current_database()) / 1048576.0);",
    );
  });

  it("fails at or above the fail limit, warns at or above the warn limit", () => {
    expect(segN).toContain(
      "status := case when observed >= v_total then 'fail' when observed >= v_n then 'warn' else 'pass' end;",
    );
  });

  it("the detail names the size, both limits and the three biggest public relations", () => {
    expect(segN).toContain(
      "detail := 'veritabanı ' || observed::text || ' MB · uyarı ' || v_n::text || ' MB · kritik ' || v_total::text || ' MB · en büyük: ' || coalesce(v_text, '-');",
    );
    expect(segN).toContain("pg_catalog.pg_total_relation_size(c.oid)");
    expect(segN).toContain("n.nspname = 'public'");
    expect(segN).toContain("c.relkind in ('r', 'm')");
    expect(segN).toContain("limit 3");
    expect(segN).toContain("t.relname || ' ' || t.mb::text || ' MB'");
  });

  it("answers 'unknown' with the first 200 characters of the error if anything fails", () => {
    expect(segN).toContain(
      "exception when others then status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200); end; return next;",
    );
  });

  it("qualifies every catalogue function and only reads", () => {
    for (const fn of ["string_agg", "pg_database_size", "current_database", "pg_total_relation_size"]) {
      const bare = new RegExp(`(?<![.\\w])${fn}\\s*\\(`, "g");
      expect([...segN.matchAll(bare)], fn).toEqual([]);
    }
    expect(segN).not.toMatch(/\b(insert|update|delete|truncate|execute)\b/i);
  });
});

describe("136 pg_cron: ops-cron-route-runs-prune", () => {
  it("schedules by name at 17 4 * * * with a 60 s statement timeout, behind a pg_cron existence guard", () => {
    const n = norm(code);
    expect(n).toContain("from pg_catalog.pg_extension where extname = 'pg_cron'");
    expect(n).toMatch(/cron\.schedule\('ops-cron-route-runs-prune', '17 4 \* \* \*',/);
    expect(n).toContain("set statement_timeout = '60s'; select public.ops_cron_route_runs_prune();");
  });

  it("unschedules a job of that name first, only if it exists, and touches no other job", () => {
    const n = norm(code);
    expect(n).toContain("if exists (select 1 from cron.job where jobname = 'ops-cron-route-runs-prune') then perform cron.unschedule('ops-cron-route-runs-prune'); end if;");
    expect([...n.matchAll(/cron\.unschedule\(/g)]).toHaveLength(1);
    expect([...n.matchAll(/cron\.schedule\(/g)]).toHaveLength(1);
    expect(code).not.toMatch(/cron\.alter_job|update\s+cron\.job|delete\s+from\s+cron\.job/i);
    // every job name mentioned in a cron call is ours
    const outside = norm(codeOutsideFns);
    const names = [...outside.matchAll(/jobname\s*=\s*'([^']+)'|cron\.(?:un)?schedule\(\s*'([^']+)'/g)].map((m) => m[1] ?? m[2]);
    expect(new Set(names)).toEqual(new Set(["ops-cron-route-runs-prune"]));
  });

  it("with pg_cron missing it raises a notice and returns (local and CI databases)", () => {
    expect(norm(code)).toMatch(/raise notice '136: pg_cron missing[^']*'; return;/);
  });
});

describe("136 function comment", () => {
  let c122 = "";
  let c136 = "";
  beforeAll(() => {
    c122 = commentText(sql122);
    c136 = commentText(sql.slice(beginIdx));
  });

  it("is 122's text with the migration list and the row count updated: 16 fixed rows", () => {
    expect(c122).toContain("(migrations 077, 100, 103, 108, 114, 115, 119, 122): 14 fixed rows");
    expect(c136).toContain("(migrations 077, 100, 103, 108, 114, 115, 119, 122, 136): 16 fixed rows");
    expect(c136).not.toContain("14 fixed rows");
  });

  it("keeps everything 122 said, in order, and adds both new rows before ' status is one of'", () => {
    const expected122 = c122.replace("119, 122): 14 fixed rows", "119, 122, 136): 16 fixed rows");
    const [head, tail] = expected122.split(" status is one of") as [string, string];
    expect(head.endsWith("longest first).")).toBe(true);
    const keep = head.slice(0, -1); // up to and including "longest first)"
    expect(c136.startsWith(keep)).toBe(true);
    expect(c136.endsWith(` status is one of${tail}`)).toBe(true);
    const added = c136.slice(keep.length, c136.length - ` status is one of${tail}`.length);
    expect(added).toContain(CHECK_15);
    expect(added).toContain("ops_cron_route_runs");
    expect(added).toContain("30 min");
    expect(added).toMatch(/at least 2/);
    expect(added).toContain(CHECK_16);
    expect(added).toContain("pg_database_size");
    expect(added).toContain("ops_db_size_limits");
    expect(added.indexOf(CHECK_15)).toBeLessThan(added.indexOf(CHECK_16));
    // still read-only, still service_role only
    expect(c136).toContain("service_role only");
    expect(c136).toContain("docs/ops-heartbeat.md");
  });
});

// ---------------------------------------------------------------------------
// Live behaviour (opt-in): everything above against a throwaway Postgres with
// 122 and then 136 applied. TAYF_PSQL is the psql binary and PGHOST/PGPORT/
// PGUSER/PGDATABASE select the server. Every fixture sits in a transaction that
// is rolled back, except the idempotence test, which applies 136 once more.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))("136 against a live Postgres (122 and 136 applied)", () => {
  function psqlArgs(extra: string[]): string[] {
    return ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", ...extra];
  }
  function runPsql(input: string): string {
    return execFileSync(process.env.TAYF_PSQL as string, psqlArgs(["-f", "-"]), {
      input,
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8" },
      maxBuffer: 8 * 1024 * 1024,
    });
  }
  /** The stderr of a script that must fail. */
  function runPsqlError(input: string): string {
    try {
      execFileSync(process.env.TAYF_PSQL as string, psqlArgs(["-f", "-"]), {
        input,
        encoding: "utf8",
        env: { ...process.env, PGCLIENTENCODING: "UTF8" },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      return String((e as { stderr?: string }).stderr ?? e);
    }
    throw new Error("expected psql to fail");
  }

  /** A fixture: rows (minutes ago, route, status) in a clean table, then the two new report rows. */
  function report(rows: ReadonlyArray<readonly [number, string, number]> | null): Record<string, { status: string; observed: string; threshold: string; detail: string }> {
    const insert =
      rows === null
        ? ""
        : rows.length === 0
          ? ""
          : `insert into public.ops_cron_route_runs (ran_at, route, status, ok, duration_ms)
  select now() - m * interval '1 minute', r, s, s < 500, 120
    from (values ${rows.map(([m, r, s]) => `(${m}::numeric, '${r}'::text, ${s}::int)`).join(", ")}) as v(m, r, s);`;
    const out = runPsql(`
begin;
delete from public.ops_cron_route_runs;
${insert}
select 'row', check_name, status, coalesce(observed::text, ''), coalesce(threshold::text, ''), coalesce(detail, '')
  from public.ops_health_report() where check_name in ('${CHECK_15}', '${CHECK_16}');
rollback;
`);
    const result: Record<string, { status: string; observed: string; threshold: string; detail: string }> = {};
    for (const line of out.split("\n").filter((l) => l.startsWith("row|"))) {
      const [, name, status, observed, threshold, ...rest] = line.split("|");
      result[name as string] = { status: status as string, observed: observed as string, threshold: threshold as string, detail: rest.join("|") };
    }
    return result;
  }

  /** `n` runs of `route` with `failed` of them at 500, spread over the last 29 minutes. */
  function runs(route: string, n: number, failed: number, okStatus = 200): Array<[number, string, number]> {
    const out: Array<[number, string, number]> = [];
    for (let i = 0; i < n; i++) out.push([1 + i * Math.floor(28 / Math.max(n, 1)), route, i < failed ? 500 : okStatus]);
    return out;
  }

  it("the target database runs 136: the ledger row is there and the function carries both new rows", () => {
    expect(runPsql("select count(*) from supabase_migrations.schema_migrations where version = '136';").trim()).toBe("1");
    expect(
      runPsql(
        `select prosrc like '%${CHECK_15}%' and prosrc like '%${CHECK_16}%' from pg_proc where oid = 'public.ops_health_report()'::regprocedure;`,
      ).trim(),
    ).toBe("t");
  });

  it("rows 1-14 are identical to 122's function, run side by side in one transaction", () => {
    const block = functionBlock(sql122, "ops_health_report").replace(
      "create or replace function public.ops_health_report()",
      "create function pg_temp.ops_health_report_122()",
    );
    const out = runPsql(`
begin;
${block}
select 'same', (select array_agg(t::text) from (select * from pg_temp.ops_health_report_122()) t)
             = (select array_agg(t::text) from (select * from public.ops_health_report() limit 14) t),
       (select count(*) from pg_temp.ops_health_report_122());
rollback;
`);
    expect(out.trim().split("\n").filter((l) => l.startsWith("same|"))).toEqual(["same|t|14"]);
  });

  it("returns exactly 16 rows in order; the last two are cron_route_failures_30m and db_size_mb", () => {
    expect(runPsql("select count(*) from public.ops_health_report();").trim()).toBe("16");
    const names = runPsql("select check_name from public.ops_health_report();")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(names).toEqual(ROW_NAMES_16);
  });

  it("OUTAGE PROOF: six headline 500s inside 30 minutes fail, observed 6, 'headline 6/6'", () => {
    const r = report([[1, "headline", 500], [6, "headline", 500], [11, "headline", 500], [16, "headline", 500], [21, "headline", 500], [26, "headline", 500]])[CHECK_15]!;
    expect(r.status).toBe("fail");
    expect(r.observed).toBe("6");
    expect(r.threshold).toBe("1");
    expect(r.detail).toBe(`${DETAIL_FAILED_PREFIX}headline 6/6`);
    expect(r.detail).toContain("headline 6/6");
  });

  it("one failure of six warns; one of one warns; none of six passes", () => {
    const one6 = report(runs("headline", 6, 1))[CHECK_15]!;
    expect(one6.status).toBe("warn");
    expect(one6.observed).toBe("1");
    expect(one6.detail).toBe(`${DETAIL_FAILED_PREFIX}headline 1/6`);

    const one1 = report([[3, "social", 500]])[CHECK_15]!;
    expect(one1.status).toBe("warn");
    expect(one1.observed).toBe("1");
    expect(one1.detail).toBe(`${DETAIL_FAILED_PREFIX}social 1/1`);

    const none = report(runs("headline", 6, 0))[CHECK_15]!;
    expect(none.status).toBe("pass");
    expect(none.observed).toBe("0");
    expect(none.detail).toBe("son 30 dakikada 6 çalışma, başarısız yok");
  });

  it("an empty window warns with observed null and 'son 30 dakikada cron rotası kaydı yok'; so do rows older than 30 minutes", () => {
    const empty = report([])[CHECK_15]!;
    expect(empty.status).toBe("warn");
    expect(empty.observed).toBe("");
    expect(empty.detail).toBe(DETAIL_NONE);
    // rows of a route that is not on the stale list (social runs by day only, digest weekly) fall out of the window quietly
    const old = report([[31, "social", 500], [45, "social", 500], [59, "digest", 500]])[CHECK_15]!;
    expect(old.status).toBe("warn");
    expect(old.observed).toBe("");
    expect(old.detail).toBe(DETAIL_NONE);
    // rows beyond the 7 day retention are no history at all
    const ancient = report([[8 * 24 * 60, "headline", 200], [9 * 24 * 60, "alerts-webhooks", 200]])[CHECK_15]!;
    expect(ancient.status).toBe("warn");
    expect(ancient.observed).toBe("");
    expect(ancient.detail).toBe(DETAIL_NONE);
  });

  it("STALE PROOF (review of h12-ops-1): headline silent for 31 minutes while alerts-webhooks keeps writing 200s is a fail naming headline, not a pass", () => {
    // a run Vercel kills at maxDuration (60 s) never reaches finally/after(): no row, no failure to count
    const r = report([
      [31, "headline", 200], [36, "headline", 200], [41, "headline", 200],
      ...runs("alerts-webhooks", 3, 0),
    ])[CHECK_15]!;
    expect(r.status).toBe("fail");
    expect(r.observed).toBe("1");
    expect(r.threshold).toBe("1");
    expect(r.detail).toBe("son 30 dakikada 3 çalışma, başarısız yok · kayıt gelmiyor: headline 31 dk");
  });

  it("headline gap: on time to 15 minutes, warn above 15, fail above 30 (strictly above, so exactly 15 and exactly 30 are still the lower state)", () => {
    const at = (m: number) => report([[m, "headline", 200], ...runs("alerts-webhooks", 3, 0)])[CHECK_15]!;
    expect(at(15).status).toBe("pass");
    expect(at(15).observed).toBe("0");
    const w16 = at(16);
    expect(w16.status).toBe("warn");
    expect(w16.observed).toBe("1");
    expect(w16.detail).toContain("kayıt gelmiyor: headline 16 dk");
    expect(at(30).status).toBe("warn");
    const f31 = at(31);
    expect(f31.status).toBe("fail");
    expect(f31.detail).toContain("kayıt gelmiyor: headline 31 dk");
  });

  it("alerts-webhooks gap: on time to 25 minutes, warn above 25, fail above 60 while headline keeps writing", () => {
    const at = (m: number) => report([[m, "alerts-webhooks", 200], ...runs("headline", 6, 0)])[CHECK_15]!;
    expect(at(25).status).toBe("pass");
    expect(at(26).status).toBe("warn");
    expect(at(26).detail).toContain("kayıt gelmiyor: alerts-webhooks 26 dk");
    expect(at(60).status).toBe("warn");
    expect(at(61).status).toBe("fail");
    expect(at(61).detail).toContain("kayıt gelmiyor: alerts-webhooks 61 dk");
  });

  it("a stale route is found whether or not its old rows are failures, and whatever else the window holds (an empty window included)", () => {
    // empty window: every row is older than 30 minutes; the stale rule names headline instead of the bare 'no record' text
    const empty = report([[31, "headline", 500], [45, "headline", 500], [59, "headline", 500]])[CHECK_15]!;
    expect(empty.status).toBe("fail");
    expect(empty.observed).toBe("1");
    expect(empty.detail).toBe(`${DETAIL_NONE} · kayıt gelmiyor: headline 31 dk`);
    // an old 504 is still a silent route
    const old504 = report([[40, "headline", 504], ...runs("alerts-webhooks", 3, 0)])[CHECK_15]!;
    expect(old504.status).toBe("fail");
    expect(old504.detail).toBe("son 30 dakikada 3 çalışma, başarısız yok · kayıt gelmiyor: headline 40 dk");
  });

  it("a dead route stays flagged for the whole 7 day retention, not just 24 hours: headline last seen 3 days ago is still a fail", () => {
    const r = report([[3 * 24 * 60, "headline", 200], [4 * 24 * 60, "headline", 200], ...runs("alerts-webhooks", 3, 0)])[CHECK_15]!;
    expect(r.status).toBe("fail");
    expect(r.observed).toBe("1");
    expect(r.detail).toBe("son 30 dakikada 3 çalışma, başarısız yok · kayıt gelmiyor: headline 4320 dk");
  });

  it("failures and silence add up: headline 6/6 plus a silent alerts-webhooks fails with observed 7 and both parts in the detail", () => {
    const r = report([...runs("headline", 6, 6), [45, "alerts-webhooks", 200]])[CHECK_15]!;
    expect(r.status).toBe("fail");
    expect(r.observed).toBe("7");
    expect(r.detail).toBe(`${DETAIL_FAILED_PREFIX}headline 6/6 · kayıt gelmiyor: alerts-webhooks 45 dk`);
  });

  it("both silent: the longest silence is named first; a fail needs only one of them beyond its fail gap", () => {
    const r = report([[20, "headline", 200], [70, "alerts-webhooks", 200], [2, "social", 200]])[CHECK_15]!;
    expect(r.status).toBe("fail");
    expect(r.observed).toBe("2");
    expect(r.detail).toBe("son 30 dakikada 2 çalışma, başarısız yok · kayıt gelmiyor: alerts-webhooks 70 dk, headline 20 dk");
    // warn only: headline 20 (warn > 15, fail > 30) and alerts-webhooks 30 (warn > 25, fail > 60)
    const warn = report([[20, "headline", 200], [30, "alerts-webhooks", 200], [2, "social", 200]])[CHECK_15]!;
    expect(warn.status).toBe("warn");
    expect(warn.observed).toBe("2");
  });

  it("routes outside the list are never stale: fact-checks 3 h, social 12 h and digest 6 days old with fresh headline and alerts-webhooks rows pass", () => {
    const r = report([
      ...runs("headline", 6, 0),
      ...runs("alerts-webhooks", 3, 0),
      [180, "fact-checks", 200],
      [12 * 60, "social", 200],
      [6 * 24 * 60, "digest", 200],
    ])[CHECK_15]!;
    expect(r.status).toBe("pass");
    expect(r.observed).toBe("0");
    expect(r.detail).toBe("son 30 dakikada 9 çalışma, başarısız yok");
  });

  it("a route that has never recorded is not stale (nothing to compare with); the first rows after the deploy must not warn", () => {
    const r = report(runs("alerts-webhooks", 3, 0))[CHECK_15]!;
    expect(r.status).toBe("pass");
    expect(r.detail).toBe("son 30 dakikada 3 çalışma, başarısız yok");
  });

  it("the fail rule is 'at least 2 failures AND at least half of that route's runs': 2/4 fails, 2/5 and 1/2 warn", () => {
    expect(report(runs("headline", 4, 2))[CHECK_15]!.status).toBe("fail");
    expect(report(runs("headline", 5, 2))[CHECK_15]!.status).toBe("warn");
    expect(report(runs("headline", 2, 1))[CHECK_15]!.status).toBe("warn");
    expect(report(runs("headline", 2, 2))[CHECK_15]!.status).toBe("fail");
  });

  it("another route's healthy runs do not dilute a failing route; the detail lists the failing routes worst first", () => {
    const r = report([
      ...runs("headline", 6, 6),
      ...runs("social", 2, 1),
      ...runs("digest", 3, 0),
      ...runs("fact-checks", 4, 0, 204),
    ])[CHECK_15]!;
    expect(r.status).toBe("fail");
    expect(r.observed).toBe("7");
    expect(r.detail).toBe(`${DETAIL_FAILED_PREFIX}headline 6/6, social 1/2`);
  });

  it("only status >= 500 counts: 400, 401, 429 and 499 are not failures; 500 and 599 are", () => {
    const okish = report([[1, "headline", 400], [2, "headline", 401], [3, "headline", 429], [4, "headline", 499]])[CHECK_15]!;
    expect(okish.status).toBe("pass");
    expect(okish.observed).toBe("0");
    const bad = report([[1, "headline", 500], [2, "headline", 599]])[CHECK_15]!;
    expect(bad.status).toBe("fail");
    expect(bad.observed).toBe("2");
  });

  it("db_size_mb passes on a small database, warns at the warn limit and fails at the fail limit (limits replaced inside a rolled-back transaction)", () => {
    const pass = report(null)[CHECK_16]!;
    expect(pass.status).toBe("pass");
    expect(pass.threshold).toBe("7000");
    expect(pass.detail).toMatch(/^veritabanı \d+ MB · uyarı 7000 MB · kritik 7600 MB · en büyük: .+ \d+ MB/);

    const withLimits = (warn: number, fail: number) => {
      const out = runPsql(`
begin;
create or replace function public.ops_db_size_limits() returns table (warn_mb numeric, fail_mb numeric)
  language sql immutable security definer set search_path = '' as $f$ select ${warn}::numeric, ${fail}::numeric $f$;
select 'row', status, coalesce(observed::text, ''), coalesce(threshold::text, ''), detail from public.ops_health_report() where check_name = '${CHECK_16}';
rollback;
`);
      const [, status, observed, threshold, ...rest] = (out.split("\n").find((l) => l.startsWith("row|")) as string).split("|");
      return { status, observed, threshold, detail: rest.join("|") };
    };
    const failed = withLimits(1, 2);
    expect(failed.status).toBe("fail");
    expect(failed.threshold).toBe("1");
    expect(failed.detail).toMatch(/^veritabanı \d+ MB · uyarı 1 MB · kritik 2 MB · en büyük: /);
    expect(withLimits(1, 1000000).status).toBe("warn");
    // restored by the rollback
    expect(runPsql("select warn_mb, fail_mb from public.ops_db_size_limits();").trim()).toBe("7000|7600");
  });

  it("db_size_mb names at most three relations, biggest first, all from schema public", () => {
    const detail = report(null)[CHECK_16]!.detail;
    const list = detail.split(" · en büyük: ")[1] as string;
    const items = list.split(", ");
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(3);
    const sizes = items.map((i) => Number(/ (\d+) MB$/.exec(i)?.[1]));
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
  });

  it("anon, authenticated and public cannot execute any of the four functions; service_role can", () => {
    const sigs = [
      "public.ops_cron_route_run_record(text, integer, integer)",
      "public.ops_cron_route_runs_prune()",
      "public.ops_db_size_limits()",
      "public.ops_health_report()",
    ];
    for (const sig of sigs) {
      expect(
        runPsql(
          `select has_function_privilege('anon', '${sig}', 'execute'), has_function_privilege('authenticated', '${sig}', 'execute'), has_function_privilege('service_role', '${sig}', 'execute');`,
        ).trim(),
        sig,
      ).toBe("f|f|t");
    }
    expect(
      runPsql(
        `select count(*) from pg_proc p, lateral aclexplode(p.proacl) a where p.proname in ('ops_cron_route_run_record', 'ops_cron_route_runs_prune', 'ops_db_size_limits') and a.grantee = 0;`,
      ).trim(),
    ).toBe("0");
    expect(
      runPsql(
        `select bool_and(prosecdef), bool_and(proconfig = array['search_path=""']::text[]) from pg_proc where proname in ('ops_cron_route_run_record', 'ops_cron_route_runs_prune', 'ops_db_size_limits', 'ops_health_report') and pronamespace = 'public'::regnamespace;`,
      ).trim(),
    ).toBe("t|t");
  });

  it("anon and authenticated hold no privilege at all on the table or its sequence; RLS is on", () => {
    const privs = ["select", "insert", "update", "delete", "truncate", "references", "trigger"];
    for (const role of ["anon", "authenticated"]) {
      const probes = privs.map((p) => `has_table_privilege('${role}', 'public.ops_cron_route_runs', '${p}')`).join(", ");
      expect(runPsql(`select ${probes};`).trim(), role).toBe(privs.map(() => "f").join("|"));
      expect(
        runPsql(
          `select has_sequence_privilege('${role}', 'public.ops_cron_route_runs_id_seq', 'usage'), has_sequence_privilege('${role}', 'public.ops_cron_route_runs_id_seq', 'select'), has_sequence_privilege('${role}', 'public.ops_cron_route_runs_id_seq', 'update');`,
        ).trim(),
        role,
      ).toBe("f|f|f");
    }
    expect(
      runPsql(
        `select count(*) from pg_class c, lateral aclexplode(c.relacl) a where c.oid in ('public.ops_cron_route_runs'::regclass, 'public.ops_cron_route_runs_id_seq'::regclass) and a.grantee = 0;`,
      ).trim(),
    ).toBe("0");
    expect(runPsql("select relrowsecurity from pg_class where oid = 'public.ops_cron_route_runs'::regclass;").trim()).toBe("t");
  });

  it("the record RPC stores route, status, ok and the clamped duration", () => {
    const out = runPsql(`
begin;
delete from public.ops_cron_route_runs;
select public.ops_cron_route_run_record('headline', 200, 37);
select public.ops_cron_route_run_record('headline', 500, -5);
select public.ops_cron_route_run_record('fact-checks', 499, 99999999);
select public.ops_cron_route_run_record('social', 503, null);
select 'r', route, status, ok, duration_ms from public.ops_cron_route_runs order by id;
rollback;
`);
    expect(out.split("\n").filter((l) => l.startsWith("r|"))).toEqual([
      "r|headline|200|t|37",
      "r|headline|500|f|0",
      "r|fact-checks|499|t|3600000",
      "r|social|503|f|0",
    ]);
  });

  it("the record RPC raises on a bad route or status", () => {
    for (const call of [
      "('Bad Route', 200, 1)",
      "('', 200, 1)",
      "(null, 200, 1)",
      "('a/b', 200, 1)",
      "('headline', 99, 1)",
      "('headline', 600, 1)",
      "('headline', null, 1)",
    ]) {
      const err = runPsqlError(`select public.ops_cron_route_run_record${call};`);
      expect(err, call).toMatch(/ops_cron_route_run_record: invalid (route|status)/);
    }
    expect(runPsql("select count(*) from public.ops_cron_route_runs where route in ('Bad Route', '', 'a/b');").trim()).toBe("0");
  });

  it("the prune deletes rows older than 7 days and nothing newer", () => {
    const out = runPsql(`
begin;
delete from public.ops_cron_route_runs;
insert into public.ops_cron_route_runs (ran_at, route, status, ok, duration_ms)
  values (now() - interval '8 days', 'headline', 200, true, 1),
         (now() - interval '7 days 1 minute', 'headline', 200, true, 1),
         (now() - interval '6 days 23 hours', 'headline', 200, true, 1),
         (now(), 'headline', 500, false, 1);
select 'pruned', public.ops_cron_route_runs_prune();
select 'left', count(*) from public.ops_cron_route_runs;
rollback;
`);
    expect(out.split("\n").filter((l) => l.startsWith("pruned|") || l.startsWith("left|"))).toEqual(["pruned|2", "left|2"]);
  });

  it("the cron job is scheduled once at 17 4 * * * when pg_cron is present", () => {
    const has = runPsql("select to_regclass('cron.job') is not null;").trim();
    if (has !== "t") return;
    expect(runPsql("select schedule from cron.job where jobname = 'ops-cron-route-runs-prune';").trim()).toBe("17 4 * * *");
    expect(runPsql("select count(*) from cron.job where jobname = 'ops-cron-route-runs-prune';").trim()).toBe("1");
  });

  it("applying 136 again is a no-op: no error, one ledger row, the same function text, one cron job", () => {
    const before = runPsql(
      "select md5(prosrc) from pg_proc where oid = 'public.ops_health_report()'::regprocedure;",
    ).trim();
    execFileSync(process.env.TAYF_PSQL as string, psqlArgs(["-f", MIGRATION_136]), {
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8" },
    });
    expect(runPsql("select count(*) from supabase_migrations.schema_migrations where version = '136';").trim()).toBe("1");
    expect(runPsql("select md5(prosrc) from pg_proc where oid = 'public.ops_health_report()'::regprocedure;").trim()).toBe(before);
    expect(runPsql("select count(*) from public.ops_health_report();").trim()).toBe("16");
    if (runPsql("select to_regclass('cron.job') is not null;").trim() === "t") {
      expect(runPsql("select count(*) from cron.job where jobname = 'ops-cron-route-runs-prune' and active;").trim()).toBe("1");
    }
  });
});
