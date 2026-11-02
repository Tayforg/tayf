-- 150 ops_health_report() rows 18 (queue_lag) and 19 (cron_jobs_stalled) and public.ops_cron_expected:
-- local PG15 dry-run. Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=/private/tmp/claude-501/-Users-fatihhekimoglu/1acb1ff4-979e-4aaa-8131-2db2e1d46641/scratchpad/pg-150-a   # pg-150-b and port 55560 for the second run
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55550 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55550 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f /Users/fatihhekimoglu/.claude/jobs/c644d1b7/tmp/jevtest/qa/stub.sql -f tests/migrations/sql/150-ops-queue-cron-liveness-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql PGHOST=/tmp PGPORT=55550 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/150-ops-queue-cron-liveness)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
--
-- (\ir paths below are relative to this file.) Every check is a DO block or a pg_temp function
-- that raises on mismatch, so a clean run ending in "DRYRUN 150 OK" is the pass. Every scenario
-- that writes sits inside begin ... rollback.
--
-- Order: the shapes the report reads, then 114, 115, 119, 122, 136 and 145 (the production
-- history of the function), the post-117 privilege state, 145's rows 1-17 captured, 150 applied,
-- an operator's tuning, 150 applied AGAIN, then the scenarios.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Prelude A: columns and tables the report reads that the stub does not carry. -------------
alter table public.articles add column if not exists created_at timestamptz not null default now();
alter table public.articles add column if not exists content_hash text;
alter table public.sources add column if not exists fetch_last_status int;
alter table public.sources add column if not exists fetch_fail_streak integer not null default 0;
alter table public.sources add column if not exists fetch_quarantined_until timestamptz;

create table if not exists public.ingest_cycles (
  id bigint generated always as identity primary key,
  started_at timestamptz not null,
  finished_at timestamptz not null default now(),
  fetched int, inserted int, row_errors int, failed int, duration_ms int
);
create table if not exists public.jev_shadow_runs (
  id bigserial primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  calls integer not null default 0,
  input_tokens integer not null default 0,
  errors integer not null default 0,
  status text not null default 'running',
  note text
);
create table if not exists public.jev_alerts (
  id bigserial primary key,
  kind text not null,
  day date not null,
  subject text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  resolved_at timestamptz
);

-- Prelude B: stand-ins for pg_cron, pg_net and pgmq (no extension is installed locally). --------
create schema if not exists cron;
create table cron.job (
  jobid bigserial primary key, jobname text, schedule text, command text, active boolean not null default true
);
create table cron.job_run_details (
  runid bigserial primary key, jobid bigint, status text, start_time timestamptz, end_time timestamptz,
  command text, return_message text
);
create schema if not exists net;
create table net._http_response (
  id bigint, status_code integer, content_type text, headers jsonb, content text,
  timed_out boolean, error_msg text, created timestamptz not null default now()
);
create schema if not exists pgmq;
create table pgmq.q_cluster_work (
  msg_id bigserial primary key, read_ct integer not null default 0, enqueued_at timestamptz not null default now(),
  vt timestamptz not null default now(), message jsonb, headers jsonb
);
create table pgmq.q_image_backfill (like pgmq.q_cluster_work including all);
create table pgmq.a_cluster_work (
  msg_id bigint primary key, read_ct integer not null default 0, enqueued_at timestamptz not null default now(),
  archived_at timestamptz not null default now(), vt timestamptz not null default now(), message jsonb, headers jsonb
);
create table pgmq.a_image_backfill (like pgmq.a_cluster_work including all);
create index archived_at_idx_cluster_work on pgmq.a_cluster_work (archived_at);
create index archived_at_idx_image_backfill on pgmq.a_image_backfill (archived_at);

-- Prelude C: the production history of ops_health_report() (the order production applied them). --
\ir ../../../supabase/migrations/114_sources_newly_dark.sql
\ir ../../../supabase/migrations/115_sources_newly_dark_24h.sql
\ir ../../../supabase/migrations/119_feed_freshness.sql
\ir ../../../supabase/migrations/122_ops_ingest_gaps.sql
\ir ../../../supabase/migrations/136_ops_heartbeat_app_side.sql
\ir ../../../supabase/migrations/145_ops_anon_surface_check.sql

