-- 106_source_karne_resilient.sql
--
-- Makes the "Kapsama karnesi" refresh (096) survive a cold, small-memory
-- database: two covering indexes, a per-source refresh function, a bounded
-- batch function and a cron job that runs the batch every 15 minutes. The
-- app side (src/lib/sources/karne.ts) additionally tells the reader when the
-- stored row is stale (older than 48 h) instead of presenting old numbers as
-- current.
--
-- STEP 0 FINDINGS (production, 2026-10-22, read-only SELECT / EXPLAIN without
-- ANALYZE; no secrets recorded)
--   * cron job 'source-karne-refresh' (096): schedule '41 0 * * *', command
--     `set statement_timeout = '15min'; select public.source_karne_refresh();`,
--     active. cron.job_run_details: last SUCCESS 2026-10-12 00:41 (2 m 47 s
--     for the whole pass); FAILED on 9 consecutive nights, 2026-10-13 through
--     2026-10-21, each run cancelled after ~15 min (00:41:00 -> 00:56:01..04)
--     with "canceling statement due to statement timeout", CONTEXT = the
--     `with zmap(...` statement of 096. The 15 min budget covers the WHOLE
--     source_karne_refresh() call (one transaction, 118 sources), so a
--     per-source exception block alone cannot fix it.
--   * sources: 118 active / 144 total. Compute: Supabase Micro (256 MB
--     shared_buffers) against a multi-GB database, so reads are cold.
--   * pg_stat_user_tables: articles n_live_tup 1,281,355, heap 983 MB (about
--     98.7% of pages all-visible, relallvisible 124,196 / relpages 125,883);
--     clusters 243,585 rows, 398 MB heap; cluster_articles 332,051 rows, 19
--     MB heap (about 86.5% all-visible, 2,130 / 2,461; no dedicated vacuum
--     job, last autovacuum 2026-10-07); source_karne_30d 118 rows, 32 kB.
--     289,047 articles fall in the 30-day window across all sources.
--   * pg_stat_user_indexes / pg_indexes (articles): idx_articles_source_
--     published (source_id, published_at DESC) 60 MB; idx_articles_published_
--     at (published_at DESC) 39 MB; articles_pkey (id) 50 MB. cluster_
--     articles: cluster_articles_pkey (cluster_id, article_id) 20 MB;
--     idx_cluster_articles_article_id (article_id) 13 MB. No index carries
--     both the join key and the selected column of either table: the `mine`
--     CTE needs (source_id, published_at) -> id on articles and article_id ->
--     cluster_id on cluster_articles.
--   * EXPLAIN (no ANALYZE) of 096's per-source SELECT (INSERT removed),
--     literals substituted:
--       - haberler-com (aggregator): Parallel Hash Join of cluster_articles
--         (Parallel Seq Scan) with a Parallel Index Scan on idx_articles_
--         published_at (Index Cond published_at >= now() - 30 days, Filter
--         source_id = <haberler-com>), estimated cost 46,870 for that scan
--         alone, total 109,922. The planner abandons the per-source index and
--         walks the whole 30-day window of ALL sources (289k rows) with one
--         articles heap fetch each, only to evaluate source_id.
--       - cumhuriyet (outlet): Bitmap Index Scan on idx_articles_source_
--         published -> Parallel Bitmap Heap Scan on articles (one heap fetch
--         per in-window article, only to read id) -> hash join with a Seq
--         Scan of cluster_articles. sozcu: same articles side, then Index
--         Scan on idx_cluster_articles_article_id (plus a heap fetch for
--         cluster_id).
--   * HYPOTHESIS CONFIRMED for outlets: idx_articles_source_published has no
--     id, so every in-window article costs an articles heap fetch (096 Step
--     0: read=21,860 for haberler-com), and cluster_articles costs another
--     heap fetch per match. For the aggregator the bottleneck is worse (the
--     global published_at scan above). Both are removed by a covering index
--     (source_id, published_at DESC) INCLUDE (id) -> Index Only Scan with no
--     source_id filter fetches (the articles visibility map is kept fresh by
--     045's */30 vacuum), plus (article_id, cluster_id) on cluster_articles.
--     Residual cost, not indexable: one clusters heap fetch per distinct
--     cluster (398 MB heap, wide bias_distribution), bounded by the batch.
--
-- DESIGN
--   * source_karne_refresh_source(p_source_id, p_days): 096's per-source
--     statement, verbatim except v_src.id -> p_source_id. Takes no lock.
--   * source_karne_refresh_batch(p_days, p_limit, p_budget_ms): same advisory
--     lock key as 096; refreshes at most p_limit active sources whose row is
--     missing or older than 20 hours, oldest first, stopping at the wall-
--     clock budget. A source that raises is logged (raise log) and skipped;
--     it does not count toward the limit. Note: `exception when others` does
--     not catch query_canceled, so a single source exceeding the cron
--     statement_timeout would still abort (and roll back) that run.
--   * source_karne_refresh(p_days): same signature as 096, now a full pass
--     through refresh_source with per-source isolation. MANUAL tool, not
--     scheduled, must not be run on a cold production database.
--   * Cron 'source-karne-refresh' is re-pointed to '*/15 * * * *' running the
--     batch (10 sources, 120 s budget, statement_timeout 5 min). A function-
--     level SET would not re-arm the caller's running timer (verified on
--     PG15), so the cron command sets it itself. Each source is recomputed
--     about once a day; a full catch-up is 12 runs, about 3 h.
--   * No backfill call: the first cron ticks fill the table.
--
-- INDEX BUILD (operator): the two CREATE INDEX statements below are plain
-- (no CONCURRENTLY inside a transaction), and a plain build of the articles
-- index blocks ingest writes while it runs. Pre-build both OUTSIDE a
-- transaction before applying this migration, which then makes them no-ops:
--   create index concurrently if not exists idx_articles_source_published_inc_id
--     on public.articles (source_id, published_at desc) include (id);
--   create index concurrently if not exists idx_cluster_articles_article_cluster
--     on public.cluster_articles (article_id, cluster_id);
--
-- Additive only: no table, no drop, no alter table. Zone map: verbatim
-- BIAS_TO_ZONE, parity-tested by tests/migrations/106-source-karne-resilient.
-- test.ts. Rollback: cron.unschedule('source-karne-refresh'); drop the two
-- indexes; re-run 096's function body to restore the monolithic version.

