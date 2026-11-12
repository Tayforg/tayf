import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Contract test for migration 203 ("price_at_completed_bar"), h144-ekonomi-1.
//
// public.price_at(ticker, ts) is the reference price of the /ekonomi "haberden" chip (the move since the
// headline). bist_bars_5m is stamped with each bar's START (051: "ts is the bar start, floored to 5 min"), so
// the bar with ts <= p_ts that 187 picks is the bar that CONTAINS the headline and its close is the price at
// ts + 5 min, up to five minutes AFTER the headline. GLRMK, BirGun headline at 12:00:00 Istanbul on 11 Nov:
// price_at returned 106.80 (the close of the 12:00-12:05 bar, in which the price fell from 108.60), the price at
// the headline was 108.60; the page printed -4,78 % haberden instead of -6,35 %.
//
// 203 changes only the bar predicate: `ts <= p_ts` becomes `ts <= p_ts - interval '5 minutes'`, the close of the
// last COMPLETED bar (ts + 5 min <= p_ts). The 4-day lower bound, the daily lookup, the 18:10 cutoff and the
// session-day CASE of 187 are carried over unchanged.
//
// This file pins: one transaction, the function, its grants and the ledger row; that the replaced function
// keeps 187's signature, language, volatility and security (and that 187's body is the production body, by
// md5); that the new body is 187's body with exactly the bar predicate replaced; the revoke and grant of 058;
// that nothing is dropped, updated or deleted and the only insert is the ledger row; the dry-run script and the
// manifest entry; and, in the opt-in live block (TAYF_PSQL), the behaviour on a throwaway Postgres: the five
// edge cases of the header and the production cases (GLRMK, ASELS, THYAO, TURSG).
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const FILE_203 = "203_price_at_completed_bar.sql";
const MIGRATION_203 = resolve(MIGRATIONS_DIR, FILE_203);
const MIGRATION_187 = resolve(MIGRATIONS_DIR, "187_price_at_daily_close_wins.sql");
const MIGRATION_058 = resolve(MIGRATIONS_DIR, "058_finance_hardening.sql");
const DRYRUN_203 = resolve(ROOT, "tests", "migrations", "sql", "203-price-at-completed-bar-dryrun.sql");
const MANIFEST = resolve(ROOT, "tests", "migrations", "sql", "live-manifest.txt");

/** Production, read-only, 2026-11-12: md5(prosrc), length(prosrc) and proacl of public.price_at(text, timestamptz). */
const PROD_PROSRC_MD5 = "e473799ca41463d0b022e7f42c4e0fce";
const PROD_PROSRC_LEN = 817;
const PROD_PROACL = "{postgres=X/postgres,service_role=X/postgres}";

const FN_MARKER = "create or replace function public.price_at(p_ticker text, p_ts timestamptz)";

/** 187's bar predicate and 203's, as normalised text: the only thing that differs between the two bodies. */
const BAR_PRED_187 = "where ticker = p_ticker and ts <= p_ts and ts >= p_ts - interval '4 days'";
const BAR_PRED_203 = "where ticker = p_ticker and ts <= p_ts - interval '5 minutes' and ts >= p_ts - interval '4 days'";
const CASE_187 =
  "case when b.ts is not null and (d.day is null or (b.ts at time zone 'Europe/Istanbul')::date > d.day) then b.close else d.close end";

const stripSqlComments = (sql: string): string => sql.replace(/--[^\n]*/g, "");
const norm = (sql: string): string => stripSqlComments(sql).replace(/\s+/g, " ").trim();
const md5 = (text: string): string => createHash("md5").update(text).digest("hex");

/**
 * The top-level statements only: comments gone, every dollar-quoted block collapsed to $$$$ and every
 * single-quoted literal to ''. A scanner, not a regex.
 */
function topLevel(sql: string): string {
  const code = stripSqlComments(sql);
  let out = "";
  let i = 0;
  while (i < code.length) {
    if (code.startsWith("$$", i)) {
      const end = code.indexOf("$$", i + 2);
      out += "$$$$";
      i = end < 0 ? code.length : end + 2;
    } else if (code[i] === "'") {
      let j = i + 1;
      while (j < code.length) {
        if (code[j] === "'" && code[j + 1] === "'") j += 2;
        else if (code[j] === "'") break;
        else j += 1;
      }
      out += "''";
      i = j + 1;
    } else {
      out += code[i];
      i += 1;
    }
  }
  return out;
}

