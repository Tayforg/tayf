import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { MERGE_ERROR_CODES } from "../../src/lib/clusters/merge";

// Static SQL-contract test for migration 099 (cluster merge engine).
// Comments are stripped before code guards (same as 098).

const MIGRATION = resolve(__dirname, "..", "..", "supabase", "migrations", "099_cluster_merge.sql");

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

describe("migration 099_cluster_merge.sql (SQL contract)", () => {
  let raw = "";
  let code = "";

  beforeAll(() => {
    expect(existsSync(MIGRATION), "099_cluster_merge.sql must exist").toBe(true);
    raw = readFileSync(MIGRATION, "utf8");
    code = stripComments(raw);
  });

  it("ends with the schema_migrations insert followed by commit", () => {
    expect(code.trimEnd()).toMatch(
      /insert into supabase_migrations\.schema_migrations \(version, name\)\s+values \('099', '099_cluster_merge'\)\s+on conflict do nothing;\s*commit;$/i,
    );
  });

  it("adds clusters.merged_into with a guarded self-check constraint and a partial index", () => {
    expect(code).toMatch(
      /alter table public\.clusters add column if not exists merged_into uuid references public\.clusters\(id\) on delete set null/i,
    );
    expect(code).toMatch(/clusters_merged_into_not_self/);
    expect(code).toMatch(/check \(merged_into is null or merged_into <> id\)/i);
    // guarded so a re-apply does not fail
    expect(code).toMatch(/if not exists \(\s*select 1 from pg_catalog\.pg_constraint/i);
    expect(code).toMatch(
      /create index if not exists clusters_merged_into_idx on public\.clusters \(merged_into\) where merged_into is not null/i,
    );
  });

  it("cluster_merge_atomic is security definer with an empty search_path", () => {
    const m = code.match(/create or replace function public\.cluster_merge_atomic\s*\([\s\S]*?\$fn\$/i);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/security\s+definer/i);
    expect(m![0]).toMatch(/set\s+search_path\s*=\s*''/i);
  });

  it("revokes execute from public/anon/authenticated and grants service_role", () => {
    expect(code).toMatch(
      /revoke all on function public\.cluster_merge_atomic\(uuid, uuid, text, text\) from public, anon, authenticated/i,
    );
    expect(code).toMatch(
      /grant execute on function public\.cluster_merge_atomic\(uuid, uuid, text, text\) to service_role/i,
    );
  });

  it("never grants write privileges, all, or anything to anon", () => {
    expect(code).not.toMatch(
      /grant\s+[^;]*\b(insert|update|delete|truncate|all|maintain)\b[^;]*\bto\b[^;]*\b(anon|authenticated)\b/i,
    );
    expect(code).not.toMatch(/\bto\s+anon\b/i);
  });

  it.each(["cluster_merge_log", "cluster_merge_dismissals"])(
    "%s has RLS, revoked defaults and the PG17 maintain guard",
    (t) => {
      expect(code).toMatch(new RegExp(`alter table public\\.${t} enable row level security`, "i"));
      expect(code).toMatch(
        new RegExp(`revoke all on [^;]*public\\.${t}[^;]*from anon, authenticated, public`, "i"),
      );
      expect(code).toMatch(/server_version_num'\)::int >= 170000/);
      expect(code).toMatch(
        new RegExp(`execute 'revoke maintain on [^']*public\\.${t}[^']* from anon, authenticated'`, "i"),
      );
    },
  );

  it("recomputes both clusters through cluster_unlink_article (no formula copy)", () => {
    expect(code).toContain("perform public.cluster_unlink_article(p_target, null::uuid)");
    expect(code).toContain("perform public.cluster_unlink_article(p_source, null::uuid)");
  });

  it("does not copy zone maps or the blindspot threshold (raw file, comments included)", () => {
    expect(raw).not.toMatch(/iktidar/);
    expect(raw).not.toContain("'pro_government'");
    expect(raw).not.toMatch(/>=\s*0\.8/);
  });

  it("takes the global merge lock, then the per-cluster locks in a fixed order", () => {
    expect(code).toContain("pg_advisory_xact_lock(pg_catalog.hashtext('cluster_merge')");
    const lo = code.indexOf("pg_catalog.hashtext(least(p_source, p_target)::text)");
    const hi = code.indexOf("pg_catalog.hashtext(greatest(p_source, p_target)::text)");
    expect(lo).toBeGreaterThan(-1);
    expect(hi).toBeGreaterThan(lo);
    expect(code.indexOf("hashtext('cluster_merge')")).toBeLessThan(lo);
    expect(code).toContain("pg_advisory_xact_lock(pg_catalog.hashtext('story_threads_write')");
  });

  it("raises exactly the error codes the TypeScript contract lists", () => {
    const raised = new Set([...code.matchAll(/raise exception '(cluster_merge_[a-z_]+)'/g)].map((m) => m[1]));
    expect([...raised].sort()).toEqual([...MERGE_ERROR_CODES].sort());
  });
});
