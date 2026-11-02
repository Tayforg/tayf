import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assertLiveReady } from "../_helpers/live-db";
import { SUPABASE_SCHEMAS, addrIsLocalSql } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// The throwaway-database guard at the top of tests/migrations/sql/stub.sql, and
// the address expression tests/_helpers/live-db.ts sends, on a real Postgres.
//
// Why: the stub ends by granting anon / authenticated / service_role everything
// on every FUTURE table, sequence and function, and its CREATE TABLEs are not
// repeatable. Loaded by mistake into a Supabase project, with psql left on its
// default of "carry on after an error", it exits 0, skips the statements that
// fail, and silently undoes migration 117's default revoke. The guard makes it
// refuse instead, before it creates or alters anything.
//
// Static side (always runs): tests/migrations/live-harness.test.ts. Live side
// (opt-in, TAYF_PSQL): this file. Each scenario gets its OWN scratch database,
// created from the live one and dropped at the end, so nothing here touches the
// database the other live files use. Run it with tests/migrations/sql/run-live.sh.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))("stub.sql throwaway guard (live Postgres)", () => {
  assertLiveReady("stub-guard");

  const psql = process.env.TAYF_PSQL as string;
  const STUB = resolve(__dirname, "sql", "stub.sql");
  const scratchDatabases: string[] = [];

  /** One psql call. `db` overrides PGDATABASE; no ON_ERROR_STOP unless the args carry it, as a careless run would be. */
  function run(args: string[], db?: string): { status: number | null; stdout: string; all: string } {
    const r = spawnSync(psql, ["-X", "-q", "-At", ...args], {
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8", ...(db ? { PGDATABASE: db } : {}) },
    });
    return { status: r.status, stdout: r.stdout.trim(), all: `${r.stdout}${r.stderr}` };
  }

  /** A new, empty database. */
  function scratch(): string {
    const name = `tayf_live_stubguard_${process.pid}_${scratchDatabases.length + 1}`;
    const r = run(["-v", "ON_ERROR_STOP=1", "-c", `create database "${name}"`]);
    if (r.status !== 0) throw new Error(`cannot create ${name}: ${r.all}`);
    scratchDatabases.push(name);
    return name;
  }

  const scalar = (db: string, sql: string): string => run(["-v", "ON_ERROR_STOP=1", "-c", sql], db).stdout;
  const loadStub = (db: string, strict: boolean) => run([...(strict ? ["-v", "ON_ERROR_STOP=1"] : []), "-f", STUB], db);

  /** What migration 117 leaves behind: no default privileges for anon / authenticated / service_role. */
  const revokeDefaults = (db: string): void => {
    scalar(db, "alter default privileges in schema public revoke all on tables from anon, authenticated, service_role");
    scalar(db, "alter default privileges in schema public revoke all on sequences from anon, authenticated, service_role");
    scalar(db, "alter default privileges in schema public revoke execute on functions from anon, authenticated, service_role");
  };

  afterAll(() => {
    for (const name of scratchDatabases) {
      run(["-c", `drop database if exists "${name}" with (force)`]);
    }
  });

  it("loads into a fresh, empty database, and leaves the permissive default privileges the prelude promises", () => {
    const db = scratch();
    const r = loadStub(db, true);
    expect(r.status, r.all).toBe(0);
    expect(scalar(db, "select to_regclass('public.sources') is not null")).toBe("t");
    expect(scalar(db, "select count(*) from pg_default_acl")).toBe("3");
  });

  it("refuses a second load into the same database, exits non-zero, and does not touch default privileges (the 117 revoke survives)", () => {
    const db = scratch();
    expect(loadStub(db, true).status).toBe(0);
    revokeDefaults(db);
    expect(scalar(db, "select count(*) from pg_default_acl")).toBe("0");

    // psql's own default after an error is to carry on: that is exactly what must not matter.
    const again = loadStub(db, false);
    expect(again.status).not.toBe(0);
    expect(again.all).toContain("stub.sql refuses to load");
    expect(again.all).toContain("public.sources already exists");
    // nothing after the guard ran: not even the harmless "already exists, skipping" notices
    expect(again.all).not.toContain("skipping");

    expect(scalar(db, "select count(*) from pg_default_acl")).toBe("0");
    scalar(db, "create table public.after_guard (id int)");
    expect(scalar(db, "select has_table_privilege('anon', 'public.after_guard', 'insert')")).toBe("f");
  });

  for (const schema of [...SUPABASE_SCHEMAS, "cron"]) {
    it(`refuses a database that has a "${schema}" schema, and creates nothing`, () => {
      const db = scratch();
      scalar(db, `create schema "${schema}"`);
      const r = loadStub(db, false);
      expect(r.status).not.toBe(0);
      expect(r.all).toContain("stub.sql refuses to load");
      expect(r.all).toContain(schema);
      expect(r.all).toContain("Supabase");
      expect(scalar(db, "select to_regclass('public.sources') is null")).toBe("t");
      expect(scalar(db, "select count(*) from pg_extension where extname = 'pgcrypto'")).toBe("0");
      expect(scalar(db, "select count(*) from pg_default_acl")).toBe("0");
    });
  }

  it("names every offending schema when there are several", () => {
    const db = scratch();
    scalar(db, 'create schema "auth"');
    scalar(db, 'create schema "storage"');
    const r = loadStub(db, false);
    expect(r.status).not.toBe(0);
    expect(r.all).toContain("auth, storage");
  });

  it("stops at its first error even when the caller did not ask psql to (line 1 sets ON_ERROR_STOP)", () => {
    const db = scratch();
    // public.clusters is the third CREATE TABLE of the stub: sources and articles are created, then it fails.
    scalar(db, "create table public.clusters (x int)");
    const r = loadStub(db, false);
    expect(r.status).not.toBe(0);
    expect(r.all).toContain("already exists");
    expect(scalar(db, "select to_regclass('public.articles') is not null")).toBe("t");
    expect(scalar(db, "select to_regclass('public.cluster_articles') is null")).toBe("t");
    // the prelude is the last thing in the file: it never ran
    expect(scalar(db, "select count(*) from pg_default_acl")).toBe("0");
  });

  describe("the server-address expression (live-db.ts addrIsLocalSql, same list as the stub)", () => {
    const answer = (addr: string): string =>
      run(["-v", "ON_ERROR_STOP=1", "-c", `select ${addrIsLocalSql(`'${addr}'::inet`)}`]).stdout;

    it("accepts loopback, the private ranges and a unix socket (null)", () => {
      for (const addr of ["127.0.0.1", "127.255.255.254", "::1", "10.1.2.3", "172.16.0.5", "172.31.255.1", "192.168.1.1", "fd00::1"]) {
        expect(answer(addr), addr).toBe("t");
      }
      const nullAddr = run(["-v", "ON_ERROR_STOP=1", "-c", `select ${addrIsLocalSql("null::inet")}`]).stdout;
      expect(nullAddr).toBe("t");
    });

    it("refuses public addresses, including the ones just outside a private range", () => {
      for (const addr of ["8.8.8.8", "203.0.113.7", "172.15.255.255", "172.32.0.1", "192.169.0.1", "11.0.0.1", "2001:db8::1", "::2"]) {
        expect(answer(addr), addr).toBe("f");
      }
    });
  });
});
