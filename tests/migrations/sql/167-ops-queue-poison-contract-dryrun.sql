-- 167 ops_health_report() row 18 (queue_lag): poison is read_ct > 3, the consumers' MAX_READS contract:
-- local PG15 dry-run. Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55567 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55567 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/167-ops-queue-poison-contract-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql PGHOST=/tmp PGPORT=55567 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/167-ops-queue-poison-contract)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh
--
-- (\ir paths below are relative to this file.) Every check is a DO block or a pg_temp function that raises on
-- mismatch, so a clean run ending in "DRYRUN 167 OK" is the pass. Every scenario that writes (the fixtures in the
-- pgmq stand-in tables) sits inside begin ... rollback; the database this leaves behind has 167 applied and no
-- queue fixture in it.
--
-- Order: 150's dry-run (114, 115, 119, 122, 136, 145 and 150 in production order, on stand-ins for pg_cron, pg_net
-- and pgmq, so ops_health_report() exists), 041 (sources.fetch_last_at, which row 20 reads) and 157 (the ingest_cycles
-- counters), 161 (the text production runs, gated on its md5), a baseline that shows the defect (an image_backfill
-- archive at read_ct 3 reads warn), then 167 TWICE, then the scenarios.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Prelude: the history 167 sits on. -----------------------------------------------------------------------
\ir 150-ops-queue-cron-liveness-dryrun.sql
\ir ../../../supabase/migrations/041_source_fetch_state.sql
\ir ../../../supabase/migrations/157_ingest_poll_stale.sql
\ir ../../../supabase/migrations/161_image_coverage_by_source.sql

-- The deployed body is the one 167 starts from: 161's fingerprint (production, read-only, 2026-11-06).
do $$
declare v_md5 text; v_len int;
begin
  select md5(prosrc), length(prosrc) into v_md5, v_len from pg_proc where oid = 'public.ops_health_report()'::regprocedure;
  if v_md5 <> 'c1c2ff6c61daede5a5e8c8695547b445' or v_len <> 47349 then
    raise exception 'the local 161 body differs from production (md5 gate): % / %', v_md5, v_len;
  end if;
end $$;

-- Helpers: empty the four queue tables, and assert row 18. ----------------------------------------------------
create function pg_temp.empty_queues() returns void language plpgsql as $$
begin
  delete from pgmq.q_cluster_work;
  delete from pgmq.q_image_backfill;
  delete from pgmq.a_cluster_work;
  delete from pgmq.a_image_backfill;
end $$;

create function pg_temp.assert_queue_lag(p_label text, p_status text, p_suffix text) returns void language plpgsql as $$
declare r record;
begin
  select l.status as st, l.detail as dt into r from public.ops_health_report() l where l.check_name = 'queue_lag';
  if r.st is distinct from p_status or r.dt is null or right(r.dt, length(p_suffix)) <> p_suffix then
    raise exception '%: wanted % / ...%, got % / %', p_label, p_status, p_suffix, r.st, r.dt;
  end if;
end $$;

-- Baseline (what production runs the moment before 167): the report has 21 rows, and an image_backfill archive at
-- read_ct 3 (a message processed on its 3rd read) counts as poison and warns: the defect. ----------------------
create temp table before_167 as
  select t.n, t.check_name, t.status
    from public.ops_health_report() with ordinality as t(check_name, status, observed, threshold, detail, n);

do $$
begin
  if (select count(*) from before_167) <> 21 then raise exception 'baseline: wanted 21 report rows, got %', (select count(*) from before_167); end if;
  if (select check_name from before_167 where n = 18) <> 'queue_lag' then raise exception 'baseline: row 18 is not queue_lag'; end if;
end $$;

begin;
select pg_temp.empty_queues();
insert into pgmq.a_image_backfill (msg_id, read_ct, archived_at) select g, 3, now() - interval '1 hour' from generate_series(1, 11) g;
select pg_temp.assert_queue_lag('baseline 161: 11 archives at read_ct 3', 'warn', 'zehirli (24 sa): 11');
rollback;

