import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 130 ("db-hot-paths"), hunt 10
// (2026-11-01), findings h10-dbhot-1 and h10-dbhot-2. Three changes that cut
// about 4.5k DB-seconds a day:
//
//   1. public.existing_source_content_hash_pairs(uuid[], text[]): a PAIRWISE
//      probe replaces ingest's `.in("source_id", ...).in("content_hash", ...)`
//      source x hash cross product (PostgREST's #1 statement by DB time).
//   2. cluster-topics-refresh splits into a 2 h job every 10 min plus a new
//      36 h job ('cluster-topics-refresh-wide') hourly. The function body and
//      its advisory lock are untouched.
//   3. The framing pool gets a partial index on jev_shadow_predictions that
//      the refresh's recent_politics CTE can imply, and its upsert stops
//      rewriting rows that did not change.
//
// A partial index only helps while the query's WHERE implies the index
// predicate, and the edge function only gains from the RPC while it calls it
// with the SQL's parameter names. Both couplings are parsed out below, so
// changing either side fails this file until the other is brought back in
// line (a NEW migration -- never edit 130 once applied).
// ---------------------------------------------------------------------------

const REPO = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(REPO, "supabase", "migrations");
const MIGRATION_130_FILE = "130_db_hot_paths.sql";
const MIGRATION_130 = resolve(MIGRATIONS_DIR, MIGRATION_130_FILE);
const MIGRATION_105 = resolve(MIGRATIONS_DIR, "105_framing_candidate_pool.sql");
const INGEST = resolve(REPO, "supabase", "functions", "ingest", "index.ts");

const INDEX_NAME = "jev_shadow_predictions_politics_conf_idx";
const INDEX_STMT =
  "create index if not exists jev_shadow_predictions_politics_conf_idx on public.jev_shadow_predictions (created_at desc) include (article_id) where task = 'politics' and jev_prob >= 0.7 and article_id is not null;";
const PREBUILD_STMT =
  "create index concurrently if not exists jev_shadow_predictions_politics_conf_idx on public.jev_shadow_predictions (created_at desc) include (article_id) where task = 'politics' and jev_prob >= 0.7 and article_id is not null;";
const UPSERT_GUARD =
  "where (framing_candidate_pool.title, framing_candidate_pool.published_at) is distinct from (excluded.title, excluded.published_at)";

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Blank out every single-quoted string literal (so prose in messages never satisfies a code guard). */
function sansStrings(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

/** Drop every dollar-quoted block (function bodies, DO blocks, nested $sql$ strings), leaving `$$`. */
function sansDollarBlocks(sql: string): string {
  return sql.replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, "$$$$");
}

/** Whitespace-collapsed form that keeps the text (used on already comment-free strings). */
function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Collapsed, with no space just inside parentheses, so `( a )` and `(a)` compare equal. */
function tight(s: string): string {
  return collapse(s).replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
}

/** The dollar-quoted body that follows the first match of `startRe` in `sql`. */
function dollarBodyAfter(sql: string, startRe: RegExp): string {
  const from = sql.search(startRe);
  if (from < 0) throw new Error(`pattern not found: ${startRe}`);
  const m = /\$(\w+)\$([\s\S]*?)\$\1\$/.exec(sql.slice(from));
  if (!m) throw new Error(`no dollar-quoted body after: ${startRe}`);
  return m[2] as string;
}

/** TypeScript with its comments removed (a quoting comment must never satisfy a parity assertion). */
function stripTsComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

/** TypeScript flattened so a prettier line-wrap cannot hide or fake a match. */
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
let code = ""; // comments stripped
let codeNoStr = ""; // comments stripped, string literals blanked
let top = ""; // comments stripped, dollar blocks removed, strings blanked: top-level statements only
let head = "";
let headText = "";
let sql105 = "";
let code105 = "";
let ingest = "";
let ingestFlat = "";

