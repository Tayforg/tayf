import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Permanent CI guard (hunt 29, h29-docs-1): the operator runbooks must contain
// SQL that RUNS and that does not change anything it is only meant to look at.
//
// Scope: every fenced block whose info string is sql, psql, pgsql or postgres
// (case-insensitive, first word) in docs/*.md and README.md.
//
//   Rule A  A statement (split on `;` outside string literals and `--` comments)
//           that mentions cron.job_run_details AND the identifier `jobname` but
//           never references the cron.job relation. The run table has no jobname
//           column (jobid, runid, job_pid, database, username, command, status,
//           return_message, start_time, end_time), so the query fails with 42703.
//           Join cron.job on jobid instead. The rule is applied per statement,
//           not per block, because one block often holds a working
//           `select ... from cron.job` next to the broken run-table query (the
//           038 verification block did), and a block-level check would pass it.
//   Rule B  A queue call that changes state when it is only pasted to look:
//             - pgmq.read(, pgmq.read_with_poll(, pgmq.pop( are ALWAYS a
//               violation: they hide the messages for the visibility timeout and
//               bump read_ct, and the consumers archive at read_ct > 3, so one
//               look from the SQL editor can push a healthy message into poison.
//               Read pgmq.q_<queue> / pgmq.a_<queue> with a select instead.
//             - pgmq.send / send_batch / archive / delete / purge_queue /
//               drop_queue / set_vt and public.pgmq_read_msgs / archive_msg /
//               delete_msg / send_msg are a violation unless the block carries the
//               line `-- MUTATES QUEUE STATE`.
//
// Implemented with indexOf and character-boundary checks, never with a regular
// expression over SQL text (the CodeQL rules of this repo). Offsets are kept by
// lower-casing ASCII letters only (String#toLowerCase can change the length).
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const DOCS_DIR = resolve(ROOT, "docs");
const SQL_INFO_STRINGS = new Set(["sql", "psql", "pgsql", "postgres"]);
const MUTATION_MARKER = "-- mutates queue state";

const ALWAYS_BAD_CALLS = ["pgmq.read", "pgmq.read_with_poll", "pgmq.pop"] as const;
const MARKER_GATED_CALLS = [
  "pgmq.send",
  "pgmq.send_batch",
  "pgmq.archive",
  "pgmq.delete",
  "pgmq.purge_queue",
  "pgmq.drop_queue",
  "pgmq.set_vt",
  "public.pgmq_read_msgs",
  "public.pgmq_archive_msg",
  "public.pgmq_delete_msg",
  "public.pgmq_send_msg",
] as const;

interface SqlBlock {
  /** 1-based line of the first line inside the fence. */
  firstLine: number;
  lines: string[];
}

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
  return (
    (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || (code >= 48 && code <= 57) || ch === "_"
  );
}

