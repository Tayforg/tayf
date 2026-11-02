import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Permanent CI guard (hunt 29, h29-docs-2): a cron cadence written in the docs
// must be the cadence the migrations leave behind.
//
// docs/architecture.md said kap-drain ran every 10 minutes (migration 051 made
// it every 2), quotes-daily at `*/3 15-16` (058 moved it to `12-59/3 15-16`) and
// the image requeue hourly at :17 with 150 messages (154 made it four runs an
// hour of 40), and tests/migrations/142-image-backfill-retry.test.ts enforced the
// stale text. Nothing connected the prose to the schedules.
//
// 1. REPLAY. supabase/migrations/*.sql, sorted by file name, comments blanked by
//    a character scan that respects '...' strings:
//      cron.schedule('name', 'expr', ...)        -> map.set(name, expr)
//      cron.unschedule('name')                   -> map.delete(name)
//      cron.alter_job(.., schedule := '<expr>')  -> the job is the nearest preceding
//                                                   jobname = '<name>' literal of the
//                                                   same file (109 and 144); calls that
//                                                   carry no schedule (112, 148) are skipped.
//    A call whose arguments are not literals is pinned in UNPARSED below, so a new
//    dynamic schedule is noticed instead of silently missing from the map.
// 2. DOCS. docs/architecture.md, README.md, docs/ops-heartbeat.md and
//    docs/backup-posture.md, outside fenced blocks. On every line the backticked
//    tokens are scanned by character; job tokens are the keys of the replayed map,
//    expression tokens are five fields made of [0-9*/,-]. An expression token
//    directly after the word was / from / eski / rollback is history and is dropped,
//    and a line that says "rollback" is skipped. When a line has as many job tokens
//    as expression tokens (at least one) they are paired by position and must be
//    equal; any other line is skipped and counted.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const DOC_FILES = ["docs/architecture.md", "README.md", "docs/ops-heartbeat.md", "docs/backup-posture.md"];
const HISTORY_WORDS = new Set(["was", "from", "eski", "rollback"]);

/** Non-literal cron calls found in the migrations on 2026-11-02 (all followed by literal schedule calls). */
const UNPARSED_PINNED: readonly string[] = [
  "038_cron_schedules.sql: cron.unschedule(v_jobname)",
  "051_finance_bars_and_speed.sql: cron.unschedule(v_job)",
];

// ---------------------------------------------------------------------------
// Character-scan helpers (no regular expression runs over SQL text)
// ---------------------------------------------------------------------------

function lowerAscii(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : text[i];
  }
  return out;
}

function isIdentChar(ch: string | undefined): boolean {
  if (ch === undefined || ch === "") return false;
  const code = ch.charCodeAt(0);
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || (code >= 48 && code <= 57) || ch === "_";
}

