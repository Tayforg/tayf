-- 158 saved_clusters_v3 (first_published) + the sixth anon RPC in ops_health_report() row 17:
-- local PG15 dry-run. Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55558 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55558 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/158-saved-clusters-v3-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql PGHOST=/tmp PGPORT=55558 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/158-saved-clusters-v3)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh
--
-- (\ir paths below are relative to this file.) Every check is a DO block that raises on mismatch, so a
-- clean run ending in "DRYRUN 158 OK" is the pass. Every scenario that writes sits inside begin ... rollback,
-- except the six fixture clusters of section 3 (md5-keyed ids), which stay in the database the harness hands to
-- the live vitest block; that block inserts and rolls back fixtures of its own.
--
-- Order: 150's dry-run (114, 115, 119, 122, 136, 145 and 150 in production order, on stand-ins for pg_cron,
-- pg_net and pgmq, so ops_health_report() exists), 041 (sources.fetch_last_at, which row 20 reads) and 157
-- (the report's production text), the clusters columns 124 / 138 need, 124 and 138 (saved_clusters_v2 as it
-- is on production), a baseline reading, then 158 TWICE.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Prelude: the history 158 sits on. -----------------------------------------------------------------------
\ir 150-ops-queue-cron-liveness-dryrun.sql
\ir ../../../supabase/migrations/041_source_fetch_state.sql
\ir ../../../supabase/migrations/157_ingest_poll_stale.sql

-- blindspot_recall_veto is NULLABLE here on purpose (production has it NOT NULL default false, 071), so the
-- coalesce of 138's expression is exercised too; first_published comes from the stub.
alter table public.clusters add column if not exists blindspot_recall_veto boolean;
alter table public.clusters add column if not exists merged_into uuid;
alter table public.clusters add column if not exists summary_tr text;

\ir ../../../supabase/migrations/124_saved_clusters_v2.sql
\ir ../../../supabase/migrations/138_saved_clusters_veto.sql

-- Baseline (what production runs the moment before 158): the report has 20 rows, anon_surface passes with
-- the five-RPC allowlist, v2 exists and v3 does not. ------------------------------------------------------
create temp table before_158 as
  select check_name, status, observed, detail from public.ops_health_report();
create temp table before_v2 as
  select md5(prosrc) as m, length(prosrc) as len, proacl::text as acl, proconfig::text as cfg,
         provolatile, prosecdef, prorows, procost,
         pg_get_function_result(oid) as res
    from pg_proc where oid = 'public.saved_clusters_v2(uuid[])'::regprocedure;

do $$
begin
  if (select count(*) from before_158) <> 20 then raise exception 'baseline: wanted 20 report rows, got %', (select count(*) from before_158); end if;
  if (select status from before_158 where check_name = 'anon_surface') <> 'pass' then
    raise exception 'baseline: anon_surface should pass, got %', (select detail from before_158 where check_name = 'anon_surface');
  end if;
  if (select detail from before_158 where check_name = 'anon_surface') not like '%(5 izinli RPC hariç)%' then
    raise exception 'baseline: 157 should say 5 izinli RPC, got %', (select detail from before_158 where check_name = 'anon_surface');
  end if;
  if to_regprocedure('public.saved_clusters_v3(uuid[])') is not null then raise exception 'baseline: v3 must not exist yet'; end if;
  if (select len from before_v2) <> 365 or (select m from before_v2) <> '8ad5bfef58acd7c79d238c6feee06a6d' then
    raise exception 'baseline: v2 is not production''s body (md5 %, length %)', (select m from before_v2), (select len from before_v2);
  end if;
end $$;

-- Apply: 158 TWICE (re-apply safety). ---------------------------------------------------------------------
\echo '--- first application of 158'
\ir ../../../supabase/migrations/158_saved_clusters_v3.sql
\echo '--- second application of 158 (the ledger insert must say INSERT 0 0)'
\ir ../../../supabase/migrations/158_saved_clusters_v3.sql

-- 1. schema state right after the double apply -------------------------------------------------------------
do $$
declare
  v_acl text[];
  v_v3 text[];
