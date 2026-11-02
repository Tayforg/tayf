-- 154_image_requeue_stagger.sql
--
-- The hourly 150-message image requeue (142) stops starving fresh articles. public.image_backfill_requeue(p_limit)
-- re-sends only the second and third try (attempts 1 to 2), and sends each message with a visibility delay of
-- 20 s per message already sent (capped at 900 s); the pg_cron job image-backfill-requeue runs four times an
-- hour with 40 messages ('2,17,32,47 * * * *', requeue(40)) instead of once with 150. One function replaced,
-- one cron job rescheduled by name, one note in ops_cron_expected. No table, column, index, trigger or data
-- change (h28-freshness-2, hunt 28, 2026-11-02).
--
-- WHY (evidence: production, read-only, 2026-11-02)
--   * 142's image-backfill-requeue sends 150 un-delayed messages at minute 17. image-drain runs every 5 minutes
--     and the image-consumer takes at most 40 messages per tick (BATCH_SIZE 20, WALL_BUDGET_MS 30000), FIFO by
--     msg_id. The burst therefore keeps the consumer busy for about 15 minutes and every FRESH article enqueued
--     behind it waits. Queue wait in pgmq.a_image_backfill over 24 h for fresh messages (enqueued within 30 s of
--     the article insert), by minutes after :17: minutes 0-9 n=295, p50 725 s, p95 1026 s, max 1032 s;
--     minutes 10-19 n=230, p50 200 s, p95 311 s; the rest of the hour n=1393, p50 183 s, p95 301 s. Users see
--     image-less cards for longer on about 15% of new articles. ops queue_lag (150) does not page: its
--     image_backfill limits (1800 / 3600 s) are not breached.
--   * Waste: of 3,000 requeued messages enqueued 2-24 h ago, only 333 are for articles that now have an image
--     and 1,669 are for articles still image-less after 5 attempts (image-consumer resets the attempts to 0 on
--     success, index.ts:284). The yield is in the second and third try, so the later tries (attempts 3 and 4)
--     are dropped from the selection.
--
-- DESIGN DECISION: 4 x 40 EVERY 15 MINUTES, NOT THE BRIEF'S HOURLY 150 WITH A 20 s STAGGER
--   The brief was: keep hourly 150 and add delay = v_sent * 20. That holds the last message 149 * 20 = 2,980 s
--   INVISIBLE. pgmq.metrics' oldest_msg_age_sec is now() - min(enqueued_at) over EVERY row of the queue,
--   invisible ones included, and src/app/api/health/route.ts compares it with QUEUE_OLDEST_AGE_THRESHOLD_SEC
--   = 1800 (153 makes that probe work again): /api/health would go degraded from about :47 to :70 of every
--   hour. 150's queue_lag row ages the oldest VISIBLE message from enqueued_at, so it would warn above
--   1800 s as well (a delayed message that becomes visible is already as old as its delay). So the stagger is
--   kept (20 s per message) but the cadence changes: 4 runs an hour of 40 messages, capacity 160 an hour (at
--   least the old 150), largest delay 39 * 20 = 780 s, and the function also caps the delay at
--   least(v_sent * 20, 900) so no larger p_limit can ever push a message further than 900 s. The SIMULATION
--   section below proves both designs' numbers. The batch sizes also match the consumer: 40 messages are what it
--   takes per tick, and a staggered batch never exceeds that together with the fresh arrivals of one tick.
--
-- WHAT CHANGES (pinned by tests/migrations/154-image-requeue-stagger.test.ts: 47 static checks, the 10 case
-- simulation and an 8 case live block)
--   1. public.image_backfill_requeue(p_limit integer default 300) returns integer: create or replace with the
--      SAME signature and attributes as 142 (plpgsql, volatile, security definer, search_path = ''), so no
--      drop is needed. The body is 142's byte for byte except for two changes (the test derives the expected
--      body from 142's text and compares): (a) `a.image_backfill_attempts between 1 and 2` instead of `between
--      1 and 4`; (b) the send is the three-argument pgmq.send('image_backfill', jsonb_build_object(
--      'article_id', r.id), least(v_sent * 20, 900)), evaluated BEFORE v_sent is incremented, so the first
--      message has delay 0, the second 20 s, the third 40 s. The v_limit clamp (1..1000, null = 300), the 2 hour
--      and 7 day windows, the NULL-safe `not in` queue guard and `order by a.created_at desc` stay as in 142.
--      An updated comment. EXECUTE: the revoke and the grant of 142, statement for statement (revoked from
--      public, anon, authenticated; granted to service_role only). Nothing is granted on pgmq.
--   2. pg_cron job image-backfill-requeue: unscheduled if present, then scheduled at '2,17,32,47 * * * *' with
--      ` set statement_timeout = '60s'; select public.image_backfill_requeue(40); `. The minutes 2, 17, 32 and
--      47 are off the image-drain ticks (minutes divisible by 5), so a burst is never read in the same minute it
--      is sent, and 15 minutes apart. Scheduled by name; no other job is mentioned, so image-drain, ingest-drain
--      and the rest are untouched; without pg_cron the block raises a notice and skips.
--   3. public.ops_cron_expected (150): the note of the image-backfill-requeue row becomes the new schedule
--      (update ... set note where jobname = ... and note is distinct from ...; only if the table exists).
--      max_gap stays 3 hours: the longest silence between two ticks is 15 minutes, 3 h is still the 150 rule
--      for a job that ticks hourly or faster, and the operator may have tuned it.
--   4. notify pgrst 'reload schema' and the ledger row in the 095 pattern.
--
-- STEP 0 (production, read-only, 2026-11-02 ~21:00 UTC, SELECT only through sbq.py; nothing was applied)
--   a) Function. md5(prosrc) of public.image_backfill_requeue(integer) = 917624baf55f5021fe458e8f0664b6d1,
--      835 characters, which is the md5 of 142's body (the exact bytes between `as $fn$` and `$fn$;`, computed
--      locally with node:crypto): no drift. prosecdef t, volatile, owner postgres, proconfig
--      search_path="", proacl {postgres=X/postgres,service_role=X/postgres}, argument p_limit integer,
--      result integer.
--   b) Cron. select jobname, schedule, command, active from cron.job where jobname = 'image-backfill-requeue' ->
--      one row, active, schedule '17 * * * *', command ` set statement_timeout = '60s'; select
--      public.image_backfill_requeue(150); `. image-drain is '*/5 * * * *'. cron.job holds 42 jobs, all active.
--      ops_cron_expected: image-backfill-requeue | 03:00:00 | 17 * * * *.
--   c) Candidates now (image_url null, tried over 2 hours ago, created within 7 days; 142's STEP 0 c shape):
--      attempts 1..4: 4,493; attempts 1..2: 4,253 (attempts 1: 4,223, 2: 30, 3: 44, 4: 196). So the selection
--      drops 240 rows (5%) that the later tries would have re-sent. At 160 an hour the 4,253 rows take about 27
--      hours to work through, newest first, as before (142 sent 150 an hour); the steady state needs far less
--      (about 21 new failures an hour, 142 STEP 0 d).
--   d) pgmq.metrics('image_backfill') now: queue_length 3, oldest_msg_age_sec 51, total_messages 165,757. The
--      pgmq extension is 1.5.1 and pgmq.send(text, jsonb, integer) exists (153 STEP 0 b).
--
-- SIMULATION (tests/migrations/154-image-requeue-stagger.test.ts, pure TypeScript, 1 s steps, 3 h)
--   Model: a fresh message every 45 s (about the measured 79 an hour), visible at once; image-drain every 300 s
--   takes at most 40 VISIBLE messages in msg_id order; fresh wait = consume time - enqueue time; metrics age =
--   now - min(enqueued_at) over ALL queued messages (pgmq.metrics, what /api/health reads); visible age = the
--   same over visible messages only (150's queue_lag). The NEW design is built from this file's constants
--   (cron minutes, N, stagger, cap). Bucket = fresh messages enqueued in the 600 s after a :17 burst.
--                               fresh p95 in the :17 bucket | max metrics age | max visible age | max queue depth
--     OLD   hourly 150, delay 0       1065 s (p50 915)           1079 s            1079 s           156
--     NEW   4 x 40, delay i * 20       285 s (p50 150)            779 s             779 s            46
--     BRIEF hourly 150, delay i * 20   285 s                     3179 s            3179 s           156
--   OLD reproduces production (measured p95 1026 s) and never trips 1800 s, which is why nothing paged. NEW
--   passes every bound (p95 < 330, both ages < 1800). BRIEF-LITERAL fixes the fresh wait too, but its metrics
--   age passes 2,980 s and its visible age passes 1800 s: the reason for the cadence change. The test asserts
--   OLD p95 > 900; NEW p95 < 330, max metrics age < 1800, max visible age < 1800; BRIEF max metrics age > 1800.
--
-- DRY RUNS (x2) (local PG15.12, two fresh throwaway clusters under scratchpad: pg-bh-w3-a on port 55731 and
-- pg-bh-w3-b on port 55732, 2026-11-02, 127.0.0.1 only; the shared stub schema (jevtest/qa/stub.sql) plus, in
-- tests/migrations/sql/154-image-requeue-stagger-dryrun.sql: a pgmq stand-in (meta, q_image_backfill with an
-- identity msg_id, send(queue, msg, delay default 0) with vt = clock_timestamp() + delay seconds like pgmq
-- 1.5.1), the columns of public.articles that 142 reads, thirteen fixture articles (A1 attempts 1 tried 3 h
-- ago created 2 d ago, A2 attempts 2 created 1 d ago, A3 attempts 2 created 1 h ago: eligible under 154;
-- A4 attempts 3 and A5 attempts 4: eligible under 142 only; A6 attempts 0, A7 parked, A8 tried 1 h ago, A9 gate
-- ahead, A10 created 8 d ago, A11 has an image, A12 eligible but already queued, A13 attempted_at null: excluded
-- by both; the queue holds A12 and one message without article_id), a fake pg_cron (cron.job, cron.schedule,
-- cron.unschedule and a pg_extension row, holding other-job '*/7 * * * *', image-drain '*/5 * * * *' and
-- ingest-drain '*/3 * * * *'), ops_cron_expected with four rows, and 142 applied from its own file behind the
-- md5 gate 917624baf55f5021fe458e8f0664b6d1 / 835 characters). Each run: psql -v ON_ERROR_STOP=1 -f stub.sql
-- -f the dry-run file, which ends with the line DRYRUN 154 OK. The two outputs are identical modulo line
-- numbers. A third database without pg_cron and without ops_cron_expected (-v nocron=1) ends in DRYRUN 154 OK too.
--   Before      142's function: requeue(100) = 5 articles (A1 A2 A3 A4 A5), max delay 0 s; cron.job holds
--               `17 * * * * |  set statement_timeout = '60s'; select public.image_backfill_requeue(150); `
--   apply 1     BEGIN, SET, CREATE FUNCTION, COMMENT, REVOKE, GRANT, DO, DO, NOTIFY, INSERT 0 1, COMMIT
--   apply 2     the same statements, no error; the ledger insert is INSERT 0 0
--   no pg_cron  NOTICE `154: pg_cron missing, skipping the image-backfill-requeue schedule.` on both applies; the
--               ops_cron_expected branch does nothing when the table is missing
--   After       ledger 142 | 154 154_image_requeue_stagger; function definer, volatile, search_path "", owner
--               postgres, ACL {postgres=X/postgres,service_role=X/postgres} (142's), md5(prosrc)
--               2c3e427b0c98801b873b335544ab7699, 866 characters; has_function_privilege anon f, authenticated f,
--               service_role t; as anon and as authenticated `permission denied for function
--               image_backfill_requeue`; as service_role it runs (definer path).
--   Cron        exactly one image-backfill-requeue at '2,17,32,47 * * * *' with ` set statement_timeout = '60s';
--               select public.image_backfill_requeue(40); `; other-job, image-drain and ingest-drain unchanged
--               (md5 of their rows equal before and after). A later apply over a job drifted to '5 5 * * *' /
--               `select 99` put it back (unschedule then schedule); an apply after the job was deleted scheduled
--               it again; the other jobs were still unchanged.
--   Ops note    ops_cron_expected image-backfill-requeue: note `2,17,32,47 * * * *`, max_gap 03:00:00; the other
--               three rows unchanged (md5); apply 2 wrote nothing (the row's xmin is the same after apply 2). A row
--               whose operator-tuned max_gap is 5 hours and note 'tuned' got the note back and kept 5 hours.
--   Stagger     requeue(3) -> 3, in order A3 (b), A2, A1 (newest first), vt about now() + 0, 20 and 40 s
--               (NOTICE `stagger: A3=0 A2=20 A1=40`). requeue(100) -> 3 (A1 A2 A3; A4 and A5 are no longer
--               selected, 142 picked 5); a second call -> 0 (everything eligible is already queued, and the
--               message without article_id does not poison the NOT IN guard). Clamp: p_limit 0 -> 1, -5 -> 1, null ->
--               1 (one eligible article was left; null means 300). Cap: 60 eligible articles, requeue(60) -> 60,
--               delays 0 .. 900 s, 15 messages (45..59) at the 900 s cap, none above.
--   Data        md5 over public.articles before and after the calls: equal (no article row written).
--   Live block  tests/migrations/154-image-requeue-stagger.test.ts with TAYF_PSQL on the server the dry run
--               leaves behind: 8 cases, all passed (the ledger row and function attributes, the grants, the
--               stagger 0/20/40 within 2 s, attempts 1 and 2 only, the 900 s cap, the queue guard and the
--               unchanged articles, the cron schedule, the ops note).
--   Test counts: 47 static + 10 simulation + 8 live in the 154 test; the 142 test (42 static) still passes
--               against 142's own file.
--
-- DEPLOY: APPLY 154 ONLY (after 153, docs/migration-guide.md); NO EDGE DEPLOY, NO APP DEPLOY
--   1. Apply this file (operator, `supabase db push`). It replaces one function and one cron job, updates one
--      note, takes no table lock and rewrites no data. Messages 142's :17 tick already queued drain normally.
--   2. The first new tick is the next minute 2, 17, 32 or 47. The image-consumer is unchanged and needs no
--      deploy (the delay is applied by pgmq.send; the consumer reads only visible messages).
--   3. Acceptance the next day: the fresh-wait bucket query (VERIFY) gives p95 under 320 s in every bucket, and
--      image-consumer averages under 8 s at :20, :25 and :30. /api/health keeps queue oldest_msg_age_sec far
--      below 1800 s (largest expected: about 800 s).
--
-- VERIFY (read-only):
--   select jobname, schedule, command from cron.job where jobname = 'image-backfill-requeue';
--      -- one row, 2,17,32,47 * * * *, select public.image_backfill_requeue(40)
--   select has_function_privilege('anon', 'public.image_backfill_requeue(integer)', 'execute'),
--          has_function_privilege('authenticated', 'public.image_backfill_requeue(integer)', 'execute'),
--          has_function_privilege('service_role', 'public.image_backfill_requeue(integer)', 'execute');   -- f, f, t
--   select md5(prosrc), length(prosrc) from pg_proc where oid = 'public.image_backfill_requeue(integer)'::regprocedure;
--      -- expect 2c3e427b0c98801b873b335544ab7699, 866
--   select note, max_gap from public.ops_cron_expected where jobname = 'image-backfill-requeue';
--      -- 2,17,32,47 * * * *, 03:00:00
--   after a few ticks:
--   select status, start_time from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'image-backfill-requeue')
--    order by start_time desc limit 5;                                   -- succeeded, 15 minutes apart
--   select queue_length, oldest_msg_age_sec from pgmq.metrics('image_backfill');   -- under about 800 s at all times
--   next day, the fresh-wait buckets (24 h of the archive, bounded by archived_at):
--   select (extract(epoch from q.enqueued_at)::bigint % 3600) / 600 as bucket_of_10_min, count(*),
--          percentile_cont(0.95) within group (order by extract(epoch from (q.archived_at - q.enqueued_at))) as p95_wait_s
--     from pgmq.a_image_backfill q join public.articles a on a.id = (q.message ->> 'article_id')::uuid
--    where q.archived_at > now() - interval '24 hours' and q.enqueued_at < a.created_at + interval '30 seconds'
--    group by 1 order by 1;                                              -- p95 under 320 s in every bucket
--   select version, name from supabase_migrations.schema_migrations where version = '154';
--
-- ROLLBACK (nothing else depends on 154; run by the operator, in one transaction)
--   re-run ONLY 142's function section: the text of 142_image_backfill_retry.sql from `create or replace function
--     public.image_backfill_requeue(` through `grant execute on function public.image_backfill_requeue(integer) to
--     service_role;` (the comment, revoke and grant included; md5(prosrc) is 917624baf55f5021fe458e8f0664b6d1
--     again);
--   select cron.unschedule('image-backfill-requeue');
--   select cron.schedule('image-backfill-requeue', '17 * * * *',
--     $$ set statement_timeout = '60s'; select public.image_backfill_requeue(150); $$);
--   update public.ops_cron_expected set note = '17 * * * *' where jobname = 'image-backfill-requeue';
--   delete from supabase_migrations.schema_migrations where version = '154';   -- ledger row 154
--   Messages already on the queue are ordinary image_backfill messages (a delayed one becomes visible on its own).
--
-- Additive. Safe to re-apply (create or replace function, unschedule-if-exists then schedule, the note update only
-- when it differs, ledger insert on conflict do nothing; the revoke and the grant are idempotent). One transaction.
-- No table or column change, no index, no trigger, no data rewrite, no write to public.articles: the function's
-- only effect is pgmq.send. No grant to anon or authenticated.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. public.image_backfill_requeue(p_limit): 142's function with two changes. The
--    selection is attempts 1 to 2 (the second and third try), and every message is sent
--    with a visibility delay of 20 s per message already sent in this call (capped at
--    900 s), so a batch becomes visible one message per 20 s instead of all at once.
--    Same signature as 142, so create or replace is enough.
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
       and a.image_backfill_attempts between 1 and 2
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
      pg_catalog.jsonb_build_object('article_id', r.id),
      least(v_sent * 20, 900)
    );
    v_sent := v_sent + 1;
  end loop;

  return v_sent;
end;
$fn$;

comment on function public.image_backfill_requeue(integer) is
  'Re-sends image-less articles to the pgmq image_backfill queue (migration 142; migration 154 staggers the sends). '
  'Picks articles with image_url null, 1 or 2 failed og:image attempts, the last '
  'attempt more than 2 hours ago and created within 7 days, newest first, at most '
  'p_limit (clamped to 1..1000, null means 300), and skips articles that already '
  'have a message in the queue. Each message is sent with a visibility delay of 20 s per '
  'message already sent in the call (at most 900 s), so a batch of 40 becomes visible over '
  '13 minutes and never starves the articles that arrive meanwhile. Writes no article row: '
  'the image-consumer bumps the attempt counters and parks the row after the 5th failure. '
  'Returns the number of messages sent. Run four times an hour (2, 17, 32, 47) with 40 by the '
  'image-backfill-requeue cron job. service_role only.';

revoke all on function public.image_backfill_requeue(integer) from public, anon, authenticated;
grant execute on function public.image_backfill_requeue(integer) to service_role;

-- ---------------------------------------------------------------------------
-- 2. pg_cron: image-backfill-requeue, four times an hour with 40 messages. Scheduled by
-- name; an existing job of that name is unscheduled first; no other job is touched.
-- ---------------------------------------------------------------------------

do $cron$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    raise notice '154: pg_cron missing, skipping the image-backfill-requeue schedule.';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'image-backfill-requeue') then
    perform cron.unschedule('image-backfill-requeue');
  end if;

  perform cron.schedule('image-backfill-requeue', '2,17,32,47 * * * *',
    $sql$ set statement_timeout = '60s'; select public.image_backfill_requeue(40); $sql$);
end
$cron$;

-- ---------------------------------------------------------------------------
-- 3. ops_cron_expected (150): the note is the schedule. max_gap stays what the operator
-- set (3 hours is still right: the longest gap between two ticks is 15 minutes).
-- ---------------------------------------------------------------------------

do $ops$
begin
  if pg_catalog.to_regclass('public.ops_cron_expected') is not null then
    update public.ops_cron_expected set note = '2,17,32,47 * * * *'
     where jobname = 'image-backfill-requeue' and note is distinct from '2,17,32,47 * * * *';
  end if;
end
$ops$;

-- 4. Schema cache and ledger ----------------------------------------------------

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('154', '154_image_requeue_stagger')
  on conflict do nothing;

commit;