-- The deployed body is the one 150 starts from: 145's fingerprint (production md5 fa5581a2e5edd98ce214b9621ecef7a4).
do $$
declare v_md5 text; v_len int;
begin
  select md5(prosrc), length(prosrc) into v_md5, v_len from pg_proc where oid = 'public.ops_health_report()'::regprocedure;
  if v_md5 <> 'fa5581a2e5edd98ce214b9621ecef7a4' or v_len <> 30774 then
    raise exception 'the local 145 body differs from production (md5 gate): % / %', v_md5, v_len;
  end if;
end $$;

-- Prelude D: the post-117 privilege state (nothing for anon/authenticated on what exists), then the
-- Supabase default privileges, so that 150's new table starts out exposed and its revokes have
-- something to undo. -------------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated, public;
revoke all on all sequences in schema public from anon, authenticated, public;
revoke execute on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;

-- A healthy cron stub: the expected jobs (read from 150's seed list below) plus the four jobs the
-- older rows look at; every job active with a succeeded run a minute ago.
create function pg_temp.cron_healthy() returns void language plpgsql as $$
begin
  delete from cron.job_run_details;
  delete from cron.job;
  insert into cron.job (jobname, schedule, command, active)
    select n, '* * * * *', 'select net.http_post(''https://x.invalid'', ''SECRET-COMMAND'')', true
      from unnest(array['cluster-drain', 'ingest-drain', 'image-drain', 'kap-drain', 'ops-health-snapshot',
                        'cluster-topics-refresh', 'framing-candidate-pool-refresh', 'source-karne-refresh',
                        'net-response-compact', 'articles-vacuum', 'trends-rollup-refresh', 'weekly-words-sample',
                        'cron-log-compact', 'image-backfill-requeue', 'clusters-vacuum', 'prune-nightly',
                        'reader-data-purge', 'ops-exhaust-prune', 'jev-shadow-prune', 'ops-cron-route-runs-prune',
                        'jev-shadow', 'jev-cluster-audit', 'jev-regression-weekly', 'blindspot-recall-veto']) n;
  insert into cron.job_run_details (jobid, status, start_time, end_time, command, return_message)
    select jobid, 'succeeded', now() - interval '1 minute', now() - interval '59 seconds', 'SECRET-COMMAND', 'SECRET-RETURN'
      from cron.job;
end $$;

select pg_temp.cron_healthy();
insert into net._http_response (status_code, created) select 200, now() - interval '1 minute' from generate_series(1, 10);
insert into public.ingest_cycles (started_at, finished_at) select now() - g * interval '3 minutes', now() - g * interval '3 minutes' + interval '20 seconds' from generate_series(1, 12) g;

-- Rows 1-17 under 145: name, order and status are what 150 must keep. ----------------------------
create temp table base145 as
  select t.n, t.check_name, t.status
    from public.ops_health_report() with ordinality as t(check_name, status, observed, threshold, detail, n);

do $$
begin
  if (select count(*) from base145) <> 17 then raise exception '145 should return 17 rows, got %', (select count(*) from base145); end if;
  if (select status from base145 where check_name = 'anon_surface') <> 'pass' then
    raise exception 'the post-117 baseline should read anon_surface pass, got %', (select status from base145 where check_name = 'anon_surface');
  end if;
end $$;

-- Apply 150: first time, an operator tunes one row, then AGAIN (the re-apply must keep the tuning). ----
\ir ../../../supabase/migrations/150_ops_queue_and_cron_liveness.sql

update public.ops_cron_expected set max_gap = interval '77 minutes' where jobname = 'cluster-drain';
delete from public.ops_cron_expected where jobname = 'jev-shadow-prune';

\ir ../../../supabase/migrations/150_ops_queue_and_cron_liveness.sql

-- Re-apply semantics: one ledger row, the tuning kept, the deleted row seeded back (on conflict do nothing
-- only skips rows that exist), the seed count 20.
do $$
begin
  if (select count(*) from supabase_migrations.schema_migrations where version = '150') <> 1 then
    raise exception 'the ledger should hold one 150 row';
  end if;
  if (select name from supabase_migrations.schema_migrations where version = '150') <> '150_ops_queue_and_cron_liveness' then
    raise exception 'the ledger name is wrong';
  end if;
  if (select max_gap from public.ops_cron_expected where jobname = 'cluster-drain') <> interval '77 minutes' then
    raise exception 're-applying 150 overwrote an operator tuning';
  end if;
  if (select count(*) from public.ops_cron_expected) <> 20 then
    raise exception 'the seed should hold 20 jobs, got %', (select count(*) from public.ops_cron_expected);
  end if;
  if (select max_gap from public.ops_cron_expected where jobname = 'jev-shadow-prune') <> interval '26 hours' then
    raise exception 'the deleted seed row did not come back with its 26 h gap';
  end if;
end $$;
update public.ops_cron_expected set max_gap = interval '10 minutes' where jobname = 'cluster-drain';

-- The new function: fingerprint, flags, ACL, comment. ------------------------------------------------
do $$
declare f record;
begin
  select p.prosecdef, p.provolatile, p.proconfig, p.proacl::text as acl, length(p.prosrc) as len,
         obj_description(p.oid, 'pg_proc') as cmt
    into f from pg_proc p where p.oid = 'public.ops_health_report()'::regprocedure;
  if not f.prosecdef or f.provolatile <> 'v' or f.proconfig is distinct from array['search_path=""'] then
    raise exception 'function flags changed: % % %', f.prosecdef, f.provolatile, f.proconfig;
  end if;
  if f.acl is distinct from '{postgres=X/postgres,service_role=X/postgres}' then raise exception 'function ACL is %', f.acl; end if;
  if f.cmt not like '%19 fixed rows%' or f.cmt not like '%queue_lag%' or f.cmt not like '%cron_jobs_stalled%' then
    raise exception 'function comment not updated';
  end if;
  if has_function_privilege('anon', 'public.ops_health_report()', 'execute')
     or has_function_privilege('authenticated', 'public.ops_health_report()', 'execute')
     or not has_function_privilege('service_role', 'public.ops_health_report()', 'execute') then
    raise exception 'function privileges are wrong';
  end if;
end $$;

-- The table's surface. ---------------------------------------------------------------------------------
do $$
declare privs text := 'select,insert,update,delete,truncate,references,trigger';
begin
  if has_table_privilege('anon', 'public.ops_cron_expected', privs)
     or has_table_privilege('authenticated', 'public.ops_cron_expected', privs) then
    raise exception 'anon or authenticated holds a privilege on ops_cron_expected';
  end if;
  if has_table_privilege('anon', 'public.ops_cron_expected', 'select') then raise exception 'anon can select'; end if;
  if not has_table_privilege('service_role', 'public.ops_cron_expected', 'select')
     or has_table_privilege('service_role', 'public.ops_cron_expected', 'insert,update,delete,truncate') then
    raise exception 'service_role should hold select only';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.ops_cron_expected'::regclass) then
    raise exception 'row level security is off';
  end if;
  if (select count(*) from pg_policy where polrelid = 'public.ops_cron_expected'::regclass) <> 0 then
    raise exception 'a policy exists';
  end if;
  if exists (select 1 from pg_class c, aclexplode(c.relacl) a
              where c.oid = 'public.ops_cron_expected'::regclass
                and a.grantee in (to_regrole('anon')::oid, to_regrole('authenticated')::oid)) then
    raise exception 'an ACL entry names anon or authenticated';
  end if;
end $$;

-- Rows 1-17 keep their names, order and status; 18 and 19 are appended in that order. ------------------
do $$
begin
  if (select count(*) from public.ops_health_report()) <> 19 then raise exception '150 should return 19 rows'; end if;
  if exists (
    select 1
      from (select t.n, t.check_name, t.status
              from public.ops_health_report() with ordinality as t(check_name, status, observed, threshold, detail, n)
             where t.n <= 17) a
      full join base145 b on b.n = a.n
     where a.check_name is distinct from b.check_name or a.status is distinct from b.status
  ) then
    raise exception 'rows 1-17 differ from 145 (name, order or status)';
  end if;
  if (select check_name from public.ops_health_report() with ordinality as t(check_name, status, observed, threshold, detail, n) where n = 18) <> 'queue_lag'
     or (select check_name from public.ops_health_report() with ordinality as t(check_name, status, observed, threshold, detail, n) where n = 19) <> 'cron_jobs_stalled' then
    raise exception 'rows 18 and 19 are not queue_lag and cron_jobs_stalled';
  end if;
  -- the privilege check still reads pass: the new table is not exposed
  if (select status from public.ops_health_report() where check_name = 'anon_surface') <> 'pass' then
    raise exception 'anon_surface no longer passes: %', (select detail from public.ops_health_report() where check_name = 'anon_surface');
  end if;
end $$;

-- Scenario helpers. ---------------------------------------------------------------------------------------
create function pg_temp.expect_row(p_check text, p_status text, p_observed numeric, p_detail text)
returns void language plpgsql as $$
declare r record;
begin
  select * into r from public.ops_health_report() where check_name = p_check;
  if r.status is distinct from p_status then
    raise exception '%: status % (wanted %), observed %, detail %', p_check, r.status, p_status, r.observed, r.detail;
  end if;
  if p_observed is not null and r.observed is distinct from p_observed then
    raise exception '%: observed % (wanted %), detail %', p_check, r.observed, p_observed, r.detail;
  end if;
  if p_detail is not null and r.detail is distinct from p_detail then
    raise exception '%: detail "%" (wanted "%")', p_check, r.detail, p_detail;
  end if;
end $$;

create function pg_temp.q_add(p_queue text, p_age interval, p_vt_in interval default interval '-1 second', p_n integer default 1)
returns void language plpgsql as $$
begin
  execute format('insert into pgmq.q_%s (enqueued_at, vt) select now() - %L::interval, now() + %L::interval from generate_series(1, %s)',
                 p_queue, p_age, p_vt_in, p_n);
end $$;

create function pg_temp.a_add(p_queue text, p_read_ct integer, p_ago interval)
returns void language plpgsql as $$
begin
  execute format('insert into pgmq.a_%s (msg_id, read_ct, archived_at) values ((select coalesce(max(msg_id), 0) + 1 from pgmq.a_%s), %s, now() - %L::interval)',
                 p_queue, p_queue, p_read_ct, p_ago);
end $$;

-- queue_lag ----------------------------------------------------------------------------------------------
begin;  -- empty queues
select pg_temp.cron_healthy();
select pg_temp.expect_row('queue_lag', 'pass', 0, 'cluster_work: 0 mesaj, en eski 0 sn · image_backfill: 0 mesaj, en eski 0 sn · zehirli (24 sa): 0');
select pg_temp.expect_row('cron_jobs_stalled', 'pass', 0, '20 iş izleniyor');
rollback;

begin;  -- a visible cluster_work message 20 minutes old
select pg_temp.q_add('cluster_work', interval '20 minutes');
select pg_temp.expect_row('queue_lag', 'fail', 1200, 'cluster_work: 1 mesaj, en eski 1200 sn · image_backfill: 0 mesaj, en eski 0 sn · zehirli (24 sa): 0');
rollback;

begin;  -- 8 minutes: warn
select pg_temp.q_add('cluster_work', interval '8 minutes');
select pg_temp.expect_row('queue_lag', 'warn', 480, null);
rollback;

begin;  -- 4 minutes: pass
select pg_temp.q_add('cluster_work', interval '4 minutes');
select pg_temp.expect_row('queue_lag', 'pass', 240, null);
rollback;

begin;  -- boundaries: 300 s pass, 301 s warn, 900 s warn, 901 s fail
select pg_temp.q_add('cluster_work', interval '300 seconds');
select pg_temp.expect_row('queue_lag', 'pass', 300, null);
rollback;
begin;
select pg_temp.q_add('cluster_work', interval '301 seconds');
select pg_temp.expect_row('queue_lag', 'warn', 301, null);
rollback;
begin;
select pg_temp.q_add('cluster_work', interval '900 seconds');
select pg_temp.expect_row('queue_lag', 'warn', 900, null);
rollback;
begin;
select pg_temp.q_add('cluster_work', interval '901 seconds');
select pg_temp.expect_row('queue_lag', 'fail', 901, null);
rollback;

begin;  -- an in-flight message (vt in the future) does not age the queue, but counts toward the depth
select pg_temp.q_add('cluster_work', interval '1 hour', interval '30 seconds');
select pg_temp.expect_row('queue_lag', 'pass', 0, 'cluster_work: 1 mesaj, en eski 0 sn · image_backfill: 0 mesaj, en eski 0 sn · zehirli (24 sa): 0');
rollback;

begin;  -- depth 301 of fresh messages: warn; 300: pass
select pg_temp.q_add('cluster_work', interval '5 seconds', interval '-1 second', 301);
select pg_temp.expect_row('queue_lag', 'warn', 5, null);
rollback;
begin;
select pg_temp.q_add('cluster_work', interval '5 seconds', interval '-1 second', 300);
select pg_temp.expect_row('queue_lag', 'pass', 5, null);
rollback;

begin;  -- image_backfill: 30 min pass, 31 min warn, 61 min fail
select pg_temp.q_add('image_backfill', interval '30 minutes');
select pg_temp.expect_row('queue_lag', 'pass', 0, 'cluster_work: 0 mesaj, en eski 0 sn · image_backfill: 1 mesaj, en eski 1800 sn · zehirli (24 sa): 0');
rollback;
begin;
select pg_temp.q_add('image_backfill', interval '31 minutes');
select pg_temp.expect_row('queue_lag', 'warn', 0, null);
rollback;
begin;
select pg_temp.q_add('image_backfill', interval '61 minutes');
select pg_temp.expect_row('queue_lag', 'fail', 0, 'cluster_work: 0 mesaj, en eski 0 sn · image_backfill: 1 mesaj, en eski 3660 sn · zehirli (24 sa): 0');
rollback;

begin;  -- poison: an archived message with read_ct 3 in the last 24 hours warns; read_ct 2 or 25 hours ago does not
select pg_temp.a_add('cluster_work', 3, interval '2 hours');
select pg_temp.expect_row('queue_lag', 'warn', 0, 'cluster_work: 0 mesaj, en eski 0 sn · image_backfill: 0 mesaj, en eski 0 sn · zehirli (24 sa): 1');
rollback;
begin;
select pg_temp.a_add('image_backfill', 7, interval '23 hours');
select pg_temp.expect_row('queue_lag', 'warn', 0, null);
rollback;
begin;
select pg_temp.a_add('cluster_work', 2, interval '2 hours');
select pg_temp.a_add('cluster_work', 9, interval '25 hours');
select pg_temp.expect_row('queue_lag', 'pass', 0, null);
rollback;

begin;  -- a stalled queue with a poison message still reads fail
select pg_temp.q_add('cluster_work', interval '20 minutes');
select pg_temp.a_add('image_backfill', 4, interval '1 hour');
select pg_temp.expect_row('queue_lag', 'fail', 1200, 'cluster_work: 1 mesaj, en eski 1200 sn · image_backfill: 0 mesaj, en eski 0 sn · zehirli (24 sa): 1');
rollback;

begin;  -- pgmq absent: unknown, no exception, the other eighteen rows are still returned
alter schema pgmq rename to pgmq_off;
select pg_temp.expect_row('queue_lag', 'unknown', null, 'pgmq kuyruğu yok');
do $$ begin
  if (select count(*) from public.ops_health_report()) <> 19 then raise exception 'the report should still return 19 rows'; end if;
  if (select observed from public.ops_health_report() where check_name = 'queue_lag') is not null then raise exception 'observed should be null'; end if;
end $$;
rollback;

begin;  -- an archive that errors on read: unknown with the error text, no exception
alter table pgmq.a_cluster_work drop column archived_at;
do $$ declare r record; begin
  select * into r from public.ops_health_report() where check_name = 'queue_lag';
  if r.status <> 'unknown' or r.detail not like '%archived_at%' then raise exception 'wanted unknown with the error text, got % / %', r.status, r.detail; end if;
end $$;
rollback;

begin;  -- a message payload never reaches the detail
insert into pgmq.q_cluster_work (enqueued_at, vt, message) values (now() - interval '20 minutes', now() - interval '1 second', '{"secret":"PAYLOAD-MARK"}');
do $$ declare r record; begin
  select * into r from public.ops_health_report() where check_name = 'queue_lag';
  if r.status <> 'fail' or r.detail like '%PAYLOAD-MARK%' or r.detail like '%secret%' then raise exception 'payload leaked or wrong status: % / %', r.status, r.detail; end if;
end $$;
rollback;

-- cron_jobs_stalled -----------------------------------------------------------------------------------------
begin;  -- every expected job present, active, a run one minute ago: pass
select pg_temp.cron_healthy();
select pg_temp.expect_row('cron_jobs_stalled', 'pass', 0, '20 iş izleniyor');
do $$ begin
  if (select threshold from public.ops_health_report() where check_name = 'cron_jobs_stalled') <> 1 then raise exception 'threshold should be 1'; end if;
end $$;
rollback;

begin;  -- one job set inactive: fail, its name in the detail
select pg_temp.cron_healthy();
update cron.job set active = false where jobname = 'cluster-drain';
select pg_temp.expect_row('cron_jobs_stalled', 'fail', 1, 'pasif: cluster-drain');
rollback;

begin;  -- one job's runs deleted: fail
select pg_temp.cron_healthy();
delete from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'image-drain');
select pg_temp.expect_row('cron_jobs_stalled', 'fail', 1, 'koşu yok: image-drain');
rollback;