begin
  if (select count(*) from supabase_migrations.schema_migrations where version = '158') <> 1 then
    raise exception '158 schema_migrations row missing or duplicated';
  end if;
  if (select name from supabase_migrations.schema_migrations where version = '158') <> '158_saved_clusters_v3' then
    raise exception '158 ledger name wrong';
  end if;
  if (select count(*) from pg_proc where proname = 'saved_clusters_v3' and pronamespace = 'public'::regnamespace) <> 1 then
    raise exception 'saved_clusters_v3 must exist exactly once (no overload from create or replace)';
  end if;

  -- v3 carries v2's attributes: STABLE, SECURITY DEFINER, search_path "", rows 1000, cost 100, language sql
  if exists (select 1 from pg_proc p
              where p.oid = 'public.saved_clusters_v3(uuid[])'::regprocedure
                and not (p.provolatile = 's' and p.prosecdef
                         and p.proconfig = array['search_path=""']
                         and p.prorows = 1000 and p.procost = 100
                         and p.prolang = (select oid from pg_language where lanname = 'sql'))) then
    raise exception 'v3 volatility / security definer / search_path / rows / cost / language differ from v2';
  end if;

  -- ACL: anon, owner and service_role execute only, v2's shape
  select array(select a::text from unnest(p.proacl) a order by 1) into v_v3
    from pg_proc p where p.oid = 'public.saved_clusters_v3(uuid[])'::regprocedure;
  select array(select a::text from unnest(p.proacl) a order by 1) into v_acl
    from pg_proc p where p.oid = 'public.saved_clusters_v2(uuid[])'::regprocedure;
  if v_v3 is distinct from v_acl then raise exception 'v3 proacl % differs from v2 %', v_v3, v_acl; end if;
  if cardinality(v_v3) <> 3 then raise exception 'v3 proacl should have three entries (owner, anon, service_role), got %', v_v3; end if;

  if not has_function_privilege('anon', 'public.saved_clusters_v3(uuid[])', 'execute') then raise exception 'anon cannot execute v3'; end if;
  if has_function_privilege('authenticated', 'public.saved_clusters_v3(uuid[])', 'execute') then raise exception 'authenticated can execute v3 (must not)'; end if;
  if not has_function_privilege('service_role', 'public.saved_clusters_v3(uuid[])', 'execute') then raise exception 'service_role cannot execute v3'; end if;
  if has_table_privilege('anon', 'public.clusters', 'select') or has_table_privilege('authenticated', 'public.clusters', 'select') then
    raise exception 'anon/authenticated gained a table privilege on clusters';
  end if;

  -- the return shape: v2's seven columns, then first_published
  if pg_catalog.pg_get_function_result('public.saved_clusters_v3(uuid[])'::regprocedure)
     <> 'TABLE(id uuid, title_tr text, title_tr_neutral text, article_count integer, bias_distribution jsonb, updated_at timestamp with time zone, is_blindspot boolean, first_published timestamp with time zone)' then
    raise exception 'v3 return shape wrong: %', pg_catalog.pg_get_function_result('public.saved_clusters_v3(uuid[])'::regprocedure);
  end if;

  -- v2 did not move: body, ACL, attributes, shape
  if exists (select 1 from before_v2 b, pg_proc p
              where p.oid = 'public.saved_clusters_v2(uuid[])'::regprocedure
                and (md5(p.prosrc) <> b.m or length(p.prosrc) <> b.len or p.proacl::text <> b.acl
                     or p.proconfig::text <> b.cfg or p.provolatile <> b.provolatile or p.prosecdef <> b.prosecdef
                     or p.prorows <> b.prorows or p.procost <> b.procost
                     or pg_get_function_result(p.oid) <> b.res)) then
    raise exception 'saved_clusters_v2 changed';
  end if;
end $$;

-- 2. ops_health_report() --------------------------------------------------------------------------------------
do $$
declare
  v_old text[];
  v_new text[];
  v_acl text[];
begin
  select array_agg(check_name order by ord) into v_old from (select check_name, row_number() over () as ord from before_158) s;
  select array_agg(check_name order by ord) into v_new from (select check_name, row_number() over () as ord from public.ops_health_report()) s;
  if v_old is distinct from v_new or cardinality(v_new) <> 20 then
    raise exception 'report rows changed: % -> %', v_old, v_new;
  end if;
  if (select status from public.ops_health_report() where check_name = 'anon_surface') <> 'pass' then
    raise exception 'anon_surface no longer passes with v3 allowlisted: %', (select detail from public.ops_health_report() where check_name = 'anon_surface');
  end if;
  -- the stub has no auth schema, so the tail reads `auth.users okunamadı` here and `auth.users 0` on Supabase
  if (select detail from public.ops_health_report() where check_name = 'anon_surface')
     not like 'anon/authenticated yetkisi yok: tablo/dizi 0, definer fonksiyon 0, invoker fonksiyon 0 (6 izinli RPC hariç) · auth.users %' then
    raise exception 'anon_surface detail wrong: %', (select detail from public.ops_health_report() where check_name = 'anon_surface');
  end if;
  -- the report is still service_role only
  select array(select a::text from unnest(p.proacl) a order by 1) into v_acl
    from pg_proc p where p.oid = 'public.ops_health_report()'::regprocedure;
  if has_function_privilege('anon', 'public.ops_health_report()', 'execute')
     or has_function_privilege('authenticated', 'public.ops_health_report()', 'execute')
     or not has_function_privilege('service_role', 'public.ops_health_report()', 'execute') then
    raise exception 'ops_health_report grants wrong: %', v_acl;
  end if;
  if not exists (select 1 from pg_proc p where p.oid = 'public.ops_health_report()'::regprocedure and p.prosecdef and p.proconfig = array['search_path=""']) then
    raise exception 'ops_health_report attributes changed';
  end if;
