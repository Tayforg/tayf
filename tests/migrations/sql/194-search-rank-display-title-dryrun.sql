-- 194 search rank on the display title: local PG15 dry-run. Never touches production.
--
-- Run on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir
--   $PGBIN/initdb -D $D -U postgres -A trust -E UTF8 --locale=en_US.UTF-8 >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55594 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55594 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql \
--     -f tests/migrations/sql/194-search-rank-display-title-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql PGHOST=/tmp PGPORT=55594 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/194-search-rank-display-title)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh    (TAYF_LIVE_ONLY=194 runs just this one)
--
-- (\ir paths below are relative to this file.) Every check is a DO block that raises on mismatch, so a clean run ending in
-- "DRYRUN 194 OK" is the pass. 194 is applied twice (re-apply safety). The database this leaves behind has 129, 166, 172, 185,
-- 186 and 194 applied and holds no fixture row (the live block of 194-search-rank-display-title.test.ts seeds its own, inside a
-- transaction).
--
-- Order: the 129 state (166-search-overstem-guard-setup.sql: search_tsv, 083's index, 129 itself), then 166, 172, 185 and 186
-- from their own files, 186 gated on its md5 (973e3707..., length 14850: the base of 194, and what production runs); a fixture of
-- the rows of h116-search-1 (a 197-day-old typed-form row against last week's nine-source plural story, a 165-day-old title that
-- repeats the word, a hidden-headline row, a row with no neutral title, the two spellings of one name) and of the controls 194
-- must not change; the answers of 186's function (baseline: 186) to a list of argument sets; then 194, ledger / shape / ACL, the
-- denied roles, and the same list again. The contract checked for every call is: 194 returns exactly 186's id set (ranking never
-- changes recall), the fixtures order the way the header says, a Turkish query and its ASCII fold order a shared candidate set
-- alike, and the guard, the tier and the alias query keep their behaviour. Then a fuzz of hostile strings through the real
-- function (no error), and a synthetic load of 8,000 live clusters (rolled back): the UNCAPPED id set of 186's body and of
-- 194's body is the same for six queries, the plan keeps its three index scans, and the timing of the two bodies is compared
-- with EXPLAIN (ANALYZE).

\set ON_ERROR_STOP on

-- Prelude: Supabase default privileges (so the revokes have something to undo). ---------------------------
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;

-- The 129 state, then 166, 172, 185 and 186. -----------------------------------------------------------------------
\ir 166-search-overstem-guard-setup.sql
\ir ../../../supabase/migrations/166_search_overstem_guard.sql
\ir ../../../supabase/migrations/172_search_exempt_word_tier.sql
\ir ../../../supabase/migrations/185_search_sibling_variants.sql
\ir ../../../supabase/migrations/186_search_stem_fold_arm.sql

-- 186's body is the base (md5(prosrc) 973e3707e98448b0385bd0402c039df3, length 14850). ------------------------------
create temp table old_src as
  select p.prosrc from pg_catalog.pg_proc p
   where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
do $$
declare
  v_md5 text;
  v_len integer;
begin
  select md5(prosrc), length(prosrc) into v_md5, v_len from old_src;
  assert v_md5 = '973e3707e98448b0385bd0402c039df3', format('186 body md5 %s (the base: 973e3707...)', v_md5);
  assert v_len = 14850, format('186 body length %s (the base: 14850)', v_len);
  assert (select count(*) from supabase_migrations.schema_migrations where version = '186') = 1, '186 must be applied';
  assert (select count(*) from supabase_migrations.schema_migrations where version = '194') = 0, '194 must not be applied yet';
  assert to_regclass('public.clusters_search_stemfold_live_idx') is not null, '186 built its index';
end $$;

-- 186's function under a temp name, to run beside 194's installed one (same text, same attributes). ---------------
do $$
begin
  execute format(
    'create function pg_temp.f186(p_variants text[], p_folded text, p_limit integer default 12) returns table (id uuid) '
    || 'language sql stable set search_path = %L as %L',
    '', (select prosrc from old_src));
end $$;

