-- 111_source_reliability.sql
--
-- "Kaynak göstergeleri" (source indicators) for /source/[slug]: three numbers
-- the Kapsama karnesi (096/106) does not carry, in a SIBLING rollup table so
-- the karne table and its readers are untouched:
--   * cadence      -- how many articles the outlet published and on how many
--                     days (Europe/Istanbul), over the last 30 days;
--   * wire copy    -- in how many of its stories the outlet's title + RSS
--                     summary carry the same content fingerprint as another
--                     outlet's inside a wire-redistribution cluster (the
--                     article body is not compared);
--   * zone mix     -- the (iktidar, bagimsiz, muhalefet) vote triples of the
--                     stories it appears in, so the app can average the
--                     "Denge puanı" of those stories.
-- Blindspot participation is NOT computed here: it is n_blindspot / n_clusters
-- of source_karne_30d (096/106), derived in TypeScript.
--
-- DEFINITIONS (pinned; mirrored in src/lib/sources/reliability.ts)
--   * Window: articles.published_at >= now() - p_days days (p_days clamped
--     1..90, default 30), the same `mine` CTE as 106. Served by 106's
--     idx_articles_source_published_inc_id (index-only scan for cadence).
--   * Cadence:
--       n_articles  = all articles of the source with published_at in
--                     [window_start, window_end]; future-dated rows are
--                     excluded. Articles that never reach a cluster count.
--       active_days = distinct Europe/Istanbul calendar dates among them. A
--                     30-day window spans up to 31 dates, so the CHECK allows
--                     window_days + 1; the app clamps it for display.
--   * Wire copy -- reuses detectWireRedistribution (src/lib/clusters/wire.ts)
--     exactly:
--       - per cluster, members are deduped to the EARLIEST article per source
--         (dedupeBySource, src/lib/clusters/blindspot-feed.ts; ties by id);
--       - the cluster is WIRE when the deduped member count >= 3 AND
--         distinct(content_hash, a NULL hash counting as unique per article)
--         / count <= WIRE_UNIQUE_HASH_RATIO (0.5);
--       - n_wire_copy = the source's clusters that are wire AND where the
--         source's own deduped member has a non-null content_hash equal to the
--         hash of ANOTHER source's deduped member in that cluster.
--     "Same content fingerprint" is articles.content_hash, which ingest sets to
--     strictFingerprint(title, description) (supabase/functions/_shared/
--     cluster/fingerprint.ts): a sha1 over the sorted, de-duplicated set of
--     4-character shingles of the diacritic-folded title + RSS description
--     snippet. It is word-order-insensitive and the article body is not
--     compared, so two outlets with the same headline and summary but
--     different bodies count as the same; the app labels it "aynı başlık ve
--     özet", never "aynı metin".
--     It is direction-neutral (it never says who copied whom) and never counts
--     an independent report that merely sits inside a wire cluster.
--   * Zone mix: per cluster, the voting-source counts per zone from
--     clusters.bias_distribution (the basis of BiasSpectrum, the blindspot
--     rule and the Denge puanı), verbatim 106 lateral and BIAS_TO_ZONE map.
--     Clusters with zi + zb + zm >= 5 (BALANCE_MIN_SOURCES) are kept;
--     zone_mix is a jsonb array of [zi, zb, zm, n] grouped by triple, ordered
--     n desc. The app computes the Denge puanı with balanceFromZoneCounts, so
--     no entropy is written in SQL.
--
-- DESIGN
--   * source_reliability_refresh_source(p_source_id, p_days): cadence in one
--     index-only statement, then ONE upsert statement for clusters / wire /
--     zones. Takes no lock. service_role only.
--   * source_karne_refresh_batch(p_days, p_limit, p_budget_ms) is RE-CREATED
--     with the same signature, defaults, grants and advisory-lock key as 106.
--     A source is due when its karne row OR its reliability row is missing or
--     older than 20 hours; each due part is refreshed in its own exception
--     block (a failure is logged with `raise log` and skipped). A source
--     counts toward p_limit only when at least one part succeeded, as in 106.
--     Rows of inactive / removed sources are deleted from BOTH tables.
--   * The scheduled job is unchanged: no cron.schedule / unschedule in this
--     file; the existing */15 job already calls the batch. No backfill call:
--     the first ticks after deploy fill source_reliability_30d (about 12
--     ticks, 3 h, for 118 sources at 10 per run). source_karne_refresh()
--     (manual) and source_karne_refresh_source() are untouched.
--   * The table is service_role only (RLS on, no policy; the reader uses the
--     service-role client under the 4 s cap). New tables must not inherit
--     Supabase's default anon/authenticated grants (cf. 091/095).
--
-- DRY RUN (local PG15.12, throwaway cluster, 2026-10-22; stub schema plus
-- articles.content_hash and clusters.blindspot_recall_veto; default privileges
-- mimic Supabase's. Applied 096, 106, 111, then 111 again, on two fresh
-- databases: no error, 1 ledger row, 1 table, 2 functions, row unchanged.)
--   Fixture, source S (outlet, pro_government):
--     C1  S, A, B share h1, D unique       -> 4 deduped members, 2 distinct: wire, S is a copy
--     C2  A, B, C share h2, S unique       -> wire, S is NOT a copy
--     C3  S, A share h3, B and C NULL hash -> 3 distinct of 4: not wire (a NULL hash is
--                                             unique), so S's hash match is not counted
--     C4  S has s4e (earliest) and h4 (later), A, B, C share h4 -> deduped to the earliest
--         article: wire, S is NOT a copy (using the later one would make it a copy)
--     C5  holds only a 40-day-old S article -> outside the window
--     S has 6 in-window articles on 3 Istanbul dates (4 UTC dates: the two C4
--     articles straddle UTC midnight), one 40-day-old and one future-dated
--     article are excluded. bias_distribution: C1 2/2/1 (5 votes), C2 1/1/1,
--     C3 2/2/0, C4 {}.
--   source_reliability_refresh_source(S, 30) ->
--     n_articles 6 | active_days 3 | n_clusters 4 | n_wire_copy 1 | zone_mix [[2, 2, 1, 1]]
--   C4 given C1's triple, refreshed again (upsert path) -> zone_mix [[2, 2, 1, 2]], the
--     other columns unchanged; restored -> [[2, 2, 1, 1]]
--   inactive source / unknown id -> false
--   source_karne_refresh_batch(30, 10, 120000), 5 active sources -> 5; karne_rows 5,
--     rel_rows 5. Immediate second call -> 0. Source D deactivated, batch -> 0 and
--     both tables drop to 4 rows (D's rows gone).
--   Failure isolation: reliability upsert raising for A -> batch counts A (its karne
--     part succeeded), A has a karne row and no reliability row. Both parts raising
--     for A with p_limit 1 -> batch returns 1: A is skipped without consuming the
--     limit, B is refreshed, C waits for the next tick. Triggers removed -> A and C
--     are filled, then 0.
--   has_table_privilege('anon', 'public.source_reliability_30d', 'select') = false.
--     anon and authenticated: select / insert / update / delete / truncate on the
--     table and execute on both functions are all false; service_role true. RLS on,
--     0 policies. Both functions security definer with search_path="".
--
-- PRODUCTION PLAN CHECK (2026-10-22, read-only EXPLAIN WITHOUT ANALYZE of the
-- SELECT parts for haberler-com, the largest source; no timing was measured,
-- nothing was written): server PG 17.6, articles.content_hash exists, both
-- statements plan. Cadence: Index Only Scan (planner picked the older
-- idx_articles_source_published, also covering published_at), estimated cost
-- 7.6k. `mine`: Parallel Index Only Scan on idx_articles_source_published_inc_id
-- joined to a seq scan of cluster_articles (est. 8.7k clusters). `mem`/`wire`:
-- est. 22.5k member rows, one articles_pkey fetch each, estimated total cost
-- about 48k (106 recorded about 110k for the karne statement on the same source).
--
-- DEPLOY NOTES
--   * Additive: one table, one new function, one re-created function. Apply
--     with the normal migration path; no CONCURRENTLY step (no index here).
--   * Needs 106's idx_articles_source_published_inc_id for the cadence scan
--     (already applied). Residual cost per source is the `mem` CTE: every
--     member of every cluster the source appears in (one articles heap fetch
--     per member). The batch budget (120 s) and the cron statement_timeout
--     (5 min) bound a run; a source that exceeds it is retried by the next
--     tick. Watch the first ticks in cron.job_run_details.
--   * Until a source's row exists the card renders nothing for it (the app
--     treats a missing row as "not computed yet").
--
-- ROLLBACK
--   re-apply 106 section 3 (restores the karne-only batch), then
--     drop function public.source_reliability_refresh_source(uuid, integer);
--     drop table public.source_reliability_30d;
--     delete from supabase_migrations.schema_migrations where version = '111';

