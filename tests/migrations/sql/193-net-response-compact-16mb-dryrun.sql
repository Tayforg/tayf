-- 193 ops_net_response_compact(): the default threshold goes from 64 MiB to 16 MiB: local PG15 dry-run.
-- Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55593 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55593 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/193-net-response-compact-16mb-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql PGHOST=/tmp PGPORT=55593 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/193-net-response-compact-16mb)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh
--
-- (\ir paths below are relative to this file.) Every check is a DO block that raises on mismatch, so a clean
-- run ending in "DRYRUN 193 OK" is the pass. Every scenario that writes sits inside begin ... rollback; the
-- database this leaves behind has 100 and 193 applied and an EMPTY net._http_response.
--
-- Order: a stand-in net._http_response (the table pg_net owns on Supabase; its text column is stored EXTERNAL
-- here, uncompressed, so a known number of bytes of content really is that many bytes on disk), 100 (the
-- function as production runs it; no pg_cron here, so its schedule block only raises a notice), a baseline
-- reading gated on production's md5, then 193 TWICE, then the scenarios.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Prelude: the table pg_net owns, as a stand-in, and the history 193 sits on. -------------------------------
create schema if not exists net;
create table net._http_response (
  id bigint, status_code integer, content_type text, headers jsonb, content text,
  timed_out boolean, error_msg text, created timestamptz not null default now()
);
alter table net._http_response alter column content set storage external;

\ir ../../../supabase/migrations/100_pgnet_bloat_guard.sql

-- Baseline: the function production runs the moment before 193. ----------------------------------------------
create temp table before_193 as
  select md5(prosrc) as m, length(prosrc) as len, prosrc as src, proacl::text as acl, proconfig::text as cfg,
         provolatile, prosecdef, prorows, procost, pg_get_function_result(oid) as res,
         pg_get_function_arguments(oid) as args
    from pg_proc where oid = 'public.ops_net_response_compact(bigint)'::regprocedure;

do $$
begin
  if (select m from before_193) <> '1177f2c28709eae53292ca192b9c812f' or (select len from before_193) <> 1567 then
    raise exception 'baseline: 100''s body is not production''s (md5 %, length %)', (select m from before_193), (select len from before_193);
  end if;
  if (select args from before_193) <> 'p_max_bytes bigint DEFAULT ((64 * 1024) * 1024)' then
    raise exception 'baseline: default is not 64 MiB: %', (select args from before_193);
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '193') <> 0 then
    raise exception 'baseline: 193 must not be recorded yet';
  end if;
end $$;

-- a helper that grows the stand-in to at least p_bytes of total relation size (about 1 MiB per step) -----------
create function pg_temp.fill_to(p_bytes bigint) returns bigint language plpgsql as $$
begin
  loop
    exit when pg_catalog.pg_total_relation_size('net._http_response'::regclass) >= p_bytes;
    insert into net._http_response (id, status_code, content, created)
      select g, 200, repeat('x', 8000), now() from generate_series(1, 100) g;
  end loop;
  return pg_catalog.pg_total_relation_size('net._http_response'::regclass);
end $$;

-- Apply: 193 TWICE (re-apply safety). -------------------------------------------------------------------------
\echo '--- first application of 193'
\ir ../../../supabase/migrations/193_net_response_compact_16mb.sql
\echo '--- second application of 193 (the ledger insert must say INSERT 0 0)'
\ir ../../../supabase/migrations/193_net_response_compact_16mb.sql

-- 1. schema state right after the double apply ----------------------------------------------------------------
do $$
declare
  v_old text[];
  v_new text[];