-- Fixture (committed here, removed at the end). ids 00000000-0000-4000-8000-0000001941NN ---------------------------------
create temp table fx (id uuid primary key, k text not null);
with v(n, k, title, neutral, summary, members, archived, age) as (values
  -- (a) the emekli maaşı pair: A is 197 days old and carries the typed form in its display title, B is last week's nine-source
  --     story whose display title has the plural
  (101, 'A', 'Seçime doğru maaş ve ücret kulisi', 'İktidardan seçim hazırlığı: Emekli maaşı ve asgari ücret değişiyor', 'Kulis haberi.', 2, false, interval '197 days'),
  (102, 'B', 'Şimşek: Emekli maaşlarına zam yok', 'Mehmet Şimşek''ten emekli maaşlarına ilişkin açıklama', 'Bakan konuştu.', 9, false, interval '5 days'),
  -- A2 holds the singular form too, so BOTH spellings of the query reach it (the stemmer cannot inflect ASCII: 'maasi' never
  -- reaches B's 'maaşlarına', which is 186's recall and stays); A and A2 are the shared candidates of the parity check
  (108, 'A2', 'Emekli maaşı için yeni formül masada', null, 'Hazırlık sürüyor.', 6, false, interval '4 days'),
  -- (b) the deprem pair: C repeats the word in an old boilerplate title, D is a 10-source story from 12 days ago
  (103, 'C', 'Muğla''da deprem mi oldu?', 'Muğla''da deprem mi oldu? Az önce deprem Muğla''da nerede oldu?', 'Son depremler listesi.', 3, false, interval '165 days'),
  (104, 'D', 'Ege Denizi''nde deprem: büyüklük 4,7', 'Ege Denizi''nde 4,7 büyüklüğünde deprem', 'AFAD duyurdu.', 10, false, interval '12 days'),
  -- (c) E holds the word only in the hidden original headline, F in the display title, G has no neutral title
  (105, 'E', 'Macaristan''da siyasi deprem! Orban seçimi kaybetti', 'Macaristan''da hükümet değişti: Orban seçimi kaybetti', 'Seçim sonucu açıklandı.', 2, false, interval '0 days'),
  (106, 'F', 'Malatya''da deprem hasarı', 'Deprem sonrası Malatya''da hasar tespiti sürüyor', 'Ekipler bölgede.', 3, false, interval '2 days'),
  (107, 'G', 'Deprem bölgesinde konteyner kent kuruldu', null, 'Çadırlar kaldırılıyor.', 4, false, interval '20 days'),
  -- the two spellings of one name
  (111, 'imam1', 'İmamoğlu davasında yeni gelişme', null, 'Duruşma ertelendi.', 5, false, interval '2 days'),
  (112, 'imam2', 'İmamoğlu''nun avukatları açıklama yaptı', null, 'Savunma konuştu.', 3, false, interval '3 days'),
  (113, 'imam3', 'İBB soruşturması: İmamoğlu ifade verdi', 'İBB soruşturmasında İmamoğlu ifade verdi', 'Ifade alındı.', 4, false, interval '40 days'),
  -- controls of 166, 172 and the alias query
  (121, 'burdur', 'Burdur''da yurt zehirlenmesi', null, 'Öğrenciler hastaneye kaldırıldı.', 2, false, interval '1 hour'),
  (122, 'bursa', 'Bursa''da deprem uyarısı', null, 'Uzmanlar uyardı.', 2, false, interval '2 hours'),
  (123, 'burun', 'Hak hukuk tanımazlığın ete kemiğe büründüğü bir gün', null, 'Tepki büyüdü.', 2, false, interval '3 hours'),
  (124, 'miller', 'Miller açıklama yaptı', null, 'Açıklama geldi.', 2, false, interval '10 hours'),
  (125, 'milMili', 'Mili Eğitim Bakanlığı toplantısı', null, 'Toplantı yapıldı.', 2, false, interval '11 hours'),
  (131, 'akp1', 'AKP''den açıklama', null, 'Parti sözcüsü konuştu.', 2, false, interval '16 hours'),
  (132, 'akp2', 'AK Parti toplantısı', null, 'Grup toplantısı yapıldı.', 3, false, interval '17 hours'),
  (133, 'akpAgi', 'Aile Dayanışma Ağı yeni bir parti çağrısı yaptı', null, 'Çağrı sürdü.', 2, false, interval '18 hours'),
  (134, 'seçim', 'Seçim sonuçları açıklandı', null, 'Kurul sonuçları duyurdu.', 2, false, interval '15 hours'),
  -- archived and single-article rows are never candidates
  (141, 'arch', 'Deprem arşiv haberi', null, 'Arşivde.', 2, true, interval '11 hours'),
  (142, 'single', 'Deprem tek kaynaklı haber', null, 'Tek kaynak.', 1, false, interval '11 hours')
), ins as (
  insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at)
  select ('00000000-0000-4000-8000-000000194' || lpad(v.n::text, 3, '0'))::uuid, v.title, v.neutral, v.summary, v.members, v.archived, now() - v.age
    from v
  returning id
)
insert into fx select ('00000000-0000-4000-8000-000000194' || lpad(v.n::text, 3, '0'))::uuid, v.k from v;
analyze public.clusters;

