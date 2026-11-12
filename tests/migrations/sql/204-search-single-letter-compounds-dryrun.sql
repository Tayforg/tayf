-- 204 single-letter hyphen compounds in archive search: local PG15 dry-run. Never touches production.
--
-- Run on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir
--   $PGBIN/initdb -D $D -U postgres -A trust -E UTF8 --locale=en_US.UTF-8 >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55604 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55604 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql \
--     -f tests/migrations/sql/204-search-single-letter-compounds-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql PGHOST=/tmp PGPORT=55604 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/204-search-single-letter-compounds)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh    (TAYF_LIVE_ONLY=204 runs just this one)
--
-- (\ir paths below are relative to this file.) Every check is a DO block that raises on mismatch, so a clean run ending in
-- "DRYRUN 204 OK" is the pass. 204 is applied twice (re-apply safety). The database this leaves behind has 129, 166, 172, 185, 186, 194,
-- 196, 198 and 204 applied and holds no fixture row (the live block of 204-search-single-letter-compounds.test.ts seeds its own, inside a
-- transaction).
--
-- Order: the 129 state (166-search-overstem-guard-setup.sql: search_tsv, 083's index, 129 itself), then 166, 172, 185, 186, 194, 196 and
-- 198 from their own files, gated on 196's function (md5 c384c1f3..., length 19562) and 198's helper (md5 e282da46..., length 5133): what
-- production runs. 196's function is kept as pg_temp.f196 (the installed text, calling the installed helper), a fixture of stored
-- headlines (the compounds e-Okul, e-Devlet, e-Nabız, e-Spor, e-posta; the clusters that only hold their halves, MEB'e okul and
-- Anıtkabir'e devlet; the six regression queries; ordinary controls; rows that pin the literal tier of a compound query (e-bilet), of a plain query
-- (e okul) and of s-400), the answers of pg_temp.f196
-- (baseline: 196) to a list of argument sets as the app builds them; then 204 twice, ledger / shape / ACL, the denied roles, and the same
-- list again. The contract checked for every call: a compound query finds exactly the clusters that hold the compound (e-okul gives the
-- e-Okul cluster, not MEB'e okul; e-imza gives none; e-devlet gives the e-Devlet clusters, not Anıtkabir'e devlet); f-16, s-400, iran-israil,
-- chp-mhp, okul, devlet and every ordinary query keep 196's ids AND order; a negated compound and hostile strings do not raise; the
-- qf and qs texts of every call hold no phrase operator, and the compound is one quoted lexeme even when the input holds a quote. Then a fuzz
-- of hostile strings through the real function, and a synthetic load of 8,000 live clusters (rolled back): the plan keeps the three index
-- scans, the id sets are 196's for an ordinary query and exactly the true matches for a compound, and the timing is compared with
-- EXPLAIN (ANALYZE).

\set ON_ERROR_STOP on

-- Prelude: Supabase default privileges (so the revokes have something to undo). ---------------------------
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;

-- The 129 state, then 166, 172, 185, 186, 194, 196 and 198. ---------------------------------------------------------------
\ir 166-search-overstem-guard-setup.sql
\ir ../../../supabase/migrations/166_search_overstem_guard.sql
\ir ../../../supabase/migrations/172_search_exempt_word_tier.sql
\ir ../../../supabase/migrations/185_search_sibling_variants.sql
\ir ../../../supabase/migrations/186_search_stem_fold_arm.sql
\ir ../../../supabase/migrations/194_search_rank_display_title.sql
\ir ../../../supabase/migrations/196_search_ascii_inflection_roots.sql
\ir ../../../supabase/migrations/198_search_ascii_root_deny_collisions.sql

-- 196's function is the base (md5(prosrc) c384c1f3a0dc337e5243b5a3e55985c0, length 19562), the helper is 198's (e282da4628010153155d3bd8986db77f, 5133). ----
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
  assert md5(v_fn) = 'c384c1f3a0dc337e5243b5a3e55985c0' and length(v_fn) = 19562,
         format('196 function md5 %s length %s (the base: c384c1f3..., 19562)', md5(v_fn), length(v_fn));
  assert md5(v_helper) = 'e282da4628010153155d3bd8986db77f' and length(v_helper) = 5133,
         format('198 helper md5 %s length %s (e282da46..., 5133)', md5(v_helper), length(v_helper));
  assert (select count(*) from supabase_migrations.schema_migrations where version = '196') = 1, '196 must be applied';
  assert (select count(*) from supabase_migrations.schema_migrations where version = '198') = 1, '198 must be applied';
  assert (select count(*) from supabase_migrations.schema_migrations where version = '204') = 0, '204 must not be applied yet';
  assert to_regclass('public.clusters_search_stemfold_live_idx') is not null, '186 built its index';
  assert to_regclass('public.clusters_search_fold_live_idx') is not null, '129 built its index';
end $$;

-- 196's function under a temp name, to run beside 204's installed one (same text, same attributes). ---------------
do $$
begin
  execute format(
    'create function pg_temp.f196(p_variants text[], p_folded text, p_limit integer default 12) returns table (id uuid) '
    || 'language sql stable set search_path = %L as %L',
    '', (select fn from old_src));
end $$;

-- Fixture (committed here, removed at the end). ids 00000000-0000-4000-8000-0000002040NN ---------------------------------
create temp table fx (id uuid primary key, k text not null);
with v(n, k, title, neutral, summary, members, archived, age) as (values
  -- the compounds, and the clusters that only hold their two halves (MEB'e = meb + e; Anıtkabir'e = anıtkabir + e)
  (1,  'eOkul1',   'e-Okul sisteminde arıza', null, 'Veliler girişte sorun yaşadı.', 3, false, interval '2 days'),
  (2,  'meb1',     'MEB''e okul çağrısı', null, 'Dernekler çağrı yaptı.', 3, false, interval '1 day'),
  (3,  'okul1',    'Okul servisleri denetlendi', null, 'Valilik açıkladı.', 2, false, interval '3 days'),
  (4,  'okul2',    'Okulların onarılması için ödenek ayrıldı', null, 'Bakanlık duyurdu.', 2, false, interval '4 days'),
  (5,  'eDevlet1', 'e-Devlet şifresi nasıl yenilenir', null, 'Adımlar açıklandı.', 3, false, interval '2 days'),
  (6,  'eDevlet2', 'e-Devlet''ten randevu dönemi başlıyor', null, 'Sağlık Bakanlığı duyurdu.', 2, false, interval '3 days'),
  (7,  'anit',     'Anıtkabir''e devlet erkânı çıktı', null, 'Tören yapıldı.', 4, false, interval '1 day'),
  (8,  'both',     'e-Okul ve e-Devlet girişi birleşiyor', null, 'Tek şifre dönemi.', 2, false, interval '5 days'),
  (9,  'eNabiz',   'e-Nabız uygulaması güncellendi', null, 'Yeni özellikler geldi.', 3, false, interval '2 days'),
  (10, 'nabizFp',  'Nabız ölçen saat MEB''e sunuldu', null, 'Prototip tanıtıldı.', 2, false, interval '3 days'),
  (11, 'eSpor',    'e-Spor turnuvası başladı', null, 'Finaller hafta sonu.', 2, false, interval '2 days'),
  (12, 'ePosta',   'Yeni e-posta dolandırıcılığı uyarısı', null, 'Uzmanlar uyardı.', 2, false, interval '2 days'),
  (13, 'postaFp',  'MEB''e posta ile gönderilen evrak', null, 'Okullara dağıtıldı.', 2, false, interval '3 days'),
  (14, 'imza1',    'CHP imza topladı', null, 'Kampanya sürüyor.', 3, false, interval '1 day'),
  (15, 'imza2',    'Sevr''e İmza davası', null, 'Tartışma sürüyor.', 2, false, interval '2 days'),
  -- archived and single-article rows are never candidates
  (16, 'eOkulArch', 'e-Okul arşiv haberi', null, 'Arşivde.', 2, true, interval '6 days'),
  (17, 'eOkulOne',  'e-Okul tek kaynaklı haber', null, 'Tek kaynak.', 1, false, interval '6 days'),
  -- the regression queries: F-16 and S-400 are not compound lexemes (the parser reads f and -16), f16fp holds the halves f and 16
  (21, 'f16',        'F-16 savaş uçakları teslim edildi', null, 'Anlaşma imzalandı.', 3, false, interval '1 day'),
  (22, 'f16fp',      'Okul F blok 16 öğrenci kaydı', null, 'Kayıtlar sürüyor.', 2, false, interval '2 days'),
  (23, 's400',       'S-400 sistemi için yeni açıklama', null, 'Bakanlık konuştu.', 3, false, interval '1 day'),
  (24, 'iranIsrail', 'İran-İsrail gerilimi artıyor', null, 'Diplomasi trafiği sürüyor.', 3, false, interval '1 day'),
  (25, 'iran1',      'İran açıklama yaptı', null, 'Bakanlık duyurdu.', 2, false, interval '2 days'),
  (26, 'chpmhp',     'CHP-MHP görüşmesi yapıldı', null, 'Heyetler buluştu.', 3, false, interval '1 day'),
  (27, 'chp1',       'CHP toplantı yaptı', null, 'Genel merkez toplandı.', 2, false, interval '2 days'),
  -- ordinary controls
  (31, 'erd',    'Erdoğan açıklama yaptı', null, 'Cumhurbaşkanı konuştu.', 3, false, interval '1 day'),
  (32, 'dep',    'Deprem sonrası yardım ulaştırıldı', null, 'Ekipler bölgede.', 3, false, interval '2 days'),
  (33, 'maas',   'Emekli maaşları için yeni formül masada', null, 'Hazırlık sürüyor.', 6, false, interval '4 days'),
  (34, 'burdur', 'Burdur''da yurt zehirlenmesi', null, 'Öğrenciler hastaneye kaldırıldı.', 2, false, interval '1 hour'),
  (35, 'bursa',  'Bursa''da deprem uyarısı', null, 'Uzmanlar uyardı.', 2, false, interval '2 hours'),
  -- the literal tier of a query with NO compound: 'e okul' has the words e and okul. litB starts a word with e (Ekonomi), litA does not. Edit 3 does
  -- not apply (cmp is null), so the word e stays in the tier, as under 196: litB above litA, before and after
  (41, 'litA', 'Okul servisleri yeniden düzenlendi', null, 'Valilik MEB''e duyurdu.', 5, false, interval '1 day'),
  (42, 'litB', 'Ekonomi okul bütçesi', null, 'MEB''e bütçe ayrıldı.', 2, false, interval '3 days'),
  -- the literal tier of a COMPOUND query (edit 3): both rows hold the compound e-Bilet in their summary. litD starts a word with e (Ekonomi), litC does not
  -- and is newer and more corroborated. 196 ranks litD first (the word e is in its tier), 204 drops the word e and ranks litC first
  (43, 'litC', 'Bilet satışları yeniden düzenlendi', null, 'Yolcular e-Bilet girişinde sorun yaşadı.', 8, false, interval '1 day'),
  (44, 'litD', 'Ekonomi bilet bütçesi', null, 'e-Bilet için bütçe ayrıldı.', 2, false, interval '5 days'),
  -- s-400 has no compound lexeme (the parser reads s and -400): its literal tier is 196's, its ORDER too. s400b holds the words s and 400 in its title;
  -- s400fp is newer and holds 400 with no word that starts with s (the letter is in its summary). With the one-letter word dropped from the tier of
  -- EVERY query (the first version of 204) s400fp moved above s400b: on production one row moved from rank 27 to rank 9
  (51, 's400b',  'S-400 teslimatı yeniden başladı', null, 'Teslimat takvimi açıklandı.', 2, false, interval '5 days'),
  (52, 's400fp', 'Fransa''da polis müdahalesi: 400 gözaltı', null, 'S haberi: ayrıntılar.', 4, false, interval '1 hour')
), ins as (
  insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at)
  select ('00000000-0000-4000-8000-0000002040' || lpad(v.n::text, 2, '0'))::uuid, v.title, v.neutral, v.summary, v.members, v.archived, now() - v.age
    from v
  returning id
)
insert into fx select ('00000000-0000-4000-8000-0000002040' || lpad(v.n::text, 2, '0'))::uuid, v.k from v;
analyze public.clusters;

