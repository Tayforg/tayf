-- 199 entity_cluster_ids_v4_offset (entity_cluster_ids_v4 = v3 plus p_offset, so /gundem/<key>?sayfa=N can page past the first 20):
-- local PG15 dry-run. Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55571 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55571 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/199-entity-cluster-ids-v4-offset-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql PGHOST=/tmp PGPORT=55571 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/199-entity-cluster-ids-v4-offset)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh    (TAYF_LIVE_ONLY=199 runs just this one)
--
-- (\ir paths below are relative to this file.) Every check is a DO block or a pg_temp function that raises on
-- mismatch, so a clean run ending in "DRYRUN 199 OK" is the pass. Every scenario that writes sits inside begin ...
-- rollback, so the database this leaves behind has 156, 170 and 199 applied and holds no fixture rows.
--
-- Why it exists. 199's JS test (tests/migrations/199-entity-cluster-ids-v4-offset.test.ts) reads the SQL as text; this
-- runs the SHIPPED function in PostgreSQL: that the baseline is production's v3 (170's body, md5 pinned) with no v4, that
-- v4 with offset 0, NULL or a negative offset returns what v3 returns (ids, order and total), that the pages of one hub
-- are disjoint and their union is the whole matched set, that total is the full match count on every row of every page,
-- that the order has a total tie-break, that the offset is clamped to 1000 and the limit to 1..50, that the headline-only
-- flag and the live predicate still hold on a later page, that v3 is untouched, and that applying 199 twice leaves one
-- body, one comment and one ledger row.
--
-- Order: the state 199 sits on (the stub's clusters gets summary_tr, merged_into, 035's generated search_tsv and 083's partial
-- index, which production has), 156 and 170 as production has them (applied from their own files; v3's md5 is pinned), v4's
-- absence, then 199 TWICE, the new fingerprint and attributes, and the scenarios.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Prelude: the state 199 sits on (the same as 170's). ------------------------------------------------------------------
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

-- 156 and 170, from their own files: production's v3 before 199 (md5(prosrc) read on production on 2026-11-11). -----------
\ir ../../../supabase/migrations/156_entity_cluster_ids_v3.sql
\ir ../../../supabase/migrations/170_entity_cluster_ids_headline_only.sql

-- Fixture helpers (session-local). Cluster n has uuid c0000000-...-<n, 12 digits>.
create function pg_temp.cu(n int) returns uuid language sql immutable as
  $f$ select ('c0000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $f$;
-- One cluster: n, headline, neutral headline, stored summary, plus optional member count, state and ages. `published` is how
-- long ago first_published was (default: n minutes, so a lower n is newer).
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
-- What a call returns: the fixture numbers in the function's order, then '/' and the total ("-/0" for none). fn is 'v3' or
-- 'v4'; off is v4's p_offset ('omitted' leaves the argument out; null passes NULL); flag is the headline-only flag.
create function pg_temp.shown(q text[], p text[], fn text, flag boolean, lim int, off text default 'omitted') returns text
language plpgsql as $f$
declare r text;
begin
  if fn = 'v3' then
    select coalesce(string_agg(right(s.id::text, 12)::int::text, ',' order by s.ord), '-') || '/' || coalesce(max(s.total), 0) into r
      from (select e.id, e.total, row_number() over () as ord from public.entity_cluster_ids_v3(q, p, null, lim, flag) e) s;
  elsif off = 'omitted' then
    select coalesce(string_agg(right(s.id::text, 12)::int::text, ',' order by s.ord), '-') || '/' || coalesce(max(s.total), 0) into r
      from (select e.id, e.total, row_number() over () as ord from public.entity_cluster_ids_v4(q, p, null, lim, flag) e) s;
  elsif off = 'null' then
    select coalesce(string_agg(right(s.id::text, 12)::int::text, ',' order by s.ord), '-') || '/' || coalesce(max(s.total), 0) into r
      from (select e.id, e.total, row_number() over () as ord from public.entity_cluster_ids_v4(q, p, null, lim, flag, null) e) s;
  else
    select coalesce(string_agg(right(s.id::text, 12)::int::text, ',' order by s.ord), '-') || '/' || coalesce(max(s.total), 0) into r
      from (select e.id, e.total, row_number() over () as ord from public.entity_cluster_ids_v4(q, p, null, lim, flag, off::int) e) s;
  end if;
  return r;
end $f$;

-- Baseline: this is production's v3 (md5(prosrc) read on production on 2026-11-11) with its ACL (owner + service_role,
-- nobody else), and there is no v4 yet. --------------------------------------------------------------------------------
create temp table before_199 as
  select md5(prosrc) as m, length(prosrc) as len,
         (select string_agg(case when a.grantee = 0 then 'public' else a.grantee::regrole::text end || ':' || a.privilege_type,
                            ',' order by case when a.grantee = 0 then 'public' else a.grantee::regrole::text end)
            from aclexplode(p.proacl) a) as grants,
         proconfig::text as cfg, provolatile, prosecdef, proretset, proowner::regrole::text as owner,
         pg_get_function_result(oid) as res, pg_get_function_arguments(oid) as args, prolang,
         obj_description(oid, 'pg_proc') as cmt
    from pg_proc p where oid = 'public.entity_cluster_ids_v3(text[], text[], timestamptz, integer, boolean)'::regprocedure;

do $$
declare b record;
begin
  select * into b from before_199;
  if b.m <> 'bc1ea39f547ca8d6810833f12c7bd983' or b.len <> 1117 then
    raise exception 'baseline: the prelude function is not production''s v3 (md5 %, length %)', b.m, b.len;
  end if;
  if b.grants not like '%service_role:EXECUTE%' or b.grants like '%anon%' or b.grants like '%authenticated%' or b.grants like '%public%' then
    raise exception 'baseline: unexpected grants %', b.grants;
  end if;
  if not b.prosecdef or b.provolatile <> 's' or b.cfg is distinct from '{"search_path=\"\""}' or not b.proretset then
    raise exception 'baseline: unexpected attributes (secdef %, volatile %, config %)', b.prosecdef, b.provolatile, b.cfg;
  end if;
  if to_regprocedure('public.entity_cluster_ids_v4(text[], text[], timestamptz, integer, boolean, integer)') is not null
     or exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'entity_cluster_ids_v4') then
    raise exception 'baseline: an object named entity_cluster_ids_v4 already exists';
  end if;
end $$;

-- 199, TWICE (safe to re-apply). ---------------------------------------------------------------------------------------
\ir ../../../supabase/migrations/199_entity_cluster_ids_v4_offset.sql
create temp table after_199_first as
  select md5(prosrc) as m, proacl::text as acl, obj_description(oid, 'pg_proc') as cmt
    from pg_proc where oid = 'public.entity_cluster_ids_v4(text[], text[], timestamptz, integer, boolean, integer)'::regprocedure;
\ir ../../../supabase/migrations/199_entity_cluster_ids_v4_offset.sql

-- 1. The new function: its fingerprint and attributes; v3 as it was. ---------------------------------------------------
do $$
declare a record; b record; f record; v3 record;
begin
  select * into b from before_199;
  select md5(prosrc) as m, length(prosrc) as len,
         (select string_agg(case when x.grantee = 0 then 'public' else x.grantee::regrole::text end || ':' || x.privilege_type,
                            ',' order by case when x.grantee = 0 then 'public' else x.grantee::regrole::text end)
            from aclexplode(p.proacl) x) as grants,
         proconfig::text as cfg, provolatile, prosecdef, proretset, proowner::regrole::text as owner,
         pg_get_function_result(oid) as res, pg_get_function_arguments(oid) as args, prolang
    into a from pg_proc p where oid = 'public.entity_cluster_ids_v4(text[], text[], timestamptz, integer, boolean, integer)'::regprocedure;

  if a.m <> '364c7c7d99da7c27b42dc9673319ac14' or a.len <> 1174 then
    raise exception '199: unexpected body (md5 %, length %)', a.m, a.len;
  end if;
  if a.m = b.m then raise exception '199: the new body equals v3''s'; end if;
  if a.grants is distinct from b.grants then raise exception '199: v4 grants differ from v3''s: % -> %', b.grants, a.grants; end if;
  if a.cfg is distinct from b.cfg or a.provolatile <> b.provolatile or a.prosecdef <> b.prosecdef or a.proretset <> b.proretset
     or a.owner <> b.owner or a.prolang <> b.prolang or a.res <> b.res then
    raise exception '199: an attribute of v4 differs from v3''s';
  end if;
  if a.args <> b.args || ', p_offset integer DEFAULT 0' then
    raise exception '199: unexpected arguments %', a.args;
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'entity_cluster_ids_v4') <> 1 then
    raise exception '199: more than one entity_cluster_ids_v4 overload';
  end if;
  -- the second apply left the first apply's result
  select * into f from after_199_first;
  if f.m <> a.m then raise exception '199: the second apply changed the body'; end if;
  if has_function_privilege('anon', 'public.entity_cluster_ids_v4(text[], text[], timestamptz, integer, boolean, integer)', 'execute')
     or has_function_privilege('authenticated', 'public.entity_cluster_ids_v4(text[], text[], timestamptz, integer, boolean, integer)', 'execute')
     or not has_function_privilege('service_role', 'public.entity_cluster_ids_v4(text[], text[], timestamptz, integer, boolean, integer)', 'execute') then
    raise exception '199: execute privileges are not service_role only';
  end if;
  if obj_description('public.entity_cluster_ids_v4(text[], text[], timestamptz, integer, boolean, integer)'::regprocedure, 'pg_proc') not like '%service_role only.'
     or obj_description('public.entity_cluster_ids_v4(text[], text[], timestamptz, integer, boolean, integer)'::regprocedure, 'pg_proc') not like '%migration 199%' then
    raise exception '199: the function comment is not the 199 comment';
  end if;
  -- v3 is exactly what it was: body, grants, attributes, comment
  select md5(prosrc) as m, length(prosrc) as len, obj_description(oid, 'pg_proc') as cmt
    into v3 from pg_proc where oid = 'public.entity_cluster_ids_v3(text[], text[], timestamptz, integer, boolean)'::regprocedure;
  if v3.m <> b.m or v3.len <> b.len or v3.cmt is distinct from b.cmt then raise exception '199: v3 changed'; end if;
  if not has_function_privilege('service_role', 'public.entity_cluster_ids_v3(text[], text[], timestamptz, integer, boolean)', 'execute')
     or has_function_privilege('anon', 'public.entity_cluster_ids_v3(text[], text[], timestamptz, integer, boolean)', 'execute') then
    raise exception '199: v3 privileges changed';
  end if;
  -- 170 and 199 each recorded their own ledger row, once even though 199 was applied twice
  if (select count(*) from supabase_migrations.schema_migrations where version = '199') <> 1
     or (select name from supabase_migrations.schema_migrations where version = '199') <> '199_entity_cluster_ids_v4_offset' then
    raise exception '199: the ledger row is not exactly one row named 199_entity_cluster_ids_v4_offset';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '170') <> 1 then
    raise exception '199: 170''s ledger row changed';
  end if;
  -- no table was touched
  if exists (select 1 from public.clusters) then raise exception '199: a cluster row survived'; end if;
