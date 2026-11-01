import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 123 ("entity cluster ids"), modelled
// on tests/migrations/083-reader-query-rpcs.test.ts.
//
// 123 adds ONE read-only, ids-first RPC, public.entity_cluster_ids, behind the
// /gundem/[key] entity hubs. 083's search_cluster_ids orders by article_count
// with no time window, so it cannot serve a RECENCY hub; this one windows on
// clusters.updated_at (14 days by default, never wider than 30), orders newest
// first and returns the full match count next to every id. This file pins the
// SQL contract entity-hub-query.ts depends on, including that the tsquery block
// is the very same text as 083's (so the two searches cannot drift apart).
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "supabase", "migrations");
const MIGRATION = "123_entity_cluster_ids.sql";
const SEARCH_MIGRATION = "083_reader_query_rpcs.sql";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Strip `--` line comments so prose can never satisfy a code guard. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Collapse all whitespace runs to one space. */
function norm(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
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

/** The `c.search_tsv @@ ( ... )` operand: the 3-variant OR'd tsquery block. */
function tsqueryBlock(fnBody: string): string {
  const m = fnBody.match(
    /c\.search_tsv\s*@@\s*\(([\s\S]*?)\)\s*and\s+not\s+c\.is_archived/i,
  );
  if (!m || m[1] === undefined) throw new Error("no tsquery block");
  return norm(m[1]);
}

describe("migration 123_entity_cluster_ids.sql (SQL contract)", () => {
  let sql = "";
  let code = "";
  let fn = "";
  let fnBody = "";

  beforeAll(() => {
    const path = resolve(MIGRATIONS_DIR, MIGRATION);
    expect(existsSync(path), `${MIGRATION} must exist`).toBe(true);
    sql = read(path);
    code = stripComments(sql);
    fn = functionBlock(code, "entity_cluster_ids");
    fnBody = body(fn);
  });

  it("documents purpose, the measured counts and the rollback in its header comment", () => {
    const head = sql.slice(0, sql.search(/^\s*begin\s*;/im));
    expect(head).toMatch(/G2/);
    expect(head).toMatch(/search_cluster_ids/);
    expect(head).toMatch(/Erdoğan[^\n]*422/);
    expect(head).toMatch(/CHP[^\n]*194/);
    expect(head).toMatch(/YSK[^\n]*\b1\b/);
    expect(head).toContain(
      "drop function public.entity_cluster_ids(text[], timestamptz, integer);",
    );
    expect(head).toContain(
      "delete from supabase_migrations.schema_migrations where version='123';",
    );
  });

  it("contains the ledger insert for '123' with on conflict do nothing", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'123'\s*,\s*'123_entity_cluster_ids'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("is wrapped in a single begin/commit transaction with a 5 s lock_timeout", () => {
    expect(code).toMatch(/^\s*begin\s*;/im);
    expect(code).toMatch(/\bcommit\s*;\s*$/i);
    expect(code.match(/\bbegin\s*;/gi)?.length).toBe(1);
    expect(code.match(/\bcommit\s*;/gi)?.length).toBe(1);
    expect(code).toMatch(/set\s+local\s+lock_timeout\s*=\s*'5s'\s*;/i);
  });

  it("is additive-only: no DROP, ALTER TABLE, TRUNCATE, DELETE or UPDATE statements", () => {
    expect(code).not.toMatch(/\bdrop\s+/i);
    expect(code).not.toMatch(/\balter\s+/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    expect(code).not.toMatch(/\bupdate\s+public\./i);
    expect(code).not.toMatch(/\bcreate\s+(table|index|view|trigger|extension)\b/i);
  });

  it("writes only the migration ledger", () => {
    const inserts = code.match(/\binsert\s+into\s+[\w.]+/gi) ?? [];
    expect(inserts.map((s) => s.replace(/\s+/g, " ").toLowerCase())).toEqual([
      "insert into supabase_migrations.schema_migrations",
    ]);
  });

  it("has the exact signature and return shape", () => {
    expect(norm(fn)).toMatch(
      /^create or replace function public\.entity_cluster_ids\( ?p_variants text\[\], p_since timestamptz default null, p_limit integer default 20 ?\)/i,
    );
    expect(norm(header(fn))).toMatch(/returns table \( ?id uuid, total bigint ?\)/i);
  });

  it("is language sql, stable, security definer with an empty search_path", () => {
    const h = header(fn);
    expect(h).toMatch(/\blanguage\s+sql\b/i);
    expect(h).toMatch(/\bstable\b/i);
    expect(h).toMatch(/\bsecurity\s+definer\b/i);
    expect(h).toMatch(/\bset\s+search_path\s*=\s*''/i);
    expect(h).not.toMatch(/\bvolatile\b/i);
    expect(h).not.toMatch(/\bsecurity\s+invoker\b/i);
  });

  it("ORs the same three websearch_to_tsquery('turkish', ...) calls as 083 (whitespace-normalised)", () => {
    const search083 = stripComments(read(resolve(MIGRATIONS_DIR, SEARCH_MIGRATION)));
    const block083 = tsqueryBlock(body(functionBlock(search083, "search_cluster_ids")));
    const block123 = tsqueryBlock(fnBody);
    expect(block123).toBe(block083);
    expect(block123.match(/websearch_to_tsquery\s*\(/gi)?.length).toBe(3);
    expect(block123).toMatch(/pg_catalog\.regconfig/);
  });

  it("carries the live predicate literals (same as the 083 partial index) plus merged_into", () => {
    expect(fnBody).toMatch(/\band\s+not\s+c\.is_archived\b/i);
    expect(fnBody).toMatch(/\band\s+c\.article_count\s*>=\s*2\b/i);
    expect(fnBody).toMatch(/\band\s+c\.merged_into\s+is\s+null\b/i);
  });

  it("windows on updated_at: 14-day default when p_since is null, 30-day floor", () => {
    expect(norm(fnBody)).toContain(
      "c.updated_at >= greatest(coalesce(p_since, pg_catalog.now() - interval '14 days'), pg_catalog.now() - interval '30 days')",
    );
    // The window is clock-relative inside Postgres: the app never passes p_since.
    expect(fnBody).not.toMatch(/(?<!pg_catalog\.)\bnow\s*\(/i);
  });

  it("clamps p_limit to 1..50 with a default of 20", () => {
    expect(norm(fnBody)).toContain("limit greatest(1, least(coalesce(p_limit, 20), 50))");
  });

  it("orders newest first with an id tiebreak (not by article_count)", () => {
    expect(norm(fnBody)).toContain("order by c.updated_at desc, c.id");
    expect(fnBody).not.toMatch(/order\s+by\s+c\.article_count/i);
  });

  it("returns the full match count next to every id via count(*) over ()", () => {
    expect(norm(fnBody)).toContain("(pg_catalog.count(*) over ())::bigint");
    expect(norm(fnBody)).toMatch(/^select c\.id, \(pg_catalog\.count\(\*\) over \(\)\)::bigint from public\.clusters c where /i);
  });

  it("uses greatest/least as SQL constructs, never pg_catalog-qualified", () => {
    expect(fnBody).not.toMatch(/pg_catalog\.(greatest|least|coalesce)\b/i);
  });

  it("only references schema-qualified relations (search_path is empty)", () => {
    const rels = [...fnBody.matchAll(/\b(?:from|join)\s+([^\s(,]+)/gi)].map((m) => m[1]!);
    expect(rels.length).toBeGreaterThan(0);
    for (const rel of rels) {
      expect(rel, `unqualified relation ${rel}`).toMatch(/^public\.[a-z_]+$/i);
    }
    // Functions are pg_catalog-qualified too (except SQL constructs).
    const calls = [...fnBody.matchAll(/(?<![\w.])([a-z_][a-z0-9_]*)\s*\(/gi)]
      .map((m) => m[1]!.toLowerCase())
      .filter((n) => !["greatest", "least", "coalesce", "select", "in", "over", "interval"].includes(n));
    expect(calls).toEqual([]);
  });

  it("is documented with a comment ending 'service_role only.'", () => {
    expect(code).toMatch(
      /comment\s+on\s+function\s+public\.entity_cluster_ids\s*\(\s*text\[\]\s*,\s*timestamptz\s*,\s*integer\s*\)\s+is\s+'[\s\S]*?service_role only\.'\s*;/i,
    );
  });

  it("is revoked from public/anon/authenticated and granted only to service_role", () => {
    expect(code).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.entity_cluster_ids\s*\(\s*text\[\]\s*,\s*timestamptz\s*,\s*integer\s*\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*;/i,
    );
    expect(code).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.entity_cluster_ids\s*\(\s*text\[\]\s*,\s*timestamptz\s*,\s*integer\s*\)\s+to\s+service_role\s*;/i,
    );
    const grants = (code.match(/\bgrant\b[^;]*;/gi) ?? []).map(norm);
    expect(grants).toHaveLength(1);
    for (const g of grants) {
      expect(g).not.toMatch(/\bto\s+anon\b/i);
      expect(g).not.toMatch(/\bauthenticated\b/i);
      expect(g).not.toMatch(/\bpublic\s*;?$/i);
    }
  });

  it("grants nothing on tables, sequences or default privileges", () => {
    expect(code).not.toMatch(/\bgrant\b[^;]*\bon\s+(all\s+)?(table|tables|sequence|sequences)\b/i);
    expect(code).not.toMatch(/\balter\s+default\s+privileges\b/i);
    expect(code).not.toMatch(/\bgrant\s+(select|insert|update|delete|truncate|maintain|all)\b/i);
  });

  it("reloads the PostgREST schema cache", () => {
    expect(code).toMatch(/notify\s+pgrst\s*,\s*'reload schema'\s*;/i);
  });

  it("is idempotent: create or replace + on conflict do nothing", () => {
    expect(code).toMatch(/create\s+or\s+replace\s+function/i);
    expect(code).toMatch(/on\s+conflict\s+do\s+nothing/i);
  });
});

describe("entity-hub-query.ts is the only caller", () => {
  it("calls rpc('entity_cluster_ids') with p_variants and p_limit, never p_since", () => {
    const path = resolve(REPO_ROOT, "src", "lib", "entities", "entity-hub-query.ts");
    expect(existsSync(path), "entity-hub-query.ts must exist").toBe(true);
    const src = read(path)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/gm, "$1");
    const call = src.match(/\.rpc\(\s*"entity_cluster_ids"\s*,\s*\{([\s\S]*?)\}\s*\)/);
    expect(call, "rpc call not found").not.toBeNull();
    expect(call![1]).toMatch(/p_variants/);
    expect(call![1]).toMatch(/p_limit/);
    expect(call![1]).not.toMatch(/p_since/);
  });
});
