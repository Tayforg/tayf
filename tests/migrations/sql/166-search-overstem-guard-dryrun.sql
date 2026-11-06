-- 166 search over-stem guard: local PG15 dry-run. Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust -E UTF8 --locale=en_US.UTF-8 >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55566 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55566 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql \
--     -f tests/migrations/sql/166-search-overstem-guard-dryrun.sql
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh
--
-- (\ir paths below are relative to this file.) Every check is a DO block that raises on mismatch, so a clean
-- run ending in "DRYRUN 166 OK" is the pass. The migration is applied twice; psql prints the command tags, so
-- the ledger insert reads INSERT 0 1 and then INSERT 0 0.
--
-- Order: the 129 state (166-search-overstem-guard-setup.sql: search_tsv, 083's index, 129 itself), 129's body
-- checked against production's md5, a fixture of stem collisions (committed here, removed at the end) and the
-- answers of the 129 function to a list of queries, then 166 TWICE, ledger / shape / ACL, the same list again
-- (the collisions gone, every normal query identical, the inflected roots irakta / kirada / zamlar identical to 129),
-- the denied roles, and last a synthetic load of 12,000 live clusters (rolled back) with EXPLAIN (ANALYZE) of the
-- 129 body and the 166 body inline for 'iran', 'seçim' and 'bakan' (over-cut stems, large candidate sets) and for
-- 'irakta', 'kirada' and 'zamlar' (exempt, so they must cost what 129 costs). The 1.3x gate of h50-search-1 is
-- measured on production; here a gross regression fails (the guard run over every candidate), and the SEC-h50-1
-- case fails at 1.3x: a guarded word typed five times must cost what the same query with each distinct word
-- once costs. The few-survivor worst case (a broad stem, a rare prefix) is printed, never asserted.

\set ON_ERROR_STOP on

-- Prelude: Supabase default privileges (so the revokes have something to undo). ---------------------------
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;

-- The 129 state. ---------------------------------------------------------------------------------------
\ir 166-search-overstem-guard-setup.sql

-- 129's body is production's body (read-only on 2026-11-06: md5(prosrc) cb7fee86..., length 3426). ----------
create temp table old_src as
  select p.prosrc from pg_catalog.pg_proc p
   where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
do $$
declare
  v_md5 text;
  v_len integer;
begin
  select md5(prosrc), length(prosrc) into v_md5, v_len from old_src;
  assert v_md5 = 'cb7fee8680c50e8f20bafab3e29fef39', format('129 body md5 %s (production: cb7fee86...)', v_md5);
  assert v_len = 3426, format('129 body length %s (production: 3426)', v_len);
  assert (select count(*) from supabase_migrations.schema_migrations where version = '166') = 0, '166 must not be applied yet';
end $$;

-- Fixture: stem collisions and the queries the guard must not change (committed; removed at the end). ------
insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at) values
  ('00000000-0000-4000-8000-000000166101', 'Burdur''da yurt zehirlenmesi', null, 'Öğrenciler hastaneye kaldırıldı.', 2, false, now() - interval '1 hour'),
  ('00000000-0000-4000-8000-000000166102', 'Bursa''da deprem uyarısı', null, 'Uzmanlar uyardı.', 2, false, now() - interval '2 hours'),
  ('00000000-0000-4000-8000-000000166103', 'Bakanlıktan Ersan açıklaması', null, 'Açıklama yapıldı.', 2, false, now() - interval '3 hours'),
  ('00000000-0000-4000-8000-000000166104', 'Erken seçim anketi', null, 'Anket sonuçları.', 2, false, now() - interval '4 hours'),
  ('00000000-0000-4000-8000-000000166105', 'Sona erdi', null, 'Süreç tamamlandı.', 2, false, now() - interval '5 hours'),
  ('00000000-0000-4000-8000-000000166106', 'İlhan Kesici hayır diyecek', null, 'Konuşma yapacak.', 2, false, now() - interval '6 hours'),
  ('00000000-0000-4000-8000-000000166107', 'İlham Aliyev Ankara''da', null, 'Ziyaret edecek.', 2, false, now() - interval '7 hours'),
  ('00000000-0000-4000-8000-000000166108', 'Iğdır''da şehit', null, 'Şehit töreni yapıldı.', 2, false, now() - interval '8 hours'),
  ('00000000-0000-4000-8000-000000166109', 'Emekli maaşına zam', null, 'Zam oranı ikindi saatlerinde açıklandı.', 2, false, now() - interval '9 hours'),
  ('00000000-0000-4000-8000-000000166110', 'Turizm sezonu açıldı', null, 'Burdur Gölü çevresinde otel doluluğu arttı.', 2, false, now() - interval '10 hours'),
  ('00000000-0000-4000-8000-000000166111', 'Yurtta zehirlenme şüphesi', 'Burdur yurdunda zehirlenme şüphesi', 'Kurum inceleme başlattı.', 2, false, now() - interval '11 hours'),
  ('00000000-0000-4000-8000-000000166112', U&'\201CBurdur\201D için yeni karar', null, 'Karar açıklandı.', 2, false, now() - interval '12 hours'),
  ('00000000-0000-4000-8000-000000166113', 'Bursa''da Akburdan olayı', null, 'Polis inceleme başlattı.', 2, false, now() - interval '13 hours'),
  ('00000000-0000-4000-8000-000000166114', 'Şişli''de yol çalışması', null, 'Belediye açıklama yaptı.', 2, false, now() - interval '14 hours'),
  ('00000000-0000-4000-8000-000000166115', 'Seçim sonuçları açıklandı', null, 'Kurul sonuçları duyurdu.', 2, false, now() - interval '15 hours'),
  ('00000000-0000-4000-8000-000000166116', 'Putin Moskova''da konuştu', null, 'Kremlin açıklama yaptı.', 2, false, now() - interval '16 hours'),
  ('00000000-0000-4000-8000-000000166117', 'AKP''den açıklama', null, 'Parti sözcüsü konuştu.', 2, false, now() - interval '17 hours'),
  ('00000000-0000-4000-8000-000000166118', 'AK Parti toplantısı', null, 'Grup toplantısı yapıldı.', 2, false, now() - interval '18 hours'),
  ('00000000-0000-4000-8000-000000166119', 'Burdur''da arşivlenen haber', null, 'Arşivde.', 2, true, now() - interval '19 hours'),
  ('00000000-0000-4000-8000-000000166120', 'Burdur''da tek kaynaklı haber', null, 'Tek kaynak.', 1, false, now() - interval '20 hours'),
  -- inflected roots (review fix): irakta, kirada and zamlar are a root plus a case or plural suffix, never guarded
  ('00000000-0000-4000-8000-000000166121', 'Irak''ta saldırı', null, 'Saldırıda can kaybı yaşandı.', 2, false, now() - interval '21 hours'),
  ('00000000-0000-4000-8000-000000166122', 'Irak Başbakanı açıklama yaptı', null, 'Başbakan basın toplantısı düzenledi.', 2, false, now() - interval '22 hours'),
  ('00000000-0000-4000-8000-000000166123', 'Kira artışı açıklandı', null, 'Yeni oran belli oldu.', 2, false, now() - interval '23 hours');
