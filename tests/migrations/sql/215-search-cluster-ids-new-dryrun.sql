-- 215 search_cluster_ids_new (the newest-first archive search, ?sirala=yeni): local PG15 dry-run. Never touches production.
--
-- Run on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir
--   $PGBIN/initdb -D $D -U postgres -A trust -E UTF8 --locale=en_US.UTF-8 >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55615 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55615 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql \
--     -f tests/migrations/sql/215-search-cluster-ids-new-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql PGHOST=/tmp PGPORT=55615 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/215-search-cluster-ids-new)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh    (TAYF_LIVE_ONLY=215 runs just this one)
--
-- (\ir paths below are relative to this file.) Every check is a DO block that raises on mismatch, so a clean run ending in
-- "DRYRUN 215 OK" is the pass. 215 is applied twice (re-apply safety). The database this leaves behind has 129, 166, 172, 185, 186, 194,
-- 196, 198, 204, 211 and 215 applied and holds no fixture row (the fixtures live in one transaction that is rolled back; the live block of
-- 215-search-cluster-ids-new.test.ts seeds its own, the same way).
--
-- Order: the 129 state (166-search-overstem-guard-setup.sql: search_tsv, 083's index, 129 itself), then 166, 172, 185, 186, 194, 196, 198,
-- 204 and 211 from their own files, gated on production's bodies (search_cluster_ids = 204's: md5 32b42ca06d6b0c2a3ba8bf1264d353f7, length
-- 22892; search_cluster_ids_v2 = 211's: md5 c91d45d81b53a71b007aa6de2d1a5ed7, length 22945, read on production 2026-11-15); then 215 twice,
-- ledger / shape / ACL (anon and authenticated denied with insufficient_privilege, service_role runs it), the two older search functions
-- untouched, and the contract on a fixture: the literal-title rows come back newest first and a NEWER summary-only row is left out; a neutral
-- title is the display title; an archived and a one-article cluster never; ties go by id; pages at offset 0, 24, 48 and 72 are consecutive
-- and disjoint; p_limit is clamped to 1..24 and the offset to 0..72 (null reads the default); the newest 150 candidates are the bound
-- (150 newer summary-only rows hide every literal row, 149 leave exactly the newest one); an alias query (akp or ak parti) and a negated
-- phrase list their newest rows instead of none; the 166 guard is kept (burdur lists no Bursa row); hostile strings do not raise; and the
-- plan keeps the three index scans.

\set ON_ERROR_STOP on

-- Prelude: Supabase default privileges (so the revokes have something to undo). ---------------------------
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;

-- The 129 state, then 166, 172, 185, 186, 194, 196, 198, 204 and 211. -------------------------------------------------------
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

-- Baseline: production's two search functions (STEP 0 of 215), no 215 yet. ---------------------------------------------------
create temp table old_src as
  select (select p.prosrc from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure) as v1,
         (select p.prosrc from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids_v2(text[], text, integer, integer)'::regprocedure) as v2;
do $$
declare
  v_v1 text;
  v_v2 text;
begin
  select v1, v2 into v_v1, v_v2 from old_src;
  assert md5(v_v1) = '32b42ca06d6b0c2a3ba8bf1264d353f7' and length(v_v1) = 22892,
         format('204 body md5 %s length %s (production: 32b42ca06d6b0c2a3ba8bf1264d353f7, 22892)', md5(v_v1), length(v_v1));
  assert md5(v_v2) = 'c91d45d81b53a71b007aa6de2d1a5ed7' and length(v_v2) = 22945,
         format('211 body md5 %s length %s (production: c91d45d81b53a71b007aa6de2d1a5ed7, 22945)', md5(v_v2), length(v_v2));
  assert (select count(*) from supabase_migrations.schema_migrations where version in ('204', '211')) = 2, '204 and 211 must be applied';
  assert (select count(*) from supabase_migrations.schema_migrations where version = '215') = 0, '215 must not be applied yet';
  assert to_regprocedure('public.search_cluster_ids_new(text[], text, integer, integer)') is null, 'there is no search_cluster_ids_new yet';
  assert to_regclass('public.clusters_search_stemfold_live_idx') is not null, '186 built its index';
  assert to_regclass('public.clusters_search_fold_live_idx') is not null, '129 built its index';
end $$;
create temp table idx_before as select indexname from pg_catalog.pg_indexes where schemaname = 'public' and tablename = 'clusters';

-- Apply 215 TWICE (re-apply safety). -----------------------------------------------------------------------------------------
\ir ../../../supabase/migrations/215_search_cluster_ids_new.sql
\ir ../../../supabase/migrations/215_search_cluster_ids_new.sql

-- Ledger, shape and ACL after both runs ------------------------------------------------------------------------------------
do $$
declare
  v_n integer;
  v_p pg_catalog.pg_proc%rowtype;
  v_acl text;
begin
  select count(*) into v_n from supabase_migrations.schema_migrations where version = '215';
  assert v_n = 1, format('ledger rows for 215: %s (expected exactly 1)', v_n);
  assert (select name from supabase_migrations.schema_migrations where version = '215') = '215_search_cluster_ids_new', 'ledger name';
  assert (select count(*) from supabase_migrations.schema_migrations where version in ('204', '211')) = 2, '204 and 211 ledger rows are untouched';

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
  assert obj_description(v_p.oid, 'pg_proc') like '%215%' and obj_description(v_p.oid, 'pg_proc') like '%h191%' and obj_description(v_p.oid, 'pg_proc') like '%150%',
         'function comment must mention 215, h191 and the newest-150 bound';
  -- this file's body: md5 c500964284801f3c83be9f4b73ec398a, length 23628 (VERIFY in the migration header)
  assert md5(v_p.prosrc) = 'c500964284801f3c83be9f4b73ec398a' and length(v_p.prosrc) = 23628,
         format('215 body md5 %s length %s (the file: c500964284801f3c83be9f4b73ec398a, 23628)', md5(v_p.prosrc), length(v_p.prosrc));
  assert not has_function_privilege('anon', v_p.oid, 'execute'), 'anon must not execute';
  assert not has_function_privilege('authenticated', v_p.oid, 'execute'), 'authenticated must not execute';
  assert has_function_privilege('service_role', v_p.oid, 'execute'), 'service_role must execute';
  assert not exists (select 1 from aclexplode(v_p.proacl) a where a.grantee = 0), 'PUBLIC must have no grant';
  select string_agg(a.grantee::regrole::text, ',' order by a.grantee::regrole::text) into v_acl from aclexplode(v_p.proacl) a;
  assert v_acl = 'postgres,service_role', format('grantees: %s', v_acl);

  -- the two older search functions are not touched: same text, same ACL
  assert (select md5(v1) from old_src) = md5((select p.prosrc from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure)),
         'search_cluster_ids is untouched';
  assert (select md5(v2) from old_src) = md5((select p.prosrc from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids_v2(text[], text, integer, integer)'::regprocedure)),
         'search_cluster_ids_v2 is untouched';
  assert (select count(*) from pg_catalog.pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'search_cluster_ids') = 1, 'search_cluster_ids overloads';
  assert (select count(*) from pg_catalog.pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'search_cluster_ids_v2') = 1, 'search_cluster_ids_v2 overloads';
  assert (select string_agg(indexname, ',' order by indexname) from pg_catalog.pg_indexes where schemaname = 'public' and tablename = 'clusters')
         = (select string_agg(indexname, ',' order by indexname) from idx_before), '215 changes no index';
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
      perform 1 from public.search_cluster_ids_new(array['deprem'], 'deprem', 24, 0);
    exception when insufficient_privilege then
      v_denied := true;
    end;
    reset role;
    assert v_denied, format('%s must be denied the RPC (insufficient_privilege)', v_role);
  end loop;

  set local role service_role;
  select count(*) into v_n from public.search_cluster_ids_new(array['deprem'], 'deprem', 24, 0);
  assert v_n = 0, 'service_role runs the function (the table is empty here)';
  reset role;
end $$;

-- Fixture (one transaction, rolled back at the end). ids 00000000-0000-4000-8000-0000002150NN ... ------------------------------
begin;

create function pg_temp.sid(p_n integer) returns uuid language sql immutable as $f$
  select ('00000000-0000-4000-8000-' || lpad((215000 + p_n)::text, 12, '0'))::uuid
$f$;

-- ids of one call, in the function's order
create function pg_temp.ids(p_variants text[], p_folded text, p_limit integer, p_offset integer) returns uuid[]
language sql stable as $f$
  select coalesce(array_agg(t.id order by t.n), '{}') from public.search_cluster_ids_new(p_variants, p_folded, p_limit, p_offset) with ordinality as t(id, n)
$f$;

-- deprem: 100 literal rows 'Deprem haberi N' (N hours old, corroboration 2 + N % 5 so the ranked order is not the date order), two literal rows with
-- the very same updated_at (the id decides), one literal NEUTRAL title (30 minutes), five NEWER summary-only rows (10 to 50 minutes: the word is only in the summary),
-- an archived literal row and a one-article literal row (the newest of all).
insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at)
select pg_temp.sid(n), 'Deprem haberi ' || n, null, 'Ayrıntılar sürüyor.', 2 + (n % 5), false, now() - make_interval(hours => n)
  from generate_series(1, 100) n;
insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at) values
  (pg_temp.sid(300), 'Bölgede sarsıntı', 'Deprem bölgesinde çalışmalar sürüyor', 'Ekipler sahada.', 3, false, now() - interval '30 minutes'),
  (pg_temp.sid(310), 'Deprem tie A', null, 'Aynı saniye.', 2, false, now() - interval '50 hours 30 minutes'),
  (pg_temp.sid(311), 'Deprem tie B', null, 'Aynı saniye.', 2, false, now() - interval '50 hours 30 minutes'),
  (pg_temp.sid(301), 'Deprem arşiv haberi', null, 'Arşivde.', 3, true, now() - interval '5 minutes'),
  (pg_temp.sid(302), 'Deprem tek kaynaklı haber', null, 'Tek kaynak.', 1, false, now() - interval '4 minutes');
insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at)
select pg_temp.sid(200 + n), 'Borsa güne yükselişle başladı ' || n, null, 'Analistler deprem bölgesine yatırımı konuştu.', 9, false, now() - make_interval(mins => n * 10)
  from generate_series(1, 5) n;

-- an inflected typed word and its root
insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at) values
  (pg_temp.sid(500), 'Orman yangınları sürüyor', null, 'Ekipler müdahale etti.', 3, false, now() - interval '2 hours'),
  (pg_temp.sid(501), 'Yangın söndürüldü', null, 'Ekipler müdahale etti.', 3, false, now() - interval '1 hour');

