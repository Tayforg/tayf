-- 054_ticker_page_perf.sql
--
-- /ekonomi/[ticker] timed out in production ("canceling statement due to
-- statement timeout") on its article list. The PostgREST form
--   articles?select=...,article_tickers!inner(ticker)&article_tickers.ticker=eq.X
--   &order=published_at.desc&limit=60
-- walks articles newest-first and probes article_tickers per row, which is
-- the wrong direction: article_tickers(ticker) is indexed and small per
-- ticker. ticker_articles() starts there and joins back.
--
-- Same shape of problem in disclosure_coverage: `t.ticker = any (d.stock_codes)`
-- cannot use the GIN index on stock_codes; `d.stock_codes @> array[t.ticker]`
-- can. The view is recreated with that form (same columns).

begin;

create or replace function public.ticker_articles(p_ticker text, p_limit int default 60)
returns table (
  id uuid,
  title text,
  url text,
  published_at timestamptz,
  category text,
  source_name text,
  source_slug text,
  matched_on text
)
language sql
stable
as $$
  select a.id, a.title, a.url, a.published_at, a.category, s.name, s.slug, t.matched_on
  from public.article_tickers t
  join public.articles a on a.id = t.article_id
  left join public.sources s on s.id = a.source_id
  where t.ticker = p_ticker
  order by a.published_at desc
  limit p_limit;
$$;

create index if not exists article_tickers_ticker_created_idx
  on public.article_tickers (ticker, created_at desc);

create or replace view public.disclosure_coverage as
select
  d.disclosure_index,
  t.ticker,
  d.published_at                                       as disclosed_at,
  a.id                                                 as article_id,
  a.source_id,
  a.published_at                                       as article_at,
  round(extract(epoch from (a.published_at - d.published_at)) / 60)::int as lag_minutes,
  t.matched_on
from public.kap_disclosures d
join public.article_tickers t on d.stock_codes @> array[t.ticker]
join public.articles a on a.id = t.article_id
where a.published_at between d.published_at - interval '2 days'
                         and d.published_at + interval '5 days';

commit;
