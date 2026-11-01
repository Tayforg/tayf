-- 142_image_backfill_retry.sql
--
-- An hourly, bounded re-send of articles whose og:image backfill failed and was never
-- tried again (h15-images-2). public.image_backfill_requeue(p_limit) puts articles that
-- are still image-less after 1 to 4 attempts back on the pgmq image_backfill queue, and
-- the pg_cron job image-backfill-requeue calls it at minute 17 of every hour. It makes the
-- image-consumer's existing 5-attempt / park logic reachable. No article row is written
-- and no index is added.
--
-- WHY (evidence: production, read-only, 2026-11-01)
--   * The only enqueue onto image_backfill is the AFTER INSERT trigger articles_image_enqueue
--     (025, WHEN NEW.image_url IS NULL); 084 enqueued once by hand. There is no AFTER UPDATE
--     image trigger and no resweep job: cron.job holds only image-drain (*/5) for this path.
--     The image-consumer header nevertheless said "We do NOT requeue - the AFTER UPDATE
--     trigger and the safety-net resweep handle re-discovery", so IMG_BACKFILL_MAX_ATTEMPTS
--     = 5 and the park branch of bumpAttempt could never be reached.
--   * Articles with image_url null and published_at in the last 10 days, by attempts:
--     attempts 0 -> 2, attempts 1 -> 7,464, attempts >= 2 -> 0. Every miss was single-shot.
--   * The misses are recoverable. The haberler.com article
--     /politika/dort-parti-genel-baskani-necmettin-erbakan-in-100-20384346-haberi/ (cluster
--     7ecc94c8-06c5-4e1e-b0cf-017235a1eaa6, attempts 1, tried 2026-10-31 20:40 UTC) serves
--     https://foto.haberler.com/haber/2026/10/31/dort-parti-genel-baskani-necmettin-erbakan-in-20384346_amp.jpg
--     when fetched on 2026-11-01. In the hunter's sample, 11 of 34 haberler-com image-less
--     cluster pages, ekonomim 2 of 2 and haber7 1 of 1 now expose a valid og:image; 178 of
--     2,116 clusters updated in 48 hours have no hero image.
--
-- WHAT CHANGES (pinned by tests/migrations/142-image-backfill-retry.test.ts)
--   1. public.image_backfill_requeue(p_limit integer default 300) returns integer: security
--      definer, search_path = '', volatile. It selects articles with image_url null,
--      image_backfill_attempts between 1 and 4, image_backfill_attempted_at older than
--      2 hours and created_at within 7 days, newest first, at most
--      least(greatest(coalesce(p_limit, 300), 1), 1000), and not already in
--      pgmq.q_image_backfill (a NULL-safe NOT IN on the article_id of each message). For
--      each it calls pgmq.send('image_backfill', {article_id}). It returns the number sent.
--      EXECUTE: revoked from public, anon, authenticated; granted to service_role only.
--      Nothing is granted on pgmq (the 024-028 tripwire stays green).
--   2. pg_cron job image-backfill-requeue, '17 * * * *', body
--      set statement_timeout = '60s'; select public.image_backfill_requeue(150);
--      Scheduled by name: an existing job of that name is unscheduled first, no other job
--      is touched (image-drain and ingest-drain are not mentioned in any cron call), and
--      without pg_cron the block raises a notice and skips.
--   3. notify pgrst 'reload schema', and the ledger row in the 095 pattern.
--   No table, column, index, trigger or data change. The image-consumer is unchanged in
--   behaviour: it still writes image_url only when it finds an image, bumps the attempt
--   counters on a miss, and parks the row on the 5th failure.
--
-- RETRY BUDGET
--   Each article gets at most 4 more tries, about 2-3 h apart (the 2 h gate plus the hourly tick).
--   The 5th failure parks it: bumpAttempt pushes image_backfill_attempted_at 7 days ahead and
--   attempts reaches 5, so the row leaves the candidate set (and the created_at bound is the
--   same 7 days). Rows already queued are skipped, so a backlog never doubles. Rows whose
--   image_backfill_attempted_at is null are excluded by design (nothing to compare the gate to).
--   Cost: ≤ 150 extra og:image fetches per hour (≤ 24·150 = 3,600/day). At the measured rate of
--   about 21 new failures per hour the steady state is lower (4 x 21 = 84 per hour at most);
--   the 150 cap only bounds the first days, while the 5,536 backlog rows wait their turn,
--   newest first (about 37 hourly ticks for one pass over the backlog).
--
-- STEP 0 (production, read-only, 2026-11-01 about 21:55 UTC, SELECT only via sbq; nothing applied)
--   a) Ledger: select version from supabase_migrations.schema_migrations where version in
--      ('139','140','141','142') -> 139 and 140 only (141 is reserved for the neutral-title
--      wave and not applied; 142 is free).
--   b) select jobname, schedule from cron.job order by 1 -> 40 jobs; image-backfill-requeue is
--      absent; image-drain is '*/5 * * * *'; ingest-drain '*/3 * * * *'.
--   c) Candidates now (image_url null, attempts 1..4, attempted_at older than 2 hours,
--      created within 7 days): 5,536.
--   d) New failures per hour: image_url null and attempts >= 1 among the articles created in
--      the last 24 hours: 505, so 21.0 per hour. 4 x 21.0 = 84 is below the default 150, so
--      N stays 150 (the "raise N" rule did not fire).
--   e) Consumer throughput: pgmq.a_image_backfill rows archived in the last 6 hours: 283, so
--      47.2 per hour on average; the busiest hour of the last 24 held 121 (08:00 UTC). In each
--      of the last 16 hours the longest queue wait was at most 304 s, so every */5 tick drains
--      the queue empty (demand-limited, not capacity-limited), and the biggest burst was 54
--      messages inside 11 s. The consumer is serial and keeps reading batches of 20 while less
--      than 25 s of its 30 s wall budget is spent, so 150 messages need about 3 ticks.
--   f) select * from pgmq.metrics('image_backfill') -> queue_length 1, oldest_msg_age_sec 199,
--      total_messages 160,530.
--
-- EXPLAIN (production, read-only, EXPLAIN (ANALYZE, BUFFERS) of the function's inner select with
-- the literals, the anti-duplicate subquery and limit 150, 2026-11-01)
--   Limit  (actual time=0.795..3.521 rows=150 loops=1)
--     Buffers: shared hit=1087
--     ->  Index Scan using idx_articles_created_at on articles a  (rows=150)
--           Index Cond: (created_at > (now() - '7 days'::interval))
--           Filter: image_url IS NULL, attempts 1..4, attempted_at < now() - 2 h, NOT (id::text = ANY (hashed SubPlan 1))
--           Rows Removed by Filter: 2349
--         SubPlan 1: Seq Scan on q_image_backfill q (rows=1), Buffers: shared hit=1
--   Planning Time: 1.936 ms
--   Execution Time: 3.650 ms
--   Worst case, when fewer than 150 candidates are left and the scan walks the whole 7 days
--   (the same select with limit 100000, 5,536 rows returned):
--     Index Scan using idx_articles_created_at, Rows Removed by Filter: 60878,
--     Buffers: shared hit=33792 read=2551, Execution Time: 2685.227 ms
--   The index is the existing btree on created_at (desc); the planner walks it newest first and
--   stops at the limit. The worst case is about 2.7 s once an hour, well inside the 60 s
--   statement_timeout of the job.
--
-- NO NEW INDEX
--   The existing created_at index already serves the bound, the limit stops the scan early while a
--   backlog exists, and the full-range worst case costs 2.7 s per hour. A new index on public.articles
--   would need the 101/127 ORCHESTRATOR PRE-BUILD pattern (CREATE INDEX CONCURRENTLY by the
--   operator): a plain CREATE INDEX takes a SHARE lock that blocks ingest writes for the whole build.
--   If the worst case ever matters, a partial index (created_at) where image_url is null is the
--   follow-up, built concurrently first.
--
-- DRY RUNS (x2) (local PG15.12, throwaway cluster scratchpad/pg-an-d on port 55473, 2026-11-01;
-- the shared stub schema (jevtest/qa/stub.sql: roles anon, authenticated, service_role,
-- supabase_migrations.schema_migrations, public.sources/articles) plus, added in a scratch setup
-- and not in this file: usage on schema public for the three roles; a stub pgmq (schema pgmq,
-- table pgmq.q_image_backfill(msg_id bigserial, message jsonb), function pgmq.send(text, jsonb,
-- integer default 0) returns setof bigint that inserts into it); articles columns image_url,
-- image_backfill_attempts, image_backfill_attempted_at, created_at; the ledger rows 139 and 140;
-- eleven fixture articles: A1 attempts 1 tried 3 h ago created 2 d ago, A2 attempts 4 tried 3 h ago
-- created 1 d ago, A11 attempts 2 tried 5 h ago created 1 h ago (these three are eligible);
-- A3 attempts 0, A4 attempts 5 parked 7 d ahead, A5 tried 1 h ago, A6 gate 1 d ahead, A7 created
-- 8 d ago, A8 has an image, A9 eligible but already queued, A10 attempted_at null (all excluded);
-- the queue held A9 and one message without article_id). Each run was
-- psql -v ON_ERROR_STOP=1 -f 142_image_backfill_retry.sql, applied twice per database:
--   run 1 (database without pg_cron; apply 1)
--           BEGIN, SET, CREATE FUNCTION, COMMENT, REVOKE, GRANT,
--           NOTICE `142: pg_cron missing, skipping the image-backfill-requeue schedule.`,
--           DO, NOTIFY, INSERT 0 1, COMMIT
--   run 1 (apply 2) the same statements, no error, the same notice; the ledger insert is INSERT 0 0
--   run 2 (database with a fake cron schema like 136's: cron.job, cron.schedule, cron.unschedule
--           and a pg_extension row, holding other-job '*/7 * * * *', image-drain '*/5 * * * *'
--           and ingest-drain '*/3 * * * *'; apply 1)
--           BEGIN, SET, CREATE FUNCTION, COMMENT, REVOKE, GRANT, DO, NOTIFY, INSERT 0 1, COMMIT
--   run 2 (apply 2) the same, no notice; the ledger insert is INSERT 0 0
--   After   cron.job: exactly one image-backfill-requeue at '17 * * * *' with the command
--           ` set statement_timeout = '60s'; select public.image_backfill_requeue(150); `; other-job,
--           image-drain and ingest-drain unchanged. A third apply over a job drifted to '5 5 * * *'
--           put it back to '17 * * * *' (unschedule then schedule).
--   Function (same results in both databases)
--           image_backfill_requeue(2) -> 2, queued in order A11 (b1) then A2 (a2): newest first;
--           image_backfill_requeue() -> 1 (A1); again -> 0 (everything eligible is already queued,
--           and the message without article_id does not poison the NOT IN guard); the queue holds
--           the two original messages plus exactly three new ones. After deleting the three new
--           messages: p_limit 0 -> 1, p_limit -5 -> 1, p_limit null -> 1 (clamped to 1..1000, null
--           treated as 300), sent in the order b1, a2, a1.
--   Grants  has_function_privilege: anon f, authenticated f, service_role t. As anon and as
--           authenticated: `permission denied for function image_backfill_requeue`. As service_role:
--           returns the count. proacl {postgres=X/postgres,service_role=X/postgres}; prosecdef t,
--           provolatile v, proconfig search_path="".
--   Data    md5 over public.articles before and after the calls: equal (no article row written).
--   Ledger  139, 140, 142 (142_image_backfill_retry).
--   Test counts: tests/migrations/142-image-backfill-retry.test.ts, 42 static contract tests, all pass.
--
-- DEPLOY: APPLY 142 (operator, docs/migration-guide.md); NO EDGE DEPLOY IS REQUIRED
--   1. Apply this file. It creates one function and one cron job, takes no table lock, and does not
--      rewrite data. The first run of the job is at the next minute :17.
--   2. supabase/functions/image-consumer changes in the same PR (the header comment, and an 8 s fetch
--      timeout for the three hero-image slugs instead of 5 s) can be deployed any time:
--      supabase functions deploy image-consumer --no-verify-jwt. The requeue works with the deployed
--      consumer unchanged.
--   3. The first ticks re-send the newest 150 of the 5,536 backlog rows each hour; the consumer drains
--      them over the next */5 ticks. Rows that still have no og:image count up to attempts 5 and park.
--
-- VERIFY (read-only):
--   select jobname, schedule from cron.job where jobname = 'image-backfill-requeue';  -- one row, 17 * * * *
--   select has_function_privilege('anon', 'public.image_backfill_requeue(integer)', 'execute'),
--          has_function_privilege('authenticated', 'public.image_backfill_requeue(integer)', 'execute'),
--          has_function_privilege('service_role', 'public.image_backfill_requeue(integer)', 'execute');
--      -- expect f, f, t
--   after the first :17 tick:
--   select status, return_message, start_time from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'image-backfill-requeue')
--    order by start_time desc limit 3;                                   -- succeeded
--   select * from pgmq.metrics('image_backfill');                         -- depth up by about 150, then back to 0
--   select image_backfill_attempts, count(*) from public.articles
--    where image_url is null and created_at > now() - interval '3 days'
--    group by 1 order by 1;                                               -- attempts 2..5 appear over the next hours
--
-- ROLLBACK (nothing else depends on 142; run by the operator)
--   select cron.unschedule('image-backfill-requeue');
--   drop function public.image_backfill_requeue(integer);
--   delete from supabase_migrations.schema_migrations where version = '142';
--   Messages already on the queue are ordinary image_backfill messages; the consumer drains them.
--
-- Additive. Safe to re-apply (create or replace function, unschedule-if-exists then schedule, ledger
-- insert on conflict do nothing; the revoke and the grant are idempotent). One transaction. No table
-- or column change, no index, no trigger, no data rewrite, no write to public.*: the function's only
-- effect is pgmq.send. No grant to anon or authenticated.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. public.image_backfill_requeue(p_limit): re-send still image-less articles.
-- ---------------------------------------------------------------------------

