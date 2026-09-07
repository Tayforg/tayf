-- 038_cron_schedules.sql
--
-- Moves the pg_cron schedule for the three worker-stream drains
-- (ingest-drain, cluster-drain, image-drain — previously hand-run in the
-- Supabase Dashboard SQL Editor per docs/migration-guide.md section 3)
-- into a portable, idempotent migration, and adds a fourth job,
-- prune-nightly, that calls the two retention functions from migration
-- 037 once a day.
--
-- Why this used to be hand-run instead of a migration: pg_cron and pg_net
-- are project-scoped extensions (their grants differ between Supabase
-- Free and Pro) that are NOT installed by `supabase db push` on a fresh
-- project, and local Postgres (`supabase start`) has neither. A migration
-- that unconditionally called cron.schedule() would fail outright on any
-- environment without those extensions. So the whole body below is
-- wrapped in one DO block that checks pg_extension for both first and
-- exits with a NOTICE (not an error) when either is missing — safe to run
-- against local dev, and a real schedule change on any project that has
-- them.
--
-- No literal secret or project URL is baked in anywhere in this file. The
-- job bodies call current_setting(..., true) at RUN time (every time
-- pg_cron fires the job), exactly like the Dashboard-run SQL they replace
-- for the bearer token — the only difference is the Edge Functions base
-- URL now comes from a second setting instead of a literal URL
-- substituted by hand. Both settings must be set once, before this
-- migration is applied (see docs/migration-guide.md, section 3):
--
--   alter database postgres set app.service_role_key = '<service-role key>';
--   alter database postgres set app.functions_base_url =
--     '<your project''s Edge Functions base URL>';
--
-- When pg_cron IS present but either setting is missing, this migration
-- raises an exception (rather than scheduling a job that will 401 or hit
-- a broken URL forever) so the gap is caught at apply time, not three
-- days later in cron.job_run_details.
--
-- Idempotency: every job is unscheduled by name (if it exists) before
-- being rescheduled, so re-running this file — e.g. after editing a
-- schedule or a job body — always converges to the same four jobs with no
-- duplicate-jobname error from pg_cron.

do $$
declare
  v_base_url text;
  v_jobname text;
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_net')
  then
    raise notice
      'pg_cron and/or pg_net not installed — skipping cron schedule setup (038_cron_schedules.sql). '
      'This is expected on local Postgres; apply manually on a project that has both extensions.';
    return;
  end if;

  -- Both settings must already exist (see docs/migration-guide.md section
  -- 3). current_setting(name, true) returns NULL instead of raising when
  -- unset, so we can surface a clear error here instead of pg_cron
  -- silently sending an empty bearer / calling a broken URL forever.
  if pg_catalog.current_setting('app.service_role_key', true) is null then
    raise exception
      'app.service_role_key is not set. Run `alter database postgres set '
      'app.service_role_key = ''<service-role key>'';` before applying 038 '
      '— see docs/migration-guide.md section 3.';
  end if;

  v_base_url := pg_catalog.current_setting('app.functions_base_url', true);
  if v_base_url is null then
    raise exception
      'app.functions_base_url is not set. Run `alter database postgres set '
      'app.functions_base_url = ''<your Edge Functions base URL>'';` '
      'before applying 038 — see docs/migration-guide.md section 3.';
  end if;

  -- Unschedule by name first — no-op for a job that doesn't exist yet, and
  -- what makes re-running this file safe after a schedule/body edit.
  foreach v_jobname in array array['ingest-drain', 'cluster-drain', 'image-drain', 'prune-nightly']
  loop
    if exists (select 1 from cron.job where jobname = v_jobname) then
      perform cron.unschedule(v_jobname);
    end if;
  end loop;

  -- Drive the ingest Edge Function every 3 minutes. Canonical ingest entry
  -- point — there is no other scheduled invoker.
  perform cron.schedule(
    'ingest-drain',
    '*/3 * * * *',
    $sql$
      select net.http_post(
        url := current_setting('app.functions_base_url', true) || '/ingest',
        headers := jsonb_build_object(
          'Authorization',
          'Bearer ' || coalesce(current_setting('app.service_role_key', true), '')
        )
      )
    $sql$
  );

  -- Drain cluster_work every minute.
  perform cron.schedule(
    'cluster-drain',
    '* * * * *',
    $sql$
      select net.http_post(
        url := current_setting('app.functions_base_url', true) || '/cluster-consumer',
        headers := jsonb_build_object(
          'Authorization',
          'Bearer ' || coalesce(current_setting('app.service_role_key', true), '')
        )
      )
    $sql$
  );

  -- Drain image_backfill every five minutes (lower priority, larger pages).
  perform cron.schedule(
    'image-drain',
    '*/5 * * * *',
    $sql$
      select net.http_post(
        url := current_setting('app.functions_base_url', true) || '/image-consumer',
        headers := jsonb_build_object(
          'Authorization',
          'Bearer ' || coalesce(current_setting('app.service_role_key', true), '')
        )
      )
    $sql$
  );

  -- Nightly retention: flag stale singleton clusters, then trim pgmq's
  -- archive tables. 04:10 UTC — off-peak, offset from the top of the hour
  -- so it doesn't coincide with any other scheduled job's tick.
  perform cron.schedule(
    'prune-nightly',
    '10 4 * * *',
    $sql$
      select public.prune_singleton_clusters();
      select public.trim_pgmq_archives();
    $sql$
  );
end
$$;
