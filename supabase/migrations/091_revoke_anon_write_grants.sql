-- 091_revoke_anon_write_grants.sql
--
-- Revoke Supabase's default anon/authenticated write grants where no RLS
-- policy would ever authorize the write.
--
-- Measured against production (read-only, 2026-09-28): 18 objects in
-- schema public grant anon (and authenticated) INSERT/UPDATE/DELETE/
-- TRUNCATE (plus REFERENCES/TRIGGER). These are Supabase's default grants
-- on every new table/view, not anything Tayf intentionally set up:
--   - 13 RLS-enabled tables: articles, article_tickers, bist_aliases,
--     bist_bars_5m, bist_bars_daily, bist_companies, cluster_articles,
--     clusters, kap_disclosures, sources, stories, story_stances (full
--     grant set), and source_zone_history (TRUNCATE only)
--   - 5 non-updatable views: bist_quote_stats, disclosure_coverage,
--     ticker_attention_daily, trends_daily_bias_counts,
--     trends_daily_zone_counts_ist
--
-- pg_policies has ZERO non-SELECT policies in schema public today, so none
-- of these grants currently let anon/authenticated write anything -- RLS
-- blocks every row on the tables, and the views aren't updatable. The
-- grants are pure unused attack surface: a bug that flips
-- `alter table ... force row level security` off, a service using the
-- anon key against the wrong table, or a future PostgREST admin API
-- misconfiguration would otherwise have a live INSERT/UPDATE/DELETE path
-- for free. TRUNCATE is a special case: it is not governed by RLS at all
-- (Postgres checks table-level TRUNCATE privilege only) and is not
-- reachable through PostgREST, but leaving it granted is a needless
-- privilege with no corresponding policy layer that could ever gate it --
-- so it, TRIGGER, and REFERENCES are always revoked, unconditionally.
--
-- This migration is behaviour-preserving by construction: for each
-- table/view/materialized view in schema public and each role in
-- (anon, authenticated), it revokes INSERT/UPDATE/DELETE only when
-- pg_policies has no row for that relation whose cmd matches the command
-- (or is ALL) and whose roles include that role (or PUBLIC). If a future
-- migration adds a write policy for anon/authenticated, this migration
-- (re-run or re-applied fresh) will leave the matching privilege alone.
-- SELECT is never touched, and service_role/postgres are never referenced
-- -- ingestion and Edge Functions (which use the service_role key) are
-- unaffected.
--
-- Default privileges (`alter default privileges ... grant ... on tables
-- to anon/authenticated`) are intentionally NOT touched here: those are
-- Supabase platform defaults applied outside our migration history (by
-- the platform, on project creation and via the dashboard's "expose
-- schema" flow), and altering them risks fighting the platform on every
-- future `create table` instead of this table's grants. Follow-up: track
-- whether Supabase exposes a supported way to change the *default* for
-- newly created tables; until then, new tables must get this same
-- REVOKE treatment explicitly in the migration that creates them.
--
-- Idempotent: revoking a privilege that is already revoked is a no-op in
-- Postgres, so this migration is safe to re-run and safe to re-apply after
-- a future migration adds new tables (it will just find fewer/no grants
-- to remove on the already-hardened ones).
--
-- Verification query (read-only), expect zero rows after this migration:
--   select grantee, table_name, privilege_type
--     from information_schema.role_table_grants
--    where table_schema = 'public'
--      and grantee in ('anon', 'authenticated')
--      and privilege_type not in ('SELECT')
--      and not exists (
--        select 1 from pg_policies p
--         where p.schemaname = 'public'
--           and p.tablename = table_name
--           and (p.cmd = privilege_type or p.cmd = 'ALL')
--           and (p.roles @> array[grantee]::name[] or p.roles @> array['public']::name[])
--      );

begin;

do $$
declare
  rel record;
  role_name text;
  has_policy boolean;
  revoked text[];
  qualified_name text;
begin
  for rel in
    select c.relname as relname, c.relkind as relkind
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind in ('r', 'p', 'v', 'm') -- ordinary/partitioned tables, views, matviews
  loop
    qualified_name := format('%I.%I', 'public', rel.relname);

    foreach role_name in array array['anon', 'authenticated']
    loop
      revoked := array[]::text[];

      -- Always revoke: never governed by RLS policies, never needed by
      -- anon/authenticated in this project.
      execute format('revoke truncate, trigger, references on %s from %I', qualified_name, role_name);
      revoked := revoked || array['TRUNCATE', 'TRIGGER', 'REFERENCES'];

      -- INSERT/UPDATE/DELETE: revoke only when no policy in pg_policies
      -- would authorize this role for this command (or ALL) on this
      -- relation. This keeps the migration behaviour-preserving and
      -- forward-compatible with any future write policy.
      has_policy := exists (
        select 1
          from pg_catalog.pg_policies p
         where p.schemaname = 'public'
           and p.tablename = rel.relname
           and (p.cmd = 'INSERT' or p.cmd = 'ALL')
           and (p.roles @> array[role_name]::name[] or p.roles @> array['public']::name[])
      );
      if not has_policy then
        execute format('revoke insert on %s from %I', qualified_name, role_name);
        revoked := revoked || array['INSERT'];
      end if;

      has_policy := exists (
        select 1
          from pg_catalog.pg_policies p
         where p.schemaname = 'public'
           and p.tablename = rel.relname
           and (p.cmd = 'UPDATE' or p.cmd = 'ALL')
           and (p.roles @> array[role_name]::name[] or p.roles @> array['public']::name[])
      );
      if not has_policy then
        execute format('revoke update on %s from %I', qualified_name, role_name);
        revoked := revoked || array['UPDATE'];
      end if;

      has_policy := exists (
        select 1
          from pg_catalog.pg_policies p
         where p.schemaname = 'public'
           and p.tablename = rel.relname
           and (p.cmd = 'DELETE' or p.cmd = 'ALL')
           and (p.roles @> array[role_name]::name[] or p.roles @> array['public']::name[])
      );
      if not has_policy then
        execute format('revoke delete on %s from %I', qualified_name, role_name);
        revoked := revoked || array['DELETE'];
      end if;

      raise notice 'public.% : revoked % from %', rel.relname, array_to_string(revoked, ', '), role_name;
    end loop;
  end loop;
end $$;

insert into supabase_migrations.schema_migrations (version, name)
  values ('091', '091_revoke_anon_write_grants')
  on conflict do nothing;

commit;