begin;

-- 1. Table ---------------------------------------------------------------------

create table if not exists public.source_reliability_30d (
  source_id    uuid primary key references public.sources(id) on delete cascade,
  window_days  int not null check (window_days between 1 and 90),
  window_start timestamptz not null,
  window_end   timestamptz not null,
  n_articles   int not null check (n_articles >= 0),
  active_days  int not null check (active_days between 0 and window_days + 1),
  n_clusters   int not null check (n_clusters >= 0),
  n_wire_copy  int not null check (n_wire_copy between 0 and n_clusters),
  zone_mix     jsonb not null default '[]'::jsonb check (jsonb_typeof(zone_mix) = 'array'),
  computed_at  timestamptz not null default now()
);

comment on table public.source_reliability_30d is
  'Per-source "Kaynak göstergeleri" rollup (migration 111): cadence '
  '(n_articles, active_days), wire-copy cluster count and the zone-vote mix of '
  'the stories the source appears in, over the last window_days days. '
  'Refreshed in bounded batches by source_karne_refresh_batch() together with '
  'source_karne_30d. service_role only.';

alter table public.source_reliability_30d enable row level security;

-- Supabase default privileges hand new tables to anon/authenticated (incl.
-- write grants, cf. 091/095): strip them, then grant service_role only.
revoke all on public.source_reliability_30d from anon, authenticated, public;

