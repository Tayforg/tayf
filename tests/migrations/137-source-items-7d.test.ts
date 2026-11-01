import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 137 ("source-items-7d").
//
// Hunt 12 (2026-11-01, h12-ops-2): /kaynaklar/durum's "7 günlük gün başına
// haber" column read `sources.select('slug, stats:articles(count)')` with a 7-day
// gte on stats.published_at, a per-source LATERAL json_agg that hit PostgREST's
// 8 s statement_timeout about 12 times a day (pg_stat_statements: mean 2.5 s,
// max 7.9 s). 137 adds public.source_items_7d(), ONE set-based query (a LATERAL
// count(*) per active source: an Index Only Scan on idx_articles_source_published
// each), and src/lib/sources/feed-status.ts calls it, falling back to the old
// embed on PGRST202 while the migration is not applied.
//
// This file pins:
//   * additive, one transaction, create or replace only, no table / index / alter;
//   * language sql, STABLE, SECURITY DEFINER, search_path = '', every relation and
//     function schema-qualified (an empty search_path resolves nothing else);
//   * active sources only, a 7-day window on published_at, ordered by slug;
//   * revoke from public/anon/authenticated, execute for service_role only, no
//     table grant of any kind, the 095 ledger row as the last statement;
//   * the header records the production EXPLAIN and the local EXPLAIN ANALYZE of
//     both candidate shapes (and that the one shipped is the faster);
//   * the app's rpc name is the migration's function name.
//
// Static block: the SQL contract with comments stripped first (prose can never
// satisfy a guard). Live block (opt-in, TAYF_PSQL): applies the file twice to a
// throwaway Postgres that has stub.sql-like sources / articles tables, then runs
// rolled-back fixtures.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "supabase", "migrations");
const MIGRATION_FILE = "137_source_items_7d.sql";
const MIGRATION = resolve(MIGRATIONS_DIR, MIGRATION_FILE);
const FEED_STATUS = resolve(__dirname, "..", "..", "src", "lib", "sources", "feed-status.ts");

