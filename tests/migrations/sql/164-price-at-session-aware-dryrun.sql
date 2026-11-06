-- 164 price_at_session_aware (price_at ignores a 5-minute bar before the 18:00 Istanbul closing auction of the
-- newest daily close's day): local PG15 dry-run.
-- Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55564 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55564 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/164-price-at-session-aware-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql PGHOST=/tmp PGPORT=55564 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/164-price-at-session-aware)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh
--
-- (\ir paths below are relative to this file.) Every check is a DO block that raises on mismatch, so a clean
-- run ending in "DRYRUN 164 OK" is the pass. Every scenario that writes sits inside begin ... rollback, so the
-- database this leaves behind holds no fixture rows.
--
-- Order: public.bist_bars_5m and public.bist_bars_daily (051's tables, the two tables the stub lacks), the
-- function as production has it before 164 (062 section 2, byte for byte, with 058's revoke and grant) plus a
-- session-local copy of it (pg_temp.price_at_062) for the old-versus-new comparison, a baseline reading (the
-- bug: a stale 5-minute bar wins), then 164 TWICE and the same readings again, then a grid of 5-minute and
-- daily bar patterns on which the old and the new function must differ exactly where the bar is before 18:00
-- Istanbul time of the daily row's day.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Prelude: the state 164 sits on. ------------------------------------------------------------------------
create table if not exists public.bist_bars_daily (
  ticker text not null,
  day    date not null,
  open   numeric(14,4),
  high   numeric(14,4),
  low    numeric(14,4),
  close  numeric(14,4) not null,
  volume bigint,
  primary key (ticker, day)
);
create table if not exists public.bist_bars_5m (
  ticker text not null,
  ts     timestamptz not null,
  open   numeric(14,4),
  high   numeric(14,4),
  low    numeric(14,4),
  close  numeric(14,4) not null,
  volume bigint,
  primary key (ticker, ts)
);

-- 062 section 2, byte for byte: production's function.
create or replace function public.price_at(p_ticker text, p_ts timestamptz)
returns numeric
language sql
stable
as $$
  select coalesce(
    (select close from public.bist_bars_5m
      where ticker = p_ticker and ts <= p_ts
        and ts >= p_ts - interval '4 days'
      order by ts desc limit 1),
    (select close from public.bist_bars_daily
      where ticker = p_ticker
        and day <= case
          when (p_ts at time zone 'Europe/Istanbul')::time >= time '18:10'
            then (p_ts at time zone 'Europe/Istanbul')::date
          else (p_ts at time zone 'Europe/Istanbul')::date - 1
        end
      order by day desc limit 1)
  );
$$;

revoke execute on function public.price_at(text, timestamptz) from anon, authenticated, public;
grant execute on function public.price_at(text, timestamptz) to service_role;

-- The same body under a session-local name, for the comparison grid below.
create or replace function pg_temp.price_at_062(p_ticker text, p_ts timestamptz)
returns numeric
language sql
stable
as $$
  select coalesce(
    (select close from public.bist_bars_5m
      where ticker = p_ticker and ts <= p_ts
        and ts >= p_ts - interval '4 days'
      order by ts desc limit 1),
    (select close from public.bist_bars_daily
      where ticker = p_ticker
        and day <= case
          when (p_ts at time zone 'Europe/Istanbul')::time >= time '18:10'
            then (p_ts at time zone 'Europe/Istanbul')::date
          else (p_ts at time zone 'Europe/Istanbul')::date - 1
        end
      order by day desc limit 1)
  );
$$;

-- Baseline: this is production's function (md5(prosrc) read on production on 2026-11-06) with its ACL
-- (owner + service_role, nobody else). -----------------------------------------------------------------------
create temp table before_164 as
  select md5(prosrc) as m, length(prosrc) as len,
         (select string_agg(case when a.grantee = 0 then 'public' else a.grantee::regrole::text end || ':' || a.privilege_type,
                            ',' order by case when a.grantee = 0 then 'public' else a.grantee::regrole::text end)
            from aclexplode(p.proacl) a) as grants,
         proconfig::text as cfg, provolatile, prosecdef, proretset, proowner::regrole::text as owner,
         pg_get_function_result(oid) as res, pg_get_function_arguments(oid) as args, prolang
    from pg_proc p where oid = 'public.price_at(text, timestamptz)'::regprocedure;

do $$
declare b record;
begin
  select * into b from before_164;
  if b.m <> '57f79dbd2e2845d01d44bce6c67d4354' or b.len <> 533 then
    raise exception 'baseline: the prelude function is not production''s (md5 %, length %)', b.m, b.len;
  end if;
  if b.grants not like '%service_role:EXECUTE%' or b.grants like '%anon%' or b.grants like '%authenticated%' or b.grants like '%public%' then
    raise exception 'baseline: unexpected grants %', b.grants;
  end if;
  if b.prosecdef or b.provolatile <> 's' or b.cfg is not null or b.proretset then
    raise exception 'baseline: unexpected attributes';
  end if;
  if (select md5(prosrc) from pg_proc where oid = 'pg_temp.price_at_062(text, timestamptz)'::regprocedure) <> b.m then
    raise exception 'baseline: the session-local copy differs from the prelude function';
  end if;
end $$;

-- The bug, on the old function. The two production cases of 2026-11-06 (h48-ekonomi-1): DOHOL's last 5-minute
-- bar is from 3 Nov, its newest daily close is 5 Nov; SISE's last bar is from 2 Nov, its newest daily close 5 Nov.
-- The old function returns the stale bar's close.
begin;
insert into public.bist_bars_daily (ticker, day, close) values
  ('DOHOL', date '2026-11-03', 16.38), ('DOHOL', date '2026-11-04', 17.27), ('DOHOL', date '2026-11-05', 17.56),
  ('SISE',  date '2026-11-02', 33.42), ('SISE',  date '2026-11-03', 34.10), ('SISE',  date '2026-11-04', 35.00),
  ('SISE',  date '2026-11-05', 35.42);
insert into public.bist_bars_5m (ticker, ts, close) values
  ('DOHOL', timestamptz '2026-11-03 13:00:00+00', 16.33), ('DOHOL', timestamptz '2026-11-03 13:05:00+00', 16.41),
  ('SISE',  timestamptz '2026-11-02 13:40:00+00', 33.39), ('SISE',  timestamptz '2026-11-02 13:45:00+00', 33.40);
do $$
declare d_dohol numeric; d_sise numeric;
begin
  select close into d_dohol from public.bist_bars_daily where ticker = 'DOHOL' and day = date '2026-11-05';
  select close into d_sise  from public.bist_bars_daily where ticker = 'SISE'  and day = date '2026-11-05';
  if public.price_at('DOHOL', timestamptz '2026-11-05 22:08:00+00') is distinct from 16.41
     or public.price_at('SISE', timestamptz '2026-11-05 21:00:00+00') is distinct from 33.40 then
    raise exception 'baseline: the old function should return the stale bars (DOHOL 16.41, SISE 33.40), got % and %',
      public.price_at('DOHOL', timestamptz '2026-11-05 22:08:00+00'), public.price_at('SISE', timestamptz '2026-11-05 21:00:00+00');
  end if;
  if public.price_at('DOHOL', timestamptz '2026-11-05 22:08:00+00') is not distinct from d_dohol then
    raise exception 'baseline: the fixture does not show the bug';
  end if;
end $$;
rollback;

-- 164, TWICE (safe to re-apply). ------------------------------------------------------------------------------
\ir ../../../supabase/migrations/164_price_at_session_aware.sql
create temp table after_164_first as
  select md5(prosrc) as m, proacl::text as acl from pg_proc where oid = 'public.price_at(text, timestamptz)'::regprocedure;
\ir ../../../supabase/migrations/164_price_at_session_aware.sql

-- 1. The function: new body, everything else as before. -----------------------------------------------------------
do $$
declare a record; b record; f record;
begin
  select * into b from before_164;
  select md5(prosrc) as m, length(prosrc) as len,
         (select string_agg(case when x.grantee = 0 then 'public' else x.grantee::regrole::text end || ':' || x.privilege_type,
                            ',' order by case when x.grantee = 0 then 'public' else x.grantee::regrole::text end)
            from aclexplode(p.proacl) x) as grants,
         proconfig::text as cfg, provolatile, prosecdef, proretset, proowner::regrole::text as owner,
         pg_get_function_result(oid) as res, pg_get_function_arguments(oid) as args, prolang
    into a from pg_proc p where oid = 'public.price_at(text, timestamptz)'::regprocedure;

  if a.m <> '062c2405345dd5e61a3bdb11f6474eb5' or a.len <> 827 then
    raise exception '164: unexpected body (md5 %, length %)', a.m, a.len;
  end if;
  if a.m = b.m then raise exception '164: the body did not change'; end if;
  if a.grants is distinct from b.grants then raise exception '164: grants changed: % -> %', b.grants, a.grants; end if;
  if a.cfg is distinct from b.cfg or a.provolatile <> b.provolatile or a.prosecdef <> b.prosecdef or a.proretset <> b.proretset
     or a.owner <> b.owner or a.res <> b.res or a.args <> b.args or a.prolang <> b.prolang then
    raise exception '164: an attribute other than the body changed';
  end if;
  if a.res <> 'numeric' or a.args <> 'p_ticker text, p_ts timestamp with time zone' then
    raise exception '164: signature or result drifted: % / %', a.args, a.res;
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'price_at') <> 1 then
    raise exception '164: more than one price_at overload';
  end if;
  -- the second apply left the first apply's result
  select * into f from after_164_first;
  if f.m <> a.m then raise exception '164: the second apply changed the body'; end if;
  if has_function_privilege('anon', 'public.price_at(text, timestamptz)', 'execute')
     or has_function_privilege('authenticated', 'public.price_at(text, timestamptz)', 'execute')
     or not has_function_privilege('service_role', 'public.price_at(text, timestamptz)', 'execute') then
    raise exception '164: execute privileges are not service_role only';
  end if;
  -- 164 records its own ledger row, once even though it was applied twice
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '164') then
    raise exception '164: no ledger row for version 164';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '164') <> 1
     or (select name from supabase_migrations.schema_migrations where version = '164') <> '164_price_at_session_aware' then
    raise exception '164: the ledger row is not exactly one row named 164_price_at_session_aware';
  end if;
