-- 110_public_status.sql
--
-- Backs the public /durum ("Sistem durumu") page. One read-only function,
-- public.public_status_snapshot(), returns a small jsonb document of SAFE
-- AGGREGATES only: when the newest article arrived per bias, when the newest
-- cluster changed, when the last labelling run finished (and whether the
-- labelling cron job is switched off), and how many active sources have been
-- silent for 72 hours. It never returns a job name, an error message, a URL, a
-- response body or an id; ops_health_report() (migrations 077/103/108) stays
-- the operator view and stays service_role-only. The page reads this function
-- through the service-role reader client (src/lib/status/public-status.ts),
-- caches it for about a minute, and validates the payload with an allow-list
-- parser (src/lib/status/verdict.ts toPublicStatusSnapshot) before rendering.
--
-- Why a function and not four PostgREST reads: the cron.job lookup (is the
-- jev-shadow job active) is not reachable through PostgREST, and one round
-- trip keeps the page inside the 4 s reader cap on the Micro compute tier.
--
-- Zones: ingest freshness is grouped by sources.bias and collapsed to zones in
-- TypeScript (BIAS_TO_ZONE). This file is therefore not a new bias -> zone
-- copy and tests/migrations/zone-parity.test.ts KNOWN_FILES is unchanged.
--
-- Each section sits in its own exception block: a failing section reports
-- ok = false (the page shows "Bilinmiyor" for that step) and never aborts the
-- others. The handler deliberately captures no error text.
--
-- Sections and their bases:
--   ingest      ops check 4 basis: active VOTING sources (kind outlet / wire),
--               max(articles.created_at) per bias over the last 6 hours,
--               created_at <= now (a future-dated row cannot look fresh).
--   clustering  max(clusters.updated_at) over the last 6 hours, <= now.
--   labelling   ops check 5 basis (108): max(finished_at) of jev_shadow_runs
--               that closed ok / budget_exceeded or made at least one call, so a
--               zero-call partial run does not read as fresh; paused = the
--               jev-shadow cron job exists and every row of it is inactive.
--               Only the boolean activity flag is read, never the command.
--   feeds       all ACTIVE sources, and how many delivered no article in the
--               trailing 72 hours (published_at <= now): the same window and
--               denominator as /kaynaklar/durum (FEED_YIELD_WINDOW_MS).
--
-- STEP 0 FINDINGS (read-only SELECTs against production, 2026-10-22; numbers
-- only):
--   1. Cluster cadence. Largest gap between consecutive clusters.updated_at
--      values over the last 7 days = 51 min (10,990 intervals). Following the
--      ops 077 convention, fail = max(90, ceil(1.5 x 51) = 77) = 90 and warn =
--      ceil(fail / 2) = 45:
--        STATUS_CLUSTER_FAIL_MIN = 90
--        STATUS_CLUSTER_WARN_MIN = 45
--      (src/lib/status/verdict.ts). The query did not time out, so the 158 / 79
--      fallback was not used.
--   2. Feed baseline. 118 active sources, 26 with no article in 72 hours =
--      22.0 %. That is below the 0.35 line at which the warn level would have to
--      be lifted above its default, so:
--        STATUS_FEEDS_WARN_SILENT_SHARE = 0.40
--        STATUS_FEEDS_FAIL_SILENT_SHARE = 0.50   (the ops dead_feeds ratio)
--      Today's baseline therefore reads "ok" with 18 points of headroom to warn.
--      The ingest (79 / 158) and labelling (20 / 30) thresholds are ops checks 4
--      and 5 verbatim.
--   3. Cost of the four SELECT bodies, as plain selects with now() against
--      production (server-side execution time from explain analyze; wall time
--      per statement through the management API, which is dominated by the HTTP
--      round trip):
--        ingest      1.3 ms execution   ~333 ms wall   (5 bias rows)
--        clustering  0.09 ms execution  ~317 ms wall
--        labelling   0.15 ms execution  ~492 ms wall
--        feeds       2.0 ms execution   ~282 ms wall   (118 active, 26 silent)
--      Together ~3.5 ms of database time and ~1.4 s wall even with four separate
--      round trips, so the single call stays well under the 2 s warm budget
--      (< 2 s; the reader cap is 4 s).
--
-- DRY RUN (local PG15)
-- PostgreSQL 15.12, throwaway data dir, port 55410. Prelude: the shared stub
-- schema, plus articles.created_at and a minimal jev_shadow_runs(id, started_at,
-- finished_at, status, calls). Applied this file twice: both runs exit 0 with no
-- output, and the ledger holds exactly one row, '110 110_public_status'.
-- Fixtures: two voting sources (pro_government article created 10 min ago,
-- opposition article created 100 min ago); an aggregator article created 1 min
-- ago (must be ignored); an inactive source article 2 min ago (ignored); a
-- future-dated article (ignored); a quiet source whose last article is 5 days
-- old; clusters updated 5 min ago, 2 hours in the FUTURE (ignored) and 2 days
-- ago; a jev run that closed ok 12 min ago and a zero-call partial run that
-- closed 1 min ago (ignored).
--   ingest.last_by_bias keys ......... opposition, pro_government only
--   pro_government age ............... 10 min   (asserted 9.5 - 11)
--   opposition age ................... 100 min  (asserted 99.5 - 101)
--   clustering.last_at age ........... 5 min    (the future cluster is ignored)
--   labelling.last_at age ............ 12 min   (the zero-call partial is ignored)
--   labelling.paused ................. false     (no cron schema in this instance)
--   feeds ............................ active 4, silent 1
--   every section ok ................. true
--   top-level keys ................... clustering, feeds, generated_at, ingest, labelling
-- Privileges: pg_proc.prosecdef = t, provolatile = s, proconfig =
-- {search_path=""}. has_function_privilege: anon f, authenticated f,
-- service_role t. The function ACL is {postgres:EXECUTE, service_role:EXECUTE}
-- (PUBLIC removed). As role anon and as role authenticated the call fails with
-- "permission denied for function public_status_snapshot"; as service_role it
-- returns the document. The migration created 0 tables.
-- Extra scenarios (a stub cron.job(jobname, active) table): no jev-shadow row ->
-- paused false; row active -> false; row inactive -> true (rows of other jobs are
-- ignored). Section isolation (each rolled back): renaming jev_shadow_runs gave
-- labelling {ok false, last_at null, paused false} with ingest, clustering and
-- feeds still ok; renaming articles gave ingest {ok false, last_by_bias {}} and
-- feeds {ok false, active null, silent null} with clustering and labelling ok.
-- A regex scan of the whole document for cron / jev / net / http / jobname /
-- sqlerrm / service_role vocabulary and for uuids found nothing. Timestamps are
-- emitted in the session time zone (+01:00 here), which the TypeScript parser
-- accepts.
--
-- Read-only function, additive: no table, no trigger, no cron job, no data
-- written other than the ledger row. Safe to re-apply (create or replace,
-- ledger insert on conflict do nothing). The only grant is execute to
-- service_role, so no table-grant revoke block is needed.
--
-- Rollback: drop function public.public_status_snapshot();
-- then delete ledger row 110 from supabase_migrations.schema_migrations.