-- the bound: tsunami has 150 newer summary-only rows and 5 literal rows (1 to 5 days old); heyelan has 149 and the same 5.
insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at)
select pg_temp.sid(1000 + n), 'Piyasa raporu ' || n, null, 'Analistler tsunami riskini değerlendirdi.', 2, false, now() - make_interval(mins => n) from generate_series(1, 150) n;
insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at)
select pg_temp.sid(1200 + n), 'Tsunami uyarısı ' || n, null, 'Kıyılar boşaltıldı.', 2, false, now() - make_interval(days => n) from generate_series(1, 5) n;
insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at)
select pg_temp.sid(1400 + n), 'Hisse raporu ' || n, null, 'Analistler heyelan riskini değerlendirdi.', 2, false, now() - make_interval(mins => n) from generate_series(1, 149) n;
insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at)
select pg_temp.sid(1600 + n), 'Heyelan uyarısı ' || n, null, 'Yol kapandı.', 2, false, now() - make_interval(days => n) from generate_series(1, 5) n;

-- no literal tier, and the guard
insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at) values
  (pg_temp.sid(401), 'AK Parti kongresi toplandı', null, 'Delegeler oy kullandı.', 4, false, now() - interval '2 hours'),
  (pg_temp.sid(402), 'Gündem yoğun', null, 'AKP milletvekilleri toplandı.', 3, false, now() - interval '1 hour'),
  (pg_temp.sid(403), 'Hava durumu açıklandı', null, 'Yağış bekleniyor.', 5, false, now() - interval '30 minutes'),
  (pg_temp.sid(411), 'İran açıklama yaptı', null, 'Bakanlık duyurdu.', 2, false, now() - interval '3 hours'),
  (pg_temp.sid(412), 'İran İsrail saldırısı sürüyor', null, 'Saldırı devam ediyor.', 5, false, now() - interval '1 hour'),
  (pg_temp.sid(413), 'Gündem özeti', null, 'İran gelişmeleri konuşuldu.', 2, false, now() - interval '2 hours'),
  (pg_temp.sid(421), 'Burdur''da yurt zehirlenmesi', null, 'Öğrenciler hastaneye kaldırıldı.', 2, false, now() - interval '1 hour'),
  (pg_temp.sid(422), 'Bursa''da sel uyarısı', null, 'Uzmanlar uyardı.', 2, false, now() - interval '30 minutes');
