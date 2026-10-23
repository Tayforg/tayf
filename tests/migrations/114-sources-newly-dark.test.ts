import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { BIAS_TO_ZONE, ZONE_KEYS } from "../../supabase/functions/_shared/cluster/blindspot";
import { VOTING_SOURCE_KINDS } from "../../supabase/functions/_shared/cluster/source-kind";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 114 ("sources-newly-dark").
//
// 2026-10-15 .. 2026-10-23: five active outlet/wire sources (halk-tv,
// gazete-pencere, benguturk, medya-gazete, arti-gercek) went silent one after
// another and nothing in the heartbeat said so: dead_feeds only counts a source
// after 72 h of silence and only pages at 38+ of ~96, and the per-zone
// freshness rows look at the zone's newest article, which another outlet
// always supplies. 114 adds row 13, sources_newly_dark (warn only): an active
// outlet/wire source that is NOT in the known-dark baseline, had at least 50
// articles in the 14 days before the last 12 hours, and has none in those 12
// hours. The baseline is public.ops_dark_source_baseline, seeded with the 25
// sources docs/feed-registry-2026-09.md section 2 already knows are dark.
//
// 114 re-creates ops_health_report() with 108's body verbatim plus row 13. This
// file pins that every segment but the last two survived unchanged (modulo
// comments/whitespace), what row 13 says, that the function stays read-only,
// and the table's grant surface (service_role select only). It is modelled on
// 108-jev-stall-check-v2.test.ts. The last block (opt-in, TAYF_PSQL) runs row
// 13 against fixtures in a rolled-back transaction on a throwaway Postgres.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const MIGRATION_114 = resolve(MIGRATIONS_DIR, "114_sources_newly_dark.sql");
const MIGRATION_111 = resolve(MIGRATIONS_DIR, "111_source_reliability.sql");
const MIGRATION_108 = resolve(MIGRATIONS_DIR, "108_jev_stall_check_v2.sql");
const FEED_REGISTRY = resolve(ROOT, "docs", "feed-registry-2026-09.md");

const CHECK_12 = "jev_shadow_cron_failures_30m";
const CHECK_13 = "sources_newly_dark";
const TABLE = "ops_dark_source_baseline";

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

