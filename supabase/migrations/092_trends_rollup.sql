-- 092_trends_rollup.sql
--
-- Pre-aggregated replacement for the on-demand `trends_daily_zone_counts_ist`
-- view (migration 087) that /trends reads live.
--
-- Why: production is a Micro compute (256 MB shared_buffers, ~3 GB DB) whose
-- working set does not fit in memory. The view's group-by over `articles`
-- joined to `sources` measures ~7.8 s cold vs ~0.8 s warm; PostgREST's
-- statement_timeout for the service_role connection `next build`'s
-- prerender uses is 8 s. A cold hit (the common case right after a compute
-- restart, or the first request in a while) throws
-- "canceling statement due to statement timeout" inside
-- src/lib/trends/daily-zones.ts's `"use cache"` fetcher — see
-- src/lib/cache-resilience.ts's file header for how that fixed build
-- failure was made non-fatal. This migration removes the slow query from
-- the read path entirely: a small pg_cron job keeps a rollup TABLE current,
-- and /trends becomes a two-column-key point lookup (day, zone) against an
-- indexed table instead of a live aggregate over the full `articles` table.
--
-- What this migration does (additive only — the view from 087 is untouched
-- for compatibility; nothing currently reads it once 093 (a follow-up, not
-- part of this change) repoints callers, but no such repoint is silently
-- assumed here):
--
--   1. public.trends_daily_zone_counts_ist_rollup — one row per
--      (day, zone), RLS enabled, public-read (mirrors 049/051's "public
--      read" pattern: this is fully public data, article counts by zone,
--      already served in full by the live view for anon/authenticated
--      today per migration 091's audit — see its comment inventorying
--      trends_daily_zone_counts_ist as a public.SELECT-granted view).
--
--   2. public.trends_daily_zone_counts_ist_refresh(p_days): SECURITY
--      DEFINER, search_path = '', service_role-only. Recomputes the last
--      `p_days` Istanbul calendar days (capped at 40, matching 087's own
--      32-day + slack bound — Tayf never displays more than WINDOW_DAYS =
--      30 days, src/lib/trends/daily-zones.ts) ONE DAY AT A TIME in a
--      loop, upserting each day's zone counts. Batching per day (rather
--      than one 32-day aggregate, which is exactly the query this
--      migration exists to get off the hot path) bounds every individual
--      statement to a single day's worth of work, so no single call can
--      approach a statement timeout even on a cold cache — the same
--      safety margin a hand-rolled backfill loop would give, without a
--      separate script. An advisory lock (mirrors 071) makes a second
--      concurrent invocation (e.g. a slow cron tick overlapping the next
--      one) a no-op instead of doing redundant work.
--
--   3. pg_cron job 'trends-rollup-refresh', hourly at :00, calling the
--      function with its default `p_days = 2` — the rolling window that
--      can still change (today + yesterday's Istanbul day). Older days are
--      NOT immutable: least(published_at, created_at) can be many days
--      older than created_at (late-ingested rows; prod has lags of up to
--      ~1350 days), so a row ingested now can belong to an old bucket day.
--      The function therefore ALSO recomputes every bucket day (within the
--      40-day cap) that received a row with created_at in the last 2 days,
--      so late rows are never dropped permanently.
--
--   4. A one-off backfill: `select
--      public.trends_daily_zone_counts_ist_refresh(32);` — the full
--      32-day window the old view covered, so the rollup is immediately
--      usable without waiting for 32 hourly ticks. Same per-day batching
--      as above; expected well under 100 s total (32 single-day
--      aggregates, each bounded by the existing 087 covering index,
--      against a 7.8 s COLD full-32-day baseline for comparison).
--
-- Zone CASE: verbatim copy (as a VALUES map instead of a CASE expression)
-- of 087's/023's BIAS_TO_ZONE mapping — parity-tested by
-- tests/migrations/092-trends-rollup.test.ts the same way
-- tests/migrations/zone-parity.test.ts pins 023 and 087.
--
-- Voting kinds only: `s.kind in ('outlet', 'wire')`, matching
-- VOTING_SOURCE_KINDS — identical filter to 087's view.
--
-- DEPLOY ORDER: apply this migration, let the one-off backfill populate
-- the table, THEN ship the Vercel deploy that points
-- src/lib/trends/daily-zones.ts at the new table (kept as a follow-up
-- code change in the same PR; the table exists and is populated before
-- any code depends on it, so there is no window where the table is
-- selected from empty). The view from 087 is left in place for
-- compatibility (nothing drops it here) and keeps working exactly as
-- before regardless of when/whether the code switch lands.

begin;

-- 1. Rollup table -------------------------------------------------------------

create table if not exists public.trends_daily_zone_counts_ist_rollup (
  day        date not null,
  zone       text not null check (zone in ('iktidar', 'bagimsiz', 'muhalefet')),
  count      integer not null default 0 check (count >= 0),
  updated_at timestamptz not null default now(),
  primary key (day, zone)
);

comment on table public.trends_daily_zone_counts_ist_rollup is
  'Pre-aggregated replacement for the live trends_daily_zone_counts_ist '
  'view (087): one row per (Europe/Istanbul day, Medya DNA zone), kept '
  'current by trends_daily_zone_counts_ist_refresh() via hourly pg_cron '
  '(trends-rollup-refresh). Powers /trends via '
  'src/lib/trends/daily-zones.ts as a cheap indexed point lookup instead '
  'of an on-demand group-by over articles/sources (migration 092).';

create index if not exists trends_rollup_ist_day_idx
  on public.trends_daily_zone_counts_ist_rollup (day desc);

alter table public.trends_daily_zone_counts_ist_rollup enable row level security;

drop policy if exists "public read trends_daily_zone_counts_ist_rollup"
  on public.trends_daily_zone_counts_ist_rollup;

create policy "public read trends_daily_zone_counts_ist_rollup"
  on public.trends_daily_zone_counts_ist_rollup for select using (true);

-- The live view (087) is already anon/authenticated-readable (explicit
-- `grant select ... to anon, authenticated, service_role` there, and
-- confirmed still granted post-091's audit) — this table replaces the
-- same public data, so it gets the same explicit grant rather than
-- relying only on Supabase's default per-table privilege.
grant select on public.trends_daily_zone_counts_ist_rollup to anon, authenticated, service_role;

-- 091 revoked TRUNCATE/TRIGGER/REFERENCES unconditionally from every
-- existing public table (never governed by RLS) and INSERT/UPDATE/DELETE
-- from anon/authenticated wherever no policy grants them, because
-- Supabase's platform-level `alter default privileges` attaches those
-- write grants to every newly created table by default. This table is
-- brand new (created above, in this same migration) and has only a
-- SELECT policy, so it must get the identical explicit revoke 091's own
-- header calls out as required follow-up work for every future
-- `create table` migration — otherwise the default grants silently
-- reintroduce exactly the class of privilege 091 exists to close.
revoke insert, update, delete, truncate, trigger, references
  on public.trends_daily_zone_counts_ist_rollup from anon, authenticated;

-- PG17 added the MAINTAIN privilege (VACUUM/ANALYZE/REINDEX/LOCK TABLE),
-- which Supabase's default ACL also grants to anon/authenticated. It does
-- not exist before PG17 (revoking it would be a syntax error), so guard.
do $maint$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on public.trends_daily_zone_counts_ist_rollup from anon, authenticated';
  end if;
end
$maint$;

-- 2. Refresh function -----------------------------------------------------------

create or replace function public.trends_daily_zone_counts_ist_refresh(
  p_days integer default 2
) returns integer
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_days    integer := least(greatest(coalesce(p_days, 2), 1), 40);
  v_today   date;
  v_day     date;
  v_touched integer := 0;
  v_rows    integer;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtext('trends_daily_zone_counts_ist_refresh')::bigint
  ) then
    return 0;
  end if;

  v_today := (pg_catalog.now() at time zone 'Europe/Istanbul')::date;

  -- Days to recompute: the rolling p_days window UNION every bucket day
  -- (within the 40-day cap) that received a row ingested in the last 2
  -- days. The second set repairs old days hit by late-ingested rows
  -- (least(published_at, created_at) far older than created_at).
  for v_day in
    select d from (
      select (v_today - g)::date as d from pg_catalog.generate_series(0, v_days - 1) g
      union
      select (least(a.published_at, a.created_at) at time zone 'Europe/Istanbul')::date
        from public.articles a
       where a.created_at >= pg_catalog.now() - interval '2 days'
    ) x
    where d <= v_today and d >= v_today - 40
    order by d desc
  loop
    with zmap(bias_key, zone) as (values   -- verbatim BIAS_TO_ZONE (023/087); parity-tested
        ('pro_government','iktidar'),('gov_leaning','iktidar'),('state_media','iktidar'),
        ('islamist_conservative','iktidar'),('nationalist','iktidar'),
        ('center','bagimsiz'),('international','bagimsiz'),('pro_kurdish','bagimsiz'),
        ('opposition_leaning','muhalefet'),('opposition','muhalefet')),
    agg as (
      select z.zone, count(*)::int as cnt
        from public.articles a
        join public.sources s on s.id = a.source_id
        join zmap z on z.bias_key = s.bias
       where (least(a.published_at, a.created_at) at time zone 'Europe/Istanbul')::date = v_day
         -- Lower bound only, via the covering index as 087
         -- (idx_articles_created_published_source on created_at, include
         -- published_at/source_id). There is deliberately NO upper
         -- created_at bound: least(published_at, created_at) <= created_at,
         -- so a row bucketed to v_day can have been ingested arbitrarily
         -- LATER (prod: lags up to ~1350 days); an upper bound silently
         -- drops those rows. The lower bound is safe: bucket day v_day
         -- implies created_at >= start of v_day.
         -- Explicit Europe/Istanbul-zoned cast, matching the bucketing
         -- key's `at time zone 'Europe/Istanbul'` above: a bare
         -- `v_day::timestamptz` uses the SESSION's TimeZone (UTC on
         -- prod), anchoring the bound 3 hours late.
         and a.created_at >= (v_day::timestamp at time zone 'Europe/Istanbul')
         and s.kind in ('outlet', 'wire')
       group by 1
    )
    insert into public.trends_daily_zone_counts_ist_rollup (day, zone, count, updated_at)
    select v_day, zone, cnt, pg_catalog.now() from agg
    on conflict (day, zone) do update
      set count = excluded.count, updated_at = excluded.updated_at
     where public.trends_daily_zone_counts_ist_rollup.count is distinct from excluded.count;

    get diagnostics v_rows = row_count;
    v_touched := v_touched + v_rows;
  end loop;

  return v_touched;
