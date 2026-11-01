-- 131_ops_snapshots_archive_catchup.sql
--
-- Two silent failures found by hunt 10 (2026-11-01), one migration because both
-- end in the same place: the ops heartbeat (scripts/ops-heartbeat.mjs).
--
-- WHY (1/2) -- h10-silent-1, the pager runs on 12% of its schedule.
--   .github/workflows/ops-heartbeat.yml is '*/30 * * * *'. `gh run list` returned
--   100 scheduled runs from 2026-10-15 02:25Z to 2026-11-01 09:26Z: 100 of ~830
--   expected ticks (12%), median gap 4.1 h, max 7.75 h. Rows 1, 2, 3 and 12 of
--   ops_health_report() read only the trailing 30 minutes, so about 88% of every
--   day is never evaluated, and the only alert path is a red job email. This
--   migration makes detection independent of GitHub's scheduler: pg_cron takes
--   the non-pass rows of ops_health_report() every 10 minutes into
--   public.ops_health_snapshots; the heartbeat pages once on every unnotified
--   FAIL snapshot (ops_health_unnotified) and then stamps it
--   (ops_health_mark_notified). ops_health_report() itself is NOT modified.
--
-- WHY (2/2) -- h10-silent-2, a 6 day hole in the archive.
--   The nightly archive-export (060, '40 3 * * *') only ever exports yesterday.
--   2026-10-12..2026-10-17 (~9.9k clusters) never ran, nothing retried, and
--   nothing flagged it (cron.job_run_details retention starts 10-18, so the cause
--   is gone). This migration adds the nightly job 'archive-export-catchup' (05:12
--   UTC, off jev-shadow's :x0 minutes of 109) that posts {"catchup":true}; the
--   function re-exports the OLDEST missing day of the last 40 days, one day per
--   night. ops_archive_gap_days() counts the hole for the heartbeat
--   (archive_gap_days row) and the /admin card.
--
-- STEP 0 (read-only, production, 2026-11-01; recorded here, nothing was written):
--   (a) select schedule, command from cron.job where jobname = 'archive-export'
--       -> jobid 25, active, '40 3 * * *'. The command is 060's text exactly:
--       net.http_post(url := (vault functions_base_url) || '/archive-export',
--       headers := Content-Type + 'Bearer ' || (vault service_role_key),
--       body := '{}'::jsonb, timeout_milliseconds := 60000). The catch-up job
--       below copies it character for character and changes only the body.
--   (b) generate_series gap query, 2026-09-18 .. yesterday (2026-10-31):
--       6 missing days, 2026-10-12, 13, 14, 15, 16, 17.
--   (c) explain (analyze) select * from public.ops_health_report(), three runs:
--       455 ms (cold), 99 ms, 101 ms. Mean 218 ms, far under the 3 s line, so
--       the snapshot runs every 10 minutes ('4-59/10 * * * *'), not every 15.
--       The same query returned 14 rows, 3 of them non-pass (warn:
--       jev_alerts_unacked_72h, sources_newly_dark, ingest_gaps).
--   (d) select min(day), max(day), count(*) from public.archive_exports
--       -> 2026-09-18, 2026-10-31, 38 (= 44 days minus the 6 missing).
--
-- COST. ops_health_snapshot() stores only warn/fail/unknown rows: about 3-4 per
--   tick on today's data, so ~144 ticks/day x 3-4 = ~430-600 rows a day and, with
--   the 3 day prune inside the function, ~1.3-2k rows in the table (an index on
--   taken_at is all it needs; not a large table, so a plain CREATE INDEX, no
--   ORCHESTRATOR PRE-BUILD step as in 101/127). Database time: report() at
--   ~0.1-0.5 s x 144/day = about 15-70 s a day. The catch-up is one http_post a
--   day and, while a hole exists, one export a night (the same size as the
--   03:40 export: the function's 50 s deadline and the 60 s pg_net timeout are
--   unchanged); with no hole it answers {"reason":"no-gap"} after one small read.
--   Minute map: jev-shadow :x0, cluster-topics-refresh :x3, blindspot-recall-veto
--   :x7 (109), framing */5, karne */15; the snapshot takes :x4, which is free.
--
-- DEADLINE. The 6 missing days must re-export WITH Jev labels before
--   jev-shadow-prune (50 4 * * *, 45 day keep) drops them: 2026-10-12's labels go
--   around 2026-11-26. The window is 40 days, not 30 (deliberate): a 30 day window
--   would stop reaching 2026-10-12 on 2026-11-11; 40 days reaches it until
--   2026-11-21 (window start = today - 40). It is capped at 44 = 45 - 1
--   (archive-window.ts asserts it). Deploy this migration AND the archive-export
--   function by 2026-11-20: the first catch-up then runs by 05:12 UTC on
--   2026-11-21 at the latest, takes 10-12 (the window start that day), and
--   10-13..10-17 follow on 11-22..11-26, each exactly at the window start. Deploying earlier
--   only adds margin: the hole closes in 6 nights from the first run. Operator
--   fallback, any day, in any order: POST {"day":"2026-10-12"} to archive-export.
--   After 2026-11-21 05:12 UTC the unattended path no longer reaches 10-12; only
--   the manual POST does, and only until its labels are pruned.
--
-- THRESHOLDS (scripts/lib/ops-heartbeat.mjs, pinned by tests/migrations/131-*):
--   archive_gap_days: pass at 0 missing days; warn for 1..6 whose oldest day is no
--   more than 33 days old; fail from 7 missing days or when the oldest is older
--   than 33 days (40 - 7: one night per day cannot close it before it leaves the
--   window).
--
-- PRIVILEGES. Same shell as 105/117: the table has RLS on, no policy, and every
--   privilege of anon/authenticated/public revoked (plus the PG17-guarded MAINTAIN
--   revoke); only the four SECURITY DEFINER functions touch it, each with
--   search_path = '' and execute for service_role alone. Nothing here reaches the
--   anon surface (tests/guards/anon-surface.test.ts).
--
-- IDEMPOTENT: if-not-exists / create-or-replace throughout; both cron jobs are
--   unscheduled by name first when present; the ledger insert is on-conflict-do-
--   nothing. Missing pg_cron / pg_net / Vault secrets skip the schedules with a
--   notice (local and CI databases). Additive: no existing object is changed.
--
-- APPLY ORDER. Apply the migration, then deploy the function:
--   supabase functions deploy archive-export --no-verify-jwt
--   Until the function is redeployed the pre-131 function ignores the unknown
--   "catchup" key, treats the body as {} and re-runs yesterday's export, which
--   its hasExport check skips (harmless); until the migration is applied the
--   heartbeat shows
--   'unknown' rows (snapshot_backstop, archive_gap_days) and its exit code is
--   unchanged.
--
-- VERIFY (read-only unless noted):
--   select * from public.ops_archive_gap_days();      -- before: 6 | 2026-10-12
--   select jobname, schedule, active from cron.job
--    where jobname in ('ops-health-snapshot', 'archive-export-catchup');
--   select public.ops_health_snapshot();              -- writes: rows stored (0-4)
--   select taken_at, check_name, status from public.ops_health_snapshots
--    order by id desc limit 10;
--   select * from public.ops_health_unnotified();     -- unnotified FAIL rows
--   -- next morning: select * from public.archive_exports order by day desc limit 3;
--   -- after six nights: ops_archive_gap_days() = 0 | null
--
-- ROLLBACK:
--   select cron.unschedule('ops-health-snapshot');
--   select cron.unschedule('archive-export-catchup');
--   drop function public.ops_health_snapshot();
--   drop function public.ops_health_unnotified(interval);
--   drop function public.ops_health_mark_notified(bigint[]);
--   drop function public.ops_archive_gap_days(integer);
--   drop table public.ops_health_snapshots;
--   delete from supabase_migrations.schema_migrations where version = '131';
--   The heartbeat script tolerates all of it: it shows 'unknown' rows and keeps
--   its exit code.

begin;

-- 1. Snapshots table ------------------------------------------------------------

create table if not exists public.ops_health_snapshots (
  id bigint generated always as identity primary key,
  taken_at timestamptz not null default now(),
  check_name text not null,
  status text not null check (status in ('warn', 'fail', 'unknown')),
  observed numeric,
  threshold numeric,
  detail text,
  notified_at timestamptz
);

create index if not exists ops_health_snapshots_taken_at_idx
  on public.ops_health_snapshots (taken_at);

comment on table public.ops_health_snapshots is
  'Non-pass rows of ops_health_report(), one batch every 10 min by pg_cron '
  'ops-health-snapshot (migration 131), pruned after 3 days. FAIL rows the '
  'GitHub heartbeat has not yet paged have notified_at null. Owner and '
  'service_role functions only.';

alter table public.ops_health_snapshots enable row level security;

-- Supabase default privileges hand new tables to anon/authenticated (incl.
-- write privileges, cf. 091/095): strip them. Nothing is given back; only the
-- SECURITY DEFINER functions below touch this table.
revoke all on public.ops_health_snapshots from anon, authenticated, public;
revoke all on sequence public.ops_health_snapshots_id_seq from anon, authenticated, public;

-- PG17 added the MAINTAIN privilege; it does not exist before PG17 (revoking it
-- would be a syntax error), so guard.
do $maint$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on public.ops_health_snapshots from anon, authenticated';
  end if;
end
$maint$;

-- 2. Functions ------------------------------------------------------------------

-- 2a. The snapshot taker (pg_cron, every 10 minutes).
create or replace function public.ops_health_snapshot()
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_n integer;
begin
  -- One snapshot at a time: a slow report must not stack runs on each other.
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtext('ops_health_snapshot')::bigint
  ) then
    return 0;
  end if;

  insert into public.ops_health_snapshots (check_name, status, observed, threshold, detail)
  select r.check_name, r.status, r.observed, r.threshold, r.detail
    from public.ops_health_report() r
   where r.status in ('warn', 'fail', 'unknown');
  get diagnostics v_n = row_count;

  delete from public.ops_health_snapshots
   where taken_at < pg_catalog.now() - interval '3 days';

  return v_n;
