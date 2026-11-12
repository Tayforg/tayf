import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 205 ("jev-signals-timeout"), h146-pipeline-1.
//
// pg_cron job 39 `jev-signals-nightly` ('05 4 * * *') is three bare selects
// (jev_source_drift_compute, jev_kap_canary_compute, jev_alerts_auto_resolve) with no
// timeout of its own, so it runs under the 120 s platform statement_timeout. Its run time
// went from 43-57 s (10-29 to 11-08) to 100.6 / 105.8 / 105.9 / 111.6 s (11-09 to 11-12). One
// timeout cancels the whole implicit transaction (no source_drift_daily row, no KAP canary,
// no auto-resolve), jev_source_drift_compute() computes only yesterday, and nothing watched
// the job: public.ops_cron_expected did not list it.
//
// 205 (the number is the next free one; 202 is held on a local branch, 203 and 204 belong to
// an open PR) does two small things, both guarded and additive:
//   1. cron.alter_job: the command only (no schedule, no active flag) becomes
//      `set local statement_timeout = '5min';` plus the same three selects in the same order,
//      the format migration 148 gave blindspot-recall-veto.
//   2. one ops_cron_expected row (26 h), so cron_jobs_stalled reports a failed or missed run.
//
// This file is text-level, like 148's and 150's: SQL is scanned by character, comments are
// blanked first, and every assertion is on the comment-free code or on the header. No
// regular expression with nested quantifiers runs over SQL (CodeQL js/redos).
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const MIGRATION_NAME = "205_jev_signals_timeout.sql";
const MIGRATION = resolve(MIGRATIONS_DIR, MIGRATION_NAME);
const MIGRATION_073 = resolve(MIGRATIONS_DIR, "073_jev_pipeline_lifecycle.sql");
const MIGRATION_150 = resolve(MIGRATIONS_DIR, "150_ops_queue_and_cron_liveness.sql");
const DOC_ARCHITECTURE = resolve(ROOT, "docs", "architecture.md");
const DOC_GUIDE = resolve(ROOT, "docs", "migration-guide.md");
const DOC_HEARTBEAT = resolve(ROOT, "docs", "ops-heartbeat.md");

const JOB = "jev-signals-nightly";
const SCHEDULE = "05 4 * * *";
const SELECTS = [
  "select public.jev_source_drift_compute();",
  "select public.jev_kap_canary_compute();",
  "select public.jev_alerts_auto_resolve();",
];
const TIMEOUT_STMT = "set local statement_timeout = '5min';";
const COMMAND = [TIMEOUT_STMT, ...SELECTS].join(" ");

const LEDGER_STMT =
  "insert into supabase_migrations.schema_migrations (version, name) values ('205', '205_jev_signals_timeout') on conflict do nothing";
const OPS_INSERT_STMT =
  "insert into public.ops_cron_expected (jobname, max_gap, note) values ('jev-signals-nightly', interval '26 hours', '05 4 * * *') on conflict (jobname) do nothing;";

// -- character-scan helpers (no regular expression runs over SQL text) ----------

