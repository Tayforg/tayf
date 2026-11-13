-- 212_feed_window_overflow.sql
--
-- h174-latency-1. Ingest records when a feed's window overflowed, and the source pages say so. This is
-- detection and disclosure only: the items that fell off a feed's window stay lost, and recovering them (for
-- example extra category feed urls for haberport) is a founder registry decision named as a follow-up in the PR body.
--
-- WHY (evidence: production, read-only, 2026-11-13)
--   haberport's feed (rss_url https://www.haberport.com/rss/latest-posts) holds its 50 newest items and changes once an
--   hour (every batch's newest pubDate is :00-:02). On weekdays more than 50 items appear in that hour, so what is
--   beyond the 50 newest is never offered to Tayf. The article url's numeric id is dense (Sunday 11-08: 467 ingested of
--   an id span of 473), and on weekdays 11-10..11-12 612 of 2,311 ids are missing (26.5%). Every poll that brought
--   exactly 50 rows came after an id gap (50, 18, 20, 38, 10, 8, 10) and every poll with fewer than 50 rows had gap 0.
--   Tayf polls every 3 minutes and cannot catch up inside an hour. Nothing recorded the loss: sources.fetch_items_count
--   only feeds freshness and the bootstrap (119), and /source/haberport prints "Yayın sıklığı 518,4 haber/gün" as the
--   outlet's publishing rate, about 21% below the id-span rate. The stored-url lookup of ingest already knows when
--   none of a full window's items was stored before, and it used to record nothing.
--
-- WHAT CHANGES (additive: two nullable columns and one re-created function, no backfill, no data rewrite)
--   1. public.sources.fetch_window_overflow_at timestamptz, nullable, no default: the last time a poll found a feed
--      window of 10 items or more with none of its items stored before (NULL = never). Written by ingest only when a
--      poll overflowed.
--   2. public.ingest_cycles.window_overflows integer, nullable, no default: how many feeds overflowed in a cycle.
--   3. public.ingest_set_source_fetch_state(jsonb) is re-created: the LIVE body (119's, see STEP 0) character for
--      character, with exactly two edits: one more jsonb_to_recordset column (fetch_window_overflow_at timestamptz) and
--      one more assignment, fetch_window_overflow_at = coalesce(r.fetch_window_overflow_at, s.fetch_window_overflow_at).
--      The coalesce keeps the stored time for every row that omits the key (a normal poll, a bootstrap, a 304, a
--      failure), so only an overflow poll moves it. Same signature, same volatility, SECURITY DEFINER, search_path = '',
--      same revoke and grant.
--   Not touched: the 175 trigger sources_registry_changed_at_trg. Its WHEN clause lists 15 registry columns and no fetch_*
--   column, so the new write never moves registry_changed_at. No cron, no env, no registry row, no grant on a table or a
--   column (117 closed those: the column is not readable by anon).
--
-- STEP 0 (production, read-only, 2026-11-13): public.ingest_set_source_fetch_state(jsonb)
--   md5(prosrc) a3daf6ad35bc73ff340dd9980fee7381, length(prosrc) 1522, which is the body of 119_feed_freshness.sql
--   character for character (so the copy below is the live text, not an older one), prosecdef t, provolatile v,
--   proconfig {search_path=""}, proacl {postgres=X/postgres,service_role=X/postgres}. Ledger: no version 212, the newest
--   three-digit version is 211, and neither column exists yet on a 28-column public.sources (144 rows) or on ingest_cycles.
--   Triggers on public.sources: three, none touched.
--
-- UNKNOWN KEY (production, read-only SELECT, 2026-11-13): jsonb_to_recordset ignores a key the column list does not name.
--   select * from jsonb_to_recordset('[{"id":"11111111-1111-1111-1111-111111111111","fetch_etag":"x",
--   "fetch_window_overflow_at":"2026-11-13T07:03:00.000Z","not_a_column":1}]'::jsonb) as r(id uuid, fetch_etag text,
--   fetch_items_count int) returned one row, id and fetch_etag set and fetch_items_count null, no error. So the ingest
--   deploy that sends the new key is harmless while the OLD function is still live: the key is dropped and the other
--   columns are written as before. tests/migrations/212-feed-window-overflow.test.ts pins the body and the new column.
--
-- REPLAY (production, read-only, 2026-11-13, last 7 days of ingest data; a poll's rows share one created_at minute, so
--   a poll that brought almost the whole window as new rows (n >= fetch_items_count - 1, n >= 10) is the one 212 flags)
--   with b as (select s.slug, s.fetch_items_count fic, date_trunc('minute', a.created_at) m, count(*) n from articles a
--   join sources s on s.id = a.source_id where a.created_at > now() - interval '7 days' and s.fetch_items_count >= 10
--   group by 1,2,3) select slug, count(*) from b where n >= fic - 1 and n >= 10 group by 1 order by 2 desc:
--     haberport 47, haberler-com 3, sabah 2, ntv 1, gazete-oksijen 1.
--   haberport per day (polls flagged / polls with rows): Fri 11-06 8/17, Sat 6/21, Sun 11-08 1/22, Mon 8/19, Tue 8/19,
--   Wed 9/20, Thu 7/22, always between 06 and 15 UTC. The others, detail: haberler-com (feed of 250 items) three
--   batches of 249-250 rows after gaps of 1.5-2.3 hours, 09:00-10:45 UTC on 11-09, 11-10 and 11-12; sabah (feed of 10, the
--   floor) two batches of exactly 10 rows after gaps of about 9 hours at 04:06-04:09 UTC on 11-09 and 11-11; ntv (feed of
--   20, answering 403 with fail streak 24 now) one batch of 20 on 11-10 16:09 UTC with no other batch in the 7 days;
--   gazete-oksijen (feed of 50) one batch of 49 after 3.5 hours on 11-13 01:33 UTC. None of these is a bootstrap (every
--   source with a count is measured, and a NULL count is never flagged) and none follows a registry change (every row's
--   registry_changed_at is 175's apply time, 2026-11-08 11:56 UTC). Each is a feed whose window had moved past the last
--   stored item, after a quiet gap or an outage. A feed of exactly 10 items showing 10 new ones can also be exactly 10 new
--   items, so the floor of 10 over-reports at the very edge (sabah). A repoint of a source's rss_url (093-style) to a feed
--   of urls not stored yet would flag once for the next 7 days. After the deploy, select slug, fetch_window_overflow_at
--   from public.sources where fetch_window_overflow_at > now() - interval '1 day' should list haberport after a weekday
--   07-14 UTC window.
--
-- ORDER: APPLY 212 FIRST, THEN DEPLOY the ingest Edge Function (--no-verify-jwt) and the app (Vercel).
--   The reverse order is safe, only degraded, and nothing errors: ingest before 212 sends a key the old writer ignores
--   (see UNKNOWN KEY) and its ingest_cycles insert, which names window_overflows, is answered with a missing-column error
--   that names that column, so ingest retries once without it and keeps the 157 and 159 counters (no stamp lands and no
--   counter is written until 212 is applied). The app before 212 reads a column that is missing: /kaynaklar/durum retries
--   with the select that ran before 212 (119's freshness columns stay) and /source/[slug] retries once without the column,
--   so both pages render as they did, with no tag and no "en az". The pages catch up within the cache window
--   (source-directory, 1 h) of applying 212 and the first overflow poll.
--
-- VERIFY (read-only, after applying): md5(prosrc), length(prosrc) of 'public.ingest_set_source_fetch_state(jsonb)'::regprocedure
--   are b2305475cadda51d6c2d85b79d4d632e and 1673 (the body is the live one plus the two edits), prosecdef t, provolatile v, proconfig
--   {search_path=""}, proacl still {postgres=X/postgres,service_role=X/postgres}, has_function_privilege('anon', ..., 'execute')
--   and ('authenticated', ...) false; information_schema.columns lists fetch_window_overflow_at (timestamptz, YES, no default) on
--   sources and window_overflows (integer, YES, no default) on ingest_cycles; select version, name from
--   supabase_migrations.schema_migrations where version = '212' returns one row; max(registry_changed_at) of public.sources is
--   unchanged after an ingest cycle. After the ingest deploy and a weekday morning, the haberport row carries a
--   fetch_window_overflow_at and /source/haberport reads "en az ... haber/gün" with its note.
--
-- ROLLBACK (nothing else depends on 212; redeploy the previous ingest and the previous app first):
--   re-apply the create or replace function block of 119_feed_freshness.sql for ingest_set_source_fetch_state(jsonb), with its
--     comment, revoke and grant (that drops the key from the writer; the column then stays unused);
--   the columns may stay (nullable, unread). To drop them as well, only after the step above and both rollbacks:
--     alter table public.sources drop column if exists fetch_window_overflow_at;
--     alter table public.ingest_cycles drop column if exists window_overflows;
--   then remove ledger row 212 (run by the operator):
--     delete from supabase_migrations.schema_migrations where version = '212';
--
-- Additive. Safe to re-apply (add column if not exists, create or replace function, ledger insert on conflict do nothing).
-- One transaction. The only locks of note are the short ACCESS EXCLUSIVE ones that alter table takes, on public.ingest_cycles
-- first and on public.sources last, the same order public.ops_health_report() reads them, so the two cannot deadlock and
-- sources is held only for the function replace, the comments, notify and the ledger insert. The wait is bounded by
-- lock_timeout = 5 s: on 55P03 (busy table) or 40P01 (deadlock) nothing is recorded, re-apply. No CONCURRENTLY
-- step, no cron change, no new table, no index, no trigger, no grant, no backfill and no update of existing rows.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- (1) The two columns. Nullable, no default: NULL means "never seen" (sources) or "not recorded" (ingest_cycles). No
-- grant: the columns inherit 117's empty anon/authenticated table ACL. Lock order: public.ingest_cycles first, public.sources
-- last (see the header), the order public.ops_health_report() reads them, so the two cannot deadlock.
-- ---------------------------------------------------------------------------

alter table public.ingest_cycles
  add column if not exists window_overflows integer;

comment on column public.ingest_cycles.window_overflows is
  'Feeds whose poll found a window of 10 items or more with none of its items stored before (migration 212), one per feed per '
  'cycle. NULL on a row written before 212 or by an ingest that did not have the counter.';

alter table public.sources
  add column if not exists fetch_window_overflow_at timestamptz;

comment on column public.sources.fetch_window_overflow_at is
  'Last time ingest polled this feed and none of its items was stored before (migration 212): a poll of a window of 10 items '
  'or more whose urls were all new, so the feed had moved past the previous poll and some items were never offered to Tayf '
  '(haberport keeps its 50 newest items and is replaced hourly). NULL = never seen. Written by ingest_set_source_fetch_state '
  'only when a poll overflowed: a normal poll, a bootstrap, a 304 or a failure omits the key and the stored time is kept '
  '(coalesce). It is a time, not a count, and the lost items cannot be recovered from it. Read by /source/[slug] and '
  '/kaynaklar/durum, which treat it as recent for 7 days. Not a secret, and not readable by anon (117).';

-- ---------------------------------------------------------------------------
-- (2) ingest_set_source_fetch_state: the live body (119's, md5 a3daf6ad35bc73ff340dd9980fee7381, length 1522) with exactly
-- two edits: the new jsonb_to_recordset column and the coalesce assignment. Never a bare r.x: a row that omits the key
-- would write NULL and erase the last overflow time.
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
         end,
         fetch_window_overflow_at = coalesce(r.fetch_window_overflow_at, s.fetch_window_overflow_at)
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
           fetch_items_count int,
           fetch_window_overflow_at timestamptz
         )
   where s.id = r.id;
  get diagnostics v_changed = row_count;
  return v_changed;
end;
$$;

comment on function public.ingest_set_source_fetch_state(jsonb) is
  'Batched writer for sources.fetch_* called by the ingest Edge Function '
  '(migration 041, extended in migration 074 with the two feed-quarantine columns, in migration 119 with the two '
  'feed-freshness columns and in migration 212 with the feed-window-overflow time): one set-based write per flush from '
  'jsonb_to_recordset. p_rows: [{id, fetch_etag, fetch_last_modified, fetch_body_hash, '
  'fetch_last_status, fetch_last_at, fetch_fail_streak, fetch_quarantined_until, '
  'fetch_newest_item_at, fetch_items_count, fetch_window_overflow_at}]. A row that omits fetch_fail_streak or '
  'fetch_quarantined_until (a pre-074 caller) keeps the stored streak via coalesce, and '
  'the CASE around fetch_quarantined_until avoids `least(null, x) = x`, which would '
  'otherwise un-quarantine every healthy feed on a partial payload. The same CASE '
  'discipline guards the 119 pair: a row without fetch_items_count (a 304, a failure, a '
  'pre-119 caller) keeps both stored values, a row with a count but no fetch_newest_item_at '
  'stores NULL (an undated feed is never fresh), a date is clamped to now() + 10 minutes, '
  'and a negative count is stored as 0. The 212 key is written as coalesce(r.fetch_window_overflow_at, '
  's.fetch_window_overflow_at): a row without it (a normal poll, a bootstrap, a 304, a failure, a pre-212 caller) keeps '
  'the stored time and only an overflow poll moves it. A payload key the function does not name is ignored by '
  'jsonb_to_recordset, so ingest may be deployed before 212 is applied. Returns rows updated.';

revoke execute on function public.ingest_set_source_fetch_state(jsonb)
  from anon, authenticated, public;
grant execute on function public.ingest_set_source_fetch_state(jsonb) to service_role;

-- PostgREST caches the schema: the two new columns are written through the RPC and the insert of ingest_cycles.
notify pgrst, 'reload schema';

-- Ledger ---------------------------------------------------------------------------

insert into supabase_migrations.schema_migrations (version, name) values ('212', '212_feed_window_overflow') on conflict do nothing;

commit;
