-- 170 entity_cluster_ids_headline_only (entity_cluster_ids_v3 with p_headline_only, so /gundem/akp ignores the summary lead):
-- local PG15 dry-run. Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55570 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55570 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/170-entity-cluster-ids-headline-only-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql PGHOST=/tmp PGPORT=55570 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/170-entity-cluster-ids-headline-only)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh    (TAYF_LIVE_ONLY=170 runs just this one)
--
-- (\ir paths below are relative to this file.) Every check is a DO block or a pg_temp function that raises on
-- mismatch, so a clean run ending in "DRYRUN 170 OK" is the pass. Every scenario that writes sits inside begin ...
-- rollback, so the database this leaves behind has 156 and 170 applied and holds no fixture rows.
--
-- Why it exists. 170's JS test (tests/migrations/170-entity-cluster-ids-headline-only.test.ts) reads the SQL as text; this
-- runs the SHIPPED function in PostgreSQL: that the baseline (production's v2, 156's body, md5 pinned) lists a cluster that
-- names the party only in the summary lead, that v3 with the flag false returns what v2 returns and with the flag true drops
-- that cluster, that a missing or NULL flag is the lead mode, that the prefilter, the live predicate, the order, the total and
-- the clamp are v2's, that v2 is untouched, and that applying 170 twice leaves one body, one comment and one ledger row.
--
-- Order: the state 170 sits on (the stub's clusters gets summary_tr, merged_into, 035's generated search_tsv and 083's partial
-- index, which production has), 156 as production has it (applied from its own file, md5 pinned, with its grants), the
-- defect on that baseline, then 170 TWICE, the new fingerprint and attributes, and the scenarios.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Prelude: the state 170 sits on. ---------------------------------------------------------------------------
alter table public.clusters add column if not exists summary_tr text;
alter table public.clusters add column if not exists merged_into uuid;
alter table public.clusters add column if not exists first_published timestamptz;

-- 035: the generated tsvector the prefilter reads, byte for byte.
alter table public.clusters
  add column if not exists search_tsv tsvector
  generated always as (
    to_tsvector(
      'turkish',
      coalesce(title_tr_neutral, '') || ' ' || coalesce(title_tr, '') || ' ' || coalesce(summary_tr, '')
    )
  ) stored;

-- 083: the partial GIN index the prefilter uses, and the updated_at index of 014.
create index if not exists clusters_search_tsv_live_idx
  on public.clusters using gin (search_tsv)
  where not is_archived and article_count >= 2;
create index if not exists idx_clusters_active_updated_at on public.clusters (updated_at desc) where article_count >= 2;

-- 156, from its own file: production's v2 before 170 (md5(prosrc) read on production on 2026-11-06). ----------------------
\ir ../../../supabase/migrations/156_entity_cluster_ids_v3.sql

-- Fixture helpers (session-local). Cluster n has uuid c0000000-...-<n, 12 digits>.
create function pg_temp.cu(n int) returns uuid language sql immutable as
  $f$ select ('c0000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $f$;
-- One cluster: n, headline, neutral headline, stored summary, plus optional member count, state and ages.
create function pg_temp.fx(n int, p_title text, p_neutral text default null, p_summary text default null,
                           cnt int default 3, archived boolean default false, merged boolean default false,
                           age interval default interval '1 day', published interval default null)
returns void language sql as $f$
  insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, merged_into,
                               updated_at, first_published)
  values (pg_temp.cu(n), p_title, p_neutral, p_summary, cnt, archived, case when merged then pg_temp.cu(900) end,
          now() - age, now() - coalesce(published, n * interval '1 minute'))
$f$;
-- The akp arrays exactly as the app builds them (entityHubQueries / entityHubPatterns for the akp hub).
create function pg_temp.akp_q() returns text[] language sql as $f$ select array['ak parti', 'akp', 'ak partili', 'ak partimize'] $f$;
create function pg_temp.akp_p() returns text[] language sql as $f$ select array['\mak\s+parti', '\makp\M'] $f$;
-- What a call returns: the fixture numbers in the function's order, then '/' and the total ("-/0" for none).
create function pg_temp.shown(q text[], p text[], flag text, lim int default 50) returns text language plpgsql as $f$
declare r text;
begin
  if flag = 'v2' then
    select coalesce(string_agg(right(s.id::text, 12)::int::text, ',' order by s.ord), '-') || '/' || coalesce(max(s.total), 0) into r
      from (select e.id, e.total, row_number() over () as ord from public.entity_cluster_ids_v2(q, p, null, lim) e) s;
  elsif flag = 'omitted' then
    select coalesce(string_agg(right(s.id::text, 12)::int::text, ',' order by s.ord), '-') || '/' || coalesce(max(s.total), 0) into r
      from (select e.id, e.total, row_number() over () as ord from public.entity_cluster_ids_v3(q, p, null, lim) e) s;
  else
    select coalesce(string_agg(right(s.id::text, 12)::int::text, ',' order by s.ord), '-') || '/' || coalesce(max(s.total), 0) into r
      from (select e.id, e.total, row_number() over () as ord
              from public.entity_cluster_ids_v3(q, p, null, lim, case flag when 'true' then true when 'false' then false end) e) s;
  end if;
  return r;