-- The argument sets the app builds: the typed spellings (turkishQueryVariants), p_folded = foldTr(query). -------------
create temp table qs (q text primary key, variants text[] not null, folded text);
insert into qs values
  ('e-okul',          array['e-okul'],                    'e-okul'),
  ('e-okulu',         array['e-okulu'],                   'e-okulu'),
  ('e-devlet',        array['e-devlet'],                  'e-devlet'),
  ('e-imza',          array['e-imza'],                    'e-imza'),
  ('e-nabız',         array['e-nabız', 'e-nabiz'],        'e-nabiz'),
  ('e-nabiz',         array['e-nabiz'],                   'e-nabiz'),
  ('e-spor',          array['e-spor'],                    'e-spor'),
  ('e-posta',         array['e-posta'],                   'e-posta'),
  ('e-okul e-devlet', array['e-okul e-devlet'],           'e-okul e-devlet'),
  ('e-okul sisteminde', array['e-okul sisteminde'],        'e-okul sisteminde'),
  ('okul -e-okul',    array['okul -e-okul'],              'okul -e-okul'),
  ('e okul',          array['e okul'],                    'e okul'),
  ('e-bilet',         array['e-bilet'],                   'e-bilet'),
  ('f-16',            array['f-16'],                      'f-16'),
  ('s-400',           array['s-400'],                     's-400'),
  ('iran-israil',     array['iran-israil'],               'iran-israil'),
  ('chp-mhp',         array['chp-mhp'],                   'chp-mhp'),
  ('okul',            array['okul'],                      'okul'),
  ('devlet',          array['devlet'],                    'devlet'),
  ('erdogan',         array['erdoğan'],                   'erdogan'),
  ('deprem',          array['deprem'],                    'deprem'),
  ('emekli maasi',    array['emekli maasi'],              'emekli maasi'),
  ('burdur',          array['burdur'],                    'burdur'),
  ('empty',           array[''],                          ''),
  ('null folded',     array['okul'],                      null);

