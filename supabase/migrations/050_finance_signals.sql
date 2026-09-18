-- 050_finance_signals.sql
--
-- Read surface for /admin/ekonomi: ingestion health and the rule-based v0
-- of the prediction system. No ML here; `finance_signals.score` is the
-- slot a learned scorer replaces later. Each rule is one of the edge
-- candidates agreed on 2026-09-12:
--
--   attention_spike    a ticker's article count today is >= 3 and at least
--                      3x its prior-7-day daily average (attention fade
--                      candidate: fade, don't chase).
--   silent_disclosure  a shares_traded company filed an FR (financial
--                      report) or ODA (material event) in the last 48 h and
--                      no outlet has mentioned the ticker since (PEAD
--                      candidate: material, no press).
--   press_ahead        >= 2 articles named the ticker more than an hour
--                      BEFORE a disclosure in the last 7 days (leakage
--                      filter: the drift is probably spent).
--
-- All views read tables that migration 049 made public-read, so no RLS
-- work. Views are cheap at the 48 h / 7 d windows they scan.

begin;

-- finance_health is now owned entirely by 051_finance_bars_and_speed.sql,
-- which replaces this view with an 11-column version (bar freshness
-- columns appended to these original 7). It is deliberately NOT
-- (re)defined here (DB-10 replay safety): `create or replace view` cannot
-- drop columns, so if this file were ever replayed after 051 -- a partial
-- re-apply, a manual hotfix -- redefining the narrower 7-column shape here
-- would error instead of silently regressing. 051 owns the view for the
-- lifetime of the schema; nothing below in this file depends on it.

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
  )

union all

select
  'press_ahead',
  cv.ticker,
  count(*)::numeric,
  jsonb_build_object(
    'disclosure_index', cv.disclosure_index,
    'articles_before', count(*),
    'median_lag_min', percentile_cont(0.5) within group (order by cv.lag_minutes)
  ),
  min(cv.disclosed_at)
from public.disclosure_coverage cv
where cv.disclosed_at >= now() - interval '7 days'
  and cv.lag_minutes < -60
group by cv.disclosure_index, cv.ticker
having count(*) >= 2;

comment on view public.finance_signals is
  'Rule-based v0 signals (attention_spike, silent_disclosure, press_ahead). score is the slot a learned model fills later.';

commit;