end $f$;

-- Baseline: this is production's v2 (md5(prosrc) read on production on 2026-11-06) with its ACL (owner + service_role,
-- nobody else), and there is no v3 yet. --------------------------------------------------------------------------------
create temp table before_170 as
  select md5(prosrc) as m, length(prosrc) as len,
         (select string_agg(case when a.grantee = 0 then 'public' else a.grantee::regrole::text end || ':' || a.privilege_type,
                            ',' order by case when a.grantee = 0 then 'public' else a.grantee::regrole::text end)
            from aclexplode(p.proacl) a) as grants,
         proconfig::text as cfg, provolatile, prosecdef, proretset, proowner::regrole::text as owner,
         pg_get_function_result(oid) as res, pg_get_function_arguments(oid) as args, prolang,
         obj_description(oid, 'pg_proc') as cmt
    from pg_proc p where oid = 'public.entity_cluster_ids_v2(text[], text[], timestamptz, integer)'::regprocedure;

do $$
declare b record;
begin
  select * into b from before_170;
  if b.m <> '81be59e839f81c6e738e32a658c2a8eb' or b.len <> 884 then
    raise exception 'baseline: the prelude function is not production''s v2 (md5 %, length %)', b.m, b.len;
  end if;
  if b.grants not like '%service_role:EXECUTE%' or b.grants like '%anon%' or b.grants like '%authenticated%' or b.grants like '%public%' then
    raise exception 'baseline: unexpected grants %', b.grants;
  end if;
  if not b.prosecdef or b.provolatile <> 's' or b.cfg is distinct from '{"search_path=\"\""}' or not b.proretset then
    raise exception 'baseline: unexpected attributes (secdef %, volatile %, config %)', b.prosecdef, b.provolatile, b.cfg;
  end if;
  if to_regprocedure('public.entity_cluster_ids_v3(text[], text[], timestamptz, integer, boolean)') is not null
     or exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'entity_cluster_ids_v3') then
    raise exception 'baseline: an object named entity_cluster_ids_v3 already exists';
  end if;
end $$;

-- The defect, on the old function: a cluster that names the party only in the summary lead is listed. -------------------
begin;
select pg_temp.fx(1, 'Kültür ve Turizm Bakanlığının 2027 yılı bütçesi TBMM Plan ve Bütçe Komisyonunda',
                  'Kültür ve Turizm Bakanlığının 2027 yılı bütçesi TBMM Plan ve Bütçe Komisyonunda',
                  'TBMM Plan ve Bütçe Komisyonunda, AK Parti Samsun Milletvekili Mehmet Muş başkanlığında toplandı.');
select pg_temp.fx(2, 'Bu kez araştırma partiden geldi. AK Parti''nin kalesinde tam 15 puanlık erime');
do $$
begin
  if pg_temp.shown(pg_temp.akp_q(), pg_temp.akp_p(), 'v2') <> '1,2/2' then
    raise exception 'baseline: v2 (156) lists a cluster that names the party only in the summary lead; got %',
      pg_temp.shown(pg_temp.akp_q(), pg_temp.akp_p(), 'v2');
  end if;
end $$;
rollback;

-- 170, TWICE (safe to re-apply). ---------------------------------------------------------------------------------------
\ir ../../../supabase/migrations/170_entity_cluster_ids_headline_only.sql
create temp table after_170_first as
  select md5(prosrc) as m, proacl::text as acl, obj_description(oid, 'pg_proc') as cmt
    from pg_proc where oid = 'public.entity_cluster_ids_v3(text[], text[], timestamptz, integer, boolean)'::regprocedure;
\ir ../../../supabase/migrations/170_entity_cluster_ids_headline_only.sql

