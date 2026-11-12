-- 206_entity_cluster_days.sql
--
-- /gundem/<key> prints "Son 14 günde N küme" and the summed source mix of the 20 clusters it lists, and nothing that says how those N
-- clusters spread over the 14 days (h154-hub-trend, hunt 154, roadmap "Next up" #1, 2026-11-12). One function CREATED,
-- public.entity_cluster_days(p_queries text[], p_patterns text[], p_since timestamptz default null, p_headline_only boolean default
-- false): the hub's own match, the WHERE clause of 199's entity_cluster_ids_v4 copied character for character, counted per Istanbul
-- day of first_published. It returns 15 rows: the 14 Istanbul days ending today, oldest first, a day without a cluster as a row with 0,
-- and one last row with day null that counts the matched clusters first published before the oldest of those days. Read-only
-- (language sql, stable): no table, column, index, trigger or data change, no backfill, no UPDATE. entity_cluster_ids_v3 and
-- entity_cluster_ids_v4 are not touched, dropped or replaced. tests/migrations/206-entity-cluster-days.test.ts pins all of it,
-- including "its WHERE clause is 199's".
--
-- WHY (production, read-only, 2026-11-12 about 09:50 TRT): the per-day series that already exists, trends_daily_entity_counts_ist_rollup
-- (112, refreshed by 163 and 182), is not an honest series for this chart.
--   1. It counts a different thing: headline articles, not clusters. erdogan on 11 Kas: rollup 294, hub 51 clusters. Over the 14 days
--      the rollup holds 2,516 headlines and the hub says 457 clusters.
--   2. Its basis changes inside the window. Neither 163 nor 182 was backfilled, so each day keeps the basis of its last refresh: 30 Eki and
--      1 Kas the 112 body (all categories, no guards), 2-3 Kas 163 (guards, all categories), 31 Eki and 4-12 Kas 182 (politics only).
--      iran, 30 Eki to 8 Kas: rollup 93, 20, 124, 157, 178, 100, then 48, 16, 12, 14; the 31 Eki value (20) sits between two old-basis
--      days, a code change drawn as news. The hub-cluster series for the same days is 6, 8, 11, 16, 9, 21, 15, 4, 4, 4.
--   3. 191 is unapplied, so the rollup counts "Mehmet Şimşek" only, and the hub also matches "Bakan Şimşek". simsek, 10-12 Kas: rollup 0, 0, 0,
--      hub 3, 2, 4; over the 14 days rollup 22, hub 33. The matchers differ too: the rollup reads titles only, the hub reads the title
--      plus the first line of the summary with its requires and excludes. tcmb: rollup 25 on 30 Eki and 0 on 9 of the last 10 days, the
--      hub has 1 cluster. Points 1, 3 and 4 do not age out of the window.
--   The honest series is "hub clusters per Istanbul day of first_published". It needs the hub's exact predicate (the folded-text regex
--   `~ any(p_patterns)` with look-ahead and look-behind, plus the tsquery): PostgREST filters cannot express it, and the existing RPCs return
--   at most 50 ids. The chart does not depend on 191.
--
-- THE RULE
--   One CTE m holds the Istanbul date of first_published of every cluster the hub matches (the WHERE below, once). One CTE w holds the 14 days
--   ending today in Istanbul time. The first select counts m per day over w with a left join (zero days included), the second counts the
--   matched clusters older than the oldest day into one row with day null, and the result is ordered by its first column with the
--   null row last. No ORDER BY first_published, no LIMIT, no OFFSET: the hub's N is the sum of the 15 rows. first_published is NOT NULL
--   (003). Every reference is qualified (m.d, w.day). The app never passes p_since, so the 14-day window on updated_at is SQL's default,
--   as for the hub.
--
-- STEP 0 -- the body this migration copies its WHERE from (production, read-only, 2026-11-12 about 09:50 TRT)
--   select proname, md5(prosrc), length(prosrc), proconfig::text, proacl::text, prosecdef
--     from pg_proc where pronamespace = 'public'::regnamespace and proname like 'entity_cluster_%';
--   select pg_get_functiondef('public.entity_cluster_ids_v4'::regproc);
--   -> entity_cluster_ids_v4 md5 364c7c7d99da7c27b42dc9673319ac14, 1174 characters, prosecdef t, proconfig {search_path=""},
--      proacl {postgres=X/postgres,service_role=X/postgres}: the body of 199, character for character; its WHERE clause below is read from
--      the live definition and equals 199's.
--   -> entity_cluster_ids_v3 bc1ea39f547ca8d6810833f12c7bd983/1117 is untouched (170).
--   There is no entity_cluster_days in pg_proc yet. If a later release changes the prosrc of v4, compare again before applying.
--
-- REPLAY (production, read-only, 2026-11-12 about 09:50 TRT; this body inline as a plain SELECT with the app's exact p_queries and
-- p_patterns, one statement per hub; 15 rows each time: 14 dated days and 1 row for earlier first reports). Days are 30 Eki -> 12 Kas.
--   erdogan      34 26 11 29 30 19 19 27 19 32 49 58 51 12 -> 416 + 41 earlier = 457 (the live page says "Son 14 günde 457 küme")
--   akp          13 10 8 16 30 9 10 8 15 13 10 15 20 3 -> 180 + 2 = 182 (p_headline_only true)
--   ozgur-ozel   6 4 5 7 11 9 9 8 12 7 5 2 4 3 -> 92 + 5 = 97
--   iran         6 8 11 16 9 21 15 4 4 4 13 13 11 5 -> 140 + 8 = 148
--   simsek       0 0 0 0 5 1 11 3 4 0 0 3 2 4 -> 33 + 0 (the live page said 32 a few minutes earlier)
--   tcmb         1 cluster in the window: the sparse state of the chart
--   The body of THIS file (read from the file, the four parameters replaced by the app's literals) was replayed again later on 2026-11-12 for
--   the same six keys: 15 rows each, 14 days oldest first (30 Eki -> 12 Kas) and the day-null row last, the series above up to the live
--   drift (the running day grew by one on erdogan, akp and simsek; erdogan's earlier row went from 41 to 38 as the 14 x 24 h window on
--   updated_at moved), and for every hub the sum of the 15 rows equals max(total) of the live entity_cluster_ids_v3 for the same arrays in
--   the same statement: erdogan 455, akp 183, ozgur-ozel 97, iran 148, simsek 34, tcmb 1.
--
-- COST (EXPLAIN ANALYZE of the INLINE body, custom plan with the literal arrays, warm, all buffers hit): erdogan 51 ms, akp 21 ms,
-- ozgur-ozel 14 ms, iran 13 ms, simsek 4.7 ms; planning about 5 ms. These are the inline (custom-plan) numbers, not the cost of the call.
-- On Postgres 17.6 a SQL function that is not inlined (this one is SECURITY DEFINER) is planned without its argument values: a generic
-- plan. EXPLAIN (GENERIC_PLAN) of this WHERE shows a Bitmap Heap Scan on clusters_search_tsv_live_idx alone, with updated_at in the Filter
-- and no BitmapAnd with idx_clusters_updated_at. So the call reads every lifetime text-search match of the hub, not only the 14-day ones:
-- erdogan about 4,050 lifetime matches against 510 in the window, 4,925 buffers against 668 inline. entity_cluster_ids_v3 has the same
-- WHERE and is also a function; it measured 69 ms warm and about 1.2 to 2.1 s cold for erdogan (2,054 ms with 2,873 blocks read on
-- 2026-11-12). That is under the 4 s reader cap but not far under it, and it grows with the hub's lifetime match count. On a cold page-1
-- refill this call and the v3 list read run in parallel. It is answered once per hub per cache lifetime (about 5 minutes) and bounded to
-- the 62 hub keys. After the deploy, watch the mean and max time of entity_cluster_days next to entity_cluster_ids_v3 in
-- pg_stat_statements.
--
-- DEPLOY
--   Apply 206 first, then deploy the app (docs/migration-guide.md: an RPC the app calls is applied before the deploy). The reverse order is
--   safe: until 206 is applied PostgREST answers PGRST202 for entity_cluster_days, the app (src/lib/entities/hub-trend-query.ts) treats that
--   as "chart unavailable" and draws nothing, page 1 of a hub never depends on it, and that state is cached for minutes only, so the chart
--   appears within minutes of applying 206.
--
-- VERIFY (read-only, after applying)
--   select md5(prosrc), length(prosrc) from pg_proc where oid = 'public.entity_cluster_days(text[], text[], timestamptz, boolean)'::regprocedure;
--   -> 8af79e4bf68de3cae33f06f64db0a8e1, 1458 (this file's body; entity_cluster_ids_v4 stays 364c7c7d99da7c27b42dc9673319ac14, 1174 and v3 bc1ea39f547ca8d6810833f12c7bd983, 1117)
--   select has_function_privilege('anon', 'public.entity_cluster_days(text[], text[], timestamptz, boolean)', 'execute'),
--          has_function_privilege('authenticated', 'public.entity_cluster_days(text[], text[], timestamptz, boolean)', 'execute'),
--          has_function_privilege('service_role', 'public.entity_cluster_days(text[], text[], timestamptz, boolean)', 'execute');
--   -> false, false, true
--   a sample call on ozgur-ozel, and the hub's own count for the same arrays:
--   select count(*), sum(clusters) from public.entity_cluster_days(array['özgür özel'], array['\mozgur\s+ozel'], null, false);
--   select max(total) from public.entity_cluster_ids_v3(array['özgür özel'], array['\mozgur\s+ozel'], null, 50, false);
--   -> 15 rows, and their sum (the 14 days plus the row with day null) equals max(total) of v3 for the same arrays (97 on 2026-11-12).
--   Then, one request per second, GET /gundem/ozgur-ozel shows "Günlere göre küme sayısı" and one role="img"; ?sayfa=2 does not.
--
-- ROLLBACK (the app does not care whether entity_cluster_days exists)
--   drop function public.entity_cluster_days(text[], text[], timestamptz, boolean);
--   delete from supabase_migrations.schema_migrations where version = '206';
--   The chart falls back to nothing on PGRST202 by itself; v3 and v4 are not part of this migration and are not touched by the rollback.
--
-- NUMBER
--   197 and 202 are reserved (held by migrations of other branches) and 205 is the newest on this branch: 206 is the next free number after
--   them, and the chain has deliberate gaps (no guard requires a contiguous chain).
--
-- Access is 199's: SECURITY DEFINER, empty search_path (every relation and function schema-qualified), execute revoked from public,
-- anon and authenticated and granted to service_role only. No table grant.

begin;

set local lock_timeout = '5s';

create or replace function public.entity_cluster_days(
  p_queries text[],
  p_patterns text[],
  p_since timestamptz default null,
  p_headline_only boolean default false
)
returns table (day date, clusters bigint)
language sql
stable
security definer
set search_path = ''
as $fn$
  with m as (
    select (c.first_published at time zone 'Europe/Istanbul')::date as d
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
  ),
  w as (
    select (pg_catalog.now() at time zone 'Europe/Istanbul')::date - g as day
    from pg_catalog.generate_series(0, 13) as g
  )
  select w.day, pg_catalog.count(m.d)::bigint from w left join m on m.d = w.day group by w.day
  union all
  select null::date, pg_catalog.count(*)::bigint from m where m.d < (select pg_catalog.min(w.day) from w)
  order by 1 nulls last;
$fn$;

comment on function public.entity_cluster_days(text[], text[], timestamptz, boolean) is
  'Clusters per Istanbul day of first_published for a curated entity hub '
  '(migration 206, h154-hub-trend). The match is entity_cluster_ids_v4''s: the stemmed prefilter on p_queries, '
  'the regex guard on p_patterns, p_headline_only, the live-cluster predicate and the 14-day window (never wider than 30). '
  '15 rows: 14 Istanbul days ending today, oldest first, zero included, then one row with day null for clusters first published earlier; '
  'the 15 rows sum to the hub''s total. Caller: src/lib/entities/hub-trend-query.ts for the chart on /gundem/[key] page 1, '
  'which treats PGRST202 as "chart unavailable". '
  'service_role only.';

revoke all on function public.entity_cluster_days(text[], text[], timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.entity_cluster_days(text[], text[], timestamptz, boolean) to service_role;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name) values ('206', '206_entity_cluster_days') on conflict do nothing;

commit;
