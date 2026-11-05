-- 161_image_coverage_by_source.sql
--
-- The database half of h40-edgefns-1 (hunt 40, 2026-11-05): ops_health_report() gets ONE new row, the 21st,
-- `image_coverage`, which warns when a source's share of articles stored without an image jumps against its own
-- recent past. The Edge Function half (supabase/functions/_shared/og-image.ts and supabase/functions/image-consumer)
-- tells a Cloudflare challenge apart from a page that has no image, and counts it. The database changes are the
-- function (and its comment) and the ledger row; no table, no column, no policy, no grant to anon or authenticated,
-- no data change. No reset of the parked rows.
--
-- WHY (evidence: production, read-only, 2026-11-05 14:28 to 14:50 UTC)
--   * medyascope.tv has been blocking the image fetch since 2026-10-29. Its articles stored without an image, per
--     day by created_at (image-less / total): 10-19..10-27 = 0 every day (12 to 47 articles a day); 10-28 1/26;
--     10-29 4/15; 10-30 27/32; 10-31 21/24; 11-01 15/18; 11-02 32/38; 11-03 34/37; 11-04 40/45; 11-05 28/31. Every
--     settled image-less row has image_backfill_attempts >= 3 (3 to 5 per day), so the queue gave up on them.
--   * The cause is the site. A GET of one article page with the consumer's own User-Agent ('Mozilla/5.0 (compatible;
--     Tayf/1.0; +https://tayf.app)', og-image.ts DEFAULT_HEADERS) returns HTTP/2 403, server cloudflare,
--     cf-mitigated: challenge, title 'Just a moment...'; /robots.txt is 403 as well. The RSS feed still answers 200,
--     with no image on its non-video items. Nothing here tries to get around that: the fix classifies the response the
--     existing fetch already returned, and makes the damage visible. Getting access back is the founder's call
--     (docs/migration-guide.md, ## 161).
--   * Nothing noticed. fetchOgImage and fetchHeroImage returned null for every non-2xx, so image-consumer filed a block
--     as 'not-found' and bumped the attempt exactly as for a page with no image; queue_lag (row 18) reads the depth and
--     the age of the queue, which stayed normal; sources_newly_dark (row 13) watches sources that stopped producing
--     articles, and medyascope kept producing 15 to 45 a day. ops_health_report() had no per-source image row at all.
--
-- WHAT CHANGES (pinned by tests/migrations/161-image-coverage-by-source.test.ts, tests/guards/ops-health-checks.test.ts,
-- tests/migrations/144-blindspot-veto-cadence.test.ts and tests/migrations/zone-parity.test.ts)
--   1. ops_health_report() is re-created with 159's text VERBATIM, comments included, from the create line through row
--      20's `return next;` (the test compares the raw text, and the body against the production fingerprint below:
--      the declare block, rows 1-20, their names, order and thresholds, row 4's VALUES copy of BIAS_TO_ZONE and row
--      17's six-RPC allowlist are 159's), then ONE new block, row 21, `image_coverage`:
--        scope     sources.kind in ('outlet', 'wire') with at least 10 articles created between now() - 25 hours and
--                  now() - 1 hour. The newest hour is skipped on purpose: the image backfill has not reached it.
--        measure   share_24h = articles with image_url is null / articles, over that 24 hour window.
--        baseline  the same share over the same source's articles created between now() - 15 days and now() - 25
--                  hours (14 days; "days 2-15"), counted only when that period holds at least 10 articles of the
--                  source. A source without a baseline is never flagged (it has no past to compare with).
--        rule      warn when share_24h >= 0.5 AND share_24h - share_baseline >= 0.4. A change, not a level: a feed that
--                  carries few images by nature has a high baseline and stays quiet. Never a fail (a lost image is not
--                  an outage, the page is served).
--        output    observed = the number of such sources, threshold = 1; 'warn' at 1 or more, else 'pass'; 'unknown'
--                  with the first 200 characters of the error if the read fails.
--        detail    Turkish, slug and the two percentages only, worst first, cut at 500 characters:
--                  `son 24 saatte görselsiz haber oranı sıçrayan kaynak 1: medyascope %86 görselsiz (14 gün: %38)`,
--                  or `görselsiz haber oranında sıçrama yok (61 kaynak)` on pass. No url, title or article count.
--      The function comment is 159's with `161` added to the migration list, `21 fixed rows`, and the image_coverage
--      description appended after feed_poll_stale. Revoke all from public, anon, authenticated; execute for
--      service_role only: 159's two statements, nothing else.
--   2. The ledger row in the 095 pattern. No notify pgrst: no table, column or RPC shape changes.
--
-- STEP 0 (production, read-only, 2026-11-05 14:50 UTC, SELECT only through sbq.py; nothing was applied)
--   select md5(prosrc), length(prosrc), prosecdef, proconfig::text, proacl::text from pg_proc
--    where proname = 'ops_health_report';
--     -> md5 a2246bc0ea663b123144a2fa4c4f5735, length 42501, security definer, search_path "",
--        ACL {postgres=X/postgres,service_role=X/postgres}: 159 is applied, and it is the text this migration copies.
--        tests/migrations/161-image-coverage-by-source.test.ts recomputes the md5 and the length from 159's file.
--   The row's query as a plain SELECT (now() for v_now), on the day of the run:
--     checked 61 sources (outlet/wire with >= 10 articles in the 24 hour window), flagged 1:
--     medyascope %86 görselsiz (14 gün: %38). The next highest 24 hour shares: cnn-turk 36% (112 of 311) and
--     haberler-com 29% (527 of 1838), both under the 50% bar. So today's value is warn / 1 / threshold 1, and a
--     healthy roster reads pass / 0.
--   The 14 day share of medyascope is already 38% because the blocked days (since 10-29) are part of it; the jump is
--   86 - 38 = 48 points, over the 40-point bar. The blocked days keep entering the baseline, so while the block lasts
--   the row clears on its own once the 14 day share passes 50% (around 2026-11-08). It is the alarm; the standing
--   record is the drain summary of image-consumer (blocked, blockedBySource, in net._http_response and the logs).
--
-- EXPLAIN (ANALYZE, BUFFERS) of the row's query on production (read-only, 2026-11-05 14:50 to 15:05 UTC)
--   The final text of the row, three runs: Execution Time 1,034 ms on the first run (a cold cache), then 30.7 and 39.6 ms,
--   Planning Time 2.7 to 5.0 ms. Earlier drafts of the same plan: 265 ms cold, 27.7 to 31.9 ms warm. Under the 2 second bar
--   on every run. The plan, and the same plan with the plpgsql variable replaced by a bound parameter
--   under plan_cache_mode = force_generic_plan (73 ms):
--     CTE r   Index Scan using idx_articles_created_at on articles
--               Index Cond: created_at >= now() - 25 hours AND created_at < now() - 1 hour  (10,928 rows, ~20 ms)
--     CTE b   Index Scan using idx_articles_created_source on articles   (created_at, source_id)
--               Index Cond: created_at range AND source_id = ANY (InitPlan)  (421 rows, ~6 ms, 1,032 buffers)
--   The baseline is read only for the sources over 50%, with the source ids in an array so that the planner can use
--   the (created_at, source_id) index and visit the heap only for those sources' rows. Written as an IN (subquery) it
--   scanned 133,622 rows of 15 days through idx_articles_created_at (69,822 buffers, 145 ms warm and 2.3 s on a cold
--   cache), and a plain 15-day aggregate over every source did not finish inside the 8 second limit of the read-only
--   session. A healthy day has no source over 50%, so the baseline scan reads nothing.
--
-- DRY RUN (local PG15, throwaway cluster, 2026-11-05; never production)
--   The shared stub schema (tests/migrations/sql/stub.sql), then the manifest chain of
--   tests/migrations/sql/live-manifest.txt for 161-image-coverage-by-source.test.ts: 150's dry-run script (114, 115,
--   119, 122, 136, 145 and 150 in production order, on stand-ins for pg_cron, pg_net and pgmq), 041 (the
--   sources.fetch_* columns), 157 (the ingest_cycles counters) and this file applied twice
--   (bash tests/migrations/sql/run-live.sh with TAYF_LIVE_ONLY=161). 159 is not in the chain: this file carries its text.
--   Apply         BEGIN, CREATE FUNCTION, COMMENT, REVOKE, GRANT, INSERT 0 1 (ledger), COMMIT. Second apply: the same
--                 statements, no error, the ledger INSERT 0 0 (one 161 row).
--   After         ops_health_report() returns 21 rows; rows 1-20 have 159's names and order; row 21 is image_coverage.
--                 md5(prosrc) c1c2ff6c61daede5a5e8c8695547b445, 47,349 characters (the md5 of the text between the
--                 dollar-quote markers of this file, recomputed by the test); security definer, volatile,
--                 search_path = "", ACL service_role only. On the stub, whose articles table has no image_url, row 21
--                 answers unknown with the error text (the read failing is a row, not an exception).
--   Fixtures (rolled-back transactions; each case adds image_url to the stub's articles inside its own transaction;
--                 status / observed): no source pass / 0 `görselsiz haber oranında sıçrama yok (0 kaynak)`; the
--                 medyascope shape (90% of 40 now, 2% of 100 before) warn / 1 `son 24 saatte görselsiz haber oranı
--                 sıçrayan kaynak 1: medyascope %90 görselsiz (14 gün: %2)` next to a healthy outlet; an always
--                 image-less source (90% against 90%) pass; share boundary 50% warn, just under 50% pass; jump boundary
--                 40 points warn, 39 pass; 10 articles in the window warn, 9 pass; a source with no baseline, or a
--                 baseline of 9 articles, pass; 40 image-less articles 30 minutes old are not looked at (pass); 40
--                 image-less articles 26 hours old belong to the baseline (pass); a 90% baseline 16 days back changes
--                 nothing (warn stays); aggregator and niche sources pass, a wire source warns; two flagged sources
--                 warn / 2, worst first; 40 flagged sources warn / 40 with the detail at most 500 characters; the
--                 detail holds no URL and no article count.
--   Test counts   tests/migrations/161-image-coverage-by-source.test.ts 61 (static 47, live 14).
--
-- DEPLOY: APPLY 161, THEN DEPLOY image-consumer
--   1. Apply 161 first (docs/migration-guide.md, operator: `supabase db push`). The ops heartbeat's next run and the
--      10 minute snapshot of 131 read row 21; nothing else depends on it.
--   2. Then deploy the function: supabase functions deploy image-consumer --no-verify-jwt (the blocked outcome and the
--      blocked / blockedBySource summary ship in the same build as og-image.ts's classifier).
--   The reverse order is safe: the new image-consumer needs nothing from the database that 161 adds, and the report
--   works with or without the row.
--
-- VERIFY (read-only):
--   select count(*) from public.ops_health_report();    -- expect 21
--   select check_name, status, observed, threshold, detail from public.ops_health_report()
--    where check_name = 'image_coverage';
--      -- expect warn / 1 / 1 and `... medyascope %NN görselsiz (14 gün: %MM)` today; pass / 0 once the block is lifted
--   select md5(prosrc), length(prosrc) from pg_proc where oid = 'public.ops_health_report()'::regprocedure;
--      -- expect the md5 and length of this file's function body, the text between its dollar-quote markers (the test recomputes both)
--   select has_function_privilege('anon', 'public.ops_health_report()', 'execute'),
--          has_function_privilege('authenticated', 'public.ops_health_report()', 'execute'),
--          has_function_privilege('service_role', 'public.ops_health_report()', 'execute');
--      -- expect f, f, t
--   select version, name from supabase_migrations.schema_migrations where version = '161';   -- 1 row
--   After the image-consumer deploy, the next image-drain bodies show the block, by slug and without a URL:
--   select content::jsonb ->> 'blocked' as blocked, content::jsonb -> 'blockedBySource' as by_source
--     from net._http_response where created > now() - interval '30 minutes' order by created desc limit 10;
--      -- the image-consumer bodies (they carry "drained") show blocked > 0 and {"medyascope": n} while the site blocks us
--
-- ROLLBACK (nothing else depends on 161; run by the operator, in one transaction)
--   re-run ONLY 159's ops_health_report() section: the text of
--     159_ingest_stale_admission.sql from `create or replace function public.ops_health_report()` through
--     `grant execute on function public.ops_health_report() to service_role;` (it re-creates the function with its
--     comment, revoke and grant, which returns the report to 20 rows,
--     md5(prosrc) a2246bc0ea663b123144a2fa4c4f5735, length 42501);
--   then:
--     delete from supabase_migrations.schema_migrations where version = '161';   -- ledger row 161
--   The heartbeat, /durum and /api/health do not depend on the row count or the names. A snapshot row for
--   image_coverage written by 131 stays in public.ops_health_snapshots until its own retention removes it. To roll the
--   image-consumer change back, redeploy the previous function; the migration can stay.
--
-- Additive. Safe to re-apply (create or replace function, the ledger insert on conflict do nothing; the revoke and the
-- grant are idempotent). One transaction. No change to a column, table, index, trigger or pg_cron job, no data
-- rewrite, no reset of the parked rows (image_backfill_attempts is not touched). No CONCURRENTLY step, no grant to anon
-- or authenticated.

begin;

-- ---------------------------------------------------------------------------
-- 1. ops_health_report(): 159's text verbatim from the create line through row 20's `return next;` (comments
--    included, row 4's VALUES copy of BIAS_TO_ZONE and row 17's six-RPC allowlist too), then ONE new block, row 21
--    (image_coverage). Same returns table, plpgsql, volatile, security definer, search_path = ''. The function comment
--    is 159's with 161 added to the migration list, 21 fixed rows and the image_coverage description. Revoke and
--    grant as in 159.
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

  -- 15. cron_route_failures_30m (migration 136). The Vercel cron routes (headline, digest, fact-checks, social, alerts-webhooks) record every authenticated run in public.ops_cron_route_runs through ops_cron_route_run_record (withCronOutcome, written by after()). A route that answers 5xx leaves no trace in rows 1-14 (2026-10-31: 189 headline statement timeouts over 18 hours, no alert). Fail when one route has at least 2 failures (status >= 500) that are at least half of its runs in the last 30 minutes, so a single blip in a daily route stays a warn; warn on any failure; warn when the window holds no run at all (the app side is not recording). A run that Vercel kills at maxDuration (60 s) never reaches the wrapper's finally or after(), so it writes no row and no failure can be counted: the two frequent routes in the VALUES list below (headline every 5 minutes, alerts-webhooks every 10) are also checked for silence. A route that has recorded within the 7 day retention but whose newest row is older than warn_min (15 / 25 minutes: three and 2.5 ticks) is a warn, older than fail_min (30 / 60: six ticks) a fail, named in the detail as `kayıt gelmiyor: headline 31 dk`, even while other routes keep writing rows. Hourly, daytime-only and weekly routes (fact-checks, social, digest) have too few ticks for a gap rule and stay out; a route that has never recorded cannot be compared with anything and is not flagged (the VERIFY query shows it).
  check_name := 'cron_route_failures_30m'; threshold := 1; observed := null; detail := null;
  begin
    v_n := null; v_total := null; v_zero := null; v_text := null;
    v_jobs := null; v_active := null; v_zone := null;
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
               ('alerts-webhooks'::text, 25::numeric, 60::numeric)
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
      v_total := coalesce(v_total, 0); v_n := coalesce(v_n, 0); v_zero := coalesce(v_zero, 0);
      v_jobs := coalesce(v_jobs, 0); v_active := coalesce(v_active, false);
      if v_total = 0 and v_jobs = 0 then
        status := 'warn'; observed := null; detail := 'son 30 dakikada cron rotası kaydı yok';
      else
        observed := v_n + v_jobs;
        status := case when v_zero >= 1 or v_active then 'fail'
                       when v_n >= 1 or v_jobs >= 1 or v_total = 0 then 'warn'
                       else 'pass' end;
        detail := substr(pg_catalog.concat_ws(' · ',
          case when v_n >= 1 then 'son 30 dakikada başarısız: ' || v_text
               when v_total = 0 then 'son 30 dakikada cron rotası kaydı yok'
               else 'son 30 dakikada ' || v_total::text || ' çalışma, başarısız yok' end,
          case when v_jobs >= 1 then 'kayıt gelmiyor: ' || v_zone end), 1, 500);
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

  -- 17. anon_surface (migration 145). Supabase Auth signup is open (auth.users is empty and no code uses Supabase Auth), 13 dormant USING (true) SELECT policies exist on public, and the supabase_admin default ACL (which postgres cannot alter) hands anon and authenticated privileges on every object that role creates; tests/guards/anon-surface.test.ts reads migration text only, so a dashboard change or a supabase_admin privilege never reaches it. This row reads what anon and authenticated can actually do. Fail when either role holds any privilege on a relation or sequence of public (an ACL entry counts too, which catches PG17 MAINTAIN) or can execute a SECURITY DEFINER function there outside the six allowlisted RPCs, each exempt by its full signature (name and argument types), so an overload of an allowlisted name is counted (trigger functions and extension members excluded); warn when it can execute an invoker function there or auth.users holds a row (signup abuse); skip without the roles. The detail carries counts only, never object names or user data: ops-heartbeat.mjs prints every detail to the stdout and the step summary of the GitHub Actions run, and that repository is public, so a name here would tell anyone which endpoint to call with the public anon key; the names come from the service-role query in docs/ops-heartbeat.md (Anon yüzeyi).
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
             and p.proname::text || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' <> all (array['saved_clusters(uuid[])', 'merged_cluster_map()', 'source_slugs()', 'source_slug_exists(text)', 'saved_clusters_v2(uuid[])', 'saved_clusters_v3(uuid[])'])
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
        || ' (6 izinli RPC hariç)'
        || case when observed > 0 then ' · adlar için: docs/ops-heartbeat.md (Anon yüzeyi)' else '' end
        || ' · auth.users ' || coalesce(v_zero::text, 'okunamadı'),
        1, 500);
    end if;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 18. queue_lag (migration 150). Nothing watched clustering: ops_health_report() had no row on the pgmq queues (cluster_work feeds every home and cluster page, image_backfill the article images), so a dead consumer, an undeployed or renamed Edge Function (404) or a poison message read green while ingest kept rows 3-6 green. This row reads, for both queues, the depth (count(*)) and the age in seconds of the oldest VISIBLE message (vt <= now(); an in-flight message is not waiting), plus the archived messages of the last 24 hours with read_ct >= 3 (poison: the consumer gave up on them; the archived_at indexes make it a range scan). Baselines, measured on 2026-11-02 over 48 h: cluster_work wait p95 60 s, max 86.5 s; image_backfill p95 721 s, max 803 s (the hourly image-backfill-requeue and the 5 minute image-drain make it slow by design). Fail when cluster_work's oldest message is older than 900 s or image_backfill's older than 3600 s; warn when cluster_work's oldest is older than 300 s or its depth is above 300, image_backfill's oldest is older than 1800 s, or any poison message exists; observed is cluster_work's oldest age in seconds, threshold 900; unknown without the pgmq tables. The detail is counts only (depths, ages in seconds, the poison count), never a message body or id: ops-heartbeat.mjs prints every detail to the stdout and the step summary of a public GitHub Actions log.
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
               ((select pg_catalog.count(*) from pgmq.a_cluster_work a where a.archived_at >= pg_catalog.now() - interval '24 hours' and a.read_ct >= 3)
                + (select pg_catalog.count(*) from pgmq.a_image_backfill a where a.archived_at >= pg_catalog.now() - interval '24 hours' and a.read_ct >= 3))::numeric
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

  return;
