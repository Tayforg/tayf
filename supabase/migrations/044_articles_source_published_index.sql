-- 044_articles_source_published_index.sql
-- Composite index behind the per-source "articles in the last N days"
-- lookups (footer active-source count, /sources directory). Without it every
-- source resolves through a BitmapAnd of idx_articles_source_id and
-- idx_articles_published_at (~4.5 s for 118 sources in production, which
-- timed out the Vercel build's prerender).
create index if not exists idx_articles_source_published
  on public.articles (source_id, published_at desc);
