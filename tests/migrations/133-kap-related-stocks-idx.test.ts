import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 133 ("kap-related-stocks-idx").
//
// Hunt 11 (2026-11-01, h11-finance-1): every per-ticker reader of
// kap_disclosures filtered `stock_codes @> {T}` (GIN index from 049), so the
// 6.9 % of notices KAP tags only in related_stocks (trading halts, SPK bans,
// insider trades) never reached /ekonomi/<ticker>. The readers now send ONE
// combined filter (src/lib/finance/disclosure-filter.ts):
//     and(or(stock_codes.cs.{T},related_stocks.cs.{T}),or(<not a breaker>))
// i.e. `stock_codes @> '{T}' OR related_stocks @> '{T}'`. Without an index on
// related_stocks the OR cannot become a BitmapOr and the planner falls back to
// a sequential scan of the 215 MB table on every /ekonomi/<ticker> render.
// 133 adds that one GIN index.
//
// The index is built by the operator with CREATE INDEX CONCURRENTLY BEFORE the
// migration is applied; the migration's own `create index if not exists` is
// then a no-op. The header lists that statement and this file pins that it is
// identical to the in-file one. Same shape as 127 (headline-pick-index).
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "supabase", "migrations");
const MIGRATION_FILE = "133_kap_related_stocks_idx.sql";
const FILTER_FILE = resolve(__dirname, "..", "..", "src", "lib", "finance", "disclosure-filter.ts");

const INDEX_NAME = "kap_disclosures_related_stocks_idx";
const INDEX_STMT =
  "create index if not exists kap_disclosures_related_stocks_idx on public.kap_disclosures using gin (related_stocks);";

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
  sql = readFileSync(resolve(MIGRATIONS_DIR, MIGRATION_FILE), "utf8");
  code = stripSqlComments(sql);
  codeNoStr = sansStrings(code);
  head = sql.slice(0, sql.search(/^\s*begin\s*;/im));
  headText = head
    .split("\n")
    .map((l) => l.replace(/^\s*--\s?/, ""))
    .join("\n");
});

function indexStatements(c: string): { name: string; stmt: string }[] {
  return [...c.matchAll(/create\s+index\s+if\s+not\s+exists\s+(\w+)\s+on\s+[^;]+;/gi)].map((m) => ({
    name: m[1] as string,
    stmt: collapse(m[0]),
  }));
}

function prebuildStatements(text: string): { name: string; stmt: string }[] {
  return [...text.matchAll(/create\s+index\s+concurrently\s+if\s+not\s+exists\s+(\w+)\s+on\s+[^;]+;/gi)].map((m) => ({
    name: m[1] as string,
    stmt: collapse(m[0]),
  }));
}

