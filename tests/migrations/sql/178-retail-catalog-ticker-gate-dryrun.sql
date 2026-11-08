-- 178 retail_catalog_ticker_gate (public.is_retail_catalog, and resolve_article_tickers_for stops attaching a ticker to a retail
-- chain's weekly catalog or promo headline): local PG15 dry-run. Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55573 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55573 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/178-retail-catalog-ticker-gate-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql PGHOST=/tmp PGPORT=55573 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/178-retail-catalog-ticker-gate)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh    (TAYF_LIVE_ONLY=178 runs just this one)
--
-- (\ir paths below are relative to this file.) Every check is a DO block or a pg_temp function that raises on mismatch, so a
-- clean run ending in "DRYRUN 178 OK" is the pass. Every scenario that writes sits inside begin ... rollback, so the database
-- this leaves behind has 085, 171, 177 and 178 applied and holds no fixture rows.
--
-- Why it exists. 178's JS test (tests/migrations/178-retail-catalog-ticker-gate.test.ts) reads the SQL as text; this runs the SHIPPED
-- functions in PostgreSQL: that the baseline (177's body) attaches BIMAS to a BİM catalog story, that is_retail_catalog gives the
-- spec's truth table (the six TRUE rows, the six FALSE rows, the accepted miss, null and empty), that the resolver no longer attaches
-- BIMAS, MGROS or a code such as ARZUM to a catalog headline while a real story still attaches, that 177's stoplist gate is still in
-- the body, that applying 178 twice leaves one body per function, one ledger row and the grants service_role only, and the TIME
-- BUDGET: 10,000 predicate calls over mixed titles in under two seconds (the resolver runs once per inserted row under an 8 s
-- statement_timeout, 500 rows per ingest statement).
--
-- Order: the state 178 sits on is exactly 177's dry-run (171's dry-run, then 177 applied twice, every scenario checked); this
-- file runs it, shows the defect on 177's body, then applies 178 TWICE.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Prelude: 085, 171 and 177 as they will be in production (177's own dry-run, which ends clean). ----------------------------------
\ir 177-ticker-code-stoplist-gate-dryrun.sql

-- Fixture helpers (session-local). ----------------------------------------------------------------------------------------
create function pg_temp.co178(t text[], traded boolean) returns void language sql as
  $f$ insert into public.bist_companies (tickers, shares_traded) values (t, traded) $f$;
create function pg_temp.al178(a text, t text) returns void language sql as
  $f$ insert into public.bist_aliases (alias, ticker, origin) values (a, t, 'manual') $f$;
-- One article through the resolver: the tickers that attached, sorted and comma-joined ("-" for none).
create function pg_temp.tags178(p_title text, p_desc text, p_cat text) returns text language plpgsql as $f$
declare v_id uuid := gen_random_uuid(); r text;
begin
  insert into public.articles (id, title, description, category, published_at) values (v_id, p_title, p_desc, p_cat, now());
  perform public.resolve_article_tickers_for(array[v_id]);
  select coalesce(string_agg(ticker, ',' order by ticker), '-') into r from public.article_tickers where article_id = v_id;
  return r;
end $f$;
create function pg_temp.expect178(p_label text, p_got text, p_want text) returns void language plpgsql as $f$
begin
  if p_got is distinct from p_want then
    raise exception '178 scenario failed: % -> got %, want %', p_label, p_got, p_want;
  end if;
end $f$;
create function pg_temp.seed178() returns void language sql as $f$
  select pg_temp.co178(array['BIMAS'], true), pg_temp.co178(array['MGROS'], true), pg_temp.co178(array['SOKM'], true),
         pg_temp.co178(array['ARZUM'], true), pg_temp.co178(array['THYAO'], true), pg_temp.co178(array['DEVA'], true),
         pg_temp.co178(array['BEYAZ'], true),
         pg_temp.al178('bim', 'BIMAS'), pg_temp.al178('migros', 'MGROS'), pg_temp.al178('sok', 'SOKM') $f$;

