-- 141_neutral_title_repick.sql
--
-- Neutral-title re-pick, additive, one transaction, no data written:
--   * public.clusters.title_neutral_member_count smallint   (nullable, no default)
--   * clusters_neutral_repick_idx   (updated_at desc), partial on the re-pick set
--   * public.neutral_title_repick_candidates(p_model text, p_limit integer default 20)
--     service_role only; the headline cron (src/app/api/cron/headline/route.ts) calls it
--     after its IS NULL pick and re-picks at most 20 extractive titles per run.
-- There is NO backfill UPDATE and no trigger. Existing rows heal through the normal cron.
--
-- WHY (hunt 15, findings h15-neutral-1 and h15-neutral-2, 2026-11-01). The extractive
-- neutral title is picked once, when a cluster first reaches 2 members, and never again:
-- the cron selects `title_tr_neutral is null` and nothing resets the column. Cluster
-- d0a4e6ae (13 sources, 91 kg of drugs in beehives) still shows the third member's shouted
-- "POLİS BİLE ŞAŞKINA DÖNDÜ!", cluster 2c15fdcf (4 sources) still shows "Kısa haberler",
-- which isGenericTitle has rejected since #143, and e67ede66 (8 sources) shows the
-- minority "40 kişi tutuklandı" where six outlets say 39. Over 278 clusters with 3+ members
-- the hunter's replay of the current picker disagreed with the stored title in 42%, in
-- 56% with 8+ sources. extractive-v2 (src/lib/clusters/neutral-title.ts) fixes the picker:
-- Turkish-cased lead-ins, numerals, loaded words, and an acceptance gate (no question,
-- English, shouting, truncation). This migration lets the cron apply it to what exists.
--
-- DESIGN. A cluster is offered for a re-pick when it is active, has no LLM title
-- (title_neutral_at is null), has a title, 2+ articles, and was last updated in the last
-- 14 days, AND one of: title_neutral_model is not p_model (every extractive-v1 title),
-- title_neutral_member_count is null (never stamped), or article_count has reached
-- greatest(2 * stamped, stamped + 3) (the cluster outgrew the pick). The cron stamps
-- title_neutral_member_count with the cluster's article_count after EVERY re-pick, changed
-- title or not, so a row leaves the set until it really grows. Stamping the number of
-- titles the picker saw instead would re-pick a 40-member cluster forever. The cron writes
-- only title_tr_neutral (when it changed), title_neutral_model and
-- title_neutral_member_count: never updated_at, never a row with title_neutral_at set.
--
-- STEP 0 -- read-only measurements on production (2026-11-01, Supabase SQL endpoint,
-- every query under the 8 s statement timeout). Observed, not assumed.
--
--   1. select tgname, pg_get_triggerdef(oid) from pg_trigger
--       where tgrelid = 'public.clusters'::regclass and not tgisinternal;
--      -> [] (zero rows). No migration defines a trigger on clusters either (the only
--      triggers are on articles, sources, article_tickers and newsletter_subscribers).
--      Nothing bumps updated_at: the re-pick writes three non-key columns and
--      clusters.updated_at, which orders the home feed, stays exactly as it was.
--      (Migration 128 had to restore it because ITS statement wrote it; this one never
--      does, and the route has a test that no update payload contains the column.)
--
--   2. select version, name from supabase_migrations.schema_migrations
--       where version in ('139','140','141') -> 139_content_twin_candidates,
--      140_cluster_skip_log; no row 141.
--
--   3. pg_indexes for public.clusters: 19 indexes (clusters_active_updated_idx,
--      clusters_blindspot_checked_idx, clusters_blindspot_recall_idx,
--      clusters_blindspot_recall_veto_idx, clusters_blindspot_suspect_idx,
--      clusters_headline_pick_extractive_idx, clusters_headline_pick_llm_idx,
--      clusters_merged_into_idx, clusters_neutral_eligible_idx, clusters_pkey,
--      clusters_search_fold_live_idx, clusters_search_tsv_idx,
--      clusters_search_tsv_live_idx, clusters_title_key_live_idx,
--      clusters_topic7_updated_idx, idx_clusters_active_updated_at,
--      idx_clusters_first_published, idx_clusters_needs_rewrite, idx_clusters_updated_at).
--      clusters_neutral_repick_idx is free. 127's clusters_headline_pick_extractive_idx is
--      `title_tr_neutral is null`, the opposite set; idx_clusters_active_updated_at (014)
--      is `(updated_at desc) where article_count >= 2` with no title predicate.
--
--   4. Columns title_neutral%: title_neutral_at, title_neutral_model,
--      title_neutral_prompt_version. title_neutral_member_count does not exist yet.
--
--   5. The walk, 14 days:
--      select count(*) from public.clusters where is_archived = false
--         and title_neutral_at is null and title_tr_neutral is not null
--         and article_count >= 2 and updated_at > now() - interval '14 days';  -> 4,121
--      grouped by title_neutral_model: extractive-v1 = 4,121 (all of them). That is under
--      the function's inner limit of 5,000, so the limit stays 5,000 (it is a hard bound
--      on heap fetches; had the count been higher the limit would have been raised to it,
--      rounded up). At 20 per run and a */5 cron, 4,121 titles heal in about 17 hours
--      (206 runs), newest first, so the visible front page heals first.
--
-- LOCAL PROOF (PostgreSQL 15.12, throwaway cluster pg-an-b; stub.sql, then a scratch seed
-- kept outside the repo; shared_buffers 256 MB, random_page_cost 1.1). The seed copies
-- 127's mix: 258,879 clusters (30,874 with article_count >= 2, 48 of them pending, 191,464
-- archived, 36,541 active singletons), 51,776 heap pages, title_tr_neutral null_frac
-- 0.8787, updated_at correlation -0.32, updated_at over 60 days, 4,128 rows in the 14 day
-- set (production 4,121), the indexes of 003/014/019/037/127.
--   EXPLAIN (ANALYZE, BUFFERS) of the function's inner query with literals:
--   BEFORE (no 141 index, so the planner uses 014's idx_clusters_active_updated_at):
--       Limit (cost=0.29..4030.15 rows=131) (actual rows=4128)
--         Index Scan using idx_clusters_active_updated_at on clusters c
--           Index Cond: (updated_at > (now() - '14 days'::interval))
--           Filter: ((NOT is_archived) AND (title_neutral_at IS NULL) AND (title_tr_neutral IS NOT NULL))
--           Rows Removed by Filter: 8
--           Buffers: shared hit=2603 read=1546 written=273   (first run; warm: hit=4149)
--       Execution Time: 7.0 ms first run, 4.3 ms warm.
--   AFTER (141 applied, analyzed):
--       Limit (cost=0.29..132.25 rows=128) (actual rows=4128)
--         Index Scan using clusters_neutral_repick_idx on clusters c
--           Index Cond: (updated_at > (now() - '14 days'::interval))
--           Buffers: shared hit=4128 read=13   (first run; warm: hit=4141)
--       Execution Time: 4.8 ms first run, 4.3 ms warm. No Filter line, no Rows Removed.
--       Index size 696 kB (30,826 entries).
--   STRESS (rolled-back transaction, 8,000 older rows moved into the window, 12,128 rows in
--   it): the same query stops at the inner limit: Limit (actual rows=5000), Index Scan using
--   clusters_neutral_repick_idx, Buffers: shared hit=5020, 1.8 ms. The window cannot make the
--   walk longer than 5,000 heap fetches.
--   Honest reading: the walk is bounded by the 14 day Index Cond and by LIMIT 5000, and its
--   cost is the heap fetch of each row (title_neutral_model and the stamp are not in the
--   index). The new index removes the Filter and the 014 entries it cannot satisfy and
--   gives the planner a tight estimate (132 against 4,030), but ~4.1k buffer touches per
--   call remain either way. Production worst case, cold: 5,000 reads at the ~0.56 ms per
--   read 127 measured (7.8 s for 13,971) is about 2.8 s, under the 8 s statement timeout,
--   once per */5 tick; the hot front-page rows are normally cached. The route treats an
--   rpc error as non-fatal (HTTP 200, the IS NULL pass untouched).
--   Predicate semantics, checked in a rolled-back transaction on the seed: with every row
--   of the set stamped (extractive-v2, count = article_count) the function returns 0 rows
--   (steady state). Stamped 10: article_count 19 -> not offered, 20 -> offered
--   (greatest(2 * 10, 10 + 3)); stamped 2 and article_count 5 -> offered; a NULL stamp or
--   an extractive-v1 model -> offered; every row with title_neutral_at set -> hidden.
--   p_limit: default 20, 20 -> 20, 0 -> 1, 1000 -> 50, NULL -> 20.
--   Privileges: as anon and as authenticated `ERROR:  permission denied for function
--   neutral_title_repick_candidates`; as service_role it runs. proacl is
--   {postgres=X/postgres,service_role=X/postgres}; prosecdef t, provolatile s,
--   proconfig {search_path=""}.
--
-- DRY RUNS x2 (this file, psql -v ON_ERROR_STOP=1 -f, on the PostgreSQL 15.12 seed above; the
-- psql:<file>:<line>: prefix of each notice is dropped). The ledger had no row 141 before.
--   Apply #1: BEGIN, SET, SET, DO, ALTER TABLE, COMMENT, CREATE INDEX, CREATE FUNCTION,
--       COMMENT, REVOKE, GRANT, NOTIFY, INSERT 0 1, COMMIT.
--   Apply #2: BEGIN, SET, SET, DO,
--       NOTICE:  column "title_neutral_member_count" of relation "clusters" already exists, skipping
--       ALTER TABLE, COMMENT,
--       NOTICE:  relation "clusters_neutral_repick_idx" already exists, skipping
--       CREATE INDEX, CREATE FUNCTION, COMMENT, REVOKE, GRANT, NOTIFY, INSERT 0 0, COMMIT.
--       One ledger row for 141 after both.
--   Rehearsals: (a) with the index built first by the ORCHESTRATOR PRE-BUILD statement below
--       (taken verbatim from this file), the invalid-index check returned 0 rows and apply
--       printed the "already exists, skipping" notice for the index and INSERT 0 1. (b) With the
--       index forced to indisvalid = false (local superuser), apply stopped in step 0 with
--       "141: invalid index left by an aborted CREATE INDEX CONCURRENTLY:
--       clusters_neutral_repick_idx. Run drop index concurrently <name>, then rebuild it ...",
--       the column was not added and the ledger stayed untouched (0 rows for 141); restored,
--       apply went through. (c) The ROLLBACK block below, run verbatim, left no index, no
--       column, no function and no ledger row. anon and authenticated hold no table grants on
--       clusters before or after.
--
-- ORCHESTRATOR PRE-BUILD (run standalone, outside a transaction, before applying 141)
-- Build the index with CREATE INDEX CONCURRENTLY so writes to clusters keep flowing; 141
-- then sees it and its own `create index if not exists` does nothing. Use psql in
-- autocommit:
--
--   create index concurrently if not exists clusters_neutral_repick_idx on public.clusters (updated_at desc) where is_archived = false and title_neutral_at is null and title_tr_neutral is not null and article_count >= 2;
--
-- A failed or cancelled CONCURRENTLY build leaves an INVALID index behind, and
-- `create index if not exists` would then skip it silently. Check before applying
-- (expect 0 rows):
--
--   select c.relname from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid = i.indexrelid where c.relname in ('clusters_neutral_repick_idx') and not i.indisvalid;
--
-- 141 itself re-checks (indisvalid = false) and aborts with a message telling you to
-- `drop index concurrently <name>` and rebuild.
--
-- If the pre-build was skipped, 141 builds the index inside its transaction. That scans the
-- whole 423 MB table under a SHARE lock that blocks writes to clusters, so 141 starts with
-- `set local lock_timeout = '5s'` and `set local statement_timeout = '60s'`: a skipped
-- pre-build that cannot finish in 60 s aborts the whole migration with 57014
-- (query_canceled) instead of blocking ingest, and nothing is recorded in the ledger. Build
-- it concurrently and re-apply. A 55P03 (the 5 s lock_timeout) only means the table was
-- busy; re-apply. The ALTER TABLE ... ADD COLUMN of a nullable column without a default is
-- a catalog-only change (no rewrite); it needs a brief ACCESS EXCLUSIVE lock, which the 5 s
-- lock_timeout bounds.
--
-- HOT. The re-pick write sets title_neutral_model and title_neutral_member_count (neither
-- is indexed) and, only when the title changed, title_tr_neutral. title_tr_neutral and
-- title_neutral_at are predicate columns of 127's two indexes and of this one, so a write
-- that changes the title is not a HOT update; a write that only stamps the model and the
-- count (the title did not change) still can be. That costs next to nothing: at most 20
-- rows per */5 tick for about 17 hours, then only growth. clusters already has 19 indexes
-- and only ~2% HOT updates, because ingest and the cluster consumer move updated_at, the
-- key of several indexes, on nearly every write. The re-pick does the opposite on purpose:
-- it never writes updated_at, which orders the home feed (politics-query orders its
-- candidate window by it), so a healed title never makes an old story look new.
--
-- RELEASE ORDER. Apply 141 before or with the deploy. If the route ships first, its stamp
-- write fails once with PGRST204 (column missing from the schema cache); the route retries
-- that write without title_neutral_member_count, so the IS NULL pick keeps working, and the
-- re-pick pass reports an rpc error (non-fatal, still HTTP 200) until 141 is applied.
--
-- VERIFY (read-only, after applying):
--   1. explain (analyze, buffers) select c.id, c.title_tr_neutral, c.article_count, c.title_neutral_member_count, c.title_neutral_model, c.updated_at from public.clusters c where c.is_archived = false and c.title_neutral_at is null and c.title_tr_neutral is not null and c.article_count >= 2 and c.updated_at > now() - interval '14 days' order by c.updated_at desc limit 5000;
--      expect Index Scan using clusters_neutral_repick_idx, no Filter and no Rows Removed
--      by Filter line, Buffers in the low thousands.
--   2. select title_neutral_model, count(*) from public.clusters where is_archived = false and title_neutral_at is null and title_tr_neutral is not null and article_count >= 2 and updated_at > now() - interval '14 days' group by 1;
--      the extractive-v1 count (4,121 at Step 0) falls by ~20 per run to 0 within ~17 hours;
--      extractive-v2 rises. select count(*) from public.clusters where title_neutral_member_count is null and title_neutral_model = 'extractive-v2'
--      should stay near 0.
--   3. The cron response (GET /api/cron/headline) carries repicked and repickKept; a PGRST204
--      in the logs means 141 was not applied yet.
--   4. clusters.updated_at of a healed cluster is unchanged: compare it with the value before
--      the run (the cron writes no updated_at).
--
-- Safe to re-apply: add column if not exists, create index if not exists, create or replace
-- function, ledger insert `on conflict do nothing`. Nothing is analyzed or written to public
-- tables, and no backfill is run.
--
-- ROLLBACK (the cron then logs the rpc error and skips the re-pick; the IS NULL pick is
-- untouched and retries its stamp without the column on PGRST204):
--   drop function if exists public.neutral_title_repick_candidates(text, integer);
--   drop index concurrently if exists clusters_neutral_repick_idx;
--   alter table public.clusters drop column if exists title_neutral_member_count;
--   delete from supabase_migrations.schema_migrations where version = '141';
--
-- See tests/migrations/141-neutral-title-repick.test.ts.

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
     and c.relname in ('clusters_neutral_repick_idx')
     and i.indisvalid = false;
  if v_bad is not null then
    raise exception '141: invalid index left by an aborted CREATE INDEX CONCURRENTLY: %. Run drop index concurrently <name>, then rebuild it (see the ORCHESTRATOR PRE-BUILD block in the header of 141_neutral_title_repick.sql).', v_bad;
  end if;
end
$guard$;

-- ---------------------------------------------------------------------------
-- 1. The stamp: the article_count the extractive title was last picked from.
--    Nullable, no default: a catalog-only change, no rewrite, no backfill.
-- ---------------------------------------------------------------------------

alter table public.clusters add column if not exists title_neutral_member_count smallint;

comment on column public.clusters.title_neutral_member_count is
  'article_count the extractive neutral title was last picked from (clamped to 32767), '
  'stamped by the headline cron. neutral_title_repick_candidates() offers a cluster for a '
  're-pick when it is NULL, when the pick was made by another extractive version, or when '
  'the cluster has since doubled (or grown by 3). Migration 141.';

-- ---------------------------------------------------------------------------
-- 2. The re-pick set, as a partial index on the recency key.
-- ---------------------------------------------------------------------------

create index if not exists clusters_neutral_repick_idx
  on public.clusters (updated_at desc)
  where is_archived = false and title_neutral_at is null and title_tr_neutral is not null and article_count >= 2;

-- ---------------------------------------------------------------------------
-- 3. The candidates. The inner query walks the index from the newest end over the last
--    14 days and stops at 5000 rows (a hard bound on heap fetches); the outer filter
--    keeps the stale ones; the batch is capped at 50 whatever the caller asks.
-- ---------------------------------------------------------------------------

create or replace function public.neutral_title_repick_candidates(p_model text, p_limit integer default 20)
returns table (id uuid, title_tr_neutral text, article_count integer, title_neutral_member_count smallint)
language sql
stable
security definer
set search_path = ''
as $fn$
  select w.id, w.title_tr_neutral, w.article_count, w.title_neutral_member_count
    from (
      select c.id, c.title_tr_neutral, c.article_count, c.title_neutral_member_count,
             c.title_neutral_model, c.updated_at
        from public.clusters c
       where c.is_archived = false
         and c.title_neutral_at is null
         and c.title_tr_neutral is not null
         and c.article_count >= 2
         and c.updated_at > pg_catalog.now() - interval '14 days'
       order by c.updated_at desc
       limit 5000
    ) w
   where w.title_neutral_model is distinct from p_model
      or w.title_neutral_member_count is null
      or w.article_count >= greatest(w.title_neutral_member_count * 2, w.title_neutral_member_count + 3)
   order by w.updated_at desc
   limit least(greatest(coalesce(p_limit, 20), 1), 50);
$fn$;

comment on function public.neutral_title_repick_candidates(text, integer) is
  'Extractive neutral titles worth re-picking: active clusters of the last 14 days (newest 5000 '
  'walked on clusters_neutral_repick_idx) with no LLM title, picked by another model than p_model, '
  'never stamped, or grown to twice (or +3) the article_count they were picked at. Newest first, '
  'p_limit clamped to 1..50. Read-only; the headline cron stamps the rows. service_role only. Migration 141.';

revoke all on function public.neutral_title_repick_candidates(text, integer) from public, anon, authenticated;
grant execute on function public.neutral_title_repick_candidates(text, integer) to service_role;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('141', '141_neutral_title_repick')
  on conflict do nothing;

commit;
