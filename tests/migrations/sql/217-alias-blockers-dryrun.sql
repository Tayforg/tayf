-- 217 alias_blockers (public.bist_alias_blocks, two manual aliases, and resolve_article_tickers_for stops attaching a brand's ticker to a
-- text that names a different company by a longer phrase beginning with the same brand word): local PG15 dry-run. Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55574 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55574 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/217-alias-blockers-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql PGHOST=/tmp PGPORT=55574 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/217-alias-blockers)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh    (TAYF_LIVE_ONLY=217 runs just this one)
--
-- (\ir paths below are relative to this file.) Every check is a DO block or a pg_temp function that raises on mismatch, so a clean run
-- ending in "DRYRUN 217 OK" is the pass. Every scenario that writes sits inside begin ... rollback, so the database this leaves behind has
-- 085, 171, 177, 178 and 217 applied and holds no fixture row: only 217's own three bist_alias_blocks rows and two manual bist_aliases rows.
--
-- Why it exists. 217's JS test (tests/migrations/217-alias-blockers.test.ts) reads the SQL as text; this runs the SHIPPED function in
-- PostgreSQL: that the baseline (178's body, production's, md5 pinned) attaches KRDMD to the SPK story that names Kardemir Çelik, SMRVA to a
-- Sümer Holding story and TURSG to a Türkiye Sigorta Birliği story; that after 217 the SPK story gives EDATA, KARCL and GRTHO (never KRDMD,
-- KRDMA or KRDMB), a Kardemir Karabük Demir Çelik text still gives KRDMD, a Sümer Holding text gives no SMRVA while a Sümer Varlık text gives
-- SMRVA, a Türkiye Sigorta Birliği text gives no TURSG while a Türkiye Sigorta text gives TURSG and a text that also writes (TURSG) still gives
-- it through code_hits; that a copy of 178's function and 217's agree on every headline except the blocked pairs; that the table is RLS-on with
-- no policy and readable by service_role only; that applying 217 twice leaves one body, one ledger row, three blocks and two alias rows; and the
-- TIME BUDGET: 171's (one article that matches nothing against 2,000 shared untraded auto aliases and 2,000 companies, under 50 ms) with
-- bist_alias_blocks present, plus an article that DOES match the blocked alias (the rule fires on it) under the same 50 ms.
--
-- Order: the state 217 sits on is exactly 178's dry-run (177's, which runs 171's: the alias table of 049 with 052's enabled column, 049's fold,
-- 062's finance regex, 085 from its own file, then 171, 177 and 178 each applied twice, every scenario of theirs checked); this file runs it,
-- shows the defect on 178's body, then applies 217 TWICE.
--
-- READ-ONLY REPLAY (production, `sbq.py -e`, 2026-11-15 11:00Z and again 11:50Z; the rows the new function would not have written over 30 days;
-- KRDMD 10 rows (10 counted), SMRVA 4 (4), TURSG 60 (7)):
-- with b(alias, phrase) as (values ('kardemir','kardemir celik'),('sumer','sumer holding'),('turkiye sigorta','turkiye sigorta birligi'))
-- select b.alias, t.ticker, count(*) rows_30d, count(*) filter (where coalesce(p.jev_prob,1) >= 0.5) counted
-- from b join article_tickers t on t.matched_on = 'alias:'||b.alias
-- join articles a on a.id = t.article_id
-- left join jev_shadow_predictions p on p.subject_id = t.article_id::text||':'||t.ticker and p.task = 'ticker_relevance'
-- where a.published_at > now() - interval '30 days'
--   and strpos(' '||public.fold_tr(a.title||' '||coalesce(a.description,''))||' ', ' '||b.phrase||' ') > 0
-- group by 1,2;
-- The full per-ticker replay (the new resolver logic inlined as ONE read-only SELECT over the finance-category articles of 30 days, old and new
-- side by side, in 3-day slices under the roughly 8 s statement timeout): take 178's body and 217's body from their files, replace `a.id = any (p_ids)`
-- in `recent` with a published_at window and `a.category = 'ekonomi'`, replace `public.bist_alias_blocks` with the three seed rows as a VALUES list and
-- the alias join with bist_aliases plus the two new manual rows, end each chain with `select distinct on (article_id, ticker) article_id, ticker,
-- matched_on from hits`, and full-join the two result sets on (article_id, ticker): a pair in one side only is a removed or an added match.
--
-- FOUNDER-ONLY, NOT RUN BY THIS SCRIPT, NOT PART OF THE PR. Optional cleanup of the rows the old resolver wrote for the 8-day window the /ekonomi tape
-- reads (a data rewrite of article_tickers; 217 only stops new rows, the rest age out of the tape's window by themselves). Run it by hand on production
-- inside a transaction, read the three counts, then commit or roll back:
-- begin;
-- create temp table h198_fix as
--   select t.article_id, t.ticker, t.matched_on from public.article_tickers t join public.articles a on a.id = t.article_id
--   join (values ('alias:kardemir','kardemir celik'),('alias:sumer','sumer holding'),('alias:turkiye sigorta','turkiye sigorta birligi')) b(matched_on, phrase)
--     on b.matched_on = t.matched_on
--   where a.published_at > now() - interval '8 days'
--     and strpos(' ' || public.fold_tr(a.title || ' ' || coalesce(a.description, '')) || ' ', ' ' || b.phrase || ' ') > 0;
-- select ticker, count(*) from h198_fix group by 1;
-- delete from public.article_tickers t using h198_fix f where t.article_id = f.article_id and t.ticker = f.ticker and t.matched_on = f.matched_on;
-- select public.resolve_article_tickers_for(array(select distinct article_id from h198_fix));
-- select ticker, count(*) from public.article_tickers where article_id in (select article_id from h198_fix) group by 1;
-- rollback;  -- or commit;

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Prelude: 085, 171, 177 and 178 as production has them (178's own dry-run, which ends clean). ------------------------------------
\ir 178-retail-catalog-ticker-gate-dryrun.sql

-- Fixture helpers (session-local). ----------------------------------------------------------------------------------------
create function pg_temp.co217(t text[], traded boolean) returns void language sql as
  $f$ insert into public.bist_companies (tickers, shares_traded) values (t, traded) $f$;
create function pg_temp.al217(a text, t text, o text) returns void language sql as
  $f$ insert into public.bist_aliases (alias, ticker, origin) values (a, t, o) $f$;
-- One article through the resolver: "ticker:matched_on" pairs, sorted by ticker and comma-joined ("-" for none).
create function pg_temp.tags217(p_title text, p_desc text, p_cat text) returns text language plpgsql as $f$
declare v_id uuid := gen_random_uuid(); r text;
begin
  insert into public.articles (id, title, description, category, published_at) values (v_id, p_title, p_desc, p_cat, now());
  perform public.resolve_article_tickers_for(array[v_id]);
  select coalesce(string_agg(ticker || ':' || matched_on, ',' order by ticker), '-') into r from public.article_tickers where article_id = v_id;
  return r;
end $f$;
-- The same through the session copy of 178's function (created below).
create function pg_temp.tags217_old(p_title text, p_desc text, p_cat text) returns text language plpgsql as $f$
declare v_id uuid := gen_random_uuid(); r text;
begin
  insert into public.articles (id, title, description, category, published_at) values (v_id, p_title, p_desc, p_cat, now());
  perform pg_temp.resolve_article_tickers_178(array[v_id]);
  select coalesce(string_agg(ticker || ':' || matched_on, ',' order by ticker), '-') into r from public.article_tickers where article_id = v_id;
  return r;
end $f$;
create function pg_temp.expect217(p_label text, p_got text, p_want text) returns void language plpgsql as $f$
begin
  if p_got is distinct from p_want then
    raise exception '217 scenario failed: % -> got %, want %', p_label, p_got, p_want;
  end if;
end $f$;
-- Production's rows for the aliases of the report (read-only, 2026-11-15). The two NEW aliases are not here: 217 inserts them.
-- shares_traded is true for every company except SMRFA (SÜMER FAKTORİNG, untraded as in production: rule B drops it next to the traded SMRVA).
create function pg_temp.seed217() returns void language sql as $f$
  select pg_temp.al217('kardemir', 'KRDMD', 'manual'), pg_temp.al217('kardemir', 'KRDMA', 'auto'), pg_temp.al217('kardemir', 'KRDMB', 'auto'),
         pg_temp.al217('kardemir', 'KARCL', 'auto'), pg_temp.al217('sumer', 'SMRVA', 'auto'), pg_temp.al217('sumer', 'SMRFA', 'auto'),
         pg_temp.al217('turkiye sigorta', 'TURSG', 'manual'), pg_temp.al217('grainturk', 'GRTHO', 'auto'),
         pg_temp.co217(array['KRDMA', 'KRDMB', 'KRDMD'], true), pg_temp.co217(array['KARCL'], true), pg_temp.co217(array['EDATA'], true),
         pg_temp.co217(array['SMRVA'], true), pg_temp.co217(array['SMRFA'], false), pg_temp.co217(array['TURSG'], true),
         pg_temp.co217(array['GRTHO'], true) $f$;

-- Baseline: this is 178's resolver (production's, md5(prosrc) read on production on 2026-11-15), the text 217 replaces. ------------
do $$
declare v_md5 text; v_len integer;
begin
  select md5(prosrc), length(prosrc) into v_md5, v_len from pg_proc where oid = 'public.resolve_article_tickers_for(uuid[])'::regprocedure;
  if v_md5 <> '70eaada3de06f8ccf4f54be6b81b3d20' or v_len <> 3533 then
    raise exception '217 baseline is not 178''s body (production''s): md5 %, length %', v_md5, v_len;
  end if;
  if to_regclass('public.bist_alias_blocks') is not null then
    raise exception '217 baseline already has bist_alias_blocks';
  end if;
  if exists (select 1 from supabase_migrations.schema_migrations where version = '217') then
    raise exception '217 baseline: 217 is already in the ledger';
  end if;
  if exists (select 1 from public.bist_aliases) then
    raise exception '217 baseline: bist_aliases is not empty';
  end if;
end $$;

-- A copy of 178's function under a session-local name, for the differential below (the original is replaced by 217).
select replace(pg_get_functiondef('public.resolve_article_tickers_for(uuid[])'::regprocedure),
               'public.resolve_article_tickers_for', 'pg_temp.resolve_article_tickers_178') as def \gset
:def
;

-- The defect, on the old function: the longer name attaches the brand's ticker. ---------------------------------------------------
begin;
select pg_temp.seed217();
do $$
begin
  perform pg_temp.expect217('baseline: 178 attaches KRDMD to the SPK story that names Kardemir Çelik',
    pg_temp.tags217('SPK''dan üç şirketin işlemleriyle ilgili suç duyurusu',
      'Sermaye Piyasası Kurulu (SPK), E-Data Teknoloji, Kardemir Çelik ve Graintürk Holding paylarındaki işlemlere ilişkin incelemeler sonucunda suç duyurusunda bulunulmasına karar verdi.',
      'ekonomi'),
    'GRTHO:alias:grainturk,KRDMD:alias:kardemir');
  perform pg_temp.expect217('baseline: 178 attaches SMRVA to a Sümer Holding story',
    pg_temp.tags217('Sümer Holding''e ait üç ildeki 7 taşınmaz özelleştirilecek', '', 'ekonomi'), 'SMRVA:alias:sumer');
  perform pg_temp.expect217('baseline: 178 attaches TURSG to a Türkiye Sigorta Birliği story',
    pg_temp.tags217('Türkiye Sigorta Birliği (TSB) sel uyarısı yaptı', '', 'ekonomi'), 'TURSG:alias:turkiye sigorta');
end $$;
rollback;

-- Apply 217 TWICE: a re-apply changes nothing. -------------------------------------------------------------------------------------
\ir ../../../supabase/migrations/217_alias_blockers.sql
create temp table after_217_first as
  select md5(prosrc) as m, proacl::text as acl, (select count(*) from public.bist_alias_blocks) as nb, (select count(*) from public.bist_aliases) as na
    from pg_proc where oid = 'public.resolve_article_tickers_for(uuid[])'::regprocedure;
\ir ../../../supabase/migrations/217_alias_blockers.sql

-- 1. The new fingerprint and attributes, the grants, the ledger, the table. -----------------------------------------------------------
do $$
declare r record; f record; v_con text;
begin
  select md5(prosrc) as m, length(prosrc) as len, prosecdef, provolatile, proconfig as cfg, pg_get_function_result(oid) as res,
         pg_get_function_arguments(oid) as args, proacl::text as acl
    into r from pg_proc where oid = 'public.resolve_article_tickers_for(uuid[])'::regprocedure;
  if r.m <> 'fd6429df30125e201fe28278c606c53e' or r.len <> 3693 then
    raise exception '217 resolver fingerprint is not the shipped one: md5 %, length %', r.m, r.len;
  end if;
  if r.prosecdef or r.provolatile <> 'v' or r.cfg is distinct from array['search_path=""']::text[] or r.res <> 'integer' or r.args <> 'p_ids uuid[]' then
    raise exception '217 resolver attributes are not the shipped ones: %', r;
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'resolve_article_tickers_for') <> 1 then
    raise exception '217 left more than one resolve_article_tickers_for';
  end if;
  if has_function_privilege('anon', 'public.resolve_article_tickers_for(uuid[])', 'execute')
     or has_function_privilege('authenticated', 'public.resolve_article_tickers_for(uuid[])', 'execute')
     or not has_function_privilege('service_role', 'public.resolve_article_tickers_for(uuid[])', 'execute') then
    raise exception '217 execute privileges are not service_role only';
  end if;
  -- the second apply left the first apply's result
  select * into f from after_217_first;
  if f.m <> r.m or f.acl is distinct from r.acl or f.nb <> 3 or f.na <> 2
     or (select count(*) from public.bist_alias_blocks) <> 3 or (select count(*) from public.bist_aliases) <> 2 then
    raise exception '217: the second apply changed something (blocks %, aliases %)', f.nb, f.na;
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '217') <> 1
     or (select name from supabase_migrations.schema_migrations where version = '217') <> '217_alias_blockers'
     or (select count(*) from supabase_migrations.schema_migrations where version = '178') <> 1 then
    raise exception '217: the ledger rows are not one 217_alias_blockers row and 178''s row';
  end if;
  -- the table: two not-null text columns, primary key (alias, phrase), RLS on, no policy, nothing for anon / authenticated / public
  if (select string_agg(attname || ':' || format_type(atttypid, atttypmod) || ':' || attnotnull, ',' order by attnum)
        from pg_attribute where attrelid = 'public.bist_alias_blocks'::regclass and attnum > 0 and not attisdropped) <> 'alias:text:true,phrase:text:true' then
    raise exception '217: bist_alias_blocks columns are not (alias text not null, phrase text not null)';
  end if;
  if (select string_agg(a.attname, ',' order by k.ord) from pg_index i
        cross join lateral unnest(i.indkey) with ordinality k(attnum, ord)
        join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
       where i.indrelid = 'public.bist_alias_blocks'::regclass and i.indisprimary) is distinct from 'alias,phrase' then
    raise exception '217: the primary key is not (alias, phrase)';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.bist_alias_blocks'::regclass)
     or exists (select 1 from pg_policy where polrelid = 'public.bist_alias_blocks'::regclass) then
    raise exception '217: bist_alias_blocks must have RLS enabled and no policy';
  end if;
  if exists (select 1 from unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) p
              where has_table_privilege('anon', 'public.bist_alias_blocks', p) or has_table_privilege('authenticated', 'public.bist_alias_blocks', p))
     or not has_table_privilege('service_role', 'public.bist_alias_blocks', 'select')
     or exists (select 1 from aclexplode((select relacl from pg_class where oid = 'public.bist_alias_blocks'::regclass)) where grantee = 0) then
    raise exception '217: bist_alias_blocks privileges are not select for service_role only';
  end if;
  -- the three seed rows and the two manual aliases, and nothing else
  if (select string_agg(alias || '|' || phrase, ',' order by alias) from public.bist_alias_blocks)
     is distinct from 'kardemir|kardemir celik,sumer|sumer holding,turkiye sigorta|turkiye sigorta birligi' then
    raise exception '217: the seed rows are not the three pinned pairs';
  end if;
  if exists (select 1 from public.bist_alias_blocks where public.fold_tr(phrase) <> phrase or public.fold_tr(alias) <> alias or strpos(phrase, alias || ' ') <> 1) then
    raise exception '217: a seeded phrase is not in fold_tr form or does not start with its alias';
  end if;
  -- the CHECK bist_alias_blocks_folded refuses a row that is not in fold_tr form (each probe runs in its own sub-block: the failed insert is rolled back, no row is written)
  begin
    insert into public.bist_alias_blocks (alias, phrase) values ('turkiye sigorta', 'Türkiye Sigorta Birliğinden');
    raise exception '217: bist_alias_blocks accepted the unfolded phrase ''Türkiye Sigorta Birliğinden''';
  exception when check_violation then
    get stacked diagnostics v_con = constraint_name;
    if v_con is distinct from 'bist_alias_blocks_folded' then
      raise exception '217: the unfolded phrase was refused by % and not by bist_alias_blocks_folded', v_con;
    end if;
  end;
  begin
    insert into public.bist_alias_blocks (alias, phrase) values ('Kardemir', 'kardemir celik');
    raise exception '217: bist_alias_blocks accepted the unfolded alias ''Kardemir''';
  exception when check_violation then
    get stacked diagnostics v_con = constraint_name;
    if v_con is distinct from 'bist_alias_blocks_folded' then
      raise exception '217: the unfolded alias was refused by % and not by bist_alias_blocks_folded', v_con;
    end if;
  end;
  begin
    insert into public.bist_alias_blocks (alias, phrase) values ('turkiye sigorta', 'turkiye  sigorta birliginden');
    raise exception '217: bist_alias_blocks accepted a phrase with a doubled space';
  exception when check_violation then
    null;
  end;
  if (select count(*) from public.bist_alias_blocks) <> 3 then
    raise exception '217: a refused insert left a row in bist_alias_blocks';
  end if;
  if (select string_agg(alias || ':' || ticker || ':' || origin || ':' || enabled, ',' order by alias) from public.bist_aliases)
     is distinct from 'e data teknoloji:EDATA:manual:true,kardemir celik:KARCL:manual:true' then
    raise exception '217: the two manual alias rows are not as pinned';
  end if;
  -- no data row appeared anywhere else
  if exists (select 1 from public.bist_companies) or exists (select 1 from public.article_tickers) or exists (select 1 from public.articles) then
    raise exception '217: a table holds a row it should not';
  end if;
