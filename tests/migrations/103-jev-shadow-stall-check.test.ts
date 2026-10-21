import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { BIAS_TO_ZONE, ZONE_KEYS } from "../../supabase/functions/_shared/cluster/blindspot";
import { VOTING_SOURCE_KINDS } from "../../supabase/functions/_shared/cluster/source-kind";
import {
  JevDbUnavailableError,
  JevDeadlineError,
  jevShadowErrorEnvelope,
} from "../../supabase/functions/_shared/jev.ts";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 103 ("jev-shadow-stall-check").
//
// Finding 1(a): a database timeout in jev-shadow's first calls
// (jev_shadow_month_usage, then the insert that opens the run row) used to
// answer an unretried 500 with NO jev_shadow_runs row, and pg_cron reports
// 'succeeded' for an http-poking job the moment net.http_post queues the
// request. Nothing in ops_health_report() could see it until
// jev_shadow_last_run_min crossed 30 minutes. 103 adds a 12th row,
// jev_shadow_cron_failures_30m, that sums (a) failed cron runs of the three
// Jev jobs and (b) jev-shadow HTTP 5xx responses carrying the "fn":"jev-shadow"
// marker that jevShadowErrorEnvelope puts in every error body.
//
// The health function is re-created in full, so this file pins that every
// check from 100 (and so from 077) survived byte-for-byte (modulo
// comments/whitespace) and that the new check is the last row. It is
// modelled on 100-pgnet-bloat-guard.test.ts.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "supabase", "migrations");
const MIGRATION_103 = resolve(MIGRATIONS_DIR, "103_jev_shadow_stall_check.sql");
const MIGRATION_100 = resolve(MIGRATIONS_DIR, "100_pgnet_bloat_guard.sql");
const MIGRATION_077 = resolve(MIGRATIONS_DIR, "077_ops_health_report.sql");

const NEW_CHECK = "jev_shadow_cron_failures_30m";

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

let sql = "";
let code = "";
let healthBlock = "";
let healthBody = "";
let healthCode = "";
let sql100 = "";
let body100 = "";
let sql077 = "";
let body077 = "";

beforeAll(() => {
  sql = readFileSync(MIGRATION_103, "utf8");
  code = stripSqlComments(sql);
  healthBlock = functionBlock(code, "ops_health_report");
  healthBody = body(healthBlock);
  healthCode = stripSqlComments(healthBody);
  sql100 = readFileSync(MIGRATION_100, "utf8");
  body100 = body(functionBlock(stripSqlComments(sql100), "ops_health_report"));
  sql077 = readFileSync(MIGRATION_077, "utf8");
  body077 = body(functionBlock(stripSqlComments(sql077), "ops_health_report"));
});

