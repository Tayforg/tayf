-- 192 saved_clusters_v4 (effective_article_count) + the seventh anon RPC in ops_health_report() row 17:
-- local PG15 dry-run. Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55592 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55592 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/192-saved-clusters-v4-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql PGHOST=/tmp PGPORT=55592 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/192-saved-clusters-v4)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh
--
-- (\ir paths below are relative to this file.) Every check is a DO block that raises on mismatch, so a clean run
-- ending in "DRYRUN 192 OK" is the pass. Every scenario that writes sits inside begin ... rollback; the database
-- this leaves behind has the chain and 192 applied and no fixture in it.
--
-- Order: 150's dry-run (114, 115, 119, 122, 136, 145 and 150 in production order, on stand-ins for pg_cron, pg_net
-- and pgmq), 041 (sources.fetch_last_at, which the report reads) and 157, the clusters columns 124 / 138 need, 124,
-- 138 and 158 (saved_clusters_v3 as it is on production), 161, 167 and 173 (the report as it is on production,
-- gated on its md5), a baseline reading, then 192 TWICE, then the scenarios.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Prelude: the history 192 sits on. -----------------------------------------------------------------------
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
\ir ../../../supabase/migrations/158_saved_clusters_v3.sql
\ir ../../../supabase/migrations/161_image_coverage_by_source.sql
\ir ../../../supabase/migrations/167_ops_queue_poison_contract.sql
\ir ../../../supabase/migrations/173_ops_sources_dark_persistent.sql

-- The deployed bodies are the ones 192 starts from: v3 and the report as production runs them (read-only, 2026-11-11).
do $$
declare v_md5 text; v_len int;
begin
  select md5(prosrc), length(prosrc) into v_md5, v_len from pg_proc where oid = 'public.saved_clusters_v3(uuid[])'::regprocedure;
  if v_md5 <> '2964f03d7a434b67dc00ddeecf833131' or v_len <> 393 then
    raise exception 'the local 158 body of v3 differs from production (md5 gate): % / %', v_md5, v_len;
  end if;
  select md5(prosrc), length(prosrc) into v_md5, v_len from pg_proc where oid = 'public.ops_health_report()'::regprocedure;
  if v_md5 <> '55fa63d2f5d876feed93eb9f7b263b27' or v_len <> 52432 then
    raise exception 'the local 173 body of the report differs from production (md5 gate): % / %', v_md5, v_len;
  end if;
end $$;

-- Baseline (what production runs the moment before 192): the report has 22 rows, anon_surface passes with the
-- six-RPC allowlist, v3 exists and v4 does not. -----------------------------------------------------------
create temp table before_192 as
  select check_name, status, observed, detail from public.ops_health_report();
create temp table before_v3 as
  select md5(prosrc) as m, length(prosrc) as len, proacl::text as acl, proconfig::text as cfg,
         provolatile, prosecdef, prorows, procost,
         pg_get_function_result(oid) as res
    from pg_proc where oid = 'public.saved_clusters_v3(uuid[])'::regprocedure;

do $$
begin
  if (select count(*) from before_192) <> 22 then raise exception 'baseline: wanted 22 report rows, got %', (select count(*) from before_192); end if;
  if (select status from before_192 where check_name = 'anon_surface') <> 'pass' then
    raise exception 'baseline: anon_surface should pass, got %', (select detail from before_192 where check_name = 'anon_surface');
  end if;
  if (select detail from before_192 where check_name = 'anon_surface') not like '%(6 izinli RPC hariç)%' then
    raise exception 'baseline: 173 should say 6 izinli RPC, got %', (select detail from before_192 where check_name = 'anon_surface');
  end if;
  if to_regprocedure('public.saved_clusters_v4(uuid[])') is not null then raise exception 'baseline: v4 must not exist yet'; end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '192') <> 0 then raise exception 'baseline: 192 must not be recorded yet'; end if;
end $$;

-- Apply: 192 TWICE (re-apply safety). ---------------------------------------------------------------------
\echo '--- first application of 192'
\ir ../../../supabase/migrations/192_saved_clusters_v4.sql
\echo '--- second application of 192 (the ledger insert must say INSERT 0 0)'
\ir ../../../supabase/migrations/192_saved_clusters_v4.sql

-- 1. schema state right after the double apply -------------------------------------------------------------
do $$
declare
  v_acl text[];
  v_v4 text[];
