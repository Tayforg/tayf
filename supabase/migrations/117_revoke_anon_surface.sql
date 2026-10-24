-- 117_revoke_anon_surface.sql
--
-- Remove every anon/authenticated table and sequence grant in schema public,
-- close the default ACLs that keep re-creating them, and leave migration
-- 116's four SECURITY DEFINER RPCs as the only thing the public anon key can
-- reach.
--
-- Evidence (read-only against production, 2026-10-24, PostgreSQL 17.0.6):
--
--   (a) 23 relations in schema public are SELECTable by anon (relkind r/v):
--       article_tickers, articles, bist_aliases, bist_bars_5m,
--       bist_bars_daily, bist_companies, bist_quote_stats (v), cluster_articles,
--       cluster_fact_checks, clusters, disclosure_coverage (v), fact_checks,
--       kap_disclosures, source_zone_history, sources, stories, story_stances,
--       story_thread_members, story_threads, ticker_attention_daily (v),
--       trends_daily_bias_counts (v), trends_daily_zone_counts_ist (v),
--       trends_daily_zone_counts_ist_rollup. Reachable with nothing but the
--       public key: GET /rest/v1/<relation>.
--   (b) 6 sequences in schema public have USAGE for anon AND authenticated:
--       admin_login_attempts_id_seq, article_title_versions_id_seq,
--       cluster_merge_log_id_seq, cluster_quality_snapshots_id_seq,
--       ingest_cycles_id_seq, story_thread_candidates_id_seq. They belong to
--       tables created AFTER 091 whose migrations revoked the table grants but
--       not the sequence grants: proof that per-migration revokes slip.
--   (c) exactly one SECURITY DEFINER function in public is executable by
--       anon: rls_auto_enable() (the Supabase "ensure_rls" event-trigger
--       function; returns event_trigger, so it cannot be called as an RPC, but
--       it is dead surface). ACL {=X/postgres, postgres, anon, authenticated,
--       service_role}. Revoked explicitly below. Event-trigger firing does not
--       check EXECUTE, so ensure_rls keeps working (verified on a local PG15
--       with a real event trigger and a non-superuser creating tables).
--   (d) pg_default_acl for schema public, grantor postgres (and supabase_admin):
--         r  {postgres=arwdDxtm, anon=arwdDxtm, authenticated=arwdDxtm, service_role=arwdDxtm}
--         S  {postgres=rwU,      anon=rwU,      authenticated=rwU,      service_role=rwU}
--         f  {postgres=X,        anon=X,        authenticated=X,        service_role=X}
--       Every table, sequence and function postgres creates in public is born
--       granted to anon and authenticated. 091 and 095 deliberately left these
--       (and SELECT) alone because they were platform defaults; (b) shows that
--       was not sustainable.
--   (e) columns used by migration 116 (information_schema): clusters.id uuid,
--       title_tr text, title_tr_neutral text, article_count int4,
--       bias_distribution jsonb, updated_at timestamptz, merged_into uuid;
--       sources.slug text.
--   (f) all views in public are security_invoker (bist_quote_stats,
--       disclosure_coverage, ticker_attention_daily, trends_daily_zone_counts_ist,
--       finance_*, ml_*) EXCEPT trends_daily_bias_counts and worker_metrics
--       (reloptions NULL: they run with their owner's rights and bypass RLS on
--       the underlying tables). worker_metrics was never anon-readable;
--       trends_daily_bias_counts was. It is switched to security_invoker below
--       so a future accidental grant to anon cannot read through the owner.
--
-- After 117 the anon key reaches data only through saved_clusters(uuid[]),
-- merged_cluster_map(), source_slugs() and source_slug_exists(text) (116).
-- service_role and postgres are never referenced: ingestion, crons, Edge
-- Functions and every server route use the service-role key and keep their
-- grants. Nothing is dropped and no row is touched.
--
-- What this does NOT do (read before assuming more):
--   - PUBLIC EXECUTE on future functions is NOT revoked. A per-schema default
--     ACL cannot remove the global PUBLIC grant on functions (PostgreSQL grants
--     EXECUTE to PUBLIC on every new function regardless), and a global
--     "alter default privileges ... revoke execute on functions from public"
--     would also hit extension-created functions that service_role relies on.
--     A new SECURITY DEFINER function therefore still needs its own
--     "revoke all on function ... from public, anon, authenticated" (AGENTS.md
--     convention). The control for that is tests/guards/anon-surface.test.ts,
--     which fails any migration >= 116 that defines a SECURITY DEFINER function
--     without an anon revoke or that grants anything to anon/authenticated/public
--     other than the four 116 executes.
--   - The default ACL entries owned by supabase_admin cannot be altered by
--     postgres (a role can only change defaults for itself or roles it is a
--     member of). Objects created BY supabase_admin in public would still be
--     born granted. None exist today: every object in public is owned by
--     postgres (66 tables, 10 views, 18 sequences, 108 functions; checked
--     2026-10-24), so the postgres-run revokes below cover all of them.
--     Residual risk, documented here instead of papered over.
--   - RLS policies (017 "using (true)" SELECT policies and the rest) are left
--     in place: with the table privilege gone they are inert, and removing
--     them would make a rollback harder. Defence in depth, not the control.
--
-- Properties:
--   - Idempotent: revoking an absent privilege is a no-op; "alter default
--     privileges ... revoke" and "set (security_invoker)" are repeatable.
--   - "revoke all" also removes the PostgreSQL 17 MAINTAIN privilege, so the
--     095 guarded block is not needed again. It is valid on PG15 as well.
--   - A REVOKE by a role that is not the grantor is a WARNING, not an error,
--     so objects owned by another role are reported rather than rolling back.
--   - lock_timeout 5s bounds the only real lock (the view alter).
--
-- Verification (read-only; expect 0 rows each, then the four 116 functions):
--   select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
--    where n.nspname = 'public' and c.relkind in ('r','p','v','m')
--      and (has_table_privilege('anon', c.oid, 'select')
--        or has_table_privilege('authenticated', c.oid, 'select'));
--   select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
--    where n.nspname = 'public' and c.relkind = 'S'
--      and (has_sequence_privilege('anon', c.oid, 'usage')
--        or has_sequence_privilege('authenticated', c.oid, 'usage'));
--   select d.defaclobjtype, d.defaclacl from pg_default_acl d
--     join pg_namespace n on n.oid = d.defaclnamespace
--    where n.nspname = 'public' and d.defaclrole = 'postgres'::regrole;   -- no anon/authenticated
--   select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')
--      and p.prosecdef;                                                    -- only the 116 RPCs
--
-- Rollback: see the commented ROLLBACK block at the end of the file. It
-- restores read-only SELECT for the 23 relations and nothing else.

