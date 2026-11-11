-- 198 ASCII root deny set (collisions of 196's suffix-strip roots with other words): local PG15 dry-run. Never touches production.
--
-- Run on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir
--   $PGBIN/initdb -D $D -U postgres -A trust -E UTF8 --locale=en_US.UTF-8 >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55598 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55598 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql \
--     -f tests/migrations/sql/198-search-ascii-root-deny-collisions-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql PGHOST=/tmp PGPORT=55598 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/198-search-ascii-root-deny-collisions)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh    (TAYF_LIVE_ONLY=198 runs just this one)
--
-- (\ir paths below are relative to this file.) Every check is a DO block that raises on mismatch, so a clean run ending in
-- "DRYRUN 198 OK" is the pass. 198 is applied twice (re-apply safety). The database this leaves behind has 129, 166, 172, 185, 186, 194,
-- 196 and 198 applied and holds no fixture row (the live block of 198-search-ascii-root-deny-collisions.test.ts seeds its own, inside a
-- transaction).
--
-- Order: the 129 state (166-search-overstem-guard-setup.sql: search_tsv, 083's index, 129 itself), then 166, 172, 185, 186, 194 and 196
-- from their own files; 196 is gated on its two fingerprints (the helper md5 bcd7b393..., length 5077, and search_cluster_ids md5
-- c384c1f3..., length 19562: what production runs). 196's helper and function are kept as pg_temp.h196 and pg_temp.f196 (the installed text, the
-- function calling the copy), a fixture of stored Turkish headlines (the stems of 196's wanted widenings, the controls, and the seven collisions of
-- 198: for each, the row the word means and the unrelated row the colliding root pulled in), the answers of pg_temp.f196 (baseline: 196) to a
-- list of argument sets (the ASCII and the Turkish spelling of each word, as the app builds them); then 198 twice, ledger / shape / ACL of both
-- functions, the denied roles, the pinned output text of the helper (direct and through the app's pipeline), and the same list again. The
-- contract checked for every call: 198's id set is CONTAINED in 196's (a denied root only removes candidates); the seven collisions lose the
-- unrelated row and keep the right one; every widening of 196, every Turkish spelling and every control keeps EXACTLY 196's ids and order; the
-- roots that stay (tokat, tehdit, part) still widen; and the documented cost (the ASCII plural-possessive of a denied root). Then a fuzz of hostile
-- strings, URL tokens with an apostrophe among them, through the helper and the real function (no error).

\set ON_ERROR_STOP on

-- Prelude: Supabase default privileges (so the revokes have something to undo). ---------------------------
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;

-- The 129 state, then 166, 172, 185, 186, 194 and 196. -------------------------------------------------------------------
\ir 166-search-overstem-guard-setup.sql
\ir ../../../supabase/migrations/166_search_overstem_guard.sql
\ir ../../../supabase/migrations/172_search_exempt_word_tier.sql
\ir ../../../supabase/migrations/185_search_sibling_variants.sql
\ir ../../../supabase/migrations/186_search_stem_fold_arm.sql
\ir ../../../supabase/migrations/194_search_rank_display_title.sql
\ir ../../../supabase/migrations/196_search_ascii_inflection_roots.sql

-- 196 is the base: its helper (md5(prosrc) bcd7b393693a64a5f6123b0ebd855e3d, length 5077) and its function (c384c1f3a0dc337e5243b5a3e55985c0, 19562). -----
create temp table old_src as
  select p.prosrc as fn,
         (select h.prosrc from pg_catalog.pg_proc h where h.oid = 'public.tayf_ascii_inflection_expand(tsquery)'::regprocedure) as helper
    from pg_catalog.pg_proc p
   where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
do $$
declare
  v_fn text;
  v_helper text;
begin
  select fn, helper into v_fn, v_helper from old_src;
  assert md5(v_helper) = 'bcd7b393693a64a5f6123b0ebd855e3d' and length(v_helper) = 5077,
         format('196 helper md5 %s length %s (the base: bcd7b393..., 5077)', md5(v_helper), length(v_helper));
  assert md5(v_fn) = 'c384c1f3a0dc337e5243b5a3e55985c0' and length(v_fn) = 19562,
         format('196 function md5 %s length %s (the base: c384c1f3..., 19562)', md5(v_fn), length(v_fn));
  assert position('array[''ilisk'', ''turk'', ''sevk'']' in v_helper) > 0 and position('''mart''' in v_helper) = 0, '196''s deny set is the three-root literal';
  assert (length(v_fn) - length(replace(v_fn, 'public.tayf_ascii_inflection_expand(', ''))) = length('public.tayf_ascii_inflection_expand('), 'the function calls the helper exactly once, by name';
  assert (select count(*) from supabase_migrations.schema_migrations where version = '196') = 1, '196 must be applied';
  assert (select count(*) from supabase_migrations.schema_migrations where version = '198') = 0, '198 must not be applied yet';
  assert to_regclass('public.clusters_search_stemfold_live_idx') is not null, '186 built its index';
end $$;

-- 196's helper and function under temp names, to run beside 198's installed ones (same text, same attributes; the function calls the copy). ----
do $$
begin
  execute format(
    'create function pg_temp.h196(p tsquery) returns tsquery language plpgsql immutable strict parallel safe set search_path = %L as %L',
    '', (select helper from old_src));
  execute format(
    'create function pg_temp.f196(p_variants text[], p_folded text, p_limit integer default 12) returns table (id uuid) '
    || 'language sql stable set search_path = %L as %L',
    '', replace((select fn from old_src), 'public.tayf_ascii_inflection_expand(', 'pg_temp.h196('));
end $$;

-- Fixture (committed here, removed at the end). ids 00000000-0000-4000-8000-0000001980NN --------------------------------------------
create temp table fx (id uuid primary key, k text not null);
with v(n, k, title, neutral, summary, members, archived, age) as (values
  -- (a) emekli maaşı: the stored stems are emekli + maaş. mA holds the plural, mB the singular, mC only 'emekli', mD only 'maaş'
  (101, 'mA', 'Emekli maaşları için yeni formül masada', null, 'Hazırlık sürüyor.', 6, false, interval '4 days'),
  (102, 'mB', 'Emekli maaşı zammı açıklandı', null, 'Bakan konuştu.', 5, false, interval '3 days'),
  (103, 'mC', 'Emekliye bayram ikramiyesi müjdesi', null, 'Ödeme tarihi belli oldu.', 4, false, interval '2 days'),
  (104, 'mD', 'Memur maaşları için zam oranı belli oldu', null, 'Toplu sözleşme.', 4, false, interval '3 days'),
  -- (b) sığınak, (c) çocuk, (d) güvenlik, (e) kitap, (f) zam, (g) seçim sonuçları
  (111, 'sA', 'Depremzedeler için yeni sığınak kuruldu', null, 'Çalışma sürüyor.', 3, false, interval '2 days'),
  (112, 'sB', 'Sığınağa yerleşen aileler yardım bekliyor', null, 'Ekipler bölgede.', 3, false, interval '3 days'),
  (113, 'sC', 'Sığınaklar denetleniyor', null, 'Valilik açıkladı.', 2, false, interval '5 days'),
  (114, 'sD', 'Sığınmacılar için yeni düzenleme', null, 'Bakanlık açıkladı.', 2, false, interval '1 day'),
  (121, 'cA', 'Çocuğu kaybolan aile aranıyor', null, 'Polis ekipleri çalışıyor.', 3, false, interval '1 day'),
  (122, 'cB', 'Çocuk istismarı davasında karar çıktı', null, 'Mahkeme açıkladı.', 4, false, interval '2 days'),
  (123, 'cC', 'Çocuğun annesi gözaltına alındı', null, 'Soruşturma sürüyor.', 2, false, interval '4 days'),
  (131, 'gA', 'Okulların güvenliği artırıldı', null, 'Bakanlık duyurdu.', 3, false, interval '1 day'),
  (132, 'gB', 'Güvenlik toplantısı yapıldı', null, 'Kurul toplandı.', 2, false, interval '2 days'),
  (133, 'gC', 'Güvenliği sağlamak için yeni kural geldi', null, 'Karar yayımlandı.', 3, false, interval '3 days'),
  (141, 'kA', 'Yazarın kitapları toplatıldı', null, 'Karar çıktı.', 2, false, interval '2 days'),
  (142, 'kB', 'Kitabı yayımlandı', null, 'Yayınevi duyurdu.', 2, false, interval '3 days'),
  (151, 'zA', 'Asgari ücret zammı için masa kuruldu', null, 'Heyet toplanıyor.', 5, false, interval '2 days'),
  (152, 'zC', 'Asgari ücret zam oranı belli oldu', null, 'Beklenti sürüyor.', 4, false, interval '2 days'),
  (153, 'zD', 'Doğal gaza zam geldi', null, 'Tarife değişti.', 3, false, interval '1 day'),
  (161, 'secA', 'Seçim sonuçları açıklandı', null, 'Kurul sonuçları duyurdu.', 2, false, interval '15 hours'),
  (162, 'secB', 'Seçim sonucu kesinleşti', null, 'Yüksek Kurul açıkladı.', 3, false, interval '16 hours'),
  (163, 'secC', 'Seçim kampanyası başladı', null, 'Partiler sahada.', 2, false, interval '17 hours'),
  -- controls: a name, a province, the guard, the tier, the alias
  (171, 'imam1', 'İmamoğlu davasında yeni gelişme', null, 'Duruşma ertelendi.', 5, false, interval '2 days'),
  (172, 'imam2', 'İmamoğlu''nun avukatları açıklama yaptı', null, 'Savunma konuştu.', 3, false, interval '3 days'),
  (174, 'ozel', 'Özgür Özel miting yaptı', null, 'Kalabalık toplandı.', 3, false, interval '1 day'),
  (175, 'erd', 'Erdoğan açıklama yaptı', null, 'Cumhurbaşkanı konuştu.', 3, false, interval '1 day'),
  (176, 'iranA', 'İran açıklama yaptı', null, 'Bakanlık duyurdu.', 2, false, interval '2 days'),
  (181, 'burdur', 'Burdur''da yurt zehirlenmesi', null, 'Öğrenciler hastaneye kaldırıldı.', 2, false, interval '1 hour'),
  (182, 'bursa', 'Bursa''da deprem uyarısı', null, 'Uzmanlar uyardı.', 2, false, interval '2 hours'),
  (183, 'miller', 'Miller açıklama yaptı', null, 'Açıklama geldi.', 2, false, interval '10 hours'),
  (184, 'akp1', 'AKP''den açıklama', null, 'Parti sözcüsü konuştu.', 2, false, interval '16 hours'),
  (185, 'akp2', 'AK Parti toplantısı', null, 'Grup toplantısı yapıldı.', 3, false, interval '17 hours'),
  -- (h) 196's roots that are the stem of another word (geminate and deny set): hkB and ilB are the NEWER rows of the other word
  (201, 'hkA', 'Umut hakkı yeniden tartışılıyor', null, 'Tartışma sürüyor.', 3, false, interval '3 days'),
  (202, 'hkB', 'Bakan hakkında soruşturma başlatıldı', null, 'Savcılık açıkladı.', 3, false, interval '1 day'),
  (211, 'ilA', 'Yeni ilişki dönemi başladı', null, 'Taraflar görüştü.', 2, false, interval '2 days'),
  (212, 'ilB', 'Duruma ilişkin açıklama yapıldı', null, 'Sözcü konuştu.', 2, false, interval '1 day'),
  -- (i) 198's seven collisions: for each, the row the word means (the second of the pair) and the unrelated row the colliding root pulled in
  (301, 'mardM', 'Mart ayında kaza sayısı arttı', null, 'Emniyet verileri açıkladı.', 4, false, interval '2 days'),     -- stem mart: mardin -> mardi -> (d -> t) mart
  (302, 'mardK', 'Mardin''de kaza: üç yaralı', null, 'Yaralılar hastaneye kaldırıldı.', 3, false, interval '3 days'),
  (303, 'ny', 'New York Times yeni haberini yayımladı', null, 'Gazete açıklama yaptı.', 3, false, interval '1 day'),      -- stem york: yorgun -> yorgu -> (g -> k) york
  (304, 'yorg', 'Yorgun düşen futbolcu sahadan alındı', null, 'Antrenör konuştu.', 3, false, interval '2 days'),
  (305, 'kurtulmus', 'Kurtulmuş Kürt meselesinde yeni adım dedi', null, 'Meclis toplandı.', 3, false, interval '1 day'),  -- stem kürt (folded kurt): kurti -> kurt
  (306, 'kurti', 'Kurti Kosova hükümetini açıkladı', null, 'Priştine''de toplantı yapıldı.', 3, false, interval '2 days'),
  (307, 'karaya', 'Gemi karaya oturdu', null, 'Mürettebat kurtarıldı.', 3, false, interval '1 day'),                      -- stem kara: karasu -> kara
  (308, 'karasu', 'Karasu''da yangın çıktı', null, 'İtfaiye müdahale etti.', 3, false, interval '2 days'),
  (309, 'baskin', 'Polisten kumarhaneye baskın', null, 'Gözaltılar var.', 3, false, interval '1 day'),                   -- stem bask: baski -> bask
  (310, 'baski', 'Basın üzerindeki baskı artıyor', null, 'Gazeteciler tepki gösterdi.', 3, false, interval '2 days'),
  (311, 'toplum', 'Sivil toplum kuruluşları bildiri yayımladı', null, 'Çağrı yapıldı.', 3, false, interval '1 day'),     -- stem topl: toplu -> topl
  (312, 'toplu', 'Toplu ulaşıma zam geldi', null, 'Tarife değişti.', 3, false, interval '2 days'),
  (313, 'kars', 'Kars''ta yeni vali göreve başladı', null, 'Vali yolculuğa çıktı.', 3, false, interval '1 day'),         -- stem kars: karsi -> kars
  (314, 'karsi', 'Hükümete karşı çıktı', null, 'Muhalefet açıklama yaptı.', 3, false, interval '2 days'),
  (315, 'kurtA', 'Ormanda kurt sürüsü görüldü', null, 'Köylüler uyarıldı.', 3, false, interval '2 days'),                 -- stem kurt (the wolf): the real row of kurtlari / kurtları
  -- (j) roots that STAY: tokat (tokadi), tehdit (tehdidi), part (parti)
  (321, 'tokat', 'Gazeteciye tokat attı', null, 'Savcılık soruşturma başlattı.', 3, false, interval '2 days'),
  (322, 'tehdit', 'Avukata tehdit mesajı gönderildi', null, 'Baro açıklama yaptı.', 3, false, interval '2 days'),
  (323, 'part', 'Part zamanlı çalışma düzenlemesi geldi', null, 'Bakanlık duyurdu.', 3, false, interval '2 days'),
  -- archived and single-article rows are never candidates
  (191, 'arch', 'Emekli maaşları arşiv haberi', null, 'Arşivde.', 2, true, interval '11 hours'),
  (192, 'single', 'Emekli maaşları tek kaynaklı haber', null, 'Tek kaynak.', 1, false, interval '11 hours')
), ins as (
  insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at)
  select ('00000000-0000-4000-8000-000000198' || lpad(v.n::text, 3, '0'))::uuid, v.title, v.neutral, v.summary, v.members, v.archived, now() - v.age
    from v
  returning id
)
insert into fx select ('00000000-0000-4000-8000-000000198' || lpad(v.n::text, 3, '0'))::uuid, v.k from v;
analyze public.clusters;

