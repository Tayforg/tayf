-- 172 search exempt-word tier: local PG15 dry-run. Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust -E UTF8 --locale=en_US.UTF-8 >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55572 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55572 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql \
--     -f tests/migrations/sql/172-search-exempt-word-tier-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql PGHOST=/tmp PGPORT=55572 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/172-search-exempt-word-tier)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh    (TAYF_LIVE_ONLY=172 runs just this one)
--
-- (\ir paths below are relative to this file.) Every check is a DO block that raises on mismatch, so a clean
-- run ending in "DRYRUN 172 OK" is the pass. 172 is applied twice; psql prints the command tags, so the ledger
-- insert reads INSERT 0 1 and then INSERT 0 0. The database this leaves behind has 129, 166 and 172 applied and
-- holds no fixture row (the live block of 172-search-exempt-word-tier.test.ts seeds its own, inside a transaction).
--
-- Order: the 129 state (166-search-overstem-guard-setup.sql: search_tsv, 083's index, 129 itself), then 166 from its
-- own file, gated on production's md5 (d7f4b422..., length 9680, read-only 2026-11-07); a fixture of the
-- three name-shaped queries of h58-postship-1 (miller = mil + ler, bartin = bart + in, saniye = sani + ye), of 166's
-- inflected roots (irakta, zamlar) and of the queries 172 must not change, and the answers of 166's function to a
-- list of queries (baseline: 166 ranks the stem collisions, Milli/Mili/Mil, Bart De Wever, Ronen Bar, Al Sani,
-- above the real rows); then 172 TWICE, ledger / shape / ACL, the denied roles, and the same list again. The
-- contract checked for every query is: 172's list is the stable partition of 166's list by the tier (the rows whose
-- text has every exempt word at a word start, in 166's order, then the rest), the same ids, nothing dropped; for a
-- query with no exempt word that is 166's list itself. Last, a synthetic load of 12,000 live clusters (rolled back)
-- with EXPLAIN (ANALYZE) of the 166 body and the 172 body inline for iran, secim, bakan (no exempt word: the tier is
-- off) and for miller, bartin, saniye, zamlar and irakta (the tier is on).

\set ON_ERROR_STOP on

-- Prelude: Supabase default privileges (so the revokes have something to undo). ---------------------------
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;

-- The 129 state, then 166 as production has it. -------------------------------------------------------------
\ir 166-search-overstem-guard-setup.sql
\ir ../../../supabase/migrations/166_search_overstem_guard.sql

-- 166's body is production's body (read-only on 2026-11-07: md5(prosrc) d7f4b4223730e06db8479f42776d8040, length 9680). ---
create temp table old_src as
  select p.prosrc from pg_catalog.pg_proc p
   where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
do $$
declare
  v_md5 text;
  v_len integer;
begin
  select md5(prosrc), length(prosrc) into v_md5, v_len from old_src;
  assert v_md5 = 'd7f4b4223730e06db8479f42776d8040', format('166 body md5 %s (production: d7f4b422...)', v_md5);
  assert v_len = 9680, format('166 body length %s (production: 9680)', v_len);
  assert (select count(*) from supabase_migrations.schema_migrations where version = '166') = 1, '166 must be applied';
  assert (select count(*) from supabase_migrations.schema_migrations where version = '172') = 0, '172 must not be applied yet';
end $$;

-- 166's function under a temp name, to run beside 172's installed one (same text, same attributes). ---------------
do $$
begin
  execute format(
    'create function pg_temp.f166(p_variants text[], p_folded text, p_limit integer default 12) returns table (id uuid) '
    || 'language sql stable set search_path = %L as %L',
    '', (select prosrc from old_src));
end $$;

-- Fixture (committed here, removed at the end). ids 00000000-0000-4000-8000-0000001721NN ---------------------------------
insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at) values
  -- miller (mil + ler): the stem collisions are newer than the real rows
  ('00000000-0000-4000-8000-000000172101', 'Mili Eğitim Bakanlığı toplantısı', null, 'Toplantı yapıldı.', 2, false, now() - interval '1 hour'),
  ('00000000-0000-4000-8000-000000172102', '70 mil teklifi açıklandı', null, 'Teklif sunuldu.', 2, false, now() - interval '2 hours'),
  ('00000000-0000-4000-8000-000000172103', 'Milden projesi tamamlandı', null, 'Proje bitti.', 2, false, now() - interval '3 hours'),
  ('00000000-0000-4000-8000-000000172104', 'Miller açıklama yaptı', null, 'Açıklama geldi.', 2, false, now() - interval '10 hours'),
  ('00000000-0000-4000-8000-000000172105', 'Eski Başkan Miller''ın ziyareti', null, 'Ziyaret edildi.', 2, false, now() - interval '20 hours'),
  ('00000000-0000-4000-8000-000000172106', 'Ziyaret gerçekleşti', null, 'Bay Miller’ı karşıladı.', 2, false, now() - interval '30 hours'),
  ('00000000-0000-4000-8000-000000172107', 'Yurtta ziyaret', 'Miller yurdu ziyaret etti', 'Ziyaret sürdü.', 2, false, now() - interval '40 hours'),
  ('00000000-0000-4000-8000-000000172108', 'Miller Irak''ta konuştu', null, 'Ziyaret sürdü.', 2, false, now() - interval '70 hours'),
  ('00000000-0000-4000-8000-000000172109', 'Miller Burdur''da konuştu', null, 'Ziyaret sürdü.', 2, false, now() - interval '71 hours'),
  ('00000000-0000-4000-8000-000000172110', 'Miller Ankara''da konuştu', null, 'Ziyaret sürdü.', 2, false, now() - interval '72 hours'),
  ('00000000-0000-4000-8000-000000172111', 'Miller Ersan ile görüştü', null, 'Görüşme sürdü.', 2, false, now() - interval '73 hours'),
  ('00000000-0000-4000-8000-000000172112', 'Miller arşiv haberi', null, 'Arşivde.', 2, true, now() - interval '74 hours'),
  ('00000000-0000-4000-8000-000000172113', 'Miller tek kaynaklı haber', null, 'Tek kaynak.', 1, false, now() - interval '75 hours'),
  -- bartin (bart + in; the variants arm stems bartın to bar)
  ('00000000-0000-4000-8000-000000172121', 'Bart De Wever istifa etti', null, 'Belçika.', 2, false, now() - interval '1 hour'),
  ('00000000-0000-4000-8000-000000172122', 'Ronen Bar görevden alındı', null, 'Şin Bet.', 2, false, now() - interval '2 hours'),
  ('00000000-0000-4000-8000-000000172123', 'Bartın''da fırtına', null, 'Hava kötü.', 2, false, now() - interval '10 hours'),
  ('00000000-0000-4000-8000-000000172124', 'Fırtına vurdu', null, 'Bartın''ın sahili zarar gördü.', 2, false, now() - interval '20 hours'),
  ('00000000-0000-4000-8000-000000172125', 'Amasra', null, 'Bartin kıyıları.', 2, false, now() - interval '25 hours'),
  -- saniye (sani + ye)
  ('00000000-0000-4000-8000-000000172131', 'Al Sani ile görüştü', null, 'Katar.', 2, false, now() - interval '1 hour'),
  ('00000000-0000-4000-8000-000000172132', 'Saniye Hanım açıklama yaptı', null, 'Haber.', 2, false, now() - interval '25 hours'),
  ('00000000-0000-4000-8000-000000172133', 'Maç sona erdi', null, 'Gol son saniye atıldı.', 2, false, now() - interval '26 hours'),
  -- irakta and zamlar (166's inflected roots: exempt too, so tiered too)
  ('00000000-0000-4000-8000-000000172141', 'Irak Başbakanı açıklama yaptı', null, 'Başbakan basın toplantısı düzenledi.', 2, false, now() - interval '11.8 hours'),
  ('00000000-0000-4000-8000-000000172142', 'Irak''ta saldırı', null, 'Saldırıda can kaybı yaşandı.', 2, false, now() - interval '11.9 hours'),
  ('00000000-0000-4000-8000-000000172143', 'Orta Doğu gerginliği', null, 'Irak''ta yeni bir saldırı oldu.', 2, false, now() - interval '60 hours'),
  ('00000000-0000-4000-8000-000000172144', 'Emekli maaşına zam', null, 'Zam oranı açıklandı.', 2, false, now() - interval '12 hours'),
  ('00000000-0000-4000-8000-000000172145', 'Zamlar sürüyor', null, 'Fiyatlar arttı.', 2, false, now() - interval '50 hours'),
  ('00000000-0000-4000-8000-000000172146', 'Maaşlar', null, 'Zamlar belli oldu.', 2, false, now() - interval '55 hours'),
  -- guarded words and queries 172 must not change
  ('00000000-0000-4000-8000-000000172151', 'Burdur''da yurt zehirlenmesi', null, 'Öğrenciler hastaneye kaldırıldı.', 2, false, now() - interval '1 hour'),
  ('00000000-0000-4000-8000-000000172152', 'Bursa''da deprem uyarısı', null, 'Uzmanlar uyardı.', 2, false, now() - interval '2 hours'),
  ('00000000-0000-4000-8000-000000172153', 'Bakanlıktan Ersan açıklaması', null, 'Açıklama yapıldı.', 2, false, now() - interval '3 hours'),
  ('00000000-0000-4000-8000-000000172154', 'Erken seçim anketi', null, 'Anket sonuçları.', 2, false, now() - interval '4 hours'),
  ('00000000-0000-4000-8000-000000172155', 'İlhan Kesici hayır diyecek', null, 'Konuşma yapacak.', 2, false, now() - interval '6 hours'),
  ('00000000-0000-4000-8000-000000172156', 'İlham Aliyev Ankara''da', null, 'Ziyaret edecek.', 2, false, now() - interval '7 hours'),
  ('00000000-0000-4000-8000-000000172157', 'Iğdır''da şehit', null, 'Şehit töreni yapıldı.', 2, false, now() - interval '8 hours'),
  ('00000000-0000-4000-8000-000000172158', 'Şişli''de yol çalışması', null, 'Belediye açıklama yaptı.', 2, false, now() - interval '12 hours'),
  ('00000000-0000-4000-8000-000000172159', 'Seçim sonuçları açıklandı', null, 'Kurul sonuçları duyurdu.', 2, false, now() - interval '13 hours'),
  ('00000000-0000-4000-8000-000000172160', 'Putin Moskova''da konuştu', null, 'Kremlin açıklama yaptı.', 2, false, now() - interval '14 hours'),
  ('00000000-0000-4000-8000-000000172161', 'AKP''den açıklama', null, 'Parti sözcüsü konuştu.', 2, false, now() - interval '15 hours'),
  ('00000000-0000-4000-8000-000000172162', 'AK Parti toplantısı', null, 'Grup toplantısı yapıldı.', 2, false, now() - interval '16 hours'),
  ('00000000-0000-4000-8000-000000172163', 'Erdoğan kabine toplantısı sonrası konuştu', null, 'Açıklama yaptı.', 2, false, now() - interval '23 hours');
analyze public.clusters;

-- ge: the exempt words each query has (the tier), hand-written from the stems: mil + ler, bart + in, sani + ye,
-- irak + ta, zam + lar. [] when the query has none, or an OR / negated phrase switches the tier off.
create temp table qs (q text primary key, variants text[] not null, folded text, ge text[] not null);
insert into qs values
  ('miller',           array['miller'],                          'miller',                     array['miller']),
  ('bartin',           array['bartın', 'bartin'],                'bartin',                     array['bartin']),
  ('bartin ascii',     array['bartin'],                          'bartin',                     array['bartin']),
  ('saniye',           array['saniye'],                          'saniye',                     array['saniye']),
  ('irakta',           array['irakta'],                          'irakta',                     array['irakta']),
  ('zamlar',           array['zamlar'],                          'zamlar',                     array['zamlar']),
  ('miller irakta',    array['miller irakta'],                   'miller irakta',              array['miller', 'irakta']),
  ('miller burdur',    array['miller burdur'],                   'miller burdur',              array['miller']),
  ('miller ankara',    array['miller ankara'],                   'miller ankara',              array['miller']),
  ('miller -ersan',    array['miller -ersan'],                   'miller -ersan',              array['miller']),
  ('miller or burdur', array['miller or burdur'],                'miller or burdur',           array[]::text[]),
  ('negated phrase',   array['miller -"x y"'],                   'miller -"x y"',              array[]::text[]),
  ('burdur',           array['burdur'],                          'burdur',                     array[]::text[]),
  ('ersan',            array['ersan'],                           'ersan',                      array[]::text[]),
  ('ilhan',            array['ilhan'],                           'ilhan',                      array[]::text[]),
  ('igdir',            array['ığdır', 'iğdir', 'iğdır'],         'igdir',                      array[]::text[]),
  ('sisli',            array['şişli'],                           'sisli',                      array[]::text[]),
  ('secim',            array['seçim'],                           'secim',                      array[]::text[]),
  ('putin',            array['putin'],                           'putin',                      array[]::text[]),
  ('erdogan',          array['erdoğan'],                         'erdogan',                    array[]::text[]),
  ('akp alias',        array['akp or "ak parti"'],               'akp or ak parti',            array[]::text[]),
  ('empty',            array[''],                                '',                           array[]::text[]),
  ('null folded',      array['burdur'],                          null,                         array[]::text[]);

-- baseline: 166 (production's body) at p_limit 50, the way the app asks. ------------------------------------------
create temp table res_before as
  select qs.q, t.n, t.id from qs cross join lateral pg_temp.f166(qs.variants, qs.folded, 50) with ordinality as t(id, n);

-- The defect is there on the 166 body (so the "after" below proves something): the collisions rank above real rows. ----
do $$
declare
  v_rank integer;
  v_other integer;
begin
  select n into v_rank from res_before where q = 'miller' and id = '00000000-0000-4000-8000-000000172106';
  select n into v_other from res_before where q = 'miller' and id = '00000000-0000-4000-8000-000000172101';
  assert v_other < v_rank, format('baseline: 166 ranks Mili Egitim (%s) above the summary-only Miller row (%s)', v_other, v_rank);
  select n into v_rank from res_before where q = 'bartin' and id = '00000000-0000-4000-8000-000000172124';
  select n into v_other from res_before where q = 'bartin' and id = '00000000-0000-4000-8000-000000172121';
  assert v_other < v_rank, format('baseline: 166 ranks Bart De Wever (%s) above the Bartin summary row (%s)', v_other, v_rank);
  select n into v_rank from res_before where q = 'saniye' and id = '00000000-0000-4000-8000-000000172133';
  select n into v_other from res_before where q = 'saniye' and id = '00000000-0000-4000-8000-000000172131';
  assert v_other < v_rank, format('baseline: 166 ranks Al Sani (%s) above the summary-only saniye row (%s)', v_other, v_rank);
  select n into v_rank from res_before where q = 'irakta' and id = '00000000-0000-4000-8000-000000172143';
  select n into v_other from res_before where q = 'irakta' and id = '00000000-0000-4000-8000-000000172141';
  assert v_other < v_rank, format('baseline: 166 ranks Irak Basbakani (%s) above the summary-only Irak''ta row (%s)', v_other, v_rank);
  assert (select count(*) from res_before where q = 'miller') = 11, 'miller before: 11 rows (3 collisions, 8 Miller rows; archived and single-article rows are never candidates)';
  assert (select count(*) from res_before where q = 'bartin') = 5, 'bartin before: 5 rows';
  assert (select max(c) from (select count(*) as c from res_before group by q) m) < 50, 'the fixture keeps every list far below the 50-row cap';
end $$;

-- Apply 172 TWICE (re-apply safety). --------------------------------------------------------------------------
\ir ../../../supabase/migrations/172_search_exempt_word_tier.sql
\ir ../../../supabase/migrations/172_search_exempt_word_tier.sql

-- Ledger, shape and ACL after both runs -------------------------------------------------------------------------
do $$
declare
  v_n integer;
  v_p pg_catalog.pg_proc%rowtype;
  v_acl text;
begin
  select count(*) into v_n from supabase_migrations.schema_migrations where version = '172';
  assert v_n = 1, format('ledger rows for 172: %s (expected exactly 1)', v_n);
  assert (select name from supabase_migrations.schema_migrations where version = '172') = '172_search_exempt_word_tier', 'ledger name';
  assert (select count(*) from supabase_migrations.schema_migrations where version = '166') = 1, '166 ledger row is untouched';

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
  assert obj_description(v_p.oid, 'pg_proc') like '%172%' and obj_description(v_p.oid, 'pg_proc') like '%tier%', 'function comment must mention the tier of 172';
  assert md5(v_p.prosrc) <> 'd7f4b4223730e06db8479f42776d8040', 'the body must have changed';
  assert md5(v_p.prosrc) = '192218b7b6a56b3c8fcc48d5e0610a2c' and length(v_p.prosrc) = 12913,
         format('172 body md5 %s length %s (the file: 192218b7b6a56b3c8fcc48d5e0610a2c, 12913)', md5(v_p.prosrc), length(v_p.prosrc));

  -- ACL: owner and service_role only; no PUBLIC (grantee 0), no anon, no authenticated.
  assert not has_function_privilege('anon', v_p.oid, 'execute'), 'anon must not execute';
  assert not has_function_privilege('authenticated', v_p.oid, 'execute'), 'authenticated must not execute';
  assert has_function_privilege('service_role', v_p.oid, 'execute'), 'service_role must execute';
  assert not exists (select 1 from aclexplode(v_p.proacl) a where a.grantee = 0), 'PUBLIC must have no grant';
  select string_agg(a.grantee::regrole::text, ',' order by a.grantee::regrole::text) into v_acl
    from aclexplode(v_p.proacl) a;
  assert v_acl = 'postgres,service_role', format('grantees: %s', v_acl);

  -- nothing else changed: the fold function, its index and the table are 129's
  assert (select count(*) from pg_catalog.pg_proc where pronamespace = 'public'::regnamespace and proname = 'tayf_search_fold') = 1, 'fold overloads';
  assert to_regclass('public.clusters_search_fold_live_idx') is not null, '129 index';
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
      perform 1 from public.search_cluster_ids(array['miller'], 'miller', 24);
    exception when insufficient_privilege then
      v_denied := true;
    end;
    reset role;
    assert v_denied, format('%s must be denied', v_role);
  end loop;

  set local role service_role;
  select count(*) into v_n from public.search_cluster_ids(array['miller'], 'miller', 24);
  reset role;
  assert v_n > 0, 'service_role must get rows';
end $$;

-- The same queries after 172. ------------------------------------------------------------------------------
create temp table res_after as
  select qs.q, t.n, t.id from qs cross join lateral public.search_cluster_ids(qs.variants, qs.folded, 50) with ordinality as t(id, n);

-- The text the tier reads, restated here with a different construction from the function's (position, not strpos). ----
create temp table lit_text as
  select c.id,
         regexp_replace(public.tayf_search_fold(replace(replace(
           coalesce(c.title_tr_neutral, '') || ' ' || coalesce(c.title_tr, '') || ' ' || coalesce(c.summary_tr, ''),
           chr(39), ''), chr(8217), '')), '[^a-z0-9]+', ' ', 'g') as x
    from public.clusters c;

do $$
declare
  r record;
  v_before uuid[];
  v_after uuid[];
  v_expected uuid[];
begin
  -- the contract, for every query: 172's list is the stable partition of 166's list by the tier
  for r in select * from qs order by q loop
    select coalesce(array_agg(id order by n), '{}') into v_before from res_before where q = r.q;
    select coalesce(array_agg(id order by n), '{}') into v_after from res_after where q = r.q;
    select coalesce(array_agg(s.id order by s.tier, s.n), '{}') into v_expected
      from (
        select b.id, b.n,
               case when not exists (select 1 from unnest(r.ge) w where position(' ' || w in ' ' || (select x from lit_text where lit_text.id = b.id)) = 0)
                    then 0 else 1 end as tier
          from res_before b where b.q = r.q
      ) s;
    assert v_after = v_expected, format('query "%s": 172 is not the stable partition of 166 (166 %s, 172 %s, expected %s)', r.q, v_before, v_after, v_expected);
    assert cardinality(v_before) = cardinality(v_after), format('query "%s": the number of rows changed (recall)', r.q);
    if cardinality(r.ge) = 0 then
      assert v_before = v_after, format('query "%s" has no exempt word, so it must return 166''s list: %s -> %s', r.q, v_before, v_after);
    end if;
  end loop;

  -- what the partition must give for the queries of h58-postship-1 (written out, not derived)
  assert (select count(*) from res_after where q = 'miller') = 11, 'miller after: the same 11 rows (recall unchanged)';
  assert (select count(*) from res_after where q = 'miller' and n <= 8
             and id not in ('00000000-0000-4000-8000-000000172101', '00000000-0000-4000-8000-000000172102', '00000000-0000-4000-8000-000000172103')) = 8,
         'miller after: ranks 1 to 8 are the eight Miller rows, none of Mili / mil / Milden';
  assert (select count(*) from res_after where q = 'bartin') = 5, 'bartin after: the same 5 rows (recall unchanged)';
  assert (select count(*) from res_after where q = 'bartin' and n <= 3
             and id in ('00000000-0000-4000-8000-000000172123', '00000000-0000-4000-8000-000000172124', '00000000-0000-4000-8000-000000172125')) = 3,
         'bartin after: the three Bartin rows (title, summary with an apostrophe, summary plain) are ranks 1 to 3';
  assert (select count(*) from res_after where q = 'bartin' and n > 3
             and id in ('00000000-0000-4000-8000-000000172121', '00000000-0000-4000-8000-000000172122')) = 2,
         'bartin after: Bart De Wever and Ronen Bar are ranks 4 and 5';
  assert (select count(*) from res_after where q = 'saniye' and n <= 2
             and id in ('00000000-0000-4000-8000-000000172132', '00000000-0000-4000-8000-000000172133')) = 2
         and (select id from res_after where q = 'saniye' and n = 3) = '00000000-0000-4000-8000-000000172131',
         'saniye after: both rows with the word first, Al Sani last';
  assert (select count(*) from res_after where q = 'irakta' and n <= 3
             and id in ('00000000-0000-4000-8000-000000172142', '00000000-0000-4000-8000-000000172143', '00000000-0000-4000-8000-000000172108')) = 3
         and (select id from res_after where q = 'irakta' and n = 4) = '00000000-0000-4000-8000-000000172141',
         'irakta after: the rows that spell Irak''ta (title, summary, Miller Irak''ta) first, Irak Basbakani after';
  -- the queries 172 must not change, written out
  assert (select count(*) from res_after where q = 'burdur') = 2 and (select count(*) from res_after where q = 'ersan') = 2, 'burdur and ersan keep their guarded rows';
  assert (select count(*) from res_after where q = 'sisli') = 1, 'sisli finds the Sisli row';
  assert (select count(*) from res_after where q = 'akp alias') = 2, 'the alias query finds AKP and AK Parti';
  assert (select count(*) from res_after where q = 'empty') = 0 and (select count(*) from res_after where q = 'null folded') = (select count(*) from res_before where q = 'null folded'), 'empty and null folded queries';
  -- archived and single-article rows never appear
  assert not exists (select 1 from res_after where id in ('00000000-0000-4000-8000-000000172112', '00000000-0000-4000-8000-000000172113')), 'the live predicate holds';
end $$;

delete from public.clusters where id::text like '00000000-0000-4000-8000-0000001721%';

-- Realistic load: 12,000 live clusters (rolled back); the 166 body and the 172 body run inline as plain SELECTs
-- with EXPLAIN (ANALYZE), the way the migration header measures production. ----------------------------------
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
      'kira','zam','Miller','Milli','Mili','Bartın','Bart','Bar','saniye','Sani','zamlar','Irak''ta'
    ]) as w
    union all
    select translate(substr(md5('w' || g::text), 1, 7), '0123456789', 'ghjklmnprs')
      from generate_series(1, 400) g
  ) x;

