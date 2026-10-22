import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { FEED_YIELD_WINDOW_MS } from "@/lib/clusters/feed-health";
import { VOTING_SOURCE_KINDS } from "@/lib/bias/config";
import {
  STATUS_CLUSTER_FAIL_MIN,
  STATUS_CLUSTER_WARN_MIN,
  STATUS_FEEDS_FAIL_SILENT_SHARE,
  STATUS_FEEDS_WARN_SILENT_SHARE,
  STATUS_LOOKBACK_HOURS,
} from "@/lib/status/verdict";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 110 ("public_status"): ONE read-only
// SECURITY DEFINER function, public.public_status_snapshot(), that /durum
// reads through the service-role reader client. It returns safe aggregates
// only (timestamps by bias, counts, booleans). Comments are stripped before
// every code assertion so prose can never satisfy a guard (same style as the
// 106 and 108 tests).
//
// The migration deliberately contains no zone vocabulary: ingest is grouped
// by bias and collapsed to zones in TypeScript through BIAS_TO_ZONE, so this
// file is not a new bias->zone copy (tests/migrations/zone-parity.test.ts
// KNOWN_FILES stays untouched).
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "supabase", "migrations");
const MIGRATION = resolve(MIGRATIONS_DIR, "110_public_status.sql");
const MIGRATION_108 = resolve(MIGRATIONS_DIR, "108_jev_stall_check_v2.sql");

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

let raw = "";
let code = "";
let fnBlock = "";
let fnHeader = "";
let fnBody = "";

beforeAll(() => {
  expect(existsSync(MIGRATION), "110_public_status.sql must exist").toBe(true);
  raw = readFileSync(MIGRATION, "utf8");
  code = stripComments(raw);
  const m = code.match(
    /create\s+or\s+replace\s+function\s+public\.public_status_snapshot\s*\(\s*\)[\s\S]*?\$fn\$[\s\S]*?\$fn\$\s*;/i,
  );
  if (!m) throw new Error("public_status_snapshot() block not found");
  fnBlock = m[0];
  fnHeader = fnBlock.slice(0, fnBlock.search(/\bas\s+\$fn\$/i));
  const b = fnBlock.match(/\$fn\$([\s\S]*?)\$fn\$/);
  fnBody = b?.[1] ?? "";
});

describe("110 structure", () => {
  it("is wrapped in exactly one begin/commit with the ledger insert last", () => {
    expect([...code.matchAll(/^\s*begin\s*;/gim)]).toHaveLength(1);
    expect([...code.matchAll(/^\s*commit\s*;/gim)]).toHaveLength(1);
    const ledger = code.search(/insert\s+into\s+supabase_migrations\.schema_migrations/i);
    expect(ledger).toBeGreaterThan(code.search(/grant\s+execute\s+on\s+function/i));
    expect(ledger).toBeLessThan(code.search(/^\s*commit\s*;/im));
    const afterLedger = code.slice(ledger).replace(/^[\s\S]*?on\s+conflict\s+do\s+nothing\s*;/i, "");
    expect(afterLedger.trim()).toBe("commit;");
  });

  it("records itself as version '110' in the 095 pattern", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(version,\s*name\)\s*values\s*\(\s*'110'\s*,\s*'110_public_status'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
    expect([...code.matchAll(/insert\s+into\s+supabase_migrations\.schema_migrations/gi)]).toHaveLength(1);
  });

  it("sanity: comment stripping is non-vacuous", () => {
    expect(raw.length).toBeGreaterThan(code.length);
  });

  it("creates exactly one function and nothing else: no table, no alter, no drop, no cron", () => {
    const creates = [...code.matchAll(/create\s+(?:or\s+replace\s+)?(\w+)\s+(?:function\s+)?(public\.\w+)/gi)].map(
      (m) => `${m[1]!.toLowerCase()} ${m[2]}`,
    );
    expect(creates).toEqual(["function public.public_status_snapshot"]);
    expect(code).not.toMatch(/\bcreate\s+table\b/i);
    expect(code).not.toMatch(/\balter\s+/i);
    expect(code).not.toMatch(/\bdrop\s+/i);
    expect(code).not.toMatch(/\bcron\.(schedule|unschedule)\s*\(/i);
  });
});

describe("110 function header", () => {
  it("returns jsonb, plpgsql, stable, security definer, search_path = ''", () => {
    expect(collapse(fnHeader)).toMatch(
      /^create or replace function public\.public_status_snapshot\(\) returns jsonb language plpgsql stable security definer set search_path = ''$/i,
    );
  });
});

describe("110 grants", () => {
  it("revokes from public, anon and authenticated, and grants execute to service_role only", () => {
    expect(code).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.public_status_snapshot\(\)\s+from\s+public,\s*anon,\s*authenticated\s*;/i,
    );
    expect(code).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.public_status_snapshot\(\)\s+to\s+service_role\s*;/i,
    );
    const grants = [...code.matchAll(/(^|;)\s*grant\b[^;]*;/gi)];
    expect(grants).toHaveLength(1);
    expect(grants[0]![0]).not.toMatch(/\bto\b[^;]*\b(anon|authenticated|public)\b/i);
  });

  it("grants nothing on any table, and creates none (so no table-grant revoke block is owed)", () => {
    expect(code).not.toMatch(/\bgrant\b[^;]*\bon\s+table\b/i);
    expect(code).not.toMatch(/\bgrant\b[^;]*\b(insert|update|delete|truncate|maintain|select)\b/i);
    expect(code).not.toMatch(/\bcreate\s+table\b/i);
  });

  it("writes nothing: the only insert is the ledger row; no update/delete/truncate anywhere", () => {
    const inserts = [...code.matchAll(/\binsert\s+into\s+([\w.]+)/gi)].map((m) => m[1]);
    expect(inserts).toEqual(["supabase_migrations.schema_migrations"]);
    expect(code).not.toMatch(/\bupdate\s+[\w.]+\s+set\b/i);
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(fnBody).not.toMatch(/\b(insert|update|delete|truncate)\b/i);
  });
});

