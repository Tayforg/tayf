-- 138 saved_clusters_v2 recall/sibling veto: local PG15 dry-run. Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=/private/tmp/claude-501/-Users-fatihhekimoglu/1acb1ff4-979e-4aaa-8131-2db2e1d46641/scratchpad/pg-138-a   # then pg-138-b
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55538 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55538 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f /Users/fatihhekimoglu/.claude/jobs/c644d1b7/tmp/jevtest/qa/stub.sql \
--     -f tests/migrations/sql/138-saved-clusters-veto-dryrun.sql
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
--
-- (\ir paths below are relative to this file.) Every check is a DO block that
-- raises on mismatch, so a clean run ending in "DRYRUN 138 OK" is the pass. The
-- second application of 138 must print "INSERT 0 0" for the ledger row.
--
-- Fixture clusters are keyed by md5(key)::uuid, so every assertion reads by key.

\set ON_ERROR_STOP on

-- Prelude: Supabase default privileges (so the revokes have something to undo),
-- then the clusters columns the stub does not carry. blindspot_recall_veto is
-- NULLABLE here on purpose (production has it NOT NULL default false, 071) so the
-- null case of the coalesce is exercised too. -------------------------------------
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;

alter table public.clusters add column if not exists blindspot_recall_veto boolean;
alter table public.clusters add column if not exists merged_into uuid;
alter table public.clusters add column if not exists summary_tr text;

-- Apply: 124 (the function 138 replaces), then 138 TWICE (re-apply safety). --------
\ir ../../../supabase/migrations/124_saved_clusters_v2.sql
\echo '--- first application of 138'
\ir ../../../supabase/migrations/138_saved_clusters_veto.sql
\echo '--- second application of 138 (the ledger insert must say INSERT 0 0)'
\ir ../../../supabase/migrations/138_saved_clusters_veto.sql

-- Helpers (session-local) ----------------------------------------------------------
create function pg_temp.cid(p_key text) returns uuid language sql immutable as
$$ select md5(p_key)::uuid $$;

create function pg_temp.mk(p_key text, p_flag boolean, p_veto boolean) returns void language plpgsql as $$
begin
  insert into public.clusters (id, title_tr, title_tr_neutral, article_count, bias_distribution,
                               is_blindspot, blindspot_side, blindspot_recall_veto, updated_at)
  values (pg_temp.cid(p_key), 'fixture ' || p_key, 'fixture ' || p_key, 6,
          '{"gov_leaning": 5, "pro_government": 1}'::jsonb,
          p_flag, case when p_flag then 'pro_government' end, p_veto,
          pg_catalog.now() - (length(p_key) || ' minutes')::interval);
end $$;

-- 1. schema state right after the double apply ------------------------------------
do $$
declare
  v_acl text[];
begin
  if (select count(*) from supabase_migrations.schema_migrations where version = '138') <> 1 then
    raise exception '138 schema_migrations row missing or duplicated';
  end if;
  if (select name from supabase_migrations.schema_migrations where version = '138') <> '138_saved_clusters_veto' then
    raise exception '138 ledger name wrong';
  end if;
  if (select count(*) from pg_proc where proname = 'saved_clusters_v2' and pronamespace = 'public'::regnamespace) <> 1 then
    raise exception 'saved_clusters_v2 must exist exactly once (no overload from create or replace)';
  end if;

  -- same attributes as production (read 2026-11-01):
  --   proacl {postgres=X/postgres,service_role=X/postgres,anon=X/postgres}, STABLE, SECURITY DEFINER,
  --   proconfig {search_path=""}, prorows 1000, procost 100, language sql
  select array(select a::text from unnest(p.proacl) a order by 1) into v_acl
    from pg_proc p where p.oid = 'public.saved_clusters_v2(uuid[])'::regprocedure;
  if v_acl is distinct from array['anon=X/postgres', 'postgres=X/postgres', 'service_role=X/postgres'] then
    raise exception 'proacl is %, wanted the production shape (anon, postgres, service_role execute only)', v_acl;
  end if;
  if exists (select 1 from pg_proc p
              where p.oid = 'public.saved_clusters_v2(uuid[])'::regprocedure
                and not (p.provolatile = 's' and p.prosecdef
                         and p.proconfig = array['search_path=""']
                         and p.prorows = 1000 and p.procost = 100
                         and p.prolang = (select oid from pg_language where lanname = 'sql'))) then
    raise exception 'volatility / security definer / search_path / rows / cost / language differ from production';
  end if;

  if not has_function_privilege('anon', 'public.saved_clusters_v2(uuid[])', 'execute') then
    raise exception 'anon lost execute';
  end if;
  if has_function_privilege('authenticated', 'public.saved_clusters_v2(uuid[])', 'execute') then
    raise exception 'authenticated can execute (must not)';
  end if;
  if not has_function_privilege('service_role', 'public.saved_clusters_v2(uuid[])', 'execute') then
    raise exception 'service_role lost execute';
  end if;
  -- 138 grants nothing on tables: anon/authenticated still have no clusters privilege
  if has_table_privilege('anon', 'public.clusters', 'select') or has_table_privilege('authenticated', 'public.clusters', 'select') then
    raise exception 'anon/authenticated gained a table privilege on clusters';
  end if;
  -- the return shape is unchanged: 7 columns in 124's order and types
  if (select pg_catalog.pg_get_function_result('public.saved_clusters_v2(uuid[])'::regprocedure))
     <> 'TABLE(id uuid, title_tr text, title_tr_neutral text, article_count integer, bias_distribution jsonb, updated_at timestamp with time zone, is_blindspot boolean)' then
    raise exception 'return shape changed: %', pg_catalog.pg_get_function_result('public.saved_clusters_v2(uuid[])'::regprocedure);
  end if;
