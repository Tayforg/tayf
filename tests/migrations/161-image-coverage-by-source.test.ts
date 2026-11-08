import { describe, it, expect, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 161 ("image-coverage-by-source"), h40-edgefns-1.
//
// medyascope.tv has answered the image consumer's article fetch with a Cloudflare challenge
// (HTTP 403, cf-mitigated: challenge) since 2026-10-29, so about 90% of its articles are stored
// without an image, and no ops row noticed: queue_lag reads depth and age, sources_newly_dark
// (row 13) watches missing articles, not missing images. 161 appends ONE row to
// ops_health_report(), `image_coverage` (row 21): per outlet/wire source, the share of the last
// 24 hours' articles stored without an image against the source's own share over the 14 days
// before. The consumer half (the 'blocked' outcome) is tests/functions/image-consumer.test.ts.
//
// This file pins: 161's report body is 159's body (the production fingerprint) plus exactly one new
// row block named image_coverage; the row's contract (window, scope, thresholds, warn only, Turkish
// detail with slugs and percentages only, read only, schema-qualified); that nothing else changes
// (revoke/grant, the ledger pattern, no update / delete / insert but the ledger row); the function
// comment; the docs; and the live manifest. The live block at the end runs the row against fixtures
// through psql when TAYF_PSQL is set.
//
// SQL is scanned by character, never with a nested-quantifier regex (CodeQL).
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const MIGRATION_161 = resolve(MIGRATIONS_DIR, "161_image_coverage_by_source.sql");
const MIGRATION_159 = resolve(MIGRATIONS_DIR, "159_ingest_stale_admission.sql");
const DOC_MIGRATION_GUIDE = resolve(ROOT, "docs", "migration-guide.md");
const DOC_OPS_HEARTBEAT = resolve(ROOT, "docs", "ops-heartbeat.md");
const LIVE_MANIFEST = resolve(__dirname, "sql", "live-manifest.txt");

const CHECK = "image_coverage";
const CREATE_LINE = "create or replace function public.ops_health_report()";
const MARKER_21 = "  -- 21. image_coverage (migration 161, h40-edgefns-1).";
/** What follows the last row's `return next;`. */
const FN_END = "\n\n  return;\nend\n$fn$;";

/** Production, read-only, 2026-11-05: md5(prosrc) and length of ops_health_report() before 161 (migration 159's text). */
const PROD_MD5_BEFORE = "a2246bc0ea663b123144a2fa4c4f5735";
const PROD_LENGTH_BEFORE = 42501;

const REVOKE_STMT = "revoke all on function public.ops_health_report() from public, anon, authenticated";
const GRANT_STMT = "grant execute on function public.ops_health_report() to service_role";
const LEDGER_STMT =
  "insert into supabase_migrations.schema_migrations (version, name) values ('161', '161_image_coverage_by_source') on conflict do nothing";

const COMMENT_PREFIX_159 =
  "Read-only ops heartbeat (migrations 077, 100, 103, 108, 114, 115, 119, 122, 136, 145, 150, 157, 158, 159): 20 fixed rows, in this order --";
const COMMENT_PREFIX_161 =
  "Read-only ops heartbeat (migrations 077, 100, 103, 108, 114, 115, 119, 122, 136, 145, 150, 157, 158, 159, 161): 21 fixed rows, in this order --";
const COMMENT_TAIL_159 = "oldest first, and nothing else). status is one of pass|warn|fail|unknown|skip";

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

let raw = "";
let code = "";
let statements: string[] = [];
let raw159 = "";
let fn161 = "";
let fn159 = "";
let row21 = "";

beforeAll(() => {
  raw = readFileSync(MIGRATION_161, "utf8");
  code = stripComments(raw);
  statements = splitStatements(code);
  raw159 = readFileSync(MIGRATION_159, "utf8");
  // the last occurrence: a header may quote the create line in a comment
  const from161 = raw.lastIndexOf(CREATE_LINE);
  fn161 = raw.slice(from161, raw.indexOf(FN_END, from161) + FN_END.length);
  const from159 = raw159.lastIndexOf(CREATE_LINE);
  fn159 = raw159.slice(from159, raw159.indexOf(FN_END, from159) + FN_END.length);
  const at = fn161.indexOf(MARKER_21);
  row21 = at < 0 ? "" : fn161.slice(at, fn161.length - FN_END.length);
});

describe("161 helpers (the scans are not vacuous)", () => {
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
    expect(wordsOf("select x.image_url, 'y'")).toEqual(["select", "x", "image_url", "y"]);
    expect(literalNames("check_name := 'a_b'; x; check_name := 'c';")).toEqual(["a_b", "c"]);
  });
});

