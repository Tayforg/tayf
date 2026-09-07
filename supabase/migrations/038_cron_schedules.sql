-- 038_cron_schedules.sql
--
-- Moves the pg_cron schedule for the three worker-stream drains
-- (ingest-drain, cluster-drain, image-drain — previously hand-run in the
-- Supabase Dashboard SQL Editor per docs/migration-guide.md section 3)
-- into a portable, idempotent migration, and adds a fourth job,
-- prune-nightly, that calls the two retention functions from migration
-- 037 once a day.
--
-- pg_cron and pg_net are project-scoped extensions that local Postgres
-- does not have, so the whole body is one DO block that exits with a
-- NOTICE (not an error) when either is missing.
--
-- No literal secret or project URL is baked in. The job bodies read two
-- Supabase Vault secrets at RUN time (every time pg_cron fires):
--
--   service_role_key    — the bearer the Edge Functions accept
--   functions_base_url  — e.g. https://<ref>.supabase.co/functions/v1
--
-- Create them once before applying this migration (Dashboard → SQL Editor):
--
--   select vault.create_secret('<service-role key>', 'service_role_key');
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1', 'functions_base_url');
--
-- When pg_cron IS present but either secret is missing, this migration
-- raises so the gap is caught at apply time, not later in job_run_details.
--
-- Idempotency: every job is unscheduled by name (if it exists) before
-- being rescheduled, so re-running this file always converges to the same
-- four jobs.

do $$
declare
  v_jobname text;
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_net')
  then
    raise notice
      'pg_cron and/or pg_net not installed — skipping cron schedule setup (038_cron_schedules.sql). '
      'This is expected on local Postgres; apply on a project that has both extensions.';
    return;
  end if;

  if not exists (select 1 from vault.decrypted_secrets where name = 'service_role_key') then
    raise exception
      'Vault secret service_role_key is missing. Run `select vault.create_secret(''<service-role key>'', ''service_role_key'');` before applying 038 — see docs/migration-guide.md section 3.';
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'functions_base_url') then
    raise exception
      'Vault secret functions_base_url is missing. Run `select vault.create_secret(''https://<ref>.supabase.co/functions/v1'', ''functions_base_url'');` before applying 038 — see docs/migration-guide.md section 3.';
  end if;

  foreach v_jobname in array array['ingest-drain', 'cluster-drain', 'image-drain', 'prune-nightly']
  loop
    if exists (select 1 from cron.job where jobname = v_jobname) then
      perform cron.unschedule(v_jobname);
    end if;
  end loop;

  perform cron.schedule(
    'ingest-drain',
    '*/3 * * * *',
    $sql$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_base_url') || '/ingest',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 60000
      )
    $sql$
  );

  perform cron.schedule(
    'cluster-drain',
    '* * * * *',
    $sql$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_base_url') || '/cluster-consumer',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 60000
      )
    $sql$
  );

  perform cron.schedule(
    'image-drain',
    '*/5 * * * *',
    $sql$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_base_url') || '/image-consumer',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 60000
      )
    $sql$
  );

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
