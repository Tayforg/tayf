import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Contract test for migration 164 ("price_at_session_aware"), h48-ekonomi-1.
//
// public.price_at(ticker, ts) is the reference price of the /ekonomi "haberden" chip (the move since
// the headline). 062's body coalesces ANY 5-minute bar of the last 4 days ahead of the daily close, so a
// ticker whose last 5-minute bar is from an older session than the newest completed daily close
// (bist_bars_5m is only filled for the tickers the news named, and pruned after 14 days) was priced from
// that stale bar: DOHOL +%9,77 "haberden" against a true +%2,4, SISE +%0,18 while the stock was down 5,5 %.
//
// 164 uses a 5-minute bar only when it is at or after 18:00 Istanbul time (the closing-auction bar) of the day
// of the newest completed daily close (the daily row 062's own CASE selects), or when there is no daily row;
// otherwise the daily close wins. A bar from a mid-session dropout of the SAME day (KARCL, KRDMA, KRDMB on
// 4 Nov: three bars, the last at 10:05 Istanbul) therefore loses to that day's close as well.
//
// This file pins: one transaction, the function, its grants and the ledger row; that the replaced function
// keeps 062's signature, language, volatility and security (and that 062's body is the production body, by
// md5); that the new body keeps 062's two lookups verbatim and adds exactly the 18:00-Istanbul rule; the
// revoke and grant of 058; that nothing is dropped, updated or deleted and the only insert is the ledger
// row; and, in the opt-in live block (TAYF_PSQL), the behaviour on a throwaway Postgres, including the
// production cases.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const FILE_164 = "164_price_at_session_aware.sql";
const MIGRATION_164 = resolve(MIGRATIONS_DIR, FILE_164);
const MIGRATION_062 = resolve(MIGRATIONS_DIR, "062_coverage_semantics_and_context.sql");
const MIGRATION_058 = resolve(MIGRATIONS_DIR, "058_finance_hardening.sql");
const DRYRUN_164 = resolve(ROOT, "tests", "migrations", "sql", "164-price-at-session-aware-dryrun.sql");

/** Production, read-only, 2026-11-06: md5(prosrc), length(prosrc) and proacl of public.price_at(text, timestamptz). */
const PROD_PROSRC_MD5 = "57f79dbd2e2845d01d44bce6c67d4354";
const PROD_PROSRC_LEN = 533;
const PROD_PROACL = "{postgres=X/postgres,service_role=X/postgres}";

const FN_MARKER = "create or replace function public.price_at(p_ticker text, p_ts timestamptz)";

const stripSqlComments = (sql: string): string => sql.replace(/--[^\n]*/g, "");
const norm = (sql: string): string => stripSqlComments(sql).replace(/\s+/g, " ").trim();
const md5 = (text: string): string => createHash("md5").update(text).digest("hex");

/** Blank out every single-quoted string literal, then every dollar-quoted block: the top-level statements only. */
function topLevel(sql: string): string {
  return stripSqlComments(sql)
    .replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, "$$$$")
    .replace(/'(?:[^']|'')*'/g, "''");
}

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

const sql164 = readFileSync(MIGRATION_164, "utf8");
const code164 = stripSqlComments(sql164);
const top164 = topLevel(sql164);
const n164 = norm(sql164);
const sql062 = readFileSync(MIGRATION_062, "utf8");
const sql058 = readFileSync(MIGRATION_058, "utf8");

/** 062's two lookups, as normalised text: the 5-minute bar WHERE ... LIMIT 1 and the daily-close WHERE ... LIMIT 1. */
const body062 = norm(functionBody(sql062));
const BAR_5M_LOOKUP = /where ticker = p_ticker and ts <= p_ts and ts >= p_ts - interval '4 days' order by ts desc limit 1/.exec(
  body062,
)?.[0] as string;
const DAILY_LOOKUP = /where ticker = p_ticker and day <= case when .*? end order by day desc limit 1/.exec(body062)?.[0] as string;

