-- 144_blindspot_veto_cadence.sql
--
-- Halves the cost of the blindspot-recall-veto cron: '7-59/10 * * * *' becomes
-- '7-59/20 * * * *' (minutes 7, 27 and 47; 72 runs a day instead of 144).
-- Schedule-only change through cron.alter_job, found by job name. No function
-- change, no data write, no index, no grant, no new object.
--
-- WHY (h17-dbperf-1, measured read-only on production, 2026-11-02 00:5x UTC,
-- cron.job_run_details of job 34, command 'select public.blindspot_recall_veto_
-- refresh();'). The hourly mean run time was 2.03-2.37 s from 2026-10-31 18:00
-- to 2026-11-01 03:00 UTC, 3.53 s in the 04:00 hour (126 was applied about
-- 04:21) and 4.67-7.38 s in every hour since. Last 24 hours: 144 runs, 0
-- failed, 750 s in total, mean 5.21 s (it was about 2.2 s and 315 s a day),
-- max 13.70 s (20:00 hour). Cost only: the database is lightly loaded (0.11-0.17
-- average concurrency), so no reader sees a slower page.
--
-- WHY 126's "WARM" CLAIM DID NOT HOLD. 126:101-102 says the new body runs in
-- "0.47-0.48 s warm ... the cron runs every 10 minutes, so it is warm". It is
-- not: the instance is a Micro (256 MB shared_buffers against a 5.2 GB
-- database), and ten minutes of other traffic push the cluster_articles and
-- jev_shadow_predictions pages out. EXPLAIN (ANALYZE, BUFFERS) of the same CTE
-- chain: 3.46 s cold (shared read 10,210 buffers, temp written 1,319, mostly the
-- scand CTE's parallel sequential scan on cluster_articles and the
-- jev_shadow_predictions arm) against 0.54 s warm. Every 10-minute run therefore
-- pays the cold price, and a 20-minute cadence pays it half as often a day. The
-- per-run cost does not change; the number of runs does.
--
-- MINUTE MAP after 144:
--   jev-shadow :x0 ('*/10', 061)       cluster-topics-refresh :x3 ('3-59/10')
--   ops-health-snapshot :x4 ('4-59/10', 131)
--   blindspot-recall-veto :07, :27, :47 (109's :x7 slot, kept; 071 put it there)
--   framing */5, karne */15, trends-rollup-refresh :25, articles-vacuum :15/:45.
-- The veto minutes (7, 27, 47) are on none of the other jobs' minutes.
--
-- OPS READERS of this job, all checked (grep of scripts/ and supabase/):
--   1. blindspot_veto_cron_min in public.ops_health_report() -- the only check
--      that watches the job. Latest definition: 136_ops_heartbeat_app_side.sql
--      lines 560-592 (row 6 of the report).
--      Threshold 30: 'fail' when observed > 30, where observed is the minutes
--      since the newest succeeded end_time of the job, read from the last 5000
--      runids of cron.job_run_details. Those 5000 runids spanned 1 day 05:13 on
--      2026-11-02 (read-only), far more than the 40 minutes this needs, and 101's
--      compaction keeps at least the last hour (default 1 day) of run history.
--   2. 131's ops_health_snapshot tick at :x4 ('4-59/10'), which stores the
--      non-pass rows of that report. It sees :04 -> about 17 min since the :47 run,
--      :14 -> 7, :24 -> 17, :34 -> 7, :44 -> 17, :54 -> 7: at most about 17 min,
--      so it never records a steady-state fail.
--   3. cron_failed_runs_30m (the same report) counts failed runs of any job in the
--      last 30 minutes. Unaffected: it counts status = 'failed' rows, and fewer
--      runs can only mean fewer failures.
--   4. No other reader: nothing in scripts/ and no other function in supabase/
--      looks at this job's schedule or run history. The remaining migrations that
--      mention the job are 071 (creates it), 126 (leaves it alone) and the
--      earlier ops_health_report versions that 136 replaced.
--
-- MARGIN. Steady-state worst case = 20 min + the worst observed run (13.70 s)
-- = about 20.2 min, against the threshold 30: about 9.8 min of margin, so a slow
-- run alone can never trip the check. tests/migrations/144-blindspot-veto-
-- cadence.test.ts reads the threshold out of the newest ops_health_report()
-- definition, so a later threshold edit breaks that test.
--
-- TRADE-OFFS.
--   * One failed run now trips blindspot_veto_cron_min: the next success is about
--     40 min after the previous one (> 30), where with the 10-minute cadence three
--     consecutive missed runs were needed. pg_cron does not retry; the failed row
--     also shows in cron_failed_runs_30m. This is the price of the halved cost.
--   * A vetoed blindspot badge (and a veto that should clear) can stay up to 10
--     minutes longer than before: the reader-facing claim is withdrawn or
--     restored at the next run, now at most 20 minutes after the cause instead
--     of 10. The veto never rewrites is_blindspot; it is applied at read time.
--
-- EXPECTED after apply (re-measure 24 h later with the same job_run_details
-- query): 72 runs a day, about 375 s a day (72 x 5.21 s), 0 failed. If the mean
-- per run drops, that is a warmer cache from less eviction; if it rises toward
-- 7 s, the cadence still halves the total.
--
-- Idempotent: alter_job to the same schedule is a no-op; the ledger insert is
-- on conflict do nothing. Missing pg_cron or a missing job raises a notice and
-- skips (local/CI databases).
-- Rollback: select cron.alter_job((select jobid from cron.job where jobname =
--   'blindspot-recall-veto'), schedule := '7-59/10 * * * *'); and
--   delete from supabase_migrations.schema_migrations where version = '144';
--
-- DRY-RUN (2026-11-02, local PostgreSQL 15.12, throwaway cluster on
-- 127.0.0.1:55444 with the QA stub schema loaded; psql -v ON_ERROR_STOP=1 -f,
-- cluster stopped and its data directory deleted afterwards):
--   (1) no cron schema, applied twice: both runs printed
--         NOTICE:  144: pg_cron not installed, skipping
--       and exited 0; schema_migrations held one row, 144 | 144_blindspot_veto_cadence.
--   (2) stub cron schema (cron.job + a cron.alter_job that updates only the
--       non-null arguments), job missing, applied twice: both runs printed
--         NOTICE:  144: blindspot-recall-veto not scheduled, skipping
--       with cron.job still empty.
--   (3) jobs 'blindspot-recall-veto' '7-59/10 * * * *' and 'jev-shadow'
--       '*/10 * * * *' inserted, 144 applied (exit 0, no notice): the veto job is
--       '7-59/20 * * * *'; its command (select public.blindspot_recall_veto_refresh();),
--       its active flag and the whole jev-shadow row are unchanged.
--   (4) applied again: exit 0, same schedule, same rows, still one ledger row.
--   The rollback statement above, run on the stub, put the veto job back on
--   '7-59/10 * * * *' and the ledger delete left no row.

begin;

do $veto_cadence$
declare
  v_job bigint;
begin
  if to_regclass('cron.job') is null then
    raise notice '144: pg_cron not installed, skipping';
    return;
  end if;

  select jobid into v_job from cron.job where jobname = 'blindspot-recall-veto';
  if v_job is null then
    raise notice '144: blindspot-recall-veto not scheduled, skipping';
  else
    perform cron.alter_job(job_id := v_job, schedule := '7-59/20 * * * *');
  end if;
end
$veto_cadence$;

insert into supabase_migrations.schema_migrations (version, name)
  values ('144', '144_blindspot_veto_cadence')
  on conflict do nothing;

commit;
