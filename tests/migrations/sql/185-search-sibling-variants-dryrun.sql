-- 185 search sibling variants: local PG15 dry-run. Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust -E UTF8 --locale=en_US.UTF-8 >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55585 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55585 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql \
--     -f tests/migrations/sql/185-search-sibling-variants-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql PGHOST=/tmp PGPORT=55585 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/185-search-sibling-variants)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh    (TAYF_LIVE_ONLY=185 runs just this one)
--
-- (\ir paths below are relative to this file.) Every check is a DO block that raises on mismatch, so a clean
-- run ending in "DRYRUN 185 OK" is the pass. 185 is applied twice; psql prints the command tags, so the ledger
-- insert reads INSERT 0 1 and then INSERT 0 0. The database this leaves behind has 129, 166, 172 and 185 applied and
-- holds no fixture row (the live block of 185-search-sibling-variants.test.ts seeds its own, inside a transaction).
--
-- Order: the 129 state (166-search-overstem-guard-setup.sql: search_tsv, 083's index, 129 itself), 166 from its own
-- file, then 172 from its own file, gated on production's md5 (192218b7..., length 12913, read-only 2026-11-09); a
-- fixture of the headline-form queries of h96-search-1 (elektrik zam / zammı, emlak vergi / vergisi, gelir vergisi,
-- ısıtma zammı) and of the controls 185 must not change; the answers of 172's function (baseline: 172) to a list of
-- argument sets: the typed spellings only (what the shipped app sends in its first call) and the typed spellings with
-- the sibling's after them, at most six (the first cut's merged call; the shipped app asks the sibling in a SECOND call of
-- at most three, which both bodies answer alike, so these merged sets exist to exercise the body's read of the variants 4 to
-- 6, which no current caller sends); then 185 TWICE, ledger / shape / ACL, the denied roles, and the
-- same list again. The contract checked for every call is: a call with at most three variants returns 172's list
-- itself (p_variants[4..6] fall back to the first spelling, and an OR of it with itself changes nothing); a fourth to
-- sixth variant is read by 185 and ignored by 172. Last, a synthetic load of 8,000 live clusters (rolled back) with
-- EXPLAIN (ANALYZE) of the 172 body and the 185 body inline, the same arguments, for iran, secim, bakan (one spelling)
-- and for the six-variant calls.

\set ON_ERROR_STOP on

-- Prelude: Supabase default privileges (so the revokes have something to undo). ---------------------------
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;

-- The 129 state, 166, then 172 as production has it. ------------------------------------------------------------
\ir 166-search-overstem-guard-setup.sql
\ir ../../../supabase/migrations/166_search_overstem_guard.sql
\ir ../../../supabase/migrations/172_search_exempt_word_tier.sql

-- 172's body is production's body (read-only on 2026-11-09: md5(prosrc) 192218b7b6a56b3c8fcc48d5e0610a2c, length 12913). ---
create temp table old_src as
  select p.prosrc from pg_catalog.pg_proc p
   where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
do $$
declare
  v_md5 text;
  v_len integer;
begin
  select md5(prosrc), length(prosrc) into v_md5, v_len from old_src;
  assert v_md5 = '192218b7b6a56b3c8fcc48d5e0610a2c', format('172 body md5 %s (production: 192218b7...)', v_md5);
  assert v_len = 12913, format('172 body length %s (production: 12913)', v_len);
  assert (select count(*) from supabase_migrations.schema_migrations where version = '172') = 1, '172 must be applied';
  assert (select count(*) from supabase_migrations.schema_migrations where version = '185') = 0, '185 must not be applied yet';
  -- the stemmer facts the defect rests on (production, 2026-11-09): the possessive and the doubled-consonant form are
  -- their own lexemes, the root is not
  assert (ts_lexize('pg_catalog.turkish_stem', 'zam'))[1] = 'zam', 'zam -> zam';
  assert (ts_lexize('pg_catalog.turkish_stem', 'zammı'))[1] = 'zammı', 'zammı -> zammı';
  assert (ts_lexize('pg_catalog.turkish_stem', 'vergi'))[1] = 'vergi', 'vergi -> vergi';
  assert (ts_lexize('pg_catalog.turkish_stem', 'vergisi'))[1] = 'vergis', 'vergisi -> vergis';
  assert (ts_lexize('pg_catalog.turkish_stem', 'vergisinde'))[1] = 'vergi', 'vergisinde -> vergi';
