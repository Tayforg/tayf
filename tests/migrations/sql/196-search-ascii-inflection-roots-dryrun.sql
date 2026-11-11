-- 196 ASCII inflection roots in the stem-fold arm: local PG15 dry-run. Never touches production.
--
-- Run on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir
--   $PGBIN/initdb -D $D -U postgres -A trust -E UTF8 --locale=en_US.UTF-8 >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55596 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55596 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql \
--     -f tests/migrations/sql/196-search-ascii-inflection-roots-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql PGHOST=/tmp PGPORT=55596 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/196-search-ascii-inflection-roots)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh    (TAYF_LIVE_ONLY=196 runs just this one)
--
-- (\ir paths below are relative to this file.) Every check is a DO block that raises on mismatch, so a clean run ending in
-- "DRYRUN 196 OK" is the pass. 196 is applied twice (re-apply safety). The database this leaves behind has 129, 166, 172, 185,
-- 186, 194 and 196 applied and holds no fixture row (the live block of 196-search-ascii-inflection-roots.test.ts seeds its
-- own, inside a transaction).
--
-- Order: the 129 state (166-search-overstem-guard-setup.sql: search_tsv, 083's index, 129 itself), then 166, 172, 185, 186
-- and 194 from their own files, 194 gated on its md5 (53eddcee..., length 18894: the base of 196, and what production runs); a
-- fixture of stored Turkish headlines (the stems maaş, sığınak, çocuk, güvenlik, sonuç, zam, hakkı, ilişki; the rows hakkında and ilişkin
-- are the ones a root that is the stem of another word would pull in) and of the controls 196 must not change; the answers of
-- 194's function (baseline: 194) to a list of argument sets, the ASCII spelling and the Turkish spelling of each word; then 196, ledger / shape / ACL of both functions, the denied roles, the pinned output text of the helper, and
-- the same list again. The contract checked for every call is: 196's id set contains 194's (the roots only ever add
-- candidates), a Turkish spelling and every control keep exactly their ids, the ASCII spelling of an inflected word finds exactly
-- what the Turkish spelling finds, a negation still excludes, and hakki, hakkı and iliski keep 194's ids and order (a geminate root
-- or a deny-set root is never added). Then a fuzz of hostile strings, URL tokens with an apostrophe among them (a.com/x'maasi: the
-- doubled-quote guard), through the helper and the real function (no error), and a synthetic load of 8,000 live clusters (rolled back): the plan keeps the three index scans, and
-- the timing is compared with EXPLAIN (ANALYZE).

\set ON_ERROR_STOP on

-- Prelude: Supabase default privileges (so the revokes have something to undo). ---------------------------
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;

-- The 129 state, then 166, 172, 185, 186 and 194. ------------------------------------------------------------------------
\ir 166-search-overstem-guard-setup.sql
\ir ../../../supabase/migrations/166_search_overstem_guard.sql
\ir ../../../supabase/migrations/172_search_exempt_word_tier.sql
\ir ../../../supabase/migrations/185_search_sibling_variants.sql
\ir ../../../supabase/migrations/186_search_stem_fold_arm.sql
\ir ../../../supabase/migrations/194_search_rank_display_title.sql

-- 194's body is the base (md5(prosrc) 53eddcee85dc444ef0e24ad7087f5b00, length 18894). ------------------------------
create temp table old_src as
  select p.prosrc from pg_catalog.pg_proc p
   where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
do $$
declare
  v_md5 text;
  v_len integer;
begin
  select md5(prosrc), length(prosrc) into v_md5, v_len from old_src;
  assert v_md5 = '53eddcee85dc444ef0e24ad7087f5b00', format('194 body md5 %s (the base: 53eddcee...)', v_md5);
  assert v_len = 18894, format('194 body length %s (the base: 18894)', v_len);
  assert (select count(*) from supabase_migrations.schema_migrations where version = '194') = 1, '194 must be applied';
  assert (select count(*) from supabase_migrations.schema_migrations where version = '196') = 0, '196 must not be applied yet';
  assert to_regclass('public.clusters_search_stemfold_live_idx') is not null, '186 built its index';
  assert to_regprocedure('public.tayf_ascii_inflection_expand(tsquery)') is null, 'the helper of 196 must not exist yet';
end $$;

-- 194's function under a temp name, to run beside 196's installed one (same text, same attributes). ---------------
do $$
begin
  execute format(
    'create function pg_temp.f194(p_variants text[], p_folded text, p_limit integer default 12) returns table (id uuid) '
    || 'language sql stable set search_path = %L as %L',
    '', (select prosrc from old_src));
end $$;