-- 1. The new function: its fingerprint and attributes; v2 as it was. ----------------------------------------------------
do $$
declare a record; b record; f record; v2 record;
begin
  select * into b from before_170;
  select md5(prosrc) as m, length(prosrc) as len,
         (select string_agg(case when x.grantee = 0 then 'public' else x.grantee::regrole::text end || ':' || x.privilege_type,
                            ',' order by case when x.grantee = 0 then 'public' else x.grantee::regrole::text end)
            from aclexplode(p.proacl) x) as grants,
         proconfig::text as cfg, provolatile, prosecdef, proretset, proowner::regrole::text as owner,
         pg_get_function_result(oid) as res, pg_get_function_arguments(oid) as args, prolang
    into a from pg_proc p where oid = 'public.entity_cluster_ids_v3(text[], text[], timestamptz, integer, boolean)'::regprocedure;

  if a.m <> 'bc1ea39f547ca8d6810833f12c7bd983' or a.len <> 1117 then
    raise exception '170: unexpected body (md5 %, length %)', a.m, a.len;
  end if;
  if a.m = b.m then raise exception '170: the new body equals v2''s'; end if;
  if a.grants is distinct from b.grants then raise exception '170: v3 grants differ from v2''s: % -> %', b.grants, a.grants; end if;
  if a.cfg is distinct from b.cfg or a.provolatile <> b.provolatile or a.prosecdef <> b.prosecdef or a.proretset <> b.proretset
     or a.owner <> b.owner or a.prolang <> b.prolang or a.res <> b.res then
    raise exception '170: an attribute of v3 differs from v2''s';
  end if;
  if a.args <> b.args || ', p_headline_only boolean DEFAULT false' then
    raise exception '170: unexpected arguments %', a.args;
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'entity_cluster_ids_v3') <> 1 then
    raise exception '170: more than one entity_cluster_ids_v3 overload';
  end if;
  -- the second apply left the first apply's result
  select * into f from after_170_first;
  if f.m <> a.m then raise exception '170: the second apply changed the body'; end if;
  if has_function_privilege('anon', 'public.entity_cluster_ids_v3(text[], text[], timestamptz, integer, boolean)', 'execute')
     or has_function_privilege('authenticated', 'public.entity_cluster_ids_v3(text[], text[], timestamptz, integer, boolean)', 'execute')
     or not has_function_privilege('service_role', 'public.entity_cluster_ids_v3(text[], text[], timestamptz, integer, boolean)', 'execute') then
    raise exception '170: execute privileges are not service_role only';
  end if;
  if obj_description('public.entity_cluster_ids_v3(text[], text[], timestamptz, integer, boolean)'::regprocedure, 'pg_proc') not like '%service_role only.'
     or obj_description('public.entity_cluster_ids_v3(text[], text[], timestamptz, integer, boolean)'::regprocedure, 'pg_proc') not like '%migration 170%' then
    raise exception '170: the function comment is not the 170 comment';
  end if;
  -- v2 is exactly what it was: body, grants, attributes, comment
  select md5(prosrc) as m, length(prosrc) as len, proacl::text as acl, obj_description(oid, 'pg_proc') as cmt
    into v2 from pg_proc where oid = 'public.entity_cluster_ids_v2(text[], text[], timestamptz, integer)'::regprocedure;
  if v2.m <> b.m or v2.len <> b.len or v2.cmt is distinct from b.cmt then raise exception '170: v2 changed'; end if;
  if not has_function_privilege('service_role', 'public.entity_cluster_ids_v2(text[], text[], timestamptz, integer)', 'execute')
     or has_function_privilege('anon', 'public.entity_cluster_ids_v2(text[], text[], timestamptz, integer)', 'execute') then
    raise exception '170: v2 privileges changed';
  end if;
  -- 156 and 170 each recorded their own ledger row, once even though 170 was applied twice
  if (select count(*) from supabase_migrations.schema_migrations where version = '170') <> 1
     or (select name from supabase_migrations.schema_migrations where version = '170') <> '170_entity_cluster_ids_headline_only' then
    raise exception '170: the ledger row is not exactly one row named 170_entity_cluster_ids_headline_only';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '156') <> 1 then
    raise exception '170: 156''s ledger row changed';
  end if;
  -- no table was touched
  if exists (select 1 from public.clusters) then raise exception '170: a cluster row survived'; end if;
end $$;

