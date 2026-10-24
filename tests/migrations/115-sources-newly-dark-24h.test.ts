import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { BIAS_TO_ZONE, ZONE_KEYS } from "../../supabase/functions/_shared/cluster/blindspot";
import { VOTING_SOURCE_KINDS } from "../../supabase/functions/_shared/cluster/source-kind";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 115 ("sources-newly-dark-24h").
//
// Migration 114 added ops_health_report() row 13, sources_newly_dark (warn
// only): an active outlet/wire source outside public.ops_dark_source_baseline
// with at least 50 articles in the 14 days before the last 12 hours and none in
// those 12 hours. Its own 7-day replay (6 h steps) showed the 12 h window is
// noisy: 173 flags over 22 distinct slugs, and 89 of the 146 flags with a full
// 24 h of follow-up resumed within 24 h (61% false). The same replay at 24 h and
// the same >= 50 floor: 73 flags over 8 slugs, 13 of 63 resumed (21%).
//
// 115 re-creates ops_health_report() with 114's body verbatim and changes
// nothing but row 13's window: `interval '14 days 12 hours'` -> `'14 days 24
// hours'`, both `interval '12 hours'` -> `'24 hours'`, and the detail text
// `son 12 saatte ...` -> `son 24 saatte ...`. This file pins that as an exact
// string transform of 114, that the migration is additive (one function, one
// ledger row, no table, no new grant), and the function comment. The last block
// (opt-in, TAYF_PSQL) runs row 13 against fixtures in a rolled-back
// transaction on a throwaway Postgres with 114 and 115 applied. It is modelled
// on 114-sources-newly-dark.test.ts; the helpers are copied, not imported.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const MIGRATION_115 = resolve(MIGRATIONS_DIR, "115_sources_newly_dark_24h.sql");
const MIGRATION_114 = resolve(MIGRATIONS_DIR, "114_sources_newly_dark.sql");

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

// The three replacements 115 makes to 114's row 13, as exact string pairs.
const REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  ["interval '14 days 12 hours'", "interval '14 days 24 hours'"],
  ["interval '12 hours'", "interval '24 hours'"],
  [
    "son 12 saatte haber gelmedi (önceki 14 günde en az 50 haber vardı): ",
    "son 24 saatte haber gelmedi (önceki 14 günde en az 50 haber vardı): ",
  ],
];

