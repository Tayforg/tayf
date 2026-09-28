import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 072 ("Çerçeve draw fast path").
//
// 068's framing_next_headline started from `articles` (48 h window) and ran
// an EXISTS against jev_shadow_predictions per row. With no (article_id,
// task) index, the planner bitmap-scanned every politics prediction ever
// written (18 s cold in production, against PostgREST's 8 s
// statement_timeout), so GET /api/oyun/cerceve/next returned 500 on every
// call and framing_votes stayed at 0 rows.
//
// 072 re-creates the SAME function (same name, argument, return shape,
// SECURITY DEFINER + empty search_path, same grants) but drives it from
// jev_shadow_predictions through (task, created_at desc), which bounds the
// work by the recent window instead of the table's lifetime. The route
// (src/app/api/oyun/cerceve/next/route.ts) is untouched, so this file pins
// every piece of the contract the route depends on.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "supabase", "migrations");
const MIGRATION = "072_framing_draw_fast.sql";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Strip `--` line comments so prose can never satisfy a code guard. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** The `create or replace function public.<name>(...) ... $fn$ ... $fn$;` block. */
function functionBlock(sql: string, name: string): string {
  const re = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\([\\s\\S]*?\\$fn\\$[\\s\\S]*?\\$fn\\$\\s*;`,
    "i",
  );
  const m = sql.match(re);
  if (!m) throw new Error(`function ${name} not found`);
  return m[0];
}

/** Everything before `as $fn$`: signature, return shape, attributes. */
function header(block: string): string {
  const idx = block.search(/\bas\s+\$fn\$/i);
  return block.slice(0, idx);
}

/** Only the SQL body between the $fn$ quotes. */
function body(block: string): string {
  const m = block.match(/\$fn\$([\s\S]*?)\$fn\$/);
  if (!m || m[1] === undefined) throw new Error("no $fn$ body");
  return m[1];
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

describe("migration 072_framing_draw_fast.sql (SQL contract)", () => {
  let sql = "";
  let code = "";
  let fn072 = "";
  let fn068 = "";

  beforeAll(() => {
    const path = resolve(MIGRATIONS_DIR, MIGRATION);
    expect(existsSync(path), `${MIGRATION} must exist`).toBe(true);
    sql = read(path);
    code = stripComments(sql);
    fn072 = functionBlock(code, "framing_next_headline");
    fn068 = functionBlock(
      stripComments(read(resolve(MIGRATIONS_DIR, "068_framing_votes.sql"))),
      "framing_next_headline",
    );
  });

  it("contains the ledger insert for '072'", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'072'\s*,\s*'072_framing_draw_fast'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("is wrapped in a single transaction", () => {
    expect(code).toMatch(/^\s*begin\s*;/im);
    expect(code).toMatch(/\bcommit\s*;\s*$/i);
  });

  it("is additive-only: no DROP, no ALTER TABLE, no new table", () => {
    expect(code).not.toMatch(/\bdrop\s+(table|function|index|column|policy|view)\b/i);
    expect(code).not.toMatch(/\balter\s+table\b/i);
    expect(code).not.toMatch(/\bcreate\s+table\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\b(delete\s+from|update\s+public\.)/i);
  });

  it("re-creates framing_next_headline with the identical signature and return shape as 068", () => {
    expect(fn072).toMatch(
      /create\s+or\s+replace\s+function\s+public\.framing_next_headline\s*\(\s*p_session_hash\s+text\s*\)/i,
    );
    expect(norm(header(fn072))).toBe(norm(header(fn068)));
    expect(header(fn072)).toMatch(
      /returns\s+table\s*\(\s*article_id\s+uuid\s*,\s*title\s+text\s*\)/i,
    );
  });

  it("stays a read-only STABLE SQL function, SECURITY DEFINER with an empty search_path", () => {
    const h = header(fn072);
    expect(h).toMatch(/\blanguage\s+sql\b/i);
    expect(h).toMatch(/\bstable\b/i);
    expect(h).toMatch(/\bsecurity\s+definer\b/i);
    expect(h).toMatch(/\bset\s+search_path\s*=\s*''/i);
    expect(h).not.toMatch(/\bvolatile\b/i);
  });

  it("re-asserts the 068 grants: revoked from anon/authenticated/public, execute to service_role only", () => {
    expect(code).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.framing_next_headline\s*\(\s*text\s*\)\s+from\s+anon\s*,\s*authenticated\s*,\s*public\s*;/i,
    );
    expect(code).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.framing_next_headline\s*\(\s*text\s*\)\s+to\s+service_role\s*;/i,
    );
    expect(code).not.toMatch(
      /grant\s+[\w\s,]*on\s+function\s+public\.framing_next_headline[\s\S]*?to\s+[\w\s,]*\b(anon|authenticated|public)\b/i,
    );
  });

  it("drives the draw from jev_shadow_predictions (task, created_at) -- the first relation scanned", () => {
    const b = body(fn072);
    const firstFrom = b.match(/\bfrom\s+public\.(\w+)/i);
    expect(firstFrom?.[1]).toBe("jev_shadow_predictions");
    // Materialised so the planner cannot fold it back into a semi-join over
    // every politics prediction ever written (the 068 plan).
    expect(b).toMatch(/\bas\s+materialized\s*\(/i);
    expect(b).toMatch(/\.task\s*=\s*'politics'/i);
    expect(b).toMatch(/\.jev_prob\s*>=\s*0\.7\b/i);
    expect(b).toMatch(/\.created_at\s*>=\s*now\(\)\s*-\s*interval\s*'\d+\s+hours'/i);
  });

  it("the predictions window covers at least the 48 h article window (created_at >= published_at)", () => {
    const b = body(fn072);
    const m = b.match(/\.created_at\s*>=\s*now\(\)\s*-\s*interval\s*'(\d+)\s+hours'/i);
    expect(m).not.toBeNull();
    const hours = Number(m?.[1]);
    expect(hours).toBeGreaterThanOrEqual(48);
    // Bounded: a wide window would re-introduce the lifetime scan.
    expect(hours).toBeLessThanOrEqual(96);
  });

  it("no longer runs a per-article EXISTS against jev_shadow_predictions (the 18 s shape)", () => {
    expect(body(fn072)).not.toMatch(
      /exists\s*\(\s*select[\s\S]{0,80}?from\s+public\.jev_shadow_predictions/i,
    );
  });

  it("preserves 068's eligibility filters exactly", () => {
    const b = body(fn072);
    expect(b).toMatch(/\.published_at\s*>=\s*now\(\)\s*-\s*interval\s*'48 hours'/i);
    expect(b).toMatch(/join\s+public\.articles\s+a\s+on\s+a\.id\s*=/i);
    expect(b).toMatch(/join\s+public\.sources\s+s\s+on\s+s\.id\s*=\s*a\.source_id/i);
    expect(b).toMatch(/\bs\.active\b/i);
    expect(b).toMatch(/coalesce\s*\(\s*s\.kind\s*,\s*'outlet'\s*\)\s*<>\s*'wire'/i);
  });

  it("keeps the not-voted-by-this-session anti-join on framing_votes", () => {
    expect(body(fn072)).toMatch(
      /not\s+exists\s*\(\s*select\s+1\s+from\s+public\.framing_votes\s+v\s+where\s+v\.article_id\s*=\s*a\.id\s+and\s+v\.session_hash\s*=\s*p_session_hash\s*\)/i,
    );
  });

  it("keeps the newest-300 pool and the <5-votes-first random draw of one row", () => {
    const b = body(fn072);
    expect(b).toMatch(/order\s+by\s+a\.published_at\s+desc\s+limit\s+300/i);
    expect(b).toMatch(/left\s+join\s+public\.framing_votes\s+v\s+on\s+v\.article_id\s*=/i);
    expect(b).toMatch(/order\s+by\s*\(\s*t\.vote_count\s*>=\s*5\s*\)\s*asc\s*,\s*random\(\)\s+limit\s+1\s*;?\s*$/i);
  });

  it("refreshes the function comment", () => {
    expect(code).toMatch(/comment\s+on\s+function\s+public\.framing_next_headline\s*\(\s*text\s*\)\s+is/i);
  });

  it("the route still calls the same RPC with the same argument name", () => {
    const route = read(resolve(REPO_ROOT, "src", "app", "api", "oyun", "cerceve", "next", "route.ts"));
    expect(route).toMatch(/\.rpc\(\s*"framing_next_headline"\s*,\s*\{\s*p_session_hash:/);
  });
});