end $$;

-- 2. The reported cases, on the shipped function: the longer name attaches its own ticker, the brand's ticker stays off it. ----------
begin;
select pg_temp.seed217();
do $$
declare r text;
begin
  -- (i) the SPK story: EDATA, KARCL (its own manual alias) and GRTHO, never KRDMD, KRDMA or KRDMB
  r := pg_temp.tags217('SPK''dan üç şirketin işlemleriyle ilgili suç duyurusu',
    'Sermaye Piyasası Kurulu (SPK), E-Data Teknoloji, Kardemir Çelik ve Graintürk Holding paylarındaki işlemlere ilişkin incelemeler sonucunda suç duyurusunda bulunulmasına karar verdi.',
    'ekonomi');
  perform pg_temp.expect217('(i) the SPK story', r, 'EDATA:alias:e data teknoloji,GRTHO:alias:grainturk,KARCL:alias:kardemir celik');
  -- (ii) only Kardemir Karabük Demir Çelik: KRDMD through alias:kardemir, as before
  perform pg_temp.expect217('(ii) Kardemir Karabük Demir Çelik', pg_temp.tags217('Kardemir Karabük Demir Çelik hisse bilanço beklentisi', '', 'ekonomi'), 'KRDMD:alias:kardemir');
  perform pg_temp.expect217('(ii) Kardemir alone', pg_temp.tags217('Kardemir hisse bilanço beklentisi', '', 'ekonomi'), 'KRDMD:alias:kardemir');
  -- (iii) Sümer Holding gives no SMRVA, Sümer Varlık gives SMRVA
  perform pg_temp.expect217('(iii) Sümer Holding', pg_temp.tags217('Sümer Holding''e ait üç ildeki 7 taşınmaz özelleştirilecek', '', 'ekonomi'), '-');
  perform pg_temp.expect217('(iii) Sümer Varlık', pg_temp.tags217('Sümer Varlık Yönetim A.Ş. net kar açıkladı', '', 'ekonomi'), 'SMRVA:alias:sumer');
  -- (iv) Türkiye Sigorta Birliği gives no TURSG, Türkiye Sigorta gives TURSG, and (TURSG) in the text still gives it through code_hits
  perform pg_temp.expect217('(iv) Türkiye Sigorta Birliği (TSB)', pg_temp.tags217('Türkiye Sigorta Birliği (TSB) sel uyarısı yaptı', '', 'ekonomi'), '-');
  perform pg_temp.expect217('(iv) Türkiye Sigorta', pg_temp.tags217('Türkiye Sigorta fondan kazanç sağladı', '', 'ekonomi'), 'TURSG:alias:turkiye sigorta');
  perform pg_temp.expect217('(iv) Türkiye Sigorta Birliği and (TURSG)',
    pg_temp.tags217('Türkiye Sigorta Birliği açıklaması (TURSG) hisselerine yansıdı', '', 'ekonomi'), 'TURSG:code');
  -- the block reads the text, not the category
  perform pg_temp.expect217('TSB story filed under genel', pg_temp.tags217('Türkiye Sigorta Birliği''nden sel uyarısı', '', 'genel'), '-');
  perform pg_temp.expect217('the manual TURSG alias still attaches outside finance',
    pg_temp.tags217('Türkiye Sigorta fondan kazanç sağladı', '', 'genel'), 'TURSG:alias:turkiye sigorta');
  -- the known limit: both names in one text lose the plain 'kardemir' match; writing the code brings KRDMD back
  perform pg_temp.expect217('known limit: Kardemir and Kardemir Çelik together',
    pg_temp.tags217('Kardemir ve Kardemir Çelik hisseleri yükseldi', '', 'ekonomi'), 'KARCL:alias:kardemir celik');
  perform pg_temp.expect217('known limit: the code (KRDMD) keeps KRDMD',
    pg_temp.tags217('Kardemir (KRDMD) ve Kardemir Çelik hisseleri yükseldi', '', 'ekonomi'), 'KARCL:alias:kardemir celik,KRDMD:code');
  -- a blocked phrase blocks only its own alias
  perform pg_temp.expect217('another alias in the same text still attaches',
    pg_temp.tags217('Sümer Holding ve Türkiye Sigorta Birliği ve Graintürk Holding hisse haberi', '', 'ekonomi'), 'GRTHO:alias:grainturk');
  -- the sports desk is skipped, as before
  perform pg_temp.expect217('the sports desk is skipped', pg_temp.tags217('Kardemir Çelik hisse bilanço', '', 'spor'), '-');
  -- every seeded alias is an enabled alias row of the production fixture
  if exists (select 1 from public.bist_alias_blocks b
              where not exists (select 1 from public.bist_aliases a where a.alias = b.alias and a.enabled)) then
    raise exception '217: a seeded alias has no enabled row in the production fixture';
  end if;
