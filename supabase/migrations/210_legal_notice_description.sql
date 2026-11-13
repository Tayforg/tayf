-- 210_legal_notice_description.sql
--
-- h168-notices-1: court and tender notices (resmi ilan) that the title rules of
-- migration 107 miss are recognised by their DESCRIPTION. Yeniçağ prints a court,
-- tax-office or company notice under a mixed-case title ("T.C. Kırıkhan 2. Asliye
-- Ceza Mahkemesi") and marks it only in the description ("İlan-<title>"); Yeni
-- Mesaj, Milat and Diriliş Postası print a municipality's, a hospital's or BOTAŞ's
-- EKAP tender under a bare institution title ("ÜMRANİYE BELEDİYE BAŞKANLIĞI") and
-- say what it is only in the description ("... mal alımı 4734 sayılı Kamu İhale
-- Kanununun 19 uncu maddesine göre ..."). Ingest (supabase/functions/_shared/rss/
-- legal-notice.ts, isLegalNotice's new third argument) now drops them; the reader
-- side hides the ones already stored (source 'Son haberler', cluster page noindex).
-- This migration is the SQL twin of the new description rules, so the stored rows
-- also leave the /ekonomi ticker attention totals (legal_notice_articles, which
-- the ticker readers and the trends rollups already skip).
--
-- STEP 0 FINDINGS (production, 2026-11-12, read-only SELECT in a READ ONLY
-- transaction; no secrets recorded)
--   * public.is_legal_notice(text, text): pg_get_functiondef on production gives
--     a body that is byte for byte the body of migration 107 (1,876 characters,
--     sha256 f28c49cb47fbd5529c5834347c52a974621fcffe4ae0d3cdc923a9196f5deefc;
--     tests/migrations/210-legal-notice-description.test.ts pins that hash on the
--     107 file). IMMUTABLE, SECURITY DEFINER, search_path '', acl postgres +
--     service_role. This migration does NOT touch it: it adds a 3-argument
--     overload next to it and calls it first, so every title and url verdict of
--     107 is unchanged by construction. The 3-argument overload has no DEFAULT
--     on p_description, so a 1- or 2-argument call can only ever resolve to the
--     107 function.
--   * public.legal_notice_mark(timestamptz, timestamptz): the production body is
--     also byte for byte 107's (601 characters, sha256 4eceacedd54b65f8aaf10c37
--     8fda7061ba7711c5034c23398174f2007d9020f1). It is re-created below with the
--     same guard and insert; only the predicate call changes.
--   * cron.job 'legal-notice-mark' (jobid 55, active): schedule '23 */6 * * *',
--     command  set statement_timeout = '2min'; select public.legal_notice_mark(
--     now() - interval '30 hours', now() + interval '3 hours');  i.e. every
--     6 hours it passes the window [now - 30 hours, now + 3 hours) of
--     published_at, so the new predicate only ever marks RECENT rows. Rows older
--     than 30 hours at the time of a run are not re-marked by the cron (see
--     BACKFILL). The job is not changed here.
--   * Cost: the marker reads about 11,700 articles a day by published_at (see
--     107's header), i.e. about 15,000 rows a run, and now also reads
--     a.description (at most 500 characters, stored inline, in the same heap row
--     as the title and url). The 2-argument verdict runs first and is unchanged;
--     the description patterns are a start-anchored test and three literal
--     substring tests on at most 500 characters, and the per-letter title count
--     runs only for a row that already has a tender marker (about 6 a day).
--   * Scale (from the finding): in 7 days 40 notice articles (yenicag 30, milat 4,
--     dirilis-postasi 3, yeni-mesaj 3), 6 of them clustered; 50 yenicag rows with
--     the description prefix 'İlan-' in 10 days.
--
-- REPLAY (production, 2026-10-14 .. 2026-11-12 by published_at, 31 one-day
-- slices (the last one empty), the rule logic below inlined as one READ ONLY
-- SELECT per slice because the new function does not exist yet; the 3-argument
-- function was then run on a throwaway Postgres 15 over the same candidate rows
-- and agreed on every one, and so did the JS predicate)
--   * 180 rows carry a description marker. 157 are NEW matches (3-argument true,
--     2-argument false): yenicag 123 (all D1, 'İlan-'), yeni-mesaj 14, milat 12,
--     dirilis-postasi 8. 0 matches outside those four sources. All 157 were read
--     by hand: court, tax-office, hospital, municipality and BOTAŞ notices and
--     EKAP tenders, no news story.
--   * 19 of the 180 were already caught by the 107 title rules (posta 5, yeni-asir
--     8, takvim 5, yeni-mesaj 1): unchanged.
--   * 4 carry a marker but are KEPT because the title is mixed case: indyturk
--     'Çukurova Belediyesi'ne yönelik operasyonda 44 kişi gözaltına alındı' and
--     milliyet + posta 'İstanbul Emniyet Müdürlüğünden nezarethanelerde verilen
--     kumanyalara ilişkin açıklama' (both quote the 4734 sayılı Kamu İhale
--     Kanunu: real news), and elips-haber 'Ankara 22. Aile Mahkemesi ilanı' (a
--     true notice with a mixed-case title and a capitals 'İLAN ' description, a
--     known false negative of the uppercase gate).
--   * That is why the tender law is never a rule on its own: a 14-day scan of
--     the finding shows real news (Kızılay ihalesiz alım x3, Emniyet kumanya x2,
--     Gaziantep ihalesi) carrying it, all under mixed-case titles.
--
-- DESIGN
--   * public.is_legal_notice(p_title, p_url, p_description): the SQL twin of
--     isLegalNotice(title, url, description) in supabase/functions/_shared/rss/
--     legal-notice.ts. IMMUTABLE, SECURITY DEFINER, search_path '', service_role
--     only. Step 1 is the 107 verdict on title and url, unchanged. Then a NULL or
--     empty description returns false, and two rules judge the description after
--     NFC normalisation (an "İ" can arrive as I + U+0307):
--       D1  the description starts with the word İlan and a dash or en dash;
--           decided on the description alone (no title condition). The dash is
--           required: 'İlan sitesine 111 TL ...' is a real CNN Türk story.
--       D2  the title is mostly upper case (>= 8 letters, >= 0.85 of them upper
--           case, counted exactly as in 107) AND the description has a tender
--           marker: the sentence '4734 sayılı Kamu İhale Kanunu', the phrase
--           'İhale Kayıt Numarası', or a capitals 'İLAN ' header.
--     Each regex below is the JS `.source` of LEGAL_NOTICE_DESCRIPTION_PATTERNS
--     copied verbatim (tests/migrations/210-legal-notice-description.test.ts
--     fails the build on drift). They are valid Postgres AREs unchanged: no
--     lookaround, no `\-` escape, no `\p{..}`, case-sensitive, anchored or
--     literal, so linear on any input.
--   * public.legal_notice_mark(p_from, p_to): re-created with the identical
--     signature, window guard (both bounds, ordered, at most 2 days), half-open
--     window and on-conflict-do-nothing insert; it selects a.description and
--     calls the 3-argument form. Marks only grow. Same grants as 107.
--   * Nothing else changes: no table, no index, no cron change, no data rewrite.
--     The existing legal-notice-mark cron picks the new predicate up on its next
--     run, by name.
--
-- ACCEPTED DIVERGENCES from the JS predicate (documented, not tested)
--   * Those of 107: letters outside the Turkish/ASCII sets are not counted in the
--     SQL ratio (JS counts any \p{L}); `\s` follows the database locale in an ARE
--     and Unicode White_Space in JS.
--   * The ingest filter reads the RAW feed description (it may carry markup or
--     entities, clamped to 20,000 units); this function reads the STORED text
--     (markup stripped, entities decoded, cut at 500 characters). A marker that
--     only the raw text carries is dropped at ingest and never stored; a marker
--     hidden by markup in the raw text is stored and is caught here and by the
--     reader-side filters instead.
--
-- DEPLOY ORDER: none. The ingest function, the app and this migration are
-- independent: the app and the Edge Function do not call the 3-argument SQL
-- function, and the SQL function only feeds the ticker exclusion table.
--
-- BACKFILL (operator, OPTIONAL, after applying this migration; do NOT run it
-- inside the migration). The cron only re-marks the last 30 hours. The page-level
-- fixes (source 'Son haberler', cluster noindex) need no marking. To also drop
-- the older stored notices from the ticker totals, run 107's loop (idempotent,
-- one 2-day slice per statement):
--   for i in $(seq 30 -2 0); do
--     psql "$DATABASE_URL" -Atc "set statement_timeout = '2min'; select
--       public.legal_notice_mark(date_trunc('day', now()) - interval '$i days',
--       date_trunc('day', now()) - interval '$i days' + interval '2 days');"
--   done
--   Expect about 5 new rows a day (157 over the 30 days of the replay). Verify:
--     select count(*) from public.legal_notice_articles l
--       join public.articles a on a.id = l.article_id
--      where left(a.description, 5) = 'İlan-';
--
-- ROLLBACK (nothing depends on the 3-argument form except the marker):
--   create or replace function public.legal_notice_mark(...)  -- 107's body, which
--     -- calls public.is_legal_notice(a.title, a.url)
--   drop function public.is_legal_notice(text, text, text);
--   delete from supabase_migrations.schema_migrations where version = '210';
-- Rows already marked stay marked (marks only grow); delete them by hand if wanted.

