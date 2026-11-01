-- 130_db_hot_paths.sql
--
-- Three DB hot paths, about 4.5k DB-seconds a day. Additive, one transaction,
-- no table grants, no data written. Hunt 10 (2026-11-01), findings
-- h10-dbhot-1 and h10-dbhot-2.
--   1. public.existing_source_content_hash_pairs(p_source_ids uuid[],
--      p_hashes text[]): a PAIRWISE probe replaces ingest's source x hash
--      cross product (supabase/functions/ingest/index.ts, the content-hash
--      prefilter, PostgREST's #1 statement by DB time).
--   2. cluster-topics-refresh splits into a 2 h job every 10 min plus a new
--      36 h job, cluster-topics-refresh-wide, hourly at :08.
--   3. The framing pool: jev_shadow_predictions_politics_conf_idx (a partial
--      index the refresh's recent_politics CTE can use) and an upsert guard
--      so unchanged pool rows are no longer rewritten every 5 min.
--
-- WHY. All figures are production, read-only, 2026-11-01 (PostgreSQL 17.6).
--
--   1. Content-hash prefilter. pg_stat_statements queryid 1909717669635125342
--      (since 2026-09-07): 682,486 calls, mean 164.8 ms, max 7,986 ms (the 8 s
--      statement_timeout), 112,475,044 ms in total. The caller runs once per
--      100-row PREFILTER_CHUNK:
--        select source_id, content_hash from articles
--         where source_id = any($1) and content_hash = any($2)
--      That is a source x hash CROSS PRODUCT: it probes
--      articles_source_content_hash_key for every source of the chunk times
--      every hash of the chunk (a drain chunk spans ~28-41 sources) and the
--      caller then keeps only the exact pairs. 100 real pairs from the last
--      40 min (41 sources, 100 hashes) gave 101 rows back, one of them a stored
--      pair that was not among the 100 asked for. A chunk that hits the 8 s
--      timeout silently skips the prefilter (prefilter_errors) and the rows fall
--      back to per-row 23505 handling.
--   2. cluster_topics_refresh. 073 widened cron.job 'cluster-topics-refresh'
--      (3-59/10 * * * *) to interval '36 hours': queryid -6698768392262014287,
--      4,200 calls, mean 14,993.1 ms, max 119,747 ms. The same function at its
--      default 2 h window (queryid -4534788681009065439, before 073) had 992
--      calls and a mean of 907.9 ms. A cluster still unlabelled after two hours
--      is rare, so 35 of every 36 hours the 10 minute job re-sweeps ground it
--      already covered.
--   3. Framing pool. queryid -2504668587660639973, public.framing_candidate_pool_
--      refresh(): 3,036 calls since 2026-10-22, mean 6,945.1 ms, max 23,307 ms.
--      Two causes. (a) The recent_politics CTE (105:118-126) walks
--      jev_shadow_predictions_task_created_idx (task, created_at desc) and
--      fetches every heap row of the 54 h window because jev_prob is not in
--      the index: 'Rows Removed by Filter: 13414', Buffers shared hit=1180
--      read=16828, 2,530 ms (EXPLAIN ANALYZE, hunt 10), against a heap of
--      2581 MB on an instance with a 256 MB shared_buffers. (b) The upsert's
--      'do update set ... refreshed_at = excluded.refreshed_at' rewrites every
--      pool row every tick: n_tup_upd 17,564,053 on a table of 5,308 rows. No
--      reader of refreshed_at exists in src/, supabase/functions or scripts.
--
-- DB-SECONDS PER DAY (before -> after)
--   content-hash prefilter  2,062 -> about 370   about 12.4k calls/day x < 30 ms
--   topics refresh          2,160 -> about 490   144 x 15.0 s becomes 144 x 0.91 s
--                                                + 24 x 15 s = 131 + 360
--   framing pool refresh    2,001 -> < 864       288 calls/day x the < 3 s target
--   total                   about 6.2k -> about 1.7k, i.e. about 4.5k DB-s a day
--   (A fresh read of the content-hash statement today gives 2,045 DB-s/day,
--   112,475 s over 55 days; the finding's 2,062 is the same rate over its own
--   window. The framing and topics "after" figures are targets from the local
--   proof below and the 2 h baseline, to be confirmed with VERIFY; the
--   content-hash figure is the measured 2 ms per chunk plus a 30 ms budget.)
--
-- STEP 0 -- read-only measurements on production, 2026-11-01 ~13:00 UTC.
--
--   a. The production definition of framing_candidate_pool_refresh() equals
--      105's, so 130's "create or replace" changes nothing but the upsert guard.
--      pg_get_functiondef('public.framing_candidate_pool_refresh()'::regprocedure),
--      body compared with 105:103-158 after whitespace normalisation: identical
--      (1,626 characters on both sides, and a token-by-token diff is empty).
--   b. cron.job: 'cluster-topics-refresh'  schedule '3-59/10 * * * *',
--      command ' select public.cluster_topics_refresh(interval ''36 hours''); '
--      (073). 'framing-candidate-pool-refresh'  schedule '*/5 * * * *', command
--      ' set statement_timeout = ''2min''; select public.framing_candidate_pool_refresh(); '
--      (105). 130 leaves the framing job alone.
--   c. EXPLAIN (ANALYZE, BUFFERS) of 100 (source_id, content_hash) pairs sampled
--      from articles created in the last 40 min (100 distinct hashes, 41 sources),
--      literal arrays, each shape run twice back to back:
--        old: where source_id = any('{...}'::uuid[]) and content_hash = any('{...}'::text[])
--          Index Only Scan using articles_source_content_hash_key on articles
--          run 1 (cold): Buffers shared hit=10692 read=1452 dirtied=16, 962.5 ms, rows=101
--          run 2 (warm): Buffers shared hit=12128, 26.4 ms, rows=101
--        new: from unnest('{...}'::uuid[], '{...}'::text[]) v(sid,h)
--             join public.articles a on a.source_id = v.sid and a.content_hash = v.h
--          Nested Loop, Function Scan on v, then 100 Index Only Scan loops
--          run 1: Buffers shared hit=502, 2.04 ms, rows=100
--          run 2: Buffers shared hit=502, 2.11 ms, rows=100
--      (Hunt 10's own measurement on another 100 pairs: old hit=7094 read=1134
--      746 ms cold and hit=8221 18.5 ms warm, new hit=501.) That is 16-24x
--      fewer buffers and, cold, about 470x less time.
--   d. pg_stat_statements (cumulative):
--        1909717669635125342   682,486 calls  mean 164.8 ms  max 7,986 ms  total 112,475,044 ms
--        -6698768392262014287    4,200 calls  mean 14,993.1 ms  max 119,747 ms  total 62,971,001 ms
--        -4534788681009065439      992 calls  mean 907.9 ms  max 5,910 ms  total 900,597 ms
--        -2504668587660639973    3,036 calls  mean 6,945.1 ms  max 23,307 ms  total 21,085,272 ms
--      (the two topics statements normalise to the same text apart from the
--      interval argument: 'select public.cluster_topics_refresh(interval $1)'
--      is the 36 h job, 'select public.cluster_topics_refresh()' the old 2 h
--      default). public.jev_shadow_predictions: heap 2581 MB, indexes 546 MB,
--      about 2.75M rows (pg_class.reltuples); task = 'politics' is about 350k
--      rows, and the planner estimates 41,222 of them with jev_prob >= 0.7 and
--      article_id is not null. The exact full-table count was not taken (it timed
--      out at 90 s on the cold 2.5 GB heap); the 54 h window holds 7,054 such
--      rows. So the partial index below has about 41k entries (a few MB).
--
-- KNOWN DELTA of the topics split. A late topic label (a cluster that is
-- still unlabelled more than 2 h after it moved) now lands within <= 60 min
-- (the wide job's next :08 slot) instead of <= 10 min. Clusters that moved in
-- the last 2 h are covered every 10 min as before. The function (067, last
-- redefined in 101) is NOT redefined here: same signature, same advisory lock
-- (hashtext('cluster_topics_refresh')), so the two jobs can never overlap; a
-- run that hits the advisory lock logs a notice and returns 0 (it skips).
-- The slots are 5 min apart (:03/:13/... and :08), a wide run takes about
-- 15 s (max 120 s seen), so a skipped run is not expected.
--
-- UPSERT GUARD. 'on conflict (article_id) do update set ... where
-- (framing_candidate_pool.title, framing_candidate_pool.published_at) is
-- distinct from (excluded.title, excluded.published_at)' makes the refresh
-- write only rows whose stored values changed, so refreshed_at now means "when
-- this row last changed" (the column comment says so). PostgreSQL still takes a
-- row lock on each conflicting row it then skips (a lock-only xmax on the heap
-- tuple, no new tuple version, no dead tuple, no index entry), so the saving is
-- the dead-tuple and index churn, not the visit.
--
-- LOCAL PROOF (PostgreSQL 15.12, throwaway cluster; stub.sql, then a scratch
-- seed kept outside the repo; 105 applied for real, then 130 applied twice).
-- Seed: 120 sources, 300,000 articles with a content_hash and the unique
-- (source_id, content_hash) constraint, a jev_shadow_predictions of 90,486 rows
-- (20,486 politics rows in the last 54 h of which 6,040 have jev_prob >= 0.7 and
-- an article_id, 30,000 older politics rows, 40,000 other tasks) with 061's two
-- indexes, 4,623 pool rows after 105's populate, shared_buffers 128 MB. Local
-- numbers are warm and the tables are 10-30x smaller than production
-- (jev_shadow_predictions: 90k rows against about 2.75M); compare the shapes
-- and the buffer counts, not the milliseconds.
--   1. Recent_politics CTE (105:118-126, literal 54 h window), BEFORE:
--        Index Scan using jev_shadow_predictions_task_created_idx, Filter on
--        article_id and jev_prob, Rows Removed by Filter: 14446, Buffers:
--        shared hit=20485, 3.2 ms.
--      AFTER 130: Index Only Scan using jev_shadow_predictions_politics_conf_idx,
--        Index Cond on created_at only, NO Filter and NO Rows Removed by Filter
--        line. Right after the bulk load (visibility map not yet set) Heap
--        Fetches 6040, Buffers shared hit=6003 read=31, 1.4 ms; vacuumed, as
--        autovacuum keeps it on production, Heap Fetches 0, Buffers shared
--        hit=32, 0.86 ms: 640x fewer buffers. The same Index Only Scan is what
--        auto_explain (log_nested_statements) shows INSIDE
--        framing_candidate_pool_refresh() with v_now as a plpgsql variable.
--   2. Upsert guard. BEFORE: one refresh run rewrote all 4,623 rows
--      (n_tup_upd delta 4,623). AFTER: the second consecutive run's n_tup_upd
--      delta is 0 (n_tup_ins 0, n_tup_del 0; the plan shows 'Rows Removed by
--      Conflict Filter: 4623'). Real changes still land: after editing one
--      article's title and another's published_at, the next run's n_tup_upd
--      delta is exactly 2 and only those two rows carry a newer refreshed_at.
--   3. existing_source_content_hash_pairs, 100 real pairs (61 sources). Plan
--      inside the function: Nested Loop, Function Scan on v, 100 Index Only Scan
--      loops on articles_source_content_hash_key, Buffers shared hit=400 (a first
--      cold-ish call hit=305 read=95). The old ANY x ANY shape for the same
--      pairs: Index Only Scan, Buffers shared hit=16984 read=1422, i.e. 46x more
--      buffers. With plan_cache_mode = force_generic_plan (what plpgsql switches
--      to after five custom plans when the generic one is not costlier) the plan
--      is still a Nested Loop with 100 index probes, Buffers hit=400.
--      Contract: 3 stored pairs asked as pairs return 3 rows; the cross-pair
--      (s1,h2) of two stored pairs returns 0 rows; empty arrays and (null, null)
--      return 0 rows; arrays of different length (2 vs 1, and 1 vs null) raise
--      22023; 500 elements are accepted and 501 elements raise 54000 (more than
--      500 pairs). anon and authenticated get 'permission denied for function';
--      service_role can call it. The function ACL is postgres and service_role
--      only, the same as framing_candidate_pool_refresh(); anon and authenticated
--      hold no table grant in the schema.
--      (First draft caught here: pg_catalog.unnest(a, b) fails with 'function
--      pg_catalog.unnest(uuid[], text[]) does not exist' -- the multi-array form
--      is parser syntax for the bare name unnest only. The body uses the bare
--      name, safe under search_path = '' because pg_catalog is always searched.)
--   4. Apply #1 (ledger had no row 130): BEGIN, SET, SET, DO, CREATE FUNCTION,
--      COMMENT, REVOKE, GRANT, NOTICE pg_cron not installed -- skipping
--      cluster-topics-refresh split (130), DO, CREATE INDEX, CREATE FUNCTION,
--      COMMENT, COMMENT, REVOKE, GRANT, NOTIFY, INSERT 0 1, COMMIT. Apply #2:
--      the same plus NOTICE relation "jev_shadow_predictions_politics_conf_idx"
--      already exists, skipping, and INSERT 0 0, COMMIT; one ledger row for 130.
--      No refresh ran at apply time.
--   5. The cron block (pg_cron is not installed on the local cluster, so the real
--      file takes the skip path above). Rehearsed on a copy whose pg_extension
--      guard was re-pointed at a stub cron schema (cron.job, cron.schedule,
--      cron.unschedule) holding production's state: 'cluster-topics-refresh' at
--      '3-59/10 * * * *' on interval '36 hours', 'framing-candidate-pool-refresh'
--      at '*/5 * * * *', and an unrelated job. After the first apply:
--      'cluster-topics-refresh' '3-59/10 * * * *' on interval '2 hours',
--      'cluster-topics-refresh-wide' '8 * * * *' on interval '36 hours', the
--      framing job and the unrelated job byte-identical; after the second apply
--      the same four rows (no duplicates, no error).
--   6. Rehearsals. With the index forced to indisvalid = false (local superuser)
--      and the local ledger row cleared, apply stopped in step 0 with
--      "130: invalid index left by an aborted CREATE INDEX CONCURRENTLY:
--      jev_shadow_predictions_politics_conf_idx. Run drop index concurrently
--      <name>, then rebuild it ...", leaving 0 ledger rows for 130; restored,
--      apply went through (INSERT 0 1). With the index removed and rebuilt by the
--      ORCHESTRATOR PRE-BUILD statement below, taken verbatim from this file by a
--      script, the invalid-index check returned 0 rows and apply printed
--      NOTICE relation "jev_shadow_predictions_politics_conf_idx" already
--      exists, skipping and INSERT 0 1.
--
-- ORCHESTRATOR PRE-BUILD (run standalone, outside a transaction, before applying 130)
-- Build the index with CREATE INDEX CONCURRENTLY so writes to
-- jev_shadow_predictions (the Jev shadow pipeline) keep flowing; 130 then sees
-- it and its own `create index if not exists` does nothing. Run it first, in
-- psql autocommit, outside any transaction block. Expect a few minutes: it
-- reads the whole 2.5 GB heap.
--
--   create index concurrently if not exists jev_shadow_predictions_politics_conf_idx on public.jev_shadow_predictions (created_at desc) include (article_id) where task = 'politics' and jev_prob >= 0.7 and article_id is not null;
--
-- A failed or cancelled CONCURRENTLY build leaves an INVALID index behind, and
-- `create index if not exists` would then skip it silently. Check before
-- applying (expect 0 rows):
--
--   select c.relname from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid = i.indexrelid where c.relname in ('jev_shadow_predictions_politics_conf_idx') and not i.indisvalid;
--
-- 130 itself re-checks (indisvalid = false) and aborts with a message telling
-- you to `drop index concurrently <name>` and rebuild.
--
-- If the pre-build was skipped, 130 builds the index inside its transaction.
-- That scans the whole 2.5 GB heap under a SHARE lock that blocks writes to
-- jev_shadow_predictions, so 130 starts with `set local lock_timeout = '5s'` and
-- `set local statement_timeout = '60s'`: a skipped pre-build that cannot finish
-- in 60 s aborts the whole migration with 57014 (query_canceled) instead of
-- blocking the shadow writer, and nothing is recorded in the ledger. Build it
-- concurrently and re-apply. A 55P03 (the 5 s lock_timeout) only means the table
-- was busy; re-apply.
--
-- The partial index only helps while the refresh's WHERE implies its
-- predicate: tests/migrations/130-db-hot-paths.test.ts pins that the three
-- literals (task = 'politics', jev_prob >= 0.7, article_id is not null) stay
-- identical in the index and in the recent_politics CTE.
--
-- DEPLOY ORDER. 1. Pre-build the index (above). 2. Apply 130 (it ends with
-- `notify pgrst, 'reload schema'`, so the new RPC is callable at once). 3.
-- Redeploy the ingest edge function with `--no-verify-jwt` (the operator, after
-- merge). Steps 2 and 3 are safe in either order: until 130 is applied the new
-- ingest gets PGRST202 from PostgREST, logs
-- 'existing_source_content_hash_pairs missing (apply migration 130); using
-- legacy probe' once per isolate, and runs the old cross-product probe.
--
-- VERIFY (read-only, after applying):
--   1. The RPC is service_role only:
--      select proname, prosecdef, proconfig, proacl from pg_proc where proname = 'existing_source_content_hash_pairs';
--      expect prosecdef t, search_path="" and an ACL naming only postgres and service_role.
--   2. explain (analyze, buffers) of the recent_politics CTE with a literal
--      window shows Index Only Scan using jev_shadow_predictions_politics_conf_idx,
--      no Filter and no Rows Removed by Filter line, buffers in the tens.
--   3. cron.job holds 'cluster-topics-refresh' at '3-59/10 * * * *' with
--      interval '2 hours', 'cluster-topics-refresh-wide' at '8 * * * *' with
--      interval '36 hours', and the framing job unchanged:
--      select jobname, schedule, command from cron.job where jobname like 'cluster-topics-refresh%' or jobname = 'framing-candidate-pool-refresh';
--   4. pg_stat_statements is cumulative, so use deltas from the Step 0 baseline
--      (calls, total_exec_time): the old prefilter queryid 1909717669635125342
--      stops growing (it grows only while the legacy fallback runs); the RPC's
--      own statement ('existing_source_content_hash_pairs') has a mean under
--      30 ms; the framing refresh (queryid -2504668587660639973):
--      (total_exec_time - 21085272) / (calls - 3036) < 3,000 ms.
--   5. The two topics jobs share one pg_stat_statements text, so read their
--      durations from pg_cron: select j.jobname, count(*), avg(d.end_time - d.start_time) from cron.job_run_details d join cron.job j using (jobid) where j.jobname like 'cluster-topics-refresh%' and d.start_time > now() - interval '1 day' group by 1;
--      expect the narrow job under 1.5 s and the wide one around 15 s.
--   6. select n_tup_upd, n_dead_tup from pg_stat_user_tables where relname = 'framing_candidate_pool';
--      n_tup_upd grows only by real title or published_at changes (it grew by
--      ~5.3k every 5 min before).
--
-- Safe to re-apply: create or replace function, create index if not exists,
-- unschedule-then-schedule by job name (only 'cluster-topics-refresh' and
-- 'cluster-topics-refresh-wide' are touched), ledger insert `on conflict do
-- nothing`. Additive: nothing is dropped, no data is rewritten, nothing is
-- granted to anon or authenticated, no refresh runs at apply time.
--
-- ROLLBACK (nothing here changes data shape; redeploy the previous ingest first
-- or leave it: it falls back to the legacy probe on PGRST202):
--   select cron.unschedule('cluster-topics-refresh-wide');
--   select cron.unschedule('cluster-topics-refresh');
--   select cron.schedule('cluster-topics-refresh', '3-59/10 * * * *', $$ select public.cluster_topics_refresh(interval '36 hours'); $$);
--   105's function body: re-run the "create or replace function public.framing_candidate_pool_refresh()" statement of 105_framing_candidate_pool.sql (section 2); its revoke and grant are unchanged.
--   drop index concurrently if exists jev_shadow_predictions_politics_conf_idx;
--   drop function if exists public.existing_source_content_hash_pairs(uuid[], text[]);
--   delete from supabase_migrations.schema_migrations where version = '130';
--
-- See tests/migrations/130-db-hot-paths.test.ts and tests/functions/ingest.test.ts.

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
     and c.relname in ('jev_shadow_predictions_politics_conf_idx')
     and i.indisvalid = false;
  if v_bad is not null then
    raise exception '130: invalid index left by an aborted CREATE INDEX CONCURRENTLY: %. Run drop index concurrently <name>, then rebuild it (see the ORCHESTRATOR PRE-BUILD block in the header of 130_db_hot_paths.sql).', v_bad;
  end if;
end
$guard$;

-- ---------------------------------------------------------------------------
-- 1. Pairwise (source_id, content_hash) lookup for ingest's prefilter.
--    unnest(a, b) zips the two arrays into pairs; each pair is ONE probe of
--    articles_source_content_hash_key (migration 013), so the cost is
--    proportional to the number of pairs, not to sources x hashes.
-- ---------------------------------------------------------------------------

create or replace function public.existing_source_content_hash_pairs(
  p_source_ids uuid[],
  p_hashes text[]
)
returns table (source_id uuid, content_hash text)
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_n integer := coalesce(pg_catalog.cardinality(p_source_ids), 0);
begin
  -- unnest(a, b) pads the shorter array with NULLs instead of failing, which
  -- would turn a caller bug into silently wrong (never-matching) pairs.
  if v_n <> coalesce(pg_catalog.cardinality(p_hashes), 0) then
    raise exception 'existing_source_content_hash_pairs: p_source_ids and p_hashes must have the same length (% vs %)',
      v_n, coalesce(pg_catalog.cardinality(p_hashes), 0)
      using errcode = '22023';
  end if;
  -- Ingest sends at most PREFILTER_CHUNK (100) pairs; the cap keeps this a
  -- bounded point-lookup RPC and not a bulk scan.
  if v_n > 500 then
    raise exception 'existing_source_content_hash_pairs: at most 500 pairs per call, got %', v_n
      using errcode = '54000';
  end if;

  -- Every column is qualified: the OUT parameters source_id and content_hash
  -- shadow bare names inside this plpgsql body. `unnest` stays UNQUALIFIED on
  -- purpose: the multi-array form unnest(a, b) is parser syntax that only
  -- applies to the bare name (pg_catalog.unnest(a, b) fails with "function
  -- pg_catalog.unnest(uuid[], text[]) does not exist"), and with
  -- search_path = '' the bare name still resolves to pg_catalog, which is
  -- always searched first, so nothing can shadow it.
  return query
    select a.source_id, a.content_hash
    from unnest(p_source_ids, p_hashes) as v(sid, h)
    join public.articles a
      on a.source_id = v.sid
     and a.content_hash = v.h;
end
$fn$;

comment on function public.existing_source_content_hash_pairs(uuid[], text[]) is
  'Stored (source_id, content_hash) pairs among the given PAIRS (migration 130): '
  'p_source_ids[i] goes with p_hashes[i]. One articles_source_content_hash_key '
  'probe per pair instead of ingest''s old source x hash cross product. Raises '
  'on arrays of different length and on more than 500 pairs. service_role only.';

revoke all on function public.existing_source_content_hash_pairs(uuid[], text[]) from public, anon, authenticated;
grant execute on function public.existing_source_content_hash_pairs(uuid[], text[]) to service_role;

-- ---------------------------------------------------------------------------
-- 2. cluster-topics-refresh: a 2 h job every 10 min + a 36 h job hourly.
--    The function (067, last redefined in 101) is untouched: same signature,
--    same advisory lock, so the two jobs can never run at the same time (a run
--    that hits the lock logs a notice and skips).
-- ---------------------------------------------------------------------------

do $cron$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron not installed — skipping cluster-topics-refresh split (130)';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'cluster-topics-refresh') then
    perform cron.unschedule('cluster-topics-refresh');
  end if;
  perform cron.schedule(
    'cluster-topics-refresh',
    '3-59/10 * * * *',
    $sql$ select public.cluster_topics_refresh(interval '2 hours'); $sql$
  );

  if exists (select 1 from cron.job where jobname = 'cluster-topics-refresh-wide') then
    perform cron.unschedule('cluster-topics-refresh-wide');
  end if;
  perform cron.schedule(
    'cluster-topics-refresh-wide',
    '8 * * * *',
    $sql$ select public.cluster_topics_refresh(interval '36 hours'); $sql$
  );
end
$cron$;

-- ---------------------------------------------------------------------------
-- 3. Partial index for the framing pool refresh's recent_politics CTE. The
--    predicate is the CTE's own literal filter, so the planner can prove the
--    query implies it; created_at desc serves the 54 h range, and include
--    (article_id) makes it an index-only scan.
-- ---------------------------------------------------------------------------

create index if not exists jev_shadow_predictions_politics_conf_idx
  on public.jev_shadow_predictions (created_at desc) include (article_id)
  where task = 'politics' and jev_prob >= 0.7 and article_id is not null;

-- ---------------------------------------------------------------------------
-- 4. framing_candidate_pool_refresh(): 105's body, plus one guard on the
--    upsert so a row whose title and published_at did not change is no longer
--    rewritten every 5 min (about 5.3k dead tuples per tick before).
-- ---------------------------------------------------------------------------

create or replace function public.framing_candidate_pool_refresh()
returns integer
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_now timestamptz;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtext('framing_candidate_pool_refresh')::bigint
  ) then
    return 0;
  end if;

  v_now := pg_catalog.now();

  with recent_politics as materialized (
    -- 072's index range scan on (task, created_at desc), with v_now for now().
    -- DISTINCT keeps one candidate per article.
    select distinct p.article_id as candidate_id
    from public.jev_shadow_predictions p
    where p.task = 'politics'
      and p.created_at >= v_now - interval '54 hours'
      and p.jev_prob >= 0.7
      and p.article_id is not null
  ),
  fresh as materialized (
    -- The FULL eligible set: no per-session anti-join and no newest-300 cut,
    -- both of which the draw still applies per request.
    select
      a.id           as article_id,
      a.title        as title,
      a.published_at as published_at
    from recent_politics rp
    join public.articles a on a.id = rp.candidate_id
    join public.sources s on s.id = a.source_id
    where a.published_at >= v_now - interval '48 hours'
      and s.active
      -- Normalised the same way src/lib/sources/kind.ts's sourceKindOf does:
      -- a null kind means "outlet", never "wire".
      and coalesce(s.kind, 'outlet') <> 'wire'
  ),
  gone as (
    delete from public.framing_candidate_pool c
    where not exists (select 1 from fresh f where f.article_id = c.article_id)
  )
  insert into public.framing_candidate_pool (article_id, title, published_at, refreshed_at)
  select f.article_id, f.title, f.published_at, v_now
  from fresh f
  on conflict (article_id) do update set
    title        = excluded.title,
    published_at = excluded.published_at,
    refreshed_at = excluded.refreshed_at
  -- Rewrite a row only when something it stores changed. Without this every
  -- tick rewrote all ~5.3k rows just to move refreshed_at.
  where (framing_candidate_pool.title, framing_candidate_pool.published_at) is distinct from (excluded.title, excluded.published_at);

  return (select count(*)::int from public.framing_candidate_pool);
end
$fn$;

comment on function public.framing_candidate_pool_refresh() is
  'Recomputes public.framing_candidate_pool (migration 105, upsert guard in 130): '
  '072''s eligibility (politics prediction >= 0.7 inside a 54h window, published '
  'in the last 48h, active non-wire outlet) without the per-session anti-join or '
  'the newest-300 cut. Deletes rows that are no longer eligible, upserts the '
  'rest (rewriting only rows whose title or published_at changed), and returns '
  'the pool size (0 if another run holds the advisory lock). service_role only; '
  'scheduled every 5 min as framing-candidate-pool-refresh.';

comment on column public.framing_candidate_pool.refreshed_at is
  'When this pool row last changed (title or published_at), or was inserted '
  '(migration 130). Before 130 it was the time of the last refresh, rewritten on '
  'every 5 min tick; an unchanged row is no longer touched, so this is not a '
  'heartbeat of the refresh job.';

revoke all on function public.framing_candidate_pool_refresh() from anon, authenticated, public;
grant execute on function public.framing_candidate_pool_refresh() to service_role;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('130', '130_db_hot_paths')
  on conflict do nothing;

commit;
