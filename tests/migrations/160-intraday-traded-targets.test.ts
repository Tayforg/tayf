import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Contract test for migration 160 ("intraday_traded_targets"), h39-pipeline2-2.
//
// quotes-ingest {"mode":"intraday"} asks public.bist_intraday_targets(120) for its
// tickers. 058's body takes every distinct article_tickers.ticker of the last 7
// days, so a code that Yahoo does not know (a non-traded KAP member, a warrant, a
// rights line) never gets a bar, sorts to the head of "b.last_ts nulls first" for
// ever and took 54 of the 120 slots of every run. 160 intersects the news tickers
// with the traded set that bist_daily_targets (051 / 052) already uses.
//
// This file pins: the ledger row and one transaction; that the replaced function
// keeps 058's signature, return columns, language, volatility, security and
// grants; that the new body is 058's body (the text whose md5 is the production
// fingerprint recorded in the header) plus exactly the traded intersect; that the
// daily function and everything else is untouched; and, in the opt-in live block
// (TAYF_PSQL), the behaviour on a throwaway Postgres: only a traded ticker is
// returned, the 7-day window, the staleness order, the limit and the privileges.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const MIGRATION_160 = resolve(MIGRATIONS_DIR, "160_intraday_traded_targets.sql");
const MIGRATION_058 = resolve(MIGRATIONS_DIR, "058_finance_hardening.sql");
const MIGRATION_051 = resolve(MIGRATIONS_DIR, "051_finance_bars_and_speed.sql");

/** Production, read-only, 2026-11-05: md5(prosrc) and proacl of public.bist_intraday_targets(integer). */
const PROD_PROSRC_MD5 = "ee892ad1547b7563bb43bb3ba4b17e52";
const PROD_PROACL = "{postgres=X/postgres,service_role=X/postgres}";

const FN_MARKER = "create or replace function public.bist_intraday_targets(p_limit int default 120)";

const stripSqlComments = (sql: string): string => sql.replace(/--[^\n]*/g, "");
const norm = (sql: string): string => stripSqlComments(sql).replace(/\s+/g, " ").trim();
const md5 = (text: string): string => createHash("md5").update(text).digest("hex");

