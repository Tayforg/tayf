-- 107_legal_notice_articles.sql
--
-- Keeps BİK (Basın İlan Kurumu) court and official notices out of the ticker
-- attention totals on /ekonomi. A notice such as "GARANTİ FAKTORİNG ... İCRA
-- DAİRESİ" string-matches a ticker, lands in article_tickers and inflates that
-- ticker's article and source counts. Ingest already drops notices (the rules
-- live in supabase/functions/_shared/rss/legal-notice.ts), but rows stored
-- before the filter existed, rows that slip past it, and rows ingested by a
-- lagging edge deploy are still counted.
--
-- STEP 0 FINDINGS (production, 2026-10-22, read-only SELECT / EXPLAIN; no
-- secrets recorded)
--   * Server: server_version_num 170006 (PG 17), server_encoding UTF8,
--     datcollate / datctype en_US.UTF-8. normalize() needs a UTF8 database.
--   * normalize spelling: both `normalize(U&'I\0307', NFC) = 'İ'` and
--     `pg_catalog.normalize(U&'I\0307', 'NFC') = 'İ'` return true. The
--     qualified form is used (search_path = '' inside the functions).
--   * EXPLAIN of `select a.id from articles a where a.published_at >= now() -
--     interval '1 day' and a.published_at < now() and a.title ~
--     'MAHKEMES[İI]'`: Index Scan using idx_articles_published_at (cost
--     0.43..2330.19), Index Cond on the published_at range, the regex only as
--     a Filter. The marker therefore reads a published_at slice, never the
--     whole table.
--   * Slice size: 11,710 articles in the last 1 day. EXPLAIN (ANALYZE,
--     BUFFERS) of the same shape over the cron window (published_at between
--     now() - 30 h and now() + 3 h) with the cheapest regex as filter: 13,253
--     rows scanned in 1.2 s (shared read=1,916, hit=12,394). The plpgsql
--     predicate adds CPU on top (local PG15, varied titles: 25,000 calls in
--     about 0.6 s, i.e. 25 us a call); 2 days is about 25k rows.
--   * Notice volume: the loose title pre-filter `title ~ '(MAHKEMES[İI]|[İI]CRA
--     DA[İI]RES[İI]|DA[İI]RE BAŞKANLI[ĞG]I)' or title ~ '^[İI]LAN'` matches 47
--     rows in the last 3 days (x10 = 470, below the 5,000 lookup limit; 460
--     over 30 days). The FULL predicate is larger because it also applies the
--     /ilan/ url rule. Replayed as a read-only SELECT over the last 3 days it
--     flags 82 of 34,319 articles (36 by title, 80 by url path, 34 by both):
--     about 27 a day, so ~820 over 30 days and ~220 over 8 days. A sample of
--     the 14 newest matches were all court / municipal notices. PostgREST
--     truncates every response at max_rows (1,000 in supabase/config.toml)
--     whatever limit is requested, which puts the 30-day set at ~82% of one
--     response. fetchLegalNoticeIdsSince therefore asks for 5,000 and continues
--     with .range() pages whenever a response comes back with exactly 1,000 rows.
--   * Collation check: the same predicate logic, inlined as a read-only SELECT
--     on production (PG 17, en_US.UTF-8), agrees with all 57 rows of the shared
--     fixture table (tests/fixtures/legal-notice-cases.ts), 0 mismatches.
--   * Rejected alternative (join articles.title at read time): article_tickers
--     has 1,750 rows in the last 8 days (fetchTopTickers' window; its paging
--     cap is 20,000). EXPLAIN: Nested Loop, cost 28.57..4957.95, Bitmap Heap
--     Scan on article_tickers (article_tickers_published_ticker_idx) with a
--     Memoize'd Index Scan on articles_pkey per row, i.e. about 1,750
--     primary-key heap fetches into a 983 MB heap on a Micro compute with 256
--     MB shared_buffers (up to 20,000 at the paging cap), each pulling the wide
--     article row, to learn one title. The join's cost grows with
--     article_tickers volume and is random heap IO on a cold cache, while the
--     lookup below reads about 120 rows of a tiny table (a few heap pages) for
--     the same window, independent of that volume. An ILIKE pre-scan of
--     articles would be worse still (77k to 289k rows).
--   * cron.job: count(*) where jobname = 'legal-notice-mark' is 0.
--
-- DESIGN
--   * public.legal_notice_articles(article_id, published_at, marked_at): ids of
--     notice articles, filled by SQL rules that mirror legal-notice.ts.
--     Service-role-only (RLS on, all default grants revoked, SELECT granted to
--     service_role). The readers in src/lib/finance (fetchTopTickers,
--     fetchTickerPage) fetch the id set of their window, drop matching
--     article_tickers rows and aggregate the rest. The lookup is FAIL-OPEN: an
--     error or a missing table warns and counts every row, as before this
--     migration, so the app can deploy before or after the migration.
--   * public.is_legal_notice(p_title, p_url): the SQL twin of isLegalNotice().
--     Each regex below is the JS `.source` of LEGAL_NOTICE_PATTERNS copied
--     verbatim (tests/migrations/107-legal-notice-articles.test.ts fails the
--     build on drift, and runs the shared fixture table through a real
--     Postgres when TAYF_PSQL is set). Case is decided by counting letters in
--     the Turkish alphabet: upper = A-Z plus ÇĞİÖŞÜÂÎÛ, lower = a-z plus
--     çğıöşüâîû.
--   * public.legal_notice_mark(p_from, p_to): marks the notices published in
--     [p_from, p_to), idempotently (on conflict do nothing), and returns the
--     number of newly marked rows. The window must be at most 2 days so a
--     single call stays inside a statement_timeout.
--   * Cron 'legal-notice-mark' at minute 23 of every 6th hour re-marks the last
--     30 hours and the next 3 (for clock skew), a backstop for slips and
--     edge-deploy lag. No backfill runs inside this migration.
--
-- ACCEPTED DIVERGENCES from the JS predicate (documented, not tested)
--   * Letters outside the Turkish/ASCII sets are not counted; JS counts any
--     \p{L} letter (so a title with other-script letters can pass the 0.85
--     ratio in SQL but fail it in JS, or the reverse).
--   * `.` and `\s` treat newlines and Unicode spaces differently in a Postgres
--     ARE than in a JS regex (`.` matches a newline here, `\s` follows the
--     database locale). Titles are single-line after ingest, and the trim step
--     names NBSP and BOM explicitly.
--
-- BACKFILL (operator, once, after applying this migration; idempotent and
-- resumable; do NOT run it inside the migration). One call per 2-day slice,
-- each its own statement so none risks the API timeout:
--   for i in $(seq 30 -2 0); do
--     psql "$DATABASE_URL" -Atc "set statement_timeout = '2min'; select
--       public.legal_notice_mark(date_trunc('day', now()) - interval '$i days',
--       date_trunc('day', now()) - interval '$i days' + interval '2 days');"
--   done
--   Expect roughly 27 new rows per day (~820 over the 30 days). Verify with
--     select count(*), min(published_at), max(published_at)
--       from public.legal_notice_articles;
--
-- ROLLBACK (nothing depends on this; the readers fail open):
--   select cron.unschedule('legal-notice-mark');
--   drop function public.legal_notice_mark(timestamptz, timestamptz);
--   drop function public.is_legal_notice(text, text);
--   drop table public.legal_notice_articles;
--   delete from supabase_migrations.schema_migrations where version = '107';

