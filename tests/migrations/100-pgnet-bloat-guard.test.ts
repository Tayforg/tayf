import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { BIAS_TO_ZONE, ZONE_KEYS } from "../../supabase/functions/_shared/cluster/blindspot";
import { VOTING_SOURCE_KINDS } from "../../supabase/functions/_shared/cluster/source-kind";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 100 ("pgnet-bloat-guard").
//
// Incident 2026-10-21: net._http_response (pg_net's response log, owned by
// supabase_admin) bloated to 278 MB of heap for 552 live rows; pg_net's own
// TTL DELETE became the #1 DB time consumer and evicted the cache on a Micro
// instance, so pages ran 8-22 s and /rss.xml 500'd. DELETE never shrinks a
// heap and VACUUM FULL cannot run inside a function (and, on PG15, needs
// ownership), so the in-database lever is TRUNCATE (postgres holds that
// privilege on it). 100 adds:
//   1. public.ops_net_response_compact(): truncates above a size threshold,
//      returns 'skipped: lock' instead of raising when pg_net's worker holds
//      the lock, scheduled every 15 minutes as 'net-response-compact';
//   2. an 11th ops_health_report() check, net_response_heap_mb, so a stalled
//      compaction pages instead of silently degrading the site again.
//
// The health function is re-created in full, so this file pins that every
// 077 check survived byte-for-byte (modulo comments/whitespace) and that the
// new check is the last row.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "supabase", "migrations");
const MIGRATION_100 = resolve(MIGRATIONS_DIR, "100_pgnet_bloat_guard.sql");
const MIGRATION_077 = resolve(MIGRATIONS_DIR, "077_ops_health_report.sql");

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

let sql = "";
let code = "";
let compactBlock = "";
let compactBody = "";
let healthBlock = "";
let healthBody = "";
let healthCode = "";
let sql077 = "";
let body077 = "";

beforeAll(() => {
  sql = readFileSync(MIGRATION_100, "utf8");
  code = stripSqlComments(sql);
  compactBlock = functionBlock(code, "ops_net_response_compact");
  compactBody = stripSqlComments(body(compactBlock));
  healthBlock = functionBlock(code, "ops_health_report");
  healthBody = body(healthBlock);
  healthCode = stripSqlComments(healthBody);
  sql077 = readFileSync(MIGRATION_077, "utf8");
  body077 = body(functionBlock(stripSqlComments(sql077), "ops_health_report"));
});

