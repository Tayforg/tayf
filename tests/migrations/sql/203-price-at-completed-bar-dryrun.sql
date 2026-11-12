-- 203 price_at_completed_bar (price_at returns the close of the last COMPLETED 5-minute bar, ts + 5 min <= p_ts, not the
-- close of the bar that contains p_ts, which bist_bars_5m stamps with its START): local PG15 dry-run.
-- Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55603 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55603 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/203-price-at-completed-bar-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql PGHOST=/tmp PGPORT=55603 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/203-price-at-completed-bar)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh    (TAYF_LIVE_ONLY=203 runs just this one)
--
-- (\ir paths below are relative to this file.) Every check is a DO block that raises on mismatch, so a clean
-- run ending in "DRYRUN 203 OK" is the pass. Every scenario that writes sits inside begin ... rollback, so the
-- database this leaves behind holds no fixture rows.
--
-- Order: the state 203 sits on is exactly 187's dry-run (bist_bars_5m and bist_bars_daily, 062's function as
-- production had it, then 164 and 187 twice, every earlier scenario checked); this file runs it, keeps a
-- session-local copy of 187's body (pg_temp.price_at_187) for the old-versus-new comparison, shows the bug on
-- 187's body (the close of the containing bar, up to five minutes after p_ts), applies 203 TWICE, checks the
-- new fingerprint and attributes, then the five edge cases of the header (10:02, 09:58, 18:03, 18:12, 12:00:00)
-- and the production readings (GLRMK, ASELS, THYAO, TURSG), then a grid of 5-minute and daily bar patterns on
-- which 187 and 203 must differ only where a bar started inside the five minutes before p_ts, and 203 must equal
-- an independent formulation of the rule everywhere.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Prelude: 187 as production has it (187's own dry-run, which ends clean). -----------------------------------
\ir 187-price-at-daily-close-wins-dryrun.sql

-- 187's body under a session-local name, for the comparison grid below.
create or replace function pg_temp.price_at_187(p_ticker text, p_ts timestamptz)
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

-- Baseline: this is production's function (md5(prosrc) read on production on 2026-11-12) with its ACL
-- (owner + service_role, nobody else). -----------------------------------------------------------------------
create temp table before_203 as
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
  select * into b from before_203;
  if b.m <> 'e473799ca41463d0b022e7f42c4e0fce' or b.len <> 817 then
    raise exception 'baseline: the prelude function is not production''s (md5 %, length %)', b.m, b.len;
  end if;
  if b.grants not like '%service_role:EXECUTE%' or b.grants like '%anon%' or b.grants like '%authenticated%' or b.grants like '%public%' then
    raise exception 'baseline: unexpected grants %', b.grants;
  end if;
  if b.prosecdef or b.provolatile <> 's' or b.cfg is not null or b.proretset then
    raise exception 'baseline: unexpected attributes';
  end if;
  if (select md5(prosrc) from pg_proc where oid = 'pg_temp.price_at_187(text, timestamptz)'::regprocedure) <> b.m then
    raise exception 'baseline: the session-local copy differs from the prelude function';
  end if;
end $$;

-- The bug, on the old function. GLRMK, 2026-11-11 (h144-ekonomi-1): a BirGun headline at 12:00:00 Istanbul (09:00:00Z).
-- The bar stamped 11:55 Istanbul (08:55Z) closed at 108.60, the bar stamped 12:00 (09:00Z) closed at 106.80: the price
-- fell inside the bar that contains the headline. 187 returns 106.80, the price at 12:05.
begin;
insert into public.bist_bars_daily (ticker, day, close) values ('GLRMK', date '2026-11-10', 110.20);
insert into public.bist_bars_5m (ticker, ts, open, high, low, close, volume) values
  ('GLRMK', timestamptz '2026-11-11 08:50:00+00', 108.30, 108.40, 107.90, 108.00, 135936),
  ('GLRMK', timestamptz '2026-11-11 08:55:00+00', 108.00, 108.70, 108.00, 108.60, 80949),
  ('GLRMK', timestamptz '2026-11-11 09:00:00+00', 108.60, 108.70, 106.50, 106.80, 314706),
  ('GLRMK', timestamptz '2026-11-11 09:05:00+00', 106.80, 106.80, 106.40, 106.40, 34560);
do $$
begin
  if public.price_at('GLRMK', timestamptz '2026-11-11 09:00:00+00') is distinct from 106.80 then
    raise exception 'baseline: the old function should return the containing bar close (106.80), got %',
      public.price_at('GLRMK', timestamptz '2026-11-11 09:00:00+00');
  end if;
end $$;
rollback;

-- 203, TWICE (safe to re-apply). ------------------------------------------------------------------------------
\ir ../../../supabase/migrations/203_price_at_completed_bar.sql
create temp table after_203_first as
  select md5(prosrc) as m, proacl::text as acl from pg_proc where oid = 'public.price_at(text, timestamptz)'::regprocedure;
\ir ../../../supabase/migrations/203_price_at_completed_bar.sql

-- 1. The function: new body, everything else as before. -----------------------------------------------------------
do $$
declare a record; b record; f record;
begin
  select * into b from before_203;
  select md5(prosrc) as m, length(prosrc) as len,
         (select string_agg(case when x.grantee = 0 then 'public' else x.grantee::regrole::text end || ':' || x.privilege_type,
                            ',' order by case when x.grantee = 0 then 'public' else x.grantee::regrole::text end)
            from aclexplode(p.proacl) x) as grants,
         proconfig::text as cfg, provolatile, prosecdef, proretset, proowner::regrole::text as owner,
         pg_get_function_result(oid) as res, pg_get_function_arguments(oid) as args, prolang
    into a from pg_proc p where oid = 'public.price_at(text, timestamptz)'::regprocedure;

  if a.m <> '09131d0083e06558dcd79bcd80b09c43' or a.len <> 840 then
    raise exception '203: unexpected body (md5 %, length %)', a.m, a.len;
  end if;
  if a.m = b.m then raise exception '203: the body did not change'; end if;
  if a.grants is distinct from b.grants then raise exception '203: grants changed: % -> %', b.grants, a.grants; end if;
  if a.cfg is distinct from b.cfg or a.provolatile <> b.provolatile or a.prosecdef <> b.prosecdef or a.proretset <> b.proretset
     or a.owner <> b.owner or a.res <> b.res or a.args <> b.args or a.prolang <> b.prolang then
    raise exception '203: an attribute other than the body changed';
  end if;
  if a.res <> 'numeric' or a.args <> 'p_ticker text, p_ts timestamp with time zone' then
    raise exception '203: signature or result drifted: % / %', a.args, a.res;
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'price_at') <> 1 then
    raise exception '203: more than one price_at overload';
  end if;
  -- the second apply left the first apply's result
  select * into f from after_203_first;
  if f.m <> a.m then raise exception '203: the second apply changed the body'; end if;
  if has_function_privilege('anon', 'public.price_at(text, timestamptz)', 'execute')
     or has_function_privilege('authenticated', 'public.price_at(text, timestamptz)', 'execute')
     or not has_function_privilege('service_role', 'public.price_at(text, timestamptz)', 'execute') then
    raise exception '203: execute privileges are not service_role only';
  end if;
  -- 203 records its own ledger row, once even though it was applied twice
  if (select count(*) from supabase_migrations.schema_migrations where version = '203') <> 1
     or (select name from supabase_migrations.schema_migrations where version = '203') <> '203_price_at_completed_bar' then
    raise exception '203: the ledger row is not exactly one row named 203_price_at_completed_bar';
  end if;
  -- the new body is 187's with exactly the bar predicate replaced (plain text replacement, byte for byte)
  if replace((select prosrc from pg_proc where oid = 'pg_temp.price_at_187(text, timestamptz)'::regprocedure),
             'ts <= p_ts' || E'\n', 'ts <= p_ts - interval ''5 minutes''' || E'\n')
     <> (select prosrc from pg_proc where oid = 'public.price_at(text, timestamptz)'::regprocedure) then
    raise exception '203: the body is not 187''s with only the bar predicate replaced';
  end if;
