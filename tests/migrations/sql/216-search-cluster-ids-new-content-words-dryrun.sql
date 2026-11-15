-- 216 search_cluster_ids_new_content_words (the "En yeni" search: stop words not required, a conservative stem prefix): local PG15 dry-run. Never touches production.
--
-- Run on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir
--   $PGBIN/initdb -D $D -U postgres -A trust -E UTF8 --locale=en_US.UTF-8 >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55616 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55616 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql \
--     -f tests/migrations/sql/216-search-cluster-ids-new-content-words-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql PGHOST=/tmp PGPORT=55616 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/216-search-cluster-ids-new-content-words)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh    (TAYF_LIVE_ONLY=216 runs just this one)
--
-- (\ir paths below are relative to this file.) Every check is a DO block that raises on mismatch, so a clean run ending in
-- "DRYRUN 216 OK" is the pass. 216 is applied twice (re-apply safety). The database this leaves behind has 129, 166, 172, 185, 186, 194,
-- 196, 198, 204, 211, 215 and 216 applied and holds no fixture row (the fixtures live in one transaction that is rolled back; the live block
-- of 216-search-cluster-ids-new-content-words.test.ts seeds its own, the same way).
--
-- Order: the 129 state (166-search-overstem-guard-setup.sql), then 166, 172, 185, 186, 194, 196, 198, 204, 211 and 215 from their own files, gated on
-- production's bodies (search_cluster_ids = 204's: md5 32b42ca06d6b0c2a3ba8bf1264d353f7, length 22892; search_cluster_ids_v2 = 211's: md5
-- c91d45d81b53a71b007aa6de2d1a5ed7, length 22945; search_cluster_ids_new = 215's: md5 c500964284801f3c83be9f4b73ec398a, length 23628, read on production
-- 2026-11-15); then 216 twice, ledger / shape / ACL (anon and authenticated denied with insufficient_privilege, service_role runs it), the other two
-- search functions untouched, and the contract on a fixture, each case run on the new function and on pg_temp.old215, a copy of 215's body made from the
-- text the database held before 216: 'iran ile abd' lists the titles without the stop word 'ile' (215 listed one), 'zamlar' lists the title with 'zam'
-- (the stem), 'vergiler' and 'kararnamelerinin' list the stem-form titles, 'iran' does NOT list a title 'Irak ...' whose summary holds 'İran' (iran has no
-- pre2) and 'tarla' does not list 'Tarım ...', 'deprem için bakan' (Turkish letters in p_variants[1]) does not require 'için' in the title, the ASCII
-- spelling 'icin' is not a stop word (p_folded is not read for it), a query of stop words only ('ile ve') and an alias or negated-phrase query (lw empty)
-- list exactly 215's ids, a query without a stop word or a stem widening lists exactly 215's ids (deprem), the clamps are 215's, and the plan keeps the
-- three index scans. The short-stem allow-list (a 3-4 letter pre2 is met only by the stem or the stem plus a case, plural or possessive tail): 'kazalar' lists
-- '... kazasında yaralandı' and not '... sandalye kazandı' (its summary holds 'kaza') or 'Kazakistan ...', 'yasalar' lists a title with 'yasa' and not 'Sağlıklı Yaşam
-- Merkezi açıldı', 'zamlar' lists both 'zam' and 'zammı'; pg_temp.mut216 (216's body with the bare strpos test for every pre2) lists the unrelated titles, so the fixtures bite.

\set ON_ERROR_STOP on

-- Prelude: Supabase default privileges (so the revokes have something to undo). ---------------------------
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;

-- The 129 state, then 166, 172, 185, 186, 194, 196, 198, 204, 211 and 215. -------------------------------------------------
\ir 166-search-overstem-guard-setup.sql
\ir ../../../supabase/migrations/166_search_overstem_guard.sql
\ir ../../../supabase/migrations/172_search_exempt_word_tier.sql
\ir ../../../supabase/migrations/185_search_sibling_variants.sql
\ir ../../../supabase/migrations/186_search_stem_fold_arm.sql
\ir ../../../supabase/migrations/194_search_rank_display_title.sql
\ir ../../../supabase/migrations/196_search_ascii_inflection_roots.sql
\ir ../../../supabase/migrations/198_search_ascii_root_deny_collisions.sql
\ir ../../../supabase/migrations/204_search_single_letter_compounds.sql
\ir ../../../supabase/migrations/211_search_cluster_ids_v2_offset.sql
\ir ../../../supabase/migrations/215_search_cluster_ids_new.sql

