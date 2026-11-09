-- 186 search stem-fold arm: local PG15 dry-run. Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust -E UTF8 --locale=en_US.UTF-8 >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55586 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55586 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql \
--     -f tests/migrations/sql/186-search-stem-fold-arm-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql PGHOST=/tmp PGPORT=55586 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/186-search-stem-fold-arm)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh    (TAYF_LIVE_ONLY=186 runs just this one)
--
-- (\ir paths below are relative to this file.) Every check is a DO block that raises on mismatch, so a clean
-- run ending in "DRYRUN 186 OK" is the pass. 186 is applied twice, then the helper and the index are dropped and rebuilt
-- the way the header's ORCHESTRATOR PRE-BUILD says (the helper in a transaction, the index CONCURRENTLY in autocommit)
-- and 186 is applied a third time, which must leave that index alone. The database this leaves behind has 129, 166, 172,
-- 185 and 186 applied and holds no fixture row (the live block of 186-search-stem-fold-arm.test.ts seeds its own, inside
-- a transaction).
--
-- Order: the 129 state (166-search-overstem-guard-setup.sql: search_tsv, 083's index, 129 itself), 166, 172 and 185 from
-- their own files, 185 gated on its md5 (b8d0aa30..., length 13324: the base of 186); a fixture of the queries of
-- h96-search-2 (siginak, yurt disi, guvenlik, cocuk typed in ASCII against headlines that carry the inflected Turkish
-- words) and of the controls 186 must not change; the answers of 185's function (baseline: 185) to a list of argument sets;
-- then 186, ledger / shape / ACL, the helper's own contract, the denied roles, and the same list again. The contract
-- checked for every call is: 186's list is a superset of 185's, the same rows in the same order when nothing new is found,
-- a Turkish-typed query gets no new row, and an ASCII-typed query gets exactly the rows its Turkish twin has. Then a fuzz of
-- hostile strings through the real function (no error), and a synthetic load of 8,000 live clusters (rolled back) with
-- EXPLAIN (ANALYZE) of the 185 body and the 186 body inline: the plan must use clusters_search_stemfold_live_idx.

\set ON_ERROR_STOP on

-- Prelude: Supabase default privileges (so the revokes have something to undo). ---------------------------
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;

-- The 129 state, then 166, 172 and 185. -----------------------------------------------------------------------
\ir 166-search-overstem-guard-setup.sql
\ir ../../../supabase/migrations/166_search_overstem_guard.sql
\ir ../../../supabase/migrations/172_search_exempt_word_tier.sql
\ir ../../../supabase/migrations/185_search_sibling_variants.sql

-- 185's body is the base (md5(prosrc) b8d0aa3035e001d17750d94f5a08c9c2, length 13324). ------------------------------
create temp table old_src as
  select p.prosrc from pg_catalog.pg_proc p
   where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
do $$
declare
  v_md5 text;
  v_len integer;
begin
  select md5(prosrc), length(prosrc) into v_md5, v_len from old_src;
  assert v_md5 = 'b8d0aa3035e001d17750d94f5a08c9c2', format('185 body md5 %s (the base: b8d0aa30...)', v_md5);
  assert v_len = 13324, format('185 body length %s (the base: 13324)', v_len);
  assert (select count(*) from supabase_migrations.schema_migrations where version = '185') = 1, '185 must be applied';
  assert (select count(*) from supabase_migrations.schema_migrations where version = '186') = 0, '186 must not be applied yet';
  assert to_regclass('public.clusters_search_stemfold_live_idx') is null, 'the stem-fold index does not exist yet';
  assert to_regprocedure('public.tayf_search_stem_fold(tsvector)') is null, 'the helper does not exist yet';
  -- the stemmer facts the defect rests on (production, 2026-11-09): the stored stem keeps its Turkish letters, the ASCII
  -- spelling of the same inflected word is not stemmed to it, and the ASCII base form is its own stem
  assert (ts_lexize('pg_catalog.turkish_stem', 'sığınağı'))[1] = 'sığınak', 'sığınağı -> sığınak';
  assert (ts_lexize('pg_catalog.turkish_stem', 'siginagi'))[1] <> 'siginak', 'siginagi is not stemmed to siginak';
  assert (ts_lexize('pg_catalog.turkish_stem', 'siginak'))[1] = 'siginak', 'siginak -> siginak';
  assert (ts_lexize('pg_catalog.turkish_stem', 'güvenliği'))[1] = 'güvenlik', 'güvenliği -> güvenlik';
  assert (ts_lexize('pg_catalog.turkish_stem', 'guvenligi'))[1] = 'guvenligi', 'guvenligi -> guvenligi';
  assert (ts_lexize('pg_catalog.turkish_stem', 'çocuğu'))[1] = 'çocuk', 'çocuğu -> çocuk';
  assert (ts_lexize('pg_catalog.turkish_stem', 'dışı'))[1] = 'dış', 'dışı -> dış';
  assert (ts_lexize('pg_catalog.turkish_stem', 'disi'))[1] = 'dis', 'disi -> dis';
end $$;

-- 185's function under a temp name, to run beside 186's installed one (same text, same attributes). ---------------
do $$
begin
  execute format(
    'create function pg_temp.f185(p_variants text[], p_folded text, p_limit integer default 12) returns table (id uuid) '
    || 'language sql stable set search_path = %L as %L',
    '', (select prosrc from old_src));
end $$;

-- Fixture (committed here, removed at the end). ids 00000000-0000-4000-8000-0000001861NN ---------------------------------
create temp table fx (id uuid primary key, k text not null);
insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at) values
  -- sığınak: the inflected rows are stored as the stem 'sığınak' with Turkish letters; the ASCII query stem is 'siginak'
  ('00000000-0000-4000-8000-000000186101', 'Sığınağı vuruldu', null, 'Sivil sığınağa saldırı oldu.', 2, false, now() - interval '1 hour'),
  ('00000000-0000-4000-8000-000000186102', 'Sığınak yapımı hızlandı', null, 'Yeni sığınaklar inşa edilecek.', 2, false, now() - interval '2 hours'),
  -- (an inflection that keeps the final k, sığınaktaki, is already reached by the ASCII stem: only the softened g is lost)
  ('00000000-0000-4000-8000-000000186103', 'Sığınaktaki aileler tahliye edildi', null, 'Tahliye sürüyor.', 2, false, now() - interval '3 hours'),
  -- yurt dışı
  ('00000000-0000-4000-8000-000000186111', 'Yurt dışına çıkış yasağı', null, 'Seyahat kısıtlaması.', 2, false, now() - interval '4 hours'),
  ('00000000-0000-4000-8000-000000186112', 'Yurt dışında eğitim fırsatı', null, 'Burs verilecek.', 2, false, now() - interval '5 hours'),
  ('00000000-0000-4000-8000-000000186113', 'Yurt dışı seyahat başladı', null, 'Tatilciler yola çıktı.', 2, false, now() - interval '6 hours'),
  -- güvenlik and çocuk
  ('00000000-0000-4000-8000-000000186121', 'Güvenliği artırıldı', null, 'Önlemler alındı.', 2, false, now() - interval '7 hours'),
  ('00000000-0000-4000-8000-000000186122', 'Güvenlik toplantısı yapıldı', null, 'Karar çıktı.', 2, false, now() - interval '8 hours'),
  ('00000000-0000-4000-8000-000000186123', 'Çocuğu kurtardılar', null, 'İtfaiye müdahale etti.', 2, false, now() - interval '9 hours'),
  ('00000000-0000-4000-8000-000000186124', 'Çocuk bayramı kutlandı', null, 'Törenler yapıldı.', 2, false, now() - interval '10 hours'),
  -- archived and single-article rows are never candidates
  ('00000000-0000-4000-8000-000000186131', 'Sığınağı arşiv haberi', null, 'Arşivde.', 2, true, now() - interval '11 hours'),
  ('00000000-0000-4000-8000-000000186132', 'Sığınağı tek kaynaklı haber', null, 'Tek kaynak.', 1, false, now() - interval '11 hours'),
  -- controls: guarded (burdur, with the stem collision bürün -> bur), tiered (miller), plain words, the alias
  ('00000000-0000-4000-8000-000000186141', 'Burdur''da yurt zehirlenmesi', null, 'Öğrenciler hastaneye kaldırıldı.', 2, false, now() - interval '1 hour'),
  ('00000000-0000-4000-8000-000000186142', 'Bursa''da deprem uyarısı', null, 'Uzmanlar uyardı.', 2, false, now() - interval '2 hours'),
  ('00000000-0000-4000-8000-000000186143', 'Hak hukuk tanımazlığın ete kemiğe büründüğü bir gün', null, 'Tepki büyüdü.', 2, false, now() - interval '3 hours'),
  ('00000000-0000-4000-8000-000000186144', 'Miller açıklama yaptı', null, 'Açıklama geldi.', 2, false, now() - interval '10 hours'),
  ('00000000-0000-4000-8000-000000186145', 'Mili Eğitim Bakanlığı toplantısı', null, 'Toplantı yapıldı.', 2, false, now() - interval '11 hours'),
  ('00000000-0000-4000-8000-000000186146', 'İran açıklama yaptı', null, 'Tahran''dan.', 2, false, now() - interval '13 hours'),
  ('00000000-0000-4000-8000-000000186147', 'Erdoğan kabine toplantısı sonrası konuştu', null, 'Açıklama yaptı.', 2, false, now() - interval '14 hours'),
  ('00000000-0000-4000-8000-000000186148', 'Seçim sonuçları açıklandı', null, 'Kurul sonuçları duyurdu.', 2, false, now() - interval '15 hours'),
  ('00000000-0000-4000-8000-000000186149', 'AKP''den açıklama', null, 'Parti sözcüsü konuştu.', 2, false, now() - interval '16 hours'),
  ('00000000-0000-4000-8000-000000186150', 'AK Parti toplantısı', null, 'Grup toplantısı yapıldı.', 2, false, now() - interval '17 hours'),
  ('00000000-0000-4000-8000-000000186151', 'Aile Dayanışma Ağı yeni bir parti çağrısı yaptı', null, 'Çağrı sürdü.', 2, false, now() - interval '18 hours');
