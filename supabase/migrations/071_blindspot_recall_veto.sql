-- 071_blindspot_recall_veto.sql
--
-- Blindspot recall veto: withdraw a "kör nokta" claim from readers when Jev
-- shows the silent side covered the same event in a cluster Tayf split off.
--
-- Why: the clusterer sometimes splits one event into two clusters, so a
-- blindspot can be a matching gap rather than real silence. Migration 064's
-- 'blindspot_recall' jev-shadow stage already looks, for every blindspot,
-- for same-event articles from the silent side (jev_shadow_predictions,
-- task 'blindspot_recall', one row per candidate article with jev_prob), but
-- until now only the admin panel read the result.
--
-- Rule (mirrors the BLINDSPOT contract in
-- supabase/functions/_shared/cluster/blindspot.ts): a cluster is vetoed when
--   (a) its live bias_distribution passes the contract (>= 5 voting sources,
--       dominant zone >= 0.8), and
--   (b) after adding each distinct voting (outlet/wire) source that has a
--       blindspot_recall match at jev_prob >= 0.85 and is NOT already a
--       member, the dominant share drops below 0.8.
-- Missing data never hides anything: no predictions => no veto.
--
-- What this migration does (additive only):
--   1. clusters.blindspot_recall_veto (boolean not null default false) and
--      clusters.blindspot_recall_veto_at (timestamptz), plus a partial index.
--   2. public.blindspot_recall_veto_refresh(p_since, p_min_prob): SECURITY
--      DEFINER, search_path = '', service_role-only. Recomputes the veto for
--      recently touched blindspots plus every currently vetoed row (so stale
--      vetoes clear). Idempotent: rows are written only when the verdict
--      changes, so a second run returns 0.
--   3. pg_cron job 'blindspot-recall-veto' at 7-59/10, i.e. 7 minutes after
--      each jev-shadow tick (061 schedules jev-shadow at */10).
--   4. A one-off 30-day backfill.
--
-- What it never does: write is_blindspot, blindspot_side or updated_at. The
-- DB flags stay exactly as migration 032 computed them (no trigger stamps
-- clusters.updated_at, see 031's header). Read paths treat
-- `is_blindspot AND NOT blindspot_recall_veto` as the public claim
-- (src/lib/clusters/recall-veto.ts).
--
-- The zone map below is the seventh declared SQL copy of BIAS_TO_ZONE;
-- tests/migrations/071-blindspot-recall-veto.test.ts pins it, the
-- thresholds and the voting kinds to the contract modules.
--
-- DEPLOY ORDER: apply this migration BEFORE the Vercel deploy that selects
-- blindspot_recall_veto. PostgREST returns 400 for an unknown column in a
-- select, which would take down home, /blindspots and every cluster page.
-- See docs/migration-guide.md.

begin;

alter table public.clusters
  add column if not exists blindspot_recall_veto    boolean not null default false,
  add column if not exists blindspot_recall_veto_at timestamptz;

create index if not exists clusters_blindspot_recall_veto_idx
  on public.clusters (updated_at desc) where blindspot_recall_veto;

comment on column public.clusters.blindspot_recall_veto is
  'True when adding the silent-zone voting sources that Jev blindspot_recall matched at >= 0.85 '
  '(migration 064 stage) drops the dominant zone below BLINDSPOT.dominantShare. Read paths treat '
  'is_blindspot AND NOT blindspot_recall_veto as the public claim. Maintained by '
  'blindspot_recall_veto_refresh(); never touches is_blindspot/blindspot_side/updated_at.';

comment on column public.clusters.blindspot_recall_veto_at is
  'When blindspot_recall_veto was first set for the current veto (migration 071); '
  'null when the cluster is not vetoed.';

create or replace function public.blindspot_recall_veto_refresh(
  p_since    interval default interval '26 hours',
  p_min_prob numeric  default 0.85
) returns integer
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_since   interval := least(coalesce(p_since, interval '26 hours'), interval '30 days');
  v_min     numeric  := greatest(coalesce(p_min_prob, 0.85), 0.5);
  v_updated integer  := 0;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('blindspot_recall_veto_refresh')::bigint) then
    return 0;
  end if;

  with zmap(bias_key, zone) as (values   -- verbatim BIAS_TO_ZONE (032); parity-tested
      ('pro_government','iktidar'),('gov_leaning','iktidar'),('state_media','iktidar'),
      ('islamist_conservative','iktidar'),('nationalist','iktidar'),
      ('center','bagimsiz'),('international','bagimsiz'),('pro_kurdish','bagimsiz'),
      ('opposition_leaning','muhalefet'),('opposition','muhalefet')),
  win as (
      select c.id, c.bias_distribution, c.is_blindspot from public.clusters c
       where c.is_blindspot
         and (c.updated_at >= pg_catalog.now() - v_since
              or c.blindspot_recall_checked_at >= pg_catalog.now() - v_since)
      union
      select c.id, c.bias_distribution, c.is_blindspot from public.clusters c
       where c.blindspot_recall_veto),                 -- lets stale vetoes clear
  base as (
      select w.id as cluster_id, z.zone, (e.value)::int as n
        from win w cross join lateral pg_catalog.jsonb_each_text(w.bias_distribution) e
        join zmap z on z.bias_key = e.key
       where e.value ~ '^[0-9]+$'),                    -- a malformed count never aborts the run
  matched as (
      select distinct p.cluster_id, s.id as source_id, z.zone
        from public.jev_shadow_predictions p
        join win w            on w.id = p.cluster_id
        join public.articles a on a.id = p.article_id
        join public.sources  s on s.id = a.source_id
        join zmap z            on z.bias_key = s.bias
       where p.task = 'blindspot_recall' and p.article_id is not null
         and p.jev_prob >= v_min
         and s.kind in ('outlet','wire')              -- VOTING_SOURCE_KINDS; parity-tested
         and not exists (select 1 from public.cluster_articles ca
                           join public.articles a2 on a2.id = ca.article_id
                          where ca.cluster_id = p.cluster_id and a2.source_id = s.id)),
  live as (select cluster_id, max(zn) dom_n, sum(zn) tot
             from (select cluster_id, zone, sum(n) zn from base group by 1,2) t group by 1),
  adj  as (select cluster_id, max(zn) dom_n, sum(zn) tot
             from (select cluster_id, zone, sum(n) zn
                     from (select cluster_id, zone, n from base
                           union all select cluster_id, zone, 1 from matched) u
                    group by 1,2) t group by 1),
  verdict as (
      select w.id as cluster_id,
             coalesce(w.is_blindspot
                      and l.tot >= 5                                   -- BLINDSPOT.minSources
                      and l.dom_n::numeric / nullif(l.tot,0) >= 0.8     -- BLINDSPOT.dominantShare
                      and a.dom_n::numeric / nullif(a.tot,0) <  0.8, false) as veto
        from win w left join live l on l.cluster_id = w.id
                   left join adj  a on a.cluster_id = w.id)
  update public.clusters c
     set blindspot_recall_veto    = v.veto,
         blindspot_recall_veto_at = case when v.veto then coalesce(c.blindspot_recall_veto_at, pg_catalog.now()) end
    from verdict v
   where c.id = v.cluster_id
     and c.blindspot_recall_veto is distinct from v.veto;

  get diagnostics v_updated = row_count;
  return v_updated;
