-- 200 neutral_title_stale_quote_aware (the stale-title key reads quotation marks: a member that writes a span in quotes does not
-- carry a stored title that writes it bare): local PG15 dry-run. Never touches production.
--
-- Run once, on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each run
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55600 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55600 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/200-stale-quote-aware-dryrun.sql
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh    (only once a manifest entry names this script: the 200 test is static, so none yet)
--
-- (\ir paths below are relative to this file.) Every check is a DO block or a pg_temp function that raises on mismatch, so a
-- clean run ending in "DRYRUN 200 OK" is the pass. Every scenario that writes sits inside begin ... rollback, so the database
-- this leaves behind has 162, 169, 184 and 200 applied and holds no fixture rows.
--
-- Why it exists. 200's JS test (tests/migrations/200-stale-quote-aware.test.ts) reads the SQL as text and runs a JavaScript
-- spelling of its key; this runs the SHIPPED function in PostgreSQL, the lookbehind and lookahead regular expression included:
-- that the baseline (production's 184 body, md5 pinned) does not offer a cluster whose stored title is only carried by members
-- that quote the span, that 200 offers it, that a member carrying the title bare, a title typed with curly against straight
-- quotes, a title wrapped in quotes, a literal chr(1) or a literal pipe do not change the verdict the way a quote does, that
-- everything 162, 169 and 184 offered is still offered, that the cluster leaves the set once the cron writes a member's
-- wording, and that applying 200 twice leaves one body, one comment and one ledger row.
--
-- Order: the state 200 sits on is exactly 184's dry-run (which runs 169's: the stamp columns of 141 and 155, 129's fold, 162 from
-- its own file, then 169 and 184 twice, every scenario of theirs checked); this file runs it, shows the defect on 184's body,
-- records what 184 offers for a set of quote-free fixtures, then applies 200 TWICE and runs the scenarios.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Prelude: 184's state (its own dry-run, which ends clean). --------------------------------------------------------------------
\ir 184-repick-young-shout-dryrun.sql

