-- 100_pgnet_bloat_guard.sql
--
-- Keeps pg_net's response log (net._http_response) from bloating again, and
-- pages when it does. Two additive pieces, one transaction:
--   1. public.ops_net_response_compact(p_max_bytes) -- TRUNCATEs
--      net._http_response once its on-disk size passes a threshold (default
--      64 MiB), scheduled every 15 minutes as the pg_cron job
--      'net-response-compact'.
--   2. public.ops_health_report() gains an 11th row, net_response_heap_mb
--      (pass < 64, warn 64-200, fail > 200), appended after the existing
--      ten so every 077 check keeps its position.
--
-- INCIDENT 2026-10-21 (~21:45 UTC): production pages took 8-22 s and
-- /rss.xml returned 500. Root cause: net._http_response (pg_net's response
-- log, owned by supabase_admin) had bloated to 278 MB of heap for only 552
-- live rows. pg_net's own TTL cleanup,
--   WITH rows AS (SELECT ctid FROM net._http_response
--                  WHERE created < now() - $1 ORDER BY created LIMIT $2)
--   DELETE ...
-- was the #1 consumer of database time (683k s total over 310k calls, mean
-- 2.2 s) and kept evicting the page cache on a Micro instance
-- (shared_buffers = 32768 pages = 256 MB against a 5.2 GB database). The
-- operator ran `truncate net._http_response` by hand (it needed
-- lock_timeout = 25 s and three attempts, because pg_net's background worker
-- holds locks on the table) and page times fell back to 0.2-0.7 s. pg_net.ttl
-- is 6 h with batch_size 200, so every live row is always younger than 6 h:
-- the table is tiny in rows and huge in dead space.
--
-- WHY TRUNCATE IS THE ONLY LEVER AS `postgres`:
--   * DELETE never shrinks a heap. It only turns tuples into dead space that
--     autovacuum is supposed to reuse; here that is exactly what failed.
--     Migration 081's ops_exhaust_prune() therefore cannot help: it deletes
--     net._http_response rows older than 3 days, and there are none (pg_net's
--     TTL already removes everything older than 6 h).
--   * VACUUM FULL / CLUSTER cannot be called from the compactor (VACUUM
--     cannot run inside a function or transaction block). On PG15 and
--     earlier they also need table ownership: the table belongs to
--     supabase_admin, so VACUUM run as postgres is silently skipped ("only
--     table or database owner can vacuum it"). On prod's PG 17.6 the
--     table's ACL grants MAINTAIN to PUBLIC (read-only check, 2026-10-21:
--     has_table_privilege('postgres', ..., 'MAINTAIN') = true), so a manual
--     VACUUM FULL as postgres is probably permitted there (not exercised);
--     it would still take the same ACCESS EXCLUSIVE lock and rewrite the heap.
--   * ALTER SYSTEM (pg_net.ttl, autovacuum settings) is not permitted on
--     Supabase, and ALTER TABLE ... SET (autovacuum_*) needs ownership too.
--   * `postgres` DOES hold the TRUNCATE privilege on net._http_response, and
--     TRUNCATE swaps in a fresh empty relfilenode: instant, no dead space, no
--     VACUUM. The cost is that the (at most ~6 h of) response log is dropped.
--     Its only reader is ops_health_report().edge_http_errors_30m, which
--     looks at the last 30 minutes and reads an empty window as 'pass'.
--
-- ops_net_response_compact() behaviour:
--   * returns 'ok <size>'        total relation size <= threshold; nothing done
--   * returns 'truncated <size>' size (before the truncate) > threshold
--   * returns 'skipped: lock'    pg_net's worker (or anyone) held a conflicting
--                                lock for the whole `lock_timeout = '20s'`; the
--                                55P03 lock_not_available error is caught and
--                                NOT re-raised, so pg_cron records a success
--                                and the next 15-minute tick retries
--   * returns 'skipped: ...'     pg_net not installed, no TRUNCATE privilege on
--                                the table (other environments), or another
--                                run already holds the advisory lock
--   * any other error propagates, so a real fault still shows as a failed cron
--     run (and in ops_health_report().cron_failed_runs_30m).
--   The size it compares is pg_total_relation_size (heap + TOAST + indexes),
--   the same figure the health check reports, so 'warn' really means "the
--   compactor should have fired and has not". The threshold is floored at
--   1 MiB so a bad argument cannot turn the job into an every-tick wipe.
--   pg_cron stores only the command tag, not the returned text, so run
--   `select public.ops_net_response_compact();` by hand to see the verdict;
--   a lock-skip is also written to the server log (RAISE LOG, never an error).
--
-- Re-creating ops_health_report(): this migration repeats migration 077's
-- function body verbatim (same signature, same five output columns, same
-- SECURITY DEFINER / search_path = '' / service_role-only grants) and adds the
-- new check last. It reuses 077's v_n variable and declares nothing new.
-- tests/migrations/100-pgnet-bloat-guard.test.ts pins that 077's body is an
-- unchanged prefix of this one, so no existing check can drift. That repeats
-- the zone map once more (the bias -> zone VALUES list); it is pinned by the
-- same test and listed in tests/migrations/zone-parity.test.ts KNOWN_FILES.
--
-- Safe to re-apply: create or replace, idempotent cron reschedule (which also
-- re-enables a job the kill switch had disabled), ledger insert
-- `on conflict do nothing`. Kill switch:
--   update cron.job set active = false where jobname = 'net-response-compact';
-- Manual one-off: select public.ops_net_response_compact(0);  -- floored to 1 MiB
-- See docs/migration-guide.md ("100 -- pg_net bloat guard") and
-- docs/ops-heartbeat.md.