analyze public.clusters;

create temp table qs (q text primary key, variants text[] not null, folded text);
insert into qs values
  ('burdur',          array['burdur'],                          'burdur'),
  ('ersan',           array['ersan'],                           'ersan'),
  ('ilhan',           array['ilhan'],                           'ilhan'),
  ('igdir',           array['ığdır', 'iğdir', 'iğdır'],         'igdir'),
  ('sisli',           array['şişli'],                           'sisli'),
  ('secim',           array['seçim'],                           'secim'),
  ('putin',           array['putin'],                           'putin'),
  ('akp alias',       array['akp or "ak parti"'],               'akp or ak parti'),
  ('ersan or burdur', array['ersan or burdur'],                 'ersan or burdur'),
  ('burdur deprem',   array['burdur deprem'],                   'burdur deprem'),
  ('irakta',          array['irakta'],                          'irakta'),
  ('kirada',          array['kirada'],                          'kirada'),
  ('zamlar',          array['zamlar'],                          'zamlar'),
  ('zam -ersan',      array['zam -ersan'],                      'zam -ersan'),
  ('negated phrase',  array['deprem -"x burdur"'],              'deprem -"x burdur"'),
  ('empty',           array[''],                                ''),
  ('null folded',     array['burdur'],                          null);

create temp table res_before as
  select qs.q, t.n, t.id from qs cross join lateral public.search_cluster_ids(qs.variants, qs.folded, 24) with ordinality as t(id, n);