-- Fixture helpers (session-local). Cluster n has uuid c2000000-...-<n>; its k-th article a2000000-...-<n>-<k>.
create function pg_temp.cu200(n int) returns uuid language sql immutable as
  $f$ select ('c2000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $f$;
create function pg_temp.au200(n int, k int) returns uuid language sql immutable as
  $f$ select ('a2000000-0000-0000-' || lpad(n::text, 4, '0') || '-' || lpad(k::text, 12, '0'))::uuid $f$;
-- One cluster: n, stored title, the stamp, the live article_count (stamp = count: no growth branch fires), optional model / age.
create function pg_temp.fx200(n int, p_title text, stamped int, cnt int,
                              p_model text default 'extractive-v6', age interval default interval '1 day')
returns void language sql as $f$
  insert into public.clusters (id, title_tr_neutral, title_neutral_model, title_neutral_member_count, article_count,
                               is_archived, title_neutral_at, updated_at)
  values (pg_temp.cu200(n), p_title, p_model, stamped, cnt, false, null, now() - age)
$f$;
-- One member of cluster n: its k-th article with the given title.
create function pg_temp.mem200(n int, k int, p_title text) returns void language sql as $f$
  with a as (insert into public.articles (id, title) values (pg_temp.au200(n, k), p_title) returning id)
  insert into public.cluster_articles (cluster_id, article_id) select pg_temp.cu200(n), id from a
$f$;
-- One article_title_versions row for the k-th article of cluster n: the title the outlet had before an edit.
create function pg_temp.old200(n int, k int, p_old text, age interval default interval '3 days') returns void language sql as $f$
  insert into public.article_title_versions (article_id, old_title, new_title, seen_at)
  values (pg_temp.au200(n, k), p_old, 'edited', now() - age)
$f$;
-- The fixture numbers the function offers for extractive-v6, ascending, as text ("-" for none).
create function pg_temp.offered200() returns text language sql as $f$
  select coalesce(string_agg(right(id::text, 12)::int::text, ',' order by right(id::text, 12)::int), '-')
    from public.neutral_title_repick_candidates('extractive-v6', 50)
$f$;

-- The quote-free fixtures every release must offer the same way: one scenario, run on 184's body and again on 200's.
create temp table mix200(phase text, offered text);
create function pg_temp.mix200(p_phase text) returns void language plpgsql as $f$
begin
  -- 162: an edited-away title (a plain one, no quote anywhere) is offered; a still-carried one is not
  perform pg_temp.fx200(1, 'Merkez Bankası faiz kararını açıkladı', 3, 3);
  perform pg_temp.mem200(1, 1, 'Merkez Bankası faiz oranını sabit tuttu');
  perform pg_temp.old200(1, 1, 'Merkez Bankası faiz kararını açıkladı');
  perform pg_temp.fx200(2, 'Merkez Bankası faiz kararını açıkladı', 3, 3);
  perform pg_temp.mem200(2, 1, 'Merkez Bankası faiz kararını açıkladı');
  perform pg_temp.old200(2, 1, 'Merkez Bankası faiz kararını açıkladı');
  -- 162: recased and re-separated members still carry it
  perform pg_temp.fx200(3, 'Merkez Bankası faiz kararını açıkladı', 3, 3);
  perform pg_temp.mem200(3, 1, 'MERKEZ BANKASI: FAİZ KARARINI AÇIKLADI');
  perform pg_temp.old200(3, 1, 'Merkez Bankası faiz kararını açıkladı');
  -- 162: the 7 day window
  perform pg_temp.fx200(4, 'Merkez Bankası faiz kararını açıkladı', 3, 3);
  perform pg_temp.mem200(4, 1, 'Merkez Bankası faiz oranını sabit tuttu');
  perform pg_temp.old200(4, 1, 'Merkez Bankası faiz kararını açıkladı', interval '8 days');
  -- 162: the legacy house style is carried
  perform pg_temp.fx200(5, 'Cumhurbaşkanı Erdoğan sert konuştu', 3, 3);
  perform pg_temp.mem200(5, 1, 'Başkan Erdoğan sert konuştu');
  perform pg_temp.old200(5, 1, 'Cumhurbaşkanı Erdoğan sert konuştu');
  -- 169, 184: the other branches
  perform pg_temp.fx200(6, 'Merkez Bankası faiz kararını açıkladı', 2, 3);            -- young
  perform pg_temp.fx200(7, 'NEV''İN MİRASI GÜNDEM OLDU', 2, 2);                       -- shout
  perform pg_temp.fx200(8, 'Merkez Bankası faiz kararını açıkladı', 3, 4);            -- a stamp of 3 waits
  perform pg_temp.fx200(9, 'Merkez Bankası faiz kararını açıkladı', 3, 6);            -- growth by half
  perform pg_temp.fx200(10, 'Merkez Bankası faiz kararını açıkladı', 3, 3, p_model => 'extractive-v5'); -- another model
  -- in-word apostrophes only: curly against straight is carried
  perform pg_temp.fx200(11, 'CHP''nin kurultay davası 18 Kasım''a ertelendi', 3, 3);
  perform pg_temp.mem200(11, 1, 'CHP’nin kurultay davası 18 Kasım’a ertelendi');
  perform pg_temp.old200(11, 1, 'CHP''nin kurultay davası 18 Kasım''a ertelendi');
  insert into mix200 select p_phase, pg_temp.offered200();
end $f$;

-- Baseline: this is production's function (md5(prosrc) read on production on 2026-11-12) with its ACL (owner + service_role,
-- nobody else). ----------------------------------------------------------------------------------------------------------
create temp table before_200 as
  select md5(prosrc) as m, length(prosrc) as len,
         (select string_agg(case when a.grantee = 0 then 'public' else a.grantee::regrole::text end || ':' || a.privilege_type,
                            ',' order by case when a.grantee = 0 then 'public' else a.grantee::regrole::text end)
            from aclexplode(p.proacl) a) as grants,
         proconfig::text as cfg, provolatile, prosecdef, proretset, proowner::regrole::text as owner,
         pg_get_function_result(oid) as res, pg_get_function_arguments(oid) as args, prolang
    from pg_proc p where oid = 'public.neutral_title_repick_candidates(text, integer)'::regprocedure;

