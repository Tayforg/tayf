import { describe, it, expect, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 159 ("ingest-stale-admission"), h39-pipeline2-1.
//
// #198 (h36-pipeline-1) did not end BHA's starvation: the opposition wire went 107 minutes
// unpolled on 2026-11-05 (09:25-11:12Z) and row 20 of ops_health_report(), feed_poll_stale,
// sat at warn / 1 the whole time, because one stale feed can only warn. 159 is the database half
// of the second fix (the ingest change itself is tests/functions/ingest-order.test.ts and
// tests/functions/ingest.test.ts):
//   1. ingest_cycles gets two nullable integer columns, stale_deferred and oldest_stale_min,
//      written by ingest's recordIngestCycle;
//   2. ops_health_report() is re-created with 158's text verbatim except row 20: it is a `fail`
//      (it pages) at 3 stale feeds OR when any counted feed was last polled more than 60 minutes
//      ago; warn at 1; the detail is unchanged.
//
// This file pins the columns, the byte identity of everything but row 20 against 158 (and 158's
// body against the production fingerprint), row 20's contract, the function comment, the ledger
// pattern, the documented deploy order, the parity with the column names ingest writes, and
// docs/ops-heartbeat.md plus docs/migration-guide.md. It is static; the live block at the end runs
// row 20 against fixtures through psql when TAYF_PSQL is set (tests/migrations/sql/live-manifest.txt
// builds the database: 150's dry-run, 041, 157, 159 twice).
//
// SQL is scanned by character, never with a nested-quantifier regex (CodeQL).
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const MIGRATION_159 = resolve(MIGRATIONS_DIR, "159_ingest_stale_admission.sql");
const MIGRATION_158 = resolve(MIGRATIONS_DIR, "158_saved_clusters_v3.sql");
const DOC_MIGRATION_GUIDE = resolve(ROOT, "docs", "migration-guide.md");
const DOC_OPS_HEARTBEAT = resolve(ROOT, "docs", "ops-heartbeat.md");
const INGEST_INDEX = resolve(ROOT, "supabase", "functions", "ingest", "index.ts");
const LIVE_MANIFEST = resolve(__dirname, "sql", "live-manifest.txt");

const CHECK_20 = "feed_poll_stale";
const COLUMNS = ["stale_deferred", "oldest_stale_min"] as const;

const CREATE_LINE = "create or replace function public.ops_health_report()";
const MARKER_20_158 = "-- 20. feed_poll_stale (migration 157).";
const MARKER_20_159 = "-- 20. feed_poll_stale (migration 157, fail rule widened by migration 159).";
/** What follows the last row's `return next;`. */
const FN_END = "\n\n  return;\nend\n$fn$;";

/** Production, read-only, 2026-11-05: md5(prosrc) and length of ops_health_report() before 159. */
const PROD_MD5_BEFORE = "04c2ffc4d047278703cd16f02db6808d";
const PROD_LENGTH_BEFORE = 41855;

const REVOKE_STMT = "revoke all on function public.ops_health_report() from public, anon, authenticated";
const GRANT_STMT = "grant execute on function public.ops_health_report() to service_role";

const COMMENT_PREFIX_158 =
  "Read-only ops heartbeat (migrations 077, 100, 103, 108, 114, 115, 119, 122, 136, 145, 150, 157, 158): 20 fixed rows, in this order --";
const COMMENT_PREFIX_159 =
  "Read-only ops heartbeat (migrations 077, 100, 103, 108, 114, 115, 119, 122, 136, 145, 150, 157, 158, 159): 20 fixed rows, in this order --";
const FAIL_PHRASE_158 = "warn at 1, fail at 3; observed is the count, threshold 3;";
const FAIL_PHRASE_159 =
  "warn at 1, fail at 3 or when any counted feed was last polled more than 60 minutes ago; observed is the count, threshold 3;";

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

let raw = "";
let code = "";
let statements: string[] = [];
let raw158 = "";
let fn159 = "";
let fn158 = "";
let before159 = "";
let before158 = "";
let row20_159 = "";
let row20_158 = "";

beforeAll(() => {
  raw = readFileSync(MIGRATION_159, "utf8");
  code = stripComments(raw);
  statements = splitStatements(code);
  raw158 = readFileSync(MIGRATION_158, "utf8");
  // the last occurrence: a header may quote the create line in a comment
  const from159 = raw.lastIndexOf(CREATE_LINE);
  fn159 = raw.slice(from159, raw.indexOf(FN_END, from159) + FN_END.length);
  const from158 = raw158.lastIndexOf(CREATE_LINE);
  fn158 = raw158.slice(from158, raw158.indexOf(FN_END, from158) + FN_END.length);
  const at159 = fn159.indexOf(MARKER_20_159);
  const at158 = fn158.indexOf(MARKER_20_158);
  before159 = at159 < 0 ? "" : fn159.slice(0, at159);
  before158 = at158 < 0 ? "" : fn158.slice(0, at158);
  row20_159 = at159 < 0 ? "" : fn159.slice(at159, fn159.length - FN_END.length);
  row20_158 = at158 < 0 ? "" : fn158.slice(at158, fn158.length - FN_END.length);
});

describe("159 helpers (the scans are not vacuous)", () => {
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

  it("blankStrings empties literals, wordsOf lists whole words", () => {
    expect(blankStrings("a 'it''s' b")).toBe("a '' b");
    expect(wordsOf("select x.fetch_last_at, 'y'")).toEqual(["select", "x", "fetch_last_at", "y"]);
  });
});

describe("159 ledger and structure", () => {
  it("is one transaction: begin; first, commit; last", () => {
    expect(statements[0]).toBe("begin");
    expect(statements[statements.length - 1]).toBe("commit");
    expect(statements.filter((s) => s === "begin")).toHaveLength(1);
    expect(statements.filter((s) => s === "commit")).toHaveLength(1);
  });

  it("ends with notify pgrst, then ('159', '159_ingest_stale_admission') in the 095 pattern, then commit", () => {
    const tail = statements.slice(-3).map(collapse);
    expect(tail[0]).toBe("notify pgrst, 'reload schema'");
    expect(tail[1]).toBe(
      "insert into supabase_migrations.schema_migrations (version, name) values ('159', '159_ingest_stale_admission') on conflict do nothing",
    );
    expect(tail[2]).toBe("commit");
  });

  it("is, in order: begin, the column alter, two column comments, the function, its comment, revoke, grant, notify, ledger, commit", () => {
    const kinds = statements.map((s) => collapse(s).split(" ").slice(0, 3).join(" "));
    expect(kinds).toEqual([
      "begin",
      "alter table public.ingest_cycles",
      "comment on column",
      "comment on column",
      "create or replace",
      "comment on function",
      "revoke all on",
      "grant execute on",
      "notify pgrst, 'reload",
      "insert into supabase_migrations.schema_migrations",
      "commit",
    ]);
  });

  it("is additive: nothing is dropped, truncated, deleted, updated or scheduled, and no index or trigger is created", () => {
    // the function statement is excluded: it only reads, which row 20's block below pins
    const others = statements.filter((s) => !s.startsWith("create or replace function"));
    expect(others.length).toBe(statements.length - 1);
    const outside = wordsOf(blankStrings(others.join(";\n")));
    for (const w of ["drop", "truncate", "delete", "update", "schedule", "unschedule", "trigger", "index", "concurrently", "cron"]) {
      expect(outside, w).not.toContain(w);
    }
  });
});

describe("159 header documents the change", () => {
  let header = "";
  beforeAll(() => {
    header = raw.slice(0, raw.indexOf("\nbegin;"));
  });

  it("names the finding, the evidence and the sections", () => {
    expect(header).toMatch(/^-- 159_ingest_stale_admission\.sql/);
    for (const word of ["h39-pipeline2-1", "BHA", "107", "09:25", "11:12", "feed_poll_stale", "stale_deferred", "oldest_stale_min", "WHY", "WHAT CHANGES"]) {
      expect(header, word).toContain(word);
    }
  });

  it("records the production fingerprint of the function it copies, and the dry run", () => {
    expect(header).toContain(PROD_MD5_BEFORE);
    expect(header).toContain(String(PROD_LENGTH_BEFORE));
    expect(header).toContain("STEP 0");
    expect(header).toContain("DRY RUN");
  });

  it("states the deploy order: apply 159 BEFORE deploying ingest, and why the reverse is still safe", () => {
    expect(header).toContain("DEPLOY: APPLY 159 BEFORE DEPLOYING ingest");
    expect(header).toContain("supabase functions deploy ingest --no-verify-jwt");
    expect(header).toMatch(/PGRST204/);
    expect(header).toMatch(/42703/);
  });

  it("has a verify section and a rollback that restores 158's function and drops nothing it did not add", () => {
    expect(header).toContain("VERIFY (read-only");
    const rb = header.slice(header.indexOf("ROLLBACK"));
    expect(rb).toContain("ONLY 158's ops_health_report() section");
    expect(rb).toContain("drop column if exists stale_deferred");
    expect(rb).toContain("drop column if exists oldest_stale_min");
    expect(rb).toContain("delete from supabase_migrations.schema_migrations where version = '159'");
  });
});

describe("159 ingest_cycles columns", () => {
  let alter = "";
  beforeAll(() => {
    alter = collapse(statements.find((s) => s.startsWith("alter table")) ?? "");
  });

  it("adds exactly the two nullable integer columns, if not exists, with no default and no not null", () => {
    expect(alter).toBe(
      "alter table public.ingest_cycles add column if not exists stale_deferred integer, add column if not exists oldest_stale_min integer",
    );
    expect(alter).not.toContain("default");
    expect(alter).not.toContain("not null");
  });

  it("documents each column in a column comment", () => {
    for (const c of COLUMNS) {
      const stmt = statements.find((s) => s.startsWith(`comment on column public.ingest_cycles.${c} is`));
      expect(stmt, c).toBeDefined();
      expect(stmt as string).toContain("NULL on rows written before 159");
    }
  });

  it("matches the keys ingest writes: the same two names appear in ingest/index.ts", () => {
    const ingest = readFileSync(INGEST_INDEX, "utf8");
    for (const c of COLUMNS) expect(ingest, c).toContain(`${c}: stats.`);
  });

  it("ingest retries the cycle row without the new columns on a missing column (42703 or PGRST204)", () => {
    const ingest = readFileSync(INGEST_INDEX, "utf8");
    expect(ingest).toContain('error.code === "42703" || error.code === "PGRST204"');
    expect(ingest).toContain("migration 157 not applied? or 159?");
  });
});

describe("159 is 158's function except for row 20", () => {
  it("158's function body is the one running on production (md5 and length from the read-only fingerprint)", () => {
    const body = prosrcOf(raw158);
    expect(createHash("md5").update(body).digest("hex")).toBe(PROD_MD5_BEFORE);
    expect(body.length).toBe(PROD_LENGTH_BEFORE);
  });

  it("both files carry the row-20 marker, once, and the markers are the expected ones", () => {
    expect(fn158.split(MARKER_20_158).length - 1).toBe(1);
    expect(fn159.split(MARKER_20_159).length - 1).toBe(1);
    expect(row20_158.length).toBeGreaterThan(1000);
    expect(row20_159.length).toBeGreaterThan(1000);
  });

  it("everything from the create line through row 19 is 158's text, byte for byte (comments included)", () => {
    expect(before159.length).toBeGreaterThan(38000);
    expect(before159).toBe(before158);
  });

  it("the function ends exactly as 158's does, right after row 20's `return next;`", () => {
    expect(fn159.endsWith(`  return next;${FN_END}`)).toBe(true);
    expect(fn158.endsWith(`  return next;${FN_END}`)).toBe(true);
    expect(fn159.split(CREATE_LINE).length - 1).toBe(1);
  });

  it("keeps the header: security definer, volatile, search_path = '', returns table, one pair of $fn$ markers", () => {
    const head = fn159.slice(0, fn159.indexOf("as $fn$"));
    expect(head).toBe(fn158.slice(0, fn158.indexOf("as $fn$")));
    expect(collapse(head)).toContain("security definer");
    expect(collapse(head)).toContain("set search_path = ''");
    expect(raw.split("$fn$").length - 1).toBe(2);
  });

  it("the word 'grant' never appears in the function body, comments included (the anon-surface guard scans bodies for it)", () => {
    const words = wordsOf(prosrcOf(raw));
    expect(words).not.toContain("grant");
    expect(words).not.toContain("grants");
  });

  it("revoke all from public, anon, authenticated and execute for service_role only: 158's two statements", () => {
    const revokes = statements.filter((s) => collapse(s).startsWith("revoke all on function public.ops_health_report()"));
    const grants = statements.filter((s) => collapse(s).startsWith("grant "));
    expect(revokes.map(collapse)).toEqual([REVOKE_STMT]);
    expect(grants.map(collapse)).toEqual([GRANT_STMT]);
  });
});

describe("159 row 20: feed_poll_stale", () => {
  it("the marker comment names the 2026-11-05 evidence and the new rule", () => {
    for (const word of ["BHA", "107 minutes", "09:25", "11:12", "60 minutes", "warn / 1", "159"]) {
      expect(row20_159, word).toContain(word);
    }
  });

  it("still reads active sources with no quarantine marker, and counts the ones not polled for 30 minutes", () => {
    const body = collapse(row20_159);
    expect(body).toContain("from public.sources x where x.active and x.fetch_quarantined_until is null");
    expect(body).toContain("x.fetch_last_at < pg_catalog.now() - interval '30 minutes'");
    expect(body).toContain("threshold := 3");
  });

  it("counts the feeds last polled more than 60 minutes ago in a fifth aggregate and a fifth local", () => {
    const body = collapse(row20_159);
    expect(body).toContain("f_old numeric;");
    expect(body).toContain("pg_catalog.count(*) filter (where x.fetch_last_at < pg_catalog.now() - interval '60 minutes')::numeric");
    expect(body).toContain("into f_total, f_stale, f_old, f_never, f_list");
  });

  it("status: fail at 3 stale feeds or at one feed over 60 minutes, else warn at 1, else pass", () => {
    expect(collapse(row20_159)).toContain(
      "status := case when f_stale >= 3 or f_old >= 1 then 'fail' when f_stale >= 1 then 'warn' else 'pass' end;",
    );
    expect(collapse(row20_158)).toContain("status := case when f_stale >= 3 then 'fail' when f_stale >= 1 then 'warn' else 'pass' end;");
  });

  it("observed stays the 30-minute count, and the detail expression is 158's, character for character", () => {
    const detail = (s: string): string => {
      const at = s.indexOf("detail := substr(");
      return s.slice(at, s.indexOf("1, 500);", at) + "1, 500);".length);
    };
    expect(detail(row20_159).length).toBeGreaterThan(300);
    expect(detail(row20_159)).toBe(detail(row20_158));
    expect(collapse(row20_159)).toContain("observed := f_stale;");
  });

  it("answers 'unknown' with the first 200 characters of the error if the read fails, and only reads", () => {
    const body = collapse(row20_159);
    expect(body).toContain("exception when others then status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);");
    const outside = wordsOf(blankStrings(row20_159.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")));
    for (const w of ["insert", "update", "delete", "truncate", "drop", "alter", "create", "perform", "execute"]) {
      expect(outside, w).not.toContain(w);
    }
  });

  it("selects no column that could carry a secret or a url (slug and fetch_last_at only)", () => {
    const outside = wordsOf(blankStrings(row20_159.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")));
    for (const w of ["rss_url", "url", "fetch_etag", "fetch_body_hash", "fetch_last_modified"]) {
      expect(outside, w).not.toContain(w);
    }
    expect(outside).toContain("fetch_last_at");
    expect(outside).toContain("slug");
  });
});

describe("159 function comment", () => {
  it("is 158's text with the migration list ending 158, 159 and the fail rule of feed_poll_stale widened, nothing else", () => {
    const c158 = commentText(raw158.slice(raw158.lastIndexOf("comment on function public.ops_health_report() is")));
    const c159 = commentText(raw.slice(raw.lastIndexOf("comment on function public.ops_health_report() is")));
    expect(c158.startsWith(COMMENT_PREFIX_158)).toBe(true);
    expect(c159.startsWith(COMMENT_PREFIX_159)).toBe(true);
    expect(c158.split(FAIL_PHRASE_158).length - 1).toBe(1);
    const expected = c158.replace(COMMENT_PREFIX_158, COMMENT_PREFIX_159).replace(FAIL_PHRASE_158, FAIL_PHRASE_159);
    expect(c159).toBe(expected);
  });

  it("still says service_role only, never reads a secret-bearing pg_cron field, and points at docs/ops-heartbeat.md", () => {
    const c = commentText(raw.slice(raw.lastIndexOf("comment on function public.ops_health_report() is")));
    expect(c).toContain("service_role only");
    expect(c).toContain("never reads any potentially secret-bearing pg_cron job field");
    expect(c).toContain("docs/ops-heartbeat.md");
  });
});

describe("159 docs/ops-heartbeat.md", () => {
  let doc = "";
  beforeAll(() => {
    doc = readFileSync(DOC_OPS_HEARTBEAT, "utf8");
  });

  it("row 20 states the 60-minute fail rule next to the 30-minute count, and names migration 159", () => {
    const at = doc.indexOf("| 20 | `feed_poll_stale`");
    expect(at).toBeGreaterThan(doc.indexOf("| 19 | `cron_jobs_stalled`"));
    const row = doc.slice(at, doc.indexOf("\n", at));
    for (const word of ["sources.fetch_last_at", "30 minutes", "60 minutes", "fail", "warn", "BHA", "157", "159", "fetch_quarantined_until"]) {
      expect(row, word).toContain(word);
    }
    expect(row).toContain("fail >= 3 or any feed over 60 minutes");
  });

  it("documents the two new ingest_cycles columns", () => {
    for (const c of COLUMNS) expect(doc, c).toContain(c);
  });
});

describe("159 docs/migration-guide.md", () => {
  let section = "";
  beforeAll(() => {
    const guide = readFileSync(DOC_MIGRATION_GUIDE, "utf8");
    const at = guide.indexOf("\n## 159");
    expect(at, "the ## 159 section").toBeGreaterThan(0);
    const next = guide.indexOf("\n## ", at + 1);
    section = guide.slice(at, next < 0 ? guide.length : next);
  });

  it("has Why, What, Order, Verify and Rollback", () => {
    for (const word of ["Why", "What", "Order", "Verify", "Rollback"]) {
      expect(section, word).toContain(word);
    }
  });

  it("says to apply 159 before deploying ingest, names the deploy with --no-verify-jwt, and why the reverse costs the 157 counters", () => {
    expect(section).toContain("apply 159 before deploying ingest");
    expect(section).toContain("supabase functions deploy ingest --no-verify-jwt");
    expect(section).toMatch(/PGRST204|42703/);
  });

  it("verifies the columns, the 20 rows, row 20, the fingerprint and the ledger", () => {
    for (const word of ["stale_deferred", "oldest_stale_min", "ops_health_report()", "feed_poll_stale", "schema_migrations", "expect 20", "md5"]) {
      expect(section, word).toContain(word);
    }
  });

  it("has a rollback that re-runs only 158's report section and drops only the two columns", () => {
    expect(section).toContain("Rollback");
    expect(section).toContain("158_saved_clusters_v3.sql");
    expect(section).toContain("drop column if exists stale_deferred");
    expect(section).toContain("drop column if exists oldest_stale_min");
    expect(section).toContain("version = '159'");
  });
});

describe("159 live manifest", () => {
  it("builds 159's database: 150's dry-run, 041, 157, then 159 applied twice", () => {
    const lines = readFileSync(LIVE_MANIFEST, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("run | 159-ingest-stale-admission.test.ts"));
    expect(lines).toHaveLength(1);
    const setup = (lines[0] as string).split("|")[2] as string;
    const files = setup.trim().split(/\s+/);
    expect(files).toEqual([
      "tests/migrations/sql/150-ops-queue-cron-liveness-dryrun.sql",
      "supabase/migrations/041_source_fetch_state.sql",
      "supabase/migrations/157_ingest_poll_stale.sql",
      "supabase/migrations/159_ingest_stale_admission.sql",
      "supabase/migrations/159_ingest_stale_admission.sql",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Live behaviour (opt-in): row 20 against fixtures, on a throwaway Postgres with 145, 150, 157 and 159
// applied (tests/migrations/sql/live-manifest.txt). TAYF_PSQL is the psql binary and
// PGHOST/PGPORT/PGUSER/PGDATABASE select the server. Every case ends in a rollback.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))("159 columns and row 20 against fixtures (live Postgres, every case rolled back)", () => {
  assertLiveReady("159", { ledger: ["145", "150", "157", "159"], relations: ["public.ingest_cycles"], functions: ["public.ops_health_report()"] });

  function runPsql(input: string): string {
    return execFileSync(process.env.TAYF_PSQL as string, ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      input,
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8", PGOPTIONS: "-c client_min_messages=warning" },
      maxBuffer: 8 * 1024 * 1024,
    });
  }

  type Row = { status: string; observed: string; threshold: string; detail: string };

  /** Runs the fixture in begin..rollback and returns row 20 (the report itself must not raise). */
  function row20Of(fixture: string): Row {
    const out = runPsql(
      `begin;\ndelete from public.sources;\n${fixture}\nselect status, observed, threshold, detail from public.ops_health_report() where check_name = '${CHECK_20}';\nrollback;\n`,
    );
    const lines = out.split("\n").filter((l) => l.trim() !== "");
    expect(lines, out).toHaveLength(1);
    const [status, observed, threshold, ...rest] = (lines[0] as string).split("|");
    return { status: status as string, observed: observed as string, threshold: threshold as string, detail: rest.join("|") };
  }

  const polled = (slug: string, minutes: number, extra = "") =>
    `insert into public.sources (slug, name, active, kind, fetch_last_at) values ('${slug}', '${slug}', true, 'outlet', now() - interval '${minutes} minutes');\n${extra}`;

  beforeAll(() => {
    const out = runPsql(
      `select (select count(*) from public.ops_health_report()) || '|' || (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'ingest_cycles' and column_name in ('stale_deferred', 'oldest_stale_min') and data_type = 'integer' and is_nullable = 'YES' and column_default is null);`,
    ).trim();
    const [rows, cols] = out.split("|");
    expect(rows).toBe("20");
    expect(cols).toBe("2");
  });

  it("returns 20 rows; row 20 is feed_poll_stale, last, and the other 19 keep 158's names and order", () => {
    const out = runPsql("select check_name from public.ops_health_report();").split("\n").filter(Boolean);
    expect(out).toHaveLength(20);
    expect(out[19]).toBe(CHECK_20);
    expect(out[17]).toBe("queue_lag");
    expect(out[18]).toBe("cron_jobs_stalled");
  });

  it("no source at all: pass, observed 0, threshold 3", () => {
    const r = row20Of("");
    expect(r.status).toBe("pass");
    expect(r.observed).toBe("0");
    expect(r.threshold).toBe("3");
    expect(r.detail).toBe("aktif kaynakların hepsi son 30 dakikada yoklandı (0)");
  });

  it("one feed 61 minutes stale: FAIL (it pages), observed 1, detail unchanged", () => {
    const r = row20Of(polled("bha", 61) + polled("birgun", 1));
    expect(r.status).toBe("fail");
    expect(r.observed).toBe("1");
    expect(r.threshold).toBe("3");
    expect(r.detail).toBe("30 dakikadır yoklanmayan aktif kaynak 1: bha 61 dk");
  });

  it("one feed 31 minutes stale: warn, observed 1", () => {
    const r = row20Of(polled("bha", 31) + polled("birgun", 1));
    expect(r.status).toBe("warn");
    expect(r.observed).toBe("1");
    expect(r.detail).toBe("30 dakikadır yoklanmayan aktif kaynak 1: bha 31 dk");
  });

  it("107 minutes (what BHA did on 2026-11-05) fails", () => {
    expect(row20Of(polled("bha", 107)).status).toBe("fail");
  });

  it("the boundaries: 29 minutes passes, 31 warns, 59 warns, 61 fails", () => {
    expect(row20Of(polled("a", 29)).status).toBe("pass");
    expect(row20Of(polled("a", 31)).status).toBe("warn");
    expect(row20Of(polled("a", 59)).status).toBe("warn");
    expect(row20Of(polled("a", 61)).status).toBe("fail");
  });

  it("otherwise as before: two feeds at 40 minutes warn, three fail, polled feeds pass", () => {
    expect(row20Of(polled("a", 1) + polled("b", 29)).status).toBe("pass");
    const two = row20Of(polled("a", 40) + polled("b", 45));
    expect(two.status).toBe("warn");
    expect(two.observed).toBe("2");
    const three = row20Of(polled("a", 40) + polled("b", 45) + polled("c", 50));
    expect(three.status).toBe("fail");
    expect(three.observed).toBe("3");
  });

  it("a quarantined source, however old, and an inactive one are not counted", () => {
    const quarantined = polled("dead-now", 600, "update public.sources set fetch_fail_streak = 59, fetch_quarantined_until = now() + interval '20 hours' where slug = 'dead-now';\n");
    const off = polled("off", 600, "update public.sources set active = false where slug = 'off';\n");
    const r = row20Of(quarantined + off + polled("fresh", 2));
    expect(r.status).toBe("pass");
    expect(r.observed).toBe("0");
  });

  it("a source never polled does not fail, and a future fetch_last_at is not stale", () => {
    const never = row20Of(`insert into public.sources (slug, name, active, kind, fetch_fail_streak) values ('new-feed', 'new-feed', true, 'outlet', 0);\n` + polled("fresh", 1));
    expect(never.status).toBe("pass");
    expect(never.detail).toBe("aktif kaynakların hepsi son 30 dakikada yoklandı (1) · hiç yoklanmayan: 1");
    expect(row20Of(polled("skew", -10)).status).toBe("pass");
  });

  it("the detail is cut at 500 characters", () => {
    const many = Array.from({ length: 120 }, (_, i) => polled(`stale-source-number-${i}`, 100 + i)).join("");
    const r = row20Of(many);
    expect(r.status).toBe("fail");
    expect(r.observed).toBe("120");
    expect(r.detail.length).toBeLessThanOrEqual(500);
  });

  it("the new columns accept an insert and stay nullable; 157's columns are untouched", () => {
    const out = runPsql(
      `begin;\ninsert into public.ingest_cycles (started_at, stale_deferred, oldest_stale_min, parse_deferred) values (now(), 1, 20, 2);\ninsert into public.ingest_cycles (started_at) values (now());\nselect count(*) filter (where stale_deferred is null), count(*) filter (where stale_deferred = 1 and oldest_stale_min = 20 and parse_deferred = 2) from public.ingest_cycles;\nrollback;\n`,
    ).trim();
    const [nulls, filled] = out.split("|");
    expect(Number(nulls)).toBeGreaterThanOrEqual(1);
    expect(filled).toBe("1");
  });

  it("the function that runs is the file's: md5 and length of prosrc equal the text between the $fn$ markers, and it is security definer with an empty search_path", () => {
    const body = prosrcOf(raw);
    const out = runPsql(
      `select md5(prosrc) || '|' || length(prosrc) || '|' || prosecdef || '|' || coalesce(proconfig::text, '') from pg_proc where oid = 'public.ops_health_report()'::regprocedure;`,
    ).trim();
    // proconfig prints as {"search_path=\"\""}: the one setting, an empty search_path
    expect(out).toBe(`${createHash("md5").update(body).digest("hex")}|${body.length}|true|{"search_path=\\"\\""}`);
  });

  it("is idempotent: the ledger holds one 159 row and the function stayed service_role only", () => {
    const out = runPsql(
      `select (select count(*) from supabase_migrations.schema_migrations where version = '159') || '|' || has_function_privilege('anon', 'public.ops_health_report()', 'execute') || '|' || has_function_privilege('authenticated', 'public.ops_health_report()', 'execute') || '|' || has_function_privilege('service_role', 'public.ops_health_report()', 'execute');`,
    ).trim();
    expect(out).toBe("1|false|false|true");
  });
});