end $$;
rollback;

-- 3. Differential: a copy of 178's function against 217's over a mixed set of headlines. 217 attaches a subset of what 178 attaches (both on 217's
--    alias rows), and the pairs it drops are exactly the three the rule names. Every headline is inserted twice (ids 1xx through the copy, ids
--    2xx through 217): no row is deleted. -----------------------------------------------------------------------------------------------
begin;
select pg_temp.seed217();
create temp table d217 (i int, title text, descr text, cat text, want_old text, want_new text) on commit drop;
insert into d217 values
  (0, 'SPK''dan üç şirketin işlemleriyle ilgili suç duyurusu', 'Sermaye Piyasası Kurulu (SPK), E-Data Teknoloji, Kardemir Çelik ve Graintürk Holding paylarındaki işlemlere ilişkin incelemeler sonucunda suç duyurusunda bulunulmasına karar verdi.', 'ekonomi', 'EDATA,GRTHO,KARCL,KRDMD', 'EDATA,GRTHO,KARCL'),
  (1, 'Kardemir Karabük Demir Çelik hisse bilanço beklentisi', '', 'ekonomi', 'KRDMD', 'KRDMD'),
  (2, 'Sümer Holding''e ait üç ildeki 7 taşınmaz özelleştirilecek', '', 'ekonomi', 'SMRVA', '-'),
  (3, 'Sümer Varlık Yönetim A.Ş. net kar açıkladı', '', 'ekonomi', 'SMRVA', 'SMRVA'),
  (4, 'Türkiye Sigorta Birliği (TSB) sel uyarısı yaptı', '', 'ekonomi', 'TURSG', '-'),
  (5, 'Türkiye Sigorta fondan kazanç sağladı', '', 'ekonomi', 'TURSG', 'TURSG'),
  (6, 'Türkiye Sigorta Birliği açıklaması (TURSG) hisselerine yansıdı', '', 'ekonomi', 'TURSG', 'TURSG'),
  (7, 'Borsa güne yatay başladı', '', 'ekonomi', '-', '-'),
  (8, 'Kardemir ve Kardemir Çelik hisseleri yükseldi', '', 'ekonomi', 'KARCL,KRDMD', 'KARCL'),
  (9, 'Türkiye Sigorta Birliği''nden sel uyarısı', '', 'genel', 'TURSG', '-'),
  (10, 'Graintürk Holding hisse bilanço duyurusu', '', 'ekonomi', 'GRTHO', 'GRTHO'),
  (11, 'Kardemir Çelik''e DZ Bank''tan kredi', '', 'dunya', 'KARCL,KRDMD', 'KARCL');
