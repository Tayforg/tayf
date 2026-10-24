-- 120_twin_cluster_pairs.sql
--
-- WHY. Before #128 an outlet that edited a headline republished the story under
-- a new URL slug and kept the numeric id its CMS gave it, so ingest stored a
-- second articles row and clustering often put the two rows in two different
-- clusters (migration 113: source_article_key is that id). #128 stops new twins
-- at ingest; the twins already stored stay split, each cluster counting the
-- same outlet once more than it should, and some blindspot flags rest on them.
-- This migration adds one READ-ONLY function so /admin/birlestir can list the
-- cluster pairs that share such an article pair ("Olası ikiz kümeler"). It
-- never merges anything: each pair is merged only when an admin presses
-- Birleştir, which POSTs the existing /api/admin/cluster-merge flow (action
-- 'merge', origin 'manual', cluster_merge_atomic from migration 099).
--
--   public.admin_twin_cluster_pairs(p_days integer default 14,
--                                   p_limit integer default 50)
--     returns table (cluster_a uuid, cluster_b uuid, twin_count integer,
--                    source_slugs text[], newest_at timestamptz)
--   * a twin pair = two articles rows with the same source_id and the same
--     non-null source_article_key, both created within the window, each a
--     member of a cluster, the two clusters different;
--   * one row per cluster pair (cluster_a < cluster_b), twin_count = how many
--     distinct (source, key) twins the two clusters share, source_slugs = the
--     sorted distinct slugs, newest_at = created_at of the newest twin article;
--   * both clusters must be live (not archived, merged_into null);
--   * newest first, ties by the cluster ids; p_days is clamped to 1..14 and
--     p_limit to 1..50 (NULL means 14 and 50), whatever the caller sends.
--   * only articles in the categories the cluster trigger enqueues (politika,
--     son_dakika: articles_cluster_enqueue, migration 025) are read, because no
--     other article can be in a cluster. This is a speed choice, not a rule:
--     on prod the unfiltered and the filtered function return the same 1,082
--     pairs, and tests/migrations/120-twin-cluster-pairs.test.ts compares the
--     category list with the trigger's WHEN clause in 025. If the trigger is
--     ever widened, widen it here too.
-- SECURITY DEFINER with search_path = '' and service_role only (the admin page
-- reads through the service-role client); anon and authenticated cannot call
-- it (tests/guards/anon-surface.test.ts scans migrations from 116 on).
-- No table, no column, no index, no other grant.
--
-- STEP 0 (production, 2026-10-24, read-only SELECTs; PostgreSQL 17, no secrets)
--   (a) supabase_migrations.schema_migrations: the newest numeric version is
--       118 (118_api_throttle); 119 and 120 are not recorded, so 120 is free.
--   (b) Key coverage, articles created in the last 14 days (now() =
--       2026-10-24 07:38 UTC): 112,507 of 143,924 rows carry a
--       source_article_key; the oldest row of the window (2026-10-10 07:39)
--       is keyed, so 113's operator backfill ran for the whole window. The
--       rows without a key are the sources that have no id in their URLs
--       (daily-sabah, a-news excluded in 113, slug-only outlets).
--   (c) EXPLAIN (ANALYZE, BUFFERS) of the function body as a plain SELECT with
--       the literals 14 and 50 (shared_buffers is 256 MB, so timings swing with
--       what is in cache; every run below is a separate request):
--       * first shape (CTE tw = every row of a duplicated key, self-joined to
--         build pairs): 3.7 s cold (9,365 blocks read), then 0.41, 0.34 and
--         0.55 s warm, and again 5.0 s and 6.7 s after the cache was evicted
--         (14-19k blocks read). The planner estimates the materialised CTE at
--         21 rows (it is 5,805) and picks a hash join only by luck: the same
--         shape restricted to politika/son_dakika was estimated at 1 row and
--         became a nested loop with a 3.7 M row join filter (0.9 s warm).
--       * a window-function dup (count(*) over (partition by ...)): no better
--         (4.9 s cold, 0.55 s warm).
--       * final shape (this file): dup groups found on politika/son_dakika
--         rows of the window, then the two members of each group fetched by
--         the partial (source_id, source_article_key) index and joined to
--         cluster_articles by index (idx_cluster_articles_article_cluster).
--         No CTE is joined to itself, so the plan does not depend on a row
--         estimate: 0.22 to 0.43 s warm (216, 425 ms), 5.5 s with the cache
--         evicted (16,034 blocks read, 12,410 of them the 14-day articles
--         heap scan). Target under 2 s is met warm and not met cold; the
--         PostgREST limit is 8 s and a miss shows the page's "Veri okunamadı"
--         line, a reload is warm. The cold cost is the articles heap scan, which
--         only an index on (source_id, source_article_key, created_at) would
--         remove; this migration adds none (articles is the ingest hot table).
--   (d) Result: 1,082 cluster pairs in total (the first and the last of the
--       top 50: 1 twin each, yenicag newest 2026-10-23 21:33 UTC down to
--       cnn-turk 10:21), 50 returned by the cap. The first shape and the final
--       one return identical rows (50 of 50, and 1,082 of 1,082 without the
--       limit). Because 1,082 is far above the cap, the list refills from the
--       next-newest pairs as an admin merges.
--
-- DRY RUNS x2 (local PostgreSQL 15.12, throwaway cluster, the stub schema)
--   Stub: the QA stub.sql plus, for the stub only, articles.created_at
--   timestamptz not null default now(), articles.source_article_key text,
--   clusters.merged_into uuid and the three indexes the plan relies on
--   (articles_source_article_key_idx partial, idx_cluster_articles_article_cluster,
--   idx_articles_created_source).
--   * Run 1: BEGIN, CREATE FUNCTION, COMMENT, REVOKE, GRANT, INSERT 0 1, COMMIT.
--     Run 2: the same with INSERT 0 0 (the ledger row exists). No NOTICE and no
--     error on either run.
--   * End state after both runs: one ledger row '120'; one function, SECURITY
--     DEFINER, STABLE, proconfig {"search_path=\"\""}; proacl
--     {postgres=X/postgres,service_role=X/postgres}; has_function_privilege is
--     false for anon, false for authenticated, true for service_role; no PUBLIC
--     grantee; the comment is set. Called as anon or authenticated the function
--     fails with "permission denied for function admin_twin_cluster_pairs"; as
--     service_role it returns 0 rows on the empty tables.
--   * tests/migrations/120-twin-cluster-pairs.test.ts with TAYF_PSQL pointed at
--     that database: 34 passed (16 static, 18 live on rolled-back fixtures).
--     Mutating the applied function (not this file) fails exactly one live test
--     each: dropping the different-cluster filter, dropping the archived check
--     on one side, ascending order, a 500 row clamp, dropping the category
--     filter, a 30 day clamp. This file re-applied afterwards: 34 of 34.
--   * The cluster was stopped afterwards.
--
-- ROLLBACK (nothing depends on this until the admin page is deployed):
--   1. Redeploy the previous app (the page then never calls the function).
--   2. drop function public.admin_twin_cluster_pairs(integer, integer);
--   3. delete from supabase_migrations.schema_migrations where version = '120';
--
-- Safe to re-apply: create or replace function, comment on, revoke and grant
-- are idempotent, the ledger insert is `on conflict do nothing`.
--
-- See tests/migrations/120-twin-cluster-pairs.test.ts and
-- tests/guards/admin-twin-review.test.ts.

