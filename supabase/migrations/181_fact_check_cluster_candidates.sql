-- 181_fact_check_cluster_candidates.sql
--
-- h87-factchecks-1 (hunt 87, 2026-11-09). One new function, public.fact_check_cluster_candidates(p_query, p_gte, p_lte,
-- p_limit), and nothing else: the clusters that /api/cron/fact-checks scores against a fact-check, returned most relevant
-- first instead of largest first. Additive: no table, column, index, trigger, cron job, grant outside the new function, no
-- change to an existing function, and no data change. The only row it writes is its ledger row.
-- tests/migrations/181-fact-check-cluster-candidates.test.ts pins all of it.
--
-- WHY
--   The cron (src/app/api/cron/fact-checks/route.ts, step 4) searched clusters.search_tsv with the fact-check title's
--   words joined by OR (buildFtsQuery: six words), kept the clusters of the window (not archived, article_count >= 2,
--   updated_at >= published - 7 days, first_published <= published + 2 days) and cut them with
--   order by article_count desc limit 25. An OR query over six common words matches hundreds of clusters, and the 25
--   largest are the big stories that share one word, not the small cluster about the very same event. The matcher
--   (src/lib/fact-checks/match.ts) never saw the right cluster. Two exact matches were lost this way:
--     Teyit f8a58b4b, 2026-10-09, "Peru'da Hitler Mussolini adlı bir aday belediye başkanı seçildi": 315 clusters match
--       the query; the cluster 506da2d9 ("Sol aday Hitler Mussolini Peru'da yerel seçimi kazandı", 4 articles) is #139
--       by article_count and #1 by ts_rank_cd (1.2). The fact-check has four shadow links, all to unrelated clusters.
--     Teyit 28f0f694, 2026-10-14, "Sosyal medyada yaşa takılanlar: Yaş kısıtlaması Resmi Gazete'de": the cluster 903f9541
--       ("Resmi Gazete'de yayımlandı: Sosyal medyada 15 yaş Şartı", 3 articles) is outside the 25 largest and #1 by rank.
--   Both pairs score publish in match.ts (0.8 with 5 distinct terms, and 0.7 with 3), so the fault is retrieval only.
--
-- WHAT
--   public.fact_check_cluster_candidates(p_query text, p_gte timestamptz, p_lte timestamptz, p_limit integer default 25)
--     returns table (id uuid, title_tr text, title_tr_neutral text); language sql, stable, security definer,
--     set search_path = ''. The same filters as the old query, the same websearch tsquery on search_tsv (the 035 column,
--     so clusters_search_tsv_live_idx still serves the match), and a new order: pg_catalog.ts_rank_cd(search_tsv, query)
--     desc, then article_count desc, then id (a stable tie-break). p_limit is clamped to 1..50 and a null means 25.
--   The three columns are the ClusterCandidateRow of the route, so the member fetch and the matcher run as before. The
--   route keeps CLUSTER_CANDIDATE_LIMIT = 25 (the member fetch's limit(1000) stays enough) and does not change
--   PUBLISH_MIN_SCORE, SHADOW_MIN_SCORE, MIN_MATCHED_TERMS, MAX_CLUSTERS_PER_FACT_CHECK or MATCH_METHOD.
--   Access is the convention of 125, 156, 170 and 179: SECURITY DEFINER with an empty search_path (every relation and
--   function schema-qualified, the config as 'pg_catalog.turkish'::pg_catalog.regconfig), execute revoked from public, anon
--   and authenticated (Supabase grants EXECUTE to anon and authenticated at creation, so all three are named) and granted
--   to service_role only. The route reaches it with the service-role client. One transaction, lock_timeout 5s, ledger row last.
--
-- STEP 0 (read-only, production, 2026-11-09)
--   pg_proc: no function named fact_check_cluster_candidates. Ledger: 172 to 179 applied, nothing above. PostgreSQL 17.6.
--   clusters: 265,523 rows, 32,545 with article_count >= 2 and not archived. search_tsv is a generated column,
--   to_tsvector('turkish', title_tr_neutral || ' ' || title_tr || ' ' || summary_tr). Indexes used: clusters_search_tsv_live_idx
--   (gin, where not is_archived and article_count >= 2, 083), clusters_search_tsv_idx (gin, 035). Owner postgres,
--   relacl {postgres=arwdDxtm/postgres, service_role=arwdDxtm/postgres}.
--
-- REPLAY (read-only, production, 2026-11-09 ~00:30Z; the function body run as one plain SELECT per fact-check with the
--   parameters substituted, through a read-only transaction; the scratch harness is outside the repo). Every fact-check with
--   published_at >= 2026-09-22 (226; one has an empty query and the route skips it, so 225), p_query as the route builds it
--   from the title (RSS categories are not stored and are left out), p_gte = published - 7 days, p_lte = published + 2 days,
--   p_limit 25, each pool scored with the real match.ts (keyword-v2) and rankMatches. The old pool is order by article_count
--   desc limit 25 over the same filters.
--   Publish decisions: old pool 4, new pool 12, in both 3.
--   Pairs that publish in the new pool and have NO cluster_fact_checks row, six (none has a stored shadow row either):
--     f8a58b4b Peru Hitler Mussolini   -> 506da2d9 (4 articles) relevance rank 1, score 0.8, 5 distinct terms
--     28f0f694 Resmi Gazete yaş sınırı -> 903f9541 (3 articles) rank 1, score 0.7;  c7e92eb9 (2 articles) rank 3, score 0.7
--     ff371672 Fransa öğrenci eylemleri -> 4bab0aec (2 articles) rank 2, score 0.75 (a twin of the published 34787e03)
--     601b96b2 Panama deprem           -> 7c644c1d (2 articles) rank 2, score 0.6 ("6.1 büyüklüğünde", an aftershock of the
--                                         sequence the published pair is about)
--     29c5930e Iran/ABD uçak gemisi belgesel -> 087390a8 (2 articles) rank 1, score 0.6, 3 distinct terms (gorun, iran, abd,
--                                         vurdu): NOT in the five the finding expected. See OPEN POINTS.
--   Rank (position in the new order, of 25) of the pairs that are published today:
--     NASA 2eec34a0 1; Rusya 1b427672 2; Fransa 34787e03 3; Panama b789fa23 5; Panama 0fdb8c08 9; Okul 7b68e915 10.
--     (the four keyword-v1 rows of the 2026-11-05 audit, wrong on topic and in shadow under v2: Tugay 2df57b90 4, Fidan
--     cc57f5f6 2 and 9a0d12b4 22, 26e48fc5 outside the 25.)
--     Doğu Akdeniz d2b6332c (an on-topic published row) is outside the 25 in the new order (position 3 in the old one):
--     the order ranks the cluster's own title, neutral title and summary, while the matcher also reads the member titles.
--   Publish decisions of the old pool that the new pool loses: that one, d2b6332c.
--
-- OPEN POINTS (the replay gate of the finding: any publish beyond the expected five is to be reported, not shipped)
--   1. 087390a8 is a sixth new publish. The cluster is about satellite images of the damage to US bases from Iran's strikes;
--      the fact-check is about a viral clip said to show an Iranian strike on a carrier, taken from a documentary. Same war,
--      not the same claim, and the match rests on three generic stems. A wrong box is worse than none (docs/fact-checks.md).
--   2. d2b6332c would not be re-found by a fresh run, and the cron never unpublishes, so the live link stays.
--   Neither is a property of this function (the matcher decides, thresholds are untouched); they are what a relevance cut
--   of 25 does with the current matcher.
--   3. RESOLVED IN THE ROUTE, not here (SEC-factcheck-autopublish-fp-1): a pair that comes from this function needs
--      score >= 0.7 (RPC_PUBLISH_MIN_SCORE in src/app/api/cron/fact-checks/route.ts) to auto-publish. A lower 'publish'
--      decision of match.ts, like 087390a8 at 0.6, is written as a shadow row (is_published false) for admin review, and the
--      cron never promotes it. True 0.6 matches (the live Panama and Rusya rows) are held for review the same way.
--      Review the held rows with:
--        select cluster_id, fact_check_id, score, matched_terms from cluster_fact_checks
--          where method = 'keyword-v2' and decided_by = 'auto' and not is_published and score >= 0.6 order by created_at desc;
--      Promote or unpublish with the operator SQL of docs/fact-checks.md (Ops notes: update ... set is_published, decided_by =
--      'admin'). The function body is unchanged.
--
-- COST (read-only, EXPLAIN ANALYZE, TIMING OFF, the body as a SELECT): the Peru call 271 ms cold (2,019 buffers read), then
--   16.2 and 17.6 ms; plan: Bitmap Index Scan on clusters_search_tsv_live_idx (2,640 entries), Bitmap Heap Scan (315 rows
--   after the window filters), top-N heapsort. The same body as a prepared statement with force_generic_plan (the function
--   is not inlined: SECURITY DEFINER and a SET clause) is the same plan, 22.9 ms. Slowest shapes seen: 101 ms (Iran/ABD,
--   415 rows) and 169 ms (Resmi Gazete, 277 rows). ts_rank_cd is computed only for the rows of the window (a few hundred).
--   Far inside the 8 s statement_timeout; the cron calls it once per recent fact-check, at most 40 times an hour.
--
-- ORDER: APPLY this file any time (supabase db push, or post the SQL). The route in the same change calls the function and,
--   when PostgREST answers PGRST202 or 42883 (the function is missing), logs once per run and falls back to the old query,
--   so deploying before applying cannot break the cron; the new order takes effect on the first run after the apply.
--   No backfill: the cron re-matches only fact-checks of the last 3 days (RECENT_WINDOW_DAYS), so the Peru and Resmi Gazete
--   pages do not gain a box retroactively; a fact-check older than that is never scored again, and nothing is unpublished.
--
-- VERIFY (read-only):
--   select p.proname, pg_get_function_identity_arguments(p.oid), p.provolatile, p.prosecdef, p.proconfig::text
--     from pg_proc p where p.proname = 'fact_check_cluster_candidates'; one row: (p_query text, p_gte timestamp with time zone,
--     p_lte timestamp with time zone, p_limit integer) s t {search_path=""}.
--   select has_function_privilege('anon', 'public.fact_check_cluster_candidates(text,timestamptz,timestamptz,integer)',
--     'execute'), the same for 'authenticated' (false) and 'service_role' (true).
--   select * from public.fact_check_cluster_candidates('hitler or mussolini or peru or adlı or aday or belediye',
--     '2026-10-02 13:35+00', '2026-10-11 13:35+00'); 25 rows, 506da2d9-f558-42d9-afcf-ca476f9aeac9 first (as long as the cluster
--     is in the window).
--   select version, name from supabase_migrations.schema_migrations where version = '181'; returns one row.
--   After the next hourly run: ops_cron_route_runs has a 200 row for 'fact-checks' with substepErrors 0, and
--   select count(*) from cluster_fact_checks where created_at > '<apply time>'; shows the new links.
--
-- ROLLBACK: drop function public.fact_check_cluster_candidates(text, timestamptz, timestamptz, integer);
--   then remove the ledger row (version = '181' in supabase_migrations.schema_migrations). The route falls back to the old
--   size-ordered query by itself. Links written while 181 was applied stay (the cron never unpublishes).

begin;

set local lock_timeout = '5s';

create or replace function public.fact_check_cluster_candidates(
  p_query text,
  p_gte timestamptz,
  p_lte timestamptz,
  p_limit integer default 25
)
returns table (id uuid, title_tr text, title_tr_neutral text)
language sql
stable
security definer
set search_path = ''
as $fn$
  select c.id, c.title_tr, c.title_tr_neutral
  from public.clusters c
  cross join lateral (select pg_catalog.websearch_to_tsquery('pg_catalog.turkish'::pg_catalog.regconfig, p_query) as q) w
  where c.is_archived = false
    and c.article_count >= 2
    and c.updated_at >= p_gte
    and c.first_published <= p_lte
    and c.search_tsv @@ w.q
  order by pg_catalog.ts_rank_cd(c.search_tsv, w.q) desc, c.article_count desc, c.id
  limit least(greatest(coalesce(p_limit, 25), 1), 50)
$fn$;

comment on function public.fact_check_cluster_candidates(text, timestamptz, timestamptz, integer) is
  'Candidate clusters for /api/cron/fact-checks (migration 181, h87-factchecks-1): the non-archived clusters with at least 2 '
  'articles, updated at or after p_gte and first published at or before p_lte, whose search_tsv matches the websearch tsquery '
  'p_query (turkish), most relevant first (ts_rank_cd desc, then article_count desc, then id), at most p_limit of them '
  '(null means 25, clamped to 1..50). Replaces the old order by article_count desc limit 25, which kept the largest clusters '
  'that share one word and lost the small cluster about the same event. Returns id, title_tr and title_tr_neutral, the '
  'columns the route needs. Read-only; service_role only.';

revoke all on function public.fact_check_cluster_candidates(text, timestamptz, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.fact_check_cluster_candidates(text, timestamptz, timestamptz, integer) to service_role;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name) values ('181', '181_fact_check_cluster_candidates') on conflict do nothing;

commit;
