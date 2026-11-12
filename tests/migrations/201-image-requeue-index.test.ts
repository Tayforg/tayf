import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 201 ("image-requeue-partial-index").
//
// Hunt 140 (2026-11-12), finding h140-perf-1: the pg_cron job image-backfill-requeue
// ('2,17,32,47 * * * *', public.image_backfill_requeue(40)) walks the whole 7-day
// range of idx_articles_created_at on every run, because only ~9 to 19 of the ~69,000
// articles in that range are candidates, far fewer than its LIMIT 40, so the Limit is
// never satisfied and the scan has no early exit (3.3 s, ~31k buffers, 69,178 rows
// removed by the filter, 96 times a day). 154's header ("NO NEW INDEX" in 142) named
// the remedy: a partial index on created_at where image_url is null.
//
// 201 adds one tiny partial index, articles_image_requeue_idx, on public.articles
// (created_at desc) where image_url is null and image_backfill_attempts between 1 and 2.
// A partial index only helps while the query's WHERE implies the index predicate, so
// the function is part of this contract: the predicate is parsed out of the NEWEST
// migration that defines image_backfill_requeue (154 today; 142 is superseded), and
// this file fails until a NEW migration brings the index back in line (never edit 201
// once applied).
//
// The index is built by the operator with CREATE INDEX CONCURRENTLY BEFORE the
// migration is applied (the 101/127 ORCHESTRATOR PRE-BUILD pattern); the migration's
// own `create index if not exists` is then a no-op. The header lists that statement
// and this file pins that it is identical to the in-file one.
//
// The behaviour on a throwaway Postgres (the plan before and after, the second apply,
// the invalid-index abort) is proved by tests/migrations/sql/201-image-requeue-index-dryrun.sql,
// which run-live.sh executes; this file pins that script against the same sources.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "supabase", "migrations");
const MIGRATION_FILE = "201_image_requeue_partial_index.sql";
const MIGRATION = resolve(MIGRATIONS_DIR, MIGRATION_FILE);
const DRYRUN = resolve(__dirname, "sql", "201-image-requeue-index-dryrun.sql");

const INDEX_NAME = "articles_image_requeue_idx";

const INDEX_STMT =
  "create index if not exists articles_image_requeue_idx on public.articles (created_at desc) where image_url is null and image_backfill_attempts between 1 and 2;";
const PREBUILD_STMT =
  "create index concurrently if not exists articles_image_requeue_idx on public.articles (created_at desc) where image_url is null and image_backfill_attempts between 1 and 2;";

function stripSqlComments(s: string): string {
  return s.replace(/--[^\n]*/g, "");
}

/** Blank out every single-quoted string literal (so prose in messages never satisfies a code guard). */
function sansStrings(s: string): string {
  return s.replace(/'(?:[^']|'')*'/g, "''");
}

/** Whitespace-collapsed form that keeps the text (used on already comment-free strings). */
function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** collapse() with no space just inside parentheses, so `not in (\n select ... \n)` reads the same however it is wrapped. */
function flat(s: string): string {
  return collapse(s).replace(/\( /g, "(").replace(/ \)/g, ")");
}

let sql = "";
let code = "";
let codeNoStr = "";
let head = "";
let headText = "";
let dryrun = "";

