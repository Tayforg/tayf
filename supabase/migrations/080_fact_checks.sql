-- 080_fact_checks.sql
--
-- "Bu konuda doğrulama" -- links independent fact-check publisher articles
-- (Teyit, Doğruluk Payı, Malumatfuruş, AA Teyit Hattı) to Tayf clusters
-- whose keyword overlap suggests they cover the same claim or event.
--
-- COPYRIGHT: `fact_checks` stores the HEADLINE and LINK only, never the
-- fact-checker's description, verdict text or body copy. RSS <category>
-- terms are read by the cron for matching but are never written to this
-- table. A reader who wants the actual analysis clicks through to the
-- publisher's own site (fact-check-box.tsx renders link-out only).
--
-- NOT A `sources` ROW: fact-checkers never vote in bias/blindspot/counts
-- or the home feed. They have their own table pair so admitting a new
-- fact-check publisher can never silently perturb bias math, blindspot
-- detection, article_count, or any reader-facing count that reads
-- `sources`/`articles`. `cluster_fact_checks` is a pure link table.
--
-- RLS MODEL: both tables are readable by anon/authenticated ONLY for
-- `is_published = true` rows (and, on the link table, only when the
-- parent fact_check is also published) -- everything else (insert/update/
-- delete, and any unpublished row) is service_role-only. The cron writes
-- with the service_role key, which bypasses RLS entirely; the app loader
-- (cluster-fact-checks-query.ts) re-applies `is_published = true`
-- explicitly so a future service-role code path can never leak an
-- unpublished/shadow link by omission.
--
-- Additive only: two new tables, their indexes, RLS policies and grants.
-- No existing table, column, function or policy is touched. There are no
-- functions in this migration, so there is no SECURITY DEFINER surface.

begin;

create table if not exists public.fact_checks (
  id            uuid primary key default gen_random_uuid(),
  publisher     text not null check (publisher in ('teyit','dogrulukpayi','malumatfurus','aa-teyit')),
  url           text not null check (url ~ '^https://'),
  title         text not null check (char_length(title) between 1 and 300),
  published_at  timestamptz not null,
  is_published  boolean not null default true,
  fetched_at    timestamptz not null default now(),
  constraint fact_checks_url_key unique (url)
);
create index if not exists fact_checks_published_at_idx on public.fact_checks (published_at desc);

create table if not exists public.cluster_fact_checks (
  cluster_id     uuid not null references public.clusters(id) on delete cascade,
  fact_check_id  uuid not null references public.fact_checks(id) on delete cascade,
  score          numeric(4,3) not null check (score >= 0 and score <= 1),
  matched_terms  text[] not null default '{}',
  method         text not null default 'keyword-v1',
  is_published   boolean not null default false,
  decided_by     text not null default 'auto' check (decided_by in ('auto','admin')),
  created_at     timestamptz not null default now(),
  primary key (cluster_id, fact_check_id)
);
create index if not exists cluster_fact_checks_fact_check_idx on public.cluster_fact_checks (fact_check_id);

alter table public.fact_checks enable row level security;
alter table public.cluster_fact_checks enable row level security;

revoke all on public.fact_checks from anon, authenticated, public;
revoke all on public.cluster_fact_checks from anon, authenticated, public;
grant select on public.fact_checks to anon, authenticated;
grant select on public.cluster_fact_checks to anon, authenticated;
grant select, insert, update, delete on public.fact_checks to service_role;
grant select, insert, update, delete on public.cluster_fact_checks to service_role;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'fact_checks' and policyname = 'read published fact_checks') then
    create policy "read published fact_checks" on public.fact_checks
      for select to anon, authenticated using (is_published);
  end if;
  if not exists (select 1 from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'cluster_fact_checks' and policyname = 'read published cluster_fact_checks') then
    create policy "read published cluster_fact_checks" on public.cluster_fact_checks
      for select to anon, authenticated
      using (is_published and exists (select 1 from public.fact_checks f where f.id = fact_check_id and f.is_published));
  end if;
end $$;

comment on table public.fact_checks is 'Public fact-check articles (Teyit, Doğruluk Payı, Malumatfuruş, AA Teyit Hattı) ingested by /api/cron/fact-checks (migration 080). Headline + link ONLY -- never description/content (copyright). Not a sources row: fact-checkers never vote in bias/blindspot/counts.';
comment on table public.cluster_fact_checks is 'Keyword-overlap links fact_check -> cluster (method keyword-v1, migration 080). is_published=false = shadow candidate. decided_by=admin rows are never touched by the cron.';

insert into supabase_migrations.schema_migrations (version, name)
  values ('080', '080_fact_checks') on conflict do nothing;
commit;