begin;

-- 1. Covering indexes ------------------------------------------------------------

create index if not exists idx_articles_source_published_inc_id
  on public.articles (source_id, published_at desc) include (id);

create index if not exists idx_cluster_articles_article_cluster
  on public.cluster_articles (article_id, cluster_id);

-- 2. Per-source refresh ----------------------------------------------------------

create or replace function public.source_karne_refresh_source(
  p_source_id uuid,
  p_days integer default 30
) returns boolean
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_days      integer := least(greatest(coalesce(p_days, 30), 1), 90);
  v_end       timestamptz := pg_catalog.now();
  v_start     timestamptz;
  v_src       record;
  v_own_zone  text;
  v_own_vote  integer;
begin
  v_start := v_end - pg_catalog.make_interval(days => v_days);

  select id, bias, kind into v_src
    from public.sources where id = p_source_id and active;
  if not found then
    return false;
  end if;

  select z.zone into v_own_zone
    from (values
      ('pro_government','iktidar'),('gov_leaning','iktidar'),('state_media','iktidar'),
      ('islamist_conservative','iktidar'),('nationalist','iktidar'),
      ('center','bagimsiz'),('international','bagimsiz'),('pro_kurdish','bagimsiz'),
      ('opposition_leaning','muhalefet'),('opposition','muhalefet')
    ) as z(bias_key, zone)
   where z.bias_key = v_src.bias;
  v_own_vote := case when v_src.kind in ('outlet','wire') then 1 else 0 end;

  with zmap(bias_key, zone) as (values   -- verbatim BIAS_TO_ZONE; parity-tested by the 106 test
    ('pro_government','iktidar'),('gov_leaning','iktidar'),('state_media','iktidar'),
    ('islamist_conservative','iktidar'),('nationalist','iktidar'),
    ('center','bagimsiz'),('international','bagimsiz'),('pro_kurdish','bagimsiz'),
    ('opposition_leaning','muhalefet'),('opposition','muhalefet')),
  mine as (select distinct ca.cluster_id from public.articles a
             join public.cluster_articles ca on ca.article_id = a.id
            where a.source_id = p_source_id and a.published_at >= v_start),
  per as (select c.id,
                 (c.is_blindspot and not c.blindspot_recall_veto) as bs,
                 (select z2.zone from zmap z2 where z2.bias_key = c.blindspot_side) as bs_zone,
                 coalesce(sum(e.n) filter (where z.zone='iktidar'),0)   zi,
                 coalesce(sum(e.n) filter (where z.zone='bagimsiz'),0)  zb,
                 coalesce(sum(e.n) filter (where z.zone='muhalefet'),0) zm
            from mine m join public.clusters c on c.id = m.cluster_id
            left join lateral (select t.key, (t.value)::int n
                  from pg_catalog.jsonb_each_text(case when pg_catalog.jsonb_typeof(c.bias_distribution)='object'
                                                       then c.bias_distribution else '{}'::jsonb end) t
                 where t.value ~ '^[0-9]+$') e on true
            left join zmap z on z.bias_key = e.key
           group by c.id, c.is_blindspot, c.blindspot_recall_veto, c.blindspot_side),
  adj as (select bs, bs_zone,
            greatest(zi - case when v_own_zone='iktidar'   then v_own_vote else 0 end,0) oi,
            greatest(zb - case when v_own_zone='bagimsiz'  then v_own_vote else 0 end,0) ob,
            greatest(zm - case when v_own_zone='muhalefet' then v_own_vote else 0 end,0) om from per)
  insert into public.source_karne_30d (
    source_id, window_days, window_start, window_end, n_clusters, n_multi,
    co_iktidar, co_bagimsiz, co_muhalefet, n_blindspot, n_blindspot_same_side, computed_at)
  select p_source_id, v_days, v_start, v_end, count(*)::int,
         (count(*) filter (where oi+ob+om>0))::int, (count(*) filter (where oi>0))::int,
         (count(*) filter (where ob>0))::int, (count(*) filter (where om>0))::int,
         (count(*) filter (where bs))::int, (count(*) filter (where bs and bs_zone=v_own_zone))::int, v_end
    from adj
  on conflict (source_id) do update set
    window_days = excluded.window_days,
    window_start = excluded.window_start,
    window_end = excluded.window_end,
    n_clusters = excluded.n_clusters,
    n_multi = excluded.n_multi,
    co_iktidar = excluded.co_iktidar,
    co_bagimsiz = excluded.co_bagimsiz,
    co_muhalefet = excluded.co_muhalefet,
    n_blindspot = excluded.n_blindspot,
    n_blindspot_same_side = excluded.n_blindspot_same_side,
    computed_at = excluded.computed_at;

  return true;