-- Baseline: this is 177's resolver (pinned by the 177 test; md5 of its prosrc), the text 178 replaces. ---------------------------
do $$
declare v_md5 text; v_len integer;
begin
  select md5(prosrc), length(prosrc) into v_md5, v_len from pg_proc where oid = 'public.resolve_article_tickers_for(uuid[])'::regprocedure;
  if v_md5 <> 'e50fa9276a10825544bebac45493d81e' or v_len <> 3485 then
    raise exception '178 baseline is not 177''s body: md5 %, length %', v_md5, v_len;
  end if;
  if to_regprocedure('public.is_retail_catalog(text)') is not null then
    raise exception '178 baseline already has is_retail_catalog';
  end if;
end $$;

begin;
select pg_temp.seed178();
do $$
begin
  -- the defect: 177 attaches the retailer to its own weekly catalog
  perform pg_temp.expect178('baseline: 177 attaches BIMAS to a BİM catalog story',
    pg_temp.tags178('BİM 13 KASIM AKTÜEL ÜRÜNLER KATALOĞU', '', 'ekonomi'), 'BIMAS');
  perform pg_temp.expect178('baseline: 177 attaches BIMAS to a BİM promo story',
    pg_temp.tags178('BİM''E ALTUS HALI VE KOLTUK YIKAMA MAKİNESİ GELİYOR!', '', 'ekonomi'), 'BIMAS');
  perform pg_temp.expect178('baseline: 177 attaches ARZUM and SOKM to a Şok catalog headline',
    pg_temp.tags178('ŞOK’A ARZUM OKKA MINIO GO TÜRK KAHVE MAKİNESİ GELİYOR! (ŞOK 4-10 KASIM)', '', 'ekonomi'), 'ARZUM,SOKM');
end $$;
rollback;

-- Apply 178 TWICE: a re-apply changes nothing. ------------------------------------------------------------------------------
\ir ../../../supabase/migrations/178_retail_catalog_ticker_gate.sql
\ir ../../../supabase/migrations/178_retail_catalog_ticker_gate.sql

-- The new fingerprints and attributes, the grants and the ledger. --------------------------------------------------------------
do $$
declare r record;
begin
  select md5(prosrc) as m, prosecdef, provolatile, proconfig as cfg, pg_get_function_result(oid) as res
    into r from pg_proc where oid = 'public.resolve_article_tickers_for(uuid[])'::regprocedure;
  if r.m <> '70eaada3de06f8ccf4f54be6b81b3d20' or r.prosecdef or r.provolatile <> 'v'
     or r.cfg is distinct from array['search_path=""']::text[] or r.res <> 'integer' then
    raise exception '178 resolver fingerprint or attributes are not the shipped ones: %', r;
  end if;
  select md5(prosrc) as m, prosecdef, provolatile, proconfig as cfg, pg_get_function_result(oid) as res
    into r from pg_proc where oid = 'public.is_retail_catalog(text)'::regprocedure;
  if r.m <> 'db0f6637f447ef3f25d4efaf08494b86' or r.prosecdef or r.provolatile <> 'i'
     or r.cfg is distinct from array['search_path=""']::text[] or r.res <> 'boolean' then
    raise exception '178 predicate fingerprint or attributes are not the shipped ones: %', r;
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
        and proname in ('resolve_article_tickers_for', 'is_retail_catalog')) <> 2 then
    raise exception '178 left more than one body per function';
  end if;
  if has_function_privilege('anon', 'public.resolve_article_tickers_for(uuid[])', 'execute')
     or has_function_privilege('authenticated', 'public.resolve_article_tickers_for(uuid[])', 'execute')
     or not has_function_privilege('service_role', 'public.resolve_article_tickers_for(uuid[])', 'execute')
     or has_function_privilege('anon', 'public.is_retail_catalog(text)', 'execute')
     or has_function_privilege('authenticated', 'public.is_retail_catalog(text)', 'execute')
     or not has_function_privilege('service_role', 'public.is_retail_catalog(text)', 'execute') then
    raise exception '178 grants are not service_role only';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '178') <> 1 then
    raise exception '178 ledger row is not exactly one after two applications';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '177') <> 1 then
    raise exception '177 ledger row is not exactly one';
  end if;
end $$;

