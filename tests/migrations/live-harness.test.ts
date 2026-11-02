import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCAL_NETWORKS, SUPABASE_SCHEMAS } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Static guard for the live-Postgres migration tests (h29-tests-1).
//
// The live blocks (describe.runIf on TAYF_PSQL, 308 tests) used to depend on a
// stub schema that lived outside the repo, and CI had no Postgres job, so a
// broken live block only ever showed as "skipped". The harness now is:
//
//   tests/migrations/sql/stub.sql          the throwaway schema stub (tracked)
//   tests/migrations/sql/live-manifest.txt one entry per live test file
//   tests/migrations/sql/run-live.sh       builds a fresh database per file and runs it
//   tests/_helpers/live-db.ts              assertLiveReady(): FAIL, never skip, on a bad database
//   .github/workflows/ci.yml  `live-db`    runs run-live.sh against a postgres:15 service
//
// This file runs in plain `npm test` (no database) and keeps the pieces in
// step. Line and character scans only: no regular expression is applied to SQL
// text or to markup, and no pattern is built from partial escaping.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const TESTS_DIR = resolve(ROOT, "tests", "migrations");
const SQL_DIR = resolve(TESTS_DIR, "sql");
const STUB = resolve(SQL_DIR, "stub.sql");
const MANIFEST = resolve(SQL_DIR, "live-manifest.txt");
const RUNNER = resolve(SQL_DIR, "run-live.sh");
const CI = resolve(ROOT, ".github", "workflows", "ci.yml");
const SELF = "live-harness.test.ts";

// Needles are assembled from pieces so this file does not contain them itself
// (the "no machine-local path" scan below covers this file too).
const FORBIDDEN_IN_TESTS = ["/Us" + "ers/", "/priv" + "ate/tmp/", "jevtest/qa/" + "stub.sql"];

// --- plain-text helpers ------------------------------------------------------

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function countOf(haystack: string, needle: string): number {
  let n = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return n;
    n++;
    from = at + needle.length;
  }
}

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/** The source with whole-line comments dropped. */
function codeOnly(source: string): string {
  return source
    .split("\n")
    .filter((l) => !isCommentLine(l))
    .join("\n");
}

function isSpace(ch: string | undefined): boolean {
  return ch === " " || ch === "\n" || ch === "\t" || ch === "\r";
}

function isDigits(s: string): boolean {
  if (s.length === 0) return false;
  for (const ch of s) if (ch < "0" || ch > "9") return false;
  return true;
}

/**
 * Keys the runner sets itself: a manifest line must not set them (TAYF_PSQL would
 * swap the psql binary, TAYF_PG_EXTERNAL / TAYF_LIVE_* change how the runner behaves).
 */
const RUNNER_KNOBS = ["TAYF_PSQL", "TAYF_PG_EXTERNAL"];

/**
 * A manifest env key: a TAYF_ test knob (today TAYF_SHAPE). Never PG* (PGHOST,
 * PGHOSTADDR, PGSERVICE, PGPORT ... would retarget the run AFTER run-live.sh's
 * locality check), never a runner knob, never anything outside the TAYF_ prefix.
 */