function applyWindow(text: string): string {
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

let sql = "";
let code = "";
let healthBlock = "";
let healthBody = "";
let healthCode = "";
let sql114 = "";
let code114 = "";
let block114 = "";
let body114 = "";

beforeAll(() => {
  sql = readFileSync(MIGRATION_115, "utf8");
  code = stripSqlComments(sql);
  healthBlock = functionBlock(code, "ops_health_report");
  healthBody = body(healthBlock);
  healthCode = stripSqlComments(healthBody);
  sql114 = readFileSync(MIGRATION_114, "utf8");
  code114 = stripSqlComments(sql114);
  block114 = functionBlock(code114, "ops_health_report");
  body114 = body(block114);
});

describe("115 ledger, structure and header", () => {
  it("is wrapped in exactly one begin/commit, with the ledger insert last", () => {
    expect([...code.matchAll(/^\s*begin\s*;/gim)]).toHaveLength(1);
    expect([...code.matchAll(/^\s*commit\s*;/gim)]).toHaveLength(1);
    const ledger = code.search(/insert\s+into\s+supabase_migrations\.schema_migrations/i);
    expect(ledger).toBeGreaterThan(code.search(/grant\s+execute\s+on\s+function/i));
    expect(ledger).toBeLessThan(code.search(/^\s*commit\s*;/im));
    // nothing but the commit follows the ledger insert
    const afterLedger = code.slice(ledger).replace(/^[\s\S]*?on\s+conflict\s+do\s+nothing\s*;/i, "");
    expect(afterLedger.trim()).toBe("commit;");
    expect([...code.matchAll(/insert\s+into\s+supabase_migrations\.schema_migrations/gi)]).toHaveLength(1);
  });

  it("records itself as version '115' in the 095 pattern", () => {
    expect(norm(code)).toContain(
      "insert into supabase_migrations.schema_migrations (version, name) values ('115', '115_sources_newly_dark_24h') on conflict do nothing",
    );
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(version,\s*name\)\s*values\s*\(\s*'115'\s*,\s*'115_sources_newly_dark_24h'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("sanity: comment stripping is non-vacuous", () => {
    expect(sql.length).toBeGreaterThan(code.length);
  });

  it("runs in the order function, comment, revoke, grant, ledger", () => {
    const fn = code.search(/create\s+or\s+replace\s+function\s+public\.ops_health_report/i);
    const comment = code.search(/comment\s+on\s+function\s+public\.ops_health_report/i);
    const revoke = code.search(/revoke\s+all\s+on\s+function\s+public\.ops_health_report/i);
    const grant = code.search(/grant\s+execute\s+on\s+function\s+public\.ops_health_report/i);
    const ledger = code.search(/insert\s+into\s+supabase_migrations\.schema_migrations/i);
    expect(fn).toBeGreaterThan(0);
    expect(comment).toBeGreaterThan(fn);
    expect(revoke).toBeGreaterThan(comment);
    expect(grant).toBeGreaterThan(revoke);
    expect(ledger).toBeGreaterThan(grant);
  });

  it("the header documents the evidence, Step 0, the dry runs, rollback and idempotence", () => {
    const head = sql.slice(0, sql.search(/^\s*begin\s*;/im));
    // the 114 replay this change rests on
    for (const n of ["173", "89/146", "73", "13/63"]) {
      expect(head, n).toContain(n);
    }
    expect(head).toMatch(/61%/);
    expect(head).toMatch(/21%/);
    // what the migration does and does not do
    expect(head).toMatch(/WHAT CHANGES/);
    expect(head).toMatch(/warn only/i);
    // Step 0 and the dry runs
    expect(head).toMatch(/STEP 0/);
    expect(head).toMatch(/Dry runs? \(×2\)/i);
    expect(head).toMatch(/13 rows/);
    // rollback and idempotence
    expect(head).toMatch(/Rollback/i);
    expect(head).toContain("114_sources_newly_dark.sql");
    expect(head).toMatch(/ledger row 115/i);
    expect(head).toMatch(/safe to re-apply/i);
  });

  it("is additive: one re-created function, one ledger row, no table, alter, drop, delete, truncate or update", () => {
    expect(code).not.toMatch(/\bcreate\s+table\b/i);
    expect(code).not.toMatch(/\balter\b/i);
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(code).not.toMatch(/\bdelete\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bvacuum\b/i);
    expect(code).not.toMatch(/\bupdate\s+public\./i);
    expect(code).not.toMatch(/\bcron\.(un)?schedule\s*\(/i);
    expect(code).not.toMatch(/\b(insert\s+into|update|delete\s+from)\s+public\.sources\b/i);
    const inserts = [...code.matchAll(/insert\s+into\s+([a-z_.]+)/gi)].map((m) => m[1]);
    expect(inserts).toEqual(["supabase_migrations.schema_migrations"]);
    // the only `create` is the function; split at `(` so the signature is not read as part of it
    const creates = [...code.matchAll(/\bcreate\b[^;(]*/gi)].map((m) => norm(m[0]));
    expect(creates).toEqual(["create or replace function public.ops_health_report"]);
  });

  it("does not write ops_dark_source_baseline (the table 114 owns): the function only reads it", () => {
    expect(code).not.toMatch(
      /\b(insert\s+into|update|delete\s+from|truncate(?:\s+table)?)\s+(?:only\s+)?public\.ops_dark_source_baseline\b/i,
    );
    expect(code).not.toMatch(/\b(create|alter|drop)\s+table\b[^;]*ops_dark_source_baseline/i);
    expect(code).not.toMatch(/\b(grant|revoke)\b[^;]*\bon\s+(?:table\s+)?public\.ops_dark_source_baseline\b/i);
    // it is still read, through the anti-join that keeps known-dark sources out
    expect(healthCode).toMatch(/from\s+public\.ops_dark_source_baseline\s+b\b/i);
  });
});

describe("115 grant surface: execute on the function for service_role, nothing else", () => {
  it("revokes from public, anon and authenticated, once", () => {
    const revokes = [...code.matchAll(/\brevoke\b[^;]*;/gi)].map((m) => norm(m[0]));
    expect(revokes).toEqual(["revoke all on function public.ops_health_report() from public, anon, authenticated;"]);
  });

  it("has exactly one grant: execute on ops_health_report() to service_role", () => {
    const allGrants = [...code.matchAll(/(^|;)\s*grant\b[^;]*;/gi)].map((m) => norm(m[0].replace(/^;/, "")));
    expect(allGrants).toEqual(["grant execute on function public.ops_health_report() to service_role;"]);
  });

  it("no grant reaches anon, authenticated or public, or carries insert/update/delete/truncate/maintain", () => {
    for (const g of [...code.matchAll(/(^|;)\s*grant\b[^;]*;/gi)].map((m) => m[0])) {
      expect(g).not.toMatch(/\bto\b[^;]*\b(anon|authenticated|public)\b/i);
      expect(g).not.toMatch(/\b(insert|update|delete|truncate|maintain|references|trigger|all)\b/i);
      expect(g).toMatch(/\bto\s+service_role\s*;/i);
    }
    expect(code).not.toMatch(/\bgrant\b[^;]*\b(insert|update|delete|truncate|maintain)\b/i);
    expect(code).not.toMatch(/\balter\s+default\s+privileges\b/i);
  });
});

describe("115 ops_health_report: signature and safety match 114", () => {
  it("the function header is identical to 114's (plpgsql volatile SECURITY DEFINER, empty search_path, same columns)", () => {
    expect(norm(header(healthBlock))).toBe(norm(header(block114)));
    expect(header(healthBlock)).toMatch(
      /function\s+public\.ops_health_report\s*\(\s*\)[\s\S]*?language\s+plpgsql[\s\S]{0,40}volatile[\s\S]{0,40}security\s+definer[\s\S]{0,40}set\s+search_path\s*=\s*''/i,
    );
  });

  it("the declare section is 114's, byte for byte after norm, and #variable_conflict use_column stays", () => {
    expect(healthCode).toMatch(/#variable_conflict\s+use_column/i);
    expect(declareSection(healthBody)).toBe(declareSection(body114));
  });

  it("is read-only: no writes, truncate, cron.schedule, return_message or cron job-command access in the function", () => {
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

describe("115 ops_health_report: 114's body, with only row 13's window changed", () => {
  it("has the same number of segments as 114's body, split at every `check_name :=`", () => {
    expect(segments(healthBody).length).toBe(segments(body114).length);
    // the preamble plus 11 `check_name :=` assignments (the three zone rows share one, in a loop)
    expect(segments(healthBody)).toHaveLength(12);
  });

  it("segments 0..n-2 (the preamble and rows 1-12) are 114's after norm", () => {
    const a = segments(healthBody);
    const b = segments(body114);
    expect(a).toHaveLength(b.length);
    for (let i = 0; i < b.length - 1; i++) {
      expect(segmentName(a[i] as string)).toBe(segmentName(b[i] as string));
      expect(norm(a[i] as string), i === 0 ? "preamble" : segmentName(b[i] as string)).toBe(norm(b[i] as string));
    }
  });

  it("the unchanged rows carry real content (the segment comparison is not vacuous)", () => {
    const a = segments(healthBody);
    expect(a.slice(0, -1).filter((s) => norm(s).length > 300).length).toBeGreaterThanOrEqual(9);
    for (const name of ["cron_failed_runs_30m", "edge_http_errors_30m", "dead_feeds", "jev_shadow_cron_failures_30m"]) {
      expect(norm(segmentFor(healthBody, name)).length, name).toBeGreaterThan(300);
      expect(norm(segmentFor(healthBody, name)), name).toBe(norm(segmentFor(body114, name)));
    }
  });

  it("the last segment (row 13) is 114's row 13 with exactly the three replacements applied", () => {
    const a = segments(healthBody);
    const b = segments(body114);
    const last114 = norm(b[b.length - 1] as string);
    const last115 = norm(a[a.length - 1] as string);
    expect(segmentName(a[a.length - 1] as string)).toBe(CHECK_13);
    // the replacements bite: 1 + 2 + 1 occurrences in 114, so the transform is not a no-op
    expect(last114.split(REPLACEMENTS[0]?.[0] as string).length - 1).toBe(1);
    expect(last114.split(REPLACEMENTS[1]?.[0] as string).length - 1).toBe(2);
    expect(last114.split(REPLACEMENTS[2]?.[0] as string).length - 1).toBe(1);
    expect(last115).not.toBe(last114);
    expect(last115).toBe(applyWindow(last114));
  });

  it("row 13 no longer mentions a 12 hour window and has exactly one '14 days 24 hours'", () => {
    const seg = norm(segmentFor(healthBody, CHECK_13));
    expect(seg).not.toContain("12 hours");
    expect(seg).not.toContain("12 saatte");
    expect([...seg.matchAll(/interval '14 days 24 hours'/g)]).toHaveLength(1);
    expect([...seg.matchAll(/interval '24 hours'/g)]).toHaveLength(2);
    expect(healthCode).not.toContain("14 days 12 hours");
  });

  it("the raw function body (comments included) is byte-identical to 114's for rows 1-12", () => {
    const [before115] = splitAtRow13(rawFunctionBody(sql));
    const [before114] = splitAtRow13(rawFunctionBody(sql114));
    expect(before115.length).toBeGreaterThan(10_000);
    expect(before115).toBe(before114);
  });

  it("the raw row 13 differs from 114's only in the windows, the detail text and the marker comment", () => {
    const [, row115] = splitAtRow13(rawFunctionBody(sql));
    const [, row114] = splitAtRow13(rawFunctionBody(sql114));
    expect(row114.startsWith("-- 13. sources_newly_dark (migration 114)\n")).toBe(true);
    expect(row115.startsWith("-- 13. sources_newly_dark (migration 114; window 24 h since 115)\n")).toBe(true);
    const expected = applyWindow(row114).replace(
      "-- 13. sources_newly_dark (migration 114)\n",
      "-- 13. sources_newly_dark (migration 114; window 24 h since 115)\n",
    );
    expect(row115).toBe(expected);
  });

  it("the body still ends `end; return next; return; end`, with a single final `return;`", () => {
    const flat = norm(healthBody);
    expect(flat.endsWith("end; return next; return; end")).toBe(true);
    expect([...flat.matchAll(/\breturn;/g)]).toHaveLength(1);
    expect(flat).toMatch(/end; return next; check_name := 'sources_newly_dark';/);
  });

  it("the function comment says (migrations 077, 100, 103, 108, 114, 115): 13 fixed rows and lists the 13 names in order", () => {
    const comment = /comment\s+on\s+function\s+public\.ops_health_report\(\)\s+is([\s\S]*?);\s*\n/i.exec(sql);
    expect(comment).not.toBeNull();
    const text = (comment as RegExpExecArray)[1] as string;
    expect(text).toMatch(/\(migrations 077, 100, 103, 108, 114, 115\): 13 fixed rows/);
    const positions = ROW_NAMES_13.map((n) => text.indexOf(n));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);
    // row 13 is described, as warn-only, with the 24 h window
    const tail = text.slice(positions[12] as number);
    expect(tail).toMatch(/warn only|warn-only/i);
    expect(tail).toMatch(/ops_dark_source_baseline/);
    expect(tail).toMatch(/50/);
    expect(tail).toMatch(/24 hours/);
    expect(tail).not.toMatch(/12 hours/);
    // the comment is several adjacent string literals; join them before matching a phrase across a line break
    expect(text.replace(/'\s*\n\s*'/g, "")).toMatch(/14 days before the last 24 hours and none in those 24 hours; warn only/);
    // 108's semantics are still described
    expect(text).toMatch(/budget_exceeded/);
    expect(text).toMatch(/never reads any potentially secret-bearing pg_cron job field/);
    expect(text).toMatch(/service_role only/);
  });
});

describe("115 sources_newly_dark (row 13)", () => {
  let seg = "";
  beforeAll(() => {
    seg = norm(segmentFor(healthBody, CHECK_13));
  });

  it("opens with threshold 1 and nulled observed/detail, and ends the function", () => {
    expect(seg.startsWith("'sources_newly_dark'; threshold := 1; observed := null; detail := null; begin")).toBe(true);
    expect(seg.endsWith("end; return next; return; end")).toBe(true);
    expect(seg.match(/return next;/g)).toHaveLength(1);
  });

  it("keeps the baseline exclusion on active outlet/wire sources", () => {
    expect(seg).toContain("select s.id, s.slug from public.sources s where s.active and s.kind in ('outlet', 'wire')");
    expect(seg).toContain("and not exists (select 1 from public.ops_dark_source_baseline b where b.slug = s.slug)");
  });

  it("counts articles per source over 14 days 24 hours, split at 24 hours, never past v_now", () => {
    expect(seg).toContain(
      "from public.articles a where a.created_at >= v_now - interval '14 days 24 hours' and a.created_at <= v_now group by a.source_id",
    );
    expect(seg).toContain("pg_catalog.count(*) filter (where a.created_at < v_now - interval '24 hours') as prior_n");
    expect(seg).toContain("pg_catalog.count(*) filter (where a.created_at >= v_now - interval '24 hours') as recent_n");
  });

  it("keeps the >= 50 floor, and the row stays warn-only", () => {
    expect(seg).toContain("where c.prior_n >= 50 and c.recent_n = 0");
    expect(seg).toContain("status := case when v_n >= 1 then 'warn' else 'pass' end;");
    expect(seg).not.toMatch(/fail/);
    expect(seg).not.toMatch(/'skip'/);
    // behavioural mirror: a 13 h lull is no longer a flag at 24 h, 49 is still not enough
    const flagged = (prior: number, recent: number) => prior >= 50 && recent === 0;
    expect(flagged(50, 0)).toBe(true);
    expect(flagged(49, 0)).toBe(false);
    expect(flagged(60, 1)).toBe(false);
  });

  it("reports both Turkish detail strings exactly, the long one cut to 500 characters", () => {
    expect(seg).toContain(
      "detail := case when v_n >= 1 then substr('son 24 saatte haber gelmedi (önceki 14 günde en az 50 haber vardı): ' || v_text, 1, 500) else 'yeni susan kaynak yok' end;",
    );
  });

  it("swallows errors (a missing baseline table included) into an unknown row", () => {
    expect(seg).toContain(
      "exception when others then status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200); end; return next;",
    );
  });
});

describe("115 ops_health_report: zone-map and source-kind parity with the bias-zone contract", () => {
  it("the zmap VALUES pairs deep-equal BIAS_TO_ZONE, with no duplicates", () => {
    const span = /zmap\s*\(\s*bias_key\s*,\s*zone\s*\)\s+as\s*\(\s*values([\s\S]*?)\)\s*\n?\s*select/i.exec(healthCode);
    expect(span).not.toBeNull();
    const parsed: Record<string, string> = {};
    const pairRe = /\(\s*'([a-z_]+)'\s*,\s*'([a-z]+)'\s*\)/g;
    let m: RegExpExecArray | null;
    let count = 0;
    while ((m = pairRe.exec((span as RegExpExecArray)[1] as string)) !== null) {
      parsed[m[1] as string] = m[2] as string;
      count += 1;
    }
    expect(count).toBe(Object.keys(BIAS_TO_ZONE).length);
    expect(parsed).toEqual({ ...BIAS_TO_ZONE });
    expect([...healthCode.matchAll(/zmap\s*\(\s*bias_key/gi)]).toHaveLength(1);
  });

  it("the zone loop's array literal equals ZONE_KEYS", () => {
    const m = /foreach\s+v_zone\s+in\s+array\s+array\s*\[([^\]]+)\]/i.exec(healthCode);
    expect(m).not.toBeNull();
    const items = [...((m as RegExpExecArray)[1] as string).matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    expect(items).toEqual([...ZONE_KEYS]);
  });

  it("every 's.kind in (...)' list equals VOTING_SOURCE_KINDS, and there are exactly 3 of them", () => {
    const lists = [...healthCode.matchAll(/s\.kind\s+in\s*\(([^)]+)\)/gi)];
    expect(lists).toHaveLength(3);
    for (const l of lists) {
      const kinds = [...(l[1] as string).matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
      expect(new Set(kinds)).toEqual(new Set(VOTING_SOURCE_KINDS));
    }
  });
});

describe("115 secrets", () => {
  it("bakes no secret into the file", () => {
    expect(sql).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(sql).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{20,}/);
  });
});

// ---------------------------------------------------------------------------
// Live behaviour (opt-in): row 13 against fixtures, on a throwaway Postgres
// with 114 and then 115 applied and no other dark source. TAYF_PSQL is the psql
// binary and PGHOST/PGPORT/PGUSER/PGDATABASE select the server. Everything the
// fixtures write sits inside a transaction that is rolled back.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))("115 sources_newly_dark against fixtures (live Postgres)", () => {
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
    const src = (slug: string, kind: string, active: boolean) =>
      `('fx ${slug}', '${slug}', 'https://${slug}.invalid', 'https://${slug}.invalid/rss', 'center', '${kind}', ${active})`;
    // 60 articles from 25 h back to 25 h + 59 * 3 h: a full prior window, nothing in the last 24 h
    const ago = "now() - interval '25 hours' - gs.g * interval '3 hours'";
    const hashCol = withHash ? ", content_hash" : "";
    const hashOf = (urlExpr: string) => (withHash ? `, md5(${urlExpr})` : "");
    const urlExpr = "'https://fx.invalid/' || s.slug || '/' || gs.g";
    const extra = (slug: string, tag: string, interval: string) =>
      `insert into public.articles (source_id, title, url, published_at, created_at${hashCol})
  select s.id, 'fx ${tag}', 'https://fx.invalid/${slug}/${tag}', now() - interval '${interval}', now() - interval '${interval}'${hashOf(`'https://fx.invalid/${slug}/${tag}'`)}
    from public.sources s where s.slug = '${slug}';`;
    return `
begin;
insert into public.sources (name, slug, url, rss_url, bias, kind, active) values
  ${src("fx-dark", "outlet", true)},
  ${src("fx-lull", "outlet", true)},
  ${src("fx-busy", "outlet", true)},
  ${src("fx-small", "outlet", true)},
  ${src("fx-off", "outlet", false)},
  ${src("fx-agg", "aggregator", true)};
insert into public.sources (name, slug, url, rss_url, bias, kind, active)
  select 'fx ntv', 'ntv', 'https://ntv.invalid', 'https://ntv.invalid/rss', 'center', 'outlet', true
   where not exists (select 1 from public.sources where slug = 'ntv');
insert into public.articles (source_id, title, url, published_at, created_at${hashCol})
  select s.id, 'fx ' || s.slug || ' ' || gs.g, ${urlExpr}, ${ago}, ${ago}${hashOf(urlExpr)}
    from public.sources s
    join (values ('fx-dark', 60), ('fx-lull', 60), ('fx-busy', 60), ('fx-small', 49), ('ntv', 60), ('fx-off', 60), ('fx-agg', 60)) v(slug, n)
      on v.slug = s.slug
   cross join lateral generate_series(0, v.n - 1) as gs(g);
${extra("fx-lull", "lull", "13 hours")}
${extra("fx-busy", "fresh", "1 hour")}
${ROW_13}
delete from public.articles a using public.sources s where s.id = a.source_id and s.slug = 'fx-dark';
delete from public.sources where slug = 'fx-dark';
${ROW_13}
rollback;
`;
  }

  it("the target database runs migration 115's row 13 (14 days 24 hours), not 114's", () => {
    const out = runPsql(
      "select pg_catalog.strpos(p.prosrc, '14 days 24 hours') > 0 and pg_catalog.strpos(p.prosrc, '14 days 12 hours') = 0 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'ops_health_report';",
    ).trim();
    expect(out).toBe("t");
  });

  it("flags the source silent for 25 h; a 13 h lull (which 114 flagged) is not flagged; a second pass without the flagged source is pass", () => {
    const lines = runPsql(fixtureSql(articlesHaveContentHash()))
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    const first = parseRow(lines[0] as string);
    expect(first.check).toBe(CHECK_13);
    expect(first.status).toBe("warn");
    expect(first.observed).toBe("1");
    expect(first.threshold).toBe("1");
    expect(first.detail.startsWith("son 24 saatte haber gelmedi (önceki 14 günde en az 50 haber vardı): ")).toBe(true);
    expect(first.detail).toContain("fx-dark (60)");
    for (const other of ["fx-lull", "fx-busy", "fx-small", "ntv", "fx-off", "fx-agg"]) {
      expect(first.detail, other).not.toContain(other);
    }

    const second = parseRow(lines[1] as string);
    expect(second.status).toBe("pass");
    expect(second.observed).toBe("0");
    expect(second.threshold).toBe("1");
    expect(second.detail).toBe("yeni susan kaynak yok");
  });

  it("rolled the fixtures back", () => {
    const out = runPsql("select count(*) from public.sources where slug like 'fx-%';").trim();
    expect(out).toBe("0");
    expect(runPsql("select count(*) from public.articles where url like 'https://fx.invalid/%';").trim()).toBe("0");
  });

  it("returns exactly 13 rows, in order, and sources_newly_dark is the last", () => {
    const count = runPsql("select count(*) from public.ops_health_report();").trim();
    expect(count).toBe("13");
    const names = runPsql("select check_name from public.ops_health_report();")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(names).toEqual(ROW_NAMES_13);
  });

  it("grants execute on the function to service_role only", () => {
    const sig = "public.ops_health_report()";
    expect(
      runPsql(
        `select has_function_privilege('anon', '${sig}', 'execute'), has_function_privilege('authenticated', '${sig}', 'execute'), has_function_privilege('service_role', '${sig}', 'execute');`,
      ).trim(),
    ).toBe("f|f|t");
  });
});
