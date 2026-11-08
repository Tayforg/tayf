-- 177 ticker_code_stoplist_gate (resolve_article_tickers_for: a stoplisted code needs '(CODE)' or a company cue, the bare
-- category 'ekonomi' branch is gone): local PG15 dry-run. Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55572 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55572 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/177-ticker-code-stoplist-gate-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql PGHOST=/tmp PGPORT=55572 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/177-ticker-code-stoplist-gate)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh    (TAYF_LIVE_ONLY=177 runs just this one)
--
-- (\ir paths below are relative to this file.) Every check is a DO block or a pg_temp function that raises on mismatch, so a
-- clean run ending in "DRYRUN 177 OK" is the pass. Every scenario that writes sits inside begin ... rollback, so the database
-- this leaves behind has 085, 171 and 177 applied and holds no fixture rows.
--
-- Why it exists. 177's JS test (tests/migrations/177-ticker-code-stoplist-gate.test.ts) reads the SQL as text; this runs the
-- SHIPPED function in PostgreSQL: that the baseline (production's 171 body, md5 pinned) attaches DEVA to a Babacan story filed
-- under ekonomi, that 177 does not, that the company's own stories (the explicit code in brackets, a cue right after the code)
-- still attach, that the other stoplisted words (BEYAZ, ATLAS, KONYA) follow the same rule, that a non-stoplisted ticker is
-- untouched in every category, and that applying 177 twice leaves one body, one ledger row and the grants service_role only.
--
-- Order: the state 177 sits on is exactly 171's dry-run (bist_aliases, 049's fold, 062's finance regex, 085 as production has
-- it, then 171 twice, with every 171 scenario checked); this file runs it, shows the defect on 171's body, then applies 177 TWICE.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Prelude: 085 and 171 as production has them (171's own dry-run, which ends clean). -----------------------------------------
\ir 171-ticker-alias-siblings-dryrun.sql

-- Fixture helpers (session-local). ----------------------------------------------------------------------------------------
create function pg_temp.co177(t text[], traded boolean) returns void language sql as
  $f$ insert into public.bist_companies (tickers, shares_traded) values (t, traded) $f$;
-- One article through the resolver: the tickers that attached, sorted and comma-joined ("-" for none).
create function pg_temp.tags177(p_title text, p_desc text, p_cat text) returns text language plpgsql as $f$
declare v_id uuid := gen_random_uuid(); r text;
begin
  insert into public.articles (id, title, description, category, published_at) values (v_id, p_title, p_desc, p_cat, now());
  perform public.resolve_article_tickers_for(array[v_id]);
  select coalesce(string_agg(ticker, ',' order by ticker), '-') into r from public.article_tickers where article_id = v_id;
  return r;
end $f$;
create function pg_temp.expect177(p_label text, p_got text, p_want text) returns void language plpgsql as $f$
begin
  if p_got is distinct from p_want then
    raise exception '177 scenario failed: % -> got %, want %', p_label, p_got, p_want;
  end if;
end $f$;

-- Baseline: production's resolver is 171's body (md5(prosrc) read on production on 2026-11-08). -----------------------------
do $$
declare v_md5 text; v_len integer;
begin
  select md5(prosrc), length(prosrc) into v_md5, v_len from pg_proc where oid = 'public.resolve_article_tickers_for(uuid[])'::regprocedure;
  if v_md5 <> '999a286fb58e46bf1958b78dfedcad98' or v_len <> 3401 then
    raise exception '177 baseline is not production''s 171 body: md5 %, length %', v_md5, v_len;
  end if;
end $$;

begin;
select pg_temp.co177(array['DEVA'], true), pg_temp.co177(array['BEYAZ'], true), pg_temp.co177(array['ATLAS'], true),
       pg_temp.co177(array['KONYA'], true), pg_temp.co177(array['THYAO'], true);
