-- 134_bist_daily_settle.sql
--
-- h11-finance-2 (hunt 11, 2026-11-01): re-fetch every daily bar after the
-- closing auction has settled.
--
-- WHY. bist_daily_targets() (052:154) picks the 80 tickers the quotes-daily job
--   reads next with `order by b.last_day nulls first, t.ticker limit p_limit`.
--   quotes-daily runs '12-59/3 15-16 * * 1-5' UTC (058:586), i.e. every 3 minutes
--   from 18:12 to 19:57 Istanbul. The first ~8 runs give every ticker today's
--   bar. From then on every last_day ties, the tie breaks alphabetically, and the
--   SAME first 80 tickers are re-read for the rest of the window. The other ~545
--   keep the first, pre-auction Yahoo pass until the next session's first fetch
--   (Friday's wrong bars stay all weekend). Verified 2026-11-01 against Yahoo v8
--   chart (interval 1d) for 2026-10-30:
--     SUNTK  volume 2,974,650 in the database, 22,170,287 at Yahoo
--     AYGAZ  close 263.00 vs 269.00 (volume 457,074 vs 575,903)
--     ECOGR  close 19.04 vs 19.61
--     BIMAS  close 347.75 vs 347.50 (volume 15,083,230 vs 15,950,353)
--     AKBNK  close equal, volume 136,245,133 vs 136,755,133
--   Consumers of the stale bars: rvol ('hacim Nx', ticker-chip.tsx, rvolLabel in
--   src/lib/finance/session.ts) and chartBaseline.
--
-- WHAT.
--   1. bist_bars_daily.fetched_at timestamptz, nullable, no default, no backfill:
--      a metadata-only ALTER (no table rewrite). quotes-ingest stamps every daily
--      row it upserts with the start time of its run.
--   2. bist_daily_targets(int) is replaced in place (same signature, same return
--      type, same grants) with the tie-break `b.last_fetched nulls first`, where
--      last_fetched is the fetched_at of the ticker's newest bar. Tickers whose
--      newest bar is older come first (as before); among equals the least
--      recently fetched goes first; the ticker name only breaks exact ties. So
--      the picks rotate through all tickers instead of repeating the first 80.
--   3. The newest bar of each ticker is found with one lateral primary-key probe
--      (bist_bars_daily_pkey is (ticker, day)) instead of a group by over every
--      bar of every ticker, so the function reads ~631 index entries, not 174k
--      rows (see LOCAL PROOF).
--
-- STEP 0 (read-only, production, 2026-11-01; recorded here, nothing was written):
--   (a) select pg_get_functiondef('public.bist_daily_targets(int)'::regprocedure)
--       -> identical to 052:154-164: language sql, stable, no SET clause, body
--       `... left join (select ticker, max(day) as last_day from bist_bars_daily
--       group by 1) b using (ticker) ... order by b.last_day nulls first,
--       t.ticker limit p_limit`.
--   (b) select proacl, proconfig, prosecdef, provolatile from pg_proc
--        where proname = 'bist_daily_targets'
--       -> {postgres=X/postgres,service_role=X/postgres}, null, false (security
--       invoker), 's' (stable). So this migration sets no search_path and no
--       security definer; it keeps the 058 grants (service_role only).
--   (c) traded tickers of 4+ characters: select count(distinct t) from
--       bist_companies, unnest(tickers) t where shares_traded and length(t) >= 4
--       -> 631. Newest bar per ticker: 625 on 2026-10-30, 4 on 2026-10-28 (UMPAS,
--       TERA, ISATR, TRHOL), ISKUR on 2026-08-12, KTEST none. Those 6 sort first
--       every run and take 6 of the 80 slots; 74 remain for the rotation (the
--       simulation in tests/functions/quotes-ingest.test.ts covers this shape).
--   (d) select count(*) from bist_bars_daily -> 174,333 rows, 630 tickers, newest
--       day 2026-10-30. bist_bars_daily_pkey (ticker, day) is its only index.
--
-- COST. ALTER TABLE ... ADD COLUMN of a nullable column without a default does
--   not rewrite the table; it needs ACCESS EXCLUSIVE for a moment, bounded by the
--   5 s lock_timeout below (if a long reader holds the table, the migration fails
--   cleanly and the operator re-runs it). The column is NULL on every existing
--   row; nothing is backfilled. A NULL fetched_at sorts first among equal
--   last_day values, so on the first session after the migration the picks start
--   from the alphabet and are stamped as they go; one full rotation (8 runs, 24
--   minutes) later every ticker carries a stamp and the order is the stable
--   least-recently-fetched order. Write cost: fetched_at is 8 bytes on the rows
--   quotes-ingest already upserts (80 tickers x 1-2 bars per run); no new index.
--   Yahoo calls: unchanged (80 per run, 32 runs a session).
--
-- LOCAL PROOF (PostgreSQL 15, throwaway cluster; stub.sql, then the 051 table, the
--   052 function and the 058 grants; 625 traded tickers x 280 daily bars, ANALYZEd):
--   (a) Applied twice. Run 1: BEGIN, SET, ALTER TABLE, COMMENT, CREATE FUNCTION,
--   REVOKE, GRANT, NOTIFY, INSERT 0 1, COMMIT. Run 2: the same statements, the
--   notice 'column "fetched_at" of relation "bist_bars_daily" already exists,
--   skipping', and INSERT 0 0 (the ledger row is not duplicated).
--   (b) Before and after: proacl {postgres=X/postgres,service_role=X/postgres},
--   proconfig null, prosecdef f, provolatile s (identical to production, STEP 0
--   (b)); has_function_privilege execute: anon f, authenticated f, public f,
--   service_role t. fetched_at: timestamptz, nullable, no default; 175,000 existing
--   rows, 0 of them with a value (no backfill, no rewrite).
--   (c) Seed: 625 traded tickers T000..T624 (280 bars each, newest 2026-10-29), a
--   duplicate code, a 3-letter code and a non-traded code (all dropped by the
--   filters), and NOBR (traded, no bar: first pick). Both functions return the
--   same 626 tickers (EXCEPT both ways: 0 rows).
--   (d) Rotation replayed in SQL, 36 runs x 80 picks, 18:12..19:57 IST, every pick
--   upserted with last_day 2026-10-30 and fetched_at = the run time:
--       function                 tickers read  read at/after 18:40  stuck on the early pass
--       bist_daily_targets (052)           626                   80                      546
--       bist_daily_targets (134)           626                  626                        0
--   All 625 T-codes are re-read at/after 18:40 with 134 (79 with 052); the stalest
--   ticker was last read at 19:36 IST, exactly what the model in
--   tests/functions/quotes-ingest.test.ts predicts (the last 8 runs cover all).
--   (e) EXPLAIN (analyze, buffers) of the 134 body, p_limit 80, 626 tickers over
--   175k bars: Nested Loop Left Join -> Limit -> Index Scan Backward using
--   bist_bars_daily_pkey (loops=626), 2,511 buffers, 2.8 ms. The 052 body: Seq
--   Scan of all 175,626 bars + HashAggregate, 4,430 buffers, 13.4 ms.
--
-- APPLY ORDER. Either order is safe.
--   Migration first, then `supabase functions deploy quotes-ingest --no-verify-jwt`:
--     the pre-134 function ignores fetched_at, the new order falls back to the
--     052 behaviour (every fetched_at is NULL) until the deploy.
--   Function first: the daily upsert gets PGRST204 (column missing), logs one
--     warning per isolate and retries the batch without fetched_at, so the bars
--     keep landing; rotation starts once 134 is applied.
--   This migration needs no pg_cron change: quotes-daily keeps its schedule.
--
-- VERIFY (read-only unless noted):
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'bist_bars_daily'
--      and column_name = 'fetched_at';                  -- timestamptz | YES | null
--   select proacl, prosecdef, provolatile, proconfig from pg_proc
--    where proname = 'bist_daily_targets';              -- unchanged from STEP 0 (b)
--   select * from public.bist_daily_targets(80);        -- 80 rows, stalest first
--   -- during the next 18:12-19:57 window, after a few runs:
--   select count(*) filter (where fetched_at >= (current_date + time '18:40') at time zone 'Europe/Istanbul') as settled,
--          count(*) as tickers
--     from public.bist_bars_daily where day = current_date;   -- settled -> tickers
--   -- spot check against Yahoo (SUNTK, AYGAZ): volume and close match the settled bar.
--
-- ROLLBACK. Nothing else reads fetched_at, so dropping the column is safe:
--   -- recreate the 052 function first (it does not reference the column)
--   create or replace function public.bist_daily_targets(p_limit int default 80)
--   returns table (ticker text, last_day date) language sql stable as $fn$
--     select t.ticker, b.last_day
--     from (select distinct unnest(tickers) as ticker from public.bist_companies where shares_traded) t
--     left join (select ticker, max(day) as last_day from public.bist_bars_daily group by 1) b using (ticker)
--     where length(t.ticker) >= 4
--     order by b.last_day nulls first, t.ticker
--     limit p_limit;
--   $fn$;
--   alter table public.bist_bars_daily drop column if exists fetched_at;
--   delete from supabase_migrations.schema_migrations where version = '134';
--   (The deployed quotes-ingest tolerates the missing column: PGRST204 fallback.)
--
-- IDEMPOTENT: add-column-if-not-exists, create-or-replace, re-issued grants and an
--   on-conflict-do-nothing ledger insert: a second run changes nothing.

begin;

set local lock_timeout = '5s';

-- 1. The stamp ---------------------------------------------------------------------

alter table public.bist_bars_daily add column if not exists fetched_at timestamptz;

comment on column public.bist_bars_daily.fetched_at is
  'When quotes-ingest last read this bar from Yahoo (start of that run). NULL for '
  'bars written before migration 134. bist_daily_targets() rotates on it so every '
  'ticker is re-read after the closing auction has settled.';

-- 2. The rotation ------------------------------------------------------------------
-- Same signature, return type and attributes as 052:154 (language sql, stable,
-- security invoker, no search_path: production, STEP 0 (b)).

create or replace function public.bist_daily_targets(p_limit int default 80)
returns table (ticker text, last_day date)
language sql
stable
as $$
  select t.ticker, b.last_day
  from (select distinct unnest(c.tickers) as ticker from public.bist_companies c where c.shares_traded) t
  left join lateral (
    select d.day as last_day, d.fetched_at as last_fetched
    from public.bist_bars_daily d
    where d.ticker = t.ticker
    order by d.day desc
    limit 1
  ) b on true
  where length(t.ticker) >= 4
  order by b.last_day nulls first, b.last_fetched nulls first, t.ticker
  limit p_limit;
$$;

-- Re-issued exactly as 058 left them: service_role only.
revoke execute on function public.bist_daily_targets(int) from anon, authenticated, public;
grant execute on function public.bist_daily_targets(int) to service_role;

-- 3. Schema cache and ledger ----------------------------------------------------------

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('134', '134_bist_daily_settle')
  on conflict do nothing;

commit;