do $$
declare b record;
begin
  select * into b from before_200;
  if b.m <> 'f53e452579b59bffc6fbc0f547c852e8' or b.len <> 3040 then
    raise exception 'baseline: the prelude function is not production''s (md5 %, length %)', b.m, b.len;
  end if;
  if b.grants not like '%service_role:EXECUTE%' or b.grants like '%anon%' or b.grants like '%authenticated%' or b.grants like '%public%' then
    raise exception 'baseline: unexpected grants %', b.grants;
  end if;
  if not b.prosecdef or b.provolatile <> 's' or b.cfg is distinct from '{"search_path=\"\""}' or not b.proretset then
    raise exception 'baseline: unexpected attributes (secdef %, volatile %, config %)', b.prosecdef, b.provolatile, b.cfg;
  end if;
end $$;

-- The defect, on the old function (bffb0a3f-shaped). --------------------------------------------------------------------------
-- The stored title is a bare span; the members that still have it write it in quotes; an outlet's old title (inside the last 7
-- days) is the bare one. 184 reads the quotes away, finds the span in the members, and never offers the cluster.
begin;
select pg_temp.fx200(1, 'CHP''nin şaibeli kurultay davası 18 Kasım''a ertelendi', 3, 3);
select pg_temp.mem200(1, 1, 'CHP''nin ''şaibeli kurultay'' davası 18 Kasım''a ertelendi');
select pg_temp.mem200(1, 2, 'CHP’nin “şaibeli kurultay” davası 18 Kasım’a ertelendi');
select pg_temp.mem200(1, 3, 'CHP kurultay davasında yeni karar');
select pg_temp.old200(1, 3, 'CHP''nin şaibeli kurultay davası 18 Kasım''a ertelendi');
do $$
begin
  if pg_temp.offered200() <> '-' then
    raise exception 'baseline: 184 offers a stored title that its members only carry in quotes; offered %', pg_temp.offered200();
  end if;
end $$;
rollback;

-- What 184 offers for the quote-free fixtures: 1 (edited away), 6 (young), 7 (shout), 9 (growth), 10 (another model).
begin;
select pg_temp.mix200('before');
rollback;
do $$
begin
  if (select offered from mix200 where phase = 'before') <> '1,6,7,9,10' then
    raise exception 'baseline: unexpected offered set on 184''s body: %', (select offered from mix200 where phase = 'before');
  end if;
end $$;

-- 200, TWICE (safe to re-apply). ---------------------------------------------------------------------------------------
\ir ../../../supabase/migrations/200_neutral_title_stale_quote_aware.sql
create temp table after_200_first as
  select md5(prosrc) as m, proacl::text as acl from pg_proc where oid = 'public.neutral_title_repick_candidates(text, integer)'::regprocedure;
\ir ../../../supabase/migrations/200_neutral_title_stale_quote_aware.sql