-- Baseline: production's three search functions (STEP 0 of 216), no 216 yet. ------------------------------------------------
create temp table old_src as
  select (select p.prosrc from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure) as v1,
         (select p.prosrc from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids_v2(text[], text, integer, integer)'::regprocedure) as v2,
         (select p.prosrc from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids_new(text[], text, integer, integer)'::regprocedure) as v215;
do $$
declare
  v_v1 text;
  v_v2 text;
  v_215 text;
begin
  select v1, v2, v215 into v_v1, v_v2, v_215 from old_src;
  assert md5(v_v1) = '32b42ca06d6b0c2a3ba8bf1264d353f7' and length(v_v1) = 22892,
         format('204 body md5 %s length %s (production: 32b42ca06d6b0c2a3ba8bf1264d353f7, 22892)', md5(v_v1), length(v_v1));
  assert md5(v_v2) = 'c91d45d81b53a71b007aa6de2d1a5ed7' and length(v_v2) = 22945,
         format('211 body md5 %s length %s (production: c91d45d81b53a71b007aa6de2d1a5ed7, 22945)', md5(v_v2), length(v_v2));
  assert md5(v_215) = 'c500964284801f3c83be9f4b73ec398a' and length(v_215) = 23628,
         format('215 body md5 %s length %s (production: c500964284801f3c83be9f4b73ec398a, 23628)', md5(v_215), length(v_215));
  assert (select count(*) from supabase_migrations.schema_migrations where version in ('204', '211', '215')) = 3, '204, 211 and 215 must be applied';
  assert (select count(*) from supabase_migrations.schema_migrations where version = '216') = 0, '216 must not be applied yet';
  assert to_regclass('public.clusters_search_stemfold_live_idx') is not null, '186 built its index';
  assert to_regclass('public.clusters_search_fold_live_idx') is not null, '129 built its index';
  -- the stemmer the rule rests on (read on production, 2026-11-15): stop words are '{}', and the ASCII fold of için is the stem iç, so p_folded cannot tell
  assert pg_catalog.ts_lexize('pg_catalog.turkish_stem'::pg_catalog.regdictionary, 'ile') = '{}'::text[], 'ile is a stop word';
  assert pg_catalog.ts_lexize('pg_catalog.turkish_stem'::pg_catalog.regdictionary, 'için') = '{}'::text[], 'için is a stop word';
  assert pg_catalog.ts_lexize('pg_catalog.turkish_stem'::pg_catalog.regdictionary, 've') = '{}'::text[], 've is a stop word';
  assert pg_catalog.ts_lexize('pg_catalog.turkish_stem'::pg_catalog.regdictionary, 'ne') = '{}'::text[], 'ne is a stop word';
  assert pg_catalog.ts_lexize('pg_catalog.turkish_stem'::pg_catalog.regdictionary, 'icin') = array['iç'], 'the ASCII fold icin is the stem iç, not a stop word';
  assert pg_catalog.ts_lexize('pg_catalog.turkish_stem'::pg_catalog.regdictionary, 'bir') = array['bir'], 'bir is not a stop word of the stemmer';
  assert pg_catalog.ts_lexize('pg_catalog.turkish_stem'::pg_catalog.regdictionary, 'zamlar') = array['zam'], 'zamlar -> zam';
  assert pg_catalog.ts_lexize('pg_catalog.turkish_stem'::pg_catalog.regdictionary, 'vergiler') = array['vergi'], 'vergiler -> vergi';
  assert pg_catalog.ts_lexize('pg_catalog.turkish_stem'::pg_catalog.regdictionary, 'kararnamelerinin') = array['kararname'], 'kararnamelerinin -> kararname';
  assert pg_catalog.ts_lexize('pg_catalog.turkish_stem'::pg_catalog.regdictionary, 'iran') = array['ira'], 'iran -> ira (a blanket stem prefix would let Irak pass)';
end $$;
create temp table idx_before as select indexname from pg_catalog.pg_indexes where schemaname = 'public' and tablename = 'clusters';

-- Apply 216 TWICE (re-apply safety). -----------------------------------------------------------------------------------------
\ir ../../../supabase/migrations/216_search_cluster_ids_new_content_words.sql
\ir ../../../supabase/migrations/216_search_cluster_ids_new_content_words.sql

-- Ledger, shape and ACL after both runs ------------------------------------------------------------------------------------
do $$
declare
  v_n integer;
  v_p pg_catalog.pg_proc%rowtype;
  v_acl text;
begin
  select count(*) into v_n from supabase_migrations.schema_migrations where version = '216';
  assert v_n = 1, format('ledger rows for 216: %s (expected exactly 1)', v_n);
  assert (select name from supabase_migrations.schema_migrations where version = '216') = '216_search_cluster_ids_new_content_words', 'ledger name';
  assert (select count(*) from supabase_migrations.schema_migrations where version in ('204', '211', '215')) = 3, '204, 211 and 215 ledger rows are untouched';

  select count(*) into v_n from pg_catalog.pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'search_cluster_ids_new';
  assert v_n = 1, format('search_cluster_ids_new overloads: %s (expected 1)', v_n);
  select * into v_p from pg_catalog.pg_proc where oid = 'public.search_cluster_ids_new(text[], text, integer, integer)'::regprocedure;
  assert v_p.prosecdef, 'must be SECURITY DEFINER';
  assert v_p.provolatile = 's', format('must be STABLE, got %s', v_p.provolatile);
  assert v_p.proretset, 'must return a set';
  assert v_p.proconfig = array['search_path=""'], format('proconfig: %s', v_p.proconfig);
  assert (select l.lanname from pg_catalog.pg_language l where l.oid = v_p.prolang) = 'sql', 'language sql';
  assert pg_get_function_arguments(v_p.oid) = 'p_variants text[], p_folded text, p_limit integer DEFAULT 24, p_offset integer DEFAULT 0',
         format('arguments: %s', pg_get_function_arguments(v_p.oid));
  assert pg_get_function_result(v_p.oid) = 'TABLE(id uuid)', format('result: %s', pg_get_function_result(v_p.oid));
  assert obj_description(v_p.oid, 'pg_proc') like '%216%' and obj_description(v_p.oid, 'pg_proc') like '%h192%' and obj_description(v_p.oid, 'pg_proc') like '%stop words%'
         and obj_description(v_p.oid, 'pg_proc') like '%150%', 'function comment must mention 216, h192, stop words and the newest-150 bound';
  -- this file's body: md5 1132c3307c6acca7b1acd3c563f1b92b, length 29853 (VERIFY in the migration header)
  assert md5(v_p.prosrc) = '1132c3307c6acca7b1acd3c563f1b92b' and length(v_p.prosrc) = 29853,
         format('216 body md5 %s length %s (the file: 1132c3307c6acca7b1acd3c563f1b92b, 29853)', md5(v_p.prosrc), length(v_p.prosrc));
  assert md5(v_p.prosrc) <> (select md5(v215) from old_src), '216 replaced 215''s body';
  assert not has_function_privilege('anon', v_p.oid, 'execute'), 'anon must not execute';
  assert not has_function_privilege('authenticated', v_p.oid, 'execute'), 'authenticated must not execute';
  assert has_function_privilege('service_role', v_p.oid, 'execute'), 'service_role must execute';
  assert not exists (select 1 from aclexplode(v_p.proacl) a where a.grantee = 0), 'PUBLIC must have no grant';
  select string_agg(a.grantee::regrole::text, ',' order by a.grantee::regrole::text) into v_acl from aclexplode(v_p.proacl) a;
  assert v_acl = 'postgres,service_role', format('grantees: %s', v_acl);

  -- the two other search functions are not touched: same text, same ACL
  assert (select md5(v1) from old_src) = md5((select p.prosrc from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure)),
         'search_cluster_ids is untouched';
  assert (select md5(v2) from old_src) = md5((select p.prosrc from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids_v2(text[], text, integer, integer)'::regprocedure)),
         'search_cluster_ids_v2 is untouched';
  assert (select count(*) from pg_catalog.pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'search_cluster_ids') = 1, 'search_cluster_ids overloads';
  assert (select count(*) from pg_catalog.pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'search_cluster_ids_v2') = 1, 'search_cluster_ids_v2 overloads';
  assert (select string_agg(indexname, ',' order by indexname) from pg_catalog.pg_indexes where schemaname = 'public' and tablename = 'clusters')
         = (select string_agg(indexname, ',' order by indexname) from idx_before), '216 changes no index';
end $$;

-- Called as each role: anon and authenticated are denied; service_role runs the function. ---------------------------------
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
      perform 1 from public.search_cluster_ids_new(array['iran ile abd'], 'iran ile abd', 24, 0);
    exception when insufficient_privilege then
      v_denied := true;
    end;
    reset role;
    assert v_denied, format('%s must be denied the RPC (insufficient_privilege)', v_role);
  end loop;

  set local role service_role;
  select count(*) into v_n from public.search_cluster_ids_new(array['iran ile abd'], 'iran ile abd', 24, 0);
  assert v_n = 0, 'service_role runs the function (the table is empty here)';
  reset role;
end $$;

-- Fixture (one transaction, rolled back at the end). ids 00000000-0000-4000-8000-0000002160NN ... ------------------------------
begin;

create function pg_temp.sid(p_n integer) returns uuid language sql immutable as $f$
  select ('00000000-0000-4000-8000-' || lpad((216000 + p_n)::text, 12, '0'))::uuid
$f$;

-- old215: 215's function, as a pg_temp function made from the text the database held before 216 (old_src.v215), so every case below can be run on
-- both and compared. Same arguments, same attributes.
do $$
begin
  execute format('create function pg_temp.old215(p_variants text[], p_folded text, p_limit integer default 24, p_offset integer default 0) '
                 'returns table (id uuid) language sql stable set search_path = '''' as %L', (select v215 from old_src));
end $$;

-- ids of one call, in the function's order: the new function, and 215's
create function pg_temp.ids(p_variants text[], p_folded text, p_limit integer, p_offset integer) returns uuid[]
language sql stable as $f$
  select coalesce(array_agg(t.id order by t.n), '{}') from public.search_cluster_ids_new(p_variants, p_folded, p_limit, p_offset) with ordinality as t(id, n)
$f$;
create function pg_temp.ids_old(p_variants text[], p_folded text, p_limit integer, p_offset integer) returns uuid[]
language sql stable as $f$
  select coalesce(array_agg(t.id order by t.n), '{}') from pg_temp.old215(p_variants, p_folded, p_limit, p_offset) with ordinality as t(id, n)
$f$;

-- mut216: 216's function with the bare word-start test for EVERY pre2 (the case in lit_d replaced by `strpos(dn.n, ' ' || lw.pre2) = 0`): the defect the allow-list fixes.
do $$
declare
  v_src text;
  v_start integer;
  v_end integer;
begin
  select p.prosrc into v_src from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids_new(text[], text, integer, integer)'::regprocedure;
  v_start := strpos(v_src, 'case when pg_catalog.length(lw.pre2) >= 5 then ');
  assert v_start > 0, 'the case in lit_d';
  v_end := strpos(substr(v_src, v_start), 'end)') + v_start - 1;
  assert v_end > v_start, 'the end of the case in lit_d';
  v_src := substr(v_src, 1, v_start - 1) || 'pg_catalog.strpos(dn.n, '' '' || lw.pre2) = 0' || substr(v_src, v_end + 3);
  execute format('create function pg_temp.mut216(p_variants text[], p_folded text, p_limit integer default 24, p_offset integer default 0) '
                 'returns table (id uuid) language sql stable set search_path = '''' as %L', v_src);
end $$;
create function pg_temp.ids_mut(p_variants text[], p_folded text, p_limit integer, p_offset integer) returns uuid[]
language sql stable as $f$
  select coalesce(array_agg(t.id order by t.n), '{}') from pg_temp.mut216(p_variants, p_folded, p_limit, p_offset) with ordinality as t(id, n)
$f$;

-- iran ile abd: the stop word 'ile'. 101 holds it, 102 and 103 do not; 104 (Irak ile ABD) and 105 hold iran only in the summary.
insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at) values
  (pg_temp.sid(101), 'ABD ile İran müzakereleri', null, 'Görüşme sürdü.', 3, false, now() - interval '1 hour'),
  (pg_temp.sid(102), 'İran ABD müzakereleri', null, 'Heyetler toplandı.', 3, false, now() - interval '2 hours'),
  (pg_temp.sid(103), 'İran ve ABD gerilimi sürüyor', null, 'Taraflar açıklama yaptı.', 3, false, now() - interval '3 hours'),
  (pg_temp.sid(104), 'Irak ile ABD görüşmesi', null, 'İran gelişmeleri de konuşuldu.', 3, false, now() - interval '30 minutes'),
  (pg_temp.sid(105), 'ABD yaptırımları açıkladı', null, 'İran ile ilgili kararlar duyuruldu.', 3, false, now() - interval '20 minutes');
-- zamlar: the title word built on the stem ('zam'), and the plural; vergiler; kararnamelerinin
insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at) values
  (pg_temp.sid(111), 'Elektriğe zam geldi', null, 'EPDK açıkladı.', 3, false, now() - interval '1 hour'),
  (pg_temp.sid(112), 'Doğalgaz zamları yürürlüğe girdi', null, 'BOTAŞ duyurdu.', 3, false, now() - interval '2 hours'),
  (pg_temp.sid(113), 'Zamlar sürüyor', null, 'Fiyatlar yükseldi.', 3, false, now() - interval '3 hours'),
  (pg_temp.sid(114), 'Akaryakıt zammı açıklandı', null, 'Pompaya zam geldi.', 3, false, now() - interval '4 hours'),
  (pg_temp.sid(121), 'Vergi artışı açıklandı', null, 'Maliye duyurdu.', 3, false, now() - interval '1 hour'),
  (pg_temp.sid(122), 'Yeni vergiler geliyor', null, 'Taslak hazır.', 3, false, now() - interval '2 hours'),
  (pg_temp.sid(131), 'Kararname yayımlandı', null, 'Resmi Gazete duyurdu.', 3, false, now() - interval '1 hour'),
  (pg_temp.sid(132), 'Kararnamelerin ayrıntıları belli oldu', null, 'Maddeler açıklandı.', 3, false, now() - interval '2 hours');
-- iran: the title 'Irak ...' whose summary holds 'İran' must not pass for iran. tarla: a 3-letter stem with a 2-letter suffix stays unwidened.
insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at) values
  (pg_temp.sid(141), 'İran açıklama yaptı', null, 'Bakanlık duyurdu.', 2, false, now() - interval '3 hours'),
  (pg_temp.sid(142), 'Irak yeni hükümeti kurdu', null, 'İran etkisi tartışılıyor.', 2, false, now() - interval '5 minutes'),
  (pg_temp.sid(151), 'Tarla sulama projesi başladı', null, 'Çiftçiler memnun.', 2, false, now() - interval '2 hours'),
  (pg_temp.sid(152), 'Tarım destekleri açıklandı', null, 'Tarlalar için destek verilecek.', 2, false, now() - interval '1 hour');
-- deprem için bakan: 161 holds için in the title, 162 only in the summary (the 166 guard wants 'icin' in the title or the summary), 164 nowhere; 163 holds bakan only in the summary
insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at) values
  (pg_temp.sid(161), 'Deprem için bakan açıklama yaptı', null, 'Bölgede çalışmalar sürüyor.', 3, false, now() - interval '1 hour'),
  (pg_temp.sid(162), 'Deprem bölgesine bakan gitti', null, 'Yardım için ekipler sahada.', 3, false, now() - interval '2 hours'),
  (pg_temp.sid(163), 'Deprem sonrası borsa düştü', null, 'Bakan açıklama yaptı.', 3, false, now() - interval '30 minutes'),
  (pg_temp.sid(164), 'Deprem bakan görüşmesi', null, 'Toplantı yapıldı.', 3, false, now() - interval '4 hours');
