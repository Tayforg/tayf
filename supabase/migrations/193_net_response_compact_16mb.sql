-- 193_net_response_compact_16mb.sql
--
-- pg_net's response log returns its dead heap at 16 MiB, not 64 MiB (h112-dbgrowth-1, hunt 112, 2026-11-11).
-- ONE function changes: public.ops_net_response_compact(p_max_bytes bigint) is re-created with
-- `create or replace` and its default threshold (and the matching coalesce fallback inside the body) goes
-- from 64 MiB to 16 MiB. The argument stays, only its default changes (a default may be changed with
-- create or replace; only removing one is an error). The body is migration 100's byte for byte except that
-- one number. No table, no cron job, no other function (ops_health_report() is NOT re-created), no data
-- change at apply time; cron job 50 'net-response-compact' (*/15) keeps calling the function with no
-- arguments, so it picks the new default up at its next tick.
--
-- WHY (evidence: production, read-only, 2026-11-11 00:19-00:30Z)
--   * net._http_response (pg_net's response log, owned by supabase_admin) is 40,910,848 B of heap
--     (pg_relation_size; pg_total_relation_size 41,459,712 B = 39.5 MiB with TOAST and indexes) for 768
--     live rows, about 1.3 MB of data: rows from 2026-11-10 18:29Z to 2026-11-11 00:28Z, about 128 responses
--     an hour (pg_net.ttl is 6 h, so every live row is younger than 6 h). The rest is dead space.
--   * Migration 100 truncates it only when pg_total_relation_size exceeds p_max_bytes, which defaults to
--     64 MiB. At the measured growth of about 245 KB/h (5.9 MB/day, with stale autovacuum statistics) the heap
--     saw-tooths between 0 and 64 MiB, about 32 MiB of dead heap on average, and all of it is counted in
--     pg_database_size.
--   * pg_database_size is 7,222,267,027 B (6,888 MiB) against ops_db_size_limits() warn 7000 / fail 7600 MiB,
--     +113 MB since 2026-11-08 22:43Z (about 52 MiB a day): the warn trips about 2026-11-13. A lower default
--     is the only lever that returns bytes at once without a disk decision (that stays with the founder-held
--     h68-sqlperf-3): the first tick after this migration truncates the 39.5 MiB table (39.5 > 16) and
--     returns about 40 MB; afterwards the table never exceeds 16 MiB plus one tick of growth.
--   * Cron job 50 'net-response-compact' is `*/15 * * * *`, command
--       set statement_timeout = '90s'; select public.ops_net_response_compact();
--     active, its last three runs (00:00, 00:15, 00:30Z) succeeded.
--
-- WHAT READS net._http_response, AND HOW FAR BACK (so the compaction drops nothing an ops check still needs)
--   * public.ops_health_report() row 2, edge_http_errors_30m: `where r.created >= now() - interval '30
--     minutes'`.
--   * row 12, jev_shadow_cron_failures_30m (migrations 103 / 108 / 173): the same 30-minute window.
--   * row 11, net_response_heap_mb: reads pg_total_relation_size only, not a row; its thresholds (pass < 64,
--     warn 64-200 MiB, fail > 200 MiB) and its Turkish detail text ('uyarı >= 64 MB, hata > 200 MB; ...') are
--     NOT touched: with a 16 MiB compaction the row sits at pass, and a warn still means "the compactor
--     is being skipped".
--   * migration 081's ops_exhaust_prune() removes rows older than 3 days (never one: pg_net's own TTL
--     removes everything older than 6 h); it does not read them.
--   * no script, workflow, route or Edge Function reads the table (grep: only comments mention it).
--   * docs/ops-heartbeat.md's hand queries (service role) read it for post-mortems; after a truncate they see
--     only the rows since it, instead of up to 6 h.
--   Both ops readers look back at most 30 minutes. A truncate drops every row older than the tick, so for up
--   to 30 min after it those two rows count only responses created after the tick: a 5xx or timeout from the
--   30 minutes before the tick that no heartbeat run had read yet is lost (the heartbeat polls every 30
--   minutes, the public status snapshot of migration 131 every 10). Migration 100 accepted exactly that at
--   64 MiB. At about 5.9 MB/day the 16 MiB threshold is reached about every 2.7 days (2.8 counting MiB), so the
--   blind window of up to 30 min now recurs about every 2.7 days instead of about every 11, plus once at the
--   first tick after applying (when the table is already 39.5 MiB). The rows themselves are not needed
--   again: nothing reads past 30 minutes. No reader changes; this file does not move the window.
--
-- WHAT CHANGES (pinned by tests/migrations/193-net-response-compact-16mb.test.ts)
--   1. public.ops_net_response_compact(p_max_bytes bigint default 16 * 1024 * 1024): 100's text with the
--      signature default and `greatest(coalesce(p_max_bytes, 16 * 1024 * 1024), 1024 * 1024)` as the only
--      differences. Still plpgsql, SECURITY DEFINER, set search_path = '', the 1 MiB floor, the
--      pg_try_advisory_xact_lock, lock_timeout '20s', the lock_not_available handler ('skipped: lock'), and
--      a truncate guarded by `v_size > v_max`. An explicit argument (for example the operator's
--      `select public.ops_net_response_compact(64 * 1024 * 1024)`) behaves as before.
--   2. The comment on the function says 16 MiB and names 193.
--   3. 100's revoke and grant lines, restated: revoke all from public, anon, authenticated; execute to
--      service_role only. The ledger row in the 095 pattern.
--
-- STEP 0 (production, read-only, 2026-11-11, SELECT only through sbq.py; nothing was applied)
--   select md5(prosrc), length(prosrc), prosecdef, provolatile, proconfig, proacl::text,
--          pg_get_function_arguments(oid), pg_get_function_result(oid)
--     from pg_proc where proname = 'ops_net_response_compact';
--     -> md5 1177f2c28709eae53292ca192b9c812f, length 1567, prosecdef true, provolatile v, proconfig
--        {search_path=""}, proacl {postgres=X/postgres,service_role=X/postgres}, arguments
--        `p_max_bytes bigint DEFAULT ((64 * 1024) * 1024)`, result text.
--   The latest migration that defines ops_net_response_compact is 100_pgnet_bloat_guard.sql (the only one). The
--   md5 of the text between its `$fn$` markers (1567 characters) is 1177f2c28709eae53292ca192b9c812f: the same
--   as production, so 100 is what runs there and 193 is built from it. The test recomputes that md5 and pins
--   it; it also pins that this file's body is 100's with the single `64 * 1024 * 1024` replaced.
--   select pg_relation_size('net._http_response'), pg_total_relation_size('net._http_response'),
--          (select count(*) from net._http_response), pg_database_size(current_database());
--     -> 40910848, 41459712, 768, 7222267027 (2026-11-11 00:28Z).
--
-- DRY RUN (local PG15, throwaway cluster, 2026-11-11; never production)
--   The shared stub schema (tests/migrations/sql/stub.sql), then tests/migrations/sql/193-net-response-compact-16mb-dryrun.sql:
--   a stand-in net._http_response (its text column stored EXTERNAL, so a known number of bytes of content is that many
--   bytes on disk), 100 (no pg_cron here, so its schedule block only raises a notice), a baseline reading gated on
--   production's fingerprint, then this file applied twice (bash tests/migrations/sql/run-live.sh with
--   TAYF_LIVE_ONLY=193; Phase A "DRYRUN 193 OK", Phase B the vitest file below on the database the script leaves behind).
--   Baseline      ops_net_response_compact is production's body (md5 1177f2c28709eae53292ca192b9c812f, 1567 characters), arguments
--                 `p_max_bytes bigint DEFAULT ((64 * 1024) * 1024)`; no 193 ledger row.
--   First apply   BEGIN, CREATE FUNCTION, COMMENT, REVOKE, GRANT, INSERT 0 1 (ledger), COMMIT. Second apply: the same
--                 statements, no error, the ledger INSERT 0 0 (one 193 row).
--   After         one function (no overload from the create or replace), arguments `p_max_bytes bigint DEFAULT ((16 * 1024) * 1024)`,
--                 result text, SECURITY DEFINER, search_path "", volatile, proacl {postgres=X/postgres,service_role=X/postgres}
--                 (unchanged), anon and authenticated cannot execute, service_role can; md5(prosrc)
--                 ddc6119ae61ec7c2e4b9ad85a8bd5e36, 1567 characters: 100's body with the one `64 * 1024 * 1024` replaced
--                 (the dry run compares the text itself, not only the hash). ops_health_report() still returns 100's rows and the
--                 net_response_heap_mb detail text is unchanged.
--   Behaviour     with no argument: a 10 MiB table reads `ok`, a 15 MiB one reads `ok`, a 17 MiB one (which the old 64 MiB default
--                 left alone) reads `truncated`, the table is then empty and under 1 MiB, and an empty table reads `ok`. A NULL
--                 argument falls back to 16 MiB (20 MiB: truncated). An explicit 64 MiB still leaves a 20 MiB table alone. 0 is
--                 floored to 1 MiB (2 MiB: truncated; a one-row table: ok, never wiped). anon and authenticated are refused
--                 (insufficient_privilege); service_role runs it.
--   Test counts   tests/migrations/193-net-response-compact-16mb.test.ts 28 (static 23, live 5).
--
-- DEPLOY: APPLY 193 ANY TIME; there is no deploy order and no app change
--   Apply it like any migration (docs/migration-guide.md, operator: `supabase db push`). The next */15 tick
--   (cron job 50) runs the new default: if the table is above 16 MiB it truncates it (returns
--   'truncated <size>'), otherwise 'ok <size>'. Apply it outside the minutes where a Jev or cluster
--   failure is being investigated by hand, because the response log those queries read is emptied at the
--   first tick. Nothing in the app, no Edge Function and no other migration depends on it.
--
-- VERIFY (read-only, after applying):
--   select md5(prosrc), length(prosrc), prosecdef, proconfig::text, proacl::text,
--          pg_get_function_arguments(oid)
--     from pg_proc where oid = 'public.ops_net_response_compact(bigint)'::regprocedure;
--      -- expect the md5 / length of the DRY RUN section, t, {"search_path=\"\""},
--      --        {postgres=X/postgres,service_role=X/postgres}, p_max_bytes bigint DEFAULT ((16 * 1024) * 1024)
--   select version, name from supabase_migrations.schema_migrations where version = '193';   -- 1 row
--   at the next quarter hour: select d.status, d.start_time from cron.job_run_details d
--      where d.jobid = (select jobid from cron.job where jobname = 'net-response-compact')
--      order by d.runid desc limit 1;                                                          -- succeeded
--   select pg_relation_size('net._http_response');          -- stays under 17 MiB (17,825,792) from then on
--   select pg_database_size(current_database());             -- about 40 MB lower than before the first tick
--   select check_name, status, observed from public.ops_health_report()
--    where check_name in ('net_response_heap_mb', 'edge_http_errors_30m');                   -- pass, pass (an
--      -- edge_http_errors_30m of 0 / 0 right after the truncate is the blind window above, not a fault)
--
-- ROLLBACK (nothing else in the database depends on 193; run by the operator, in one transaction)
--   re-run ONLY 100's function section: the text of 100_pgnet_bloat_guard.sql from
--   `create or replace function public.ops_net_response_compact(p_max_bytes bigint default 64 * 1024 * 1024)`
--   through the `grant execute on function public.ops_net_response_compact(bigint) to service_role;` line
--   (md5(prosrc) 1177f2c28709eae53292ca192b9c812f, length 1567, default 64 MiB again); then
--     delete from supabase_migrations.schema_migrations where version = '193';
--   The report, the cron job and the data are not touched in either direction. The bytes the first tick
--   returned are not given back: a truncated response log has no content to restore, and nothing needs it.
--
-- Additive. Safe to re-apply (create or replace function, repeatable revoke and grant, the ledger insert on
-- conflict do nothing). One transaction. No table, no column, no index, no trigger, no policy, no pg_cron
-- job, no data rewrite, no CONCURRENTLY step, no table or sequence privilege to anyone; the only grant is
-- execute on the function to service_role (100's).

begin;

create or replace function public.ops_net_response_compact(p_max_bytes bigint default 16 * 1024 * 1024)
returns text
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_max     bigint := greatest(coalesce(p_max_bytes, 16 * 1024 * 1024), 1024 * 1024);
  v_rel     regclass;
  v_size    bigint;
  v_prev_lt text;
  v_out     text;
begin
  v_rel := pg_catalog.to_regclass('net._http_response');
  if v_rel is null then
    return 'skipped: no pg_net';
  end if;
  if not pg_catalog.has_table_privilege(v_rel, 'TRUNCATE') then
    return 'skipped: no truncate privilege';
  end if;
  -- Two overlapping runs would just queue behind each other's ACCESS EXCLUSIVE
  -- lock; the second one steps aside instead. xact-scoped: released at commit.
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('ops_net_response_compact', 0)) then
    return 'skipped: busy';
  end if;

  -- Bounds BOTH the size probe (AccessShareLock) and the TRUNCATE
  -- (AccessExclusiveLock) so neither can hang behind pg_net's worker.
  v_prev_lt := pg_catalog.current_setting('lock_timeout');
  set local lock_timeout = '20s';
  begin
    v_size := pg_catalog.pg_total_relation_size(v_rel);
    if v_size > v_max then
      truncate table net._http_response;
      v_out := 'truncated ' || pg_catalog.pg_size_pretty(v_size);
    else
      v_out := 'ok ' || pg_catalog.pg_size_pretty(v_size);
    end if;
  exception when lock_not_available then   -- SQLSTATE 55P03
    raise log 'ops_net_response_compact: lock_timeout (55P03) on net._http_response, retrying next tick';
    v_out := 'skipped: lock';
  end;
  perform pg_catalog.set_config('lock_timeout', v_prev_lt, true);   -- hand the caller's setting back
  return v_out;