-- The collisions are really there on the 129 body (so the "after" below proves something). ------------------
do $$
begin
  assert (select count(*) from res_before where q = 'burdur') = 6, 'burdur before: 6 (Burdur x4 incl. quoted, Bursa x2)';
  assert (select count(*) from res_before where q = 'ersan') = 3, 'ersan before: 3 (Ersan, erken, sona erdi)';
  assert (select count(*) from res_before where q = 'ilhan') = 2, 'ilhan before: 2 (Ilhan, Ilham)';
  assert (select count(*) from res_before where q = 'igdir') = 2, 'igdir before: 2 (Igdir, ikindi)';
  assert (select count(*) from res_before where q = 'irakta') = 2, 'irakta before: 2 (Irak''ta, Irak Başbakanı)';
  assert (select count(*) from res_before where q = 'kirada') = 1, 'kirada before: 1 (Kira artışı)';
  assert (select count(*) from res_before where q = 'zamlar') = 1, 'zamlar before: 1 (Emekli maaşına zam)';
end $$;

-- Apply 166 TWICE (re-apply safety). -------------------------------------------------------------------
\ir ../../../supabase/migrations/166_search_overstem_guard.sql
\ir ../../../supabase/migrations/166_search_overstem_guard.sql

-- Ledger, shape and ACL after both runs ------------------------------------------------------------------
do $$
declare
  v_n integer;
  v_p pg_catalog.pg_proc%rowtype;
  v_acl text;
begin
  select count(*) into v_n from supabase_migrations.schema_migrations where version = '166';
  assert v_n = 1, format('ledger rows for 166: %s (expected exactly 1)', v_n);
  assert (select name from supabase_migrations.schema_migrations where version = '166') = '166_search_overstem_guard', 'ledger name';

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
  assert obj_description(v_p.oid, 'pg_proc') like '%guard%' and obj_description(v_p.oid, 'pg_proc') like '%166%', 'function comment must mention the guard of 166';
  assert md5(v_p.prosrc) <> 'cb7fee8680c50e8f20bafab3e29fef39', 'the body must have changed';

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
      perform 1 from public.search_cluster_ids(array['burdur'], 'burdur', 24);
    exception when insufficient_privilege then
      v_denied := true;
    end;
    reset role;
    assert v_denied, format('%s must be denied', v_role);
  end loop;

  set local role service_role;
  select count(*) into v_n from public.search_cluster_ids(array['burdur'], 'burdur', 24);
  reset role;
  assert v_n > 0, 'service_role must get rows';
end $$;

-- The same queries after 166. ------------------------------------------------------------------------
create temp table res_after as
  select qs.q, t.n, t.id from qs cross join lateral public.search_cluster_ids(qs.variants, qs.folded, 24) with ordinality as t(id, n);

do $$
declare
  r record;
  v_before uuid[];
  v_after uuid[];