-- titles of 8 to 11 words, summaries of 40 to 59 words, skewed toward the frequent head of the vocabulary
-- (482 words: 82 named ones, 400 made-up ones)
insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at)
select gen_random_uuid(),
       (select string_agg(v.w, ' ') from (select (select t.w from (select 1 + floor(power(random(), 2.0) * 482)::integer + k * 0 as pick) q join tmp_vocab t on t.i = q.pick) as w
                                              from generate_series(1, 8 + (g % 4)) k) v),
       null,
       (select string_agg(v.w, ' ') from (select (select t.w from (select 1 + floor(power(random(), 2.0) * 482)::integer + k * 0 as pick) q join tmp_vocab t on t.i = q.pick) as w
                                              from generate_series(1, 40 + (g % 20)) k) v),
       2 + (g % 19),
       false,
       now() - random() * interval '60 days'
  from generate_series(1, 12000) g;
-- a few hundred rows that DO hold the three name-shaped words in the title, so the tier has rows to lift
insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at)
select gen_random_uuid(), w.t || ' ' || g, null, 'Haber metni ' || g, 2 + (g % 5), false, now() - random() * interval '60 days'
  from generate_series(1, 60) g
  cross join (values ('Miller açıklama yaptı'), ('Bartın''da fırtına'), ('Saniye Hanım konuştu'), ('Irak''ta saldırı'), ('Zamlar sürüyor')) w(t);