function isBlank(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/** Length of the leading run of backticks of a trimmed line (0 when it is not a fence line). */
function fenceTicks(line: string): number {
  const trimmed = line.trimStart();
  let n = 0;
  while (trimmed[n] === "`") n++;
  return n >= 3 ? n : 0;
}

/** The fenced blocks of a markdown text, as { info, firstLine, lines }. */
function fencedBlocks(markdown: string): Array<{ info: string; firstLine: number; lines: string[] }> {
  const all = markdown.split("\n");
  const out: Array<{ info: string; firstLine: number; lines: string[] }> = [];
  let open: { ticks: number; info: string; firstLine: number; lines: string[] } | null = null;
  for (let i = 0; i < all.length; i++) {
    const line = all[i] ?? "";
    const ticks = fenceTicks(line);
    if (open === null) {
      if (ticks > 0) {
        const info = line.trimStart().slice(ticks).trim();
        const firstWord = info.split(/[ \t]/)[0] ?? "";
        open = { ticks, info: lowerAscii(firstWord), firstLine: i + 2, lines: [] };
      }
      continue;
    }
    // A closing fence is only backticks, at least as many as the opener.
    if (ticks >= open.ticks && line.trim() === "`".repeat(line.trim().length)) {
      out.push({ info: open.info, firstLine: open.firstLine, lines: open.lines });
      open = null;
    } else {
      open.lines.push(line);
    }
  }
  if (open !== null) out.push({ info: open.info, firstLine: open.firstLine, lines: open.lines });
  return out;
}

function sqlBlocks(markdown: string): SqlBlock[] {
  return fencedBlocks(markdown)
    .filter((b) => SQL_INFO_STRINGS.has(b.info))
    .map((b) => ({ firstLine: b.firstLine, lines: b.lines }));
}

/** Offsets in `lower` where `token` occurs as a whole identifier (not glued to a longer one). */
function identifierAt(lower: string, token: string): number[] {
  const hits: number[] = [];
  let from = 0;
  for (;;) {
    const at = lower.indexOf(token, from);
    if (at < 0) return hits;
    if (!isIdentChar(lower[at - 1]) && !isIdentChar(lower[at + token.length])) hits.push(at);
    from = at + 1;
  }
}

/** Offsets of `name` followed (after optional blanks) by `(`, with an identifier boundary before it. */
function callsOf(lower: string, name: string): number[] {
  const hits: number[] = [];
  let from = 0;
  for (;;) {
    const at = lower.indexOf(name, from);
    if (at < 0) return hits;
    from = at + 1;
    if (isIdentChar(lower[at - 1])) continue;
    let k = at + name.length;
    while (isBlank(lower[k])) k++;
    if (lower[k] === "(") hits.push(at);
  }
}

/** True when the block references the cron.job relation (cron.job not continued by an identifier character). */
function referencesCronJobRelation(lower: string): boolean {
  let from = 0;
  for (;;) {
    const at = lower.indexOf("cron.job", from);
    if (at < 0) return false;
    from = at + 1;
    if (isIdentChar(lower[at - 1])) continue;
    if (!isIdentChar(lower[at + "cron.job".length])) return true;
  }
}

/**
 * The statements of a SQL text: split on `;` outside single-quoted strings, with `--`
 * comments blanked to spaces so offsets (and newlines) are preserved and a word in a
 * comment counts neither as a mention nor as a relation reference.
 */
function statementsOf(text: string): Array<{ start: number; code: string }> {
  const out: Array<{ start: number; code: string }> = [];
  let begin = 0;
  let code = "";
  let inString = false;
  let inComment = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (inComment) {
      if (ch === "\n") {
        inComment = false;
        code += ch;
      } else code += " ";
    } else if (inString) {
      code += ch;
      if (ch === "'") inString = false;
    } else if (ch === "'") {
      inString = true;
      code += ch;
    } else if (ch === "-" && text[i + 1] === "-") {
      inComment = true;
      code += " ";
    } else if (ch === ";") {
      out.push({ start: begin, code });
      begin = i + 1;
      code = "";
    } else code += ch;
  }
  out.push({ start: begin, code });
  return out;
}

function hasMutationMarker(lines: string[]): boolean {
  return lines.some((l) => lowerAscii(l).trim().startsWith(MUTATION_MARKER));
}

function lineOf(block: SqlBlock, offset: number): number {
  let line = block.firstLine;
  let seen = 0;
  for (const l of block.lines) {
    seen += l.length + 1;
    if (offset < seen) return line;
    line++;
  }
  return block.firstLine;
}

/** Violations of one markdown text, each as `<file>:<line> <message>`. */
function violationsIn(file: string, markdown: string): string[] {
  const out: string[] = [];
  for (const block of sqlBlocks(markdown)) {
    const raw = block.lines.join("\n");
    const lower = lowerAscii(raw);

    for (const stmt of statementsOf(raw)) {
      const code = lowerAscii(stmt.code);
      const jrd = code.indexOf("cron.job_run_details");
      if (jrd >= 0 && identifierAt(code, "jobname").length > 0 && !referencesCronJobRelation(code)) {
        out.push(
          `${file}:${lineOf(block, stmt.start + jrd)} cron.job_run_details has no jobname column: join cron.job on jobid`,
        );
      }
    }

    for (const name of ALWAYS_BAD_CALLS) {
      for (const at of callsOf(lower, name)) {
        out.push(
          `${file}:${lineOf(block, at)} ${name}( hides messages and bumps read_ct: select from pgmq.q_<queue> instead`,
        );
      }
    }

    if (!hasMutationMarker(block.lines)) {
      for (const name of MARKER_GATED_CALLS) {
        for (const at of callsOf(lower, name)) {
          out.push(
            `${file}:${lineOf(block, at)} ${name}( changes queue state: add the line "-- MUTATES QUEUE STATE" to the block`,
          );
        }
      }
    }
  }
  return out;
}