analyze public.clusters;

-- The expected order of the deprem literal matches: updated_at desc, id (ages in minutes). ----------------------------------
create temp table expected as
  select row_number() over (order by a.age, a.id) as n, a.id
    from (select pg_temp.sid(300) as id, 30 as age
          union all select pg_temp.sid(g), g * 60 from generate_series(1, 100) g
          union all select pg_temp.sid(310), 50 * 60 + 30
          union all select pg_temp.sid(311), 50 * 60 + 30) a;
create function pg_temp.exp_slice(p_from integer, p_to integer) returns uuid[]
language sql stable as $f$ select coalesce(array_agg(e.id order by e.n), '{}') from expected e where e.n between p_from and p_to $f$;

-- (1) newest first: the neutral title, then 1 hour, 2 hours ...; a NEWER summary-only match is left out; archived and one-article rows never. ----
do $$
declare
  v_p1 uuid[] := pg_temp.ids(array['deprem'], 'deprem', 24, 0);
  v_all uuid[];
begin
  assert cardinality(v_p1) = 24, format('page 1 has 24 rows, got %s', cardinality(v_p1));
  assert v_p1 = pg_temp.exp_slice(1, 24), format('page 1 is the newest 24 literal matches, newest first:%s%s%s%s', E'\n', v_p1, E'\n', pg_temp.exp_slice(1, 24));
  assert v_p1[1] = pg_temp.sid(300), 'the neutral title (30 minutes old) is the newest literal row: the display title is read';
  v_all := v_p1 || pg_temp.ids(array['deprem'], 'deprem', 24, 24) || pg_temp.ids(array['deprem'], 'deprem', 24, 48) || pg_temp.ids(array['deprem'], 'deprem', 24, 72);
  assert not (v_all && array[pg_temp.sid(201), pg_temp.sid(202), pg_temp.sid(203), pg_temp.sid(204), pg_temp.sid(205)]),
         'a NEWER summary-only match must not appear on any page';
  assert not (v_all && array[pg_temp.sid(301), pg_temp.sid(302)]), 'an archived and a one-article cluster are never listed';
  assert pg_temp.ids(array['deprem'], 'deprem', 24, 24) = pg_temp.exp_slice(25, 48), 'page 2 is rows 25-48';
  assert pg_temp.ids(array['deprem'], 'deprem', 24, 48) = pg_temp.exp_slice(49, 72), 'page 3 is rows 49-72';
  assert pg_temp.ids(array['deprem'], 'deprem', 24, 72) = pg_temp.exp_slice(73, 96), 'page 4 (offset 72) is rows 73-96';
  assert (select count(distinct x) from unnest(v_all) x) = 96 and cardinality(v_all) = 96, 'four pages are 96 distinct ids: pages are disjoint';
  -- ties: the same updated_at is listed in id order
  assert array_position(v_all, pg_temp.sid(310)) + 1 = array_position(v_all, pg_temp.sid(311)), 'two rows with one updated_at are listed in id order';
