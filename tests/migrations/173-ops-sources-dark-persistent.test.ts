import { describe, it, expect, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 173 ("ops-sources-dark-persistent"), h64-backendops-1.
//
// ops_health_report() row 13 (sources_newly_dark) names a source that had at least 50 articles in the 14 days before
// the last 24 hours and none in those 24 hours: a source that stays dark rolls out of the 14 day window and the row
// forgets it after 14 days; row 8 (dead_feeds) is a count (pass at 25 of 96, warn only above 38). On 2026-11-08 five
// high-volume outlets of the muhalefet / bagimsiz zones (halk-tv, gazete-pencere, benguturk, arti-gercek, medya-gazete)
// had been dark for 14 to 24 days and no row named any of them. 173 appends row 22, sources_dark_persistent: an active
// outlet or wire source outside public.ops_dark_source_baseline whose newest article is over 72 hours old and that has
// at least 300 articles published in the 60 days up to that newest article (a window anchored at the newest article, not
// at the clock, so it does not roll off while the source stays dark). It stays on while the source is dark.
//
// This file pins: 167's body is the one on production (md5 and length), 173's body is 167's rows 1-21 byte for byte
// plus row 22 appended LAST, the new fingerprint, row 22's predicates and Turkish detail, the function comment (167's
// with exactly two edits), revoke/grant, the ledger pattern, the docs, the live manifest and the dry-run. The live block
// at the end runs the report against source and article fixtures through psql when TAYF_PSQL is set.
//
// SQL is scanned by character, never with a nested-quantifier regex (CodeQL).
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const MIGRATION_173 = resolve(MIGRATIONS_DIR, "173_ops_sources_dark_persistent.sql");
const MIGRATION_167 = resolve(MIGRATIONS_DIR, "167_ops_queue_poison_contract.sql");
const DOC_OPS_HEARTBEAT = resolve(ROOT, "docs", "ops-heartbeat.md");
const LIVE_MANIFEST = resolve(__dirname, "sql", "live-manifest.txt");
const DRYRUN = resolve(__dirname, "sql", "173-ops-sources-dark-persistent-dryrun.sql");

const CREATE_LINE = "create or replace function public.ops_health_report()";
/** What follows the last row's `return next;`. */
const FN_END = "\n\n  return;\nend\n$fn$;";
const CHECK = "sources_dark_persistent";
const ROW22_MARKER = "\n\n  -- 22. sources_dark_persistent (migration 173, h64-backendops-1).";

/** Production, read-only, 2026-11-08 04:20 UTC: md5(prosrc) and length of ops_health_report() before 173 (migration 167's text). */
const PROD_MD5_BEFORE = "5a9f9e384da09a19df1cd73a3f8ba4a5";
const PROD_LENGTH_BEFORE = 47439;
/** The text between the dollar-quote markers of 173. */
const MD5_AFTER = "55fa63d2f5d876feed93eb9f7b263b27";
const LENGTH_AFTER = 52432;

/** The migration list of the function comment and the row count, before and after. */
const OLD_FN_MIGRATIONS = "159, 161, 167): 21 fixed rows";
const NEW_FN_MIGRATIONS = "159, 161, 167, 173): 22 fixed rows";
/** What closes the image_coverage description in the function comment, before and after (row 22's description is inserted). */
const OLD_FN_TAIL = "14 day percentage only, worst first). status is one of";
const ROW22_COMMENT =
  " sources_dark_persistent (an active outlet or wire source of public.sources outside public.ops_dark_source_baseline whose newest" +
  " article, published_at <= now, is missing or older than 72 hours and that has at least 300 articles published in the 60 days up to" +
  " that newest article, counted for those candidates only; sources_newly_dark (row 13) stops naming a source after 14 days of silence and" +
  " dead_feeds only counts, so this row stays on while the source stays dark and clears when it delivers again, is added to the" +
  " baseline or is set inactive; observed is the number of such sources, threshold 1; warn only, never fails; unknown if the read" +
  " fails; the detail lists slug, the article count of that window, the reason label of row 13 and the date of the last article," +
  " largest first, and nothing else)";
const NEW_FN_TAIL = `14 day percentage only, worst first),${ROW22_COMMENT}. status is one of`;

const REVOKE_STMT = "revoke all on function public.ops_health_report() from public, anon, authenticated";
const GRANT_STMT = "grant execute on function public.ops_health_report() to service_role";
const LEDGER_STMT =
  "insert into supabase_migrations.schema_migrations (version, name) values ('173', '173_ops_sources_dark_persistent') on conflict do nothing";
const LOCK_STMT = "set local lock_timeout = '5s'";

const DETAIL_PREFIX = "72 saattir haber gelmeyen, önceki 60 günde en az 300 haberi olan ve listede olmayan kaynaklar: ";
const DETAIL_PASS = "kalıcı susan kaynak yok";

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

/** The whole `comment on function ...;` section of a migration (from the last occurrence to the end). */
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

/** One check of a body: from its `check_name :=` to the first `return next;` after it. */
function rowOf(body: string, name: string): string {
  const at = body.indexOf(`check_name := '${name}'`);
  expect(at, `${name} row`).toBeGreaterThanOrEqual(0);
  return body.slice(at, body.indexOf("return next;", at) + "return next;".length);
}

let raw = "";
let code = "";
let statements: string[] = [];
let raw167 = "";
let fn173 = "";
let fn167 = "";
let body173 = "";
let body167 = "";
let rows1to21 = "";
let row22 = "";

beforeAll(() => {
  raw = readFileSync(MIGRATION_173, "utf8");
  code = stripComments(raw);
  statements = splitStatements(code);
  raw167 = readFileSync(MIGRATION_167, "utf8");
  // the last occurrence: a header may quote the create line in a comment
  const from173 = raw.lastIndexOf(CREATE_LINE);
  fn173 = raw.slice(from173, raw.indexOf(FN_END, from173) + FN_END.length);
  const from167 = raw167.lastIndexOf(CREATE_LINE);
  fn167 = raw167.slice(from167, raw167.indexOf(FN_END, from167) + FN_END.length);
  body173 = prosrcOf(raw);
  body167 = prosrcOf(raw167);
  rows1to21 = fn167.slice(0, fn167.length - FN_END.length);
  row22 = rowOf(body173, CHECK);
});

describe("173 helpers (the scans are not vacuous)", () => {
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

  it("blankStrings empties literals, wordsOf lists whole words, literalNames reads the check names, rowOf cuts one row", () => {
    expect(blankStrings("a 'it''s' b")).toBe("a '' b");
    expect(wordsOf("select x.slug, 'y'")).toEqual(["select", "x", "slug", "y"]);
    expect(literalNames("check_name := 'a_b'; x; check_name := 'c';")).toEqual(["a_b", "c"]);
    expect(rowOf("check_name := 'a'; x; return next; check_name := 'b'; y; return next;", "b")).toBe("check_name := 'b'; y; return next;");
    expect(countOf("a.b.c", ".")).toBe(2);
  });
});

describe("173 ledger and structure", () => {
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
    // and the function statement itself (the whole body, 167's rows included) writes nothing
    const body = wordsOf(blankStrings(stripComments(body173)));
    for (const w of ["insert", "update", "delete", "truncate", "drop", "alter", "create"]) {
      expect(body, w).not.toContain(w);
    }
  });

  it("does not notify pgrst: no table, column or RPC shape changes", () => {
    expect(wordsOf(blankStrings(code))).not.toContain("notify");
  });

  it("keeps the revoke and the grant exactly as 167 issues them (service_role only)", () => {
    const stmts167 = splitStatements(stripComments(raw167)).map(collapse);
    const stmts173 = statements.map(collapse);
    expect(stmts167).toContain(REVOKE_STMT);
    expect(stmts167).toContain(GRANT_STMT);
    expect(stmts173.filter((s) => s.startsWith("revoke "))).toEqual([REVOKE_STMT]);
    expect(stmts173.filter((s) => s.startsWith("grant "))).toEqual([GRANT_STMT]);
    expect(stmts173.indexOf(REVOKE_STMT)).toBe(stmts173.indexOf(GRANT_STMT) - 1);
    expect(wordsOf(blankStrings(code))).not.toContain("default");
  });

  it("keeps the signature, language, volatility, security definer and the empty search_path of 167", () => {
    const head = (fn: string) => fn.slice(0, fn.indexOf("as $fn$"));
    expect(head(fn173)).toBe(head(fn167));
    const h = collapse(head(fn173));
    expect(h).toContain("returns table (check_name text, status text, observed numeric, threshold numeric, detail text)");
    expect(h).toContain("language plpgsql volatile security definer set search_path = ''");
  });
});

