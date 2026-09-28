import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { BIAS_TO_ZONE, ZONE_KEYS } from "../../supabase/functions/_shared/cluster/blindspot";
import { VOTING_SOURCE_KINDS } from "../../supabase/functions/_shared/cluster/source-kind";

// Migration 077 (ops heartbeat) carries the eighth hand-written SQL copy of
// the bias-zone contract (a VALUES list, same shape as 071's), plus the
// safety/read-only properties the ops_health_report() SECURITY DEFINER
// function must hold: hardened search_path, service_role-only execute, no
// writes, and cron/net access only through EXECUTE behind to_regclass so a
// project missing pg_cron or pg_net still returns 10 rows instead of raising.

const MIGRATION = resolve(
  __dirname,
  "..",
  "..",
  "supabase",
  "migrations",
  "077_ops_health_report.sql",
);

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

let sql = "";
let code = "";
beforeAll(() => {
  sql = readFileSync(MIGRATION, "utf8");
  code = stripSqlComments(sql);
});

describe("077 ledger and structure", () => {
  it("is wrapped in begin/commit", () => {
    expect(code).toMatch(/\bbegin\s*;/i);
    expect(code).toMatch(/\bcommit\s*;/i);
  });

  it("records itself as version '077'", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(version,\s*name\)\s*values\s*\(\s*'077'\s*,\s*'077_ops_health_report'\s*\)/i,
    );
  });

  it("sanity: comment stripping is non-vacuous", () => {
    expect(sql.length).toBeGreaterThan(code.length);
  });
});

describe("077 function safety", () => {
  it("is plpgsql SECURITY DEFINER with an empty search_path", () => {
    expect(code).toMatch(
      /create\s+or\s+replace\s+function\s+public\.ops_health_report\s*\(\s*\)[\s\S]*?language\s+plpgsql[\s\S]{0,80}security\s+definer[\s\S]{0,80}set\s+search_path\s*=\s*''/i,
    );
  });

  it("declares #variable_conflict use_column", () => {
    expect(code).toMatch(/#variable_conflict\s+use_column/i);
  });

  it("returns exactly (check_name, status, observed, threshold, detail), with no output column named check/value/position", () => {
    const m = /returns\s+table\s*\(([^)]+)\)/i.exec(code);
    expect(m).not.toBeNull();
    const cols = (m as RegExpExecArray)[1]
      .split(",")
      .map((c) => c.trim().split(/\s+/)[0]?.toLowerCase());
    expect(cols).toEqual(["check_name", "status", "observed", "threshold", "detail"]);
    for (const forbidden of ["check", "value", "position"]) {
      expect(cols).not.toContain(forbidden);
    }
  });

  it("revokes execute from public/anon/authenticated and grants it only to service_role", () => {
    expect(code).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.ops_health_report\(\)\s+from\s+public,\s*anon,\s*authenticated/i,
    );
    expect(code).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.ops_health_report\(\)\s+to\s+service_role\s*;/i,
    );
    const grants = [...code.matchAll(/grant\s+execute\s+on\s+function\s+public\.ops_health_report[^;]*;/gi)];
    expect(grants).toHaveLength(1);
  });

  it("is read-only: no writes anywhere in the file", () => {
    expect(code).not.toMatch(/\binsert\s+into\s+public\./i);
    expect(code).not.toMatch(/\bupdate\s+public\./i);
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bcreate\s+table\b/i);
    expect(code).not.toMatch(/\balter\s+table\b/i);
    expect(code).not.toMatch(/\bcron\.schedule\s*\(/i);
  });

  it("never mentions return_message or cron.job.command", () => {
    expect(code).not.toMatch(/return_message/i);
    expect(code).not.toMatch(/\bcommand\b/i);
  });

  it("calls to_regclass for cron.job_run_details, cron.job and net._http_response", () => {
    expect(code).toMatch(/to_regclass\(\s*'cron\.job_run_details'\s*\)/i);
    expect(code).toMatch(/to_regclass\(\s*'cron\.job'\s*\)/i);
    expect(code).toMatch(/to_regclass\(\s*'net\._http_response'\s*\)/i);
  });

  it("every cron.* / net.* table reference sits inside an EXECUTE string", () => {
    // Strip every EXECUTE $q$ ... $q$ block (and the to_regclass string
    // literals, which are just string arguments, not identifier references).
    const withoutToRegclass = code.replace(/to_regclass\(\s*'[^']*'\s*\)/gi, "to_regclass(…)");
    const withoutExecuteBlocks = withoutToRegclass.replace(/execute\s+\$q\$[\s\S]*?\$q\$/gi, "EXECUTED");
    // Only real table/column references remain a concern; the object names
    // "cron.job" / "net._http_response" etc. never appear outside EXECUTE.
    expect(withoutExecuteBlocks).not.toMatch(/\bcron\.(job|job_run_details)\b/i);
    expect(withoutExecuteBlocks).not.toMatch(/\bnet\._http_response\b/i);
  });
});