-- 1. The function: new body, everything else as before. -----------------------------------------------------------------
do $$
declare a record; b record; f record;
begin
  select * into b from before_200;
  select md5(prosrc) as m, length(prosrc) as len,
         (select string_agg(case when x.grantee = 0 then 'public' else x.grantee::regrole::text end || ':' || x.privilege_type,
                            ',' order by case when x.grantee = 0 then 'public' else x.grantee::regrole::text end)
            from aclexplode(p.proacl) x) as grants,
         proconfig::text as cfg, provolatile, prosecdef, proretset, proowner::regrole::text as owner,
         pg_get_function_result(oid) as res, pg_get_function_arguments(oid) as args, prolang, prosrc
    into a from pg_proc p where oid = 'public.neutral_title_repick_candidates(text, integer)'::regprocedure;

  if a.m <> 'e007128d452df4902001859882d322b8' or a.len <> 5028 then
    raise exception '200: unexpected body (md5 %, length %)', a.m, a.len;
  end if;
  if a.m = b.m then raise exception '200: the body did not change'; end if;
  if position('pg_catalog.chr(1)' in a.prosrc) = 0 then raise exception '200: the body does not use the chr(1) sentinel'; end if;
  if a.grants is distinct from b.grants then raise exception '200: grants changed: % -> %', b.grants, a.grants; end if;
  if a.cfg is distinct from b.cfg or a.provolatile <> b.provolatile or a.prosecdef <> b.prosecdef or a.proretset <> b.proretset
     or a.owner <> b.owner or a.res <> b.res or a.args <> b.args or a.prolang <> b.prolang then
    raise exception '200: an attribute other than the body changed';
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'neutral_title_repick_candidates') <> 1 then
    raise exception '200: more than one neutral_title_repick_candidates overload';
  end if;
  -- the second apply left the first apply's result
  select * into f from after_200_first;
  if f.m <> a.m then raise exception '200: the second apply changed the body'; end if;
  if has_function_privilege('anon', 'public.neutral_title_repick_candidates(text, integer)', 'execute')
     or has_function_privilege('authenticated', 'public.neutral_title_repick_candidates(text, integer)', 'execute')
     or not has_function_privilege('service_role', 'public.neutral_title_repick_candidates(text, integer)', 'execute') then
    raise exception '200: execute privileges are not service_role only';
  end if;
  if obj_description('public.neutral_title_repick_candidates(text, integer)'::regprocedure, 'pg_proc') not like '%Migrations 141, 155, 162, 169, 184, 200.' then
    raise exception '200: the function comment does not end with the migration list 141, 155, 162, 169, 184, 200';
  end if;
  -- 184 and 200 each recorded their own ledger row, once even though 200 was applied twice
  if (select count(*) from supabase_migrations.schema_migrations where version = '200') <> 1
     or (select name from supabase_migrations.schema_migrations where version = '200') <> '200_neutral_title_stale_quote_aware' then
    raise exception '200: the ledger row is not exactly one row named 200_neutral_title_stale_quote_aware';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version in ('162', '169', '184')) <> 3 then
    raise exception '200: 162''s, 169''s or 184''s ledger row changed';
  end if;
  -- no table was touched
  if exists (select 1 from public.clusters) then raise exception '200: a cluster row survived'; end if;
end $$;

-- 2. The fix, on the live shape (bffb0a3f): the stored title is bare, the members quote the span (straight, curly, guillemets), an
--    outlet's old title inside the last 7 days is the bare one. ---------------------------------------------------------------------
begin;
select pg_temp.fx200(1, 'CHP''nin şaibeli kurultay davası 18 Kasım''a ertelendi', 3, 3);
select pg_temp.mem200(1, 1, 'CHP''nin ''şaibeli kurultay'' davası 18 Kasım''a ertelendi');
select pg_temp.mem200(1, 2, 'CHP’nin “şaibeli kurultay” davası 18 Kasım’a ertelendi');
select pg_temp.mem200(1, 3, 'CHP kurultay davasında yeni karar');
select pg_temp.old200(1, 3, 'CHP''nin şaibeli kurultay davası 18 Kasım''a ertelendi');
do $$
begin
  if pg_temp.offered200() <> '1' then
    raise exception '200: the bffb0a3f-shaped cluster should be offered; offered %', pg_temp.offered200();
  end if;
end $$;
rollback;

-- 3. The same cluster with one member carrying the title bare: not offered (fixture 2). -------------------------------------------
begin;
select pg_temp.fx200(1, 'CHP''nin şaibeli kurultay davası 18 Kasım''a ertelendi', 3, 4);
select pg_temp.mem200(1, 1, 'CHP''nin ''şaibeli kurultay'' davası 18 Kasım''a ertelendi');
select pg_temp.mem200(1, 2, 'CHP’nin “şaibeli kurultay” davası 18 Kasım’a ertelendi');
select pg_temp.mem200(1, 3, 'CHP kurultay davasında yeni karar');
select pg_temp.mem200(1, 4, 'Son dakika! CHP''nin şaibeli kurultay davası 18 Kasım''a ertelendi');
select pg_temp.old200(1, 3, 'CHP''nin şaibeli kurultay davası 18 Kasım''a ertelendi');
do $$
begin
  if pg_temp.offered200() <> '-' then
    raise exception '200: a member that carries the stored title bare must keep the cluster out; offered %', pg_temp.offered200();
  end if;