-- Apply: 167 TWICE (re-apply safety). ---------------------------------------------------------------------
\echo '--- first application of 167'
\ir ../../../supabase/migrations/167_ops_queue_poison_contract.sql
\echo '--- second application of 167 (the ledger insert must say INSERT 0 0)'
\ir ../../../supabase/migrations/167_ops_queue_poison_contract.sql

-- 1. the function: fingerprint, flags, ACL, comment, ledger --------------------------------------------------
do $$
declare f record;
begin
  select md5(p.prosrc) as m, length(p.prosrc) as len, p.prosecdef, p.provolatile, p.proconfig, p.proacl::text as acl,
         obj_description(p.oid, 'pg_proc') as cmt
    into f from pg_proc p where p.oid = 'public.ops_health_report()'::regprocedure;
  if f.m <> '5a9f9e384da09a19df1cd73a3f8ba4a5' or f.len <> 47439 then
    raise exception 'the 167 body is not the pinned one: md5 %, length %', f.m, f.len;
  end if;
  if not f.prosecdef or f.provolatile <> 'v' or f.proconfig is distinct from array['search_path=""'] then
    raise exception 'function flags changed: % % %', f.prosecdef, f.provolatile, f.proconfig;
  end if;
  if f.acl is distinct from '{postgres=X/postgres,service_role=X/postgres}' then raise exception 'function ACL is %', f.acl; end if;
  if has_function_privilege('anon', 'public.ops_health_report()', 'execute')
     or has_function_privilege('authenticated', 'public.ops_health_report()', 'execute')
     or not has_function_privilege('service_role', 'public.ops_health_report()', 'execute') then
    raise exception 'function privileges are wrong';
  end if;
  if f.cmt not like '%21 fixed rows%' or f.cmt not like '%with read_ct > 3, poison (the consumers archive on the 4th read, MAX_READS = 3;%' or f.cmt not like '%159, 161, 167): 21 fixed rows%' or f.cmt like '%read_ct >= 3%' then
    raise exception 'the function comment is wrong: %', f.cmt;
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '167') <> 1 then
    raise exception 'the ledger should hold one 167 row';
  end if;
  if (select name from supabase_migrations.schema_migrations where version = '167') <> '167_ops_queue_poison_contract' then
    raise exception 'the ledger name is wrong';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '161') <> 1 then
    raise exception 'the ledger should still hold one 161 row';
  end if;
end $$;

-- 2. the report: the same 21 rows in the same order with the same statuses as before ---------------------------
do $$
begin
  if (select count(*) from public.ops_health_report()) <> 21 then raise exception 'the report should still have 21 rows'; end if;
  if exists (
    select 1
      from before_167 b
      full join (select t.n, t.check_name, t.status
                   from public.ops_health_report() with ordinality as t(check_name, status, observed, threshold, detail, n)) a
        on a.n = b.n
     where a.check_name is distinct from b.check_name or a.status is distinct from b.status
  ) then
    raise exception '167 changed a row name, an order position or a status on the unchanged queue state';
  end if;
end $$;

-- 3. row 18 scenarios (each one in a rolled-back transaction on emptied queues) --------------------------------
begin;  -- empty queues: pass, the detail format of 150 unchanged
select pg_temp.empty_queues();
select pg_temp.assert_queue_lag('empty queues', 'pass', 'cluster_work: 0 mesaj, en eski 0 sn · image_backfill: 0 mesaj, en eski 0 sn · zehirli (24 sa): 0');
rollback;

begin;  -- the 2026-11-06 shape: 11 image_backfill messages archived on their 3rd read are processed, not poison
select pg_temp.empty_queues();
insert into pgmq.a_image_backfill (msg_id, read_ct, archived_at) select g, 3, now() - interval '1 hour' from generate_series(1, 11) g;
select pg_temp.assert_queue_lag('11 archives at read_ct 3', 'pass', 'zehirli (24 sa): 0');
rollback;

begin;  -- the same in cluster_work
select pg_temp.empty_queues();
insert into pgmq.a_cluster_work (msg_id, read_ct, archived_at) select g, 3, now() - interval '1 hour' from generate_series(1, 2) g;
select pg_temp.assert_queue_lag('cluster_work archives at read_ct 3', 'pass', 'zehirli (24 sa): 0');
rollback;

