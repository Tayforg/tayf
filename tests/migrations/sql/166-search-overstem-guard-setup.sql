-- 166 search over-stem guard: the state 166 sits on, for the local PG15 live harness. Never touches production.
--
-- Not a dry-run (no DRYRUN line; run-live.sh Phase A only runs *-dryrun.sql). It is the setup of the
-- 166-search-overstem-guard.test.ts live block (live-manifest.txt), after the 139 dry-run, and the first
-- step of 166-search-overstem-guard-dryrun.sql. It leaves a database in which 129 is applied and 166 is NOT,
-- so the live block can run the function before and after applying 166 itself.
--
-- Why a setup of its own. The 139 dry-run builds only part of the 129 state: public.tayf_search_fold, the
-- summary_tr and merged_into columns. It has no search_tsv column (035), no 083 live index, no 129 index and
-- no three-argument search_cluster_ids, all of which 166's function reads. This file adds exactly those
-- (idempotent, so it also runs on a bare stub): 035's generated column, 083's partial index, then 129 for real.
-- With 139's dry-run loaded first, tayf_search_fold is replaced by 129's own text (create or replace, same text).

\set ON_ERROR_STOP on

alter table public.clusters add column if not exists summary_tr text;

-- 035: the generated tsvector the variants arm reads, byte for byte.
alter table public.clusters
  add column if not exists search_tsv tsvector
  generated always as (
    to_tsvector(
      'turkish',
      coalesce(title_tr_neutral, '') || ' ' || coalesce(title_tr, '') || ' ' || coalesce(summary_tr, '')
    )
  ) stored;

-- 083: the partial GIN index the variants arm uses.
create index if not exists clusters_search_tsv_live_idx
  on public.clusters using gin (search_tsv)
  where not is_archived and article_count >= 2;

-- 014 and 037: the two updated_at partial indexes production has (129's LOCAL PROOF built the same two), so the
-- planner sees the indexes it sees there.
create index if not exists idx_clusters_active_updated_at on public.clusters (updated_at desc) where article_count >= 2;
create index if not exists clusters_active_updated_idx on public.clusters (updated_at desc) where is_archived = false;

-- 129 for real: the fold, the folded GIN index and the three-argument search_cluster_ids.
\ir ../../../supabase/migrations/129_search_fold_rank.sql