/** Index of the statement itself: the marker at the start of a line (a header comment may quote it too). */
function statementStart(sql: string): number {
  const at = sql.search(new RegExp(`^${FN_MARKER.replace(/[()]/g, "\\$&")}`, "m"));
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

const sql160 = readFileSync(MIGRATION_160, "utf8");
const code160 = stripSqlComments(sql160);
const n160 = norm(sql160);
const sql058 = readFileSync(MIGRATION_058, "utf8");

/** The traded-ticker set of bist_daily_targets (051), which 160 reuses verbatim. */
const TRADED_SET = "select distinct unnest(tickers) as ticker from public.bist_companies where shares_traded";

describe("160 intraday_traded_targets: ledger and transaction", () => {
  it("records version 160 in the schema_migrations ledger, idempotently (095 pattern)", () => {
    expect(n160).toContain(
      "insert into supabase_migrations.schema_migrations (version, name) values ('160', '160_intraday_traded_targets') on conflict do nothing;",
    );
  });

  it("is one transaction: a single begin, a single commit, the ledger row last", () => {
    expect([...code160.matchAll(/^\s*begin\s*;/gim)]).toHaveLength(1);
    expect([...code160.matchAll(/^\s*commit\s*;/gim)]).toHaveLength(1);
    expect(n160.slice(n160.indexOf("begin;")).endsWith("on conflict do nothing; commit;")).toBe(true);
  });
});

describe("160 intraday_traded_targets: the production fingerprint it was built from", () => {
  it("058's function body is production's body: its md5 is the recorded prosrc md5", () => {
    expect(md5(functionBody(sql058))).toBe(PROD_PROSRC_MD5);
  });

  it("the header records the production md5(prosrc), the production proacl and the md5 of the new body", () => {
    expect(sql160).toContain(PROD_PROSRC_MD5);
    expect(sql160).toContain(PROD_PROACL);
    const recorded = /new md5\(prosrc\):\s*([0-9a-f]{32})/.exec(sql160)?.[1];
    expect(recorded, "header line `new md5(prosrc): <32 hex>`").toBeDefined();
    expect(recorded).toBe(md5(functionBody(sql160)));
    expect(recorded).not.toBe(PROD_PROSRC_MD5);
  });

  it("the header says why: a non-traded code never gets a bar, sorts first for ever and took 54 of 120 slots", () => {
    expect(sql160).toMatch(/never (gets|receives|has) a bar/i);
    expect(sql160).toContain("54 of");
    expect(sql160).toContain("120");
    expect(sql160).toContain("nulls first");
  });
});

describe("160 intraday_traded_targets: the replaced function", () => {
  it("replaces exactly one function, with 058's signature, return columns, language and volatility", () => {
    expect([...code160.matchAll(/\bcreate\s+(or\s+replace\s+)?function\b/gi)]).toHaveLength(1);
    expect(n160).toContain(
      "create or replace function public.bist_intraday_targets(p_limit int default 120) returns table (ticker text, last_ts timestamptz) language sql stable as $$",
    );
    // and 058's header is the same text (so nothing but the body changes)
    const header058 = norm(functionStatement(sql058).split("as $$")[0] as string);
    const header160 = norm(functionStatement(sql160).split("as $$")[0] as string);
    expect(header160).toBe(header058);
  });

  it("keeps the owner and security of 058: SECURITY INVOKER, no SET clause, no security definer", () => {
    const stmt = norm(functionStatement(sql160));
    expect(stmt).not.toMatch(/security\s+definer/i);
    expect(stmt).not.toMatch(/\bset\s+search_path\b/i);
    expect(stmt).not.toMatch(/\bowner\s+to\b/i);
    expect(code160).not.toMatch(/\balter\s+function\b/i);
  });

  it("the new body is 058's body plus exactly the traded intersect (left join, order by and limit unchanged)", () => {
    const old058 = norm(functionBody(sql058));
    const expected = old058.replace(
      "where created_at >= now() - interval '7 days' ) t",
      `where created_at >= now() - interval '7 days' intersect ${TRADED_SET} ) t`,
    );
    expect(expected).not.toBe(old058);
    expect(norm(functionBody(sql160))).toBe(expected);
  });

  it("uses bist_daily_targets' traded set verbatim (051)", () => {
    expect(norm(readFileSync(MIGRATION_051, "utf8"))).toContain(TRADED_SET);
    expect(norm(functionBody(sql160))).toContain(TRADED_SET);
  });

  it("keeps the staleness order, the left join on bist_bars_5m and the p_limit bound", () => {
    const body = norm(functionBody(sql160));
    expect(body).toContain("left join (select ticker, max(ts) as last_ts from public.bist_bars_5m group by 1) b using (ticker)");
    expect(body).toContain("order by b.last_ts nulls first, t.ticker limit p_limit;");
  });
});

describe("160 intraday_traded_targets: grants", () => {
  it("restates 058's revoke and grant for bist_intraday_targets(int), statement for statement, for that function only", () => {
    expect(n160).toContain(
      "revoke execute on function public.bist_intraday_targets(int) from anon, authenticated, public;",
    );
    expect(n160).toContain("grant execute on function public.bist_intraday_targets(int) to service_role;");
    // 058 revokes from exactly these roles and grants to exactly this one
    const n058 = norm(sql058);
    expect(n058).toContain("from anon, authenticated, public;");
    expect(n058).toContain("to service_role;");
  });

  it("grants only to service_role, nothing to anon, authenticated or public, and the grants come after the function", () => {
    const grants = [...code160.matchAll(/\bgrant\b[^;]*;/gi)].map((m) => norm(m[0]));
    expect(grants).toEqual(["grant execute on function public.bist_intraday_targets(int) to service_role;"]);
    const revokes = [...code160.matchAll(/\brevoke\b[^;]*;/gi)].map((m) => norm(m[0]));
    expect(revokes).toEqual([
      "revoke execute on function public.bist_intraday_targets(int) from anon, authenticated, public;",
    ]);
    expect(code160.indexOf("revoke execute")).toBeGreaterThan(code160.indexOf("create or replace function"));
    expect(code160.indexOf("grant execute")).toBeGreaterThan(code160.indexOf("revoke execute"));
    expect(code160).not.toMatch(/alter\s+default\s+privileges/i);
  });
});

describe("160 intraday_traded_targets: additive, daily mode untouched", () => {
  it("never mentions the daily function in code", () => {
    expect(code160).not.toMatch(/bist_daily_targets/i);
  });

  it("creates no table, index, view, trigger or cron job and drops, deletes or updates nothing", () => {
    expect(code160).not.toMatch(/\bcreate\s+(unique\s+)?(table|index|view|trigger|materialized|extension|policy)\b/i);
    expect(code160).not.toMatch(/\bcron\./i);
    expect(code160).not.toMatch(/\bdrop\s+(table|index|function|column|constraint|policy|trigger|view)\b/i);
    expect(code160).not.toMatch(/\btruncate\b/i);
    expect(code160).not.toMatch(/\bdelete\s+from\b/i);
    expect(code160).not.toMatch(/^\s*update\b/im);
    expect(code160).not.toMatch(/\balter\s+table\b/i);
    const inserts = [...code160.matchAll(/\binsert\s+into\s+([\w.]+)/gi)].map((m) => m[1]);
    expect(inserts).toEqual(["supabase_migrations.schema_migrations"]);
  });
});

// ---------------------------------------------------------------------------
// Live block (opt-in). TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/PGDATABASE point at a
// THROWAWAY database that tests/migrations/sql/160-intraday-traded-targets-dryrun.sql built (the
// stub, bist_bars_5m, 058's function as production has it, then 160 applied twice). Every scenario
// that writes sits inside one transaction that is rolled back.
// ---------------------------------------------------------------------------
describe.runIf(Boolean(process.env.TAYF_PSQL))("160 against a live Postgres (160 applied)", () => {
  assertLiveReady("160", {
    ledger: ["160"],
    relations: ["public.bist_bars_5m", "public.bist_companies", "public.article_tickers"],
    functions: ["public.bist_intraday_targets(integer)"],
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

  const A1 = "00000000-0000-4000-8000-000000001601";
  const A2 = "00000000-0000-4000-8000-000000001602";
  const A3 = "00000000-0000-4000-8000-000000001603";
  const A4 = "00000000-0000-4000-8000-000000001604";
  const A5 = "00000000-0000-4000-8000-000000001605";
  const A6 = "00000000-0000-4000-8000-000000001606";

  /** Articles A1..A6 exist; `body` then adds companies / tickers / bars and reads. Always rolled back. */
  const withFixtures = (body: string): string => `
begin;
insert into public.articles (id, title) values
  ('${A1}', 'a1'), ('${A2}', 'a2'), ('${A3}', 'a3'), ('${A4}', 'a4'), ('${A5}', 'a5'), ('${A6}', 'a6');
${body}
rollback;
`;

  it("the spec fixture: FNCLL (company, shares_traded false), THYAO (traded) and ZZZZ (no company row) -> only THYAO", () => {
    const out = runPsql(
      withFixtures(`
insert into public.bist_companies (tickers, title, shares_traded) values
  (array['THYAO'], 'Turk Hava Yollari', true),
  (array['FNCLL'], 'Finansal kiralama', false);
insert into public.article_tickers (article_id, ticker, matched_on) values
  ('${A1}', 'FNCLL', 'alias:x'), ('${A2}', 'THYAO', 'alias:y'), ('${A3}', 'ZZZZ', 'alias:z');
select 'row', ticker, coalesce(last_ts::text, 'null') from public.bist_intraday_targets(120);
`),
    );
    expect(lines(out, "row")).toEqual(["THYAO|null"]);
  });

  it("a company with a NULL shares_traded is not traded either", () => {
    const out = runPsql(
      withFixtures(`
insert into public.bist_companies (tickers, title, shares_traded) values
  (array['THYAO'], 'Turk Hava Yollari', true),
  (array['NULLX'], 'unknown flag', null);
insert into public.article_tickers (article_id, ticker, matched_on) values
  ('${A1}', 'NULLX', 'alias:x'), ('${A2}', 'THYAO', 'alias:y');
select 'row', ticker from public.bist_intraday_targets(120);
`),
    );
    expect(lines(out, "row")).toEqual(["THYAO"]);
  });

  it("every ticker of a traded multi-class company counts (the tickers array is unnested), once even when named by several articles", () => {
    const out = runPsql(
      withFixtures(`
insert into public.bist_companies (tickers, title, shares_traded) values
  (array['KRDMA', 'KRDMB', 'KRDMD'], 'Kardemir', true);
insert into public.article_tickers (article_id, ticker, matched_on) values
  ('${A1}', 'KRDMA', 'alias:k'), ('${A2}', 'KRDMD', 'alias:k'), ('${A3}', 'KRDMD', 'alias:k'), ('${A4}', 'KRDMX', 'alias:k');
select 'row', ticker from public.bist_intraday_targets(120) order by ticker;
`),
    );
    expect(lines(out, "row")).toEqual(["KRDMA", "KRDMD"]);
  });

  it("a ticker also listed by a non-traded company row is still returned when another row trades it", () => {
    const out = runPsql(
      withFixtures(`
insert into public.bist_companies (tickers, title, shares_traded) values
  (array['AKBNK'], 'dup row, flag false', false),
  (array['AKBNK'], 'dup row, flag true', true);
insert into public.article_tickers (article_id, ticker, matched_on) values ('${A1}', 'AKBNK', 'alias:a');
select 'row', ticker from public.bist_intraday_targets(120);
`),
    );
    expect(lines(out, "row")).toEqual(["AKBNK"]);
  });

  it("keeps the 7-day news window", () => {
    const out = runPsql(
      withFixtures(`
insert into public.bist_companies (tickers, title, shares_traded) values
  (array['OLDNEWS'], 'o', true), (array['NEWNEWS'], 'n', true);
insert into public.article_tickers (article_id, ticker, matched_on, created_at) values
  ('${A1}', 'OLDNEWS', 'alias:o', now() - interval '8 days'),
  ('${A2}', 'NEWNEWS', 'alias:n', now() - interval '6 days');
select 'row', ticker from public.bist_intraday_targets(120);
`),
    );
    expect(lines(out, "row")).toEqual(["NEWNEWS"]);
  });

  it("orders never-fetched tickers first, then the oldest bar, and carries each ticker's own last_ts", () => {
    const out = runPsql(
      withFixtures(`
insert into public.bist_companies (tickers, title, shares_traded) values
  (array['EREGL'], 'e', true), (array['SAHOL'], 's', true), (array['THYAO'], 't', true), (array['AKBNK'], 'a', true);
insert into public.article_tickers (article_id, ticker, matched_on) values
  ('${A1}', 'EREGL', 'alias:e'), ('${A2}', 'SAHOL', 'alias:s'), ('${A3}', 'THYAO', 'alias:t'), ('${A4}', 'AKBNK', 'alias:a');
insert into public.bist_bars_5m (ticker, ts, close) values
  ('THYAO', timestamptz '2026-11-05 09:00:00+00', 1), ('THYAO', timestamptz '2026-11-05 09:05:00+00', 1),
  ('SAHOL', timestamptz '2026-11-05 08:00:00+00', 1);
select 'row', ticker, coalesce(to_char(last_ts at time zone 'UTC', 'HH24:MI'), 'null') from public.bist_intraday_targets(120);
`),
    );
    // never-fetched (AKBNK, EREGL by name), then SAHOL (08:00), then THYAO (09:05, the max of its two bars)
    expect(lines(out, "row")).toEqual(["AKBNK|null", "EREGL|null", "SAHOL|08:00", "THYAO|09:05"]);
  });

  it("bounds the result to p_limit and p_limit defaults to 120", () => {
    const out = runPsql(
      withFixtures(`
insert into public.bist_companies (tickers, title, shares_traded) values (array['AAA', 'BBB', 'CCC'], 'abc', true);
insert into public.article_tickers (article_id, ticker, matched_on) values
  ('${A1}', 'AAA', 'x'), ('${A2}', 'BBB', 'x'), ('${A3}', 'CCC', 'x');
select 'two', count(*) from public.bist_intraday_targets(2);
select 'zero', count(*) from public.bist_intraday_targets(0);
select 'default', count(*) from public.bist_intraday_targets();
`),
    );
    expect(lines(out, "two")).toEqual(["2"]);
    expect(lines(out, "zero")).toEqual(["0"]);
    expect(lines(out, "default")).toEqual(["3"]);
  });

  it("returns 120 of 150 traded news tickers when the set is larger than the limit (rotation still works: the stalest first)", () => {
    const out = runPsql(
      withFixtures(`
insert into public.bist_companies (tickers, title, shares_traded)
  select array['T' || lpad(g::text, 3, '0')], 'c' || g, true from generate_series(1, 150) g;
-- 150 news tickers, spread over the six fixture articles
insert into public.article_tickers (article_id, ticker, matched_on)
  select (array['${A1}', '${A2}', '${A3}', '${A4}', '${A5}', '${A6}'])[1 + g % 6]::uuid, 'T' || lpad(g::text, 3, '0'), 'x'
  from generate_series(1, 150) g;
-- T001..T030 already have a fresh bar, so they sort last and fall outside the 120
insert into public.bist_bars_5m (ticker, ts, close)
  select 'T' || lpad(g::text, 3, '0'), timestamptz '2026-11-05 09:00:00+00', 1 from generate_series(1, 30) g;
select 'n', count(*), count(*) filter (where last_ts is null) from public.bist_intraday_targets(120);
select 'fresh_in_batch', count(*) from public.bist_intraday_targets(120) where last_ts is not null;
`),
    );
    expect(lines(out, "n")).toEqual(["120|120"]);
    expect(lines(out, "fresh_in_batch")).toEqual(["0"]);
  });

  it("has 058's attributes: invoker, stable, no SET clause, the same return columns, and the new body", () => {
    const out = runPsql(`
select 'attrs', p.prosecdef, p.provolatile, coalesce(p.proconfig::text, 'null'), p.proretset,
       pg_get_function_result(p.oid), pg_get_function_arguments(p.oid), l.lanname, md5(p.prosrc)
  from pg_proc p join pg_language l on l.oid = p.prolang
 where p.oid = 'public.bist_intraday_targets(integer)'::regprocedure;
select 'overloads', count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'bist_intraday_targets';
`);
    expect(lines(out, "attrs")).toEqual([
      `f|s|null|t|TABLE(ticker text, last_ts timestamp with time zone)|p_limit integer DEFAULT 120|sql|${md5(functionBody(sql160))}`,
    ]);
    expect(lines(out, "overloads")).toEqual(["1"]);
  });

  it("is service_role only, as production has it (anon, authenticated and public cannot execute)", () => {
    const out = runPsql(`
select 'priv',
  has_function_privilege('anon', 'public.bist_intraday_targets(integer)', 'execute'),
  has_function_privilege('authenticated', 'public.bist_intraday_targets(integer)', 'execute'),
  has_function_privilege('service_role', 'public.bist_intraday_targets(integer)', 'execute');
select 'grantees', coalesce(string_agg(g, ',' order by g), '')
  from (select case when a.grantee = 0 then 'public' else a.grantee::regrole::text end as g
          from pg_proc p, aclexplode(p.proacl) a
         where p.oid = 'public.bist_intraday_targets(integer)'::regprocedure and a.grantee <> p.proowner) s;
`);
    expect(lines(out, "priv")).toEqual(["f|f|t"]);
    expect(lines(out, "grantees")).toEqual(["service_role"]);
  });

  it("the ledger row is there once", () => {
    expect(runPsql("select count(*) from supabase_migrations.schema_migrations where version = '160';").trim()).toBe("1");
  });
});
