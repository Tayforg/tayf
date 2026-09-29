-- 099 cluster merge: local PG15 dry-run. Never touches production.
--
-- Run (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=/private/tmp/claude-501/-Users-fatihhekimoglu/1acb1ff4-979e-4aaa-8131-2db2e1d46641/scratchpad/pg-merge099
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55499 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55499 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f /Users/fatihhekimoglu/.claude/jobs/c644d1b7/tmp/jevtest/qa/stub.sql -f tests/migrations/sql/099-cluster-merge-dryrun.sql
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
--
-- (\ir paths below are relative to this file.) Every check is a DO block that
-- raises on mismatch, so a clean run ending in "DRYRUN 099 OK" is the pass.

\set ON_ERROR_STOP on

-- Prelude: simulate the Supabase default privileges, then the tables the stub
-- does not carry. -------------------------------------------------------------
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;
grant select on public.clusters to anon, authenticated;

create table if not exists public.jev_shadow_predictions (
  id bigserial primary key, task text, subject_id text, cluster_id uuid, article_id uuid,
  jev_prob numeric, created_at timestamptz default now());

create table if not exists public.fact_checks (id uuid primary key default gen_random_uuid());
create table if not exists public.cluster_fact_checks (
  cluster_id     uuid not null references public.clusters(id) on delete cascade,
  fact_check_id  uuid not null references public.fact_checks(id) on delete cascade,
  score          numeric(4,3) not null check (score >= 0 and score <= 1),
  matched_terms  text[] not null default '{}',
  method         text not null default 'keyword-v1',
  is_published   boolean not null default false,
  decided_by     text not null default 'auto' check (decided_by in ('auto','admin')),
  created_at     timestamptz not null default now(),
  primary key (cluster_id, fact_check_id)
);

-- Apply: 064, 098, then 099 twice (re-apply safety). ---------------------------
\ir ../../../supabase/migrations/064_jev_cluster_live.sql
\ir ../../../supabase/migrations/098_story_threads.sql
\ir ../../../supabase/migrations/099_cluster_merge.sql
\ir ../../../supabase/migrations/099_cluster_merge.sql

-- Seed ---------------------------------------------------------------------------
insert into public.sources (id, slug, name, bias, kind) values
  ('00000000-0000-4000-8000-0000000000a1', 'g1', 'G1', 'pro_government', 'outlet'),
  ('00000000-0000-4000-8000-0000000000a2', 'g2', 'G2', 'gov_leaning', 'outlet'),
  ('00000000-0000-4000-8000-0000000000a3', 'g3', 'G3', 'state_media', 'wire'),
  ('00000000-0000-4000-8000-0000000000a4', 'g4', 'G4', 'nationalist', 'outlet'),
  ('00000000-0000-4000-8000-0000000000a5', 'g5', 'G5', 'islamist_conservative', 'outlet'),
  ('00000000-0000-4000-8000-0000000000b1', 'o1', 'O1', 'opposition', 'outlet'),
  ('00000000-0000-4000-8000-0000000000b2', 'o2', 'O2', 'opposition_leaning', 'outlet'),
  ('00000000-0000-4000-8000-0000000000c1', 'ag', 'AG', 'center', 'aggregator');

-- Articles: five gov-side (T), two opposition + one aggregator (S only); the first gov article (a001) is shared by T, S and P.
insert into public.articles (id, source_id, title, published_at) values
  ('00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-0000000000a1', 't1', '2026-09-10 10:00+00'),
  ('00000000-0000-4000-8000-00000000a002', '00000000-0000-4000-8000-0000000000a2', 't2', '2026-09-10 10:05+00'),
  ('00000000-0000-4000-8000-00000000a003', '00000000-0000-4000-8000-0000000000a3', 't3', '2026-09-10 10:10+00'),
  ('00000000-0000-4000-8000-00000000a004', '00000000-0000-4000-8000-0000000000a4', 't4', '2026-09-10 10:15+00'),
  ('00000000-0000-4000-8000-00000000a005', '00000000-0000-4000-8000-0000000000a5', 't5', '2026-09-10 10:20+00'),
  ('00000000-0000-4000-8000-00000000b001', '00000000-0000-4000-8000-0000000000b1', 's1', '2026-09-10 08:00+00'), -- earliest overall
  ('00000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-0000000000b2', 's2', '2026-09-10 09:00+00'),
  ('00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-0000000000c1', 'ag', '2026-09-10 09:30+00');

insert into public.clusters (id, title_tr, article_count, updated_at, first_published) values
  ('00000000-0000-4000-8000-0000000000e1', 'Mansur Yavaş sonrası CHP''de deprem: 5 belediye başkanı daha', 0, '2026-09-12 12:00+00', '2026-09-10 10:00+00'),
  ('00000000-0000-4000-8000-0000000000e2', 'Mansur Yavaş sonrası CHP''de deprem: 2 belediye başkanı daha', 0, '2026-09-13 12:00+00', '2026-09-10 08:00+00'),
  ('00000000-0000-4000-8000-0000000000e3', 'P tekil', 0, '2026-09-11 12:00+00', '2026-09-10 11:00+00');

-- T = e1, S = e2, P = e3
insert into public.cluster_articles (cluster_id, article_id) values
  ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000a001'),
  ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000a002'),
  ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000a003'),
  ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000a004'),
  ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000a005'),
  ('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-00000000b001'),
  ('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-00000000b002'),
  ('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-00000000c001'),
  ('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-00000000a001'), -- shared with T
  ('00000000-0000-4000-8000-0000000000e3', '00000000-0000-4000-8000-00000000a001'); -- P shares an article with S and T

insert into public.fact_checks (id) values ('00000000-0000-4000-8000-00000000f001');
insert into public.cluster_fact_checks (cluster_id, fact_check_id, score)
  values ('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-00000000f001', 0.900);

insert into public.story_threads (id) values ('00000000-0000-4000-8000-000000000a01');
insert into public.story_thread_members (thread_id, cluster_id)
  values ('00000000-0000-4000-8000-000000000a01', '00000000-0000-4000-8000-0000000000e2');
insert into public.story_thread_candidates (cluster_a, cluster_b, confidence, hours_apart, status)
  values ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000e2', 0.9, 1.0, 'pending');

-- Canonicalise the three clusters, then merge P -> S first (chain material).
select public.cluster_unlink_article(id, null) from public.clusters;

do $$
declare t public.clusters%rowtype;
begin
  select * into t from public.clusters where id = '00000000-0000-4000-8000-0000000000e1';
  if not t.is_blindspot or t.blindspot_side <> 'pro_government' or t.article_count <> 5 then
    raise exception 'seed: T should be a 5-source pro_government blindspot, got % % %', t.article_count, t.is_blindspot, t.blindspot_side;
  end if;
end $$;

-- Remember pre-merge timestamps (temp table survives the role switch).
create temp table before_state as
  select id, updated_at from public.clusters;
grant select on before_state to service_role;

grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant usage on schema supabase_migrations to service_role;

set role service_role;

select public.cluster_merge_atomic('00000000-0000-4000-8000-0000000000e3', '00000000-0000-4000-8000-0000000000e2', 'dryrun', 'manual');

-- Refresh the before-snapshot for S after the P merge touched it (S's updated_at is restored).
reset role;
do $$
declare s_before timestamptz; s_now timestamptz;
begin
  select updated_at into s_before from before_state where id = '00000000-0000-4000-8000-0000000000e2';
  select updated_at into s_now from public.clusters where id = '00000000-0000-4000-8000-0000000000e2';
  -- Target of the P merge is S: S.updated_at = greatest(S, P) = S (S is newer).
  if s_now <> s_before then raise exception 'P->S merge changed S.updated_at (% vs %)', s_now, s_before; end if;
end $$;

set role service_role;
select public.cluster_merge_atomic('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-0000000000e1', 'dryrun', 'thread') as merge_result;
reset role;

-- Assertions -------------------------------------------------------------------------
do $$
declare
  t public.clusters%rowtype;
  s public.clusters%rowtype;
  p public.clusters%rowtype;
  t_before timestamptz; s_before timestamptz;
  gov int; opp int; ctr int; lg record;
begin
  select * into t from public.clusters where id = '00000000-0000-4000-8000-0000000000e1';
  select * into s from public.clusters where id = '00000000-0000-4000-8000-0000000000e2';
  select * into p from public.clusters where id = '00000000-0000-4000-8000-0000000000e3';
  select updated_at into t_before from before_state where id = t.id;
  select updated_at into s_before from before_state where id = s.id;

  if t.article_count <> 8 then raise exception 'T.article_count % <> 8', t.article_count; end if;

  gov := (t.bias_distribution->>'pro_government')::int + (t.bias_distribution->>'gov_leaning')::int
       + (t.bias_distribution->>'state_media')::int + (t.bias_distribution->>'nationalist')::int
       + (t.bias_distribution->>'islamist_conservative')::int;
  opp := (t.bias_distribution->>'opposition')::int + (t.bias_distribution->>'opposition_leaning')::int;
  ctr := (t.bias_distribution->>'center')::int;
  if gov <> 5 or opp <> 2 or ctr <> 0 then raise exception 'T.bias_distribution wrong: %', t.bias_distribution; end if;

  if t.is_blindspot or t.blindspot_side is not null then
    raise exception 'T should no longer be a blindspot: % %', t.is_blindspot, t.blindspot_side;
  end if;

  if t.first_published <> '2026-09-10 08:00+00' then raise exception 'T.first_published %', t.first_published; end if;
  if t.updated_at <> greatest(t_before, s_before) then raise exception 'T.updated_at % <> %', t.updated_at, greatest(t_before, s_before); end if;

  if s.article_count <> 0 or not s.is_archived or s.merged_into <> t.id or s.is_blindspot or s.updated_at <> s_before then
    raise exception 'S state wrong: % % % % %', s.article_count, s.is_archived, s.merged_into, s.is_blindspot, s.updated_at;
  end if;
  if p.merged_into is distinct from t.id then raise exception 'P chain not flattened: %', p.merged_into; end if;

  if exists (select 1 from public.cluster_fact_checks where cluster_id = s.id) then raise exception 'fact check still on S'; end if;
  if not exists (select 1 from public.cluster_fact_checks where cluster_id = t.id) then raise exception 'fact check not on T'; end if;
  if not exists (select 1 from public.story_thread_members where cluster_id = t.id) then raise exception 'thread member not moved'; end if;
  if exists (select 1 from public.story_thread_members where cluster_id = s.id) then raise exception 'thread member left on S'; end if;
  if exists (select 1 from public.story_thread_candidates where status = 'pending' and (cluster_a = s.id or cluster_b = s.id)) then
    raise exception 'pending (S,T) candidate not deleted';
  end if;

  -- The log has the P->S merge and this one; check this one.
  select * into lg from public.cluster_merge_log where source_id = s.id;
  if (select count(*) from public.cluster_merge_log where source_id = s.id) <> 1 then raise exception 'expected 1 log row for S'; end if;
  if lg.moved <> 3 or lg.duplicates <> 1 then raise exception 'log moved/duplicates wrong: % %', lg.moved, lg.duplicates; end if;
  if lg.target_count_before <> 5 or lg.target_count_after <> 8 then raise exception 'log counts wrong: % -> %', lg.target_count_before, lg.target_count_after; end if;
  if not lg.target_blindspot_before or lg.target_blindspot_after then raise exception 'log blindspot flags wrong'; end if;
  if lg.actor <> 'dryrun' or lg.origin <> 'thread' then raise exception 'log actor/origin wrong'; end if;
end $$;

-- Idempotency ----------------------------------------------------------------------------
create temp table t_after as select updated_at from public.clusters where id = '00000000-0000-4000-8000-0000000000e1';

set role service_role;
create temp table second_call as
  select public.cluster_merge_atomic('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-0000000000e1', 'dryrun', 'thread') as r;
reset role;

do $$
declare r jsonb;
begin
  select sc.r into r from second_call sc;
  if (r->>'resweep')::boolean is not true or (r->>'moved')::int <> 0 then raise exception 'second call not a resweep: %', r; end if;
  if (select count(*) from public.cluster_merge_log where source_id = '00000000-0000-4000-8000-0000000000e2') <> 1 then raise exception 'log grew on resweep'; end if;
  if (select updated_at from public.clusters where id = '00000000-0000-4000-8000-0000000000e1') <> (select updated_at from t_after) then
    raise exception 'T.updated_at changed on resweep';
  end if;
end $$;

-- Guards -----------------------------------------------------------------------------------
insert into public.clusters (id, title_tr, article_count) values
  ('00000000-0000-4000-8000-0000000000f1', 'X', 0),
  ('00000000-0000-4000-8000-0000000000f2', 'Y', 0),
  ('00000000-0000-4000-8000-0000000000f3', 'Z archived', 0);
update public.clusters set is_archived = true where id = '00000000-0000-4000-8000-0000000000f3';

create or replace function pg_temp.expect_err(p_sql text, p_code text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'expected % but the call succeeded', p_code;
exception when others then
  if sqlerrm <> p_code then raise exception 'expected % got %', p_code, sqlerrm; end if;
end $$;

set role service_role;
select pg_temp.expect_err($q$select public.cluster_merge_atomic('00000000-0000-4000-8000-0000000000e1','00000000-0000-4000-8000-0000000000e1','a','manual')$q$, 'cluster_merge_self');
select pg_temp.expect_err($q$select public.cluster_merge_atomic('00000000-0000-4000-8000-0000000000f1','00000000-0000-4000-8000-0000000000e2','a','manual')$q$, 'cluster_merge_target_merged');
select pg_temp.expect_err($q$select public.cluster_merge_atomic('00000000-0000-4000-8000-0000000000e2','00000000-0000-4000-8000-0000000000f2','a','manual')$q$, 'cluster_merge_source_merged');
select pg_temp.expect_err($q$select public.cluster_merge_atomic('00000000-0000-4000-8000-0000000000f2','00000000-0000-4000-8000-0000000000f3','a','manual')$q$, 'cluster_merge_target_archived');
select pg_temp.expect_err($q$select public.cluster_merge_atomic('00000000-0000-4000-8000-0000000000f1', gen_random_uuid(),'a','manual')$q$, 'cluster_merge_not_found');
select pg_temp.expect_err($q$select public.cluster_merge_atomic('00000000-0000-4000-8000-0000000000f1','00000000-0000-4000-8000-0000000000f2','','manual')$q$, 'cluster_merge_bad_actor');
select pg_temp.expect_err($q$select public.cluster_merge_atomic('00000000-0000-4000-8000-0000000000f1','00000000-0000-4000-8000-0000000000f2','a','bogus')$q$, 'cluster_merge_bad_origin');
reset role;

-- Grants ------------------------------------------------------------------------------------
do $$
begin
  if has_function_privilege('anon', 'public.cluster_merge_atomic(uuid,uuid,text,text)', 'execute') then raise exception 'anon can execute merge'; end if;
  if has_function_privilege('authenticated', 'public.cluster_merge_atomic(uuid,uuid,text,text)', 'execute') then raise exception 'authenticated can execute merge'; end if;
  if not has_function_privilege('service_role', 'public.cluster_merge_atomic(uuid,uuid,text,text)', 'execute') then raise exception 'service_role cannot execute merge'; end if;
  if has_table_privilege('anon', 'public.cluster_merge_log', 'select') or has_table_privilege('anon', 'public.cluster_merge_log', 'insert')
     or has_table_privilege('anon', 'public.cluster_merge_dismissals', 'select') or has_table_privilege('anon', 'public.cluster_merge_dismissals', 'insert')
     or has_table_privilege('authenticated', 'public.cluster_merge_log', 'select') or has_table_privilege('authenticated', 'public.cluster_merge_dismissals', 'insert') then
    raise exception 'anon/authenticated hold a privilege on the merge tables';
  end if;
  if not has_column_privilege('anon', 'public.clusters', 'merged_into', 'select') then raise exception 'anon cannot read clusters.merged_into'; end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '099') <> 1 then raise exception '099 schema_migrations row missing or duplicated'; end if;
end $$;

select 'DRYRUN 099 OK';
