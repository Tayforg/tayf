-- 115_sources_newly_dark_24h.sql
--
-- The nightly false warnings of ops_health_report() row 13 `sources_newly_dark`
-- stop. Migration 114 flags an active outlet/wire source (outside
-- public.ops_dark_source_baseline) with at least 50 articles in the 14 days
-- before the last 12 hours and none in those 12 hours. A source that goes quiet
-- overnight for 13 or 14 hours and then publishes again trips that every night.
-- This migration widens the silence window from 12 h to 24 h. Nothing else about
-- the row changes: the >= 50 floor and the baseline exclusion stay, and the row
-- stays warn only.
--
-- WHY (evidence: the 114 header, Step 0 c, a 7-day replay at 6 h steps, k = 0..28;
-- columns are flags, distinct slugs, flags resumed within 24 h out of the flags
-- with a full 24 h of follow-up, and flagged at the time of the replay):
--   12 h, >= 50 (migration 114)   173  22  89/146 (61% false)   6
--   24 h, >= 50 (this file)        73   8  13/63  (21% false)   3
-- So at 12 h about 61% of the flags that could be judged were a source that came
-- back within a day, mostly low-volume outlets (50-150 articles in 14 days) with
-- an overnight lull longer than 12 h. At 24 h that falls to 21%, and the flags
-- drop from 173 to 73 over the week. The ones that remain are real: halk-tv and
-- gazete-pencere never resumed in the replay at either window. The row is warn
-- only, so the noise cost a line in the step summary, never a page, but a row
-- that cries wolf every night is a row nobody reads.
-- The stricter option (24 h, >= 200: 2 slugs, 0/47 resumed) is NOT applied here;
-- it stays the next step if noise persists (docs/ops-heartbeat.md).
--
-- WHAT CHANGES (row 13 only; pinned by
-- tests/migrations/115-sources-newly-dark-24h.test.ts)
--   * `interval '14 days 12 hours'` -> `interval '14 days 24 hours'` (the lower
--     bound of the counted range, 1 occurrence);
--   * `interval '12 hours'` -> `interval '24 hours'` (the prior/recent split, 2
--     occurrences);
--   * the detail `son 12 saatte haber gelmedi (...)` -> `son 24 saatte haber
--     gelmedi (...)`. `yeni susan kaynak yok`, threshold 1, the 500-character
--     cut and the exception handler are unchanged.
--   * the marker comment above row 13 and the comment on the function are
--     re-written for 115: `(migrations 077, 100, 103, 108, 114, 115)`, and row
--     13 says 24 hours.
--   Signature, declare section, rows 1-12, revoke/grant and the baseline table
--   are untouched. Rows 1-12 are byte-identical to 114 (comments included); the
--   test compares the raw text, then the comment-free segments, then row 13 as
--   an exact string transform of 114's. The function stays SECURITY DEFINER,
--   search_path = '', volatile, read-only, execute for service_role only. This
--   file creates no table, adds no grant, writes nothing, and does not read or
--   change public.sources for writing. The bias -> zone VALUES list is repeated
--   once more; it is pinned by the same test and listed in
--   tests/migrations/zone-parity.test.ts KNOWN_FILES.
--   Because the window moved, a source now needs 24 h of silence before it
--   shows: halk-tv and gazete-pencere still do (see Step 0); the other
--   sources of 114's evidence (benguturk, medya-gazete, arti-gercek) appear 24 h
--   after their last article instead of 12 h.
--
-- STEP 0 (production, read-only, 2026-10-24 00:08 UTC, via the management API's
-- SELECT / EXPLAIN only; nothing was applied and no threshold changed)
--   a) Version 115 is free: `select version from supabase_migrations.schema_migrations
--      where version >= '114' order by 1` returns '114' and nothing numbered
--      above it (the other rows are 14-digit dashboard versions from 2026-06..09
--      that sort above '114' as text).
--   b) Row 13 predicate standalone at v_now = now() (the baseline table is
--      readable there: 25 rows), slug and prior_n:
--      24 h window, 3 flagged:
--        halk-tv         1,180 prior, last article 10-16 15:12
--        gazete-pencere    919 prior, last 10-15 16:01
--        en-politik         64 prior, last 10-22 12:39 (low volume)
--      12 h window (what 114 reports at the same instant), 8 flagged:
--        haberport       7,822 prior, last 10-23 08:54
--        benguturk       1,732 prior, last 10-23 09:33
--        halk-tv         1,029 prior, last 10-16 15:12
--        gazete-pencere    816 prior, last 10-15 16:01
--        korkusuz          575 prior, last 10-23 03:24
--        tele1             125 prior, last 10-23 11:24
--        en-politik         63 prior, last 10-22 12:39
--        fayn               51 prior, last 10-23 11:30
--      The 24 h window keeps the two sources that really are dark and drops the
--      five that were between 12 and 24 h into a lull (haberport, benguturk,
--      korkusuz, tele1, fayn). They trip at 24 h if they are still silent then.
--   c) EXPLAIN (ANALYZE, BUFFERS) of the 24 h predicate (PG 17.6): Parallel Index
--      Only Scan using idx_articles_created_source on articles (77,597 rows a
--      worker, heap fetches 361), all 11,762 buffers shared hit, planning 2.5 ms,
--      execution 45.5 ms. Well under the 2 s limit, and no slower than 114's
--      12 h predicate (49 ms) although it reads 12 more hours of index.
--
-- DRY RUNS (×2) (local PG15.12, throwaway cluster, 2026-10-24; the stub schema
-- plus articles.created_at; default privileges mimic Supabase's: grant all on
-- tables to anon, authenticated, service_role). 114 applied first, then this file
-- twice in a row, each with psql -v ON_ERROR_STOP=1 -f:
--   114     BEGIN, CREATE TABLE, COMMENT, ALTER TABLE, REVOKE, DO, GRANT,
--           INSERT 0 25, CREATE FUNCTION, COMMENT, REVOKE, GRANT, INSERT 0 1, COMMIT
--   run 1   BEGIN, CREATE FUNCTION, COMMENT, REVOKE, GRANT, INSERT 0 1, COMMIT
--   run 2   the same statements, no error and no notice: INSERT 0 0 (ledger), COMMIT
--   After   2 ledger rows (114, 115); ops_health_report() returns 13 rows; row 13
--           reads pass / observed 0 / threshold 1 / `yeni susan kaynak yok` (the
--           stub has no articles). The function source holds `14 days 24 hours`
--           and no `12 hours`.
--   Grants  function acl {postgres=X/postgres, service_role=X/postgres}: execute is
--           false for anon and authenticated, true for service_role; security
--           definer, volatile, search_path = "". The baseline table keeps 114's
--           grants (25 rows; anon and authenticated hold no privilege on it).
--   Fixtures (the TAYF_PSQL block of the test, inside a rolled-back transaction):
--           fx-dark (60 articles, the newest 25 h old) is the only source reported:
--           warn, observed 1, threshold 1, detail starting `son 24 saatte haber
--           gelmedi (önceki 14 günde en az 50 haber vardı): ` and containing
--           `fx-dark (60)`. fx-lull (the same plus one article 13 h old; 114
--           flags it), fx-busy (plus one 1 h old), fx-small (49), ntv (baseline),
--           fx-off (inactive) and fx-agg (aggregator) are not. With fx-dark
--           removed: pass, `yeni susan kaynak yok`. Against 114's function the
--           same fixtures report observed 2 (fx-dark and fx-lull), so the test
--           fails there, as it should.
--   Rollback rehearsed: 114's file re-applied (the 12 h function is back), ledger
--           row 115 removed, then this file twice more with the same statement
--           tags (INSERT 0 1, then INSERT 0 0).
--
-- ROLLBACK (nothing depends on this; the table and the baseline are 114's and
-- stay):
--   re-apply the `create or replace function public.ops_health_report()` block
--     of 114_sources_newly_dark.sql, with its comment, revoke and grant (that
--     restores the 12 h window); do not drop ops_dark_source_baseline;
--   then remove ledger row 115 (the statement is below, run by the operator):
--   delete from supabase_migrations.schema_migrations where version = '115';
--
-- Additive, read-only function. Safe to re-apply (create or replace function,
-- ledger insert on conflict do nothing). Deploy: apply only, with the normal
-- migration path. No CONCURRENTLY step, no cron change, no edge function change,
-- no app change; the next ops-heartbeat run shows the 24 h wording.

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

  -- 13. sources_newly_dark (migration 114; window 24 h since 115)
  check_name := 'sources_newly_dark'; threshold := 1; observed := null; detail := null;
  begin
    with vs as (select s.id, s.slug from public.sources s
                 where s.active and s.kind in ('outlet', 'wire')
                   and not exists (select 1 from public.ops_dark_source_baseline b where b.slug = s.slug)),
    c as (select a.source_id,
                 pg_catalog.count(*) filter (where a.created_at < v_now - interval '24 hours') as prior_n,
                 pg_catalog.count(*) filter (where a.created_at >= v_now - interval '24 hours') as recent_n
            from public.articles a
           where a.created_at >= v_now - interval '14 days 24 hours' and a.created_at <= v_now
           group by a.source_id)
    select pg_catalog.count(*)::numeric,
           pg_catalog.string_agg(v.slug || ' (' || c.prior_n::text || ')', ', ' order by c.prior_n desc, v.slug)
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

  return;
end
$fn$;

comment on function public.ops_health_report() is
  'Read-only ops heartbeat (migrations 077, 100, 103, 108, 114, 115): 13 fixed rows, in this order --'
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
  ' 24 hours; warn only, never fail: the detail names them).'
  ' status is one of pass|warn|fail|unknown|skip, and threshold is the fail limit'
  ' (or the warn limit for warn-only checks). Never writes any table, and'
  ' never reads any potentially secret-bearing pg_cron job field. Polled by'
  ' .github/workflows/ops-heartbeat.yml over PostgREST every 30 minutes.'
  ' service_role only. See docs/ops-heartbeat.md.';

revoke all on function public.ops_health_report() from public, anon, authenticated;
grant execute on function public.ops_health_report() to service_role;

-- Ledger ---------------------------------------------------------------------------

insert into supabase_migrations.schema_migrations (version, name)
  values ('115', '115_sources_newly_dark_24h')
  on conflict do nothing;

commit;