begin;  -- one job deleted from cron.job (unscheduled): fail
select pg_temp.cron_healthy();
delete from cron.job where jobname = 'prune-nightly';
select pg_temp.expect_row('cron_jobs_stalled', 'fail', 1, 'yok: prune-nightly');
rollback;

begin;  -- a job whose newest run is older than its max_gap: stale; just inside the gap: pass; a daily job after 25 h: pass, 27 h: fail
select pg_temp.cron_healthy();
update cron.job_run_details set start_time = now() - interval '11 minutes' where jobid = (select jobid from cron.job where jobname = 'cluster-drain');
select pg_temp.expect_row('cron_jobs_stalled', 'fail', 1, 'koşu yok: cluster-drain');
update cron.job_run_details set start_time = now() - interval '9 minutes' where jobid = (select jobid from cron.job where jobname = 'cluster-drain');
select pg_temp.expect_row('cron_jobs_stalled', 'pass', 0, null);
update cron.job_run_details set start_time = now() - interval '25 hours' where jobid = (select jobid from cron.job where jobname = 'prune-nightly');
select pg_temp.expect_row('cron_jobs_stalled', 'pass', 0, null);
update cron.job_run_details set start_time = now() - interval '27 hours' where jobid = (select jobid from cron.job where jobname = 'prune-nightly');
select pg_temp.expect_row('cron_jobs_stalled', 'fail', 1, 'koşu yok: prune-nightly');
rollback;

