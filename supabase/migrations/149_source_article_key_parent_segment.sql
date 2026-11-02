-- 149_source_article_key_parent_segment.sql
--
-- Teaches the SQL twin public.source_article_key(text) (migration 113) the two
-- host-anchored parent-segment id rules of supabase/functions/_shared/rss/
-- article-key.ts (PARENT_SEGMENT_KEY_RES): evrensel.net /haber/<id>/<slug> and
-- indyturk.com /node/<id>/[<section>/]<slug>. Both outlets put their CMS id in a
-- PARENT path segment and a slug that changes with every headline edit after
-- it, so the last-segment rule of 113 gave them no key at all, and a re-titled
-- article was inserted as a second row (in another cluster) because the
-- "same id, new url" drop in the ingest function never fired.
--
-- This migration changes ONE function body. It adds no table, column or index,
-- updates no row, runs no backfill (no backfill: see APPLY), and changes no
-- grant. Ingest computes the key in TypeScript (sourceArticleKeyFor), so the
-- forward fix is the ingest redeploy; this file only keeps the SQL twin, which
-- the operator backfill articles_source_key_backfill would call, in step.
--
-- EVIDENCE (hunt 24, h24-feeds-1, prod 2026-11-02): evrensel 76 ids and
-- indyturk 7 ids with 2 or more rows in 7 days (183 + 14 rows), sitting in 64 +
-- 11 different clusters. Pair 1: evrensel /haber/6007631/ rows b3a2b8e4 (created
-- 09:18Z) and 829e55e4 (09:33Z), slugs "...50-tlyi-asacak" and "...50-tl-yi-
-- asacak", identical title. Pair 2: indyturk /node/784651/ rows 6cf47ad9 (09:48Z)
-- and 5e0c2aa6 (10:30Z, the url gained a /kültür/ segment), identical title.
--
-- STEP 0 (production, 2026-11-02, read-only SELECTs, bounded by source_id and
-- created_at; PostgreSQL 17, no secrets)
--   (a) Url shapes of the last 7 days, substring(url from '^https?://[^/]+/[^/]+/'):
--       evrensel 1,103 rows, ALL https://www.evrensel.net/haber/<id>/<slug>?utm_*
--       (1,103 of 1,103 match the new rule, 996 distinct ids); indyturk 295 rows,
--       ALL https://www.indyturk.com/node/<id>/..., no query (295 of 295 match,
--       288 distinct ids). No other shape in either source, so no rule exists
--       for one. Stored keys: evrensel 1 of 1,103 (a ddmmyyyy date in a slug,
--       29102026, which the new rule replaces with the real id 6007068),
--       indyturk 0 of 295.
--   (b) Verbatim stored urls and titles of the pairs above, of two more pairs
--       (evrensel 6006697, indyturk 784495) and of different articles (evrensel
--       6006702 and 6006706, indyturk 784377 and 784544) are fixtures in
--       tests/fixtures/source-article-key-cases.ts ("parent-segment ids (149)").
--   (c) MD5 GATE. select md5(prosrc), length(prosrc) from pg_proc where oid =
--       'public.source_article_key(text)'::regprocedure returns
--       dbbba7e0e939036ef5c4298b593b7474 and 1397 (immutable, security definer,
--       search_path="", EXECUTE for service_role only). That is the md5 of the
--       exact text between `as` and the closing dollar quote of the function in
--       113_source_article_key.sql (computed with node crypto; the 149 test
--       recomputes it), so 149 is built on the CURRENT production body. This
--       file's body (the 113 body plus the v_re declaration and the foreach
--       block) is 7beb33a72d1009004ef74e82f3fb0f28, 2498 bytes; the dry run
--       checks that Postgres stores exactly that.
--   (d) Callers: select proname from pg_proc where pronamespace =
--       'public'::regnamespace and prosrc like '%source_article_key(%' returns
--       articles_source_key_backfill only (the function itself does not call
--       itself). Nothing at runtime calls it, so applying 149 changes no
--       behaviour until a backfill is run.
--
-- ALGORITHM (the SQL and the TS module are the same function; 113 unchanged
-- from step 2 on)
--   0. NEW. For each parent regex in order (evrensel, then indyturk), run
--      regexp_match(p_url, <regex>, 'i') on the whole url. The first whose
--      captured id (6 to 20 digits that end the segment) is neither date-shaped
--      (8, 10, 12 or 14 digits starting like a 19xx/20xx date) nor round
--      (KEY_ROUND_RE) is the key. A capture that fails a guard falls through.
--      The regexes are anchored on scheme, host (optionally www.) and the path
--      prefix: evil.test/haber/..., evrensel.net.evil.test and notevrensel.net
--      do not match. The case-insensitive flag matches the JS /i flag.
--   1-4. Unchanged: last path segment, extension stripped, the last run of 6 to
--      20 digits that is neither date-shaped nor round. An id in any OTHER
--      parent segment (/kategori/123456/slug) still gives no key.
--
-- REPLAY (read-only; 7 days of rows created before 2026-11-02 13:14Z, exported by
-- day, old rules against new; the script lives in the session scratchpad)
--   evrensel  1,100 rows  keyed old 1 -> new 1,100; 993 distinct keys
--             groups of 2+ urls: old 0 -> new 76 (183 rows; sizes 2:61 3:7 4:2
--             5:4 6:2), 107 extra rows
--   indyturk    295 rows  keyed old 0 -> new 295; 288 distinct keys
--             groups of 2+ urls: old 0 -> new 7 (14 rows, all pairs), 7 extra rows
--   Ingest twin drop replayed in created_at order with TITLE_TWIN_MIN_JACCARD,
--   titleTokens and jaccardOfSets exactly as supabase/functions/ingest/index.ts
--   imports them (0.2): it would have dropped 94 evrensel and 6 indyturk rows
--   (title gate passed). 13 evrensel groups (13 rows) and 1 indyturk group (1
--   row) share an id but fail the title gate, so ingest keeps them as distinct
--   rows, exactly as before: evrensel 6006711, 6006718, 6006747, 6006779,
--   6006770, 6006903, 6006974, 6007266, 6007291, 6007473, 6007460, 6007540,
--   6007588 and indyturk 784544. Hand-judged: every one is the SAME story whose
--   headline moved on (works accident -> the worker's death; derby line-ups ->
--   first half; editors detained -> released; unemployment figure -> "real
--   unemployment"; election day -> count; students detained -> released; trial
--   opens -> hearing outcome; port strike; match report after the half; Germany
--   protests; Amedspor score; Besiktas score; Ozel at the metro test drive ->
--   his remarks at the same event). The 17 passing groups with the lowest
--   Jaccard (0.2 to 0.4) were hand-judged too: same story each time. There is
--   NO case of different stories sharing an id.
--   Corpus: sourceArticleKey over all 522 urls of tests/fixtures/ingest-
--   corpus.json, before and after: 7 keys change, all null -> id (evrensel
--   6007178, 6007524, 6007255, 6007488, 6007396, 6007466; indyturk 784565).
--   content_hash is untouched (tests/functions/_shared/ingest-corpus-equality).
--
-- DRY RUN (local PostgreSQL 15.12, two throwaway clusters on fresh data dirs,
-- ports 55549 and 55559, the stub schema; tests/migrations/sql/149-source-article-
-- key-parent-segment-dryrun.sql)
--   Each run: Supabase default privileges (anon and authenticated may execute new
--   functions, so the revoke has something to undo), stub.sql, 113, a check that
--   113's body is production's (md5 dbbba7e0..., 1397), four seeded rows with NULL
--   keys (both verbatim pairs), then 149 applied TWICE. Both clusters ended with
--   "DRYRUN 149 OK" and produced identical output (no NOTICE, no warning). The DO
--   blocks raise unless:
--   * the stored body is exactly this file's (md5 7beb33a7..., 2498), the function
--     exists once, is immutable, SECURITY DEFINER, search_path = "", returns text;
--   * EXECUTE is held by service_role only (anon, authenticated and PUBLIC cannot
--     call it); the backfill function's grants did not change;
--   * exactly one ledger row 149 (and one 113);
--   * no articles row changed and no source_article_key was written (a row-by-row
--     md5 before and after);
--   * a 47-row truth table holds: both incident pairs share a key (6007631,
--     784651), the evil host, the host-prefix and suffix tricks, the user-info
--     trick and /kategori/123456/slug are NULL, 5 and 21 digits are NULL, 6 and 20
--     digits key, the round and date captures fall through to the last segment, and
--     the 113 rows are unchanged;
--   * a 100,000-digit run and 100,000 trailing slashes are answered in well under
--     5 s.
--   Live vitest on cluster A (TAYF_PSQL): tests/migrations/113-source-article-key
--   and 149-source-article-key-parent-segment, 71 of 71 passed, including the whole
--   shared fixture table through public.source_article_key against the TS
--   sourceArticleKey; without TAYF_PSQL 61 passed and the 10 live tests skipped.
--
-- ROLLBACK (the TS rules ship with the ingest function; this only restores the
-- SQL twin):
--   1. Redeploy the previous ingest function if the TS rules must go too.
--   2. Re-run ONLY the source_article_key section of 113_source_article_key.sql
--      (its create, comment, revoke and grant statements for that one function;
--      not the column, index or backfill parts). That restores the body whose
--      md5 is dbbba7e0e939036ef5c4298b593b7474.
--   3. delete from supabase_migrations.schema_migrations where version = '149';
--
-- APPLY. APPLY 149 + REDEPLOY ingest, any order; safe to re-apply (create or
-- replace, idempotent revoke and grant, ledger insert is on conflict do
-- nothing); no backfill, no article update, no index change. Rows stored before
-- the ingest deploy keep NULL keys, so only a re-title of an article ingested
-- AFTER the deploy is deduped; a re-title of an item that was already stored
-- (and is still in the feed on deploy day) can insert one more row, and the
-- ~250 existing duplicate rows stay as they are. A backfill of the two sources
-- and a decision on merging those rows is a separate, optional operator step.
--
-- See docs/migration-guide.md (149) and
-- tests/migrations/149-source-article-key-parent-segment.test.ts.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- 1. SQL twin of sourceArticleKey() -----------------------------------------------

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
  v_re   text;
