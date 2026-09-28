import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 079 (owned-channels social ledger).
// Follows the 072 static-contract pattern (tests/migrations/072-*.test.ts):
// no live database, regex-level assertions against the SQL text plus a
// cross-check against the TS unions this migration's check constraints
// must mirror.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "supabase", "migrations");
const MIGRATION = "079_social_posts.sql";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

function functionBlock(sql: string, name: string): string {
  const re = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\([\\s\\S]*?\\$fn\\$[\\s\\S]*?\\$fn\\$\\s*;`,
    "i",
  );
  const m = sql.match(re);
  if (!m) throw new Error(`function ${name} not found`);
  return m[0];
}

function header(block: string): string {
  const idx = block.search(/\bas\s+\$fn\$/i);
  return block.slice(0, idx);
}

function body(block: string): string {
  const m = block.match(/\$fn\$([\s\S]*?)\$fn\$/);
  if (!m || m[1] === undefined) throw new Error("no $fn$ body");
  return m[1];
}

describe("migration 079_social_posts.sql (SQL contract)", () => {
  let sql = "";
  let code = "";
  let claimFn = "";
  let finishFn = "";

  beforeAll(() => {
    const path = resolve(MIGRATIONS_DIR, MIGRATION);
    expect(existsSync(path), `${MIGRATION} must exist`).toBe(true);
    sql = read(path);
    code = stripComments(sql);
    claimFn = functionBlock(code, "social_post_claim");
    finishFn = functionBlock(code, "social_post_finish");
  });

  it("contains the ledger insert for '079'", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'079'\s*,\s*'079_social_posts'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("is wrapped in a single transaction", () => {
    expect(code).toMatch(/^\s*begin\s*;/im);
    expect(code).toMatch(/\bcommit\s*;\s*$/i);
  });

  it("is additive only: no DROP, no TRUNCATE, no DELETE/UPDATE outside the definer functions, and the only ALTER is RLS", () => {
    expect(code).not.toMatch(/\bdrop\s+(table|function|index|column|policy|view)\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);

    const alterStatements = code.match(/\balter\s+table[^;]*;/gi) ?? [];
    expect(alterStatements.length).toBeGreaterThan(0);
    for (const stmt of alterStatements) {
      expect(stmt).toMatch(/enable\s+row\s+level\s+security/i);
    }

    // The only mutating statements outside the two function bodies are the
    // ledger insert and the ACL grants/revokes (no data DML at top level).
    const claimBody = body(claimFn);
    const finishBody = body(finishFn);
    const withoutFunctionBodies = code
      .replace(claimBody, "")
      .replace(finishBody, "");
    expect(withoutFunctionBodies).not.toMatch(
      /\b(delete\s+from|update\s+public\.)\b/i,
    );
  });

  it("declares unique (channel, cluster_id)", () => {
    expect(code).toMatch(/unique\s*\(\s*channel\s*,\s*cluster_id\s*\)/i);
  });

  it("channel/kind check constraints equal the TS unions in config.ts / select.ts", async () => {
    const { SOCIAL_CHANNELS } = await import("@/lib/social/config");
    const { SOCIAL_KINDS } = await import("@/lib/social/select");

    const channelMatch = code.match(
      /channel\s+text\s+not\s+null\s+check\s*\(\s*channel\s+in\s*\(([^)]+)\)\s*\)/i,
    );
    expect(channelMatch).not.toBeNull();
    const channels = (channelMatch?.[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^'|'$/g, ""));
    expect(channels).toEqual([...SOCIAL_CHANNELS]);

    const kindMatch = code.match(
      /kind\s+text\s+not\s+null\s+check\s*\(\s*kind\s+in\s*\(([^)]+)\)\s*\)/i,
    );
    expect(kindMatch).not.toBeNull();
    const kinds = (kindMatch?.[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^'|'$/g, ""));
    expect(kinds).toEqual([...SOCIAL_KINDS]);
  });

  it("both functions are SECURITY DEFINER with an empty search_path", () => {
    for (const fn of [claimFn, finishFn]) {
      const h = header(fn);
      expect(h).toMatch(/\bsecurity\s+definer\b/i);
      expect(h).toMatch(/\bset\s+search_path\s*=\s*''/i);
    }
  });

  it("the revoke/grant pairs exist with no anon/authenticated/public grant and no table insert/update grant to service_role", () => {
    expect(code).toMatch(
      /revoke\s+all\s+on\s+public\.social_posts\s+from\s+anon\s*,\s*authenticated\s*,\s*public\s*;/i,
    );
    expect(code).toMatch(
      /grant\s+select\s+on\s+public\.social_posts\s+to\s+service_role\s*;/i,
    );
    expect(code).not.toMatch(
      /grant\s+(insert|update)\s+on\s+public\.social_posts\s+to\s+service_role/i,
    );

    expect(code).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.social_post_claim[\s\S]{0,80}?from\s+anon\s*,\s*authenticated\s*,\s*public\s*;/i,
    );
    expect(code).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.social_post_claim[\s\S]{0,80}?to\s+service_role\s*;/i,
    );
    expect(code).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.social_post_finish[\s\S]{0,80}?from\s+anon\s*,\s*authenticated\s*,\s*public\s*;/i,
    );
    expect(code).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.social_post_finish[\s\S]{0,80}?to\s+service_role\s*;/i,
    );

    const grantStatements = code.match(/\bgrant\s+[^;]*;/gi) ?? [];
    for (const stmt of grantStatements) {
      // `public` as a schema qualifier (`public.social_posts`) is fine;
      // `public` as a grantee (`to ... public`) is not. Only the latter
      // is checked by excluding the schema-qualified form.
      const withoutSchemaQualifier = stmt.replace(/\bpublic\.\w+/gi, "");
      expect(withoutSchemaQualifier).not.toMatch(/\b(anon|authenticated|public)\b/i);
    }
  });

  it("no sequence grant exists for social_posts_id_seq", () => {
    expect(code).toMatch(
      /revoke\s+all\s+on\s+sequence\s+public\.social_posts_id_seq\s+from\s+anon\s*,\s*authenticated\s*,\s*public\s*;/i,
    );
    expect(code).not.toMatch(/grant\s+[\w\s,]*on\s+sequence\s+public\.social_posts_id_seq/i);
  });

  it("social_post_claim takes the per-channel advisory lock before counting/inserting", () => {
    const b = body(claimFn);
    expect(b).toMatch(/pg_advisory_xact_lock/i);
    const lockIdx = b.search(/pg_advisory_xact_lock/i);
    const insertIdx = b.search(/insert\s+into\s+public\.social_posts/i);
    expect(lockIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(lockIdx);
  });

  it("social_post_claim uses on conflict (channel, cluster_id) do nothing", () => {
    const b = body(claimFn);
    expect(b).toMatch(/on\s+conflict\s*\(\s*channel\s*,\s*cluster_id\s*\)\s+do\s+nothing/i);
  });

  it("social_post_claim enforces the daily cap before inserting", () => {
    const b = body(claimFn);
    expect(b).toMatch(/p_daily_cap/i);
    expect(b).toMatch(/count\(\*\)/i);
    expect(b).toMatch(/24\s+hours/i);
  });

  it("social_post_finish only transitions rows from pending, and rejects a bad status", () => {
    const b = body(finishFn);
    expect(b).toMatch(/where[\s\S]*status\s*=\s*'pending'/i);
    expect(b).toMatch(/p_status\s+not\s+in\s*\(\s*'posted'\s*,\s*'failed'\s*\)/i);
  });

  it("references public.clusters(id) on delete cascade", () => {
    expect(code).toMatch(
      /references\s+public\.clusters\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i,
    );
  });
});