function isBlank(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

interface Lexed {
  /** The source with comments replaced by spaces (newlines kept): same length, same offsets. */
  code: string;
  /** `code` with the inside of every '...' literal replaced by `_`: only structure is left. */
  masked: string;
  /** True when the scan ended inside a string or a block comment. */
  unterminated: boolean;
}

/** Blanks `--` and nested block comments and masks '...' literals; E'..' strings honour backslash escapes. */
function lex(src: string): Lexed {
  const code: string[] = [];
  const masked: string[] = [];
  let i = 0;
  let blockDepth = 0;
  let unterminated = false;
  while (i < src.length) {
    const ch = src[i] ?? "";
    const next = src[i + 1];
    if (blockDepth > 0) {
      if (ch === "/" && next === "*") {
        blockDepth++;
        code.push(" ", " ");
        masked.push(" ", " ");
        i += 2;
      } else if (ch === "*" && next === "/") {
        blockDepth--;
        code.push(" ", " ");
        masked.push(" ", " ");
        i += 2;
      } else {
        const keep = ch === "\n" ? "\n" : " ";
        code.push(keep);
        masked.push(keep);
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      blockDepth = 1;
      code.push(" ", " ");
      masked.push(" ", " ");
      i += 2;
      continue;
    }
    if (ch === "-" && next === "-") {
      while (i < src.length && src[i] !== "\n") {
        code.push(" ");
        masked.push(" ");
        i++;
      }
      continue;
    }
    if (ch === "'") {
      const before = src[i - 1];
      const escapeString = (before === "E" || before === "e") && !isIdentChar(src[i - 2]);
      code.push(ch);
      masked.push(ch);
      i++;
      let closed = false;
      while (i < src.length) {
        const c = src[i] ?? "";
        if (escapeString && c === "\\") {
          code.push(c, src[i + 1] ?? "");
          masked.push("_", "_");
          i += 2;
          continue;
        }
        if (c === "'") {
          if (src[i + 1] === "'") {
            code.push(c, c);
            masked.push("_", "_");
            i += 2;
            continue;
          }
          code.push(c);
          masked.push(c);
          i++;
          closed = true;
          break;
        }
        code.push(c);
        masked.push(c === "\n" ? "\n" : "_");
        i++;
      }
      if (!closed) unterminated = true;
      continue;
    }
    code.push(ch);
    masked.push(ch);
    i++;
  }
  if (blockDepth > 0) unterminated = true;
  return { code: code.join(""), masked: masked.join(""), unterminated };
}

/** Reads the '...' literal that starts at `masked[at]`; returns its value and the offset after it. */
function readLiteral(lexed: Lexed, at: number): { value: string; end: number } | null {
  if (lexed.masked[at] !== "'") return null;
  const close = lexed.masked.indexOf("'", at + 1);
  if (close < 0) return null;
  return { value: lexed.code.slice(at + 1, close).split("''").join("'"), end: close + 1 };
}

function skipBlanks(text: string, at: number): number {
  let k = at;
  while (isBlank(text[k])) k++;
  return k;
}

/** Offsets just after each `name(` in `masked` (lower-cased by the caller), with an identifier boundary before it. */
function callArgStarts(masked: string, name: string): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const at = masked.indexOf(name, from);
    if (at < 0) return out;
    from = at + 1;
    if (isIdentChar(masked[at - 1])) continue;
    const k = skipBlanks(masked, at + name.length);
    if (masked[k] === "(") out.push(k + 1);
  }
}