-- Fixture (committed here, removed at the end). ids 00000000-0000-4000-8000-0000001961NN ---------------------------------
create temp table fx (id uuid primary key, k text not null);
with v(n, k, title, neutral, summary, members, archived, age) as (values
  -- (a) emekli maaşı: the stored stems are emekli + maaş. mA holds the plural, mB the singular, mC only 'emekli', mD only 'maaş'
  (101, 'mA', 'Emekli maaşları için yeni formül masada', null, 'Hazırlık sürüyor.', 6, false, interval '4 days'),
  (102, 'mB', 'Emekli maaşı zammı açıklandı', null, 'Bakan konuştu.', 5, false, interval '3 days'),
  (103, 'mC', 'Emekliye bayram ikramiyesi müjdesi', null, 'Ödeme tarihi belli oldu.', 4, false, interval '2 days'),
  (104, 'mD', 'Memur maaşları için zam oranı belli oldu', null, 'Toplu sözleşme.', 4, false, interval '3 days'),
  -- (b) sığınak: the stored stem is sığınak; sD (sığınmacı) is another word
  (111, 'sA', 'Depremzedeler için yeni sığınak kuruldu', null, 'Çalışma sürüyor.', 3, false, interval '2 days'),
  (112, 'sB', 'Sığınağa yerleşen aileler yardım bekliyor', null, 'Ekipler bölgede.', 3, false, interval '3 days'),
  (113, 'sC', 'Sığınaklar denetleniyor', null, 'Valilik açıkladı.', 2, false, interval '5 days'),
  (114, 'sD', 'Sığınmacılar için yeni düzenleme', null, 'Bakanlık açıkladı.', 2, false, interval '1 day'),
  -- (c) çocuk and (d) güvenlik
  (121, 'cA', 'Çocuğu kaybolan aile aranıyor', null, 'Polis ekipleri çalışıyor.', 3, false, interval '1 day'),
  (122, 'cB', 'Çocuk istismarı davasında karar çıktı', null, 'Mahkeme açıkladı.', 4, false, interval '2 days'),
  (123, 'cC', 'Çocuğun annesi gözaltına alındı', null, 'Soruşturma sürüyor.', 2, false, interval '4 days'),
  (131, 'gA', 'Okulların güvenliği artırıldı', null, 'Bakanlık duyurdu.', 3, false, interval '1 day'),
  (132, 'gB', 'Güvenlik toplantısı yapıldı', null, 'Kurul toplandı.', 2, false, interval '2 days'),
  (133, 'gC', 'Güvenliği sağlamak için yeni kural geldi', null, 'Karar yayımlandı.', 3, false, interval '3 days'),
  -- (e) kitap: the stemmer already softens kitabi, so this is a control (the soft-letter root adds nothing)
  (141, 'kA', 'Yazarın kitapları toplatıldı', null, 'Karar çıktı.', 2, false, interval '2 days'),
  (142, 'kB', 'Kitabı yayımlandı', null, 'Yayınevi duyurdu.', 2, false, interval '3 days'),
  -- (f) zam: the sibling call of the app asks for 'zam' words. zA holds 'zammı' (its own lexeme), zC and zD 'zam'
  (151, 'zA', 'Asgari ücret zammı için masa kuruldu', null, 'Heyet toplanıyor.', 5, false, interval '2 days'),
  (152, 'zC', 'Asgari ücret zam oranı belli oldu', null, 'Beklenti sürüyor.', 4, false, interval '2 days'),
  (153, 'zD', 'Doğal gaza zam geldi', null, 'Tarife değişti.', 3, false, interval '1 day'),
  -- (g) seçim sonuçları: the stored stems are seçim + sonuç (sonuçları and sonucu both stem to sonuç)
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
  -- (h) roots that are the stem of ANOTHER word: the stemmer leaves hakkı, ilişki whole (stored stems hakkı, ilişki), while
  -- hakkında stems to hakk and ilişkin to ilişk. A root hakk or ilisk would pull the unrelated rows in (and, newer, push the real
  -- ones past the 1000-row cap on production). hkB is NEWER than hkA on purpose: recency would put it first.
  (201, 'hkA', 'Umut hakkı yeniden tartışılıyor', null, 'Tartışma sürüyor.', 3, false, interval '3 days'),
  (202, 'hkB', 'Bakan hakkında soruşturma başlatıldı', null, 'Savcılık açıkladı.', 3, false, interval '1 day'),
  (211, 'ilA', 'Yeni ilişki dönemi başladı', null, 'Taraflar görüştü.', 2, false, interval '2 days'),
  (212, 'ilB', 'Duruma ilişkin açıklama yapıldı', null, 'Sözcü konuştu.', 2, false, interval '1 day'),
  -- archived and single-article rows are never candidates
  (191, 'arch', 'Emekli maaşları arşiv haberi', null, 'Arşivde.', 2, true, interval '11 hours'),
  (192, 'single', 'Emekli maaşları tek kaynaklı haber', null, 'Tek kaynak.', 1, false, interval '11 hours')
), ins as (
  insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at)
  select ('00000000-0000-4000-8000-000000196' || lpad(v.n::text, 3, '0'))::uuid, v.title, v.neutral, v.summary, v.members, v.archived, now() - v.age
    from v
  returning id
)
insert into fx select ('00000000-0000-4000-8000-000000196' || lpad(v.n::text, 3, '0'))::uuid, v.k from v;
analyze public.clusters;

-- The argument sets the app sends: the typed spellings (turkishQueryVariants), p_folded = foldTr(query). -------------
create temp table qs (q text primary key, variants text[] not null, folded text);
insert into qs values
  ('emekli maasi',         array['emekli maasi'],                       'emekli maasi'),
  ('emekli maaşı',        array['emekli maaşı', 'emekli maaşi'],       'emekli maasi'),
  ('siginagi',             array['siginagi'],                           'siginagi'),
  ('sığınağı',            array['sığınağı', 'siğinaği'],               'siginagi'),
  ('maaslari',             array['maaslari'],                           'maaslari'),
  ('maaşları',            array['maaşları', 'maaşlari'],               'maaslari'),
  ('cocugu',               array['cocugu'],                             'cocugu'),
  ('çocuğu',              array['çocuğu'],                             'cocugu'),
  ('guvenligi',            array['guvenligi'],                          'guvenligi'),
  ('güvenliği',           array['güvenliği'],                          'guvenligi'),
  ('secim sonuclari',      array['secim sonuclari'],                    'secim sonuclari'),
  ('seçim sonuçları',     array['seçim sonuçları', 'seçim sonuçlari'], 'secim sonuclari'),
  ('kitabi',               array['kitabi'],                             'kitabi'),
  ('kitabı',              array['kitabı', 'kitabi'],                   'kitabi'),
  ('asgari ucret zammi',   array['asgari ucret zammi'],                 'asgari ucret zammi'),
  ('asgari ucret zam',     array['asgari ucret zam'],                   'asgari ucret zam'),
  ('dogal gaz zam',        array['dogal gaz zam'],                      'dogal gaz zam'),
  ('hakki',                array['hakki'],                              'hakki'),
  ('hakkı',               array['hakkı', 'hakki'],                    'hakki'),
  ('iliski',               array['iliski'],                             'iliski'),
  ('zam',                  array['zam'],                                'zam'),
  ('secim',                array['secim'],                              'secim'),
  ('iran',                 array['iran'],                               'iran'),
  ('erdogan',              array['erdogan'],                            'erdogan'),
  ('burdur',               array['burdur'],                             'burdur'),
  ('miller',               array['miller'],                             'miller'),
  ('imamoglu',             array['imamoglu'],                           'imamoglu'),
  ('imamoğlu',            array['imamoğlu'],                           'imamoglu'),
  ('ozgur ozel',           array['ozgur ozel'],                         'ozgur ozel'),
  ('özgür özel',          array['özgür özel'],                         'ozgur ozel'),
  ('akp alias',            array['akp or "ak parti"'],                  'akp or ak parti'),
  ('negated',              array['maaslari -memur'],                    'maaslari -memur'),
  ('negated phrase',       array['iran -"israil saldırısı"'],           'iran -"israil saldirisi"'),
  ('empty',                array[''],                                   ''),
  ('null folded',          array['burdur'],                             null);