begin
  if (select count(*) from supabase_migrations.schema_migrations where version = '193') <> 1 then
    raise exception '193 schema_migrations row missing or duplicated';
  end if;
  if (select name from supabase_migrations.schema_migrations where version = '193') <> '193_net_response_compact_16mb' then
    raise exception '193 ledger name wrong';
  end if;
  if (select count(*) from pg_proc where proname = 'ops_net_response_compact' and pronamespace = 'public'::regnamespace) <> 1 then
    raise exception 'ops_net_response_compact must exist exactly once (create or replace must not make an overload)';
  end if;

  -- the argument and its (new) default
  if pg_get_function_arguments('public.ops_net_response_compact(bigint)'::regprocedure)
     <> 'p_max_bytes bigint DEFAULT ((16 * 1024) * 1024)' then
    raise exception 'default is not 16 MiB: %', pg_get_function_arguments('public.ops_net_response_compact(bigint)'::regprocedure);
  end if;
  if pg_get_function_result('public.ops_net_response_compact(bigint)'::regprocedure) <> (select res from before_193) then
    raise exception 'return type changed';
  end if;

  -- attributes and ACL are 100's: SECURITY DEFINER, search_path "", volatile, owner + service_role only
  if exists (select 1 from before_193 b, pg_proc p
              where p.oid = 'public.ops_net_response_compact(bigint)'::regprocedure
                and (p.proacl::text <> b.acl or p.proconfig::text <> b.cfg or p.provolatile <> b.provolatile
                     or p.prosecdef <> b.prosecdef or p.prorows <> b.prorows or p.procost <> b.procost)) then
    raise exception 'ACL or attributes moved';
  end if;
  if not (select prosecdef and proconfig = array['search_path=""'] from pg_proc where oid = 'public.ops_net_response_compact(bigint)'::regprocedure) then
    raise exception 'not security definer with an empty search_path';
  end if;
  if has_function_privilege('anon', 'public.ops_net_response_compact(bigint)', 'execute')
     or has_function_privilege('authenticated', 'public.ops_net_response_compact(bigint)', 'execute')
     or not has_function_privilege('service_role', 'public.ops_net_response_compact(bigint)', 'execute') then
    raise exception 'grants wrong: only service_role (and the owner) may execute';
  end if;

  -- the body is 100's with the one fallback changed
  if (select prosrc from pg_proc where oid = 'public.ops_net_response_compact(bigint)'::regprocedure)
     <> replace((select src from before_193), '64 * 1024 * 1024', '16 * 1024 * 1024') then
    raise exception 'the body differs from 100''s by more than the fallback';
  end if;
  if (select md5(prosrc) from pg_proc where oid = 'public.ops_net_response_compact(bigint)'::regprocedure) = (select m from before_193) then
    raise exception 'the body did not change at all';
  end if;
  if (select length(prosrc) from pg_proc where oid = 'public.ops_net_response_compact(bigint)'::regprocedure) <> (select len from before_193) then
    raise exception 'the body length changed (16 and 64 are both two digits)';
  end if;

  -- nothing else moved: the report still has 100's 11 rows (the stub has no later history), the job table is empty
  select array_agg(check_name order by ord) into v_new from (select check_name, row_number() over () as ord from public.ops_health_report()) s;
  if cardinality(v_new) <> 11 or v_new[11] <> 'net_response_heap_mb' then
    raise exception 'the report moved: %', v_new;
  end if;
  if (select detail from public.ops_health_report() where check_name = 'net_response_heap_mb')
     <> 'uyarı >= 64 MB, hata > 200 MB; 15 dakikada bir küçültülür (ops_net_response_compact)' then
    raise exception 'the heap row detail text moved';
  end if;
end $$;

-- 2. behaviour, as the role the cron job runs (postgres here; the job calls it with no argument) -------------
-- 2a. below 16 MiB: nothing happens (also what 64 MiB would have said); above it: truncated.
do $$
declare
  v_size bigint;
  v_out text;