begin;

-- ---------------------------------------------------------------------------
-- 1. The compactor
-- ---------------------------------------------------------------------------

create or replace function public.ops_net_response_compact(p_max_bytes bigint default 64 * 1024 * 1024)
returns text
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_max     bigint := greatest(coalesce(p_max_bytes, 64 * 1024 * 1024), 1024 * 1024);
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
  'total relation size exceeds p_max_bytes (default 64 MiB, floored at 1 MiB). Migration 100. '
  'Returns ''ok <size>'', ''truncated <size>'', ''skipped: lock'' (lock_timeout 20 s hit, '
  'SQLSTATE 55P03 swallowed so pg_cron shows success and retries next tick) or ''skipped: ...'' '
  '(no pg_net, no TRUNCATE privilege, or another run holds the advisory lock). TRUNCATE is the only '
  'lever postgres has on that table: a DELETE never shrinks the heap and a full-table rewrite '
  'needs ownership. Scheduled every 15 minutes as net-response-compact; the operator kill switch is '
  '`update cron.job set active=false where jobname=''net-response-compact'';`. '
  'service_role only.';

revoke all on function public.ops_net_response_compact(bigint) from public, anon, authenticated;
grant execute on function public.ops_net_response_compact(bigint) to service_role;

-- ---------------------------------------------------------------------------
-- 2. ops_health_report(): 077's ten checks, unchanged, plus net_response_heap_mb
-- ---------------------------------------------------------------------------

create or replace function public.ops_health_report()
returns table (check_name text, status text, observed numeric, threshold numeric, detail text)
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
#variable_conflict use_column
declare
  v_now    timestamptz := pg_catalog.now();
  v_n      numeric;
  v_total  numeric;
  v_jobs   numeric;
  v_active boolean;
  v_last   timestamptz;
  v_text   text;
  v_zone   text;
