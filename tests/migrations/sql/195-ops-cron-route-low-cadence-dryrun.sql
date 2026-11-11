-- 195 ops_health_report() row 15: the fact-checks silence gap and the low-cadence streak rule (h118-crons-1):
-- local PG15 dry-run. Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55595 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55595 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/195-ops-cron-route-low-cadence-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql PGHOST=/tmp PGPORT=55595 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/195-ops-cron-route-low-cadence)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh
--
-- (\ir paths below are relative to this file.) Every check is a DO block that raises on mismatch, so a clean run
-- ending in "DRYRUN 195 OK" is the pass. Every scenario that writes sits inside begin ... rollback; the database
-- this leaves behind has the chain and 195 applied and an empty public.ops_cron_route_runs.
--
-- Order: 192's dry-run (150's chain with 114, 115, 119, 122, 136, 145 and 150 on stand-ins for pg_cron, pg_net and
-- pgmq, then 041, 157, 124, 138, 158, 161, 167, 173 and 192 twice: the report as production runs it), a gate on
-- production's fingerprint of that report, a baseline reading, then 195 TWICE, then the scenarios.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Prelude: the history 195 sits on. ------------------------------------------------------------------------
\ir 192-saved-clusters-v4-dryrun.sql

-- The deployed body is the one 195 starts from: the report as production runs it (read-only, 2026-11-11).
do $$
declare v_md5 text; v_len int; v_acl text;
begin
  select md5(prosrc), length(prosrc), proacl::text into v_md5, v_len, v_acl
    from pg_proc where oid = 'public.ops_health_report()'::regprocedure;
  if v_md5 <> 'a2252c75458b9d86a0a536b589d97ceb' or v_len <> 52463 then
    raise exception 'the local 192 body of the report differs from production (md5 gate): % / %', v_md5, v_len;
  end if;
end $$;

-- Baseline (what production runs the moment before 195): 22 rows, row 15 on the empty table, no ledger row 195. -----
create temp table before_195 as
  select check_name, status, observed, threshold, detail from public.ops_health_report();
create temp table before_fn as
  select md5(prosrc) as m, length(prosrc) as len, array(select a::text from unnest(proacl) a order by 1) as acl, proconfig::text as cfg,
         provolatile, prosecdef, prorows, procost, pg_get_function_result(oid) as res
    from pg_proc where oid = 'public.ops_health_report()'::regprocedure;

do $$
begin
  if (select count(*) from before_195) <> 22 then raise exception 'baseline: wanted 22 report rows, got %', (select count(*) from before_195); end if;
  if (select count(*) from public.ops_cron_route_runs) <> 0 then raise exception 'baseline: ops_cron_route_runs should be empty'; end if;
  if (select detail from before_195 where check_name = 'cron_route_failures_30m') <> 'son 30 dakikada cron rotası kaydı yok' then
    raise exception 'baseline: row 15 on the empty table should be the plain warn, got %', (select detail from before_195 where check_name = 'cron_route_failures_30m');
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '195') <> 0 then raise exception 'baseline: 195 must not be recorded yet'; end if;
end $$;

-- Apply: 195 TWICE (re-apply safety). ----------------------------------------------------------------------
\echo '--- first application of 195'
\ir ../../../supabase/migrations/195_ops_cron_route_low_cadence.sql
\echo '--- second application of 195 (the ledger insert must say INSERT 0 0)'
\ir ../../../supabase/migrations/195_ops_cron_route_low_cadence.sql

-- 1. schema state right after the double apply -----------------------------------------------------------------
do $$
declare
  v_acl_before text[];
  v_acl_after text[];