end $$;

-- 2. Page 1 parity: offset 0, an omitted offset, a NULL offset and a negative offset return what v3 returns (ids, order, total),
-- in both headline modes and on a mixed set (a live row, an archived one, a merged one, a one-article one, an old one). ----
begin;
select pg_temp.fx(g, 'AK Parti''den açıklama ' || g) from generate_series(1, 55) g;
select pg_temp.fx(56, 'AK Parti''den açıklama 56', archived => true);
select pg_temp.fx(57, 'AK Parti''den açıklama 57', merged => true);
select pg_temp.fx(58, 'AK Parti''den açıklama 58', cnt => 1);
select pg_temp.fx(59, 'AK Parti''den açıklama 59', age => interval '31 days');
select pg_temp.fx(60, 'Komisyon toplandı', null, 'AK Parti Samsun Milletvekili başkanlığında toplandı.');
do $$
declare q text[] := pg_temp.akp_q(); p text[] := pg_temp.akp_p(); flag boolean; lim int; off text;
begin
  foreach flag in array array[true, false] loop
    foreach lim in array array[1, 3, 20, 50] loop
      foreach off in array array['omitted', 'null', '0', '-1', '-100'] loop
        if pg_temp.shown(q, p, 'v4', flag, lim, off) <> pg_temp.shown(q, p, 'v3', flag, lim) then
          raise exception '199: v4 (flag %, limit %, offset %) is not v3: % against %', flag, lim, off,
            pg_temp.shown(q, p, 'v4', flag, lim, off), pg_temp.shown(q, p, 'v3', flag, lim);
        end if;
      end loop;
    end loop;
  end loop;
  -- the live predicate is still v3's: archived, merged, single-article and 31-day-old clusters are out
  if pg_temp.shown(q, p, 'v4', true, 50, '0') <> (select string_agg(g::text, ',' order by g) from generate_series(1, 50) g) || '/55'
     or pg_temp.shown(q, p, 'v4', true, 50, '50') <> (select string_agg(g::text, ',' order by g) from generate_series(51, 55) g) || '/55' then
    raise exception '199: the live predicate changed; got % | %', pg_temp.shown(q, p, 'v4', true, 50, '0'), pg_temp.shown(q, p, 'v4', true, 50, '50');
  end if;
  -- and the lead mode still sees the summary lead (56 matched, one more than the headline mode)
  if pg_temp.shown(q, p, 'v4', false, 50, '0') not like '%/56' then
    raise exception '199: the lead mode should count the summary lead; got %', pg_temp.shown(q, p, 'v4', false, 50, '0');
  end if;