end $$;
rollback;

-- 4. Every quotation mark is the same mark, outside a word and in the middle of the title. -----------------------------------------
begin;
select pg_temp.fx200(1, 'Bakan zam yok dedi ve açıkladı', 3, 3);   select pg_temp.mem200(1, 1, 'Bakan ''zam yok'' dedi ve açıkladı');
select pg_temp.fx200(2, 'Bakan zam yok dedi ve açıkladı', 3, 3);   select pg_temp.mem200(2, 1, 'Bakan “zam yok” dedi ve açıkladı');
select pg_temp.fx200(3, 'Bakan zam yok dedi ve açıkladı', 3, 3);   select pg_temp.mem200(3, 1, 'Bakan "zam yok" dedi ve açıkladı');
select pg_temp.fx200(4, 'Bakan zam yok dedi ve açıkladı', 3, 3);   select pg_temp.mem200(4, 1, 'Bakan «zam yok» dedi ve açıkladı');
select pg_temp.fx200(5, 'Bakan zam yok dedi ve açıkladı', 3, 3);   select pg_temp.mem200(5, 1, 'Bakan ‘zam yok’ dedi ve açıkladı');
select pg_temp.fx200(6, 'Bakan zam yok dedi ve açıkladı', 3, 3);   select pg_temp.mem200(6, 1, 'Bakan zam yok dedi ve açıkladı');   -- bare: carried
select pg_temp.old200(1, 1, 'Bakan zam yok dedi ve açıkladı');
select pg_temp.old200(2, 1, 'Bakan zam yok dedi ve açıkladı');
select pg_temp.old200(3, 1, 'Bakan zam yok dedi ve açıkladı');
select pg_temp.old200(4, 1, 'Bakan zam yok dedi ve açıkladı');
select pg_temp.old200(5, 1, 'Bakan zam yok dedi ve açıkladı');
select pg_temp.old200(6, 1, 'Bakan zam yok dedi ve açıkladı');
do $$
begin
  if pg_temp.offered200() <> '1,2,3,4,5' then
    raise exception '200: every quotation mark should make the member quote the span; offered %', pg_temp.offered200();
  end if;
end $$;
rollback;