begin;  -- the newest run of one job failed: warn
select pg_temp.cron_healthy();
update cron.job_run_details set status = 'failed' where jobid = (select jobid from cron.job where jobname = 'ingest-drain');
select pg_temp.expect_row('cron_jobs_stalled', 'warn', 1, 'son koşu başarısız: ingest-drain');
rollback;

begin;  -- a failed run OLDER than a succeeded one is not a warn
select pg_temp.cron_healthy();
insert into cron.job_run_details (runid, jobid, status, start_time)
  select (select min(runid) from cron.job_run_details) - 1, jobid, 'failed', now() - interval '5 minutes' from cron.job where jobname = 'ingest-drain';
select pg_temp.expect_row('cron_jobs_stalled', 'pass', 0, null);
rollback;

begin;  -- a run that is still running counts as a run
select pg_temp.cron_healthy();
update cron.job_run_details set status = 'running', end_time = null where jobid = (select jobid from cron.job where jobname = 'kap-drain');
select pg_temp.expect_row('cron_jobs_stalled', 'pass', 0, null);
rollback;

begin;  -- several problems at once: fail counts missing + inactive + stale; the failed job is listed too
select pg_temp.cron_healthy();
delete from cron.job where jobname = 'prune-nightly';
update cron.job set active = false where jobname in ('kap-drain', 'cluster-drain');
delete from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'image-drain');
update cron.job_run_details set status = 'failed' where jobid = (select jobid from cron.job where jobname = 'ingest-drain');
select pg_temp.expect_row('cron_jobs_stalled', 'fail', 4, 'yok: prune-nightly · pasif: cluster-drain, kap-drain · koşu yok: image-drain · son koşu başarısız: ingest-drain');
rollback;