begin
  if (select count(*) from supabase_migrations.schema_migrations where version = '195') <> 1 then
    raise exception '195 schema_migrations row missing or duplicated';
  end if;
  if (select name from supabase_migrations.schema_migrations where version = '195') <> '195_ops_cron_route_low_cadence' then
    raise exception '195 ledger name wrong';
  end if;
  if (select count(*) from pg_proc where proname = 'ops_health_report' and pronamespace = 'public'::regnamespace) <> 1 then
    raise exception 'ops_health_report must exist exactly once (no overload from create or replace)';
  end if;

  -- the same attributes as before: plpgsql, volatile, security definer, search_path "", rows and cost, the result shape
  if exists (select 1 from before_fn b, pg_proc p
              where p.oid = 'public.ops_health_report()'::regprocedure
                and (p.provolatile <> b.provolatile or p.prosecdef <> b.prosecdef or p.proconfig::text <> b.cfg
                     or p.prorows <> b.prorows or p.procost <> b.procost or pg_get_function_result(p.oid) <> b.res
                     or p.prolang <> (select oid from pg_language where lanname = 'plpgsql'))) then
    raise exception 'ops_health_report attributes / result shape changed';
  end if;
  if not exists (select 1 from pg_proc p where p.oid = 'public.ops_health_report()'::regprocedure and p.prosecdef and p.provolatile = 'v'
                    and p.proconfig = array['search_path=""']) then
    raise exception 'ops_health_report must be volatile, security definer, search_path ""';
  end if;
  -- the body moved: it is not 192's any more
  if (select md5(p.prosrc) from pg_proc p where p.oid = 'public.ops_health_report()'::regprocedure) = (select m from before_fn) then
    raise exception 'the body did not change';
  end if;

  -- ACL: the owner and service_role only, exactly as before
  select array(select a::text from unnest(p.proacl) a order by 1) into v_acl_after
    from pg_proc p where p.oid = 'public.ops_health_report()'::regprocedure;
  select b.acl into v_acl_before from before_fn b;
  if v_acl_after is distinct from v_acl_before then raise exception 'proacl % differs from before %', v_acl_after, v_acl_before; end if;
  if cardinality(v_acl_after) <> 2 then raise exception 'proacl should have two entries (owner, service_role), got %', v_acl_after; end if;
  if has_function_privilege('anon', 'public.ops_health_report()', 'execute') then raise exception 'anon can execute the report'; end if;
  if has_function_privilege('authenticated', 'public.ops_health_report()', 'execute') then raise exception 'authenticated can execute the report'; end if;
  if not has_function_privilege('service_role', 'public.ops_health_report()', 'execute') then raise exception 'service_role cannot execute the report'; end if;

  -- the function comment lists 195 and still says 22 fixed rows
  if obj_description('public.ops_health_report()'::regprocedure, 'pg_proc') not like '%173, 192, 195): 22 fixed rows%' then
    raise exception 'the function comment does not list migration 195';
  end if;
  if obj_description('public.ops_health_report()'::regprocedure, 'pg_proc') not like '%ardışık başarısız%'
     or obj_description('public.ops_health_report()'::regprocedure, 'pg_proc') not like '%15 / 25 / 130 min%'
     or obj_description('public.ops_health_report()'::regprocedure, 'pg_proc') not like '%30 / 60 / 250 min%' then
    raise exception 'the function comment does not describe the new row 15';
  end if;
end $$;

-- 2. the report: 22 rows, every row as before (row 15 included: the table is empty), db_size_mb excepted -----------
-- db_size_mb reads pg_database_size, which moves with every catalogue write (this very migration adds a function body and
-- a comment), so it is the one row not compared by value; its text is 192's byte for byte (tests/migrations/195-...test.ts).
do $$
begin
  if (select count(*) from public.ops_health_report()) <> 22 then raise exception 'wanted 22 rows after 195'; end if;
  if (select string_agg(check_name, ',') from public.ops_health_report()) is distinct from (select string_agg(check_name, ',') from before_195) then
    raise exception 'check names or their order changed';
  end if;
  if exists (select 1 from public.ops_health_report() r join before_195 b using (check_name)
              where r.check_name <> 'db_size_mb'
                and (r.status, r.observed, r.threshold, r.detail) is distinct from (b.status, b.observed, b.threshold, b.detail)) then
    raise exception 'a row changed on the same data: %', (select string_agg(r.check_name, ',') from public.ops_health_report() r join before_195 b using (check_name)
              where r.check_name <> 'db_size_mb'
                and (r.status, r.observed, r.threshold, r.detail) is distinct from (b.status, b.observed, b.threshold, b.detail));
  end if;
  if (select threshold from public.ops_health_report() where check_name = 'cron_route_failures_30m') <> 1 then
    raise exception 'row 15 threshold moved';
  end if;
