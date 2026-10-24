import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 122 ("ops-ingest-gaps").
//
// ingest-drain runs every 3 minutes (038) and the ingest Edge Function writes
// its public.ingest_cycles row at the END of a cycle. A tick the platform kills
// (pg_net answers 546 WORKER_RESOURCE_LIMIT) writes no row at all, so row 3
// (ingest_cycles_30m, a count over 30 minutes) can read pass while ticks are
// lost. 122 re-creates ops_health_report() with 119's body verbatim for the
// header, the declare section and rows 1-13, and appends row 14, `ingest_gaps`:
// the number of gaps over 5 minutes between consecutive started_at in the last 6
// hours, warn only (3 or more gaps, or any gap over 10 minutes).
//
// This file pins:
//   * the migration is additive, grants nothing to anon/authenticated/public,
//     creates no table and ends with the ledger row in the 095 pattern;
//   * the text from the create line through row 13's last `return next;` is 119's,
//     byte for byte, comments included;
//   * row 14's contract (thresholds, window, strings, warn-only, exception
//     handler, last row);
//   * the schedule row 14's 5-minute reading depends on (038, never changed);
//   * the function comment is 119's with the two edits 122 makes.
// The last block (opt-in, TAYF_PSQL) runs row 14 against ingest_cycles fixtures
// in rolled-back transactions on a throwaway Postgres with 122 applied. Its
// helpers are copied from 119's test, not imported.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const MIGRATION_122 = resolve(MIGRATIONS_DIR, "122_ops_ingest_gaps.sql");
const MIGRATION_119 = resolve(MIGRATIONS_DIR, "119_feed_freshness.sql");
const MIGRATION_038 = resolve(MIGRATIONS_DIR, "038_cron_schedules.sql");

const CHECK_14 = "ingest_gaps";

const ROW_NAMES_14 = [
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
  "ingest_gaps",
];

const CREATE_LINE = "create or replace function public.ops_health_report()";
const MARKER_14 = "-- 14. ingest_gaps (migration 122).";

const DETAIL_NONE = "son 6 saatte ingest döngüsü yok";
const DETAIL_GAPS_PREFIX = "son 6 saatte 5 dakikadan uzun boşluk: ";
const DETAIL_CLEAN_PREFIX = "son 6 saatte 5 dakikadan uzun boşluk yok · en uzunu ";

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
  const idx = block.search(/\bas\s+\$[a-z]*\$/i);
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

/** The text of a `comment on function public.ops_health_report() is '...' '...';` statement, raw SQL in, string out. */
function commentText(rawSql: string): string {
  const start = rawSql.search(/comment\s+on\s+function\s+public\.ops_health_report\(\)\s+is\s*/i);
  expect(start, "comment on function ops_health_report").toBeGreaterThanOrEqual(0);
  let rest = rawSql.slice(start).replace(/^comment\s+on\s+function\s+public\.ops_health_report\(\)\s+is\s*/i, "");
  let out = "";
  for (;;) {
    const m = /^'((?:[^']|'')*)'\s*/.exec(rest);
    if (!m) break;
    out += (m[1] as string).replace(/''/g, "'");
    rest = rest.slice(m[0].length);
  }
  expect(rest.startsWith(";"), "the comment statement ends right after its last literal").toBe(true);
  return out;
}

let sql = "";
let code = "";
let healthBlock = "";
let healthBody = "";
let codeOutsideFn = "";
let sql119 = "";
let block119 = "";
let body119 = "";

beforeAll(() => {
  expect(existsSync(MIGRATION_122), "122_ops_ingest_gaps.sql must exist").toBe(true);
  sql = readFileSync(MIGRATION_122, "utf8");
  code = stripSqlComments(sql);
  healthBlock = functionBlock(code, "ops_health_report");
  healthBody = body(healthBlock);
  codeOutsideFn = code.replace(healthBlock, "");
  sql119 = readFileSync(MIGRATION_119, "utf8");
  block119 = functionBlock(stripSqlComments(sql119), "ops_health_report");
  body119 = body(block119);
});