-- 2. The fix, on the live shapes: the budget committee (lead only), a poll headline, an AKP'li headline, an ex-MP epithet. -----
begin;
select pg_temp.fx(1, 'Kültür ve Turizm Bakanlığının 2027 yılı bütçesi TBMM Plan ve Bütçe Komisyonunda',
                  'Kültür ve Turizm Bakanlığının 2027 yılı bütçesi TBMM Plan ve Bütçe Komisyonunda',
                  'TBMM Plan ve Bütçe Komisyonunda, AK Parti Samsun Milletvekili Mehmet Muş başkanlığında toplandı.');
select pg_temp.fx(2, 'Bu kez araştırma partiden geldi. AK Parti''nin kalesinde tam 15 puanlık erime');
select pg_temp.fx(3, 'Fatma Betül''ün tutuklanmasının ardından AKP''li isimden olay sözler');
select pg_temp.fx(4, 'Fon soruşturması: Adli kontrolle serbest bırakılan Ertan Aydın itiraz üzerine tutuklandı', null,
                  'İstanbul Cumhuriyet Başsavcılığının fon soruşturmasında AK Parti eski milletvekili Ertan Aydın tutuklandı.');
do $$
begin
  if pg_temp.shown(pg_temp.akp_q(), pg_temp.akp_p(), 'true') <> '2,3/2' then
    raise exception '170: with the flag true only the headline clusters should remain; got %',
      pg_temp.shown(pg_temp.akp_q(), pg_temp.akp_p(), 'true');
  end if;
  if pg_temp.shown(pg_temp.akp_q(), pg_temp.akp_p(), 'false') <> '1,2,3,4/4'
     or pg_temp.shown(pg_temp.akp_q(), pg_temp.akp_p(), 'false') <> pg_temp.shown(pg_temp.akp_q(), pg_temp.akp_p(), 'v2') then
    raise exception '170: with the flag false v3 must return what v2 returns; got % against %',
      pg_temp.shown(pg_temp.akp_q(), pg_temp.akp_p(), 'false'), pg_temp.shown(pg_temp.akp_q(), pg_temp.akp_p(), 'v2');
  end if;
end $$;
rollback;

-- 3. The neutral title counts as a headline; the second summary line counts in neither mode. ----------------------------------
begin;
select pg_temp.fx(1, 'Komisyon toplandı', 'AK Parti''den açıklama', 'x');
select pg_temp.fx(2, 'Gündem', null, E'İlk satır.\nAKP açıklaması geldi.');
select pg_temp.fx(3, 'Gündem', null, E'AKP açıklaması geldi.\nİkinci satır.');
do $$
begin
  if pg_temp.shown(pg_temp.akp_q(), pg_temp.akp_p(), 'true') <> '1/1' then
    raise exception '170: the neutral title should count and no summary line should; got %',
      pg_temp.shown(pg_temp.akp_q(), pg_temp.akp_p(), 'true');
  end if;
  if pg_temp.shown(pg_temp.akp_q(), pg_temp.akp_p(), 'false') <> '1,3/2' then
    raise exception '170: the lead mode should count the first line only; got %',
      pg_temp.shown(pg_temp.akp_q(), pg_temp.akp_p(), 'false');
  end if;
end $$;
rollback;

-- 4. A missing flag and a NULL flag are the lead mode, as v2 is. ---------------------------------------------------------------
begin;
select pg_temp.fx(1, 'Kültür ve Turizm Bakanlığının bütçesi', null, 'AK Parti Samsun Milletvekili başkanlığında toplandı.');
select pg_temp.fx(2, 'AK Parti''den açıklama');
do $$
begin
  if pg_temp.shown(pg_temp.akp_q(), pg_temp.akp_p(), 'omitted') <> '1,2/2'
     or pg_temp.shown(pg_temp.akp_q(), pg_temp.akp_p(), 'null') <> '1,2/2' then
    raise exception '170: a missing or NULL flag should be the lead mode; got % and %',
      pg_temp.shown(pg_temp.akp_q(), pg_temp.akp_p(), 'omitted'), pg_temp.shown(pg_temp.akp_q(), pg_temp.akp_p(), 'null');
  end if;
end $$;
rollback;

