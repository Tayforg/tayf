\set ON_ERROR_STOP on
-- Throwaway schema stub for LOCAL or CI Postgres only.
-- It is never applied to production and it holds no secrets (vault.decrypted_secrets
-- is an empty table). It is loaded by tests/migrations/sql/run-live.sh into a fresh
-- database before each live migration test file (see live-manifest.txt); the dry-run
-- scripts in this directory start from it too.
--
-- NEVER give this file a remote connection string. It ends by granting anon,
-- authenticated and service_role full rights on every future table, sequence and
-- function, which on a Supabase project would undo migration 117's default revoke, and
-- its statements are not safe to repeat on a real database. So the first thing it does
-- (line 1 makes psql stop at the first error, whatever the caller passed) is a guard
-- that refuses, before anything is created or altered, a database that
--   * already has public.sources (the stub loads only into a fresh, empty database), or
--   * has a schema only a Supabase project has (auth, storage, supabase_functions, cron), or
--   * is served from an address that is neither a unix socket, loopback nor a private
--     network (a CI service container is reached on its own private address). The same list
--     is LOCAL_NETWORKS in tests/_helpers/live-db.ts, which vets the target again at the
--     start of every live test block.
-- The schema checks are what identify a Supabase project; the address check is a second line.
--
do $guard$
declare
  addr inet := inet_server_addr();
  supa text;
begin
  if to_regclass('public.sources') is not null then
    raise exception 'stub.sql refuses to load: public.sources already exists. The stub only loads into a fresh, empty throwaway database.';
  end if;
  select string_agg(nspname, ', ' order by nspname) into supa
    from pg_namespace
   where nspname in ('auth', 'storage', 'supabase_functions', 'cron');
  if supa is not null then
    raise exception 'stub.sql refuses to load: schema(s) % exist, so this looks like a Supabase project, not a throwaway database.', supa;
  end if;
  if addr is not null and not (addr <<= any (array['127.0.0.0/8', '::1/128', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7']::inet[])) then
    raise exception 'stub.sql refuses to load: the server address % is not a unix socket, loopback or private-network address.', addr;
  end if;
end
$guard$;
--
-- The tables are the minimal shape the migrations read; production columns they lack
-- are added by the migration or dry-run script that needs them. The marked prelude at
-- the end of the file makes roles and default privileges look like a Supabase project,
-- deliberately pessimistic so every migration's revokes are really exercised.
--
create extension if not exists pgcrypto;
create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations(version text primary key, name text);
create schema if not exists vault; create table if not exists vault.decrypted_secrets(name text, decrypted_secret text);
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $$;
create table public.sources(id uuid primary key default gen_random_uuid(), slug text, name text, bias text, active boolean default true, kind text default 'outlet', url text, rss_url text);
create table public.articles(id uuid primary key default gen_random_uuid(), source_id uuid references public.sources(id), title text, description text, category text, published_at timestamptz default now(), url text);
create table public.clusters(id uuid primary key default gen_random_uuid(), title_tr text, title_tr_neutral text, title_neutral_model text, article_count int default 0, updated_at timestamptz default now(), is_archived boolean default false);
create table public.cluster_articles(cluster_id uuid references public.clusters(id), article_id uuid references public.articles(id), primary key(cluster_id, article_id));
-- pack A+ additions: columns the cluster-consumer RPCs and later migrations reference
alter table public.clusters add column if not exists bias_distribution jsonb not null default '{}'::jsonb;
alter table public.clusters add column if not exists is_blindspot boolean not null default false;
alter table public.clusters add column if not exists blindspot_side text;
alter table public.clusters add column if not exists first_published timestamptz;
alter table public.clusters add column if not exists created_at timestamptz not null default now();
alter table public.clusters add column if not exists title_en text;
alter table public.articles add column if not exists entities jsonb;
alter table public.articles add column if not exists minhash_sig bigint[];
create table if not exists public.article_tickers(article_id uuid references public.articles(id), ticker text, matched_on text, created_at timestamptz default now(), published_at timestamptz, source_id uuid, primary key(article_id, ticker));
create table if not exists public.kap_disclosures(disclosure_index bigint primary key, published_at timestamptz, kap_title text, stock_codes text[], related_stocks text[], disclosure_class text, disclosure_type text, disclosure_category text, subject text, summary text, is_late boolean, year int, period text, rule_type text, attachment_count int, modify_status text, raw jsonb, created_at timestamptz default now());
create table if not exists public.article_title_versions(id bigserial primary key, article_id uuid, source_id uuid, old_title text, new_title text, new_title_hash text, seen_at timestamptz default now());
create table if not exists public.bist_companies(kap_member_oid text, mkk_member_oid text, tickers text[] not null, title text, city text, kap_state text, member_type text, shares_traded boolean, updated_at timestamptz);

-- Supabase-like prelude ------------------------------------------------------------
-- Deliberately pessimistic: a Supabase project hands anon / authenticated / service_role
-- every new table, sequence and function by default, and a migration that forgets a
-- revoke would pass on a bare Postgres. These run AFTER the stub's own tables above, so
-- those keep plain owner-only privileges; every object a migration creates later gets
-- the permissive defaults and must revoke what it should not leave behind.
alter role service_role bypassrls;
alter table public.articles add column if not exists created_at timestamptz not null default now();
alter default privileges for role current_user in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role current_user in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role current_user in schema public grant execute on functions to anon, authenticated, service_role;