end $$;

-- 2. fixtures ----------------------------------------------------------------------
-- a006ab26-like: flagged and vetoed by Jev   (VF1 -> false)
-- 112a68bd-like: flagged and vetoed by sibling (the same column; VF2 -> false)
-- flagged, unvetoed (UF -> true), flagged with a NULL veto (NF -> true)
-- unflagged: UN (false/false) -> false, UV (false/true) -> false, UNN (false/null) -> false
select pg_temp.mk('VF1', true, true);
select pg_temp.mk('VF22', true, true);
select pg_temp.mk('UF333', true, false);
select pg_temp.mk('NF4444', true, null);
select pg_temp.mk('UN55555', false, false);
select pg_temp.mk('UV666666', false, true);
select pg_temp.mk('UNN7777777', false, null);

-- 3. behaviour as anon (the role the browser uses) ----------------------------------
create temp table ids as
  select array[pg_temp.cid('VF1'), pg_temp.cid('VF22'), pg_temp.cid('UF333'), pg_temp.cid('NF4444'),
               pg_temp.cid('UN55555'), pg_temp.cid('UV666666'), pg_temp.cid('UNN7777777')] as a;
grant select on ids to anon, authenticated, service_role;

set role anon;
do $$
declare
  v_ids uuid[] := (select a from ids);
  r record;
  n integer := 0;
  want boolean;
begin
  for r in select * from public.saved_clusters_v2(v_ids) loop
    n := n + 1;
    want := case r.title_tr
      when 'fixture VF1'         then false  -- vetoed row reads false
      when 'fixture VF22'        then false  -- the sibling-veto twin of the same column
      when 'fixture UF333'       then true   -- flagged, unvetoed
      when 'fixture NF4444'      then true   -- flagged, veto null: pass-through, like applyRecallVeto
      when 'fixture UN55555'     then false  -- unflagged
      when 'fixture UV666666'    then false
      when 'fixture UNN7777777'  then false
    end;
    if r.is_blindspot is distinct from want then
      raise exception '% is_blindspot=% wanted %', r.title_tr, r.is_blindspot, want;
    end if;
    -- the other six columns are untouched
    if r.article_count <> 6 or r.bias_distribution <> '{"gov_leaning": 5, "pro_government": 1}'::jsonb
       or r.title_tr_neutral <> r.title_tr or r.updated_at is null then
      raise exception '% other columns changed', r.title_tr;
    end if;
  end loop;
  if n <> 7 then raise exception 'wanted 7 rows, got %', n; end if;

  -- newest update first (the fixtures' updated_at shrinks with the key length)
  if (select array_agg(title_tr order by ord) from (
        select title_tr, row_number() over () as ord from public.saved_clusters_v2(v_ids)) s)
     is distinct from array['fixture VF1', 'fixture VF22', 'fixture UF333', 'fixture NF4444',
                            'fixture UN55555', 'fixture UV666666', 'fixture UNN7777777'] then
    raise exception 'order by updated_at desc lost';
  end if;

  -- null / empty input: zero rows, no error
  if exists (select 1 from public.saved_clusters_v2(null)) then raise exception 'null input returned rows'; end if;
  if exists (select 1 from public.saved_clusters_v2('{}'::uuid[])) then raise exception 'empty input returned rows'; end if;

  -- the 200-id truncation survives: a fixture at position 201 is not looked up
  if exists (
    select 1 from public.saved_clusters_v2(
      array(select gen_random_uuid() from generate_series(1, 200)) || pg_temp.cid('UF333'))) then
    raise exception 'id 201 was looked up: the p_ids[1:200] truncation is gone';
  end if;
  if (select count(*) from public.saved_clusters_v2(
        pg_temp.cid('UF333') || array(select gen_random_uuid() from generate_series(1, 199)))) <> 1 then
    raise exception 'id 1 of 200 was not found';
  end if;
end $$;
reset role;

-- authenticated must still be refused
set role authenticated;
do $$
begin
  perform * from public.saved_clusters_v2(null);
  raise exception 'authenticated could call saved_clusters_v2';
exception when insufficient_privilege then null;
end $$;
reset role;

-- service_role keeps access
set role service_role;
do $$
begin
  if (select count(*) from public.saved_clusters_v2((select a from ids))) <> 7 then
    raise exception 'service_role got the wrong row count';
  end if;
end $$;
reset role;

-- 4. fixture sanity: the two vetoed rows really are flagged AND vetoed in the table --
do $$
begin
  if (select count(*) from public.clusters c join ids i on c.id = any (i.a)
       where c.is_blindspot and c.blindspot_recall_veto) <> 2 then
    raise exception 'fixture sanity: expected exactly 2 flagged-and-vetoed rows';
  end if;
end $$;

\echo 'DRYRUN 138 OK'