-- kazalar (pre2 'kaza'): 181 and 184 hold a word built on the stem; 182 ('kazandı', summary holds 'kaza') and 183 ('Kazakistan') merely start with it.
-- yasalar (pre2 'yasa'): 191 holds 'yasa'; 192 holds 'yaşam' (folded: yasam) and 'yasa' only in its summary.
insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at) values
  (pg_temp.sid(181), 'Otoyolda zincirleme kazasında üç kişi yaralandı', null, 'Kaza sonrası ekipler sevk edildi.', 3, false, now() - interval '1 hour'),
  (pg_temp.sid(182), 'Demokratlar ara seçimlerde sandalye kazandı', null, 'Sayım merkezinde kaza oldu.', 3, false, now() - interval '90 minutes'),
  (pg_temp.sid(183), 'Kazakistan Cumhurbaşkanı Tokayev görüştü', null, 'Trafik kazaları da konuşuldu.', 3, false, now() - interval '100 minutes'),
  (pg_temp.sid(184), 'Trafik kazaları arttı', null, 'Emniyet açıklama yaptı.', 3, false, now() - interval '2 hours'),
  (pg_temp.sid(191), 'Yeni yasa Meclis''te kabul edildi', null, 'Teklif yasasına ilişkin oylama yapıldı.', 3, false, now() - interval '1 hour'),
  (pg_temp.sid(192), 'Sağlıklı Yaşam Merkezi açıldı', null, 'Yeni yasa kapsamında merkezler hizmete girdi.', 3, false, now() - interval '30 minutes');
