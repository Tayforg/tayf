-- 051_finance_bars_and_speed.sql
--
-- Three things for Tayf Ekonomi:
--
-- 1. Latency. Ticker matching now fires from an AFTER INSERT trigger on
--    articles (like cluster enqueue in 025) instead of waiting for the
--    10-minute sweep; the sweep stays as an hourly safety net. kap-drain
--    moves from every 10 to every 2 minutes.
--
-- 2. Price history. bist_bars_daily (every traded share, 1y back on first
--    fill) and bist_bars_5m (any ticker that appeared in the news in the
--    last 7 days, 5-minute bars during the session). Filled by the
--    quotes-ingest Edge Function on pg_cron. This is what "move since the
--    headline", relative volume and the ML labels are computed from.
--
-- 3. Datasets. bar_returns() gives forward returns around an event day;
--    ml_news_events and ml_disclosure_events join it to the news and KAP
--    tables so the backtest/ML side gets labelled rows straight from SQL.
--    bist_quote_stats gives the pages relative volume; price_at() and
--    feed_reference_prices() give the price at headline time.
--
-- Session facts baked in: BIST regular session 10:00-18:00 Istanbul
-- (closing auction to ~18:10), Istanbul is fixed UTC+3, cron is UTC.

begin;

-- 1. Insert-triggered ticker resolution ---------------------------------------

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
           ' ' || public.fold_tr(a.title || ' ' || coalesce(a.description, '')) || ' ' as folded
    from public.articles a
    where a.id = any (p_ids)
  ),
  alias_hits as (
    select r.id as article_id, al.ticker, 'alias:' || al.alias as matched_on
    from recent r
    join public.bist_aliases al on strpos(r.folded, ' ' || al.alias || ' ') > 0
  ),
  code_hits as (
    select distinct r.id as article_id, c.ticker, 'code' as matched_on
    from recent r
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

-- The windowed sweep from 049 now delegates to the array form.
create or replace function public.resolve_article_tickers(p_since interval default interval '30 minutes')
returns integer
language sql
as $$
  select public.resolve_article_tickers_for(
    coalesce((select array_agg(id) from public.articles where created_at >= now() - p_since), '{}')
  );
$$;

create or replace function public.resolve_article_tickers_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.resolve_article_tickers_for(array[NEW.id]);
  return NEW;
end;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'postgres') then
    alter function public.resolve_article_tickers_trigger() owner to postgres;
  end if;
end
$$;

drop trigger if exists articles_resolve_tickers on public.articles;
create trigger articles_resolve_tickers
  after insert on public.articles
  for each row
  execute function public.resolve_article_tickers_trigger();

-- 2. Bars ---------------------------------------------------------------------

create table if not exists public.bist_bars_daily (
  ticker text not null,
  day    date not null,
  open   numeric(14,4),
  high   numeric(14,4),
  low    numeric(14,4),
  close  numeric(14,4) not null,
  volume bigint,
  primary key (ticker, day)
);
comment on table public.bist_bars_daily is 'Daily OHLCV per BIST ticker from Yahoo (<CODE>.IS). Filled by quotes-ingest {"mode":"daily"}.';

create table if not exists public.bist_bars_5m (
  ticker text not null,
  ts     timestamptz not null,
  open   numeric(14,4),
  high   numeric(14,4),
  low    numeric(14,4),
  close  numeric(14,4) not null,
  volume bigint,
  primary key (ticker, ts)
);
comment on table public.bist_bars_5m is '5-minute OHLCV for tickers seen in the news in the last 7 days. ts is the bar start, floored to 5 min. Filled by quotes-ingest {"mode":"intraday"}.';

create index if not exists bist_bars_5m_ts_idx on public.bist_bars_5m (ts desc);

alter table public.bist_bars_daily enable row level security;
alter table public.bist_bars_5m    enable row level security;
drop policy if exists "public read bist_bars_daily" on public.bist_bars_daily;
drop policy if exists "public read bist_bars_5m"    on public.bist_bars_5m;
create policy "public read bist_bars_daily" on public.bist_bars_daily for select using (true);
create policy "public read bist_bars_5m"    on public.bist_bars_5m    for select using (true);

-- Which tickers the daily job should refresh next: traded shares ordered by
-- how stale their last bar is (never-fetched first).
create or replace function public.bist_daily_targets(p_limit int default 80)
returns table (ticker text, last_day date)
language sql
stable
as $$
  select t.ticker, b.last_day
  from (select distinct unnest(tickers) as ticker from public.bist_companies where shares_traded) t
  left join (select ticker, max(day) as last_day from public.bist_bars_daily group by 1) b using (ticker)
  order by b.last_day nulls first, t.ticker
  limit p_limit;
$$;

