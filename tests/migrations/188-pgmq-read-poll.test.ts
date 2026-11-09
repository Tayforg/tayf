import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Contract test for migration 188 ("pgmq_read_msgs_poll"), h101-e2elatency-1.
//
// cluster-drain runs every minute and read cluster_work once at about :02 and left; ingest-drain
// (every third minute) enqueues at about :06 to :11, so 73 % of the messages waited 40 to 65 s
// (p50 55 s). 188 adds the long-poll twin of 029's pgmq_read_msgs so the consumer can wait for
// the insert inside one invocation: public.pgmq_read_msgs_poll(queue_name, vt, qty,
// max_poll_seconds, poll_interval_ms) over pgmq.read_with_poll.
//
// This file pins: one transaction and the ledger row; ONE new function with the argument names
// _shared/pgmq.ts sends and 029's return type; SECURITY DEFINER with search_path = ''; the
// clamps that keep one call under PostgREST's 8 s statement_timeout; the revokes and the single
// service_role grant; and that nothing else is touched. The live behaviour (clamp reaching the
// pgmq function, the grants held by real roles, applying twice) is the dry-run script
// tests/migrations/sql/188-pgmq-read-poll-dryrun.sql, which run-live.sh executes.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const MIGRATION_188 = resolve(MIGRATIONS_DIR, "188_pgmq_read_msgs_poll.sql");
const MIGRATION_029 = resolve(MIGRATIONS_DIR, "029_public_pgmq_wrappers.sql");

const stripSqlComments = (sql: string): string => sql.replace(/--[^\n]*/g, "");
const norm = (sql: string): string => stripSqlComments(sql).replace(/\s+/g, " ").trim().toLowerCase();

const raw = readFileSync(MIGRATION_188, "utf8");
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

describe("188 pgmq_read_msgs_poll: ledger and transaction", () => {
  it("is one transaction: begin first, commit last", () => {
    expect(code.startsWith("begin;")).toBe(true);
    expect(code.endsWith("commit;")).toBe(true);
    expect(code.split("begin;")).toHaveLength(2);
    expect(code.split("commit;")).toHaveLength(2);
  });

  it("records ledger row 188 and re-applies safely", () => {
    expect(code).toContain(
      "insert into supabase_migrations.schema_migrations (version, name) values ('188', '188_pgmq_read_msgs_poll') on conflict do nothing;",
    );
  });

  it("asks PostgREST to reload its schema cache, so the new RPC is callable at once", () => {
    expect(code).toContain("notify pgrst, 'reload schema';");
  });
});

describe("188 pgmq_read_msgs_poll: the function", () => {
  const fn = createStatement(raw, "create or replace function public.pgmq_read_msgs_poll(");

  it("takes the argument names _shared/pgmq.ts sends, in that order", () => {
    expect(fn.startsWith(
      "create or replace function public.pgmq_read_msgs_poll(queue_name text, vt int, qty int, max_poll_seconds int, poll_interval_ms int)",
    )).toBe(true);
  });

  it("returns 029's pgmq_read_msgs row type", () => {
    const shim = createStatement(readFileSync(MIGRATION_029, "utf8"), "create or replace function public.pgmq_read_msgs(");
    const returnsOf = (s: string): string => {
      const at = s.indexOf(" returns ");
      return s.slice(at + " returns ".length, s.indexOf(" language ", at));
    };
    expect(returnsOf(shim)).toBe("setof pgmq.message_record");
    expect(returnsOf(fn)).toBe(returnsOf(shim));
  });

  it("is language sql, SECURITY DEFINER, with search_path locked to the empty string", () => {
    expect(fn).toContain(" language sql ");
    expect(fn).toContain(" security definer ");
    expect(fn).not.toContain("security invoker");
    expect(fn).toContain(" set search_path = '' ");
  });

  it("is one plain select over pgmq.read_with_poll, fully qualified, passing queue_name, vt and qty through", () => {
    const body = fn.slice(fn.indexOf("as $$") + "as $$".length, fn.lastIndexOf("$$;"));
    expect(body.startsWith(" select * from pgmq.read_with_poll(queue_name, vt, qty, ")).toBe(true);
    expect(body.trimEnd().endsWith(");")).toBe(true);
    expect(body.split(";")).toHaveLength(2);
  });

  it("clamps the wait to 1..6 s: one call must stay under the 8 s statement_timeout of PostgREST's authenticator", () => {
    expect(fn).toContain("least(greatest(max_poll_seconds, 1), 6)");
  });

  it("clamps the sleep step to 50..1000 ms, so the last sleep cannot push a call past the timeout either", () => {
    expect(fn).toContain("least(greatest(poll_interval_ms, 50), 1000)");
  });

  it("explains the clamp in a comment (8 s authenticator statement_timeout)", () => {
    const comments = raw
      .split("\n")
      .filter((l) => l.trimStart().startsWith("--"))
      .join("\n")
      .toLowerCase();
    expect(comments).toContain("statement_timeout");
    expect(comments).toContain("8 s");
    expect(comments).toContain("authenticator");
  });

  it("says a cancelled call rolls back (nothing stays leased), here and in the migration guide: pgmq leases inside the caller's transaction", () => {
    const comments = raw
      .split("\n")
      .filter((l) => l.trimStart().startsWith("--"))
      .map((l) => l.trimStart().replace(/^--+/, ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .toLowerCase();
    expect(comments).toContain("the transaction rolls back, so nothing stays leased");
    expect(comments).not.toContain("stay hidden for the visibility timeout");

    const guide = readFileSync(resolve(ROOT, "docs", "migration-guide.md"), "utf8").replace(/\s+/g, " ");
    expect(guide).toContain("cancelled with 57014 (the transaction rolls back, so nothing stays leased");
    expect(guide).not.toContain("cancelled with 57014 after it has leased its messages");
  });
});

describe("188 pgmq_read_msgs_poll: grants", () => {
  it("revokes every role that PostgREST or the default privileges could have given EXECUTE", () => {
    expect(code).toContain(
      "revoke all on function public.pgmq_read_msgs_poll(text, int, int, int, int) from public, anon, authenticated;",
    );
  });

  it("grants EXECUTE to service_role and nobody else", () => {
    expect(code).toContain("grant execute on function public.pgmq_read_msgs_poll(text, int, int, int, int) to service_role;");
    expect(code.split(" grant ")).toHaveLength(2);
    for (const bad of [" to anon", " to authenticated", " to public", "to postgres"]) {
      expect(code.includes(bad), bad).toBe(false);
    }
  });

  it("orders the revoke before the grant", () => {
    expect(code.indexOf("revoke all on function")).toBeLessThan(code.indexOf("grant execute on function"));
  });
});

describe("188 pgmq_read_msgs_poll: additive only", () => {
  it("creates exactly one function and no table, index, trigger, view, type, extension, cron job or data change", () => {
    expect(code.split("create or replace function").length - 1).toBe(1);
    for (const bad of [
      "create table",
      "create index",
      "create unique index",
      "create trigger",
      "create view",
      "create type",
      "create extension",
      "create schema",
      "alter table",
      "alter function",
      "drop ",
      "truncate",
      "delete from",
      "update ",
      "cron.schedule",
      "cron.unschedule",
    ]) {
      expect(code.includes(bad), bad).toBe(false);
    }
  });

  it("inserts only its own ledger row", () => {
    expect(code.split("insert into ").length - 1).toBe(1);
  });

  it("does not touch 029's pgmq_read_msgs", () => {
    const withoutNew = code.split("pgmq_read_msgs_poll").join("");
    expect(withoutNew.includes("pgmq_read_msgs")).toBe(false);
  });
});