-- The argument sets the app sends: the typed spellings (turkishQueryVariants), p_folded = foldTr(query). -------------
create temp table qs (q text primary key, variants text[] not null, folded text);
insert into qs values
  ('emekli maaşı',        array['emekli maaşı'],                       'emekli maasi'),
  ('emekli maasi',        array['emekli maasi'],                       'emekli maasi'),
  ('emekli maaşı app',    array['emekli maaşı', 'emekli maaşi'],       'emekli maasi'),
  ('deprem',              array['deprem'],                             'deprem'),
  ('imamoğlu',            array['imamoğlu'],                           'imamoglu'),
  ('imamoglu',            array['imamoglu'],                           'imamoglu'),
  ('burdur',              array['burdur'],                             'burdur'),
  ('miller',              array['miller'],                             'miller'),
  ('iran',                array['iran'],                               'iran'),
  ('seçim sonucu',        array['seçim sonucu'],                       'secim sonucu'),
  ('akp alias',           array['akp or "ak parti"'],                  'akp or ak parti'),
  ('akp quoted',          array['akp or "ak parti"'],                  'akp or "ak parti"'),
  ('phrase',              array['"emekli maaşı"'],                     '"emekli maasi"'),
  ('negated',             array['deprem -bursa'],                      'deprem -bursa'),
  ('negated phrase',      array['iran -"israil saldırısı"'],           'iran -"israil saldirisi"'),
  ('sibling six',         array['elektrik zammı', 'elektrik zammi', 'elektrik zam'], 'elektrik zammi'),
  ('empty',               array[''],                                   ''),
  ('null folded',         array['burdur'],                             null);

-- baseline: 186 (the base body) at p_limit 50, the way the app asks. -------------------------------------------------
create temp table res_before as
  select qs.q, t.n, t.id from qs cross join lateral pg_temp.f186(qs.variants, qs.folded, 50) with ordinality as t(id, n);

create function pg_temp.keys(p_tbl text, p_q text) returns text[]
language plpgsql as $f$
declare
  v text[];
begin
  execute format('select coalesce(array_agg(f.k order by r.n), ''{}'') from %I r join fx f on f.id = r.id where r.q = %L', p_tbl, p_q) into v;
  return v;
end $f$;

-- The defect is there on the 186 body (so the "after" below proves something). ----------------------------------------------
do $$
declare
  v_keys text[];
begin
  v_keys := pg_temp.keys('res_before', 'emekli maaşı');
  assert v_keys @> array['A', 'B'], format('baseline: "emekli maaşı" finds A and B, got %s', v_keys);
  assert array_position(v_keys, 'A') < array_position(v_keys, 'B'), format('baseline: 186 ranks the 197-day-old typed form A above the fresh plural story B, got %s', v_keys);
  v_keys := pg_temp.keys('res_before', 'deprem');
  assert v_keys @> array['C', 'D', 'E', 'F', 'G'], format('baseline: "deprem" finds C, D, E, F and G, got %s', v_keys);
  assert array_position(v_keys, 'E') < array_position(v_keys, 'F'), format('baseline: 186 gave E the literal tier through the hidden headline, got %s', v_keys);
  assert not (v_keys && array['arch', 'single']), 'baseline: archived and single-article rows are never candidates';
  assert (select max(c) from (select count(*) as c from res_before group by q) m) < 50, 'the fixture keeps every list far below the 50-row cap';
