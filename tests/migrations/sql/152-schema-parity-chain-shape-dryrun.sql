-- 152 schema_parity, CHAIN SHAPE: local PG15 dry-run. Never touches production.
--
-- What a rebuild from 001-151 leaves: sources as 001 + 005 + 034 made it (the inline
-- bias check sources_bias_check with the ten keys, kind and sources_kind_check, no
-- tradition / source_type), articles with its four constraints PLUS 026's NOT VALID
-- articles_content_hash_length_chk (026 is in the ledger). 152 must add prod's objects
-- beside them and leave everything else alone.
--
-- Scenarios, in this order, on one database:
--   V  legacy-row variant: a 'nationalist' row exists. 152 adds the columns, their
--      CHECKs and indexes but SKIPS sources_alignment_check (a NOT VALID check still
--      fires on every UPDATE, so it would break the row's later writes); the UPDATE of
--      that row succeeds. Run twice. Then the documented ROLLBACK from the migration
--      header runs and the chain shape is restored exactly.
--   M  main: the sources table is empty. 152 adds sources_alignment_check NOT VALID;
--      state_media is refused, center accepted with the defaults. Run twice.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55153 -c listen_addresses=127.0.0.1 -c unix_socket_directories=" -l $D/log -w start
--   $PGBIN/psql -h 127.0.0.1 -p 55153 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/152-schema-parity-chain-shape-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql TAYF_SHAPE=chain PGHOST=127.0.0.1 PGPORT=55153 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/152-schema-parity)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh
--   (the NOTICE of the skipped alignment check is on stderr: add 2>&1 and grep "152:")
--
-- (\ir paths below are relative to this file.) Every check is a DO block or a pg_temp
-- function that raises on mismatch, so a clean run ending in "DRYRUN 152 chain-shape OK"
-- is the pass. Every scenario that writes sits inside begin ... rollback, except V's
-- own apply / rollback pair, which is the point of V.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Prelude A: the chain's tables, replacing the stub's minimal ones. ----------------------
drop table if exists public.articles cascade;
drop table if exists public.sources cascade;

-- 001 (inline bias check -> sources_bias_check, re-declared by 005 with the same ten keys).
create table public.sources (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  url text not null,
  rss_url text not null,
  bias text not null check (bias in (
    'pro_government', 'gov_leaning', 'state_media', 'center',
    'opposition_leaning', 'opposition', 'nationalist',
    'islamist_conservative', 'pro_kurdish', 'international'
  )),
  logo_url text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index idx_sources_bias on public.sources (bias);
create index idx_sources_active on public.sources (active);
-- 034
alter table public.sources add column kind text not null default 'outlet';
alter table public.sources add constraint sources_kind_check check (kind in ('outlet', 'aggregator', 'wire', 'niche'));

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
-- 026 as the chain applies it (NOT VALID, never validated) and its ledger row.
alter table public.articles
  add constraint articles_content_hash_length_chk
  check (content_hash is null or content_hash ~ '^[0-9a-f]{40}$' or content_hash ~ '^[0-9a-f]{64}$')
  not valid;
insert into supabase_migrations.schema_migrations (version, name)
values ('026', '026_unify_content_hash_v2') on conflict do nothing;

-- Prelude B: snapshot view, helpers, the chain snapshot. -------------------------------
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

-- Same, restricted to the articles table (152 must not touch it at all).
create temp view v_snap_articles as select * from v_snap where name like 'articles%' or name like 'public.articles%';

create temp table snap_chain as select * from v_snap;
create temp table snap_chain_articles as select * from v_snap_articles;

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

-- Raises unless the sources constraint names are exactly `expected` (comma separated).
create function pg_temp.assert_sources_constraints(expected text) returns void
language plpgsql as $$
declare
  v_got text;
begin
  select string_agg(conname, ',' order by conname) into v_got from pg_constraint where conrelid = 'public.sources'::regclass;
  if v_got is distinct from expected then
    raise exception 'sources constraints: expected %, got %', expected, v_got;
  end if;
end $$;

-- Sanity of the prelude: this IS the chain shape.
select pg_temp.assert_sources_constraints('sources_bias_check,sources_kind_check,sources_pkey,sources_slug_key');
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sources' and column_name in ('tradition', 'source_type')) then
    raise exception 'prelude: the chain shape must not have tradition / source_type';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '152') <> 0 then
    raise exception 'prelude: the ledger already has 152';
  end if;