end $$;

-- 2. The five edge cases of the header. THYAO on 11 Nov 2026 (a Wednesday): a volume-0 stub at 09:55, the first trades at
--    10:00 (volume 1,582,333), a volume-0 18:00 auction stub, daily rows for 10 and 11 Nov (the latter has landed). -----
begin;
insert into public.bist_bars_daily (ticker, day, close) values ('THYAO', date '2026-11-10', 100), ('THYAO', date '2026-11-11', 105);
insert into public.bist_bars_5m (ticker, ts, open, high, low, close, volume) values
  ('THYAO', timestamptz '2026-11-10 17:55:00+03',  99.5,  99.9,  99.4,  99.5, 900000),
  ('THYAO', timestamptz '2026-11-10 18:00:00+03',  99.9,  99.9,  99.9,  99.9, 0),
  ('THYAO', timestamptz '2026-11-11 09:55:00+03', 100.2, 100.2, 100.2, 100.2, 0),
  ('THYAO', timestamptz '2026-11-11 10:00:00+03', 100.2, 100.6, 100.1, 100.4, 1582333),
  ('THYAO', timestamptz '2026-11-11 11:50:00+03', 102.9, 103.0, 102.4, 102.5, 200000),
  ('THYAO', timestamptz '2026-11-11 11:55:00+03', 102.5, 103.1, 102.5, 103.0, 210000),
  ('THYAO', timestamptz '2026-11-11 12:00:00+03', 103.0, 103.6, 102.8, 103.5, 220000),
  ('THYAO', timestamptz '2026-11-11 17:55:00+03', 104.6, 104.8, 104.5, 104.7, 300000),
  ('THYAO', timestamptz '2026-11-11 18:00:00+03', 104.9, 104.9, 104.9, 104.9, 0);