-- baseline: 196 (the base body) at p_limit 50, the way the app asks. -------------------------------------------------
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

-- The defect is there on the 196 body (so the "after" below proves something): the halves e + okul, e + devlet, e + imza match
-- every apostrophe dative. ------------------------------------------------------------------------------------------------
do $$
begin
  assert pg_temp.kset('res_before', 'e-okul') @> array['eOkul1', 'meb1'], format('baseline: 196 lists MEB''e okul for e-okul, got %s', pg_temp.kset('res_before', 'e-okul'));
  assert pg_temp.kset('res_before', 'e-imza') @> array['imza2'], format('baseline: 196 lists Sevr''e İmza for e-imza (no story holds e-imza), got %s', pg_temp.kset('res_before', 'e-imza'));
  assert pg_temp.kset('res_before', 'e-devlet') @> array['eDevlet1', 'anit'], format('baseline: 196 lists Anıtkabir''e devlet for e-devlet, got %s', pg_temp.kset('res_before', 'e-devlet'));
  assert pg_temp.kset('res_before', 'e-nabiz') @> array['nabizFp'], format('baseline: 196 lists the halves for e-nabiz, got %s', pg_temp.kset('res_before', 'e-nabiz'));
  assert pg_temp.kset('res_before', 'e-posta') @> array['postaFp'], format('baseline: 196 lists the halves for e-posta, got %s', pg_temp.kset('res_before', 'e-posta'));
  assert pg_temp.kset('res_before', 'f-16') @> array['f16', 'f16fp'], format('baseline: f-16 lists F-16 and the halves row, got %s', pg_temp.kset('res_before', 'f-16'));
  -- the literal tier of 196: the one-letter word e makes litB (a word starting with e) outrank litA, and litD outrank litC for the compound e-bilet
  assert array_position(pg_temp.keys('res_before', 'e okul'), 'litB') < array_position(pg_temp.keys('res_before', 'e okul'), 'litA'),
         format('baseline: the prefix e puts litB (a word that starts with e) above litA, got %s', pg_temp.keys('res_before', 'e okul'));
  assert pg_temp.kset('res_before', 'e-bilet') = array['litC', 'litD'], format('baseline: e-bilet lists the two e-Bilet rows, got %s', pg_temp.kset('res_before', 'e-bilet'));
  assert array_position(pg_temp.keys('res_before', 'e-bilet'), 'litD') < array_position(pg_temp.keys('res_before', 'e-bilet'), 'litC'),
         format('baseline: the prefix e puts litD (a word that starts with e) above litC for e-bilet, got %s', pg_temp.keys('res_before', 'e-bilet'));
  -- s-400 on 196: the row with the s word in its title is above the newer row that only holds 400, so the s-400 check below is not vacuous
  assert pg_temp.kset('res_before', 's-400') @> array['s400', 's400b', 's400fp'], format('baseline: s-400 lists the three S-400 rows, got %s', pg_temp.kset('res_before', 's-400'));
  assert array_position(pg_temp.keys('res_before', 's-400'), 's400b') < array_position(pg_temp.keys('res_before', 's-400'), 's400fp'),
         format('baseline: s400b (title with the words s and 400) above s400fp (400 only), got %s', pg_temp.keys('res_before', 's-400'));
  assert not (pg_temp.keys('res_before', 'e-okul') && array['eOkulArch', 'eOkulOne']), 'baseline: archived and single-article rows are never candidates';
  assert (select max(c) from (select count(*) as c from res_before group by q) m) < 50, 'the fixture keeps every list far below the 50-row cap';
end $$;

-- Apply 204 TWICE (re-apply safety). --------------------------------------------------------------------------
create temp table idx_before as select indexname from pg_catalog.pg_indexes where schemaname = 'public' and tablename = 'clusters';
\ir ../../../supabase/migrations/204_search_single_letter_compounds.sql
\ir ../../../supabase/migrations/204_search_single_letter_compounds.sql

-- Ledger, shape and ACL after both runs -----------------------------------------------------------------------------
do $$
declare
  v_n integer;
  v_p pg_catalog.pg_proc%rowtype;
  v_h pg_catalog.pg_proc%rowtype;
  v_acl text;
