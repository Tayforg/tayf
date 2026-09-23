import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Static guard for 062. An earlier draft of this migration was applied from
// a stale checkout and replaced 058's hardened resolver and two views with
// plain bodies. These assertions are the properties that were lost: they
// fail if a later edit rebuilds the objects without 058's hardening.

const sql = readFileSync(
  resolve(__dirname, "..", "..", "supabase", "migrations", "062_coverage_semantics_and_context.sql"),
  "utf8",
);

function body(startMarker: string): string {
  const start = sql.indexOf(startMarker);
  expect(start).toBeGreaterThan(-1);
  const end = sql.indexOf("$$;", start);
  return sql.slice(start, end);
}

describe("migration 062_coverage_semantics_and_context.sql (static)", () => {
  it("keeps 058's resolver hardening", () => {
    const fn = body("create or replace function public.resolve_article_tickers_for");
    expect(fn).toMatch(/set search_path = ''/);
    expect(fn).toMatch(/pg_catalog\.strpos/);
    expect(fn).toMatch(/pg_catalog\.regexp_matches/);
    expect(fn).toMatch(/insert into public\.article_tickers \(article_id, ticker, matched_on, published_at, source_id\)/);
  });

  it("gates only auto aliases on finance context", () => {
    const fn = body("create or replace function public.resolve_article_tickers_for");
    expect(fn).toMatch(/al\.origin = 'manual' or r\.fin_ctx/);
    expect(fn).toMatch(/coalesce\(a\.category, ''\) <> 'spor'/);
  });

  it("re-issues security_invoker after recreating both views", () => {
    for (const view of ["finance_signals", "ml_disclosure_events"]) {
      const created = sql.indexOf(`create or replace view public.${view}`);
      const altered = sql.search(new RegExp(`alter view public\\.${view}\\s+set \\(security_invoker = on\\)`));
      expect(created).toBeGreaterThan(-1);
      expect(altered).toBeGreaterThan(created);
    }
  });

  it("uses the GIN-friendly company join and the denormalized timestamp", () => {
    expect(sql).not.toMatch(/= any \(bc\.tickers\)/);
    expect(sql.match(/bc\.tickers @> array\[c\.ticker\]/g)?.length).toBeGreaterThanOrEqual(3);
    expect(sql).toMatch(/t\.published_at >= d\.published_at - interval '24 hours'/);
  });

  it("locks down the one new function and records itself in the ledger", () => {
    expect(sql).toMatch(/revoke all on function public\.finance_context_regex\(\) from public, anon, authenticated/);
    expect(sql).toMatch(/grant execute on function public\.finance_context_regex\(\) to service_role/);
    expect(sql).toMatch(/values \('062', '062_coverage_semantics_and_context'\)/);
  });

  it("deletes stored matches by (alias, ticker), never by alias text alone", () => {
    const del = sql.slice(sql.indexOf("delete from public.article_tickers t"));
    expect(del).toMatch(/al\.ticker = t\.ticker/);
  });
});