/** Index of the statement itself: the marker at the start of a line (a header comment may quote it too). */
function statementStart(sql: string): number {
  const at = sql.startsWith(FN_MARKER) ? 0 : sql.indexOf(`\n${FN_MARKER}`) + 1;
  expect(at, `expected a line starting with "${FN_MARKER}"`).toBeGreaterThan(-1);
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

const sql203 = readFileSync(MIGRATION_203, "utf8");
const code203 = stripSqlComments(sql203);
const top203 = norm(topLevel(sql203));
const n203 = norm(sql203);
const sql187 = readFileSync(MIGRATION_187, "utf8");
const sql058 = readFileSync(MIGRATION_058, "utf8");

const body187 = norm(functionBody(sql187));
const body203 = norm(functionBody(sql203));
/** 187's daily-close lookup, as normalised text: the WHERE ... LIMIT 1 of the daily subquery. */
const DAILY_LOOKUP = /where ticker = p_ticker and day <= case when .*? end order by day desc limit 1/.exec(body187)?.[0] as string;

describe("203 price_at_completed_bar: ledger and transaction", () => {
  it("records version 203 in the schema_migrations ledger, idempotently (095 pattern)", () => {
    expect(n203).toContain(
      "insert into supabase_migrations.schema_migrations (version, name) values ('203', '203_price_at_completed_bar') on conflict do nothing;",
    );
  });

  it("is one transaction: a single begin, a single commit, the ledger row last", () => {
    // top203 has comments gone, literals and the function body blanked, and every whitespace run collapsed
    expect(top203.split("begin;")).toHaveLength(2);
    expect(top203.split("commit;")).toHaveLength(2);
    expect(top203.startsWith("begin; create or replace function")).toBe(true);
    expect(n203.slice(n203.indexOf("begin;")).endsWith("on conflict do nothing; commit;")).toBe(true);
  });

  it("is named for its file and is the only migration numbered 203", () => {
    expect(FILE_203).toBe("203_price_at_completed_bar.sql");
    const names = readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("203_"));
    expect(names).toEqual([FILE_203]);
  });
});

