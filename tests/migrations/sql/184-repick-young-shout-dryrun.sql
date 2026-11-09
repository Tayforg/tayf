-- 184 neutral_title_repick_young_and_shout (a cluster stamped at 2 that has grown to 3 or more, and a stored title in capitals
-- only, are re-offered): local PG15 dry-run. Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55584 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55584 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/184-repick-young-shout-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql PGHOST=/tmp PGPORT=55584 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/184-repick-young-shout)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh    (TAYF_LIVE_ONLY=184 runs just this one)
--
-- (\ir paths below are relative to this file.) Every check is a DO block or a pg_temp function that raises on mismatch, so a
-- clean run ending in "DRYRUN 184 OK" is the pass. Every scenario that writes sits inside begin ... rollback, so the database
-- this leaves behind has 162, 169 and 184 applied and holds no fixture rows.
--
-- Why it exists. 184's JS test (tests/migrations/184-repick-young-shout.test.ts) reads the SQL as text; this runs the SHIPPED
-- function in PostgreSQL: that the baseline (production's 169 body, md5 pinned) offers neither a cluster stamped at 2 that has 3
-- or 4 members nor an all-capitals title stamped at its own count, that 184 offers both, that a stamp above 2 keeps the old
-- growth bar, that the shout branch is letters and no lower case on explicit Turkish classes (dotless i and circumflexed vowels
-- are lower case, digits and punctuation are neutral, a title with no letters does not match), that everything 169 offered it
-- still offers, that both branches leave once the cron has written its stamp or its sentence-cased title, and that applying 184
-- twice leaves one body, one comment and one ledger row.
--
-- Order: the state 184 sits on is exactly 169's dry-run (the two stamp columns of 141 and 155, 129's fold, 162 from its own
-- file, then 169 twice, with every 169 scenario checked); this file runs it, shows both defects on 169's body, then applies 184
-- TWICE, the new fingerprint and attributes, and the scenarios.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Prelude: 162 and 169 as production has them (169's own dry-run, which ends clean). -------------------------------------
\ir 169-repick-gate-fail-dryrun.sql

-- Fixture helpers (session-local). Cluster n has uuid c0000000-...-<n, 12 digits>.
create function pg_temp.cu184(n int) returns uuid language sql immutable as
  $f$ select ('c0000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $f$;
-- One cluster: n, stored title, the stamp (null = never stamped), the live article_count, optional model / LLM stamp / age.
create function pg_temp.fx184(n int, p_title text, stamped int, cnt int,
                              p_model text default 'extractive-v6', llm boolean default false,
                              age interval default interval '1 day', archived boolean default false)
returns void language sql as $f$
  insert into public.clusters (id, title_tr_neutral, title_neutral_model, title_neutral_member_count, article_count,
                               is_archived, title_neutral_at, updated_at)
  values (pg_temp.cu184(n), p_title, p_model, stamped, cnt, archived, case when llm then now() else null end, now() - age)
$f$;
-- The fixture numbers the function offers for extractive-v6, ascending, as text ("-" for none).
create function pg_temp.offered184() returns text language sql as $f$
  select coalesce(string_agg(right(id::text, 12)::int::text, ',' order by right(id::text, 12)::int), '-')
    from public.neutral_title_repick_candidates('extractive-v6', 50)
$f$;

-- Baseline: this is production's function (md5(prosrc) read on production on 2026-11-09) with its ACL (owner + service_role,
-- nobody else). ----------------------------------------------------------------------------------------------------------
create temp table before_184 as
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
  select * into b from before_184;
  if b.m <> 'c5a3b354ff0f51ef77fae5b3fbf11b0a' or b.len <> 2745 then
    raise exception 'baseline: the prelude function is not production''s (md5 %, length %)', b.m, b.len;
  end if;
  if b.grants not like '%service_role:EXECUTE%' or b.grants like '%anon%' or b.grants like '%authenticated%' or b.grants like '%public%' then
    raise exception 'baseline: unexpected grants %', b.grants;
  end if;
  if not b.prosecdef or b.provolatile <> 's' or b.cfg is distinct from '{"search_path=\"\""}' or not b.proretset then
    raise exception 'baseline: unexpected attributes (secdef %, volatile %, config %)', b.prosecdef, b.provolatile, b.cfg;
  end if;
end $$;

-- The defects, on the old function. -------------------------------------------------------------------------------------------
-- (1) young: a cluster stamped at 2 waits for the growth bar (5 members).
begin;
select pg_temp.fx184(1, 'Merkez Bankası faiz kararını açıkladı', 2, 3);   -- 459a7b61-shaped: stamped 2, now 3
select pg_temp.fx184(2, 'Merkez Bankası faiz kararını açıkladı', 2, 4);   -- stamped 2, now 4
select pg_temp.fx184(3, 'Merkez Bankası faiz kararını açıkladı', 2, 5);   -- at the growth bar (2 + greatest(3, 1) = 5): offered
do $$
begin
  if pg_temp.offered184() <> '3' then
    raise exception 'baseline: 169 does not offer a cluster stamped at 2 that has 3 members before the growth bar; offered %', pg_temp.offered184();
  end if;
end $$;
rollback;

-- (2) shout: an all-capitals title stamped at its own count is never offered.
begin;
select pg_temp.fx184(1, 'NEV''İN MİRASI GÜNDEM OLDU', 2, 2);                                   -- 09f152ec
select pg_temp.fx184(2, 'PENDİK VERGİ DAİRESİ MÜDÜRLÜĞÜ PENDİK VERGİ DAİRESİ', 2, 2);         -- fe2c6725
do $$
begin
  if pg_temp.offered184() <> '-' then
    raise exception 'baseline: 169 does not offer an all-capitals title stamped at its own count; offered %', pg_temp.offered184();
  end if;
end $$;
rollback;

-- 184, TWICE (safe to re-apply). ---------------------------------------------------------------------------------------
\ir ../../../supabase/migrations/184_neutral_title_repick_young_and_shout.sql
create temp table after_184_first as
  select md5(prosrc) as m, proacl::text as acl from pg_proc where oid = 'public.neutral_title_repick_candidates(text, integer)'::regprocedure;
\ir ../../../supabase/migrations/184_neutral_title_repick_young_and_shout.sql

-- 1. The function: new body, everything else as before. -----------------------------------------------------------------
do $$
declare a record; b record; f record;
begin
  select * into b from before_184;
  select md5(prosrc) as m, length(prosrc) as len,
         (select string_agg(case when x.grantee = 0 then 'public' else x.grantee::regrole::text end || ':' || x.privilege_type,
                            ',' order by case when x.grantee = 0 then 'public' else x.grantee::regrole::text end)
            from aclexplode(p.proacl) x) as grants,
         proconfig::text as cfg, provolatile, prosecdef, proretset, proowner::regrole::text as owner,
         pg_get_function_result(oid) as res, pg_get_function_arguments(oid) as args, prolang
    into a from pg_proc p where oid = 'public.neutral_title_repick_candidates(text, integer)'::regprocedure;

  if a.m <> 'f53e452579b59bffc6fbc0f547c852e8' or a.len <> 3040 then
    raise exception '184: unexpected body (md5 %, length %)', a.m, a.len;
  end if;
  if a.m = b.m then raise exception '184: the body did not change'; end if;
  if a.grants is distinct from b.grants then raise exception '184: grants changed: % -> %', b.grants, a.grants; end if;
  if a.cfg is distinct from b.cfg or a.provolatile <> b.provolatile or a.prosecdef <> b.prosecdef or a.proretset <> b.proretset
     or a.owner <> b.owner or a.res <> b.res or a.args <> b.args or a.prolang <> b.prolang then
    raise exception '184: an attribute other than the body changed';
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'neutral_title_repick_candidates') <> 1 then
    raise exception '184: more than one neutral_title_repick_candidates overload';
  end if;
  -- the second apply left the first apply's result
  select * into f from after_184_first;
  if f.m <> a.m then raise exception '184: the second apply changed the body'; end if;
  if has_function_privilege('anon', 'public.neutral_title_repick_candidates(text, integer)', 'execute')
     or has_function_privilege('authenticated', 'public.neutral_title_repick_candidates(text, integer)', 'execute')
     or not has_function_privilege('service_role', 'public.neutral_title_repick_candidates(text, integer)', 'execute') then
    raise exception '184: execute privileges are not service_role only';
  end if;
  if obj_description('public.neutral_title_repick_candidates(text, integer)'::regprocedure, 'pg_proc') not like '%Migrations 141, 155, 162, 169, 184.' then
    raise exception '184: the function comment does not end with the migration list 141, 155, 162, 169, 184';
  end if;
  -- 162, 169 and 184 each recorded their own ledger row, once even though 184 was applied twice
  if (select count(*) from supabase_migrations.schema_migrations where version = '184') <> 1
     or (select name from supabase_migrations.schema_migrations where version = '184') <> '184_neutral_title_repick_young_and_shout' then
    raise exception '184: the ledger row is not exactly one row named 184_neutral_title_repick_young_and_shout';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version in ('162', '169')) <> 2 then
    raise exception '184: 162''s or 169''s ledger row changed';
  end if;
  -- no table was touched
  if exists (select 1 from public.clusters) then raise exception '184: a cluster row survived'; end if;