/** Removes `--` comments (to the end of the line, newline kept); quoted strings are copied verbatim. */
function stripComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === "'") {
      let j = i + 1;
      while (j < text.length) {
        if (text.charAt(j) === "'") {
          if (text.charAt(j + 1) === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "-" && text.charAt(i + 1) === "-") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl;
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
function splitStatements(codeText: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < codeText.length) {
    const ch = codeText.charAt(i);
    if (ch === "'") {
      let j = i + 1;
      while (j < codeText.length) {
        if (codeText.charAt(j) === "'") {
          if (codeText.charAt(j + 1) === "'") {
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
      while (j < codeText.length && isTagChar(codeText.charAt(j))) j += 1;
      if (codeText.charAt(j) === "$") {
        const tag = codeText.slice(i, j + 1);
        const close = codeText.indexOf(tag, j + 1);
        i = close < 0 ? codeText.length : close + tag.length;
      } else {
        i += 1;
      }
    } else if (ch === ";") {
      out.push(codeText.slice(start, i).trim());
      start = i + 1;
      i += 1;
    } else {
      i += 1;
    }
  }
  const tail = codeText.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/** Empties the content of every single-quoted string: `'abc'` becomes `''`. */
function blankStrings(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === "'") {
      let j = i + 1;
      while (j < text.length) {
        if (text.charAt(j) === "'") {
          if (text.charAt(j + 1) === "'") {
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
function quotedStrings(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text.charAt(i) !== "'") {
      i += 1;
      continue;
    }
    let cur = "";
    let j = i + 1;
    while (j < text.length) {
      if (text.charAt(j) === "'") {
        if (text.charAt(j + 1) === "'") {
          cur += "'";
          j += 2;
          continue;
        }
        break;
      }
      cur += text.charAt(j);
      j += 1;
    }
    out.push(cur);
    i = j + 1;
  }
  return out;
}

/** Index of the `)` that closes the `(` at `openIdx`, skipping quoted literals. */
function closingParen(text: string, openIdx: number): number {
  let depth = 0;
  let inQuote = false;
  for (let i = openIdx; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (inQuote) {
      if (ch === "'") inQuote = false;
      continue;
    }
    if (ch === "'") inQuote = true;
    else if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function collapse(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

/** Lower-case identifier-like words of the text, in order (`_` belongs to a word, so `alter_job` is not `alter`). */
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

function isDigits(s: string | undefined): boolean {
  if (s === undefined || s.length === 0) return false;
  for (const ch of s) if (ch < "0" || ch > "9") return false;
  return true;
}

/** A schedule of one fixed minute and one fixed hour, every day: the daily form of 150's `max_gap` rule (26 h). */
function isDailyAtFixedTime(schedule: string): boolean {
  const f = schedule.split(" ");
  return f.length === 5 && isDigits(f[0]) && isDigits(f[1]) && f[2] === "*" && f[3] === "*" && f[4] === "*";
}

/** The header comment as prose: the `--` prefixes dropped, whitespace collapsed. */
function proseOf(headText: string): string {
  return collapse(
    headText
      .split("\n")
      .map((l) => (l.startsWith("--") ? l.slice(2) : l))
      .join(" "),
  );
}

/** The text between a dollar-quote tag and its close, the DO block's body. */
function blockOf(codeText: string, tag: string): string {
  const open = codeText.indexOf(tag);
  if (open < 0) return "";
  const close = codeText.indexOf(tag, open + tag.length);
  return close < 0 ? "" : codeText.slice(open + tag.length, close);
}

let sql = "";
let code = "";
let statements: string[] = [];
let head = "";
let prose = "";
let cronBlock = "";
let watchBlock = "";

beforeAll(() => {
  // A missing migration fails each assertion below instead of the whole file.
  sql = existsSync(MIGRATION) ? readFileSync(MIGRATION, "utf8") : "";
  code = stripComments(sql);
  statements = splitStatements(code);
  const beginAt = sql.search(/^begin;/m);
  head = beginAt < 0 ? "" : sql.slice(0, beginAt);
  prose = proseOf(head);
  cronBlock = blockOf(code, "$jev_timeout$");
  watchBlock = blockOf(code, "$jev_watch$");
});

describe("205 helpers (the scans are not vacuous)", () => {
  it("stripComments drops -- outside strings and keeps it inside them", () => {
    expect(stripComments("a -- c\nb")).toBe("a \nb");
    expect(stripComments("select '-- not a comment'; -- real\nx")).toBe("select '-- not a comment'; \nx");
  });

  it("splitStatements keeps ; inside strings and dollar-quoted bodies", () => {
    expect(splitStatements("a; b 'x;y'; c $f$ d; e $f$; g")).toEqual(["a", "b 'x;y'", "c $f$ d; e $f$", "g"]);
  });

  it("quotedStrings decodes a doubled quote, closingParen skips quoted parentheses, wordsOf keeps alter_job whole", () => {
    expect(quotedStrings("x 'set local statement_timeout = ''5min''; y' z")).toEqual(["set local statement_timeout = '5min'; y"]);
    expect(closingParen("f(a, ')', g(b)) tail", 1)).toBe(14);
    expect(wordsOf("perform cron.alter_job(x)")).toContain("alter_job");
    expect(wordsOf("perform cron.alter_job(x)")).not.toContain("alter");
    expect(blankStrings("a 'UPDATE it''s' b")).toBe("a '' b");
    expect(inOrder("a b c", ["a", "c"])).toBe(true);
    expect(inOrder("a b c", ["c", "a"])).toBe(false);
    expect(countOf("abcabcab", "ab")).toBe(3);
    expect(isDailyAtFixedTime("05 4 * * *")).toBe(true);
    expect(isDailyAtFixedTime("*/5 * * * *")).toBe(false);
  });
});

describe("205 file, transaction and ledger", () => {
  it("the file exists and is the only 205 migration, named like its ledger row", () => {
    expect(existsSync(MIGRATION), `${MIGRATION_NAME} must exist`).toBe(true);
    expect(readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("205_"))).toEqual([MIGRATION_NAME]);
  });

  it("is one transaction: begin; set local lock_timeout = '5s'; ... ledger insert; commit;", () => {
    const firstCodeLine = code.split("\n").find((l) => l.trim() !== "");
    expect(firstCodeLine?.trim()).toBe("begin;");
    expect(statements[0]).toBe("begin");
    expect(statements[1]).toBe("set local lock_timeout = '5s'");
    expect(statements[statements.length - 1]).toBe("commit");
    expect(statements.filter((s) => s === "begin")).toHaveLength(1);
    expect(statements.filter((s) => s === "commit")).toHaveLength(1);
    expect(code.trimEnd().endsWith("commit;")).toBe(true);
  });

  it("holds exactly six statements, in this order: begin, lock_timeout, the cron block, the watch block, the ledger row, commit", () => {
    const starts = [
      "begin",
      "set local lock_timeout = '5s'",
      "do $jev_timeout$",
      "do $jev_watch$",
      "insert into supabase_migrations.schema_migrations",
      "commit",
    ];
    expect(statements).toHaveLength(starts.length);
    starts.forEach((start, i) => {
      expect(collapse(statements[i] ?? "").startsWith(start), `statement ${i}: ${start}`).toBe(true);
    });
  });

  it("the ledger row is ('205', '205_jev_signals_timeout') in the 095 pattern, once, and the last statement before commit", () => {
    expect(collapse(statements[statements.length - 2] ?? "")).toBe(LEDGER_STMT);
    expect(statements.filter((s) => s.startsWith("insert into supabase_migrations"))).toHaveLength(1);
    expect(countOf(code, "schema_migrations")).toBe(1);
  });

  it("sanity: comment stripping is non-vacuous and both DO blocks were found", () => {
    expect(sql.length).toBeGreaterThan(code.length);
    expect(cronBlock.length).toBeGreaterThan(100);
    expect(watchBlock.length).toBeGreaterThan(100);
    expect([...code.matchAll(/\bdo\s+\$(\w*)\$/gi)].map((m) => m[1])).toEqual(["jev_timeout", "jev_watch"]);
  });
});

describe("205 the cron command of job jev-signals-nightly", () => {
  let args = "";
  let command = "";

  beforeAll(() => {
    const callAt = code.indexOf("cron.alter_job(");
    expect(callAt, "a cron.alter_job call").toBeGreaterThanOrEqual(0);
    const open = code.indexOf("(", callAt);
    const close = closingParen(code, open);
    expect(close).toBeGreaterThan(open);
    args = collapse(code.slice(open + 1, close));
    command = quotedStrings(args)[0] ?? "";
  });

  it("calls cron.alter_job once, by job id, changing the command and nothing else", () => {
    expect(countOf(code, "cron.alter_job(")).toBe(1);
    expect(args.startsWith("job_id := v_job, command := '")).toBe(true);
    for (const other of ["schedule", "active", "database", "username", "job_name"]) {
      expect(args.includes(`${other} :=`), `${other} :=`).toBe(false);
    }
    expect(quotedStrings(args)).toHaveLength(1);
  });

  it("the command starts with set local statement_timeout = '5min'; and holds the three selects, in order, once each", () => {
    expect(command).toBe(COMMAND);
    expect(command.startsWith(TIMEOUT_STMT + " ")).toBe(true);
    expect(command.startsWith(`${TIMEOUT_STMT} ${SELECTS[0]}`)).toBe(true);
    const drift = command.indexOf(SELECTS[0] as string);
    const kap = command.indexOf(SELECTS[1] as string);
    const resolveAt = command.indexOf(SELECTS[2] as string);
    expect(drift).toBeGreaterThan(0);
    expect(kap).toBeGreaterThan(drift);
    expect(resolveAt).toBeGreaterThan(kap);
    for (const s of SELECTS) expect(countOf(command, s), s).toBe(1);
    // nothing else runs: the statements are the timeout and the three selects
    expect(command.split(";").map((s) => s.trim()).filter(Boolean)).toEqual([
      "set local statement_timeout = '5min'",
      "select public.jev_source_drift_compute()",
      "select public.jev_kap_canary_compute()",
      "select public.jev_alerts_auto_resolve()",
    ]);
  });

  it("the three selects are the ones of 073's cron.schedule body, verbatim and in order", () => {
    const m073 = readFileSync(MIGRATION_073, "utf8");
    const at = m073.indexOf(`cron.schedule('${JOB}'`);
    expect(at, "073 schedules the job").toBeGreaterThan(0);
    const open = m073.indexOf("$sql$", at);
    const close = m073.indexOf("$sql$", open + 5);
    expect(open).toBeGreaterThan(at);
    expect(close).toBeGreaterThan(open);
    const body073 = m073.slice(open + 5, close);
    expect(body073.split(";").map((s) => collapse(s)).filter(Boolean).map((s) => `${s};`)).toEqual(SELECTS);
  });

  it("finds the job by its name and by that name only", () => {
    const names = [...code.matchAll(/jobname\s*=\s*'([^']*)'/g)].map((m) => m[1]);
    expect(names).toEqual([JOB]);
    expect(code).not.toMatch(/cron\.(un)?schedule\b/i);
    expect(code).not.toMatch(/\bupdate\s+cron\./i);
  });

  it("is guarded: no pg_cron or no job is a notice and a skip, and the call is reached only past both guards", () => {
    const block = collapse(cronBlock);
    expect(
      inOrder(block, [
        "if to_regclass('cron.job') is null then raise notice '205:",
        "else select jobid into v_job from cron.job where jobname = 'jev-signals-nightly';",
        "if v_job is null then raise notice '205:",
        "else perform cron.alter_job(",
        "end if; end if; end",
      ]),
    ).toBe(true);
    expect(countOf(block, "raise notice '205:")).toBe(2);
    expect(countOf(block, "perform cron.alter_job(")).toBe(1);
    expect(blankStrings(block).includes("raise exception")).toBe(false);
    expect(block.startsWith("declare v_job bigint; begin")).toBe(true);
  });
});

describe("205 the ops_cron_expected row that watches the job", () => {
  it("is inserted only when the table exists, as `insert ... on conflict (jobname) do nothing`, else a notice", () => {
    const block = collapse(watchBlock);
    expect(
      inOrder(block, [
        "if to_regclass('public.ops_cron_expected') is not null then",
        OPS_INSERT_STMT,
        "else raise notice '205:",
        "end if;",
      ]),
    ).toBe(true);
    expect(block.startsWith("begin if to_regclass('public.ops_cron_expected') is not null then insert into")).toBe(true);
    expect(countOf(block, "insert into public.ops_cron_expected")).toBe(1);
  });

  it("the whole file has exactly two inserts: the watch row and the ledger row", () => {
    const flat = collapse(code);
    expect(countOf(blankStrings(flat), "insert into")).toBe(2);
    expect(countOf(flat, "insert into public.ops_cron_expected (")).toBe(1);
    expect(countOf(flat, "insert into supabase_migrations.schema_migrations (")).toBe(1);
  });

  it("never updates a row: an operator's tuned max_gap survives a re-apply (do nothing, no do update)", () => {
    expect(collapse(watchBlock)).toContain("on conflict (jobname) do nothing;");
    expect(wordsOf(blankStrings(code))).not.toContain("update");
  });

  it("the note is the schedule 073 leaves, and 26 h is the daily rule of 150's header", () => {
    const m073 = readFileSync(MIGRATION_073, "utf8");
    const at = m073.indexOf(`cron.schedule('${JOB}', '`);
    expect(at).toBeGreaterThan(0);
    const from = at + `cron.schedule('${JOB}', '`.length;
    expect(m073.slice(from, m073.indexOf("'", from))).toBe(SCHEDULE);
    expect(isDailyAtFixedTime(SCHEDULE)).toBe(true);
    // 150: daily job -> 26 h (a day plus two hours for the run time and the heartbeat's own cadence)
    expect(collapse(watchBlock)).toContain(`'${JOB}', interval '26 hours', '${SCHEDULE}'`);
  });

  it("150's table has jobname as its primary key (the conflict target exists) and a max_gap check above zero", () => {
    const m150 = collapse(stripComments(readFileSync(MIGRATION_150, "utf8")));
    expect(m150).toContain(
      "create table if not exists public.ops_cron_expected ( jobname text primary key, max_gap interval not null check (max_gap > interval '0'), note text )",
    );
  });

  it("the newest ops_health_report() reads the table in row 19 (cron_jobs_stalled), so the new row is watched", () => {
    const defining = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql") && isDigits(f.slice(0, 3)) && f.charAt(3) === "_" && f !== MIGRATION_NAME)
      .sort()
      .filter((f) => readFileSync(resolve(MIGRATIONS_DIR, f), "utf8").includes("create or replace function public.ops_health_report()"));
    expect(defining.length).toBeGreaterThan(5);
    const newest = collapse(stripComments(readFileSync(resolve(MIGRATIONS_DIR, defining[defining.length - 1] as string), "utf8")));
    expect(newest).toContain("check_name := 'cron_jobs_stalled'");
    expect(newest).toContain("from public.ops_cron_expected e left join cron.job j on j.jobname = e.jobname");
    expect(newest).toContain("r.start_time < pg_catalog.now() - e.max_gap then 'stale'");
    expect(newest).toContain("when r.status = 'failed' then 'failed'");
  });
});

describe("205 is additive", () => {
  it("creates, drops, deletes, updates, truncates, grants, revokes and indexes nothing", () => {
    const words = wordsOf(blankStrings(code));
    for (const forbidden of [
      "create",
      "drop",
      "delete",
      "update",
      "truncate",
      "grant",
      "revoke",
      "alter",
      "index",
      "concurrently",
      "vacuum",
      "trigger",
      "policy",
      "function",
      "schedule",
      "unschedule",
      "copy",
    ]) {
      expect(words, forbidden).not.toContain(forbidden);
    }
    expect(code).not.toMatch(/create\s+(or\s+replace\s+)?function/i);
    expect(code).not.toMatch(/create\s+(unique\s+)?index/i);
  });

  it("writes only the job command, the watch row and the ledger row, and reads no secret-bearing field", () => {
    // the only function it calls is cron.alter_job; no net, no vault, no key
    expect(countOf(blankStrings(code), "perform ")).toBe(1);
    for (const needle of ["net.http_post", "vault.", "decrypted_secrets", "Bearer", "eyJ", "service_role_key"]) {
      expect(sql.includes(needle), needle).toBe(false);
    }
    // the job's current command is never selected (it can carry secrets on other jobs): only the job id is read
    expect(collapse(blankStrings(cronBlock))).not.toContain("select command");
    expect(countOf(collapse(blankStrings(cronBlock)), "select ")).toBe(1);
  });
});

describe("205 header documents the evidence, the reasoning, the replay and the rollback", () => {
  it("has its sections", () => {
    expect(head.length).toBeGreaterThan(3000);
    for (const part of ["WHY", "EVIDENCE", "THE FIX", "WHY 5 MIN", "HEARTBEAT", "DEPLOY ORDER", "VERIFY", "ROLLBACK"]) {
      expect(head, part).toContain(part);
    }
    expect(head).toContain("h146-pipeline-1");
    expect(head).toContain("DEPLOY ORDER: none");
  });

  it("records the run times: 43-57 s to 11-08, then 100.6, 105.8, 105.9 and 111.6 s", () => {
    for (const t of ["43.0", "57.2", "100.6", "105.8", "105.9", "111.6"]) expect(prose, t).toContain(t);
    for (const day of ["10-29", "11-08", "11-09", "11-12"]) expect(prose, day).toContain(day);
    expect(prose).toContain("04:05:00");
  });

  it("records the timeout evidence: 120000 ms reset_val, no role override, one implicit transaction, yesterday only, the held backfill", () => {
    expect(prose).toContain("statement_timeout");
    expect(prose).toContain("120000");
    expect(prose).toContain("pg_db_role_setting");
    expect(prose).toContain("implicit transaction");
    expect(prose).toContain("source_drift_daily");
    expect(prose).toContain("jev_alerts");
    expect(prose).toContain("jev_source_drift_compute(p_day");
    expect(prose).toContain("yesterday");
    expect(prose).toContain("h68-sqlperf-1");
    expect(prose).toContain("migration 148");
    expect(prose).toContain("libpq");
  });

  it("explains 5 min: about 2.7 times the worst run, the order of jobs 48 and 54, a pathological run still fails fast", () => {
    // 300 s / 111.6 s, rounded to one decimal, is the "2.7" the header states
    expect(Math.round((300 / 111.6) * 10) / 10).toBe(2.7);
    const why = prose.slice(prose.indexOf("WHY 5 MIN"));
    expect(why).toContain("2.7");
    expect(why).toContain("jobs 48");
    expect(why).toContain("54");
    expect(why).toContain("fails fast");
  });

  it("names the crossing date of the 120 s limit and what it is not (h140-rejected-4: no index, no data change)", () => {
    expect(prose).toContain("Nov 14");
    expect(prose).toContain("h140-rejected-4");
    expect(prose).toContain("no index");
  });

  it("records the read-only heartbeat replay: 21 jobs, none missing, inactive, stale or failed; the job read pass", () => {
    expect(prose).toContain("cron_jobs_stalled");
    expect(prose).toContain("21");
    expect(prose).toContain("0 missing, 0 inactive, 0 stale, 0 failed");
    expect(prose).toContain("26 h");
    expect(prose).toContain("21 iş izleniyor");
  });

  it("states the replay before apply and the verify after apply, read-only", () => {
    expect(prose).toContain("from cron.job where jobname = 'jev-signals-nightly'");
    expect(prose).toContain("from cron.job_run_details");
    expect(prose).toContain("the schedule and active are unchanged");
  });

  it("the rollback restores the three-select command, deletes the watch row and the ledger row", () => {
    const rollback = prose.slice(prose.indexOf("ROLLBACK"));
    expect(rollback).toContain("cron.alter_job");
    expect(rollback).toContain("select jobid from cron.job where jobname = 'jev-signals-nightly'");
    expect(rollback).toContain(
      "command := 'select public.jev_source_drift_compute(); select public.jev_kap_canary_compute(); select public.jev_alerts_auto_resolve();'",
    );
    expect(rollback).toContain("delete from public.ops_cron_expected where jobname = 'jev-signals-nightly'");
    expect(rollback).toContain("delete from supabase_migrations.schema_migrations where version = '205'");
  });

  it("says it is safe to re-apply and names the migration numbers it left free", () => {
    expect(prose).toMatch(/safe to re-apply/i);
    expect(prose).toContain("202");
    expect(prose).toContain("203");
    expect(prose).toContain("204");
  });
});

describe("205 docs", () => {
  it("docs/architecture.md: the Jev row says the command sets a 5-minute timeout (migration 205) and the job is watched, not 'only in job_run_details'", () => {
    const doc = readFileSync(DOC_ARCHITECTURE, "utf8");
    const row = doc.split("\n").find((l) => l.startsWith("| Jev sinyalleri |")) ?? "";
    expect(row.length).toBeGreaterThan(0);
    expect(row).toContain("`jev-signals-nightly`");
    expect(row).toContain("`05 4 * * *`");
    expect(row).toContain("5-minute");
    expect(row).toContain("statement_timeout");
    expect(row).toContain("migration 205");
    expect(row).toContain("`ops_cron_expected`");
    expect(row).toContain("`cron_jobs_stalled`");
    expect(row).not.toContain("Failures surface only in");
    expect(row).toContain("Zero gateway calls");
  });

  it("docs/migration-guide.md: a 205 section after 199 with apply, verify and rollback, the command and the row", () => {
    const doc = readFileSync(DOC_GUIDE, "utf8");
    const at = doc.indexOf("\n## 205 ");
    expect(at, "## 205 heading").toBeGreaterThan(0);
    expect(countOf(doc, "\n## 205 ")).toBe(1);
    expect(at).toBeGreaterThan(doc.indexOf("\n## 199 "));
    const next = doc.indexOf("\n## ", at + 1);
    const section = doc.slice(at, next < 0 ? doc.length : next);
    // the guide writes the rollback label both as "**Rollback:**" and "**Rollback** (...)": the shared prefix is pinned
    for (const part of ["**Why:**", "**What 205 does**", "**Order:**", "**Verify**", "**Rollback"]) {
      expect(section, part).toContain(part);
    }
    expect(section).toContain("APPLY 205");
    expect(section).toContain("set local statement_timeout = '5min';");
    expect(section).toContain("jev-signals-nightly");
    expect(section).toContain("21 iş izleniyor");
    expect(section).toContain("select cron.alter_job(");
    expect(section).toContain("delete from public.ops_cron_expected where jobname = 'jev-signals-nightly'");
    expect(section).toContain("delete from supabase_migrations.schema_migrations where version = '205'");
    expect(section).toContain("04:05Z");
  });

  it("docs/ops-heartbeat.md: row 19 counts 21 jobs and names jev-signals-nightly with its 26 h gap and migration 205", () => {
    const doc = readFileSync(DOC_HEARTBEAT, "utf8");
    const row = doc.split("\n").find((l) => l.startsWith("| 19 | `cron_jobs_stalled`")) ?? "";
    expect(row.length).toBeGreaterThan(0);
    expect(row).toContain("`jev-signals-nightly`");
    expect(row).toContain("26 h");
    expect(row).toContain("migration 205");
    expect(row).toContain("21 iş izleniyor");
    expect(row).not.toContain("`20 iş izleniyor`");
  });
});