const SIG = "public.source_items_7d()";

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Blank out every single-quoted string literal (so prose in messages never satisfies a code guard). */
function sansStrings(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** The text between the $fn$ markers of the one function in the file. */
function functionBody(code: string): string {
  const m = code.match(/\$fn\$([\s\S]*?)\$fn\$/);
  if (!m || m[1] === undefined) throw new Error("no $fn$ body found");
  return m[1];
}

let raw = "";
let code = "";
let flat = "";
let body = "";
let head = "";
let headText = "";

beforeAll(() => {
  expect(existsSync(MIGRATION), `${MIGRATION_FILE} must exist`).toBe(true);
  raw = readFileSync(MIGRATION, "utf8");
  code = stripSqlComments(raw);
  flat = collapse(code);
  body = collapse(functionBody(code));
  head = raw.slice(0, raw.search(/^\s*begin\s*;/im));
  headText = head
    .split("\n")
    .map((l) => l.replace(/^\s*--\s?/, ""))
    .join("\n");
});

describe("migration 137_source_items_7d.sql (SQL contract)", () => {
  it("sanity: comment stripping is non-vacuous (header says STEP 0, code does not)", () => {
    expect(raw).toMatch(/STEP 0/);
    expect(code).not.toMatch(/STEP 0/);
    expect(code.length).toBeGreaterThan(200);
  });

  it("is the only migration numbered 137", () => {
    const same = readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("137_"));
    expect(same).toEqual([MIGRATION_FILE]);
  });

  it("is one transaction: begin first, commit last", () => {
    expect(flat.startsWith("begin;")).toBe(true);
    expect(flat.endsWith("commit;")).toBe(true);
    expect(flat.match(/\bbegin\s*;/gi)).toHaveLength(1);
    expect(flat.match(/\bcommit\s*;/gi)).toHaveLength(1);
  });

  it("is additive: one create or replace function, nothing dropped, altered, created or written", () => {
    const stripped = sansStrings(code);
    expect(stripped.match(/\bcreate\s+or\s+replace\s+function\b/gi)).toHaveLength(1);
    expect(stripped).not.toMatch(/\bdrop\s+/i);
    expect(stripped).not.toMatch(/\balter\s+/i);
    expect(stripped).not.toMatch(/\bcreate\s+(?:unique\s+)?(?:table|index|extension|schema|view|materialized|trigger|type)\b/i);
    expect(stripped).not.toMatch(/\b(?:truncate|delete\s+from|update\s+public|insert\s+into\s+public)\b/i);
    expect(stripped).not.toMatch(/\bcreate\s+function\b/i); // create or replace only
  });

  it("declares public.source_items_7d() returning table (slug text, items integer)", () => {
    expect(flat).toMatch(
      /create or replace function public\.source_items_7d\(\) returns table \(slug text, items integer\)/,
    );
  });

  it("is language sql, STABLE, SECURITY DEFINER with search_path = ''", () => {
    const decl = flat.slice(0, flat.indexOf("$fn$"));
    expect(decl).toMatch(/\blanguage sql\b/);
    expect(decl).toMatch(/\bstable\b/);
    expect(decl).not.toMatch(/\b(?:volatile|immutable)\b/);
    expect(decl).toMatch(/\bsecurity definer\b/);
    expect(decl).toMatch(/\bset search_path = ''/);
    expect(decl).not.toMatch(/\bsecurity invoker\b/);
  });

  it("qualifies every relation and function (the empty search_path resolves nothing)", () => {
    const rels = [...body.matchAll(/\b(?:from|join)\s+(?!lateral\b)([a-z_][a-z0-9_.]*)/gi)].map((m) => m[1] as string);
    expect(rels.length).toBeGreaterThanOrEqual(2);
    for (const rel of rels) expect(rel, `unqualified relation ${rel}`).toMatch(/^public\.[a-z_]+$/);
    expect(rels.sort()).toEqual(["public.articles", "public.sources"]);
    // every function call is pg_catalog-qualified
    expect(body).toMatch(/pg_catalog\.count\(\*\)/);
    expect(body).toMatch(/pg_catalog\.now\(\)/);
    expect(body.replace(/pg_catalog\.(?:count|now)/g, "")).not.toMatch(/\b(?:count|now)\s*\(/i);
  });

  it("counts only ACTIVE sources, over a 7-day window on articles.published_at, ordered by slug", () => {
    expect(body).toMatch(/\bwhere s\.active\b/);
    expect(body).toMatch(/a\.source_id = s\.id/);
    expect(body).toMatch(/a\.published_at >= pg_catalog\.now\(\) - interval '7 days'/);
    expect(body).toMatch(/\border by s\.slug\s*$/);
    // a LATERAL count per source: a source with no recent article still yields a row (0)
    expect(body).toMatch(/cross join lateral \( select pg_catalog\.count\(\*\)::integer as n from public\.articles a /);
    expect(body).not.toMatch(/\bgroup by\b/);
  });

  it("is a SELECT only: no write inside the body", () => {
    expect(body.startsWith("select ")).toBe(true);
    expect(body).not.toMatch(/\b(?:insert|update|delete|truncate|create|drop|alter|grant|revoke|perform|execute)\b/i);
  });

  it("revokes from public, anon and authenticated and grants execute to service_role only", () => {
    expect(flat).toContain(`revoke all on function ${SIG} from public, anon, authenticated;`);
    expect(flat).toContain(`grant execute on function ${SIG} to service_role;`);
    const grants = flat.match(/\bgrant\b[^;]*;/gi) ?? [];
    expect(grants).toEqual([`grant execute on function ${SIG} to service_role;`]);
    // the grantee list (after " to ") names no publicly reachable role
    for (const g of grants) expect(g.split(" to ").slice(1).join(" to ")).not.toMatch(/\b(?:anon|authenticated|public)\b/i);
    // the revoke comes before the grant
    expect(flat.indexOf("revoke all on function")).toBeLessThan(flat.indexOf("grant execute on function"));
  });

  it("grants nothing on any table, sequence or schema", () => {
    expect(sansStrings(code)).not.toMatch(/\bgrant\s+(?:select|insert|update|delete|truncate|maintain|references|trigger|usage|all)\b/i);
    expect(sansStrings(code)).not.toMatch(/\balter\s+default\s+privileges\b/i);
  });

  it("documents the function with a comment", () => {
    expect(flat).toMatch(/comment on function public\.source_items_7d\(\) is '/);
    // the comment text itself never mentions a grant to a public role (anon-surface scans strings too)
    const comment = flat.match(/comment on function public\.source_items_7d\(\) is ([^;]*);/)?.[1] ?? "";
    expect(comment.length).toBeGreaterThan(80);
    expect(comment).not.toMatch(/\bgrant\b/i);
  });

  it("asks PostgREST to reload its schema cache and ends with the 095 ledger insert", () => {
    expect(flat).toContain("notify pgrst, 'reload schema';");
    const ledger =
      "insert into supabase_migrations.schema_migrations (version, name) values ('137', '137_source_items_7d') on conflict do nothing; commit;";
    expect(flat.endsWith(ledger)).toBe(true);
    expect(flat.match(/schema_migrations/g)).toHaveLength(1);
  });

  it("adds no index, so there is no ORCHESTRATOR PRE-BUILD block to keep in sync", () => {
    expect(headText).not.toMatch(/create index concurrently/i);
    expect(headText).toMatch(/No index build/i);
  });
});

describe("migration 137 header (the evidence)", () => {
  it("has the 127/120 sections: STEP 0, LOCAL PROOF, DRY RUNS, VERIFY, ROLLBACK", () => {
    for (const section of ["STEP 0", "LOCAL PROOF", "DRY RUNS", "VERIFY", "ROLLBACK", "ORDER OF DEPLOY"]) {
      expect(headText, section).toContain(section);
    }
  });

  it("records why: the 12 timeouts a day and the pg_stat_statements mean and max", () => {
    expect(headText).toMatch(/12 statement timeouts/);
    expect(headText).toMatch(/mean 2,5\d\d ms/);
    expect(headText).toMatch(/max 7,937 ms/);
    expect(headText).toContain("sources_stats_1");
  });

  it("records the production EXPLAIN (plain, no ANALYZE) with an Index Only Scan and no Seq Scan on articles", () => {
    expect(headText).toMatch(/plain EXPLAIN, never ANALYZE/);
    const m = headText.match(/1\. EXPLAIN of the inlined function body[\s\S]*?(?=\n\s*2\. )/);
    expect(m, "STEP 0 item 1").not.toBeNull();
    // the plan lines only, not the prose that follows them
    const plan = m![0].split("An Index Only Scan per source")[0] as string;
    expect(plan).toMatch(/Index Only Scan using idx_articles_source_published(?:_inc_id)? on articles/);
    expect(plan).toMatch(/Nested Loop\s+\(cost=/);
    expect(plan).toMatch(/Index Cond: \(\(source_id = s\.id\) AND \(published_at >= /);
    expect(plan).not.toMatch(/Seq Scan on articles/);
    expect(plan).not.toMatch(/Bitmap Heap Scan/);
  });

  it("records the local EXPLAIN ANALYZE of both shapes, and ships the faster (the LATERAL form)", () => {
    const times = [...headText.matchAll(/Execution Time ([\d.]+) ms, ([\d.]+) ms, ([\d.]+) ms/g)].map((m) =>
      [m[1], m[2], m[3]].map(Number).sort((a, b) => a - b),
    );
    expect(times, "one timing line per shape").toHaveLength(2);
    const [lateral, groupBy] = times as [number[], number[]];
    for (const t of [...lateral, ...groupBy]) expect(t).toBeGreaterThan(0);
    const median = (xs: number[]) => xs[1] as number;
    expect(median(lateral), "the shipped LATERAL form must be the faster").toBeLessThan(median(groupBy));
    expect(headText).toMatch(/GROUP BY form/);
    expect(headText).toMatch(/PostgreSQL 15\.12/);
    expect(body).toMatch(/cross join lateral/);
  });

  it("records both dry runs, the ledger outcome and the privilege check", () => {
    expect(headText).toMatch(/Apply #1[\s\S]*INSERT 0 1[\s\S]*COMMIT/);
    expect(headText).toMatch(/Apply #2[\s\S]*INSERT 0 0/);
    expect(headText).toMatch(/service_role true; anon, authenticated\s+false/);
  });
});

describe("migration 137 and the app agree", () => {
  it("feed-status.ts calls rpc('source_items_7d') and falls back on PGRST202 only", () => {
    const src = readFileSync(FEED_STATUS, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/gm, "$1");
    expect(src).toContain('.rpc("source_items_7d")');
    expect(src).toMatch(/error\?\.code === "PGRST202"/);
    expect(src).toContain("fetchSourceItemsPerDayLegacy");
    // the function name in the app is the one the migration creates
    expect(flat).toContain("function public.source_items_7d()");
  });
});

// ---------------------------------------------------------------------------
// Live behaviour (opt-in): TAYF_PSQL is the psql binary and PGHOST / PGPORT /
// PGUSER / PGDATABASE select a THROWAWAY server holding public.sources
// (slug, name, bias, active, kind, url, rss_url) and public.articles (source_id,
// title, category, published_at, url) plus supabase_migrations.schema_migrations
// (stub.sql has them). The file is applied twice, then every scenario is its own
// BEGIN ... ROLLBACK script.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))("137 source_items_7d against fixtures (live Postgres)", () => {
  function runPsql(input: string): string {
    return execFileSync(process.env.TAYF_PSQL as string, ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      input,
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8" },
      maxBuffer: 8 * 1024 * 1024,
    });
  }

  const applyFile = () => runPsql(readFileSync(MIGRATION, "utf8"));
  const defMd5 = () => runPsql(`select md5(pg_get_functiondef('${SIG}'::regprocedure));`).trim();

  it("applies twice: the second apply changes nothing and the ledger holds one row", () => {
    applyFile();
    const first = defMd5();
    applyFile();
    expect(defMd5()).toBe(first);
    expect(
      runPsql("select count(*) from supabase_migrations.schema_migrations where version = '137';").trim(),
    ).toBe("1");
  });

  /** A rolled-back script: fixture sources and articles, then a select over the fixture slugs. */
  function scenario(): string[] {
    const src = (slug: string, active: boolean) =>
      `insert into public.sources (slug, name, bias, active, kind, url, rss_url) values ('${slug}', '${slug}', 'center', ${active}, 'outlet', 'https://fx.test/${slug}', 'https://fx.test/${slug}/rss');`;
    const art = (slug: string, ago: string, n: number) =>
      `insert into public.articles (source_id, title, category, published_at, url) select id, 'fx ${slug} ${n}', 'politika', now() - interval '${ago}', 'https://fx.test/${slug}/${n}' from public.sources where slug = '${slug}';`;
    const out = runPsql(
      [
        "begin;",
        src("fx-i7-active", true),
        src("fx-i7-inactive", false),
        src("fx-i7-empty", true),
        src("fx-i7-edge", true),
        art("fx-i7-active", "1 hour", 1),
        art("fx-i7-active", "3 days", 2),
        art("fx-i7-active", "3 days", 3),
        art("fx-i7-inactive", "1 hour", 1),
        art("fx-i7-edge", "6 days", 1),
        art("fx-i7-edge", "8 days", 2),
        "select slug || '|' || items from public.source_items_7d() where slug like 'fx-i7-%' order by slug;",
        "rollback;",
      ].join("\n"),
    );
    return out.split("\n").filter(Boolean);
  }

  it("lists active sources only, counts the last 7 days only, and reports 0 for a quiet source", () => {
    expect(scenario()).toEqual(["fx-i7-active|3", "fx-i7-edge|1", "fx-i7-empty|0"]);
  });

  it("rolled back: the fixtures leave no trace", () => {
    scenario();
    expect(runPsql("select count(*) from public.sources where slug like 'fx-i7-%';").trim()).toBe("0");
  });

  it("anon and authenticated cannot execute it; service_role can; no table privilege was added", () => {
    const priv = (role: string) =>
      runPsql(
        `select case when exists (select 1 from pg_roles where rolname = '${role}') then pg_catalog.has_function_privilege('${role}', '${SIG}', 'execute')::text else 'norole' end;`,
      ).trim();
    expect(priv("anon")).not.toBe("true");
    expect(priv("authenticated")).not.toBe("true");
    expect(priv("service_role")).not.toBe("false");
    expect(
      runPsql(
        "select count(*) from information_schema.role_table_grants where grantee in ('anon', 'authenticated') and table_schema = 'public' and table_name in ('sources', 'articles');",
      ).trim(),
    ).toBe("0");
  });
});
