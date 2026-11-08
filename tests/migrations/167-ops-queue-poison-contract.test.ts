import { describe, it, expect, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 167 ("ops-queue-poison-contract"), h51-pipeline-1.
//
// ops_health_report() row 18 (queue_lag) counted as "zehirli" (poison) every message archived in the last 24 hours
// with read_ct >= 3. The consumers' contract is different: image-consumer and cluster-consumer archive a message as
// poison only when read_ct EXCEEDS MAX_READS (3), on the 4th read. A message that was processed on its 3rd read and
// archived normally therefore warned for 24 hours (production, 2026-11-06: 11 image_backfill rows, msg_id
// 182446-182456, all with image_url set, 'zehirli (24 sa): 11'), and a real poison message would have hidden among
// such rows. 167 re-creates the function with 161's text (the production fingerprint) except the two read_ct
// comparisons and the two sentences that describe them.
//
// This file pins: 161's body is the one on production (md5 and length), 167's body is 161's with exactly those
// spots changed (a line diff of three lines, and a replacement that reproduces the file byte for byte), the new
// fingerprint, that the SQL constant is the consumers' MAX_READS (both Edge Functions are parsed, so the two cannot
// drift), the function comment, revoke/grant, the ledger pattern, the docs and the live manifest. The live block at
// the end runs row 18 against archive fixtures through psql when TAYF_PSQL is set.
//
// SQL is scanned by character, never with a nested-quantifier regex (CodeQL).
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const MIGRATION_167 = resolve(MIGRATIONS_DIR, "167_ops_queue_poison_contract.sql");
const MIGRATION_161 = resolve(MIGRATIONS_DIR, "161_image_coverage_by_source.sql");
const IMAGE_CONSUMER = resolve(ROOT, "supabase", "functions", "image-consumer", "index.ts");
const CLUSTER_CONSUMER = resolve(ROOT, "supabase", "functions", "cluster-consumer", "index.ts");
const DOC_MIGRATION_GUIDE = resolve(ROOT, "docs", "migration-guide.md");
const DOC_OPS_HEARTBEAT = resolve(ROOT, "docs", "ops-heartbeat.md");
const LIVE_MANIFEST = resolve(__dirname, "sql", "live-manifest.txt");
const DRYRUN = resolve(__dirname, "sql", "167-ops-queue-poison-contract-dryrun.sql");

const CREATE_LINE = "create or replace function public.ops_health_report()";
/** What follows the last row's `return next;`. */
const FN_END = "\n\n  return;\nend\n$fn$;";

/** Production, read-only, 2026-11-06: md5(prosrc) and length of ops_health_report() before 167 (migration 161's text). */
const PROD_MD5_BEFORE = "c1c2ff6c61daede5a5e8c8695547b445";
const PROD_LENGTH_BEFORE = 47349;
/** The text between the dollar-quote markers of 167. */
const MD5_AFTER = "5a9f9e384da09a19df1cd73a3f8ba4a5";
const LENGTH_AFTER = 47439;

/** The two executable comparisons (each inside a `$q$` query of row 18), before and after. */
const OLD_CMP = "a.read_ct >= 3)";
const NEW_CMP = "a.read_ct > 3)";
/** The row-18 comment sentence, before and after. */
const OLD_ROW_COMMENT =
  "plus the archived messages of the last 24 hours with read_ct >= 3 (poison: the consumer gave up on them; the archived_at indexes make it a range scan)";
const NEW_ROW_COMMENT =
  "plus the messages archived in the last 24 hours with read_ct > 3 (poison: the consumers archive on the 4th read, MAX_READS = 3, so a message processed on its 3rd read is not poison, migration 167; the archived_at indexes make it a range scan)";
/** The sentence of the function comment (the text of `comment on function`, adjacent literals joined), before and after. */
const OLD_FN_COMMENT = "plus the messages archived in the last 24 hours with read_ct >= 3, poison;";
const NEW_FN_COMMENT =
  "plus the messages archived in the last 24 hours with read_ct > 3, poison (the consumers archive on the 4th read, MAX_READS = 3; a message processed on its 3rd read is not poison; cluster-consumer gates only a failed attempt, so a cluster_work message that succeeds on its 4th or later read is counted too);";
/** The migration list of the function comment, before and after (167 adds itself, as every earlier re-creation did). */
const OLD_FN_MIGRATIONS = "159, 161): 21 fixed rows";
const NEW_FN_MIGRATIONS = "159, 161, 167): 21 fixed rows";

const REVOKE_STMT = "revoke all on function public.ops_health_report() from public, anon, authenticated";
const GRANT_STMT = "grant execute on function public.ops_health_report() to service_role";
const LEDGER_STMT =
  "insert into supabase_migrations.schema_migrations (version, name) values ('167', '167_ops_queue_poison_contract') on conflict do nothing";
const LOCK_STMT = "set local lock_timeout = '5s'";

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

/** Empties every single-quoted literal. */
function blankStrings(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    if (sql.charAt(i) === "'") {
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
      out += sql.charAt(i);
      i += 1;
    }
  }
  return out;
}

