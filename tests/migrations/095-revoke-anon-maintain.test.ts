import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Static SQL-contract test for migration 095 (revoke the PostgreSQL 17
// MAINTAIN privilege from anon/authenticated on every public relation).

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATION = resolve(
  REPO_ROOT,
  "supabase",
  "migrations",
  "095_revoke_anon_maintain.sql",
);

/** Strip `--` line comments so prose can never satisfy a code guard. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

describe("migration 095_revoke_anon_maintain.sql (SQL contract)", () => {
  let sql = "";
  let code = "";

  beforeAll(() => {
    sql = readFileSync(MIGRATION, "utf8");
    code = stripComments(sql);
  });

  it("records itself in the migration ledger idempotently", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'095'\s*,\s*'095_revoke_anon_maintain'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("is wrapped in begin; ... commit;", () => {
    const trimmed = code.trim();
    expect(trimmed).toMatch(/^begin;/i);
    expect(trimmed).toMatch(/commit;$/i);
  });

  it("guards on server_version_num >= 170000 before the first revoke", () => {
    expect(code).toMatch(/server_version_num[\s\S]{0,80}170000/i);
    const guard = code.search(/server_version_num[\s\S]{0,80}170000/i);
    const ret = code.indexOf("return;", guard);
    const firstRevoke = code.search(/revoke\s+maintain/i);
    expect(ret).toBeGreaterThan(guard);
    expect(firstRevoke).toBeGreaterThan(ret);
  });

  it("checks that anon and authenticated roles exist", () => {
    expect(code).toMatch(/pg_roles/i);
    expect(code).toMatch(/rolname\s*=\s*'anon'/i);
    expect(code).toMatch(/rolname\s*=\s*'authenticated'/i);
  });

  it("iterates the catalog for public relations", () => {
    expect(code).toMatch(/pg_catalog\.pg_class/i);
    expect(code).toMatch(/nspname\s*=\s*'public'/i);
    expect(code).toMatch(/relkind\s+in\s*\(\s*'r'\s*,\s*'p'\s*,\s*'v'\s*,\s*'m'\s*\)/i);
  });

  it("revokes via format() with %I.%I from anon, authenticated", () => {
    expect(code).toContain(
      "format('revoke maintain on table %I.%I from anon, authenticated'",
    );
  });

  it("every revoke revokes exactly maintain (never SELECT)", () => {
    const matches = [...code.matchAll(/revoke\s+([a-z_,\s]+?)\s+on\b/gi)];
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) {
      expect(m[1].toLowerCase()).toBe("maintain");
    }
  });

  it("contains no grants, service_role, postgres, default privileges or DDL", () => {
    // Statement form only: the summary NOTICE text legitimately says "grant(s)".
    expect(code).not.toMatch(/\bgrant\s+[a-z_,\s]+?\s+on\b/i);
    expect(code).not.toMatch(/service_role/i);
    expect(code).not.toMatch(/\b(from|to)\s+postgres\b/i);
    expect(code).not.toMatch(/alter\s+default\s+privileges/i);
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(code).not.toMatch(/alter\s+table/i);
    expect(code).not.toMatch(/create\s+table/i);
    expect(code).not.toMatch(/\btruncate\b/i);
  });

  it("uses aclexplode and 'MAINTAIN' for before/after accounting", () => {
    expect(code).toMatch(/aclexplode/i);
    expect(code).toContain("'MAINTAIN'");
  });

  it("reports with raise notice and raise warning for leftovers", () => {
    expect(code).toMatch(/raise\s+notice/i);
    expect(code).toMatch(/raise\s+warning/i);
  });

  it("documents evidence and verification in the header", () => {
    expect(sql).toMatch(/aclexplode/);
    expect(sql).toMatch(/MAINTAIN/);
    expect(sql).toContain("sources_rss_backup_093");
    expect(sql).toContain("trends_daily_zone_counts_ist_rollup");
    expect(sql).toContain("sources_fetch_state_backup_094");
    expect(sql).toMatch(/default privileges/i);
  });

  it("names no specific relation in code", () => {
    for (const name of [
      "articles",
      "clusters",
      "sources",
      "trends_daily_zone_counts_ist_rollup",
    ]) {
      expect(code).not.toMatch(new RegExp(`public\\.${name}\\b`, "i"));
    }
  });
});
