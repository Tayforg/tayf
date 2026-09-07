import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static checks for migration 037 (singleton-cluster retention + pgmq
// archive trim) and 038 (idempotent pg_cron schedule, including the new
// prune-nightly job). No live tier — the pg_cron / pg_net extensions these
// exercise aren't present on local Postgres at all (038 itself no-ops
// there), so there's nothing a SUPABASE_LOCAL_URL-gated suite could assert
// beyond what the static checks already cover.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "supabase", "migrations");

function read(name: string): string {
  return readFileSync(resolve(MIGRATIONS_DIR, name), "utf8");
}

// Slices out one `create or replace function <name>` header — everything
// between the signature and the `as $$` body delimiter — so SECURITY
// DEFINER / search_path assertions can be scoped to the right function
// instead of matching anywhere in the file.
function functionHeader(sql: string, fnName: string): string {
  const start = sql.indexOf(`create or replace function ${fnName}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("as $$", start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe("migration 037_retention.sql (static)", () => {
  let sql = "";
  beforeAll(() => {
    sql = read("037_retention.sql");
    expect(sql.length).toBeGreaterThan(0);
  });

  it("adds clusters.is_archived as a not-null boolean defaulting to false", () => {
    expect(sql).toMatch(
      /add\s+column\s+if\s+not\s+exists\s+is_archived\s+boolean\s+not\s+null\s+default\s+false/i,
    );
  });

  it("adds a partial index on updated_at where is_archived = false, without touching existing indexes", () => {
    expect(sql).toMatch(
      /create\s+index\s+if\s+not\s+exists\s+clusters_active_updated_idx\s+on\s+public\.clusters\s*\(\s*updated_at\s+desc\s*\)\s*where\s+is_archived\s*=\s*false/i,
    );
    // Migration 014 already owns idx_clusters_active_updated_at (on
    // article_count) — this migration must not create, alter, or drop it,
    // and must define exactly one new index (clusters_active_updated_idx).
    expect(sql).not.toMatch(/drop\s+index/i);
    expect(sql).not.toMatch(/(create|alter)\s+index[^;]*idx_clusters_active_updated_at/i);
    const createdIndexes = [...sql.matchAll(/create\s+index\s+if\s+not\s+exists\s+(\S+)/gi)].map(
      (m) => m[1],
    );
    expect(createdIndexes).toEqual(["clusters_active_updated_idx"]);
  });

  it("defines prune_singleton_clusters(retention_days, batch) as SECURITY DEFINER with empty search_path", () => {
    expect(sql).toMatch(
      /create\s+or\s+replace\s+function\s+public\.prune_singleton_clusters\(\s*retention_days\s+int\s+default\s+30\s*,\s*batch\s+int\s+default\s+5000\s*\)/i,
    );
    const header = functionHeader(sql, "public.prune_singleton_clusters");
    expect(header).toMatch(/security\s+definer/i);
    expect(header).toMatch(/set\s+search_path\s*=\s*''/i);
  });

  it("prune_singleton_clusters guards against a non-positive or null batch so it cannot loop forever", () => {
    expect(sql).toMatch(
      /batch\s+is\s+null\s+or\s+batch\s*<=\s*0[\s\S]{0,60}raise\s+exception/i,
    );
    // Belt-and-braces: an empty pass must also end the loop, independent
    // of the guard above.
    expect(sql).toMatch(/exit\s+when\s+v_batch_count\s*=\s*0\s+or\s+v_batch_count\s*<\s*batch/i);
  });

  it("prune_singleton_clusters only flags singletons — never deletes clusters or articles", () => {
    expect(sql).not.toMatch(/delete\s+from\s+public\.clusters/i);
    expect(sql).not.toMatch(/delete\s+from\s+public\.articles/i);
    expect(sql).not.toMatch(/delete\s+from\s+public\.cluster_articles/i);
    expect(sql).toMatch(/article_count\s*=\s*1/);
    expect(sql).toMatch(/set\s+is_archived\s*=\s*true/i);
  });

  it("revokes/grants prune_singleton_clusters per the service_role-only convention", () => {
    expect(sql).toMatch(
      /revoke\s+execute\s+on\s+function\s+public\.prune_singleton_clusters\(int,\s*int\)\s+from\s+[^;]*\banon\b[^;]*\bauthenticated\b[^;]*\bpublic\b/i,
    );
    expect(sql).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.prune_singleton_clusters\(int,\s*int\)\s+to\s+service_role/i,
    );
  });

  it("defines trim_pgmq_archives(keep_days) as SECURITY DEFINER with empty search_path", () => {
    expect(sql).toMatch(
      /create\s+or\s+replace\s+function\s+public\.trim_pgmq_archives\(\s*keep_days\s+int\s+default\s+7\s*\)/i,
    );
    const header = functionHeader(sql, "public.trim_pgmq_archives");
    expect(header).toMatch(/security\s+definer/i);
    expect(header).toMatch(/set\s+search_path\s*=\s*''/i);
  });

  it("guards trim_pgmq_archives with to_regclass so it no-ops where pgmq is absent", () => {
    expect(sql).toMatch(/to_regclass\(\s*'pgmq\.a_cluster_work'\s*\)\s+is\s+not\s+null/i);
    expect(sql).toMatch(/to_regclass\(\s*'pgmq\.a_image_backfill'\s*\)\s+is\s+not\s+null/i);
    expect(sql).toMatch(/delete\s+from\s+pgmq\.a_cluster_work/i);
    expect(sql).toMatch(/delete\s+from\s+pgmq\.a_image_backfill/i);
  });

  it("revokes/grants trim_pgmq_archives per the service_role-only convention", () => {
    expect(sql).toMatch(
      /revoke\s+execute\s+on\s+function\s+public\.trim_pgmq_archives\(int\)\s+from\s+[^;]*\banon\b[^;]*\bauthenticated\b[^;]*\bpublic\b/i,
    );
    expect(sql).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.trim_pgmq_archives\(int\)\s+to\s+service_role/i,
    );
  });
});

describe("migration 038_cron_schedules.sql (static)", () => {
  let sql = "";
  beforeAll(() => {
    sql = read("038_cron_schedules.sql");
    expect(sql.length).toBeGreaterThan(0);
  });

  it("schedules exactly the four jobnames — the three existing drains plus prune-nightly", () => {
    const jobnames = [...sql.matchAll(/cron\.schedule\(\s*'([a-z-]+)'/g)].map((m) => m[1]);
    expect(new Set(jobnames).size).toBe(4);
    expect([...new Set(jobnames)].sort()).toEqual(
      ["cluster-drain", "image-drain", "ingest-drain", "prune-nightly"].sort(),
    );
  });

  it("unschedules by jobname before rescheduling (idempotent re-apply)", () => {
    expect(sql).toMatch(/cron\.unschedule/i);
    // Guarded by an existence check, not a bare call every time.
    expect(sql).toMatch(/if\s+exists\s*\([^)]*from\s+cron\.job\s+where\s+jobname/i);
  });

  it("guards on pg_extension for both pg_cron and pg_net, skipping (not erroring) when either is absent", () => {
    expect(sql).toMatch(/pg_extension\s+where\s+extname\s*=\s*'pg_cron'/i);
    expect(sql).toMatch(/pg_extension\s+where\s+extname\s*=\s*'pg_net'/i);
    expect(sql).toMatch(/raise\s+notice/i);
  });

  it("reads the base URL and bearer from Vault — never a literal secret or project URL", () => {
    expect(sql).toMatch(/vault\.decrypted_secrets\s+where\s+name\s*=\s*'service_role_key'/);
    expect(sql).toMatch(/vault\.decrypted_secrets\s+where\s+name\s*=\s*'functions_base_url'/);
    // Only placeholder URLs (<ref>) may appear, never a real project host.
    expect(sql.toLowerCase()).not.toMatch(/[a-z0-9]{20}\.supabase\.co/);
    expect(sql).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{20,}/);
  });

  it("raises an exception at apply time when a Vault secret is missing (pg_cron present)", () => {
    expect(sql).toMatch(/if\s+not\s+exists\s*\(select 1 from vault\.decrypted_secrets[^)]*\)\s*then\s*[\s\S]{0,20}raise\s+exception/i);
  });

  it("prune-nightly calls both retention functions from 037", () => {
    const jobBody = sql.slice(sql.indexOf("'prune-nightly'"));
    expect(jobBody).toMatch(/prune_singleton_clusters\(\)/);
    expect(jobBody).toMatch(/trim_pgmq_archives\(\)/);
  });

  it("keeps the same schedules as the guide for the three pre-existing drains", () => {
    expect(sql).toMatch(/'ingest-drain'[\s\S]{0,20}'\*\/3 \* \* \* \*'/);
    expect(sql).toMatch(/'cluster-drain'[\s\S]{0,20}'\* \* \* \* \*'/);
    expect(sql).toMatch(/'image-drain'[\s\S]{0,20}'\*\/5 \* \* \* \*'/);
    expect(sql).toMatch(/'prune-nightly'[\s\S]{0,20}'10 4 \* \* \*'/);
  });
});
