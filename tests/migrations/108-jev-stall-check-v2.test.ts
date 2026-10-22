import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { BIAS_TO_ZONE, ZONE_KEYS } from "../../supabase/functions/_shared/cluster/blindspot";
import { VOTING_SOURCE_KINDS } from "../../supabase/functions/_shared/cluster/source-kind";
import {
  JevDbUnavailableError,
  JevDeadlineError,
  jevShadowErrorEnvelope,
  requestDeadlineMs,
} from "../../supabase/functions/_shared/jev.ts";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 108 ("jev-stall-check-v2").
//
// 2026-10-22 stall: jev-shadow's pg_net requests timed out (rows 329690 and
// 329711 have timed_out = true and a NULL status) and the function kept
// closing zero-call partial runs (3622, 3623). Those runs advanced
// max(finished_at), so jev_shadow_last_run_min (check 5) and the cron-failure
// row (check 12) both read pass during the stall. 108 re-creates
// ops_health_report() with 103's body byte for byte except checks 5,
// jev_alerts_unacked_72h and 12, and reschedules the jev-shadow cron job with a
// 120 s pg_net timeout and an enqueued_at body field (the function derives a
// poke-bounded deadline from it).
//
// This file pins that every other segment of the body survived unchanged
// (modulo comments/whitespace), what the three changed checks now say, that
// the function stays read-only, and the shape of the cron reschedule block.
// It is modelled on 103-jev-shadow-stall-check.test.ts.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "supabase", "migrations");
const MIGRATION_108 = resolve(MIGRATIONS_DIR, "108_jev_stall_check_v2.sql");
const MIGRATION_103 = resolve(MIGRATIONS_DIR, "103_jev_shadow_stall_check.sql");
const MIGRATION_061 = resolve(MIGRATIONS_DIR, "061_jev_shadow.sql");

const CHANGED_CHECKS = ["jev_shadow_last_run_min", "jev_alerts_unacked_72h", "jev_shadow_cron_failures_30m"];
const CHECK_5 = "jev_shadow_last_run_min";
const CHECK_ALERTS = "jev_alerts_unacked_72h";
const CHECK_12 = "jev_shadow_cron_failures_30m";

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
  const idx = block.search(/\bas\s+\$fn\$/i);
  return block.slice(0, idx);
}

/** Only the SQL body between the $fn$ quotes. */
function body(block: string): string {
  const m = block.match(/\$fn\$([\s\S]*?)\$fn\$/);
  if (!m || m[1] === undefined) throw new Error("no $fn$ body");
  return m[1];
}

/** Comment-free, whitespace-collapsed form, for byte-for-byte preservation checks. */
function norm(sql: string): string {
  return stripSqlComments(sql).replace(/\s+/g, " ").trim();
}

function literalCheckNames(fnBody: string): string[] {
  return [...stripSqlComments(fnBody).matchAll(/check_name\s*:=\s*'([a-z0-9_]+)'\s*;/gi)].map(
    (m) => m[1] as string,
  );
}

/** The declare section of a plpgsql body, whitespace-normalised. */
function declareSection(fnBody: string): string {
  const m = /\bdeclare\b([\s\S]*?)\bbegin\b/i.exec(stripSqlComments(fnBody));
  if (!m) throw new Error("no declare section");
  return norm(m[1] as string);
}

/** A function body split at every `check_name :=`; index 0 is the preamble. */
function segments(fnBody: string): string[] {
  return stripSqlComments(fnBody).split(/check_name\s*:=/);
}

/** The check a segment belongs to: its literal name, or the loop expression. */
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

/** Every `execute $q$ ... $q$` string in a block, in source order. */
function executeQueries(block: string): string[] {
  return [...block.matchAll(/execute\s+\$q\$([\s\S]*?)\$q\$/gi)].map((m) => m[1] as string);
}

/** Each top-level `do $$ ... $$;` block of a file. */
function doBlocks(sql: string): string[] {
  return [...sql.matchAll(/\bdo\s+\$\$([\s\S]*?)\$\$\s*;/gi)].map((m) => m[1] as string);
}

