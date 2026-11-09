-- 188_pgmq_read_msgs_poll.sql
--
-- The long-poll twin of 029's public.pgmq_read_msgs: public.pgmq_read_msgs_poll(queue_name, vt, qty,
-- max_poll_seconds, poll_interval_ms), a SECURITY DEFINER shim over pgmq.read_with_poll, so the cluster
-- consumer can wait for ingest's insert INSIDE one invocation instead of finding the queue empty and leaving
-- (h101-e2elatency-1, hunt 101, 2026-11-09). One function added. No table, column, index, trigger, cron job or
-- data change; 029's shims are not touched.
--
-- WHY (evidence: production, read-only, 2026-11-09 08:35Z to 09:00Z)
--   * cron.job: ingest-drain runs '*/3 * * * *', cluster-drain runs '* * * * *'. Ingest inserts the articles of a
--     cycle in ONE transaction at about :04-:12 of its minute (every message of a cycle carries the same
--     enqueued_at; first message at second 5.8 at the median, 11.7 at the 90th percentile). The consumer of that
--     minute started at about :02 (median 2.3 s, 90th percentile 6.8 s), read cluster_work once, found nothing
--     and exited (cluster-consumer/index.ts breaks on an empty read). The messages were read by the NEXT minute's
--     consumer.
--   * pgmq.a_cluster_work, 24 h to 09:00Z (n = 1,250, read time = vt - 60 s, every message read once, max
--     read_ct 1, so no backlog and no retry): enqueue-to-read wait p50 54.8 s, p90 59.0 s, p99 67.3 s; 24.6 % under
--     10 s; 73.2 % between 40 and 65 s. Every message of the 24 h was enqueued in an ingest minute.
--   * pgmq 1.5.1 already has pgmq.read_with_poll(queue_name, vt, qty, max_poll_seconds, poll_interval_ms,
--     conditional), a plpgsql loop that re-reads until a message shows up or the wait is over. It is not reachable
--     from the Edge Functions: pgmq is not exposed through PostgREST (029), so a public shim is needed.
--
-- WHAT CHANGES
--   public.pgmq_read_msgs_poll(queue_name text, vt int, qty int, max_poll_seconds int, poll_interval_ms int)
--   returns setof pgmq.message_record (029's pgmq_read_msgs row type), language sql, SECURITY DEFINER,
--   search_path = '' with every identifier schema-qualified (029's pattern: a pg_temp shadow cannot reach the
--   body). Body: one select over pgmq.read_with_poll with the wait and the sleep step clamped.
--
--   WHY THE CLAMP: PostgREST connects as `authenticator`, whose role setting is statement_timeout = 8 s
--   (production pg_roles, 2026-11-09: authenticator {session_preload_libraries=safeupdate,
--   statement_timeout=8s,lock_timeout=8s}; service_role has no override of its own). A call that runs longer is
--   cancelled with 57014: the transaction rolls back, so nothing stays leased (pgmq.read_with_poll returns as soon
--   as a read finds rows, so only an empty wait can run long), but the wait is wasted and the consumer counts a
--   failedTransient and ends the drain. So one call may wait 6 s at most (the consumer asks for 6 and calls at
--   most twice per invocation), and max_poll_seconds is clamped to 1..6. The sleep step is clamped to 50..1000 ms: pgmq checks the deadline
--   only at the top of the loop, so the last sleep can overshoot the wait by one step, and an unclamped step of
--   10 s would defeat the 6 s clamp. The floor of 1 s is not cosmetic either: pgmq.read_with_poll with
--   max_poll_seconds = 0 returns before its FIRST read (stop_at is already reached), so 0 would silently read
--   nothing instead of reading once. With both clamps a call ends within 7 s plus one query.
--
--   EXECUTE: revoked from public, anon and authenticated, granted to service_role only (029's grants; the
--   default privileges of a Supabase project would otherwise give anon and authenticated EXECUTE on a new
--   public function, and the RPC would be callable from the browser). The shim leases messages (it bumps read_ct
--   and the visibility timeout), exactly like pgmq_read_msgs. `notify pgrst, 'reload schema'` makes PostgREST
--   see the function at once.
--
-- PRODUCTION FINGERPRINT THIS WAS BASED ON (read-only, 2026-11-09, pg_proc)
--   no function named pgmq_read_msgs_poll exists (count 0);
--   public.pgmq_read_msgs(text, integer, integer): prosrc md5 723ac411b99e6303fc3d6333d7ab4359 (length 47),
--     SECURITY DEFINER, proconfig {search_path=""}, owner postgres, proacl {postgres=X/postgres,service_role=X/postgres};
--   pgmq.read_with_poll(text, integer, integer, integer, integer, jsonb): prosrc md5
--     2201ed04d2c80c42759eba0eec49d94f (length 1304), plpgsql, volatile, owner postgres, proacl {postgres=X/postgres}
--     (service_role cannot call it directly, which is why the shim is SECURITY DEFINER), defaults
--     max_poll_seconds 5, poll_interval_ms 100, conditional '{}';
--   pgmq extension version 1.5.1.
--   new function: md5(prosrc) = 5b63418cb63edba4f494b309ee30b0fa (length 153) -- see the final check in
--   tests/migrations/sql/188-pgmq-read-poll-dryrun.sql, which recomputes it.
--
-- DEPLOY ORDER (nothing breaks in either order)
--   The consumer asks for the new RPC only in an ingest minute and falls back to the plain read when PostgREST
--   answers PGRST202 or 42883, so a cluster-consumer deployed BEFORE this migration works as before, and a
--   migration applied before the consumer is deployed is simply unused. Apply 188, then deploy cluster-consumer
--   (`supabase functions deploy cluster-consumer --no-verify-jwt`).
--
-- ROLLBACK
--   drop function public.pgmq_read_msgs_poll(text, int, int, int, int);
--   delete from supabase_migrations.schema_migrations where version = '188';
--   notify pgrst, 'reload schema';
--   The consumer then falls back to the plain read in every minute (one extra failing RPC per ingest minute).

begin;

create or replace function public.pgmq_read_msgs_poll(queue_name text, vt int, qty int, max_poll_seconds int, poll_interval_ms int)
returns setof pgmq.message_record
language sql security definer set search_path = ''
as $$
  select * from pgmq.read_with_poll(queue_name, vt, qty,
    least(greatest(max_poll_seconds, 1), 6),
    least(greatest(poll_interval_ms, 50), 1000));
$$;

-- service_role only: REVOKE names every role, because revoking from public alone leaves the role-direct grants
-- that a Supabase project's default privileges add, and the RPC would stay reachable through PostgREST.
revoke all on function public.pgmq_read_msgs_poll(text, int, int, int, int) from public, anon, authenticated;
grant execute on function public.pgmq_read_msgs_poll(text, int, int, int, int) to service_role;

insert into supabase_migrations.schema_migrations (version, name)
  values ('188', '188_pgmq_read_msgs_poll')
  on conflict do nothing;

notify pgrst, 'reload schema';

commit;
