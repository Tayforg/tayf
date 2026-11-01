-- 136_ops_heartbeat_app_side.sql
--
-- The ops heartbeat learns to see the app. ops_health_report() gets a fifteenth
-- row, `cron_route_failures_30m` (the outcomes of the Vercel cron routes), and a
-- sixteenth, `db_size_mb` (database size against two limits). Rows 1-14 are
-- 122's, byte for byte. The outcomes come from a new table, public.ops_cron_route_runs,
-- that the five /api/cron/* routes fill through a service-role RPC after every
-- authenticated run (src/lib/ops/cron-route-outcome.ts, h12-ops-1).
--
-- WHY (evidence: production, read-only, 2026-11-01)
--   * 189 x `canceling statement due to statement timeout` from postgrest in
--     postgres_logs, all on the clusters headline-pick query (title_tr_neutral IS
--     NULL ...), from 2026-10-31 16:10:26 UTC (the start of the 24 h window, so the
--     onset was earlier) to 2026-11-01 10:30:26 UTC: 18+ hours. src/app/api/cron/
--     headline/route.ts turned each one into apiServerError, a 500, every 5 minutes.
--     The cause is fixed (migration 127, #147: partial indexes), but no row of
--     ops_health_report() reads app-route outcomes: a failing Vercel cron route
--     leaves nothing in pg_cron (it only fires the HTTP request), pg_net or
--     ingest_cycles. .github/workflows/page-latency.yml is workflow_dispatch only.
--   * Disk: pg_database_size was 6252 MB (jev_shadow_predictions 3142 MB, articles
--     2016 MB) and no check watched it (grep -rn 'pg_database_size|db_size' over
--     supabase/migrations, scripts, src and docs found nothing).
--
-- WHAT CHANGES (pinned by tests/migrations/136-ops-heartbeat-app-side.test.ts,
-- tests/guards/ops-health-checks.test.ts and tests/guards/cron-route-outcome.test.ts)
--   1. public.ops_cron_route_runs (id identity, ran_at, route, status, ok,
--      duration_ms), an index on ran_at, RLS on, no policy. Every privilege of
--      anon, authenticated and public is revoked on the table and its sequence,
--      plus the PG17-guarded MAINTAIN revoke (131's block). Nothing is granted.
--   2. ops_cron_route_run_record(p_route, p_status, p_duration_ms): raises on a
--      route that does not match ^[a-z0-9-]{1,40}$ or a status outside 100-599,
--      clamps the duration to 0-3600000, inserts with ok := status < 500.
--      ops_cron_route_runs_prune(): removes rows older than 7 days.
--      ops_db_size_limits(): an immutable constant, warn 7000 / fail 7600 MB.
--      All three SECURITY DEFINER, search_path = '', revoked from public, anon and
--      authenticated, execute for service_role only.
--   3. ops_health_report() is re-created with 122's text VERBATIM, comments
--      included, from the create line through row 14's last `return next;` (the
--      test compares the raw text and the declare block), then:
--      Row 15, `cron_route_failures_30m`, threshold 1:
--        window    public.ops_cron_route_runs with ran_at in the last 30 minutes;
--        observed  the runs with status >= 500;
--        status    'fail' when some route has at least 2 failures that are at
--                  least half of its runs; 'warn' on any other failure; 'pass'
--                  otherwise; 'warn' with observed null and `son 30 dakikada cron
--                  rotası kaydı yok` when the window holds no run; 'unknown' with
--                  `ops_cron_route_runs yok` if the table is missing, or with the
--                  first 200 characters of the error;
--        detail    `son 30 dakikada başarısız: headline 6/6, social 1/2` (route,
--                  failures/runs; routes that fail the rule first, then most
--                  failures), cut at 500 characters; `son 30 dakikada n çalışma,
--                  başarısız yok` on pass.
--        silence   (added in the review of h12-ops-1) a run that Vercel kills at
--                  maxDuration (60 s: 504 FUNCTION_INVOCATION_TIMEOUT) never reaches
--                  withCronOutcome's finally/after(), so it leaves no row at all and the
--                  counts above cannot see it: headline (every 5 minutes, sequential LLM
--                  calls, no wall-clock budget) could time out on every tick while
--                  alerts-webhooks (every 10) keeps writing 200 rows and the row reads
--                  pass. So the newest row of each route in a VALUES list is also
--                  compared with a gap: headline 15 / 30 minutes, alerts-webhooks
--                  25 / 60 (warn above the first, fail above the second; three and six
--                  ticks for headline, 2.5 and six for alerts-webhooks; strictly above,
--                  so a row exactly on the limit is still on time). Only a route that
--                  has a row within the table's 7 day retention can be silent (a route
--                  that has never recorded has nothing to be compared with, and the
--                  first rows after the deploy must not warn); fact-checks (hourly),
--                  social (every 20 minutes from 05:00 to 20:59 UTC only) and digest
--                  (weekly) are not listed: a gap rule would warn every night or week.
--                  `observed` becomes failures + silent routes, the detail appends
--                  ` · kayıt gelmiyor: headline 31 dk, alerts-webhooks 27 dk` (the whole
--                  minutes since the newest row, longest first), and an empty 30 minute
--                  window with a silent route reads that route instead of the bare
--                  `kaydı yok` warn (its status is then the route's warn or fail).
--                  tests/guards/ops-health-checks.test.ts ties the list to vercel.ts
--                  (warn >= 2 ticks, fail >= 6 ticks of the route's own schedule).
--                  Stopping a listed route on purpose (Vercel cron paused, route
--                  retired) needs a create or replace of this function without it.
--      Row 16, `db_size_mb`, threshold = the warn limit:
--        observed  round(pg_database_size(current_database()) / 1 MiB);
--        status    'fail' at or above fail_mb, 'warn' at or above warn_mb, else
--                  'pass', the limits read from public.ops_db_size_limits();
--        detail    `veritabanı n MB · uyarı w MB · kritik f MB · en büyük: rel mb
--                  MB, ...` (the three biggest public tables and materialized
--                  views by pg_total_relation_size); 'unknown' on any error.
--      The function comment is 122's with `(migrations ..., 122, 136): 16 fixed
--      rows` and the two descriptions before ` status is one of`. Revoke all from
--      public, anon, authenticated; execute for service_role only.
--   4. pg_cron job 'ops-cron-route-runs-prune', '17 4 * * *' (04:15 jev-budget-
--      nightly and 04:20 alias-prune are the neighbours), scheduled by name behind
--      a pg_cron existence guard; a job of that name is unscheduled first, no other
--      job is touched. Without pg_cron (local, CI) it raises a notice and skips.
--   5. notify pgrst 'reload schema' (the app calls the RPC through PostgREST), and
--      the ledger row in the 095 pattern.
--   Why a fail needs 2 failures: headline runs every 5 minutes (6 per window), so an
--   outage like 2026-10-31 reads 6/6 and fails inside one window; digest
--   (weekly), fact-checks (hourly) and social (every 20 minutes in the day) have too
--   few runs for one transient 500 to mean an outage, so one failure only warns, and
--   a warn does not page (exit 1 only on 'fail', an empty report or mostly 'unknown').
--   The heartbeat (scripts/lib/ops-heartbeat.mjs), /durum and /api/health do not
--   depend on the row count or the names.
--   The bias -> zone VALUES list of row 4 is repeated once more; it is pinned by the
--   same test and listed in tests/migrations/zone-parity.test.ts KNOWN_FILES.
--   Limits: 7000 / 7600 MB are the defaults for the 8 GB Pro allowance (about 85% /
--   93% of 8192 MB), chosen so that today's 6252 MB reads pass. The stated policy is
--   70% / 85% of the disk that is actually provisioned; with 8192 MB that would be
--   5734 / 6963 and today's size would already warn. The founder sets the real numbers
--   with `create or replace function public.ops_db_size_limits()` once the disk size
--   is confirmed (docs/ops-heartbeat.md, row 16). Nothing in this file needs it.
--
-- STEP 0 (production, read-only, 2026-11-01, via SELECT only; nothing was applied)
--   a) Version 136 is free: the ledger's newest three-digit version is '134' and it
--      has no '135' (reserved for the clusters index of the same wave) or '136'.
--   b) The deployed ops_health_report() is the one this file copies:
--      select md5(prosrc), length(prosrc), prosecdef, provolatile, proacl ->
--      f6548a98c236a3b998fedf8c192e6b7c, 19,091 characters, true, v,
--      {postgres=X/postgres,service_role=X/postgres}: 122's fingerprint exactly
--      (see 122's DRY RUNS), so there is no drift to carry over.
--   c) pg_database_size = 6253 MB (PostgreSQL 17.6, so the MAINTAIN revoke is live
--      there). The five biggest public relations by pg_total_relation_size:
--      jev_shadow_predictions 3144 MB, articles 2017 MB, clusters 533 MB,
--      kap_disclosures 215 MB, cluster_articles 76 MB.
--   d) cron.job has no 'ops-cron-route-runs-prune'. 04:17 is free (04:05
--      jev-signals-nightly, 04:10 prune-nightly, 04:15 jev-budget-nightly, 04:20
--      alias-prune, 04:25 bars-5m-prune, 04:40 ops-exhaust-prune and reader-data-purge,
--      04:50 jev-shadow-prune).
--   e) Cost of row 16's top-three read: explain (analyze) -> 14.4 ms, a seq scan of
--      pg_class (1,154 rows, 187 tables and views) and 68 public relations sized.
--      Row 15, on a 3,500 row copy of the table (rolled back): an index scan on
--      ops_cron_route_runs_ran_at_idx, 11 rows, 0.02 ms.
--   f) Volume: vercel.ts schedules headline */5, alerts-webhooks */10, social */20
--      from 05:00 to 20:59 UTC, fact-checks hourly, digest weekly: about 500 rows a
--      day, about 3.5k rows at the 7 day retention. A plain create index is enough
--      (no ORCHESTRATOR PRE-BUILD step as in 101/127: the table is new and tiny).
--
-- DRY RUNS (×2) (local PG15.12, throwaway cluster scratchpad/pg-aj-c on port 55436,
-- 2026-11-01; the shared stub schema (jevtest/qa/stub.sql) plus, added in a scratch
-- setup and not in this file: default privileges that mimic Supabase's pre-117
-- (all on tables, sequences and functions to anon, authenticated, service_role),
-- articles.created_at, the sources fetch_* columns and the ingest_cycles,
-- jev_shadow_runs and jev_alerts shapes the report reads). 114, 115, 119 and 122
-- were applied first (md5(prosrc) f6548a98c236a3b998fedf8c192e6b7c, 19,091
-- characters, 14 rows: the production fingerprint), then this file twice in a row,
-- each with psql -v ON_ERROR_STOP=1 -f, once in a database without pg_cron and
-- once in one with a fake cron schema (cron.job, cron.schedule, cron.unschedule and
-- a pg_extension row, with 'other-job' and 'ingest-drain' in cron.job):
--   run 1   BEGIN, CREATE TABLE, CREATE INDEX, COMMENT, ALTER TABLE, REVOKE, REVOKE,
--           DO, then CREATE FUNCTION, COMMENT, REVOKE, GRANT four times, DO, NOTIFY,
--           INSERT 0 1, COMMIT
--   run 2   the same statements, no error; notices `relation ... already exists,
--           skipping` for the table and the index; the ledger insert is INSERT 0 0
--   no pg_cron  both runs: NOTICE `136: pg_cron missing, skipping the
--           ops-cron-route-runs-prune schedule.`
--   fake cron   after two runs cron.job holds one 'ops-cron-route-runs-prune' at
--           '17 4 * * *' with the prune command, and 'other-job' and 'ingest-drain'
--           untouched
--   After   ledger 114, 115, 119, 122, 136; ops_health_report() returns 16 rows;
--           md5(prosrc) e162202811feb63b15f26e6c3f6d4cfd (23,194 characters);
--           security definer, volatile, search_path = "".
--   Grants  has_function_privilege execute is false for anon and authenticated and
--           true for service_role on all four functions; direct calls as anon and
--           authenticated fail with `permission denied for function`, select as anon
--           and insert as authenticated with `permission denied for table`; no ACL
--           entry for public; RLS on; set role service_role can record and read the
--           report. The PG17 branch of the MAINTAIN block cannot run on PG15 (the
--           guard skips it); it is 131's block, which the test pins character for
--           character, and 131 is live on PG 17.6.
--   Rows 1-14 (the TAYF_PSQL block of the test, in ONE transaction): a pg_temp copy
--           of 122's function, built from the 122 file text, returns the same 14
--           rows as the first 14 of public.ops_health_report() (array_agg of the
--           row text compared with =): identical.
--   Fixtures (rolled-back transactions; the six runs written through the RPC as
--           service_role, ran_at = the transaction clock):
--           OUTAGE PROOF, six 'headline' rows with status 500 inside 30 minutes:
--             fail / observed 6 / threshold 1 / `son 30 dakikada başarısız:
--             headline 6/6`;
--           1 failure of 6: warn / 1 / `... headline 1/6`; 1 of 1: warn / 1 /
--             `... social 1/1`; 0 of 6: pass / 0 / `son 30 dakikada 6 çalışma,
--             başarısız yok`; 2 of 4 and 2 of 2: fail; 2 of 5 and 1 of 2: warn;
--           headline 6/6 + social 1/2 + digest 0/3: fail / 7 / `... headline 6/6,
--             social 1/2` (healthy runs of other routes do not dilute);
--           an empty table, or only rows older than 30 minutes: warn / null /
--             `son 30 dakikada cron rotası kaydı yok`;
--           statuses 400, 401, 429 and 499 do not count, 500 and 599 do;
--           db_size_mb: pass / 8 / threshold 7000 / `veritabanı 8 MB · uyarı 7000 MB ·
--             kritik 7600 MB · en büyük: ...` on the 8 MB local database; with
--             ops_db_size_limits() replaced by (1, 2) inside the transaction: fail;
--             by (1, 1000000): warn; the rollback restores 7000 / 7600;
--           the RPC stores ok = status < 500 and clamps the duration (-5 -> 0,
--             99999999 -> 3600000, null -> 0); it raises `invalid route` / `invalid
--             status` for 'Bad Route', '', null, 'a/b', 99, 600 and a null status;
--           the prune removes rows older than 7 days and keeps the rest;
--           16 rows, in order, the last two cron_route_failures_30m and db_size_mb.
--           Test counts: 64 tests in the 136 file (46 static, 18 live), all passing
--           against this database, in the one without pg_cron and in the one with it.
--   Mutation checks (five mutated copies, each applied to a fresh database, the live
--           block run against it): a fail rule of 1 failure instead of 2, a changed
--           row-3 threshold (rows 1-14 no longer 122's), the table privileges not
--           revoked from anon, a 60 minute window, and ok := status <= 500 in the RPC
--           were each caught by at least one live test.
--   Rollback rehearsed: 122 re-applied, the job unscheduled, the three functions and
--           the table dropped, ledger row 136 removed: 14 rows and md5(prosrc)
--           f6548a98c236a3b998fedf8c192e6b7c again, ledger 114, 115, 119, 122; then
--           this file twice more: INSERT 0 1, then INSERT 0 0 (16 rows).
--   Fix pass (review of h12-ops-1: the silence rule of row 15, a run Vercel kills at
--           maxDuration writes no row). Dry-run again on a second throwaway cluster,
--           scratchpad/pg-aj-fix on port 55440, the same stub and prerequisites, 114, 115,
--           119 and 122 first, then this file twice in a row in a database without
--           pg_cron and in one with the fake cron schema: the same statements as above,
--           ledger INSERT 0 1 then INSERT 0 0, 16 rows, one 'ops-cron-route-runs-prune'
--           job at '17 4 * * *' with 'other-job' and 'ingest-drain' untouched; after:
--           md5(prosrc) a2b0b84c193022c78547beb0296e5f0c (25,536 characters), security
--           definer, volatile, search_path = "". Rows 1-14 are still 122's (the side-by-side
--           proof above passes). Cost of the silence query on a 3,500 row copy of the table
--           (every row inside the 7 day look-back, rolled back): 0.7 ms (a scan of the table,
--           a hash join to the two-row list); the whole report 4.7 ms. Test counts: 75 tests
--           in the 136 file (48 static, 27 live), all passing against both databases.
--           New fixtures: headline silent 31 minutes while alerts-webhooks writes 200s (fail,
--           `kayıt gelmiyor: headline 31 dk`); the exact limits (15 and 30 minutes for
--           headline, 25 and 60 for alerts-webhooks: strictly above); an old 504 is still
--           silence; failures plus silence (observed 7); both routes silent, longest first;
--           fact-checks, social and digest never stale; a route that never recorded is not
--           flagged; a route silent for 3 days still fails (7 day look-back); rows older
--           than 7 days are no history. Mutation checks (seven mutated copies, each applied
--           to a fresh database, the live block run against it): `>=` instead of `>` on the
--           warn gap, a 24 hour look-back, no fail on silence, observed without the silent
--           routes, shortest silence first, a third route in the list, and an empty window
--           that ignores silence were each caught by at least one test.
--
-- DEPLOY: APPLY 136, THEN LET THE APP DEPLOY
--   1. Apply this file (docs/migration-guide.md, operator). The next heartbeat run, and
--      the 10 minute snapshot (131), shows rows 15 and 16. Until the app that carries
--      withCronOutcome is deployed, row 15 reads warn `son 30 dakikada cron rotası
--      kaydı yok`: a warn, no page.
--   2. Deploy the app (Vercel, the usual merge deploy). The first authenticated cron
--      tick (headline, at most 5 minutes) writes the first row. CRON_SECRET must be
--      set in the Vercel project, as it already has to be: without it the routes answer
--      503 and nothing is recorded (an unauthenticated call is never recorded). No
--      Edge Function changes; nothing to redeploy there.
--   3. Optional, later: set the real disk limits with create or replace function
--      public.ops_db_size_limits() (docs/ops-heartbeat.md).
--   If the app is deployed before the migration, the RPC does not exist yet: the
--   wrapper swallows the error and logs one `[cron-outcome]` warning per instance;
--   the routes are unaffected.
--
-- VERIFY (read-only unless noted):
--   select count(*) from public.ops_health_report();    -- expect 16
--   select check_name, status, observed, threshold, detail from public.ops_health_report()
--    where check_name in ('cron_route_failures_30m', 'db_size_mb');
--      -- db_size_mb: pass / about 6253 / 7000; cron_route_failures_30m: pass after the
--      -- app deploy, `son 30 dakikada n çalışma, başarısız yok`
--   select route, count(*), count(*) filter (where status >= 500) as failed, max(ran_at)
--     from public.ops_cron_route_runs group by route order by route;
--      -- expect a row for headline and for alerts-webhooks within about 15 minutes of
--      -- the first authenticated ticks; a listed route that never appears here is not
--      -- flagged by row 15 (nothing to compare with), so look at it by hand once
--   select jobname, schedule, active from cron.job where jobname = 'ops-cron-route-runs-prune';
--   select has_function_privilege('anon', 'public.ops_cron_route_run_record(text, integer, integer)', 'execute'),
--          has_function_privilege('service_role', 'public.ops_cron_route_run_record(text, integer, integer)', 'execute'),
--          has_table_privilege('anon', 'public.ops_cron_route_runs', 'select');
--      -- expect f, t, f
--
-- ROLLBACK (nothing else depends on 136; run by the operator)
--   re-apply 122_ops_ingest_gaps.sql whole (it is idempotent: it re-creates
--     ops_health_report() with its comment, revoke and grant, which returns the report
--     to 14 rows);
--   then:
--     select cron.unschedule('ops-cron-route-runs-prune');
--     drop function public.ops_cron_route_run_record(text, integer, integer);
--     drop function public.ops_cron_route_runs_prune();
--     drop function public.ops_db_size_limits();
--     drop table public.ops_cron_route_runs;
--     delete from supabase_migrations.schema_migrations where version = '136';   -- ledger row 136
--   The app tolerates the missing RPC (one warning per instance); revert the route
--   wrappers only if you want the warning gone.
--
-- Additive. Safe to re-apply (create table / index if not exists, create or replace
-- function, a job unscheduled by name before it is scheduled again, ledger insert on
-- conflict do nothing). One transaction; no ALTER of an existing object, no data
-- rewrite, no lock of note (a new table, plus the catalog lock create or replace
-- function takes on its functions). No CONCURRENTLY step, no grant to anon or
-- authenticated.

