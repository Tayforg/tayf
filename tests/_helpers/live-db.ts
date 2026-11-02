import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll } from "vitest";

// ---------------------------------------------------------------------------
// Readiness check for the live-Postgres migration tests (describe.runIf on
// TAYF_PSQL). Those blocks used to skip silently, and a database that was not
// built the way the block expects (no stub, a migration missing) failed far
// from the cause with a confusing SQL error. assertLiveReady() makes the
// precondition explicit: it runs as the suite's first beforeAll and THROWS when
// the database is not what the block needs. A throwing beforeAll fails the
// file in vitest; it never skips it.
//
// Build the database with tests/migrations/sql/run-live.sh (manifest:
// tests/migrations/sql/live-manifest.txt).
//
// It also REFUSES a database that is, or looks like, production. A live block
// applies a migration twice outside any transaction and writes fixtures, and
// production has every ledger row, relation and function a block asks for, so
// the object check alone would pass there. run-live.sh only vets PGHOST; the
// checks below run in the database itself, so an ambient PG* / ~/.pgpass /
// SSH tunnel to a Supabase project is caught too.
// ---------------------------------------------------------------------------

/** The schema stub every live database starts from (tracked in the repo, no secrets). */
export const STUB_SQL = fileURLToPath(new URL("../migrations/sql/stub.sql", import.meta.url));

export interface LiveReadyChecks {
  /** supabase_migrations.schema_migrations versions that must be present, e.g. "140". */
  ledger?: readonly string[];
  /** Relations (tables, indexes, views) as schema-qualified names, checked with to_regclass. */
  relations?: readonly string[];
  /** Functions as regprocedure signatures, e.g. "public.is_legal_notice(text,text)". */
  functions?: readonly string[];
}

const STUB_RELATIONS: readonly string[] = [
  "public.sources",
  "public.articles",
  "supabase_migrations.schema_migrations",
];
const LEDGER_TABLE = "supabase_migrations.schema_migrations";

/**
 * Networks a throwaway server may be reached on, as the server sees the client
 * connection (inet_server_addr()): loopback, and the private ranges a CI service
 * container sits on (a published Docker port reaches the server on the
 * container's own 172.x address, never on 127.0.0.1). A unix socket has no
 * address at all (null). tests/migrations/sql/stub.sql carries the same list;
 * live-harness.test.ts keeps the two in step.
 *
 * This is defence in depth: a hosted database can sit on a private address too.
 * What identifies a Supabase project for certain is SUPABASE_SCHEMAS.
 */
export const LOCAL_NETWORKS = [
  "127.0.0.0/8",
  "::1/128",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "fc00::/7",
] as const;

/**
 * Schemas only a Supabase project has. `cron` is deliberately absent: several
 * live blocks and dry-run scripts create a fake one. stub.sql (a fresh database
 * only) refuses `cron` as well.
 */
export const SUPABASE_SCHEMAS = ["auth", "storage", "supabase_functions"] as const;

/** A SQL string literal body: every single quote doubled. */
function q(value: string): string {
  return value.replaceAll("'", "''");
}

/**
 * The objects a live block needs that the database does not have, as readable
 * items ("ledger 140", "relation public.cluster_skip_log", "function ...",
 * "stub public.articles"). `query` runs one SQL statement and returns psql's
 * unaligned, tuples-only output. Pure: no process, no database of its own.
 */
export function missingLiveObjects(checks: LiveReadyChecks, query: (sql: string) => string): string[] {
  const missing: string[] = [];
  const regclassPresent = (name: string): boolean =>
    query(`select to_regclass('${q(name)}') is not null;`).trim() === "t";

  let ledgerTable = false;
  for (const rel of STUB_RELATIONS) {
    const present = regclassPresent(rel);
    if (rel === LEDGER_TABLE) ledgerTable = present;
    if (!present) missing.push(`stub ${rel}`);
  }

  for (const version of checks.ledger ?? []) {
    // Without the ledger table the count query would be a SQL error, not an answer.
    const count = ledgerTable
      ? Number(query(`select count(*) from ${LEDGER_TABLE} where version = '${q(version)}';`).trim())
      : 0;
    if (!(count > 0)) missing.push(`ledger ${version}`);
  }

  for (const rel of checks.relations ?? []) {
    if (!regclassPresent(rel)) missing.push(`relation ${rel}`);
  }

  for (const fn of checks.functions ?? []) {
    const present = query(`select to_regprocedure('${q(fn)}') is not null;`).trim() === "t";
    if (!present) missing.push(`function ${fn}`);
  }

  return missing;
}