begin
  if (select count(*) from supabase_migrations.schema_migrations where version = '192') <> 1 then
    raise exception '192 schema_migrations row missing or duplicated';
  end if;
  if (select name from supabase_migrations.schema_migrations where version = '192') <> '192_saved_clusters_v4' then
    raise exception '192 ledger name wrong';
  end if;
  if (select count(*) from pg_proc where proname = 'saved_clusters_v4' and pronamespace = 'public'::regnamespace) <> 1 then
    raise exception 'saved_clusters_v4 must exist exactly once (no overload from create or replace)';
  end if;

  -- v4 carries v3's attributes: STABLE, SECURITY DEFINER, search_path "", rows 1000, cost 100, language sql
  if exists (select 1 from pg_proc p
              where p.oid = 'public.saved_clusters_v4(uuid[])'::regprocedure
                and not (p.provolatile = 's' and p.prosecdef
                         and p.proconfig = array['search_path=""']
                         and p.prorows = 1000 and p.procost = 100
                         and p.prolang = (select oid from pg_language where lanname = 'sql'))) then
    raise exception 'v4 volatility / security definer / search_path / rows / cost / language differ from v3';
  end if;

  -- ACL: anon, owner and service_role execute only, v3's shape
  select array(select a::text from unnest(p.proacl) a order by 1) into v_v4
    from pg_proc p where p.oid = 'public.saved_clusters_v4(uuid[])'::regprocedure;
  select array(select a::text from unnest(p.proacl) a order by 1) into v_acl
    from pg_proc p where p.oid = 'public.saved_clusters_v3(uuid[])'::regprocedure;
  if v_v4 is distinct from v_acl then raise exception 'v4 proacl % differs from v3 %', v_v4, v_acl; end if;
  if cardinality(v_v4) <> 3 then raise exception 'v4 proacl should have three entries (owner, anon, service_role), got %', v_v4; end if;

  if not has_function_privilege('anon', 'public.saved_clusters_v4(uuid[])', 'execute') then raise exception 'anon cannot execute v4'; end if;
  if has_function_privilege('authenticated', 'public.saved_clusters_v4(uuid[])', 'execute') then raise exception 'authenticated can execute v4 (must not)'; end if;
  if not has_function_privilege('service_role', 'public.saved_clusters_v4(uuid[])', 'execute') then raise exception 'service_role cannot execute v4'; end if;
  if has_table_privilege('anon', 'public.clusters', 'select') or has_table_privilege('authenticated', 'public.clusters', 'select')
     or has_table_privilege('anon', 'public.cluster_articles', 'select') or has_table_privilege('anon', 'public.articles', 'select') then
    raise exception 'anon/authenticated gained a table privilege on the cluster tree';
  end if;

  -- the return shape: v3's eight columns, then effective_article_count
  if pg_catalog.pg_get_function_result('public.saved_clusters_v4(uuid[])'::regprocedure)
     <> 'TABLE(id uuid, title_tr text, title_tr_neutral text, article_count integer, bias_distribution jsonb, updated_at timestamp with time zone, is_blindspot boolean, first_published timestamp with time zone, effective_article_count integer)' then
    raise exception 'v4 return shape wrong: %', pg_catalog.pg_get_function_result('public.saved_clusters_v4(uuid[])'::regprocedure);
  end if;

  -- v3 did not move: body, ACL, attributes, shape
  if exists (select 1 from before_v3 b, pg_proc p
              where p.oid = 'public.saved_clusters_v3(uuid[])'::regprocedure
                and (md5(p.prosrc) <> b.m or length(p.prosrc) <> b.len or p.proacl::text <> b.acl
                     or p.proconfig::text <> b.cfg or p.provolatile <> b.provolatile or p.prosecdef <> b.prosecdef
                     or p.prorows <> b.prorows or p.procost <> b.procost
                     or pg_get_function_result(p.oid) <> b.res)) then
    raise exception 'saved_clusters_v3 changed';
  end if;
end $$;

-- 2. ops_health_report() --------------------------------------------------------------------------------------
do $$
declare
  v_old text[];
  v_new text[];
  v_acl text[];
