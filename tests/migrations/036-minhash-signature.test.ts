import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static assertions for migration 036 (persisted MinHash signature).
// Mirrors the "static checks always run" half of tests/migrations/
// 035-cluster-search.test.ts — no live Postgres required.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "supabase", "migrations");

function read(name: string): string {
  return readFileSync(resolve(MIGRATIONS_DIR, name), "utf8");
}

describe("migration 036_minhash_signature.sql (static)", () => {
  let sql = "";
  beforeAll(() => {
    sql = read("036_minhash_signature.sql");
    expect(sql.length).toBeGreaterThan(0);
  });

  it("adds minhash_sig as a nullable bigint[] column", () => {
    expect(sql).toMatch(/alter\s+table\s+public\.articles/i);
    expect(sql).toMatch(/add\s+column\s+if\s+not\s+exists\s+minhash_sig\s+bigint\[\]/i);
  });

  it("adds minhash_version as a nullable smallint column", () => {
    expect(sql).toMatch(/add\s+column\s+if\s+not\s+exists\s+minhash_version\s+smallint/i);
  });

  it("documents both columns with `comment on column`", () => {
    expect(sql).toMatch(/comment\s+on\s+column\s+public\.articles\.minhash_sig\s+is/i);
    expect(sql).toMatch(/comment\s+on\s+column\s+public\.articles\.minhash_version\s+is/i);
  });

  it("performs no backfill — no UPDATE statement anywhere in the file", () => {
    for (const line of sql.split("\n")) {
      expect(line).not.toMatch(/^\s*update\s/i);
    }
  });

  it("documents applying the migration before redeploying cluster-consumer", () => {
    expect(sql).toMatch(/apply this migration first/i);
    expect(sql).toMatch(/redeploy cluster-consumer/i);
  });
});
