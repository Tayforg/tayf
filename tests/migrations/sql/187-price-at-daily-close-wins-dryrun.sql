-- 187 price_at_daily_close_wins (price_at returns the settled daily close of a completed session instead of that session's
-- 18:00 stub bar; a bar of a later session than the newest daily row still wins): local PG15 dry-run.
-- Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55587 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55587 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/187-price-at-daily-close-wins-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql PGHOST=/tmp PGPORT=55587 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/187-price-at-daily-close-wins)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh    (TAYF_LIVE_ONLY=187 runs just this one)
--
-- (\ir paths below are relative to this file.) Every check is a DO block that raises on mismatch, so a clean
-- run ending in "DRYRUN 187 OK" is the pass. Every scenario that writes sits inside begin ... rollback, so the
-- database this leaves behind holds no fixture rows.
--
-- Order: the state 187 sits on is exactly 164's dry-run (bist_bars_5m and bist_bars_daily, 062's function as
-- production had it, then 164 twice, with every 164 scenario checked); this file runs it, keeps a session-local
-- copy of 164's body (pg_temp.price_at_164) for the old-versus-new comparison, shows the bug on 164's body (a
-- volume-0 18:00 stub beating the settled close), applies 187 TWICE, checks the new fingerprint and attributes,
-- then a grid of 5-minute and daily bar patterns on which 164 and 187 must differ exactly where the newest bar
-- falls between 18:00 and midnight Istanbul of the daily row's own day, and 187 must equal an independent
-- formulation of the rule everywhere.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Prelude: 164 as production has it (164's own dry-run, which ends clean). -----------------------------------
\ir 164-price-at-session-aware-dryrun.sql

-- 164's body under a session-local name, for the comparison grid below.
create or replace function pg_temp.price_at_164(p_ticker text, p_ts timestamptz)
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

-- Baseline: this is production's function (md5(prosrc) read on production on 2026-11-09) with its ACL
-- (owner + service_role, nobody else). -----------------------------------------------------------------------
create temp table before_187 as
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
  select * into b from before_187;
  if b.m <> '062c2405345dd5e61a3bdb11f6474eb5' or b.len <> 827 then
    raise exception 'baseline: the prelude function is not production''s (md5 %, length %)', b.m, b.len;
  end if;
  if b.grants not like '%service_role:EXECUTE%' or b.grants like '%anon%' or b.grants like '%authenticated%' or b.grants like '%public%' then
    raise exception 'baseline: unexpected grants %', b.grants;
  end if;
  if b.prosecdef or b.provolatile <> 's' or b.cfg is not null or b.proretset then
    raise exception 'baseline: unexpected attributes';
  end if;
  if (select md5(prosrc) from pg_proc where oid = 'pg_temp.price_at_164(text, timestamptz)'::regprocedure) <> b.m then
    raise exception 'baseline: the session-local copy differs from the prelude function';
  end if;
end $$;

-- The bug, on the old function. VAKBN, 2026-11-06 (h99-financenumbers-3): the 18:00 Istanbul 5-minute bar is a
-- volume-0 stub (open = high = low = close = 33.04) while the settled daily close is 33.06. 164 returns the stub.
begin;
insert into public.bist_bars_daily (ticker, day, close) values
  ('VAKBN', date '2026-11-05', 31.80), ('VAKBN', date '2026-11-06', 33.06);
insert into public.bist_bars_5m (ticker, ts, open, high, low, close, volume) values
  ('VAKBN', timestamptz '2026-11-06 14:55:00+00', 32.94, 33.04, 32.86, 33.02, 1253762),
  ('VAKBN', timestamptz '2026-11-06 15:00:00+00', 33.04, 33.04, 33.04, 33.04, 0);
do $$
declare d_vakbn numeric;
begin
  select close into d_vakbn from public.bist_bars_daily where ticker = 'VAKBN' and day = date '2026-11-06';
  if public.price_at('VAKBN', timestamptz '2026-11-08 12:32:00+03') is distinct from 33.04
     or public.price_at('VAKBN', timestamptz '2026-11-09 00:00:00+03') is distinct from 33.04 then
    raise exception 'baseline: the old function should return the stub (33.04), got % and %',
      public.price_at('VAKBN', timestamptz '2026-11-08 12:32:00+03'), public.price_at('VAKBN', timestamptz '2026-11-09 00:00:00+03');
  end if;
  if public.price_at('VAKBN', timestamptz '2026-11-08 12:32:00+03') is not distinct from d_vakbn then
    raise exception 'baseline: the fixture does not show the bug';
  end if;
end $$;
rollback;

-- 187, TWICE (safe to re-apply). ------------------------------------------------------------------------------
\ir ../../../supabase/migrations/187_price_at_daily_close_wins.sql
create temp table after_187_first as
  select md5(prosrc) as m, proacl::text as acl from pg_proc where oid = 'public.price_at(text, timestamptz)'::regprocedure;
\ir ../../../supabase/migrations/187_price_at_daily_close_wins.sql

-- 1. The function: new body, everything else as before. -----------------------------------------------------------
do $$
declare a record; b record; f record;
begin
  select * into b from before_187;
  select md5(prosrc) as m, length(prosrc) as len,
         (select string_agg(case when x.grantee = 0 then 'public' else x.grantee::regrole::text end || ':' || x.privilege_type,
                            ',' order by case when x.grantee = 0 then 'public' else x.grantee::regrole::text end)
            from aclexplode(p.proacl) x) as grants,
         proconfig::text as cfg, provolatile, prosecdef, proretset, proowner::regrole::text as owner,
         pg_get_function_result(oid) as res, pg_get_function_arguments(oid) as args, prolang
    into a from pg_proc p where oid = 'public.price_at(text, timestamptz)'::regprocedure;

  if a.m <> 'e473799ca41463d0b022e7f42c4e0fce' or a.len <> 817 then
    raise exception '187: unexpected body (md5 %, length %)', a.m, a.len;
  end if;
  if a.m = b.m then raise exception '187: the body did not change'; end if;
  if a.grants is distinct from b.grants then raise exception '187: grants changed: % -> %', b.grants, a.grants; end if;
  if a.cfg is distinct from b.cfg or a.provolatile <> b.provolatile or a.prosecdef <> b.prosecdef or a.proretset <> b.proretset
     or a.owner <> b.owner or a.res <> b.res or a.args <> b.args or a.prolang <> b.prolang then
    raise exception '187: an attribute other than the body changed';
  end if;
  if a.res <> 'numeric' or a.args <> 'p_ticker text, p_ts timestamp with time zone' then
    raise exception '187: signature or result drifted: % / %', a.args, a.res;
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'price_at') <> 1 then
    raise exception '187: more than one price_at overload';
  end if;
  -- the second apply left the first apply's result
  select * into f from after_187_first;
  if f.m <> a.m then raise exception '187: the second apply changed the body'; end if;
  if has_function_privilege('anon', 'public.price_at(text, timestamptz)', 'execute')
     or has_function_privilege('authenticated', 'public.price_at(text, timestamptz)', 'execute')
     or not has_function_privilege('service_role', 'public.price_at(text, timestamptz)', 'execute') then
    raise exception '187: execute privileges are not service_role only';
  end if;
  -- 187 records its own ledger row, once even though it was applied twice
  if (select count(*) from supabase_migrations.schema_migrations where version = '187') <> 1
     or (select name from supabase_migrations.schema_migrations where version = '187') <> '187_price_at_daily_close_wins' then
    raise exception '187: the ledger row is not exactly one row named 187_price_at_daily_close_wins';
  end if;
