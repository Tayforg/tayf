import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Contract test for migration 183 ("intraday_targets_session_window"),
// h92-marketclock-1.
//
// 160's bist_intraday_targets selects the news tickers of `now() - interval '7 days'`.
// That is a rolling cut-off, so a ticker leaves the target list at the minute its last
// mention turns 7 days old, in the middle of a session: its bars stop there and the
// quotes-ingest range '1d' / `ts >= last` filter never back-fills them. VKING on
// 2026-11-06: 27 bars 06:55Z-09:05Z, the last one 11.53 with volume 0, the daily close 12.09.
// 183 moves the cut-off to Istanbul midnight 7 days back, so the set changes only at
// Istanbul midnight and never during the 09:55-18:15 session.
//
// This file pins: the ledger row and one transaction; that the replaced function keeps
// 160's signature, return columns, language, volatility, security and grants; that the
// new body is 160's body (the text whose md5 is the production fingerprint recorded in
// the header) with exactly ONE line changed, to the Istanbul-midnight window; that the
// grants are 160's, word for word; and that nothing else is touched. No live block: the
// window is one SQL expression and the header records its read-only production replay.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const MIGRATION_183 = resolve(MIGRATIONS_DIR, "183_intraday_targets_session_window.sql");
const MIGRATION_160 = resolve(MIGRATIONS_DIR, "160_intraday_traded_targets.sql");

/** Production, read-only, 2026-11-09: md5(prosrc), length and proacl of public.bist_intraday_targets(integer) (= 160's body). */
const PROD_PROSRC_MD5 = "36d7209bf11615ba628fcee3f274faa3";
const PROD_PROSRC_LENGTH = 422;
const PROD_PROACL = "{postgres=X/postgres,service_role=X/postgres}";

const FN_MARKER = "create or replace function public.bist_intraday_targets(p_limit int default 120)";

/** 160's window line (inside the `t` subquery) and 183's replacement, indentation included. */
const OLD_WINDOW = "    where created_at >= now() - interval '7 days'";
const NEW_WINDOW =
  "    where created_at >= (((now() at time zone 'Europe/Istanbul')::date - 7)::timestamp at time zone 'Europe/Istanbul')";

const stripSqlComments = (sql: string): string => sql.replace(/--[^\n]*/g, "");
const norm = (sql: string): string => stripSqlComments(sql).replace(/\s+/g, " ").trim();
const md5 = (text: string): string => createHash("md5").update(text).digest("hex");

