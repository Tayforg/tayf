import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 135 ("cluster-title-key-idx").
//
// Hunt 12 (2026-11-01), finding h12-cluster-1: the cluster consumer only holds
// the newest CONTEXT_CLUSTER_CAP = 200 clusters (plus a sticky tail of >= 5
// article ones) in memory. A story that reappears with the IDENTICAL headline
// after the window has moved on (Yusra Geyik: posta 53d92ca1 at 06:00, cnn-turk
// 217069e3 at 09:42, 269 clusters updated in between) therefore never meets its
// own singleton and opens a twin. The cap stays 200 (the 546 CPU limit); instead
// the consumer asks the database, once per article, for the live clusters
// updated in the last 24 h whose folded seed title is the article's folded
// title. 135 adds
//   * clusters_title_key_live_idx  btree (md5(tayf_search_fold(title_tr)),
//                                   updated_at desc) where not is_archived and
//                                   merged_into is null
//   * public.cluster_title_probe(p_title, p_since, p_limit)  the probe, a
//                                   SECURITY DEFINER sql function, service_role
//                                   only
//
// The index is built by the operator with CREATE INDEX CONCURRENTLY BEFORE the
// migration is applied (the 101/127 ORCHESTRATOR PRE-BUILD pattern); the
// migration's own `create index if not exists` is then a no-op. The header lists
// the statement and this file pins that it is identical to the in-file one.
//
// The last block (opt-in, TAYF_PSQL) applies 135 twice to a throwaway Postgres
// and proves the probe's plan and behaviour. TAYF_PSQL is the psql binary and
// PGHOST/PGPORT/PGUSER/PGDATABASE select the server; the target needs the stub
// schema (public.clusters with merged_into) and migration 129's tayf_search_fold.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "supabase", "migrations");
const MIGRATION_FILE = "135_cluster_title_key_idx.sql";
const MIGRATION = resolve(MIGRATIONS_DIR, MIGRATION_FILE);

const INDEX_NAME = "clusters_title_key_live_idx";
const FN_SIG = "public.cluster_title_probe(text, timestamptz, integer)";

