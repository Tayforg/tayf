import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Contract test for migration 187 ("price_at_daily_close_wins"), h99-financenumbers-3.
//
// public.price_at(ticker, ts) is the reference price of the /ekonomi "haberden" chip (the move since
// the headline). 164 lets a 5-minute bar win when it is at or after 18:00 Istanbul of the newest daily row's
// day, taking that bar for the closing-auction print. In production bist_bars_5m holds an 18:00 bar for most
// tickers and it is very often a volume-0 stub (open = high = low = close) that differs from the settled
// close: VAKBN 2026-11-06 18:00 bar 33.04, bist_bars_daily close 33.06 (Yahoo: 33,06). A headline after the
// close was then measured from 33.04: "+%0,73 haberden" beside a +%0,67 day move.
//
// 187 changes only the CASE: a bar wins when it exists and (there is no daily row, or the Istanbul calendar
// date of the bar is LATER than the daily row's day); otherwise the daily close is returned. A completed
// session's settled close beats every bar of that session; a bar of a later session than the newest daily row
// (the live intraday case, and the window between 18:10 and the daily bar's arrival) still wins.
//
// This file pins: one transaction, the function, its grants and the ledger row; that the replaced function
// keeps 164's signature, language, volatility and security (and that 164's body is the production body, by
// md5); that the new body is 164's body with exactly the CASE replaced, both lookups verbatim; the revoke and
// grant of 058; that nothing is dropped, updated or deleted and the only insert is the ledger row; and, in the
// opt-in live block (TAYF_PSQL), the behaviour on a throwaway Postgres, including the production cases.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const FILE_187 = "187_price_at_daily_close_wins.sql";
const MIGRATION_187 = resolve(MIGRATIONS_DIR, FILE_187);
const MIGRATION_164 = resolve(MIGRATIONS_DIR, "164_price_at_session_aware.sql");
const MIGRATION_062 = resolve(MIGRATIONS_DIR, "062_coverage_semantics_and_context.sql");
const MIGRATION_058 = resolve(MIGRATIONS_DIR, "058_finance_hardening.sql");
const DRYRUN_187 = resolve(ROOT, "tests", "migrations", "sql", "187-price-at-daily-close-wins-dryrun.sql");
const MANIFEST = resolve(ROOT, "tests", "migrations", "sql", "live-manifest.txt");

/** Production, read-only, 2026-11-09: md5(prosrc), length(prosrc) and proacl of public.price_at(text, timestamptz). */
const PROD_PROSRC_MD5 = "062c2405345dd5e61a3bdb11f6474eb5";
const PROD_PROSRC_LEN = 827;
const PROD_PROACL = "{postgres=X/postgres,service_role=X/postgres}";

const FN_MARKER = "create or replace function public.price_at(p_ticker text, p_ts timestamptz)";

/** 164's CASE and 187's CASE, as normalised text: the only thing that differs between the two bodies. */
const CASE_164 =
  "case when b.ts is not null and (d.day is null or b.ts >= (d.day + time '18:00') at time zone 'Europe/Istanbul') then b.close else d.close end";
const CASE_187 =
  "case when b.ts is not null and (d.day is null or (b.ts at time zone 'Europe/Istanbul')::date > d.day) then b.close else d.close end";

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

const sql187 = readFileSync(MIGRATION_187, "utf8");
const code187 = stripSqlComments(sql187);
const top187 = topLevel(sql187);
const n187 = norm(sql187);
const sql164 = readFileSync(MIGRATION_164, "utf8");
const sql062 = readFileSync(MIGRATION_062, "utf8");
const sql058 = readFileSync(MIGRATION_058, "utf8");

const body164 = norm(functionBody(sql164));
const body187 = norm(functionBody(sql187));
/** 164's two lookups, as normalised text: the 5-minute bar WHERE ... LIMIT 1 and the daily-close WHERE ... LIMIT 1. */
const BAR_5M_LOOKUP = /where ticker = p_ticker and ts <= p_ts and ts >= p_ts - interval '4 days' order by ts desc limit 1/.exec(
  body164,
)?.[0] as string;
const DAILY_LOOKUP = /where ticker = p_ticker and day <= case when .*? end order by day desc limit 1/.exec(body164)?.[0] as string;