end $$;

-- 2. The fix, on the live shapes: young clusters (stamped 2, now 3 and 4), a stamp of 1, and both shouting titles. ----------
begin;
select pg_temp.fx184(1, 'Merkez Bankası faiz kararını açıkladı', 2, 3);                          -- 459a7b61, f771e177 ...
select pg_temp.fx184(2, 'Merkez Bankası faiz kararını açıkladı', 2, 4);
select pg_temp.fx184(3, 'Merkez Bankası faiz kararını açıkladı', 1, 3);                          -- a stamp of 1
select pg_temp.fx184(4, 'NEV''İN MİRASI GÜNDEM OLDU', 2, 2);                                     -- 09f152ec
select pg_temp.fx184(5, 'PENDİK VERGİ DAİRESİ MÜDÜRLÜĞÜ PENDİK VERGİ DAİRESİ', 2, 2);           -- fe2c6725
do $$
begin
  if pg_temp.offered184() <> '1,2,3,4,5' then
    raise exception '184: the young and the shouting clusters should all be offered; offered %', pg_temp.offered184();
  end if;
end $$;
rollback;

-- 3. What is NOT offered. ------------------------------------------------------------------------------------------------
begin;
select pg_temp.fx184(1, 'Merkez Bankası faiz kararını açıkladı', 2, 2);                           -- stamped 2, still 2 members
select pg_temp.fx184(2, 'Merkez Bankası faiz kararını açıkladı', 3, 4);                           -- a stamp of 3 waits for the growth bar
select pg_temp.fx184(3, 'Merkez Bankası faiz kararını açıkladı', 3, 6);                           -- the growth bar of 155 (3 + 3 = 6): offered
select pg_temp.fx184(4, 'Merkez Bankası faiz kararını açıkladı', 5, 4);                           -- shrank below its stamp (a merge)
select pg_temp.fx184(5, 'Merkez Bankası faiz kararını açıkladı', 2, 3, llm => true);              -- an LLM title is never re-picked
select pg_temp.fx184(6, 'Merkez Bankası faiz kararını açıkladı', 2, 3, archived => true);         -- archived
select pg_temp.fx184(7, 'Merkez Bankası faiz kararını açıkladı', 2, 3, age => interval '15 days'); -- outside the 14 day window
select pg_temp.fx184(8, 'Nev''in mirası gündem oldu', 2, 2);                                      -- sentence case at the same stamp
select pg_temp.fx184(9, 'NEV''İN MİRASI GÜNDEM OLDU', 2, 2, llm => true);                         -- a shouting LLM title
select pg_temp.fx184(10, 'NEV''İN MİRASI GÜNDEM OLDU', 2, 2, archived => true);
select pg_temp.fx184(11, 'NEV''İN MİRASI GÜNDEM OLDU', 2, 2, age => interval '15 days');
do $$
begin
  if pg_temp.offered184() <> '3' then
    raise exception '184: only the stamp-3 / 6-member cluster (the growth bar) should be offered here; offered %', pg_temp.offered184();
  end if;
