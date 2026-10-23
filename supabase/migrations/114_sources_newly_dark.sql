-- 114_sources_newly_dark.sql
--
-- The ops heartbeat now names active outlet/wire sources that were producing
-- plenty of articles and suddenly went silent. One new row, ops_health_report()
-- row 13 `sources_newly_dark` (warn only), plus a small baseline table of the
-- sources already known to be dark so the row starts quiet.
--
-- EVIDENCE (production, read-only, 2026-10-23). Five active outlet/wire sources
-- went dark between 10-15 and 10-23 and nothing in the heartbeat said so:
--   halk-tv         status 0,   streak 22, last article 10-16        4,108 in 30 d
--   gazete-pencere  status 404, streak 29, last article 10-15        2,759 in 30 d
--   benguturk       status 403, streak 22, last article 10-23 09:33  3,686 in 30 d
--   medya-gazete    status 0,   streak 22, last article 10-23 12:12  3,741 in 30 d
--   arti-gercek     status 403, streak 21, last article 10-23 14:33  1,221 in 30 d
-- Three of them (halk-tv, medya-gazete, arti-gercek) are opposition_leaning, so
-- the muhalefet zone loses about 9k articles a month (4,108 + 3,741 + 1,221).
-- Nothing caught it: dead_feeds counts a source only after 72 h of silence and
-- warns only above 38 silent sources, and the ingest_fresh_* rows look at the
-- newest article of a whole zone, which any other outlet in the zone supplies.
--
-- ROW 13 (pinned by tests/migrations/114-sources-newly-dark.test.ts)
--   * Population: sources.active and kind in ('outlet', 'wire') (the voting
--     kinds, as in checks 4-6 and 10) whose slug is NOT in
--     public.ops_dark_source_baseline.
--   * Per source, on articles.created_at (ingest time, as checks 4-6; never
--     published_at, which a feed can back- or forward-date): prior_n = rows in
--     [v_now - 14 days 12 hours, v_now - 12 hours), recent_n = rows in
--     [v_now - 12 hours, v_now]. Flagged when prior_n >= 50 and recent_n = 0.
--   * warn when at least one source is flagged, else pass. Never fail (a quiet
--     source is a prompt to look, not an outage), never skip; a query error
--     (a missing baseline table included) is `unknown`, as in every other row.
--     scripts/lib/ops-heartbeat.mjs exits non-zero only on `fail`, so this row
--     does not page. It shows in the Action's step summary.
--   * Detail: `son 12 saatte haber gelmedi (önceki 14 günde en az 50 haber
--     vardı): slug (prior_n), ...`, largest prior_n first, cut at 500 characters;
--     `yeni susan kaynak yok` when nothing is flagged. threshold = 1.
--
-- WHAT CHANGES
--   * public.ops_dark_source_baseline(slug, reason, noted_in, added_at): the
--     known-dark sources, seeded with the 25 of docs/feed-registry-2026-09.md
--     section 2, reason = that table's class (blocked-403 14, dns-timeout 3,
--     not-a-feed 4, redirect-offsite 1, valid-stale 3). RLS on, no policy, every
--     default grant revoked (091/095), the PG17 MAINTAIN revoke guarded as in
--     107/111, and this file grants SELECT to service_role and nothing else.
--     anon and authenticated hold no privilege at all; whatever else service_role
--     holds comes from Supabase's default privileges (that is what lets the
--     service key ack a source). The function is SECURITY DEFINER and reads the
--     table; nothing in the app does.
--   * public.ops_health_report() is re-created: 108 body verbatim plus row 13.
--     Same signature, same five output columns, same SECURITY DEFINER /
--     search_path = '' / service_role-only grants. The function header, the
--     declare section and checks 1-12 are byte-identical to 108's (the test
--     splits both bodies at every `check_name :=` and compares them; check 12
--     only loses its `return; end` tail, which now follows row 13). The comment
--     on the function is re-written for 13 rows. The bias -> zone VALUES list is
--     repeated once more; it is pinned by the same test and listed in
--     tests/migrations/zone-parity.test.ts KNOWN_FILES. The guard
--     tests/guards/ops-health-checks.test.ts fails the build if a later
--     re-creation drops any literal check this one has.
--   * No source is touched. This file does not repoint, relay, activate or
--     deactivate any row of public.sources and does not read it for writing;
--     what to do with a dark source (repoint, relay, deactivate) is a founder /
--     operator decision (docs/feed-registry-2026-09.md section 2).
--
-- ACK PROCEDURE (operator; service_role or postgres, no other role can read or
-- write the table). To stop a known-dark source from warning:
--   insert into public.ops_dark_source_baseline (slug, reason) values ('<slug>', '<why>') on conflict (slug) do nothing;
-- To re-arm the warning, for example once the source is repointed:
--   delete from public.ops_dark_source_baseline where slug = '<slug>';
-- Do not ack halk-tv, gazete-pencere, benguturk, medya-gazete or arti-gercek
-- unless the founder has decided to leave them dark. Docs: docs/ops-heartbeat.md.
--
-- STEP 0 (production, read-only SELECT / EXPLAIN, 2026-10-23 22:12 UTC; no
-- thresholds were changed)
--   a) Version 114 is free: the ledger holds 108..112 and nothing above (113 is
--      another change of this wave).
--   b) Row 13 predicate standalone at v_now = now(), the 25 baseline slugs
--      inlined: 6 flagged, not the five of the evidence.
--        haberport       7,922 prior, last article 10-23 08:54 (about 50 an hour
--                        until 08:00, then 13 h of nothing: a sixth silent source)
--        benguturk       1,743 prior, last 10-23 09:33
--        halk-tv         1,064 prior, last 10-16 15:12
--        gazete-pencere    843 prior, last 10-15 16:01
--        korkusuz          583 prior, last 10-23 03:24 (low volume)
--        en-politik         63 prior, last 10-22 12:39 (low volume)
--      medya-gazete (last 12:12, 5 articles in the last 12 h) and arti-gercek
--      (last 14:33, 16 in the last 12 h) were not yet 12 h silent at 22:12 UTC;
--      they trip at about 00:12 and 02:33 UTC if they stay silent.
--   c) False-positive replay, v_now = now() - k * 6 h for k = 0..28 (7 days,
--      computed in one pass from 6 h age buckets of created_at; k = 0 matches b).
--      173 flags over 22 distinct slugs. Of the 146 flags with a full 24 h of
--      follow-up (k >= 4), 89 saw an article within 24 h. Flagged and then
--      resumed within 24 h (17 slugs): acik-gazete, agos, aykiri, bbc-turkce,
--      bha, bir-gazete, demokrat-haber, dw-turkce, en-politik, haberet,
--      hurriyet-daily-news, korkusuz, medya-gazete, mynet, serbestiyet, tele1,
--      turkiye-haber-ajansi. These are low-volume outlets (50-150 articles in
--      14 days) and overnight lulls longer than 12 h. Never resumed: halk-tv
--      (24 of 24 complete flags) and gazete-pencere (25 of 25). Sensitivity, for
--      the operator, NOT applied (flags, distinct slugs, flags resumed within
--      24 h / complete flags, flagged now):
--        12 h, >= 50 (this file)   173  22  89/146  6
--        12 h, >= 200               81  13  17/66   5
--        18 h, >= 50               103  11  35/88   4
--        24 h, >= 50                73   8  13/63   3
--        24 h, >= 200               55   2   0/47   2  (halk-tv, gazete-pencere)
--      The row is warn only, so noise costs a line in the table, not a page.
--      Tuning it is a new migration (docs/ops-heartbeat.md, Tuning a threshold).
--   d) EXPLAIN (ANALYZE, BUFFERS) of the predicate: Parallel Index Only Scan
--      using idx_articles_created_source on articles (75,242 rows a worker,
--      heap fetches 6,610), all 4,974 buffers shared hit, planning 2.2 ms,
--      execution 49 ms (limit 2 s).
--   e) All 25 baseline slugs exist in sources and are active. Five of them
--      (bloomberg-ht, finansal-gundem, tobb, journo: niche; haber3: aggregator)
--      are not voting kinds, so row 13 would ignore them anyway. All 25 are
--      seeded regardless.
--
-- DRY RUNS (×2) (local PG15.12, throwaway cluster, 2026-10-23; stub schema plus
-- articles.created_at; default privileges mimic Supabase's: grant all on tables
-- to anon, authenticated, service_role). Applied twice in a row on a fresh
-- database:
--   run 1   BEGIN, CREATE TABLE, COMMENT, ALTER TABLE, REVOKE, DO, GRANT,
--           INSERT 0 25, CREATE FUNCTION, COMMENT, REVOKE, GRANT, INSERT 0 1, COMMIT
--   run 2   the same statements, no error: NOTICE `relation already exists,
--           skipping`, INSERT 0 0 (seed), INSERT 0 0 (ledger), COMMIT
--   After   25 seed rows (blocked-403 14, dns-timeout 3, not-a-feed 4,
--           redirect-offsite 1, valid-stale 3); 1 ledger row; ops_health_report()
--           returns 13 rows and row 13 reads pass / observed 0 / threshold 1 /
--           `yeni susan kaynak yok`. The stub has no pg_cron, pg_net or Jev
--           tables and no articles, so rows 1-3, 7-9, 11 and 12 read unknown and
--           rows 4-6 read fail, as expected there.
--   Grants  anon and authenticated: select, insert, update, delete, truncate,
--           references and trigger on the table are all false, execute on the
--           function is false; service_role execute is true. RLS on, 0 policies.
--           The function is volatile, security definer, search_path = "".
--   Fixtures (the TAYF_PSQL block of the test, inside a rolled-back transaction):
--           fx-dark (active outlet, 60 articles 1-10 days old) is reported: warn,
--           observed 1, detail ending `fx-dark (60)`. fx-busy (60 plus one 1 h
--           old), fx-small (49), ntv (baseline slug), fx-off (inactive) and
--           fx-agg (aggregator) are not. With fx-dark removed: pass,
--           `yeni susan kaynak yok`.
--
-- ROLLBACK (nothing else depends on this; re-apply the function first, because
-- row 13 reads the table):
--   re-apply the `create or replace function public.ops_health_report()` of
--     108_jev_stall_check_v2.sql (with its comment, revoke and grant); that
--     restores the 12-row report. Its cron do-block need not run again.
--   drop table public.ops_dark_source_baseline;
--   then delete ledger row 114:
--   delete from supabase_migrations.schema_migrations where version = '114';
--
-- Additive, read-only function. Safe to re-apply (create table if not exists,
-- seed on conflict do nothing, create or replace function, ledger insert on
-- conflict do nothing). The seed never overwrites a row an operator edited.
-- Deploy: apply with the normal migration path. No CONCURRENTLY step, no cron
-- change, no edge function change; the next ops-heartbeat run shows row 13.