end $$;

-- Apply 194 TWICE (re-apply safety). --------------------------------------------------------------------------
create temp table idx_before as select indexname from pg_catalog.pg_indexes where schemaname = 'public' and tablename = 'clusters';
\ir ../../../supabase/migrations/194_search_rank_display_title.sql
\ir ../../../supabase/migrations/194_search_rank_display_title.sql

-- Ledger, shape and ACL after both runs -----------------------------------------------------------------------------
do $$
declare
  v_n integer;
  v_p pg_catalog.pg_proc%rowtype;
  v_acl text;
begin
  select count(*) into v_n from supabase_migrations.schema_migrations where version = '194';
  assert v_n = 1, format('ledger rows for 194: %s (expected exactly 1)', v_n);
  assert (select name from supabase_migrations.schema_migrations where version = '194') = '194_search_rank_display_title', 'ledger name';
  assert (select count(*) from supabase_migrations.schema_migrations where version = '186') = 1, '186 ledger row is untouched';

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
  assert obj_description(v_p.oid, 'pg_proc') like '%194%' and obj_description(v_p.oid, 'pg_proc') like '%display title%', 'function comment must mention the display-title ranking of 194';
  assert md5(v_p.prosrc) <> '973e3707e98448b0385bd0402c039df3', 'the body must have changed';
  assert md5(v_p.prosrc) = '53eddcee85dc444ef0e24ad7087f5b00' and length(v_p.prosrc) = 18894,
         format('194 body md5 %s length %s (the file: 53eddcee85dc444ef0e24ad7087f5b00, 18894)', md5(v_p.prosrc), length(v_p.prosrc));
  assert not has_function_privilege('anon', v_p.oid, 'execute'), 'anon must not execute';
  assert not has_function_privilege('authenticated', v_p.oid, 'execute'), 'authenticated must not execute';
  assert has_function_privilege('service_role', v_p.oid, 'execute'), 'service_role must execute';
  assert not exists (select 1 from aclexplode(v_p.proacl) a where a.grantee = 0), 'PUBLIC must have no grant';
  select string_agg(a.grantee::regrole::text, ',' order by a.grantee::regrole::text) into v_acl from aclexplode(v_p.proacl) a;
  assert v_acl = 'postgres,service_role', format('grantees: %s', v_acl);

  -- 194 adds and drops no index, no helper, no overload: 186's objects are untouched
  assert (select string_agg(indexname, ',' order by indexname) from pg_catalog.pg_indexes where schemaname = 'public' and tablename = 'clusters')
         = (select string_agg(indexname, ',' order by indexname) from idx_before), '194 changes no index';
  assert to_regclass('public.clusters_search_stemfold_live_idx') is not null, '186 index still there';
  assert (select count(*) from pg_catalog.pg_proc where pronamespace = 'public'::regnamespace and proname = 'tayf_search_stem_fold') = 1, 'the helper of 186 is untouched';
  assert (select count(*) from pg_catalog.pg_proc where pronamespace = 'public'::regnamespace and proname = 'tayf_search_fold') = 1, 'fold overloads';
end $$;

-- Called as each role: anon and authenticated are denied; service_role runs the function. ----------------------------
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
      perform 1 from public.search_cluster_ids(array['deprem'], 'deprem', 24);
    exception when insufficient_privilege then
      v_denied := true;
    end;
    reset role;
    assert v_denied, format('%s must be denied the RPC', v_role);
  end loop;

  set local role service_role;
  select count(*) into v_n from public.search_cluster_ids(array['deprem'], 'deprem', 24);
  reset role;
  assert v_n > 0, 'service_role must get rows';