end $$;
rollback;

-- 4. The shout classes: explicit Turkish letters, no lower case, at least one capital. ----------------------------------------
begin;
select pg_temp.fx184(1, 'ÇOCUK ŞEKERİ ÖĞRENCİ ÜÇ GÜN', 2, 2);            -- Turkish capitals only: offered
select pg_temp.fx184(2, 'ÇAĞRI 2026: 11 KASIM!', 2, 2);                    -- digits and punctuation are neutral: offered
select pg_temp.fx184(3, 'TBMM''de BÜTÇE GÖRÜŞMELERİ', 2, 2);               -- one lower-case word: not offered
select pg_temp.fx184(4, 'KARŞI ÇIKTI ı', 2, 2);                            -- a dotless i is lower case: not offered
select pg_temp.fx184(5, 'HAYATÎ âlem', 2, 2);                              -- circumflexed lower case: not offered
select pg_temp.fx184(6, '12345 6789 0123 4567', 2, 2);                     -- no letters at all: not offered
select pg_temp.fx184(7, 'ÇAĞRI', 3, 3);                                    -- short, but shouting: offered whatever the stamp
select pg_temp.fx184(8, 'NEV''İN MİRASI GÜNDEM OLDU', null, 2);            -- never stamped: offered (the old NULL branch too)
select pg_temp.fx184(9, 'NEV''İN MİRASI GÜNDEM OLDU', 6, 7);               -- grown past the stamp: offered
select pg_temp.fx184(10, 'NEV''İN MİRASI GÜNDEM OLDU', 7, 7);              -- stamp equals count: offered (no stamp condition)
do $$
begin
  if pg_temp.offered184() <> '1,2,7,8,9,10' then
    raise exception '184: the shout classes are wrong; offered %', pg_temp.offered184();
  end if;
