-- 058_finance_hardening.sql
--
-- Hardening pass over the Ekonomi feature (049-054), which shipped without
-- a single GRANT or REVOKE and with the article resolver wired into the
-- core ingest transaction. Four classes of fix:
--
--   1. Access. 049-054 issued no grants, so all seven new views are
--      SELECT-able with the browser-shipped anon key and run with the
--      owner's rights (no security_invoker), and all eleven new functions
--      keep the default PUBLIC EXECUTE. 039:66-67 and 048 set the
--      precedent for operator surfaces; 032:201-206 sets the wording for
--      function revokes (name the roles -- revoking from public alone
--      leaves the role-direct grants and the RPC stays live via PostgREST).
--   2. Blast radius. resolve_article_tickers_trigger() has no exception
--      block, so a finance-side fault aborts the article INSERT. The
--      hourly sweep at 051:369 already exists as the backfill net; let it
--      do its job instead.
--   3. Cost. article_tickers carries no timestamp, so every /ekonomi
--      window query probes the 1.25 GB articles table -- the top-tickers
--      query is at 7.85 s against an 8 s statement_timeout. One
--      denormalized column plus an index fixes that, the feed query and
--      the lag histogram. bist_companies.tickers also has no GIN index, so
--      finance_signals / ml_disclosure_events seq-scan it per disclosure.
--   4. Data loss. prune_generic_aliases deletes article_tickers by alias
--      TEXT with no ticker predicate, so disabling one auto alias in an
--      N-ticker company group (kardemir, alarko, ihlas, nurol) silently
--      deletes every other ticker's history sharing that alias -- including
--      a manual, still-enabled alias's rows. This is the one change in
--      this migration that stops irreversible loss, not just a grant.
--
-- 055 is reserved for the registry pack, 056/057 for headline/game.

begin;

-- DBF-02: ACCESS EXCLUSIVE on article_tickers (from the NOT NULL below)
-- must never queue article ingest behind an unbounded wait; a timeout
-- rolls back cleanly and the orchestrator retries.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- 1. View grants ---------------------------------------------------------------
-- Operator + research surfaces are service_role only, mirroring 048.
revoke all on public.finance_signals      from anon, authenticated;
revoke all on public.finance_health       from anon, authenticated;
revoke all on public.ml_news_events       from anon, authenticated;
revoke all on public.ml_disclosure_events from anon, authenticated;
grant select on public.finance_signals, public.finance_health,
                public.ml_news_events, public.ml_disclosure_events
  to service_role;

-- The three the public pages read stay readable, but every view stops
-- executing with the owner's rights so base-table RLS is enforced.
-- (Verified none of the three anon-readable views calls a function, so
-- invoker rights need no extra EXECUTE grants.)
-- NOTE: the actual `alter view ... set (security_invoker = on)` statements
-- are issued further down, immediately before COMMIT -- four of these
-- seven views are recreated below (ticker_attention_daily, finance_signals,
-- ml_disclosure_events, disclosure_coverage); the ALTER VIEW ...
-- security_invoker statements are deferred to the end so a recreation
-- cannot wipe the option.

-- 2. Function EXECUTE ----------------------------------------------------------
-- The zero-arg form must go before this section's end recreates it with
-- p_limit, or the existing quotes-ingest call becomes ambiguous.
drop function if exists public.bist_intraday_targets();

-- The actual REVOKE/GRANT for all thirteen functions lives at the end of
-- this migration (section "2, continued"), after econ_feed, the new
-- bist_intraday_targets(int) and prune_bist_bars_5m are all defined --
-- REVOKE requires the function to already exist.

