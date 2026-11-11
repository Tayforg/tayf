-- 199_entity_cluster_ids_v4_offset.sql
--
-- /gundem/<key> lists only the newest 20 of the clusters a hub matches and has no way past them (h136-roadmap-2, hunt 136,
-- 2026-11-11). One function CREATED, public.entity_cluster_ids_v4(text[], text[], timestamptz, integer, boolean, integer): its
-- body is 170's entity_cluster_ids_v3 body (production's, md5 pinned below) with ONE added clause, an OFFSET after the LIMIT,
-- read from the new last argument p_offset. The argument defaults to 0, so a call that leaves it out, or passes 0 or NULL,
-- returns what v3 returns for the same first five arguments. entity_cluster_ids_v3 is not touched, dropped or replaced: it is the
-- read of page 1 of every hub and stays so. No table, column, index, trigger or data change, no backfill, no UPDATE.
-- tests/migrations/199-entity-cluster-ids-v4-offset.test.ts pins all of it, including "the body is 170's with that single
-- clause".
--
-- WHY
--   v3 ends in `limit greatest(1, least(coalesce(p_limit, 20), 50))` and takes no offset, and the page of /gundem/[key] shows 20
--   (ENTITY_HUB_LIMIT) under a note that says "Son 14 günde 422 küme · en yeni 20 tanesi listeleniyor". GET /gundem lists 58 hubs,
--   and 28 of them have more than 20 clusters in the 14-day window (production, read-only, 2026-11-11 20:30Z): erdogan 452, abd 418,
--   meclis 247, israil 211, akp 184, trump 182, chp 152, iran 144, mhp 106, ozgur-ozel 102; 2,468 hub entries in total are unreachable
--   from their hub. GET /gundem/chp?sayfa=2 returned 200 with the identical 20 ids and the canonical /gundem/chp: the copy is honest, but
--   there is no way past the first 20 of a roadmap item that promises "every cluster mentioning ...". With the offset the page can say
--   ?sayfa=N: src/app/gundem/[key]/page.tsx, src/lib/entities/entity-hub-query.ts and entity-hub.ts, the same pager /konu/[slug] has.
--
-- THE RULE
--   v4 is v3 plus `offset greatest(0, least(coalesce(p_offset, 0), 1000))` after the limit clause. Everything else is v3's byte for
--   byte: the prefilter (the stemmed tsquery on search_tsv), the headline-only switch, the folded regex guard, the 083 partial-index
--   predicate (not is_archived, article_count >= 2, merged_into is null), the 14/30-day window on updated_at, the order
--   (first_published desc, id: a total order, so two pages never overlap), the 1..50 limit clamp, and `total`, which is
--   `count(*) over ()`. A window function is evaluated before LIMIT and OFFSET, so total still counts the whole filtered set on every
--   row of every page. The offset is clamped to 0..1000 and NULL reads as 0. A hub shows at most 1020 rows (51 pages of 20,
--   ENTITY_HUB_MAX_ROWS in the app): the last page starts at the clamp, and the app never calls v4 for a later page, so a clamped
--   offset is never answered for a page that was not asked for.
--
-- STEP 0 -- the body this migration starts from (production, read-only, 2026-11-11 ~20:40Z)
--   select proname, md5(prosrc), length(prosrc), proconfig::text, proacl::text, prosecdef, provolatile
--     from pg_proc where pronamespace = 'public'::regnamespace and proname like 'entity_cluster_ids%';
--   -> entity_cluster_ids    md5 09d046087512c7927f498b1b0175cfcc, 872 characters (123, untouched)
--   -> entity_cluster_ids_v2 md5 81be59e839f81c6e738e32a658c2a8eb, 884 characters (156, untouched)
--   -> entity_cluster_ids_v3 md5 bc1ea39f547ca8d6810833f12c7bd983, 1117 characters, prosecdef t, provolatile s,
--      proconfig {search_path=""}, proacl {postgres=X/postgres,service_role=X/postgres}, arguments
--      (p_queries text[], p_patterns text[], p_since timestamptz default null, p_limit integer default 20, p_headline_only boolean
--      default false).
--   There is no entity_cluster_ids_v4. The md5 of the text between the dollar quotes of 170_entity_cluster_ids_headline_only.sql is
--   bc1ea39f547ca8d6810833f12c7bd983, 1117 characters: it equals the md5 of production's v3 body, so this file is built on the
--   current one. If a later release changes prosrc, compare again before applying.
--
-- REPLAY (production, read-only, 2026-11-11 ~20:45Z; this file's body and 170's inline as plain SELECTs with the app's exact
-- p_queries and p_patterns, one statement per hub so every page sees one window; the live v3 function returned the same ids and
-- the same order as 170's inline body for all three hubs)
--   hub      total  pages  page 1 of v4 (offset 0) = v3's 20 ids in order | pages disjoint | union = the matched set | past the end
--   chp        151      8  yes                                           | yes (151 = 151) | yes (151 = 151)      | offsets 160, 180, 200: 0 rows
--   akp        183     10  yes (p_headline_only true)                    | yes (183 = 183) | yes (183 = 183)      | offsets 200, 220: 0 rows
--   erdogan    453     23  yes                                           | yes (453 = 453) | yes (453 = 453)      | offsets 460, 480: 0 rows
--   Every non-empty page carried the same total, the pages concatenated in offset order equal the full ordered list, and the
--   short last pages hold 11, 3 and 13 rows. The totals differ from the finding's 152, 184 and 452 (20:30Z) by one cluster each,
--   the 14-day window having moved.
--
-- DEPLOY
--   Apply 199 first, then deploy the app (docs/migration-guide.md: an RPC the app calls is applied before the deploy). The reverse
--   order is safe but degraded: The app (src/lib/entities/entity-hub-query.ts) reads page 1 with v3 exactly as
--   today and a later page with v4 (p_offset = (page - 1) * 20, p_limit 20, the hub's p_headline_only). On PGRST202 (function not in
--   the schema cache, i.e. 199 unapplied) a later page resolves to an "unavailable" state: the page says "Bu sayfa şu an
--   gösterilemiyor" with a link to page 1 and is noindex, and nothing throws. Page 1 of a hub that has more than 20 clusters shows a
--   "Sonraki" link in the meantime; it leads there. The unavailable page is cached for a few minutes only, so a page heals soon
--   after 199 is applied. v3, v2 and v1 stay the page-1 fallback chain.
--
-- VERIFY (read-only, after applying)
--   select md5(prosrc), length(prosrc) from pg_proc where oid = 'public.entity_cluster_ids_v4(text[], text[], timestamptz, integer, boolean, integer)'::regprocedure;
--   -> 364c7c7d99da7c27b42dc9673319ac14, 1174 (this file's body; v3 stays bc1ea39f547ca8d6810833f12c7bd983, 1117)
--   select has_function_privilege('anon', 'public.entity_cluster_ids_v4(text[], text[], timestamptz, integer, boolean, integer)', 'execute'),
--          has_function_privilege('authenticated', 'public.entity_cluster_ids_v4(text[], text[], timestamptz, integer, boolean, integer)', 'execute'),
--          has_function_privilege('service_role', 'public.entity_cluster_ids_v4(text[], text[], timestamptz, integer, boolean, integer)', 'execute');
--   -> false, false, true
--   select count(*), max(total) from public.entity_cluster_ids_v4(array['chp'], array['\mchp\M'], null, 20, false, 20);
--   -> 20 rows and a total about 151 (the 2026-11-11 replay; the same call with p_offset 0 returns v3's 20 ids, and its ids are
--   disjoint from the 20 of offset 20); GET /gundem/chp?sayfa=2 then lists 20 /cluster ids that /gundem/chp does not.
--
-- ROLLBACK (the app does not care whether v4 exists)
--   drop function public.entity_cluster_ids_v4(text[], text[], timestamptz, integer, boolean, integer);
--   delete from supabase_migrations.schema_migrations where version = '199';
--   The later pages fall back to the "unavailable" state on PGRST202 by themselves. v3 is not part of this migration and is not
--   touched by the rollback.
--
-- NUMBER
--   197 is held by a migration of another branch; 196 and 198 exist. 199 is the next free number after them, and the chain has a
--   deliberate gap at 197 (no guard requires a contiguous chain).
--
-- Access is 170's: SECURITY DEFINER, empty search_path (every relation and function schema-qualified), execute revoked from public,
-- anon and authenticated and granted to service_role only. No table grant. The statements below repeat the comment, the revoke and
-- the grant of 170 for the new signature so the file stands on its own.

begin;

set local lock_timeout = '5s';

create or replace function public.entity_cluster_ids_v4(
  p_queries text[],
  p_patterns text[],
  p_since timestamptz default null,
  p_limit integer default 20,
  p_headline_only boolean default false,
  p_offset integer default 0
)
returns table (id uuid, total bigint)
language sql
stable
security definer
set search_path = ''
as $fn$
  select c.id, (pg_catalog.count(*) over ())::bigint
  from public.clusters c
  where c.search_tsv @@ pg_catalog.websearch_to_tsquery('pg_catalog.turkish'::pg_catalog.regconfig, pg_catalog.array_to_string(p_queries[1:12], ' or '))
    and (case when p_headline_only
              then pg_catalog.lower(pg_catalog.translate(coalesce(c.title_tr, '') || ' ' || coalesce(c.title_tr_neutral, ''), 'İIıŞşĞğÜüÖöÇçÂâÎîÛû', 'iiissgguuooccaaiiuu'))
              else pg_catalog.lower(pg_catalog.translate(coalesce(c.title_tr, '') || ' ' || coalesce(c.title_tr_neutral, '') || ' ' || pg_catalog.split_part(coalesce(c.summary_tr, ''), E'\n', 1), 'İIıŞşĞğÜüÖöÇçÂâÎîÛû', 'iiissgguuooccaaiiuu'))
         end) ~ any (pg_catalog.array_remove(p_patterns[1:12], ''))
    and not c.is_archived      -- literal copy of the 083 partial-index predicate
    and c.article_count >= 2
    and c.merged_into is null
    and c.updated_at >= greatest(coalesce(p_since, pg_catalog.now() - interval '14 days'), pg_catalog.now() - interval '30 days')
  order by c.first_published desc, c.id
  limit greatest(1, least(coalesce(p_limit, 20), 50))
  offset greatest(0, least(coalesce(p_offset, 0), 1000));
$fn$;

comment on function public.entity_cluster_ids_v4(text[], text[], timestamptz, integer, boolean, integer) is
  'Precise newest-first cluster ids for a curated entity hub, one page at a time '
  '(migration 199, h136-roadmap-2). Same as entity_cluster_ids_v3 (migration 170) plus '
  'p_offset integer default 0, applied after the limit and clamped to 0..1000 (null reads as 0): '
  'p_offset 0 returns v3''s page, p_offset 20 with p_limit 20 the next 20, and total is still the '
  'full match count of every row (count(*) over () runs before limit and offset). The matching '
  '(stemmed prefilter on p_queries, regex guard on p_patterns, p_headline_only), the 14-day window '
  '(never wider than 30), the order (first_published desc, then id) and the limit clamp (1..50, '
  'default 20) are v3''s. Caller: src/lib/entities/entity-hub-query.ts for /gundem/[key]?sayfa=N '
  '(page 2 and later; page 1 reads v3), which treats PGRST202 as "page not available yet". '
  'service_role only.';

revoke all on function public.entity_cluster_ids_v4(text[], text[], timestamptz, integer, boolean, integer) from public, anon, authenticated;
grant execute on function public.entity_cluster_ids_v4(text[], text[], timestamptz, integer, boolean, integer) to service_role;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name) values ('199', '199_entity_cluster_ids_v4_offset') on conflict do nothing;

commit;