insert into fx select id, 'r' || right(id::text, 3) from public.clusters where id::text like '00000000-0000-4000-8000-0000001861%';
analyze public.clusters;

-- The argument sets the app sends: the typed spellings (turkishQueryVariants), p_folded = foldTr(query). -------------
create temp table qs (q text primary key, variants text[] not null, folded text);
insert into qs values
  ('siginak',      array['siginak'],                      'siginak'),
  ('sığınak',      array['sığınak'],                      'siginak'),
  ('yurt disi',    array['yurt disi'],                    'yurt disi'),
  ('yurt dışı',    array['yurt dışı', 'yurt dişi'],       'yurt disi'),
  ('guvenlik',     array['guvenlik'],                     'guvenlik'),
  ('güvenlik',     array['güvenlik'],                     'guvenlik'),
  ('cocuk',        array['cocuk'],                        'cocuk'),
  ('çocuk',        array['çocuk'],                        'cocuk'),
  ('guvenligi',    array['guvenligi'],                    'guvenligi'),
  ('burdur',       array['burdur'],                       'burdur'),
  ('miller',       array['miller'],                       'miller'),
  ('iran',         array['iran'],                         'iran'),
  ('erdogan',      array['erdogan'],                      'erdogan'),
  ('erdoğan',      array['erdoğan'],                      'erdogan'),
  ('secim',        array['seçim'],                        'secim'),
  ('akp alias',    array['akp or "ak parti"'],            'akp or ak parti'),
  ('phrase',       array['"yurt dışı"'],                  '"yurt disi"'),
  ('negated',      array['-siginak'],                     '-siginak'),
  ('sibling six',  array['elektrik zammı', 'elektrik zammi', 'elektrik zam'], 'elektrik zammi'),
  ('empty',        array[''],                             ''),
  ('null folded',  array['burdur'],                       null);

