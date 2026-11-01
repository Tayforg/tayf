-- 135_cluster_title_key_idx.sql
--
-- One partial btree index on public.clusters and one SECURITY DEFINER read
-- function, for the cluster consumer's exact-title probe. Additive, one
-- transaction, no route change, no UI change, nothing granted to anon or
-- authenticated, no data written.
--   clusters_title_key_live_idx        (md5(tayf_search_fold(title_tr)), updated_at desc)
--                                      where not is_archived and merged_into is null
--   public.cluster_title_probe(p_title text, p_since timestamptz, p_limit integer)
--                                      the live clusters whose folded seed title is
--                                      the folded p_title, newest first, service_role only
--
-- WHY (hunt 12, finding h12-cluster-1, 2026-11-01). The consumer keeps the newest
-- CONTEXT_CLUSTER_CAP = 200 clusters by updated_at, plus a sticky tail of clusters
-- with at least 5 articles, in memory and scores each incoming article against
-- those only. A story that comes back with the IDENTICAL headline after the window
-- has moved on never meets its own singleton and opens a twin: Yusra Geyik,
-- cluster 53d92ca1 (posta, ingested 06:00) and cluster 217069e3 (cnn-turk, ingested
-- 09:42), both live singletons with the title 'Yusra Geyik takside beklerken, Nehir
-- Erdogan arka kapidan kacti' (written with its Turkish letters in the data), and
-- 269 clusters updated between the two. The cap stays 200: the context build
-- fingerprints seed and latest of every cluster on each cold invocation and a larger
-- cap trips the Edge Function compute limit (546 WORKER_RESOURCE_LIMIT, see the
-- comment above CONTEXT_CLUSTER_CAP in cluster-consumer/index.ts). So instead of a
-- bigger context the consumer asks the database, once per article and only when the
-- headline has at least 3 distinct tokens, for the live clusters updated in the last
-- 24 hours whose folded seed title equals the article's folded title, and loads
-- those (at most 3) into the context for that one decision. clusters.title_tr holds
-- the seed headline: createCluster writes title_tr = the first article's title, and
-- nothing else rewrites it (STEP 0 item 5).
--
-- STEP 0 -- read-only measurements on production (2026-11-01 ~16:30 UTC,
-- PostgreSQL 17.6). Every number here is observed, not assumed.
--
--   1. select p.proname, p.provolatile, p.proparallel, p.proacl::text, p.prosecdef
--      from pg_catalog.pg_proc p where p.pronamespace = 'public'::regnamespace and
--      p.proname = 'tayf_search_fold'   ->   provolatile 'i' (immutable), proparallel
--      's', proacl {postgres=X/postgres,service_role=X/postgres} (no anon, no
--      authenticated, no PUBLIC), prosecdef false. Migration 129's fold is therefore
--      legal in an index expression and executable by service_role only.
--
--   2. select column_name, data_type, is_nullable, column_default from
--      information_schema.columns where table_schema = 'public' and table_name =
--      'clusters' and column_name in (...):  article_count integer NOT NULL default 0;
--      first_published timestamp with time zone NOT NULL; id uuid NOT NULL default
--      gen_random_uuid(); is_archived boolean NOT NULL default false; merged_into uuid
--      NULL; title_tr text NOT NULL; title_tr_neutral text NULL; updated_at timestamp
--      with time zone NOT NULL default now(). The function's result columns are cast to
--      exactly those types (the consumer's ClusterRow shape).
--
--   3. select reltuples::bigint, relpages from pg_class where oid =
--      'public.clusters'::regclass  ->  259,134 / 50,930 (no count(*) over the table).
--
--   4. select count(*) from public.clusters where updated_at >= now() - interval '24
--      hours' and not is_archived and merged_into is null  ->  997 (returned in well
--      under 8 s). That is the whole population the probe ever has to look at.
--
--   5. Who writes clusters.title_tr (grep over src/ and supabase/): createCluster in
--      cluster-consumer/index.ts (title_tr = article.title, the seed headline);
--      migration 018 (one-time HTML-entity decode); migration 074 (an article-title
--      edit is copied to a cluster that inherited exactly the old headline). The
--      story_threads route that also updates 'title_tr' writes public.story_threads, a
--      different table. So the key changes only on those paths.
--
--   6. EXPLAIN (plain, no analyze) of the probe body on production BEFORE this index:
--        Limit  (cost=0.42..370.95 rows=1)
--          ->  Index Scan using clusters_active_updated_idx on clusters c
--                Index Cond: (updated_at >= (now() - '24:00:00'::interval))
--                Filter: ((merged_into IS NULL) AND (md5(tayf_search_fold(title_tr)) = '4b977f9a...'))
--      i.e. without 135 the probe is a walk of the ~1,000 entries of the last 24 h with
--      a heap visit and a fold per row. Not catastrophic, but cost-bound by the busiest
--      hours; the index turns it into 4 buffers (EXPLAIN section below).
--
--   7. pg_indexes for public.clusters (18 indexes): none is keyed on title_tr or on
--      tayf_search_fold(title_tr); clusters_search_fold_live_idx (129) is a GIN over the
--      folded text of title_tr_neutral, title_tr and summary_tr and cannot answer
--      equality. clusters_title_key_live_idx is free. select version from
--      supabase_migrations.schema_migrations where version in ('135','136','137')  ->  0
--      rows. (The ledger is supabase_migrations.schema_migrations.)
--
-- ORCHESTRATOR PRE-BUILD (run each standalone, outside a transaction, before applying 135)
-- Build the index with CREATE INDEX CONCURRENTLY so inserts into clusters keep
-- flowing; 135 then sees it and its own `create index if not exists` does nothing.
-- Run this first, outside any transaction block (use psql in autocommit):
--
--   create index concurrently if not exists clusters_title_key_live_idx on public.clusters (pg_catalog.md5(public.tayf_search_fold(title_tr)), updated_at desc) where not is_archived and merged_into is null;
--
-- A failed or cancelled CONCURRENTLY build leaves an INVALID index behind, and
-- `create index if not exists` would then skip it silently. Check before
-- applying (expect 0 rows):
--
--   select c.relname from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid = i.indexrelid where c.relname in ('clusters_title_key_live_idx') and not i.indisvalid;
--
-- 135 itself re-checks (indisvalid = false) and aborts with a message telling
-- you to `drop index concurrently <name>` and rebuild it.
--
-- If the pre-build was skipped, 135 builds the index inside its transaction. That
-- scans the whole 423 MB table under a SHARE lock that blocks writes to clusters, so
-- 135 starts with `set local lock_timeout = '5s'` and `set local statement_timeout =
-- '60s'`: a skipped pre-build that cannot finish in 60 s aborts the whole migration
-- with 57014 (query_canceled) instead of blocking ingest, and nothing is recorded in
-- the ledger. Build it concurrently and re-apply. A 55P03 (the 5 s lock_timeout) only
-- means the table was busy; re-apply.
--
-- WRITE COST. The index expression is evaluated for every live row that is inserted
-- or updated: one tayf_search_fold and one md5 (microseconds) plus one btree insert.
-- Rows that are archived or merged are not in the index, so archiving a cluster
-- removes its entry and costs nothing further. The extra btree insert is not new
-- traffic: updated_at is the leading or trailing key of several existing indexes, and
-- ingest and the cluster consumer move it on nearly every cluster write, so those
-- updates are already non-HOT (migration 127 measured 2.1% HOT updates, n_tup_hot_upd
-- 13,511 of n_tup_upd 638,062). The writers that run this expression with their own
-- privileges need EXECUTE on tayf_search_fold; service_role holds it (migration 129
-- grants it, STEP 0 item 1), and the SECURITY DEFINER functions and pg_cron jobs that
-- also update clusters run as the owner. The index itself is about 12 MB on 180k live
-- clusters (local proof below).
--
-- DRY RUNS x2 (local PostgreSQL 15.12, throwaway cluster, stub.sql plus 129's
-- tayf_search_fold verbatim and a merged_into column; 260,002 clusters seeded from the
-- 476 production titles in scratchpad/ana/all_clusters.json, repeated with a numeric
-- suffix and one in thirty left exact, 31.0% archived or merged = 80,491 rows, plus
-- the two Yusra clusters; 49 MB table, 6,273 pages; fold provolatile 'i', proacl
-- {postgres=X/postgres,service_role=X/postgres} as on production).
--   Pre-build: create index concurrently if not exists ... CREATE INDEX in 591 ms,
--       the invalid-index check returned 0 rows, index 12 MB on 179,511 live clusters.
--   Apply #1 (index already built, ledger had no row 135): BEGIN, SET, SET, DO,
--       NOTICE relation "clusters_title_key_live_idx" already exists, skipping,
--       CREATE INDEX, CREATE FUNCTION, COMMENT, REVOKE, GRANT, INSERT 0 1, COMMIT.
--   Apply #2: the same lines with INSERT 0 0 and the same "already exists, skipping"
--       notice; one ledger row for 135, one index, indisvalid true.
--   Rehearsals: with the index dropped and no pre-build, apply built it inside the
--       transaction (CREATE INDEX without the notice, 0.6 s on this table, ledger row
--       written). With the index forced to indisvalid = false and the ledger row
--       removed, apply stopped in step 0 with "135: invalid index left by an aborted
--       CREATE INDEX CONCURRENTLY: clusters_title_key_live_idx. Run drop index
--       concurrently <name>, then rebuild it ..." and the ledger stayed untouched
--       (0 rows for 135); restored, apply went through.
--   Privileges after apply: has_function_privilege('execute') is false for anon, false
--       for authenticated, true for service_role; as anon and as authenticated the call
--       fails with "permission denied for function cluster_title_probe"; proacl
--       {postgres=X/postgres,service_role=X/postgres}, prosecdef true, provolatile 's',
--       proconfig search_path="". Nothing is granted on any table.
--
-- EXPLAIN (local PostgreSQL 15.12, same data; the title is the Yusra headline, 2 live
-- hits).
--   Body with literals (explain analyze, buffers):
--       Limit (cost=0.42..3.79 rows=3) (actual time=0.022..0.023 rows=2)
--         -> Index Scan using clusters_title_key_live_idx on clusters c
--              Index Cond: ((md5(tayf_search_fold(title_tr)) = '4b977f9a...') AND
--              (updated_at >= (now() - '24:00:00'::interval)))   Buffers: shared hit=4
--       Execution Time: 0.027 ms.
--   Same body as a prepared statement with $1 = title, $2 = p_since, $3 = p_limit under
--   plan_cache_mode = force_generic_plan (the worst case: nothing is known at plan
--   time, which is also how a non-inlined sql function is planned):
--       Limit (cost=0.68..34.95 rows=31) (actual time=0.028..0.028 rows=2)
--         -> Index Scan using clusters_title_key_live_idx on clusters c
--              Index Cond: ((md5(tayf_search_fold(title_tr)) = md5(tayf_search_fold($1)))
--              AND (updated_at >= COALESCE($2, (now() - '24:00:00'::interval))))
--       Buffers: shared hit=4, Execution Time: 0.048 ms (0.020 ms on the second execute).
--   select * from public.cluster_title_probe('<the Yusra headline>')  ->  both clusters,
--   217069e3 first, 0.12 to 0.17 ms; an unknown headline  ->  0 rows in 0.14 ms.
--   The generic plan keeps the partial index because the predicate columns are written
--   as literals in the function body (not is_archived, merged_into is null).
--
-- VERIFY (read-only, after applying):
--   1. select pg_catalog.has_function_privilege('anon', 'public.cluster_title_probe(text,timestamptz,integer)', 'execute'), pg_catalog.has_function_privilege('authenticated', 'public.cluster_title_probe(text,timestamptz,integer)', 'execute'), pg_catalog.has_function_privilege('service_role', 'public.cluster_title_probe(text,timestamptz,integer)', 'execute');
--      expect false, false, true.
--   2. explain (analyze, buffers) select c.id from public.clusters c where pg_catalog.md5(public.tayf_search_fold(c.title_tr)) = pg_catalog.md5(public.tayf_search_fold('<a headline of the last hour>')) and c.updated_at >= pg_catalog.now() - interval '24 hours' and not c.is_archived and c.merged_into is null order by c.updated_at desc limit 3;
--      expect Index Scan using clusters_title_key_live_idx, buffers in the single digits.
--   3. select count(*) from public.cluster_title_probe('<a headline of the last hour>');
--      expect at least 1 (the cluster that headline created).
--   4. After the cluster-consumer deploy: the function logs show no '[cluster-consumer]
--      cluster_title_probe failed' line (one such line per cold start means the rpc
--      errored: check this migration is applied and PostgREST has reloaded its schema
--      cache), and 'same-source-duplicate skip' lines appear for same-outlet repeats.
--
-- Safe to re-apply: create index if not exists, create or replace function, revoke and
-- grant are idempotent, ledger insert `on conflict do nothing`. Nothing is dropped,
-- analyzed or written.
--
-- ROLLBACK (the consumer degrades to "no probe" on an rpc error, so it can be
-- reverted in either order):
--   drop function if exists public.cluster_title_probe(text, timestamptz, integer);
--   drop index concurrently if exists clusters_title_key_live_idx;
--   delete from supabase_migrations.schema_migrations where version = '135';
--
-- See tests/migrations/135-cluster-title-key-idx.test.ts.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 0. Guard: a cancelled CREATE INDEX CONCURRENTLY leaves an INVALID index that
--    `create index if not exists` would silently accept.
-- ---------------------------------------------------------------------------

