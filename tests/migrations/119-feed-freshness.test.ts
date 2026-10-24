import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { BIAS_TO_ZONE, ZONE_KEYS } from "../../supabase/functions/_shared/cluster/blindspot";
import { VOTING_SOURCE_KINDS } from "../../supabase/functions/_shared/cluster/source-kind";
import { FUTURE_ITEM_TOLERANCE_MS } from "../../supabase/functions/_shared/rss/feed-freshness";
import { FEED_YIELD_WINDOW_MS } from "../../src/lib/clusters/feed-health";
import {
  classifySilence,
  FROZEN_FEED_MS,
  SILENCE_REASON_LABEL,
  type SilenceReason,
} from "../../src/lib/sources/silence-reason";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 119 ("feed-freshness").
//
// A frozen feed (HTTP 200, but the newest item never changes: haberport,
// korkusuz and en-politik on 2026-10-24) and a quiet outlet look the same to
// sources_newly_dark: no articles in 24 hours. 119 gives ingest two new columns
// on public.sources (fetch_newest_item_at, fetch_items_count), lets the batched
// writer ingest_set_source_fetch_state carry them, and re-creates
// ops_health_report() so row 13 labels every silent source: `erişim yok` (the
// feed could not be fetched), `akış donmuş` (it answers, but the newest item is
// over 72 hours old or the feed is empty), or `sessiz` (it is current).
//
// This file pins:
//   * the migration is additive, grants nothing to anon/authenticated/public,
//     and ends with the ledger row in the 095 pattern;
//   * ingest_set_source_fetch_state keeps 074's seven assignments byte for byte
//     and adds the two new ones WITHOUT a bare least() (least(NULL, x) = x
//     would mark every undated feed as fresh, the trap 074 documents);
//   * ops_health_report() is 115's body with rows 1-12 byte-identical and row 13
//     changed by an explicit list of replacements;
//   * the TypeScript twins (src/lib/sources/silence-reason.ts and the edge
//     helper) agree with the SQL: the 72 h frozen threshold, the 10 minute future
//     tolerance, the labels and the order of the checks.
// The last block (opt-in, TAYF_PSQL) runs the labels and the writer against
// fixtures in rolled-back transactions on a throwaway Postgres with 114, 115
// and 119 applied. Its helpers are copied from 115's test, not imported.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const MIGRATION_119 = resolve(MIGRATIONS_DIR, "119_feed_freshness.sql");
const MIGRATION_115 = resolve(MIGRATIONS_DIR, "115_sources_newly_dark_24h.sql");
const MIGRATION_074 = resolve(MIGRATIONS_DIR, "074_ingest_fixes.sql");

const CHECK_13 = "sources_newly_dark";

const ROW_NAMES_13 = [
  "cron_failed_runs_30m",
  "edge_http_errors_30m",
  "ingest_cycles_30m",
  "ingest_fresh_iktidar_min",
  "ingest_fresh_bagimsiz_min",
  "ingest_fresh_muhalefet_min",
  "jev_shadow_last_run_min",
  "blindspot_veto_cron_min",
  "jev_alerts_unacked_72h",
  "dead_feeds",
  "net_response_heap_mb",
  "jev_shadow_cron_failures_30m",
  "sources_newly_dark",
];

// The SQL labels, in the order the CASE evaluates them.
const LABEL_ORDER: ReadonlyArray<SilenceReason> = ["erisim_yok", "akis_donmus", "sessiz"];

/** The reason CASE of row 13, exactly as the spec writes it (whitespace-normalised). */
const REASON_CASE =
  "case when (s.fetch_quarantined_until is not null and s.fetch_quarantined_until > v_now) or coalesce(s.fetch_fail_streak,0) > 0 or s.fetch_last_status is null or not (s.fetch_last_status between 200 and 299 or s.fetch_last_status = 304) then 'erişim yok' when s.fetch_items_count = 0 or s.fetch_newest_item_at < v_now - interval '72 hours' then 'akış donmuş' else 'sessiz' end";

// What 119 changes in 115's row 13, as exact string pairs over the comment-free,
// whitespace-collapsed text. Nothing else in the row may differ.
const REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  [
    "with vs as (select s.id, s.slug from public.sources s where",
    `with vs as (select s.id, s.slug, ${REASON_CASE} as reason from public.sources s where`,
  ],
  [
    "pg_catalog.string_agg(v.slug || ' (' || c.prior_n::text || ')', ', ' order by",
    "pg_catalog.string_agg(v.slug || ' (' || c.prior_n::text || ') · ' || v.reason, ', ' order by",
  ],
];

const MARKER_115 = "-- 13. sources_newly_dark (migration 114; window 24 h since 115)\n";
const MARKER_119 = "-- 13. sources_newly_dark (migration 114; window 24 h since 115; reason labels since 119)\n";

const DETAIL_PREFIX = "son 24 saatte haber gelmedi (önceki 14 günde en az 50 haber vardı): ";

const NEW_ASSIGNMENTS = [
  "fetch_newest_item_at = case when r.fetch_items_count is null then s.fetch_newest_item_at when r.fetch_newest_item_at is null then null else least(r.fetch_newest_item_at, pg_catalog.now() + interval '10 minutes') end",
  "fetch_items_count = case when r.fetch_items_count is null then s.fetch_items_count else greatest(r.fetch_items_count, 0) end",
];

function applyReplacements(text: string): string {
  let out = text;
  for (const [from, to] of REPLACEMENTS) out = out.split(from).join(to);
  return out;
}