create or replace function public.image_backfill_requeue(p_limit integer default 300)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 300), 1), 1000);
  v_sent  integer := 0;
  r       record;
begin
  for r in
    select a.id
      from public.articles a
     where a.image_url is null
       and a.image_backfill_attempts between 1 and 4
       and a.image_backfill_attempted_at < pg_catalog.now() - interval '2 hours'
       and a.created_at > pg_catalog.now() - interval '7 days'
       and a.id::text not in (
             select q.message ->> 'article_id'
               from pgmq.q_image_backfill q
              where q.message ->> 'article_id' is not null
           )
     order by a.created_at desc
     limit v_limit
  loop
    perform pgmq.send(
      'image_backfill',
      pg_catalog.jsonb_build_object('article_id', r.id)
    );
    v_sent := v_sent + 1;
  end loop;

  return v_sent;
end;
$fn$;

comment on function public.image_backfill_requeue(integer) is
  'Re-sends image-less articles to the pgmq image_backfill queue (migration 142). '
  'Picks articles with image_url null, 1 to 4 failed og:image attempts, the last '
  'attempt more than 2 hours ago and created within 7 days, newest first, at most '
  'p_limit (clamped to 1..1000, null means 300), and skips articles that already '
  'have a message in the queue. Writes no article row: the image-consumer bumps the '
  'attempt counters and parks the row after the 5th failure. Returns the number of '
  'messages sent. Run hourly by the image-backfill-requeue cron job. service_role only.';

revoke all on function public.image_backfill_requeue(integer) from public, anon, authenticated;
grant execute on function public.image_backfill_requeue(integer) to service_role;

-- ---------------------------------------------------------------------------
-- 2. pg_cron: image-backfill-requeue (hourly at minute 17). Scheduled by name; an
-- existing job of that name is unscheduled first; no other job is touched.
-- ---------------------------------------------------------------------------

do $cron$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    raise notice '142: pg_cron missing, skipping the image-backfill-requeue schedule.';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'image-backfill-requeue') then
    perform cron.unschedule('image-backfill-requeue');
  end if;

  perform cron.schedule('image-backfill-requeue', '17 * * * *',
    $sql$ set statement_timeout = '60s'; select public.image_backfill_requeue(150); $sql$);
end
$cron$;

-- 3. Schema cache and ledger ----------------------------------------------------

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('142', '142_image_backfill_retry')
  on conflict do nothing;

commit;