insert into public.articles (id, title, description, category, published_at)
  select ('a0000000-0000-0000-0000-' || lpad((100 + i)::text, 12, '0'))::uuid, title, descr, cat, now() from d217
  union all
  select ('a0000000-0000-0000-0000-' || lpad((200 + i)::text, 12, '0'))::uuid, title, descr, cat, now() from d217;
select pg_temp.resolve_article_tickers_178(array(select id from public.articles where id < 'a0000000-0000-0000-0000-000000000200'::uuid));
select public.resolve_article_tickers_for(array(select id from public.articles where id >= 'a0000000-0000-0000-0000-000000000200'::uuid));
do $$
declare r record; bad text := ''; n_old int; n_new int;
begin
  for r in
    select c.i, c.title, c.want_old, c.want_new,
           coalesce((select string_agg(t.ticker, ',' order by t.ticker) from public.article_tickers t
                      where t.article_id = ('a0000000-0000-0000-0000-' || lpad((100 + c.i)::text, 12, '0'))::uuid), '-') as got_old,
           coalesce((select string_agg(t.ticker, ',' order by t.ticker) from public.article_tickers t
                      where t.article_id = ('a0000000-0000-0000-0000-' || lpad((200 + c.i)::text, 12, '0'))::uuid), '-') as got_new
      from d217 c order by c.i
  loop
    if r.got_old <> r.want_old or r.got_new <> r.want_new then
      bad := bad || format('[%s] %s: 178 gave %s (want %s), 217 gave %s (want %s) ', r.i, r.title, r.got_old, r.want_old, r.got_new, r.want_new);
    end if;
  end loop;
  if bad <> '' then raise exception '217 differential: %', bad; end if;
  select count(*) into n_old from public.article_tickers where article_id < 'a0000000-0000-0000-0000-000000000200'::uuid;
  select count(*) into n_new from public.article_tickers where article_id >= 'a0000000-0000-0000-0000-000000000200'::uuid;
  -- 217 attaches exactly 6 pairs fewer than 178 on these headlines: KRDMD x3 (the SPK story, Kardemir and Kardemir Çelik together, the DZ Bank
  -- loan), SMRVA x1 (Sümer Holding) and TURSG x2 (Türkiye Sigorta Birliği, in ekonomi and in genel). The per-headline equalities above already
  -- pin every pair; this count says the function change adds none (a 217 row that 178 lacks would shrink the difference).
  if n_old - n_new <> 6 then
    raise exception '217 differential: expected 6 dropped pairs, got % (178 % rows, 217 % rows)', n_old - n_new, n_old, n_new;
  end if;