-- PG17 added the MAINTAIN privilege; it does not exist before PG17 (revoking
-- it would be a syntax error), so guard.
do $maint$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on public.source_reliability_30d from anon, authenticated';
  end if;
end
$maint$;

grant select, insert, update, delete on public.source_reliability_30d to service_role;

-- 2. Per-source refresh ----------------------------------------------------------

create or replace function public.source_reliability_refresh_source(
  p_source_id uuid,
  p_days integer default 30
) returns boolean
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_days        integer := least(greatest(coalesce(p_days, 30), 1), 90);
  v_end         timestamptz := pg_catalog.now();
  v_start       timestamptz;
  v_n_articles  integer;
  v_active_days integer;
begin
  v_start := v_end - pg_catalog.make_interval(days => v_days);

  perform 1 from public.sources where id = p_source_id and active;
  if not found then
    return false;
  end if;

  -- Cadence: every in-window, non-future article of the source (index-only
  -- scan on idx_articles_source_published_inc_id).
  select pg_catalog.count(*)::int,
         pg_catalog.count(distinct (a.published_at at time zone 'Europe/Istanbul')::date)::int
    into v_n_articles, v_active_days
    from public.articles a
   where a.source_id = p_source_id
     and a.published_at >= v_start
     and a.published_at <= v_end;

  with zmap(bias_key, zone) as (values   -- verbatim BIAS_TO_ZONE; parity-tested by the 111 test
    ('pro_government','iktidar'),('gov_leaning','iktidar'),('state_media','iktidar'),
    ('islamist_conservative','iktidar'),('nationalist','iktidar'),
    ('center','bagimsiz'),('international','bagimsiz'),('pro_kurdish','bagimsiz'),
    ('opposition_leaning','muhalefet'),('opposition','muhalefet')),
  mine as (select distinct ca.cluster_id from public.articles a
             join public.cluster_articles ca on ca.article_id = a.id
            where a.source_id = p_source_id and a.published_at >= v_start),
  -- Earliest article per source in each cluster the source appears in
  -- (dedupeBySource parity).
  mem as (select distinct on (ca.cluster_id, a.source_id)
                 ca.cluster_id, a.source_id, a.id, a.content_hash
            from mine m
            join public.cluster_articles ca on ca.cluster_id = m.cluster_id
            join public.articles a on a.id = ca.article_id
           order by ca.cluster_id, a.source_id, a.published_at asc, a.id),
  -- detectWireRedistribution: >= 3 members and distinct hashes / members <= 0.5,
  -- a NULL hash counting as unique per article.
  wire as (select x.cluster_id from mem x
            group by x.cluster_id
           having pg_catalog.count(*) >= 3
              and pg_catalog.count(distinct coalesce(x.content_hash, 'null:' || x.id::text))::numeric
                  / pg_catalog.count(*) <= 0.5),
  copies as (select o.cluster_id from mem o
               join wire w on w.cluster_id = o.cluster_id
              where o.source_id = p_source_id
                and o.content_hash is not null
                and exists (select 1 from mem y
                             where y.cluster_id = o.cluster_id
                               and y.source_id <> p_source_id
                               and y.content_hash = o.content_hash)),
  zc as (select c.id,
                coalesce(sum(e.n) filter (where z.zone='iktidar'),0)::int   zi,
                coalesce(sum(e.n) filter (where z.zone='bagimsiz'),0)::int  zb,
                coalesce(sum(e.n) filter (where z.zone='muhalefet'),0)::int zm
           from mine m join public.clusters c on c.id = m.cluster_id
           left join lateral (select t.key, (t.value)::int n
                 from pg_catalog.jsonb_each_text(case when pg_catalog.jsonb_typeof(c.bias_distribution)='object'
                                                      then c.bias_distribution else '{}'::jsonb end) t
                where t.value ~ '^[0-9]+$') e on true
           left join zmap z on z.bias_key = e.key
          group by c.id),
  mix as (select zi, zb, zm, pg_catalog.count(*)::int n
            from zc where zi + zb + zm >= 5 group by zi, zb, zm)
  insert into public.source_reliability_30d (
    source_id, window_days, window_start, window_end, n_articles, active_days,
    n_clusters, n_wire_copy, zone_mix, computed_at)
  select p_source_id, v_days, v_start, v_end, v_n_articles, v_active_days,
         (select pg_catalog.count(*) from mine)::int,
         (select pg_catalog.count(*) from copies)::int,
         coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(zi, zb, zm, n)
                                               order by n desc, zi, zb, zm) from mix),
                  '[]'::jsonb),
         v_end
  on conflict (source_id) do update set
    window_days = excluded.window_days,
    window_start = excluded.window_start,
    window_end = excluded.window_end,
    n_articles = excluded.n_articles,
    active_days = excluded.active_days,
    n_clusters = excluded.n_clusters,
    n_wire_copy = excluded.n_wire_copy,
    zone_mix = excluded.zone_mix,
    computed_at = excluded.computed_at;

  return true;
