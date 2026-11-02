import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 144 ("blindspot-veto-cadence"),
// h17-dbperf-1. Since 126 every 10-minute run of the blindspot-recall-veto cron
// starts cold (mean 2.1 s -> 5.2 s, about 750 DB-seconds a day). 144 moves the
// schedule from '7-59/10 * * * *' to '7-59/20 * * * *' with a schedule-only
// cron.alter_job, found by job name and guarded, so the command is never
// re-typed and nothing else changes. The one thing that bounds the cadence is
// the ops check blindspot_veto_cron_min (fail when the last succeeded run is
// more than 30 minutes old); the last test reads that threshold out of the
// newest ops_health_report() definition, so a later threshold edit breaks it.
//
// Everything below parses with character scans and indexOf, never with a
// nested-quantifier regex over SQL text.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "supabase", "migrations");
const MIGRATION_FILE = resolve(MIGRATIONS_DIR, "144_blindspot_veto_cadence.sql");

const JOB_NAME = "blindspot-recall-veto";
const NEW_SCHEDULE = "7-59/20 * * * *";
const OLD_SCHEDULE = "7-59/10 * * * *";
const WORST_RUN_SECONDS = 13.7; // the slowest run of the last 24 h before 144
const REPORT_CREATE = "create or replace function public.ops_health_report()";
const CHECK_START = "check_name := 'blindspot_veto_cron_min'; threshold := ";

