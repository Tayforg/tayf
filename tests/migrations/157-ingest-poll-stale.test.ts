import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 157 ("ingest-poll-stale"), h36-pipeline-1.
//
// BHA (an opposition wire, 4.25 MB for 1000 items) went unpolled for hours because the
// ingest isolate item budget kept refusing it, and nothing paged: a refused feed writes no
// fetch state, and no ops row fires before 24-72 h of silence. 157 is the observability half
// of the fix (the ingest change itself is tests/functions/ingest-order.test.ts and
// tests/functions/ingest.test.ts):
//   1. ingest_cycles gets three nullable integer columns, isolate_budget_deferred,
//      parse_deferred and parse_deferred_max_streak, written by ingest's recordIngestCycle;
//   2. ops_health_report() is re-created with 150's text verbatim (rows 1-19) plus row 20,
//      `feed_poll_stale`: active sources with no quarantine marker whose fetch_last_at is
//      older than 30 minutes; warn at 1, fail at 3.
//
// This file pins the columns, rows 1-19 as 150's text (the byte identity is also pinned by
// tests/guards/ops-health-checks.test.ts), row 20's contract, the function comment, the ledger
// pattern, the header's documented evidence and deploy order, the parity with the column
// names ingest writes, and docs/ops-heartbeat.md plus docs/migration-guide.md. It is static;
// the live block at the end runs row 20 against fixtures through psql when TAYF_PSQL is set
// (tests/migrations/sql/live-manifest.txt builds the database: 150's dry-run, 041, 157 twice).
//
// SQL is scanned by character, never with a nested-quantifier regex (CodeQL).
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const MIGRATION_157 = resolve(MIGRATIONS_DIR, "157_ingest_poll_stale.sql");
const MIGRATION_150 = resolve(MIGRATIONS_DIR, "150_ops_queue_and_cron_liveness.sql");
const DOC_MIGRATION_GUIDE = resolve(ROOT, "docs", "migration-guide.md");
const DOC_OPS_HEARTBEAT = resolve(ROOT, "docs", "ops-heartbeat.md");
const INGEST_INDEX = resolve(ROOT, "supabase", "functions", "ingest", "index.ts");

const CHECK_20 = "feed_poll_stale";
const COLUMNS = ["isolate_budget_deferred", "parse_deferred", "parse_deferred_max_streak"] as const;

const CREATE_LINE = "create or replace function public.ops_health_report()";
const MARKER_20 = "-- 20. feed_poll_stale (migration 157).";
/** What follows the last row's `return next;`. */
const FN_END = "\n\n  return;\nend\n$fn$;";

const REVOKE_STMT = "revoke all on function public.ops_health_report() from public, anon, authenticated";
const GRANT_STMT = "grant execute on function public.ops_health_report() to service_role";

const COMMENT_PREFIX_150 =
  "Read-only ops heartbeat (migrations 077, 100, 103, 108, 114, 115, 119, 122, 136, 145, 150): 19 fixed rows, in this order --";
const COMMENT_PREFIX_157 =
  "Read-only ops heartbeat (migrations 077, 100, 103, 108, 114, 115, 119, 122, 136, 145, 150, 157): 20 fixed rows, in this order --";
const COMMENT_STATUS_MARK = " status is one of";

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

let raw = "";
let code = "";
let statements: string[] = [];
let raw150 = "";
let rows1to19 = "";
let fnStatement = "";
let row20 = "";

beforeAll(() => {
  raw = readFileSync(MIGRATION_157, "utf8");
  code = stripComments(raw);
  statements = splitStatements(code);
  raw150 = readFileSync(MIGRATION_150, "utf8");
  // the last occurrence: a header may quote the create line in a comment
  const from150 = raw150.lastIndexOf(CREATE_LINE);
  const end150 = raw150.indexOf(FN_END, from150);
  rows1to19 = raw150.slice(from150, end150);
  fnStatement = statements.find((s) => s.startsWith("create or replace function")) ?? "";
  const at = raw.lastIndexOf(MARKER_20);
  row20 = at < 0 ? "" : raw.slice(at, raw.indexOf(FN_END, at));
});

