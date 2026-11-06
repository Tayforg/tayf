-- 165 framing_pool_politics_gate (the Çerçeve pool keeps political outlet headlines only): local PG15 dry-run.
-- Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55565 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55565 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/165-framing-pool-politics-gate-dryrun.sql
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh    (TAYF_LIVE_ONLY=165 runs just this one)
--
-- (\ir paths below are relative to this file.) Every check is a DO block that raises on mismatch, so a clean
-- run ending in "DRYRUN 165 OK" is the pass. Every scenario that writes sits inside begin ... rollback, so the
-- database this leaves behind holds no fixture rows.
--
-- Why it exists. 165's JS test (tests/migrations/165-framing-pool-politics-gate.test.ts) reads the SQL as text;
-- this runs the SHIPPED function in PostgreSQL: that the parenthesised OR really leaves every other condition in
-- force, that a null category with politics_admitted_at set is kept, that a null kind is an outlet, that each of
-- the six English slugs is dropped on its own, and that the refresh's existing `gone` delete removes the rows the
-- old function had admitted.
--
-- Order: the state 165 sits on (articles.politics_admitted_at, jev_shadow_predictions, the pool table of 105), the
-- function as production has it before 165 (130 section 4, byte for byte, md5 pinned, with 105's revoke and grant)
-- plus a session-local copy of it (pg_temp.refresh_prod) to fill the pool the old way, a baseline refresh (the bug:
-- 20 rows of every kind), then 165 TWICE, the new fingerprint and attributes, and the same fixtures refreshed by the
-- new function (6 rows, the other 14 removed by `gone`).

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Prelude: the state 165 sits on. ------------------------------------------------------------------------
-- The stub's articles has no politics_admitted_at (production's has: migration 089 / 151 stamp it).
alter table public.articles add column if not exists politics_admitted_at timestamptz;

create table public.jev_shadow_predictions (
  id         bigserial primary key,
  article_id uuid,
  task       text not null,
  jev_prob   real,
  created_at timestamptz not null default now()
);

-- 105 section 1: the pool table, owner-only.
create table public.framing_candidate_pool (
  article_id   uuid primary key references public.articles(id) on delete cascade,
  title        text,
  published_at timestamptz not null,
  refreshed_at timestamptz not null default now()
);
revoke all on public.framing_candidate_pool from anon, authenticated, public;

-- 130 section 4, byte for byte: production's function (md5(prosrc) 9d57360d..., length 2093).
create or replace function public.framing_candidate_pool_refresh()
returns integer
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_now timestamptz;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtext('framing_candidate_pool_refresh')::bigint
  ) then
    return 0;
  end if;

  v_now := pg_catalog.now();

  with recent_politics as materialized (
    -- 072's index range scan on (task, created_at desc), with v_now for now().
    -- DISTINCT keeps one candidate per article.
    select distinct p.article_id as candidate_id
    from public.jev_shadow_predictions p
    where p.task = 'politics'
      and p.created_at >= v_now - interval '54 hours'
      and p.jev_prob >= 0.7
      and p.article_id is not null
  ),
  fresh as materialized (
    -- The FULL eligible set: no per-session anti-join and no newest-300 cut,
    -- both of which the draw still applies per request.
    select
      a.id           as article_id,
      a.title        as title,
      a.published_at as published_at
    from recent_politics rp
    join public.articles a on a.id = rp.candidate_id
    join public.sources s on s.id = a.source_id
    where a.published_at >= v_now - interval '48 hours'
      and s.active
      -- Normalised the same way src/lib/sources/kind.ts's sourceKindOf does:
      -- a null kind means "outlet", never "wire".
      and coalesce(s.kind, 'outlet') <> 'wire'
  ),
  gone as (
    delete from public.framing_candidate_pool c
    where not exists (select 1 from fresh f where f.article_id = c.article_id)
  )
  insert into public.framing_candidate_pool (article_id, title, published_at, refreshed_at)
  select f.article_id, f.title, f.published_at, v_now
  from fresh f
  on conflict (article_id) do update set
    title        = excluded.title,
    published_at = excluded.published_at,
    refreshed_at = excluded.refreshed_at
  -- Rewrite a row only when something it stores changed. Without this every
  -- tick rewrote all ~5.3k rows just to move refreshed_at.
  where (framing_candidate_pool.title, framing_candidate_pool.published_at) is distinct from (excluded.title, excluded.published_at);

  return (select count(*)::int from public.framing_candidate_pool);
