-- 218 alias_sibling_code_wins (resolve_article_tickers_for stops attaching an AUTO alias row for ticker Y when the same article writes another
-- ticker Z by its code and Z shares the alias): local PG15 dry-run. Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55575 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55575 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/218-alias-sibling-code-wins-dryrun.sql
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh    (TAYF_LIVE_ONLY=218 runs just this one)
--
-- (\ir paths below are relative to this file.) Every check is a DO block or a pg_temp function that raises on mismatch, so a clean run
-- ending in "DRYRUN 218 OK" is the pass. Every scenario that writes sits inside begin ... rollback, so the database this leaves behind has
-- 085, 171, 177, 178, 217 and 218 applied and holds no fixture row: only 217's three bist_alias_blocks rows and two manual bist_aliases rows.
--
-- Why it exists. 218's JS test (tests/migrations/218-alias-sibling-code-wins.test.ts) reads the SQL as text; this runs the SHIPPED function in
-- PostgreSQL. The baseline is 217's body (production's, md5 pinned): a story that writes BTCIM by its code and names Batiçim in its description
-- attaches BSOKE too, through the shared auto alias 'baticim'. After 218:
--   S1 a story writing BTCIM gives BTCIM only (no BSOKE);
--   S2 a text with no code keeps both siblings (the known limit, bucket C of 171: unchanged);
--   S3 both codes written give both (by code, and neither alias row is needed);
--   S4 a manual row is never dropped (TSKB manual on 'tskb' keeps TSKB, TSGYO comes in by its code);
--   S5 a sibling code that fails the code gate does not trigger D (a stoplisted code written bare is not in code_hits);
--   S6 OYAKC written next to Oyak gives OYAKC only (no OYA, OYAYO or OYYAT);
-- plus: a differential of a session copy of 217's function against 218's (218 attaches a subset, the dropped pairs are exactly rule D's, none is
-- added), idempotence (applying 218 twice leaves one body, one ledger row and the grants), and the TIME BUDGET: 171's rule, 50 ms for one article,
-- both for an article that matches nothing and for an article where D fires, against 2,000 shared untraded auto aliases and 2,000 companies.
--
-- Order: the state 218 sits on is exactly 217's dry-run (178's, which runs 177's and 171's: the alias table of 049 with 052's enabled column,
-- 049's fold, 062's finance regex, 085 from its own file, then 171, 177, 178 and 217 each applied twice, every scenario of theirs checked); this
-- file runs it, shows the defect on 217's body, then applies 218 TWICE.
--
-- READ-ONLY REPLAY (production, `sbq.py -e`, 2026-11-22; the numbers are in the header of 218_alias_sibling_code_wins.sql): take 217's body and
-- 218's body from their files, keep each CTE chain from `with recent as (` through `hits`, replace `a.id = any (p_ids)` in `recent` with a
-- published_at window, end each chain with `select distinct on (article_id, ticker) article_id, ticker, matched_on from hits`, run both in
-- 3-day slices under the statement timeout and full join the two result sets on (article_id, ticker): a pair on one side only is a removed
-- (old only) or an added (new only) match. The shape of one slice:
-- with old_pairs as (<217's chain>), new_pairs as (<218's chain>),
--      diff as (select coalesce(o.article_id, n.article_id) article_id, coalesce(o.ticker, n.ticker) ticker, o.matched_on old_m, n.matched_on new_m
--               from old_pairs o full join new_pairs n on n.article_id = o.article_id and n.ticker = o.ticker
--               where o.article_id is null or n.article_id is null)
-- select (select count(*) from old_pairs), (select count(*) from new_pairs), d.* from diff d;

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Prelude: 085, 171, 177, 178 and 217 as production has them (217's own dry-run, which ends clean). --------------------------------
\ir 217-alias-blockers-dryrun.sql

-- Fixture helpers (session-local). ----------------------------------------------------------------------------------------
create function pg_temp.co218(t text[], traded boolean) returns void language sql as
  $f$ insert into public.bist_companies (tickers, shares_traded) values (t, traded) $f$;
create function pg_temp.al218(a text, t text, o text) returns void language sql as
  $f$ insert into public.bist_aliases (alias, ticker, origin) values (a, t, o) $f$;
-- One article through the resolver: the tickers sorted and comma-joined ("-" for none), or "ticker:matched_on" pairs when p_pairs. p_old runs the
-- session copy of 217's function (created below), otherwise the shipped function.
create function pg_temp.tags218(p_title text, p_desc text, p_cat text, p_old boolean default false, p_pairs boolean default false) returns text
language plpgsql as $f$
declare v_id uuid := gen_random_uuid(); r text;
begin
  insert into public.articles (id, title, description, category, published_at) values (v_id, p_title, p_desc, p_cat, now());
  if p_old then
    perform pg_temp.resolve_article_tickers_217(array[v_id]);
  else
    perform public.resolve_article_tickers_for(array[v_id]);
  end if;
  select coalesce(string_agg(case when p_pairs then ticker || ':' || matched_on else ticker end, ',' order by ticker), '-') into r
    from public.article_tickers where article_id = v_id;
  return r;
end $f$;
create function pg_temp.expect218(p_label text, p_got text, p_want text) returns void language plpgsql as $f$
begin
  if p_got is distinct from p_want then
    raise exception '218 scenario failed: % -> got %, want %', p_label, p_got, p_want;
  end if;
end $f$;
-- Production's rows for the aliases of the report (read-only, 2026-11-22), 'sumer' (217's rule C) and one fixture-only alias for S5. 217's two manual aliases and its three
-- block rows are already in the database. shares_traded is true for every company except ANELT and TSKYO (untraded, as in production).
create function pg_temp.seed218() returns void language sql as $f$
  select pg_temp.al218('baticim', 'BSOKE', 'auto'), pg_temp.al218('baticim', 'BTCIM', 'auto'),
         pg_temp.al218('oyak', 'OYA', 'auto'), pg_temp.al218('oyak', 'OYAKC', 'auto'), pg_temp.al218('oyak', 'OYAYO', 'auto'), pg_temp.al218('oyak', 'OYYAT', 'auto'),
         pg_temp.al218('tskb', 'TSKB', 'manual'), pg_temp.al218('tskb', 'TSGYO', 'auto'), pg_temp.al218('tskb', 'TSKYO', 'auto'),
         pg_temp.al218('anel', 'ANELE', 'auto'), pg_temp.al218('anel', 'ANELT', 'auto'),
         pg_temp.al218('xmarka', 'XMRKA', 'auto'), pg_temp.al218('xmarka', 'DEVA', 'auto'), pg_temp.al218('sumer', 'SMRVA', 'auto'),
         pg_temp.co218(array['BSOKE'], true), pg_temp.co218(array['BTCIM'], true),
         pg_temp.co218(array['OYA', 'OYYAT'], true), pg_temp.co218(array['OYAKC'], true), pg_temp.co218(array['OYAYO'], true),
         pg_temp.co218(array['TSK', 'TSKB'], true), pg_temp.co218(array['TSGYO'], true), pg_temp.co218(array['TSKYO'], false),
         pg_temp.co218(array['ANELE'], true), pg_temp.co218(array['ANELT'], false),
         pg_temp.co218(array['XMRKA'], true), pg_temp.co218(array['DEVA'], true), pg_temp.co218(array['SMRVA'], true) $f$;