beforeAll(() => {
  sql = readFileSync(MIGRATION_130, "utf8");
  code = stripSqlComments(sql);
  codeNoStr = sansStrings(code);
  top = sansStrings(sansDollarBlocks(code));
  head = sql.slice(0, sql.search(/^\s*begin\s*;/im));
  headText = head
    .split("\n")
    .map((l) => l.replace(/^\s*--\s?/, ""))
    .join("\n");
  sql105 = readFileSync(MIGRATION_105, "utf8");
  code105 = stripSqlComments(sql105);
  ingest = stripTsComments(readFileSync(INGEST, "utf8"));
  ingestFlat = flattenTs(ingest);
});

function rpcBody(): string {
  return dollarBodyAfter(code, /create or replace function public\.existing_source_content_hash_pairs\b/i);
}

function framingBody130(): string {
  return dollarBodyAfter(code, /create or replace function public\.framing_candidate_pool_refresh\(\)/i);
}

function framingBody105(): string {
  return dollarBodyAfter(code105, /create or replace function public\.framing_candidate_pool_refresh\(\)/i);
}

/** `create index [concurrently] if not exists X on ...;` statements. */
function indexStatements(text: string, concurrently: boolean): { name: string; stmt: string }[] {
  const re = concurrently
    ? /create\s+index\s+concurrently\s+if\s+not\s+exists\s+(\w+)\s+on\s+[^;]+;/gi
    : /create\s+index\s+if\s+not\s+exists\s+(\w+)\s+on\s+[^;]+;/gi;
  return [...text.matchAll(re)].map((m) => ({ name: m[1] as string, stmt: collapse(m[0]) }));
}