describe("110 leak guards", () => {
  it("the RAW file (comments included) carries no zone vocabulary", () => {
    expect(raw).not.toMatch(/iktidar|bagimsiz|muhalefet/i);
  });

  it("has no sqlerrm: no error text can reach the payload", () => {
    expect(code).not.toMatch(/sqlerrm/i);
    expect(code).not.toMatch(/sqlstate/i);
    expect(code).not.toMatch(/get\s+stacked\s+diagnostics/i);
  });

  it("never selects job names, commands, urls, content or error text", () => {
    for (const col of ["command", "url", "content", "error_msg", "return_message", "database", "username"]) {
      expect(fnBody, col).not.toMatch(new RegExp(`\\b${col}\\b`, "i"));
    }
    expect(fnBody).not.toMatch(/\bnet\.|_http_response|job_run_details/i);
    // jobname appears only as the equality predicate on the jev-shadow job
    const uses = [...fnBody.matchAll(/\bjobname\b/gi)];
    expect(uses).toHaveLength(1);
    expect(fnBody).toMatch(/where\s+j\.jobname\s*=\s*'jev-shadow'/i);
  });

  it("the only dynamic SQL is the cron.job activity flag, as one boolean", () => {
    const queries = [...fnBody.matchAll(/execute\s+\$q\$([\s\S]*?)\$q\$/gi)].map((m) => collapse(m[1]!));
    expect(queries).toEqual([
      "select coalesce(pg_catalog.bool_and(not j.active), false) from cron.job j where j.jobname = 'jev-shadow'",
    ]);
    expect(fnBody).toMatch(/pg_catalog\.to_regclass\('cron\.job'\)\s+is\s+not\s+null/i);
  });

  it("the comment on the function says safe aggregates only", () => {
    expect(code).toMatch(/comment\s+on\s+function\s+public\.public_status_snapshot\(\)\s+is\s+'[^']*safe aggregates only[^']*'/i);
  });
});