function literalCheckNames(fnBody: string): string[] {
  return [...stripSqlComments(fnBody).matchAll(/check_name\s*:=\s*'([a-z0-9_]+)'\s*;/gi)].map(
    (m) => m[1] as string,
  );
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

let sql = "";
let code = "";
let healthBlock = "";
let healthBody = "";
let healthCode = "";
let sql108 = "";
let code108 = "";
let block108 = "";
let body108 = "";

beforeAll(() => {
  sql = readFileSync(MIGRATION_114, "utf8");
  code = stripSqlComments(sql);
  healthBlock = functionBlock(code, "ops_health_report");
  healthBody = body(healthBlock);
  healthCode = stripSqlComments(healthBody);
  sql108 = readFileSync(MIGRATION_108, "utf8");
  code108 = stripSqlComments(sql108);
  block108 = functionBlock(code108, "ops_health_report");
  body108 = body(block108);
});

describe("114 ledger, structure and header", () => {
  it("is wrapped in exactly one begin/commit, with the ledger insert last", () => {
    expect([...code.matchAll(/^\s*begin\s*;/gim)]).toHaveLength(1);
    expect([...code.matchAll(/^\s*commit\s*;/gim)]).toHaveLength(1);
    const ledger = code.search(/insert\s+into\s+supabase_migrations\.schema_migrations/i);
    expect(ledger).toBeGreaterThan(code.search(/grant\s+execute\s+on\s+function/i));
    expect(ledger).toBeGreaterThan(code.search(/grant\s+select\s+on\s+public\./i));
    expect(ledger).toBeLessThan(code.search(/^\s*commit\s*;/im));
    // nothing but the commit follows the ledger insert
    const afterLedger = code.slice(ledger).replace(/^[\s\S]*?on\s+conflict\s+do\s+nothing\s*;/i, "");
    expect(afterLedger.trim()).toBe("commit;");
    expect([...code.matchAll(/insert\s+into\s+supabase_migrations\.schema_migrations/gi)]).toHaveLength(1);
  });

  it("records itself as version '114' in the 095 pattern", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(version,\s*name\)\s*values\s*\(\s*'114'\s*,\s*'114_sources_newly_dark'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("sanity: comment stripping is non-vacuous", () => {
    expect(sql.length).toBeGreaterThan(code.length);
  });

  it("runs in the order table, seed, function, ledger", () => {
    const create = code.search(/create\s+table\s+if\s+not\s+exists\s+public\.ops_dark_source_baseline/i);
    const seed = code.search(/insert\s+into\s+public\.ops_dark_source_baseline/i);
    const fn = code.search(/create\s+or\s+replace\s+function\s+public\.ops_health_report/i);
    const ledger = code.search(/insert\s+into\s+supabase_migrations\.schema_migrations/i);
    expect(create).toBeGreaterThan(0);
    expect(seed).toBeGreaterThan(create);
    expect(fn).toBeGreaterThan(seed);
    expect(ledger).toBeGreaterThan(fn);
  });

  it("the header documents the evidence, the 108 re-creation, the ack procedure, the dry runs, Step 0, rollback and idempotence", () => {
    const head = sql.slice(0, sql.search(/^\s*begin\s*;/im));
    // evidence: the five sources and their 30-day volume
    for (const slug of ["halk-tv", "gazete-pencere", "benguturk", "medya-gazete", "arti-gercek"]) {
      expect(head, slug).toContain(slug);
    }
    for (const n of ["4,108", "2,759", "3,686", "3,741", "1,221"]) {
      expect(head, n).toContain(n);
    }
    expect(head).toMatch(/opposition_leaning/);
    expect(head).toMatch(/muhalefet/);
    expect(head).toMatch(/9k articles a month/);
    // what the migration does and does not do
    expect(head).toMatch(/108 body verbatim plus row 13/);
    expect(head).toMatch(/no source is touched/i);
    // ack procedure
    expect(head).toMatch(/insert into public\.ops_dark_source_baseline \(slug, reason\)/);
    expect(head).toMatch(/delete from public\.ops_dark_source_baseline/i);
    expect(head).toMatch(/founder/i);
    // Step 0 and the dry runs
    expect(head).toMatch(/STEP 0/);
    expect(head).toMatch(/idx_articles_created_source/);
    expect(head).toMatch(/Dry runs? \(×2\)/i);
    expect(head).toMatch(/25 seed rows/);
    expect(head).toMatch(/13 rows/);
    // rollback and idempotence
    expect(head).toMatch(/Rollback/i);
    expect(head).toMatch(/108/);
    expect(head).toMatch(/drop table public\.ops_dark_source_baseline/i);
    expect(head).toMatch(/ledger row 114/i);
    expect(head).toMatch(/safe to re-apply/i);
  });

  it("is additive and touches no source: one new table, one re-created function, no drop/alter/delete/update", () => {
    // the only alter is the new table's own row level security switch
    const alters = [...code.matchAll(/\balter\s+table\b[^;]*;/gi)].map((m) => norm(m[0]));
    expect(alters).toEqual(["alter table public.ops_dark_source_baseline enable row level security;"]);
    expect(code).not.toMatch(/\bdrop\s+(table|function|schema|extension|policy|index)\b/i);
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bvacuum\b/i);
    expect(code).not.toMatch(/\bupdate\s+public\./i);
    expect(code).not.toMatch(/\bcron\.(un)?schedule\s*\(/i);
    expect(code).not.toMatch(/\b(insert\s+into|update|delete\s+from)\s+public\.sources\b/i);
    const inserts = [...code.matchAll(/insert\s+into\s+([a-z_.]+)/gi)].map((m) => m[1]);
    expect(inserts).toEqual(["public.ops_dark_source_baseline", "supabase_migrations.schema_migrations"]);
    const tables = [...code.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_.]+)/gi)].map((m) => m[1]);
    expect(tables).toEqual(["public.ops_dark_source_baseline"]);
    const creates = [...code.matchAll(/create\s+or\s+replace\s+function\s+(public\.[a-z_]+)/gi)].map((m) => m[1]);
    expect(creates).toEqual(["public.ops_health_report"]);
  });
});