end $$;
rollback;

-- 3. The pages of one hub are disjoint, their union is the matched set, total is the full count on every row. -----------
begin;
select pg_temp.fx(g, 'AK Parti''den açıklama ' || g) from generate_series(1, 55) g;
do $$
declare q text[] := pg_temp.akp_q(); p text[] := pg_temp.akp_p(); got text;
begin
  if pg_temp.shown(q, p, 'v4', true, 20, '0') <> (select string_agg(g::text, ',' order by g) from generate_series(1, 20) g) || '/55'
     or pg_temp.shown(q, p, 'v4', true, 20, '20') <> (select string_agg(g::text, ',' order by g) from generate_series(21, 40) g) || '/55'
     or pg_temp.shown(q, p, 'v4', true, 20, '40') <> (select string_agg(g::text, ',' order by g) from generate_series(41, 55) g) || '/55' then
    raise exception '199: pages 1..3 are not 1-20, 21-40 and 41-55 with total 55; got % | % | %',
      pg_temp.shown(q, p, 'v4', true, 20, '0'), pg_temp.shown(q, p, 'v4', true, 20, '20'), pg_temp.shown(q, p, 'v4', true, 20, '40');
  end if;
  -- past the end: no rows (and so no total: the app reads it from page 1)
  if pg_temp.shown(q, p, 'v4', true, 20, '60') <> '-/0' or pg_temp.shown(q, p, 'v4', true, 20, '55') <> '-/0' then
    raise exception '199: a page past the end should be empty; got % and %',
      pg_temp.shown(q, p, 'v4', true, 20, '60'), pg_temp.shown(q, p, 'v4', true, 20, '55');
  end if;
  -- every row of every non-empty page carries the full count
  select string_agg(distinct total::text, ',') into got
    from (select total from public.entity_cluster_ids_v4(q, p, null, 20, true, 0)
          union all select total from public.entity_cluster_ids_v4(q, p, null, 20, true, 20)
          union all select total from public.entity_cluster_ids_v4(q, p, null, 20, true, 40)) s;
  if got <> '55' then raise exception '199: total should be 55 on every row of every page; got %', got; end if;
  -- a page that does not start on a multiple of the limit: offset 5, limit 10 is rows 6-15
  if pg_temp.shown(q, p, 'v4', true, 10, '5') <> (select string_agg(g::text, ',' order by g) from generate_series(6, 15) g) || '/55' then
    raise exception '199: offset 5 limit 10 should be rows 6-15; got %', pg_temp.shown(q, p, 'v4', true, 10, '5');
  end if;