-- The argument sets the app sends: the typed spellings (turkishQueryVariants), p_folded = foldTr(query). -------------
create temp table qs (q text primary key, variants text[] not null, folded text);
insert into qs values
  -- the seven collisions, as typed, and the pairs that must agree
  ('mardin kaza',          array['mardin kaza'],                        'mardin kaza'),
  ('mardin',               array['mardin'],                             'mardin'),
  ('yorgun',               array['yorgun'],                             'yorgun'),
  ('kurti',                array['kurti'],                              'kurti'),
  ('karasu',               array['karasu'],                             'karasu'),
  ('baskı',               array['baskı', 'baski'],                    'baski'),
  ('baski',                array['baski'],                              'baski'),
  ('toplu',                array['toplu'],                              'toplu'),
  ('karşı çıktı',        array['karşı çıktı', 'karşi çikti'],      'karsi cikti'),
  ('karsi cikti',          array['karsi cikti'],                        'karsi cikti'),
  -- the plural-possessive of a denied root (the documented cost), ASCII and Turkish
  ('kurtlari',             array['kurtlari'],                           'kurtlari'),
  ('kurtları',            array['kurtları', 'kurtlari'],              'kurtlari'),
  ('karalari',             array['karalari'],                           'karalari'),
  ('karaları',            array['karaları', 'karalari'],              'karalari'),
  -- 196's widenings, ASCII and Turkish
  ('emekli maasi',         array['emekli maasi'],                       'emekli maasi'),
  ('emekli maaşı',        array['emekli maaşı', 'emekli maaşi'],       'emekli maasi'),
  ('siginagi',             array['siginagi'],                           'siginagi'),
  ('sığınağı',            array['sığınağı', 'siğinaği'],               'siginagi'),
  ('maaslari',             array['maaslari'],                           'maaslari'),
  ('maaşları',            array['maaşları', 'maaşlari'],               'maaslari'),
  ('cocugu',               array['cocugu'],                             'cocugu'),
  ('çocuğu',              array['çocuğu'],                             'cocugu'),
  ('guvenligi',            array['guvenligi'],                          'guvenligi'),
  ('güvenliği',           array['güvenliği'],                           'guvenligi'),
  ('secim sonuclari',      array['secim sonuclari'],                    'secim sonuclari'),
  ('seçim sonuçları',     array['seçim sonuçları', 'seçim sonuçlari'], 'secim sonuclari'),
  -- controls and the roots that stay
  ('kitabi',               array['kitabi'],                             'kitabi'),
  ('kitabı',              array['kitabı', 'kitabi'],                   'kitabi'),
  ('asgari ucret zammi',   array['asgari ucret zammi'],                 'asgari ucret zammi'),
  ('asgari ucret zam',     array['asgari ucret zam'],                   'asgari ucret zam'),
  ('hakki',                array['hakki'],                              'hakki'),
  ('hakkı',               array['hakkı', 'hakki'],                    'hakki'),
  ('iliski',               array['iliski'],                             'iliski'),
  ('turku',                array['turku'],                              'turku'),
  ('sevgi',                array['sevgi'],                              'sevgi'),
  ('tokadi',               array['tokadi'],                             'tokadi'),
  ('tehdidi',              array['tehdidi'],                            'tehdidi'),
  ('parti',                array['parti'],                              'parti'),
  ('zam',                  array['zam'],                                'zam'),
  ('secim',                array['secim'],                              'secim'),
  ('iran',                 array['iran'],                               'iran'),
  ('erdogan',              array['erdogan'],                            'erdogan'),
  ('burdur',               array['burdur'],                             'burdur'),
  ('miller',               array['miller'],                             'miller'),
  ('imamoglu',             array['imamoglu'],                           'imamoglu'),
  ('imamoğlu',            array['imamoğlu'],                           'imamoglu'),
  ('deprem',               array['deprem'],                             'deprem'),
  ('akp alias',            array['akp or "ak parti"'],                  'akp or ak parti'),
  ('negated',              array['maaslari -memur'],                    'maaslari -memur'),
  ('negated phrase',       array['iran -"israil saldırısı"'],           'iran -"israil saldirisi"'),
  ('empty',                array[''],                                   ''),
  ('null folded',          array['burdur'],                             null),
  -- an apostrophe inside a URL token (a lexeme with a doubled quote in the stem query): answered, not raised
  ('a.com/x''maasi',       array['a.com/x''maasi'],                     'a.com/x''maasi'),
  ('x.co/a''maaslari',     array['x.co/a''maaslari'],                   'x.co/a''maaslari'),
  ('a.com/x''kurti',       array['a.com/x''kurti'],                     'a.com/x''kurti');

