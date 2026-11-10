import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Contract test for migration 190 ("consumer_lease"), h106-attachdesign-1.
//
// The cluster consumer is now attach-limited by its trigger: cron-drain reads once a minute and ingest
// inserts at about :04-:12, so a message waits p50 55 s for the next minute (h101). #252 tried to cure it
// with a long poll and held pg_net's batch open (h102, #253 switched it off). The follow-up design lets
// ingest KICK the consumer from EdgeRuntime.waitUntil once its enqueue is done. Two consumers (the cron
// one and the kicked one, in different isolates) must never read cluster_work at the same time, or they
// score the same story's messages in parallel and open twins. PostgREST cannot hold a session advisory
// lock, so 190 adds a TTL lease row and two SECURITY DEFINER RPCs over it.
//
// This file pins the SQL text: one transaction and the ledger row; the table (RLS on, no policy, nothing
// for public, anon, authenticated); consumer_lease_acquire (SECURITY DEFINER, search_path = '', TTL clamp
// 5..120, ONE insert ... on conflict do update with the takeover rule, returning true, coalesce to false);
// consumer_lease_release (delete only for the holder); the revokes and the service_role grants; and that
// nothing else is touched. The behaviour (takeover only after expiry, same-holder renew, release only by
// the holder, the clamp, the roles against real ACLs, applying twice, the rollback) is the dry-run script
// tests/migrations/sql/190-consumer-lease-dryrun.sql, which run-live.sh executes on a throwaway Postgres.
// The Edge side (RPC names, argument names) is pinned against this file in
// tests/functions/_shared/lease.test.ts.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATION_190 = resolve(ROOT, "supabase", "migrations", "190_consumer_lease.sql");
const DRYRUN_190 = resolve(__dirname, "sql", "190-consumer-lease-dryrun.sql");

const stripSqlComments = (sql: string): string => sql.replace(/--[^\n]*/g, "");
const norm = (sql: string): string => stripSqlComments(sql).replace(/\s+/g, " ").trim().toLowerCase();

const raw = readFileSync(MIGRATION_190, "utf8");
const code = norm(raw);

/** The text of the one statement that starts at `marker`, up to and including its `;` after the closing `$$`. */
function createStatement(sql: string, marker: string): string {
  const text = norm(sql);
  const at = text.indexOf(marker);
  expect(at, `expected ${marker}`).toBeGreaterThanOrEqual(0);
  const close = text.indexOf("$$;", text.indexOf("as $$", at) + 5);
  expect(close, "expected a closing $$;").toBeGreaterThan(at);
  return text.slice(at, close + 3);
}

describe("190 consumer_lease: ledger and transaction", () => {
  it("is one transaction: begin first, commit last", () => {
    expect(code.startsWith("begin;")).toBe(true);
    expect(code.endsWith("commit;")).toBe(true);
    expect(code.split("begin;")).toHaveLength(2);
    expect(code.split("commit;")).toHaveLength(2);
  });

  it("records ledger row 190 and re-applies safely", () => {
    expect(code).toContain(
      "insert into supabase_migrations.schema_migrations (version, name) values ('190', '190_consumer_lease') on conflict do nothing;",
    );
  });

  it("asks PostgREST to reload its schema cache, so the new RPCs are callable at once", () => {
    expect(code).toContain("notify pgrst, 'reload schema';");
  });
});

describe("190 consumer_lease: the table", () => {
  const table = code.slice(
    code.indexOf("create table if not exists public.consumer_leases"),
    code.indexOf(");", code.indexOf("create table if not exists public.consumer_leases")) + 2,
  );

  it("is public.consumer_leases with the four columns of the design", () => {
    expect(table).toContain("name text primary key");
    expect(table).toContain("holder text not null");
    expect(table).toContain("acquired_at timestamptz not null default clock_timestamp()");
    expect(table).toContain("expires_at timestamptz not null");
    expect(table.match(/,/g)?.length).toBe(3);
  });

  it("has row level security on and no policy at all", () => {
    expect(code).toContain("alter table public.consumer_leases enable row level security;");
    expect(code.includes("create policy")).toBe(false);
    expect(code.includes("force row level security")).toBe(false);
    expect(code.includes("disable row level security")).toBe(false);
  });

  it("revokes everything from public, anon and authenticated, and grants the table to nobody", () => {
    expect(code).toContain("revoke all on public.consumer_leases from public, anon, authenticated;");
    for (const grant of code.split(" grant ").slice(1)) {
      expect(grant.startsWith("execute on function public.consumer_lease_"), grant.slice(0, 60)).toBe(true);
    }
    expect(code.includes("grant all")).toBe(false);
    expect(code.includes("grant select")).toBe(false);
    expect(code.includes("grant insert")).toBe(false);
  });

  it("says what the table is for in a table comment", () => {
    expect(code).toContain("comment on table public.consumer_leases is");
  });
});

