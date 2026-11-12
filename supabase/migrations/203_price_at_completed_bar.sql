-- 203_price_at_completed_bar.sql
--
-- The /ekonomi "haberden" chip (the move since the headline) is measured from the close of the last COMPLETED
-- 5-minute bar, not from the close of the bar that contains the headline. One function replaced, with the same
-- signature: public.price_at(p_ticker, p_ts). No table, column, index, trigger, cron job or data change, and no
-- change to its only caller feed_reference_prices() (h144-ekonomi-1, hunt 144, 2026-11-12).
--
-- WHY (evidence: production, read-only, 2026-11-12 03:40Z to 04:25Z)
--   * bist_bars_5m is stamped with each bar's START (start-stamped bars): 051 says "ts is the bar start, floored to
--     5 min", so a bar with ts T covers [T, T + 5 min) and its close is the price at ts + 5 min. THYAO on 11 Nov:
--     the 09:55 bar is a volume-0 stub, the 10:00 bar has volume 1,582,333 (the first trades), the 18:00 bar is a
--     volume-0 auction stub.
--   * 187's lookup is "ts <= p_ts order by ts desc limit 1": the newest bar that has STARTED, that is the containing
--     bar, whose close is up to 5 minutes AFTER the headline. The reaction to the headline is folded into the base
--     of "haberden". 051's own comment on the function says "Last known price at or before p_ts".
--   * GLRMK, BirGun headline at 12:00:00 Istanbul on 11 Nov (09:00:00Z): price_at returned 106.80, the close of the
--     12:00 bar in which the price fell from 108.60 (the close of the 11:55 bar, the price at the headline). The last
--     price is 101.70: the page printed -4,78 % haberden; the price at the headline gives -6,35 %.
--     ASELS at 11:12: price_at 343.50, the price at the headline 342.00; with a last price of 343.25 that is -0,07 %
--     against +0,37 %, a sign flip. THYAO at 16:46: 317.00 against 317.25; the live /ekonomi row reads
--     "THYAO 314,75 +%0,32 -%0,71 haberden", the right base gives -0,79 %. TURSG at 16:42: 3.26 against 3.25.
--   * the chart (src/components/finance/intraday-chart.tsx) drew every close at the bar's stamp, five minutes early;
--     the same change ships a barCloseMinutes() helper there, which is code, not part of this file.
--
-- WHAT CHANGES
--   public.price_at(p_ticker text, p_ts timestamptz) returns numeric, language sql, stable, SECURITY INVOKER,
--   no SET clause: create or replace with the SAME signature, return type, language, volatility and security as
--   187, so no drop is needed and feed_reference_prices() needs no change. The body is 187's, text for text, with
--   ONE predicate changed, in the 5-minute lookup:
--       ts <= p_ts                          (187: the newest bar that has started)
--       ts <= p_ts - interval '5 minutes'   (203: the newest bar that has completed: ts + 5 min <= p_ts)
--   Everything else is 187's and unchanged: the 4-day lower bound "ts >= p_ts - interval '4 days'" stays relative to
--   p_ts; the daily lookup (the newest bist_bars_daily row with day <= the reference day, which is the Istanbul date
--   of p_ts from 18:10 Istanbul time on and the day before that otherwise); the session-day rule (a bar is returned
--   when it exists and there is no daily row OR the Istanbul calendar date of the bar is LATER than the daily row's
--   day, (b.ts at time zone 'Europe/Istanbul')::date > d.day; otherwise the daily close); the left joins from a
--   one-row relation, so the function always returns one scalar row (null when neither source has data).
--   EXECUTE: 058's revoke and grant for this function, statement for statement (revoked from anon, authenticated
--   and public; granted to service_role only), as 187 restated them. Both are no-ops on production, where the ACL
--   already is the one below, and they make the file stand on its own.
--
-- EDGE CASES (all asserted by tests/migrations/sql/203-price-at-completed-bar-dryrun.sql; THYAO fixture of 11 Nov
-- with a volume-0 stub at 09:55 and at 18:00, bars at 10:00, 11:55, 12:00 and 17:55, daily rows for 10 and 11 Nov)
--   * p_ts 10:02 Istanbul takes the 09:55 opening-auction stub of today (the 10:00 bar is still running; 187 took it).
--   * p_ts 09:58 takes the previous day's daily close: the newest completed bar is the previous session's 18:00 bar,
--     a bar of the daily row's own day, so the daily row wins by 187's rule (187 took the 09:55 stub of today).
--   * p_ts 18:03 takes the 17:55 bar close (the 18:00 bar is still running; 187 took the 18:00 stub). The reference
--     day is still the previous day before 18:10, so the bar of today wins.
--   * p_ts 18:12 takes today's daily close: the 18:00 bar is complete but it is a bar of the daily row's own day, so
--     the settled close beats it (as in 187). Until the daily row lands (about 19:33) the 18:00 bar is the price.
--   * p_ts 12:00:00 takes the 11:55 bar close, not the 12:00 bar that contains the headline: the bar is used from
--     ts + 5 min exactly, inclusive (11:59:59 reads the 11:50 bar; 12:05:00 reads the 12:00 bar).
--   A bar that is still running and is the only one gives the daily close, and null when there is none either.
--
-- PRODUCTION FINGERPRINT THE REPLACE WAS BASED ON (read-only, 2026-11-12, pg_proc and pg_get_functiondef)
--   public.price_at(text, timestamp with time zone): LANGUAGE sql, STABLE, SECURITY INVOKER, proconfig NULL,
--   returns numeric, the only overload.
--   md5(prosrc) = e473799ca41463d0b022e7f42c4e0fce (length 817), which is the md5 of the text between the $$
--   markers of 187, the latest migration that defines it (the test recomputes it).
--   proacl = {postgres=X/postgres,service_role=X/postgres}
--   new md5(prosrc): 09131d0083e06558dcd79bcd80b09c43 (length 840)
--
-- CALLERS (every place that reads price_at; production pg_proc, pg_views, pg_matviews and cron.job scanned for the
-- name, plus the repo: supabase/migrations, supabase/functions, src, scripts, .github)
--   * public.feed_reference_prices(p_article_ids uuid[]) (051): price_at(t.ticker, a.published_at) for each
--     article x ticker. The ONLY caller. Its one consumer is src/lib/finance/queries.ts readReferencePrices (the RPC)
--     for /ekonomi's "haberden" chip: pctChange(ref, live price). Its numbers move as described below; it never
--     relied on the containing bar (051 documents "last known price at or before p_ts").
--   * public.bar_returns(), ml_news_events, ml_disclosure_events do NOT call price_at (they read bist_bars_daily
--     only): unchanged. No view, materialized view, cron job, Edge Function or other src file calls it.
--   * src/lib/finance/dev-fixtures.ts priceAt() is the offline dev client's TypeScript copy ("price_at() equivalent
--     over the fixture bars", the containing-bar rule): it feeds no production number and is left as it is.
--
-- REPLAY (production, SELECT only through sbq.py, 2026-11-12 04:2xZ, the new body run inline next to
-- public.price_at; "last" is the newest bist_bars_5m close of the ticker)
--   the four examples of the evidence: price_at('GLRMK', '2026-11-11 09:00:00+00') 106.80 -> 108.60;
--   ('ASELS', '2026-11-11 08:12:00+00') 343.50 -> 342.00; ('THYAO', '2026-11-11 13:46:00+00') 317.00 -> 317.25;
--   ('TURSG', '2026-11-11 13:42:00+00') 3.26 -> 3.25. "haberden" against last: GLRMK -4,78 % -> -6,35 %, ASELS
--   -0,07 % -> +0,37 %, THYAO -0,71 % -> -0,79 %, TURSG -0,92 % -> -0,62 %.
--   article_tickers x articles published on 11 Nov (UTC day), the pairs feed_reference_prices() prices with
--   price_at(ticker, published_at): 179 pairs. 75 change (the largest move is 1.69 % of the price), 104 do not; 7 are
--   null before and 7 after (no bar and no daily row); 46 pairs move their "haberden" by 0.1 point or more; 4 change
--   the sign of (last - reference), counting a flat 0 as a sign. The 20 newest pairs (published 16:19 to 18:54
--   Istanbul): 8 change, among them EKGYO 18:01:32 18.37 -> 18.39 (the 17:55 bar instead of the 18:00 stub),
--   THYAO 16:46 317.00 -> 317.25, KGYO 16:36 7.50 -> 7.55, LMKDC 16:32 21.42 -> 21.48, TURSG 16:42 3.26 -> 3.25.
--
-- NOT TOUCHED: feed_reference_prices, bar_returns, the bist_bars_* tables, quotes-ingest, the 14-day prune of
-- bist_bars_5m, the /ekonomi page code.
--
-- AFTER DEPLOY: price_at('GLRMK', '2026-11-11 09:00:00+00') = 108.60 (it was 106.80), ASELS 342.00, THYAO 317.25,
-- TURSG 3.25 (while 11 Nov is within the 14-day bar window), and GET /ekonomi in session hours: the A Haber 16:46
-- THYAO row reads "-%0,79 haberden" against a last price of 314,75 (if it is still on the feed).
--
-- LEDGER: this file records version 203 in supabase_migrations.schema_migrations itself, idempotently (the 095
-- pattern: insert ... on conflict do nothing, last statement before commit), so applying it by posting the
-- SQL (management API or psql) leaves `supabase migration list` correct; `supabase db push` records the same
-- row. Re-applying is harmless (create or replace, and the ledger insert does nothing the second time).
--
-- ROLLBACK (nothing depends on 203; one transaction): re-run ONLY 187's
-- "create or replace function public.price_at(p_ticker text, p_ts timestamptz)" statement (the previous body,
-- md5 e473799ca41463d0b022e7f42c4e0fce), then delete the ledger row 203.

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
       where ticker = p_ticker and ts <= p_ts - interval '5 minutes'
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
  values ('203', '203_price_at_completed_bar')
  on conflict do nothing;

commit;