end $$;

-- 172's function under a temp name, to run beside 185's installed one (same text, same attributes). ---------------
do $$
begin
  execute format(
    'create function pg_temp.f172(p_variants text[], p_folded text, p_limit integer default 12) returns table (id uuid) '
    || 'language sql stable set search_path = %L as %L',
    '', (select prosrc from old_src));
end $$;

-- Fixture (committed here, removed at the end). ids 00000000-0000-4000-8000-0000001851NN ---------------------------------
create temp table fx (id uuid primary key, k text not null);
insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at) values
  -- elektrik zam: the stored stem is 'zam', the stem of the typed 'zammı' is 'zammı'
  ('00000000-0000-4000-8000-000000185101', 'Elektriğe zam geldi', null, 'Zam oranı açıklandı.', 2, false, now() - interval '1 hour'),
  ('00000000-0000-4000-8000-000000185102', 'Elektrik tarifesine zam yapıldı', null, 'Yeni tarife yürürlükte.', 2, false, now() - interval '2 hours'),
  ('00000000-0000-4000-8000-000000185103', 'Elektrik zammı sonrası tepki', null, 'Tepki çoğaldı.', 2, false, now() - interval '3 hours'),
  ('00000000-0000-4000-8000-000000185104', 'Elektrik kesintisi yaşandı', null, 'Kesinti sürdü.', 2, false, now() - interval '4 hours'),
  ('00000000-0000-4000-8000-000000185105', 'Doğalgaz zam haberi', null, 'Yeni tarife.', 2, false, now() - interval '4 hours'),
  -- emlak vergisi: 'vergisinde' stems to 'vergi', the typed 'vergisi' to 'vergis'
  ('00000000-0000-4000-8000-000000185111', 'Emlak vergisinde değişiklik', null, 'Yeni oran duyuruldu.', 2, false, now() - interval '5 hours'),
  ('00000000-0000-4000-8000-000000185112', 'Emlak vergisi ödemeleri başladı', null, 'Ödemeler sürüyor.', 2, false, now() - interval '6 hours'),
  ('00000000-0000-4000-8000-000000185113', 'Gelir vergisi dilimleri belli oldu', null, 'Dilimler yenilendi.', 2, false, now() - interval '7 hours'),
  ('00000000-0000-4000-8000-000000185114', 'Gelir vergisinde yeni dönem', null, 'Dilimler.', 2, false, now() - interval '7 hours'),
  -- ısıtma zammı: three typed spellings (ısıtma zammı, isitma zammi, isıtma zammı); the sibling's are the variants 4 to 6
  ('00000000-0000-4000-8000-000000185121', 'Isıtma zam haberi', null, 'Isıtma giderlerine zam.', 2, false, now() - interval '8 hours'),
  -- archived and single-article rows are never candidates
  ('00000000-0000-4000-8000-000000185131', 'Elektrik zam arşiv haberi', null, 'Arşivde.', 2, true, now() - interval '9 hours'),
  ('00000000-0000-4000-8000-000000185132', 'Elektrik zam tek kaynaklı haber', null, 'Tek kaynak.', 1, false, now() - interval '9 hours'),
  -- controls: guarded (burdur), tiered (miller), a doubled consonant that is not listed (messi), plain words
  ('00000000-0000-4000-8000-000000185141', 'Burdur''da yurt zehirlenmesi', null, 'Öğrenciler hastaneye kaldırıldı.', 2, false, now() - interval '1 hour'),
  ('00000000-0000-4000-8000-000000185142', 'Bursa''da deprem uyarısı', null, 'Uzmanlar uyardı.', 2, false, now() - interval '2 hours'),
  ('00000000-0000-4000-8000-000000185143', 'Miller açıklama yaptı', null, 'Açıklama geldi.', 2, false, now() - interval '10 hours'),
  ('00000000-0000-4000-8000-000000185144', 'Mili Eğitim Bakanlığı toplantısı', null, 'Toplantı yapıldı.', 2, false, now() - interval '11 hours'),
  ('00000000-0000-4000-8000-000000185145', 'Messi gol attı', null, 'Maç bitti.', 2, false, now() - interval '12 hours'),
  ('00000000-0000-4000-8000-000000185146', 'İran açıklama yaptı', null, 'Tahran''dan.', 2, false, now() - interval '13 hours'),
  ('00000000-0000-4000-8000-000000185147', 'Seçim sonuçları açıklandı', null, 'Kurul sonuçları duyurdu.', 2, false, now() - interval '14 hours'),
  ('00000000-0000-4000-8000-000000185148', 'AKP''den açıklama', null, 'Parti sözcüsü konuştu.', 2, false, now() - interval '15 hours'),
  ('00000000-0000-4000-8000-000000185149', 'AK Parti toplantısı', null, 'Grup toplantısı yapıldı.', 2, false, now() - interval '16 hours');