end $$;

-- 3. fixtures and behaviour as anon (the role the browser uses) ------------------------------------------------
-- 1 h old flagged, 25 h old flagged, vetoed, unflagged, flagged with no first_published, flagged with a NULL veto.
create function pg_temp.cid(p_key text) returns uuid language sql immutable as $$ select md5(p_key)::uuid $$;

create function pg_temp.mk(p_key text, p_flag boolean, p_veto boolean, p_first timestamptz) returns void language plpgsql as $$
begin
  insert into public.clusters (id, title_tr, title_tr_neutral, article_count, bias_distribution,
                               is_blindspot, blindspot_side, blindspot_recall_veto, first_published, updated_at)
  values (pg_temp.cid(p_key), 'fixture ' || p_key, 'fixture ' || p_key, 6,
          '{"gov_leaning": 5, "pro_government": 1}'::jsonb,
          p_flag, case when p_flag then 'pro_government' end, p_veto, p_first,
          pg_catalog.now() - (length(p_key) || ' minutes')::interval);
end $$;

select pg_temp.mk('YNG1', true, false, pg_catalog.now() - interval '1 hour');
select pg_temp.mk('OLD22', true, false, pg_catalog.now() - interval '25 hours');
select pg_temp.mk('VET333', true, true, pg_catalog.now() - interval '30 hours');
select pg_temp.mk('UNF4444', false, false, pg_catalog.now() - interval '2 hours');
select pg_temp.mk('NOFP55555', true, false, null);
select pg_temp.mk('NULV666666', true, null, pg_catalog.now() - interval '48 hours');

create temp table ids as
  select array[pg_temp.cid('YNG1'), pg_temp.cid('OLD22'), pg_temp.cid('VET333'), pg_temp.cid('UNF4444'),
               pg_temp.cid('NOFP55555'), pg_temp.cid('NULV666666')] as a;
grant select on ids to anon, authenticated, service_role;

set role anon;
do $$
declare
  v_ids uuid[] := (select a from ids);
  r record;
  n integer := 0;
  want boolean;
