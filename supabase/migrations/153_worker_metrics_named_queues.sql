-- 153_worker_metrics_named_queues.sql
--
-- public.worker_metrics (024) stops calling pgmq.metrics_all() and reads the two queues it has always
-- meant to expose by name: pgmq.metrics('cluster_work') UNION ALL pgmq.metrics('image_backfill'). One view,
-- same six columns, same ACL, nothing granted on pgmq. /api/health's queue probe works again (h28-live-1,
-- hunt 28, 2026-11-02; regression of 151).
--
-- WHY (evidence: production, read-only, 2026-11-02)
--   * GET https://www.tayfhaber.com/api/health at 20:32:45Z answered {"status":"degraded"}, and has since
--     151 (cluster_attach queue). pg_get_viewdef('public.worker_metrics') is FROM pgmq.metrics_all() WHERE
--     queue_name = ANY('{cluster_work,image_backfill}'). metrics_all() is SECURITY INVOKER (prosecdef f) and
--     loops over EVERY row of pgmq.meta before the WHERE runs, so it calls pgmq.metrics() for cluster_attach
--     too, which reads pgmq.q_cluster_attach and pgmq.q_cluster_attach_msg_id_seq with the CALLER's
--     privileges. service_role has neither (has_table_privilege and has_sequence_privilege false; true for
--     cluster_work and image_backfill), because 048 granted only the two queues that existed then and 151
--     deliberately granted nothing on the new one. The probe fails with 42501 "permission denied for
--     sequence q_cluster_attach_msg_id_seq" (Supabase postgres logs at 20:14:28, 20:22:32, 20:22:45 and
--     20:24:05Z); the same statement as `set local role service_role; select * from pgmq.metrics_all()` on
--     production returns the same error today (read-only check, 2026-11-02 21:08Z).
--   * src/app/api/health/route.ts reads the view with the service role, gets the 403, sets
--     checks.queues.ok = false, and the whole verdict becomes degraded. Impact: the queue depth and age
--     probe is blind, and any monitor reading `status` sees degraded all the time. ops_health_report() row 18
--     (150) reads pgmq through a definer, so it is unaffected. Not a security problem: it fails closed.
--   * tests/migrations/151-cluster-attach-probe.test.ts said "024 and 029 already give service_role its
--     access", which is false for metrics_all; that it() description is corrected in the same change (the
--     assertion is unchanged).
--
-- DESIGN DECISION: cluster_attach STAYS UNGRANTED ON PURPOSE
--   The alternative fix, `grant select on pgmq.q_cluster_attach` (and its sequence) to service_role, would
--   make the old view work again but breaks 151's invariant "nothing is granted on cluster_attach" and the
--   spirit of the 024-028 pgmq exposure tripwire (the pgmq schema is exposed to PostgREST; every extra grant
--   is queue-API surface). The consumer reaches cluster_attach through 024/029's definer path only. 153
--   therefore keeps cluster_attach ungranted on purpose, leaves the pgmq schema alone and changes the one
--   thing that was wrong: which queues the view asks about. pgmq.metrics(text) touches only the named queue (its table, its msg_id sequence,
--   format_table_name), so a queue nobody granted can never break the view again. The price: a queue created
--   in the future is NOT in the view unless somebody adds it. tests/migrations/153-worker-metrics-named-
--   queues.test.ts therefore fails on any pgmq.create('<q>') in supabase/migrations that is neither named in
--   this view nor listed in its EXCLUDED set with a reason (today: cluster_attach), and on any later
--   migration that goes back to metrics_all.
--
-- WHAT CHANGES (pinned by tests/migrations/153-worker-metrics-named-queues.test.ts, 37 static checks and a
-- 12 case live block, and the unchanged tests/migrations/024-028.test.ts tripwire)
--   1. create or replace view public.worker_metrics as
--        select queue_name, queue_length, newest_msg_age_sec, oldest_msg_age_sec, total_messages, scrape_time
--          from pgmq.metrics('cluster_work')
--        union all
--        select <the same six columns> from pgmq.metrics('image_backfill');
--      Same column names, order and types as 024 (text, bigint, integer, integer, bigint, timestamptz), so
--      create or replace is legal and PostgREST / route.ts see no change. No WITH options (024's view has
--      none; reloptions is null on production). pgmq.metrics() also returns queue_visible_length (pgmq
--      1.5.1); the view does not select it, exactly as 024's did not.
--   2. An updated comment on the view.
--   3. The same revoke and grant as 024 section 5: `revoke all on public.worker_metrics from public, anon,
--      authenticated; grant select on public.worker_metrics to service_role;`. NO grant, revoke or default
--      privilege on any pgmq object.
--   4. notify pgrst 'reload schema' and the ledger row in the 095 pattern.
--   No table, function, trigger, index, queue or data change; no cron job.
--
-- STEP 0 (production, read-only, 2026-11-02 ~21:00 UTC, SELECT only through sbq.py; nothing was applied)
--   a) The view. pg_get_viewdef('public.worker_metrics'::regclass) = ` SELECT queue_name, queue_length,
--      newest_msg_age_sec, oldest_msg_age_sec, total_messages, scrape_time FROM pgmq.metrics_all()
--      metrics_all(queue_name, queue_length, newest_msg_age_sec, oldest_msg_age_sec, total_messages,
--      scrape_time, queue_visible_length) WHERE (queue_name = ANY (ARRAY['cluster_work'::text,
--      'image_backfill'::text]));`, md5 0355d6fcc93744296eb7982e7889a184. That is 024 section 5 in
--      pg_get_viewdef's normal form (IN list shown as ANY array); nothing else defined it since (048 and 117
--      only touch grants): no drift. Columns from pg_attribute, in order: queue_name text, queue_length
--      bigint, newest_msg_age_sec integer, oldest_msg_age_sec integer, total_messages bigint, scrape_time
--      timestamp with time zone. reloptions null.
--      MISMATCH WITH THE BRIEF, recorded and carried: relacl is {postgres=arwdDxtm/postgres,
--      service_role=arwdDxtm/postgres}, i.e. service_role holds EVERY privilege on the view (a Supabase
--      default privilege that 024 never revoked from service_role), not select only. anon, authenticated and
--      PUBLIC hold nothing. 153 does not touch it: create or replace view keeps the ACL, the revoke targets
--      public, anon and authenticated only, and the view (a union all over function calls) is not updatable,
--      so the surplus bits cannot do anything. Tightening service_role to select is a separate decision.
--   b) extversion of pgmq 1.5.1. pgmq.metrics(text) (returns pgmq.metrics_result, SECURITY INVOKER, volatile)
--      and pgmq.send(queue_name text, msg jsonb, delay integer) both exist. pgmq.metrics_result columns:
--      queue_name text, queue_length bigint, newest_msg_age_sec integer, oldest_msg_age_sec integer,
--      total_messages bigint, scrape_time timestamptz, queue_visible_length bigint.
--   c) Privileges of service_role: execute on pgmq.metrics(text) true and on pgmq.format_table_name(text,text)
--      true; select on pgmq.q_cluster_work true, on pgmq.q_image_backfill true, on pgmq.q_cluster_attach
--      false; select on the sequences q_cluster_work_msg_id_seq true, q_image_backfill_msg_id_seq true,
--      q_cluster_attach_msg_id_seq false (usage is false on all three; pgmq.metrics() reads last_value, which
--      needs select); select on pgmq.meta true.
--   d) The fix, executed read-only on production as the role that reads the view:
--      `set local role service_role; select ... from pgmq.metrics('cluster_work') union all select ... from
--      pgmq.metrics('image_backfill')` returned 2 rows (cluster_work: depth 1, oldest 34 s, total 262,452;
--      image_backfill: depth 7, oldest 214 s, total 165,771). The old `select queue_name from
--      pgmq.metrics_all()` under the same role: 42501 permission denied for sequence
--      q_cluster_attach_msg_id_seq, raised in pgmq.metrics(text) called from metrics_all() (the CONTEXT shows
--      the cluster_attach CTE reading the sequence).
--
-- DRY RUNS (x2) (local PG15.12, two fresh throwaway clusters under scratchpad: pg-bh-w3-a on port 55731 and
-- pg-bh-w3-b on port 55732, 2026-11-02, 127.0.0.1 only; the shared stub schema (jevtest/qa/stub.sql) plus,
-- in tests/migrations/sql/153-worker-metrics-named-queues-dryrun.sql: a pgmq stand-in modelled on 1.5.1
-- (meta, q_ and a_ tables with an identity msg_id, metrics_result, format_table_name, metrics(text) and
-- metrics_all() as SECURITY INVOKER plpgsql that read the queue table and its sequence with the caller's
-- privileges), 024's and 048's grant model (service_role only, two queues), 024's view exactly as production
-- has it (viewdef above, relacl with service_role holding all), 151's cluster_attach queue with nothing
-- granted, a few messages (one invisible), ledger 150-152). Each run: psql -v ON_ERROR_STOP=1 -f stub.sql
-- -f the dry-run file, which ends with the line DRYRUN 153 OK. The two outputs are identical modulo line
-- numbers.
--   Before 153  as service_role, `select count(*) from public.worker_metrics` raises
--               NOTICE REGRESSION (expected): permission denied for sequence q_cluster_attach_msg_id_seq [42501]
--               (production's exact error).
--   apply 1     BEGIN, SET, CREATE VIEW, COMMENT, REVOKE, GRANT, NOTIFY, INSERT 0 1, COMMIT
--   apply 2     the same statements, no error; the ledger insert is INSERT 0 0
--   After       ledger 152 | 153 153_worker_metrics_named_queues; the stored definition is two
--               pgmq.metrics('<queue>'::text) calls under UNION ALL, no metrics_all; columns queue_name:text,
--               queue_length:bigint, newest_msg_age_sec:integer, oldest_msg_age_sec:integer,
--               total_messages:bigint, scrape_time:timestamp with time zone (byte-identical to the column
--               list before 153); relacl and reloptions unchanged (service_role keeps its privileges, null
--               options).
--   Behaviour   as service_role: `select queue_name, queue_length, newest_msg_age_sec, oldest_msg_age_sec,
--               total_messages from worker_metrics` returns cluster_work|1|600|600|1 and
--               image_backfill|2|1200|1500|2: exactly 2 rows, no 42501, while cluster_attach exists and holds
--               a message; the invisible message (vt 15 minutes ahead) is counted in the depth and in
--               oldest_msg_age_sec (pgmq.metrics counts every row; 154 depends on that fact).
--   Invariants  every ACL in the pgmq schema (relations, sequences, functions, the schema itself) is
--               byte-identical before and after 153 (md5 of the lists); service_role still cannot read
--               pgmq.q_cluster_attach, pgmq.a_cluster_attach or the sequence; anon and authenticated hold
--               nothing on them; `select * from pgmq.metrics_all()` as service_role STILL fails with 42501
--               (the reason the view had to change); anon and authenticated cannot read the view and hold no
--               privilege on it; PUBLIC holds none; the comment names both queues and 153.
--   Live block  tests/migrations/153-worker-metrics-named-queues.test.ts with TAYF_PSQL on the server the
--               dry run leaves behind: 12 cases, all passed (count 2 as service_role, the two names, the old
--               path still failing, cluster_attach still locked, columns and types, no options, the stored
--               definition, anon and authenticated denied, no PUBLIC entry, the ledger row).
--   Test counts: 37 static + 12 live in the 153 test; the 151 test (35 static) and 024-028 pass unchanged.
--
-- DEPLOY: APPLY 153 ONLY (then 154, docs/migration-guide.md); NO APP DEPLOY
--   1. Apply this file (operator, `supabase db push`). It replaces one view under lock_timeout = '5s' and
--      takes no other lock. src/app/api/health/route.ts is unchanged: it already reads worker_metrics.
--   2. Order with 154: 153 first, then 154. They are independent, but 154's cadence is chosen so that the
--      oldest_msg_age_sec this view reports (invisible messages included) stays far below the route's 1800 s
--      bound, and that only matters once the probe works again.
--
-- VERIFY (read-only):
--   select pg_get_viewdef('public.worker_metrics'::regclass);
--      -- two pgmq.metrics('cluster_work'::text) / ('image_backfill'::text) calls, UNION ALL, no metrics_all
--   begin; set local role service_role; select queue_name, queue_length, oldest_msg_age_sec from public.worker_metrics; rollback;
--      -- 2 rows, no 42501
--   select has_table_privilege('service_role', 'pgmq.q_cluster_attach', 'select');       -- still f
--   select has_table_privilege('anon', 'public.worker_metrics', 'select'),
--          has_table_privilege('authenticated', 'public.worker_metrics', 'select');       -- f, f
--   select relacl from pg_class where oid = 'public.worker_metrics'::regclass;           -- unchanged
--   select version, name from supabase_migrations.schema_migrations where version = '153';
--   GET /api/health after the apply -> "status":"healthy" (or degraded only for a real reason; the response
--   no longer carries checks.queues.error "permission denied for sequence ...").
--
-- ROLLBACK (nothing else depends on 153; run by the operator, in one transaction)
--   create or replace view public.worker_metrics as
--     select queue_name, queue_length, newest_msg_age_sec, oldest_msg_age_sec, total_messages, scrape_time
--       from pgmq.metrics_all()
--      where queue_name in ('cluster_work', 'image_backfill');
--   notify pgrst, 'reload schema';
--   delete from supabase_migrations.schema_migrations where version = '153';
--   That is 024's definition. Its price: /api/health goes back to degraded for as long as a queue that
--   service_role cannot read (cluster_attach) exists, and the queue probe is blind again. The ACL statements
--   need no repeat (create or replace keeps them).
--
-- Additive. Safe to re-apply (create or replace view, the revoke and the grant are idempotent, the comment is
-- replaced, the ledger insert is on conflict do nothing). One transaction. No table, function, trigger, index,
-- queue or data change, no cron job, no CONCURRENTLY step, no grant on any pgmq object and none to anon or
-- authenticated.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. public.worker_metrics over the two named queues. pgmq.metrics(text) touches only the
--    queue it is given (its table, its msg_id sequence, format_table_name), so a queue
--    nobody granted to service_role can never break the view. Same six columns, same
--    order, same types as 024's view; no WITH options (024's view has none).
-- ---------------------------------------------------------------------------