-- The truth table: the spec's six TRUE rows, its six FALSE rows, the accepted miss, null and empty. -------------------------------
do $$
declare r record; n integer := 0;
begin
  for r in
    select * from (values
      ('BİM 13 KASIM AKTÜEL ÜRÜNLER KATALOĞU', true),
      ('BUGÜN SATIŞTA! BİM''E 3 ÇEKMECELİ DERİN DONDURUCU GELİYOR! (BİM 8-14 KASIM)', true),
      ('BİM 8 Kasım 2026 Pazar Aktüel Ürünler Kataloğu Yayımda!', true),
      ('BİM 11 KASIM ÇARŞAMBA İNDİRİM KATALOĞU YAYINLANDI!', true),
      ('Bim aktüel ürünler kataloğu yayınlandı!', true),
      ('BİM''E ALTUS HALI VE KOLTUK YIKAMA MAKİNESİ GELİYOR!', true),
      ('BİM, 250 bin lira sermayeli teknoloji şirketi kurdu', false),
      ('BİM''den büyük atak. Şube sayısını katladı A101 ile farkı kapattı!', false),
      ('BofA''nın haftalık bilançosu: Bankaları aldı, BİM''i sattı', false),
      ('29 Ekim zincir marketler açık mı? 29 Ekim Cumhuriyet Bayramı BİM, A101, ŞOK market çalışma saatleri', false),
      ('THY, 7 milyar doları aştı', false),
      ('33 şirketin temettü takvimi açıklandı', false),
      ('MONSTER OYUN BİLGİSAYARLARI 49.990 TL''DEN BAŞLAYAN FİYATLARLA BİM''DE!', false),
      ('MONSTER OYUN BİLGİSAYARLARI 49.990 TL''DEN BAŞLAYAN FİYATLARLA BİM''DE! (BİM 11-17 KASIM)', true),
      ('BİM''DE BU ÜRÜNLER RESMEN KAPIŞILACAK! YENİ İNDİRİM LİSTESİ AÇIKLANDI! (BİM 27 EKİM 2 KASIM)', true),
      ('Migros 1 alana 1 bedava kampanyası ne zaman? Migros 10-18 Ekim 2026 indirimli ürünler', true),
      ('ŞOK’A YENİ TV GELİYOR', true),
      ('CarrefourSA''YA gofret makinesi GELİYOR', true),
      ('Bimbo aktüel ürünler kataloğu', false),
      ('Migros 13 Kasım 2026 tarihinde genel kurul toplantısı yapacak', false),
      ('BİM 5 Kasım''da bilançosunu açıklayacak', false),
      ('', false),
      ('   ', false),
      ('🛒 BİM aktüel ürünler kataloğu 🛒', true)
    ) v(t, want)
  loop
    n := n + 1;
    if public.is_retail_catalog(r.t) is distinct from r.want then
      raise exception '178 is_retail_catalog(%) = %, want %', r.t, public.is_retail_catalog(r.t), r.want;
    end if;
  end loop;
  if public.is_retail_catalog(null) is distinct from false then
    raise exception '178 is_retail_catalog(null) must be false, not null';
  end if;
  raise notice '178: % truth-table rows ok', n;
end $$;