begin
  if p_url is null then return null; end if;

  -- Host-anchored parent-segment ids (migration 149): evrensel.net keeps its
  -- CMS id in /haber/<id>/<slug> and indyturk.com in /node/<id>/<slug>, so a
  -- headline edit changes the last segment but not the id. These are
  -- PARENT_SEGMENT_KEY_RES of article-key.ts, in the same order, tried on the
  -- whole url; the capture must pass the same date-shape and round-number
  -- guards as a last-segment run. Anything that does not match, or whose
  -- capture fails a guard, falls through to the last-segment logic below.
  foreach v_re in array array[
    '^https?://(?:www\.)?evrensel\.net/haber/([0-9]{6,20})(?:/|$)',
    '^https?://(?:www\.)?indyturk\.com/node/([0-9]{6,20})(?:/|$)'
  ] loop
    v_run := (pg_catalog.regexp_match(p_url, v_re, 'i'))[1];
    if v_run is not null
       and not (pg_catalog.length(v_run) in (8, 10, 12, 14)
                and v_run ~ '^(19|20)[0-9]{2}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])')
       and not (v_run ~ '^[1-9][0-9]?0{4,}$')
    then
      return v_run;
    end if;
  end loop;

  -- Scheme and authority skipped by the regex; the query string and the
  -- fragment are not part of the captured path. No match (a relative or
  -- unparseable url) gives a NULL path and so no key.
  v_path := (pg_catalog.regexp_match(p_url, '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*([^?#]*)'))[1];
  if v_path is null then return null; end if;

  -- Only the LAST path segment counts, except the host-anchored parent ids
  -- above: any other id in a parent segment (/kategori/123456/slug) is a
  -- section id, and keying on it would merge different stories.
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
  '(migrations 113, 149): for evrensel.net /haber/<id>/ and indyturk.com /node/<id>/ the '
  'id in that parent segment; otherwise the last run of 6 to 20 digits, neither date-shaped '
  'nor round, in the last path segment of the url; or NULL. IMMUTABLE and NULL-safe. '
  'service_role only.';

revoke all on function public.source_article_key(text) from public, anon, authenticated;
grant execute on function public.source_article_key(text) to service_role;

insert into supabase_migrations.schema_migrations (version, name)
  values ('149', '149_source_article_key_parent_segment')
  on conflict do nothing;

commit;
