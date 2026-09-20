-- 055_coverage_semantics_and_context.sql
--
-- Three corrections after a week of live data (and an outside relevance
-- test that scored 15 of 25 article_tickers matches as not about the
-- company, e.g. ELITE on a Xiaomi phone story, ISYHO on a traffic accident
-- in a place called Işıklar).
--
-- 1. "Press ahead" was any mention in the 48 h before a filing. For a
--    ticker that is in the news every day that is always true: 280 of 488
--    covered disclosures in 7 days were flagged. It is now ABNORMAL
--    pre-filing attention: >= 2 articles in the 24 h before, and at least
--    3x the ticker's own daily rate over the 14 days before that.
--    "First coverage" is now the first article AT OR AFTER the filing.
--
-- 2. Auto aliases (one title token) only count inside finance context: the
--    article is category 'ekonomi' or carries market vocabulary. Manual
--    aliases and ticker codes stay unconditional. On 6 days of prod data
--    this keeps 56% of auto matches.
--
-- 3. price_at() fell back to the article day's own daily close, i.e. a
--    price from after the headline. It now uses the last close strictly
--    before the article unless the article came after that day's close.

begin;

-- 1. Resolver with finance context -------------------------------------------

create or replace function public.resolve_article_tickers_for(p_ids uuid[])
returns integer
language plpgsql
as $$
declare
  v_n integer;
begin
  with recent as (
    select a.id,
           a.title || ' ' || coalesce(a.description, '') as raw,
           ' ' || public.fold_tr(a.title || ' ' || coalesce(a.description, '')) || ' ' as folded,
           a.category
    from public.articles a
    where a.id = any (p_ids)
      and coalesce(a.category, '') <> 'spor'
  ),
  ctx as (
    select r.*,
           (r.category = 'ekonomi' or r.folded ~ public.finance_context_regex()) as fin_ctx
    from recent r
  ),
  alias_hits as (
    select r.id as article_id, al.ticker, 'alias:' || al.alias as matched_on
    from ctx r
    join public.bist_aliases al
      on al.enabled
     and (al.origin = 'manual' or r.fin_ctx)
     and strpos(r.folded, ' ' || al.alias || ' ') > 0
  ),
  code_hits as (
    select distinct r.id as article_id, c.ticker, 'code' as matched_on
    from ctx r
    cross join lateral regexp_matches(r.raw, '\m([A-Z]{4,6})\M', 'g') m
    join (
      select unnest(tickers) as ticker from public.bist_companies where shares_traded
    ) c on c.ticker = m[1]
  ),
  hits as (
    select * from alias_hits
    union all
    select * from code_hits
  )
  insert into public.article_tickers (article_id, ticker, matched_on)
  select distinct on (article_id, ticker) article_id, ticker, matched_on
  from hits
  on conflict do nothing;

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Market vocabulary, matched against fold_tr() text (lowercase ASCII,
-- single spaces). Deliberately excludes everyday words like fiyat, milyon,
-- dolar, satis: a phone review has those too.
create or replace function public.finance_context_regex()
returns text
language sql
immutable
as $$
  select '\m(hisse|hisseleri|hissesi|hisselerinde|borsa|borsada|bist|kap|paylari|yatirimci|yatirimcilar|sirket|sirketi|sirketin|holding|bilanco|temettu|halka arz|sermaye|ciro|ihale|spk|genel kurul|bedelsiz|bedelli|geri alim|net kar|net zarar|finansal sonuc|ceyrek)\M'::text;
$$;

update public.bist_aliases set enabled = false
where origin = 'auto' and alias in ('elite', 'isiklar');

-- Drop stored auto-alias matches that fail the new rule or use a disabled alias.
delete from public.article_tickers t
using public.bist_aliases al, public.articles a
where t.matched_on = 'alias:' || al.alias
  and al.ticker = t.ticker
  and a.id = t.article_id
  and (
    not al.enabled
    or (al.origin = 'auto'
        and coalesce(a.category, '') <> 'ekonomi'
        and not (' ' || public.fold_tr(a.title || ' ' || coalesce(a.description, '')) || ' ') ~ public.finance_context_regex())
  );

-- 2. Reference price without lookahead ------------------------------------------

create or replace function public.price_at(p_ticker text, p_ts timestamptz)
returns numeric
language sql
stable
as $$
  select coalesce(
    (select close from public.bist_bars_5m
      where ticker = p_ticker and ts <= p_ts
        and ts >= p_ts - interval '4 days'
      order by ts desc limit 1),
    (select close from public.bist_bars_daily
      where ticker = p_ticker
        and day <= case
          when (p_ts at time zone 'Europe/Istanbul')::time >= time '18:10'
            then (p_ts at time zone 'Europe/Istanbul')::date
          else (p_ts at time zone 'Europe/Istanbul')::date - 1
        end
      order by day desc limit 1)
  );
$$;

-- 3. Signals: press_ahead = abnormal pre-filing attention ------------------------