/** Offset of the `)` that closes the call whose arguments start at `start` (masked text, strings are inert). */
function closingParen(masked: string, start: number): number {
  let depth = 1;
  for (let i = start; i < masked.length; i++) {
    if (masked[i] === "(") depth++;
    else if (masked[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return masked.length;
}

/** Top-level comma split of the masked arguments, as [start, end) offsets. */
function splitArgs(masked: string, start: number, end: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let depth = 0;
  let from = start;
  for (let i = start; i < end; i++) {
    const ch = masked[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push([from, i]);
      from = i + 1;
    }
  }
  out.push([from, end]);
  return out;
}

/** The literal value of one argument (`'x'`, or `name := 'x'` handled by the caller), or null. */
function literalArg(lexed: Lexed, range: [number, number]): string | null {
  const at = skipBlanks(lexed.masked, range[0]);
  const lit = readLiteral(lexed, at);
  if (!lit) return null;
  return skipBlanks(lexed.masked, lit.end) >= range[1] ? lit.value : null;
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

interface Replay {
  jobs: Map<string, string>;
  unparsed: string[];
  unterminated: string[];
}

interface CronEvent {
  at: number;
  kind: "schedule" | "unschedule" | "alter_job";
  argsStart: number;
}

function snippet(lexed: Lexed, start: number): string {
  const end = Math.min(closingParen(lexed.masked, start), start + 60);
  return lexed.code.slice(start, end).split("\n").join(" ").trim();
}

/** The job named by the nearest `jobname = '<name>'` literal before `at`, or null. */
function nearestJobname(lexed: Lexed, at: number): string | null {
  const masked = lowerAscii(lexed.masked.slice(0, at));
  let from = masked.length;
  while (from >= 0) {
    const hit = masked.lastIndexOf("jobname", from);
    if (hit < 0) return null;
    from = hit - 1;
    if (isIdentChar(masked[hit - 1]) || isIdentChar(masked[hit + "jobname".length])) continue;
    let k = skipBlanks(masked, hit + "jobname".length);
    if (masked[k] !== "=") continue;
    k = skipBlanks(masked, k + 1);
    const lit = readLiteral(lexed, k);
    if (lit) return lit.value;
  }
  return null;
}

function replayFile(file: string, src: string, jobs: Map<string, string>, unparsed: string[]): boolean {
  const lexed = lex(src);
  const masked = lowerAscii(lexed.masked);
  const lexedLower: Lexed = { ...lexed, masked };
  const events: CronEvent[] = [];
  for (const [name, kind] of [
    ["cron.schedule", "schedule"],
    ["cron.unschedule", "unschedule"],
    ["cron.alter_job", "alter_job"],
  ] as const) {
    for (const argsStart of callArgStarts(masked, name)) events.push({ at: argsStart, kind, argsStart });
  }
  events.sort((a, b) => a.at - b.at);

  for (const ev of events) {
    const close = closingParen(masked, ev.argsStart);
    const args = splitArgs(masked, ev.argsStart, close);
    if (ev.kind === "schedule") {
      const name = args[0] ? literalArg(lexedLower, args[0]) : null;
      const expr = args[1] ? literalArg(lexedLower, args[1]) : null;
      if (name !== null && expr !== null) jobs.set(name, expr);
      else unparsed.push(`${file}: cron.schedule(${snippet(lexedLower, ev.argsStart)})`);
    } else if (ev.kind === "unschedule") {
      const name = args[0] ? literalArg(lexedLower, args[0]) : null;
      if (name !== null) jobs.delete(name);
      else unparsed.push(`${file}: cron.unschedule(${snippet(lexedLower, ev.argsStart)})`);
    } else {
      // alter_job(job_id, schedule, command, ...): a named or the second positional argument.
      let scheduleArg: [number, number] | null = null;
      for (const [index, range] of args.entries()) {
        const text = masked.slice(range[0], range[1]).trim();
        if (text.startsWith("schedule") && text.slice("schedule".length).trimStart().startsWith(":=")) {
          scheduleArg = [range[0] + masked.slice(range[0], range[1]).indexOf(":=") + 2, range[1]];
        } else if (index === 1 && !text.includes(":=")) scheduleArg = range;
      }
      if (scheduleArg === null) continue;
      const expr = literalArg(lexedLower, scheduleArg);
      const job = nearestJobname(lexedLower, ev.at);
      if (expr !== null && job !== null) jobs.set(job, expr);
      else unparsed.push(`${file}: cron.alter_job(${snippet(lexedLower, ev.argsStart)})`);
    }
  }
  return lexed.unterminated;
}

function replayMigrations(): Replay {
  const jobs = new Map<string, string>();
  const unparsed: string[] = [];
  const unterminated: string[] = [];
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const src = readFileSync(resolve(MIGRATIONS_DIR, file), "utf8");
    if (replayFile(file, src, jobs, unparsed)) unterminated.push(file);
  }
  return { jobs, unparsed, unterminated };
}

// ---------------------------------------------------------------------------
// Docs scan
// ---------------------------------------------------------------------------

/** Backticked tokens of one line, with the text in front of each: a character scan, no regular expression. */
function backtickTokens(line: string): Array<{ token: string; before: string }> {
  const out: Array<{ token: string; before: string }> = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      i++;
      continue;
    }
    const close = line.indexOf("`", i + 1);
    if (close < 0) break;
    const token = line.slice(i + 1, close);
    if (token.length > 0) out.push({ token, before: line.slice(0, i) });
    i = close + 1;
  }
  return out;
}

const CRON_FIELD_CHARS = new Set("0123456789*/,-".split(""));

/** Five space-separated fields, each made only of digits and the characters star, slash, comma and hyphen. */
function isCronExpression(token: string): boolean {
  const fields = token.split(" ");
  if (fields.length !== 5) return false;
  return fields.every((f) => f.length > 0 && f.split("").every((c) => CRON_FIELD_CHARS.has(c)));
}

/** The last run of ASCII letters in `before`, lower-cased ("(was " -> "was"). */
function lastWord(before: string): string {
  let end = before.length;
  while (end > 0 && !isLetter(before[end - 1])) end--;
  let start = end;
  while (start > 0 && isLetter(before[start - 1])) start--;
  return lowerAscii(before.slice(start, end));
}

function isLetter(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  const code = ch.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/** True when only blanks and punctuation (no other word) separate the last word from the token. */
function justAfterHistoryWord(before: string): boolean {
  let end = before.length;
  while (end > 0 && (isBlank(before[end - 1]) || before[end - 1] === "(" || before[end - 1] === ":")) end--;
  return HISTORY_WORDS.has(lastWord(before.slice(0, end)));
}

/** The lines of a markdown text that are outside fenced blocks, with their 1-based numbers. */
function proseLines(markdown: string): Array<{ n: number; text: string }> {
  const out: Array<{ n: number; text: string }> = [];
  let ticks = 0;
  markdown.split("\n").forEach((text, index) => {
    const trimmed = text.trimStart();
    let run = 0;
    while (trimmed[run] === "`") run++;
    if (ticks === 0) {
      if (run >= 3) ticks = run;
      else out.push({ n: index + 1, text });
    } else if (run >= ticks && trimmed.trim() === "`".repeat(trimmed.trim().length)) ticks = 0;
  });
  return out;
}

interface DocScan {
  mismatches: string[];
  verified: number;
  skipped: number;
  rollbackSkipped: number;
}

function scanDoc(file: string, markdown: string, jobs: Map<string, string>): DocScan {
  const scan: DocScan = { mismatches: [], verified: 0, skipped: 0, rollbackSkipped: 0 };
  for (const { n, text } of proseLines(markdown)) {
    if (lowerAscii(text).includes("rollback")) {
      scan.rollbackSkipped++;
      continue;
    }
    const jobTokens: string[] = [];
    const exprTokens: string[] = [];
    for (const { token, before } of backtickTokens(text)) {
      if (jobs.has(token)) jobTokens.push(token);
      else if (isCronExpression(token) && !justAfterHistoryWord(before)) exprTokens.push(token);
    }
    if (jobTokens.length === 0 && exprTokens.length === 0) continue;
    if (jobTokens.length !== exprTokens.length || jobTokens.length === 0) {
      scan.skipped++;
      continue;
    }
    scan.verified++;
    jobTokens.forEach((job, index) => {
      const want = jobs.get(job);
      const got = exprTokens[index];
      if (want !== got) scan.mismatches.push(`${file}:${n} \`${job}\` is documented as \`${got}\` but the migrations leave \`${want}\``);
    });
  }
  return scan;
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

const replay = replayMigrations();

describe("docs cron parity: replaying the migrations", () => {
  it("lexes every migration to its end (no unterminated string or comment hides a cron call)", () => {
    expect(replay.unterminated).toEqual([]);
  });

  it("pins the cron calls with non-literal arguments, so a new dynamic schedule is noticed", () => {
    expect(replay.unparsed).toEqual(UNPARSED_PINNED);
  });

  it("replays the effective schedule of the jobs whose cadence changed after their first migration", () => {
    const want: Record<string, string> = {
      "kap-drain": "*/2 * * * *",
      "quotes-daily": "12-59/3 15-16 * * 1-5",
      "image-backfill-requeue": "2,17,32,47 * * * *",
      "clusters-vacuum": "35 */6 * * *",
      "blindspot-recall-veto": "7-59/20 * * * *",
      "trends-rollup-refresh": "25 * * * *",
      "articles-vacuum": "15,45 * * * *",
    };
    for (const [job, expr] of Object.entries(want)) expect(replay.jobs.get(job), job).toBe(expr);
  });

  it("holds every job the docs name, and none of the jobs a later migration unscheduled", () => {
    expect(replay.jobs.size).toBeGreaterThanOrEqual(40);
    for (const job of ["ingest-drain", "cluster-drain", "image-drain", "prune-nightly", "reader-data-purge", "quotes-intraday", "jev-shadow", "jev-signals-nightly"]) {
      expect(replay.jobs.has(job), job).toBe(true);
    }
  });
});

describe("docs cron parity: docs against the replayed schedules", () => {
  const totals = { verified: 0, skipped: 0 };
  const mismatches: string[] = [];
  for (const file of DOC_FILES) {
    const scan = scanDoc(file, readFileSync(resolve(ROOT, file), "utf8"), replay.jobs);
    mismatches.push(...scan.mismatches);
    totals.verified += scan.verified;
    totals.skipped += scan.skipped;
  }

  it("every line with as many job names as cron expressions agrees with the migrations", () => {
    expect(mismatches).toEqual([]);
  });

  it("verifies a meaningful number of lines (the scan is not vacuous) and skips a bounded number", () => {
    // 2026-11-02: 24 lines verified, 34 skipped (prose that names a job without its cron expression, or the Vercel
    // crons, which have no job name). The bounds leave room to edit the docs but fail if the scan stops matching.
    expect(totals.verified).toBeGreaterThanOrEqual(20);
    expect(totals.skipped).toBeLessThanOrEqual(45);
  });
});

// ---------------------------------------------------------------------------
// Report only (never in CI): TAYF_CRON_REPORT=1 prints the scan counts; with
// TAYF_CRON_Q2=<file holding the JSON rows of `select jobname, schedule from
// cron.job`> it also prints the drift between the replayed map and production
// (jobs changed by hand with `update cron.job`, or never replayable).
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.TAYF_CRON_REPORT)("docs cron parity: report (not in CI)", () => {
  it("prints the counts and the drift against production", () => {
    const lines: string[] = [];
    for (const file of DOC_FILES) {
      const scan = scanDoc(file, readFileSync(resolve(ROOT, file), "utf8"), replay.jobs);
      lines.push(`${file}: verified ${scan.verified}, skipped ${scan.skipped}, rollback-skipped ${scan.rollbackSkipped}, mismatches ${scan.mismatches.length}`);
    }
    lines.push(`replayed jobs: ${replay.jobs.size}`);
    const q2 = process.env.TAYF_CRON_Q2;
    if (q2) {
      const prod = new Map<string, string>();
      for (const row of JSON.parse(readFileSync(q2, "utf8")) as Array<{ jobname: string; schedule: string }>) prod.set(row.jobname, row.schedule);
      lines.push(`production jobs: ${prod.size}`);
      for (const [job, expr] of replay.jobs) {
        if (!prod.has(job)) lines.push(`drift: ${job} replayed as '${expr}' but missing in production`);
        else if (prod.get(job) !== expr) lines.push(`drift: ${job} replayed as '${expr}' but production has '${prod.get(job)}'`);
      }
      for (const [job, expr] of prod) if (!replay.jobs.has(job)) lines.push(`drift: ${job} ('${expr}') is in production but not replayed`);
    }
    console.info(lines.join("\n"));
    expect(lines.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Self-tests of the replay and the scan
// ---------------------------------------------------------------------------

function replayOf(...files: Array<[string, string]>): Replay {
  const jobs = new Map<string, string>();
  const unparsed: string[] = [];
  const unterminated: string[] = [];
  for (const [file, src] of [...files].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (replayFile(file, src, jobs, unparsed)) unterminated.push(file);
  }
  return { jobs, unparsed, unterminated };
}

describe("docs cron parity: replay self-tests", () => {
  it("schedules, reschedules and unschedules by literal name", () => {
    const r = replayOf(
      ["001.sql", "select cron.schedule('a', '*/5 * * * *', $$ select 1 $$); select cron.schedule('b', '1 * * * *', 'x');"],
      ["002.sql", "do $x$ begin perform cron.unschedule('a'); perform cron.schedule('a', '*/7 * * * *', $q$ select 2 $q$); end $x$;"],
      ["003.sql", "select cron.unschedule('b');"],
    );
    expect([...r.jobs]).toEqual([["a", "*/7 * * * *"]]);
    expect(r.unparsed).toEqual([]);
  });

  it("reads a multi-line call, a comment between arguments and an uppercase call", () => {
    const r = replayOf([
      "001.sql",
      "PERFORM CRON.SCHEDULE(\n  'a',  -- the name\n  '2,17 * * * *',\n  $sql$ select 1 $sql$\n);",
    ]);
    expect(r.jobs.get("a")).toBe("2,17 * * * *");
  });

  it("is not fooled by comments, doubled quotes or schedule calls inside strings and comments", () => {
    const r = replayOf([
      "001.sql",
      [
        "-- select cron.schedule('ghost', '1 1 * * *', 'x');",
        "/* select cron.schedule('ghost2', '1 1 * * *', 'x'); /* nested */ still comment */",
        "raise exception 'don''t cron.schedule(''ghost3'', ''1 1 * * *'')';",
        "select cron.schedule('real', '3 3 * * *', 'select ''-- not a comment''');",
      ].join("\n"),
    ]);
    expect([...r.jobs]).toEqual([["real", "3 3 * * *"]]);
    expect(r.unterminated).toEqual([]);
  });

  it("reports an unterminated string instead of reading past it", () => {
    const r = replayOf(["001.sql", "select 'oops; select cron.schedule('a', '1 1 * * *', 'x');"]);
    expect(r.unterminated).toEqual(["001.sql"]);
  });

  it("pins non-literal schedule and unschedule calls", () => {
    const r = replayOf(["001.sql", "perform cron.schedule(v_name, '1 1 * * *', 'x'); perform cron.unschedule(v_job); perform cron.schedule('a', v_expr, 'x');"]);
    expect(r.jobs.size).toBe(0);
    expect(r.unparsed).toEqual([
      "001.sql: cron.schedule(v_name, '1 1 * * *', 'x')",
      "001.sql: cron.unschedule(v_job)",
      "001.sql: cron.schedule('a', v_expr, 'x')",
    ]);
  });

  it("applies alter_job(schedule := ...) to the nearest preceding jobname literal and skips calls without a schedule", () => {
    const r = replayOf(
      ["001.sql", "select cron.schedule('a', '0 * * * *', 'x'); select cron.schedule('b', '0 1 * * *', 'x');"],
      [
        "002.sql",
        [
          "select jobid into v_job from cron.job where jobname = 'a';",
          "perform cron.alter_job(v_job, schedule := '25 * * * *');",
          "select jobid into v_job from cron.job where jobname   =   'b';",
          "perform cron.alter_job(job_id := v_job, schedule := '7-59/20 * * * *');",
        ].join("\n"),
      ],
      [
        "003.sql",
        "select jobid into v_job from cron.job where jobname = 'a'; perform cron.alter_job(v_job, command := 'set local statement_timeout = ''120s''; select f(1);');",
      ],
    );
    expect(r.jobs.get("a")).toBe("25 * * * *");
    expect(r.jobs.get("b")).toBe("7-59/20 * * * *");
    expect(r.unparsed).toEqual([]);
  });

  it("takes the second positional argument of alter_job as the schedule, and pins an alter_job it cannot resolve", () => {
    const ok = replayOf(["001.sql", "select cron.schedule('a', '0 * * * *', 'x'); select jobid from cron.job where jobname = 'a'; select cron.alter_job(1, '5 * * * *');"]);
    expect(ok.jobs.get("a")).toBe("5 * * * *");
    const lost = replayOf(["001.sql", "select cron.alter_job(1, schedule := '5 * * * *');"]);
    expect(lost.unparsed).toEqual(["001.sql: cron.alter_job(1, schedule := '5 * * * *')"]);
  });

  it("an E'' string with a backslash-escaped quote does not desynchronise the scan", () => {
    const r = replayOf(["001.sql", "select E'it\\'s'; select cron.schedule('a', '1 1 * * *', 'x');"]);
    expect(r.jobs.get("a")).toBe("1 1 * * *");
    expect(r.unterminated).toEqual([]);
  });
});

describe("docs cron parity: docs scan self-tests", () => {
  const jobs = new Map([
    ["kap-drain", "*/2 * * * *"],
    ["quotes-daily", "12-59/3 15-16 * * 1-5"],
    ["quotes-intraday", "*/5 7-15 * * 1-5"],
    ["image-backfill-requeue", "2,17,32,47 * * * *"],
  ]);
  const scan = (text: string): DocScan => scanDoc("d.md", text, jobs);

  it("flags a stale cadence next to a job name", () => {
    const s = scan("| KAP drain | `kap-drain` | `*/10 * * * *` | pulls |");
    expect(s.verified).toBe(1);
    expect(s.mismatches).toEqual(["d.md:1 `kap-drain` is documented as `*/10 * * * *` but the migrations leave `*/2 * * * *`"]);
  });

  it("accepts the current cadence", () => {
    expect(scan("| KAP drain | `kap-drain` | `*/2 * * * *` |").mismatches).toEqual([]);
  });

  it("pairs several jobs and expressions on one line by position", () => {
    const row = "| Bars | `quotes-daily` / `quotes-intraday` | `12-59/3 15-16 * * 1-5` UTC / `*/5 7-15 * * 1-5` UTC |";
    expect(scan(row).mismatches).toEqual([]);
    expect(scan(row).verified).toBe(1);
    const stale = "| Bars | `quotes-daily` / `quotes-intraday` | `*/3 15-16 * * 1-5` UTC / `*/5 7-15 * * 1-5` UTC |";
    expect(scan(stale).mismatches).toHaveLength(1);
    const swapped = "| Bars | `quotes-daily` / `quotes-intraday` | `*/5 7-15 * * 1-5` / `12-59/3 15-16 * * 1-5` |";
    expect(scan(swapped).mismatches).toHaveLength(2);
  });

  it("drops an expression right after was / from / eski / rollback, case-insensitively", () => {
    for (const lead of ["(was ", "Was ", "changed from ", "eski ", "FROM "]) {
      const s = scan(`The \`image-backfill-requeue\` job runs \`2,17,32,47 * * * *\` (${lead}\`17 * * * *\`).`);
      expect(s.mismatches, lead).toEqual([]);
      expect(s.verified, lead).toBe(1);
    }
    // A history word that is not directly in front of the token does not excuse it.
    const stale = scan("The `image-backfill-requeue` job was moved and runs `17 * * * *` now.");
    expect(stale.mismatches).toHaveLength(1);
  });

  it("skips a line that says rollback", () => {
    const s = scan("Rollback: `image-backfill-requeue` back to `17 * * * *`.");
    expect(s.mismatches).toEqual([]);
    expect(s.verified).toBe(0);
    expect(s.rollbackSkipped).toBe(1);
  });

  it("skips and counts a line whose job and expression counts differ", () => {
    const s = scan("`kap-drain` and `quotes-daily` both run `*/10 * * * *`.");
    expect(s.mismatches).toEqual([]);
    expect(s.verified).toBe(0);
    expect(s.skipped).toBe(1);
    expect(scan("runs `* * * * *` every minute").skipped).toBe(1);
  });

  it("ignores fenced blocks, unknown tokens and text that only looks like an expression", () => {
    const md = ["```sql", "-- `kap-drain` `*/10 * * * *`", "```", "`kap-ingest` runs `*/10 * * * *`", "`kap-drain` at `1 2 3 4`", "`kap-drain` at `a b c d e`"].join("\n");
    const s = scan(md);
    expect(s.mismatches).toEqual([]);
    expect(s.verified).toBe(0);
  });

  it("tokenises backticks by character and recognises cron expressions strictly", () => {
    expect(backtickTokens("a `b` c `d e` `` f `").map((t) => t.token)).toEqual(["b", "d e"]);
    expect(isCronExpression("*/5 7-15 * * 1-5")).toBe(true);
    expect(isCronExpression("2,17,32,47 * * * *")).toBe(true);
    expect(isCronExpression("5 4 * * * *")).toBe(false);
    expect(isCronExpression("a * * * *")).toBe(false);
    expect(isCronExpression("*/5  7 * * *")).toBe(false);
  });
});