beforeAll(() => {
  sql = readFileSync(MIGRATION, "utf8");
  code = stripSqlComments(sql);
  codeNoStr = sansStrings(code);
  head = sql.slice(0, sql.search(/^\s*begin\s*;/im));
  headText = head
    .split("\n")
    .map((l) => l.replace(/^\s*--\s?/, ""))
    .join("\n");
  dryrun = readFileSync(DRYRUN, "utf8");
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

/** Every top-level statement of the executable SQL, the invalid-index guard block left out. */
function statements(c: string): string[] {
  return c
    .replace(/do\s+\$guard\$[\s\S]*?\$guard\$\s*;/i, "")
    .split(";")
    .map(collapse)
    .filter((s) => s.length > 0);
}

// --- the function the index serves ------------------------------------------

interface Definer {
  file: string;
  /** the loop's select, whitespace-flattened, from `select a.id` through `limit v_limit` */
  select: string;
  /** the WHERE clause, whitespace-flattened, without the word where */
  where: string;
  /** the order-by clause without the words order by */
  orderBy: string;
}

/**
 * Every migration (201 itself aside) that (re)defines public.image_backfill_requeue, in file order. A LATER
 * migration counts too: if one changes the function's filter, the parity tests below fail until a new migration
 * brings the index back in line.
 */
function definers(): Definer[] {
  const out: Definer[] = [];
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f) && f !== MIGRATION_FILE)
    .sort();
  for (const file of files) {
    const c = stripSqlComments(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
    const fn = /create\s+or\s+replace\s+function\s+public\.image_backfill_requeue\s*\([\s\S]*?\bas\s+\$fn\$([\s\S]*?)\$fn\$/i.exec(c);
    if (!fn) continue;
    const loop = /for\s+r\s+in\s+(select\s+a\.id\s+from\s+public\.articles\s+a\s+where\s+([\s\S]*?)\s+order\s+by\s+([\s\S]*?)\s+limit\s+v_limit)\s+loop/i.exec(
      fn[1] as string,
    );
    if (!loop) throw new Error(`${file}: the loop select of image_backfill_requeue was not found`);
    out.push({
      file,
      select: flat(loop[1] as string),
      where: flat(loop[2] as string),
      orderBy: flat(loop[3] as string),
    });
  }
  return out;
}

/** The leading, immutable part of the WHERE: `image_url is null and image_backfill_attempts between N and M`. */
function leadingFilter(where: string): { filter: string; rest: string } {
  const m = /^a\.image_url is null and a\.image_backfill_attempts between (\d+) and (\d+)(?= and )/i.exec(where);
  if (!m) throw new Error(`the WHERE does not start with the image_url / attempts filter: ${where}`);
  return {
    filter: collapse(m[0].replace(/\ba\./g, "")),
    rest: where.slice(m[0].length),
  };
}

describe("201 file and ledger", () => {
  it("is the only 201 migration, and 142 and 154 are both there to read the function from", () => {
    const mine = readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("201_"));
    expect(mine).toEqual([MIGRATION_FILE]);
    expect(definers().length).toBeGreaterThanOrEqual(2);
  });

  it("is wrapped in begin/commit and sets lock_timeout 5s / statement_timeout 60s first", () => {
    expect([...code.matchAll(/\bbegin\s*;/gi)]).toHaveLength(1);
    expect([...code.matchAll(/\bcommit\s*;/gi)]).toHaveLength(1);
    expect(code.trimStart()).toMatch(
      /^begin\s*;\s*set\s+local\s+lock_timeout\s*=\s*'5s'\s*;\s*set\s+local\s+statement_timeout\s*=\s*'60s'\s*;/i,
    );
  });

  it("records itself as version '201' under the name of its own file", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(version,\s*name\)\s*values\s*\(\s*'201'\s*,\s*'201_image_requeue_partial_index'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
    expect(MIGRATION_FILE).toBe("201_image_requeue_partial_index.sql");
  });

  it("the ledger insert is the last statement before commit", () => {
    expect(code.trimEnd()).toMatch(
      /values\s*\(\s*'201'\s*,\s*'201_image_requeue_partial_index'\s*\)\s*on\s+conflict\s+do\s+nothing\s*;\s*commit\s*;$/i,
    );
  });

  it("sanity: comment stripping and string blanking are non-vacuous", () => {
    expect(sql.length).toBeGreaterThan(code.length);
    expect(code.length).toBeGreaterThan(codeNoStr.length);
  });
});

describe("201 executable SQL is the index and the ledger row, nothing else", () => {
  it("is exactly: begin, two set locals, the index, the ledger insert, commit (the guard block aside)", () => {
    expect(statements(code)).toEqual([
      "begin",
      "set local lock_timeout = '5s'",
      "set local statement_timeout = '60s'",
      INDEX_STMT.slice(0, -1),
      "insert into supabase_migrations.schema_migrations (version, name) values ('201', '201_image_requeue_partial_index') on conflict do nothing",
      "commit",
    ]);
  });

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
    expect(codeNoStr).not.toMatch(/\bcron\./i);
    expect(codeNoStr).not.toMatch(/\bnotify\b/i);
  });

  it("writes no public table; the only insert is the ledger row", () => {
    expect(codeNoStr).not.toMatch(/\b(insert\s+into|update|delete\s+from)\s+public\./i);
    const inserts = [...codeNoStr.matchAll(/\binsert\s+into\s+([\w.]+)/gi)].map((m) => m[1]);
    expect(inserts).toEqual(["supabase_migrations.schema_migrations"]);
    expect([...codeNoStr.matchAll(/\bupdate\b|\bdelete\b/gi)]).toHaveLength(0);
  });

  it("is idempotent: create index if not exists, ledger insert on conflict do nothing", () => {
    // codeNoStr: the guard's error text says "CREATE INDEX CONCURRENTLY", which is prose, not a statement.
    expect([...codeNoStr.matchAll(/\bcreate\s+index\b/gi)]).toHaveLength(1);
    expect([...codeNoStr.matchAll(/\bcreate\s+index\s+if\s+not\s+exists\b/gi)]).toHaveLength(1);
    expect([...codeNoStr.matchAll(/\binsert\s+into\b/gi)]).toHaveLength(1);
    expect([...codeNoStr.matchAll(/\bon\s+conflict\s+do\s+nothing\b/gi)]).toHaveLength(1);
  });

  it("never mentions the zone word (zone-parity would count this file as another zone-map copy)", () => {
    expect(sql.toLowerCase()).not.toContain("iktidar");
  });
});

