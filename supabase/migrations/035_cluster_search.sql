-- 035: Full-text search over clusters (`search_tsv`).
--
-- Backs search-query.ts's archive fallback: when the homepage's in-memory
-- title filter (which only sees the already-fetched top clusters) finds
-- nothing, the page falls back to a real Postgres full-text query across
-- ALL clusters, ordered by article_count / updated_at.
--
-- WARNING — one-time table rewrite: `add column ... generated always as
-- (...) stored` computes and writes the tsvector for EVERY existing row,
-- not just new ones. Production carries ~170k cluster rows, so this
-- ALTER TABLE will take noticeably longer than a plain column add and
-- holds the same lock class (ACCESS EXCLUSIVE for the duration of the
-- rewrite) — plan to run it off-peak, same caution as migration 034's
-- backfill note.
--
-- 'turkish' text search config folds Turkish morphology (stems, stop
-- words) so a query like "seçim" also matches "seçimi", "seçimler", etc.
-- Indexed columns mirror the H2 neutral-headline coalesce order used
-- everywhere else (title_tr_neutral, then title_tr) plus summary_tr.

alter table public.clusters
  add column if not exists search_tsv tsvector
  generated always as (
    to_tsvector(
      'turkish',
      coalesce(title_tr_neutral, '') || ' ' || coalesce(title_tr, '') || ' ' || coalesce(summary_tr, '')
    )
  ) stored;

create index if not exists clusters_search_tsv_idx
  on public.clusters using gin (search_tsv);

comment on column public.clusters.search_tsv is
  'Generated tsvector (turkish config) over title_tr_neutral || title_tr || summary_tr. '
  'Backs search-query.ts full-text fallback search via clusters_search_tsv_idx (GIN).';
