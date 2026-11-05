-- 157_ingest_poll_stale.sql
--
-- Observability for the ingest budgets, the second half of h36-pipeline-1 (hunt 36, 2026-11-05; the first
-- half is the ingest change itself). Two things: public.ingest_cycles gets three nullable integer
-- columns, isolate_budget_deferred, parse_deferred and parse_deferred_max_streak, which ingest writes
-- with the cycle row, and ops_health_report() gets a twentieth row, `feed_poll_stale`: active sources
-- (no quarantine marker) whose last poll, sources.fetch_last_at, is more than 30 minutes old. Rows 1-19
-- are 150's, byte for byte. The database changes are one alter table (three columns), the function (and
-- its comment); no table is created, no policy, no grant to anon or authenticated, no data change.
--
-- WHY (evidence: production, read-only, 2026-11-05)
--   * bha, an opposition wire, was last polled at 05:45:07Z, 2 h 39 min before the 08:24Z reading
--     (status 200, fetch_items_count 1000, fail_streak 0), while birgun, cumhuriyet and haberler-com were
--     under a minute old. Its newest stored article was created 2026-11-04 15:21Z, 17 hours earlier;
--     created_at - published_at over 3 days: p50 79 min, p90 363 min (n = 223) against haberler-com
--     10 / 35, evrensel 16 / 30, birgun 37 / 70.
--   * Cause: the ingest isolate item budget. supabase/functions/ingest/order.ts estimated a changed feed
--     as floor(bytes / 1500) items, which is 2,833 for BHA's 4.25 MB body (1000 real items, 4.2 kB each),
--     and createItemBudget().fits() admits a feed only on an isolate that holds at most 2,167 of the 5,000
--     items. A refused feed writes no fetch state, so its fetch_last_at freezes, and the module-scope
--     memory of deferred feeds is lost when the isolate recycles. The ingest change books such a feed
--     from its last known item count and puts every source whose fetch_last_at is stale first.
--   * Nothing watched it. Row 3 counts cycles, rows 4-6 are satisfied by any other outlet in the zone,
--     row 13 waits 24 hours and row 10 72 hours. A healthy feed is attempted every 3-minute cycle and a
--     200, a 304 or a failure all write fetch_last_at, so a fetch_last_at older than 30 minutes means the
--     feed was skipped or deferred, not that it was quiet.
--   * ingest_cycles counted none of it: the deferral counters lived only in the cycle log line and the
--     HTTP response (stats.isolateBudgetDeferred, stats.parseDeferred, stats.parseDeferredMaxStreak).
--
-- WHAT CHANGES (pinned by tests/migrations/157-ingest-poll-stale.test.ts,
-- tests/guards/ops-health-checks.test.ts, tests/guards/anon-surface.test.ts and
-- tests/migrations/zone-parity.test.ts)
--   1. alter table public.ingest_cycles add column if not exists isolate_budget_deferred integer,
--      parse_deferred integer, parse_deferred_max_streak integer. Nullable, no default: rows written
--      before 157, or by an ingest build without it, read NULL. A column added without a default is a
--      catalogue change only (PostgreSQL 11 and later), no table rewrite. A comment on each column.
--      isolate_budget_deferred: changed feeds this cycle refused because they did not fit the isolate
--      item budget (each also counts in parse_deferred); parse_deferred: changed feeds deferred by either
--      budget; parse_deferred_max_streak: the longest run of consecutive cycles any one feed has been
--      deferred (0 when none; best effort across warm invocations).
--   2. ops_health_report() is re-created with 150's text VERBATIM, comments included, from the create line
--      through row 19's last `return next;` (the test compares the raw text, so the declare block, rows
--      1-19, their names, order and thresholds are 150's, row 4's VALUES copy of BIAS_TO_ZONE included:
--      tests/migrations/zone-parity.test.ts lists this file), then
--        row 20 feed_poll_stale, threshold 3. The sources with active and fetch_quarantined_until is null,
--          split three ways: fetch_last_at older than 30 minutes (stale), fetch_last_at is null (never
--          polled), the rest (polled). observed = the stale count. fail when stale >= 3; warn when stale
--          >= 1; else pass. detail (Turkish, slugs and minutes only, cut at 500 characters): `30
--          dakikadır yoklanmayan aktif kaynak N: slug M dk, ...` (oldest first), or `aktif kaynakların
--          hepsi son 30 dakikada yoklandı (N)` on pass, each followed by ` · hiç yoklanmayan: K` when K
--          sources were never polled. unknown with the error text if the read fails.
--      Quarantined sources are left out on purpose. 27 of the 118 active sources are quarantined today
--      (fail streaks 32 to 59, all in the 24-hour backoff): the ingest does not fetch them, so their
--      fetch_last_at is legitimately old, and dead_feeds / sources_newly_dark already cover them. The test
--      is `fetch_quarantined_until is null`, not `is null or <= now()`: a marker whose time has passed
--      means the source is waiting for its probe (it is fetched in the next cycle, which clears the marker
--      or sets a new one), and with 27 sources probing every 24 hours that window would put a single
--      source into the count for a minute or two about three times an hour. A source never polled
--      (fetch_last_at is null) is not stale (null < x is not true): it cannot be told from a source
--      added a minute ago, and ingest puts it first in the next cycle. It is only named in the detail.
--      The function comment is 150's with `(migrations ..., 150, 157): 20 fixed rows`, the end of
--      cron_jobs_stalled's description turned from a full stop into a comma, and the new description
--      before ` status is one of`. Revoke all from public, anon, authenticated; execute for service_role
--      only: 150's two statements, nothing else.
--   3. notify pgrst 'reload schema' (PostgREST must learn the three columns, or an insert naming them
--      answers PGRST204) and the ledger row in the 095 pattern.
--
-- STEP 0 (production, read-only, 2026-11-05 ~08:36 UTC, SELECT only through sbq.py; nothing was applied)
--   Row 20's predicate as a plain SELECT on public.sources:
--     active 118; quarantined now 27 (fail streaks 32 x1, 33 x1, 34 x2, 35 x1, 36 x2, 42 x1, 57 x1, 59 x18);
--     active with fetch_quarantined_until is null 91; of those fetch_last_at is null 0; markers whose
--     time has passed 0; fetch_last_at older than 30 minutes: 1, bha, last polled 171 minutes ago
--     (fetch_last_status 200, fail streak 0, fetch_items_count 1000). The next oldest of the 90 other
--     feeds was 3.9 minutes old, so a 30-minute limit is about eight cycles of slack and a healthy
--     roster reads 0.
--   Without the quarantine test the count is also 1 today (every quarantined source is inside its
--   backoff), so the test removes the probe-window noise, not a current false positive.
--   Cost: one pass over public.sources (118 rows), well under a millisecond of work; no index needed.
--
-- DRY RUNS (local PG15.12, throwaway cluster under scratchpad, 2026-11-05; the shared stub schema
-- (tests/migrations/sql/stub.sql), then the manifest chain of tests/migrations/sql/live-manifest.txt for
-- 157-ingest-poll-stale.test.ts: 150's dry-run script (114, 115, 119, 122, 136, 145 and 150 in
-- production order, stand-ins for pg_cron, pg_net and pgmq), 041 (the sources.fetch_* columns) and this
-- file applied twice; bash tests/migrations/sql/run-live.sh with TAYF_LIVE_ONLY=157)
--   First apply   BEGIN, ALTER TABLE, COMMENT x3, CREATE FUNCTION, COMMENT, REVOKE, GRANT, NOTIFY,
--                 INSERT 0 1 (ledger), COMMIT. Second apply: the same statements, no error, the ledger
--                 INSERT 0 0 (one 157 row).
--   After         ops_health_report() returns 20 rows; rows 1-19 have 150's names and order; row 20 is
--                 feed_poll_stale. md5(prosrc) d4e50357ea4ae0b85601d5e2047c2c7c, 41,827 characters; security definer, volatile,
--                 search_path = "", ACL service_role only. The three columns are integer, nullable,
--                 without a default.
--   Fixtures (rolled-back transactions; status / observed): no source pass / 0; two sources polled 1 and
--                 29 minutes ago pass / 0; bha 171 minutes warn / 1 `30 dakikadır yoklanmayan aktif
--                 kaynak 1: bha 171 dk`; 29 minutes pass, 31 minutes warn; two stale warn / 2, three
--                 fail / 3, listed oldest first; a quarantined source and one with an expired marker
--                 pass / 0; an inactive source pass; a source never polled pass / 0 with `hiç
--                 yoklanmayan: 1`; a fetch_last_at in the future pass; 120 stale sources fail / 120 with
--                 the detail at most 500 characters.
--   Test counts   tests/migrations/157-ingest-poll-stale.test.ts 52 (static 39, live 13).
--
-- PROD READOUT (production, read-only; row 20 as a plain SELECT; the migration was NOT applied there)
--   feed_poll_stale     warn / observed 1 / threshold 3 / `30 dakikadır yoklanmayan aktif kaynak 1: bha 171 dk`
--   The expected status on production once applied: warn, observed 1, until the ingest deploy below
--   reaches a fresh isolate; after it the row should read pass / 0 (BHA polled every cycle).
--
-- DEPLOY: APPLY 157, THEN DEPLOY ingest
--   1. apply 157 first (docs/migration-guide.md, operator): the next heartbeat run, and the 10 minute
--      snapshot (131), shows row 20, and PostgREST knows the three columns from the first cycle.
--   2. Deploy the ingest function: supabase functions deploy ingest --no-verify-jwt (the same change
--      carries the estimate cap and the stale-first order of h36-pipeline-1).
--   Either order is safe. An insert that names a column the table does not have fails the WHOLE row, so
--   ingest's recordIngestCycle retries the insert once without the three columns when the answer is
--   Postgres 42703 (undefined column) or PostgREST PGRST204 (column not in the schema cache): the same
--   pattern as the legacy sources select for migration 119. Deployed before 157, ingest logs `ingest_cycles
--   deferral columns missing (migration 157 not applied?)` once per cycle and writes the row it wrote
--   before; the counters are absent until 157 is applied, and no cycle row is lost. Any other error is
--   logged and not retried.
--
-- VERIFY (read-only):
--   select count(*) from public.ops_health_report();    -- expect 20
--   select check_name, status, observed, threshold, detail from public.ops_health_report()
--    where check_name = 'feed_poll_stale';
--      -- expect pass / 0 / 3 after the ingest deploy (warn / 1 / 3 `bha 171 dk` before it)
--   select column_name, data_type, is_nullable from information_schema.columns
--    where table_schema = 'public' and table_name = 'ingest_cycles'
--      and column_name in ('isolate_budget_deferred', 'parse_deferred', 'parse_deferred_max_streak');
--      -- expect 3 rows, integer, YES
--   select md5(prosrc), length(prosrc) from pg_proc where oid = 'public.ops_health_report()'::regprocedure;
--      -- expect d4e50357ea4ae0b85601d5e2047c2c7c, 41,827
--   select has_function_privilege('anon', 'public.ops_health_report()', 'execute'),
--          has_function_privilege('authenticated', 'public.ops_health_report()', 'execute'),
--          has_function_privilege('service_role', 'public.ops_health_report()', 'execute');
--      -- expect f, f, t
--   select version, name from supabase_migrations.schema_migrations where version = '157';
--   After the ingest deploy, the cycle rows carry the counters:
--   select started_at, isolate_budget_deferred, parse_deferred, parse_deferred_max_streak
--     from public.ingest_cycles order by started_at desc limit 5;
--
-- ROLLBACK (nothing else depends on 157; run by the operator, in one transaction)
--   re-run ONLY 150's ops_health_report() section: the text of
--     150_ops_queue_and_cron_liveness.sql from `create or replace function public.ops_health_report()`
--     through `grant execute on function public.ops_health_report() to service_role;` (it re-creates the
--     function with its comment, revoke and grant, which returns the report to 19 rows,
--     md5(prosrc) 2445cd7d15a23d4af88d42ddf79ac2ff);
--   then:
--     alter table public.ingest_cycles drop column if exists isolate_budget_deferred,
--       drop column if exists parse_deferred, drop column if exists parse_deferred_max_streak;
--     notify pgrst, 'reload schema';
--     delete from supabase_migrations.schema_migrations where version = '157';   -- ledger row 157
--   The heartbeat, /durum and /api/health do not depend on the row count or the names. A snapshot row
--   for feed_poll_stale written by 131 stays in public.ops_health_snapshots until its own retention
--   removes it. Dropping the columns while the new ingest build is deployed is safe: it retries the cycle
--   row without them (see DEPLOY).
--
-- Additive. Safe to re-apply (add column if not exists, create or replace function, the ledger insert on
-- conflict do nothing; the revoke and the grant are idempotent). One transaction. No change to an existing
-- column, no table, no index, no trigger, no pg_cron job (no schedule, unschedule or alter of any job), no
-- data rewrite. No CONCURRENTLY step, no grant to anon or authenticated.