describe("173 header documents the change", () => {
  let header = "";
  beforeAll(() => {
    header = raw.slice(0, raw.indexOf("\nbegin;"));
  });

  it("names the finding, the evidence and the sections", () => {
    expect(header).toMatch(/^-- 173_ops_sources_dark_persistent\.sql/);
    for (const word of [
      "h64-backendops-1",
      "sources_dark_persistent",
      "sources_newly_dark",
      "dead_feeds",
      "halk-tv",
      "gazete-pencere",
      "benguturk",
      "arti-gercek",
      "medya-gazete",
      "9768",
      "7752",
      "6725",
      "4485",
      "2369",
      "ops_dark_source_baseline",
      "WHY",
      "WHAT CHANGES",
    ]) {
      expect(header, word).toContain(word);
    }
  });

  it("records the production fingerprint it copies, the fingerprint it produces, the read-only replay and the dry run", () => {
    expect(header).toContain("STEP 0");
    expect(header).toContain(PROD_MD5_BEFORE);
    expect(header).toContain(String(PROD_LENGTH_BEFORE));
    expect(header).toContain(MD5_AFTER);
    expect(header).toContain(String(LENGTH_AFTER));
    expect(header).toContain("REPLAY");
    expect(header).toContain("DRY RUN");
    expect(header).toContain("DRYRUN 173 OK");
  });

  it("states the deploy order (apply only) and the founder steps that stay outside the migration", () => {
    expect(header).toContain("DEPLOY: APPLY 173 ONLY");
    expect(header).toContain("FOUNDER STEPS");
    for (const word of ["SOURCE_HEADERS", "supabase/functions/_shared/rss/fetcher.ts", "blocked-403", "h33-ops-2", "residential"]) {
      expect(header, word).toContain(word);
    }
  });

  it("has a verify section and a rollback that restores 167's function and drops nothing", () => {
    expect(header).toContain("VERIFY (read-only");
    expect(header).toContain("sources_dark_persistent");
    const rb = header.slice(header.indexOf("ROLLBACK"));
    expect(rb).toContain("ONLY 167's ops_health_report() section");
    expect(rb).toContain("delete from supabase_migrations.schema_migrations where version = '173'");
    expect(rb).toContain(PROD_MD5_BEFORE);
  });

  it("describes the window as the 60 days up to the newest article (anchored), with no stale 63 day created_at text and no 'deviation' paragraph", () => {
    // the header wraps its comment lines: read it as running text
    const flat = collapse(header.split("\n--").join(" "));
    expect(flat).toContain("at least 300 articles published in the 60 days up to its newest article");
    expect(header).toContain("idx_articles_source_published_inc_id");
    expect(header).toContain("anchored");
    expect(header).not.toContain("63 day");
    expect(header).not.toContain("Deviation from the finding");
    expect(header).not.toContain("one pass over");
    expect(header).not.toContain("idx_articles_created_source");
    // the old, clock-bound counts (7039 ... 1873) are gone from the replay
    for (const stale of ["7039", "6047", "4641", "4222", "(1873)"]) expect(header, stale).not.toContain(stale);
  });

  it("names the callers that really run the row (the pg_cron snapshot and the heartbeat script), not /api/health, and quotes the dry-run fixture's volume", () => {
    expect(header).toContain("ops_health_snapshot(), migration 131");
    expect(header).toContain("scripts/ops-heartbeat.mjs");
    // /api/health never calls ops_health_report(): it is not a caller of the row (the rollback sentence "do not depend on row 22" stays)
    const flatHeader = collapse(header.split("\n--").join(" "));
    expect(flatHeader).not.toContain("the 30 minute heartbeat and /api/health");
    expect(flatHeader).not.toContain("snapshot (every 10 minutes), the 30 minute heartbeat");
    expect(readFileSync(resolve(ROOT, "src", "app", "api", "health", "route.ts"), "utf8")).not.toMatch(/\.rpc\(\s*["']ops_health_report["']/);
    // the dry-run fixture of a source dark for 20 days holds 350 articles, not 401
    expect(collapse(header.split("\n--").join(" "))).toContain("a source dark for 20 days with 350 articles");
    expect(header).not.toContain("with 401 articles");
    expect(readFileSync(DRYRUN, "utf8")).toContain("select pg_temp.mk_articles('a', interval '20 days', 350);");
  });

  it("changes no data: it touches no source, no article and no baseline row", () => {
    const outside = wordsOf(blankStrings(code));
    expect(outside).not.toContain("delete");
    expect(outside).not.toContain("update");
    expect(outside.filter((w) => w === "insert")).toHaveLength(1);
  });
});

describe("173 is 167's function with row 22 appended", () => {
  it("167's function body is the one running on production (md5 and length from the read-only fingerprint)", () => {
    expect(createHash("md5").update(body167).digest("hex")).toBe(PROD_MD5_BEFORE);
    expect(body167.length).toBe(PROD_LENGTH_BEFORE);
  });

  it("173's function body has the pinned new fingerprint", () => {
    expect(createHash("md5").update(body173).digest("hex")).toBe(MD5_AFTER);
    expect(body173.length).toBe(LENGTH_AFTER);
  });

  it("rows 1-21 are 167's text byte for byte (comments included): the function up to the last `return next;` is a prefix of 173's", () => {
    expect(rows1to21.endsWith("  return next;")).toBe(true);
    expect(rows1to21.length).toBeGreaterThan(47000);
    expect(fn173.startsWith(rows1to21)).toBe(true);
    // and nothing of 167's declare block, rows or comments moved: the body prefix is 167's body minus its closing lines
    const bodyPrefix = body167.slice(0, body167.length - "\n\n  return;\nend\n".length);
    expect(body173.startsWith(bodyPrefix)).toBe(true);
  });

  it("row 22 is appended right after row 21, after one blank line, and the function then ends as 167's does", () => {
    expect(fn173.slice(rows1to21.length).startsWith(ROW22_MARKER)).toBe(true);
    expect(fn173.endsWith(FN_END)).toBe(true);
    expect(countOf(fn173, ROW22_MARKER)).toBe(1);
    // nothing but row 22 sits between row 21's `return next;` and the closing lines
    const tail = fn173.slice(rows1to21.length, fn173.length - FN_END.length);
    expect(tail.startsWith(ROW22_MARKER)).toBe(true);
    expect(countOf(tail, "return next;")).toBe(1);
    expect(tail.indexOf(`check_name := '${CHECK}'`)).toBeGreaterThan(ROW22_MARKER.length);
    expect(tail.endsWith("  return next;")).toBe(true);
  });

  it("the literal check names are 167's, in the same order, plus sources_dark_persistent LAST (22 rows: the three zone rows share one literal built in a loop)", () => {
    const names167 = literalNames(body167);
    const names173 = literalNames(body173);
    expect(names167).toHaveLength(19);
    expect(names173).toEqual([...names167, CHECK]);
    expect(names167[names167.length - 1]).toBe("image_coverage");
    expect(names173[names173.length - 1]).toBe(CHECK);
    expect(names173).toHaveLength(20);
    expect(new Set(names173).size).toBe(names173.length);
  });

  it("row 22's `return next;` is the last one in the body (nothing returns after it)", () => {
    const at = body173.indexOf(`check_name := '${CHECK}'`);
    const last = body173.lastIndexOf("return next;");
    expect(last).toBeGreaterThan(at);
    expect(countOf(body173.slice(at), "return next;")).toBe(1);
    expect(body173.endsWith("  return next;\n\n  return;\nend\n")).toBe(true);
  });

  it("rows 8 and 13 are untouched (the same text as 167's)", () => {
    expect(rowOf(body173, "dead_feeds")).toBe(rowOf(body167, "dead_feeds"));
    expect(rowOf(body173, "sources_newly_dark")).toBe(rowOf(body167, "sources_newly_dark"));
  });
});

describe("173 row 22 (sources_dark_persistent)", () => {
  let seg = "";
  let exec = "";
  beforeAll(() => {
    seg = collapse(row22);
    exec = collapse(stripComments(row22));
  });

  it("threshold 1, observed is the flagged count, warn at one, pass otherwise, never fail", () => {
    expect(seg).toContain("threshold := 1");
    expect(seg).toContain("observed := d_hit;");
    expect(seg).toContain("status := case when d_hit >= 1 then 'warn' else 'pass' end;");
    expect(exec).not.toContain("'fail'");
    expect(wordsOf(blankStrings(stripComments(row22)))).not.toContain("fail");
  });

  it("answers unknown with the first 200 characters of the error", () => {
    expect(seg).toContain("exception when others then status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);");
  });

  it("the candidates are active outlet/wire sources outside the baseline, by the newest article with published_at <= now (row 8's lookup) older than 72 hours or missing", () => {
    expect(exec).toContain("from public.sources s where s.active and s.kind in ('outlet', 'wire')");
    expect(exec).toContain("not exists (select 1 from public.ops_dark_source_baseline b where b.slug = s.slug)");
    expect(exec).toContain(
      "(select a.published_at from public.articles a where a.source_id = s.id and a.published_at <= v_now order by a.published_at desc limit 1) as last_at",
    );
    expect(exec).toContain("where v.last_at is null or v.last_at < v_now - interval '72 hours'");
  });

  it("prior_n counts the candidate's articles published in the 60 days up to its newest article (anchored, so it never rolls off while the source stays dark), as one scalar subquery per candidate, and a candidate is flagged at 300 or more", () => {
    expect(exec).toContain(
      "(select pg_catalog.count(*) from public.articles a where a.source_id = v.id and a.published_at > coalesce(v.last_at, v_now) - interval '60 days' and a.published_at <= coalesce(v.last_at, 'infinity'::timestamptz)) as prior_n",
    );
    expect(exec).toContain("filter (where v.prior_n >= 300)");
    expect(countOf(exec, "prior_n >= 300")).toBe(2);
    // not tied to the clock: no moving 63 day created_at range, no range scan with an id array, no separate count CTE
    expect(exec).not.toContain("interval '63 days'");
    expect(exec).not.toContain("created_at");
    expect(exec).not.toContain("any (array(");
    expect(exec).not.toContain("join c ");
    expect(exec).not.toContain("group by");
    expect(countOf(exec, "interval '60 days'")).toBe(1);
    // the newest-article lookup runs once per source (vs is materialized), the count once per candidate (cand is materialized)
    expect(exec).toContain("with vs as materialized (");
    expect(exec).toContain("cand as materialized (");
    // only the two reads of public.articles exist: the newest-article lookup and the window count
    expect(countOf(exec, "from public.articles a")).toBe(2);
  });

  it("reuses row 13's three-label reason CASE (erişim yok, akış donmuş, sessiz) read from sources.fetch_*", () => {
    const row13 = collapse(rowOf(body167, "sources_newly_dark"));
    const from = row13.indexOf("case when (s.fetch_quarantined_until is not null");
    const to = row13.indexOf("else 'sessiz' end as reason") + "else 'sessiz' end as reason".length;
    expect(from).toBeGreaterThan(0);
    const caseText = row13.slice(from, to);
    expect(caseText).toContain("'erişim yok'");
    expect(caseText).toContain("'akış donmuş'");
    expect(exec).toContain(caseText);
  });

  it("the Turkish detail: the warn sentence, the per-source format (slug (n) · reason · son haber DD.MM, Istanbul time), the order, the 500 cut and the pass text", () => {
    expect(exec).toContain(`substr('${DETAIL_PREFIX}' || d_list, 1, 500)`);
    expect(exec).toContain(`else '${DETAIL_PASS}' end`);
    expect(exec).toContain("v.slug || ' (' || v.prior_n::text || ') · ' || v.reason || ' · son haber ' || coalesce(pg_catalog.to_char(v.last_at at time zone 'Europe/Istanbul', 'DD.MM'), 'yok')");
    expect(exec).toContain("order by v.prior_n desc, v.slug");
    expect(exec).toContain("filter (where v.prior_n >= 300)");
  });

  it("only reads, and the detail can carry no url, title or feed address (the heartbeat log is public)", () => {
    const outside = wordsOf(blankStrings(stripComments(row22)));
    for (const w of ["insert", "update", "delete", "truncate", "drop", "alter", "create", "perform", "execute"]) {
      expect(outside, w).not.toContain(w);
    }
    for (const w of ["url", "rss_url", "title", "summary", "description", "content", "content_hash", "fetch_etag"]) {
      expect(outside, w).not.toContain(w);
    }
    expect(outside).toContain("slug");
    expect(outside).toContain("ops_dark_source_baseline");
  });

  it("qualifies its functions (search_path is empty): the aggregates and to_char carry pg_catalog", () => {
    const outside = blankStrings(stripComments(row22));
    expect(countOf(outside, "pg_catalog.count(")).toBeGreaterThanOrEqual(2);
    expect(countOf(outside, "pg_catalog.string_agg(")).toBe(1);
    expect(countOf(outside, "pg_catalog.to_char(")).toBe(1);
    expect(outside).not.toMatch(/(^|[^._a-z])(count|string_agg|to_char)\(/);
  });

  it("its comment names the finding, the two rows it complements and the three limits", () => {
    const comment = body173.slice(body173.indexOf(ROW22_MARKER), body173.indexOf(`check_name := '${CHECK}'`));
    for (const word of ["h64-backendops-1", "sources_newly_dark", "dead_feeds", "14 days", "72 hours", "60 days", "300", "ops_dark_source_baseline", "idx_articles_source_published_inc_id"]) {
      expect(comment, word).toContain(word);
    }
    // the clock-bound window and its one-pass range scan are gone from the comment
    for (const stale of ["63 days", "one pass", "idx_articles_created_source", "same shape as row 21"]) {
      expect(comment, stale).not.toContain(stale);
    }
  });
});

describe("173 function comment", () => {
  it("is 167's comment with the migration list and row count moved and row 22 described after image_coverage, nothing else", () => {
    const c167 = commentText(commentSection(raw167));
    const c173 = commentText(commentSection(raw));
    expect(countOf(c167, OLD_FN_MIGRATIONS)).toBe(1);
    expect(countOf(c167, OLD_FN_TAIL)).toBe(1);
    expect(countOf(c173, NEW_FN_MIGRATIONS)).toBe(1);
    expect(countOf(c173, NEW_FN_TAIL)).toBe(1);
    expect(c173).toBe(c167.replace(OLD_FN_MIGRATIONS, NEW_FN_MIGRATIONS).replace(OLD_FN_TAIL, NEW_FN_TAIL));
  });

  it("lists 22 fixed rows, service_role only, never reads a secret-bearing pg_cron field, and points at docs/ops-heartbeat.md", () => {
    const c = commentText(commentSection(raw));
    expect(c).toContain("22 fixed rows, in this order --");
    expect(c).not.toContain("21 fixed rows");
    expect(c).toContain("service_role only");
    expect(c).toContain("never reads any potentially secret-bearing pg_cron job field");
    expect(c).toContain("docs/ops-heartbeat.md");
  });

  it("describes row 22's window as the 60 days up to the newest article, not 63 days from the clock", () => {
    const c = commentText(commentSection(raw));
    expect(c).toContain("at least 300 articles published in the 60 days up to that newest article");
    expect(c).not.toContain("63 days");
  });
});

describe("173 docs/ops-heartbeat.md", () => {
  let doc = "";
  beforeAll(() => {
    doc = readFileSync(DOC_OPS_HEARTBEAT, "utf8");
  });

  it("counts 22 rows everywhere it counts rows, and credits row 22 to migration 173", () => {
    expect(doc).toContain("22 fixed-order rows");
    expect(doc).toContain("the twenty-first by migration 161 and the twenty-second by migration 173");
    expect(doc).toContain("on top of the 22:");
    expect(doc).toContain("exactly\n22 rows.");
    expect(doc).not.toContain("21 fixed-order rows");
    expect(doc).not.toContain("on top of the 21:");
    expect(doc.split("\n")[0]).toContain("173");
  });

  it("row 22 is the last table row, after row 21, and states the candidates, the window, the threshold, the status and the evidence", () => {
    const at = doc.indexOf("| 22 | `sources_dark_persistent`");
    expect(at).toBeGreaterThan(doc.indexOf("| 21 | `image_coverage`"));
    const row = doc.slice(at, doc.indexOf("\n", at));
    for (const word of [
      "ops_dark_source_baseline",
      "72 hours",
      "60 days",
      "300",
      "published_at",
      "`outlet`",
      "`wire`",
      "never fails",
      "warn ≥ 1",
      "threshold 1",
      "sources_newly_dark",
      "dead_feeds",
      "14 days",
      "kalıcı susan kaynak yok",
      "72 saattir haber gelmeyen",
      "erişim yok",
      "akış donmuş",
      "sessiz",
      "halk-tv",
      "gazete-pencere",
      "benguturk",
      "arti-gercek",
      "medya-gazete",
      "9768",
      "idx_articles_source_published_inc_id",
      "migration 173",
      "h64-backendops-1",
    ]) {
      expect(row, word).toContain(word);
    }
    // the window is anchored at the newest article: no clock-bound 63 day count, no one-pass range scan
    for (const stale of ["63 days", "idx_articles_created_source", "one pass", "7039", "6047", "4641", "4222"]) expect(row, stale).not.toContain(stale);
    expect(row).toContain("up to their newest article");
    // it is the last row of the table: the next line is not another `| NN |` row
    const next = doc.slice(doc.indexOf("\n", at) + 1).split("\n")[0] as string;
    expect(next.startsWith("| 23 |")).toBe(false);
  });

  it("says when the row clears and what the operator does about a source it names (baseline, inactive, repoint)", () => {
    const at = doc.indexOf("| 22 | `sources_dark_persistent`");
    const row = doc.slice(at, doc.indexOf("\n", at));
    for (const word of ["clears", "ops_dark_source_baseline", "inactive", "SOURCE_HEADERS", "blocked-403"]) {
      expect(row, word).toContain(word);
    }
  });
});

describe("173 live manifest and dry-run", () => {
  it("builds 173's database with its own dry-run script: one run entry, that script as the only setup file", () => {
    const lines = readFileSync(LIVE_MANIFEST, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("run | 173-ops-sources-dark-persistent.test.ts"));
    expect(lines).toHaveLength(1);
    const setup = (lines[0] as string).split("|")[2] as string;
    expect(setup.trim().split(/\s+/)).toEqual(["tests/migrations/sql/173-ops-sources-dark-persistent-dryrun.sql"]);
  });

  it("the dry-run builds the chain (150's dry-run, 041, 157, 161, 167), gates on the production fingerprint, applies 173 twice, and ends with its OK line", () => {
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
      "../../../supabase/migrations/173_ops_sources_dark_persistent.sql",
      "../../../supabase/migrations/173_ops_sources_dark_persistent.sql",
    ]);
    expect(sql).toContain(PROD_MD5_BEFORE);
    expect(sql).toContain(MD5_AFTER);
    expect(sql.trimEnd().endsWith("select 'DRYRUN 173 OK';")).toBe(true);
    expect(sql).toContain("-f tests/migrations/sql/stub.sql");
    expect(sql).toContain("D=$(mktemp -d)");
    expect(sql).toContain("-- or: bash tests/migrations/sql/run-live.sh");
  });
});

// ---------------------------------------------------------------------------
// Live behaviour (opt-in): the report against source and article fixtures, on a throwaway Postgres with 145, 150, 157,
// 161, 167 and 173 applied (tests/migrations/sql/live-manifest.txt). TAYF_PSQL is the psql binary and
// PGHOST/PGPORT/PGUSER/PGDATABASE select the server. Every case ends in a rollback.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))("173 row 22 against source and article fixtures (live Postgres, every case rolled back)", () => {
  assertLiveReady("173", { ledger: ["145", "150", "157", "161", "167", "173"], functions: ["public.ops_health_report()"] });

  function runPsql(input: string): string {
    return execFileSync(process.env.TAYF_PSQL as string, ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      input,
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8", PGOPTIONS: "-c client_min_messages=warning" },
      maxBuffer: 8 * 1024 * 1024,
    });
  }

  type Row = { status: string; observed: string; threshold: string; detail: string };

  /**
   * Runs the fixture in begin..rollback (on emptied sources, articles and baseline) and returns rows 13 and 22 of the report
   * (the report itself must not raise).
   */
  function rowsOf(fixture: string): { dark: Row; persistent: Row } {
    const out = runPsql(
      `begin;\ndelete from public.articles;\ndelete from public.sources;\ndelete from public.ops_dark_source_baseline;\n${fixture}\n` +
        `select check_name, status, observed, threshold, detail from public.ops_health_report() where check_name in ('sources_newly_dark', '${CHECK}') order by check_name desc;\nrollback;\n`,
    );
    const lines = out.split("\n").filter((l) => l.trim() !== "");
    expect(lines, out).toHaveLength(2);
    const parse = (line: string): Row => {
      const [, status, observed, threshold, ...rest] = line.split("|");
      return { status: status as string, observed: observed as string, threshold: threshold as string, detail: rest.join("|") };
    };
    // order by check_name desc: sources_newly_dark, then sources_dark_persistent
    return { dark: parse(lines[0] as string), persistent: parse(lines[1] as string) };
  }
  const rowOfFixture = (fixture: string): Row => rowsOf(fixture).persistent;

  let seq = 0;
  /** A source: kind, active flag and an optional extra `set` clause on its fetch state. */
  const source = (slug: string, opts: { kind?: string; active?: boolean; fetch?: string } = {}) =>
    `insert into public.sources (slug, name, active, kind) values ('${slug}', '${slug}', ${opts.active ?? true}, '${opts.kind ?? "outlet"}');\n` +
    (opts.fetch ? `update public.sources set ${opts.fetch} where slug = '${slug}';\n` : "");
  /**
   * `n` articles of the source created `createdAgo` ago (spread over a few seconds), published `publishedAgo` ago (default
   * the same). Distinct urls and content hashes.
   */
  function articles(slug: string, createdAgo: string, n: number, publishedAgo = createdAgo): string {
    seq += 1;
    const tag = `${slug}-${seq}`;
    return (
      `insert into public.articles (source_id, title, url, content_hash, published_at, created_at)\n` +
      `select s.id, 't ' || g, 'https://example.test/${tag}/' || g, 'h-${tag}-' || g, now() - interval '${publishedAgo}', ` +
      `now() - interval '${createdAgo}' - (g || ' seconds')::interval\n` +
      `from public.sources s, generate_series(1, ${n}) g where s.slug = '${slug}';\n`
    );
  }
  /** `dd.mm` of `now() - interval` in Istanbul time, as the report prints the date of the last article. */
  const istanbulDate = (ago: string): string =>
    runPsql(`select to_char((now() - interval '${ago}') at time zone 'Europe/Istanbul', 'DD.MM');`).trim();

  const SILENT = "fetch_last_status = 200, fetch_fail_streak = 0, fetch_items_count = 5, fetch_newest_item_at = now()";
  const FROZEN = "fetch_last_status = 200, fetch_fail_streak = 0, fetch_items_count = 0";

  beforeAll(() => {
    expect(runPsql(`select count(*) from public.ops_health_report();`).trim()).toBe("22");
  });

  it("returns 22 rows: row 22 is sources_dark_persistent, last; image_coverage stays row 21 and queue_lag row 18", () => {
    const out = runPsql("select check_name from public.ops_health_report();").split("\n").filter(Boolean);
    expect(out).toHaveLength(22);
    expect(out[21]).toBe(CHECK);
    expect(out[20]).toBe("image_coverage");
    expect(out[19]).toBe("feed_poll_stale");
    expect(out[17]).toBe("queue_lag");
    expect(out[12]).toBe("sources_newly_dark");
  });

  it("works in a read-only transaction (the production heartbeat reads through one)", () => {
    expect(runPsql(`begin read only;\nselect count(*) from public.ops_health_report();\nrollback;\n`).trim()).toBe("22");
  });

  it("no source at all: pass, observed 0, threshold 1, the Turkish pass text", () => {
    const r = rowOfFixture("");
    expect(r.status).toBe("pass");
    expect(r.observed).toBe("0");
    expect(r.threshold).toBe("1");
    expect(r.detail).toBe(DETAIL_PASS);
  });

  it("the 2026-11-08 shape warns where row 13 stays quiet: a source dark for 20 days with 400 articles before that is named by row 22 only", () => {
    // newest article 20 days ago, 400 articles created 21 days ago: row 13's 14 day window holds none of them
    const both = rowsOf(source("halk-tv") + articles("halk-tv", "21 days", 400, "20 days") + articles("halk-tv", "20 days", 1, "20 days"));
    expect(both.dark.status).toBe("pass");
    expect(both.dark.detail).toBe("yeni susan kaynak yok");
    expect(both.persistent.status).toBe("warn");
    expect(both.persistent.observed).toBe("1");
    expect(both.persistent.threshold).toBe("1");
    expect(both.persistent.detail).toBe(`${DETAIL_PREFIX}halk-tv (401) · erişim yok · son haber ${istanbulDate("20 days")}`);
  });

  it("names every flagged source, largest first then by slug, each with its reason label read from sources.fetch_*", () => {
    const fixture =
      source("b-quiet", { fetch: SILENT }) + articles("b-quiet", "30 days", 400) +
      source("a-quiet", { fetch: SILENT }) + articles("a-quiet", "30 days", 400) +
      source("c-frozen", { fetch: FROZEN }) + articles("c-frozen", "30 days", 1000) +
      source("d-blocked", { fetch: "fetch_last_status = 403, fetch_fail_streak = 40" }) + articles("d-blocked", "30 days", 350);
    const r = rowOfFixture(fixture);
    const d = istanbulDate("30 days");
    expect(r.status).toBe("warn");
    expect(r.observed).toBe("4");
    expect(r.detail).toBe(
      `${DETAIL_PREFIX}c-frozen (1000) · akış donmuş · son haber ${d}, a-quiet (400) · sessiz · son haber ${d}, b-quiet (400) · sessiz · son haber ${d}, d-blocked (350) · erişim yok · son haber ${d}`,
    );
  });

  it("flags at 300 articles in the window and not at 299", () => {
    expect(rowOfFixture(source("a") + articles("a", "30 days", 300)).status).toBe("warn");
    expect(rowOfFixture(source("a") + articles("a", "30 days", 299)).status).toBe("pass");
  });

  it("the dark boundary is 72 hours of the newest article (published_at): 71 hours is still a delivering source, 73 hours is dark", () => {
    expect(rowOfFixture(source("a") + articles("a", "30 days", 400) + articles("a", "71 hours", 1)).status).toBe("pass");
    expect(rowOfFixture(source("a") + articles("a", "30 days", 400) + articles("a", "73 hours", 1)).status).toBe("warn");
  });

  it("clears when the source delivers again: one fresh article is enough", () => {
    const dark = source("a") + articles("a", "30 days", 400);
    expect(rowOfFixture(dark).status).toBe("warn");
    expect(rowOfFixture(dark + articles("a", "1 hour", 1)).status).toBe("pass");
  });

  it("sticky: the window is anchored at the newest article, so the row stays on however long the source stays dark (40, 70 and 120 days; row 13 forgot it long ago)", () => {
    for (const ago of ["40 days", "70 days", "120 days"]) {
      const r = rowsOf(source("a") + articles("a", ago, 400));
      expect(r.dark.status, ago).toBe("pass");
      expect(r.persistent.status, ago).toBe("warn");
      expect(r.persistent.observed, ago).toBe("1");
      expect(r.persistent.detail, ago).toBe(`${DETAIL_PREFIX}a (400) · erişim yok · son haber ${istanbulDate(ago)}`);
    }
  });

  it("the window is the 60 days up to the newest article: articles 89 days old count (401 in all), 91 days old do not", () => {
    const newest = istanbulDate("30 days");
    const inside = rowOfFixture(source("a") + articles("a", "30 days", 1) + articles("a", "89 days", 400));
    expect(inside.status).toBe("warn");
    expect(inside.observed).toBe("1");
    expect(inside.detail).toBe(`${DETAIL_PREFIX}a (401) · erişim yok · son haber ${newest}`);
    const outside = rowOfFixture(source("a") + articles("a", "30 days", 1) + articles("a", "91 days", 400));
    expect(outside.status).toBe("pass");
    expect(outside.observed).toBe("0");
    expect(outside.detail).toBe(DETAIL_PASS);
  });

  it("the window is by published_at, not ingest time: 400 articles created 60 hours ago but published 100 hours ago name a source whose newest article is 100 hours old", () => {
    for (const created of ["60 hours", "73 hours"]) {
      const r = rowOfFixture(source("a") + articles("a", created, 400, "100 hours"));
      expect(r.status, created).toBe("warn");
      expect(r.observed, created).toBe("1");
      expect(r.detail, created).toBe(`${DETAIL_PREFIX}a (400) · erişim yok · son haber ${istanbulDate("100 hours")}`);
    }
  });

  it("excludes a baselined source, an inactive source and a source of another kind; a wire counts like an outlet", () => {
    const rows = source("a") + articles("a", "30 days", 400);
    expect(rowOfFixture(rows + "insert into public.ops_dark_source_baseline (slug, reason) values ('a', 'blocked-403');\n").status).toBe("pass");
    expect(rowOfFixture(source("a", { active: false }) + articles("a", "30 days", 400)).status).toBe("pass");
    expect(rowOfFixture(source("a", { kind: "aggregator" }) + articles("a", "30 days", 400)).status).toBe("pass");
    const wire = rowOfFixture(source("a", { kind: "wire" }) + articles("a", "30 days", 400));
    expect(wire.status).toBe("warn");
    expect(wire.observed).toBe("1");
  });

  it("a source that never delivered anything, or has no article in the window, is not flagged", () => {
    expect(rowOfFixture(source("empty")).status).toBe("pass");
    expect(rowOfFixture(source("young") + articles("young", "100 hours", 50)).status).toBe("pass");
  });

  it("a source whose every article is dated in the future has no newest article: it is a candidate and its date reads 'yok'", () => {
    const r = rowOfFixture(source("a") + articles("a", "30 days", 400, "-10 days"));
    expect(r.status).toBe("warn");
    expect(r.detail).toBe(`${DETAIL_PREFIX}a (400) · erişim yok · son haber yok`);
  });

  it("never fails, and the detail is cut at 500 characters however many sources are flagged", () => {
    let fixture = "";
    for (let i = 0; i < 12; i++) {
      const slug = `kaynak-${String(i).padStart(2, "0")}-${"x".repeat(40)}`;
      fixture += source(slug) + articles(slug, "30 days", 300 + i);
    }
    const r = rowOfFixture(fixture);
    expect(r.status).toBe("warn");
    expect(r.observed).toBe("12");
    expect(r.detail.length).toBe(500);
    expect(r.detail.startsWith(`${DETAIL_PREFIX}kaynak-11-`)).toBe(true);
  });

  it("the other rows are untouched: the report still returns row 13 and the new row side by side", () => {
    const r = rowsOf(source("a") + articles("a", "20 days", 200) + articles("a", "10 days", 150));
    // dark for 10 days with 150 articles created 10 days ago (row 13's 14 day window) and 200 created 20 days ago (only row 22's window): both rows name it, row 22 counts all 350
    expect(r.persistent.status).toBe("warn");
    expect(r.persistent.detail).toBe(`${DETAIL_PREFIX}a (350) · erişim yok · son haber ${istanbulDate("10 days")}`);
    expect(r.dark.status).toBe("warn");
    expect(r.dark.observed).toBe("1");
    // and a source row 13 names but row 22 does not: 160 articles in all is under 300
    const small = rowsOf(source("b") + articles("b", "20 days", 60) + articles("b", "10 days", 100));
    expect(small.dark.status).toBe("warn");
    expect(small.persistent.status).toBe("pass");
  });

  it("the function that runs is the file's: md5 and length of prosrc equal the text between the $fn$ markers, and it is security definer with an empty search_path", () => {
    const out = runPsql(
      `select md5(prosrc) || '|' || length(prosrc) || '|' || prosecdef || '|' || provolatile::text || '|' || coalesce(proconfig::text, '') from pg_proc where oid = 'public.ops_health_report()'::regprocedure;`,
    ).trim();
    expect(out).toBe(`${createHash("md5").update(body173).digest("hex")}|${body173.length}|true|v|{"search_path=\\"\\""}`);
  });

  it("the stored comment lists 22 rows and row 22", () => {
    const out = runPsql(`select obj_description('public.ops_health_report()'::regprocedure, 'pg_proc');`);
    expect(out).toContain("159, 161, 167, 173): 22 fixed rows");
    expect(out).toContain("sources_dark_persistent (an active outlet or wire source");
    expect(out).not.toContain("21 fixed rows");
  });

  it("is idempotent: the ledger holds one 173 row and the function stayed service_role only", () => {
    const out = runPsql(
      `select (select count(*) from supabase_migrations.schema_migrations where version = '173') || '|' || has_function_privilege('anon', 'public.ops_health_report()', 'execute') || '|' || has_function_privilege('authenticated', 'public.ops_health_report()', 'execute') || '|' || has_function_privilege('service_role', 'public.ops_health_report()', 'execute');`,
    ).trim();
    expect(out).toBe("1|false|false|true");
  });
});