-- baseline: 194 (the base body) at p_limit 50, the way the app asks. -------------------------------------------------
create temp table res_before as
  select qs.q, t.n, t.id from qs cross join lateral pg_temp.f194(qs.variants, qs.folded, 50) with ordinality as t(id, n);

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

-- The defect is there on the 194 body (so the "after" below proves something): an ASCII word with a suffix finds only part
-- of what its Turkish spelling finds. ------------------------------------------------------------------------------------
do $$
begin
  assert pg_temp.kset('res_before', 'emekli maasi') = array['mB'], format('baseline: emekli maasi finds only the singular row, got %s', pg_temp.kset('res_before', 'emekli maasi'));
  assert pg_temp.kset('res_before', 'emekli maaşı') = array['mA', 'mB'], format('baseline: emekli maaşı finds both, got %s', pg_temp.kset('res_before', 'emekli maaşı'));
  assert pg_temp.kset('res_before', 'siginagi') = array['sB'] and pg_temp.kset('res_before', 'sığınağı') = array['sA', 'sB', 'sC'], 'baseline: siginagi 1 row against 3';
  assert pg_temp.kset('res_before', 'maaslari') = array['mA', 'mD'] and pg_temp.kset('res_before', 'maaşları') = array['mA', 'mB', 'mD'], 'baseline: maaslari 2 rows against 3';
  assert pg_temp.kset('res_before', 'cocugu') = array['cA', 'cC'] and pg_temp.kset('res_before', 'çocuğu') = array['cA', 'cB', 'cC'], 'baseline: cocugu 2 rows against 3';
  assert pg_temp.kset('res_before', 'guvenligi') = array['gA', 'gC'] and pg_temp.kset('res_before', 'güvenliği') = array['gA', 'gB', 'gC'], 'baseline: guvenligi 2 rows against 3';
  assert pg_temp.kset('res_before', 'secim sonuclari') = array['secA'] and pg_temp.kset('res_before', 'seçim sonuçları') = array['secA', 'secB'], 'baseline: secim sonuclari 1 row against 2';
  -- the words whose Turkish stem is the word itself: 194 finds only the rows that carry hakkı / ilişki, not hakkında / ilişkin
  assert pg_temp.kset('res_before', 'hakki') = array['hkA'] and pg_temp.kset('res_before', 'hakkı') = array['hkA'],
         format('baseline: hakki and hakkı find only the hakkı row, got %s and %s', pg_temp.kset('res_before', 'hakki'), pg_temp.kset('res_before', 'hakkı'));
  assert pg_temp.kset('res_before', 'iliski') = array['ilA'], format('baseline: iliski finds only the ilişki row, got %s', pg_temp.kset('res_before', 'iliski'));
  assert not (pg_temp.keys('res_before', 'emekli maasi') && array['arch', 'single']), 'baseline: archived and single-article rows are never candidates';
  assert (select max(c) from (select count(*) as c from res_before group by q) m) < 50, 'the fixture keeps every list far below the 50-row cap';
end $$;

-- Apply 196 TWICE (re-apply safety). --------------------------------------------------------------------------
create temp table idx_before as select indexname from pg_catalog.pg_indexes where schemaname = 'public' and tablename = 'clusters';
\ir ../../../supabase/migrations/196_search_ascii_inflection_roots.sql
\ir ../../../supabase/migrations/196_search_ascii_inflection_roots.sql

-- Ledger, shape and ACL after both runs -----------------------------------------------------------------------------
do $$
declare
  v_n integer;
  v_p pg_catalog.pg_proc%rowtype;
  v_h pg_catalog.pg_proc%rowtype;
  v_acl text;