end $$;

-- 3. scenarios (each in its own rolled-back transaction) -----------------------------------------------------------
-- A row is [minutes before now(), route, status]; the report reads pg_catalog.now(), the transaction clock, so the gaps are exact.
create function pg_temp.load(p_rows jsonb) returns void language plpgsql as $f$
begin
  delete from public.ops_cron_route_runs;
  insert into public.ops_cron_route_runs (ran_at, route, status, ok, duration_ms)
  select now() - (e->>0)::numeric * interval '1 minute', e->>1, (e->>2)::int, (e->>2)::int < 500, 120
    from jsonb_array_elements(p_rows) e;
end $f$;

create function pg_temp.r15() returns text language sql as $f$
  select status || '|' || coalesce(observed::text, '') || '|' || coalesce(detail, '')
    from public.ops_health_report() where check_name = 'cron_route_failures_30m'
$f$;

create function pg_temp.expect(p_label text, p_want text) returns void language plpgsql as $f$
declare v_got text := pg_temp.r15();
begin
  if v_got is distinct from p_want then
    raise exception 'scenario %: wanted [%] got [%]', p_label, p_want, v_got;
  end if;
end $f$;

-- healthy base: headline 6 runs and alerts-webhooks 3 runs inside 30 minutes, all 200 (9 runs)
create function pg_temp.base() returns jsonb language sql as $f$
  select '[[1,"headline",200],[6,"headline",200],[11,"headline",200],[16,"headline",200],[21,"headline",200],[26,"headline",200],
           [2,"alerts-webhooks",200],[12,"alerts-webhooks",200],[22,"alerts-webhooks",200]]'::jsonb
$f$;

-- healthy: pass
begin;
select pg_temp.load(pg_temp.base() || '[[23,"fact-checks",200],[83,"fact-checks",200]]'::jsonb);
select pg_temp.expect('healthy', 'pass|0|son 30 dakikada 10 çalışma, başarısız yok');
rollback;

-- spec 1: the two newest fact-checks rows are 500 -> fail (192 read pass on these rows)
begin;
select pg_temp.load(pg_temp.base() || '[[45,"fact-checks",500],[105,"fact-checks",500]]'::jsonb);
select pg_temp.expect('fact-checks 500 x2', 'fail|1|son 30 dakikada 9 çalışma, başarısız yok · ardışık başarısız: fact-checks 2/2');
rollback;

-- the same two failures, the newest inside the 30 minute window: fail with both rules named
begin;
select pg_temp.load(pg_temp.base() || '[[23,"fact-checks",500],[83,"fact-checks",500]]'::jsonb);
select pg_temp.expect('fact-checks 500 x2 in window', 'fail|2|son 30 dakikada başarısız: fact-checks 1/1 · ardışık başarısız: fact-checks 2/2');
rollback;

-- spec 2: the newest is 500 and the previous is 200 -> warn, even though the row is older than 30 minutes
begin;
select pg_temp.load(pg_temp.base() || '[[45,"fact-checks",500],[105,"fact-checks",200]]'::jsonb);
select pg_temp.expect('fact-checks 500 then 200', 'warn|1|son 30 dakikada 9 çalışma, başarısız yok · ardışık başarısız: fact-checks 1/2');
rollback;

