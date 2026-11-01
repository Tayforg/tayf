import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 134 ("bist-daily-settle").
//
// h11-finance-2: bist_daily_targets() ordered by `b.last_day nulls first,
// t.ticker limit 80`. Once every ticker holds today's bar the last_day ties
// sort alphabetically, so the same first 80 tickers were re-fetched for the
// rest of the 18:12-19:57 IST window and the other ~545 kept the first,
// pre-auction Yahoo pass (SUNTK volume 2,974,650 vs 22,170,287). 134 adds a
// nullable bist_bars_daily.fetched_at and a tie-break on it, so the targets
// rotate through every ticker.
//
// This file pins the SQL text: the additive column, the unchanged signature,
// the exact ordering, the unchanged grants and the ledger row. The ordering's
// behaviour (every ticker re-read after the auction) is proven by the pure
// rotation model in tests/functions/quotes-ingest.test.ts, which also checks
// that its sort keys are the ones pinned here. The database-level proof is the
// local PG15 dry run recorded in the migration header.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATION_134 = resolve(ROOT, "supabase", "migrations", "134_bist_daily_settle.sql");
const MIGRATION_052 = resolve(ROOT, "supabase", "migrations", "052_alias_hygiene.sql");
const MIGRATION_058 = resolve(ROOT, "supabase", "migrations", "058_finance_hardening.sql");

/** Comments removed (134 keeps `--` out of every string literal on purpose). */
function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Whitespace removed entirely: a layout-proof way to compare SQL fragments. */
function sq(sql: string): string {
  return sql.replace(/\s+/g, "");
}