begin
  select count(*) into v_n from supabase_migrations.schema_migrations where version = '196';
  assert v_n = 1, format('ledger rows for 196: %s (expected exactly 1)', v_n);
  assert (select name from supabase_migrations.schema_migrations where version = '196') = '196_search_ascii_inflection_roots', 'ledger name';
  assert (select count(*) from supabase_migrations.schema_migrations where version = '194') = 1, '194 ledger row is untouched';

  -- search_cluster_ids: same signature, same attributes, the new body, grants as before
  select count(*) into v_n from pg_catalog.pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'search_cluster_ids';
  assert v_n = 1, format('search_cluster_ids overloads: %s (expected 1: the stub carries no 083 two-argument function)', v_n);
  select * into v_p from pg_catalog.pg_proc where oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
  assert v_p.prosecdef, 'must be SECURITY DEFINER';
  assert v_p.provolatile = 's', format('must be STABLE, got %s', v_p.provolatile);
  assert v_p.proretset, 'must return a set';
  assert v_p.proconfig = array['search_path=""'], format('proconfig: %s', v_p.proconfig);
  assert (select l.lanname from pg_catalog.pg_language l where l.oid = v_p.prolang) = 'sql', 'language sql';
  assert pg_get_function_arguments(v_p.oid) = 'p_variants text[], p_folded text, p_limit integer DEFAULT 12',
         format('arguments: %s', pg_get_function_arguments(v_p.oid));
  assert pg_get_function_result(v_p.oid) = 'TABLE(id uuid)', format('result: %s', pg_get_function_result(v_p.oid));
  assert obj_description(v_p.oid, 'pg_proc') like '%196%' and obj_description(v_p.oid, 'pg_proc') like '%ASCII%', 'function comment must mention 196 and the ASCII roots';
  assert md5(v_p.prosrc) <> '53eddcee85dc444ef0e24ad7087f5b00', 'the body must have changed';
  assert md5(v_p.prosrc) = 'c384c1f3a0dc337e5243b5a3e55985c0' and length(v_p.prosrc) = 19562,
         format('196 body md5 %s length %s (the file: c384c1f3a0dc337e5243b5a3e55985c0, 19562)', md5(v_p.prosrc), length(v_p.prosrc));
  assert not has_function_privilege('anon', v_p.oid, 'execute'), 'anon must not execute';
  assert not has_function_privilege('authenticated', v_p.oid, 'execute'), 'authenticated must not execute';
  assert has_function_privilege('service_role', v_p.oid, 'execute'), 'service_role must execute';
  assert not exists (select 1 from aclexplode(v_p.proacl) a where a.grantee = 0), 'PUBLIC must have no grant';
  select string_agg(a.grantee::regrole::text, ',' order by a.grantee::regrole::text) into v_acl from aclexplode(v_p.proacl) a;
  assert v_acl = 'postgres,service_role', format('grantees: %s', v_acl);

  -- the helper: plpgsql, IMMUTABLE, STRICT, PARALLEL SAFE, search_path '', not security definer, service_role only
  select * into v_h from pg_catalog.pg_proc where oid = 'public.tayf_ascii_inflection_expand(tsquery)'::regprocedure;
  assert (select count(*) from pg_catalog.pg_proc where pronamespace = 'public'::regnamespace and proname = 'tayf_ascii_inflection_expand') = 1, 'helper overloads';
  assert (select l.lanname from pg_catalog.pg_language l where l.oid = v_h.prolang) = 'plpgsql', 'helper language plpgsql';
  assert v_h.provolatile = 'i', format('the helper must be IMMUTABLE, got %s', v_h.provolatile);
  assert v_h.proparallel = 's', format('the helper must be PARALLEL SAFE, got %s', v_h.proparallel);
  assert v_h.proisstrict, 'the helper must be STRICT';
  assert not v_h.prosecdef, 'the helper is not security definer';
  assert v_h.proconfig = array['search_path=""'], format('helper proconfig: %s', v_h.proconfig);
  assert pg_get_function_result(v_h.oid) = 'tsquery', format('helper result: %s', pg_get_function_result(v_h.oid));
  assert md5(v_h.prosrc) = 'bcd7b393693a64a5f6123b0ebd855e3d' and length(v_h.prosrc) = 5077,
         format('helper body md5 %s length %s (the file: bcd7b393693a64a5f6123b0ebd855e3d, 5077)', md5(v_h.prosrc), length(v_h.prosrc));
  assert obj_description(v_h.oid, 'pg_proc') like '%196%', 'helper comment must name 196';
  assert not has_function_privilege('anon', v_h.oid, 'execute'), 'anon must not execute the helper';
  assert not has_function_privilege('authenticated', v_h.oid, 'execute'), 'authenticated must not execute the helper';
  assert has_function_privilege('service_role', v_h.oid, 'execute'), 'service_role must execute the helper';
  assert not exists (select 1 from aclexplode(v_h.proacl) a where a.grantee = 0), 'PUBLIC must have no grant on the helper';
  select string_agg(a.grantee::regrole::text, ',' order by a.grantee::regrole::text) into v_acl from aclexplode(v_h.proacl) a;
  assert v_acl = 'postgres,service_role', format('helper grantees: %s', v_acl);

  -- 196 adds and drops no index and touches no other helper: 186's objects are untouched
  assert (select string_agg(indexname, ',' order by indexname) from pg_catalog.pg_indexes where schemaname = 'public' and tablename = 'clusters')
         = (select string_agg(indexname, ',' order by indexname) from idx_before), '196 changes no index';
  assert to_regclass('public.clusters_search_stemfold_live_idx') is not null, '186 index still there';
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

-- The helper's exact output (the text of the tsquery). ------------------------------------------------------------------
create function pg_temp.ex(p text) returns text language sql as
  $$ select public.tayf_ascii_inflection_expand(pg_catalog.to_tsquery('pg_catalog.simple', p))::text $$;
do $$
declare
  w text;
  v_t tsquery;