-- an older failure behind a newer success is not counted
begin;
select pg_temp.load(pg_temp.base() || '[[45,"fact-checks",200],[105,"fact-checks",500],[165,"fact-checks",500]]'::jsonb);
select pg_temp.expect('fact-checks 200 then 500 x2', 'pass|0|son 30 dakikada 9 çalışma, başarısız yok');
rollback;

-- spec 4: headline 2 failures of 6 inside 30 minutes is a warn, as before; 3 of 6 is a fail, as before
begin;
select pg_temp.load('[[1,"headline",500],[6,"headline",500],[11,"headline",200],[16,"headline",200],[21,"headline",200],[26,"headline",200],
                      [2,"alerts-webhooks",200],[12,"alerts-webhooks",200],[22,"alerts-webhooks",200],[23,"fact-checks",200]]'::jsonb);
select pg_temp.expect('headline 2/6', 'warn|2|son 30 dakikada başarısız: headline 2/6');
rollback;
begin;
select pg_temp.load('[[1,"headline",500],[6,"headline",500],[11,"headline",500],[16,"headline",200],[21,"headline",200],[26,"headline",200],
                      [2,"alerts-webhooks",200],[12,"alerts-webhooks",200],[22,"alerts-webhooks",200],[23,"fact-checks",200]]'::jsonb);
select pg_temp.expect('headline 3/6', 'fail|3|son 30 dakikada başarısız: headline 3/6');
rollback;

-- spec 5 and the gap boundaries: fact-checks newest row 260 minutes old -> fail; 129 / 130 pass, 131 warn, 250 warn, 251 fail
begin;
select pg_temp.load(pg_temp.base() || '[[260,"fact-checks",200]]'::jsonb);
select pg_temp.expect('fact-checks silent 260', 'fail|1|son 30 dakikada 9 çalışma, başarısız yok · kayıt gelmiyor: fact-checks 260 dk');
rollback;
begin;
select pg_temp.load(pg_temp.base() || '[[130,"fact-checks",200]]'::jsonb);
select pg_temp.expect('fact-checks silent 130', 'pass|0|son 30 dakikada 9 çalışma, başarısız yok');
rollback;
begin;
select pg_temp.load(pg_temp.base() || '[[131,"fact-checks",200]]'::jsonb);
select pg_temp.expect('fact-checks silent 131', 'warn|1|son 30 dakikada 9 çalışma, başarısız yok · kayıt gelmiyor: fact-checks 131 dk');
rollback;
begin;
select pg_temp.load(pg_temp.base() || '[[250,"fact-checks",200]]'::jsonb);
select pg_temp.expect('fact-checks silent 250', 'warn|1|son 30 dakikada 9 çalışma, başarısız yok · kayıt gelmiyor: fact-checks 250 dk');
rollback;
begin;
select pg_temp.load(pg_temp.base() || '[[251,"fact-checks",200]]'::jsonb);
select pg_temp.expect('fact-checks silent 251', 'fail|1|son 30 dakikada 9 çalışma, başarısız yok · kayıt gelmiyor: fact-checks 251 dk');
rollback;

-- a route that never recorded is not flagged
begin;
select pg_temp.load(pg_temp.base());
select pg_temp.expect('fact-checks never recorded', 'pass|0|son 30 dakikada 9 çalışma, başarısız yok');
rollback;

-- headline and alerts-webhooks silence is unchanged
begin;
select pg_temp.load('[[31,"headline",200],[2,"alerts-webhooks",200],[12,"alerts-webhooks",200],[22,"alerts-webhooks",200],[23,"fact-checks",200]]'::jsonb);
select pg_temp.expect('headline silent 31', 'fail|1|son 30 dakikada 4 çalışma, başarısız yok · kayıt gelmiyor: headline 31 dk');
rollback;