-- 5. The other hubs: the flag false is v2 for the chp patterns too (the lead of a "CHP Genel Başkanı" story still counts). ------
begin;
select pg_temp.fx(1, 'Komisyon toplandı', null, 'CHP Genel Başkanı Özel açıklama yaptı.');
select pg_temp.fx(2, 'CHP''den açıklama');
do $$
declare q text[] := array['chp']; p text[] := array['\mchp\M'];
begin
  if pg_temp.shown(q, p, 'false') <> '1,2/2' or pg_temp.shown(q, p, 'false') <> pg_temp.shown(q, p, 'v2') then
    raise exception '170: chp with the flag false should be v2; got % against %', pg_temp.shown(q, p, 'false'), pg_temp.shown(q, p, 'v2');
  end if;
  if pg_temp.shown(q, p, 'true') <> '2/1' then
    raise exception '170: chp with the flag true should be headline-only; got %', pg_temp.shown(q, p, 'true');
  end if;
end $$;
rollback;

-- 6. The prefilter is still ANDed with the regex, in both modes. --------------------------------------------------------------
begin;
select pg_temp.fx(1, 'AK Parti''den açıklama');
do $$
declare p text[] := pg_temp.akp_p();
begin
  if pg_temp.shown(array['zelenski'], p, 'true') <> '-/0' or pg_temp.shown(array['zelenski'], p, 'false') <> '-/0' then
    raise exception '170: a headline that matches the regex but not the queries should not be returned';
  end if;
  if pg_temp.shown(pg_temp.akp_q(), array[]::text[], 'true') <> '-/0' or pg_temp.shown(pg_temp.akp_q(), null, 'true') <> '-/0'
     or pg_temp.shown(pg_temp.akp_q(), array[''], 'true') <> '-/0' then
    raise exception '170: empty or null p_patterns should return zero rows';
  end if;
end $$;
rollback;

-- 7. The live predicate and the window are v2's. -------------------------------------------------------------------------------
begin;
select pg_temp.fx(1, 'AK Parti''den açıklama');
select pg_temp.fx(2, 'AK Parti''den açıklama', archived => true);
select pg_temp.fx(3, 'AK Parti''den açıklama', merged => true);
select pg_temp.fx(4, 'AK Parti''den açıklama', cnt => 1);
select pg_temp.fx(5, 'AK Parti''den açıklama', age => interval '31 days');
select pg_temp.fx(6, 'AK Parti''den açıklama', age => interval '13 days');
do $$
begin
  if pg_temp.shown(pg_temp.akp_q(), pg_temp.akp_p(), 'true') <> '1,6/2' then
    raise exception '170: archived, merged, single-article and 31-day-old clusters should not be returned; got %',
      pg_temp.shown(pg_temp.akp_q(), pg_temp.akp_p(), 'true');
  end if;
  if pg_temp.shown(pg_temp.akp_q(), pg_temp.akp_p(), 'false') <> pg_temp.shown(pg_temp.akp_q(), pg_temp.akp_p(), 'v2') then
    raise exception '170: the live predicate differs from v2''s';
  end if;
end $$;
rollback;

-- 8. The bounds are v2's: newest first, the total before the limit, limit clamped to 1..50. ------------------------------------
begin;
select pg_temp.fx(g, 'AK Parti''den açıklama') from generate_series(1, 55) g;
do $$
declare first3 text; n_default int; n_clamped int; n_floor int; total_before_limit text;
begin
  select string_agg(right(id::text, 12)::int::text, ',') into first3
    from (select id from public.entity_cluster_ids_v3(pg_temp.akp_q(), pg_temp.akp_p(), null, 3, true)) s;
  select count(*) into n_default from public.entity_cluster_ids_v3(pg_temp.akp_q(), pg_temp.akp_p(), null, null, true);
  select count(*) into n_clamped from public.entity_cluster_ids_v3(pg_temp.akp_q(), pg_temp.akp_p(), null, 1000, true);
  select count(*) into n_floor from public.entity_cluster_ids_v3(pg_temp.akp_q(), pg_temp.akp_p(), null, 0, true);
  select max(total)::text into total_before_limit from public.entity_cluster_ids_v3(pg_temp.akp_q(), pg_temp.akp_p(), null, 3, true);
  if first3 <> '1,2,3' or n_default <> 20 or n_clamped <> 50 or n_floor <> 1 or total_before_limit <> '55' then
    raise exception '170: bounds changed: first % / default % / clamped % / floor % / total %', first3, n_default, n_clamped, n_floor, total_before_limit;
  end if;
end $$;
rollback;

-- 9. Nothing was left behind by the scenarios above. ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from public.clusters) then
    raise exception 'a rolled-back fixture survived';
  end if;
end $$;

select 'DRYRUN 170 OK';