-- 3. Trigger: never abort an article INSERT ------------------------------------
create or replace function public.resolve_article_tickers_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
set lock_timeout = '200ms'
as $$
begin
  begin
    -- lock_not_available (55P03) IS catchable by `when others`, so this
    -- converts "ingest blocked behind alias-prune" into a skipped match.
    -- Deliberately NOT statement_timeout: plpgsql's `when others` does not
    -- catch QUERY_CANCELED (57014), so it would give false assurance.
    -- lock_timeout is set via this function's proconfig (above) rather than
    -- `set local` in the body: a `set local` here demotes the GUC to a
    -- nested level that outlives the trigger's plpgsql subtransaction and
    -- leaks 200ms lock_timeout into the calling (article INSERT) transaction
    -- for its remainder. A proconfig entry is correctly saved/restored by
    -- the function call itself.
    perform public.resolve_article_tickers_for(array[NEW.id]);
  exception when others then
    raise warning '[resolve_article_tickers] % on article %', sqlerrm, NEW.id;
  end;
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

-- 4. Denormalize the article timestamp onto article_tickers --------------------
-- The join to articles was the reason every window query scanned 1.25 GB.
alter table public.article_tickers add column if not exists published_at timestamptz;
alter table public.article_tickers add column if not exists source_id uuid;

update public.article_tickers t
set published_at = a.published_at, source_id = a.source_id
from public.articles a
where a.id = t.article_id and t.published_at is null;

-- Safe only because the resolver below now always supplies it; the NOT NULL
-- is what keeps the rewritten views from silently dropping rows.
--
-- DBF-01: a row inserted by the pre-058 resolver while this migration is
-- mid-run (concurrent with the ALTER below) does not supply
-- published_at/source_id, so a bare NOT NULL would reject it. This BEFORE
-- INSERT trigger backfills both columns from the parent article whenever
-- the caller omits them, so the constraint below never loses a
-- concurrently inserted row.
create or replace function public.article_tickers_fill_ts()
returns trigger language plpgsql security definer set search_path = '' as $fx$
begin
  if NEW.published_at is null or NEW.source_id is null then
    select a.published_at, a.source_id into NEW.published_at, NEW.source_id
    from public.articles a where a.id = NEW.article_id;
  end if;
  return NEW;
end $fx$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'postgres') then
    alter function public.article_tickers_fill_ts() owner to postgres;
  end if;
end
$$;

drop trigger if exists article_tickers_fill_ts_trg on public.article_tickers;
create trigger article_tickers_fill_ts_trg before insert on public.article_tickers
  for each row execute function public.article_tickers_fill_ts();

alter table public.article_tickers alter column published_at set not null;

create index if not exists article_tickers_published_ticker_idx
  on public.article_tickers (published_at desc, ticker);