-- Scenarios on the shipped resolver, each article in its own rolled-back transaction. ---------------------------------------
begin;
select pg_temp.seed178();
do $$
begin
  -- the catalog and promo stories leave the resolver whole: the alias path and the code path alike
  perform pg_temp.expect178('BİM catalog gets no BIMAS', pg_temp.tags178('BİM 13 KASIM AKTÜEL ÜRÜNLER KATALOĞU', '', 'ekonomi'), '-');
  perform pg_temp.expect178('BİM promo gets no BIMAS',
    pg_temp.tags178('BİM''E ALTUS HALI VE KOLTUK YIKAMA MAKİNESİ GELİYOR!', '', 'ekonomi'), '-');
  perform pg_temp.expect178('Şok catalog gets neither ARZUM (code) nor SOKM (alias)',
    pg_temp.tags178('ŞOK’A ARZUM OKKA MINIO GO TÜRK KAHVE MAKİNESİ GELİYOR! (ŞOK 4-10 KASIM)', '', 'ekonomi'), '-');
  perform pg_temp.expect178('Migros campaign gets no MGROS',
    pg_temp.tags178('Migros 1 alana 1 bedava kampanyası ne zaman? Migros 10-18 Ekim 2026 indirimli ürünler', '', 'ekonomi'), '-');
  perform pg_temp.expect178('the catalog gate does not read the category', pg_temp.tags178('BİM 13 KASIM AKTÜEL ÜRÜNLER KATALOĞU', '', 'genel'), '-');
  -- real stories still attach
  perform pg_temp.expect178('real BİM story', pg_temp.tags178('BİM, 250 bin lira sermayeli teknoloji şirketi kurdu', '', 'ekonomi'), 'BIMAS');
  perform pg_temp.expect178('BofA story naming BİM', pg_temp.tags178('BofA''nın haftalık bilançosu: Bankaları aldı, BİM''i sattı', '', 'ekonomi'), 'BIMAS');
  perform pg_temp.expect178('Migros results', pg_temp.tags178('Migros''un üçüncü çeyrek net karı yüzde 12 arttı', '', 'ekonomi'), 'MGROS');
  perform pg_temp.expect178('ARZUM by code', pg_temp.tags178('ARZUM hisseleri yükseldi', '', 'ekonomi'), 'ARZUM');
  perform pg_temp.expect178('real BİM story in genel', pg_temp.tags178('BİM, 250 bin lira sermayeli teknoloji şirketi kurdu', '', 'genel'), 'BIMAS');
  -- the gate reads the title only
  perform pg_temp.expect178('catalog words in the description do not exclude a real story',
    pg_temp.tags178('BİM yeni şirket kurdu', 'BİM aktüel ürünler kataloğu bu hafta yayımlandı', 'ekonomi'), 'BIMAS');
  -- 177's stoplist gate is still in the body
  perform pg_temp.expect178('177: Babacan story gets no DEVA',
    pg_temp.tags178('Babacan: Kayıp 173 milyar doları geçti', 'DEVA Partisi Genel Başkanı Ali Babacan', 'ekonomi'), '-');
  perform pg_temp.expect178('177: DEVA hisseleri', pg_temp.tags178('DEVA hisseleri yüzde 5 yükseldi', '', 'ekonomi'), 'DEVA');
  perform pg_temp.expect178('177: BEYAZ EŞYA catalog', pg_temp.tags178('BİM KATALOĞU: BEYAZ EŞYA fırsatları', '', 'ekonomi'), '-');
  perform pg_temp.expect178('THYAO hisseleri', pg_temp.tags178('THYAO hisseleri', '', 'ekonomi'), 'THYAO');
  -- an article id that does not exist: nothing, no error
  perform pg_temp.expect178('unknown id', public.resolve_article_tickers_for(array[gen_random_uuid()])::text, '0');
end $$;
rollback;

-- TIME BUDGET: 10,000 predicate calls over mixed titles (half of them catalogs) in under two seconds. -------------------------------
do $$
declare v_t0 timestamptz; v_ms numeric; v_hits integer;
begin
  perform public.is_retail_catalog('warm-up');  -- compiles the SQL function, not timed
  v_t0 := clock_timestamp();
  select count(*) into v_hits
    from generate_series(1, 10000) g
   where public.is_retail_catalog(case g % 4
           when 0 then 'BİM ' || g || ' KASIM AKTÜEL ÜRÜNLER KATALOĞU'
           when 1 then 'Borsa güne yatay başladı, ' || g || ' puan yükseldi, yabancı payı arttı'
           when 2 then 'BİM''E ' || g || ' ÇEKMECELİ DERİN DONDURUCU GELİYOR! (BİM 8-14 KASIM)'
           else 'THY, ' || g || ' milyar doları aştı' end);
  v_ms := extract(epoch from clock_timestamp() - v_t0) * 1000;
  if v_hits <> 5000 then raise exception '178 time-budget titles: expected 5000 catalog rows, got %', v_hits; end if;
  if v_ms > 2000 then
    raise exception '178 is_retail_catalog took % ms for 10,000 calls (budget 2000 ms)', round(v_ms, 1);
  end if;
  raise notice '178: time budget ok, % ms for 10,000 calls', round(v_ms, 1);
end $$;

-- Nothing was left behind by the scenarios above. ------------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from public.bist_aliases) or exists (select 1 from public.bist_companies)
     or exists (select 1 from public.articles) or exists (select 1 from public.article_tickers) then
    raise exception 'a rolled-back fixture survived';
  end if;
end $$;

select 'DRYRUN 178 OK';