end
$fn$;

revoke all on function public.framing_candidate_pool_refresh() from anon, authenticated, public;
grant execute on function public.framing_candidate_pool_refresh() to service_role;

-- The same body under a session-local name, to fill the pool the old way before 165 replaces the public one.
create function pg_temp.refresh_prod()
returns integer
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_now timestamptz;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtext('framing_candidate_pool_refresh')::bigint
  ) then
    return 0;
  end if;

  v_now := pg_catalog.now();

  with recent_politics as materialized (
    -- 072's index range scan on (task, created_at desc), with v_now for now().
    -- DISTINCT keeps one candidate per article.
    select distinct p.article_id as candidate_id
    from public.jev_shadow_predictions p
    where p.task = 'politics'
      and p.created_at >= v_now - interval '54 hours'
      and p.jev_prob >= 0.7
      and p.article_id is not null
  ),
  fresh as materialized (
    -- The FULL eligible set: no per-session anti-join and no newest-300 cut,
    -- both of which the draw still applies per request.
    select
      a.id           as article_id,
      a.title        as title,
      a.published_at as published_at
    from recent_politics rp
    join public.articles a on a.id = rp.candidate_id
    join public.sources s on s.id = a.source_id
    where a.published_at >= v_now - interval '48 hours'
      and s.active
      -- Normalised the same way src/lib/sources/kind.ts's sourceKindOf does:
      -- a null kind means "outlet", never "wire".
      and coalesce(s.kind, 'outlet') <> 'wire'
  ),
  gone as (
    delete from public.framing_candidate_pool c
    where not exists (select 1 from fresh f where f.article_id = c.article_id)
  )
  insert into public.framing_candidate_pool (article_id, title, published_at, refreshed_at)
  select f.article_id, f.title, f.published_at, v_now
  from fresh f
  on conflict (article_id) do update set
    title        = excluded.title,
    published_at = excluded.published_at,
    refreshed_at = excluded.refreshed_at
  -- Rewrite a row only when something it stores changed. Without this every
  -- tick rewrote all ~5.3k rows just to move refreshed_at.
  where (framing_candidate_pool.title, framing_candidate_pool.published_at) is distinct from (excluded.title, excluded.published_at);

  return (select count(*)::int from public.framing_candidate_pool);
end
$fn$;

