-- 189_source_reliability_copy_any_cluster.sql
--
-- "Başka kaynaklarla aynı başlık ve özet" (the third row of the "Kaynak
-- göstergeleri" card on /source/[slug]) now counts EVERY cluster the source is
-- in, not only the clusters that pass the wire gate (h103-sourcescores-1).
-- Re-creates ONLY public.source_reliability_refresh_source(uuid, integer) of
-- 111; the table, the batch, the schedule and every other function stay as they
-- are.
--
-- WHY
--   111 divided two different populations. n_clusters counts every in-window
--   cluster of the source (`mine`), but n_wire_copy counted only the clusters
--   that ALSO pass detectWireRedistribution (src/lib/clusters/wire.ts: at least
--   3 deduped members and distinct hashes / members <= 0.5). That gate almost
--   never fires on real stories: outlets that reword a big story give a ratio
--   near 0.9, so it is never "wire". The profile therefore printed 0-2 % for
--   every outlet although the label and the value read as "the share of this
--   outlet's stories that carry another outlet's headline and summary".
--   Production, 2026-11-09 (read-only): source_reliability_30d, 88 active rows
--   with n_clusters >= 20, 64 of them n_wire_copy = 0, the maximum 1.75 %;
--   stored AA 8/1165, TRT Haber 4/730, Milat 9/608, Cumhuriyet 1/2233. The same
--   30 days recomputed without the gate: AA 217/1167, TRT Haber 266/731,
--   Milat 204/603, Cumhuriyet 39/2264 (see REPLAY). The ungated count separates
--   sources (18.6 % and about 34-36 % against 1.7 %), the gated one cannot.
--
-- DEFINITION (pinned; mirrored in src/lib/sources/reliability.ts, the karne
-- helper formatShare and the /metodoloji copy)
--   * Window, cadence, zone mix, the `mine`, `mem`, `zmap`, `zc` and `mix` CTEs
--     and the upsert: exactly 111's. The window is articles.published_at >=
--     now() - p_days days (p_days clamped 1..90, default 30); the cadence days
--     are Europe/Istanbul (Türkiye) calendar dates.
--   * Per cluster the members are deduped to the EARLIEST article per source
--     (dedupeBySource, src/lib/clusters/blindspot-feed.ts; ties by id): the
--     `mem` CTE, unchanged.
--   * n_wire_copy (the column keeps its name and its CHECK) = the number of the
--     source's in-window clusters, of ANY size (a pair counts: there is no
--     member-count floor), where the source's own deduped member has a non-null
--     content_hash equal to the content_hash of the deduped member of ANOTHER
--     source whose sources.kind is not 'aggregator'.
--   * The wire gate is removed: no `wire` CTE, no "at least 3 members", no
--     distinct-hash ratio. "Wire" survives only as the column name.
--   * "Same content fingerprint" is articles.content_hash, which ingest sets to
--     strictFingerprint(title, description) (supabase/functions/_shared/
--     cluster/fingerprint.ts): a sha1 over the sorted, de-duplicated 4-character
--     shingles of the diacritic-folded title + RSS summary. The article body is not compared,
--     so two outlets with the same headline and summary but different bodies
--     count as the same; the app labels it "aynı başlık ve özet", never
--     "aynı metin".
--   * Aggregators (kind = 'aggregator': 7 active sources on 2026-11-09, among
--     them Haberler.com and Onedio) republish other outlets' headlines
--     wholesale, so as a PARTNER they say nothing about who shares with whom and
--     are not counted. The exclusion is on the partner only: an aggregator's own
--     row still counts the clusters it shares with a non-aggregator. Partners of
--     kind 'wire' (AA, BHA, IHA, Türkiye Haber Ajansı), 'outlet' and 'niche'
--     count.
--   * `copies` reads `mem o` of the source itself, one row per cluster of
--     `mine`, so copies is a subset of mine and n_wire_copy <= n_clusters: the
--     CHECK of 111 still holds for every row.
--   * Direction-neutral: it never says who copied whom, and the outlet that
--     published the headline first is counted like the one that reused it.
--
-- REFRESH TIMING (no data rewrite, no backfill, no manual refresh call)
--   This file replaces a function and writes no row. Rows keep their old
--   n_wire_copy until the existing batch recomputes them. The cron job
--   source-karne-refresh (*/15 * * * *, select public.source_karne_refresh_batch
--   (30, 10, 120000)) picks a source when its reliability row is older than 20 hours,
--   10 sources per tick, oldest first. On 2026-11-09 11:06Z the 118 rows were
--   computed between 2026-11-08 19:45Z and 2026-11-09 00:30Z, so they fall due
--   between 15:45Z and 20:30Z today, about 6 per tick on average (the batch
--   takes up to 10). Applied before 15:45Z, every row is therefore recomputed by
--   the new function within one tick of falling due, the last one on the first
--   tick after 20:30Z. Applied later, the rows already due are taken 10 per
--   tick, oldest first: 12 ticks, about 3 hours, for all 118. Until a row is
--   recomputed the card keeps the old value, as it does between any two cycles.
--
-- DESIGN
--   * Same signature (p_source_id uuid, p_days integer default 30) returns
--     boolean, SECURITY DEFINER, search_path '', same grants as 111: service_role
--     only. No table change, no index, no trigger, no schedule change.
--   * One statement shape as in 111 (cadence, then ONE upsert). The only CTE that
--     changes is `copies`; `wire` is gone. Cost: `mem` dominates both versions
--     (one articles fetch per member). EXPLAIN without ANALYZE for haberler-com,
--     the largest source, 30 days, 2026-11-09 (read-only): total cost 57.8k for
--     111's mine + wire + copies, 55.9k for mine + the new copies (a hash join on
--     cluster_id and content_hash); the planner picks no new scan of articles.
--
-- PRODUCTION CHECK (2026-11-09, read-only, nothing written)
--   * STEP 0: md5(prosrc) of public.source_reliability_refresh_source(uuid,
--     integer) on production = 761dacdf55be8a0d632a04df034fdec9, length 4586,
--     prosecdef true, proconfig {search_path=""}: equal to the md5 of the text
--     between the $fn$ markers of 111's function, so 189 replaces exactly 111's
--     body and nothing was changed by hand in between. No later migration
--     redefines the function.
--   * REPLAY, the new CTEs run inline through a READ ONLY transaction for the
--     same 30 days; "111 logic" is 111's wire-gated `copies` run in the same
--     statement and reproduces the stored rows, which checks the harness:
--       source (kind)                  stored       111 logic    189 logic
--       anadolu-ajansi (wire)          8/1165       8/1167       217/1167  18.6 %
--       trt-haber (outlet)             4/730        4/731        266/731   36.4 %
--       milat (outlet)                 9/608        9/603        204/603   33.8 %
--       cumhuriyet (outlet)            1/2233       1/2264       39/2264    1.7 %
--       demokrat-haber (outlet)        0/46         0/47         5/47      10.6 %
--       diyanet-haber (niche)          1/57         1/55         4/55       7.3 %
--       a-news / turkiye-haber-ajansi / medya-gazete   0/40, 0/47, 0/56  ->  0/42, 0/47, 0/55
--       haberler-com (aggregator), 10 days (30 days passes the 8 s read-only
--       cap)                          5/10809 (30 d)  2/2860     33/2860    1.2 %
--     Counting the aggregator partners as well would give 239 for AA (not 217),
--     56 for haberler-com (not 33) and 6 for demokrat-haber (not 5).
--
-- DRY RUN (local PG15.12, throwaway cluster, the tracked stub plus articles.content_hash and
-- clusters.bias_distribution; tests/migrations/sql/189-source-reliability-copy-dryrun.sql, run by
-- run-live.sh, 2026-11-09). It applies 111 (its function body md5 equals the production md5 above),
-- builds a fixture of 12 clusters over 8 sources, runs 111's function for every active source, applies
-- 189 TWICE and runs the function again:
--   * Source S: 111 counted 3 of 11 clusters (C5 and C8 wire clusters, C16 whose only partners are
--     aggregators); 189 counts 6 of 11: C1 (a pair), C5, C8, C9 (6 members, 5 distinct hashes, not
--     wire), C10 (a niche partner) and C17 (an inactive partner); C16 drops out. C4 stays out because
--     S's EARLIEST article in it carries another hash, C6 because NULL hashes never match, C7 is
--     outside the window (n_clusters 11, n_articles 12).
--   * An aggregator's own row counts non-aggregator partners: AG 3 of 4 clusters, AG2 2 of 4; a
--     cluster shared only with another aggregator is not counted (C15).
--   * For every fixture source n_wire_copy equals an independent formulation (row_number instead of
--     distinct on), n_wire_copy <= n_clusters, and every other column (window_days, n_articles,
--     active_days, n_clusters, zone_mix [[2, 1, 2, 2]]) equals what 111 wrote. The inactive source
--     and an unknown id return false and write no row.
--   * After two applies: one function of that name, SECURITY DEFINER, search_path "", returns
--     boolean, anon and authenticated cannot execute it, service_role can, ledger row 189 exactly
--     once, source_karne_refresh_batch untouched. Body md5 c23aa161f55921967e997578b2be16da, length
--     4660 (read it on production after the apply: select md5(prosrc), length(prosrc) from pg_proc
--     where oid = 'public.source_reliability_refresh_source(uuid,integer)'::regprocedure).
--   * The rollback of this header (re-apply 111, delete ledger row 189) restores md5
--     761dacdf55be8a0d632a04df034fdec9 and S's gated count 3; applying 189 once more gives 6.
--
-- DEPLOY NOTES
--   * Additive: one CREATE OR REPLACE FUNCTION, one comment, the same revoke and
--     grant as 111, and the ledger row. Apply with the normal migration path; it
--     takes no table lock, so there is nothing to schedule around, and it is safe
--     to apply twice.
--   * The app (reliability.ts, karne.ts, /metodoloji) ships the new copy and the
--     formatShare helper in the same PR. Either order is safe: the app only reads
--     the stored counts, and a row that is not yet recomputed simply shows its
--     older, smaller count under the new copy until the batch reaches it.
--   * Right after the apply, read-only: select md5(prosrc), length(prosrc), prosecdef, proconfig
--     from pg_proc where oid = 'public.source_reliability_refresh_source(uuid,integer)'::regprocedure
--     returns c23aa161f55921967e997578b2be16da, 4660, true, {search_path=""}; and
--     has_function_privilege('anon', that oid, 'execute') and ('authenticated', ...) are false,
--     ('service_role', ...) true.
--   * After one batch cycle (see REFRESH TIMING), read-only:
--       select s.slug, r.n_wire_copy, r.n_clusters, r.computed_at
--         from public.source_reliability_30d r join public.sources s on s.id = r.source_id
--        where s.slug in ('anadolu-ajansi', 'trt-haber', 'milat', 'cumhuriyet');
--     with computed_at after the apply. Expect AA near 15-21 %, TRT Haber and
--     Milat in the 30s, Cumhuriyet near 1-2 %.
--
-- ROLLBACK
--   re-apply 111's function body and its comment (the create or replace function
--   block and the comment on function statement of section 2 of
--   111_source_reliability.sql; create or replace keeps 189's comment otherwise)
--   restores the wire gate, then
--     delete from supabase_migrations.schema_migrations where version = '189';
--   The rows return to the gated count as the batch recomputes them.