do $$
begin
  -- the defect: 171 lets the stoplisted DEVA through for any ekonomi story
  perform pg_temp.expect177('baseline: 171 attaches DEVA to a Babacan story filed under ekonomi',
    pg_temp.tags177('Babacan: Kayıp 173 milyar doları geçti', 'DEVA Partisi Genel Başkanı Ali Babacan', 'ekonomi'), 'DEVA');
  perform pg_temp.expect177('baseline: 171 attaches BEYAZ to a catalog story filed under ekonomi',
    pg_temp.tags177('BİM KATALOĞU: BEYAZ EŞYA fırsatları', '', 'ekonomi'), 'BEYAZ');
end $$;
rollback;

-- Apply 177 TWICE: a re-apply changes nothing. ------------------------------------------------------------------------------
\ir ../../../supabase/migrations/177_ticker_code_stoplist_gate.sql
\ir ../../../supabase/migrations/177_ticker_code_stoplist_gate.sql

-- The new fingerprint and attributes, the grants and the ledger. ---------------------------------------------------------------
do $$
declare r record;
begin
  select md5(prosrc) as m, prosecdef, provolatile, proconfig as cfg, pg_get_function_result(oid) as res
    into r from pg_proc where oid = 'public.resolve_article_tickers_for(uuid[])'::regprocedure;
  if r.m <> 'e50fa9276a10825544bebac45493d81e' or r.prosecdef or r.provolatile <> 'v' or r.cfg is distinct from array['search_path=""']::text[] or r.res <> 'integer' then
    raise exception '177 fingerprint or attributes are not the shipped ones: %', r;
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'resolve_article_tickers_for') <> 1 then
    raise exception '177 left more than one resolve_article_tickers_for';
  end if;
  if has_function_privilege('anon', 'public.resolve_article_tickers_for(uuid[])', 'execute')
     or has_function_privilege('authenticated', 'public.resolve_article_tickers_for(uuid[])', 'execute')
     or not has_function_privilege('service_role', 'public.resolve_article_tickers_for(uuid[])', 'execute') then
    raise exception '177 grants are not service_role only';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '177') <> 1 then
    raise exception '177 ledger row is not exactly one after two applications';
  end if;
  if public.ticker_code_stoplist() <> array['DEVA','BEYAZ','ATLAS','KONYA']::text[] then
    raise exception '177 changed the stoplist';
  end if;
end $$;

-- Scenarios on the shipped function, each article in its own rolled-back transaction. ---------------------------------------
begin;
select pg_temp.co177(array['DEVA'], true), pg_temp.co177(array['BEYAZ'], true), pg_temp.co177(array['ATLAS'], true),
       pg_temp.co177(array['KONYA'], true), pg_temp.co177(array['THYAO'], true), pg_temp.co177(array['ASELS'], true);