-- 5. What the old key made equal stays equal. ------------------------------------------------------------------------------------------
begin;
-- (1) curly against straight in-word apostrophes
select pg_temp.fx200(1, 'CHP''nin kurultay davası 18 Kasım''a ertelendi', 3, 3);
select pg_temp.mem200(1, 1, 'CHP’nin kurultay davası 18 Kasım’a ertelendi');
select pg_temp.old200(1, 1, 'CHP''nin kurultay davası 18 Kasım''a ertelendi');
-- (2) a stored title wrapped in quotes, carried by the bare member (the pinned h94 test), and the reverse
select pg_temp.fx200(2, '"Diplomatik çözüm için çalışıyoruz"', 3, 3);
select pg_temp.mem200(2, 1, 'Diplomatik çözüm için çalışıyoruz');
select pg_temp.old200(2, 1, '"Diplomatik çözüm için çalışıyoruz"');
select pg_temp.fx200(3, 'Diplomatik çözüm için çalışıyoruz', 3, 3);
select pg_temp.mem200(3, 1, '“Diplomatik çözüm için çalışıyoruz”');
select pg_temp.old200(3, 1, 'Diplomatik çözüm için çalışıyoruz');
-- (3) a stray leading quote the cleaning dropped
select pg_temp.fx200(4, 'Kaşif Kozinoğlu''nun ATK raporu: ''Ölüm nedeni'' açıklandı', 3, 3);
select pg_temp.mem200(4, 1, '''Kaşif Kozinoğlu''nun ATK raporu: ''Ölüm nedeni'' açıklandı');
select pg_temp.old200(4, 1, 'Kaşif Kozinoğlu''nun ATK raporu: ''Ölüm nedeni'' açıklandı');
-- (4) a literal pipe is a separator, not a quote
select pg_temp.fx200(5, 'Merkez Bankası faiz kararını açıkladı', 3, 3);
select pg_temp.mem200(5, 1, 'Merkez Bankası | faiz kararını açıkladı');
select pg_temp.old200(5, 1, 'Merkez Bankası faiz kararını açıkladı');
-- (5) a literal chr(1) in a member title is not a quote: it is removed first
select pg_temp.fx200(6, 'Bakan zam yok dedi ve açıkladı', 3, 3);
select pg_temp.mem200(6, 1, 'Bakan ' || chr(1) || 'zam yok' || chr(1) || ' dedi ve açıkladı');
select pg_temp.old200(6, 1, 'Bakan zam yok dedi ve açıkladı');
-- (6) the legacy 'Başkan Erdoğan' wording is carried
select pg_temp.fx200(7, 'Cumhurbaşkanı Erdoğan sert konuştu', 3, 3);
select pg_temp.mem200(7, 1, 'Başkan Erdoğan sert konuştu');
select pg_temp.old200(7, 1, 'Cumhurbaşkanı Erdoğan sert konuştu');
-- (7) a lead-in and a different case
select pg_temp.fx200(8, 'CHP kurultay davası 18 Kasım''a ertelendi', 3, 3);
select pg_temp.mem200(8, 1, 'SON DAKİKA | CHP KURULTAY DAVASI 18 KASIM''A ERTELENDİ');
select pg_temp.old200(8, 1, 'CHP kurultay davası 18 Kasım''a ertelendi');
do $$
begin
  if pg_temp.offered200() <> '-' then
    raise exception '200: a title the old key judged carried must stay carried; offered %', pg_temp.offered200();
  end if;
end $$;
rollback;

-- 6. What is offered besides the quote case. ---------------------------------------------------------------------------------------------
begin;
-- (1) a quote that closes inside the title is a quoted span even when the title opens with its opening mark
select pg_temp.fx200(1, 'Ölüm nedeni açıklandı', 3, 3);
select pg_temp.mem200(1, 1, '''Ölüm nedeni'' açıklandı');
select pg_temp.old200(1, 1, 'Ölüm nedeni açıklandı');
-- (2) the legacy house style, quoted in the member
select pg_temp.fx200(2, 'Cumhurbaşkanı Erdoğan sert konuştu', 3, 3);
select pg_temp.mem200(2, 1, 'Başkan Erdoğan ''sert'' konuştu');
select pg_temp.old200(2, 1, 'Cumhurbaşkanı Erdoğan sert konuştu');
-- (3) the old title has to be inside the last 7 days: an 8 day old one does not offer the cluster
select pg_temp.fx200(3, 'CHP''nin şaibeli kurultay davası 18 Kasım''a ertelendi', 3, 3);
select pg_temp.mem200(3, 1, 'CHP''nin ''şaibeli kurultay'' davası 18 Kasım''a ertelendi');
select pg_temp.old200(3, 1, 'CHP''nin şaibeli kurultay davası 18 Kasım''a ertelendi', interval '8 days');
-- (4) the old title is the quoted wording: the bare stored title is not in it
select pg_temp.fx200(4, 'CHP''nin şaibeli kurultay davası 18 Kasım''a ertelendi', 3, 3);
select pg_temp.mem200(4, 1, 'CHP kurultay davasında yeni karar');
select pg_temp.old200(4, 1, 'CHP''nin ''şaibeli kurultay'' davası 18 Kasım''a ertelendi');
-- (5) an LLM title and an archived cluster are never offered, quotes or not
select pg_temp.fx200(5, 'CHP''nin şaibeli kurultay davası 18 Kasım''a ertelendi', 3, 3);
select pg_temp.mem200(5, 1, 'CHP''nin ''şaibeli kurultay'' davası 18 Kasım''a ertelendi');
select pg_temp.old200(5, 1, 'CHP''nin şaibeli kurultay davası 18 Kasım''a ertelendi');
update public.clusters set title_neutral_at = now() where id = pg_temp.cu200(5);
select pg_temp.fx200(6, 'CHP''nin şaibeli kurultay davası 18 Kasım''a ertelendi', 3, 3);
select pg_temp.mem200(6, 1, 'CHP''nin ''şaibeli kurultay'' davası 18 Kasım''a ertelendi');
select pg_temp.old200(6, 1, 'CHP''nin şaibeli kurultay davası 18 Kasım''a ertelendi');
update public.clusters set is_archived = true where id = pg_temp.cu200(6);
do $$
begin
  if pg_temp.offered200() <> '1,2' then
    raise exception '200: expected only the quoted-span clusters 1 and 2 to be offered; offered %', pg_temp.offered200();
  end if;
end $$;
rollback;

-- 7. Everything 162, 169 and 184 offered is still offered, and nothing else is (the quote-free fixtures of the baseline). ------------
begin;
select pg_temp.mix200('after');
rollback;
do $$
begin
  if (select offered from mix200 where phase = 'after') is distinct from (select offered from mix200 where phase = 'before') then
    raise exception '200: the quote-free fixtures are offered differently: before % / after %',
      (select offered from mix200 where phase = 'before'), (select offered from mix200 where phase = 'after');
  end if;
end $$;

-- 8. No loop: the cron writes a member's own wording and stamps the count, and the cluster leaves. ---------------------------------------
begin;
select pg_temp.fx200(1, 'CHP''nin şaibeli kurultay davası 18 Kasım''a ertelendi', 3, 3);
select pg_temp.mem200(1, 1, 'CHP''nin ''şaibeli kurultay'' davası 18 Kasım''a ertelendi');
select pg_temp.mem200(1, 2, 'CHP''nin kurultay davası 18 Kasım''a ertelendi');
select pg_temp.mem200(1, 3, 'CHP kurultay davasında yeni karar');
select pg_temp.old200(1, 3, 'CHP''nin şaibeli kurultay davası 18 Kasım''a ertelendi');
do $$
declare before_fix text; after_fix text;
begin
  before_fix := pg_temp.offered200();
  update public.clusters set title_tr_neutral = 'CHP''nin kurultay davası 18 Kasım''a ertelendi', title_neutral_member_count = article_count
   where id = pg_temp.cu200(1);
  after_fix := pg_temp.offered200();
  if before_fix <> '1' or after_fix <> '-' then
    raise exception '200: the stale loop is wrong: before % / repaired %', before_fix, after_fix;
  end if;
end $$;
rollback;

-- 9. The bounds are 162's: newest first, limit clamped to 1..50. ------------------------------------------------------------------------
begin;
select pg_temp.fx200(g, 'Merkez Bankası faiz kararını açıkladı', 2, 3, age => g * interval '1 minute') from generate_series(1, 55) g;
do $$
declare first_ids text; n_default int; n_clamped int; n_floor int;
begin
  select string_agg(right(id::text, 12)::int::text, ',') into first_ids
    from (select id from public.neutral_title_repick_candidates('extractive-v6', 3)) s;
  select count(*) into n_default from public.neutral_title_repick_candidates('extractive-v6');
  select count(*) into n_clamped from public.neutral_title_repick_candidates('extractive-v6', 1000);
  select count(*) into n_floor from public.neutral_title_repick_candidates('extractive-v6', 0);
  if first_ids <> '1,2,3' or n_default <> 20 or n_clamped <> 50 or n_floor <> 1 then
    raise exception '200: bounds changed: first % / default % / clamped % / floor %', first_ids, n_default, n_clamped, n_floor;
  end if;
end $$;
rollback;

-- 10. Nothing was left behind by the scenarios above. ----------------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from public.clusters) or exists (select 1 from public.cluster_articles)
     or exists (select 1 from public.article_title_versions) or exists (select 1 from public.articles) then
    raise exception 'a rolled-back fixture survived';
  end if;
end $$;

select 'DRYRUN 200 OK';