-- baseline: 185 (the base body) at p_limit 50, the way the app asks. -------------------------------------------------
create temp table res_before as
  select qs.q, t.n, t.id from qs cross join lateral pg_temp.f185(qs.variants, qs.folded, 50) with ordinality as t(id, n);

-- The defect is there on the 185 body (so the "after" below proves something). ----------------------------------------------
do $$
declare
  v_keys text[];
begin
  select coalesce(array_agg(f.k order by f.k), '{}') into v_keys from res_before b join fx f on f.id = b.id where b.q = 'siginak';
  assert v_keys = array['r102', 'r103'], format('baseline: "siginak" misses the row whose inflection softens the g (r101), got %s', v_keys);
  select coalesce(array_agg(f.k order by f.k), '{}') into v_keys from res_before b join fx f on f.id = b.id where b.q = 'sığınak';
  assert v_keys = array['r101', 'r102', 'r103'], format('baseline: "sığınak" finds the three live rows, got %s', v_keys);
  select coalesce(array_agg(f.k order by f.k), '{}') into v_keys from res_before b join fx f on f.id = b.id where b.q = 'guvenlik';
  assert v_keys = array['r122'], format('baseline: "guvenlik" finds only the base-form row, got %s', v_keys);
  select coalesce(array_agg(f.k order by f.k), '{}') into v_keys from res_before b join fx f on f.id = b.id where b.q = 'cocuk';
  assert v_keys = array['r124'], format('baseline: "cocuk" finds only the base-form row, got %s', v_keys);
  assert (select count(*) from res_before where q = 'yurt disi') < (select count(*) from res_before where q = 'yurt dışı'), 'baseline: "yurt disi" finds fewer rows than "yurt dışı"';
  assert (select max(c) from (select count(*) as c from res_before group by q) m) < 50, 'the fixture keeps every list far below the 50-row cap';
end $$;

-- Apply 186 TWICE (re-apply safety). --------------------------------------------------------------------------
create temp table idx_before as select indexname from pg_catalog.pg_indexes where schemaname = 'public' and tablename = 'clusters';
\ir ../../../supabase/migrations/186_search_stem_fold_arm.sql
\ir ../../../supabase/migrations/186_search_stem_fold_arm.sql

-- Ledger, shape, ACL and the index after both runs ----------------------------------------------------------------
do $$
declare
  v_n integer;
  v_p pg_catalog.pg_proc%rowtype;
  v_h pg_catalog.pg_proc%rowtype;
  v_acl text;
  v_def text;
