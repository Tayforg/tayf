import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 141 ("neutral-title-repick").
//
// Hunt 15 (2026-11-01): the headline cron picks an extractive neutral title
// once, at 2-3 members, and never looks at the cluster again; a 13-source
// cluster kept "POLİS BİLE ŞAŞKINA DÖNDÜ!". extractive-v2 (neutral-title.ts)
// plus a bounded re-pick heals the last 14 days with no backfill UPDATE:
//   * public.clusters.title_neutral_member_count smallint  (nullable, no default)
//   * clusters_neutral_repick_idx  (updated_at desc) partial on the re-pick set
//   * public.neutral_title_repick_candidates(p_model, p_limit)  service_role only
// The route (src/app/api/cron/headline/route.ts) is part of the contract: it
// must call the function with EXTRACTIVE_MODEL_ID, cap its batch at the
// function's cap of 50, and never write clusters.updated_at (it orders the
// home feed). Static block only; the proof lives in the migration header.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "supabase", "migrations");
const MIGRATION_FILE = "141_neutral_title_repick.sql";
const MIGRATION = resolve(MIGRATIONS_DIR, MIGRATION_FILE);
const ROUTE = resolve(__dirname, "..", "..", "src", "app", "api", "cron", "headline", "route.ts");

const INDEX_NAME = "clusters_neutral_repick_idx";
const INDEX_STMT =
  "create index if not exists clusters_neutral_repick_idx on public.clusters (updated_at desc) where is_archived = false and title_neutral_at is null and title_tr_neutral is not null and article_count >= 2;";
const FN = "public.neutral_title_repick_candidates";
const FN_SIG = `${FN}(text, integer)`;

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Blank out every single-quoted string literal (so prose in messages never satisfies a code guard). */
function sansStrings(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

/** Whitespace collapsed, and no padding just inside parentheses. */
function collapse(s: string): string {
  return s.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();
}

function stripTsComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

function flattenTs(src: string): string {
  return src
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/,\)/g, ")")
    .replace(/\s+\.(?=[A-Za-z_]+\()/g, ".")
    .trim();
}

/** The text between the $fn$ markers of the one function in the file. */
function functionBody(code: string): string {
  const m = code.match(/\$fn\$([\s\S]*?)\$fn\$/);
  if (!m || m[1] === undefined) throw new Error("no $fn$ body found");
  return m[1];
}

/** Text between the `(` at `open` and its matching `)`. */
function callArgs(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open + 1);
}

/**
 * Argument text of every call that writes a clusters row: `.update(` and the route's `writeExtractive(`
 * helper (comments already removed from the source).
 */
