-- 160 intraday_traded_targets (bist_intraday_targets keeps only traded shares): local PG15 dry-run.
-- Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55560 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55560 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/160-intraday-traded-targets-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql PGHOST=/tmp PGPORT=55560 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/160-intraday-traded-targets)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh
--
-- (\ir paths below are relative to this file.) Every check is a DO block that raises on mismatch, so a clean
-- run ending in "DRYRUN 160 OK" is the pass. Every scenario that writes sits inside begin ... rollback, so the
-- database this leaves behind holds no fixture rows.
--
-- Order: public.bist_bars_5m (051's table, the one table the stub lacks), the function as production has it
-- before 160 (058 section 7, byte for byte, with 058's revoke and grant), a baseline reading (the bug: a
-- non-traded code and a code with no company row come back), then 160 TWICE and the same readings again.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Prelude: the state 160 sits on. ------------------------------------------------------------------------
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

create or replace function public.bist_intraday_targets(p_limit int default 120)
returns table (ticker text, last_ts timestamptz)
language sql
stable
as $$
  select t.ticker, b.last_ts
  from (
    select distinct ticker from public.article_tickers
    where created_at >= now() - interval '7 days'
  ) t
  left join (select ticker, max(ts) as last_ts from public.bist_bars_5m group by 1) b
    using (ticker)
  order by b.last_ts nulls first, t.ticker
  limit p_limit;
$$;
revoke execute on function public.bist_intraday_targets(int) from anon, authenticated, public;
grant execute on function public.bist_intraday_targets(int) to service_role;

-- Baseline: this is production's function (md5(prosrc) read on production on 2026-11-05) with its ACL
-- (owner + service_role, nobody else). -----------------------------------------------------------------------
create temp table before_160 as
  select md5(prosrc) as m, length(prosrc) as len,
         (select string_agg(case when a.grantee = 0 then 'public' else a.grantee::regrole::text end || ':' || a.privilege_type,
                            ',' order by case when a.grantee = 0 then 'public' else a.grantee::regrole::text end)
            from aclexplode(p.proacl) a) as grants,
         proconfig::text as cfg, provolatile, prosecdef, proretset, proowner::regrole::text as owner,
         pg_get_function_result(oid) as res, pg_get_function_arguments(oid) as args, prolang
    from pg_proc p where oid = 'public.bist_intraday_targets(integer)'::regprocedure;

do $$
declare b record;
begin
  select * into b from before_160;
  if b.m <> 'ee892ad1547b7563bb43bb3ba4b17e52' or b.len <> 315 then
    raise exception 'baseline: the prelude function is not production''s (md5 %, length %)', b.m, b.len;
  end if;
  if b.grants not like '%service_role:EXECUTE%' or b.grants like '%anon%' or b.grants like '%authenticated%' or b.grants like '%public%' then
    raise exception 'baseline: unexpected grants %', b.grants;
  end if;
  if b.prosecdef or b.provolatile <> 's' or b.cfg is not null or not b.proretset then
    raise exception 'baseline: unexpected attributes';
  end if;
end $$;

-- The bug, on the old function: a non-traded company's code (FNCLL) and a code with no company row (ZZZZ)
-- are targets, and being bar-less they sort ahead of the traded THYAO. -----------------------------------------
begin;
insert into public.articles (id, title) values
  ('00000000-0000-4000-8000-000000001601', 'a1'), ('00000000-0000-4000-8000-000000001602', 'a2'),
  ('00000000-0000-4000-8000-000000001603', 'a3');
insert into public.bist_companies (tickers, title, shares_traded) values
  (array['THYAO'], 'Turk Hava Yollari', true), (array['FNCLL'], 'Finansal kiralama', false);
insert into public.article_tickers (article_id, ticker, matched_on) values
  ('00000000-0000-4000-8000-000000001601', 'FNCLL', 'alias:x'),
  ('00000000-0000-4000-8000-000000001602', 'THYAO', 'alias:y'),
  ('00000000-0000-4000-8000-000000001603', 'ZZZZ', 'alias:z');
insert into public.bist_bars_5m (ticker, ts, close) values ('THYAO', now(), 1);
do $$
declare r text;
begin
  select string_agg(ticker, ',' order by last_ts nulls first, ticker) into r from public.bist_intraday_targets(120);
  if r is distinct from 'FNCLL,ZZZZ,THYAO' then
    raise exception 'baseline: the old function should return FNCLL,ZZZZ,THYAO (bar-less codes first), got %', r;
  end if;
end $$;
rollback;

-- 160, TWICE (safe to re-apply). ------------------------------------------------------------------------------
\ir ../../../supabase/migrations/160_intraday_traded_targets.sql
create temp table after_160_first as
  select md5(prosrc) as m, proacl::text as acl from pg_proc where oid = 'public.bist_intraday_targets(integer)'::regprocedure;
\ir ../../../supabase/migrations/160_intraday_traded_targets.sql

-- 1. The function: new body, everything else as before. -----------------------------------------------------------
do $$
declare a record; b record; f record; owner_ok boolean;
begin
  select * into b from before_160;
  select md5(prosrc) as m, length(prosrc) as len,
         (select string_agg(case when x.grantee = 0 then 'public' else x.grantee::regrole::text end || ':' || x.privilege_type,
                            ',' order by case when x.grantee = 0 then 'public' else x.grantee::regrole::text end)
            from aclexplode(p.proacl) x) as grants,
         proconfig::text as cfg, provolatile, prosecdef, proretset, proowner::regrole::text as owner,
         pg_get_function_result(oid) as res, pg_get_function_arguments(oid) as args, prolang
    into a from pg_proc p where oid = 'public.bist_intraday_targets(integer)'::regprocedure;

  if a.m <> '36d7209bf11615ba628fcee3f274faa3' or a.len <> 422 then
    raise exception '160: unexpected body (md5 %, length %)', a.m, a.len;
  end if;
  if a.m = b.m then raise exception '160: the body did not change'; end if;
  if a.grants is distinct from b.grants then raise exception '160: grants changed: % -> %', b.grants, a.grants; end if;
  if a.cfg is distinct from b.cfg or a.provolatile <> b.provolatile or a.prosecdef <> b.prosecdef or a.proretset <> b.proretset
     or a.owner <> b.owner or a.res <> b.res or a.args <> b.args or a.prolang <> b.prolang then
    raise exception '160: an attribute other than the body changed';
  end if;
  if a.res <> 'TABLE(ticker text, last_ts timestamp with time zone)' or a.args <> 'p_limit integer DEFAULT 120' then
    raise exception '160: signature or result drifted: % / %', a.args, a.res;
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'bist_intraday_targets') <> 1 then
    raise exception '160: more than one bist_intraday_targets overload';
  end if;
  -- the second apply left the first apply's result
  select * into f from after_160_first;
  if f.m <> a.m then raise exception '160: the second apply changed the body'; end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '160') <> 1 then
    raise exception '160: ledger row count is not 1';
  end if;
  if has_function_privilege('anon', 'public.bist_intraday_targets(integer)', 'execute')
     or has_function_privilege('authenticated', 'public.bist_intraday_targets(integer)', 'execute')
     or not has_function_privilege('service_role', 'public.bist_intraday_targets(integer)', 'execute') then
    raise exception '160: execute privileges are not service_role only';
  end if;