end $$;
rollback;

-- 4. Idempotent and read-only: a second call inserts nothing and no block, alias or company row changes. --------------------------------
begin;
select pg_temp.seed217();
insert into public.articles (id, title, description, category, published_at) values
  ('a0000000-0000-0000-0000-0000000000a1', 'Kardemir Çelik hisse bilanço', '', 'ekonomi', now());
do $$
declare first_call int; second_call int; b int; a int; c int;
begin
  select count(*) into b from public.bist_alias_blocks;
  select count(*) into a from public.bist_aliases;
  select count(*) into c from public.bist_companies;
  first_call := public.resolve_article_tickers_for(array['a0000000-0000-0000-0000-0000000000a1'::uuid]);
  second_call := public.resolve_article_tickers_for(array['a0000000-0000-0000-0000-0000000000a1'::uuid]);
  if first_call <> 1 or second_call <> 0 then raise exception '217: expected 1 then 0 inserted rows, got % then %', first_call, second_call; end if;
  if (select count(*) from public.bist_alias_blocks) <> b or (select count(*) from public.bist_aliases) <> a or (select count(*) from public.bist_companies) <> c then
    raise exception '217: the resolver changed a block, alias or company row';
  end if;
end $$;
rollback;

-- 5. Time budget. 171's rule, with bist_alias_blocks present: the 058 trigger calls the resolver once per inserted row inside the ingest upsert
--    (PostgREST, authenticator's 8 s statement_timeout; a 57014 is not catchable), so one article must cost about what it cost under 178 (~1 ms):
--    rule C runs only on the alias rows that matched the text (alias_matches is MATERIALIZED), not on every alias row. ~2,000 enabled auto
--    aliases in shared pairs of untraded tickers, ~2,000 traded companies, and (a) one finance-context article that matches none of the aliases,
--    best of 3 under 50 ms, then (b) the production fixture's Kardemir Çelik story, which DOES match the blocked alias, under the same 50 ms.
begin;
select pg_temp.seed217();
insert into public.bist_aliases (alias, ticker, origin, enabled)
  select 'zzmarka' || lpad(g::text, 4, '0'), 'ZZU' || lpad(g::text, 4, '0') || s, 'auto', true
    from generate_series(1, 1000) g, unnest(array['A', 'B']) s;
insert into public.bist_companies (tickers, shares_traded)
  select array['ZZT' || lpad(g::text, 4, '0')], true from generate_series(1, 2000) g;
do $$
declare v_id uuid; v_t0 timestamptz; v_one numeric; v_ms numeric := 1000000; v_n integer;
begin
  if (select count(*) from public.bist_aliases where enabled and origin = 'auto' and alias like 'zzmarka%') <> 2000
     or (select count(*) from public.bist_companies where tickers[1] like 'ZZT%') <> 2000 then
    raise exception '217: the time-budget fixture is not 2,000 aliases and 2,000 companies';
  end if;
  perform public.resolve_article_tickers_for(array[gen_random_uuid()]);  -- warm-up: compiles the plpgsql body, not timed
  for i in 1..3 loop
    insert into public.articles (id, title, description, category, published_at)
      values (gen_random_uuid(), 'Borsa güne yatay başladı ' || i, '', 'ekonomi', now()) returning id into v_id;
    v_t0 := clock_timestamp();
    v_n := public.resolve_article_tickers_for(array[v_id]);
    v_one := extract(epoch from clock_timestamp() - v_t0) * 1000;
    if v_n <> 0 then raise exception '217: the time-budget article matches none of the aliases, yet % rows were inserted', v_n; end if;
    v_ms := least(v_ms, v_one);
  end loop;
  if v_ms > 50 then
    raise exception '217: one article took % ms against 2,000 shared untraded auto aliases and 2,000 companies (budget 50 ms): rule C runs on every alias row, not on the rows that matched the text', round(v_ms, 1);
  end if;
  raise notice '217: time budget ok, % ms for one non-matching article (best of 3)', round(v_ms, 1);
  -- (b) an article that matches the blocked alias: the rule fires on it and the cost stays in budget
  v_ms := 1000000;
  for i in 1..3 loop
    insert into public.articles (id, title, description, category, published_at)
      values (gen_random_uuid(), 'Kardemir Çelik hisse bilanço ' || i, '', 'ekonomi', now()) returning id into v_id;
    v_t0 := clock_timestamp();
    v_n := public.resolve_article_tickers_for(array[v_id]);
    v_one := extract(epoch from clock_timestamp() - v_t0) * 1000;
    if v_n <> 1 then raise exception '217: the Kardemir Çelik story should attach exactly KARCL, got % rows', v_n; end if;
    v_ms := least(v_ms, v_one);
  end loop;
  if v_ms > 50 then
    raise exception '217: a Kardemir Çelik story took % ms against 2,000 shared untraded auto aliases and 2,000 companies (budget 50 ms)', round(v_ms, 1);
  end if;
  raise notice '217: time budget ok, % ms for one blocked-alias article (best of 3)', round(v_ms, 1);
end $$;
rollback;

-- 6. Nothing was left behind by the scenarios above except 217's own rows. ---------------------------------------------------------------
do $$
begin
  if exists (select 1 from public.bist_companies) or exists (select 1 from public.articles) or exists (select 1 from public.article_tickers) then
    raise exception 'a rolled-back fixture survived';
  end if;
  if (select count(*) from public.bist_aliases) <> 2 or (select count(*) from public.bist_alias_blocks) <> 3 then
    raise exception '217 left the wrong number of block or alias rows behind';
  end if;
end $$;

select 'DRYRUN 217 OK';
