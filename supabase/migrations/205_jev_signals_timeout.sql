-- 205_jev_signals_timeout.sql
--
-- Give pg_cron job 39 `jev-signals-nightly` a statement timeout of its own, and make a
-- failed or missed run of it visible in the ops heartbeat. Two small guarded writes and
-- nothing else: no index, no function change, no data rewrite, and the schedule and the
-- active flag of the job are not touched. (hunt 146, h146-pipeline-1. The numbers 202,
-- 203 and 204 are not used: 202 is held on a local branch, 203 and 204 belong to an open
-- pull request.)
--
-- WHY. The job is three bare selects (jev_source_drift_compute, jev_kap_canary_compute,
-- jev_alerts_auto_resolve) with no timeout in its command, so it runs under the platform's
-- 120 s statement_timeout, and its run time has grown past 100 s. One timeout (57014) in
-- the first select cancels the whole run: no source_drift_daily row for the day, no KAP
-- canary reading, no jev_alerts auto-resolve. Nothing watched the job either: it is not in
-- public.ops_cron_expected, so cron_jobs_stalled never reported a failed or missing run.
-- The consumers are the admin Jev panels (src/components/admin/jev-signals-section.tsx,
-- src/lib/admin/jev-signals.ts, kap-signals.ts): the impact is internal data, not a public
-- page.
--
-- EVIDENCE (production, read-only, 2026-11-12).
--   cron.job 39 'jev-signals-nightly': schedule '05 4 * * *', username postgres, active;
--   the command is the three selects of 073 and nothing else.
--   cron.job_run_details of job 39, every run succeeded. Seconds, 10-29 to 11-08: 43.0,
--   42.6, 45.0, 44.5, 46.0, 51.3, 50.0, 57.2, 54.4, 50.6, 55.0. Then 100.6 (11-09), 105.8
--   (11-10), 105.9 (11-11) and 111.6 (11-12, 04:05:00 to 04:06:51Z): a step of about 45 s
--   on 11-09, then about 3.7 s a night, so the run reaches 120 s around Nov 14-15.
--   pg_settings: statement_timeout has reset_val 120000 (ms) for role postgres. The role
--   postgres has no statement_timeout of its own (pg_db_role_setting holds one only for
--   anon 3s, authenticated 8s and authenticator 8s; the rolconfig of postgres is a
--   search_path), so the 120 s configuration value is what job 39 gets. A read-only
--   session shows 8000 only because it sets its own.
--   One run is one implicit transaction: pg_cron on production runs jobs through libpq as
--   one simple-query string (migration 148's header records it), so a 57014 in the drift
--   select also drops the canary and the auto-resolve.
--   jev_source_drift_compute(p_day default yesterday) computes only yesterday, so a
--   missed night is not recomputed by the next one, and the self-heal that would backfill
--   it is held (h68-sqlperf-1). Its 14-day baseline re-reads raw jev_shadow_predictions.
--   12 other jobs already carry a timeout in their command (34, 48, 50-55, 59, 61, 63,
--   64); job 39 is the only heavy job that does not.
--   public.ops_cron_expected has 20 rows and jev-signals-nightly is not one of them.
--   This is not h140-rejected-4: that was a 105 MB index, rejected because every run
--   still succeeded. This migration adds no index and changes no data.
--
-- THE FIX.
--   (1) cron.alter_job(job_id := <job 39>, command := ...) changes the command and
--       nothing else (no schedule, no active, no database, no username). The command
--       becomes
--         set local statement_timeout = '5min'; select public.jev_source_drift_compute();
--         select public.jev_kap_canary_compute(); select public.jev_alerts_auto_resolve();
--       the three selects verbatim and in 073's order, in the format 148 gave
--       blindspot-recall-veto (job 34): a leading `set local` governs the statements that
--       follow it inside the run's one implicit transaction. The job is found by name; no
--       pg_cron, or no job of that name, is a notice and a skip (local and CI databases).
--   (2) one row in public.ops_cron_expected: ('jev-signals-nightly', interval '26 hours',
--       '05 4 * * *'). 26 h is 150's rule for a daily job and the note is the schedule. It
--       is written only when the table exists, as `on conflict (jobname) do nothing`, so
--       an operator's tuning survives a re-apply.
--
-- WHY 5 MIN. 300 s is about 2.7 times the worst run so far (111.6 s) and the same order as
-- jobs 48 and 54 (both 5min), so the growth of about 4 s a night has weeks of room, while a
-- pathological run still fails fast instead of running unbounded. The run itself is not
-- made faster here. The optional follow-up (not in this migration) is to compute the
-- 14-day baseline from a daily rollup instead of re-reading the raw predictions.
--
-- HEARTBEAT. ops_health_report() row 19, cron_jobs_stalled (150; its newest text is 195's),
-- reads public.ops_cron_expected: each listed job is counted as missing (no cron.job row),
-- inactive, stale (no run, or the newest start_time older than max_gap, any status) or
-- failed (the newest run has status failed). With the new row a timed-out run of job 39
-- reads warn (the newest run failed) until the next success, and a night with no run at
-- all reads fail (stale) after 26 h. Replay before applying (read-only, 2026-11-12 04:52Z;
-- row 19's query over the table plus the new row as a union): 21 jobs, 0 missing, 0
-- inactive, 0 stale, 0 failed. The new row's newest run started 2026-11-12 04:05:00Z, 0.80
-- h old against a 26 h gap, so it reads pass and the detail changes from "20 iş
-- izleniyor" to "21 iş izleniyor". Applying this cannot turn the live heartbeat red.
--
-- READ-ONLY REPLAY BEFORE APPLY (results of 2026-11-12):
--   select command, schedule, active from cron.job where jobname = 'jev-signals-nightly';
--     the three selects, '05 4 * * *', true
--   select reset_val from pg_settings where name = 'statement_timeout';          120000
--   select start_time, status, end_time - start_time from cron.job_run_details
--     where jobid = 39 order by start_time desc limit 5;
--     11-12 111.6 s, 11-11 105.9 s, 11-10 105.8 s, 11-09 100.6 s, 11-08 55.0 s, all succeeded
--
-- DEPLOY ORDER: none. Apply with `supabase db push` (or post the SQL; the PR applies
-- nothing; the founder applies it): no app change, no Edge Function deploy, no index, no
-- data write. Ship before about Nov 14 04:05Z, when a run first risks reaching 120 s; the
-- next 04:05Z run after applying uses the new command. Safe to re-apply: the same command
-- is set again and the insert is `do nothing`.
--
-- VERIFY (read-only, after applying):
--   select command, schedule, active from cron.job where jobname = 'jev-signals-nightly';
--     the command starts with "set local statement_timeout = '5min';", the schedule and
--     active are unchanged ('05 4 * * *', true)
--   select jobname, max_gap, note from public.ops_cron_expected
--     where jobname = 'jev-signals-nightly';      26:00:00, '05 4 * * *'
--   select status, detail from public.ops_health_report()
--     where check_name = 'cron_jobs_stalled';     pass, 21 iş izleniyor
--   select start_time, status, end_time - start_time from cron.job_run_details
--     where jobid = 39 order by start_time desc limit 3;
--     the next 04:05Z run has status succeeded
--
-- ROLLBACK (nothing else depends on 205):
--   select cron.alter_job((select jobid from cron.job where jobname = 'jev-signals-nightly'),
--     command := 'select public.jev_source_drift_compute(); select public.jev_kap_canary_compute(); select public.jev_alerts_auto_resolve();');
--   delete from public.ops_cron_expected where jobname = 'jev-signals-nightly';
--   delete from supabase_migrations.schema_migrations where version = '205';
-- The restored command differs from 073's text only in whitespace.

begin;

set local lock_timeout = '5s';

-- 1. The command of job 39: the timeout first, then the three selects of 073 unchanged.
--    No pg_cron, or no job of that name: a notice and a skip, as in 144 and 148.
do $jev_timeout$
declare
  v_job bigint;
begin
  if to_regclass('cron.job') is null then
    raise notice '205: pg_cron not installed, skipping the jev-signals-nightly command change';
  else
    select jobid into v_job from cron.job where jobname = 'jev-signals-nightly';
    if v_job is null then
      raise notice '205: jev-signals-nightly is not scheduled, skipping the command change';
    else
      perform cron.alter_job(
        job_id  := v_job,
        command := 'set local statement_timeout = ''5min''; select public.jev_source_drift_compute(); select public.jev_kap_canary_compute(); select public.jev_alerts_auto_resolve();');
    end if;
  end if;
end
$jev_timeout$;

-- 2. The heartbeat row (cron_jobs_stalled): the job is watched with a 26 h gap.
--    No table (150 not applied): a notice and a skip.
do $jev_watch$
begin
  if to_regclass('public.ops_cron_expected') is not null then
    insert into public.ops_cron_expected (jobname, max_gap, note)
      values ('jev-signals-nightly', interval '26 hours', '05 4 * * *')
      on conflict (jobname) do nothing;
  else
    raise notice '205: public.ops_cron_expected does not exist (apply 150 first), skipping the watch row';
  end if;
end
$jev_watch$;

insert into supabase_migrations.schema_migrations (version, name)
  values ('205', '205_jev_signals_timeout')
  on conflict do nothing;

commit;
