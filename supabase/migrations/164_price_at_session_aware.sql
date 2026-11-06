-- 164_price_at_session_aware.sql
--
-- The /ekonomi "haberden" chip (the move since the headline) stops using a 5-minute bar from before the
-- closing auction of the newest completed daily close's day. One function replaced, with the same signature:
-- public.price_at(p_ticker, p_ts). No table, column, index, trigger, cron job or data change, and no change to
-- its only caller feed_reference_prices() (h48-ekonomi-1, hunt 48, 2026-11-06).
--
-- WHY (evidence: production, read-only, 2026-11-06)
--   * 062's body is: coalesce(<latest 5-minute bar within the 4 days before p_ts>, <daily close of the
--     reference day>). The 5-minute bar wins whenever one exists, however old. bist_bars_5m is only filled for
--     the tickers the news named in the last 7 days and is pruned after 14 days (058), so a ticker that was in
--     the news two sessions ago and not since keeps a stale bar that out-ranks every newer daily close.
--   * /ekonomi, HSBC row "TUPRS, SASA, DOHOL, THYAO": "DOHOL 17,98 +%2,39 +%9,77 haberden". price_at('DOHOL',
--     '2026-11-05 22:08+00') returned 16.38, the 13:05Z bar of 3 Nov, although bist_bars_daily holds DOHOL
--     3 Nov 16.38, 4 Nov 17.27, 5 Nov 17.56. Against 17.56 the move is about +2,4 %, not +9,77 %.
--   * "Bloomberg HT 05.11 19:43 Şişecam üçüncü çeyrekte zarar açıkladı": "SISE 33,46 -%5,53 +%0,18 haberden".
--     price_at('SISE', '2026-11-05 21:00+00') returned 33.40, the 13:45Z bar of 2 Nov; the 5 Nov daily close is
--     35.42, so the move since the headline equals the day move (-5,5 %) and the chip should not print.
--   * The same thing happens inside ONE day when a ticker's bars drop out mid-session. KARCL, KRDMA and KRDMB
--     have only 3 five-minute bars on 4 Nov, the last at 07:05Z (10:05 Istanbul), while bist_bars_daily holds
--     their 4 Nov closes (28.60, 35.18, 55.40). A rule that only compares dates keeps that 10:05 bar for the
--     rest of the day and the next morning: price_at('KARCL', '2026-11-04 18:01:25+00') and ('KARCL',
--     '2026-11-05 06:30+00') return 26.58 (062 returns the same), the close is 28.60; price_at('KRDMB',
--     '2026-11-04 21:04:51+00') returns 51.55, the close is 55.40; price_at('ENJSA', '2026-11-03 06:18+00')
--     returns 110.50 from the 2 Nov 13:40Z (16:40 Istanbul) bar, the 2 Nov close is 111.10. Intraday is
--     unaffected: KARCL at '2026-11-04 08:00+00' gives 26.58 under both rules (reference day 3 Nov).
--   * Why 18:00 Istanbul: no bar in bist_bars_5m is later than 18:00 Istanbul time (0 of 125,599). Over 2 to 5 Nov
--     the 18:00 bar's close equals the daily close in 517 of 526 ticker-days, the 17:55 bar's in 173 of 544. So
--     the 18:00 bar is the day's last print and a bar counts as such only at or after 18:00; any earlier bar of
--     the daily row's day is not the close.
--   * page: src/app/ekonomi/page.tsx pctChange(refs[...], q.price), refs from feed_reference_prices (051).
--
-- WHAT CHANGES
--   public.price_at(p_ticker text, p_ts timestamptz) returns numeric, language sql, stable, SECURITY INVOKER,
--   no SET clause: create or replace with the SAME signature, return type, language, volatility and security as
--   062, so no drop is needed and feed_reference_prices() needs no change. The two lookups are 062's, text for
--   text (the latest 5-minute bar in [p_ts - 4 days, p_ts], and the latest bist_bars_daily row with day <= the
--   reference day, where the reference day is the Istanbul date of p_ts from 18:10 Istanbul time on and the
--   day before that otherwise). What changes is who wins:
--     * a 5-minute bar is returned only when it exists AND (there is no daily row OR the bar is at or after
--       18:00 Istanbul time of the day of that daily row: b.ts >= (d.day + time '18:00') at time zone
--       'Europe/Istanbul');
--     * otherwise the daily close is returned; null when neither exists.
--   So the intraday case (a bar of a later session than the reference day, always at or after 18:00 of the
--   day before it) is unchanged, and the 18:00 closing-auction bar of the daily row's day still wins. What is
--   ignored is every bar BEFORE 18:00 Istanbul time of the daily row's day: a bar from an older session, and
--   a mid-session bar of the same day (a dropout such as KARCL's 10:05 bar, or the 17:55 bar), because the
--   daily close of that day is the better price. The threshold is in Istanbul time, not UTC: a bar at 15:00Z
--   is the 18:00 closing auction. The two lookups are left-joined subqueries (no coalesce), so the function always reads both
--   primary-key indexes (bist_bars_5m, bist_bars_daily; one row each) instead of stopping after the first.
--   Cost, EXPLAIN ANALYZE on production over the 675 pairs of the replay below, 3 runs each: 92.2 to 97.1 ms
--   with 062's price_at, 92.0 to 98.8 ms with the new body inline.
--   tests/migrations/164-price-at-session-aware.test.ts pins 062's body to production by md5 and checks that
--   both lookups are carried over verbatim.
--   EXECUTE: 058's revoke and grant for this function, statement for statement (revoked from anon,
--   authenticated and public; granted to service_role only). Both are no-ops on production, where the ACL
--   already is the one below, and they make the file stand on its own.
--
-- PRODUCTION FINGERPRINT THE REPLACE WAS BASED ON (read-only, 2026-11-06, pg_get_functiondef + pg_proc)
--   public.price_at(text, timestamp with time zone): LANGUAGE sql, STABLE, SECURITY INVOKER, proconfig NULL,
--   returns numeric, owner postgres, the only overload.
--   md5(prosrc) = 57f79dbd2e2845d01d44bce6c67d4354 (length 533), which is the md5 of the text between the $$
--   markers of 062 section 2, the latest migration that defines it (the test recomputes it).
--   proacl = {postgres=X/postgres,service_role=X/postgres}
--   new md5(prosrc): 062c2405345dd5e61a3bdb11f6474eb5 (length 827)
--
-- REPLAY (production, SELECT only through sbq.py, 2026-11-06 10:38Z, the new body run inline next to public.price_at)
--   article_tickers x articles published since 2026-11-03 00:00Z on traded tickers (bist_companies.shares_traded):
--   675 pairs, 112 tickers. 38 pairs change, on exactly nine tickers: AGHOL 17 (25.02 -> 25.22, bar of 30 Oct,
--   daily day 2 Nov), KARCL 4 (26.58 -> 28.60), KRDMA 4 (34.42 -> 35.18), KRDMB 4 (51.55 -> 55.40) (these three:
--   the 4 Nov 07:05Z dropout bar, daily day 4 Nov), LMKDC 3 (18.93 -> 20.40, bar of 2 Nov, daily day 3 Nov),
--   KRSTL 2 (6.29 -> 6.58), SISE 2 (33.40 -> 35.42, bar of 2 Nov, daily day 5 Nov), DOHOL 1 (16.38 -> 17.56, bar
--   of 3 Nov, daily day 5 Nov), ENJSA 1 (110.50 -> 111.10, bar of 2 Nov 13:40Z, daily day 2 Nov). 25 of the 38
--   have a bar from an older day than the daily row, 13 a bar from the daily row's own day before 18:00
--   Istanbul. Pairs with a bar at or after 18:00 Istanbul of the daily day: 604, changed: 0. Changed pairs whose
--   bar is at or after that threshold: 0. Null prices: 10 before, 10 after (no bar and no daily row).
--   A second run with this file's function body itself as the inline SELECT (built from the file text, p_ticker
--   and p_ts substituted by column references) gave the same 675 pairs, 112 tickers, 38 changes on 9 tickers.
--   (The rule of this file's first draft, bar date >= daily day, changed 25 of these 38 pairs, none of the 13.)
--
-- NOT TOUCHED: feed_reference_prices, bar_returns, the bist_bars_* tables, quotes-ingest, the 14-day prune of
-- bist_bars_5m, the /ekonomi page code.
--
-- AFTER DEPLOY: GET /ekonomi. The DOHOL chip on the HSBC row reads about +%2,4 haberden (price / 17.56 - 1),
-- and the post-close Şişecam rows no longer print "haberden" (equal to the day move, so hidden as redundant).
--
-- LEDGER: this file records version 164 in supabase_migrations.schema_migrations itself, idempotently (the 095
-- pattern: insert ... on conflict do nothing, last statement before commit), so applying it by posting the
-- SQL (management API or psql) leaves `supabase migration list` correct; `supabase db push` records the same
-- row. Re-applying is harmless (create or replace, and the ledger insert does nothing the second time).
--
-- ROLLBACK (nothing depends on 164; one transaction): re-run ONLY 062 section 2's
-- "create or replace function public.price_at(p_ticker text, p_ts timestamptz)" statement (the original body,
-- md5 57f79dbd2e2845d01d44bce6c67d4354), then delete the ledger row 164.

begin;

create or replace function public.price_at(p_ticker text, p_ts timestamptz)
returns numeric
language sql
stable
as $$
  select case
           when b.ts is not null
                and (d.day is null or b.ts >= (d.day + time '18:00') at time zone 'Europe/Istanbul')
             then b.close
           else d.close
         end
    from (select 1) one
    left join (
      select ts, close from public.bist_bars_5m
       where ticker = p_ticker and ts <= p_ts
         and ts >= p_ts - interval '4 days'
       order by ts desc limit 1
    ) b on true
    left join (
      select day, close from public.bist_bars_daily
       where ticker = p_ticker
         and day <= case
           when (p_ts at time zone 'Europe/Istanbul')::time >= time '18:10'
             then (p_ts at time zone 'Europe/Istanbul')::date
           else (p_ts at time zone 'Europe/Istanbul')::date - 1
         end
       order by day desc limit 1
    ) d on true;
$$;

-- 058's grants for this function, unchanged (REVOKE names every role: revoking from public alone leaves the
-- role-direct grants and the RPC stays reachable through PostgREST).
revoke execute on function public.price_at(text, timestamptz) from anon, authenticated, public;
grant execute on function public.price_at(text, timestamptz) to service_role;

insert into supabase_migrations.schema_migrations (version, name)
  values ('164', '164_price_at_session_aware')
  on conflict do nothing;

commit;