-- ile / bir: 'ile' is a stop word, 'bir' is not ({bir})
insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at) values
  (pg_temp.sid(171), 'Bir ayda ikinci deprem', null, 'Uzmanlar uyardı.', 3, false, now() - interval '1 hour'),
  (pg_temp.sid(172), 'Barış ile bir araya geldiler', null, 'Görüşme sürdü.', 3, false, now() - interval '2 hours'),
  (pg_temp.sid(173), 'Kayıp ile ilgili açıklama', null, 'Polis araştırıyor.', 3, false, now() - interval '3 hours');
-- 130 plain deprem rows (hours 10..139 old, corroboration 2 + n % 5): enough for four full pages, so the clamps and the paging are compared on a long list
insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at)
select pg_temp.sid(1000 + n), 'Deprem haberi ' || n, null, 'Ayrıntılar sürüyor.', 2 + (n % 5), false, now() - make_interval(hours => 10 + n)
  from generate_series(1, 130) n;
-- no literal tier, and the guard
insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at) values
  (pg_temp.sid(401), 'AK Parti kongresi toplandı', null, 'Delegeler oy kullandı.', 4, false, now() - interval '2 hours'),
  (pg_temp.sid(402), 'Gündem yoğun', null, 'AKP milletvekilleri toplandı.', 3, false, now() - interval '1 hour'),
  (pg_temp.sid(403), 'Hava durumu açıklandı', null, 'Yağış bekleniyor.', 5, false, now() - interval '30 minutes'),
  (pg_temp.sid(411), 'İran açıklama yaptı (arşiv)', null, 'Bakanlık duyurdu.', 2, false, now() - interval '3 hours'),
  (pg_temp.sid(412), 'İran İsrail saldırısı sürüyor', null, 'Saldırı devam ediyor.', 5, false, now() - interval '1 hour'),
  (pg_temp.sid(413), 'Gündem özeti', null, 'İran gelişmeleri konuşuldu.', 2, false, now() - interval '2 hours'),
  (pg_temp.sid(421), 'Burdur''da yurt zehirlenmesi', null, 'Öğrenciler hastaneye kaldırıldı.', 2, false, now() - interval '1 hour'),
  (pg_temp.sid(422), 'Bursa''da sel uyarısı', null, 'Uzmanlar uyardı.', 2, false, now() - interval '30 minutes');