end $$;

-- 2. The fix on the production case: VAKBN reads the bist_bars_daily close of 6 Nov (read from the daily row, never a
--    literal, because 5-minute bars get pruned in production); a bar of a later session still wins, and the 18:00
--    bar of today is used until the daily row lands. -----------------------------------------------------------------
begin;
insert into public.bist_bars_daily (ticker, day, close) values
  ('VAKBN', date '2026-11-05', 31.80), ('VAKBN', date '2026-11-06', 33.06);
insert into public.bist_bars_5m (ticker, ts, open, high, low, close, volume) values
  ('VAKBN', timestamptz '2026-11-06 14:55:00+00', 32.94, 33.04, 32.86, 33.02, 1253762),
  ('VAKBN', timestamptz '2026-11-06 15:00:00+00', 33.04, 33.04, 33.04, 33.04, 0),
  ('VAKBN', timestamptz '2026-11-09 10:05:00+03', 33.30, 33.30, 33.30, 33.30, 5000);
do $$
declare d_vakbn numeric;
begin
  select close into d_vakbn from public.bist_bars_daily where ticker = 'VAKBN' and day = date '2026-11-06';
  if public.price_at('VAKBN', timestamptz '2026-11-08 12:32:00+03') is distinct from d_vakbn
     or public.price_at('VAKBN', timestamptz '2026-11-09 00:00:00+03') is distinct from d_vakbn then
    raise exception '187: VAKBN on the weekend should read the 6 Nov daily close %, got % and %', d_vakbn,
      public.price_at('VAKBN', timestamptz '2026-11-08 12:32:00+03'), public.price_at('VAKBN', timestamptz '2026-11-09 00:00:00+03');
  end if;
  if public.price_at('VAKBN', timestamptz '2026-11-09 10:10:00+03') is distinct from 33.30 then
    raise exception '187: the Monday 10:05 bar (a later session than the Friday daily row) should win, got %',
      public.price_at('VAKBN', timestamptz '2026-11-09 10:10:00+03');
  end if;
  if public.price_at('VAKBN', timestamptz '2026-11-09 10:00:00+03') is distinct from d_vakbn then
    raise exception '187: before the Monday bar exists the Friday daily close should be returned, got %',
      public.price_at('VAKBN', timestamptz '2026-11-09 10:00:00+03');
  end if;
