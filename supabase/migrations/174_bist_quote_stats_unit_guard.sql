-- 174_bist_quote_stats_unit_guard.sql
-- h67-edgefns-1 (hunt 67). public.bist_quote_stats stops reporting a relative volume whose 20-session window is not in
-- one unit or not made of real volumes.
--
-- WHY
--   /ekonomi and /ekonomi/<ticker> print "hacim 20 günlük ortalamanın N katı" from bist_quote_stats: the last session's
--   volume over avg(volume) of the 20 rows before it (051), with no unit or zero handling. quotes-ingest (daily mode)
--   keeps only the rows with day >= last_day, so a row Yahoo has since split-adjusted stays frozen in the old unit, and a
--   halt placeholder (a flat bar with volume 0) is stored as a real row. Re-verified on 2026-11-08 (08:21-08:26 UTC, one
--   GET each plus read-only SQL):
--     MERCN  3.00004-for-1 split on 2026-10-30 (close 8.44 on 10-28, open 2.8133 and close 2.72 on 10-30). The 15 earlier
--            rows of the window are in pre-split units. The page said 1,7 (stored avg_volume_20 5,117,508.75, rvol 1.73);
--            with the 15 pre-split volumes multiplied by 3.00004 the average is 10,815,320 and the ratio is 0.82.
--     DUNYH  19 of the 20 prior rows are flat at 109.10 with volume 0 (some written by daily mode itself, fetched_at
--            11-02 .. 11-06); the only real prior print is 2026-10-12 (volume 17,013,257), so the average is 850,662.85
--            and rvol 7.51, shown in amber (>= 2). The last close is 11.92: a 109.10 -> 11.92 step is a placeholder
--            against a real price, not a trade.
--     SKBNK  10-22 close step 4.48 -> 3.21 (a unit break the same way) is inside its window until about 11-20.
--     SASA   4 zero-volume rows (real bars, open differs from close) among the 20: the average is diluted by a fifth,
--            rvol 3.44 where the real-volume average gives 2.75.
--   Scope over the 20-session windows of the 626 tickers with a 2026-11-06 bar: 3 with a close step outside 0.75 .. 1.35
--   (DUNYH 11-06, MERCN 10-30, SKBNK 10-22) and 5 with zero-volume prior rows (DUNYH 19, SASA 4, TRHOL 2, ISBTR 1,
--   RALYH 1). Not h36-data-1 / h48-ekonomi-1 / h51-morphology-2 / h57-ekonomi-1 (price base, stale 5-minute bars,
--   wording and rounding).
--
-- WHAT CHANGES (one view, no table, no data, no Edge Function, no UI copy)
--   create or replace view public.bist_quote_stats with (security_invoker = on): the same seven columns in the same
--   order with the same types (ticker, last_day, last_close, prev_close, last_volume, avg_volume_20, rvol). CTE b: per
--   ticker in day order, prev_close = lag(close) and unit_break = the close is outside 0.75 .. 1.35 of the previous
--   close (BIST's daily band is +-10 percent, so a step that large is a unit change or a placeholder, not a trade; the
--   division sits in the CASE branch that tests the divisor first). CTE ranked: break_in_window = bool_or(unit_break)
--   over the 19 preceding rows and the current one (the 20 averaged rows and the last one, so every step between them
--   is looked at), avg_nz = avg(volume) filter (where volume > 0) and n_nz = count(*) filter (where volume > 0) over the
--   20 rows before the current one (what 051 averaged; the zeros no longer count), rn as before. The row with rn = 1 is
--   output with prev_close unchanged (session.ts rebaseQuoteOnStat reads it), and
--     avg_volume_20 = null when break_in_window, or n_nz < 10, or the last volume is null or not above 0; else avg_nz
--     rvol          = round(last_volume / avg_volume_20, 2) when avg_volume_20 > 0, else null
--   avg_volume_20 is nulled too, not only rvol: queries.ts relativeVolume() divides last_volume by avg_volume_20 first
--   and uses the stored rvol only as its fallback. rvolLabel() (session.ts) returns null for a null rvol, so the
--   /ekonomi/<ticker> header drops the volume line, and ticker-chip.tsx renders its "hacim" span only when rvol is not
--   null. Every window partitions by ticker, so the app's .in('ticker', ...) filter still reaches the bars' primary key.
--   security_invoker is in the WITH list and set again with alter view, because a create or replace without the list
--   clears the option (058 learned that). The grant is production's: service_role has every privilege, anon and
--   authenticated none (117); create or replace keeps the ACL, so re-issuing it is a no-op.
--
-- STEP 0 (read-only, production, 2026-11-08): what 174 replaces and keeps
--   md5(pg_get_viewdef('public.bist_quote_stats'::regclass, true)) = 8f5ecc5369051b3b9405e23a6376c68c, length 880 (051's
--   view, PostgreSQL 17.6); reloptions {security_invoker=on}; relacl {postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres};
--   role_table_grants: postgres (all, grantable) and service_role (DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE,
--   UPDATE); columns ticker text, last_day date, last_close numeric(14,4), prev_close numeric, last_volume bigint,
--   avg_volume_20 numeric, rvol numeric. The ledger holds 172 and 173 and no 174.
--
-- REPLAY (read-only on production, 2026-11-08, the view body below as a plain SELECT against 051's body):
--   ticker   avg_volume_20 before -> after     rvol before -> after
--   MERCN    5,117,509 -> null                  1.73 -> null
--   DUNYH    850,663 -> null                    7.51 -> null
--   SKBNK    53,785,851 -> null                 1.72 -> null   (until the 10-22 step leaves the window, about 11-20)
--   SASA     488,456,997 -> 610,571,246         3.44 -> 2.75
--   GARAN    23,743,773 -> 23,743,773           1.85 -> 1.85   (unchanged)
--   Over all 630 tickers (626 with a 2026-11-06 bar): 8 rvol values change. DUNYH, MERCN, SKBNK and TERA (last volume 0
--   on 11-05, was 0.00) go to null; SASA 3.44 -> 2.75, TRHOL 4.14 -> 3.72, RALYH 2.33 -> 2.21, ISBTR 2.75 -> 2.61 (their
--   zero-volume rows leave the average). avg_volume_20 changes for 10: those 8 plus ISATR and UMPAS (last volume 0, the
--   average was 0 and the rvol null before and after). last_day, last_close, prev_close and last_volume are identical
--   for all 630.
--
-- COST (EXPLAIN ANALYZE, timing off, read-only, production, the view body wrapped in a subselect with the filter the app
--   sends): 5 tickers 8.5 ms (3 runs: 8.57, 8.52, 8.82) against 6.2 ms for 051's body, plan Index Scan using
--   bist_bars_daily_pkey with Index Cond ticker = ANY (...), so the filter is pushed below both window stages; 40
--   tickers 59 to 63 ms against 39 ms; the unfiltered view (nothing reads it that way) 296 ms against 165 ms.
--
-- DRY RUN (local PG15, tests/migrations/sql/174-bist-quote-stats-unit-guard-dryrun.sql): builds 051's table and view as
--   production has them (with the production grants), reads MERCN-, DUNYH- and SASA-shaped fixtures before 174 (the bug),
--   applies 174 twice, checks the ACL, reloptions and column types did not move, and reads the fixtures again. It ends
--   with DRYRUN 174 OK. The live vitest block runs on the database it leaves behind (live-manifest.txt).
--
-- DEPLOY: APPLY 174 ONLY. The pages read the view by name: no Vercel deploy, no Edge Function deploy, no cron change.
--   The next render after the cache window (FEED_CACHE, minutes) shows the new values; nothing to restart.
--   Apply with the usual path (supabase db push, or post the SQL); the file is one transaction and safe to re-apply.
--
-- OUT OF SCOPE (a founder decision): the stored history is not repaired. A re-fetch of the old rows (quotes-ingest
--   daily mode with the full flag, dropping the flat zero-volume bars in supabase/functions/quotes-ingest/bars.ts) would
--   rewrite bist_bars_daily rows, so it waits for an OK. This migration only stops the page from computing a ratio over
--   a window it cannot trust; once the history is clean the guard stays harmless (a clean window is unchanged).
--
-- VERIFY (read-only, after applying):
--   select md5(pg_get_viewdef('public.bist_quote_stats'::regclass, true)) - differs from 8f5ecc53... (the body changed);
--   select reloptions from pg_class where oid = 'public.bist_quote_stats'::regclass   -> {security_invoker=on};
--   select ticker, avg_volume_20, rvol from public.bist_quote_stats where ticker in ('MERCN','DUNYH','GARAN')
--     -> MERCN and DUNYH null / null, GARAN 23743772.6 / 1.85 (as of the 2026-11-06 bar);
--   select version, name from supabase_migrations.schema_migrations where version = '174'   -> one row.
--   Then GET /ekonomi/MERCN and /ekonomi/DUNYH: the "hacim 20 günlük ortalamanın N katı" line is absent; GET
--   /ekonomi/GARAN still reads 1,8. The /ekonomi tape chips of a nulled ticker show no "hacim" span.
--
-- ROLLBACK (not expected to be needed): re-run only the create or replace view public.bist_quote_stats statement of
--   051_finance_bars_and_speed.sql (the one headed "Per ticker: latest daily bar, previous close, 20-day average
--   volume"), then
--     alter view public.bist_quote_stats set (security_invoker = on);
--   (a bare replace clears the option), then
--     delete from supabase_migrations.schema_migrations where version = '174';
--   md5(pg_get_viewdef(...)) is then 8f5ecc5369051b3b9405e23a6376c68c again. The ACL does not change in either direction.

begin;

set local lock_timeout = '5s';

create or replace view public.bist_quote_stats
with (security_invoker = on) as
with b as (
  -- Per ticker in day order: the previous close and whether this close is a unit break.
  select
    ticker, day, close, volume,
    lag(close) over w as prev_close,
    case
      when lag(close) over w > 0
        then (close / lag(close) over w < 0.75 or close / lag(close) over w > 1.35)
      else false
    end as unit_break
  from public.bist_bars_daily
  window w as (partition by ticker order by day)
),
ranked as (
  select
    ticker, day, close, volume, prev_close,
    -- a break among the last 20 steps: the 20 averaged rows and the current one
    bool_or(unit_break) over (w rows between 19 preceding and current row) as break_in_window,
    -- the 20 rows before the current one, real volumes only
    avg(volume) filter (where volume > 0) over (w rows between 20 preceding and 1 preceding) as avg_nz,
    count(*) filter (where volume > 0) over (w rows between 20 preceding and 1 preceding) as n_nz,
    row_number() over (partition by ticker order by day desc) as rn
  from b
  window w as (partition by ticker order by day)
),
last_row as (
  select
    ticker, day as last_day, close as last_close, prev_close, volume as last_volume,
    case
      when break_in_window or n_nz < 10 or volume is null or volume <= 0 then null
      else avg_nz
    end as avg_volume_20
  from ranked
  where rn = 1
)
select
  ticker, last_day, last_close, prev_close, last_volume, avg_volume_20,
  case when avg_volume_20 > 0 then round(last_volume::numeric / avg_volume_20, 2) end as rvol
from last_row;

-- A create or replace view without the WITH list clears reloptions: set it again (058's lesson).
alter view public.bist_quote_stats set (security_invoker = on);

-- Production's ACL (relacl {postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}); create or replace keeps it, so this
-- is a no-op. Nothing is granted to anon or authenticated (117).
grant all on public.bist_quote_stats to service_role;

insert into supabase_migrations.schema_migrations (version, name) values ('174', '174_bist_quote_stats_unit_guard') on conflict do nothing;

commit;
