import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 150 ("ops-queue-cron-liveness"), h24-ops-1.
//
// ops_health_report() watched neither clustering nor the pg_cron jobs themselves: a
// stalled cluster_work / image_backfill queue, a poison message, an unscheduled or
// deactivated job, all read green. 150 re-creates the function with two more rows,
// 18 `queue_lag` (pgmq depth, oldest visible message, poison messages archived in 24 h)
// and 19 `cron_jobs_stalled` (the jobs listed in the new table public.ops_cron_expected
// against cron.job and the newest cron.job_run_details row), and adds that table.
//
// This file pins: the table (RLS, no policy, service_role select only, the PG17-guarded
// maintain revoke), its seed (a literal list, each name present in another migration so
// the list cannot drift, each gap following the max_gap rule of the header), rows 1-17
// as 145's text (the byte identity is also pinned by tests/guards/ops-health-checks.test.ts),
// the two new rows' contracts, the function header / comment / revoke / grant, the ledger
// pattern, the header's documented evidence, and docs/ops-heartbeat.md. It is static; the
// live block at the end runs the same scenarios as the dry run through psql when
// TAYF_PSQL is set (see the DRY RUNS of the migration header).
//
// SQL is scanned by character, never with a nested-quantifier regex (CodeQL).
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const MIGRATION_150_NAME = "150_ops_queue_and_cron_liveness.sql";
const MIGRATION_150 = resolve(MIGRATIONS_DIR, MIGRATION_150_NAME);
const MIGRATION_145 = resolve(MIGRATIONS_DIR, "145_ops_anon_surface_check.sql");
const DOC_MIGRATION_GUIDE = resolve(ROOT, "docs", "migration-guide.md");
const DOC_OPS_HEARTBEAT = resolve(ROOT, "docs", "ops-heartbeat.md");
const DRYRUN = resolve(ROOT, "tests", "migrations", "sql", "150-ops-queue-cron-liveness-dryrun.sql");

const CHECK_18 = "queue_lag";
const CHECK_19 = "cron_jobs_stalled";

const ROW_NAMES_17 = [
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
  "cron_route_failures_30m",
  "db_size_mb",
  "anon_surface",
];

const CREATE_LINE = "create or replace function public.ops_health_report()";
const MARKER_18 = "-- 18. queue_lag (migration 150).";
const MARKER_19 = "-- 19. cron_jobs_stalled (migration 150).";
/** What follows the last row's `return next;`. */
const FN_END = "\n\n  return;\nend\n$fn$;";

const REVOKE_STMT = "revoke all on function public.ops_health_report() from public, anon, authenticated";
const GRANT_STMT = "grant execute on function public.ops_health_report() to service_role";

const TABLE_STMT =
  "create table if not exists public.ops_cron_expected ( jobname text primary key, max_gap interval not null check (max_gap > interval '0'), note text )";

const COMMENT_PREFIX_145 =
  "Read-only ops heartbeat (migrations 077, 100, 103, 108, 114, 115, 119, 122, 136, 145): 17 fixed rows, in this order --";
const COMMENT_PREFIX_150 =
  "Read-only ops heartbeat (migrations 077, 100, 103, 108, 114, 115, 119, 122, 136, 145, 150): 19 fixed rows, in this order --";
const COMMENT_STATUS_MARK = " status is one of";

/** The runid window of row 19: the newest N run ids of cron.job_run_details (about 1.5 x the runs of 26 hours). */
const RUN_WINDOW = 7000;

/** The seeded list, pinned: jobname, max_gap literal, schedule (the note). Each is an active job on production (Step 0 c). */
const EXPECTED_SEED: Array<[string, string, string]> = [
  ["cluster-drain", "10 minutes", "* * * * *"],
  ["ingest-drain", "15 minutes", "*/3 * * * *"],
  ["image-drain", "20 minutes", "*/5 * * * *"],
  ["kap-drain", "15 minutes", "*/2 * * * *"],
  ["ops-health-snapshot", "30 minutes", "4-59/10 * * * *"],
  ["cluster-topics-refresh", "30 minutes", "3-59/10 * * * *"],
  ["framing-candidate-pool-refresh", "20 minutes", "*/5 * * * *"],
  ["source-karne-refresh", "1 hour", "*/15 * * * *"],
  ["net-response-compact", "1 hour", "*/15 * * * *"],
  ["articles-vacuum", "2 hours", "15,45 * * * *"],
  ["trends-rollup-refresh", "3 hours", "25 * * * *"],
  ["weekly-words-sample", "3 hours", "38 * * * *"],
  ["cron-log-compact", "3 hours", "35 * * * *"],
  ["image-backfill-requeue", "3 hours", "17 * * * *"],
  ["clusters-vacuum", "7 hours", "35 */6 * * *"],
  ["prune-nightly", "26 hours", "10 4 * * *"],
  ["reader-data-purge", "26 hours", "40 4 * * *"],
  ["ops-exhaust-prune", "26 hours", "40 4 * * *"],
  ["jev-shadow-prune", "26 hours", "50 4 * * *"],
  ["ops-cron-route-runs-prune", "26 hours", "17 4 * * *"],
];

// -- character-scan helpers (no regular expression runs over SQL text) ----------

