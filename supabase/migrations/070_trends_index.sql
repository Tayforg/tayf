-- 070_trends_index.sql
--
-- /trends prerender was aborting `next build` (twice on 2026-09-21) with
-- "canceling statement due to statement timeout": the
-- trends_daily_bias_counts view (migration 023) groups the WHOLE articles
-- table by a computed day expression, so its `day >= cutoff` filter can
-- use no index and Postgres seq-scans the wide articles heap (197,797 rows,
-- 7.0 s measured, against PostgREST's 8 s statement_timeout).
--
-- A covering index on exactly the two columns the view reads lets the
-- planner answer it with an index-only scan: 7,030 ms -> 965 ms measured
-- in production right after creation. Additive only; nothing else changes.

create index if not exists idx_articles_created_source
  on public.articles (created_at, source_id);

comment on index public.idx_articles_created_source is
  'Covering index for trends_daily_bias_counts (migration 070): the view '
  'reads only created_at and source_id from articles, so this turns its '
  'full heap seq scan into an index-only scan. Keep autovacuum on articles '
  'healthy (migration 045) or the visibility map goes stale and the scan '
  'degrades back toward the heap.';

insert into supabase_migrations.schema_migrations (version, name)
  values ('070', '070_trends_index')
  on conflict do nothing;