do $$
declare d_prev numeric; d_today numeric; r numeric;
begin
  -- read from the rows, never from a literal
  select close into d_prev  from public.bist_bars_daily where ticker = 'THYAO' and day = date '2026-11-10';
  select close into d_today from public.bist_bars_daily where ticker = 'THYAO' and day = date '2026-11-11';

  -- 10:02 takes the 09:55 opening-auction stub of today (the 10:00 bar is still running); 187 returned the 10:00 close
  r := public.price_at('THYAO', timestamptz '2026-11-11 10:02:00+03');
  if r is distinct from (select close from public.bist_bars_5m where ticker = 'THYAO' and ts = timestamptz '2026-11-11 09:55:00+03') then
    raise exception '203 edge 10:02: expected the 09:55 stub close 100.20, got %', r;
  end if;
  if pg_temp.price_at_187('THYAO', timestamptz '2026-11-11 10:02:00+03') is distinct from 100.40 then
    raise exception '203 edge 10:02: the old function should read the containing 10:00 bar (100.40)';
  end if;

  -- 09:58 takes the previous day's daily close: the newest completed bar is the 18:00 stub of 10 Nov, a bar of the
  -- daily row's own day; 187 returned the 09:55 stub of today
  r := public.price_at('THYAO', timestamptz '2026-11-11 09:58:00+03');
  if r is distinct from d_prev then raise exception '203 edge 09:58: expected the previous daily close %, got %', d_prev, r; end if;
  if pg_temp.price_at_187('THYAO', timestamptz '2026-11-11 09:58:00+03') is distinct from 100.20 then
    raise exception '203 edge 09:58: the old function should read the 09:55 stub (100.20)';
  end if;

  -- 18:03 takes the 17:55 bar close; 187 returned the 18:00 stub
  r := public.price_at('THYAO', timestamptz '2026-11-11 18:03:00+03');
  if r is distinct from (select close from public.bist_bars_5m where ticker = 'THYAO' and ts = timestamptz '2026-11-11 17:55:00+03') then
    raise exception '203 edge 18:03: expected the 17:55 close 104.70, got %', r;
  end if;
  if pg_temp.price_at_187('THYAO', timestamptz '2026-11-11 18:03:00+03') is distinct from 104.90 then
    raise exception '203 edge 18:03: the old function should read the 18:00 stub (104.90)';
  end if;

  -- 18:12 takes today's daily close (the daily row has landed: the settled close beats the stub), as 187 did
  r := public.price_at('THYAO', timestamptz '2026-11-11 18:12:00+03');
  if r is distinct from d_today then raise exception '203 edge 18:12: expected today''s daily close %, got %', d_today, r; end if;
  if pg_temp.price_at_187('THYAO', timestamptz '2026-11-11 18:12:00+03') is distinct from d_today then
    raise exception '203 edge 18:12: 187 should also return today''s daily close';
  end if;

  -- 12:00:00 takes the 11:55 bar close; 187 returned the 12:00 bar (the one that contains the headline)
  r := public.price_at('THYAO', timestamptz '2026-11-11 12:00:00+03');
  if r is distinct from (select close from public.bist_bars_5m where ticker = 'THYAO' and ts = timestamptz '2026-11-11 11:55:00+03') then
    raise exception '203 edge 12:00:00: expected the 11:55 close 103.00, got %', r;
  end if;
  if pg_temp.price_at_187('THYAO', timestamptz '2026-11-11 12:00:00+03') is distinct from 103.50 then
    raise exception '203 edge 12:00:00: the old function should read the 12:00 bar (103.50)';
  end if;

  -- the boundary is exact to the second: a bar is used from ts + 5 minutes, not one second before
  if public.price_at('THYAO', timestamptz '2026-11-11 11:59:59+03') is distinct from 102.50
     or public.price_at('THYAO', timestamptz '2026-11-11 12:04:59+03') is distinct from 103.00
     or public.price_at('THYAO', timestamptz '2026-11-11 12:05:00+03') is distinct from 103.50 then
    raise exception '203 boundary: 11:59:59 / 12:04:59 / 12:05:00 should read 102.50 / 103.00 / 103.50, got % / % / %',
      public.price_at('THYAO', timestamptz '2026-11-11 11:59:59+03'),
      public.price_at('THYAO', timestamptz '2026-11-11 12:04:59+03'),
      public.price_at('THYAO', timestamptz '2026-11-11 12:05:00+03');
  end if;