describe("100 ledger and structure", () => {
  it("is wrapped in begin/commit", () => {
    expect(code).toMatch(/\bbegin\s*;/i);
    expect(code).toMatch(/\bcommit\s*;/i);
  });

  it("records itself as version '100'", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(version,\s*name\)\s*values\s*\(\s*'100'\s*,\s*'100_pgnet_bloat_guard'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("sanity: comment stripping is non-vacuous", () => {
    expect(sql.length).toBeGreaterThan(code.length);
  });

  it("the header documents the incident and why TRUNCATE is the only lever", () => {
    const head = sql.slice(0, sql.search(/^\s*begin\s*;/im));
    expect(head).toMatch(/2026-10-21/);
    expect(head).toMatch(/278 MB/);
    expect(head).toMatch(/552/);
    expect(head).toMatch(/supabase_admin/);
    expect(head).toMatch(/VACUUM FULL/);
    expect(head).toMatch(/TRUNCATE/);
    expect(head).toMatch(/DELETE/);
    expect(head).toMatch(/ops_exhaust_prune/);
    expect(head).toMatch(/lock_timeout/);
  });

  it("only touches the two ops functions, one cron job and the ledger", () => {
    expect(code).not.toMatch(/\bcreate\s+table\b/i);
    expect(code).not.toMatch(/\balter\s+table\b/i);
    expect(code).not.toMatch(/\bdrop\s+(table|function|schema|extension)\b/i);
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    expect(code).not.toMatch(/\bvacuum\b/i);
    expect(code).not.toMatch(/\binsert\s+into\s+public\./i);
    expect(code).not.toMatch(/\bupdate\s+public\./i);
    const creates = [...code.matchAll(/create\s+or\s+replace\s+function\s+(public\.[a-z_]+)/gi)].map(
      (m) => m[1],
    );
    expect(creates).toEqual(["public.ops_net_response_compact", "public.ops_health_report"]);
  });
});

describe("100 ops_net_response_compact: shape and grants", () => {
  it("is plpgsql SECURITY DEFINER, empty search_path, bigint default 64 MiB, returns text", () => {
    expect(header(compactBlock)).toMatch(
      /function\s+public\.ops_net_response_compact\s*\(\s*p_max_bytes\s+bigint\s+default\s+64\s*\*\s*1024\s*\*\s*1024\s*\)\s*returns\s+text\s+language\s+plpgsql\s+security\s+definer\s+set\s+search_path\s*=\s*''/i,
    );
  });

  it("revokes from public/anon/authenticated and grants execute to service_role only", () => {
    expect(code).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.ops_net_response_compact\(bigint\)\s+from\s+public,\s*anon,\s*authenticated\s*;/i,
    );
    const grants = [
      ...code.matchAll(/grant\s+execute\s+on\s+function\s+public\.ops_net_response_compact[^;]*;/gi),
    ];
    expect(grants).toHaveLength(1);
    expect(grants[0]?.[0]).toMatch(/\(bigint\)\s+to\s+service_role\s*;/i);
    // No grant statement in the whole file may name anon/authenticated/public as a grantee.
    for (const g of code.matchAll(/(^|;)\s*grant\b[^;]*;/gi)) {
      expect(g[0]).not.toMatch(/\bto\b[^;]*\b(anon|authenticated|public)\b/i);
    }
  });

  it("has a function comment naming the kill switch", () => {
    expect(sql).toMatch(/comment\s+on\s+function\s+public\.ops_net_response_compact\(bigint\)\s+is/i);
    expect(sql).toMatch(/update cron\.job set active\s*=\s*false where jobname\s*=\s*''net-response-compact''/i);
  });

  it("schema-qualifies every catalog function it calls (search_path is empty)", () => {
    expect(compactBody).not.toMatch(
      /(?<![.\w])(to_regclass|has_table_privilege|pg_total_relation_size|pg_size_pretty|pg_try_advisory_xact_lock|hashtextextended|current_setting|set_config)\s*\(/i,
    );
    expect(compactBody).toMatch(/pg_catalog\.to_regclass\(\s*'net\._http_response'\s*\)/i);
  });
});

describe("100 ops_net_response_compact: behaviour contract", () => {
  it("compares pg_total_relation_size against p_max_bytes with a floor and a 64 MiB default", () => {
    expect(compactBody).toMatch(
      /greatest\(\s*coalesce\(\s*p_max_bytes\s*,\s*64\s*\*\s*1024\s*\*\s*1024\s*\)\s*,\s*1024\s*\*\s*1024\s*\)/i,
    );
    expect(compactBody).toMatch(/pg_catalog\.pg_total_relation_size\(\s*v_rel\s*\)/i);
    expect(compactBody).toMatch(/v_size\s*>\s*v_max/i);
    // strictly greater: exactly at the threshold does not truncate
    expect(compactBody).not.toMatch(/v_size\s*>=\s*v_max/i);
  });

  it("no-ops (returns without raising) when pg_net is absent or TRUNCATE is not granted", () => {
    expect(compactBody).toMatch(/v_rel\s+is\s+null[\s\S]*?return\s+'skipped:[^']*'/i);
    expect(compactBody).toMatch(
      /not\s+pg_catalog\.has_table_privilege\(\s*v_rel\s*,\s*'TRUNCATE'\s*\)[\s\S]*?return\s+'skipped:[^']*'/i,
    );
  });

  it("takes a transaction-scoped try-advisory lock so two runs never overlap", () => {
    expect(compactBody).toMatch(/not\s+pg_catalog\.pg_try_advisory_xact_lock\(/i);
    expect(compactBody).toMatch(/pg_try_advisory_xact_lock\([\s\S]*?\)\s*then\s+return\s+'skipped: busy'/i);
  });

  it("returns 'ok <size>' under the threshold and 'truncated <size>' after truncating", () => {
    expect(compactBody).toMatch(/'ok\s'\s*\|\|\s*pg_catalog\.pg_size_pretty\(/i);
    expect(compactBody).toMatch(/'truncated\s'\s*\|\|\s*pg_catalog\.pg_size_pretty\(/i);
  });

  it("sets lock_timeout = 20s locally, before the truncate, and restores the caller's value", () => {
    expect(compactBody).toMatch(/set\s+local\s+lock_timeout\s*=\s*'20s'\s*;/i);
    expect(compactBody.search(/set\s+local\s+lock_timeout/i)).toBeLessThan(
      compactBody.search(/^\s*truncate\b/im),
    );
    expect(compactBody).toMatch(/pg_catalog\.set_config\(\s*'lock_timeout'\s*,\s*v_prev_lt\s*,\s*true\s*\)/i);
  });

  it("truncates exactly net._http_response, once, inside the 55P03 handler's block", () => {
    const truncates = [...compactBody.matchAll(/^\s*truncate\b[^;]*;/gim)].map((m) => m[0].trim());
    expect(truncates).toEqual(["truncate table net._http_response;"]);
    expect(compactBody).toMatch(
      /truncate\s+table\s+net\._http_response\s*;[\s\S]*?exception\s+when\s+(lock_not_available|sqlstate\s+'55P03')\s+then[\s\S]*?'skipped: lock'/i,
    );
    // plain TRUNCATE: no CASCADE, no identity reset
    expect(compactBody).not.toMatch(/truncate[^;]*\b(cascade|restart\s+identity)\b/i);
  });

  it("checks the guards before it truncates", () => {
    const at = (re: RegExp) => compactBody.search(re);
    const trunc = at(/^\s*truncate\b/im);
    expect(at(/to_regclass\(/i)).toBeLessThan(trunc);
    expect(at(/has_table_privilege\(/i)).toBeLessThan(trunc);
    expect(at(/pg_try_advisory_xact_lock\(/i)).toBeLessThan(trunc);
    expect(at(/pg_total_relation_size\(/i)).toBeLessThan(trunc);
  });

  it("handles ONLY the lock timeout: no raise exception, no 'when others'", () => {
    expect(compactBody).not.toMatch(/\braise\s+exception\b/i);
    expect(compactBody).not.toMatch(/\bwhen\s+others\b/i);
    const handlers = [...compactBody.matchAll(/\bexception\s+when\s+([a-z_0-9' ]+?)\s+then/gi)].map(
      (m) => (m[1] as string).toLowerCase(),
    );
    expect(handlers).toHaveLength(1);
    expect(handlers[0]).toMatch(/^(lock_not_available|sqlstate '55p03')$/);
  });
});

/** `cron.schedule( <args up to and including the closing $sql$> )` -- group 1 is the args. */
const SCHEDULE_CALL = /\bcron\.schedule\s*\(([\s\S]*?\$sql\$[\s\S]*?\$sql\$)\s*\)\s*;/i;

describe("100 pg_cron schedule", () => {
  it("schedules net-response-compact every 15 minutes, idempotently, skipping when pg_cron is absent", () => {
    expect(code).toMatch(/do\s+\$\$[\s\S]*?end\s+\$\$\s*;/i);
    expect(code).toMatch(/extname\s*=\s*'pg_cron'/i);
    expect(code).toMatch(
      /if\s+exists\s*\(\s*select\s+1\s+from\s+cron\.job\s+where\s+jobname\s*=\s*'net-response-compact'\s*\)\s+then\s+perform\s+cron\.unschedule\(\s*'net-response-compact'\s*\)\s*;\s*end\s+if\s*;/i,
    );
    expect([...code.matchAll(/\bcron\.schedule\s*\(/gi)]).toHaveLength(1);
    const call = (SCHEDULE_CALL.exec(code)?.[1] ?? "") as string;
    expect(call).toMatch(/^\s*'net-response-compact'\s*,\s*'\*\/15 \* \* \* \*'/);
    expect(call).toMatch(/select\s+public\.ops_net_response_compact\(\)\s*;/i);
  });

  it("raises the statement timeout above lock_timeout so 55P03 (not 57014) is the failure mode", () => {
    const call = (SCHEDULE_CALL.exec(code)?.[1] ?? "") as string;
    const m = /set\s+statement_timeout\s*=\s*'(\d+)(s|min)'/i.exec(call);
    expect(m).not.toBeNull();
    const seconds = Number(m?.[1]) * (m?.[2] === "min" ? 60 : 1);
    expect(seconds).toBeGreaterThan(20);
  });
});

describe("100 ops_health_report: signature, grants and safety are unchanged from 077", () => {
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
    // the 077 header is the source of truth: identical attributes
    const old = functionBlock(stripSqlComments(sql077), "ops_health_report");
    expect(norm(header(healthBlock))).toBe(norm(header(old)));
  });

  it("declares #variable_conflict use_column", () => {
    expect(healthCode).toMatch(/#variable_conflict\s+use_column/i);
  });

  it("revokes from public/anon/authenticated and grants only to service_role (exactly once)", () => {
    expect(code).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.ops_health_report\(\)\s+from\s+public,\s*anon,\s*authenticated\s*;/i,
    );
    const grants = [...code.matchAll(/grant\s+execute\s+on\s+function\s+public\.ops_health_report[^;]*;/gi)];
    expect(grants).toHaveLength(1);
    expect(grants[0]?.[0]).toMatch(/\(\)\s+to\s+service_role\s*;/i);
  });

  it("is read-only: no writes, truncate, cron.schedule, return_message or cron command access", () => {
    expect(healthCode).not.toMatch(/\binsert\s+into\b/i);
    expect(healthCode).not.toMatch(/\bupdate\s+[a-z_]+\./i);
    expect(healthCode).not.toMatch(/\bdelete\s+from\b/i);
    expect(healthCode).not.toMatch(/\btruncate\b/i);
    expect(healthCode).not.toMatch(/\bcron\.schedule\s*\(/i);
    expect(healthCode).not.toMatch(/return_message/i);
    expect(healthCode).not.toMatch(/\bcommand\b/i);
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

describe("100 ops_health_report: every 077 check is preserved, the new one is last", () => {
  const ORIGINAL_ORDER = [
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
  ];

  it("the literal check_name assignments are 077's, in order, plus net_response_heap_mb at the end", () => {
    expect(literalCheckNames(body077)).toEqual([
      "cron_failed_runs_30m",
      "edge_http_errors_30m",
      "ingest_cycles_30m",
      "jev_shadow_last_run_min",
      "blindspot_veto_cron_min",
      "jev_alerts_unacked_72h",
      "dead_feeds",
    ]);
    expect(literalCheckNames(healthBody)).toEqual([
      ...literalCheckNames(body077),
      "net_response_heap_mb",
    ]);
    // the three per-zone rows come from the same foreach loop as in 077
    expect(healthCode).toMatch(/check_name\s*:=\s*'ingest_fresh_'\s*\|\|\s*v_zone\s*\|\|\s*'_min'/i);
  });

  it("the function comment lists all 11 rows in order and says 11", () => {
    const comment = /comment\s+on\s+function\s+public\.ops_health_report\(\)\s+is([\s\S]*?);\s*\n/i.exec(sql);
    expect(comment).not.toBeNull();
    const text = (comment as RegExpExecArray)[1] as string;
    expect(text).toMatch(/11 fixed rows/);
    const expected = [...ORIGINAL_ORDER, "net_response_heap_mb"];
    const positions = expected.map((n) => text.indexOf(n));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("077's whole body (comments and whitespace aside) is a verbatim prefix of the new body", () => {
    const old = norm(body077);
    expect(old.endsWith("return; end")).toBe(true);
    const oldHead = old.slice(0, old.length - "return; end".length);
    const now = norm(healthBody);
    expect(now.startsWith(oldHead)).toBe(true);
    const tail = now.slice(oldHead.length);
    expect(tail.startsWith("check_name := 'net_response_heap_mb'")).toBe(true);
    expect(tail.endsWith("return; end")).toBe(true);
    // the tail adds exactly one `return next;` (one new row) and declares nothing new
    expect(tail.match(/return next;/g)).toHaveLength(1);
  });

  it("sanity: the 077 file really is untouched by this suite's expectations (10 names in its comment)", () => {
    for (const n of ORIGINAL_ORDER) expect(sql077).toContain(n);
  });
});

describe("100 net_response_heap_mb check", () => {
  let block = "";
  beforeAll(() => {
    const start = healthCode.indexOf("check_name := 'net_response_heap_mb'");
    expect(start).toBeGreaterThan(0);
    block = healthCode.slice(start);
  });

  it("reports unknown when pg_net is absent, and swallows errors into an unknown row", () => {
    expect(block).toMatch(/pg_catalog\.to_regclass\(\s*'net\._http_response'\s*\)\s+is\s+null/i);
    expect(block).toMatch(/status\s*:=\s*'unknown'/i);
    expect(block).toMatch(/exception\s+when\s+others\s+then\s+status\s*:=\s*'unknown'/i);
    expect(block).toMatch(/end;\s*return\s+next\s*;/i);
  });

  it("measures pg_total_relation_size in MiB, the same quantity the compactor thresholds on", () => {
    expect(block).toMatch(
      /pg_catalog\.pg_total_relation_size\(\s*pg_catalog\.to_regclass\(\s*'net\._http_response'\s*\)\s*\)\s*\/\s*1048576(\.0)?/i,
    );
  });

  it("pass < 64, warn 64..200 inclusive, fail > 200, with threshold = 200 (the fail limit)", () => {
    expect(block).toMatch(/threshold\s*:=\s*200\s*;/);
    const m =
      /status\s*:=\s*case\s+when\s+v_n\s*>\s*(\d+)\s+then\s+'fail'\s+when\s+v_n\s*>=\s*(\d+)\s+then\s+'warn'\s+else\s+'pass'\s+end/i.exec(
        block,
      );
    expect(m).not.toBeNull();
    const failAbove = Number(m?.[1]);
    const warnFrom = Number(m?.[2]);
    expect(failAbove).toBe(200);
    expect(warnFrom).toBe(64);
    const classify = (mb: number) => (mb > failAbove ? "fail" : mb >= warnFrom ? "warn" : "pass");
    expect(classify(0)).toBe("pass");
    expect(classify(63.99)).toBe("pass");
    expect(classify(64)).toBe("warn");
    expect(classify(200)).toBe("warn");
    expect(classify(200.01)).toBe("fail");
    expect(classify(278)).toBe("fail"); // the 2026-10-21 incident size
  });
});

describe("100 ops_health_report: zone-map and source-kind parity with the bias-zone contract", () => {
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

describe("100 ops_health_report: exception handling", () => {
  it("has at least 9 'exception when others' blocks, each followed by a 'return next'", () => {
    expect([...healthCode.matchAll(/exception\s+when\s+others\s+then/gi)].length).toBeGreaterThanOrEqual(9);
    expect([...healthCode.matchAll(/end;\s*return\s+next\s*;/gi)].length).toBeGreaterThanOrEqual(9);
  });
});