begin
  -- the collisions are gone, the rows with the word are kept
  assert (select array_agg(id order by id) from res_after where q = 'burdur') = array[
    '00000000-0000-4000-8000-000000166101', '00000000-0000-4000-8000-000000166110',
    '00000000-0000-4000-8000-000000166111', '00000000-0000-4000-8000-000000166112']::uuid[],
    'burdur after: the title, summary, neutral-title and quoted rows only';
  assert (select id from res_after where q = 'burdur' order by n desc limit 1) = '00000000-0000-4000-8000-000000166110',
    'burdur after: the summary-only row ranks last (the literal title tier still orders)';
  assert (select array_agg(id) from res_after where q = 'ersan') = array['00000000-0000-4000-8000-000000166103']::uuid[], 'ersan after: the Ersan row only';
  assert (select array_agg(id) from res_after where q = 'ilhan') = array['00000000-0000-4000-8000-000000166106']::uuid[], 'ilhan after: Ilhan, not Ilham';
  assert (select array_agg(id) from res_after where q = 'igdir') = array['00000000-0000-4000-8000-000000166108']::uuid[], 'igdir after: Igdir, not the ikindi row';
  assert (select count(*) from res_after where q = 'burdur deprem') = 0, 'burdur deprem after: nothing (Bursa has no burd)';
  -- a root plus a case or plural suffix is not guarded: the ids and the order are 129's (the generic loop below
  -- compares them; these three say what must be there)
  assert (select count(*) from res_after where q = 'irakta') = 2, 'irakta after: both Irak rows (it used to ask for "irakt")';
  assert (select count(*) from res_after where q = 'kirada') = 1, 'kirada after: the Kira row';
  assert (select count(*) from res_after where q = 'zamlar') = 1, 'zamlar after: the zam row';

  -- every other query returns the same ids in the same order as the 129 function
  for r in select q from qs where q not in ('burdur', 'ersan', 'ilhan', 'igdir', 'burdur deprem') order by q loop
    select coalesce(array_agg(id order by n), '{}') into v_before from res_before where q = r.q;
    select coalesce(array_agg(id order by n), '{}') into v_after from res_after where q = r.q;
    assert v_before = v_after, format('query "%s" changed: %s -> %s', r.q, v_before, v_after);
  end loop;
  assert (select count(*) from res_after where q = 'sisli') = 1, 'sisli finds the Sisli row';
  assert (select count(*) from res_after where q = 'akp alias') = 2, 'the alias query finds AKP and AK Parti';
  assert (select count(*) from res_after where q = 'empty') = 0, 'the empty query finds nothing';
  -- archived and single-article rows never appear
  assert not exists (select 1 from res_after where id in ('00000000-0000-4000-8000-000000166119', '00000000-0000-4000-8000-000000166120')), 'the live predicate holds';
end $$;

delete from public.clusters where id::text like '00000000-0000-4000-8000-0000001661%';

-- Realistic load: 12,000 live clusters (rolled back); the 129 body and the 166 body run inline as plain SELECTs
-- with EXPLAIN (ANALYZE), the way the migration header measures production. -----------------------------
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
      'kira','zam'
    ]) as w
    union all
    select translate(substr(md5('w' || g::text), 1, 7), '0123456789', 'ghjklmnprs')
      from generate_series(1, 400) g
  ) x;

-- titles of 8 to 11 words, summaries of 40 to 59 words, skewed toward the frequent head of the vocabulary
-- (472 words: 72 named ones, 400 made-up ones)
insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at)
select gen_random_uuid(),
       (select string_agg(v.w, ' ') from (select (select t.w from (select 1 + floor(power(random(), 2.0) * 472)::integer + k * 0 as pick) q join tmp_vocab t on t.i = q.pick) as w
                                              from generate_series(1, 8 + (g % 4)) k) v),
       null,
       (select string_agg(v.w, ' ') from (select (select t.w from (select 1 + floor(power(random(), 2.0) * 472)::integer + k * 0 as pick) q join tmp_vocab t on t.i = q.pick) as w
                                              from generate_series(1, 40 + (g % 20)) k) v),
       2 + (g % 19),
       false,
       now() - random() * interval '60 days'
  from generate_series(1, 12000) g;
analyze public.clusters;

do $$
declare
  v_old text;
  v_new text;
  v_q record;
  v_src_old text;
  v_src_new text;
  v_line text;
  v_old_ms numeric[];
  v_new_ms numeric[];
  v_rows integer;
  v_ratio numeric;
  i integer;