describe("187 price_at_daily_close_wins: ledger and transaction", () => {
  it("records version 187 in the schema_migrations ledger, idempotently (095 pattern)", () => {
    expect(n187).toContain(
      "insert into supabase_migrations.schema_migrations (version, name) values ('187', '187_price_at_daily_close_wins') on conflict do nothing;",
    );
  });

  it("is one transaction: a single begin, a single commit, the ledger row last", () => {
    expect([...code187.matchAll(/^\s*begin\s*;/gim)]).toHaveLength(1);
    expect([...code187.matchAll(/^\s*commit\s*;/gim)]).toHaveLength(1);
    expect(n187.slice(n187.indexOf("begin;")).endsWith("on conflict do nothing; commit;")).toBe(true);
  });

  it("is named for its file and is the only migration numbered 187", () => {
    expect(FILE_187).toBe("187_price_at_daily_close_wins.sql");
    const names = readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("187_"));
    expect(names).toEqual([FILE_187]);
  });
});

describe("187 price_at_daily_close_wins: the production fingerprint it was built from", () => {
  it("164's function body is production's body: its md5 and length are the recorded prosrc", () => {
    const body = functionBody(sql164);
    expect(md5(body)).toBe(PROD_PROSRC_MD5);
    expect(body.length).toBe(PROD_PROSRC_LEN);
  });

  it("164 is the newest earlier migration that defines price_at (051 -> 062 -> 164)", () => {
    const defs = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql") && f < FILE_187)
      .sort()
      .filter((f) =>
        /create\s+or\s+replace\s+function\s+public\.price_at\s*\(/i.test(
          stripSqlComments(readFileSync(resolve(MIGRATIONS_DIR, f), "utf8")),
        ),
      );
    expect(defs).toEqual([
      "051_finance_bars_and_speed.sql",
      "062_coverage_semantics_and_context.sql",
      "164_price_at_session_aware.sql",
    ]);
  });

  it("the header records the production md5(prosrc), length, proacl and the md5 and length of the new body", () => {
    expect(sql187).toContain(PROD_PROSRC_MD5);
    expect(sql187).toContain(`length ${PROD_PROSRC_LEN}`);
    expect(sql187).toContain(PROD_PROACL);
    const body = functionBody(sql187);
    const recorded = /new md5\(prosrc\):\s*([0-9a-f]{32}) \(length (\d+)\)/.exec(sql187);
    expect(recorded, "header line `new md5(prosrc): <32 hex> (length N)`").not.toBeNull();
    expect(recorded?.[1]).toBe(md5(body));
    expect(Number(recorded?.[2])).toBe(body.length);
    expect(recorded?.[1]).not.toBe(PROD_PROSRC_MD5);
  });

  it("the header says why: an 18:00 volume-0 stub bar beat the settled daily close (VAKBN 33.04 vs 33.06)", () => {
    expect(sql187).toContain("VAKBN");
    expect(sql187).toContain("33.04");
    expect(sql187).toContain("33.06");
    expect(sql187).toMatch(/volume 0/i);
    expect(sql187).toMatch(/stub/i);
    expect(sql187).toMatch(/haberden/);
    expect(sql187).toContain("feed_reference_prices");
  });

  it("the header carries a REPLAY and a ROLLBACK note that names 164's statement", () => {
    expect(sql187).toMatch(/^-- REPLAY/m);
    expect(sql187).toMatch(/pairs/);
    expect(sql187).toMatch(/^-- ROLLBACK/m);
    expect(sql187).toContain("164");
  });
});

describe("187 price_at_daily_close_wins: the replaced function", () => {
  it("replaces exactly one function, with 164's signature, return type, language and volatility", () => {
    expect([...code187.matchAll(/\bcreate\s+(or\s+replace\s+)?function\b/gi)]).toHaveLength(1);
    expect(n187).toContain(
      "create or replace function public.price_at(p_ticker text, p_ts timestamptz) returns numeric language sql stable as $$",
    );
    const header164 = norm(functionStatement(sql164).split("as $$")[0] as string);
    const header187 = norm(functionStatement(sql187).split("as $$")[0] as string);
    expect(header187).toBe(header164);
  });

  it("keeps the owner and security of 164: SECURITY INVOKER, no SET clause, no security definer", () => {
    const stmt = norm(functionStatement(sql187));
    expect(stmt).not.toMatch(/security\s+definer/i);
    expect(stmt).not.toMatch(/\bset\s+search_path\b/i);
    expect(stmt).not.toMatch(/\bowner\s+to\b/i);
    expect(code187).not.toMatch(/\balter\s+function\b/i);
  });

  it("keeps 164's two lookups verbatim: the 4-day 5-minute window and the 18:10 Istanbul daily CASE", () => {
    expect(BAR_5M_LOOKUP, "164's 5-minute lookup text").toBeDefined();
    expect(DAILY_LOOKUP, "164's daily lookup text").toBeDefined();
    expect(body187).toContain(BAR_5M_LOOKUP);
    expect(body187).toContain(DAILY_LOOKUP);
    expect(body187).toContain("interval '4 days'");
    expect(body187).toContain("time '18:10'");
    expect(body187).toContain("'Europe/Istanbul'");
    expect(body187).toContain("from public.bist_bars_5m");
    expect(body187).toContain("from public.bist_bars_daily");
    // and they are still 062's lookups, text for text
    const body062 = norm(functionBody(sql062));
    expect(body062).toContain(BAR_5M_LOOKUP);
    expect(body062).toContain(DAILY_LOOKUP);
  });

  it("is 164's body with exactly the CASE replaced, nothing else changed", () => {
    expect(body164).toContain(CASE_164);
    expect(body187).toContain(CASE_187);
    expect(body164.replace(CASE_164, CASE_187)).toBe(body187);
  });

  it("a bar wins only when it is from a LATER Istanbul calendar day than the daily row (or there is no daily row)", () => {
    expect(body187).toContain(
      "when b.ts is not null and (d.day is null or (b.ts at time zone 'Europe/Istanbul')::date > d.day) then b.close else d.close end",
    );
    expect(body187).toContain("::date > d.day");
    // the 18:00 rule of 164 is gone: no time threshold on the bar, and no UTC conversion
    expect(body187).not.toContain("time '18:00'");
    expect(body187).not.toMatch(/b\.ts\s*>=/);
    expect(body187).not.toMatch(/d\.day\s*\+\s*time/);
    expect(body187).not.toMatch(/at time zone 'utc'/i);
    // the date is taken in Istanbul time, never from a bare timestamp cast
    expect(body187).not.toMatch(/b\.ts\s*::\s*date/);
  });

  it("returns a single scalar row even when neither source has data (left joins from a one-row relation)", () => {
    // whitespace just inside parentheses is not significant
    const body = body187.replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
    expect(body).toMatch(/from \(select 1\) \w+ left join \(select ts, close from public\.bist_bars_5m /);
    expect(body).toMatch(/\) b on true left join \(select day, close from public\.bist_bars_daily /);
    expect(body).toMatch(/\) d on true;?$/);
  });

  it("does not use coalesce: the 5-minute bar never wins by default", () => {
    expect(body187).not.toMatch(/\bcoalesce\s*\(/i);
  });
});

describe("187 price_at_daily_close_wins: grants", () => {
  it("restates 058's revoke and grant for price_at(text, timestamptz), statement for statement, for that function only", () => {
    expect(n187).toContain("revoke execute on function public.price_at(text, timestamptz) from anon, authenticated, public;");
    expect(n187).toContain("grant execute on function public.price_at(text, timestamptz) to service_role;");
    // 058 names this very function in its multi-function revoke and grant
    const n058 = norm(sql058);
    expect(n058).toContain("public.price_at(text, timestamptz),");
    expect(n058).toContain("from anon, authenticated, public;");
    expect(n058).toContain("to service_role;");
  });

  it("grants only to service_role, nothing to anon, authenticated or public, and the grants come after the function", () => {
    const grants = [...code187.matchAll(/\bgrant\b[^;]*;/gi)].map((m) => norm(m[0]));
    expect(grants).toEqual(["grant execute on function public.price_at(text, timestamptz) to service_role;"]);
    const revokes = [...code187.matchAll(/\brevoke\b[^;]*;/gi)].map((m) => norm(m[0]));
    expect(revokes).toEqual(["revoke execute on function public.price_at(text, timestamptz) from anon, authenticated, public;"]);
    expect(code187.indexOf("revoke execute")).toBeGreaterThan(code187.indexOf("create or replace function"));
    expect(code187.indexOf("grant execute")).toBeGreaterThan(code187.indexOf("revoke execute"));
    expect(code187).not.toMatch(/alter\s+default\s+privileges/i);
  });
});

describe("187 price_at_daily_close_wins: function replacement only, nothing else touched", () => {
  it("has no drop, update, delete or truncate statement, and no insert but the one ledger row", () => {
    // topLevel() blanks string literals, so the ledger statement reads: values ('', '')
    const ledger = /\binsert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*''\s*,\s*''\s*\)\s*on\s+conflict\s+do\s+nothing\s*;/gi;
    expect([...top187.matchAll(ledger)]).toHaveLength(1);
    expect(top187.replace(ledger, "")).not.toMatch(/\binsert\b/i);
    expect(top187).not.toMatch(/\bdrop\b/i);
    expect(top187).not.toMatch(/\bupdate\b/i);
    expect(top187).not.toMatch(/\bdelete\b/i);
    expect(top187).not.toMatch(/\btruncate\b/i);
    // and none inside the function body either
    expect(body187).not.toMatch(/\b(drop|insert|update|delete|truncate)\b/i);
  });

  it("creates no table, index, view, trigger or cron job and alters no table", () => {
    expect(code187).not.toMatch(/\bcreate\s+(unique\s+)?(table|index|view|trigger|materialized|extension|policy)\b/i);
    expect(code187).not.toMatch(/\bcron\./i);
    expect(code187).not.toMatch(/\balter\s+table\b/i);
  });

  it("never redefines or mentions its callers or the other finance functions in code", () => {
    expect(code187).not.toMatch(/feed_reference_prices|bar_returns|bist_intraday_targets|bist_daily_targets|econ_feed/i);
  });
});

describe("187 price_at_daily_close_wins: dry-run script and live manifest", () => {
  const dry = existsSync(DRYRUN_187) ? readFileSync(DRYRUN_187, "utf8") : "";

  it("ships the local PG15 dry-run: 164's function as production has it, 187 twice, ending in DRYRUN 187 OK", () => {
    expect(existsSync(DRYRUN_187)).toBe(true);
    expect(dry).toContain(PROD_PROSRC_MD5);
    expect(dry.match(/\\ir \.\.\/\.\.\/\.\.\/supabase\/migrations\/187_price_at_daily_close_wins\.sql/g)).toHaveLength(2);
    expect(dry.trimEnd().endsWith("select 'DRYRUN 187 OK';")).toBe(true);
  });

  it("asserts the production case against the daily row, not a literal, and rolls its fixtures back", () => {
    expect(dry).toContain("VAKBN");
    expect(dry).toMatch(/bist_bars_daily/);
    expect(dry).toContain("rollback;");
  });

  it("has a live-manifest entry that runs this file with the dry-run as its setup", () => {
    const manifest = readFileSync(MANIFEST, "utf8");
    expect(manifest).toContain(
      "run | 187-price-at-daily-close-wins.test.ts | tests/migrations/sql/187-price-at-daily-close-wins-dryrun.sql | - | 0",
    );
  });
});

// ---------------------------------------------------------------------------
// Live block (opt-in). TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/PGDATABASE point at a
// THROWAWAY database that tests/migrations/sql/187-price-at-daily-close-wins-dryrun.sql built (the stub,
// bist_bars_5m / bist_bars_daily, price_at as production has it, then 187 applied twice). Every
// scenario that writes sits inside one transaction that is rolled back.
// ---------------------------------------------------------------------------
describe.runIf(Boolean(process.env.TAYF_PSQL))("187 against a live Postgres (187 applied)", () => {
  assertLiveReady("187", {
    ledger: ["187"],
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
  /** A bar with an explicit volume (the stub bars of production carry volume 0). */
  const barVol = (ticker: string, ts: string, close: number, volume: number): string =>
    `insert into public.bist_bars_5m (ticker, ts, open, high, low, close, volume) values ('${ticker}', timestamptz '${ts}', ${close}, ${close}, ${close}, ${close}, ${volume});`;
  const price = (tag: string, ticker: string, ts: string): string =>
    `select '${tag}', coalesce(public.price_at('${ticker}', timestamptz '${ts}')::text, 'null');`;

  it("VAKBN (h99-financenumbers-3): the volume-0 18:00 stub of 6 Nov no longer beats that day's settled close, on a Sunday and on Monday 00:00", () => {
    const out = runPsql(
      inTx(`
${daily("VAKBN", [["2026-11-05", 31.8], ["2026-11-06", 33.06]])}
${bars("VAKBN", [["2026-11-06 14:50:00+00", 32.94], ["2026-11-06 14:55:00+00", 33.02]])}
${barVol("VAKBN", "2026-11-06 18:00:00+03", 33.04, 0)}
${price("sunday", "VAKBN", "2026-11-08 12:32:00+03")}
${price("monday0000", "VAKBN", "2026-11-09 00:00:00+03")}
${price("friday_evening", "VAKBN", "2026-11-06 21:00:00+03")}
`),
    );
    // 164 returned 33.0400 (the stub) for all three
    expect(lines(out, "sunday")).toEqual(["33.0600"]);
    expect(lines(out, "monday0000")).toEqual(["33.0600"]);
    expect(lines(out, "friday_evening")).toEqual(["33.0600"]);
  });

  it("intraday is unchanged: a bar of a later session than the newest daily row wins (Monday 10:05 bar, Friday daily row)", () => {
    const out = runPsql(
      inTx(`
${daily("VAKBN", [["2026-11-06", 33.06]])}
${barVol("VAKBN", "2026-11-06 18:00:00+03", 33.04, 0)}
${bars("VAKBN", [["2026-11-09 10:05:00+03", 33.3]])}
${price("monday", "VAKBN", "2026-11-09 10:10:00+03")}
${price("monday_before_bar", "VAKBN", "2026-11-09 10:00:00+03")}
`),
    );
    expect(lines(out, "monday")).toEqual(["33.3000"]);
    // before the 10:05 bar exists the Friday daily close is what is left (it beats the stub)
    expect(lines(out, "monday_before_bar")).toEqual(["33.0600"]);
  });

  it("with no daily row at or before the reference day, the 5-minute bar is used; with neither, null", () => {
    const out = runPsql(
      inTx(`
${bars("DOHOL", [["2026-11-03 13:05:00+00", 16.1]])}
${price("nodaily", "DOHOL", "2026-11-04 08:00:00+00")}
${daily("DOHOL", [["2026-11-05", 17.56]])}
${price("future_daily", "DOHOL", "2026-11-04 08:00:00+00")}
${price("none", "NOPE", "2026-11-05 22:00:00+00")}
`),
    );
    // the 5 Nov daily row is after the reference day (3 Nov), so it is not a candidate either
    expect(lines(out, "nodaily")).toEqual(["16.1000"]);
    expect(lines(out, "future_daily")).toEqual(["16.1000"]);
    expect(lines(out, "none")).toEqual(["null"]);
  });

  it("between 18:10 and the daily bar's arrival the 18:00 bar of today is used, and the daily close replaces it once it lands", () => {
    const out = runPsql(
      inTx(`
${daily("VAKBN", [["2026-11-05", 31.8]])}
${barVol("VAKBN", "2026-11-06 18:00:00+03", 33.04, 0)}
${price("before_daily", "VAKBN", "2026-11-06 19:00:00+03")}
${daily("VAKBN", [["2026-11-06", 33.06]])}
${price("after_daily", "VAKBN", "2026-11-06 19:00:00+03")}
`),
    );
    expect(lines(out, "before_daily")).toEqual(["33.0400"]);
    expect(lines(out, "after_daily")).toEqual(["33.0600"]);
  });

  it("after the close, neither the 17:55 bar nor the 18:00 closing-auction bar (with volume) of the daily day beats that day's daily close", () => {
    const out = runPsql(
      inTx(`
${daily("GARAN", [["2026-11-05", 105]])}
${bars("GARAN", [["2026-11-05 14:55:00+00", 104.5]])}
${price("late", "GARAN", "2026-11-05 16:30:00+00")}
${daily("YKBNK", [["2026-11-05", 105]])}
${bars("YKBNK", [["2026-11-05 14:55:00+00", 104.5]])}
${barVol("YKBNK", "2026-11-05 15:00:00+00", 104.9, 125000)}
${price("auction", "YKBNK", "2026-11-05 16:30:00+00")}
`),
    );
    expect(lines(out, "late")).toEqual(["105.0000"]);
    // 164 returned 104.9000: the settled daily row is the close, the auction included
    expect(lines(out, "auction")).toEqual(["105.0000"]);
  });

  it("takes the bar's DATE in ISTANBUL time: a bar at 21:00Z (00:00 of the next Istanbul day) is a later session, one at 20:59Z is not", () => {
    const out = runPsql(
      inTx(`
${daily("THYAO", [["2026-11-05", 105]])}
${bars("THYAO", [["2026-11-05 21:00:00+00", 104]])}
${daily("EREGL", [["2026-11-05", 50]])}
${bars("EREGL", [["2026-11-05 20:59:00+00", 49]])}
${price("next_day_bar", "THYAO", "2026-11-06 05:00:00+00")}
${price("same_day_bar", "EREGL", "2026-11-06 05:00:00+00")}
`),
    );
    // a UTC date comparison would call the 21:00Z bar 5 Nov (not later than the daily day) and return 105
    expect(lines(out, "next_day_bar")).toEqual(["104.0000"]);
    expect(lines(out, "same_day_bar")).toEqual(["50.0000"]);
  });

  it("164's cases still hold: DOHOL and SISE stale bars lose to the 5 Nov daily close; a mid-session bar and an older day's bar lose too", () => {
    const out = runPsql(
      inTx(`
${daily("DOHOL", [["2026-11-03", 16.38], ["2026-11-04", 17.27], ["2026-11-05", 17.56]])}
${bars("DOHOL", [["2026-11-03 13:00:00+00", 16.0], ["2026-11-03 13:05:00+00", 16.1]])}
${daily("SISE", [["2026-11-02", 33.42], ["2026-11-03", 34.0], ["2026-11-04", 35.0], ["2026-11-05", 35.42]])}
${bars("SISE", [["2026-11-02 13:40:00+00", 33.39], ["2026-11-02 13:45:00+00", 33.4]])}
${daily("MIDDAY", [["2026-11-05", 50]])}
${bars("MIDDAY", [["2026-11-05 09:00:00+00", 49]])}
${daily("OLDER", [["2026-11-05", 60]])}
${bars("OLDER", [["2026-11-04 14:55:00+00", 59]])}
${price("dohol", "DOHOL", "2026-11-05 22:08:00+00")}
${price("sise", "SISE", "2026-11-05 21:00:00+00")}
${price("midday", "MIDDAY", "2026-11-05 16:30:00+00")}
${price("older", "OLDER", "2026-11-05 16:30:00+00")}
`),
    );
    expect(lines(out, "dohol")).toEqual(["17.5600"]);
    expect(lines(out, "sise")).toEqual(["35.4200"]);
    expect(lines(out, "midday")).toEqual(["50.0000"]);
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
    // 11:00 Istanbul on 4 Nov: reference day 3 Nov, the 10:05 bar is of a later day than the 3 Nov daily row
    expect(lines(out, "intraday")).toEqual(["26.5800"]);
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

  it("ignores other tickers, looks at no future data and keeps the 4-day lookback", () => {
    const out = runPsql(
      inTx(`
${daily("OTHER", [["2026-11-04", 1]])}
${bars("OTHER", [["2026-11-05 07:00:00+00", 2]])}
${daily("BIMAS", [["2026-11-04", 200], ["2026-11-05", 210]])}
${bars("BIMAS", [["2026-11-05 12:00:00+00", 205]])}
${daily("PGSUS", [["2026-11-04", 300]])}
${bars("PGSUS", [["2026-10-30 12:00:00+00", 290]])}
${price("isolated", "SAHOL", "2026-11-05 22:00:00+00")}
${price("early", "BIMAS", "2026-11-05 10:00:00+00")}
${price("old", "PGSUS", "2026-11-05 07:00:00+00")}
`),
    );
    expect(lines(out, "isolated")).toEqual(["null"]);
    // 13:00 Istanbul, before 18:10: reference day 4 Nov; the 12:00Z bar is in the future of p_ts
    expect(lines(out, "early")).toEqual(["200.0000"]);
    expect(lines(out, "old")).toEqual(["300.0000"]);
  });

  it("has 164's attributes: invoker, stable, no SET clause, returns numeric, sql, one overload, and the new body", () => {
    const out = runPsql(`
select 'attrs', p.prosecdef, p.provolatile, coalesce(p.proconfig::text, 'null'), p.proretset,
       pg_get_function_result(p.oid), pg_get_function_arguments(p.oid), l.lanname, md5(p.prosrc)
  from pg_proc p join pg_language l on l.oid = p.prolang
 where p.oid = 'public.price_at(text, timestamptz)'::regprocedure;
select 'overloads', count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'price_at';
`);
    expect(lines(out, "attrs")).toEqual([
      `f|s|null|f|numeric|p_ticker text, p_ts timestamp with time zone|sql|${md5(functionBody(sql187))}`,
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
    expect(runPsql("select count(*) from supabase_migrations.schema_migrations where version = '187';").trim()).toBe("1");
  });
});
