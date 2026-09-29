-- 096_source_karne.sql
--
-- "Kapsama karnesi" (coverage report card) rollup for /source/[slug]:
-- one row per active source describing how its CLUSTERED stories behave
-- over the last 30 days. Read by src/lib/sources/karne.ts as a single PK
-- lookup; the aggregate itself runs off the request path, in pg_cron.
--
-- DEFINITIONS (pinned; mirrored in src/lib/sources/karne.ts and
-- docs/source-karne.md)
--   * Window: articles.published_at >= now() - p_days days. Served by
--     idx_articles_source_published (044).
--   * Story: a distinct cluster holding >= 1 article of source S published
--     in the window. Non-politics articles are never clustered, so they
--     drop out of every count below.
--   * own_vote = 1 if S.kind in ('outlet','wire') else 0 (voting kinds,
--     VOTING_SOURCE_KINDS); own_zone = BIAS_TO_ZONE[S.bias].
--   * Per cluster, zone counts come from clusters.bias_distribution, which
--     counts DISTINCT VOTING SOURCES. others_z = greatest(z - (zone =
--     own_zone ? own_vote : 0), 0).
--   * n_multi = clusters with others_i + others_b + others_m >= 1;
--     n_solo = n_clusters - n_multi (derived app-side).
--   * co_<zone> = multi clusters with others_zone >= 1 (a cluster can count
--     in several zones; shares do not sum to 100%).
--   * n_blindspot = clusters with is_blindspot AND NOT
--     blindspot_recall_veto (the public blindspot definition, 071).
--     n_blindspot_same_side = subset where zone(blindspot_side) = own_zone.
--
-- Deliberately NOT computed: clickbait (precision gate closed), headline
-- edits (056 counsel gate), first-mover counts, any list of skipped stories.
--
-- STEP 0 MEASUREMENTS (production, 2026-09-29, read-only EXPLAIN (ANALYZE,
-- BUFFERS) of the per-source SELECT with the INSERT removed; cold-ish cache):
--   haberler-com  (aggregator, 33,122 articles/30d): 4,044 ms; shared hit=26195 read=21860
--   haber7        (outlet,      8,580 articles/30d):   867 ms; shared hit=10004 read=5943
--   cumhuriyet    (outlet,      8,573 articles/30d): 8,575 ms; shared hit=12841 read=5052
-- Max 8.6 s > 3 s threshold, so the one-off backfill is NOT part of this
-- migration (see docs/source-karne.md, "Deploy"): run
-- `set statement_timeout = '10min'; select public.source_karne_refresh(30);`
-- as a separate step. The cron command sets the same timeout itself (a
-- function-level SET would not re-arm the caller's already-running timer;
-- verified on PG15). The cron job fills the table within 6 hours anyway.
--
-- Additive only: one new table, one new function, one cron job. Nothing
-- existing is altered. The table is service_role-only (no anon/authenticated
-- grants, RLS on with zero policies); the reader uses the service role.
--
-- Zone map: verbatim BIAS_TO_ZONE, parity-tested by
-- tests/migrations/096-source-karne.test.ts (8th SQL copy).

begin;

-- 1. Table ---------------------------------------------------------------------

create table if not exists public.source_karne_30d (
  source_id             uuid primary key references public.sources(id) on delete cascade,
  window_days           int not null check (window_days between 1 and 90),
  window_start          timestamptz not null,
  window_end            timestamptz not null,
  n_clusters            int not null check (n_clusters >= 0),
  n_multi               int not null check (n_multi between 0 and n_clusters),
  co_iktidar            int not null check (co_iktidar >= 0),
  co_bagimsiz           int not null check (co_bagimsiz >= 0),
  co_muhalefet          int not null check (co_muhalefet >= 0),
  n_blindspot           int not null check (n_blindspot >= 0),
  n_blindspot_same_side int not null check (n_blindspot_same_side >= 0),
  computed_at           timestamptz not null default now()
);

comment on table public.source_karne_30d is
  'Per-source "Kapsama karnesi" rollup (migration 096): clustered-story counts '
  'over the last window_days days, refreshed every 6 h by '
  'source_karne_refresh(). service_role only.';

