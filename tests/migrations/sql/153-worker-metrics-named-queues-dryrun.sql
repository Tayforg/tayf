-- 153 worker_metrics_named_queues (hunt-28, h28-live-1): local PG15 dry-run. Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root). The servers listen on 127.0.0.1 only (no
-- unix socket: the scratchpad path is longer than a socket path may be):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55731 -c listen_addresses=127.0.0.1 -c unix_socket_directories=" -l $D/log -w start
--   $PGBIN/psql -h 127.0.0.1 -p 55731 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/153-worker-metrics-named-queues-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql PGHOST=127.0.0.1 PGPORT=55731 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/153-worker-metrics-named-queues)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh
--
-- (\ir paths below are relative to this file.) Every check is a DO block that raises on mismatch, so a
-- clean run ending in "DRYRUN 153 OK" is the pass. Every scenario that writes sits inside begin ... rollback.
--
-- Order: a pgmq stand-in modelled on pgmq 1.5.1 (production's version): metrics(text) and metrics_all()
-- are SECURITY INVOKER plpgsql, metrics() reads the queue table AND the queue's msg_id sequence AND calls
-- pgmq.format_table_name() with the CALLER's privileges, metrics_all() loops over pgmq.meta (so it touches
-- every queue). Then 024/048's grant model (service_role only, two queues), 024's view exactly as
-- production has it, 151's queue cluster_attach with nothing granted, the regression shown, 153 applied,
-- 153 applied AGAIN, then the checks.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Prelude A: the pgmq stand-in (no extension is installed locally). ------------------------------
create schema pgmq;
create table pgmq.meta (
  queue_name text primary key,
  is_partitioned boolean not null default false,
  is_unlogged boolean not null default false,
  created_at timestamptz not null default now()
);
-- pgmq 1.5.1's result type: seven columns, queue_visible_length last (production's viewdef lists it).
create type pgmq.metrics_result as (
  queue_name text, queue_length bigint, newest_msg_age_sec integer, oldest_msg_age_sec integer,
  total_messages bigint, scrape_time timestamptz, queue_visible_length bigint);

create function pgmq.format_table_name(queue_name text, prefix text) returns text
language plpgsql immutable as $$
begin
  return lower(prefix || '_' || queue_name);
end $$;

-- Like pgmq.create: the live table q_<name> (identity key, so the sequence is q_<name>_msg_id_seq), the
-- archive a_<name>, a meta row.
create function pgmq.create(queue_name text) returns void language plpgsql as $$
begin
  insert into pgmq.meta (queue_name) values (queue_name) on conflict do nothing;
  execute format(
    'create table if not exists pgmq.%I (msg_id bigint generated always as identity primary key, read_ct integer not null default 0, enqueued_at timestamptz not null default now(), vt timestamptz not null default now(), message jsonb, headers jsonb)',
    'q_' || queue_name);
  execute format(
    'create table if not exists pgmq.%I (msg_id bigint primary key, read_ct integer not null default 0, enqueued_at timestamptz not null default now(), archived_at timestamptz not null default now(), vt timestamptz not null default now(), message jsonb, headers jsonb)',
    'a_' || queue_name);
end $$;

-- pgmq.metrics(text): SECURITY INVOKER. The sequence comes first in the FROM list so that a caller without
-- privileges on the queue fails exactly as production's log shows ("permission denied for sequence
-- q_cluster_attach_msg_id_seq"). total_messages is the sequence's last_value; the ages count INVISIBLE
-- messages too (min(enqueued_at) over every row).
create function pgmq.metrics(queue_name text) returns pgmq.metrics_result language plpgsql as $$
declare
  result_row pgmq.metrics_result;
  qtable text := pgmq.format_table_name(queue_name, 'q');
begin
  execute format($q$
    select %L::text, q_summary.queue_length, q_summary.newest_msg_age_sec, q_summary.oldest_msg_age_sec,
           all_metrics.total_messages, q_summary.scrape_time, q_summary.queue_visible_length
      from (select case when is_called then last_value else 0 end as total_messages from pgmq.%I) all_metrics,
           (select count(*) as queue_length,
                   count(case when vt <= now() then 1 end) as queue_visible_length,
                   extract(epoch from (now() - max(enqueued_at)))::int as newest_msg_age_sec,
                   extract(epoch from (now() - min(enqueued_at)))::int as oldest_msg_age_sec,
                   now() as scrape_time
              from pgmq.%I) q_summary
  $q$, queue_name, qtable || '_msg_id_seq', qtable) into result_row;
  return result_row;
end $$;

-- pgmq.metrics_all(): loops over pgmq.meta, so it calls metrics() for EVERY queue, granted or not.
create function pgmq.metrics_all() returns setof pgmq.metrics_result language plpgsql as $$
declare
  row_name record;
  result_row pgmq.metrics_result;
