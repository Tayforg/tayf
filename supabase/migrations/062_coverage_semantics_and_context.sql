-- 062_coverage_semantics_and_context.sql
--
-- Three semantic corrections to the Ekonomi feature after a week of live
-- data (and an outside relevance test that scored 15 of 25 article_tickers
-- matches as not about the company: ELITE on a Xiaomi phone story, ISYHO on
-- a traffic accident in a place called Işıklar).
--
-- Every object below is rebuilt FROM ITS 058 BODY, so 058's hardening
-- stays: resolver `set search_path = ''` with pg_catalog-qualified calls
-- and the published_at/source_id carry, the GIN-friendly
-- `bc.tickers @> array[c.ticker]` join, and security_invoker on the two
-- views (re-issued at the end; a bare CREATE OR REPLACE VIEW resets
-- reloptions). Function ACLs survive CREATE OR REPLACE; the one new
-- function gets its own REVOKE/GRANT.
--
-- 1. "Press ahead" was any mention in the 48 h before a filing. For a
--    ticker that is in the news every day that is always true: 280 of 488
--    covered disclosures in 7 days were flagged. It is now ABNORMAL
--    pre-filing attention: >= 2 articles in the 24 h before, and at least
--    3x the ticker's own daily rate over the 14 days before that. Counted
--    on article_tickers.published_at (058's denormalized, indexed column),
--    no join to articles. "First coverage" is the first article AT OR
--    AFTER the filing; silent_disclosure means none of those exist.
--
-- 2. Auto aliases (one title token) only count inside finance context: the
--    article is category 'ekonomi' or carries market vocabulary. Manual
--    aliases and ticker codes stay unconditional. On 6 days of prod data
--    this kept 61% of stored matches.
--
-- 3. price_at() fell back to the article day's own daily close, i.e. a
--    price from after the headline. It now uses the last close strictly
--    before the article unless the article came after that day's close.
--
-- History: an earlier draft of this file was applied to production on
-- 2026-09-20 as "055" from a checkout that predated 055-060. It replaced
-- 058's resolver and two views with un-hardened bodies for about an hour.
-- This migration is the corrected form and is safe to run over either state.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- 1. Finance context ------------------------------------------------------------

-- Market vocabulary, matched against fold_tr() text (lowercase ASCII,
-- single spaces). Deliberately excludes everyday words like fiyat, milyon,
-- dolar, satis: a phone review has those too.
create or replace function public.finance_context_regex()
returns text
language sql
immutable
set search_path = ''
as $$
  select '\m(hisse|hisseleri|hissesi|hisselerinde|borsa|borsada|bist|kap|paylari|yatirimci|yatirimcilar|sirket|sirketi|sirketin|holding|bilanco|temettu|halka arz|sermaye|ciro|ihale|spk|genel kurul|bedelsiz|bedelli|geri alim|net kar|net zarar|finansal sonuc|ceyrek)\M'::text;
$$;

revoke all on function public.finance_context_regex() from public, anon, authenticated;
grant execute on function public.finance_context_regex() to service_role;

-- Resolver: 058's body, plus the category column and the fin_ctx gate on
-- auto aliases.
create or replace function public.resolve_article_tickers_for(p_ids uuid[])
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_n integer;
begin
  with recent as (
    select a.id,
           a.title || ' ' || coalesce(a.description, '') as raw,
           ' ' || public.fold_tr(a.title || ' ' || coalesce(a.description, '')) || ' ' as folded,
           a.published_at,
           a.source_id,
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
    select r.id as article_id, al.ticker, 'alias:' || al.alias as matched_on,
           r.published_at, r.source_id
    from ctx r
    join public.bist_aliases al
      on al.enabled
     and (al.origin = 'manual' or r.fin_ctx)
     and pg_catalog.strpos(r.folded, ' ' || al.alias || ' ') > 0
  ),
  code_hits as (
    select distinct r.id as article_id, c.ticker, 'code' as matched_on,
           r.published_at, r.source_id
    from ctx r
    cross join lateral pg_catalog.regexp_matches(r.raw, '\m([A-Z]{4,6})\M', 'g') m
    join (
      select pg_catalog.unnest(tickers) as ticker from public.bist_companies where shares_traded
    ) c on c.ticker = m[1]
  ),
  hits as (
    select * from alias_hits
    union all
    select * from code_hits
  )
  insert into public.article_tickers (article_id, ticker, matched_on, published_at, source_id)
  select distinct on (article_id, ticker) article_id, ticker, matched_on, published_at, source_id
  from hits
  on conflict do nothing;

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

update public.bist_aliases set enabled = false
where origin = 'auto' and enabled and alias in ('elite', 'isiklar');

-- Drop stored auto-alias matches that fail the rule or use a disabled
-- alias. Keyed on (alias, ticker), never alias text alone (058 section 6).
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

-- 3. Signals ---------------------------------------------------------------------

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
    (select count(*) from public.article_tickers t
       where t.ticker = c.ticker
         and t.published_at >= d.published_at - interval '24 hours'
         and t.published_at <  d.published_at)::numeric as pre24,
    (select count(*) from public.article_tickers t
       where t.ticker = c.ticker
         and t.published_at >= d.published_at - interval '15 days'
         and t.published_at <  d.published_at - interval '24 hours')::numeric / 14 as base_daily
  from public.kap_disclosures d
  cross join lateral unnest(d.stock_codes) as c(ticker)
  join public.bist_companies bc on bc.tickers @> array[c.ticker] and bc.shares_traded
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
join public.bist_companies bc on bc.tickers @> array[c.ticker] and bc.shares_traded
where d.published_at >= now() - interval '48 hours'
  and d.disclosure_class in ('FR', 'ODA')
  and coalesce(d.subject, '') not ilike '%devre kesici%'
  and not exists (
    select 1 from public.article_tickers t
    where t.ticker = c.ticker
      and t.published_at >= d.published_at
      and t.published_at <= d.published_at + interval '5 days'
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

-- 4. ML disclosure events ---------------------------------------------------------
-- first_coverage_lag_min is post-filing only; pre24_articles is appended
-- (CREATE OR REPLACE VIEW can only grow columns at the end).

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
  (select count(*) from public.article_tickers t
     where t.ticker = c.ticker
       and t.published_at >= d.published_at - interval '24 hours'
       and t.published_at <  d.published_at) as pre24_articles
from public.kap_disclosures d
cross join lateral unnest(d.stock_codes) as c(ticker)
join public.bist_companies bc on bc.tickers @> array[c.ticker] and bc.shares_traded
left join lateral public.bar_returns(c.ticker, d.published_at) r on true;

-- Re-issue after the recreations above (058's note: a bare CREATE OR
-- REPLACE VIEW wipes the option). Grants are untouched by the replace.
alter view public.finance_signals      set (security_invoker = on);
alter view public.ml_disclosure_events set (security_invoker = on);

insert into supabase_migrations.schema_migrations (version, name)
  values ('062', '062_coverage_semantics_and_context')
  on conflict do nothing;

commit;
