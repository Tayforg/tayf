-- 043_reader_data_purge_cron.sql
--
-- Schedules public.purge_reader_data() (migration 042) to run nightly at
-- 04:40 UTC — deliberately 30 minutes after migration 038's nightly
-- retention sweep (04:10) so the two never overlap.
--
-- Migration 038 drives its jobs over an outbound HTTP call, which needs a
-- pair of project extensions plus a couple of stored secrets to build the
-- request. This job is simpler: purge_reader_data() runs entirely inside
-- Postgres against tables in this same database, so there is nothing to
-- call out to and nothing to configure beyond the schedule itself — the
-- whole job body is a single `select public.purge_reader_data();`. The DO
-- block below therefore only needs to guard on the scheduler extension
-- being present, and exits with a NOTICE, not an error, when it is
-- missing — expected on local Postgres, which does not have it.
--
-- Idempotency: the job is unscheduled by name (if it exists) before being
-- rescheduled, so re-running this file always converges to the same single
-- job. This migration does not schedule, unschedule, or otherwise touch
-- any of migration 038's jobs.

do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    raise notice
      'pg_cron not installed — skipping cron schedule setup (043_reader_data_purge_cron.sql). '
      'Expected on local Postgres; apply on a project that has it.';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'reader-data-purge') then
    perform cron.unschedule('reader-data-purge');
  end if;

  perform cron.schedule(
    'reader-data-purge',
    '40 4 * * *',
    $sql$
      select public.purge_reader_data();
    $sql$
  );
end
$$;