begin
  assert pg_temp.ex('emekli & maasi') = $t$( 'emekli' | 'emekl' ) & ( 'maasi' | 'maas' )$t$, format('emekli & maasi: %s', pg_temp.ex('emekli & maasi'));
  assert pg_temp.ex('siginagi') = $t$'siginagi' | 'siginag' | 'siginak'$t$, format('siginagi: %s', pg_temp.ex('siginagi'));
  assert pg_temp.ex('maaslari') = $t$'maaslari' | 'maaslar' | 'maas'$t$, format('maaslari: %s', pg_temp.ex('maaslari'));
  assert pg_temp.ex('maaslarin') = $t$'maaslarin' | 'maas'$t$, format('maaslarin: %s', pg_temp.ex('maaslarin'));
  assert pg_temp.ex('guvenligi') = $t$'guvenligi' | 'guvenlig' | 'guvenlik'$t$, format('guvenligi: %s', pg_temp.ex('guvenligi'));
  assert pg_temp.ex('cocugu') = $t$'cocugu' | 'cocug' | 'cocuk'$t$, format('cocugu: %s', pg_temp.ex('cocugu'));
  assert pg_temp.ex('kitabi') = $t$'kitabi' | 'kitab' | 'kitap'$t$, format('kitabi (b -> p): %s', pg_temp.ex('kitabi'));
  assert pg_temp.ex('cildi') = $t$'cildi' | 'cild' | 'cilt'$t$, format('cildi (d -> t): %s', pg_temp.ex('cildi'));
  assert pg_temp.ex('vergisi') = $t$'vergisi' | 'vergis' | 'vergi'$t$, format('vergisi (R1 and R2): %s', pg_temp.ex('vergisi'));
  assert pg_temp.ex('sonuclari') = $t$'sonuclari' | 'sonuclar' | 'sonuc'$t$, format('sonuclari: %s', pg_temp.ex('sonuclari'));
  -- R1 skips a root that ends in a doubled consonant (zamm, hakk, hiss, hatt, sirr, redd: the GEMINATE_ROOTS of turkish-query.ts): the
  -- stemmer leaves zammi, hakki, hissi whole, so such a root is the stem of ANOTHER word (hakkında -> hakk), never of the lexeme
  assert pg_temp.ex('zammi') = $t$'zammi'$t$, format('zammi: unchanged (geminate root zamm), got %s', pg_temp.ex('zammi'));
  assert pg_temp.ex('hakki') = $t$'hakki'$t$, format('hakki: unchanged (geminate root hakk), got %s', pg_temp.ex('hakki'));
  -- a closed deny set of roots that are the stem of another frequent word (ilişkin -> ilisk, türk -> turk, sevk): R1 reaches them from
  -- iliski, turku and (the soft letter of) sevgi; the root sevg of sevgi matches no stored stem, and stays
  assert pg_temp.ex('iliski') = $t$'iliski'$t$, format('iliski: unchanged (deny set ilisk), got %s', pg_temp.ex('iliski'));
  assert pg_temp.ex('turku') = $t$'turku'$t$, format('turku: unchanged (deny set turk), got %s', pg_temp.ex('turku'));
  assert pg_temp.ex('sevgi') = $t$'sevgi' | 'sevg'$t$, format('sevgi: the root sevg, not the denied sevk, got %s', pg_temp.ex('sevgi'));
  -- a documented limit: parti has the root 'part' (104 live stories carry that stem), kept on purpose
  assert pg_temp.ex('parti') = $t$'parti' | 'part'$t$, format('parti: %s', pg_temp.ex('parti'));
  -- a negation, a phrase and an OR keep their operators around the groups
  assert pg_temp.ex('!maasi & x2024') = $t$!( 'maasi' | 'maas' ) & 'x2024'$t$, format('negation: %s', pg_temp.ex('!maasi & x2024'));
  assert pg_temp.ex('a <-> maasi') = $t$'a' <-> ( 'maasi' | 'maas' )$t$, format('phrase: %s', pg_temp.ex('a <-> maasi'));
  -- (an OR of groups is printed flat by Postgres: the same query)
  assert pg_temp.ex('maasi | zam') = $t$'maasi' | 'maas' | 'zam'$t$, format('or: %s', pg_temp.ex('maasi | zam'));
  -- unchanged: too short a root ('kar' is 3 letters), no suffix, a digit, a lexeme with a suffix marker, a lexeme that is its own root
  foreach w in array array['zam', 'iran', 'secim', 'kari', 'erdogan', 'deprem', 'bakan', 'ozel', 'burdur', '2024', 'covid19', 'maasi:*', 'maasi:A', 'ali',
                           'zammi', 'hakki', 'iliski', 'turku', 'hissi', 'hatti'] loop
    assert pg_temp.ex(w) = pg_catalog.to_tsquery('pg_catalog.simple', w)::text, format('%s must be unchanged, got %s', w, pg_temp.ex(w));
  end loop;
  -- a query that holds a doubled quote (a lexeme with an apostrophe inside it: tsquery prints a quote inside a lexeme as two quotes, and
  -- nothing else prints two adjacent quotes) is returned as it is: the [a-z] pattern could match INSIDE such a lexeme, and the rewritten
  -- text would not parse back (ERROR 42601 on 'a.com/x'( 'maasi' | 'maas' )). The query of the 194 function, the helper's own input:
  foreach w in array array['a.com/x''maasi', 'x.com/a''kitabi', 'haber.com/x''maasi emekli', 'x.co/a''cocugu''y', 'a.com/''maasi''', 'x.co/a''maaslari'] loop
    v_t := pg_catalog.to_tsquery('pg_catalog.simple', public.tayf_search_fold(pg_catalog.plainto_tsquery('pg_catalog.turkish', w)::text));
    assert public.tayf_ascii_inflection_expand(v_t)::text = v_t::text, format('a doubled-quote query must be returned unchanged: %s -> %s', v_t, public.tayf_ascii_inflection_expand(v_t));
  end loop;
  v_t := pg_catalog.to_tsquery('pg_catalog.simple', public.tayf_search_fold(pg_catalog.plainto_tsquery('pg_catalog.turkish', 'a.com/x''maasi')::text));
  assert pg_catalog.strpos(v_t::text, '''''') > 0, format('the fixture query holds a doubled quote: %s', v_t);
  assert public.tayf_ascii_inflection_expand(v_t)::text = v_t::text, 'a.com/x''maasi: unchanged';
  -- strict: null in, null out; an empty query is returned as it is
  assert public.tayf_ascii_inflection_expand(null::tsquery) is null, 'null in gives null out';
  assert public.tayf_ascii_inflection_expand(''::tsquery)::text = '', 'an empty query stays empty';
  -- deterministic: the same argument gives the same text, whatever the order the lexemes were typed in
  assert pg_temp.ex('maasi & emekli') = $t$( 'maasi' | 'maas' ) & ( 'emekli' | 'emekl' )$t$, format('typed order is kept: %s', pg_temp.ex('maasi & emekli'));
  assert pg_temp.ex('maasi & maasi') = pg_temp.ex('maasi & maasi'), 'repeatable';
  -- a lexeme that is also a root of another lexeme of the same query is still expanded once, as itself
  assert pg_temp.ex('vergisi & vergi') = $t$( 'vergisi' | 'vergis' | 'vergi' ) & ( 'vergi' | 'verg' | 'verk' )$t$, format('vergisi & vergi: %s', pg_temp.ex('vergisi & vergi'));
end $$;

