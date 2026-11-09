-- 188 pgmq_read_msgs_poll (the long-poll twin of 029's pgmq_read_msgs, a SECURITY DEFINER shim over
-- pgmq.read_with_poll with the wait clamped to 1..6 s and the sleep step to 50..1000 ms): local PG15 dry-run.
-- Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55588 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55588 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/188-pgmq-read-poll-dryrun.sql
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh    (TAYF_LIVE_ONLY=188 runs just this one)
--
-- (\ir paths below are relative to this file.) Every check is a DO block that raises on mismatch, so a clean
-- run ending in "DRYRUN 188 OK" is the pass. Nothing here writes a row: the pgmq stand-in below is functions and
-- one composite type, and every call reads the stand-in's echo.
--
-- Order: the pgmq extension is not in the stub, so a stand-in schema is built first with the signatures and the
-- ACLs production has (read_with_poll is callable by its owner only, as in pgmq 1.5.1; its stand-in does not
-- poll, it ECHOES the arguments it received in the row it returns, so the clamp is observable). Then 029 is
-- applied from its own file (the shims 188 is modelled on), then 188 TWICE, and the checks run: fingerprint
-- and attributes, the ACL against 029's shim and against real roles, the clamp over a grid of inputs, and the
-- rollback statements of the header followed by a re-apply.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- 1. The pgmq stand-in (signatures and ACLs as in pgmq 1.5.1; owner = the loading role). ------------------------
create schema pgmq;

create type pgmq.message_record as (
  msg_id bigint, read_ct integer, enqueued_at timestamptz, vt timestamptz, message jsonb, headers jsonb
);

-- ECHO: msg_id = qty, read_ct = vt, message = every other argument, so a test reads back what arrived.
create function pgmq.read_with_poll(
  queue_name text, vt integer, qty integer,
  max_poll_seconds integer default 5, poll_interval_ms integer default 100, conditional jsonb default '{}'::jsonb
) returns setof pgmq.message_record
language sql
as $$
  select qty::bigint, vt, now(), now(),
         jsonb_build_object('queue_name', queue_name, 'max_poll_seconds', max_poll_seconds,
                            'poll_interval_ms', poll_interval_ms, 'conditional', conditional),
         null::jsonb;
$$;
revoke all on function pgmq.read_with_poll(text, integer, integer, integer, integer, jsonb) from public;

-- What 029's five shims call (bodies are validated when 029 runs, so every callee must exist).
create function pgmq.read(queue_name text, vt integer, qty integer, conditional jsonb default '{}'::jsonb)
  returns setof pgmq.message_record language sql as $$ select null::bigint, null::integer, null::timestamptz, null::timestamptz, null::jsonb, null::jsonb where false; $$;
create function pgmq.archive(queue_name text, msg_id bigint) returns boolean language sql as $$ select true; $$;
create function pgmq.delete(queue_name text, msg_id bigint) returns boolean language sql as $$ select true; $$;
create function pgmq.send(queue_name text, msg jsonb) returns bigint language sql as $$ select 1::bigint; $$;
create function pgmq.metrics(queue_name text)
  returns table(queue_name text, queue_length bigint, newest_msg_age_sec integer, oldest_msg_age_sec integer, total_messages bigint, scrape_time timestamptz)
  language sql as $$ select queue_name, 0::bigint, 0, 0, 0::bigint, now(); $$;
revoke all on function pgmq.read(text, integer, integer, jsonb) from public;
revoke all on function pgmq.archive(text, bigint) from public;
revoke all on function pgmq.delete(text, bigint) from public;
revoke all on function pgmq.send(text, jsonb) from public;
revoke all on function pgmq.metrics(text) from public;

-- 2. Before: no function of the new name; 029's shims as production has them. ------------------------------------
\ir ../../../supabase/migrations/029_public_pgmq_wrappers.sql

do $$
begin
  if exists (select 1 from pg_proc where proname = 'pgmq_read_msgs_poll') then
    raise exception 'a function named pgmq_read_msgs_poll exists before 188 (production has none)';
  end if;
  if not exists (select 1 from pg_proc where oid = 'public.pgmq_read_msgs(text,integer,integer)'::regprocedure) then
    raise exception '029 did not create pgmq_read_msgs';
  end if;
end $$;

-- 3. Apply 188 TWICE (one transaction each, create or replace, ledger on conflict do nothing). --------------------
\ir ../../../supabase/migrations/188_pgmq_read_msgs_poll.sql
\ir ../../../supabase/migrations/188_pgmq_read_msgs_poll.sql