describe("122 ledger, structure and header", () => {
  it("is one transaction: begin, ..., ledger insert, commit", () => {
    expect([...code.matchAll(/^\s*begin\s*;/gim)]).toHaveLength(1);
    expect([...code.matchAll(/^\s*commit\s*;/gim)]).toHaveLength(1);
    const ledger = code.search(/insert\s+into\s+supabase_migrations\.schema_migrations/i);
    expect(ledger).toBeGreaterThan(code.search(/grant\s+execute\s+on\s+function\s+public\.ops_health_report/i));
    expect(ledger).toBeLessThan(code.search(/^\s*commit\s*;/im));
    const afterLedger = code.slice(ledger).replace(/^[\s\S]*?on\s+conflict\s+do\s+nothing\s*;/i, "");
    expect(afterLedger.trim()).toBe("commit;");
    expect([...code.matchAll(/insert\s+into\s+supabase_migrations\.schema_migrations/gi)]).toHaveLength(1);
  });

  it("records itself as version '122' in the 095 pattern", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(version,\s*name\)\s*values\s*\(\s*'122'\s*,\s*'122_ops_ingest_gaps'\s*\)\s*on\s+conflict\s+do\s+nothing\s*;\s*commit\s*;\s*$/i,
    );
  });

  it("sanity: comment stripping is non-vacuous", () => {
    expect(sql.length).toBeGreaterThan(code.length);
    expect(sql).toMatch(/STEP 0/);
    expect(code).not.toMatch(/STEP 0/);
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

  it("the header documents WHY, WHAT, Step 0, both dry runs, deploy and rollback, with the 546 evidence", () => {
    const head = sql.slice(0, sql.search(/^\s*begin\s*;/im));
    for (const section of ["WHY", "WHAT CHANGES", "STEP 0", "DRY RUNS (×2)", "DEPLOY", "ROLLBACK"]) {
      expect(head, section).toContain(section);
    }
    expect(head).toMatch(/safe to re-apply/i);
    expect(head).toContain("546");
    expect(head).toContain("WORKER_RESOURCE_LIMIT");
    expect(head).toContain("ingest_gaps");
    expect(head).toContain("ingest-drain");
    // Step 0: version free; the deployed ops_health_report() is 119's, by md5
    expect(head).toMatch(/Version 122 is free/i);
    expect(head).toContain("c99eb293f647eb4706c420e1613020f7");
    // the baseline the thresholds were checked against
    expect(head).toMatch(/baseline/i);
    expect(head).toMatch(/INSERT 0 0/);
    expect(head).toMatch(/14 rows/);
    expect(head).toMatch(/service_role only/i);
    // rollback re-applies 119's block and removes the ledger row
    expect(head).toContain("119_feed_freshness.sql");
    expect(head).toMatch(/ledger row 122/i);
    // what to do when it warns
    expect(head).toMatch(/net\._http_response/);
  });
});