create or replace view public.finance_signals as
with ist_today as (
  select (now() at time zone 'Europe/Istanbul')::date as d
),
today as (
  select t.ticker, sum(t.articles)::numeric as n
  from public.ticker_attention_daily t, ist_today
  where t.day = ist_today.d
  group by 1
),
base as (
  select t.ticker, sum(t.articles)::numeric / 7 as n
  from public.ticker_attention_daily t, ist_today
  where t.day >= ist_today.d - 7 and t.day < ist_today.d
  group by 1
),
pre as (
  select
    d.disclosure_index, c.ticker, d.published_at as disclosed_at, d.subject,
    (select count(*) from public.article_tickers t join public.articles a on a.id = t.article_id
       where t.ticker = c.ticker
         and a.published_at >= d.published_at - interval '24 hours'
         and a.published_at <  d.published_at)::numeric as pre24,
    (select count(*) from public.article_tickers t join public.articles a on a.id = t.article_id
       where t.ticker = c.ticker
         and a.published_at >= d.published_at - interval '15 days'
         and a.published_at <  d.published_at - interval '24 hours')::numeric / 14 as base_daily
  from public.kap_disclosures d
  cross join lateral unnest(d.stock_codes) as c(ticker)
  join public.bist_companies bc on c.ticker = any (bc.tickers) and bc.shares_traded
  where d.published_at >= now() - interval '7 days'
    and d.disclosure_class in ('FR', 'ODA')
    and coalesce(d.subject, '') not ilike '%devre kesici%'
)
select
  'attention_spike'::text as kind,
  t.ticker,
  round(t.n / greatest(coalesce(b.n, 0.5), 0.5), 1) as score,
  jsonb_build_object('today', t.n, 'avg7d', round(coalesce(b.n, 0), 1)) as evidence,
  now() as observed_at
from today t
left join base b using (ticker)
where t.n >= 3 and t.n >= 3 * greatest(coalesce(b.n, 0.5), 0.5)

union all

select
  'silent_disclosure',
  c.ticker,
  (case when d.disclosure_class = 'FR' then 3 else 1 end)::numeric,
  jsonb_build_object(
    'disclosure_index', d.disclosure_index,
    'subject', d.subject,
    'class', d.disclosure_class,
    'disclosed_at', d.published_at
  ),
  d.published_at
from public.kap_disclosures d
cross join lateral unnest(d.stock_codes) as c(ticker)
join public.bist_companies bc on c.ticker = any (bc.tickers) and bc.shares_traded
where d.published_at >= now() - interval '48 hours'
  and d.disclosure_class in ('FR', 'ODA')
  and coalesce(d.subject, '') not ilike '%devre kesici%'
  and not exists (
    select 1 from public.disclosure_coverage cv
    where cv.disclosure_index = d.disclosure_index and cv.ticker = c.ticker
      and cv.lag_minutes >= 0
  )

union all

select
  'press_ahead',
  p.ticker,
  round(p.pre24 / greatest(p.base_daily, 0.5), 1),
  jsonb_build_object(
    'disclosure_index', p.disclosure_index,
    'subject', p.subject,
    'articles_before', p.pre24,
    'baseline_daily', round(p.base_daily, 2),
    'disclosed_at', p.disclosed_at
  ),
  p.disclosed_at
from pre p
where p.pre24 >= 2 and p.pre24 >= 3 * greatest(p.base_daily, 0.5);

-- 4. ML disclosure events: first coverage is post-filing; pre-filing attention added
--    (new columns go last; create or replace cannot reorder).

create or replace view public.ml_disclosure_events as
select
  d.disclosure_index,
  c.ticker,
  d.published_at,
  d.disclosure_class,
  d.subject,
  d.is_late,
  (select count(*) from public.disclosure_coverage cv
     where cv.disclosure_index = d.disclosure_index and cv.ticker = c.ticker) as coverage_articles,
  (select min(cv.lag_minutes) from public.disclosure_coverage cv
     where cv.disclosure_index = d.disclosure_index and cv.ticker = c.ticker and cv.lag_minutes >= 0) as first_coverage_lag_min,
  (select coalesce(sum(x.articles), 0) from public.ticker_attention_daily x
     where x.ticker = c.ticker
       and x.day >= (d.published_at at time zone 'Europe/Istanbul')::date - 7
       and x.day <  (d.published_at at time zone 'Europe/Istanbul')::date) as attention_prev7,
  r.entry_day, r.entry_close, r.r0, r.r1, r.r5, r.r20, r.pre5,
  (select count(*) from public.disclosure_coverage cv
     where cv.disclosure_index = d.disclosure_index and cv.ticker = c.ticker
       and cv.lag_minutes >= -1440 and cv.lag_minutes < 0) as pre24_articles
from public.kap_disclosures d
cross join lateral unnest(d.stock_codes) as c(ticker)
join public.bist_companies bc on c.ticker = any (bc.tickers) and bc.shares_traded
left join lateral public.bar_returns(c.ticker, d.published_at) r on true;

commit;
