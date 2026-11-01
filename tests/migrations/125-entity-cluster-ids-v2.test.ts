import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { RISING_FOLD_FROM, RISING_FOLD_TO } from "@/lib/trends/rising-entities";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 125 ("precise entity hubs"), modelled
// on tests/migrations/123-entity-cluster-ids.test.ts.
//
// 123's entity_cluster_ids matches the Turkish STEMMED tsquery only, so a hub
// for DEVA also lists every story that says "devam" (both stem to "dev"/"deva"
// territory). 125 adds entity_cluster_ids_v2: the same stemmed tsquery as a
// recall prefilter on the GIN index, ANDed with a regex guard on folded text
// (precision), searching every curated spelling and ordered by first_published
// so the card ages (which print first_published) read in order. 123 itself is
// never edited: the app falls back to it on PGRST202 while 125 is unapplied.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "supabase", "migrations");
const MIGRATION = "125_entity_cluster_ids_v2.sql";
const V1_MIGRATION = "123_entity_cluster_ids.sql";
const FN = "entity_cluster_ids_v2";

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

/** Blank every single-quoted string literal (doubled quotes included). */
function blankStrings(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
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

const SIG = String.raw`\(\s*text\[\]\s*,\s*text\[\]\s*,\s*timestamptz\s*,\s*integer\s*\)`;

describe("migration 125_entity_cluster_ids_v2.sql (SQL contract)", () => {
  let sql = "";
  let code = "";
  let fn = "";
  let fnBody = "";

  beforeAll(() => {
    const path = resolve(MIGRATIONS_DIR, MIGRATION);
    expect(existsSync(path), `${MIGRATION} must exist`).toBe(true);
    sql = read(path);
    code = stripComments(sql);
    fn = functionBlock(code, FN);
    fnBody = body(fn);
  });

  it("documents the collisions, the order, the EXPLAIN result and the rollback in its header comment", () => {
    const head = sql.slice(0, sql.search(/^\s*begin\s*;/im));
    for (const word of [
      "devam",
      "deva",
      "domuz",
      "dolar",
      "iyi",
      "Zelensk",
      "AKP",
      "first_published",
      "Bitmap Index Scan",
    ]) {
      expect(head, `header must mention ${word}`).toContain(word);
    }
    expect(head).toContain(
      "drop function public.entity_cluster_ids_v2(text[], text[], timestamptz, integer);",
    );
    expect(head).toContain(
      "delete from supabase_migrations.schema_migrations where version='125';",
    );
    expect(head).toMatch(/^-- 125_entity_cluster_ids_v2\.sql/);
  });

  it("contains the ledger insert for '125' with on conflict do nothing, and it is the only insert", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'125'\s*,\s*'125_entity_cluster_ids_v2'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
    const inserts = code.match(/\binsert\s+into\s+[\w.]+/gi) ?? [];
    expect(inserts.map((s) => s.replace(/\s+/g, " ").toLowerCase())).toEqual([
      "insert into supabase_migrations.schema_migrations",
    ]);
  });

  it("is wrapped in a single begin/commit transaction with a 5 s lock_timeout", () => {
    expect(code).toMatch(/^\s*begin\s*;/im);
    expect(code).toMatch(/\bcommit\s*;\s*$/i);
    expect(code.match(/\bbegin\s*;/gi)?.length).toBe(1);
    expect(code.match(/\bcommit\s*;/gi)?.length).toBe(1);
    expect(code).toMatch(/set\s+local\s+lock_timeout\s*=\s*'5s'\s*;/i);
  });

  it("is additive-only: no DROP, ALTER, TRUNCATE, DELETE, UPDATE or new relations", () => {
    expect(code).not.toMatch(/\bdrop\s+/i);
    expect(code).not.toMatch(/\balter\s+/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    expect(code).not.toMatch(/\bupdate\s+public\./i);
    expect(code).not.toMatch(/\bcreate\s+(table|index|view|trigger|extension)\b/i);
  });

  it("has the exact signature and return shape", () => {
    expect(norm(fn)).toMatch(
      /^create or replace function public\.entity_cluster_ids_v2\( ?p_queries text\[\], p_patterns text\[\], p_since timestamptz default null, p_limit integer default 20 ?\)/i,
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

  it("prefilters on the stemmed tsquery over every query (first 12) using the GIN index", () => {
    expect(norm(fnBody)).toContain(
      "c.search_tsv @@ pg_catalog.websearch_to_tsquery('pg_catalog.turkish'::pg_catalog.regconfig, pg_catalog.array_to_string(p_queries[1:12], ' or '))",
    );
  });

  it("ANDs a regex guard on text folded exactly like migration 112", () => {
    const folded =
      "pg_catalog.lower(pg_catalog.translate(coalesce(c.title_tr, '') || ' ' || coalesce(c.title_tr_neutral, '') || ' ' || coalesce(c.summary_tr, ''), " +
      `'${RISING_FOLD_FROM}', '${RISING_FOLD_TO}')) ~ any (pg_catalog.array_remove(p_patterns[1:12], ''))`;
    expect(norm(fnBody)).toContain(folded);
    // With string literals blanked there is no OR left: the guard is ANDed
    // with the prefilter and with every live predicate.
    expect(blankStrings(fnBody)).not.toMatch(/\bor\b/i);
    expect(norm(fnBody)).toMatch(
      /c\.search_tsv @@ [^;]*?\) and pg_catalog\.lower\(pg_catalog\.translate\(/,
    );
  });

  it("carries the live predicate literals, the 123 window text and the 1..50 limit clamp", () => {
    expect(fnBody).toMatch(/\band\s+not\s+c\.is_archived\b/i);
    expect(fnBody).toMatch(/\band\s+c\.article_count\s*>=\s*2\b/i);
    expect(fnBody).toMatch(/\band\s+c\.merged_into\s+is\s+null\b/i);
    expect(norm(fnBody)).toContain(
      "c.updated_at >= greatest(coalesce(p_since, pg_catalog.now() - interval '14 days'), pg_catalog.now() - interval '30 days')",
    );
    expect(fnBody).not.toMatch(/(?<!pg_catalog\.)\bnow\s*\(/i);
    expect(norm(fnBody)).toContain("limit greatest(1, least(coalesce(p_limit, 20), 50))");
    expect(norm(fnBody)).toContain("(pg_catalog.count(*) over ())::bigint");
    expect(norm(fnBody)).toMatch(
      /^select c\.id, \(pg_catalog\.count\(\*\) over \(\)\)::bigint from public\.clusters c where /i,
    );
  });

  it("orders by first_published desc (id tiebreak), never by updated_at or article_count", () => {
    expect(norm(fnBody)).toContain("order by c.first_published desc, c.id");
    expect(fnBody).not.toMatch(/order\s+by\s+c\.updated_at/i);
    expect(fnBody).not.toMatch(/order\s+by\s+c\.article_count/i);
  });

  it("uses greatest/least as SQL constructs, never pg_catalog-qualified", () => {
    expect(fnBody).not.toMatch(/pg_catalog\.(greatest|least|coalesce)\b/i);
  });

  it("only references schema-qualified relations and functions (search_path is empty)", () => {
    const b = blankStrings(fnBody);
    const rels = [...b.matchAll(/\b(?:from|join)\s+([^\s(,]+)/gi)].map((m) => m[1]!);
    expect(rels.length).toBeGreaterThan(0);
    for (const rel of rels) {
      expect(rel, `unqualified relation ${rel}`).toMatch(/^public\.[a-z_]+$/i);
    }
    const calls = [...b.matchAll(/(?<![\w.])([a-z_][a-z0-9_]*)\s*\(/gi)]
      .map((m) => m[1]!.toLowerCase())
      .filter(
        (n) =>
          !["greatest", "least", "coalesce", "select", "in", "over", "interval", "any"].includes(n),
      );
    expect(calls).toEqual([]);
  });

  it("is documented with a comment ending 'service_role only.'", () => {
    expect(code).toMatch(
      new RegExp(
        String.raw`comment\s+on\s+function\s+public\.entity_cluster_ids_v2\s*${SIG}\s+is\s+'[\s\S]*?service_role only\.'\s*;`,
        "i",
      ),
    );
  });

  it("is revoked from public/anon/authenticated and granted only to service_role", () => {
    expect(code).toMatch(
      new RegExp(
        String.raw`revoke\s+all\s+on\s+function\s+public\.entity_cluster_ids_v2\s*${SIG}\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*;`,
        "i",
      ),
    );
    expect(code).toMatch(
      new RegExp(
        String.raw`grant\s+execute\s+on\s+function\s+public\.entity_cluster_ids_v2\s*${SIG}\s+to\s+service_role\s*;`,
        "i",
      ),
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

  it("leaves 123 untouched: v1 still orders by updated_at (v2 is a new function, not an edit)", () => {
    const v1 = stripComments(read(resolve(MIGRATIONS_DIR, V1_MIGRATION)));
    expect(norm(v1)).toContain("order by c.updated_at desc, c.id");
    expect(v1).not.toMatch(/entity_cluster_ids_v2/);
  });
});

describe("entity-hub-query.ts is the only caller of v2, with a PGRST202-only v1 fallback", () => {
  const path = resolve(REPO_ROOT, "src", "lib", "entities", "entity-hub-query.ts");
  const src = existsSync(path)
    ? read(path)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/[^\n]*/gm, "$1")
    : "";

  it("calls rpc('entity_cluster_ids_v2') with p_queries, p_patterns and p_limit, never p_since", () => {
    expect(existsSync(path), "entity-hub-query.ts must exist").toBe(true);
    const call = src.match(/\.rpc\(\s*"entity_cluster_ids_v2"\s*,\s*\{([\s\S]*?)\}\s*\)/);
    expect(call, "v2 rpc call not found").not.toBeNull();
    expect(call![1]).toMatch(/p_queries/);
    expect(call![1]).toMatch(/p_patterns/);
    expect(call![1]).toMatch(/p_limit/);
    expect(call![1]).not.toMatch(/p_since/);
    expect(src.match(/\.rpc\(\s*"entity_cluster_ids_v2"/g)).toHaveLength(1);
  });

  it("calls the v1 rpc only after a PGRST202 check, and PGRST202 is the only PostgREST code", () => {
    const v2At = src.indexOf('.rpc("entity_cluster_ids_v2"');
    const codeAt = src.indexOf('"PGRST202"');
    const v1At = src.indexOf('.rpc("entity_cluster_ids",');
    expect(v2At).toBeGreaterThan(-1);
    expect(codeAt).toBeGreaterThan(v2At);
    expect(v1At).toBeGreaterThan(codeAt);
    expect(src.match(/\.rpc\(\s*"entity_cluster_ids"/g)).toHaveLength(1);
    expect(src.match(/PGRST\d+/g)).toEqual(["PGRST202"]);
  });
});