describe("201 (0) invalid-index guard", () => {
  const guardRaw = () => {
    const guard = /do\s+\$guard\$([\s\S]*?)\$guard\$\s*;/i.exec(code);
    expect(guard, "guard block (do $guard$ ... $guard$;) not found").not.toBeNull();
    return (guard as RegExpExecArray)[1] as string;
  };

  it("raises when the index exists with indisvalid = false, telling the operator to drop concurrently and rebuild", () => {
    expect(code).toMatch(/pg_catalog\.pg_index/i);
    expect(codeNoStr).toMatch(/\bindisvalid\s*=\s*false\b|\bnot\s+\w+\.indisvalid\b/i);
    expect(code).toMatch(/raise\s+exception\s+'201:[^']*drop index concurrently[^']*rebuild[^']*'/i);
  });

  it("names the index the migration creates", () => {
    expect(indexStatements(code).map((s) => s.name)).toEqual([INDEX_NAME]);
    expect(guardRaw()).toContain(`'${INDEX_NAME}'`);
  });

  it("runs after the timeouts and before the CREATE INDEX", () => {
    const guardAt = code.search(/do\s+\$guard\$/i);
    expect(guardAt).toBeGreaterThan(code.search(/set\s+local\s+statement_timeout/i));
    expect(guardAt).toBeLessThan(code.search(/create\s+index\s+if\s+not\s+exists/i));
  });

  it("checks the public schema's catalog, schema-qualified (search_path is not relied on)", () => {
    const raw = guardRaw();
    expect(raw).toMatch(/pg_catalog\.pg_class/i);
    expect(raw).toMatch(/relnamespace\s*=\s*'public'::regnamespace/i);
    expect(sansStrings(raw)).not.toMatch(/(?<![.\w])(string_agg|count|format)\s*\(/i);
  });
});

describe("201 (0b) size guard (SEC-2: fail closed on a big table without the pre-built index, as 113 does)", () => {
  const guardRaw = () => {
    const guard = /do\s+\$guard\$([\s\S]*?)\$guard\$\s*;/i.exec(code);
    expect(guard, "guard block (do $guard$ ... $guard$;) not found").not.toBeNull();
    return (guard as RegExpExecArray)[1] as string;
  };

  it("declares v_size and looks the index up with to_regclass, schema-qualified", () => {
    const raw = guardRaw();
    expect(sansStrings(raw)).toMatch(/\bv_size\s+bigint\b/i);
    expect(raw).toContain("pg_catalog.to_regclass('public.articles_image_requeue_idx')");
    expect(raw).toMatch(/to_regclass\('public\.articles_image_requeue_idx'\)\s+is\s+null/i);
  });

  it("measures public.articles with pg_relation_size and compares it with 64 MB (67108864 bytes)", () => {
    const raw = guardRaw();
    expect(raw).toMatch(/pg_catalog\.pg_relation_size\('public\.articles'::regclass\)/i);
    expect(raw).toContain("67108864");
    expect(sansStrings(raw)).toMatch(/\bv_size\s*>\s*67108864\b/);
  });

  it("raises a '201: ...' exception that names the ORCHESTRATOR PRE-BUILD, the SHARE lock and the 60 s timeout", () => {
    const raw = guardRaw();
    const m = /raise\s+exception\s+'(201: public\.articles is %[^']*)'\s*,\s*\(v_size\s*\/\s*1048576\)\s*;/i.exec(raw);
    expect(m, "size-guard raise exception not found").not.toBeNull();
    const msg = (m as RegExpExecArray)[1] as string;
    expect(msg).toContain("ORCHESTRATOR PRE-BUILD");
    expect(msg).toContain("articles_image_requeue_idx");
    expect(msg).toMatch(/SHARE lock/);
    expect(msg).toMatch(/60 s statement_timeout/);
    expect(msg).toMatch(/CREATE INDEX CONCURRENTLY/);
    expect(msg).toMatch(/re-apply 201/);
  });

  it("sits in the guard block: after the invalid-index check, before the CREATE INDEX (and after the timeouts)", () => {
    const raw = guardRaw();
    expect(raw.indexOf("indisvalid")).toBeGreaterThan(-1);
    expect(raw.indexOf("pg_relation_size")).toBeGreaterThan(raw.indexOf("indisvalid"));
    const sizeAt = code.search(/pg_relation_size\('public\.articles'/i);
    expect(sizeAt).toBeGreaterThan(code.search(/set\s+local\s+statement_timeout/i));
    expect(sizeAt).toBeLessThan(code.search(/create\s+index\s+if\s+not\s+exists/i));
  });

  it("is size-gated, not unconditional: a small fresh dev or CI database still builds the index in the transaction", () => {
    const raw = sansStrings(guardRaw());
    // The raise for the size guard is inside an `if v_size > ... then`, itself inside `if to_regclass(...) is null then`.
    expect(raw).toMatch(
      /if\s+pg_catalog\.to_regclass\(''\)\s+is\s+null\s+then\s+v_size\s*:=\s*pg_catalog\.pg_relation_size\(''::regclass\);\s*if\s+v_size\s*>\s*67108864\s+then\s+raise\s+exception\s+''\s*,\s*\(v_size\s*\/\s*1048576\);\s*end\s+if;\s*end\s+if;/i,
    );
    // The create index stays `if not exists` (the small-table, pre-built and re-apply cases).
    expect(indexStatements(code)).toHaveLength(1);
  });

  it("the header says the in-transaction build blocks writes (SHARE lock) and that 201 refuses on a table over 64 MB like 113", () => {
    const h = collapse(headText);
    expect(h).toMatch(/SHARE lock/);
    expect(h).toMatch(/55P03/);
    expect(h).toMatch(/refuses[^.]*64 MB/i);
    expect(h).toMatch(/\b113\b/);
    expect(h).toMatch(/small fresh dev or CI database/i);
  });

  it("the header no longer claims the 60 s abort happens instead of blocking ingest", () => {
    expect(collapse(headText)).not.toMatch(/instead of blocking ingest/i);
  });
});

