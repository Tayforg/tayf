-- 122_ops_ingest_gaps.sql
--
-- ops_health_report() gets a fourteenth row, `ingest_gaps`, that makes a lost
-- ingest tick visible. The ingest Edge Function writes its public.ingest_cycles
-- row at the END of a cycle (039), so a tick the platform kills before that point
-- (pg_net answers 546 WORKER_RESOURCE_LIMIT) leaves no trace in ingest_cycles at
-- all. Row 3 (ingest_cycles_30m) only counts rows over 30 minutes and reads pass
-- from 8 rows up, so one or two lost ticks in half an hour are invisible to it.
-- Row 14 looks at the spacing instead: the number of gaps over 5 minutes between
-- consecutive started_at in the last 6 hours.
--
-- WHY (evidence: production, read-only, 2026-10-24)
--   * 546 is real and recurring. docs/ops-heartbeat.md records, over 24 hours on
--     2026-10-23, 27 x 546 against 427 x 200 on net._http_response (about 6%, up
--     to 25% an hour at 06-09 UTC, reason CPUTime). A killed ingest tick writes no
--     ingest_cycles row, and pg_net keeps its response log only about 6 hours (and
--     ops_net_response_compact truncates it from 64 MiB), so afterwards the only
--     lasting trace of a lost tick is the hole in ingest_cycles.started_at.
--   * ingest-drain runs every 3 minutes ('*/3 * * * *', 038, active; no later
--     migration reschedules it, which the test checks). Two consecutive ticks are
--     therefore 3 minutes apart; a gap over 5 minutes is at least one tick that
--     produced no row (killed, skipped by an overloaded cron, or a row write that
--     failed: ingest swallows that error by design).
--   * The history shows it. public.ingest_cycles holds 21,350 rows from
--     2026-09-07 22:48 to 2026-10-24 16:39 UTC. Between 09-29 and 10-12 cycles were
--     almost gapless (a 6 hour bucket usually had 0 or 1 gap over 5 minutes, of at
--     most 6 minutes; the one exception is 10-08 12:00-18:00, with a 14.9 minute
--     gap). From 10-13 the gaps come back: 10-22 06:00-12:00 UTC had 11 gaps
--     over 5 minutes, 5 of them over 10, the longest 21 minutes; 10-22
--     12:00-18:00 had a 33 minute gap; 10-23 06:00-12:00 had 10 gaps, 3 over 10
--     minutes. Row 3 read pass through most of this.
--
-- WHAT CHANGES (pinned by tests/migrations/122-ops-ingest-gaps.test.ts and
-- tests/guards/ops-health-checks.test.ts)
--   1. ops_health_report() is re-created with 119's text VERBATIM, comments
--      included, from the create line (returns table, plpgsql, volatile, security
--      definer, search_path = '', #variable_conflict, the declare block) through
--      row 13's last `return next;` (the test compares the raw text), and then
--      row 14 is appended before `return;`.
--   2. Row 14, check_name 'ingest_gaps', threshold 3 (the warn limit; the row is
--      warn only and never 'fail'):
--        window    ingest_cycles with started_at in the last 6 hours (and not in
--                  the future), finished_at in the last 6 hours 15 minutes so the
--                  descending finished_at index (039) serves the read;
--        gap       started_at - lag(started_at) over (order by started_at);
--        observed  the number of gaps over 5 minutes;
--        status    'warn' at 3 or more gaps, or when the longest gap is over 10
--                  minutes; 'pass' otherwise; 'warn' with observed null and
--                  `son 6 saatte ingest döngüsü yok` when the window holds no
--                  cycle at all; 'unknown' if the query errors;
--        detail    `son 6 saatte 5 dakikadan uzun boşluk: <n> · en uzunu <m> dk ·
--                  HH:MI→HH:MI, ... (UTC)`, longest first, cut at 500 characters;
--                  `son 6 saatte 5 dakikadan uzun boşluk yok · en uzunu <m> dk`
--                  when there is none. <m> is the longest gap in minutes with
--                  one decimal and trailing zeros trimmed (3, 12, 6.1): plain
--                  round(x, 1) would print 3.0 dk for a healthy 3 minute cadence.
--      The first row of the window has no predecessor, so a gap that straddles the
--      start of the window is not counted.
--   3. The function comment is 119's with `(migrations 077, 100, 103, 108, 114,
--      115, 119, 122): 14 fixed rows` and an ingest_gaps description before
--      ` status is one of`. Revoke all from public, anon, authenticated; grant
--      execute to service_role only (119's); the ledger row in the 095 pattern.
--   The heartbeat (scripts/lib/ops-heartbeat.mjs) and /durum do not depend on the
--   row count. A warn does not page (exit 1 only on 'fail', an empty report or
--   mostly 'unknown'); it shows in the step summary. This file creates no table,
--   adds no grant, deletes nothing and schedules nothing. The bias -> zone VALUES
--   list of row 4 is repeated once more; it is pinned by the same test and listed
--   in tests/migrations/zone-parity.test.ts KNOWN_FILES.
--
-- STEP 0 (production, read-only, 2026-10-24 16:40-16:55 UTC, via SELECT only;
-- nothing was applied)
--   a) Version 122 is free: the ledger holds '119' and '120' as its newest
--      three-digit versions and no '121' or '122'.
--   b) The deployed ops_health_report() is the one this file copies: md5(prosrc)
--      c99eb293f647eb4706c420e1613020f7 (17,050 characters), the md5 of the text
--      between the two fn quotes of 119_feed_freshness.sql. security definer,
--      volatile, search_path = "", acl service_role only.
--   c) cron.job 'ingest-drain': schedule '*/3 * * * *', active. (The command
--      column was not selected.)
--   d) Gap baseline over the retained history (21,350 rows, 6 hour buckets, UTC),
--      the figures behind the thresholds. The rule was evaluated on sliding 6 hour
--      windows ending every 30 minutes, exactly as the heartbeat would:
--        09-29 .. 10-12 (healthy stretch), 625 windows: 16 warn (2.6%), none in
--          its last 5 days (0 of 97);
--        the last 12 days, 577 windows: 320 warn (55%): 290 by 3 or more gaps,
--          167 by a gap over 10 minutes (the two overlap), 505 had at least one
--          gap over 5 minutes. Over the last 5 days: 152 of 239.
--      Alternatives measured over the same 577 windows: 4 gaps or over 15 minutes
--      would warn 228 times (40%), 5 gaps or over 20 minutes 113 times (20%).
--      The rule is quiet when ingest is healthy (2.6%) and warns through the
--      degraded stretch since 10-13, which is exactly what it exists to show; 55%
--      is a true reading of that stretch, not a permanent false alarm, so the
--      thresholds stay at 3 gaps and 10 minutes. It is warn only; if it proves too
--      noisy after the ticks are fixed, tune it in a new migration.
--      Right now (16:55 UTC): 119 cycles in the window, 1 gap, 6 minutes
--      (13:57->14:03), so the row would read pass. The read is an index scan on
--      ingest_cycles_finished_at_idx, 119 rows, 0.13 ms.
--   e) (121's cluster drift query is in 121_cluster_link_recompute.sql.)
--
-- DRY RUNS (×2) (local PG15.12, throwaway cluster, 2026-10-24; the shared stub
-- schema plus, added in a scratch setup and not in this file: default privileges
-- that mimic Supabase's and a revoke that mimics 117, the sources fetch_*
-- columns, articles.created_at, and ingest_cycles per 039). 114, 115 and 119 were
-- applied first, then this file twice in a row, each with psql -v
-- ON_ERROR_STOP=1 -f:
--   run 1   BEGIN, CREATE FUNCTION, COMMENT, REVOKE, GRANT, INSERT 0 1, COMMIT
--   run 2   the same statements, no error, no notice; the ledger insert is INSERT 0 0
--   After   ledger 114, 115, 119, 122; ops_health_report() returns 14 rows and row
--           14 reads warn / observed null / threshold 3 / `son 6 saatte ingest
--           döngüsü yok` on the empty table; md5(prosrc) is
--           f6548a98c236a3b998fedf8c192e6b7c (19,091 characters, the text between
--           the two fn quotes of this file).
--   Grants  has_function_privilege execute is false for anon and authenticated and
--           true for service_role (service_role only; acl {postgres=X/postgres,
--           service_role=X/postgres}); security definer, volatile,
--           search_path = "".
--   Fixtures (the TAYF_PSQL block of the test, inside rolled-back transactions;
--           ticks 30 s before the transaction clock, every 3 minutes, minus the
--           skipped ones):
--           a clean cadence: pass / observed 0 / `... boşluk yok · en uzunu 3 dk`;
--           one 6 minute and one 12 minute gap: warn / 2 / `... boşluk: 2 · en
--           uzunu 12 dk · <12 minute gap>, <6 minute gap> (UTC)`;
--           three 6 minute gaps: warn / 3, equal gaps earliest first;
--           two 6 minute gaps: pass / 2 (detail still names them);
--           a gap of exactly 10 minutes: pass; 11 minutes: warn;
--           a gap straddling the start of the window: not counted;
--           an empty table: warn / null / `son 6 saatte ingest döngüsü yok`;
--           a single cycle: pass / 0 / `en uzunu 0 dk`;
--           a 7 minute cadence (51 gaps): warn, detail cut at 500 characters;
--           14 rows, ingest_gaps last. The tables are rolled back.
--           Mutation check: with 119's function re-applied the row-14 live tests
--           fail, with 122 re-applied they pass.
--   Older live blocks, run against the database with 122 applied (they look rows
--           up by name): 114, 115 and 119: 141 tests pass, 1 is skipped and 3
--           fail; the three that fail are each version's own `returns exactly 13 rows` assertion, which
--           pins the row count of its own migration and cannot hold once a
--           fourteenth row exists (those files are not part of this change).
--   Rollback rehearsed: 119's ops_health_report() block re-applied with its
--           comment, revoke and grant (md5(prosrc) back to
--           c99eb293f647eb4706c420e1613020f7, 13 rows), ledger row 122 removed
--           (DELETE 1), then this file twice more: INSERT 0 1, then INSERT 0 0.
--
-- DEPLOY: APPLY 122 ONLY, NOTHING TO DEPLOY
--   Apply this file. The next heartbeat run (every 30 minutes) shows the row.
--   Verify (read-only):
--     select count(*) from public.ops_health_report();   -- expect 14
--     select status, observed, threshold, detail from public.ops_health_report()
--      where check_name = 'ingest_gaps';
--     select has_function_privilege('anon', 'public.ops_health_report()', 'execute'),
--            has_function_privilege('authenticated', 'public.ops_health_report()', 'execute'),
--            has_function_privilege('service_role', 'public.ops_health_report()', 'execute');
--       -- expect f, f, t
--   When the row warns: read the gaps in the detail (UTC), then look for 546 in
--   net._http_response for those minutes BEFORE the compaction trims it (see
--   docs/ops-heartbeat.md, row 14). The cause is on the ingest side
--   (CPU/wall-clock limit, parse budget of 113), not in this check.
--
-- ROLLBACK (nothing else depends on 122)
--   re-apply the create or replace function block of 119_feed_freshness.sql for
--     ops_health_report(), with its comment, revoke and grant (that returns the
--     report to 13 rows);
--   then remove ledger row 122 (run by the operator):
--     delete from supabase_migrations.schema_migrations where version = '122';
--
-- Additive. Safe to re-apply (create or replace function, ledger insert on
-- conflict do nothing). One transaction; no ALTER, no lock of note beyond the
-- catalog lock create or replace function takes on this one function. No
-- CONCURRENTLY step, no cron change, no new table, no grant to anon or
-- authenticated.

begin;

-- ---------------------------------------------------------------------------
-- ops_health_report(): 119's body, rows 1-13 byte for byte (comments included),
-- plus row 14, ingest_gaps. Same returns table, plpgsql, volatile, security
-- definer, search_path = ''.
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
  v_zero   numeric;
  v_tmo    numeric;
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

  -- 5. jev-shadow last finished run that did work (migration 108). Only runs
  -- that made at least one call, or closed ok / budget_exceeded, count. A
  -- partial or error run with zero calls still sets finished_at but proves
  -- nothing (runs 3622 and 3623 kept this row at pass through the 2026-10-22
  -- stall). budget_exceeded counts as fresh on purpose: a deliberate monthly
  -- cap is a healthy stop, not a stall.
  check_name := 'jev_shadow_last_run_min'; threshold := 30; observed := null; detail := null;
  begin
    v_jobs := 0; v_active := null;
    if pg_catalog.to_regclass('cron.job') is not null then
      execute $q$ select pg_catalog.count(*)::numeric, pg_catalog.bool_or(j.active)
                    from cron.job j where j.jobname = 'jev-shadow' $q$ into v_jobs, v_active;
    end if;
    select pg_catalog.max(r.finished_at) into v_last
      from public.jev_shadow_runs r
     where r.started_at >= v_now - interval '2 days'
       and (r.status in ('ok', 'budget_exceeded') or r.calls > 0);
    if v_last is not null then observed := round(extract(epoch from (v_now - v_last)) / 60.0, 1); end if;
    if v_jobs > 0 and v_active is false then
      status := 'skip'; detail := 'jev-shadow cron işi pasif';
    elsif v_last is null then
      status := 'fail'; detail := 'son 2 günde ok ya da çağrılı koşu yok';
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

  -- 7. unacked Jev alerts older than 72 h that are still OPEN (warn only: a
  -- queue, not an outage). Migration 108: an alert already resolved
  -- (resolved_at set) no longer counts -- 41 of the 42 unacked rows on
  -- 2026-10-22 were resolved. The detail keeps the unacked total.
  check_name := 'jev_alerts_unacked_72h'; threshold := 1; observed := null; detail := null;
  begin
    select pg_catalog.count(*) filter (where a.resolved_at is null and a.created_at < v_now - interval '72 hours')::numeric,
           pg_catalog.count(*)::numeric
      into v_n, v_total
      from public.jev_alerts a where a.acknowledged_at is null;
    observed := v_n;
    status := case when v_n >= 1 then 'warn' else 'pass' end;
    detail := 'açık ve onaysız: ' || v_n::text || ' / onaysız toplam: ' || v_total::text;
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

  -- 12. jev-shadow stall (migrations 103, 108). Three signals, summed, plus a
  -- timeout note that only escalates to warn:
  --   (a) failed pg_cron runs in the last 30 min for the three Jev jobs that
  --       poke or call the function (jev-shadow, jev-cluster-audit,
  --       jev-regression-weekly) -- same runid > max - 5000 window as check 1,
  --       since job_run_details has no start_time index;
  --   (b) net._http_response rows from the last 30 min with status_code >= 500
  --       whose body carries the "fn":"jev-shadow" marker. Every error body
  --       jevShadowErrorEnvelope emits has it (504 deadline, 503
  --       db-unavailable, 500 internal-error);
  --   (c) jev_shadow_runs rows started in the last 30 min that closed partial
  --       or error with zero calls (migration 108): the run opened and closed
  --       but did no work, which is what the 2026-10-22 stall looked like
  --       from inside the table;
  --   timed_out pg_net rows (status NULL, no body) cannot be attributed to a
  --   function, so they raise a pass to warn but never count toward fail.
  -- v_n is (a), v_total is (b), v_zero is (c), v_tmo is the timed_out count.
  -- A relation that does not exist leaves its variable null. An error anywhere
  -- is the only 'unknown'.
  check_name := 'jev_shadow_cron_failures_30m'; threshold := 2; observed := null; detail := null;
  begin
    v_n := null; v_total := null; v_zero := null; v_tmo := null;
    if pg_catalog.to_regclass('cron.job_run_details') is not null then
      execute $q$
        select pg_catalog.count(*)::numeric
          from cron.job_run_details d
          join cron.job j on j.jobid = d.jobid
         where d.runid > (select coalesce(pg_catalog.max(x.runid), 0) - 5000 from cron.job_run_details x)
           and d.start_time >= pg_catalog.now() - interval '30 minutes'
           and d.status = 'failed'
           and j.jobname in ('jev-shadow', 'jev-cluster-audit', 'jev-regression-weekly')
      $q$ into v_n;
    end if;
    if pg_catalog.to_regclass('net._http_response') is not null then
      execute $q$
        select pg_catalog.count(*) filter (where r.status_code >= 500 and r.content like '%"fn":"jev-shadow"%')::numeric,
               pg_catalog.count(*) filter (where r.timed_out)::numeric
          from net._http_response r
         where r.created >= pg_catalog.now() - interval '30 minutes'
      $q$ into v_total, v_tmo;
    end if;
    select pg_catalog.count(*)::numeric into v_zero
      from public.jev_shadow_runs r
     where r.started_at >= v_now - interval '30 minutes'
       and r.status in ('partial', 'error')
       and r.calls = 0;
    observed := coalesce(v_n, 0) + coalesce(v_total, 0) + coalesce(v_zero, 0);
    status := case when observed >= 2 then 'fail'
                   when observed >= 1 or coalesce(v_tmo, 0) >= 1 then 'warn' else 'pass' end;
    detail := 'cron hatası: ' || coalesce(v_n, 0)::text || ' · HTTP 5xx: ' || coalesce(v_total, 0)::text
              || ' · sıfır çağrılı koşu: ' || coalesce(v_zero, 0)::text
              || ' · zaman aşımı (fonksiyon bilinmiyor): ' || coalesce(v_tmo, 0)::text || ' (son 30 dk)';
    if v_n is null and v_total is null then
      detail := detail || ' · pg_cron ve pg_net yok';
    end if;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 13. sources_newly_dark (migration 114; window 24 h since 115; reason labels since 119)
  check_name := 'sources_newly_dark'; threshold := 1; observed := null; detail := null;
  begin
    with vs as (select s.id, s.slug,
                       case when (s.fetch_quarantined_until is not null and s.fetch_quarantined_until > v_now)
                                 or coalesce(s.fetch_fail_streak,0) > 0
                                 or s.fetch_last_status is null
                                 or not (s.fetch_last_status between 200 and 299 or s.fetch_last_status = 304)
                            then 'erişim yok'
                            when s.fetch_items_count = 0
                                 or s.fetch_newest_item_at < v_now - interval '72 hours'
                            then 'akış donmuş'
                            else 'sessiz' end as reason
                  from public.sources s
                 where s.active and s.kind in ('outlet', 'wire')
                   and not exists (select 1 from public.ops_dark_source_baseline b where b.slug = s.slug)),
    c as (select a.source_id,
                 pg_catalog.count(*) filter (where a.created_at < v_now - interval '24 hours') as prior_n,
                 pg_catalog.count(*) filter (where a.created_at >= v_now - interval '24 hours') as recent_n
            from public.articles a
           where a.created_at >= v_now - interval '14 days 24 hours' and a.created_at <= v_now
           group by a.source_id)
    select pg_catalog.count(*)::numeric,
           pg_catalog.string_agg(v.slug || ' (' || c.prior_n::text || ') · ' || v.reason, ', ' order by c.prior_n desc, v.slug)
      into v_n, v_text
      from vs v join c on c.source_id = v.id
     where c.prior_n >= 50 and c.recent_n = 0;
    observed := v_n;
    status := case when v_n >= 1 then 'warn' else 'pass' end;
    detail := case when v_n >= 1
      then substr('son 24 saatte haber gelmedi (önceki 14 günde en az 50 haber vardı): ' || v_text, 1, 500)
      else 'yeni susan kaynak yok' end;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 14. ingest_gaps (migration 122). A tick the platform kills (pg_net 546 WORKER_RESOURCE_LIMIT) writes no ingest_cycles row, so row 3 can read pass. ingest-drain runs */3 (038): a gap over 5 minutes between consecutive started_at is at least one lost tick. Warn only.
  check_name := 'ingest_gaps'; threshold := 3; observed := null; detail := null;
  begin
    v_n := null; v_total := null; v_zero := null; v_text := null;
    with s as (
      select c.started_at,
             c.started_at - pg_catalog.lag(c.started_at) over (order by c.started_at) as gap
        from public.ingest_cycles c
       where c.finished_at >= v_now - interval '6 hours 15 minutes'
         and c.started_at >= v_now - interval '6 hours'
         and c.started_at <= v_now
    )
    select pg_catalog.count(*)::numeric,
           pg_catalog.count(*) filter (where s.gap > interval '5 minutes')::numeric,
           pg_catalog.trim_scale(round(extract(epoch from pg_catalog.max(s.gap)) / 60.0, 1)),
           pg_catalog.string_agg(
             pg_catalog.to_char((s.started_at - s.gap) at time zone 'UTC', 'HH24:MI') || '→'
               || pg_catalog.to_char(s.started_at at time zone 'UTC', 'HH24:MI'),
             ', ' order by s.gap desc, s.started_at) filter (where s.gap > interval '5 minutes')
      into v_total, v_n, v_zero, v_text
      from s;
    observed := v_n;
    if coalesce(v_total, 0) = 0 then
      status := 'warn'; observed := null; detail := 'son 6 saatte ingest döngüsü yok';
    else
      status := case when v_n >= 3 or coalesce(v_zero, 0) > 10 then 'warn' else 'pass' end;
      detail := case when v_n >= 1
        then substr('son 6 saatte 5 dakikadan uzun boşluk: ' || v_n::text || ' · en uzunu ' || coalesce(v_zero, 0)::text || ' dk · ' || v_text || ' (UTC)', 1, 500)
        else 'son 6 saatte 5 dakikadan uzun boşluk yok · en uzunu ' || coalesce(v_zero, 0)::text || ' dk' end;
    end if;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  return;
end
$fn$;

comment on function public.ops_health_report() is
  'Read-only ops heartbeat (migrations 077, 100, 103, 108, 114, 115, 119, 122): 14 fixed rows, in this order --'
  ' cron_failed_runs_30m, edge_http_errors_30m, ingest_cycles_30m,'
  ' ingest_fresh_iktidar_min, ingest_fresh_bagimsiz_min, ingest_fresh_muhalefet_min,'
  ' jev_shadow_last_run_min (minutes since the last finished jev-shadow run that closed'
  ' ok or budget_exceeded or made at least one call; zero-call partial/error runs do not'
  ' count: warn > 20, fail > 30),'
  ' blindspot_veto_cron_min,'
  ' jev_alerts_unacked_72h (unacknowledged AND unresolved Jev alerts older than 72 h; warn only),'
  ' dead_feeds,'
  ' net_response_heap_mb (pg_net response-log MiB: pass < 64, warn 64-200, fail > 200),'
  ' jev_shadow_cron_failures_30m (failed runs of the jev-shadow, jev-cluster-audit and'
  ' jev-regression-weekly cron jobs plus jev-shadow HTTP 5xx responses carrying the'
  ' "fn":"jev-shadow" marker plus jev-shadow runs that closed partial or error with zero calls,'
  ' last 30 min: warn 1, fail >= 2; any timed_out pg_net request alone raises pass to warn),'
  ' sources_newly_dark (active outlet/wire sources outside public.ops_dark_source_baseline'
  ' that had at least 50 articles in the 14 days before the last 24 hours and none in those'
  ' 24 hours; warn only, never fail: the detail names them, each as slug (n) followed by a'
  ' reason read from sources.fetch_*: erişim yok (quarantined now, a fail streak, no status yet,'
  ' or a last status that is neither 2xx nor 304), akış donmuş (the feed answers but holds no'
  ' items, or its newest item, fetch_newest_item_at, is over 72 hours old; fetch_newest_item_at'
  ' and fetch_items_count are written by ingest, migration 119), sessiz (everything else, a'
  ' source never measured included)),'
  ' ingest_gaps (gaps of more than 5 minutes between consecutive ingest_cycles.started_at in the last'
  ' 6 hours, each one at least one lost ingest-drain tick, for example a pg_net 546 kill;'
  ' warn at 3 or more gaps or any gap over 10 minutes, never fail; the detail lists the gaps as'
  ' HH:MI→HH:MI in UTC, longest first).'
  ' status is one of pass|warn|fail|unknown|skip, and threshold is the fail limit'
  ' (or the warn limit for warn-only checks). Never writes any table, and'
  ' never reads any potentially secret-bearing pg_cron job field. Polled by'
  ' .github/workflows/ops-heartbeat.yml over PostgREST every 30 minutes.'
  ' service_role only. See docs/ops-heartbeat.md.';

revoke all on function public.ops_health_report() from public, anon, authenticated;
grant execute on function public.ops_health_report() to service_role;

-- Ledger ---------------------------------------------------------------------------

insert into supabase_migrations.schema_migrations (version, name)
  values ('122', '122_ops_ingest_gaps')
  on conflict do nothing;

commit;
