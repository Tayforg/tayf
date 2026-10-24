-- 116_anon_public_rpcs.sql
--
-- Four bounded, read-only SECURITY DEFINER RPCs: the ONLY way the public anon
-- key reaches data once migration 117 has run.
--
-- Why. The anon key ships to every browser (NEXT_PUBLIC_SUPABASE_ANON_KEY) and
-- the edge middleware. Today it can SELECT 23 public relations through
-- PostgREST (RLS policy 017 "using (true)" plus Supabase's default table
-- grants): articles, clusters, sources, kap_disclosures, story threads, ...
-- Row-level SELECT on whole tables is a scraping surface far wider than the
-- three things the app really does with the anon key. 117 revokes it. 116
-- gives those three things a narrow door first.
--
-- The four functions and their ONLY callers (verified by
-- tests/guards/anon-surface.test.ts):
--
--   saved_clusters(p_ids uuid[])
--       src/components/bookmark/saved-list.tsx (/saved: resolves localStorage
--       bookmark ids to titles/counts/bias_distribution) and
--       src/components/bookmark/bookmark-snapshots.ts (one-id baseline when a
--       story is bookmarked). Browser client, POST /rest/v1/rpc/saved_clusters.
--   merged_cluster_map()
--       src/lib/seo/merged-cluster-gate.ts (edge middleware, /cluster/<id>
--       308 for merged clusters, migration 099). GET.
--   source_slugs()
--   source_slug_exists(p_slug text)
--       src/lib/seo/source-slug-gate.ts (edge middleware, /source/<slug>
--       not-found gate). GET.
--
-- Properties, identical for all four:
--   - language sql, STABLE, SECURITY DEFINER, set search_path = '' (every
--     relation is schema-qualified, no operator or function is resolved from
--     a caller-controlled path).
--   - revoke all ... from public, anon, authenticated, then grant execute to
--     anon and service_role. NOTHING is ever granted to authenticated (Tayf
--     has no user sessions).
--   - Hard output caps, so a public key cannot page through a table:
--       saved_clusters      <= 200 rows. The input array is TRUNCATED to its
--                           first 200 elements (p_ids[1:200]); over-cap input
--                           is never an error because /saved must not
--                           hard-fail. The browser sends the newest 200
--                           bookmarks (Set insertion order), so users with
--                           more than 200 saves see their newest 200.
--       merged_cluster_map  <= 1000 rows, newest merges first (the same
--                           bound the PostgREST max-rows setting gave the
--                           query this replaces; older merges rely on the
--                           page's own permanentRedirect()). Served from the
--                           partial index clusters_merged_into_idx.
--       source_slugs        <= 2000 rows (144 sources today).
--       source_slug_exists  one boolean; the argument must match
--                           ^[a-z0-9][a-z0-9-]{0,63}$ (SOURCE_SLUG_RE in
--                           src/lib/seo/source-slug-gate.ts, which mirrors
--                           isValidSourceSlug), otherwise false with no table
--                           read.
--   - No archived filter: the queries they replace had none, and /saved must
--     keep showing a bookmarked story even after it is archived.
--   - RETURNS TABLE types are copied from production information_schema
--     (2026-10-24): clusters.id uuid, title_tr text, title_tr_neutral text,
--     article_count int4, bias_distribution jsonb, updated_at timestamptz,
--     merged_into uuid; sources.slug text.
--
-- Fail-open behaviour, timeouts and caches in the app are unchanged: every
-- gate failure still resolves to "unknown"/no redirect, and /saved still shows
-- 'Kaydedilenler yüklenemedi. Lütfen sayfayı yenileyin.' on an RPC error.
--
-- Properties of the migration:
--   - Additive only: create or replace function, revoke/grant on those four
--     functions. No table is read, altered, granted or dropped.
--   - Idempotent: create or replace + repeatable revoke/grant + ledger
--     "on conflict do nothing".
--   - Takes no table lock; lock_timeout 5s bounds the catalog locks.
--   - notify pgrst makes PostgREST rebuild its schema cache so the RPCs are
--     routable immediately.
--
-- Rollout order (docs/migration-guide.md, "Anon yüzeyi (116/117) devreye alma"):
--   1. Apply 116 (this file). Nothing calls the functions yet; harmless.
--   2. Deploy the app that calls them (saved-list, bookmark-snapshots, the two
--      edge gates).
--   3. Verify /saved lists bookmarks, a merged /cluster/<id> answers 308 and
--      /source/<junk> reaches the not-found sink.
--   4. Apply 117 (revokes the anon table/sequence grants).
--   Applying 117 before step 2 only degrades softly (gates fail open, /saved
--   shows its error line) but is still the wrong order.
--
-- Verification (read-only, expect the four rows then true/false/true):
--   select p.oid::regprocedure from pg_proc p
--    where p.pronamespace = 'public'::regnamespace
--      and p.proname in ('saved_clusters','merged_cluster_map','source_slugs','source_slug_exists');
--   select has_function_privilege('anon','public.saved_clusters(uuid[])','execute'),
--          has_function_privilege('authenticated','public.saved_clusters(uuid[])','execute'),
--          has_function_privilege('anon','public.source_slug_exists(text)','execute');
--
-- Rollback (nothing depends on them until the app deploy):
--   drop function public.saved_clusters(uuid[]);
--   drop function public.merged_cluster_map();
--   drop function public.source_slugs();
--   drop function public.source_slug_exists(text);

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- saved_clusters: /saved and the bookmark baseline.
-- ---------------------------------------------------------------------------
create or replace function public.saved_clusters(p_ids uuid[])
returns table (
  id uuid,
  title_tr text,
  title_tr_neutral text,
  article_count integer,
  bias_distribution jsonb,
  updated_at timestamptz
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
         c.updated_at
    from public.clusters c
   where c.id = any (coalesce(p_ids[1:200], '{}'::uuid[]))
   order by c.updated_at desc
   limit 200
$fn$;

revoke all on function public.saved_clusters(uuid[]) from public, anon, authenticated;
grant execute on function public.saved_clusters(uuid[]) to anon, service_role;

-- ---------------------------------------------------------------------------
-- merged_cluster_map: edge middleware, /cluster/<id> 308 for merged clusters.
-- ---------------------------------------------------------------------------
create or replace function public.merged_cluster_map()
returns table (
  id uuid,
  merged_into uuid
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select c.id,
         c.merged_into
    from public.clusters c
   where c.merged_into is not null
   order by c.updated_at desc
   limit 1000
$fn$;

revoke all on function public.merged_cluster_map() from public, anon, authenticated;
grant execute on function public.merged_cluster_map() to anon, service_role;

-- ---------------------------------------------------------------------------
-- source_slugs: edge middleware, the full known-slug set for /source/<slug>.
-- ---------------------------------------------------------------------------
create or replace function public.source_slugs()
returns table (
  slug text
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select s.slug
    from public.sources s
   where s.slug is not null
   order by s.slug
   limit 2000
$fn$;

revoke all on function public.source_slugs() from public, anon, authenticated;
grant execute on function public.source_slugs() to anon, service_role;

-- ---------------------------------------------------------------------------
-- source_slug_exists: edge middleware, targeted probe once the set is stale.
-- The regex is SOURCE_SLUG_RE.source, byte for byte.
-- ---------------------------------------------------------------------------
create or replace function public.source_slug_exists(p_slug text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select case
           when p_slug is not null and p_slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'
           then exists (select 1 from public.sources s where s.slug = p_slug)
           else false
         end
$fn$;

revoke all on function public.source_slug_exists(text) from public, anon, authenticated;
grant execute on function public.source_slug_exists(text) to anon, service_role;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('116', '116_anon_public_rpcs')
  on conflict do nothing;

commit;