begin;

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
  -- n_wire_copy (189): the source's own deduped member (one row per cluster of
  -- `mine`, so copies is a subset of mine) has a non-null hash equal to the hash
  -- of the deduped member of ANOTHER source whose kind is not 'aggregator'. Any
  -- cluster size: 111's `wire` gate (>= 3 members, distinct hashes / members <=
  -- 0.5) is gone. The aggregator exclusion is on the partner (y), never on the
  -- source's own row (o).
  copies as (select o.cluster_id from mem o
              where o.source_id = p_source_id
                and o.content_hash is not null
                and exists (select 1 from mem y join public.sources s on s.id = y.source_id
                             where y.cluster_id = o.cluster_id
                               and y.source_id <> p_source_id
                               and y.content_hash = o.content_hash
                               and s.kind <> 'aggregator')),
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
  'active days), the copy count n_wire_copy (the clusters of the source, of any '
  'size, where its earliest article has the same content_hash as the earliest '
  'article of another source that is not an aggregator, migration 189) and the '
  'zone-vote mix. Returns false if the source is missing or inactive, true '
  'after the upsert. Called by the 15-minute source_karne_refresh job. '
  'service_role only.';

revoke all on function public.source_reliability_refresh_source(uuid, integer) from public, anon, authenticated;
grant execute on function public.source_reliability_refresh_source(uuid, integer) to service_role;

insert into supabase_migrations.schema_migrations (version, name)
  values ('189', '189_source_reliability_copy_any_cluster')
  on conflict do nothing;

commit;