function stripSqlComments(sql: string): string {
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

/** The `create or replace function public.<name>(...) ... $$ ... $$;` block. */
function dollarBlock(sql: string, name: string): string {
  const re = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\([\\s\\S]*?\\bas\\s+\\$\\$[\\s\\S]*?\\$\\$\\s*;`,
    "i",
  );
  const m = sql.match(re);
  if (!m) throw new Error(`function ${name} not found`);
  return m[0];
}

/** Everything before `as $fn$` / `as $$`: signature, return shape, attributes. */
function header(block: string): string {
  const idx = block.search(/\bas\s+\$[a-z]*\$/i);
  return block.slice(0, idx);
}

/** Only the SQL body between the $fn$ quotes. */
function body(block: string): string {
  const m = block.match(/\$fn\$([\s\S]*?)\$fn\$/);
  if (!m || m[1] === undefined) throw new Error("no $fn$ body");
  return m[1];
}

/** Only the SQL body between the $$ quotes. */
function dollarBody(block: string): string {
  const m = block.match(/\bas\s+\$\$([\s\S]*?)\$\$/i);
  if (!m || m[1] === undefined) throw new Error("no $$ body");
  return m[1];
}

/** Comment-free, whitespace-collapsed form, for byte-for-byte preservation checks. */
function norm(sql: string): string {
  return stripSqlComments(sql).replace(/\s+/g, " ").trim();
}

/** The declare section of a plpgsql body, whitespace-normalised. */
function declareSection(fnBody: string): string {
  const m = /\bdeclare\b([\s\S]*?)\bbegin\b/i.exec(stripSqlComments(fnBody));
  if (!m) throw new Error("no declare section");
  return norm(m[1] as string);
}

/** A function body split at every `check_name :=`; index 0 is the preamble. */
function segments(fnBody: string): string[] {
  return stripSqlComments(fnBody).split(/check_name\s*:=/);
}

/** The check a segment belongs to: its literal name, or the loop expression. */
function segmentName(seg: string): string {
  const m = /^\s*'([a-z0-9_]+)'\s*;/i.exec(seg);
  return m ? (m[1] as string) : (/^\s*([^;]+);/.exec(seg)?.[1] ?? "").trim();
}

function segmentFor(fnBody: string, name: string): string {
  const seg = segments(fnBody)
    .slice(1)
    .find((s) => segmentName(s) === name);
  if (!seg) throw new Error(`segment ${name} not found`);
  return seg;
}

/** The function body between the two `$fn$` quotes of the raw file, comments kept. */
function rawFunctionBody(src: string): string {
  expect([...src.matchAll(/\$fn\$/g)]).toHaveLength(2);
  const start = src.indexOf("$fn$") + "$fn$".length;
  return src.slice(start, src.indexOf("$fn$", start));
}

/** Splits a raw body at its row-13 marker comment into [rows 1-12, row 13 and the tail]. */
function splitAtRow13(rawBody: string): [string, string] {
  const idx = rawBody.indexOf("-- 13. sources_newly_dark");
  expect(idx, "row 13 marker comment").toBeGreaterThan(0);
  return [rawBody.slice(0, idx), rawBody.slice(idx)];
}

/** The `update ... set <assignments>` text of a writer body, raw. */
function rawAssignments(dollarFnBody: string): string {
  const start = dollarFnBody.indexOf("set fetch_etag");
  const end = dollarFnBody.indexOf("from pg_catalog.jsonb_to_recordset");
  expect(start, "set fetch_etag").toBeGreaterThan(0);
  expect(end, "from jsonb_to_recordset").toBeGreaterThan(start);
  return dollarFnBody.slice(start, end);
}

/** The `as r( ... )` column list of the jsonb_to_recordset call, normalised. */
function recordsetColumns(dollarFnBody: string): string {
  const m = /jsonb_to_recordset\(p_rows\)\s+as\s+r\(([\s\S]*?)\)\s*where/i.exec(dollarFnBody);
  if (!m) throw new Error("no recordset column list");
  return norm(m[1] as string);
}

let sql = "";
let code = "";
let codeOutsideFns = "";
let healthBlock = "";
let healthBody = "";
let healthCode = "";
let sql115 = "";
let block115 = "";
let body115 = "";
let ingestBlock = "";
let ingestBody = "";
let sql074 = "";
let block074 = "";
let body074 = "";

beforeAll(() => {
  sql = readFileSync(MIGRATION_119, "utf8");
  code = stripSqlComments(sql);
  healthBlock = functionBlock(code, "ops_health_report");
  healthBody = body(healthBlock);
  healthCode = stripSqlComments(healthBody);
  ingestBlock = dollarBlock(code, "ingest_set_source_fetch_state");
  ingestBody = dollarBody(ingestBlock);
  codeOutsideFns = code.replace(healthBlock, "").replace(ingestBlock, "");
  sql115 = readFileSync(MIGRATION_115, "utf8");
  block115 = functionBlock(stripSqlComments(sql115), "ops_health_report");
  body115 = body(block115);
  sql074 = readFileSync(MIGRATION_074, "utf8");
  block074 = dollarBlock(stripSqlComments(sql074), "ingest_set_source_fetch_state");
  body074 = dollarBody(block074);
});

describe("119 ledger, structure and header", () => {
  it("is one transaction: begin, set local lock_timeout = '5s', ..., ledger insert, commit", () => {
    expect([...code.matchAll(/^\s*begin\s*;/gim)]).toHaveLength(1);
    expect([...code.matchAll(/^\s*commit\s*;/gim)]).toHaveLength(1);
    expect(code).toMatch(/begin\s*;\s*set\s+local\s+lock_timeout\s*=\s*'5s'\s*;/i);
    const ledger = code.search(/insert\s+into\s+supabase_migrations\.schema_migrations/i);
    expect(ledger).toBeGreaterThan(code.search(/grant\s+execute\s+on\s+function\s+public\.ops_health_report/i));
    expect(ledger).toBeLessThan(code.search(/^\s*commit\s*;/im));
    // nothing but the commit follows the ledger insert
    const afterLedger = code.slice(ledger).replace(/^[\s\S]*?on\s+conflict\s+do\s+nothing\s*;/i, "");
    expect(afterLedger.trim()).toBe("commit;");
    expect([...code.matchAll(/insert\s+into\s+supabase_migrations\.schema_migrations/gi)]).toHaveLength(1);
  });

  it("records itself as version '119' in the 095 pattern", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(version,\s*name\)\s*values\s*\(\s*'119'\s*,\s*'119_feed_freshness'\s*\)\s*on\s+conflict\s+do\s+nothing\s*;\s*commit\s*;\s*$/i,
    );
  });

  it("sanity: comment stripping is non-vacuous", () => {
    expect(sql.length).toBeGreaterThan(code.length);
  });

  it("runs in the order columns, writer, ops_health_report, ledger", () => {
    const alter = code.search(/alter\s+table\s+public\.sources/i);
    const comments = code.search(/comment\s+on\s+column\s+public\.sources\.fetch_newest_item_at/i);
    const writer = code.search(/create\s+or\s+replace\s+function\s+public\.ingest_set_source_fetch_state/i);
    const writerGrant = code.search(/grant\s+execute\s+on\s+function\s+public\.ingest_set_source_fetch_state/i);
    const health = code.search(/create\s+or\s+replace\s+function\s+public\.ops_health_report/i);
    const healthGrant = code.search(/grant\s+execute\s+on\s+function\s+public\.ops_health_report/i);
    const ledger = code.search(/insert\s+into\s+supabase_migrations\.schema_migrations/i);
    expect(alter).toBeGreaterThan(0);
    expect(comments).toBeGreaterThan(alter);
    expect(writer).toBeGreaterThan(comments);
    expect(writerGrant).toBeGreaterThan(writer);
    expect(health).toBeGreaterThan(writerGrant);
    expect(healthGrant).toBeGreaterThan(health);
    expect(ledger).toBeGreaterThan(healthGrant);
  });

  it("the header documents WHY, Step 0, the dry runs, rollback and idempotence", () => {
    const head = sql.slice(0, sql.search(/^\s*begin\s*;/im));
    expect(head).toMatch(/WHY/);
    expect(head).toMatch(/STEP 0/);
    expect(head).toMatch(/DRY RUNS? \(×2\)/);
    expect(head).toMatch(/ROLLBACK/);
    expect(head).toMatch(/safe to re-apply/i);
    // what the migration does
    expect(head).toMatch(/WHAT CHANGES/);
    for (const word of ["haberport", "korkusuz", "en-politik", "akış donmuş", "erişim yok", "sessiz"]) {
      expect(head, word).toContain(word);
    }
    // Step 0 facts recorded: the prod function hashes match the bodies of 115 and 074
    expect(head).toContain("fa1acc6711da972923b7a2dcd48e8b03");
    expect(head).toContain("5d0afd3467ed8578b960c5b1871a3036");
    expect(head).toMatch(/Version 119 is free/i);
    // dry runs: the checks the spec asks for
    expect(head).toMatch(/13 rows/);
    expect(head).toMatch(/has_column_privilege/);
    expect(head).toMatch(/service_role only/i);
    // the deploy order and the bootstrap
    expect(head).toMatch(/APPLY 119, THEN DEPLOY ingest/);
    expect(head).toMatch(/bootstrap/i);
    // rollback restores the previous bodies
    expect(head).toContain("115_sources_newly_dark_24h.sql");
    expect(head).toContain("074_ingest_fixes.sql");
    expect(head).toMatch(/ledger row 119/i);
  });
});

describe("119 additive shape", () => {
  it("adds exactly the two nullable columns, no default, no not null, one alter", () => {
    const alters = [...code.matchAll(/\balter\b[^;]*;/gi)].map((m) => norm(m[0]));
    expect(alters).toEqual([
      "alter table public.sources add column if not exists fetch_newest_item_at timestamptz, add column if not exists fetch_items_count integer;",
    ]);
  });

  it("comments both columns", () => {
    for (const col of ["fetch_newest_item_at", "fetch_items_count"]) {
      expect(code, col).toMatch(new RegExp(`comment\\s+on\\s+column\\s+public\\.sources\\.${col}\\s+is\\s+'`, "i"));
    }
  });

  it("outside the two function blocks: no table, drop, delete, truncate, vacuum, update, cron or other insert", () => {
    expect(codeOutsideFns).not.toMatch(/\bcreate\s+table\b/i);
    expect(codeOutsideFns).not.toMatch(/\bcreate\s+(unique\s+)?index\b/i);
    expect(codeOutsideFns).not.toMatch(/\bdrop\b/i);
    expect(codeOutsideFns).not.toMatch(/\bdelete\b/i);
    expect(codeOutsideFns).not.toMatch(/\btruncate\b/i);
    expect(codeOutsideFns).not.toMatch(/\bvacuum\b/i);
    expect(codeOutsideFns).not.toMatch(/\bupdate\b/i);
    expect(codeOutsideFns).not.toMatch(/\bcron\.(un)?schedule\s*\(/i);
    const inserts = [...codeOutsideFns.matchAll(/insert\s+into\s+([a-z_.]+)/gi)].map((m) => m[1]);
    expect(inserts).toEqual(["supabase_migrations.schema_migrations"]);
  });

  it("the only creates are the two re-created functions (split at `(` so a signature is not read as part of it)", () => {
    const creates = [...code.matchAll(/\bcreate\b[^;(]*/gi)].map((m) => norm(m[0]));
    expect(creates).toEqual([
      "create or replace function public.ingest_set_source_fetch_state",
      "create or replace function public.ops_health_report",
    ]);
  });

  it("does not touch ops_dark_source_baseline (114's table) other than reading it in row 13", () => {
    expect(code).not.toMatch(
      /\b(insert\s+into|update|delete\s+from|truncate(?:\s+table)?)\s+(?:only\s+)?public\.ops_dark_source_baseline\b/i,
    );
    expect(code).not.toMatch(/\b(create|alter|drop)\s+table\b[^;]*ops_dark_source_baseline/i);
    expect(healthCode).toMatch(/from\s+public\.ops_dark_source_baseline\s+b\b/i);
  });

  it("only the writer function writes public.sources, and only through its UPDATE", () => {
    expect(healthCode).not.toMatch(/\b(insert|update|delete|truncate)\b/i);
    expect(norm(ingestBody)).toMatch(/^declare v_changed integer; begin update public\.sources s set /);
    expect([...ingestBody.matchAll(/\bupdate\b/gi)]).toHaveLength(1);
    expect(ingestBody).not.toMatch(/\b(insert|delete|truncate)\b/i);
  });
});