-- The fixtures. One loader, called inside each rolled-back transaction below.
--   key  source (kind)               category    admitted  note
--   k01  outlet                      politika    -         kept
--   k02  outlet                      son_dakika  -         kept
--   k03  outlet                      ekonomi     -         politics gate
--   k04  outlet                      ekonomi     now       kept (admitted)
--   k05  outlet                      null        now       kept (null category, admitted)
--   k06  outlet                      null        -         politics gate (null or false)
--   k07  outlet                      dunya       -         politics gate
--   k08  outlet                      genel       -         politics gate
--   k09  aggregator                  politika    -         outlet gate
--   k10  niche                       politika    -         outlet gate
--   k11  wire                        politika    -         never in the pool (already out)
--   k12  null kind                   politika    -         kept (null kind is an outlet)
--   k13..k18  the six English slugs  politika    -         English gate, one each
--   k19  inactive outlet             politika    -         never in the pool (already out)
--   k20  outlet, prediction 0.5      politika    -         never in the pool (already out)
--   k21  outlet, 49 h old            politika    -         never in the pool (already out)
--   k22  outlet, two predictions     politika    -         kept, once
--   k23  aggregator                  ekonomi     now       outlet gate (admitted does not rescue a non-outlet)
--   k24  English a-news              ekonomi     now       English gate (admitted does not rescue an English slug)
create function pg_temp.load_fixtures() returns void language plpgsql as $f$
begin
  insert into public.sources (slug, name, kind, active) values
    ('outlet-fx', 'outlet', 'outlet', true), ('aggregator-fx', 'aggregator', 'aggregator', true),
    ('niche-fx', 'niche', 'niche', true), ('wire-fx', 'wire', 'wire', true), ('nullkind-fx', 'nullkind', null, true),
    ('inactive-fx', 'inactive', 'outlet', false),
    ('a-news', 'A News', 'outlet', true), ('daily-sabah', 'Daily Sabah', 'outlet', true),
    ('hurriyet-daily-news', 'Hurriyet Daily News', 'outlet', true), ('mfa-turkey', 'MFA Turkey', 'outlet', true),
    ('trt-world', 'TRT World', 'outlet', true), ('turkiye-today', 'Turkiye Today', 'outlet', true);

  insert into public.articles (title, source_id, category, politics_admitted_at, published_at)
  select f.title, s.id, f.category, f.admitted, now() - f.age
    from (values
      ('k01', 'outlet-fx',           'politika',   null::timestamptz, interval '1 hour'),
      ('k02', 'outlet-fx',           'son_dakika', null,              interval '1 hour'),
      ('k03', 'outlet-fx',           'ekonomi',    null,              interval '1 hour'),
      ('k04', 'outlet-fx',           'ekonomi',    now(),             interval '1 hour'),
      ('k05', 'outlet-fx',           null,         now(),             interval '1 hour'),
      ('k06', 'outlet-fx',           null,         null,              interval '1 hour'),
      ('k07', 'outlet-fx',           'dunya',      null,              interval '1 hour'),
      ('k08', 'outlet-fx',           'genel',      null,              interval '1 hour'),
      ('k09', 'aggregator-fx',       'politika',   null,              interval '1 hour'),
      ('k10', 'niche-fx',            'politika',   null,              interval '1 hour'),
      ('k11', 'wire-fx',             'politika',   null,              interval '1 hour'),
      ('k12', 'nullkind-fx',         'politika',   null,              interval '1 hour'),
      ('k13', 'a-news',              'politika',   null,              interval '1 hour'),
      ('k14', 'daily-sabah',         'politika',   null,              interval '1 hour'),
      ('k15', 'hurriyet-daily-news', 'politika',   null,              interval '1 hour'),
      ('k16', 'mfa-turkey',          'politika',   null,              interval '1 hour'),
      ('k17', 'trt-world',           'politika',   null,              interval '1 hour'),
      ('k18', 'turkiye-today',       'politika',   null,              interval '1 hour'),
      ('k19', 'inactive-fx',         'politika',   null,              interval '1 hour'),
      ('k20', 'outlet-fx',           'politika',   null,              interval '1 hour'),
      ('k21', 'outlet-fx',           'politika',   null,              interval '49 hours'),
      ('k22', 'outlet-fx',           'politika',   null,              interval '1 hour'),
      ('k23', 'aggregator-fx',       'ekonomi',    now(),             interval '1 hour'),
      ('k24', 'a-news',              'ekonomi',    now(),             interval '1 hour')
    ) as f(title, slug, category, admitted, age)
    join public.sources s on s.slug = f.slug;

  insert into public.jev_shadow_predictions (article_id, task, jev_prob)
  select a.id, 'politics', case when a.title = 'k20' then 0.5 else 0.9 end from public.articles a;
  -- k22 carries a second, older prediction: DISTINCT keeps one candidate per article
  insert into public.jev_shadow_predictions (article_id, task, jev_prob, created_at)
  select a.id, 'politics', 0.95, now() - interval '2 hours' from public.articles a where a.title = 'k22';
end
$f$;

-- Baseline: this is production's function (md5(prosrc) read on production on 2026-11-06) with its ACL
-- (owner + service_role, nobody else). -----------------------------------------------------------------------
create temp table before_165 as
  select md5(prosrc) as m, length(prosrc) as len,
         (select string_agg(case when a.grantee = 0 then 'public' else a.grantee::regrole::text end || ':' || a.privilege_type,
                            ',' order by case when a.grantee = 0 then 'public' else a.grantee::regrole::text end)
            from aclexplode(p.proacl) a) as grants,
         proconfig::text as cfg, provolatile, prosecdef, proretset, proowner::regrole::text as owner,
         pg_get_function_result(oid) as res, pg_get_function_arguments(oid) as args, prolang
    from pg_proc p where oid = 'public.framing_candidate_pool_refresh()'::regprocedure;

do $$
declare b record;
begin
  select * into b from before_165;
  if b.m <> '9d57360d0dc610c8c2d3c1d97ca6fc75' or b.len <> 2093 then
    raise exception 'baseline: the prelude function is not production''s (md5 %, length %)', b.m, b.len;
  end if;
  if b.grants not like '%service_role:EXECUTE%' or b.grants like '%anon%' or b.grants like '%authenticated%' or b.grants like '%public%' then
    raise exception 'baseline: unexpected grants %', b.grants;
  end if;
  if not b.prosecdef or b.provolatile <> 'v' or b.cfg is distinct from '{"search_path=\"\""}' or b.proretset or b.res <> 'integer' then
    raise exception 'baseline: unexpected attributes (secdef %, volatile %, config %)', b.prosecdef, b.provolatile, b.cfg;
  end if;
  if (select md5(prosrc) from pg_proc where oid = 'pg_temp.refresh_prod()'::regprocedure) <> b.m then
    raise exception 'baseline: the session-local copy differs from the prelude function';
  end if;
