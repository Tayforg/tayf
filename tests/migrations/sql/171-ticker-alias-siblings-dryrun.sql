-- 171 ticker_alias_siblings (resolve_article_tickers_for stops attaching sibling companies through a shared brand alias):
-- local PG15 dry-run. Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55571 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55571 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/171-ticker-alias-siblings-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql PGHOST=/tmp PGPORT=55571 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/171-ticker-alias-siblings)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh    (TAYF_LIVE_ONLY=171 runs just this one)
--
-- (\ir paths below are relative to this file.) Every check is a DO block or a pg_temp function that raises on
-- mismatch, so a clean run ending in "DRYRUN 171 OK" is the pass. Every scenario that writes sits inside begin ...
-- rollback, so the database this leaves behind has 085 and 171 applied and holds no fixture rows.
--
-- Why it exists. 171's JS test (tests/migrations/171-ticker-alias-siblings.test.ts) reads the SQL as text; this runs the
-- SHIPPED function in PostgreSQL: that the baseline (production's 085 body, md5 pinned) attaches the untraded affiliate
-- FNCLL and the auto siblings TSGYO and TSKYO, that 171 gives TCELL only and TSKB only (and alarko, migros, enerjisa and
-- kardemir their manual parent), that rule B alone drops an untraded auto sibling of a traded one, that an alias whose
-- siblings are ALL untraded auto rows keeps 085's behaviour (rule B is narrowed: it needs a manual or traded sibling), that an
-- untraded auto row next to an untraded MANUAL sibling still drops (rule A), that all-auto traded siblings and single-row
-- aliases are untouched, that manual rows are never dropped, that a disabled row neither wins nor shares, that the
-- finance-context gate and the code path are 085's, that a copy of 085's function and 171's agree on every pair except
-- the dropped ones (a differential over a mixed set of headlines), that applying 171 twice leaves one body and one
-- ledger row with the grants service_role only, and the TIME BUDGET: one article that matches nothing costs under 50 ms
-- against ~2,000 enabled auto aliases in shared untraded pairs and ~2,000 companies (the alias-only predicates run on the
-- rows that matched the text, not on every alias row: O(matches), not O(auto aliases x companies)).
--
-- Order: the state 171 sits on (bist_aliases of 049 with 052's enabled column, 049's fold, 062's finance regex; the stub
-- already carries articles, article_tickers and bist_companies), 085 as production has it (applied from its own file, md5
-- pinned, with 058's revoke and grant), the defect on that baseline, then 171 TWICE, the new fingerprint and attributes,
-- and the scenarios.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Prelude: the state 171 sits on. ---------------------------------------------------------------------------
-- 049 + 052: the alias table production has.
create table public.bist_aliases (
  alias   text not null,
  ticker  text not null,
  origin  text not null default 'manual',
  enabled boolean not null default true,
  primary key (alias, ticker)
);

-- Migration 049's fold, copied verbatim.
create or replace function public.fold_tr(s text)
returns text
language sql
immutable
strict
as $$
  select trim(regexp_replace(
    lower(translate(s, 'ŞĞÇÖÜİIşğçöüıÂÎÛâîû', 'SGCOUIIsgcouiAIUaiu')),
    '[^a-z0-9]+', ' ', 'g'
  ));
$$;

-- Migration 062's finance-context regex, copied verbatim.
create or replace function public.finance_context_regex()
returns text
language sql
immutable
set search_path = ''
as $$
  select '\m(hisse|hisseleri|hissesi|hisselerinde|borsa|borsada|bist|kap|paylari|yatirimci|yatirimcilar|sirket|sirketi|sirketin|holding|bilanco|temettu|halka arz|sermaye|ciro|ihale|spk|genel kurul|bedelsiz|bedelli|geri alim|net kar|net zarar|finansal sonuc|ceyrek)\M'::text;
$$;

-- 085, from its own file: production's resolver before 171 (md5(prosrc) read on production on 2026-11-07). ----------------
\ir ../../../supabase/migrations/085_ticker_code_gate.sql
-- 058's execute lines for this function, which production has: owner and service_role only (the stub's default privileges
-- hand every new function to anon and authenticated).
revoke execute on function public.resolve_article_tickers_for(uuid[]) from anon, authenticated, public;
grant execute on function public.resolve_article_tickers_for(uuid[]) to service_role;

-- Fixture helpers (session-local). ----------------------------------------------------------------------------
create function pg_temp.al(a text, t text, o text, en boolean default true) returns void language sql as
  $f$ insert into public.bist_aliases (alias, ticker, origin, enabled) values (a, t, o, en) $f$;
create function pg_temp.co(t text[], traded boolean) returns void language sql as
  $f$ insert into public.bist_companies (tickers, shares_traded) values (t, traded) $f$;
-- One article through the resolver: the tickers that attached, sorted and comma-joined ("-" for none).
create function pg_temp.tags(p_title text, p_cat text default 'ekonomi') returns text language plpgsql as $f$
declare v_id uuid := gen_random_uuid(); r text;
begin
  insert into public.articles (id, title, description, category, published_at) values (v_id, p_title, '', p_cat, now());
  perform public.resolve_article_tickers_for(array[v_id]);
  select coalesce(string_agg(ticker, ',' order by ticker), '-') into r from public.article_tickers where article_id = v_id;
  return r;
end $f$;
-- The rows production has for the two aliases of the report (read 2026-11-07).
create function pg_temp.turkcell() returns void language sql as $f$
  select pg_temp.al('turkcell', 'TCELL', 'manual'), pg_temp.al('turkcell', 'FNCLL', 'auto'),
         pg_temp.co(array['TCELL'], true), pg_temp.co(array['FNCLL'], false) $f$;
create function pg_temp.tskb() returns void language sql as $f$
  select pg_temp.al('tskb', 'TSKB', 'manual'), pg_temp.al('tskb', 'TSGYO', 'auto'), pg_temp.al('tskb', 'TSKYO', 'auto'),
         pg_temp.co(array['TSKB'], true), pg_temp.co(array['TSGYO'], true), pg_temp.co(array['TSKYO'], false) $f$;

-- Baseline: this is production's resolver (md5(prosrc) read on production on 2026-11-07) with its ACL (owner + service_role,
-- nobody else). ------------------------------------------------------------------------------------------------------------
create temp table before_171 as
  select md5(prosrc) as m, length(prosrc) as len,
         (select string_agg(case when a.grantee = 0 then 'public' else a.grantee::regrole::text end || ':' || a.privilege_type,
                            ',' order by case when a.grantee = 0 then 'public' else a.grantee::regrole::text end)
            from aclexplode(p.proacl) a) as grants,
         proconfig::text as cfg, provolatile, prosecdef, proretset, proowner::regrole::text as owner,
         pg_get_function_result(oid) as res, pg_get_function_arguments(oid) as args, prolang
    from pg_proc p where oid = 'public.resolve_article_tickers_for(uuid[])'::regprocedure;