-- 4. Fingerprint and attributes. ---------------------------------------------------------------------------------
do $$
declare
  p pg_proc%rowtype;
  twin pg_proc%rowtype;
begin
  if (select count(*) from pg_proc where proname = 'pgmq_read_msgs_poll') <> 1 then
    raise exception '188 must leave exactly one pgmq_read_msgs_poll';
  end if;
  select * into p from pg_proc where oid = 'public.pgmq_read_msgs_poll(text,integer,integer,integer,integer)'::regprocedure;
  select * into twin from pg_proc where oid = 'public.pgmq_read_msgs(text,integer,integer)'::regprocedure;

  if md5(p.prosrc) <> '5b63418cb63edba4f494b309ee30b0fa' or length(p.prosrc) <> 153 then
    raise exception '188 body fingerprint is % / %, the header says 5b63418cb63edba4f494b309ee30b0fa / 153', md5(p.prosrc), length(p.prosrc);
  end if;
  if not p.prosecdef then raise exception '188 must be SECURITY DEFINER'; end if;
  if p.proconfig is distinct from array['search_path=""'] then
    raise exception '188 proconfig is %, expected {search_path=""}', p.proconfig;
  end if;
  if (select l.lanname from pg_language l where l.oid = p.prolang) <> 'sql' then raise exception '188 must be language sql'; end if;
  if p.provolatile <> 'v' then raise exception '188 must be volatile (it leases messages), is %', p.provolatile; end if;
  if pg_get_function_result(p.oid) <> pg_get_function_result(twin.oid) then
    raise exception '188 returns % but 029 pgmq_read_msgs returns %', pg_get_function_result(p.oid), pg_get_function_result(twin.oid);
  end if;
  if pg_get_function_arguments(p.oid) <> 'queue_name text, vt integer, qty integer, max_poll_seconds integer, poll_interval_ms integer' then
    raise exception '188 arguments are %', pg_get_function_arguments(p.oid);
  end if;
  if p.proowner <> twin.proowner then raise exception '188 and 029 shims have different owners'; end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '188' and name = '188_pgmq_read_msgs_poll') <> 1 then
    raise exception 'ledger row 188 must exist exactly once after two applications';
  end if;
end $$;

-- 5. ACL: the same as 029's shim (owner + service_role), nothing for public, anon, authenticated. ----------------
do $$
declare
  poll_acl text := (select proacl::text from pg_proc where oid = 'public.pgmq_read_msgs_poll(text,integer,integer,integer,integer)'::regprocedure);
  twin_acl text := (select proacl::text from pg_proc where oid = 'public.pgmq_read_msgs(text,integer,integer)'::regprocedure);
begin
  if poll_acl is null then raise exception '188 has a default ACL (NULL): PUBLIC could execute it'; end if;
  if poll_acl is distinct from twin_acl then
    raise exception '188 ACL % differs from 029 shim ACL %', poll_acl, twin_acl;
  end if;
  if exists (
    select 1 from pg_proc p, aclexplode(p.proacl) a
     where p.oid = 'public.pgmq_read_msgs_poll(text,integer,integer,integer,integer)'::regprocedure and a.grantee = 0
  ) then
    raise exception '188 is executable by PUBLIC';
  end if;
  if not has_function_privilege('service_role', 'public.pgmq_read_msgs_poll(text,integer,integer,integer,integer)', 'execute') then
    raise exception 'service_role cannot execute 188';
  end if;
  if has_function_privilege('anon', 'public.pgmq_read_msgs_poll(text,integer,integer,integer,integer)', 'execute') then
    raise exception 'anon can execute 188';
  end if;
  if has_function_privilege('authenticated', 'public.pgmq_read_msgs_poll(text,integer,integer,integer,integer)', 'execute') then
    raise exception 'authenticated can execute 188';
  end if;
end $$;

