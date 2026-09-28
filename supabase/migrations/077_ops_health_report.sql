-- 077_ops_health_report.sql
--
-- Ops heartbeat: public.ops_health_report(), a read-only SECURITY DEFINER
-- function returning 10 fixed pass/warn/fail/unknown/skip rows, polled by
-- .github/workflows/ops-heartbeat.yml on a */30 cron. See docs/ops-heartbeat.md.
--
-- Why: cron.job_run_details reports 'succeeded' for every http-poking pg_cron
-- job the moment net.http_post queues the request -- it never waits for the
-- response, so a cron job can show green for weeks while the Edge Function it
-- calls is failing every single invocation. Direct evidence from
-- net._http_response over a ~6 h production window: 844 200s, 9 546
-- (WORKER_RESOURCE_LIMIT, counted as an error: >= 500), 4 timeouts, 1 send
-- failure. Over the same 7 days, cron.job_run_details showed 0 failures.
-- Nothing pages anyone today; this migration plus the Action are the pager.
--
-- Step 0 read-only findings (2026-09-28, against the live project; see the
-- task's SPEC for the exact queries) and how each threshold below was tuned:
--   1. net._http_response has status_code, timed_out, error_msg, created --
--      exactly what the edge_http_errors_30m check reads.
--   2. has_table_privilege('postgres', ...) is true for both net._http_response
--      and cron.job_run_details -- the SECURITY DEFINER reads will not be
--      blocked by grants.
--   3. Error baseline: ~140 responses/hour, 1-4 errors/hour (~0.5-2 per 30
--      min) at a healthy time, matching the idea's "~1.2 per 30 minutes"
--      estimate. Kept the drafted edge_http_errors_30m thresholds as written
--      (fail >= 5 and >= 5% of the batch, warn >= 2).
--   4. cron.job has both 'jev-shadow' and 'blindspot-recall-veto', both
--      active. cron.job_run_details volume is ~3.4k rows/day, far under the
--      ~240k/day (5000-row window still covers >> 30 minutes) the runid-window
--      trick assumes. Kept cron_failed_runs_30m as written (fail >= 1).
--   5. Zone freshness (7 days, active outlet/wire sources joined through the
--      BIAS_TO_ZONE map below): max gap 104.9 min (bagimsiz), p99 15.0 min.
--      fail = max(90, ceil(1.5 * 104.9)) = 158; warn = fail / 2 = 79 (was the
--      drafted 90/45 -- raised to clear the real p99/max spread with margin).
--   6. ingest_cycles per 30-minute bucket over 3 days: min 2 (edge-of-window
--      partial bucket), p5 8 -- consistent with the idea's "432-459 a day"
--      estimate (~9-9.5 per 30 min against 10 expected). Kept
--      ingest_cycles_30m as written (fail < 5, warn < 8).
--   7. Dead feeds (exact 077 definition below): 35 of 96 active outlet/wire
--      sources (36.4%) had no published_at in the last 72h (15 never
--      published at all, 20 stale) -- materially higher than the idea's
--      "23 dead" synth estimate (24%). Raised the fail ratio from the
--      drafted 0.35 to 0.50 and the warn count from the drafted 25 to
--      observed + 3 = 38, so today's real baseline (35, 36.4%) reads 'pass'
--      instead of paging on day one; the 15 never-published feeds are a
--      known pre-existing issue to chase separately (docs/ops-heartbeat.md).
--   8. jev-shadow: max gap between consecutive jev_shadow_runs.finished_at
--      over 3 days is 10.6 minutes. Kept jev_shadow_last_run_min as written
--      (fail > 30, warn > 20).
--   9. Alerts: 13 unacked jev_alerts, 12 of them older than 72h, close to the
--      idea's "13 unacked" estimate. This check is warn-only by design (a
--      queue, not an outage); kept threshold = 1 as written.
--
-- Read-only: this function never writes to any table, never schedules
-- cron.*, and never reads cron.job.command or cron.job_run_details.return_message
-- (both can carry secrets/PII). It reaches cron.* and net.* only through
-- EXECUTE strings guarded by to_regclass, so a project without pg_cron or
-- pg_net still returns 10 rows (status 'unknown' for the affected checks)
-- instead of raising.
--
-- The zone map below is the eighth declared SQL copy of BIAS_TO_ZONE
-- (supabase/functions/_shared/cluster/blindspot.ts); it is pinned by
-- tests/migrations/077-ops-health-report.test.ts and listed in
-- tests/migrations/zone-parity.test.ts's KNOWN_FILES.
--
-- DEPLOY ORDER: apply this migration to production BEFORE
-- .github/workflows/ops-heartbeat.yml reaches the default branch -- the
-- workflow calls public.ops_health_report() over PostgREST and a missing
-- function is a 404, which the runner treats as exit 2 (not a real 'fail',
-- but a red, confusing CI run). See docs/migration-guide.md.

begin;

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

  return;
end
$fn$;

comment on function public.ops_health_report() is
  'Read-only ops heartbeat (migration 077): 10 fixed rows, in this order --'
  ' cron_failed_runs_30m, edge_http_errors_30m, ingest_cycles_30m,'
  ' ingest_fresh_iktidar_min, ingest_fresh_bagimsiz_min, ingest_fresh_muhalefet_min,'
  ' jev_shadow_last_run_min, blindspot_veto_cron_min, jev_alerts_unacked_72h, dead_feeds.'
  ' status is one of pass|warn|fail|unknown|skip; threshold is the fail limit'
  ' (or the warn limit for warn-only checks). Never writes any table, and'
  ' never reads any potentially secret-bearing pg_cron job field. Polled by'
  ' .github/workflows/ops-heartbeat.yml over PostgREST every 30 minutes.'
  ' service_role only. See docs/ops-heartbeat.md.';

revoke all on function public.ops_health_report() from public, anon, authenticated;
grant execute on function public.ops_health_report() to service_role;

insert into supabase_migrations.schema_migrations (version, name)
  values ('077', '077_ops_health_report') on conflict do nothing;

commit;