/** Index of the statement itself: the marker at the start of a line (a header comment may quote it too). */
function statementStart(sql: string): number {
  const at = sql.search(new RegExp(`^${FN_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"));
  expect(at, `expected a line starting with "${FN_MARKER}"`).toBeGreaterThanOrEqual(0);
  return at;
}

/** The text between `as $$` and the closing `$$;` of the function: Postgres' prosrc. */
function functionBody(sql: string): string {
  const start = statementStart(sql);
  const open = sql.indexOf("as $$", start);
  expect(open, "expected an `as $$` after the function header").toBeGreaterThan(start);
  const bodyStart = open + "as $$".length;
  const close = sql.indexOf("$$;", bodyStart);
  expect(close, "expected a closing `$$;`").toBeGreaterThan(bodyStart);
  return sql.slice(bodyStart, close);
}

/** The function from its header through the closing `$$;`. */
function functionStatement(sql: string): string {
  const start = statementStart(sql);
  const close = sql.indexOf("$$;", sql.indexOf("as $$", start) + 5);
  return sql.slice(start, close + 3);
}

const sql183 = readFileSync(MIGRATION_183, "utf8");
const code183 = stripSqlComments(sql183);
const n183 = norm(sql183);
const sql160 = readFileSync(MIGRATION_160, "utf8");
const body160 = functionBody(sql160);
const body183 = functionBody(sql183);

describe("183 intraday_targets_session_window: ledger and transaction", () => {
  it("records version 183 in the schema_migrations ledger, idempotently (095 pattern)", () => {
    expect(n183).toContain(
      "insert into supabase_migrations.schema_migrations (version, name) values ('183', '183_intraday_targets_session_window') on conflict do nothing;",
    );
  });

  it("is one transaction: a single begin, a single commit, the ledger row last", () => {
    expect([...code183.matchAll(/^\s*begin\s*;/gim)]).toHaveLength(1);
    expect([...code183.matchAll(/^\s*commit\s*;/gim)]).toHaveLength(1);
    expect(n183.slice(n183.indexOf("begin;")).endsWith("on conflict do nothing; commit;")).toBe(true);
  });
});

describe("183 intraday_targets_session_window: the production fingerprint it was built from", () => {
  it("160's function body is production's body: its md5 and length are the recorded prosrc md5 and length", () => {
    expect(md5(body160)).toBe(PROD_PROSRC_MD5);
    expect(body160.length).toBe(PROD_PROSRC_LENGTH);
  });

  it("the header records the production md5(prosrc), the production proacl and the md5 of the new body", () => {
    expect(sql183).toContain(PROD_PROSRC_MD5);
    expect(sql183).toContain(PROD_PROACL);
    const recorded = /new md5\(prosrc\):\s*([0-9a-f]{32})/.exec(sql183)?.[1];
    expect(recorded, "header line `new md5(prosrc): <32 hex>`").toBeDefined();
    expect(recorded).toBe(md5(body183));
    expect(recorded).not.toBe(PROD_PROSRC_MD5);
  });

  it("the header says why: a rolling 7-day cut-off drops a ticker mid-session (VKING 2026-11-06, 11.53 against 12.09)", () => {
    expect(sql183).toContain("VKING");
    expect(sql183).toContain("2026-11-06");
    expect(sql183).toContain("11.53");
    expect(sql183).toContain("12.09");
    expect(sql183).toMatch(/mid-session/i);
    expect(sql183).toMatch(/never back-?fill/i);
    // the per-session counts of tickers whose last 5m bar was before 17:30 Istanbul
    for (const day of ["10-26", "10-27", "10-30", "11-02", "11-03", "11-04", "11-05", "11-06"]) {
      expect(sql183, `the header lists session ${day}`).toContain(day);
    }
  });

  it("the header records the rollback: 160's create statement, then the ledger row 183", () => {
    expect(sql183).toMatch(/ROLLBACK/);
    expect(sql183).toContain("160");
    expect(sql183).toContain("delete the ledger row 183");
  });
});

describe("183 intraday_targets_session_window: the replaced function", () => {
  it("replaces exactly one function, with 160's signature, return columns, language and volatility", () => {
    expect([...code183.matchAll(/\bcreate\s+(or\s+replace\s+)?function\b/gi)]).toHaveLength(1);
    expect(n183).toContain(
      "create or replace function public.bist_intraday_targets(p_limit int default 120) returns table (ticker text, last_ts timestamptz) language sql stable as $$",
    );
    const header160 = norm(functionStatement(sql160).split("as $$")[0] as string);
    const header183 = norm(functionStatement(sql183).split("as $$")[0] as string);
    expect(header183).toBe(header160);
  });

  it("keeps the owner and security of 160: SECURITY INVOKER, no SET clause, no security definer", () => {
    const stmt = norm(functionStatement(sql183));
    expect(stmt).not.toMatch(/security\s+definer/i);
    expect(stmt).not.toMatch(/\bset\s+search_path\b/i);
    expect(stmt).not.toMatch(/\bowner\s+to\b/i);
    expect(code183).not.toMatch(/\balter\s+function\b/i);
  });

  it("the new body is 160's body with exactly one line changed: the window", () => {
    expect(body160).toContain(OLD_WINDOW);
    expect(body183).toBe(body160.replace(OLD_WINDOW, NEW_WINDOW));

    // belt and braces: line by line, one difference and it is the window
    const lines160 = body160.split("\n");
    const lines183 = body183.split("\n");
    expect(lines183).toHaveLength(lines160.length);
    const differing = lines160.flatMap((l, i) => (l === lines183[i] ? [] : [[l, lines183[i]]]));
    expect(differing).toEqual([[OLD_WINDOW, NEW_WINDOW]]);
  });

  it("the window is Istanbul midnight seven days back, not a rolling 7 x 24 hours", () => {
    expect(body183).toContain(
      "created_at >= (((now() at time zone 'Europe/Istanbul')::date - 7)::timestamp at time zone 'Europe/Istanbul')",
    );
    expect(body183).not.toMatch(/interval\s+'7 days'/i);
    // a bare now() minus an interval is the rolling form that 183 removes
    expect(body183).not.toMatch(/now\(\)\s*-\s*interval/i);
  });

  it("keeps 160's traded intersect, the staleness order, the left join on bist_bars_5m and the p_limit bound", () => {
    const body = norm(body183);
    expect(body).toContain(
      "intersect select distinct unnest(tickers) as ticker from public.bist_companies where shares_traded",
    );
    expect(body).toContain("left join (select ticker, max(ts) as last_ts from public.bist_bars_5m group by 1) b using (ticker)");
    expect(body).toContain("order by b.last_ts nulls first, t.ticker limit p_limit;");
  });
});

describe("183 intraday_targets_session_window: grants", () => {
  it("restates 160's revoke and grant for bist_intraday_targets(int), word for word", () => {
    const revoke160 = [...stripSqlComments(sql160).matchAll(/\brevoke\b[^;]*;/gi)].map((m) => norm(m[0]));
    const grant160 = [...stripSqlComments(sql160).matchAll(/\bgrant\b[^;]*;/gi)].map((m) => norm(m[0]));
    expect(revoke160).toHaveLength(1);
    expect(grant160).toHaveLength(1);
    const revoke183 = [...code183.matchAll(/\brevoke\b[^;]*;/gi)].map((m) => norm(m[0]));
    const grant183 = [...code183.matchAll(/\bgrant\b[^;]*;/gi)].map((m) => norm(m[0]));
    expect(revoke183).toEqual(revoke160);
    expect(grant183).toEqual(grant160);
    expect(n183).toContain(
      "revoke execute on function public.bist_intraday_targets(int) from anon, authenticated, public;",
    );
    expect(n183).toContain("grant execute on function public.bist_intraday_targets(int) to service_role;");
  });

  it("grants only to service_role, and the grants come after the function", () => {
    expect(code183.indexOf("revoke execute")).toBeGreaterThan(code183.indexOf("create or replace function"));
    expect(code183.indexOf("grant execute")).toBeGreaterThan(code183.indexOf("revoke execute"));
    expect(code183).not.toMatch(/alter\s+default\s+privileges/i);
    expect(code183).not.toMatch(/\bto\s+(anon|authenticated|public)\b/i);
  });
});

describe("183 intraday_targets_session_window: additive, nothing else touched", () => {
  it("never mentions the daily function in code", () => {
    expect(code183).not.toMatch(/bist_daily_targets/i);
  });

  it("creates no table, index, view, trigger or cron job; no back-fill; drops, deletes and updates nothing", () => {
    expect(code183).not.toMatch(/\bcreate\s+(unique\s+)?(table|index|view|trigger|materialized|extension|policy)\b/i);
    expect(code183).not.toMatch(/\bcron\./i);
    expect(code183).not.toMatch(/\bdrop\s+(table|index|function|column|constraint|policy|trigger|view)\b/i);
    expect(code183).not.toMatch(/\btruncate\b/i);
    expect(code183).not.toMatch(/\bdelete\s+from\b/i);
    expect(code183).not.toMatch(/^\s*update\b/im);
    expect(code183).not.toMatch(/\balter\s+table\b/i);
    const inserts = [...code183.matchAll(/\binsert\s+into\s+([\w.]+)/gi)].map((m) => m[1]);
    expect(inserts).toEqual(["supabase_migrations.schema_migrations"]);
  });
});
