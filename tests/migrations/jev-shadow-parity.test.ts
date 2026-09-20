import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  JEV_MONTHLY_TOKEN_CAP_DEFAULT,
  JEV_POLITICS_CATEGORIES,
  JEV_TASKS,
  JEV_USD_PER_TOKEN,
  type JevRunStatus,
  type JevSubjectType,
} from "../../supabase/functions/_shared/jev.ts";

// ---------------------------------------------------------------------------
// Static parity test for migration 061 (TypeSafe Jev shadow mode). 061 is
// additive-only and copied verbatim from the planner's SQL (see W1.md), so
// this file does not re-derive or lint the SQL the way 024-028.test.ts does
// -- it only pins the two vocabularies that live in BOTH the migration's
// comments/CHECK constraints and _shared/jev.ts's exported constants/types,
// so the two files can never drift silently.
//
// CONSTANT DRIFT note (pack.md "Known risks"): JEV_POLITICS_CATEGORIES here
// duplicates POLITICS_CATEGORIES at cluster-consumer/index.ts:93 on purpose
// (importing the real one would drag Deno.serve into vitest). This test
// pins the literal against the migration comment; it cannot detect that
// cluster-consumer changed its own list independently -- same class of gap
// the guide calls out for stale deploys elsewhere in this repo.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "supabase", "migrations");
const FUNCTIONS_DIR = resolve(__dirname, "..", "..", "supabase", "functions");

function read(name: string): string {
  return readFileSync(resolve(MIGRATIONS_DIR, name), "utf8");
}

