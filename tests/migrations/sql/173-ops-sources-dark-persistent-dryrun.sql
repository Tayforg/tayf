-- 173 ops_health_report() row 22 (sources_dark_persistent): a high-volume source that stays dark stays named:
-- local PG15 dry-run. Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55573 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55573 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/173-ops-sources-dark-persistent-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql PGHOST=/tmp PGPORT=55573 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/173-ops-sources-dark-persistent)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh
--
-- (\ir paths below are relative to this file.) Every check is a DO block or a pg_temp function that raises on
-- mismatch, so a clean run ending in "DRYRUN 173 OK" is the pass. Every scenario that writes (sources and articles
-- fixtures) sits inside begin ... rollback; the database this leaves behind has 173 applied and no fixture in it.
--
-- Order: 150's dry-run (114, 115, 119, 122, 136, 145 and 150 in production order, on stand-ins for pg_cron, pg_net
-- and pgmq, so ops_health_report() and ops_dark_source_baseline exist), 041 (sources.fetch_last_at) and 157 (the
-- ingest_cycles counters), 161 and 167 (the text production runs, gated on its md5), a baseline reading (21 rows),
-- then 173 TWICE, then the scenarios.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Prelude: the history 173 sits on. -----------------------------------------------------------------------
\ir 150-ops-queue-cron-liveness-dryrun.sql
\ir ../../../supabase/migrations/041_source_fetch_state.sql
\ir ../../../supabase/migrations/157_ingest_poll_stale.sql
\ir ../../../supabase/migrations/161_image_coverage_by_source.sql
\ir ../../../supabase/migrations/167_ops_queue_poison_contract.sql

-- The deployed body is the one 173 starts from: 167's fingerprint (production, read-only, 2026-11-08).
do $$
declare v_md5 text; v_len int;
begin
  select md5(prosrc), length(prosrc) into v_md5, v_len from pg_proc where oid = 'public.ops_health_report()'::regprocedure;
  if v_md5 <> '5a9f9e384da09a19df1cd73a3f8ba4a5' or v_len <> 47439 then
    raise exception 'the local 167 body differs from production (md5 gate): % / %', v_md5, v_len;
  end if;
end $$;

-- Helpers: fixtures and row assertions. -----------------------------------------------------------------------
create function pg_temp.clean() returns void language plpgsql as $$
begin
  delete from public.articles;
  delete from public.sources;
  delete from public.ops_dark_source_baseline;
end $$;

-- a source; p_status / p_streak set its fetch state (null status and streak 0 read 'erişim yok': no status yet)
create function pg_temp.mk_source(p_slug text, p_kind text default 'outlet', p_active boolean default true,
                                  p_status int default null, p_streak int default 0) returns void language plpgsql as $$
begin
  insert into public.sources (slug, name, active, kind, fetch_last_status, fetch_fail_streak)
    values (p_slug, p_slug, p_active, p_kind, p_status, p_streak);
end $$;

-- p_n articles of the source created p_created_ago ago (spread over seconds), published p_published_ago ago (default the same)
create function pg_temp.mk_articles(p_slug text, p_created_ago interval, p_n int, p_published_ago interval default null) returns void language plpgsql as $$
begin
  insert into public.articles (source_id, title, url, content_hash, published_at, created_at)
    select s.id, 't ' || g, 'https://example.test/' || p_slug || '/' || g::text || '/' || gen_random_uuid()::text,
           'h-' || p_slug || '-' || g::text || '-' || gen_random_uuid()::text,
           now() - coalesce(p_published_ago, p_created_ago),
           now() - p_created_ago - (g || ' seconds')::interval
      from public.sources s, generate_series(1, p_n) g where s.slug = p_slug;
end $$;

