-- 112_trends_entity_rollup.sql
--
-- Per-entity daily rollup behind "Yükselen Konular" (rising topics) on /trends:
-- how many outlet/wire ARTICLES mention each person, institution, country or
-- economic term of a curated vocabulary on each Istanbul calendar day.
--
-- WHY. The only trends rollup is per (day, Medya DNA zone):
-- public.trends_daily_zone_counts_ist_rollup (092), refreshed by the pg_cron job
-- 'trends-rollup-refresh' ('25 * * * *' since 109; 6 h average 34 s, maximum
-- 106 s). No per-entity daily data exists, and articles.entities was measured
-- EMPTY in production (098 header, 2026-09-29), so it cannot be rolled up. This
-- migration therefore tokenizes article TITLES against a curated vocabulary,
-- ONE Istanbul day per statement, and folds that work into the existing cron.
-- No articles scan happens on the request path: /trends reads at most ~560
-- rollup rows (9 days x 62 entities) through src/lib/trends/rising-query.ts.
--
-- STEP 0 FINDINGS (production, 2026-10-23 19:30 UTC, read-only SELECT and
-- EXPLAIN ANALYZE; no secrets recorded)
--   * Volume: 7,253 outlet/wire articles were created in the last 24 hours.
--     articles.title, published_at and created_at are all NOT NULL;
--     legal_notice_articles (107) holds 857 rows.
--   * Per-day SELECT, the exact per-day statement below minus the insert, for
--     yesterday (2026-10-22): 2.09 s on the first run, 0.95 s on the second
--     (wall clock through the management API, round trip included). Gate: < 5 s.
--   * The first draft bounded the day only by `created_at >= start of day`
--     (092's predicate). For a late-ingest repair day that lower bound alone
--     makes the planner heap-fetch every article created since then (the title
--     is not in the covering index): 2026-10-13, the deepest day this function
--     can touch, took 10.07 s cold and 1.31 s warm. day_articles therefore
--     narrows the day with two DISJOINT index range scans before 092's exact
--     predicate runs as a recheck:
--       arm 1  published_at in [day, next day) and created_at >= day
--              (idx_articles_published_at, ~11.7k rows for 2026-10-13)
--       arm 2  created_at in [day, next day) and published_at >= next day
--              (BitmapAnd of idx_articles_created_source and
--              idx_articles_published_at, 0 heap rows: published late, created
--              the same day)
--     The arms cover every row whose least(published_at, created_at) falls on
--     the day, exactly once. Output verified IDENTICAL (cmp) to the lower-bound
--     form for 2026-10-13 and 2026-10-22. Timings of the shipped form:
--     2026-10-13 EXPLAIN ANALYZE 889 ms, wall 1.32 s; 2026-10-22 wall 0.99 s;
--     2026-10-02 (a day 21 days old that no earlier query had touched) 3.58 s.
--   * Sanity sample for 2026-10-22 (articles per entity): abd 170, erdogan 157,
--     iran 154, trump 130, meclis 125, tcmb 106, faiz 101, ... ; every one of
--     the 62 vocabulary entities is returned (zero included).
--
-- WHAT THIS DOES (additive; one transaction)
--   1. public.trends_daily_entity_counts_ist_rollup (day, entity, count): one
--      row per Istanbul day and vocabulary entity. Service-role only: RLS on,
--      no policies, every Supabase default grant revoked (anon, authenticated,
--      public; PG17 MAINTAIN too), SELECT granted to service_role. The app
--      reads it through the service-role createReaderClient(), so there is no
--      public read.
--   2. public.trends_daily_entity_counts_ist_refresh(p_days): SECURITY DEFINER,
--      search_path = '', service_role-only. Recomputes the last p_days
--      (default 2, capped at 10) Istanbul days PLUS every bucket day (within 10
--      days) that received a row ingested in the last 2 days, as 092 does for
--      late-ingested rows. One day is one statement: lower(translate(title,
--      folds)) is split on [^a-z0-9]+ into unigrams and adjacent bigrams, which
--      are joined to a VALUES map of the vocabulary; an article counts ONCE per
--      entity (select distinct id, entity), so the numbers are articles, not
--      mentions. Only s.kind in ('outlet', 'wire') count, and notices in
--      legal_notice_articles (107) are excluded. Every day gets one row for
--      EVERY vocabulary entity (zero included), so "a row exists for the day"
--      means "the day was refreshed" (src/lib/trends/rising.ts relies on it).
--      An advisory lock makes an overlapping call a no-op, and the whole loop is
--      wrapped so a failure (including a statement timeout) raises a WARNING and
--      returns -1 instead of aborting the transaction it shares with the zone
--      refresh in the cron command below.
--   3. Folds the function into the existing cron command with cron.alter_job:
--      'select public.trends_daily_zone_counts_ist_refresh(); select
--      public.trends_daily_entity_counts_ist_refresh();'. The schedule is left
--      untouched. Skips with a notice if pg_cron or the job is missing (local
--      and CI databases).
--   4. Backfill: refresh(9), today plus 8 days, enough for the 7-day baseline of
--      yesterday's fallback ranking. Roughly 1-3.5 s a day, so about 20-40 s.
--      Because refresh() swallows errors (see 2), the backfill runs in a DO block
--      that RAISES when refresh() returns -1 or fewer than 9 days were written:
--      the migration then rolls back whole (no ledger row) instead of
--      committing an empty rollup. Re-run it after fixing the cause.
--
-- VOCABULARY PARITY. The emap VALUES below are the flattened RISING_ENTITIES of
-- src/lib/trends/rising-entities.ts, and the two translate() literals are its
-- RISING_FOLD_FROM / RISING_FOLD_TO. tests/migrations/112-trends-entity-rollup.test.ts
-- fails the build if either side drifts. Changing the vocabulary later means a
-- new migration that replaces the function (create or replace) and re-runs the
-- backfill.
--
-- DEPLOY ORDER
--   1. Apply this migration (supabase db push, or the one-at-a-time psql
--      pattern in docs/migration-guide.md). It is additive: the old app build
--      does not read the table.
--   2. Then ship the Vercel deploy. Before step 1 the new section simply shows
--      "Yükselen konular şu anda hesaplanamıyor." (the reader treats a missing
--      or empty table as a failure, cached for the short 'minutes' lifetime).
--   3. Verify with the queries in docs/migration-guide.md (9 days x 62 rows =
--      558 rows right after the backfill; the cron command holds both calls).
--
-- ROLLBACK (nothing else depends on this; the section degrades to its
-- "hesaplanamıyor" copy)
--   select cron.alter_job((select jobid from cron.job where jobname =
--     'trends-rollup-refresh'), command := 'select
--     public.trends_daily_zone_counts_ist_refresh();');
--   drop function public.trends_daily_entity_counts_ist_refresh(integer);
--   drop table public.trends_daily_entity_counts_ist_rollup;
--   delete from supabase_migrations.schema_migrations where version = '112';
--
-- NO DELETE / PRUNE. This migration never deletes: the refresh only upserts, and
-- days that leave the rolling window keep their last counts. The table grows by
-- about 62 rows a day (about 23k a year); rows older than the 9-day read window
-- are never read and can be pruned by an operator later if it ever matters.

begin;

-- 1. Rollup table -------------------------------------------------------------

create table if not exists public.trends_daily_entity_counts_ist_rollup (
  day        date not null,
  entity     text not null check (entity ~ '^[a-z0-9-]+$'),
  count      integer not null default 0 check (count >= 0),
  updated_at timestamptz not null default now(),
  primary key (day, entity)
);

comment on table public.trends_daily_entity_counts_ist_rollup is
  'Per-entity daily rollup (migration 112): one row per (Europe/Istanbul day, '
  'vocabulary entity key) with the number of outlet/wire articles whose title '
  'mentions the entity. Kept current by trends_daily_entity_counts_ist_refresh() '
  'inside the hourly trends-rollup-refresh cron. Powers "Yükselen Konular" on '
  '/trends via src/lib/trends/rising-query.ts. Service-role only.';

create index if not exists trends_entity_rollup_ist_day_idx
  on public.trends_daily_entity_counts_ist_rollup (day desc);

alter table public.trends_daily_entity_counts_ist_rollup enable row level security;

-- Supabase default privileges hand new tables to anon/authenticated (incl.
-- write grants, cf. 091/095): strip them. No public read is intended; only
-- service_role (the app's reader client) may select, and the owner-run
-- SECURITY DEFINER refresh below is the only writer.
revoke all on public.trends_daily_entity_counts_ist_rollup from anon, authenticated, public;

-- PG17 added the MAINTAIN privilege; it does not exist before PG17 (revoking it
-- would be a syntax error), so guard.
do $maint$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on public.trends_daily_entity_counts_ist_rollup from anon, authenticated';
  end if;
end
$maint$;

grant select on public.trends_daily_entity_counts_ist_rollup to service_role;

-- 2. Refresh function -----------------------------------------------------------

-- plan_cache_mode: the per-day statement is planned with the day's bounds as
-- plpgsql parameters. A generic plan would guess default range selectivities
-- and could pick a full scan of articles, so every execution gets a custom plan.
create or replace function public.trends_daily_entity_counts_ist_refresh(
  p_days integer default 2
) returns integer
language plpgsql security definer set search_path = '' set plan_cache_mode = force_custom_plan
as $fn$
declare
  v_days    integer := least(greatest(coalesce(p_days, 2), 1), 10);
  v_today   date;
  v_day     date;
  v_from    timestamptz;
  v_to      timestamptz;
  v_touched integer := 0;
  v_rows    integer;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtext('trends_daily_entity_counts_ist_refresh')::bigint
  ) then
    return 0;
  end if;

  v_today := (pg_catalog.now() at time zone 'Europe/Istanbul')::date;

  begin
    -- Days to recompute: the rolling p_days window UNION every bucket day
    -- (within 10 days) that received a row ingested in the last 2 days, which
    -- repairs old days hit by late-ingested rows (same rule as 092).
    for v_day in
      select d from (
        select (v_today - g)::date as d from pg_catalog.generate_series(0, v_days - 1) g
        union
        select (least(a.published_at, a.created_at) at time zone 'Europe/Istanbul')::date
          from public.articles a
         where a.created_at >= pg_catalog.now() - interval '2 days'
      ) x
      where d <= v_today and d >= v_today - 10
      order by d desc
    loop
      -- Explicit Europe/Istanbul-zoned bounds of v_day (a bare v_day::timestamptz
      -- would use the session TimeZone, UTC on production).
      v_from := (v_day::timestamp at time zone 'Europe/Istanbul');
      v_to   := ((v_day + 1)::timestamp at time zone 'Europe/Istanbul');

      with emap(token, entity) as (values   -- RISING_ENTITIES, flattened; parity-tested
          ('akp','akp'),('ak parti','akp'),('chp','chp'),('mhp','mhp'),
          ('dem','dem'),('hdp','hdp'),('iyi parti','iyi-parti'),('yrp','yrp'),
          ('yeniden refah','yrp'),('deva','deva'),('meclis','meclis'),('tbmm','meclis'),
          ('aym','aym'),('anayasa mahkemesi','aym'),('yargitay','yargitay'),('danistay','danistay'),
          ('ysk','ysk'),('tcmb','tcmb'),('merkez bankasi','tcmb'),('tuik','tuik'),
          ('bddk','bddk'),('spk','spk'),('msb','msb'),('tsk','tsk'),
          ('afad','afad'),('diyanet','diyanet'),('disisleri','disisleri'),('meb','meb'),
          ('rtuk','rtuk'),('mit','mit'),('erdogan','erdogan'),('ozgur ozel','ozgur-ozel'),
          ('imamoglu','imamoglu'),('bahceli','bahceli'),('kilicdaroglu','kilicdaroglu'),('mansur yavas','mansur-yavas'),
          ('mehmet simsek','simsek'),('hakan fidan','fidan'),('yerlikaya','yerlikaya'),('babacan','babacan'),
          ('davutoglu','davutoglu'),('aksener','aksener'),('demirtas','demirtas'),('ocalan','ocalan'),
          ('trump','trump'),('putin','putin'),('netanyahu','netanyahu'),('zelenski','zelenski'),
          ('zelenskiy','zelenski'),('abd','abd'),('rusya','rusya'),('ukrayna','ukrayna'),
          ('suriye','suriye'),('iran','iran'),('israil','israil'),('gazze','gazze'),
          ('hamas','hamas'),('pkk','pkk'),('feto','feto'),('nato','nato'),
          ('yunanistan','yunanistan'),('almanya','almanya'),('cin','cin'),('enflasyon','enflasyon'),
          ('faiz','faiz'),('dolar','dolar'),('borsa','borsa'),('bist','borsa'),
          ('asgari ucret','asgari-ucret')),
      day_articles as (
        select a.id,
               pg_catalog.lower(pg_catalog.translate(a.title, 'İIıŞşĞğÜüÖöÇçÂâÎîÛû', 'iiissgguuooccaaiiuu')) as t
          from (
            -- Two DISJOINT index range scans that together hold every row whose
            -- least(published_at, created_at) is on v_day (see Step 0 above).
            select x.id, x.title, x.source_id, x.published_at, x.created_at
              from public.articles x
             where x.published_at >= v_from and x.published_at < v_to
               and x.created_at >= v_from
            union all
            select y.id, y.title, y.source_id, y.published_at, y.created_at
              from public.articles y
             where y.created_at >= v_from and y.created_at < v_to
               and y.published_at >= v_to
          ) a
          join public.sources s on s.id = a.source_id
         -- Exact bucketing recheck, as 092/087: Istanbul day of
         -- least(published_at, created_at), with a created_at lower bound and
         -- deliberately NO upper created_at bound.
         where (least(a.published_at, a.created_at) at time zone 'Europe/Istanbul')::date = v_day
           and a.created_at >= (v_day::timestamp at time zone 'Europe/Istanbul')
           and s.kind in ('outlet', 'wire')
           and a.title is not null
           and not exists (select 1 from public.legal_notice_articles l where l.article_id = a.id)
      ),
      toks as (
        select d.id, x.tok, x.ord
          from day_articles d
         cross join lateral pg_catalog.regexp_split_to_table(d.t, '[^a-z0-9]+')
               with ordinality as x(tok, ord)
      ),
      grams as (
        select t.id, t.tok as gram from toks t where t.tok <> ''
        union all
        select p.id, p.tok || ' ' || q.tok
          from toks p
          join toks q on q.id = p.id and q.ord = p.ord + 1
         where p.tok <> '' and q.tok <> ''
      ),
      hits as (
        select distinct g.id, m.entity
          from grams g
          join emap m on m.token = g.gram
      ),
      agg as (
        select h.entity, count(*)::int as cnt
          from hits h
         group by h.entity
      )
      insert into public.trends_daily_entity_counts_ist_rollup (day, entity, count, updated_at)
      select v_day, e.entity, coalesce(g.cnt, 0), pg_catalog.now()
        from (select distinct entity from emap) e
        left join agg g on g.entity = e.entity
      on conflict (day, entity) do update
        set count = excluded.count, updated_at = excluded.updated_at
       where public.trends_daily_entity_counts_ist_rollup.count is distinct from excluded.count;

      get diagnostics v_rows = row_count;
      v_touched := v_touched + v_rows;
    end loop;
  exception when others or query_canceled then
    raise warning '112 entity refresh failed: %', sqlerrm;
    return -1;
  end;

  return v_touched;
end
$fn$;

comment on function public.trends_daily_entity_counts_ist_refresh(integer) is
  'Recomputes public.trends_daily_entity_counts_ist_rollup for the last p_days '
  'Istanbul days (default 2, capped at 10) plus days hit by late-ingested rows, '
  'one day per statement. Counts outlet/wire articles whose title mentions each '
  'vocabulary entity, once per article, and writes a row for every entity. '
  'Returns the number of (day, entity) rows changed, 0 when another call holds '
  'the lock, or -1 after a WARNING when the refresh failed (it never raises, so '
  'it cannot abort the cron transaction it shares with the zone refresh). '
  'service_role only; run hourly inside trends-rollup-refresh.';

revoke all on function public.trends_daily_entity_counts_ist_refresh(integer) from public, anon, authenticated;
grant execute on function public.trends_daily_entity_counts_ist_refresh(integer) to service_role;

-- 3. Fold into the existing hourly cron (schedule untouched) ---------------------

do $fold$
declare
  v_job bigint;
begin
  if to_regclass('cron.job') is null then
    raise notice '112: pg_cron not installed, skipping';
    return;
  end if;

  select jobid into v_job from cron.job where jobname = 'trends-rollup-refresh';
  if v_job is null then
    raise notice '112: trends-rollup-refresh not scheduled, skipping';
    return;
  end if;

  perform cron.alter_job(
    v_job,
    command := 'select public.trends_daily_zone_counts_ist_refresh(); select public.trends_daily_entity_counts_ist_refresh();'
  );
end
$fold$;

-- 4. Backfill: today plus 8 days, so yesterday's 7-day baseline is complete. ------

-- refresh() never raises: it catches every failure (a statement timeout too),
-- warns and returns -1, and it returns 0 without working when an overlapping
-- refresh holds the advisory lock (the hourly cron). A bare select would ignore
-- both and commit an empty or partial rollup together with the '112' ledger row,
-- and the hourly run only recomputes the last 2 days, so the older days would
-- never fill. This block fails the migration instead (the transaction rolls
-- back, no ledger row, safe to re-run). now() is the transaction start time in
-- both the function and here, so v_today is the same Istanbul day it used.
do $backfill$
declare
  v_today  date := (pg_catalog.now() at time zone 'Europe/Istanbul')::date;
  v_result integer;
  v_days   integer;
begin
  v_result := public.trends_daily_entity_counts_ist_refresh(9);
  if v_result < 0 then
    raise exception '112: entity backfill failed (see the preceding WARNING); rolling the migration back, re-run it';
  end if;

  select count(distinct r.day) into v_days
    from public.trends_daily_entity_counts_ist_rollup r
   where r.day between v_today - 8 and v_today;
  if v_days < 9 then
    raise exception '112: entity backfill wrote % of 9 days (an overlapping refresh holds the lock?); rolling the migration back, re-run it', v_days;
  end if;
end
$backfill$;

insert into supabase_migrations.schema_migrations (version, name)
  values ('112', '112_trends_entity_rollup')
  on conflict do nothing;

commit;