begin
  for r in select * from public.saved_clusters_v3(v_ids) loop
    n := n + 1;
    -- the claim is v2's (veto applied in the database); the 24 hour wait is the client's, so a young flagged
    -- row is still true here and carries its first_published
    want := case r.title_tr
      when 'fixture YNG1'      then true
      when 'fixture OLD22'     then true
      when 'fixture VET333'    then false
      when 'fixture UNF4444'   then false
      when 'fixture NOFP55555' then true
      when 'fixture NULV666666' then true
    end;
    if r.is_blindspot is distinct from want then raise exception '% is_blindspot=% wanted %', r.title_tr, r.is_blindspot, want; end if;
    if (r.title_tr = 'fixture YNG1' and not (r.first_published between pg_catalog.now() - interval '61 minutes' and pg_catalog.now() - interval '59 minutes'))
       or (r.title_tr = 'fixture OLD22' and not (r.first_published between pg_catalog.now() - interval '25 hours 1 minute' and pg_catalog.now() - interval '24 hours 59 minutes'))
       or (r.title_tr = 'fixture NOFP55555' and r.first_published is not null) then
      raise exception '% first_published wrong: %', r.title_tr, r.first_published;
    end if;
    if r.article_count <> 6 or r.bias_distribution <> '{"gov_leaning": 5, "pro_government": 1}'::jsonb
       or r.title_tr_neutral <> r.title_tr or r.updated_at is null then
      raise exception '% other columns changed', r.title_tr;
    end if;
  end loop;
  if n <> 6 then raise exception 'wanted 6 rows, got %', n; end if;

  -- v3 minus first_published is the v2 row, for every fixture
  if exists (
    select 1 from public.saved_clusters_v3(v_ids) v3
      left join public.saved_clusters_v2(v_ids) v2 using (id)
     where to_jsonb(v3) - 'first_published' is distinct from to_jsonb(v2)) then
    raise exception 'v3 minus first_published differs from v2';
  end if;
  if (select count(*) from public.saved_clusters_v2(v_ids)) <> 6 then raise exception 'v2 row count changed'; end if;

  -- newest update first (the fixtures' updated_at shrinks with the key length)
  if (select array_agg(title_tr order by ord) from (
        select title_tr, row_number() over () as ord from public.saved_clusters_v3(v_ids)) s)
     is distinct from array['fixture YNG1', 'fixture OLD22', 'fixture VET333', 'fixture UNF4444', 'fixture NOFP55555', 'fixture NULV666666'] then
    raise exception 'order by updated_at desc lost';
  end if;

  -- null / empty input: zero rows, no error
  if exists (select 1 from public.saved_clusters_v3(null)) then raise exception 'null input returned rows'; end if;
  if exists (select 1 from public.saved_clusters_v3('{}'::uuid[])) then raise exception 'empty input returned rows'; end if;

  -- the 200-id truncation survives: a fixture at position 201 is not looked up, one at position 1 is
  if exists (
    select 1 from public.saved_clusters_v3(
      array(select gen_random_uuid() from generate_series(1, 200)) || pg_temp.cid('OLD22'))) then
    raise exception 'id 201 was looked up: the p_ids[1:200] truncation is gone';
  end if;
  if (select count(*) from public.saved_clusters_v3(
        pg_temp.cid('OLD22') || array(select gen_random_uuid() from generate_series(1, 199)))) <> 1 then
    raise exception 'id 1 of 200 was not found';
  end if;
end $$;
reset role;

-- authenticated must still be refused; service_role keeps access
set role authenticated;
do $$
begin
  perform * from public.saved_clusters_v3(null);
  raise exception 'authenticated could call saved_clusters_v3';
exception when insufficient_privilege then null;
end $$;
reset role;

set role service_role;
do $$
begin
  if (select count(*) from public.saved_clusters_v3((select a from ids))) <> 6 then
    raise exception 'service_role got the wrong row count';
  end if;
end $$;
reset role;

-- 4. the anon_surface check still catches a real leak (rolled back) -------------------------------------------------
-- A new anon-executable SECURITY DEFINER RPC that is not in the six, and an overload of v3, must both fail.
begin;
create function public.saved_clusters_v4(p_ids uuid[]) returns integer language sql security definer set search_path = '' as $f$ select 1 $f$;
do $$
begin
  if (select status from public.ops_health_report() where check_name = 'anon_surface') <> 'fail' then
    raise exception 'a seventh anon RPC (saved_clusters_v4) did not fail anon_surface';
  end if;
end $$;
rollback;

begin;
create function public.saved_clusters_v3(p_ids text[]) returns integer language sql security definer set search_path = '' as $f$ select 1 $f$;
do $$
begin
  if (select status from public.ops_health_report() where check_name = 'anon_surface') <> 'fail' then
    raise exception 'an overload of saved_clusters_v3 did not fail anon_surface (the allowlist is by full identity)';
  end if;
end $$;
rollback;

do $$
begin
  if (select status from public.ops_health_report() where check_name = 'anon_surface') <> 'pass' then
    raise exception 'anon_surface should pass again after the rolled-back leaks';
  end if;
  if to_regprocedure('public.saved_clusters_v4(uuid[])') is not null or to_regprocedure('public.saved_clusters_v3(text[])') is not null then
    raise exception 'a rolled-back function survived';
  end if;
end $$;

-- 5. fixture sanity: the vetoed row is really flagged AND vetoed, the young one really young ---------------------------
do $$
begin
  if (select count(*) from public.clusters c join ids i on c.id = any (i.a) where c.is_blindspot and c.blindspot_recall_veto) <> 1 then
    raise exception 'fixture sanity: expected exactly 1 flagged-and-vetoed row';
  end if;
  if (select count(*) from public.clusters c join ids i on c.id = any (i.a)
       where c.is_blindspot and c.first_published > pg_catalog.now() - interval '24 hours') <> 1 then
    raise exception 'fixture sanity: expected exactly 1 flagged row younger than 24 hours';
  end if;
end $$;

select 'DRYRUN 158 OK';