create function pg_temp.assert_row22(p_label text, p_status text, p_observed numeric, p_detail text default null) returns void language plpgsql as $$
declare r record;
begin
  select l.status as st, l.observed as ob, l.threshold as th, l.detail as dt into r
    from public.ops_health_report() l where l.check_name = 'sources_dark_persistent';
  if r.st is distinct from p_status or r.ob is distinct from p_observed or r.th is distinct from 1
     or (p_detail is not null and r.dt is distinct from p_detail) then
    raise exception '%: wanted % / % / 1 / %, got % / % / % / %', p_label, p_status, p_observed, p_detail, r.st, r.ob, r.th, r.dt;
  end if;
end $$;

create function pg_temp.assert_row13(p_label text, p_status text) returns void language plpgsql as $$
declare r record;
begin
  select l.status as st, l.detail as dt into r from public.ops_health_report() l where l.check_name = 'sources_newly_dark';
  if r.st is distinct from p_status then
    raise exception '%: row 13 wanted %, got % / %', p_label, p_status, r.st, r.dt;
  end if;
end $$;

-- the date row 22 prints for an article published p_ago ago
create function pg_temp.ist(p_ago interval) returns text language sql as $$
  select to_char((now() - p_ago) at time zone 'Europe/Istanbul', 'DD.MM') $$;

-- Baseline (what production runs the moment before 173): the report has 21 rows and no sources_dark_persistent. ---
create temp table before_173 as
  select t.n, t.check_name, t.status
    from public.ops_health_report() with ordinality as t(check_name, status, observed, threshold, detail, n);

do $$
begin
  if (select count(*) from before_173) <> 21 then raise exception 'baseline: wanted 21 report rows, got %', (select count(*) from before_173); end if;
  if (select check_name from before_173 where n = 21) <> 'image_coverage' then raise exception 'baseline: row 21 is not image_coverage'; end if;
  if exists (select 1 from before_173 where check_name = 'sources_dark_persistent') then raise exception 'baseline: row 22 exists before 173'; end if;
end $$;

-- Apply: 173 TWICE (re-apply safety). ---------------------------------------------------------------------
\echo '--- first application of 173'
\ir ../../../supabase/migrations/173_ops_sources_dark_persistent.sql
\echo '--- second application of 173 (the ledger insert must say INSERT 0 0)'
\ir ../../../supabase/migrations/173_ops_sources_dark_persistent.sql

-- 1. the function: fingerprint, flags, ACL, comment, ledger --------------------------------------------------
do $$
declare f record;
begin
  select md5(p.prosrc) as m, length(p.prosrc) as len, p.prosecdef, p.provolatile, p.proconfig, p.proacl::text as acl,
         obj_description(p.oid, 'pg_proc') as cmt
    into f from pg_proc p where p.oid = 'public.ops_health_report()'::regprocedure;
  if f.m <> '55fa63d2f5d876feed93eb9f7b263b27' or f.len <> 52432 then
    raise exception 'the 173 body is not the pinned one: md5 %, length %', f.m, f.len;
  end if;
  if not f.prosecdef or f.provolatile <> 'v' or f.proconfig is distinct from array['search_path=""'] then
    raise exception 'function flags changed: % % %', f.prosecdef, f.provolatile, f.proconfig;
  end if;
  if f.acl is distinct from '{postgres=X/postgres,service_role=X/postgres}' then raise exception 'function ACL is %', f.acl; end if;
  if has_function_privilege('anon', 'public.ops_health_report()', 'execute')
     or has_function_privilege('authenticated', 'public.ops_health_report()', 'execute')
     or not has_function_privilege('service_role', 'public.ops_health_report()', 'execute') then
    raise exception 'function privileges are wrong';
  end if;
  if f.cmt not like '%22 fixed rows%' or f.cmt like '%21 fixed rows%' or f.cmt not like '%159, 161, 167, 173): 22 fixed rows%'
     or f.cmt not like '%sources_dark_persistent (an active outlet or wire source%' then
    raise exception 'the function comment is wrong: %', f.cmt;
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '173') <> 1 then
    raise exception 'the ledger should hold one 173 row';
  end if;
  if (select name from supabase_migrations.schema_migrations where version = '173') <> '173_ops_sources_dark_persistent' then
    raise exception 'the ledger name is wrong';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '167') <> 1 then
    raise exception 'the ledger should still hold one 167 row';
  end if;