begin
  select array_agg(check_name order by ord) into v_old from (select check_name, row_number() over () as ord from before_192) s;
  select array_agg(check_name order by ord) into v_new from (select check_name, row_number() over () as ord from public.ops_health_report()) s;
  if v_old is distinct from v_new or cardinality(v_new) <> 22 then
    raise exception 'report rows changed: % -> %', v_old, v_new;
  end if;
  if (select status from public.ops_health_report() where check_name = 'anon_surface') <> 'pass' then
    raise exception 'anon_surface no longer passes with v4 allowlisted: %', (select detail from public.ops_health_report() where check_name = 'anon_surface');
  end if;
  -- the stub has no auth schema, so the tail reads `auth.users okunamadı` here and `auth.users 0` on Supabase
  if (select detail from public.ops_health_report() where check_name = 'anon_surface')
     not like 'anon/authenticated yetkisi yok: tablo/dizi 0, definer fonksiyon 0, invoker fonksiyon 0 (7 izinli RPC hariç) · auth.users %' then
    raise exception 'anon_surface detail wrong: %', (select detail from public.ops_health_report() where check_name = 'anon_surface');
  end if;
  -- every other row reads as it did before (same names, same statuses on the empty stub)
  if exists (select 1 from before_192 b join public.ops_health_report() r using (check_name)
              where b.check_name <> 'anon_surface' and b.status is distinct from r.status) then
    raise exception 'a row other than anon_surface changed its status';
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

-- 3. fixtures and behaviour as anon (the role the browser uses), all inside one transaction that is rolled back --------
begin;

-- p_members: a jsonb array of [source number, minutes after the base time, content hash or null]
create function pg_temp.cid(p_key text) returns uuid language sql immutable as $$ select md5(p_key)::uuid $$;

create function pg_temp.fx(p_key text, p_stored int, p_members jsonb) returns void language plpgsql as $$
declare
  m jsonb;
  v_src uuid;
  v_art uuid;
begin
  insert into public.clusters (id, title_tr, title_tr_neutral, article_count, bias_distribution,
                               is_blindspot, blindspot_side, blindspot_recall_veto, first_published, updated_at)
  values (pg_temp.cid(p_key), 'fixture ' || p_key, 'fixture ' || p_key, p_stored,
          '{"center": 3, "gov_leaning": 1}'::jsonb, false, null, false, pg_catalog.now() - interval '2 hours',
          pg_catalog.now() - (length(p_key) || ' minutes')::interval);
  for m in select * from jsonb_array_elements(p_members) loop
    select s.id into v_src from public.sources s where s.slug = 'drysrc-' || (m->>0);
    if v_src is null then
      insert into public.sources (slug, name, bias, kind, active) values ('drysrc-' || (m->>0), 'Dry ' || (m->>0), 'center', 'outlet', true)
        returning id into v_src;
    end if;
    insert into public.articles (source_id, title, url, published_at, content_hash)
      values (v_src, 'title ' || p_key || ' ' || (m->>0) || ' ' || (m->>1), 'https://example.test/' || p_key || '/' || (m->>0) || '/' || (m->>1),
              timestamptz '2026-11-05 12:00:00+00' + ((m->>1) || ' minutes')::interval,
              case when m->>2 is null then null else p_key || ':' || (m->>2) end)
      returning id into v_art;
    insert into public.cluster_articles (cluster_id, article_id) values (pg_temp.cid(p_key), v_art);
  end loop;
end $$;

-- key, stored raw count, members, and below the wanted effective count
select pg_temp.fx('W63', 6, '[[1,1,"A"],[2,2,"A"],[3,3,"B"],[4,4,"B"],[5,5,"C"],[6,6,"C"]]');          -- 1e801e36: 6 outlets, 3 texts -> 3
select pg_temp.fx('PAIR', 2, '[[1,1,"A"],[2,2,"A"]]');                                                   -- fewer than 3 never collapse -> 2
select pg_temp.fx('DIST4', 4, '[[1,1,"A"],[2,2,"B"],[3,3,"C"],[4,4,"D"]]');                              -- 4
select pg_temp.fx('T3H2', 3, '[[1,1,"A"],[2,2,"A"],[3,3,"B"]]');                                         -- 2 / 3 > 0.5 -> 3
select pg_temp.fx('T4H2', 4, '[[1,1,"A"],[2,2,"A"],[3,3,"B"],[4,4,"B"]]');                               -- 2 / 4 = 0.5 -> wire -> 2
select pg_temp.fx('NULL3', 3, '[[1,1,null],[2,2,null],[3,3,null]]');                                     -- NULL is its own text -> 3
select pg_temp.fx('DUPSRC', 5, '[[1,1,"A"],[1,2,"B"],[1,3,"C"],[2,4,"A"],[3,5,"A"]]');                   -- dedupe first: 3 members, 1 text -> 1
select pg_temp.fx('S7H4', 7, '[[1,1,"A"],[2,2,"A"],[3,3,"B"],[4,4,"B"],[5,5,"C"],[6,6,"D"],[7,7,"D"]]'); -- 4 / 7 > 0.5 -> 7
select pg_temp.fx('S7H3', 7, '[[1,1,"A"],[2,2,"A"],[3,3,"A"],[4,4,"B"],[5,5,"B"],[6,6,"C"],[7,7,"C"]]'); -- 3 / 7 <= 0.5 -> 3
select pg_temp.fx('NOMEM', 3, '[]');                                                                      -- no member rows -> NULL
select pg_temp.fx('MIXNULL', 4, '[[1,1,"A"],[2,2,"A"],[3,3,null],[4,4,null]]');                          -- 3 texts / 4 -> 4
select pg_temp.fx('COPY5', 5, '[[1,1,"A"],[2,2,"A"],[3,3,"A"],[4,4,"A"],[5,5,"A"]]');                    -- 1