/** Splits comment-free SQL on `;`, not inside a quoted string or a dollar-quoted body. */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  let dollar: string | null = null;
  while (i < sql.length) {
    const ch = sql.charAt(i);
    if (dollar) {
      if (sql.startsWith(dollar, i)) {
        cur += dollar;
        i += dollar.length;
        dollar = null;
      } else {
        cur += ch;
        i += 1;
      }
      continue;
    }
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
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "$") {
      const end = sql.indexOf("$", i + 1);
      const tag = end > i ? sql.slice(i, end + 1) : "";
      const isTag = tag.length >= 2 && [...tag.slice(1, -1)].every((c) => /[a-z_0-9]/i.test(c));
      if (isTag) {
        dollar = tag;
        cur += tag;
        i += tag.length;
        continue;
      }
    }
    if (ch === ";") {
      if (cur.trim() !== "") out.push(cur.trim());
      cur = "";
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Identifier-like words of the text, lower case. */
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

/** How many times `needle` occurs in `text` (non-overlapping). */
function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** The text of `comment on function ... is '...';`, with adjacent literals joined. */
function commentText(sql: string): string {
  const at = sql.indexOf("comment on function public.ops_health_report() is");
  expect(at, "comment on function").toBeGreaterThanOrEqual(0);
  const end = sql.indexOf(";\n", at);
  const body = sql.slice(at, end);
  let out = "";
  let i = body.indexOf("'");
  while (i >= 0 && i < body.length) {
    let j = i + 1;
    let lit = "";
    while (j < body.length) {
      if (body.charAt(j) === "'") {
        if (body.charAt(j + 1) === "'") {
          lit += "'";
          j += 2;
          continue;
        }
        break;
      }
      lit += body.charAt(j);
      j += 1;
    }
    out += lit;
    i = body.indexOf("'", j + 1);
  }
  return out;
}

/** The text between the opening and the closing `$fn$` of the ops_health_report() definition (what pg_proc.prosrc holds). */
function prosrcOf(rawSql: string): string {
  const from = rawSql.lastIndexOf(CREATE_LINE);
  const open = rawSql.indexOf("as $fn$", from) + "as $fn$".length;
  return rawSql.slice(open, rawSql.indexOf("$fn$;", open));
}

/** The whole `comment on function ...;` section of a migration (from the last occurrence to the revoke). */
function commentSection(rawSql: string): string {
  return rawSql.slice(rawSql.lastIndexOf("comment on function public.ops_health_report() is"));
}

/** Literal `check_name := 'x';` names of a body, in order. */
function literalNames(body: string): string[] {
  const out: string[] = [];
  const marker = "check_name := '";
  let at = body.indexOf(marker);
  while (at >= 0) {
    const start = at + marker.length;
    out.push(body.slice(start, body.indexOf("'", start)));
    at = body.indexOf(marker, start);
  }
  return out;
}

/** The integers that follow `read_ct <op> ` in the text, in order. */
function readCtLimits(text: string, op: string): number[] {
  const marker = `read_ct ${op} `;
  const out: number[] = [];
  let at = text.indexOf(marker);
  while (at >= 0) {
    let j = at + marker.length;
    let digits = "";
    while (j < text.length && text.charAt(j) >= "0" && text.charAt(j) <= "9") {
      digits += text.charAt(j);
      j += 1;
    }
    if (digits) out.push(Number(digits));
    at = text.indexOf(marker, at + marker.length);
  }
  return out;
}

/** The lines of a TypeScript file that are code, not comments. */
function codeLines(src: string): string[] {
  return src.split("\n").filter((l) => {
    const t = l.trim();
    return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  });
}

/** The values of every `const MAX_READS = <n>;` line of a TypeScript file. */
function maxReadsOf(src: string): number[] {
  const prefix = "const MAX_READS = ";
  return codeLines(src)
    .map((l) => l.trim())
    .filter((l) => l.startsWith(prefix))
    .map((l) => Number(l.slice(prefix.length, l.indexOf(";"))));
}

/** The section of a markdown file from `\n## <num>` to the next `\n## `. */
function sectionOf(md: string, num: string): string {
  const at = md.indexOf(`\n## ${num}`);
  expect(at, `the ## ${num} section`).toBeGreaterThan(0);
  const next = md.indexOf("\n## ", at + 1);
  return md.slice(at, next < 0 ? md.length : next);
}

let raw = "";
let code = "";
let statements: string[] = [];
let raw161 = "";
let fn167 = "";
let fn161 = "";
let body167 = "";
let body161 = "";

beforeAll(() => {
  raw = readFileSync(MIGRATION_167, "utf8");
  code = stripComments(raw);
  statements = splitStatements(code);
  raw161 = readFileSync(MIGRATION_161, "utf8");
  // the last occurrence: a header may quote the create line in a comment
  const from167 = raw.lastIndexOf(CREATE_LINE);
  fn167 = raw.slice(from167, raw.indexOf(FN_END, from167) + FN_END.length);
  const from161 = raw161.lastIndexOf(CREATE_LINE);
  fn161 = raw161.slice(from161, raw161.indexOf(FN_END, from161) + FN_END.length);
  body167 = prosrcOf(raw);
  body161 = prosrcOf(raw161);
});

describe("167 helpers (the scans are not vacuous)", () => {
  it("stripComments drops -- outside strings and keeps it inside them", () => {
    expect(stripComments("a -- b\nc '-- d'")).toBe("a \nc '-- d'");
  });

  it("splitStatements keeps ; inside strings and dollar-quoted bodies", () => {
    expect(splitStatements("select 'a;b'; do $x$ begin a; b; end $x$; select 2;")).toEqual([
      "select 'a;b'",
      "do $x$ begin a; b; end $x$",
      "select 2",
    ]);
  });

  it("blankStrings empties literals, wordsOf lists whole words, literalNames reads the check names", () => {
    expect(blankStrings("a 'it''s' b")).toBe("a '' b");
    expect(wordsOf("select x.read_ct, 'y'")).toEqual(["select", "x", "read_ct", "y"]);
    expect(literalNames("check_name := 'a_b'; x; check_name := 'c';")).toEqual(["a_b", "c"]);
  });

  it("readCtLimits reads the integer after the operator, maxReadsOf reads the consumers' constant, countOf counts", () => {
    expect(readCtLimits("a.read_ct > 3) and b.read_ct >= 12 or c.read_ct > x", ">")).toEqual([3]);
    expect(readCtLimits("a.read_ct > 3) and b.read_ct >= 12", ">=")).toEqual([12]);
    expect(maxReadsOf("// const MAX_READS = 9;\nconst MAX_READS = 3;\n")).toEqual([3]);
    expect(countOf("a.b.c", ".")).toBe(2);
  });
});

describe("167 ledger and structure", () => {
  it("is one transaction: begin; first, commit; last", () => {
    expect(statements[0]).toBe("begin");
    expect(statements[statements.length - 1]).toBe("commit");
    expect(statements.filter((s) => s === "begin")).toHaveLength(1);
    expect(statements.filter((s) => s === "commit")).toHaveLength(1);
  });

  it("sets lock_timeout 5s right after begin", () => {
    expect(collapse(statements[1] as string)).toBe(LOCK_STMT);
  });

  it("ends with the ledger row in the 095 pattern, then commit", () => {
    const tail = statements.slice(-2).map(collapse);
    expect(tail[0]).toBe(LEDGER_STMT);
    expect(tail[1]).toBe("commit");
  });

  it("is, in order: begin, lock_timeout, the function, its comment, revoke, grant, ledger, commit", () => {
    const kinds = statements.map((s) => collapse(s).split(" ").slice(0, 3).join(" "));
    expect(kinds).toEqual([
      "begin",
      "set local lock_timeout",
      "create or replace",
      "comment on function",
      "revoke all on",
      "grant execute on",
      "insert into supabase_migrations.schema_migrations",
      "commit",
    ]);
  });

  it("is additive: no update, delete, drop, truncate, alter, schedule, index or trigger anywhere, and the ledger row is the only insert", () => {
    const outside = wordsOf(blankStrings(statements.filter((s) => !s.startsWith("create or replace function")).join(";\n")));
    for (const w of ["update", "delete", "drop", "truncate", "alter", "schedule", "unschedule", "trigger", "index", "concurrently", "cron", "table"]) {
      expect(outside, w).not.toContain(w);
    }
    const inserts = statements.filter((s) => wordsOf(blankStrings(s)).includes("insert"));
    expect(inserts.map(collapse)).toEqual([LEDGER_STMT]);
    // and the function statement itself (the whole body, 161's rows included) writes nothing
    const body = wordsOf(blankStrings(stripComments(body167)));
    for (const w of ["insert", "update", "delete", "truncate", "drop", "alter", "create"]) {
      expect(body, w).not.toContain(w);
    }
  });

  it("does not notify pgrst: no table, column or RPC shape changes", () => {
    expect(wordsOf(blankStrings(code))).not.toContain("notify");
  });

  it("keeps the revoke and the grant exactly as 161 issues them (service_role only)", () => {
    const stmts161 = splitStatements(stripComments(raw161)).map(collapse);
    const stmts167 = statements.map(collapse);
    expect(stmts161).toContain(REVOKE_STMT);
    expect(stmts161).toContain(GRANT_STMT);
    expect(stmts167.filter((s) => s.startsWith("revoke "))).toEqual([REVOKE_STMT]);
    expect(stmts167.filter((s) => s.startsWith("grant "))).toEqual([GRANT_STMT]);
    expect(stmts167.indexOf(REVOKE_STMT)).toBe(stmts167.indexOf(GRANT_STMT) - 1);
    expect(wordsOf(blankStrings(code))).not.toContain("default");
  });

  it("keeps the signature, language, volatility, security definer and the empty search_path of 161", () => {
    const head = (fn: string) => fn.slice(0, fn.indexOf("as $fn$"));
    expect(head(fn167)).toBe(head(fn161));
    const h = collapse(head(fn167));
    expect(h).toContain("returns table (check_name text, status text, observed numeric, threshold numeric, detail text)");
    expect(h).toContain("language plpgsql volatile security definer set search_path = ''");
  });
});

describe("167 header documents the change", () => {
  let header = "";
  beforeAll(() => {
    header = raw.slice(0, raw.indexOf("\nbegin;"));
  });

  it("names the finding, the evidence and the sections", () => {
    expect(header).toMatch(/^-- 167_ops_queue_poison_contract\.sql/);
    for (const word of [
      "h51-pipeline-1",
      "queue_lag",
      "zehirli (24 sa): 11",
      "MAX_READS",
      "read_ct > 3",
      "4th read",
      "182446",
      "haberport",
      "image_backfill_attempts",
      "h24-ops-1",
      "WHY",
      "WHAT CHANGES",
    ]) {
      expect(header, word).toContain(word);
    }
  });

  it("states which queue the 4th-read rule is exact for, and that cluster_work can count a late success", () => {
    const flat = header.replace(/\n-- ?/g, " ").replace(/ +/g, " ");
    for (const phrase of [
      "image-consumer gates before processing, so every image_backfill archive at read_ct > 3 is poison",
      "cluster-consumer gates only in its error path (:3420) and archives a success at any read_ct",
      "a cluster_work message that succeeds on its 4th or later read is counted too",
      "none on production since 2026-10-30",
      "the cluster_work gate at :3420; :2942 is the same gate on the cluster_attach queue, which row 18 does not read",
      "The image-consumer comment at :459-461 (before this change)",
      "the matching sentence of the function comment, and 167 added to its migration list",
    ]) {
      expect(flat, phrase).toContain(phrase);
    }
    expect(flat).not.toContain("the gates at :2942 and :3420");
    expect(flat).not.toContain("comment at :454-457");
  });

  it("records the production fingerprint it copies, the fingerprint it produces, and the dry run", () => {
    expect(header).toContain("STEP 0");
    expect(header).toContain(PROD_MD5_BEFORE);
    expect(header).toContain(String(PROD_LENGTH_BEFORE));
    expect(header).toContain(MD5_AFTER);
    expect(header).toContain(String(LENGTH_AFTER));
    expect(header).toContain("DRY RUN");
  });

  it("states the deploy order: apply only, no function deploy, no app deploy", () => {
    expect(header).toContain("DEPLOY: APPLY 167 ONLY");
    expect(header).toContain("image-consumer");
    expect(header).toContain("comment-only");
  });

  it("has a verify section and a rollback that restores 161's function and drops nothing", () => {
    expect(header).toContain("VERIFY (read-only");
    expect(header).toContain("zehirli (24 sa): 0");
    const rb = header.slice(header.indexOf("ROLLBACK"));
    expect(rb).toContain("ONLY 161's ops_health_report() section");
    expect(rb).toContain("delete from supabase_migrations.schema_migrations where version = '167'");
    expect(rb).toContain(PROD_MD5_BEFORE);
  });

  it("changes no data: it does not touch the queues or the parked rows", () => {
    expect(code).not.toContain("image_backfill_attempts");
    expect(wordsOf(blankStrings(code))).not.toContain("pgmq_send");
  });
});

describe("167 is 161's function with the poison comparison changed", () => {
  it("161's function body is the one running on production (md5 and length from the read-only fingerprint)", () => {
    expect(createHash("md5").update(body161).digest("hex")).toBe(PROD_MD5_BEFORE);
    expect(body161.length).toBe(PROD_LENGTH_BEFORE);
  });

  it("167's function body has the pinned new fingerprint", () => {
    expect(createHash("md5").update(body167).digest("hex")).toBe(MD5_AFTER);
    expect(body167.length).toBe(LENGTH_AFTER);
    // the three replacements below change the length by exactly this much: +90 characters
    expect(body167.length - body161.length).toBe(
      (NEW_ROW_COMMENT.length - OLD_ROW_COMMENT.length) + 2 * (NEW_CMP.length - OLD_CMP.length),
    );
  });

  it("the old text is in 161 (once, twice) and the new text is in 167 (once, twice); the old text is gone from 167", () => {
    expect(countOf(fn161, OLD_ROW_COMMENT)).toBe(1);
    expect(countOf(fn161, OLD_CMP)).toBe(2);
    expect(countOf(fn167, NEW_ROW_COMMENT)).toBe(1);
    expect(countOf(fn167, NEW_CMP)).toBe(2);
    expect(countOf(fn167, OLD_ROW_COMMENT)).toBe(0);
    expect(countOf(fn167, OLD_CMP)).toBe(0);
  });

  it("applying those three replacements to 161's function gives 167's function byte for byte (comments included)", () => {
    const expected = fn161.replace(OLD_ROW_COMMENT, NEW_ROW_COMMENT).replaceAll(OLD_CMP, NEW_CMP);
    expect(fn167).toBe(expected);
    expect(fn167.length).toBeGreaterThan(47000);
  });

  it("differs from 161's function on exactly three lines: the row-18 comment and the two archive counts", () => {
    const a = fn161.split("\n");
    const b = fn167.split("\n");
    expect(b).toHaveLength(a.length);
    const changed = a.map((l, i) => (l === b[i] ? -1 : i)).filter((i) => i >= 0);
    expect(changed).toHaveLength(3);
    const first = a[changed[0] as number] as string;
    expect(first.trimStart().startsWith("-- 18. queue_lag (migration 150).")).toBe(true);
    expect(b[changed[0] as number]).toBe(first.replace(OLD_ROW_COMMENT, NEW_ROW_COMMENT));
    for (const i of changed.slice(1)) {
      expect(a[i]).toContain("pgmq.a_");
      expect(b[i]).toBe((a[i] as string).replace(OLD_CMP, NEW_CMP));
    }
    // the two executable lines are the two archives, one each
    expect(changed.slice(1).map((i) => (b[i] as string).includes("a_cluster_work"))).toEqual([true, false]);
    expect(changed.slice(1).map((i) => (b[i] as string).includes("a_image_backfill"))).toEqual([false, true]);
  });

  it("row 18 keeps its marker, its other limits, its status rule and its Turkish detail format", () => {
    const at = body167.indexOf("check_name := 'queue_lag'");
    const row = body167.slice(at, body167.indexOf("return next;", at));
    expect(row).toContain("threshold := 900");
    expect(row).toContain("when qc_oldest > 900 or qi_oldest > 3600 then 'fail'");
    expect(row).toContain("when qc_oldest > 300 or qc_depth > 300 or qi_oldest > 1800 or q_poison >= 1 then 'warn'");
    expect(row).toContain("' sn · zehirli (24 sa): ' || q_poison::text");
    expect(row).toContain("a.archived_at >= pg_catalog.now() - interval '24 hours'");
    // the marker line that tests/guards/ops-health-checks.test.ts pins right after row 17
    expect(body167).toContain("\n\n  -- 18. queue_lag (migration 150). Nothing watched clustering");
  });

  it("the body's literal check names are 161's, in the same order (21 rows: the three zone rows share one literal built in a loop)", () => {
    const names161 = literalNames(body161);
    const names167 = literalNames(body167);
    expect(names161).toHaveLength(19);
    expect(names167).toEqual(names161);
    expect(names167[names167.length - 1]).toBe("image_coverage");
    expect(names167).toContain("queue_lag");
    expect(names167.indexOf("queue_lag")).toBe(names161.indexOf("queue_lag"));
    expect(names167.filter((n) => n === "queue_lag")).toHaveLength(1);
  });
});

describe("167 poison means read_ct > MAX_READS, as the consumers define it", () => {
  const image = readFileSync(IMAGE_CONSUMER, "utf8");
  const cluster = readFileSync(CLUSTER_CONSUMER, "utf8");

  it("no `read_ct >= 3` is left in the executable SQL, the function body, or the function comment", () => {
    expect(countOf(stripComments(body167), "read_ct >= 3")).toBe(0);
    expect(countOf(body167, "read_ct >= 3")).toBe(0);
    expect(countOf(commentText(commentSection(raw)), "read_ct >= 3")).toBe(0);
    expect(readCtLimits(code, ">=")).toEqual([]);
  });

  it("`read_ct > 3` appears exactly twice in the executable SQL: once per archive, cluster_work then image_backfill", () => {
    const exec = stripComments(body167);
    expect(countOf(exec, "read_ct > 3")).toBe(2);
    expect(readCtLimits(exec, ">")).toEqual([3, 3]);
    expect(countOf(exec,"pgmq.a_cluster_work a where a.archived_at >= pg_catalog.now() - interval '24 hours' and a.read_ct > 3")).toBe(1);
    expect(countOf(exec, "pgmq.a_image_backfill a where a.archived_at >= pg_catalog.now() - interval '24 hours' and a.read_ct > 3")).toBe(1);
  });

  it("both consumers declare `const MAX_READS = 3;` and archive only on `read_ct > MAX_READS`", () => {
    for (const [name, src] of [
      ["image-consumer", image],
      ["cluster-consumer", cluster],
    ] as const) {
      expect(maxReadsOf(src), `${name}: const MAX_READS`).toEqual([3]);
      const gate = codeLines(src).filter((l) => l.includes("read_ct > MAX_READS"));
      expect(gate.length, `${name}: read_ct > MAX_READS`).toBeGreaterThanOrEqual(1);
      expect(codeLines(src).filter((l) => l.includes("read_ct >= MAX_READS")), `${name}: no >= gate`).toEqual([]);
      expect(codeLines(src).filter((l) => l.includes("read_ct >= 3") || l.includes("read_ct > 3")), `${name}: no literal`).toEqual([]);
    }
  });

  it("the SQL limit is the consumers' MAX_READS: change one and this fails (the two cannot drift)", () => {
    const [imageMax] = maxReadsOf(image);
    const [clusterMax] = maxReadsOf(cluster);
    expect(imageMax).toBe(clusterMax);
    expect(readCtLimits(stripComments(body167), ">")).toEqual([imageMax, imageMax]);
  });

  it("the function comment carries the same limit", () => {
    const c = commentText(commentSection(raw));
    expect(readCtLimits(c, ">")).toEqual([3]);
    expect(c).toContain("MAX_READS = 3");
  });
});

describe("167 function comment", () => {
  it("is 161's comment with the poison sentence changed and 167 added to its migration list, nothing else", () => {
    const c161 = commentText(commentSection(raw161));
    const c167 = commentText(commentSection(raw));
    expect(countOf(c161, OLD_FN_COMMENT)).toBe(1);
    expect(countOf(c167, NEW_FN_COMMENT)).toBe(1);
    expect(countOf(c161, OLD_FN_MIGRATIONS)).toBe(1);
    expect(countOf(c167, NEW_FN_MIGRATIONS)).toBe(1);
    expect(c167).toBe(c161.replace(OLD_FN_COMMENT, NEW_FN_COMMENT).replace(OLD_FN_MIGRATIONS, NEW_FN_MIGRATIONS));
  });

  it("still lists 21 fixed rows, service_role only, never reads a secret-bearing pg_cron field, and points at docs/ops-heartbeat.md", () => {
    const c = commentText(commentSection(raw));
    expect(c).toContain("21 fixed rows, in this order --");
    expect(c).toContain("service_role only");
    expect(c).toContain("never reads any potentially secret-bearing pg_cron job field");
    expect(c).toContain("docs/ops-heartbeat.md");
    expect(c).toContain("or one poison message exists");
  });
});

describe("167 docs/ops-heartbeat.md", () => {
  let doc = "";
  beforeAll(() => {
    doc = readFileSync(DOC_OPS_HEARTBEAT, "utf8");
  });

  it("row 18 defines poison as read_ct > 3 (the 4th read) and credits migration 167", () => {
    const at = doc.indexOf("| 18 | `queue_lag`");
    expect(at).toBeGreaterThan(doc.indexOf("| 17 | `anon_surface`"));
    const row = doc.slice(at, doc.indexOf("\n", at));
    for (const word of ["`read_ct > 3`", "4th read", "MAX_READS", "3rd read", "not poison", "167"]) {
      expect(row, word).toContain(word);
    }
    expect(row).toContain("`image-consumer` before it processes the message, `cluster-consumer` after a failed attempt");
    expect(row).toContain("`cluster-consumer` archives a success at any `read_ct`");
    expect(row).not.toContain("both archive a message only once");
    expect(row).not.toContain("read_ct >= 3");
    expect(row).toContain("zehirli (24 sa): 0");
    expect(row).toContain("poison ≥ 1");
  });

  it("no line of the document still says `read_ct >= 3`", () => {
    expect(doc).not.toContain("read_ct >= 3");
    expect(doc).toContain("with `read_ct > 3` (the 4th read)");
  });

  it("keeps the 21-row count of 161", () => {
    // 173 appended a twenty-second row and moved the count (tests/migrations/173-ops-sources-dark-persistent.test.ts pins 22)
    expect(doc).toMatch(/(21|22) fixed-order rows/);
    expect(doc).toContain("the twenty-first by migration 161");
  });
});

describe("167 docs/migration-guide.md", () => {
  let guide = "";
  let section = "";
  beforeAll(() => {
    guide = readFileSync(DOC_MIGRATION_GUIDE, "utf8");
    section = sectionOf(guide, "167");
  });

  it("sits after section 166, and the section ends at the next heading (168 follows it)", () => {
    expect(guide.indexOf("\n## 167")).toBeGreaterThan(guide.indexOf("\n## 166"));
    // 168 was appended after it: the section text must stop there, so nothing of 168 is read as 167's
    expect(section).not.toContain("\n## 168");
  });

  it("has Why, What, an md5 table, Order, Verify and Rollback", () => {
    for (const word of ["**Why:**", "**What 167 does**", "| md5(prosrc) | length |", "**Order:**", "**Verify**", "**Rollback:**"]) {
      expect(section, word).toContain(word);
    }
    expect(section).toContain(PROD_MD5_BEFORE);
    expect(section).toContain(String(PROD_LENGTH_BEFORE));
    expect(section).toContain(MD5_AFTER);
    expect(section).toContain(String(LENGTH_AFTER));
  });

  it("states the evidence and the contract", () => {
    for (const word of ["read_ct > 3", "MAX_READS", "4th read", "182446", "haberport", "zehirli (24 sa): 11", "zehirli (24 sa): 0"]) {
      expect(section, word).toContain(word);
    }
  });

  it("says 167 is added to the migration list of the function comment", () => {
    expect(section).toContain("the row-18 comment and the function comment, which also gains 167 in its migration list");
  });

  it("says apply only: no function deploy and no app deploy (the image-consumer change is a comment)", () => {
    expect(section).toContain("APPLY 167");
    expect(section).toContain("no redeploy");
    expect(section).toContain("image-consumer");
  });

  it("verifies the report row, the fingerprint, the privileges and the ledger", () => {
    for (const word of ["queue_lag", "md5(prosrc)", "has_function_privilege", "schema_migrations", "version = '167'"]) {
      expect(section, word).toContain(word);
    }
  });

  it("has a rollback that re-runs only 161's report section and deletes only the 167 ledger row", () => {
    const rb = section.slice(section.indexOf("**Rollback:**"));
    expect(rb).toContain("161_image_coverage_by_source.sql");
    expect(rb).toContain("version = '167'");
    expect(rb).toContain(PROD_MD5_BEFORE);
  });

  it("uses no fenced sql block (tests/guards/docs-sql-snippets.test.ts scans those)", () => {
    expect(section).not.toContain("```");
  });

  it("no other section of the guide says `read_ct >= 3` as a current rule", () => {
    const rest = guide.replace(section, "");
    expect(rest).not.toContain("read_ct >= 3");
  });
});

describe("167 live manifest and dry-run", () => {
  it("builds 167's database with its own dry-run script: one run entry, that script as the only setup file", () => {
    const lines = readFileSync(LIVE_MANIFEST, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("run | 167-ops-queue-poison-contract.test.ts"));
    expect(lines).toHaveLength(1);
    const setup = (lines[0] as string).split("|")[2] as string;
    expect(setup.trim().split(/\s+/)).toEqual(["tests/migrations/sql/167-ops-queue-poison-contract-dryrun.sql"]);
  });

  it("the dry-run builds the chain (150's dry-run, 041, 157, 161), gates on the production fingerprint, applies 167 twice, and ends with its OK line", () => {
    const sql = readFileSync(DRYRUN, "utf8");
    const ir = sql
      .split("\n")
      .filter((l) => l.startsWith("\\ir "))
      .map((l) => l.slice(4).trim());
    expect(ir).toEqual([
      "150-ops-queue-cron-liveness-dryrun.sql",
      "../../../supabase/migrations/041_source_fetch_state.sql",
      "../../../supabase/migrations/157_ingest_poll_stale.sql",
      "../../../supabase/migrations/161_image_coverage_by_source.sql",
      "../../../supabase/migrations/167_ops_queue_poison_contract.sql",
      "../../../supabase/migrations/167_ops_queue_poison_contract.sql",
    ]);
    expect(sql).toContain(PROD_MD5_BEFORE);
    expect(sql).toContain(MD5_AFTER);
    expect(sql.trimEnd().endsWith("select 'DRYRUN 167 OK';")).toBe(true);
    expect(sql).toContain("-f tests/migrations/sql/stub.sql");
    expect(sql).toContain("D=$(mktemp -d)");
    expect(sql).toContain("-- or: bash tests/migrations/sql/run-live.sh");
  });
});

// ---------------------------------------------------------------------------
// Live behaviour (opt-in): row 18 against archive fixtures, on a throwaway Postgres with 145, 150, 157, 161 and 167
// applied (tests/migrations/sql/live-manifest.txt). TAYF_PSQL is the psql binary and
// PGHOST/PGPORT/PGUSER/PGDATABASE select the server. Every case ends in a rollback.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))("167 row 18 against archive fixtures (live Postgres, every case rolled back)", () => {
  assertLiveReady("167", { ledger: ["145", "150", "157", "161", "167"], functions: ["public.ops_health_report()"] });

  function runPsql(input: string): string {
    return execFileSync(process.env.TAYF_PSQL as string, ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      input,
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8", PGOPTIONS: "-c client_min_messages=warning" },
      maxBuffer: 8 * 1024 * 1024,
    });
  }

  type Row = { status: string; observed: string; detail: string };

  /** Runs the fixture in begin..rollback on emptied queues and returns row 18 (the report itself must not raise). */
  function queueRowOf(fixture: string): Row {
    const out = runPsql(
      `begin;\ndelete from pgmq.q_cluster_work;\ndelete from pgmq.q_image_backfill;\ndelete from pgmq.a_cluster_work;\ndelete from pgmq.a_image_backfill;\n${fixture}\nselect status, observed, detail from public.ops_health_report() where check_name = 'queue_lag';\nrollback;\n`,
    );
    const lines = out.split("\n").filter((l) => l.trim() !== "");
    expect(lines, out).toHaveLength(1);
    const [status, observed, ...rest] = (lines[0] as string).split("|");
    return { status: status as string, observed: observed as string, detail: rest.join("|") };
  }

  /** `n` archived messages of a queue with the given read_ct, archived `ago` ago. */
  const archived = (queue: "cluster_work" | "image_backfill", readCt: number, n = 1, ago = "1 hour") =>
    `insert into pgmq.a_${queue} (msg_id, read_ct, archived_at) select 1000 * ${readCt} + g, ${readCt}, now() - interval '${ago}' from generate_series(1, ${n}) g;\n`;
  /** A visible message of a queue enqueued `age` ago. */
  const waiting = (queue: "cluster_work" | "image_backfill", age: string) =>
    `insert into pgmq.q_${queue} (enqueued_at, vt) values (now() - interval '${age}', now() - interval '1 second');\n`;

  const EMPTY_DETAIL = "cluster_work: 0 mesaj, en eski 0 sn · image_backfill: 0 mesaj, en eski 0 sn · zehirli (24 sa): 0";

  beforeAll(() => {
    expect(runPsql(`select count(*) from public.ops_health_report();`).trim()).toBe("21");
  });

  it("returns 21 rows in 161's order: queue_lag stays row 18, image_coverage row 21", () => {
    const out = runPsql("select check_name from public.ops_health_report();").split("\n").filter(Boolean);
    expect(out).toHaveLength(21);
    expect(out[17]).toBe("queue_lag");
    expect(out[18]).toBe("cron_jobs_stalled");
    expect(out[19]).toBe("feed_poll_stale");
    expect(out[20]).toBe("image_coverage");
  });

  it("empty queues: pass, observed 0, the detail format of 150 unchanged", () => {
    const r = queueRowOf("");
    expect(r.status).toBe("pass");
    expect(r.observed).toBe("0");
    expect(r.detail).toBe(EMPTY_DETAIL);
  });

  it("messages archived on their 3rd read (processed, not poison) pass: 11 image_backfill rows read 'zehirli (24 sa): 0'", () => {
    const r = queueRowOf(archived("image_backfill", 3, 11));
    expect(r.status).toBe("pass");
    expect(r.detail.endsWith("zehirli (24 sa): 0")).toBe(true);
  });

  it("a 3rd-read archive in cluster_work passes too", () => {
    const r = queueRowOf(archived("cluster_work", 3, 2));
    expect(r.status).toBe("pass");
    expect(r.detail.endsWith("zehirli (24 sa): 0")).toBe(true);
  });

  it("a message archived on its 4th read (read_ct 4, the consumers' poison) warns, in either queue", () => {
    const image = queueRowOf(archived("image_backfill", 4));
    expect(image.status).toBe("warn");
    expect(image.detail.endsWith("zehirli (24 sa): 1")).toBe(true);
    const cluster = queueRowOf(archived("cluster_work", 4));
    expect(cluster.status).toBe("warn");
    expect(cluster.detail.endsWith("zehirli (24 sa): 1")).toBe(true);
  });

  it("the count sums both archives and counts only read_ct > 3: 11 at read_ct 3 plus 2 at 4 plus 1 at 5 is 3", () => {
    const r = queueRowOf(archived("image_backfill", 3, 11) + archived("image_backfill", 4, 2) + archived("cluster_work", 5, 1));
    expect(r.status).toBe("warn");
    expect(r.detail.endsWith("zehirli (24 sa): 3")).toBe(true);
  });

  it("read_ct 2 never counts; the 24 hour window is kept: a read_ct 4 archive 25 hours old passes, 23 hours old warns", () => {
    expect(queueRowOf(archived("image_backfill", 2, 5)).status).toBe("pass");
    expect(queueRowOf(archived("image_backfill", 4, 1, "25 hours")).status).toBe("pass");
    expect(queueRowOf(archived("image_backfill", 4, 1, "23 hours")).status).toBe("warn");
  });

  it("the other limits are unchanged: an old cluster_work message fails, a 31 minute old image_backfill message warns", () => {
    const fail = queueRowOf(waiting("cluster_work", "20 minutes"));
    expect(fail.status).toBe("fail");
    expect(fail.observed).toBe("1200");
    expect(queueRowOf(waiting("image_backfill", "31 minutes")).status).toBe("warn");
    expect(queueRowOf(waiting("image_backfill", "10 minutes") + waiting("cluster_work", "1 minute")).status).toBe("pass");
  });

  it("the function that runs is the file's: md5 and length of prosrc equal the text between the $fn$ markers, and it is security definer with an empty search_path", () => {
    const out = runPsql(
      `select md5(prosrc) || '|' || length(prosrc) || '|' || prosecdef || '|' || coalesce(proconfig::text, '') from pg_proc where oid = 'public.ops_health_report()'::regprocedure;`,
    ).trim();
    // proconfig prints as {"search_path=\"\""}: the one setting, an empty search_path
    expect(out).toBe(`${createHash("md5").update(body167).digest("hex")}|${body167.length}|true|{"search_path=\\"\\""}`);
  });

  it("the stored comment says read_ct > 3 and no longer read_ct >= 3", () => {
    const out = runPsql(`select obj_description('public.ops_health_report()'::regprocedure, 'pg_proc');`);
    expect(out).toContain("read_ct > 3, poison (the consumers archive on the 4th read");
    expect(out).not.toContain("read_ct >= 3");
  });

  it("is idempotent: the ledger holds one 167 row and the function stayed service_role only", () => {
    const out = runPsql(
      `select (select count(*) from supabase_migrations.schema_migrations where version = '167') || '|' || has_function_privilege('anon', 'public.ops_health_report()', 'execute') || '|' || has_function_privilege('authenticated', 'public.ops_health_report()', 'execute') || '|' || has_function_privilege('service_role', 'public.ops_health_report()', 'execute');`,
    ).trim();
    expect(out).toBe("1|false|false|true");
  });
});