begin
  for row_name in select m.queue_name from pgmq.meta m loop
    result_row := pgmq.metrics(row_name.queue_name);
    return next result_row;
  end loop;
end $$;

-- The queues that exist when 024/048 run.
select pgmq.create('cluster_work');
select pgmq.create('image_backfill');

-- Prelude B: 024 (section 4) and 048, as they leave production: the pgmq surface locked to service_role,
-- the two queues readable by it, then 024's view exactly as production defines it. -------------------
grant usage on schema public to anon, authenticated, service_role;
revoke all on schema pgmq from public, anon, authenticated;
grant usage on schema pgmq to service_role;
revoke all on all tables    in schema pgmq from public, anon, authenticated;
revoke all on all sequences in schema pgmq from public, anon, authenticated;
revoke all on all functions in schema pgmq from public, anon, authenticated;
do $$
declare fn_oid oid;
begin
  for fn_oid in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'pgmq' and p.proname in ('send', 'read', 'delete', 'archive', 'metrics', 'metrics_all', 'list_queues')
  loop
    execute format('grant execute on function %s to service_role', fn_oid::regprocedure);
  end loop;
end $$;
-- 048
grant select on table pgmq.meta to service_role;
grant execute on function pgmq.format_table_name(text, text) to service_role;
do $$
declare q text;
begin
  for q in select queue_name from pgmq.meta where queue_name in ('cluster_work', 'image_backfill') loop
    execute format('grant select on table pgmq.%I to service_role', 'q_' || q);
    execute format('grant select on sequence pgmq.%I to service_role', 'q_' || q || '_msg_id_seq');
  end loop;
end $$;

