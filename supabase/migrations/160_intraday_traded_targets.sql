-- 160_intraday_traded_targets.sql
--
-- quotes-ingest {"mode":"intraday"} stops spending its 120 slots on codes Yahoo does not know. One function
-- replaced, with the same signature: public.bist_intraday_targets(p_limit) now takes the distinct tickers the
-- news named in the last 7 days INTERSECTED with the traded set (bist_companies.shares_traded) that the daily
-- job already uses (bist_daily_targets, 051 / 052). No table, column, index, trigger, cron job or data change
-- (h39-pipeline2-2, hunt 39, 2026-11-05).
--
-- WHY (evidence: production, read-only, 2026-11-05)
--   * 058's body is: select distinct ticker from article_tickers over 7 days, left join max(ts) from
--     bist_bars_5m, order by b.last_ts nulls first, t.ticker, limit p_limit. It has no shares_traded filter. A
--     news code that is not a traded share never gets a bar, so its last_ts stays NULL and "nulls first" puts
--     it at the head of every run for ever. Yahoo answers it with 404 and the function sends it again 5 minutes
--     later.
--   * Last 7 days (re-counted read-only for this header): 186 news tickers, 131 with a bar in the last 2 days,
--     55 with none; 52 of the 55 have no shares_traded company in bist_companies, the other 3 are traded (OYA,
--     SEK, TERA). The 12:35:00Z quotes-intraday response (net._http_response 375855) read tickers 120, fetched
--     66, 54 failures "yahoo 404" (AKCVR, AKCKM, ARTI, ATAC, AYDGN, BOYNR, DENIZ, DNZ, FNCLL, KILER, OYA, SEK,
--     TRMEN ...). The never-fetched codes took 54 of the 120 slots, so the 131 real tickers were read every
--     other run only. cron.job quotes-intraday runs '*/5 7-15 * * 1-5': about 650 Yahoo requests an hour that
--     were certain to 404. Bar lag for news tickers at 12:25-12:31Z (audit measurement, not re-run here): p50
--     22.9 min, p90 27.9 min, against Yahoo's roughly 15 minute delay plus the 5 minute cadence.
--   * The daily mode already restricts to traded tickers (051 / 052: 'select distinct unnest(tickers) from
--     bist_companies where shares_traded'); the intraday mode never got the same filter.
--
-- WHAT CHANGES
--   public.bist_intraday_targets(p_limit int default 120) returns table (ticker text, last_ts timestamptz),
--   language sql, stable: create or replace with the SAME signature, return columns, language, volatility and
--   security as 058 section 7, so no drop is needed and quotes-ingest (which calls it with p_limit = 120 and
--   reads ticker and last_ts) needs no change. The body is 058's body except for two added lines in the `t`
--   subquery: "intersect" and the traded set, written exactly as bist_daily_targets writes it
--   ('select distinct unnest(tickers) as ticker from public.bist_companies where shares_traded'). The left join
--   on bist_bars_5m, "order by b.last_ts nulls first, t.ticker" and "limit p_limit" are unchanged, so the
--   staleness rotation works as before. tests/migrations/160-intraday-traded-targets.test.ts derives the
--   expected body from 058's text and compares.
--   EXECUTE: 058's revoke and grant for this function, statement for statement (revoked from anon,
--   authenticated and public; granted to service_role only). Both are no-ops on production, where the ACL
--   already is the one below, and they make the file stand on its own.
--
-- PRODUCTION FINGERPRINT THE REPLACE WAS BASED ON (read-only, 2026-11-05, pg_get_functiondef + pg_proc)
--   public.bist_intraday_targets(integer): LANGUAGE sql, STABLE, SECURITY INVOKER, proconfig NULL, proretset,
--   owner postgres, result TABLE(ticker text, last_ts timestamp with time zone), arguments
--   "p_limit integer DEFAULT 120", the only overload.
--   md5(prosrc) = ee892ad1547b7563bb43bb3ba4b17e52 (length 315), which is the md5 of the text between the $$
--   markers of 058 section 7, the latest migration that defines it (the test recomputes it).
--   proacl = {postgres=X/postgres,service_role=X/postgres}
--   new md5(prosrc): 36d7209bf11615ba628fcee3f274faa3 (length 422)
--
-- REPLAY (production, SELECT only through sbq.py, the new body run inline, p_limit 120)
--   * candidates: 186 distinct news tickers before, 134 after (52 removed, every one of them in the 404 list).
--   * the 120 rows: 54 of 120 were in the 12:35Z 404 list before, 2 of 120 after: OYA and SEK, traded shares
--     with no Yahoo data that stay never-fetched and so still sort first (a data-quality note, not part of
--     this fix; BRISA was the third such case in the audit). 52 other tickers enter the batch (THYAO, GARAN,
--     BIMAS, TUPRS, ARCLK, FROTO, TTKOM ...); the batch is 120 of 134 candidates, so the 14 stalest wait one run.
--   * cost: EXPLAIN ANALYZE of the function body, 48.6 ms before and 48.4 ms after.
--
-- NOT TOUCHED: bist_daily_targets and the daily mode, the quotes-intraday / quotes-daily cron jobs, the
-- bist_bars_* tables, article_tickers, bist_companies, quotes-ingest's INTRADAY_LIMIT.
--
-- ROLLBACK (nothing depends on 160; one transaction): re-run ONLY 058 section 7's
-- "create or replace function public.bist_intraday_targets(p_limit int default 120)" statement (the original
-- body, md5 ee892ad1547b7563bb43bb3ba4b17e52), then delete the ledger row 160.

begin;

create or replace function public.bist_intraday_targets(p_limit int default 120)
returns table (ticker text, last_ts timestamptz)
language sql
stable
as $$
  select t.ticker, b.last_ts
  from (
    select distinct ticker from public.article_tickers
    where created_at >= now() - interval '7 days'
    intersect
    select distinct unnest(tickers) as ticker from public.bist_companies where shares_traded
  ) t
  left join (select ticker, max(ts) as last_ts from public.bist_bars_5m group by 1) b
    using (ticker)
  order by b.last_ts nulls first, t.ticker
  limit p_limit;
$$;

-- 058's grants for this function, unchanged (REVOKE names every role: revoking from public alone leaves the
-- role-direct grants and the RPC stays reachable through PostgREST).
revoke execute on function public.bist_intraday_targets(int) from anon, authenticated, public;
grant execute on function public.bist_intraday_targets(int) to service_role;

insert into supabase_migrations.schema_migrations (version, name)
  values ('160', '160_intraday_traded_targets')
  on conflict do nothing;

commit;
