-- 101_db_hot_paths.sql
--
-- Speeds up the cron hot paths behind the 2026-10-21 incident and stops
-- cron.job_run_details from bloating. Additive, one transaction, no UI change.
--   (a) cluster_topics_refresh(): the predictions join probes the unique
--       (task, subject_id) index instead of the wide article_id index.
--   (b) clusters_blindspot_checked_idx: partial index so the 26 h window of
--       blindspot_recall_veto_refresh() (071) can BitmapOr two small indexes.
--   (c) jev_shadow_predictions_live_marginal_idx: partial covering index for
--       the `live` CTEs of jev_shadow_month_usage and jev_budget_daily (088).
--   (d) autovacuum reloptions on jev_shadow_predictions.
--   (e) public.ops_cron_log_compact(): bounds cron.job_run_details, scheduled
--       hourly as the pg_cron job 'cron-log-compact'.
--
-- INCIDENT 2026-10-21 (~21:45 UTC): production pages took 8-22 s and /rss.xml
-- returned 500. Migration 100 removed the first cause (net._http_response had
-- bloated to 278 MB of heap for 552 live rows). The database runs on a Micro
-- instance (shared_buffers 256 MB against a 5.2 GB database), so every cron
-- statement that reads cold pages evicts the page cache the site depends on.
-- 101 trims the remaining statements that read more than they have to and
-- caps the one pg_cron log table that grows without bound between the daily
-- prunes.
--
-- STEP 0 -- read-only measurements on production (2026-10-21 ~23:00 UTC,
-- PostgreSQL 17.6, pg_cron 1.6.4). Every number here is observed, not assumed.
--
--   Q1 (the invariant that makes (a) safe)
--      select count(*) from jev_shadow_predictions where task = 'topic7' and
--      (article_id is null or subject_id <> article_id::text)   ->   bad = 0.
--      0 violations over all 253,806 topic7 rows. The single full-table query
--      timed out twice at 60 s on a cold cache, so it was run in 23 slices on
--      created_at (three 4-day slices, then twenty 1-day slices covering
--      09-29 .. 10-19 where the 4-day ones timed out; the table grew by ~150
--      rows while the slices ran). bad = 0 in every slice.
--
--   Q2 (join rewrite, explain (analyze, buffers) on a pure-SELECT copy of the
--      067 `windowed` + `confident` CTEs, interval '36 hours': ~2,886 clusters,
--      ~5,200 cluster_articles rows, 679 confident rows)
--      OLD join (p.article_id = ca.article_id)
--         plan : Index Scan using jev_shadow_predictions_article_idx; every
--                probe heap-fetches the article's other-task predictions and
--                discards them ("Rows Removed by Filter: 1" per probe)
--         cold : 7,506.7 ms, buffers shared hit=26,852 read=7,069
--         warm : 47.5 ms, buffers shared hit=33,913
--      NEW join (p.task = 'topic7' and p.subject_id = ca.article_id::text)
--         plan : Index Scan using jev_shadow_predictions_task_subject_id_key,
--                Index Cond: (task = 'topic7') AND (subject_id = ca.article_id::text)
--         first: 477.3 ms, buffers shared hit=35,527 read=2,293 (it ran right
--                after OLD, which had already warmed the shared cluster pages,
--                so that pair is order-confounded; do not read it as a win)
--         warm : 56.2 ms, buffers shared hit=37,820
--      Warm, the two are the same (47 vs 56 ms; the text key is one buffer
--      deeper per probe). Cold, on 8 disjoint 24 h windows run in alternating
--      order (old,new,new,old then new,old,old,new), the predictions node read
--      1.90 pages per probe with OLD (20,000 reads / 10,525 probes) and 1.16
--      with NEW (13,497 / 11,634): 39% fewer reads, because a probe whose
--      article has no topic7 row now stops in the index instead of fetching
--      heap pages for its politics/topic/pair rows. Wall-clock in those cold
--      runs was dominated by storage latency that drifted from 1 to 22 ms per
--      read between consecutive queries (3.7 s to 38 s for the same plan
--      shape), so no wall-clock claim is made. What (a) buys is a plan that
--      cannot regress onto the wide article_id path and fewer cold reads.
--
--   Q3 (blindspot window): 941 is_blindspot rows of 243,847 clusters; the 26 h
--      window (updated_at or blindspot_recall_checked_at >= now() - 26 h)
--      holds 36 of them, so the blindspots are 26.1x the window (rule: keep
--      (b) at >= 10x). The expected seq scan did NOT happen: migration 014
--      dropped idx_clusters_is_blindspot, but 064 later added
--      clusters_blindspot_recall_idx on public.clusters (updated_at desc)
--      where is_blindspot (48 kB), and the planner uses it: Index Scan, Filter
--      on the OR, Rows Removed by Filter: 905, Buffers 937 (cold: hit=169
--      read=768, 5,366 ms; warm: hit=937, 3.4 ms). 937 < 1,000, but the 26x
--      ratio keeps (b). Only half of (b) is new: an index on (updated_at desc)
--      where is_blindspot already exists under another name, so creating
--      clusters_blindspot_updated_idx would duplicate it byte for byte and
--      double the write cost for no gain. 101 therefore adds only
--      clusters_blindspot_checked_idx, which lets the planner BitmapOr it with
--      clusters_blindspot_recall_idx (shown in the local proof below).
--
--   Q4 (cron.job_run_details): 79 MB total (82,329,600 bytes; heap 71 MB,
--      indexes 6,200 kB), 53,534 rows from 2026-10-07 04:41 UTC, 3,665 in the
--      last day, 148 in the last hour. Owner supabase_admin; row level
--      security is on (policy username = current_user) but postgres has
--      rolbypassrls and every row is username 'postgres'. has_table_privilege
--      for postgres: TRUNCATE = true, INSERT = true, SELECT = true. No user
--      triggers. So the compact-and-reinsert design is possible as postgres;
--      migration 081's daily DELETE prune cannot shrink the heap, which is why
--      a TRUNCATE is needed at all.
--
--   Q5 (jev_shadow_predictions): reloptions = null (no custom autovacuum
--      settings), owner = postgres (ALTER TABLE ... SET works), ~1.96 M live
--      tuples, 2,216 MB with indexes, last autovacuum 2026-10-17 07:51 UTC. At
--      the default 0.2 scale factors, vacuum waits for ~390k dead or inserted
--      tuples.
--
--   Q6: 7,187 jev_shadow_predictions rows with task = 'pair_marginal' and
--      run_id is null (of ~1.83 M), so the live-marginal partial index holds
--      ~7k entries.
--
-- WHY THE (a) JOIN REWRITE IS EQUIVALENT. jev_shadow_predictions has
-- unique (task, subject_id) (061), and for task 'topic7' the writer stores the
-- article's uuid as subject_id (subject_type 'article'; Q1 measured 0
-- exceptions over 253,806 rows, including none with a null article_id). With
-- the WHERE already pinning task = 'topic7', `p.article_id = ca.article_id`
-- and `p.task = 'topic7' and p.subject_id = ca.article_id::text` therefore
-- select the same row, and at most one row per article (the unique key). The
-- rest of the function is byte-for-byte 067's: tests/migrations/
-- 101-db-hot-paths.test.ts compares the normalized bodies, and no article_id
-- residual is added on purpose (it could tempt the planner back onto
-- jev_shadow_predictions_article_idx). The 067 cron job is not touched.
--
-- LOCAL PROOF (PostgreSQL 15.12, throwaway cluster; stub.sql, then 061, 067 and
-- 064 (for blindspot_recall_checked_at), then 101 applied twice; scripts are kept
-- outside the repo):
--   (a) 200 clusters (150 inside the 2 h window, 50 five days old) with 698
--       members (1-6 per cluster, some with a stale article_count), 665 topic7
--       rows over these cases: p = 0.79, 0.80, 0.85, 0.9, 0.95, 1.0; a missing
--       probabilities key; a string probability; an unknown label; a null
--       choice; no row at all for 1 article in 13; plus a politics row and a
--       topic row on every article and 20 orphan topic7 rows. 067's function,
--       then 101's, each starting from a reset of topic7/topic7_p/topic7_n,
--       snapshot of (id, topic7, topic7_p, topic7_n):
--         window      returns (067 / 101)   symmetric EXCEPT rows   second run
--         2 hours          119 / 119                 0                0 / 0
--         36 hours         119 / 119                 0                -
--         30 days          160 / 160                 0                0 / 0
--       82 of 200 clusters get a label (all seven vocabulary words occur), 78
--       have confident members but no majority, 40 have none. A control EXCEPT
--       between the 30 day and the 2 hour snapshots returns 82 rows, so the
--       comparison can fail.
--   (b) 243,847 clusters, 941 scattered blindspots, 36 in the 26 h window.
--       Before: Bitmap Heap Scan on clusters_blindspot_recall_idx, 905 rows
--       removed by filter, 947 buffers. After clusters_blindspot_checked_idx:
--       BitmapOr of the two partial indexes, no rows removed, 40 buffers.
--   (c)(d) applying 101 a second time: both indexes "already exists,
--       skipping", the same three reloptions, ledger INSERT 0 0, one function
--       of each name. Both indexes come out as specified (partial, with
--       INCLUDE (input_tokens) on the live-marginal one). With
--       clusters_blindspot_checked_idx forced to indisvalid = false, the apply
--       stops in step 0 with the "drop index concurrently ... then rebuild"
--       error and the ledger and schema stay untouched.
--   (e) ops_cron_log_compact() against a fake cron.job_run_details (24,005 rows,
--       24 MB, the owner is postgres): no cron schema -> 'skipped: no pg_cron';
--       default cap -> 'ok 24 MB'; p_max_bytes 0 (floored to 16 MiB) ->
--       'compacted 24 MB, kept 4' (only the four rows younger than 1 day; runid
--       values intact, the sequence not reset, table down to 32 kB, no temp
--       table left behind), then 'ok 32 kB'; p_keep 1 minute is clamped up to
--       1 hour (kept 2), 10 days is clamped down to 3 days (kept 5), null means
--       1 day (kept 4), p_max_bytes null means 150 MiB ('ok'); a table locked
--       by another session -> 'skipped: lock' after 20 s (the caller's
--       lock_timeout of 7 s is handed back, all 24,005 rows untouched, a LOG
--       line is written); advisory lock held elsewhere -> 'skipped: busy'; an
--       owner with SELECT only -> 'skipped: no truncate privilege', with
--       SELECT + TRUNCATE or INSERT + TRUNCATE -> 'skipped: no insert
--       privilege', with SELECT + INSERT + TRUNCATE -> compacts (LOCK TABLE
--       rides on TRUNCATE). EXECUTE is held by postgres and service_role only;
--       anon and authenticated cannot call either function.
--   Not run locally: the pg_cron block (no pg_cron on the scratch cluster; it
--   logs a NOTICE and skips, exactly as 100's does). Its shape is pinned by
--   tests/migrations/101-db-hot-paths.test.ts.
--
-- ORCHESTRATOR PRE-BUILD (run each standalone, outside a transaction, before applying 101)
-- The indexes below are built with CREATE INDEX CONCURRENTLY so inserts into
-- jev_shadow_predictions and clusters keep flowing; 101 then sees them and its
-- own `create index if not exists` does nothing. Run these first, one per
-- statement, each outside any transaction block:
--
--   create index concurrently if not exists jev_shadow_predictions_live_marginal_idx on public.jev_shadow_predictions (created_at) include (input_tokens) where task = 'pair_marginal' and run_id is null;
--   create index concurrently if not exists clusters_blindspot_checked_idx on public.clusters (blindspot_recall_checked_at desc) where is_blindspot;
--
-- Do NOT build a clusters index on (updated_at desc) where is_blindspot: it
-- already exists as clusters_blindspot_recall_idx (064).
--
-- A failed or cancelled CONCURRENTLY build leaves an INVALID index behind, and
-- `create index if not exists` would then skip it silently. Check before
-- applying (expect 0 rows):
--
--   select c.relname from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid = i.indexrelid where c.relname in ('jev_shadow_predictions_live_marginal_idx', 'clusters_blindspot_checked_idx') and not i.indisvalid;
--
-- 101 itself re-checks (indisvalid = false) and aborts with a message telling
-- you to `drop index concurrently <name>` and rebuild.
--
-- If a pre-build was skipped, 101 builds the missing index inside its
-- transaction. That takes a SHARE lock that blocks writes to the table, so 101
-- starts with `set local lock_timeout = '5s'` and `set local statement_timeout
-- = '60s'`: a skipped pre-build on a table too big to index in 60 s aborts the
-- whole migration with 57014 (query_canceled) instead of blocking inserts, and
-- nothing is recorded in the ledger. Build it concurrently and re-apply.
--
-- ops_cron_log_compact() behaviour:
--   * 'ok <size>'                      total relation size <= cap; nothing done
--   * 'compacted <size>, kept <n>'     size (before) > cap: under ACCESS
--                                      EXCLUSIVE, the rows younger than p_keep
--                                      are copied to a temp table, the table is
--                                      TRUNCATEd and the kept rows are put back
--                                      (same runid values, the sequence is not
--                                      reset), all in one transaction. Keeping
--                                      the last day means cron_failed_runs_30m
--                                      and blindspot_veto_cron_min (077) never
--                                      false-fail right after a compaction.
--   * 'skipped: no pg_cron'            cron.job_run_details does not exist
--   * 'skipped: no truncate privilege' / 'skipped: no insert privilege'
--                                      the owner lacks TRUNCATE, or INSERT or
--                                      SELECT (the reinsert needs all three)
--   * 'skipped: busy'                  another run holds the advisory lock
--   * 'skipped: lock'                  lock_timeout = 20 s expired (55P03 is
--                                      the only error caught, pg_cron records
--                                      a success and the next hourly tick
--                                      retries; the subtransaction rolls the
--                                      copy back, nothing is lost)
--   * any other error propagates and shows as a failed cron run.
--   Floors: the cap is at least 16 MiB (so a bad argument cannot turn the job
--   into an hourly wipe) and p_keep is clamped to between 1 hour and 3 days.
--   Why a TRUNCATE and not a DELETE: DELETE never shrinks the heap; 081 already
--   deletes rows older than the retention daily, and the heap is still 71 MB.
--   Rows that exist only as status 'starting' (start_time still null) are not
--   kept; pg_cron's later UPDATE of such a row matches nothing and is a no-op.
--
-- Safe to re-apply: create or replace, create index if not exists, ALTER TABLE
-- ... SET, idempotent cron reschedule (which also re-enables a job the kill
-- switch had disabled), ledger insert `on conflict do nothing`.
--
-- Kill switch (stop compaction without a deploy):
--   update cron.job set active = false where jobname = 'cron-log-compact';
--   -- or: select cron.unschedule('cron-log-compact');
-- Manual one-off verdict (floored to the 16 MiB cap, so this compacts only if
-- the table really is above it):
--   select public.ops_cron_log_compact();
--   select public.ops_cron_log_compact(0);
--
-- Rollback (nothing here changes data shape):
--   (a) re-apply migration 067's `create or replace function
--       public.cluster_topics_refresh`
--   (b) drop index concurrently if exists clusters_blindspot_checked_idx;
--   (c) drop index concurrently if exists jev_shadow_predictions_live_marginal_idx;
--   (d) alter table public.jev_shadow_predictions reset (autovacuum_vacuum_scale_factor, autovacuum_vacuum_insert_scale_factor, autovacuum_analyze_scale_factor);
--   (e) select cron.unschedule('cron-log-compact');
--       drop function public.ops_cron_log_compact(bigint, interval);
--
-- See docs/migration-guide.md (101) and tests/migrations/101-db-hot-paths.test.ts.

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
     and c.relname in ('jev_shadow_predictions_live_marginal_idx', 'clusters_blindspot_checked_idx')
     and i.indisvalid = false;
  if v_bad is not null then
    raise exception '101: invalid index left by an aborted CREATE INDEX CONCURRENTLY: %. Run drop index concurrently <name>, then rebuild it (see the ORCHESTRATOR PRE-BUILD block in the header of 101_db_hot_paths.sql).', v_bad;
  end if;
end
$guard$;

-- ---------------------------------------------------------------------------
-- (a) cluster_topics_refresh(): 067's function, one join changed
-- ---------------------------------------------------------------------------

create or replace function public.cluster_topics_refresh(
  p_since interval default interval '2 hours'
)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  -- Clamped so an operator backfill (`select public.cluster_topics_refresh(
  -- interval '30 days')`) is the widest pass this function will ever make,
  -- and a fat-fingered '10 years' cannot turn a 10-minute cron tick into a
  -- full-table sweep.
  v_since   interval := least(
                          coalesce(p_since, interval '2 hours'),
                          interval '30 days'
                        );
  v_updated integer  := 0;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('cluster_topics_refresh')::bigint) then
    raise notice 'cluster_topics_refresh: another pass holds the lock, skipping this run';
    return 0;
  end if;

  with windowed as (
    -- The only chunking mechanism, per the package spec: the clusters
    -- window. This query has no is_archived predicate, so migration 037's
    -- clusters_active_updated_idx (partial, where is_archived = false) does
    -- not apply; it is served by migration 003's unconditional
    -- idx_clusters_updated_at (updated_at desc) instead.
    select c.id             as cluster_id,
           c.article_count  as member_total
      from public.clusters c
     where c.updated_at >= pg_catalog.now() - v_since
  ),
  confident as (
    -- One row per (cluster, member) prediction that cleared the gate.
    -- Bound by the unique (task, subject_id) index on jev_shadow_predictions
    -- (for task 'topic7' subject_id is the article uuid as text; migration 101
    -- header, Q1) and the (cluster_id, article_id) primary key on
    -- cluster_articles. The join is on that key on purpose: probing by
    -- article_id would walk the wide article_id index and heap-fetch every
    -- other-task prediction of the article just to discard it.
    select w.cluster_id,
           p.jev_choice as topic_choice,
           pr.member_p  as member_p
      from windowed w
      join public.cluster_articles ca
        on ca.cluster_id = w.cluster_id
      join public.jev_shadow_predictions p
        on p.task = 'topic7' and p.subject_id = ca.article_id::text
     cross join lateral (
       -- SQL does not define AND-conjunct evaluation order: a sibling guard
       -- ("is this a JSON number?") and the ::numeric cast it protects are
       -- NOT guaranteed to run guard-first when written as two AND
       -- conjuncts -- a plan change (ANALYZE, a new index, a PostgreSQL
       -- major upgrade) can put the cast first and raise 22P02 on a
       -- malformed or absent probabilities value. Per the Postgres docs,
       -- "if it is essential to force evaluation order, a CASE construct
       -- can be used" -- so the guard and the cast are one indivisible CASE
       -- expression here, not two AND conjuncts.
       select case
                when pg_catalog.jsonb_typeof(
                       p.jev_answer -> 'answer' -> 'probabilities' -> p.jev_choice
                     ) = 'number'
                then (p.jev_answer -> 'answer' -> 'probabilities' ->> p.jev_choice)::numeric
                else null
              end as member_p
     ) pr
     where p.task = 'topic7'
       and p.jev_choice is not null
       -- Vocabulary filter: ignore, never raise. A future question set that
       -- returns an unknown label must not take the refresh down.
       and p.jev_choice in ('politika', 'dunya', 'ekonomi', 'spor', 'yasam', 'teknoloji', 'genel')
       and pr.member_p >= 0.800
       and pr.member_p <= 1
  ),
  tallies as (
    select cluster_id,
           topic_choice,
           pg_catalog.count(*)::integer as vote_n,
           pg_catalog.avg(member_p)     as mean_p
      from confident
     group by cluster_id, topic_choice
  ),
  totals as (
    select cluster_id,
           pg_catalog.sum(vote_n)::integer as confident_n
      from tallies
     group by cluster_id
  ),
  leaders as (
    -- Deterministic winner: most votes, then highest mean probability, then
    -- alphabetical. The 60% majority gate below means a genuine tie never
    -- produces a label anyway; the ordering exists so the same input always
    -- yields the same output.
    select distinct on (t.cluster_id)
           t.cluster_id,
           t.topic_choice,
           t.vote_n,
           t.mean_p,
           x.confident_n
      from tallies t
      join totals x
        on x.cluster_id = t.cluster_id
     order by t.cluster_id, t.vote_n desc, t.mean_p desc, t.topic_choice asc
  ),
  decided as (
    select w.cluster_id,
           case
             when l.topic_choice is null then null
             when l.confident_n >= 2
              and (l.vote_n)::numeric / l.confident_n >= 0.600 then l.topic_choice
             -- Single-member cluster: one confident member at >= 0.900.
             -- confident_n = 1 is required as well as member_total = 1, so a
             -- stale article_count can never let a split vote through this
             -- branch.
             when w.member_total = 1
              and l.confident_n = 1
              and l.mean_p >= 0.900 then l.topic_choice
             else null
           end as topic_choice,
           case
             when l.topic_choice is null then null
             when l.confident_n >= 2
              and (l.vote_n)::numeric / l.confident_n >= 0.600 then pg_catalog.round(l.mean_p, 3)
             when w.member_total = 1
              and l.confident_n = 1
              and l.mean_p >= 0.900 then pg_catalog.round(l.mean_p, 3)
             else null
           end as topic_p,
           coalesce(l.confident_n, 0) as confident_n
      from windowed w
      left join leaders l
        on l.cluster_id = w.cluster_id
  ),
  applied as (
    update public.clusters c
       set topic7   = d.topic_choice,
           topic7_p = d.topic_p,
           topic7_n = d.confident_n
      from decided d
     where c.id = d.cluster_id
       -- No-op guard: a steady-state tick writes zero rows, so this function
       -- cannot churn the table, cannot bloat it, and cannot look like
       -- pipeline activity to anything watching write volume.
       and (c.topic7   is distinct from d.topic_choice
         or c.topic7_p is distinct from d.topic_p
         or c.topic7_n is distinct from d.confident_n)
    returning 1 as applied_flag
  )
  select pg_catalog.count(*)::integer
    into v_updated
    from applied;

  return v_updated;
end
$fn$;

comment on function public.cluster_topics_refresh(interval) is
  'Recomputes clusters.topic7 / topic7_p / topic7_n for every cluster '
  'updated within p_since (default 2 hours, clamped to 30 days), from '
  'jev_shadow_predictions rows with task = ''topic7''. A member counts as '
  'evidence only when its own choice probability is >= 0.800; a label is '
  'written when >= 60% of >= 2 confident members agree, or when a '
  'single-member cluster has its one confident member at >= 0.900; '
  'otherwise topic7 is set back to null. Returns the number of cluster rows '
  'actually changed (the UPDATE is guarded with IS DISTINCT FROM, so a tick '
  'that changes nothing returns 0). Never writes clusters.updated_at — that '
  'column is the /api/health liveness signal (migration 027). Makes zero '
  'gateway calls. Migration 101: the predictions join probes the unique (task, subject_id) index.';

revoke all on function public.cluster_topics_refresh(interval) from anon, authenticated, public;
grant execute on function public.cluster_topics_refresh(interval) to service_role;

-- ---------------------------------------------------------------------------
-- (b) Blindspot window: a second small partial index for the OR in
--     blindspot_recall_veto_refresh() (071). The updated_at half is served by
--     064's clusters_blindspot_recall_idx (same definition), so nothing is
--     duplicated here.
-- ---------------------------------------------------------------------------

create index if not exists clusters_blindspot_checked_idx
  on public.clusters (blindspot_recall_checked_at desc)
  where is_blindspot;

-- ---------------------------------------------------------------------------
-- (c) The `live` CTEs of jev_shadow_month_usage and jev_budget_daily (088):
--     task = 'pair_marginal' and run_id is null, created_at >= <month/day start>,
--     summing input_tokens. ~7k entries; index-only scannable.
-- ---------------------------------------------------------------------------

create index if not exists jev_shadow_predictions_live_marginal_idx
  on public.jev_shadow_predictions (created_at) include (input_tokens)
  where task = 'pair_marginal' and run_id is null;

-- ---------------------------------------------------------------------------
-- (d) Autovacuum: the table is ~2 GB and insert-heavy; the 0.2 defaults mean
--     vacuum and analyze wait for ~390k tuples. (articles is not touched: 045
--     already tunes it.)
-- ---------------------------------------------------------------------------

alter table public.jev_shadow_predictions set (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_insert_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.01
);

-- ---------------------------------------------------------------------------
-- (e) The cron log compactor
-- ---------------------------------------------------------------------------

create or replace function public.ops_cron_log_compact(
  p_max_bytes bigint   default 150 * 1024 * 1024,
  p_keep      interval default interval '1 day'
)
returns text
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_max     bigint   := greatest(coalesce(p_max_bytes, 150 * 1024 * 1024), 16 * 1024 * 1024);
  v_keep    interval := least(greatest(coalesce(p_keep, interval '1 day'), interval '1 hour'), interval '3 days');
  v_rel     regclass;
  v_size    bigint;
  v_kept    bigint := 0;
  v_prev_lt text;
  v_out     text;
begin
  v_rel := pg_catalog.to_regclass('cron.job_run_details');
  if v_rel is null then
    return 'skipped: no pg_cron';
  end if;
  if not pg_catalog.has_table_privilege(v_rel, 'TRUNCATE') then
    return 'skipped: no truncate privilege';
  end if;
  if not pg_catalog.has_table_privilege(v_rel, 'INSERT')
     or not pg_catalog.has_table_privilege(v_rel, 'SELECT') then
    return 'skipped: no insert privilege';
  end if;
  -- Two overlapping runs would queue behind each other's ACCESS EXCLUSIVE
  -- lock; the second one steps aside instead. xact-scoped: released at commit.
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('ops_cron_log_compact', 0)) then
    return 'skipped: busy';
  end if;

  -- Bounds BOTH the size probe and the table lock, so pg_cron's own writers
  -- (every job start and finish updates this table) cannot hold us up for more
  -- than 20 s, and we cannot hold them up for long either.
  v_prev_lt := pg_catalog.current_setting('lock_timeout');
  set local lock_timeout = '20s';
  begin
    v_size := pg_catalog.pg_total_relation_size(v_rel);
    if v_size > v_max then
      -- Lock first, then copy: with the table locked nothing can add or update
      -- a row between the copy and the TRUNCATE.
      lock table cron.job_run_details in access exclusive mode;
      create temp table ops_cron_keep on commit drop as
        select * from cron.job_run_details where start_time >= pg_catalog.now() - v_keep;
      truncate table cron.job_run_details;
      insert into cron.job_run_details select * from pg_temp.ops_cron_keep;
      get diagnostics v_kept = row_count;
      v_out := 'compacted ' || pg_catalog.pg_size_pretty(v_size) || ', kept ' || v_kept::text;
    else
      v_out := 'ok ' || pg_catalog.pg_size_pretty(v_size);
    end if;
  exception when lock_not_available then   -- SQLSTATE 55P03
    raise log 'ops_cron_log_compact: lock_timeout (55P03) on cron.job_run_details, retrying next tick';
    v_out := 'skipped: lock';
  end;
  perform pg_catalog.set_config('lock_timeout', v_prev_lt, true);   -- hand the caller's setting back
  return v_out;
end
$fn$;

comment on function public.ops_cron_log_compact(bigint, interval) is
  'Compacts cron.job_run_details (owned by supabase_admin) when its total relation size exceeds '
  'p_max_bytes (default 150 MiB, floored at 16 MiB): under ACCESS EXCLUSIVE it copies the rows '
  'younger than p_keep (default 1 day, clamped to 1 hour .. 3 days) to a temp table, TRUNCATEs the '
  'table and puts the kept rows back, so cron_failed_runs_30m and blindspot_veto_cron_min keep '
  'their data. Migration 101. Returns ''ok <size>'', ''compacted <size>, kept <n>'', '
  '''skipped: lock'' (lock_timeout 20 s hit, SQLSTATE 55P03 swallowed so pg_cron shows success and '
  'retries next tick) or ''skipped: ...'' (no pg_cron, no TRUNCATE or INSERT or SELECT privilege, or '
  'another run holds the advisory lock). Scheduled hourly at :35 as cron-log-compact; the operator '
  'kill switch is `update cron.job set active = false where jobname = ''cron-log-compact'';`. '
  'service_role only.';

revoke all on function public.ops_cron_log_compact(bigint, interval) from public, anon, authenticated;
grant execute on function public.ops_cron_log_compact(bigint, interval) to service_role;

-- ---------------------------------------------------------------------------
-- Schedule: hourly at :35 (clear of the */10 and 3-59/10 ticks and of 081's
-- 04:40 prune). statement_timeout is raised above the 20 s lock_timeout so a
-- held lock surfaces as the handled 55P03, never as a 57014 timeout.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron not installed — skipping cron-log-compact schedule (101)';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'cron-log-compact') then
    perform cron.unschedule('cron-log-compact');
  end if;
  perform cron.schedule('cron-log-compact', '35 * * * *',
    $sql$ set statement_timeout = '90s'; select public.ops_cron_log_compact(); $sql$);
end $$;

insert into supabase_migrations.schema_migrations (version, name)
  values ('101', '101_db_hot_paths')
  on conflict do nothing;

commit;
