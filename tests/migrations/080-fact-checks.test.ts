import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { FACT_CHECK_PUBLISHER_KEYS } from "@/lib/fact-checks/feeds";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 080 ("Bu konuda doğrulama").
//
// Additive only: two new tables (fact_checks, cluster_fact_checks), their
// indexes, RLS policies and grants. No existing object is touched, no
// function/SECURITY DEFINER surface is introduced.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "supabase", "migrations");
const MIGRATION = "080_fact_checks.sql";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Strip `--` line comments so prose can never satisfy a code guard. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

describe("migration 080_fact_checks.sql (SQL contract)", () => {
  let code = "";

  beforeAll(() => {
    const path = resolve(MIGRATIONS_DIR, MIGRATION);
    expect(existsSync(path), `${MIGRATION} must exist`).toBe(true);
    code = stripComments(read(path));
  });

  it("contains the ledger insert for '080' and is wrapped in a transaction", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'080'\s*,\s*'080_fact_checks'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
    expect(code).toMatch(/^\s*begin\s*;/im);
    expect(code).toMatch(/\bcommit\s*;\s*$/i);
  });

  it("creates exactly two tables", () => {
    const matches = code.match(/\bcreate\s+table\b/gi) ?? [];
    expect(matches.length).toBe(2);
    expect(code).toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.fact_checks/i);
    expect(code).toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.cluster_fact_checks/i);
  });

  it("is additive-only: no drop, no truncate, no delete/update, no security definer", () => {
    expect(code).not.toMatch(/\bdrop\s+(table|function|index|column|policy|view)\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    expect(code).not.toMatch(/\bupdate\s+public\./i);
    expect(code).not.toMatch(/\bsecurity\s+definer\b/i);
  });

  it("only alters tables to enable RLS on the two new tables", () => {
    const alters = code.match(/\balter\s+table\s+[^\n;]*/gi) ?? [];
    expect(alters.length).toBeGreaterThan(0);
    for (const stmt of alters) {
      expect(stmt).toMatch(/\benable\s+row\s+level\s+security\b/i);
      expect(stmt).toMatch(/public\.(fact_checks|cluster_fact_checks)\b/i);
    }
  });

  it("the fact_checks column list never stores description/content/summary/body/excerpt/image (copyright guard)", () => {
    const m = code.match(/create\s+table\s+if\s+not\s+exists\s+public\.fact_checks\s*\(([\s\S]*?)\)\s*;/i);
    expect(m).not.toBeNull();
    const cols = m![1]!.toLowerCase();
    for (const forbidden of ["description", "content", "summary", "body", "excerpt", "image"]) {
      expect(cols).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
  });

  it("the publisher CHECK list is exactly FACT_CHECK_PUBLISHER_KEYS (parity)", () => {
    const m = code.match(/publisher\s+text\s+not\s+null\s+check\s*\(\s*publisher\s+in\s*\(([^)]+)\)\s*\)/i);
    expect(m).not.toBeNull();
    const keys = m![1]!
      .split(",")
      .map((s) => s.trim().replace(/^'|'$/g, ""));
    expect(keys).toEqual([...FACT_CHECK_PUBLISHER_KEYS]);
  });

  it("enables RLS on both tables", () => {
    expect(code).toMatch(/alter\s+table\s+public\.fact_checks\s+enable\s+row\s+level\s+security/i);
    expect(code).toMatch(/alter\s+table\s+public\.cluster_fact_checks\s+enable\s+row\s+level\s+security/i);
  });

  it("grants anon/authenticated SELECT only -- no insert/update/delete grant", () => {
    expect(code).toMatch(/grant\s+select\s+on\s+public\.fact_checks\s+to\s+anon\s*,\s*authenticated/i);
    expect(code).toMatch(/grant\s+select\s+on\s+public\.cluster_fact_checks\s+to\s+anon\s*,\s*authenticated/i);
    expect(code).not.toMatch(
      /grant\s+[\w\s,]*\b(insert|update|delete)\b[\w\s,]*on\s+public\.(fact_checks|cluster_fact_checks)\s+to\s+[\w\s,]*\b(anon|authenticated)\b/i,
    );
  });

  it("both read policies are FOR SELECT gated on is_published", () => {
    const fcPolicy = code.match(/create\s+policy\s+"read published fact_checks"[\s\S]*?;/i);
    const cfcPolicy = code.match(/create\s+policy\s+"read published cluster_fact_checks"[\s\S]*?;/i);
    expect(fcPolicy).not.toBeNull();
    expect(cfcPolicy).not.toBeNull();
    expect(fcPolicy![0]).toMatch(/for\s+select/i);
    expect(fcPolicy![0]).toMatch(/using\s*\(\s*is_published\s*\)/i);
    expect(cfcPolicy![0]).toMatch(/for\s+select/i);
    expect(cfcPolicy![0]).toMatch(/using\s*\(\s*is_published\s+and\b/i);
  });

  it("cluster_fact_checks.is_published defaults to false, decided_by CHECK is ('auto','admin'), both FKs cascade", () => {
    const m = code.match(/create\s+table\s+if\s+not\s+exists\s+public\.cluster_fact_checks\s*\(([\s\S]*?)\)\s*;/i);
    expect(m).not.toBeNull();
    const body = m![1]!;
    expect(body).toMatch(/is_published\s+boolean\s+not\s+null\s+default\s+false/i);
    expect(body).toMatch(/decided_by\s+text\s+not\s+null\s+default\s+'auto'\s+check\s*\(\s*decided_by\s+in\s*\(\s*'auto'\s*,\s*'admin'\s*\)\s*\)/i);
    const fks = body.match(/references\s+public\.\w+\([^)]*\)\s+on\s+delete\s+cascade/gi) ?? [];
    expect(fks.length).toBe(2);
  });
});