begin
  select count(*) into v_n from supabase_migrations.schema_migrations where version = '186';
  assert v_n = 1, format('ledger rows for 186: %s (expected exactly 1)', v_n);
  assert (select name from supabase_migrations.schema_migrations where version = '186') = '186_search_stem_fold_arm', 'ledger name';
  assert (select count(*) from supabase_migrations.schema_migrations where version = '185') = 1, '185 ledger row is untouched';

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
  assert obj_description(v_p.oid, 'pg_proc') like '%186%' and obj_description(v_p.oid, 'pg_proc') like '%stem-fold%', 'function comment must mention the stem-fold arm of 186';
  assert md5(v_p.prosrc) <> 'b8d0aa3035e001d17750d94f5a08c9c2', 'the body must have changed';
  assert md5(v_p.prosrc) = '973e3707e98448b0385bd0402c039df3' and length(v_p.prosrc) = 14850,
         format('186 body md5 %s length %s (the file: 973e3707e98448b0385bd0402c039df3, 14850)', md5(v_p.prosrc), length(v_p.prosrc));
  assert not has_function_privilege('anon', v_p.oid, 'execute'), 'anon must not execute';
  assert not has_function_privilege('authenticated', v_p.oid, 'execute'), 'authenticated must not execute';
  assert has_function_privilege('service_role', v_p.oid, 'execute'), 'service_role must execute';
  assert not exists (select 1 from aclexplode(v_p.proacl) a where a.grantee = 0), 'PUBLIC must have no grant';
  select string_agg(a.grantee::regrole::text, ',' order by a.grantee::regrole::text) into v_acl from aclexplode(v_p.proacl) a;
  assert v_acl = 'postgres,service_role', format('grantees: %s', v_acl);

  -- the helper: immutable, parallel safe, empty search_path, not security definer, service_role only
  select count(*) into v_n from pg_catalog.pg_proc where pronamespace = 'public'::regnamespace and proname = 'tayf_search_stem_fold';
  assert v_n = 1, format('tayf_search_stem_fold overloads: %s', v_n);
  select * into v_h from pg_catalog.pg_proc where oid = 'public.tayf_search_stem_fold(tsvector)'::regprocedure;
  assert v_h.provolatile = 'i', format('the helper must be IMMUTABLE, got %s', v_h.provolatile);
  assert v_h.proparallel = 's', format('the helper must be PARALLEL SAFE, got %s', v_h.proparallel);
  assert not v_h.prosecdef, 'the helper must not be SECURITY DEFINER (the index expression runs as the writer)';
  assert v_h.proconfig = array['search_path=""'], format('helper proconfig: %s', v_h.proconfig);
  assert pg_get_function_result(v_h.oid) = 'tsvector', 'the helper returns tsvector';
  assert (select l.lanname from pg_catalog.pg_language l where l.oid = v_h.prolang) = 'sql', 'helper language sql';
  assert not has_function_privilege('anon', v_h.oid, 'execute'), 'anon must not execute the helper';
  assert not has_function_privilege('authenticated', v_h.oid, 'execute'), 'authenticated must not execute the helper';
  assert has_function_privilege('service_role', v_h.oid, 'execute'), 'service_role must execute the helper';
  assert not exists (select 1 from aclexplode(v_h.proacl) a where a.grantee = 0), 'PUBLIC must have no grant on the helper';
  select string_agg(a.grantee::regrole::text, ',' order by a.grantee::regrole::text) into v_acl from aclexplode(v_h.proacl) a;
  assert v_acl = 'postgres,service_role', format('helper grantees: %s', v_acl);

  -- the index: valid, GIN, partial on the literal live predicate, over the helper
  assert (select i.indisvalid from pg_catalog.pg_index i where i.indexrelid = 'public.clusters_search_stemfold_live_idx'::regclass), 'the index is valid';
  v_def := pg_get_indexdef('public.clusters_search_stemfold_live_idx'::regclass);
  assert v_def like '%USING gin (tayf_search_stem_fold(search_tsv))%', format('index definition: %s', v_def);
  assert v_def like '%WHERE ((NOT is_archived) AND (article_count >= 2))', format('index predicate: %s', v_def);
  assert (select string_agg(i, ',' order by i) from pg_catalog.pg_indexes x, lateral (select x.indexname as i) l where x.schemaname = 'public' and x.tablename = 'clusters')
         = (select string_agg(i, ',' order by i) from (select indexname as i from idx_before union all select 'clusters_search_stemfold_live_idx') z),
         '186 adds exactly one index (the stem-fold one) and drops none';
  -- 129's fold, its index and 083's index are untouched
  assert (select count(*) from pg_catalog.pg_proc where pronamespace = 'public'::regnamespace and proname = 'tayf_search_fold') = 1, 'fold overloads';
  assert to_regclass('public.clusters_search_fold_live_idx') is not null and to_regclass('public.clusters_search_tsv_live_idx') is not null, '129 and 083 indexes';
end $$;

-- The helper's own contract ----------------------------------------------------------------------------------------
do $$
declare
  v tsvector;