end $$;
rollback;

begin;
-- 6 Nov 19:00 Istanbul: the daily row of 6 Nov has not landed yet (about 19:33): the stub of today is the only price of today
insert into public.bist_bars_daily (ticker, day, close) values ('VAKBN', date '2026-11-05', 31.80);
insert into public.bist_bars_5m (ticker, ts, open, high, low, close, volume) values
  ('VAKBN', timestamptz '2026-11-06 15:00:00+00', 33.04, 33.04, 33.04, 33.04, 0);
do $$
begin
  if public.price_at('VAKBN', timestamptz '2026-11-06 19:00:00+03') is distinct from 33.04 then
    raise exception '187: before the daily row lands the 18:00 bar of today should be used, got %',
      public.price_at('VAKBN', timestamptz '2026-11-06 19:00:00+03');
  end if;
end $$;
insert into public.bist_bars_daily (ticker, day, close) values ('VAKBN', date '2026-11-06', 33.06);
do $$
begin
  if public.price_at('VAKBN', timestamptz '2026-11-06 19:00:00+03') is distinct from 33.06 then
    raise exception '187: once the daily row lands it should replace the stub, got %',
      public.price_at('VAKBN', timestamptz '2026-11-06 19:00:00+03');
  end if;
end $$;
rollback;

-- 3. The grid. Eight tickers with different bar patterns, a reading every 3 hours from 29 Oct to 8 Nov. Against 164 the
--    new function must differ exactly where the newest bar of the 4 days before the reading falls between 18:00 and
--    midnight Istanbul of the day of the newest daily row of the reference day (and its close is not the daily close),
--    and it must equal an independent formulation of the rule (string comparison of Istanbul dates) everywhere.
--    The grid has to contain such rows and unchanged rows, or it proves nothing.
begin;
-- T1: a daily row every weekday, 5-minute bars on 3 Nov only (stale bars, an older session than the daily row)
-- T2: a daily row and hourly bars on every weekday, the last at 15:00Z = 18:00 Istanbul (the stub): changes after the close
-- T3: bars only, no daily row;  T4: daily rows only, no bar
-- T5: a daily row until 2 Nov, bars on 3 and 4 Nov (bars of a later session than the last daily row)
-- T6: daily rows every weekday, one bar per day at 21:30Z, i.e. 00:30 of the NEXT Istanbul day
-- T8: like T2, but the 18:00 bar's close equals the daily close (a stub that agrees with the settle): no value changes
create temp table days as
  select date '2026-10-29' + g as d from generate_series(0, 8) g
   where extract(isodow from date '2026-10-29' + g) < 6;

insert into public.bist_bars_daily (ticker, day, close)
  select t, d, 100 + extract(day from d)::int
    from days, unnest(array['T1', 'T2', 'T4', 'T6', 'T8']) t
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
  select 'T6', (d + time '21:30') at time zone 'UTC', 600 + extract(day from d)::int from days
  union all
  select 'T8', ts, 300 + extract(hour from ts)::int
    from days, generate_series((d + time '07:00') at time zone 'UTC', (d + time '14:00') at time zone 'UTC', interval '1 hour') ts
  union all
  select 'T8', (d + time '15:00') at time zone 'UTC', 100 + extract(day from d)::int from days;

create temp table grid as
  select t as ticker, ts
    from unnest(array['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8']) t,
         generate_series(timestamptz '2026-10-29 00:00:00+00', timestamptz '2026-11-08 00:00:00+00', interval '3 hours') ts;

create temp table graded as
  select g.ticker, g.ts,
         pg_temp.price_at_164(g.ticker, g.ts) as old_price,
         public.price_at(g.ticker, g.ts) as new_price,
         -- the independent rule: reference day, newest daily row, newest bar, Istanbul dates compared as text
         (select max(x.day) from public.bist_bars_daily x
           where x.ticker = g.ticker
             and x.day <= (case when to_char(g.ts at time zone 'Europe/Istanbul', 'HH24MI') >= '1810'
                                then (g.ts at time zone 'Europe/Istanbul')::date
                                else (g.ts at time zone 'Europe/Istanbul')::date - 1 end)) as d_day,
         (select max(y.ts) from public.bist_bars_5m y
           where y.ticker = g.ticker and y.ts <= g.ts and y.ts >= g.ts - interval '4 days') as b_ts
    from grid g;

