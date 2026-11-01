import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { HEADLINE_MIN_ARTICLE_COUNT } from "@/lib/headline/prompt";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 127 ("headline-pick-index").
//
// Hunt 8 (2026-11-01): the neutral-headline cron's candidate pick
// (src/app/api/cron/headline/route.ts) timed out at 8 s (mean 4,882 ms, max
// 8,000 ms) because no index matches it. It filters on `<col> is null`,
// `is_archived = false` and `article_count >= N` and orders by `updated_at desc`
// with a tiny LIMIT; the planner walks idx_clusters_active_updated_at (014) and
// discards ~30k active singletons and already-titled clusters before it finds
// the few pending ones. 127 adds one tiny partial index per mode:
//   clusters_headline_pick_extractive_idx  (extractive mode, no API key)
//   clusters_headline_pick_llm_idx         (llm mode)
// Both on public.clusters (updated_at desc), so the pick becomes a short walk
// from the newest end with no rows removed by a filter.
//
// A partial index only helps while the query's WHERE implies the index
// predicate. The route is therefore part of this contract: the constants and
// the exact chain of PostgREST calls are parsed out of route.ts below, so
// changing the pick (or either threshold) fails this file until the migration
// (a new one -- never edit 127 once applied) is brought back in line.
//
// The indexes are built by the operator with CREATE INDEX CONCURRENTLY BEFORE
// the migration is applied; the migration's own `create index if not exists`
// is then a no-op. The header lists those statements and this file pins that
// they are identical to the in-file ones.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "supabase", "migrations");
const MIGRATION_127_FILE = "127_headline_pick_index.sql";
const MIGRATION_127 = resolve(MIGRATIONS_DIR, MIGRATION_127_FILE);
const ROUTE = resolve(__dirname, "..", "..", "src", "app", "api", "cron", "headline", "route.ts");

const EXTRACTIVE_NAME = "clusters_headline_pick_extractive_idx";
const LLM_NAME = "clusters_headline_pick_llm_idx";

const EXTRACTIVE_STMT =
  "create index if not exists clusters_headline_pick_extractive_idx on public.clusters (updated_at desc) where title_tr_neutral is null and is_archived = false and article_count >= 2;";
const LLM_STMT =
  "create index if not exists clusters_headline_pick_llm_idx on public.clusters (updated_at desc) where title_neutral_at is null and is_archived = false and article_count >= 3;";

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Blank out every single-quoted string literal (so prose in messages never satisfies a code guard). */
function sansStrings(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

/** Whitespace-collapsed form that keeps the text (used on already comment-free strings). */
function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * TypeScript with its comments removed, so a comment that merely quotes `.eq("is_archived", false)` can never
 * satisfy a parity assertion. Only comments that start a line or follow whitespace are removed, so the `//` of
 * a URL inside a string (`https://...`) survives.
 */
function stripTsComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

/**
 * TypeScript source flattened so a prettier line-wrap cannot hide or fake a match: runs of whitespace
 * collapse to one space, none is left just inside parentheses, a trailing comma before `)` is dropped and a
 * method chain reads on one line (`supabase .from(...)` becomes `supabase.from(...)`).
 */
function flattenTs(src: string): string {
  return src
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/,\)/g, ")")
    .replace(/\s+\.(?=[A-Za-z_]+\()/g, ".")
    .trim();
}

let sql = "";
let code = "";
let codeNoStr = "";
let head = "";
let headText = "";
let route = "";
let routeFlat = "";