end
$fn$;

comment on function public.source_karne_refresh_source(uuid, integer) is
  'Recomputes the public.source_karne_30d row of ONE active source over the '
  'last p_days days (clamped 1..90). Returns false if the source is missing or '
  'inactive, true after the upsert. Takes no lock; called by '
  'source_karne_refresh_batch() (scheduled) and source_karne_refresh() '
  '(manual). service_role only.';

revoke all on function public.source_karne_refresh_source(uuid, integer) from public, anon, authenticated;
grant execute on function public.source_karne_refresh_source(uuid, integer) to service_role;

-- 3. Bounded batch -----------------------------------------------------------------

create or replace function public.source_karne_refresh_batch(
  p_days integer default 30,
  p_limit integer default 10,
  p_budget_ms integer default 120000
) returns integer
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_days      integer := least(greatest(coalesce(p_days, 30), 1), 90);
  v_limit     integer := least(greatest(coalesce(p_limit, 10), 1), 200);
  v_budget_ms integer := least(greatest(coalesce(p_budget_ms, 120000), 1000), 600000);
  v_started   timestamptz := pg_catalog.clock_timestamp();
  v_src       record;
  v_done      integer := 0;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtext('source_karne_refresh')::bigint
  ) then
    return 0;
  end if;

  for v_src in
    select s.id
      from public.sources s
      left join public.source_karne_30d k on k.source_id = s.id
     where s.active
       and (k.source_id is null or k.computed_at < pg_catalog.now() - interval '20 hours')
     order by k.computed_at asc nulls first, s.id
  loop
    exit when v_done >= v_limit
           or pg_catalog.clock_timestamp() - v_started
              > pg_catalog.make_interval(secs => v_budget_ms / 1000.0);

    begin
      perform public.source_karne_refresh_source(v_src.id, v_days);
      v_done := v_done + 1;
    exception when others then
      raise log 'source_karne_refresh_batch: source % failed: % (%)', v_src.id, sqlerrm, sqlstate;
    end;
  end loop;

  -- Rows of sources that are gone or deactivated.
  delete from public.source_karne_30d k
   where not exists (select 1 from public.sources s where s.id = k.source_id and s.active);

  return v_done;