analyze public.clusters;

-- (1) iran ile abd: the stop word is not required. 215 listed only the title that holds 'ile'; 216 lists the three titles that hold iran and abd, newest first, and the same
-- ids as the stem-form query 'iran abd'; the summary-only rows (104, 105) are still left out. -----------------------------------------------
do $$
begin
  assert pg_temp.ids_old(array['iran ile abd'], 'iran ile abd', 24, 0) = array[pg_temp.sid(101)],
         format('215 lists only the title with ile: %s', pg_temp.ids_old(array['iran ile abd'], 'iran ile abd', 24, 0));
  assert pg_temp.ids(array['iran ile abd'], 'iran ile abd', 24, 0) = array[pg_temp.sid(101), pg_temp.sid(102), pg_temp.sid(103)],
         format('iran ile abd lists the three titles, newest first, got %s', pg_temp.ids(array['iran ile abd'], 'iran ile abd', 24, 0));
  assert pg_temp.ids(array['iran ile abd'], 'iran ile abd', 24, 0) = pg_temp.ids(array['iran abd'], 'iran abd', 24, 0), 'iran ile abd lists what iran abd lists';
  assert not (pg_temp.ids(array['iran ile abd'], 'iran ile abd', 24, 0) && array[pg_temp.sid(104), pg_temp.sid(105)]), 'a summary-only match (no iran in the title) is left out';
