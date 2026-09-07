import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static assertions for migration 035 (full-text search over clusters).
// Mirrors the "static checks always run" half of tests/migrations/
// 024-028.test.ts — no live Postgres required.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "supabase", "migrations");

function read(name: string): string {
  return readFileSync(resolve(MIGRATIONS_DIR, name), "utf8");
}

describe("migration 035_cluster_search.sql (static)", () => {
  let sql = "";
  beforeAll(() => {
    sql = read("035_cluster_search.sql");
    expect(sql.length).toBeGreaterThan(0);
  });

  it("adds search_tsv as a generated, stored tsvector column using the turkish config", () => {
    expect(sql).toMatch(
      /add\s+column\s+if\s+not\s+exists\s+search_tsv\s+tsvector[\s\S]*generated\s+always\s+as\s*\([\s\S]*to_tsvector\(\s*'turkish'/i,
    );
    expect(sql).toMatch(/\)\s*stored/i);
  });

  it("derives search_tsv from title_tr_neutral, title_tr, and summary_tr", () => {
    expect(sql).toMatch(/coalesce\(\s*title_tr_neutral\s*,\s*''\s*\)/i);
    expect(sql).toMatch(/coalesce\(\s*title_tr\s*,\s*''\s*\)/i);
    expect(sql).toMatch(/coalesce\(\s*summary_tr\s*,\s*''\s*\)/i);
  });

  it("creates a GIN index on search_tsv", () => {
    expect(sql).toMatch(
      /create\s+index\s+if\s+not\s+exists\s+clusters_search_tsv_idx\s+on\s+public\.clusters\s+using\s+gin\s*\(\s*search_tsv\s*\)/i,
    );
  });

  it("documents the one-time table rewrite on the ~170k-row production table", () => {
    expect(sql).toMatch(/one-time table rewrite/i);
    expect(sql).toMatch(/170k/);
  });
});
