-- 124_saved_clusters_v2.sql
--
-- saved_clusters_v2(p_ids uuid[]): the /saved lookup of migration 116's
-- saved_clusters plus ONE more column, is_blindspot, so a saved story can show
-- the same "Kör nokta" pill and zone-spectrum bar the feed cards show.
--
-- Why a new function and not a changed one. saved_clusters (116) returns six
-- columns; PostgreSQL cannot add an OUT column to an existing function with
-- create or replace, and dropping it would break the deployed app between the
-- migration and the deploy. A second function is purely additive:
--
--   saved_clusters(p_ids uuid[])        UNCHANGED. Still the only caller:
--       src/components/bookmark/bookmark-snapshots.ts (one-id baseline when a
--       story is bookmarked). 124 never touches it.
--   saved_clusters_v2(p_ids uuid[])     NEW. Only caller:
--       src/components/bookmark/saved-list.tsx (/saved). Browser client,
--       POST /rest/v1/rpc/saved_clusters_v2.
--
-- Properties (identical to 116's saved_clusters, plus the extra column):
--   - language sql, STABLE, SECURITY DEFINER, set search_path = '' (every
--     relation is schema-qualified).
--   - revoke all ... from public, anon, authenticated, then grant execute to
--     anon and service_role. NOTHING is granted to authenticated (Tayf has no
--     user sessions). This exact grant shape is the one
--     tests/guards/anon-surface.test.ts allowlists; the anon surface grows by
--     exactly this one function.
--   - Hard caps, so a public key cannot page through the table: the input
--     array is TRUNCATED to its first 200 elements (p_ids[1:200]) and the
--     result is limited to 200 rows, newest update first. Over-cap input is
--     never an error because /saved must not hard-fail.
--   - No archived filter: /saved keeps showing a bookmarked story after it is
--     archived (same as v1).
--   - RETURNS TABLE types come from production information_schema
--     (2026-10-24): clusters.id uuid, title_tr text, title_tr_neutral text,
--     article_count int4, bias_distribution jsonb, updated_at timestamptz,
--     is_blindspot boolean.
--   - tests/migrations/124-saved-clusters-v2.test.ts parses this file and 116
--     and checks that the select list is v1's plus c.is_blindspot and that
--     the from/where/order/limit are identical.
--
-- Properties of the migration:
--   - Additive only: one create or replace function, one comment, one
--     revoke/grant on that function. No table is read, altered, granted or
--     dropped.
--   - Idempotent: create or replace + repeatable revoke/grant + ledger
--     "on conflict do nothing".
--   - Takes no table lock; lock_timeout 5s bounds the catalog locks.
--   - notify pgrst makes PostgREST rebuild its schema cache so the RPC is
--     routable immediately.
--
-- Rollout order (either order is safe):
--   - Apply 124 first, then deploy the app: /saved calls v2 from the start.
--   - Deploy the app first: until 124 is applied PostgREST answers the v2 call
--     with PGRST202 (function not in the schema cache). saved-list.tsx treats
--     exactly that code as "124 not applied yet" and retries once with
--     saved_clusters, so /saved still lists the bookmarks (without the pill
--     and bar). Every other error code keeps the 'Kaydedilenler yüklenemedi'
--     line.
--
-- Verification (read-only, expect one row then true/false and the column list):
--   select p.oid::regprocedure from pg_proc p
--    where p.pronamespace = 'public'::regnamespace
--      and p.proname = 'saved_clusters_v2';
--   select has_function_privilege('anon','public.saved_clusters_v2(uuid[])','execute'),
--          has_function_privilege('authenticated','public.saved_clusters_v2(uuid[])','execute');
--   select * from public.saved_clusters_v2(null) limit 1;  -- zero rows, no error
--
-- Rollback (the app falls back to v1 on PGRST202 once the cache reloads):
--   drop function public.saved_clusters_v2(uuid[]);
--   delete from supabase_migrations.schema_migrations where version = '124';

begin;

set local lock_timeout = '5s';

create or replace function public.saved_clusters_v2(p_ids uuid[])
returns table (
  id uuid,
  title_tr text,
  title_tr_neutral text,
  article_count integer,
  bias_distribution jsonb,
  updated_at timestamptz,
  is_blindspot boolean
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select c.id,
         c.title_tr,
         c.title_tr_neutral,
         c.article_count,
         c.bias_distribution,
         c.updated_at,
         c.is_blindspot
    from public.clusters c
   where c.id = any (coalesce(p_ids[1:200], '{}'::uuid[]))
   order by c.updated_at desc
   limit 200
$fn$;

comment on function public.saved_clusters_v2(uuid[]) is
  'Saved-story lookup for /saved: the same rows as saved_clusters (at most 200, input truncated to 200 ids) plus is_blindspot. v1 stays for bookmark-snapshots.ts.';

revoke all on function public.saved_clusters_v2(uuid[]) from public, anon, authenticated;
grant execute on function public.saved_clusters_v2(uuid[]) to anon, service_role;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('124', '124_saved_clusters_v2')
  on conflict do nothing;

commit;
