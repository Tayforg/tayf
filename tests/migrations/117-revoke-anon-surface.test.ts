import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 117 ("revoke-anon-surface").
//
// 091/095 revoked anon/authenticated WRITE and MAINTAIN grants but left SELECT
// and the default ACLs alone. Production (read-only, 2026-10-24) still shows
// 23 relations readable by anon, 6 sequences with USAGE for anon and
// authenticated (born after 091 because default ACLs still grant them), and
// SECURITY DEFINER public.rls_auto_enable() executable by anon. 117 removes
// all of that at once and fixes the default ACLs so the next table cannot
// leak, then relies on migration 116's four allowlisted RPCs for the only
// legitimate anon reads.
//
// What 117 must NOT do is as load-bearing as what it does: it never names
// service_role (ingestion, crons and every server route use it), never
// grants anything, never drops, never touches RLS policies, and never uses
// `on all functions` (that would also hit extension functions that
// service_role relies on).
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATION = "117_revoke_anon_surface.sql";

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

describe("migration 117_revoke_anon_surface.sql (SQL contract)", () => {
  let sql = "";
  let code = "";

  beforeAll(() => {
    const path = resolve(REPO_ROOT, "supabase", "migrations", MIGRATION);
    expect(existsSync(path), `${MIGRATION} must exist`).toBe(true);
    sql = readFileSync(path, "utf8");
    code = stripComments(sql);
  });

  it("contains the ledger insert for '117'", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'117'\s*,\s*'117_revoke_anon_surface'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("is a single transaction with a bounded lock wait", () => {
    expect(code).toMatch(/^\s*begin\s*;/im);
    expect(code).toMatch(/\bcommit\s*;\s*$/i);
    expect(code).toMatch(/set\s+local\s+lock_timeout\s*=\s*'5s'\s*;/i);
  });

  it("revokes every table-like and sequence privilege in public from anon and authenticated", () => {
    expect(code).toMatch(
      /revoke\s+all\s+on\s+all\s+tables\s+in\s+schema\s+public\s+from\s+anon\s*,\s*authenticated\s*;/i,
    );
    expect(code).toMatch(
      /revoke\s+all\s+on\s+all\s+sequences\s+in\s+schema\s+public\s+from\s+anon\s*,\s*authenticated\s*;/i,
    );
  });

  it("makes trends_daily_bias_counts a security_invoker view", () => {
    expect(code).toMatch(
      /alter\s+view\s+public\.trends_daily_bias_counts\s+set\s*\(\s*security_invoker\s*=\s*on\s*\)\s*;/i,
    );
  });

  it("fixes the default ACLs for tables, sequences and functions created by postgres", () => {
    for (const kind of ["tables", "sequences"]) {
      expect(code).toMatch(
        new RegExp(
          `alter\\s+default\\s+privileges\\s+for\\s+role\\s+postgres\\s+in\\s+schema\\s+public\\s+revoke\\s+all\\s+on\\s+${kind}\\s+from\\s+anon\\s*,\\s*authenticated\\s*;`,
          "i",
        ),
      );
    }
    expect(code).toMatch(
      /alter\s+default\s+privileges\s+for\s+role\s+postgres\s+in\s+schema\s+public\s+revoke\s+execute\s+on\s+functions\s+from\s+anon\s*,\s*authenticated\s*;/i,
    );
  });

  it("revokes execute on public.rls_auto_enable() (prod fact 0c) without failing where it is absent", () => {
    expect(code).toMatch(/to_regprocedure\s*\(\s*'public\.rls_auto_enable\(\)'\s*\)/i);
    expect(code).toMatch(
      /revoke\s+execute\s+on\s+function\s+public\.rls_auto_enable\(\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated/i,
    );
  });

  it("never names service_role, never grants, never drops, never touches policies or all functions", () => {
    expect(code).not.toMatch(/service_role/i);
    expect(code).not.toMatch(/\bgrant\b/i);
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(code).not.toMatch(/\bpolicy\b/i);
    expect(code).not.toMatch(/\bpolicies\b/i);
    expect(code).not.toMatch(/\bon\s+all\s+functions\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bdelete\b/i);
  });

  it("only ever revokes from anon/authenticated (and public for the one named function)", () => {
    const revokes = code.match(/\brevoke\b[^;]*;/gi) ?? [];
    expect(revokes.length).toBeGreaterThanOrEqual(6);
    for (const r of revokes) {
      if (/rls_auto_enable/i.test(r)) continue;
      expect(r, r).toMatch(/\bfrom\s+anon\s*,\s*authenticated\s*;$/i);
    }
  });

  it("only alters the one view and default privileges (no other DDL)", () => {
    expect(code).not.toMatch(/\balter\s+table\b/i);
    expect(code).not.toMatch(/\bcreate\b/i);
    const views = code.match(/\balter\s+view\s+(\S+)/gi) ?? [];
    expect(views).toHaveLength(1);
  });

  it("documents the evidence and the residual risks in the header", () => {
    const head = sql.slice(0, sql.search(/^\s*begin\s*;/im));
    expect(head).toMatch(/23 relations/i);
    expect(head).toMatch(/6 sequences/i);
    expect(head).toMatch(/rls_auto_enable/);
    expect(head).toMatch(/supabase_admin/);
    expect(head).toMatch(/PUBLIC EXECUTE/);
    expect(head).toMatch(/anon-surface\.test\.ts/);
  });

  it("ships a commented ROLLBACK block that re-grants SELECT only (never writes)", () => {
    const at = sql.search(/^-- ROLLBACK\b/m);
    expect(at, "-- ROLLBACK block").toBeGreaterThan(-1);
    const rollback = sql.slice(at);
    const lines = rollback.split("\n").filter((l) => /\bgrant\b/i.test(l));
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const l of lines) {
      expect(l).toMatch(/^--\s*grant\s+select\s+on\s+public\./i);
      expect(l).not.toMatch(/\b(insert|update|delete|truncate|maintain|references|trigger|all)\b/i);
    }
    // The 23 relations from prod fact 0a are all listed.
    const listed = new Set(
      lines.flatMap((l) => Array.from(l.matchAll(/public\.([a-z0-9_]+)/gi), (m) => m[1])),
    );
    for (const rel of [
      "article_tickers",
      "articles",
      "bist_aliases",
      "bist_bars_5m",
      "bist_bars_daily",
      "bist_companies",
      "bist_quote_stats",
      "cluster_articles",
      "cluster_fact_checks",
      "clusters",
      "disclosure_coverage",
      "fact_checks",
      "kap_disclosures",
      "source_zone_history",
      "sources",
      "stories",
      "story_stances",
      "story_thread_members",
      "story_threads",
      "ticker_attention_daily",
      "trends_daily_bias_counts",
      "trends_daily_zone_counts_ist",
      "trends_daily_zone_counts_ist_rollup",
    ]) {
      expect(listed.has(rel), `rollback lists ${rel}`).toBe(true);
    }
    // Nothing in the rollback block is live SQL.
    expect(rollback.split("\n").filter((l) => l.trim() && !l.trim().startsWith("--"))).toEqual([]);
  });
});