end $$;

-- 2. The fix on the two production cases: each equals the bist_bars_daily close of 5 Nov, read from the daily row
--    (never a literal, because 5-minute bars get pruned in production). -----------------------------------------
begin;
insert into public.bist_bars_daily (ticker, day, close) values
  ('DOHOL', date '2026-11-03', 16.38), ('DOHOL', date '2026-11-04', 17.27), ('DOHOL', date '2026-11-05', 17.56),
  ('SISE',  date '2026-11-02', 33.42), ('SISE',  date '2026-11-03', 34.10), ('SISE',  date '2026-11-04', 35.00),
  ('SISE',  date '2026-11-05', 35.42);
insert into public.bist_bars_5m (ticker, ts, close) values
  ('DOHOL', timestamptz '2026-11-03 13:00:00+00', 16.33), ('DOHOL', timestamptz '2026-11-03 13:05:00+00', 16.41),
  ('SISE',  timestamptz '2026-11-02 13:40:00+00', 33.39), ('SISE',  timestamptz '2026-11-02 13:45:00+00', 33.40);
do $$
declare d_dohol numeric; d_sise numeric;
begin
  select close into d_dohol from public.bist_bars_daily where ticker = 'DOHOL' and day = date '2026-11-05';
  select close into d_sise  from public.bist_bars_daily where ticker = 'SISE'  and day = date '2026-11-05';
  if public.price_at('DOHOL', timestamptz '2026-11-05 22:08:00+00') is distinct from d_dohol then
    raise exception '164: DOHOL should read the 5 Nov daily close %, got %', d_dohol, public.price_at('DOHOL', timestamptz '2026-11-05 22:08:00+00');
  end if;
  if public.price_at('SISE', timestamptz '2026-11-05 21:00:00+00') is distinct from d_sise then
    raise exception '164: SISE should read the 5 Nov daily close %, got %', d_sise, public.price_at('SISE', timestamptz '2026-11-05 21:00:00+00');
  end if;
  -- DOHOL on the morning of 4 Nov (reference day 3 Nov): the 3 Nov 13:05Z bar is 16:05 Istanbul, before the 18:00
  -- closing auction of the daily day, so it loses to the 3 Nov daily close as well (read from the daily row)
  select close into d_dohol from public.bist_bars_daily where ticker = 'DOHOL' and day = date '2026-11-03';
  if public.price_at('DOHOL', timestamptz '2026-11-04 08:00:00+00') is distinct from d_dohol then
    raise exception '164: DOHOL on the morning of 4 Nov should read the 3 Nov daily close %, got %', d_dohol,
      public.price_at('DOHOL', timestamptz '2026-11-04 08:00:00+00');
  end if;
