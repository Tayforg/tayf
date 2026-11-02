-- 152 schema_parity, PROD SHAPE: local PG15 dry-run. Never touches production.
--
-- Production's public.sources (alignment check, tradition / source_type with their
-- CHECKs and indexes) and public.articles (the four constraints, NO content_hash
-- check) as read on 2026-11-02 (Step 0 (a)-(c) in the migration header). On this
-- shape 152 must change NOTHING but the ledger.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=/private/tmp/claude-501/-Users-fatihhekimoglu/1acb1ff4-979e-4aaa-8131-2db2e1d46641/scratchpad/pg-w1-prod   # remove and re-initdb for the second run
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55152 -c listen_addresses=127.0.0.1 -c unix_socket_directories=" -l $D/log -w start
--   $PGBIN/psql -h 127.0.0.1 -p 55152 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f /Users/fatihhekimoglu/.claude/jobs/c644d1b7/tmp/jevtest/qa/stub.sql -f tests/migrations/sql/152-schema-parity-prod-shape-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql TAYF_SHAPE=prod PGHOST=127.0.0.1 PGPORT=55152 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/152-schema-parity)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
--
-- (\ir paths below are relative to this file.) Every check is a DO block or a pg_temp
-- function that raises on mismatch, so a clean run ending in "DRYRUN 152 prod-shape OK"
-- is the pass. Every scenario that writes sits inside begin ... rollback.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Prelude A: production's tables, replacing the stub's minimal ones. -------------------
drop table if exists public.articles cascade;
drop table if exists public.sources cascade;

create table public.sources (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null,
  url text not null,
  rss_url text not null,
  bias text not null,
  logo_url text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  kind text not null default 'outlet',
  tradition text not null default 'mainstream',
  source_type text not null default 'general',
  constraint sources_slug_key unique (slug),
  constraint sources_alignment_check check (bias = any (array['pro_government'::text, 'gov_leaning'::text, 'center'::text, 'opposition_leaning'::text, 'opposition'::text])),
  constraint sources_kind_check check (kind = any (array['outlet'::text, 'aggregator'::text, 'wire'::text, 'niche'::text])),
  constraint sources_source_type_check check (source_type = any (array['general'::text, 'sports'::text, 'finance'::text, 'niche'::text])),
  constraint sources_tradition_check check (tradition = any (array['mainstream'::text, 'islamist'::text, 'nationalist'::text, 'secular'::text, 'left'::text, 'kurdish'::text, 'state'::text, 'international'::text]))
);
create index idx_sources_alignment on public.sources using btree (bias);
create index idx_sources_source_type on public.sources using btree (source_type);
create index idx_sources_tradition on public.sources using btree (tradition);

create table public.articles (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null,
  title text,
  description text,
  url text not null,
  image_url text,
  published_at timestamptz,
  content_hash text not null,
  category text,
  created_at timestamptz not null default now(),
  constraint articles_source_id_fkey foreign key (source_id) references public.sources(id) on delete cascade,
  constraint articles_source_content_hash_key unique (source_id, content_hash),
  constraint articles_url_key unique (url)
);

-- A few rows, including production's one non-hex content_hash (Step 0 (g)): 152 must
-- tolerate it and must leave it writable (it adds no articles constraint).
insert into public.sources (id, slug, name, url, rss_url, bias, tradition, source_type) values
  ('15200000-0000-0000-0000-000000000001', 'p-gov', 'P gov', 'https://p1.example', 'https://p1.example/rss', 'pro_government', 'state', 'general'),
  ('15200000-0000-0000-0000-000000000002', 'p-mid', 'P mid', 'https://p2.example', 'https://p2.example/rss', 'center', 'mainstream', 'general'),
  ('15200000-0000-0000-0000-000000000003', 'p-opp', 'P opp', 'https://p3.example', 'https://p3.example/rss', 'opposition', 'left', 'niche');
insert into public.articles (source_id, title, url, content_hash) values
  ('15200000-0000-0000-0000-000000000001', 'sha1 row', 'https://p1.example/a', '0123456789abcdef0123456789abcdef01234567'),
  ('15200000-0000-0000-0000-000000000002', 'sha256 row', 'https://p2.example/a', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),
  ('15200000-0000-0000-0000-000000000003', 'legacy url-hash row', 'https://p3.example/a', 'https://p3.example/a');

-- Prelude B: the snapshot view (constraints, indexes, columns, relfilenodes) and helpers.
create temp view v_snap as
  select 'con'::text as k, c.oid::text as id, c.conrelid::regclass::text || '.' || c.conname as name,
         c.convalidated::text || ' ' || pg_get_constraintdef(c.oid) as def
    from pg_constraint c
   where c.conrelid in ('public.sources'::regclass, 'public.articles'::regclass)
  union all
  select 'idx', i.indexrelid::text, i.indexrelid::regclass::text, pg_get_indexdef(i.indexrelid)
    from pg_index i
   where i.indrelid in ('public.sources'::regclass, 'public.articles'::regclass)
  union all
  select 'col', a.attrelid::text || '.' || a.attnum::text, a.attrelid::regclass::text || '.' || a.attname,
         format_type(a.atttypid, a.atttypmod) || ' notnull=' || a.attnotnull::text || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '')
    from pg_attribute a
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid in ('public.sources'::regclass, 'public.articles'::regclass)
     and a.attnum > 0 and not a.attisdropped
  union all
  select 'rel', c.oid::text, c.relname::text, c.relfilenode::text
    from pg_class c
   where c.oid in ('public.sources'::regclass, 'public.articles'::regclass);

create temp table snap_prod as select * from v_snap;

