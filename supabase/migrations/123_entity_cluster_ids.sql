-- 123_entity_cluster_ids.sql
--
-- Entity hubs (roadmap G2, /gundem/[key]). One ids-first, read-only RPC that
-- lists the NEWEST clusters mentioning a curated entity (src/lib/trends/
-- rising-entities.ts: Erdoğan, CHP, YSK, ...) together with the total match
-- count inside the window.
--
-- Why a new RPC and not search_cluster_ids (migration 083): that function
-- orders by article_count desc with NO time window. For a recency hub it
-- would surface the most-corroborated clusters of all time, so a hub for a
-- person in the news today would lead with a story from months ago. This one
-- windows on clusters.updated_at, orders newest first and ties on id, so the
-- list is stable between requests.
--
-- Measured match counts over the default 14-day window (read-only SELECT of
-- the same predicate against production, 2026-10-31):
--
--   Erdoğan  422 clusters
--   CHP      194 clusters
--   YSK        1 cluster
--
-- EXPLAIN (analyze, buffers) of the inline SELECT with literal variants
-- (production, read-only, 2026-10-31): Erdoğan 46 ms cold / 17 ms warm,
-- CHP 49 ms cold / 20 ms warm. Bitmap Index Scan on the 083 partial index
-- clusters_search_tsv_live_idx (3,694 / 4,649 candidate rows), WindowAgg over
-- the 422 / 194 survivors, top-N heapsort. No new index is needed.
--
-- Hence the cap and the total: the page lists at most 20 (p_limit is clamped
-- to 1..50) and says "Son 14 günde 422 küme · en yeni 20 tanesi
-- listeleniyor". Hubs with fewer than three matches (YSK) are rendered with
-- noindex by the page: a one-card hub is a thin page. `count(*) over ()` is
-- evaluated before the LIMIT, so the total is the full match count, not the
-- page size, and it costs no second scan.
--
-- Window: the SQL default is now() - 14 days when p_since is null, and
-- p_since can never reach further back than 30 days. The application never
-- passes p_since, so no clock is read in app code and the page stays
-- prerenderable under cacheComponents.
--
-- Matching: the very same 3-variant OR'd websearch_to_tsquery block as 083
-- (the same Turkish word can be stored under up to three lexeme spellings
-- under the database's en_US.UTF-8 collation, see 083 Q2), against
-- clusters.search_tsv (035) and its GIN index. The predicate literals are the
-- ones the 083 partial index covers (not is_archived, article_count >= 2)
-- plus merged_into is null, so a cluster that was merged away (migration 099)
-- never appears next to its survivor. tests/migrations/123-entity-cluster-
-- ids.test.ts pins the tsquery block to 083's text.
--
-- Access: SECURITY DEFINER with an empty search_path, so every relation and
-- function is schema-qualified. Execute is revoked from public, anon and
-- authenticated and granted to service_role only; the Next.js server calls it
-- through createReaderClient() (service key, 4 s statement cap). It takes no
-- table grants and the anon key cannot reach it (tests/guards/anon-surface).
--
-- Additive only: one new function (create or replace), no DDL on any existing
-- object, ledger insert is on conflict do nothing. Safe to apply twice.
--
-- Rollback:
--   drop function public.entity_cluster_ids(text[], timestamptz, integer);
--   delete from supabase_migrations.schema_migrations where version='123';

begin;

set local lock_timeout = '5s';

create or replace function public.entity_cluster_ids(
  p_variants text[],
  p_since timestamptz default null,
  p_limit integer default 20
)
returns table (id uuid, total bigint)
language sql
stable
security definer
set search_path = ''
as $fn$
  select c.id, (pg_catalog.count(*) over ())::bigint
  from public.clusters c
  where c.search_tsv @@ (
          select pg_catalog.websearch_to_tsquery('pg_catalog.turkish'::pg_catalog.regconfig, coalesce(p_variants[1], ''))
              || pg_catalog.websearch_to_tsquery('pg_catalog.turkish'::pg_catalog.regconfig, coalesce(p_variants[2], p_variants[1], ''))
              || pg_catalog.websearch_to_tsquery('pg_catalog.turkish'::pg_catalog.regconfig, coalesce(p_variants[3], p_variants[1], ''))
        )
    and not c.is_archived      -- literal copy of the 083 partial-index predicate
    and c.article_count >= 2
    and c.merged_into is null
    and c.updated_at >= greatest(coalesce(p_since, pg_catalog.now() - interval '14 days'), pg_catalog.now() - interval '30 days')
  order by c.updated_at desc, c.id
  limit greatest(1, least(coalesce(p_limit, 20), 50));
$fn$;

comment on function public.entity_cluster_ids(text[], timestamptz, integer) is
  'Newest-first cluster ids matching a curated entity (migration 123, roadmap G2). '
  'Caller: src/lib/entities/entity-hub-query.ts for /gundem/[key], which derives '
  'p_variants from turkishQueryVariants() and never passes p_since. Same 3-variant '
  'OR''d websearch_to_tsquery block as search_cluster_ids (083), but windowed on '
  'clusters.updated_at (default 14 days, never wider than 30), ordered by '
  'updated_at desc then id, excluding archived and merged-away clusters. Returns '
  '(id, total): total is the full match count in the window, before the LIMIT '
  '(p_limit clamped to 1..50, default 20). The caller runs a separate '
  '.in(''id'', ids) embed select for just the returned ids. service_role only.';

revoke all on function public.entity_cluster_ids(text[], timestamptz, integer) from public, anon, authenticated;
grant execute on function public.entity_cluster_ids(text[], timestamptz, integer) to service_role;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('123', '123_entity_cluster_ids')
  on conflict do nothing;

commit;