describe("157 helpers (the scans are not vacuous)", () => {
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

describe("157 ledger and structure", () => {
  it("is one transaction: begin; first, commit; last", () => {
    expect(statements[0]).toBe("begin");
    expect(statements[statements.length - 1]).toBe("commit");
  });

  it("ends with notify pgrst, then ('157', '157_ingest_poll_stale') in the 095 pattern, then commit", () => {
    const n = statements.length;
    expect(collapse(statements[n - 3] as string)).toBe("notify pgrst, 'reload schema'");
    expect(collapse(statements[n - 2] as string)).toBe(
      "insert into supabase_migrations.schema_migrations (version, name) values ('157', '157_ingest_poll_stale') on conflict do nothing",
    );
  });

  it("is, in order: begin, the column alter, three column comments, the function, its comment, revoke, grant, notify, ledger, commit", () => {
    const heads = statements.map((s) => collapse(s).split(" ").slice(0, 3).join(" "));
    expect(heads).toEqual([
      "begin",
      "alter table public.ingest_cycles",
      "comment on column",
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
    const words = wordsOf(blankStrings(code.replace(fnStatement, "")));
    for (const w of ["drop", "truncate", "delete", "update", "schedule", "unschedule", "trigger", "index", "concurrently"]) {
      expect(words, w).not.toContain(w);
    }
  });
});

describe("157 header documents the change", () => {
  let header = "";
  beforeAll(() => {
    header = raw.slice(0, raw.indexOf("\nbegin;"));
  });

  it("names the finding, the evidence, the sections and both ways the deploy can go", () => {
    for (const word of [
      "h36-pipeline-1",
      "WHY",
      "WHAT CHANGES",
      "STEP 0",
      "bha",
      "isolate item budget",
      "PROD READOUT",
      "DEPLOY",
      "VERIFY",
      "ROLLBACK",
      "--no-verify-jwt",
    ]) {
      expect(header, word).toContain(word);
    }
  });

  it("states the deploy order and why either order is safe (ingest retries the cycle row without the new columns)", () => {
    expect(header).toContain("apply 157 first");
    expect(header).toMatch(/42703/);
    expect(header).toMatch(/PGRST204/);
    expect(header).toContain("retries the insert once without");
    expect(header).toContain("supabase functions deploy ingest --no-verify-jwt");
  });

  it("records the predicate's evaluation on production before it shipped, and why quarantined and never-polled sources are left out", () => {
    expect(header).toContain("fetch_quarantined_until is null");
    expect(header).toContain("fetch_last_at is null");
    expect(header).toContain("27");
    expect(header).toContain("171");
    expect(header).toContain("expected status on production once applied: warn");
  });

  it("has a rollback that restores 150's function and drops nothing it did not add", () => {
    const rollback = header.slice(header.indexOf("ROLLBACK"));
    expect(rollback).toContain("150_ops_queue_and_cron_liveness.sql");
    expect(rollback).toContain("drop column");
    expect(rollback).toContain("schema_migrations where version = '157'");
  });
});

describe("157 ingest_cycles columns", () => {
  let alter = "";
  beforeAll(() => {
    alter = collapse(statements[1] as string);
  });

  it("adds exactly the three nullable integer columns, if not exists, with no default and no not null", () => {
    expect(alter.startsWith("alter table public.ingest_cycles")).toBe(true);
    const adds = alter.split("add column if not exists ").slice(1).map((s) => s.replace(/,\s*$/, "").trim());
    expect(adds).toEqual(COLUMNS.map((c) => `${c} integer`));
    expect(alter).not.toContain("not null");
    expect(alter).not.toContain("default");
  });

  it("documents each column in a column comment", () => {
    const comments = statements.filter((s) => s.startsWith("comment on column"));
    expect(comments).toHaveLength(3);
    COLUMNS.forEach((c, i) => {
      const text = collapse(comments[i] as string);
      expect(text.startsWith(`comment on column public.ingest_cycles.${c} is`)).toBe(true);
      expect(text).toContain("migration 157");
      expect(text).toContain("NULL");
    });
  });

  it("matches the keys ingest writes: the same three names appear in ingest/index.ts", () => {
    const ingest = readFileSync(INGEST_INDEX, "utf8");
    for (const c of COLUMNS) expect(ingest, c).toContain(`${c}:`);
  });

  it("ingest retries the cycle row without them on a missing column (42703 or PGRST204), so the deploy order is not a hard dependency", () => {
    const ingest = readFileSync(INGEST_INDEX, "utf8");
    expect(ingest).toContain('"42703"');
    expect(ingest).toContain('"PGRST204"');
    expect(ingest).toContain("migration 157 not applied?");
  });
});

describe("157 rows 1-19 are 150's, byte for byte", () => {
  it("150's text from the create line through row 19's `return next;` is not vacuous", () => {
    expect(rows1to19.length).toBeGreaterThan(38000);
    expect(rows1to19.endsWith("  return next;")).toBe(true);
    expect(rows1to19.startsWith(CREATE_LINE)).toBe(true);
  });

  it("157 contains that text exactly once, followed by the row-20 marker, row 20 and then `  return;\\nend\\n$fn$;`", () => {
    const first = raw.indexOf(rows1to19);
    expect(first).toBeGreaterThan(0);
    expect(raw.indexOf(rows1to19, first + 1)).toBe(-1);
    const rest = raw.slice(first + rows1to19.length);
    expect(rest.startsWith(`\n\n  ${MARKER_20}`)).toBe(true);
    expect(rest.includes(FN_END)).toBe(true);
    expect(rest.slice(rest.indexOf(FN_END)).startsWith(`${FN_END}\n\ncomment on function`)).toBe(true);
  });

  it("the literal check names are 150's sixteen (the three per-zone rows are built in a loop) followed by feed_poll_stale, which is last", () => {
    const names150 = [...stripComments(rows1to19).matchAll(/check_name\s*:=\s*'([a-z0-9_]+)'\s*;/gi)].map((m) => m[1]);
    const names157 = [...stripComments(fnStatement).matchAll(/check_name\s*:=\s*'([a-z0-9_]+)'\s*;/gi)].map((m) => m[1]);
    expect(names150).toHaveLength(16);
    expect(names150.slice(-2)).toEqual(["queue_lag", "cron_jobs_stalled"]);
    expect(names157).toEqual([...names150, CHECK_20]);
    expect(stripComments(fnStatement)).toMatch(/check_name\s*:=\s*'ingest_fresh_'\s*\|\|\s*v_zone\s*\|\|\s*'_min'/i);
  });

  it("keeps 150's header (security definer, volatile, search_path = '', returns table)", () => {
    const h = collapse(fnStatement.slice(0, fnStatement.indexOf("$fn$")));
    expect(h).toContain("returns table (check_name text, status text, observed numeric, threshold numeric, detail text)");
    expect(h).toContain("language plpgsql volatile security definer set search_path = ''");
  });

  it("the function body has no $fn$ of its own and the file has exactly the opening and the closing $fn$", () => {
    expect(raw.split("$fn$")).toHaveLength(3);
  });

  it("the word 'grant' never appears in the function body, comments included (the anon-surface guard scans bodies for it)", () => {
    const open = raw.indexOf("$fn$");
    const close = raw.indexOf("$fn$", open + 4);
    const words = wordsOf(raw.slice(open + 4, close));
    expect(words).not.toContain("grant");
    expect(words).not.toContain("grants");
    expect(wordsOf(row20)).not.toContain("grant");
  });
});

describe("157 row 20: feed_poll_stale", () => {
  let seg = "";
  let codeSeg = "";
  beforeAll(() => {
    seg = collapse(row20);
    codeSeg = collapse(stripComments(row20));
  });

  it("is the last check: marker comment first, then the fixed preamble and its own locals, one `return next;`", () => {
    expect(row20.startsWith(MARKER_20)).toBe(true);
    expect(codeSeg.startsWith("check_name := 'feed_poll_stale'; threshold := 3; observed := null; detail := null;")).toBe(true);
    expect(codeSeg).toContain("declare f_total numeric; f_stale numeric; f_never numeric; f_list text; begin");
    expect(row20.endsWith("  return next;")).toBe(true);
    expect(row20.split("return next;")).toHaveLength(2);
  });

  it("the marker comment names the evidence: BHA, the 2026-11-05 readout, the refused feed that writes no fetch state, the public slugs", () => {
    const marker = row20.slice(0, row20.indexOf("\n"));
    for (const word of ["BHA", "2026-11-05", "writes no fetch state", "quarantine", "never polled", "Warn at 1, fail at 3", "public"]) {
      expect(marker, word).toContain(word);
    }
  });

  it("reads active sources with no quarantine marker, and counts those whose fetch_last_at is older than 30 minutes", () => {
    expect(codeSeg).toContain("from public.sources x where x.active and x.fetch_quarantined_until is null");
    expect(codeSeg).toContain("count(*) filter (where x.fetch_last_at < pg_catalog.now() - interval '30 minutes')::numeric");
  });

  it("does not count a never-polled source as stale (null < x is not true) but names it, and counts the polled ones as the total", () => {
    expect(codeSeg).toContain("count(*) filter (where x.fetch_last_at is not null)::numeric");
    expect(codeSeg).toContain("count(*) filter (where x.fetch_last_at is null)::numeric");
    expect(codeSeg).toContain("' · hiç yoklanmayan: '");
    // never-polled sources take no part in the status
    expect(codeSeg).toMatch(/status := case when f_stale >= 3 then 'fail' when f_stale >= 1 then 'warn' else 'pass' end;/);
    expect(codeSeg).not.toMatch(/status[^;]*f_never/);
    expect(codeSeg).toContain("observed := f_stale;");
  });

  it("status: fail at 3 stale sources or more, warn at 1 or 2, else pass; threshold 3", () => {
    expect(codeSeg).toContain("threshold := 3");
    expect(codeSeg).toContain("when f_stale >= 3 then 'fail' when f_stale >= 1 then 'warn' else 'pass'");
  });

  it("detail: Turkish, the stale slugs with the minutes since the last poll, oldest first, cut at 500 characters", () => {
    expect(codeSeg).toContain("string_agg(coalesce(x.slug, '?') || ' ' || pg_catalog.floor(extract(epoch from pg_catalog.now() - x.fetch_last_at) / 60)::text || ' dk', ', ' order by x.fetch_last_at, x.slug)");
    expect(codeSeg).toContain("'30 dakikadır yoklanmayan aktif kaynak '");
    expect(codeSeg).toContain("'aktif kaynakların hepsi son 30 dakikada yoklandı ('");
    expect(codeSeg).toContain("1, 500)");
  });

  it("answers 'unknown' with the first 200 characters of the error if the read fails, and only reads", () => {
    expect(codeSeg).toContain("exception when others then status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200); end;");
    const outside = wordsOf(blankStrings(stripComments(row20)));
    for (const w of ["insert", "update", "delete", "truncate", "drop", "alter", "create", "perform", "execute"]) {
      expect(outside, w).not.toContain(w);
    }
    expect(outside).toContain("sources");
  });

  it("uses only its own locals plus the OUT columns (no v_ variable of the shared declare block)", () => {
    const outside = wordsOf(blankStrings(stripComments(row20)));
    expect(outside.filter((w) => w.startsWith("v_"))).toEqual([]);
  });

  it("selects no column that could carry a secret or a url (slug and fetch_last_at only)", () => {
    for (const w of ["rss_url", "url", "fetch_etag", "fetch_body_hash", "fetch_last_modified"]) {
      expect(wordsOf(blankStrings(stripComments(row20))), w).not.toContain(w);
    }
    expect(seg).not.toContain("rss_url");
  });
});

describe("157 function comment, revoke and grant are 150's", () => {
  it("revoke all from public, anon, authenticated and execute for service_role only: 150's two statements, nothing else", () => {
    const revokes = statements.filter((s) => s.startsWith("revoke") && collapse(s).includes("function"));
    expect(revokes.map(collapse)).toEqual([REVOKE_STMT]);
    const fnGrants = statements.filter((s) => s.startsWith("grant") && collapse(s).includes("function"));
    expect(fnGrants.map(collapse)).toEqual([GRANT_STMT]);
    expect(statements.filter((s) => s.startsWith("grant"))).toHaveLength(1);
  });

  describe("comment on function", () => {
    let c150 = "";
    let c157 = "";
    let middle150 = "";
    let tail150 = "";

    beforeAll(() => {
      c150 = commentText(stripComments(raw150));
      c157 = commentText(code);
      expect(c150.startsWith(COMMENT_PREFIX_150)).toBe(true);
      const mark = c150.indexOf(COMMENT_STATUS_MARK);
      expect(mark).toBeGreaterThan(0);
      // 150's description list, without the final full stop that closes cron_jobs_stalled's description
      middle150 = c150.slice(COMMENT_PREFIX_150.length, mark - 1);
      tail150 = c150.slice(mark);
      expect(c150.charAt(mark - 1)).toBe(".");
    });

    it("is 150's text with the migration list ending 150, 157 and `20 fixed rows`", () => {
      expect(c157.startsWith(COMMENT_PREFIX_157)).toBe(true);
      expect(c157).not.toContain("19 fixed rows");
    });

    it("adds the feed_poll_stale description right before ' status is one of', after cron_jobs_stalled's, which now ends with a comma", () => {
      expect(c157.slice(COMMENT_PREFIX_157.length).startsWith(middle150 + ", feed_poll_stale (")).toBe(true);
      expect(c157.endsWith(tail150)).toBe(true);
      const description = c157.slice(COMMENT_PREFIX_157.length + middle150.length + 1, c157.length - tail150.length);
      expect(description.startsWith(" feed_poll_stale (")).toBe(true);
      expect(description.endsWith(").")).toBe(true);
      for (const word of ["public.sources", "fetch_last_at", "30 minutes", "quarantine", "warn", "fail", "unknown", "slugs", "threshold 3"]) {
        expect(description, word).toContain(word);
      }
    });

    it("still says service_role only, never reads a secret-bearing pg_cron field, and points at docs/ops-heartbeat.md", () => {
      expect(c157).toContain("service_role only");
      expect(c157).toContain("docs/ops-heartbeat.md");
      expect(c157).toContain("status is one of pass|warn|fail|unknown|skip");
      expect(c157).toContain("never reads any potentially secret-bearing pg_cron job field");
    });
  });
});

describe("157 docs/ops-heartbeat.md", () => {
  let doc = "";
  beforeAll(() => {
    doc = readFileSync(DOC_OPS_HEARTBEAT, "utf8");
  });

  it("the title and the intro list 157, and the row count is 20 (21 once 161 appended its row)", () => {
    expect(doc.slice(0, doc.indexOf("\n"))).toContain("150, 157");
    expect(doc).toContain("migrations 077, 100, 103, 108, 114, 115, 119, 122, 136, 145, 150 and 157");
    // 161 appended a twenty-first row and moved these counts (tests/migrations/161-image-coverage-by-source.test.ts pins 21)
    expect(doc).toMatch(/(20|21|22) fixed-order rows/);
    expect(doc).not.toContain("19 fixed-order rows");
    expect(doc).toMatch(/always returns exactly\n(20|21|22) rows/);
  });

  it("the table has row 20 after row 19, with its predicate, thresholds and the readout", () => {
    const at = doc.indexOf("| 20 | `feed_poll_stale`");
    expect(at).toBeGreaterThan(doc.indexOf("| 19 | `cron_jobs_stalled`"));
    const row = doc.slice(at, doc.indexOf("\n", at));
    for (const word of ["sources.fetch_last_at", "30", "quarantine", "warn", "fail", "BHA", "157", "fetch_quarantined_until"]) {
      expect(row, word).toContain(word);
    }
  });
});

describe("157 docs/migration-guide.md", () => {
  let section = "";
  beforeAll(() => {
    const guide = readFileSync(DOC_MIGRATION_GUIDE, "utf8");
    const at = guide.indexOf("\n## 157");
    expect(at, "the ## 157 section").toBeGreaterThan(0);
    const next = guide.indexOf("\n## ", at + 1);
    section = guide.slice(at, next < 0 ? guide.length : next);
  });

  it("has Why, What, Order, Verify and Rollback", () => {
    for (const word of ["Why", "What", "Order", "Verify", "Rollback"]) {
      expect(section, word).toContain(word);
    }
  });

  it("names the ingest deploy with --no-verify-jwt and says to apply 157 first, and why the reverse is still safe", () => {
    expect(section).toContain("supabase functions deploy ingest --no-verify-jwt");
    expect(section).toContain("apply 157 first");
    expect(section).toMatch(/PGRST204|42703/);
  });

  it("verifies the columns, the 20 rows, row 20 and the ledger", () => {
    for (const word of ["isolate_budget_deferred", "ops_health_report()", "feed_poll_stale", "schema_migrations", "expect 20"]) {
      expect(section, word).toContain(word);
    }
  });
});

// ---------------------------------------------------------------------------
// Live behaviour (opt-in): row 20 against fixtures, on a throwaway Postgres with 145, 150 and 157
// applied (tests/migrations/sql/live-manifest.txt: 150's dry-run, 041, 157 twice). TAYF_PSQL is the
// psql binary and PGHOST/PGPORT/PGUSER/PGDATABASE select the server. Every case ends in a rollback.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))("157 column and row 20 against fixtures (live Postgres, every case rolled back)", () => {
  assertLiveReady("157", { ledger: ["145", "150", "157"], relations: ["public.ingest_cycles"], functions: ["public.ops_health_report()"] });

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

  const source = (slug: string, cols: string, vals: string) =>
    `insert into public.sources (slug, name, active, kind, ${cols}) values ('${slug}', '${slug}', true, 'outlet', ${vals});\n`;
  const polled = (slug: string, minutes: number, extra = "") =>
    `insert into public.sources (slug, name, active, kind, fetch_last_at) values ('${slug}', '${slug}', true, 'outlet', now() - interval '${minutes} minutes');\n${extra}`;

  beforeAll(() => {
    const out = runPsql(
      `select (select count(*) from public.ops_health_report()) || '|' || (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'ingest_cycles' and column_name in ('isolate_budget_deferred', 'parse_deferred', 'parse_deferred_max_streak') and data_type = 'integer' and is_nullable = 'YES' and column_default is null);`,
    ).trim();
    const [rows, cols] = out.split("|");
    expect(rows).toBe("20");
    expect(cols).toBe("3");
  });

  it("returns 20 rows; row 20 is feed_poll_stale, last, and rows 1-19 keep 150's names and order", () => {
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

  it("all sources polled within 30 minutes: pass, with the number watched", () => {
    const r = row20Of(polled("a", 1) + polled("b", 29));
    expect(r.status).toBe("pass");
    expect(r.observed).toBe("0");
    expect(r.detail).toBe("aktif kaynakların hepsi son 30 dakikada yoklandı (2)");
  });

  it("BHA 171 minutes old: warn, observed 1, the slug and the age in the detail", () => {
    const r = row20Of(polled("bha", 171) + polled("birgun", 1));
    expect(r.status).toBe("warn");
    expect(r.observed).toBe("1");
    expect(r.detail).toBe("30 dakikadır yoklanmayan aktif kaynak 1: bha 171 dk");
  });

  it("the boundary: 29 minutes passes, 31 minutes warns", () => {
    expect(row20Of(polled("a", 29)).status).toBe("pass");
    expect(row20Of(polled("a", 31)).status).toBe("warn");
  });

  it("two stale feeds warn, three fail; the detail lists them oldest first", () => {
    const two = row20Of(polled("a", 40) + polled("b", 90));
    expect(two.status).toBe("warn");
    expect(two.observed).toBe("2");
    expect(two.detail).toBe("30 dakikadır yoklanmayan aktif kaynak 2: b 90 dk, a 40 dk");
    const three = row20Of(polled("a", 40) + polled("b", 90) + polled("c", 300));
    expect(three.status).toBe("fail");
    expect(three.observed).toBe("3");
    expect(three.detail).toBe("30 dakikadır yoklanmayan aktif kaynak 3: c 300 dk, b 90 dk, a 40 dk");
  });

  it("a quarantined source is not counted, nor one whose quarantine just expired and waits for its probe", () => {
    const future = polled("dead-now", 600, "update public.sources set fetch_fail_streak = 59, fetch_quarantined_until = now() + interval '20 hours' where slug = 'dead-now';\n");
    const expired = polled("probe-due", 1500, "update public.sources set fetch_fail_streak = 59, fetch_quarantined_until = now() - interval '1 minute' where slug = 'probe-due';\n");
    const r = row20Of(future + expired + polled("fresh", 2));
    expect(r.status).toBe("pass");
    expect(r.observed).toBe("0");
  });

  it("an inactive source is not counted", () => {
    const r = row20Of(polled("off", 600, "update public.sources set active = false where slug = 'off';\n"));
    expect(r.status).toBe("pass");
  });

  it("a source never polled (fetch_last_at null) does not warn, but is named in the detail", () => {
    const r = row20Of(source("new-feed", "fetch_fail_streak", "0") + polled("fresh", 1));
    expect(r.status).toBe("pass");
    expect(r.observed).toBe("0");
    expect(r.detail).toBe("aktif kaynakların hepsi son 30 dakikada yoklandı (1) · hiç yoklanmayan: 1");
  });

  it("a future fetch_last_at (clock skew) is not stale", () => {
    const r = row20Of(polled("skew", -10));
    expect(r.status).toBe("pass");
  });

  it("the detail is cut at 500 characters", () => {
    const many = Array.from({ length: 120 }, (_, i) => polled(`stale-source-number-${i}`, 100 + i)).join("");
    const r = row20Of(many);
    expect(r.status).toBe("fail");
    expect(r.observed).toBe("120");
    expect(r.detail.length).toBeLessThanOrEqual(500);
  });

  it("the new columns accept an insert and stay nullable", () => {
    const out = runPsql(
      `begin;\ninsert into public.ingest_cycles (started_at, isolate_budget_deferred, parse_deferred, parse_deferred_max_streak) values (now(), 2, 3, 4);\ninsert into public.ingest_cycles (started_at) values (now());\nselect count(*) filter (where isolate_budget_deferred is null), count(*) filter (where parse_deferred = 3 and parse_deferred_max_streak = 4) from public.ingest_cycles;\nrollback;\n`,
    ).trim();
    const [nulls, filled] = out.split("|");
    expect(Number(nulls)).toBeGreaterThanOrEqual(1);
    expect(filled).toBe("1");
  });

  it("is idempotent: the ledger holds one 157 row and the function stayed service_role only", () => {
    const out = runPsql(
      `select (select count(*) from supabase_migrations.schema_migrations where version = '157') || '|' || has_function_privilege('anon', 'public.ops_health_report()', 'execute') || '|' || has_function_privilege('authenticated', 'public.ops_health_report()', 'execute') || '|' || has_function_privilege('service_role', 'public.ops_health_report()', 'execute');`,
    ).trim();
    expect(out).toBe("1|false|false|true");
  });
});