/** Removes `--` comments (to the end of the line, newline kept); quoted strings are copied verbatim. */
function stripComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql.charAt(i);
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql.charAt(j) === "'") {
          if (sql.charAt(j + 1) === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "-" && sql.charAt(i + 1) === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? sql.length : nl;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

function isTagChar(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

/** Top-level statements of comment-free SQL; `;` inside strings and dollar-quoted bodies is kept. */
function splitStatements(code: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < code.length) {
    const ch = code.charAt(i);
    if (ch === "'") {
      let j = i + 1;
      while (j < code.length) {
        if (code.charAt(j) === "'") {
          if (code.charAt(j + 1) === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      i = j + 1;
    } else if (ch === "$") {
      let j = i + 1;
      while (j < code.length && isTagChar(code.charAt(j))) j += 1;
      if (code.charAt(j) === "$") {
        const tag = code.slice(i, j + 1);
        const close = code.indexOf(tag, j + 1);
        i = close < 0 ? code.length : close + tag.length;
      } else {
        i += 1;
      }
    } else if (ch === ";") {
      out.push(code.slice(start, i).trim());
      start = i + 1;
      i += 1;
    } else {
      i += 1;
    }
  }
  const tail = code.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/** Empties the content of every single-quoted string: `'abc'` becomes `''`. */
function blankStrings(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql.charAt(i);
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql.charAt(j) === "'") {
          if (sql.charAt(j + 1) === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      out += "''";
      i = j + 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** The contents of every single-quoted string, in order (`''` inside one is an escaped quote). */
function quotedStrings(sql: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < sql.length) {
    if (sql.charAt(i) !== "'") {
      i += 1;
      continue;
    }
    let cur = "";
    let j = i + 1;
    while (j < sql.length) {
      if (sql.charAt(j) === "'") {
        if (sql.charAt(j + 1) === "'") {
          cur += "'";
          j += 2;
          continue;
        }
        break;
      }
      cur += sql.charAt(j);
      j += 1;
    }
    out.push(cur);
    i = j + 1;
  }
  return out;
}

function collapse(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

/** Comment-free, whitespace-collapsed form. */
function norm(sql: string): string {
  return collapse(stripComments(sql));
}

/** Lower-case identifier-like words of the text, in order. */
function wordsOf(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of text.toLowerCase()) {
    if ((ch >= "a" && ch <= "z") || ch === "_" || (ch >= "0" && ch <= "9")) {
      cur += ch;
    } else if (cur) {
      out.push(cur);
      cur = "";
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Whether `word` occurs in the text as a whole word (so `grantee` is not `grant`). */
function hasWord(text: string, word: string): boolean {
  return wordsOf(text).includes(word);
}

/** True when every fragment occurs in the text, each after the previous one. */
function inOrder(text: string, fragments: string[]): boolean {
  let at = 0;
  for (const f of fragments) {
    const found = text.indexOf(f, at);
    if (found < 0) return false;
    at = found + f.length;
  }
  return true;
}

/** How many times `needle` occurs in `text` (non-overlapping). */
function countOf(text: string, needle: string): number {
  let n = 0;
  let at = text.indexOf(needle);
  while (at >= 0) {
    n += 1;
    at = text.indexOf(needle, at + needle.length);
  }
  return n;
}

/** The ROLLBACK paragraph of the header (to the "Additive." line), whitespace-collapsed. */
function rollbackOf(head: string): string {
  const at = head.indexOf("ROLLBACK (");
  expect(at, "ROLLBACK section").toBeGreaterThan(0);
  const end = head.indexOf("Additive. Safe to re-apply", at);
  return collapse(
    head
      .slice(at, end < 0 ? head.length : end)
      .split("\n")
      .map((l) => (l.startsWith("--") ? l.slice(2) : l))
      .join(" "),
  );
}

/** The literal check names of a function body, in order (`check_name := 'x';`; the loop's concatenation is not literal). */
function literalCheckNames(body: string): string[] {
  const names: string[] = [];
  const key = "check_name := '";
  let at = body.indexOf(key);
  while (at >= 0) {
    const from = at + key.length;
    const end = body.indexOf("'", from);
    if (body.charAt(end + 1) === ";") names.push(body.slice(from, end));
    at = body.indexOf(key, end);
  }
  return names;
}

/** The joined text of `comment on function public.ops_health_report() is '...' '...';` (adjacent literals). */
function commentText(rawSql: string): string {
  const head = "comment on function public.ops_health_report() is";
  const start = rawSql.indexOf(head);
  expect(start, "comment on function public.ops_health_report()").toBeGreaterThanOrEqual(0);
  let i = start + head.length;
  let out = "";
  for (;;) {
    while (i < rawSql.length && (rawSql.charAt(i) === " " || rawSql.charAt(i) === "\n")) i += 1;
    if (rawSql.charAt(i) !== "'") break;
    i += 1;
    for (;;) {
      const ch = rawSql.charAt(i);
      if (ch === "'") {
        if (rawSql.charAt(i + 1) === "'") {
          out += "'";
          i += 2;
          continue;
        }
        i += 1;
        break;
      }
      out += ch;
      i += 1;
    }
  }
  expect(rawSql.charAt(i), "the comment statement ends right after its last literal").toBe(";");
  return out;
}

/** The smallest gap in minutes between two firings of a simple cron schedule (the forms the seed uses). */
function tickMinutes(schedule: string): number {
  const fields = schedule.split(" ");
  expect(fields, schedule).toHaveLength(5);
  const minute = fields[0] as string;
  const hour = fields[1] as string;
  if (hour.startsWith("*/")) return Number(hour.slice(2)) * 60;
  if (hour !== "*") return 24 * 60; // one fixed hour, every day
  if (minute === "*") return 1;
  if (minute.includes("/")) return Number(minute.slice(minute.indexOf("/") + 1));
  if (minute.includes(",")) {
    const marks = minute.split(",").map(Number);
    let best = 60 - (marks[marks.length - 1] as number) + (marks[0] as number);
    for (let i = 1; i < marks.length; i++) best = Math.min(best, (marks[i] as number) - (marks[i - 1] as number));
    return best;
  }
  return 60; // one fixed minute, every hour
}

/** "10 minutes" / "1 hour" / "26 hours" in minutes. */
function gapMinutes(gap: string): number {
  const [n, unit] = gap.split(" ");
  const value = Number(n);
  if (unit === "minutes" || unit === "minute") return value;
  if (unit === "hours" || unit === "hour") return value * 60;
  throw new Error(`unknown interval literal: ${gap}`);
}

let sql = "";
let code = "";
let statements: string[] = [];
let sql145 = "";
let rowsOneToSeventeen = ""; // A: 145's text from the create line through row 17's `return next;`
let aAt = -1;
let newRowsRaw = "";
let fnStatement = "";
let fnBody = "";
let row18Raw = "";
let row19Raw = "";
let row18 = "";
let row19 = "";
let head = "";

beforeAll(() => {
  expect(existsSync(MIGRATION_150), `${MIGRATION_150_NAME} must exist`).toBe(true);
  sql = readFileSync(MIGRATION_150, "utf8");
  code = stripComments(sql);
  statements = splitStatements(code);
  sql145 = readFileSync(MIGRATION_145, "utf8");
  head = sql.slice(0, sql.search(/^begin;/m));

  // the last occurrence: 145's rollback paragraph quotes the create line in a comment
  const from145 = sql145.lastIndexOf(CREATE_LINE);
  const end145 = sql145.indexOf(FN_END, from145);
  expect(from145).toBeGreaterThan(0);
  expect(end145).toBeGreaterThan(from145);
  rowsOneToSeventeen = sql145.slice(from145, end145);

  aAt = sql.indexOf(rowsOneToSeventeen);
  const rowStart = aAt + rowsOneToSeventeen.length;
  const rowEnd = sql.indexOf(FN_END, rowStart);
  newRowsRaw = aAt < 0 || rowEnd < 0 ? "" : sql.slice(rowStart, rowEnd);
  const at19 = newRowsRaw.indexOf(MARKER_19);
  row18Raw = at19 < 0 ? newRowsRaw : newRowsRaw.slice(0, at19);
  row19Raw = at19 < 0 ? "" : newRowsRaw.slice(at19);
  row18 = norm(row18Raw);
  row19 = norm(row19Raw);

  fnStatement = statements.find((s) => s.startsWith(CREATE_LINE)) ?? "";
  const open = fnStatement.indexOf("$fn$");
  const close = fnStatement.lastIndexOf("$fn$");
  fnBody = open >= 0 && close > open ? fnStatement.slice(open + "$fn$".length, close) : "";
});

describe("150 helpers (the scans are not vacuous)", () => {
  it("stripComments drops -- outside strings and keeps it inside them", () => {
    expect(stripComments("a -- c\nb")).toBe("a \nb");
    expect(stripComments("select '-- not a comment'; -- real\nx")).toBe("select '-- not a comment'; \nx");
    expect(stripComments("-- only a comment")).toBe("");
  });

  it("splitStatements keeps ; inside strings and dollar-quoted bodies", () => {
    expect(splitStatements("a; b 'x;y'; c $f$ d; e $f$; g")).toEqual(["a", "b 'x;y'", "c $f$ d; e $f$", "g"]);
  });

  it("blankStrings and quotedStrings read literals, hasWord matches whole words, countOf counts, inOrder sequences", () => {
    expect(blankStrings("a 'UPDATE it''s' b 'x'")).toBe("a '' b ''");
    expect(quotedStrings("a 'one', interval '10 minutes', 'it''s'")).toEqual(["one", "10 minutes", "it's"]);
    expect(hasWord("select a.grantee from t", "grant")).toBe(false);
    expect(hasWord("grant select on t", "grant")).toBe(true);
    expect(countOf("abcabcab", "ab")).toBe(3);
    expect(inOrder("a b c", ["a", "c"])).toBe(true);
    expect(inOrder("a b c", ["c", "a"])).toBe(false);
  });

  it("tickMinutes and gapMinutes read the schedules and intervals of the seed", () => {
    expect(tickMinutes("* * * * *")).toBe(1);
    expect(tickMinutes("*/3 * * * *")).toBe(3);
    expect(tickMinutes("4-59/10 * * * *")).toBe(10);
    expect(tickMinutes("15,45 * * * *")).toBe(30);
    expect(tickMinutes("25 * * * *")).toBe(60);
    expect(tickMinutes("35 */6 * * *")).toBe(360);
    expect(tickMinutes("10 4 * * *")).toBe(1440);
    expect(gapMinutes("10 minutes")).toBe(10);
    expect(gapMinutes("1 hour")).toBe(60);
    expect(gapMinutes("26 hours")).toBe(1560);
  });
});

describe("150 ledger, structure and header", () => {
  it("is one transaction: the body starts with begin; and ends with notify, the ledger insert and commit;", () => {
    const firstCodeLine = code.split("\n").find((l) => l.trim() !== "");
    expect(firstCodeLine?.trim()).toBe("begin;");
    expect(statements[0]).toBe("begin");
    expect(statements[statements.length - 1]).toBe("commit");
    expect(statements.filter((s) => s === "begin")).toHaveLength(1);
    expect(statements.filter((s) => s === "commit")).toHaveLength(1);
  });

  it("ends with notify pgrst, then ('150', '150_ops_queue_and_cron_liveness') in the 095 pattern, then commit", () => {
    expect(code).toMatch(
      /notify\s+pgrst\s*,\s*'reload schema'\s*;\s*insert\s+into\s+supabase_migrations\.schema_migrations\s*\(version,\s*name\)\s*values\s*\(\s*'150'\s*,\s*'150_ops_queue_and_cron_liveness'\s*\)\s*on\s+conflict\s+do\s+nothing\s*;\s*commit\s*;\s*$/i,
    );
    expect(statements.filter((s) => s.startsWith("insert into supabase_migrations"))).toHaveLength(1);
  });

  it("is exactly sixteen statements, in the order: table, its comment, RLS, revokes, grant, maintain block, seed, function, comment, revoke, grant, notify, ledger", () => {
    const starts = [
      "begin",
      "create table if not exists public.ops_cron_expected",
      "comment on table public.ops_cron_expected is",
      "alter table public.ops_cron_expected enable row level security",
      "revoke all on public.ops_cron_expected from anon, authenticated, public",
      "revoke all on public.ops_cron_expected from service_role",
      "grant select on public.ops_cron_expected to service_role",
      "do $maint$",
      "insert into public.ops_cron_expected (jobname, max_gap, note)",
      CREATE_LINE,
      "comment on function public.ops_health_report() is",
      REVOKE_STMT,
      GRANT_STMT,
      "notify pgrst, 'reload schema'",
      "insert into supabase_migrations.schema_migrations",
      "commit",
    ];
    expect(statements).toHaveLength(starts.length);
    starts.forEach((start, i) => {
      expect(collapse(statements[i] ?? "").startsWith(start), `statement ${i}: ${start}`).toBe(true);
    });
  });

  it("sanity: comment stripping is non-vacuous", () => {
    expect(sql.length).toBeGreaterThan(code.length);
    expect(sql).toContain("STEP 0");
    expect(code).not.toContain("STEP 0");
  });

  it("the header documents WHY (h24-ops-1), WHAT CHANGES, STEP 0 (md5 gate, queues, jobs, run volume), the baselines, both dry runs, the prod readout, deploy, verify and rollback", () => {
    expect(head.length).toBeGreaterThan(4000);
    for (const section of ["WHY", "WHAT CHANGES", "STEP 0", "DRY RUNS (×2)", "PROD READOUT", "DEPLOY", "VERIFY", "ROLLBACK"]) {
      expect(head, section).toContain(section);
    }
    expect(head).toMatch(/safe to re-apply/i);
    for (const word of ["h24-ops-1", "pgmq", "cluster_work", "image_backfill", "pg_cron", "cron.job_run_details", "migration 131", "service_role"]) {
      expect(head, word).toContain(word);
    }
    // Step 0 a: the md5 gate (145's fingerprint) and the byte length
    expect(head).toContain("fa5581a2e5edd98ce214b9621ecef7a4");
    expect(head).toContain("30,774");
    // Step 0 b: the queues, the index decision, depth, age, poison
    expect(head).toMatch(/archived_at_idx_cluster_work/);
    expect(head).toMatch(/oldest visible/i);
    expect(head).toMatch(/poison/i);
    // Step 0 c: the seeded list against cron.job
    expect(head).toContain("42 jobs");
    // Step 0 d: run volume and the window literal
    expect(head).toContain("4600");
    expect(head).toContain(String(RUN_WINDOW));
    expect(head).toMatch(/cron-log-compact/);
    // the baselines the thresholds come from
    expect(head).toMatch(/p95 60 s/);
    expect(head).toMatch(/86\.5 s/);
    expect(head).toMatch(/p95 7\d\d(\.\d)? s/);
    // dry runs
    expect(head).toContain("pg-150-a");
    expect(head).toContain("pg-150-b");
    expect(head).toContain("55550");
    expect(head).toContain("55560");
    expect(head).toContain("DRYRUN 150 OK");
    expect(head).toContain("INSERT 0 1");
    expect(head).toContain("INSERT 0 0");
    expect(head).toMatch(/19 rows/);
    // the prod readout
    expect(head).toMatch(/explain \(analyze\)/i);
    expect(head).toMatch(/pass \/ pass/i);
  });

  it("the header says the 7000-id window and the 26 h rule hold at today's volume, and tells the operator how to tune", () => {
    expect(collapse(head)).toContain("update public.ops_cron_expected set max_gap");
    expect(collapse(head)).toContain("delete from public.ops_cron_expected where jobname");
  });

  it("is one new table and one function: nothing else is created, altered, dropped, truncated, scheduled or written but the seed and the ledger row", () => {
    expect([...code.matchAll(/\bcreate\s+or\s+replace\s+function\s+([a-z_.]+)\s*\(/gi)].map((m) => m[1])).toEqual([
      "public.ops_health_report",
    ]);
    expect([...code.matchAll(/\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_.]+)/gi)].map((m) => m[1])).toEqual([
      "public.ops_cron_expected",
    ]);
    const words = wordsOf(blankStrings(code));
    for (const forbidden of [
      "drop",
      "delete",
      "truncate",
      "update",
      "policy",
      "concurrently",
      "index",
      "trigger",
      "schedule",
      "unschedule",
      "alter_job",
      "vacuum",
    ]) {
      expect(words, forbidden).not.toContain(forbidden);
    }
    // the only alter is the RLS switch
    expect(statements.filter((s) => hasWord(blankStrings(s), "alter")).map(collapse)).toEqual([
      "alter table public.ops_cron_expected enable row level security",
    ]);
    // nothing touches cron.job (the 122 guard)
    expect(code).not.toMatch(/update\s+cron\.job/i);
    expect(code).not.toContain("cron.schedule");
    expect(code).not.toContain("cron.alter_job");
    expect(code).not.toContain("cron.unschedule");
    expect(statements.filter((s) => s.startsWith("insert into")).map((s) => collapse(s).split(" (")[0])).toEqual([
      "insert into public.ops_cron_expected",
      "insert into supabase_migrations.schema_migrations",
    ]);
  });

  it("the dry-run file exists, applies 145 then 150 twice, and ends with DRYRUN 150 OK", () => {
    expect(existsSync(DRYRUN), "tests/migrations/sql/150-ops-queue-cron-liveness-dryrun.sql").toBe(true);
    const dry = readFileSync(DRYRUN, "utf8");
    expect(dry).toContain("145_ops_anon_surface_check.sql");
    expect(countOf(dry, "150_ops_queue_and_cron_liveness.sql\n")).toBeGreaterThanOrEqual(2);
    expect(dry.trimEnd().endsWith("select 'DRYRUN 150 OK';")).toBe(true);
  });
});

describe("150 rollback re-runs only 145's ops_health_report() section, then drops the table and the ledger row", () => {
  it("the header's rollback names the section, the drop and the ledger delete", () => {
    const rollback = rollbackOf(head);
    expect(rollback).toContain("ONLY 145's ops_health_report() section");
    expect(rollback).toContain("create or replace function public.ops_health_report()");
    expect(rollback).toContain("grant execute on function public.ops_health_report() to service_role;");
    expect(rollback).toContain("drop table public.ops_cron_expected;");
    expect(rollback).toContain("delete from supabase_migrations.schema_migrations where version = '150'");
    expect(rollback).toContain("notify pgrst, 'reload schema'");
    expect(rollback).toContain("145_ops_anon_surface_check.sql");
  });

  it("145's section (create line through its grant) creates exactly one function and nothing else", () => {
    const from = sql145.lastIndexOf(CREATE_LINE);
    const grantAt = sql145.indexOf(GRANT_STMT + ";", from);
    expect(from).toBeGreaterThan(0);
    expect(grantAt).toBeGreaterThan(from);
    const section = sql145.slice(from, grantAt + GRANT_STMT.length + 1);
    expect([...stripComments(section).matchAll(/\bcreate\s+or\s+replace\s+function\s+([a-z_.]+)\s*\(/gi)].map((m) => m[1])).toEqual([
      "public.ops_health_report",
    ]);
    expect(section.endsWith(GRANT_STMT + ";")).toBe(true);
  });
});

describe("150 rows 1-17 are 145's, byte for byte", () => {
  it("145's text from the create line through row 17's `return next;` is not vacuous", () => {
    expect(rowsOneToSeventeen.startsWith(CREATE_LINE)).toBe(true);
    expect(rowsOneToSeventeen.endsWith("  return next;")).toBe(true);
    expect(rowsOneToSeventeen).toContain("-- 16. db_size_mb (migration 136).");
    expect(rowsOneToSeventeen).toContain("-- 17. anon_surface (migration 145).");
    expect(rowsOneToSeventeen.length).toBeGreaterThan(30000);
  });

  it("150 contains that text exactly once, followed by the row-18 marker, the row-19 block and then `  return;\\nend\\n$fn$;`", () => {
    expect(aAt, "150 holds 145's rows 1-17 verbatim").toBeGreaterThan(0);
    expect(sql.indexOf(rowsOneToSeventeen, aAt + 1)).toBe(-1);
    expect(code.indexOf(CREATE_LINE)).toBeGreaterThanOrEqual(0);
    expect(code.indexOf(CREATE_LINE, code.indexOf(CREATE_LINE) + 1)).toBe(-1);
    expect(sql.lastIndexOf(CREATE_LINE)).toBe(aAt);
    expect(sql.slice(aAt + rowsOneToSeventeen.length).startsWith("\n\n  " + MARKER_18)).toBe(true);
    expect(newRowsRaw.endsWith("  return next;")).toBe(true);
    expect(sql.slice(aAt + rowsOneToSeventeen.length + newRowsRaw.length).startsWith(FN_END)).toBe(true);
    expect(sql.indexOf(FN_END)).toBe(aAt + rowsOneToSeventeen.length + newRowsRaw.length);
  });

  it("the literal check names are 145's seventeen followed by queue_lag and cron_jobs_stalled, in that order", () => {
    expect(literalCheckNames(fnBody)).toEqual(ROW_NAMES_17.filter((n) => !n.startsWith("ingest_fresh_")).concat([CHECK_18, CHECK_19]));
    expect(literalCheckNames(rowsOneToSeventeen)).toHaveLength(17 - 3);
  });

  it("keeps 145's header (security definer, volatile, search_path = '', returns table) and its declare block", () => {
    const head150 = fnStatement.slice(0, fnStatement.indexOf("$fn$"));
    const head145 = rowsOneToSeventeen.slice(0, rowsOneToSeventeen.indexOf("$fn$"));
    expect(collapse(head150)).toBe(collapse(head145));
    expect(collapse(head150)).toContain(
      "returns table (check_name text, status text, observed numeric, threshold numeric, detail text) language plpgsql volatile security definer set search_path = ''",
    );
    const declare = (text: string) => collapse(text.slice(text.indexOf("declare"), text.indexOf("\nbegin\n")));
    expect(declare(fnBody)).toBe(declare(rowsOneToSeventeen));
    expect(fnBody.trimStart().startsWith("#variable_conflict use_column")).toBe(true);
  });

  it("the function body has no $fn$ of its own and the file has exactly the opening and the closing $fn$", () => {
    expect(fnBody).not.toContain("$fn$");
    expect(code.split("$fn$")).toHaveLength(3);
  });

  it("the word 'grant' never appears in the function body, comments included (the anon-surface guard scans bodies for it)", () => {
    const rawBodyStart = sql.indexOf("$fn$", aAt) + "$fn$".length;
    const rawBody = sql.slice(rawBodyStart, sql.indexOf(FN_END, aAt));
    expect(rawBody.length).toBeGreaterThan(rowsOneToSeventeen.length - 400);
    expect(hasWord(rawBody, "grant")).toBe(false);
    expect(hasWord(rawBody, "grants")).toBe(false);
    expect(hasWord(newRowsRaw, "grant")).toBe(false);
  });
});

describe("150 row 18: queue_lag", () => {
  it("is the row after anon_surface: marker comment first, then the fixed preamble and its own locals, one `return next;`", () => {
    expect(row18Raw.trimStart().startsWith(MARKER_18)).toBe(true);
    expect(row18.startsWith("check_name := 'queue_lag'; threshold := 900; observed := null; detail := null; declare")).toBe(true);
    expect([...row18.matchAll(/\breturn next;/g)]).toHaveLength(1);
    expect(row18.endsWith("return next;")).toBe(true);
    for (const local of ["qc_depth numeric;", "qc_oldest numeric;", "qi_depth numeric;", "qi_oldest numeric;", "q_poison numeric;"]) {
      expect(row18, local).toContain(local);
    }
  });

  it("the marker comment names the evidence: nothing watched clustering, the 2026-11-02 baselines, poison, the counts-only detail", () => {
    const start = row18Raw.indexOf(MARKER_18);
    const comment = row18Raw.slice(start, row18Raw.indexOf("\n", start));
    for (const word of ["cluster_work", "image_backfill", "p95", "poison", "read_ct", "counts only", "pgmq"]) {
      expect(comment, word).toContain(word);
    }
  });

  it("answers 'unknown' with a Turkish detail when either queue table is missing, before it queries them", () => {
    expect(row18).toContain(
      "if pg_catalog.to_regclass('pgmq.q_cluster_work') is null or pg_catalog.to_regclass('pgmq.q_image_backfill') is null then status := 'unknown'; detail := 'pgmq kuyruğu yok';",
    );
    expect(row18.indexOf("pgmq kuyruğu yok")).toBeLessThan(row18.indexOf("execute $q$"));
  });

  it("reads the queues through dynamic SQL (one execute), depth as count(*) and the oldest age over messages that are visible (vt <= now())", () => {
    expect(countOf(row18, "execute $q$")).toBe(1);
    expect(countOf(row18, "$q$")).toBe(2);
    expect(row18).toContain("(select pg_catalog.count(*) from pgmq.q_cluster_work)::numeric");
    expect(row18).toContain("(select pg_catalog.count(*) from pgmq.q_image_backfill)::numeric");
    for (const q of ["q_cluster_work", "q_image_backfill"]) {
      expect(row18, q).toContain(
        `(select coalesce(extract(epoch from pg_catalog.now() - pg_catalog.min(m.enqueued_at)), 0) from pgmq.${q} m where m.vt <= pg_catalog.now())::numeric`,
      );
    }
    expect(row18).toContain("into qc_depth, qc_oldest, qi_depth, qi_oldest, q_poison;");
  });

  it("poison: archived messages with read_ct >= 3 in the last 24 hours, summed over both archives (the archived_at indexes make it a range scan)", () => {
    for (const a of ["a_cluster_work", "a_image_backfill"]) {
      expect(row18, a).toContain(
        `(select pg_catalog.count(*) from pgmq.${a} a where a.archived_at >= pg_catalog.now() - interval '24 hours' and a.read_ct >= 3)`,
      );
    }
  });

  it("status: fail above 900 s (cluster_work) or 3600 s (image_backfill); warn above 300 s, depth 300, 1800 s or one poison message; else pass", () => {
    expect(row18).toContain(
      "status := case when qc_oldest > 900 or qi_oldest > 3600 then 'fail' when qc_oldest > 300 or qc_depth > 300 or qi_oldest > 1800 or q_poison >= 1 then 'warn' else 'pass' end;",
    );
    expect(row18).toContain("observed := round(qc_oldest);");
    for (const s of ["pass", "warn", "fail", "unknown"]) expect(row18, s).toContain(`'${s}'`);
    expect(row18).not.toContain("'skip'");
  });

  it("detail: Turkish, counts and ages only, in the order of the spec", () => {
    expect(
      inOrder(row18, [
        "'cluster_work: '",
        "qc_depth::text",
        "' mesaj, en eski '",
        "round(qc_oldest)::text",
        "' sn · image_backfill: '",
        "qi_depth::text",
        "' mesaj, en eski '",
        "round(qi_oldest)::text",
        "' sn · zehirli (24 sa): '",
        "q_poison::text;",
      ]),
    ).toBe(true);
    // never a message body, a payload or an id: those columns are not read at all
    const words = wordsOf(blankStrings(row18));
    for (const col of ["message", "msg_id", "headers"]) expect(words, col).not.toContain(col);
  });

  it("answers 'unknown' with the first 200 characters of the error if the query fails, and only reads", () => {
    expect(row18.endsWith("exception when others then status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200); end; return next;")).toBe(true);
    const bare = wordsOf(blankStrings(row18));
    for (const forbidden of ["insert", "update", "delete", "truncate", "drop", "alter", "create", "grant", "revoke", "perform", "vacuum"]) {
      expect(bare, forbidden).not.toContain(forbidden);
    }
  });

  it("uses only its own locals plus the OUT columns (no v_ variable of the shared declare block)", () => {
    expect(wordsOf(row18).filter((w) => w.startsWith("v_"))).toEqual([]);
  });
});

describe("150 row 19: cron_jobs_stalled", () => {
  it("is the last check: marker comment first, then the fixed preamble and its own locals, one `return next;`", () => {
    expect(row19Raw.trimStart().startsWith(MARKER_19)).toBe(true);
    expect(row19.startsWith("check_name := 'cron_jobs_stalled'; threshold := 1; observed := null; detail := null; declare")).toBe(true);
    expect([...row19.matchAll(/\breturn next;/g)]).toHaveLength(1);
    expect(row19.endsWith("return next;")).toBe(true);
    expect(fnBody.trimEnd().endsWith("return next;\n\n  return;\nend")).toBe(true);
    for (const local of ["j_total numeric;", "j_missing numeric;", "j_inactive numeric;", "j_stale numeric;", "j_failed numeric;"]) {
      expect(row19, local).toContain(local);
    }
    for (const local of ["n_missing text;", "n_inactive text;", "n_stale text;", "n_failed text;"]) {
      expect(row19, local).toContain(local);
    }
  });

  it("the marker comment names the evidence: nothing watched the jobs, row 1 counts only 'failed', the 6-day archive hole of 131, public detail", () => {
    const start = row19Raw.indexOf(MARKER_19);
    const comment = row19Raw.slice(start, row19Raw.indexOf("\n", start));
    for (const word of ["ops_cron_expected", "failed", "131", "max_gap", "counts", "job names", "7000", "runid"]) {
      expect(comment, word).toContain(word);
    }
  });

  it("answers 'unknown' for a missing pg_cron or a missing table, before it queries them", () => {
    expect(row19).toContain(
      "if pg_catalog.to_regclass('cron.job_run_details') is null or pg_catalog.to_regclass('cron.job') is null then status := 'unknown'; detail := 'pg_cron yok';",
    );
    expect(row19).toContain(
      "elsif pg_catalog.to_regclass('public.ops_cron_expected') is null then status := 'unknown'; detail := 'ops_cron_expected yok';",
    );
    expect(row19.indexOf("ops_cron_expected yok")).toBeLessThan(row19.indexOf("execute $q$"));
  });

  it("one dynamic query: expected jobs left join cron.job by jobname and left join lateral the newest run inside the runid window", () => {
    expect(countOf(row19, "execute $q$")).toBe(1);
    expect(countOf(row19, "$q$")).toBe(2);
    expect(row19).toContain("from public.ops_cron_expected e left join cron.job j on j.jobname = e.jobname left join lateral (");
    expect(row19).toContain("select d.start_time, d.status from cron.job_run_details d where d.jobid = j.jobid");
    expect(row19).toContain(`d.runid > (select coalesce(pg_catalog.max(x.runid), 0) - ${RUN_WINDOW} from cron.job_run_details x)`);
    expect(row19).toContain("order by d.runid desc limit 1) r on true");
    expect(row19).toContain(
      "into j_total, j_missing, j_inactive, j_stale, j_failed, n_missing, n_inactive, n_stale, n_failed;",
    );
  });

  it("classifies each job once: missing (no cron.job row), inactive, stale (no run, or the newest older than max_gap, any status), failed (newest run failed)", () => {
    expect(row19).toContain(
      "case when j.jobid is null then 'missing' when j.active is not true then 'inactive' when r.start_time is null or r.start_time < pg_catalog.now() - e.max_gap then 'stale' when r.status = 'failed' then 'failed' else 'ok' end",
    );
    for (const kind of ["missing", "inactive", "stale", "failed"]) {
      expect(row19, kind).toContain(`filter (where s.kind = '${kind}')`);
    }
  });

  it("status: fail on a missing, inactive or stale job (observed = their count); warn when only a newest run failed (observed = the failed count); else pass with 0", () => {
    expect(row19).toContain(
      "observed := case when j_missing + j_inactive + j_stale >= 1 then j_missing + j_inactive + j_stale else j_failed end;",
    );
    expect(row19).toContain(
      "status := case when j_missing + j_inactive + j_stale >= 1 then 'fail' when j_failed >= 1 then 'warn' else 'pass' end;",
    );
    for (const s of ["pass", "warn", "fail", "unknown"]) expect(row19, s).toContain(`'${s}'`);
  });

  it("detail: job names and counts only, Turkish, cut at 500 characters", () => {
    expect(
      inOrder(row19, [
        "'yok: '",
        "n_missing",
        "'pasif: '",
        "n_inactive",
        "'koşu yok: '",
        "n_stale",
        "'son koşu başarısız: '",
        "n_failed",
        "' iş izleniyor'",
        "1, 500);",
      ]),
    ).toBe(true);
    expect(row19).toContain("j_total::text || ' iş izleniyor'");
    expect(row19).toContain("pg_catalog.concat_ws(' · '");
  });

  it("never reads cron.job.command or cron.job_run_details.command / return_message (they carry vault secrets), not even in a select list", () => {
    const outside = wordsOf(blankStrings(row19));
    expect(outside).not.toContain("command");
    expect(outside).not.toContain("return_message");
    expect(outside).not.toContain("username");
    expect(outside).not.toContain("database");
    // no star select: a `j.*` or `d.*` would pull command in
    for (const star of ["select *", "j.*", "d.*", "e.*", "r.*", "s.*"]) expect(row19, star).not.toContain(star);
    // the columns it does read
    for (const col of ["jobname", "jobid", "active", "runid", "start_time", "status"]) expect(outside, col).toContain(col);
  });

  it("answers 'unknown' with the first 200 characters of the error if the query fails, and only reads", () => {
    expect(row19.endsWith("exception when others then status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200); end; return next;")).toBe(true);
    const bare = wordsOf(blankStrings(row19));
    for (const forbidden of ["insert", "update", "delete", "truncate", "drop", "alter", "create", "grant", "revoke", "perform", "vacuum"]) {
      expect(bare, forbidden).not.toContain(forbidden);
    }
    expect(wordsOf(row19).filter((w) => w.startsWith("v_"))).toEqual([]);
  });

  it("the whole body runs exactly two more dynamic queries than 145's", () => {
    const executes = (text: string) => wordsOf(blankStrings(text)).filter((w) => w === "execute").length;
    expect(executes(fnBody)).toBe(executes(rowsOneToSeventeen) + 2);
  });
});

describe("150 table public.ops_cron_expected", () => {
  const stmt = (start: string): string => collapse(statements.find((s) => collapse(s).startsWith(start)) ?? "");

  it("has exactly the columns jobname (primary key), max_gap (interval, not null, > 0) and note", () => {
    expect(stmt("create table if not exists public.ops_cron_expected")).toBe(TABLE_STMT);
  });

  it("has a table comment that says what it is, who tunes it and that it is service_role only", () => {
    const comment = quotedStrings(statements.find((s) => collapse(s).startsWith("comment on table public.ops_cron_expected")) ?? "").join("");
    for (const word of ["cron_jobs_stalled", "max_gap", "migration 150", "service_role", "docs/ops-heartbeat.md"]) {
      expect(comment, word).toContain(word);
    }
  });

  it("enables row level security and creates no policy", () => {
    expect(stmt("alter table public.ops_cron_expected")).toBe("alter table public.ops_cron_expected enable row level security");
    expect(wordsOf(blankStrings(code))).not.toContain("policy");
  });

  it("revokes everything from anon, authenticated and public, then from service_role, and grants service_role select only", () => {
    expect(stmt("revoke all on public.ops_cron_expected from anon")).toBe(
      "revoke all on public.ops_cron_expected from anon, authenticated, public",
    );
    expect(stmt("revoke all on public.ops_cron_expected from service_role")).toBe("revoke all on public.ops_cron_expected from service_role");
    expect(stmt("grant select on public.ops_cron_expected")).toBe("grant select on public.ops_cron_expected to service_role");
  });

  it("revokes MAINTAIN on PG17 only (the privilege does not exist before PG17), in a guarded DO block (143's pattern)", () => {
    const block = stmt("do $maint$");
    expect(block).toContain("current_setting('server_version_num')::int >= 170000");
    expect(block).toContain("execute 'revoke maintain on public.ops_cron_expected from anon, authenticated'");
    expect(block.endsWith("$maint$")).toBe(true);
  });

  it("grants nothing to anon, authenticated or public: the only grants are service_role's table select and function execute", () => {
    const grants = statements.filter((s) => hasWord(blankStrings(s), "grant") && !s.startsWith(CREATE_LINE)).map(collapse);
    expect(grants).toEqual(["grant select on public.ops_cron_expected to service_role", GRANT_STMT]);
    for (const g of grants) {
      expect(g.endsWith("to service_role")).toBe(true);
      expect(g).not.toMatch(/\b(anon|authenticated|public)\s*$/);
    }
    // no default-privilege change, no schema-wide grant
    const words = wordsOf(blankStrings(code));
    expect(words).not.toContain("privileges");
    expect(words).not.toContain("default");
  });

  it("the revokes come before the seed and the function", () => {
    const at = (needle: string) => code.indexOf(needle);
    expect(at("alter table public.ops_cron_expected")).toBeGreaterThan(at("create table if not exists public.ops_cron_expected"));
    expect(at("revoke all on public.ops_cron_expected from anon")).toBeGreaterThan(at("alter table public.ops_cron_expected"));
    expect(at("grant select on public.ops_cron_expected")).toBeGreaterThan(at("revoke all on public.ops_cron_expected from service_role"));
    expect(at("do $maint$")).toBeGreaterThan(at("grant select on public.ops_cron_expected"));
    expect(at("insert into public.ops_cron_expected")).toBeGreaterThan(at("do $maint$"));
    expect(at(CREATE_LINE)).toBeGreaterThan(at("insert into public.ops_cron_expected"));
  });
});

describe("150 seed of public.ops_cron_expected", () => {
  let seedStmt = "";
  let triples: Array<[string, string, string]> = [];

  beforeAll(() => {
    seedStmt = statements.find((s) => collapse(s).startsWith("insert into public.ops_cron_expected")) ?? "";
    const strings = quotedStrings(seedStmt);
    expect(strings.length % 3).toBe(0);
    triples = [];
    for (let i = 0; i < strings.length; i += 3) triples.push([strings[i] as string, strings[i + 1] as string, strings[i + 2] as string]);
  });

  it("is `insert ... on conflict (jobname) do nothing`, so an operator's tuning survives a re-apply", () => {
    expect(collapse(seedStmt)).toContain("insert into public.ops_cron_expected (jobname, max_gap, note) values (");
    expect(collapse(seedStmt).endsWith("on conflict (jobname) do nothing")).toBe(true);
    expect(hasWord(blankStrings(seedStmt), "update")).toBe(false);
  });

  it("every max_gap is an `interval '...'` literal, one per job", () => {
    expect(countOf(collapse(seedStmt), "interval '")).toBe(EXPECTED_SEED.length);
  });

  it("equals the pinned list, in order", () => {
    expect(triples).toEqual(EXPECTED_SEED);
  });

  it("has no duplicate job name", () => {
    expect(new Set(triples.map((t) => t[0])).size).toBe(triples.length);
  });

  it("lists no weekday-only (quotes-*) or weekly job, and none that is not a plain job name", () => {
    for (const [name] of EXPECTED_SEED) {
      expect(name.startsWith("quotes-"), name).toBe(false);
      expect(name.startsWith("jev-regression-weekly"), name).toBe(false);
      expect([...name].every((c) => (c >= "a" && c <= "z") || c === "-"), name).toBe(true);
    }
  });

  it("every seeded job name appears as a quoted literal in another migration or in docs/migration-guide.md, so the list cannot drift from the schedules", () => {
    const others = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{3}_.+\.sql$/.test(f) && f !== MIGRATION_150_NAME)
      .map((f) => readFileSync(resolve(MIGRATIONS_DIR, f), "utf8"));
    others.push(readFileSync(DOC_MIGRATION_GUIDE, "utf8"));
    expect(others.length).toBeGreaterThan(100);
    for (const [name] of EXPECTED_SEED) {
      expect(
        others.some((text) => text.includes(`'${name}'`)),
        `'${name}' in some other migration or docs/migration-guide.md`,
      ).toBe(true);
    }
  });

  it("each max_gap follows the rule of the header: sub-hourly at least 3 ticks and 10 minutes (and under twice that), hourly 3 h, multi-hour tick + 1 h, daily 26 h", () => {
    for (const [name, gap, schedule] of EXPECTED_SEED) {
      const tick = tickMinutes(schedule);
      const minutes = gapMinutes(gap);
      if (tick < 60) {
        const floor = Math.max(3 * tick, 10);
        expect(minutes, `${name}: gap ${gap} for a ${tick} minute tick`).toBeGreaterThanOrEqual(floor);
        expect(minutes, `${name}: gap ${gap} is loose for a ${tick} minute tick`).toBeLessThanOrEqual(2 * floor);
      } else if (tick === 60) {
        expect(minutes, name).toBe(180);
      } else if (tick < 1440) {
        expect(minutes, name).toBe(tick + 60);
      } else {
        expect(minutes, name).toBe(26 * 60);
      }
    }
  });

  it("the daily jobs stay visible in the runid window: 26 h of runs is well inside it", () => {
    // 4600 runs per 26 h on 2026-11-02 (Step 0 d); the window is 1.5 x that, rounded up to 1000
    expect(RUN_WINDOW).toBe(Math.ceil((1.5 * 4600) / 1000) * 1000);
    expect(row19).toContain(`- ${RUN_WINDOW} from cron.job_run_details x`);
  });
});

describe("150 function header, comment, revoke and grant are 145's", () => {
  it("revoke all from public, anon, authenticated and execute for service_role only: 145's two statements, nothing else", () => {
    const revokes = statements.filter((s) => hasWord(blankStrings(s), "revoke") && s.startsWith("revoke") && collapse(s).includes("function"));
    expect(revokes.map(collapse)).toEqual([REVOKE_STMT]);
    const fnGrants = statements.filter((s) => s.startsWith("grant") && collapse(s).includes("function"));
    expect(fnGrants.map(collapse)).toEqual([GRANT_STMT]);
  });

  it("stays SECURITY DEFINER with search_path = '' and volatile plpgsql", () => {
    const h = collapse(fnStatement.slice(0, fnStatement.indexOf("$fn$")));
    expect(h).toContain("security definer");
    expect(h).toContain("set search_path = ''");
    expect(h).toContain("volatile");
    expect(h).toContain("language plpgsql");
  });

  describe("comment on function", () => {
    let c145 = "";
    let c150 = "";
    let middle145 = "";
    let tail145 = "";

    beforeAll(() => {
      c145 = commentText(sql145);
      c150 = commentText(sql);
      expect(c145.startsWith(COMMENT_PREFIX_145)).toBe(true);
      const mark = c145.indexOf(COMMENT_STATUS_MARK);
      expect(mark).toBeGreaterThan(0);
      // 145's description list, without the final full stop that closes anon_surface's description
      middle145 = c145.slice(COMMENT_PREFIX_145.length, mark - 1);
      tail145 = c145.slice(mark);
      expect(c145.charAt(mark - 1)).toBe(".");
    });

    it("is 145's text with the migration list ending 145, 150 and `19 fixed rows`", () => {
      expect(c150.startsWith(COMMENT_PREFIX_150)).toBe(true);
      expect(c150).not.toContain("17 fixed rows");
    });

    it("adds the queue_lag and cron_jobs_stalled descriptions right before ' status is one of', after anon_surface's, which now ends with a comma", () => {
      expect(c150.slice(COMMENT_PREFIX_150.length).startsWith(middle145 + ", queue_lag (")).toBe(true);
      expect(c150.endsWith(tail145)).toBe(true);
      const description = c150.slice(COMMENT_PREFIX_150.length + middle145.length + 1, c150.length - tail145.length);
      expect(description.startsWith(" queue_lag (")).toBe(true);
      expect(description.endsWith(").")).toBe(true);
      const at = description.indexOf(", cron_jobs_stalled (");
      expect(at).toBeGreaterThan(0);
      const queue = description.slice(0, at);
      const cron = description.slice(at);
      for (const word of ["cluster_work", "image_backfill", "pgmq", "900", "3600", "300", "1800", "read_ct", "fail", "warn", "unknown"]) {
        expect(queue, word).toContain(word);
      }
      for (const word of ["public.ops_cron_expected", "cron.job", "cron.job_run_details", "max_gap", "fail", "warn", "unknown", "job names"]) {
        expect(cron, word).toContain(word);
      }
      // counts and names only, the heartbeat output is public
      expect(description).toContain("counts");
      expect(description).not.toContain("command");
      expect(description).not.toContain("return_message");
    });

    it("still says service_role only, never reads a secret-bearing pg_cron field, and points at docs/ops-heartbeat.md", () => {
      expect(c150).toContain("service_role only");
      expect(c150).toContain("docs/ops-heartbeat.md");
      expect(c150).toContain("status is one of pass|warn|fail|unknown|skip");
      expect(c150).toContain("never reads any potentially secret-bearing pg_cron job field");
    });
  });
});

describe("150 docs/ops-heartbeat.md", () => {
  let doc = "";
  let section = "";

  beforeAll(() => {
    doc = readFileSync(DOC_OPS_HEARTBEAT, "utf8");
    const at = doc.indexOf("## Kuyruk ve cron canlılığı (migration 150, rows 18 and 19)");
    expect(at, "the section for migration 150").toBeGreaterThan(0);
    const next = doc.indexOf("\n## ", at + 1);
    section = doc.slice(at, next < 0 ? doc.length : next);
  });

  it("the title and the intro list 150, and the row count is 19 (20 once 157 appended its row, 21 once 161 did)", () => {
    const title = doc.slice(0, doc.indexOf("\n"));
    expect(title).toContain("145, 150");
    expect(doc).toContain("migrations 077, 100, 103, 108, 114, 115, 119, 122, 136, 145, 150");
    // 157 appended a twentieth row and 161 a twenty-first, and they moved these counts (tests/migrations/161-image-coverage-by-source.test.ts pins 21)
    expect(doc).toMatch(/(19|20|21|22) fixed-order rows/);
    expect(doc).not.toContain("17 fixed-order rows");
    expect(doc).toMatch(/always returns exactly\n(19|20|21|22) rows/);
  });

  it("the table has rows 18 and 19 with their thresholds and baselines", () => {
    const rowOf = (prefix: string): string => {
      const at = doc.indexOf(prefix);
      expect(at, prefix).toBeGreaterThan(0);
      return doc.slice(at, doc.indexOf("\n", at));
    };
    const r18 = rowOf("| 18 | `queue_lag`");
    for (const word of ["cluster_work", "image_backfill", "pgmq", "900", "3600", "300", "1800", "read_ct", "p95 60 s", "86.5 s", "p95"]) {
      expect(r18, word).toContain(word);
    }
    const r19 = rowOf("| 19 | `cron_jobs_stalled`");
    for (const word of ["ops_cron_expected", "max_gap", "cron.job", "fail", "warn", "7000"]) {
      expect(r19, word).toContain(word);
    }
    expect(doc.indexOf("| 19 | `cron_jobs_stalled`")).toBeGreaterThan(doc.indexOf("| 18 | `queue_lag`"));
    expect(doc.indexOf("| 18 | `queue_lag`")).toBeGreaterThan(doc.indexOf("| 17 | `anon_surface`"));
  });

  it("the section says what each status means for both rows", () => {
    for (const word of ["pass", "warn", "fail", "unknown", "yok:", "pasif:", "koşu yok:", "son koşu başarısız:", "zehirli", "en eski"]) {
      expect(section, word).toContain(word);
    }
  });

  it("the section tells the operator how to tune: update max_gap as the owner, or delete a row", () => {
    expect(section).toContain("update public.ops_cron_expected set max_gap =");
    expect(section).toContain("delete from public.ops_cron_expected where jobname =");
    expect(section).toContain("owner");
    expect(section).toContain("on conflict (jobname) do nothing");
  });

  it("the section has a service_role query listing the newest run of each job, without the command column", () => {
    expect(section).toContain("service_role");
    expect(section).toContain("cron.job_run_details");
    expect(section).toContain("left join lateral");
    // the query never selects the secret-bearing columns; the text only names them to say it does not
    const sqlBlocks: string[] = [];
    let at = section.indexOf("```sql");
    while (at >= 0) {
      const end = section.indexOf("```", at + 6);
      sqlBlocks.push(section.slice(at + 6, end));
      at = section.indexOf("```sql", end + 3);
    }
    expect(sqlBlocks.length).toBeGreaterThanOrEqual(1);
    for (const block of sqlBlocks) {
      const words = wordsOf(blankStrings(stripComments(block)));
      expect(words, block).not.toContain("command");
      expect(words, block).not.toContain("return_message");
    }
  });

  it("the section says the details are public (counts and job names only) and why", () => {
    expect(section).toContain("public");
    expect(section).toContain("counts and job names only");
    expect(section).toContain("GITHUB_STEP_SUMMARY");
  });

  it("the section records the thresholds' baselines and the run-volume measurement", () => {
    for (const word of ["p95 60 s", "86.5 s", "4600", String(RUN_WINDOW)]) {
      expect(section, word).toContain(word);
    }
  });
});

// ---------------------------------------------------------------------------
// Live behaviour (opt-in): rows 18 and 19 against fixtures, on a throwaway Postgres
// with 145 and 150 applied (tests/migrations/sql/150-ops-queue-cron-liveness-dryrun.sql
// leaves one behind). TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/PGDATABASE
// select the server. The server must have neither pg_cron nor pgmq installed: the stub
// schemas `cron` and `pgmq` are created inside each case's transaction (if not exists)
// and every case ends in a rollback.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))("150 rows 18 and 19 against fixtures (live Postgres, every case rolled back)", () => {
  assertLiveReady("150", { ledger: ["145", "150"], relations: ["public.ops_cron_expected"], functions: ["public.ops_health_report()"] });

  function runPsql(input: string): string {
    return execFileSync(process.env.TAYF_PSQL as string, ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      input,
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8", PGOPTIONS: "-c client_min_messages=warning" },
      maxBuffer: 8 * 1024 * 1024,
    });
  }

  /** The shapes pg_cron and pgmq have; created inside the case's transaction when the server has no such schema. */
  const STUBS = `
create schema if not exists cron;
create table if not exists cron.job (jobid bigserial primary key, jobname text, schedule text, command text, active boolean not null default true);
create table if not exists cron.job_run_details (runid bigserial primary key, jobid bigint, status text, start_time timestamptz, end_time timestamptz, command text, return_message text);
create schema if not exists pgmq;
create table if not exists pgmq.q_cluster_work (msg_id bigserial primary key, read_ct integer not null default 0, enqueued_at timestamptz not null default now(), vt timestamptz not null default now(), message jsonb);
create table if not exists pgmq.q_image_backfill (msg_id bigserial primary key, read_ct integer not null default 0, enqueued_at timestamptz not null default now(), vt timestamptz not null default now(), message jsonb);
create table if not exists pgmq.a_cluster_work (msg_id bigint primary key, read_ct integer not null default 0, enqueued_at timestamptz not null default now(), archived_at timestamptz not null default now(), vt timestamptz not null default now(), message jsonb);
create table if not exists pgmq.a_image_backfill (msg_id bigint primary key, read_ct integer not null default 0, enqueued_at timestamptz not null default now(), archived_at timestamptz not null default now(), vt timestamptz not null default now(), message jsonb);
delete from cron.job_run_details; delete from cron.job;
delete from pgmq.q_cluster_work; delete from pgmq.q_image_backfill; delete from pgmq.a_cluster_work; delete from pgmq.a_image_backfill;
`;

  /** Every expected job present, active, with a succeeded run one minute ago; the secret-looking columns are filled. */
  const HEALTHY_CRON = `
insert into cron.job (jobname, schedule, command, active)
  select e.jobname, e.note, 'select net.http_post(''https://x.invalid'', ''SECRET-COMMAND'')', true from public.ops_cron_expected e;
insert into cron.job_run_details (jobid, status, start_time, end_time, command, return_message)
  select j.jobid, 'succeeded', now() - interval '1 minute', now() - interval '59 seconds', 'SECRET-COMMAND', 'SECRET-RETURN' from cron.job j;
`;

  type Row = { check: string; status: string; observed: string; threshold: string; detail: string };

  function parseRow(line: string): Row {
    const [check, status, observed, threshold, ...rest] = line.split("|");
    return {
      check: check as string,
      status: status as string,
      observed: observed as string,
      threshold: threshold as string,
      detail: rest.join("|"),
    };
  }

  /** Runs the fixture in begin..rollback and returns the one row of `check` (the report itself must not raise). */
  function rowOf(check: string, fixture: string): Row {
    const out = runPsql(
      `begin;\n${STUBS}\n${fixture}\nselect check_name, status, observed, threshold, detail from public.ops_health_report() where check_name = '${check}';\nrollback;\n`,
    );
    const lines = out.split("\n").filter((l) => l.trim() !== "");
    expect(lines, out).toHaveLength(1);
    return parseRow(lines[0] as string);
  }

  const queueRow = (fixture: string) => rowOf(CHECK_18, fixture);
  const cronRow = (fixture: string) => rowOf(CHECK_19, fixture);

  const msg = (queue: string, ageSql: string, extra = "") =>
    `insert into pgmq.q_${queue} (enqueued_at, vt${extra ? ", read_ct" : ""}) values (now() - interval '${ageSql}', now() - interval '1 second'${extra ? ", " + extra : ""});\n`;

  beforeAll(() => {
    const out = runPsql(
      `select (select count(*) from pg_extension where extname in ('pg_cron', 'pgmq')) || '|' || (to_regclass('public.ops_cron_expected') is not null)::text || '|' || (select count(*) from public.ops_health_report());`,
    ).trim();
    const [exts, table, rows] = out.split("|");
    expect(exts, "refusing to run fixtures on a server with pg_cron or pgmq installed").toBe("0");
    expect(table, "apply 145 and 150 first (see the dry-run file)").toBe("true");
    expect(rows).toBe("19");
  });

  it("returns 19 rows; rows 18 and 19 are queue_lag and cron_jobs_stalled, in that order, last", () => {
    const out = runPsql("select check_name from public.ops_health_report();").split("\n").filter(Boolean);
    expect(out).toHaveLength(19);
    expect(out.slice(-2)).toEqual([CHECK_18, CHECK_19]);
    expect(out.slice(0, 17).filter((n) => n.startsWith("ingest_fresh_"))).toHaveLength(3);
  });

  describe("queue_lag", () => {
    it("empty queues: pass, observed 0, threshold 900, counts only", () => {
      const r = queueRow("");
      expect(r.status).toBe("pass");
      expect(r.observed).toBe("0");
      expect(r.threshold).toBe("900");
      expect(r.detail).toBe("cluster_work: 0 mesaj, en eski 0 sn · image_backfill: 0 mesaj, en eski 0 sn · zehirli (24 sa): 0");
    });

    it("a visible cluster_work message 20 minutes old: fail, observed 1200", () => {
      const r = queueRow(msg("cluster_work", "20 minutes"));
      expect(r.status).toBe("fail");
      expect(r.observed).toBe("1200");
      expect(r.detail).toContain("cluster_work: 1 mesaj, en eski 1200 sn");
    });

    it("an 8 minute old message: warn; a 4 minute old one: pass; exactly 900 s is still a warn, 901 s a fail", () => {
      expect(queueRow(msg("cluster_work", "8 minutes")).status).toBe("warn");
      expect(queueRow(msg("cluster_work", "4 minutes")).status).toBe("pass");
      expect(queueRow(msg("cluster_work", "900 seconds")).status).toBe("warn");
      expect(queueRow(msg("cluster_work", "901 seconds")).status).toBe("fail");
      expect(queueRow(msg("cluster_work", "300 seconds")).status).toBe("pass");
      expect(queueRow(msg("cluster_work", "301 seconds")).status).toBe("warn");
    });

    it("an in-flight message (vt in the future) does not age the queue, but still counts toward the depth", () => {
      const r = queueRow(`insert into pgmq.q_cluster_work (enqueued_at, vt) values (now() - interval '1 hour', now() + interval '30 seconds');`);
      expect(r.status).toBe("pass");
      expect(r.detail).toContain("cluster_work: 1 mesaj, en eski 0 sn");
    });

    it("depth above 300 warns even when every message is fresh; 300 itself passes", () => {
      const fill = (n: number) =>
        `insert into pgmq.q_cluster_work (enqueued_at, vt) select now() - interval '5 seconds', now() - interval '1 second' from generate_series(1, ${n});`;
      const warn = queueRow(fill(301));
      expect(warn.status).toBe("warn");
      expect(warn.detail).toContain("cluster_work: 301 mesaj");
      expect(queueRow(fill(300)).status).toBe("pass");
    });

    it("image_backfill: 30 minutes old passes, 31 minutes warns, 61 minutes fails", () => {
      expect(queueRow(msg("image_backfill", "30 minutes")).status).toBe("pass");
      expect(queueRow(msg("image_backfill", "31 minutes")).status).toBe("warn");
      const fail = queueRow(msg("image_backfill", "61 minutes"));
      expect(fail.status).toBe("fail");
      expect(fail.observed).toBe("0"); // observed is cluster_work's age
      expect(fail.detail).toContain("image_backfill: 1 mesaj, en eski 3660 sn");
    });

    it("poison: an archived message with read_ct 3 in the last 24 hours warns; read_ct 2, or 25 hours ago, passes", () => {
      const archive = (queue: string, readCt: number, ago: string) =>
        `insert into pgmq.a_${queue} (msg_id, read_ct, archived_at) values (1, ${readCt}, now() - interval '${ago}');`;
      const warn = queueRow(archive("cluster_work", 3, "2 hours"));
      expect(warn.status).toBe("warn");
      expect(warn.detail.endsWith("zehirli (24 sa): 1")).toBe(true);
      expect(queueRow(archive("image_backfill", 7, "23 hours")).status).toBe("warn");
      expect(queueRow(archive("cluster_work", 2, "2 hours")).status).toBe("pass");
      expect(queueRow(archive("cluster_work", 9, "25 hours")).status).toBe("pass");
    });

    it("a stalled cluster_work with a poison message in the archive still reads fail, not warn", () => {
      const r = queueRow(msg("cluster_work", "20 minutes") + `insert into pgmq.a_image_backfill (msg_id, read_ct, archived_at) values (1, 4, now());`);
      expect(r.status).toBe("fail");
      expect(r.detail.endsWith("zehirli (24 sa): 1")).toBe(true);
    });

    it("pgmq absent: unknown with the Turkish detail, and the report does not raise", () => {
      const r = queueRow("alter schema pgmq rename to pgmq_off;");
      expect(r.status).toBe("unknown");
      expect(r.detail).toBe("pgmq kuyruğu yok");
      expect(r.observed).toBe("");
    });

    it("a queue table that errors on read (an archive without archived_at): unknown with the error text, no exception", () => {
      const r = queueRow("alter table pgmq.a_cluster_work drop column archived_at;");
      expect(r.status).toBe("unknown");
      expect(r.detail).toContain("archived_at");
    });

    it("the detail carries no message body, id or payload", () => {
      const r = queueRow(
        `insert into pgmq.q_cluster_work (enqueued_at, vt, message) values (now() - interval '20 minutes', now() - interval '1 second', '{"secret":"PAYLOAD-MARK"}');`,
      );
      expect(r.status).toBe("fail");
      expect(r.detail).not.toContain("PAYLOAD-MARK");
      expect(r.detail).not.toContain("secret");
    });
  });

  describe("cron_jobs_stalled", () => {
    const EXPECTED_COUNT = String(EXPECTED_SEED.length);

    it("healthy (every expected job present, active, a run one minute ago): pass, observed 0, threshold 1, N iş izleniyor", () => {
      const r = cronRow(HEALTHY_CRON);
      expect(r.status).toBe("pass");
      expect(r.observed).toBe("0");
      expect(r.threshold).toBe("1");
      expect(r.detail).toBe(`${EXPECTED_COUNT} iş izleniyor`);
    });

    it("a job set inactive: fail, observed 1, its name in the detail under `pasif:`", () => {
      const r = cronRow(HEALTHY_CRON + "update cron.job set active = false where jobname = 'cluster-drain';");
      expect(r.status).toBe("fail");
      expect(r.observed).toBe("1");
      expect(r.detail).toBe("pasif: cluster-drain");
    });

    it("a job whose runs are all deleted: fail under `koşu yok:`", () => {
      const r = cronRow(
        HEALTHY_CRON + "delete from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'image-drain');",
      );
      expect(r.status).toBe("fail");
      expect(r.observed).toBe("1");
      expect(r.detail).toBe("koşu yok: image-drain");
    });

    it("a job deleted from cron.job (unscheduled): fail under `yok:`", () => {
      const r = cronRow(HEALTHY_CRON + "delete from cron.job where jobname = 'prune-nightly';");
      expect(r.status).toBe("fail");
      expect(r.observed).toBe("1");
      expect(r.detail).toBe("yok: prune-nightly");
    });

    it("a job whose newest run is older than its max_gap is stale: fail; one minute inside the gap is not", () => {
      const aged = (job: string, age: string) =>
        HEALTHY_CRON +
        `update cron.job_run_details set start_time = now() - interval '${age}' where jobid = (select jobid from cron.job where jobname = '${job}');`;
      // cluster-drain max_gap is 10 minutes
      expect(cronRow(aged("cluster-drain", "11 minutes")).detail).toBe("koşu yok: cluster-drain");
      expect(cronRow(aged("cluster-drain", "9 minutes")).status).toBe("pass");
      // prune-nightly max_gap is 26 hours: a daily job 25 h after its run is still fine
      expect(cronRow(aged("prune-nightly", "25 hours")).status).toBe("pass");
      expect(cronRow(aged("prune-nightly", "27 hours")).status).toBe("fail");
    });

    it("the newest run of a job failed: warn (observed = the failed count), but a failed run older than a succeeded one is not", () => {
      const failed = cronRow(
        HEALTHY_CRON +
          "update cron.job_run_details set status = 'failed' where jobid = (select jobid from cron.job where jobname = 'ingest-drain');",
      );
      expect(failed.status).toBe("warn");
      expect(failed.observed).toBe("1");
      expect(failed.detail).toBe("son koşu başarısız: ingest-drain");
      const recovered = cronRow(
        HEALTHY_CRON +
          `insert into cron.job_run_details (runid, jobid, status, start_time) select (select min(runid) from cron.job_run_details) - 1, jobid, 'failed', now() - interval '5 minutes' from cron.job where jobname = 'ingest-drain';`,
      );
      expect(recovered.status).toBe("pass");
    });

    it("a run that is still running counts as a run (any status)", () => {
      const r = cronRow(
        HEALTHY_CRON + "update cron.job_run_details set status = 'running', end_time = null where jobid = (select jobid from cron.job where jobname = 'kap-drain');",
      );
      expect(r.status).toBe("pass");
    });

    it("several problems: the fail counts missing + inactive + stale, the detail lists every kind in order, and a failed job is only mentioned as a warn", () => {
      const r = cronRow(
        HEALTHY_CRON +
          `delete from cron.job where jobname = 'prune-nightly';
update cron.job set active = false where jobname in ('kap-drain', 'cluster-drain');
delete from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'image-drain');
update cron.job_run_details set status = 'failed' where jobid = (select jobid from cron.job where jobname = 'ingest-drain');`,
      );
      expect(r.status).toBe("fail");
      expect(r.observed).toBe("4");
      expect(r.detail).toBe(
        "yok: prune-nightly · pasif: cluster-drain, kap-drain · koşu yok: image-drain · son koşu başarısız: ingest-drain",
      );
    });

    /** Every job but cluster-drain has a run at runid 3000000 + jobid; cluster-drain's only run sits `offset` ids below the newest one. */
    const windowFixture = (offset: number) =>
      HEALTHY_CRON +
      `delete from cron.job_run_details;
insert into cron.job_run_details (runid, jobid, status, start_time) select 3000000 + jobid, jobid, 'succeeded', now() - interval '1 minute' from cron.job where jobname <> 'cluster-drain';
insert into cron.job_run_details (runid, jobid, status, start_time) select (select max(runid) from cron.job_run_details) - ${offset}, jobid, 'succeeded', now() - interval '1 minute' from cron.job where jobname = 'cluster-drain';`;

    it("a run outside the runid window does not count: the newest run of a job sits at max(runid) - 7000 (the bound is exclusive)", () => {
      const r = cronRow(windowFixture(RUN_WINDOW));
      expect(r.status).toBe("fail");
      expect(r.detail).toBe("koşu yok: cluster-drain");
    });

    it("the run window is wide enough: a run at max(runid) - 6999 is still seen", () => {
      const r = cronRow(windowFixture(RUN_WINDOW - 1));
      expect(r.status).toBe("pass");
      expect(r.detail).toBe(`${EXPECTED_COUNT} iş izleniyor`);
    });

    it("an unlisted job that is dead is not the report's business: removing a row from ops_cron_expected stops watching it", () => {
      const r = cronRow(HEALTHY_CRON + "delete from public.ops_cron_expected where jobname = 'cluster-drain'; delete from cron.job where jobname = 'cluster-drain';");
      expect(r.status).toBe("pass");
      expect(r.detail).toBe(`${Number(EXPECTED_COUNT) - 1} iş izleniyor`);
    });

    it("an operator's tuning: a tighter max_gap turns a healthy job stale", () => {
      const r = cronRow(HEALTHY_CRON + "update public.ops_cron_expected set max_gap = interval '30 seconds' where jobname = 'cluster-drain';");
      expect(r.status).toBe("fail");
      expect(r.detail).toBe("koşu yok: cluster-drain");
    });

    it("pg_cron absent: unknown `pg_cron yok`, and the report does not raise", () => {
      const r = cronRow("alter schema cron rename to cron_off;");
      expect(r.status).toBe("unknown");
      expect(r.detail).toBe("pg_cron yok");
    });

    it("ops_cron_expected absent: unknown `ops_cron_expected yok`", () => {
      const r = cronRow("drop table public.ops_cron_expected;");
      expect(r.status).toBe("unknown");
      expect(r.detail).toBe("ops_cron_expected yok");
    });

    it("never leaks cron.job.command or the run's return_message into the detail, even with a failing job", () => {
      const r = cronRow(
        HEALTHY_CRON +
          "update cron.job_run_details set status = 'failed', return_message = 'SECRET-RETURN https://x.invalid/key=abc' where jobid = (select jobid from cron.job where jobname = 'ingest-drain');",
      );
      expect(r.status).toBe("warn");
      for (const secret of ["SECRET", "https", "key=abc", "http_post"]) expect(r.detail).not.toContain(secret);
    });

    it("an empty ops_cron_expected is a pass with `0 iş izleniyor` (nothing to watch)", () => {
      const r = cronRow(HEALTHY_CRON + "delete from public.ops_cron_expected;");
      expect(r.status).toBe("pass");
      expect(r.detail).toBe("0 iş izleniyor");
    });
  });

  describe("the table's surface", () => {
    it("anon and authenticated have no privilege on it, row level security is on, service_role has select only", () => {
      const out = runPsql(`
select has_table_privilege('anon', 'public.ops_cron_expected', 'select,insert,update,delete,truncate,references,trigger'),
       has_table_privilege('authenticated', 'public.ops_cron_expected', 'select,insert,update,delete,truncate,references,trigger'),
       has_table_privilege('service_role', 'public.ops_cron_expected', 'select'),
       has_table_privilege('service_role', 'public.ops_cron_expected', 'insert,update,delete,truncate'),
       (select relrowsecurity from pg_class where oid = 'public.ops_cron_expected'::regclass),
       (select count(*) from pg_policy where polrelid = 'public.ops_cron_expected'::regclass),
       has_function_privilege('anon', 'public.ops_health_report()', 'execute'),
       has_function_privilege('authenticated', 'public.ops_health_report()', 'execute'),
       has_function_privilege('service_role', 'public.ops_health_report()', 'execute');
`).trim();
      expect(out).toBe("f|f|t|f|t|0|f|f|t");
    });

    it("a check constraint rejects a non-positive max_gap", () => {
      expect(() => runPsql("begin; insert into public.ops_cron_expected (jobname, max_gap) values ('zz-test', interval '0'); rollback;")).toThrow();
      expect(() => runPsql("begin; insert into public.ops_cron_expected (jobname, max_gap) values ('zz-test', interval '-1 minute'); rollback;")).toThrow();
    });

    it("the ledger has one 150 row and the seed is the pinned list", () => {
      const ledger = runPsql("select count(*) from supabase_migrations.schema_migrations where version = '150';").trim();
      expect(ledger).toBe("1");
      const seed = runPsql(
        "select jobname || '|' || (extract(epoch from max_gap) / 60)::int || '|' || note from public.ops_cron_expected order by jobname;",
      )
        .split("\n")
        .filter(Boolean);
      const wanted = EXPECTED_SEED.map(([name, gap, note]) => `${name}|${gapMinutes(gap)}|${note}`).sort();
      expect([...seed].sort()).toEqual(wanted);
    });
  });
});
