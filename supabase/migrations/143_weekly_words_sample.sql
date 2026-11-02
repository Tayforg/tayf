-- 143_weekly_words_sample.sql
--
-- A tiny table that holds, per Istanbul day and Medya DNA zone, the 300-article sample behind the
-- /hafta "Ayrisan Kelimeler" section, refreshed hourly (h14-perf-1). public.weekly_words_sample_refresh
-- (p_days) rebuilds the newest p_days days, the pg_cron job weekly-words-sample calls it at minute 38
-- of every hour, and src/lib/weekly/distinctive-words-query.ts reads the table in at most 8 requests
-- instead of 21 article scans. Service role only; no index is added to any large table.
--
-- WHY (evidence: production, read-only, 2026-11-01 and 2026-11-02)
--   * /hafta fills its distinctive-words cache with 21 reads (3 zones x 7 days), each
--     `articles where source_id in (<zone ids>) and created_at in [day) order by id limit 300`.
--     Every read walks the whole day through idx_articles_created_at and sorts by id to keep 300.
--     The wave AL gate build logged `[weekly-words] error: ... exceeding 4000 ms` during prerender
--     (2026-11-01): a cold fill can pass the 4 s reader cap (READER_TIMEOUT_MS). A bounded pool of 4
--     (#155) cannot reduce the pages a cold fill has to read.
--   * A single-statement sampling RPC was measured and rejected: 4.7 s to more than 8 s cold, for the
--     same reason (one statement still reads seven days of articles).
--   * The sample changes slowly: a day that is over never changes (article ids and created_at are
--     fixed at insert), and today grows by a few hundred rows an hour. Precomputing it once an hour
--     moves the scan out of the request path. The reader keeps the pooled article reads as a
--     fallback for any day the table has no row for, so nothing depends on the table being filled.
--
-- WHAT CHANGES (pinned by tests/migrations/143-weekly-words-sample.test.ts,
-- src/lib/weekly/distinctive-words-query.test.ts and its .cache.test.ts)
--   1. public.weekly_words_sample (day date, zone text check in the three Medya DNA zones, article_id
--      uuid, source_id uuid, title text, url text, created_at timestamptz; primary key (day, zone,
--      article_id)). There is deliberately NO foreign key on article_id: an FK would make every
--      DELETE on public.articles probe this table (it has no article_id index). The price is that
--      a row outlives its article, so the refresh function carries an orphan sweep (3 below) and
--      the 35-day retention removes the rest. url and source_id are kept because the builder needs both: the
--      source spread per term and the example links; without them the output would change.
--   2. RLS on, no policy. Every privilege of anon, authenticated and public is revoked, the Supabase
--      default grants of service_role are replaced by SELECT only (the refresh function is SECURITY
--      DEFINER and writes as its owner), plus the PG17-guarded MAINTAIN revoke (140's block).
--      Nothing is granted to anon or authenticated, so tests/guards/anon-surface.test.ts is unaffected.
--   3. public.weekly_words_sample_refresh(p_days integer default 2) returns integer: security definer,
--      search_path = '', lock_timeout 5 s, volatile. p_days is clamped to 1..14 (null means 2). A
--      transaction-level advisory try-lock keeps runs from overlapping. For each of the newest p_days
--      Istanbul days (today is day 1) it deletes the day, then inserts, per zone, the 300 articles with
--      the smallest id: created_at in [day 00:00, next day 00:00) Europe/Istanbul, source active, kind
--      in ('outlet', 'wire'), bias mapped by the zone map (verbatim BIAS_TO_ZONE, parity-tested).
--      After the loop, an orphan sweep deletes the rows of the page window (day >= v_today - 6,
--      i.e. today and the 6 days before it, the days /hafta reads) whose article no longer exists:
--        delete from public.weekly_words_sample w where w.day >= v_today - 6
--           and not exists (select 1 from public.articles a where a.id = w.article_id);
--      Why: there is no FK, and the hourly job rewrites only today and yesterday, so without the
--      sweep the copy of a deleted article (a takedown or court access-ban request, the admin
--      "delete all articles" action, a retention policy) would stay on /hafta as an example
--      headline and link for up to about 6 days plus the 6 h cache, where before 143 a deletion
--      left /hafta within one cache lifetime. The sweep costs one articles_pkey lookup per row,
--      at most 6,300 an hour, and adds no index. Rows older than today minus 35 days are deleted.
--      It returns the rows written (the sweep is not counted). EXECUTE: revoked from
--      public, anon and authenticated; granted to service_role only.
--      The sample is the 300 smallest ids because ids are uuid v4 from gen_random_uuid(), so the
--      smallest ids are a uniform random sample, and Postgres uuid order equals the lowercase-hex
--      string order the old PostgREST `order by id limit 300` and the builder's own id sort use.
--      English-outlet, empty-title and horoscope rows stay IN the sample; the builder drops them
--      later, exactly as before.
--   4. pg_cron job weekly-words-sample, '38 * * * *', body
--      set statement_timeout = '120s'; select public.weekly_words_sample_refresh(2);
--      Scheduled by name: an existing job of that name is unscheduled first, no other job is touched,
--      and without pg_cron the block raises a notice and skips. Minute 38 on purpose, NOT 35: :35
--      already holds cron-log-compact ('35 * * * *', 101, up to 90 s) and clusters-vacuum ('35 */6',
--      084). :38 also avoids :25 trends-rollup-refresh, :15/:45 articles-vacuum, :17
--      image-backfill-requeue, :19 source-clickbait-rollup, the :x0/:x3/:x4/:x7 ticks and :43
--      jev-unlink-triage. The only job that shares the minute is kap-drain ('*/2 * * * *'), a cheap
--      queue drain that fires on every even minute and cannot be avoided from an even minute.
--   5. notify pgrst 'reload schema' (the reader reads the table through PostgREST) and the ledger
--      row in the 095 pattern.
--   The app change (src/lib/weekly/distinctive-words-query.ts) reads the table and keeps the pooled
--   article reads as the fallback; buildWeeklyDistinctiveWords is untouched.
--
--   Documented differences from the old rolling 24 h slices:
--     (1) The windows move from rolling 24 h slices anchored at the moment of the fill to
--         Istanbul calendar days: today (partial) plus the 6 previous days.
--         /hafta still says "Son 7 gün".
--     (2) Source eligibility (active, kind, bias mapped) is evaluated at refresh time. The builder
--         re-filters with the live sources list, so a source switched off since the refresh still
--         drops out; a source switched ON since then shows up from the next refresh.
--     (3) Today's rows lag up to 1 h (the job runs hourly).
--
-- EXPECTED SIZE
--   * At most 3 zones x 300 rows x 36 days (today plus the 35 retained) = 32,400 rows, about 300 B a
--     row: about 10 MB of heap plus about 1.5 MB of primary key, about 12 MB in the worst case.
--     (Measured on the throwaway PG15 with 32,400 synthetic rows and ~25-byte titles: 6,744 kB.)
--   * About 2.5 MB right after the 8-day backfill (8 x 900 rows at most).
--   * Hourly churn is at most 1,800 rows (today and yesterday are rewritten each hour), handled by
--     default autovacuum; no vacuum job is needed for a table this size. The orphan sweep reads at
--     most 6,300 rows of this table and probes articles_pkey once per row; it deletes nothing
--     unless an article was removed.
--   * No index on any large table. The only index is the primary key of the new table.
--   * The DB is about 6.3 GB with a founder retention decision pending; this table is 0.2 % of it.
--
-- STEP 0 (production, read-only, 2026-11-02 about 00:30 UTC, SELECT only via sbq; nothing applied)
--   a) Ledger: select version from supabase_migrations.schema_migrations where version in
--      ('141','142','143') -> 141 and 142 (143 is free).
--   b) select to_regclass('public.weekly_words_sample'), to_regprocedure('public.weekly_words_sample_refresh(integer)')
--      -> null, null.
--   c) select jobname, schedule from cron.job order by schedule -> 41 jobs; weekly-words-sample is
--      absent and nothing sits at minute 38 (only the */2 kap-drain fires on it, see above).
--   d) EXPLAIN (ANALYZE, BUFFERS) of the function's inner SELECT alone (no insert) for yesterday's
--      Istanbul day, 2026-11-01 (the zone map as a VALUES list, row_number() over (partition by zone
--      order by id) <= 300):
--        Subquery Scan on x  (actual time=77.309..78.905 rows=900 loops=1)
--          Buffers: shared hit=4933 read=73 dirtied=3
--          ->  WindowAgg  (actual rows=900)   Run Condition: (row_number() OVER (?) <= 300)
--                ->  Sort  (actual rows=5498)  Sort Key: zone, a.id  Sort Method: quicksort  Memory: 1529kB
--                      ->  Hash Join  (actual rows=5498)  Hash Cond: (s.bias = "*VALUES*".column1)
--                            ->  Hash Join  Hash Cond: (a.source_id = s.id)
--                                  ->  Index Scan using idx_articles_created_at on articles a  (actual rows=7120)
--                                        Index Cond: created_at >= '2026-10-31 21:00:00+00' and < '2026-11-01 21:00:00+00'
--                                        Buffers: shared hit=4898 read=73 dirtied=3
--                                  ->  Hash on Seq Scan on sources s (actual rows=96)  Filter: active and kind in (outlet, wire)
--        Planning Time: 3.277 ms
--        Execution Time: 79.325 ms
--      Rows per zone before the 300 cut: iktidar 2,710, bagimsiz 1,308, muhalefet 1,480 (all above 300).
--      The same statement for the oldest day of the window, 2026-10-27 (cold): Index Scan using
--      idx_articles_created_at, 11,098 rows in range, Buffers: shared hit=2609 read=3566, 900 rows out
--      after 1,713.9 ms. So the hourly refresh of two days costs well under 3 s, and an 8-day backfill
--      about 14 s cold, far inside the 120 s statement_timeout of the job.
--
-- DRY RUNS (x2) (local PG15.12, throwaway cluster scratchpad/pg-ap-143 on 127.0.0.1:55643, 2026-11-02;
-- the shared stub schema (jevtest/qa/stub.sql: roles anon, authenticated, service_role,
-- supabase_migrations.schema_migrations, public.sources/articles) plus, added in a scratch setup and
-- not in this file: articles.created_at, usage on schema public for the three roles, default
-- privileges and grants that mimic Supabase's pre-117 (all on tables, sequences and functions to anon,
-- authenticated, service_role), `alter role service_role bypassrls` as Supabase has it, and the ledger
-- row '142'). Each run was psql -v ON_ERROR_STOP=1 -f 143_weekly_words_sample.sql:
--   run 1   BEGIN, SET, CREATE TABLE, COMMENT, ALTER TABLE, REVOKE, REVOKE, GRANT, DO, CREATE FUNCTION,
--           COMMENT, REVOKE, GRANT, NOTICE `143: pg_cron missing, skipping the weekly-words-sample
--           schedule.`, DO, NOTIFY, INSERT 0 1, COMMIT
--   run 2   the same statements, no error; notice `relation "weekly_words_sample" already exists,
--           skipping`; the same pg_cron notice; the ledger insert is INSERT 0 0
--   With a fake cron schema (cron.job, cron.schedule, cron.unschedule and a pg_extension row, holding
--   other-job '*/7 * * * *', image-drain '*/5 * * * *' and a drifted weekly-words-sample '5 5 * * *'):
--   apply 1 = no notice, apply 2 = the same plus `already exists, skipping`, ledger INSERT 0 0; after
--   both, cron.job holds exactly one weekly-words-sample at '38 * * * *' with the command
--   ` set statement_timeout = '120s'; select public.weekly_words_sample_refresh(2); ` (the drifted job
--   was unscheduled first), and other-job and image-drain are unchanged.
--   After   ledger 142, 143 (143_weekly_words_sample); columns day date, zone text, article_id uuid,
--           source_id uuid (all not null), title text, url text, created_at timestamptz not null;
--           constraints weekly_words_sample_pkey (day, zone, article_id) and
--           weekly_words_sample_zone_check, no foreign key; one index (the pkey); relrowsecurity t,
--           no policy; relacl {postgres=arwdDxt/postgres,service_role=r/postgres}.
--   Grants  has_table_privilege: anon and authenticated false for select, insert, update, delete,
--           truncate, references, trigger; service_role true for select only. As anon and as
--           authenticated: `permission denied for table weekly_words_sample` on select, and
--           `permission denied for function weekly_words_sample_refresh` on the function. As
--           service_role: select works, insert/update/delete/truncate fail with `permission denied for
--           table weekly_words_sample`, the function runs (it writes as its owner). proacl
--           {postgres=X/postgres,service_role=X/postgres}; prosecdef t, provolatile v, proconfig
--           search_path="" and lock_timeout=5s.
--   Data    Seeded: sources iktidar/bagimsiz(wire)/muhalefet, a niche one and an inactive one; articles
--           over three Istanbul days with 20:59:59Z / 21:00:00Z boundary rows; yesterday holds 350 rows
--           for iktidar, 120 for bagimsiz, 300 for muhalefet, plus 30 niche and 30 inactive rows.
--           refresh(3) -> 962; run again -> 962 and identical contents (the table `except` the first
--           copy and the copy `except` the table are both empty).
--           Cells: iktidar 41/300/41, bagimsiz 40/120/40, muhalefet 40/300/40 (T-2/T-1/today); each cell
--           holds exactly the 300 smallest ids (compared with an independent UTC-range query on all 9
--           cells). Niche and inactive sources: 0 rows. Boundaries: 20:59:59Z before the Istanbul day
--           opened -> the day before; 21:00:00Z -> the new day; the last second of the day -> that day.
--           A manually inserted day-36 row was deleted, a day-35 row kept. Clamp: refresh(0) -> 1 day,
--           (null) -> 2 days, (1) -> 1, (100) -> 14.
--   Plan    EXPLAIN (ANALYZE, BUFFERS) of the reader query (day between today-6 and today, order by day,
--           zone, article_id, limit 1000) on 32,400 seeded rows (36 days x 3 zones x 300): first page
--           Index Scan using weekly_words_sample_pkey, 1,012 buffers, Execution Time: 0.140 ms; a late
--           page (offset 5000) Bitmap Index Scan on weekly_words_sample_pkey plus a 6,300-row sort,
--           3.429 ms. Total size 6,744 kB.
--   Orphan sweep (added after review; same local PG15.12, throwaway cluster scratchpad/pg-ap-143fix on
--   127.0.0.1:55645, 2026-11-02), a clean database each time:
--     run 1   the statements above, ledger INSERT 0 1; run 2 the same, `already exists, skipping`,
--             ledger INSERT 0 0; ledger 142, 143.
--     Plan    1.5M synthetic articles (articles_pkey and idx_articles_created_at only), 4,200 sample
--             rows: EXPLAIN (ANALYZE, BUFFERS) of the sweep -> Nested Loop Anti Join over a Seq Scan on
--             weekly_words_sample (2,100 rows in the window) and an Index Scan using articles_pkey
--             (loops=2100), Buffers: shared hit=8460, Execution Time: 3.352 ms; the whole
--             weekly_words_sample_refresh(2) took 42 to 51 ms (it rewrote 600 rows).
--     Data    Live test: after refresh(11), the articles of today, T-1, T-4 and T-6 (inside the page
--             window) and of T-7 and T-9 (outside it) were deleted, then refresh(1), which rewrites
--             today only, ran: the rows of T-1, T-4 and T-6 were swept, today was rewritten (the
--             deleted article gone, a second one kept), T-2, T-3 and T-5 stayed, and the rows of T-7
--             and T-9 stayed for the 35-day retention. On the 1.5M-article database, five sample
--             rows of T-4 whose articles were deleted: before 5, after 0 (refresh(1)). Against the
--             function without the sweep the same live test fails (the rows stay).
--   Test counts: tests/migrations/143-weekly-words-sample.test.ts, 74 static contract tests pass; with
--   TAYF_PSQL pointing at the dry-run database its 10 live tests pass too.
--
-- DEPLOY: APPLY 143, BACKFILL ONCE, THEN (OR BEFORE) THE APP
--   1. Apply this file (docs/migration-guide.md, operator). It creates one table, one function and one
--      cron job, takes no lock on an existing table, and does not rewrite data. The first run of the
--      job is at the next :38, and it fills today and yesterday.
--   2. Backfill the rest of the week once, outside a transaction block, with a raised timeout (a cold
--      8-day pass is about 14 s, longer than a SQL editor's default):
--        set statement_timeout = '120s'; select public.weekly_words_sample_refresh(8);
--      It returns at most 7,200 rows. Skipping it is safe: the hourly job rewrites today and yesterday,
--      so every day of the window has rows within 7 days, and until then the reader reads each missing
--      day from public.articles (3 pooled reads per missing day).
--   3. Deploy the app. The order does not matter: until 143 is applied (and PostgREST has reloaded its
--      schema cache) the reader gets PGRST205 or 42P01, logs one warning
--      (`[weekly-words] weekly_words_sample is not available (PGRST205); reading the articles directly`)
--      and uses the pooled article reads for every day, exactly the old path with Istanbul-day windows.
--      The words stay cached for 6 h (weekly-words profile); revalidateTag('weekly-words') by hand
--      shows the new path at once.
--
-- VERIFY (read-only):
--   select to_regclass('public.weekly_words_sample');                      -- expect the table
--   select jobname, schedule from cron.job where jobname = 'weekly-words-sample';  -- one row, 38 * * * *
--   select has_table_privilege('anon', 'public.weekly_words_sample', 'select'),
--          has_table_privilege('authenticated', 'public.weekly_words_sample', 'select'),
--          has_table_privilege('service_role', 'public.weekly_words_sample', 'select'),
--          has_table_privilege('service_role', 'public.weekly_words_sample', 'insert');
--      -- expect f, f, t, f
--   select has_function_privilege('anon', 'public.weekly_words_sample_refresh(integer)', 'execute'),
--          has_function_privilege('authenticated', 'public.weekly_words_sample_refresh(integer)', 'execute'),
--          has_function_privilege('service_role', 'public.weekly_words_sample_refresh(integer)', 'execute');
--      -- expect f, f, t
--   after the first :38 tick:
--   select status, return_message, start_time from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'weekly-words-sample')
--    order by start_time desc limit 3;                                     -- succeeded
--   select day, zone, count(*) from public.weekly_words_sample group by 1, 2 order by 1 desc, 2;
--      -- 300 per cell for past days (today may hold fewer); after the backfill 8 days x 3 zones
--   select pg_size_pretty(pg_total_relation_size('public.weekly_words_sample'));  -- a few MB, never above ~12 MB
--
-- TAKEDOWN (operator): after deleting an article for a takedown or an access ban
--   The hourly orphan sweep removes the sample copy of a deleted article at the next :38 tick, and
--   the cached words live 6 h. To remove it from /hafta right away, delete the copy yourself, then
--   drop the cache tag:
--     delete from public.weekly_words_sample where article_id = '<id>';
--     POST /api/revalidate {"tags":["weekly-words"]} with Authorization: Bearer $CRON_SECRET
--   (weekly-words is the tag src/lib/weekly/distinctive-words-query.ts caches under, and it is on
--   the route's allowlist.)
--
-- ROLLBACK (nothing else depends on 143; run by the operator)
--   select cron.unschedule('weekly-words-sample');
--   drop function public.weekly_words_sample_refresh(integer);
--   drop table public.weekly_words_sample;
--   delete from supabase_migrations.schema_migrations where version = '143';
--   The reader tolerates the missing table (one warning per fill, then the pooled article reads);
--   revert the app only if you want the warning gone.
--
-- Additive. Safe to re-apply (create table if not exists, create or replace function,
-- unschedule-if-exists then schedule, ledger insert on conflict do nothing; the revokes, the grants
-- and the RLS switch are idempotent). One transaction. No change to an existing object, no index, no
-- trigger, no data rewrite, no write outside public.weekly_words_sample. No grant to anon or
-- authenticated.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. public.weekly_words_sample: per (Istanbul day, zone) the 300 smallest article ids.
-- ---------------------------------------------------------------------------

create table if not exists public.weekly_words_sample (
  day date not null,
  zone text not null check (zone in ('iktidar', 'bagimsiz', 'muhalefet')),
  article_id uuid not null,   -- deliberately NO FK: an FK would make every articles DELETE probe this table (no article_id index); retention removes stale rows
  source_id uuid not null,
  title text,
  url text,
  created_at timestamptz not null,
  primary key (day, zone, article_id)
);

comment on table public.weekly_words_sample is
  'Precomputed sample behind the /hafta "Ayrisan Kelimeler" section (migration 143): '
  'per Istanbul calendar day and Medya DNA zone, the 300 articles with the smallest '
  'id (uuid v4, so a uniform random sample) among the articles of active outlet and '
  'wire sources whose bias the zone map knows. Rewritten hourly by '
  'weekly_words_sample_refresh (pg_cron job weekly-words-sample), today plus the 35 '
  'days before it are kept. article_id has no foreign key on purpose; the refresh '
  'deletes the rows of the last 7 days whose article no longer exists. The reader '
  '(src/lib/weekly/distinctive-words-query.ts) falls back to the articles table for '
  'a day this table has no row for. service_role only.';

alter table public.weekly_words_sample enable row level security;

-- Supabase default privileges hand new tables to anon/authenticated (incl.
-- write privileges, cf. 091/095) and to service_role (all): strip them, then
-- give service_role back the read the /hafta reader needs. The refresh function
-- is SECURITY DEFINER and writes as its owner.
revoke all on public.weekly_words_sample from anon, authenticated, public;
revoke all on public.weekly_words_sample from service_role;
grant select on public.weekly_words_sample to service_role;

-- PG17 added the MAINTAIN privilege; it does not exist before PG17 (revoking it
-- would be a syntax error), so guard.
do $maint$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on public.weekly_words_sample from anon, authenticated';
  end if;
end
$maint$;

-- ---------------------------------------------------------------------------
-- 2. public.weekly_words_sample_refresh(p_days): rebuild the newest p_days days.
-- ---------------------------------------------------------------------------

create or replace function public.weekly_words_sample_refresh(p_days integer default 2)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '5s'
as $fn$
declare
  v_days  integer := least(greatest(coalesce(p_days, 2), 1), 14);
  v_today date    := (pg_catalog.now() at time zone 'Europe/Istanbul')::date;
  v_day   date;
  v_n     integer;
  v_total integer := 0;
begin
  -- One refresh at a time: a slow run must not be doubled up by the next tick.
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('weekly_words_sample_refresh')) then
    raise notice 'weekly_words_sample_refresh: busy, skipping';
    return 0;
  end if;

  for i in 0 .. v_days - 1 loop
    v_day := v_today - i;

    delete from public.weekly_words_sample where day = v_day;

    with zmap(bias_key, zone) as (values   -- verbatim BIAS_TO_ZONE; parity-tested by the 143 test
        ('pro_government','iktidar'),('gov_leaning','iktidar'),('state_media','iktidar'),
        ('islamist_conservative','iktidar'),('nationalist','iktidar'),
        ('center','bagimsiz'),('international','bagimsiz'),('pro_kurdish','bagimsiz'),
        ('opposition_leaning','muhalefet'),('opposition','muhalefet'))
    insert into public.weekly_words_sample (day, zone, article_id, source_id, title, url, created_at)
    select v_day, x.zone, x.id, x.source_id, x.title, x.url, x.created_at from (
      select a.id, a.source_id, a.title, a.url, a.created_at, z.zone,
             pg_catalog.row_number() over (partition by z.zone order by a.id) as rn
        from public.articles a
        join public.sources s on s.id = a.source_id
        join zmap z on z.bias_key = s.bias
       -- The Istanbul calendar day, via explicit Europe/Istanbul casts (a bare
       -- v_day::timestamptz would use the session TimeZone, UTC on prod).
       where a.created_at >= (v_day::timestamp at time zone 'Europe/Istanbul')
         and a.created_at <  ((v_day + 1)::timestamp at time zone 'Europe/Istanbul')
         and s.active
         and s.kind in ('outlet', 'wire')) x
     where x.rn <= 300;

    get diagnostics v_n = row_count;
    v_total := v_total + v_n;
  end loop;

  -- Orphan sweep. The table has no foreign key on article_id, and the loop above rebuilds only the
  -- newest p_days days (today and yesterday on the hourly job), so a day that is further back keeps
  -- its copy of an article that has since been deleted (takedown, admin nuke, retention) and /hafta
  -- would go on showing that title and link for days. Drop those rows for every day the page reads
  -- (today and the 6 days before it). One primary-key lookup on articles per row, at most
  -- 3 zones x 300 rows x 7 days = 6,300 an hour; no index, and not counted in the rows written.
  delete from public.weekly_words_sample w
   where w.day >= v_today - 6
     and not exists (select 1 from public.articles a where a.id = w.article_id);

  delete from public.weekly_words_sample where day < v_today - 35;

  return v_total;