let sql = "";
let code = "";
let healthBlock = "";
let healthBody = "";
let healthCode = "";
let sql103 = "";
let body103 = "";
let code103 = "";
let sql061 = "";

beforeAll(() => {
  sql = readFileSync(MIGRATION_108, "utf8");
  code = stripSqlComments(sql);
  healthBlock = functionBlock(code, "ops_health_report");
  healthBody = body(healthBlock);
  healthCode = stripSqlComments(healthBody);
  sql103 = readFileSync(MIGRATION_103, "utf8");
  code103 = stripSqlComments(sql103);
  body103 = body(functionBlock(code103, "ops_health_report"));
  sql061 = readFileSync(MIGRATION_061, "utf8");
});

describe("108 ledger, structure and header", () => {
  it("is wrapped in exactly one begin/commit, with the ledger insert last", () => {
    expect([...code.matchAll(/^\s*begin\s*;/gim)]).toHaveLength(1);
    expect([...code.matchAll(/^\s*commit\s*;/gim)]).toHaveLength(1);
    const ledger = code.search(/insert\s+into\s+supabase_migrations\.schema_migrations/i);
    expect(ledger).toBeGreaterThan(code.search(/grant\s+execute\s+on\s+function/i));
    expect(ledger).toBeGreaterThan(code.indexOf("cron.schedule("));
    expect(ledger).toBeLessThan(code.search(/^\s*commit\s*;/im));
    // nothing but the commit follows the ledger insert
    const afterLedger = code.slice(ledger).replace(/^[\s\S]*?on\s+conflict\s+do\s+nothing\s*;/i, "");
    expect(afterLedger.trim()).toBe("commit;");
    expect([...code.matchAll(/insert\s+into\s+supabase_migrations\.schema_migrations/gi)]).toHaveLength(1);
  });

  it("records itself as version '108' in the 095 pattern", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(version,\s*name\)\s*values\s*\(\s*'108'\s*,\s*'108_jev_stall_check_v2'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("sanity: comment stripping is non-vacuous", () => {
    expect(sql.length).toBeGreaterThan(code.length);
  });

  it("the header documents the stall evidence, the re-creation rule, the decision, rollback and idempotence", () => {
    const head = sql.slice(0, sql.search(/^\s*begin\s*;/im));
    // db-2: the pg_net timeouts and the zero-call partial runs
    expect(head).toMatch(/db-2/);
    expect(head).toMatch(/329690/);
    expect(head).toMatch(/329711/);
    expect(head).toMatch(/timed_out\s*=\s*true/);
    expect(head).toMatch(/status NULL/i);
    expect(head).toMatch(/3622/);
    expect(head).toMatch(/3623/);
    expect(head).toMatch(/max\(finished_at\)/);
    expect(head).toMatch(/check 12/i);
    expect(head).toMatch(/check 5/i);
    // db-3: resolved alerts
    expect(head).toMatch(/db-3/);
    expect(head).toMatch(/41 of the 42/);
    expect(head).toMatch(/resolved/i);
    // db-1: NULL notes and the pg_net timeout shorter than the run
    expect(head).toMatch(/db-1/);
    expect(head).toMatch(/notes were NULL/i);
    expect(head).toMatch(/60 s/);
    expect(head).toMatch(/120 s/);
    expect(head).toMatch(/enqueued_at/);
    // what is unchanged, and the decisions
    expect(head).toMatch(/103/);
    expect(head).toMatch(/verbatim/i);
    expect(head).toMatch(/jev_alerts_unacked_72h/);
    expect(head).toMatch(/budget_exceeded/);
    expect(head).toMatch(/monthly cap/i);
    // rollback and idempotence
    expect(head).toMatch(/Rollback/i);
    expect(head).toMatch(/061/);
    expect(head).toMatch(/ledger row 108/i);
    expect(head).toMatch(/safe to re-apply/i);
    // no new table, so no grant-revoke block
    expect(head).toMatch(/no new tables?/i);
    expect(head).toMatch(/grant-revoke block/i);
  });

  it("only re-creates ops_health_report and reschedules one cron job: no table, no drop, no data written", () => {
    expect(code).not.toMatch(/\bcreate\s+table\b/i);
    expect(code).not.toMatch(/\balter\s+table\b/i);
    expect(code).not.toMatch(/\bdrop\s+(table|function|schema|extension)\b/i);
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bvacuum\b/i);
    expect(code).not.toMatch(/\binsert\s+into\s+public\./i);
    expect(code).not.toMatch(/\bupdate\s+public\./i);
    expect(code).not.toMatch(/jev_alerts\s*\(/i);
    expect(code.match(/cron\.schedule\s*\(/gi)).toHaveLength(1);
    expect(code.match(/cron\.unschedule\s*\(/gi)).toHaveLength(1);
    const creates = [...code.matchAll(/create\s+or\s+replace\s+function\s+(public\.[a-z_]+)/gi)].map((m) => m[1]);
    expect(creates).toEqual(["public.ops_health_report"]);
  });
});

describe("108 ops_health_report: signature, grants and safety are unchanged", () => {
  it("the function header is identical to 103's (plpgsql volatile SECURITY DEFINER, empty search_path, same columns)", () => {
    expect(norm(header(healthBlock))).toBe(norm(header(functionBlock(code103, "ops_health_report"))));
    expect(header(healthBlock)).toMatch(
      /function\s+public\.ops_health_report\s*\(\s*\)[\s\S]*?language\s+plpgsql[\s\S]{0,40}volatile[\s\S]{0,40}security\s+definer[\s\S]{0,40}set\s+search_path\s*=\s*''/i,
    );
  });

  it("declares #variable_conflict use_column and 103's variables plus exactly v_zero and v_tmo", () => {
    expect(healthCode).toMatch(/#variable_conflict\s+use_column/i);
    expect(declareSection(healthBody)).toBe(`${declareSection(body103)} v_zero numeric; v_tmo numeric;`);
  });

  it("revokes from public/anon/authenticated and grants only to service_role, and that is the only grant in the file", () => {
    expect(code).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.ops_health_report\(\)\s+from\s+public,\s*anon,\s*authenticated\s*;/i,
    );
    const grants = [...code.matchAll(/grant\s+execute\s+on\s+function\s+public\.ops_health_report[^;]*;/gi)];
    expect(grants).toHaveLength(1);
    expect(grants[0]?.[0]).toMatch(/\(\)\s+to\s+service_role\s*;/i);
    const allGrants = [...code.matchAll(/(^|;)\s*grant\b[^;]*;/gi)];
    expect(allGrants).toHaveLength(1);
    for (const g of allGrants) {
      expect(g[0]).not.toMatch(/\bto\b[^;]*\b(anon|authenticated|public)\b/i);
      expect(g[0]).not.toMatch(/\b(insert|update|delete|truncate|maintain)\b/i);
    }
    // no new table, so no table-grant revoke block is needed
    expect(code).not.toMatch(/\brevoke\b[^;]*\bon\s+table\b/i);
  });

  it("is read-only: no writes, truncate, cron.schedule, return_message or cron job-command access in the function", () => {
    expect(healthCode).not.toMatch(/\binsert\b/i);
    expect(healthCode).not.toMatch(/\bupdate\b/i);
    expect(healthCode).not.toMatch(/\bdelete\b/i);
    expect(healthCode).not.toMatch(/\btruncate\b/i);
    expect(healthCode).not.toMatch(/\bcron\.(un)?schedule\s*\(/i);
    expect(healthCode).not.toMatch(/\bcommand\b/i);
    expect(healthCode).not.toMatch(/return_message/i);
    expect(sql).not.toMatch(/return_message/i);
  });

  it("cron.* / net.* relations are reached only through to_regclass or EXECUTE strings", () => {
    expect(healthCode).toMatch(/to_regclass\(\s*'cron\.job_run_details'\s*\)/i);
    expect(healthCode).toMatch(/to_regclass\(\s*'cron\.job'\s*\)/i);
    expect(healthCode).toMatch(/to_regclass\(\s*'net\._http_response'\s*\)/i);
    const withoutToRegclass = healthCode.replace(/to_regclass\(\s*'[^']*'\s*\)/gi, "to_regclass(...)");
    const withoutExecute = withoutToRegclass.replace(/execute\s+\$q\$[\s\S]*?\$q\$/gi, "EXECUTED");
    expect(withoutExecute).not.toMatch(/\bcron\.(job|job_run_details)\b/i);
    expect(withoutExecute).not.toMatch(/\bnet\._http_response\b/i);
  });
});

describe("108 ops_health_report: only the three named checks differ from 103", () => {
  it("the literal check_name assignments are 103's, in the same order (12 rows, same positions)", () => {
    expect(literalCheckNames(healthBody)).toEqual(literalCheckNames(body103));
    expect(literalCheckNames(healthBody)).toHaveLength(9);
    expect(healthCode).toMatch(/check_name\s*:=\s*'ingest_fresh_'\s*\|\|\s*v_zone\s*\|\|\s*'_min'/i);
  });

  it("the function comment lists all 12 rows in order and says (migrations 077, 100, 103, 108): 12 fixed rows", () => {
    const comment = /comment\s+on\s+function\s+public\.ops_health_report\(\)\s+is([\s\S]*?);\s*\n/i.exec(sql);
    expect(comment).not.toBeNull();
    const text = (comment as RegExpExecArray)[1] as string;
    expect(text).toMatch(/\(migrations 077, 100, 103, 108\): 12 fixed rows/);
    const expected = [
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
    ];
    const positions = expected.map((n) => text.indexOf(n));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // the new semantics are described, not just named
    expect(text).toMatch(/budget_exceeded/);
    expect(text).toMatch(/calls > 0|made a call|at least one call/i);
    expect(text).toMatch(/resolved/i);
    expect(text).toMatch(/zero-call|zero calls/i);
    expect(text).toMatch(/timed out|timed_out|timeout/i);
    expect(text).toMatch(/warn 1, fail >= 2/);
    expect(text).toMatch(/jev-cluster-audit/);
    expect(text).toMatch(/jev-regression-weekly/);
    expect(text).toMatch(/never reads any potentially secret-bearing pg_cron job field/);
    expect(text).toMatch(/service_role only/);
  });

  it("every segment of the body, split at `check_name :=`, is 103's after norm, except the three changed checks", () => {
    const a = segments(healthBody);
    const b = segments(body103);
    expect(a).toHaveLength(b.length);
    // the preamble differs only by the two new variables
    expect(norm(a[0] as string).replace(" v_zero numeric; v_tmo numeric;", "")).toBe(norm(b[0] as string));
    const differing: string[] = [];
    for (let i = 1; i < a.length; i++) {
      const nameA = segmentName(a[i] as string);
      expect(nameA).toBe(segmentName(b[i] as string));
      if (norm(a[i] as string) !== norm(b[i] as string)) differing.push(nameA);
    }
    expect(differing).toEqual(CHANGED_CHECKS);
  });

  it("the unchanged checks carry real content (the segment comparison is not vacuous)", () => {
    for (const name of [
      "cron_failed_runs_30m",
      "edge_http_errors_30m",
      "blindspot_veto_cron_min",
      "dead_feeds",
      "net_response_heap_mb",
    ]) {
      expect(norm(segmentFor(healthBody, name)).length).toBeGreaterThan(300);
    }
    expect(norm(segmentFor(healthBody, "net_response_heap_mb"))).toBe(
      norm(segmentFor(body103, "net_response_heap_mb")),
    );
  });
});

describe("108 jev_shadow_last_run_min (check 5)", () => {
  let seg = "";
  beforeAll(() => {
    seg = norm(segmentFor(healthBody, CHECK_5));
  });

  it("reads max(finished_at) only over ok / budget_exceeded runs or runs that made a call", () => {
    expect(seg).toContain(
      "select pg_catalog.max(r.finished_at) into v_last from public.jev_shadow_runs r where r.started_at >= v_now - interval '2 days' and (r.status in ('ok', 'budget_exceeded') or r.calls > 0);",
    );
  });

  it("keeps the thresholds (fail > 30, warn > 20, threshold 30) and the cron-kill-switch skip", () => {
    expect(seg).toContain("threshold := 30;");
    expect(seg).toMatch(/case when observed > 30 then 'fail' when observed > 20 then 'warn' else 'pass' end/);
    expect(seg).toContain("status := 'skip'; detail := 'jev-shadow cron işi pasif';");
  });

  it("says so in Turkish when there is no ok or calling run in 2 days", () => {
    expect(seg).toContain("status := 'fail'; detail := 'son 2 günde ok ya da çağrılı koşu yok';");
    expect(seg).not.toContain("son 2 günde biten koşu yok");
  });

  it("is 103's check 5 with exactly the query and the detail replaced", () => {
    const old = norm(segmentFor(body103, CHECK_5))
      .replace(
        "select pg_catalog.max(r.finished_at) into v_last from public.jev_shadow_runs r where r.started_at >= v_now - interval '2 days';",
        "select pg_catalog.max(r.finished_at) into v_last from public.jev_shadow_runs r where r.started_at >= v_now - interval '2 days' and (r.status in ('ok', 'budget_exceeded') or r.calls > 0);",
      )
      .replace("son 2 günde biten koşu yok", "son 2 günde ok ya da çağrılı koşu yok");
    expect(seg).toBe(old);
  });
});

describe("108 jev_alerts_unacked_72h", () => {
  let seg = "";
  beforeAll(() => {
    seg = norm(segmentFor(healthBody, CHECK_ALERTS));
  });

  it("counts only OPEN unacked alerts older than 72 h, and still totals every unacked alert", () => {
    expect(seg).toContain(
      "select pg_catalog.count(*) filter (where a.resolved_at is null and a.created_at < v_now - interval '72 hours')::numeric, pg_catalog.count(*)::numeric into v_n, v_total from public.jev_alerts a where a.acknowledged_at is null;",
    );
  });

  it("warns at one or more, passes otherwise, threshold 1", () => {
    expect(seg).toContain("threshold := 1;");
    expect(seg).toContain("observed := v_n;");
    expect(seg).toContain("status := case when v_n >= 1 then 'warn' else 'pass' end;");
  });

  it("reports the open count and the unacked total in the detail", () => {
    expect(seg).toContain(
      "detail := 'açık ve onaysız: ' || v_n::text || ' / onaysız toplam: ' || v_total::text;",
    );
    expect(seg).not.toContain("toplam onaysız:");
  });

  it("swallows errors into an unknown row", () => {
    expect(seg).toMatch(/exception when others then status := 'unknown'; observed := null; detail := substr\(sqlerrm, 1, 200\);/);
  });
});

describe("108 jev_shadow_cron_failures_30m (check 12)", () => {
  let block = "";
  let seg = "";
  let queries: string[] = [];
  let queries103: string[] = [];
  beforeAll(() => {
    block = segmentFor(healthBody, CHECK_12);
    seg = norm(block);
    queries = executeQueries(block);
    queries103 = executeQueries(segmentFor(body103, CHECK_12));
  });

  it("is still the last row, with threshold 2", () => {
    const parts = segments(healthBody);
    expect(segmentName(parts[parts.length - 1] as string)).toBe(CHECK_12);
    expect(seg.startsWith("'jev_shadow_cron_failures_30m'; threshold := 2;")).toBe(true);
    expect(seg.endsWith("return; end")).toBe(true);
    expect(seg.match(/return next;/g)).toHaveLength(1);
  });

  it("resets all four counters to null first, so an absent relation differs from a zero count", () => {
    expect(seg).toContain("v_n := null; v_total := null; v_zero := null; v_tmo := null;");
  });

  it("(a) the cron EXECUTE is 103's first one, verbatim, into v_n behind the same to_regclass guard", () => {
    expect(queries).toHaveLength(2);
    expect(queries103).toHaveLength(2);
    expect(norm(queries[0] as string)).toBe(norm(queries103[0] as string));
    expect(seg).toMatch(
      /if pg_catalog\.to_regclass\('cron\.job_run_details'\) is not null then execute \$q\$[\s\S]*?\$q\$ into v_n; end if;/,
    );
  });

  it("(b) one pg_net query counts jev-shadow 5xx and timed_out rows, into v_total and v_tmo, behind its guard", () => {
    const q = norm(queries[1] as string);
    expect(q).toBe(
      "select pg_catalog.count(*) filter (where r.status_code >= 500 and r.content like '%\"fn\":\"jev-shadow\"%')::numeric, pg_catalog.count(*) filter (where r.timed_out)::numeric from net._http_response r where r.created >= pg_catalog.now() - interval '30 minutes'",
    );
    expect(q).toContain("r.timed_out");
    expect(seg).toMatch(
      /if pg_catalog\.to_regclass\('net\._http_response'\) is not null then execute \$q\$[\s\S]*?\$q\$ into v_total, v_tmo; end if;/,
    );
  });

  it("(c) counts zero-call partial or error runs of the last 30 minutes into v_zero", () => {
    expect(seg).toContain(
      "select pg_catalog.count(*)::numeric into v_zero from public.jev_shadow_runs r where r.started_at >= v_now - interval '30 minutes' and r.status in ('partial', 'error') and r.calls = 0;",
    );
  });

  it("observed sums all three counts; an absent relation counts as zero", () => {
    expect(seg).toContain("observed := coalesce(v_n, 0) + coalesce(v_total, 0) + coalesce(v_zero, 0);");
  });

  it("fail at 2 or more, warn at 1 or more or any timed-out request, pass otherwise", () => {
    expect(seg).toContain(
      "status := case when observed >= 2 then 'fail' when observed >= 1 or coalesce(v_tmo, 0) >= 1 then 'warn' else 'pass' end;",
    );
    // behavioural mirror of the case expression
    const classify = (observed: number, tmo: number) =>
      observed >= 2 ? "fail" : observed >= 1 || tmo >= 1 ? "warn" : "pass";
    expect(classify(0, 0)).toBe("pass");
    expect(classify(0, 1)).toBe("warn");
    expect(classify(0, 7)).toBe("warn"); // timeouts alone never escalate past warn
    expect(classify(1, 0)).toBe("warn");
    expect(classify(2, 0)).toBe("fail");
    expect(classify(40, 3)).toBe("fail");
  });

  it("the detail names all four counts, and appends the missing-extension note only when both relations are absent", () => {
    expect(seg).toContain(
      "detail := 'cron hatası: ' || coalesce(v_n, 0)::text || ' · HTTP 5xx: ' || coalesce(v_total, 0)::text || ' · sıfır çağrılı koşu: ' || coalesce(v_zero, 0)::text || ' · zaman aşımı (fonksiyon bilinmiyor): ' || coalesce(v_tmo, 0)::text || ' (son 30 dk)'",
    );
    expect(seg).toMatch(
      /if v_n is null and v_total is null then detail := detail \|\| ' · pg_cron ve pg_net yok'; end if;/,
    );
  });

  it("dropped the old unknown branch and the redeploy caveat; errors still yield unknown", () => {
    expect(seg).not.toContain("yeniden dağıtıldıktan");
    expect(seg).not.toContain("status := 'unknown'; detail := 'pg_cron ve pg_net yok'");
    expect(seg).toMatch(/exception when others then status := 'unknown'; observed := null; detail := substr\(sqlerrm, 1, 200\);/);
    expect(seg).toMatch(/end; return next;/);
  });
});

describe("108 fn marker parity with jevShadowErrorEnvelope", () => {
  function sqlMarker(): string {
    const m = /r\.content\s+like\s+'%([^']+)%'/i.exec(healthCode);
    expect(m).not.toBeNull();
    return (m as RegExpExecArray)[1] as string;
  }

  it("the marker is the JSON key/value pair jev-shadow emits, with no LIKE wildcard inside it", () => {
    const marker = sqlMarker();
    expect(marker).toBe('"fn":"jev-shadow"');
    expect(marker).not.toMatch(/[%_]/);
  });

  it("every 5xx error body jevShadowErrorEnvelope emits contains the marker, as serialised by JSON.stringify", () => {
    const marker = sqlMarker();
    const cases: unknown[] = [
      new JevDeadlineError("articles"),
      new JevDbUnavailableError("startRun", new Error("timeout")),
      new JevDbUnavailableError("finishRun", new Error("timeout")),
      new Error("anything else"),
      "not even an Error",
    ];
    for (const err of cases) {
      const env = jevShadowErrorEnvelope(err, "00000000-0000-4000-8000-000000000000");
      expect(env.status).toBeGreaterThanOrEqual(500);
      expect(JSON.stringify(env.body)).toContain(marker);
    }
  });
});

describe("108 ops_health_report: zone-map and source-kind parity with the bias-zone contract", () => {
  it("the zmap VALUES pairs deep-equal BIAS_TO_ZONE, with no duplicates", () => {
    const span = /zmap\s*\(\s*bias_key\s*,\s*zone\s*\)\s+as\s*\(\s*values([\s\S]*?)\)\s*\n?\s*select/i.exec(
      healthCode,
    );
    expect(span).not.toBeNull();
    const parsed: Record<string, string> = {};
    const pairRe = /\(\s*'([a-z_]+)'\s*,\s*'([a-z]+)'\s*\)/g;
    let m: RegExpExecArray | null;
    let count = 0;
    while ((m = pairRe.exec((span as RegExpExecArray)[1] as string)) !== null) {
      parsed[m[1] as string] = m[2] as string;
      count += 1;
    }
    expect(count).toBe(Object.keys(BIAS_TO_ZONE).length);
    expect(parsed).toEqual({ ...BIAS_TO_ZONE });
  });

  it("the zone loop's array literal equals ZONE_KEYS", () => {
    const m = /foreach\s+v_zone\s+in\s+array\s+array\s*\[([^\]]+)\]/i.exec(healthCode);
    expect(m).not.toBeNull();
    const items = [...((m as RegExpExecArray)[1] as string).matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    expect(items).toEqual([...ZONE_KEYS]);
  });

  it("every 's.kind in (...)' list equals VOTING_SOURCE_KINDS, and there are exactly 2 of them", () => {
    const lists = [...healthCode.matchAll(/s\.kind\s+in\s*\(([^)]+)\)/gi)];
    expect(lists).toHaveLength(2);
    for (const l of lists) {
      const kinds = [...(l[1] as string).matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
      expect(new Set(kinds)).toEqual(new Set(VOTING_SOURCE_KINDS));
    }
  });
});

describe("108 ops_health_report: exception handling", () => {
  it("has at least 10 'exception when others' blocks, each followed by a 'return next'", () => {
    expect([...healthCode.matchAll(/exception\s+when\s+others\s+then/gi)].length).toBeGreaterThanOrEqual(10);
    expect([...healthCode.matchAll(/end;\s*return\s+next\s*;/gi)].length).toBeGreaterThanOrEqual(10);
  });
});

describe("108 jev-shadow cron reschedule block", () => {
  let block = "";
  let block061 = "";
  beforeAll(() => {
    const blocks = doBlocks(code);
    expect(blocks).toHaveLength(1);
    block = blocks[0] as string;
    const found = doBlocks(stripSqlComments(sql061)).find((b) => b.includes("cron.schedule('jev-shadow'"));
    expect(found).toBeDefined();
    block061 = found as string;
  });

  it("returns with a notice when pg_cron/pg_net or the Vault secrets are absent (061's guards)", () => {
    expect(block).toMatch(/extname\s*=\s*'pg_cron'/);
    expect(block).toMatch(/extname\s*=\s*'pg_net'/);
    expect(block).toMatch(/vault\.decrypted_secrets\s+where\s+name\s*=\s*'service_role_key'/);
    expect(block).toMatch(/vault\.decrypted_secrets\s+where\s+name\s*=\s*'functions_base_url'/);
    expect([...block.matchAll(/raise\s+notice\b/gi)].length).toBeGreaterThanOrEqual(2);
    expect([...block.matchAll(/\breturn\s*;/gi)].length).toBeGreaterThanOrEqual(2);
    // the guards come before any cron.* call
    expect(block.search(/raise\s+notice/i)).toBeLessThan(block.indexOf("cron.unschedule"));
    expect(block.indexOf("functions_base_url")).toBeLessThan(block.indexOf("cron.unschedule"));
    // 061's two guards, unchanged apart from the notice wording
    for (const needle of [
      "extname = 'pg_cron'",
      "extname = 'pg_net'",
      "name = 'service_role_key'",
      "name = 'functions_base_url'",
    ]) {
      expect(block061).toContain(needle);
    }
  });

  it("remembers whether the job is active, then unschedules it if it exists", () => {
    expect(norm(block)).toContain("select j.active into v_active from cron.job j where j.jobname = 'jev-shadow';");
    expect(block).toMatch(/exists\s*\(\s*select\s+1\s+from\s+cron\.job\s+where\s+jobname\s*=\s*'jev-shadow'\s*\)\s+then\s+perform\s+cron\.unschedule\(\s*'jev-shadow'\s*\)/i);
    expect(block.indexOf("select j.active")).toBeLessThan(block.indexOf("cron.unschedule"));
  });

  it("schedules 'jev-shadow' every ten minutes", () => {
    expect(block).toMatch(/perform\s+cron\.schedule\(\s*'jev-shadow'\s*,\s*'\*\/10 \* \* \* \*'\s*,\s*\$sql\$/);
  });

  it("its url and headers are 061's, unchanged", () => {
    const grab = (b: string, from: RegExp): string => {
      const m = from.exec(b);
      expect(m).not.toBeNull();
      return norm((m as RegExpExecArray)[1] as string);
    };
    const urlRe = /url\s*:=([\s\S]*?),\s*headers\s*:=/;
    const headersRe = /headers\s*:=([\s\S]*?),\s*body\s*:=/;
    expect(grab(block, urlRe)).toBe(grab(block061, urlRe));
    expect(grab(block, headersRe)).toBe(grab(block061, headersRe));
    expect(grab(block, urlRe)).toContain("'/jev-shadow'");
    expect(grab(block, headersRe)).toContain("service_role_key");
  });

  it("posts an enqueued_at timestamp in the format requestDeadlineMs parses, with a 120 s pg_net timeout", () => {
    expect(block).toContain("'enqueued_at'");
    expect(norm(block)).toContain(
      `body := jsonb_build_object('enqueued_at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),`,
    );
    expect(block).toMatch(/timeout_milliseconds\s*:=\s*120000\b/);
    expect(block).not.toMatch(/timeout_milliseconds\s*:=\s*60000\b/);
  });

  it("restores a deactivated job (the kill switch survives the reschedule)", () => {
    expect(norm(block)).toContain(
      "if v_active is false then update cron.job set active = false where jobname = 'jev-shadow'; end if;",
    );
    expect(block.indexOf("update cron.job")).toBeGreaterThan(block.indexOf("cron.schedule("));
  });

  it("never reads the job command or any other secret-bearing job field", () => {
    expect(block).not.toMatch(/\bcommand\b/i);
    expect(block).not.toMatch(/return_message/i);
    expect(block).not.toMatch(/\bj\.\*|select\s+\*/i);
  });

  it("bakes no secret into the file: the bearer is read from Vault at run time", () => {
    expect(sql).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(sql).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{20,}/);
  });
});

describe("108 enqueued_at format parity with requestDeadlineMs", () => {
  it("a timestamp in the SQL format (millisecond precision, Z suffix) parses, and 5 s of queue age leaves 40 s", () => {
    expect(
      requestDeadlineMs({ enqueued_at: "2026-10-22T23:50:00.123Z" }, Date.parse("2026-10-22T23:50:05.123Z")),
    ).toBe(40000);
  });
});