-- The same argument sets after 196. --------------------------------------------------------------------------
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
  -- the contract, for every call: 196's id set CONTAINS 194's (the roots only add candidates), and no id repeats
  for r in select * from qs order by q loop
    select coalesce(array_agg(id order by id), '{}') into v_before from res_before where q = r.q;
    select coalesce(array_agg(id order by id), '{}') into v_after from res_after where q = r.q;
    assert v_after @> v_before, format('call "%s": 196 lost an id of 194 (%s -> %s)', r.q, v_before, v_after);
    assert (select count(*) from res_after where q = r.q) = (select count(distinct id) from res_after where q = r.q), format('call "%s": a duplicate id', r.q);
  end loop;

  -- every Turkish spelling, and every control, keeps EXACTLY its ids (the roots add nothing where the stems were already stored)
  foreach v_pair slice 1 in array array[
      ['emekli maaşı'], ['sığınağı'], ['maaşları'], ['çocuğu'], ['güvenliği'], ['seçim sonuçları'], ['kitabi'], ['kitabı'],
      ['asgari ucret zammi'], ['asgari ucret zam'], ['dogal gaz zam'], ['hakki'], ['hakkı'], ['iliski'], ['zam'], ['secim'], ['iran'], ['erdogan'], ['burdur'], ['miller'],
      ['imamoglu'], ['imamoğlu'], ['ozgur ozel'], ['özgür özel'], ['akp alias'], ['negated phrase'], ['empty'], ['null folded']] loop
    assert pg_temp.kset('res_after', v_pair[1]) = pg_temp.kset('res_before', v_pair[1]),
           format('"%s" must keep its ids: %s -> %s', v_pair[1], pg_temp.kset('res_before', v_pair[1]), pg_temp.kset('res_after', v_pair[1]));
  end loop;

  -- a root that is the stem of another word is not added: hakki, hakkı and iliski keep 194's ids AND 194's order, and the rows of
  -- the other word (hakkında, ilişkin) stay out, newer or not
  foreach v_pair slice 1 in array array[['hakki'], ['hakkı'], ['iliski']] loop
    assert pg_temp.keys('res_after', v_pair[1]) = pg_temp.keys('res_before', v_pair[1]),
           format('"%s" must keep 194''s order: %s -> %s', v_pair[1], pg_temp.keys('res_before', v_pair[1]), pg_temp.keys('res_after', v_pair[1]));
    assert not (pg_temp.keys('res_after', v_pair[1]) && array['hkB', 'ilB']),
           format('"%s" must not pull in a hakkında or ilişkin row: %s', v_pair[1], pg_temp.keys('res_after', v_pair[1]));
  end loop;
  assert pg_temp.keys('res_after', 'hakki') = array['hkA'] and pg_temp.keys('res_after', 'hakkı') = array['hkA'], 'hakki and hakkı: the hakkı row only';
  assert pg_temp.keys('res_after', 'iliski') = array['ilA'], 'iliski: the ilişki row only';

  -- the ASCII spelling of an inflected word finds exactly what the Turkish spelling finds, and in the same order (the same
  -- p_folded: the score depends on p_folded and the title only)
  foreach v_pair slice 1 in array array[
      ['emekli maasi', 'emekli maaşı'], ['siginagi', 'sığınağı'], ['maaslari', 'maaşları'], ['cocugu', 'çocuğu'],
      ['guvenligi', 'güvenliği'], ['secim sonuclari', 'seçim sonuçları']] loop
    v_a := pg_temp.keys('res_after', v_pair[1]);
    v_b := pg_temp.keys('res_after', v_pair[2]);
    assert cardinality(v_b) >= 2, format('"%s" finds rows (not vacuous): %s', v_pair[2], v_b);
    assert pg_temp.kset('res_after', v_pair[1]) = pg_temp.kset('res_after', v_pair[2]),
           format('"%s" and "%s" must find the same ids: %s vs %s', v_pair[1], v_pair[2], v_a, v_b);
    assert v_a = v_b, format('"%s" and "%s" must list them in the same order: %s vs %s', v_pair[1], v_pair[2], v_a, v_b);
    assert pg_temp.kset('res_before', v_pair[1]) <@ pg_temp.kset('res_after', v_pair[1])
           and pg_temp.kset('res_before', v_pair[1]) <> pg_temp.kset('res_after', v_pair[1]), format('"%s" gained rows', v_pair[1]);
  end loop;

  -- the rows themselves
  assert pg_temp.kset('res_after', 'emekli maasi') = array['mA', 'mB'], format('emekli maasi: mA and mB, got %s', pg_temp.kset('res_after', 'emekli maasi'));
  assert not (pg_temp.keys('res_after', 'emekli maasi') && array['mC', 'mD', 'arch', 'single']), 'emekli maasi: no emekli-only, maas-only, archived or single-article row';
  assert pg_temp.kset('res_after', 'siginagi') = array['sA', 'sB', 'sC'], 'siginagi: the three sığınak rows, not sığınmacı';
  assert pg_temp.kset('res_after', 'maaslari') = array['mA', 'mB', 'mD'], format('maaslari: got %s', pg_temp.kset('res_after', 'maaslari'));
  assert pg_temp.kset('res_after', 'cocugu') = array['cA', 'cB', 'cC'], 'cocugu: the three çocuk rows';
  assert pg_temp.kset('res_after', 'guvenligi') = array['gA', 'gB', 'gC'], 'guvenligi: the three güvenlik rows';
  assert pg_temp.kset('res_after', 'secim sonuclari') = array['secA', 'secB'], 'secim sonuclari: sonuçları and sonucu, not the campaign row';
  -- the sibling call of the app ('asgari ucret zammi' -> 'asgari ucret zam', folded as the sibling) still finds the 'zam' rows
  assert pg_temp.kset('res_after', 'asgari ucret zam') = array['zC'], format('asgari ucret zam: zC, got %s', pg_temp.kset('res_after', 'asgari ucret zam'));
  -- a negation still excludes: maaslari -memur has the roots of maaslari and drops the memur row mD
  assert pg_temp.kset('res_after', 'negated') = array['mA', 'mB'], format('maaslari -memur: mA and mB, got %s', pg_temp.kset('res_after', 'negated'));
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
    -- an apostrophe inside a URL or file token: the stem query holds a lexeme with a doubled quote ('a.com/x''maasi'), which the
    -- [a-z] pattern must never rewrite (the rewritten text would raise 42601 in to_tsquery; 194 answers these queries with no rows)
    'a.com/x''maasi', 'x.com/a''kitabi', 'haber.com/x''maasi emekli', 'x.co/a''cocugu''y', 'a.com/''maasi''', 'x.co/a''maaslari',
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
  select count(*) into v_n from public.search_cluster_ids(null, 'maaslari', 5);
  select count(*) into v_n from public.search_cluster_ids(array['maaslari'], null, 5);
  select count(*) into v_n from public.search_cluster_ids(array['maaslari'], 'maaslari', null);
end $$;

delete from public.clusters where id::text like '00000000-0000-4000-8000-000000196%';

-- Realistic load: 8,000 live clusters (rolled back); the 194 body and the 196 body run inline as plain SELECTs, the same
-- arguments, with the p_limit clause removed: the UNCAPPED id set (up to the 1000-row scoring cap) is compared, and the bodies are
-- timed with EXPLAIN (ANALYZE). ---------------------------------------------------------------------------------
begin;
select setseed(0.4242);