end $$;
rollback;

-- 5. 162's and 169's own branches still work. ------------------------------------------------------------------------------------
begin;
select pg_temp.fx184(1, 'Merkez Bankası faiz kararını açıkladı', 2, 2, p_model => 'extractive-v5');   -- another model
select pg_temp.fx184(2, 'Merkez Bankası faiz kararını açıkladı', null, 2);                             -- a NULL stamp
select pg_temp.fx184(3, 'Merkez Bankası faiz kararını açıkladı', 5, 8);                                -- growth by half (5 + 3)
select pg_temp.fx184(4, 'Merkez Bankası faiz kararını açıkladı', 5, 7);                                -- not yet: 7 < 8
select pg_temp.fx184(5, repeat('ç', 203), 3, 4);                                                       -- 169: gate-fail, grown by one
select pg_temp.fx184(6, 'Dolar rekor kırdı mı?', 3, 4);                                                -- 169: a question, grown by one
select pg_temp.fx184(7, repeat('ç', 203), 3, 3);                                                       -- 169: gate-fail but not grown
do $$
begin
  if pg_temp.offered184() <> '1,2,3,5,6' then
    raise exception '184: 162''s or 169''s branches changed; offered %', pg_temp.offered184();
  end if;
end $$;
rollback;

-- 6. No loop. -----------------------------------------------------------------------------------------------------------------------
-- (a) young: once the cron stamps article_count the cluster leaves, and it is offered again only by the growth bar.
begin;
select pg_temp.fx184(1, 'Merkez Bankası faiz kararını açıkladı', 2, 3);
do $$
declare before_stamp text; after_stamp text; after_grown text; after_bar text;
begin
  before_stamp := pg_temp.offered184();
  update public.clusters set title_neutral_member_count = article_count where id = pg_temp.cu184(1);
  after_stamp := pg_temp.offered184();
  update public.clusters set article_count = 4 where id = pg_temp.cu184(1);
  after_grown := pg_temp.offered184();
  update public.clusters set article_count = 6 where id = pg_temp.cu184(1);
  after_bar := pg_temp.offered184();
  if before_stamp <> '1' or after_stamp <> '-' or after_grown <> '-' or after_bar <> '1' then
    raise exception '184: the young stamp loop is wrong: before % / stamped % / grown % / bar %', before_stamp, after_stamp, after_grown, after_bar;
  end if;
end $$;
rollback;

-- (b) shout: the cron writes the sentence-cased title and the stamp, and the cluster leaves.
begin;
select pg_temp.fx184(1, 'NEV''İN MİRASI GÜNDEM OLDU', 2, 2);
do $$
declare before_fix text; after_fix text;
begin
  before_fix := pg_temp.offered184();
  update public.clusters set title_tr_neutral = 'Nev''in mirası gündem oldu', title_neutral_member_count = article_count
   where id = pg_temp.cu184(1);
  after_fix := pg_temp.offered184();
  if before_fix <> '1' or after_fix <> '-' then
    raise exception '184: the shout loop is wrong: before % / repaired %', before_fix, after_fix;
  end if;
end $$;
rollback;

-- 7. The bounds are 162's: newest first, limit clamped to 1..50. ------------------------------------------------------------
begin;
select pg_temp.fx184(g, 'Merkez Bankası faiz kararını açıkladı', 2, 3, age => g * interval '1 minute') from generate_series(1, 55) g;
do $$
declare first_ids text; n_default int; n_clamped int; n_floor int;
begin
  select string_agg(right(id::text, 12)::int::text, ',') into first_ids
    from (select id from public.neutral_title_repick_candidates('extractive-v6', 3)) s;
  select count(*) into n_default from public.neutral_title_repick_candidates('extractive-v6');
  select count(*) into n_clamped from public.neutral_title_repick_candidates('extractive-v6', 1000);
  select count(*) into n_floor from public.neutral_title_repick_candidates('extractive-v6', 0);
  if first_ids <> '1,2,3' or n_default <> 20 or n_clamped <> 50 or n_floor <> 1 then
    raise exception '184: bounds changed: first % / default % / clamped % / floor %', first_ids, n_default, n_clamped, n_floor;
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

select 'DRYRUN 184 OK';