-- Baseline: this is 217's resolver (production's, md5(prosrc) read on production on 2026-11-22), the text 218 replaces. ----------
do $$
declare v_md5 text; v_len integer;
begin
  select md5(prosrc), length(prosrc) into v_md5, v_len from pg_proc where oid = 'public.resolve_article_tickers_for(uuid[])'::regprocedure;
  if v_md5 <> 'fd6429df30125e201fe28278c606c53e' or v_len <> 3693 then
    raise exception '218 baseline is not 217''s body (production''s): md5 %, length %', v_md5, v_len;
  end if;
  if exists (select 1 from supabase_migrations.schema_migrations where version = '218') then
    raise exception '218 baseline: 218 is already in the ledger';
  end if;
  if (select count(*) from public.bist_alias_blocks) <> 3 or (select count(*) from public.bist_aliases) <> 2 then
    raise exception '218 baseline: the block rows and alias rows are not 217''s three and two';
  end if;
  if not ('DEVA' = any (public.ticker_code_stoplist())) then
    raise exception '218 baseline: DEVA is not in ticker_code_stoplist() (S5 needs a stoplisted code)';
  end if;
end $$;

-- A copy of 217's function under a session-local name, for the differential below (the original is replaced by 218).
select replace(pg_get_functiondef('public.resolve_article_tickers_for(uuid[])'::regprocedure),
               'public.resolve_article_tickers_for', 'pg_temp.resolve_article_tickers_217') as def \gset