end $$;
rollback;

-- 4. The order has a total tie-break: clusters first published at the very same instant never move between pages. ----------
begin;
-- 45 clusters, all with one first_published (23 minutes ago): the order is then by id alone
select pg_temp.fx(g, 'AK Parti''den açıklama ' || g, published => interval '23 minutes') from generate_series(1, 45) g;
do $$
declare q text[] := pg_temp.akp_q(); p text[] := pg_temp.akp_p();
begin
  if pg_temp.shown(q, p, 'v4', true, 20, '0') <> (select string_agg(g::text, ',' order by g) from generate_series(1, 20) g) || '/45'
     or pg_temp.shown(q, p, 'v4', true, 20, '20') <> (select string_agg(g::text, ',' order by g) from generate_series(21, 40) g) || '/45'
     or pg_temp.shown(q, p, 'v4', true, 20, '40') <> (select string_agg(g::text, ',' order by g) from generate_series(41, 45) g) || '/45' then
    raise exception '199: with equal first_published the pages should follow the id order; got % | % | %',
      pg_temp.shown(q, p, 'v4', true, 20, '0'), pg_temp.shown(q, p, 'v4', true, 20, '20'), pg_temp.shown(q, p, 'v4', true, 20, '40');
  end if;
end $$;
rollback;