describe("130 ledger and structure", () => {
  it("is wrapped in begin/commit and sets lock_timeout 5s / statement_timeout 60s first", () => {
    expect([...top.matchAll(/\bbegin\s*;/gi)]).toHaveLength(1);
    expect([...top.matchAll(/\bcommit\s*;/gi)]).toHaveLength(1);
    expect(code.trimStart()).toMatch(
      /^begin\s*;\s*set\s+local\s+lock_timeout\s*=\s*'5s'\s*;\s*set\s+local\s+statement_timeout\s*=\s*'60s'\s*;/i,
    );
  });

  it("records itself as version '130' under the name of its own file", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(version,\s*name\)\s*values\s*\(\s*'130'\s*,\s*'130_db_hot_paths'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
    expect(MIGRATION_130_FILE).toBe("130_db_hot_paths.sql");
  });

  it("the ledger insert is the last statement before commit", () => {
    expect(code.trimEnd()).toMatch(
      /values\s*\(\s*'130'\s*,\s*'130_db_hot_paths'\s*\)\s*on\s+conflict\s+do\s+nothing\s*;\s*commit\s*;$/i,
    );
  });

  it("reloads the PostgREST schema cache so the new RPC is callable right after apply", () => {
    expect(code).toMatch(/notify\s+pgrst\s*,\s*'reload schema'\s*;/i);
  });

  it("sections run in the documented order", () => {
    const at = (re: RegExp): number => {
      const i = code.search(re);
      expect(i, `${re} not found`).toBeGreaterThanOrEqual(0);
      return i;
    };
    const order = [
      at(/set\s+local\s+statement_timeout/i),
      at(/do\s+\$guard\$/i),
      at(/create or replace function public\.existing_source_content_hash_pairs/i),
      at(/cron\.schedule\(\s*'cluster-topics-refresh'/i),
      at(/create\s+index\s+if\s+not\s+exists/i),
      at(/create or replace function public\.framing_candidate_pool_refresh/i),
      at(/notify\s+pgrst/i),
      at(/insert\s+into\s+supabase_migrations\.schema_migrations/i),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("sanity: comment stripping, string blanking and block removal are non-vacuous", () => {
    expect(sql.length).toBeGreaterThan(code.length);
    expect(code.length).toBeGreaterThan(codeNoStr.length);
    expect(codeNoStr.length).toBeGreaterThan(top.length);
    expect(sansDollarBlocks("a $x$ b $y$ c $y$ d $x$ e $$ f $$ g")).toBe("a $$ e $$ g");
  });
});

describe("130 existing_source_content_hash_pairs RPC", () => {
  it("has the pinned signature, returns table (source_id uuid, content_hash text), plpgsql stable security definer, search_path = ''", () => {
    expect(tight(code)).toContain(
      "create or replace function public.existing_source_content_hash_pairs(p_source_ids uuid[], p_hashes text[]) returns table (source_id uuid, content_hash text) language plpgsql stable security definer set search_path = '' as $fn$",
    );
  });

  it("raises on mismatched cardinality and on more than 500 pairs, before it queries", () => {
    const body = collapse(sansStrings(rpcBody()));
    expect(body).toMatch(/\bcardinality\(p_source_ids\)/i);
    expect(body).toMatch(/\bcardinality\(p_hashes\)/i);
    expect(body).toMatch(/<>/);
    expect(body).toMatch(/>\s*500\b/);
    expect([...body.matchAll(/\braise\s+exception\b/gi)]).toHaveLength(2);
    expect(body.search(/\braise\s+exception\b/i)).toBeLessThan(body.search(/\breturn\s+query\b/i));
    expect(body.lastIndexOf("raise exception")).toBeLessThan(body.search(/\breturn\s+query\b/i));
  });

  it("selects from unnest(p_source_ids, p_hashes) as v(sid, h) joined to public.articles on BOTH columns", () => {
    const body = tight(sansStrings(rpcBody()));
    const m =
      /return query select a\.source_id, a\.content_hash from unnest\(p_source_ids, p_hashes\) as v\(sid, h\) join public\.articles a on (a\.source_id = v\.sid and a\.content_hash = v\.h|a\.content_hash = v\.h and a\.source_id = v\.sid);?/i.exec(
        body,
      );
    expect(m, `pairwise return query not found in: ${body}`).not.toBeNull();
    // The multi-array unnest(a, b) is parser syntax for the BARE name only: pg_catalog.unnest(a, b)
    // fails at call time ("function pg_catalog.unnest(uuid[], text[]) does not exist"), which a
    // static read of the SQL would never show. search_path = '' still resolves the bare name.
    expect(body).not.toMatch(/pg_catalog\.unnest\s*\(/i);
    // It is a pairwise join, never a cross product: no ANY(...) and no IN over either array.
    expect(body).not.toMatch(/\bany\s*\(/i);
    expect(body).not.toMatch(/\bin\s*\(\s*select\b/i);
  });

  it("qualifies every column of the query: the OUT parameters source_id and content_hash would shadow bare names", () => {
    const query = sansStrings(rpcBody());
    const from = query.search(/\breturn\s+query\b/i);
    expect(from).toBeGreaterThan(0);
    const bare = [...query.slice(from).matchAll(/(?<![.\w])(source_id|content_hash)\b/gi)];
    expect(bare.map((m) => m[0])).toEqual([]);
  });

  it("is revoked from public, anon and authenticated and granted to service_role only", () => {
    const sig = "public\\.existing_source_content_hash_pairs\\(uuid\\[\\], text\\[\\]\\)";
    const revoke = new RegExp(`revoke\\s+all\\s+on\\s+function\\s+${sig}\\s+from\\s+([\\w,\\s]+?);`, "i").exec(code);
    expect(revoke, "revoke not found").not.toBeNull();
    expect(
      ((revoke as RegExpExecArray)[1] as string)
        .split(",")
        .map((s) => s.trim())
        .sort(),
    ).toEqual(["anon", "authenticated", "public"]);
    const grants = [...code.matchAll(new RegExp(`grant\\s+[^;]*?${sig}[^;]*;`, "gi"))].map((m) => collapse(m[0]));
    expect(grants).toEqual(["grant execute on function public.existing_source_content_hash_pairs(uuid[], text[]) to service_role;"]);
    expect(code.search(new RegExp(`revoke\\s+all\\s+on\\s+function\\s+${sig}`, "i"))).toBeLessThan(
      code.search(new RegExp(`grant\\s+execute\\s+on\\s+function\\s+${sig}`, "i")),
    );
  });

  it("is documented with a comment on the function", () => {
    expect(code).toMatch(/comment on function public\.existing_source_content_hash_pairs\(uuid\[\], text\[\]\) is\s+'/i);
  });
});

describe("130 ingest call-site parity", () => {
  it("ingest calls the RPC with exactly the SQL's parameter names", () => {
    const sigM = /function public\.existing_source_content_hash_pairs\(([^)]*)\)/i.exec(tight(code));
    expect(sigM, "RPC signature not found").not.toBeNull();
    const sqlParams = ((sigM as RegExpExecArray)[1] as string).split(",").map((p) => (p.trim().split(/\s+/)[0] as string));
    expect(sqlParams).toEqual(["p_source_ids", "p_hashes"]);

    const callM = /\.rpc\("existing_source_content_hash_pairs", \{ (p_source_ids): [^}]*? (p_hashes): [^}]*\}\)/.exec(ingestFlat);
    expect(callM, "the .rpc(\"existing_source_content_hash_pairs\", { ... }) call was not found in ingest/index.ts").not.toBeNull();
    expect([(callM as RegExpExecArray)[1], (callM as RegExpExecArray)[2]]).toEqual(sqlParams);
    // The arrays are the per-row pairs, index-aligned: both come from the same `rows`, un-deduped.
    expect(ingestFlat).toContain("p_source_ids: rows.map((r) => r.source_id)");
    expect(ingestFlat).toContain("p_hashes: rows.map((r) => r.content_hash)");
  });

  it('`.in("content_hash"` appears exactly once in ingest/index.ts, inside the legacy fallback function', () => {
    expect(ingest.split('.in("content_hash"').length - 1).toBe(1);
    const start = ingest.search(/\bfunction legacyExistingPairsProbe\(/);
    expect(start, "legacyExistingPairsProbe not found").toBeGreaterThanOrEqual(0);
    const end = ingest.indexOf("\n}\n", start);
    expect(end).toBeGreaterThan(start);
    expect(ingest.slice(start, end)).toContain('.in("content_hash"');
  });

  it("the chunk lookup falls back to the legacy probe only on PGRST202 (function missing), and is otherwise fail-open", () => {
    const start = ingest.search(/\bfunction dropExistingSourceContentHashRowsChunk\(/);
    expect(start).toBeGreaterThanOrEqual(0);
    const chunkFn = ingest.slice(start, ingest.indexOf("\n}\n", start));
    expect(chunkFn).toContain('"PGRST202"');
    expect(chunkFn).toContain("legacyExistingPairsProbe(supabase, rows)");
    expect(chunkFn).not.toContain('.in("content_hash"');
    expect([...chunkFn.matchAll(/lookupErrors: 1/g)]).toHaveLength(2);
  });
});

describe("130 pg_cron split of cluster-topics-refresh", () => {
  function cronBlock(): string {
    const blocks = [...code.matchAll(/do\s+\$(\w+)\$([\s\S]*?)\$\1\$\s*;/gi)].map((m) => m[2] as string);
    const hit = blocks.filter((b) => /cron\.schedule/i.test(b));
    expect(hit, "exactly one DO block schedules cron jobs").toHaveLength(1);
    return hit[0] as string;
  }

  it("is guarded on the pg_cron extension and returns early without it", () => {
    const b = cronBlock();
    expect(b).toMatch(/if\s+not\s+exists\s*\(\s*select\s+1\s+from\s+pg_catalog\.pg_extension\s+where\s+extname\s*=\s*'pg_cron'\s*\)\s*then\s+raise\s+notice[^;]*;\s*return\s*;\s*end\s+if\s*;/i);
    expect(b.search(/pg_extension/i)).toBeLessThan(b.search(/cron\.job/i));
  });

  it("unschedules each job (only if it exists) immediately before scheduling it", () => {
    const b = tight(cronBlock());
    for (const name of ["cluster-topics-refresh", "cluster-topics-refresh-wide"]) {
      const guard = `if exists (select 1 from cron.job where jobname = '${name}') then perform cron.unschedule('${name}'); end if; perform cron.schedule('${name}',`;
      expect(b, `${name}: unschedule guard directly before schedule`).toContain(guard);
    }
  });

  it("schedules the narrow job every 10 min on a 2 h window and the wide job hourly at :08 on a 36 h window", () => {
    const b = tight(cronBlock());
    expect(b).toContain(
      "perform cron.schedule('cluster-topics-refresh', '3-59/10 * * * *', $sql$ select public.cluster_topics_refresh(interval '2 hours'); $sql$);",
    );
    expect(b).toContain(
      "perform cron.schedule('cluster-topics-refresh-wide', '8 * * * *', $sql$ select public.cluster_topics_refresh(interval '36 hours'); $sql$);",
    );
  });

  it("touches no other job: the two names are the only ones in schedule/unschedule calls and cron.job lookups", () => {
    const names = (re: RegExp): string[] => [...code.matchAll(re)].map((m) => m[1] as string);
    expect(names(/cron\.schedule\(\s*'([^']+)'/gi)).toEqual(["cluster-topics-refresh", "cluster-topics-refresh-wide"]);
    expect(names(/cron\.unschedule\(\s*'([^']+)'/gi)).toEqual(["cluster-topics-refresh", "cluster-topics-refresh-wide"]);
    expect(names(/jobname\s*=\s*'([^']+)'/gi)).toEqual(["cluster-topics-refresh", "cluster-topics-refresh-wide"]);
    expect(codeNoStr).not.toMatch(/\b(update|delete\s+from|insert\s+into)\s+cron\./i);
    expect(codeNoStr).not.toMatch(/\bcron\.alter_job\b/i);
  });

  it("does NOT redefine cluster_topics_refresh: its signature (p_since interval default 2 h) and advisory lock stay as the latest earlier migration left them", () => {
    expect(codeNoStr).not.toMatch(/create\s+(or\s+replace\s+)?function\s+public\.cluster_topics_refresh/i);
    const earlier = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql") && f < MIGRATION_130_FILE)
      .sort();
    const defs = earlier
      .map((f) => ({ f, c: stripSqlComments(readFileSync(resolve(MIGRATIONS_DIR, f), "utf8")) }))
      .filter(({ c }) => /create\s+or\s+replace\s+function\s+public\.cluster_topics_refresh\b/i.test(c));
    expect(defs.length).toBeGreaterThanOrEqual(2);
    const last = (defs[defs.length - 1] as { f: string; c: string }).c;
    expect(tight(last)).toMatch(
      /create or replace function public\.cluster_topics_refresh\(p_since interval default interval '2 hours'\) returns integer language plpgsql security definer set search_path = ''/i,
    );
    expect(last).toContain("pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('cluster_topics_refresh')::bigint)");
  });
});

describe("130 framing partial index", () => {
  it("creates exactly one index, with the pinned statement", () => {
    const stmts = indexStatements(code, false);
    expect(stmts.map((s) => s.name)).toEqual([INDEX_NAME]);
    expect(stmts[0]?.stmt).toBe(INDEX_STMT);
    expect(codeNoStr).not.toMatch(/\bconcurrently\b/i);
  });

  it("the ORCHESTRATOR PRE-BUILD line is the same statement with `concurrently`", () => {
    const pre = indexStatements(headText, true);
    expect(pre).toHaveLength(1);
    expect(pre[0]?.stmt).toBe(PREBUILD_STMT);
    expect(INDEX_STMT).toBe(PREBUILD_STMT.replace("create index concurrently if not exists", "create index if not exists"));
    expect(indexStatements(code, false)[0]?.stmt).toBe(pre[0]?.stmt.replace(" concurrently", ""));
  });

  it("the predicate's three literals appear verbatim in the new function's recent_politics CTE, so the planner can imply the index", () => {
    const pred = /\bwhere\s+(.+);$/i.exec(INDEX_STMT) as RegExpExecArray;
    const literals = (pred[1] as string).split(/\s+and\s+/i);
    expect(literals).toEqual(["task = 'politics'", "jev_prob >= 0.7", "article_id is not null"]);

    const cte = /with recent_politics as materialized \(([\s\S]*?)\),\s*fresh as materialized/i.exec(framingBody130());
    expect(cte, "recent_politics CTE not found").not.toBeNull();
    const cteText = collapse(cte![1] as string);
    for (const lit of literals) {
      expect(cteText, `CTE carries "${lit}"`).toMatch(new RegExp(`(?:\\bp\\.)?${lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`));
    }
    expect(cteText).toMatch(/from public\.jev_shadow_predictions p/);
  });

  it("an invalid index left by an aborted CREATE INDEX CONCURRENTLY aborts the apply with a 130 message", () => {
    const guard = /do\s+\$guard\$([\s\S]*?)\$guard\$\s*;/i.exec(code);
    expect(guard, "guard block (do $guard$ ... $guard$;) not found").not.toBeNull();
    const raw = (guard as RegExpExecArray)[1] as string;
    expect(raw).toContain(`'${INDEX_NAME}'`);
    expect(raw).toMatch(/pg_catalog\.pg_index/i);
    expect(raw).toMatch(/pg_catalog\.pg_class/i);
    expect(raw).toMatch(/relnamespace\s*=\s*'public'::regnamespace/i);
    expect(sansStrings(raw)).toMatch(/\bindisvalid\s*=\s*false\b/i);
    expect(raw).toMatch(/raise\s+exception\s+'130:[^']*drop index concurrently[^']*rebuild[^']*'/i);
    expect(code.search(/do\s+\$guard\$/i)).toBeLessThan(code.search(/create\s+index\s+if\s+not\s+exists/i));
  });

  it("lock_timeout 5s and statement_timeout 60s are set before the create index", () => {
    const create = code.search(/create\s+index\s+if\s+not\s+exists/i);
    expect(code.search(/set\s+local\s+lock_timeout\s*=\s*'5s'/i)).toBeGreaterThanOrEqual(0);
    expect(code.search(/set\s+local\s+lock_timeout\s*=\s*'5s'/i)).toBeLessThan(create);
    expect(code.search(/set\s+local\s+statement_timeout\s*=\s*'60s'/i)).toBeGreaterThanOrEqual(0);
    expect(code.search(/set\s+local\s+statement_timeout\s*=\s*'60s'/i)).toBeLessThan(create);
  });

  it("creates no table, so no new default grants need revoking", () => {
    expect(codeNoStr).not.toMatch(/\bcreate\s+(unlogged\s+|temp\s+|temporary\s+)?table\b/i);
    expect(codeNoStr).not.toMatch(/\balter\s+table\b/i);
  });

  it("does not duplicate or shadow an index from an earlier migration", () => {
    const earlier = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql") && f < MIGRATION_130_FILE)
      .sort();
    const found: string[] = [];
    for (const f of earlier) {
      const c = collapse(stripSqlComments(readFileSync(resolve(MIGRATIONS_DIR, f), "utf8")));
      for (const m of c.matchAll(/create (?:unique )?index (?:concurrently )?(?:if not exists )?(\w+) on (?:public\.)?jev_shadow_predictions\b[^;]*;/gi)) {
        found.push(m[1] as string);
        expect(m[1]).not.toBe(INDEX_NAME);
        expect(m[0], `${m[1]} must not already be the politics-confidence partial index`).not.toMatch(/jev_prob\s*>=\s*0\.7/);
      }
    }
    expect(found).toContain("jev_shadow_predictions_task_created_idx");
  });
});

describe("130 framing_candidate_pool_refresh upsert guard", () => {
  it("keeps 105's signature and attributes, and the same advisory lock", () => {
    const c = tight(code);
    expect(c).toContain(
      "create or replace function public.framing_candidate_pool_refresh() returns integer language plpgsql security definer set search_path = '' as $fn$",
    );
    expect(framingBody130()).toContain("pg_catalog.hashtext('framing_candidate_pool_refresh')::bigint");
    expect(framingBody130()).toContain("pg_catalog.pg_try_advisory_xact_lock(");
  });

  it("the body equals 105's body except for the one added `where ... is distinct from` clause after the do-update set list", () => {
    const b105 = collapse(stripSqlComments(framingBody105()));
    const marker = "refreshed_at = excluded.refreshed_at;";
    expect(b105.split(marker).length - 1, "105 ends its set list with refreshed_at = excluded.refreshed_at;").toBe(1);
    const expected = b105.replace(marker, `refreshed_at = excluded.refreshed_at ${UPSERT_GUARD};`);
    expect(expected).not.toBe(b105);
    const b130 = collapse(stripSqlComments(framingBody130()));
    expect(b130).toBe(expected);
    expect(b130.split(UPSERT_GUARD).length - 1).toBe(1);
  });

  it("the guard compares exactly the columns the pool carries besides its key and refreshed_at", () => {
    const cols = /create table if not exists public\.framing_candidate_pool \(([\s\S]*?)\);/i.exec(code105);
    expect(cols).not.toBeNull();
    const names = (cols![1] as string)
      .split("\n")
      .map((l) => /^\s*(\w+)\s+\w+/.exec(l)?.[1])
      .filter(Boolean);
    expect(names).toEqual(["article_id", "title", "published_at", "refreshed_at"]);
  });

  it("re-asserts 105's revoke and grant verbatim", () => {
    const re = /(revoke all on function public\.framing_candidate_pool_refresh\(\) from [^;]+;|grant execute on function public\.framing_candidate_pool_refresh\(\) to [^;]+;)/gi;
    const in105 = [...code105.matchAll(re)].map((m) => collapse(m[0]));
    const in130 = [...code.matchAll(re)].map((m) => collapse(m[0]));
    expect(in105).toHaveLength(2);
    expect(in130).toEqual(in105);
  });

  it("documents refreshed_at as the last CHANGE time", () => {
    expect(code).toMatch(/comment on column public\.framing_candidate_pool\.refreshed_at is\s+'[^']*last[^']*chang/i);
  });
});

describe("130 executable SQL is additive and writes nothing", () => {
  it("has no drop, truncate, alter or vacuum", () => {
    expect(codeNoStr).not.toMatch(/\bdrop\b/i);
    expect(codeNoStr).not.toMatch(/\btruncate\b/i);
    expect(codeNoStr).not.toMatch(/\balter\b/i);
    expect(codeNoStr).not.toMatch(/\bvacuum\b/i);
  });

  it("rewrites no data outside function bodies: the only top-level insert is the ledger row", () => {
    expect(top).not.toMatch(/\b(update|delete\s+from)\b/i);
    expect(top).not.toMatch(/\binsert\s+into\s+public\./i);
    expect([...top.matchAll(/\binsert\s+into\s+([\w.]+)/gi)].map((m) => m[1])).toEqual(["supabase_migrations.schema_migrations"]);
  });

  it("never runs a refresh at apply time (no top-level select of either refresh function)", () => {
    expect(top).not.toMatch(/\bselect\s+public\.framing_candidate_pool_refresh\s*\(/i);
    expect(top).not.toMatch(/\bselect\s+public\.cluster_topics_refresh\s*\(/i);
    // ... but the cron commands do carry them (the block removal above is not hiding a typo).
    expect(code).toMatch(/\$sql\$\s*select public\.cluster_topics_refresh\(interval '2 hours'\);\s*\$sql\$/);
  });

  it("grants nothing to anon or authenticated: every grant is `execute` to service_role", () => {
    const grants = [...codeNoStr.matchAll(/\bgrant\b[^;]*;/gi)].map((m) => collapse(m[0]));
    expect(grants.length).toBe(2);
    for (const g of grants) expect(g).toMatch(/^grant execute on function [\w.]+\([^)]*\) to service_role;$/i);
    expect(codeNoStr).not.toMatch(/\bgrant\b[^;]*\bto\s+[^;]*\b(anon|authenticated|public)\b/i);
  });

  it("every function it creates is SECURITY DEFINER with search_path = '' and service_role-only", () => {
    const fns = [...tight(code).matchAll(/create or replace function (public\.\w+)\(([^)]*)\)/gi)];
    expect(fns.map((m) => m[1])).toEqual(["public.existing_source_content_hash_pairs", "public.framing_candidate_pool_refresh"]);
    expect([...tight(code).matchAll(/security definer set search_path = ''/gi)]).toHaveLength(2);
  });
});

describe("130 header: documentation", () => {
  it("has the WHY section with the measured production numbers", () => {
    expect(headText).toMatch(/\bWHY\b/);
    expect(headText).toContain("1909717669635125342");
    expect(headText).toContain("-6698768392262014287");
    expect(headText).toContain("-4534788681009065439");
    expect(headText).toContain("-2504668587660639973");
    expect(headText).toMatch(/682,\d{3} calls/);
    expect(headText).toMatch(/164\.8 ms/);
    expect(headText).toMatch(/hit=502/);
    expect(headText).toMatch(/Rows Removed by Filter/);
  });

  it("states DB-seconds per day before and after for each change and in total", () => {
    for (const n of ["2,062", "370", "2,160", "490", "2,001", "864"]) expect(headText).toContain(n);
    expect(headText).toMatch(/6\.2k/);
    expect(headText).toMatch(/1\.7k/);
  });

  it("has STEP 0 with the production definition check (105 parity), cron rows and index inventory facts", () => {
    expect(headText).toMatch(/STEP 0/);
    expect(headText).toMatch(/pg_get_functiondef/);
    expect(headText).toMatch(/105/);
    expect(headText).toMatch(/3-59\/10 \* \* \* \*/);
    expect(headText).toMatch(/\*\/5 \* \* \* \*/);
    expect(headText).toMatch(/jev_shadow_predictions_task_created_idx/);
  });

  it("documents the known delta of the topics split and the shared advisory lock", () => {
    expect(headText).toMatch(/KNOWN DELTA/i);
    expect(headText).toMatch(/60 min/);
    expect(headText).toMatch(/advisory lock/i);
    expect(headText).toMatch(/cluster-topics-refresh-wide/);
  });

  it("has the ORCHESTRATOR PRE-BUILD block with the indisvalid check and the 57014 note", () => {
    expect(head).toContain("ORCHESTRATOR PRE-BUILD (run standalone, outside a transaction, before applying 130)");
    expect(headText).toMatch(/not\s+\w+\.indisvalid|indisvalid\s*=\s*false/i);
    expect(headText).toMatch(/57014/);
    const m = /select c\.relname from pg_catalog\.pg_index i[^;]*;/i.exec(collapse(headText));
    expect(m, "invalid-index check select not found in the header").not.toBeNull();
    expect((m as RegExpExecArray)[0]).toContain(`'${INDEX_NAME}'`);
    expect((m as RegExpExecArray)[0]).toMatch(/not i\.indisvalid/i);
  });

  it("has a read-only VERIFY section, a ROLLBACK section and a DEPLOY ORDER note", () => {
    expect(headText).toMatch(/VERIFY/);
    expect(headText).toMatch(/Index (Only )?Scan using jev_shadow_predictions_politics_conf_idx/);
    expect(headText).toMatch(/ROLLBACK/);
    expect(headText).toMatch(/cron\.schedule\('cluster-topics-refresh', '3-59\/10 \* \* \* \*', \$\$ select public\.cluster_topics_refresh\(interval '36 hours'\); \$\$\)/);
    expect(headText).toMatch(/cron\.unschedule\('cluster-topics-refresh-wide'\)/);
    expect(headText).toMatch(/drop index concurrently if exists jev_shadow_predictions_politics_conf_idx/i);
    expect(headText).toMatch(/drop function if exists public\.existing_source_content_hash_pairs\(uuid\[\], text\[\]\)/i);
    expect(headText).toMatch(/delete from supabase_migrations\.schema_migrations where version = '130'/i);
    expect(headText).toMatch(/--no-verify-jwt/);
    expect(headText).toMatch(/PGRST202/);
  });

  it("has LOCAL PROOF with the plan, the second-apply result and the n_tup_upd delta", () => {
    expect(headText).toMatch(/LOCAL PROOF/);
    expect(headText).toMatch(/already exists, skipping/);
    expect(headText).toMatch(/INSERT 0 0/);
    expect(headText).toMatch(/n_tup_upd/);
    expect(headText).toMatch(/Index (Only )?Scan using jev_shadow_predictions_politics_conf_idx/);
    expect(headText).toMatch(/501 elements|more than 500|> 500/i);
  });

  it("states the migration is additive and safe to re-apply", () => {
    expect(headText).toMatch(/additive/i);
    expect(headText).toMatch(/re-?apply/i);
  });
});