end
$fn$;

comment on function public.blindspot_recall_veto_refresh(interval, numeric) is
  'Recomputes clusters.blindspot_recall_veto (migration 071) for blindspots updated or '
  'recall-checked within p_since (capped at 30 days) plus every currently vetoed row. '
  'Returns the number of rows whose veto changed. Never writes is_blindspot, '
  'blindspot_side or updated_at. service_role only; scheduled as blindspot-recall-veto.';

revoke all on function public.blindspot_recall_veto_refresh(interval, numeric) from public, anon, authenticated;
grant execute on function public.blindspot_recall_veto_refresh(interval, numeric) to service_role;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron not installed — skipping blindspot-recall-veto schedule (071)'; return;
  end if;
  if exists (select 1 from cron.job where jobname = 'blindspot-recall-veto') then
    perform cron.unschedule('blindspot-recall-veto');
  end if;
  perform cron.schedule('blindspot-recall-veto', '7-59/10 * * * *',
    $sql$ select public.blindspot_recall_veto_refresh(); $sql$);   -- 7 min after each jev-shadow tick
end $$;

select public.blindspot_recall_veto_refresh(interval '30 days');   -- one-off backfill

insert into supabase_migrations.schema_migrations (version, name)
  values ('071', '071_blindspot_recall_veto') on conflict do nothing;

commit;