-- 024 section 5 (production's pg_get_viewdef: FROM pgmq.metrics_all() WHERE queue_name = ANY(...)).
create or replace view public.worker_metrics as
  select queue_name, queue_length, newest_msg_age_sec, oldest_msg_age_sec, total_messages, scrape_time
    from pgmq.metrics_all()
   where queue_name in ('cluster_work', 'image_backfill');
revoke all on public.worker_metrics from public, anon, authenticated;
grant select on public.worker_metrics to service_role;
-- Production's relacl on the view is {postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}
-- (STEP 0 a): service_role holds every privilege, a Supabase default privilege that 024 never revoked.
grant all on public.worker_metrics to service_role;

-- Prelude C: 151's queue, created AFTER 048, with nothing granted (the revokes of 151 section 1). ---
select pgmq.create('cluster_attach');
revoke all on pgmq.q_cluster_attach from public, anon, authenticated;
revoke all on pgmq.a_cluster_attach from public, anon, authenticated;
revoke all on sequence pgmq.q_cluster_attach_msg_id_seq from public, anon, authenticated;

insert into supabase_migrations.schema_migrations (version, name) values
  ('150', '150_ops_queue_and_cron_liveness'), ('151', '151_cluster_attach_probe'), ('152', '152_schema_parity')
  on conflict do nothing;

-- Messages, so the ages are not all null: an old visible one, an invisible one, a cluster_attach one.
insert into pgmq.q_cluster_work (enqueued_at, vt, message) values (now() - interval '10 minutes', now() - interval '10 minutes', '{"article_id": "w1"}');
insert into pgmq.q_image_backfill (enqueued_at, vt, message) values
  (now() - interval '25 minutes', now() - interval '25 minutes', '{"article_id": "i1"}'),
  (now() - interval '20 minutes', now() + interval '15 minutes', '{"article_id": "i2"}');
insert into pgmq.q_cluster_attach (enqueued_at, vt, message) values (now() - interval '3 minutes', now() - interval '3 minutes', '{"article_id": "c1"}');

-- Snapshots to compare after 153: the view's column list, and every ACL in the pgmq schema. --------
select string_agg(attname || ':' || format_type(atttypid, atttypmod), ',' order by attnum) as cols_before
  from pg_attribute where attrelid = 'public.worker_metrics'::regclass and attnum > 0 and not attisdropped \gset
select md5(coalesce(string_agg(c.relname || ':' || coalesce(c.relacl::text, ''), '|' order by c.relname), '')) as pgmq_rel_acl_before
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'pgmq' and c.relkind in ('r', 'S', 'v', 'c') \gset
select md5(coalesce(string_agg(p.oid::regprocedure::text || ':' || coalesce(p.proacl::text, ''), '|' order by p.oid::regprocedure::text), '')) as pgmq_fn_acl_before
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'pgmq' \gset
select coalesce(nspacl::text, '') as pgmq_nsp_acl_before from pg_namespace where nspname = 'pgmq' \gset
select relacl::text as view_acl_before from pg_class where oid = 'public.worker_metrics'::regclass \gset
-- psql does not expand :'var' inside a $$ ... $$ body, so the snapshots travel in custom settings.
select set_config('dry.cols_before', :'cols_before', false) as s1,
       set_config('dry.pgmq_rel_acl_before', :'pgmq_rel_acl_before', false) as s2,
       set_config('dry.pgmq_fn_acl_before', :'pgmq_fn_acl_before', false) as s3,
       set_config('dry.pgmq_nsp_acl_before', :'pgmq_nsp_acl_before', false) as s4,
       set_config('dry.view_acl_before', :'view_acl_before', false) as s5 \gset

-- ===== The regression, BEFORE 153 ==================================================================
\echo ===== before 153: select * from worker_metrics as service_role
begin;
set local role service_role;
do $$
begin
  begin
    perform count(*) from public.worker_metrics;
    raise exception 'expected 42501 before 153: worker_metrics should read cluster_attach through metrics_all()';
  exception when insufficient_privilege then
    -- production's postgres log: permission denied for sequence q_cluster_attach_msg_id_seq
    if sqlstate <> '42501' or sqlerrm !~ '^permission denied for (sequence|table) q_cluster_attach' then
      raise exception 'wrong error before 153: % (%)', sqlerrm, sqlstate;
    end if;
    raise notice 'REGRESSION (expected): % [%]', sqlerrm, sqlstate;
  end;
end $$;
rollback;

-- ===== 153 applied (apply 1) ======================================================================
\echo ===== 153 apply 1
\ir ../../../supabase/migrations/153_worker_metrics_named_queues.sql
\echo ===== 153 apply 1 done

-- ===== 153 applied AGAIN (apply 2): no error, the ledger insert is INSERT 0 0 ======================
\echo ===== 153 apply 2
\ir ../../../supabase/migrations/153_worker_metrics_named_queues.sql
\echo ===== 153 apply 2 done

-- ===== After ========================================================================================
\echo ===== after
select 'ledger', string_agg(version || ' ' || name, ' | ' order by version) from supabase_migrations.schema_migrations where version in ('152', '153');
select 'viewdef', pg_get_viewdef('public.worker_metrics'::regclass);
select 'columns', string_agg(attname || ':' || format_type(atttypid, atttypmod), ',' order by attnum)
  from pg_attribute where attrelid = 'public.worker_metrics'::regclass and attnum > 0 and not attisdropped;
select 'relacl', relacl::text, 'reloptions', coalesce(reloptions::text, '(null)') from pg_class where oid = 'public.worker_metrics'::regclass;
\echo ===== select * from worker_metrics as service_role (ages: cluster_work 600 s; image_backfill 1500 s, the invisible 1200 s one counts)
begin;
set local role service_role;
select queue_name, queue_length, newest_msg_age_sec, oldest_msg_age_sec, total_messages from public.worker_metrics order by queue_name;
rollback;

-- ===== Checks that raise ============================================================================
-- 1. Idempotence: one ledger row; the stored definition no longer mentions metrics_all and has both calls.
do $$
declare v_def text;
begin
  if (select count(*) from supabase_migrations.schema_migrations where version = '153') <> 1 then raise exception 'ledger 153 is not exactly one row'; end if;
  v_def := pg_get_viewdef('public.worker_metrics'::regclass);
  if v_def like '%metrics_all%' then raise exception 'the view still reads metrics_all: %', v_def; end if;
  if v_def not like '%metrics(''cluster_work''%' or v_def not like '%metrics(''image_backfill''%' then raise exception 'the view does not name both queues: %', v_def; end if;
  if v_def not like '%UNION ALL%' then raise exception 'the view is not a union all: %', v_def; end if;
end $$;

-- 2. The column list (names, types, order) is 024's, so PostgREST and /api/health see no change.
do $$
declare v_cols text;
begin
  select string_agg(attname || ':' || format_type(atttypid, atttypmod), ',' order by attnum) into v_cols
    from pg_attribute where attrelid = 'public.worker_metrics'::regclass and attnum > 0 and not attisdropped;
  if v_cols <> current_setting('dry.cols_before') then raise exception 'column list changed: % vs %', v_cols, current_setting('dry.cols_before'); end if;
  if v_cols <> 'queue_name:text,queue_length:bigint,newest_msg_age_sec:integer,oldest_msg_age_sec:integer,total_messages:bigint,scrape_time:timestamp with time zone' then
    raise exception 'unexpected column list: %', v_cols;
  end if;
end $$;

-- 3. The fix: as service_role, exactly 2 rows, the two named queues, no 42501, while cluster_attach exists and holds a message.
begin;
set local role service_role;
do $$
declare v_n bigint; v_names text; r record;
begin
  select count(*), string_agg(queue_name, ',' order by queue_name) into v_n, v_names from public.worker_metrics;
  if v_n <> 2 or v_names <> 'cluster_work,image_backfill' then raise exception 'worker_metrics returned % rows (%)', v_n, v_names; end if;
  select * into r from public.worker_metrics where queue_name = 'image_backfill';
  -- the invisible message (enqueued 20 min ago, visible in 15 min) is counted: depth 2, oldest 25 min
  if r.queue_length <> 2 or r.oldest_msg_age_sec not between 1499 and 1560 then
    raise exception 'image_backfill metrics wrong: %', r;
  end if;
  select * into r from public.worker_metrics where queue_name = 'cluster_work';
  if r.queue_length <> 1 or r.oldest_msg_age_sec not between 599 and 660 then raise exception 'cluster_work metrics wrong: %', r; end if;
end $$;
rollback;

-- 4. cluster_attach stays locked: 153 granted nothing on the pgmq schema (every ACL is byte-identical to the
--    snapshot taken before 153), service_role still cannot read the queue or its sequence, and the old
--    function path (metrics_all) still fails for service_role: the reason the view had to change.
do $$
begin
  if (select md5(coalesce(string_agg(c.relname || ':' || coalesce(c.relacl::text, ''), '|' order by c.relname), ''))
        from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'pgmq' and c.relkind in ('r', 'S', 'v', 'c')) <> current_setting('dry.pgmq_rel_acl_before') then
    raise exception '153 changed an ACL in the pgmq schema (relations)';
  end if;
  if (select md5(coalesce(string_agg(p.oid::regprocedure::text || ':' || coalesce(p.proacl::text, ''), '|' order by p.oid::regprocedure::text), ''))
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'pgmq') <> current_setting('dry.pgmq_fn_acl_before') then
    raise exception '153 changed an ACL in the pgmq schema (functions)';
  end if;
  if (select coalesce(nspacl::text, '') from pg_namespace where nspname = 'pgmq') <> current_setting('dry.pgmq_nsp_acl_before') then
    raise exception '153 changed the pgmq schema ACL';
  end if;
  if has_table_privilege('service_role', 'pgmq.q_cluster_attach', 'select') or has_table_privilege('service_role', 'pgmq.a_cluster_attach', 'select')
     or has_sequence_privilege('service_role', 'pgmq.q_cluster_attach_msg_id_seq', 'select') then
    raise exception 'service_role can read the cluster_attach queue';
  end if;
  if has_table_privilege('anon', 'pgmq.q_cluster_attach', 'select') or has_table_privilege('authenticated', 'pgmq.q_cluster_attach', 'select') then
    raise exception 'a client role can read the cluster_attach queue';
  end if;
end $$;
begin;
set local role service_role;
do $$
begin
  begin
    perform count(*) from pgmq.metrics_all();
    raise exception 'metrics_all() should still fail for service_role';
  exception when insufficient_privilege then
    raise notice 'metrics_all still fails for service_role (the reason for 153): % [%]', sqlerrm, sqlstate;
  end;
end $$;
rollback;

-- 5. The view's ACL is untouched by 153: byte-identical to production's shape; anon and authenticated hold
--    nothing and cannot read it.
do $$
begin
  if (select relacl::text from pg_class where oid = 'public.worker_metrics'::regclass) <> current_setting('dry.view_acl_before') then
    raise exception 'the ACL of the view changed: %', (select relacl::text from pg_class where oid = 'public.worker_metrics'::regclass);
  end if;
  if exists (select 1 from unnest(array['select','insert','update','delete','truncate','references','trigger']) p
              where has_table_privilege('anon', 'public.worker_metrics', p) or has_table_privilege('authenticated', 'public.worker_metrics', p)) then
    raise exception 'a client role holds a privilege on the view';
  end if;
  if exists (select 1 from pg_class c, aclexplode(c.relacl) a where c.oid = 'public.worker_metrics'::regclass and a.grantee = 0) then
    raise exception 'PUBLIC holds a privilege on the view';
  end if;
  if not has_table_privilege('service_role', 'public.worker_metrics', 'select') then raise exception 'service_role cannot select the view'; end if;
  if (select reloptions from pg_class where oid = 'public.worker_metrics'::regclass) is not null then raise exception 'the view has options'; end if;
end $$;
do $$
declare v_role text;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    execute format('set local role %I', v_role);
    begin
      perform count(*) from public.worker_metrics;
      raise exception '% can read the view', v_role;
    exception when insufficient_privilege then
      null;
    end;
    reset role;
  end loop;
end $$;

-- 6. The comment names the queues and the reason.
do $$
declare v_doc text;
begin
  v_doc := obj_description('public.worker_metrics'::regclass, 'pg_class');
  if v_doc is null or v_doc not like '%cluster_work%' or v_doc not like '%image_backfill%' or v_doc not like '%153%' then
    raise exception 'comment on the view missing or stale: %', v_doc;
  end if;
end $$;

\echo DRYRUN 153 OK