end $$;

-- 2. the report: 22 rows, the first 21 as before (same names, order and statuses), row 22 last ------------------
do $$
begin
  if (select count(*) from public.ops_health_report()) <> 22 then raise exception 'the report should have 22 rows'; end if;
  if exists (
    select 1
      from before_173 b
      full join (select t.n, t.check_name, t.status
                   from public.ops_health_report() with ordinality as t(check_name, status, observed, threshold, detail, n)) a
        on a.n = b.n
     where a.n <= 21 and (a.check_name is distinct from b.check_name or a.status is distinct from b.status)
  ) then
    raise exception '173 changed a row name, an order position or a status of rows 1-21 on the unchanged state';
  end if;
  if (select t.check_name from public.ops_health_report() with ordinality as t(check_name, status, observed, threshold, detail, n) where t.n = 22) <> 'sources_dark_persistent' then
    raise exception 'row 22 is not sources_dark_persistent';
  end if;
end $$;

-- 3. row 22 scenarios (each one in a rolled-back transaction on emptied sources, articles and baseline) ---------
begin;  -- no source: pass, the Turkish pass text
select pg_temp.clean();
select pg_temp.assert_row22('no source', 'pass', 0, 'kalıcı susan kaynak yok');
rollback;

begin;  -- the 2026-11-08 shape: five dark sources with the production volumes (articles in the 60 days up to the newest one); row 13 has forgotten them (last article over 14 days 24 hours ago)
select pg_temp.clean();
select pg_temp.mk_source('halk-tv', 'outlet', true, 403, 45);
select pg_temp.mk_source('gazete-pencere', 'outlet', true, 403, 41);
select pg_temp.mk_source('benguturk', 'outlet', true, 403, 38);
select pg_temp.mk_source('arti-gercek', 'outlet', true, 403, 37);
select pg_temp.mk_source('medya-gazete', 'outlet', true, 404, 40);
select pg_temp.mk_articles('halk-tv', interval '23 days', 9768);
select pg_temp.mk_articles('gazete-pencere', interval '24 days', 6725);
select pg_temp.mk_articles('benguturk', interval '18 days', 7752);
select pg_temp.mk_articles('arti-gercek', interval '18 days', 2369);
select pg_temp.mk_articles('medya-gazete', interval '16 days', 4485);
select pg_temp.assert_row13('five dark sources, 16-24 days', 'pass');
select pg_temp.assert_row22('five dark sources', 'warn', 5,
  '72 saattir haber gelmeyen, önceki 60 günde en az 300 haberi olan ve listede olmayan kaynaklar: '
  || 'halk-tv (9768) · erişim yok · son haber ' || pg_temp.ist(interval '23 days') || ', '
  || 'benguturk (7752) · erişim yok · son haber ' || pg_temp.ist(interval '18 days') || ', '
  || 'gazete-pencere (6725) · erişim yok · son haber ' || pg_temp.ist(interval '24 days') || ', '
  || 'medya-gazete (4485) · erişim yok · son haber ' || pg_temp.ist(interval '16 days') || ', '
  || 'arti-gercek (2369) · erişim yok · son haber ' || pg_temp.ist(interval '18 days'));
-- the founder acks one slug: the row falls to four
insert into public.ops_dark_source_baseline (slug, reason) values ('benguturk', 'blocked-403');
select pg_temp.assert_row22('one slug baselined', 'warn', 4);
-- one source delivers again: three
select pg_temp.mk_articles('halk-tv', interval '1 hour', 1);
select pg_temp.assert_row22('one source delivers again', 'warn', 3);
-- one is set inactive: two
update public.sources set active = false where slug = 'gazete-pencere';
select pg_temp.assert_row22('one source set inactive', 'warn', 2);
rollback;