describe("114 public.ops_dark_source_baseline: shape and grant surface", () => {
  it("is created if not exists with slug as the primary key and the documented columns", () => {
    const m = /create\s+table\s+if\s+not\s+exists\s+public\.ops_dark_source_baseline\s*\(([\s\S]*?)\)\s*;/i.exec(code);
    expect(m).not.toBeNull();
    const cols = norm((m as RegExpExecArray)[1] as string);
    expect(cols).toBe(
      "slug text primary key, reason text not null, noted_in text not null default 'docs/feed-registry-2026-09.md §2', added_at timestamptz not null default pg_catalog.now()",
    );
  });

  it("carries a table comment that names the check and the ack procedure", () => {
    const m = /comment\s+on\s+table\s+public\.ops_dark_source_baseline\s+is([\s\S]*?);\s*\n/i.exec(code);
    expect(m).not.toBeNull();
    const text = (m as RegExpExecArray)[1] as string;
    expect(text).toContain("sources_newly_dark");
    expect(text).toMatch(/114/);
    expect(text).toMatch(/service_role/);
  });

  it("enables row level security and defines no policy", () => {
    expect(code).toMatch(/alter\s+table\s+public\.ops_dark_source_baseline\s+enable\s+row\s+level\s+security\s*;/i);
    expect(code).not.toMatch(/\bcreate\s+policy\b/i);
    expect(code).not.toMatch(/\bdisable\s+row\s+level\s+security\b/i);
    expect(code).not.toMatch(/\bforce\s+row\s+level\s+security\b/i);
  });

  it("revokes every default privilege from anon, authenticated and public", () => {
    expect(code).toMatch(
      /revoke\s+all\s+on\s+public\.ops_dark_source_baseline\s+from\s+anon\s*,\s*authenticated\s*,\s*public\s*;/i,
    );
  });

  it("revokes MAINTAIN behind a PG17 guard, verbatim from 107/111", () => {
    const maint = /do\s+\$maint\$([\s\S]*?)\$maint\$\s*;/i.exec(code);
    expect(maint).not.toBeNull();
    const inner = norm((maint as RegExpExecArray)[1] as string);
    expect(inner).toBe(
      "begin if current_setting('server_version_num')::int >= 170000 then execute 'revoke maintain on public.ops_dark_source_baseline from anon, authenticated'; end if; end",
    );
    // the same block 111 uses, with only the table name changed
    const code111 = stripSqlComments(readFileSync(MIGRATION_111, "utf8"));
    const maint111 = /do\s+\$maint\$([\s\S]*?)\$maint\$\s*;/i.exec(code111);
    expect(maint111).not.toBeNull();
    expect(inner).toBe(norm((maint111 as RegExpExecArray)[1] as string).replace("source_reliability_30d", TABLE));
    // the guard comes after the revoke-all and before the grant
    expect(code.search(/\$maint\$/)).toBeGreaterThan(code.search(/revoke\s+all\s+on\s+public\.ops_dark_source_baseline/i));
    expect(code.search(/\$maint\$/)).toBeLessThan(code.search(/grant\s+select\s+on\s+public\.ops_dark_source_baseline/i));
  });

  it("grants SELECT to service_role and nothing else on the table", () => {
    const tableGrants = [...code.matchAll(/(^|;)\s*grant\b[^;]*\bon\s+(?:table\s+)?public\.ops_dark_source_baseline\b[^;]*;/gi)];
    expect(tableGrants).toHaveLength(1);
    expect(norm(tableGrants[0]?.[0]?.replace(/^;/, "") ?? "")).toBe(
      "grant select on public.ops_dark_source_baseline to service_role;",
    );
  });

  it("no grant anywhere reaches anon, authenticated or public, or carries a write privilege", () => {
    const allGrants = [...code.matchAll(/(^|;)\s*grant\b[^;]*;/gi)].map((m) => m[0]);
    // the select grant on the table and the execute grant on the function, nothing more
    expect(allGrants).toHaveLength(2);
    for (const g of allGrants) {
      expect(g).not.toMatch(/\bto\b[^;]*\b(anon|authenticated|public)\b/i);
      expect(g).not.toMatch(/\b(insert|update|delete|truncate|maintain|references|trigger|all)\b/i);
      expect(g).toMatch(/\bto\s+service_role\s*;/i);
    }
    expect(code).not.toMatch(/\bgrant\b[^;]*\b(insert|update|delete|truncate|maintain)\b/i);
    expect(code).not.toMatch(/\balter\s+default\s+privileges\b/i);
  });
});