end $$;

-- (2) zamlar, vergiler, kararnamelerinin: a typed inflected form also accepts the title word built on its stem. ----------------------
do $$
begin
  assert pg_temp.ids_old(array['zamlar'], 'zamlar', 24, 0) = array[pg_temp.sid(112), pg_temp.sid(113)], '215: zamlar lists only the plural titles';
  assert pg_temp.ids(array['zamlar'], 'zamlar', 24, 0) = array[pg_temp.sid(111), pg_temp.sid(112), pg_temp.sid(113), pg_temp.sid(114)],
         format('zamlar lists the titles with zam and zammı and the plurals, got %s', pg_temp.ids(array['zamlar'], 'zamlar', 24, 0));
  assert pg_temp.ids(array['zamlar'], 'zamlar', 24, 0) = pg_temp.ids(array['zam'], 'zam', 24, 0), 'zamlar lists what zam lists';
  assert pg_temp.ids_old(array['vergiler'], 'vergiler', 24, 0) = array[pg_temp.sid(122)], '215: vergiler lists only Yeni vergiler';
  assert pg_temp.ids(array['vergiler'], 'vergiler', 24, 0) = array[pg_temp.sid(121), pg_temp.sid(122)], 'vergiler lists Vergi artışı and Yeni vergiler';
  assert pg_temp.ids_old(array['kararnamelerinin'], 'kararnamelerinin', 24, 0) = array[pg_temp.sid(132)], '215: kararnamelerinin lists only Kararnamelerin ...';
  assert pg_temp.ids(array['kararnamelerinin'], 'kararnamelerinin', 24, 0) = array[pg_temp.sid(131), pg_temp.sid(132)], 'kararnamelerinin lists Kararname yayımlandı too';
end $$;

-- (2b) the short-stem allow-list (db-1): a pre2 of 3-4 letters is met only by the stem or the stem plus a case, plural or possessive tail (the doubled consonant included:
-- zam + mı = zammı). kazalar lists 'kazasında' and 'kazaları', and neither '... sandalye kazandı' (its summary holds 'kaza') nor 'Kazakistan ...'; yasalar lists 'yasa' and not
-- 'Yaşam'; zamlar lists both 'zam' and 'zammı'. mut216 (the bare word-start test for every pre2) lists the unrelated titles: the fixtures bite. ------------------------------
do $$
begin
  assert pg_temp.ids(array['kazalar'], 'kazalar', 24, 0) = array[pg_temp.sid(181), pg_temp.sid(184)],
         format('kazalar lists kazasında and kazaları, got %s', pg_temp.ids(array['kazalar'], 'kazalar', 24, 0));
  assert not (pg_temp.ids(array['kazalar'], 'kazalar', 24, 0) && array[pg_temp.sid(182), pg_temp.sid(183)]), 'kazalar must not list ... sandalye kazandı or Kazakistan ...';
  assert pg_temp.ids_old(array['kazalar'], 'kazalar', 24, 0) = array[pg_temp.sid(184)], '215: kazalar lists only the title with kazaları';
  assert pg_temp.ids_mut(array['kazalar'], 'kazalar', 24, 0) = array[pg_temp.sid(181), pg_temp.sid(182), pg_temp.sid(183), pg_temp.sid(184)],
         format('the bare strpos test lists the unrelated titles, got %s', pg_temp.ids_mut(array['kazalar'], 'kazalar', 24, 0));
  assert pg_temp.ids(array['yasalar'], 'yasalar', 24, 0) = array[pg_temp.sid(191)],
         format('yasalar lists the title with yasa only, got %s', pg_temp.ids(array['yasalar'], 'yasalar', 24, 0));
  assert not (pg_temp.ids(array['yasalar'], 'yasalar', 24, 0) && array[pg_temp.sid(192)]), 'yasalar must not list Sağlıklı Yaşam Merkezi açıldı';
  assert pg_temp.ids_old(array['yasalar'], 'yasalar', 24, 0) = '{}', '215: yasalar lists nothing';
  assert pg_temp.ids_mut(array['yasalar'], 'yasalar', 24, 0) @> array[pg_temp.sid(191), pg_temp.sid(192)], 'the bare strpos test lists Yaşam too';
  assert pg_temp.ids(array['zamlar'], 'zamlar', 24, 0) @> array[pg_temp.sid(111), pg_temp.sid(114)], 'zamlar lists both the zam and the zammı titles';
end $$;

-- (3) the Irak guard: iran has no pre2 (the stem 'ira' is 3 letters and the rest, 'n', is no suffix), so a title 'Irak ...' whose summary holds 'İran' is not listed;
-- tarla (stem 'tar', suffix 'la' is 2 letters) does not list 'Tarım ...'. Both equal 215. ------------------------------------------------------
do $$
begin
  assert not (pg_temp.ids(array['iran'], 'iran', 24, 0) && array[pg_temp.sid(142)]), 'iran must not list the title Irak yeni hükümeti kurdu (Irak for iran)';
  assert pg_temp.ids(array['iran'], 'iran', 24, 0) = pg_temp.ids_old(array['iran'], 'iran', 24, 0), 'iran lists exactly what 215 listed';
  assert pg_temp.ids(array['iran'], 'iran', 24, 0) @> array[pg_temp.sid(101), pg_temp.sid(102), pg_temp.sid(103), pg_temp.sid(141)],
         format('iran lists the titles that hold the word, got %s', pg_temp.ids(array['iran'], 'iran', 24, 0));
  assert pg_temp.ids(array['tarla'], 'tarla', 24, 0) = array[pg_temp.sid(151)], 'tarla lists Tarla sulama projesi only, not Tarım destekleri';
  assert pg_temp.ids(array['tarla'], 'tarla', 24, 0) = pg_temp.ids_old(array['tarla'], 'tarla', 24, 0), 'tarla lists exactly what 215 listed';
