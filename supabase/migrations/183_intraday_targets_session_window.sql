-- 183_intraday_targets_session_window.sql
--
-- bist_intraday_targets stops dropping a ticker mid-session. One function replaced, with the same
-- signature, and ONE line of its body changed: the news window. 160 reads `created_at >= now() - interval '7 days'`, a
-- rolling cut-off, so a ticker leaves the target list at the minute its last mention turns 7 x 24 hours old, which can
-- be 12:27 on a trading day. 183 reads Istanbul midnight 7 days back, so the target set changes only at Istanbul
-- midnight and never during the 09:55-18:15 session. No table, column, index, trigger, cron job or data change, and no
-- back-fill (h92-marketclock-1, hunt 92, 2026-11-09).
--
-- WHY (evidence: production, read-only, 2026-11-09)
--   * quotes-ingest {"mode":"intraday"} asks Yahoo for range '1d' and keeps only the bars with ts >= the ticker's own
--     last_ts, so a ticker that is out of the target list for the rest of a day never back-fills: its bars stop
--     where the list dropped it. readIntraday (src/lib/finance/queries.ts) takes the newest bar day with no
--     completeness check, and intraday-chart.tsx took the colour, the last-price tag and the aria-label from the last bar.
--   * VKING 2026-11-06: bist_bars_5m has 27 bars, 06:55Z-09:05Z, the last close 11.53 with volume 0. bist_bars_daily
--     VKING 2026-11-06 closed at 12.09 (volume 307202), bist_quote_stats says last_close 12.09, prev_close 11.67. VKING's
--     only article_tickers row of the last 30 days is 2026-10-30 09:27:07Z, which turned 7 days old at 2026-11-06 09:27Z,
--     about 20 minutes after the last bar. The live page said 'son 11,53' in red under a header of 12,09 and %3,60.
--   * Per session, tickers whose last 5m bar is before 17:30 Istanbul, and how many of them ended more than 0.5 % away
--     from the daily close (bist_bars_5m + bist_bars_daily, re-counted 2026-11-09), cut / off by more than 0.5 %:
--       10-26 4 / 3    10-27 10 / 8    10-28 183 / 1 (half day, the session ended 12:30)    10-30 3 / 3
--       11-02 5 / 4    11-03 8 / 4     11-04 8 / 6    11-05 3 / 2    11-06 4 / 3        (10-29 was a holiday)
--     For 11-02 .. 11-06 every one of the 28 cut ticker-sessions is a window cut: its last mention before the open turned
--     7 days old during that session and no later mention arrived before that moment.
--
-- WHAT CHANGES
--   public.bist_intraday_targets(p_limit int default 120) returns table (ticker text, last_ts timestamptz), language
--   sql, stable: create or replace with the SAME signature, return columns, language, volatility and security as 058 /
--   160, so no drop is needed and quotes-ingest (which calls it with p_limit = 120 and reads ticker and last_ts) needs
--   no change. The body is 160's body verbatim except the window line, which becomes
--       where created_at >= (((now() at time zone 'Europe/Istanbul')::date - 7)::timestamp at time zone 'Europe/Istanbul')
--   that is the Istanbul calendar date today minus 7, as a timestamp at Istanbul midnight, converted back to timestamptz.
--   The traded intersect, the left join on bist_bars_5m, "order by b.last_ts nulls first, t.ticker" and "limit p_limit"
--   are unchanged, so the staleness rotation works as before.
--   tests/migrations/183-intraday-targets-session-window.test.ts reads 160's body from its file and asserts the 183 body
--   differs in that one line only.
--   EXECUTE: 160's revoke and grant for this function, statement for statement (revoked from anon, authenticated and
--   public; granted to service_role only). Both are no-ops on production, where the ACL already is the one below.
--
-- PRODUCTION FINGERPRINT THE REPLACE WAS BASED ON (read-only, 2026-11-09, pg_proc)
--   public.bist_intraday_targets(integer): LANGUAGE sql, STABLE (provolatile s), SECURITY INVOKER (prosecdef false).
--   md5(prosrc) = 36d7209bf11615ba628fcee3f274faa3 (length 422), which is the md5 of the text between the $$ markers of
--   160 (the test recomputes it).
--   proacl = {postgres=X/postgres,service_role=X/postgres}
--   new md5(prosrc): da2a5d8f48697ec2b709b18a89cc6962 (length 491)
--
-- REPLAY (production, SELECT only through sbq.py, the old and the new body run inline)
--   * VKING 2026-11-06, the target set at that instant (mentions up to it): in the set at 06:55Z and 09:00Z under both
--     windows; at 09:30Z, 12:00Z and 15:00Z OUT under 160's window, IN under 183's. 183's window start is 2026-10-29
--     21:00Z from the open to the close and VKING's mention (2026-10-30 09:27:07Z) is after it; VKING leaves the set
--     at Istanbul midnight, 2026-11-06 21:00Z. Under 160 its bars stopped at 12:05 Istanbul (11.53); the daily close
--     is 12.09.
--   * Candidates (traded news tickers) old / new at 2026-11-06 06:55Z 137 / 141, 09:00Z 138 / 144, 09:30Z 137 / 144,
--     12:00Z 137 / 145, 15:00Z 139 / 147, 21:30Z 140 / 140; with now() (2026-11-09 02:51Z) 146 / 146 and the 120 rows
--     are the same 120. The batch stays 120 of 137+ candidates, so the stalest-first rotation is as it was; the 4 to 8
--     extra candidates during a session are exactly the tickers 160 would have cut.
--   * Cost: EXPLAIN ANALYZE of the body, median of 3 runs, 51.6 ms with 160's window and 51.7 ms with 183's.
--
-- NOT TOUCHED: bist_daily_targets and the daily mode, the quotes-intraday / quotes-daily cron jobs, the bist_bars_*
-- tables, article_tickers, bist_companies, quotes-ingest's INTRADAY_LIMIT. Bars already missing (VKING 11-06 and the
-- 27 other ticker-sessions above) are not rewritten; the ticker page states the settled close for such a session
-- (intradayCutShort in src/lib/finance/session.ts) until a newer bar day replaces it.
--
-- ROLLBACK (nothing depends on 183; one transaction): re-run ONLY the "create or replace function
-- public.bist_intraday_targets(p_limit int default 120)" statement of 160_intraday_traded_targets.sql (md5(prosrc)
-- 36d7209bf11615ba628fcee3f274faa3), then delete the ledger row 183
-- (remove version '183' from supabase_migrations.schema_migrations). The ACL does not change in either direction.

begin;

create or replace function public.bist_intraday_targets(p_limit int default 120)
returns table (ticker text, last_ts timestamptz)
language sql
stable
as $$
  select t.ticker, b.last_ts
  from (
    select distinct ticker from public.article_tickers
    where created_at >= (((now() at time zone 'Europe/Istanbul')::date - 7)::timestamp at time zone 'Europe/Istanbul')
    intersect
    select distinct unnest(tickers) as ticker from public.bist_companies where shares_traded
  ) t
  left join (select ticker, max(ts) as last_ts from public.bist_bars_5m group by 1) b
    using (ticker)
  order by b.last_ts nulls first, t.ticker
  limit p_limit;
$$;

-- 160's grants for this function, unchanged (REVOKE names every role: revoking from public alone leaves the
-- role-direct grants and the RPC stays reachable through PostgREST).
revoke execute on function public.bist_intraday_targets(int) from anon, authenticated, public;
grant execute on function public.bist_intraday_targets(int) to service_role;

insert into supabase_migrations.schema_migrations (version, name)
  values ('183', '183_intraday_targets_session_window')
  on conflict do nothing;

commit;