begin;

create or replace function public.admin_twin_cluster_pairs(p_days integer default 14, p_limit integer default 50)
returns table (cluster_a uuid, cluster_b uuid, twin_count integer, source_slugs text[], newest_at timestamptz)
language sql stable security definer set search_path = ''
as $fn$
  with p as (
    select pg_catalog.now() - (least(greatest(coalesce(p_days, 14), 1), 14) * interval '1 day') as since,
           least(greatest(coalesce(p_limit, 50), 1), 50) as lim
  ),
  dup as (
    select a.source_id, a.source_article_key
      from public.articles a, p
     where a.source_article_key is not null
       and a.category in ('politika', 'son_dakika')
       and a.created_at >= p.since
     group by 1, 2
    having pg_catalog.count(*) > 1
  ),
  pairs as (
    select least(c1.cluster_id, c2.cluster_id) as ca,
           greatest(c1.cluster_id, c2.cluster_id) as cb,
           d.source_id,
           d.source_article_key,
           greatest(t1.created_at, t2.created_at) as at
      from dup d
     cross join p
      join public.articles t1
        on t1.source_id = d.source_id
       and t1.source_article_key = d.source_article_key
       and t1.created_at >= p.since
      join public.articles t2
        on t2.source_id = d.source_id
       and t2.source_article_key = d.source_article_key
       and t2.created_at >= p.since
       and t2.id > t1.id
      join public.cluster_articles c1 on c1.article_id = t1.id
      join public.cluster_articles c2 on c2.article_id = t2.id
     where c1.cluster_id <> c2.cluster_id
  )
  select x.ca,
         x.cb,
         pg_catalog.count(distinct (x.source_id, x.source_article_key))::integer,
         pg_catalog.array_agg(distinct s.slug order by s.slug),
         pg_catalog.max(x.at)
    from pairs x
    join public.clusters k1 on k1.id = x.ca and not coalesce(k1.is_archived, false) and k1.merged_into is null
    join public.clusters k2 on k2.id = x.cb and not coalesce(k2.is_archived, false) and k2.merged_into is null
    join public.sources s on s.id = x.source_id
   group by x.ca, x.cb
   order by pg_catalog.max(x.at) desc, x.ca, x.cb
   limit (select lim from p)
$fn$;

comment on function public.admin_twin_cluster_pairs(integer, integer) is
  'Read-only list of cluster pairs that share a same-source, same-source_article_key '
  'article pair (twin rows from before the ingest fix, migration 113), both clusters '
  'live, newest twin first. p_days is clamped to 1..14, p_limit to 1..50. Feeds the '
  'Olası ikiz kümeler list on /admin/birlestir, which never merges on its own. '
  'service_role only. Migration 120.';

revoke all on function public.admin_twin_cluster_pairs(integer, integer) from public, anon, authenticated;
grant execute on function public.admin_twin_cluster_pairs(integer, integer) to service_role;

insert into supabase_migrations.schema_migrations (version, name)
  values ('120', '120_twin_cluster_pairs')
  on conflict do nothing;

commit;