end $$;

-- (2) the independent computation: the same predicate (not archived, two articles), a hand-written display-title word start, no function call. ----
do $$
declare
  v_ind uuid[];
begin
  select array_agg(x.id order by x.updated_at desc, x.id) into v_ind from (
    select c.id, c.updated_at from public.clusters c
     where not c.is_archived and c.article_count >= 2
       and strpos(' ' || regexp_replace(public.tayf_search_fold(coalesce(nullif(btrim(c.title_tr_neutral), ''), c.title_tr)), '[^a-z0-9]+', ' ', 'g'), ' depr') > 0
     order by c.updated_at desc, c.id limit 24) x;
  assert pg_temp.ids(array['deprem'], 'deprem', 24, 0) = v_ind, 'the first 24 ids equal the independently computed newest 24 literal matches';
  -- the ranked function is NOT this order on this fixture (the older, better corroborated rows lead), so the check above is not vacuous
  assert (select array_agg(t.id order by t.n) from public.search_cluster_ids_v2(array['deprem'], 'deprem', 24, 0) with ordinality as t(id, n)) is distinct from v_ind,
         'the ranked order differs from the newest-first order on the fixture';
end $$;

-- (3) the limit clamp 1..24 (null reads 24) and the offset clamp 0..72 (null reads 0). ----------------------------------------
do $$
declare
  v_p1 uuid[] := pg_temp.ids(array['deprem'], 'deprem', 24, 0);