-- social: a failing pair fails; social silence is not a gap rule (12 hours without a row passes)
begin;
select pg_temp.load(pg_temp.base() || '[[45,"social",500],[65,"social",500]]'::jsonb);
select pg_temp.expect('social 500 x2', 'fail|1|son 30 dakikada 9 çalışma, başarısız yok · ardışık başarısız: social 2/2');
rollback;
begin;
select pg_temp.load(pg_temp.base() || '[[720,"social",200],[740,"social",200]]'::jsonb);
select pg_temp.expect('social silent overnight', 'pass|0|son 30 dakikada 9 çalışma, başarısız yok');
rollback;

-- digest: two failing weekend rows fail until a later success; one failing row warns
begin;
select pg_temp.load(pg_temp.base() || '[[4320,"digest",500],[2880,"digest",500]]'::jsonb);
select pg_temp.expect('digest 500 x2', 'fail|1|son 30 dakikada 9 çalışma, başarısız yok · ardışık başarısız: digest 2/2');
rollback;
begin;
select pg_temp.load(pg_temp.base() || '[[4320,"digest",500]]'::jsonb);
select pg_temp.expect('digest 500 x1', 'warn|1|son 30 dakikada 9 çalışma, başarısız yok · ardışık başarısız: digest 1/2');
rollback;
begin;
select pg_temp.load(pg_temp.base() || '[[1440,"digest",200],[2880,"digest",500],[4320,"digest",500]]'::jsonb);
select pg_temp.expect('digest recovered', 'pass|0|son 30 dakikada 9 çalışma, başarısız yok');
rollback;

-- two low-cadence routes: worst streak first
begin;
select pg_temp.load(pg_temp.base() || '[[23,"fact-checks",200],[45,"social",500],[65,"social",200],[4320,"digest",500],[2880,"digest",500]]'::jsonb);
select pg_temp.expect('digest and social', 'fail|2|son 30 dakikada 10 çalışma, başarısız yok · ardışık başarısız: digest 2/2, social 1/2');
rollback;

-- rows older than the 7 day retention do not count
begin;
select pg_temp.load(pg_temp.base() || '[[11520,"fact-checks",500],[11580,"fact-checks",500]]'::jsonb);
select pg_temp.expect('fact-checks 500 x2 eight days ago', 'pass|0|son 30 dakikada 9 çalışma, başarısız yok');
rollback;

-- a failing low-cadence route is not hidden by the empty-window warn; with no rows at all the plain warn stays
begin;
select pg_temp.load('[[45,"fact-checks",500],[105,"fact-checks",500]]'::jsonb);
select pg_temp.expect('empty window, fact-checks 500 x2', 'fail|1|son 30 dakikada cron rotası kaydı yok · ardışık başarısız: fact-checks 2/2');
rollback;
begin;
select pg_temp.load('[]'::jsonb);
select pg_temp.expect('no rows', 'warn||son 30 dakikada cron rotası kaydı yok');
rollback;

-- 4. the other rows never move with row 15's fixtures ------------------------------------------------------------------
begin;
select pg_temp.load(pg_temp.base() || '[[45,"fact-checks",500],[105,"fact-checks",500]]'::jsonb);
do $$
begin
  if exists (select 1 from public.ops_health_report() r join before_195 b using (check_name)
              where r.check_name not in ('cron_route_failures_30m', 'db_size_mb')
                and (r.status, r.observed, r.threshold, r.detail) is distinct from (b.status, b.observed, b.threshold, b.detail)) then
    raise exception 'a row other than 15 changed with the route fixtures: %', (select string_agg(r.check_name, ',') from public.ops_health_report() r join before_195 b using (check_name)
              where r.check_name not in ('cron_route_failures_30m', 'db_size_mb')
                and (r.status, r.observed, r.threshold, r.detail) is distinct from (b.status, b.observed, b.threshold, b.detail));
  end if;
end $$;
rollback;

do $$
begin
  if (select count(*) from public.ops_cron_route_runs) <> 0 then raise exception 'a rolled-back fixture survived'; end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '195') <> 1 then raise exception '195 ledger row lost'; end if;
end $$;

select 'DRYRUN 195 OK';
