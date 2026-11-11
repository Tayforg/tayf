-- 195_ops_cron_route_low_cadence.sql
--
-- ops_health_report() row 15 (cron_route_failures_30m) can FAIL for the low-cadence Vercel routes and notices fact-checks going
-- silent (h118-crons-1, hunt 118, 2026-11-11). The function is re-created with 192's text VERBATIM (it is what production runs) except
-- row 15 and the two places of the function comment that describe it. Row 15 gets (a) a silence gap for the hourly fact-checks route,
-- 130 minutes (warn, two missed ticks) and 250 minutes (fail, four), and (b) a streak rule for the routes fact-checks, social and
-- digest: each route's newest TWO rows within the 7 day retention, both at status >= 500 is a failing route (the row fails), only the
-- newest at >= 500 is a warn, and the detail appends `ardışık başarısız: <route> 2/2` (or 1/2), route names and counts only.
-- headline and alerts-webhooks keep the 30 minute rule and their silence gaps exactly. Nothing else in the database changes: no table,
-- column, index, policy, data, grant or pg_cron job.
--
-- NUMBERING: 195, not 194. 194 (search_rank_display_title, hunt-117) is taken by another branch. This file copies 192's report, the newest
-- re-creation, which is the body production runs today (STEP 0 below), and depends on nothing else.
--
-- WHY (evidence: production, read-only, 2026-11-11 06:40-07:20 UTC)
--   * Row 15 can never fail for an hourly route. Its FAIL needs one route with failures >= 2 and failures * 2 >= runs inside 30 minutes.
--     fact-checks runs hourly at minute :23 (vercel.ts, `23 * * * *`): 168 rows in 7 days (2026-11-04 07:23 to 2026-11-11 06:23), the
--     167 gaps between them 59.9 to 60.1 minutes, so a 30 minute window never holds two of its runs. The weekly digest (`0 6 * * 6,0`)
--     has 1 row in 7 days. A fact-checks route that answers 500 on every tick therefore reads, at most, `warn`
--     ('son 30 dakikada başarısız: fact-checks 1/1'): synthetic rows (headline 6 and alerts-webhooks 3 healthy plus one fact-checks 500
--     in the window) give v_total 10, v_n 1, v_zero 0, status warn.
--   * A warn never pages. scripts/lib/ops-heartbeat.mjs evaluate() exits 1 only for a fail, a missed FAIL snapshot, the archive-gap
--     row, an empty report or a half-unknown report; a warn only shows in the step summary. So a fact-checks route that fails every
--     hour is never paged, and it feeds the cluster page's 'Bu konuda doğrulama' block through cluster_fact_checks.
--   * Nothing alerted on fact-checks going silent. The silence list of row 15 held only ('headline', 15, 30) and ('alerts-webhooks',
--     25, 60) (migration 136: hourly, daytime-only and weekly routes were left out for lack of ticks). If Vercel stopped invoking
--     fact-checks, or Vercel killed every run at maxDuration (no after(), no row), row 15 stayed `pass` as long as headline kept
--     ticking. An hourly route does have enough ticks for a gap rule: 2 ticks warn, 4 ticks fail.
--   * The 2-failure rule of 136 protects 'a single blip in a daily route'. It did not anticipate a route that fails on every hourly tick.
--   * Production now: 0 route failures in 7 days (statuses of fact-checks 168 x 200, social 336 x 200, digest 1 x 200) except one headline
--     599 on 2026-11-06. The gap is latent: no outage is live, and today's row 15 reads pass with the same detail before and after.
--
-- WHAT CHANGES (pinned by tests/migrations/195-ops-cron-route-low-cadence.test.ts, tests/guards/ops-health-checks.test.ts,
-- tests/migrations/144-blindspot-veto-cadence.test.ts and tests/migrations/zone-parity.test.ts)
--   1. ops_health_report() is re-created with 192's text VERBATIM from the create line through the grant (the test compares the raw
--      text; rows 1-14 and 16-22, the declare block, row 4's VALUES copy of BIAS_TO_ZONE, row 17's seven-RPC allowlist and 192's
--      statement shape are byte identical) except: row 15's text, the function comment's description of row 15, and the comment's
--      migration list (`... 173, 192, 195): 22 fixed rows`). Same returns table, plpgsql, volatile, security definer,
--      search_path = ''. Revoke all from public, anon, authenticated; execute for service_role only: 192's two statements.
--   2. Row 15, same name, same threshold 1, same 22 rows in the same order:
--      a. Silence list: ('fact-checks'::text, 130::numeric, 250::numeric) after the two it had. The route runs hourly at :23, so
--         130 minutes is two missed ticks (warn) and 250 minutes four (fail); the 7 day rule is the old one: only a route that has a
--         row within the 7 day retention is compared, a route that never recorded is not flagged. Named in the detail as
--         `kayıt gelmiyor: fact-checks 131 dk` like headline's. Max gap between fact-checks rows in the last 7 days: 60.1 minutes.
--      b. Low-cadence streak rule, routes in ('fact-checks', 'social', 'digest') (hourly, every 20 minutes in daytime, weekly: their runs
--         seldom or never share a 30 minute window, and a warn never pages):
--         take each route's newest 2 rows within 7 days (row_number() over (partition by route order by ran_at desc, id desc) <= 2).
--           both status >= 500             streak 2: the route counts as failing, row 15 is `fail`
--           only the newest status >= 500  streak 1: row 15 is `warn`, even when that row is older than 30 minutes
--           otherwise                      streak 0 (a newer success clears an older failure)
--         The detail appends ` · ardışık başarısız: fact-checks 2/2` (digest 2/2, social 1/2 ...: worst streak first, then route),
--         last, after the 30 minute text and the silence text, route names and counts only (the Actions log is public).
--         `observed` adds the number of such routes (streak >= 1); a failure inside the 30 minute window is seen by both rules,
--         so it counts in the 30 minute total and in this one. The empty-window warn ('son 30 dakikada cron rotası kaydı yok') no
--         longer hides a failing low-cadence route: it applies only when no such route has a streak.
--      c. headline and alerts-webhooks: the 30 minute CTE `r`, its select, the silence CTE `s` and its select are 192's text
--         exactly; their gaps stay 15 / 30 and 25 / 60 minutes, and the fail rule of 136 (>= 2 failures, at least half of the runs,
--         30 minutes) still applies to every route. Today's cases keep their status, observed and detail (REPLAY).
--      d. The row-15 code comment and the function comment's row-15 description say all this. The streak variables are declared in a
--         nested `declare ... begin` inside row 15, so the function's declare block stays 192's.
--      Consequence to know: a streak of 2 is a fail until a newer success or until the failing rows leave the table (7 day
--      retention, pruned 04:17 UTC). For fact-checks and social the next healthy tick clears it within the hour. digest runs on
--      Saturday and Sunday 06:00 UTC, so two failing weekend runs keep row 15 failing until the next weekend's success or 7 days.
--   3. `set local lock_timeout = '5s'` first, so a conflicting lock on the function fails the apply fast instead of queueing.
--      notify pgrst 'reload schema' and the ledger row in the 095 pattern.
--
-- STEP 0 (production, read-only, 2026-11-11 06:40 UTC, SELECT only through sbq.py; nothing was applied)
--   select md5(p.prosrc), length(p.prosrc), p.proconfig::text, p.proacl::text, p.prosecdef, p.provolatile
--     from pg_proc p where p.oid = 'public.ops_health_report()'::regprocedure;
--     -> md5 a2252c75458b9d86a0a536b589d97ceb, length 52463, search_path "", ACL {postgres=X/postgres,service_role=X/postgres},
--        security definer, volatile: 192 is applied, and it is the text this migration copies. (pg_get_functiondef prints 52,695
--        characters: the prosrc plus the `create or replace function` header lines.) The ledger ends ... 190, 192, 193; no 194, no 195.
--        tests/migrations/195-ops-cron-route-low-cadence.test.ts recomputes the md5 and the length from 192's file. STOP and re-copy if
--        a later migration changed the report (the test also fails when another migration re-creates the report between 192 and 195).
--
-- REPLAY (read-only, 2026-11-11 07:00-07:20 UTC: the new row's CTEs evaluated as plain SELECTs with now() for v_now, over production's
-- public.ops_cron_route_runs of the last 7 days; OLD is the same query with 192's silence list and without the low-cadence CTE)
--   today's rows (headline 2013, alerts-webhooks 1007, social 336, fact-checks 168, digest 1; newest fact-checks 06:23 UTC):
--     OLD  pass  observed 0  'son 30 dakikada 11 çalışma, başarısız yok'
--     NEW  pass  observed 0  'son 30 dakikada 11 çalışma, başarısız yok'          -> unchanged
--   synthetic rows (a VALUES CTE, ran_at = now() - m minutes; headline 6 and alerts-webhooks 3 healthy inside 30 minutes in every case):
--     fact-checks rows                                OLD                       NEW
--     one 500 at 23 min (the case of WHY)             warn 1, '... fact-checks 1/1'   warn 2, '... fact-checks 1/1 · ardışık başarısız: fact-checks 1/2'
--     500 at 23 and 83 min                            warn 1                    fail 2, '... fact-checks 1/1 · ardışık başarısız: fact-checks 2/2'
--     500 at 45 and 105 min (outside 30 min)          pass 0                    fail 1, 'son 30 dakikada 9 çalışma, başarısız yok · ardışık başarısız: fact-checks 2/2'
--     500 at 45 min, 200 at 105 min                   pass 0                    warn 1, '... · ardışık başarısız: fact-checks 1/2'
--     one 200 at 131 min                              pass 0                    warn 1, '... · kayıt gelmiyor: fact-checks 131 dk'
--     one 200 at 300 min (a 5 h silence)              pass 0                    fail 1, '... · kayıt gelmiyor: fact-checks 300 dk'
--     one 200 at 260 min                              pass 0                    fail 1, '... · kayıt gelmiyor: fact-checks 260 dk'
--     200 at 23 and 83 min (healthy)                  pass 0                    pass 0, 'son 30 dakikada 10 çalışma, başarısız yok'
--   The live block of the test file runs the same cases (and the gap boundaries 129 / 130 / 131 / 250 / 251, social, digest, several routes,
--   headline 2 of 6 and 3 of 6) against both the new function and 192's text side by side, rows other than 15 compared whole.
--
-- DRY RUN (local PG15, throwaway cluster; never production)
--   The shared stub schema (tests/migrations/sql/stub.sql), then tests/migrations/sql/195-ops-cron-route-low-cadence-dryrun.sql: 192's
--   dry-run (150's chain with 114, 115, 119, 122, 136, 145, 150, then 041, 157, 124, 138, 158, 161, 167, 173 and 192 twice, on stand-ins for
--   pg_cron, pg_net and pgmq), a gate on the production fingerprint (md5 a2252c75458b9d86a0a536b589d97ceb, length 52463), a baseline reading
--   of the 22 rows, then this file applied TWICE (bash tests/migrations/sql/run-live.sh with TAYF_LIVE_ONLY=195).
--   Apply         BEGIN, SET, CREATE FUNCTION, COMMENT, REVOKE, GRANT, NOTIFY, INSERT 0 1 (ledger), COMMIT. Second apply: the same
--                 statements, no error, the ledger INSERT 0 0 (one 195 row).
--   After         ops_health_report() returns 22 rows with the same names in the same order, and every row other than 15 reads as 192's does on
--                 the same data; md5(prosrc) 52072a51a208b77e1cae577db8a22ff1, 55271 characters;
--                 security definer, volatile, search_path = "", ACL service_role only; the function comment lists 195.
--   Result        the dry-run script ends with "DRYRUN 195 OK"; tests/migrations/195-ops-cron-route-low-cadence.test.ts 50 (static 28,
--                 live 22), all passing through run-live.sh (TAYF_LIVE_ONLY=195).
--
-- DEPLOY: APPLY 195 ONLY (no Edge Function deploy, no app deploy, no Vercel change; the founder applies it through the normal migration flow)
--   1. Apply 195 (operator: `supabase db push`, or `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/195_ops_cron_route_low_cadence.sql`).
--      The ops heartbeat's next run (every 30 minutes) and the 10 minute snapshot of 131 read the new row. On today's data it stays `pass`.
--   2. After applying, a fact-checks failure or silence shows as warn or fail in the step summary of the ops heartbeat, and a fail exits 1.
--
-- VERIFY (read-only, after applying):
--   select check_name, status, observed, detail from public.ops_health_report() where check_name = 'cron_route_failures_30m';
--      -- expect pass, 0, 'son 30 dakikada N çalışma, başarısız yok' (the same as before applying)
--   select count(*) from public.ops_health_report();   -- expect 22
--   select md5(p.prosrc), length(p.prosrc) from pg_proc p where p.oid = 'public.ops_health_report()'::regprocedure;
--      -- expect 52072a51a208b77e1cae577db8a22ff1, 55271
--   select has_function_privilege('anon', 'public.ops_health_report()', 'execute'),
--          has_function_privilege('authenticated', 'public.ops_health_report()', 'execute'),
--          has_function_privilege('service_role', 'public.ops_health_report()', 'execute');
--      -- expect f, f, t
--   select route, count(*), max(ran_at) from public.ops_cron_route_runs where ran_at >= now() - interval '7 days' group by route order by route;
--      -- fact-checks present with a newest row under 130 minutes old; a route that has never recorded is not flagged
--   select version, name from supabase_migrations.schema_migrations where version = '195';   -- 1 row
--
-- ROLLBACK (nothing else depends on 195; run by the operator, in one transaction)
--   re-run ONLY 192's ops_health_report() section: the text of
--     192_saved_clusters_v4.sql from `create or replace function public.ops_health_report()` through
--     `grant execute on function public.ops_health_report() to service_role;` (it re-creates the function with its comment, revoke and
--     grant: md5(prosrc) a2252c75458b9d86a0a536b589d97ceb, length 52463, ACL {postgres=X/postgres,service_role=X/postgres});
--   then:
--     notify pgrst, 'reload schema';
--     delete from supabase_migrations.schema_migrations where version = '195';   -- ledger row 195
--   The heartbeat, /durum and /api/health do not depend on the new detail text. Rolling back removes the fact-checks gap and the streak rule.
--
-- Additive. Safe to re-apply (create or replace function, the ledger insert on conflict do nothing; the revoke and the grant are
-- idempotent). One transaction; lock_timeout 5s bounds the catalogue lock. No table, no column, no index, no trigger, no policy, no
-- pg_cron job, no data rewrite, no CONCURRENTLY step, no grant to anon or authenticated. No LLM spend.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. ops_health_report(): 192's text verbatim from the create line through the grant, except row 15 (the fact-checks gap
--    and the low-cadence streak rule), the function comment's description of row 15 and its migration list.
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

  -- 15. cron_route_failures_30m (migration 136; the fact-checks gap and the low-cadence streak rule: migration 195, h118-crons-1). The Vercel cron routes (headline, digest, fact-checks, social, alerts-webhooks) record every authenticated run in public.ops_cron_route_runs through ops_cron_route_run_record (withCronOutcome, written by after()). A route that answers 5xx leaves no trace in rows 1-14 (2026-10-31: 189 headline statement timeouts over 18 hours, no alert). Fail when one route has at least 2 failures (status >= 500) that are at least half of its runs in the last 30 minutes, so a single blip in a daily route stays a warn; warn on any failure; warn when the window holds no run at all (the app side is not recording). That 30 minute rule is the one headline (every 5 minutes) and alerts-webhooks (every 10) keep exactly; it cannot fail an hourly or weekly route, whose runs never share a 30 minute window, and a warn never pages (scripts/lib/ops-heartbeat.mjs exits 1 only for a fail), so fact-checks, social and digest also get a streak rule on their newest two rows within the 7 day retention, whatever the age of the rows: both at status >= 500 is a failing route (fail), only the newest at >= 500 is a warn (a newer success clears it), and the detail appends `ardışık başarısız: fact-checks 2/2` (route and count only, 1/2 for the warn; the Actions log is public). A run that Vercel kills at maxDuration (60 s) never reaches the wrapper's finally or after(), so it writes no row and no failure can be counted: the routes in the VALUES list below (headline every 5 minutes, alerts-webhooks every 10, fact-checks hourly at :23) are also checked for silence. A route that has recorded within the 7 day retention but whose newest row is older than warn_min (15 / 25 / 130 minutes: three, 2.5 and two ticks) is a warn, older than fail_min (30 / 60 / 250: six, six and four ticks) a fail, named in the detail as `kayıt gelmiyor: headline 31 dk`, even while other routes keep writing rows. Social (daytime only, 05:00-20:59 UTC) and digest (weekly) have too few ticks for a gap rule and stay out of the silence list; a route that has never recorded cannot be compared with anything and is not flagged (the VERIFY query shows it). Row 15's own variables are declared in a nested block, so the declare block of the function stays 192's.
  check_name := 'cron_route_failures_30m'; threshold := 1; observed := null; detail := null;
  declare
    v_low_fail numeric;
    v_low_warn numeric;
    v_low_text text;
  begin
    v_n := null; v_total := null; v_zero := null; v_text := null;
    v_jobs := null; v_active := null; v_zone := null;
    v_low_fail := null; v_low_warn := null; v_low_text := null;
    if pg_catalog.to_regclass('public.ops_cron_route_runs') is null then
      status := 'unknown'; detail := 'ops_cron_route_runs yok';
    else
      with r as (
        select x.route,
               pg_catalog.count(*) as runs,
               pg_catalog.count(*) filter (where x.status >= 500) as failures
          from public.ops_cron_route_runs x
         where x.ran_at >= v_now - interval '30 minutes'
         group by x.route
      )
      select pg_catalog.sum(r.runs),
             pg_catalog.sum(r.failures),
             pg_catalog.count(*) filter (where r.failures >= 2 and r.failures * 2 >= r.runs),
             pg_catalog.string_agg(
               r.route || ' ' || r.failures::text || '/' || r.runs::text, ', '
               order by (r.failures >= 2 and r.failures * 2 >= r.runs) desc, r.failures desc, r.runs, r.route
             ) filter (where r.failures >= 1)
        into v_total, v_n, v_zero, v_text
        from r;
      -- silence: the newest row per listed route, in minutes (warn_min / fail_min are the gaps)
      with e (route, warn_min, fail_min) as (
        values ('headline'::text, 15::numeric, 30::numeric),
               ('alerts-webhooks'::text, 25::numeric, 60::numeric),
               ('fact-checks'::text, 130::numeric, 250::numeric)
      ),
      s as (
        select e.route, e.warn_min, e.fail_min,
               extract(epoch from (v_now - pg_catalog.max(x.ran_at))) / 60.0 as age_min
          from e
          join public.ops_cron_route_runs x on x.route = e.route
         where x.ran_at >= v_now - interval '7 days'
         group by e.route, e.warn_min, e.fail_min
      )
      select pg_catalog.count(*) filter (where s.age_min > s.warn_min)::numeric,
             pg_catalog.bool_or(s.age_min > s.fail_min),
             pg_catalog.string_agg(
               s.route || ' ' || pg_catalog.floor(s.age_min)::text || ' dk', ', '
               order by s.age_min desc, s.route
             ) filter (where s.age_min > s.warn_min)
        into v_jobs, v_active, v_zone
        from s;
      -- low-cadence routes (migration 195): the newest two rows of each route within the 7 day retention. streak is 2 when both rows are
      -- failures (status >= 500), 1 when only the newest is, else 0 (a newer success clears an older failure). The 30 minute rule above
      -- cannot see an hourly or weekly route fail twice, and seldom a social one (every 20 minutes, daytime only): those are the three routes below.
      with l as (
        select x.route, x.status,
               pg_catalog.row_number() over (partition by x.route order by x.ran_at desc, x.id desc) as rn
          from public.ops_cron_route_runs x
         where x.route in ('fact-checks', 'social', 'digest')
           and x.ran_at >= v_now - interval '7 days'
      ),
      k as (
        select l.route,
               case when pg_catalog.count(*) filter (where l.status >= 500) = 2 then 2
                    when pg_catalog.bool_or(l.rn = 1 and l.status >= 500) then 1
                    else 0 end as streak
          from l
         where l.rn <= 2
         group by l.route
      )
      select pg_catalog.count(*) filter (where k.streak = 2)::numeric,
             pg_catalog.count(*) filter (where k.streak >= 1)::numeric,
             pg_catalog.string_agg(
               k.route || ' ' || k.streak::text || '/2', ', '
               order by k.streak desc, k.route
             ) filter (where k.streak >= 1)
        into v_low_fail, v_low_warn, v_low_text
        from k;
      v_total := coalesce(v_total, 0); v_n := coalesce(v_n, 0); v_zero := coalesce(v_zero, 0);
      v_jobs := coalesce(v_jobs, 0); v_active := coalesce(v_active, false);
      v_low_fail := coalesce(v_low_fail, 0); v_low_warn := coalesce(v_low_warn, 0);
      if v_total = 0 and v_jobs = 0 and v_low_warn = 0 then
        status := 'warn'; observed := null; detail := 'son 30 dakikada cron rotası kaydı yok';
      else
        observed := v_n + v_jobs + v_low_warn;
        status := case when v_zero >= 1 or v_active or v_low_fail >= 1 then 'fail'
                       when v_n >= 1 or v_jobs >= 1 or v_low_warn >= 1 or v_total = 0 then 'warn'
                       else 'pass' end;
        detail := substr(pg_catalog.concat_ws(' · ',
          case when v_n >= 1 then 'son 30 dakikada başarısız: ' || v_text
               when v_total = 0 then 'son 30 dakikada cron rotası kaydı yok'
               else 'son 30 dakikada ' || v_total::text || ' çalışma, başarısız yok' end,
          case when v_jobs >= 1 then 'kayıt gelmiyor: ' || v_zone end,
          case when v_low_warn >= 1 then 'ardışık başarısız: ' || v_low_text end), 1, 500);
      end if;
    end if;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 16. db_size_mb (migration 136). pg_database_size was 6252 MB on 2026-11-01 (jev_shadow_predictions 3142 MB, articles 2016 MB) and nothing watched it. The warn and fail limits in MB come from public.ops_db_size_limits() (default 7000 / 7600; the founder sets them to 70% / 85% of the provisioned disk with create or replace); threshold is the warn limit. The detail names the three biggest public relations.
  check_name := 'db_size_mb'; threshold := null; observed := null; detail := null;
  begin
    v_n := null; v_total := null; v_text := null;
    select l.warn_mb, l.fail_mb into v_n, v_total from public.ops_db_size_limits() l;
    threshold := v_n;
    observed := round(pg_catalog.pg_database_size(pg_catalog.current_database()) / 1048576.0);
    select pg_catalog.string_agg(t.relname || ' ' || t.mb::text || ' MB', ', ' order by t.sz desc, t.relname)
      into v_text
      from (
        select c.relname::text as relname,
               pg_catalog.pg_total_relation_size(c.oid) as sz,
               round(pg_catalog.pg_total_relation_size(c.oid) / 1048576.0) as mb
          from pg_catalog.pg_class c
          join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public'
           and c.relkind in ('r', 'm')
         order by sz desc, c.relname
         limit 3
      ) t;
    status := case when observed >= v_total then 'fail' when observed >= v_n then 'warn' else 'pass' end;
    detail := 'veritabanı ' || observed::text || ' MB · uyarı ' || v_n::text || ' MB · kritik ' || v_total::text || ' MB · en büyük: ' || coalesce(v_text, '-');
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 17. anon_surface (migration 145). Supabase Auth signup is open (auth.users is empty and no code uses Supabase Auth), 13 dormant USING (true) SELECT policies exist on public, and the supabase_admin default ACL (which postgres cannot alter) hands anon and authenticated privileges on every object that role creates; tests/guards/anon-surface.test.ts reads migration text only, so a dashboard change or a supabase_admin privilege never reaches it. This row reads what anon and authenticated can actually do. Fail when either role holds any privilege on a relation or sequence of public (an ACL entry counts too, which catches PG17 MAINTAIN) or can execute a SECURITY DEFINER function there outside the seven allowlisted RPCs, each exempt by its full signature (name and argument types), so an overload of an allowlisted name is counted (trigger functions and extension members excluded); warn when it can execute an invoker function there or auth.users holds a row (signup abuse); skip without the roles. The detail carries counts only, never object names or user data: ops-heartbeat.mjs prints every detail to the stdout and the step summary of the GitHub Actions run, and that repository is public, so a name here would tell anyone which endpoint to call with the public anon key; the names come from the service-role query in docs/ops-heartbeat.md (Anon yüzeyi).
  check_name := 'anon_surface'; threshold := 1; observed := null; detail := null;
  begin
    v_n := null; v_total := null; v_jobs := null; v_zero := null;
    if pg_catalog.to_regrole('anon') is null or pg_catalog.to_regrole('authenticated') is null then
      status := 'skip'; detail := 'anon/authenticated rolü yok';
    else
      select pg_catalog.count(*)::numeric
        into v_n
        from (
          select c.oid
            from pg_catalog.pg_class c
            join pg_catalog.pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public'
             and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
             and (
                   case when c.relkind = 'S'
                        then pg_catalog.has_sequence_privilege('anon', c.oid, 'USAGE,SELECT,UPDATE')
                          or pg_catalog.has_sequence_privilege('authenticated', c.oid, 'USAGE,SELECT,UPDATE')
                        else pg_catalog.has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                          or pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                   end
                   or exists (
                        select 1
                          from pg_catalog.aclexplode(c.relacl) a
                         where a.grantee in (pg_catalog.to_regrole('anon')::oid, pg_catalog.to_regrole('authenticated')::oid)
                      )
                 )
        ) r;

      select pg_catalog.count(*) filter (where f.definer)::numeric,
             pg_catalog.count(*) filter (where not f.definer)::numeric
        into v_total, v_jobs
        from (
          select p.prosecdef as definer
            from pg_catalog.pg_proc p
            join pg_catalog.pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.prokind in ('f', 'p')
             and p.prorettype not in ('pg_catalog.trigger'::pg_catalog.regtype, 'pg_catalog.event_trigger'::pg_catalog.regtype)
             and not exists (select 1 from pg_catalog.pg_depend d where d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass and d.objid = p.oid and d.deptype = 'e')
             and p.proname::text || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' <> all (array['saved_clusters(uuid[])', 'merged_cluster_map()', 'source_slugs()', 'source_slug_exists(text)', 'saved_clusters_v2(uuid[])', 'saved_clusters_v3(uuid[])', 'saved_clusters_v4(uuid[])'])
             and (
                   pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
                   or pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
                 )
        ) f;

      v_n := coalesce(v_n, 0); v_total := coalesce(v_total, 0); v_jobs := coalesce(v_jobs, 0);

      if pg_catalog.to_regclass('auth.users') is not null then
        begin
          execute 'select pg_catalog.count(*)::numeric from (select 1 from auth.users limit 1000) u' into v_zero;
        exception when others then
          v_zero := null;
        end;
      end if;

      observed := v_n + v_total + v_jobs;
      status := case when v_n + v_total >= 1 then 'fail' when v_jobs >= 1 or coalesce(v_zero, 0) >= 1 then 'warn' else 'pass' end;
      detail := substr(
        case when observed = 0 then 'anon/authenticated yetkisi yok: ' else 'anon/authenticated yetkisi var: ' end
        || 'tablo/dizi ' || v_n::text
        || ', definer fonksiyon ' || v_total::text
        || ', invoker fonksiyon ' || v_jobs::text
        || ' (7 izinli RPC hariç)'
        || case when observed > 0 then ' · adlar için: docs/ops-heartbeat.md (Anon yüzeyi)' else '' end
        || ' · auth.users ' || coalesce(v_zero::text, 'okunamadı'),
        1, 500);
    end if;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 18. queue_lag (migration 150). Nothing watched clustering: ops_health_report() had no row on the pgmq queues (cluster_work feeds every home and cluster page, image_backfill the article images), so a dead consumer, an undeployed or renamed Edge Function (404) or a poison message read green while ingest kept rows 3-6 green. This row reads, for both queues, the depth (count(*)) and the age in seconds of the oldest VISIBLE message (vt <= now(); an in-flight message is not waiting), plus the messages archived in the last 24 hours with read_ct > 3 (poison: the consumers archive on the 4th read, MAX_READS = 3, so a message processed on its 3rd read is not poison, migration 167; the archived_at indexes make it a range scan). Baselines, measured on 2026-11-02 over 48 h: cluster_work wait p95 60 s, max 86.5 s; image_backfill p95 721 s, max 803 s (the hourly image-backfill-requeue and the 5 minute image-drain make it slow by design). Fail when cluster_work's oldest message is older than 900 s or image_backfill's older than 3600 s; warn when cluster_work's oldest is older than 300 s or its depth is above 300, image_backfill's oldest is older than 1800 s, or any poison message exists; observed is cluster_work's oldest age in seconds, threshold 900; unknown without the pgmq tables. The detail is counts only (depths, ages in seconds, the poison count), never a message body or id: ops-heartbeat.mjs prints every detail to the stdout and the step summary of a public GitHub Actions log.
  check_name := 'queue_lag'; threshold := 900; observed := null; detail := null;
  declare
    qc_depth  numeric;
    qc_oldest numeric;
    qi_depth  numeric;
    qi_oldest numeric;
    q_poison  numeric;
  begin
    if pg_catalog.to_regclass('pgmq.q_cluster_work') is null or pg_catalog.to_regclass('pgmq.q_image_backfill') is null then
      status := 'unknown'; detail := 'pgmq kuyruğu yok';
    else
      execute $q$
        select (select pg_catalog.count(*) from pgmq.q_cluster_work)::numeric,
               (select coalesce(extract(epoch from pg_catalog.now() - pg_catalog.min(m.enqueued_at)), 0) from pgmq.q_cluster_work m where m.vt <= pg_catalog.now())::numeric,
               (select pg_catalog.count(*) from pgmq.q_image_backfill)::numeric,
               (select coalesce(extract(epoch from pg_catalog.now() - pg_catalog.min(m.enqueued_at)), 0) from pgmq.q_image_backfill m where m.vt <= pg_catalog.now())::numeric,
               ((select pg_catalog.count(*) from pgmq.a_cluster_work a where a.archived_at >= pg_catalog.now() - interval '24 hours' and a.read_ct > 3)
                + (select pg_catalog.count(*) from pgmq.a_image_backfill a where a.archived_at >= pg_catalog.now() - interval '24 hours' and a.read_ct > 3))::numeric
      $q$ into qc_depth, qc_oldest, qi_depth, qi_oldest, q_poison;
      observed := round(qc_oldest);
      status := case when qc_oldest > 900 or qi_oldest > 3600 then 'fail' when qc_oldest > 300 or qc_depth > 300 or qi_oldest > 1800 or q_poison >= 1 then 'warn' else 'pass' end;
      detail := 'cluster_work: ' || qc_depth::text || ' mesaj, en eski ' || round(qc_oldest)::text
             || ' sn · image_backfill: ' || qi_depth::text || ' mesaj, en eski ' || round(qi_oldest)::text
             || ' sn · zehirli (24 sa): ' || q_poison::text;
    end if;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 19. cron_jobs_stalled (migration 150). Row 1 counts only runs with status 'failed' in the last 30 minutes, so an unscheduled or deactivated job (cluster-drain, image-drain, prune-nightly, ops-health-snapshot itself, ...) produced no row and read green; migration 131's header records a 6-day archive hole that nothing flagged. This row reads the jobs listed in public.ops_cron_expected (jobname, max_gap; the operator tunes it) against cron.job and the newest cron.job_run_details row of each job inside the newest 7000 run ids (about 1.5 x the runs of 26 hours on 2026-11-02; job_run_details has no start_time index, so the runid window is the bound, as in row 1). Each listed job is counted once: missing (no cron.job row), inactive (active is false), stale (no run in the window, or its newest start_time is older than max_gap; any run status counts as a run, because a job that runs and fails is the warn case below, not a silent one) or failed (the newest run has status 'failed'). Fail when missing + inactive + stale >= 1, observed = that count; else warn when failed >= 1, observed = the failed count; else pass with observed 0; threshold 1. unknown without pg_cron or without the table. It never reads cron.job.command or the run's command / return_message (they carry vault secrets). The detail lists job names and counts only (a public Actions log prints it): yok / pasif / koşu yok / son koşu başarısız followed by the names, or N iş izleniyor.
  check_name := 'cron_jobs_stalled'; threshold := 1; observed := null; detail := null;
  declare
    j_total    numeric;
    j_missing  numeric;
    j_inactive numeric;
    j_stale    numeric;
    j_failed   numeric;
    n_missing  text;
    n_inactive text;
    n_stale    text;
    n_failed   text;
  begin
    if pg_catalog.to_regclass('cron.job_run_details') is null or pg_catalog.to_regclass('cron.job') is null then
      status := 'unknown'; detail := 'pg_cron yok';
    elsif pg_catalog.to_regclass('public.ops_cron_expected') is null then
      status := 'unknown'; detail := 'ops_cron_expected yok';
    else
      execute $q$
        select pg_catalog.count(*)::numeric,
               pg_catalog.count(*) filter (where s.kind = 'missing')::numeric,
               pg_catalog.count(*) filter (where s.kind = 'inactive')::numeric,
               pg_catalog.count(*) filter (where s.kind = 'stale')::numeric,
               pg_catalog.count(*) filter (where s.kind = 'failed')::numeric,
               pg_catalog.string_agg(s.jobname, ', ' order by s.jobname) filter (where s.kind = 'missing'),
               pg_catalog.string_agg(s.jobname, ', ' order by s.jobname) filter (where s.kind = 'inactive'),
               pg_catalog.string_agg(s.jobname, ', ' order by s.jobname) filter (where s.kind = 'stale'),
               pg_catalog.string_agg(s.jobname, ', ' order by s.jobname) filter (where s.kind = 'failed')
          from (
            select e.jobname,
                   case when j.jobid is null then 'missing'
                        when j.active is not true then 'inactive'
                        when r.start_time is null or r.start_time < pg_catalog.now() - e.max_gap then 'stale'
                        when r.status = 'failed' then 'failed'
                        else 'ok' end as kind
              from public.ops_cron_expected e
              left join cron.job j on j.jobname = e.jobname
              left join lateral (
                select d.start_time, d.status
                  from cron.job_run_details d
                 where d.jobid = j.jobid
                   and d.runid > (select coalesce(pg_catalog.max(x.runid), 0) - 7000 from cron.job_run_details x)
                 order by d.runid desc
                 limit 1) r on true
          ) s
      $q$ into j_total, j_missing, j_inactive, j_stale, j_failed, n_missing, n_inactive, n_stale, n_failed;
      observed := case when j_missing + j_inactive + j_stale >= 1 then j_missing + j_inactive + j_stale else j_failed end;
      status := case when j_missing + j_inactive + j_stale >= 1 then 'fail' when j_failed >= 1 then 'warn' else 'pass' end;
      detail := substr(
        case when status <> 'pass'
             then pg_catalog.concat_ws(' · ',
                    case when j_missing >= 1 then 'yok: ' || n_missing end,
                    case when j_inactive >= 1 then 'pasif: ' || n_inactive end,
                    case when j_stale >= 1 then 'koşu yok: ' || n_stale end,
                    case when j_failed >= 1 then 'son koşu başarısız: ' || n_failed end)
             else j_total::text || ' iş izleniyor' end,
        1, 500);
    end if;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 20. feed_poll_stale (migration 157, fail rule widened by migration 159). No row noticed a feed that stopped being polled while the others carried on: on 2026-11-05 BHA, an opposition wire, had not been polled for 2 h 39 min (its newest stored article was 17 h old, its created-minus-published lag p50 79 min, p90 363 min) because the ingest isolate item budget kept refusing its 4.25 MB body, and a refused feed writes no fetch state, so nothing moved; rows 3-6 stay green on any other outlet, and rows 10 and 13 wait 72 and 24 hours. A healthy feed is attempted every 3-minute cycle and a 200, a 304 or a failure all write sources.fetch_last_at, so a fetch_last_at older than 30 minutes means the feed was skipped or deferred, not that it was quiet. This row counts the active sources with no quarantine marker (fetch_quarantined_until is null: a marker, even one whose time has passed, means the source is dead or waiting for its probe, which the quarantine and rows 10 and 13 already cover) whose fetch_last_at is older than 30 minutes. A source never polled (fetch_last_at is null) is not counted, it is only named in the detail. Warn at 1; fail at 3, or when any counted feed was last polled more than 60 minutes ago (migration 159, h39-pipeline2-1: #198 did not end the starvation, and between 09:25 and 11:12 UTC on 2026-11-05 BHA went 107 minutes unpolled while this row read warn / 1 in eight consecutive snapshots (bha 218, 39, 49 ... 99 dk) and nothing paged, because one stale feed could only warn; with the 60-minute rule five of those eight snapshots are a fail); observed is still the count of feeds over 30 minutes, threshold 3; unknown if the read fails. The detail names the slugs with the minutes since the last poll, oldest first, cut at 500 characters (sources.slug is public, the site lists every source; no url, validator or header is read). On 2026-11-05 08:36 UTC: 1 (bha, 171 min); the next oldest of the other 90 feeds was 3.9 min.
  check_name := 'feed_poll_stale'; threshold := 3; observed := null; detail := null;
  declare
    f_total numeric;
    f_stale numeric;
    f_old   numeric;
    f_never numeric;
    f_list  text;
  begin
    select pg_catalog.count(*) filter (where x.fetch_last_at is not null)::numeric,
           pg_catalog.count(*) filter (where x.fetch_last_at < pg_catalog.now() - interval '30 minutes')::numeric,
           pg_catalog.count(*) filter (where x.fetch_last_at < pg_catalog.now() - interval '60 minutes')::numeric,
           pg_catalog.count(*) filter (where x.fetch_last_at is null)::numeric,
           pg_catalog.string_agg(coalesce(x.slug, '?') || ' ' || pg_catalog.floor(extract(epoch from pg_catalog.now() - x.fetch_last_at) / 60)::text || ' dk', ', ' order by x.fetch_last_at, x.slug)
             filter (where x.fetch_last_at < pg_catalog.now() - interval '30 minutes')
      into f_total, f_stale, f_old, f_never, f_list
      from public.sources x
     where x.active and x.fetch_quarantined_until is null;
    observed := f_stale;
    status := case when f_stale >= 3 or f_old >= 1 then 'fail' when f_stale >= 1 then 'warn' else 'pass' end;
    detail := substr(
      case when f_stale >= 1
           then '30 dakikadır yoklanmayan aktif kaynak ' || f_stale::text || ': ' || f_list
           else 'aktif kaynakların hepsi son 30 dakikada yoklandı (' || f_total::text || ')' end
      || case when f_never >= 1 then ' · hiç yoklanmayan: ' || f_never::text else '' end,
      1, 500);
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 21. image_coverage (migration 161, h40-edgefns-1). Nothing noticed an outlet that kept publishing but lost its article images. medyascope.tv has answered every article fetch of the image consumer with a Cloudflare challenge (HTTP 403, cf-mitigated: challenge, title Just a moment...) since 2026-10-29: its articles stored without an image, per day by created_at, went from 0 of 12 to 47 (10-19 to 10-27) to 27 of 32, 21 of 24, 15 of 18, 32 of 38, 34 of 37 and 40 of 45 (10-30 to 11-04), every settled row at image_backfill_attempts >= 3, while every other row stayed green: the consumer counted the block as not-found, queue_lag reads depth and age only, and sources_newly_dark (row 13) watches missing articles, not missing images. This row takes each source of kind outlet or wire with at least 10 articles created between 25 hours and 1 hour ago (the newest hour is skipped: the backfill has not reached it yet) and compares the share of those articles stored without an image (image_url is null) with the same source own share over the 14 days before (created between 15 days and 25 hours ago), a baseline that counts only when the source has at least 10 articles in it, so a source without a past is never flagged. Warn when the 24 hour share is at least 50 percent AND at least 40 points above that baseline: a change, not a level, because some feeds carry few images by nature. observed is the number of such sources, threshold 1; never fail (a lost image is not an outage, the page is still served); unknown if the read fails. The baseline is read only for the sources over 50 percent, through the (created_at, source_id) index, so a healthy day is one pass over the last 24 hours of articles by the articles.created_at index (about 11,000 rows, 30 ms). The detail lists slug, the 24 hour percentage and the 14 day percentage only, worst first, cut at 500 characters (sources.slug is public; no url, title or count is read). On 2026-11-05 14:50 UTC: 61 sources checked, 1 flagged, medyascope %86 görselsiz (14 gün: %38) (the 14 day share already holds the first blocked days); the next highest were cnn-turk at 36 percent and haberler-com at 29 percent, both under 50. The blocked days drift into the baseline while a block lasts, so with a block that does not end the row clears on its own after about 3 more days (around 2026-11-08, when the 14 day share passes 50 percent): it is the alarm, and the drain summary of image-consumer (blocked, blockedBySource) is the standing record.
  check_name := 'image_coverage'; threshold := 1; observed := null; detail := null;
  declare
    i_checked numeric;
    i_hit     numeric;
    i_list    text;
  begin
    with r as materialized (
      select a.source_id,
             pg_catalog.count(*)::numeric as n,
             pg_catalog.count(*) filter (where a.image_url is null)::numeric as nul
        from public.articles a
       where a.created_at >= v_now - interval '25 hours' and a.created_at < v_now - interval '1 hour'
       group by a.source_id
      having pg_catalog.count(*) >= 10),
    rs as (
      select r.source_id, r.n, r.nul, s.slug
        from r join public.sources s on s.id = r.source_id
       where s.kind in ('outlet', 'wire')),
    b as (
      select a.source_id,
             pg_catalog.count(*)::numeric as n,
             pg_catalog.count(*) filter (where a.image_url is null)::numeric as nul
        from public.articles a
       where a.created_at >= v_now - interval '15 days' and a.created_at < v_now - interval '25 hours'
         and a.source_id = any (array(select x.source_id from rs x where x.nul >= 0.5 * x.n))
       group by a.source_id
      having pg_catalog.count(*) >= 10),
    f as (
      select rs.slug,
             rs.nul / rs.n as share_24,
             b.nul / b.n as share_base,
             (b.n is not null and rs.nul / rs.n >= 0.5 and rs.nul / rs.n - b.nul / b.n >= 0.4) as hit
        from rs left join b on b.source_id = rs.source_id)
    select pg_catalog.count(*)::numeric,
           pg_catalog.count(*) filter (where f.hit)::numeric,
           pg_catalog.string_agg(
             f.slug || ' %' || pg_catalog.round(100 * f.share_24)::text || ' görselsiz (14 gün: %' || pg_catalog.round(100 * f.share_base)::text || ')',
             ', ' order by f.share_24 desc, f.slug) filter (where f.hit)
      into i_checked, i_hit, i_list
      from f;
    observed := i_hit;
    status := case when i_hit >= 1 then 'warn' else 'pass' end;
    detail := substr(
      case when i_hit >= 1
           then 'son 24 saatte görselsiz haber oranı sıçrayan kaynak ' || i_hit::text || ': ' || i_list
           else 'görselsiz haber oranında sıçrama yok (' || i_checked::text || ' kaynak)' end,
      1, 500);
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 22. sources_dark_persistent (migration 173, h64-backendops-1). Row 13 (sources_newly_dark) counts a source's articles only inside created_at >= now - 14 days 24 hours and needs none in the last 24 hours, so a source that stays dark rolls out of that window and the row forgets it after 14 days; row 8 (dead_feeds) is a count (pass at 25 of 96, warn only above 38) and names nothing. On 2026-11-08 five outlets of the muhalefet and bagimsiz zones had been dark for 14 to 24 days (halk-tv, gazete-pencere, benguturk, arti-gercek, medya-gazete: 17,632 articles between 15 September and 14 October) and no row named any of them. This row keeps naming a high-volume source for as long as it stays dark. Candidates: active outlet or wire sources outside public.ops_dark_source_baseline whose newest article (published_at <= now, the same per-source limit 1 lookup as row 8, through the (source_id, published_at) index) is missing or older than 72 hours. prior_n is the number of a candidate's articles published in the 60 days up to its newest article (published_at > newest - 60 days and <= newest; a source with no article dated at or before now counts the articles published after now - 60 days). The window is anchored at the newest article, not at the clock, so the count does not shrink as the silence goes on: a window that moved with now would roll the volume off after 60 days and the row would forget the source, the failure this row exists to prevent. A candidate is flagged at 300 or more. The count is one scalar subquery per candidate, an index-only scan of idx_articles_source_published_inc_id (source_id, published_at desc) include (id), never grouped over every source; a healthy day has no candidate and the row costs only the newest-article lookups. observed is the flagged count, threshold 1; warn at one, else pass; NEVER fail (a dark outlet is an editorial gap, the site is still served); unknown if the read fails. The row stays on while the source stays dark and clears only when the source delivers again, is inserted into ops_dark_source_baseline, or is set inactive. The detail (Turkish, cut at 500 characters) lists slug, the window count, the reason label of row 13 (erişim yok, akış donmuş, sessiz, read from sources.fetch_*, the same CASE) and the date of the newest article in Istanbul time (yok when none is dated at or before now), largest first; sources.slug is public (the site lists every source); no url, title or rss_url is read, because ops-heartbeat.mjs prints every detail to a public GitHub Actions log.
  check_name := 'sources_dark_persistent'; threshold := 1; observed := null; detail := null;
  declare
    d_hit  numeric;
    d_list text;
  begin
    with vs as materialized (
      select s.id, s.slug,
             case when (s.fetch_quarantined_until is not null and s.fetch_quarantined_until > v_now)
                       or coalesce(s.fetch_fail_streak,0) > 0
                       or s.fetch_last_status is null
                       or not (s.fetch_last_status between 200 and 299 or s.fetch_last_status = 304)
                  then 'erişim yok'
                  when s.fetch_items_count = 0
                       or s.fetch_newest_item_at < v_now - interval '72 hours'
                  then 'akış donmuş'
                  else 'sessiz' end as reason,
             (select a.published_at from public.articles a
               where a.source_id = s.id and a.published_at <= v_now
               order by a.published_at desc limit 1) as last_at
        from public.sources s where s.active and s.kind in ('outlet', 'wire')
         and not exists (select 1 from public.ops_dark_source_baseline b where b.slug = s.slug)),
    cand as materialized (
      select v.id, v.slug, v.reason, v.last_at,
             (select pg_catalog.count(*) from public.articles a
               where a.source_id = v.id
                 and a.published_at > coalesce(v.last_at, v_now) - interval '60 days'
                 and a.published_at <= coalesce(v.last_at, 'infinity'::timestamptz)) as prior_n
        from vs v
       where v.last_at is null or v.last_at < v_now - interval '72 hours')
    select pg_catalog.count(*) filter (where v.prior_n >= 300)::numeric,
           pg_catalog.string_agg(
             v.slug || ' (' || v.prior_n::text || ') · ' || v.reason || ' · son haber '
               || coalesce(pg_catalog.to_char(v.last_at at time zone 'Europe/Istanbul', 'DD.MM'), 'yok'),
             ', ' order by v.prior_n desc, v.slug) filter (where v.prior_n >= 300)
      into d_hit, d_list
      from cand v;
    observed := d_hit;
    status := case when d_hit >= 1 then 'warn' else 'pass' end;
    detail := case when d_hit >= 1
      then substr('72 saattir haber gelmeyen, önceki 60 günde en az 300 haberi olan ve listede olmayan kaynaklar: ' || d_list, 1, 500)
      else 'kalıcı susan kaynak yok' end;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  return;
end
$fn$;

comment on function public.ops_health_report() is
  'Read-only ops heartbeat (migrations 077, 100, 103, 108, 114, 115, 119, 122, 136, 145, 150, 157, 158, 159, 161, 167, 173, 192, 195): 22 fixed rows, in this order --'
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
  ' HH:MI→HH:MI in UTC, longest first),'
  ' cron_route_failures_30m (HTTP 5xx outcomes of the Vercel cron routes in public.ops_cron_route_runs,'
  ' written by withCronOutcome, last 30 min: warn at 1 failure, fail when one route has at least 2'
  ' failures that are at least half of its runs; warn when the window holds no run at all; the detail'
  ' lists the failing routes as route failures/runs, worst first; a run Vercel kills at maxDuration writes'
  ' no row, so headline (every 5 min), alerts-webhooks (every 10 min) and fact-checks (hourly) are also checked for silence:'
  ' a route with a row in the last 7 days whose newest row is older than 15 / 25 / 130 min is a warn and'
  ' older than 30 / 60 / 250 min a fail, named in the detail as kayıt gelmiyor: route n dk;'
  ' the low-cadence routes fact-checks, social and digest, whose runs seldom or never share a 30 minute window, are'
  ' also judged on their newest two rows within 7 days, whatever the age of the rows: both with status >= 500'
  ' is a fail, only the newest a warn, named in the detail as ardışık başarısız: route 2/2 (or 1/2); route'
  ' names and counts only),'
  ' db_size_mb (pg_database_size in MB against public.ops_db_size_limits(): warn at the first limit,'
  ' fail at the second, threshold is the warn limit; the detail names the three biggest public relations),'
  ' anon_surface (what anon and authenticated can actually do in public, read from the catalogue: any'
  ' privilege on a table, view, materialized view, foreign table or sequence, an ACL entry for either role'
  ' included (this catches PG17 MAINTAIN), or EXECUTE on a SECURITY DEFINER function other than the seven'
  ' allowlisted RPCs saved_clusters, merged_cluster_map, source_slugs, source_slug_exists,'
  ' saved_clusters_v2, saved_clusters_v3 and saved_clusters_v4, each exempt by its full signature, name and argument types (trigger functions and'
  ' extension members excluded) is a fail; EXECUTE on an invoker function there, or a row in auth.users'
  ' (signup abuse), is a warn; skip when the roles do not exist; the detail carries counts only, never'
  ' object names or user data, because the heartbeat output is public: the names are in the service-role'
  ' query of docs/ops-heartbeat.md, Anon yüzeyi),'
  ' queue_lag (the pgmq queues cluster_work and image_backfill: the depth, and the age in seconds of the oldest'
  ' visible message, vt <= now(); plus the messages archived in the last 24 hours with read_ct > 3, poison (the consumers'
  ' archive on the 4th read, MAX_READS = 3; a message processed on its 3rd read is not poison;'
  ' cluster-consumer gates only a failed attempt, so a cluster_work message that succeeds on its 4th or later read is counted too);'
  ' fail when the oldest cluster_work message is older than 900 s or the oldest image_backfill message older'
  ' than 3600 s; warn when the oldest cluster_work message is older than 300 s or its depth is above 300, the'
  ' oldest image_backfill message is older than 1800 s, or one poison message exists; observed is the oldest'
  ' cluster_work age in seconds, threshold 900; unknown without pgmq; the detail carries counts and ages'
  ' only, never a message body or id),'
  ' cron_jobs_stalled (the jobs listed in public.ops_cron_expected, each with its own max_gap, against'
  ' cron.job and the newest cron.job_run_details row of the job inside the newest 7000 run ids: fail when a'
  ' listed job is missing from cron.job, inactive, or has no run newer than max_gap, any run status counting'
  ' as a run; warn when only the newest run of a job failed; observed is the count of failing jobs (the'
  ' failed ones for a warn), threshold 1; unknown without pg_cron or the table; the detail lists job names'
  ' and counts only; the operator tunes the table, see docs/ops-heartbeat.md, Kuyruk ve cron canlılığı),'
  ' feed_poll_stale (the active sources of public.sources with no quarantine marker, fetch_quarantined_until null,'
  ' whose last poll, fetch_last_at, is older than 30 minutes: a healthy feed is attempted every 3-minute ingest cycle and'
  ' any outcome writes fetch_last_at, so a stale one was skipped or deferred, for example by the ingest isolate item'
  ' budget; a source never polled is not counted, only named; warn at 1, fail at 3 or when any counted feed was last polled more than 60 minutes ago; observed is the count, threshold 3;'
  ' unknown if the read fails; the detail lists the slugs with the minutes since the last poll, oldest first, and'
  ' nothing else),'
  ' image_coverage (per source of kind outlet or wire with at least 10 articles created between 25 hours and 1 hour ago,'
  ' the newest hour skipped because the image backfill has not reached it: the share of those articles stored without an'
  ' image, image_url null, against the same source own share over the 14 days before, created between 15 days and 25 hours'
  ' ago, counted only when that period holds at least 10 articles of the source; warn when the 24 hour share is at least'
  ' 50 percent and at least 40 points above the baseline, for example a site that starts answering the image fetch with a'
  ' Cloudflare challenge; observed is the number of such sources, threshold 1; never fails; unknown if the read fails;'
  ' the detail lists slug, the 24 hour percentage and the 14 day percentage only, worst first),'
  ' sources_dark_persistent (an active outlet or wire source of public.sources outside public.ops_dark_source_baseline whose newest'
  ' article, published_at <= now, is missing or older than 72 hours and that has at least 300 articles published in the 60 days up to'
  ' that newest article, counted for those candidates only; sources_newly_dark (row 13) stops naming a source after 14 days of silence and'
  ' dead_feeds only counts, so this row stays on while the source stays dark and clears when it delivers again, is added to the'
  ' baseline or is set inactive; observed is the number of such sources, threshold 1; warn only, never fails; unknown if the read'
  ' fails; the detail lists slug, the article count of that window, the reason label of row 13 and the date of the last article,'
  ' largest first, and nothing else).'
  ' status is one of pass|warn|fail|unknown|skip, and threshold is the fail limit'
  ' (or the warn limit for warn-only checks). Never writes any table, and'
  ' never reads any potentially secret-bearing pg_cron job field. Polled by'
  ' .github/workflows/ops-heartbeat.yml over PostgREST every 30 minutes.'
  ' service_role only. See docs/ops-heartbeat.md.';


revoke all on function public.ops_health_report() from public, anon, authenticated;
grant execute on function public.ops_health_report() to service_role;

-- ---------------------------------------------------------------------------
-- 2. PostgREST schema cache; ledger.
-- ---------------------------------------------------------------------------

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('195', '195_ops_cron_route_low_cadence')
  on conflict do nothing;

commit;