function docFiles(): string[] {
  const files = readdirSync(DOCS_DIR)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => `docs/${name}`);
  return [...files, "README.md"];
}

// ---------------------------------------------------------------------------
// The guard itself
// ---------------------------------------------------------------------------

describe("docs SQL snippets: runnable and read-only (h29-docs-1)", () => {
  const files = docFiles();

  it("scans docs/*.md and README.md and finds the SQL blocks (the scan is not vacuous)", () => {
    expect(files).toContain("docs/migration-guide.md");
    expect(files).toContain("docs/key-rotation.md");
    expect(files).toContain("README.md");
    let blocks = 0;
    for (const file of files) blocks += sqlBlocks(readFileSync(resolve(ROOT, file), "utf8")).length;
    expect(blocks).toBeGreaterThanOrEqual(120);
  });

  it("no sql block selects jobname from cron.job_run_details without joining cron.job, and none calls pgmq.read / pgmq.pop or an unmarked queue mutation", () => {
    const found: string[] = [];
    for (const file of files) {
      found.push(...violationsIn(file, readFileSync(resolve(ROOT, file), "utf8")));
    }
    expect(found).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Mutation self-tests: the scanner flags what it must and ignores what it must
// ---------------------------------------------------------------------------

const FENCE = "```";
const doc = (info: string, ...lines: string[]): string => [`${FENCE}${info}`, ...lines, FENCE].join("\n");

describe("docs SQL snippets: scanner self-tests", () => {
  it("flags a jobname filter on cron.job_run_details and reports the line of the table", () => {
    const md = ["# t", "", doc("sql", "select jobname, status", "  from cron.job_run_details", "  where jobname = 'x';")].join("\n");
    expect(violationsIn("d.md", md)).toEqual([
      "d.md:5 cron.job_run_details has no jobname column: join cron.job on jobid",
    ]);
  });

  it("passes the joined form", () => {
    const md = doc(
      "sql",
      "select j.jobname, d.status, d.return_message, d.start_time",
      "  from cron.job_run_details d join cron.job j using (jobid)",
      "  where j.jobname in ('cluster-drain') order by d.start_time desc limit 10;",
    );
    expect(violationsIn("d.md", md)).toEqual([]);
  });

  it("does not take cron.job_run_details for the cron.job relation, and accepts a later cron.job reference", () => {
    expect(referencesCronJobRelation("from cron.job_run_details where jobname = 'x'")).toBe(false);
    expect(referencesCronJobRelation("from cron.job_run_details; select 1 from cron.job;")).toBe(true);
    expect(referencesCronJobRelation("select * from cron.job\n where true")).toBe(true);
    expect(referencesCronJobRelation("select * from cron.job)")).toBe(true);
    expect(referencesCronJobRelation("select * from xcron.job")).toBe(false);
  });

  it("checks each statement: a working cron.job select next to a broken run-table query is still flagged (the 038 block)", () => {
    const md = doc(
      "sql",
      "select jobname, schedule, active from cron.job where jobname in ('a');",
      "",
      "select jobname, status",
      "  from cron.job_run_details",
      "  where jobname in ('a');",
    );
    expect(violationsIn("d.md", md)).toEqual([
      "d.md:5 cron.job_run_details has no jobname column: join cron.job on jobid",
    ]);
  });

  it("ignores words in comments and in the split of a semicolon inside a string literal", () => {
    const commentOnly = doc("sql", "-- jobname is resolved through cron.job", "select status from cron.job_run_details where jobid = 3;");
    expect(violationsIn("d.md", commentOnly)).toEqual([]);
    const commentRelation = doc("sql", "-- cron.job", "select jobname from cron.job_run_details;");
    expect(violationsIn("d.md", commentRelation)).toHaveLength(1);
    const semicolonInString = doc(
      "sql",
      "select d.status from cron.job_run_details d join cron.job j using (jobid)",
      "  where j.jobname = 'a;b';",
    );
    expect(violationsIn("d.md", semicolonInString)).toEqual([]);
    expect(statementsOf("select 'x;y'; select 2;").map((st) => st.code.trim())).toEqual(["select 'x;y'", "select 2", ""]);
  });

  it("does not flag a run-table query that never names jobname", () => {
    const md = doc("sql", "select status, start_time from cron.job_run_details where jobid = 3;");
    expect(violationsIn("d.md", md)).toEqual([]);
  });

  it("treats jobname as a whole identifier only", () => {
    const md = doc("sql", "select a_jobname_x from cron.job_run_details;");
    expect(violationsIn("d.md", md)).toEqual([]);
  });

  it("flags pgmq.read, pgmq.read_with_poll and pgmq.pop, blanks before the parenthesis allowed", () => {
    const md = doc(
      "sql",
      "select * from pgmq.read('image_backfill', 60, 5);",
      "select * from pgmq.read_with_poll ('q', 30, 1);",
      "select * from pgmq.pop\t('q');",
    );
    expect(violationsIn("d.md", md)).toEqual([
      expect.stringContaining("d.md:2 pgmq.read("),
      expect.stringContaining("d.md:3 pgmq.read_with_poll("),
      expect.stringContaining("d.md:4 pgmq.pop("),
    ]);
  });

  it("flags the queue mutations unless the block carries the marker line", () => {
    const bare = doc("sql", "select pgmq.archive('cluster_work', 42);", "select public.pgmq_send_msg('q', '{}'::jsonb);");
    expect(violationsIn("d.md", bare)).toEqual([
      expect.stringContaining("d.md:2 pgmq.archive("),
      expect.stringContaining("d.md:3 public.pgmq_send_msg("),
    ]);
    const marked = doc("sql", "-- MUTATES QUEUE STATE", "select pgmq.archive('cluster_work', 42);", "select public.pgmq_send_msg('q', '{}'::jsonb);");
    expect(violationsIn("d.md", marked)).toEqual([]);
  });

  it("never lets the marker excuse pgmq.read / pgmq.pop", () => {
    const md = doc("sql", "-- MUTATES QUEUE STATE", "select * from pgmq.read('q', 30, 1);");
    expect(violationsIn("d.md", md)).toHaveLength(1);
  });

  it("ignores pgmq.read in prose, in inline code and in non-sql fences", () => {
    const md = [
      "Never call pgmq.read from the SQL editor; `pgmq.read('q', 1, 1)` bumps read_ct.",
      doc("bash", "psql -c \"select * from pgmq.read('q', 1, 1)\""),
      doc("", "select * from pgmq.read('q', 1, 1);"),
      doc("json", "{\"jobname\": \"cron.job_run_details\"}"),
    ].join("\n");
    expect(violationsIn("d.md", md)).toEqual([]);
  });

  it("does not match longer identifiers (pgmq.reader, my_pgmq.read, pgmq.read_x)", () => {
    const md = doc("sql", "select pgmq.reader(1);", "select my_pgmq.read(1);", "select pgmq.read_x(1);", "select pgmq.q_image_backfill;");
    expect(violationsIn("d.md", md)).toEqual([]);
  });

  it("recognises sql, psql, pgsql and postgres info strings in any case, and an info string with extra words", () => {
    const body = "select * from pgmq.read('q', 1, 1);";
    for (const info of ["sql", "SQL", "psql", "pgsql", "Postgres", "sql title=\"x\""]) {
      expect(violationsIn("d.md", doc(info, body)), info).toHaveLength(1);
    }
    for (const info of ["bash", "sh", "text", "typescript", "sqlite"]) {
      expect(violationsIn("d.md", doc(info, body)), info).toEqual([]);
    }
  });

  it("handles indented fences inside lists, longer fences, an unterminated fence and a fence inside another", () => {
    const indented = ["1. step", "", "   ```sql", "   select * from pgmq.pop('q');", "   ```"].join("\n");
    expect(violationsIn("d.md", indented)).toEqual([expect.stringContaining("d.md:4 pgmq.pop(")]);

    const long = ["````sql", "select * from pgmq.pop('q');", "```", "select 1;", "````"].join("\n");
    expect(violationsIn("d.md", long)).toHaveLength(1);

    const unterminated = ["```sql", "select * from pgmq.pop('q');"].join("\n");
    expect(violationsIn("d.md", unterminated)).toHaveLength(1);

    const nested = ["```text", "```sql", "select * from pgmq.pop('q');", "```"].join("\n");
    expect(violationsIn("d.md", nested)).toEqual([]);
  });

  it("keeps offsets stable across non-ASCII text", () => {
    const md = doc("sql", "-- İstanbul İİİ", "select * from pgmq.pop('q');");
    expect(violationsIn("d.md", md)).toEqual([expect.stringContaining("d.md:3 pgmq.pop(")]);
  });
});