describe("114 baseline seed", () => {
  const SEED_RE = /insert\s+into\s+public\.ops_dark_source_baseline\s*\(\s*slug\s*,\s*reason\s*\)\s*values([\s\S]*?)on\s+conflict\s*\(\s*slug\s*\)\s+do\s+nothing\s*;/i;

  function parseSeed(): Array<[string, string]> {
    const m = SEED_RE.exec(code);
    if (!m) throw new Error("seed insert not found");
    return [...(m[1] as string).matchAll(/\(\s*'([a-z0-9-]+)'\s*,\s*'([a-z0-9-]+)'\s*\)/g)].map(
      (x): [string, string] => [x[1] as string, x[2] as string],
    );
  }

  /** slug -> class, from the table in docs/feed-registry-2026-09.md between "## 2." and "## 3.". */
  function parseRegistrySection2(): Map<string, string> {
    const doc = readFileSync(FEED_REGISTRY, "utf8");
    const start = doc.indexOf("## 2.");
    const end = doc.indexOf("## 3.");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const out = new Map<string, string>();
    for (const line of doc.slice(start, end).split("\n")) {
      if (!line.startsWith("|")) continue;
      const cells = line.split("|").map((c) => c.trim());
      // cells[0] is the empty text before the first pipe
      const slug = cells[1] ?? "";
      const zone = cells[2] ?? "";
      const klass = cells[4] ?? "";
      if (!/^[a-z][a-z0-9-]*$/.test(slug) || slug === "slug" || !zone.includes("->")) continue;
      out.set(slug, klass);
    }
    return out;
  }

  it("is a single insert ... on conflict (slug) do nothing", () => {
    expect([...code.matchAll(/insert\s+into\s+public\.ops_dark_source_baseline/gi)]).toHaveLength(1);
    expect(SEED_RE.test(code)).toBe(true);
  });

  it("seeds exactly 25 distinct slugs", () => {
    const pairs = parseSeed();
    expect(pairs).toHaveLength(25);
    expect(new Set(pairs.map(([s]) => s)).size).toBe(25);
  });

  it("the seeded slugs are set-equal to the section 2 slugs of docs/feed-registry-2026-09.md", () => {
    const doc = parseRegistrySection2();
    expect(doc.size).toBe(25);
    expect(new Set(parseSeed().map(([s]) => s))).toEqual(new Set(doc.keys()));
  });

  it("each seeded reason is that slug's class in the registry table", () => {
    const doc = parseRegistrySection2();
    for (const [slug, reason] of parseSeed()) {
      expect(reason, slug).toBe(doc.get(slug));
    }
    expect(new Set(parseSeed().map(([, r]) => r))).toEqual(
      new Set(["blocked-403", "dns-timeout", "not-a-feed", "redirect-offsite", "valid-stale"]),
    );
  });

  it("leaves out the five sources the check exists to find", () => {
    const seeded = new Set(parseSeed().map(([s]) => s));
    for (const slug of ["halk-tv", "gazete-pencere", "benguturk", "medya-gazete", "arti-gercek"]) {
      expect(seeded.has(slug), slug).toBe(false);
    }
  });
});

