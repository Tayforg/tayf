import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 193 ("net-response-compact-16mb"), h112-dbgrowth-1.
//
// net._http_response (pg_net's response log) held 40.9 MB of heap for 768 live rows (about 1.3 MB of data)
// because ops_net_response_compact() truncates only above 64 MiB, and the table grows about 5.9 MB a day: it
// saw-tooths between 0 and 64 MiB, about 32 MiB of dead heap on average, all of it counted in
// pg_database_size. 193 lowers the default threshold to 16 MiB with `create or replace` (the argument stays,
// only its default changes) so the next 15-minute tick returns about 40 MB. The body is migration 100's,
// byte for byte, except the coalesce fallback (64 -> 16 MiB). The cron job, the report's net_response_heap_mb
// row and its Turkish detail text are not touched.
//
// This file pins: the production fingerprint of the function 193 replaces (md5 of the body between the $fn$
// markers == migration 100's, the latest definition before 193), the body diff against 100 (exactly the
// fallback), the grants, that the cron job is not redefined, that the readers of net._http_response still
// look back at most 30 minutes (so a truncate costs them nothing more than the 30-minute blind window 100
// already accepted), the ledger pattern, the docs and the dry run. The live block at the end runs the real
// function through psql when TAYF_PSQL is set (tests/migrations/sql/live-manifest.txt builds the database).
//
// SQL is scanned by character or by plain substring, never with a nested-quantifier regex (CodeQL).
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const MIGRATION_193 = resolve(MIGRATIONS_DIR, "193_net_response_compact_16mb.sql");
const MIGRATION_100 = resolve(MIGRATIONS_DIR, "100_pgnet_bloat_guard.sql");
const DOC_MIGRATION_GUIDE = resolve(ROOT, "docs", "migration-guide.md");
const DRYRUN = resolve(__dirname, "sql", "193-net-response-compact-16mb-dryrun.sql");
const MANIFEST = resolve(__dirname, "sql", "live-manifest.txt");

/** What production's ops_net_response_compact was on 2026-11-11 (read-only, pg_proc): migration 100's body. */
const PROD_BODY_MD5 = "1177f2c28709eae53292ca192b9c812f";
const PROD_BODY_LENGTH = 1567;
const PROD_ACL = "{postgres=X/postgres,service_role=X/postgres}";

const REVOKE = "revoke all on function public.ops_net_response_compact(bigint) from public, anon, authenticated;";
const GRANT = "grant execute on function public.ops_net_response_compact(bigint) to service_role;";
const MIB_64 = "64 * 1024 * 1024";
const MIB_16 = "16 * 1024 * 1024";

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

/** Empties every single-quoted literal (comment texts, messages and the privilege names inside strings are not code). */
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
const md5 = (s: string): string => createHash("md5").update(s, "utf8").digest("hex");

/** The text between the `$fn$` markers of the last definition of `public.<fn>(` in the text (what pg_proc.prosrc holds). */
function prosrc(sql: string, fn: string): string {
  const at = sql.lastIndexOf(`create or replace function public.${fn}(`);
  expect(at, `create line of ${fn}`).toBeGreaterThanOrEqual(0);
  const open = sql.indexOf("as $fn$", at);
  expect(open, `$fn$ opening of ${fn}`).toBeGreaterThan(at);
  const bodyStart = open + "as $fn$".length;
  const close = sql.indexOf("$fn$", bodyStart);
  expect(close, `$fn$ closing of ${fn}`).toBeGreaterThan(bodyStart);
  return sql.slice(bodyStart, close);
}

/** Everything from the create line to `as $fn$` of the last definition: signature, return type, attributes. */
function header(sql: string, fn: string): string {
  const at = sql.lastIndexOf(`create or replace function public.${fn}(`);
  expect(at, `create line of ${fn}`).toBeGreaterThanOrEqual(0);
  return sql.slice(at, sql.indexOf("as $fn$", at));
}