describe("122 additive shape", () => {
  it("creates no table, alters nothing, drops nothing, schedules nothing and writes only the ledger row outside the function", () => {
    expect(code).not.toMatch(/\bcreate\s+table\b/i);
    expect(code).not.toMatch(/\balter\s+(table|sequence|view)\b/i);
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(codeOutsideFn).not.toMatch(/\b(delete|truncate|update|vacuum|analyze)\b/i);
    expect(code).not.toMatch(/\bcron\.(schedule|alter_job|unschedule)\b/i);
    const inserts = [...codeOutsideFn.matchAll(/\binsert\s+into\s+([a-z_.]+)/gi)].map((m) => m[1]);
    expect(inserts).toEqual(["supabase_migrations.schema_migrations"]);
  });

  it("re-creates exactly one function, ops_health_report(), with create or replace", () => {
    const creates = [...code.matchAll(/\bcreate\s+(or\s+replace\s+)?function\s+([a-z_.]+)/gi)];
    expect(creates).toHaveLength(1);
    expect(creates[0]?.[1]).toBeTruthy();
    expect(creates[0]?.[2]).toBe("public.ops_health_report");
  });

  it("grants nothing to anon, authenticated or public; execute goes to service_role only, exactly once", () => {
    expect(code).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.ops_health_report\(\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*;/i,
    );
    const grants = [...code.matchAll(/\bgrant\b[^;]*;/gi)].map((m) => m[0].replace(/\s+/g, " "));
    expect(grants).toEqual(["grant execute on function public.ops_health_report() to service_role;"]);
    expect(code).not.toMatch(/\bgrant\b[^;]*\bto\b[^;]*\b(anon|authenticated|public)\b/i);
  });

  it("keeps the function header: returns table, plpgsql, volatile, security definer, search_path = ''", () => {
    expect(header(healthBlock).replace(/\s+/g, " ").trim()).toBe(header(block119).replace(/\s+/g, " ").trim());
    const h = header(healthBlock);
    expect(h).toMatch(/security\s+definer/i);
    expect(h).toMatch(/set\s+search_path\s*=\s*''/i);
    expect(h).toMatch(/\bvolatile\b/i);
    expect(h).toMatch(/language\s+plpgsql/i);
  });

  it("keeps the #variable_conflict directive and the declare block of 119 (row 14 reuses v_n, v_total, v_zero and v_text)", () => {
    expect(healthBody).toMatch(/^\s*#variable_conflict use_column\b/);
    expect(declareSection(healthBody)).toBe(declareSection(body119));
  });
});

describe("122 rows 1-13 are 119's, byte for byte", () => {
  it("the raw text from the create line through row 13's last `return next;` equals 119's (comments included)", () => {
    const from122 = sql.slice(sql.indexOf(CREATE_LINE));
    const idx122 = from122.indexOf(MARKER_14);
    expect(idx122, "row 14 marker comment").toBeGreaterThan(0);
    const prefix122 = from122.slice(0, idx122).trimEnd();

    const from119 = sql119.slice(sql119.indexOf(CREATE_LINE));
    const end119 = from119.lastIndexOf("return next;") + "return next;".length;
    expect(from119.slice(end119).trim().startsWith("return;"), "119 ends with `return;` after row 13").toBe(true);
    const prefix119 = from119.slice(0, end119);

    expect(prefix122.endsWith("return next;")).toBe(true);
    expect(prefix122).toBe(prefix119);
  });

  it("the literal check names are 119's followed by ingest_gaps", () => {
    const names = (b: string) => [...stripSqlComments(b).matchAll(/check_name\s*:=\s*'([a-z0-9_]+)'\s*;/gi)].map((m) => m[1]);
    expect(names(healthBody)).toEqual([...names(body119), CHECK_14]);
  });

  it("the segments of rows 1-13 are identical to 119's", () => {
    const s122 = segments(healthBody);
    const s119 = segments(body119);
    expect(s122).toHaveLength(s119.length + 1);
    for (let i = 0; i < s119.length - 1; i++) {
      expect(norm(s122[i] as string), `segment ${i}`).toBe(norm(s119[i] as string));
    }
    // row 13 is the last segment of 119; in 122 it ends where row 14's comment begins
    const row13of122 = norm(s122[s119.length - 1] as string);
    expect(row13of122).toBe(norm(s119[s119.length - 1] as string).replace(/\s*return;\s*end$/, "").trim());
  });
});

describe("122 row 14: ingest_gaps", () => {
  let seg = "";
  let segN = "";

  beforeAll(() => {
    seg = segmentFor(healthBody, CHECK_14);
    segN = norm(seg);
  });

  it("is the last check: it follows row 13 and precedes `return;`", () => {
    const parts = segments(healthBody).slice(1);
    expect(segmentName(parts[parts.length - 1] as string)).toBe(CHECK_14);
    expect(segmentName(parts[parts.length - 2] as string)).toBe("sources_newly_dark");
    // the last `return next;` of the function belongs to row 14, and `return; end` follows it
    expect(norm(healthBody).endsWith("return next; return; end")).toBe(true);
    expect(segN.endsWith("return next; return; end")).toBe(true);
    expect([...segN.matchAll(/\breturn next;/g)]).toHaveLength(1);
  });

  it("the row marker comment names the migration, the 546 cause, the schedule and warn-only", () => {
    const m = new RegExp(`${MARKER_14.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*`).exec(sql);
    expect(m, "row 14 marker").not.toBeNull();
    const comment = (m as RegExpExecArray)[0];
    for (const word of ["546", "WORKER_RESOURCE_LIMIT", "ingest_cycles", "row 3", "*/3", "038", "5 minutes", "Warn only"]) {
      expect(comment, word).toContain(word);
    }
  });

  it("sets threshold 3, observed null and detail null up front", () => {
    expect(segN.startsWith("'ingest_gaps'; threshold := 3; observed := null; detail := null;")).toBe(true);
  });

  it("reads the last 6 hours of ingest_cycles, started_at against the same clock as the other rows (v_now)", () => {
    expect(segN).toContain("from public.ingest_cycles c");
    expect(segN).toContain("c.started_at >= v_now - interval '6 hours'");
    expect(segN).toContain("c.started_at <= v_now");
    // the finished_at bound keeps the descending finished_at index in play and tolerates a 15 minute cycle
    expect(segN).toContain("c.finished_at >= v_now - interval '6 hours 15 minutes'");
  });

  it("measures the gap between consecutive started_at with lag(c.started_at) over (order by c.started_at)", () => {
    expect(segN).toContain("lag(c.started_at) over (order by c.started_at)");
    expect(segN).toMatch(/c\.started_at - pg_catalog\.lag\(c\.started_at\) over \(order by c\.started_at\) as gap/);
  });

  it("counts gaps over 5 minutes and warns at 3 or more gaps or any gap over 10 minutes", () => {
    expect(segN).toContain("count(*) filter (where s.gap > interval '5 minutes')");
    expect(segN).toContain("when v_n >= 3 or coalesce(v_zero, 0) > 10 then 'warn' else 'pass'");
    expect(segN).toContain("max(s.gap)");
    // the longest gap is reported in minutes, trailing zeros trimmed (3, not 3.0)
    expect(segN).toContain("pg_catalog.trim_scale(round(extract(epoch from pg_catalog.max(s.gap)) / 60.0, 1))");
  });

  it("lists each gap as HH24:MI→HH24:MI in UTC, longest first, only for gaps over 5 minutes", () => {
    expect(segN).toContain("pg_catalog.to_char((s.started_at - s.gap) at time zone 'UTC', 'HH24:MI')");
    expect(segN).toContain("'→'");
    expect(segN).toContain("pg_catalog.to_char(s.started_at at time zone 'UTC', 'HH24:MI')");
    expect(segN).toContain("order by s.gap desc, s.started_at) filter (where s.gap > interval '5 minutes')");
  });

  it("selects into v_total, v_n, v_zero, v_text, in that order, and sets observed := v_n", () => {
    expect(segN).toContain("into v_total, v_n, v_zero, v_text from s;");
    expect(segN).toContain("observed := v_n;");
    expect(segN).toContain("v_n := null; v_total := null; v_zero := null; v_text := null;");
  });

  it("an empty window is a warn with observed null and the exact Turkish detail", () => {
    expect(segN).toContain(
      `if coalesce(v_total, 0) = 0 then status := 'warn'; observed := null; detail := '${DETAIL_NONE}';`,
    );
  });

  it("carries the three Turkish detail strings exactly, and cuts the gap list at 500 characters", () => {
    expect(segN).toContain(`'${DETAIL_NONE}'`);
    expect(segN).toContain(`substr('${DETAIL_GAPS_PREFIX}' || v_n::text || ' · en uzunu ' || coalesce(v_zero, 0)::text || ' dk · ' || v_text || ' (UTC)', 1, 500)`);
    expect(segN).toContain(`'${DETAIL_CLEAN_PREFIX}' || coalesce(v_zero, 0)::text || ' dk'`);
    expect(segN).toContain("detail := case when v_n >= 1 then substr(");
  });

  it("is warn-only: it never assigns 'fail' and never mentions it", () => {
    expect(segN).not.toMatch(/status\s*:=\s*'fail'/);
    expect(segN).not.toContain("'fail'");
    expect(segN).toContain("'warn'");
    expect(segN).toContain("'pass'");
  });

  it("answers 'unknown' with the first 200 characters of the error if the query fails", () => {
    expect(segN).toContain(
      "exception when others then status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200); end; return next;",
    );
  });

  it("qualifies every catalogue function: no unqualified count, max, lag, to_char or string_agg", () => {
    for (const fn of ["count", "max", "lag", "to_char", "string_agg", "trim_scale"]) {
      const bare = new RegExp(`(?<![.\\w])${fn}\\s*\\(`, "g");
      expect([...segN.matchAll(bare)], fn).toEqual([]);
    }
  });

  it("only reads: no insert, update, delete or execute in the row", () => {
    expect(segN).not.toMatch(/\b(insert|update|delete|truncate|execute)\b/i);
  });
});

describe("122 function comment", () => {
  let c119 = "";
  let c122 = "";
  beforeAll(() => {
    c119 = commentText(sql119);
    c122 = commentText(sql.slice(sql.search(/^\s*begin\s*;/im)));
  });

  it("is 119's text with the migration list and the row count updated", () => {
    expect(c119).toContain("(migrations 077, 100, 103, 108, 114, 115, 119): 13 fixed rows");
    expect(c122).toContain("(migrations 077, 100, 103, 108, 114, 115, 119, 122): 14 fixed rows");
    expect(c122).not.toContain("13 fixed rows");
  });

  it("keeps everything 119 said, in order, and adds the ingest_gaps description before ' status is one of'", () => {
    const expected119 = c119.replace("115, 119): 13 fixed rows", "115, 119, 122): 14 fixed rows");
    const [head, tail] = expected119.split(" status is one of") as [string, string];
    expect(head.endsWith("included)).")).toBe(true);
    const keep = head.slice(0, -1); // up to and including "included))"
    expect(c122.startsWith(keep)).toBe(true);
    expect(c122.endsWith(` status is one of${tail}`)).toBe(true);
    const added = c122.slice(keep.length, c122.length - ` status is one of${tail}`.length);
    expect(added).toContain("ingest_gaps");
    expect(added).toContain("ingest_cycles.started_at");
    expect(added).toContain("5 minutes");
    expect(added).toContain("6 hours");
    expect(added).toMatch(/3 or more gaps/);
    expect(added).toMatch(/over 10 minutes/);
    expect(added).toMatch(/warn only|never fail/i);
    // still read-only, still service_role only
    expect(c122).toContain("service_role only");
    expect(c122).toContain("docs/ops-heartbeat.md");
  });
});

describe("122 relies on the ingest-drain schedule of 038", () => {
  it("038 schedules 'ingest-drain' at '*/3 * * * *'", () => {
    const sql038 = stripSqlComments(readFileSync(MIGRATION_038, "utf8")).replace(/\s+/g, " ");
    expect(sql038).toMatch(/perform cron\.schedule\( 'ingest-drain', '\*\/3 \* \* \* \*',/);
  });

  it("no later migration schedules, alters or unschedules 'ingest-drain' (a changed cadence would make the 5 minute reading wrong)", () => {
    const later = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{3}_.+\.sql$/.test(f) && parseInt(f, 10) > 38)
      .sort();
    expect(later.length).toBeGreaterThan(50);
    const offenders: string[] = [];
    for (const f of later) {
      const text = stripSqlComments(readFileSync(resolve(MIGRATIONS_DIR, f), "utf8")).replace(/\s+/g, " ");
      for (const m of text.matchAll(/cron\.(schedule|alter_job|unschedule)\s*\(([^;]*?);/gi)) {
        if ((m[2] as string).includes("ingest-drain")) offenders.push(`${f}: cron.${m[1]}`);
      }
      if (/update\s+cron\.job\b[^;]*ingest-drain/i.test(text)) offenders.push(`${f}: update cron.job`);
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Live behaviour (opt-in): row 14 against ingest_cycles fixtures, on a
// throwaway Postgres with 122 applied (twice). TAYF_PSQL is the psql binary and
// PGHOST/PGPORT/PGUSER/PGDATABASE select the server. Everything the fixtures
// write sits inside a transaction that is rolled back.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))("122 ingest_gaps against fixtures (live Postgres)", () => {
  function runPsql(input: string): string {
    return execFileSync(process.env.TAYF_PSQL as string, ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      input,
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8" },
      maxBuffer: 8 * 1024 * 1024,
    });
  }

  let cyclesBefore = "";
  beforeAll(() => {
    cyclesBefore = runPsql("select count(*) from public.ingest_cycles;").trim();
  });

  /** Minutes before (now - 30 s) at which a tick starts: every 3 minutes over 6 h 30 min, minus the skipped ones. */
  function ticks(skip: readonly number[], extra: readonly number[] = []): number[] {
    const out: number[] = [];
    for (let m = 0; m <= 390; m += 3) if (!skip.includes(m)) out.push(m);
    return [...out, ...extra].sort((a, b) => a - b);
  }

  /** The instant `m` minutes before the fixture clock, as HH24:MI UTC, computed in SQL from the fixture formula (not from the function under test). */
  const at = (m: number) =>
    `pg_catalog.to_char((now() - interval '30 seconds' - ${m} * interval '1 minute') at time zone 'UTC', 'HH24:MI')`;

  /** `HH:MI→HH:MI` for a gap between an older tick (m1 minutes back) and the next newer tick (m2 minutes back). */
  const gap = (older: number, newer: number) => `${at(older)} || '→' || ${at(newer)}`;

  interface Run {
    status: string;
    observed: string;
    threshold: string;
    detail: string;
    expected: string;
  }

  /** Runs row 14 on a fixture (tick offsets in minutes) and, in SQL, builds the expected gap list. */
  function run(offsets: readonly number[] | null, expectedGaps: ReadonlyArray<readonly [number, number]> = []): Run {
    const insert =
      offsets === null
        ? "delete from public.ingest_cycles;"
        : `delete from public.ingest_cycles;
insert into public.ingest_cycles (started_at, finished_at)
  select now() - interval '30 seconds' - m * interval '1 minute',
         now() - interval '30 seconds' - m * interval '1 minute' + interval '20 seconds'
    from unnest(array[${offsets.join(",")}]::int[]) as m;`;
    const expected = expectedGaps.length === 0 ? "''" : expectedGaps.map(([o, n]) => `(${gap(o, n)})`).join(" || ', ' || ");
    const out = runPsql(`
begin;
${insert}
select 'exp', ${expected};
select 'row', check_name, status, coalesce(observed::text, ''), threshold, coalesce(detail, '') from public.ops_health_report() where check_name = '${CHECK_14}';
rollback;
`);
    const lines = out.split("\n").filter((l) => l.length > 0);
    const exp = lines.find((l) => l.startsWith("exp|")) as string;
    const row = lines.filter((l) => l.startsWith("row|"));
    expect(row).toHaveLength(1);
    const [, name, status, observed, threshold, ...rest] = (row[0] as string).split("|");
    expect(name).toBe(CHECK_14);
    return {
      status: status as string,
      observed: observed as string,
      threshold: threshold as string,
      detail: rest.join("|"),
      expected: exp.slice("exp|".length),
    };
  }

  it("the target database runs 122: the ledger row is there and the function carries row 14", () => {
    expect(runPsql("select count(*) from supabase_migrations.schema_migrations where version = '122';").trim()).toBe("1");
    expect(runPsql("select prosrc like '%ingest_gaps%' from pg_proc where oid = 'public.ops_health_report()'::regprocedure;").trim()).toBe("t");
  });

  it("a clean 3 minute cadence over 6 hours passes: observed 0, 'boşluk yok · en uzunu 3 dk'", () => {
    const r = run(ticks([]));
    expect(r.status).toBe("pass");
    expect(r.observed).toBe("0");
    expect(r.threshold).toBe("3");
    expect(r.detail).toBe(`${DETAIL_CLEAN_PREFIX}3 dk`);
  });

  it("one 6 minute gap and one 12 minute gap warn (the 12 minute one is over 10): observed 2, longest first", () => {
    // skipping m = 60 leaves ticks at 63 and 57 (6 minutes apart); skipping 195, 198 and 201 leaves 204 and 192 (12 minutes)
    const r = run(ticks([60, 195, 198, 201]), [
      [204, 192],
      [63, 57],
    ]);
    expect(r.status).toBe("warn");
    expect(r.observed).toBe("2");
    expect(r.threshold).toBe("3");
    expect(r.detail).toBe(`${DETAIL_GAPS_PREFIX}2 · en uzunu 12 dk · ${r.expected} (UTC)`);
  });

  it("three 6 minute gaps warn (3 or more gaps), earliest first when equally long: observed 3", () => {
    const r = run(ticks([60, 150, 240]), [
      [243, 237],
      [153, 147],
      [63, 57],
    ]);
    expect(r.status).toBe("warn");
    expect(r.observed).toBe("3");
    expect(r.detail).toBe(`${DETAIL_GAPS_PREFIX}3 · en uzunu 6 dk · ${r.expected} (UTC)`);
  });

  it("two 6 minute gaps pass, and the detail still names them", () => {
    const r = run(ticks([60, 150]), [
      [153, 147],
      [63, 57],
    ]);
    expect(r.status).toBe("pass");
    expect(r.observed).toBe("2");
    expect(r.detail).toBe(`${DETAIL_GAPS_PREFIX}2 · en uzunu 6 dk · ${r.expected} (UTC)`);
  });

  it("a gap of exactly 10 minutes passes, one of 11 minutes warns (over 10)", () => {
    // skipping 60, 63 and 66 and adding 67 leaves ticks at 67 and 57, 10 minutes apart (69 -> 67 is 2 minutes)
    const ten = run(ticks([60, 63, 66], [67]), [[67, 57]]);
    expect(ten.status).toBe("pass");
    expect(ten.observed).toBe("1");
    expect(ten.detail).toBe(`${DETAIL_GAPS_PREFIX}1 · en uzunu 10 dk · ${ten.expected} (UTC)`);
    const eleven = run(ticks([60, 63, 66], [68]), [[68, 57]]);
    expect(eleven.status).toBe("warn");
    expect(eleven.observed).toBe("1");
    expect(eleven.detail).toBe(`${DETAIL_GAPS_PREFIX}1 · en uzunu 11 dk · ${eleven.expected} (UTC)`);
  });

  it("a gap that straddles the start of the 6 hour window is not counted (its older tick is outside the window)", () => {
    // the window starts at m = 360; skipping 357, 354, 351 and 348 leaves a 15 minute hole between the tick at 360 (outside) and 345 (the first inside)
    const r = run(ticks([357, 354, 351, 348]));
    expect(r.status).toBe("pass");
    expect(r.observed).toBe("0");
    expect(r.detail).toBe(`${DETAIL_CLEAN_PREFIX}3 dk`);
  });

  it("an empty ingest_cycles table warns with observed null and 'son 6 saatte ingest döngüsü yok'", () => {
    const r = run(null);
    expect(r.status).toBe("warn");
    expect(r.observed).toBe("");
    expect(r.threshold).toBe("3");
    expect(r.detail).toBe(DETAIL_NONE);
  });

  it("a single cycle in the window has no gap: pass, observed 0, 'en uzunu 0 dk'", () => {
    const r = run([5]);
    expect(r.status).toBe("pass");
    expect(r.observed).toBe("0");
    expect(r.detail).toBe(`${DETAIL_CLEAN_PREFIX}0 dk`);
  });

  it("many long gaps cut the detail at 500 characters", () => {
    // one tick every 7 minutes: ~51 gaps of 7 minutes
    const offsets: number[] = [];
    for (let m = 0; m <= 390; m += 7) offsets.push(m);
    const r = run(offsets);
    expect(r.status).toBe("warn");
    expect(Number(r.observed)).toBeGreaterThan(40);
    expect(r.detail.length).toBe(500);
    expect(r.detail.startsWith(DETAIL_GAPS_PREFIX)).toBe(true);
  });

  it("rolled the fixtures back", () => {
    expect(runPsql("select count(*) from public.ingest_cycles;").trim()).toBe(cyclesBefore);
  });

  it("returns exactly 14 rows, in order, and ingest_gaps is the last", () => {
    expect(runPsql("select count(*) from public.ops_health_report();").trim()).toBe("14");
    const names = runPsql("select check_name from public.ops_health_report();")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(names).toEqual(ROW_NAMES_14);
  });

  it("service_role only may execute; security definer; volatile; search_path is empty", () => {
    expect(
      runPsql(
        "select has_function_privilege('anon', 'public.ops_health_report()', 'execute'), has_function_privilege('authenticated', 'public.ops_health_report()', 'execute'), has_function_privilege('service_role', 'public.ops_health_report()', 'execute');",
      ).trim(),
    ).toBe("f|f|t");
    expect(runPsql(`select prosecdef, provolatile, proconfig = array['search_path=""']::text[] from pg_proc where oid = 'public.ops_health_report()'::regprocedure;`).trim()).toBe(
      "t|v|t",
    );
  });
});