describe("161 ledger and structure", () => {
  it("is one transaction: begin; first, commit; last", () => {
    expect(statements[0]).toBe("begin");
    expect(statements[statements.length - 1]).toBe("commit");
    expect(statements.filter((s) => s === "begin")).toHaveLength(1);
    expect(statements.filter((s) => s === "commit")).toHaveLength(1);
  });

  it("ends with the ledger row in the 095 pattern, then commit", () => {
    const tail = statements.slice(-2).map(collapse);
    expect(tail[0]).toBe(LEDGER_STMT);
    expect(tail[1]).toBe("commit");
  });

  it("is, in order: begin, the function, its comment, revoke, grant, ledger, commit", () => {
    const kinds = statements.map((s) => collapse(s).split(" ").slice(0, 3).join(" "));
    expect(kinds).toEqual([
      "begin",
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
    // and the function statement itself (the whole body, 159's rows included) writes nothing
    const body = wordsOf(blankStrings(stripComments(prosrcOf(raw))));
    for (const w of ["insert", "update", "delete", "truncate", "drop", "alter", "create"]) {
      expect(body, w).not.toContain(w);
    }
  });

  it("does not notify pgrst: no table, column or RPC shape changes", () => {
    expect(wordsOf(blankStrings(code))).not.toContain("notify");
  });
});

describe("161 header documents the change", () => {
  let header = "";
  beforeAll(() => {
    header = raw.slice(0, raw.indexOf("\nbegin;"));
  });

  it("names the finding, the evidence and the sections", () => {
    expect(header).toMatch(/^-- 161_image_coverage_by_source\.sql/);
    for (const word of [
      "h40-edgefns-1",
      "medyascope",
      "Cloudflare",
      "cf-mitigated",
      "2026-10-29",
      "image_coverage",
      "image_backfill_attempts",
      "WHY",
      "WHAT CHANGES",
    ]) {
      expect(header, word).toContain(word);
    }
  });

  it("records the production fingerprint of the function it copies, the EXPLAIN timing, and the dry run", () => {
    expect(header).toContain(PROD_MD5_BEFORE);
    expect(header).toContain(String(PROD_LENGTH_BEFORE));
    expect(header).toContain("STEP 0");
    expect(header).toContain("EXPLAIN (ANALYZE");
    expect(header).toContain("idx_articles_created_at");
    expect(header).toContain("DRY RUN");
  });

  it("states the deploy order: apply 161, then deploy image-consumer with --no-verify-jwt", () => {
    expect(header).toContain("DEPLOY: APPLY 161, THEN DEPLOY image-consumer");
    expect(header).toContain("supabase functions deploy image-consumer --no-verify-jwt");
  });

  it("has a verify section and a rollback that restores 159's function and drops nothing", () => {
    expect(header).toContain("VERIFY (read-only");
    const rb = header.slice(header.indexOf("ROLLBACK"));
    expect(rb).toContain("ONLY 159's ops_health_report() section");
    expect(rb).toContain("delete from supabase_migrations.schema_migrations where version = '161'");
    expect(rb).toContain(PROD_MD5_BEFORE);
  });

  it("keeps the parked rows alone: no reset of image_backfill_attempts, no data change", () => {
    expect(header).toContain("No reset of the parked rows");
    expect(code).not.toContain("image_backfill_attempts");
  });
});

describe("161 is 159's function plus exactly one row", () => {
  it("159's function body is the one running on production (md5 and length from the read-only fingerprint)", () => {
    const body = prosrcOf(raw159);
    expect(createHash("md5").update(body).digest("hex")).toBe(PROD_MD5_BEFORE);
    expect(body.length).toBe(PROD_LENGTH_BEFORE);
  });

  it("the marker is in 161 once and in 159 never", () => {
    expect(fn161.split(MARKER_21).length - 1).toBe(1);
    expect(fn159.includes(MARKER_21)).toBe(false);
    expect(row21.length).toBeGreaterThan(1500);
  });

  it("everything from the create line through row 20's `return next;` is 159's text, byte for byte (comments included)", () => {
    const tail159 = `  return next;${FN_END}`;
    expect(fn159.endsWith(tail159)).toBe(true);
    const before159 = fn159.slice(0, fn159.length - FN_END.length);
    expect(before159.length).toBeGreaterThan(40000);
    expect(fn161.startsWith(`${before159}\n\n${MARKER_21}`)).toBe(true);
  });

  it("the function ends exactly as 159's does, right after the new row's `return next;`", () => {
    expect(fn161.endsWith(`  return next;${FN_END}`)).toBe(true);
    expect(fn161.split(CREATE_LINE).length - 1).toBe(1);
  });

  it("removing the new row block gives 159's function text exactly", () => {
    const without = fn161.slice(0, fn161.indexOf(`\n\n${MARKER_21}`)) + FN_END;
    expect(without).toBe(fn159);
  });

  it("the body's literal check names are 159's 19 literals plus image_coverage, last", () => {
    const names159 = literalNames(prosrcOf(raw159));
    const names161 = literalNames(prosrcOf(raw));
    expect(names161).toEqual([...names159, CHECK]);
    expect(names161[names161.length - 1]).toBe(CHECK);
    expect(names161.filter((n) => n === CHECK)).toHaveLength(1);
    expect(names159[names159.length - 1]).toBe("feed_poll_stale");
  });

  it("keeps the header: security definer, volatile, search_path = '', returns table, one pair of $fn$ markers", () => {
    const head = fn161.slice(0, fn161.indexOf("as $fn$"));
    expect(head).toBe(fn159.slice(0, fn159.indexOf("as $fn$")));
    expect(collapse(head)).toContain("security definer");
    expect(collapse(head)).toContain("volatile");
    expect(collapse(head)).toContain("set search_path = ''");
    expect(raw.split("$fn$").length - 1).toBe(2);
  });

  it("the word 'grant' never appears in the function body, comments included (the anon-surface guard scans bodies for it)", () => {
    const words = wordsOf(prosrcOf(raw));
    expect(words).not.toContain("grant");
    expect(words).not.toContain("grants");
  });

  it("revoke all from public, anon, authenticated and execute for service_role only: 159's two statements", () => {
    const revokes = statements.filter((s) => collapse(s).startsWith("revoke all on function public.ops_health_report()"));
    const grants = statements.filter((s) => collapse(s).startsWith("grant "));
    expect(revokes.map(collapse)).toEqual([REVOKE_STMT]);
    expect(grants.map(collapse)).toEqual([GRANT_STMT]);
  });
});

describe("161 row 21: image_coverage", () => {
  let rowCode = "";
  let rowCollapsed = "";
  beforeAll(() => {
    rowCode = stripComments(row21);
    rowCollapsed = collapse(rowCode);
  });

  it("the marker comment names the evidence: medyascope, the date, the challenge and the daily numbers", () => {
    for (const word of ["medyascope", "2026-10-29", "Cloudflare", "403", "cf-mitigated", "sources_newly_dark", "queue_lag", "14 days", "2026-11-05"]) {
      expect(row21, word).toContain(word);
    }
  });

  it("is a row of its own: threshold 1, the check name set once, observed and detail reset", () => {
    expect(rowCollapsed).toContain("check_name := 'image_coverage'; threshold := 1; observed := null; detail := null;");
    expect(rowCollapsed.endsWith("return next;")).toBe(true);
    expect(row21.split("return next;").length - 1).toBe(1);
  });

  it("scope: sources of kind outlet or wire, at least 10 articles created between 25 hours and 1 hour ago (the newest hour is skipped)", () => {
    expect(rowCollapsed).toContain("s.kind in ('outlet', 'wire')");
    expect(rowCollapsed).toContain("a.created_at >= v_now - interval '25 hours' and a.created_at < v_now - interval '1 hour'");
    expect(rowCollapsed).toContain("having pg_catalog.count(*) >= 10");
  });

  it("baseline: the source's own share over the 14 days before (created between 15 days and 25 hours ago), read only for sources over 50%, and only with at least 10 articles", () => {
    expect(rowCollapsed).toContain("a.created_at >= v_now - interval '15 days' and a.created_at < v_now - interval '25 hours'");
    expect(rowCollapsed).toContain("a.source_id = any (array(select x.source_id from rs x where x.nul >= 0.5 * x.n))");
    // two group-by-source scans of public.articles, each with at least 10 rows
    expect(rowCollapsed.split("having pg_catalog.count(*) >= 10").length - 1).toBe(2);
    expect(rowCollapsed.split("from public.articles a").length - 1).toBe(2);
  });

  it("every scan of public.articles is bounded on created_at (the index): two lower bounds, two upper bounds", () => {
    expect(rowCollapsed.split("a.created_at >= v_now - interval").length - 1).toBe(2);
    expect(rowCollapsed.split("a.created_at < v_now - interval").length - 1).toBe(2);
    expect(wordsOf(blankStrings(rowCode))).not.toContain("published_at");
  });

  it("image-less means image_url is null, counted with a filter on the same scan", () => {
    expect(rowCollapsed).toContain("pg_catalog.count(*) filter (where a.image_url is null)::numeric as nul");
  });

  it("flags a source when its 24 hour share is at least 0.5 and at least 0.4 above its own baseline; a source without a baseline is never flagged", () => {
    expect(rowCollapsed).toContain("(b.n is not null and rs.nul / rs.n >= 0.5 and rs.nul / rs.n - b.nul / b.n >= 0.4) as hit");
  });

  it("observed is the number of flagged sources; warn at 1, else pass; the row never fails", () => {
    expect(rowCollapsed).toContain("observed := i_hit;");
    expect(rowCollapsed).toContain("status := case when i_hit >= 1 then 'warn' else 'pass' end;");
    expect(wordsOf(rowCode)).not.toContain("fail");
  });

  it("the detail is Turkish, lists slug and the two percentages only, worst first, and is cut at 500 characters", () => {
    expect(rowCollapsed).toContain("' görselsiz (14 gün: %'");
    expect(rowCollapsed).toContain("pg_catalog.round(100 * f.share_24)::text");
    expect(rowCollapsed).toContain("pg_catalog.round(100 * f.share_base)::text");
    expect(rowCollapsed).toContain("order by f.share_24 desc, f.slug");
    expect(rowCollapsed).toContain("1, 500);");
    expect(rowCollapsed).toContain("görselsiz haber oranında sıçrama yok (");
  });

  it("answers 'unknown' with the first 200 characters of the error if the read fails", () => {
    expect(rowCollapsed).toContain("exception when others then status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);");
  });

  it("only reads: no write, no dynamic SQL, no perform", () => {
    const outside = wordsOf(blankStrings(rowCode));
    for (const w of ["insert", "update", "delete", "truncate", "drop", "alter", "create", "perform", "execute"]) {
      expect(outside, w).not.toContain(w);
    }
  });

  it("selects no url, title or body column: slug, kind, source_id, created_at and image_url only", () => {
    const outside = wordsOf(blankStrings(rowCode));
    for (const w of ["url", "rss_url", "title", "summary", "content", "description", "content_hash"]) {
      expect(outside, w).not.toContain(w);
    }
    for (const w of ["slug", "kind", "source_id", "created_at", "image_url"]) expect(outside, w).toContain(w);
  });

  it("calls every function schema-qualified (search_path is empty)", () => {
    // a bare name before `(` that is not a keyword: count, round, string_agg, now, substr and coalesce are the ones this row could use
    const bare: string[] = [];
    for (const fnName of ["count", "round", "string_agg", "now", "floor", "concat_ws"]) {
      let at = rowCode.indexOf(`${fnName}(`);
      while (at >= 0) {
        const prev = at === 0 ? " " : rowCode.charAt(at - 1);
        if (prev !== ".") bare.push(fnName);
        at = rowCode.indexOf(`${fnName}(`, at + 1);
      }
    }
    expect(bare).toEqual([]);
    expect(rowCode).toContain("pg_catalog.count(*)");
    expect(rowCode).toContain("pg_catalog.string_agg(");
  });

  it("shares no variable with the other rows: its three locals are declared in its own block", () => {
    expect(rowCollapsed).toContain("declare i_checked numeric; i_hit numeric; i_list text; begin");
    for (const v of ["i_checked", "i_hit", "i_list"]) {
      expect(prosrcOf(raw159).includes(v), `${v} not in 159`).toBe(false);
    }
  });
});

describe("161 function comment", () => {
  it("is 159's text with the migration list ending 159, 161, 21 fixed rows, and the image_coverage description appended, nothing else", () => {
    const c159 = commentText(raw159.slice(raw159.lastIndexOf("comment on function public.ops_health_report() is")));
    const c161 = commentText(raw.slice(raw.lastIndexOf("comment on function public.ops_health_report() is")));
    expect(c159.startsWith(COMMENT_PREFIX_159)).toBe(true);
    expect(c161.startsWith(COMMENT_PREFIX_161)).toBe(true);
    expect(c159.split(COMMENT_TAIL_159).length - 1).toBe(1);
    const start = c161.indexOf(" image_coverage (");
    expect(start).toBeGreaterThan(0);
    const end = c161.indexOf(" status is one of pass|warn|fail|unknown|skip");
    expect(end).toBeGreaterThan(start);
    // removing the new entry and restoring the prefix and the full stop gives 159's comment
    const restored = (c161.slice(0, start) + c161.slice(end)).replace(COMMENT_PREFIX_161, COMMENT_PREFIX_159).replace("nothing else), status", "nothing else). status");
    expect(restored).toBe(c159);
  });

  it("describes the row: scope, windows, thresholds, warn only, the detail, and the 2 percentages", () => {
    const c = commentText(raw.slice(raw.lastIndexOf("comment on function public.ops_health_report() is")));
    const entry = c.slice(c.indexOf(" image_coverage ("), c.indexOf(" status is one of pass|warn|fail|unknown|skip"));
    for (const word of ["outlet", "wire", "10 articles", "25 hours", "1 hour", "14 days", "image_url", "50 percent", "40", "warn", "never fails", "threshold 1", "unknown", "slug"]) {
      expect(entry, word).toContain(word);
    }
  });

  it("still says service_role only, never reads a secret-bearing pg_cron field, and points at docs/ops-heartbeat.md", () => {
    const c = commentText(raw.slice(raw.lastIndexOf("comment on function public.ops_health_report() is")));
    expect(c).toContain("service_role only");
    expect(c).toContain("never reads any potentially secret-bearing pg_cron job field");
    expect(c).toContain("docs/ops-heartbeat.md");
  });
});

describe("161 docs/ops-heartbeat.md", () => {
  let doc = "";
  beforeAll(() => {
    doc = readFileSync(DOC_OPS_HEARTBEAT, "utf8");
  });

  it("counts 21 rows everywhere it counts rows, and credits row 21 to migration 161", () => {
    // 173 appended a twenty-second row and moved these counts (tests/migrations/173-ops-sources-dark-persistent.test.ts pins 22)
    expect(doc).toMatch(/(21|22) fixed-order rows/);
    expect(doc).toContain("the twenty-first by migration 161");
    expect(doc).toMatch(/on top of the (21|22):/);
    expect(doc).toMatch(/exactly\n(21|22) rows\./);
    expect(doc).not.toContain("20 fixed-order rows");
  });

  it("row 21 states the scope, the two windows, the thresholds and the evidence, and names migration 161", () => {
    const at = doc.indexOf("| 21 | `image_coverage`");
    expect(at).toBeGreaterThan(doc.indexOf("| 20 | `feed_poll_stale`"));
    const row = doc.slice(at, doc.indexOf("\n", at));
    for (const word of [
      "outlet",
      "wire",
      "25 hours",
      "14 days",
      "image_url",
      "at least 10",
      "50%",
      "40 points",
      "warn",
      "medyascope",
      "2026-10-29",
      "cf-mitigated",
      "161",
      "blocked",
      "Cloudflare",
    ]) {
      expect(row, word).toContain(word);
    }
    expect(row).toContain("warn >= 1 (threshold 1)");
  });
});

describe("161 docs/migration-guide.md", () => {
  let section = "";
  beforeAll(() => {
    const guide = readFileSync(DOC_MIGRATION_GUIDE, "utf8");
    const at = guide.indexOf("\n## 161");
    expect(at, "the ## 161 section").toBeGreaterThan(0);
    const next = guide.indexOf("\n## ", at + 1);
    section = guide.slice(at, next < 0 ? guide.length : next);
  });

  it("has Why, What, Order, Verify and Rollback", () => {
    for (const word of ["Why", "What", "Order", "Verify", "Rollback"]) {
      expect(section, word).toContain(word);
    }
  });

  it("says to apply 161 first, then deploy image-consumer with --no-verify-jwt, and that the reverse is safe", () => {
    expect(section).toContain("apply 161");
    expect(section).toContain("supabase functions deploy image-consumer --no-verify-jwt");
    expect(section.indexOf("apply 161")).toBeLessThan(section.indexOf("supabase functions deploy image-consumer"));
  });

  it("verifies the 21 rows, row 21, the fingerprint, the privileges and the ledger, and the drain summary", () => {
    for (const word of ["expect 21", "image_coverage", "medyascope", "md5", "schema_migrations", "has_function_privilege", "net._http_response", "blockedBySource"]) {
      expect(section, word).toContain(word);
    }
  });

  it("has a rollback that re-runs only 159's report section and deletes only the 161 ledger row", () => {
    expect(section).toContain("159_ingest_stale_admission.sql");
    expect(section).toContain("version = '161'");
    expect(section).toContain(PROD_MD5_BEFORE);
  });

  it("states the founder follow-up and does not reset parked rows", () => {
    expect(section).toContain("allowlist");
    expect(section).toContain("image_backfill_attempts");
    expect(section).toContain("founder");
  });
});

describe("161 live manifest", () => {
  it("builds 161's database: 150's dry-run, 041, 157, then 161 applied twice", () => {
    const lines = readFileSync(LIVE_MANIFEST, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("run | 161-image-coverage-by-source.test.ts"));
    expect(lines).toHaveLength(1);
    const setup = (lines[0] as string).split("|")[2] as string;
    const files = setup.trim().split(/\s+/);
    expect(files).toEqual([
      "tests/migrations/sql/150-ops-queue-cron-liveness-dryrun.sql",
      "supabase/migrations/041_source_fetch_state.sql",
      "supabase/migrations/157_ingest_poll_stale.sql",
      "supabase/migrations/161_image_coverage_by_source.sql",
      "supabase/migrations/161_image_coverage_by_source.sql",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Live behaviour (opt-in): row 21 against fixtures, on a throwaway Postgres with 145, 150, 157 and 161
// applied (tests/migrations/sql/live-manifest.txt). TAYF_PSQL is the psql binary and
// PGHOST/PGPORT/PGUSER/PGDATABASE select the server. Every case ends in a rollback.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))("161 row 21 against fixtures (live Postgres, every case rolled back)", () => {
  assertLiveReady("161", { ledger: ["145", "150", "157", "161"], functions: ["public.ops_health_report()"] });

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
   * Runs the fixture in begin..rollback and returns row 21 (the report itself must not raise). The stub's articles table has
   * no image_url (production does), so each case adds it inside its own transaction.
   */
  function row21Of(fixture: string): Row {
    const out = runPsql(
      `begin;\nalter table public.articles add column if not exists image_url text;\ndelete from public.articles;\ndelete from public.sources;\n${fixture}\nselect status, observed, threshold, detail from public.ops_health_report() where check_name = '${CHECK}';\nrollback;\n`,
    );
    const lines = out.split("\n").filter((l) => l.trim() !== "");
    expect(lines, out).toHaveLength(1);
    const [status, observed, threshold, ...rest] = (lines[0] as string).split("|");
    return { status: status as string, observed: observed as string, threshold: threshold as string, detail: rest.join("|") };
  }

  let seq = 0;
  /** A source of the given kind. */
  const source = (slug: string, kind = "outlet") =>
    `insert into public.sources (slug, name, active, kind) values ('${slug}', '${slug}', true, '${kind}');\n`;
  /**
   * `total` articles of the source created `hoursAgo` hours ago (spread over a few minutes), `imageless` of them without an
   * image_url. Distinct urls and content hashes.
   */
  function articles(slug: string, hoursAgo: number, total: number, imageless: number): string {
    seq += 1;
    const tag = `${slug}-${seq}`;
    return (
      `insert into public.articles (source_id, title, url, content_hash, published_at, created_at, image_url)\n` +
      `select s.id, 't ' || g, 'https://example.test/${tag}/' || g, 'h-${tag}-' || g, now() - interval '${hoursAgo} hours', ` +
      `now() - interval '${hoursAgo} hours' - (g || ' seconds')::interval, ` +
      `case when g <= ${imageless} then null else 'https://cdn.example.test/${tag}/' || g || '.jpg' end\n` +
      `from public.sources s, generate_series(1, ${total}) g where s.slug = '${slug}';\n`
    );
  }

  beforeAll(() => {
    const out = runPsql(`select count(*) from public.ops_health_report();`).trim();
    expect(out).toBe("21");
  });

  it("returns 21 rows; row 21 is image_coverage, last; row 20 is feed_poll_stale and the other 19 are 159's names and order", () => {
    const out = runPsql("select check_name from public.ops_health_report();").split("\n").filter(Boolean);
    expect(out).toHaveLength(21);
    expect(out[20]).toBe(CHECK);
    expect(out[19]).toBe("feed_poll_stale");
    expect(out[17]).toBe("queue_lag");
    expect(out[18]).toBe("cron_jobs_stalled");
  });

  it("no source at all: pass, observed 0, threshold 1", () => {
    const r = row21Of("");
    expect(r.status).toBe("pass");
    expect(r.observed).toBe("0");
    expect(r.threshold).toBe("1");
    expect(r.detail).toBe("görselsiz haber oranında sıçrama yok (0 kaynak)");
  });

  it("the medyascope shape (90% image-less now, 2% over the 14 days before) warns, naming the slug and both percentages", () => {
    const r = row21Of(source("medyascope") + articles("medyascope", 10, 40, 36) + articles("medyascope", 100, 100, 2) + source("birgun") + articles("birgun", 10, 40, 1));
    expect(r.status).toBe("warn");
    expect(r.observed).toBe("1");
    expect(r.threshold).toBe("1");
    expect(r.detail).toBe("son 24 saatte görselsiz haber oranı sıçrayan kaynak 1: medyascope %90 görselsiz (14 gün: %2)");
  });

  it("a source that is always image-less (high baseline) is not flagged: a change is, a level is not", () => {
    const r = row21Of(source("noimg") + articles("noimg", 10, 40, 36) + articles("noimg", 100, 100, 90));
    expect(r.status).toBe("pass");
    expect(r.observed).toBe("0");
    expect(r.detail).toBe("görselsiz haber oranında sıçrama yok (1 kaynak)");
  });

  it("the share boundary: 50% now over a 2% baseline warns, just under 50% passes", () => {
    expect(row21Of(source("a") + articles("a", 10, 40, 20) + articles("a", 100, 100, 2)).status).toBe("warn");
    expect(row21Of(source("a") + articles("a", 10, 40, 19) + articles("a", 100, 100, 2)).status).toBe("pass");
  });

  it("the jump boundary: 40 points above the baseline warns, 39 does not", () => {
    // 60% now: baseline 20% is a 40-point jump, 21% is 39
    expect(row21Of(source("a") + articles("a", 10, 100, 60) + articles("a", 100, 100, 20)).status).toBe("warn");
    expect(row21Of(source("a") + articles("a", 10, 100, 60) + articles("a", 100, 100, 21)).status).toBe("pass");
  });

  it("needs at least 10 articles in the last 24 hours (9 never flags) and at least 10 in the baseline", () => {
    expect(row21Of(source("a") + articles("a", 10, 10, 10) + articles("a", 100, 100, 0)).status).toBe("warn");
    expect(row21Of(source("a") + articles("a", 10, 9, 9) + articles("a", 100, 100, 0)).status).toBe("pass");
    // a new source with no baseline cannot be compared with its own past
    expect(row21Of(source("fresh") + articles("fresh", 10, 40, 40)).status).toBe("pass");
    expect(row21Of(source("fresh") + articles("fresh", 10, 40, 40) + articles("fresh", 100, 9, 0)).status).toBe("pass");
  });

  it("skips the newest hour (the backfill has not reached it) and the 24 hour window ends 25 hours ago", () => {
    // 40 articles 30 minutes old, all image-less, plus 10 healthy ones 10 hours old: the recent ones are not looked at
    const fresh = `insert into public.articles (source_id, title, url, content_hash, published_at, created_at, image_url)
      select s.id, 't' || g, 'https://example.test/fresh/' || g, 'hf-' || g, now(), now() - interval '30 minutes', null
      from public.sources s, generate_series(1, 40) g where s.slug = 'a';\n`;
    expect(row21Of(source("a") + articles("a", 10, 10, 0) + fresh + articles("a", 100, 100, 0)).status).toBe("pass");
    // 40 image-less articles 26 hours old belong to the baseline, not the window
    expect(row21Of(source("a") + articles("a", 10, 10, 0) + articles("a", 26, 40, 40) + articles("a", 100, 100, 0)).status).toBe("pass");
    // and articles older than 15 days are not in the baseline: a 90% baseline 16 days back changes nothing
    expect(row21Of(source("a") + articles("a", 10, 40, 36) + articles("a", 100, 100, 2) + articles("a", 16 * 24, 500, 450)).status).toBe("warn");
  });

  it("only outlet and wire sources count: an aggregator, a niche source and an inactive-kind row are ignored", () => {
    const f = (slug: string, kind: string) => source(slug, kind) + articles(slug, 10, 40, 36) + articles(slug, 100, 100, 2);
    expect(row21Of(f("agg", "aggregator")).status).toBe("pass");
    expect(row21Of(f("nic", "niche")).status).toBe("pass");
    expect(row21Of(f("wir", "wire")).status).toBe("warn");
  });

  it("two flagged sources: observed 2, worst first, one line", () => {
    const f = (slug: string, imageless: number) => source(slug) + articles(slug, 10, 40, imageless) + articles(slug, 100, 100, 2);
    const r = row21Of(f("aaa", 30) + f("zzz", 38));
    expect(r.status).toBe("warn");
    expect(r.observed).toBe("2");
    expect(r.detail).toBe("son 24 saatte görselsiz haber oranı sıçrayan kaynak 2: zzz %95 görselsiz (14 gün: %2), aaa %75 görselsiz (14 gün: %2)");
  });

  it("the detail names slugs and percentages only: no url, no count of articles", () => {
    const r = row21Of(source("medyascope") + articles("medyascope", 10, 40, 36) + articles("medyascope", 100, 100, 2));
    expect(r.detail).not.toContain("http");
    expect(r.detail).not.toContain("example.test");
    expect(r.detail).not.toContain("40");
  });

  it("the detail is cut at 500 characters", () => {
    const many = Array.from({ length: 40 }, (_, i) => {
      const slug = `a-very-long-source-slug-number-${String(i).padStart(2, "0")}`;
      return source(slug) + articles(slug, 10, 10, 10) + articles(slug, 100, 10, 0);
    }).join("");
    const r = row21Of(many);
    expect(r.status).toBe("warn");
    expect(r.observed).toBe("40");
    expect(r.detail.length).toBeLessThanOrEqual(500);
  });

  it("the function that runs is the file's: md5 and length of prosrc equal the text between the $fn$ markers, and it is security definer with an empty search_path", () => {
    const body = prosrcOf(raw);
    const out = runPsql(
      `select md5(prosrc) || '|' || length(prosrc) || '|' || prosecdef || '|' || coalesce(proconfig::text, '') from pg_proc where oid = 'public.ops_health_report()'::regprocedure;`,
    ).trim();
    // proconfig prints as {"search_path=\"\""}: the one setting, an empty search_path
    expect(out).toBe(`${createHash("md5").update(body).digest("hex")}|${body.length}|true|{"search_path=\\"\\""}`);
  });

  it("is idempotent: the ledger holds one 161 row and the function stayed service_role only", () => {
    const out = runPsql(
      `select (select count(*) from supabase_migrations.schema_migrations where version = '161') || '|' || has_function_privilege('anon', 'public.ops_health_report()', 'execute') || '|' || has_function_privilege('authenticated', 'public.ops_health_report()', 'execute') || '|' || has_function_privilege('service_role', 'public.ops_health_report()', 'execute');`,
    ).trim();
    expect(out).toBe("1|false|false|true");
  });
});