begin
  select count(*) into v_n from supabase_migrations.schema_migrations where version = '204';
  assert v_n = 1, format('ledger rows for 204: %s (expected exactly 1)', v_n);
  assert (select name from supabase_migrations.schema_migrations where version = '204') = '204_search_single_letter_compounds', 'ledger name';
  assert (select count(*) from supabase_migrations.schema_migrations where version in ('196', '198')) = 2, '196 and 198 ledger rows are untouched';

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
  assert obj_description(v_p.oid, 'pg_proc') like '%204%' and obj_description(v_p.oid, 'pg_proc') like '%e-okul%', 'function comment must mention 204 and the compounds';
  assert md5(v_p.prosrc) <> 'c384c1f3a0dc337e5243b5a3e55985c0', 'the body must have changed';
  assert md5(v_p.prosrc) = '32b42ca06d6b0c2a3ba8bf1264d353f7' and length(v_p.prosrc) = 22892,
         format('204 body md5 %s length %s (the file: 32b42ca06d6b0c2a3ba8bf1264d353f7, 22892)', md5(v_p.prosrc), length(v_p.prosrc));
  assert not has_function_privilege('anon', v_p.oid, 'execute'), 'anon must not execute';
  assert not has_function_privilege('authenticated', v_p.oid, 'execute'), 'authenticated must not execute';
  assert has_function_privilege('service_role', v_p.oid, 'execute'), 'service_role must execute';
  assert not exists (select 1 from aclexplode(v_p.proacl) a where a.grantee = 0), 'PUBLIC must have no grant';
  select string_agg(a.grantee::regrole::text, ',' order by a.grantee::regrole::text) into v_acl from aclexplode(v_p.proacl) a;
  assert v_acl = 'postgres,service_role', format('grantees: %s', v_acl);

  -- the helper is 198's, untouched: same text, same attributes, same ACL
  select * into v_h from pg_catalog.pg_proc where oid = 'public.tayf_ascii_inflection_expand(tsquery)'::regprocedure;
  assert md5(v_h.prosrc) = 'e282da4628010153155d3bd8986db77f' and length(v_h.prosrc) = 5133, 'the helper of 198 is not touched';
  assert v_h.provolatile = 'i' and v_h.proparallel = 's' and v_h.proisstrict and not v_h.prosecdef, 'the helper keeps its attributes';

  -- 204 adds and drops no index and touches no other helper
  assert (select string_agg(indexname, ',' order by indexname) from pg_catalog.pg_indexes where schemaname = 'public' and tablename = 'clusters')
         = (select string_agg(indexname, ',' order by indexname) from idx_before), '204 changes no index';
  assert to_regclass('public.clusters_search_stemfold_live_idx') is not null, '186 index still there';
  assert (select count(*) from pg_catalog.pg_proc where pronamespace = 'public'::regnamespace and proname = 'tayf_search_stem_fold') = 1, 'the helper of 186 is untouched';
  assert (select count(*) from pg_catalog.pg_proc where pronamespace = 'public'::regnamespace and proname = 'tayf_search_fold') = 1, 'fold overloads';
  assert (select count(*) from pg_catalog.pg_proc where pronamespace = 'public'::regnamespace and proname = 'tayf_ascii_inflection_expand') = 1, 'helper overloads';
end $$;

-- Called as each role: anon and authenticated are denied; service_role runs the function. ----------------------------------
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
      perform 1 from public.search_cluster_ids(array['e-okul'], 'e-okul', 24);
    exception when insufficient_privilege then
      v_denied := true;
    end;
    reset role;
    assert v_denied, format('%s must be denied the RPC', v_role);
  end loop;

  set local role service_role;
  select count(*) into v_n from public.search_cluster_ids(array['e-okul'], 'e-okul', 24);
  assert v_n > 0, 'service_role must get rows from the RPC';
  reset role;
end $$;

-- The same argument sets after 204. --------------------------------------------------------------------------
create temp table res_after as
  select qs.q, t.n, t.id from qs cross join lateral public.search_cluster_ids(qs.variants, qs.folded, 50) with ordinality as t(id, n);

do $$
declare
  r record;
  v_pair text[];