end;
$fn$;

comment on function public.weekly_words_sample_refresh(integer) is
  'Rebuilds the newest p_days Istanbul days (clamped to 1..14, null means 2, today '
  'counts as day 1) of public.weekly_words_sample (migration 143): per day and zone '
  'the 300 articles with the smallest id among the articles created inside the '
  'Istanbul calendar day whose source is active, of kind outlet or wire, and has a '
  'bias the zone map knows. Delete-then-insert per day inside one transaction, an '
  'advisory try-lock so runs never overlap, rows of the last 7 days whose article no '
  'longer exists are dropped (orphan sweep), and rows older than today minus 35 days '
  'are dropped. Returns the number of rows written. Run hourly at minute 38 by the '
  'weekly-words-sample cron job. service_role only.';

revoke all on function public.weekly_words_sample_refresh(integer) from public, anon, authenticated;
grant execute on function public.weekly_words_sample_refresh(integer) to service_role;

-- ---------------------------------------------------------------------------
-- 3. pg_cron: weekly-words-sample (hourly at minute 38). Scheduled by name; an
-- existing job of that name is unscheduled first; no other job is touched.
-- ---------------------------------------------------------------------------

do $cron$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    raise notice '143: pg_cron missing, skipping the weekly-words-sample schedule.';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'weekly-words-sample') then
    perform cron.unschedule('weekly-words-sample');
  end if;

  perform cron.schedule('weekly-words-sample', '38 * * * *',
    $sql$ set statement_timeout = '120s'; select public.weekly_words_sample_refresh(2); $sql$);
end
$cron$;

-- 4. Schema cache and ledger ----------------------------------------------------

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('143', '143_weekly_words_sample')
  on conflict do nothing;

commit;