begin;

create or replace function public.public_status_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_now timestamptz := pg_catalog.now();
  v_since timestamptz := pg_catalog.now() - interval '6 hours';
  v_ingest jsonb; v_ingest_ok boolean := true;
  v_cluster timestamptz; v_cluster_ok boolean := true;
  v_label timestamptz; v_label_ok boolean := true; v_paused boolean := false;
  v_active integer; v_silent integer; v_feeds_ok boolean := true;
begin
  begin  -- ingest: ops check 4 basis (active voting sources, articles.created_at), grouped by bias
    select coalesce(pg_catalog.jsonb_object_agg(t.bias, t.last_at), '{}'::jsonb) into v_ingest
      from (select s.bias, pg_catalog.max(a.created_at) as last_at
              from public.articles a join public.sources s on s.id = a.source_id
             where s.active and s.kind in ('outlet', 'wire')
               and a.created_at >= v_since and a.created_at <= v_now
             group by s.bias) t;
  exception when others then v_ingest := '{}'::jsonb; v_ingest_ok := false; end;
  begin
    select pg_catalog.max(c.updated_at) into v_cluster from public.clusters c
     where c.updated_at >= v_since and c.updated_at <= v_now;
  exception when others then v_cluster := null; v_cluster_ok := false; end;
  begin  -- labelling: ops check 5 basis (108)
    select pg_catalog.max(r.finished_at) into v_label from public.jev_shadow_runs r
     where r.started_at >= v_since and (r.status in ('ok', 'budget_exceeded') or r.calls > 0);
    if pg_catalog.to_regclass('cron.job') is not null then
      execute $q$ select coalesce(pg_catalog.bool_and(not j.active), false) from cron.job j where j.jobname = 'jev-shadow' $q$ into v_paused;
    end if;
  exception when others then v_label := null; v_label_ok := false; v_paused := false; end;
  begin  -- feeds: all active sources, same 72 h yield window as /kaynaklar/durum
    select pg_catalog.count(*)::int,
           (pg_catalog.count(*) filter (where not exists (select 1 from public.articles a
              where a.source_id = s.id and a.published_at >= v_now - interval '72 hours' and a.published_at <= v_now)))::int
      into v_active, v_silent from public.sources s where s.active;
  exception when others then v_active := null; v_silent := null; v_feeds_ok := false; end;
  return pg_catalog.jsonb_build_object(
    'generated_at', v_now,
    'ingest', pg_catalog.jsonb_build_object('ok', v_ingest_ok, 'last_by_bias', v_ingest),
    'clustering', pg_catalog.jsonb_build_object('ok', v_cluster_ok, 'last_at', v_cluster),
    'labelling', pg_catalog.jsonb_build_object('ok', v_label_ok, 'last_at', v_label, 'paused', v_paused),
    'feeds', pg_catalog.jsonb_build_object('ok', v_feeds_ok, 'active', v_active, 'silent', v_silent));
end
$fn$;

comment on function public.public_status_snapshot() is
  'Safe aggregates only (timestamps, counts, booleans): no job names, error text, URLs or ids. Read by /durum through the service-role reader client. service_role only. Migration 110.';

revoke all on function public.public_status_snapshot() from public, anon, authenticated;
grant execute on function public.public_status_snapshot() to service_role;

insert into supabase_migrations.schema_migrations (version, name)
  values ('110', '110_public_status')
  on conflict do nothing;

commit;