end $$;

-- (4) deprem için bakan (Turkish letters in p_variants[1]): the stop word için is not required in the title. The ASCII spelling 'icin' is the stem iç, not a stop word
-- (p_folded is not read for it), so it behaves as in 215. The 166 guard is 215's: a candidate still needs 'icin' in the title or the summary (164 has neither). -------
do $$
begin
  assert pg_temp.ids_old(array['deprem için bakan'], 'deprem icin bakan', 24, 0) = array[pg_temp.sid(161)], '215: only the title with için';
  assert pg_temp.ids(array['deprem için bakan'], 'deprem icin bakan', 24, 0) = array[pg_temp.sid(161), pg_temp.sid(162)],
         format('deprem için bakan lists the two titles, got %s', pg_temp.ids(array['deprem için bakan'], 'deprem icin bakan', 24, 0));
  assert pg_temp.ids(array['deprem bakan'], 'deprem bakan', 24, 0) = array[pg_temp.sid(161), pg_temp.sid(162), pg_temp.sid(164)], 'the stem-form query also lists 164';
  assert not (pg_temp.ids(array['deprem için bakan'], 'deprem icin bakan', 24, 0) && array[pg_temp.sid(163)]), 'a summary-only match is left out';
  assert pg_temp.ids(array['deprem icin bakan'], 'deprem icin bakan', 24, 0) = pg_temp.ids_old(array['deprem icin bakan'], 'deprem icin bakan', 24, 0),
         'the ASCII spelling icin is not a stop word: 215''s answer';
  assert pg_temp.ids(array['deprem ve bakan'], 'deprem ve bakan', 24, 0) = array[pg_temp.sid(161), pg_temp.sid(162), pg_temp.sid(164)], 've is a stop word too';
  assert pg_temp.ids_old(array['deprem ve bakan'], 'deprem ve bakan', 24, 0) = '{}', '215: ve is required in the title';
end $$;

-- (5) a query of stop words only keeps 215's behaviour; 'ile bir' drops only 'ile' (bir is {bir}, a content word). ---------------------------------
do $$
begin
  assert pg_temp.ids(array['ile ve'], 'ile ve', 24, 0) = pg_temp.ids_old(array['ile ve'], 'ile ve', 24, 0), 'a query of stop words only keeps 215''s answer';
  assert pg_temp.ids(array['ile için'], 'ile icin', 24, 0) = pg_temp.ids_old(array['ile için'], 'ile icin', 24, 0), 'ile için: stop words only, 215''s answer';
  assert pg_temp.ids_old(array['ile bir'], 'ile bir', 24, 0) = array[pg_temp.sid(172)], '215: ile and bir are both required';
  assert pg_temp.ids(array['ile bir'], 'ile bir', 24, 0) = array[pg_temp.sid(171), pg_temp.sid(172)], 'ile bir: only bir is required';
end $$;

-- (6) no regression: no stop word and no stem widening, the same ids in the same order as 215; the clamps and the paging are 215's. --------------------
do $$
declare
  v_off integer;
  v_lim integer;
begin
  assert cardinality(pg_temp.ids(array['deprem'], 'deprem', 24, 0)) = 24, 'deprem page 1 has 24 rows';
  foreach v_off in array array[0, 24, 48, 72, 73, 1000, -5] loop
    assert pg_temp.ids(array['deprem'], 'deprem', 24, v_off) = pg_temp.ids_old(array['deprem'], 'deprem', 24, v_off), format('deprem at offset %s equals 215', v_off);
  end loop;
  foreach v_lim in array array[50, 1000000, 0, -3, 5, 1] loop
    assert pg_temp.ids(array['deprem'], 'deprem', v_lim, 3) = pg_temp.ids_old(array['deprem'], 'deprem', v_lim, 3), format('deprem at limit %s equals 215', v_lim);
  end loop;
  assert pg_temp.ids(array['deprem'], 'deprem', null, null) = pg_temp.ids_old(array['deprem'], 'deprem', null, null), 'null limit and offset equal 215''s';
  assert (select count(*) from public.search_cluster_ids_new(array['deprem'], 'deprem')) = 24, 'the defaults are p_limit 24 and p_offset 0';
  assert pg_temp.ids(array['deprem'], 'deprem', 24, 72) = pg_temp.ids_old(array['deprem'], 'deprem', 24, 72), 'page 4 equals 215''s';
  assert (select count(distinct x) from unnest(pg_temp.ids(array['deprem'], 'deprem', 24, 0) || pg_temp.ids(array['deprem'], 'deprem', 24, 24) || pg_temp.ids(array['deprem'], 'deprem', 24, 48)
                                                  || pg_temp.ids(array['deprem'], 'deprem', 24, 72)) x) = 96, 'four pages are 96 distinct ids';