begin
  -- folds the stored stems, drops the duplicates the fold creates, keeps no positions
  v := public.tayf_search_stem_fold(to_tsvector('pg_catalog.turkish', 'Sığınağı vuruldu, güvenliği artırıldı, çocuğu kurtardılar; siginak guvenlik yurt dışına'));
  assert v @@ to_tsquery('pg_catalog.simple', 'siginak & guvenlik & cocuk & dis & yurt'), format('folded stems: %s', v);
  assert strip(v) = v, 'the helper returns a vector without positions';
  assert array_length(tsvector_to_array(v), 1) = (select count(distinct x) from unnest(tsvector_to_array(v)) x), 'no duplicate lexeme';
  -- the vector of a row is the fold of the lexemes of its search_tsv
  assert (select public.tayf_search_stem_fold(c.search_tsv) from public.clusters c where c.id = '00000000-0000-4000-8000-000000186101')
         @@ to_tsquery('pg_catalog.simple', 'siginak'), 'the row of "Sığınağı vuruldu" holds siginak';
  -- edge cases: the empty vector, null, and a lexeme the fold deletes entirely (U+0307 alone): no error, no empty lexeme
  assert public.tayf_search_stem_fold(''::tsvector) = ''::tsvector, 'empty vector';
  assert public.tayf_search_stem_fold(null) is null or public.tayf_search_stem_fold(null) = ''::tsvector, 'null input gives null or an empty vector, never an error';
  v := public.tayf_search_stem_fold(array_to_tsvector(array['x', chr(775), 'Yy']));
  assert tsvector_to_array(v) = array['Yy', 'x'] or tsvector_to_array(v) = array['x', 'Yy'] or tsvector_to_array(v) = array['x', 'yy'] or tsvector_to_array(v) = array['yy', 'x'],
         format('a lexeme made only of U+0307 is left out: %s', v);
  assert not (tsvector_to_array(v) @> array['']), 'no empty lexeme';
  -- same input, same output (immutability is not just declared)
  assert public.tayf_search_stem_fold(to_tsvector('pg_catalog.turkish', 'Güvenliği')) = public.tayf_search_stem_fold(to_tsvector('pg_catalog.turkish', 'Güvenliği')), 'deterministic';
end $$;

-- Called as each role: anon and authenticated are denied; service_role runs both functions. ----------------------
-- (test setup only, never a migration: the stub's clusters table has owner-only privileges, production's service_role is a writer)
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
      perform 1 from public.search_cluster_ids(array['siginak'], 'siginak', 24);
    exception when insufficient_privilege then
      v_denied := true;
    end;
    reset role;
    assert v_denied, format('%s must be denied the RPC', v_role);
    v_denied := false;
    begin
      execute format('set local role %I', v_role);
      perform public.tayf_search_stem_fold(to_tsvector('x'));
    exception when insufficient_privilege then
      v_denied := true;
    end;
    reset role;
    assert v_denied, format('%s must be denied the helper', v_role);
  end loop;

  set local role service_role;
  select count(*) into v_n from public.search_cluster_ids(array['siginak'], 'siginak', 24);
  -- service_role is a writer of public.clusters: the index expression runs as that role on every non-HOT update
  update public.clusters set article_count = article_count where id = '00000000-0000-4000-8000-000000186101';
  update public.clusters set article_count = article_count + 1 where id = '00000000-0000-4000-8000-000000186101';
  update public.clusters set article_count = article_count - 1, updated_at = now() where id = '00000000-0000-4000-8000-000000186101';
  reset role;
  assert v_n > 0, 'service_role must get rows';
end $$;

-- The same argument sets after 186. --------------------------------------------------------------------------
create temp table res_after as
  select qs.q, t.n, t.id from qs cross join lateral public.search_cluster_ids(qs.variants, qs.folded, 50) with ordinality as t(id, n);

do $$
declare
  r record;
  v_before uuid[];
  v_after uuid[];
  v_keys text[];
  v_twin uuid[];
