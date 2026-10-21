import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 101 ("db-hot-paths").
//
// Incident 2026-10-21: the database was starved by slow cron hot paths and by
// bloat (see 100 for pg_net's response log). 101 is the follow-up:
//   (a) cluster_topics_refresh(): the predictions join probes the unique
//       (task, subject_id) index instead of the wide article_id index. The
//       function is re-created byte-for-byte from 067 except for that one join,
//       and this file pins exactly that;
//   (b) a partial index for the blindspot-recall-veto 26 h window (the
//       updated_at half already exists as 064's clusters_blindspot_recall_idx,
//       so only the blindspot_recall_checked_at half is new);
//   (c) a partial covering index for the `live` CTEs of jev_shadow_month_usage
//       and jev_budget_daily (088);
//   (d) autovacuum reloptions on jev_shadow_predictions;
//   (e) public.ops_cron_log_compact(): bounds cron.job_run_details by
//       compacting it (keep the last day) when it passes a size cap, scheduled
//       hourly as 'cron-log-compact'.
//
// The indexes are built by the operator with CREATE INDEX CONCURRENTLY BEFORE
// the migration is applied; the migration's own `create index if not exists`
// is then a no-op. The header lists those statements and this file pins that
// they are identical to the in-file ones.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "supabase", "migrations");
const MIGRATION_101 = resolve(MIGRATIONS_DIR, "101_db_hot_paths.sql");
const MIGRATION_067 = resolve(MIGRATIONS_DIR, "067_cluster_topics.sql");
const MIGRATION_064 = resolve(MIGRATIONS_DIR, "064_jev_cluster_live.sql");

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Blank out every single-quoted string literal (so prose in messages never satisfies a code guard). */
function sansStrings(sql: string): string {
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

/** Comment-free, whitespace-collapsed form, for byte-for-byte preservation checks. */
function norm(sql: string): string {
  return stripSqlComments(sql).replace(/\s+/g, " ").trim();
}

/** Whitespace-collapsed form that keeps the text (used on already comment-free strings). */
function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** The concatenated text of `comment on function public.<name>(...) is '..' '..';`. */
function functionComment(sql: string, name: string): string {
  const m = new RegExp(`comment\\s+on\\s+function\\s+public\\.${name}\\s*\\([^)]*\\)\\s+is([\\s\\S]*?);\\s*\\n`, "i").exec(
    sql,
  );
  if (!m) throw new Error(`comment on function ${name} not found`);
  const parts = [...(m[1] as string).matchAll(/'((?:[^']|'')*)'/g)].map((x) => (x[1] as string).replace(/''/g, "'"));
  return parts.join("");
}

let sql = "";
let code = "";
let codeNoStr = "";
let head = "";
let headText = "";
let sql067 = "";
let code067 = "";
let refreshBlock = "";
let refreshBody = "";
let compactBlock = "";
let compactBody = "";
let compactBodyNoStr = "";