begin
  select prosrc into v_old from old_src;
  select p.prosrc into v_new from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
  for v_q in select * from (values ('iran', 'iran'), ('seçim', 'secim'), ('bakan', 'bakan'), ('irakta', 'irakta'), ('kirada', 'kirada'), ('zamlar', 'zamlar')) as t(typed, folded) loop
    v_src_old := replace(replace(replace(v_old, 'p_variants', format('(array[%L]::text[])', v_q.typed)), 'p_folded', format('(%L::text)', v_q.folded)), 'p_limit', '24');
    v_src_new := replace(replace(replace(v_new, 'p_variants', format('(array[%L]::text[])', v_q.typed)), 'p_folded', format('(%L::text)', v_q.folded)), 'p_limit', '24');
    v_old_ms := '{}';
    v_new_ms := '{}';
    for i in 1..3 loop
      for v_line in execute 'explain (analyze) ' || v_src_old loop
        if v_line like 'Execution Time:%' then v_old_ms := v_old_ms || substring(v_line from '([0-9.]+) ms')::numeric; end if;
      end loop;
      for v_line in execute 'explain (analyze) ' || v_src_new loop
        if v_line like 'Execution Time:%' then v_new_ms := v_new_ms || substring(v_line from '([0-9.]+) ms')::numeric; end if;
      end loop;
    end loop;
    select count(*) into v_rows from public.search_cluster_ids(array[v_q.typed], v_q.folded, 24);
    assert v_rows = 24, format('%s: the 166 function returned %s rows (expected 24 on the load)', v_q.typed, v_rows);
    v_ratio := (select percentile_cont(0.5) within group (order by m) from unnest(v_new_ms) m)
             / (select percentile_cont(0.5) within group (order by m) from unnest(v_old_ms) m);
    raise notice '%: 129 body % ms, 166 body % ms, median ratio %', v_q.typed, v_old_ms, v_new_ms, round(v_ratio, 2);
    -- Production is the measurement of record (h50-search-1: iran and seçim within 1.3x, see the header of 166).
    -- This load has its words in long summaries more than in headlines, so the guard works harder here than on real
    -- data. What the bound catches is the guard run over EVERY candidate (about 6x on this load) instead of the
    -- first 1000 survivors.
    assert v_ratio < 4, format('%s: the 166 body took %sx the 129 body (bound 4x on this load)', v_q.typed, round(v_ratio, 2));
  end loop;
end $$;

-- SEC-h50-1: a guarded word typed several times is ONE guard row (select distinct), and each candidate folds its text at
-- most twice however many guard words there are. So a query that repeats one guarded word and ends in a rarer
-- guarded prefix must cost what the same query with each distinct word once costs. Before the fix every duplicate
-- guard row re-folded the title, the summary and the neutral title of every candidate (on production 'bakan' x5 plus
-- 'bakada' took 1,386 ms against 209 ms for this body). The median of 5 runs each, after one warm-up run.
create function pg_temp.dry_median_ms(p_src text, p_typed text, p_folded text, p_runs integer default 5) returns numeric
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

do $$
declare
  v_new text;
  v_case record;
  v_rep numeric;
  v_once numeric;
  v_ratio numeric;
begin
  select p.prosrc into v_new from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
  for v_case in select * from (values
      ('bakan bakan bakan bakan burdur', 'bakan burdur'),
      ('bakan bakan bakan bakan bakan ersan', 'bakan ersan')
    ) as t(repeated, once) loop
    v_rep := pg_temp.dry_median_ms(v_new, v_case.repeated, v_case.repeated);
    v_once := pg_temp.dry_median_ms(v_new, v_case.once, v_case.once);
    v_ratio := v_rep / v_once;
    raise notice '%: % ms, % (each distinct word once): % ms, ratio %', v_case.repeated, v_rep, v_case.once, v_once, round(v_ratio, 2);
    if v_ratio > 1.3 then
      raise exception '"%" took %x the time of "%" (bound 1.3x: every candidate is folded at most twice, however many guard words)', v_case.repeated, round(v_ratio, 2), v_case.once;
    end if;
  end loop;
end $$;

-- The known worst case, printed for the record and NEVER asserted: a few-survivor query whose stem is broad and whose own
-- prefix is rare ('bakam': stem 'baka', shared by every 'bakan' row, no row has a word starting 'bakam') visits every
-- candidate and keeps none, so it costs more than 129 does (production: 152 ms -> 444 ms; 'ayse' 145 -> 268 ms). The
-- migration header lists both as the known worst case above the 1.3x gate.
do $$
declare
  v_old text;
  v_new text;
  v_a numeric;
  v_b numeric;
begin
  select prosrc into v_old from old_src;
  select p.prosrc into v_new from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
  v_a := pg_temp.dry_median_ms(v_old, 'bakam', 'bakam', 3);
  v_b := pg_temp.dry_median_ms(v_new, 'bakam', 'bakam', 3);
  raise notice 'few-survivor worst case (informational, not a gate): bakam, 129 body % ms, 166 body % ms, ratio %', v_a, v_b, round(v_b / v_a, 2);
end $$;
rollback;

\echo DRYRUN 166 OK