begin
  assert pg_temp.ids(array['deprem'], 'deprem', 50, 0) = v_p1, 'p_limit 50 reads 24';
  assert pg_temp.ids(array['deprem'], 'deprem', 1000000, 0) = v_p1, 'a huge p_limit reads 24';
  assert pg_temp.ids(array['deprem'], 'deprem', null, 0) = v_p1, 'a null p_limit reads 24';
  assert pg_temp.ids(array['deprem'], 'deprem', 0, 0) = v_p1[1:1], 'p_limit 0 reads 1';
  assert pg_temp.ids(array['deprem'], 'deprem', -3, 0) = v_p1[1:1], 'a negative p_limit reads 1';
  assert pg_temp.ids(array['deprem'], 'deprem', 5, 0) = v_p1[1:5], 'p_limit 5 gives 5 rows';
  assert pg_temp.ids(array['deprem'], 'deprem', 5, 3) = v_p1[4:8], 'p_limit 5 at offset 3 is rows 4-8';
  assert pg_temp.ids(array['deprem'], 'deprem', 24, 1000) = pg_temp.ids(array['deprem'], 'deprem', 24, 72), 'offset 1000 reads offset 72';
  assert pg_temp.ids(array['deprem'], 'deprem', 24, 73) = pg_temp.ids(array['deprem'], 'deprem', 24, 72), 'offset 73 reads offset 72';
  assert pg_temp.ids(array['deprem'], 'deprem', 24, -5) = v_p1, 'a negative offset reads 0';
  assert pg_temp.ids(array['deprem'], 'deprem', 24, null) = v_p1, 'a null offset reads 0';
  assert (select count(*) from public.search_cluster_ids_new(array['deprem'], 'deprem')) = 24, 'the defaults are p_limit 24 and p_offset 0';
  assert pg_temp.ids(array['deprem', 'depreM'], 'deprem', 24, 0) = v_p1, 'a second typed spelling finds the same rows in the same order';
  -- a typed inflected word is a literal match only on its own form (194's lit_d: the word minus its last two letters starts a word of the title)
  assert pg_temp.ids(array['yangınlar'], 'yanginlar', 24, 0) = array[pg_temp.sid(500)],
         format('yangınlar lists the title that holds yangınları, not the singular one, got %s', pg_temp.ids(array['yangınlar'], 'yanginlar', 24, 0));
  -- the candidates are the stemmer's (yangın is stored as the stem yangı, yangınları as yangın): the root finds the singular title only, as search_cluster_ids_v2 does
  assert pg_temp.ids(array['yangın'], 'yangin', 24, 0) = array[pg_temp.sid(501)], 'yangın lists the singular title';
end $$;

-- (4) the 150 bound: 150 newer summary-only rows hide every literal row, 149 leave exactly the newest one. -----------------
do $$
begin
  assert pg_temp.ids(array['tsunami'], 'tsunami', 24, 0) = '{}', format('tsunami: the newest 150 candidates are the summary-only rows, got %s', pg_temp.ids(array['tsunami'], 'tsunami', 24, 0));
  assert pg_temp.ids(array['heyelan'], 'heyelan', 24, 0) = array[pg_temp.sid(1601)], format('heyelan: the newest literal row, alone, got %s', pg_temp.ids(array['heyelan'], 'heyelan', 24, 0));
end $$;

-- (5) a query with no literal tier lists its newest rows; the 166 guard is kept; hostile strings do not raise. ----------------
do $$
begin
  assert pg_temp.ids(array['akp or "ak parti"'], 'akp or ak parti', 24, 0) = array[pg_temp.sid(402), pg_temp.sid(401)],
         format('akp or ak parti: the title row and the summary row, newest first, got %s', pg_temp.ids(array['akp or "ak parti"'], 'akp or ak parti', 24, 0));
  -- a negated phrase: the candidates are the ranked function's (204's arms, whatever the folded arm reads of -"..."), newest first. On this fixture the folded arm turns
  -- the quote into a space, so it still reads the phrase's words as required: the excluded row is a candidate of the ranked function too, and of this one (parity, a
  -- pre-existing property of 204's arms that 215 does not change)
  assert cardinality(pg_temp.ids(array['iran -"israil saldırısı"', 'iran -"israil saldirisi"'], 'iran -"israil saldirisi"', 24, 0)) >= 2
     and pg_temp.ids(array['iran -"israil saldırısı"', 'iran -"israil saldirisi"'], 'iran -"israil saldirisi"', 24, 0)
       = (select array_agg(c.id order by c.updated_at desc, c.id)
            from public.search_cluster_ids_v2(array['iran -"israil saldırısı"', 'iran -"israil saldirisi"'], 'iran -"israil saldirisi"', 50, 0) t join public.clusters c on c.id = t.id),
         'a negated phrase lists exactly the ranked function''s candidates, newest first';
  assert pg_temp.ids(array['akp or "ak parti"'], 'akp or ak parti', 24, 0)
       = (select array_agg(c.id order by c.updated_at desc, c.id)
            from public.search_cluster_ids_v2(array['akp or "ak parti"'], 'akp or ak parti', 50, 0) t join public.clusters c on c.id = t.id),
         'an alias query lists exactly the ranked function''s candidates, newest first';
  assert pg_temp.ids(array['burdur'], 'burdur', 24, 0) = array[pg_temp.sid(421)], 'burdur lists the Burdur row and not the newer Bursa row (the 166 guard)';
  assert pg_temp.ids(array[''], '', 24, 0) = '{}', 'an empty query lists nothing';
  assert pg_temp.ids(array['okul'], null, 24, 0) is not null, 'a null folded text does not raise';
  assert pg_temp.ids(array['''; drop table public.clusters; --'], '''; drop table public.clusters; --', 24, 0) = '{}', 'a hostile string lists nothing and raises nothing';
  assert pg_temp.ids(null, 'deprem', 24, 0) is not null, 'a null variants array does not raise';
  assert to_regclass('public.clusters') is not null, 'the table is still there';
end $$;

-- (6) the plan: `kept` is not a materialized CTE node (NOT MATERIALIZED), and the folded and stem-fold arms keep their indexes (the arms are 204's). On this
-- tiny fixture the planner reads the variants arm through the partial updated_at index (a table of a few hundred rows), so that arm's index is not asserted here. ---
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
  v_plan text := pg_temp.plan_of(array['deprem'], 'deprem');
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
  assert (select count(*) from public.clusters where id::text like '00000000-0000-4000-8000-0000002150%' or id::text like '00000000-0000-4000-8000-00000021%') = 0, 'no fixture row is left behind';
end $$;

\echo DRYRUN 215 OK