begin;

-- 1. Baseline table -------------------------------------------------------------

create table if not exists public.ops_dark_source_baseline (
  slug     text primary key,
  reason   text not null,
  noted_in text not null default 'docs/feed-registry-2026-09.md §2',
  added_at timestamptz not null default pg_catalog.now()
);

comment on table public.ops_dark_source_baseline is
  'Sources already known to be dark (migration 114): the sources_newly_dark row of '
  'ops_health_report() skips every slug listed here. Seeded with the 25 sources of '
  'docs/feed-registry-2026-09.md section 2 (reason = their class). Insert a row to '
  'acknowledge a dark source, delete it to re-arm the warning. service_role only.';

alter table public.ops_dark_source_baseline enable row level security;

-- Supabase default privileges hand new tables to anon/authenticated (incl.
-- write grants, cf. 091/095): strip them. Only service_role may read; nothing
-- but an operator writes.
revoke all on public.ops_dark_source_baseline from anon, authenticated, public;

-- PG17 added the MAINTAIN privilege; it does not exist before PG17 (revoking
-- it would be a syntax error), so guard.
do $maint$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on public.ops_dark_source_baseline from anon, authenticated';
  end if;
end
$maint$;

grant select on public.ops_dark_source_baseline to service_role;

-- 2. Seed: docs/feed-registry-2026-09.md section 2 (slug, class) ------------------