end
$fn$;

comment on function public.source_reliability_refresh_source(uuid, integer) is
  'Recomputes the public.source_reliability_30d row of ONE active source over '
  'the last p_days days (clamped 1..90): cadence (articles, Istanbul-date '
  'active days), wire-copy cluster count (detectWireRedistribution parity) and '
  'the zone-vote mix. Returns false if the source is missing or inactive, true '
  'after the upsert. Takes no lock; called by source_karne_refresh_batch(). '
  'service_role only.';

revoke all on function public.source_reliability_refresh_source(uuid, integer) from public, anon, authenticated;
grant execute on function public.source_reliability_refresh_source(uuid, integer) to service_role;

-- 3. Bounded batch (re-created: karne + reliability) --------------------------------

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
  v_ok        boolean;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtext('source_karne_refresh')::bigint
  ) then
    return 0;
  end if;

  for v_src in
    select s.id,
           (k.source_id is null or k.computed_at < pg_catalog.now() - interval '20 hours') as karne_due,
           (r.source_id is null or r.computed_at < pg_catalog.now() - interval '20 hours') as rel_due
      from public.sources s
      left join public.source_karne_30d k on k.source_id = s.id
      left join public.source_reliability_30d r on r.source_id = s.id
     where s.active
       and ((k.source_id is null or k.computed_at < pg_catalog.now() - interval '20 hours')
            or (r.source_id is null or r.computed_at < pg_catalog.now() - interval '20 hours'))
     order by least(coalesce(k.computed_at, '-infinity'::timestamptz),
                    coalesce(r.computed_at, '-infinity'::timestamptz)) asc, s.id
  loop
    exit when v_done >= v_limit
           or pg_catalog.clock_timestamp() - v_started
              > pg_catalog.make_interval(secs => v_budget_ms / 1000.0);

    v_ok := false;

    if v_src.karne_due then
      begin
        perform public.source_karne_refresh_source(v_src.id, v_days);
        v_ok := true;
      exception when others then
        raise log 'source_karne_refresh_batch: karne of source % failed: % (%)', v_src.id, sqlerrm, sqlstate;
      end;
    end if;

    if v_src.rel_due then
      begin
        perform public.source_reliability_refresh_source(v_src.id, v_days);
        v_ok := true;
      exception when others then
        raise log 'source_karne_refresh_batch: reliability of source % failed: % (%)', v_src.id, sqlerrm, sqlstate;
      end;
    end if;

    if v_ok then v_done := v_done + 1; end if;
  end loop;

  -- Rows of sources that are gone or deactivated.
  delete from public.source_karne_30d k
   where not exists (select 1 from public.sources s where s.id = k.source_id and s.active);
  delete from public.source_reliability_30d r
   where not exists (select 1 from public.sources s where s.id = r.source_id and s.active);

  return v_done;
end
$fn$;

comment on function public.source_karne_refresh_batch(integer, integer, integer) is
  'Bounded refresh of public.source_karne_30d and public.source_reliability_30d: '
  'recomputes at most p_limit (1..200, default 10) active sources whose karne '
  'or reliability row is missing or older than 20 hours, oldest first, within '
  'p_budget_ms (1000..600000, default 120000) of wall clock. Each due part runs '
  'in its own exception block: a part that errors is logged (raise log) and '
  'skipped, and a source counts toward the limit only if at least one part '
  'succeeded. Rows of inactive or removed sources are deleted from both '
  'tables. Returns the number of sources refreshed (0 if another run holds the '
  'advisory lock). Scheduled every 15 minutes as source-karne-refresh (106). '
  'service_role only.';

revoke all on function public.source_karne_refresh_batch(integer, integer, integer) from public, anon, authenticated;
grant execute on function public.source_karne_refresh_batch(integer, integer, integer) to service_role;

-- 4. Schedule: unchanged (106's */15 job already calls the batch). No backfill. ----------

insert into supabase_migrations.schema_migrations (version, name)
  values ('111', '111_source_reliability')
  on conflict do nothing;

commit;