alter table graded add column b_close numeric, add column d_close numeric, add column rule_price numeric;
update graded g set
  b_close = (select y.close from public.bist_bars_5m y where y.ticker = g.ticker and y.ts = g.b_ts),
  d_close = (select x.close from public.bist_bars_daily x where x.ticker = g.ticker and x.day = g.d_day);
update graded set rule_price =
  case when b_ts is not null
            and (d_day is null or to_char(b_ts at time zone 'Europe/Istanbul', 'YYYYMMDD') > to_char(d_day, 'YYYYMMDD'))
       then b_close
       else d_close end;

do $$
declare n_all int; n_diff int; n_expected int; n_bad int; n_bad_diff int; n_same_with_bar int; n_later int;
begin
  select count(*) into n_all from graded;
  select count(*) into n_diff from graded where old_price is distinct from new_price;
  -- the new function equals the independent rule everywhere
  select count(*) into n_bad from graded where new_price is distinct from rule_price;
  -- a reading changes against 164 if and only if the newest bar is between 18:00 and midnight Istanbul of the daily
  -- row's own day and its close is not the daily close
  select count(*) into n_expected from graded
   where b_ts is not null and d_day is not null
     and b_ts >= (d_day + time '18:00') at time zone 'Europe/Istanbul'
     and b_ts <  (d_day + 1)::timestamp at time zone 'Europe/Istanbul'
     and b_close is distinct from d_close;
  select count(*) into n_bad_diff from graded
   where (old_price is distinct from new_price)
         is distinct from (b_ts is not null and d_day is not null
                           and b_ts >= (d_day + time '18:00') at time zone 'Europe/Istanbul'
                           and b_ts <  (d_day + 1)::timestamp at time zone 'Europe/Istanbul'
                           and b_close is distinct from d_close);
  select count(*) into n_same_with_bar from graded where b_ts is not null and old_price is not distinct from new_price;
  select count(*) into n_later from graded
   where b_ts is not null and d_day is not null
     and to_char(b_ts at time zone 'Europe/Istanbul', 'YYYYMMDD') > to_char(d_day, 'YYYYMMDD');
  if n_all <> 8 * 81 then raise exception '187 grid: expected % readings, got %', 8 * 81, n_all; end if;
  if n_bad <> 0 then raise exception '187 grid: % readings differ from the independent rule', n_bad; end if;
  if n_bad_diff <> 0 then raise exception '187 grid: % readings differ from 164 where the rule says they should not', n_bad_diff; end if;
  if n_diff <> n_expected or n_diff < 10 then raise exception '187 grid: % differing readings, % expected (at least 10 needed)', n_diff, n_expected; end if;
  if n_same_with_bar < 100 then raise exception '187 grid: only % unchanged readings with a bar', n_same_with_bar; end if;
  -- the live intraday readings (a bar of a later session than the daily row) exist and return the bar
  if n_later < 10 then raise exception '187 grid: only % readings with a bar of a later session', n_later; end if;
  if exists (select 1 from graded
              where b_ts is not null and d_day is not null
                and to_char(b_ts at time zone 'Europe/Istanbul', 'YYYYMMDD') > to_char(d_day, 'YYYYMMDD')
                and new_price is distinct from b_close) then
    raise exception '187 grid: a bar of a later session did not win';
  end if;
  -- T7 has no data at all: null before and after
  if exists (select 1 from graded where ticker = 'T7' and (old_price is not null or new_price is not null)) then
    raise exception '187 grid: T7 should be null';
  end if;
  -- the new function never returns a value the old function and the daily table could not both explain
  if exists (select 1 from graded
              where new_price is not null
                and new_price is distinct from old_price
                and new_price is distinct from d_close) then
    raise exception '187 grid: a changed reading is not the daily close';
  end if;
  -- T1 (stale bars), T3 (bars only), T4 (daily only), T5 (newer bars), T6 (00:30 bars) and T8 (a stub that equals the
  -- settle) never change against 164
  if exists (select 1 from graded where ticker in ('T1', 'T3', 'T4', 'T5', 'T6', 'T8') and old_price is distinct from new_price) then
    raise exception '187 grid: a stale-bar, bar-only, daily-only, newer-bar, 00:30-bar or agreeing-stub ticker changed';
  end if;
  -- T2 is the stub pattern: it must change somewhere (and, by the check above, only where the rule says)
  if not exists (select 1 from graded where ticker = 'T2' and old_price is distinct from new_price) then
    raise exception '187 grid: T2 (stub bars) did not change anywhere';
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

select 'DRYRUN 187 OK';
