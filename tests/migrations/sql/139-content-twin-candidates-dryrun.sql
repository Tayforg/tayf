-- 139 content-twin candidates: local PG15 dry-run. Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=/private/tmp/claude-501/-Users-fatihhekimoglu/1acb1ff4-979e-4aaa-8131-2db2e1d46641/scratchpad/pg-139-a   # then pg-139-b
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55539 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55539 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f /Users/fatihhekimoglu/.claude/jobs/c644d1b7/tmp/jevtest/qa/stub.sql \
--     -f tests/migrations/sql/139-content-twin-candidates-dryrun.sql
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
--
-- (\ir paths below are relative to this file.) Every check is a DO block that raises on
-- mismatch, so a clean run ending in "DRYRUN 139 OK" is the pass. The migration is applied
-- twice; psql prints the command tags, so the ledger insert reads INSERT 0 1 and then
-- INSERT 0 0. The server is left running on purpose for the opt-in live test:
--   TAYF_PSQL=$PGBIN/psql PGHOST=/tmp PGPORT=55539 PGUSER=postgres PGDATABASE=postgres \
--     npx vitest run tests/migrations/139

\set ON_ERROR_STOP on

-- Prelude: Supabase default privileges (so the revokes have something to undo), then the
-- columns and the function the stub does not carry. -------------------------------------
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;

alter table public.clusters add column if not exists merged_into uuid;
alter table public.clusters add column if not exists summary_tr text;
create index if not exists idx_clusters_first_published on public.clusters (first_published desc);