end $$;

-- The bug, on the old function: every kind of article is in the pool. ------------------------------------------------
begin;
select pg_temp.load_fixtures();
do $$
declare n int; keys text;
begin
  n := public.framing_candidate_pool_refresh();
  select string_agg(title, ',' order by title) into keys from public.framing_candidate_pool;
  if keys is distinct from 'k01,k02,k03,k04,k05,k06,k07,k08,k09,k10,k12,k13,k14,k15,k16,k17,k18,k22,k23,k24' or n <> 20 then
    raise exception 'baseline: the old function should admit 20 rows of every kind, got % (%)', n, keys;
  end if;
end $$;
rollback;

-- 165, TWICE (safe to re-apply). ------------------------------------------------------------------------------
\ir ../../../supabase/migrations/165_framing_pool_politics_gate.sql
create temp table after_165_first as
  select md5(prosrc) as m, proacl::text as acl from pg_proc where oid = 'public.framing_candidate_pool_refresh()'::regprocedure;
\ir ../../../supabase/migrations/165_framing_pool_politics_gate.sql

-- 1. The function: new body, everything else as before. -----------------------------------------------------------
do $$
declare a record; b record; f record;
begin
  select * into b from before_165;
  select md5(prosrc) as m, length(prosrc) as len,
         (select string_agg(case when x.grantee = 0 then 'public' else x.grantee::regrole::text end || ':' || x.privilege_type,
                            ',' order by case when x.grantee = 0 then 'public' else x.grantee::regrole::text end)
            from aclexplode(p.proacl) x) as grants,
         proconfig::text as cfg, provolatile, prosecdef, proretset, proowner::regrole::text as owner,
         pg_get_function_result(oid) as res, pg_get_function_arguments(oid) as args, prolang
    into a from pg_proc p where oid = 'public.framing_candidate_pool_refresh()'::regprocedure;

  if a.m <> 'eca2c0c86cd141e01a6f4b141fa8b977' or a.len <> 3022 then
    raise exception '165: unexpected body (md5 %, length %)', a.m, a.len;
  end if;
  if a.m = b.m then raise exception '165: the body did not change'; end if;
  if a.grants is distinct from b.grants then raise exception '165: grants changed: % -> %', b.grants, a.grants; end if;
  if a.cfg is distinct from b.cfg or a.provolatile <> b.provolatile or a.prosecdef <> b.prosecdef or a.proretset <> b.proretset
     or a.owner <> b.owner or a.res <> b.res or a.args <> b.args or a.prolang <> b.prolang then
    raise exception '165: an attribute other than the body changed';
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'framing_candidate_pool_refresh') <> 1 then
    raise exception '165: more than one framing_candidate_pool_refresh overload';
  end if;
  -- the second apply left the first apply's result
  select * into f from after_165_first;
  if f.m <> a.m then raise exception '165: the second apply changed the body'; end if;
  if has_function_privilege('anon', 'public.framing_candidate_pool_refresh()', 'execute')
     or has_function_privilege('authenticated', 'public.framing_candidate_pool_refresh()', 'execute')
     or not has_function_privilege('service_role', 'public.framing_candidate_pool_refresh()', 'execute') then
    raise exception '165: execute privileges are not service_role only';
  end if;
  if obj_description('public.framing_candidate_pool_refresh()'::regprocedure, 'pg_proc') not like '%165%' then
    raise exception '165: the function comment does not name 165';
  end if;
  -- 165 records its own ledger row, once even though it was applied twice
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '165') then
    raise exception '165: no ledger row for version 165';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '165') <> 1
     or (select name from supabase_migrations.schema_migrations where version = '165') <> '165_framing_pool_politics_gate' then
    raise exception '165: the ledger row is not exactly one row named 165_framing_pool_politics_gate';
  end if;
  -- the table is untouched: still owner-only and still empty
  if has_table_privilege('anon', 'public.framing_candidate_pool', 'select') or exists (select 1 from public.framing_candidate_pool) then
    raise exception '165: the pool table changed';
  end if;