do $$
declare b record;
begin
  select * into b from before_171;
  if b.m <> '2667cc7fad0d66879f77ec6ad31e52ab' or b.len <> 1760 then
    raise exception 'baseline: the prelude function is not production''s resolver (md5 %, length %)', b.m, b.len;
  end if;
  if b.grants not like '%service_role:EXECUTE%' or b.grants like '%anon%' or b.grants like '%authenticated%' or b.grants like '%public%' then
    raise exception 'baseline: unexpected grants %', b.grants;
  end if;
  if b.prosecdef or b.provolatile <> 'v' or b.cfg is distinct from '{"search_path=\"\""}' or b.proretset then
    raise exception 'baseline: unexpected attributes (secdef %, volatile %, config %)', b.prosecdef, b.provolatile, b.cfg;
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '085') <> 1 then
    raise exception 'baseline: 085''s ledger row is missing';
  end if;
  if exists (select 1 from supabase_migrations.schema_migrations where version = '171') then
    raise exception 'baseline: 171 is already in the ledger';
  end if;
end $$;

-- A copy of 085's function under a session-local name, for the differential below (the original is replaced by 171).
select replace(pg_get_functiondef('public.resolve_article_tickers_for(uuid[])'::regprocedure),
               'public.resolve_article_tickers_for', 'pg_temp.resolve_article_tickers_085') as def \gset
:def
;

