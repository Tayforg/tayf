-- 113_source_article_key.sql
--
-- Stops a headline edit from creating a second article row. An outlet that
-- edits a headline publishes the same article under a new URL slug and keeps
-- the numeric id its CMS gave it (aksam: .../haber-1708664 before and after).
-- Ingest upserts on `url` and checks (source_id, content_hash), and both
-- change with the headline, so every edit became a second row that clusters
-- and counts as a second article of the same source.
--
-- This migration adds the storage and the lookup path only:
--   * articles.source_article_key (nullable text): the id taken from the url
--   * articles_source_article_key_idx: partial (source_id, source_article_key)
--   * public.source_article_key(text): the SQL twin of
--     supabase/functions/_shared/rss/article-key.ts (sourceArticleKey)
--   * public.articles_source_key_backfill(from, to): bounded operator backfill
-- The ingest Edge Function (this PR) reads the key at ingest, drops a re-polled
-- item whose key is already stored under a different url, and records the new
-- headline through the existing title-version path instead.
--
-- EVIDENCE: articles 1fe98b20 and 8f291028 (aksam, haber-1708664, published_at
-- 2026-10-23 17:16, created 17:18 and 17:27: "Bakan Güler'den Mekke İttifakı
-- vurgusu" and the same plus ": Husilerle çatışmaya girilmeyecek"). Recorded in
-- the task brief: 35 groups and 81 articles in 24 h on clustered politics
-- articles, every group split into separate rows, 28 of the 35 with the same
-- published_at, and 23 of 104 blindspot clusters containing such a pair.
--
-- STEP 0 (production, 2026-10-23, read-only SELECTs; PostgreSQL 17, no secrets)
--   (a) supabase_migrations.schema_migrations: the newest numeric version is
--       112 (112_trends_entity_rollup); 113 and 114 are not recorded.
--   (b) select tgname, pg_get_triggerdef(oid) from pg_trigger where tgrelid =
--       'public.articles'::regclass and not tgisinternal returns three
--       triggers: articles_cluster_enqueue (AFTER INSERT, WHEN category is
--       politika or son_dakika), articles_image_enqueue (AFTER INSERT, WHEN
--       image_url IS NULL) and articles_resolve_tickers (AFTER INSERT). There
--       is NO UPDATE trigger, so the backfill UPDATE enqueues nothing.
--       articles is 1850 MB with about 1.3 M rows; idx_articles_created_at
--       (created_at desc) exists, so a created_at window is an index range scan.
--   (c) Real URLs, 3 per slug from the last day (aksam, dunya, yeni-safak,
--       cnn-turk, anadolu-ajansi), are fixtures in tests/fixtures/
--       source-article-key-cases.ts. All five carry a trailing id and key
--       cleanly (aksam .../haber-1708701, aa .../4099137, cnnturk
--       ...-3483798, dunya ...-haberi-845066, yenisafak ...-4866822); none is
--       slug-only. dunya 845066 is a second headline-edit pair.
--   (d) Twin replay, 7 days, an inline SQL version of the algorithm below over
--       articles.created_at >= now() - 7 days: 63,011 rows of the 68 sources
--       that have at least one keyed url, 55,479 keyed urls, 1,353 keys with 2
--       or more urls (groups) covering 2,963 articles; group sizes 2:1144,
--       3:170, 4:33, 5:3, 6:3, max 6 urls per key (haber7, yeni-safak). 43
--       sources have a group. The all-category rate is higher than the
--       brief's politics-only count: 183 groups (406 articles) were created
--       wholly inside the last 24 h, 68 of those groups in politika or
--       son_dakika. 55% of groups carry one published_at for every url.
--       Per source (keyed urls / keys with 2+ urls / max urls per key), top 16
--       of 43:
--         haber7 2333/291/6   yenicag 2064/111/4   aksam 1888/70/3
--         gzt 1774/65/4       star 1646/64/4       anadolu-ajansi 1336/56/3
--         birgun 1371/54/5    yeni-safak 796/54/6  odatv 1054/52/4
--         posta 1206/51/3     cumhuriyet 2192/48/4 haber-global 1157/47/4
--         cnn-turk 1909/32/4  sozcu 1602/29/3      ekonomim 1484/29/4
--         haberturk 1399/29/3 dunya 838/29/3
--       and 27 more sources with 1 to 25 groups each (300 groups together).
--       Sample groups (title, published_at; later headlines in order):
--         aksam 1708664: "Bakan Güler'den Mekke İttifakı vurgusu" / "...:
--           Husilerle çatışmaya girilmeyecek", 2026-10-23 17:16
--         takvim 6533707: "İsralili yerleşimciler Batı Şeria'da 20 kuzuyu
--           katletti" / "İsrailli ...", 2026-10-17 09:14
--         isci-haber 274264: "İskenderun'da Çöp Sahaından Toplanan Bozuk Etler
--           Ele Geçirildi" / "...Sahasından...", 2026-10-23 06:31
--         dw-turkce 79691716: "Fransa'da protestolarda bin 200 gözaltı" /
--           "bin 800 gözaltı", 2026-10-18 08:44
--         muhalif 746388: "Zonguldak'ta maden ocağında grizu patlaması: 2 işçi
--           öldü, 5 yaralı" / "3 işçi hayatını kaybetti, 5 yaralı", 2026-10-23 08:27
--         trt-haber 960459: "İstanbul'da sele kapılan 3 kişi aranıyor" / "5 kişi
--           aranıyor" / "İstanbul Valisi Gül: Derenin ıslahıyla ilgili
--           çalışmalar başladı", 2026-10-18 09:09
--         abc-haber 874741: "Fenerbahçe'den elindeki maçı son dakikada verdi!
--           Sarı Kanarya 90 dakikada yıkıldı" / "...son dakika verdi! ... 90.
--           dakikada yıkıldı", 2026-10-20 18:51
--         star 2047188: four headlines for one speech ("tıp mirası" vurgusu ...
--           "38 bin personel ilanına çıkacağız"), 2026-10-17 11:55 .. 12:23
--         bloomberg-ht 3792331: "Petrol beş ayın zirvesinin ardından yatay
--           seyretti" / "Petrolde kritik seviye aşıldı", 2026-10-23 03:32
--         haber7 3670642: "Borsa güne yükselişle başladı" / "Borsa İstanbul'da
--           düşüş devam ediyor!" / "...yüzde 5'lik kayıp!", 2026-10-23 07:00 ..
--           13:27 (one CMS item reused as a rolling bulletin)
--       Reviewed every source's groups for "same story": all are one CMS item
--       whose headline was rewritten (sometimes completely, and rolling
--       bulletins keep the id while the story moves on) EXCEPT ONE:
--         daily-sabah 500000: "German industry lost nearly 500,000 jobs since
--           2019: Ifo" and "Funding shortfall forces WFP to cut food aid to
--           500,000 Gazans", 2026-10-19 09:46 and 12:45.
--       daily-sabah urls have no id: only 3 of its 418 urls contain a 6-digit
--       run, and every one is a number inside the slug. So the key is noise
--       there, and daily-sabah is excluded: ARTICLE_KEY_EXCLUDED_SLUGS in
--       supabase/functions/_shared/rss/article-key.ts, and the same list in
--       the WHERE clause of articles_source_key_backfill() below
--       (tests/migrations/113-source-article-key.test.ts compares the two).
--       The 7-day replay saw no group for the other slug-only sources (a-news
--       7 keyed of 546 urls, yeni-asir 2/669, evrensel 2/1199, ilke-tv 2/562,
--       elips-haber 1/986, euronews-turkce 1/415, dirilis-postasi 1/706, sabah
--       1/234, cgtn-turk 1/466, hukuki-haber 22/126, trt-world 57/275), but 7
--       days was too short. A 30-day replay (2026-10-23, same algorithm) found
--       a-news with 3 false groups: 100000 (Nor'easter outage 09-26, Tencent
--       chips 10-01, dengue deaths 10-11), 250000 (Yemen displacement vs a
--       school march in France) and 300000 (diesel supply vs revoked visas).
--       All are round numbers inside English slugs, and the Nor'easter and
--       Tencent rows are 4.6 days apart, inside the 7-day twin window, so the
--       Tencent article would have been dropped as a "twin". Only 18 of the
--       2,248 a-news urls in 30 days carry a 6-digit run: 13 slug numbers (11
--       round, 421000 and 874000) and 5 with a 10-digit epoch-like suffix that
--       no two urls ever shared. a-news is therefore excluded as well.
--       Every other slug-only source above (and every other source) had no
--       false group in the same 30 days.
--       The round-number guard covers the same defect for any outlet not on the
--       list yet: a digit run of one or two significant digits followed by at
--       least four zeros (100000, 250000, 1000000) is a quantity in a headline,
--       not an id, and is skipped like a date-shaped run (KEY_ROUND_RE in
--       article-key.ts, copied verbatim below). It costs a missed dedupe, never
--       a false merge, for the rare real id of that shape. Old rules (daily-
--       sabah excluded only) against the final rules over prod on 2026-10-23,
--       keyed urls / keys with 2+ urls / articles in those groups / sources
--       with a group: 7 days 55,478 / 1,352 / 2,961 / 42 against 55,469 /
--       1,352 / 2,961 / 42 (no real group lost); 30 days 234,845 / 5,371 /
--       11,827 / 51 against 234,820 / 5,367 / 11,819 / 50 (the 3 a-news groups
--       and birgun 740000, a rolling bulletin that shares a real id).
--   (e) Keyed rows, last 14 days (the backfill size): 112,602 of 144,094 rows
--       under the first rules; with the final rules (daily-sabah and a-news
--       excluded, round runs skipped) 112,578 of 144,086 on the re-run, oldest
--       created_at 2026-10-09 22:15 UTC. About 8,000 per day.
--   (f) ingest_cycles, last 3 days (1,329 cycles), percentile_disc(.5, .9,
--       .99) and max of `fetched`: p50 45, p90 55, p99 71, max 78; during
--       hours 06-08 UTC (135 cycles) p50 52, p90 68, p99 73, max 77. duration_ms averages 18.9 s (max 93.7 s; hours 06-08:
--       18.0 s, max 56.7 s). Complete days hold 417 to 456 cycles against 480
--       scheduled: the rest are cycles the platform killed on the CPU limit
--       (HTTP 546, reason CPUTime), which the parse budget in the same PR
--       addresses.
--
-- ALGORITHM (the SQL and the TS module are the same function)
--   1. Match '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*([^?#]*)' to get the path (a
--      regex, not a URL parser, so both sides run the identical expression).
--      A relative or unparseable url has no match: key NULL. The query string
--      and the fragment never reach the path.
--   2. Strip trailing slashes, take the LAST path segment, strip a file
--      extension (.html .htm .shtml .shtm .php .asp .aspx, any case).
--   3. Collect the maximal digit runs of that segment and keep the runs of 6 to
--      20 digits that are neither date-shaped (8, 10, 12 or 14 digits starting
--      like a 19xx/20xx date) nor round (one or two significant digits, then
--      at least four zeros: 100000, 250000, 1000000).
--   4. The key is the LAST kept run, as written.
--   Only the last segment counts: an id in a parent segment
--   (/kategori/123456/slug) is a section id, and keying on it would merge
--   different stories.
--
-- ORCHESTRATOR PRE-BUILD (run each standalone, outside a transaction, before applying 113)
-- The column and the index are created without blocking inserts into articles
-- (the ingest cycle writes it every 3 minutes). Run these two first, one per
-- statement, each outside any transaction block:
--
--   set lock_timeout = '5s'; alter table public.articles add column if not exists source_article_key text;
--   create index concurrently if not exists articles_source_article_key_idx on public.articles (source_id, source_article_key) where source_article_key is not null;
--
-- A failed or cancelled CONCURRENTLY build leaves an INVALID index behind, and
-- `create index if not exists` would then skip it silently. Check before
-- applying (expect 0 rows):
--
--   select c.relname from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid = i.indexrelid where c.relname = 'articles_source_article_key_idx' and not i.indisvalid;
--
-- 113 re-checks (indisvalid = false) and aborts, telling you to `drop index
-- concurrently articles_source_article_key_idx` and rebuild.
--
-- If the pre-build was skipped, do NOT rely on 113 to build the index. The
-- `alter table ... add column if not exists` takes ACCESS EXCLUSIVE on articles
-- before it checks whether the column exists (a no-op still takes it, verified
-- locally: a concurrent SELECT times out), and holds it until commit. A
-- non-concurrent `create index` in the same transaction would run under that
-- lock, so on the 1850 MB / 1.3 M-row table it blocks reads (the public site)
-- as well as writes (ingest) until the build ends or the 60 s statement_timeout
-- aborts it. So 113 fails closed: its first guard raises "run the ORCHESTRATOR
-- PRE-BUILD first" when the index does not exist and articles is over 64 MB
-- (pg_relation_size, catalog only; nothing is locked or changed). Below 64 MB,
-- a fresh dev or CI database, 113 adds the column and builds the index itself
-- in well under a second. With the pre-build done the transaction is
-- sub-second: the ALTER and the CREATE INDEX are no-ops that still queue for
-- their lock, and `set local lock_timeout = '5s'` bounds that wait (a long
-- reader ahead of the ALTER makes new readers queue behind it for at most 5 s,
-- then 113 aborts with 55P03 and nothing is recorded in the ledger; re-apply).
--
-- BACKFILL (operator, NOT inside the migration; idempotent and resumable). Run
-- it after applying 113 and BEFORE deploying the ingest function, so every row
-- the new ingest checks against already carries its key. One call per 2-day
-- slice, each its own statement so none risks the API timeout. One fixed
-- anchor T0 keeps the slices gapless:
--   T0=$(psql "$DATABASE_URL" -Atc "select now()")
--   for i in 14 12 10 8 6 4 2; do
--     psql -q "$DATABASE_URL" -Atc "set statement_timeout = '2min'; select public.articles_source_key_backfill('$T0'::timestamptz - interval '$i days', '$T0'::timestamptz - interval '$i days' + interval '2 days');"
--   done
-- Expect about 112,600 rows in total (about 16,000 per 2-day slice, the first
-- slices smaller). Verify:
--   select count(*) total, count(source_article_key) keyed, count(*) filter (where source_article_key is null) unkeyed from public.articles where created_at >= now() - interval '14 days';
-- Rows created between T0 and the ingest deploy have no key (the old ingest
-- does not write one). After the deploy, run one catch-up:
--   select public.articles_source_key_backfill('$T0'::timestamptz, now() + interval '1 hour');
-- Rows older than 14 days stay NULL: the lookup window is 7 days.
--
-- DEPLOY ORDER: pre-build, apply 113, backfill, THEN deploy the ingest
-- function (npx supabase functions deploy ingest --no-verify-jwt). An ingest
-- deployed before the column exists fails every upsert (unknown column).
--
-- DRY RUN (local PostgreSQL 15.12, throwaway cluster, the stub schema)
--   Stub: supabase stub.sql plus `alter table public.articles add column if not
--   exists created_at timestamptz not null default now()` (stub only).
--   * Pre-build, then 113, then 113 again (cluster A): the two pre-build
--     statements run standalone; the invalid-index check returns 0 rows; 113
--     commits twice with NOTICEs "column source_article_key ... already exists,
--     skipping" and "relation articles_source_article_key_idx already exists,
--     skipping" on both runs; one ledger row '113'; the column is text, nullable,
--     no default; the index is the partial btree (source_id, source_article_key)
--     where source_article_key is not null and indisvalid; each function exists
--     once, SECURITY DEFINER with search_path="" (source_article_key is
--     immutable); EXECUTE is held by service_role only (anon, authenticated and
--     public cannot call either).
--   * Fresh cluster B, no pre-build, small table: 113 applied twice. The first run adds the
--     column and builds the index; the second prints the same two skipping
--     NOTICEs; the same end state as above.
--   * Guard (a): with the index forced to indisvalid = false, 113 aborts at the
--     guard with the "drop index concurrently" message; nothing else ran.
--   * Guard (b), fail closed (re-run for the review fix): a database with
--     100,000 articles rows (97 MB by pg_relation_size) and no pre-build. 113
--     aborts at the guard with "public.articles is 97 MB and
--     articles_source_article_key_idx does not exist yet ... Run the
--     ORCHESTRATOR PRE-BUILD first"; no ledger row, no column, no function.
--     After the two pre-build statements 113 applies twice in 0.03 s each.
--     Lock check on the same server: a transaction that runs only the no-op
--     `alter table ... add column if not exists` makes a concurrent SELECT on
--     articles fail with a lock timeout, i.e. ACCESS EXCLUSIVE is taken before
--     the column check. On a small table without the index (the fresh cluster
--     above) the guard passes and 113 builds the index itself.
--   * Parity: 20,000 random urls (schemes, ports, empty hosts, 5 to 21 digit
--     runs, date runs, round runs, extensions, queries, fragments, repeated and
--     trailing slashes, newlines) through the TS module and through public.
--     source_article_key(): 0 differences (5,913 keyed, 14,087 NULL). The
--     fixture table (69 urls) passes the same way (tests/migrations/113-
--     source-article-key.test.ts with TAYF_PSQL set: all pass, including the
--     three guard cases).
--   * Backfill: 100,050 synthetic rows (5 sources of 20,000 plus 50 daily-sabah
--     rows): a 2-day slice of 43,250 rows keyed 43,200 in 1.2 s; the second
--     call returned 0; the daily-sabah rows stayed NULL (the live test also
--     checks a-news and a round id). It raises for a NULL
--     bound, an inverted window and a window longer than 2 days. All of that was
--     rolled back.
--
-- ROLLBACK (nothing depends on this until the new ingest is deployed):
--   1. Redeploy the previous ingest function (it does not read or write the
--      column).
--   2. drop function public.articles_source_key_backfill(timestamptz, timestamptz);
--   3. drop function public.source_article_key(text);
--   4. drop index concurrently if exists articles_source_article_key_idx;
--   5. alter table public.articles drop column if exists source_article_key;
--      (only after step 1: the new ingest writes the column on every upsert)
--   6. delete from supabase_migrations.schema_migrations where version = '113';
--
-- Safe to re-apply: add column if not exists, create index if not exists,
-- create or replace function, grants are idempotent, the ledger insert is
-- `on conflict do nothing`.
--
-- See docs/migration-guide.md (113) and tests/migrations/113-source-article-key.test.ts.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- 0. Guards, both before any DDL.
--    (a) A cancelled CREATE INDEX CONCURRENTLY leaves an INVALID index that
--        `create index if not exists` would silently accept.
--    (b) Fail closed on the skipped pre-build. `alter table ... add column if
--        not exists` takes ACCESS EXCLUSIVE on articles before it looks at the
--        column, and holds it until commit; the non-concurrent `create index`
--        below would then run under that lock and block every read and write
--        of articles for the whole build. On a table over 64 MB with no index
--        yet, refuse. A small table (a fresh dev or CI database) is built in
--        the transaction as before.

do $guard$
declare
  v_bad  text;
  v_size bigint;
begin
  select pg_catalog.string_agg(c.relname::text, ', ' order by c.relname)
    into v_bad
    from pg_catalog.pg_index i
    join pg_catalog.pg_class c on c.oid = i.indexrelid
   where c.relnamespace = 'public'::regnamespace
     and c.relname = 'articles_source_article_key_idx'
     and i.indisvalid = false;
  if v_bad is not null then
    raise exception '113: invalid index left by an aborted CREATE INDEX CONCURRENTLY: %. Run drop index concurrently <name>, then rebuild it (see the ORCHESTRATOR PRE-BUILD block in the header of 113_source_article_key.sql).', v_bad;
  end if;

  if pg_catalog.to_regclass('public.articles_source_article_key_idx') is null then
    v_size := pg_catalog.pg_relation_size('public.articles'::regclass);
    if v_size > 67108864 then
      raise exception '113: public.articles is % MB and articles_source_article_key_idx does not exist yet. Applying 113 now would build the index inside this transaction while the column change holds ACCESS EXCLUSIVE, which blocks every read and write of articles until the build ends. Run the ORCHESTRATOR PRE-BUILD first (the two standalone statements in the header of 113_source_article_key.sql; the index with CREATE INDEX CONCURRENTLY), then re-apply 113.', (v_size / 1048576);
    end if;
  end if;
end
$guard$;

-- 1. Column and index -----------------------------------------------------------

alter table public.articles add column if not exists source_article_key text;

comment on column public.articles.source_article_key is
  'The numeric id the outlet puts in the article url (migration 113): the last '
  'run of 6 to 20 digits in the last path segment, neither date-shaped nor round. Two urls of '
  'one source with the same key are one article whose headline was edited. '
  'NULL when the url has no id, for sources in ARTICLE_KEY_EXCLUDED_SLUGS and '
  'for rows older than the backfill. Written by the ingest function; see '
  'public.source_article_key().';

create index if not exists articles_source_article_key_idx
  on public.articles (source_id, source_article_key)
  where source_article_key is not null;

-- 2. SQL twin of sourceArticleKey() ------------------------------------------------

create or replace function public.source_article_key(p_url text)
returns text
language plpgsql immutable security definer set search_path = ''
as $fn$
declare
  v_path text;
  v_seg  text;
  v_m    text[];
  v_run  text;
  v_key  text := null;
begin
  if p_url is null then return null; end if;

  -- Scheme and authority skipped by the regex; the query string and the
  -- fragment are not part of the captured path. No match (a relative or
  -- unparseable url) gives a NULL path and so no key.
  v_path := (pg_catalog.regexp_match(p_url, '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*([^?#]*)'))[1];
  if v_path is null then return null; end if;

  -- Only the LAST path segment counts: an id in a parent segment
  -- (/kategori/123456/slug) is a section id, and keying on it would merge
  -- different stories.
  v_path := pg_catalog.rtrim(v_path, '/');
  v_seg := pg_catalog.regexp_replace(v_path, '^.*/', '');
  v_seg := pg_catalog.regexp_replace(v_seg, '\.(s?html?|php|aspx?)$', '', 'i');

  -- The last digit run of 6 to 20 digits that is neither date-shaped nor round
  -- (a quantity such as 100000 in a headline slug) wins.
  for v_m in select pg_catalog.regexp_matches(v_seg, '[0-9]+', 'g') loop
    v_run := v_m[1];
    if pg_catalog.length(v_run) between 6 and 20
       and not (
         pg_catalog.length(v_run) in (8, 10, 12, 14)
         and v_run ~ '^(19|20)[0-9]{2}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])'
       )
       and not (v_run ~ '^[1-9][0-9]?0{4,}$')
    then
      v_key := v_run;
    end if;
  end loop;

  return v_key;
end
$fn$;

comment on function public.source_article_key(text) is
  'SQL twin of sourceArticleKey() in supabase/functions/_shared/rss/article-key.ts '
  '(migration 113): the last run of 6 to 20 digits, neither date-shaped nor round, in the last '
  'path segment of the url, or NULL. IMMUTABLE and NULL-safe. service_role only.';

revoke all on function public.source_article_key(text) from public, anon, authenticated;
grant execute on function public.source_article_key(text) to service_role;

-- 3. Bounded operator backfill ------------------------------------------------------

create or replace function public.articles_source_key_backfill(p_from timestamptz, p_to timestamptz)
returns integer
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_n integer;
begin
  if p_from is null or p_to is null
     or p_to <= p_from
     or p_to - p_from > interval '2 days'
  then
    raise exception 'articles_source_key_backfill: need non-null p_from < p_to at most 2 days apart (got % .. %)',
      p_from, p_to;
  end if;

  -- Fills only NULL keys of the rows created in [p_from, p_to), so it is
  -- idempotent and never overwrites a key the ingest function wrote. The
  -- slugs in the array are ARTICLE_KEY_EXCLUDED_SLUGS (article-key.ts).
  update public.articles a
     set source_article_key = k.key
    from (
      select x.id, public.source_article_key(x.url) as key
        from public.articles x
        join public.sources s on s.id = x.source_id
       where x.created_at >= p_from
         and x.created_at < p_to
         and x.source_article_key is null
         and s.slug <> all (array['a-news', 'daily-sabah']::text[])
    ) k
   where a.id = k.id
     and k.key is not null;

  get diagnostics v_n = row_count;
  return v_n;
end
$fn$;

comment on function public.articles_source_key_backfill(timestamptz, timestamptz) is
  'Fills articles.source_article_key for the rows created in [p_from, p_to) '
  '(migration 113), idempotently, and returns the number of rows keyed. Raises '
  'unless both bounds are given, p_from < p_to and the window is at most 2 days. '
  'Skips the sources in ARTICLE_KEY_EXCLUDED_SLUGS. Operator-run in 2-day slices; '
  'nothing schedules it. service_role only.';

revoke all on function public.articles_source_key_backfill(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.articles_source_key_backfill(timestamptz, timestamptz) to service_role;

-- 4. Backfill: intentionally omitted (operator loop in the header). -------------------

insert into supabase_migrations.schema_migrations (version, name)
  values ('113', '113_source_article_key')
  on conflict do nothing;

commit;