insert into public.ops_dark_source_baseline (slug, reason) values
  ('ntv', 'blocked-403'),
  ('milli-gazete', 'blocked-403'),
  ('internet-haber', 'blocked-403'),
  ('dogru-haber', 'blocked-403'),
  ('gercek-gundem', 'blocked-403'),
  ('haber3', 'blocked-403'),
  ('en-son-haber', 'blocked-403'),
  ('dikgazete', 'blocked-403'),
  ('gazete-duvar', 'blocked-403'),
  ('gazete-net', 'blocked-403'),
  ('haberiniz', 'blocked-403'),
  ('krt-tv', 'blocked-403'),
  ('ekol-tv', 'blocked-403'),
  ('iha', 'blocked-403'),
  ('al-ain-turkce', 'dns-timeout'),
  ('finansal-gundem', 'dns-timeout'),
  ('tobb', 'dns-timeout'),
  ('t24', 'not-a-feed'),
  ('rudaw-turkce', 'not-a-feed'),
  ('turkiye-today', 'not-a-feed'),
  ('voa-turkce', 'not-a-feed'),
  ('yenisoz', 'redirect-offsite'),
  ('bloomberg-ht', 'valid-stale'),
  ('ayandon', 'valid-stale'),
  ('journo', 'valid-stale')
