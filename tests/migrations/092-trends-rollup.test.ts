import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { BIAS_TO_ZONE } from "../../supabase/functions/_shared/cluster/blindspot";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 092 ("trends rollup table").
//
// 087 added a live view (trends_daily_zone_counts_ist) that /trends reads
// on demand; that group-by measures ~7.8s cold on production's Micro
// compute, close enough to PostgREST's 8s statement_timeout to throw
// "canceling statement due to statement timeout" during `next build`'s
// prerender (see src/lib/cache-resilience.ts's file header). 092 adds a
// pre-aggregated rollup TABLE kept current by an hourly pg_cron job
// instead, additive only -- it does not touch or drop the 087 view. Style
// mirrors tests/migrations/087-trends-istanbul-day.test.ts and
// tests/migrations/071-blindspot-recall-veto.test.ts: comments stripped
// before every regex assertion so prose can never satisfy a code guard.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "supabase", "migrations");
const MIGRATION = "092_trends_rollup.sql";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Strip `--` line comments so prose can never satisfy a code guard. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

describe("migration 092_trends_rollup.sql (SQL contract)", () => {
  let sql = "";
  let code = "";

  beforeAll(() => {
    const path = resolve(MIGRATIONS_DIR, MIGRATION);
    expect(existsSync(path), `${MIGRATION} must exist`).toBe(true);
    sql = read(path);
    code = stripComments(sql);
  });

  it("contains the ledger insert for '092'", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'092'\s*,\s*'092_trends_rollup'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("is wrapped in a single transaction", () => {
    expect(code).toMatch(/^\s*begin\s*;/im);
    expect(code).toMatch(/\bcommit\s*;\s*$/i);
  });

  it("is additive-only: no DROP TABLE, DROP VIEW, or destructive DML", () => {
    expect(code).not.toMatch(/\bdrop\s+(table|view)\b/i);
    expect(code).not.toMatch(/\balter\s+table\s+public\.articles\b/i);
    // TRUNCATE the DML statement is destructive; `revoke truncate ... on
    // <table> from anon, authenticated` (091's own pattern, mirrored here
    // for the new rollup table) is a privilege grant/revoke, not DML —
    // narrow the guard to the statement form, same as
    // 091-revoke-anon-write-grants.test.ts's `/\btruncate\s+table\b/i`.
    expect(code).not.toMatch(/\btruncate\s+table\b/i);
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
  });

  it("does not touch or drop the 087 view", () => {
    expect(code).not.toMatch(/drop\s+view\s+(public\.)?trends_daily_zone_counts_ist\b/i);
    expect(code).not.toMatch(
      /create\s+or\s+replace\s+view\s+(public\.)?trends_daily_zone_counts_ist\b(?!_rollup)/i,
    );
  });

  it("creates the rollup table with a (day, zone) primary key", () => {
    expect(code).toMatch(
      /create\s+table\s+if\s+not\s+exists\s+public\.trends_daily_zone_counts_ist_rollup\b/i,
    );
    expect(code).toMatch(/primary\s+key\s*\(\s*day\s*,\s*zone\s*\)/i);
  });

  it("constrains zone to the three Medya DNA zones", () => {
    expect(code).toMatch(
      /zone\s+text\s+not\s+null\s+check\s*\(\s*zone\s+in\s*\(\s*'iktidar'\s*,\s*'bagimsiz'\s*,\s*'muhalefet'\s*\)\s*\)/i,
    );
  });

  it("enables RLS and adds a public-read policy (mirrors 049/051)", () => {
    expect(code).toMatch(
      /alter\s+table\s+public\.trends_daily_zone_counts_ist_rollup\s+enable\s+row\s+level\s+security/i,
    );
    expect(code).toMatch(
      /create\s+policy\s+"public read trends_daily_zone_counts_ist_rollup"\s+on\s+public\.trends_daily_zone_counts_ist_rollup\s+for\s+select\s+using\s*\(\s*true\s*\)/i,
    );
  });

  it("grants select on the rollup table to anon, authenticated, service_role", () => {
    expect(code).toMatch(
      /grant\s+select\s+on\s+public\.trends_daily_zone_counts_ist_rollup\s+to\s+anon\s*,\s*authenticated\s*,\s*service_role\s*;/i,
    );
  });

  it("defines the refresh function as SECURITY DEFINER with search_path = ''", () => {
    expect(code).toMatch(
      /create\s+or\s+replace\s+function\s+public\.trends_daily_zone_counts_ist_refresh\s*\(/i,
    );
    expect(code).toMatch(/security\s+definer\s+set\s+search_path\s*=\s*''/i);
  });

  it("takes an advisory lock so overlapping refresh calls do not race", () => {
    expect(code).toMatch(/pg_try_advisory_xact_lock/i);
  });

  it("caps the refresh window at 40 days and batches one day at a time", () => {
    const m = code.match(/least\s*\(\s*greatest\s*\(\s*coalesce\s*\(\s*p_days\s*,\s*\d+\s*\)\s*,\s*\d+\s*\)\s*,\s*(\d+)\s*\)/i);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBeLessThanOrEqual(40);
    // Batched: a loop construct, not one bare 32/40-day group-by.
    expect(code).toMatch(/\bwhile\b|\bfor\b[\s\S]*?\bloop\b/i);
  });

  it("revokes execute from public/anon/authenticated and grants only service_role", () => {
    expect(code).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.trends_daily_zone_counts_ist_refresh\s*\(\s*integer\s*\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated/i,
    );
    expect(code).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.trends_daily_zone_counts_ist_refresh\s*\(\s*integer\s*\)\s+to\s+service_role\s*;/i,
    );
  });

  it("schedules an hourly pg_cron job guarded by an extension check", () => {
    expect(code).toMatch(/pg_extension\s+where\s+extname\s*=\s*'pg_cron'/i);
    expect(code).toMatch(/cron\.schedule\s*\(\s*'trends-rollup-refresh'\s*,\s*'0 \* \* \* \*'/i);
  });

  it("unschedules any pre-existing job of the same name before rescheduling", () => {
    expect(code).toMatch(
      /if\s+exists\s*\(\s*select\s+1\s+from\s+cron\.job\s+where\s+jobname\s*=\s*'trends-rollup-refresh'\s*\)\s+then\s+perform\s+cron\.unschedule\('trends-rollup-refresh'\)/i,
    );
  });

  it("runs a one-off 32-day backfill", () => {
    expect(code).toMatch(
      /select\s+public\.trends_daily_zone_counts_ist_refresh\s*\(\s*32\s*\)\s*;/i,
    );
  });

  it("filters to voting kinds only: s.kind in ('outlet', 'wire')", () => {
    expect(code).toMatch(/s\.kind\s+in\s*\(\s*'outlet'\s*,\s*'wire'\s*\)/i);
  });

  it("the zmap VALUES pairs deep-equal BIAS_TO_ZONE (mirrors 071/077's parity check)", () => {
    const span = /zmap\s*\(\s*bias_key\s*,\s*zone\s*\)\s+as\s*\(\s*values([\s\S]*?)\)\s*,\s*\n?\s*agg\s+as/i.exec(
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
    // No duplicated key hiding behind the record collapse.
    expect(count).toBe(Object.keys(BIAS_TO_ZONE).length);
    expect(parsed).toEqual(BIAS_TO_ZONE);
  });

  it("buckets by the Istanbul day of least(published_at, created_at), matching 087", () => {
    expect(code).toMatch(/least\s*\(\s*a\.published_at\s*,\s*a\.created_at\s*\)/i);
    expect(code).toMatch(/at\s+time\s+zone\s+'Europe\/Istanbul'/i);
  });

  it("anchors the per-day refresh window on the Istanbul day boundary, not a bare v_day::timestamptz (session-TimeZone-independent)", () => {
    // The bucketing key casts `least(published_at, created_at)` to Istanbul
    // time before taking `::date`. The window bound that's supposed to
    // cover the same Istanbul day must ALSO go through an explicit
    // `at time zone 'Europe/Istanbul'` cast — a bare `v_day::timestamptz`
    // instead uses the session's TimeZone setting (UTC on prod), anchoring
    // the window 3 hours later than the Istanbul day it's meant to cover.
    expect(code).not.toMatch(/v_day\s*::\s*timestamptz/i);
    expect(code).not.toMatch(/v_day\s*\+\s*\d+\s*\)?\s*::\s*timestamptz/i);
    // The lower bound must derive from an explicit Europe/Istanbul-zoned
    // cast of v_day.
    const windowClause = /a\.created_at\s*>=\s*\(v_day[^\n]*/i.exec(code);
    expect(windowClause).not.toBeNull();
    expect(windowClause![0]).toMatch(/v_day[\s\S]{0,60}at\s+time\s+zone\s+'Europe\/Istanbul'/i);
  });

  it("has NO upper created_at bound in the per-day aggregation (late-ingested rows bucket to old days)", () => {
    // least(published_at, created_at) can be many days older than
    // created_at, so `a.created_at < v_day + N` silently drops late rows.
    expect(code).not.toMatch(/a\.created_at\s*<\s*\(?\s*v_day/i);
  });

  it("also recomputes bucket days that received recently-ingested rows (repairs old days)", () => {
    expect(code).toMatch(/a\.created_at\s*>=\s*pg_catalog\.now\(\)\s*-\s*interval\s*'2 days'/i);
  });

  it("guards a MAINTAIN revoke behind server_version_num >= 170000", () => {
    expect(code).toMatch(/server_version_num[\s\S]{0,40}>=\s*170000/i);
    expect(code).toMatch(/revoke\s+maintain\s+on\s+public\.trends_daily_zone_counts_ist_rollup/i);
  });

  it("revokes anon/authenticated write privileges on the new rollup table (mirrors 091's unconditional TRUNCATE/TRIGGER/REFERENCES revoke, plus INSERT/UPDATE/DELETE since it has no write policy)", () => {
    expect(code).toMatch(
      /revoke\s+insert\s*,\s*update\s*,\s*delete\s*,\s*truncate\s*,\s*trigger\s*,\s*references\s+on\s+public\.trends_daily_zone_counts_ist_rollup\s+from\s+anon\s*,\s*authenticated\s*;/i,
    );
  });
});
