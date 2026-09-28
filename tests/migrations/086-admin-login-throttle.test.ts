import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 086 ("admin-login-throttle").
//
// src/lib/rate-limit.ts's in-memory limiter is process-local and does not
// hold across Vercel instances; rotating IPs also bypasses it because it is
// keyed per clientKey(). This migration adds a DB-backed second layer: a
// SECURITY DEFINER function that atomically counts and (if under the caps)
// records one attempt, keyed by an HMAC digest of the client key -- never
// the raw IP or the password. Blocked attempts must never be recorded, or
// a persistent attacker could extend their own lockout window forever.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "supabase", "migrations");
const MIGRATION = "086_admin_login_throttle.sql";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Strip `--` line comments so prose can never satisfy a code guard. */
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

describe("migration 086_admin_login_throttle.sql (SQL contract)", () => {
  let sql = "";
  let code = "";
  let fn = "";

  beforeAll(() => {
    const path = resolve(MIGRATIONS_DIR, MIGRATION);
    expect(existsSync(path), `${MIGRATION} must exist`).toBe(true);
    sql = read(path);
    code = stripComments(sql);
    fn = functionBlock(code, "admin_login_throttle");
  });

  it("contains the ledger insert for '086'", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'086'\s*,\s*'086_admin_login_throttle'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("is wrapped in a single transaction", () => {
    expect(code).toMatch(/^\s*begin\s*;/im);
    expect(code).toMatch(/\bcommit\s*;\s*$/i);
  });

  it("is additive-only: no DROP or TRUNCATE, and no ALTER of any other table", () => {
    expect(code).not.toMatch(/\bdrop\s+(table|function|index|column|policy|view)\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    // The only table this migration may touch is admin_login_attempts, and
    // only via CREATE TABLE / ALTER TABLE ... ENABLE ROW LEVEL SECURITY.
    const alterMatches = code.match(/\balter\s+table\s+(?:if\s+exists\s+)?(\S+)/gi) ?? [];
    for (const m of alterMatches) {
      expect(m.toLowerCase()).toMatch(/admin_login_attempts/);
    }
  });

  it("creates admin_login_attempts with the 64-hex check constraint", () => {
    expect(code).toMatch(
      /create\s+table\s+if\s+not\s+exists\s+public\.admin_login_attempts\s*\(/i,
    );
    expect(code).toMatch(/key_hash\s+text\s+not\s+null\s+check\s*\(\s*key_hash\s*~\s*'\^\[0-9a-f\]\{64\}\$'\s*\)/i);
  });

  it("enables RLS on admin_login_attempts with no policies defined", () => {
    expect(code).toMatch(
      /alter\s+table\s+public\.admin_login_attempts\s+enable\s+row\s+level\s+security/i,
    );
    expect(code).not.toMatch(/create\s+policy/i);
  });

  it("revokes all table privileges from anon, authenticated, public and service_role", () => {
    expect(code).toMatch(
      /revoke\s+all\s+on\s+public\.admin_login_attempts\s+from\s+anon\s*,\s*authenticated\s*,\s*public\s*,\s*service_role\s*;/i,
    );
  });

  it("defines admin_login_throttle returning table(allowed boolean, retry_after_seconds integer)", () => {
    expect(fn).toMatch(
      /create\s+or\s+replace\s+function\s+public\.admin_login_throttle\s*\(\s*p_key_hash\s+text\s*\)/i,
    );
    expect(header(fn)).toMatch(
      /returns\s+table\s*\(\s*allowed\s+boolean\s*,\s*retry_after_seconds\s+integer\s*\)/i,
    );
  });

  it("is plpgsql, SECURITY DEFINER, empty search_path, and NOT stable/immutable", () => {
    const h = header(fn);
    expect(h).toMatch(/\blanguage\s+plpgsql\b/i);
    expect(h).toMatch(/\bsecurity\s+definer\b/i);
    expect(h).toMatch(/\bset\s+search_path\s*=\s*''/i);
    expect(h).not.toMatch(/\bstable\b/i);
    expect(h).not.toMatch(/\bimmutable\b/i);
  });

  it("validates the key with the 64-hex regex before doing anything else", () => {
    const b = body(fn);
    expect(b).toMatch(/p_key_hash\s+is\s+null\s+or\s+p_key_hash\s*!~\s*'\^\[0-9a-f\]\{64\}\$'/i);
    expect(b).toMatch(/errcode\s*=\s*'22023'/i);
  });

  it("takes a pg_advisory_xact_lock to serialise check-then-insert", () => {
    expect(body(fn)).toMatch(/pg_advisory_xact_lock\s*\(/i);
  });

  it("sweeps rows older than the 1-day retention window", () => {
    const b = body(fn);
    expect(b).toMatch(/c_retention\s+constant\s+interval\s*:=\s*interval\s*'1\s+day'\s*;/i);
    expect(b).toMatch(/delete\s+from\s+public\.admin_login_attempts[\s\S]*?c_retention/i);
  });

  it("counts per-key and global attempts over a 15-minute window with the 5 / 50 constants", () => {
    const b = body(fn);
    expect(b).toMatch(/interval\s*'15\s+minutes'/i);
    expect(b).toMatch(/c_per_key\s+constant\s+integer\s*:=\s*5\s*;/i);
    expect(b).toMatch(/c_global\s+constant\s+integer\s*:=\s*50\s*;/i);
  });

  it("only inserts an attempt AFTER the blocked branch's return -- blocked attempts are never recorded", () => {
    const b = body(fn);
    const blockedIdx = b.search(/allowed\s*:=\s*false/i);
    const returnAfterBlocked = b.slice(blockedIdx).search(/\breturn\s*;/i);
    expect(blockedIdx).toBeGreaterThan(-1);
    expect(returnAfterBlocked).toBeGreaterThan(-1);
    const insertIdx = b.search(/insert\s+into\s+public\.admin_login_attempts/i);
    expect(insertIdx).toBeGreaterThan(blockedIdx + returnAfterBlocked);
  });

  it("grants execute to service_role only", () => {
    expect(code).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.admin_login_throttle\s*\(\s*text\s*\)\s+from\s+anon\s*,\s*authenticated\s*,\s*public\s*;/i,
    );
    expect(code).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.admin_login_throttle\s*\(\s*text\s*\)\s+to\s+service_role\s*;/i,
    );
    expect(code).not.toMatch(
      /grant\s+[\w\s,]*on\s+function\s+public\.admin_login_throttle[\s\S]*?to\s+[\w\s,]*\b(anon|authenticated|public)\b/i,
    );
  });
});