begin;

set local lock_timeout = '5s';

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

alter view public.trends_daily_bias_counts set (security_invoker = on);

alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated;

-- Prod fact (c): the one non-116 definer function anon can execute. Guarded so
-- the migration also applies on databases without the Supabase ensure_rls
-- helper (local stacks, previews).
do $x$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end
$x$;

insert into supabase_migrations.schema_migrations (version, name)
  values ('117', '117_revoke_anon_surface')
  on conflict do nothing;

commit;

-- ROLLBACK (not recommended; every line is commented on purpose). Read access
-- only. Writes, sequence usage and the default ACLs are never restored.
-- grant select on public.article_tickers to anon, authenticated;
-- grant select on public.articles to anon, authenticated;
-- grant select on public.bist_aliases to anon, authenticated;
-- grant select on public.bist_bars_5m to anon, authenticated;
-- grant select on public.bist_bars_daily to anon, authenticated;
-- grant select on public.bist_companies to anon, authenticated;
-- grant select on public.bist_quote_stats to anon, authenticated;
-- grant select on public.cluster_articles to anon, authenticated;
-- grant select on public.cluster_fact_checks to anon, authenticated;
-- grant select on public.clusters to anon, authenticated;
-- grant select on public.disclosure_coverage to anon, authenticated;
-- grant select on public.fact_checks to anon, authenticated;
-- grant select on public.kap_disclosures to anon, authenticated;
-- grant select on public.source_zone_history to anon, authenticated;
-- grant select on public.sources to anon, authenticated;
-- grant select on public.stories to anon, authenticated;
-- grant select on public.story_stances to anon, authenticated;
-- grant select on public.story_thread_members to anon, authenticated;
-- grant select on public.story_threads to anon, authenticated;
-- grant select on public.ticker_attention_daily to anon, authenticated;
-- grant select on public.trends_daily_bias_counts to anon, authenticated;
-- grant select on public.trends_daily_zone_counts_ist to anon, authenticated;
-- grant select on public.trends_daily_zone_counts_ist_rollup to anon, authenticated;
-- alter view public.trends_daily_bias_counts reset (security_invoker);