begin
  -- 1. pg_cron failures, last 30 min, all jobs
  check_name := 'cron_failed_runs_30m'; threshold := 1; observed := null; detail := null;
  begin
    if pg_catalog.to_regclass('cron.job_run_details') is null then
      status := 'unknown'; detail := 'pg_cron yok';
    else
      execute $q$
        select pg_catalog.count(*)::numeric,
               pg_catalog.string_agg(distinct coalesce(j.jobname, d.jobid::text), ', ')
          from cron.job_run_details d
          left join cron.job j on j.jobid = d.jobid
         where d.runid > (select coalesce(pg_catalog.max(x.runid), 0) - 5000 from cron.job_run_details x)
           and d.start_time >= pg_catalog.now() - interval '30 minutes'
           and d.status = 'failed'
      $q$ into v_n, v_text;
      observed := v_n;
      status := case when v_n >= 1 then 'fail' else 'pass' end;
      detail := v_text;
    end if;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 2. Edge Function HTTP outcomes (pg_net keeps ~6 h)
  check_name := 'edge_http_errors_30m'; threshold := 5; observed := null; detail := null;
  begin
    if pg_catalog.to_regclass('net._http_response') is null then
      status := 'unknown'; detail := 'pg_net yok';
    else
      execute $q$
        select pg_catalog.count(*) filter (where r.status_code >= 500 or r.status_code in (401, 403)
                                              or r.timed_out or r.error_msg is not null)::numeric,
               pg_catalog.count(*)::numeric,
               pg_catalog.string_agg(distinct coalesce(r.status_code::text, 'hata'), ', ')
                 filter (where r.status_code >= 500 or r.status_code in (401, 403)
                            or r.timed_out or r.error_msg is not null)
          from net._http_response r
         where r.created >= pg_catalog.now() - interval '30 minutes'
      $q$ into v_n, v_total, v_text;
      observed := v_n;
      status := case when v_n >= 5 and v_n >= 0.05 * v_total then 'fail'
                     when v_n >= 2 then 'warn' else 'pass' end;
      detail := pg_catalog.concat_ws(' · ', v_n::text || ' / ' || v_total::text || ' yanıt', v_text);
    end if;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 3. ingest cycles (ingest-drain */3 => 10 per 30 min)
  check_name := 'ingest_cycles_30m'; threshold := 5; observed := null; detail := null;
  begin
    select pg_catalog.count(*)::numeric into v_n
      from public.ingest_cycles c where c.finished_at >= v_now - interval '30 minutes';
    observed := v_n;
    status := case when v_n < 5 then 'fail' when v_n < 8 then 'warn' else 'pass' end;
    detail := 'beklenen 10';
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 4. ingest freshness per zone (newest articles.created_at, active voting sources)
  -- Thresholds tuned from Step 0 (7-day gap survey): fail = max(90, ceil(1.5
  -- * observed max gap 104.9 min)) = 158; warn = fail / 2 = 79.
  foreach v_zone in array array['iktidar', 'bagimsiz', 'muhalefet'] loop
    check_name := 'ingest_fresh_' || v_zone || '_min'; threshold := 158; observed := null; detail := null;
    begin
      with zmap(bias_key, zone) as (values
        ('pro_government', 'iktidar'), ('gov_leaning', 'iktidar'), ('state_media', 'iktidar'),
        ('islamist_conservative', 'iktidar'), ('nationalist', 'iktidar'),
        ('center', 'bagimsiz'), ('international', 'bagimsiz'), ('pro_kurdish', 'bagimsiz'),
        ('opposition_leaning', 'muhalefet'), ('opposition', 'muhalefet'))
      select pg_catalog.max(a.created_at) into v_last
        from public.articles a
        join public.sources s on s.id = a.source_id
        join zmap z on z.bias_key = s.bias
       where z.zone = v_zone
         and s.active
         and s.kind in ('outlet', 'wire')
         and a.created_at >= v_now - interval '24 hours'
         and a.created_at <= v_now;
      if v_last is null then
        status := 'fail'; detail := 'son 24 saatte haber yok';
      else
        observed := round(extract(epoch from (v_now - v_last)) / 60.0, 1);
        status := case when observed > 158 then 'fail' when observed > 79 then 'warn' else 'pass' end;
      end if;
    exception when others then
      status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
    end;
    return next;
  end loop;

  -- 5. jev-shadow last finished run
  check_name := 'jev_shadow_last_run_min'; threshold := 30; observed := null; detail := null;
  begin
    v_jobs := 0; v_active := null;
    if pg_catalog.to_regclass('cron.job') is not null then
      execute $q$ select pg_catalog.count(*)::numeric, pg_catalog.bool_or(j.active)
                    from cron.job j where j.jobname = 'jev-shadow' $q$ into v_jobs, v_active;
    end if;
    select pg_catalog.max(r.finished_at) into v_last
      from public.jev_shadow_runs r where r.started_at >= v_now - interval '2 days';
    if v_last is not null then observed := round(extract(epoch from (v_now - v_last)) / 60.0, 1); end if;
    if v_jobs > 0 and v_active is false then
      status := 'skip'; detail := 'jev-shadow cron işi pasif';
    elsif v_last is null then
      status := 'fail'; detail := 'son 2 günde biten koşu yok';
    else
      status := case when observed > 30 then 'fail' when observed > 20 then 'warn' else 'pass' end;
    end if;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 6. blindspot-recall-veto cron freshness (071)
  check_name := 'blindspot_veto_cron_min'; threshold := 30; observed := null; detail := null;
  begin
    if pg_catalog.to_regclass('cron.job_run_details') is null then
      status := 'unknown'; detail := 'pg_cron yok';
    else
      execute $q$ select pg_catalog.count(*)::numeric, pg_catalog.bool_or(j.active)
                    from cron.job j where j.jobname = 'blindspot-recall-veto' $q$ into v_jobs, v_active;
      if v_jobs = 0 then
        status := 'warn'; detail := 'blindspot-recall-veto işi yok (071 uygulanmamış olabilir)';
      elsif v_active is false then
        status := 'skip'; detail := 'cron işi pasif';
      else
        execute $q$
          select pg_catalog.max(d.end_time)
            from cron.job_run_details d
            join cron.job j on j.jobid = d.jobid
           where j.jobname = 'blindspot-recall-veto'
             and d.status = 'succeeded'
             and d.runid > (select coalesce(pg_catalog.max(x.runid), 0) - 5000 from cron.job_run_details x)
        $q$ into v_last;
        if v_last is null then
          status := 'fail'; detail := 'yakın zamanda başarılı koşu yok';
        else
          observed := round(extract(epoch from (v_now - v_last)) / 60.0, 1);
          status := case when observed > 30 then 'fail' else 'pass' end;
        end if;
      end if;
    end if;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 7. unacked Jev alerts older than 72 h (warn only: a queue, not an outage)
  check_name := 'jev_alerts_unacked_72h'; threshold := 1; observed := null; detail := null;
  begin
    select pg_catalog.count(*) filter (where a.created_at < v_now - interval '72 hours')::numeric,
           pg_catalog.count(*)::numeric
      into v_n, v_total
      from public.jev_alerts a where a.acknowledged_at is null;
    observed := v_n;
    status := case when v_n >= 1 then 'warn' else 'pass' end;
    detail := 'toplam onaysız: ' || v_total::text;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 8. dead feeds: active voting sources with no article in 72 h (published_at
  -- <= now guards future dates). Thresholds tuned from Step 0: observed 35 /
  -- 96 (36.4%) on the live baseline -- raised the fail ratio from the
  -- drafted 0.35 to 0.50 and the warn count from the drafted 25 to
  -- observed + 3 = 38, so today's baseline reads 'pass'.
  check_name := 'dead_feeds'; threshold := null; observed := null; detail := null;
  begin
    with vs as (
      select s.id from public.sources s where s.active and s.kind in ('outlet', 'wire')
    ),
    latest as (
      select v.id,
             (select a.published_at from public.articles a
               where a.source_id = v.id and a.published_at <= v_now
               order by a.published_at desc limit 1) as last_at
        from vs v
    )
    select pg_catalog.count(*) filter (where l.last_at is null or l.last_at < v_now - interval '72 hours')::numeric,
           pg_catalog.count(*)::numeric
      into v_n, v_total
      from latest l;
    observed := v_n;
    threshold := ceil(0.50 * v_total);
    status := case when v_total > 0 and v_n >= 0.50 * v_total then 'fail'
                   when v_n > 38 then 'warn' else 'pass' end;
    detail := v_n::text || ' / ' || v_total::text || ' aktif kaynak 72 saattir sessiz';
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;


  -- 11. pg_net response-log size (migration 100). ops_net_response_compact()
  -- keeps this under 64 MiB from a 15-minute cron; warn/fail here means the
  -- compaction is being skipped (lock held by pg_net's worker, job disabled,
  -- TRUNCATE privilege lost) while the table bloats again -- the 2026-10-21
  -- failure mode (278 MB of heap behind 552 live rows). Measured as total
  -- relation size, the same figure the compactor thresholds on. Reuses v_n
  -- (MiB) so the declare block stays identical to 077's.
  check_name := 'net_response_heap_mb'; threshold := 200; observed := null; detail := null;
  begin
    if pg_catalog.to_regclass('net._http_response') is null then
      status := 'unknown'; detail := 'pg_net yok';
    else
      v_n := pg_catalog.pg_total_relation_size(pg_catalog.to_regclass('net._http_response')) / 1048576.0;
      observed := round(v_n, 1);
      status := case when v_n > 200 then 'fail' when v_n >= 64 then 'warn' else 'pass' end;
      detail := 'uyarı >= 64 MB, hata > 200 MB; 15 dakikada bir küçültülür (ops_net_response_compact)';
    end if;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  return;