begin
  truncate table net._http_response;
  v_size := pg_temp.fill_to(10 * 1024 * 1024);
  if v_size >= 16 * 1024 * 1024 then raise exception 'fixture: 10 MiB fill overshot (%)', v_size; end if;
  v_out := public.ops_net_response_compact();
  if v_out not like 'ok %' then raise exception '10 MiB with the default should read ok, got %', v_out; end if;
  if (select count(*) from net._http_response) < 1000 then raise exception 'the ok path removed rows'; end if;

  -- just under 16 MiB: still ok
  v_size := pg_temp.fill_to(15 * 1024 * 1024);
  if v_size >= 16 * 1024 * 1024 then raise exception 'fixture: 15 MiB fill overshot (%)', v_size; end if;
  v_out := public.ops_net_response_compact();
  if v_out not like 'ok %' then raise exception 'under 16 MiB should read ok, got % at %', v_out, v_size; end if;

  -- above 16 MiB (and below 64): the old default would have said ok; the new one truncates
  v_size := pg_temp.fill_to(17 * 1024 * 1024);
  if v_size >= 64 * 1024 * 1024 or v_size <= 16 * 1024 * 1024 then raise exception 'fixture: expected 16-64 MiB, got %', v_size; end if;
  v_out := public.ops_net_response_compact();
  if v_out not like 'truncated %' then raise exception 'above 16 MiB with the default should truncate, got % at %', v_out, v_size; end if;
  if (select count(*) from net._http_response) <> 0 then raise exception 'the table is not empty after the truncate'; end if;
  if pg_total_relation_size('net._http_response') > 1024 * 1024 then
    raise exception 'the truncate did not return the space: %', pg_total_relation_size('net._http_response');
  end if;
  -- right after: ok again, no second truncate
  if public.ops_net_response_compact() not like 'ok %' then raise exception 'an empty table should read ok'; end if;
end $$;

-- 2b. a NULL argument falls back to 16 MiB; an explicit 64 MiB is honoured; 0 is floored to 1 MiB.
do $$
declare
  v_out text;
begin
  truncate table net._http_response;
  perform pg_temp.fill_to(20 * 1024 * 1024);
  v_out := public.ops_net_response_compact(64 * 1024 * 1024);
  if v_out not like 'ok %' then raise exception 'explicit 64 MiB must still be honoured, got %', v_out; end if;
  if (select count(*) from net._http_response) = 0 then raise exception 'explicit 64 MiB removed rows'; end if;
  v_out := public.ops_net_response_compact(null);
  if v_out not like 'truncated %' then raise exception 'NULL must fall back to 16 MiB and truncate, got %', v_out; end if;
  perform pg_temp.fill_to(2 * 1024 * 1024);
  v_out := public.ops_net_response_compact(0);
  if v_out not like 'truncated %' then raise exception '0 must be floored to 1 MiB and truncate 2 MiB, got %', v_out; end if;
  if (select count(*) from net._http_response) <> 0 then raise exception 'floor path left rows'; end if;
  -- an empty-ish table under the 1 MiB floor is never wiped by a bad argument
  insert into net._http_response (id, status_code, content, created) values (1, 200, 'x', now());
  v_out := public.ops_net_response_compact(0);
  if v_out not like 'ok %' or (select count(*) from net._http_response) <> 1 then raise exception 'a tiny table was wiped by argument 0: %', v_out; end if;
  delete from net._http_response;
end $$;

-- 2c. the other callers: anon and authenticated are refused, service_role runs it.
set role anon;
do $$
begin
  perform public.ops_net_response_compact();
  raise exception 'anon could call ops_net_response_compact';
exception when insufficient_privilege then null;
end $$;
reset role;

set role authenticated;
do $$
begin
  perform public.ops_net_response_compact();
  raise exception 'authenticated could call ops_net_response_compact';
exception when insufficient_privilege then null;
end $$;
reset role;

set role service_role;
do $$
begin
  -- the stand-in table belongs to the migrating role, not service_role, so the function (SECURITY DEFINER, owner
  -- postgres) is what truncates: service_role itself holds no privilege on the table
  if public.ops_net_response_compact() not like 'ok %' then raise exception 'service_role call failed'; end if;
end $$;
reset role;

-- 3. the cron job is not touched by 193: this stand-in has none (no pg_cron), and 193 created none ---------------
do $$
begin
  if to_regclass('cron.job') is not null then raise exception 'unexpected cron.job in the dry-run database'; end if;
  if exists (select 1 from pg_proc where proname = 'ops_net_response_compact' and pronamespace <> 'public'::regnamespace) then
    raise exception 'an unexpected second ops_net_response_compact exists';
  end if;
  if (select count(*) from net._http_response) <> 0 then raise exception 'the dry run leaves rows behind'; end if;
end $$;

select 'DRYRUN 193 OK';