end $$;
rollback;

-- 3. The grid. Six tickers with different bar patterns, a reading every 3 hours from 29 Oct to 8 Nov. The old and
--    the new function must differ exactly where the newest bar of the 4 days before the reading is before 18:00
--    Istanbul time of the day of the newest daily row of the reference day (an independent formulation of the
--    rule), and never otherwise. The grid has to contain such rows and unchanged rows, or it proves nothing.
begin;
-- T1: a daily row every weekday, 5-minute bars on 3 Nov only (the DOHOL pattern: stale bars)
-- T2: a daily row and hourly bars on every weekday, the last at 15:00Z = 18:00 Istanbul, the closing auction
--     (full coverage: the newest bar is never before the daily day's 18:00)
-- T3: bars only, no daily row;  T4: daily rows only, no bar
-- T5: a daily row until 2 Nov, bars on 3 and 4 Nov (bars newer than the last daily row)
-- T6: daily rows every weekday, one bar per day at 21:30Z, i.e. 00:30 of the NEXT Istanbul day: from 18:10 that
--     day on, the reference day is the bar's own day and the bar (00:30) is before its 18:00, so it changes
create temp table days as
  select date '2026-10-29' + g as d from generate_series(0, 8) g
   where extract(isodow from date '2026-10-29' + g) < 6;

insert into public.bist_bars_daily (ticker, day, close)
  select t, d, 100 + extract(day from d)::int
    from days, unnest(array['T1', 'T2', 'T4', 'T6']) t
  union all
  select 'T5', d, 100 + extract(day from d)::int from days where d <= date '2026-11-02';
insert into public.bist_bars_5m (ticker, ts, close)
  select 'T1', ts, 200 + extract(hour from ts)::int + extract(minute from ts)::int / 100.0
    from generate_series(timestamptz '2026-11-03 07:00:00+00', timestamptz '2026-11-03 13:05:00+00', interval '5 minutes') ts
  union all
  select 'T2', ts, 300 + extract(hour from ts)::int
    from days, generate_series((d + time '07:00') at time zone 'UTC', (d + time '15:00') at time zone 'UTC', interval '1 hour') ts
  union all
  select 'T3', ts, 400 + extract(hour from ts)::int
    from generate_series(timestamptz '2026-10-30 08:00:00+00', timestamptz '2026-11-04 14:00:00+00', interval '7 hours') ts
  union all
  select 'T5', ts, 500 + extract(hour from ts)::int
    from generate_series(timestamptz '2026-11-03 08:00:00+00', timestamptz '2026-11-04 14:00:00+00', interval '6 hours') ts
  union all
  select 'T6', (d + time '21:30') at time zone 'UTC', 600 + extract(day from d)::int from days;

create temp table grid as
  select t as ticker, ts
    from unnest(array['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']) t,
         generate_series(timestamptz '2026-10-29 00:00:00+00', timestamptz '2026-11-08 00:00:00+00', interval '3 hours') ts;

create temp table graded as
  select g.ticker, g.ts,
         pg_temp.price_at_062(g.ticker, g.ts) as old_price,
         public.price_at(g.ticker, g.ts) as new_price,
         -- the independent rule: reference day, newest daily row, newest bar, Istanbul dates
         (select max(x.day) from public.bist_bars_daily x
           where x.ticker = g.ticker
             and x.day <= (case when to_char(g.ts at time zone 'Europe/Istanbul', 'HH24MI') >= '1810'
                                then (g.ts at time zone 'Europe/Istanbul')::date
                                else (g.ts at time zone 'Europe/Istanbul')::date - 1 end)) as d_day,
         (select max(y.ts) from public.bist_bars_5m y
           where y.ticker = g.ticker and y.ts <= g.ts and y.ts >= g.ts - interval '4 days') as b_ts
    from grid g;

do $$
declare n_all int; n_diff int; n_expected int; n_bad int; n_same_with_bar int; n_null int;
begin
  select count(*) into n_all from graded;
  select count(*) into n_diff from graded where old_price is distinct from new_price;
  select count(*) into n_expected from graded
   where b_ts is not null and d_day is not null and b_ts < (d_day + time '18:00') at time zone 'Europe/Istanbul';
  -- a row differs if and only if the rule says the bar is from an older session than the daily row
  select count(*) into n_bad from graded
   where (old_price is distinct from new_price)
         is distinct from (b_ts is not null and d_day is not null and b_ts < (d_day + time '18:00') at time zone 'Europe/Istanbul');
  select count(*) into n_same_with_bar from graded
   where b_ts is not null and old_price is not distinct from new_price;
  select count(*) into n_null from graded where new_price is null;
  if n_all <> 7 * 81 then raise exception '164 grid: expected % readings, got %', 7 * 81, n_all; end if;
  if n_bad <> 0 then raise exception '164 grid: % readings differ from the rule', n_bad; end if;
  if n_diff <> n_expected or n_diff < 10 then raise exception '164 grid: % differing readings, % expected (at least 10 needed)', n_diff, n_expected; end if;
  if n_same_with_bar < 100 then raise exception '164 grid: only % unchanged readings with a bar', n_same_with_bar; end if;
  -- T7 has no bars at all: null before and after
  if exists (select 1 from graded where ticker = 'T7' and (old_price is not null or new_price is not null)) then
    raise exception '164 grid: T7 should be null';
  end if;
  -- the new function never returns a value the old function and the daily table could not both explain
  if exists (select 1 from graded g
              where new_price is not null
                and new_price is distinct from old_price
                and new_price is distinct from (select close from public.bist_bars_daily x where x.ticker = g.ticker and x.day = g.d_day)) then
    raise exception '164 grid: a changed reading is not the daily close';
  end if;
  -- T2 (full coverage), T3 (bars only), T4 (daily only) and T5 (bars newer than the last daily row) never change
  if exists (select 1 from graded where ticker in ('T2', 'T3', 'T4', 'T5') and old_price is distinct from new_price) then
    raise exception '164 grid: a fully covered, bar-only, daily-only or newer-bar ticker changed';
  end if;
  -- T1 is the stale-bar pattern and T6 the 00:30 Istanbul pattern: both must change somewhere
  if not exists (select 1 from graded where ticker = 'T1' and old_price is distinct from new_price) then
    raise exception '164 grid: T1 (stale bars) did not change anywhere';
  end if;
  if not exists (select 1 from graded where ticker = 'T6' and old_price is distinct from new_price) then
    raise exception '164 grid: T6 (00:30 Istanbul bars) did not change anywhere';
  end if;
end $$;
rollback;

-- 4. Nothing was left behind by the scenarios above. ----------------------------------------------------------------
do $$
begin
  if exists (select 1 from public.bist_bars_5m) or exists (select 1 from public.bist_bars_daily) then
    raise exception 'a rolled-back fixture survived';
  end if;
end $$;

select 'DRYRUN 164 OK';
