import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 087 ("trends Istanbul-day view").
//
// /trends (migration 023) buckets by UTC calendar day over all source
// kinds. 087 adds a NEW additive view, trends_daily_zone_counts_ist,
// bucketed by the Europe/Istanbul calendar day of
// least(published_at, created_at), voting kinds only -- it does not touch
// the old view or its consumer (src/lib/clusters/trends-query.ts, a
// separate wave's file). Style mirrors
// tests/migrations/072-framing-draw-fast.test.ts: comments stripped
// before every regex assertion so prose can never satisfy a code guard.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "supabase", "migrations");
const MIGRATION = "087_trends_istanbul_day.sql";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Strip `--` line comments so prose can never satisfy a code guard. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

describe("migration 087_trends_istanbul_day.sql (SQL contract)", () => {
  let sql = "";
  let code = "";

  beforeAll(() => {
    const path = resolve(MIGRATIONS_DIR, MIGRATION);
    expect(existsSync(path), `${MIGRATION} must exist`).toBe(true);
    sql = read(path);
    code = stripComments(sql);
  });

  it("contains the ledger insert for '087'", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'087'\s*,\s*'087_trends_istanbul_day'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("is wrapped in a single transaction", () => {
    expect(code).toMatch(/^\s*begin\s*;/im);
    expect(code).toMatch(/\bcommit\s*;\s*$/i);
  });

  it("is additive-only: no DROP, ALTER TABLE, UPDATE or DELETE", () => {
    expect(code).not.toMatch(/\bdrop\s+(table|function|index|column|policy|view)\b/i);
    expect(code).not.toMatch(/\balter\s+table\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\b(delete\s+from|update\s+public\.)/i);
  });

  it("does not touch the old trends_daily_bias_counts view", () => {
    expect(code).not.toMatch(/create\s+or\s+replace\s+view\s+(public\.)?trends_daily_bias_counts\b/i);
  });

  it("creates a NEW security_invoker view: trends_daily_zone_counts_ist", () => {
    expect(code).toMatch(
      /create\s+or\s+replace\s+view\s+public\.trends_daily_zone_counts_ist\b/i,
    );
    expect(code).toMatch(/security_invoker\s*=\s*true/i);
  });

  it("buckets by the Istanbul day of least(published_at, created_at)", () => {
    expect(code).toMatch(/least\s*\(\s*a\.published_at\s*,\s*a\.created_at\s*\)/i);
    expect(code).toMatch(/at\s+time\s+zone\s+'Europe\/Istanbul'/i);
  });

  it("bounds created_at between 31 and 40 days", () => {
    const m = code.match(/a\.created_at\s*>=\s*now\(\)\s*-\s*interval\s*'(\d+)\s+days'/i);
    expect(m).not.toBeNull();
    const days = Number(m?.[1]);
    expect(days).toBeGreaterThanOrEqual(31);
    expect(days).toBeLessThanOrEqual(40);
  });

  it("filters to voting kinds only: s.kind in ('outlet', 'wire')", () => {
    expect(code).toMatch(/s\.kind\s+in\s*\(\s*'outlet'\s*,\s*'wire'\s*\)/i);
  });

  it("grants select on the new view to anon, authenticated, service_role", () => {
    expect(code).toMatch(
      /grant\s+select\s+on\s+public\.trends_daily_zone_counts_ist\s+to\s+anon\s*,\s*authenticated\s*,\s*service_role\s*;/i,
    );
  });

  it("adds a covering index for the new view", () => {
    expect(code).toMatch(
      /create\s+index\s+if\s+not\s+exists\s+idx_articles_created_published_source\s+on\s+public\.articles\s*\(\s*created_at\s*\)\s+include\s*\(\s*published_at\s*,\s*source_id\s*\)/i,
    );
  });

  it("keeps the zone CASE in the same shape as 023 (10 bias keys mapped)", () => {
    const whens = code.match(/when\s+'[a-z_]+'\s+then\s+'[a-z]+'/gi) ?? [];
    expect(whens.length).toBe(10);
  });
});