analyze public.clusters;

create function pg_temp.median_ms(p_src text, p_typed text, p_folded text, p_runs integer default 5) returns numeric
language plpgsql as $f$
declare
  v_src text;
  v_line text;
  v_ms numeric[] := '{}';
  i integer;
begin
  v_src := replace(replace(replace(p_src, 'p_variants', format('(array[%L]::text[])', p_typed)), 'p_folded', format('(%L::text)', p_folded)), 'p_limit', '24');
  for i in 0..p_runs loop
    for v_line in execute 'explain (analyze) ' || v_src loop
      if i > 0 and v_line like 'Execution Time:%' then v_ms := v_ms || substring(v_line from '([0-9.]+) ms')::numeric; end if;
    end loop;
  end loop;
  return (select percentile_cont(0.5) within group (order by m) from unnest(v_ms) m);
end $f$;

-- Timing: the 166 body and the 172 body, inline, alternating, the median of 5 runs each after one warm-up run each.
-- Production is the measurement of record (the migration header: iran, secim and the five exempt queries within 1.3x).
-- The queries with no exempt word run the tier off: lit_ok is true without reading a cluster text, so they must cost
-- what 166 costs (bound 1.5x here: a body that folded the summary of every hit anyway would fail it). The exempt
-- queries fold the summary of each hit whose title lacks the word, and this load has long summaries (about 400
-- characters, 1000 hits, few real rows: the worst case), so their bound is a gross one (2.4x; the first draft that
-- folded title and summary of every hit measured 2.7x on it, this body about 1.6x).
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
      ('iran', 'iran', false), ('seçim', 'secim', false), ('bakan', 'bakan', false),
      ('miller', 'miller', true), ('bartın', 'bartin', true), ('saniye', 'saniye', true), ('zamlar', 'zamlar', true), ('irakta', 'irakta', true)
    ) as t(typed, folded, exempt) loop
    v_a := pg_temp.median_ms(v_old, v_q.typed, v_q.folded);
    v_b := pg_temp.median_ms(v_new, v_q.typed, v_q.folded);
    v_ratio := v_b / v_a;
    raise notice '%: 166 body % ms, 172 body % ms, median ratio % (%)', v_q.typed, v_a, v_b, round(v_ratio, 2),
      case when v_q.exempt then 'tier on' else 'tier off' end;
    -- the 1.3x gate is measured on production; here a gross regression fails
    assert v_ratio < case when v_q.exempt then 2.4 else 1.5 end,
           format('%s: the 172 body took %sx the 166 body (bound %sx on this load)', v_q.typed, round(v_ratio, 2), case when v_q.exempt then 2.4 else 1.5 end);
  end loop;
  -- the tier must not drop a row: 24 rows come back for every query on this load
  assert (select count(*) from public.search_cluster_ids(array['miller'], 'miller', 24)) = 24, 'miller: 24 rows on the load';
  assert (select count(*) from public.search_cluster_ids(array['bartın', 'bartin'], 'bartin', 24)) = 24, 'bartin: 24 rows on the load';
end $$;
rollback;

\echo DRYRUN 172 OK
