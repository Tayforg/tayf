-- 213_legal_notice_tax_court.sql
--
-- h181-sourcepages-1: tax-office, enforcement-office and mixed-case court notices. A tax
-- office's "İLANEN TEBLİĞ" (a table of debtors: tax number, name, address) and an
-- enforcement office's "GAZETE VEYA İNTERNET HABER SİTESİ İLANI" (a sale notice of a debtor's
-- goods) arrive from Milat, Diriliş Postası and Yeni Mesaj under a bare all-caps office name
-- ("KOZYATAĞI VERGİ DAİRESİ MÜDÜRLÜĞÜ", "SİLİVRİ İCRA VE İFLAS MÜDÜRLÜĞÜ"), and İşçi Haber
-- rewrites a BİK court notice into a sentence-case title ("Kocaeli 3. sulh hukuk
-- Mahkemesi'nden ilanen tebliğ") with the defendant named in the description. None carries
-- the markers of migrations 107 and 210 ("İlan-", a tender law, a title that ends in the
-- court), so they were stored and listed under 'Son haberler' on indexable source pages.
-- Ingest (supabase/functions/_shared/rss/legal-notice.ts, isLegalNotice) now drops them and
-- the reader side (selectSourceRecentArticles, isNoticeOnlyCluster) hides the ones already
-- stored; both call the same function, so neither needs a change of its own.
-- This migration is the SQL twin of the two rules that can have one (E1 title, E2
-- description), so the stored rows also leave the /ekonomi ticker attention totals
-- (legal_notice_articles, which the ticker readers and the trends rollups already skip).
--
-- STEP 0 FINDINGS (production, 2026-11-14, read-only SELECT in a READ ONLY transaction; no
-- secrets recorded)
--   * public.is_legal_notice(text, text, text): pg_get_functiondef on production gives a
--     body that is byte for byte the body of migration 210: md5(prosrc)
--     058d43141f193fbfafac5ed3dc135c86, length 1322 (tests/migrations/213-legal-notice-
--     tax-court.test.ts pins both on the 210 file, and checks that every code line of
--     210's body is in this migration's body, in order: this migration inserts two blocks
--     and changes nothing else). IMMUTABLE, SECURITY DEFINER, search_path '', acl postgres
--     + service_role.
--   * public.is_legal_notice(text, text): md5(prosrc) 21dda0ecf78d88db334f781872015ce2,
--     length 1876, the body of migration 107. NOT touched here.
--   * public.legal_notice_mark(timestamptz, timestamptz): md5(prosrc)
--     b31c204027e406034970c82277c9f1b9, length 616, the body of migration 210, which
--     already calls the 3-argument form. NOT touched here.
--   * cron.job 'legal-notice-mark' (jobid 55, active): schedule '23 */6 * * *'; it marks
--     the window [now - 30 hours, now + 3 hours) by published_at, so the new predicate
--     only ever marks RECENT rows (see BACKFILL). legal_notice_articles holds 869 rows
--     (2026-09-17 .. 2026-11-13). The ledger has 210 and 212, not 213.
--   * Cost: the new title test is one more NFC normalisation and one end-anchored regex
--     test per row, and the two description tests are literal substring tests on at most
--     500 characters; the per-letter title count runs only for a row that matches. As one
--     inline SELECT (EXPLAIN ANALYZE, TIMING OFF, read-only) over a whole day of articles
--     by published_at (10,092 rows on 2026-11-13): 172, 172 and 179 ms for the title
--     test and both description tests together, i.e. about 17 microseconds a row and
--     about 0.26 s more for a 15,000-row marker run.
--
-- REPLAY (production, 2026-10-14 .. 2026-11-14 by published_at, 32 one-day slices (the
-- last one partial), 315,715 articles; the JS predicate with the new rules against the
-- one at HEAD 1db90d3, on the title, url and the first 2,000 characters of the
-- description of every row)
--   * 388 rows were notices before, 404 are now: 16 NEW matches, 0 rows cleared (the
--     rules only add). Every one of the 16 was read: tax-office, enforcement-office and
--     court notices, no news story.
--       - the notice-heavy outlets: milat 2 (PENDİK and KOZYATAĞI VERGİ DAİRESİ
--         MÜDÜRLÜĞÜ), dirilis-postasi 3 (YENİBOSNA, KÜÇÜKÇEKMECE VERGİ DAİRESİ MÜDÜRLÜĞÜ,
--         BÜYÜKÇEKMECE İCRA DAİRESİ MÜDÜRLÜĞÜ), yeni-mesaj 2 (SİLİVRİ İCRA VE İFLAS
--         MÜDÜRLÜĞÜ, İSTANBUL ANADOLU BANKA ALACAKLARI İCRA DAİRESİ MÜDÜRLÜĞÜ), isci-haber 7
--         (the seven court notices: Batman 6. asliye hukuk, İstanbul 6. asliye ceza,
--         Bakırköy 11. asliye ceza, Kocaeli 3. sulh hukuk, Patnos 4. asliye hukuk, Ankara
--         50. iş, Bursa 41. asliye ceza);
--       - outside them, 2 rows: elips-haber 'Ankara 22. Aile Mahkemesi ilanı' (a family
--         court notice naming a respondent, the "known false negative" of 210's replay)
--         and yenicag 'T.C. Ankara Batı 3. Aile Mahkemesi İlan' (its description starts
--         with the capitals 'İLAN-', which 210's D1 does not read);
--       - 7 of the 16 have an SQL twin (the all-caps office rows, E1 and E2); the other 9
--         are decided by the TS-only court rule.
--   * None of the 16 carries a ticker and none was in legal_notice_articles; one is in a
--     cluster: milat PENDİK VERGİ DAİRESİ MÜDÜRLÜĞÜ in fe2c6725 (2 members, the other a
--     yeni-mesaj notice that was already caught), which becomes a notice-only cluster.
--   * SQL twin: E1 and E2 were also run as one inline READ ONLY SELECT per slice in
--     production's own Postgres (the function does not exist there yet; the same regexes,
--     the same NFC pass, the same letter gate): the same 27 article ids as the JS verdict
--     of E1 and E2 over the same 32 slices (0 only in JS, 0 only in SQL). 20 of the 27
--     were notices already (court, enforcement-office and municipality titles of 107,
--     from takvim, posta, cnn-turk, cumhuriyet and others); the 7 new ones are the
--     all-caps office rows above. The live block of the 213 test (CI job live-db,
--     tests/migrations/sql/run-live.sh) runs the shared truth table through the function.
--   * What stays, on purpose: the real story 'Anayasa Mahkemesi'nden Canan Karatay
--     Kararı: İfade Özgürlüğü Vurgusu' (isci-haber, the eighth row of that outlet's
--     fortnight) and every other news title; no title that ends in an ilan word and
--     names a court was left unflagged; four all-caps titles with another directorate at
--     the end (KADIKÖY BELEDİYE BŞK. YAZI İŞLERİ MÜDÜRLÜĞÜ, BOTAŞ DOĞAL GAZ İLETİM II.
--     BÖLGE MÜDÜRLÜĞÜ, TRAKYA SERBEST BÖLGE GÜMRÜK MÜDÜRLÜĞÜ, İSTANBUL DSİ 14. BÖLGE
--     MÜDÜRLÜĞÜ) are not offices of this rule; three elips-haber rows (a mixed-case
--     'Ankara Batı İcra Dairesi İlanı' twice and 'Ankara Sulh Hukuk Mahkemeleri Satış
--     Memurluğu', the new header in the description under a mixed-case title) stay
--     visible, because the description rules need the uppercase title. They are the known
--     residue of this change, like 'Kandıra sulh hukuk mahkemesi Kerpe'de 6 arsayı
--     satıyor'.
--
-- DESIGN
--   * public.is_legal_notice(p_title, p_url, p_description) is re-created with the
--     identical signature, volatility, SECURITY DEFINER, empty search_path, revoke and
--     grant (service_role only), and a body that is 210's with two inserted blocks:
--       E1  after the 2-argument verdict and BEFORE the NULL-description return (it needs
--           no description): the NFC title ends in a tax or enforcement office's own name
--           (ENDS_WITH_OFFICE) AND the title is mostly upper case (>= 8 letters, >= 0.85 of
--           them upper case, counted exactly as in 107 and 210);
--       E2  after D2, before the final return: the NFC description contains the case-
--           sensitive literal 'İLANEN TEBLİĞ' or 'GAZETE VEYA İNTERNET HABER SİTESİ İLANI'
--           AND the title is mostly upper case (the same gate).
--     Each regex below is the JS `.source` copied verbatim (ENDS_WITH_OFFICE of
--     LEGAL_NOTICE_TITLE_V2_PATTERNS, the two literals of LEGAL_NOTICE_DESCRIPTION_V2_
--     PATTERNS); tests/migrations/213-legal-notice-tax-court.test.ts fails the build on
--     drift. They are valid Postgres AREs unchanged (no lookaround, no `\-` escape, no
--     `\p{..}`, the hyphen last in its class, case-sensitive, anchored or literal, so
--     linear on any input). They live in two NEW objects, not in LEGAL_NOTICE_PATTERNS or
--     LEGAL_NOTICE_DESCRIPTION_PATTERNS, so migrations 107 and 210 keep embedding exactly
--     their own patterns and their parity tests stay as they are.
--   * The sentence-case court rule of the TS function (MIXED_COURT_NOTICE: a court-level
--     word, 'mahkemesi' within 40 characters, then the notice word (ilan, ilanı, ilanen
--     tebliğ or ilanen tebligat) directly after 'mahkemesi', after a space or after the
--     ablative -nden (apostrophe optional, at most 24 characters between), ending the
--     title) has no SQL twin on purpose. It lower-cases the title
--     with the Turkish locale, and case folding of İ and ı is not reliable in a POSIX
--     ARE (it follows the database collation). The /ekonomi ticker counts do not depend
--     on it: none of the nine rows it alone decides in the replay carries a ticker.
--   * public.is_legal_notice(text, text) of 107, public.legal_notice_mark and the cron job
--     are not touched. No UPDATE, no backfill, no cron change, no table, no index.
--
-- ACCEPTED DIVERGENCES from the JS predicate (documented, not tested)
--   * Those of 107 and 210: letters outside the Turkish/ASCII sets are not counted in the
--     SQL ratio (JS counts any \p{L}); `\s` follows the database locale in an ARE and
--     Unicode White_Space in JS; the ingest filter reads the RAW feed description (up to
--     20,000 units, then its first 2,000) while this function reads the STORED text
--     (markup stripped, entities decoded, cut at 500 characters).
--   * The sentence-case court rule: JS only (above). A row it alone decides stays out of
--     the ticker exclusion table; the page-level filters hide it all the same.
--
-- DEPLOY ORDER: none. The ingest function, the app and this migration are independent:
-- the app and the Edge Function do not call the 3-argument SQL function, and the SQL
-- function only feeds the ticker exclusion table. Ingest (supabase functions deploy
-- ingest --no-verify-jwt) stops storing the three families; the app (Vercel) hides the
-- stored ones on 'Son haberler' and noindexes a notice-only cluster.
--
-- VERIFY (read-only, after applying): md5(prosrc), length(prosrc) of
--   'public.is_legal_notice(text, text, text)'::regprocedure is 54eefa5648200c016f29e8583683ee65, 3071 (was
--   058d43141f193fbfafac5ed3dc135c86, 1322); has_function_privilege('anon', ..., 'execute') and ('authenticated', ...)
--   false, ('service_role', ...) true; the 2-argument function is still md5
--   21dda0ecf78d88db334f781872015ce2 and legal_notice_mark still
--   b31c204027e406034970c82277c9f1b9; select version, name from
--   supabase_migrations.schema_migrations where version = '213' returns one row. After the
--   app deploy (and its 1 h page cache), one request a second: GET /source/milat,
--   /source/dirilis-postasi and /source/isci-haber show no 'VERGİ DAİRESİ MÜDÜRLÜĞÜ' and no
--   'ilanen tebliğ' item under 'Son haberler'.
--
-- BACKFILL (operator, OPTIONAL, after applying this migration; do NOT run it inside the
-- migration). The cron only re-marks the last 30 hours. The page-level fixes (source 'Son
-- haberler', cluster noindex) need no marking. To also drop the older stored rows from the
-- ticker totals, run 107's loop (idempotent, one 2-day slice per statement):
--   for i in $(seq 30 -2 0); do
--     psql "$DATABASE_URL" -Atc "set statement_timeout = '2min'; select
--       public.legal_notice_mark(date_trunc('day', now()) - interval '$i days',
--       date_trunc('day', now()) - interval '$i days' + interval '2 days');"
--   done
--   Expect about 7 new rows in 30 days (the all-caps office rows of the replay; none of
--   the 16 carries a ticker, so the totals do not move).
--
-- ROLLBACK (nothing depends on the new blocks):
--   re-run the `create or replace function public.is_legal_notice(text, text, text)` block
--     of 210_legal_notice_description.sql (its body, comment, revoke and grant);
--   delete from supabase_migrations.schema_migrations where version = '213';
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

  -- E1 (migration 213): a tax office's or an enforcement office's own name at the end of a
  -- mostly upper case title ("KOZYATAĞI VERGİ DAİRESİ MÜDÜRLÜĞÜ", "SİLİVRİ İCRA VE İFLAS
  -- MÜDÜRLÜĞÜ"). It needs no description, so it runs before the NULL description return.
  -- The cheap regex test runs first; the per-letter title count only for a title that matches.
  if p_title is not null and p_title <> '' then
    v_t := pg_catalog.normalize(p_title, 'NFC');
    if v_t ~ '((V[Eİ]RG[İI]|[İI]CRA) DA[İI]RES[İI]|[İI]CRA VE [İI]FLAS) M[ÜU]D[ÜU]RL[ÜU][ĞG][ÜU][\s.:;,!-]*$' then
      v_up := pg_catalog.length(pg_catalog.regexp_replace(v_t, '[^A-ZÇĞİÖŞÜÂÎÛ]', '', 'g'));
      v_lo := pg_catalog.length(pg_catalog.regexp_replace(v_t, '[^a-zçğıöşüâîû]', '', 'g'));
      if v_up + v_lo >= 8
         and v_up >= 0.85 * (v_up + v_lo)
      then
        return true;
      end if;
    end if;
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

  -- E2 (migration 213): the notice's own header in the description ("İLANEN TEBLİĞ" of a
  -- tax office, "GAZETE VEYA İNTERNET HABER SİTESİ İLANI" of an enforcement office's sale
  -- notice), trusted only under a mostly upper case title, like D2. The two literal tests
  -- run first; the per-letter title count only for a row that has one.
  if p_title is not null and p_title <> ''
     and (
       v_d ~ 'İLANEN TEBLİĞ'
       or v_d ~ 'GAZETE VEYA İNTERNET HABER SİTESİ İLANI'
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
  '(migration 213, on top of migration 210): the 2-argument verdict of migration 107 on title and url, '
  'E1 a mostly-uppercase title that ends in a tax or enforcement office name (VERGİ DAİRESİ MÜDÜRLÜĞÜ, '
  'İCRA DAİRESİ MÜDÜRLÜĞÜ, İCRA VE İFLAS MÜDÜRLÜĞÜ), then the description rules: '
  'D1 the description starts with the word İlan and a dash (Yeniçağ notices), '
  'D2 a mostly-uppercase title and a tender marker (the 4734 sayılı Kamu İhale Kanunu sentence, '
  'the phrase İhale Kayıt Numarası, or a capitals İLAN header), '
  'E2 a mostly-uppercase title and the notice header İLANEN TEBLİĞ or GAZETE VEYA İNTERNET '
  'HABER SİTESİ İLANI in the description. The sentence-case court rule of the TS function (E3, TS only) has no SQL twin. '
  'IMMUTABLE, NULL-safe (never returns NULL). service_role only.';

revoke all on function public.is_legal_notice(text, text, text) from public, anon, authenticated;
grant execute on function public.is_legal_notice(text, text, text) to service_role;

-- 2. Marker, cron, data: unchanged. The legal-notice-mark job already calls
--    legal_notice_mark(), which already calls the 3-argument form by name; no backfill
--    or rewrite runs inside this migration.

insert into supabase_migrations.schema_migrations (version, name)
  values ('213', '213_legal_notice_tax_court')
  on conflict do nothing;

commit;