begin;  -- the runid window: a run at max(runid) - 7000 is outside, at max(runid) - 6999 inside
select pg_temp.cron_healthy();
delete from cron.job_run_details;
insert into cron.job_run_details (runid, jobid, status, start_time)
  select 3000000 + j.jobid, j.jobid, 'succeeded', now() - interval '1 minute' from cron.job j where j.jobname <> 'cluster-drain';
insert into cron.job_run_details (runid, jobid, status, start_time)
  select (select max(runid) from cron.job_run_details) - 7000, j.jobid, 'succeeded', now() - interval '1 minute' from cron.job j where j.jobname = 'cluster-drain';
select pg_temp.expect_row('cron_jobs_stalled', 'fail', 1, 'koşu yok: cluster-drain');
rollback;
begin;
select pg_temp.cron_healthy();
delete from cron.job_run_details;
insert into cron.job_run_details (runid, jobid, status, start_time)
  select 3000000 + j.jobid, j.jobid, 'succeeded', now() - interval '1 minute' from cron.job j where j.jobname <> 'cluster-drain';
insert into cron.job_run_details (runid, jobid, status, start_time)
  select (select max(runid) from cron.job_run_details) - 6999, j.jobid, 'succeeded', now() - interval '1 minute' from cron.job j where j.jobname = 'cluster-drain';
