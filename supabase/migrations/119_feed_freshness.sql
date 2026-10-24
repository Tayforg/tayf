-- 119_feed_freshness.sql
--
-- A frozen feed is told apart from a quiet outlet and from a blocked one, and
-- ops_health_report() row 13 (`sources_newly_dark`) says which it is. Ingest
-- stores what each feed reports about itself (the newest item date and the item
-- count) on public.sources; the report and /kaynaklar/durum read it next to the
-- fetch status Tayf already keeps. Edge half: supabase/functions/ingest/index.ts
-- and supabase/functions/_shared/rss/feed-freshness.ts. App half:
-- src/lib/sources/silence-reason.ts, feed-status.ts and the durum page.
--
-- WHY (evidence: production, read-only, 2026-10-24 07:40 UTC)
--   haberport, korkusuz and en-politik answer HTTP 200 on every poll
--   (fetch_last_status 200, fetch_fail_streak 0, no quarantine, fetch_body_hash
--   set, no etag) and publish nothing new: the body is the same bytes every
--   time. Their last stored articles are 10-23 08:54 (haberport, 7,922 in the
--   14 days before the last 24 h), 10-23 03:24 (korkusuz, 591; its newest
--   published_at is 10-22 09:29) and 10-22 12:39 (en-politik, 64). Row 13
--   (114/115) lists them as `slug (n)`, which reads exactly like an outlet that
--   is merely quiet, and like halk-tv and gazete-pencere (last article 10-16 and
--   10-15), which are a different problem. The operator's next move differs:
--     * the feed is frozen: find a new feed URL or contact the publisher;
--     * the feed cannot be fetched: look at the status and the quarantine;
--     * the feed is current and nothing new was published: usually nothing.
--   Tayf had no column that could say which. A frozen feed with a byte-identical
--   body is never parsed again (fetchFeed short-circuits on fetch_body_hash, and
--   on the etag 304), so the very sources this item targets would keep an empty
--   column forever. That is why ingest runs a one-time BOOTSTRAP fetch for every
--   source whose fetch_items_count is still NULL (see Deploy).
--
-- WHAT CHANGES (pinned by tests/migrations/119-feed-freshness.test.ts)
--   1. public.sources gets two nullable columns, no default, no not null:
--        fetch_newest_item_at timestamptz   newest usable item date of the feed
--        fetch_items_count    integer       entries the feed held at the last parse
--      No grant of any kind: the columns inherit 117's empty anon/authenticated
--      table ACL (nothing is readable by anon; service_role reads them).
--   2. ingest_set_source_fetch_state(jsonb) is re-created (074's body): the seven
--      existing assignments are byte-identical, the recordset column list gains
--      the two keys, and two assignments are added:
--        fetch_newest_item_at = case when r.fetch_items_count is null then the
--          stored value when r.fetch_newest_item_at is null then null else
--          least(r.fetch_newest_item_at, now() + interval '10 minutes') end
--        fetch_items_count = case when r.fetch_items_count is null then the
--          stored value else greatest(r.fetch_items_count, 0) end
--      The two values travel together: a payload without fetch_items_count (a
--      304, a failure, a pre-119 ingest) keeps both stored values, and a payload
--      with a count but no newest date writes NULL (a feed whose items carry no
--      usable date). It is never a bare least(): least(NULL, x) = x would turn
--      every undated feed into a fresh one, the trap 074 documents for the
--      quarantine column. A future date is clamped to now + 10 minutes as a
--      second guard (the edge helper already ignores items past that tolerance).
--      Signature, language, security definer, search_path = '' and the grants
--      are 074's.
--   3. ops_health_report() is re-created with 115's body verbatim for the
--      header, the declare section and rows 1-12 (comments included; the test
--      compares the raw text). Row 13 keeps every predicate (baseline
--      exclusion, >= 50 articles in the 14 days before the last 24 hours, none
--      in those 24 hours, threshold 1, warn only, `yeni susan kaynak yok`, the
--      500-character cut, the exception handler, the detail prefix) and changes
--      two things: the vs CTE gets a `reason` column, evaluated in this order,
--        'erişim yok'   quarantined now, or fetch_fail_streak > 0, or no status
--                        yet, or a last status that is neither 2xx nor 304
--                        (blocked 403/404, 5xx, 0 = no HTTP answer);
--        'akış donmuş'  the feed answers but holds no items, or its newest item
--                        is more than 72 hours old;
--        'sessiz'        everything else (the feed is current or paused for
--                        under 72 hours, or was never measured:
--                        fetch_items_count and fetch_newest_item_at NULL);
--      and every entry reads `slug (prior_n) · reason`. The `slug (n)`
--      substring is kept, so 115's fixture assertions still hold. The marker
--      comment and the function comment are re-written for 119 (migrations 077,
--      100, 103, 108, 114, 115, 119). The TypeScript twin of the three labels
--      and of the order is src/lib/sources/silence-reason.ts; the test pins both.
--      WHY 72 hours and not 24: row 13 lists a source only after 24 hours with no
--      STORED article, and ingest stores every usable item within minutes of the
--      feed publishing it, so a listed source's newest feed item is already about
--      24 hours old. A 24 hour threshold would label every listed source
--      `akış donmuş`, a live outlet that paused over a night or a weekend
--      included, and the runbook would tell the operator to find a new feed URL
--      for it (115's replay: 13 of 63 complete flags, 21%, resumed within 24 h).
--      72 hours is the window dead_feeds and the app's silence gate
--      (FEED_YIELD_WINDOW_MS) already use; a feed whose newest item is 24-72
--      hours old reads `sessiz` (look again), and flips to `akış donmuş` if it
--      is still frozen once that item passes 72 hours. The cost: a frozen feed
--      reads `sessiz` for its first three days. tests/migrations/119 and
--      tests/guards/ops-health-checks.test.ts pin the threshold above row 13's
--      own window, and src/lib/sources/silence-reason.ts (FROZEN_FEED_MS) mirrors it.
--   The function stays SECURITY DEFINER, search_path = '', volatile, read-only,
--   execute for service_role only. This file creates no table, adds no grant,
--   deletes nothing and writes no row of public.sources itself. The bias -> zone
--   VALUES list is repeated once more; it is pinned by the same test and listed
--   in tests/migrations/zone-parity.test.ts KNOWN_FILES.
--
-- STEP 0 (production, read-only, 2026-10-24 07:40 UTC, via the management API's
-- SELECT only; nothing was applied)
--   a) Version 119 is free: the ledger holds '118' as its newest three-digit
--      version and no '119' or '120'.
--   b) Both columns are absent: information_schema.columns returns no row for
--      public.sources.fetch_newest_item_at or fetch_items_count.
--   c) The deployed bodies are the ones this file copies: md5(prosrc) of
--      public.ops_health_report() is fa1acc6711da972923b7a2dcd48e8b03 (16,338
--      characters), the md5 of the text between the two function quotes of
--      115_sources_newly_dark_24h.sql; md5(prosrc) of
--      public.ingest_set_source_fetch_state(jsonb) is
--      5d0afd3467ed8578b960c5b1871a3036 (1,009 characters), the md5 of the text
--      between the two dollar quotes of 074_ingest_fixes.sql.
--   d) The fetch_* values of the three frozen feeds (fetch_last_at 07:39 UTC,
--      i.e. polled every cycle):
--        slug         status  fail_streak  quarantined_until  etag   body hash
--        haberport    200     0            null               empty  348add1f89e5...
--        korkusuz     200     0            null               empty  0c5658b7e0bb...
--        en-politik   200     0            null               empty  fe1975777952...
--      All three: active, kind outlet. After the deploy and the bootstrap parse of
--      their feed they read 'sessiz' until the newest item of the feed is over 72
--      hours old, then 'akış donmuş' (korkusuz and en-politik from 10-25, haberport
--      a day later, if the feeds stay frozen).
--   e) What row 13's predicate flagged later the same day, with the fetch state
--      the new labels read (sources: 144 rows, 118 active, 96 outlet/wire):
--        slug            prior_n  status  fail_streak  quarantined_until   label
--        halk-tv         1,113    0       23           2026-10-24 22:51    erişim yok
--        gazete-pencere    877    403     30           2026-10-25 01:54    erişim yok
--        korkusuz          590    200     0            null                akış donmuş (once its newest item is over 72 h old)
--        en-politik         63    200     0            null                akış donmuş (once its newest item is over 72 h old)
--      haberport (last stored article 10-23 08:54) joins them as its 24 hours
--      pass. Until a source has been measured (fetch_items_count NULL) it reads
--      'sessiz' rather than 'akış donmuş': the bootstrap closes that gap. Until
--      the newest item is over 72 hours old it reads 'sessiz' too.
--
-- DRY RUNS (×2) (local PG15.12, throwaway cluster, 2026-10-24; the stub schema
-- plus, added in setup and not in this file, the sources fetch_* columns that
-- 041 and 074 own and articles.created_at; default privileges mimic Supabase's,
-- then a revoke mimics 117: anon and authenticated hold no table privilege).
-- 114 applied first, then 115, then this file twice in a row, each with psql -v
-- ON_ERROR_STOP=1 -f:
--   114     BEGIN, CREATE TABLE, COMMENT, ALTER TABLE, REVOKE, DO, GRANT,
--           INSERT 0 25, CREATE FUNCTION, COMMENT, REVOKE, GRANT, INSERT 0 1, COMMIT
--   115     BEGIN, CREATE FUNCTION, COMMENT, REVOKE, GRANT, INSERT 0 1, COMMIT
--   run 1   BEGIN, SET, ALTER TABLE, COMMENT, COMMENT, CREATE FUNCTION, COMMENT,
--           REVOKE, GRANT, CREATE FUNCTION, COMMENT, REVOKE, GRANT, INSERT 0 1, COMMIT
--   run 2   the same statements, no error; the only notices are the two "column
--           ... already exists, skipping" lines of add column if not exists; the
--           ledger insert is INSERT 0 0
--   After   3 ledger rows (114, 115, 119); ops_health_report() returns 13 rows and
--           row 13 reads pass / observed 0 / threshold 1 / `yeni susan kaynak yok`
--           (no articles in the stub); both new columns are timestamptz and
--           integer, nullable, no default.
--   Grants  has_column_privilege is false for anon and authenticated on both
--           columns, for select and for update, and true for service_role;
--           has_function_privilege execute is false for anon and authenticated
--           and true for service_role on both functions (service_role only; acl
--           {postgres=X/postgres, service_role=X/postgres}); security definer,
--           volatile, search_path = "". The prosrc of ops_health_report() holds
--           `14 days 24 hours`, `72 hours`, `akış donmuş` and no `14 days 12 hours`.
--   Fixtures (the TAYF_PSQL block of the test, inside rolled-back transactions;
--           each source has 60 articles older than 25 h and none recent) row 13:
--           warn / observed 10 / threshold 1 / `son 24 saatte haber gelmedi
--           (önceki 14 günde en az 50 haber vardı): fx-blocked (60) · erişim yok,
--           fx-empty (60) · akış donmuş, fx-frozen (60) · akış donmuş,
--           fx-frozen-73 (60) · akış donmuş, fx-html (60) · erişim yok, fx-paused
--           (60) · sessiz, fx-paused-71 (60) · sessiz, fx-quar (60) · erişim yok,
--           fx-quiet (60) · sessiz, fx-unmeasured (60) · sessiz` (newest feed
--           item 100 h, 73 h, 30 h and 71 h old for fx-frozen, fx-frozen-73,
--           fx-paused and fx-paused-71: the 72 hour threshold splits them).
--           Postgres refuses a year-0 or negative-year timestamp in
--           jsonb_to_recordset and fails the whole batch ("date/time field value
--           out of range", "time zone displacement out of range"); the edge
--           helper therefore bounds the item date to 1990..2100 before it is
--           sent, and ingest retries a refused batch in halves (the writer's SQL
--           is unchanged: the only caller is service_role code that sends
--           Date.toISOString() output). The writer: a payload without the
--           keys keeps count 12 and the stored date; count 5 with a null date
--           stores NULL (not now + 10 minutes); a date 2 days ahead is stored as
--           now + 10 minutes; a negative count is stored as 0. Mutation checks:
--           with 115's function the label test fails; with the CASEs removed
--           from the writer four writer tests fail. 115's own fixture block
--           passes against the database with 119 applied.
--   Rollback rehearsed: the 074 writer block re-applied (prosrc md5 back to
--           5d0afd3467ed8578b960c5b1871a3036, no fetch_items_count) and 115's
--           file re-applied (no labels), ledger row 119 removed, then this file
--           twice more with the same statement tags (INSERT 0 1, then INSERT 0 0).
--           Re-run after the 72 hour change: the full sequence above on a fresh
--           database, the TAYF_PSQL fixtures (114, 115 and 119 blocks pass), and
--           this rollback rehearsal.
--
-- DEPLOY: APPLY 119, THEN DEPLOY ingest (docs/migration-guide.md, section 119)
--   Apply this file first, then deploy the ingest Edge Function
--   (npx supabase functions deploy ingest --no-verify-jwt). The new ingest tries
--   the two new columns in its sources select and, when Postgres answers 42703
--   (undefined column: 119 not applied yet), retries once with the old select
--   and carries on without freshness, so the reverse order costs nothing but
--   the data. A pre-119 ingest never sends the keys, and the writer keeps the
--   stored values for a payload without them.
--   The first cycles after the deploy bootstrap every source whose
--   fetch_items_count is NULL: the etag and body-hash short-circuits are skipped
--   for that source once, the feed is parsed (the parse budget still applies, a
--   deferred bootstrap retries first next cycle), freshness is stored and, when
--   the body is the one already stored (the frozen feeds), no row is inserted.
--   Expect roughly three to four cycles for the whole roster. The app half needs
--   no ordering: it also falls back on 42703.
--
-- ROLLBACK (nothing else depends on 119; redeploy the previous ingest first)
--   re-apply the create or replace function block of 074_ingest_fixes.sql for
--     ingest_set_source_fetch_state(jsonb), with its comment, revoke and grant
--     (that drops the two keys from the writer; the columns then stay unused);
--   re-apply the create or replace function block of
--     115_sources_newly_dark_24h.sql for ops_health_report(), with its comment,
--     revoke and grant (that restores the plain `slug (n)` detail);
--   the columns may stay (nullable, unread). To drop them as well, only after
--     both steps above and the ingest rollback:
--     alter table public.sources drop column if exists fetch_newest_item_at,
--       drop column if exists fetch_items_count;
--   then remove ledger row 119 (run by the operator):
--     delete from supabase_migrations.schema_migrations where version = '119';
--
-- Additive. Safe to re-apply (add column if not exists, create or replace
-- function, ledger insert on conflict do nothing). One transaction; the only
-- lock of note is the short ACCESS EXCLUSIVE one that alter table takes on
-- public.sources (144 rows), bounded by lock_timeout = 5 s: on 55P03
-- nothing is recorded, re-apply. No CONCURRENTLY step, no cron change, no new
-- table, no grant.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- (1) The two feed-freshness columns on `sources`. Nullable, no default: NULL
-- means "never measured". No grant: the columns inherit 117's empty
-- anon/authenticated table ACL.
-- ---------------------------------------------------------------------------

alter table public.sources
  add column if not exists fetch_newest_item_at timestamptz,
  add column if not exists fetch_items_count integer;

comment on column public.sources.fetch_newest_item_at is
  'Newest item date the feed reported at its last parse (migration 119), from the raw '
  'isoDate or pubDate of each entry: unparseable dates are skipped, dates more than '
  '10 minutes in the future are ignored (so a frozen feed cannot look fresh) and so are '
  'dates before 1990 (a year-0 date would make Postgres refuse the whole batched write). '
  'NULL = never measured, or the feed carried no usable date. Written together with fetch_items_count '
  'by ingest_set_source_fetch_state. Not a secret, and not readable by anon (117).';

comment on column public.sources.fetch_items_count is
  'Entries the feed held at its last parse (migration 119), dated or not. 0 = the feed '
  'answers but is empty. NULL = never measured, which makes ingest bootstrap the source '
  'once (the etag and body-hash short-circuits are skipped for one parse). Written '
  'together with fetch_newest_item_at by ingest_set_source_fetch_state.';

-- ---------------------------------------------------------------------------
-- (2) ingest_set_source_fetch_state: 074's body, now also carrying the two
-- freshness keys. Never a bare least(): least(NULL, x) = x, so
-- `least(r.fetch_newest_item_at, ...)` on its own would turn every undated feed
-- (newest NULL) into one that was fresh a moment ago. The CASE keeps the stored
-- pair when the payload has no count, writes NULL when it has a count but no
-- date, and only clamps a date the caller actually sent.
-- ---------------------------------------------------------------------------

create or replace function public.ingest_set_source_fetch_state(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed integer;
begin
  update public.sources s
     set fetch_etag = r.fetch_etag,
         fetch_last_modified = r.fetch_last_modified,
         fetch_body_hash = r.fetch_body_hash,
         fetch_last_status = r.fetch_last_status,
         fetch_last_at = r.fetch_last_at,
         fetch_fail_streak = greatest(coalesce(r.fetch_fail_streak, s.fetch_fail_streak), 0),
         fetch_quarantined_until = case
           when r.fetch_quarantined_until is null then null
           else least(r.fetch_quarantined_until, pg_catalog.now() + interval '25 hours')
         end,
         fetch_newest_item_at = case
           when r.fetch_items_count is null then s.fetch_newest_item_at
           when r.fetch_newest_item_at is null then null
           else least(r.fetch_newest_item_at, pg_catalog.now() + interval '10 minutes')
         end,
         fetch_items_count = case
           when r.fetch_items_count is null then s.fetch_items_count
           else greatest(r.fetch_items_count, 0)
         end
    from pg_catalog.jsonb_to_recordset(p_rows) as r(
           id uuid,
           fetch_etag text,
           fetch_last_modified text,
           fetch_body_hash text,
           fetch_last_status int,
           fetch_last_at timestamptz,
           fetch_fail_streak int,
           fetch_quarantined_until timestamptz,
           fetch_newest_item_at timestamptz,
           fetch_items_count int
         )
   where s.id = r.id;
  get diagnostics v_changed = row_count;
  return v_changed;
end;
$$;

comment on function public.ingest_set_source_fetch_state(jsonb) is
  'Batched writer for sources.fetch_* called by the ingest Edge Function '
  '(migration 041, extended in migration 074 with the two feed-quarantine columns and '
  'in migration 119 with the two feed-freshness columns): one set-based write per flush from '
  'jsonb_to_recordset. p_rows: [{id, fetch_etag, fetch_last_modified, fetch_body_hash, '
  'fetch_last_status, fetch_last_at, fetch_fail_streak, fetch_quarantined_until, '
  'fetch_newest_item_at, fetch_items_count}]. A row that omits fetch_fail_streak or '
  'fetch_quarantined_until (a pre-074 caller) keeps the stored streak via coalesce, and '
  'the CASE around fetch_quarantined_until avoids `least(null, x) = x`, which would '
  'otherwise un-quarantine every healthy feed on a partial payload. The same CASE '
  'discipline guards the 119 pair: a row without fetch_items_count (a 304, a failure, a '
  'pre-119 caller) keeps both stored values, a row with a count but no fetch_newest_item_at '
  'stores NULL (an undated feed is never fresh), a date is clamped to now() + 10 minutes, '
  'and a negative count is stored as 0. Returns rows updated.';

revoke execute on function public.ingest_set_source_fetch_state(jsonb)
  from anon, authenticated, public;
grant execute on function public.ingest_set_source_fetch_state(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- (3) ops_health_report(): 115's body, row 13 now names the reason of each
-- silent source. Rows 1-12 are byte-identical to 115 (comments included).
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

  return;
end
$fn$;

comment on function public.ops_health_report() is
  'Read-only ops heartbeat (migrations 077, 100, 103, 108, 114, 115, 119): 13 fixed rows, in this order --'
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
  ' source never measured included)).'
  ' status is one of pass|warn|fail|unknown|skip, and threshold is the fail limit'
  ' (or the warn limit for warn-only checks). Never writes any table, and'
  ' never reads any potentially secret-bearing pg_cron job field. Polled by'
  ' .github/workflows/ops-heartbeat.yml over PostgREST every 30 minutes.'
  ' service_role only. See docs/ops-heartbeat.md.';

revoke all on function public.ops_health_report() from public, anon, authenticated;
grant execute on function public.ops_health_report() to service_role;

-- Ledger ---------------------------------------------------------------------------

insert into supabase_migrations.schema_migrations (version, name)
  values ('119', '119_feed_freshness')
  on conflict do nothing;

commit;