begin
  -- no id repeats, in any call
  for r in select * from qs order by q loop
    assert (select count(*) from res_after where q = r.q) = (select count(distinct id) from res_after where q = r.q), format('call "%s": a duplicate id', r.q);
  end loop;

  -- the compounds: exactly the clusters that hold the compound (the spec's fixtures: e-Okul sisteminde arıza and MEB'e okul çağrısı for
  -- e-okul; e-Devlet şifresi and Anıtkabir'e devlet erkânı for e-devlet; e-imza matches nothing)
  assert pg_temp.kset('res_after', 'e-okul') = array['both', 'eOkul1'], format('e-okul: only the e-Okul clusters, got %s', pg_temp.kset('res_after', 'e-okul'));
  assert not (pg_temp.keys('res_after', 'e-okul') && array['meb1', 'okul1', 'okul2']), 'e-okul must not list MEB''e okul çağrısı or a plain okul row';
  assert pg_temp.kset('res_after', 'e-okulu') = array['both', 'eOkul1'], format('e-okulu (a suffix): the same e-Okul clusters, got %s', pg_temp.kset('res_after', 'e-okulu'));
  assert (select count(*) from res_after where q = 'e-imza') = 0, format('e-imza: no story holds it, got %s', pg_temp.kset('res_after', 'e-imza'));
  assert pg_temp.kset('res_after', 'e-devlet') = array['both', 'eDevlet1', 'eDevlet2'], format('e-devlet: only the e-Devlet clusters, got %s', pg_temp.kset('res_after', 'e-devlet'));
  assert not (pg_temp.keys('res_after', 'e-devlet') && array['anit']), 'e-devlet must not list Anıtkabir''e devlet erkânı';
  -- e-nabız: the stemmer stores the compound as e-nap (e-nabiz typed in ASCII has no Turkish spelling among the variants, and 196's variants arm
  -- misses it): the stored lexeme is what the folded arm and the stem arm read
  assert pg_temp.kset('res_after', 'e-nabız') = array['eNabiz'], format('e-nabız: the e-Nabız cluster, got %s', pg_temp.kset('res_after', 'e-nabız'));
  assert pg_temp.kset('res_after', 'e-nabiz') = array['eNabiz'], format('e-nabiz (ASCII): the e-Nabız cluster, got %s', pg_temp.kset('res_after', 'e-nabiz'));
  assert pg_temp.kset('res_after', 'e-spor') = array['eSpor'], format('e-spor: got %s', pg_temp.kset('res_after', 'e-spor'));
  assert pg_temp.kset('res_after', 'e-posta') = array['ePosta'], format('e-posta: got %s', pg_temp.kset('res_after', 'e-posta'));
  -- two compounds in one query are both required
  assert pg_temp.kset('res_after', 'e-okul e-devlet') = array['both'], format('e-okul e-devlet: the cluster that holds both, got %s', pg_temp.kset('res_after', 'e-okul e-devlet'));
  assert pg_temp.kset('res_after', 'e-okul sisteminde') = array['eOkul1'], format('e-okul sisteminde: got %s', pg_temp.kset('res_after', 'e-okul sisteminde'));
  -- a compound never adds a row to 196's set: every 204 id is a 196 id, or comes from the variants arm, which 204 does not change
  for r in select * from qs where q in ('e-okul', 'e-okulu', 'e-devlet', 'e-imza', 'e-nabız', 'e-nabiz', 'e-spor', 'e-posta', 'e-okul e-devlet', 'e-okul sisteminde') order by q loop
    assert pg_temp.kset('res_after', r.q) <@ pg_temp.kset('res_before', r.q), format('"%s": 204 added a row 196 did not return (%s -> %s)', r.q, pg_temp.kset('res_before', r.q), pg_temp.kset('res_after', r.q));
  end loop;
  assert not (pg_temp.keys('res_after', 'e-okul') && array['eOkulArch', 'eOkulOne']), 'archived and single-article rows are never candidates';

  -- a negated compound: no error; the e-Okul clusters are out, the plain okul rows are in (the variants arm answers it)
  assert not (pg_temp.keys('res_after', 'okul -e-okul') && array['eOkul1', 'both']), format('okul -e-okul must not list an e-Okul cluster, got %s', pg_temp.keys('res_after', 'okul -e-okul'));
  assert pg_temp.keys('res_after', 'okul -e-okul') @> array['okul1', 'okul2'], format('okul -e-okul lists the plain okul rows, got %s', pg_temp.keys('res_after', 'okul -e-okul'));

  -- the six regression queries of the spec and every ordinary query: 196's ids AND 196's order
  foreach v_pair slice 1 in array array[
      ['f-16'], ['s-400'], ['iran-israil'], ['chp-mhp'], ['okul'], ['devlet'], ['erdogan'], ['deprem'], ['emekli maasi'], ['burdur'], ['empty'], ['null folded']] loop
    assert pg_temp.keys('res_after', v_pair[1]) = pg_temp.keys('res_before', v_pair[1]),
           format('"%s" must keep 196''s ids and order: %s -> %s', v_pair[1], pg_temp.keys('res_before', v_pair[1]), pg_temp.keys('res_after', v_pair[1]));
  end loop;
  assert pg_temp.keys('res_after', 'f-16') @> array['f16'] and pg_temp.keys('res_after', 'f-16') @> array['f16fp'], 'f-16: the F-16 row (and the halves row, which 196 returned too)';
  assert pg_temp.keys('res_after', 's-400') @> array['s400'], 's-400: the S-400 row';
  assert pg_temp.keys('res_after', 'iran-israil') @> array['iranIsrail'], 'iran-israil: the İran-İsrail row';
  assert pg_temp.keys('res_after', 'chp-mhp') @> array['chpmhp'], 'chp-mhp: the CHP-MHP row';
  assert pg_temp.kset('res_after', 'okul') @> array['okul1', 'okul2', 'eOkul1', 'meb1'], 'okul: a plain word still finds every row that holds it';
  assert pg_temp.keys('res_after', 'burdur') = array['burdur'], format('burdur: the guard keeps only the Burdur row, got %s', pg_temp.keys('res_after', 'burdur'));

  -- edit 3, the literal tier of a COMPOUND query: 196 put litD (a word that starts with e) above litC for 'e-bilet'; the one-letter word no longer decides it,
  -- so the newer, more corroborated litC is above litD. The id set is the two rows that hold the compound.
  assert pg_temp.kset('res_after', 'e-bilet') = array['litC', 'litD'], format('e-bilet keeps its id set, got %s', pg_temp.kset('res_after', 'e-bilet'));
  assert array_position(pg_temp.keys('res_after', 'e-bilet'), 'litC') < array_position(pg_temp.keys('res_after', 'e-bilet'), 'litD'),
         format('e-bilet after 204: litC above litD (the one-letter word e of a compound is not a prefix), got %s', pg_temp.keys('res_after', 'e-bilet'));
  -- a query with NO compound keeps the one-letter word: 'e okul' is 196's, ids AND order (litB above litA)
  assert pg_temp.keys('res_after', 'e okul') = pg_temp.keys('res_before', 'e okul'),
         format('e okul has no compound: 196''s ids and order, %s -> %s', pg_temp.keys('res_before', 'e okul'), pg_temp.keys('res_after', 'e okul'));
  assert array_position(pg_temp.keys('res_after', 'e okul'), 'litB') < array_position(pg_temp.keys('res_after', 'e okul'), 'litA'),
         format('e okul after 204: litB above litA (the one-letter word stays in the tier), got %s', pg_temp.keys('res_after', 'e okul'));
  -- s-400 (a letter-digit query, no compound lexeme): 196's pg_temp copy and 204 return the identical ORDERED id list, the rows that expose the one-letter
  -- word included (s400b above s400fp)
  assert pg_temp.keys('res_after', 's-400') = pg_temp.keys('res_before', 's-400'),
         format('s-400 must be 196''s, ids AND order: %s -> %s', pg_temp.keys('res_before', 's-400'), pg_temp.keys('res_after', 's-400'));
  assert array_position(pg_temp.keys('res_after', 's-400'), 's400b') < array_position(pg_temp.keys('res_after', 's-400'), 's400fp'),
         format('s-400 after 204: s400b above s400fp (the letter s stays in the tier), got %s', pg_temp.keys('res_after', 's-400'));

  -- empty and null inputs
  assert (select count(*) from res_after where q = 'empty') = 0, 'the empty query finds nothing';
  assert pg_temp.keys('res_after', 'null folded') @> array['okul1'], format('a null p_folded runs and finds the variants arm rows, got %s', pg_temp.keys('res_after', 'null folded'));
end $$;

-- The query texts: qf and qs never hold a phrase operator, the compound is ONE quoted lexeme, and a quote in the input never reaches it. -----
-- The installed body is cut before the cand CTE and closed with a select of the texts: the real q and qs, nothing re-implemented.
do $$
declare
  v_src text;
begin
  select p.prosrc into v_src from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
  assert position(E'\n  ), cand as (' in v_src) > 0, 'the cand marker';
  v_src := left(v_src, position(E'\n  ), cand as (' in v_src) - 1) || E'\n  ) select q.qf::text as qf, qs.qs::text as qs, q.cmp::text as cmp from q cross join qs';
  execute format('create function pg_temp.dbg(p_variants text[], p_folded text) returns table (qf text, qs text, cmp text) language sql stable set search_path = %L as %L', '', v_src);
end $$;

do $$
declare
  r record;
  v_in text;
begin
  -- the pinned texts
  select * into r from pg_temp.dbg(array['e-okul'], 'e-okul');
  assert r.cmp = $t$'e-okul'$t$, format('e-okul: cmp %s', r.cmp);
  assert r.qf = $t$'e' & 'okul' & 'e-okul'$t$, format('e-okul: qf %s', r.qf);
  assert r.qs = $t$'e' & 'okul' & 'e-okul'$t$, format('e-okul: qs %s', r.qs);
  select * into r from pg_temp.dbg(array['e-nabiz'], 'e-nabiz');
  assert r.cmp = $t$'e-nap'$t$, format('e-nabiz: the stored lexeme e-nap, got %s', r.cmp);
  select * into r from pg_temp.dbg(array['e-okulu'], 'e-okulu');
  assert r.cmp = $t$'e-okul'$t$, format('e-okulu: the stored lexeme e-okul, got %s', r.cmp);
  select * into r from pg_temp.dbg(array['e-okul e-devlet'], 'e-okul e-devlet');
  assert r.cmp = $t$'e-devlet' & 'e-okul'$t$, format('two compounds: sorted AND, got %s', r.cmp);
  -- no compound lexeme: cmp is null and qf and qs are 196's texts (iran-israil, chp-mhp, covid-19 have a hyphen but no single letter; f-16 and s-400 have no lexeme)
  for v_in in select unnest(array['okul', 'iran-israil', 'chp-mhp', 'covid-19', 'f-16', 's-400', 'e-o', 'e--okul', 'ee-okul', 'emekli maasi', 'deprem']) loop
    select * into r from pg_temp.dbg(array[v_in], v_in);
    assert r.cmp is null, format('%s: cmp must be null, got %s', v_in, r.cmp);
  end loop;
  select * into r from pg_temp.dbg(array['emekli maasi'], 'emekli maasi');
  assert r.qf = $t$'emekli' & 'maasi'$t$ and r.qs = $t$( 'emekli' | 'emekl' ) & ( 'maasi' | 'maas' )$t$, format('emekli maasi: 196''s qf and qs, got %s and %s', r.qf, r.qs);

  -- never a phrase operator, never a doubled quote or a backslash inside the compound, for every kind of input (the quote assertion of the spec)
  for v_in in select unnest(array[
      'e-okul', 'e-okul e-devlet', 'e-nabiz', 'f-16', 'okul', 'okul -e-okul', '-e-okul', '"e-okul sistemi"', 'e-okul or e-devlet', 'iran-israil e-okul',
      'e-okul''; drop table x; --', '''e-okul', 'e-ok''ul', 'e-okul''', '''e-okul''', 'e-okul\', '\e-okul', 'e-okul"', '"e-okul', 'a-b-cd', 'x--y', 'a_b', 'e-okul_x',
      'e-ö', 'e-öğrenci', 'E-OKUL', 'e-oku-l', 'e-12', 'e-ab1', 'e-1ab', '-e-', 'e-', '-', '--', 'x-ray e-okul'
    ]) loop
    for r in select * from pg_temp.dbg(array[v_in], v_in) loop
      assert position('<' in r.qf) = 0, format('qf must not contain ''<'': %s -> %s', v_in, r.qf);
      assert r.qs is null or position('<' in r.qs) = 0, format('qs must not contain ''<'': %s -> %s', v_in, r.qs);
      assert r.cmp is null or position('<' in r.cmp) = 0, format('cmp must not contain ''<'': %s -> %s', v_in, r.cmp);
      assert r.cmp is null or (position('''''' in r.cmp) = 0 and position('\' in r.cmp) = 0), format('the compound lexeme holds no escaped quote and no backslash: %s -> %s', v_in, r.cmp);
    end loop;
  end loop;
  -- a quote in the input: the compound lexeme is the quoted [a-z0-9-] text only
  select * into r from pg_temp.dbg(array['''e-okul'], '''e-okul');
  assert r.cmp = $t$'e-okul'$t$, format('a leading quote: cmp %s', r.cmp);
  select * into r from pg_temp.dbg(array['e-okul''; drop table x; --'], 'e-okul''; drop table x; --');
  assert r.cmp = $t$'e-okul'$t$, format('a quote and a statement after the compound: cmp %s', r.cmp);
  select * into r from pg_temp.dbg(array['e-ok''ul'], 'e-ok''ul');
  assert r.cmp = $t$'e-ok'$t$, format('a quote inside the compound ends it: cmp %s', r.cmp);
  select * into r from pg_temp.dbg(array['e-okul\'], 'e-okul\');
  assert r.cmp = $t$'e-okul'$t$, format('a backslash after the compound: cmp %s', r.cmp);
  -- a hyphen chain: the pattern takes b-cd out of a-b-cd (a letter that follows a hyphen starts a word too), which no vector stores (the parser keeps
  -- a-b-cd as one lexeme), so the folded and the stem arm return nothing for it and the variants arm answers: a documented limit
  select * into r from pg_temp.dbg(array['a-b-cd'], 'a-b-cd');
  assert r.cmp = $t$'b-cd'$t$, format('a-b-cd: the pattern takes b-cd, got %s', r.cmp);
end $$;

-- The literal tier's prefixes (lw), read from the real CTE: the body is cut before the hits CTE and closed with a select of lw. 196's text is cut the same way.
-- A compound query drops its one-letter words ('e-okul': e is out, okul stays); a query with no compound lexeme keeps them ('e okul', 's-400').
do $$
declare
  v_src text;
  v_old text;
  v_cut constant text := E'\n  ), hits as (';
  v_end constant text := E'\n  ) select coalesce(pg_catalog.array_agg(lw.pre order by lw.pre), ''{}''::text[]) as pres from lw';
begin
  select p.prosrc into v_src from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
  select fn into v_old from old_src;
  assert position(v_cut in v_src) > 0 and position(v_cut in v_old) > 0, 'the hits marker';
  execute format('create function pg_temp.dbglw(p_variants text[], p_folded text) returns table (pres text[]) language sql stable set search_path = %L as %L',
                 '', left(v_src, position(v_cut in v_src) - 1) || v_end);
  execute format('create function pg_temp.dbglw196(p_variants text[], p_folded text) returns table (pres text[]) language sql stable set search_path = %L as %L',
                 '', left(v_old, position(v_cut in v_old) - 1) || v_end);
end $$;

do $$
declare
  v_in text;
  v_new text[];
  v_old text[];
begin
  -- a compound query: the word e is not a prefix, the other words are
  select pres into v_new from pg_temp.dbglw(array['e-okul'], 'e-okul');
  select pres into v_old from pg_temp.dbglw196(array['e-okul'], 'e-okul');
  assert v_old = array['e', 'okul'], format('196: e-okul has the prefixes e and okul, got %s', v_old);
  assert v_new = array['okul'], format('204: e-okul still drops the letter e from lw, got %s', v_new);
  select pres into v_new from pg_temp.dbglw(array['e-okul e-devlet'], 'e-okul e-devlet');
  assert v_new = array['devl', 'okul'], format('204: e-okul e-devlet drops both e words, got %s', v_new);
  select pres into v_new from pg_temp.dbglw(array['e-bilet'], 'e-bilet');
  assert v_new = array['bile'], format('204: e-bilet drops the letter e, got %s', v_new);
  -- a compound and a letter-digit word in one query: cmp is not null, so both one-letter words go (only the ORDER of such a query can differ from 196's)
  select pres into v_new from pg_temp.dbglw(array['e-okul s-400'], 'e-okul s-400');
  assert v_new = array['400', 'okul'], format('204: e-okul s-400 drops e and s, got %s', v_new);
  -- no compound lexeme: cmp is null and lw is 196's, letter for letter
  for v_in in select unnest(array['s-400', 'f-16', 'e okul', 'okul', 'iran-israil', 'chp-mhp', 'emekli maasi', 'deprem', 'u-19', 'f-35', 'a b c', 'e-o', 'erdogan']) loop
    select pres into v_new from pg_temp.dbglw(array[v_in], v_in);
    select pres into v_old from pg_temp.dbglw196(array[v_in], v_in);
    assert v_new = v_old, format('lw of "%s" must be 196''s: %s -> %s', v_in, v_old, v_new);
  end loop;
  select pres into v_new from pg_temp.dbglw(array['s-400'], 's-400');
  assert v_new = array['400', 's'], format('204: s-400 keeps the letter s in lw, got %s', v_new);
  select pres into v_new from pg_temp.dbglw(array['e okul'], 'e okul');
  assert v_new = array['e', 'okul'], format('204: e okul (no compound) keeps the letter e in lw, got %s', v_new);
  -- empty and null inputs
  select pres into v_new from pg_temp.dbglw(array[''], '');
  assert v_new = '{}'::text[], format('an empty query has no prefix, got %s', v_new);
  select pres into v_new from pg_temp.dbglw(array['okul'], null);
  assert v_new = '{}'::text[], format('a null p_folded has no prefix, got %s', v_new);
end $$;

-- Fuzz: hostile strings go through the real function with the arguments the app would build; none may raise. --------------
do $$
declare
  v_s text;
  v_n bigint;
  v_cases text[] := array[
    'a', 'ab', 'e-okul', '"e-okul"', '-e-okul', 'okul -e-okul', 'e-okul or e-devlet', '(e-okul)', 'e-okul & e-devlet', 'e-okul | e-devlet', '!e-okul', 'e-okul:*',
    'e-okul <-> e-devlet', 'e-okul<->e-devlet', '<->', '<2>', '''', '''''', 'o''brien', 'a''b''c', 'e-okul''', '''e-okul', '\', '\\', 'a\b', 'e-okul\', '"', '""', '"a', 'a"',
    'a-b', 'a--b', '-a-b-', '- -', '---', 'covid-19', 'covid_19', 'x.y', '3.5', '192.168.1.1', 'a@b.c', 'http://x.y/z?q=1', '/usr/bin', 'ğüşıöç', 'ĞÜŞİÖÇ', 'ı', 'İ',
    'e-öğrenci', 'e-İmza', 'E-NABIZ', 'e-nabız', 'e-ö', 'i̇', 'e'||chr(769), chr(775), 'e-'||chr(775)||'okul', chr(8217), 'e-okul'||chr(8217)||'x', 'e'||chr(8209)||'okul', 'e'||chr(8211)||'okul', '😀', 'e-😀',
    'ａ-ｂｃ', 'ﬁ', repeat('a', 64), repeat('ı', 64), repeat('a ', 32), repeat('e-okul ', 10), repeat('e-ab ', 200), repeat('e-', 500), repeat('-e-ab', 300),
    'e-' || repeat('a', 3000), 'e-' || repeat('a', 100000), repeat('x-ab ', 2000), 'e-okul ' || repeat('a', 5000),
    '1 2 3 4 5 6', '& & &', '| | |', '! ! !', '( ) ( )', ':* :*', 'a:', ':a', 'a:b', 'a:*b', 'null', '%', '_', '*', '?', ';', ',', '.', '[a]', '{a}', '^a$', '$1', 'a b c d e f g h',
    '[', '[[', '(?', '(?<=', '\d+', '.*', '^', '$', 'a|b', 'a)(b', 'imamoglu', 'yurt disi', 'veya', 've', 'bir', 'icin', 'e-ve', 'o-ve', 'a-ve', 'e-bir', 'e-icin'
  ];
begin
  foreach v_s in array v_cases loop
    -- the app sends the lower-cased query as the variant and its fold as p_folded
    select count(*) into v_n from public.search_cluster_ids(array[lower(v_s)], public.tayf_search_fold(v_s), 5);
    select count(*) into v_n from public.search_cluster_ids(array[lower(v_s), lower(v_s) || ' x'], public.tayf_search_fold(v_s), 5);
    -- and the raw text as p_folded (the function folds it itself)
    select count(*) into v_n from public.search_cluster_ids(array[v_s], v_s, 5);
  end loop;
  -- and a null variants array, a null folded query, a null limit
  select count(*) into v_n from public.search_cluster_ids(null, 'e-okul', 5);
  select count(*) into v_n from public.search_cluster_ids(array['e-okul'], null, 5);
  select count(*) into v_n from public.search_cluster_ids(array['e-okul'], 'e-okul', null);
end $$;

delete from public.clusters where id::text like '00000000-0000-4000-8000-0000002040%';

-- Realistic load: 8,000 live clusters (rolled back); the 196 body and the 204 body run inline as plain SELECTs, the same
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
      'emekli','maaşı','maaşları','imamoğlu','depremler','mi','oldu','akp','ak','devlet','imza','meb'
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
-- the compounds and the halves, deterministic (a hash of the random id), appended to the summary: e-Okul and e-Devlet in about 1% of the
-- clusters each, e-Nabız in 0.5%, the halves MEB'e okul and Anıtkabir'e devlet in about 3% and 2%. Left to the skewed vocabulary above they would
-- not exist, and the comparison would show nothing.
update public.clusters c
   set summary_tr = c.summary_tr || ' ' || w.w
  from (select x.id,
               case abs(hashtext(x.id::text)) % 100
                 when 0 then 'e-Okul sistemi'
                 when 1 then 'e-Devlet şifresi'
                 when 2 then 'e-Nabız uygulaması'
                 when 3 then 'MEB''e okul çağrısı'
                 when 4 then 'MEB''e okul'
                 when 5 then 'MEB''e okul'
                 when 6 then 'Anıtkabir''e devlet erkânı'
                 when 7 then 'Anıtkabir''e devlet erkânı'
               end as w
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

-- the ids in rank order (the uncapped list, the page is its first 24)
create function pg_temp.id_list(p_src text, p_variants text[], p_folded text) returns uuid[]
language plpgsql as $f$
declare
  v uuid[];
begin
  execute format('select coalesce(array_agg(x.id order by x.n), ''{}'') from (select b.id, row_number() over () as n from (%s) b) x', pg_temp.inline_src(p_src, p_variants, p_folded, null)) into v;
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

-- The id sets of the two bodies on the load. An ordinary query keeps 196's set AND its rank order. A compound query returns exactly the clusters
-- whose search_tsv holds the compound (the phrase of the variants arm, which 204 does not change), and 196 returned more. ---------------
do $$
declare
  v_old text;
  v_new text;
  v_q record;
  v_a uuid[];
  v_b uuid[];
  v_true uuid[];
begin
  select fn into v_old from old_src;
  select p.prosrc into v_new from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
  for v_q in select * from (values
      ('deprem', array['deprem'], 'deprem', false, 'deprem'),
      ('okul', array['okul'], 'okul', false, 'okul'),
      ('devlet', array['devlet'], 'devlet', false, 'devlet'),
      ('imamoglu', array['imamoglu'], 'imamoglu', false, 'imamoglu'),
      ('emekli maasi', array['emekli maasi'], 'emekli maasi', false, 'emekli maasi'),
      ('burdur', array['burdur'], 'burdur', false, 'burdur'),
      ('f-16', array['f-16'], 'f-16', false, 'f-16'),
      ('iran-israil', array['iran-israil'], 'iran-israil', false, 'iran-israil'),
      ('e-okul', array['e-okul'], 'e-okul', true, 'e-okul'),
      ('e-devlet', array['e-devlet'], 'e-devlet', true, 'e-devlet'),
      ('e-imza', array['e-imza'], 'e-imza', true, 'e-imza'),
      -- typed in ASCII: the true matches are those of the Turkish spelling (the variants arm of 196 cannot find e-Nabız from e-nabiz)
      ('e-nabiz', array['e-nabiz'], 'e-nabiz', true, 'e-nabız')
    ) as t(typed, variants, folded, compound, tq) loop
    v_a := pg_temp.id_set(v_old, v_q.variants, v_q.folded);   -- 196
    v_b := pg_temp.id_set(v_new, v_q.variants, v_q.folded);   -- 204
    raise notice '%: 196 % ids, 204 % ids; same set: %', v_q.typed, cardinality(v_a), cardinality(v_b), v_a = v_b;
    if not v_q.compound then
      assert v_a = v_b, format('%s: an ordinary query must keep its id set (%s -> %s ids)', v_q.typed, cardinality(v_a), cardinality(v_b));
      assert pg_temp.id_list(v_old, v_q.variants, v_q.folded) = pg_temp.id_list(v_new, v_q.variants, v_q.folded),
             format('%s: an ordinary query must keep its rank order', v_q.typed);
    else
      assert v_b <@ v_a, format('%s: 204 must not add an id to 196''s set', v_q.typed);
      select coalesce(array_agg(c.id order by c.id), '{}') into v_true
        from public.clusters c
       where c.search_tsv @@ pg_catalog.websearch_to_tsquery('pg_catalog.turkish', v_q.tq) and not c.is_archived and c.article_count >= 2;
      assert v_b = v_true, format('%s: 204 must return exactly the clusters that hold the compound (%s ids against %s true matches)', v_q.typed, cardinality(v_b), cardinality(v_true));
      if v_q.typed in ('e-okul', 'e-devlet') then
        assert cardinality(v_b) >= 20 and cardinality(v_a) > cardinality(v_b), format('%s: the load holds the compound and the halves (196 %s ids, 204 %s)', v_q.typed, cardinality(v_a), cardinality(v_b));
      end if;
    end if;
  end loop;
  -- e-imza: no cluster holds it, 196 listed the halves
  assert cardinality(pg_temp.id_set(v_new, array['e-imza'], 'e-imza')) = 0, 'e-imza returns nothing on the load';
end $$;

-- The plan: 204 reads the same three indexes (only the folded and stem query texts changed), no sequential scan of public.clusters. ----
do $$
declare
  v_new text;
  v_plan text;
  v_q record;
begin
  select p.prosrc into v_new from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
  for v_q in select * from (values ('okul', array['okul'], 'okul'), ('e-okul', array['e-okul'], 'e-okul'), ('e-devlet', array['e-devlet'], 'e-devlet'), ('deprem', array['deprem'], 'deprem'), ('e-imza', array['e-imza'], 'e-imza')) as t(typed, variants, folded) loop
    v_plan := pg_temp.plan_text(v_new, v_q.variants, v_q.folded);
    assert v_plan like '%on clusters_search_stemfold_live_idx%', format('%s: the plan must keep clusters_search_stemfold_live_idx:%s%s', v_q.typed, E'\n', v_plan);
    assert v_plan like '%on clusters_search_tsv_live_idx%' and v_plan like '%on clusters_search_fold_live_idx%', format('%s: the other two arms keep their indexes:%s%s', v_q.typed, E'\n', v_plan);
    assert v_plan not like '%Seq Scan on clusters%', format('%s: no sequential scan of clusters:%s%s', v_q.typed, E'\n', v_plan);
  end loop;
end $$;

-- Timing, EXPLAIN (ANALYZE), inline, alternating, the median of 5 runs each after one warm-up run each. Production is the measurement of record
-- (the migration header). The SAME arguments on 196 and on 204: an ordinary query costs what it cost (a gross regression fails: bound 1.5x on this
-- load), a compound query costs no more than it did (it scores fewer rows). -----------------------------------------------------
do $$
declare
  v_old text;
  v_new text;
  v_q record;
  v_a numeric;
  v_b numeric;
begin
  select fn into v_old from old_src;
  select p.prosrc into v_new from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
  for v_q in select * from (values
      ('deprem', array['deprem'], 'deprem'),
      ('okul', array['okul'], 'okul'),
      ('imamoglu', array['imamoglu'], 'imamoglu'),
      ('e-okul', array['e-okul'], 'e-okul'),
      ('e-devlet', array['e-devlet'], 'e-devlet'),
      ('e-imza', array['e-imza'], 'e-imza')
    ) as t(typed, variants, folded) loop
    v_a := (select percentile_cont(0.5) within group (order by m) from unnest(pg_temp.run_ms(v_old, v_q.variants, v_q.folded, 5)) m);     -- 196
    v_b := (select percentile_cont(0.5) within group (order by m) from unnest(pg_temp.run_ms(v_new, v_q.variants, v_q.folded, 5)) m);     -- 204
    raise notice '%: 196 % ms, 204 % ms (same arguments, ratio %)', v_q.typed, v_a, v_b, round(v_b / v_a, 2);
    assert v_b / v_a < 1.5, format('%s: the 204 body took %sx the 196 body on the same arguments (bound 1.5x on this load)', v_q.typed, round(v_b / v_a, 2));
  end loop;
end $$;
rollback;

\echo DRYRUN 204 OK