do $guard$
declare
  v_bad text;
begin
  select pg_catalog.string_agg(c.relname::text, ', ' order by c.relname)
    into v_bad
    from pg_catalog.pg_index i
    join pg_catalog.pg_class c on c.oid = i.indexrelid
   where c.relnamespace = 'public'::regnamespace
     and c.relname in ('clusters_title_key_live_idx')
     and i.indisvalid = false;
  if v_bad is not null then
    raise exception '135: invalid index left by an aborted CREATE INDEX CONCURRENTLY: %. Run drop index concurrently <name>, then rebuild it (see the ORCHESTRATOR PRE-BUILD block in the header of 135_cluster_title_key_idx.sql).', v_bad;
  end if;
end
$guard$;

-- ---------------------------------------------------------------------------
-- 1. The index. Key = md5 of the folded seed title (a fixed 32-character value,
--    so a long headline cannot hit the btree row-size limit), then updated_at
--    desc for the probe's "newest first, last 24 h". Partial on the live
--    predicate in the literal form of the probe's WHERE clause.
-- ---------------------------------------------------------------------------

create index if not exists clusters_title_key_live_idx
  on public.clusters (pg_catalog.md5(public.tayf_search_fold(title_tr)), updated_at desc)
  where not is_archived and merged_into is null;