end
$fn$;

comment on function public.ops_net_response_compact(bigint) is
  'Truncates net._http_response (pg_net response log, owned by supabase_admin) when its '
  'total relation size exceeds p_max_bytes (default 16 MiB, floored at 1 MiB). Migrations 100, 193. '
  'Returns ''ok <size>'', ''truncated <size>'', ''skipped: lock'' (lock_timeout 20 s hit, '
  'SQLSTATE 55P03 swallowed so pg_cron shows success and retries next tick) or ''skipped: ...'' '
  '(no pg_net, no TRUNCATE privilege, or another run holds the advisory lock). TRUNCATE is the only '
  'lever postgres has on that table: row removal never shrinks the heap and a full-table rewrite '
  'needs ownership. Scheduled every 15 minutes as net-response-compact (no arguments); the operator '
  'kill switch is deactivating that job in cron.job. The default was 64 MiB until 193 (the heap '
  'saw-toothed to 64 MiB, about 32 MiB of dead space on average, inside pg_database_size). '
  'service_role only.';

revoke all on function public.ops_net_response_compact(bigint) from public, anon, authenticated;
grant execute on function public.ops_net_response_compact(bigint) to service_role;

insert into supabase_migrations.schema_migrations (version, name)
  values ('193', '193_net_response_compact_16mb')
  on conflict do nothing;

commit;
