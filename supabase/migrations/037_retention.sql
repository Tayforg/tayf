-- 037_retention.sql
--
-- Archival-only retention for singleton clusters, plus a pgmq archive
-- trimmer. Nothing in this migration deletes a cluster or an article —
-- "prune" here means flipping a flag so the home/politics list can filter
-- stale one-source noise out, not removing rows. See migration 038 for the
-- pg_cron schedule that calls these nightly.
--
-- What this installs:
--   1. clusters.is_archived (boolean, default false). A cluster becomes
--      archived when it never grew past a single source and has been
--      stale (updated_at) past the retention window — the common shape
--      of a one-off wire item that never attracted follow-up coverage.
--      Nothing reads is_archived yet outside this migration's own index
--      and function; wiring the home/politics queries to filter on it is
--      a follow-up.
--   2. clusters_active_updated_idx — a partial index mirroring
--      idx_clusters_active_updated_at from migration 014 (updated_at
--      DESC), but keyed on the new flag instead of article_count. Kept
--      as a separate index rather than folding into 014's — that index
--      stays untouched here (do not touch existing indexes).
--   3. public.prune_singleton_clusters(retention_days, batch) — flags
--      singleton clusters (article_count = 1) older than retention_days
--      as is_archived, LIMIT-batched so a first run against a large
--      backlog doesn't take one giant table lock. Returns the total rows
--      flagged across all batches.
--   4. public.trim_pgmq_archives(keep_days) — deletes rows from pgmq's
--      archive tables (pgmq.a_cluster_work, pgmq.a_image_backfill) older
--      than keep_days. These archive tables are the DLQ-lite audit trail
--      described in supabase/functions/_shared/pgmq.ts; they grow forever
--      otherwise. Guarded with to_regclass so it is a no-op (not an
--      error) on a database where pgmq was never installed — local
--      Postgres has neither pg_cron nor pg_net nor pgmq by default.
--
-- Idempotency: `add column if not exists`, `create index if not exists`,
-- and `create or replace function` are all safe to re-run.

begin;

-- 1. Column ------------------------------------------------------------------

alter table public.clusters
  add column if not exists is_archived boolean not null default false;

comment on column public.clusters.is_archived is
  'Set by public.prune_singleton_clusters() for stale singleton clusters. '
  'Archival only — the row and its articles are never deleted.';

-- 2. Partial index for "active" cluster listings ------------------------------
-- Mirrors 014's idx_clusters_active_updated_at shape but on is_archived
-- instead of article_count; that index is left untouched.

create index if not exists clusters_active_updated_idx
  on public.clusters (updated_at desc)
  where is_archived = false;

-- 3. Singleton-cluster retention ----------------------------------------------

create or replace function public.prune_singleton_clusters(
  retention_days int default 30,
  batch int default 5000
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total integer := 0;
  v_batch_count integer;
begin
  if batch is null or batch <= 0 then
    raise exception 'batch must be a positive integer, got %', batch;
  end if;

  if retention_days is null or retention_days < 0 then
    raise exception 'retention_days must be a non-negative integer, got %', retention_days;
  end if;

  loop
    with candidates as (
      select id
      from public.clusters
      where article_count = 1
        and is_archived = false
        and updated_at < pg_catalog.now() - pg_catalog.make_interval(days => retention_days)
      order by updated_at
      limit batch
      for update skip locked
    )
    update public.clusters c
    set is_archived = true
    from candidates
    where c.id = candidates.id;

    get diagnostics v_batch_count = row_count;
    v_total := v_total + v_batch_count;
    -- v_batch_count = 0 also ends the loop — belt-and-braces alongside the
    -- guard above so an empty pass never spins.
    exit when v_batch_count = 0 or v_batch_count < batch;
  end loop;

  return v_total;
end;
$$;

comment on function public.prune_singleton_clusters(int, int) is
  'Flags singleton clusters (article_count = 1) whose updated_at is older '
  'than retention_days as is_archived, in LIMITed batches of size batch. '
  'Raises if batch is null/<=0 or retention_days is null/negative — a '
  'non-positive batch would otherwise LIMIT-loop forever. Never deletes '
  'clusters or articles. Returns the total rows flagged. Scheduled nightly '
  'by migration 038 (prune-nightly, 04:10 UTC); safe to re-run manually — '
  'see docs/migration-guide.md, "Retention (037)".';

revoke execute on function public.prune_singleton_clusters(int, int)
  from anon, authenticated, public;
grant execute on function public.prune_singleton_clusters(int, int) to service_role;

-- 4. pgmq archive trimmer ------------------------------------------------------

create or replace function public.trim_pgmq_archives(keep_days int default 7)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer := 0;
  v_count integer;
begin
  -- No-op (not an error) where pgmq is absent, e.g. local Postgres.
  if pg_catalog.to_regclass('pgmq.a_cluster_work') is not null then
    delete from pgmq.a_cluster_work
    where archived_at < pg_catalog.now() - pg_catalog.make_interval(days => keep_days);
    get diagnostics v_count = row_count;
    v_deleted := v_deleted + v_count;
  end if;

  if pg_catalog.to_regclass('pgmq.a_image_backfill') is not null then
    delete from pgmq.a_image_backfill
    where archived_at < pg_catalog.now() - pg_catalog.make_interval(days => keep_days);
    get diagnostics v_count = row_count;
    v_deleted := v_deleted + v_count;
  end if;

  return v_deleted;
end;
$$;

comment on function public.trim_pgmq_archives(int) is
  'Deletes rows older than keep_days from the pgmq archive tables '
  '(pgmq.a_cluster_work, pgmq.a_image_backfill) — the DLQ-lite audit trail '
  'from supabase/functions/_shared/pgmq.ts. No-op where pgmq is not '
  'installed. Returns rows deleted. Scheduled nightly by migration 038.';

revoke execute on function public.trim_pgmq_archives(int)
  from anon, authenticated, public;
grant execute on function public.trim_pgmq_archives(int) to service_role;

commit;