:def
;

-- The defect, on the old function: the story that writes BTCIM by its code also attaches BSOKE through the shared auto alias. ---------
begin;
select pg_temp.seed218();
do $$
begin
  perform pg_temp.expect218('baseline: 217 attaches BSOKE to a story that writes BTCIM by its code',
    pg_temp.tags218('SPK''dan BTCIM hisselerine işlem yasağı',
      'Sermaye Piyasası Kurulu, Batıçim Çimento hisselerinde işlem yapılmasını yasakladı.', 'ekonomi', true),
    'BSOKE,BTCIM');
  perform pg_temp.expect218('baseline: 217 attaches OYA, OYAYO and OYYAT to OYAKC written next to Oyak',
    pg_temp.tags218('OYAKC hisseleri rekor kırdı, Oyak Çimento yatırım yaptı', '', 'ekonomi', true), 'OYA,OYAKC,OYAYO,OYYAT');
end $$;
rollback;

-- Apply 218 TWICE: a re-apply changes nothing. -------------------------------------------------------------------------------------
\ir ../../../supabase/migrations/218_alias_sibling_code_wins.sql
create temp table after_218_first as
  select md5(prosrc) as m, proacl::text as acl, (select count(*) from public.bist_alias_blocks) as nb, (select count(*) from public.bist_aliases) as na,
         (select count(*) from supabase_migrations.schema_migrations where version = '218') as nl
    from pg_proc where oid = 'public.resolve_article_tickers_for(uuid[])'::regprocedure;
\ir ../../../supabase/migrations/218_alias_sibling_code_wins.sql

-- 1. The new fingerprint and attributes, the grants and the ledger (the second apply left the first apply's result: idempotent). ------
do $$
declare r record; f record;
begin
  select md5(prosrc) as m, length(prosrc) as len, prosecdef, provolatile, proconfig as cfg, pg_get_function_result(oid) as res,
         pg_get_function_arguments(oid) as args, proacl::text as acl
    into r from pg_proc where oid = 'public.resolve_article_tickers_for(uuid[])'::regprocedure;
  if r.m <> '9423af074e20589a80d4765915f5749c' or r.len <> 3919 then
    raise exception '218 resolver fingerprint is not the shipped one: md5 %, length %', r.m, r.len;
  end if;
  if r.prosecdef or r.provolatile <> 'v' or r.cfg is distinct from array['search_path=""']::text[] or r.res <> 'integer' or r.args <> 'p_ids uuid[]' then
    raise exception '218 resolver attributes are not the shipped ones: %', r;
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'resolve_article_tickers_for') <> 1 then
    raise exception '218 left more than one resolve_article_tickers_for';
  end if;
  if has_function_privilege('anon', 'public.resolve_article_tickers_for(uuid[])', 'execute')
     or has_function_privilege('authenticated', 'public.resolve_article_tickers_for(uuid[])', 'execute')
     or not has_function_privilege('service_role', 'public.resolve_article_tickers_for(uuid[])', 'execute') then
    raise exception '218 execute privileges are not service_role only';
  end if;
  -- idempotent: the second apply left the first apply's body, ACL, rows and ledger
  select * into f from after_218_first;
  if f.m <> r.m or f.acl is distinct from r.acl or f.nb <> 3 or f.na <> 2 or f.nl <> 1
     or (select count(*) from public.bist_alias_blocks) <> 3 or (select count(*) from public.bist_aliases) <> 2 then
    raise exception '218: the second apply changed something (blocks %, aliases %, ledger rows %)', f.nb, f.na, f.nl;
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '218') <> 1
     or (select name from supabase_migrations.schema_migrations where version = '218') <> '218_alias_sibling_code_wins'
     or (select count(*) from supabase_migrations.schema_migrations where version = '217') <> 1
     or (select count(*) from supabase_migrations.schema_migrations where version = '178') <> 1 then
    raise exception '218: the ledger rows are not one 218_alias_sibling_code_wins row plus 217''s and 178''s';
  end if;
  -- no table, no data change: 217's rows only, no fixture row anywhere
  if exists (select 1 from public.bist_companies) or exists (select 1 from public.article_tickers) or exists (select 1 from public.articles) then
    raise exception '218: a table holds a row it should not';
  end if;