select pg_temp.expect_row('cron_jobs_stalled', 'pass', 0, '20 iş izleniyor');
rollback;

begin;  -- the operator's levers: delete a row to stop watching a job; tighten max_gap to make a job stale
select pg_temp.cron_healthy();
delete from public.ops_cron_expected where jobname = 'cluster-drain';
delete from cron.job where jobname = 'cluster-drain';
select pg_temp.expect_row('cron_jobs_stalled', 'pass', 0, '19 iş izleniyor');
rollback;
begin;
select pg_temp.cron_healthy();
update public.ops_cron_expected set max_gap = interval '30 seconds' where jobname = 'cluster-drain';
select pg_temp.expect_row('cron_jobs_stalled', 'fail', 1, 'koşu yok: cluster-drain');
rollback;
begin;  -- an empty table is a pass with nothing to watch
select pg_temp.cron_healthy();
delete from public.ops_cron_expected;
select pg_temp.expect_row('cron_jobs_stalled', 'pass', 0, '0 iş izleniyor');
rollback;

begin;  -- pg_cron absent: unknown, no exception
alter schema cron rename to cron_off;
select pg_temp.expect_row('cron_jobs_stalled', 'unknown', null, 'pg_cron yok');
do $$ begin
  if (select count(*) from public.ops_health_report()) <> 19 then raise exception 'the report should still return 19 rows'; end if;