create or replace view public.worker_metrics as
  select queue_name, queue_length, newest_msg_age_sec, oldest_msg_age_sec, total_messages, scrape_time
    from pgmq.metrics('cluster_work')
  union all
  select queue_name, queue_length, newest_msg_age_sec, oldest_msg_age_sec, total_messages, scrape_time
    from pgmq.metrics('image_backfill');

comment on view public.worker_metrics is
  'pgmq queue depth + age of the two tayf work queues, cluster_work and image_backfill '
  '(migration 153; 024 filtered the all-queues function, which failed for service_role '
  'once the cluster_attach queue existed). Each branch calls pgmq.metrics(<queue>) for one '
  'named queue, so a queue that service_role cannot read never breaks the view; a new queue '
  'must be added here on purpose (tests/migrations/153-worker-metrics-named-queues.test.ts). '
  'oldest_msg_age_sec counts invisible (delayed) messages too. Read by /api/health (alerts '
  'when queue_length or oldest_msg_age_sec exceeds its bound). Operational data: service_role '
  'only.';

-- Same statements as 024 section 5: nothing for the client roles, select for service_role.
revoke all on public.worker_metrics from public, anon, authenticated;
grant select on public.worker_metrics to service_role;

-- 2. Schema cache and ledger ----------------------------------------------------

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('153', '153_worker_metrics_named_queues')
  on conflict do nothing;

commit;