create temp table fx_want (id uuid, key text, stored int, want int);
insert into fx_want
  select pg_temp.cid(k), k, s, w from (values
    ('W63', 6, 3), ('PAIR', 2, 2), ('DIST4', 4, 4), ('T3H2', 3, 3), ('T4H2', 4, 2), ('NULL3', 3, 3),
    ('DUPSRC', 5, 1), ('S7H4', 7, 7), ('S7H3', 7, 3), ('NOMEM', 3, null), ('MIXNULL', 4, 4), ('COPY5', 5, 1)) v(k, s, w);
grant select on fx_want to anon, authenticated, service_role;

set role anon;
do $$
declare
  v_ids uuid[] := (select array_agg(id) from fx_want);
  r record;
  n integer := 0;
  -- h113 database-192-2d-array-bound-bypass: 2-D inputs. p_ids[1:200] slices only the OUTER dimension.
  v_2d_small uuid[] := array[[md5('W63')::uuid, gen_random_uuid()], [gen_random_uuid(), gen_random_uuid()]];
  v_2d_at_201 uuid[] := (select ('{' || string_agg('{"' || (case when g = 201 then md5('W63')::uuid else gen_random_uuid() end)
                                                       || '","' || gen_random_uuid() || '"}', ',' order by g) || '}')::uuid[]
                           from generate_series(1, 201) g);
  v_2d_at_1 uuid[] := (select ('{' || string_agg('{"' || (case when g = 1 then md5('W63')::uuid else gen_random_uuid() end)
                                                     || '","' || gen_random_uuid() || '"}', ',' order by g) || '}')::uuid[]
                         from generate_series(1, 201) g);