describe("133 ledger and structure", () => {
  it("is wrapped in begin/commit and sets lock_timeout 5s / statement_timeout 60s first", () => {
    expect([...code.matchAll(/\bbegin\s*;/gi)]).toHaveLength(1);
    expect([...code.matchAll(/\bcommit\s*;/gi)]).toHaveLength(1);
    expect(code.trimStart()).toMatch(
      /^begin\s*;\s*set\s+local\s+lock_timeout\s*=\s*'5s'\s*;\s*set\s+local\s+statement_timeout\s*=\s*'60s'\s*;/i,
    );
  });

  it("records itself as version '133' under the name of its own file", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(version,\s*name\)\s*values\s*\(\s*'133'\s*,\s*'133_kap_related_stocks_idx'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
    expect(MIGRATION_FILE).toBe("133_kap_related_stocks_idx.sql");
  });

  it("the ledger insert is the last statement before commit", () => {
    expect(code.trimEnd()).toMatch(
      /values\s*\(\s*'133'\s*,\s*'133_kap_related_stocks_idx'\s*\)\s*on\s+conflict\s+do\s+nothing\s*;\s*commit\s*;$/i,
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

describe("133 executable SQL is additive and nothing else", () => {
  it("grants, revokes, drops, alters, analyzes, vacuums and truncates nothing, and creates no table/function/view/policy", () => {
    expect(codeNoStr).not.toMatch(/\bgrant\b/i);
    expect(codeNoStr).not.toMatch(/\brevoke\b/i);
    expect(codeNoStr).not.toMatch(/\bdrop\b/i);
    expect(codeNoStr).not.toMatch(/\balter\b/i);
    expect(codeNoStr).not.toMatch(/\banalyze\b/i);
    expect(codeNoStr).not.toMatch(/\bvacuum\b/i);
    expect(codeNoStr).not.toMatch(/\btruncate\b/i);
    expect(codeNoStr).not.toMatch(/\bcreate\s+(or\s+replace\s+)?function\b/i);
    expect(codeNoStr).not.toMatch(/\bcreate\s+(or\s+replace\s+)?(unlogged\s+|temp\s+|temporary\s+)?(table|view|trigger|policy)\b/i);
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

describe("133 (0) invalid-index guard", () => {
  it("raises when the index exists with indisvalid = false, telling the operator to drop concurrently and rebuild", () => {
    expect(code).toMatch(/pg_catalog\.pg_index/i);
    expect(codeNoStr).toMatch(/\bindisvalid\s*=\s*false\b|\bnot\s+\w+\.indisvalid\b/i);
    expect(code).toMatch(/raise\s+exception\s+'133: invalid index[^']*drop index concurrently[^']*rebuild[^']*'/i);
  });

  it("names the index the migration creates", () => {
    const guard = /do\s+\$guard\$([\s\S]*?)\$guard\$\s*;/i.exec(code);
    expect(guard, "guard block (do $guard$ ... $guard$;) not found").not.toBeNull();
    expect((guard as RegExpExecArray)[1]).toContain(`'${INDEX_NAME}'`);
  });

  it("runs before the CREATE INDEX", () => {
    const guardAt = code.search(/do\s+\$guard\$/i);
    expect(guardAt).toBeGreaterThan(0);
    expect(guardAt).toBeLessThan(code.search(/create\s+index\s+if\s+not\s+exists/i));
  });

  it("checks the public schema's catalog, schema-qualified (search_path is not relied on)", () => {
    const guard = /do\s+\$guard\$([\s\S]*?)\$guard\$\s*;/i.exec(code);
    const raw = (guard as RegExpExecArray)[1] as string;
    expect(raw).toMatch(/pg_catalog\.pg_class/i);
    expect(raw).toMatch(/relnamespace\s*=\s*'public'::regnamespace/i);
  });
});

describe("133 index definition", () => {
  it("creates exactly one index, with the pinned statement", () => {
    const stmts = indexStatements(code);
    expect(stmts.map((s) => s.name)).toEqual([INDEX_NAME]);
    expect(stmts[0]?.stmt).toBe(INDEX_STMT);
  });

  it("is a GIN index on related_stocks only: not unique, no include, no predicate", () => {
    const stmt = indexStatements(code)[0]!.stmt;
    expect(stmt).toMatch(/using gin \(related_stocks\);$/);
    expect(stmt).not.toMatch(/\b(unique|include|where)\b/i);
  });

  it("does not duplicate an index from an earlier migration (only stock_codes is GIN-indexed on kap_disclosures)", () => {
    const earlier = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql") && f < MIGRATION_FILE)
      .sort();
    expect(earlier.length).toBeGreaterThan(100);
    const kapIndexes: { file: string; name: string; stmt: string }[] = [];
    for (const file of earlier) {
      const c = collapse(stripSqlComments(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8")));
      for (const m of c.matchAll(/create (?:unique )?index (?:concurrently )?(?:if not exists )?(\w+) on (?:public\.)?kap_disclosures\b[^;]*;/gi)) {
        kapIndexes.push({ file, name: m[1] as string, stmt: m[0] });
      }
    }
    expect(kapIndexes.length).toBeGreaterThanOrEqual(3);
    for (const { name, stmt } of kapIndexes) {
      expect(name).not.toBe(INDEX_NAME);
      expect(stmt, `${name} must not already index related_stocks`).not.toMatch(/related_stocks/i);
    }
    expect(kapIndexes.some((i) => /using gin \(stock_codes\)/i.test(i.stmt))).toBe(true);
  });

  it("the column is the one the reader's filter names: disclosure-filter.ts matches related_stocks with cs. (array containment, served by GIN)", () => {
    const filter = readFileSync(FILTER_FILE, "utf8");
    expect(filter).toContain("related_stocks.cs.");
    expect(filter).toContain("stock_codes.cs.");
    expect(indexStatements(code)[0]?.stmt).toContain("(related_stocks)");
  });
});

describe("133 header: ORCHESTRATOR PRE-BUILD", () => {
  it("has the heading, the indisvalid check and the 57014 note", () => {
    expect(head).toContain("ORCHESTRATOR PRE-BUILD (run standalone, outside a transaction, before applying 133)");
    expect(headText).toMatch(/indisvalid/);
    expect(headText).toMatch(/57014/);
  });

  it("the in-file `create index if not exists ...` has the identical `create index concurrently if not exists ...` in the header", () => {
    const inFile = indexStatements(code);
    const prebuild = prebuildStatements(headText);
    expect(inFile).toHaveLength(1);
    expect(prebuild).toHaveLength(1);
    const expected = inFile[0]!.stmt.replace("create index if not exists", "create index concurrently if not exists");
    expect(prebuild[0]?.stmt).toBe(expected);
  });

  it("the invalid-index check query names the index", () => {
    const m = /select c\.relname from pg_catalog\.pg_index i[^;]*;/i.exec(collapse(headText));
    expect(m, "invalid-index check select not found in the header").not.toBeNull();
    expect((m as RegExpExecArray)[0]).toContain(`'${INDEX_NAME}'`);
    expect((m as RegExpExecArray)[0]).toMatch(/not i\.indisvalid/i);
  });
});

describe("133 header: deploy order is a hard, blocking, pre-merge requirement", () => {
  // Hunt 11 review: the readers (disclosure-filter.ts) ship with the Vercel deploy on merge. Before
  // 133 exists, `stock_codes @> T OR related_stocks @> T` plans as a Seq Scan of kap_disclosures
  // (EXPLAIN on production: Limit -> Seq Scan, cost 28,886, 215 MB, 208k rows) for the
  // /ekonomi/<well-formed unknown code> existence probe, which any anonymous visitor can reach.
  // The header must say so, once, without a softer wording anywhere else.
  it("says the index must exist BEFORE MERGING the PR that ships the readers, because Vercel deploys on merge", () => {
    expect(headText).toMatch(/DEPLOY ORDER/);
    expect(headText).toMatch(/BEFORE MERGING/);
    expect(headText).toMatch(/Vercel deploys on merge/i);
    expect(headText).toMatch(/blocking/i);
  });

  it("explains what happens without it: a Seq Scan on the existence probe, reachable by anonymous visitors", () => {
    expect(headText).toMatch(/Seq Scan/);
    expect(headText).toMatch(/existence probe/i);
    expect(headText).toMatch(/anonymous/i);
    expect(headText).toMatch(/28,886/);
  });

  it("makes indisvalid = true the merge gate in VERIFY", () => {
    expect(headText).toMatch(/indisvalid = true[^\n]*merge|merge[^\n]*indisvalid = true/i);
  });

  it("never softens it: no 'preferred', 'optional' or 'not required' wording", () => {
    expect(headText).not.toMatch(/\bpreferred\b/i);
    expect(headText).not.toMatch(/\boptional\b/i);
    expect(headText).not.toMatch(/\bnot required\b/i);
    expect(headText).not.toMatch(/\bafter the release\b/i);
  });
});

describe("133 header: documentation sections", () => {
  it("has the WHY section with the Step 0 numbers", () => {
    expect(headText).toMatch(/\bWHY\b/);
    expect(headText).toMatch(/STEP 0/);
    expect(headText).toMatch(/556/);
    expect(headText).toMatch(/8,098/);
    expect(headText).toMatch(/6\.9 ?%/);
    expect(headText).toMatch(/1688666/);
    expect(headText).toMatch(/TRHOL/);
    expect(headText).toMatch(/kap_disclosures_stock_codes_idx/);
    expect(headText).toMatch(/215 MB/);
    expect(headText).toMatch(/schema_migrations/);
  });

  it("has LOCAL PROOF with the BitmapOr plan, both applies and the invalid-index rehearsal", () => {
    expect(headText).toMatch(/LOCAL PROOF/);
    expect(headText).toMatch(/PostgreSQL 15/);
    expect(headText).toMatch(/BitmapOr/);
    expect(headText).toMatch(/kap_disclosures_stock_codes_idx/);
    expect(headText).toMatch(/kap_disclosures_related_stocks_idx/);
    expect(headText).toMatch(/CREATE INDEX/);
    expect(headText).toMatch(/INSERT 0 1/);
    expect(headText).toMatch(/already exists, skipping/);
    expect(headText).toMatch(/INSERT 0 0/);
    expect(headText).toMatch(/133: invalid index/);
    expect(headText).toMatch(/ledger[^\n]*(untouched|stayed)/i);
  });

  it("has a read-only VERIFY section", () => {
    expect(headText).toMatch(/VERIFY/);
    expect(headText).toMatch(/explain[^\n]*\n?[\s\S]*?kap_disclosures_related_stocks_idx/i);
  });

  it("has ROLLBACK lines for the index and for ledger row 133", () => {
    expect(headText).toMatch(/ROLLBACK/);
    expect(headText).toMatch(/drop index concurrently if exists kap_disclosures_related_stocks_idx/i);
    expect(headText).toMatch(/delete from supabase_migrations\.schema_migrations where version = '133'/i);
  });

  it("states the migration is additive, grants nothing and is safe to re-apply", () => {
    expect(headText).toMatch(/additive/i);
    expect(headText).toMatch(/re-?apply/i);
    expect(headText).toMatch(/no grants?|grants? nothing|nothing is granted/i);
  });
});