-- 5. The newest first: a lower first_published age is a higher rank, whatever the insertion order. --------------------------
begin;
select pg_temp.fx(1, 'AK Parti''den açıklama 1', published => interval '5 hours');
select pg_temp.fx(2, 'AK Parti''den açıklama 2', published => interval '1 hour');
select pg_temp.fx(3, 'AK Parti''den açıklama 3', published => interval '3 hours');
select pg_temp.fx(4, 'AK Parti''den açıklama 4', published => interval '2 hours');
do $$
declare q text[] := pg_temp.akp_q(); p text[] := pg_temp.akp_p();
begin
  if pg_temp.shown(q, p, 'v4', true, 2, '0') <> '2,4/4' or pg_temp.shown(q, p, 'v4', true, 2, '2') <> '3,1/4' then
    raise exception '199: pages should run newest first by first_published; got % | %',
      pg_temp.shown(q, p, 'v4', true, 2, '0'), pg_temp.shown(q, p, 'v4', true, 2, '2');
  end if;
end $$;
rollback;

-- 6. The bounds: the offset is clamped to 0..1000, the limit to 1..50 (v3's clamp), NULL for either is the default. ---------
begin;
select pg_temp.fx(g, 'AK Parti''den açıklama ' || g) from generate_series(1, 1030) g;
do $$
declare q text[] := pg_temp.akp_q(); p text[] := pg_temp.akp_p(); at1000 text; n int;
begin
  at1000 := pg_temp.shown(q, p, 'v4', true, 20, '1000');
  if at1000 <> (select string_agg(g::text, ',' order by g) from generate_series(1001, 1020) g) || '/1030' then
    raise exception '199: offset 1000 should be rows 1001-1020 of 1030; got %', at1000;
  end if;
  -- past the clamp every offset is answered with the clamp's window, which is why the app never asks for one
  if pg_temp.shown(q, p, 'v4', true, 20, '1001') <> at1000 or pg_temp.shown(q, p, 'v4', true, 20, '5000') <> at1000
     or pg_temp.shown(q, p, 'v4', true, 20, '2147483647') <> at1000 then
    raise exception '199: an offset past 1000 should be clamped to 1000';
  end if;
  -- the limit clamp is v3's, with an offset: limit 1000 -> 50, limit 0 -> 1, NULL -> 20
  select count(*) into n from public.entity_cluster_ids_v4(q, p, null, 1000, true, 10);
  if n <> 50 then raise exception '199: limit 1000 with an offset should be clamped to 50; got %', n; end if;
  select count(*) into n from public.entity_cluster_ids_v4(q, p, null, 0, true, 10);
  if n <> 1 then raise exception '199: limit 0 with an offset should be clamped to 1; got %', n; end if;
  select count(*) into n from public.entity_cluster_ids_v4(q, p, null, null, true, 10);
  if n <> 20 then raise exception '199: a NULL limit with an offset should be 20; got %', n; end if;
  if pg_temp.shown(q, p, 'v4', true, 100, '10') <> (select string_agg(g::text, ',' order by g) from generate_series(11, 60) g) || '/1030' then
    raise exception '199: limit 100 (clamped to 50) with offset 10 should be rows 11-60; got %', pg_temp.shown(q, p, 'v4', true, 100, '10');
  end if;
  -- a NULL headline flag is the lead mode, as in v3
  select count(*) into n from public.entity_cluster_ids_v4(q, p, null, 50, null, 0);
  if n <> 50 then raise exception '199: a NULL flag should still list; got %', n; end if;
end $$;
rollback;

-- 7. The headline-only flag and the regex guard still apply on a later page. -----------------------------------------------
begin;
-- 30 clusters that name the party in the headline, 30 that name it only in the summary lead
select pg_temp.fx(g, 'AK Parti''den açıklama ' || g) from generate_series(1, 30) g;
select pg_temp.fx(g, 'Komisyon toplandı ' || g, null, 'AK Parti Samsun Milletvekili başkanlığında toplandı.') from generate_series(31, 60) g;
do $$
declare q text[] := pg_temp.akp_q(); p text[] := pg_temp.akp_p();
begin
  -- headline mode: 30 matches, page 2 holds 10 of them (21-30)
  if pg_temp.shown(q, p, 'v4', true, 20, '20') <> (select string_agg(g::text, ',' order by g) from generate_series(21, 30) g) || '/30' then
    raise exception '199: headline mode page 2 should be 21-30 of 30; got %', pg_temp.shown(q, p, 'v4', true, 20, '20');
  end if;
  -- lead mode: 60 matches, page 2 is 21-40
  if pg_temp.shown(q, p, 'v4', false, 20, '20') <> (select string_agg(g::text, ',' order by g) from generate_series(21, 40) g) || '/60' then
    raise exception '199: lead mode page 2 should be 21-40 of 60; got %', pg_temp.shown(q, p, 'v4', false, 20, '20');
  end if;
  -- the prefilter is still ANDed with the regex on a later page; empty or null patterns return nothing
  if pg_temp.shown(array['zelenski'], p, 'v4', true, 20, '0') <> '-/0'
     or pg_temp.shown(q, array[]::text[], 'v4', true, 20, '20') <> '-/0'
     or pg_temp.shown(q, null, 'v4', true, 20, '20') <> '-/0'
     or pg_temp.shown(q, array[''], 'v4', true, 20, '20') <> '-/0' then
    raise exception '199: the prefilter and the regex guard should both still apply on a later page';
  end if;
end $$;
rollback;

-- 8. Nothing was left behind by the scenarios above. ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from public.clusters) then
    raise exception 'a rolled-back fixture survived';
  end if;
end $$;

select 'DRYRUN 199 OK';
