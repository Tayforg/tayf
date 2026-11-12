-- 201_image_requeue_partial_index.sql
--
-- One tiny partial index for the loop of public.image_backfill_requeue(), the function the pg_cron job
-- image-backfill-requeue calls four times an hour. Additive, one transaction, no function change, no cron
-- change, no UI change, nothing granted, no data written.
--   articles_image_requeue_idx  btree (created_at desc) on public.articles
--                               where image_url is null and image_backfill_attempts between 1 and 2
-- The predicate is the function's own filter (the 154 body, still the live one), so the planner can prove it
-- and the loop becomes a walk over a few dozen index entries instead of over every article of the last 7 days.
--
-- WHY (hunt 140, finding h140-perf-1, 2026-11-12). The loop is
--     select a.id from public.articles a
--      where a.image_url is null and a.image_backfill_attempts between 1 and 2
--        and a.image_backfill_attempted_at < pg_catalog.now() - interval '2 hours'
--        and a.created_at > pg_catalog.now() - interval '7 days'
--        and a.id::text not in (select q.message ->> 'article_id' from pgmq.q_image_backfill q where ...)
--      order by a.created_at desc limit 40
-- and the only index it can use is idx_articles_created_at. About 69,000 articles were created in the last 7
-- days and 37 of them are tries 2 and 3 of an image-less article, 19 of those tried over 2 hours ago. That is
-- far fewer than LIMIT 40, so the Limit is never satisfied and the scan has no early exit: it walks the whole
-- 7-day range, fetches every heap row of the 1,178 MB table and throws nearly all of them away. 154 sized this
-- at "the worst case once an hour" when the job ran hourly; since 154 it runs 96 runs a day.
--   * cron.job_run_details of job 64, 11-04 to 11-11: 96 runs a day, average 3.0 to 4.1 s, maximum 10.5 s,
--     286 to 396 s of database time a day, no failure. Last 24 h on 2026-11-12: 96 runs, average 3.40 s,
--     maximum 10.35 s, 326 s in total, none failed. On 11-03, while a backlog still stopped the scan early, the
--     average was 1.0 s.
--   * About 6,000 physical block reads (roughly 50 MB) per run on the hot articles table, for 9 rows sent.
--   No user-visible symptom: this is wasted I/O. The database is at 6,907 MB against the 7,000 MB ops warn, so
--   only a tiny index is acceptable.
-- 142's header ("NO NEW INDEX") named the remedy: "a partial index (created_at) where image_url is null is the
-- follow-up, built concurrently first". 154 narrowed the tries from 1..4 to 1..2, which is the predicate.
--
-- STEP 0 -- read-only measurements on production (2026-11-12, PostgreSQL 17.6, SELECT and EXPLAIN only).
--
--   1. pg_get_functiondef('public.image_backfill_requeue(integer)'::regprocedure): the WHERE of the loop is
--      byte for byte 154's. md5(prosrc) = 2c3e427b0c98801b873b335544ab7699, 866 characters, the value 154 recorded
--      for its own body: no drift. cron.job 64 (image-backfill-requeue, active) is '2,17,32,47 * * * *' and runs
--      set statement_timeout = '60s'; select public.image_backfill_requeue(40);
--
--   2. EXPLAIN (no analyze) of the loop, literals, limit 40, 2026-11-12:
--        Limit  (cost=1.44..14202.93 rows=18 width=24)
--          ->  Index Scan using idx_articles_created_at on articles a  (cost=1.44..14202.93 rows=18 width=24)
--                Index Cond: (created_at > (now() - '7 days'::interval))
--                Filter: ((image_url IS NULL) AND (image_backfill_attempts >= 1) AND (image_backfill_attempts <= 2)
--                         AND (image_backfill_attempted_at < (now() - '02:00:00'::interval))
--                         AND (NOT (ANY ((id)::text = (hashed SubPlan 1).col1))))
--                SubPlan 1
--                  ->  Seq Scan on q_image_backfill q  (cost=0.00..1.00 rows=1 width=32)
--                        Filter: ((message ->> 'article_id'::text) IS NOT NULL)
--      The planner expects 18 rows and prices the walk at 14,203 cost units.
--
--   3. EXPLAIN (ANALYZE, BUFFERS, TIMING OFF) of the same query, taken by the hunter 2026-11-12 01:15 to 01:20 UTC
--      (read-only SELECT, the text from pg_get_functiondef):
--        Index Scan using idx_articles_created_at on articles a, 9 rows,
--          Rows Removed by Filter: 69,178, Buffers: shared hit=24,629 read=6,272, Execution Time: 3,322 ms
--
--   4. The 7-day window (index scan on created_at): 69,189 rows; 4,738 with image_url null; 37 with image_url
--      null and attempts 1 or 2; 19 of those with image_backfill_attempted_at over 2 hours ago. The queue
--      guard (pgmq.q_image_backfill holds 19 messages, oldest 66 s) is a hashed subplan over a one-page table.
--
--   5. Index size, estimated. TABLESAMPLE SYSTEM (2) twice and SYSTEM (8) once over public.articles (1,484,776 live
--      tuples, 150,680 pages, 1,178 MB heap, 1,013 MB of indexes): matching rows 1,610 of 29,741, 1,540 of
--      29,452 and 6,416 of 119,040, so about 80,400, 77,600 and 80,000: about 80,000 entries. Only 37 are in the
--      last 7 days; the rest are older articles that were tried once or twice and never again (142 only looks
--      back 7 days). Size: 80,000 x about 22 bytes (16-byte index tuple, 4-byte line pointer, 90% leaf fill) is
--      about 1.8 MB for a fresh build; a local build of the same shape (LOCAL PROOF) costs 24.3 bytes an entry,
--      which gives 1.9 MB. Upper bound: idx_articles_created_at really costs 45.25 bytes an entry on production
--      (67,182,592 bytes for 1,484,771 rows, with bloat), and 80,000 x 45.25 is 3.6 MB. Under the 5 MB bar either
--      way; the existing idx_articles_image_backfill_attempted is 944 kB.
--
--   6. pg_indexes for public.articles (15 indexes): articles_pkey, articles_source_article_key_idx,
--      articles_source_content_hash_key, articles_url_key, idx_articles_category, idx_articles_created_at,
--      idx_articles_created_published_source, idx_articles_created_source, idx_articles_image_backfill_attempted,
--      idx_articles_politics_published, idx_articles_politics_unclustered, idx_articles_published_at,
--      idx_articles_source_id, idx_articles_source_published, idx_articles_source_published_inc_id.
--      The new name is free and nothing is equivalent. The one image-related index,
--      idx_articles_image_backfill_attempted (015: (image_backfill_attempted_at nulls first) where image_url is
--      null and category in ('politika', 'son_dakika')), is keyed on the attempt time and limited to two
--      categories, so it cannot serve a created_at walk over all categories.
--
--   7. select version from supabase_migrations.schema_migrations where version in ('154','197','198','199',
--      '200','201','202')  ->  154, 198, 199. (The ledger is supabase_migrations.schema_migrations; 197 is held
--      and 200 is not applied.) 201 is free.
--
--   8. pg_stat_user_tables for public.articles: n_tup_upd 771,713, n_tup_hot_upd 34,489 (4.5% HOT).
--
-- LOCAL PROOF (PostgreSQL 15.12, throwaway cluster; tests/migrations/sql/stub.sql, then
-- tests/migrations/sql/201-image-requeue-index-dryrun.sql; 201 applied for real in every scenario below; the
-- script ran clean on a fresh database and once more through tests/migrations/sql/run-live.sh on a fresh
-- private server, each ending in DRYRUN 201 OK). The dry-run seeds a production-shaped articles table (random_page_cost 1.1,
-- ANALYZE): 220,000 articles, 69,000 of them in the last 7 days (production 69,189), 4,928 of those without an
-- image and 40 of those tries 1 and 2 (20 tried 3 hours ago, 20 tried 1 hour ago), so 20 are eligible (production
-- 19) and the queue guard skips the one already queued: 19 ids; the 151,000 older articles hold 8,741 more
-- tries 1 and 2 (5.8%, production about 5.4%). pgmq is a stand-in (q_image_backfill only).
--   BEFORE (no index): Index Scan using idx_articles_created_at, 19 rows, Rows Removed by Filter: 68,981,
--       1,321 buffers (production: 69,178 removed, 30,901 buffers; the local heap is narrow and warm).
--   Pre-build (the ORCHESTRATOR PRE-BUILD statement below, verbatim) then apply #1: NOTICE relation
--       "articles_image_requeue_idx" already exists, skipping, INSERT 0 1. Apply #2: the same notice, INSERT 0 0;
--       one ledger row for 201.
--   AFTER: Index Scan using articles_image_requeue_idx, 19 rows, Rows Removed by Filter: 21, 9 buffers. The
--       index is 212,992 bytes for 8,781 entries (24.3 bytes an entry; production's 80,000 entries would be
--       1.9 MB), its entry count equals count(*) of its predicate, and its definition is a btree on
--       (created_at desc) with that predicate.
--   Same rows: the loop returns the same ids in the same order before and after (an array comparison).
--   Predicate coupling: the loop with 142's filter (attempts between 1 and 4) does NOT use the index; a
--       partial index serves only a query whose WHERE implies its predicate.
--   Pre-build skipped, small table: with the index dropped, the loop is back on idx_articles_created_at; the
--       stub's public.articles is 26,984,448 bytes (25 MB, under the 64 MB size guard), so apply #3 builds the
--       index inside the transaction (BEGIN, SET, SET, DO, CREATE INDEX, INSERT 0 1, COMMIT, no skipping
--       notice), the plan is the same as AFTER and the ledger holds one row.
--   Size guard (SEC-2): the same table padded to 97,206,272 bytes (92 MB, over 64 MB) with the index dropped and
--       the ledger row deleted: apply stops in step 0 with "201: public.articles is 92 MB and
--       articles_image_requeue_idx does not exist yet. Applying 201 now would build the index inside this
--       transaction under a SHARE lock ... Run the ORCHESTRATOR PRE-BUILD first ...", the two statements after it
--       are ignored ("current transaction is aborted"), COMMIT rolls back: no index is built and the ledger has 0
--       rows for 201. After the ORCHESTRATOR PRE-BUILD statement the same apply goes through (the "already exists,
--       skipping" notice, INSERT 0 1, one ledger row).
--   Invalid index: with the index forced to indisvalid = false (local superuser), apply stops in step 0 with
--       "201: invalid index left by an aborted CREATE INDEX CONCURRENTLY: articles_image_requeue_idx. Run drop
--       index concurrently articles_image_requeue_idx, then rebuild it ..." and the ledger stays untouched (0
--       rows for 201); restored, apply goes through.
--   Data: md5 over public.articles before and after the applies: equal; the only object added to public is the index.
--
-- ORCHESTRATOR PRE-BUILD (run standalone, outside a transaction, before applying 201)
-- Build the index with CREATE INDEX CONCURRENTLY so inserts into articles (the ingest cycle) keep flowing; 201
-- then sees it and its own `create index if not exists` does nothing. Run it first, outside any transaction
-- block (use psql in autocommit):
--
--   create index concurrently if not exists articles_image_requeue_idx on public.articles (created_at desc) where image_url is null and image_backfill_attempts between 1 and 2;
--
-- A failed or cancelled CONCURRENTLY build leaves an INVALID index behind, and `create index if not exists`
-- would then skip it silently. Check before applying (expect 0 rows):
--
--   select c.relname from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid = i.indexrelid where c.relname = 'articles_image_requeue_idx' and not i.indisvalid;
--
-- 201 itself re-checks (indisvalid = false) and aborts with a message telling you to `drop index concurrently
-- articles_image_requeue_idx` and rebuild.
--
-- If the pre-build was skipped, the build inside 201's own transaction would scan the whole 1,178 MB table under a
-- SHARE lock on articles. That lock blocks every write to articles for the whole build, up to the 60 s
-- statement_timeout, and the writers (ingest and the image-consumer, through PostgREST: the authenticator role has
-- lock_timeout 8 s) fail with 55P03 meanwhile. `set local lock_timeout = '5s'` bounds only the wait to GET the
-- lock, and `set local statement_timeout = '60s'` only ends the stall with 57014 (query_canceled) after it has
-- happened, so neither protects ingest. So 201 refuses on a table over 64 MB without the index, as 113 does
-- (fail closed, SEC-2): step 0 raises "201: public.articles is N MB and articles_image_requeue_idx does not exist
-- yet ... Run the ORCHESTRATOR PRE-BUILD first" and nothing is recorded in the ledger. Only on a small fresh dev or
-- CI database (64 MB or less, where the build is instant) does 201 build the index inside its transaction.
-- Build it concurrently and re-apply. A 55P03 (the 5 s lock_timeout) only means the table was busy; re-apply.
--
-- DISK. +about 1.9 MB (3.6 MB at the very most) on a database at 6,907 MB against the 7,000 MB ops warn. Nothing
-- else is added. An aborted CONCURRENTLY build leaves a partial relation of the same order; drop it as above.
--
-- HOT. image_url and image_backfill_attempts become index-predicate columns of a second index. image_url
-- already was one (015's idx_articles_image_backfill_attempted), and the only writers of these columns are the
-- image-consumer's two updates (supabase/functions/image-consumer/index.ts): the success update sets image_url,
-- image_backfill_attempted_at and image_backfill_attempts = 0, the miss update sets image_backfill_attempted_at
-- and image_backfill_attempts. Both also set image_backfill_attempted_at, the KEY of idx_articles_image_backfill_attempted, so
-- neither was ever HOT-eligible: no HOT update is lost. Ingest inserts rows with attempts 0, outside the
-- predicate, so an insert adds no entry; an entry appears when the consumer records a first or second miss
-- (about 21 a hour) and goes dead when the row gets an image or a third miss. The write cost is negligible.
--
-- GENERIC PLAN. A partial index is usable only when the planner can prove the query implies the predicate. Here
-- the predicate is made of constants in the function's own text (image_url is null, between 1 and 2), not of
-- parameters, so a generic plan proves it as well as a custom plan; only the LIMIT is a variable (v_limit).
-- pg_cron opens a new session for every run, so the function is planned fresh each time anyway.
--
-- VERIFY (read-only, after applying; copy the loop query from pg_get_functiondef):
--   1. explain (analyze, buffers, timing off) select a.id from public.articles a where a.image_url is null and a.image_backfill_attempts between 1 and 2 and a.image_backfill_attempted_at < pg_catalog.now() - interval '2 hours' and a.created_at > pg_catalog.now() - interval '7 days' and a.id::text not in (select q.message ->> 'article_id' from pgmq.q_image_backfill q where q.message ->> 'article_id' is not null) order by a.created_at desc limit 40;
--      expect Index Scan using articles_image_requeue_idx (not idx_articles_created_at),
--      Rows Removed by Filter under 100 (about 20), buffers under 500 (hit + read) and Execution Time under
--      50 ms. Today: 69,178 rows removed, 30,901 buffers and 3,322 ms.
--   2. select indisvalid, indisready from pg_catalog.pg_index where indexrelid = 'public.articles_image_requeue_idx'::regclass;
--      expect t, t. select pg_size_pretty(pg_relation_size('public.articles_image_requeue_idx')); expect under 5 MB
--      (about 1.9 MB, 3.6 MB at the most).
--   3. Over the next 24 h the job's average falls under 0.5 s (3.40 s today):
--      select avg(end_time - start_time), max(end_time - start_time) from cron.job_run_details
--       where jobid = (select jobid from cron.job where jobname = 'image-backfill-requeue') and start_time > now() - interval '24 hours';
--   4. image_backfill_requeue sends the same rows as before: compare the pgmq.a_image_backfill and
--      pgmq.q_image_backfill counts per day (the 24 h before and after the apply) and the number of messages the
--      job's ticks put on the queue; the dry-run proved the identical id list.
--
-- Safe to re-apply: create index if not exists, ledger insert `on conflict do nothing`. Additive: nothing is
-- dropped, altered, granted, analyzed or written to a public table. No function change, no cron change.
--
-- ROLLBACK (nothing here changes data shape):
--   drop index concurrently if exists articles_image_requeue_idx;
--   delete from supabase_migrations.schema_migrations where version = '201';
--
-- See tests/migrations/201-image-requeue-index.test.ts and tests/migrations/sql/201-image-requeue-index-dryrun.sql.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 0. Guard: a cancelled CREATE INDEX CONCURRENTLY leaves an INVALID index that
--    `create index if not exists` would silently accept; and a table over 64 MB with
--    no pre-built index is refused instead of being locked for the whole build.
-- ---------------------------------------------------------------------------

do $guard$
declare
  v_bad text;
  v_size bigint;
begin
  select c.relname::text
    into v_bad
    from pg_catalog.pg_index i
    join pg_catalog.pg_class c on c.oid = i.indexrelid
   where c.relnamespace = 'public'::regnamespace
     and c.relname = 'articles_image_requeue_idx'
     and i.indisvalid = false;
  if v_bad is not null then
    raise exception '201: invalid index left by an aborted CREATE INDEX CONCURRENTLY: %. Run drop index concurrently articles_image_requeue_idx, then rebuild it (see the ORCHESTRATOR PRE-BUILD block in the header of 201_image_requeue_partial_index.sql).', v_bad;
  end if;

  -- Fail closed on a big table without the pre-built index (SEC-2, the 113 precedent): the create index below
  -- would otherwise run inside this transaction under a SHARE lock that blocks every write to articles.
  if pg_catalog.to_regclass('public.articles_image_requeue_idx') is null then
    v_size := pg_catalog.pg_relation_size('public.articles'::regclass);
    if v_size > 67108864 then
      raise exception '201: public.articles is % MB and articles_image_requeue_idx does not exist yet. Applying 201 now would build the index inside this transaction under a SHARE lock that blocks every write to articles (ingest, image-consumer) until the build ends or the 60 s statement_timeout fires. Run the ORCHESTRATOR PRE-BUILD first (CREATE INDEX CONCURRENTLY, in the header of 201_image_requeue_partial_index.sql), then re-apply 201.', (v_size / 1048576);
    end if;
  end if;
end
$guard$;

-- ---------------------------------------------------------------------------
-- The loop of public.image_backfill_requeue (154):
--   from public.articles a where a.image_url is null and a.image_backfill_attempts between 1 and 2 and ...
--   order by a.created_at desc limit v_limit
-- The predicate is the function's leading filter, the key is its order. The now()-relative bounds and the
-- queue guard stay residual filters: the index is the access path and the walk stops at the 7-day bound.
-- ---------------------------------------------------------------------------

create index if not exists articles_image_requeue_idx
  on public.articles (created_at desc)
  where image_url is null and image_backfill_attempts between 1 and 2;

insert into supabase_migrations.schema_migrations (version, name)
  values ('201', '201_image_requeue_partial_index')
  on conflict do nothing;

commit;