/** Drops "--" up to the end of the line when the "--" is outside a single-quoted string. */
function stripSqlComments(sql: string): string {
  let out = "";
  let inString = false;
  let i = 0;
  while (i < sql.length) {
    const ch = sql.charAt(i);
    if (inString) {
      out += ch;
      if (ch === "'") inString = false; // a doubled '' closes and reopens: same result
      i += 1;
      continue;
    }
    if (ch === "'") {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "-" && sql.charAt(i + 1) === "-") {
      while (i < sql.length && sql.charAt(i) !== "\n") i += 1; // keep the newline itself
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Collapses every whitespace run (space, tab, CR, LF) to one space and trims. */
function collapseWhitespace(text: string): string {
  let out = "";
  let pendingSpace = false;
  for (const ch of text) {
    const isSpace = ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
    if (isSpace) {
      pendingSpace = out.length > 0;
    } else {
      if (pendingSpace) out += " ";
      pendingSpace = false;
      out += ch;
    }
  }
  return out;
}

/** Lower-case words (letters, digits, underscore) outside single-quoted strings and dollar tags. */
function sqlWords(code: string): string[] {
  const words: string[] = [];
  let current = "";
  let inString = false;
  const flush = (): void => {
    if (current.length > 0) words.push(current);
    current = "";
  };
  for (const ch of code) {
    if (inString) {
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") {
      flush();
      inString = true;
      continue;
    }
    const lower = ch.toLowerCase();
    const isWordChar = (lower >= "a" && lower <= "z") || (lower >= "0" && lower <= "9") || lower === "_";
    if (isWordChar) current += lower;
    else flush();
  }
  flush();
  return words;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
}

/** The text between the quote that opens right after `prefix` and the next quote, for every `prefix`. */
function quotedValuesAfter(haystack: string, prefix: string): string[] {
  const values: string[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(prefix, from);
    if (at < 0) return values;
    const start = at + prefix.length;
    const end = haystack.indexOf("'", start);
    if (end < 0) throw new Error(`unterminated string after ${prefix}`);
    values.push(haystack.slice(start, end));
    from = end + 1;
  }
}

// Minutes of the hour a 5-field cron minute field fires on: star, n, a-b, a-b/s, star-slash-s and comma lists.
function parseMinuteField(field: string): number[] {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const slash = part.indexOf("/");
    const range = slash < 0 ? part : part.slice(0, slash);
    const step = slash < 0 ? 1 : Number(part.slice(slash + 1));
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in ${field}`);
    if (range === "") throw new Error(`empty range in "${field}"`);
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = 0;
      hi = 59;
    } else if (range.includes("-")) {
      const dash = range.indexOf("-");
      lo = Number(range.slice(0, dash));
      hi = Number(range.slice(dash + 1));
    } else {
      lo = Number(range);
      hi = slash < 0 ? lo : 59; // "7/20" means 7, 27, 47 in cron
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 0 || hi > 59 || lo > hi) {
      throw new Error(`bad range in ${field}`);
    }
    for (let m = lo; m <= hi; m += step) out.add(m);
  }
  return [...out].sort((a, b) => a - b);
}

function fieldsOf(schedule: string): string[] {
  return collapseWhitespace(schedule).split(" ");
}

/** Reads the unsigned integer that starts at `from` (digits only) or -1 when there is none. */
function readDigits(text: string, from: number): number {
  let end = from;
  while (end < text.length && text.charAt(end) >= "0" && text.charAt(end) <= "9") end += 1;
  return end === from ? -1 : Number(text.slice(from, end));
}

const raw = existsSync(MIGRATION_FILE) ? readFileSync(MIGRATION_FILE, "utf8") : "";
const code = stripSqlComments(raw);
const flat = collapseWhitespace(code);
const header = raw.slice(0, raw.indexOf("\nbegin;") < 0 ? raw.length : raw.indexOf("\nbegin;"));

/** Newest migration (by sorted file name) that defines public.ops_health_report(). */
function latestReportDefinition(): { file: string; sql: string } {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  let found: { file: string; sql: string } | null = null;
  for (const file of files) {
    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf8");
    if (sql.toLowerCase().includes(REPORT_CREATE)) found = { file, sql: sql.toLowerCase() };
  }
  if (!found) throw new Error("no migration defines public.ops_health_report()");
  return found;
}

describe("144 blindspot veto cadence: helpers", () => {
  it("stripSqlComments drops -- outside strings and keeps -- inside them", () => {
    expect(stripSqlComments("a -- c\nb")).toBe("a \nb");
    expect(stripSqlComments("select '-- not a comment'; -- real\nx")).toBe("select '-- not a comment'; \nx");
    expect(stripSqlComments("select 'it''s -- still text'; -- gone")).toBe("select 'it''s -- still text'; ");
    expect(stripSqlComments("-- only a comment")).toBe("");
  });

  it("parseMinuteField covers the shapes pg_cron schedules use", () => {
    expect(parseMinuteField("7-59/20")).toEqual([7, 27, 47]);
    expect(parseMinuteField("7-59/10")).toEqual([7, 17, 27, 37, 47, 57]);
    expect(parseMinuteField("*/10")).toEqual([0, 10, 20, 30, 40, 50]);
    expect(parseMinuteField("3-59/10")).toEqual([3, 13, 23, 33, 43, 53]);
    expect(parseMinuteField("15,45")).toEqual([15, 45]);
    expect(parseMinuteField("25")).toEqual([25]);
    expect(() => parseMinuteField("7-61/20")).toThrow();
    expect(() => parseMinuteField("*/0")).toThrow();
  });
});

describe("144 blindspot veto cadence", () => {
  it("the migration file exists", () => {
    expect(existsSync(MIGRATION_FILE)).toBe(true);
    expect(raw.length).toBeGreaterThan(0);
  });

  it("is one transaction and ends with the 095 ledger pattern", () => {
    expect(code.trimStart().startsWith("begin;")).toBe(true);
    expect(code.trimEnd().endsWith("commit;")).toBe(true);
    expect(countOccurrences(code, "begin;")).toBe(1);
    expect(countOccurrences(code, "commit;")).toBe(1);
    const ledger =
      "insert into supabase_migrations.schema_migrations (version, name) " +
      "values ('144', '144_blindspot_veto_cadence') on conflict do nothing; commit;";
    expect(flat.endsWith(ledger)).toBe(true);
  });

  it("alters exactly one job, by name, to the new schedule literal", () => {
    expect(countOccurrences(code, "cron.alter_job(")).toBe(1);
    expect(countOccurrences(code, `schedule := '${NEW_SCHEDULE}'`)).toBe(1);
    expect(flat).toContain(`perform cron.alter_job(job_id := v_job, schedule := '${NEW_SCHEDULE}');`);
    const names = quotedValuesAfter(code, "jobname = '");
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name).toBe(JOB_NAME);
    // the job is looked up before it is altered
    expect(code.indexOf("jobname = '")).toBeLessThan(code.indexOf("cron.alter_job("));
  });

  it("skips cleanly without pg_cron or without the job", () => {
    expect(code).toContain("to_regclass('cron.job') is null");
    expect(countOccurrences(code, "if v_job is null then")).toBe(1);
    expect(code).toContain("raise notice '144: pg_cron not installed, skipping'");
    expect(code).toContain("raise notice '144: blindspot-recall-veto not scheduled, skipping'");
    // the pg_cron guard comes before the job lookup, which comes before the alter
    expect(code.indexOf("to_regclass('cron.job') is null")).toBeLessThan(code.indexOf("jobname = '"));
    expect(code.indexOf("if v_job is null then")).toBeLessThan(code.indexOf("cron.alter_job("));
  });

  it("changes the schedule only: no schedule/unschedule, no command or active change", () => {
    expect(code).not.toContain("cron.schedule(");
    expect(code).not.toContain("cron.unschedule(");
    expect(code).not.toContain("command :=");
    expect(code).not.toContain("active :=");
    expect(code).not.toContain("database :=");
    expect(code).not.toContain("username :=");
  });

  it("grants nothing and writes nothing besides the ledger row", () => {
    const words = sqlWords(code);
    for (const banned of ["grant", "revoke", "update", "delete", "truncate", "drop", "create", "alter", "merge", "copy"]) {
      expect(words, `statement word ${banned}`).not.toContain(banned);
    }
    // exactly one insert, and it is the ledger row
    expect(words.filter((w) => w === "insert")).toHaveLength(1);
    expect(countOccurrences(flat, "insert into supabase_migrations.schema_migrations (version, name)")).toBe(1);
  });

  it("the header names every reader of the job, the evidence and the dry-run record", () => {
    for (const needle of [
      "blindspot_veto_cron_min",
      "136_ops_heartbeat_app_side.sql",
      "ops_health_snapshot",
      "cron_failed_runs_30m",
      "7-59/10",
      "7-59/20",
      "126",
      "5.21",
      "13.70",
      "72 runs",
      "DRY-RUN",
      "Rollback",
    ]) {
      expect(header, `header mentions ${needle}`).toContain(needle);
    }
  });
});

describe("144 cadence math", () => {
  /** Every schedule literal the migration passes to cron.alter_job. */
  function migrationSchedules(): string[] {
    return quotedValuesAfter(code, "schedule := '");
  }
  function migrationMinutes(): number[] {
    const first = migrationSchedules()[0] ?? "";
    return parseMinuteField(fieldsOf(first)[0] ?? "");
  }

  it("the migration sets exactly the documented 5-field schedule", () => {
    const found = migrationSchedules();
    expect(found).toEqual([NEW_SCHEDULE]);
    const fields = fieldsOf(found[0] ?? "");
    expect(fields).toHaveLength(5);
    expect(fields.slice(1)).toEqual(["*", "*", "*", "*"]);
  });

  it("fires at :07, :27 and :47: 3 runs an hour, 72 a day (half of 144)", () => {
    const minutes = migrationMinutes();
    expect(minutes).toEqual([7, 27, 47]);
    expect(minutes.length * 24).toBe(72);
    expect(parseMinuteField(fieldsOf(OLD_SCHEDULE)[0] ?? "").length * 24).toBe(144);
    expect(minutes.length * 24 * 2).toBe(144);
  });

  it("every gap is 20 minutes, including the wrap from :47 to the next :07", () => {
    const minutes = migrationMinutes();
    const gaps = minutes.map((m, i) => ((minutes[(i + 1) % minutes.length] ?? 0) - m + 60) % 60);
    expect(gaps).toEqual([20, 20, 20]);
  });

  it("keeps 109's :x7 slot and never shares a minute with jev-shadow, cluster-topics-refresh or the snapshot", () => {
    const minutes = migrationMinutes();
    expect(minutes.length).toBeGreaterThan(0);
    for (const m of minutes) expect(m % 10).toBe(7);
    const others: Record<string, number[]> = {
      "jev-shadow */10": parseMinuteField("*/10"),
      "cluster-topics-refresh 3-59/10": parseMinuteField("3-59/10"),
      "ops-health-snapshot 4-59/10": parseMinuteField("4-59/10"),
    };
    for (const [name, taken] of Object.entries(others)) {
      for (const m of minutes) expect(taken.includes(m), `${name} at :${m}`).toBe(false);
    }
  });
});

describe("144 ops freshness margin", () => {
  function newestCheck(): { file: string; startAt: number; endAt: number; threshold: number; block: string } {
    const { file, sql } = latestReportDefinition();
    const startAt = sql.indexOf(CHECK_START);
    const threshold = startAt < 0 ? -1 : readDigits(sql, startAt + CHECK_START.length);
    const endAt = startAt < 0 ? -1 : sql.indexOf("return next;", startAt);
    const block = startAt < 0 || endAt < 0 ? "" : sql.slice(startAt, endAt);
    return { file, startAt, endAt, threshold, block };
  }

  it("reads the threshold of blindspot_veto_cron_min from the newest ops_health_report()", () => {
    const { file, startAt, endAt, threshold } = newestCheck();
    expect(file).toBe("136_ops_heartbeat_app_side.sql"); // update this when a later migration redefines the report
    expect(startAt).toBeGreaterThan(-1);
    expect(endAt).toBeGreaterThan(startAt);
    expect(threshold).toBe(30);
  });

  it("the check fails on observed > the same number", () => {
    const { threshold, block } = newestCheck();
    expect(threshold).toBeGreaterThan(0);
    expect(block).toContain(`observed > ${threshold}`);
    expect(block).toContain("d.status = 'succeeded'");
  });

  it("20 minutes plus the worst observed run (13.7 s) stays under the threshold", () => {
    const { threshold } = newestCheck();
    const worstCaseMinutes = 20 + WORST_RUN_SECONDS / 60;
    expect(worstCaseMinutes).toBeLessThan(threshold);
    // about 9.8 minutes of margin, i.e. a slow run alone can never trip the check
    expect(threshold - worstCaseMinutes).toBeGreaterThan(9);
  });
});
