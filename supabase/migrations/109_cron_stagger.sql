-- 109_cron_stagger.sql
--
-- Moves the two heaviest recurring cron jobs off the jev-shadow minutes.
-- Schedule-only change through cron.alter_job: each job keeps its command,
-- database, user and active flag exactly as its own migration left them.
--
-- WHY. jev-shadow runs at :00/:10/.../:50 (061). Two heavy jobs also start at
-- :00 on the Micro instance (256 MB shared_buffers vs a 5.2 GB database):
--   trends-rollup-refresh  '0 * * * *'   (092)  6 h avg 34 s, max 106 s
--   articles-vacuum        '*/30 * * * *' (045)  6 h avg 67 s, max 197 s
-- Every zero-call jev-shadow run on 2026-10-21/22 started on the hour
-- (runs 3617 23:01, 3623 00:00, 3629 01:00: status partial, calls 0, the
-- candidate reads lost the cache to the rollup + vacuum). Runs at the other
-- five minutes of each hour were all ok. With 108's stall check counting
-- zero-call runs, that collision would also warn every hour.
--
-- NEW SLOTS (minute map after 109; jev-shadow :x0, cluster-topics-refresh :x3,
-- blindspot-recall-veto :x7, framing pool */5, karne batch */15, all short):
--   trends-rollup-refresh  '25 * * * *'    after the :20 jev run (<= 60 s),
--                                          done before the :30 run
--   articles-vacuum        '15,45 * * * *' between the :10/:20 and :40/:50
--                                          jev runs; a 197 s worst case still
--                                          ends by :18:17 / :48:17
-- The vacuum cadence (every 30 min) and the rollup cadence (hourly) are
-- unchanged.
--
-- Idempotent: alter_job to the same schedule is a no-op. Missing pg_cron or
-- a missing job raises a notice and skips (local/CI databases).
-- Rollback: select cron.alter_job((select jobid from cron.job where jobname =
--   'trends-rollup-refresh'), schedule := '0 * * * *'); and likewise
--   'articles-vacuum' -> '*/30 * * * *'.

begin;

do $stagger$
declare
  v_job bigint;
begin
  if to_regclass('cron.job') is null then
    raise notice '109: pg_cron not installed, skipping';
    return;
  end if;

  select jobid into v_job from cron.job where jobname = 'trends-rollup-refresh';
  if v_job is null then
    raise notice '109: trends-rollup-refresh not scheduled, skipping';
  else
    perform cron.alter_job(v_job, schedule := '25 * * * *');
  end if;

  v_job := null;
  select jobid into v_job from cron.job where jobname = 'articles-vacuum';
  if v_job is null then
    raise notice '109: articles-vacuum not scheduled, skipping';
  else
    perform cron.alter_job(v_job, schedule := '15,45 * * * *');
  end if;
end
$stagger$;

insert into supabase_migrations.schema_migrations (version, name)
  values ('109', '109_cron_stagger')
  on conflict do nothing;

commit;