end
$fn$;

comment on function public.trends_daily_zone_counts_ist_refresh(integer) is
  'Recomputes public.trends_daily_zone_counts_ist_rollup for the last '
  'p_days Istanbul calendar days (capped at 40), one day at a time so no '
  'single statement scans more than one day''s worth of articles. Returns '
  'the number of (day, zone) rows whose count changed. service_role only; '
  'scheduled hourly as trends-rollup-refresh with the default p_days = 2.';

revoke all on function public.trends_daily_zone_counts_ist_refresh(integer) from public, anon, authenticated;
grant execute on function public.trends_daily_zone_counts_ist_refresh(integer) to service_role;

-- 3. Hourly schedule --------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron not installed — skipping trends-rollup-refresh schedule (092)';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'trends-rollup-refresh') then
    perform cron.unschedule('trends-rollup-refresh');
  end if;
  perform cron.schedule('trends-rollup-refresh', '0 * * * *',
    $sql$ select public.trends_daily_zone_counts_ist_refresh(); $sql$);
end $$;

-- 4. One-off backfill: the full 32-day window the live view (087) covers,
--    so the rollup is immediately usable without waiting for 32 hourly
--    ticks. Batched one day at a time inside the function itself (see its
--    comment) — expected well under 100 s total.
select public.trends_daily_zone_counts_ist_refresh(32);

insert into supabase_migrations.schema_migrations (version, name)
  values ('092', '092_trends_rollup')
  on conflict do nothing;

commit;
