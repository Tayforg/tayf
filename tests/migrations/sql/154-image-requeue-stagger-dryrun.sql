-- 154 image_requeue_stagger (hunt-28, h28-freshness-2): local PG15 dry-run. Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root). The servers listen on 127.0.0.1 only (no
-- unix socket: the scratchpad path is longer than a socket path may be):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55731 -c listen_addresses=127.0.0.1 -c unix_socket_directories=" -l $D/log -w start
--   $PGBIN/createdb -h 127.0.0.1 -p 55731 -U postgres dry154
--   $PGBIN/psql -h 127.0.0.1 -p 55731 -U postgres -d dry154 -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/154-image-requeue-stagger-dryrun.sql
--   Without pg_cron and without ops_cron_expected (the notice branch and the missing-table branch), a
--   third database:   ... -d dry154_nocron -v nocron=1 -f tests/migrations/sql/stub.sql -f tests/migrations/sql/154-image-requeue-stagger-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql PGHOST=127.0.0.1 PGPORT=55731 PGUSER=postgres PGDATABASE=dry154 \
--      npx vitest run tests/migrations/154-image-requeue-stagger)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh
--
-- (\ir paths below are relative to this file.) Every check is a DO block that raises on mismatch, so a
-- clean run ending in "DRYRUN 154 OK" is the pass. Every scenario that writes sits inside begin ... rollback.
--
-- Order: a pgmq stand-in whose send(queue, msg, delay) sets vt = clock_timestamp() + delay seconds like
-- pgmq 1.5.1; the columns and thirteen fixture articles; a fake pg_cron (cron.job, cron.schedule,
-- cron.unschedule and a pg_extension row, three other jobs) and the ops_cron_expected table as 150 seeds it;
-- 142 applied (production's state; the md5 gate on its function body: 917624baf55f5021fe458e8f0664b6d1);
-- 154 applied, 154 applied AGAIN, then the checks and the scenarios.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Prelude A: a pgmq stand-in (no extension is installed locally). --------------------------------
create schema pgmq;
create table pgmq.meta (queue_name text primary key);
create function pgmq.create(queue_name text) returns void language plpgsql as $$
begin
  insert into pgmq.meta (queue_name) values (queue_name) on conflict do nothing;
  execute format(
    'create table if not exists pgmq.%I (msg_id bigint generated always as identity primary key, read_ct integer not null default 0, enqueued_at timestamptz not null default now(), vt timestamptz not null default now(), message jsonb, headers jsonb)',
    'q_' || queue_name);
end $$;
-- Like pgmq.send(queue, msg, delay): enqueued_at = now(), vt = clock_timestamp() + delay seconds.
create function pgmq.send(queue_name text, msg jsonb, delay integer default 0) returns bigint language plpgsql as $$
declare v bigint;
begin
  execute format('insert into pgmq.%I (vt, message) values (clock_timestamp() + make_interval(secs => $1), $2) returning msg_id', 'q_' || queue_name)
    into v using delay, msg;
  return v;
end $$;
select pgmq.create('image_backfill');

-- Prelude B: the columns 142 reads, and thirteen fixture articles. ---------------------------------
alter table public.articles add column if not exists image_url text;
alter table public.articles add column if not exists image_backfill_attempts integer not null default 0;
alter table public.articles add column if not exists image_backfill_attempted_at timestamptz;
alter table public.articles add column if not exists created_at timestamptz not null default now();
create index if not exists idx_articles_created_at on public.articles (created_at desc);

insert into public.articles (id, title, image_url, image_backfill_attempts, image_backfill_attempted_at, created_at) values
  -- eligible under 154 (attempts 1..2, tried over 2 h ago, created within 7 d, not queued), newest first A3, A2, A1
  ('a1540000-0000-0000-0000-000000000001', 'A1 attempts 1, tried 3 h ago, created 2 d ago',        null, 1, now() - interval '3 hours', now() - interval '2 days'),
  ('a1540000-0000-0000-0000-000000000002', 'A2 attempts 2, tried 3 h ago, created 1 d ago',        null, 2, now() - interval '3 hours', now() - interval '1 day'),
  ('a1540000-0000-0000-0000-000000000003', 'A3 attempts 2, tried 5 h ago, created 1 h ago',        null, 2, now() - interval '5 hours', now() - interval '1 hour'),
  -- eligible under 142 (attempts 3 and 4) but NOT under 154
  ('a1540000-0000-0000-0000-000000000004', 'A4 attempts 3 (142 yes, 154 no)',                      null, 3, now() - interval '3 hours', now() - interval '1 day'),
  ('a1540000-0000-0000-0000-000000000005', 'A5 attempts 4 (142 yes, 154 no)',                      null, 4, now() - interval '3 hours', now() - interval '1 day'),
  -- excluded by both
  ('a1540000-0000-0000-0000-000000000006', 'A6 attempts 0',                                        null, 0, now() - interval '3 hours', now() - interval '1 day'),
  ('a1540000-0000-0000-0000-000000000007', 'A7 attempts 5, parked 7 d ahead',                      null, 5, now() + interval '7 days',  now() - interval '3 days'),
  ('a1540000-0000-0000-0000-000000000008', 'A8 attempts 1, tried 1 h ago',                         null, 1, now() - interval '1 hour',  now() - interval '1 day'),
  ('a1540000-0000-0000-0000-000000000009', 'A9 attempts 1, gate 1 d ahead',                        null, 1, now() + interval '1 day',   now() - interval '1 day'),
  ('a1540000-0000-0000-0000-000000000010', 'A10 attempts 1, created 8 d ago',                      null, 1, now() - interval '3 hours', now() - interval '8 days'),
  ('a1540000-0000-0000-0000-000000000011', 'A11 has an image',                                     'https://example.invalid/a11.jpg', 1, now() - interval '3 hours', now() - interval '1 day'),
  ('a1540000-0000-0000-0000-000000000012', 'A12 eligible but already queued',                      null, 1, now() - interval '3 hours', now() - interval '12 hours'),
  ('a1540000-0000-0000-0000-000000000013', 'A13 attempted_at null',                                null, 1, null,                       now() - interval '1 day');
-- the queue holds A12 and one message without an article_id (the NULL-safe NOT IN guard)
select pgmq.send('image_backfill', '{"article_id": "a1540000-0000-0000-0000-000000000012"}'::jsonb);
select pgmq.send('image_backfill', '{"other": 1}'::jsonb);

-- Prelude C: the post-117 privilege state. ---------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;
revoke all on all tables in schema public from anon, authenticated, public;
grant all on all tables in schema public to service_role;
grant usage on schema pgmq to service_role;
insert into supabase_migrations.schema_migrations (version, name) values
  ('139', '139_content_twin_candidates'), ('140', '140_cluster_skip_log') on conflict do nothing;

-- Prelude D: a fake pg_cron and the ops_cron_expected table as 150 seeds it (not in nocron mode). ---
\if :{?nocron}
\echo (nocron: no pg_cron, no ops_cron_expected)
\else
create schema cron;
create table cron.job (
  jobid bigserial primary key, jobname text unique, schedule text not null, command text not null, active boolean not null default true);
create function cron.schedule(job_name text, schedule text, command text) returns bigint language plpgsql as $$
declare v bigint;
begin
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
    on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid into v;
  return v;
end $$;
create function cron.unschedule(job_name text) returns boolean language plpgsql as $$
begin
  delete from cron.job where jobname = job_name;
  return found;
end $$;
-- pg_cron is "installed": one row in pg_extension (superuser, throwaway database).
insert into pg_catalog.pg_extension (oid, extname, extowner, extnamespace, extrelocatable, extversion)
  values (915400, 'pg_cron', 10, (select oid from pg_namespace where nspname = 'cron'), false, '1.6');
select cron.schedule('other-job', '*/7 * * * *', 'select 1');
select cron.schedule('image-drain', '*/5 * * * *', 'select 2');
select cron.schedule('ingest-drain', '*/3 * * * *', 'select 3');

create table public.ops_cron_expected (
  jobname text primary key,
  max_gap interval not null check (max_gap > interval '0'),
  note text);
insert into public.ops_cron_expected (jobname, max_gap, note) values
  ('cluster-drain',          interval '10 minutes', '* * * * *'),
  ('image-drain',            interval '20 minutes', '*/5 * * * *'),
  ('image-backfill-requeue', interval '3 hours',    '17 * * * *'),
  ('prune-nightly',          interval '26 hours',   '10 4 * * *');
\endif

-- ===== 142 applied: production's state ===============================================================
\echo ===== 142 (production's state before 154)
\ir ../../../supabase/migrations/142_image_backfill_retry.sql

-- The md5 gate: the dry-run copy IS the production body (sbq, read-only, 2026-11-02:
-- md5(prosrc) 917624baf55f5021fe458e8f0664b6d1, 835 characters, definer, search_path "", ACL
-- {postgres=X/postgres,service_role=X/postgres}).
do $$
declare v_md5 text; v_len int; v_acl text;
begin
  select md5(prosrc), length(prosrc), proacl::text into v_md5, v_len, v_acl
    from pg_proc where oid = 'public.image_backfill_requeue(integer)'::regprocedure;
  if v_md5 <> '917624baf55f5021fe458e8f0664b6d1' or v_len <> 835 then
    raise exception 'the local image_backfill_requeue body differs from production (md5 gate): % / %', v_md5, v_len;
  end if;
  if v_acl <> '{postgres=X/postgres,service_role=X/postgres}' then raise exception 'unexpected ACL before 154: %', v_acl; end if;
end $$;

-- Before 154: 142's function picks attempts 1..4 (A1 A2 A3 A4 A5) and sends without a delay.
begin;
do $$
declare v_n integer; v_max numeric;
begin
  v_n := public.image_backfill_requeue(100);
  select max(extract(epoch from (vt - now()))) into v_max from pgmq.q_image_backfill where message ->> 'article_id' <> 'a1540000-0000-0000-0000-000000000012';
  if v_n <> 5 then raise exception '142 should pick 5 articles (attempts 1..4), picked %', v_n; end if;
  if v_max > 1 then raise exception '142 should send without a delay, max vt - now() = %', v_max; end if;
  raise notice '142 before 154: requeue(100) = %, max delay % s', v_n, round(v_max);
end $$;
rollback;

-- Snapshots to compare after 154. ------------------------------------------------------------------
select md5(string_agg(a::text, '|' order by a.id)) as articles_md5_before from public.articles a \gset
select max(msg_id) as max_msg_before from pgmq.q_image_backfill \gset
select md5(prosrc) as body142_md5 from pg_proc where oid = 'public.image_backfill_requeue(integer)'::regprocedure \gset
\if :{?nocron}
\else
select md5(coalesce(string_agg(jobname || '|' || schedule || '|' || command || '|' || active::text, ';' order by jobname), '')) as other_jobs_before
  from cron.job where jobname <> 'image-backfill-requeue' \gset
select md5(coalesce(string_agg(o::text, ';' order by o.jobname), '')) as other_ops_before
  from public.ops_cron_expected o where jobname <> 'image-backfill-requeue' \gset
select set_config('dry.other_jobs_before', :'other_jobs_before', false) as s1, set_config('dry.other_ops_before', :'other_ops_before', false) as s2 \gset
select schedule || ' | ' || command as job142 from cron.job where jobname = 'image-backfill-requeue' \gset
\echo cron.job after 142: :job142
\endif
select set_config('dry.articles_md5_before', :'articles_md5_before', false) as s0, set_config('dry.body142_md5', :'body142_md5', false) as s3,
       set_config('dry.max_msg_before', :'max_msg_before', false) as s4 \gset

-- ===== 154 applied (apply 1) =========================================================================
\echo ===== 154 apply 1
\ir ../../../supabase/migrations/154_image_requeue_stagger.sql
\echo ===== 154 apply 1 done
\if :{?nocron}
\else
select o.xmin::text as ops_xmin_1 from public.ops_cron_expected o where jobname = 'image-backfill-requeue' \gset
select jobid::text as jobid_1 from cron.job where jobname = 'image-backfill-requeue' \gset
\endif

-- ===== 154 applied AGAIN (apply 2): no error, the ledger insert is INSERT 0 0 =========================
\echo ===== 154 apply 2
\ir ../../../supabase/migrations/154_image_requeue_stagger.sql
\echo ===== 154 apply 2 done

-- ===== After =========================================================================================
\echo ===== after
select 'ledger', string_agg(version || ' ' || name, ' | ' order by version) from supabase_migrations.schema_migrations where version in ('142', '154');
select 'function', p.prosecdef, p.provolatile, p.proconfig[1], pg_get_userbyid(p.proowner), p.proacl::text, md5(p.prosrc), length(p.prosrc)
  from pg_proc p where p.oid = 'public.image_backfill_requeue(integer)'::regprocedure;
select 'privileges', has_function_privilege('anon', 'public.image_backfill_requeue(integer)', 'execute') as anon,
       has_function_privilege('authenticated', 'public.image_backfill_requeue(integer)', 'execute') as authenticated,
       has_function_privilege('service_role', 'public.image_backfill_requeue(integer)', 'execute') as service_role;
select 'comment', obj_description('public.image_backfill_requeue(integer)'::regprocedure, 'pg_proc');
\if :{?nocron}
\else
select 'cron.job', jobname, schedule, command from cron.job order by jobname;
select 'ops_cron_expected', jobname, max_gap, note from public.ops_cron_expected order by jobname;
\endif

-- ===== Checks that raise =============================================================================
-- 1. Idempotence and shape: one function, one ledger row, the body is no longer 142's, the two changes are in it.
do $$
declare v_src text;
begin
  if (select count(*) from pg_proc where proname = 'image_backfill_requeue') <> 1 then raise exception 'function count'; end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '154') <> 1 then raise exception 'ledger 154 is not exactly one row'; end if;
  select prosrc into v_src from pg_proc where oid = 'public.image_backfill_requeue(integer)'::regprocedure;
  if md5(v_src) = current_setting('dry.body142_md5') then raise exception '154 did not change the body'; end if;
  if position('image_backfill_attempts between 1 and 2' in v_src) = 0 or position('between 1 and 4' in v_src) > 0 then raise exception 'attempts window'; end if;
  if position('least(v_sent * 20, 900)' in v_src) = 0 then raise exception 'stagger missing'; end if;
  if not (select prosecdef from pg_proc where oid = 'public.image_backfill_requeue(integer)'::regprocedure) then raise exception 'not security definer'; end if;
  if (select proconfig[1] from pg_proc where oid = 'public.image_backfill_requeue(integer)'::regprocedure) <> 'search_path=""' then raise exception 'search_path'; end if;
  if (select provolatile from pg_proc where oid = 'public.image_backfill_requeue(integer)'::regprocedure) <> 'v' then raise exception 'not volatile'; end if;
end $$;

-- 2. Grants as 142: anon f, authenticated f, service_role t; the ACL is exactly 142's.
do $$
begin
  if has_function_privilege('anon', 'public.image_backfill_requeue(integer)', 'execute')
     or has_function_privilege('authenticated', 'public.image_backfill_requeue(integer)', 'execute') then
    raise exception 'a client role can execute the function';
  end if;
  if not has_function_privilege('service_role', 'public.image_backfill_requeue(integer)', 'execute') then raise exception 'service_role cannot execute'; end if;
  if (select proacl::text from pg_proc where oid = 'public.image_backfill_requeue(integer)'::regprocedure) <> '{postgres=X/postgres,service_role=X/postgres}' then
    raise exception 'ACL differs from 142';
  end if;
end $$;
do $$
declare v_role text;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    execute format('set local role %I', v_role);
    begin
      perform public.image_backfill_requeue(1);
      raise exception '% can call the function', v_role;
    exception when insufficient_privilege then
      if sqlerrm not like 'permission denied for function image_backfill_requeue%' then raise exception 'wrong error: %', sqlerrm; end if;
    end;
    reset role;
  end loop;
end $$;

-- 3. The stagger: requeue(3) sends A3, A2, A1 (newest first) with vt 0, 20 and 40 s ahead (+- 1 s).
begin;
do $$
declare r record; v_n integer; v_expect integer := 0; v_line text := '';
begin
  v_n := public.image_backfill_requeue(3);
  if v_n <> 3 then raise exception 'requeue(3) returned %', v_n; end if;
  for r in
    select right(q.message ->> 'article_id', 2) as art, round(extract(epoch from (q.vt - now())))::int as delay
      from pgmq.q_image_backfill q where q.msg_id > current_setting('dry.max_msg_before')::bigint order by q.msg_id
  loop
    v_line := v_line || 'A' || ltrim(r.art, '0') || '=' || r.delay || ' ';
    if abs(r.delay - v_expect) > 1 then raise exception 'delay % for A% (expected about %)', r.delay, r.art, v_expect; end if;
    v_expect := v_expect + 20;
  end loop;
  if v_line <> 'A3=0 A2=20 A1=40 ' then raise exception 'order/delays: %', v_line; end if;
  raise notice 'stagger: %', v_line;
end $$;
rollback;

-- 4. Attempts 3 and 4 are no longer selected: requeue(100) picks 3 (A1 A2 A3); 142 picked 5.
begin;
do $$
declare v_n integer;
begin
  v_n := public.image_backfill_requeue(100);
  if v_n <> 3 then raise exception 'requeue(100) should pick 3 articles, picked %', v_n; end if;
  if exists (select 1 from pgmq.q_image_backfill q where right(q.message ->> 'article_id', 2) in ('04', '05')) then raise exception 'attempts 3 or 4 were queued'; end if;
  -- a second call finds everything eligible already queued (the guard), and the message without article_id does not poison it
  if public.image_backfill_requeue(100) <> 0 then raise exception 'second call should send nothing'; end if;
  raise notice 'requeue(100) picked % (A1 A2 A3), the second call 0', v_n;
end $$;
rollback;

-- 5. The clamp is 142's: 0 and -5 mean 1, null means 300.
begin;
do $$
begin
  if public.image_backfill_requeue(0) <> 1 then raise exception 'p_limit 0'; end if;
  if public.image_backfill_requeue(-5) <> 1 then raise exception 'p_limit -5'; end if;
  if public.image_backfill_requeue(null) <> 1 then raise exception 'p_limit null (one eligible article left)'; end if;
end $$;
rollback;

-- 6. The cap: 60 eligible articles, requeue(60): the delays run 0, 20, ... 900, 900, ... and never pass 900.
begin;
insert into public.articles (id, title, image_url, image_backfill_attempts, image_backfill_attempted_at, created_at)
  select ('a1540000-0000-0000-0000-' || lpad((800000 + g)::text, 12, '0'))::uuid, 'bulk ' || g, null, 1,
         now() - interval '3 hours', now() - interval '3 days' - g * interval '1 minute'
    from generate_series(1, 60) g;
do $$
declare v_n integer; v_min integer; v_max integer; v_cap integer;
begin
  delete from pgmq.q_image_backfill;
  v_n := public.image_backfill_requeue(60);
  select min(round(extract(epoch from (vt - now())))::int), max(round(extract(epoch from (vt - now())))::int),
         count(*) filter (where round(extract(epoch from (vt - now()))) between 898 and 902)
    into v_min, v_max, v_cap from pgmq.q_image_backfill;
  if v_n <> 60 or abs(v_min) > 1 or abs(v_max - 900) > 1 then raise exception 'cap: n %, min %, max %', v_n, v_min, v_max; end if;
  if v_cap <> 15 then raise exception 'messages 45..59 should sit at the 900 s cap, found %', v_cap; end if;
  raise notice 'cap: % sent, delays % .. % s, % at the cap', v_n, v_min, v_max, v_cap;
end $$;
rollback;

-- 7. No article row is written by the function (md5 of the whole table, before 154 vs after the calls).
do $$
begin
  if (select md5(string_agg(a::text, '|' order by a.id)) from public.articles a) <> current_setting('dry.articles_md5_before') then
    raise exception 'public.articles changed';
  end if;
end $$;

-- 8. Service role can call it (definer path, no pgmq grant needed).
begin;
set local role service_role;
do $$
begin
  if public.image_backfill_requeue(1) <> 1 then raise exception 'service_role call'; end if;
end $$;
rollback;

\if :{?nocron}
-- 9 (nocron). No pg_cron, no ops_cron_expected: the notice branch ran, nothing else happened.
do $$
begin
  if to_regclass('cron.job') is not null or to_regclass('public.ops_cron_expected') is not null then raise exception 'nocron database has cron objects'; end if;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then raise exception 'pg_cron present'; end if;
end $$;
\else
-- 9. The cron job: exactly one image-backfill-requeue at the new schedule with the new command; the others unchanged.
do $$
declare v_sched text; v_cmd text;
begin
  select schedule, command into v_sched, v_cmd from cron.job where jobname = 'image-backfill-requeue';
  if (select count(*) from cron.job where jobname = 'image-backfill-requeue') <> 1 then raise exception 'job count'; end if;
  if v_sched <> '2,17,32,47 * * * *' then raise exception 'schedule %', v_sched; end if;
  if v_cmd <> ' set statement_timeout = ''60s''; select public.image_backfill_requeue(40); ' then raise exception 'command %', v_cmd; end if;
  if (select md5(coalesce(string_agg(jobname || '|' || schedule || '|' || command || '|' || active::text, ';' order by jobname), ''))
        from cron.job where jobname <> 'image-backfill-requeue') <> current_setting('dry.other_jobs_before') then
    raise exception 'another cron job changed';
  end if;
  if (select count(*) from cron.job) <> 4 then raise exception 'job total'; end if;
end $$;

-- 10. ops_cron_expected: the note follows the schedule, max_gap is still 3 hours, no other row changed, and the
--     second apply wrote nothing (the row's xmin did not move between apply 1 and apply 2).
do $$
begin
  if (select note from public.ops_cron_expected where jobname = 'image-backfill-requeue') <> '2,17,32,47 * * * *' then raise exception 'note'; end if;
  if (select max_gap from public.ops_cron_expected where jobname = 'image-backfill-requeue') <> interval '3 hours' then raise exception 'max_gap changed'; end if;
  if (select md5(coalesce(string_agg(o::text, ';' order by o.jobname), '')) from public.ops_cron_expected o where jobname <> 'image-backfill-requeue')
       <> current_setting('dry.other_ops_before') then
    raise exception 'another ops_cron_expected row changed';
  end if;
end $$;
select (o.xmin::text = :'ops_xmin_1') as xmin_same from public.ops_cron_expected o where jobname = 'image-backfill-requeue' \gset
\if :xmin_same
\echo ops_cron_expected row not rewritten by apply 2 (xmin unchanged)
\else
\echo FAIL: apply 2 rewrote the ops_cron_expected row
select 1/0;
\endif

-- 11. A drifted job is put back (unschedule then schedule); a deleted job is scheduled again; other jobs untouched.
update cron.job set schedule = '5 5 * * *', command = 'select 99' where jobname = 'image-backfill-requeue';
\ir ../../../supabase/migrations/154_image_requeue_stagger.sql
do $$
begin
  if (select schedule from cron.job where jobname = 'image-backfill-requeue') <> '2,17,32,47 * * * *' then raise exception 'drift not repaired'; end if;
  if (select command from cron.job where jobname = 'image-backfill-requeue') <> ' set statement_timeout = ''60s''; select public.image_backfill_requeue(40); ' then raise exception 'command drift not repaired'; end if;
end $$;
delete from cron.job where jobname = 'image-backfill-requeue';
\ir ../../../supabase/migrations/154_image_requeue_stagger.sql
do $$
begin
  if (select count(*) from cron.job where jobname = 'image-backfill-requeue') <> 1 then raise exception 'deleted job not scheduled again'; end if;
  if (select md5(coalesce(string_agg(jobname || '|' || schedule || '|' || command || '|' || active::text, ';' order by jobname), ''))
        from cron.job where jobname <> 'image-backfill-requeue') <> current_setting('dry.other_jobs_before') then
    raise exception 'another cron job changed after the repairs';
  end if;
end $$;

-- 12. A row tuned by the operator is not a conflict: max_gap (the operator's) survives, only the note is rewritten.
update public.ops_cron_expected set max_gap = interval '5 hours', note = 'tuned' where jobname = 'image-backfill-requeue';
\ir ../../../supabase/migrations/154_image_requeue_stagger.sql
do $$
begin
  if (select note from public.ops_cron_expected where jobname = 'image-backfill-requeue') <> '2,17,32,47 * * * *' then raise exception 'note not rewritten'; end if;
  if (select max_gap from public.ops_cron_expected where jobname = 'image-backfill-requeue') <> interval '5 hours' then raise exception 'max_gap was overwritten'; end if;
end $$;
update public.ops_cron_expected set max_gap = interval '3 hours' where jobname = 'image-backfill-requeue';
\endif

-- 13. Ledger: 142 and 154 once each; 154 never re-inserted.
do $$
begin
  if (select count(*) from supabase_migrations.schema_migrations where version in ('142', '154')) <> 2 then raise exception 'ledger rows'; end if;
end $$;

\echo DRYRUN 154 OK