begin;

-- 1. Table ---------------------------------------------------------------------

create table if not exists public.legal_notice_articles (
  article_id   uuid primary key references public.articles(id) on delete cascade,
  published_at timestamptz not null,
  marked_at    timestamptz not null default now()
);

create index if not exists legal_notice_articles_published_idx
  on public.legal_notice_articles (published_at desc);

comment on table public.legal_notice_articles is
  'BİK court / official notice articles (migration 107), the ids the /ekonomi '
  'ticker readers skip when summing attention. Filled by '
  'legal_notice_mark() (cron legal-notice-mark every 6 hours plus the operator '
  'backfill) using the SQL twin of supabase/functions/_shared/rss/legal-notice.ts. '
  'Service-role only; rows cascade with their article.';

alter table public.legal_notice_articles enable row level security;

-- Supabase default privileges hand new tables to anon/authenticated (incl.
-- write grants, cf. 091/095): strip them. Only service_role may read; the
-- owner-run SECURITY DEFINER marker below is the only writer.
revoke all on public.legal_notice_articles from anon, authenticated, public;

-- PG17 added the MAINTAIN privilege; it does not exist before PG17 (revoking
-- it would be a syntax error), so guard.
do $maint$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on public.legal_notice_articles from anon, authenticated';
  end if;
end
$maint$;

grant select on public.legal_notice_articles to service_role;

-- 2. Predicate -----------------------------------------------------------------

create or replace function public.is_legal_notice(p_title text, p_url text default null)
returns boolean
language plpgsql immutable security definer set search_path = ''
as $fn$
declare
  v_t    text;
  v_up   integer;
  v_lo   integer;
  v_path text;