begin;

-- ---------------------------------------------------------------------------
-- 1. public.ops_cron_route_runs: one row per authenticated /api/cron/* run.
-- ---------------------------------------------------------------------------

create table if not exists public.ops_cron_route_runs (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default now(),
  route text not null check (route ~ '^[a-z0-9-]{1,40}$'),
  status smallint not null check (status between 100 and 599),
  ok boolean not null,
  duration_ms integer not null check (duration_ms between 0 and 3600000)
);

create index if not exists ops_cron_route_runs_ran_at_idx
  on public.ops_cron_route_runs (ran_at);

comment on table public.ops_cron_route_runs is
  'One row per authenticated run of a Vercel cron route (headline, digest, '
  'fact-checks, social, alerts-webhooks), written by withCronOutcome '
  '(src/lib/ops/cron-route-outcome.ts) through ops_cron_route_run_record(). '
  'ok is status < 500. Read by ops_health_report() row 15 '
  '(cron_route_failures_30m); pruned after 7 days by the pg_cron job '
  'ops-cron-route-runs-prune (migration 136). Owner and service_role '
  'functions only.';

alter table public.ops_cron_route_runs enable row level security;

-- Supabase default privileges hand new tables to anon/authenticated (incl.
-- write privileges, cf. 091/095): strip them. Nothing is given back; only the
-- SECURITY DEFINER functions below touch this table.
revoke all on public.ops_cron_route_runs from anon, authenticated, public;
revoke all on sequence public.ops_cron_route_runs_id_seq from anon, authenticated, public;

-- PG17 added the MAINTAIN privilege; it does not exist before PG17 (revoking it
-- would be a syntax error), so guard.
do $maint$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on public.ops_cron_route_runs from anon, authenticated';
  end if;
end
$maint$;

-- ---------------------------------------------------------------------------
-- 2. The service-role insert RPC, the prune and the size limits.
-- ---------------------------------------------------------------------------

-- 2a. One outcome. The route literal and the status are validated (a bug in
-- the caller must not store garbage); the duration is clamped, not rejected.
create or replace function public.ops_cron_route_run_record(p_route text, p_status integer, p_duration_ms integer)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_route is null or p_route !~ '^[a-z0-9-]{1,40}$' then
    raise exception 'ops_cron_route_run_record: invalid route' using errcode = '22023';
  end if;
  if p_status is null or p_status < 100 or p_status > 599 then
    raise exception 'ops_cron_route_run_record: invalid status' using errcode = '22023';
  end if;

  insert into public.ops_cron_route_runs (route, status, ok, duration_ms)
  values (p_route, p_status::smallint, p_status < 500,
          least(greatest(coalesce(p_duration_ms, 0), 0), 3600000));
end
$fn$;

comment on function public.ops_cron_route_run_record(text, integer, integer) is
  'Stores one cron route outcome (route, HTTP status, duration in ms) in '
  'ops_cron_route_runs (migration 136). Raises on a route that does not match '
  '^[a-z0-9-]{1,40}$ or a status outside 100-599; the duration is clamped to '
  '0-3600000. Called by withCronOutcome after the response. service_role only.';

revoke all on function public.ops_cron_route_run_record(text, integer, integer) from public, anon, authenticated;
grant execute on function public.ops_cron_route_run_record(text, integer, integer) to service_role;

-- 2b. Retention: 7 days (the report reads 30 minutes).
create or replace function public.ops_cron_route_runs_prune()
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_n integer;
begin
  delete from public.ops_cron_route_runs
   where ran_at < pg_catalog.now() - interval '7 days';
  get diagnostics v_n = row_count;
  return v_n;
end
$fn$;

comment on function public.ops_cron_route_runs_prune() is
  'Removes ops_cron_route_runs rows older than 7 days and returns how many '
  '(migration 136). Scheduled daily as ops-cron-route-runs-prune. service_role only.';

revoke all on function public.ops_cron_route_runs_prune() from public, anon, authenticated;
grant execute on function public.ops_cron_route_runs_prune() to service_role;

-- 2c. The disk limits row 16 compares pg_database_size() with, in MB. A constant
-- on purpose: no table, nothing to grant; the founder changes it with create or
-- replace when the disk is resized.
create or replace function public.ops_db_size_limits()
returns table (warn_mb numeric, fail_mb numeric)
language sql
immutable
security definer
set search_path = ''
as $fn$
  select 7000::numeric, 7600::numeric
$fn$;

comment on function public.ops_db_size_limits() is
  'Warn and fail limits in MB for ops_health_report() row 16 (db_size_mb), '
  'migration 136: 7000 / 7600, the defaults for the 8 GB Pro allowance. '
  'Set to 70%/85% of the provisioned disk; change with create or replace. '
  'service_role only.';

revoke all on function public.ops_db_size_limits() from public, anon, authenticated;
grant execute on function public.ops_db_size_limits() to service_role;

-- ---------------------------------------------------------------------------
-- 3. ops_health_report(): 122's body, rows 1-14 byte for byte (comments
-- included), plus rows 15 (cron_route_failures_30m) and 16 (db_size_mb). Same
-- returns table, plpgsql, volatile, security definer, search_path = ''.
-- ---------------------------------------------------------------------------

create or replace function public.ops_health_report()
returns table (check_name text, status text, observed numeric, threshold numeric, detail text)
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
#variable_conflict use_column
declare
  v_now    timestamptz := pg_catalog.now();
  v_n      numeric;
  v_total  numeric;
  v_jobs   numeric;
  v_active boolean;
  v_last   timestamptz;
  v_text   text;
  v_zone   text;
  v_zero   numeric;
  v_tmo    numeric;
begin
  -- 1. pg_cron failures, last 30 min, all jobs
  check_name := 'cron_failed_runs_30m'; threshold := 1; observed := null; detail := null;
  begin
    if pg_catalog.to_regclass('cron.job_run_details') is null then
      status := 'unknown'; detail := 'pg_cron yok';
    else
      execute $q$
        select pg_catalog.count(*)::numeric,
               pg_catalog.string_agg(distinct coalesce(j.jobname, d.jobid::text), ', ')
          from cron.job_run_details d
          left join cron.job j on j.jobid = d.jobid
         where d.runid > (select coalesce(pg_catalog.max(x.runid), 0) - 5000 from cron.job_run_details x)
           and d.start_time >= pg_catalog.now() - interval '30 minutes'
           and d.status = 'failed'
      $q$ into v_n, v_text;
      observed := v_n;
      status := case when v_n >= 1 then 'fail' else 'pass' end;
      detail := v_text;
    end if;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 2. Edge Function HTTP outcomes (pg_net keeps ~6 h)
  check_name := 'edge_http_errors_30m'; threshold := 5; observed := null; detail := null;
  begin
    if pg_catalog.to_regclass('net._http_response') is null then
      status := 'unknown'; detail := 'pg_net yok';
    else
      execute $q$
        select pg_catalog.count(*) filter (where r.status_code >= 500 or r.status_code in (401, 403)
                                              or r.timed_out or r.error_msg is not null)::numeric,
               pg_catalog.count(*)::numeric,
               pg_catalog.string_agg(distinct coalesce(r.status_code::text, 'hata'), ', ')
                 filter (where r.status_code >= 500 or r.status_code in (401, 403)
                            or r.timed_out or r.error_msg is not null)
          from net._http_response r
         where r.created >= pg_catalog.now() - interval '30 minutes'
      $q$ into v_n, v_total, v_text;
      observed := v_n;
      status := case when v_n >= 5 and v_n >= 0.05 * v_total then 'fail'
                     when v_n >= 2 then 'warn' else 'pass' end;
      detail := pg_catalog.concat_ws(' · ', v_n::text || ' / ' || v_total::text || ' yanıt', v_text);
    end if;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 3. ingest cycles (ingest-drain */3 => 10 per 30 min)
  check_name := 'ingest_cycles_30m'; threshold := 5; observed := null; detail := null;
  begin
    select pg_catalog.count(*)::numeric into v_n
      from public.ingest_cycles c where c.finished_at >= v_now - interval '30 minutes';
    observed := v_n;
    status := case when v_n < 5 then 'fail' when v_n < 8 then 'warn' else 'pass' end;
    detail := 'beklenen 10';
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 4. ingest freshness per zone (newest articles.created_at, active voting sources)
  -- Thresholds tuned from Step 0 (7-day gap survey): fail = max(90, ceil(1.5
  -- * observed max gap 104.9 min)) = 158; warn = fail / 2 = 79.
  foreach v_zone in array array['iktidar', 'bagimsiz', 'muhalefet'] loop
    check_name := 'ingest_fresh_' || v_zone || '_min'; threshold := 158; observed := null; detail := null;
    begin
      with zmap(bias_key, zone) as (values
        ('pro_government', 'iktidar'), ('gov_leaning', 'iktidar'), ('state_media', 'iktidar'),
        ('islamist_conservative', 'iktidar'), ('nationalist', 'iktidar'),
        ('center', 'bagimsiz'), ('international', 'bagimsiz'), ('pro_kurdish', 'bagimsiz'),
        ('opposition_leaning', 'muhalefet'), ('opposition', 'muhalefet'))
      select pg_catalog.max(a.created_at) into v_last
        from public.articles a
        join public.sources s on s.id = a.source_id
        join zmap z on z.bias_key = s.bias
       where z.zone = v_zone
         and s.active
         and s.kind in ('outlet', 'wire')
         and a.created_at >= v_now - interval '24 hours'
         and a.created_at <= v_now;
      if v_last is null then
        status := 'fail'; detail := 'son 24 saatte haber yok';
      else
        observed := round(extract(epoch from (v_now - v_last)) / 60.0, 1);
        status := case when observed > 158 then 'fail' when observed > 79 then 'warn' else 'pass' end;
      end if;
    exception when others then
      status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
    end;
    return next;
  end loop;

  -- 5. jev-shadow last finished run that did work (migration 108). Only runs
  -- that made at least one call, or closed ok / budget_exceeded, count. A
  -- partial or error run with zero calls still sets finished_at but proves
  -- nothing (runs 3622 and 3623 kept this row at pass through the 2026-10-22
  -- stall). budget_exceeded counts as fresh on purpose: a deliberate monthly
  -- cap is a healthy stop, not a stall.
  check_name := 'jev_shadow_last_run_min'; threshold := 30; observed := null; detail := null;
  begin
    v_jobs := 0; v_active := null;
    if pg_catalog.to_regclass('cron.job') is not null then
      execute $q$ select pg_catalog.count(*)::numeric, pg_catalog.bool_or(j.active)
                    from cron.job j where j.jobname = 'jev-shadow' $q$ into v_jobs, v_active;
    end if;
    select pg_catalog.max(r.finished_at) into v_last
      from public.jev_shadow_runs r
     where r.started_at >= v_now - interval '2 days'
       and (r.status in ('ok', 'budget_exceeded') or r.calls > 0);
    if v_last is not null then observed := round(extract(epoch from (v_now - v_last)) / 60.0, 1); end if;
    if v_jobs > 0 and v_active is false then
      status := 'skip'; detail := 'jev-shadow cron işi pasif';
    elsif v_last is null then
      status := 'fail'; detail := 'son 2 günde ok ya da çağrılı koşu yok';
    else
      status := case when observed > 30 then 'fail' when observed > 20 then 'warn' else 'pass' end;
    end if;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 6. blindspot-recall-veto cron freshness (071)
  check_name := 'blindspot_veto_cron_min'; threshold := 30; observed := null; detail := null;
  begin
    if pg_catalog.to_regclass('cron.job_run_details') is null then
      status := 'unknown'; detail := 'pg_cron yok';
    else
      execute $q$ select pg_catalog.count(*)::numeric, pg_catalog.bool_or(j.active)
                    from cron.job j where j.jobname = 'blindspot-recall-veto' $q$ into v_jobs, v_active;
      if v_jobs = 0 then
        status := 'warn'; detail := 'blindspot-recall-veto işi yok (071 uygulanmamış olabilir)';
      elsif v_active is false then
        status := 'skip'; detail := 'cron işi pasif';
      else
        execute $q$
          select pg_catalog.max(d.end_time)
            from cron.job_run_details d
            join cron.job j on j.jobid = d.jobid
           where j.jobname = 'blindspot-recall-veto'
             and d.status = 'succeeded'
             and d.runid > (select coalesce(pg_catalog.max(x.runid), 0) - 5000 from cron.job_run_details x)
        $q$ into v_last;
        if v_last is null then
          status := 'fail'; detail := 'yakın zamanda başarılı koşu yok';
        else
          observed := round(extract(epoch from (v_now - v_last)) / 60.0, 1);
          status := case when observed > 30 then 'fail' else 'pass' end;
        end if;
      end if;
    end if;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 7. unacked Jev alerts older than 72 h that are still OPEN (warn only: a
  -- queue, not an outage). Migration 108: an alert already resolved
  -- (resolved_at set) no longer counts -- 41 of the 42 unacked rows on
  -- 2026-10-22 were resolved. The detail keeps the unacked total.
  check_name := 'jev_alerts_unacked_72h'; threshold := 1; observed := null; detail := null;
  begin
    select pg_catalog.count(*) filter (where a.resolved_at is null and a.created_at < v_now - interval '72 hours')::numeric,
           pg_catalog.count(*)::numeric
      into v_n, v_total
      from public.jev_alerts a where a.acknowledged_at is null;
    observed := v_n;
    status := case when v_n >= 1 then 'warn' else 'pass' end;
    detail := 'açık ve onaysız: ' || v_n::text || ' / onaysız toplam: ' || v_total::text;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 8. dead feeds: active voting sources with no article in 72 h (published_at
  -- <= now guards future dates). Thresholds tuned from Step 0: observed 35 /
  -- 96 (36.4%) on the live baseline -- raised the fail ratio from the
  -- drafted 0.35 to 0.50 and the warn count from the drafted 25 to
  -- observed + 3 = 38, so today's baseline reads 'pass'.
  check_name := 'dead_feeds'; threshold := null; observed := null; detail := null;
  begin
    with vs as (
      select s.id from public.sources s where s.active and s.kind in ('outlet', 'wire')
    ),
    latest as (
      select v.id,
             (select a.published_at from public.articles a
               where a.source_id = v.id and a.published_at <= v_now
               order by a.published_at desc limit 1) as last_at
        from vs v
    )
    select pg_catalog.count(*) filter (where l.last_at is null or l.last_at < v_now - interval '72 hours')::numeric,
           pg_catalog.count(*)::numeric
      into v_n, v_total
      from latest l;
    observed := v_n;
    threshold := ceil(0.50 * v_total);
    status := case when v_total > 0 and v_n >= 0.50 * v_total then 'fail'
                   when v_n > 38 then 'warn' else 'pass' end;
    detail := v_n::text || ' / ' || v_total::text || ' aktif kaynak 72 saattir sessiz';
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;


  -- 11. pg_net response-log size (migration 100). ops_net_response_compact()
  -- keeps this under 64 MiB from a 15-minute cron; warn/fail here means the
  -- compaction is being skipped (lock held by pg_net's worker, job disabled,
  -- TRUNCATE privilege lost) while the table bloats again -- the 2026-10-21
  -- failure mode (278 MB of heap behind 552 live rows). Measured as total
  -- relation size, the same figure the compactor thresholds on. Reuses v_n
  -- (MiB) so the declare block stays identical to 077's.
  check_name := 'net_response_heap_mb'; threshold := 200; observed := null; detail := null;
  begin
    if pg_catalog.to_regclass('net._http_response') is null then
      status := 'unknown'; detail := 'pg_net yok';
    else
      v_n := pg_catalog.pg_total_relation_size(pg_catalog.to_regclass('net._http_response')) / 1048576.0;
      observed := round(v_n, 1);
      status := case when v_n > 200 then 'fail' when v_n >= 64 then 'warn' else 'pass' end;
      detail := 'uyarı >= 64 MB, hata > 200 MB; 15 dakikada bir küçültülür (ops_net_response_compact)';
    end if;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 12. jev-shadow stall (migrations 103, 108). Three signals, summed, plus a
  -- timeout note that only escalates to warn:
  --   (a) failed pg_cron runs in the last 30 min for the three Jev jobs that
  --       poke or call the function (jev-shadow, jev-cluster-audit,
  --       jev-regression-weekly) -- same runid > max - 5000 window as check 1,
  --       since job_run_details has no start_time index;
  --   (b) net._http_response rows from the last 30 min with status_code >= 500
  --       whose body carries the "fn":"jev-shadow" marker. Every error body
  --       jevShadowErrorEnvelope emits has it (504 deadline, 503
  --       db-unavailable, 500 internal-error);
  --   (c) jev_shadow_runs rows started in the last 30 min that closed partial
  --       or error with zero calls (migration 108): the run opened and closed
  --       but did no work, which is what the 2026-10-22 stall looked like
  --       from inside the table;
  --   timed_out pg_net rows (status NULL, no body) cannot be attributed to a
  --   function, so they raise a pass to warn but never count toward fail.
  -- v_n is (a), v_total is (b), v_zero is (c), v_tmo is the timed_out count.
  -- A relation that does not exist leaves its variable null. An error anywhere
  -- is the only 'unknown'.
  check_name := 'jev_shadow_cron_failures_30m'; threshold := 2; observed := null; detail := null;
  begin
    v_n := null; v_total := null; v_zero := null; v_tmo := null;
    if pg_catalog.to_regclass('cron.job_run_details') is not null then
      execute $q$
        select pg_catalog.count(*)::numeric
          from cron.job_run_details d
          join cron.job j on j.jobid = d.jobid
         where d.runid > (select coalesce(pg_catalog.max(x.runid), 0) - 5000 from cron.job_run_details x)
           and d.start_time >= pg_catalog.now() - interval '30 minutes'
           and d.status = 'failed'
           and j.jobname in ('jev-shadow', 'jev-cluster-audit', 'jev-regression-weekly')
      $q$ into v_n;
    end if;
    if pg_catalog.to_regclass('net._http_response') is not null then
      execute $q$
        select pg_catalog.count(*) filter (where r.status_code >= 500 and r.content like '%"fn":"jev-shadow"%')::numeric,
               pg_catalog.count(*) filter (where r.timed_out)::numeric
          from net._http_response r
         where r.created >= pg_catalog.now() - interval '30 minutes'
      $q$ into v_total, v_tmo;
    end if;
    select pg_catalog.count(*)::numeric into v_zero
      from public.jev_shadow_runs r
     where r.started_at >= v_now - interval '30 minutes'
       and r.status in ('partial', 'error')
       and r.calls = 0;
    observed := coalesce(v_n, 0) + coalesce(v_total, 0) + coalesce(v_zero, 0);
    status := case when observed >= 2 then 'fail'
                   when observed >= 1 or coalesce(v_tmo, 0) >= 1 then 'warn' else 'pass' end;
    detail := 'cron hatası: ' || coalesce(v_n, 0)::text || ' · HTTP 5xx: ' || coalesce(v_total, 0)::text
              || ' · sıfır çağrılı koşu: ' || coalesce(v_zero, 0)::text
              || ' · zaman aşımı (fonksiyon bilinmiyor): ' || coalesce(v_tmo, 0)::text || ' (son 30 dk)';
    if v_n is null and v_total is null then
      detail := detail || ' · pg_cron ve pg_net yok';
    end if;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 13. sources_newly_dark (migration 114; window 24 h since 115; reason labels since 119)
  check_name := 'sources_newly_dark'; threshold := 1; observed := null; detail := null;
  begin
    with vs as (select s.id, s.slug,
                       case when (s.fetch_quarantined_until is not null and s.fetch_quarantined_until > v_now)
                                 or coalesce(s.fetch_fail_streak,0) > 0
                                 or s.fetch_last_status is null
                                 or not (s.fetch_last_status between 200 and 299 or s.fetch_last_status = 304)
                            then 'erişim yok'
                            when s.fetch_items_count = 0
                                 or s.fetch_newest_item_at < v_now - interval '72 hours'
                            then 'akış donmuş'
                            else 'sessiz' end as reason
                  from public.sources s
                 where s.active and s.kind in ('outlet', 'wire')
                   and not exists (select 1 from public.ops_dark_source_baseline b where b.slug = s.slug)),
    c as (select a.source_id,
                 pg_catalog.count(*) filter (where a.created_at < v_now - interval '24 hours') as prior_n,
                 pg_catalog.count(*) filter (where a.created_at >= v_now - interval '24 hours') as recent_n
            from public.articles a
           where a.created_at >= v_now - interval '14 days 24 hours' and a.created_at <= v_now
           group by a.source_id)
    select pg_catalog.count(*)::numeric,
           pg_catalog.string_agg(v.slug || ' (' || c.prior_n::text || ') · ' || v.reason, ', ' order by c.prior_n desc, v.slug)
      into v_n, v_text
      from vs v join c on c.source_id = v.id
     where c.prior_n >= 50 and c.recent_n = 0;
    observed := v_n;
    status := case when v_n >= 1 then 'warn' else 'pass' end;
    detail := case when v_n >= 1
      then substr('son 24 saatte haber gelmedi (önceki 14 günde en az 50 haber vardı): ' || v_text, 1, 500)
      else 'yeni susan kaynak yok' end;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 14. ingest_gaps (migration 122). A tick the platform kills (pg_net 546 WORKER_RESOURCE_LIMIT) writes no ingest_cycles row, so row 3 can read pass. ingest-drain runs */3 (038): a gap over 5 minutes between consecutive started_at is at least one lost tick. Warn only.
  check_name := 'ingest_gaps'; threshold := 3; observed := null; detail := null;
  begin
    v_n := null; v_total := null; v_zero := null; v_text := null;
    with s as (
      select c.started_at,
             c.started_at - pg_catalog.lag(c.started_at) over (order by c.started_at) as gap
        from public.ingest_cycles c
       where c.finished_at >= v_now - interval '6 hours 15 minutes'
         and c.started_at >= v_now - interval '6 hours'
         and c.started_at <= v_now
    )
    select pg_catalog.count(*)::numeric,
           pg_catalog.count(*) filter (where s.gap > interval '5 minutes')::numeric,
           pg_catalog.trim_scale(round(extract(epoch from pg_catalog.max(s.gap)) / 60.0, 1)),
           pg_catalog.string_agg(
             pg_catalog.to_char((s.started_at - s.gap) at time zone 'UTC', 'HH24:MI') || '→'
               || pg_catalog.to_char(s.started_at at time zone 'UTC', 'HH24:MI'),
             ', ' order by s.gap desc, s.started_at) filter (where s.gap > interval '5 minutes')
      into v_total, v_n, v_zero, v_text
      from s;
    observed := v_n;
    if coalesce(v_total, 0) = 0 then
      status := 'warn'; observed := null; detail := 'son 6 saatte ingest döngüsü yok';
    else
      status := case when v_n >= 3 or coalesce(v_zero, 0) > 10 then 'warn' else 'pass' end;
      detail := case when v_n >= 1
        then substr('son 6 saatte 5 dakikadan uzun boşluk: ' || v_n::text || ' · en uzunu ' || coalesce(v_zero, 0)::text || ' dk · ' || v_text || ' (UTC)', 1, 500)
        else 'son 6 saatte 5 dakikadan uzun boşluk yok · en uzunu ' || coalesce(v_zero, 0)::text || ' dk' end;
    end if;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 15. cron_route_failures_30m (migration 136). The Vercel cron routes (headline, digest, fact-checks, social, alerts-webhooks) record every authenticated run in public.ops_cron_route_runs through ops_cron_route_run_record (withCronOutcome, written by after()). A route that answers 5xx leaves no trace in rows 1-14 (2026-10-31: 189 headline statement timeouts over 18 hours, no alert). Fail when one route has at least 2 failures (status >= 500) that are at least half of its runs in the last 30 minutes, so a single blip in a daily route stays a warn; warn on any failure; warn when the window holds no run at all (the app side is not recording). A run that Vercel kills at maxDuration (60 s) never reaches the wrapper's finally or after(), so it writes no row and no failure can be counted: the two frequent routes in the VALUES list below (headline every 5 minutes, alerts-webhooks every 10) are also checked for silence. A route that has recorded within the 7 day retention but whose newest row is older than warn_min (15 / 25 minutes: three and 2.5 ticks) is a warn, older than fail_min (30 / 60: six ticks) a fail, named in the detail as `kayıt gelmiyor: headline 31 dk`, even while other routes keep writing rows. Hourly, daytime-only and weekly routes (fact-checks, social, digest) have too few ticks for a gap rule and stay out; a route that has never recorded cannot be compared with anything and is not flagged (the VERIFY query shows it).
  check_name := 'cron_route_failures_30m'; threshold := 1; observed := null; detail := null;
  begin
    v_n := null; v_total := null; v_zero := null; v_text := null;
    v_jobs := null; v_active := null; v_zone := null;
    if pg_catalog.to_regclass('public.ops_cron_route_runs') is null then
      status := 'unknown'; detail := 'ops_cron_route_runs yok';
    else
      with r as (
        select x.route,
               pg_catalog.count(*) as runs,
               pg_catalog.count(*) filter (where x.status >= 500) as failures
          from public.ops_cron_route_runs x
         where x.ran_at >= v_now - interval '30 minutes'
         group by x.route
      )
      select pg_catalog.sum(r.runs),
             pg_catalog.sum(r.failures),
             pg_catalog.count(*) filter (where r.failures >= 2 and r.failures * 2 >= r.runs),
             pg_catalog.string_agg(
               r.route || ' ' || r.failures::text || '/' || r.runs::text, ', '
               order by (r.failures >= 2 and r.failures * 2 >= r.runs) desc, r.failures desc, r.runs, r.route
             ) filter (where r.failures >= 1)
        into v_total, v_n, v_zero, v_text
        from r;
      -- silence: the newest row per listed route, in minutes (warn_min / fail_min are the gaps)
      with e (route, warn_min, fail_min) as (
        values ('headline'::text, 15::numeric, 30::numeric),
               ('alerts-webhooks'::text, 25::numeric, 60::numeric)
      ),
      s as (
        select e.route, e.warn_min, e.fail_min,
               extract(epoch from (v_now - pg_catalog.max(x.ran_at))) / 60.0 as age_min
          from e
          join public.ops_cron_route_runs x on x.route = e.route
         where x.ran_at >= v_now - interval '7 days'
         group by e.route, e.warn_min, e.fail_min
      )
      select pg_catalog.count(*) filter (where s.age_min > s.warn_min)::numeric,
             pg_catalog.bool_or(s.age_min > s.fail_min),
             pg_catalog.string_agg(
               s.route || ' ' || pg_catalog.floor(s.age_min)::text || ' dk', ', '
               order by s.age_min desc, s.route
             ) filter (where s.age_min > s.warn_min)
        into v_jobs, v_active, v_zone
        from s;
      v_total := coalesce(v_total, 0); v_n := coalesce(v_n, 0); v_zero := coalesce(v_zero, 0);
      v_jobs := coalesce(v_jobs, 0); v_active := coalesce(v_active, false);
      if v_total = 0 and v_jobs = 0 then
        status := 'warn'; observed := null; detail := 'son 30 dakikada cron rotası kaydı yok';
      else
        observed := v_n + v_jobs;
        status := case when v_zero >= 1 or v_active then 'fail'
                       when v_n >= 1 or v_jobs >= 1 or v_total = 0 then 'warn'
                       else 'pass' end;
        detail := substr(pg_catalog.concat_ws(' · ',
          case when v_n >= 1 then 'son 30 dakikada başarısız: ' || v_text
               when v_total = 0 then 'son 30 dakikada cron rotası kaydı yok'
               else 'son 30 dakikada ' || v_total::text || ' çalışma, başarısız yok' end,
          case when v_jobs >= 1 then 'kayıt gelmiyor: ' || v_zone end), 1, 500);
      end if;
    end if;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 16. db_size_mb (migration 136). pg_database_size was 6252 MB on 2026-11-01 (jev_shadow_predictions 3142 MB, articles 2016 MB) and nothing watched it. The warn and fail limits in MB come from public.ops_db_size_limits() (default 7000 / 7600; the founder sets them to 70% / 85% of the provisioned disk with create or replace); threshold is the warn limit. The detail names the three biggest public relations.
  check_name := 'db_size_mb'; threshold := null; observed := null; detail := null;
  begin
    v_n := null; v_total := null; v_text := null;
    select l.warn_mb, l.fail_mb into v_n, v_total from public.ops_db_size_limits() l;
    threshold := v_n;
    observed := round(pg_catalog.pg_database_size(pg_catalog.current_database()) / 1048576.0);
    select pg_catalog.string_agg(t.relname || ' ' || t.mb::text || ' MB', ', ' order by t.sz desc, t.relname)
      into v_text
      from (
        select c.relname::text as relname,
               pg_catalog.pg_total_relation_size(c.oid) as sz,
               round(pg_catalog.pg_total_relation_size(c.oid) / 1048576.0) as mb
          from pg_catalog.pg_class c
          join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public'
           and c.relkind in ('r', 'm')
         order by sz desc, c.relname
         limit 3
      ) t;
    status := case when observed >= v_total then 'fail' when observed >= v_n then 'warn' else 'pass' end;
    detail := 'veritabanı ' || observed::text || ' MB · uyarı ' || v_n::text || ' MB · kritik ' || v_total::text || ' MB · en büyük: ' || coalesce(v_text, '-');
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  return;
end
$fn$;