end $$;
rollback;

-- 3. The production readings of 11 Nov 2026 (read-only replay on production, 2026-11-12): GLRMK 108.60 (was 106.80),
--    ASELS 342.00 (was 343.50), THYAO 317.25 (was 317.00), TURSG 3.25 (was 3.26). -----------------------------------
begin;
insert into public.bist_bars_daily (ticker, day, close) values
  ('GLRMK', date '2026-11-10', 110.20), ('ASELS', date '2026-11-10', 340.00),
  ('THYAO', date '2026-11-10', 318.00), ('TURSG', date '2026-11-10', 3.30);
insert into public.bist_bars_5m (ticker, ts, open, high, low, close, volume) values
  ('GLRMK', timestamptz '2026-11-11 08:50:00+00', 108.30, 108.40, 107.90, 108.00, 135936),
  ('GLRMK', timestamptz '2026-11-11 08:55:00+00', 108.00, 108.70, 108.00, 108.60, 80949),
  ('GLRMK', timestamptz '2026-11-11 09:00:00+00', 108.60, 108.70, 106.50, 106.80, 314706),
  ('GLRMK', timestamptz '2026-11-11 09:05:00+00', 106.80, 106.80, 106.40, 106.40, 34560),
  ('ASELS', timestamptz '2026-11-11 08:05:00+00', 340.75, 342.50, 340.50, 342.00, 839083),
  ('ASELS', timestamptz '2026-11-11 08:10:00+00', 342.25, 343.75, 342.00, 343.50, 1196561),
  ('ASELS', timestamptz '2026-11-11 08:15:00+00', 343.75, 343.75, 342.75, 343.00, 630226),
  ('THYAO', timestamptz '2026-11-11 13:40:00+00', 317.00, 317.50, 316.75, 317.25, 410000),
  ('THYAO', timestamptz '2026-11-11 13:45:00+00', 317.25, 317.25, 316.75, 317.00, 380000),
  ('TURSG', timestamptz '2026-11-11 13:35:00+00', 3.26, 3.26, 3.25, 3.25, 80000),
  ('TURSG', timestamptz '2026-11-11 13:40:00+00', 3.25, 3.26, 3.25, 3.26, 90000);