const INDEX_STMT =
  "create index if not exists clusters_title_key_live_idx on public.clusters (pg_catalog.md5(public.tayf_search_fold(title_tr)), updated_at desc) where not is_archived and merged_into is null;";

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Blank out every single-quoted string literal (so prose in messages never satisfies a code guard). */
function sansStrings(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

let sql = "";
let code = "";
let codeNoStr = "";
let head = "";
let headText = "";

beforeAll(() => {
  sql = readFileSync(MIGRATION, "utf8");
  code = stripSqlComments(sql);
  codeNoStr = sansStrings(code);
  head = sql.slice(0, sql.search(/^\s*begin\s*;/im));
  headText = head
    .split("\n")
    .map((l) => l.replace(/^\s*--\s?/, ""))
    .join("\n");
});

/** `create index if not exists X on ...;` statements in executable SQL. */
function indexStatements(c: string): { name: string; stmt: string }[] {
  return [...c.matchAll(/create\s+index\s+if\s+not\s+exists\s+(\w+)\s+on\s+[^;]+;/gi)].map((m) => ({
    name: m[1] as string,
    stmt: collapse(m[0]),
  }));
}

/** `create index concurrently if not exists X on ...;` statements in the header's prose. */
function prebuildStatements(text: string): { name: string; stmt: string }[] {
  return [...text.matchAll(/create\s+index\s+concurrently\s+if\s+not\s+exists\s+(\w+)\s+on\s+[^;]+;/gi)].map((m) => ({
    name: m[1] as string,
    stmt: collapse(m[0]),
  }));
}

/** The text between `$fn$` markers of the probe function. */
function fnBody(): string {
  const m = /create\s+or\s+replace\s+function\s+public\.cluster_title_probe[\s\S]*?\$fn\$([\s\S]*?)\$fn\$/i.exec(code);
  if (!m) throw new Error("cluster_title_probe body ($fn$ ... $fn$) not found");
  return m[1] as string;
}

/** The function statement up to (and including) the closing $fn$ marker. */
function fnStatement(): string {
  const m = /create\s+or\s+replace\s+function\s+public\.cluster_title_probe[\s\S]*?\$fn\$[\s\S]*?\$fn\$/i.exec(code);
  if (!m) throw new Error("cluster_title_probe statement not found");
  return m[0];
}

describe("135 ledger and structure", () => {
  it("is wrapped in begin/commit and sets lock_timeout 5s / statement_timeout 60s first", () => {
    expect([...code.matchAll(/\bbegin\s*;/gi)]).toHaveLength(1);
    expect([...code.matchAll(/\bcommit\s*;/gi)]).toHaveLength(1);
    expect(code.trimStart()).toMatch(
      /^begin\s*;\s*set\s+local\s+lock_timeout\s*=\s*'5s'\s*;\s*set\s+local\s+statement_timeout\s*=\s*'60s'\s*;/i,
    );
  });

  it("records itself as version '135' under the name of its own file", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(version,\s*name\)\s*values\s*\(\s*'135'\s*,\s*'135_cluster_title_key_idx'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
    expect(MIGRATION_FILE).toBe("135_cluster_title_key_idx.sql");
  });

  it("the ledger insert is the last statement before commit", () => {
    expect(code.trimEnd()).toMatch(
      /values\s*\(\s*'135'\s*,\s*'135_cluster_title_key_idx'\s*\)\s*on\s+conflict\s+do\s+nothing\s*;\s*commit\s*;$/i,
    );
  });

  it("sanity: comment stripping and string blanking are non-vacuous", () => {
    expect(sql.length).toBeGreaterThan(code.length);
    expect(code.length).toBeGreaterThan(codeNoStr.length);
  });

  it("never mentions the zone word (zone-parity would count this file as another zone-map copy)", () => {
    expect(sql.toLowerCase()).not.toContain("iktidar");
  });

  it("migrations 001-134 are all still there and 135 is the next number (this wave adds no other file at 135)", () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
    expect(files.filter((f) => f.startsWith("135_"))).toEqual([MIGRATION_FILE]);
    expect(files).toContain("129_search_fold_rank.sql");
    expect(files).toContain("127_headline_pick_index.sql");
  });
});

describe("135 executable SQL is additive", () => {
  it("has no concurrently, drop, truncate, vacuum, analyze, alter or table DDL in executable SQL", () => {
    expect(codeNoStr).not.toMatch(/\bconcurrently\b/i);
    expect(codeNoStr).not.toMatch(/\bdrop\b/i);
    expect(codeNoStr).not.toMatch(/\btruncate\b/i);
    expect(codeNoStr).not.toMatch(/\bvacuum\b/i);
    expect(codeNoStr).not.toMatch(/\banalyze\b/i);
    expect(codeNoStr).not.toMatch(/\balter\b/i);
    expect(codeNoStr).not.toMatch(/\bcreate\s+(or\s+replace\s+)?(unlogged\s+|temp\s+|temporary\s+)?(table|view|trigger|policy|extension)\b/i);
  });

  it("writes no public table; the only insert is the ledger row", () => {
    expect(codeNoStr).not.toMatch(/\b(insert\s+into|update|delete\s+from)\s+public\./i);
    const inserts = [...codeNoStr.matchAll(/\binsert\s+into\s+([\w.]+)/gi)].map((m) => m[1]);
    expect(inserts).toEqual(["supabase_migrations.schema_migrations"]);
    expect([...codeNoStr.matchAll(/\bupdate\b|\bdelete\b/gi)]).toHaveLength(0);
  });

  it("creates exactly one index and exactly one function", () => {
    expect(indexStatements(code).map((s) => s.name)).toEqual([INDEX_NAME]);
    const fns = [...code.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([\w.]+)\s*\(/gi)].map((m) => m[1]);
    expect(fns).toEqual(["public.cluster_title_probe"]);
  });

  it("the statement_timeout (60s) is what turns a skipped pre-build into an abort, and is documented", () => {
    expect(head).toMatch(/57014/);
    expect(head).toMatch(/statement_timeout/);
    expect(head).toMatch(/lock_timeout/);
  });
});