begin;  -- row 22 names what row 13 still names: dark for 10 days, 150 articles in row 13's window and 200 older ones
select pg_temp.clean();
select pg_temp.mk_source('a');
select pg_temp.mk_articles('a', interval '20 days', 200);
select pg_temp.mk_articles('a', interval '10 days', 150);
select pg_temp.assert_row13('dark 10 days, 150 + 200 articles', 'warn');
select pg_temp.assert_row22('dark 10 days, 150 + 200 articles', 'warn', 1,
  '72 saattir haber gelmeyen, önceki 60 günde en az 300 haberi olan ve listede olmayan kaynaklar: a (350) · erişim yok · son haber ' || pg_temp.ist(interval '10 days'));
rollback;

begin;  -- and goes on after row 13 has forgotten the source: dark for 20 days, 350 articles
select pg_temp.clean();
select pg_temp.mk_source('a');
select pg_temp.mk_articles('a', interval '20 days', 350);
select pg_temp.assert_row13('dark 20 days', 'pass');
select pg_temp.assert_row22('dark 20 days', 'warn', 1);
rollback;

begin;  -- 300 articles flag, 299 do not
select pg_temp.clean();
select pg_temp.mk_source('a');
select pg_temp.mk_articles('a', interval '30 days', 300);
select pg_temp.assert_row22('300 articles', 'warn', 1);
rollback;

begin;
select pg_temp.clean();
select pg_temp.mk_source('a');
select pg_temp.mk_articles('a', interval '30 days', 299);
select pg_temp.assert_row22('299 articles', 'pass', 0, 'kalıcı susan kaynak yok');
rollback;

begin;  -- the 72 hour edge of the newest article: 71 hours is a delivering source, 73 hours is dark
select pg_temp.clean();
select pg_temp.mk_source('a');
select pg_temp.mk_articles('a', interval '30 days', 400);
select pg_temp.mk_articles('a', interval '71 hours', 1);
select pg_temp.assert_row22('newest article 71 hours old', 'pass', 0);
rollback;

begin;
select pg_temp.clean();
select pg_temp.mk_source('a');
select pg_temp.mk_articles('a', interval '30 days', 400);
select pg_temp.mk_articles('a', interval '73 hours', 1);
select pg_temp.assert_row22('newest article 73 hours old', 'warn', 1);
rollback;

begin;  -- sticky: the window is anchored at the newest article, so the row does not roll off while the source stays dark (70 and 120 days)
select pg_temp.clean();
select pg_temp.mk_source('a');
select pg_temp.mk_articles('a', interval '70 days', 400);
select pg_temp.assert_row13('dark 70 days', 'pass');
select pg_temp.assert_row22('dark 70 days', 'warn', 1,
  '72 saattir haber gelmeyen, önceki 60 günde en az 300 haberi olan ve listede olmayan kaynaklar: a (400) · erişim yok · son haber ' || pg_temp.ist(interval '70 days'));
rollback;

begin;
select pg_temp.clean();
select pg_temp.mk_source('a');
select pg_temp.mk_articles('a', interval '120 days', 400);
select pg_temp.assert_row22('dark 120 days', 'warn', 1);
rollback;

begin;  -- the window is the 60 days up to the newest article: 89 days old counts (401 in all), 91 days old does not
select pg_temp.clean();
select pg_temp.mk_source('a');
select pg_temp.mk_articles('a', interval '30 days', 1);
select pg_temp.mk_articles('a', interval '89 days', 400);
select pg_temp.assert_row22('newest 30 days, 400 articles 89 days old', 'warn', 1,
  '72 saattir haber gelmeyen, önceki 60 günde en az 300 haberi olan ve listede olmayan kaynaklar: a (401) · erişim yok · son haber ' || pg_temp.ist(interval '30 days'));
rollback;

begin;
select pg_temp.clean();
select pg_temp.mk_source('a');
select pg_temp.mk_articles('a', interval '30 days', 1);
select pg_temp.mk_articles('a', interval '91 days', 400);
select pg_temp.assert_row22('newest 30 days, 400 articles 91 days old', 'pass', 0, 'kalıcı susan kaynak yok');
rollback;

