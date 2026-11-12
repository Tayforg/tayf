import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 207 ("admin-login-throttle-device").
//
// 086 gave /admin/login one atomic DB function with a per-key cap (5 / 15 min)
// and a global cap (50 / 15 min). The global cap is shared by every caller, so
// a caller that can keep it full also shuts out the owner. 207 adds a second
// function, admin_login_throttle_device(text), that is 086's function without
// the global count: a browser that already proved the current password carries
// a signed device cookie and is throttled per device only. Everyone else keeps
// 086 untouched.
//
// The SQL is read as text and compared as text: comments are stripped line by
// line, whitespace is collapsed, and every assertion is a substring or an
// index comparison. No regular expression is applied to SQL.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "supabase", "migrations");
const MIGRATION = "207_admin_login_throttle_device.sql";
const BASE_MIGRATION = "086_admin_login_throttle.sql";

// sha256 of 086_admin_login_throttle.sql as deployed. A migration that has
// run is never edited; 207 must not have touched it.
const BASE_SHA256 = "16b33cc750bd125121851d25fcf7c733e5ef5445341633d952f483c0ea8eb091";

const FN = "public.admin_login_throttle_device";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Drops `--` line comments so prose can never satisfy a code assertion. */
function stripComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const at = line.indexOf("--");
      return at < 0 ? line : line.slice(0, at);
    })
    .join("\n");
}

/** Lower case, one space between tokens, no space inside or before brackets. */
function canon(sql: string): string {
  const flat = sql.toLowerCase().split(/\s+/).filter((t) => t.length > 0).join(" ");
  return flat
    .replaceAll(" (", "(")
    .replaceAll("( ", "(")
    .replaceAll(" )", ")")
    .replaceAll(" ,", ",")
    .replaceAll(" ;", ";");
}

function countOf(haystack: string, needle: string): number {
  let n = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return n;
    n++;
    from = at + needle.length;
  }
}

interface Fn {
  header: string;
  body: string;
}