function isTestEnvKey(key: string): boolean {
  if (!key.startsWith("TAYF_") || key.length === "TAYF_".length) return false;
  if (key.startsWith("TAYF_LIVE_") || RUNNER_KNOBS.includes(key)) return false;
  for (const ch of key) {
    const ok = (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "_";
    if (!ok) return false;
  }
  return true;
}

function isEnvPair(s: string): boolean {
  const eq = s.indexOf("=");
  if (eq <= 0 || eq === s.length - 1) return false;
  return isTestEnvKey(s.slice(0, eq));
}

function words(field: string): string[] {
  return field === "-" ? [] : field.split(" ").filter((w) => w.length > 0);
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

// --- manifest parser ---------------------------------------------------------

interface RunEntry {
  kind: "run";
  line: number;
  file: string;
  setup: string[];
  env: string[];
  skips: number;
}
interface PendingEntry {
  kind: "pending";
  line: number;
  file: string;
  reason: string;
}
type Entry = RunEntry | PendingEntry;

function parseManifest(text: string): { entries: Entry[]; errors: string[] } {
  const entries: Entry[] = [];
  const errors: string[] = [];
  text.split("\n").forEach((raw, idx) => {
    const line = idx + 1;
    const t = raw.trim();
    if (t === "" || t.startsWith("#")) return;
    const f = t.split(" | ").map((s) => s.trim());
    const file = f[1] ?? "";
    if (f[0] === "run") {
      if (f.length !== 5) return void errors.push(`line ${line}: run needs 5 fields, got ${f.length}`);
      const setup = words(f[2] as string);
      const env = words(f[3] as string);
      const skipsField = f[4] as string;
      if (!file.endsWith(".test.ts") || file.includes("/")) errors.push(`line ${line}: bad test file ${file}`);
      for (const e of env) if (!isEnvPair(e)) errors.push(`line ${line}: bad env pair ${e}`);
      if (!isDigits(skipsField)) errors.push(`line ${line}: allowed skips must be a number, got ${skipsField}`);
      entries.push({ kind: "run", line, file, setup, env, skips: isDigits(skipsField) ? Number(skipsField) : -1 });
    } else if (f[0] === "pending") {
      if (f.length < 3) return void errors.push(`line ${line}: pending needs 3 fields, got ${f.length}`);
      if (!file.endsWith(".test.ts") || file.includes("/")) errors.push(`line ${line}: bad test file ${file}`);
      entries.push({ kind: "pending", line, file, reason: f.slice(2).join(" | ") });
    } else {
      errors.push(`line ${line}: unknown kind ${f[0] ?? ""}`);
    }
  });
  return { entries, errors };
}

// --- discovery ---------------------------------------------------------------

const PSQL_GATE = "describe.runIf(Boolean(process.env.TAYF_PSQL))";

const testFiles = readdirSync(TESTS_DIR)
  .filter((n) => n.endsWith(".test.ts") && n !== SELF)
  .sort();

/** File name -> code lines mention TAYF_PSQL / SUPABASE_LOCAL_URL (comments do not count). */
function liveKind(name: string): { psql: boolean; supabase: boolean } {
  const code = codeOnly(read(resolve(TESTS_DIR, name)));
  return {
    psql: code.includes("process.env.TAYF_PSQL"),
    supabase: code.includes("SUPABASE_LOCAL_URL"),
  };
}

const liveFiles = testFiles.filter((n) => {
  const k = liveKind(n);
  return k.psql || k.supabase;
});
const psqlFiles = liveFiles.filter((n) => liveKind(n).psql);

const manifestText = existsSync(MANIFEST) ? read(MANIFEST) : "";
const manifest = parseManifest(manifestText);
const manifestFiles = new Set(manifest.entries.map((e) => e.file));

// --- the stub ----------------------------------------------------------------

describe("live harness: stub.sql", () => {
  it("is tracked in the repo, not a path outside it", () => {
    expect(existsSync(STUB)).toBe(true);
  });

  const stub = existsSync(STUB) ? read(STUB) : "";

  it("says it is a throwaway stub for local or CI Postgres, never applied to production, holding no secrets", () => {
    const head = stub.split("\n").slice(0, 12).join("\n").toLowerCase();
    expect(head).toContain("throwaway");
    expect(head).toContain("never applied to production");
    expect(head).toContain("no secrets");
    expect(head).toContain("run-live.sh");
  });

  it("starts with \\set ON_ERROR_STOP on, so a mistaken run can never skip a failed statement and carry on", () => {
    expect(stub.split("\n")[0]).toBe("\\set ON_ERROR_STOP on");
  });

  it("warns in its header that it must never be given a remote connection string", () => {
    const head = stub.split("\n").slice(0, 25).join("\n").toLowerCase();
    expect(head).toContain("never");
    expect(head).toContain("remote connection");
    expect(head).toContain("refuses");
  });

  it("creates the three roles behind a guard, so a shared server is not an error", () => {
    expect(stub).toContain("rolname='anon'");
    expect(stub).toContain("rolname='authenticated'");
    expect(stub).toContain("rolname='service_role'");
  });

  it("carries the stub tables the live blocks use", () => {
    for (const t of [
      "public.sources",
      "public.articles",
      "public.clusters",
      "public.cluster_articles",
      "public.article_tickers",
      "public.kap_disclosures",
      "public.article_title_versions",
      "public.bist_companies",
      "supabase_migrations.schema_migrations",
      "vault.decrypted_secrets",
    ]) {
      expect(stub, t).toContain(t);
    }
  });

  it("ends with a marked Supabase-like prelude: bypassrls, articles.created_at, permissive default privileges", () => {
    const marker = stub.indexOf("-- Supabase-like prelude");
    expect(marker).toBeGreaterThan(0);
    // the prelude comes after the stub's own tables ...
    expect(marker).toBeGreaterThan(stub.lastIndexOf("create table"));
    const prelude = stub.slice(marker).toLowerCase();
    expect(prelude).toContain("alter role service_role bypassrls");
    expect(prelude).toContain("alter table public.articles add column if not exists created_at timestamptz not null default now()");
    // scoped to the loading role explicitly (the default, but a reader should not have to know that)
    expect(prelude).toContain("alter default privileges for role current_user in schema public grant all on tables to anon, authenticated, service_role");
    expect(prelude).toContain("alter default privileges for role current_user in schema public grant all on sequences to anon, authenticated, service_role");
    expect(prelude).toContain("alter default privileges for role current_user in schema public grant execute on functions to anon, authenticated, service_role");
  });

  describe("throwaway-database guard", () => {
    const open = stub.indexOf("do $guard$");
    const close = stub.indexOf("$guard$;", open + 1);
    const guard = open >= 0 && close > open ? stub.slice(open, close) : "";

    it("is a DO block before the first statement that changes anything", () => {
      expect(open).toBeGreaterThan(0);
      expect(close).toBeGreaterThan(open);
      for (const first of ["create extension", "create schema", "create table", "create role", "alter "]) {
        const at = stub.toLowerCase().indexOf(first);
        expect(at, first).toBeGreaterThan(close);
      }
    });

    it("refuses a database that already has public.sources (the stub only loads into a fresh database)", () => {
      expect(guard).toContain("to_regclass('public.sources') is not null");
      expect(guard).toContain("raise exception");
    });

    it("refuses every Supabase-only schema, and cron as well (nothing has created a fake one yet)", () => {
      for (const schema of [...SUPABASE_SCHEMAS, "cron"]) expect(guard, schema).toContain(`'${schema}'`);
      expect(guard).toContain("pg_namespace");
    });

    it("refuses a server address outside LOCAL_NETWORKS, with the same list as live-db.ts", () => {
      expect(guard).toContain("inet_server_addr()");
      for (const net of LOCAL_NETWORKS) expect(guard, net).toContain(`'${net}'`);
    });
  });

  it("holds no secret, key or machine-local path", () => {
    expect(stub).toContain("bypassrls");
    expect(stub).toContain("created_at");
    for (const needle of ["/Us" + "ers/", "/priv" + "ate/", "eyJ", "service_role_key"]) {
      expect(stub.toLowerCase().includes(needle.toLowerCase()), needle).toBe(false);
    }
    // the vault stub is an empty table: no INSERT into it anywhere
    expect(stub.toLowerCase()).not.toContain("insert into vault");
  });
});

// --- the manifest ------------------------------------------------------------

describe("live harness: live-manifest.txt", () => {
  it("exists and every line parses", () => {
    expect(existsSync(MANIFEST)).toBe(true);
    expect(manifest.errors).toEqual([]);
    expect(manifest.entries.length).toBeGreaterThan(0);
  });

  it("names only test files and setup files that exist", () => {
    const missing: string[] = [];
    for (const e of manifest.entries) {
      if (!existsSync(resolve(TESTS_DIR, e.file))) missing.push(`line ${e.line}: ${e.file}`);
      if (e.kind === "run") {
        for (const s of e.setup) if (!existsSync(resolve(ROOT, s))) missing.push(`line ${e.line}: setup ${s}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("lets a line set only TAYF_* test knobs: never PG*, never a runner knob", () => {
    const ok = ["TAYF_SHAPE=chain", "TAYF_SHAPE=prod", "TAYF_X1=a"];
    for (const pair of ok) expect(isEnvPair(pair), pair).toBe(true);
    const bad = [
      "PGHOST=db.example.com",
      "PGHOSTADDR=203.0.113.9",
      "PGSERVICE=prod",
      "PGSERVICEFILE=/x",
      "PGPORT=6543",
      "PGUSER=postgres",
      "PGPASSFILE=/x",
      "PGOPTIONS=-c",
      "PGDATABASE=postgres",
      "NODE_OPTIONS=--require=x",
      "PATH=/x",
      "TAYF_PSQL=/bin/true",
      "TAYF_PG_EXTERNAL=1",
      "TAYF_LIVE_KEEP=1",
      "TAYF_LIVE_ONLY=140",
      "TAYF_=x",
      "TAYF_SHAPE",
      "TAYF_SHAPE=",
      "=x",
      "tayf_shape=x",
      "TAYF_SH-APE=x",
      "XTAYF_SHAPE=x",
    ];
    for (const pair of bad) expect(isEnvPair(pair), pair).toBe(false);
  });

  it("every env key a run entry sets is read by that test file as process.env.<KEY>", () => {
    const unused: string[] = [];
    for (const e of manifest.entries) {
      if (e.kind !== "run") continue;
      const src = existsSync(resolve(TESTS_DIR, e.file)) ? read(resolve(TESTS_DIR, e.file)) : "";
      for (const pair of e.env) {
        const key = pair.slice(0, pair.indexOf("="));
        if (!src.includes(`process.env.${key}`)) unused.push(`line ${e.line}: ${e.file} never reads ${key}`);
      }
    }
    expect(unused).toEqual([]);
  });

  it("lists a (file, env) pair at most once", () => {
    const seen = new Set<string>();
    const dup: string[] = [];
    for (const e of manifest.entries) {
      const key = `${e.file} ${e.kind === "run" ? [...e.env].sort().join(" ") : ""}`;
      if (seen.has(key)) dup.push(`line ${e.line}: ${key}`);
      seen.add(key);
    }
    expect(dup).toEqual([]);
  });

  it("gives every pending entry a real reason (at least 20 characters)", () => {
    const short = manifest.entries.filter((e) => e.kind === "pending" && e.reason.length < 20).map((e) => `line ${e.line}`);
    expect(short).toEqual([]);
  });

  it("allows skips only as a small number, and every setup path is repo-relative", () => {
    for (const e of manifest.entries) {
      if (e.kind !== "run") continue;
      expect(e.skips, `line ${e.line}`).toBeGreaterThanOrEqual(0);
      expect(e.skips, `line ${e.line}`).toBeLessThanOrEqual(5);
      for (const s of e.setup) {
        expect(s.startsWith("/"), `line ${e.line}: ${s}`).toBe(false);
        expect(s.includes(".."), `line ${e.line}: ${s}`).toBe(false);
      }
    }
  });

  it("runs only files that have a TAYF_PSQL block; SUPABASE_LOCAL_URL suites are pending", () => {
    const wrong: string[] = [];
    for (const e of manifest.entries) {
      const k = liveKind(e.file);
      if (e.kind === "run" && !k.psql) wrong.push(`line ${e.line}: ${e.file} has no TAYF_PSQL block`);
      if (e.kind === "run" && k.supabase) wrong.push(`line ${e.line}: ${e.file} needs SUPABASE_LOCAL_URL`);
    }
    expect(wrong).toEqual([]);
  });

  it("covers every live test file: the set of live files equals the set of manifest files", () => {
    const live = [...liveFiles].sort();
    const listed = [...manifestFiles].sort();
    expect(listed).toEqual(live);
  });
});

// --- the live blocks ---------------------------------------------------------

describe("live harness: assertLiveReady wiring", () => {
  it("finds the live files (the scan itself works)", () => {
    expect(psqlFiles.length).toBeGreaterThanOrEqual(25);
  });

  it("every TAYF_PSQL file imports assertLiveReady and calls it at least once per live describe", () => {
    const bad: string[] = [];
    for (const name of psqlFiles) {
      const src = read(resolve(TESTS_DIR, name));
      const gates = countOf(src, PSQL_GATE);
      const calls = countOf(src, "assertLiveReady(");
      if (gates === 0) bad.push(`${name}: no ${PSQL_GATE}`);
      if (calls < gates) bad.push(`${name}: ${calls} assertLiveReady( for ${gates} live describe(s)`);
      if (!src.includes('import { assertLiveReady } from "../_helpers/live-db";')) bad.push(`${name}: missing import`);
    }
    expect(bad).toEqual([]);
  });

  it("assertLiveReady is the first statement in the body of every live describe", () => {
    const bad: string[] = [];
    for (const name of psqlFiles) {
      const src = read(resolve(TESTS_DIR, name));
      let from = 0;
      for (;;) {
        const gate = src.indexOf(PSQL_GATE, from);
        if (gate < 0) break;
        from = gate + PSQL_GATE.length;
        const arrow = src.indexOf("=> {", from);
        if (arrow < 0) {
          bad.push(`${name}: no body after the live describe`);
          break;
        }
        // skip whitespace and whole-line comments
        let i = arrow + "=> {".length;
        for (;;) {
          while (isSpace(src[i])) i++;
          if (src.startsWith("//", i)) {
            const nl = src.indexOf("\n", i);
            i = nl < 0 ? src.length : nl + 1;
            continue;
          }
          break;
        }
        if (!src.startsWith("assertLiveReady(", i)) bad.push(`${name}: first statement is not assertLiveReady(`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("keeps describe.runIf, so a run without a database still skips", () => {
    for (const name of psqlFiles) {
      expect(read(resolve(TESTS_DIR, name)).includes(PSQL_GATE), name).toBe(true);
    }
  });
});

// --- no machine-local paths --------------------------------------------------

describe("live harness: no machine-local path under tests/migrations", () => {
  it("no .ts or .sql file names an absolute home path, a scratchpad path or the external stub", () => {
    const hits: string[] = [];
    for (const p of listFiles(TESTS_DIR)) {
      if (!p.endsWith(".ts") && !p.endsWith(".sql")) continue;
      const src = read(p);
      for (const needle of FORBIDDEN_IN_TESTS) {
        if (src.includes(needle)) hits.push(`${p.slice(ROOT.length + 1)}: ${needle}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("every dry-run header points at the tracked stub, a mktemp data dir, and the runner", () => {
    const bad: string[] = [];
    const dryruns = readdirSync(SQL_DIR).filter((n) => n.endsWith("-dryrun.sql"));
    expect(dryruns.length).toBeGreaterThanOrEqual(12);
    for (const n of dryruns) {
      const head = read(resolve(SQL_DIR, n)).split("\n").slice(0, 40).join("\n");
      if (!head.includes("-f tests/migrations/sql/stub.sql")) bad.push(`${n}: -f tests/migrations/sql/stub.sql`);
      if (!head.includes("D=$(mktemp -d)")) bad.push(`${n}: D=$(mktemp -d)`);
      if (!head.includes("-- or: bash tests/migrations/sql/run-live.sh")) bad.push(`${n}: -- or: bash tests/migrations/sql/run-live.sh`);
    }
    expect(bad).toEqual([]);
  });
});

// --- the runner --------------------------------------------------------------

describe("live harness: run-live.sh", () => {
  const sh = existsSync(RUNNER) ? read(RUNNER) : "";

  it("exists, is executable, starts with the bash shebang and is strict", () => {
    expect(existsSync(RUNNER)).toBe(true);
    expect(sh.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(sh).toContain("set -euo pipefail");
    expect(statSync(RUNNER).mode & 0o111).not.toBe(0);
  });

  it("cleans up with a trap and supports the external (CI service) server mode", () => {
    expect(sh).toContain("trap ");
    expect(sh).toContain("TAYF_PG_EXTERNAL");
  });

  it("refuses an external server that is not local (so it can never be aimed at production)", () => {
    for (const host of ["localhost", "127.0.0.1", "::1"]) expect(sh, host).toContain(host);
    expect(sh.toLowerCase()).toContain("refus");
  });

  it("uses a unix socket only for its own server, and knows the knobs", () => {
    expect(sh).toContain("listen_addresses=''");
    for (const knob of ["PGBIN", "TAYF_LIVE_ONLY", "TAYF_LIVE_KEEP", "TAYF_PSQL"]) expect(sh, knob).toContain(knob);
  });

  it("never reads an environment file", () => {
    expect(sh.includes(".env")).toBe(false);
  });

  it("loads the tracked stub and the manifest", () => {
    expect(sh).toContain("stub.sql");
    expect(sh).toContain("live-manifest.txt");
  });

  it("checks the manifest env fields before it starts a server or reads PGBIN", () => {
    const check = sh.indexOf("valid_env_pair");
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(sh.indexOf('"$PGBIN/initdb"'));
    expect(check).toBeLessThan(sh.indexOf("if [ \"$EXTERNAL\" = \"1\" ]; then\n  [ -n \"${PGHOST"));
  });

  // Behavioral: the runner is copied into a temp tree with a made-up manifest. It dies on the manifest
  // before it needs a PostgreSQL (PGBIN points nowhere), so no database is involved.
  function runnerIn(manifest: string, env: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "run-live-harness-"));
    try {
      const sqlDir = join(dir, "tests", "migrations", "sql");
      mkdirSync(sqlDir, { recursive: true });
      copyFileSync(RUNNER, join(sqlDir, "run-live.sh"));
      writeFileSync(join(sqlDir, "stub.sql"), "-- empty\n");
      writeFileSync(join(sqlDir, "live-manifest.txt"), manifest);
      const r = spawnSync("bash", [join(sqlDir, "run-live.sh")], {
        encoding: "utf8",
        timeout: 30000,
        env: { PATH: process.env.PATH ?? "", PGBIN: "/nonexistent-pgbin-for-the-harness-test", ...env },
      });
      return { status: r.status, stderr: r.stderr };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const runLine = (envField: string) => `run | 137-source-items-7d.test.ts | - | ${envField} | 0\n`;

  it("dies (exit 2) on a manifest env pair that is not a TAYF_* test knob", () => {
    for (const pair of [
      "PGHOST=db.example.com",
      "PGHOSTADDR=203.0.113.9",
      "PGSERVICE=prod",
      "PGPORT=6543",
      "PGOPTIONS=-c",
      "NODE_OPTIONS=--require=x",
      "TAYF_PSQL=/bin/true",
      "TAYF_PG_EXTERNAL=1",
      "TAYF_LIVE_KEEP=1",
      "TAYF_SHAPE=chain PGHOST=db.example.com",
      "TAYF_SHAPE",
      "tayf_shape=x",
    ]) {
      const r = runnerIn(runLine(pair));
      expect(r.status, pair).toBe(2);
      expect(r.stderr, pair).toContain("live-manifest.txt line 1");
      expect(r.stderr, pair).toContain("env");
      expect(r.stderr, pair).not.toContain("PGBIN");
    }
  });

  it("checks every run line, not only the first, and reports the right line number", () => {
    const r = runnerIn("# comment\n" + runLine("-") + runLine("TAYF_SHAPE=chain") + runLine("PGHOST=db.example.com"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("live-manifest.txt line 4");
  });

  it("lets a TAYF_* pair and '-' through the manifest check (it then stops at the missing PGBIN)", () => {
    const r = runnerIn(runLine("-") + runLine("TAYF_SHAPE=chain"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("PGBIN");
    expect(r.stderr).not.toContain("live-manifest.txt line");
  });

  it("ignores pending lines for the env check", () => {
    const r = runnerIn("pending | 128-delete-source-recompute.test.ts | PGHOST=x is only text in a reason here\n");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("PGBIN");
  });

  it("refuses an external server that is not local, and one steered by PGHOSTADDR / PGSERVICE (behavior)", () => {
    const base = { TAYF_PG_EXTERNAL: "1" };
    const remote = runnerIn(runLine("-"), { ...base, PGHOST: "db.example.com" });
    expect(remote.status).toBe(2);
    expect(remote.stderr).toContain("refusing to run");
    const addr = runnerIn(runLine("-"), { ...base, PGHOST: "localhost", PGHOSTADDR: "203.0.113.9" });
    expect(addr.status).toBe(2);
    expect(addr.stderr).toContain("PGHOSTADDR");
    const svc = runnerIn(runLine("-"), { ...base, PGHOST: "localhost", PGSERVICE: "prod" });
    expect(svc.status).toBe(2);
    expect(svc.stderr).toContain("PGSERVICE");
  });
});

// --- CI ----------------------------------------------------------------------

describe("live harness: ci.yml live-db job", () => {
  const lines = read(CI).split("\n");
  const start = lines.indexOf("  live-db:");
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i] as string;
    if (l.length > 0 && !l.startsWith("   ") && !l.startsWith("#")) {
      end = i;
      break;
    }
  }
  const job = start < 0 ? "" : lines.slice(start, end).join("\n");

  it("has a live-db job", () => {
    expect(start).toBeGreaterThanOrEqual(0);
  });

  it("runs the runner against a postgres:15 service in external mode", () => {
    expect(job).toContain("postgres:15");
    expect(job).toContain("run-live.sh");
    expect(job).toContain("TAYF_PG_EXTERNAL");
  });

  it("is read-only, holds no secret and does not persist checkout credentials", () => {
    expect(job).toContain("permissions:");
    expect(job).toContain("contents: read");
    expect(job).toContain("persist-credentials: false");
    expect(job.includes("secrets.")).toBe(false);
  });

  it("keeps the check and deno jobs", () => {
    expect(lines).toContain("  check:");
    expect(lines).toContain("  deno:");
  });
});