end
$fn$;

comment on function public.ops_health_snapshot() is
  'Stores the warn/fail/unknown rows of ops_health_report() in '
  'ops_health_snapshots and prunes rows older than 3 days (migration 131). '
  'Returns the rows stored (0 if another run holds the advisory lock). '
  'service_role only; scheduled every 10 min as ops-health-snapshot.';

revoke all on function public.ops_health_snapshot() from public, anon, authenticated;
grant execute on function public.ops_health_snapshot() to service_role;

-- 2b. The FAIL snapshots nobody has been told about yet.
create or replace function public.ops_health_unnotified(p_since interval default interval '24 hours')
returns table (
  id bigint,
  taken_at timestamptz,
  check_name text,
  status text,
  observed numeric,
  threshold numeric,
  detail text
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select s.id, s.taken_at, s.check_name, s.status, s.observed, s.threshold, s.detail
    from public.ops_health_snapshots s
   where s.status = 'fail'
     and s.notified_at is null
     and s.taken_at >= pg_catalog.now() - least(p_since, interval '3 days')
   order by s.taken_at, s.id
   limit 200
$fn$;

comment on function public.ops_health_unnotified(interval) is
  'FAIL snapshots with notified_at null, taken within p_since (default 24 h, '
  'never more than the 3 day retention), oldest first, at most 200 '
  '(migration 131). The GitHub heartbeat pages on these and then calls '
  'ops_health_mark_notified. service_role only.';

revoke all on function public.ops_health_unnotified(interval) from public, anon, authenticated;
grant execute on function public.ops_health_unnotified(interval) to service_role;

-- 2c. Stamp the snapshots that were paged.
create or replace function public.ops_health_mark_notified(p_ids bigint[])
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_n integer;
begin
  if p_ids is null or pg_catalog.cardinality(p_ids) = 0 then
    return 0;
  end if;
  if pg_catalog.cardinality(p_ids) > 1000 then
    raise exception 'ops_health_mark_notified: % ids is more than the 1000 allowed', pg_catalog.cardinality(p_ids);
  end if;

  update public.ops_health_snapshots s
     set notified_at = pg_catalog.now()
   where s.id = any (p_ids)
     and s.notified_at is null;
  get diagnostics v_n = row_count;

  return v_n;
end
$fn$;

comment on function public.ops_health_mark_notified(bigint[]) is
  'Sets notified_at on the given snapshot ids that are still unnotified and '
  'returns how many it stamped (migration 131). Raises above 1000 ids. '
  'service_role only.';

revoke all on function public.ops_health_mark_notified(bigint[]) from public, anon, authenticated;
grant execute on function public.ops_health_mark_notified(bigint[]) to service_role;

-- 2d. The archive hole: UTC days in [today - p_days, today - 2] with no
-- archive_exports row. Yesterday is left to the 03:40 job; days before the first
-- ledger row are not "missing" (the archive began there). p_days is clamped to
-- [2, 44]: 44 = the 45 day Jev keep window - 1. Mirrors
-- supabase/functions/_shared/archive-window.ts (tests/migrations/131-* pins both).
create or replace function public.ops_archive_gap_days(p_days integer default 40)
returns table (missing_days integer, oldest_missing date)
language sql
stable
security definer
set search_path = ''
as $fn$
  with w as (
    select (pg_catalog.now() at time zone 'utc')::date as today,
           least(greatest(coalesce(p_days, 40), 2), 44) as n
  ),
  b as (
    select w.today - 2 as win_to,
           case when f.first_day is null then null
                else greatest(w.today - w.n, f.first_day)
           end as win_from
      from w
     cross join (select min(a.day) as first_day from public.archive_exports a) f
  ),
  d as (
    select b.win_from + g.i as day
      from b
     cross join lateral generate_series(0, b.win_to - b.win_from) as g(i)
  )
  select count(*)::integer, min(d.day)
    from d
   where not exists (select 1 from public.archive_exports e where e.day = d.day)
$fn$;

comment on function public.ops_archive_gap_days(integer) is
  'Count and oldest of the UTC days in [today - p_days, today - 2] without an '
  'archive_exports row (migration 131). Always one row; the window starts no '
  'earlier than the first ledger day; p_days is clamped to [2, 44]. '
  'service_role only.';

revoke all on function public.ops_archive_gap_days(integer) from public, anon, authenticated;
grant execute on function public.ops_archive_gap_days(integer) to service_role;

-- 3. pg_cron: ops-health-snapshot -----------------------------------------------

do $snap$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    raise notice '131: pg_cron missing, skipping the ops-health-snapshot schedule.';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'ops-health-snapshot') then
    perform cron.unschedule('ops-health-snapshot');
  end if;

  perform cron.schedule('ops-health-snapshot', '4-59/10 * * * *',
    $sql$ set statement_timeout = '60s'; select public.ops_health_snapshot(); $sql$);