/** Column names declared inside a `create table ... ( ... )` block for one table. */
function ddlColumns(sql: string, table: string): string[] {
  const tableMatch = sql.match(
    new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?public\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`, "i"),
  );
  expect(tableMatch, `could not find CREATE TABLE for ${table}`).not.toBeNull();
  const body = tableMatch![1] ?? "";
  const columns: string[] = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("--")) continue;
    const nameMatch = line.match(/^([a-z_][a-z0-9_]*)\s+/i);
    if (nameMatch && nameMatch[1] !== "unique" && nameMatch[1] !== "primary" && nameMatch[1] !== "check" && nameMatch[1] !== "foreign") {
      columns.push(nameMatch[1]!);
    }
  }
  return columns;
}

describe("migration 061_jev_shadow.sql (static parity)", () => {
  let sql = "";
  beforeAll(() => {
    sql = read("061_jev_shadow.sql");
    expect(sql.length).toBeGreaterThan(0);
  });

  it("mentions every JEV_TASKS name in the task-column comment", () => {
    for (const task of JEV_TASKS) {
      expect(sql).toContain(task);
    }
  });

  it("the subject_type CHECK list equals the JevSubjectType union members", () => {
    const match = sql.match(/subject_type\s+in\s*\(([^)]+)\)/i);
    expect(match).not.toBeNull();
    const values = (match![1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^'|'$/g, ""))
      .filter(Boolean);

    const expected: JevSubjectType[] = ["article", "pair", "cluster", "kap", "title_version"];
    expect(values.sort()).toEqual([...expected].sort());
  });

  it("the jev_shadow_runs status CHECK list equals the JevRunStatus union members", () => {
    const match = sql.match(/status\s+in\s*\(([^)]+)\)/i);
    expect(match).not.toBeNull();
    const values = (match![1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^'|'$/g, ""))
      .filter(Boolean);

    const expected: JevRunStatus[] = ["running", "ok", "partial", "rate_limited", "budget_exceeded", "error"];
    expect(values.sort()).toEqual([...expected].sort());
  });

  it("JEV_POLITICS_CATEGORIES deep-equals ['politika','son_dakika'], pinned against the cluster-consumer:93 pointer", () => {
    expect(JEV_POLITICS_CATEGORIES).toEqual(["politika", "son_dakika"]);
    // The migration's own comment documents which table/column this backs;
    // the cluster-consumer:93 cross-reference lives in _shared/jev.ts's
    // JSDoc (see the CONSTANT DRIFT note above), not in the SQL file, so we
    // assert the constant value here rather than grepping the migration for
    // a line number that would immediately go stale.
    expect(JEV_POLITICS_CATEGORIES).toHaveLength(2);
  });

  it("contains the ledger insert for '061'", () => {
    expect(sql).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations[\s\S]*?values\s*\(\s*'061'\s*,\s*'061_jev_shadow'\s*\)/i,
    );
  });

  it("is additive-only: creates tables/functions with IF NOT EXISTS / OR REPLACE, never DROP or ALTER an existing object", () => {
    expect(sql).not.toMatch(/\bdrop\s+table\b/i);
    expect(sql).not.toMatch(/\bdrop\s+column\b/i);
    expect(sql).not.toMatch(/\balter\s+table\s+public\.(articles|clusters)\b/i);
  });

  it("is service_role-only: RLS enabled and anon/authenticated/public explicitly revoked on all three new tables", () => {
    for (const table of ["jev_shadow_runs", "jev_shadow_predictions", "jev_shadow_reviews"]) {
      expect(sql).toMatch(new RegExp(`alter\\s+table\\s+public\\.${table}\\s+enable\\s+row\\s+level\\s+security`, "i"));
      expect(sql).toMatch(new RegExp(`revoke\\s+all\\s+on\\s+public\\.${table}\\s+from\\s+anon,\\s*authenticated,\\s*public`, "i"));
    }
  });
});

// ---------------------------------------------------------------------------
// JEV-A1 static guard: every column jev-shadow/index.ts's
// fetchPendingTitleVersions passes to `.gte()`/`.order()` against
// `article_title_versions` must be a real column in migration 056's DDL.
// This is the coverage fix for the `created_at` vs `seen_at` bug -- neither
// tsc (tsconfig.json excludes supabase/functions/**) nor
// tests/functions/jev-shadow.test.ts (scoped to _shared only) can catch a
// PostgREST column-name mismatch, since JevPorts is an interface with no
// knowledge of the underlying schema.
// ---------------------------------------------------------------------------

describe("jev-shadow/index.ts <-> article_title_versions column parity (JEV-A1)", () => {
  it("every .gte()/.order() column used against article_title_versions exists in migration 056's DDL", () => {
    // CRLF-normalised: the body regexes below anchor on "\n" (Windows autocrlf).
    const indexTs = readFileSync(resolve(FUNCTIONS_DIR, "jev-shadow", "index.ts"), "utf8").replace(/\r\n/g, "\n");
    const migration056 = read("056_article_title_versions.sql");
    const columns = ddlColumns(migration056, "article_title_versions");
    expect(columns.length).toBeGreaterThan(0);

    const fnMatch = indexTs.match(/async fetchPendingTitleVersions[\s\S]*?\n    \},\n/);
    expect(fnMatch, "could not find fetchPendingTitleVersions in jev-shadow/index.ts").not.toBeNull();
    const fnBody = fnMatch![0];

    const usedColumns = new Set<string>();
    for (const m of fnBody.matchAll(/\.(?:gte|lte|gt|lt|eq|order)\(\s*"([a-z_]+)"/g)) {
      usedColumns.add(m[1]!);
    }
    expect(usedColumns.size).toBeGreaterThan(0);
    for (const col of usedColumns) {
      expect(
        columns,
        `column "${col}" used in fetchPendingTitleVersions is not a real article_title_versions column (migration 056)`,
      ).toContain(col);
    }
    // The bug this guard exists for: `created_at` does not exist on this table.
    expect(usedColumns.has("created_at")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// JEV-A16: the monthly token cap default and the USD/token conversion rate
// are hand-duplicated in three places (061's SQL default, _shared/jev.ts,
// and src/lib/admin/jev-shadow-status.ts's "keep in sync by hand" literal).
// Pin both so a change to one drifts loudly instead of silently.
// ---------------------------------------------------------------------------

describe("jev-shadow cost constants: cap + USD/token parity (JEV-A16)", () => {
  it("061's jev_shadow_month_usage default cap matches JEV_MONTHLY_TOKEN_CAP_DEFAULT", () => {
    const sql = read("061_jev_shadow.sql");
    expect(sql).toContain(`p_cap bigint default ${JEV_MONTHLY_TOKEN_CAP_DEFAULT}`);
  });

  it("JEV_USD_PER_TOKEN in src/lib/admin/jev-shadow-status.ts equals the one in _shared/jev.ts", () => {
    const adminPath = resolve(__dirname, "..", "..", "src", "lib", "admin", "jev-shadow-status.ts");
    const adminSrc = readFileSync(adminPath, "utf8");
    const match = adminSrc.match(/const\s+JEV_USD_PER_TOKEN\s*=\s*([\d_]+)\s*\/\s*([\d_]+)\s*;/);
    expect(match, "could not find JEV_USD_PER_TOKEN literal in jev-shadow-status.ts").not.toBeNull();
    const numerator = Number(match![1]!.replace(/_/g, ""));
    const denominator = Number(match![2]!.replace(/_/g, ""));
    expect(numerator / denominator).toBe(JEV_USD_PER_TOKEN);
  });
});