begin;

-- ---------------------------------------------------------------------------
-- 1. public.ingest_cycles: the deferral counters ingest writes with each cycle row.
-- ---------------------------------------------------------------------------

alter table public.ingest_cycles
  add column if not exists isolate_budget_deferred integer,
  add column if not exists parse_deferred integer,
  add column if not exists parse_deferred_max_streak integer;

comment on column public.ingest_cycles.isolate_budget_deferred is
  'Changed feeds this cycle refused a parse because they did not fit what was left of the ingest isolate item '
  'budget (INGEST_ISOLATE_ITEM_BUDGET, hunt-11); each also counts in parse_deferred. Written by ingest '
  '(migration 157, h36-pipeline-1). NULL on rows written before 157 or by an ingest build without it.';

comment on column public.ingest_cycles.parse_deferred is
  'Changed feeds this cycle deferred to the next cycle by either parse budget (the per-cycle MAX_PARSES_PER_CYCLE / '
  'PARSE_BUDGET_BYTES or the isolate item budget); they are retried first, not dropped. Written by ingest '
  '(migration 157). NULL on rows written before 157 or by an ingest build without it.';

comment on column public.ingest_cycles.parse_deferred_max_streak is
  'The longest run of consecutive cycles any one feed has been deferred, counting this cycle (0 when nothing was '
  'deferred): starvation made visible. Best effort across warm invocations, because the deferral memory lives in '
  'the isolate. Written by ingest (migration 157). NULL on rows written before 157 or by an ingest build without it.';