do $$
begin
  if public.price_at('GLRMK', timestamptz '2026-11-11 09:00:00+00') is distinct from 108.60
     or pg_temp.price_at_187('GLRMK', timestamptz '2026-11-11 09:00:00+00') is distinct from 106.80 then
    raise exception '203 GLRMK: expected 108.60 (was 106.80), got % (was %)', public.price_at('GLRMK', timestamptz '2026-11-11 09:00:00+00'),
      pg_temp.price_at_187('GLRMK', timestamptz '2026-11-11 09:00:00+00');
  end if;
  if public.price_at('ASELS', timestamptz '2026-11-11 08:12:00+00') is distinct from 342.00
     or pg_temp.price_at_187('ASELS', timestamptz '2026-11-11 08:12:00+00') is distinct from 343.50 then
    raise exception '203 ASELS: expected 342.00 (was 343.50), got % (was %)', public.price_at('ASELS', timestamptz '2026-11-11 08:12:00+00'),
      pg_temp.price_at_187('ASELS', timestamptz '2026-11-11 08:12:00+00');
  end if;
  if public.price_at('THYAO', timestamptz '2026-11-11 13:46:00+00') is distinct from 317.25
     or pg_temp.price_at_187('THYAO', timestamptz '2026-11-11 13:46:00+00') is distinct from 317.00 then
    raise exception '203 THYAO: expected 317.25 (was 317.00), got % (was %)', public.price_at('THYAO', timestamptz '2026-11-11 13:46:00+00'),
      pg_temp.price_at_187('THYAO', timestamptz '2026-11-11 13:46:00+00');
  end if;
  if public.price_at('TURSG', timestamptz '2026-11-11 13:42:00+00') is distinct from 3.25
     or pg_temp.price_at_187('TURSG', timestamptz '2026-11-11 13:42:00+00') is distinct from 3.26 then
    raise exception '203 TURSG: expected 3.25 (was 3.26), got % (was %)', public.price_at('TURSG', timestamptz '2026-11-11 13:42:00+00'),
      pg_temp.price_at_187('TURSG', timestamptz '2026-11-11 13:42:00+00');
  end if;
end $$;
rollback;

-- 4. 187's own cases still hold: the settled close of a completed session beats its 18:00 stub (VAKBN), a bar of a later
--    session still wins once it is complete, and until the daily row lands the 18:00 bar of today is the price. ----------
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
    raise exception '203: VAKBN on the weekend should read the 6 Nov daily close %, got % and %', d_vakbn,
      public.price_at('VAKBN', timestamptz '2026-11-08 12:32:00+03'), public.price_at('VAKBN', timestamptz '2026-11-09 00:00:00+03');
  end if;
  if public.price_at('VAKBN', timestamptz '2026-11-09 10:10:00+03') is distinct from 33.30 then
    raise exception '203: the Monday 10:05 bar (complete at 10:10:00, a later session than the Friday daily row) should win, got %',
      public.price_at('VAKBN', timestamptz '2026-11-09 10:10:00+03');
  end if;
  if public.price_at('VAKBN', timestamptz '2026-11-09 10:09:59+03') is distinct from d_vakbn then
    raise exception '203: one second before the 10:05 bar completes the Friday daily close should be returned, got %',
      public.price_at('VAKBN', timestamptz '2026-11-09 10:09:59+03');
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
    raise exception '203: before the daily row lands the 18:00 bar of today should be used, got %',
      public.price_at('VAKBN', timestamptz '2026-11-06 19:00:00+03');
  end if;
end $$;
insert into public.bist_bars_daily (ticker, day, close) values ('VAKBN', date '2026-11-06', 33.06);
do $$
begin
  if public.price_at('VAKBN', timestamptz '2026-11-06 19:00:00+03') is distinct from 33.06 then
    raise exception '203: once the daily row lands it should replace the stub, got %',
      public.price_at('VAKBN', timestamptz '2026-11-06 19:00:00+03');
  end if;
end $$;
rollback;