begin
  if p_title is not null and p_title <> '' then
    -- NFC first ("İ" can arrive as I + U+0307), then trim like JS trim():
    -- \s plus NBSP and BOM (and the other Unicode spaces) named explicitly.
    v_t := pg_catalog.regexp_replace(
      pg_catalog.normalize(p_title, 'NFC'),
      '^[\s\u00a0\ufeff\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\s\u00a0\ufeff\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$',
      '',
      'g'
    );
    v_up := pg_catalog.length(pg_catalog.regexp_replace(v_t, '[^A-ZÇĞİÖŞÜÂÎÛ]', '', 'g'));
    v_lo := pg_catalog.length(pg_catalog.regexp_replace(v_t, '[^a-zçğıöşüâîû]', '', 'g'));

    -- A: mostly uppercase (>= 8 letters, >= 0.85 uppercase) and one of three shapes.
    if v_up + v_lo >= 8
       and v_up >= 0.85 * (v_up + v_lo)
       and (
         v_t ~ '(MAHKEMES[İI]|[İI]CRA DA[İI]RES[İI]|DA[İI]RE BAŞKANLI[ĞG]I)(NDEN|NDAN)?[\s.:;,!-]*$'
         or v_t ~ '(MAHKEMES[İI]NDEN|[İI]CRA DA[İI]RES[İI]NDEN|DA[İI]RE BAŞKANLI[ĞG]INDAN)'
         or v_t ~ '^T\.\s?C\.\s.*MAHKEMES[İI]'
       )
    then
      return true;
    end if;

    -- (iv) A bare "İLAN" header has fewer than 8 letters; the ratio gate alone
    -- (3 letters = the word itself) decides.
    if v_t ~ '^[İI]LAN([\s:.–-]|$)'
       and v_up + v_lo >= 3
       and v_up >= 0.85 * (v_up + v_lo)
    then
      return true;
    end if;
  end if;

  -- B: an /ilan/ section in the url path (scheme and authority skipped; a
  -- relative or unparseable url gives a NULL path and so no signal).
  if p_url is not null and p_url <> '' then
    v_path := (pg_catalog.regexp_match(p_url, '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*([^?#]*)'))[1];
    if v_path ~* '(^|\/)(ilan|ilanlar|resmi-ilan|resmi-ilanlar)(\/|$)' then
      return true;
    end if;
  end if;

  return false;
end
$fn$;

comment on function public.is_legal_notice(text, text) is
  'SQL twin of isLegalNotice() in supabase/functions/_shared/rss/legal-notice.ts '
  '(migration 107): true for a BİK court / official notice, judged on the title '
  '(mostly uppercase and an institution shape) or on an /ilan/ url path. '
  'IMMUTABLE, NULL-safe (never returns NULL). service_role only.';

revoke all on function public.is_legal_notice(text, text) from public, anon, authenticated;
grant execute on function public.is_legal_notice(text, text) to service_role;

-- 3. Marker --------------------------------------------------------------------

create or replace function public.legal_notice_mark(p_from timestamptz, p_to timestamptz)
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
    raise exception 'legal_notice_mark: need non-null p_from < p_to at most 2 days apart (got % .. %)',
      p_from, p_to;
  end if;

  insert into public.legal_notice_articles (article_id, published_at)
  select a.id, a.published_at
  from public.articles a
  where a.published_at >= p_from
    and a.published_at < p_to
    and public.is_legal_notice(a.title, a.url)
  on conflict (article_id) do nothing;

  get diagnostics v_n = row_count;
  return v_n;
end
$fn$;

comment on function public.legal_notice_mark(timestamptz, timestamptz) is
  'Marks the BİK notices among the articles published in [p_from, p_to) in '
  'legal_notice_articles (migration 107), idempotently, and returns the number '
  'of newly marked rows. Raises unless both bounds are given, p_from < p_to and '
  'the window is at most 2 days. Cron legal-notice-mark runs it every 6 hours '
  'over the last 30 hours; the operator backfill runs it in 2-day slices. '
  'service_role only.';

revoke all on function public.legal_notice_mark(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.legal_notice_mark(timestamptz, timestamptz) to service_role;

-- 4. Cron backstop -------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron not installed — skipping legal-notice-mark schedule (107)';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'legal-notice-mark') then
    perform cron.unschedule('legal-notice-mark');
  end if;
  perform cron.schedule('legal-notice-mark', '23 */6 * * *',  -- 30 h back + 3 h ahead of now() per run
    $sql$ set statement_timeout = '2min'; select public.legal_notice_mark(now() - interval '30 hours', now() + interval '3 hours'); $sql$);
end $$;

-- 5. Backfill: intentionally omitted (operator loop in the header). ------------------

insert into supabase_migrations.schema_migrations (version, name)
  values ('107', '107_legal_notice_articles')
  on conflict do nothing;

commit;
