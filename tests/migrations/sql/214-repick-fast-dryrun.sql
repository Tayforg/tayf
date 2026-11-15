-- 214 neutral_title_repick_fast (the same re-pick candidates, read through one window and one set of index probes instead of a hashed IN over
-- the isci-haber outlet and a clusters probe per stale pair): local PG15 dry-run. Never touches production.
--
-- Run once, on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each run
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55614 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55614 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/214-repick-fast-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql PGHOST=/tmp PGPORT=55614 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/214-repick-fast)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh    (TAYF_LIVE_ONLY=214 runs just this one)
--
-- (\ir paths below are relative to this file.) Every check is a DO block that raises on mismatch, so a clean run ending in
-- "DRYRUN 214 OK" is the pass. Nothing is written to a table: the database this leaves behind has 162, 169, 184, 200, 208, 209 and 214
-- applied and holds no fixture rows.
--
-- Why it exists. 214's JS test (tests/migrations/214-repick-fast.test.ts) reads the SQL as text, and its live block runs 209's body and the
-- shipped function side by side on fixtures and on seeded random populations; this builds the state that block needs: the
-- stub tables, 184's dry-run (the two stamp columns of 141 and 155, 129's fold, 162, 169 and 184 applied and every scenario of theirs
-- checked), then 200, 208 and 209 from their own files, the baseline check (209's body is production's: md5 cf7458da...), and 214
-- applied TWICE (one body, one comment, one ledger row, the same ACL).

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Prelude: 184's state (its own dry-run, which ends clean), then 200, 208 and 209 as production has them. ----------------------
\ir 184-repick-young-shout-dryrun.sql
\ir ../../../supabase/migrations/200_neutral_title_stale_quote_aware.sql
\ir ../../../supabase/migrations/208_neutral_title_repick_generic.sql
\ir ../../../supabase/migrations/209_neutral_title_repick_loaded_cased.sql

-- Baseline: this is production's function (md5(prosrc) and length read on production on 2026-11-15, h189 STEP 0) with its ACL. ----
do $$
declare got record;
begin
  select md5(p.prosrc) as m, length(p.prosrc) as l, p.proacl::text as acl into got
    from pg_proc p where p.oid = 'public.neutral_title_repick_candidates(text, integer)'::regprocedure;
  if got.m <> 'cf7458daa1b7b96e750c5583693e2608' or got.l <> 11078 then
    raise exception '214: the baseline is not production''s 209 body: % / %', got.m, got.l;
  end if;
  if got.acl <> '{postgres=X/postgres,service_role=X/postgres}' then
    raise exception '214: the baseline ACL is %', got.acl;
  end if;
end $$;

-- Apply 214 TWICE (create or replace, comment, revoke/grant restated, ledger insert on conflict do nothing). -------------------------
\ir ../../../supabase/migrations/214_neutral_title_repick_fast.sql
\ir ../../../supabase/migrations/214_neutral_title_repick_fast.sql

do $$
declare got record;
begin
  select md5(p.prosrc) as m, length(p.prosrc) as l, p.prosecdef as sd, p.provolatile::text as vol,
         coalesce(p.proconfig::text, '') as cfg, p.proacl::text as acl,
         pg_get_function_result(p.oid) as res, pg_get_function_arguments(p.oid) as args
    into got
    from pg_proc p where p.oid = 'public.neutral_title_repick_candidates(text, integer)'::regprocedure;
  if got.m <> '6ec3157704dee41e96daf0d744c35b7a' or got.l <> 10484 then
    raise exception '214: the body is not the pinned one: % / %', got.m, got.l;
  end if;
  if not got.sd or got.vol <> 's' or got.cfg <> '{"search_path=\"\""}' or got.acl <> '{postgres=X/postgres,service_role=X/postgres}' then
    raise exception '214: attributes changed: % % % %', got.sd, got.vol, got.cfg, got.acl;
  end if;
  if got.res <> 'TABLE(id uuid, title_tr_neutral text, article_count integer, title_neutral_member_count smallint)'
     or got.args <> 'p_model text, p_limit integer DEFAULT 20' then
    raise exception '214: signature changed: % / %', got.res, got.args;
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '214') <> 1 then
    raise exception '214: the ledger row is not unique';
  end if;
  if (select count(*) from pg_proc where proname = 'neutral_title_repick_candidates') <> 1 then
    raise exception '214: more than one neutral_title_repick_candidates';
  end if;
  if has_function_privilege('anon', 'public.neutral_title_repick_candidates(text, integer)', 'execute')
     or has_function_privilege('authenticated', 'public.neutral_title_repick_candidates(text, integer)', 'execute')
     or not has_function_privilege('service_role', 'public.neutral_title_repick_candidates(text, integer)', 'execute') then
    raise exception '214: the ACL changed';
  end if;
  if obj_description('public.neutral_title_repick_candidates(text, integer)'::regprocedure, 'pg_proc') not like '%208, 209, 214.' then
    raise exception '214: the comment does not name 214';
  end if;
end $$;

-- Nothing was left behind. -----------------------------------------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from public.clusters) or exists (select 1 from public.cluster_articles)
     or exists (select 1 from public.article_title_versions) then
    raise exception 'a fixture row survived';
  end if;
end $$;

select 'DRYRUN 214 OK';