-- Resolver: the LIVE body from 052:29 (sports-desk skip, 3-letter-code
-- rejection via the {4,6} bound), extended to carry published_at/source_id
-- from `recent` through to the insert.
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
           a.source_id
    from public.articles a
    where a.id = any (p_ids)
      and coalesce(a.category, '') <> 'spor'
  ),
  alias_hits as (
    select r.id as article_id, al.ticker, 'alias:' || al.alias as matched_on,
           r.published_at, r.source_id
    from recent r
    join public.bist_aliases al on al.enabled and pg_catalog.strpos(r.folded, ' ' || al.alias || ' ') > 0
  ),
  code_hits as (
    select distinct r.id as article_id, c.ticker, 'code' as matched_on,
           r.published_at, r.source_id
    from recent r
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

create or replace view public.ticker_attention_daily as
select
  t.ticker,
  (t.published_at at time zone 'Europe/Istanbul')::date as day,
  count(*)                      as articles,
  count(distinct t.source_id)   as sources,
  min(t.published_at)           as first_at
from public.article_tickers t
group by 1, 2;

-- 5. Feed RPC (replaces the articles -> article_tickers!inner embed) -----------
create or replace function public.econ_feed(p_limit int default 80)
returns table (
  id uuid, title text, url text, published_at timestamptz, category text,
  source_name text, source_slug text, tickers text[]
)
language sql
stable
as $$
  with picked as (
    select t.article_id, max(t.published_at) as published_at
    from public.article_tickers t
    group by 1
    order by 2 desc
    limit p_limit
  )
  select a.id, a.title, a.url, a.published_at, a.category, s.name, s.slug,
         (select array_agg(distinct t2.ticker order by t2.ticker)
            from public.article_tickers t2 where t2.article_id = a.id)
  from picked p
  join public.articles a on a.id = p.article_id
  left join public.sources s on s.id = a.source_id
  order by a.published_at desc;
$$;

-- 6. Alias prune: count articles, respect manual aliases, delete by ticker -----
create or replace function public.prune_generic_aliases(p_days int default 14, p_max_hits int default 100)
returns integer
language plpgsql
as $$
declare
  v_n integer;
begin
  with hot as (
    select substr(matched_on, 7) as alias, count(distinct article_id) as n
    from public.article_tickers
    where matched_on like 'alias:%' and created_at >= now() - make_interval(days => p_days)
    group by 1
    having count(distinct article_id) > p_max_hits
  ),
  disabled as (
    update public.bist_aliases al
    set enabled = false
    from hot
    where al.alias = hot.alias and al.origin = 'auto' and al.enabled
      and not exists (
        select 1 from public.bist_aliases m
        where m.alias = al.alias and m.origin = 'manual' and m.enabled
      )
    returning al.alias, al.ticker
  )
  delete from public.article_tickers t
  using disabled d
  where t.matched_on = 'alias:' || d.alias
    and t.ticker = d.ticker;

  select count(*) into v_n from public.bist_aliases where origin = 'auto' and not enabled;
  return v_n;
end;
$$;

-- 7. Intraday targets: bounded, and the whole set rotates ----------------------
-- Carries each ticker's own last_ts (already computed in the `b` subquery)
-- out to the caller so quotes-ingest can build its per-ticker watermark from
-- this RPC directly, instead of re-deriving it from a flat, unordered,
-- LIMIT-capped read of bist_bars_5m that silently truncates to a handful of
-- tickers (DB-03).
create or replace function public.bist_intraday_targets(p_limit int default 120)
returns table (ticker text, last_ts timestamptz)
language sql
stable
as $$
  select t.ticker, b.last_ts
  from (
    select distinct ticker from public.article_tickers
    where created_at >= now() - interval '7 days'
  ) t
  left join (select ticker, max(ts) as last_ts from public.bist_bars_5m group by 1) b
    using (ticker)
  order by b.last_ts nulls first, t.ticker
  limit p_limit;
$$;

-- 8. GIN index + the join form that can use it (054:11-13's own lesson) --------
create index if not exists bist_companies_tickers_idx
  on public.bist_companies using gin (tickers);

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
join public.bist_companies bc on bc.tickers @> array[c.ticker] and bc.shares_traded
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
join public.bist_companies bc on bc.tickers @> array[c.ticker] and bc.shares_traded
left join lateral public.bar_returns(c.ticker, d.published_at) r on true;

-- disclosure_coverage: keep 054's indexable stock_codes containment, and add
-- the (now indexed) t.published_at window alongside the original
-- a.published_at window. The two predicates are logically equal, so
-- semantics are unchanged -- but not the plan: this is fast for
-- disclosure-driven windows (a lookup by d.published_at can now use
-- article_tickers_published_ticker_idx), while in the ticker-driven
-- direction it defeats Memoize on the correlated a.published_at bound.
-- Watch finance_signals in pg_stat_statements.
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
join public.article_tickers t
  on d.stock_codes @> array[t.ticker]
  and t.published_at between d.published_at - interval '2 days'
                          and d.published_at + interval '5 days'
join public.articles a on a.id = t.article_id
where a.published_at between d.published_at - interval '2 days'
                          and d.published_at + interval '5 days';

-- 9. bist_bars_5m retention (46 MB / 10 days, nothing reads past one session) --
create or replace function public.prune_bist_bars_5m(keep_days int default 90)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total integer := 0;
  v_batch_count integer;
begin
  if keep_days is null or keep_days < 0 then
    raise exception 'keep_days must be a non-negative integer, got %', keep_days;
  end if;

  loop
    with candidates as (
      select ticker, ts
      from public.bist_bars_5m
      where ts < pg_catalog.now() - pg_catalog.make_interval(days => keep_days)
      order by ts
      limit 5000
      for update skip locked
    )
    delete from public.bist_bars_5m b
    using candidates c
    where b.ticker = c.ticker and b.ts = c.ts;

    get diagnostics v_batch_count = row_count;
    v_total := v_total + v_batch_count;
    exit when v_batch_count = 0 or v_batch_count < 5000;
  end loop;

  return v_total;
end;
$$;

comment on function public.prune_bist_bars_5m(int) is
  'Deletes bist_bars_5m rows older than keep_days, LIMIT-batched at 5000 rows '
  'per pass like prune_singleton_clusters (037). Nothing reads a 5-minute bar '
  'past the session it was drawn in. Returns the total rows deleted. '
  'Scheduled nightly as its own bars-5m-prune cron job (below) with '
  'keep_days=14 (DB-07): the growth this job fixes was 229,028 rows / 46 MB '
  'in 10 days, so the default of 90 days here is far beyond any read path '
  'and would let the table reach ~414 MB before the job ever deletes a row. '
  '14 days is the window the read paths actually justify -- disclosure-time '
  'price lookups older than that degrade gracefully to the daily close via '
  'price_at()''s bist_bars_daily fallback (051:178-186) rather than null. '
  'prune-nightly''s existing command body (037/038) is left untouched.';

-- 2, continued. Function EXECUTE ------------------------------------------------
-- All thirteen functions now exist. 032:201-206's exact wording: name every
-- role, since revoking from public alone leaves the role-direct grants and
-- the RPC stays reachable via PostgREST.
revoke execute on function
    public.fold_tr(text),
    public.resolve_article_tickers(interval),
    public.resolve_article_tickers_for(uuid[]),
    public.resolve_article_tickers_trigger(),
    public.article_tickers_fill_ts(),
    public.prune_generic_aliases(int, int),
    public.prune_bist_bars_5m(int),
    public.bist_daily_targets(int),
    public.bist_intraday_targets(int),
    public.price_at(text, timestamptz),
    public.feed_reference_prices(uuid[]),
    public.bar_returns(text, timestamptz),
    public.ticker_articles(text, int),
    public.econ_feed(int)
  from anon, authenticated, public;

grant execute on function
    public.fold_tr(text),
    public.resolve_article_tickers(interval),
    public.resolve_article_tickers_for(uuid[]),
    public.resolve_article_tickers_trigger(),
    public.article_tickers_fill_ts(),
    public.prune_generic_aliases(int, int),
    public.prune_bist_bars_5m(int),
    public.bist_daily_targets(int),
    public.bist_intraday_targets(int),
    public.price_at(text, timestamptz),
    public.feed_reference_prices(uuid[]),
    public.bar_returns(text, timestamptz),
    public.ticker_articles(text, int),
    public.econ_feed(int)
  to service_role;

-- 11. Indexes no query can use, on the two busiest finance tables --------------
drop index if exists public.kap_disclosures_subject_idx;
drop index if exists public.article_tickers_ticker_idx;

-- 1, continued. View security_invoker ------------------------------------------
-- Issued here, after every `create or replace view` in this migration: a bare
-- CREATE OR REPLACE VIEW resets reloptions to NULL, so setting this option
-- any earlier (each view above is recreated later in this same file) would
-- be silently undone before COMMIT. All seven views must show
-- {security_invoker=on} in pg_class.reloptions once this migration lands --
-- verify with:
--   select relname, reloptions from pg_class
--   where relnamespace = 'public'::regnamespace
--     and relname = any(array['ticker_attention_daily','disclosure_coverage',
--       'bist_quote_stats','finance_signals','finance_health',
--       'ml_news_events','ml_disclosure_events']);
alter view public.ticker_attention_daily set (security_invoker = on);
alter view public.disclosure_coverage    set (security_invoker = on);
alter view public.bist_quote_stats       set (security_invoker = on);
alter view public.finance_signals        set (security_invoker = on);
alter view public.finance_health         set (security_invoker = on);
alter view public.ml_news_events         set (security_invoker = on);
alter view public.ml_disclosure_events   set (security_invoker = on);

-- SEC-F-08: record this migration in the ledger from inside the file
-- itself, same precedent as 055.
insert into supabase_migrations.schema_migrations (version, name)
  values ('058', '058_finance_hardening')
  on conflict do nothing;

commit;

-- 9, continued. bars-5m-prune cron job ------------------------------------------
-- Its own job so prune-nightly's existing command body (which already makes
-- the 037 retention calls) is never reconstructed blind.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron missing — skipping bars-5m-prune schedule (058_finance_hardening.sql).';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'bars-5m-prune') then
    perform cron.unschedule('bars-5m-prune');
  end if;
  -- DB-07: 14 days, not the function's 90-day default -- see the comment
  -- on prune_bist_bars_5m(int) above for why 90 is a no-op for ~80 nights
  -- against this table's actual growth rate.
  perform cron.schedule(
    'bars-5m-prune',
    '25 4 * * *',
    $sql$ select public.prune_bist_bars_5m(14); $sql$
  );
end
$$;

-- 10. quotes-daily starts after the closing auction settles (~18:10 IST) -------
-- Supersedes the header comment at 051:334 and the '*/3 15-16 * * 1-5'
-- expression at 051:372 (051 itself is not edited): the old window's first
-- two passes (15:30, 15:33 UTC) fired before the close and could read a
-- pre-auction daily bar.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_net')
  then
    raise notice 'pg_cron/pg_net missing — skipping quotes-daily reschedule (058_finance_hardening.sql).';
    return;
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'service_role_key')
     or not exists (select 1 from vault.decrypted_secrets where name = 'functions_base_url')
  then
    raise notice 'Vault secrets missing — skipping quotes-daily reschedule (058). See 038.';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'quotes-daily') then
    perform cron.unschedule('quotes-daily');
  end if;

  perform cron.schedule('quotes-daily', '12-59/3 15-16 * * 1-5', $sql$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_base_url') || '/quotes-ingest',
      headers := jsonb_build_object('Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
      body := '{"mode":"daily"}'::jsonb, timeout_milliseconds := 60000)
  $sql$);