describe("201 index definition", () => {
  it("creates exactly one index, articles_image_requeue_idx", () => {
    expect(indexStatements(code).map((s) => s.name)).toEqual([INDEX_NAME]);
  });

  it("pins the exact statement", () => {
    expect(indexStatements(code)[0]?.stmt).toBe(INDEX_STMT);
  });

  it("is a btree on (created_at desc) only: not unique, no include, no other key column", () => {
    const stmt = indexStatements(code)[0]?.stmt as string;
    expect(stmt).toMatch(/^create index if not exists \w+ on public\.articles \(created_at desc\) where /);
    expect(stmt).not.toMatch(/\b(unique|include|using)\b/i);
  });

  it("the predicate holds only immutable column tests: no now(), no created_at, no subquery", () => {
    const pred = (indexStatements(code)[0]?.stmt as string).replace(/^.*? where /, "");
    expect(pred).toBe("image_url is null and image_backfill_attempts between 1 and 2;");
    expect(pred).not.toMatch(/\bnow\b|\bcreated_at\b|\bselect\b|\binterval\b|\bimage_backfill_attempted_at\b/i);
  });

  it("does not duplicate or shadow an index from an earlier migration", () => {
    const earlier = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql") && f < MIGRATION_FILE)
      .sort();
    expect(earlier.length).toBeGreaterThan(100);
    const articlesIndexes: { file: string; name: string; stmt: string }[] = [];
    for (const file of earlier) {
      const c = collapse(stripSqlComments(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8")));
      for (const m of c.matchAll(
        /create (?:unique )?index (?:concurrently )?(?:if not exists )?(\w+) on (?:public\.)?articles\b[^;]*;/gi,
      )) {
        articlesIndexes.push({ file, name: m[1] as string, stmt: m[0] });
      }
    }
    expect(articlesIndexes.length).toBeGreaterThan(5);
    for (const { name, stmt } of articlesIndexes) {
      expect(name).not.toBe(INDEX_NAME);
      expect(stmt, `${name} must not already be keyed on the requeue predicate`).not.toMatch(/image_backfill_attempts/i);
    }
  });

  it("the neighbours the header names still look the way the header describes them", () => {
    const read = (f: string) => collapse(stripSqlComments(readFileSync(resolve(MIGRATIONS_DIR, f), "utf8")));
    // 015: attempted_at, politics only: it cannot serve this predicate.
    expect(read("015_image_attempted_at.sql")).toMatch(
      /create index if not exists idx_articles_image_backfill_attempted on articles \(image_backfill_attempted_at nulls first\) where image_url is null and category in \('politika', 'son_dakika'\);/,
    );
    // 002: the created_at index the loop walks today.
    expect(read("002_create_articles.sql")).toMatch(/create index idx_articles_created_at on articles \(created_at desc\);/);
  });
});

describe("201 predicate parity with image_backfill_requeue (fails if the function changes and the index stops matching)", () => {
  it("the index predicate is the leading filter of the newest definer's WHERE, with the alias dropped", () => {
    const all = definers();
    const latest = all[all.length - 1] as Definer;
    const { filter } = leadingFilter(latest.where);
    expect(filter).toBe("image_url is null and image_backfill_attempts between 1 and 2");
    const idx = indexStatements(code)[0]?.stmt as string;
    expect(idx).toBe(`create index if not exists ${INDEX_NAME} on public.articles (created_at desc) where ${filter};`);
    expect(PREBUILD_STMT).toBe(idx.replace("create index if not exists", "create index concurrently if not exists"));
  });

  it("the newest definer is not 142: 154 narrowed the tries (between 1 and 4 became between 1 and 2), and the index follows 154", () => {
    const all = definers();
    const first = all[0] as Definer;
    const latest = all[all.length - 1] as Definer;
    expect(first.file).toBe("142_image_backfill_retry.sql");
    expect(leadingFilter(first.where).filter).toBe("image_url is null and image_backfill_attempts between 1 and 4");
    expect(latest.file > first.file).toBe(true);
    expect(leadingFilter(latest.where).filter).not.toBe(leadingFilter(first.where).filter);
  });

  it("every other conjunct of the WHERE is on a column the index does not hold or on a now()-relative bound, so none can be in the predicate", () => {
    const latest = definers().slice(-1)[0] as Definer;
    const { rest } = leadingFilter(latest.where);
    const cols = [...new Set([...rest.matchAll(/\ba\.(\w+)/g)].map((m) => m[1] as string))].sort();
    expect(cols).toEqual(["created_at", "id", "image_backfill_attempted_at"]);
    // the two now()-relative bounds and the queue guard, in this order
    expect(rest).toMatch(/^ and a\.image_backfill_attempted_at < pg_catalog\.now\(\) - interval '2 hours'/);
    expect(rest).toMatch(/ and a\.created_at > pg_catalog\.now\(\) - interval '7 days'/);
    expect(rest).toMatch(/ and a\.id::text not in \(select q\.message ->> 'article_id' from pgmq\.q_image_backfill q where q\.message ->> 'article_id' is not null\)$/);
  });

  it("the function orders by created_at desc: the index key and its direction", () => {
    const latest = definers().slice(-1)[0] as Definer;
    expect(latest.orderBy).toBe("a.created_at desc");
    expect(indexStatements(code)[0]?.stmt).toContain("(created_at desc)");
  });

  it("sanity: the parser is non-vacuous (a changed bound or an added filter would be seen)", () => {
    const latest = definers().slice(-1)[0] as Definer;
    const widened = latest.where.replace("between 1 and 2", "between 1 and 4");
    expect(leadingFilter(widened).filter).toBe("image_url is null and image_backfill_attempts between 1 and 4");
    expect(leadingFilter(widened).filter).not.toBe("image_url is null and image_backfill_attempts between 1 and 2");
    const extra = latest.where.replace(" and a.created_at >", " and a.category = 'x' and a.created_at >");
    expect([...new Set([...leadingFilter(extra).rest.matchAll(/\ba\.(\w+)/g)].map((m) => m[1] as string))].sort()).toContain("category");
    expect(() => leadingFilter("a.image_url is not null and a.image_backfill_attempts between 1 and 2 and a.id is null")).toThrow();
  });
});

describe("201 header: ORCHESTRATOR PRE-BUILD", () => {
  it("has the heading, the indisvalid check and the 57014 note", () => {
    expect(head).toContain("ORCHESTRATOR PRE-BUILD (run standalone, outside a transaction, before applying 201)");
    expect(headText).toMatch(/indisvalid/);
    expect(headText).toMatch(/not\s+\w+\.indisvalid|indisvalid\s*=\s*false/i);
    expect(headText).toMatch(/57014/);
    expect(headText).toMatch(/55P03/);
  });

  it("the in-file `create index if not exists X ...` has the identical `create index concurrently if not exists X ...` in the header", () => {
    const inFile = indexStatements(code);
    const prebuild = prebuildStatements(headText);
    expect(inFile).toHaveLength(1);
    expect(prebuild).toHaveLength(1);
    expect(prebuild[0]?.name).toBe(INDEX_NAME);
    const expected = (inFile[0]?.stmt as string).replace("create index if not exists", "create index concurrently if not exists");
    expect(prebuild[0]?.stmt).toBe(expected);
    expect(prebuild[0]?.stmt).toBe(PREBUILD_STMT);
  });

  it("the invalid-index check query names the index", () => {
    const m = /select c\.relname from pg_catalog\.pg_index i[^;]*;/i.exec(collapse(headText));
    expect(m, "invalid-index check select not found in the header").not.toBeNull();
    expect((m as RegExpExecArray)[0]).toContain(`'${INDEX_NAME}'`);
    expect((m as RegExpExecArray)[0]).toMatch(/not i\.indisvalid/i);
  });
});

describe("201 header: documentation sections", () => {
  it("has the WHY section with the h140 measurements", () => {
    expect(headText).toMatch(/\bWHY\b/);
    expect(headText).toMatch(/h140-perf-1/);
    expect(headText).toMatch(/3,322/);
    expect(headText).toMatch(/69,178/);
    expect(headText).toMatch(/24,629/);
    expect(headText).toMatch(/6,272/);
    expect(headText).toMatch(/96 runs/);
  });

  it("has STEP 0 with the plan today, the function check and the index inventory", () => {
    expect(headText).toMatch(/STEP 0/);
    expect(headText).toMatch(/EXPLAIN/);
    expect(headText).toMatch(/Index Scan using idx_articles_created_at/);
    expect(headText).toMatch(/Rows Removed by Filter/);
    expect(headText).toMatch(/pg_get_functiondef/);
    expect(headText).toMatch(/idx_articles_image_backfill_attempted/);
    expect(headText).toMatch(/schema_migrations/);
    expect(headText).toMatch(/TABLESAMPLE/);
    expect(headText).toMatch(/NO NEW INDEX/);
  });

  it("has LOCAL PROOF with the after plan, the second-apply result and the dry-run name", () => {
    expect(headText).toMatch(/LOCAL PROOF/);
    expect(headText).toMatch(/Index Scan using articles_image_requeue_idx/);
    expect(headText).toMatch(/already exists, skipping/);
    expect(headText).toMatch(/INSERT 0 0/);
    expect(headText).toContain("201-image-requeue-index-dryrun.sql");
  });

  it("has the HOT-update, the disk and the generic-plan notes", () => {
    expect(headText).toMatch(/\bHOT\b/);
    expect(headText).toMatch(/image_backfill_attempted_at/);
    expect(headText).toMatch(/7,000 MB/);
    expect(headText).toMatch(/\bgeneric plan\b/i);
  });

  it("has a read-only VERIFY section that names the index and the thresholds", () => {
    expect(headText).toMatch(/VERIFY/);
    expect(headText).toMatch(/explain \(analyze, buffers, timing off\)/i);
    expect(headText).toMatch(/Index Scan using articles_image_requeue_idx/);
    expect(headText).toMatch(/Rows Removed by Filter[^\n]*100/);
    expect(headText).toMatch(/500/);
    expect(headText).toMatch(/50 ms/);
    expect(headText).toMatch(/pg_relation_size/);
    expect(headText).toMatch(/5 MB/);
    expect(headText).toMatch(/0\.5 s/);
    expect(headText).toMatch(/cron\.job_run_details/);
  });

  it("has ROLLBACK lines for the index and for ledger row 201", () => {
    expect(headText).toMatch(/ROLLBACK/);
    expect(headText).toMatch(/drop index concurrently if exists articles_image_requeue_idx/i);
    expect(headText).toMatch(/delete from supabase_migrations\.schema_migrations where version = '201'/i);
  });

  it("states the migration is additive, leaves the function and the cron job alone, and is safe to re-apply", () => {
    expect(headText).toMatch(/additive/i);
    expect(headText).toMatch(/re-?apply/i);
    expect(headText).toMatch(/No function change/i);
  });
});

describe("201 dry-run script", () => {
  it("has the header the live harness requires and ends with its OK line", () => {
    const first40 = dryrun.split("\n").slice(0, 40).join("\n");
    expect(first40).toContain("-f tests/migrations/sql/stub.sql");
    expect(first40).toContain("D=$(mktemp -d)");
    expect(first40).toContain("-- or: bash tests/migrations/sql/run-live.sh");
    expect(dryrun.trimEnd().split("\n").pop()).toBe("\\echo DRYRUN 201 OK");
  });

  it("applies the migration file itself and runs the identical pre-build statement", () => {
    expect(dryrun).toContain("\\ir ../../../supabase/migrations/201_image_requeue_partial_index.sql");
    expect(flat(stripSqlComments(dryrun))).toContain(PREBUILD_STMT);
  });

  it("its loop query is the function's loop select, byte for byte after whitespace, with limit 40", () => {
    const latest = definers().slice(-1)[0] as Definer;
    const expected = latest.select.replace(/\blimit v_limit$/i, "limit 40");
    expect(expected).toMatch(/limit 40$/);
    expect(flat(stripSqlComments(dryrun))).toContain(expected);
  });

  it("checks the stub's size against the 64 MB guard, and proves the guard refuses on a padded table over 64 MB", () => {
    const d = flat(stripSqlComments(dryrun));
    // step 8 (small table, pre-build skipped -> builds in the transaction) is only valid while the stub is under 64 MB
    expect(d).toMatch(/pg_relation_size\('public\.articles'\) < 64 \* 1024 \* 1024/);
    // step 8b: pad over 64 MB, drop the index, apply 201: it must abort with no index and no ledger row
    expect(d).toMatch(/pg_relation_size\('public\.articles'\) > 64 \* 1024 \* 1024/);
    expect(dryrun).toMatch(/8b\./);
    expect(dryrun).toMatch(/size guard/i);
  });

  it("names the plan checks: before the index (idx_articles_created_at) and after (articles_image_requeue_idx)", () => {
    expect(dryrun).toContain("idx_articles_created_at");
    expect(dryrun).toContain(INDEX_NAME);
    expect(dryrun).toMatch(/Rows Removed by Filter/);
    expect(dryrun).toMatch(/indisvalid/);
  });
});