end $$;

-- 2. The fix: the old function fills the pool with all 20 rows, the new one leaves 6 and `gone` removes the 14. -----
begin;
select pg_temp.load_fixtures();
do $$
declare n int; keys text; gone_keys text;
begin
  -- the pool as the old function left it
  n := pg_temp.refresh_prod();
  if n <> 20 then raise exception '165: the old fill should give 20 rows, got %', n; end if;

  n := public.framing_candidate_pool_refresh();
  select string_agg(title, ',' order by title) into keys from public.framing_candidate_pool;
  -- kept: politika, son_dakika, admitted ekonomi, admitted null category, null kind, the doubly-predicted one (once)
  if keys is distinct from 'k01,k02,k04,k05,k12,k22' or n <> 6 then
    raise exception '165: wanted k01,k02,k04,k05,k12,k22 (6), got % (%)', keys, n;
  end if;
  select string_agg(a.title, ',' order by a.title) into gone_keys
    from public.articles a where not exists (select 1 from public.framing_candidate_pool c where c.article_id = a.id);
  -- removed by `gone`: the politics gate (k03 k06 k07 k08), the outlet gate (k09 k10 k23), the English gate (k13..k18 k24),
  -- plus the four that never qualified (k11 wire, k19 inactive, k20 low prediction, k21 too old)
  if gone_keys is distinct from 'k03,k06,k07,k08,k09,k10,k11,k13,k14,k15,k16,k17,k18,k19,k20,k21,k23,k24' then
    raise exception '165: unexpected removed set %', gone_keys;
  end if;

  -- a second refresh changes nothing (idempotent) and returns the pool size
  if public.framing_candidate_pool_refresh() <> 6 then raise exception '165: the second refresh should return 6'; end if;

  -- the OR branch is live: stamping an ekonomi article politics_admitted_at admits it on the next refresh
  update public.articles set politics_admitted_at = now() where title = 'k03';
  -- (the refresh result goes into a variable first: a table read in the same expression would use the statement's
  -- snapshot, taken before the refresh wrote)
  n := public.framing_candidate_pool_refresh();
  if n <> 7 or not exists (select 1 from public.framing_candidate_pool where title = 'k03') then
    raise exception '165: an admitted ekonomi article should join the pool (got % rows)', n;
  end if;
  -- ... and a source re-classified as a non-outlet leaves it again
  update public.sources set kind = 'aggregator' where slug = 'outlet-fx';
  n := public.framing_candidate_pool_refresh();
  select string_agg(title, ',' order by title) into keys from public.framing_candidate_pool;
  if n <> 1 or keys is distinct from 'k12' then
    raise exception '165: after outlet-fx became an aggregator only the null-kind article should remain, got % (%)', keys, n;
  end if;
end $$;
rollback;

-- 3. Control: the six English articles are plain outlet politika rows, so only their source slug set them apart in
--    section 2. Rename those six sources and the same articles are admitted. ------------------------------------------
begin;
select pg_temp.load_fixtures();
do $$
declare v_slug text; n int;
begin
  foreach v_slug in array array['a-news', 'daily-sabah', 'hurriyet-daily-news', 'mfa-turkey', 'trt-world', 'turkiye-today'] loop
    update public.sources set slug = 'x-' || v_slug where sources.slug = v_slug;
  end loop;
  -- with every English source renamed, the six English politika articles are ordinary outlet rows (k13..k18), and so
  -- is the admitted ekonomi one of a-news (k24): the 6 kept in section 2 + 6 + 1
  n := public.framing_candidate_pool_refresh();
  if n <> 6 + 6 + 1
     or (select count(*) from public.framing_candidate_pool where title in ('k13', 'k14', 'k15', 'k16', 'k17', 'k18', 'k24')) <> 7 then
    raise exception '165: renamed English sources should be admitted (control), got % rows', n;
  end if;
end $$;
rollback;

-- 4. Nothing was left behind by the scenarios above. ----------------------------------------------------------------
do $$
begin
  if exists (select 1 from public.framing_candidate_pool) or exists (select 1 from public.jev_shadow_predictions)
     or exists (select 1 from public.articles) or exists (select 1 from public.sources) then
    raise exception 'a rolled-back fixture survived';
  end if;
end $$;

select 'DRYRUN 165 OK';