begin;

-- 1. Predicate -------------------------------------------------------------------

create or replace function public.is_legal_notice(p_title text, p_url text, p_description text)
returns boolean
language plpgsql immutable security definer set search_path = ''
as $fn$
declare
  v_d  text;
  v_t  text;
  v_up integer;
  v_lo integer;
begin
  -- Title and url: the 2-argument verdict of migration 107, unchanged.
  if public.is_legal_notice(p_title, p_url) then
    return true;
  end if;

  if p_description is null or p_description = '' then
    return false;
  end if;

  v_d := pg_catalog.normalize(p_description, 'NFC');

  -- D1: Yeniçağ's marker, "İlan-<title>". A dash or en dash is required.
  if v_d ~ '^\s*[İI]lan\s*[-–]' then
    return true;
  end if;

  -- D2: a tender marker in the description, trusted only under a title that is
  -- mostly upper case (real news carries the tender law under mixed-case titles).
  -- The cheap description tests run first; the per-letter title count only for a
  -- row that has a marker.
  if p_title is not null and p_title <> ''
     and (
       v_d ~ '4734 sayılı Kamu İhale Kanunu'
       or v_d ~ 'İhale Kayıt Numarası'
       or v_d ~ '^\s*[İI]LAN\s'
     )
  then
    v_t  := pg_catalog.normalize(p_title, 'NFC');
    v_up := pg_catalog.length(pg_catalog.regexp_replace(v_t, '[^A-ZÇĞİÖŞÜÂÎÛ]', '', 'g'));
    v_lo := pg_catalog.length(pg_catalog.regexp_replace(v_t, '[^a-zçğıöşüâîû]', '', 'g'));
    if v_up + v_lo >= 8
       and v_up >= 0.85 * (v_up + v_lo)
    then
      return true;
    end if;
  end if;

  return false;
