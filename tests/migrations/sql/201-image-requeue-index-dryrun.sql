-- 201 image_requeue_partial_index (hunt-140, h140-perf-1): local PG15 dry-run. Never touches production.
--
-- Run on a fresh data dir (from the repo root). The server listens on 127.0.0.1 only (no unix socket: the
-- scratchpad path is longer than a socket path may be). The connecting role must be a superuser (scenario 9
-- forces indisvalid = false in pg_index, as 127's rehearsal did):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55741 -c listen_addresses=127.0.0.1 -c unix_socket_directories=" -l $D/log -w start
--   $PGBIN/createdb -h 127.0.0.1 -p 55741 -U postgres dry201
--   $PGBIN/psql -h 127.0.0.1 -p 55741 -U postgres -d dry201 -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/201-image-requeue-index-dryrun.sql
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh
--
-- (\ir paths below are relative to this file.) Every check is a select dry.ok(...) that raises on mismatch, so
-- a clean run ending in "DRYRUN 201 OK" is the pass. Scenario 9 turns ON_ERROR_STOP off for ONE apply that is
-- expected to abort (the invalid-index guard): that apply prints an ERROR and a ROLLBACK, and the checks after
-- it prove the ledger stayed untouched.
--
-- Order: a pgmq stand-in (only q_image_backfill, which the loop reads); the columns of public.articles the loop
-- reads; production's idx_articles_created_at (002); 220,000 production-shaped articles (69,000 in the last 7
-- days, as in production's 69,189, of which a few dozen are tries 1 and 2); ANALYZE; the loop query; then
-- 1. BEFORE plan, 2. the ORCHESTRATOR PRE-BUILD statement, 3. apply 201, 4. apply 201 again, 5. AFTER plan and
-- the same rows, 6. predicate coupling, 7. data unchanged, 8. pre-build skipped on a small table (201 builds in its
-- transaction), 8b. size guard (the table padded over 64 MB, no index: 201 refuses), 9. invalid index, 10. ledger.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Prelude A: a pgmq stand-in (no extension is installed locally). --------------------------------
create schema pgmq;
create table pgmq.q_image_backfill (msg_id bigint generated always as identity primary key, message jsonb);

-- Prelude B: the columns the loop reads, production's created_at index, and the data. -----------
alter table public.articles add column if not exists image_url text;
alter table public.articles add column if not exists image_backfill_attempts integer not null default 0;
alter table public.articles add column if not exists image_backfill_attempted_at timestamptz;
alter table public.articles add column if not exists created_at timestamptz not null default now();
create index idx_articles_created_at on public.articles (created_at desc);

-- 220,000 articles. i <= 69,000 is the last 7 days (one every 8.76 s), the rest runs 70 days further back.
--   last 7 days: every 14th article has no image and has not been tried (attempts 0, attempted_at null)
--   older:       i % 19 = 0 -> no image, attempts 1, tried 5 days ago     (about 5.3% of the old rows, like production's ~5.4%)
--                i % 190 = 1 -> no image, attempts 2, tried 5 days ago
--                i % 33 = 5 -> no image, attempts 0
--                i % 170 = 11 -> no image, attempts 5 (parked 7 days ahead) unless one of the first two applies
insert into public.articles (title, image_url, image_backfill_attempts, image_backfill_attempted_at, created_at)
select 'article ' || i,
       case when i <= 69000 then (case when i % 14 = 0 then null else 'https://example.invalid/' || i end)
            else (case when i % 19 = 0 or i % 190 = 1 or i % 33 = 5 or i % 170 = 11 then null else 'https://example.invalid/' || i end) end,
       case when i <= 69000 then 0
            else (case when i % 19 = 0 then 1 when i % 190 = 1 then 2 when i % 170 = 11 then 5 else 0 end) end,
       case when i <= 69000 then null
            else (case when i % 19 = 0 or i % 190 = 1 then now() - interval '5 days' when i % 170 = 11 then now() + interval '7 days' else null end) end,
       case when i <= 69000 then now() - i * interval '8.76 seconds'
            else now() - interval '7 days' - (i - 69000) * interval '40 seconds' end
  from generate_series(1, 220000) as i;

-- Tries 1 and 2 inside the last 7 days: 20 tried 3 hours ago (eligible), 20 tried 1 hour ago (not yet).
update public.articles a
   set image_backfill_attempts = 1 + (s.n % 2)::integer,
       image_backfill_attempted_at = case when s.n % 250 = 3 then now() - interval '3 hours' else now() - interval '1 hour' end
  from (select id, row_number() over (order by created_at desc) as n
          from public.articles
         where image_url is null and created_at > now() - interval '7 days') s
 where a.id = s.id and s.n % 250 in (3, 4);

-- The queue holds one eligible article (the loop must skip it) and one message without an article_id (the
-- NULL-safe NOT IN guard must not be poisoned by it).
insert into pgmq.q_image_backfill (message)
select jsonb_build_object('article_id', id)
  from public.articles
 where image_url is null and image_backfill_attempts between 1 and 2
   and image_backfill_attempted_at < now() - interval '2 hours'
   and created_at > now() - interval '7 days'
 order by created_at desc
 limit 1;
insert into pgmq.q_image_backfill (message) values ('{"other": 1}'::jsonb);

insert into supabase_migrations.schema_migrations (version, name) values ('154', '154_image_requeue_stagger');

set random_page_cost = 1.1;
analyze public.articles;

-- Prelude C: helpers. dry.ok raises; dry.loop_sql is the loop of public.image_backfill_requeue (154's select,
-- limit 40 instead of v_limit); dry.scan_of runs EXPLAIN (ANALYZE, BUFFERS, TIMING OFF) and returns the
-- articles scan node's facts; dry.loop_ids returns the ids the loop selects, in order. -----------
create schema dry;
create table dry.kv (k text primary key, v text);

create function dry.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'DRYRUN 201 FAILED: %', msg; end if;
end $$;

create function dry.loop_sql() returns text language sql as $f$
  select $q$
    select a.id
      from public.articles a
     where a.image_url is null
       and a.image_backfill_attempts between 1 and 2
       and a.image_backfill_attempted_at < pg_catalog.now() - interval '2 hours'
       and a.created_at > pg_catalog.now() - interval '7 days'
       and a.id::text not in (
             select q.message ->> 'article_id'
               from pgmq.q_image_backfill q
              where q.message ->> 'article_id' is not null
           )
     order by a.created_at desc
     limit 40
  $q$
$f$;

create function dry.scan_of(q text) returns jsonb language plpgsql as $$
declare j jsonb; n jsonb; top jsonb;
begin
  execute 'explain (analyze, buffers, timing off, format json) ' || q into j;
  top := j -> 0 -> 'Plan';
  n := jsonb_path_query_first(j, '$.**?(@."Relation Name" == "articles")');
  return jsonb_build_object(
    'node', n ->> 'Node Type',
    'index', n ->> 'Index Name',
    'removed', coalesce((n ->> 'Rows Removed by Filter')::bigint, 0),
    'rows', (n ->> 'Actual Rows')::bigint,
    'buffers', coalesce((top ->> 'Shared Hit Blocks')::bigint, 0) + coalesce((top ->> 'Shared Read Blocks')::bigint, 0));
end $$;

create function dry.loop_ids(q text default dry.loop_sql()) returns text language plpgsql as $$
declare d text;
begin
  execute 'select coalesce(string_agg(id::text, '','' order by rn), '''') from (select id, row_number() over () as rn from (' || q || ') s) t' into d;
  return d;
end $$;

create table dry.rels_before as
  select relname, relkind from pg_class where relnamespace = 'public'::regnamespace;
create table dry.articles_md5 as
  select md5(string_agg(a::text, '|' order by id)) as m from public.articles a;

-- 1. BEFORE (production's plan): the created_at index walks the whole 7-day range. ---------------
select 'BEFORE ' || dry.scan_of(dry.loop_sql())::text;
select dry.ok((dry.scan_of(dry.loop_sql()) ->> 'node') = 'Index Scan', 'BEFORE: the loop is an Index Scan');
select dry.ok((dry.scan_of(dry.loop_sql()) ->> 'index') = 'idx_articles_created_at', 'BEFORE: it walks idx_articles_created_at');
select dry.ok((dry.scan_of(dry.loop_sql()) ->> 'removed')::bigint > 10000, 'BEFORE: Rows Removed by Filter is in the tens of thousands');
select dry.ok((dry.scan_of(dry.loop_sql()) ->> 'rows')::bigint < 40, 'BEFORE: fewer candidates than LIMIT 40, so the scan has no early exit');
insert into dry.kv values ('before_ids', dry.loop_ids());
select dry.ok(length(v) > 0 and array_length(string_to_array(v, ','), 1) between 15 and 39, 'BEFORE: the loop selects a few dozen ids') from dry.kv where k = 'before_ids';
select 'candidates ' || array_length(string_to_array(v, ','), 1) from dry.kv where k = 'before_ids';

-- 2. ORCHESTRATOR PRE-BUILD (the statement from 201's header, run standalone, outside a transaction).
create index concurrently if not exists articles_image_requeue_idx on public.articles (created_at desc) where image_url is null and image_backfill_attempts between 1 and 2;
select dry.ok((select indisvalid and indisready from pg_index where indexrelid = 'public.articles_image_requeue_idx'::regclass), 'the pre-build index is valid and ready');
select dry.ok((select count(*) = 0 from supabase_migrations.schema_migrations where version = '201'), 'the pre-build writes no ledger row');

-- 3. Apply 201 (index already built: "already exists, skipping"; ledger INSERT 0 1). -------------
\ir ../../../supabase/migrations/201_image_requeue_partial_index.sql
select dry.ok((select count(*) = 1 from supabase_migrations.schema_migrations where version = '201' and name = '201_image_requeue_partial_index'), 'apply 1: one ledger row 201');

-- 4. Apply 201 again (INSERT 0 0). ----------------------------------------------------------------
\ir ../../../supabase/migrations/201_image_requeue_partial_index.sql
select dry.ok((select count(*) = 1 from supabase_migrations.schema_migrations where version = '201'), 'apply 2: still one ledger row 201');
select dry.ok((select count(*) = 1 from pg_class where relname = 'articles_image_requeue_idx'), 'apply 2: still one index');

-- 5. AFTER: the loop walks the new index, removes almost nothing, selects the same ids. --------
select 'AFTER ' || dry.scan_of(dry.loop_sql())::text;
select dry.ok((dry.scan_of(dry.loop_sql()) ->> 'node') = 'Index Scan', 'AFTER: the loop is an Index Scan');
select dry.ok((dry.scan_of(dry.loop_sql()) ->> 'index') = 'articles_image_requeue_idx', 'AFTER: Index Scan using articles_image_requeue_idx');
select dry.ok((dry.scan_of(dry.loop_sql()) ->> 'removed')::bigint < 100, 'AFTER: Rows Removed by Filter under 100');
select dry.ok((dry.scan_of(dry.loop_sql()) ->> 'buffers')::bigint < 500, 'AFTER: buffers (hit + read) under 500');
select dry.ok(dry.loop_ids() = (select v from dry.kv where k = 'before_ids'), 'AFTER: the loop selects the same ids in the same order as before');
select dry.ok(pg_relation_size('public.articles_image_requeue_idx') between 1 and 5 * 1024 * 1024, 'the index is under 5 MB');
select 'index bytes ' || pg_relation_size('public.articles_image_requeue_idx') || ', entries ' || (select reltuples::bigint from pg_class where oid = 'public.articles_image_requeue_idx'::regclass);
select dry.ok((select reltuples::bigint from pg_class where oid = 'public.articles_image_requeue_idx'::regclass)
                = (select count(*) from public.articles where image_url is null and image_backfill_attempts between 1 and 2),
              'the index holds exactly the rows of its predicate');
-- pg_get_indexdef nests the BETWEEN parentheses on PG15 and not on PG17, so compare it without parentheses.
select dry.ok((select regexp_replace(indexdef, '[()]', '', 'g') from pg_indexes where indexname = 'articles_image_requeue_idx')
                = 'CREATE INDEX articles_image_requeue_idx ON public.articles USING btree created_at DESC WHERE image_url IS NULL AND image_backfill_attempts >= 1 AND image_backfill_attempts <= 2',
              'the index definition is a btree on (created_at desc) with the requeue predicate');

-- 6. Predicate coupling: 142's filter (attempts between 1 and 4) is not implied by 201's predicate, so the
-- partial index must NOT serve it. A partial index only serves a query whose WHERE implies its predicate. ---
select dry.ok((dry.scan_of(replace(dry.loop_sql(), 'between 1 and 2', 'between 1 and 4')) ->> 'index') is distinct from 'articles_image_requeue_idx',
              'a query with 142''s wider filter does not use the partial index');
select dry.ok((dry.scan_of(replace(dry.loop_sql(), 'between 1 and 2', 'between 1 and 4')) ->> 'index') = 'idx_articles_created_at',
              'a query with 142''s wider filter still walks idx_articles_created_at');

-- 7. Nothing but the index was added, and no article row changed. ---------------------------------
select dry.ok((select array_agg(relname::text order by relname) from (select relname from pg_class where relnamespace = 'public'::regnamespace except select relname from dry.rels_before) x)
                = array['articles_image_requeue_idx'], 'the only object added to public is articles_image_requeue_idx');
select dry.ok((select count(*) = 0 from (select relname from dry.rels_before except select relname from pg_class where relnamespace = 'public'::regnamespace) y), 'nothing was dropped from public');
select dry.ok((select md5(string_agg(a::text, '|' order by id)) from public.articles a) = (select m from dry.articles_md5), 'md5 over public.articles is unchanged');

-- 8. Pre-build skipped on a small table: 201 builds the index inside its own transaction. ------------
-- (The size guard lets this through only while the stub is under 64 MB; step 8b proves it refuses above.)
drop index public.articles_image_requeue_idx;
delete from supabase_migrations.schema_migrations where version = '201';
select 'articles bytes (8) ' || pg_relation_size('public.articles') || ' = ' || (pg_relation_size('public.articles') / 1048576) || ' MB';
select dry.ok(pg_relation_size('public.articles') < 64 * 1024 * 1024, 'step 8: the 220,000-row stub is under 64 MB, so the size guard lets the in-transaction build through');
select dry.ok((dry.scan_of(dry.loop_sql()) ->> 'index') = 'idx_articles_created_at', 'without the index the loop is back on idx_articles_created_at');
\ir ../../../supabase/migrations/201_image_requeue_partial_index.sql
select dry.ok((select indisvalid and indisready from pg_index where indexrelid = 'public.articles_image_requeue_idx'::regclass), 'apply 3: the index built inside the transaction is valid');
select dry.ok((select count(*) = 1 from supabase_migrations.schema_migrations where version = '201'), 'apply 3: one ledger row 201');
select dry.ok((dry.scan_of(dry.loop_sql()) ->> 'index') = 'articles_image_requeue_idx', 'apply 3: the loop uses the index');
select dry.ok(dry.loop_ids() = (select v from dry.kv where k = 'before_ids'), 'apply 3: the same ids');

-- 8b. Size guard (SEC-2, the 113 precedent): public.articles over 64 MB and no index. Building it inside 201's
-- transaction would hold a SHARE lock that blocks every write to articles for the whole build, so 201 must stop in
-- step 0 ("201: public.articles is N MB and articles_image_requeue_idx does not exist yet ... Run the ORCHESTRATOR
-- PRE-BUILD first"): no index built, no ledger row. After the pre-build the same apply goes through. The padding
-- rows have an image and attempts 0, so they are outside the index predicate and every earlier check is unaffected.
insert into public.articles (title, description, image_url, image_backfill_attempts, created_at)
select 'pad ' || i, repeat('x', 1000), 'https://example.invalid/pad/' || i, 0, now() - interval '30 days' - i * interval '1 second'
  from generate_series(1, 60000) as i;
select 'articles bytes (8b) ' || pg_relation_size('public.articles') || ' = ' || (pg_relation_size('public.articles') / 1048576) || ' MB';
select dry.ok(pg_relation_size('public.articles') > 64 * 1024 * 1024, '8b: the padded articles table is over 64 MB');
-- Step 8 left the index it built in its transaction (and its ledger row): drop both, as if the pre-build was skipped.
drop index public.articles_image_requeue_idx;
delete from supabase_migrations.schema_migrations where version = '201';
select dry.ok(to_regclass('public.articles_image_requeue_idx') is null, '8b: the index does not exist before the apply');
select dry.ok((select count(*) = 0 from supabase_migrations.schema_migrations where version = '201'), '8b: no ledger row before the apply');
\set ON_ERROR_STOP off
\ir ../../../supabase/migrations/201_image_requeue_partial_index.sql
\set ON_ERROR_STOP on
select dry.ok(to_regclass('public.articles_image_requeue_idx') is null, 'size guard: the apply refused and built no index in its transaction');
select dry.ok((select count(*) = 0 from supabase_migrations.schema_migrations where version = '201'), 'size guard: the apply refused and wrote no ledger row');
-- The ORCHESTRATOR PRE-BUILD (standalone, outside a transaction), then the same apply goes through.
create index concurrently if not exists articles_image_requeue_idx on public.articles (created_at desc) where image_url is null and image_backfill_attempts between 1 and 2;
\ir ../../../supabase/migrations/201_image_requeue_partial_index.sql
select dry.ok((select indisvalid and indisready from pg_index where indexrelid = 'public.articles_image_requeue_idx'::regclass), 'size guard: after the pre-build the index is valid');
select dry.ok((select count(*) = 1 from supabase_migrations.schema_migrations where version = '201'), 'size guard: after the pre-build the apply goes through and records 201');

-- 9. An INVALID index (a cancelled CREATE INDEX CONCURRENTLY): 201 must stop in step 0 and write no ledger row.
delete from supabase_migrations.schema_migrations where version = '201';
update pg_index set indisvalid = false where indexrelid = 'public.articles_image_requeue_idx'::regclass;
select dry.ok((select not indisvalid from pg_index where indexrelid = 'public.articles_image_requeue_idx'::regclass), 'the index is forced invalid');
\set ON_ERROR_STOP off
\ir ../../../supabase/migrations/201_image_requeue_partial_index.sql
\set ON_ERROR_STOP on
select dry.ok((select count(*) = 0 from supabase_migrations.schema_migrations where version = '201'), 'invalid index: the apply aborted and wrote no ledger row');
select dry.ok((select not indisvalid from pg_index where indexrelid = 'public.articles_image_requeue_idx'::regclass), 'invalid index: the apply did not silently accept it');
update pg_index set indisvalid = true where indexrelid = 'public.articles_image_requeue_idx'::regclass;
\ir ../../../supabase/migrations/201_image_requeue_partial_index.sql
select dry.ok((select count(*) = 1 from supabase_migrations.schema_migrations where version = '201'), 'restored: the apply went through');

-- 10. Ledger: 154 and 201 once each. ----------------------------------------------------------------
select dry.ok((select count(*) = 2 from supabase_migrations.schema_migrations where version in ('154', '201')), 'ledger rows');

\echo DRYRUN 201 OK