-- ---------------------------------------------------------------------------
-- 2. ops_health_report(): 150's text verbatim from the create line through row 19's
--    `return next;` (comments included, row 4's VALUES copy of BIAS_TO_ZONE too), plus
--    row 20 (feed_poll_stale). Same returns table, plpgsql, volatile, security definer,
--    search_path = ''. Comment, revoke and grant as in 150, the comment listing 20 rows.
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

  -- 17. anon_surface (migration 145). Supabase Auth signup is open (auth.users is empty and no code uses Supabase Auth), 13 dormant USING (true) SELECT policies exist on public, and the supabase_admin default ACL (which postgres cannot alter) hands anon and authenticated privileges on every object that role creates; tests/guards/anon-surface.test.ts reads migration text only, so a dashboard change or a supabase_admin privilege never reaches it. This row reads what anon and authenticated can actually do. Fail when either role holds any privilege on a relation or sequence of public (an ACL entry counts too, which catches PG17 MAINTAIN) or can execute a SECURITY DEFINER function there outside the five allowlisted RPCs, each exempt by its full signature (name and argument types), so an overload of an allowlisted name is counted (trigger functions and extension members excluded); warn when it can execute an invoker function there or auth.users holds a row (signup abuse); skip without the roles. The detail carries counts only, never object names or user data: ops-heartbeat.mjs prints every detail to the stdout and the step summary of the GitHub Actions run, and that repository is public, so a name here would tell anyone which endpoint to call with the public anon key; the names come from the service-role query in docs/ops-heartbeat.md (Anon yüzeyi).
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
             and p.proname::text || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' <> all (array['saved_clusters(uuid[])', 'merged_cluster_map()', 'source_slugs()', 'source_slug_exists(text)', 'saved_clusters_v2(uuid[])'])
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
        || ' (5 izinli RPC hariç)'
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

  -- 20. feed_poll_stale (migration 157). No row noticed a feed that stopped being polled while the others carried on: on 2026-11-05 BHA, an opposition wire, had not been polled for 2 h 39 min (its newest stored article was 17 h old, its created-minus-published lag p50 79 min, p90 363 min) because the ingest isolate item budget kept refusing its 4.25 MB body, and a refused feed writes no fetch state, so nothing moved; rows 3-6 stay green on any other outlet, and rows 10 and 13 wait 72 and 24 hours. A healthy feed is attempted every 3-minute cycle and a 200, a 304 or a failure all write sources.fetch_last_at, so a fetch_last_at older than 30 minutes means the feed was skipped or deferred, not that it was quiet. This row counts the active sources with no quarantine marker (fetch_quarantined_until is null: a marker, even one whose time has passed, means the source is dead or waiting for its probe, which the quarantine and rows 10 and 13 already cover) whose fetch_last_at is older than 30 minutes. A source never polled (fetch_last_at is null) is not counted, it is only named in the detail. Warn at 1, fail at 3; observed is the count, threshold 3; unknown if the read fails. The detail names the slugs with the minutes since the last poll, oldest first, cut at 500 characters (sources.slug is public, the site lists every source; no url, validator or header is read). On 2026-11-05 08:36 UTC: 1 (bha, 171 min); the next oldest of the other 90 feeds was 3.9 min.
  check_name := 'feed_poll_stale'; threshold := 3; observed := null; detail := null;
  declare
    f_total numeric;
    f_stale numeric;
    f_never numeric;
    f_list  text;
  begin
    select pg_catalog.count(*) filter (where x.fetch_last_at is not null)::numeric,
           pg_catalog.count(*) filter (where x.fetch_last_at < pg_catalog.now() - interval '30 minutes')::numeric,
           pg_catalog.count(*) filter (where x.fetch_last_at is null)::numeric,
           pg_catalog.string_agg(coalesce(x.slug, '?') || ' ' || pg_catalog.floor(extract(epoch from pg_catalog.now() - x.fetch_last_at) / 60)::text || ' dk', ', ' order by x.fetch_last_at, x.slug)
             filter (where x.fetch_last_at < pg_catalog.now() - interval '30 minutes')
      into f_total, f_stale, f_never, f_list
      from public.sources x
     where x.active and x.fetch_quarantined_until is null;
    observed := f_stale;
    status := case when f_stale >= 3 then 'fail' when f_stale >= 1 then 'warn' else 'pass' end;
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

  return;
end
$fn$;

comment on function public.ops_health_report() is
  'Read-only ops heartbeat (migrations 077, 100, 103, 108, 114, 115, 119, 122, 136, 145, 150, 157): 20 fixed rows, in this order --'
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
  ' included (this catches PG17 MAINTAIN), or EXECUTE on a SECURITY DEFINER function other than the five'
  ' allowlisted RPCs saved_clusters, merged_cluster_map, source_slugs, source_slug_exists and'
  ' saved_clusters_v2, each exempt by its full signature, name and argument types (trigger functions and'
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
  ' budget; a source never polled is not counted, only named; warn at 1, fail at 3; observed is the count, threshold 3;'
  ' unknown if the read fails; the detail lists the slugs with the minutes since the last poll, oldest first, and'
  ' nothing else).'
  ' status is one of pass|warn|fail|unknown|skip, and threshold is the fail limit'
  ' (or the warn limit for warn-only checks). Never writes any table, and'
  ' never reads any potentially secret-bearing pg_cron job field. Polled by'
  ' .github/workflows/ops-heartbeat.yml over PostgREST every 30 minutes.'
  ' service_role only. See docs/ops-heartbeat.md.';

revoke all on function public.ops_health_report() from public, anon, authenticated;
grant execute on function public.ops_health_report() to service_role;

-- Schema cache and ledger ---------------------------------------------------

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('157', '157_ingest_poll_stale')
  on conflict do nothing;

commit;
