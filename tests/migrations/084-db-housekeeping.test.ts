import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 084 ("db-platform" housekeeping:
// clusters autovacuum tuning, three FK support indexes, two confirmed-dead
// articles indexes dropped, a 30-day video image_url cleanup + rcman
// thumbnail upgrade, and a nightly manual clusters vacuum via pg_cron).
//
// See the migration's own header for the Step 0 numbers (S2-S5, S8) this
// file's assertions are built from.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "supabase", "migrations");
const MIGRATION = "084_db_housekeeping.sql";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Strip `--` line comments so prose can never satisfy a code guard. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

describe("migration 084_db_housekeeping.sql (SQL contract)", () => {
  let sql = "";
  let code = "";
  let header = "";

  beforeAll(() => {
    const path = resolve(MIGRATIONS_DIR, MIGRATION);
    expect(existsSync(path), `${MIGRATION} must exist`).toBe(true);
    sql = read(path);
    code = stripComments(sql);
    // Everything up to the first `begin;` is the prose header.
    header = sql.slice(0, sql.search(/^\s*begin\s*;/im));
  });

  it("contains the ledger insert for '084' and is wrapped in a single transaction", () => {
    expect(code).toMatch(/^\s*begin\s*;/im);
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'084'\s*,\s*'084_db_housekeeping'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
    expect(code).toMatch(/\bcommit\s*;\s*$/i);
  });

  it("sets lock_timeout and statement_timeout locally", () => {
    expect(code).toMatch(/set\s+local\s+lock_timeout\s*=\s*'5s'/i);
    expect(code).toMatch(/set\s+local\s+statement_timeout\s*=\s*'5min'/i);
  });

  it("header records the S2-S5 and S8 measurements, including idx_scan", () => {
    expect(header).toContain("idx_scan");
    expect(header).toMatch(/191,345|191345/);
    expect(header).toMatch(/16,457|16457/);
    expect(header).toMatch(/32 MB/);
    expect(header).toMatch(/13 MB/);
    expect(header).toMatch(/178 MB/);
    expect(header).toMatch(/1,746|1746/);
  });

  it("header explains that 013 dropped idx_story_stances_source_id and it returns only as FK support on an empty table", () => {
    expect(header).toMatch(/013/);
    expect(header).toMatch(/idx_story_stances_source_id/);
    expect(header).toMatch(/empty/i);
  });

  it("header records the lock notes (ACCESS EXCLUSIVE, lock_timeout re-run, drop index concurrently escape hatch)", () => {
    expect(header).toMatch(/access exclusive/i);
    expect(header.toLowerCase()).toContain("drop index concurrently");
  });

  it("header records operator follow-ups: manual clusters vacuum and the net._http_response runbook", () => {
    expect(header).toMatch(/vacuum\s*\(analyze\)\s*public\.clusters/i);
    expect(header.toLowerCase()).toContain("net._http_response");
  });

  it("sets all three clusters reloptions", () => {
    expect(code).toMatch(
      /alter\s+table\s+public\.clusters\s+set\s*\(\s*autovacuum_vacuum_scale_factor\s*=\s*0\.05\s*,\s*autovacuum_analyze_scale_factor\s*=\s*0\.02\s*,\s*autovacuum_vacuum_insert_scale_factor\s*=\s*0\.05\s*\)/i,
    );
  });

  it("creates the three FK indexes with if not exists", () => {
    expect(code).toMatch(
      /create\s+index\s+if\s+not\s+exists\s+corrections_cluster_id_idx\s+on\s+public\.corrections\s*\(\s*cluster_id\s*\)/i,
    );
    expect(code).toMatch(
      /create\s+index\s+if\s+not\s+exists\s+zone_guesses_article_id_idx\s+on\s+public\.zone_guesses\s*\(\s*article_id\s*\)/i,
    );
    expect(code).toMatch(
      /create\s+index\s+if\s+not\s+exists\s+story_stances_source_id_idx\s+on\s+public\.story_stances\s*\(\s*source_id\s*\)/i,
    );
  });

  it("every drop statement is exactly the two confirmed-unused articles indexes -- no drop table or function", () => {
    const drops = [...code.matchAll(/drop\s+[^\n;]+;/gi)].map((m) => m[0].trim());
    expect(drops.length).toBe(2);
    for (const d of drops) {
      expect(d).toMatch(
        /^drop\s+index\s+if\s+exists\s+public\.idx_articles_(fingerprint|body_excerpt_backfill)\s*;$/i,
      );
    }
    expect(code).not.toMatch(/\bdrop\s+(table|function|view|column|policy)\b/i);
  });

  it("updates only touch public.articles.image_url and are bounded to 30 days", () => {
    const updates = [...code.matchAll(/update\s+([a-z_][\w.]*)/gi)].map((m) =>
      m[1].toLowerCase(),
    );
    expect(updates.length).toBeGreaterThan(0);
    for (const target of updates) {
      expect(target).toBe("public.articles");
    }
    // Both UPDATE statements carry the 30-day bound and set image_url only.
    const updateStatements = code.match(/update\s+public\.articles[\s\S]*?;/gi) ?? [];
    expect(updateStatements.length).toBe(2);
    for (const stmt of updateStatements) {
      expect(stmt).toMatch(/set\s+image_url\s*=/i);
      expect(stmt).toMatch(/interval\s*'30\s+days'/i);
    }
  });

  it("'vacuum' appears only inside the cron.schedule call (VACUUM cannot run inside a transaction)", () => {
    // Exclude the 'clusters-vacuum' job-name literal (a hyphenated
    // identifier, not the SQL command) -- what must appear exactly once is
    // the actual VACUUM statement string handed to cron.schedule.
    const withoutJobName = code.replace(/clusters-vacuum/gi, "");
    const matches = [...withoutJobName.matchAll(/\bvacuum\b/gi)];
    expect(matches.length).toBe(1);
    const idx = matches[0].index ?? -1;
    const surrounding = withoutJobName.slice(Math.max(0, idx - 80), idx + 80);
    expect(surrounding).toMatch(/cron\.schedule/i);
  });

  it("the cron job is guarded by a pg_cron existence check and is unschedule-if-exists", () => {
    expect(code).toMatch(
      /if\s+not\s+exists\s*\(\s*select\s+1\s+from\s+pg_catalog\.pg_extension\s+where\s+extname\s*=\s*'pg_cron'\s*\)/i,
    );
    expect(code).toMatch(
      /if\s+exists\s*\(\s*select\s+1\s+from\s+cron\.job\s+where\s+jobname\s*=\s*'clusters-vacuum'\s*\)\s*then\s+perform\s+cron\.unschedule\(\s*'clusters-vacuum'\s*\)/i,
    );
    expect(code).toMatch(
      /cron\.schedule\(\s*'clusters-vacuum'\s*,\s*'35\s+\*\/6\s+\*\s+\*\s+\*'/i,
    );
  });

  it("never truncates or deletes anything", () => {
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
  });

  it("re-enqueues image_backfill explicitly for cleared video rows (025's trigger only fires on INSERT)", () => {
    expect(code).toMatch(/pgmq\.send\(\s*'image_backfill'/i);
    expect(code).toMatch(/pg_catalog\.jsonb_build_object\(\s*'article_id'\s*,\s*x\s*\)/i);
  });
});