end $$;

-- 2. The six scenarios, on the shipped function. Each scenario writes its fixtures inside its own begin ... rollback. ------------------------------------
-- S1: the story writes BTCIM and its description names Batiçim: BTCIM only, never BSOKE.
begin;
select pg_temp.seed218();
do $$
begin
  perform pg_temp.expect218('S1 a story writing BTCIM gives BTCIM only',
    pg_temp.tags218('SPK''dan BTCIM hisselerine işlem yasağı',
      'Sermaye Piyasası Kurulu, Batıçim Çimento hisselerinde işlem yapılmasını yasakladı.', 'ekonomi'), 'BTCIM');
  -- the same, with the code in the description (the headline says only Batiçim): the code anywhere in the title or description counts
  perform pg_temp.expect218('S1 the code in the description counts',
    pg_temp.tags218('SPK''den Batıçim hisselerine işlem yasağı', 'Yasak kapsamındaki pay BTCIM kodlu hisse.', 'ekonomi'), 'BTCIM');
end $$;
rollback;

-- S2: no code anywhere: both siblings, as before (the known limit, 171's bucket C).
begin;
select pg_temp.seed218();
do $$
begin
  perform pg_temp.expect218('S2 a text with no code keeps both siblings',
    pg_temp.tags218('SPK''den Batıçim hisselerine işlem yasağı', '', 'ekonomi', false, true), 'BSOKE:alias:baticim,BTCIM:alias:baticim');
end $$;
rollback;

-- S3: both codes written: both, by code (rule D drops both alias rows, each code attaches its own ticker). And Y still attaches by its own code:
-- BSOKE written next to Batiçim gives BSOKE, while BTCIM (a sibling named by no code) drops.
begin;
select pg_temp.seed218();
do $$
begin
  perform pg_temp.expect218('S3 both codes written give both',
    pg_temp.tags218('Batıçim: BTCIM ve BSOKE hisseleri tavan oldu', '', 'ekonomi', false, true), 'BSOKE:code,BTCIM:code');
  perform pg_temp.expect218('S3 Y still attaches by its own code: Batıçim (BSOKE) gives BSOKE',
    pg_temp.tags218('Batıçim (BSOKE) hisse bilanço beklentisi', '', 'ekonomi'), 'BSOKE');
end $$;
rollback;

-- S4: a manual row is never dropped. TSKB is manual on 'tskb'; TSGYO is an auto sibling written by its code.
begin;
select pg_temp.seed218();
do $$
begin
  perform pg_temp.expect218('S4 a manual row is never dropped',
    pg_temp.tags218('TSKB ve iştiraki (TSGYO) için yeni karar', '', 'ekonomi'), 'TSGYO,TSKB');
  -- the same with TSKB written in mixed case, so TSKB can only come from its manual alias row: rule D must not drop it for TSGYO's code
  perform pg_temp.expect218('S4 a manual row is never dropped, TSKB by its alias row only',
    pg_temp.tags218('Tskb Bankası ve iştiraki (TSGYO) için yeni karar', '', 'ekonomi', false, true), 'TSGYO:code,TSKB:alias:tskb');
end $$;
rollback;

-- S5: DEVA is in ticker_code_stoplist(); written bare it fails code_hits' gate, so it is not a code hit and rule D does not fire: both siblings attach.
-- The same code in parentheses passes the gate, so it is a code hit and rule D fires: XMRKA drops, DEVA stays.
begin;
select pg_temp.seed218();
do $$
begin
  perform pg_temp.expect218('S5 a sibling code that fails the code gate does not trigger D',
    pg_temp.tags218('Xmarka ile DEVA arasında ortaklık anlaşması', '', 'ekonomi', false, true), 'DEVA:alias:xmarka,XMRKA:alias:xmarka');
  perform pg_temp.expect218('S5 the same code written in parentheses passes the gate and wins',
    pg_temp.tags218('Xmarka ile (DEVA) arasında ortaklık anlaşması', '', 'ekonomi'), 'DEVA');
end $$;
rollback;

-- S6: OYAKC written next to Oyak: OYAKC only, never OYA, OYAYO or OYYAT.
begin;
select pg_temp.seed218();
do $$
begin
  perform pg_temp.expect218('S6 OYAKC written next to Oyak gives OYAKC only',
    pg_temp.tags218('OYAKC hisseleri rekor kırdı, Oyak Çimento yatırım yaptı', '', 'ekonomi'), 'OYAKC');
end $$;
rollback;

-- S7 (beyond the spec's six): the sibling must be an ENABLED alias row. QSIBL shares 'qmarka' but its alias row is disabled, so its code in the text does not drop QMRKA's row.
begin;
select pg_temp.seed218();
select pg_temp.al218('qmarka', 'QMRKA', 'auto');
insert into public.bist_aliases (alias, ticker, origin, enabled) values ('qmarka', 'QSIBL', 'auto', false);
select pg_temp.co218(array['QMRKA'], true), pg_temp.co218(array['QSIBL'], true);
do $$
begin
  perform pg_temp.expect218('S7 a disabled sibling alias row does not trigger D',
    pg_temp.tags218('Qmarka ve (QSIBL) hisse haberi', '', 'ekonomi'), 'QMRKA,QSIBL');
end $$;
rollback;

-- S8 (beyond the spec's six): only a code of a ticker that SHARES the alias triggers D. BTCIM is written but does not share 'oyak', so the four oyak siblings still attach as under 217.
begin;
select pg_temp.seed218();
do $$
begin
  perform pg_temp.expect218('S8 a code that does not share the alias does not trigger D',
    pg_temp.tags218('Oyak Çimento ve BTCIM hisseleri', '', 'ekonomi'), 'BTCIM,OYA,OYAKC,OYAYO,OYYAT');
  perform pg_temp.expect218('S8 the same text under 217 gives the same tickers',
    pg_temp.tags218('Oyak Çimento ve BTCIM hisseleri', '', 'ekonomi', true), 'BTCIM,OYA,OYAKC,OYAYO,OYYAT');
end $$;
rollback;

-- The rest of the resolver is untouched: 217's rule C and 171's rules A and B still hold, the sports desk is still skipped and outside finance context only a code attaches.
begin;
select pg_temp.seed218();
do $$
begin
  perform pg_temp.expect218('rule C is untouched: Sümer Holding gives no SMRVA',
    pg_temp.tags218('Sümer Holding''e ait taşınmaz özelleştirilecek', '', 'ekonomi'), '-');
  perform pg_temp.expect218('rule C is untouched: Sümer Varlık gives SMRVA',
    pg_temp.tags218('Sümer Varlık Yönetim A.Ş. net kar açıkladı', '', 'ekonomi'), 'SMRVA');
  perform pg_temp.expect218('rule B is untouched: Anel with ANELE written gives ANELE only',
    pg_temp.tags218('ANELE hisse bilanço beklentisi, Anel Elektrik', '', 'ekonomi'), 'ANELE');
  perform pg_temp.expect218('rule B is untouched: Anel alone gives ANELE only (ANELT is untraded)',
    pg_temp.tags218('Anel Elektrik hisse bilanço beklentisi', '', 'ekonomi'), 'ANELE');
  perform pg_temp.expect218('the sports desk is skipped',
    pg_temp.tags218('SPK''dan BTCIM hisselerine işlem yasağı', '', 'spor'), '-');
  perform pg_temp.expect218('outside finance context only the code attaches',
    pg_temp.tags218('BTCIM bugün gündemde', 'Batıçim haberi', 'genel', false, true), 'BTCIM:code');
end $$;
rollback;

-- 3. Differential: a session copy of 217's function against 218's over a mixed set of headlines. 218 attaches a subset of what 217 attaches, and the pairs it
--    drops are exactly rule D's: a sibling's auto alias row next to another sibling's code. Every headline is inserted twice (ids 1xx through the copy,
--    ids 2xx through 218): no row is deleted. -----------------------------------------------------------------------------------------------
begin;
select pg_temp.seed218();
create temp table d218 (i int, title text, descr text, cat text, want_old text, want_new text) on commit drop;
insert into d218 values
  (0, 'SPK''dan BTCIM hisselerine işlem yasağı', 'Sermaye Piyasası Kurulu, Batıçim Çimento hisselerinde işlem yapılmasını yasakladı.', 'ekonomi', 'BSOKE,BTCIM', 'BTCIM'),
  (1, 'SPK''den Batıçim hisselerine işlem yasağı', '', 'ekonomi', 'BSOKE,BTCIM', 'BSOKE,BTCIM'),
  (2, 'Batıçim: BTCIM ve BSOKE hisseleri tavan oldu', '', 'ekonomi', 'BSOKE,BTCIM', 'BSOKE,BTCIM'),
  (3, 'TSKB ve iştiraki (TSGYO) için yeni karar', '', 'ekonomi', 'TSGYO,TSKB', 'TSGYO,TSKB'),
  (4, 'Tskb Bankası ve iştiraki (TSGYO) için yeni karar', '', 'ekonomi', 'TSGYO,TSKB', 'TSGYO,TSKB'),
  (5, 'Xmarka ile DEVA arasında ortaklık anlaşması', '', 'ekonomi', 'DEVA,XMRKA', 'DEVA,XMRKA'),
  (6, 'Xmarka ile (DEVA) arasında ortaklık anlaşması', '', 'ekonomi', 'DEVA,XMRKA', 'DEVA'),
  (7, 'OYAKC hisseleri rekor kırdı, Oyak Çimento yatırım yaptı', '', 'ekonomi', 'OYA,OYAKC,OYAYO,OYYAT', 'OYAKC'),
  (8, 'Borsa güne yatay başladı', '', 'ekonomi', '-', '-'),
  (9, 'Batıçim (BSOKE) hisse bilanço beklentisi', '', 'ekonomi', 'BSOKE,BTCIM', 'BSOKE'),
  (10, 'Anel Elektrik hisse bilanço beklentisi', '', 'ekonomi', 'ANELE', 'ANELE'),
  (11, 'Sümer Holding''e ait taşınmaz özelleştirilecek', '', 'ekonomi', '-', '-'),
  (12, 'BTCIM bugün gündemde', 'Batıçim haberi', 'genel', 'BTCIM', 'BTCIM'),
  (13, 'Sümer Varlık Yönetim A.Ş. net kar açıkladı', '', 'ekonomi', 'SMRVA', 'SMRVA');
insert into public.articles (id, title, description, category, published_at)
  select ('a0000000-0000-0000-0000-' || lpad((100 + i)::text, 12, '0'))::uuid, title, descr, cat, now() from d218
  union all
  select ('a0000000-0000-0000-0000-' || lpad((200 + i)::text, 12, '0'))::uuid, title, descr, cat, now() from d218;
select pg_temp.resolve_article_tickers_217(array(select id from public.articles where id < 'a0000000-0000-0000-0000-000000000200'::uuid));
select public.resolve_article_tickers_for(array(select id from public.articles where id >= 'a0000000-0000-0000-0000-000000000200'::uuid));
do $$
declare r record; bad text := ''; n_old int; n_new int; n_added int;
begin
  for r in
    select c.i, c.title, c.want_old, c.want_new,
           coalesce((select string_agg(t.ticker, ',' order by t.ticker) from public.article_tickers t
                      where t.article_id = ('a0000000-0000-0000-0000-' || lpad((100 + c.i)::text, 12, '0'))::uuid), '-') as got_old,
           coalesce((select string_agg(t.ticker, ',' order by t.ticker) from public.article_tickers t
                      where t.article_id = ('a0000000-0000-0000-0000-' || lpad((200 + c.i)::text, 12, '0'))::uuid), '-') as got_new
      from d218 c order by c.i
  loop
    if r.got_old <> r.want_old or r.got_new <> r.want_new then
      bad := bad || format('[%s] %s: 217 gave %s (want %s), 218 gave %s (want %s) ', r.i, r.title, r.got_old, r.want_old, r.got_new, r.want_new);
    end if;
  end loop;
  if bad <> '' then raise exception '218 differential: %', bad; end if;
  select count(*) into n_old from public.article_tickers where article_id < 'a0000000-0000-0000-0000-000000000200'::uuid;
  select count(*) into n_new from public.article_tickers where article_id >= 'a0000000-0000-0000-0000-000000000200'::uuid;
  -- 218 attaches exactly 6 pairs fewer than 217 on these headlines: BSOKE x1 (the BTCIM story), XMRKA x1 ((DEVA)), OYA, OYAYO and OYYAT x3 (OYAKC) and BTCIM x1
  -- (Batiçim (BSOKE)). The per-headline equalities above already pin every pair; the second count says the change adds none (an added pair would shrink the
  -- difference) and the third that no pair exists on the 218 side only.
  if n_old - n_new <> 6 then
    raise exception '218 differential: expected 6 dropped pairs, got % (217 % rows, 218 % rows)', n_old - n_new, n_old, n_new;
  end if;
  select count(*) into n_added from public.article_tickers n
   where n.article_id >= 'a0000000-0000-0000-0000-000000000200'::uuid
     and not exists (select 1 from public.article_tickers o
                      where o.article_id = ('a0000000-0000-0000-0000-' || lpad((right(n.article_id::text, 12)::int - 100)::text, 12, '0'))::uuid
                        and o.ticker = n.ticker);
  if n_added <> 0 then
    raise exception '218 differential: % pair(s) exist under 218 and not under 217', n_added;
  end if;
end $$;
rollback;

-- 4. Idempotent and read-only: a second call inserts nothing and no block, alias or company row changes. --------------------------------
begin;
select pg_temp.seed218();
insert into public.articles (id, title, description, category, published_at) values
  ('a0000000-0000-0000-0000-0000000000a1', 'SPK''dan BTCIM hisselerine işlem yasağı', 'Batıçim Çimento hisselerinde işlem yasağı.', 'ekonomi', now());
do $$
declare first_call int; second_call int; b int; a int; c int;
begin
  select count(*) into b from public.bist_alias_blocks;
  select count(*) into a from public.bist_aliases;
  select count(*) into c from public.bist_companies;
  first_call := public.resolve_article_tickers_for(array['a0000000-0000-0000-0000-0000000000a1'::uuid]);
  second_call := public.resolve_article_tickers_for(array['a0000000-0000-0000-0000-0000000000a1'::uuid]);
  if first_call <> 1 or second_call <> 0 then raise exception '218: expected 1 then 0 inserted rows, got % then %', first_call, second_call; end if;
  if (select count(*) from public.bist_alias_blocks) <> b or (select count(*) from public.bist_aliases) <> a or (select count(*) from public.bist_companies) <> c then
    raise exception '218: the resolver changed a block, alias or company row';
  end if;
end $$;
rollback;

-- 5. TIME BUDGET. 171's rule: the 058 trigger calls the resolver once per inserted row inside the ingest upsert (PostgREST, authenticator's 8 s
--    statement_timeout; a 57014 is not catchable), so one article must cost about what it cost under 217 (~1 ms). Rule D runs only on the alias rows
--    that matched the text (alias_matches is MATERIALIZED) and reads code_hits, which is materialized once (it is read twice now). ~2,000 enabled auto
--    aliases in shared pairs of untraded tickers, ~2,000 traded companies, and (a) one finance-context article that matches none of the aliases, best
--    of 3 under 50 ms, then (b) an article where D fires (the BTCIM story: BSOKE's alias row is dropped), under the same 50 ms.
begin;
select pg_temp.seed218();
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
    raise exception '218: the time-budget fixture is not 2,000 aliases and 2,000 companies';
  end if;
  perform public.resolve_article_tickers_for(array[gen_random_uuid()]);  -- warm-up: compiles the plpgsql body, not timed
  for i in 1..3 loop
    insert into public.articles (id, title, description, category, published_at)
      values (gen_random_uuid(), 'Borsa güne yatay başladı ' || i, '', 'ekonomi', now()) returning id into v_id;
    v_t0 := clock_timestamp();
    v_n := public.resolve_article_tickers_for(array[v_id]);
    v_one := extract(epoch from clock_timestamp() - v_t0) * 1000;
    if v_n <> 0 then raise exception '218: the time-budget article matches none of the aliases, yet % rows were inserted', v_n; end if;
    v_ms := least(v_ms, v_one);
  end loop;
  if v_ms > 50 then
    raise exception '218: one article took % ms against 2,000 shared untraded auto aliases and 2,000 companies (budget 50 ms): rule D runs on every alias row, not on the rows that matched the text', round(v_ms, 1);
  end if;
  raise notice '218: time budget ok, % ms for one non-matching article (best of 3)', round(v_ms, 1);
  -- (b) an article where D fires: the rule drops BSOKE's alias row and the cost stays in budget
  v_ms := 1000000;
  for i in 1..3 loop
    insert into public.articles (id, title, description, category, published_at)
      values (gen_random_uuid(), 'SPK''dan BTCIM hisselerine işlem yasağı ' || i, 'Batıçim Çimento hisselerinde işlem yasağı.', 'ekonomi', now()) returning id into v_id;
    v_t0 := clock_timestamp();
    v_n := public.resolve_article_tickers_for(array[v_id]);
    v_one := extract(epoch from clock_timestamp() - v_t0) * 1000;
    if v_n <> 1 then raise exception '218: the BTCIM story should attach exactly BTCIM, got % rows', v_n; end if;
    v_ms := least(v_ms, v_one);
  end loop;
  if v_ms > 50 then
    raise exception '218: a BTCIM story took % ms against 2,000 shared untraded auto aliases and 2,000 companies (budget 50 ms)', round(v_ms, 1);
  end if;
  raise notice '218: time budget ok, % ms for an article where D fires (best of 3)', round(v_ms, 1);
end $$;
rollback;

-- 6. Nothing was left behind by the scenarios above except 217's own rows and 218's ledger row. -----------------------------------------
do $$
begin
  if exists (select 1 from public.bist_companies) or exists (select 1 from public.articles) or exists (select 1 from public.article_tickers) then
    raise exception 'a rolled-back fixture survived';
  end if;
  if (select count(*) from public.bist_aliases) <> 2 or (select count(*) from public.bist_alias_blocks) <> 3 then
    raise exception '218 left the wrong number of block or alias rows behind';
  end if;
end $$;

select 'DRYRUN 218 OK';