end
$fn$;

comment on function public.source_karne_refresh_batch(integer, integer, integer) is
  'Bounded refresh of public.source_karne_30d: recomputes at most p_limit '
  '(1..200, default 10) active sources whose row is missing or older than 20 '
  'hours, oldest first, within p_budget_ms (1000..600000, default 120000) of '
  'wall clock. A source that errors is logged (raise log) and skipped, and '
  'does not count toward the limit. Returns the number of sources refreshed '
  '(0 if another run holds the advisory lock). Scheduled every 15 minutes as '
  'source-karne-refresh: each source is recomputed about once a day, up to 10 '
  'per run, about 3 h for a full catch-up. service_role only.';

revoke all on function public.source_karne_refresh_batch(integer, integer, integer) from public, anon, authenticated;
grant execute on function public.source_karne_refresh_batch(integer, integer, integer) to service_role;

-- 4. Legacy full pass (manual) -------------------------------------------------------

create or replace function public.source_karne_refresh(
  p_days integer default 30
) returns integer
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_days      integer := least(greatest(coalesce(p_days, 30), 1), 90);
  v_src       record;
  v_processed integer := 0;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtext('source_karne_refresh')::bigint
  ) then
    return 0;
  end if;

  for v_src in
    select s.id from public.sources s where s.active order by s.id
  loop
    begin
      perform public.source_karne_refresh_source(v_src.id, v_days);
      v_processed := v_processed + 1;
    exception when others then
      raise log 'source_karne_refresh: source % failed: % (%)', v_src.id, sqlerrm, sqlstate;
    end;
  end loop;

  -- Rows of sources that are gone or deactivated.
  delete from public.source_karne_30d k
   where not exists (select 1 from public.sources s where s.id = k.source_id and s.active);

  return v_processed;
end
$fn$;

comment on function public.source_karne_refresh(integer) is
  'MANUAL full pass over public.source_karne_30d: recomputes every active '
  'source over the last p_days days (clamped 1..90) in one transaction via '
  'source_karne_refresh_source(), skipping (and logging) a source that errors. '
  'Returns the number of sources processed (0 if another run holds the '
  'advisory lock). NOT scheduled, and must not be run on a cold production '
  'database (it exceeds the 15 min budget on Micro compute); the scheduled '
  'path is source_karne_refresh_batch(). service_role only.';

revoke all on function public.source_karne_refresh(integer) from public, anon, authenticated;
grant execute on function public.source_karne_refresh(integer) to service_role;

-- 5. Table comment: the real cadence -----------------------------------------------

comment on table public.source_karne_30d is
  'Per-source "Kapsama karnesi" rollup (migration 096): clustered-story counts '
  'over the last window_days days, refreshed in bounded batches by '
  'source_karne_refresh_batch() (migration 106; cron source-karne-refresh '
  'every 15 minutes, a source is recomputed once its row is older than 20 '
  'hours). service_role only.';

-- 6. Schedule ------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron not installed — skipping source-karne-refresh schedule (106)';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'source-karne-refresh') then
    perform cron.unschedule('source-karne-refresh');
  end if;
  perform cron.schedule('source-karne-refresh', '*/15 * * * *',  -- up to 10 sources per run, ~3 h for a full catch-up
    $sql$ set statement_timeout = '5min'; select public.source_karne_refresh_batch(30, 10, 120000); $sql$);
end $$;

-- 7. Backfill: intentionally omitted (the first cron ticks fill the table). -------------

insert into supabase_migrations.schema_migrations (version, name)
  values ('106', '106_source_karne_resilient')
  on conflict do nothing;

commit;
