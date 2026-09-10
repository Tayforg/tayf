-- 045_articles_autovacuum.sql
-- /sources and the footer count read `articles` through index-only scans on
-- idx_articles_source_published. Those scans need a fresh visibility map:
-- with the default autovacuum thresholds the map lags hours behind the
-- ingest inserts, the per-source count degrades from ~70 ms to ~5 s (a heap
-- fetch per row) and PostgREST's 8 s statement timeout turns /sources into
-- the error page. Measured 2026-09-10: 5,089 ms before VACUUM, 71 ms after.
alter table public.articles set (
  autovacuum_vacuum_insert_scale_factor = 0.005,
  autovacuum_vacuum_insert_threshold = 1000,
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.02
);

-- Belt and braces: an explicit VACUUM every 30 minutes keeps the map fresh
-- even while autovacuum is busy elsewhere. Idempotent: re-running replaces
-- the job. Rollback: cron.unschedule('articles-vacuum') and
-- alter table public.articles reset (autovacuum_vacuum_insert_scale_factor,
-- autovacuum_vacuum_insert_threshold, autovacuum_vacuum_scale_factor,
-- autovacuum_analyze_scale_factor).
do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron is not installed; skipping articles-vacuum schedule';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'articles-vacuum') then
    perform cron.unschedule('articles-vacuum');
  end if;
  perform cron.schedule(
    'articles-vacuum',
    '*/30 * * * *',
    'vacuum (analyze) public.articles'
  );
end
$$;