insert into fx select id, 'r' || right(id::text, 3) from public.clusters where id::text like '00000000-0000-4000-8000-0000001851%';
analyze public.clusters;

-- The argument sets. 'typed' is the typed spellings alone (the shipped app's first call); 'app' is the first cut's merged call:
-- the typed spellings first, the sibling's after them (turkishQueryVariants of both, deduplicated, at most six). The shipped
-- app does not send the merged form (CORR-2): it asks the sibling in a second call of at most three variants.
create temp table qs (q text primary key, variants text[] not null, folded text);
insert into qs values
  ('elektrik typed',  array['elektrik zammı', 'elektrik zammi'],                                                       'elektrik zammi'),
  ('elektrik app',    array['elektrik zammı', 'elektrik zammi', 'elektrik zam'],                                       'elektrik zammi'),
  ('emlak typed',     array['emlak vergisi'],                                                                          'emlak vergisi'),
  ('emlak app',       array['emlak vergisi', 'emlak vergi'],                                                           'emlak vergisi'),
  ('gelir typed',     array['gelir vergisi'],                                                                          'gelir vergisi'),
  ('gelir app',       array['gelir vergisi', 'gelir vergi'],                                                           'gelir vergisi'),
  ('isitma typed',    array['ısıtma zammı', 'isitma zammi', 'isıtma zammı'],                                           'isitma zammi'),
  ('isitma app',      array['ısıtma zammı', 'isitma zammi', 'isıtma zammı', 'ısıtma zam', 'isitma zam', 'isıtma zam'], 'isitma zammi'),
  ('fourth only',     array['zzqx1', 'zzqx2', 'zzqx3', 'elektrik zam'],                                                'zzqx1'),
  ('fifth only',      array['zzqx1', 'zzqx2', 'zzqx3', 'zzqx4', 'elektrik zam'],                                       'zzqx1'),
  ('sixth only',      array['zzqx1', 'zzqx2', 'zzqx3', 'zzqx4', 'zzqx5', 'elektrik zam'],                              'zzqx1'),
  ('seventh ignored', array['zzqx1', 'zzqx2', 'zzqx3', 'zzqx4', 'zzqx5', 'zzqx6', 'elektrik zam'],                     'zzqx1'),
  ('burdur',          array['burdur'],                                                                                 'burdur'),
  ('miller',          array['miller'],                                                                                 'miller'),
  ('messi',           array['messi'],                                                                                  'messi'),
  ('iran',            array['iran'],                                                                                   'iran'),
  ('secim',           array['seçim'],                                                                                  'secim'),
  ('akp alias',       array['akp or "ak parti"'],                                                                      'akp or ak parti'),
  ('empty',           array[''],                                                                                       ''),
  ('null folded',     array['burdur'],                                                                                 null);

-- baseline: 172 (production's body) at p_limit 50, the way the app asks. ------------------------------------------
create temp table res_before as
  select qs.q, t.n, t.id from qs cross join lateral pg_temp.f172(qs.variants, qs.folded, 50) with ordinality as t(id, n);

-- The defect is there on the 172 body (so the "after" below proves something). ------------------------------------------
do $$
declare
  v_keys text[];
begin
  select coalesce(array_agg(f.k order by b.n), '{}') into v_keys from res_before b join fx f on f.id = b.id where b.q = 'elektrik typed';
  assert v_keys = array['r103'], format('baseline: 172 finds only the row that says zammı for "elektrik zammı", got %s', v_keys);
  select coalesce(array_agg(f.k order by b.n), '{}') into v_keys from res_before b join fx f on f.id = b.id where b.q = 'emlak typed';
  assert v_keys = array['r112'], format('baseline: 172 finds only the row that says vergisi for "emlak vergisi", got %s', v_keys);
  assert (select count(*) from res_before where q = 'gelir typed') = 1, 'baseline: 172 finds one Gelir vergisi row of two';
  -- the sibling's rows are all there to be found when the sibling is asked for within the first three variants
  select coalesce(array_agg(f.k order by f.k), '{}') into v_keys from res_before b join fx f on f.id = b.id where b.q = 'elektrik app';
  assert v_keys = array['r101', 'r102', 'r103'], format('baseline: 172 reads the sibling in the third variant, got %s', v_keys);
  -- and does not read a fourth variant at all
  assert (select count(*) from res_before where q = 'isitma app') = 0, 'baseline: 172 ignores the variants 4 to 6 (isitma zam)';
  assert (select count(*) from res_before where q in ('fourth only', 'fifth only', 'sixth only', 'seventh ignored')) = 0, 'baseline: 172 ignores p_variants[4] and later';
  assert (select max(c) from (select count(*) as c from res_before group by q) m) < 50, 'the fixture keeps every list far below the 50-row cap';
end $$;

-- Apply 185 TWICE (re-apply safety). --------------------------------------------------------------------------
create temp table idx_before as select indexname from pg_catalog.pg_indexes where schemaname = 'public' and tablename = 'clusters';
\ir ../../../supabase/migrations/185_search_sibling_variants.sql
\ir ../../../supabase/migrations/185_search_sibling_variants.sql

-- Ledger, shape and ACL after both runs -------------------------------------------------------------------------
do $$
declare
  v_n integer;
  v_p pg_catalog.pg_proc%rowtype;
  v_acl text;
begin
  select count(*) into v_n from supabase_migrations.schema_migrations where version = '185';
  assert v_n = 1, format('ledger rows for 185: %s (expected exactly 1)', v_n);
  assert (select name from supabase_migrations.schema_migrations where version = '185') = '185_search_sibling_variants', 'ledger name';
  assert (select count(*) from supabase_migrations.schema_migrations where version = '172') = 1, '172 ledger row is untouched';

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
  assert obj_description(v_p.oid, 'pg_proc') like '%185%' and obj_description(v_p.oid, 'pg_proc') like '%sibling%', 'function comment must mention the sibling variants of 185';
  assert md5(v_p.prosrc) <> '192218b7b6a56b3c8fcc48d5e0610a2c', 'the body must have changed';
  assert md5(v_p.prosrc) = 'b8d0aa3035e001d17750d94f5a08c9c2' and length(v_p.prosrc) = 13324,
         format('185 body md5 %s length %s (the file: b8d0aa3035e001d17750d94f5a08c9c2, 13324)', md5(v_p.prosrc), length(v_p.prosrc));

  -- ACL: owner and service_role only; no PUBLIC (grantee 0), no anon, no authenticated.
  assert not has_function_privilege('anon', v_p.oid, 'execute'), 'anon must not execute';
  assert not has_function_privilege('authenticated', v_p.oid, 'execute'), 'authenticated must not execute';
  assert has_function_privilege('service_role', v_p.oid, 'execute'), 'service_role must execute';
  assert not exists (select 1 from aclexplode(v_p.proacl) a where a.grantee = 0), 'PUBLIC must have no grant';
  select string_agg(a.grantee::regrole::text, ',' order by a.grantee::regrole::text) into v_acl
    from aclexplode(v_p.proacl) a;
  assert v_acl = 'postgres,service_role', format('grantees: %s', v_acl);

  -- nothing else changed: the fold function, its indexes and the table are 129's, and no index was added
  assert (select count(*) from pg_catalog.pg_proc where pronamespace = 'public'::regnamespace and proname = 'tayf_search_fold') = 1, 'fold overloads';
  assert to_regclass('public.clusters_search_fold_live_idx') is not null, '129 index';
  assert (select coalesce(string_agg(indexname, ',' order by indexname), '') from pg_catalog.pg_indexes where schemaname = 'public' and tablename = 'clusters')
         = (select coalesce(string_agg(indexname, ',' order by indexname), '') from idx_before), '185 adds no index and drops none';
end $$;

-- Called as each role: anon and authenticated are denied; service_role runs it. ----------------------------
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
      perform 1 from public.search_cluster_ids(array['elektrik zam'], 'elektrik zam', 24);
    exception when insufficient_privilege then
      v_denied := true;
    end;
    reset role;
    assert v_denied, format('%s must be denied', v_role);
  end loop;

  set local role service_role;
  select count(*) into v_n from public.search_cluster_ids(array['elektrik zam'], 'elektrik zam', 24);
  reset role;
  assert v_n > 0, 'service_role must get rows';
end $$;

-- The same argument sets after 185. --------------------------------------------------------------------------
create temp table res_after as
  select qs.q, t.n, t.id from qs cross join lateral public.search_cluster_ids(qs.variants, qs.folded, 50) with ordinality as t(id, n);

do $$
declare
  r record;
  v_before uuid[];
  v_after uuid[];
  v_keys text[];
begin
  -- the contract, for every call with at most three variants: 185 returns 172's ordered list
  for r in select * from qs where cardinality(variants) <= 3 order by q loop
    select coalesce(array_agg(id order by n), '{}') into v_before from res_before where q = r.q;
    select coalesce(array_agg(id order by n), '{}') into v_after from res_after where q = r.q;
    assert v_after = v_before, format('call "%s" has at most three variants, so 185 must return 172''s list: %s -> %s', r.q, v_before, v_after);
  end loop;

  -- the sibling in the first three variants: found, with the typed row kept
  select coalesce(array_agg(f.k order by f.k), '{}') into v_keys from res_after a join fx f on f.id = a.id where a.q = 'elektrik app';
  assert v_keys = array['r101', 'r102', 'r103'], format('elektrik zammı as the app sends it: the Zam rows and the typed row, got %s', v_keys);
  select coalesce(array_agg(f.k order by f.k), '{}') into v_keys from res_after a join fx f on f.id = a.id where a.q = 'emlak app';
  assert v_keys = array['r111', 'r112'], format('emlak vergisi as the app sends it: both forms, got %s', v_keys);
  select coalesce(array_agg(f.k order by f.k), '{}') into v_keys from res_after a join fx f on f.id = a.id where a.q = 'gelir app';
  assert v_keys = array['r113', 'r114'], format('gelir vergisi as the app sends it: both forms, got %s', v_keys);

  -- p_variants[4], [5] and [6] are read by 185 and not by 172
  select coalesce(array_agg(f.k order by f.k), '{}') into v_keys from res_after a join fx f on f.id = a.id where a.q = 'isitma app';
  assert v_keys = array['r121'], format('isitma zammı: the sibling at the variants 4 to 6 finds the Isıtma zam row, got %s', v_keys);
  assert (select count(*) from res_before where q = 'isitma app') = 0, 'and 172 did not';
  for r in select * from qs where q in ('fourth only', 'fifth only', 'sixth only') order by q loop
    select coalesce(array_agg(f.k order by f.k), '{}') into v_keys from res_after a join fx f on f.id = a.id where a.q = r.q;
    assert v_keys = array['r101', 'r102'], format('call "%s": 185 reads the variant at its position (the rows that say zam), got %s', r.q, v_keys);
  end loop;
  -- the seventh variant is not read (p_variants[7] is not in q.qv): the six-variant bound of the app
  assert (select count(*) from res_after where q = 'seventh ignored') = 0, 'the seventh variant is ignored';

  -- the controls, written out
  assert (select count(*) from res_after where q = 'burdur') = 1, 'burdur keeps its guarded row (Bursa stays out)';
  assert (select count(*) from res_after where q = 'miller') = 2, 'miller keeps its two rows';
  assert (select f.k from res_after a join fx f on f.id = a.id where a.q = 'miller' and a.n = 1) = 'r143', 'and the tier still puts the Miller row first';
  assert (select count(*) from res_after where q = 'messi') = 1, 'messi is not rewritten and keeps its row';
  assert (select count(*) from res_after where q = 'akp alias') = 2, 'the alias query finds AKP and AK Parti';
  assert (select count(*) from res_after where q = 'empty') = 0 and (select count(*) from res_after where q = 'null folded') = (select count(*) from res_before where q = 'null folded'), 'empty and null folded queries';
  -- archived and single-article rows never appear
  assert not exists (select 1 from res_after a join fx f on f.id = a.id where f.k in ('r131', 'r132')), 'the live predicate holds';
end $$;

delete from public.clusters where id::text like '00000000-0000-4000-8000-0000001851%';

-- Realistic load: 8,000 live clusters (rolled back); the 172 body and the 185 body run inline as plain SELECTs with
-- EXPLAIN (ANALYZE), the same arguments, the way the migration header measures production. ----------------------------
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
      'elektrik','zam','zammı','vergi','vergisi','vergisinde','ceza','cezası','trafik','emlak'
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

-- Timing: the 172 body and the 185 body, inline, SAME arguments, alternating, the median of 5 runs each after one warm-up run
-- each. Production is the measurement of record (the migration header: iran and trafik cezası within 1.3x for the body alone).
-- The three extra tsquery terms are copies of the first spelling (GIN merges equal entries), so a call with one spelling must
-- cost what 172 costs; the six-variant calls add real terms. A gross regression fails (bound 1.5x on this load).
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
      ('trafik cezası, 3 variants', array['trafik cezası', 'trafik cezasi', 'trafik ceza'], 'trafik cezasi'),
      ('elektrik zammı, 6 variants', array['elektrik zammı', 'elektrik zammi', 'elektrik zam', 'elektrik zamm', 'elektrik zamk', 'elektrik zamy'], 'elektrik zammi'),
      ('emlak vergisi, 2 variants', array['emlak vergisi', 'emlak vergi'], 'emlak vergisi')
    ) as t(typed, variants, folded) loop
    v_a := pg_temp.median_ms(v_old, v_q.variants, v_q.folded);
    v_b := pg_temp.median_ms(v_new, v_q.variants, v_q.folded);
    v_ratio := v_b / v_a;
    raise notice '%: 172 body % ms, 185 body % ms, median ratio %', v_q.typed, v_a, v_b, round(v_ratio, 2);
    -- the 1.3x gate is measured on production; here a gross regression fails
    assert v_ratio < 1.5, format('%s: the 185 body took %sx the 172 body (bound 1.5x on this load)', v_q.typed, round(v_ratio, 2));
  end loop;
  assert (select count(*) from public.search_cluster_ids(array['elektrik zammı', 'elektrik zam'], 'elektrik zammi', 24)) > 0, 'the load has Elektrik zam rows';
end $$;
rollback;

\echo DRYRUN 185 OK