begin
  -- the contract, for every call: 186's list contains 185's, and a call that finds nothing new returns 185's list itself
  for r in select * from qs order by q loop
    select coalesce(array_agg(id order by n), '{}') into v_before from res_before where q = r.q;
    select coalesce(array_agg(id order by n), '{}') into v_after from res_after where q = r.q;
    assert v_after @> v_before, format('call "%s": 186 dropped a row of 185 (%s -> %s)', r.q, v_before, v_after);
    if r.q not in ('siginak', 'yurt disi', 'guvenlik', 'cocuk', 'akp alias') then
      assert v_after = v_before, format('call "%s" has nothing new to find, so 186 must return 185''s list: %s -> %s', r.q, v_before, v_after);
    end if;
  end loop;

  -- an ASCII query gets exactly the rows its Turkish twin has (the twin's list is unchanged by 186)
  for r in select * from (values ('siginak', 'sığınak'), ('yurt disi', 'yurt dışı'), ('guvenlik', 'güvenlik'), ('cocuk', 'çocuk')) v(ascii_q, turkish_q) loop
    select coalesce(array_agg(id order by id), '{}') into v_after from res_after where q = r.ascii_q;
    select coalesce(array_agg(id order by id), '{}') into v_twin from res_after where q = r.turkish_q;
    assert v_after = v_twin, format('"%s" must find the rows of "%s": %s vs %s', r.ascii_q, r.turkish_q, v_after, v_twin);
  end loop;

  -- written out
  select coalesce(array_agg(f.k order by f.k), '{}') into v_keys from res_after a join fx f on f.id = a.id where a.q = 'siginak';
  assert v_keys = array['r101', 'r102', 'r103'], format('siginak after: the three live rows (was r102 and r103), got %s', v_keys);
  select coalesce(array_agg(f.k order by f.k), '{}') into v_keys from res_after a join fx f on f.id = a.id where a.q = 'guvenlik';
  assert v_keys = array['r121', 'r122'], format('guvenlik after: both rows, got %s', v_keys);
  select coalesce(array_agg(f.k order by f.k), '{}') into v_keys from res_after a join fx f on f.id = a.id where a.q = 'cocuk';
  assert v_keys = array['r123', 'r124'], format('cocuk after: both rows, got %s', v_keys);
  assert (select count(*) from res_after where q = 'yurt disi') = 3, 'yurt disi after: the three yurt dışı rows';
  -- a Turkish-typed query gets no new row
  assert (select count(*) from res_after where q = 'sığınak') = 3 and (select count(*) from res_before where q = 'sığınak') = 3, 'sığınak is unchanged';
  -- an inflected ASCII word is not a stem: it keeps finding what it found (limit 1 of the documented KNOWN LIMITS)
  assert (select count(*) from res_after where q = 'guvenligi') = (select count(*) from res_before where q = 'guvenligi'), 'guvenligi is unchanged';
  -- the 166 guard stays: burdur keeps its row and not Bursa, and the bürün row (stem bür, folded bur) is removed by the guard
  select coalesce(array_agg(f.k order by f.k), '{}') into v_keys from res_after a join fx f on f.id = a.id where a.q = 'burdur';
  assert v_keys = array['r141'], format('burdur after: the guard keeps only the Burdur row, got %s', v_keys);
  -- the exempt-word tier of 172 stays: the Miller row first
  assert (select f.k from res_after a join fx f on f.id = a.id where a.q = 'miller' and a.n = 1) = 'r144', 'miller: the tier still puts the Miller row first';
  -- phrase and negated queries run (no error) and keep 185's list (checked above). The alias query has the documented weak
  -- candidate (KNOWN LIMIT 2 of the header): 'Ağı' is stored as the stem 'ak', which the unquoted folded side 'ak & parti' of
  -- the alias query matches next to 'parti'; the two rows that say AKP and AK Parti stay, and the weak one comes last
  select coalesce(array_agg(f.k order by a.n), '{}') into v_keys from res_after a join fx f on f.id = a.id where a.q = 'akp alias';
  assert v_keys[1:2] = (select coalesce(array_agg(f.k order by b.n), '{}') from res_before b join fx f on f.id = b.id where b.q = 'akp alias'), 'the alias query keeps its two rows first';
  assert cardinality(v_keys) = 3 and v_keys[3] = 'r151', format('the alias query gets the one weak candidate (r151) after them, got %s', v_keys);
  -- archived and single-article rows never appear
  assert not exists (select 1 from res_after a join fx f on f.id = a.id where f.k in ('r131', 'r132')), 'the live predicate holds';
  assert (select count(*) from res_after where q = 'empty') = 0, 'the empty query finds nothing';
end $$;

-- Fuzz: hostile strings go through the real function with the arguments the app would build; none may raise. -------------
do $$
declare
  v_s text;
  v_n bigint;
  v_cases text[] := array[
    'a', 'ab', 'siginak', 'yurt disi', '"yurt disi"', '-siginak', 'siginak or yurt', 'or', 'OR or Or', '(siginak)', 'siginak & yurt', 'siginak | yurt',
    '!siginak', 'siginak:*', 'siginak <-> yurt', 'siginak<->yurt', '<->', '<2>', '''', '''''', 'o''brien', 'a''b''c', '\', '\\', 'a\b', '"', '""', '"a', 'a"',
    'a-b', 'a--b', '-a-b-', '- -', '---', 'covid-19', 'covid_19', 'x.y', '3.5', '192.168.1.1', 'a@b.c', 'http://x.y/z?q=1', '/usr/bin', 'ğüşıöç', 'ĞÜŞİÖÇ', 'ı', 'İ',
    'i̇', 'e'||chr(769), chr(775), 'a'||chr(775)||'b', chr(8217), 'x'||chr(8217)||'y', '😀', 'a😀b', 'ａｂｃ', 'ﬁ', repeat('a', 64), repeat('ı', 64), repeat('a ', 32),
    '1 2 3 4 5 6', '& & &', '| | |', '! ! !', '( ) ( )', ':* :*', 'a:', ':a', 'a:b', 'a:*b', 'null', '%', '_', '*', '?', ';', ',', '.', '[a]', '{a}', '^a$', '$1', 'a b c d e f g h',
    'sığınak', 'yurt dışı', 'veya', 've', 'bir', 'için'
  ];
begin
  foreach v_s in array v_cases loop
    -- the app sends the lower-cased query as the variant and its fold as p_folded
    select count(*) into v_n from public.search_cluster_ids(array[lower(v_s)], public.tayf_search_fold(v_s), 5);
    select count(*) into v_n from public.search_cluster_ids(array[lower(v_s), lower(v_s) || ' x'], public.tayf_search_fold(v_s), 5);
  end loop;
  -- and a null variants array, a null folded query, a null limit
  select count(*) into v_n from public.search_cluster_ids(null, 'siginak', 5);
  select count(*) into v_n from public.search_cluster_ids(array['siginak'], null, 5);
  select count(*) into v_n from public.search_cluster_ids(array['siginak'], 'siginak', null);
end $$;

-- The pre-built path: drop the helper and the index, run the header's ORCHESTRATOR PRE-BUILD steps as written (the helper in a
-- transaction, the index CONCURRENTLY in autocommit), check no invalid index is left, then apply 186 again: it must leave the
-- pre-built index alone (same relation, not rebuilt). ----------------------------------------------------------------------
drop index public.clusters_search_stemfold_live_idx;
drop function public.tayf_search_stem_fold(tsvector);

begin;
create or replace function public.tayf_search_stem_fold(p tsvector)
returns tsvector
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select pg_catalog.array_to_tsvector(array(
    select distinct x
    from pg_catalog.unnest(pg_catalog.string_to_array(public.tayf_search_fold(pg_catalog.array_to_string(pg_catalog.tsvector_to_array(p), pg_catalog.chr(1))), pg_catalog.chr(1))) as x
    where x <> ''))
$fn$;
revoke all on function public.tayf_search_stem_fold(tsvector) from public, anon, authenticated;
grant execute on function public.tayf_search_stem_fold(tsvector) to service_role;
commit;

create index concurrently if not exists clusters_search_stemfold_live_idx on public.clusters using gin (public.tayf_search_stem_fold(search_tsv)) where not is_archived and article_count >= 2;

create temp table prebuilt as select 'public.clusters_search_stemfold_live_idx'::regclass::oid as oid;
do $$
begin
  assert (select count(*) from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid = i.indexrelid where c.relname = 'clusters_search_stemfold_live_idx' and not i.indisvalid) = 0,
         'the invalid-index check of the header returns 0 rows';
end $$;

\ir ../../../supabase/migrations/186_search_stem_fold_arm.sql

do $$
begin
  assert 'public.clusters_search_stemfold_live_idx'::regclass::oid = (select oid from prebuilt), 'the migration left the pre-built index alone';
  assert (select count(*) from supabase_migrations.schema_migrations where version = '186') = 1, 'still one ledger row for 186';
  assert md5((select prosrc from pg_catalog.pg_proc where oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure)) = '973e3707e98448b0385bd0402c039df3', 'the body is the file''s';
  assert (select count(*) from public.search_cluster_ids(array['siginak'], 'siginak', 24)) = 3, 'siginak finds its three rows through the pre-built index';
end $$;

delete from public.clusters where id::text like '00000000-0000-4000-8000-0000001861%';

-- Realistic load: 8,000 live clusters (rolled back); the 185 body and the 186 body run inline as plain SELECTs with
-- EXPLAIN (ANALYZE), the same arguments, the way the migration header measures. -----------------------------------------
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
      'güvenliği','çocuğu','dışında','yurt','savaş','hırsızlığı','güvenlik','çocuk'
    ]) as w
    union all
    select translate(substr(md5('w' || g::text), 1, 7), '0123456789', 'ghjklmnprs')
      from generate_series(1, 400) g
  ) x;

insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at)
select gen_random_uuid(),
       (select string_agg(v.w, ' ') from (select (select t.w from (select 1 + floor(power(random(), 2.0) * 480)::integer + k * 0 as pick) q join tmp_vocab t on t.i = q.pick) as w
                                              from generate_series(1, 8 + (g % 4)) k) v),
       null,
       (select string_agg(v.w, ' ') from (select (select t.w from (select 1 + floor(power(random(), 2.0) * 480)::integer + k * 0 as pick) q join tmp_vocab t on t.i = q.pick) as w
                                              from generate_series(1, 40 + (g % 20)) k) v),
       2 + (g % 19),
       false,
       now() - random() * interval '60 days'
  from generate_series(1, 8000) g;
-- a few dozen rows that hold the inflected Turkish word the ASCII query is typed against, so the third arm has rows to find
insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at)
select gen_random_uuid(), w.t || ' ' || g, null, 'Haber metni ' || g, 2 + (g % 5), false, now() - random() * interval '60 days'
  from generate_series(1, 40) g
  cross join (values ('Sığınağı vuruldu'), ('Sığınaktan çıktılar'), ('Yurt dışına çıkış')) w(t);
analyze public.clusters;

create function pg_temp.median_ms(p_src text, p_variants text[], p_folded text, p_runs integer default 5) returns numeric
language plpgsql as $f$
declare
  v_src text;
  v_line text;
  v_ms numeric[] := '{}';
  i integer;
begin
  v_src := replace(replace(replace(p_src, 'p_variants', format('(%L::text[])', p_variants)), 'p_folded', format('(%L::text)', p_folded)), 'p_limit', '24');
  for i in 0..p_runs loop
    for v_line in execute 'explain (analyze) ' || v_src loop
      if i > 0 and v_line like 'Execution Time:%' then v_ms := v_ms || substring(v_line from '([0-9.]+) ms')::numeric; end if;
    end loop;
  end loop;
  return (select percentile_cont(0.5) within group (order by m) from unnest(v_ms) m);
end $f$;

create function pg_temp.plan_text(p_src text, p_variants text[], p_folded text) returns text
language plpgsql as $f$
declare
  v_src text;
  v_line text;
  v_plan text := '';
begin
  v_src := replace(replace(replace(p_src, 'p_variants', format('(%L::text[])', p_variants)), 'p_folded', format('(%L::text)', p_folded)), 'p_limit', '24');
  for v_line in execute 'explain ' || v_src loop
    v_plan := v_plan || v_line || E'\n';
  end loop;
  return v_plan;
end $f$;

-- The plan: the third arm reads clusters_search_stemfold_live_idx (a bitmap index scan), beside the two other indexes, no
-- sequential scan of public.clusters.
do $$
declare
  v_new text;
  v_plan text;
  v_q record;
begin
  select p.prosrc into v_new from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
  for v_q in select * from (values ('siginak', array['siginak'], 'siginak'), ('sığınak', array['sığınak'], 'siginak')) as t(typed, variants, folded) loop
    v_plan := pg_temp.plan_text(v_new, v_q.variants, v_q.folded);
    assert v_plan like '%Index Scan on clusters_search_stemfold_live_idx%', format('%s: the plan must use clusters_search_stemfold_live_idx:%s%s', v_q.typed, E'\n', v_plan);
    assert v_plan like '%on clusters_search_tsv_live_idx%' and v_plan like '%on clusters_search_fold_live_idx%', format('%s: the other two arms keep their indexes', v_q.typed);
    assert v_plan not like '%Seq Scan on clusters%', format('%s: no sequential scan of clusters:%s%s', v_q.typed, E'\n', v_plan);
  end loop;
end $$;

-- Timing: the 185 body and the 186 body, inline, SAME arguments, alternating, the median of 5 runs each after one warm-up run
-- each. Production is the measurement of record (the migration header: iran and erdogan within 1.3x). The third arm is one more
-- bitmap index scan and one more branch of the union; a call that finds nothing new must cost what 185 costs. A gross
-- regression fails (bound 1.5x on this load).
do $$
declare
  v_old text;
  v_new text;
  v_q record;
  v_a numeric;
  v_b numeric;
  v_ratio numeric;
begin
  select prosrc into v_old from old_src;
  select p.prosrc into v_new from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
  for v_q in select * from (values
      ('iran', array['iran'], 'iran'),
      ('seçim', array['seçim'], 'secim'),
      ('bakan', array['bakan'], 'bakan'),
      ('güvenlik', array['güvenlik'], 'guvenlik'),
      ('yurt dışı', array['yurt dışı', 'yurt dişi'], 'yurt disi'),
      ('burdur', array['burdur'], 'burdur')
    ) as t(typed, variants, folded) loop
    v_a := pg_temp.median_ms(v_old, v_q.variants, v_q.folded);
    v_b := pg_temp.median_ms(v_new, v_q.variants, v_q.folded);
    v_ratio := v_b / v_a;
    raise notice '%: 185 body % ms, 186 body % ms, median ratio %', v_q.typed, v_a, v_b, round(v_ratio, 2);
    assert v_ratio < 1.5, format('%s: the 186 body took %sx the 185 body (bound 1.5x on this load)', v_q.typed, round(v_ratio, 2));
  end loop;
  -- the arm finds rows on the load: the ASCII query returns the rows of the Turkish one
  assert (select count(*) from public.search_cluster_ids(array['siginak'], 'siginak', 50)) = (select count(*) from public.search_cluster_ids(array['sığınak'], 'siginak', 50)), 'siginak equals sığınak on the load';
  assert (select count(*) from public.search_cluster_ids(array['siginak'], 'siginak', 50)) = 50, 'and there are more than 50 of them (the 80 inserted rows)';
end $$;
rollback;

\echo DRYRUN 186 OK