describe("190 consumer_lease: consumer_lease_acquire", () => {
  const fn = createStatement(raw, "create or replace function public.consumer_lease_acquire(");

  it("takes p_name, p_holder and p_ttl_seconds, the argument names _shared/lease.ts sends, and returns boolean", () => {
    expect(
      fn.startsWith(
        "create or replace function public.consumer_lease_acquire(p_name text, p_holder text, p_ttl_seconds int) returns boolean",
      ),
    ).toBe(true);
  });

  it("is SECURITY DEFINER with search_path locked to the empty string, and volatile (the default)", () => {
    expect(fn).toContain(" security definer ");
    expect(fn).not.toContain("security invoker");
    expect(fn).toContain(" set search_path = '' ");
    expect(fn).not.toContain(" stable ");
    expect(fn).not.toContain(" immutable ");
  });

  it("clamps the TTL to 5..120 seconds (a null or negative TTL is the 5 s floor)", () => {
    expect(fn).toContain("least(greatest(p_ttl_seconds, 5), 120)");
  });

  it("is ONE insert ... on conflict (name) do update, schema-qualified, no select-then-write race", () => {
    expect(fn.split("insert into public.consumer_leases").length - 1).toBe(1);
    expect(fn).toContain("on conflict (name) do update");
    expect(fn.includes(" for update")).toBe(false);
    expect(fn.includes("lock table")).toBe(false);
    expect(fn.includes("pg_advisory")).toBe(false);
    expect(fn.split("update set").length - 1).toBe(1);
    expect(fn.split(" delete ").length - 1).toBe(0);
  });

  it("takes an existing row over only when it has expired or when the same holder renews", () => {
    expect(fn).toContain("where l.expires_at <= clock_timestamp() or l.holder = excluded.holder");
  });

  it("sets the holder and the new expiry on takeover and renewal, and keeps acquired_at on a live renewal", () => {
    expect(fn).toContain("holder = excluded.holder");
    expect(fn).toContain("expires_at = excluded.expires_at");
    expect(fn).toContain("acquired_at = case when l.holder = excluded.holder and l.expires_at > clock_timestamp() then l.acquired_at else excluded.acquired_at end");
  });

  it("answers true when the statement wrote a row and false when the where clause refused it", () => {
    expect(fn).toContain("returning true");
    expect(fn).toContain("coalesce(");
    expect(fn).toContain(", false)");
  });

  it("measures time with clock_timestamp() only: now() is the transaction start and would freeze a long statement's clock", () => {
    expect(fn.includes("now()")).toBe(false);
    expect(fn.includes("current_timestamp")).toBe(false);
    expect(fn.includes("transaction_timestamp")).toBe(false);
  });
});

describe("190 consumer_lease: consumer_lease_release", () => {
  const fn = createStatement(raw, "create or replace function public.consumer_lease_release(");

  it("takes p_name and p_holder and returns boolean", () => {
    expect(
      fn.startsWith("create or replace function public.consumer_lease_release(p_name text, p_holder text) returns boolean"),
    ).toBe(true);
  });

  it("is SECURITY DEFINER with search_path locked to the empty string", () => {
    expect(fn).toContain(" security definer ");
    expect(fn).not.toContain("security invoker");
    expect(fn).toContain(" set search_path = '' ");
  });

  it("deletes the row only when the holder matches (a stale holder cannot release a successor's lease)", () => {
    expect(fn.split("delete from public.consumer_leases").length - 1).toBe(1);
    expect(fn).toContain("l.name = p_name and l.holder = p_holder");
    expect(fn.includes("truncate")).toBe(false);
  });
});

describe("190 consumer_lease: grants", () => {
  it.each([
    "public.consumer_lease_acquire(text, text, int)",
    "public.consumer_lease_release(text, text)",
  ])("%s: revoked from public, anon and authenticated, then granted to service_role only", (sig) => {
    const revoke = `revoke all on function ${sig} from public, anon, authenticated;`;
    const grant = `grant execute on function ${sig} to service_role;`;
    expect(code).toContain(revoke);
    expect(code).toContain(grant);
    expect(code.indexOf(revoke)).toBeLessThan(code.indexOf(grant));
  });

  it("grants EXECUTE to service_role and nobody else", () => {
    expect(code.split(" grant ").length - 1).toBe(2);
    for (const bad of [" to anon", " to authenticated", " to public", "to postgres"]) {
      expect(code.includes(bad), bad).toBe(false);
    }
  });

  it("revokes after the function it protects is created (a revoke that precedes the create protects nothing)", () => {
    for (const name of ["consumer_lease_acquire", "consumer_lease_release"]) {
      expect(code.indexOf(`create or replace function public.${name}(`)).toBeGreaterThan(-1);
      expect(code.indexOf(`create or replace function public.${name}(`)).toBeLessThan(
        code.indexOf(`revoke all on function public.${name}(`),
      );
    }
  });
});