-- anon and authenticated really are refused (the stub's default privileges would have granted them EXECUTE).
do $$
begin
  set local role anon;
  begin
    perform * from public.pgmq_read_msgs_poll('q', 30, 1, 1, 50);
    raise exception 'anon called pgmq_read_msgs_poll';
  exception when insufficient_privilege then
    null;
  end;
  reset role;
  set local role authenticated;
  begin
    perform * from public.pgmq_read_msgs_poll('q', 30, 1, 1, 50);
    raise exception 'authenticated called pgmq_read_msgs_poll';
  exception when insufficient_privilege then
    null;
  end;
  reset role;
end $$;

-- 6. The call as service_role: arguments reach pgmq.read_with_poll, the wait and the step are clamped. ------------
-- (service_role has no right on the pgmq schema: only the SECURITY DEFINER shim reaches it.)
do $$
declare
  g record;
  r pgmq.message_record;
  n int;
begin
  set local role service_role;
  for g in
    select * from (values
      (1,    6,   250,  6,  250),   -- what the consumer asks for
      (2,    1,    50,  1,   50),   -- both lower bounds
      (3,    3,   999,  3,  999),   -- inside the range: untouched
      (4,    7,   100,  6,  100),   -- above 6 s
      (5,   99,  5000,  6, 1000),   -- far above both
      (6,    0,     0,  1,   50),   -- 0 would make pgmq return before its first read
      (7,   -5,    -1,  1,   50),   -- negatives
      (8, null,  null,  1,   50),   -- NULL: greatest() ignores it
      (9,    6,  1000,  6, 1000),   -- both upper bounds
      (10,   6,  1001,  6, 1000)    -- one over the step bound
    ) as v(case_no, secs, ms, want_secs, want_ms)
    order by case_no
  loop
    n := 0;
    for r in select * from public.pgmq_read_msgs_poll('cluster_work', 60, 2, g.secs, g.ms) loop
      n := n + 1;
      if r.msg_id <> 2 or r.read_ct <> 60 then
        raise exception 'case %: qty/vt did not pass through (msg_id %, read_ct %)', g.case_no, r.msg_id, r.read_ct;
      end if;
      if r.message ->> 'queue_name' <> 'cluster_work' then
        raise exception 'case %: queue_name did not pass through (%)', g.case_no, r.message;
      end if;
      if (r.message ->> 'max_poll_seconds')::int is distinct from g.want_secs then
        raise exception 'case %: wait % -> % (wanted %)', g.case_no, g.secs, r.message ->> 'max_poll_seconds', g.want_secs;
      end if;
      if (r.message ->> 'poll_interval_ms')::int is distinct from g.want_ms then
        raise exception 'case %: step % -> % (wanted %)', g.case_no, g.ms, r.message ->> 'poll_interval_ms', g.want_ms;
      end if;
      if r.message -> 'conditional' <> '{}'::jsonb then
        raise exception 'case %: the shim must not pass a conditional filter (%)', g.case_no, r.message -> 'conditional';
      end if;
    end loop;
    if n <> 1 then raise exception 'case %: expected the echo row, got % rows', g.case_no, n; end if;
  end loop;
  reset role;
end $$;

-- 7. Rollback of the header, then re-apply. ----------------------------------------------------------------------
begin;
drop function public.pgmq_read_msgs_poll(text, int, int, int, int);
delete from supabase_migrations.schema_migrations where version = '188';
notify pgrst, 'reload schema';
commit;

do $$
begin
  if exists (select 1 from pg_proc where proname = 'pgmq_read_msgs_poll') then
    raise exception 'the rollback left pgmq_read_msgs_poll behind';
  end if;
  if exists (select 1 from supabase_migrations.schema_migrations where version = '188') then
    raise exception 'the rollback left ledger row 188 behind';
  end if;
  if not exists (select 1 from pg_proc where oid = 'public.pgmq_read_msgs(text,integer,integer)'::regprocedure) then
    raise exception 'the rollback removed 029 pgmq_read_msgs';
  end if;
end $$;

\ir ../../../supabase/migrations/188_pgmq_read_msgs_poll.sql

do $$
begin
  if (select md5(prosrc) from pg_proc where oid = 'public.pgmq_read_msgs_poll(text,integer,integer,integer,integer)'::regprocedure)
       <> '5b63418cb63edba4f494b309ee30b0fa' then
    raise exception 're-applying 188 after the rollback changed the body';
  end if;
  if (select proacl::text from pg_proc where oid = 'public.pgmq_read_msgs_poll(text,integer,integer,integer,integer)'::regprocedure)
       is distinct from (select proacl::text from pg_proc where oid = 'public.pgmq_read_msgs(text,integer,integer)'::regprocedure) then
    raise exception 're-applying 188 after the rollback changed the ACL';
  end if;
end $$;

select 'DRYRUN 188 OK';