end
$fn$;

comment on function public.is_legal_notice(text, text, text) is
  'SQL twin of isLegalNotice(title, url, description) in supabase/functions/_shared/rss/legal-notice.ts '
  '(migration 210): the 2-argument verdict of migration 107 on title and url, then two description rules: '
  'D1 the description starts with the word İlan and a dash (Yeniçağ''s ''İlan-<title>'' notices), '
  'D2 a mostly-uppercase title and a tender marker in the description (the 4734 sayılı Kamu İhale Kanunu '
  'sentence, the phrase İhale Kayıt Numarası, or a capitals İLAN header). '
  'IMMUTABLE, NULL-safe (never returns NULL). service_role only.';

revoke all on function public.is_legal_notice(text, text, text) from public, anon, authenticated;
grant execute on function public.is_legal_notice(text, text, text) to service_role;

-- 2. Marker ------------------------------------------------------------------------

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
    and public.is_legal_notice(a.title, a.url, a.description)
  on conflict (article_id) do nothing;

  get diagnostics v_n = row_count;
  return v_n;
end
$fn$;

comment on function public.legal_notice_mark(timestamptz, timestamptz) is
  'Marks the BİK notices among the articles published in [p_from, p_to) in '
  'legal_notice_articles (migration 107; since migration 210 judged on title, url and description), '
  'idempotently, and returns the number of newly marked rows. Raises unless both bounds are given, '
  'p_from < p_to and the window is at most 2 days. Cron legal-notice-mark runs it every 6 hours '
  'over the last 30 hours; the operator backfill runs it in 2-day slices. '
  'service_role only.';

revoke all on function public.legal_notice_mark(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.legal_notice_mark(timestamptz, timestamptz) to service_role;

-- 3. Cron, data: unchanged. The legal-notice-mark job calls legal_notice_mark() by
--    name; no backfill or rewrite runs inside this migration.

insert into supabase_migrations.schema_migrations (version, name)
  values ('210', '210_legal_notice_description')
  on conflict do nothing;

commit;