end
$snap$;

-- 4. pg_cron: archive-export-catchup --------------------------------------------

-- Daily 05:12 UTC, after the 03:40 export and clear of jev-shadow's :x0 minutes
-- (109). Command text = 060's archive-export command, only the body differs.
-- Same do-block shape as 060: skipped with a notice when pg_cron/pg_net or the
-- Vault secrets are absent. No key is written here; the Bearer is read from the
-- Vault each time the job runs.
do $catchup$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_net')
  then
    raise notice '131: pg_cron/pg_net missing, skipping the archive-export-catchup schedule.';
    return;
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'service_role_key')
     or not exists (select 1 from vault.decrypted_secrets where name = 'functions_base_url')
  then
    raise notice '131: Vault secrets missing, skipping the archive-export-catchup schedule. See 038.';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'archive-export-catchup') then
    perform cron.unschedule('archive-export-catchup');
  end if;

  perform cron.schedule('archive-export-catchup', '12 5 * * *', $sql$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_base_url') || '/archive-export',
      headers := jsonb_build_object('Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
      body := '{"catchup":true}'::jsonb,
      timeout_milliseconds := 60000)
  $sql$);
end
$catchup$;

-- 5. Schema cache and ledger ----------------------------------------------------

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('131', '131_ops_snapshots_archive_catchup')
  on conflict do nothing;

commit;