end
$fn$;

comment on function public.ops_health_report() is
  'Read-only ops heartbeat (migrations 077, 100): 11 fixed rows, in this order --'
  ' cron_failed_runs_30m, edge_http_errors_30m, ingest_cycles_30m,'
  ' ingest_fresh_iktidar_min, ingest_fresh_bagimsiz_min, ingest_fresh_muhalefet_min,'
  ' jev_shadow_last_run_min, blindspot_veto_cron_min, jev_alerts_unacked_72h, dead_feeds,'
  ' net_response_heap_mb (pg_net response-log MiB: pass < 64, warn 64-200, fail > 200).'
  ' status is one of pass|warn|fail|unknown|skip; threshold is the fail limit'
  ' (or the warn limit for warn-only checks). Never writes any table, and'
  ' never reads any potentially secret-bearing pg_cron job field. Polled by'
  ' .github/workflows/ops-heartbeat.yml over PostgREST every 30 minutes.'
  ' service_role only. See docs/ops-heartbeat.md.';

revoke all on function public.ops_health_report() from public, anon, authenticated;
grant execute on function public.ops_health_report() to service_role;

-- ---------------------------------------------------------------------------
-- 3. Schedule: every 15 minutes (pg_net's TTL keeps rows < 6 h, so bloat
--    needs days to reach 64 MiB; 15 minutes is far inside that and gives a
--    lock-skipped tick three more tries per hour). statement_timeout is
--    raised above the 20 s lock_timeout so a held lock surfaces as the handled
--    55P03, never as a 57014 statement timeout.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron not installed — skipping net-response-compact schedule (100)';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'net-response-compact') then
    perform cron.unschedule('net-response-compact');
  end if;
  perform cron.schedule('net-response-compact', '*/15 * * * *',
    $sql$ set statement_timeout = '90s'; select public.ops_net_response_compact(); $sql$);
end $$;

insert into supabase_migrations.schema_migrations (version, name)
  values ('100', '100_pgnet_bloat_guard')
  on conflict do nothing;

commit;