beforeAll(() => {
  sql = readFileSync(MIGRATION_101, "utf8");
  code = stripSqlComments(sql);
  codeNoStr = sansStrings(code);
  head = sql.slice(0, sql.search(/^\s*begin\s*;/im));
  headText = head
    .split("\n")
    .map((l) => l.replace(/^\s*--\s?/, ""))
    .join("\n");
  sql067 = readFileSync(MIGRATION_067, "utf8");
  code067 = stripSqlComments(sql067);
  refreshBlock = functionBlock(code, "cluster_topics_refresh");
  refreshBody = body(refreshBlock);
  compactBlock = functionBlock(code, "ops_cron_log_compact");
  compactBody = stripSqlComments(body(compactBlock));
  compactBodyNoStr = sansStrings(compactBody);
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

describe("101 ledger and structure", () => {
  it("is wrapped in begin/commit and sets lock_timeout 5s / statement_timeout 60s first", () => {
    expect(code).toMatch(/\bbegin\s*;/i);
    expect(code).toMatch(/\bcommit\s*;/i);
    const m = /\bbegin\s*;\s*set\s+local\s+lock_timeout\s*=\s*'5s'\s*;\s*set\s+local\s+statement_timeout\s*=\s*'60s'\s*;/i.exec(
      code,
    );
    expect(m, "begin; must be followed by the two set local timeouts").not.toBeNull();
  });

  it("records itself as version '101'", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(version,\s*name\)\s*values\s*\(\s*'101'\s*,\s*'101_db_hot_paths'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("the ledger insert is the last statement before commit", () => {
    expect(code.trimEnd()).toMatch(/on\s+conflict\s+do\s+nothing\s*;\s*commit\s*;$/i);
  });

  it("sanity: comment stripping and string blanking are non-vacuous", () => {
    expect(sql.length).toBeGreaterThan(code.length);
    expect(code.length).toBeGreaterThan(codeNoStr.length);
  });

  it("creates exactly the two functions, one table setting and the indexes -- nothing else", () => {
    const creates = [...code.matchAll(/create\s+or\s+replace\s+function\s+(public\.[a-z_]+)/gi)].map((m) => m[1]);
    expect(creates).toEqual(["public.cluster_topics_refresh", "public.ops_cron_log_compact"]);
    expect(codeNoStr).not.toMatch(/\bcreate\s+table\b/i);
    // The only DML on public tables is 067's own clusters UPDATE inside the refresh function.
    const outsideFunctions = codeNoStr
      .replace(/create\s+or\s+replace\s+function[\s\S]*?\$fn\$[\s\S]*?\$fn\$\s*;/gi, "")
      .replace(/insert\s+into\s+supabase_migrations\.schema_migrations/gi, "");
    expect(outsideFunctions).not.toMatch(/\b(insert\s+into|update|delete\s+from)\s+public\./i);
    const updates = [...sansStrings(refreshBody).matchAll(/\bupdate\s+([a-z_.]+)/gi)].map((m) => m[1]);
    expect(updates).toEqual(["public.clusters"]);
    expect(compactBodyNoStr).not.toMatch(/\b(insert\s+into|update)\s+public\./i);
    expect(codeNoStr).not.toMatch(/\bvacuum\b/i);
    const alters = [...codeNoStr.matchAll(/\balter\s+table\s+([a-z_.]+)/gi)].map((m) => m[1]);
    expect(alters).toEqual(["public.jev_shadow_predictions"]);
  });

  it("never drops, deletes, or grants to anon/authenticated/public", () => {
    // `on commit drop` (the temp table) is the only legitimate use of the word.
    const noCommitDrop = codeNoStr.replace(/on\s+commit\s+drop/gi, "");
    expect(noCommitDrop).not.toMatch(/\bdrop\b/i);
    expect(codeNoStr).not.toMatch(/\bdelete\s+from\b/i);
    for (const g of code.matchAll(/(^|;)\s*grant\b[^;]*;/gi)) {
      expect(g[0]).not.toMatch(/\bto\b[^;]*\b(anon|authenticated|public)\b/i);
    }
    // Every revoke names the three roles; nothing is revoked from service_role.
    for (const r of code.matchAll(/(^|;)\s*revoke\b[^;]*;/gi)) {
      expect(r[0]).not.toMatch(/\bfrom\b[^;]*\bservice_role\b/i);
    }
  });

  it("never mentions the zone word (zone-parity would count this file as a fifth zone-map copy)", () => {
    expect(sql.toLowerCase()).not.toContain("iktidar");
  });

  it("the header documents the incident, the Step 0 numbers and why the join rewrite is equivalent", () => {
    expect(head).toMatch(/2026-10-21/);
    for (const q of ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"]) expect(head).toContain(q);
    // Q1: the invariant that makes the rewrite safe, and its measured result.
    expect(head).toMatch(/subject_id\s*<>\s*article_id::text/);
    expect(head).toMatch(/unique\s*\(task,\s*subject_id\)/i);
    expect(head).toMatch(/0 violations|violations?\s*=\s*0|bad\s*=\s*0/i);
    // Q3/Q4/Q5/Q6: the facts the other pieces rest on.
    expect(head).toMatch(/941/);
    expect(head).toMatch(/clusters_blindspot_recall_idx/);
    expect(head).toMatch(/79 MB/);
    expect(head).toMatch(/postgres/);
    expect(head).toMatch(/7,?187/);
    // The local-proof summary was pasted in.
    expect(head).toMatch(/LOCAL PROOF/);
    expect(head).toMatch(/symmetric EXCEPT/i);
  });
});

describe("101 (0) invalid-index guard", () => {
  it("raises when a named index exists with indisvalid = false, telling the operator to drop concurrently and rebuild", () => {
    expect(code).toMatch(/pg_catalog\.pg_index/i);
    expect(codeNoStr).toMatch(/\bindisvalid\s*=\s*false\b|\bnot\s+\w+\.indisvalid\b/i);
    expect(code).toMatch(/raise\s+exception\s+'[^']*drop index concurrently[^']*rebuild[^']*'/i);
  });

  it("names every index the migration creates", () => {
    const guard = /do\s+\$guard\$([\s\S]*?)\$guard\$\s*;/i.exec(code);
    expect(guard, "guard block (do $guard$ ... $guard$;) not found").not.toBeNull();
    for (const { name } of indexStatements(code)) {
      expect((guard as RegExpExecArray)[1]).toContain(`'${name}'`);
    }
  });

  it("runs before the first CREATE INDEX and before the function re-creation", () => {
    const guardAt = code.search(/do\s+\$guard\$/i);
    expect(guardAt).toBeGreaterThan(0);
    expect(guardAt).toBeLessThan(code.search(/create\s+index\s+if\s+not\s+exists/i));
    expect(guardAt).toBeLessThan(code.search(/create\s+or\s+replace\s+function/i));
  });
});

describe("101 (a) cluster_topics_refresh: 067 verbatim except the predictions join", () => {
  const OLD_JOIN = "join public.jev_shadow_predictions p on p.article_id = ca.article_id";
  const NEW_JOIN =
    "join public.jev_shadow_predictions p on p.task = 'topic7' and p.subject_id = ca.article_id::text";

  it("the header (signature, returns, language, security definer, search_path) is 067's, normalized", () => {
    const old = functionBlock(code067, "cluster_topics_refresh");
    expect(norm(header(refreshBlock))).toBe(norm(header(old)));
    expect(header(refreshBlock)).toMatch(
      /returns\s+integer\s+language\s+plpgsql\s+security\s+definer\s+set\s+search_path\s*=\s*''/i,
    );
  });

  it("the normalized body equals 067's with the one join string replaced", () => {
    const old = norm(body(functionBlock(code067, "cluster_topics_refresh")));
    const oldOccurrences = old.split(OLD_JOIN).length - 1;
    expect(oldOccurrences, "067 must contain the old join exactly once").toBe(1);
    expect(norm(refreshBody)).toBe(old.replace(OLD_JOIN, NEW_JOIN));
  });

  it("probes by (task, subject_id) and keeps no article_id residual on the predictions side", () => {
    const n = norm(refreshBody);
    expect(n).toContain(NEW_JOIN);
    expect(n).not.toMatch(/\bp\.article_id\b/);
    // The harmless WHERE conjunct stays in place.
    expect(n).toContain("where p.task = 'topic7' and p.jev_choice is not null");
  });

  it("keeps the advisory lock, the IS DISTINCT FROM no-op guard and never writes updated_at", () => {
    const n = norm(refreshBody);
    expect(n).toMatch(/not pg_catalog\.pg_try_advisory_xact_lock\(pg_catalog\.hashtext\('cluster_topics_refresh'\)::bigint\)/);
    expect(n).toMatch(/c\.topic7 is distinct from d\.topic_choice or c\.topic7_p is distinct from d\.topic_p or c\.topic7_n is distinct from d\.confident_n/);
    expect(n).not.toMatch(/updated_at\s*=/);
  });

  it("the CTE comment no longer claims the article_id index and now names the unique (task, subject_id) index", () => {
    const raw = body(functionBlock(sql, "cluster_topics_refresh"));
    expect(raw).not.toMatch(/Bound by the \(article_id\) partial index/);
    expect(raw).toMatch(/unique \(task, subject_id\)/);
  });

  it("re-issues 067's comment on function and appends the Migration 101 sentence", () => {
    const old = functionComment(sql067, "cluster_topics_refresh");
    const now = functionComment(sql, "cluster_topics_refresh");
    const suffix = "Migration 101: the predictions join probes the unique (task, subject_id) index.";
    expect(now.startsWith(old)).toBe(true);
    expect(now).toBe(`${old} ${suffix}`);
  });

  it("revokes from anon/authenticated/public and grants execute to service_role, once each", () => {
    expect(code).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.cluster_topics_refresh\(interval\)\s+from\s+anon,\s*authenticated,\s*public\s*;/i,
    );
    const grants = [...code.matchAll(/grant\s+execute\s+on\s+function\s+public\.cluster_topics_refresh[^;]*;/gi)];
    expect(grants).toHaveLength(1);
    expect(grants[0]?.[0]).toMatch(/\(interval\)\s+to\s+service_role\s*;/i);
  });

  it("does not reschedule the 067 cron job (the schedule is untouched)", () => {
    expect(code).not.toMatch(/cluster-topics-refresh/i);
  });
});

describe("101 (b)(c) indexes: built concurrently by the operator first, then a no-op here", () => {
  it("creates exactly the checked_at blindspot index and the live-marginal covering index", () => {
    const names = indexStatements(code).map((s) => s.name);
    expect(names).toEqual(["clusters_blindspot_checked_idx", "jev_shadow_predictions_live_marginal_idx"]);
  });

  it("does not duplicate 064's clusters_blindspot_recall_idx (updated_at desc where is_blindspot)", () => {
    const sql064 = stripSqlComments(readFileSync(MIGRATION_064, "utf8"));
    expect(collapse(sql064)).toMatch(
      /create index if not exists clusters_blindspot_recall_idx on public\.clusters \(updated_at desc\) where is_blindspot;/,
    );
    expect(code).not.toMatch(/public\.clusters\s*\(\s*updated_at\s+desc\s*\)\s*where\s+is_blindspot/i);
    expect(code).not.toMatch(/clusters_blindspot_updated_idx/i);
  });

  it("pins the exact index definitions", () => {
    const byName = Object.fromEntries(indexStatements(code).map((s) => [s.name, s.stmt]));
    expect(byName["jev_shadow_predictions_live_marginal_idx"]).toBe(
      "create index if not exists jev_shadow_predictions_live_marginal_idx on public.jev_shadow_predictions (created_at) include (input_tokens) where task = 'pair_marginal' and run_id is null;",
    );
    expect(byName["clusters_blindspot_checked_idx"]).toBe(
      "create index if not exists clusters_blindspot_checked_idx on public.clusters (blindspot_recall_checked_at desc) where is_blindspot;",
    );
  });

  it("each in-file `create index if not exists X ...` has the identical `create index concurrently if not exists X ...` in the header", () => {
    const inFile = indexStatements(code);
    const prebuild = prebuildStatements(headText);
    expect(inFile.length).toBeGreaterThan(0);
    // same set (the header lists the big-table build first; order is irrelevant)
    expect(prebuild.map((p) => p.name).sort()).toEqual(inFile.map((i) => i.name).sort());
    expect(prebuild).toHaveLength(inFile.length);
    for (const { name, stmt } of inFile) {
      const expected = stmt.replace("create index if not exists", "create index concurrently if not exists");
      const found = prebuild.find((p) => p.name === name);
      expect(found?.stmt, `pre-build statement for ${name}`).toBe(expected);
    }
  });

  it("has the ORCHESTRATOR PRE-BUILD heading, the indisvalid check and the rollback/kill switches in the header", () => {
    expect(head).toContain("ORCHESTRATOR PRE-BUILD (run each standalone, outside a transaction, before applying 101)");
    expect(headText).toMatch(/indisvalid/);
    expect(headText).toMatch(/not\s+\w+\.indisvalid|indisvalid\s*=\s*false/i);
    expect(headText).toMatch(/drop index concurrently if exists jev_shadow_predictions_live_marginal_idx/i);
    expect(headText).toMatch(/update cron\.job set active\s*=\s*false where jobname\s*=\s*'cron-log-compact'/i);
    expect(headText).toMatch(/alter table public\.jev_shadow_predictions reset \(/i);
    expect(headText).toMatch(/57014/);
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

describe("101 (d) autovacuum reloptions on jev_shadow_predictions", () => {
  it("sets exactly the three scale factors, with the exact values", () => {
    const m = /alter\s+table\s+public\.jev_shadow_predictions\s+set\s*\(([^)]*)\)\s*;/i.exec(code);
    expect(m).not.toBeNull();
    const opts: Record<string, string> = {};
    for (const part of (m as RegExpExecArray)[1]!.split(",")) {
      const kv = /^\s*([a-z_]+)\s*=\s*([0-9.]+)\s*$/i.exec(part);
      expect(kv, `bad reloption fragment: ${part}`).not.toBeNull();
      opts[(kv as RegExpExecArray)[1] as string] = (kv as RegExpExecArray)[2] as string;
    }
    expect(opts).toEqual({
      autovacuum_vacuum_scale_factor: "0.02",
      autovacuum_vacuum_insert_scale_factor: "0.02",
      autovacuum_analyze_scale_factor: "0.01",
    });
  });

  it("leaves articles alone (045 already tunes it)", () => {
    expect(codeNoStr).not.toMatch(/public\.articles/i);
  });
});

describe("101 (e) ops_cron_log_compact: shape and grants", () => {
  it("is plpgsql SECURITY DEFINER, empty search_path, (bigint 150 MiB, interval '1 day'), returns text", () => {
    expect(header(compactBlock)).toMatch(
      /function\s+public\.ops_cron_log_compact\s*\(\s*p_max_bytes\s+bigint\s+default\s+150\s*\*\s*1024\s*\*\s*1024\s*,\s*p_keep\s+interval\s+default\s+interval\s+'1 day'\s*\)\s*returns\s+text\s+language\s+plpgsql\s+security\s+definer\s+set\s+search_path\s*=\s*''/i,
    );
  });

  it("revokes from public/anon/authenticated and grants execute to service_role only, once", () => {
    expect(code).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.ops_cron_log_compact\(bigint,\s*interval\)\s+from\s+public,\s*anon,\s*authenticated\s*;/i,
    );
    const grants = [...code.matchAll(/grant\s+execute\s+on\s+function\s+public\.ops_cron_log_compact[^;]*;/gi)];
    expect(grants).toHaveLength(1);
    expect(grants[0]?.[0]).toMatch(/\(bigint,\s*interval\)\s+to\s+service_role\s*;/i);
  });

  it("has a function comment naming the kill switch", () => {
    expect(sql).toMatch(/comment\s+on\s+function\s+public\.ops_cron_log_compact\(bigint,\s*interval\)\s+is/i);
    expect(functionComment(sql, "ops_cron_log_compact")).toMatch(
      /update cron\.job set active\s*=\s*false where jobname\s*=\s*'cron-log-compact'/i,
    );
  });

  it("schema-qualifies every catalog function it calls (search_path is empty)", () => {
    expect(compactBodyNoStr).not.toMatch(
      /(?<![.\w])(to_regclass|has_table_privilege|pg_total_relation_size|pg_size_pretty|pg_try_advisory_xact_lock|hashtextextended|current_setting|set_config|now|count)\s*\(/i,
    );
    expect(compactBody).toMatch(/pg_catalog\.to_regclass\(\s*'cron\.job_run_details'\s*\)/i);
  });
});

describe("101 (e) ops_cron_log_compact: behaviour contract", () => {
  it("floors: v_max >= 16 MiB (default 150 MiB), v_keep clamped to [1 hour, 3 days] (default 1 day)", () => {
    expect(collapse(compactBody)).toMatch(
      /v_max\s+bigint\s*:=\s*greatest\(\s*coalesce\(\s*p_max_bytes\s*,\s*150 \* 1024 \* 1024\s*\)\s*,\s*16 \* 1024 \* 1024\s*\)/i,
    );
    expect(collapse(compactBody)).toMatch(
      /v_keep\s+interval\s*:=\s*least\(\s*greatest\(\s*coalesce\(\s*p_keep\s*,\s*interval '1 day'\s*\)\s*,\s*interval '1 hour'\s*\)\s*,\s*interval '3 days'\s*\)/i,
    );
  });

  it("no-ops with the documented skip messages when pg_cron is absent or privileges are missing", () => {
    expect(compactBody).toMatch(/v_rel\s+is\s+null[\s\S]*?return\s+'skipped: no pg_cron'/i);
    expect(compactBody).toMatch(
      /not\s+pg_catalog\.has_table_privilege\(\s*v_rel\s*,\s*'TRUNCATE'\s*\)[\s\S]*?return\s+'skipped: no truncate privilege'/i,
    );
    expect(compactBody).toMatch(
      /not\s+pg_catalog\.has_table_privilege\(\s*v_rel\s*,\s*'INSERT'\s*\)\s+or\s+not\s+pg_catalog\.has_table_privilege\(\s*v_rel\s*,\s*'SELECT'\s*\)[\s\S]*?return\s+'skipped: no insert privilege'/i,
    );
  });

  it("takes a transaction-scoped try-advisory lock keyed on hashtextextended('ops_cron_log_compact', 0)", () => {
    expect(collapse(compactBody)).toMatch(
      /not pg_catalog\.pg_try_advisory_xact_lock\(\s*pg_catalog\.hashtextextended\(\s*'ops_cron_log_compact'\s*,\s*0\s*\)\s*\)\s*then\s+return\s+'skipped: busy'/i,
    );
  });

  it("compares the total relation size strictly against v_max; 'ok <size>' under, 'compacted <size>, kept <n>' over", () => {
    expect(compactBody).toMatch(/pg_catalog\.pg_total_relation_size\(\s*v_rel\s*\)/i);
    expect(compactBody).toMatch(/v_size\s*>\s*v_max/i);
    expect(compactBody).not.toMatch(/v_size\s*>=\s*v_max/i);
    expect(collapse(compactBody)).toMatch(/'ok '\s*\|\|\s*pg_catalog\.pg_size_pretty\(\s*v_size\s*\)/i);
    expect(collapse(compactBody)).toMatch(
      /'compacted '\s*\|\|\s*pg_catalog\.pg_size_pretty\(\s*v_size\s*\)\s*\|\|\s*', kept '\s*\|\|\s*v_kept::text/i,
    );
    expect(compactBody).toMatch(/get\s+diagnostics\s+v_kept\s*=\s*row_count/i);
  });

  it("sets lock_timeout = 20s locally before the lock, and restores the caller's value", () => {
    expect(compactBody).toMatch(/set\s+local\s+lock_timeout\s*=\s*'20s'\s*;/i);
    expect(compactBody.search(/set\s+local\s+lock_timeout/i)).toBeLessThan(compactBody.search(/^\s*lock\s+table\b/im));
    expect(compactBody).toMatch(/v_prev_lt\s+text\b/i);
    expect(compactBody).toMatch(/pg_catalog\.set_config\(\s*'lock_timeout'\s*,\s*v_prev_lt\s*,\s*true\s*\)/i);
  });

  it("over the cap: lock table (access exclusive), then copy the kept rows to a temp table, truncate once, reinsert", () => {
    const n = collapse(compactBody);
    expect(n).toMatch(/lock table cron\.job_run_details in access exclusive mode;/i);
    expect(n).toMatch(
      /create temp table ops_cron_keep on commit drop as select \* from cron\.job_run_details where start_time >= pg_catalog\.now\(\) - v_keep;/i,
    );
    expect(n).toMatch(/truncate table cron\.job_run_details;/i);
    expect(n).toMatch(/insert into cron\.job_run_details select \* from pg_temp\.ops_cron_keep;/i);
    const at = (re: RegExp) => compactBody.search(re);
    const order = [
      at(/^\s*lock\s+table\b/im),
      at(/create\s+temp\s+table\s+ops_cron_keep/i),
      at(/^\s*truncate\b/im),
      at(/insert\s+into\s+cron\.job_run_details/i),
    ];
    expect(order.every((p) => p > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("truncates exactly cron.job_run_details, once: no CASCADE, no identity reset, no other relation", () => {
    const truncates = [...compactBody.matchAll(/^\s*truncate\b[^;]*;/gim)].map((m) => collapse(m[0]));
    expect(truncates).toEqual(["truncate table cron.job_run_details;"]);
    expect(compactBody).not.toMatch(/truncate[^;]*\b(cascade|restart\s+identity)\b/i);
    // the whole migration truncates exactly once
    expect([...codeNoStr.matchAll(/\btruncate\b/gi)]).toHaveLength(1);
  });

  it("checks every guard before it truncates", () => {
    const at = (re: RegExp) => compactBody.search(re);
    const trunc = at(/^\s*truncate\b/im);
    expect(at(/to_regclass\(/i)).toBeLessThan(trunc);
    expect(at(/has_table_privilege\(\s*v_rel\s*,\s*'TRUNCATE'/i)).toBeLessThan(trunc);
    expect(at(/has_table_privilege\(\s*v_rel\s*,\s*'INSERT'/i)).toBeLessThan(trunc);
    expect(at(/pg_try_advisory_xact_lock\(/i)).toBeLessThan(trunc);
    expect(at(/pg_total_relation_size\(/i)).toBeLessThan(trunc);
    expect(at(/v_size\s*>\s*v_max/i)).toBeLessThan(trunc);
  });

  it("handles ONLY the lock timeout (55P03): no raise exception, no 'when others'", () => {
    expect(compactBodyNoStr).not.toMatch(/\braise\s+exception\b/i);
    expect(compactBodyNoStr).not.toMatch(/\bwhen\s+others\b/i);
    const handlers = [...compactBodyNoStr.matchAll(/\bexception\s+when\s+([a-z_0-9' ]+?)\s+then/gi)].map((m) =>
      (m[1] as string).toLowerCase(),
    );
    expect(handlers).toHaveLength(1);
    expect(handlers[0]).toMatch(/^(lock_not_available|sqlstate '55p03')$/);
    expect(compactBody).toMatch(/exception\s+when\s+lock_not_available\s+then[\s\S]*?raise\s+log[\s\S]*?'skipped: lock'/i);
  });

  it("the truncate sits inside the block guarded by that handler", () => {
    const trunc = compactBody.search(/^\s*truncate\b/im);
    const handler = compactBody.search(/exception\s+when\s+lock_not_available/i);
    const innerBegin = compactBody.lastIndexOf("begin", trunc);
    expect(innerBegin).toBeGreaterThan(compactBody.search(/set\s+local\s+lock_timeout/i));
    expect(trunc).toBeLessThan(handler);
  });
});

/** `cron.schedule( <args up to and including the closing $sql$> )` -- group 1 is the args. */
const SCHEDULE_CALL = /\bcron\.schedule\s*\(([\s\S]*?\$sql\$[\s\S]*?\$sql\$)\s*\)\s*;/i;

describe("101 pg_cron schedule", () => {
  it("schedules cron-log-compact hourly at :35, idempotently, skipping when pg_cron is absent", () => {
    expect(code).toMatch(/do\s+\$\$[\s\S]*?end\s+\$\$\s*;/i);
    expect(code).toMatch(/extname\s*=\s*'pg_cron'/i);
    expect(code).toMatch(
      /if\s+exists\s*\(\s*select\s+1\s+from\s+cron\.job\s+where\s+jobname\s*=\s*'cron-log-compact'\s*\)\s+then\s+perform\s+cron\.unschedule\(\s*'cron-log-compact'\s*\)\s*;\s*end\s+if\s*;/i,
    );
    expect([...code.matchAll(/\bcron\.schedule\s*\(/gi)]).toHaveLength(1);
    const call = (SCHEDULE_CALL.exec(code)?.[1] ?? "") as string;
    expect(call).toMatch(/^\s*'cron-log-compact'\s*,\s*'35 \* \* \* \*'/);
    expect(call).toMatch(/select\s+public\.ops_cron_log_compact\(\)\s*;/i);
  });

  it("raises the statement timeout above the 20 s lock_timeout so 55P03 (not 57014) is the failure mode", () => {
    const call = (SCHEDULE_CALL.exec(code)?.[1] ?? "") as string;
    const m = /set\s+statement_timeout\s*=\s*'(\d+)(s|min)'/i.exec(call);
    expect(m).not.toBeNull();
    const seconds = Number(m?.[1]) * (m?.[2] === "min" ? 60 : 1);
    expect(seconds).toBeGreaterThan(20);
  });

  it("does not touch any other cron job", () => {
    const names = [...code.matchAll(/jobname\s*=\s*'([^']+)'/gi)].map((m) => m[1]);
    expect(new Set(names)).toEqual(new Set(["cron-log-compact"]));
  });
});