-- Migration 129's fold, copied verbatim (the stub has no 129).
create or replace function public.tayf_search_fold(p_text text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select pg_catalog.lower(pg_catalog.translate(p_text, 'İIıŞşĞğÜüÖöÇçÂâÎîÛû' || pg_catalog.chr(775), 'iiissgguuooccaaiiuu') collate pg_catalog."C")
$fn$;
revoke all on function public.tayf_search_fold(text) from public, anon, authenticated;
grant execute on function public.tayf_search_fold(text) to service_role;

-- Apply 139 TWICE (re-apply safety). -------------------------------------------------------
\ir ../../../supabase/migrations/139_content_twin_candidates.sql
\ir ../../../supabase/migrations/139_content_twin_candidates.sql

-- Ledger, shape and ACL after both runs ------------------------------------------------------
do $$
declare
  v_n integer;
  v_p pg_catalog.pg_proc%rowtype;
  v_acl text;
begin
  select count(*) into v_n from supabase_migrations.schema_migrations where version = '139';
  assert v_n = 1, format('ledger rows for 139: %s (expected exactly 1)', v_n);
  assert (select name from supabase_migrations.schema_migrations where version = '139') = '139_content_twin_candidates',
         'ledger name';

  select count(*) into v_n from pg_catalog.pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'admin_content_twin_pairs';
  assert v_n = 1, format('admin_content_twin_pairs overloads: %s (expected 1)', v_n);

  select * into v_p from pg_catalog.pg_proc where oid = 'public.admin_content_twin_pairs(integer, integer)'::regprocedure;
  assert v_p.prosecdef, 'must be SECURITY DEFINER';
  assert v_p.provolatile = 's', format('must be STABLE, got %s', v_p.provolatile);
  assert v_p.proretset, 'must return a set';
  assert v_p.proconfig = array['search_path=""'], format('proconfig: %s', v_p.proconfig);
  assert pg_get_function_arguments(v_p.oid) = 'p_hours integer DEFAULT 48, p_limit integer DEFAULT 50',
         format('arguments: %s', pg_get_function_arguments(v_p.oid));
  assert pg_get_function_result(v_p.oid) =
         'TABLE(cluster_a uuid, cluster_b uuid, title_a text, title_b text, summary_a text, summary_b text, published_a timestamp with time zone, published_b timestamp with time zone, article_count_a integer, article_count_b integer, shared_stems integer, jaccard numeric)',
         format('result: %s', pg_get_function_result(v_p.oid));
  assert obj_description(v_p.oid, 'pg_proc') is not null, 'function comment missing';

  -- ACL: owner and service_role only; no PUBLIC (grantee 0), no anon, no authenticated.
  assert not has_function_privilege('anon', v_p.oid, 'execute'), 'anon must not execute';
  assert not has_function_privilege('authenticated', v_p.oid, 'execute'), 'authenticated must not execute';
  assert has_function_privilege('service_role', v_p.oid, 'execute'), 'service_role must execute';
  assert not exists (select 1 from aclexplode(v_p.proacl) a where a.grantee = 0), 'PUBLIC must have no grant';
  select string_agg(a.grantee::regrole::text, ',' order by a.grantee::regrole::text) into v_acl
    from aclexplode(v_p.proacl) a;
  assert v_acl = 'postgres,service_role', format('grantees: %s', v_acl);
end $$;

-- Called as each role: anon, authenticated and PUBLIC are denied; service_role runs it (0 rows on
-- the empty table). -------------------------------------------------------------------------
do $$
declare
  v_role text;
  v_denied boolean;
  v_n bigint;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    v_denied := false;
    begin
      execute format('set local role %I', v_role);
      perform 1 from public.admin_content_twin_pairs(48, 5);
    exception when insufficient_privilege then
      v_denied := true;
    end;
    reset role;
    assert v_denied, format('%s must be denied', v_role);
  end loop;

  set local role service_role;
  select count(*) into v_n from public.admin_content_twin_pairs(48, 5);
  reset role;
  assert v_n = 0, format('empty table must give 0 rows, got %s', v_n);
end $$;

-- Behaviour on a small fixture (rolled back) -----------------------------------------------------
begin;
insert into public.clusters (id, title_tr, summary_tr, first_published, article_count, is_archived, merged_into) values
  ('00000000-0000-4000-8000-000000000001', 'Zelenski İstanbul''a geldi, Erdoğan ile görüşecek', 'özet bir', now() - interval '3 hours', 5, false, null),
  ('00000000-0000-4000-8000-000000000002', 'Zelenski İstanbul''da, Erdoğan ile görüşecek',      'özet iki', now() - interval '2 hours', 3, false, null),
  ('00000000-0000-4000-8000-000000000003', 'Zelenski İstanbul''a geldi, Erdoğan ile görüşecek', 'arşiv',    now() - interval '2 hours', 3, true,  null),
  ('00000000-0000-4000-8000-000000000004', 'Zelenski İstanbul''a geldi, Erdoğan ile görüşecek', 'birleşti', now() - interval '2 hours', 3, false, '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000005', 'Zelenski İstanbul''a geldi, Erdoğan ile görüşecek', 'tek',      now() - interval '2 hours', 1, false, null),
  ('00000000-0000-4000-8000-000000000006', 'Zelenski İstanbul''a geldi, Erdoğan ile görüşecek', 'uzak',     now() - interval '10 hours', 4, false, null),
  ('00000000-0000-4000-8000-000000000007', 'Galatasaray Fenerbahçe derbisinde kazanan belli oldu', 'spor',   now() - interval '2 hours', 6, false, null);
do $$
declare
  r record;
  v_n integer;
begin
  -- only 1 + 2 qualify: 3 archived, 4 merged, 5 single article, 6 is 7 h before cluster 1 (> 6 h),
  -- 7 is another story.
  select count(*) into v_n from public.admin_content_twin_pairs(48, 100);
  assert v_n = 1, format('fixture pairs: %s (expected 1)', v_n);
  select * into r from public.admin_content_twin_pairs(48, 100);
  assert r.cluster_a = '00000000-0000-4000-8000-000000000001' and r.cluster_b = '00000000-0000-4000-8000-000000000002',
         'pair ids (a < b)';
  -- zelen, istan, erdog are shared; geldi is only in cluster 1 ('gorus' is a generic stem): 3 of 4.
  assert r.shared_stems = 3, format('shared stems %s (expected 3)', r.shared_stems);
  assert r.jaccard = 0.75, format('jaccard %s (expected 0.75)', r.jaccard);
  assert r.article_count_a = 5 and r.article_count_b = 3, 'article counts';
  assert r.summary_a = 'özet bir' and r.summary_b = 'özet iki', 'summaries';
  assert r.title_a like 'Zelenski %', 'title';
  -- 6 h window is inclusive: cluster 6 moved to exactly 6 h before cluster 1 pairs with it (and not
  -- with cluster 2, 7 h away).
  update public.clusters set first_published = (select first_published - interval '6 hours' from public.clusters
                                               where id = '00000000-0000-4000-8000-000000000001')
   where id = '00000000-0000-4000-8000-000000000006';
  select count(*) into v_n from public.admin_content_twin_pairs(48, 100);
  assert v_n = 2, format('after the inclusive-window update: %s pairs (expected 2: 1+2, 1+6)', v_n);
  -- clamps: 0 hours means 1, 0 limit means 1, null means the defaults.
  select count(*) into v_n from public.admin_content_twin_pairs(0, 100);
  assert v_n = 0, 'p_hours 0 clamps to 1 hour';
  select count(*) into v_n from public.admin_content_twin_pairs(48, 0);
  assert v_n = 1, 'p_limit 0 clamps to 1';
  select count(*) into v_n from public.admin_content_twin_pairs(null, null);
  assert v_n = 2, 'null means 48 hours / 50 rows';
end $$;
rollback;

-- Realistic load: ~2,000 live clusters over 48 h, planted twins, then EXPLAIN (ANALYZE, BUFFERS) of the
-- body as a plain SELECT with the literals 48 and 100 (what the prod measurement in the migration header
-- does). Rolled back. ----------------------------------------------------------------------------------
begin;
select setseed(0.4242);

create temp table tmp_vocab (i integer primary key, w text not null) on commit drop;
insert into tmp_vocab
select row_number() over ()::integer, w
  from (
    select unnest(array[
      'erdoğan','cumhurbaşkanı','başkan','bakan','belediyesi','soruşturma','tutuklandı','seçim','meclis','parti',
      'ankara','istanbul','izmir','israil','gazze','ukrayna','rusya','trump','abd','avrupa',
      'ekonomi','enflasyon','faiz','dolar','borsa','merkez','bankası','deprem','yangın','sel',
      'fenerbahçe','galatasaray','beşiktaş','maç','transfer','teknik','direktör','futbol','basketbol','şampiyon',
      'üniversite','öğrenci','sınav','okul','sağlık','hastane','doktor','aşı','kanser','ilaç',
      'polis','operasyon','gözaltı','mahkeme','karar','dava','hakim','savcı','cezaevi','af'
    ]) as w
    union all
    select translate(substr(md5('w' || g::text), 1, 7), '0123456789', 'ghjklmnprs')
      from generate_series(1, 340) g
  ) x;

-- 2,000 clusters: 5 to 9 words each, drawn with a skew toward the frequent head of the vocabulary.
insert into public.clusters (id, title_tr, summary_tr, first_published, article_count, is_archived)
select gen_random_uuid(),
       (select string_agg(v.w, ' ' order by k)
          from (select k, (select t.w from (select 1 + floor(power(random(), 2.2) * 400)::integer + k * 0 as pick) q join tmp_vocab t on t.i = q.pick) as w
                  from generate_series(1, 5 + (g % 5)) k) v),
       'özet ' || g,
       now() - random() * interval '48 hours',
       2 + (g % 39),
       false
  from generate_series(1, 2000) g;

-- 40 planted twin pairs: the same title with one word swapped, opened within 2 hours.
insert into public.clusters (id, title_tr, summary_tr, first_published, article_count, is_archived)
select gen_random_uuid(), c.title_tr || ' ' || 'planted' || (row_number() over ())::text, 'özet twin', least(c.first_published + interval '40 minutes', now()), 3, false
  from (select title_tr, first_published from public.clusters order by id limit 40) c;

analyze public.clusters;

do $$
declare
  v_src text;
  v_line text;
  v_ms numeric;
  v_plan text;
  v_live integer;
  v_pairs integer;
  v_planted integer;
  i integer;
begin
  select count(*) into v_live from public.clusters
   where first_published >= now() - interval '48 hours' and not is_archived and merged_into is null and article_count >= 2;
  raise notice 'live clusters in the 48 h window: %', v_live;
  assert v_live >= 2000, 'seed produced too few live clusters';

  select count(*) into v_pairs from public.admin_content_twin_pairs(48, 100);
  raise notice 'pairs returned (limit 100): %', v_pairs;
  select count(*) into v_planted from public.admin_content_twin_pairs(48, 100) f
   where f.summary_a = 'özet twin' or f.summary_b = 'özet twin';
  raise notice 'pairs that involve a planted twin: %', v_planted;
  assert v_planted >= 25, format('planted twins missing: %s of 40', v_planted);
  assert v_pairs <= 100, 'limit 100 not respected';

  select replace(replace(p.prosrc, 'p_hours', '48'), 'p_limit', '100') into v_src
    from pg_catalog.pg_proc p where p.oid = 'public.admin_content_twin_pairs(integer, integer)'::regprocedure;

  for i in 1..3 loop
    v_plan := '';
    for v_line in execute 'explain (analyze, buffers) ' || v_src loop
      v_plan := v_plan || E'\n' || v_line;
      if v_line like 'Execution Time:%' then
        v_ms := substring(v_line from '([0-9.]+) ms')::numeric;
      end if;
    end loop;
    raise notice 'EXPLAIN (ANALYZE, BUFFERS) run %: Execution Time % ms', i, v_ms;
    if i = 3 then raise notice 'plan of run 3:%', v_plan; end if;
    assert v_ms < 1000, format('run %s took %s ms (target under 1000)', i, v_ms);
  end loop;
end $$;
rollback;

\echo DRYRUN 139 OK