/** Whitespace collapsed to single spaces. */
function collapse(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/** The `create or replace function public.bist_daily_targets ... $$ ... $$;` statement. */
function functionBlock(sql: string): string {
  const m = /create\s+or\s+replace\s+function\s+public\.bist_daily_targets\b[\s\S]*?\$\$[\s\S]*?\$\$\s*;/i.exec(sql);
  expect(m, "create or replace function public.bist_daily_targets").not.toBeNull();
  return (m as RegExpExecArray)[0];
}

/** Everything of a function statement before its `as $$` body. */
function functionHeader(sql: string): string {
  const block = functionBlock(sql);
  return block.slice(0, block.search(/\bas\s+\$\$/i));
}

let raw = "";
let code = "";

beforeAll(() => {
  expect(existsSync(MIGRATION_134), "supabase/migrations/134_bist_daily_settle.sql").toBe(true);
  raw = readFileSync(MIGRATION_134, "utf8");
  code = stripSqlComments(raw);
});

describe("134: header and shape", () => {
  it("documents WHY, the evidence, STEP 0, LOCAL PROOF, APPLY ORDER, VERIFY and ROLLBACK", () => {
    for (const needle of [
      "WHY",
      "STEP 0",
      "LOCAL PROOF",
      "APPLY ORDER",
      "VERIFY",
      "ROLLBACK",
      "SUNTK",
      "22,170,287",
      "2,974,650",
      "AYGAZ",
      "2026-10-30",
      "h11-finance-2",
    ]) {
      expect(raw, needle).toContain(needle);
    }
  });

  it("is one transaction that opens with a 5 s lock_timeout before it touches anything", () => {
    expect(code).toMatch(/^\s*begin\s*;\s*set\s+local\s+lock_timeout\s*=\s*'5s'\s*;/i);
    expect(code).toMatch(/commit\s*;\s*$/i);
    expect(code.search(/set\s+local\s+lock_timeout/i)).toBeLessThan(code.search(/\balter\s+table\b/i));
  });

  it("is additive: no drop, truncate, delete, update, insert into a data table or index build", () => {
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    expect(code).not.toMatch(/\bupdate\b/i);
    expect(code).not.toMatch(/\bcreate\s+(?:unique\s+)?index\b/i);
    const inserts = [...code.matchAll(/\binsert\s+into\s+([\w.]+)/gi)].map((m) => m[1]);
    expect(inserts).toEqual(["supabase_migrations.schema_migrations"]);
  });

  it("alters exactly one table and touches no other finance table", () => {
    const alters = [...code.matchAll(/\balter\s+table\b([^;]*);/gi)].map((m) => collapse(m[0]));
    expect(alters).toEqual(["alter table public.bist_bars_daily add column if not exists fetched_at timestamptz;"]);
    expect(code).not.toMatch(/\bbist_bars_5m\b/i);
    expect(code).not.toMatch(/\bcreate\s+table\b/i);
    expect(code).not.toMatch(/\bcreate\s+(?:or\s+replace\s+)?view\b/i);
  });

  it("ends with the schema_migrations ledger row in the 095 pattern, then commit", () => {
    expect(sq(code)).toContain(
      sq(`insert into supabase_migrations.schema_migrations (version, name)
        values ('134', '134_bist_daily_settle')
        on conflict do nothing;`),
    );
    expect(code.indexOf("schema_migrations")).toBeLessThan(code.search(/commit\s*;\s*$/i));
  });

  it("reloads the PostgREST schema cache (so the new column is writable at once)", () => {
    expect(code).toMatch(/notify\s+pgrst\s*,\s*'reload schema'\s*;/i);
  });

  it("holds no secret-looking literal", () => {
    expect(raw).not.toContain("eyJ");
    expect(raw).not.toContain("Bearer ey");
    expect(raw).not.toContain("sb_secret");
  });
});

describe("134: bist_bars_daily.fetched_at", () => {
  it("adds a nullable timestamptz with no default, no NOT NULL and no backfill", () => {
    const m = /\balter\s+table\s+public\.bist_bars_daily\b[^;]*;/i.exec(code);
    expect(m, "alter table public.bist_bars_daily").not.toBeNull();
    const stmt = collapse((m as RegExpExecArray)[0]);
    expect(stmt).toBe("alter table public.bist_bars_daily add column if not exists fetched_at timestamptz;");
    expect(stmt).not.toMatch(/\bdefault\b/i);
    expect(stmt).not.toMatch(/\bnot\s+null\b/i);
    expect(stmt).not.toMatch(/\bgenerated\b/i);
    expect(code).not.toMatch(/\bupdate\b/i);
  });

  it("documents the column", () => {
    expect(code).toMatch(/comment\s+on\s+column\s+public\.bist_bars_daily\.fetched_at\s+is\s+'/i);
  });
});

describe("134: public.bist_daily_targets(p_limit int default 80)", () => {
  it("keeps the 052 signature and return type", () => {
    const s = sq(functionHeader(code));
    expect(s).toContain("createorreplacefunctionpublic.bist_daily_targets(p_limitintdefault80)");
    expect(s).toContain("returnstable(tickertext,last_daydate)");

    // Same header as the definition production runs today (052:154-157).
    const prior052 = functionHeader(stripSqlComments(readFileSync(MIGRATION_052, "utf8")));
    expect(sq(functionHeader(code))).toBe(sq(prior052));
  });

  it("is language sql, stable, security invoker and sets no search_path (as in production, 2026-11-01)", () => {
    const header = functionHeader(code);
    expect(header).toMatch(/\blanguage\s+sql\b/i);
    expect(header).toMatch(/\bstable\b/i);
    expect(header).not.toMatch(/\bsecurity\s+definer\b/i);
    expect(header).not.toMatch(/\bset\s+search_path\b/i);
    expect(code).not.toMatch(/\bsecurity\s+definer\b/i);
  });

  it("targets the traded tickers of bist_companies with at least four characters", () => {
    const body = collapse(functionBlock(code));
    expect(body).toContain("select distinct unnest(c.tickers) as ticker from public.bist_companies c where c.shares_traded");
    expect(body).toMatch(/where length\(t\.ticker\) >= 4\b/i);
  });

  it("probes each ticker's newest bar through the primary key (one lateral index probe, not a full group by)", () => {
    const body = collapse(functionBlock(code));
    expect(body).toContain(
      "left join lateral ( select d.day as last_day, d.fetched_at as last_fetched from public.bist_bars_daily d where d.ticker = t.ticker order by d.day desc limit 1 ) b on true",
    );
    expect(body).not.toMatch(/\bgroup by\b/i);
    expect(body).not.toMatch(/\bmax\s*\(/i);
  });

  it("orders by last_day, then by the last fetch (never-fetched first), then ticker, and limits to p_limit", () => {
    const body = collapse(functionBlock(code));
    expect(body).toContain("order by b.last_day nulls first, b.last_fetched nulls first, t.ticker limit p_limit;");
  });

  it("no longer orders by (last_day, ticker) alone: that was the stuck-alphabet bug", () => {
    const body = collapse(functionBlock(code));
    expect(body).not.toMatch(/order by b\.last_day nulls first, t\.ticker/i);
  });

  it("qualifies every relation (the function sets no search_path)", () => {
    const block = functionBlock(code);
    for (const rel of [...block.matchAll(/\b(?:from|join)\s+([a-z_][\w.]*)/gi)].map((m) => m[1] as string)) {
      if (rel === "lateral") continue;
      expect(rel, `relation ${rel}`).toMatch(/^public\./);
    }
  });

  it("is revoked from anon, authenticated and public, and granted to service_role only", () => {
    expect(collapse(code)).toContain(
      "revoke execute on function public.bist_daily_targets(int) from anon, authenticated, public;",
    );
    expect(collapse(code)).toContain("grant execute on function public.bist_daily_targets(int) to service_role;");
    expect(code.search(/revoke\s+execute/i)).toBeGreaterThan(code.search(/create\s+or\s+replace\s+function/i));
    expect(code.search(/grant\s+execute/i)).toBeGreaterThan(code.search(/revoke\s+execute/i));
  });

  it("uses the same (int) signature 058 revoked and granted", () => {
    const text058 = stripSqlComments(readFileSync(MIGRATION_058, "utf8"));
    expect(collapse(text058)).toMatch(/revoke execute on function[^;]*public\.bist_daily_targets\(int\)[^;]*from anon, authenticated, public;/i);
    expect(collapse(text058)).toMatch(/grant execute on function[^;]*public\.bist_daily_targets\(int\)[^;]*to service_role;/i);
  });

  it("grants nothing to anon, authenticated or public anywhere, and opens no default privileges", () => {
    const offenders: string[] = [];
    for (const piece of code.split(";")) {
      const stmt = piece.replace(/\s+/g, " ").trim();
      const m = /^grant\b[\s\S]*?\bto\b([\s\S]*)$/i.exec(stmt);
      if (!m) continue;
      const roles = (m[1] as string).toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
      if (roles.some((r) => ["anon", "authenticated", "public"].includes(r))) offenders.push(stmt);
    }
    expect(offenders).toEqual([]);
    expect(code).not.toMatch(/alter\s+default\s+privileges/i);
  });

  it("grants no table privilege to anyone (the new column rides on the service-role writes)", () => {
    expect(code).not.toMatch(/\bgrant\b[^;]*\bon\s+(?:table\s+)?public\.bist_bars_daily\b/i);
    expect(code).not.toMatch(/\bgrant\b[^;]*\b(?:insert|update|delete|truncate|maintain)\b/i);
  });
});