comment on function public.ops_health_report() is
  'Read-only ops heartbeat (migrations 077, 100, 103, 108, 114, 115, 119, 122, 136): 16 fixed rows, in this order --'
  ' cron_failed_runs_30m, edge_http_errors_30m, ingest_cycles_30m,'
  ' ingest_fresh_iktidar_min, ingest_fresh_bagimsiz_min, ingest_fresh_muhalefet_min,'
  ' jev_shadow_last_run_min (minutes since the last finished jev-shadow run that closed'
  ' ok or budget_exceeded or made at least one call; zero-call partial/error runs do not'
  ' count: warn > 20, fail > 30),'
  ' blindspot_veto_cron_min,'
  ' jev_alerts_unacked_72h (unacknowledged AND unresolved Jev alerts older than 72 h; warn only),'
  ' dead_feeds,'
  ' net_response_heap_mb (pg_net response-log MiB: pass < 64, warn 64-200, fail > 200),'
  ' jev_shadow_cron_failures_30m (failed runs of the jev-shadow, jev-cluster-audit and'
  ' jev-regression-weekly cron jobs plus jev-shadow HTTP 5xx responses carrying the'
  ' "fn":"jev-shadow" marker plus jev-shadow runs that closed partial or error with zero calls,'
  ' last 30 min: warn 1, fail >= 2; any timed_out pg_net request alone raises pass to warn),'
  ' sources_newly_dark (active outlet/wire sources outside public.ops_dark_source_baseline'
  ' that had at least 50 articles in the 14 days before the last 24 hours and none in those'
  ' 24 hours; warn only, never fail: the detail names them, each as slug (n) followed by a'
  ' reason read from sources.fetch_*: erişim yok (quarantined now, a fail streak, no status yet,'
  ' or a last status that is neither 2xx nor 304), akış donmuş (the feed answers but holds no'
  ' items, or its newest item, fetch_newest_item_at, is over 72 hours old; fetch_newest_item_at'
  ' and fetch_items_count are written by ingest, migration 119), sessiz (everything else, a'
  ' source never measured included)),'
  ' ingest_gaps (gaps of more than 5 minutes between consecutive ingest_cycles.started_at in the last'
  ' 6 hours, each one at least one lost ingest-drain tick, for example a pg_net 546 kill;'
  ' warn at 3 or more gaps or any gap over 10 minutes, never fail; the detail lists the gaps as'
  ' HH:MI→HH:MI in UTC, longest first),'
  ' cron_route_failures_30m (HTTP 5xx outcomes of the Vercel cron routes in public.ops_cron_route_runs,'
  ' written by withCronOutcome, last 30 min: warn at 1 failure, fail when one route has at least 2'
  ' failures that are at least half of its runs; warn when the window holds no run at all; the detail'
  ' lists the failing routes as route failures/runs, worst first; a run Vercel kills at maxDuration writes'
  ' no row, so headline (every 5 min) and alerts-webhooks (every 10 min) are also checked for silence:'
  ' a route with a row in the last 7 days whose newest row is older than 15 / 25 min is a warn and'
  ' older than 30 / 60 min a fail, named in the detail as kayıt gelmiyor: route n dk),'
  ' db_size_mb (pg_database_size in MB against public.ops_db_size_limits(): warn at the first limit,'
  ' fail at the second, threshold is the warn limit; the detail names the three biggest public relations).'
  ' status is one of pass|warn|fail|unknown|skip, and threshold is the fail limit'
  ' (or the warn limit for warn-only checks). Never writes any table, and'
  ' never reads any potentially secret-bearing pg_cron job field. Polled by'
  ' .github/workflows/ops-heartbeat.yml over PostgREST every 30 minutes.'
  ' service_role only. See docs/ops-heartbeat.md.';

revoke all on function public.ops_health_report() from public, anon, authenticated;
grant execute on function public.ops_health_report() to service_role;

-- ---------------------------------------------------------------------------
-- 4. pg_cron: ops-cron-route-runs-prune (daily 04:17 UTC; 04:15 jev-budget-nightly
-- and 04:20 alias-prune are the neighbours). Scheduled by name; an existing job of
-- that name is unscheduled first; no other job is touched.
-- ---------------------------------------------------------------------------

do $prune$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    raise notice '136: pg_cron missing, skipping the ops-cron-route-runs-prune schedule.';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'ops-cron-route-runs-prune') then
    perform cron.unschedule('ops-cron-route-runs-prune');
  end if;

  perform cron.schedule('ops-cron-route-runs-prune', '17 4 * * *',
    $sql$ set statement_timeout = '60s'; select public.ops_cron_route_runs_prune(); $sql$);
end
$prune$;

-- 5. Schema cache and ledger ----------------------------------------------------

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('136', '136_ops_heartbeat_app_side')
  on conflict do nothing;

commit;
