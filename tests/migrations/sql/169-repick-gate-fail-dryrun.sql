-- 169 neutral_title_repick_gate_fail (a stamped cluster whose stored title fails the length or '?' gate is re-offered once it
-- has grown): local PG15 dry-run. Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55569 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55569 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/169-repick-gate-fail-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql PGHOST=/tmp PGPORT=55569 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/169-repick-gate-fail)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh    (TAYF_LIVE_ONLY=169 runs just this one)
--
-- (\ir paths below are relative to this file.) Every check is a DO block or a pg_temp function that raises on
-- mismatch, so a clean run ending in "DRYRUN 169 OK" is the pass. Every scenario that writes sits inside begin ...
-- rollback, so the database this leaves behind has 169 applied and holds no fixture rows.
--
-- Why it exists. 169's JS test (tests/migrations/169-repick-gate-fail.test.ts) reads the SQL as text; this runs the
-- SHIPPED function in PostgreSQL: that the baseline (production's 162 body, md5 pinned) does NOT offer a stamped cluster
-- whose title fails the gate until the growth bar, that 169 offers it as soon as it has grown by one member, that the
-- three gate predicates sit on the right edges (110 / 20 characters, counted in characters, trimmed; a '?'), that
-- everything 162 offered it still offers, and that applying 169 twice leaves one body, one comment and one ledger row.
--
-- Order: the state 169 sits on (clusters gets the two stamp columns production has; the house fold of 129; the stub
-- already carries article_title_versions, cluster_articles and articles), 162 as production has it (applied from its
-- own file, md5 pinned, with its grants), the bug on that baseline, then 169 TWICE, the new fingerprint and
-- attributes, and the scenarios.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Prelude: the state 169 sits on. ---------------------------------------------------------------------------
-- The stamp columns of 141 and 155 (the stub's clusters has neither): smallint count, timestamptz LLM stamp.
alter table public.clusters add column if not exists title_neutral_at timestamptz;
alter table public.clusters add column if not exists title_neutral_member_count smallint;

-- Migration 129's fold, copied verbatim (the stub has no 129).
create or replace function public.tayf_search_fold(p_text text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select pg_catalog.lower(pg_catalog.translate(p_text, 'İIıŞşĞğÜüÖöÇçÂâÎîÛû' || pg_catalog.chr(775), 'iiissgguuooccaaiiuu') collate pg_catalog."C")
$fn$;
revoke all on function public.tayf_search_fold(text) from public, anon, authenticated;
grant execute on function public.tayf_search_fold(text) to service_role;

-- 162, from its own file: production's function before 169 (md5(prosrc) read on production on 2026-11-06). ---------------
\ir ../../../supabase/migrations/162_neutral_title_stale_edit_repick.sql

-- Fixture helpers (session-local). Cluster n has uuid c0000000-...-<n, 12 digits>.
create function pg_temp.cu(n int) returns uuid language sql immutable as
  $f$ select ('c0000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $f$;
-- One cluster: n, stored title, the stamp (null = never stamped), the live article_count, optional model / LLM stamp / age.
create function pg_temp.fx_cluster(n int, p_title text, stamped int, cnt int,
                                   p_model text default 'extractive-v6', llm boolean default false,
                                   age interval default interval '1 day', archived boolean default false)
returns void language sql as $f$
  insert into public.clusters (id, title_tr_neutral, title_neutral_model, title_neutral_member_count, article_count,
                               is_archived, title_neutral_at, updated_at)
  values (pg_temp.cu(n), p_title, p_model, stamped, cnt, archived, case when llm then now() else null end, now() - age)
$f$;
-- The fixture numbers the function offers for extractive-v6, ascending, as text ("-" for none).
create function pg_temp.offered() returns text language sql as $f$
  select coalesce(string_agg(right(id::text, 12)::int::text, ',' order by right(id::text, 12)::int), '-')
    from public.neutral_title_repick_candidates('extractive-v6', 50)
$f$;

-- Baseline: this is production's function (md5(prosrc) read on production on 2026-11-06) with its ACL (owner + service_role,
-- nobody else). ----------------------------------------------------------------------------------------------------------
create temp table before_169 as
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
  select * into b from before_169;
  if b.m <> 'bb64fbb5bd16d32f659fb9d22889a166' or b.len <> 2418 then
    raise exception 'baseline: the prelude function is not production''s (md5 %, length %)', b.m, b.len;
  end if;
  if b.grants not like '%service_role:EXECUTE%' or b.grants like '%anon%' or b.grants like '%authenticated%' or b.grants like '%public%' then
    raise exception 'baseline: unexpected grants %', b.grants;
  end if;
  if not b.prosecdef or b.provolatile <> 's' or b.cfg is distinct from '{"search_path=\"\""}' or not b.proretset then
    raise exception 'baseline: unexpected attributes (secdef %, volatile %, config %)', b.prosecdef, b.provolatile, b.cfg;
  end if;
end $$;

-- The bug, on the old function: a stamped cluster with a title that fails the gate waits for the growth bar. ----------------
begin;
select pg_temp.fx_cluster(1, repeat('ç', 203), 2, 3);              -- d096acf8: 203 characters, stamped 2, now 3
select pg_temp.fx_cluster(2, repeat('ç', 167), 2, 4);              -- 442e0395: 167 characters, stamped 2, now 4
select pg_temp.fx_cluster(3, 'Dolar rekor kırdı mı?', 2, 3);       -- a question
select pg_temp.fx_cluster(4, repeat('ç', 203), 2, 5);              -- at the growth bar (2 + greatest(3, 1) = 5): 162 offers it
do $$
begin
  if pg_temp.offered() <> '4' then
    raise exception 'baseline: 162 does not offer a stamped cluster whose title fails the gate before the growth bar; offered %', pg_temp.offered();
  end if;
end $$;
rollback;

-- 169, TWICE (safe to re-apply). ---------------------------------------------------------------------------------------
\ir ../../../supabase/migrations/169_neutral_title_repick_gate_fail.sql
create temp table after_169_first as
  select md5(prosrc) as m, proacl::text as acl from pg_proc where oid = 'public.neutral_title_repick_candidates(text, integer)'::regprocedure;
\ir ../../../supabase/migrations/169_neutral_title_repick_gate_fail.sql

-- 1. The function: new body, everything else as before. -----------------------------------------------------------------
do $$
declare a record; b record; f record;
begin
  select * into b from before_169;
  select md5(prosrc) as m, length(prosrc) as len,
         (select string_agg(case when x.grantee = 0 then 'public' else x.grantee::regrole::text end || ':' || x.privilege_type,
                            ',' order by case when x.grantee = 0 then 'public' else x.grantee::regrole::text end)
            from aclexplode(p.proacl) x) as grants,
         proconfig::text as cfg, provolatile, prosecdef, proretset, proowner::regrole::text as owner,
         pg_get_function_result(oid) as res, pg_get_function_arguments(oid) as args, prolang
    into a from pg_proc p where oid = 'public.neutral_title_repick_candidates(text, integer)'::regprocedure;

  if a.m <> 'c5a3b354ff0f51ef77fae5b3fbf11b0a' or a.len <> 2745 then
    raise exception '169: unexpected body (md5 %, length %)', a.m, a.len;
  end if;
  if a.m = b.m then raise exception '169: the body did not change'; end if;
  if a.grants is distinct from b.grants then raise exception '169: grants changed: % -> %', b.grants, a.grants; end if;
  if a.cfg is distinct from b.cfg or a.provolatile <> b.provolatile or a.prosecdef <> b.prosecdef or a.proretset <> b.proretset
     or a.owner <> b.owner or a.res <> b.res or a.args <> b.args or a.prolang <> b.prolang then
    raise exception '169: an attribute other than the body changed';
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'neutral_title_repick_candidates') <> 1 then
    raise exception '169: more than one neutral_title_repick_candidates overload';
  end if;
  -- the second apply left the first apply's result
  select * into f from after_169_first;
  if f.m <> a.m then raise exception '169: the second apply changed the body'; end if;
  if has_function_privilege('anon', 'public.neutral_title_repick_candidates(text, integer)', 'execute')
     or has_function_privilege('authenticated', 'public.neutral_title_repick_candidates(text, integer)', 'execute')
     or not has_function_privilege('service_role', 'public.neutral_title_repick_candidates(text, integer)', 'execute') then
    raise exception '169: execute privileges are not service_role only';
  end if;
  if obj_description('public.neutral_title_repick_candidates(text, integer)'::regprocedure, 'pg_proc') not like '%Migrations 141, 155, 162, 169.' then
    raise exception '169: the function comment does not end with the migration list 141, 155, 162, 169';
  end if;
  -- 162 and 169 each recorded their own ledger row, once even though 169 was applied twice
  if (select count(*) from supabase_migrations.schema_migrations where version = '169') <> 1
     or (select name from supabase_migrations.schema_migrations where version = '169') <> '169_neutral_title_repick_gate_fail' then
    raise exception '169: the ledger row is not exactly one row named 169_neutral_title_repick_gate_fail';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '162') <> 1 then
    raise exception '169: 162''s ledger row changed';
  end if;
  -- no table was touched
  if exists (select 1 from public.clusters) then raise exception '169: a cluster row survived'; end if;
end $$;

-- 2. The fix, on the three live shapes (d096acf8, 442e0395, e0750c57) and a question. -----------------------------------
begin;
select pg_temp.fx_cluster(1, repeat('ç', 203), 2, 3);              -- d096acf8
select pg_temp.fx_cluster(2, repeat('ç', 167), 2, 4);              -- 442e0395
select pg_temp.fx_cluster(3, repeat('ç', 129), 2, 3);              -- e0750c57
select pg_temp.fx_cluster(4, 'Dolar rekor kırdı mı?', 2, 3);       -- a question
do $$
begin
  if pg_temp.offered() <> '1,2,3,4' then
    raise exception '169: the stamped, grown, gate-failing clusters should all be offered; offered %', pg_temp.offered();
  end if;
end $$;
rollback;

-- 3. What is NOT offered. ------------------------------------------------------------------------------------------------
begin;
select pg_temp.fx_cluster(1, repeat('ç', 203), 2, 2);                          -- stamped 2, still 2 members: nothing changed
select pg_temp.fx_cluster(2, repeat('ç', 60), 2, 3);                           -- a clean title waits for the growth bar
select pg_temp.fx_cluster(3, repeat('ç', 203), 5, 4);                          -- shrank below its stamp (a merge)
select pg_temp.fx_cluster(4, repeat('ç', 203), 2, 3, llm => true);             -- an LLM title is never re-picked
select pg_temp.fx_cluster(5, repeat('ç', 203), 2, 3, archived => true);        -- archived
select pg_temp.fx_cluster(6, repeat('ç', 203), 2, 3, age => interval '15 days'); -- outside the 14 day window
select pg_temp.fx_cluster(7, repeat('ç', 110), 2, 3);                          -- 110 characters (220 bytes): passes the length gate
select pg_temp.fx_cluster(8, repeat('ç', 20), 2, 3);                           -- 20 characters: passes the length gate
do $$
begin
  if pg_temp.offered() <> '-' then
    raise exception '169: nothing here should be offered; offered %', pg_temp.offered();
  end if;
end $$;
rollback;

-- 4. The edges: 111 characters, 19 characters, a short title padded with spaces. ----------------------------------------------
begin;
select pg_temp.fx_cluster(1, repeat('ç', 111), 2, 3);
select pg_temp.fx_cluster(2, repeat('ç', 19), 2, 3);
select pg_temp.fx_cluster(3, '   ' || repeat('ç', 17) || '   ', 2, 3);
do $$
begin
  if pg_temp.offered() <> '1,2,3' then
    raise exception '169: the 111 / 19 / padded-17 character titles should be offered; offered %', pg_temp.offered();
  end if;
end $$;
rollback;

-- 5. 162's own branches still work: another model, a NULL stamp, growth by half, and the clean-title growth bar. --------------
begin;
select pg_temp.fx_cluster(1, 'Merkez Bankası faiz kararını açıkladı', 2, 2, p_model => 'extractive-v5');
select pg_temp.fx_cluster(2, 'Merkez Bankası faiz kararını açıkladı', null, 2);
select pg_temp.fx_cluster(3, 'Merkez Bankası faiz kararını açıkladı', 2, 4);   -- 4 < 2 + 3: not offered
select pg_temp.fx_cluster(4, 'Merkez Bankası faiz kararını açıkladı', 2, 5);   -- 5 >= 2 + 3: offered
select pg_temp.fx_cluster(5, 'Merkez Bankası faiz kararını açıkladı', 2, 2);   -- nothing changed
do $$
begin
  if pg_temp.offered() <> '1,2,4' then
    raise exception '169: 162''s branches changed; offered %', pg_temp.offered();
  end if;
end $$;
rollback;

-- 6. No loop: once the cron stamps article_count the cluster leaves, and it is offered again only after further growth. -------
begin;
select pg_temp.fx_cluster(1, repeat('ç', 203), 2, 3);
do $$
declare before_stamp text; after_stamp text; after_growth text;
begin
  before_stamp := pg_temp.offered();
  update public.clusters set title_neutral_member_count = article_count where id = pg_temp.cu(1);
  after_stamp := pg_temp.offered();
  update public.clusters set article_count = 4 where id = pg_temp.cu(1);
  after_growth := pg_temp.offered();
  if before_stamp <> '1' or after_stamp <> '-' or after_growth <> '1' then
    raise exception '169: the stamp loop is wrong: before % / stamped % / grown %', before_stamp, after_stamp, after_growth;
  end if;
end $$;
rollback;

-- 7. The bounds are 162's: newest first, limit clamped to 1..50. ------------------------------------------------------------
begin;
select pg_temp.fx_cluster(g, repeat('ç', 150), 2, 3, age => g * interval '1 minute') from generate_series(1, 55) g;
do $$
declare first_ids text; n_default int; n_clamped int; n_floor int;
begin
  select string_agg(right(id::text, 12)::int::text, ',') into first_ids
    from (select id from public.neutral_title_repick_candidates('extractive-v6', 3)) s;
  select count(*) into n_default from public.neutral_title_repick_candidates('extractive-v6');
  select count(*) into n_clamped from public.neutral_title_repick_candidates('extractive-v6', 1000);
  select count(*) into n_floor from public.neutral_title_repick_candidates('extractive-v6', 0);
  if first_ids <> '1,2,3' or n_default <> 20 or n_clamped <> 50 or n_floor <> 1 then
    raise exception '169: bounds changed: first % / default % / clamped % / floor %', first_ids, n_default, n_clamped, n_floor;
  end if;
end $$;
rollback;

-- 8. Nothing was left behind by the scenarios above. -------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from public.clusters) or exists (select 1 from public.cluster_articles)
     or exists (select 1 from public.article_title_versions) then
    raise exception 'a rolled-back fixture survived';
  end if;
end $$;

select 'DRYRUN 169 OK';