/** The text between the first two $fn$ tags after `create or replace function <name>(`. */
function functionParts(code: string, name: string): Fn {
  const start = code.indexOf(`create or replace function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  const open = code.indexOf("$fn$", start);
  const close = open < 0 ? -1 : code.indexOf("$fn$", open + 4);
  if (open < 0 || close < 0) throw new Error(`no $fn$ body for ${name}`);
  return { header: code.slice(start, open), body: code.slice(open + 4, close) };
}

describe("migration 207_admin_login_throttle_device.sql (SQL contract)", () => {
  let raw = "";
  let code = "";
  let fn: Fn = { header: "", body: "" };
  let baseCode = "";
  let baseFn: Fn = { header: "", body: "" };

  beforeAll(() => {
    const path = resolve(MIGRATIONS_DIR, MIGRATION);
    expect(existsSync(path), `${MIGRATION} must exist`).toBe(true);
    raw = read(path);
    code = canon(stripComments(raw));
    fn = functionParts(code, FN);
    baseCode = canon(stripComments(read(resolve(MIGRATIONS_DIR, BASE_MIGRATION))));
    baseFn = functionParts(baseCode, "public.admin_login_throttle");
  });

  it("is the only migration file numbered 207", () => {
    const claimed = readdirSync(MIGRATIONS_DIR).filter((n) => n.startsWith("207_"));
    expect(claimed).toEqual([MIGRATION]);
  });

  it("contains the ledger insert for '207'", () => {
    expect(code).toContain(
      canon(
        "insert into supabase_migrations.schema_migrations (version, name) " +
          "values ('207', '207_admin_login_throttle_device') on conflict do nothing;",
      ),
    );
  });

  it("is one transaction: begin, a 5 s lock_timeout, then commit as the last statement", () => {
    expect(code.startsWith("begin; set local lock_timeout = '5s';")).toBe(true);
    expect(code.endsWith("commit;")).toBe(true);
    expect(countOf(code, "begin;")).toBe(1);
    expect(countOf(code, "commit;")).toBe(1);
  });

  it("is additive only: one new function, no table, index, policy, drop, truncate or alter", () => {
    expect(countOf(code, "create or replace function")).toBe(1);
    for (const banned of [
      "create table",
      "create index",
      "create policy",
      "create trigger",
      "create extension",
      "alter table",
      "alter function",
      "alter default privileges",
      "drop ",
      "truncate",
      "cron.",
      "ops_health_report",
    ]) {
      expect(code.includes(banned), banned).toBe(false);
    }
  });

  it("defines admin_login_throttle_device(p_key_hash text) returning table(allowed boolean, retry_after_seconds integer)", () => {
    expect(fn.header.startsWith(`create or replace function ${FN}(p_key_hash text)`)).toBe(true);
    expect(fn.header).toContain("returns table(allowed boolean, retry_after_seconds integer)");
  });

  it("is plpgsql, volatile, SECURITY DEFINER with an empty search_path", () => {
    expect(fn.header).toContain("language plpgsql");
    expect(fn.header).toContain("volatile");
    expect(fn.header).toContain("security definer");
    expect(fn.header).toContain("set search_path = ''");
    expect(fn.header.includes("stable")).toBe(false);
    expect(fn.header.includes("immutable")).toBe(false);
  });

  it("validates the key as 64 hex characters (errcode 22023) before the lock", () => {
    const check = "p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$'";
    const lock = "pg_catalog.pg_advisory_xact_lock(86086086)";
    const checkAt = fn.body.indexOf(check);
    expect(checkAt).toBeGreaterThan(-1);
    expect(fn.body).toContain("errcode = '22023'");
    expect(fn.body.indexOf(lock)).toBeGreaterThan(checkAt);
  });

  it("takes the same advisory lock as 086 (86086086), so the two functions serialise with each other", () => {
    expect(fn.body).toContain("perform pg_catalog.pg_advisory_xact_lock(86086086);");
    expect(baseFn.body).toContain("perform pg_catalog.pg_advisory_xact_lock(86086086);");
    expect(countOf(fn.body, "pg_advisory_xact_lock(")).toBe(1);
  });

  it("sweeps rows older than the 1-day retention window, as 086 does", () => {
    const sweep =
      "delete from public.admin_login_attempts a where a.attempted_at < v_now - c_retention;";
    expect(fn.body).toContain("c_retention constant interval := interval '1 day';");
    expect(fn.body).toContain(sweep);
    expect(baseFn.body).toContain(sweep);
  });

  it("counts only the caller's own key over a 15-minute window with a per-key cap of 5", () => {
    expect(fn.body).toContain("c_window constant interval := interval '15 minutes';");
    expect(fn.body).toContain("c_per_key constant integer := 5;");
    expect(fn.body).toContain("a.key_hash = p_key_hash and a.attempted_at > v_now - c_window");
    expect(fn.body).toContain("if v_key_n >= c_per_key then");
  });

  it("has no global cap: every statement that reads admin_login_attempts is filtered by the key", () => {
    // No unfiltered count and no global constant or counter survives from 086.
    for (const gone of ["c_global", "v_all_n", "v_all_first", "v_all"]) {
      expect(fn.body.includes(gone), gone).toBe(false);
    }
    expect(countOf(fn.body, "count(")).toBe(1);
    const statements = fn.body.split(";");
    const reads = statements.filter(
      (s) => s.includes("from public.admin_login_attempts") && !s.includes("delete from"),
    );
    expect(reads).toHaveLength(1);
    for (const s of reads) {
      expect(s).toContain("count(");
      expect(s).toContain("a.key_hash = p_key_hash");
    }
    // 086 is the control: it does carry the global counter.
    expect(baseFn.body).toContain("c_global constant integer := 50;");
    expect(baseFn.body).toContain("v_all_n");
  });

  it("derives retry_after_seconds from the oldest counted attempt of the key", () => {
    expect(fn.body).toContain("into v_key_n, v_key_first");
    expect(fn.body).toContain(
      canon("extract(epoch from (v_key_first + c_window - v_now))"),
    );
    expect(fn.body).toContain("retry_after_seconds := greatest(v_retry, 1);");
  });

  it("records an attempt only AFTER the blocked branch's return, so blocked attempts are never written", () => {
    const blockedAt = fn.body.indexOf("allowed := false;");
    expect(blockedAt).toBeGreaterThan(-1);
    const returnAfterBlocked = fn.body.indexOf("return;", blockedAt);
    expect(returnAfterBlocked).toBeGreaterThan(blockedAt);
    expect(countOf(fn.body, "insert into public.admin_login_attempts")).toBe(1);
    const insertAt = fn.body.indexOf("insert into public.admin_login_attempts");
    expect(insertAt).toBeGreaterThan(returnAfterBlocked);
    expect(fn.body).toContain(
      "insert into public.admin_login_attempts(key_hash, attempted_at) values(p_key_hash, v_now);",
    );
    expect(fn.body).toContain("allowed := true;");
  });

  it("documents the function with a comment", () => {
    expect(code).toContain(`comment on function ${FN}(text) is`);
  });

  it("revokes from anon, authenticated and public, and grants execute to service_role only", () => {
    const revoke = `revoke all on function ${FN}(text) from anon, authenticated, public;`;
    const grant = `grant execute on function ${FN}(text) to service_role;`;
    expect(code).toContain(revoke);
    expect(code).toContain(grant);
    expect(code.indexOf(revoke)).toBeLessThan(code.indexOf(grant));
  });

  it("never grants to anon, authenticated or public", () => {
    const grants = code
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.startsWith("grant "));
    expect(grants).toEqual([`grant execute on function ${FN}(text) to service_role`]);
    for (const g of grants) {
      expect(g.includes("anon")).toBe(false);
      expect(g.includes("authenticated")).toBe(false);
      expect(g.includes("public ")).toBe(false);
    }
  });

  it("leaves migration 086 untouched and does not redefine admin_login_throttle(text)", () => {
    const base = read(resolve(MIGRATIONS_DIR, BASE_MIGRATION));
    expect(createHash("sha256").update(base).digest("hex")).toBe(BASE_SHA256);
    expect(code.includes("function public.admin_login_throttle(")).toBe(false);
    expect(code.includes("on public.admin_login_attempts")).toBe(false);
    expect(baseFn.body).toContain("c_per_key constant integer := 5;");
    expect(baseFn.body).toContain("c_global constant integer := 50;");
  });

  it("states the defence in its header comment without a how-to", () => {
    const head = raw.split("\n").slice(0, 80).join("\n").toLowerCase();
    expect(head).toContain("device");
    expect(head).toContain("apply before the");
    expect(head).toContain("delete from public.admin_login_attempts");
    // The header explains why the function exists; it does not coach a caller.
    for (const coaching of ["you can", "step 1", "step-by-step"]) {
      expect(head.includes(coaching), coaching).toBe(false);
    }
  });
});
