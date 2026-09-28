-- 084_db_housekeeping.sql
--
-- DB housekeeping: audit fix A (db-platform), Step 0 re-measured live on
-- 2026-09-28 (Supabase confirmed in eu-west-2/London via
-- `select inet_server_addr()` -> a 2a05:d01c::/32 address).
--
-- S2. clusters vacuum state:
--   n_live_tup=191,345  n_dead_tup=16,457  last_autovacuum=2026-09-28 19:18:57 UTC
--   last_vacuum=null    last_autoanalyze=2026-09-28 04:10:52 UTC   reloptions=null (none set)
--   At ~206k rows (matches the planner's estimate), the default
--   autovacuum_vacuum_scale_factor=0.2 fires near ~41k dead tuples; 0.05
--   fires near ~10k instead -- roughly 4x more often, keeping bloat and
--   the visibility map fresher for this frequently-updated table.
--
-- S3. Two unused articles indexes (R1: drop only if idx_scan=0, not
--   unique/PK, doesn't back a constraint, and stats cover >=30 days):
--   idx_articles_fingerprint            idx_scan=0  size=32 MB  not unique/PK  backs no constraint
--   idx_articles_body_excerpt_backfill  idx_scan=0  size=13 MB  not unique/PK  backs no constraint
--   pg_stat_database.stats_reset = null; pg_postmaster_start_time() =
--   2026-05-22 18:00:04 UTC (>30 days before this measurement) -- stats
--   cover the full window, R1 is satisfied for both. Neither index is
--   referenced by any query in src, supabase/functions, scripts or the
--   migrations (grepped clean).
--
-- S4. FK columns with no leading index (R2: add each one still listed):
--   story_stances.source_id (story_stances_source_id_fkey)
--   corrections.cluster_id  (corrections_cluster_id_fkey)
--   zone_guesses.article_id (zone_guesses_article_id_fkey)
--   All three tables are EMPTY (count(*) = 0 each) as of this measurement --
--   013 dropped idx_story_stances_source_id specifically because it was
--   never scanned on an empty table; it is re-added here purely as FK
--   support (cheap to build now, before the table has real rows) rather
--   than because of any observed query pattern.
--
-- S5. image_url shapes, 30-day window:
--   video (mp4/m3u8/webm/mov) = 1,746 rows       -> R4: backfill ships (>0)
--   rcman 150x84 small crop   = 12,641 rows       -> R3: upgrade ships (see below)
--   haberet 150x84 small crop = 10,554 rows       -> TODO, no verified larger variant
--   rcman-small hosts, 3-day window: img.aydinlik.com.tr=504,
--   img.ekonomim.com=444, img.f5haber.com=191, image.artigercek.com=122.
--   R3 verification: 25 rcman URLs sampled at random from the last 3 days,
--   each rewritten '/rcman/Cw150h84q95gc/' -> '/rcman/Cw1280h720q95gc/' and
--   probed with `curl -sI`: 25/25 returned `200 image/jpeg` (>= the 24/25
--   threshold) -- the upgrade ships for both ingest and backfill.
--
-- S8. net._http_response (informational only -- 084 does not touch it; see
--   docs/migration-guide.md's corrected runbook): 178 MB total size, 820
--   live rows, owned by supabase_admin, has_table_privilege(...,'TRUNCATE')
--   = true for the migrating role, last_autovacuum 2026-08-05 10:11:49 UTC.
--   VACUUM (plain or FULL) run as postgres is a no-op here because the
--   table owner is supabase_admin, not postgres -- see docs section "net.
--   _http_response bloat: the operator step".
--
-- Lock notes: the two `drop index if exists` statements below (on
-- public.articles) take an ACCESS EXCLUSIVE lock -- briefly excluding
-- both readers and writers -- for the (near-instant, non-CONCURRENT)
-- duration of that DDL statement. The three `create index if not exists`
-- statements (on corrections/zone_guesses/story_stances, all currently
-- empty per S4) take only a SHARE lock -- Postgres's documented level for
-- a non-CONCURRENT CREATE INDEX -- which blocks writers but NOT readers of
-- the target table. `set local lock_timeout = '5s'` below means the whole
-- transaction fails fast (and can simply be re-run) rather than queuing
-- behind a long-running reader. An operator who wants zero lock risk on
-- the DROPs (the half that genuinely excludes readers) can pre-run them in
-- their own session with
-- `drop index concurrently if exists public.idx_articles_fingerprint;` /
-- `... idx_articles_body_excerpt_backfill;` before applying this file --
-- DROP INDEX IF EXISTS is then a no-op here.
--
-- Operator follow-ups (not run inside this transaction -- VACUUM cannot
-- run inside a transaction block, and `net._http_response` needs the
-- table-owner runbook in docs):
--   1. A one-off manual `vacuum (analyze) public.clusters;` right after
--      applying, to work off the current 16,457 dead tuples immediately
--      rather than waiting for the new, tighter autovacuum thresholds.
--   2. The net._http_response runbook in docs/migration-guide.md ("net.
--      _http_response bloat: the operator step") -- a manual
--      `truncate table net._http_response;` in the 04:30 UTC lull.
--
-- One transaction, additive only (new indexes, a reloption change, a
-- bounded 30-day data cleanup, and a cron schedule) plus two `drop index`
-- statements for indexes confirmed dead by S3/R1 above. SECURITY DEFINER
-- is not used anywhere in this file. Safe to re-apply: every CREATE is
-- `if not exists`, every DROP is `if exists`, the cron reschedule
-- unschedules-then-reschedules, and the ledger insert is
-- `on conflict do nothing`.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '5min';

-- S2 / autovacuum tuning -----------------------------------------------------

alter table public.clusters set (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_vacuum_insert_scale_factor = 0.05
);

-- S4 / R2: FK support indexes -------------------------------------------------

create index if not exists corrections_cluster_id_idx on public.corrections (cluster_id);
create index if not exists zone_guesses_article_id_idx on public.zone_guesses (article_id);
create index if not exists story_stances_source_id_idx on public.story_stances (source_id);

-- S3 / R1: drop the two confirmed-unused articles indexes --------------------

drop index if exists public.idx_articles_fingerprint;
drop index if exists public.idx_articles_body_excerpt_backfill;

-- S5 / R4: null out video image_url values from the last 30 days and
-- explicitly enqueue image_backfill for them -- migration 025's
-- articles_image_enqueue trigger only fires `AFTER INSERT ... WHEN
-- (new.image_url IS NULL)`, so this UPDATE does not fire it itself.
do $$
declare v_ids uuid[];
begin
  with nulled as (
    update public.articles a set image_url = null
     where a.published_at > pg_catalog.now() - interval '30 days'
       and a.image_url ~* '\.(mp4|m3u8|webm|mov)(\?|#|$)'
    returning a.id)
  select coalesce(pg_catalog.array_agg(n.id), '{}') into v_ids from nulled n;
  raise notice '084: cleared % video image_url values', pg_catalog.cardinality(v_ids);
  -- 025 enqueues image_backfill only on INSERT; enqueue the cleared rows explicitly
  if pg_catalog.cardinality(v_ids) > 0 and exists (select 1 from pg_catalog.pg_namespace where nspname = 'pgmq') then
    perform pgmq.send('image_backfill', pg_catalog.jsonb_build_object('article_id', x)) from pg_catalog.unnest(v_ids) as x;
  end if;
end $$;

-- S5 / R3: upgrade the rcman 150x84 small crop to 1280x720 for the last 30
-- days (verified: 25/25 sampled URLs return 200 image/* after rewrite).
update public.articles set image_url = pg_catalog.replace(image_url, '/rcman/Cw150h84q95gc/', '/rcman/Cw1280h720q95gc/')
 where published_at > pg_catalog.now() - interval '30 days' and image_url like '%/rcman/Cw150h84q95gc/%';

-- Operator follow-up #1: manual clusters vacuum, scheduled nightly so the
-- currently-observed dead-tuple backlog (16,457) and any future backlog
-- gets worked off even between autovacuum runs. VACUUM cannot run inside
-- this transaction block, hence the cron.schedule wrapper.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron not installed; skipping clusters-vacuum'; return;
  end if;
  if exists (select 1 from cron.job where jobname = 'clusters-vacuum') then perform cron.unschedule('clusters-vacuum'); end if;
  perform cron.schedule('clusters-vacuum', '35 */6 * * *', 'vacuum (analyze) public.clusters');
end $$;

insert into supabase_migrations.schema_migrations (version, name) values ('084', '084_db_housekeeping') on conflict do nothing;

commit;