end
$$;

-- 12. kap-corrections-daily: replay KAP amendments once a day (DB-08) -----------
-- DB-08 switched kap-drain's default poll body ({}, every 2 min, 051:361)
-- to ON CONFLICT DO NOTHING so the ~500-row two-day window stops being
-- rewritten every cycle. But kap_disclosures explicitly models amendment
-- (modify_status, is_late, subject, summary, raw -- 049:75) and the default
-- poll window IS 48 hours, so a correction KAP issues inside that window
-- would otherwise never be re-applied. Rather than splitting by age (which
-- would restore DO UPDATE across the whole poll window and undo DB-08), one
-- low-frequency job posts an explicit `{"from": <yesterday>}` so the
-- DO UPDATE (backfill) path in ingestRange replays corrections once a day,
-- scheduled off-peak (well outside kap-drain's continuous 2-minute cadence)
-- rather than reconstructing kap-drain's own body. Own job, same do-block
-- shape as bars-5m-prune, so kap-drain's existing schedule (049/051) is
-- never touched.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_net')
  then
    raise notice 'pg_cron/pg_net missing — skipping kap-corrections-daily schedule (058_finance_hardening.sql).';
    return;
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'service_role_key')
     or not exists (select 1 from vault.decrypted_secrets where name = 'functions_base_url')
  then
    raise notice 'Vault secrets missing — skipping kap-corrections-daily schedule (058). See 038.';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'kap-corrections-daily') then
    perform cron.unschedule('kap-corrections-daily');
  end if;

  -- 03:15 UTC (~06:15 Europe/Istanbul), well before the trading day and
  -- clear of kap-drain's continuous */2 cadence.
  perform cron.schedule('kap-corrections-daily', '15 3 * * *', $sql$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_base_url') || '/kap-ingest',
      headers := jsonb_build_object('Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
      body := jsonb_build_object('from',
        to_char(((now() at time zone 'Europe/Istanbul')::date - 1), 'YYYY-MM-DD')),
      timeout_milliseconds := 60000)
  $sql$);
end
$$;