end $$;

-- The same argument sets after 194. --------------------------------------------------------------------------
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
begin
  -- the contract, for every call: 194's id SET is 186's (ranking never changes recall), and no id repeats
  for r in select * from qs order by q loop
    select coalesce(array_agg(id order by id), '{}') into v_before from res_before where q = r.q;
    select coalesce(array_agg(id order by id), '{}') into v_after from res_after where q = r.q;
    assert v_after = v_before, format('call "%s": the id set changed (%s -> %s)', r.q, v_before, v_after);
    assert (select count(*) from res_after where q = r.q) = (select count(distinct id) from res_after where q = r.q), format('call "%s": a duplicate id', r.q);
  end loop;
  assert (select count(*) from res_after) = (select count(*) from res_before), 'the same number of rows overall';

  -- (a) the fresh nine-source plural story B before the 197-day-old typed form A
  v_keys := pg_temp.keys('res_after', 'emekli maaşı');
  assert v_keys @> array['A', 'B'] and array_position(v_keys, 'B') < array_position(v_keys, 'A'), format('emekli maaşı: B before A, got %s', v_keys);
  v_keys := pg_temp.keys('res_after', 'emekli maaşı app');
  assert array_position(v_keys, 'B') < array_position(v_keys, 'A'), format('emekli maaşı (two variants): B before A, got %s', v_keys);
  -- (b) the 10-source story D before the 165-day-old title C that repeats the word
  v_keys := pg_temp.keys('res_after', 'deprem');
  assert array_position(v_keys, 'D') < array_position(v_keys, 'C'), format('deprem: D before C, got %s', v_keys);
  -- (c) F (the display title has the word) before E (only the hidden headline has it), and E is still there
  assert v_keys @> array['E'], 'E is still returned';
  assert array_position(v_keys, 'F') < array_position(v_keys, 'E'), format('deprem: F before E, got %s', v_keys);
  -- G has no neutral title: its original title is its display title
  assert array_position(v_keys, 'G') < array_position(v_keys, 'E'), format('deprem: G (no neutral title, the word in the shown title) before E, got %s', v_keys);
  assert not (v_keys && array['arch', 'single']), 'archived and single-article rows never appear';

  -- (d) the same p_folded, the Turkish and the ASCII spelling: the shared candidates are in the same order
  v_a := pg_temp.keys('res_after', 'emekli maaşı');
  v_b := pg_temp.keys('res_after', 'emekli maasi');
  assert v_b @> array['A', 'A2'] and array_position(v_b, 'A2') < array_position(v_b, 'A'), format('emekli maasi: the shared candidates A2 before A, got %s', v_b);
  assert not (v_b && array['B']), 'B (the plural) is reached by the Turkish spelling only: 186''s recall, unchanged';
  assert (select coalesce(array_agg(k order by pos), '{}') from (select k, array_position(v_a, k) pos from unnest(v_a) k where k = any(v_b)) x)
       = (select coalesce(array_agg(k order by pos), '{}') from (select k, array_position(v_b, k) pos from unnest(v_b) k where k = any(v_a)) x),
         format('emekli: the shared candidates keep their order: %s vs %s', v_a, v_b);
  v_a := pg_temp.keys('res_after', 'imamoğlu');
  v_b := pg_temp.keys('res_after', 'imamoglu');
  assert v_a = v_b and cardinality(v_a) >= 3, format('imamoğlu and imamoglu: the same list, got %s vs %s', v_a, v_b);

  -- (e) the alias and the OR query have no literal tier; their rows are all there
  v_keys := pg_temp.keys('res_after', 'akp alias');
  assert v_keys @> array['akp1', 'akp2'], format('akp alias: both party rows, got %s', v_keys);
  assert array_position(v_keys, 'akpAgi') is null or array_position(v_keys, 'akpAgi') > array_position(v_keys, 'akp1'), format('akp alias: the weak Ağı row after akp1, got %s', v_keys);

  -- the 166 guard stays: burdur keeps its row and not Bursa, and the bürün row is removed by the guard
  assert pg_temp.keys('res_after', 'burdur') = array['burdur'], format('burdur after: the guard keeps only the Burdur row, got %s', pg_temp.keys('res_after', 'burdur'));
  -- the exempt-word tier of 172 stays: the Miller row first
  assert (pg_temp.keys('res_after', 'miller'))[1] = 'miller', 'miller: the tier still puts the Miller row first';
  -- empty and null inputs
  assert (select count(*) from res_after where q = 'empty') = 0, 'the empty query finds nothing';
  -- a null p_folded switches the guard and the tiers off (no guard word): the variants arm still finds the Burdur row, and the set is 186's (checked above)
  assert pg_temp.keys('res_after', 'null folded') @> array['burdur'], format('a null p_folded runs and finds the variants arm rows, got %s', pg_temp.keys('res_after', 'null folded'));