describe("119 grant surface: nothing for anon, authenticated or public", () => {
  it("revokes execute from anon/authenticated/public on both functions, and nothing else", () => {
    const revokes = [...code.matchAll(/\brevoke\b[^;]*;/gi)].map((m) => norm(m[0]));
    expect(revokes).toEqual([
      "revoke execute on function public.ingest_set_source_fetch_state(jsonb) from anon, authenticated, public;",
      "revoke all on function public.ops_health_report() from public, anon, authenticated;",
    ]);
  });

  it("has exactly two grants: execute on each function to service_role", () => {
    const allGrants = [...code.matchAll(/(^|;)\s*grant\b[^;]*;/gi)].map((m) => norm(m[0].replace(/^;/, "")));
    expect(allGrants).toEqual([
      "grant execute on function public.ingest_set_source_fetch_state(jsonb) to service_role;",
      "grant execute on function public.ops_health_report() to service_role;",
    ]);
  });

  it("no grant reaches anon, authenticated or public, none is a table or column grant, none carries a write privilege", () => {
    for (const g of [...code.matchAll(/(^|;)\s*grant\b[^;]*;/gi)].map((m) => m[0])) {
      expect(g).not.toMatch(/\bto\b[^;]*\b(anon|authenticated|public)\b/i);
      expect(g).not.toMatch(/\b(insert|update|delete|truncate|maintain|references|trigger|all)\b/i);
      expect(g).toMatch(/\bon\s+function\b/i);
      expect(g).toMatch(/\bto\s+service_role\s*;/i);
    }
    expect(code).not.toMatch(/\bgrant\b[^;]*\bon\s+(table\s+)?public\.sources\b/i);
    expect(code).not.toMatch(/\bgrant\b[^;]*\([^)]*fetch_/i);
    expect(code).not.toMatch(/\balter\s+default\s+privileges\b/i);
  });
});