-- The defect, on the old function: the siblings attach. --------------------------------------------------------------------
begin;
select pg_temp.tskb();
select pg_temp.turkcell();
do $$
declare tskb text := pg_temp.tags('TSKB’nin iklim finansman hedefi 5 milyar dolar');
        turkcell text := pg_temp.tags('Turkcell COP31’de dijital ve yeşil dönüşüm vizyonunu paylaşacak');
begin
  if tskb <> 'TSGYO,TSKB,TSKYO' or turkcell <> 'FNCLL,TCELL' then
    raise exception 'baseline: 085 attaches the untraded affiliate FNCLL and the auto siblings TSGYO and TSKYO; got tskb % and turkcell %', tskb, turkcell;
  end if;
end $$;
rollback;

-- 171, TWICE (safe to re-apply). -------------------------------------------------------------------------------------------
\ir ../../../supabase/migrations/171_ticker_alias_siblings.sql
create temp table after_171_first as
  select md5(prosrc) as m, proacl::text as acl
    from pg_proc where oid = 'public.resolve_article_tickers_for(uuid[])'::regprocedure;
\ir ../../../supabase/migrations/171_ticker_alias_siblings.sql

-- 1. The new function: its fingerprint and attributes; the grants as they were. ---------------------------------------------
do $$
declare a record; b record; f record;
begin
  select * into b from before_171;
  select md5(prosrc) as m, length(prosrc) as len,
         (select string_agg(case when x.grantee = 0 then 'public' else x.grantee::regrole::text end || ':' || x.privilege_type,
                            ',' order by case when x.grantee = 0 then 'public' else x.grantee::regrole::text end)
            from aclexplode(p.proacl) x) as grants,
         proconfig::text as cfg, provolatile, prosecdef, proretset, proowner::regrole::text as owner,
         pg_get_function_result(oid) as res, pg_get_function_arguments(oid) as args, prolang
    into a from pg_proc p where oid = 'public.resolve_article_tickers_for(uuid[])'::regprocedure;

  if a.m <> '999a286fb58e46bf1958b78dfedcad98' or a.len <> 3401 then
    raise exception '171: unexpected body (md5 %, length %)', a.m, a.len;
  end if;
  if a.m = b.m then raise exception '171: the new body equals 085''s'; end if;
  if a.grants is distinct from b.grants then raise exception '171: grants differ from 085''s: % -> %', b.grants, a.grants; end if;
  if a.cfg is distinct from b.cfg or a.provolatile <> b.provolatile or a.prosecdef <> b.prosecdef or a.proretset <> b.proretset
     or a.owner <> b.owner or a.prolang <> b.prolang or a.res <> b.res or a.args <> b.args then
    raise exception '171: an attribute of the resolver differs from 085''s';
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'resolve_article_tickers_for') <> 1 then
    raise exception '171: more than one resolve_article_tickers_for overload';
  end if;
  -- the second apply left the first apply's result
  select * into f from after_171_first;
  if f.m <> a.m then raise exception '171: the second apply changed the body'; end if;
  if has_function_privilege('anon', 'public.resolve_article_tickers_for(uuid[])', 'execute')
     or has_function_privilege('authenticated', 'public.resolve_article_tickers_for(uuid[])', 'execute')
     or not has_function_privilege('service_role', 'public.resolve_article_tickers_for(uuid[])', 'execute') then
    raise exception '171: execute privileges are not service_role only';
  end if;
  -- 085 and 171 each recorded their own ledger row, once even though 171 was applied twice
  if (select count(*) from supabase_migrations.schema_migrations where version = '171') <> 1
     or (select name from supabase_migrations.schema_migrations where version = '171') <> '171_ticker_alias_siblings' then
    raise exception '171: the ledger row is not exactly one row named 171_ticker_alias_siblings';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '085') <> 1 then
    raise exception '171: 085''s ledger row changed';
  end if;
  -- the migration wrote no data: no alias, company, article or tag row exists
  if exists (select 1 from public.bist_aliases) or exists (select 1 from public.bist_companies)
     or exists (select 1 from public.article_tickers) or exists (select 1 from public.articles) then
    raise exception '171: a table holds a row it should not';
  end if;
end $$;

-- 2. The two reported cases: the manual sibling wins. -----------------------------------------------------------------------
begin;
select pg_temp.tskb();
select pg_temp.turkcell();
do $$
declare tskb text := pg_temp.tags('TSKB’nin iklim finansman hedefi 5 milyar dolar');
        turkcell text := pg_temp.tags('Turkcell COP31’de dijital ve yeşil dönüşüm vizyonunu paylaşacak');