describe("110 payload shape", () => {
  it("the jsonb_build_object key set is exactly the documented one", () => {
    const start = fnBody.search(/return\s+pg_catalog\.jsonb_build_object\s*\(/i);
    expect(start).toBeGreaterThan(-1);
    const ret = fnBody.slice(start);
    const keys = new Set([...ret.matchAll(/'([a-z_]+)'\s*,/gi)].map((m) => m[1]));
    expect(keys).toEqual(
      new Set([
        "generated_at",
        "ingest",
        "ok",
        "last_by_bias",
        "clustering",
        "last_at",
        "labelling",
        "paused",
        "feeds",
        "active",
        "silent",
      ]),
    );
  });

  it("each of the four sections is isolated in its own exception block", () => {
    expect([...fnBody.matchAll(/exception\s+when\s+others\s+then/gi)]).toHaveLength(4);
  });

  it("every built-in call is schema-qualified (search_path is empty) and every table is schema-qualified", () => {
    const unqualified = [
      ...fnBody.matchAll(
        /(?<![\w.])(now|max|min|count|jsonb_build_object|jsonb_object_agg|bool_and|to_regclass)\s*\(/gi,
      ),
    ].map((m) => m[1]);
    expect(unqualified).toEqual([]);
    const relations = [...fnBody.matchAll(/\b(?:from|join)\s+([\w.]+)/gi)].map((m) => m[1]);
    expect(relations.length).toBeGreaterThan(0);
    for (const rel of relations) expect(rel, rel).toMatch(/^(public|cron)\./);
  });

  it("ingest reads articles.created_at of active VOTING sources, grouped by bias only", () => {
    expect(fnBody).toMatch(/pg_catalog\.max\(a\.created_at\)/i);
    expect(fnBody).toMatch(/group\s+by\s+s\.bias/i);
    expect(fnBody).toMatch(/s\.active\s+and\s+s\.kind\s+in\s*\(/i);
  });

  it("clustering reads max(clusters.updated_at) bounded by now()", () => {
    expect(fnBody).toMatch(/pg_catalog\.max\(c\.updated_at\)[\s\S]*?from\s+public\.clusters\s+c/i);
    expect(fnBody).toMatch(/c\.updated_at\s*<=\s*v_now/i);
  });
});

describe("110 parity with the TypeScript constants", () => {
  it("interval '72 hours' equals FEED_YIELD_WINDOW_MS (the /kaynaklar/durum window)", () => {
    const hours = [...fnBody.matchAll(/interval\s+'(\d+)\s+hours'/gi)].map((m) => Number(m[1]));
    expect(hours).toContain(FEED_YIELD_WINDOW_MS / 3.6e6);
    expect(FEED_YIELD_WINDOW_MS / 3.6e6).toBe(72);
  });

  it("interval '6 hours' equals STATUS_LOOKBACK_HOURS", () => {
    const hours = [...fnBody.matchAll(/interval\s+'(\d+)\s+hours'/gi)].map((m) => Number(m[1]));
    expect(hours).toContain(STATUS_LOOKBACK_HOURS);
    // and nothing else: the only windows are the lookback and the yield window
    expect([...new Set(hours)].sort((a, b) => a - b)).toEqual([STATUS_LOOKBACK_HOURS, FEED_YIELD_WINDOW_MS / 3.6e6]);
  });

  it("the kind-in set equals VOTING_SOURCE_KINDS", () => {
    const m = /s\.kind\s+in\s*\(([^)]*)\)/i.exec(fnBody);
    expect(m).not.toBeNull();
    const kinds = [...m![1]!.matchAll(/'([a-z_]+)'/gi)].map((x) => x[1]);
    expect(new Set(kinds)).toEqual(new Set(VOTING_SOURCE_KINDS));
  });

  it("the labelling predicate is the one 108's ops check 5 uses", () => {
    const predicate = "status in ('ok', 'budget_exceeded') or r.calls > 0";
    expect(collapse(fnBody)).toContain(predicate);
    expect(collapse(stripComments(readFileSync(MIGRATION_108, "utf8")))).toContain(predicate);
  });

  it("the feeds query is the /kaynaklar/durum yield probe: active sources, published_at, bounded by now", () => {
    expect(fnBody).toMatch(/a\.published_at\s*>=\s*v_now\s*-\s*interval\s+'72 hours'/i);
    expect(fnBody).toMatch(/a\.published_at\s*<=\s*v_now/i);
    expect(fnBody).toMatch(/from\s+public\.sources\s+s\s+where\s+s\.active/i);
  });
});

describe("110 header documentation", () => {
  let head = "";
  beforeAll(() => {
    head = raw.slice(0, raw.search(/^\s*begin\s*;/im));
  });

  it("documents purpose, Step 0 findings, the dry run, rollback and idempotence", () => {
    expect(head).toMatch(/STEP 0 FINDINGS/);
    expect(head).toMatch(/DRY RUN \(local PG15\)/);
    expect(head).toMatch(/Rollback/i);
    expect(head).toMatch(/drop function public\.public_status_snapshot\(\)/i);
    expect(head).toMatch(/ledger row 110/i);
    expect(head).toMatch(/safe to re-apply/i);
    expect(head).toMatch(/service_role/);
  });

  it("the Step 0 numbers in the header match the constants in verdict.ts", () => {
    const fail = /STATUS_CLUSTER_FAIL_MIN\s*=\s*(\d+)/.exec(head);
    const warn = /STATUS_CLUSTER_WARN_MIN\s*=\s*(\d+)/.exec(head);
    expect(Number(fail?.[1])).toBe(STATUS_CLUSTER_FAIL_MIN);
    expect(Number(warn?.[1])).toBe(STATUS_CLUSTER_WARN_MIN);
    const fw = /STATUS_FEEDS_WARN_SILENT_SHARE\s*=\s*([\d.]+)/.exec(head);
    const ff = /STATUS_FEEDS_FAIL_SILENT_SHARE\s*=\s*([\d.]+)/.exec(head);
    expect(Number(fw?.[1])).toBe(STATUS_FEEDS_WARN_SILENT_SHARE);
    expect(Number(ff?.[1])).toBe(STATUS_FEEDS_FAIL_SILENT_SHARE);
  });

  it("records the measured timing of the four bodies and the warm budget", () => {
    expect(head).toMatch(/ingest/i);
    expect(head).toMatch(/\bms\b/);
    expect(head).toMatch(/< ?2 s/);
  });
});