describe("164 price_at_session_aware: ledger and transaction", () => {
  it("records version 164 in the schema_migrations ledger, idempotently (095 pattern)", () => {
    expect(n164).toContain(
      "insert into supabase_migrations.schema_migrations (version, name) values ('164', '164_price_at_session_aware') on conflict do nothing;",
    );
  });

  it("is one transaction: a single begin, a single commit, the ledger row last", () => {
    expect([...code164.matchAll(/^\s*begin\s*;/gim)]).toHaveLength(1);
    expect([...code164.matchAll(/^\s*commit\s*;/gim)]).toHaveLength(1);
    expect(n164.slice(n164.indexOf("begin;")).endsWith("on conflict do nothing; commit;")).toBe(true);
  });

  it("is numbered after 163 and named for its file", () => {
    expect(FILE_164).toBe("164_price_at_session_aware.sql");
    const names = readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("164_"));
    expect(names).toEqual([FILE_164]);
  });
});

describe("164 price_at_session_aware: the production fingerprint it was built from", () => {
  it("062's function body is production's body: its md5 and length are the recorded prosrc", () => {
    const body = functionBody(sql062);
    expect(md5(body)).toBe(PROD_PROSRC_MD5);
    expect(body.length).toBe(PROD_PROSRC_LEN);
  });

  it("062 is the newest earlier migration that defines price_at (051 -> 062)", () => {
    const defs = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql") && f < FILE_164)
      .sort()
      .filter((f) =>
        /create\s+or\s+replace\s+function\s+public\.price_at\s*\(/i.test(
          stripSqlComments(readFileSync(resolve(MIGRATIONS_DIR, f), "utf8")),
        ),
      );
    expect(defs).toEqual(["051_finance_bars_and_speed.sql", "062_coverage_semantics_and_context.sql"]);
  });

  it("the header records the production md5(prosrc), length, proacl and the md5 of the new body", () => {
    expect(sql164).toContain(PROD_PROSRC_MD5);
    expect(sql164).toContain(`length ${PROD_PROSRC_LEN}`);
    expect(sql164).toContain(PROD_PROACL);
    const recorded = /new md5\(prosrc\):\s*([0-9a-f]{32})/.exec(sql164)?.[1];
    expect(recorded, "header line `new md5(prosrc): <32 hex>`").toBeDefined();
    expect(recorded).toBe(md5(functionBody(sql164)));
    expect(recorded).not.toBe(PROD_PROSRC_MD5);
  });

  it("the header says why: a stale 5-minute bar from an older session beat the newer daily close (DOHOL, SISE)", () => {
    expect(sql164).toContain("DOHOL");
    expect(sql164).toContain("SISE");
    expect(sql164).toContain("KARCL");
    expect(sql164).toMatch(/older session/i);
    expect(sql164).toMatch(/haberden/);
    expect(sql164).toContain("feed_reference_prices");
  });
});

describe("164 price_at_session_aware: the replaced function", () => {
  it("replaces exactly one function, with 062's signature, return type, language and volatility", () => {
    expect([...code164.matchAll(/\bcreate\s+(or\s+replace\s+)?function\b/gi)]).toHaveLength(1);
    expect(n164).toContain(
      "create or replace function public.price_at(p_ticker text, p_ts timestamptz) returns numeric language sql stable as $$",
    );
    const header062 = norm(functionStatement(sql062).split("as $$")[0] as string);
    const header164 = norm(functionStatement(sql164).split("as $$")[0] as string);
    expect(header164).toBe(header062);
  });

  it("keeps the owner and security of 062: SECURITY INVOKER, no SET clause, no security definer", () => {
    const stmt = norm(functionStatement(sql164));
    expect(stmt).not.toMatch(/security\s+definer/i);
    expect(stmt).not.toMatch(/\bset\s+search_path\b/i);
    expect(stmt).not.toMatch(/\bowner\s+to\b/i);
    expect(code164).not.toMatch(/\balter\s+function\b/i);
  });

  it("keeps 062's two lookups verbatim: the 4-day 5-minute window and the 18:10 Istanbul daily CASE", () => {
    expect(BAR_5M_LOOKUP, "062's 5-minute lookup text").toBeDefined();
    expect(DAILY_LOOKUP, "062's daily lookup text").toBeDefined();
    const body = norm(functionBody(sql164));
    expect(body).toContain(BAR_5M_LOOKUP);
    expect(body).toContain(DAILY_LOOKUP);
    expect(body).toContain("interval '4 days'");
    expect(body).toContain("time '18:10'");
    expect(body).toContain("'Europe/Istanbul'");
    expect(body).toContain("from public.bist_bars_5m");
    expect(body).toContain("from public.bist_bars_daily");
  });

  it("a bar wins only at or after 18:00 Istanbul (the closing-auction bar) of the daily row's day, or when there is no daily row", () => {
    const body = norm(functionBody(sql164));
    expect(body).toContain(
      "when b.ts is not null and (d.day is null or b.ts >= (d.day + time '18:00') at time zone 'Europe/Istanbul') then b.close else d.close end",
    );
    // the threshold is in Istanbul time, never UTC, and never a date comparison
    expect(body).not.toMatch(/b\.ts\s*::\s*date/);
    expect(body).not.toMatch(/::date\s*>=\s*d\.day/);
    expect(body).not.toMatch(/at time zone 'utc'/i);
  });

  it("returns a single scalar row even when neither source has data (left joins from a one-row relation)", () => {
    // whitespace just inside parentheses is not significant
    const body = norm(functionBody(sql164)).replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
    expect(body).toMatch(/from \(select 1\) \w+ left join \(select ts, close from public\.bist_bars_5m /);
    expect(body).toMatch(/\) b on true left join \(select day, close from public\.bist_bars_daily /);
    expect(body).toMatch(/\) d on true;?$/);
  });

  it("does not use coalesce any more: the 5-minute bar no longer wins by default", () => {
    expect(norm(functionBody(sql164))).not.toMatch(/\bcoalesce\s*\(/i);
  });
});

describe("164 price_at_session_aware: grants", () => {
  it("restates 058's revoke and grant for price_at(text, timestamptz), statement for statement, for that function only", () => {
    expect(n164).toContain("revoke execute on function public.price_at(text, timestamptz) from anon, authenticated, public;");
    expect(n164).toContain("grant execute on function public.price_at(text, timestamptz) to service_role;");
    // 058 names this very function in its multi-function revoke and grant
    const n058 = norm(sql058);
    expect(n058).toContain("public.price_at(text, timestamptz),");
    expect(n058).toContain("from anon, authenticated, public;");
    expect(n058).toContain("to service_role;");
  });

  it("grants only to service_role, nothing to anon, authenticated or public, and the grants come after the function", () => {
    const grants = [...code164.matchAll(/\bgrant\b[^;]*;/gi)].map((m) => norm(m[0]));
    expect(grants).toEqual(["grant execute on function public.price_at(text, timestamptz) to service_role;"]);
    const revokes = [...code164.matchAll(/\brevoke\b[^;]*;/gi)].map((m) => norm(m[0]));
    expect(revokes).toEqual(["revoke execute on function public.price_at(text, timestamptz) from anon, authenticated, public;"]);
    expect(code164.indexOf("revoke execute")).toBeGreaterThan(code164.indexOf("create or replace function"));
    expect(code164.indexOf("grant execute")).toBeGreaterThan(code164.indexOf("revoke execute"));
    expect(code164).not.toMatch(/alter\s+default\s+privileges/i);
  });
});

describe("164 price_at_session_aware: additive, nothing else touched", () => {
  it("has no drop, update, delete or truncate statement, and no insert but the one ledger row", () => {
    // topLevel() blanks string literals, so the ledger statement reads: values ('', '')
    const ledger = /\binsert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*''\s*,\s*''\s*\)\s*on\s+conflict\s+do\s+nothing\s*;/gi;
    expect([...top164.matchAll(ledger)]).toHaveLength(1);
    expect(top164.replace(ledger, "")).not.toMatch(/\binsert\b/i);
    expect(top164).not.toMatch(/\bdrop\b/i);
    expect(top164).not.toMatch(/\bupdate\b/i);
    expect(top164).not.toMatch(/\bdelete\b/i);
    expect(top164).not.toMatch(/\btruncate\b/i);
    // and none inside the function body either
    const body = norm(functionBody(sql164));
    expect(body).not.toMatch(/\b(drop|insert|update|delete|truncate)\b/i);
  });

  it("creates no table, index, view, trigger or cron job and alters no table", () => {
    expect(code164).not.toMatch(/\bcreate\s+(unique\s+)?(table|index|view|trigger|materialized|extension|policy)\b/i);
    expect(code164).not.toMatch(/\bcron\./i);
    expect(code164).not.toMatch(/\balter\s+table\b/i);
  });

  it("never redefines or mentions its callers or the other finance functions in code", () => {
    expect(code164).not.toMatch(/feed_reference_prices|bar_returns|bist_intraday_targets|bist_daily_targets|econ_feed/i);
  });
});

describe("164 price_at_session_aware: dry-run script", () => {
  const dry = existsSync(DRYRUN_164) ? readFileSync(DRYRUN_164, "utf8") : "";

  it("ships the local PG15 dry-run: 062's function as production has it, 164 twice, ending in DRYRUN 164 OK", () => {
    expect(existsSync(DRYRUN_164)).toBe(true);
    expect(dry).toContain(PROD_PROSRC_MD5);
    expect(dry.match(/\\ir \.\.\/\.\.\/\.\.\/supabase\/migrations\/164_price_at_session_aware\.sql/g)).toHaveLength(2);
    expect(dry.trimEnd().endsWith("select 'DRYRUN 164 OK';")).toBe(true);
  });

  it("asserts the two production cases against the daily row, not a literal (5-minute bars get pruned)", () => {
    expect(dry).toContain("DOHOL");
    expect(dry).toContain("SISE");
    expect(dry).toMatch(/bist_bars_daily/);
    expect(dry).toContain("rollback;");
  });
});

// ---------------------------------------------------------------------------
// Live block (opt-in). TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/PGDATABASE point at a
// THROWAWAY database that tests/migrations/sql/164-price-at-session-aware-dryrun.sql built (the stub,
// bist_bars_5m / bist_bars_daily, 062's function as production has it, then 164 applied twice). Every
// scenario that writes sits inside one transaction that is rolled back.
// ---------------------------------------------------------------------------
describe.runIf(Boolean(process.env.TAYF_PSQL))("164 against a live Postgres (164 applied)", () => {
  assertLiveReady("164", {
    ledger: ["164"],
    relations: ["public.bist_bars_5m", "public.bist_bars_daily"],
    functions: ["public.price_at(text,timestamp with time zone)"],
  });

  function runPsql(input: string): string {
    return execFileSync(process.env.TAYF_PSQL as string, ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      input,
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8" },
      maxBuffer: 8 * 1024 * 1024,
    });
  }
  const lines = (out: string, tag: string): string[] =>
    out.split("\n").filter((l) => l.startsWith(`${tag}|`)).map((l) => l.slice(tag.length + 1));

  /** Fixture rows (daily and 5-minute bars), the reads, always rolled back. */
  const inTx = (body: string): string => `
begin;
${body}
rollback;
`;
  const daily = (ticker: string, rows: [string, number][]): string =>
    `insert into public.bist_bars_daily (ticker, day, close) values ${rows.map(([d, c]) => `('${ticker}', date '${d}', ${c})`).join(", ")};`;
  const bars = (ticker: string, rows: [string, number][]): string =>
    `insert into public.bist_bars_5m (ticker, ts, close) values ${rows.map(([t, c]) => `('${ticker}', timestamptz '${t}', ${c})`).join(", ")};`;
  const price = (tag: string, ticker: string, ts: string): string =>
    `select '${tag}', coalesce(public.price_at('${ticker}', timestamptz '${ts}')::text, 'null');`;

  it("DOHOL (h48-ekonomi-1): a 5-minute bar from 3 Nov no longer beats the 5 Nov daily close", () => {
    const out = runPsql(
      inTx(`
${daily("DOHOL", [["2026-11-03", 16.38], ["2026-11-04", 17.27], ["2026-11-05", 17.56]])}
${bars("DOHOL", [["2026-11-03 13:00:00+00", 16.0], ["2026-11-03 13:05:00+00", 16.1]])}
${price("after", "DOHOL", "2026-11-05 22:08:00+00")}
`),
    );
    // 62's coalesce returned 16.1000 (the 13:05Z bar, two sessions old)
    expect(lines(out, "after")).toEqual(["17.5600"]);
  });

  it("SISE (h48-ekonomi-1): a 5-minute bar from 2 Nov ending 13:45Z no longer beats the 5 Nov daily close", () => {
    const out = runPsql(
      inTx(`
${daily("SISE", [["2026-11-02", 33.42], ["2026-11-03", 34.0], ["2026-11-04", 35.0], ["2026-11-05", 35.42]])}
${bars("SISE", [["2026-11-02 13:40:00+00", 33.39], ["2026-11-02 13:45:00+00", 33.4]])}
${price("after", "SISE", "2026-11-05 21:00:00+00")}
`),
    );
    expect(lines(out, "after")).toEqual(["35.4200"]);
  });

  it("intraday is unchanged: a bar from the same session as p_ts wins over the previous day's daily close", () => {
    const out = runPsql(
      inTx(`
${daily("AKBNK", [["2026-11-04", 100]])}
${bars("AKBNK", [["2026-11-05 06:50:00+00", 100.9], ["2026-11-05 06:55:00+00", 101]])}
${price("mid", "AKBNK", "2026-11-05 07:00:00+00")}
`),
    );
    expect(lines(out, "mid")).toEqual(["101.0000"]);
  });

  it("after the close, a 17:55 Istanbul bar (not the closing-auction bar) loses to that day's daily close", () => {
    const out = runPsql(
      inTx(`
${daily("GARAN", [["2026-11-05", 105]])}
${bars("GARAN", [["2026-11-05 14:55:00+00", 104.5]])}
${price("late", "GARAN", "2026-11-05 16:30:00+00")}
`),
    );
    // 062 and the first cut of 164 returned 104.5000 (the 17:55 bar beat the same day's close)
    expect(lines(out, "late")).toEqual(["105.0000"]);
  });

  it("after the close, the 18:00 Istanbul closing-auction bar of the daily day still wins", () => {
    const out = runPsql(
      inTx(`
${daily("YKBNK", [["2026-11-05", 105]])}
${bars("YKBNK", [["2026-11-05 14:55:00+00", 104.5], ["2026-11-05 15:00:00+00", 104.9]])}
${price("auction", "YKBNK", "2026-11-05 16:30:00+00")}
`),
    );
    expect(lines(out, "auction")).toEqual(["104.9000"]);
  });

  it("puts the 18:00 threshold in ISTANBUL time: a 15:00Z bar is the closing auction, not a UTC afternoon bar", () => {
    const out = runPsql(
      inTx(`
${daily("THYAO", [["2026-11-05", 105]])}
${bars("THYAO", [["2026-11-05 15:00:00+00", 104]])}
${price("edge", "THYAO", "2026-11-05 16:30:00+00")}
`),
    );
    // a UTC conversion puts the threshold at 18:00Z (21:00 Istanbul) and would wrongly pick the daily 105
    expect(lines(out, "edge")).toEqual(["104.0000"]);
  });

  it("a mid-session bar of the daily day loses to that day's close, and so does the day before's", () => {
    const out = runPsql(
      inTx(`
${daily("EREGL", [["2026-11-05", 50]])}
${bars("EREGL", [["2026-11-05 09:00:00+00", 49]])}
${daily("ASELS", [["2026-11-05", 60]])}
${bars("ASELS", [["2026-11-04 14:55:00+00", 59]])}
${price("same", "EREGL", "2026-11-05 16:30:00+00")}
${price("older", "ASELS", "2026-11-05 16:30:00+00")}
`),
    );
    // 09:00Z is 12:00 Istanbul on the daily day: before the closing auction
    expect(lines(out, "same")).toEqual(["50.0000"]);
    expect(lines(out, "older")).toEqual(["60.0000"]);
  });

  it("KARCL (4 Nov): a mid-session dropout bar at 10:05 Istanbul loses to that day's close afterwards, and wins intraday", () => {
    const out = runPsql(
      inTx(`
${daily("KARCL", [["2026-11-03", 26], ["2026-11-04", 28.6]])}
${bars("KARCL", [["2026-11-04 07:05:00+00", 26.58]])}
${price("evening", "KARCL", "2026-11-04 18:01:25+00")}
${price("nextmorning", "KARCL", "2026-11-05 06:30:00+00")}
${price("intraday", "KARCL", "2026-11-04 08:00:00+00")}
`),
    );
    expect(lines(out, "evening")).toEqual(["28.6000"]);
    expect(lines(out, "nextmorning")).toEqual(["28.6000"]);
    // 11:00 Istanbul on 4 Nov: reference day 3 Nov, the 10:05 bar is newer than the 3 Nov 18:00 threshold
    expect(lines(out, "intraday")).toEqual(["26.5800"]);
  });

  it("with no daily row at or before the reference day, the 5-minute bar is used", () => {
    const out = runPsql(
      inTx(`
${bars("DOHOL", [["2026-11-03 13:05:00+00", 16.1]])}
${price("nodaily", "DOHOL", "2026-11-04 08:00:00+00")}
${daily("DOHOL", [["2026-11-05", 17.56]])}
${price("future_daily", "DOHOL", "2026-11-04 08:00:00+00")}
`),
    );
    // the 5 Nov daily row is after the reference day (3 Nov), so it is not a candidate either
    expect(lines(out, "nodaily")).toEqual(["16.1000"]);
    expect(lines(out, "future_daily")).toEqual(["16.1000"]);
  });

  it("with no 5-minute bar, the daily close of the reference day is returned (before 18:10 the previous day, from 18:10 the same day)", () => {
    const out = runPsql(
      inTx(`
${daily("KCHOL", [["2026-11-03", 10], ["2026-11-04", 11], ["2026-11-05", 12]])}
${price("morning", "KCHOL", "2026-11-05 07:00:00+00")}
${price("before1810", "KCHOL", "2026-11-05 15:09:00+00")}
${price("at1810", "KCHOL", "2026-11-05 15:10:00+00")}
`),
    );
    expect(lines(out, "morning")).toEqual(["11.0000"]);
    expect(lines(out, "before1810")).toEqual(["11.0000"]);
    expect(lines(out, "at1810")).toEqual(["12.0000"]);
  });

  it("returns null when neither a bar nor a daily row exists, and ignores other tickers", () => {
    const out = runPsql(
      inTx(`
${daily("OTHER", [["2026-11-04", 1]])}
${bars("OTHER", [["2026-11-05 07:00:00+00", 2]])}
${price("none", "NOPE", "2026-11-05 22:00:00+00")}
${price("isolated", "SAHOL", "2026-11-05 22:00:00+00")}
`),
    );
    expect(lines(out, "none")).toEqual(["null"]);
    expect(lines(out, "isolated")).toEqual(["null"]);
  });

  it("looks at no future data: a bar after p_ts is ignored, and so is a daily row after the reference day", () => {
    const out = runPsql(
      inTx(`
${daily("BIMAS", [["2026-11-04", 200], ["2026-11-05", 210]])}
${bars("BIMAS", [["2026-11-05 12:00:00+00", 205]])}
${price("early", "BIMAS", "2026-11-05 10:00:00+00")}
`),
    );
    // 13:00 Istanbul, before 18:10: reference day 4 Nov; the 12:00Z bar is in the future of p_ts
    expect(lines(out, "early")).toEqual(["200.0000"]);
  });

  it("the 4-day lookback is kept: a bar older than 4 days is ignored (and the daily close is returned)", () => {
    const out = runPsql(
      inTx(`
${daily("PGSUS", [["2026-11-04", 300]])}
${bars("PGSUS", [["2026-10-30 12:00:00+00", 290]])}
${price("old", "PGSUS", "2026-11-05 07:00:00+00")}
`),
    );
    expect(lines(out, "old")).toEqual(["300.0000"]);
  });

  it("has 062's attributes: invoker, stable, no SET clause, returns numeric, sql, and the new body", () => {
    const out = runPsql(`
select 'attrs', p.prosecdef, p.provolatile, coalesce(p.proconfig::text, 'null'), p.proretset,
       pg_get_function_result(p.oid), pg_get_function_arguments(p.oid), l.lanname, md5(p.prosrc)
  from pg_proc p join pg_language l on l.oid = p.prolang
 where p.oid = 'public.price_at(text, timestamptz)'::regprocedure;
select 'overloads', count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'price_at';
`);
    expect(lines(out, "attrs")).toEqual([
      `f|s|null|f|numeric|p_ticker text, p_ts timestamp with time zone|sql|${md5(functionBody(sql164))}`,
    ]);
    expect(lines(out, "overloads")).toEqual(["1"]);
  });

  it("is service_role only, as production has it (anon, authenticated and public cannot execute)", () => {
    const out = runPsql(`
select 'priv',
  has_function_privilege('anon', 'public.price_at(text, timestamptz)', 'execute'),
  has_function_privilege('authenticated', 'public.price_at(text, timestamptz)', 'execute'),
  has_function_privilege('service_role', 'public.price_at(text, timestamptz)', 'execute');
select 'grantees', coalesce(string_agg(g, ',' order by g), '')
  from (select case when a.grantee = 0 then 'public' else a.grantee::regrole::text end as g
          from pg_proc p, aclexplode(p.proacl) a
         where p.oid = 'public.price_at(text, timestamptz)'::regprocedure and a.grantee <> p.proowner) s;
`);
    expect(lines(out, "priv")).toEqual(["f|f|t"]);
    expect(lines(out, "grantees")).toEqual(["service_role"]);
  });

  it("the ledger row is there once", () => {
    expect(runPsql("select count(*) from supabase_migrations.schema_migrations where version = '164';").trim()).toBe("1");
  });
});
