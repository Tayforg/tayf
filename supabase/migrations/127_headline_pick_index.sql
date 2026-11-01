-- 127_headline_pick_index.sql
--
-- Two tiny partial indexes for the neutral-headline cron's candidate pick
-- (src/app/api/cron/headline/route.ts). Additive, one transaction, no route
-- change, no UI change, nothing granted, no data written.
--   clusters_headline_pick_extractive_idx  extractive mode (no ANTHROPIC_API_KEY)
--   clusters_headline_pick_llm_idx         llm mode
-- Both are btree (updated_at desc) on public.clusters, partial on exactly the
-- filters of the pick, so the pick becomes a walk from the newest end that
-- stops as soon as it has its rows.
--
-- WHY (hunt 8, finding h8-pipeline-1, 2026-11-01). The pick is
--     select id, title_tr, title_tr_neutral, summary_tr, article_count
--       from public.clusters
--      where <title_tr_neutral | title_neutral_at> is null
--        and is_archived = false
--        and article_count >= <2 extractive | 3 llm>
--      order by updated_at desc limit <50 | 5>
-- and no index matches it. h8 measured 34-36 clusters pending against 36,812
-- active singletons, a pick that averaged 4,882 ms and peaked at 8,000 ms (the
-- 8 s timeout), and a backlog of 83 min. The mechanism: only a few dozen
-- clusters are ever pending, far fewer than LIMIT 50, so the Limit is never
-- satisfied and the scan has no early exit. The planner walks every entry of
-- idx_clusters_active_updated_at (30,728 clusters with article_count >= 2),
-- fetches each heap row (a 423 MB table on an instance with a 256 MB
-- shared_buffers) and throws 30,688 of them away. Cold, that is 13,971 disk
-- reads and 7.8 s, right at the timeout, on every 5 minute tick.
--
-- The route is part of this contract. tests/migrations/127-headline-pick-index.test.ts
-- parses route.ts: it pins the two article_count floors against
-- EXTRACTIVE_MIN_ARTICLE_COUNT and HEADLINE_MIN_ARTICLE_COUNT, the null column
-- of each mode, and the exact chain of filters of the pick. Change the pick
-- and that file fails until a NEW migration brings the indexes back in line
-- (never edit 127 once applied).
--
-- STEP 0 -- read-only measurements on production (2026-11-01 ~10:00 UTC,
-- PostgreSQL 17.6). Every number here is observed, not assumed.
--
--   1. EXPLAIN (analyze, buffers) of the extractive pick, literals, limit 50:
--        Limit  (cost=0.29..172.36 rows=50) (actual time=0.037..7824.997 rows=39 loops=1)
--          Buffers: shared hit=16249 read=13971
--          ->  Index Scan using idx_clusters_active_updated_at on clusters
--                (cost=0.29..23374.65 rows=6792) (actual time=0.036..7824.990 rows=39 loops=1)
--                Filter: ((title_tr_neutral IS NULL) AND (NOT is_archived))
--                Rows Removed by Filter: 30688
--                Buffers: shared hit=16249 read=13971
--        Execution Time: 7825.062 ms
--      (6,792 is the planner's ESTIMATE of matching rows; the scan really
--      walked 30,727 entries to find 39.)
--
--   2. explain (generic_plan) of the same query with is_archived = $1 and
--      article_count >= $2 (what a bound-parameter statement gets):
--        Limit  (cost=0.42..81.72 rows=50)
--          ->  Index Scan using idx_clusters_updated_at on clusters
--                (cost=0.42..61918.13 rows=38079)
--                Filter: ((title_tr_neutral IS NULL) AND (article_count >= $2) AND (is_archived = $1))
--      A generic plan cannot prove a partial-index predicate from a
--      parameter, so it never uses 127's indexes (nor 014's or 037's).
--
--   3. plain explain of the llm shape (title_neutral_at is null ... >= 3 ... limit 5):
--        Limit  (cost=0.29..29.04 rows=5)
--          ->  Index Scan using idx_clusters_active_updated_at on clusters
--                (cost=0.29..23449.82 rows=4078)
--                Filter: ((title_neutral_at IS NULL) AND (NOT is_archived) AND (article_count >= 3))
--
--   4. counts: extractive pending 39 (25 with article_count 2), llm pending
--      16,463, clusters 258,878. The llm figure is every active cluster with
--      article_count >= 3: title_neutral_at is null on 100% of rows
--      (pg_stats null_frac 1), because the llm path has not run on production
--      and the live mode is extractive. title_tr_neutral null_frac is 0.8837.
--      The oldest extractive-pending cluster had updated_at 08:16 UTC, 1 h 53 min
--      old; all 39 pending ones are from the last ~2 h. 36,788 active singletons.
--
--   5. pg_indexes for public.clusters (15 indexes): clusters_active_updated_idx,
--      clusters_blindspot_checked_idx, clusters_blindspot_recall_idx,
--      clusters_blindspot_recall_veto_idx, clusters_blindspot_suspect_idx,
--      clusters_merged_into_idx, clusters_neutral_eligible_idx, clusters_pkey,
--      clusters_search_tsv_idx, clusters_search_tsv_live_idx,
--      clusters_topic7_updated_idx, idx_clusters_active_updated_at,
--      idx_clusters_first_published, idx_clusters_needs_rewrite,
--      idx_clusters_updated_at. Both new names are free and nothing is
--      equivalent. The nearest neighbours: idx_clusters_active_updated_at
--      (014: (updated_at desc) where article_count >= 2), clusters_active_updated_idx
--      (037: (updated_at desc) where is_archived = false) and idx_clusters_updated_at
--      (003) have no title predicate; clusters_neutral_eligible_idx (083) and
--      idx_clusters_needs_rewrite (019) are keyed on title_neutral_at, not on
--      updated_at, so they cannot serve the ordering. None of the existing
--      indexes mentions title_tr_neutral.
--
--   6. select version from supabase_migrations.schema_migrations where version
--      in ('127','128')  ->  0 rows. (The ledger is supabase_migrations.schema_migrations.)
--
--   7. pg_stat_statements (queryid 6977704822941124295, stats since 2026-09-21):
--      5,532 calls, mean 4,882.4 ms, max 7,999.5 ms, total_exec_time 27,009,468 ms.
--      The statement text shows is_archived = $1 ... LIMIT $3 (pg_stat_statements
--      normalises literals and bound parameters alike).
--
-- LOCAL PROOF (PostgreSQL 15.12, throwaway cluster; stub.sql, then a scratch
-- seed kept outside the repo; 127 applied for real). The scratch table copies
-- production's shape, so the local planner reproduces production's numbers:
-- 258,879 clusters (30,728 with article_count >= 2, 16,463 >= 3, 39 pending,
-- 191,363 archived singletons, 36,788 active singletons), 51,776 heap pages
-- (production 50,930), title_tr_neutral null_frac 0.8804 (0.8837),
-- updated_at correlation -0.31 (-0.38), random_page_cost 1.1, the five
-- indexes production already has. Check: the local BEFORE plan costs 176.18 on
-- an estimate of 7,076 rows (production 172.36 on 6,792) and the local generic
-- plan costs 82.58 (production 81.72).
--   Extractive pick, BEFORE:
--       Index Scan using idx_clusters_active_updated_at, Filter on title_tr_neutral
--       and is_archived, Rows Removed by Filter: 30689, Buffers: shared hit=6769
--       read=24044, cost 176.18, 34.7 ms (warm local disk; 7,825 ms cold on production).
--   Extractive pick, AFTER:
--       Index Scan using clusters_headline_pick_extractive_idx, no Filter line and
--       no Rows Removed by Filter, Buffers: shared hit=18 read=22, cost 48.17, 0.092 ms.
--   Llm pick, production-shaped data (16,463 pending): BEFORE cost 29.01 on
--       idx_clusters_active_updated_at; AFTER cost 5.25, Index Scan using
--       clusters_headline_pick_llm_idx.
--   Llm pick, steady state (all rewritten except the 3 newest, vacuumed):
--       BEFORE: idx_clusters_active_updated_at, Rows Removed by Filter: 30725,
--       Buffers: shared hit=24224 read=23303, 48.9 ms.
--       AFTER: Index Scan using clusters_headline_pick_llm_idx, Buffers: shared
--       hit=2 read=2, 0.020 ms. (The llm index only pays off once rewrites
--       shrink the pending set below LIMIT 5, the situation extractive is in
--       today; right now the llm pick finds its 5 rows within a few entries.)
--   Sizes: extractive index 16 kB (39 entries), llm index 376 kB (16,463 entries).
--   Custom vs generic plan (prepared statement with is_archived = $1 and
--       article_count >= $2, plan_cache_mode = auto, 12 executions): still the
--       custom plan, Index Scan using clusters_headline_pick_extractive_idx,
--       cost 48.17; forced generic plan: idx_clusters_updated_at, cost 82.58 (llm:
--       custom 5.25, generic 7.65). pg_prepared_statements: 0 generic plans.
--   Apply #1 (ledger had no row 127): BEGIN, SET, SET, DO, CREATE INDEX, CREATE
--       INDEX, INSERT 0 1, COMMIT. Apply #2: NOTICE relation
--       "clusters_headline_pick_extractive_idx" already exists, skipping, NOTICE
--       relation "clusters_headline_pick_llm_idx" already exists, skipping,
--       INSERT 0 0, COMMIT; one ledger row for 127.
--   Rehearsals: with the llm index dropped, apply rebuilt only that one (one
--       "already exists, skipping"); with both indexes built first by the two
--       ORCHESTRATOR PRE-BUILD statements below (taken verbatim from this file),
--       the invalid-index check returned 0 rows and apply printed both "already
--       exists, skipping" notices and INSERT 0 1. With the extractive index forced
--       to indisvalid = false (local superuser), apply stopped in step 0 with
--       "127: invalid index left by an aborted CREATE INDEX CONCURRENTLY:
--       clusters_headline_pick_extractive_idx. Run drop index concurrently <name>,
--       then rebuild it ...", and the ledger stayed untouched (0 rows for 127);
--       restored, apply went through. anon and authenticated hold no table
--       grants on clusters before or after.
--
-- ORCHESTRATOR PRE-BUILD (run each standalone, outside a transaction, before applying 127)
-- Build the indexes with CREATE INDEX CONCURRENTLY so inserts into clusters keep
-- flowing; 127 then sees them and its own `create index if not exists` does
-- nothing. Run these first, one per statement, each outside any transaction
-- block (use psql in autocommit):
--
--   create index concurrently if not exists clusters_headline_pick_extractive_idx on public.clusters (updated_at desc) where title_tr_neutral is null and is_archived = false and article_count >= 2;
--   create index concurrently if not exists clusters_headline_pick_llm_idx on public.clusters (updated_at desc) where title_neutral_at is null and is_archived = false and article_count >= 3;
--
-- A failed or cancelled CONCURRENTLY build leaves an INVALID index behind, and
-- `create index if not exists` would then skip it silently. Check before
-- applying (expect 0 rows):
--
--   select c.relname from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid = i.indexrelid where c.relname in ('clusters_headline_pick_extractive_idx', 'clusters_headline_pick_llm_idx') and not i.indisvalid;
--
-- 127 itself re-checks (indisvalid = false) and aborts with a message telling
-- you to `drop index concurrently <name>` and rebuild.
--
-- If a pre-build was skipped, 127 builds the missing index inside its
-- transaction. That scans the whole 423 MB table under a SHARE lock that blocks
-- writes to clusters, so 127 starts with `set local lock_timeout = '5s'` and
-- `set local statement_timeout = '60s'`: a skipped pre-build that cannot finish
-- in 60 s aborts the whole migration with 57014 (query_canceled) instead of
-- blocking ingest, and nothing is recorded in the ledger. Build it concurrently
-- and re-apply. A 55P03 (the 5 s lock_timeout) only means the table was busy; re-apply.
--
-- HOT. title_tr_neutral and title_neutral_at become index-predicate columns.
-- title_neutral_at already was one (019, 083), so the llm write loses nothing.
-- The extractive write (title_tr_neutral and title_neutral_model, and no
-- updated_at) was HOT-eligible and no longer is. That costs next to nothing:
-- it is at most 50 rows per 5 minute tick, about 244 clusters a day reach 2
-- articles in their first 24 h, and clusters already has 15 indexes and only
-- 2.1% HOT updates (n_tup_hot_upd 13,511 of n_tup_upd 638,062), because ingest
-- and the cluster consumer move updated_at, the key of three existing
-- indexes, on nearly every write. Most cluster writes already change the
-- indexed updated_at, so the HOT loss is negligible.
--
-- GENERIC PLAN. A partial index is usable only when the planner can prove the
-- query implies the predicate. With literal filters it can. With bound
-- parameters (is_archived = $1, article_count >= $2) a generic plan cannot and
-- falls back to idx_clusters_updated_at (Step 0 item 2). Whether PostgREST
-- binds the pick's filter values or inlines them was NOT verified from the
-- database side (item 7: the normalised text looks the same either way). If
-- they are bound and the statement is prepared, the plan cache plans the first
-- five executions on a connection as custom plans (the values are known, so
-- the partial index qualifies) and picks the generic plan afterwards only when
-- its cost is below the average custom cost. A custom plan is chosen while it
-- is cheaper, and it is: 48.17 against 82.58 for the extractive pick and 5.25
-- against 7.65 for the llm pick, the local planner staying on the custom plan
-- over 12 executions. That is a margin of about 1.7x in cost units (not orders
-- of magnitude); in real work it is about 40 buffers against 30,800. If
-- statistics drift ever closed that margin, a connection would flip to the
-- generic plan, which walks all 258,879 entries of idx_clusters_updated_at
-- with no early exit instead of today's 30,728. VERIFY item 2 watches for it.
-- The fallback, outside 127: serve the pick from a function with literal
-- predicates, or set plan_cache_mode = force_custom_plan on the PostgREST role.
--
-- VERIFY (read-only, after applying):
--   1. explain (analyze, buffers) select id, title_tr, title_tr_neutral, summary_tr, article_count from public.clusters where title_tr_neutral is null and is_archived = false and article_count >= 2 order by updated_at desc limit 50;
--      expect Index Scan using clusters_headline_pick_extractive_idx, no Filter
--      and no Rows Removed by Filter line, buffers in the tens.
--   2. The pick mean is under 100 ms. pg_stat_statements is cumulative, so use
--      the delta from the Step 0 baseline (queryid 6977704822941124295,
--      calls 5532, total_exec_time 27009468): after a few hours,
--      (total_exec_time - 27009468) / (calls - 5532) < 100 ms, and max_exec_time
--      of a reset window well under 8,000 ms. A climbing delta mean means the
--      generic-plan flip described above.
--   3. The oldest pending cluster is under 10 min old after a few ticks (it was
--      1 h 53 min at Step 0):
--      select now() - min(updated_at) from public.clusters where title_tr_neutral is null and not is_archived and article_count >= 2;
--
-- Safe to re-apply: create index if not exists, ledger insert `on conflict do
-- nothing`. Nothing is dropped, granted, analyzed or written.
--
-- ROLLBACK (nothing here changes data shape):
--   drop index concurrently if exists clusters_headline_pick_extractive_idx;
--   drop index concurrently if exists clusters_headline_pick_llm_idx;
--   delete from supabase_migrations.schema_migrations where version = '127';
--
-- See tests/migrations/127-headline-pick-index.test.ts.

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
     and c.relname in ('clusters_headline_pick_extractive_idx', 'clusters_headline_pick_llm_idx')
     and i.indisvalid = false;
  if v_bad is not null then
    raise exception '127: invalid index left by an aborted CREATE INDEX CONCURRENTLY: %. Run drop index concurrently <name>, then rebuild it (see the ORCHESTRATOR PRE-BUILD block in the header of 127_headline_pick_index.sql).', v_bad;
  end if;
end
$guard$;

-- ---------------------------------------------------------------------------
-- The headline cron's candidate pick, extractive mode (no API key):
--   .is("title_tr_neutral", null).eq("is_archived", false)
--   .gte("article_count", EXTRACTIVE_MIN_ARTICLE_COUNT).order("updated_at", desc)
-- ---------------------------------------------------------------------------

create index if not exists clusters_headline_pick_extractive_idx
  on public.clusters (updated_at desc)
  where title_tr_neutral is null and is_archived = false and article_count >= 2;

-- ---------------------------------------------------------------------------
-- The same pick, llm mode:
--   .is("title_neutral_at", null).eq("is_archived", false)
--   .gte("article_count", HEADLINE_MIN_ARTICLE_COUNT).order("updated_at", desc)
-- ---------------------------------------------------------------------------

create index if not exists clusters_headline_pick_llm_idx
  on public.clusters (updated_at desc)
  where title_neutral_at is null and is_archived = false and article_count >= 3;

insert into supabase_migrations.schema_migrations (version, name)
  values ('127', '127_headline_pick_index')
  on conflict do nothing;

commit;
