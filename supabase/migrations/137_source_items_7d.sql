-- 137_source_items_7d.sql
--
-- One read-only function, public.source_items_7d(), that answers "how many
-- articles did each active source publish in the last 7 days" in ONE set-based
-- query. /kaynaklar/durum (and /sources) show that count as the "7 günlük gün
-- başına haber" column; src/lib/sources/feed-status.ts getSourceItemsPerDay()
-- now calls this function instead of the PostgREST embed
-- `sources.select('slug, stats:articles(count)').gte('stats.published_at', ...)`.
-- Additive, one transaction, no table, no column, no index, no data written.
--
--   public.source_items_7d() returns table (slug text, items integer)
--   * one row per ACTIVE source (a source with no article in the window gets
--     items = 0), ordered by slug;
--   * items counts articles with published_at >= now() - interval '7 days'.
--     Nothing bounds published_at from above, exactly like the embed it replaces
--     (a source-controlled future date still counts as published; the
--     freshness column on the same page, which does bound it, is unchanged);
--   * language sql, STABLE, SECURITY DEFINER with search_path = '' (every
--     relation and function is schema-qualified), service_role only.
--
-- WHY (hunt 12, finding h12-ops-2, 2026-11-01). The embed is a per-source
-- LATERAL json_agg. Supabase postgres_logs (24 h) show 12 statement timeouts
-- from postgrest on the statement that contains sources_stats_1, the first at
-- 00:25:07 and the last at 14:34:17 UTC. extensions.pg_stat_statements for that
-- shape: 391 calls, mean 2,527 ms, max 7,937 ms (the finding read 390 calls,
-- mean 2,515 ms, same max), so the slow tail sits right under PostgREST's 8 s
-- statement_timeout. A failed read is cached for the `minutes` lifetime and the
-- public transparency page shows "—" for the whole column until then.
--
-- The count needs nothing but (source_id, published_at), so one index range per
-- active source answers it; no articles heap page is read while the visibility
-- map is current. The function body is the cheapest shape of that: a LATERAL
-- count(*) per source, so the planner cannot choose a join of the whole 7-day
-- window against sources (the GROUP BY form below did exactly that locally).
--
-- STEP 0 -- read-only measurements on production (2026-11-01, PostgreSQL 17.6;
-- plain EXPLAIN, never ANALYZE; no secrets). Every number here is observed.
--
--   1. EXPLAIN of the inlined function body (literals, as a plain SELECT):
--        Nested Loop  (cost=24.15..2871.98 rows=118 width=14)
--          ->  Index Scan using sources_slug_key on sources s  (cost=0.14..36.40 rows=118 width=26)
--                Filter: active
--          ->  Aggregate  (cost=24.01..24.02 rows=1 width=4)
--                ->  Index Only Scan using idx_articles_source_published on articles a  (cost=0.43..22.61 rows=560 width=0)
--                      Index Cond: ((source_id = s.id) AND (published_at >= (now() - '7 days'::interval)))
--      An Index Only Scan per source, nothing else on articles: no Seq Scan, no
--      Bitmap Heap Scan, no sort (sources_slug_key already delivers slug order).
--
--   2. Indexes on public.articles that can serve it (pg_index.indisvalid = true
--      for both): idx_articles_source_published (source_id, published_at desc),
--      67 MB, the one the planner picked for count(*); and
--      idx_articles_source_published_inc_id (106's covering index, the same keys
--      INCLUDE (id)), 92 MB. No new index is needed, so there is no
--      ORCHESTRATOR PRE-BUILD block. (106 documents that 045's */30 vacuum keeps
--      the articles visibility map fresh, which is what makes the scan index-only.)
--
--   3. sources: 118 active of 144 rows. sources.slug is text, sources.active
--      boolean, articles.source_id uuid, articles.published_at timestamptz, so the
--      declared return types need no cast beyond count(*)::integer.
--
--   4. supabase_migrations.schema_migrations: 0 rows for versions 135, 136 and
--      137, so 137 is free. (The ledger is supabase_migrations.schema_migrations.)
--
--   5. pg_stat_statements (stats since 2026-09-21), the shape containing
--      sources_stats_1: 391 calls, mean 2,527 ms, max 7,937 ms. A second
--      statement from the same pages (the directory read, id/name/slug/url ...
--      with `latest`): 3,389 calls, mean 2,344 ms, max 7,988 ms. That one is not
--      changed here.
--
-- LOCAL PROOF (PostgreSQL 15.12, throwaway cluster at scratchpad/pg-aj-d, port
-- 55437, shared_buffers 256 MB, random_page_cost 1.1; stub.sql, then
-- idx_articles_source_published and idx_articles_source_published_inc_id as on
-- production, sources_slug_key unique(slug)). Seed: 120 sources (100 active, 20
-- inactive) x 10,000 articles spread uniformly over 30 days = 1,200,000 articles,
-- of which 279,318 fall in the last 7 days (about 2,323 per active source, far
-- above production's roughly 560 estimate per source, so this is a pessimistic
-- load). vacuum analyze on both tables before measuring.
--   Body as written below (LATERAL count(*)), EXPLAIN (ANALYZE), warm:
--       Execution Time 9.281 ms, 7.072 ms, 10.678 ms (the last run with buffers:
--       shared hit=1896). Plan: Nested Loop; Index Scan using sources_slug_key;
--       Aggregate over Index Only Scan using idx_articles_source_published,
--       actual rows=2323 loops=100. No Seq Scan.
--   GROUP BY form (select s.slug, count(a.id) from sources s left join articles a
--   on a.source_id = s.id and a.published_at >= now() - interval '7 days' where
--   s.active group by s.slug order by s.slug), EXPLAIN (ANALYZE), warm:
--       Execution Time 16.554 ms, 13.779 ms, 19.809 ms (buffers: shared hit=2341).
--       Plan: GroupAggregate over a Nested Loop Left Join that produces all
--       232,269 joined rows (Index Only Scan using
--       idx_articles_source_published_inc_id, loops=100) before it counts them.
--   The LATERAL form is about 1.8x faster and visits fewer buffers, so it is the
--   one below; both return the same 100 rows.
--   The same function called as `select * from public.source_items_7d()` (a
--   SECURITY DEFINER function is not inlined, so it plans its body per call):
--   EXPLAIN (ANALYZE) Function Scan on source_items_7d, rows=100, Execution Time
--   6.693 ms and 6.749 ms, warm.
--
-- DRY RUNS (PostgreSQL 15.12, scratchpad/pg-aj-d, port 55437, stub.sql applied,
-- the seed above; both applies of the file as it stands):
--   Apply #1 (ledger had no row 137): BEGIN, CREATE FUNCTION, COMMENT, REVOKE,
--       GRANT, NOTIFY, INSERT 0 1, COMMIT.
--   Apply #2: the same statements with INSERT 0 0 (on conflict do nothing); the
--       ledger holds one row for 137, the function definition is unchanged
--       (md5 of pg_get_functiondef f4645e408a1577d9d56dde18055395f7 after both
--       applies).
--   Result check: select * from public.source_items_7d() returns 100 rows (the
--       active sources), slug-ordered, equal to the GROUP BY form row for row.
--       Toggling a source to inactive removes its row; an article 8 days old is
--       not counted, one 6 days old is; a source with no recent article yields
--       items = 0. has_function_privilege: service_role true; anon, authenticated
--       false; no table privileges were added to any role.
--
-- No index build, so nothing to pre-build and no CONCURRENTLY. No lock beyond the
-- ACCESS SHARE a SELECT takes: the migration only creates a function.
--
-- VERIFY (read-only, after applying):
--   1. select count(*) from public.source_items_7d();   -- = active sources (118 on 2026-11-01)
--   2. explain select s.slug, c.n from public.sources s cross join lateral (select
--      pg_catalog.count(*)::integer as n from public.articles a where a.source_id =
--      s.id and a.published_at >= pg_catalog.now() - interval '7 days') c where
--      s.active order by s.slug;
--      expect an Index Only Scan on idx_articles_source_published (or the
--      _inc_id twin) per source and no Seq Scan on articles.
--   3. /kaynaklar/durum shows the "7 günlük gün başına haber" column; the
--      statement timeouts that name sources_stats_1 in postgres_logs stop (they
--      stay possible only while the app runs the legacy embed, i.e. before this
--      migration is applied).
--   4. select has_function_privilege('anon', 'public.source_items_7d()', 'execute');  -- false
--
-- ORDER OF DEPLOY. Either order is safe. The app calls the function first and, on
-- PostgREST PGRST202 (function not in the schema cache), falls back once to the
-- old embed, so shipping the app before this migration only costs the old speed.
-- This file ends with `notify pgrst, 'reload schema'` so PostgREST sees the
-- function at once.
--
-- ROLLBACK:
--   drop function if exists public.source_items_7d();
--   delete from supabase_migrations.schema_migrations where version = '137';
-- (the app then takes its PGRST202 fallback to the embed).
--
-- See tests/migrations/137-source-items-7d.test.ts.

begin;

create or replace function public.source_items_7d()
returns table (slug text, items integer)
language sql stable security definer set search_path = ''
as $fn$
  select s.slug, c.n
    from public.sources s
   cross join lateral (
     select pg_catalog.count(*)::integer as n
       from public.articles a
      where a.source_id = s.id
        and a.published_at >= pg_catalog.now() - interval '7 days'
   ) c
   where s.active
   order by s.slug
$fn$;

comment on function public.source_items_7d() is
  'Articles published in the last 7 days per ACTIVE source, one row per source '
  '(items = 0 when it published nothing), ordered by slug. One set-based query '
  'for /kaynaklar/durum and /sources; replaces the per-source stats:articles(count) '
  'embed that timed out at 8 s. STABLE, SECURITY DEFINER, service_role only.';

revoke all on function public.source_items_7d() from public, anon, authenticated;
grant execute on function public.source_items_7d() to service_role;

-- Schema cache and ledger ---------------------------------------------------------

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('137', '137_source_items_7d')
  on conflict do nothing;

commit;