-- Raises unless `stmt` fails with a check violation on the constraint `expected`.
create function pg_temp.expect_check_violation(stmt text, expected text) returns void
language plpgsql as $$
declare
  v_con text;
begin
  begin
    execute stmt;
  exception when check_violation then
    get stacked diagnostics v_con = constraint_name;
    if v_con is distinct from expected then
      raise exception 'expected a violation of %, got %', expected, v_con;
    end if;
    return;
  end;
  raise exception 'statement was accepted: %', stmt;
end $$;

-- Sanity of the prelude: the six sources and four articles constraints of Step 0 (a).
do $$
begin
  if (select string_agg(conname, ',' order by conname) from pg_constraint where conrelid = 'public.sources'::regclass)
     is distinct from 'sources_alignment_check,sources_kind_check,sources_pkey,sources_slug_key,sources_source_type_check,sources_tradition_check' then
    raise exception 'prelude: sources constraints are not production''s';
  end if;
  if (select string_agg(conname, ',' order by conname) from pg_constraint where conrelid = 'public.articles'::regclass)
     is distinct from 'articles_pkey,articles_source_content_hash_key,articles_source_id_fkey,articles_url_key' then
    raise exception 'prelude: articles constraints are not production''s';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version in ('026', '152')) <> 0 then
    raise exception 'prelude: the ledger already has 026 or 152';
  end if;
end $$;

-- Run 1 ---------------------------------------------------------------------------
\ir ../../../supabase/migrations/152_schema_parity.sql

-- P1: nothing but the ledger changed (same oids, definitions, validity, relfilenodes).
do $$
begin
  if exists (select * from snap_prod except select * from v_snap) or exists (select * from v_snap except select * from snap_prod) then
    raise exception 'P1: 152 changed production''s shape';
  end if;
end $$;

-- P2: the ledger has 152 exactly once, and no 026 row (the content_hash check is deferred).
do $$
begin
  if (select count(*) from supabase_migrations.schema_migrations where version = '152' and name = '152_schema_parity') <> 1 then
    raise exception 'P2: ledger row 152 missing or duplicated';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '026') <> 0 then
    raise exception 'P2: 152 recorded 026';
  end if;
end $$;

-- Run 2 (a no-op) -----------------------------------------------------------------
\ir ../../../supabase/migrations/152_schema_parity.sql

-- P3: still identical, ledger still once.
do $$
begin
  if exists (select * from snap_prod except select * from v_snap) or exists (select * from v_snap except select * from snap_prod) then
    raise exception 'P3: the second run changed the shape';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '152') <> 1 then
    raise exception 'P3: ledger row 152 duplicated by the second run';
  end if;
end $$;

-- P4: the content_hash CHECK is deferred: articles has exactly its four constraints.
do $$
begin
  if exists (select 1 from pg_constraint where conrelid = 'public.articles'::regclass and conname = 'articles_content_hash_length_chk') then
    raise exception 'P4: articles_content_hash_length_chk exists (it is deferred)';
  end if;
  if (select count(*) from pg_constraint where conrelid = 'public.articles'::regclass) <> 4 then
    raise exception 'P4: articles does not have exactly four constraints';
  end if;
end $$;

-- P5: every sources constraint is still validated, as in production.
do $$
begin
  if exists (select 1 from pg_constraint where conrelid = 'public.sources'::regclass and not convalidated) then
    raise exception 'P5: a sources constraint is not validated';
  end if;
end $$;

-- P6: behaviour (writes rolled back). Production's five keys pass, the legacy keys fail.
begin;
select pg_temp.expect_check_violation(
  $q$insert into public.sources (slug, name, url, rss_url, bias) values ('p-x1', 'X', 'https://x.example', 'https://x.example/rss', 'state_media')$q$,
  'sources_alignment_check');
select pg_temp.expect_check_violation(
  $q$insert into public.sources (slug, name, url, rss_url, bias) values ('p-x2', 'X', 'https://x.example', 'https://x.example/rss', 'nationalist')$q$,
  'sources_alignment_check');
select pg_temp.expect_check_violation(
  $q$insert into public.sources (slug, name, url, rss_url, bias, tradition) values ('p-x3', 'X', 'https://x.example', 'https://x.example/rss', 'center', 'bogus')$q$,
  'sources_tradition_check');
select pg_temp.expect_check_violation(
  $q$insert into public.sources (slug, name, url, rss_url, bias, source_type) values ('p-x4', 'X', 'https://x.example', 'https://x.example/rss', 'center', 'bogus')$q$,
  'sources_source_type_check');
insert into public.sources (slug, name, url, rss_url, bias) values ('p-ok', 'OK', 'https://ok.example', 'https://ok.example/rss', 'gov_leaning');
do $$
begin
  if (select tradition || '/' || source_type from public.sources where slug = 'p-ok') <> 'mainstream/general' then
    raise exception 'P6: the column defaults did not apply';
  end if;
end $$;
rollback;

-- P7: the legacy url-hash row of production is still selectable and writable.
begin;
do $$
declare
  v_n bigint;
begin
  update public.articles set title = 'touched' where content_hash like 'https://%';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'P7: expected to update the one legacy row, updated %', v_n; end if;
end $$;
rollback;

-- Nothing the scenarios did is left behind.
do $$
begin
  if (select count(*) from public.sources) <> 3 then raise exception 'residue: sources'; end if;
  if (select count(*) from public.articles) <> 3 then raise exception 'residue: articles'; end if;
  if (select count(*) from public.articles where title = 'touched') <> 0 then raise exception 'residue: touched'; end if;
end $$;

\echo DRYRUN 152 prod-shape OK