begin
  for r in select * from public.saved_clusters_v4(v_ids) loop
    n := n + 1;
    if r.effective_article_count is distinct from (select w.want from fx_want w where w.id = r.id) then
      raise exception '% effective_article_count=% wanted %', r.title_tr, r.effective_article_count, (select w.want from fx_want w where w.id = r.id);
    end if;
    if r.article_count <> (select w.stored from fx_want w where w.id = r.id) then
      raise exception '% article_count changed to %', r.title_tr, r.article_count;
    end if;
  end loop;
  if n <> 12 then raise exception 'wanted 12 rows, got %', n; end if;

  -- v4 minus effective_article_count is the v3 row, for every fixture
  if exists (
    select 1 from public.saved_clusters_v4(v_ids) v4
      left join public.saved_clusters_v3(v_ids) v3 using (id)
     where to_jsonb(v4) - 'effective_article_count' is distinct from to_jsonb(v3)) then
    raise exception 'v4 minus effective_article_count differs from v3';
  end if;
  if (select count(*) from public.saved_clusters_v3(v_ids)) <> 12 then raise exception 'v3 row count changed'; end if;

  -- newest update first, the same order as v3 (the fixtures' updated_at shrinks with the key length)
  if (select array_agg(id order by ord) from (select id, row_number() over () as ord from public.saved_clusters_v4(v_ids)) s)
     is distinct from (select array_agg(id order by ord) from (select id, row_number() over () as ord from public.saved_clusters_v3(v_ids)) s) then
    raise exception 'order by updated_at desc lost';
  end if;

  -- the production example by name
  if (select effective_article_count from public.saved_clusters_v4(array[md5('W63')::uuid])) <> 3
     or (select article_count from public.saved_clusters_v4(array[md5('W63')::uuid])) <> 6 then
    raise exception 'the 6-members-3-hashes example is not 3 / 6';
  end if;

  -- null / empty input: zero rows, no error
  if exists (select 1 from public.saved_clusters_v4(null)) then raise exception 'null input returned rows'; end if;
  if exists (select 1 from public.saved_clusters_v4('{}'::uuid[])) then raise exception 'empty input returned rows'; end if;

  -- the 200-id truncation survives: a fixture at position 201 is not looked up, one at position 1 is
  if exists (
    select 1 from public.saved_clusters_v4(
      array(select gen_random_uuid() from generate_series(1, 200)) || md5('W63')::uuid)) then
    raise exception 'id 201 was looked up: the p_ids[1:200] truncation is gone';
  end if;
  if (select count(*) from public.saved_clusters_v4(
        md5('W63')::uuid || array(select gen_random_uuid() from generate_series(1, 199)))) <> 1 then
    raise exception 'id 1 of 200 was not found';
  end if;

  -- a multi-dimensional p_ids reads nothing: the slice would cap only the outer dimension and `= any`
  -- would look up every inner element (past the 200-id cap, through the per-cluster lateral)
  if array_ndims(v_2d_small) <> 2 or array_ndims(v_2d_at_201) <> 2 or array_ndims(v_2d_at_1) <> 2
     or array_length(v_2d_at_201, 1) <> 201 or array_length(v_2d_at_201, 2) <> 2 then
    raise exception 'the 2-D test inputs are not 2-D';
  end if;
  if exists (select 1 from public.saved_clusters_v4(v_2d_small)) then
    raise exception 'a 2 x 2 array holding W63 was looked up: the array_ndims(p_ids) = 1 guard is gone';
  end if;
  if exists (select 1 from public.saved_clusters_v4(v_2d_at_201)) then
    raise exception 'a 201 x 2 array holding W63 at outer position 201 returned rows';
  end if;
  if exists (select 1 from public.saved_clusters_v4(v_2d_at_1)) then
    raise exception 'a 201 x 2 array holding W63 at outer position 1 was looked up: the 2-D bound is bypassed';
  end if;
  -- the same id in a 1-D array is still found, so the guard does not refuse a normal call
  if (select count(*) from public.saved_clusters_v4(array[md5('W63')::uuid, gen_random_uuid()])) <> 1 then
    raise exception 'a 1-D array holding W63 was not found';
  end if;
end $$;
reset role;

-- authenticated must still be refused; service_role keeps access
set role authenticated;
do $$
begin
  perform * from public.saved_clusters_v4(null);
  raise exception 'authenticated could call saved_clusters_v4';
exception when insufficient_privilege then null;
end $$;
reset role;

set role service_role;
do $$
begin
  if (select count(*) from public.saved_clusters_v4((select array_agg(id) from fx_want))) <> 12 then
    raise exception 'service_role got the wrong row count';
  end if;
end $$;
reset role;

rollback;

-- 4. the anon_surface check still catches a real leak (rolled back) -------------------------------------------------
-- A new anon-executable SECURITY DEFINER RPC that is not in the seven, and an overload of v4, must both fail.
begin;
create function public.saved_clusters_v5(p_ids uuid[]) returns integer language sql security definer set search_path = '' as $f$ select 1 $f$;
do $$
begin
  if (select status from public.ops_health_report() where check_name = 'anon_surface') <> 'fail' then
    raise exception 'an eighth anon RPC (saved_clusters_v5) did not fail anon_surface';
  end if;
end $$;
rollback;

begin;
create function public.saved_clusters_v4(p_ids text[]) returns integer language sql security definer set search_path = '' as $f$ select 1 $f$;
do $$
begin
  if (select status from public.ops_health_report() where check_name = 'anon_surface') <> 'fail' then
    raise exception 'an overload of saved_clusters_v4 did not fail anon_surface (the allowlist is by full identity)';
  end if;
end $$;
rollback;

do $$
begin
  if (select status from public.ops_health_report() where check_name = 'anon_surface') <> 'pass' then
    raise exception 'anon_surface should pass again after the rolled-back leaks';
  end if;
  if to_regprocedure('public.saved_clusters_v5(uuid[])') is not null or to_regprocedure('public.saved_clusters_v4(text[])') is not null then
    raise exception 'a rolled-back function survived';
  end if;
  if exists (select 1 from public.clusters where title_tr like 'fixture %') or exists (select 1 from public.sources where slug like 'drysrc-%') then
    raise exception 'a rolled-back fixture survived';
  end if;
end $$;

select 'DRYRUN 192 OK';