describe("135 invalid-index guard", () => {
  const guardBlock = () => {
    const guard = /do\s+\$guard\$([\s\S]*?)\$guard\$\s*;/i.exec(code);
    expect(guard, "guard block (do $guard$ ... $guard$;) not found").not.toBeNull();
    return (guard as RegExpExecArray)[1] as string;
  };

  it("raises when the index exists with indisvalid = false, telling the operator to drop concurrently and rebuild", () => {
    expect(code).toMatch(/pg_catalog\.pg_index/i);
    expect(codeNoStr).toMatch(/\bindisvalid\s*=\s*false\b|\bnot\s+\w+\.indisvalid\b/i);
    expect(code).toMatch(/raise\s+exception\s+'135:[^']*drop index concurrently[^']*rebuild[^']*'/i);
  });

  it("names the index the migration creates and checks the public schema's catalog, schema-qualified", () => {
    const raw = guardBlock();
    expect(raw).toContain(`'${INDEX_NAME}'`);
    expect(raw).toMatch(/pg_catalog\.pg_class/i);
    expect(raw).toMatch(/relnamespace\s*=\s*'public'::regnamespace/i);
    expect(sansStrings(raw)).not.toMatch(/(?<![.\w])(string_agg|count|format)\s*\(/i);
  });

  it("runs before the CREATE INDEX", () => {
    const guardAt = code.search(/do\s+\$guard\$/i);
    expect(guardAt).toBeGreaterThan(0);
    expect(guardAt).toBeLessThan(code.search(/create\s+index\s+if\s+not\s+exists/i));
  });
});

describe("135 index definition", () => {
  it("pins the exact statement", () => {
    expect(indexStatements(code)).toEqual([{ name: INDEX_NAME, stmt: INDEX_STMT }]);
  });

  it("is a btree on (md5(fold(title_tr)), updated_at desc), partial on the live predicate, schema-qualified", () => {
    const stmt = indexStatements(code)[0]!.stmt;
    expect(stmt).toMatch(/^create index if not exists \w+ on public\.clusters \(pg_catalog\.md5\(public\.tayf_search_fold\(title_tr\)\), updated_at desc\) where not is_archived and merged_into is null;$/);
    expect(stmt).not.toMatch(/\b(unique|include|using)\b/i);
  });

  it("the index predicate and key are exactly what the probe filters on (so the partial index is provable)", () => {
    const body = collapse(fnBody());
    expect(body).toContain("pg_catalog.md5(public.tayf_search_fold(c.title_tr)) = pg_catalog.md5(public.tayf_search_fold(p_title))");
    expect(body).toContain("not c.is_archived and c.merged_into is null");
    expect(body).toMatch(/order by c\.updated_at desc/);
    expect(body).toMatch(/c\.updated_at >= /);
  });

  it("does not duplicate an index from an earlier migration, and the fold it relies on is immutable (129)", () => {
    const earlier = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql") && f < MIGRATION_FILE)
      .sort();
    expect(earlier.length).toBeGreaterThan(100);
    for (const file of earlier) {
      const c = collapse(stripSqlComments(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8")));
      expect(c, `${file} must not already define ${INDEX_NAME}`).not.toContain(INDEX_NAME);
      for (const m of c.matchAll(/create (?:unique )?index (?:concurrently )?(?:if not exists )?(\w+) on (?:public\.)?clusters\b[^;]*;/gi)) {
        expect(m[0], `${m[1]} must not already be keyed on md5(tayf_search_fold(title_tr))`).not.toMatch(
          /md5\s*\(\s*(?:public\.)?tayf_search_fold\s*\(\s*title_tr\s*\)\s*\)/i,
        );
      }
    }
    const m129 = collapse(stripSqlComments(readFileSync(resolve(MIGRATIONS_DIR, "129_search_fold_rank.sql"), "utf8")));
    expect(m129).toMatch(/create or replace function public\.tayf_search_fold\(p_text text\) returns text language sql immutable/);
    expect(m129).toContain("grant execute on function public.tayf_search_fold(text) to service_role;");
  });
});

describe("135 header: ORCHESTRATOR PRE-BUILD", () => {
  it("has the heading, the indisvalid check and the 57014 note", () => {
    expect(head).toContain("ORCHESTRATOR PRE-BUILD (run each standalone, outside a transaction, before applying 135)");
    expect(headText).toMatch(/indisvalid/);
    expect(headText).toMatch(/not\s+\w+\.indisvalid|indisvalid\s*=\s*false/i);
    expect(headText).toMatch(/57014/);
  });

  it("the in-file `create index if not exists X ...` has the identical `create index concurrently if not exists X ...` in the header", () => {
    const inFile = indexStatements(code);
    const prebuild = prebuildStatements(headText);
    expect(inFile).toHaveLength(1);
    expect(prebuild).toHaveLength(1);
    const { name, stmt } = inFile[0]!;
    const expected = stmt.replace("create index if not exists", "create index concurrently if not exists");
    expect(prebuild[0]!.name).toBe(name);
    expect(prebuild[0]!.stmt).toBe(expected);
  });

  it("the invalid-index check query names the index", () => {
    const m = /select c\.relname from pg_catalog\.pg_index i[^;]*;/i.exec(collapse(headText));
    expect(m, "invalid-index check select not found in the header").not.toBeNull();
    expect((m as RegExpExecArray)[0]).toContain(`'${INDEX_NAME}'`);
    expect((m as RegExpExecArray)[0]).toMatch(/not i\.indisvalid/i);
  });
});

describe("135 cluster_title_probe", () => {
  it("is SECURITY DEFINER, STABLE, LANGUAGE sql, with search_path pinned to the empty string", () => {
    const stmt = collapse(fnStatement());
    expect(stmt).toMatch(/\blanguage sql\b/i);
    expect(stmt).toMatch(/\bstable\b/i);
    expect(stmt).toMatch(/\bsecurity definer\b/i);
    expect(stmt).toMatch(/\bset search_path = ''/i);
    expect(stmt).not.toMatch(/\b(volatile|immutable)\b/i);
  });

  it("has the (p_title text, p_since timestamptz default null, p_limit integer default 3) signature and the six-column result the consumer reads", () => {
    // Spaces around parentheses and commas are layout, not content.
    const tight = collapse(fnStatement()).replace(/\s*([(),])\s*/g, "$1");
    expect(tight).toContain("cluster_title_probe(p_title text,p_since timestamptz default null,p_limit integer default 3)");
    expect(tight).toContain(
      "returns table(id uuid,title_tr text,title_tr_neutral text,first_published timestamptz,updated_at timestamptz,article_count integer)",
    );
  });

  it("selects the live rows whose folded title matches, newest first, 24 h by default, clamped to 1..5", () => {
    const body = collapse(fnBody());
    expect(body).toContain("from public.clusters c");
    expect(body).toContain("coalesce(p_since, pg_catalog.now() - interval '24 hours')");
    expect(body).toContain("limit least(greatest(coalesce(p_limit, 3), 1), 5)");
  });

  it("qualifies every function call in the body (search_path is empty); only coalesce / least / greatest are bare syntax", () => {
    const body = sansStrings(fnBody());
    const bare: string[] = [];
    for (const m of body.matchAll(/(?<![.\w])([a-z_][a-z0-9_]*)\s*\(/gi)) {
      const name = (m[1] as string).toLowerCase();
      if (!["coalesce", "least", "greatest"].includes(name)) bare.push(name);
    }
    expect(bare).toEqual([]);
    // Table references are schema-qualified too.
    for (const m of body.matchAll(/\b(from|join)\s+([\w.]+)/gi)) {
      expect(m[2], `${m[0]} must be schema-qualified`).toMatch(/^public\./);
    }
  });

  it("revokes everything from public, anon and authenticated, and executes for service_role only", () => {
    expect(collapse(code)).toContain(`revoke all on function ${FN_SIG} from public, anon, authenticated;`);
    const grants = [...collapse(code).matchAll(/\bgrant\b[^;]*;/gi)].map((m) => m[0]);
    expect(grants).toEqual([`grant execute on function ${FN_SIG} to service_role;`]);
  });

  it("revokes before it grants, and both come after the function is created", () => {
    const c = collapse(code);
    const created = c.indexOf("create or replace function public.cluster_title_probe");
    const revoked = c.indexOf("revoke all on function");
    const granted = c.indexOf("grant execute on function");
    expect(created).toBeGreaterThan(0);
    expect(revoked).toBeGreaterThan(created);
    expect(granted).toBeGreaterThan(revoked);
  });

  it("has a comment on the function and grants nothing on any table, schema or sequence", () => {
    expect(collapse(code)).toMatch(/comment on function public\.cluster_title_probe\(text, timestamptz, integer\) is /i);
    expect(codeNoStr).not.toMatch(/\bgrant\b[^;]*\bon\s+(all\s+)?(tables?|sequences?|schema)\b/i);
    expect(codeNoStr).not.toMatch(/\bgrant\b[^;]*\b(insert|update|delete|truncate|maintain|select)\b/i);
    expect(codeNoStr).not.toMatch(/\bto\s+(anon|authenticated|public)\b/i);
    expect(codeNoStr).not.toMatch(/alter\s+default\s+privileges/i);
  });
});

describe("135 header: documentation sections", () => {
  it("has the WHY section with the Yusra pair and the 269 clusters between them", () => {
    expect(headText).toMatch(/\bWHY\b/);
    expect(headText).toMatch(/53d92ca1/);
    expect(headText).toMatch(/217069e3/);
    expect(headText).toMatch(/269/);
    expect(headText).toMatch(/546/);
    expect(headText).toMatch(/CONTEXT_CLUSTER_CAP/);
  });

  it("has STEP 0 with the production reads (fold volatility and ACL, column types, row estimate, write source)", () => {
    expect(headText).toMatch(/STEP 0/);
    expect(headText).toMatch(/provolatile/);
    expect(headText).toMatch(/proacl/);
    expect(headText).toMatch(/service_role/);
    expect(headText).toMatch(/information_schema\.columns/);
    expect(headText).toMatch(/reltuples/);
    expect(headText).toMatch(/title_tr/);
    expect(headText).toMatch(/schema_migrations/);
  });

  it("has the WRITE COST note (fold + md5 on each non-HOT live update, EXECUTE for service_role)", () => {
    expect(headText).toMatch(/WRITE COST/);
    expect(headText).toMatch(/\bHOT\b/);
    expect(headText).toMatch(/md5/);
    expect(headText).toMatch(/EXECUTE/);
  });

  it("has the DRY RUNS section: two applies on a local PG15, the second a no-op", () => {
    expect(headText).toMatch(/DRY RUNS/);
    expect(headText).toMatch(/already exists, skipping/);
    expect(headText).toMatch(/INSERT 0 0/);
    expect(headText).toMatch(/PostgreSQL 15/);
  });

  it("has the EXPLAIN section with the index scan, for literals and for a forced generic plan", () => {
    expect(headText).toMatch(/EXPLAIN/);
    expect(headText).toMatch(/Index Scan using clusters_title_key_live_idx/);
    expect(headText).toMatch(/force_generic_plan/);
  });

  it("has a read-only VERIFY section", () => {
    expect(headText).toMatch(/VERIFY/);
    expect(headText).toMatch(/cluster_title_probe/);
  });

  it("has ROLLBACK lines for the function, the index and ledger row 135", () => {
    expect(headText).toMatch(/ROLLBACK/);
    expect(headText).toMatch(/drop function if exists public\.cluster_title_probe\(text, timestamptz, integer\)/i);
    expect(headText).toMatch(/drop index concurrently if exists clusters_title_key_live_idx/i);
    expect(headText).toMatch(/delete from supabase_migrations\.schema_migrations where version = '135'/i);
  });

  it("states the migration is additive and safe to re-apply", () => {
    expect(headText).toMatch(/additive/i);
    expect(headText).toMatch(/re-?apply/i);
  });
});

// ---------------------------------------------------------------------------
// Live behaviour (opt-in): 135 applied twice to a throwaway Postgres, then the
// probe against fixtures inside a rolled-back transaction.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))("135 against a live Postgres", () => {
  function runPsql(input: string): string {
    return execFileSync(process.env.TAYF_PSQL as string, ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      input,
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8" },
      maxBuffer: 8 * 1024 * 1024,
    });
  }

  it("applies twice: the second apply creates nothing and leaves one ledger row and one index", () => {
    runPsql(readFileSync(MIGRATION, "utf8"));
    runPsql(readFileSync(MIGRATION, "utf8"));
    expect(runPsql("select count(*) from supabase_migrations.schema_migrations where version = '135';").trim()).toBe("1");
    expect(
      runPsql(`select count(*) from pg_catalog.pg_indexes where schemaname = 'public' and indexname = '${INDEX_NAME}';`).trim(),
    ).toBe("1");
    expect(
      runPsql(`select i.indisvalid from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid = i.indexrelid where c.relname = '${INDEX_NAME}';`).trim(),
    ).toBe("t");
  });

  it("the probe's query shape is served by the index (seqscan disabled so a small fixture table cannot hide a mismatch)", () => {
    const out = runPsql(`
begin;
set local enable_seqscan = off;
set local enable_bitmapscan = off;
explain (costs off)
select c.id from public.clusters c
 where pg_catalog.md5(public.tayf_search_fold(c.title_tr)) = pg_catalog.md5(public.tayf_search_fold('Yüsra Geyik takside beklerken'))
   and c.updated_at >= pg_catalog.now() - interval '24 hours'
   and not c.is_archived and c.merged_into is null
 order by c.updated_at desc limit 3;
rollback;
`);
    expect(out).toMatch(new RegExp(`Index (Only )?Scan using ${INDEX_NAME}`));
  });

  it("returns folded-title matches only: live, recent, newest first, limit clamped", () => {
    const out = runPsql(`
begin;
insert into public.clusters (id, title_tr, article_count, first_published, updated_at, is_archived, merged_into)
values
  ('00000000-0000-0000-0000-0000000000a1', 'Yüsra Geyik takside beklerken', 1, now() - interval '3 hours', now() - interval '3 hours', false, null),
  ('00000000-0000-0000-0000-0000000000a2', 'YÜSRA GEYİK TAKSİDE BEKLERKEN', 1, now() - interval '1 hours', now() - interval '1 hours', false, null),
  ('00000000-0000-0000-0000-0000000000a3', 'Yüsra Geyik takside beklerken', 1, now() - interval '2 hours', now() - interval '2 hours', true, null),
  ('00000000-0000-0000-0000-0000000000a4', 'Yüsra Geyik takside beklerken', 1, now() - interval '2 hours', now() - interval '2 hours', false, '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000a5', 'Yüsra Geyik takside beklerken', 1, now() - interval '30 hours', now() - interval '30 hours', false, null),
  ('00000000-0000-0000-0000-0000000000a6', 'Başka bir haber', 1, now() - interval '1 hours', now() - interval '1 hours', false, null);
select 'ids', coalesce(string_agg(id::text, ',' order by updated_at desc), '') from public.cluster_title_probe('yusra geyik takside beklerken');
select 'one', count(*) from public.cluster_title_probe('Yüsra Geyik takside beklerken', null, 1);
select 'wide', count(*) from public.cluster_title_probe('Yüsra Geyik takside beklerken', now() - interval '48 hours', 3);
select 'none', count(*) from public.cluster_title_probe('Hiç olmayan başlık');
rollback;
`);
    const lines = out.split("\n").filter((l) => l.length > 0);
    expect(lines).toContain("ids|00000000-0000-0000-0000-0000000000a2,00000000-0000-0000-0000-0000000000a1");
    expect(lines).toContain("one|1");
    expect(lines).toContain("wide|3");
    expect(lines).toContain("none|0");
  });

  it("anon and authenticated cannot execute the probe; service_role can", () => {
    const out = runPsql(`
select 'anon', pg_catalog.has_function_privilege('anon', '${FN_SIG}', 'execute');
select 'auth', pg_catalog.has_function_privilege('authenticated', '${FN_SIG}', 'execute');
select 'srv', pg_catalog.has_function_privilege('service_role', '${FN_SIG}', 'execute');
`);
    expect(out).toContain("anon|f");
    expect(out).toContain("auth|f");
    expect(out).toContain("srv|t");
  });
});