describe("103 ledger and structure", () => {
  it("is wrapped in begin/commit, with the ledger insert last", () => {
    expect([...code.matchAll(/^\s*begin\s*;/gim)]).toHaveLength(1);
    expect([...code.matchAll(/^\s*commit\s*;/gim)]).toHaveLength(1);
    const ledger = code.search(/insert\s+into\s+supabase_migrations\.schema_migrations/i);
    expect(ledger).toBeGreaterThan(code.search(/grant\s+execute\s+on\s+function/i));
    expect(ledger).toBeLessThan(code.search(/^\s*commit\s*;/im));
  });

  it("records itself as version '103'", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(version,\s*name\)\s*values\s*\(\s*'103'\s*,\s*'103_jev_shadow_stall_check'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("sanity: comment stripping is non-vacuous", () => {
    expect(sql.length).toBeGreaterThan(code.length);
  });

  it("the header explains finding 1(a), the 'succeeded' blind spot and why no alert row is written", () => {
    const head = sql.slice(0, sql.search(/^\s*begin\s*;/im));
    expect(head).toMatch(/1\(a\)/);
    expect(head).toMatch(/'succeeded'/);
    expect(head).toMatch(/net\.http_post/);
    expect(head).toMatch(/jev_shadow_last_run_min/);
    expect(head).toMatch(/jev_alerts/);
    expect(head).toMatch(/source_drift/);
    expect(head).toMatch(/kap_class_canary/);
    expect(head).toMatch(/stage_budget/);
    expect(head).toMatch(/"fn":"jev-shadow"/);
    expect(head).toMatch(/jevShadowErrorEnvelope/);
    expect(head).toMatch(/redeploy|deploy/i);
  });

  it("only re-creates ops_health_report: no table, no cron job, no data written", () => {
    expect(code).not.toMatch(/\bcreate\s+table\b/i);
    expect(code).not.toMatch(/\balter\s+table\b/i);
    expect(code).not.toMatch(/\bdrop\s+(table|function|schema|extension)\b/i);
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bvacuum\b/i);
    expect(code).not.toMatch(/\bcron\.schedule\s*\(/i);
    expect(code).not.toMatch(/\binsert\s+into\s+public\./i);
    expect(code).not.toMatch(/\bupdate\s+public\./i);
    expect(code).not.toMatch(/jev_alerts\s*\(/i);
    const creates = [...code.matchAll(/create\s+or\s+replace\s+function\s+(public\.[a-z_]+)/gi)].map(
      (m) => m[1],
    );
    expect(creates).toEqual(["public.ops_health_report"]);
  });
});

describe("103 ops_health_report: signature, grants and safety are unchanged", () => {
  it("is plpgsql volatile SECURITY DEFINER with an empty search_path and the same return shape", () => {
    expect(header(healthBlock)).toMatch(
      /function\s+public\.ops_health_report\s*\(\s*\)[\s\S]*?language\s+plpgsql[\s\S]{0,40}volatile[\s\S]{0,40}security\s+definer[\s\S]{0,40}set\s+search_path\s*=\s*''/i,
    );
    const m = /returns\s+table\s*\(([^)]+)\)/i.exec(header(healthBlock));
    expect(m).not.toBeNull();
    const cols = (m as RegExpExecArray)[1]
      .split(",")
      .map((c) => c.trim().replace(/\s+/g, " "));
    expect(cols).toEqual([
      "check_name text",
      "status text",
      "observed numeric",
      "threshold numeric",
      "detail text",
    ]);
  });

  it("the function header is identical to 077's (and to 100's)", () => {
    const old077 = functionBlock(stripSqlComments(sql077), "ops_health_report");
    const old100 = functionBlock(stripSqlComments(sql100), "ops_health_report");
    expect(norm(header(healthBlock))).toBe(norm(header(old077)));
    expect(norm(header(healthBlock))).toBe(norm(header(old100)));
  });

  it("declares #variable_conflict use_column and the same variables as 100 (nothing new)", () => {
    expect(healthCode).toMatch(/#variable_conflict\s+use_column/i);
    expect(declareSection(healthBody)).toBe(declareSection(body100));
    expect(declareSection(healthBody)).toBe(declareSection(body077));
  });

  it("revokes from public/anon/authenticated and grants only to service_role (exactly once)", () => {
    expect(code).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.ops_health_report\(\)\s+from\s+public,\s*anon,\s*authenticated\s*;/i,
    );
    const grants = [...code.matchAll(/grant\s+execute\s+on\s+function\s+public\.ops_health_report[^;]*;/gi)];
    expect(grants).toHaveLength(1);
    expect(grants[0]?.[0]).toMatch(/\(\)\s+to\s+service_role\s*;/i);
    // The only grant statement in the file is that one: no write privilege, no other grantee.
    const allGrants = [...code.matchAll(/(^|;)\s*grant\b[^;]*;/gi)];
    expect(allGrants).toHaveLength(1);
    for (const g of allGrants) {
      expect(g[0]).not.toMatch(/\bto\b[^;]*\b(anon|authenticated|public)\b/i);
      expect(g[0]).not.toMatch(/\b(insert|update|delete|truncate|maintain)\b/i);
    }
  });

  it("is read-only: no writes, truncate, cron.schedule, return_message or cron job-body access", () => {
    expect(healthCode).not.toMatch(/\binsert\s+into\b/i);
    expect(healthCode).not.toMatch(/\bupdate\s+[a-z_]+\./i);
    expect(healthCode).not.toMatch(/\bdelete\s+from\b/i);
    expect(healthCode).not.toMatch(/\btruncate\b/i);
    expect(healthCode).not.toMatch(/\bcron\.schedule\s*\(/i);
    expect(healthCode).not.toMatch(/return_message/i);
    expect(healthCode).not.toMatch(/\bcommand\b/i);
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

describe("103 ops_health_report: every earlier check is preserved, the new one is last", () => {
  const ORDER_100 = [
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
  ];

  it("the literal check_name assignments are 100's, in order, plus the new check at the end", () => {
    expect(literalCheckNames(body100)).toEqual([
      "cron_failed_runs_30m",
      "edge_http_errors_30m",
      "ingest_cycles_30m",
      "jev_shadow_last_run_min",
      "blindspot_veto_cron_min",
      "jev_alerts_unacked_72h",
      "dead_feeds",
      "net_response_heap_mb",
    ]);
    expect(literalCheckNames(healthBody)).toEqual([...literalCheckNames(body100), NEW_CHECK]);
    // the three per-zone rows still come from the same foreach loop as in 077
    expect(healthCode).toMatch(/check_name\s*:=\s*'ingest_fresh_'\s*\|\|\s*v_zone\s*\|\|\s*'_min'/i);
  });

  it("the function comment lists all 12 rows in order and says 12", () => {
    const comment = /comment\s+on\s+function\s+public\.ops_health_report\(\)\s+is([\s\S]*?);\s*\n/i.exec(sql);
    expect(comment).not.toBeNull();
    const text = (comment as RegExpExecArray)[1] as string;
    expect(text).toMatch(/12 fixed rows/);
    expect(text).toMatch(/migrations 077, 100, 103/);
    const expected = [...ORDER_100, NEW_CHECK];
    const positions = expected.map((n) => text.indexOf(n));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // the new row is described, not just named
    expect(text).toMatch(/jev-shadow/);
    expect(text).toMatch(/jev-cluster-audit/);
    expect(text).toMatch(/jev-regression-weekly/);
    expect(text).toMatch(/warn 1, fail >= 2/);
  });

  it("100's whole body (comments and whitespace aside) is a verbatim prefix of the new body", () => {
    const old = norm(body100);
    expect(old.endsWith("return; end")).toBe(true);
    const oldHead = old.slice(0, old.length - "return; end".length);
    const now = norm(healthBody);
    expect(now.startsWith(oldHead)).toBe(true);
    const tail = now.slice(oldHead.length);
    expect(tail.startsWith(`check_name := '${NEW_CHECK}'; threshold := 2;`)).toBe(true);
    expect(tail.endsWith("return; end")).toBe(true);
    // the tail adds exactly one `return next;` (one new row)
    expect(tail.match(/return next;/g)).toHaveLength(1);
  });

  it("077's body is still a prefix of 100's, so the whole chain 077 -> 100 -> 103 is append-only", () => {
    const o77 = norm(body077);
    const head77 = o77.slice(0, o77.length - "return; end".length);
    expect(norm(body100).startsWith(head77)).toBe(true);
    expect(norm(healthBody).startsWith(head77)).toBe(true);
  });

  it("sanity: the 100 file really lists the 11 names in its comment", () => {
    for (const n of ORDER_100) expect(sql100).toContain(n);
  });
});

describe("103 jev_shadow_cron_failures_30m check", () => {
  let block = "";
  /** The two `execute $q$ ... $q$` strings, in source order. */
  let queries: string[] = [];
  beforeAll(() => {
    const start = healthCode.indexOf(`check_name := '${NEW_CHECK}'`);
    expect(start).toBeGreaterThan(0);
    block = healthCode.slice(start);
    queries = [...block.matchAll(/execute\s+\$q\$([\s\S]*?)\$q\$/gi)].map((m) => m[1] as string);
  });

  it("has exactly two queries: failed cron runs first, then the pg_net 5xx count", () => {
    expect(queries).toHaveLength(2);
    expect(queries[0]).toMatch(/from\s+cron\.job_run_details\s+d\s+join\s+cron\.job\s+j\s+on\s+j\.jobid\s*=\s*d\.jobid/i);
    expect(queries[1]).toMatch(/from\s+net\._http_response\s+r/i);
  });

  it("(1) counts failed cron runs of exactly the three Jev jobs, last 30 min, in check 1's runid window", () => {
    const q = queries[0] as string;
    expect(q).toMatch(/d\.status\s*=\s*'failed'/i);
    expect(q).toMatch(/d\.start_time\s*>=\s*pg_catalog\.now\(\)\s*-\s*interval\s*'30 minutes'/i);
    expect(q).toMatch(
      /d\.runid\s*>\s*\(\s*select\s+coalesce\(\s*pg_catalog\.max\(\s*x\.runid\s*\)\s*,\s*0\s*\)\s*-\s*5000\s+from\s+cron\.job_run_details\s+x\s*\)/i,
    );
    const list = /j\.jobname\s+in\s*\(([^)]+)\)/i.exec(q);
    expect(list).not.toBeNull();
    const jobs = [...((list as RegExpExecArray)[1] as string).matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
    expect(new Set(jobs)).toEqual(new Set(["jev-shadow", "jev-cluster-audit", "jev-regression-weekly"]));
    expect(jobs).toHaveLength(3);
    // the same runid window literal as check 1
    expect(healthCode.match(/-\s*5000\b/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("(2) counts pg_net rows of the last 30 min with status_code >= 500 and the fn marker", () => {
    const q = queries[1] as string;
    expect(q).toMatch(/r\.created\s*>=\s*pg_catalog\.now\(\)\s*-\s*interval\s*'30 minutes'/i);
    expect(q).toMatch(/r\.status_code\s*>=\s*500\b/i);
    expect(q).toMatch(/r\.content\s+like\s+'%[^']+%'/i);
  });

  it("only runs each query when its relation exists (to_regclass guard), reusing v_n and v_total", () => {
    expect(block).toMatch(
      /if\s+pg_catalog\.to_regclass\(\s*'cron\.job_run_details'\s*\)\s+is\s+not\s+null\s+then\s+execute\s+\$q\$[\s\S]*?\$q\$\s+into\s+v_n\s*;\s*end\s+if\s*;/i,
    );
    expect(block).toMatch(
      /if\s+pg_catalog\.to_regclass\(\s*'net\._http_response'\s*\)\s+is\s+not\s+null\s+then\s+execute\s+\$q\$[\s\S]*?\$q\$\s+into\s+v_total\s*;\s*end\s+if\s*;/i,
    );
    // the variables start null, so an absent relation is distinguishable from a zero count
    expect(block).toMatch(/v_n\s*:=\s*null\s*;\s*v_total\s*:=\s*null\s*;/i);
  });

  it("observed is the sum of both counts; an absent relation counts as zero", () => {
    expect(block).toMatch(/observed\s*:=\s*coalesce\(\s*v_n\s*,\s*0\s*\)\s*\+\s*coalesce\(\s*v_total\s*,\s*0\s*\)\s*;/i);
  });

  it("is 'unknown' only when BOTH relations are absent, and swallows errors into an unknown row", () => {
    expect(block).toMatch(
      /if\s+v_n\s+is\s+null\s+and\s+v_total\s+is\s+null\s+then\s+status\s*:=\s*'unknown'\s*;\s*detail\s*:=\s*'pg_cron ve pg_net yok'\s*;/i,
    );
    expect(block).toMatch(/exception\s+when\s+others\s+then\s+status\s*:=\s*'unknown'/i);
    expect(block).toMatch(/end;\s*return\s+next\s*;/i);
  });

  it("fail >= 2, warn >= 1, pass otherwise, with threshold = 2 (the fail limit)", () => {
    expect(block).toMatch(/threshold\s*:=\s*2\s*;/);
    const m =
      /status\s*:=\s*case\s+when\s+observed\s*>=\s*(\d+)\s+then\s+'fail'\s+when\s+observed\s*>=\s*(\d+)\s+then\s+'warn'\s+else\s+'pass'\s+end/i.exec(
        block,
      );
    expect(m).not.toBeNull();
    const failFrom = Number(m?.[1]);
    const warnFrom = Number(m?.[2]);
    expect(failFrom).toBe(2);
    expect(warnFrom).toBe(1);
    const classify = (n: number) => (n >= failFrom ? "fail" : n >= warnFrom ? "warn" : "pass");
    expect(classify(0)).toBe("pass");
    expect(classify(1)).toBe("warn");
    expect(classify(2)).toBe("fail");
    expect(classify(40)).toBe("fail");
  });

  it("the detail names both counts and carries the redeploy caveat", () => {
    expect(block).toMatch(/detail\s*:=\s*'cron hatası: '\s*\|\|/);
    expect(block).toMatch(/' · HTTP 5xx: '/);
    expect(block).toMatch(/HTTP sayımı jev-shadow yeniden dağıtıldıktan sonra geçerli/);
    expect(block).toMatch(/son 30 dk/);
  });
});

describe("103 fn marker parity with jevShadowErrorEnvelope", () => {
  /** The LIKE pattern between the % wildcards. */
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
      new JevDbUnavailableError("monthTokens", new Error("timeout")),
      new JevDbUnavailableError("finishRun", new Error("timeout")),
      new Error("anything else"),
      "not even an Error",
    ];
    for (const err of cases) {
      const env = jevShadowErrorEnvelope(err, "00000000-0000-4000-8000-000000000000");
      expect(env.status).toBeGreaterThanOrEqual(500);
      expect(JSON.stringify(env.body)).toContain(marker);
    }
    const statuses = cases.map((e) => jevShadowErrorEnvelope(e, "r").status);
    expect(new Set(statuses)).toEqual(new Set([504, 503, 500]));
  });
});

describe("103 ops_health_report: zone-map and source-kind parity with the bias-zone contract", () => {
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

describe("103 ops_health_report: exception handling", () => {
  it("has at least 10 'exception when others' blocks, each followed by a 'return next'", () => {
    expect([...healthCode.matchAll(/exception\s+when\s+others\s+then/gi)].length).toBeGreaterThanOrEqual(10);
    expect([...healthCode.matchAll(/end;\s*return\s+next\s*;/gi)].length).toBeGreaterThanOrEqual(10);
  });
});