alter table public.source_karne_30d enable row level security;

-- Supabase default privileges hand new tables to anon/authenticated (incl.
-- write grants, cf. 091/095): strip them, then grant service_role only.
revoke all on public.source_karne_30d from anon, authenticated, public;

-- PG17 added the MAINTAIN privilege; it does not exist before PG17 (revoking
-- it would be a syntax error), so guard.
do $maint$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on public.source_karne_30d from anon, authenticated';
  end if;
end
$maint$;

grant select, insert, update, delete on public.source_karne_30d to service_role;

-- 2. Refresh function ----------------------------------------------------------

create or replace function public.source_karne_refresh(
  p_days integer default 30
) returns integer
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_days      integer := least(greatest(coalesce(p_days, 30), 1), 90);
  v_end       timestamptz := pg_catalog.now();
  v_start     timestamptz;
  v_src       record;
  v_own_zone  text;
  v_own_vote  integer;
  v_processed integer := 0;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtext('source_karne_refresh')::bigint
  ) then
    return 0;
  end if;

  v_start := v_end - pg_catalog.make_interval(days => v_days);

  for v_src in
    select id, bias, kind from public.sources where active order by id
  loop
    select z.zone into v_own_zone
      from (values
        ('pro_government','iktidar'),('gov_leaning','iktidar'),('state_media','iktidar'),
        ('islamist_conservative','iktidar'),('nationalist','iktidar'),
        ('center','bagimsiz'),('international','bagimsiz'),('pro_kurdish','bagimsiz'),
        ('opposition_leaning','muhalefet'),('opposition','muhalefet')
      ) as z(bias_key, zone)
     where z.bias_key = v_src.bias;
    v_own_vote := case when v_src.kind in ('outlet','wire') then 1 else 0 end;

    with zmap(bias_key, zone) as (values   -- verbatim BIAS_TO_ZONE; parity-tested (8th SQL copy)
      ('pro_government','iktidar'),('gov_leaning','iktidar'),('state_media','iktidar'),
      ('islamist_conservative','iktidar'),('nationalist','iktidar'),
      ('center','bagimsiz'),('international','bagimsiz'),('pro_kurdish','bagimsiz'),
      ('opposition_leaning','muhalefet'),('opposition','muhalefet')),
    mine as (select distinct ca.cluster_id from public.articles a
               join public.cluster_articles ca on ca.article_id = a.id
              where a.source_id = v_src.id and a.published_at >= v_start),
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
    select v_src.id, v_days, v_start, v_end, count(*)::int,
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

    v_processed := v_processed + 1;
  end loop;

  -- Rows of sources that are gone or deactivated.
  delete from public.source_karne_30d k
   where not exists (select 1 from public.sources s where s.id = k.source_id and s.active);

  return v_processed;
end
$fn$;

comment on function public.source_karne_refresh(integer) is
  'Recomputes public.source_karne_30d for every active source over the last '
  'p_days days (clamped 1..90), one statement per source. Returns the number '
  'of sources processed (0 if another run holds the advisory lock). '
  'service_role only; scheduled every 6 h as source-karne-refresh.';

revoke all on function public.source_karne_refresh(integer) from public, anon, authenticated;
grant execute on function public.source_karne_refresh(integer) to service_role;

-- 3. Schedule ----------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron not installed — skipping source-karne-refresh schedule (096)';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'source-karne-refresh') then
    perform cron.unschedule('source-karne-refresh');
  end if;
  perform cron.schedule('source-karne-refresh', '41 0 * * *',  -- daily 03:41 TRT (low traffic); a full pass scans ~1-9 s per source
    $sql$ set statement_timeout = '15min'; select public.source_karne_refresh(); $sql$);
end $$;

-- 4. Backfill: intentionally omitted (Step 0: max 8.6 s > 3 s). See deploy notes.

insert into supabase_migrations.schema_migrations (version, name)
  values ('096', '096_source_karne')
  on conflict do nothing;

commit;