describe("203 price_at_completed_bar: the production fingerprint it was built from", () => {
  it("187's function body is production's body: its md5 and length are the recorded prosrc", () => {
    const body = functionBody(sql187);
    expect(md5(body)).toBe(PROD_PROSRC_MD5);
    expect(body.length).toBe(PROD_PROSRC_LEN);
  });

  it("187 is the newest earlier migration that defines price_at (051 -> 062 -> 164 -> 187)", () => {
    const defs = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql") && f < FILE_203)
      .sort()
      .filter((f) =>
        stripSqlComments(readFileSync(resolve(MIGRATIONS_DIR, f), "utf8"))
          .toLowerCase()
          .includes("create or replace function public.price_at("),
      );
    expect(defs).toEqual([
      "051_finance_bars_and_speed.sql",
      "062_coverage_semantics_and_context.sql",
      "164_price_at_session_aware.sql",
      "187_price_at_daily_close_wins.sql",
    ]);
  });

  it("the header records the production md5(prosrc), length, proacl and the md5 and length of the new body", () => {
    expect(sql203).toContain(PROD_PROSRC_MD5);
    expect(sql203).toContain(`length ${PROD_PROSRC_LEN}`);
    expect(sql203).toContain(PROD_PROACL);
    const body = functionBody(sql203);
    const recorded = /new md5\(prosrc\):\s*([0-9a-f]{32}) \(length (\d+)\)/.exec(sql203);
    expect(recorded, "header line `new md5(prosrc): <32 hex> (length N)`").not.toBeNull();
    expect(recorded?.[1]).toBe(md5(body));
    expect(Number(recorded?.[2])).toBe(body.length);
    expect(recorded?.[1]).not.toBe(PROD_PROSRC_MD5);
  });

  it("the header says why: bars are start-stamped (051), so the containing bar's close is up to 5 minutes after p_ts", () => {
    expect(sql203).toContain("051");
    expect(sql203).toMatch(/bar start/i);
    expect(sql203).toMatch(/start-stamped|stamped with (their|its) start/i);
    expect(sql203).toContain("containing bar");
    expect(sql203).toMatch(/5 minutes AFTER/);
    expect(sql203).toContain("haberden");
    // the evidence: GLRMK 12:00:00 Istanbul, 106.80 against 108.60
    expect(sql203).toContain("GLRMK");
    expect(sql203).toContain("106.80");
    expect(sql203).toContain("108.60");
    expect(sql203).toContain("ts + 5 min");
  });

  it("the header states the five edge cases", () => {
    // p_ts 10:02 -> the 09:55 opening-auction stub; 09:58 -> the previous day's daily close; 18:03 -> the 17:55 bar;
    // 18:12 -> today's daily close; 12:00:00 -> the 11:55 bar
    for (const needle of ["10:02", "09:55", "09:58", "18:03", "17:55", "18:12", "12:00:00", "11:55"]) {
      expect(sql203, needle).toContain(needle);
    }
    expect(sql203).toMatch(/EDGE CASES/);
    expect(sql203).toMatch(/opening-auction stub/);
    expect(sql203).toMatch(/previous day's daily close/);
    expect(sql203).toMatch(/today's daily close/);
  });

  it("the header carries a REPLAY and a ROLLBACK note that names 187's statement", () => {
    expect(sql203).toMatch(/^-- REPLAY/m);
    expect(sql203).toMatch(/pairs/);
    expect(sql203).toMatch(/^-- ROLLBACK/m);
    expect(sql203).toContain("187");
    expect(sql203).toContain(PROD_PROSRC_MD5);
  });

  it("the header records the callers: feed_reference_prices is the only one, and bar_returns does not use price_at", () => {
    expect(sql203).toContain("feed_reference_prices");
    expect(sql203).toContain("bar_returns");
    expect(sql203).toMatch(/NOT TOUCHED/);
  });
});

describe("203 price_at_completed_bar: the replaced function", () => {
  it("replaces exactly one function, with 187's signature, return type, language and volatility", () => {
    expect([...n203.matchAll(/\bcreate (or replace )?function\b/gi)]).toHaveLength(1);
    expect(top203).toContain(
      "create or replace function public.price_at(p_ticker text, p_ts timestamptz) returns numeric language sql stable as $$$$",
    );
    const header187 = norm(functionStatement(sql187).split("as $$")[0] as string);
    const header203 = norm(functionStatement(sql203).split("as $$")[0] as string);
    expect(header203).toBe(header187);
  });

  it("keeps the owner and security of 187: SECURITY INVOKER, no SET clause, no security definer", () => {
    const stmt = norm(functionStatement(sql203));
    expect(stmt).not.toMatch(/security definer/i);
    expect(stmt).not.toMatch(/\bset search_path\b/i);
    expect(stmt).not.toMatch(/\bowner to\b/i);
    expect(code203).not.toMatch(/\balter\s+function\b/i);
  });

  it("the bar lookup is `ts <= p_ts - interval '5 minutes'`: the last COMPLETED bar", () => {
    expect(body203).toContain(BAR_PRED_203);
    expect(body203).toContain("ts <= p_ts - interval '5 minutes'");
    // the containing-bar predicate is gone
    expect(body203).not.toContain("ts <= p_ts and");
    expect(body203.split("interval '5 minutes'")).toHaveLength(2);
  });

  it("keeps the 4-day lower bound relative to p_ts, unshifted", () => {
    expect(body203).toContain("and ts >= p_ts - interval '4 days'");
    expect(body203).not.toContain("ts >= p_ts - interval '5 minutes'");
    expect(body203).not.toContain("interval '4 days' - interval");
  });

  it("keeps 187's daily lookup, the 18:10 cutoff and the session-day rule verbatim", () => {
    expect(DAILY_LOOKUP, "187's daily lookup text").toBeDefined();
    expect(body203).toContain(DAILY_LOOKUP);
    expect(body203).toContain("time '18:10'");
    expect(body203).toContain("'Europe/Istanbul'");
    expect(body203).toContain("from public.bist_bars_5m");
    expect(body203).toContain("from public.bist_bars_daily");
    // 187's rule: a bar wins only from a later Istanbul calendar day than the daily row (or with no daily row)
    expect(body203).toContain(CASE_187);
    expect(body203).toContain("(b.ts at time zone 'Europe/Istanbul')::date > d.day");
    // and 164's 18:00 rule did not come back
    expect(body203).not.toContain("time '18:00'");
    expect(body203).not.toMatch(/at time zone 'utc'/i);
  });

  it("is 187's body with exactly the bar predicate replaced, nothing else changed", () => {
    expect(body187).toContain(BAR_PRED_187);
    expect(body203).toContain(BAR_PRED_203);
    expect(body187.replaceAll(BAR_PRED_187, BAR_PRED_203)).toBe(body203);
  });

  it("returns a single scalar row even when neither source has data (left joins from a one-row relation)", () => {
    // whitespace just inside parentheses is not significant (norm() already made every run one space)
    const body = body203.replaceAll("( ", "(").replaceAll(" )", ")");
    expect(body).toMatch(/from \(select 1\) \w+ left join \(select ts, close from public\.bist_bars_5m /);
    expect(body).toMatch(/\) b on true left join \(select day, close from public\.bist_bars_daily /);
    expect(body).toMatch(/\) d on true;?$/);
  });

  it("does not use coalesce: the 5-minute bar never wins by default", () => {
    expect(body203).not.toMatch(/\bcoalesce\s*\(/i);
  });
});

describe("203 price_at_completed_bar: grants", () => {
  it("restates 058's revoke and grant for price_at(text, timestamptz), statement for statement, for that function only", () => {
    expect(n203).toContain("revoke execute on function public.price_at(text, timestamptz) from anon, authenticated, public;");
    expect(n203).toContain("grant execute on function public.price_at(text, timestamptz) to service_role;");
    // 058 names this very function in its multi-function revoke and grant
    const n058 = norm(sql058);
    expect(n058).toContain("public.price_at(text, timestamptz),");
    expect(n058).toContain("from anon, authenticated, public;");
    expect(n058).toContain("to service_role;");
  });

  it("grants only to service_role, nothing to anon, authenticated or public, and the grants come after the function", () => {
    const grants = [...code203.matchAll(/\bgrant\b[^;]*;/gi)].map((m) => norm(m[0]));
    expect(grants).toEqual(["grant execute on function public.price_at(text, timestamptz) to service_role;"]);
    const revokes = [...code203.matchAll(/\brevoke\b[^;]*;/gi)].map((m) => norm(m[0]));
    expect(revokes).toEqual(["revoke execute on function public.price_at(text, timestamptz) from anon, authenticated, public;"]);
    expect(code203.indexOf("revoke execute")).toBeGreaterThan(code203.indexOf("create or replace function"));
    expect(code203.indexOf("grant execute")).toBeGreaterThan(code203.indexOf("revoke execute"));
    expect(code203).not.toMatch(/alter\s+default\s+privileges/i);
  });
});

describe("203 price_at_completed_bar: function replacement only, nothing else touched", () => {
  it("has no drop, update, delete or truncate statement, and no insert but the one ledger row", () => {
    // topLevel() blanks string literals, so the ledger statement reads: values ('', '')
    const ledger = "insert into supabase_migrations.schema_migrations (version, name) values ('', '') on conflict do nothing;";
    expect(top203.split(ledger)).toHaveLength(2);
    expect(top203.replaceAll(ledger, "")).not.toMatch(/\binsert\b/i);
    expect(top203).not.toMatch(/\bdrop\b/i);
    expect(top203).not.toMatch(/\bupdate\b/i);
    expect(top203).not.toMatch(/\bdelete\b/i);
    expect(top203).not.toMatch(/\btruncate\b/i);
    // and none inside the function body either
    expect(body203).not.toMatch(/\b(drop|insert|update|delete|truncate)\b/i);
  });

  it("creates no table, index, view, trigger or cron job and alters no table", () => {
    expect(n203).not.toMatch(/\bcreate (unique )?(table|index|view|trigger|materialized|extension|policy)\b/i);
    expect(code203).not.toMatch(/\bcron\./i);
    expect(n203).not.toMatch(/\balter table\b/i);
  });

  it("never redefines or mentions its callers or the other finance functions in code", () => {
    expect(code203).not.toMatch(/feed_reference_prices|bar_returns|bist_intraday_targets|bist_daily_targets|econ_feed/i);
  });
});

describe("203 price_at_completed_bar: dry-run script and live manifest", () => {
  const dry = existsSync(DRYRUN_203) ? readFileSync(DRYRUN_203, "utf8") : "";

  it("ships the local PG15 dry-run: 187's function as production has it, 203 twice, ending in DRYRUN 203 OK", () => {
    expect(existsSync(DRYRUN_203)).toBe(true);
    expect(dry).toContain(PROD_PROSRC_MD5);
    expect(dry.split("\\ir ../../../supabase/migrations/203_price_at_completed_bar.sql").length - 1).toBe(2);
    expect(dry).toContain("\\ir 187-price-at-daily-close-wins-dryrun.sql");
    expect(dry.trimEnd().endsWith("select 'DRYRUN 203 OK';")).toBe(true);
  });

  it("asserts the five edge cases and the production cases, and rolls its fixtures back", () => {
    for (const needle of ["GLRMK", "ASELS", "THYAO", "TURSG", "10:02", "09:58", "18:03", "18:12", "12:00:00"]) {
      expect(dry, needle).toContain(needle);
    }
    expect(dry).toMatch(/bist_bars_daily/);
    expect(dry).toContain("rollback;");
  });

  it("has a live-manifest entry that runs this file with the dry-run as its setup", () => {
    const manifest = readFileSync(MANIFEST, "utf8");
    expect(manifest).toContain(
      "run | 203-price-at-completed-bar.test.ts | tests/migrations/sql/203-price-at-completed-bar-dryrun.sql | - | 0",
    );
  });
});

// ---------------------------------------------------------------------------
// Live block (opt-in). TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/PGDATABASE point at a
// THROWAWAY database that tests/migrations/sql/203-price-at-completed-bar-dryrun.sql built (the stub,
// bist_bars_5m / bist_bars_daily, price_at as production has it, then 203 applied twice). Every
// scenario that writes sits inside one transaction that is rolled back.
// ---------------------------------------------------------------------------
describe.runIf(Boolean(process.env.TAYF_PSQL))("203 against a live Postgres (203 applied)", () => {
  assertLiveReady("203", {
    ledger: ["203"],
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
    out
      .split("\n")
      .filter((l) => l.startsWith(`${tag}|`))
      .map((l) => l.slice(tag.length + 1));

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

  /** THYAO on 11 Nov (a Wednesday): stub at 09:55, first trades at 10:00, an 18:00 auction stub, daily rows for 10 and 11 Nov. */
  const thyaoDay = `
${daily("THYAO", [["2026-11-10", 100], ["2026-11-11", 105]])}
${barVol("THYAO", "2026-11-10 17:55:00+03", 99.5, 900000)}
${barVol("THYAO", "2026-11-10 18:00:00+03", 99.9, 0)}
${barVol("THYAO", "2026-11-11 09:55:00+03", 100.2, 0)}
${barVol("THYAO", "2026-11-11 10:00:00+03", 100.4, 1582333)}
${bars("THYAO", [["2026-11-11 11:50:00+03", 102.5], ["2026-11-11 11:55:00+03", 103], ["2026-11-11 12:00:00+03", 103.5]])}
${bars("THYAO", [["2026-11-11 17:55:00+03", 104.7]])}
${barVol("THYAO", "2026-11-11 18:00:00+03", 104.9, 0)}
`;

  it("edge case 1: p_ts 10:02 Istanbul takes the 09:55 opening-auction stub of today (the 10:00 bar is not complete)", () => {
    const out = runPsql(inTx(`${thyaoDay}\n${price("t", "THYAO", "2026-11-11 10:02:00+03")}`));
    // 187 returned 100.4000, the close of the 10:00 bar (the price at 10:05)
    expect(lines(out, "t")).toEqual(["100.2000"]);
  });

  it("edge case 2: p_ts 09:58 Istanbul takes the previous day's daily close (the newest completed bar is of the daily row's own day)", () => {
    const out = runPsql(inTx(`${thyaoDay}\n${price("t", "THYAO", "2026-11-11 09:58:00+03")}`));
    // 187 returned 100.2000 (the 09:55 stub, a bar of a later session than the 10 Nov daily row)
    expect(lines(out, "t")).toEqual(["100.0000"]);
  });

  it("edge case 3: p_ts 18:03 Istanbul takes the 17:55 bar close (the 18:00 bar is not complete yet)", () => {
    const out = runPsql(inTx(`${thyaoDay}\n${price("t", "THYAO", "2026-11-11 18:03:00+03")}`));
    // 187 returned 104.9000, the 18:00 stub
    expect(lines(out, "t")).toEqual(["104.7000"]);
  });

  it("edge case 4: p_ts 18:12 Istanbul takes today's daily close (the settled close beats the 18:00 stub)", () => {
    const out = runPsql(inTx(`${thyaoDay}\n${price("t", "THYAO", "2026-11-11 18:12:00+03")}`));
    expect(lines(out, "t")).toEqual(["105.0000"]);
  });

  it("edge case 5: p_ts 12:00:00 Istanbul takes the 11:55 bar close, not the 12:00 bar that contains the headline", () => {
    const out = runPsql(inTx(`${thyaoDay}\n${price("t", "THYAO", "2026-11-11 12:00:00+03")}`));
    // 187 returned 103.5000
    expect(lines(out, "t")).toEqual(["103.0000"]);
  });

  it("the boundary is inclusive to the second: a bar is used from ts + 5 minutes exactly, not one second before", () => {
    const out = runPsql(
      inTx(`${thyaoDay}
${price("at_1200_00", "THYAO", "2026-11-11 12:00:00+03")}
${price("at_1159_59", "THYAO", "2026-11-11 11:59:59+03")}
${price("at_1204_59", "THYAO", "2026-11-11 12:04:59+03")}
${price("at_1205_00", "THYAO", "2026-11-11 12:05:00+03")}
`),
    );
    expect(lines(out, "at_1200_00")).toEqual(["103.0000"]);
    // the 11:55 bar completes at 12:00:00: one second earlier the newest completed bar is 11:50
    expect(lines(out, "at_1159_59")).toEqual(["102.5000"]);
    expect(lines(out, "at_1204_59")).toEqual(["103.0000"]);
    expect(lines(out, "at_1205_00")).toEqual(["103.5000"]);
  });

  it("GLRMK (11 Nov, BirGun 12:00:00 Istanbul): 108.60, the close before the reaction, not 106.80 from inside it", () => {
    const out = runPsql(
      inTx(`
${daily("GLRMK", [["2026-11-10", 110.2]])}
${bars("GLRMK", [["2026-11-11 11:50:00+03", 108], ["2026-11-11 11:55:00+03", 108.6], ["2026-11-11 12:00:00+03", 106.8], ["2026-11-11 12:05:00+03", 106.4]])}
${price("glrmk", "GLRMK", "2026-11-11 09:00:00+00")}
`),
    );
    expect(lines(out, "glrmk")).toEqual(["108.6000"]);
  });

  it("ASELS 11:12 Istanbul reads 342.00 (was 343.50) and TURSG 16:42 reads 3.25 (was 3.26): the production readings of 11 Nov", () => {
    const out = runPsql(
      inTx(`
${daily("ASELS", [["2026-11-10", 340]])}
${bars("ASELS", [["2026-11-11 11:05:00+03", 342], ["2026-11-11 11:10:00+03", 343.5], ["2026-11-11 11:15:00+03", 343]])}
${daily("TURSG", [["2026-11-10", 3.3]])}
${bars("TURSG", [["2026-11-11 16:35:00+03", 3.25], ["2026-11-11 16:40:00+03", 3.26]])}
${price("asels", "ASELS", "2026-11-11 08:12:00+00")}
${price("tursg", "TURSG", "2026-11-11 13:42:00+00")}
`),
    );
    expect(lines(out, "asels")).toEqual(["342.0000"]);
    expect(lines(out, "tursg")).toEqual(["3.2500"]);
  });

  it("THYAO 16:46 Istanbul reads 317.25 (was 317.00): the 16:40 bar completed at 16:45, the 16:45 bar is still running", () => {
    const out = runPsql(
      inTx(`
${daily("THYAO", [["2026-11-10", 318]])}
${bars("THYAO", [["2026-11-11 16:40:00+03", 317.25], ["2026-11-11 16:45:00+03", 317]])}
${price("thyao", "THYAO", "2026-11-11 13:46:00+00")}
${price("thyao_1650", "THYAO", "2026-11-11 16:50:00+03")}
`),
    );
    expect(lines(out, "thyao")).toEqual(["317.2500"]);
    // from 16:50:00 the 16:45 bar is complete too
    expect(lines(out, "thyao_1650")).toEqual(["317.0000"]);
  });

  it("VAKBN (187): the settled daily close of a completed session still beats its 18:00 stub, on a Sunday and on Monday 00:00", () => {
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
    expect(lines(out, "sunday")).toEqual(["33.0600"]);
    expect(lines(out, "monday0000")).toEqual(["33.0600"]);
    expect(lines(out, "friday_evening")).toEqual(["33.0600"]);
  });

  it("intraday: a bar of a later session than the newest daily row wins once complete (Monday 10:05 bar from 10:10:00, not 10:09:59)", () => {
    const out = runPsql(
      inTx(`
${daily("VAKBN", [["2026-11-06", 33.06]])}
${barVol("VAKBN", "2026-11-06 18:00:00+03", 33.04, 0)}
${bars("VAKBN", [["2026-11-09 10:05:00+03", 33.3]])}
${price("at_1010_00", "VAKBN", "2026-11-09 10:10:00+03")}
${price("at_1009_59", "VAKBN", "2026-11-09 10:09:59+03")}
`),
    );
    expect(lines(out, "at_1010_00")).toEqual(["33.3000"]);
    // before the 10:05 bar completes the Friday daily close is what is left (it beats the stub)
    expect(lines(out, "at_1009_59")).toEqual(["33.0600"]);
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

  it("with no daily row at or before the reference day the completed bar is used; with neither, null", () => {
    const out = runPsql(
      inTx(`
${bars("DOHOL", [["2026-11-03 13:05:00+00", 16.1]])}
${price("nodaily", "DOHOL", "2026-11-04 08:00:00+00")}
${daily("DOHOL", [["2026-11-05", 17.56]])}
${price("future_daily", "DOHOL", "2026-11-04 08:00:00+00")}
${price("none", "NOPE", "2026-11-05 22:00:00+00")}
`),
    );
    expect(lines(out, "nodaily")).toEqual(["16.1000"]);
    expect(lines(out, "future_daily")).toEqual(["16.1000"]);
    expect(lines(out, "none")).toEqual(["null"]);
  });

  it("the only bar is still running: no completed bar and no daily row gives null; with a daily row, that row", () => {
    const out = runPsql(
      inTx(`
${bars("ONLY", [["2026-11-11 12:00:00+03", 50]])}
${price("running", "ONLY", "2026-11-11 12:03:00+03")}
${price("done", "ONLY", "2026-11-11 12:05:00+03")}
${daily("WITHD", [["2026-11-10", 49]])}
${bars("WITHD", [["2026-11-11 12:00:00+03", 50]])}
${price("withd_running", "WITHD", "2026-11-11 12:03:00+03")}
`),
    );
    expect(lines(out, "running")).toEqual(["null"]);
    expect(lines(out, "done")).toEqual(["50.0000"]);
    // the running bar is of a later session than the 10 Nov daily row, but it is not complete: the daily close is returned
    expect(lines(out, "withd_running")).toEqual(["49.0000"]);
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

  it("ignores other tickers, looks at no future data and keeps the 4-day lookback relative to p_ts", () => {
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

  it("has 187's attributes: invoker, stable, no SET clause, returns numeric, sql, one overload, and the new body", () => {
    const out = runPsql(`
select 'attrs', p.prosecdef, p.provolatile, coalesce(p.proconfig::text, 'null'), p.proretset,
       pg_get_function_result(p.oid), pg_get_function_arguments(p.oid), l.lanname, md5(p.prosrc)
  from pg_proc p join pg_language l on l.oid = p.prolang
 where p.oid = 'public.price_at(text, timestamptz)'::regprocedure;
select 'overloads', count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'price_at';
`);
    expect(lines(out, "attrs")).toEqual([
      `f|s|null|f|numeric|p_ticker text, p_ts timestamp with time zone|sql|${md5(functionBody(sql203))}`,
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
    expect(runPsql("select count(*) from supabase_migrations.schema_migrations where version = '203';").trim()).toBe("1");
  });
});