function writeArgs(src: string): string[] {
  return [...src.matchAll(/\.update\s*\(|(?<!function )\bwriteExtractive\s*\(/g)].map((m) =>
    callArgs(src, (m.index as number) + m[0].length - 1),
  );
}

let raw = "";
let code = "";
let codeNoStr = "";
let flat = "";
let body = "";
let head = "";
let headText = "";
let route = "";
let routeCode = "";
let routeFlat = "";

beforeAll(() => {
  expect(existsSync(MIGRATION), `${MIGRATION_FILE} must exist`).toBe(true);
  raw = readFileSync(MIGRATION, "utf8");
  code = stripSqlComments(raw);
  codeNoStr = sansStrings(code);
  flat = collapse(code);
  body = collapse(functionBody(code));
  head = raw.slice(0, raw.search(/^\s*begin\s*;/im));
  headText = head
    .split("\n")
    .map((l) => l.replace(/^\s*--\s?/, ""))
    .join("\n");
  route = readFileSync(ROUTE, "utf8");
  routeCode = stripTsComments(route);
  routeFlat = flattenTs(routeCode);
});

describe("141 ledger and structure", () => {
  it("is wrapped in one begin/commit and sets lock_timeout 5s / statement_timeout 60s first", () => {
    expect([...code.matchAll(/\bbegin\s*;/gi)]).toHaveLength(1);
    expect([...code.matchAll(/\bcommit\s*;/gi)]).toHaveLength(1);
    expect(code.trimStart()).toMatch(
      /^begin\s*;\s*set\s+local\s+lock_timeout\s*=\s*'5s'\s*;\s*set\s+local\s+statement_timeout\s*=\s*'60s'\s*;/i,
    );
  });

  it("records itself as version '141' under the name of its own file", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(version,\s*name\)\s*values\s*\(\s*'141'\s*,\s*'141_neutral_title_repick'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
    expect(MIGRATION_FILE).toBe("141_neutral_title_repick.sql");
  });

  it("the ledger insert is the last statement before commit", () => {
    expect(code.trimEnd()).toMatch(
      /values\s*\(\s*'141'\s*,\s*'141_neutral_title_repick'\s*\)\s*on\s+conflict\s+do\s+nothing\s*;\s*commit\s*;$/i,
    );
  });

  it("sanity: comment stripping and string blanking are non-vacuous", () => {
    expect(raw.length).toBeGreaterThan(code.length);
    expect(code.length).toBeGreaterThan(codeNoStr.length);
  });

  it("never mentions the zone word (zone-parity would count this file as another zone-map copy)", () => {
    expect(raw.toLowerCase()).not.toContain("iktidar");
  });

  it("bakes no secret into the file", () => {
    expect(raw).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(raw).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{20,}/);
  });
});

describe("141 executable SQL is additive", () => {
  it("writes no public table: the only insert is the ledger row, and there is no update or delete", () => {
    expect(codeNoStr).not.toMatch(/\b(insert\s+into|update|delete\s+from)\s+public\./i);
    const inserts = [...codeNoStr.matchAll(/\binsert\s+into\s+([\w.]+)/gi)].map((m) => m[1]);
    expect(inserts).toEqual(["supabase_migrations.schema_migrations"]);
    expect([...codeNoStr.matchAll(/\bupdate\b|\bdelete\b/gi)]).toHaveLength(0);
  });

  it("has no drop, trigger, truncate, rule or default-privilege statement", () => {
    expect(codeNoStr).not.toMatch(/\bdrop\b/i);
    expect(codeNoStr).not.toMatch(/\btrigger\b/i);
    expect(codeNoStr).not.toMatch(/\btruncate\b/i);
    expect(codeNoStr).not.toMatch(/\bcreate\s+(or\s+replace\s+)?rule\b/i);
    expect(codeNoStr).not.toMatch(/\balter\s+default\s+privileges\b/i);
    expect(codeNoStr).not.toMatch(/\bcreate\s+(or\s+replace\s+)?(unlogged\s+|temp\s+|temporary\s+)?(table|view|policy|extension)\b/i);
  });

  it("uses CONCURRENTLY nowhere in executable SQL (it cannot run inside begin/commit)", () => {
    expect(codeNoStr).not.toMatch(/\bconcurrently\b/i);
  });

  it("the only ALTER is the one nullable column on public.clusters", () => {
    const alters = [...flat.matchAll(/\balter\s[^;]*;/gi)].map((m) => m[0]);
    expect(alters).toEqual([
      "alter table public.clusters add column if not exists title_neutral_member_count smallint;",
    ]);
  });

  it("the column has no default and no not null (no table rewrite, no backfill)", () => {
    const stmt = flat.match(/alter table public\.clusters add column[^;]*;/i)?.[0] ?? "";
    expect(stmt).toBe("alter table public.clusters add column if not exists title_neutral_member_count smallint;");
    expect(stmt).not.toMatch(/\bdefault\b/i);
    expect(stmt).not.toMatch(/\bnot\s+null\b/i);
  });

  it("the statement_timeout (60s) is what turns a skipped pre-build into an abort, and is documented", () => {
    expect(head).toMatch(/57014/);
    expect(head).toMatch(/statement_timeout/);
    expect(head).toMatch(/lock_timeout/);
  });
});

describe("141 invalid-index guard", () => {
  const guardOf = () => /do\s+\$guard\$([\s\S]*?)\$guard\$\s*;/i.exec(code);

  it("raises when the index exists with indisvalid = false, telling the operator to drop concurrently and rebuild", () => {
    expect(code).toMatch(/pg_catalog\.pg_index/i);
    expect(codeNoStr).toMatch(/\bindisvalid\s*=\s*false\b|\bnot\s+\w+\.indisvalid\b/i);
    expect(code).toMatch(/raise\s+exception\s+'141:[^']*drop index concurrently[^']*rebuild[^']*'/i);
  });

  it("names the index the migration creates, schema-qualified catalog (search_path is not relied on)", () => {
    const guard = guardOf();
    expect(guard, "guard block (do $guard$ ... $guard$;) not found").not.toBeNull();
    const text = (guard as RegExpExecArray)[1] as string;
    expect(text).toContain(`'${INDEX_NAME}'`);
    expect(text).toMatch(/pg_catalog\.pg_class/i);
    expect(text).toMatch(/relnamespace\s*=\s*'public'::regnamespace/i);
  });

  it("runs before the ALTER and before the CREATE INDEX", () => {
    const guardAt = code.search(/do\s+\$guard\$/i);
    expect(guardAt).toBeGreaterThan(0);
    expect(guardAt).toBeLessThan(code.search(/alter\s+table/i));
    expect(guardAt).toBeLessThan(code.search(/create\s+index\s+if\s+not\s+exists/i));
  });
});

describe("141 index definition", () => {
  const indexStatements = (c: string) =>
    [...c.matchAll(/create\s+index\s+if\s+not\s+exists\s+(\w+)\s+on\s+[^;]+;/gi)].map((m) => ({
      name: m[1] as string,
      stmt: collapse(m[0]),
    }));

  it("creates exactly clusters_neutral_repick_idx, with the pinned statement", () => {
    const stmts = indexStatements(code);
    expect(stmts.map((s) => s.name)).toEqual([INDEX_NAME]);
    expect(stmts[0]?.stmt).toBe(INDEX_STMT);
  });

  it("is a btree on (updated_at desc) only: not unique, no include, `is_archived = false` form", () => {
    expect(INDEX_STMT).not.toMatch(/\b(unique|include|using)\b/i);
    expect(INDEX_STMT).not.toMatch(/\bnot\s+is_archived\b/i);
    expect(INDEX_STMT).toMatch(/\bis_archived\s*=\s*false\b/);
  });

  it("the name is free: no earlier migration creates it", () => {
    const earlier = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql") && f < MIGRATION_FILE)
      .sort();
    expect(earlier.length).toBeGreaterThan(100);
    for (const f of earlier) {
      expect(stripSqlComments(readFileSync(resolve(MIGRATIONS_DIR, f), "utf8")), f).not.toContain(INDEX_NAME);
    }
  });

  it("its article_count floor is the route's EXTRACTIVE_MIN_ARTICLE_COUNT", () => {
    const m = /const EXTRACTIVE_MIN_ARTICLE_COUNT = (\d+);/.exec(route);
    expect(m, "EXTRACTIVE_MIN_ARTICLE_COUNT not found in route.ts").not.toBeNull();
    expect(INDEX_STMT).toContain(`article_count >= ${(m as RegExpExecArray)[1]};`);
  });
});

describe("141 header: ORCHESTRATOR PRE-BUILD", () => {
  it("has the heading, the indisvalid check and the 57014 note", () => {
    expect(head).toContain("ORCHESTRATOR PRE-BUILD");
    expect(headText).toMatch(/not\s+\w+\.indisvalid|indisvalid\s*=\s*false/i);
    expect(headText).toMatch(/57014/);
  });

  it("the in-file index has the identical `create index concurrently if not exists` in the header", () => {
    const prebuild = [...headText.matchAll(/create\s+index\s+concurrently\s+if\s+not\s+exists\s+(\w+)\s+on\s+[^;]+;/gi)].map(
      (m) => ({ name: m[1] as string, stmt: collapse(m[0]) }),
    );
    expect(prebuild).toHaveLength(1);
    expect(prebuild[0]?.name).toBe(INDEX_NAME);
    expect(prebuild[0]?.stmt).toBe(INDEX_STMT.replace("create index if not exists", "create index concurrently if not exists"));
  });

  it("the invalid-index check select names the index", () => {
    const m = /select c\.relname from pg_catalog\.pg_index i[^;]*;/i.exec(collapse(headText));
    expect(m, "invalid-index check select not found in the header").not.toBeNull();
    expect((m as RegExpExecArray)[0]).toContain(`'${INDEX_NAME}'`);
    expect((m as RegExpExecArray)[0]).toMatch(/not i\.indisvalid/i);
  });
});

describe("141 function neutral_title_repick_candidates", () => {
  it("has the documented signature and result columns", () => {
    expect(flat).toContain(
      `create or replace function ${FN}(p_model text, p_limit integer default 20) returns table (id uuid, title_tr_neutral text, article_count integer, title_neutral_member_count smallint)`,
    );
  });

  it("is SQL, STABLE, SECURITY DEFINER with an empty search_path", () => {
    const header = flat.match(/title_neutral_member_count smallint\) ([\s\S]*?) as \$fn\$/i)?.[1] ?? "";
    expect(header).toMatch(/\blanguage sql\b/i);
    expect(header).toMatch(/\bstable\b/i);
    expect(header).not.toMatch(/\b(immutable|volatile)\b/i);
    expect(header).toMatch(/\bsecurity definer\b/i);
    expect(header).toMatch(/set search_path = ''/i);
  });

  it("walks the index: the inner query has the index predicate, the 14 day window, the order and a hard limit", () => {
    expect(body).toContain(
      "from public.clusters c where c.is_archived = false and c.title_neutral_at is null and c.title_tr_neutral is not null and c.article_count >= 2",
    );
    expect(body).toContain("c.updated_at > pg_catalog.now() - interval '14 days'");
    expect(body).toMatch(/order by c\.updated_at desc limit 5000\) w/);
  });

  it("selects the stale ones: another model, no stamp, or the cluster doubled/grew by 3", () => {
    expect(body).toContain("w.title_neutral_model is distinct from p_model");
    expect(body).toContain("w.title_neutral_member_count is null");
    expect(body).toContain("w.article_count >= greatest(w.title_neutral_member_count * 2, w.title_neutral_member_count + 3)");
    expect(body).toMatch(/where w\.title_neutral_model is distinct from p_model or w\.title_neutral_member_count is null or /);
  });

  it("orders newest first and caps the batch at 50, NULL-safe and never below 1", () => {
    expect(body).toMatch(/order by w\.updated_at desc limit least\(greatest\(coalesce\(p_limit, 20\), 1\), 50\);?$/);
  });

  it("reads only: no write verb, no dynamic SQL, never touches updated_at as a value", () => {
    expect(body).not.toMatch(/\b(insert|update|delete|truncate|merge)\b/i);
    expect(body).not.toMatch(/\bperform\b|\bexecute\b/i);
    expect(body).not.toMatch(/title_neutral_prompt_version|summary_tr/);
  });

  it("schema-qualifies every relation and function it uses (empty search_path)", () => {
    const refs = [...body.matchAll(/(?<!distinct )\b(?:from|join)\s+([a-z_][a-z0-9_.]*)/gi)].map((m) => m[1] as string);
    expect(refs.length).toBeGreaterThanOrEqual(1);
    for (const r of refs) expect(r.startsWith("public.") || r.startsWith("pg_catalog."), `unqualified relation ${r}`).toBe(true);
    expect(body).not.toMatch(/(?<![.\w])now\s*\(/i);
    expect(body).toContain("pg_catalog.now()");
  });

  it("comments on the function", () => {
    expect(flat).toMatch(new RegExp(`comment on function ${FN.replace(".", "\\.")}\\(text, integer\\) is `, "i"));
  });
});

