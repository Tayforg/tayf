-- 095_revoke_anon_maintain.sql
--
-- Revoke the PostgreSQL 17 MAINTAIN privilege from anon/authenticated on
-- every relation in schema public.
--
-- Evidence (read-only against production, 2026-09-29):
--   - server_version_num = 170006 (PostgreSQL 17.0.6), so MAINTAIN exists.
--   - 18 public relations grant MAINTAIN to both anon and authenticated
--     (36 aclexplode rows), all with grantor postgres, so a REVOKE run as
--     postgres removes them all. Relations: article_tickers, articles,
--     bist_aliases, bist_bars_5m, bist_bars_daily, bist_companies,
--     bist_quote_stats (view), cluster_articles, clusters,
--     disclosure_coverage (view), kap_disclosures, source_zone_history,
--     sources, stories, story_stances, ticker_attention_daily (view),
--     trends_daily_bias_counts (view), trends_daily_zone_counts_ist (view).
--   - 0 non-security-definer public functions callable by anon/authenticated
--     contain VACUUM/ANALYZE/REINDEX/CLUSTER/LOCK TABLE/REFRESH MATERIALIZED.
--   - cron.job maintenance commands (articles-vacuum, clusters-vacuum,
--     trends-rollup-refresh, ...) all run as username postgres.
--   - 0 materialized views in public.
--
-- Why: MAINTAIN permits VACUUM, ANALYZE, CLUSTER, REINDEX, REFRESH
-- MATERIALIZED VIEW and LOCK TABLE. Supabase's default ACL grants it to
-- anon/authenticated. It is unreachable through PostgREST, but LOCK TABLE
-- ... IN ACCESS EXCLUSIVE MODE through any future SQL path would be a
-- one-line denial of service. 091 revoked INSERT/UPDATE/DELETE/TRUNCATE/
-- TRIGGER/REFERENCES but not MAINTAIN.
--
-- Properties:
--   - SELECT is untouched. service_role and postgres are never referenced.
--   - Default privileges are intentionally untouched (same reasoning as 091):
--     any table created later must repeat 092's guarded revoke or re-run
--     this block.
--   - Idempotent. A no-op with a NOTICE below PostgreSQL 17 (MAINTAIN does
--     not exist there; e.g. local PG15).
--   - Coverage: sources_rss_backup_093, trends_daily_zone_counts_ist_rollup,
--     sources_fetch_state_backup_094 and every table created after 091 are
--     covered because the block loops the catalog and names no relation.
--   - A REVOKE by a non-grantor is a WARNING, not an error, so leftovers are
--     reported (with grantor) instead of raising and rolling back.
--
-- Verification (expect 0 rows):
--   select c.relname, c.relkind, a.grantee::regrole, a.grantor::regrole
--     from pg_catalog.pg_class c
--     join pg_catalog.pg_namespace n on n.oid = c.relnamespace
--     cross join lateral pg_catalog.aclexplode(c.relacl) a
--    where n.nspname = 'public' and c.relkind in ('r','p','v','m')
--      and a.privilege_type = 'MAINTAIN'
--      and a.grantee in ('anon'::regrole, 'authenticated'::regrole);
--
-- Rollback (not recommended):
--   grant maintain on table public.<rel> to anon, authenticated;

begin;

do $maint$
declare
  v_rel     record;
  v_scanned integer := 0;
  v_revoked integer := 0;
  v_left    integer := 0;
begin
  if pg_catalog.current_setting('server_version_num')::int < 170000 then
    raise notice '095: server_version_num % < 170000: MAINTAIN does not exist before PostgreSQL 17, nothing to revoke',
      pg_catalog.current_setting('server_version_num');
    return;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
     or not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    raise notice '095: role anon or authenticated missing, nothing to revoke';
    return;
  end if;

  for v_rel in
    select c.relname,
           exists (select 1 from pg_catalog.aclexplode(c.relacl) a
                    where a.privilege_type = 'MAINTAIN'
                      and a.grantee in ('anon'::regrole, 'authenticated'::regrole)) as had_maintain
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
     order by c.relname
  loop
    v_scanned := v_scanned + 1;
    execute format('revoke maintain on table %I.%I from anon, authenticated', 'public', v_rel.relname);
    if v_rel.had_maintain then
      v_revoked := v_revoked + 1;
      raise notice 'public.% : revoked MAINTAIN from anon, authenticated', v_rel.relname;
    end if;
  end loop;

  for v_rel in
    select c.relname, a.grantee::regrole::text as grantee, a.grantor::regrole::text as grantor
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      cross join lateral pg_catalog.aclexplode(c.relacl) a
     where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
       and a.privilege_type = 'MAINTAIN'
       and a.grantee in ('anon'::regrole, 'authenticated'::regrole)
  loop
    v_left := v_left + 1;
    raise warning '095: public.% still grants MAINTAIN to % (grantor %); revoke it as that grantor', v_rel.relname, v_rel.grantee, v_rel.grantor;
  end loop;

  raise notice '095: scanned % relation(s) in public; MAINTAIN revoked from anon/authenticated on %; % grant(s) remain',
    v_scanned, v_revoked, v_left;
end
$maint$;

insert into supabase_migrations.schema_migrations (version, name)
  values ('095', '095_revoke_anon_maintain')
  on conflict do nothing;

commit;