end $$;

-- (7) a query with no literal tier (an alias `or`, a negated phrase) lists its newest rows, the same ids as 215, with or without a stop word; the 166 guard is kept;
-- hostile strings do not raise. ---------------------------------------------------------------------------------------------------------
do $$
begin
  assert pg_temp.ids(array['akp or "ak parti"'], 'akp or ak parti', 24, 0) = array[pg_temp.sid(402), pg_temp.sid(401)],
         format('akp or ak parti: the title row and the summary row, newest first, got %s', pg_temp.ids(array['akp or "ak parti"'], 'akp or ak parti', 24, 0));
  assert pg_temp.ids(array['akp or "ak parti"'], 'akp or ak parti', 24, 0) = pg_temp.ids_old(array['akp or "ak parti"'], 'akp or ak parti', 24, 0), 'the alias query equals 215''s';
  assert pg_temp.ids(array['akp ile or "ak parti"'], 'akp ile or ak parti', 24, 0) = pg_temp.ids_old(array['akp ile or "ak parti"'], 'akp ile or ak parti', 24, 0),
         'an alias query with a stop word: lw stays empty, 215''s answer';
  assert pg_temp.ids(array['iran -"israil saldırısı"', 'iran -"israil saldirisi"'], 'iran -"israil saldirisi"', 24, 0)
       = pg_temp.ids_old(array['iran -"israil saldırısı"', 'iran -"israil saldirisi"'], 'iran -"israil saldirisi"', 24, 0), 'the negated phrase equals 215''s';
  assert cardinality(pg_temp.ids(array['iran -"israil saldırısı"', 'iran -"israil saldirisi"'], 'iran -"israil saldirisi"', 24, 0)) >= 2, 'the negated phrase lists its newest rows, not none';
  assert pg_temp.ids(array['iran ile -"israil saldırısı"'], 'iran ile -"israil saldirisi"', 24, 0) = pg_temp.ids_old(array['iran ile -"israil saldırısı"'], 'iran ile -"israil saldirisi"', 24, 0),
         'a negated phrase with a stop word: 215''s answer';
  assert pg_temp.ids(array['burdur'], 'burdur', 24, 0) = array[pg_temp.sid(421)], 'burdur lists the Burdur row and not the newer Bursa row (the 166 guard)';
  assert pg_temp.ids(array[''], '', 24, 0) = '{}', 'an empty query lists nothing';
  assert pg_temp.ids(array['okul'], null, 24, 0) is not null, 'a null folded text does not raise';
  assert pg_temp.ids(array['''; drop table public.clusters; --'], '''; drop table public.clusters; --', 24, 0) = '{}', 'a hostile string lists nothing and raises nothing';
  assert pg_temp.ids(null, 'deprem', 24, 0) is not null, 'a null variants array does not raise';
  assert to_regclass('public.clusters') is not null, 'the table is still there';
end $$;

-- (8) the plan: `kept` is not a materialized CTE node (NOT MATERIALIZED), and the folded and stem-fold arms keep their indexes (the arms are 204's). On this tiny
-- fixture the planner reads the variants arm through the partial updated_at index (a table of a few hundred rows), so that arm's index is not asserted here. ---
create function pg_temp.plan_of(p_variants text[], p_folded text) returns text
language plpgsql as $f$
declare
  v_src text;
  v_line text;
  v_out text := '';
begin
  select p.prosrc into v_src from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids_new(text[], text, integer, integer)'::regprocedure;
  v_src := replace(replace(replace(replace(v_src, 'p_variants', format('(%L::text[])', p_variants::text)), 'p_folded', quote_literal(p_folded)), 'p_limit', '(24)::integer'), 'p_offset', '(0)::integer');
  set local enable_seqscan = off;
  for v_line in execute 'explain (costs off) ' || rtrim(v_src, E'\n;') loop
    v_out := v_out || v_line || E'\n';
  end loop;
  return v_out;
end $f$;
do $$
declare
  v_plan text := pg_temp.plan_of(array['iran ile abd'], 'iran ile abd');
begin
  assert v_plan not like '%CTE kept%', format('kept is NOT MATERIALIZED: no CTE node for it:%s%s', E'\n', v_plan);
  assert v_plan like '%CTE f0%' and v_plan like '%CTE lw%', format('the small CTEs (f0, lw) are still shared nodes:%s%s', E'\n', v_plan);
  assert v_plan like '%clusters_search_fold_live_idx%', format('the folded arm keeps its index:%s%s', E'\n', v_plan);
  assert v_plan like '%clusters_search_stemfold_live_idx%', format('the stem-fold arm keeps its index:%s%s', E'\n', v_plan);
end $$;

rollback;

-- The database this leaves behind holds no fixture row. ----------------------------------------------------------------------
do $$
begin
  assert (select count(*) from public.clusters where id::text like '00000000-0000-4000-8000-00000021%') = 0, 'no fixture row is left behind';
end $$;

\echo DRYRUN 216 OK