-- baseline: 196 (the base text, as pg_temp.f196) at p_limit 50, the way the app asks. ---------------------------------
create temp table res_before as
  select qs.q, t.n, t.id from qs cross join lateral pg_temp.f196(qs.variants, qs.folded, 50) with ordinality as t(id, n);

create function pg_temp.keys(p_tbl text, p_q text) returns text[]
language plpgsql as $f$
declare
  v text[];
begin
  execute format('select coalesce(array_agg(f.k order by r.n), ''{}'') from %I r join fx f on f.id = r.id where r.q = %L', p_tbl, p_q) into v;
  return v;
end $f$;

-- sorted keys of a result table: the id SET of a call
create function pg_temp.kset(p_tbl text, p_q text) returns text[]
language plpgsql as $f$
declare
  v text[];
begin
  execute format('select coalesce(array_agg(f.k order by f.k), ''{}'') from %I r join fx f on f.id = r.id where r.q = %L', p_tbl, p_q) into v;
  return v;
end $f$;

-- The defect is there on 196 (so the "after" below proves something): each colliding root pulls the unrelated row in. -----------------------------
do $$
begin
  assert pg_temp.kset('res_before', 'mardin kaza') = array['mardK', 'mardM'], format('baseline: mardin kaza returns the Mardin row AND the Mart row, got %s', pg_temp.kset('res_before', 'mardin kaza'));
  assert pg_temp.kset('res_before', 'mardin') = array['mardK', 'mardM'], format('baseline: mardin, got %s', pg_temp.kset('res_before', 'mardin'));
  assert pg_temp.kset('res_before', 'yorgun') = array['ny', 'yorg'], format('baseline: yorgun returns the New York row, got %s', pg_temp.kset('res_before', 'yorgun'));
  assert pg_temp.kset('res_before', 'kurti') = array['kurtA', 'kurti', 'kurtulmus'], format('baseline: kurti returns the Kurtulmuş and the wolf rows, got %s', pg_temp.kset('res_before', 'kurti'));
  assert pg_temp.kset('res_before', 'karasu') = array['karasu', 'karaya'], format('baseline: karasu returns the karaya row, got %s', pg_temp.kset('res_before', 'karasu'));
  assert pg_temp.kset('res_before', 'baski') = array['baski', 'baskin'] and pg_temp.kset('res_before', 'baskı') = array['baski', 'baskin'], format('baseline: baski and baskı return the baskın row, got %s and %s', pg_temp.kset('res_before', 'baski'), pg_temp.kset('res_before', 'baskı'));
  assert pg_temp.kset('res_before', 'toplu') = array['mD', 'toplu', 'toplum'], format('baseline: toplu returns the toplum row (and mD, whose summary says Toplu sözleşme), got %s', pg_temp.kset('res_before', 'toplu'));
  assert pg_temp.kset('res_before', 'karsi cikti') = array['kars', 'karsi'] and pg_temp.kset('res_before', 'karşı çıktı') = array['kars', 'karsi'], format('baseline: karşı çıktı returns the Kars row, got %s', pg_temp.kset('res_before', 'karşı çıktı'));
  -- the widenings of 196 and the roots that stay are in the baseline (the same as in 196's own dry-run)
  assert pg_temp.kset('res_before', 'emekli maasi') = array['mA', 'mB'], format('baseline: emekli maasi, got %s', pg_temp.kset('res_before', 'emekli maasi'));
  assert pg_temp.kset('res_before', 'siginagi') = array['sA', 'sB', 'sC'], 'baseline: siginagi';
  assert pg_temp.kset('res_before', 'tokadi') @> array['tokat'], 'baseline: tokadi finds the tokat row';
  assert pg_temp.kset('res_before', 'tehdidi') @> array['tehdit'], 'baseline: tehdidi finds the tehdit row';
  assert pg_temp.kset('res_before', 'parti') @> array['part'], 'baseline: parti finds the part row';
  assert pg_temp.kset('res_before', 'kurtlari') @> array['kurtA'], 'baseline: kurtlari reaches the kurt row through the root kurt';
  assert not (pg_temp.keys('res_before', 'emekli maasi') && array['arch', 'single']), 'baseline: archived and single-article rows are never candidates';
  assert (select max(c) from (select count(*) as c from res_before group by q) m) < 50, 'the fixture keeps every list far below the 50-row cap';
end $$;

-- Apply 198 TWICE (re-apply safety). --------------------------------------------------------------------------
create temp table idx_before as select indexname from pg_catalog.pg_indexes where schemaname = 'public' and tablename = 'clusters';
\ir ../../../supabase/migrations/198_search_ascii_root_deny_collisions.sql
\ir ../../../supabase/migrations/198_search_ascii_root_deny_collisions.sql

-- Ledger, shape and ACL after both runs -----------------------------------------------------------------------------
do $$
declare
  v_n integer;
  v_p pg_catalog.pg_proc%rowtype;
  v_h pg_catalog.pg_proc%rowtype;
  v_acl text;
begin
  select count(*) into v_n from supabase_migrations.schema_migrations where version = '198';
  assert v_n = 1, format('ledger rows for 198: %s (expected exactly 1)', v_n);
  assert (select name from supabase_migrations.schema_migrations where version = '198') = '198_search_ascii_root_deny_collisions', 'ledger name';
  assert (select count(*) from supabase_migrations.schema_migrations where version = '196') = 1, '196 ledger row is untouched';
  assert (select count(*) from supabase_migrations.schema_migrations where version in ('191', '197')) = 0, '198 writes no row for 191 or 197';

  -- search_cluster_ids: NOT touched: the same text, attributes and grants as 196 left them
  select count(*) into v_n from pg_catalog.pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'search_cluster_ids';
  assert v_n = 1, format('search_cluster_ids overloads: %s (expected 1: the stub carries no 083 two-argument function)', v_n);
  select * into v_p from pg_catalog.pg_proc where oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
  assert md5(v_p.prosrc) = 'c384c1f3a0dc337e5243b5a3e55985c0' and length(v_p.prosrc) = 19562,
         format('search_cluster_ids must stay 196''s: md5 %s length %s', md5(v_p.prosrc), length(v_p.prosrc));
  assert v_p.prosrc = (select fn from old_src), 'search_cluster_ids text is byte for byte what it was before 198';
  assert v_p.prosecdef and v_p.provolatile = 's' and v_p.proconfig = array['search_path=""'], 'search_cluster_ids attributes unchanged';
  assert obj_description(v_p.oid, 'pg_proc') like '%196%' and obj_description(v_p.oid, 'pg_proc') not like '%198%', 'search_cluster_ids comment is 196''s, untouched';
  assert not has_function_privilege('anon', v_p.oid, 'execute') and not has_function_privilege('authenticated', v_p.oid, 'execute') and has_function_privilege('service_role', v_p.oid, 'execute'), 'search_cluster_ids grants unchanged';

  -- the helper: plpgsql, IMMUTABLE, STRICT, PARALLEL SAFE, search_path '', not security definer, service_role only; its text is 196's with one literal changed
  select * into v_h from pg_catalog.pg_proc where oid = 'public.tayf_ascii_inflection_expand(tsquery)'::regprocedure;
  assert (select count(*) from pg_catalog.pg_proc where pronamespace = 'public'::regnamespace and proname = 'tayf_ascii_inflection_expand') = 1, 'helper overloads';
  assert (select l.lanname from pg_catalog.pg_language l where l.oid = v_h.prolang) = 'plpgsql', 'helper language plpgsql';
  assert v_h.provolatile = 'i', format('the helper must be IMMUTABLE, got %s', v_h.provolatile);
  assert v_h.proparallel = 's', format('the helper must be PARALLEL SAFE, got %s', v_h.proparallel);
  assert v_h.proisstrict, 'the helper must be STRICT';
  assert not v_h.prosecdef, 'the helper is not security definer';
  assert v_h.proconfig = array['search_path=""'], format('helper proconfig: %s', v_h.proconfig);
  assert pg_get_function_result(v_h.oid) = 'tsquery', format('helper result: %s', pg_get_function_result(v_h.oid));
  assert md5(v_h.prosrc) = 'e282da4628010153155d3bd8986db77f' and length(v_h.prosrc) = 5133,
         format('helper body md5 %s length %s (the file: e282da4628010153155d3bd8986db77f, 5133)', md5(v_h.prosrc), length(v_h.prosrc));
  assert md5(v_h.prosrc) <> 'bcd7b393693a64a5f6123b0ebd855e3d', 'the helper text must have changed';
  assert v_h.prosrc = replace((select helper from old_src), 'array[''ilisk'', ''turk'', ''sevk'']', 'array[''ilisk'', ''turk'', ''sevk'', ''mart'', ''york'', ''kurt'', ''kara'', ''bask'', ''topl'', ''kars'']'),
         'the helper is 196''s text with ONE literal changed (the deny set)';
  assert obj_description(v_h.oid, 'pg_proc') like '%198%' and obj_description(v_h.oid, 'pg_proc') like '%196%', 'helper comment must name 198 and 196';
  assert not has_function_privilege('anon', v_h.oid, 'execute'), 'anon must not execute the helper';
  assert not has_function_privilege('authenticated', v_h.oid, 'execute'), 'authenticated must not execute the helper';
  assert has_function_privilege('service_role', v_h.oid, 'execute'), 'service_role must execute the helper';
  assert not exists (select 1 from aclexplode(v_h.proacl) a where a.grantee = 0), 'PUBLIC must have no grant on the helper';
  select string_agg(a.grantee::regrole::text, ',' order by a.grantee::regrole::text) into v_acl from aclexplode(v_h.proacl) a;
  assert v_acl = 'postgres,service_role', format('helper grantees: %s', v_acl);

  -- 198 adds and drops no index and touches no other helper
  assert (select string_agg(indexname, ',' order by indexname) from pg_catalog.pg_indexes where schemaname = 'public' and tablename = 'clusters')
         = (select string_agg(indexname, ',' order by indexname) from idx_before), '198 changes no index';
  assert (select count(*) from pg_catalog.pg_proc where pronamespace = 'public'::regnamespace and proname = 'tayf_search_stem_fold') = 1, 'the helper of 186 is untouched';
  assert (select count(*) from pg_catalog.pg_proc where pronamespace = 'public'::regnamespace and proname = 'tayf_search_fold') = 1, 'fold overloads';
end $$;

-- Called as each role: anon and authenticated are denied; service_role runs both functions. -----------------------------
-- (test setup only, never a migration: the stub's clusters table has owner-only privileges, production's service_role reads it)
grant select, update on public.clusters to service_role;
do $$
declare
  v_role text;
  v_denied boolean;
  v_n bigint;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    v_denied := false;
    begin
      execute format('set local role %I', v_role);
      perform 1 from public.search_cluster_ids(array['maaslari'], 'maaslari', 24);
    exception when insufficient_privilege then
      v_denied := true;
    end;
    reset role;
    assert v_denied, format('%s must be denied the RPC', v_role);

    v_denied := false;
    begin
      execute format('set local role %I', v_role);
      perform public.tayf_ascii_inflection_expand(pg_catalog.to_tsquery('pg_catalog.simple', 'maasi'));
    exception when insufficient_privilege then
      v_denied := true;
    end;
    reset role;
    assert v_denied, format('%s must be denied the helper', v_role);
  end loop;

  set local role service_role;
  select count(*) into v_n from public.search_cluster_ids(array['maaslari'], 'maaslari', 24);
  assert v_n > 0, 'service_role must get rows from the RPC';
  assert public.tayf_ascii_inflection_expand(pg_catalog.to_tsquery('pg_catalog.simple', 'maasi')) is not null, 'service_role runs the helper';
  reset role;
end $$;

-- The helper's exact output (the text of the tsquery): directly (ex) and through the app's pipeline (exq: websearch_to_tsquery('turkish') of the
-- folded query, the fold, the helper). 196's helper (pg_temp.h196) prints the old roots on the same input. ---------------------------------------
create function pg_temp.ex(p text) returns text language sql as
  $$ select public.tayf_ascii_inflection_expand(pg_catalog.to_tsquery('pg_catalog.simple', p))::text $$;
create function pg_temp.ex196(p text) returns text language sql as
  $$ select pg_temp.h196(pg_catalog.to_tsquery('pg_catalog.simple', p))::text $$;
create function pg_temp.exq(p text) returns text language sql as
  $$ select public.tayf_ascii_inflection_expand(pg_catalog.to_tsquery('pg_catalog.simple', public.tayf_search_fold(pg_catalog.websearch_to_tsquery('pg_catalog.turkish', public.tayf_search_fold(p))::text)))::text $$;
create function pg_temp.exq196(p text) returns text language sql as
  $$ select pg_temp.h196(pg_catalog.to_tsquery('pg_catalog.simple', public.tayf_search_fold(pg_catalog.websearch_to_tsquery('pg_catalog.turkish', public.tayf_search_fold(p))::text)))::text $$;
do $$
declare
  w text;
  v_t tsquery;
begin
  -- the seven collisions, through the pipeline: 196 printed the colliding root, 198 does not
  assert pg_temp.exq196('mardin') = $t$'mardi' | 'mard' | 'mart'$t$, format('196 baseline mardin: %s', pg_temp.exq196('mardin'));
  assert pg_temp.exq('mardin') = $t$'mardi' | 'mard'$t$, format('mardin: %s', pg_temp.exq('mardin'));
  assert pg_temp.exq196('yorgun') = $t$'yorgu' | 'yorg' | 'york'$t$, format('196 baseline yorgun: %s', pg_temp.exq196('yorgun'));
  assert pg_temp.exq('yorgun') = $t$'yorgu' | 'yorg'$t$, format('yorgun: %s', pg_temp.exq('yorgun'));
  assert pg_temp.exq196('kurti') = $t$'kurti' | 'kurt'$t$, format('196 baseline kurti: %s', pg_temp.exq196('kurti'));
  assert pg_temp.exq('kurti') = $t$'kurti'$t$, format('kurti: %s', pg_temp.exq('kurti'));
  assert pg_temp.exq196('karasu') = $t$'karasu' | 'karas' | 'kara'$t$, format('196 baseline karasu: %s', pg_temp.exq196('karasu'));
  assert pg_temp.exq('karasu') = $t$'karasu' | 'karas'$t$, format('karasu: %s', pg_temp.exq('karasu'));
  assert pg_temp.exq196('baski') = $t$'baski' | 'bask'$t$ and pg_temp.exq196('baskı') = $t$'baski' | 'bask'$t$, '196 baseline baski and baskı';
  assert pg_temp.exq('baski') = $t$'baski'$t$, format('baski: %s', pg_temp.exq('baski'));
  assert pg_temp.exq('baskı') = $t$'baski'$t$, format('baskı (the Turkish spelling): %s', pg_temp.exq('baskı'));
  assert pg_temp.exq196('toplu') = $t$'toplu' | 'topl'$t$, format('196 baseline toplu: %s', pg_temp.exq196('toplu'));
  assert pg_temp.exq('toplu') = $t$'toplu'$t$, format('toplu: %s', pg_temp.exq('toplu'));
  assert pg_temp.exq196('karsi') = $t$'karsi' | 'kars'$t$ and pg_temp.exq196('karşı') = $t$'karsi' | 'kars'$t$, '196 baseline karsi and karşı';
  assert pg_temp.exq('karsi') = $t$'karsi'$t$ and pg_temp.exq('karşı') = $t$'karsi'$t$, format('karsi / karşı: %s / %s', pg_temp.exq('karsi'), pg_temp.exq('karşı'));
  -- with a second word: the group of the other word is kept, the denied root is not
  assert pg_temp.exq196('mardin kaza') = $t$( 'mardi' | 'mard' | 'mart' ) & 'kaz'$t$, format('196 baseline mardin kaza: %s', pg_temp.exq196('mardin kaza'));
  assert pg_temp.exq('mardin kaza') = $t$( 'mardi' | 'mard' ) & 'kaz'$t$, format('mardin kaza: %s', pg_temp.exq('mardin kaza'));
  assert pg_temp.exq196('karşı çıktı') = $t$( 'karsi' | 'kars' ) & 'cik'$t$, format('196 baseline karşı çıktı: %s', pg_temp.exq196('karşı çıktı'));
  assert pg_temp.exq('karşı çıktı') = $t$'karsi' & 'cik'$t$, format('karşı çıktı: %s', pg_temp.exq('karşı çıktı'));

  -- every 196 pin is unchanged
  assert pg_temp.ex('emekli & maasi') = $t$( 'emekli' | 'emekl' ) & ( 'maasi' | 'maas' )$t$, format('emekli & maasi: %s', pg_temp.ex('emekli & maasi'));
  assert pg_temp.ex('siginagi') = $t$'siginagi' | 'siginag' | 'siginak'$t$, format('siginagi: %s', pg_temp.ex('siginagi'));
  assert pg_temp.ex('maaslari') = $t$'maaslari' | 'maaslar' | 'maas'$t$, format('maaslari: %s', pg_temp.ex('maaslari'));
  assert pg_temp.ex('maaslarin') = $t$'maaslarin' | 'maas'$t$, format('maaslarin: %s', pg_temp.ex('maaslarin'));
  assert pg_temp.ex('guvenligi') = $t$'guvenligi' | 'guvenlig' | 'guvenlik'$t$, format('guvenligi: %s', pg_temp.ex('guvenligi'));
  assert pg_temp.ex('cocugu') = $t$'cocugu' | 'cocug' | 'cocuk'$t$, format('cocugu: %s', pg_temp.ex('cocugu'));
  assert pg_temp.ex('kitabi') = $t$'kitabi' | 'kitab' | 'kitap'$t$, format('kitabi (b -> p): %s', pg_temp.ex('kitabi'));
  assert pg_temp.ex('cildi') = $t$'cildi' | 'cild' | 'cilt'$t$, format('cildi (d -> t): %s', pg_temp.ex('cildi'));
  assert pg_temp.ex('vergisi') = $t$'vergisi' | 'vergis' | 'vergi'$t$, format('vergisi (R1 and R2): %s', pg_temp.ex('vergisi'));
  assert pg_temp.ex('cezasi') = $t$'cezasi' | 'cezas' | 'ceza'$t$, format('cezasi (R1 and R2): %s', pg_temp.ex('cezasi'));
  assert pg_temp.ex('sonuclari') = $t$'sonuclari' | 'sonuclar' | 'sonuc'$t$, format('sonuclari: %s', pg_temp.ex('sonuclari'));
  assert pg_temp.ex('sevgi') = $t$'sevgi' | 'sevg'$t$, format('sevgi: the root sevg, not the denied sevk, got %s', pg_temp.ex('sevgi'));
  assert pg_temp.ex('zammi') = $t$'zammi'$t$ and pg_temp.ex('hakki') = $t$'hakki'$t$ and pg_temp.ex('hissi') = $t$'hissi'$t$ and pg_temp.ex('hatti') = $t$'hatti'$t$, 'geminate roots stay out';
  assert pg_temp.ex('iliski') = $t$'iliski'$t$ and pg_temp.ex('turku') = $t$'turku'$t$, 'the 196 deny set stays';
  -- the roots that STAY: tokadi carries tokat, tehdidi carries tehdit, parti carries part (kenti carries kent)
  assert pg_temp.ex('tokadi') = $t$'tokadi' | 'tokad' | 'tokat'$t$, format('tokadi: %s', pg_temp.ex('tokadi'));
  assert pg_temp.ex('tehdidi') = $t$'tehdidi' | 'tehdid' | 'tehdit'$t$, format('tehdidi: %s', pg_temp.ex('tehdidi'));
  assert pg_temp.ex('parti') = $t$'parti' | 'part'$t$, format('parti: %s', pg_temp.ex('parti'));
  assert pg_temp.ex('kenti') = $t$'kenti' | 'kent'$t$, format('kenti: %s', pg_temp.ex('kenti'));
  -- the documented cost: the plural-possessive of a denied root (R3) loses the root, the other root of the rule stays
  assert pg_temp.ex196('kurtlari') = $t$'kurtlari' | 'kurtlar' | 'kurt'$t$ and pg_temp.ex('kurtlari') = $t$'kurtlari' | 'kurtlar'$t$, format('kurtlari: 196 %s, 198 %s', pg_temp.ex196('kurtlari'), pg_temp.ex('kurtlari'));
  assert pg_temp.ex196('karalari') = $t$'karalari' | 'karalar' | 'kara'$t$ and pg_temp.ex('karalari') = $t$'karalari' | 'karalar'$t$, format('karalari: 196 %s, 198 %s', pg_temp.ex196('karalari'), pg_temp.ex('karalari'));
  -- the colliding LEXEMES themselves, directly (the stem the Turkish stemmer gives): only the denied root leaves
  assert pg_temp.ex('mardi') = $t$'mardi' | 'mard'$t$ and pg_temp.ex('yorgu') = $t$'yorgu' | 'yorg'$t$ and pg_temp.ex('karasu') = $t$'karasu' | 'karas'$t$, 'mardi, yorgu, karasu keep their other root';
  assert pg_temp.ex('kurti') = $t$'kurti'$t$ and pg_temp.ex('baski') = $t$'baski'$t$ and pg_temp.ex('toplu') = $t$'toplu'$t$ and pg_temp.ex('karsi') = $t$'karsi'$t$, 'kurti, baski, toplu, karsi are unchanged';
  -- a negation, a phrase and an OR keep their operators around the groups
  assert pg_temp.ex('!maasi & x2024') = $t$!( 'maasi' | 'maas' ) & 'x2024'$t$, format('negation: %s', pg_temp.ex('!maasi & x2024'));
  assert pg_temp.ex('a <-> maasi') = $t$'a' <-> ( 'maasi' | 'maas' )$t$, format('phrase: %s', pg_temp.ex('a <-> maasi'));
  assert pg_temp.ex('!mardi & maasi') = $t$!( 'mardi' | 'mard' ) & ( 'maasi' | 'maas' )$t$, format('negated collision: %s', pg_temp.ex('!mardi & maasi'));
  -- unchanged: too short a root, no suffix, a digit, a suffix marker
  foreach w in array array['zam', 'iran', 'secim', 'kari', 'erdogan', 'deprem', 'bakan', 'ozel', 'burdur', '2024', 'covid19', 'maasi:*', 'maasi:A', 'ali', 'mart', 'york', 'kurt', 'kara', 'bask', 'topl', 'kars'] loop
    assert pg_temp.ex(w) = pg_catalog.to_tsquery('pg_catalog.simple', w)::text, format('%s must be unchanged, got %s', w, pg_temp.ex(w));
  end loop;
  -- a query that holds a doubled quote is returned as it is (196's guard)
  foreach w in array array['a.com/x''maasi', 'x.com/a''kitabi', 'a.com/x''kurti', 'x.co/a''cocugu''y', 'a.com/''maasi''', 'x.co/a''maaslari'] loop
    v_t := pg_catalog.to_tsquery('pg_catalog.simple', public.tayf_search_fold(pg_catalog.plainto_tsquery('pg_catalog.turkish', w)::text));
    assert public.tayf_ascii_inflection_expand(v_t)::text = v_t::text, format('a doubled-quote query must be returned unchanged: %s -> %s', v_t, public.tayf_ascii_inflection_expand(v_t));
  end loop;
  -- strict: null in, null out; an empty query is returned as it is
  assert public.tayf_ascii_inflection_expand(null::tsquery) is null, 'null in gives null out';
  assert public.tayf_ascii_inflection_expand(''::tsquery)::text = '', 'an empty query stays empty';
  -- 196's helper and 198's helper agree on every lexeme that has no denied root: the same text for the same input
  foreach w in array array['maasi', 'siginagi', 'maaslari', 'guvenligi', 'cocugu', 'kitabi', 'cildi', 'vergisi', 'cezasi', 'sonuclari', 'sevgi', 'zammi', 'hakki', 'iliski', 'turku', 'tokadi', 'tehdidi', 'parti', 'kenti', 'zam', 'iran', 'emekli & maasi', '!maasi & x2024', 'a <-> maasi'] loop
    assert pg_temp.ex(w) = pg_temp.ex196(w), format('%s must print the same under 196 and 198: %s vs %s', w, pg_temp.ex196(w), pg_temp.ex(w));
  end loop;
end $$;

-- The same argument sets after 198. --------------------------------------------------------------------------
create temp table res_after as
  select qs.q, t.n, t.id from qs cross join lateral public.search_cluster_ids(qs.variants, qs.folded, 50) with ordinality as t(id, n);

do $$
declare
  r record;
  v_before uuid[];
  v_after uuid[];
  v_keys text[];
  v_a text[];
  v_b text[];
  v_pair text[];
begin
  -- the contract, for every call: 198's id set is CONTAINED in 196's (a denied root only removes candidates), and no id repeats
  for r in select * from qs order by q loop
    select coalesce(array_agg(id order by id), '{}') into v_before from res_before where q = r.q;
    select coalesce(array_agg(id order by id), '{}') into v_after from res_after where q = r.q;
    assert v_before @> v_after, format('call "%s": 198 returned an id that 196 did not (%s -> %s)', r.q, v_before, v_after);
    assert (select count(*) from res_after where q = r.q) = (select count(distinct id) from res_after where q = r.q), format('call "%s": a duplicate id', r.q);
  end loop;

  -- the seven collisions: the unrelated row is gone and the right one stays
  assert pg_temp.kset('res_after', 'mardin kaza') = array['mardK'], format('mardin kaza: only the Mardin row, got %s', pg_temp.kset('res_after', 'mardin kaza'));
  assert pg_temp.kset('res_after', 'mardin') = array['mardK'], format('mardin: only the Mardin row, got %s', pg_temp.kset('res_after', 'mardin'));
  assert pg_temp.kset('res_after', 'yorgun') = array['yorg'], format('yorgun: no New York row, got %s', pg_temp.kset('res_after', 'yorgun'));
  assert pg_temp.kset('res_after', 'kurti') = array['kurti'], format('kurti: the Kurti row, not Kurtulmuş or the wolf, got %s', pg_temp.kset('res_after', 'kurti'));
  assert pg_temp.kset('res_after', 'karasu') = array['karasu'], format('karasu: the Karasu row, not karaya, got %s', pg_temp.kset('res_after', 'karasu'));
  assert pg_temp.kset('res_after', 'baski') = array['baski'] and pg_temp.kset('res_after', 'baskı') = array['baski'], format('baski, baskı: the baskı row, not baskın, got %s and %s', pg_temp.kset('res_after', 'baski'), pg_temp.kset('res_after', 'baskı'));
  assert pg_temp.kset('res_after', 'toplu') = array['mD', 'toplu'], format('toplu: the toplu row and mD (Toplu sözleşme), not toplum, got %s', pg_temp.kset('res_after', 'toplu'));
  assert pg_temp.kset('res_after', 'karsi cikti') = array['karsi'] and pg_temp.kset('res_after', 'karşı çıktı') = array['karsi'], format('karşı çıktı: no Kars row, got %s and %s', pg_temp.kset('res_after', 'karsi cikti'), pg_temp.kset('res_after', 'karşı çıktı'));
  assert not (pg_temp.keys('res_after', 'mardin kaza') && array['mardM']), 'a Mart row is not returned for mardin kaza';
  assert not (pg_temp.keys('res_after', 'kurti') && array['kurtulmus']) and pg_temp.keys('res_after', 'kurti') @> array['kurti'], 'a Kurtulmuş row is not returned for kurti, a Kurti row is';
  assert not (pg_temp.keys('res_after', 'baskı') && array['baskin']), 'a baskın row is not returned for baskı';
  -- the ASCII and the Turkish spelling of a collision find the same ids, in the same order
  assert pg_temp.keys('res_after', 'baski') = pg_temp.keys('res_after', 'baskı'), 'baski and baskı: the same order';
  assert pg_temp.keys('res_after', 'karsi cikti') = pg_temp.keys('res_after', 'karşı çıktı'), 'karsi cikti and karşı çıktı: the same order';

  -- every widening of 196, every Turkish spelling and every control keeps EXACTLY 196's ids AND order
  foreach v_pair slice 1 in array array[
      ['emekli maasi'], ['emekli maaşı'], ['siginagi'], ['sığınağı'], ['maaslari'], ['maaşları'], ['cocugu'], ['çocuğu'], ['guvenligi'], ['güvenliği'], ['secim sonuclari'], ['seçim sonuçları'],
      ['kitabi'], ['kitabı'], ['asgari ucret zammi'], ['asgari ucret zam'], ['hakki'], ['hakkı'], ['iliski'], ['turku'], ['sevgi'], ['tokadi'], ['tehdidi'], ['parti'],
      ['zam'], ['secim'], ['iran'], ['erdogan'], ['burdur'], ['miller'], ['imamoglu'], ['imamoğlu'], ['deprem'], ['akp alias'], ['negated'], ['negated phrase'], ['empty'], ['null folded'],
      ['a.com/x''maasi'], ['x.co/a''maaslari'], ['a.com/x''kurti']] loop
    assert pg_temp.keys('res_after', v_pair[1]) = pg_temp.keys('res_before', v_pair[1]),
           format('"%s" must keep 196''s ids and order: %s -> %s', v_pair[1], pg_temp.keys('res_before', v_pair[1]), pg_temp.keys('res_after', v_pair[1]));
  end loop;

  -- 196's widening is kept: the ASCII spelling still finds exactly what the Turkish spelling finds, in the same order, and finds more than 194 would have
  foreach v_pair slice 1 in array array[
      ['emekli maasi', 'emekli maaşı'], ['siginagi', 'sığınağı'], ['maaslari', 'maaşları'], ['cocugu', 'çocuğu'],
      ['guvenligi', 'güvenliği'], ['secim sonuclari', 'seçim sonuçları']] loop
    v_a := pg_temp.keys('res_after', v_pair[1]);
    v_b := pg_temp.keys('res_after', v_pair[2]);
    assert cardinality(v_b) >= 2, format('"%s" finds rows (not vacuous): %s', v_pair[2], v_b);
    assert pg_temp.kset('res_after', v_pair[1]) = pg_temp.kset('res_after', v_pair[2]),
           format('"%s" and "%s" must find the same ids: %s vs %s', v_pair[1], v_pair[2], v_a, v_b);
    assert v_a = v_b, format('"%s" and "%s" must list them in the same order: %s vs %s', v_pair[1], v_pair[2], v_a, v_b);
  end loop;
  assert pg_temp.kset('res_after', 'emekli maasi') = array['mA', 'mB'], format('emekli maasi: mA and mB, got %s', pg_temp.kset('res_after', 'emekli maasi'));
  assert pg_temp.kset('res_after', 'siginagi') = array['sA', 'sB', 'sC'], 'siginagi: the three sığınak rows, not sığınmacı';
  assert pg_temp.kset('res_after', 'maaslari') = array['mA', 'mB', 'mD'], format('maaslari: got %s', pg_temp.kset('res_after', 'maaslari'));
  assert pg_temp.kset('res_after', 'cocugu') = array['cA', 'cB', 'cC'], 'cocugu: the three çocuk rows';
  assert pg_temp.kset('res_after', 'guvenligi') = array['gA', 'gB', 'gC'], 'guvenligi: the three güvenlik rows';
  assert pg_temp.kset('res_after', 'secim sonuclari') = array['secA', 'secB'], 'secim sonuclari: sonuçları and sonucu, not the campaign row';
  assert pg_temp.kset('res_after', 'asgari ucret zam') = array['zC'], format('asgari ucret zam: zC, got %s', pg_temp.kset('res_after', 'asgari ucret zam'));
  assert pg_temp.kset('res_after', 'negated') = array['mA', 'mB'], format('maaslari -memur: mA and mB, got %s', pg_temp.kset('res_after', 'negated'));

  -- the roots that stay still widen
  assert pg_temp.keys('res_after', 'tokadi') @> array['tokat'], 'tokadi still finds the tokat row';
  assert pg_temp.keys('res_after', 'tehdidi') @> array['tehdit'], 'tehdidi still finds the tehdit row';
  assert pg_temp.keys('res_after', 'parti') @> array['part'], 'parti still finds the part row';

  -- the documented cost: the ASCII plural-possessive of a denied root no longer reaches its stem (the Turkish spelling does: the variants arm reads kurt)
  assert pg_temp.keys('res_before', 'kurtlari') @> array['kurtA'] and not (pg_temp.keys('res_after', 'kurtlari') && array['kurtA']), 'kurtlari: 196 reached the wolf row, 198 does not';
  assert pg_temp.keys('res_after', 'kurtları') @> array['kurtA'] and not (pg_temp.keys('res_after', 'kurtları') && array['kurtulmus']), 'kurtları (Turkish): the wolf row stays, the Kürt row (a collision) is gone';
  assert pg_temp.keys('res_before', 'karalari') @> array['karaya'] and not (pg_temp.keys('res_after', 'karalari') && array['karaya']), 'karalari: 196 reached the kara row, 198 does not';
  assert pg_temp.keys('res_after', 'karaları') @> array['karaya'], 'karaları (Turkish): the kara row stays';

  -- the 166 guard stays, the 172 tier stays, the alias keeps both spellings
  assert pg_temp.keys('res_after', 'burdur') = array['burdur'], format('burdur after: the guard keeps only the Burdur row, got %s', pg_temp.keys('res_after', 'burdur'));
  assert (pg_temp.keys('res_after', 'miller'))[1] = 'miller', 'miller: the tier still puts the Miller row first';
  v_keys := pg_temp.keys('res_after', 'akp alias');
  assert v_keys @> array['akp1', 'akp2'], format('akp alias: both party rows, got %s', v_keys);
  -- empty and null inputs
  assert (select count(*) from res_after where q = 'empty') = 0, 'the empty query finds nothing';
  assert pg_temp.keys('res_after', 'null folded') @> array['burdur'], format('a null p_folded runs and finds the variants arm rows, got %s', pg_temp.keys('res_after', 'null folded'));
end $$;

-- Fuzz: hostile strings go through the helper (as three kinds of tsquery) and the real function with the arguments the app would
-- build; none may raise. ------------------------------------------------------------------------------------------------
do $$
declare
  v_s text;
  v_n bigint;
  v_cases text[] := array[
    'a', 'ab', 'maasi', 'maaslari', 'emekli maasi', '"emekli maasi"', '-maasi', 'maasi or yurt', 'or', 'OR or Or', '(maasi)', 'maasi & yurt', 'maasi | yurt',
    '!maasi', 'maasi:*', 'maasi <-> yurt', 'maasi<->yurt', '<->', '<2>', '''', '''''', 'o''brien', 'a''b''c', 'maasi''', '''maasi', '\', '\\', 'a\b', '"', '""', '"a', 'a"',
    'a-b', 'a--b', '-a-b-', '- -', '---', 'covid-19', 'covid_19', 'x.y', '3.5', '192.168.1.1', 'a@b.c', 'http://x.y/z?q=1', '/usr/bin', 'ğüşıöç', 'ĞÜŞİÖÇ', 'ı', 'İ',
    'i̇', 'e'||chr(769), chr(775), 'a'||chr(775)||'b', chr(8217), 'x'||chr(8217)||'y', '😀', 'a😀b', 'ａｂｃ', 'ﬁ', repeat('a', 64), repeat('ı', 64), repeat('a ', 32),
    repeat('maasi ', 10), repeat('siginagi ', 7), repeat('maaslarin ', 6), 'zammi vergisi cezasi parti kitabi cildi',
    -- the denied roots and the colliding words themselves, alone and repeated
    'mardin', 'yorgun', 'kurti', 'karasu', 'baski', 'baskı', 'toplu', 'karsi', 'karşı çıktı', 'mart york kurt kara bask topl kars', 'mardi yorgu karasu kurti baski toplu karsi',
    repeat('mardin ', 9), repeat('karasu ', 9), '-mardin', '-"mardin kaza"', 'mardin or yorgun', '"mardin kaza"',
    -- an apostrophe inside a URL or file token (the doubled-quote guard)
    'a.com/x''maasi', 'x.com/a''kitabi', 'haber.com/x''maasi emekli', 'x.co/a''cocugu''y', 'a.com/''maasi''', 'x.co/a''maaslari', 'a.com/x''kurti', 'x.co/a''karasu',
    -- roots that are the stem of another word, and a word with a geminate root
    'hakki', 'hakkı', 'iliski', 'turku', 'sevgi', 'hissi', 'hatti', 'umut hakki', 'elektrik zammi',
    '1 2 3 4 5 6', '& & &', '| | |', '! ! !', '( ) ( )', ':* :*', 'a:', ':a', 'a:b', 'a:*b', 'null', '%', '_', '*', '?', ';', ',', '.', '[a]', '{a}', '^a$', '$1', 'a b c d e f g h',
    '[', '[[', '(?', '(?<=', '\d+', '.*', '^', '$', 'a|b', 'a)(b', 'imamoglu', 'yurt disi', 'veya', 've', 'bir', 'icin'
  ];
begin
  foreach v_s in array v_cases loop
    -- the helper on a plain, a websearch and a phrase-free reading of the text
    perform public.tayf_ascii_inflection_expand(pg_catalog.plainto_tsquery('pg_catalog.simple', v_s));
    perform public.tayf_ascii_inflection_expand(pg_catalog.websearch_to_tsquery('pg_catalog.simple', v_s));
    perform public.tayf_ascii_inflection_expand(pg_catalog.websearch_to_tsquery('pg_catalog.turkish', public.tayf_search_fold(v_s)));
    -- the app sends the lower-cased query as the variant and its fold as p_folded
    select count(*) into v_n from public.search_cluster_ids(array[lower(v_s)], public.tayf_search_fold(v_s), 5);
    select count(*) into v_n from public.search_cluster_ids(array[lower(v_s), lower(v_s) || ' x'], public.tayf_search_fold(v_s), 5);
  end loop;
  -- and a null variants array, a null folded query, a null limit
  select count(*) into v_n from public.search_cluster_ids(null, 'mardin', 5);
  select count(*) into v_n from public.search_cluster_ids(array['mardin'], null, 5);
  select count(*) into v_n from public.search_cluster_ids(array['mardin'], 'mardin', null);
end $$;

delete from public.clusters where id::text like '00000000-0000-4000-8000-000000198%';

\echo DRYRUN 198 OK