begin;  -- a 4th read is the consumers' poison, in either queue
select pg_temp.empty_queues();
insert into pgmq.a_image_backfill (msg_id, read_ct, archived_at) values (1, 4, now() - interval '1 hour');
select pg_temp.assert_queue_lag('image_backfill archive at read_ct 4', 'warn', 'zehirli (24 sa): 1');
rollback;

begin;
select pg_temp.empty_queues();
insert into pgmq.a_cluster_work (msg_id, read_ct, archived_at) values (1, 4, now() - interval '1 hour');
select pg_temp.assert_queue_lag('cluster_work archive at read_ct 4', 'warn', 'zehirli (24 sa): 1');
rollback;

begin;  -- the count sums both archives and counts only read_ct > 3: 11 at 3 (no), 2 at 4 and 1 at 5 in the other queue (yes)
select pg_temp.empty_queues();
insert into pgmq.a_image_backfill (msg_id, read_ct, archived_at) select 3000 + g, 3, now() - interval '1 hour' from generate_series(1, 11) g;
insert into pgmq.a_image_backfill (msg_id, read_ct, archived_at) select 4000 + g, 4, now() - interval '1 hour' from generate_series(1, 2) g;
insert into pgmq.a_cluster_work (msg_id, read_ct, archived_at) values (5001, 5, now() - interval '1 hour');
select pg_temp.assert_queue_lag('11 at 3 + 2 at 4 + 1 at 5', 'warn', 'zehirli (24 sa): 3');
rollback;

begin;  -- read_ct 2 never counts
select pg_temp.empty_queues();
insert into pgmq.a_image_backfill (msg_id, read_ct, archived_at) select g, 2, now() - interval '1 hour' from generate_series(1, 5) g;
select pg_temp.assert_queue_lag('read_ct 2', 'pass', 'zehirli (24 sa): 0');
rollback;

begin;  -- the 24 hour window is kept: 25 hours old passes, 23 hours old warns
select pg_temp.empty_queues();
insert into pgmq.a_image_backfill (msg_id, read_ct, archived_at) values (1, 4, now() - interval '25 hours');
select pg_temp.assert_queue_lag('read_ct 4 archived 25 hours ago', 'pass', 'zehirli (24 sa): 0');
rollback;

begin;
select pg_temp.empty_queues();
insert into pgmq.a_image_backfill (msg_id, read_ct, archived_at) values (1, 4, now() - interval '23 hours');
select pg_temp.assert_queue_lag('read_ct 4 archived 23 hours ago', 'warn', 'zehirli (24 sa): 1');
rollback;

begin;  -- the other limits are unchanged: an old cluster_work message fails, a 31 minute old image_backfill message warns
select pg_temp.empty_queues();
insert into pgmq.q_cluster_work (enqueued_at, vt) values (now() - interval '20 minutes', now() - interval '1 second');
select pg_temp.assert_queue_lag('cluster_work message 20 minutes old', 'fail', 'zehirli (24 sa): 0');
rollback;

begin;
select pg_temp.empty_queues();
insert into pgmq.q_image_backfill (enqueued_at, vt) values (now() - interval '31 minutes', now() - interval '1 second');
select pg_temp.assert_queue_lag('image_backfill message 31 minutes old', 'warn', 'zehirli (24 sa): 0');
rollback;

begin;  -- anon still cannot call the report
do $$ begin
  set local role anon;
  begin
    perform * from public.ops_health_report();
    raise exception 'anon called ops_health_report';
  exception when insufficient_privilege then null;
  end;
  reset role;
end $$;
rollback;

-- Nothing is left behind. -------------------------------------------------------------------------------------
do $$
begin
  if (select count(*) from pgmq.a_cluster_work) + (select count(*) from pgmq.a_image_backfill)
     + (select count(*) from pgmq.q_cluster_work) + (select count(*) from pgmq.q_image_backfill) <> 0 then
    raise exception 'a queue fixture leaked out of its transaction';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '167') <> 1 then
    raise exception 'the ledger should still hold one 167 row';
  end if;
end $$;

select 'DRYRUN 167 OK';
