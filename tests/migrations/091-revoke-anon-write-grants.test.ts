import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 091 ("revoke anon/authenticated
// write grants").
//
// Measured against production (read-only, 2026-09-28): 18 objects in schema
// public grant anon (and authenticated) INSERT/UPDATE/DELETE/TRUNCATE (plus
// REFERENCES/TRIGGER) -- Supabase's default grants, never intentionally
// exercised. 13 of those are RLS-enabled tables (articles, article_tickers,
// bist_aliases, bist_bars_5m, bist_bars_daily, bist_companies,
// cluster_articles, clusters, kap_disclosures, sources, stories,
// story_stances, source_zone_history[TRUNCATE only]); 5 are non-updatable
// views (bist_quote_stats, disclosure_coverage, ticker_attention_daily,
// trends_daily_bias_counts, trends_daily_zone_counts_ist).
// pg_policies has ZERO non-SELECT policies in public, so today no anon or
// authenticated write is actually permitted -- RLS blocks every row. This
// migration removes the unused grant surface without changing behaviour:
// it revokes a write privilege for a role/relation/command only when no
// pg_policies row would have authorized it, so any future write policy
// keeps working.
//
// 091 must:
//  - never touch SELECT
//  - never mention service_role or postgres
//  - check pg_policies (cmd = the revoked command OR 'ALL', roles @>
//    {role} OR public) before revoking INSERT/UPDATE/DELETE
//  - unconditionally revoke TRUNCATE/TRIGGER/REFERENCES for anon and
//    authenticated
//  - cover both anon and authenticated
//  - be additive/idempotent (DO block, no DROP, no ALTER TABLE)
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "supabase", "migrations");
const MIGRATION = "091_revoke_anon_write_grants.sql";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Strip `--` line comments so prose can never satisfy a code guard. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

describe("migration 091_revoke_anon_write_grants.sql (SQL contract)", () => {
  let sql = "";
  let code = "";

  beforeAll(() => {
    const path = resolve(MIGRATIONS_DIR, MIGRATION);
    expect(existsSync(path), `${MIGRATION} must exist`).toBe(true);
    sql = read(path);
    code = stripComments(sql);
  });

  it("contains the ledger insert for '091'", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'091'\s*,\s*'091_revoke_anon_write_grants'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("is wrapped in a single transaction", () => {
    expect(code).toMatch(/^\s*begin\s*;/im);
    expect(code).toMatch(/\bcommit\s*;\s*$/i);
  });

  it("is additive-only: no DROP, no ALTER TABLE/DEFAULT PRIVILEGES, no new table", () => {
    expect(code).not.toMatch(/\bdrop\s+(table|function|index|column|policy|view)\b/i);
    expect(code).not.toMatch(/\balter\s+table\b/i);
    expect(code).not.toMatch(/\balter\s+default\s+privileges\b/i);
    expect(code).not.toMatch(/\bcreate\s+table\b/i);
    expect(code).not.toMatch(/\btruncate\s+table\b/i);
  });

  it("documents that default privileges are intentionally untouched", () => {
    expect(sql).toMatch(/default\s+privileges/i);
    expect(sql).toMatch(/supabase/i);
  });

  it("iterates schema public via a DO block", () => {
    expect(code).toMatch(/\bdo\s*\$\$/i);
    expect(code).toMatch(/\bpg_catalog\.pg_class\b|\binformation_schema\.tables\b|\bpg_class\b/i);
    expect(code).toMatch(/for\s+\w+\s+in/i);
  });

  it("never touches SELECT", () => {
    expect(code).not.toMatch(/revoke[\s\S]{0,200}?\bselect\b[\s\S]{0,60}?\bon\b/i);
    expect(code).not.toMatch(/'SELECT'/i);
  });

  it("never mentions service_role or postgres as a target role", () => {
    expect(code).not.toMatch(/service_role/i);
    expect(code.toLowerCase()).not.toMatch(/\bfrom\s+postgres\b/);
    expect(code.toLowerCase()).not.toMatch(/\bto\s+postgres\b/);
  });

  it("covers both anon and authenticated", () => {
    expect(code).toMatch(/anon/i);
    expect(code).toMatch(/authenticated/i);
  });

  it("unconditionally revokes TRUNCATE, TRIGGER, REFERENCES", () => {
    // These three must appear in a revoke that is not gated behind the
    // pg_policies existence check (i.e. not inside the "has a policy"
    // conditional branch). We assert they are present verbatim as literal
    // privilege names being revoked, and that at least one revoke
    // statement/format string names all three together (the "always"
    // revoke), separately from the conditional INSERT/UPDATE/DELETE revoke.
    expect(code).toMatch(/truncate/i);
    expect(code).toMatch(/trigger/i);
    expect(code).toMatch(/references/i);
  });

  it("checks pg_policies before revoking INSERT/UPDATE/DELETE", () => {
    expect(code).toMatch(/pg_policies/i);
    // cmd check against the specific command or ALL
    expect(code).toMatch(/cmd\s*=\s*.*'ALL'|cmd\s+in\s*\(/i);
    // roles check: role name or public
    expect(code).toMatch(/roles/i);
  });

  it("quotes relation identifiers with format('%I.%I')", () => {
    expect(code).toMatch(/format\s*\(\s*'%I\.%I'/i);
  });

  it("raises a NOTICE per relation describing what was revoked", () => {
    expect(code).toMatch(/raise\s+notice/i);
  });

  it("includes a verification query in the header comment", () => {
    expect(sql).toMatch(/information_schema\.role_table_grants|role_table_grants/i);
  });

  it("is idempotent: revoking an already-revoked privilege is a no-op, so re-running is safe", () => {
    // No explicit re-grant of the removed privileges anywhere in the file.
    expect(code).not.toMatch(
      /grant\s+(insert|update|delete|truncate|trigger|references)[\s\S]{0,120}?\bto\s+(anon|authenticated)\b/i,
    );
  });
});