begin
  if tskb <> 'TSKB' then raise exception '171: tskb should give TSKB only; got %', tskb; end if;
  if turkcell <> 'TCELL' then raise exception '171: turkcell should give TCELL only; got %', turkcell; end if;
end $$;
rollback;

-- 3. alarko, migros, enerjisa, kardemir: the manual parent only (production's rows, read 2026-11-07). ------------------------
begin;
select pg_temp.al('alarko', 'ALARK', 'manual'), pg_temp.al('alarko', 'ALCAR', 'auto'), pg_temp.al('alarko', 'ALGYO', 'auto'),
       pg_temp.co(array['ALARK'], true), pg_temp.co(array['ALCAR'], true), pg_temp.co(array['ALGYO'], true);
select pg_temp.al('migros', 'MGROS', 'manual'), pg_temp.al('migros', 'MIGRS', 'auto'),
       pg_temp.co(array['MGROS'], true), pg_temp.co(array['MIGRS'], false);
select pg_temp.al('enerjisa', 'ENJSA', 'manual'), pg_temp.al('enerjisa', 'EEDAS', 'auto'),
       pg_temp.co(array['ENJSA'], true), pg_temp.co(array['EEDAS'], false);
select pg_temp.al('kardemir', 'KRDMD', 'manual'), pg_temp.al('kardemir', 'KRDMA', 'auto'), pg_temp.al('kardemir', 'KRDMB', 'auto'),
       pg_temp.al('kardemir', 'KARCL', 'auto'), pg_temp.co(array['KRDMA', 'KRDMB', 'KRDMD'], true), pg_temp.co(array['KARCL'], true);
do $$
declare alarko text := pg_temp.tags('Alarko Holding net kar açıkladı');
        migros text := pg_temp.tags('Migros hisse geri alım programı');
        enerjisa text := pg_temp.tags('Enerjisa bilanço sonuçlarını açıkladı');
        kardemir text := pg_temp.tags('Kardemir hisse bilanço beklentisi');
begin
  if alarko <> 'ALARK' or migros <> 'MGROS' or enerjisa <> 'ENJSA' or kardemir <> 'KRDMD' then
    raise exception '171: manual parent only expected; got alarko %, migros %, enerjisa %, kardemir %', alarko, migros, enerjisa, kardemir;
  end if;
end $$;
rollback;

-- 4. Rule B alone, all-untraded groups, all-auto traded groups, single rows, manual rows, disabled rows. -------------------------
begin;
-- rule B alone: no manual row, an untraded auto sibling drops and the traded one stays
select pg_temp.al('eregli', 'EREGL', 'auto'), pg_temp.al('eregli', 'ERGLI', 'auto'),
       pg_temp.co(array['EREGL'], true), pg_temp.co(array['ERGLI'], false);
-- every sibling untraded AND auto: no manual or traded sibling to defer to, so 085's behaviour stays (both attach)
select pg_temp.al('trive', 'TRMEN', 'auto'), pg_temp.al('trive', 'TVM', 'auto'),
       pg_temp.co(array['TRMEN'], false), pg_temp.co(array['TVM'], false);
-- an untraded auto row next to an untraded MANUAL sibling: rule A drops it (the manual row stays)
select pg_temp.al('yonet', 'YONET', 'manual'), pg_temp.al('yonet', 'YONYO', 'auto'),
       pg_temp.co(array['YONET'], false), pg_temp.co(array['YONYO'], false);
-- two untraded auto rows next to one traded auto row: rule B drops both untraded rows
select pg_temp.al('karma', 'KARMA', 'auto'), pg_temp.al('karma', 'KARUN', 'auto'), pg_temp.al('karma', 'KARTR', 'auto'),
       pg_temp.co(array['KARMA'], true), pg_temp.co(array['KARUN'], false), pg_temp.co(array['KARTR'], false);
-- all-auto traded siblings: all four attach (the founder's follow-up b)
select pg_temp.al('oyak', t, 'auto'), pg_temp.co(array[t], true) from unnest(array['OYA', 'OYAKC', 'OYAYO', 'OYYAT']) t;
-- a single row, auto and untraded: nothing shares it
select pg_temp.al('tekil', 'TEKIL', 'auto'), pg_temp.co(array['TEKIL'], false);
-- two manual rows, one untraded: a manual row is never dropped
select pg_temp.al('ortak', 'ORTAK', 'manual'), pg_temp.al('ortak', 'ORTYO', 'manual'),
       pg_temp.co(array['ORTAK'], true), pg_temp.co(array['ORTYO'], false);
-- a disabled manual sibling does not win; a disabled other row does not share
select pg_temp.al('pasif', 'PASIF', 'manual', false), pg_temp.al('pasif', 'PASYO', 'auto'),
       pg_temp.co(array['PASIF'], true), pg_temp.co(array['PASYO'], true);
select pg_temp.al('eski', 'ESKIX', 'auto'), pg_temp.al('eski', 'ESKIY', 'auto', false), pg_temp.co(array['ESKIX'], false);
do $$
declare r text;
begin
  r := pg_temp.tags('Eregli hisse bilanço sonrası yükseldi');
  if r <> 'EREGL' then raise exception '171: rule B alone should leave EREGL only; got %', r; end if;
  r := pg_temp.tags('Trive Yatırım’ın faaliyetlerine geçici durdurma kararı SPK');
  if r <> 'TRMEN,TVM' then raise exception '171: an all-untraded auto alias should keep 085''s behaviour (TRMEN,TVM); got %', r; end if;
  r := pg_temp.tags('Yonet hisse bilanço');
  if r <> 'YONET' then raise exception '171: an untraded auto row next to an untraded MANUAL sibling should drop (rule A); got %', r; end if;
  r := pg_temp.tags('Karma hisse bilanço');
  if r <> 'KARMA' then raise exception '171: untraded auto rows next to a traded auto sibling should drop (rule B); got %', r; end if;
  r := pg_temp.tags('OYAK’tan Libya petrolünde büyük hamle hisse');
  if r <> 'OYA,OYAKC,OYAYO,OYYAT' then raise exception '171: all-auto traded siblings should all attach; got %', r; end if;
  r := pg_temp.tags('Tekil hisse bilanço duyurusu');
  if r <> 'TEKIL' then raise exception '171: a single-row alias should be untouched; got %', r; end if;
  r := pg_temp.tags('Ortak hisse bilanço');
  if r <> 'ORTAK,ORTYO' then raise exception '171: manual rows should never be dropped; got %', r; end if;
  r := pg_temp.tags('Pasif hisse bilanço');
  if r <> 'PASYO' then raise exception '171: a disabled manual sibling should not win; got %', r; end if;
  r := pg_temp.tags('Eski hisse bilanço');
  if r <> 'ESKIX' then raise exception '171: a disabled other row should not make the alias shared; got %', r; end if;
end $$;
rollback;
-- one manual parent alias resolves the all-auto group (rule A): the owner's pick
begin;
select pg_temp.al('oyak', t, case when t = 'OYAKC' then 'manual' else 'auto' end), pg_temp.co(array[t], true)
  from unnest(array['OYA', 'OYAKC', 'OYAYO', 'OYYAT']) t;
do $$
declare r text := pg_temp.tags('OYAK’tan Libya petrolünde büyük hamle hisse');
begin
  if r <> 'OYAKC' then raise exception '171: one manual parent alias should resolve the oyak group; got %', r; end if;
end $$;
rollback;

-- 5. The gates are 085's: finance context for auto rows, the code path for a dropped sibling. --------------------------------
begin;
select pg_temp.turkcell();
select pg_temp.tskb();
select pg_temp.al('tekil', 'TEKIL', 'auto'), pg_temp.co(array['TEKIL'], true);
do $$
declare r text;
begin
  -- outside finance only the manual row attaches
  r := pg_temp.tags('Turkcell kurucusu Kopenhag''da konuştu', 'dunya');
  if r <> 'TCELL' then raise exception '171: outside finance only TCELL should attach; got %', r; end if;
  r := pg_temp.tags('Tekil festivali açıldı', 'yasam');
  if r <> '-' then raise exception '171: an auto alias outside finance should not attach; got %', r; end if;
  -- the sports desk is skipped
  r := pg_temp.tags('Turkcell hisse bilanço', 'spor');
  if r <> '-' then raise exception '171: the sports desk should be skipped; got %', r; end if;
  -- a dropped sibling still attaches when its own code is written; an untraded ticker's code never does
  r := pg_temp.tags('TSGYO paylarında hareket');
  if r <> 'TSGYO' then raise exception '171: the code path should still match TSGYO; got %', r; end if;
  r := pg_temp.tags('TSKYO paylarında hareket');
  if r <> '-' then raise exception '171: an untraded code should not match; got %', r;  end if;
end $$;
rollback;

-- 6. Differential: a copy of 085's function against 171 over a mixed set of headlines. 171 attaches a subset of what 085
--    attaches, and the pairs it drops are exactly the siblings the rules name. ------------------------------------------------
begin;
select pg_temp.turkcell();
select pg_temp.tskb();
select pg_temp.al('alarko', 'ALARK', 'manual'), pg_temp.al('alarko', 'ALCAR', 'auto'), pg_temp.al('alarko', 'ALGYO', 'auto'),
       pg_temp.co(array['ALARK'], true), pg_temp.co(array['ALCAR'], true), pg_temp.co(array['ALGYO'], true);
select pg_temp.al('eregli', 'EREGL', 'auto'), pg_temp.al('eregli', 'ERGLI', 'auto'),
       pg_temp.co(array['EREGL'], true), pg_temp.co(array['ERGLI'], false);
select pg_temp.al('trive', 'TRMEN', 'auto'), pg_temp.al('trive', 'TVM', 'auto'),
       pg_temp.co(array['TRMEN'], false), pg_temp.co(array['TVM'], false);
select pg_temp.al('oyak', t, 'auto'), pg_temp.co(array[t], true) from unnest(array['OYA', 'OYAKC', 'OYAYO', 'OYYAT']) t;
select pg_temp.al('tekil', 'TEKIL', 'auto'), pg_temp.co(array['TEKIL'], true);
select pg_temp.al('garanti bbva', 'GARAN', 'manual'), pg_temp.co(array['GARAN'], true);
insert into public.articles (title, description, category, published_at) values
  ('Turkcell COP31’de dijital ve yeşil dönüşüm vizyonunu paylaşacak', '', 'ekonomi', now()),
  ('TSKB’nin iklim finansman hedefi 5 milyar dolar', '', 'ekonomi', now()),
  ('Alarko Carrier Gebze fabrikasını kapatıyor: 183 çalışan işsiz kalacak', '', 'ekonomi', now()),
  ('Ereğli bilanço sonrası yükseldi', '', 'ekonomi', now()),
  ('Trive Yatırım’ın faaliyetlerine geçici durdurma kararı', '', 'ekonomi', now()),
  ('OYAK’tan Libya petrolünde büyük hamle', '', 'ekonomi', now()),
  ('Tekil hisse bilanço duyurusu', '', 'ekonomi', now()),
  ('Garanti BBVA kâr açıkladı', '', 'ekonomi', now()),
  ('Turkcell kurucusu Kopenhag''da konuştu', '', 'dunya', now()),
  ('Turkcell Stadı''nda maç oynandı', '', 'spor', now()),
  ('Alarko Carrier’den hisse açıklaması: GARAN değil ALARK', '', 'ekonomi', now());
select pg_temp.resolve_article_tickers_085(array(select id from public.articles));
create temp table d085 as select article_id, ticker from public.article_tickers;
delete from public.article_tickers;
select public.resolve_article_tickers_for(array(select id from public.articles));
create temp table d171 as select article_id, ticker from public.article_tickers;
do $$
declare n085 int; n171 int; extra text; dropped text;
begin
  select count(*) into n085 from d085;
  select count(*) into n171 from d171;
  select string_agg(ticker, ',' order by ticker) into extra from (select article_id, ticker from d171 except select article_id, ticker from d085) x;
  select string_agg(ticker, ',' order by ticker) into dropped from (select article_id, ticker from d085 except select article_id, ticker from d171) x;
  if n085 = 0 then raise exception '171: the differential fixture produced no 085 tags'; end if;
  if extra is not null then raise exception '171: attaches a pair 085 does not: %', extra; end if;
  -- the Trive headline (TRMEN, TVM: an alias whose siblings are all untraded auto rows) is no longer dropped
  if dropped is distinct from 'ALCAR,ALCAR,ALGYO,ALGYO,ERGLI,FNCLL,TSGYO,TSKYO' then
    raise exception '171: unexpected dropped pairs: % (085 % rows, 171 % rows)', dropped, n085, n171;
  end if;
  if n085 - n171 <> 8 then raise exception '171: expected 8 dropped rows, got %', n085 - n171; end if;
end $$;
rollback;

-- 7. Idempotent and read-only: a second call inserts nothing and no alias or company row changes. --------------------------------
begin;
select pg_temp.turkcell();
insert into public.articles (id, title, description, category, published_at) values
  ('a0000000-0000-0000-0000-0000000000a1', 'Turkcell hisse bilanço', '', 'ekonomi', now());
do $$
declare first_call int; second_call int;
begin
  first_call := public.resolve_article_tickers_for(array['a0000000-0000-0000-0000-0000000000a1'::uuid]);
  second_call := public.resolve_article_tickers_for(array['a0000000-0000-0000-0000-0000000000a1'::uuid]);
  if first_call <> 1 or second_call <> 0 then raise exception '171: expected 1 then 0 inserted rows, got % then %', first_call, second_call; end if;
  if (select count(*) from public.bist_aliases) <> 2 or (select count(*) from public.bist_aliases where enabled) <> 2
     or (select count(*) from public.bist_companies) <> 2 then
    raise exception '171: the resolver changed an alias or company row';
  end if;
end $$;
rollback;

-- 8. Time budget. The 058 trigger calls the resolver once per inserted row inside the ingest upsert (PostgREST, authenticator's
--    8 s statement_timeout; a 57014 is not catchable), so one article must cost about what it cost under 085 (~1 ms): the
--    alias-only predicates may run only on the alias rows that matched the text. ~2,000 enabled auto aliases in shared pairs
--    of untraded tickers, ~2,000 traded companies (so every NOT EXISTS has real rows to scan), and one finance-context
--    article that matches none of the aliases. A body that evaluates the predicates for every auto alias row does
--    O(auto aliases x companies) work here (~4,000,000 array tests) and takes several hundred ms; the post-match body
--    does O(matches) work (none) and takes a few ms.
begin;
insert into public.bist_aliases (alias, ticker, origin, enabled)
  select 'zzmarka' || lpad(g::text, 4, '0'), 'ZZU' || lpad(g::text, 4, '0') || s, 'auto', true
    from generate_series(1, 1000) g, unnest(array['A', 'B']) s;
insert into public.bist_companies (tickers, shares_traded)
  select array['ZZT' || lpad(g::text, 4, '0')], true from generate_series(1, 2000) g;
do $$
declare v_id uuid := gen_random_uuid(); v_t0 timestamptz; v_ms numeric; v_n integer;
begin
  if (select count(*) from public.bist_aliases where enabled and origin = 'auto') <> 2000
     or (select count(*) from public.bist_companies) <> 2000 then
    raise exception '171: the time-budget fixture is not 2,000 aliases and 2,000 companies';
  end if;
  insert into public.articles (id, title, description, category, published_at)
    values (v_id, 'Borsa güne yatay başladı', '', 'ekonomi', now());
  perform public.resolve_article_tickers_for(array[gen_random_uuid()]);  -- warm-up: compiles the plpgsql body, not timed
  v_t0 := clock_timestamp();
  v_n := public.resolve_article_tickers_for(array[v_id]);
  v_ms := extract(epoch from clock_timestamp() - v_t0) * 1000;
  if v_n <> 0 then raise exception '171: the time-budget article matches none of the aliases, yet % rows were inserted', v_n; end if;
  if v_ms > 50 then
    raise exception '171: one article took % ms against 2,000 shared untraded auto aliases and 2,000 companies (budget 50 ms): the alias-only predicates run on every alias row, not on the rows that matched the text', round(v_ms, 1);
  end if;
  raise notice '171: time budget ok, % ms for one article', round(v_ms, 1);
end $$;
rollback;

-- 9. Nothing was left behind by the scenarios above. -------------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from public.bist_aliases) or exists (select 1 from public.bist_companies)
     or exists (select 1 from public.articles) or exists (select 1 from public.article_tickers) then
    raise exception 'a rolled-back fixture survived';
  end if;
end $$;

select 'DRYRUN 171 OK';
