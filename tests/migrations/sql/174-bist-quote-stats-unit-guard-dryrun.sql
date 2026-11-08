-- 174 bist_quote_stats_unit_guard (relative volume is hidden when its 20-session window crosses a unit break, holds fewer
-- than 10 real volumes, or ends on a zero volume): local PG15 dry-run.
-- Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55574 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55574 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/174-bist-quote-stats-unit-guard-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql PGHOST=/tmp PGPORT=55574 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/174-bist-quote-stats-unit-guard)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh
--
-- (\ir paths below are relative to this file.) Every check is a DO block that raises on mismatch, so a clean run ending
-- in "DRYRUN 174 OK" is the pass. Every scenario that writes sits inside begin ... rollback, so the database this leaves
-- behind holds no bar rows.
--
-- Order: public.bist_bars_daily (051's table, the one table the stub lacks), the view as production has it before 174
-- (051's text, security_invoker on, the production ACL: owner and service_role only, the stub's default privileges for
-- anon and authenticated revoked as 117 did), a baseline reading (the bug: MERCN across its split reads about 1.5, DUNYH
-- over its zero-volume placeholders reads 7.5, SASA's zero rows dilute the average), then 174 TWICE, the unchanged
-- ACL, options and columns, and the same fixtures again.
--
-- Production's md5(pg_get_viewdef('public.bist_quote_stats'::regclass, true)) was 8f5ecc5369051b3b9405e23a6376c68c, length 880
-- (PostgreSQL 17.6, read 2026-11-08). It is not compared here: pg_get_viewdef prints some expressions differently between
-- major versions, so the baseline below pins the columns, options and ACL, and reads the old behaviour instead.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Prelude: the state 174 sits on. ------------------------------------------------------------------------
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
alter table public.bist_bars_daily enable row level security;
drop policy if exists "public read bist_bars_daily" on public.bist_bars_daily;
create policy "public read bist_bars_daily" on public.bist_bars_daily for select using (true);

-- 051's view, as production has it before 174.
create or replace view public.bist_quote_stats as
with ranked as (
  select
    ticker, day, close, volume,
    lag(close) over w as prev_close,
    avg(volume) over (w rows between 20 preceding and 1 preceding) as avg_volume_20,
    row_number() over (partition by ticker order by day desc) as rn
  from public.bist_bars_daily
  window w as (partition by ticker order by day)
)
select ticker, day as last_day, close as last_close, prev_close, volume as last_volume, avg_volume_20,
       case when avg_volume_20 > 0 then round(volume / avg_volume_20, 2) end as rvol
from ranked
where rn = 1;
-- 058: security_invoker; 117: nothing for anon or authenticated (the stub's default privileges grant them).
alter view public.bist_quote_stats set (security_invoker = on);
revoke all on public.bist_quote_stats from public, anon, authenticated;
grant all on public.bist_quote_stats to service_role;

-- The three production shapes of 2026-11-06, as one session-local loader (21 rows each, consecutive days).
create function pg_temp.load_fixtures() returns void language sql as $$
  -- MERCN: 15 rows in pre-split units (8.44 .. 10.54, volume about 5M), then 2.81 .. 2.72 (volume 8M, last 8,841,503).
  insert into public.bist_bars_daily (ticker, day, close, volume)
  select 'MERCN', date '2026-01-01' + g,
         case when g < 15 then 8.44 + (g % 4) * 0.7 else (array[2.81, 2.75, 2.70, 2.78, 2.80, 2.72])[g - 14] end,
         case when g < 15 then 5000000 + 100000 * (g % 5) when g < 20 then 8000000 else 8841503 end
  from generate_series(0, 20) g;
  -- DUNYH: one real print, 19 flat zero-volume rows at 109.10, then 11.92 on 6,390,319.
  insert into public.bist_bars_daily (ticker, day, close, volume)
  select 'DUNYH', date '2026-01-01' + g,
         case when g < 20 then 109.10 else 11.92 end,
         case when g = 0 then 17013257 when g < 20 then 0 else 6390319 end
  from generate_series(0, 20) g;
  -- SASA: 20 prior rows with 4 zero-volume rows (rows 3, 7, 11, 15), no price step, then 2,500,000.
  insert into public.bist_bars_daily (ticker, day, close, volume)
  select 'SASA', date '2026-01-01' + g,
         3.40 + (g % 3) * 0.05,
         case when g = 20 then 2500000 when (g + 1) in (3, 7, 11, 15) then 0 else 1000000 + 10000 * (g + 1) end
  from generate_series(0, 20) g;
$$;

-- Baseline: production's view with its options and ACL, and the bug. ----------------------------------------
create temp table before_174 as
  select c.relacl::text as acl, c.reloptions::text as opts,
         (select string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' order by a.attnum)
            from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as cols,
         pg_get_userbyid(c.relowner) as owner
    from pg_class c where c.oid = 'public.bist_quote_stats'::regclass;

do $$
declare b record;
begin
  select * into b from before_174;
  if b.cols <> 'ticker:text,last_day:date,last_close:numeric(14,4),prev_close:numeric,last_volume:bigint,avg_volume_20:numeric,rvol:numeric' then
    raise exception 'baseline: unexpected columns %', b.cols;
  end if;
  if b.opts <> '{security_invoker=on}' then
    raise exception 'baseline: unexpected options %', b.opts;
  end if;
  if b.acl like '%anon=%' or b.acl like '%authenticated=%' or b.acl not like '%service_role=%' then
    raise exception 'baseline: unexpected ACL %', b.acl;
  end if;
end $$;

begin;
select pg_temp.load_fixtures();
do $$
declare m record; d record; s record;
begin
  select * into m from public.bist_quote_stats where ticker = 'MERCN';
  select * into d from public.bist_quote_stats where ticker = 'DUNYH';
  select * into s from public.bist_quote_stats where ticker = 'SASA';
  -- the bug: a ratio across the split (the true one is below 1), a ratio over the placeholders, a diluted average
  if m.rvol is null or m.rvol < 1.3 or m.rvol > 1.7 then
    raise exception 'baseline: MERCN-shaped rvol should be about 1.5 on the old view, got %', m.rvol;
  end if;
  if d.rvol is null or d.rvol < 7 then
    raise exception 'baseline: DUNYH-shaped rvol should be about 7.5 on the old view, got %', d.rvol;
  end if;
  if s.rvol is null or s.avg_volume_20 <> (select avg(volume) from public.bist_bars_daily where ticker = 'SASA' and day < date '2026-01-21') then
    raise exception 'baseline: SASA-shaped average should include the zero rows on the old view, got %', s.avg_volume_20;
  end if;
end $$;
rollback;

-- 174, twice (it is safe to re-apply). ---------------------------------------------------------------------
\ir ../../../supabase/migrations/174_bist_quote_stats_unit_guard.sql
\ir ../../../supabase/migrations/174_bist_quote_stats_unit_guard.sql

-- The ACL, the options and the columns did not move; the ledger row is there once. -----------------------------
do $$
declare b record; c record; n integer;
begin
  select * into b from before_174;
  select c2.relacl::text as acl, c2.reloptions::text as opts,
         (select string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' order by a.attnum)
            from pg_attribute a where a.attrelid = c2.oid and a.attnum > 0 and not a.attisdropped) as cols,
         pg_get_userbyid(c2.relowner) as owner
    into c from pg_class c2 where c2.oid = 'public.bist_quote_stats'::regclass;
  if c.acl is distinct from b.acl then raise exception 'after: ACL moved from % to %', b.acl, c.acl; end if;
  if c.opts is distinct from b.opts then raise exception 'after: options moved from % to %', b.opts, c.opts; end if;
  if c.cols is distinct from b.cols then raise exception 'after: columns moved from % to %', b.cols, c.cols; end if;
  if c.owner is distinct from b.owner then raise exception 'after: owner moved from % to %', b.owner, c.owner; end if;
  select count(*) into n from supabase_migrations.schema_migrations where version = '174' and name = '174_bist_quote_stats_unit_guard';
  if n <> 1 then raise exception 'after: expected one ledger row for 174, found %', n; end if;
  if has_table_privilege('anon', 'public.bist_quote_stats', 'select') or has_table_privilege('authenticated', 'public.bist_quote_stats', 'select') then
    raise exception 'after: anon or authenticated can read the view';
  end if;
  if not has_table_privilege('service_role', 'public.bist_quote_stats', 'select') then
    raise exception 'after: service_role cannot read the view';
  end if;
end $$;

-- The same fixtures on the new view. --------------------------------------------------------------------------
begin;
select pg_temp.load_fixtures();
do $$
declare m record; d record; s record; want numeric;
begin
  select * into m from public.bist_quote_stats where ticker = 'MERCN';
  select * into d from public.bist_quote_stats where ticker = 'DUNYH';
  select * into s from public.bist_quote_stats where ticker = 'SASA';
  if m.avg_volume_20 is not null or m.rvol is not null then
    raise exception 'after: MERCN-shaped should be null / null, got % / %', m.avg_volume_20, m.rvol;
  end if;
  if m.last_volume <> 8841503 or m.prev_close <> 2.80 or m.last_close <> 2.72 then
    raise exception 'after: MERCN-shaped other columns moved: % % %', m.last_volume, m.prev_close, m.last_close;
  end if;
  if d.avg_volume_20 is not null or d.rvol is not null then
    raise exception 'after: DUNYH-shaped should be null / null, got % / %', d.avg_volume_20, d.rvol;
  end if;
  select round(2500000 / avg(volume), 2) into want
    from public.bist_bars_daily where ticker = 'SASA' and volume > 0 and day < date '2026-01-21';
  if s.rvol is distinct from want or s.avg_volume_20 is distinct from (select avg(volume) from public.bist_bars_daily where ticker = 'SASA' and volume > 0 and day < date '2026-01-21') then
    raise exception 'after: SASA-shaped should be the 16-row average (rvol %), got % / %', want, s.avg_volume_20, s.rvol;
  end if;
end $$;
rollback;

-- The dry run leaves no bar rows behind. ----------------------------------------------------------------------
do $$
begin
  if (select count(*) from public.bist_bars_daily) <> 0 then
    raise exception 'the dry run left bar rows behind';
  end if;
end $$;

select 'DRYRUN 174 OK';
