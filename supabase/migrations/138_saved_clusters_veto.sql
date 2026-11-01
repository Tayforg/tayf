-- 138_saved_clusters_veto.sql
--
-- saved_clusters_v2(p_ids uuid[]): apply the blindspot veto to the is_blindspot
-- column, so /saved stops showing the amber "Kör nokta" pill for a story whose
-- blindspot claim the rest of the site has withdrawn.
--
-- WHY. Migration 124 returns the raw c.is_blindspot. Every other public surface
-- treats `is_blindspot AND NOT blindspot_recall_veto` as the claim: the cluster
-- page through applyRecallVeto (src/lib/clusters/recall-veto.ts, called by
-- cluster-detail-query.ts), the feeds through .eq("blindspot_recall_veto", false).
-- Migration 126 lists /saved as a known gap that it left alone, in its list of
-- findings "NOT changed here" (item (1)): a vetoed story keeps its pill on /saved
-- while its cluster page has none. One column covers both vetoes: 071's Jev recall
-- (blindspot_veto_reason 'jev_recall') and 126's sibling headline rule
-- ('sibling_headline') both set blindspot_recall_veto. Production, read-only,
-- 2026-11-01 (hunt 13, h13-biasdata-2):
--   * a006ab26-1462-48a0-8c0f-1325b689bebd (TÜSEB Aziz Sancar ödülleri):
--     is_blindspot true, blindspot_recall_veto true, reason jev_recall. Its
--     /cluster page has no "Kör nokta"; bookmarked, /saved showed the pill.
--   * 112a68bd-68d3-4bc8-ab0b-6d12b37762b8 (Erdoğan-Zelenski görüşmesi):
--     true / true, reason sibling_headline.
--   * 10 of the 29 blindspot-flagged clusters created in the last 3 days
--     (34 percent) carry the veto, so this is a frequent case, not a corner.
--
-- WHAT CHANGES. One expression in one create or replace function. The select list
-- of 124 is reproduced character for character except the last column:
--     c.is_blindspot
--   becomes
--     (c.is_blindspot and not coalesce(c.blindspot_recall_veto, false)) as is_blindspot
-- The coalesce makes a NULL veto pass through exactly like applyRecallVeto, where
-- only a literal true vetoes (production has the column NOT NULL default false,
-- so it is a no-op there; fixtures and old environments may carry nulls). Signature,
-- the seven return columns and their order and types, language sql, STABLE,
-- SECURITY DEFINER, set search_path = '', from / where / order by / limit (the
-- p_ids[1:200] truncation, newest update first, 200 rows) and the grants are
-- unchanged. No feed-health gate is added: this is the veto and nothing else.
-- tests/migrations/138-saved-clusters-veto.test.ts parses 124 and this file and
-- pins all of that, plus the truth table against applyRecallVeto.
--
-- STEP 0 (production, read-only, 2026-11-01).
--   select pg_get_functiondef('public.saved_clusters_v2(uuid[])'::regprocedure)
--     -> exactly 124's definition: RETURNS TABLE(id uuid, title_tr text,
--        title_tr_neutral text, article_count integer, bias_distribution jsonb,
--        updated_at timestamp with time zone, is_blindspot boolean), LANGUAGE
--        sql, STABLE SECURITY DEFINER, SET search_path TO '', body
--        `select c.id, ..., c.is_blindspot from public.clusters c where c.id =
--        any (coalesce(p_ids[1:200], '{}'::uuid[])) order by c.updated_at desc
--        limit 200`. The only difference to this migration is the is_blindspot
--        expression.
--   select proacl, provolatile, prosecdef, proconfig, prorows, procost from pg_proc ...
--     -> {postgres=X/postgres,service_role=X/postgres,anon=X/postgres}, s, true,
--        {search_path=""}, 1000, 100. create or replace keeps owner, ACL and
--        these attributes; the revoke / grant below restate the same ACL for
--        tests/guards/anon-surface.test.ts, which scans every migration >= 116.
--   clusters.is_blindspot and clusters.blindspot_recall_veto are boolean NOT NULL
--   default false.
--
-- Properties of the migration:
--   - Additive: one create or replace function, one comment, one revoke/grant on
--     that function, the ledger row. No data rewrite, no table touched, nothing
--     dropped. Takes no table lock; lock_timeout 5s bounds the catalog lock.
--   - Idempotent: create or replace + repeatable revoke/grant + ledger
--     "on conflict do nothing".
--   - Nothing is granted to authenticated (Tayf has no user sessions) and no
--     table privilege is granted to anyone. The grant shape (execute to anon and
--     service_role after revoking from public, anon, authenticated) is the one
--     the anon-surface guard allowlists; the guard needs no edit.
--   - notify pgrst makes PostgREST rebuild its schema cache.
--
-- DEPLOY ORDER: none. The app reads the same column name (is_blindspot) from the
-- same RPC, so the app and this migration can ship in either order. Apply with
-- `supabase db push`. Until it is applied /saved behaves as before (the pill on
-- vetoed stories); afterwards the pill follows the cluster page.
--
-- Verification (read-only):
--   select has_function_privilege('anon','public.saved_clusters_v2(uuid[])','execute'),
--          has_function_privilege('authenticated','public.saved_clusters_v2(uuid[])','execute');
--       -- true, false
--   select id, is_blindspot from public.saved_clusters_v2(
--     array['a006ab26-1462-48a0-8c0f-1325b689bebd','112a68bd-68d3-4bc8-ab0b-6d12b37762b8']::uuid[]);
--       -- both false after this migration (true before)
--
-- Dry-run (local PG15, throwaway data dirs, never production):
--   tests/migrations/sql/138-saved-clusters-veto-dryrun.sql. Prelude: Supabase
--   default privileges, clusters.blindspot_recall_veto (nullable), merged_into,
--   summary_tr. Applies 124, then 138 twice. Run twice on two fresh data dirs
--   (pg-138-a, pg-138-b, port 55538), both ended with "DRYRUN 138 OK". The second
--   application of 138 printed "INSERT 0 0" for the ledger row. As the anon role
--   the vetoed rows read false, the flagged unvetoed and flagged null-veto rows
--   true, the unflagged rows false; proacl is the production shape; anon and
--   service_role can execute, authenticated cannot; the 200-id truncation holds.
--
-- ROLLBACK: re-apply the create or replace function block of
-- 124_saved_clusters_v2.sql (function, comment, revoke, grant), then
--   delete from supabase_migrations.schema_migrations where version = '138';
-- The app is unaffected (the column set is identical).

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
         (c.is_blindspot and not coalesce(c.blindspot_recall_veto, false)) as is_blindspot
    from public.clusters c
   where c.id = any (coalesce(p_ids[1:200], '{}'::uuid[]))
   order by c.updated_at desc
   limit 200
$fn$;

comment on function public.saved_clusters_v2(uuid[]) is
  'Saved-story lookup for /saved: the same rows as saved_clusters (at most 200, input truncated to 200 ids) plus is_blindspot, withdrawn by blindspot_recall_veto exactly like the cluster page (migration 138). v1 stays for bookmark-snapshots.ts.';

revoke all on function public.saved_clusters_v2(uuid[]) from public, anon, authenticated;
grant execute on function public.saved_clusters_v2(uuid[]) to anon, service_role;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('138', '138_saved_clusters_veto')
  on conflict do nothing;

commit;