describe("114 ops_health_report: signature, grants and safety match 108", () => {
  it("the function header is identical to 108's (plpgsql volatile SECURITY DEFINER, empty search_path, same columns)", () => {
    expect(norm(header(healthBlock))).toBe(norm(header(block108)));
    expect(header(healthBlock)).toMatch(
      /function\s+public\.ops_health_report\s*\(\s*\)[\s\S]*?language\s+plpgsql[\s\S]{0,40}volatile[\s\S]{0,40}security\s+definer[\s\S]{0,40}set\s+search_path\s*=\s*''/i,
    );
  });

  it("the declare section is 108's, byte for byte after norm, and #variable_conflict use_column stays", () => {
    expect(healthCode).toMatch(/#variable_conflict\s+use_column/i);
    expect(declareSection(healthBody)).toBe(declareSection(body108));
  });

  it("revokes from public/anon/authenticated and grants execute only to service_role, as 108 did", () => {
    expect(code).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.ops_health_report\(\)\s+from\s+public,\s*anon,\s*authenticated\s*;/i,
    );
    const grants = [...code.matchAll(/grant\s+execute\s+on\s+function\s+public\.ops_health_report[^;]*;/gi)];
    expect(grants).toHaveLength(1);
    expect(grants[0]?.[0]).toMatch(/\(\)\s+to\s+service_role\s*;/i);
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

  it("cron.* / net.* relations are reached only through to_regclass or EXECUTE strings", () => {
    expect(healthCode).toMatch(/to_regclass\(\s*'cron\.job_run_details'\s*\)/i);
    expect(healthCode).toMatch(/to_regclass\(\s*'cron\.job'\s*\)/i);
    expect(healthCode).toMatch(/to_regclass\(\s*'net\._http_response'\s*\)/i);
    const withoutToRegclass = healthCode.replace(/to_regclass\(\s*'[^']*'\s*\)/gi, "to_regclass(...)");
    const withoutExecute = withoutToRegclass.replace(/execute\s+\$q\$[\s\S]*?\$q\$/gi, "EXECUTED");
    expect(withoutExecute).not.toMatch(/\bcron\.(job|job_run_details)\b/i);
    expect(withoutExecute).not.toMatch(/\bnet\._http_response\b/i);
  });
});

describe("114 ops_health_report: 108's twelve checks plus row 13", () => {
  it("the literal check_name assignments are 108's, then sources_newly_dark", () => {
    expect(literalCheckNames(healthBody)).toEqual([...literalCheckNames(body108), CHECK_13]);
    expect(literalCheckNames(healthBody)).toHaveLength(10);
    expect(healthCode).toMatch(/check_name\s*:=\s*'ingest_fresh_'\s*\|\|\s*v_zone\s*\|\|\s*'_min'/i);
  });

  it("every segment of the body, split at `check_name :=`, is 108's after norm, except check 12's tail and the new check 13", () => {
    const a = segments(healthBody);
    const b = segments(body108);
    expect(a).toHaveLength(b.length + 1);
    expect(norm(a[0] as string)).toBe(norm(b[0] as string));
    for (let i = 1; i < b.length - 1; i++) {
      expect(segmentName(a[i] as string)).toBe(segmentName(b[i] as string));
      expect(norm(a[i] as string), segmentName(b[i] as string)).toBe(norm(b[i] as string));
    }
    // segment 12 is 108's last segment minus its trailing " return; end": row 13 follows it
    const last108 = norm(b[b.length - 1] as string);
    expect(segmentName(b[b.length - 1] as string)).toBe(CHECK_12);
    expect(segmentName(a[b.length - 1] as string)).toBe(CHECK_12);
    expect(last108.endsWith(" return; end")).toBe(true);
    expect(norm(a[b.length - 1] as string)).toBe(last108.slice(0, -" return; end".length));
    // and the new segment 13 is last
    expect(segmentName(a[a.length - 1] as string)).toBe(CHECK_13);
  });

  it("the unchanged checks carry real content (the segment comparison is not vacuous)", () => {
    for (const name of ["cron_failed_runs_30m", "edge_http_errors_30m", "blindspot_veto_cron_min", "dead_feeds", "net_response_heap_mb"]) {
      expect(norm(segmentFor(healthBody, name)).length).toBeGreaterThan(300);
    }
    expect(norm(segmentFor(healthBody, "jev_shadow_last_run_min"))).toBe(
      norm(segmentFor(body108, "jev_shadow_last_run_min")),
    );
  });

  it("row 13 sits between row 12's `return next;` and the final `return;`", () => {
    const flat = norm(healthBody);
    expect(flat).toMatch(/end; return next; check_name := 'sources_newly_dark';/);
    expect(flat.endsWith("end; return next; return; end")).toBe(true);
    expect([...flat.matchAll(/\breturn;/g)]).toHaveLength(1);
  });

  it("the function comment says (migrations 077, 100, 103, 108, 114): 13 fixed rows and lists the 13 names in order", () => {
    const comment = /comment\s+on\s+function\s+public\.ops_health_report\(\)\s+is([\s\S]*?);\s*\n/i.exec(sql);
    expect(comment).not.toBeNull();
    const text = (comment as RegExpExecArray)[1] as string;
    expect(text).toMatch(/\(migrations 077, 100, 103, 108, 114\): 13 fixed rows/);
    const positions = ROW_NAMES_13.map((n) => text.indexOf(n));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);
    // row 13 is described, as warn-only
    const tail = text.slice(positions[12] as number);
    expect(tail).toMatch(/warn only|warn-only/i);
    expect(tail).toMatch(/ops_dark_source_baseline/);
    expect(tail).toMatch(/50/);
    expect(tail).toMatch(/12 hours|12 h/);
    // 108's semantics are still described
    expect(text).toMatch(/budget_exceeded/);
    expect(text).toMatch(/never reads any potentially secret-bearing pg_cron job field/);
    expect(text).toMatch(/service_role only/);
  });
});

describe("114 sources_newly_dark (row 13)", () => {
  let seg = "";
  beforeAll(() => {
    seg = norm(segmentFor(healthBody, CHECK_13));
  });

  it("opens with threshold 1 and nulled observed/detail, and ends the function", () => {
    expect(seg.startsWith("'sources_newly_dark'; threshold := 1; observed := null; detail := null; begin")).toBe(true);
    expect(seg.endsWith("end; return next; return; end")).toBe(true);
    expect(seg.match(/return next;/g)).toHaveLength(1);
  });

  it("looks at active outlet/wire sources that are not in the baseline", () => {
    expect(seg).toContain("select s.id, s.slug from public.sources s where s.active and s.kind in ('outlet', 'wire')");
    expect(seg).toContain(
      "and not exists (select 1 from public.ops_dark_source_baseline b where b.slug = s.slug)",
    );
  });

  it("counts articles per source over 14 days 12 hours, split at 12 hours, never past v_now", () => {
    expect(seg).toContain("from public.articles a where a.created_at >= v_now - interval '14 days 12 hours' and a.created_at <= v_now group by a.source_id");
    expect(seg).toContain(
      "pg_catalog.count(*) filter (where a.created_at < v_now - interval '12 hours') as prior_n",
    );
    expect(seg).toContain(
      "pg_catalog.count(*) filter (where a.created_at >= v_now - interval '12 hours') as recent_n",
    );
    expect([...seg.matchAll(/interval '14 days 12 hours'/g)]).toHaveLength(1);
    expect([...seg.matchAll(/interval '12 hours'/g)]).toHaveLength(2);
  });

  it("flags a source with at least 50 articles before the last 12 hours and none in them", () => {
    expect(seg).toContain("where c.prior_n >= 50 and c.recent_n = 0");
    expect(seg).toMatch(/>= 50/);
    // behavioural mirror of the predicate: 49 is not enough, one recent article clears it
    const flagged = (prior: number, recent: number) => prior >= 50 && recent === 0;
    expect(flagged(50, 0)).toBe(true);
    expect(flagged(49, 0)).toBe(false);
    expect(flagged(500, 1)).toBe(false);
    expect(flagged(0, 0)).toBe(false);
  });

  it("orders the named sources by their prior volume and shows it", () => {
    expect(seg).toContain(
      "pg_catalog.string_agg(v.slug || ' (' || c.prior_n::text || ')', ', ' order by c.prior_n desc, v.slug)",
    );
    expect(seg).toContain("into v_n, v_text");
    expect(seg).toContain("observed := v_n;");
  });

  it("is warn-only: status is warn or pass, and the word fail never appears", () => {
    expect(seg).toContain("status := case when v_n >= 1 then 'warn' else 'pass' end;");
    expect(seg).not.toMatch(/'fail'/);
    expect(seg).not.toMatch(/fail/);
    expect(seg).not.toMatch(/'skip'/);
  });

  it("reports both Turkish detail strings exactly, the long one cut to 500 characters", () => {
    expect(seg).toContain(
      "detail := case when v_n >= 1 then substr('son 12 saatte haber gelmedi (önceki 14 günde en az 50 haber vardı): ' || v_text, 1, 500) else 'yeni susan kaynak yok' end;",
    );
  });

  it("swallows errors (a missing baseline table included) into an unknown row", () => {
    expect(seg).toContain(
      "exception when others then status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200); end; return next;",
    );
  });
});

describe("114 ops_health_report: zone-map and source-kind parity with the bias-zone contract", () => {
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

describe("114 ops_health_report: exception handling", () => {
  it("has at least 11 'exception when others' blocks, each followed by a 'return next'", () => {
    expect([...healthCode.matchAll(/exception\s+when\s+others\s+then/gi)].length).toBeGreaterThanOrEqual(11);
    expect([...healthCode.matchAll(/end;\s*return\s+next\s*;/gi)].length).toBeGreaterThanOrEqual(11);
  });
});

describe("114 secrets", () => {
  it("bakes no secret into the file", () => {
    expect(sql).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(sql).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{20,}/);
  });
});

// ---------------------------------------------------------------------------
// Live behaviour (opt-in): row 13 against fixtures, on a throwaway Postgres
// with 114 applied and no other dark source. TAYF_PSQL is the psql binary and
// PGHOST/PGPORT/PGUSER/PGDATABASE select the server. Everything the fixtures
// write sits inside a transaction that is rolled back.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))("114 sources_newly_dark against fixtures (live Postgres)", () => {
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
    const ago = "now() - interval '1 day' - gs.g * interval '3 hours'";
    const hashCol = withHash ? ", content_hash" : "";
    const hashOf = (urlExpr: string) => (withHash ? `, md5(${urlExpr})` : "");
    const urlExpr = "'https://fx.invalid/' || s.slug || '/' || gs.g";
    return `
begin;
insert into public.sources (name, slug, url, rss_url, bias, kind, active) values
  ${src("fx-dark", "outlet", true)},
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
    join (values ('fx-dark', 60), ('fx-busy', 60), ('fx-small', 49), ('ntv', 60), ('fx-off', 60), ('fx-agg', 60)) v(slug, n)
      on v.slug = s.slug
   cross join lateral generate_series(0, v.n - 1) as gs(g);
insert into public.articles (source_id, title, url, published_at, created_at${hashCol})
  select s.id, 'fx fresh', 'https://fx.invalid/fx-busy/fresh', now() - interval '1 hour', now() - interval '1 hour'${hashOf("'https://fx.invalid/fx-busy/fresh'")}
    from public.sources s where s.slug = 'fx-busy';
${ROW_13}
delete from public.articles a using public.sources s where s.id = a.source_id and s.slug = 'fx-dark';
delete from public.sources where slug = 'fx-dark';
${ROW_13}
rollback;
`;
  }

  it("reports only the silent, non-baseline, active outlet with enough history; a second pass without it is pass", () => {
    const lines = runPsql(fixtureSql(articlesHaveContentHash()))
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    const first = parseRow(lines[0] as string);
    expect(first.check).toBe(CHECK_13);
    expect(first.status).toBe("warn");
    expect(first.observed).toBe("1");
    expect(first.threshold).toBe("1");
    expect(first.detail).toContain("fx-dark (60)");
    expect(first.detail.startsWith("son 12 saatte haber gelmedi (önceki 14 günde en az 50 haber vardı): ")).toBe(true);
    for (const other of ["fx-busy", "fx-small", "ntv", "fx-off", "fx-agg"]) {
      expect(first.detail, other).not.toContain(other);
    }

    const second = parseRow(lines[1] as string);
    expect(second.status).toBe("pass");
    expect(second.observed).toBe("0");
    expect(second.detail).toBe("yeni susan kaynak yok");
  });

  it("rolled the fixtures back", () => {
    const out = runPsql("select count(*) from public.sources where slug like 'fx-%';").trim();
    expect(out).toBe("0");
  });

  it("returns exactly 13 rows and sources_newly_dark is the last", () => {
    const count = runPsql("select count(*) from public.ops_health_report();").trim();
    expect(count).toBe("13");
    const names = runPsql("select check_name from public.ops_health_report();")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(names).toEqual(ROW_NAMES_13);
  });

  it("seeds the 25 baseline slugs and keeps them away from anon and authenticated", () => {
    expect(runPsql(`select count(*) from public.${TABLE};`).trim()).toBe("25");
    // anon and authenticated hold no privilege at all (default privileges included).
    // What service_role holds beyond SELECT comes from the environment's default
    // privileges, not from this migration, so only its SELECT is asserted.
    const privilegeNames = ["select", "insert", "update", "delete", "truncate", "references", "trigger"];
    for (const role of ["anon", "authenticated"]) {
      const checks = privilegeNames.map((p) => `has_table_privilege('${role}', 'public.${TABLE}', '${p}')`).join(", ");
      expect(runPsql(`select ${checks};`).trim(), role).toBe(privilegeNames.map(() => "f").join("|"));
    }
    expect(runPsql(`select has_table_privilege('service_role', 'public.${TABLE}', 'select');`).trim()).toBe("t");
  });
});