-- Which tickers the intraday job should track: anything the news named in
-- the last 7 days.
create or replace function public.bist_intraday_targets()
returns table (ticker text)
language sql
stable
as $$
  select distinct t.ticker
  from public.article_tickers t
  where t.created_at >= now() - interval '7 days'
  order by 1;
$$;

-- 3. Reference prices for the pages --------------------------------------------

-- Last known price at or before p_ts: a 5-minute bar if we have one, else
-- the last daily close before that day.
create or replace function public.price_at(p_ticker text, p_ts timestamptz)
returns numeric
language sql
stable
as $$
  select coalesce(
    (select close from public.bist_bars_5m
      where ticker = p_ticker and ts <= p_ts
      order by ts desc limit 1),
    (select close from public.bist_bars_daily
      where ticker = p_ticker and day <= (p_ts at time zone 'Europe/Istanbul')::date
      order by day desc limit 1)
  );
$$;

create or replace function public.feed_reference_prices(p_article_ids uuid[])
returns table (article_id uuid, ticker text, ref_price numeric)
language sql
stable
as $$
  select t.article_id, t.ticker, public.price_at(t.ticker, a.published_at)
  from public.article_tickers t
  join public.articles a on a.id = t.article_id
  where t.article_id = any (p_article_ids);
$$;

-- Per ticker: latest daily bar, previous close, 20-day average volume.
create or replace view public.bist_quote_stats as
with ranked as (
  select
    ticker, day, close, volume,
    lag(close) over w as prev_close,
    avg(volume) over (w rows between 20 preceding and 1 preceding) as avg_volume_20,
    row_number() over (partition by ticker order by day desc) as rn
  from public.bist_bars_daily
  window w as (partition by ticker order by day)
)
select ticker, day as last_day, close as last_close, prev_close, volume as last_volume, avg_volume_20,
       case when avg_volume_20 > 0 then round(volume / avg_volume_20, 2) end as rvol
from ranked
where rn = 1;

-- Admin health gains the bar freshness columns (appended; view columns can
-- only grow at the end under create or replace).
create or replace view public.finance_health as
select
  (select max(published_at) from public.kap_disclosures)                                   as last_disclosure_at,
  (select count(*) from public.kap_disclosures where published_at >= now() - interval '24 hours') as disclosures_24h,
  (select count(*) from public.article_tickers where created_at >= now() - interval '24 hours')   as article_tickers_24h,
  (select count(distinct ticker) from public.article_tickers where created_at >= now() - interval '24 hours') as tickers_24h,
  (select max(created_at) from public.article_tickers)                                     as last_resolved_at,
  (select count(*) from public.bist_companies where shares_traded)                          as companies_traded,
  (select count(*) from public.bist_aliases)                                                as aliases,
  (select count(distinct ticker) from public.bist_bars_daily)                               as daily_bar_tickers,
  (select max(day) from public.bist_bars_daily)                                             as last_daily_bar_day,
  (select count(distinct ticker) from public.bist_bars_5m where ts >= now() - interval '1 day') as intraday_tickers_24h,
  (select max(ts) from public.bist_bars_5m)                                                 as last_5m_bar_at;

-- 4. Forward returns for ML ------------------------------------------------------

-- Event day = Istanbul date of p_ts; anything after the 18:10 close counts
-- as the next session. Entry is the close of the first bar on/after that
-- day. r0 is that day's own reaction, r1/r5/r20 are forward from entry,
-- pre5 is the run-up over the five sessions before the event (leakage).
create or replace function public.bar_returns(p_ticker text, p_ts timestamptz)
returns table (entry_day date, entry_close numeric, r0 numeric, r1 numeric, r5 numeric, r20 numeric, pre5 numeric)
language sql
stable
as $$
  with ist as (
    select (p_ts at time zone 'Europe/Istanbul') as lt
  ),
  ev as (
    select (case when lt::time >= time '18:10' then lt::date + 1 else lt::date end) as d from ist
  ),
  bars as (
    select day, close, row_number() over (order by day) as n
    from public.bist_bars_daily where ticker = p_ticker
  ),
  entry as (
    select b.day, b.close, b.n from bars b, ev where b.day >= ev.d order by b.day limit 1
  )
  select
    e.day,
    e.close,
    round(e.close / nullif((select close from bars where n = e.n - 1), 0) - 1, 6),
    round((select close from bars where n = e.n + 1)  / nullif(e.close, 0) - 1, 6),
    round((select close from bars where n = e.n + 5)  / nullif(e.close, 0) - 1, 6),
    round((select close from bars where n = e.n + 20) / nullif(e.close, 0) - 1, 6),
    round((select close from bars where n = e.n - 1) / nullif((select close from bars where n = e.n - 6), 0) - 1, 6)
  from entry e;
$$;