do $$
begin
  -- the spec's five rows, every one category ekonomi
  perform pg_temp.expect177('Babacan story gets no DEVA',
    pg_temp.tags177('Babacan: Kayıp 173 milyar doları geçti', 'DEVA Partisi Genel Başkanı Ali Babacan', 'ekonomi'), '-');
  perform pg_temp.expect177('Deva Holding (DEVA) bilanço gets DEVA',
    pg_temp.tags177('Deva Holding (DEVA) 3. çeyrek bilançosunu açıkladı', '', 'ekonomi'), 'DEVA');
  perform pg_temp.expect177('DEVA hisseleri gets DEVA',
    pg_temp.tags177('DEVA hisseleri yüzde 5 yükseldi', '', 'ekonomi'), 'DEVA');
  perform pg_temp.expect177('catalog BEYAZ EŞYA gets no BEYAZ',
    pg_temp.tags177('BİM KATALOĞU: BEYAZ EŞYA fırsatları', '', 'ekonomi'), '-');
  perform pg_temp.expect177('THYAO hisseleri gets THYAO',
    pg_temp.tags177('THYAO hisseleri', '', 'ekonomi'), 'THYAO');
  -- more cues, and the Turkish suffixes after the cue word
  perform pg_temp.expect177('DEVA Holding cue', pg_temp.tags177('DEVA Holding''in net karı arttı', '', 'ekonomi'), 'DEVA');
  perform pg_temp.expect177('DEVA bilanço cue with a suffix', pg_temp.tags177('DEVA bilançosu beklentiyi aştı', '', 'ekonomi'), 'DEVA');
  perform pg_temp.expect177('DEVA hissesinde cue with a suffix', pg_temp.tags177('DEVA hissesinde sert düşüş', '', 'ekonomi'), 'DEVA');
  perform pg_temp.expect177('ATLAS hisseleri cue', pg_temp.tags177('ATLAS hisseleri borsada işlem görmeye başladı', '', 'ekonomi'), 'ATLAS');
  perform pg_temp.expect177('ATLAS Okyanusu gets no ATLAS', pg_temp.tags177('ATLAS Okyanusu''nda fırtına', '', 'ekonomi'), '-');
  perform pg_temp.expect177('KONYA Büyükşehir gets no KONYA', pg_temp.tags177('KONYA Büyükşehir yeni hat açtı', '', 'ekonomi'), '-');
  perform pg_temp.expect177('explicit (KONYA) gets KONYA', pg_temp.tags177('Fabrika açılışı (KONYA) tamam', '', 'ekonomi'), 'KONYA');
  perform pg_temp.expect177('the code in the description counts', pg_temp.tags177('Şirket haberi', 'Deva Holding (DEVA) açıkladı', 'ekonomi'), 'DEVA');
  -- a possessive suffix after the code is not a cue (the documented limit)
  perform pg_temp.expect177('DEVA''nın bilançosu needs (DEVA)', pg_temp.tags177('DEVA''nın bilançosu açıklandı', '', 'ekonomi'), '-');
  -- not stoplisted: unchanged, whatever the category
  perform pg_temp.expect177('ASELS in ekonomi', pg_temp.tags177('ASELS ihracatta rekor', '', 'ekonomi'), 'ASELS');
  perform pg_temp.expect177('ASELS in genel', pg_temp.tags177('ASELS ihracatta rekor', '', 'genel'), 'ASELS');
  perform pg_temp.expect177('THYAO next to the party', pg_temp.tags177('THYAO ve DEVA Partisi birlikte anıldı', '', 'ekonomi'), 'THYAO');
  -- other categories: the stoplist was already in force there; the cue and (DEVA) still pass
  perform pg_temp.expect177('politika party story', pg_temp.tags177('DEVA Partisi kongre yaptı', '', 'politika'), '-');
  perform pg_temp.expect177('politika explicit code', pg_temp.tags177('Genel Başkan (DEVA) açıklama yaptı', '', 'politika'), 'DEVA');
  perform pg_temp.expect177('genel with a cue', pg_temp.tags177('DEVA hisseleri yükseldi', '', 'genel'), 'DEVA');
  -- edges: lower-case code (no match at all), null description, curly apostrophe, emoji
  perform pg_temp.expect177('lower-case deva is no code', pg_temp.tags177('deva hisseleri yükseldi', '', 'ekonomi'), '-');
  perform pg_temp.expect177('null description', pg_temp.tags177('DEVA hisseleri', null, 'ekonomi'), 'DEVA');
  perform pg_temp.expect177('quotes and emoji around the code', pg_temp.tags177('“DEVA” Partisi açıklaması 🚀', '', 'ekonomi'), '-');
  perform pg_temp.expect177('curly apostrophe after the code', pg_temp.tags177('DEVA’nın hisseleri', '', 'ekonomi'), '-');
end $$;
rollback;

-- Nothing was left behind by the scenarios above. ------------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from public.bist_aliases) or exists (select 1 from public.bist_companies)
     or exists (select 1 from public.articles) or exists (select 1 from public.article_tickers) then
    raise exception 'a rolled-back fixture survived';
  end if;
end $$;

select 'DRYRUN 177 OK';