beforeAll(() => {
  sql = readFileSync(MIGRATION_127, "utf8");
  code = stripSqlComments(sql);
  codeNoStr = sansStrings(code);
  head = sql.slice(0, sql.search(/^\s*begin\s*;/im));
  headText = head
    .split("\n")
    .map((l) => l.replace(/^\s*--\s?/, ""))
    .join("\n");
  route = readFileSync(ROUTE, "utf8");
  routeFlat = flattenTs(stripTsComments(route));
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

/** The `<col> is null and is_archived = false and article_count >= <n>` predicate of one index statement. */
function predicate(stmt: string): { nullCol: string; minCount: number } {
  const m = /\bwhere\s+(\w+)\s+is\s+null\s+and\s+is_archived\s*=\s*false\s+and\s+article_count\s*>=\s*(\d+)\s*;$/i.exec(stmt);
  if (!m) throw new Error(`predicate not in the expected shape: ${stmt}`);
  return { nullCol: m[1] as string, minCount: Number(m[2]) };
}

function byName(): Record<string, string> {
  return Object.fromEntries(indexStatements(code).map((s) => [s.name, s.stmt]));
}

describe("127 ledger and structure", () => {
  it("is wrapped in begin/commit and sets lock_timeout 5s / statement_timeout 60s first", () => {
    expect([...code.matchAll(/\bbegin\s*;/gi)]).toHaveLength(1);
    expect([...code.matchAll(/\bcommit\s*;/gi)]).toHaveLength(1);
    expect(code.trimStart()).toMatch(
      /^begin\s*;\s*set\s+local\s+lock_timeout\s*=\s*'5s'\s*;\s*set\s+local\s+statement_timeout\s*=\s*'60s'\s*;/i,
    );
  });

  it("records itself as version '127' under the name of its own file", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(version,\s*name\)\s*values\s*\(\s*'127'\s*,\s*'127_headline_pick_index'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
    expect(MIGRATION_127_FILE).toBe("127_headline_pick_index.sql");
  });

  it("the ledger insert is the last statement before commit", () => {
    expect(code.trimEnd()).toMatch(
      /values\s*\(\s*'127'\s*,\s*'127_headline_pick_index'\s*\)\s*on\s+conflict\s+do\s+nothing\s*;\s*commit\s*;$/i,
    );
  });

  it("sanity: comment stripping and string blanking are non-vacuous", () => {
    expect(sql.length).toBeGreaterThan(code.length);
    expect(code.length).toBeGreaterThan(codeNoStr.length);
  });

  it("never mentions the zone word (zone-parity would count this file as another zone-map copy)", () => {
    expect(sql.toLowerCase()).not.toContain("iktidar");
  });
});

describe("127 executable SQL is additive and nothing else", () => {
  it("has no concurrently, drop, function, table, grant, revoke, analyze, statistics, vacuum, alter or truncate", () => {
    expect(codeNoStr).not.toMatch(/\bconcurrently\b/i);
    expect(codeNoStr).not.toMatch(/\bdrop\b/i);
    expect(codeNoStr).not.toMatch(/\bcreate\s+(or\s+replace\s+)?function\b/i);
    expect(codeNoStr).not.toMatch(/\bcreate\s+(or\s+replace\s+)?(unlogged\s+|temp\s+|temporary\s+)?(table|view|trigger|policy)\b/i);
    expect(codeNoStr).not.toMatch(/\bgrant\b/i);
    expect(codeNoStr).not.toMatch(/\brevoke\b/i);
    expect(codeNoStr).not.toMatch(/\banalyze\b/i);
    expect(codeNoStr).not.toMatch(/\bcreate\s+statistics\b/i);
    expect(codeNoStr).not.toMatch(/\bvacuum\b/i);
    expect(codeNoStr).not.toMatch(/\balter\b/i);
    expect(codeNoStr).not.toMatch(/\btruncate\b/i);
  });

  it("writes no public table; the only insert is the ledger row", () => {
    expect(codeNoStr).not.toMatch(/\b(insert\s+into|update|delete\s+from)\s+public\./i);
    const inserts = [...codeNoStr.matchAll(/\binsert\s+into\s+([\w.]+)/gi)].map((m) => m[1]);
    expect(inserts).toEqual(["supabase_migrations.schema_migrations"]);
    expect([...codeNoStr.matchAll(/\bupdate\b|\bdelete\b/gi)]).toHaveLength(0);
  });

  it("uses CONCURRENTLY nowhere in executable SQL (it cannot run inside begin/commit)", () => {
    expect(codeNoStr).not.toMatch(/\bconcurrently\b/i);
  });

  it("the statement_timeout (60s) is what turns a skipped pre-build into an abort, and is documented", () => {
    expect(head).toMatch(/57014/);
    expect(head).toMatch(/statement_timeout/);
    expect(head).toMatch(/lock_timeout/);
  });
});

describe("127 (0) invalid-index guard", () => {
  it("raises when a named index exists with indisvalid = false, telling the operator to drop concurrently and rebuild", () => {
    expect(code).toMatch(/pg_catalog\.pg_index/i);
    expect(codeNoStr).toMatch(/\bindisvalid\s*=\s*false\b|\bnot\s+\w+\.indisvalid\b/i);
    expect(code).toMatch(/raise\s+exception\s+'127:[^']*drop index concurrently[^']*rebuild[^']*'/i);
  });

  it("names both indexes the migration creates", () => {
    const guard = /do\s+\$guard\$([\s\S]*?)\$guard\$\s*;/i.exec(code);
    expect(guard, "guard block (do $guard$ ... $guard$;) not found").not.toBeNull();
    expect(indexStatements(code).map((s) => s.name)).toEqual([EXTRACTIVE_NAME, LLM_NAME]);
    for (const name of [EXTRACTIVE_NAME, LLM_NAME]) {
      expect((guard as RegExpExecArray)[1]).toContain(`'${name}'`);
    }
  });

  it("runs before the first CREATE INDEX", () => {
    const guardAt = code.search(/do\s+\$guard\$/i);
    expect(guardAt).toBeGreaterThan(0);
    expect(guardAt).toBeLessThan(code.search(/create\s+index\s+if\s+not\s+exists/i));
  });

  it("checks the public schema's catalog, schema-qualified (search_path is not relied on)", () => {
    const guard = /do\s+\$guard\$([\s\S]*?)\$guard\$\s*;/i.exec(code);
    const raw = (guard as RegExpExecArray)[1] as string;
    expect(raw).toMatch(/pg_catalog\.pg_class/i);
    expect(raw).toMatch(/relnamespace\s*=\s*'public'::regnamespace/i);
    expect(sansStrings(raw)).not.toMatch(/(?<![.\w])(string_agg|count|format)\s*\(/i);
  });
});

describe("127 index definitions", () => {
  it("creates exactly the extractive and the llm pick index, in that order", () => {
    expect(indexStatements(code).map((s) => s.name)).toEqual([EXTRACTIVE_NAME, LLM_NAME]);
  });

  it("pins the exact statements", () => {
    const stmts = byName();
    expect(stmts[EXTRACTIVE_NAME]).toBe(EXTRACTIVE_STMT);
    expect(stmts[LLM_NAME]).toBe(LLM_STMT);
  });

  it("predicates use `is_archived = false` (the form 037 and the route use), never `not is_archived`", () => {
    for (const { stmt } of indexStatements(code)) {
      expect(stmt).toMatch(/\bis_archived\s*=\s*false\b/);
      expect(stmt).not.toMatch(/\bnot\s+is_archived\b/i);
    }
  });

  it("is a btree on (updated_at desc) only: not unique, no include, no other key column", () => {
    for (const { stmt } of indexStatements(code)) {
      expect(stmt).toMatch(/^create index if not exists \w+ on public\.clusters \(updated_at desc\) where /);
      expect(stmt).not.toMatch(/\b(unique|include|using)\b/i);
    }
  });

  it("does not duplicate or shadow an index from an earlier migration", () => {
    const earlier = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql") && f !== MIGRATION_127_FILE)
      .sort();
    expect(earlier.length).toBeGreaterThan(100);
    const clustersIndexes: { file: string; name: string; stmt: string }[] = [];
    for (const file of earlier) {
      const c = collapse(stripSqlComments(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8")));
      for (const m of c.matchAll(
        /create (?:unique )?index (?:concurrently )?(?:if not exists )?(\w+) on (?:public\.)?clusters\b[^;]*;/gi,
      )) {
        clustersIndexes.push({ file, name: m[1] as string, stmt: m[0] });
      }
    }
    expect(clustersIndexes.length).toBeGreaterThan(5);
    for (const { name, stmt } of clustersIndexes) {
      expect([EXTRACTIVE_NAME, LLM_NAME]).not.toContain(name);
      // No earlier clusters index is built on the pending-title predicate at all ...
      expect(stmt, `${name} must not already cover title_tr_neutral`).not.toMatch(/title_tr_neutral/i);
      // ... and none is keyed on updated_at together with title_neutral_at.
      expect(stmt, `${name} must not already be (updated_at desc) where title_neutral_at is null`).not.toMatch(
        /\(updated_at desc\)[^;]*title_neutral_at/i,
      );
    }
  });

  it("the neighbours the header names still look the way the header describes them", () => {
    const read = (f: string) => collapse(stripSqlComments(readFileSync(resolve(MIGRATIONS_DIR, f), "utf8")));
    expect(read("014_query_perf.sql")).toMatch(
      /create index if not exists idx_clusters_active_updated_at on clusters \(updated_at desc\) where article_count >= 2;/,
    );
    expect(read("037_retention.sql")).toMatch(
      /create index if not exists clusters_active_updated_idx on public\.clusters \(updated_at desc\) where is_archived = false;/,
    );
    expect(read("083_reader_query_rpcs.sql")).toMatch(
      /create index if not exists clusters_neutral_eligible_idx on public\.clusters \(title_neutral_at\) where article_count >= 3;/,
    );
    expect(read("019_neutral_headlines.sql")).toMatch(
      /create index if not exists idx_clusters_needs_rewrite on clusters \(title_neutral_at\) where title_neutral_at is null and article_count >= 3;/,
    );
  });
});

describe("127 constant parity with the route and the prompt module", () => {
  it("the extractive predicate's article_count literal equals EXTRACTIVE_MIN_ARTICLE_COUNT in route.ts", () => {
    const m = /const EXTRACTIVE_MIN_ARTICLE_COUNT = (\d+);/.exec(route);
    expect(m, "EXTRACTIVE_MIN_ARTICLE_COUNT not found in route.ts").not.toBeNull();
    expect(predicate(byName()[EXTRACTIVE_NAME] as string).minCount).toBe(Number((m as RegExpExecArray)[1]));
  });

  it("the llm predicate's article_count literal equals HEADLINE_MIN_ARTICLE_COUNT, which route.ts aliases as MIN_ARTICLE_COUNT", () => {
    expect(routeFlat).toContain("const MIN_ARTICLE_COUNT = HEADLINE_MIN_ARTICLE_COUNT;");
    expect(predicate(byName()[LLM_NAME] as string).minCount).toBe(HEADLINE_MIN_ARTICLE_COUNT);
  });

  it("each index's null column is the one route.ts filters on in that mode", () => {
    const m = /\.is\(mode === "llm" \? "(\w+)" : "(\w+)", null\)/.exec(routeFlat);
    expect(m, "the .is(mode === ...) call not found in route.ts").not.toBeNull();
    const [, llmCol, extractiveCol] = m as RegExpExecArray;
    expect(predicate(byName()[LLM_NAME] as string).nullCol).toBe(llmCol);
    expect(predicate(byName()[EXTRACTIVE_NAME] as string).nullCol).toBe(extractiveCol);
    expect(llmCol).not.toBe(extractiveCol);
  });
});

describe("127 route-shape parity (fails if the pick changes and the index stops matching)", () => {
  const PICK = /const \{ data: clustersData, error: pickError \} = await supabase(\.from\("clusters"\).*?\.limit\([^;]*?\));/;

  it("the pick still filters on the mode's null column, is_archived = false and the mode's article_count floor", () => {
    expect(routeFlat).toContain('.is(mode === "llm" ? "title_neutral_at" : "title_tr_neutral", null)');
    expect(routeFlat).toContain('.eq("is_archived", false)');
    expect(routeFlat).toContain(
      '.gte("article_count", mode === "llm" ? MIN_ARTICLE_COUNT : EXTRACTIVE_MIN_ARTICLE_COUNT)',
    );
  });

  it("the pick still orders by updated_at descending (the index key)", () => {
    expect(routeFlat).toContain('.order("updated_at", { ascending: false })');
  });

  it("the pick chain carries exactly those predicates: no extra filter the index predicate would not cover", () => {
    const m = PICK.exec(routeFlat);
    expect(m, "the candidate-pick query chain was not found in route.ts").not.toBeNull();
    const chain = (m as RegExpExecArray)[1] as string;
    const calls = [...chain.matchAll(/\.([A-Za-z_]+)\(/g)].map((x) => x[1]);
    expect(calls).toEqual(["from", "select", "is", "eq", "gte", "order", "limit"]);
    expect(chain).toContain('.is(mode === "llm" ? "title_neutral_at" : "title_tr_neutral", null)');
    expect(chain).toContain('.eq("is_archived", false)');
    expect(chain).toContain('.order("updated_at", { ascending: false })');
  });

  it("sanity: comments are stripped, so a quoting comment cannot satisfy the parity assertions", () => {
    expect(routeFlat.length).toBeLessThan(flattenTs(route).length);
    // route.ts's own comment quotes `.eq("is_archived", false)`; it must not be counted as code.
    expect(route.split('.eq("is_archived", false)').length - 1).toBeGreaterThan(
      routeFlat.split('.eq("is_archived", false)').length - 1,
    );
    expect(stripTsComments('const u = "https://x.test/a"; // .eq("is_archived", false)')).toContain("https://x.test/a");
    expect(stripTsComments('a(); /* .eq("is_archived", false) */ b();')).not.toContain("is_archived");
  });

  it("sanity: the chain extractor is non-vacuous (a stray .neq would be seen)", () => {
    const real = (PICK.exec(routeFlat) as RegExpExecArray)[1] as string;
    const tampered = routeFlat.replace(real, real.replace('.eq("is_archived", false)', '.eq("is_archived", false).neq("id", "x")'));
    expect(tampered).not.toBe(routeFlat);
    const chain = (PICK.exec(tampered) as RegExpExecArray)[1] as string;
    expect([...chain.matchAll(/\.([A-Za-z_]+)\(/g)].map((x) => x[1])).toContain("neq");
  });
});

describe("127 header: ORCHESTRATOR PRE-BUILD", () => {
  it("has the heading, the indisvalid check and the 57014 note", () => {
    expect(head).toContain("ORCHESTRATOR PRE-BUILD (run each standalone, outside a transaction, before applying 127)");
    expect(headText).toMatch(/indisvalid/);
    expect(headText).toMatch(/not\s+\w+\.indisvalid|indisvalid\s*=\s*false/i);
    expect(headText).toMatch(/57014/);
  });

  it("each in-file `create index if not exists X ...` has the identical `create index concurrently if not exists X ...` in the header", () => {
    const inFile = indexStatements(code);
    const prebuild = prebuildStatements(headText);
    expect(inFile).toHaveLength(2);
    expect(prebuild.map((p) => p.name).sort()).toEqual(inFile.map((i) => i.name).sort());
    expect(prebuild).toHaveLength(inFile.length);
    for (const { name, stmt } of inFile) {
      const expected = stmt.replace("create index if not exists", "create index concurrently if not exists");
      const found = prebuild.find((p) => p.name === name);
      expect(found?.stmt, `pre-build statement for ${name}`).toBe(expected);
    }
  });

  it("the invalid-index check query names both indexes", () => {
    const m = /select c\.relname from pg_catalog\.pg_index i[^;]*;/i.exec(collapse(headText));
    expect(m, "invalid-index check select not found in the header").not.toBeNull();
    expect((m as RegExpExecArray)[0]).toContain(`'${EXTRACTIVE_NAME}'`);
    expect((m as RegExpExecArray)[0]).toContain(`'${LLM_NAME}'`);
    expect((m as RegExpExecArray)[0]).toMatch(/not i\.indisvalid/i);
  });
});

describe("127 header: documentation sections", () => {
  it("has the WHY section with the h8 pipeline numbers", () => {
    expect(headText).toMatch(/\bWHY\b/);
    expect(headText).toMatch(/4,882/);
    expect(headText).toMatch(/8,000/);
    expect(headText).toMatch(/36,812/);
    expect(headText).toMatch(/83 min/);
  });

  it("has STEP 0 with the before plan, the generic plan and the index inventory", () => {
    expect(headText).toMatch(/STEP 0/);
    expect(headText).toMatch(/EXPLAIN/);
    expect(headText).toMatch(/Index Scan using idx_clusters_active_updated_at/);
    expect(headText).toMatch(/Rows Removed by Filter/);
    expect(headText).toMatch(/generic_plan/);
    expect(headText).toMatch(/idx_clusters_updated_at/);
    expect(headText).toMatch(/clusters_neutral_eligible_idx/);
    expect(headText).toMatch(/idx_clusters_needs_rewrite/);
    expect(headText).toMatch(/schema_migrations/);
  });

  it("has LOCAL PROOF with the after plan on both indexes and the second-apply result", () => {
    expect(headText).toMatch(/LOCAL PROOF/);
    expect(headText).toMatch(/Index Scan using clusters_headline_pick_extractive_idx/);
    expect(headText).toMatch(/Index Scan using clusters_headline_pick_llm_idx/);
    expect(headText).toMatch(/already exists, skipping/);
    expect(headText).toMatch(/INSERT 0 0/);
  });

  it("has the HOT-update and the generic-plan notes", () => {
    expect(headText).toMatch(/\bHOT\b/);
    expect(headText).toMatch(/title_tr_neutral/);
    expect(headText).toMatch(/title_neutral_at/);
    expect(headText).toMatch(/custom plan/i);
    expect(headText).toMatch(/generic plan/i);
  });

  it("has a read-only VERIFY section that names the extractive index and the thresholds", () => {
    expect(headText).toMatch(/VERIFY/);
    expect(headText).toMatch(/explain[^\n]*\n?[\s\S]*?clusters_headline_pick_extractive_idx/i);
    expect(headText).toMatch(/100 ms/);
    expect(headText).toMatch(/10 min/);
  });

  it("has ROLLBACK lines for both indexes and for ledger row 127", () => {
    expect(headText).toMatch(/ROLLBACK/);
    expect(headText).toMatch(/drop index concurrently if exists clusters_headline_pick_extractive_idx/i);
    expect(headText).toMatch(/drop index concurrently if exists clusters_headline_pick_llm_idx/i);
    expect(headText).toMatch(/delete from supabase_migrations\.schema_migrations where version = '127'/i);
  });

  it("states the migration is additive and safe to re-apply", () => {
    expect(headText).toMatch(/additive/i);
    expect(headText).toMatch(/re-?apply/i);
  });
});
