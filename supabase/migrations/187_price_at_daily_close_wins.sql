-- 187_price_at_daily_close_wins.sql
--
-- The /ekonomi "haberden" chip (the move since the headline) measures a headline published after a session's close
-- from the SETTLED daily close, not from the volume-0 18:00 stub bar of that session. One function replaced, with the
-- same signature: public.price_at(p_ticker, p_ts). No table, column, index, trigger, cron job or data change, and no
-- change to its only caller feed_reference_prices() (h99-financenumbers-3, hunt 99, 2026-11-09).
--
-- WHY (evidence: production, read-only, 2026-11-09 07:30Z)
--   * 164's rule lets a 5-minute bar win when it is at or after 18:00 Istanbul of the daily row's day, on the premise
--     that the 18:00 bar is the closing-auction print and therefore the close. It is not always: bist_bars_5m holds a
--     bar at 18:00 for most tickers, and that bar is very often a stub (open = high = low = close, volume 0). Across
--     2 to 6 Nov, 128 to 145 of about 150 to 160 sessions a day end on a volume-0 18:00 stub, and the stub differs
--     from the settled daily close in only 2, 3, 2, 2 and 1 of them (largest gaps 0.36, 0.30, 0.53, 0.57, 0.06 %).
--     The daily row is the settled close (the closing auction included) and it is the price Yahoo quotes.
--   * VAKBN: bist_bars_5m 2026-11-06 15:00:00Z (18:00 Istanbul) is open = high = low = close = 33.04, volume 0, while
--     bist_bars_daily 2026-11-06 closes at 33.06. public.price_at('VAKBN', '2026-11-08T12:32:00+03:00') and
--     public.price_at('VAKBN', '2026-11-09T00:00:00+03:00') both return 33.04. /ekonomi shows VAKBN 33,28 +%0,67
--     (the day move, from 33.06); a headline published after Friday's close printed "+%0,73 haberden" (33.28 / 33.04),
--     different from the day move only because of the stub, so it was not hidden as redundant. On 5 Nov the stub was
--     31.62 against a daily close of 31.80 (-0.57 %).
--   * page: src/app/ekonomi/page.tsx pctChange(refs[...], q.price), refs from feed_reference_prices (051).
--
-- WHAT CHANGES
--   public.price_at(p_ticker text, p_ts timestamptz) returns numeric, language sql, stable, SECURITY INVOKER,
--   no SET clause: create or replace with the SAME signature, return type, language, volatility and security as
--   164, so no drop is needed and feed_reference_prices() needs no change. The two lookups are 164's (and 062's), text
--   for text: b = the latest 5-minute bar in [p_ts - 4 days, p_ts], d = the latest bist_bars_daily row with day <= the
--   reference day (the Istanbul date of p_ts from 18:10 Istanbul time on, the day before that otherwise). Only the
--   CASE changes, and only who wins:
--     * a 5-minute bar is returned when it exists AND (there is no daily row OR the Istanbul calendar date of the
--       bar is LATER than the daily row's day: (b.ts at time zone 'Europe/Istanbul')::date > d.day);
--     * otherwise the daily close is returned; null when neither exists.
--   So a completed session's settled daily close beats every bar of that session: the 18:00 stub included (164 let
--   that one win), a mid-session dropout bar (164 already ignored it) and any bar of an older session. A bar of a
--   LATER session than the newest daily row still wins, which is the live intraday case (a headline at 10:10 on a
--   Monday reads the 10:05 bar, the newest daily row being Friday's) and the window between 18:10 and the daily bar's
--   arrival (about 19:33 Istanbul), where the 18:00 bar of today is the only price of today and is used until the
--   daily row lands and replaces it. Against 164 the only readings that change are the ones where the bar falls
--   between 18:00 and midnight Istanbul of the daily row's own day (today's rule returned the bar, this one returns
--   the daily close); every other reading is byte for byte 164's. The comparison is on the Istanbul calendar date, not
--   UTC: a bar at 15:00Z is 18:00 of that same Istanbul day.
--   The two lookups stay left-joined subqueries (no coalesce), so the function always reads both primary-key
--   indexes and returns one scalar row even when neither source has data. Cost: the CASE is a comparison of two
--   values already read, so the plan is 164's.
--   tests/migrations/187-price-at-daily-close-wins.test.ts pins 164's body to production by md5 and checks that
--   both lookups are carried over verbatim.
--   EXECUTE: 058's revoke and grant for this function, statement for statement (revoked from anon,
--   authenticated and public; granted to service_role only). Both are no-ops on production, where the ACL
--   already is the one below, and they make the file stand on its own.
--
-- PRODUCTION FINGERPRINT THE REPLACE WAS BASED ON (read-only, 2026-11-09, pg_proc)
--   public.price_at(text, timestamp with time zone): LANGUAGE sql, STABLE, SECURITY INVOKER, proconfig NULL,
--   returns numeric, the only overload.
--   md5(prosrc) = 062c2405345dd5e61a3bdb11f6474eb5 (length 827), which is the md5 of the text between the $$
--   markers of 164, the latest migration that defines it (the test recomputes it).
--   proacl = {postgres=X/postgres,service_role=X/postgres}
--   new md5(prosrc): e473799ca41463d0b022e7f42c4e0fce (length 817)
--
-- REPLAY (production, SELECT only through sbq.py, 2026-11-09 07:46Z, the new body run inline next to public.price_at)
--   article_tickers x articles published since 2026-11-06 07:46Z on traded tickers (bist_companies.shares_traded),
--   the pairs feed_reference_prices() prices with public.price_at(ticker, published_at): 476 pairs, 83 tickers.
--   7 pairs change, on exactly one ticker: VAKBN 7 (33.04 -> 33.06, the 18:00 stub of 6 Nov, daily day 6 Nov).
--   Of the 476 pairs: 342 have a bar at or after 18:00 Istanbul of the daily row's own day (the readings 164 gave to
--   the bar; 7 of them change), 93 have a bar of a later session than the daily row (live intraday, unchanged), 7 a bar
--   of an older session (the daily close wins under both rules), 34 no bar at all, 0 a bar with no daily row, 0 a
--   mid-session bar of the daily day. Null prices: 6 before, 6 after (no bar and no daily row).
--
-- NOT TOUCHED: feed_reference_prices, bar_returns, the bist_bars_* tables, quotes-ingest, the 14-day prune of
-- bist_bars_5m, the /ekonomi page code.
--
-- AFTER DEPLOY: public.price_at('VAKBN', '2026-11-08T12:32:00+03:00') = 33.06 (it was 33.04), and GET /ekonomi
-- outside session hours: a row under a headline published after Friday's close no longer prints a "haberden" that
-- differs from the day move only because of a stub bar.
--
-- LEDGER: this file records version 187 in supabase_migrations.schema_migrations itself, idempotently (the 095
-- pattern: insert ... on conflict do nothing, last statement before commit), so applying it by posting the
-- SQL (management API or psql) leaves `supabase migration list` correct; `supabase db push` records the same
-- row. Re-applying is harmless (create or replace, and the ledger insert does nothing the second time).
--
-- ROLLBACK (nothing depends on 187; one transaction): re-run ONLY 164's
-- "create or replace function public.price_at(p_ticker text, p_ts timestamptz)" statement (the previous body,
-- md5 062c2405345dd5e61a3bdb11f6474eb5), then delete the ledger row 187.

begin;

create or replace function public.price_at(p_ticker text, p_ts timestamptz)
returns numeric
language sql
stable
as $$
  select case
           when b.ts is not null
                and (d.day is null or (b.ts at time zone 'Europe/Istanbul')::date > d.day)
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
  values ('187', '187_price_at_daily_close_wins')
  on conflict do nothing;

commit;