-- ---------------------------------------------------------------------------
-- 2. The probe. SECURITY DEFINER (the consumer calls it with the service role
--    over PostgREST), search_path pinned to '' and every name qualified.
-- ---------------------------------------------------------------------------

create or replace function public.cluster_title_probe(
  p_title text,
  p_since timestamptz default null,
  p_limit integer default 3
)
returns table (
  id uuid,
  title_tr text,
  title_tr_neutral text,
  first_published timestamptz,
  updated_at timestamptz,
  article_count integer
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select c.id, c.title_tr, c.title_tr_neutral, c.first_published, c.updated_at, c.article_count
    from public.clusters c
   where pg_catalog.md5(public.tayf_search_fold(c.title_tr)) = pg_catalog.md5(public.tayf_search_fold(p_title))
     and c.updated_at >= coalesce(p_since, pg_catalog.now() - interval '24 hours')
     and not c.is_archived and c.merged_into is null
   order by c.updated_at desc
   limit least(greatest(coalesce(p_limit, 3), 1), 5)
$fn$;

comment on function public.cluster_title_probe(text, timestamptz, integer) is
  'Exact-title probe of the cluster consumer (migration 135, hunt 12 finding '
  'h12-cluster-1): the live clusters (not archived, not merged) updated since '
  'p_since (default: the last 24 hours) whose folded seed title equals the folded '
  'p_title, newest first, at most p_limit (clamped to 1..5). Fold = '
  'tayf_search_fold (migration 129). Served by clusters_title_key_live_idx. '
  'Execute for service_role only.';

revoke all on function public.cluster_title_probe(text, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.cluster_title_probe(text, timestamptz, integer) to service_role;

insert into supabase_migrations.schema_migrations (version, name)
  values ('135', '135_cluster_title_key_idx')
  on conflict do nothing;

commit;