end
$fn$;

comment on function public.ops_health_report() is
  'Read-only ops heartbeat (migrations 077, 100, 103, 108, 114, 115, 119, 122, 136, 145, 150, 157, 158, 159, 161): 21 fixed rows, in this order --'
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
  ' no row, so headline (every 5 min) and alerts-webhooks (every 10 min) are also checked for silence:'
  ' a route with a row in the last 7 days whose newest row is older than 15 / 25 min is a warn and'
  ' older than 30 / 60 min a fail, named in the detail as kayıt gelmiyor: route n dk),'
  ' db_size_mb (pg_database_size in MB against public.ops_db_size_limits(): warn at the first limit,'
  ' fail at the second, threshold is the warn limit; the detail names the three biggest public relations),'
  ' anon_surface (what anon and authenticated can actually do in public, read from the catalogue: any'
  ' privilege on a table, view, materialized view, foreign table or sequence, an ACL entry for either role'
  ' included (this catches PG17 MAINTAIN), or EXECUTE on a SECURITY DEFINER function other than the six'
  ' allowlisted RPCs saved_clusters, merged_cluster_map, source_slugs, source_slug_exists,'
  ' saved_clusters_v2 and saved_clusters_v3, each exempt by its full signature, name and argument types (trigger functions and'
  ' extension members excluded) is a fail; EXECUTE on an invoker function there, or a row in auth.users'
  ' (signup abuse), is a warn; skip when the roles do not exist; the detail carries counts only, never'
  ' object names or user data, because the heartbeat output is public: the names are in the service-role'
  ' query of docs/ops-heartbeat.md, Anon yüzeyi),'
  ' queue_lag (the pgmq queues cluster_work and image_backfill: the depth, and the age in seconds of the oldest'
  ' visible message, vt <= now(); plus the messages archived in the last 24 hours with read_ct >= 3, poison;'
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
  ' the detail lists slug, the 24 hour percentage and the 14 day percentage only, worst first).'
  ' status is one of pass|warn|fail|unknown|skip, and threshold is the fail limit'
  ' (or the warn limit for warn-only checks). Never writes any table, and'
  ' never reads any potentially secret-bearing pg_cron job field. Polled by'
  ' .github/workflows/ops-heartbeat.yml over PostgREST every 30 minutes.'
  ' service_role only. See docs/ops-heartbeat.md.';

revoke all on function public.ops_health_report() from public, anon, authenticated;
grant execute on function public.ops_health_report() to service_role;

-- Ledger -------------------------------------------------------------------

insert into supabase_migrations.schema_migrations (version, name)
  values ('161', '161_image_coverage_by_source')
  on conflict do nothing;

commit;