create temp table tmp_vocab (i integer primary key, w text not null) on commit drop;
insert into tmp_vocab
select row_number() over ()::integer, w
  from (
    select unnest(array[
      'erdoğan','cumhurbaşkanı','başkan','bakan','belediyesi','soruşturma','tutuklandı','seçim','meclis','parti',
      'ankara','istanbul','izmir','israil','gazze','ukrayna','rusya','trump','abd','avrupa',
      'ekonomi','enflasyon','faiz','dolar','borsa','merkez','bankası','deprem','yangın','sel',
      'fenerbahçe','galatasaray','beşiktaş','maç','transfer','teknik','direktör','futbol','basketbol','şampiyon',
      'üniversite','öğrenci','sınav','okul','sağlık','hastane','doktor','aşı','kanser','ilaç',
      'polis','operasyon','gözaltı','mahkeme','karar','dava','hakim','savcı','cezaevi','af',
      'İran','Irak','şişli','açıklaması','görüşme','toplantı','ziyaret','Burdur','Bursa','Ersan',
      'emekli','maaşı','maaşları','imamoğlu','depremler','mi','oldu','akp','ak'
    ]) as w
    union all
    select translate(substr(md5('w' || g::text), 1, 7), '0123456789', 'ghjklmnprs')
      from generate_series(1, 400) g
  ) x;

insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at)
select gen_random_uuid(),
       (select string_agg(v.w, ' ') from (select (select t.w from (select 1 + floor(power(random(), 2.0) * 480)::integer + k * 0 as pick) q join tmp_vocab t on t.i = q.pick) as w
                                              from generate_series(1, 8 + (g % 4)) k) v),
       case when g % 3 = 0 then null else (select string_agg(v.w, ' ') from (select (select t.w from (select 1 + floor(power(random(), 2.0) * 480)::integer + k * 0 as pick) q join tmp_vocab t on t.i = q.pick) as w
                                              from generate_series(1, 6 + (g % 5)) k) v) end,
       (select string_agg(v.w, ' ') from (select (select t.w from (select 1 + floor(power(random(), 2.0) * 480)::integer + k * 0 as pick) q join tmp_vocab t on t.i = q.pick) as w
                                              from generate_series(1, 40 + (g % 20)) k) v),
       2 + (g % 19),
       false,
       now() - random() * interval '200 days'
  from generate_series(1, 8000) g;
-- the stored Turkish stems of the five pairs, in a deterministic 4% each of the clusters (a hash of the random id), appended to the summary:
-- sığınak, çocuk, güvenlik, maaş, sonuç and 'emekli maaşı' as a phrase. Left to the skewed vocabulary above they would hit the 1000-row cap
-- under both bodies and the comparison would show nothing.
update public.clusters c
   set summary_tr = c.summary_tr || ' ' || w.w
  from (select x.id, (array['sığınak', 'sığınağı', 'çocuk', 'çocuğu', 'güvenlik', 'güvenliği', 'maaş', 'sonuç', 'sonuçları', 'emekli maaşı'])[1 + abs(hashtext(x.id::text)) % 25] as w
          from public.clusters x) w
 where w.id = c.id and w.w is not null;
analyze public.clusters;

-- the inline form of a body: arguments as literals, the limit clause removed when p_limit is null, else a literal
create function pg_temp.inline_src(p_src text, p_variants text[], p_folded text, p_limit integer) returns text
language plpgsql as $f$
declare
  v_src text;
begin
  v_src := replace(p_src, 'limit greatest(1, least(coalesce(p_limit, 12), 50));', case when p_limit is null then '' else format('limit %s', p_limit) end);
  return replace(replace(v_src, 'p_variants', format('(%L::text[])', p_variants)), 'p_folded', format('(%L::text)', p_folded));
end $f$;

create function pg_temp.id_set(p_src text, p_variants text[], p_folded text) returns uuid[]
language plpgsql as $f$
declare
  v uuid[];
begin
  execute format('select coalesce(array_agg(x.id order by x.id), ''{}'') from (%s) x', pg_temp.inline_src(p_src, p_variants, p_folded, null)) into v;
  return v;
end $f$;

-- the timing of one body, in ms, one run per call (explain analyze), as an array of p_runs values after one warm-up run
create function pg_temp.run_ms(p_src text, p_variants text[], p_folded text, p_runs integer) returns numeric[]
language plpgsql as $f$
declare
  v_line text;
  v_ms numeric[] := '{}';
  i integer;
begin
  for i in 0..p_runs loop
    for v_line in execute 'explain (analyze) ' || pg_temp.inline_src(p_src, p_variants, p_folded, 24) loop
      if i > 0 and v_line like 'Execution Time:%' then v_ms := v_ms || substring(v_line from '([0-9.]+) ms')::numeric; end if;
    end loop;
  end loop;
  return v_ms;
end $f$;

create function pg_temp.plan_text(p_src text, p_variants text[], p_folded text) returns text
language plpgsql as $f$
declare
  v_line text;
  v_plan text := '';
begin
  for v_line in execute 'explain ' || pg_temp.inline_src(p_src, p_variants, p_folded, 24) loop
    v_plan := v_plan || v_line || E'\n';
  end loop;
  return v_plan;
end $f$;

-- The id sets of the two bodies on the load. The roots only add candidates, so 196's set contains 194's whenever the scoring cap
-- does not cut: a set under the 1000-row cap is compared whole. A Turkish spelling and a control keep their set; the ASCII
-- spelling of an inflected word finds what the Turkish spelling finds. --------------------------------------------------------
do $$
declare
  v_old text;
  v_new text;
  v_q record;
  v_a uuid[];
  v_b uuid[];
  v_t uuid[];
  v_widened integer := 0;
