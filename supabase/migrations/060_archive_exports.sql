-- 060_archive_exports.sql
--
-- Tayf Arşiv (deck M-10, "collect first"): one ledger row per nightly export
-- of what Tayf saw on a given UTC day. The export itself lives in the
-- PRIVATE storage bucket `tayf-archive` (created out-of-band by the
-- operator via storage.buckets; this migration never touches storage) as
-- `YYYY/MM/DD/clusters.jsonl`, `articles.jsonl` and `manifest.json`, written
-- by the `archive-export` Edge Function scheduled below.
--
-- Contents are headlines and URLs only -- cluster titles, member article
-- titles, article URLs, source slug + zone, timestamps. No descriptions,
-- bodies, images or reader data are exported. Retention is a legal decision
-- pending counsel (working assumption: keep >= 2 years); until then nothing
-- prunes the bucket and nothing exposes it -- the bucket stays private, and
-- this table is service_role-only (RLS on, no policies, explicit revoke
-- from anon/authenticated/public -- same shell as 041/057/059).
--
-- Coverage bound: a day's file holds the clusters whose first_published
-- falls in that UTC day *as of export time*, plus the members those clusters
-- had then. A day is closed by its ledger row (the function skips a day that
-- already has one), so an article attached to a yesterday cluster after the
-- export ran is not back-filled into yesterday's file.
--
-- Idempotency: `day` is unique, so the function skips a day that already
-- has a row and a re-run of this file is a no-op (`if not exists`, idempotent
-- cron reschedule, ledger insert `on conflict do nothing`).

begin;

create table if not exists public.archive_exports (
  id uuid primary key default gen_random_uuid(),
  day date not null unique,
  object_path text not null,
  sha256 text not null,
  rows integer not null default 0,
  bytes bigint not null default 0,
  created_at timestamptz not null default now()
);

comment on table public.archive_exports is
  'One row per nightly Tayf Arşiv export (M-10). object_path is the '
  'YYYY/MM/DD prefix inside the private tayf-archive bucket; sha256 is the '
  'hex digest of that prefix''s manifest.json (which carries per-file '
  'digests); rows/bytes sum clusters.jsonl + articles.jsonl. Exports hold '
  'headlines and URLs only. Retention >= 2 years pending counsel.';

alter table public.archive_exports enable row level security;
revoke all on public.archive_exports from anon, authenticated, public;
grant select, insert on public.archive_exports to service_role;

-- Nightly 03:40 UTC (~06:40 Europe/Istanbul): a quiet slot clear of
-- kap-corrections-daily (03:15) and ahead of prune-nightly (04:10),
-- alias-prune (04:20), bars-5m-prune (04:25) and reader-data-purge (04:40).
-- (articles-vacuum is not a boundary to sit after -- it runs every 30 min,
-- 045_articles_autovacuum.sql.) Same do-block
-- shape as 058's kap-corrections-daily: idempotent reschedule, skipped
-- with a notice when pg_cron/pg_net or the Vault bearer are absent.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_net')
  then
    raise notice 'pg_cron/pg_net missing — skipping archive-export schedule (060_archive_exports.sql).';
    return;
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'service_role_key')
     or not exists (select 1 from vault.decrypted_secrets where name = 'functions_base_url')
  then
    raise notice 'Vault secrets missing — skipping archive-export schedule (060). See 038.';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'archive-export') then
    perform cron.unschedule('archive-export');
  end if;

  perform cron.schedule('archive-export', '40 3 * * *', $sql$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_base_url') || '/archive-export',
      headers := jsonb_build_object('Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000)
  $sql$);
end
$$;

insert into supabase_migrations.schema_migrations (version, name)
  values ('060', '060_archive_exports')
  on conflict do nothing;

commit;