end $$;

-- ===== Scenario V: a branch database that already holds a legacy-key row ===============
insert into public.sources (slug, name, url, rss_url, bias) values
  ('v-nat', 'V nationalist', 'https://v.example', 'https://v.example/rss', 'nationalist');

\ir ../../../supabase/migrations/152_schema_parity.sql

-- V1: the columns, their checks and the indexes arrived; the alignment check was SKIPPED.
do $$
begin
  if (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'sources' and column_name in ('tradition', 'source_type')) <> 2 then
    raise exception 'V1: tradition / source_type were not added';
  end if;
  perform pg_temp.assert_sources_constraints('sources_bias_check,sources_kind_check,sources_pkey,sources_slug_key,sources_source_type_check,sources_tradition_check');
  if (select count(*) from pg_indexes where schemaname = 'public' and indexname in ('idx_sources_tradition', 'idx_sources_source_type')) <> 2 then
    raise exception 'V1: the two indexes were not created';
  end if;
end $$;

-- V2: the legacy row stays writable (this is why the check is skipped), and the chain's
--     ten-key check still decides what is accepted.
begin;
do $$
declare
  v_n bigint;
begin
  update public.sources set active = false where slug = 'v-nat';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'V2: the legacy row was not updatable (% rows)', v_n; end if;
end $$;
insert into public.sources (slug, name, url, rss_url, bias) values ('v-state', 'V state', 'https://vs.example', 'https://vs.example/rss', 'state_media');
rollback;

-- V3: ledger row 152 once; 026 untouched; articles untouched.
do $$
begin
  if (select count(*) from supabase_migrations.schema_migrations where version = '152') <> 1 then raise exception 'V3: ledger 152'; end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '026') <> 1 then raise exception 'V3: ledger 026 changed'; end if;
  if exists (select * from snap_chain_articles except select * from v_snap_articles)
     or exists (select * from v_snap_articles except select * from snap_chain_articles) then
    raise exception 'V3: 152 touched articles';
  end if;
end $$;

-- Second run: a no-op (snapshot taken between the runs).
create temp table snap_v1 as select * from v_snap;
\ir ../../../supabase/migrations/152_schema_parity.sql
do $$
begin
  if exists (select * from snap_v1 except select * from v_snap) or exists (select * from v_snap except select * from snap_v1) then
    raise exception 'V4: the second run changed the shape';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '152') <> 1 then raise exception 'V4: ledger 152 duplicated'; end if;
end $$;

-- V5: the documented ROLLBACK (migration header, "a database where 152 added them").
alter table public.sources drop constraint if exists sources_alignment_check;
alter table public.sources drop constraint if exists sources_tradition_check;
alter table public.sources drop constraint if exists sources_source_type_check;
drop index if exists public.idx_sources_tradition;
drop index if exists public.idx_sources_source_type;
alter table public.sources drop column if exists tradition, drop column if exists source_type;
delete from supabase_migrations.schema_migrations where version = '152';
delete from public.sources where slug = 'v-nat';
do $$
begin
  if exists (select * from snap_chain except select * from v_snap) or exists (select * from v_snap except select * from snap_chain) then
    raise exception 'V5: the documented rollback did not restore the chain shape';
  end if;
end $$;

-- ===== Scenario M: the main path, an empty sources table ================================
do $$
begin
  if (select count(*) from public.sources) <> 0 then raise exception 'M0: sources is not empty'; end if;
end $$;

\ir ../../../supabase/migrations/152_schema_parity.sql

-- M1: the alignment check was added NOT VALID beside sources_bias_check (never dropped).
do $$
declare
  v_def text;