-- One row per (article, ticker) with attention context, nearest KAP
-- disclosure and forward returns. Nulls where bars are not (yet) there.
create or replace view public.ml_news_events as
select
  t.article_id,
  t.ticker,
  a.source_id,
  a.published_at,
  t.matched_on,
  (select count(*) from public.article_tickers x where x.article_id = t.article_id) as tickers_in_article,
  (select coalesce(sum(d.articles), 0) from public.ticker_attention_daily d
     where d.ticker = t.ticker
       and d.day >= (a.published_at at time zone 'Europe/Istanbul')::date - 7
       and d.day <  (a.published_at at time zone 'Europe/Istanbul')::date) as attention_prev7,
  (select coalesce(sum(d.articles), 0) from public.ticker_attention_daily d
     where d.ticker = t.ticker
       and d.day = (a.published_at at time zone 'Europe/Istanbul')::date) as attention_day,
  nd.disclosure_index as nearest_disclosure_index,
  nd.disclosure_class as nearest_disclosure_class,
  nd.lag_minutes as nearest_disclosure_lag_min,
  r.entry_day, r.entry_close, r.r0, r.r1, r.r5, r.r20, r.pre5
from public.article_tickers t
join public.articles a on a.id = t.article_id
left join lateral (
  select d.disclosure_index, d.disclosure_class,
         round(extract(epoch from (a.published_at - d.published_at)) / 60)::int as lag_minutes
  from public.kap_disclosures d
  where t.ticker = any (d.stock_codes)
    and d.published_at between a.published_at - interval '2 days' and a.published_at + interval '2 days'
  order by abs(extract(epoch from (a.published_at - d.published_at))) limit 1
) nd on true
left join lateral public.bar_returns(t.ticker, a.published_at) r on true;

comment on view public.ml_news_events is
  'Labelled news events: one row per article x ticker with attention context, nearest KAP disclosure and forward returns from bist_bars_daily.';

-- One row per (disclosure, ticker) for PEAD-style work.
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
     where cv.disclosure_index = d.disclosure_index and cv.ticker = c.ticker) as first_coverage_lag_min,
  (select coalesce(sum(x.articles), 0) from public.ticker_attention_daily x
     where x.ticker = c.ticker
       and x.day >= (d.published_at at time zone 'Europe/Istanbul')::date - 7
       and x.day <  (d.published_at at time zone 'Europe/Istanbul')::date) as attention_prev7,
  r.entry_day, r.entry_close, r.r0, r.r1, r.r5, r.r20, r.pre5
from public.kap_disclosures d
cross join lateral unnest(d.stock_codes) as c(ticker)
join public.bist_companies bc on c.ticker = any (bc.tickers) and bc.shares_traded
left join lateral public.bar_returns(c.ticker, d.published_at) r on true;

comment on view public.ml_disclosure_events is
  'Labelled KAP events: one row per disclosure x traded ticker with press coverage, prior attention and forward returns.';

commit;

-- 5. pg_cron ----------------------------------------------------------------------
-- All times UTC. Istanbul = UTC+3, no DST.
--   kap-drain        every 2 min
--   resolve-tickers  hourly safety sweep over the last 2 hours
--   quotes-daily     every 3 min 15:30-16:57 UTC weekdays (18:30-19:57 IST)
--   quotes-intraday  every 5 min 07:00-15:15 UTC weekdays (10:00-18:15 IST)

do $$
declare
  v_job text;
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_net')
  then
    raise notice 'pg_cron/pg_net missing — skipping 051 schedules.';
    return;
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'service_role_key')
     or not exists (select 1 from vault.decrypted_secrets where name = 'functions_base_url')
  then
    raise notice 'Vault secrets missing — skipping 051 schedules. See 038.';
    return;
  end if;

  foreach v_job in array array['kap-drain', 'resolve-tickers', 'quotes-daily', 'quotes-intraday']
  loop
    if exists (select 1 from cron.job where jobname = v_job) then
      perform cron.unschedule(v_job);
    end if;
  end loop;

  perform cron.schedule('kap-drain', '*/2 * * * *', $sql$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_base_url') || '/kap-ingest',
      headers := jsonb_build_object('Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
      body := '{}'::jsonb, timeout_milliseconds := 60000)
  $sql$);

  perform cron.schedule('resolve-tickers', '7 * * * *',
    $sql$ select public.resolve_article_tickers(interval '2 hours'); $sql$);

  perform cron.schedule('quotes-daily', '*/3 15-16 * * 1-5', $sql$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_base_url') || '/quotes-ingest',
      headers := jsonb_build_object('Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
      body := '{"mode":"daily"}'::jsonb, timeout_milliseconds := 60000)
  $sql$);

  perform cron.schedule('quotes-intraday', '*/5 7-15 * * 1-5', $sql$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_base_url') || '/quotes-ingest',
      headers := jsonb_build_object('Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
      body := '{"mode":"intraday"}'::jsonb, timeout_milliseconds := 60000)
  $sql$);
end
$$;