describe("119 ingest_set_source_fetch_state: 074's writer plus the two freshness keys", () => {
  it("keeps 074's signature, language, SECURITY DEFINER, empty search_path and $$ quoting", () => {
    expect(norm(header(ingestBlock))).toBe(norm(header(block074)));
    expect(header(ingestBlock)).toMatch(
      /function\s+public\.ingest_set_source_fetch_state\s*\(\s*p_rows\s+jsonb\s*\)\s*returns\s+integer\s+language\s+plpgsql\s+security\s+definer\s+set\s+search_path\s*=\s*''/i,
    );
    expect(ingestBlock).toMatch(/\bas\s+\$\$/i);
  });

  it("the seven existing assignments are 074's, byte for byte", () => {
    const a074 = rawAssignments(dollarBody(dollarBlock(sql074, "ingest_set_source_fetch_state")));
    const a119 = rawAssignments(dollarBody(dollarBlock(sql, "ingest_set_source_fetch_state")));
    expect(a074.length).toBeGreaterThan(300);
    expect(a074).toContain("fetch_quarantined_until = case");
    // 119's set list starts with 074's, text for text, then continues with the new keys
    expect(a119.startsWith(a074.trimEnd())).toBe(true);
    expect(norm(a074).split(/,\s+fetch_/).length).toBe(7);
  });

  it("adds the two new assignments, exactly, after the seven", () => {
    const set119 = norm(rawAssignments(dollarBody(dollarBlock(sql, "ingest_set_source_fetch_state"))));
    const set074 = norm(rawAssignments(dollarBody(dollarBlock(sql074, "ingest_set_source_fetch_state"))));
    expect(set119).toBe(`${set074}, ${NEW_ASSIGNMENTS.join(", ")}`);
  });

  it("never uses a bare least() on fetch_newest_item_at: every least( sits in the else of a CASE", () => {
    const flat = norm(ingestBody);
    const occurrences = [...flat.matchAll(/least\(\s*r\.fetch_newest_item_at/g)];
    expect(occurrences).toHaveLength(1);
    for (const m of occurrences) {
      expect(flat.slice(Math.max(0, (m.index ?? 0) - 5), m.index), "preceded by else").toBe("else ");
    }
    expect(flat).not.toMatch(/fetch_newest_item_at\s*=\s*(pg_catalog\.)?least\(/i);
    expect(flat).toMatch(/fetch_newest_item_at = case when r\.fetch_items_count is null then s\.fetch_newest_item_at when r\.fetch_newest_item_at is null then null else /);
    // the same trap 074 documents for the quarantine column stays closed
    expect(flat).not.toMatch(/fetch_quarantined_until\s*=\s*(pg_catalog\.)?least\(/i);
  });

  it("the jsonb_to_recordset column list is 074's plus the two new keys", () => {
    const cols119 = recordsetColumns(ingestBody);
    const cols074 = recordsetColumns(body074);
    expect(cols074).toContain("fetch_quarantined_until timestamptz");
    expect(cols119).toBe(`${cols074}, fetch_newest_item_at timestamptz, fetch_items_count int`);
  });

  it("the join, row count and return are 074's", () => {
    const tail = (b: string) => norm(b.slice(b.indexOf("where s.id = r.id")));
    expect(tail(ingestBody)).toBe("where s.id = r.id; get diagnostics v_changed = row_count; return v_changed; end;");
    expect(tail(ingestBody)).toBe(tail(body074));
  });

  it("the function comment names the keys, the CASE and the least(null, x) trap", () => {
    const m = /comment\s+on\s+function\s+public\.ingest_set_source_fetch_state\(jsonb\)\s+is([\s\S]*?);\s*\n/i.exec(sql);
    expect(m).not.toBeNull();
    const text = ((m as RegExpExecArray)[1] as string).replace(/'\s*\n\s*'/g, "");
    expect(text).toContain("fetch_newest_item_at");
    expect(text).toContain("fetch_items_count");
    expect(text).toMatch(/least\(null, x\)/);
    expect(text).toMatch(/migration 119/);
    expect(text).toMatch(/Returns rows updated/);
  });
});

describe("119 ops_health_report: signature and safety match 115", () => {
  it("the function header is identical to 115's (plpgsql volatile SECURITY DEFINER, empty search_path, same columns)", () => {
    expect(norm(header(healthBlock))).toBe(norm(header(block115)));
    expect(header(healthBlock)).toMatch(
      /function\s+public\.ops_health_report\s*\(\s*\)[\s\S]*?language\s+plpgsql[\s\S]{0,40}volatile[\s\S]{0,40}security\s+definer[\s\S]{0,40}set\s+search_path\s*=\s*''/i,
    );
  });

  it("the declare section is 115's after norm, and #variable_conflict use_column stays", () => {
    expect(healthCode).toMatch(/#variable_conflict\s+use_column/i);
    expect(declareSection(healthBody)).toBe(declareSection(body115));
  });

  it("is read-only: no writes, truncate, cron.schedule, return_message or cron job-command access", () => {
    expect(healthCode).not.toMatch(/\binsert\b/i);
    expect(healthCode).not.toMatch(/\bupdate\b/i);
    expect(healthCode).not.toMatch(/\bdelete\b/i);
    expect(healthCode).not.toMatch(/\btruncate\b/i);
    expect(healthCode).not.toMatch(/\bcron\.(un)?schedule\s*\(/i);
    expect(healthCode).not.toMatch(/\bcommand\b/i);
    expect(healthCode).not.toMatch(/return_message/i);
    expect(sql).not.toMatch(/return_message/i);
  });
});

describe("119 ops_health_report: 115's body, with only row 13 changed", () => {
  it("has 115's segment count, split at every `check_name :=`", () => {
    expect(segments(healthBody).length).toBe(segments(body115).length);
    expect(segments(healthBody)).toHaveLength(12);
  });

  it("segments 0..n-2 (the preamble and rows 1-12) are 115's after norm", () => {
    const a = segments(healthBody);
    const b = segments(body115);
    for (let i = 0; i < b.length - 1; i++) {
      expect(segmentName(a[i] as string)).toBe(segmentName(b[i] as string));
      expect(norm(a[i] as string), i === 0 ? "preamble" : segmentName(b[i] as string)).toBe(norm(b[i] as string));
    }
  });

  it("the unchanged rows carry real content (the comparison is not vacuous)", () => {
    const a = segments(healthBody);
    expect(a.slice(0, -1).filter((s) => norm(s).length > 300).length).toBeGreaterThanOrEqual(9);
    for (const name of ["cron_failed_runs_30m", "edge_http_errors_30m", "dead_feeds", "jev_shadow_cron_failures_30m"]) {
      expect(norm(segmentFor(healthBody, name)).length, name).toBeGreaterThan(300);
      expect(norm(segmentFor(healthBody, name)), name).toBe(norm(segmentFor(body115, name)));
    }
  });

  it("the raw function body (comments included) is byte-identical to 115's for the header, declare section and rows 1-12", () => {
    const [before119] = splitAtRow13(rawFunctionBody(sql));
    const [before115] = splitAtRow13(rawFunctionBody(sql115));
    expect(before119.length).toBeGreaterThan(10_000);
    expect(before119).toBe(before115);
    expect(before119).toMatch(/#variable_conflict use_column\s+declare/);
  });

  it("row 13 is 115's row 13 with exactly the explicit replacements applied", () => {
    const a = segments(healthBody);
    const b = segments(body115);
    const last115 = norm(b[b.length - 1] as string);
    const last119 = norm(a[a.length - 1] as string);
    expect(segmentName(a[a.length - 1] as string)).toBe(CHECK_13);
    // each replacement bites exactly once, so the transform is not a no-op
    for (const [from] of REPLACEMENTS) {
      expect(last115.split(from).length - 1, from).toBe(1);
    }
    expect(last119).not.toBe(last115);
    expect(last119).toBe(applyReplacements(last115));
  });

  it("the raw row 13 (marker comment included) is 115's with the marker line and the replacements applied, whitespace aside", () => {
    const [, row119] = splitAtRow13(rawFunctionBody(sql));
    const [, row115] = splitAtRow13(rawFunctionBody(sql115));
    expect(row115.startsWith(MARKER_115)).toBe(true);
    expect(row119.startsWith(MARKER_119)).toBe(true);
    const collapse = (t: string) => t.replace(/\s+/g, " ").trim();
    expect(collapse(row119)).toBe(applyReplacements(collapse(row115.replace(MARKER_115, MARKER_119))));
  });

  it("keeps every predicate of row 13: baseline, 50 floor, 24 h windows, threshold 1, warn only, 500-char cut, handler", () => {
    const seg = norm(segmentFor(healthBody, CHECK_13));
    expect(seg.startsWith("'sources_newly_dark'; threshold := 1; observed := null; detail := null; begin")).toBe(true);
    expect(seg).toContain("s.active and s.kind in ('outlet', 'wire')");
    expect(seg).toContain("and not exists (select 1 from public.ops_dark_source_baseline b where b.slug = s.slug)");
    expect(seg).toContain(
      "from public.articles a where a.created_at >= v_now - interval '14 days 24 hours' and a.created_at <= v_now group by a.source_id",
    );
    expect(seg).toContain("pg_catalog.count(*) filter (where a.created_at < v_now - interval '24 hours') as prior_n");
    expect(seg).toContain("pg_catalog.count(*) filter (where a.created_at >= v_now - interval '24 hours') as recent_n");
    expect(seg).toContain("where c.prior_n >= 50 and c.recent_n = 0");
    expect(seg).toContain("status := case when v_n >= 1 then 'warn' else 'pass' end;");
    expect(seg).not.toMatch(/'fail'/);
    expect(seg).not.toMatch(/'skip'/);
    expect(seg).toContain(
      `detail := case when v_n >= 1 then substr('${DETAIL_PREFIX}' || v_text, 1, 500) else 'yeni susan kaynak yok' end;`,
    );
    expect(seg).toContain(
      "exception when others then status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200); end; return next;",
    );
    expect(seg.match(/return next;/g)).toHaveLength(1);
  });

  it("carries the reason CASE exactly once, in the vs CTE, and each entry reads slug (n) · reason", () => {
    const seg = norm(segmentFor(healthBody, CHECK_13));
    expect(seg.split(REASON_CASE).length - 1).toBe(1);
    expect(seg).toContain(`${REASON_CASE} as reason from public.sources s`);
    expect(seg).toContain("v.slug || ' (' || c.prior_n::text || ') · ' || v.reason");
    // the 115 fixture assertions look for `slug (n)`; that substring is kept
    expect(seg).toContain("v.slug || ' (' || c.prior_n::text || ')");
  });

  it("the three label literals are present, each once, in the order erişim yok, akış donmuş, sessiz", () => {
    const seg = norm(segmentFor(healthBody, CHECK_13));
    const positions = LABEL_ORDER.map((r) => seg.indexOf(`'${SILENCE_REASON_LABEL[r]}'`));
    expect(positions.every((p) => p > 0)).toBe(true);
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);
    for (const r of LABEL_ORDER) {
      expect(seg.split(`'${SILENCE_REASON_LABEL[r]}'`).length - 1, r).toBe(1);
    }
    expect(seg).toContain("then 'erişim yok'");
    expect(seg).toContain("then 'akış donmuş'");
    expect(seg).toContain("else 'sessiz' end");
  });

  it("the body still ends `end; return next; return; end`, with a single final `return;`", () => {
    const flat = norm(healthBody);
    expect(flat.endsWith("end; return next; return; end")).toBe(true);
    expect([...flat.matchAll(/\breturn;/g)]).toHaveLength(1);
    expect(flat).toMatch(/end; return next; check_name := 'sources_newly_dark';/);
  });

  it("the function comment says (migrations 077, 100, 103, 108, 114, 115, 119): 13 fixed rows, lists the 13 names in order and explains the three labels", () => {
    const comment = /comment\s+on\s+function\s+public\.ops_health_report\(\)\s+is([\s\S]*?);\s*\n/i.exec(sql);
    expect(comment).not.toBeNull();
    const text = (comment as RegExpExecArray)[1] as string;
    expect(text).toMatch(/\(migrations 077, 100, 103, 108, 114, 115, 119\): 13 fixed rows/);
    const positions = ROW_NAMES_13.map((n) => text.indexOf(n));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);
    const tail = text.slice(positions[12] as number);
    expect(tail).toMatch(/warn only|warn-only/i);
    expect(tail).toMatch(/ops_dark_source_baseline/);
    expect(tail).toMatch(/50/);
    expect(tail).toMatch(/24 hours/);
    expect(tail).toMatch(/72 hours old/);
    expect(tail).not.toMatch(/12 hours/);
    for (const label of Object.values(SILENCE_REASON_LABEL)) {
      expect(tail, label).toContain(label);
    }
    expect(tail).toContain("fetch_newest_item_at");
    expect(tail).toContain("fetch_items_count");
    // 108's and 115's semantics are still described
    expect(text).toMatch(/budget_exceeded/);
    expect(text).toMatch(/never reads any potentially secret-bearing pg_cron job field/);
    expect(text).toMatch(/service_role only/);
  });

  it("revokes from public/anon/authenticated and grants execute to service_role, after the comment", () => {
    const comment = code.search(/comment\s+on\s+function\s+public\.ops_health_report/i);
    const revoke = code.search(/revoke\s+all\s+on\s+function\s+public\.ops_health_report/i);
    const grant = code.search(/grant\s+execute\s+on\s+function\s+public\.ops_health_report/i);
    expect(revoke).toBeGreaterThan(comment);
    expect(grant).toBeGreaterThan(revoke);
  });
});

describe("119 TypeScript parity (silence-reason.ts and the edge helper)", () => {
  it("FROZEN_FEED_MS equals the SQL's 72 hours, the same window as dead_feeds and the app's silence gate", () => {
    expect(FROZEN_FEED_MS).toBe(72 * 60 * 60 * 1000);
    expect(FROZEN_FEED_MS).toBe(FEED_YIELD_WINDOW_MS);
    const seg = norm(segmentFor(healthBody, CHECK_13));
    expect(seg).toContain("s.fetch_newest_item_at < v_now - interval '72 hours'");
    expect(norm(segmentFor(healthBody, "dead_feeds"))).toContain("v_now - interval '72 hours'");
  });

  it("the frozen threshold is longer than row 13's own 24 h window: a source listed after 24 h of silence is not frozen by that fact alone", () => {
    const seg = norm(segmentFor(healthBody, CHECK_13));
    const window = [...seg.matchAll(/a\.created_at >= v_now - interval '(\d+) hours'/g)].map((m) => Number(m[1]));
    const frozen = /s\.fetch_newest_item_at < v_now - interval '(\d+) hours'/.exec(seg);
    expect(window).toEqual([24]);
    expect(frozen).not.toBeNull();
    expect(Number((frozen as RegExpExecArray)[1])).toBeGreaterThan(Math.max(...window));
  });

  it("FUTURE_ITEM_TOLERANCE_MS equals the writer's 10 minutes", () => {
    expect(FUTURE_ITEM_TOLERANCE_MS).toBe(10 * 60 * 1000);
    expect(norm(ingestBody)).toContain("pg_catalog.now() + interval '10 minutes'");
  });

  it("the labels equal SILENCE_REASON_LABEL, and the SQL evaluates them in classifySilence's order", () => {
    expect(SILENCE_REASON_LABEL).toEqual({ akis_donmus: "akış donmuş", erisim_yok: "erişim yok", sessiz: "sessiz" });
    const seg = norm(segmentFor(healthBody, CHECK_13));
    const start = seg.indexOf("select s.id, s.slug, case");
    const end = seg.indexOf(" as reason");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const literals = [...seg.slice(start, end).matchAll(/(?:then|else) '([^']+)'/g)].map((m) => m[1]);
    expect(literals).toEqual(LABEL_ORDER.map((r) => SILENCE_REASON_LABEL[r]));
  });

  it("the SQL conditions mirror classifySilence: reachability is 2xx or 304, unknown status is unreachable", () => {
    const seg = norm(segmentFor(healthBody, CHECK_13));
    expect(seg).toContain("s.fetch_last_status between 200 and 299 or s.fetch_last_status = 304");
    expect(seg).toContain("s.fetch_last_status is null");
    expect(seg).toContain("coalesce(s.fetch_fail_streak,0) > 0");
    expect(seg).toContain("s.fetch_quarantined_until > v_now");
    expect(seg).toContain("s.fetch_items_count = 0");
  });

  it("the zmap VALUES pairs deep-equal BIAS_TO_ZONE, the zone loop equals ZONE_KEYS, and every s.kind list equals VOTING_SOURCE_KINDS", () => {
    const span = /zmap\s*\(\s*bias_key\s*,\s*zone\s*\)\s+as\s*\(\s*values([\s\S]*?)\)\s*\n?\s*select/i.exec(healthCode);
    expect(span).not.toBeNull();
    const parsed: Record<string, string> = {};
    const pairRe = /\(\s*'([a-z_]+)'\s*,\s*'([a-z]+)'\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = pairRe.exec((span as RegExpExecArray)[1] as string)) !== null) {
      parsed[m[1] as string] = m[2] as string;
    }
    expect(parsed).toEqual({ ...BIAS_TO_ZONE });
    const loop = /foreach\s+v_zone\s+in\s+array\s+array\s*\[([^\]]+)\]/i.exec(healthCode);
    expect(loop).not.toBeNull();
    expect([...((loop as RegExpExecArray)[1] as string).matchAll(/'([a-z_]+)'/g)].map((x) => x[1])).toEqual([...ZONE_KEYS]);
    const lists = [...healthCode.matchAll(/s\.kind\s+in\s*\(([^)]+)\)/gi)];
    expect(lists).toHaveLength(3);
    for (const l of lists) {
      const kinds = [...(l[1] as string).matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
      expect(new Set(kinds)).toEqual(new Set(VOTING_SOURCE_KINDS));
    }
  });
});

describe("119 secrets", () => {
  it("bakes no secret into the file", () => {
    expect(sql).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(sql).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{20,}/);
  });
});

// ---------------------------------------------------------------------------
// Fixtures shared by the SQL run and the TypeScript mirror. Every source has 60
// articles older than 25 hours and none recent, so row 13 flags all of them and
// the label is the only thing that differs.
// ---------------------------------------------------------------------------

interface Fx {
  slug: string;
  status: number;
  failStreak: number;
  /** hours until fetch_quarantined_until; null = not quarantined */
  quarantinedForHours: number | null;
  /** hours since the newest feed item; null = unmeasured/undated */
  newestAgoHours: number | null;
  count: number | null;
  expected: string;
}

const FIXTURES: readonly Fx[] = [
  { slug: "fx-frozen", status: 200, failStreak: 0, quarantinedForHours: null, newestAgoHours: 100, count: 12, expected: "akış donmuş" },
  { slug: "fx-frozen-73", status: 200, failStreak: 0, quarantinedForHours: null, newestAgoHours: 73, count: 12, expected: "akış donmuş" },
  // a live outlet that paused over a night or a weekend: 25-71 h since its newest item is NOT frozen
  { slug: "fx-paused", status: 200, failStreak: 0, quarantinedForHours: null, newestAgoHours: 30, count: 12, expected: "sessiz" },
  { slug: "fx-paused-71", status: 200, failStreak: 0, quarantinedForHours: null, newestAgoHours: 71, count: 12, expected: "sessiz" },
  { slug: "fx-empty", status: 200, failStreak: 0, quarantinedForHours: null, newestAgoHours: null, count: 0, expected: "akış donmuş" },
  { slug: "fx-blocked", status: 403, failStreak: 0, quarantinedForHours: null, newestAgoHours: 30, count: 12, expected: "erişim yok" },
  { slug: "fx-quar", status: 200, failStreak: 0, quarantinedForHours: 6, newestAgoHours: 30, count: 12, expected: "erişim yok" },
  { slug: "fx-html", status: 200, failStreak: 3, quarantinedForHours: null, newestAgoHours: 30, count: 12, expected: "erişim yok" },
  { slug: "fx-quiet", status: 200, failStreak: 0, quarantinedForHours: null, newestAgoHours: 1, count: 20, expected: "sessiz" },
  { slug: "fx-unmeasured", status: 200, failStreak: 0, quarantinedForHours: null, newestAgoHours: null, count: null, expected: "sessiz" },
];

describe("119 fixtures: the TypeScript classifier agrees with the labels the SQL must give", () => {
  it("classifySilence gives each fixture its expected label", () => {
    const now = Date.parse("2026-10-24T12:00:00.000Z");
    for (const f of FIXTURES) {
      const reason = classifySilence(
        {
          lastHttpStatus: f.status,
          failStreak: f.failStreak,
          quarantined: f.quarantinedForHours !== null,
          newestFeedItemAt: f.newestAgoHours === null ? null : new Date(now - f.newestAgoHours * 3_600_000).toISOString(),
          feedItemsCount: f.count,
        },
        now,
      );
      expect(SILENCE_REASON_LABEL[reason], f.slug).toBe(f.expected);
    }
  });

  it("covers all three labels", () => {
    expect(new Set(FIXTURES.map((f) => f.expected))).toEqual(new Set(Object.values(SILENCE_REASON_LABEL)));
  });
});

// ---------------------------------------------------------------------------
// Live behaviour (opt-in): the labels and the writer against fixtures, on a
// throwaway Postgres with 114, 115 and then 119 applied (twice) and no other
// dark source. TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/PGDATABASE
// select the server. Everything the fixtures write sits inside a transaction
// that is rolled back.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))("119 feed freshness against fixtures (live Postgres)", () => {
  function runPsql(input: string): string {
    return execFileSync(process.env.TAYF_PSQL as string, ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      input,
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8" },
      maxBuffer: 8 * 1024 * 1024,
    });
  }

  const ROW_13 =
    "select check_name, status, observed, threshold, detail from public.ops_health_report() where check_name = 'sources_newly_dark';";

  function parseRow(line: string): { check: string; status: string; observed: string; threshold: string; detail: string } {
    const [check, status, observed, threshold, ...rest] = line.split("|");
    return {
      check: check as string,
      status: status as string,
      observed: observed as string,
      threshold: threshold as string,
      detail: rest.join("|"),
    };
  }

  /** True when articles has a content_hash column (the full schema; the throwaway stub has none). */
  function articlesHaveContentHash(): boolean {
    return (
      runPsql(
        "select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'articles' and column_name = 'content_hash');",
      ).trim() === "t"
    );
  }

  function fixtureSql(withHash: boolean): string {
    const rows = FIXTURES.map((f) => {
      const newest = f.newestAgoHours === null ? "null::timestamptz" : `now() - interval '${f.newestAgoHours} hours'`;
      const quar = f.quarantinedForHours === null ? "null::timestamptz" : `now() + interval '${f.quarantinedForHours} hours'`;
      const count = f.count === null ? "null::integer" : `${f.count}`;
      return `('fx ${f.slug}', '${f.slug}', 'https://${f.slug}.invalid', 'https://${f.slug}.invalid/rss', 'center', 'outlet', true, ${f.status}, ${f.failStreak}, ${quar}, ${newest}, ${count})`;
    }).join(",\n  ");
    const slugs = FIXTURES.map((f) => `('${f.slug}', 60)`).join(", ");
    // 60 articles from 25 h back to 25 h + 59 * 3 h: a full prior window, nothing in the last 24 h
    const ago = "now() - interval '25 hours' - gs.g * interval '3 hours'";
    const hashCol = withHash ? ", content_hash" : "";
    const urlExpr = "'https://fx.invalid/' || s.slug || '/' || gs.g";
    const hashOf = withHash ? `, md5(${urlExpr})` : "";
    return `
begin;
insert into public.sources (name, slug, url, rss_url, bias, kind, active, fetch_last_status, fetch_fail_streak, fetch_quarantined_until, fetch_newest_item_at, fetch_items_count) values
  ${rows};
insert into public.articles (source_id, title, url, published_at, created_at${hashCol})
  select s.id, 'fx ' || s.slug || ' ' || gs.g, ${urlExpr}, ${ago}, ${ago}${hashOf}
    from public.sources s
    join (values ${slugs}) v(slug, n) on v.slug = s.slug
   cross join lateral generate_series(0, v.n - 1) as gs(g);
${ROW_13}
rollback;
`;
  }

  it("the target database runs 119: both columns exist, nullable, and the ledger row is there", () => {
    expect(
      runPsql(
        "select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'sources' and column_name in ('fetch_newest_item_at', 'fetch_items_count') and is_nullable = 'YES' and column_default is null;",
      ).trim(),
    ).toBe("2");
    expect(runPsql("select count(*) from supabase_migrations.schema_migrations where version = '119';").trim()).toBe("1");
  });

  it("row 13 labels every silent source: akış donmuş, erişim yok or sessiz, keeping the `slug (n)` form", () => {
    const lines = runPsql(fixtureSql(articlesHaveContentHash()))
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const row = parseRow(lines[0] as string);
    expect(row.check).toBe(CHECK_13);
    expect(row.status).toBe("warn");
    expect(row.observed).toBe(String(FIXTURES.length));
    expect(row.threshold).toBe("1");
    expect(row.detail.startsWith(DETAIL_PREFIX)).toBe(true);
    const entries = row.detail.slice(DETAIL_PREFIX.length).split(", ");
    expect(entries).toHaveLength(FIXTURES.length);
    const bySlug = new Map<string, string>();
    for (const e of entries) {
      const m = /^(\S+) \((\d+)\) · (.+)$/.exec(e);
      expect(m, e).not.toBeNull();
      expect((m as RegExpExecArray)[2]).toBe("60");
      bySlug.set((m as RegExpExecArray)[1] as string, (m as RegExpExecArray)[3] as string);
    }
    for (const f of FIXTURES) {
      expect(bySlug.get(f.slug), f.slug).toBe(f.expected);
      expect(row.detail, f.slug).toContain(`${f.slug} (60) · ${f.expected}`);
    }
  });

  it("rolled the fixtures back", () => {
    expect(runPsql("select count(*) from public.sources where slug like 'fx-%';").trim()).toBe("0");
    expect(runPsql("select count(*) from public.articles where url like 'https://fx.invalid/%';").trim()).toBe("0");
  });

  it("returns exactly 13 rows, in order, and sources_newly_dark is the last", () => {
    expect(runPsql("select count(*) from public.ops_health_report();").trim()).toBe("13");
    const names = runPsql("select check_name from public.ops_health_report();")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(names).toEqual(ROW_NAMES_13);
  });

  it("anon and authenticated hold no privilege on the new columns; service_role only may execute the two functions", () => {
    for (const col of ["fetch_newest_item_at", "fetch_items_count"]) {
      expect(
        runPsql(
          `select has_column_privilege('anon', 'public.sources', '${col}', 'select'), has_column_privilege('authenticated', 'public.sources', '${col}', 'select'), has_column_privilege('anon', 'public.sources', '${col}', 'update'), has_column_privilege('authenticated', 'public.sources', '${col}', 'update');`,
        ).trim(),
        col,
      ).toBe("f|f|f|f");
    }
    for (const sig of ["public.ops_health_report()", "public.ingest_set_source_fetch_state(jsonb)"]) {
      expect(
        runPsql(
          `select has_function_privilege('anon', '${sig}', 'execute'), has_function_privilege('authenticated', '${sig}', 'execute'), has_function_privilege('service_role', '${sig}', 'execute');`,
        ).trim(),
        sig,
      ).toBe("f|f|t");
    }
  });

  describe("ingest_set_source_fetch_state", () => {
    /** One payload row carrying the seven legacy keys for the fixture source, plus any extra keys. */
    const payload = (extra: string) =>
      `select public.ingest_set_source_fetch_state(jsonb_build_array(jsonb_build_object('id', s.id, 'fetch_etag', 'e2', 'fetch_last_modified', null, 'fetch_body_hash', 'h2', 'fetch_last_status', 200, 'fetch_last_at', now(), 'fetch_fail_streak', 0, 'fetch_quarantined_until', null${extra}))) from public.sources s where s.slug = 'fx-rpc';`;
    const probe = (tag: string) =>
      `select '${tag}', coalesce(fetch_items_count::text, 'null'), coalesce((fetch_newest_item_at = now() - interval '30 hours')::text, 'null'), coalesce((fetch_newest_item_at = now() + interval '10 minutes')::text, 'null'), (fetch_newest_item_at is null)::text from public.sources where slug = 'fx-rpc';`;

    function run(): string[] {
      const out = runPsql(`
begin;
insert into public.sources (name, slug, url, rss_url, bias, kind, active, fetch_last_status, fetch_newest_item_at, fetch_items_count)
  values ('fx rpc', 'fx-rpc', 'https://fx-rpc.invalid', 'https://fx-rpc.invalid/rss', 'center', 'outlet', true, 200, now() - interval '30 hours', 12);
${payload("")}
${probe("keys-omitted")}
${payload(", 'fetch_items_count', 5, 'fetch_newest_item_at', null")}
${probe("count-5-newest-null")}
${payload(", 'fetch_items_count', 7, 'fetch_newest_item_at', to_jsonb(now() + interval '2 days')")}
${probe("future-clamped")}
${payload(", 'fetch_items_count', 9, 'fetch_newest_item_at', to_jsonb(now() - interval '30 hours')")}
${probe("past-kept")}
${payload(", 'fetch_newest_item_at', to_jsonb(now() + interval '1 hour')")}
${probe("newest-without-count")}
${payload(", 'fetch_items_count', -3, 'fetch_newest_item_at', to_jsonb(now() - interval '30 hours')")}
${probe("negative-count")}
${payload(", 'fetch_items_count', 4")}
${probe("count-without-newest")}
rollback;
`);
      return out.split("\n").filter((l) => l.includes("|"));
    }

    let lines: string[] = [];
    beforeAll(() => {
      lines = run();
    });
    const find = (tag: string) => {
      const line = lines.find((l) => l.startsWith(`${tag}|`));
      expect(line, tag).toBeDefined();
      const [, count, isThirtyHoursAgo, isClamped, isNull] = (line as string).split("|");
      return { count, isThirtyHoursAgo, isClamped, isNull };
    };

    it("a payload without the keys keeps the stored count and newest", () => {
      expect(find("keys-omitted")).toEqual({ count: "12", isThirtyHoursAgo: "true", isClamped: "false", isNull: "false" });
    });

    it("count 5 with newest null writes null, not now + 10 minutes (the least(NULL, x) trap)", () => {
      expect(find("count-5-newest-null")).toEqual({ count: "5", isThirtyHoursAgo: "null", isClamped: "null", isNull: "true" });
    });

    it("a newest 2 days in the future is clamped to now + 10 minutes", () => {
      expect(find("future-clamped")).toEqual({ count: "7", isThirtyHoursAgo: "false", isClamped: "true", isNull: "false" });
    });

    it("a past newest is stored as sent", () => {
      expect(find("past-kept")).toEqual({ count: "9", isThirtyHoursAgo: "true", isClamped: "false", isNull: "false" });
    });

    it("a newest without a count changes nothing", () => {
      expect(find("newest-without-count")).toEqual({ count: "9", isThirtyHoursAgo: "true", isClamped: "false", isNull: "false" });
    });

    it("a negative count is stored as 0", () => {
      expect(find("negative-count").count).toBe("0");
    });

    it("a count without a newest writes null (a measured feed with no usable date)", () => {
      expect(find("count-without-newest")).toEqual({ count: "4", isThirtyHoursAgo: "null", isClamped: "null", isNull: "true" });
    });

    it("left no fixture behind", () => {
      expect(runPsql("select count(*) from public.sources where slug = 'fx-rpc';").trim()).toBe("0");
    });

    // Why the edge helper (feed-freshness.ts) and buildFetchStateUpdate bound the
    // item date to 1990..2100: Postgres refuses a year-0 or negative-year
    // timestamp inside jsonb_to_recordset, and one refused row fails the WHOLE
    // batch, so a hostile feed would erase every other source's fetch state.
    describe("a timestamp Postgres refuses fails the whole batch (the reason the edge bounds the date)", () => {
      const batch = (bad: string) => `
begin;
insert into public.sources (name, slug, url, rss_url, bias, kind, active) values
  ('fx good', 'fx-good', 'https://fx-good.invalid', 'https://fx-good.invalid/rss', 'center', 'outlet', true),
  ('fx bad', 'fx-bad', 'https://fx-bad.invalid', 'https://fx-bad.invalid/rss', 'center', 'outlet', true);
select public.ingest_set_source_fetch_state(jsonb_build_array(
  jsonb_build_object('id', (select id from public.sources where slug = 'fx-good'), 'fetch_last_status', 200, 'fetch_items_count', 5, 'fetch_newest_item_at', '2026-10-24T08:30:00.000Z'),
  jsonb_build_object('id', (select id from public.sources where slug = 'fx-bad'), 'fetch_last_status', 200, 'fetch_items_count', 3, 'fetch_newest_item_at', '${bad}')));
rollback;
`;

      it.each(["0000-01-01T00:00:00.000Z", "-000001-12-31T21:00:00.000Z", "-000100-01-01T00:00:00.000Z"])(
        "%s is refused by Postgres",
        (bad) => {
          expect(() => runPsql(batch(bad))).toThrow();
        },
      );

      it("the same batch with a 1990..2100 date goes through", () => {
        expect(() => runPsql(batch("1990-01-01T00:00:00.000Z"))).not.toThrow();
        expect(() => runPsql(batch("2100-12-31T23:59:59.999Z"))).not.toThrow();
      });

      it("left no fixture behind", () => {
        expect(runPsql("select count(*) from public.sources where slug in ('fx-good', 'fx-bad');").trim()).toBe("0");
      });
    });
  });
});