describe("141 privileges", () => {
  it("revokes all from public, anon and authenticated, and grants execute to service_role only", () => {
    expect(flat).toContain(`revoke all on function ${FN_SIG} from public, anon, authenticated;`);
    const grants = flat.match(/\bgrant\b[^;]*;/gi) ?? [];
    expect(grants).toEqual([`grant execute on function ${FN_SIG} to service_role;`]);
  });

  it("grants nothing on tables or sequences and touches no default privileges", () => {
    expect(flat).not.toMatch(/\bto\s+(public|anon|authenticated)\b/i);
    expect(flat).not.toMatch(/grant\s+[^;]*\bon\s+(table|sequence|all)\b/i);
    expect(flat).not.toMatch(/alter\s+default\s+privileges/i);
  });

  it("asks PostgREST to reload its schema cache", () => {
    expect(flat).toMatch(/notify pgrst, 'reload schema';/i);
  });
});

describe("141 header: documentation sections", () => {
  it.each(["WHY", "STEP 0", "LOCAL PROOF", "DRY RUNS x2", "HOT", "VERIFY", "ROLLBACK"])("has the %s section", (section) => {
    expect(headText).toContain(section);
  });

  it("STEP 0 records the trigger, ledger, index-name and walk-size facts", () => {
    expect(headText).toMatch(/pg_trigger/);
    expect(headText).toMatch(/nothing bumps updated_at/i);
    expect(headText).toMatch(/schema_migrations/);
    expect(headText).toMatch(/pg_indexes/);
    expect(headText).toMatch(/4,?121/);
    expect(headText).toMatch(/extractive-v1/);
    expect(headText).toMatch(/5,?000/);
  });

  it("LOCAL PROOF has EXPLAIN (ANALYZE, BUFFERS) before and after, the new index scan and the second-apply result", () => {
    expect(headText).toMatch(/EXPLAIN \(ANALYZE, BUFFERS\)/);
    expect(headText).toMatch(/BEFORE/);
    expect(headText).toMatch(/AFTER/);
    expect(headText).toMatch(/Index Scan using clusters_neutral_repick_idx/);
    expect(headText).toMatch(/already exists, skipping/);
    expect(headText).toMatch(/INSERT 0 0/);
    expect(headText).toMatch(/permission denied for function/);
  });

  it("DRY RUNS x2 pastes both runs", () => {
    expect(headText).toMatch(/DRY RUNS x2/);
    expect(headText).toMatch(/Apply #1/);
    expect(headText).toMatch(/Apply #2/);
  });

  it("HOT explains why the re-pick write is cheap, and why the cron never writes updated_at", () => {
    expect(headText).toMatch(/\bHOT\b/);
    expect(headText).toMatch(/title_tr_neutral/);
    expect(headText).toMatch(/updated_at/);
    expect(headText).toMatch(/home feed/i);
  });

  it("VERIFY is read-only and names the index and the PGRST204 fallback", () => {
    expect(headText).toMatch(/VERIFY/);
    expect(headText).toMatch(/Index Scan using clusters_neutral_repick_idx/);
    expect(headText).toMatch(/PGRST204/);
  });

  it("ROLLBACK drops the function, the index and the column, and deletes ledger row 141", () => {
    expect(headText).toMatch(/drop function if exists public\.neutral_title_repick_candidates\(text, integer\)/i);
    expect(headText).toMatch(/drop index concurrently if exists clusters_neutral_repick_idx/i);
    expect(headText).toMatch(/alter table public\.clusters drop column if exists title_neutral_member_count/i);
    expect(headText).toMatch(/delete from supabase_migrations\.schema_migrations where version = '141'/i);
  });

  it("states the migration is additive, writes no data and is safe to re-apply", () => {
    expect(headText).toMatch(/additive/i);
    expect(headText).toMatch(/re-?apply/i);
    expect(headText).toMatch(/no backfill/i);
  });
});

describe("141 route parity (src/app/api/cron/headline/route.ts)", () => {
  it("calls the function with p_model: EXTRACTIVE_MODEL_ID", () => {
    expect(routeFlat).toMatch(/\.rpc\("neutral_title_repick_candidates", \{ p_model: EXTRACTIVE_MODEL_ID, p_limit: [A-Za-z_]+ ?\}\)/);
  });

  it("REPICK_BATCH is at most the function's cap of 50", () => {
    const m = /const REPICK_BATCH = (\d+);/.exec(routeCode);
    expect(m, "REPICK_BATCH not found in route.ts").not.toBeNull();
    const batch = Number((m as RegExpExecArray)[1]);
    const cap = Number(/limit least\(greatest\(coalesce\(p_limit, 20\), 1\), (\d+)\)/.exec(body)?.[1]);
    expect(cap).toBe(50);
    expect(batch).toBeGreaterThan(0);
    expect(batch).toBeLessThanOrEqual(cap);
  });

  it("stamps the cluster's article_count, clamped to the smallint maximum, not the number of titles used", () => {
    expect(routeCode).toMatch(/const MEMBER_COUNT_MAX = 32767;/);
    expect(routeFlat).toContain("Math.min(articleCount, MEMBER_COUNT_MAX)");
    const stamps = [...routeFlat.matchAll(/title_neutral_member_count: ([^,}]+)/g)].map((m) => (m[1] as string).trim()).filter((v) => v !== "_stamp" && v !== "number | null;"); // the destructure in writeExtractive, the row type
    expect(stamps.length).toBeGreaterThanOrEqual(4);
    for (const v of stamps) expect(v, `stamp value ${v}`).toMatch(/^memberCountStamp\((c|r)\.article_count\)$/);
  });

  it("no .update({...}) object, no writeExtractive patch and no patch the route builds contains updated_at", () => {
    const writes = writeArgs(routeCode);
    expect(writes.length).toBeGreaterThanOrEqual(5);
    for (const a of writes) expect(a, `write(${a})`).not.toMatch(/updated_at/);
    // The only mention of the column in code is the pick's ORDER BY.
    const residue = routeFlat.replace('.order("updated_at", { ascending: false })', "");
    expect(residue).not.toMatch(/updated_at/);
  });

  it("sanity: the write extractor is non-vacuous (a stray updated_at would be seen)", () => {
    const tampered = routeCode.replace("title_neutral_model: EXTRACTIVE_MODEL_ID,", "title_neutral_model: EXTRACTIVE_MODEL_ID, updated_at: x,");
    expect(tampered).not.toBe(routeCode);
    expect(writeArgs(tampered).some((a) => /updated_at/.test(a))).toBe(true);
    const viaUpdate = routeCode.replace("title_tr_neutral: result.text,", "title_tr_neutral: result.text, updated_at: x,");
    expect(writeArgs(viaUpdate).some((a) => /updated_at/.test(a))).toBe(true);
    expect(stripTsComments('a(); // .rpc("neutral_title_repick_candidates")')).not.toContain("neutral_title_repick_candidates");
  });
});