end $$;
rollback;

begin;  -- the table absent: unknown, no exception
drop table public.ops_cron_expected;
select pg_temp.expect_row('cron_jobs_stalled', 'unknown', null, 'ops_cron_expected yok');
rollback;

begin;  -- the secret-bearing columns never reach the detail, even for a failing job
select pg_temp.cron_healthy();
update cron.job_run_details set status = 'failed', return_message = 'SECRET-RETURN https://x.invalid/key=abc'
 where jobid = (select jobid from cron.job where jobname = 'ingest-drain');
do $$ declare r record; begin
  select * into r from public.ops_health_report() where check_name = 'cron_jobs_stalled';
  if r.status <> 'warn' or r.detail ~ 'SECRET|https|key=abc|http_post' then raise exception 'secret leaked or wrong status: % / %', r.status, r.detail; end if;
end $$;
rollback;

begin;  -- anon cannot read the table or call the report; the check constraint rejects a non-positive gap
do $$ begin
  set local role anon;
  begin
    perform 1 from public.ops_cron_expected;
    raise exception 'anon read ops_cron_expected';
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.ops_health_report();
    raise exception 'anon called ops_health_report';
  exception when insufficient_privilege then null;
  end;
  reset role;
  begin
    insert into public.ops_cron_expected (jobname, max_gap) values ('zz-test', interval '0');
    raise exception 'a zero gap was accepted';
  exception when check_violation then null;
  end;
end $$;
rollback;

-- Nothing is left behind. -------------------------------------------------------------------------------------
do $$
begin
  if (select count(*) from public.ops_cron_expected) <> 20 then raise exception 'the seed changed during the scenarios'; end if;
  if (select max_gap from public.ops_cron_expected where jobname = 'cluster-drain') <> interval '10 minutes' then
    raise exception 'the restored tuning is wrong';
  end if;
  if (select count(*) from pgmq.q_cluster_work) + (select count(*) from pgmq.a_cluster_work) <> 0 then
    raise exception 'a queue fixture leaked out of its transaction';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '150') <> 1 then
    raise exception 'the ledger should still hold one 150 row';
  end if;
end $$;

select 'DRYRUN 150 OK';