describe("190 consumer_lease: additive only", () => {
  it("creates one table and two functions, and nothing else", () => {
    expect(code.split("create table").length - 1).toBe(1);
    expect(code.split("create or replace function").length - 1).toBe(2);
    for (const bad of [
      "create index",
      "create unique index",
      "create trigger",
      "create view",
      "create materialized view",
      "create type",
      "create extension",
      "create schema",
      "create role",
      "alter function",
      "alter system",
      "alter database",
      "alter role",
      "drop ",
      "truncate",
      "update public.",
      "cron.schedule",
      "cron.unschedule",
      "cron.alter_job",
      "set_config",
      "current_setting",
    ]) {
      expect(code.includes(bad), bad).toBe(false);
    }
  });

  it("alters only its own table (the RLS switch), and writes only its own rows and its ledger row", () => {
    expect(code.split("alter table ").length - 1).toBe(1);
    expect(code.split("insert into ").length - 1).toBe(2); // the lease row (in the acquire function) and the ledger row
    expect(code.split("delete from ").length - 1).toBe(1); // the release function
    // ("update public." is refused above; the `do update set` of the upsert is no table.)
    const touched = [...code.matchAll(/(?:insert into|delete from|alter table|create table(?: if not exists)?)\s+([a-z_.]+)/g)].map(
      (m) => m[1],
    );
    expect(new Set(touched)).toEqual(new Set(["public.consumer_leases", "supabase_migrations.schema_migrations"]));
  });

  it("touches no existing object of the cluster pipeline", () => {
    for (const name of ["pgmq", "cluster_work", "cluster_attach", "clusters", "cluster_articles", "articles", "net.http_post", "enqueue_"]) {
      expect(code.includes(name), name).toBe(false);
    }
  });
});

describe("190 consumer_lease: header", () => {
  const header = raw
    .split("\n")
    .filter((l) => l.trimStart().startsWith("--"))
    .map((l) => l.trimStart().replace(/^--+/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .toLowerCase();

  it("carries the measured evidence, the deploy order and a rollback", () => {
    expect(header).toContain("h106-attachdesign-1");
    expect(header).toContain("a_cluster_work");
    expect(header).toContain("rollback");
    expect(header).toContain("drop function public.consumer_lease_acquire(text, text, int)");
    expect(header).toContain("drop function public.consumer_lease_release(text, text)");
    expect(header).toContain("drop table public.consumer_leases");
    expect(header).toContain("delete from supabase_migrations.schema_migrations where version = '190'");
    expect(header).toContain("supabase secrets unset cluster_kick");
  });

  it("states the deploy order: apply 190, deploy cluster-consumer, deploy ingest, then set CLUSTER_KICK", () => {
    const apply = header.indexOf("apply 190");
    const consumer = header.indexOf("deploy cluster-consumer", apply);
    const ingest = header.indexOf("deploy ingest", consumer);
    const secret = header.indexOf("supabase secrets set cluster_kick=on", ingest);
    expect(apply).toBeGreaterThanOrEqual(0);
    expect(consumer).toBeGreaterThan(apply);
    expect(ingest).toBeGreaterThan(consumer);
    expect(secret).toBeGreaterThan(ingest);
  });

  it("says why now() is not used and why a session advisory lock is not (PostgREST)", () => {
    expect(header).toContain("clock_timestamp");
    expect(header).toContain("advisory");
    expect(header).toContain("postgrest");
  });
});

describe("190 consumer_lease: dry-run script", () => {
  it("exists next to the other dry-runs, so run-live.sh picks it up", () => {
    expect(existsSync(DRYRUN_190)).toBe(true);
  });

  const dry = existsSync(DRYRUN_190) ? readFileSync(DRYRUN_190, "utf8") : "";

  it("applies 190 twice and ends with its OK line", () => {
    expect(dry.split("190_consumer_lease.sql").length - 1).toBeGreaterThanOrEqual(3); // twice up front, once after the rollback
    expect(dry).toContain("select 'DRYRUN 190 OK';");
  });

  it("checks every behaviour of the finding: takeover only after expiry, same-holder renew, release only by the holder, the clamp, the ACLs", () => {
    const lower = dry.toLowerCase();
    for (const needle of [
      "takeover",
      "renew",
      "release",
      "clamp",
      "has_function_privilege",
      "insufficient_privilege",
      "relrowsecurity",
      "pg_policy",
    ]) {
      expect(lower.includes(needle), needle).toBe(true);
    }
  });
});