on conflict (slug) do nothing;

-- 3. ops_health_report(): 108's twelve checks plus row 13 -------------------------

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

  -- 13. sources_newly_dark (migration 114)
  check_name := 'sources_newly_dark'; threshold := 1; observed := null; detail := null;
  begin
    with vs as (select s.id, s.slug from public.sources s
                 where s.active and s.kind in ('outlet', 'wire')
                   and not exists (select 1 from public.ops_dark_source_baseline b where b.slug = s.slug)),
    c as (select a.source_id,
                 pg_catalog.count(*) filter (where a.created_at < v_now - interval '12 hours') as prior_n,
                 pg_catalog.count(*) filter (where a.created_at >= v_now - interval '12 hours') as recent_n
            from public.articles a
           where a.created_at >= v_now - interval '14 days 12 hours' and a.created_at <= v_now
           group by a.source_id)
    select pg_catalog.count(*)::numeric,
           pg_catalog.string_agg(v.slug || ' (' || c.prior_n::text || ')', ', ' order by c.prior_n desc, v.slug)
      into v_n, v_text
      from vs v join c on c.source_id = v.id
     where c.prior_n >= 50 and c.recent_n = 0;
    observed := v_n;
    status := case when v_n >= 1 then 'warn' else 'pass' end;
    detail := case when v_n >= 1
      then substr('son 12 saatte haber gelmedi (önceki 14 günde en az 50 haber vardı): ' || v_text, 1, 500)
      else 'yeni susan kaynak yok' end;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  return;
end
$fn$;

comment on function public.ops_health_report() is
  'Read-only ops heartbeat (migrations 077, 100, 103, 108, 114): 13 fixed rows, in this order --'
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
  ' that had at least 50 articles in the 14 days before the last 12 hours and none in those'
  ' 12 hours; warn only, never fail: the detail names them).'
  ' status is one of pass|warn|fail|unknown|skip, and threshold is the fail limit'
  ' (or the warn limit for warn-only checks). Never writes any table, and'
  ' never reads any potentially secret-bearing pg_cron job field. Polled by'
  ' .github/workflows/ops-heartbeat.yml over PostgREST every 30 minutes.'
  ' service_role only. See docs/ops-heartbeat.md.';

revoke all on function public.ops_health_report() from public, anon, authenticated;
grant execute on function public.ops_health_report() to service_role;

-- 4. Ledger ------------------------------------------------------------------------

insert into supabase_migrations.schema_migrations (version, name)
  values ('114', '114_sources_newly_dark')
  on conflict do nothing;

commit;