begin;  -- the window is by published_at: created 60 hours ago but published 100 hours ago, the newest article is 100 hours old
select pg_temp.clean();
select pg_temp.mk_source('a');
select pg_temp.mk_articles('a', interval '60 hours', 400, interval '100 hours');
select pg_temp.assert_row22('created 60 hours ago, published 100 hours ago', 'warn', 1,
  '72 saattir haber gelmeyen, önceki 60 günde en az 300 haberi olan ve listede olmayan kaynaklar: a (400) · erişim yok · son haber ' || pg_temp.ist(interval '100 hours'));
rollback;

begin;  -- exclusions: another kind, an inactive source; a wire counts like an outlet
select pg_temp.clean();
select pg_temp.mk_source('a', 'aggregator');
select pg_temp.mk_articles('a', interval '30 days', 400);
select pg_temp.mk_source('b', 'outlet', false);
select pg_temp.mk_articles('b', interval '30 days', 400);
select pg_temp.assert_row22('aggregator and inactive source', 'pass', 0);
select pg_temp.mk_source('w', 'wire');
select pg_temp.mk_articles('w', interval '30 days', 400);
select pg_temp.assert_row22('a wire counts', 'warn', 1);
rollback;

begin;  -- a source with no article, and a source whose articles are all future-dated (no newest article: the date reads 'yok')
select pg_temp.clean();
select pg_temp.mk_source('empty');
select pg_temp.assert_row22('a source without any article', 'pass', 0);
select pg_temp.mk_source('future');
select pg_temp.mk_articles('future', interval '30 days', 400, interval '-10 days');
select pg_temp.assert_row22('future-dated articles', 'warn', 1,
  '72 saattir haber gelmeyen, önceki 60 günde en az 300 haberi olan ve listede olmayan kaynaklar: future (400) · erişim yok · son haber yok');
rollback;

begin;  -- never fail, and the detail is cut at 500 characters
select pg_temp.clean();
select pg_temp.mk_source('kaynak-' || lpad(g::text, 2, '0') || '-' || repeat('x', 40)) from generate_series(1, 12) g;
do $$
declare r record;
begin
  for r in select s.slug, row_number() over (order by s.slug) as n from public.sources s loop
    perform pg_temp.mk_articles(r.slug, interval '30 days', 300 + r.n::int);
  end loop;
  if (select l.status from public.ops_health_report() l where l.check_name = 'sources_dark_persistent') <> 'warn' then raise exception 'twelve flagged sources should warn'; end if;
  if (select l.observed from public.ops_health_report() l where l.check_name = 'sources_dark_persistent') <> 12 then raise exception 'observed should be 12'; end if;
  if (select length(l.detail) from public.ops_health_report() l where l.check_name = 'sources_dark_persistent') <> 500 then raise exception 'the detail should be cut at 500 characters'; end if;
end $$;
rollback;

begin;  -- the report works in a read-only transaction (production reads through one)
set transaction read only;
do $$ begin
  if (select count(*) from public.ops_health_report()) <> 22 then raise exception 'the report should have 22 rows in a read-only transaction'; end if;
end $$;
rollback;

begin;  -- anon still cannot call the report
do $$ begin
  set local role anon;
  begin
    perform * from public.ops_health_report();
    raise exception 'anon called ops_health_report';
  exception when insufficient_privilege then null;
  end;
  reset role;
end $$;
rollback;

-- Nothing is left behind. -------------------------------------------------------------------------------------
do $$
begin
  if (select count(*) from public.articles) + (select count(*) from public.sources) <> 0 then
    raise exception 'a fixture leaked out of its transaction';
  end if;
  if (select count(*) from public.ops_dark_source_baseline) <> 25 then
    raise exception 'the baseline seed of 114 should still hold its 25 rows, got %', (select count(*) from public.ops_dark_source_baseline);
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '173') <> 1 then
    raise exception 'the ledger should still hold one 173 row';
  end if;
end $$;

select 'DRYRUN 173 OK';
