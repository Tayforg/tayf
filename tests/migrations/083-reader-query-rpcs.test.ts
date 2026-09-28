import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 083 ("reader-query RPCs"),
// modelled on tests/migrations/072-framing-draw-fast.test.ts.
//
// 083 adds two ids-first, read-only RPCs (search_cluster_ids,
// headline_neutral_counts) so the archive search and the neutralizer
// honesty gate never run an expensive lateral embed / double aggregate
// before the winning rows are known. This file pins the SQL contract every
// caller (search-query.ts, status.ts) depends on.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "supabase", "migrations");
const MIGRATION = "083_reader_query_rpcs.sql";

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

describe("migration 083_reader_query_rpcs.sql (SQL contract)", () => {
  let sql = "";
  let code = "";
  let searchFn = "";
  let countsFn = "";

  beforeAll(() => {
    const path = resolve(MIGRATIONS_DIR, MIGRATION);
    expect(existsSync(path), `${MIGRATION} must exist`).toBe(true);
    sql = read(path);
    code = stripComments(sql);
    searchFn = functionBlock(code, "search_cluster_ids");
    countsFn = functionBlock(code, "headline_neutral_counts");
  });

  it("contains the ledger insert for '083' with on conflict do nothing", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'083'\s*,\s*'083_reader_query_rpcs'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("is wrapped in a single begin/commit transaction", () => {
    expect(code).toMatch(/^\s*begin\s*;/im);
    expect(code).toMatch(/\bcommit\s*;\s*$/i);
  });

  it("is additive-only: no DROP, TRUNCATE, DELETE, UPDATE, or ALTER TABLE", () => {
    expect(code).not.toMatch(/\bdrop\s+(table|function|index|column|policy|view)\b/i);
    expect(code).not.toMatch(/\balter\s+table\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\b(delete\s+from|update\s+public\.)/i);
  });

  it("creates both partial indexes with their exact documented predicates", () => {
    expect(code).toMatch(
      /create\s+index\s+if\s+not\s+exists\s+clusters_search_tsv_live_idx\s+on\s+public\.clusters\s+using\s+gin\s*\(\s*search_tsv\s*\)\s*where\s+not\s+is_archived\s+and\s+article_count\s*>=\s*2\s*;/i,
    );
    expect(code).toMatch(
      /create\s+index\s+if\s+not\s+exists\s+clusters_neutral_eligible_idx\s+on\s+public\.clusters\s*\(\s*title_neutral_at\s*\)\s*where\s+article_count\s*>=\s*3\s*;/i,
    );
  });

  it("search_cluster_ids: correct signature and return shape", () => {
    expect(searchFn).toMatch(
      /create\s+or\s+replace\s+function\s+public\.search_cluster_ids\s*\(\s*p_variants\s+text\[\]\s*,\s*p_limit\s+integer\s+default\s+12\s*\)/i,
    );
    expect(header(searchFn)).toMatch(/returns\s+table\s*\(\s*id\s+uuid\s*\)/i);
  });

  it("headline_neutral_counts: correct signature and return shape", () => {
    expect(countsFn).toMatch(
      /create\s+or\s+replace\s+function\s+public\.headline_neutral_counts\s*\(\s*\)/i,
    );
    expect(header(countsFn)).toMatch(
      /returns\s+table\s*\(\s*eligible\s+bigint\s*,\s*neutralized\s+bigint\s*\)/i,
    );
  });

  it("both functions are language sql, stable, security definer, empty search_path", () => {
    for (const fn of [searchFn, countsFn]) {
      const h = header(fn);
      expect(h).toMatch(/\blanguage\s+sql\b/i);
      expect(h).toMatch(/\bstable\b/i);
      expect(h).toMatch(/\bsecurity\s+definer\b/i);
      expect(h).toMatch(/\bset\s+search_path\s*=\s*''/i);
      expect(h).not.toMatch(/\bvolatile\b/i);
    }
  });

  it("both functions are revoked from anon/authenticated/public and granted only to service_role", () => {
    expect(code).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.search_cluster_ids\s*\(\s*text\[\]\s*,\s*integer\s*\)\s+from\s+anon\s*,\s*authenticated\s*,\s*public\s*;/i,
    );
    expect(code).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.search_cluster_ids\s*\(\s*text\[\]\s*,\s*integer\s*\)\s+to\s+service_role\s*;/i,
    );
    expect(code).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.headline_neutral_counts\s*\(\s*\)\s+from\s+anon\s*,\s*authenticated\s*,\s*public\s*;/i,
    );
    expect(code).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.headline_neutral_counts\s*\(\s*\)\s+to\s+service_role\s*;/i,
    );
    expect(code).not.toMatch(
      /grant\s+[\w\s,]*on\s+function\s+public\.(search_cluster_ids|headline_neutral_counts)[\s\S]*?to\s+[\w\s,]*\b(anon|authenticated|public)\b/i,
    );
  });

  it("search_cluster_ids's predicate matches the live index predicate literally", () => {
    const b = body(searchFn);
    expect(b).toMatch(/not\s+c\.is_archived/i);
    expect(b).toMatch(/c\.article_count\s*>=\s*2\b/i);
  });

  it("search_cluster_ids ORs three websearch_to_tsquery('turkish', ...) calls together", () => {
    const b = body(searchFn);
    const matches = b.match(/websearch_to_tsquery\s*\(/gi) ?? [];
    expect(matches.length).toBe(3);
    expect(b).toMatch(/turkish/i);
    expect(b).toMatch(/\|\|/);
  });

  it("search_cluster_ids caps and floors p_limit", () => {
    const b = body(searchFn);
    expect(b).toMatch(/greatest\s*\(\s*1\s*,\s*least\s*\(/i);
  });

  it("headline_neutral_counts's literal 3 equals HEADLINE_MIN_ARTICLE_COUNT (src/lib/headline/prompt.ts)", () => {
    const promptSrc = read(resolve(REPO_ROOT, "src", "lib", "headline", "prompt.ts"));
    const m = promptSrc.match(/HEADLINE_MIN_ARTICLE_COUNT\s*=\s*(\d+)/);
    expect(m).not.toBeNull();
    const constant = Number(m?.[1]);

    const b = body(countsFn);
    const literalMatch = b.match(/article_count\s*>=\s*(\d+)/i);
    expect(literalMatch).not.toBeNull();
    expect(Number(literalMatch?.[1])).toBe(constant);
  });

  it("headline_neutral_counts computes both counts in a single scan (one FROM clusters)", () => {
    const b = body(countsFn);
    const fromMatches = b.match(/\bfrom\s+public\.clusters\b/gi) ?? [];
    expect(fromMatches.length).toBe(1);
    expect(b).toMatch(/count\s*\(\s*\*\s*\)/i);
    expect(b).toMatch(/filter\s*\(\s*where\s+c\.title_neutral_at\s+is\s+not\s+null\s*\)/i);
  });

  it("search-query.ts calls rpc('search_cluster_ids', ...) with p_variants", () => {
    const src = read(
      resolve(REPO_ROOT, "src", "lib", "clusters", "search-query.ts"),
    );
    expect(src).toMatch(/\.rpc\(\s*"search_cluster_ids"\s*,\s*\{[\s\S]*?p_variants/);
  });

  it("status.ts calls rpc('headline_neutral_counts')", () => {
    const src = read(resolve(REPO_ROOT, "src", "lib", "headline", "status.ts"));
    expect(src).toMatch(/\.rpc\(\s*"headline_neutral_counts"\s*\)/);
  });

  it("is idempotent: applying it twice does not change its own SQL (create or replace / IF NOT EXISTS / ON CONFLICT everywhere)", () => {
    expect(code).toMatch(/create\s+index\s+if\s+not\s+exists/i);
    expect(code).toMatch(/create\s+or\s+replace\s+function/i);
    expect(code).toMatch(/on\s+conflict\s+do\s+nothing/i);
  });
});