describe("077 the 10 fixed check names, in order", () => {
  it("appear in the fixed order", () => {
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
    ];
    // The zone names come from a foreach loop over an array literal, not
    // literal check_name assignments, so match those three separately.
    const literalNames = [...code.matchAll(/check_name\s*:=\s*'([a-z0-9_]+)'\s*;/gi)].map((m) => m[1]);
    expect(literalNames).toEqual([
      "cron_failed_runs_30m",
      "edge_http_errors_30m",
      "ingest_cycles_30m",
      "jev_shadow_last_run_min",
      "blindspot_veto_cron_min",
      "jev_alerts_unacked_72h",
      "dead_feeds",
    ]);
    expect(code).toMatch(/check_name\s*:=\s*'ingest_fresh_'\s*\|\|\s*v_zone\s*\|\|\s*'_min'/i);
    // Sanity: the full fixed order, as documented in the function comment,
    // mentions all 10 in order.
    const commentOrder = expected.filter((name) => sql.includes(name));
    expect(commentOrder).toEqual(expected);
  });
});

describe("077 zone-map and source-kind parity with the bias-zone contract", () => {
  it("the zmap VALUES pairs deep-equal BIAS_TO_ZONE, with no duplicates", () => {
    const span = /zmap\s*\(\s*bias_key\s*,\s*zone\s*\)\s+as\s*\(\s*values([\s\S]*?)\)\s*\n?\s*select/i.exec(
      code,
    );
    expect(span).not.toBeNull();
    const body = (span as RegExpExecArray)[1] as string;
    const parsed: Record<string, string> = {};
    const pairRe = /\(\s*'([a-z_]+)'\s*,\s*'([a-z]+)'\s*\)/g;
    let m: RegExpExecArray | null;
    let count = 0;
    while ((m = pairRe.exec(body)) !== null) {
      parsed[m[1] as string] = m[2] as string;
      count += 1;
    }
    expect(count).toBe(Object.keys(BIAS_TO_ZONE).length);
    expect(parsed).toEqual({ ...BIAS_TO_ZONE });
  });

  it("the zone loop's array literal equals ZONE_KEYS", () => {
    const m = /foreach\s+v_zone\s+in\s+array\s+array\s*\[([^\]]+)\]/i.exec(code);
    expect(m).not.toBeNull();
    const items = [...((m as RegExpExecArray)[1] as string).matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    expect(items).toEqual([...ZONE_KEYS]);
  });

  it("every 's.kind in (...)' list equals VOTING_SOURCE_KINDS, and there are exactly 2 of them", () => {
    const lists = [...code.matchAll(/s\.kind\s+in\s*\(([^)]+)\)/gi)];
    expect(lists).toHaveLength(2);
    for (const l of lists) {
      const kinds = [...(l[1] as string).matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
      expect(new Set(kinds)).toEqual(new Set(VOTING_SOURCE_KINDS));
    }
  });
});

describe("077 exception handling", () => {
  it("has at least 8 'exception when others' blocks, each followed by a 'return next'", () => {
    const blocks = [...code.matchAll(/exception\s+when\s+others\s+then/gi)];
    expect(blocks.length).toBeGreaterThanOrEqual(8);

    const returnNexts = [...code.matchAll(/return\s+next\s*;/gi)];
    expect(returnNexts.length).toBeGreaterThanOrEqual(8);

    // Every exception block is immediately followed (before the next
    // exception/begin block) by a `return next;` before anything mutates
    // check_name again -- i.e. `end;\n  return next;` right after each catch.
    const endThenReturnNext = [...code.matchAll(/end;\s*return\s+next\s*;/gi)];
    expect(endThenReturnNext.length).toBeGreaterThanOrEqual(8);
  });
});