begin
  select prosrc into v_old from old_src;
  select p.prosrc into v_new from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
  -- ASCII spelling, its Turkish twin (the same p_folded), and whether the pair is expected to widen
  for v_q in select * from (values
      ('emekli maasi', array['emekli maasi'], 'emekli maasi', array['emekli maaşı', 'emekli maaşi'], true),
      ('siginagi', array['siginagi'], 'siginagi', array['sığınağı', 'siğinaği'], true),
      ('maaslari', array['maaslari'], 'maaslari', array['maaşları', 'maaşlari'], true),
      ('cocugu', array['cocugu'], 'cocugu', array['çocuğu'], true),
      ('guvenligi', array['guvenligi'], 'guvenligi', array['güvenliği'], true),
      ('secim sonuclari', array['secim sonuclari'], 'secim sonuclari', array['seçim sonuçları', 'seçim sonuçlari'], true),
      ('imamoglu', array['imamoglu'], 'imamoglu', array['imamoğlu'], false),
      ('deprem', array['deprem'], 'deprem', array['deprem'], false),
      ('burdur', array['burdur'], 'burdur', array['burdur'], false),
      ('secim', array['secim'], 'secim', array['seçim'], false)
    ) as t(typed, variants, folded, tr_variants, widens) loop
    v_a := pg_temp.id_set(v_old, v_q.variants, v_q.folded);        -- 194, ASCII
    v_b := pg_temp.id_set(v_new, v_q.variants, v_q.folded);        -- 196, ASCII
    v_t := pg_temp.id_set(v_new, v_q.tr_variants, v_q.folded);     -- 196, Turkish
    raise notice '%: 194 % ids, 196 % ids (ASCII), 196 % ids (Turkish); same set as 194: %, ASCII = Turkish: %', v_q.typed, cardinality(v_a), cardinality(v_b), cardinality(v_t), v_a = v_b, v_b = v_t;
    if cardinality(v_b) < 1000 then
      assert v_b @> v_a, format('%s: 196 lost an id of 194 under the cap (%s -> %s ids)', v_q.typed, cardinality(v_a), cardinality(v_b));
    end if;
    if not v_q.widens then
      assert v_a = v_b, format('%s: a word without a suffix must keep its id set (%s -> %s ids)', v_q.typed, cardinality(v_a), cardinality(v_b));
    elsif cardinality(v_a) < 1000 then
      -- a set that 194 already fills to the scoring cap cannot widen: only the others are asserted
      assert cardinality(v_b) > cardinality(v_a), format('%s: the roots must add candidates on the load (%s -> %s ids)', v_q.typed, cardinality(v_a), cardinality(v_b));
      v_widened := v_widened + 1;
    end if;
    assert v_b = v_t, format('%s: the ASCII and the Turkish spelling must find the same ids on the load (%s vs %s)', v_q.typed, cardinality(v_b), cardinality(v_t));
  end loop;
  assert v_widened >= 3, format('at least three of the six pairs must widen under the cap on the load, got %s', v_widened);
  assert cardinality(pg_temp.id_set(v_new, array['maaslari'], 'maaslari')) > 24, 'maaslari has more than a page of candidates on the load';
end $$;

-- The plan: 196 reads the same three indexes (only the stem arm's query text changed), no sequential scan of public.clusters. ----
do $$
declare
  v_new text;
  v_plan text;
  v_q record;
begin
  select p.prosrc into v_new from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
  for v_q in select * from (values ('guvenligi', array['guvenligi'], 'guvenligi'), ('maaslari', array['maaslari'], 'maaslari'), ('emekli maasi', array['emekli maasi'], 'emekli maasi'), ('siginak', array['siginak'], 'siginak')) as t(typed, variants, folded) loop
    v_plan := pg_temp.plan_text(v_new, v_q.variants, v_q.folded);
    assert v_plan like '%Index Scan on clusters_search_stemfold_live_idx%', format('%s: the plan must keep clusters_search_stemfold_live_idx:%s%s', v_q.typed, E'\n', v_plan);
    assert v_plan like '%on clusters_search_tsv_live_idx%' and v_plan like '%on clusters_search_fold_live_idx%', format('%s: the other two arms keep their indexes', v_q.typed);
    assert v_plan not like '%Seq Scan on clusters%', format('%s: no sequential scan of clusters:%s%s', v_q.typed, E'\n', v_plan);
  end loop;
end $$;

-- Timing, EXPLAIN (ANALYZE), inline, alternating, the median of 5 runs each after one warm-up run each. Production is the
-- measurement of record (the migration header). Two comparisons: (1) the SAME arguments on a query whose id set does not change
-- (a gross regression fails: bound 1.5x on this load); (2) an ASCII query whose set widens to its Turkish twin's, against the
-- Turkish twin on 194's body: the same candidates, so the same work (bound 1.5x). The same arguments on a widening query scores
-- more rows by design, so it is reported and not bounded. ---------------------------------------------------------------
do $$
declare
  v_old text;
  v_new text;
  v_q record;
  v_a numeric;
  v_b numeric;
  v_c numeric;
begin
  select prosrc into v_old from old_src;
  select p.prosrc into v_new from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
  for v_q in select * from (values
      ('deprem', array['deprem'], 'deprem', array['deprem']),
      ('seçim', array['secim'], 'secim', array['seçim']),
      ('imamoğlu', array['imamoglu'], 'imamoglu', array['imamoğlu']),
      ('burdur', array['burdur'], 'burdur', array['burdur']),
      ('emekli maasi', array['emekli maasi'], 'emekli maasi', array['emekli maaşı', 'emekli maaşi']),
      ('maaslari', array['maaslari'], 'maaslari', array['maaşları', 'maaşlari']),
      ('guvenligi', array['guvenligi'], 'guvenligi', array['güvenliği'])
    ) as t(typed, variants, folded, tr_variants) loop
    v_a := (select percentile_cont(0.5) within group (order by m) from unnest(pg_temp.run_ms(v_old, v_q.variants, v_q.folded, 5)) m);     -- 194, ASCII
    v_b := (select percentile_cont(0.5) within group (order by m) from unnest(pg_temp.run_ms(v_new, v_q.variants, v_q.folded, 5)) m);     -- 196, ASCII
    v_c := (select percentile_cont(0.5) within group (order by m) from unnest(pg_temp.run_ms(v_old, v_q.tr_variants, v_q.folded, 5)) m);  -- 194, Turkish
    raise notice '%: 194 ASCII % ms, 196 ASCII % ms (same arguments, ratio %), 194 Turkish % ms (196 ASCII / 194 Turkish ratio %)',
      v_q.typed, v_a, v_b, round(v_b / v_a, 2), v_c, round(v_b / v_c, 2);
    if pg_temp.id_set(v_old, v_q.variants, v_q.folded) = pg_temp.id_set(v_new, v_q.variants, v_q.folded) then
      assert v_b / v_a < 1.5, format('%s: the 196 body took %sx the 194 body on the same arguments and the same ids (bound 1.5x on this load)', v_q.typed, round(v_b / v_a, 2));
    else
      assert v_b / v_c < 1.5, format('%s: the 196 body took %sx the 194 body on the Turkish twin with the same ids (bound 1.5x on this load)', v_q.typed, round(v_b / v_c, 2));
    end if;
  end loop;
end $$;
rollback;

\echo DRYRUN 196 OK