begin
  perform pg_temp.assert_sources_constraints('sources_alignment_check,sources_bias_check,sources_kind_check,sources_pkey,sources_slug_key,sources_source_type_check,sources_tradition_check');
  if (select convalidated from pg_constraint where conrelid = 'public.sources'::regclass and conname = 'sources_alignment_check') then
    raise exception 'M1: sources_alignment_check was added validated';
  end if;
  if not (select convalidated from pg_constraint where conrelid = 'public.sources'::regclass and conname = 'sources_tradition_check') then
    raise exception 'M1: sources_tradition_check is not validated';
  end if;
  select pg_get_constraintdef(oid) into v_def from pg_constraint where conrelid = 'public.sources'::regclass and conname = 'sources_bias_check';
  if v_def !~ 'state_media' or v_def !~ 'international' then raise exception 'M1: sources_bias_check lost its ten keys: %', v_def; end if;
  select pg_get_constraintdef(oid) into v_def from pg_constraint where conrelid = 'public.sources'::regclass and conname = 'sources_alignment_check';
  if v_def ~ 'state_media' or v_def !~ 'gov_leaning' then raise exception 'M1: the alignment check is not the five keys: %', v_def; end if;
  if (select string_agg(column_name || ':' || is_nullable || ':' || column_default, ',' order by column_name)
        from information_schema.columns where table_schema = 'public' and table_name = 'sources' and column_name in ('tradition', 'source_type'))
     is distinct from 'source_type:NO:''general''::text,tradition:NO:''mainstream''::text' then
    raise exception 'M1: the column definitions differ from production''s';
  end if;
end $$;

-- M2: behaviour (rolled back). Legacy keys are refused, writable keys accepted with the defaults.
begin;
select pg_temp.expect_check_violation(
  $q$insert into public.sources (slug, name, url, rss_url, bias) values ('m-x1', 'X', 'https://x.example', 'https://x.example/rss', 'state_media')$q$,
  'sources_alignment_check');
select pg_temp.expect_check_violation(
  $q$insert into public.sources (slug, name, url, rss_url, bias) values ('m-x2', 'X', 'https://x.example', 'https://x.example/rss', 'nationalist')$q$,
  'sources_alignment_check');
select pg_temp.expect_check_violation(
  $q$insert into public.sources (slug, name, url, rss_url, bias, tradition) values ('m-x3', 'X', 'https://x.example', 'https://x.example/rss', 'center', 'bogus')$q$,
  'sources_tradition_check');
select pg_temp.expect_check_violation(
  $q$insert into public.sources (slug, name, url, rss_url, bias, source_type) values ('m-x4', 'X', 'https://x.example', 'https://x.example/rss', 'center', 'bogus')$q$,
  'sources_source_type_check');
insert into public.sources (slug, name, url, rss_url, bias) values ('m-ok', 'OK', 'https://ok.example', 'https://ok.example/rss', 'center');
do $$
begin
  if (select tradition || '/' || source_type from public.sources where slug = 'm-ok') <> 'mainstream/general' then
    raise exception 'M2: the column defaults did not apply';
  end if;
end $$;
rollback;

-- M3: ledger, articles untouched (026's check still NOT VALID, same oid), indexes present.
do $$
begin
  if (select count(*) from supabase_migrations.schema_migrations where version = '152') <> 1 then raise exception 'M3: ledger 152'; end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '026') <> 1 then raise exception 'M3: ledger 026 changed'; end if;
  if exists (select * from snap_chain_articles except select * from v_snap_articles)
     or exists (select * from v_snap_articles except select * from snap_chain_articles) then
    raise exception 'M3: 152 touched articles';
  end if;
  if (select count(*) from pg_indexes where schemaname = 'public' and tablename = 'sources'
        and indexname in ('idx_sources_tradition', 'idx_sources_source_type', 'idx_sources_bias', 'idx_sources_active')) <> 4 then
    raise exception 'M3: sources indexes';
  end if;
end $$;

-- Second run: a no-op.
create temp table snap_m1 as select * from v_snap;
\ir ../../../supabase/migrations/152_schema_parity.sql
do $$
begin
  if exists (select * from snap_m1 except select * from v_snap) or exists (select * from v_snap except select * from snap_m1) then
    raise exception 'M4: the second run changed the shape';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '152') <> 1 then raise exception 'M4: ledger 152 duplicated'; end if;
end $$;

-- Nothing the scenarios did is left behind.
do $$
begin
  if (select count(*) from public.sources) <> 0 then raise exception 'residue: sources'; end if;
end $$;

\echo DRYRUN 152 chain-shape OK