end $$;

-- Fuzz: hostile strings go through the real function with the arguments the app would build; none may raise. -------------
do $$
declare
  v_s text;
  v_n bigint;
  v_cases text[] := array[
    'a', 'ab', 'deprem', 'emekli maaşı', '"emekli maaşı"', '-deprem', 'deprem or yurt', 'or', 'OR or Or', '(deprem)', 'deprem & yurt', 'deprem | yurt',
    '!deprem', 'deprem:*', 'deprem <-> yurt', 'deprem<->yurt', '<->', '<2>', '''', '''''', 'o''brien', 'a''b''c', '\', '\\', 'a\b', '"', '""', '"a', 'a"',
    'a-b', 'a--b', '-a-b-', '- -', '---', 'covid-19', 'covid_19', 'x.y', '3.5', '192.168.1.1', 'a@b.c', 'http://x.y/z?q=1', '/usr/bin', 'ğüşıöç', 'ĞÜŞİÖÇ', 'ı', 'İ',
    'i̇', 'e'||chr(769), chr(775), 'a'||chr(775)||'b', chr(8217), 'x'||chr(8217)||'y', '😀', 'a😀b', 'ａｂｃ', 'ﬁ', repeat('a', 64), repeat('ı', 64), repeat('a ', 32),
    '1 2 3 4 5 6', '& & &', '| | |', '! ! !', '( ) ( )', ':* :*', 'a:', ':a', 'a:b', 'a:*b', 'null', '%', '_', '*', '?', ';', ',', '.', '[a]', '{a}', '^a$', '$1', 'a b c d e f g h',
    '[', '[[', '(?', '(?<=', '\d+', '.*', '^', '$', 'a|b', 'a)(b', 'imamoğlu', 'yurt dışı', 'veya', 've', 'bir', 'için'
  ];
begin
  foreach v_s in array v_cases loop
    -- the app sends the lower-cased query as the variant and its fold as p_folded
    select count(*) into v_n from public.search_cluster_ids(array[lower(v_s)], public.tayf_search_fold(v_s), 5);
    select count(*) into v_n from public.search_cluster_ids(array[lower(v_s), lower(v_s) || ' x'], public.tayf_search_fold(v_s), 5);
  end loop;
  -- and a null variants array, a null folded query, a null limit
  select count(*) into v_n from public.search_cluster_ids(null, 'deprem', 5);
  select count(*) into v_n from public.search_cluster_ids(array['deprem'], null, 5);
  select count(*) into v_n from public.search_cluster_ids(array['deprem'], 'deprem', null);
end $$;

delete from public.clusters where id::text like '00000000-0000-4000-8000-000000194%';

-- Realistic load: 8,000 live clusters (rolled back); the 186 body and the 194 body run inline as plain SELECTs, the same
-- arguments, with the p_limit clause removed: the UNCAPPED id set (up to the 1000-row scoring cap) must be identical, and the two
-- bodies are timed with EXPLAIN (ANALYZE). ---------------------------------------------------------------------------------
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

create function pg_temp.median_ms(p_src text, p_variants text[], p_folded text, p_runs integer default 5) returns numeric
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
  return (select percentile_cont(0.5) within group (order by m) from unnest(v_ms) m);
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

-- The id set of the two bodies on the load: the same for every query, and not vacuous. ----------------------------------
do $$
declare
  v_old text;
  v_new text;
  v_q record;
  v_a uuid[];
  v_b uuid[];
begin
  select prosrc into v_old from old_src;
  select p.prosrc into v_new from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
  for v_q in select * from (values
      ('deprem', array['deprem'], 'deprem'),
      ('emekli maaşı', array['emekli maaşı', 'emekli maaşi'], 'emekli maasi'),
      ('imamoğlu', array['imamoğlu'], 'imamoglu'),
      ('imamoglu', array['imamoglu'], 'imamoglu'),
      ('seçim', array['seçim'], 'secim'),
      ('akp alias', array['akp or "ak parti"'], 'akp or ak parti'),
      ('burdur', array['burdur'], 'burdur'),
      ('merkez bankası', array['merkez bankası', 'merkez bankasi'], 'merkez bankasi')
    ) as t(typed, variants, folded) loop
    v_a := pg_temp.id_set(v_old, v_q.variants, v_q.folded);
    v_b := pg_temp.id_set(v_new, v_q.variants, v_q.folded);
    raise notice '%: % ids on the load, same set: %', v_q.typed, cardinality(v_a), v_a = v_b;
    assert v_a = v_b, format('%s: the uncapped id set changed (%s -> %s ids)', v_q.typed, cardinality(v_a), cardinality(v_b));
  end loop;
  assert cardinality(pg_temp.id_set(v_new, array['deprem'], 'deprem')) > 24, 'deprem has more than a page of candidates on the load';
end $$;

-- The plan: 194 reads the same three indexes (the ORDER BY is the only change), no sequential scan of public.clusters. ----
do $$
declare
  v_new text;
  v_plan text;
  v_q record;
begin
  select p.prosrc into v_new from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
  for v_q in select * from (values ('deprem', array['deprem'], 'deprem'), ('siginak', array['siginak'], 'siginak')) as t(typed, variants, folded) loop
    v_plan := pg_temp.plan_text(v_new, v_q.variants, v_q.folded);
    assert v_plan like '%Index Scan on clusters_search_stemfold_live_idx%', format('%s: the plan must keep clusters_search_stemfold_live_idx:%s%s', v_q.typed, E'\n', v_plan);
    assert v_plan like '%on clusters_search_tsv_live_idx%' and v_plan like '%on clusters_search_fold_live_idx%', format('%s: the other two arms keep their indexes', v_q.typed);
    assert v_plan not like '%Seq Scan on clusters%', format('%s: no sequential scan of clusters:%s%s', v_q.typed, E'\n', v_plan);
  end loop;
end $$;

-- Timing: the 186 body and the 194 body, inline, SAME arguments, alternating, the median of 5 runs each after one warm-up run
-- each. Production is the measurement of record (the migration header: deprem within +20%). The ORDER BY gains one fold of the
-- display title and one ts_rank_cd per scored row (at most 1000); a gross regression fails (bound 1.5x on this load).
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
      ('deprem', array['deprem'], 'deprem'),
      ('seçim', array['seçim'], 'secim'),
      ('bakan', array['bakan'], 'bakan'),
      ('emekli maaşı', array['emekli maaşı', 'emekli maaşi'], 'emekli maasi'),
      ('imamoğlu', array['imamoğlu'], 'imamoglu'),
      ('burdur', array['burdur'], 'burdur')
    ) as t(typed, variants, folded) loop
    v_a := pg_temp.median_ms(v_old, v_q.variants, v_q.folded);
    v_b := pg_temp.median_ms(v_new, v_q.variants, v_q.folded);
    v_ratio := v_b / v_a;
    raise notice '%: 186 body % ms, 194 body % ms, median ratio %', v_q.typed, v_a, v_b, round(v_ratio, 2);
    assert v_ratio < 1.5, format('%s: the 194 body took %sx the 186 body (bound 1.5x on this load)', v_q.typed, round(v_ratio, 2));
  end loop;
end $$;
rollback;

\echo DRYRUN 194 OK