-- A bar that is still running is not a price: with only that bar and no daily row the answer is null, and with a daily
-- row it is the daily close.
begin;
insert into public.bist_bars_5m (ticker, ts, close) values ('ONLY', timestamptz '2026-11-11 12:00:00+03', 50);
insert into public.bist_bars_daily (ticker, day, close) values ('WITHD', date '2026-11-10', 49);
insert into public.bist_bars_5m (ticker, ts, close) values ('WITHD', timestamptz '2026-11-11 12:00:00+03', 50);
do $$
begin
  if public.price_at('ONLY', timestamptz '2026-11-11 12:03:00+03') is not null then
    raise exception '203: a running bar alone should give null, got %', public.price_at('ONLY', timestamptz '2026-11-11 12:03:00+03');
  end if;
  if public.price_at('ONLY', timestamptz '2026-11-11 12:05:00+03') is distinct from 50 then
    raise exception '203: the bar completed at 12:05:00 should be the price, got %', public.price_at('ONLY', timestamptz '2026-11-11 12:05:00+03');
  end if;
  if public.price_at('WITHD', timestamptz '2026-11-11 12:03:00+03') is distinct from 49 then
    raise exception '203: a running bar should not beat the previous daily close, got %', public.price_at('WITHD', timestamptz '2026-11-11 12:03:00+03');
  end if;
end $$;
rollback;

-- 5. The grid. Six tickers with different bar patterns, a reading every 7 minutes from 9 Nov 06:00Z to 11 Nov 16:00Z
--    (the readings drift against the 5-minute stamps, so some fall inside a running bar and some do not). Against 187
--    the new function must differ only where a bar of the ticker started inside the five minutes before p_ts, and it
--    must equal an independent formulation of the rule (the newest bar with ts + 5 min <= p_ts, Istanbul dates
--    compared as text) everywhere. Every bar close is unique per ticker (its 5-minute slot number), so a returned price
--    identifies the bar it came from. The grid has to contain changed and unchanged readings, or it proves nothing.
begin;
-- G1: a daily row every weekday (also 11 Nov), a bar every 5 minutes 09:55-18:00 Istanbul on 9, 10 and 11 Nov
-- G2: like G1, but no daily row for 11 Nov (it has not landed): the live day
-- G3: hourly bars (on the hour) on the three days, daily rows for 9 and 10 Nov
-- G4: bars only, no daily row;  G5: daily rows only, no bar;  G6: nothing at all
create temp table days as
  select date '2026-11-09' + g as d from generate_series(0, 2) g;

insert into public.bist_bars_daily (ticker, day, close)
  select t, d, 1000 + extract(day from d)::int
    from days, unnest(array['G1', 'G3', 'G5']) t
   where t <> 'G3' or d < date '2026-11-11'
  union all
  select 'G2', d, 1000 + extract(day from d)::int from days where d < date '2026-11-11';

insert into public.bist_bars_5m (ticker, ts, close)
  select t, ts, (extract(epoch from ts) / 300 - 5900000)::numeric(14,4)
    from days, unnest(array['G1', 'G2']) t,
         generate_series((d + time '09:55') at time zone 'Europe/Istanbul', (d + time '18:00') at time zone 'Europe/Istanbul', interval '5 minutes') ts
  union all
  select 'G3', ts, (extract(epoch from ts) / 300 - 5900000)::numeric(14,4)
    from days, generate_series((d + time '10:00') at time zone 'Europe/Istanbul', (d + time '18:00') at time zone 'Europe/Istanbul', interval '1 hour') ts
  union all
  select 'G4', ts, (extract(epoch from ts) / 300 - 5900000)::numeric(14,4)
    from generate_series(timestamptz '2026-11-09 07:00:00+00', timestamptz '2026-11-11 14:00:00+00', interval '35 minutes') ts;

create temp table grid as
  select t as ticker, ts
    from unnest(array['G1', 'G2', 'G3', 'G4', 'G5', 'G6']) t,
         generate_series(timestamptz '2026-11-09 06:00:00+00', timestamptz '2026-11-11 16:00:00+00', interval '7 minutes') ts;