end $$;

-- 2. The fix: only the traded THYAO comes back. -------------------------------------------------------------------
begin;
insert into public.articles (id, title) values
  ('00000000-0000-4000-8000-000000001601', 'a1'), ('00000000-0000-4000-8000-000000001602', 'a2'),
  ('00000000-0000-4000-8000-000000001603', 'a3'), ('00000000-0000-4000-8000-000000001604', 'a4');
insert into public.bist_companies (tickers, title, shares_traded) values
  (array['THYAO'], 'Turk Hava Yollari', true), (array['FNCLL'], 'Finansal kiralama', false),
  (array['NULLX'], 'unknown flag', null), (array['KRDMA', 'KRDMD'], 'Kardemir', true);
insert into public.article_tickers (article_id, ticker, matched_on) values
  ('00000000-0000-4000-8000-000000001601', 'FNCLL', 'alias:x'),
  ('00000000-0000-4000-8000-000000001602', 'THYAO', 'alias:y'),
  ('00000000-0000-4000-8000-000000001603', 'ZZZZ', 'alias:z'),
  ('00000000-0000-4000-8000-000000001604', 'NULLX', 'alias:n'),
  ('00000000-0000-4000-8000-000000001601', 'KRDMD', 'alias:k');
insert into public.bist_bars_5m (ticker, ts, close) values ('THYAO', timestamptz '2026-11-05 09:00:00+00', 1);
do $$
declare r text;
begin
  select string_agg(ticker || '@' || coalesce(to_char(last_ts at time zone 'UTC', 'HH24:MI'), 'null'), ',' order by last_ts nulls first, ticker)
    into r from public.bist_intraday_targets(120);
  -- KRDMD never fetched sorts first, THYAO has its 09:00 bar; FNCLL (not traded), NULLX (flag NULL) and ZZZZ (no company) are gone
  if r is distinct from 'KRDMD@null,THYAO@09:00' then
    raise exception '160: wanted KRDMD@null,THYAO@09:00, got %', r;
  end if;
  if (select count(*) from public.bist_intraday_targets(1)) <> 1 or (select count(*) from public.bist_intraday_targets()) <> 2 then
    raise exception '160: p_limit / default 120 not honoured';
  end if;
end $$;
rollback;

-- 3. Nothing was left behind by the scenarios above. ----------------------------------------------------------------
do $$
begin
  if exists (select 1 from public.article_tickers) or exists (select 1 from public.bist_companies) or exists (select 1 from public.bist_bars_5m) then
    raise exception 'a rolled-back fixture survived';
  end if;
end $$;

select 'DRYRUN 160 OK';
