import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 118 ("api-throttle").
//
// src/lib/rate-limit.ts's in-memory limiter is process-local: on Vercel every
// instance has its own Map, and a cold start resets it. POST /api/oyun and
// POST /api/corrections therefore need a fleet-wide second layer. Migration
// 118 adds a generic DB-backed sliding-window counter: one SECURITY DEFINER
// function that atomically counts and (if under the limit) records one hit,
// keyed by (bucket, HMAC digest of the client key) -- never a raw IP.
// Blocked hits must never be recorded, or a persistent client could extend
// its own lockout forever. Same shape as 086's admin-login throttle, but the
// advisory lock is per (bucket, key) so unrelated clients never serialise.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "supabase", "migrations");
const MIGRATION = "118_api_throttle.sql";

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

describe("migration 118_api_throttle.sql (SQL contract)", () => {
  let sql = "";
  let code = "";
  let fn = "";

  beforeAll(() => {
    const path = resolve(MIGRATIONS_DIR, MIGRATION);
    expect(existsSync(path), `${MIGRATION} must exist`).toBe(true);
    sql = read(path);
    code = stripComments(sql);
    fn = functionBlock(code, "api_throttle");
  });

  it("contains the ledger insert for '118'", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'118'\s*,\s*'118_api_throttle'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("is wrapped in a single transaction", () => {
    expect(code.match(/^\s*begin\s*;/gim) ?? []).toHaveLength(1);
    expect(code.match(/\bcommit\s*;/gi) ?? []).toHaveLength(1);
    expect(code).toMatch(/^\s*begin\s*;/im);
    expect(code).toMatch(/\bcommit\s*;\s*$/i);
  });

  it("is additive-only: no DROP or TRUNCATE, and no ALTER of any other table", () => {
    expect(code).not.toMatch(/\bdrop\s+(table|function|index|column|policy|view|sequence)\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bdelete\s+from\s+(?!public\.api_throttle_hits)/i);
    const alterMatches = code.match(/\balter\s+table\s+(?:if\s+exists\s+)?(\S+)/gi) ?? [];
    expect(alterMatches.length).toBeGreaterThan(0);
    for (const m of alterMatches) {
      expect(m.toLowerCase()).toMatch(/api_throttle_hits/);
    }
  });

  it("creates api_throttle_hits with the bucket and 64-hex key_hash check constraints", () => {
    expect(code).toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.api_throttle_hits\s*\(/i);
    expect(code).toMatch(
      /bucket\s+text\s+not\s+null\s+check\s*\(\s*bucket\s*~\s*'\^\[a-z0-9:_-\]\{1,80\}\$'\s*\)/i,
    );
    expect(code).toMatch(
      /key_hash\s+text\s+not\s+null\s+check\s*\(\s*key_hash\s*~\s*'\^\[0-9a-f\]\{64\}\$'\s*\)/i,
    );
    expect(code).toMatch(/hit_at\s+timestamptz\s+not\s+null\s+default\s+now\(\)/i);
  });

  it("indexes (bucket, key_hash, hit_at desc) and hit_at", () => {
    expect(code).toMatch(
      /create\s+index\s+if\s+not\s+exists\s+api_throttle_hits_bucket_key_time_idx\s+on\s+public\.api_throttle_hits\s*\(\s*bucket\s*,\s*key_hash\s*,\s*hit_at\s+desc\s*\)/i,
    );
    expect(code).toMatch(
      /create\s+index\s+if\s+not\s+exists\s+api_throttle_hits_time_idx\s+on\s+public\.api_throttle_hits\s*\(\s*hit_at\s*\)/i,
    );
  });

  it("enables RLS on api_throttle_hits with no policies defined", () => {
    expect(code).toMatch(
      /alter\s+table\s+public\.api_throttle_hits\s+enable\s+row\s+level\s+security/i,
    );
    expect(code).not.toMatch(/create\s+policy/i);
  });

  it("revokes all table privileges from anon, authenticated, public and service_role", () => {
    expect(code).toMatch(
      /revoke\s+all\s+on\s+public\.api_throttle_hits\s+from\s+anon\s*,\s*authenticated\s*,\s*public\s*,\s*service_role\s*;/i,
    );
  });

  it("never grants anything on the table (no public read is intended)", () => {
    expect(code).not.toMatch(/grant\s+[\w\s,]+\s+on\s+(table\s+)?public\.api_throttle_hits/i);
  });

  it("revokes the identity sequence's privileges from anon, authenticated and public", () => {
    expect(code).toMatch(/pg_get_serial_sequence\s*\(\s*'public\.api_throttle_hits'\s*,\s*'id'\s*\)/i);
    expect(code).toMatch(
      /revoke\s+all\s+on\s+sequence\s+%s\s+from\s+anon\s*,\s*authenticated\s*,\s*public/i,
    );
  });

  it("has the PG17-guarded MAINTAIN revoke", () => {
    expect(code).toMatch(/server_version_num'?\s*\)\s*::\s*int\s*>=\s*170000/i);
    expect(code).toMatch(
      /revoke\s+maintain\s+on\s+public\.api_throttle_hits\s+from\s+anon\s*,\s*authenticated/i,
    );
    // The revoke is only reachable inside the version guard.
    const guardIdx = code.search(/server_version_num'?\s*\)\s*::\s*int\s*>=\s*170000/i);
    const revokeIdx = code.search(/revoke\s+maintain/i);
    expect(revokeIdx).toBeGreaterThan(guardIdx);
  });

  it("defines api_throttle(text, text, integer, integer) returning table(allowed boolean, retry_after_seconds integer)", () => {
    expect(fn).toMatch(
      /create\s+or\s+replace\s+function\s+public\.api_throttle\s*\(\s*p_bucket\s+text\s*,\s*p_key_hash\s+text\s*,\s*p_limit\s+integer\s*,\s*p_window_seconds\s+integer\s*\)/i,
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
    expect(h).toMatch(/\bvolatile\b/i);
    expect(h).not.toMatch(/\bstable\b/i);
    expect(h).not.toMatch(/\bimmutable\b/i);
  });

  it("validates all four arguments with errcode 22023, before taking the lock", () => {
    const b = body(fn);
    expect(b).toMatch(/p_bucket\s+is\s+null\s+or\s+p_bucket\s*!~\s*'\^\[a-z0-9:_-\]\{1,80\}\$'/i);
    expect(b).toMatch(/p_key_hash\s+is\s+null\s+or\s+p_key_hash\s*!~\s*'\^\[0-9a-f\]\{64\}\$'/i);
    expect(b).toMatch(/p_limit\s+is\s+null\s+or\s+p_limit\s*<\s*1\s+or\s+p_limit\s*>\s*1000/i);
    expect(b).toMatch(
      /p_window_seconds\s+is\s+null\s+or\s+p_window_seconds\s*<\s*1\s+or\s+p_window_seconds\s*>\s*86400/i,
    );
    expect(b.match(/errcode\s*=\s*'22023'/gi) ?? []).toHaveLength(4);

    const lastValidation = b.search(/p_window_seconds\s+is\s+null/i);
    const lockIdx = b.search(/pg_advisory_xact_lock\s*\(/i);
    expect(lockIdx).toBeGreaterThan(lastValidation);
  });

  it("derives the window with make_interval from the validated seconds", () => {
    expect(body(fn)).toMatch(
      /make_interval\s*\(\s*secs\s*=>\s*p_window_seconds\s*::\s*double\s+precision\s*\)/i,
    );
  });

  it("takes a PER-KEY advisory lock (hashtextextended of bucket:key_hash), not a constant", () => {
    const b = body(fn);
    expect(b).toMatch(
      /pg_catalog\.pg_advisory_xact_lock\s*\(\s*pg_catalog\.hashtextextended\s*\(\s*p_bucket\s*\|\|\s*':'\s*\|\|\s*p_key_hash\s*,\s*118\s*\)\s*\)/i,
    );
    // 086 used a literal constant (one global lock); that would serialise every client.
    expect(b).not.toMatch(/pg_advisory_xact_lock\s*\(\s*\d+\s*\)/i);
  });

  it("sweeps rows older than 1 day, bounded by a LIMIT, and skips rows another sweep holds", () => {
    const b = body(fn);
    expect(b).toMatch(/interval\s*'1\s+day'/i);
    const sweep = b.match(/delete\s+from\s+public\.api_throttle_hits[\s\S]*?;/i)?.[0] ?? "";
    expect(sweep).not.toBe("");
    expect(sweep).toMatch(/\blimit\s+(\d+|c_sweep)\b/i);
    expect(sweep).toMatch(/hit_at\s*<\s*[\s\S]*?c_retention/i);
    expect(sweep).toMatch(/for\s+update\s+skip\s+locked/i);
    // The lock comes first, the sweep second.
    expect(b.search(/delete\s+from\s+public\.api_throttle_hits/i)).toBeGreaterThan(
      b.search(/pg_advisory_xact_lock/i),
    );
  });

  it("the sweep is bounded to a small constant batch (500)", () => {
    expect(body(fn)).toMatch(/c_sweep\s+constant\s+integer\s*:=\s*500\s*;/i);
  });

  it("counts hits for this bucket and key inside the window and reads the oldest one", () => {
    const b = body(fn);
    expect(b).toMatch(/count\s*\(\s*\*\s*\)\s*::\s*integer\s*,\s*pg_catalog\.min\s*\(\s*h\.hit_at\s*\)/i);
    expect(b).toMatch(/h\.bucket\s*=\s*p_bucket/i);
    expect(b).toMatch(/h\.key_hash\s*=\s*p_key_hash/i);
    expect(b).toMatch(/h\.hit_at\s*>\s*v_now\s*-\s*v_window/i);
  });

  it("only inserts a hit AFTER the blocked branch's return -- blocked hits are never recorded", () => {
    const b = body(fn);
    const blockedIdx = b.search(/allowed\s*:=\s*false/i);
    const returnAfterBlocked = b.slice(blockedIdx).search(/\breturn\s*;/i);
    expect(blockedIdx).toBeGreaterThan(-1);
    expect(returnAfterBlocked).toBeGreaterThan(-1);
    const insertIdx = b.search(/insert\s+into\s+public\.api_throttle_hits/i);
    expect(insertIdx).toBeGreaterThan(blockedIdx + returnAfterBlocked);
    // And there is exactly one insert, none inside the blocked branch.
    expect(b.match(/insert\s+into\s+public\.api_throttle_hits/gi) ?? []).toHaveLength(1);
  });

  it("blocks at count >= p_limit and never reports a retry below 1 second", () => {
    const b = body(fn);
    expect(b).toMatch(/v_n\s*>=\s*p_limit/i);
    expect(b).toMatch(
      /greatest\s*\(\s*1\s*,\s*pg_catalog\.ceil\s*\(\s*extract\s*\(\s*epoch\s+from\s*\(\s*v_first\s*\+\s*v_window\s*-\s*v_now\s*\)\s*\)\s*\)\s*::\s*integer\s*\)/i,
    );
  });

  it("grants execute to service_role only", () => {
    expect(code).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.api_throttle\s*\(\s*text\s*,\s*text\s*,\s*integer\s*,\s*integer\s*\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*;/i,
    );
    expect(code).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.api_throttle\s*\(\s*text\s*,\s*text\s*,\s*integer\s*,\s*integer\s*\)\s+to\s+service_role\s*;/i,
    );
    expect(code).not.toMatch(
      /grant\s+[\w\s,]*on\s+function\s+public\.api_throttle[\s\S]*?to\s+[\w\s,]*\b(anon|authenticated|public)\b/i,
    );
  });

  it("never touches the other throttle objects (086) and records no raw IP column", () => {
    expect(code).not.toMatch(/admin_login_attempts/i);
    expect(code).not.toMatch(/\b(ip|ip_address|user_agent)\b\s+(text|inet|varchar)/i);
  });
});