create temp table graded as
  select g.ticker, g.ts,
         pg_temp.price_at_187(g.ticker, g.ts) as old_price,
         public.price_at(g.ticker, g.ts) as new_price,
         -- the independent rule: reference day, newest daily row, newest completed bar, Istanbul dates compared as text
         (select max(x.day) from public.bist_bars_daily x
           where x.ticker = g.ticker
             and x.day <= (case when to_char(g.ts at time zone 'Europe/Istanbul', 'HH24MI') >= '1810'
                                then (g.ts at time zone 'Europe/Istanbul')::date
                                else (g.ts at time zone 'Europe/Istanbul')::date - 1 end)) as d_day,
         (select max(y.ts) from public.bist_bars_5m y
           where y.ticker = g.ticker and y.ts + interval '5 minutes' <= g.ts and y.ts >= g.ts - interval '4 days') as b_ts,
         -- 187's pick: the newest bar at or before p_ts, completed or not
         (select max(y.ts) from public.bist_bars_5m y
           where y.ticker = g.ticker and y.ts <= g.ts and y.ts >= g.ts - interval '4 days') as old_b_ts
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
declare n_all int; n_diff int; n_bad int; n_bad_diff int; n_same int; n_bar_win int; n_daily_win int;
begin
  select count(*) into n_all from graded;
  select count(*) into n_diff from graded where old_price is distinct from new_price;
  -- the new function equals the independent rule everywhere
  select count(*) into n_bad from graded where new_price is distinct from rule_price;
  -- a reading can differ from 187 only when 187's bar is a running one (it started inside the five minutes before p_ts);
  -- when 187's bar is complete the two pick the same bar and return the same price
  select count(*) into n_bad_diff from graded
   where old_price is distinct from new_price
     and (old_b_ts is null or old_b_ts + interval '5 minutes' <= ts);
  select count(*) into n_same from graded where old_b_ts is not null and old_price is not distinct from new_price;
  select count(*) into n_bar_win from graded where b_ts is not null and new_price is not distinct from b_close and new_price is distinct from d_close;
  select count(*) into n_daily_win from graded where d_day is not null and new_price is not distinct from d_close;
  -- 58 hours at 7-minute steps = 498 readings per ticker
  if n_all <> 6 * 498 then raise exception '203 grid: expected % readings, got %', 6 * 498, n_all; end if;
  if n_bad <> 0 then raise exception '203 grid: % readings differ from the independent rule', n_bad; end if;
  if n_bad_diff <> 0 then raise exception '203 grid: % readings differ from 187 although 187''s bar was complete', n_bad_diff; end if;
  if n_diff < 50 then raise exception '203 grid: only % readings differ from 187 (at least 50 needed)', n_diff; end if;
  if n_same < 500 then raise exception '203 grid: only % unchanged readings with a bar', n_same; end if;
  if n_bar_win < 100 or n_daily_win < 100 then
    raise exception '203 grid: too few bar-wins (%) or daily-wins (%) to prove the session rule', n_bar_win, n_daily_win;
  end if;
  -- the new function never returns the close of a bar that has not completed (closes are unique per ticker)
  if exists (select 1 from graded g
              where g.new_price is not null
                and exists (select 1 from public.bist_bars_5m y
                             where y.ticker = g.ticker and y.close = g.new_price and y.ts + interval '5 minutes' > g.ts)) then
    raise exception '203 grid: a returned price is the close of a bar that was still running';
  end if;
  -- G5 (daily only), G6 (nothing) never change against 187; G6 is null before and after
  if exists (select 1 from graded where ticker in ('G5', 'G6') and old_price is distinct from new_price) then
    raise exception '203 grid: a daily-only or empty ticker changed';
  end if;
  if exists (select 1 from graded where ticker = 'G6' and (old_price is not null or new_price is not null)) then
    raise exception '203 grid: G6 should be null';
  end if;
  -- G1 (dense bars) must change somewhere, so must G3 (hourly bars: only the readings inside the first five minutes of an hour)
  if not exists (select 1 from graded where ticker = 'G1' and old_price is distinct from new_price)
     or not exists (select 1 from graded where ticker = 'G3' and old_price is distinct from new_price) then
    raise exception '203 grid: G1 or G3 did not change anywhere';
  end if;
end $$;
rollback;

-- 6. Nothing was left behind by the scenarios above. ----------------------------------------------------------------
do $$
begin
  if exists (select 1 from public.bist_bars_5m) or exists (select 1 from public.bist_bars_daily) then
    raise exception 'a rolled-back fixture survived';
  end if;
end $$;

select 'DRYRUN 203 OK';