/** Every migration (number, file, text) in number order. */
function allMigrations(): Array<{ num: number; file: string; raw: string; code: string }> {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
    .map((file) => {
      const raw = readFileSync(resolve(MIGRATIONS_DIR, file), "utf8");
      return { num: parseInt(file, 10), file, raw, code: stripComments(raw) };
    });
}

describe("migration 193_net_response_compact_16mb.sql (SQL contract)", () => {
  let raw = "";
  let code = "";
  let statements: string[] = [];
  let raw100 = "";
  let code100 = "";

  beforeAll(() => {
    expect(existsSync(MIGRATION_193), "193_net_response_compact_16mb.sql must exist").toBe(true);
    raw = readFileSync(MIGRATION_193, "utf8");
    code = stripComments(raw);
    statements = splitStatements(code);
    raw100 = readFileSync(MIGRATION_100, "utf8");
    code100 = stripComments(raw100);
  });

  it("sanity: comment stripping is non-vacuous (the header says DEPLOY, the code does not)", () => {
    expect(raw).toMatch(/DEPLOY/);
    expect(code).not.toMatch(/DEPLOY/);
  });

  it("is one transaction, the ledger row in the 095 pattern, nothing else after the grants", () => {
    expect(statements[0]).toBe("begin");
    expect(statements[statements.length - 1]).toBe("commit");
    expect(collapse(statements[statements.length - 2] as string)).toBe(
      "insert into supabase_migrations.schema_migrations (version, name) values ('193', '193_net_response_compact_16mb') on conflict do nothing",
    );
  });

  it("runs exactly these statements, in this order: the function, its comment, revoke, grant, ledger", () => {
    const shape = statements.map((s) => collapse(s).split(" ").slice(0, 2).join(" "));
    expect(shape).toEqual(["begin", "create or", "comment on", "revoke all", "grant execute", "insert into", "commit"]);
    expect(/^create or replace function (public\.[a-z_]+)\(/.exec(statements[1] as string)?.[1]).toBe(
      "public.ops_net_response_compact",
    );
  });

  it("is additive: nothing dropped, altered, truncated at apply time, deleted, scheduled or rewritten; no table, index, policy or trigger", () => {
    // the TRUNCATE that exists is inside the function body (dollar quoted), never a top-level statement
    for (const s of statements) {
      const first = collapse(s).split(" ")[0];
      expect(["begin", "create", "comment", "revoke", "grant", "insert", "commit"], s.slice(0, 60)).toContain(first);
    }
    const outsideBody = blankStrings(statements.filter((s) => !s.startsWith("create or replace function")).join(";\n"));
    for (const forbidden of ["drop ", "alter ", "truncate ", "delete ", "update ", "cron.", "vacuum", "concurrently"]) {
      expect(outsideBody.toLowerCase(), forbidden).not.toContain(forbidden);
    }
    expect(statements.filter((s) => s.startsWith("insert"))).toHaveLength(1);
    // only this one function is created
    expect(statements.filter((s) => s.startsWith("create"))).toHaveLength(1);
  });

  it("does not redefine cron job 50: no cron.schedule / unschedule / alter_job here, and the job (100) still calls the function with no arguments", () => {
    // string literals blanked: the function comment may name the job and cron.job as text
    expect(blankStrings(code)).not.toMatch(/cron\./i);
    expect(blankStrings(code)).not.toMatch(/net-response-compact/);
    // 100 schedules it; no later migration touches the job
    // (a statement that calls cron.schedule / unschedule / alter_job AND names the job; 150 only lists the job name in
    // public.ops_cron_expected, a data row that watches it)
    const scheduling = allMigrations().filter((m) =>
      splitStatements(m.code).some(
        (s) =>
          s.includes("net-response-compact") &&
          (s.includes("cron.schedule") || s.includes("cron.unschedule") || s.includes("cron.alter_job")),
      ),
    );
    expect(scheduling.map((m) => m.num)).toEqual([100]);
    // the job's whole command: the call has an empty argument list, so the new default is what it runs
    expect(code100).toContain("$sql$ set statement_timeout = '90s'; select public.ops_net_response_compact(); $sql$");
    expect(code100).toContain("'*/15 * * * *'");
  });

  // ---- the function is 100's, with one number changed -------------------------------------------

  it("the latest migration that defines ops_net_response_compact before 193 is 100 (the file the header and this test compare against)", () => {
    const defining = allMigrations()
      .filter((m) => m.code.includes("function public.ops_net_response_compact("))
      .map((m) => m.num);
    expect(defining).toEqual([100, 193]);
  });

  it("the body of 100's function is the production body: md5 and length recorded in the header", () => {
    const body = prosrc(raw100, "ops_net_response_compact");
    expect(body.length).toBe(PROD_BODY_LENGTH);
    expect(md5(body)).toBe(PROD_BODY_MD5);
    expect(raw).toContain(PROD_BODY_MD5);
    expect(raw).toContain(`length ${PROD_BODY_LENGTH}`);
    expect(raw).toContain(PROD_ACL);
    expect(raw).toContain("select md5(prosrc)");
    expect(raw).toContain("p_max_bytes bigint DEFAULT ((64 * 1024) * 1024)");
  });

  it("the latest create of ops_net_response_compact across supabase/migrations has default 16 * 1024 * 1024 and the 16 MiB coalesce fallback", () => {
    const defining = allMigrations().filter((m) => m.code.includes("function public.ops_net_response_compact("));
    const latest = defining[defining.length - 1]!;
    expect(latest.num).toBe(193);
    const h = collapse(header(latest.code, "ops_net_response_compact"));
    expect(h).toContain(`function public.ops_net_response_compact(p_max_bytes bigint default ${MIB_16}) returns text`);
    expect(h).not.toContain(MIB_64);
    const body = collapse(prosrc(latest.code, "ops_net_response_compact"));
    expect(body).toContain(`v_max bigint := greatest(coalesce(p_max_bytes, ${MIB_16}), 1024 * 1024);`);
    expect(body).not.toContain(MIB_64);
  });

  it("keeps the signature (one bigint argument, so the create or replace is the same function), returns text, language plpgsql", () => {
    const h = collapse(header(code, "ops_net_response_compact"));
    expect(h).toMatch(/^create or replace function public\.ops_net_response_compact\(p_max_bytes bigint default 16 \* 1024 \* 1024\)/);
    expect(h).toMatch(/\breturns text\b/);
    expect(h).toMatch(/\blanguage plpgsql\b/);
    // a default may be changed with create or replace; removing it is not allowed, and this keeps it
    expect(h).toContain("default");
  });

  it("is SECURITY DEFINER with an empty search_path, exactly as 100 declares it", () => {
    const h = collapse(header(code, "ops_net_response_compact"));
    expect(h).toMatch(/\bsecurity definer\b/);
    expect(h).toMatch(/\bset search_path = ''/);
    expect(collapse(header(code, "ops_net_response_compact"))).toBe(
      collapse(header(code100, "ops_net_response_compact")).replace(MIB_64, MIB_16),
    );
  });

  it("keeps the 1 MiB floor, the advisory lock, lock_timeout '20s', the lock_not_available handler and a truncate guarded by v_size > v_max", () => {
    const body = collapse(prosrc(code, "ops_net_response_compact"));
    expect(body).toContain("greatest(coalesce(p_max_bytes, 16 * 1024 * 1024), 1024 * 1024)");
    expect(body).toContain("pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('ops_net_response_compact', 0))");
    expect(body).toContain("set local lock_timeout = '20s';");
    expect(body).toContain("exception when lock_not_available then");
    expect(body).toContain("v_size := pg_catalog.pg_total_relation_size(v_rel);");
    // the truncate sits inside the `if v_size > v_max then` branch, and it is the only one
    const ifAt = body.indexOf("if v_size > v_max then");
    const truncAt = body.indexOf("truncate table net._http_response;");
    const elseAt = body.indexOf("else", truncAt);
    expect(ifAt).toBeGreaterThan(-1);
    expect(truncAt).toBeGreaterThan(ifAt);
    expect(elseAt).toBeGreaterThan(truncAt);
    expect(body.split("truncate table").length - 1).toBe(1);
    expect(body).toContain("v_out := 'truncated ' || pg_catalog.pg_size_pretty(v_size);");
    expect(body).toContain("v_out := 'ok ' || pg_catalog.pg_size_pretty(v_size);");
    expect(body).toContain("v_out := 'skipped: lock';");
  });

  it("the whole body is 100's with the one fallback changed (no other difference, byte for byte)", () => {
    const b100 = prosrc(raw100, "ops_net_response_compact");
    const b193 = prosrc(raw, "ops_net_response_compact");
    expect(b100.split(MIB_64).length - 1).toBe(1);
    expect(b193).toBe(b100.replace(MIB_64, MIB_16));
    expect(b193).not.toBe(b100);
    expect(b193.length).toBe(b100.length);
  });

  it("reads only schema-qualified objects (search_path is empty) and nothing but pg_net's table is truncated", () => {
    const body = prosrc(code, "ops_net_response_compact");
    expect(body).not.toMatch(/\bfrom\s+public\./i);
    // string literals blanked: 'TRUNCATE' (the privilege name) and the skip message are text, not statements
    expect(blankStrings(body).match(/\btruncate\b/gi)).toHaveLength(1);
    expect(body).toContain("truncate table net._http_response;");
  });

  it("states its comment: default 16 MiB, floored at 1 MiB, migration 193, service_role only", () => {
    const stmt = statements.find((s) => s.startsWith("comment on function public.ops_net_response_compact")) as string;
    expect(stmt).toBeDefined();
    expect(stmt).toMatch(/^comment on function public\.ops_net_response_compact\s*\(\s*bigint\s*\)\s+is\s+'/);
    expect(stmt).toContain("default 16 MiB");
    expect(stmt).toContain("floored at 1 MiB");
    expect(stmt).toContain("193");
    expect(stmt).toContain("service_role only");
    expect(stmt).not.toContain("default 64 MiB");
  });

  it("restates 100's revoke and grant lines exactly (service_role only, nothing to anon or authenticated)", () => {
    const revokes = statements.filter((s) => s.startsWith("revoke")).map(collapse);
    const grants = statements.filter((s) => s.startsWith("grant")).map(collapse);
    expect(revokes).toEqual([REVOKE.slice(0, -1)]);
    expect(grants).toEqual([GRANT.slice(0, -1)]);
    expect(raw100).toContain(REVOKE);
    expect(raw100).toContain(GRANT);
    expect(grants.join(" ")).not.toMatch(/\b(anon|authenticated)\b/i);
    expect(grants.join(" ")).toMatch(/ to service_role$/);
  });

  // ---- what reads net._http_response, and how far back --------------------------------------------

  it("the ops checks that read net._http_response look back at most 30 minutes (the newest ops_health_report definition), so a truncate costs them only the blind window 100 accepted", () => {
    const withReport = allMigrations().filter((m) => m.code.includes("create or replace function public.ops_health_report()"));
    const newest = withReport[withReport.length - 1]!;
    const body = prosrc(newest.code, "ops_health_report");
    // every `from net._http_response` is followed by a created-window of 30 minutes before the next `$q$`
    const reads: number[] = [];
    let from = 0;
    for (;;) {
      const at = body.indexOf("from net._http_response", from);
      if (at < 0) break;
      reads.push(at);
      from = at + 1;
    }
    expect(reads.length, "edge_http_errors_30m and jev_shadow_cron_failures_30m read it").toBe(2);
    for (const at of reads) {
      const end = body.indexOf("$q$", at);
      const clause = collapse(body.slice(at, end));
      expect(clause, clause).toContain("where r.created >= pg_catalog.now() - interval '30 minutes'");
      expect(clause).not.toMatch(/interval '(?!30 minutes)/);
    }
    // the third mention is the size probe of the heap row, which reads pg_total_relation_size only
    expect(body).toContain("pg_catalog.pg_total_relation_size(pg_catalog.to_regclass('net._http_response'))");
  });

  it("nothing else in the repo reads net._http_response rows: only ops_health_report() versions select from it (081's retention job deletes from it), and no script or workflow touches it", () => {
    const migrations = allMigrations();
    const readers = migrations.filter((m) => m.code.toLowerCase().includes("from net._http_response")).map((m) => m.num);
    const reporters = migrations
      .filter((m) => m.code.includes("create or replace function public.ops_health_report()"))
      .map((m) => m.num);
    expect(readers.filter((n) => !reporters.includes(n))).toEqual([81]);
    // 081's retention job DELETES from the table (older than 3 days: it never matches a row), it does not read it
    expect(readFileSync(resolve(MIGRATIONS_DIR, "081_ops_retention.sql"), "utf8")).toContain("delete from net._http_response h");
    for (const dir of [resolve(ROOT, "scripts"), resolve(ROOT, ".github", "workflows")]) {
      for (const f of readdirSync(dir)) {
        if (!/\.(mjs|js|ts|sh|ya?ml)$/.test(f)) continue;
        expect(readFileSync(resolve(dir, f), "utf8"), `${dir}/${f}`).not.toContain("_http_response");
      }
    }
  });

  it("leaves ops_health_report() alone: the net_response_heap_mb thresholds and Turkish detail text are as 100 wrote them, and 193 does not re-create the report", () => {
    expect(code).not.toContain("ops_health_report");
    const withReport = allMigrations().filter((m) => m.code.includes("create or replace function public.ops_health_report()"));
    const body = collapse(prosrc(withReport[withReport.length - 1]!.code, "ops_health_report"));
    expect(withReport[withReport.length - 1]!.num).toBeLessThan(193);
    expect(body).toContain("check_name := 'net_response_heap_mb'; threshold := 200;");
    expect(body).toContain("case when v_n > 200 then 'fail' when v_n >= 64 then 'warn' else 'pass' end;");
    expect(body).toContain("'uyarı >= 64 MB, hata > 200 MB; 15 dakikada bir küçültülür (ops_net_response_compact)'");
  });

  // ---- header and docs -------------------------------------------------------------------------

  it("header documents why, the evidence, Step 0, the blind window, the readers, deploy order, verify and rollback", () => {
    expect(raw).toMatch(/^-- 193_net_response_compact_16mb\.sql/);
    for (const needle of [
      "h112-dbgrowth-1",
      "net._http_response",
      "ops_net_response_compact",
      "16 MiB",
      "64 MiB",
      "STEP 0",
      "100_pgnet_bloat_guard.sql",
      "proacl",
      "edge_http_errors_30m",
      "jev_shadow_cron_failures_30m",
      "net_response_heap_mb",
      "uyarı >= 64 MB",
      "ops_db_size_limits",
      "DEPLOY",
      "VERIFY",
      "ROLLBACK",
      "net-response-compact",
      "DRY RUN",
      "DRYRUN 193 OK",
      "delete from supabase_migrations.schema_migrations where version = '193'",
    ]) {
      expect(raw, needle).toContain(needle);
    }
    // the blind window is stated, with the new cadence
    expect(raw).toContain("30 min");
    expect(raw).toContain("2.7 days");
  });

  it("the rollback of the header re-runs 100's function section only (default back to 64 MiB), never the report or the cron job", () => {
    const at = raw.indexOf("ROLLBACK");
    expect(at).toBeGreaterThan(0);
    const rollback = raw.slice(at, raw.indexOf("\nbegin;", at));
    expect(rollback).toContain("100_pgnet_bloat_guard.sql");
    expect(rollback).toContain("64 * 1024 * 1024");
    expect(rollback).toContain("1177f2c28709eae53292ca192b9c812f");
    expect(rollback).not.toMatch(/cron\.schedule/);
  });

  it("docs/migration-guide.md has a '## 193' section: why, what, order, verify and rollback", () => {
    const guide = readFileSync(DOC_MIGRATION_GUIDE, "utf8");
    const at = guide.indexOf("\n## 193");
    expect(at, "## 193 heading").toBeGreaterThan(0);
    const next = guide.indexOf("\n## ", at + 1);
    const section = guide.slice(at, next < 0 ? undefined : next);
    expect(section).toMatch(/^\n## 193 — .*net/);
    for (const needle of ["**Why:**", "**What 193 does**", "**Order:**", "**Verify", "**Rollback", "16 MiB", "net._http_response", "edge_http_errors_30m"]) {
      expect(section, needle).toContain(needle);
    }
    expect(section).toContain(PROD_BODY_MD5);
  });

  it("ships a local PG15 dry run that applies 100, then 193 twice, and ends with DRYRUN 193 OK", () => {
    expect(existsSync(DRYRUN), "193 dry-run sql must exist").toBe(true);
    const dry = readFileSync(DRYRUN, "utf8");
    expect(dry).toMatch(/100_pgnet_bloat_guard\.sql/);
    expect(dry.match(/193_net_response_compact_16mb\.sql/g)!.length).toBeGreaterThanOrEqual(2);
    expect(dry).toMatch(/pg_get_function_arguments/);
    expect(dry).toMatch(/ops_net_response_compact\(null\)/);
    expect(dry).toMatch(/DRYRUN 193 OK/);
  });

  it("the live manifest builds this test's database (dry run as setup, zero allowed skips)", () => {
    const lines = readFileSync(MANIFEST, "utf8").split("\n");
    const entry = lines.find((l) => l.startsWith("run | 193-net-response-compact-16mb.test.ts"));
    expect(entry, "run | 193-net-response-compact-16mb.test.ts entry").toBeDefined();
    expect(entry).toContain("tests/migrations/sql/193-net-response-compact-16mb-dryrun.sql");
    expect((entry as string).trim().endsWith("| 0")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Live block (opt-in): needs the database tests/migrations/sql/live-manifest.txt builds for this file
// (the stub, a stand-in net._http_response with external TOAST storage, 100 applied, then 193 applied
// twice by the dry-run script); TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/PGDATABASE select
// the server. Every scenario that writes sits inside one transaction that is rolled back.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))("migration 193: public.ops_net_response_compact() default 16 MiB (live Postgres)", () => {
  assertLiveReady("193", {
    ledger: ["100", "193"],
    relations: ["net._http_response"],
    functions: ["public.ops_net_response_compact(bigint)"],
  });

  function runPsql(input: string): string {
    return execFileSync(process.env.TAYF_PSQL as string, ["-X", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      input,
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8" },
      maxBuffer: 8 * 1024 * 1024,
    });
  }
  const lines = (out: string, tag: string): string[] =>
    out.split("\n").filter((l) => l.startsWith(`${tag}|`)).map((l) => l.slice(tag.length + 1));

  /** SQL that grows net._http_response to at least `mib` MiB of total relation size (the stand-in's text column is EXTERNAL: no compression). */
  const fill = (mib: number): string =>
    `do $f$ begin
       loop
         exit when pg_catalog.pg_total_relation_size('net._http_response'::regclass) >= ${mib} * 1024 * 1024;
         insert into net._http_response (id, status_code, content, created)
           select g, 200, repeat('x', 8000), now() from generate_series(1, 100) g;
       end loop;
     end $f$;`;

  it("is the same function with a 16 MiB default: one overload, default 16 * 1024 * 1024, service_role only, security definer, search_path ''", () => {
    const out = runPsql(`
select 'COUNT|' || count(*) from pg_proc where proname = 'ops_net_response_compact' and pronamespace = 'public'::regnamespace;
select 'ARGS|' || pg_get_function_arguments('public.ops_net_response_compact(bigint)'::regprocedure);
select 'ATTR|' || prosecdef || '|' || proconfig::text || '|' || (select lanname from pg_language where oid = prolang)
  from pg_proc where oid = 'public.ops_net_response_compact(bigint)'::regprocedure;
select 'PRIV|' || has_function_privilege('anon', 'public.ops_net_response_compact(bigint)', 'execute')
       || '|' || has_function_privilege('authenticated', 'public.ops_net_response_compact(bigint)', 'execute')
       || '|' || has_function_privilege('service_role', 'public.ops_net_response_compact(bigint)', 'execute');
select 'LEDGER|' || count(*) || '|' || min(name) from supabase_migrations.schema_migrations where version = '193';
`);
    expect(lines(out, "COUNT")).toEqual(["1"]);
    expect(lines(out, "ARGS")).toEqual(["p_max_bytes bigint DEFAULT ((16 * 1024) * 1024)"]);
    expect(lines(out, "ATTR")).toEqual(['true|{"search_path=\\"\\""}|plpgsql']);
    expect(lines(out, "PRIV")).toEqual(["false|false|true"]);
    expect(lines(out, "LEDGER")).toEqual(["1|193_net_response_compact_16mb"]);
  });

  it("applied twice leaves exactly the definition in the file (md5 of prosrc)", () => {
    const sql = readFileSync(MIGRATION_193, "utf8");
    const out = runPsql(`select 'MD5|' || md5(prosrc) || '|' || length(prosrc) from pg_proc where oid = 'public.ops_net_response_compact(bigint)'::regprocedure;`);
    const body = prosrc(sql, "ops_net_response_compact");
    expect(lines(out, "MD5")).toEqual([`${md5(body)}|${body.length}`]);
  });

  it("with no argument it truncates a table above 16 MiB and leaves one below it (the default is the 16 MiB fallback)", () => {
    const out = runPsql(`
begin;
truncate table net._http_response;
${fill(10)}
select 'LOW|' || public.ops_net_response_compact();
select 'LOWROWS|' || count(*) from net._http_response;
${fill(17)}
select 'HIGH|' || public.ops_net_response_compact();
select 'HIGHROWS|' || count(*) from net._http_response;
rollback;
`);
    expect(lines(out, "LOW")[0]).toMatch(/^ok \d+ (kB|MB)$/);
    expect(Number(lines(out, "LOWROWS")[0])).toBeGreaterThan(1000);
    expect(lines(out, "HIGH")[0]).toMatch(/^truncated \d+ (kB|MB)$/);
    expect(lines(out, "HIGHROWS")).toEqual(["0"]);
  });

  it("a NULL argument falls back to 16 MiB, an explicit 64 MiB is still honoured, and 0 is floored to 1 MiB", () => {
    const out = runPsql(`
begin;
truncate table net._http_response;
${fill(20)}
select 'EXPLICIT64|' || public.ops_net_response_compact(64 * 1024 * 1024);
select 'EXPLICIT64ROWS|' || (count(*) > 0) from net._http_response;
select 'NULLARG|' || public.ops_net_response_compact(null);
select 'NULLROWS|' || count(*) from net._http_response;
${fill(2)}
select 'FLOOR|' || public.ops_net_response_compact(0);
select 'FLOORROWS|' || count(*) from net._http_response;
rollback;
`);
    expect(lines(out, "EXPLICIT64")[0]).toMatch(/^ok \d+ (kB|MB)$/);
    expect(lines(out, "EXPLICIT64ROWS")).toEqual(["true"]);
    expect(lines(out, "NULLARG")[0]).toMatch(/^truncated \d+ (kB|MB)$/);
    expect(lines(out, "NULLROWS")).toEqual(["0"]);
    expect(lines(out, "FLOOR")[0]).toMatch(/^truncated \d+ (kB|MB)$/);
    expect(lines(out, "FLOORROWS")).toEqual(["0"]);
  });

  it("left nothing behind (the fixture transactions were rolled back)", () => {
    const out = runPsql(`select 'LEFT|' || count(*) from net._http_response;`);
    expect(lines(out, "LEFT")).toEqual(["0"]);
  });
});