/** SQL boolean expression: `addr` is null (unix socket) or inside one of LOCAL_NETWORKS. */
export function addrIsLocalSql(addr: string): string {
  const nets = LOCAL_NETWORKS.map((n) => `'${n}'`).join(", ");
  return `(${addr} is null or ${addr} <<= any (array[${nets}]::inet[]))`;
}

/**
 * Reasons this database must not be written to, as readable items; [] when it
 * looks like a throwaway. Fails closed: any answer but the expected one is a
 * problem. `query` as in missingLiveObjects. Pure: no process, no database of its own.
 */
export function liveTargetProblems(query: (sql: string) => string): string[] {
  const problems: string[] = [];

  if (query(`select ${addrIsLocalSql("inet_server_addr()")};`).trim() !== "t") {
    problems.push("the server address is not a loopback or private-network address");
  }

  const names = SUPABASE_SCHEMAS.map((n) => `'${n}'`).join(", ");
  const found = query(
    `select coalesce(string_agg(nspname, ',' order by nspname), '') from pg_namespace where nspname in (${names});`,
  ).trim();
  if (found !== "") problems.push(`Supabase schema(s) present (${found}): this looks like a Supabase project`);

  return problems;
}

/** The error text of a live block pointed at a database that is, or looks like, production. */
export function targetRefusalMessage(label: string, problems: readonly string[]): string {
  return (
    `[live-db] ${label}: refusing to run against this database: ${problems.join("; ")}. ` +
    "The live tests apply migrations and write fixtures; point TAYF_PSQL / PG* at a throwaway Postgres " +
    "built by tests/migrations/sql/run-live.sh"
  );
}

/** The error text of a live block whose database is not ready. */
export function notReadyMessage(label: string, missing: readonly string[]): string {
  return (
    `[live-db] ${label}: database not ready: ${missing.join(", ")} ` +
    `(build it with tests/migrations/sql/run-live.sh; manifest tests/migrations/sql/live-manifest.txt; stub ${STUB_SQL})`
  );
}

/**
 * The whole readiness check, with `run` as the only door to the database:
 * reachable, then NOT production-like, then the objects the block needs. The
 * target check comes first so that nothing about a Supabase project (which has
 * every object a block asks for) can make a run look fine. Throws on the first
 * failing stage.
 */
export function verifyLiveDatabase(label: string, checks: LiveReadyChecks, run: (sql: string) => string): void {
  try {
    run("select 1;");
  } catch (e) {
    const stderr = String((e as { stderr?: string }).stderr ?? e).trim();
    throw new Error(
      `[live-db] ${label}: cannot reach the database (${stderr.split("\n")[0]}) ` +
        "(build it with tests/migrations/sql/run-live.sh; manifest tests/migrations/sql/live-manifest.txt)",
    );
  }

  const refused = liveTargetProblems(run);
  if (refused.length > 0) throw new Error(targetRefusalMessage(label, refused));

  const missing = missingLiveObjects(checks, run);
  if (missing.length > 0) throw new Error(notReadyMessage(label, missing));
}

/**
 * Call as the FIRST statement inside `describe.runIf(Boolean(process.env.TAYF_PSQL))`.
 * Registers a beforeAll that checks the database TAYF_PSQL / PGHOST / PGPORT /
 * PGUSER / PGDATABASE point at, and throws (the file FAILS, it does not skip)
 * when that database looks like production, or when the stub or a named object
 * is missing.
 */
export function assertLiveReady(label: string, checks: LiveReadyChecks = {}): void {
  beforeAll(() => {
    const psql = process.env.TAYF_PSQL as string;
    const run = (sql: string): string =>
      execFileSync(psql, ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
        input: sql,
        encoding: "utf8",
        env: { ...process.env, PGCLIENTENCODING: "UTF8" },
        stdio: ["pipe", "pipe", "pipe"],
      });
    verifyLiveDatabase(label, checks, run);
  });
}
