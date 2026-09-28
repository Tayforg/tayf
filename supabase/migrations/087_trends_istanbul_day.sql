-- 087_trends_istanbul_day.sql
--
-- /trends currently buckets by UTC calendar day
-- (trends_daily_bias_counts, migration 023: date_trunc('day', a.created_at
-- at time zone 'utc')), over ALL source kinds. Both of those contradict
-- the documented contract in src/lib/sources/kind.ts ("whether a source's
-- kind counts toward bias_distribution / blindspot / trends") and the
-- editorial expectation that a reader in Türkiye sees "today" flip at
-- midnight Istanbul time, not 03:00 (UTC+3 in winter, UTC+3 year-round —
-- Türkiye does not observe DST since 2016).
--
-- This migration is purely additive: it adds a covering index and a NEW
-- view (trends_daily_zone_counts_ist). The old view
-- (trends_daily_bias_counts, migration 023) and its trends-query.ts
-- consumer are UNTOUCHED — a separate wave owns that file
-- (src/lib/clusters/trends-query.ts is under src/lib/clusters/*-query.ts,
-- which is reserved) — so /trends switches to a brand-new module
-- (src/lib/trends/daily-zones.ts) reading this new view instead.
--
-- Bucketing key: `least(a.published_at, a.created_at) at time zone
-- 'Europe/Istanbul'`, cast to date. `least()` clamps any future-dated
-- published_at to created_at (the same story-timeline clamping rule used
-- elsewhere), so a mis-stamped future publish date can never park an
-- article on a day that hasn't happened yet. Since
-- `least(published_at, created_at) <= created_at` always holds, the
-- `a.created_at >= now() - interval '32 days'` bound below loses no row
-- that would otherwise fall inside the 30-day display window: the extra
-- 2 days of slack absorb the worst-case skew between the two timestamps
-- and between UTC and Europe/Istanbul (+03:00) without narrowing the
-- window trends-daily-zones.ts actually displays.
--
-- Voting kinds only: `s.kind in ('outlet', 'wire')`, matching
-- VOTING_SOURCE_KINDS (supabase/functions/_shared/cluster/source-kind.ts)
-- — aggregator/niche sources never counted toward bias_distribution or
-- blindspot detection, and now never counted toward /trends either.
--
-- security_invoker = true (not the SECURITY DEFINER pattern some other
-- views/functions here use) is safe here because migration 017 already
-- grants public SELECT on both `articles` and `sources`; running the view
-- as invoker avoids tripping the Supabase advisor's
-- security-definer-view lint that migration 023's plain view triggers.
--
-- The zone CASE is copied byte-for-byte in shape from migration 023 so
-- tests/migrations/zone-parity.test.ts's parseZoneCase() reads it and can
-- assert it against BIAS_TO_ZONE the same way it does for 023.
--
-- `create index` runs inside this transaction, so it is NON-CONCURRENT
-- (same precedent as migration 070) — acceptable for an additive index on
-- a table this size; a CONCURRENT build cannot run inside a transaction
-- block at all.

begin;

create index if not exists idx_articles_created_published_source
  on public.articles (created_at) include (published_at, source_id);

comment on index public.idx_articles_created_published_source is
  'Covering index for trends_daily_zone_counts_ist (087): created_at range '
  '+ published_at/source_id, index-only. created_at is the range key '
  '(where a.created_at >= now() - interval ''32 days''); published_at and '
  'source_id ride along in INCLUDE so the view''s SELECT list is answered '
  'entirely from the index without a heap fetch.';

create or replace view public.trends_daily_zone_counts_ist
  with (security_invoker = true) as
select
  (least(a.published_at, a.created_at) at time zone 'Europe/Istanbul')::date as day,
  case s.bias
    when 'pro_government'        then 'iktidar'
    when 'gov_leaning'           then 'iktidar'
    when 'state_media'           then 'iktidar'
    when 'islamist_conservative' then 'iktidar'
    when 'nationalist'           then 'iktidar'
    when 'center'                then 'bagimsiz'
    when 'international'         then 'bagimsiz'
    when 'pro_kurdish'           then 'bagimsiz'
    when 'opposition_leaning'    then 'muhalefet'
    when 'opposition'            then 'muhalefet'
  end as zone,
  count(*)::int as count
from public.articles a
join public.sources s on s.id = a.source_id
where a.created_at >= now() - interval '32 days'
  and s.kind in ('outlet', 'wire')
group by 1, 2;

comment on view public.trends_daily_zone_counts_ist is
  'Daily article counts per Medya DNA zone, bucketed by the Europe/Istanbul '
  'calendar day of least(published_at, created_at) -- clamps a future-dated '
  'published_at to created_at''s day. Voting kinds only (outlet, wire), '
  'matching VOTING_SOURCE_KINDS. Powers /trends via '
  'src/lib/trends/daily-zones.ts. 32-day created_at bound: '
  'least(published_at, created_at) <= created_at always, so the bound '
  'loses nothing inside the 30-day display window. Keep the zone CASE in '
  'sync with BIAS_TO_ZONE in src/lib/bias/config.ts (asserted by '
  'tests/migrations/zone-parity.test.ts). The old '
  'trends_daily_bias_counts view (migration 023, UTC day, all kinds) is '
  'untouched -- it has its own consumer (src/lib/clusters/trends-query.ts) '
  'owned by a separate change.';

-- PostgREST needs explicit grants to expose a view. RLS on the underlying
-- `articles` and `sources` tables still governs what rows are visible --
-- this grant just allows the roles to read the aggregated projection.
grant select on public.trends_daily_zone_counts_ist to anon, authenticated, service_role;

insert into supabase_migrations.schema_migrations (version, name)
  values ('087', '087_trends_istanbul_day')
  on conflict do nothing;

commit;
