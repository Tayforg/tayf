import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 124 ("saved-clusters-v2").
//
// saved_clusters_v2(p_ids uuid[]) is saved_clusters (migration 116) plus one
// extra column, is_blindspot, so /saved can render the same "Kor nokta" pill
// and spectrum bar the feed cards show. v1 is NOT touched: bookmark-snapshots.ts
// still calls it (and saved-list.tsx falls back to it on PGRST202 while 124 is
// not applied yet).
//
// Properties pinned here:
//   - additive: one create-or-replace function, one revoke, one grant (execute
//     to anon + service_role, never authenticated), a comment, notify, ledger;
//   - same caps and truncation as v1 (p_ids[1:200], order by updated_at desc,
//     limit 200) -- parity-checked against 116's saved_clusters body;
//   - exactly the 7 documented return columns, in order.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATION = "124_saved_clusters_v2.sql";
const MIGRATION_116 = "116_anon_public_rpcs.sql";

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

/** Everything before `as $fn$`: signature, return shape, attributes. */
function header(block: string): string {
  const idx = block.search(/\bas\s+\$fn\$/i);
  return block.slice(0, idx);
}

function body(block: string): string {
  const m = block.match(/\$fn\$([\s\S]*?)\$fn\$/);
  if (!m || m[1] === undefined) throw new Error("no $fn$ body");
  return m[1];
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

/** `select <list> from ...` -> normalised select list. */
function selectList(b: string): string {
  const m = norm(b).match(/^select (.*?) from /);
  if (!m || m[1] === undefined) throw new Error("no select list");
  return m[1];
}

/** Normalised text after the select list: from / where / order / limit. */
function tail(b: string): string {
  const n = norm(b);
  const idx = n.indexOf(" from ");
  if (idx === -1) throw new Error("no from clause");
  return n.slice(idx + 1);
}

describe("migration 124_saved_clusters_v2.sql (SQL contract)", () => {
  let sql = "";
  let code = "";
  let block = "";
  let sql116 = "";
  let code116 = "";

  beforeAll(() => {
    const path = resolve(REPO_ROOT, "supabase", "migrations", MIGRATION);
    expect(existsSync(path), `${MIGRATION} must exist`).toBe(true);
    sql = readFileSync(path, "utf8");
    code = stripComments(sql);
    block = functionBlock(code, "saved_clusters_v2");
    sql116 = readFileSync(resolve(REPO_ROOT, "supabase", "migrations", MIGRATION_116), "utf8");
    code116 = stripComments(sql116);
  });

  it("contains the ledger insert for '124'", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'124'\s*,\s*'124_saved_clusters_v2'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("is a single transaction with a bounded lock wait", () => {
    expect(code).toMatch(/^\s*begin\s*;/im);
    expect(code).toMatch(/\bcommit\s*;\s*$/i);
    expect(code).toMatch(/set\s+local\s+lock_timeout\s*=\s*'5s'\s*;/i);
    const beginAt = code.search(/^\s*begin\s*;/im);
    const commitAt = code.search(/\bcommit\s*;\s*$/i);
    const ledgerAt = code.search(/insert\s+into\s+supabase_migrations\.schema_migrations/i);
    expect(ledgerAt).toBeGreaterThan(beginAt);
    expect(ledgerAt).toBeLessThan(commitAt);
  });

  it("asks PostgREST to reload its schema cache", () => {
    expect(code).toMatch(/notify\s+pgrst\s*,\s*'reload schema'\s*;/i);
  });

  it("is additive: no drop, alter table, create table/policy/view/index/trigger, table or sequence grants, default privileges", () => {
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(code).not.toMatch(/\balter\s+table\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bcreate\s+(table|policy|view|index|trigger)\b/i);
    expect(code).not.toMatch(/\bon\s+(table|sequence|all\s+tables|all\s+sequences|schema)\b/i);
    expect(code).not.toMatch(/\bgrant\s+(select|insert|update|delete|truncate|maintain|usage|all)\b/i);
    expect(code).not.toMatch(/\balter\s+default\s+privileges\b/i);
  });

  it("creates exactly one function and never redefines v1", () => {
    expect(code.match(/\bcreate\s+(?:or\s+replace\s+)?function\b/gi)).toHaveLength(1);
    expect(code).not.toMatch(/function\s+public\.saved_clusters\s*\(/i);
  });

  it("has exactly one revoke and one grant, the grant to anon, service_role and never authenticated", () => {
    const revokes = code.match(/\brevoke\b[^;]*;/gi) ?? [];
    const grants = code.match(/\bgrant\b[^;]*;/gi) ?? [];
    expect(revokes).toHaveLength(1);
    expect(grants).toHaveLength(1);
    expect(revokes[0]).toMatch(
      /^revoke\s+all\s+on\s+function\s+public\.saved_clusters_v2\s*\(\s*uuid\[\]\s*\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*;$/i,
    );
    expect(grants[0]).toMatch(
      /^grant\s+execute\s+on\s+function\s+public\.saved_clusters_v2\s*\(\s*uuid\[\]\s*\)\s+to\s+anon\s*,\s*service_role\s*;$/i,
    );
    expect(grants[0]).not.toMatch(/authenticated/i);
  });

  it("documents the function with a comment that points at the v1 consumer", () => {
    expect(code).toMatch(/comment\s+on\s+function\s+public\.saved_clusters_v2\s*\(\s*uuid\[\]\s*\)\s+is\s+'/i);
    const m = code.match(/comment\s+on\s+function[^;]*;/i);
    expect(m?.[0]).toMatch(/bookmark-snapshots\.ts/);
    expect(m?.[0]).toMatch(/v1/i);
  });

  it("takes the documented argument list", () => {
    expect(header(block)).toMatch(/function\s+public\.saved_clusters_v2\s*\(\s*p_ids\s+uuid\[\]\s*\)/i);
  });

  it("is language sql, stable, SECURITY DEFINER with an empty search_path", () => {
    const h = header(block);
    expect(h).toMatch(/\blanguage\s+sql\b/i);
    expect(h).toMatch(/\bstable\b/i);
    expect(h).not.toMatch(/\b(volatile|immutable)\b/i);
    expect(h).toMatch(/\bsecurity\s+definer\b/i);
    expect(h).toMatch(/\bset\s+search_path\s*=\s*''/i);
  });

  it("reads only schema-qualified relations (search_path is empty)", () => {
    const b = body(block);
    const rels = Array.from(b.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_.]*)/gi), (m) => m[1]);
    expect(rels.length).toBeGreaterThan(0);
    for (const r of rels) expect(r, "unqualified relation").toMatch(/^public\./i);
  });

  it("returns exactly the 7 columns, in order", () => {
    expect(norm(header(block))).toMatch(
      /returns table \( id uuid, title_tr text, title_tr_neutral text, article_count integer, bias_distribution jsonb, updated_at timestamptz, is_blindspot boolean \)/,
    );
    // And nothing else sneaks in between the parentheses.
    const cols = header(block).match(/returns\s+table\s*\(([\s\S]*?)\)\s*language/i)?.[1] ?? "";
    expect(cols.split(",").map((c) => c.trim().split(/\s+/)[0])).toEqual([
      "id",
      "title_tr",
      "title_tr_neutral",
      "article_count",
      "bias_distribution",
      "updated_at",
      "is_blindspot",
    ]);
  });

  it("truncates over-cap input, caps the result at 200 and never raises", () => {
    const b = body(block);
    expect(b).toMatch(/coalesce\s*\(\s*p_ids\[1:200\]\s*,\s*'\{\}'::uuid\[\]\s*\)/i);
    expect(b).toMatch(/order\s+by\s+c\.updated_at\s+desc/i);
    expect(b).toMatch(/\blimit\s+200\b/i);
    expect(b).toMatch(/from\s+public\.clusters\s+c\b/i);
    expect(block).not.toMatch(/\braise\b/i);
    // No archived filter: parity with v1, /saved keeps archived stories.
    expect(b).not.toMatch(/is_archived/i);
  });

  it("selects exactly the v1 select list plus c.is_blindspot, with the identical from/where/order/limit", () => {
    const v1 = body(functionBlock(code116, "saved_clusters"));
    const v2 = body(block);
    expect(selectList(v2)).toBe(`${selectList(v1)}, c.is_blindspot`);
    expect(tail(v2)).toBe(tail(v1));
    // Sanity: the parity helpers are not vacuous.
    expect(selectList(v1)).toContain("c.bias_distribution");
    expect(tail(v1)).toContain("limit 200");
  });

  it("header documents purpose, verification and rollback, and leaves v1 alone", () => {
    expect(sql).toMatch(/^-- 124_saved_clusters_v2\.sql/);
    expect(sql).toMatch(/Rollback/i);
    expect(sql).toMatch(/drop function public\.saved_clusters_v2\(uuid\[\]\);/);
    expect(sql).toMatch(/Verification/i);
    expect(sql).toMatch(/PGRST202/);
  });
});
