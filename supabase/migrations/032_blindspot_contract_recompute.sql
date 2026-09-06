-- 032_blindspot_contract_recompute.sql
--
-- Ships the one-bias-zone contract's blindspot rule as a re-runnable SQL
-- function, and backfills every existing cluster under it once.
--
-- Before this migration, blindspot detection had FOUR independent copies
-- (the Deno cluster-consumer, a dead src/lib/bias/analyzer.ts copy, the
-- /blindspots page's own 0.8-share rule, and cross-spectrum.ts's 0.85
-- blindspotCandidate) plus migration 031's single-zone-only DB rule
-- (>= 5 sources AND exactly one zone has ANY coverage). The contract in
-- supabase/functions/_shared/cluster/blindspot.ts (BLINDSPOT.minSources = 5,
-- BLINDSPOT.dominantShare = 0.8) supersedes all of them: a zone need not
-- have 100% of sources, just >= 80%. tests/migrations/zone-parity.test.ts
-- fails this file (and 023, and 031) if the zone mapping or the threshold
-- literals below drift from that module.
--
-- public.recompute_blindspot_flags() re-derives is_blindspot /
-- blindspot_side for EVERY cluster from the stored bias_distribution jsonb:
--   * total sources (summed over the 10 known bias keys) >= 5
--   * the dominant Medya DNA zone's share of that total >= 0.8
--   * blindspot_side is the largest bias category inside the dominant zone,
--     ties broken by BIAS_KEYS order (array_position against a literal copy
--     of BIAS_KEYS below)
-- It only UPDATEs rows whose is_blindspot or blindspot_side actually
-- change, and returns that row count. Re-run it (`select
-- public.recompute_blindspot_flags();`) any time the contract's thresholds
-- or zone mapping change — it is the only place production data gets
-- re-derived, and the cluster-consumer Edge Function must also be
-- redeployed in that case since the contract module is bundled into it
-- (see docs/migration-guide.md).
--
-- Idempotency: `create or replace function` is safe to re-run; the
-- function body is a plain UPDATE with an `is distinct from` guard, so
-- calling it twice in a row changes 0 rows the second time. No trigger
-- fires from this UPDATE (clusters has none on UPDATE), so
-- clusters.updated_at — the /api/health liveness signal — is untouched,
-- matching migration 031's convention.
--
-- Scale note: production carries ~170k already-flagged clusters. This is a
-- single plain UPDATE (no batching, no trigger side effects) — acceptable
-- for a one-time contract backfill, but a future re-run against a much
-- larger clusters table may want to chunk by id range if it starts
-- competing with the live cluster-consumer write path.

begin;

create or replace function public.recompute_blindspot_flags()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed integer;
  v_changed_zero integer;
begin
  with counts as (
    select
      c.id as cluster_id,
      e.key as bias_key,
      (e.value)::int as n,
      -- Zone CASE copied verbatim from BIAS_TO_ZONE in
      -- supabase/functions/_shared/cluster/blindspot.ts. Keep in sync —
      -- tests/migrations/zone-parity.test.ts enforces it.
      case e.key
        when 'pro_government'        then 'iktidar'
        when 'gov_leaning'           then 'iktidar'
        when 'state_media'           then 'iktidar'
        when 'islamist_conservative' then 'iktidar'
        when 'nationalist'           then 'iktidar'
        when 'center'                then 'bagimsiz'
        when 'international'         then 'bagimsiz'
        when 'pro_kurdish'           then 'bagimsiz'
        when 'opposition_leaning'    then 'muhalefet'
        when 'opposition'            then 'muhalefet'
      end as zone
    from public.clusters c
    cross join lateral pg_catalog.jsonb_each_text(c.bias_distribution) e
    -- Only the 10 known categories count; legacy keys from the
    -- pre-taxonomy default ('independent') are ignored, same as 031.
    where e.key in (
      'pro_government', 'gov_leaning', 'state_media', 'center',
      'opposition_leaning', 'opposition', 'nationalist',
      'islamist_conservative', 'pro_kurdish', 'international'
    )
  ),
  totals as (
    select cluster_id, pg_catalog.sum(n) as total
    from counts
    group by cluster_id
  ),
  zone_totals as (
    select cluster_id, zone, pg_catalog.sum(n) as zone_n
    from counts
    group by cluster_id, zone
  ),
  dominant as (
    -- The zone with the most sources per cluster. Ties (only possible when
    -- share can't reach 0.8 anyway) break by ZONE_KEYS order, mirroring
    -- tallyZones()'s iteration order in blindspot.ts.
    select distinct on (zt.cluster_id)
      zt.cluster_id,
      zt.zone as dominant_zone,
      zt.zone_n
    from zone_totals zt
    order by
      zt.cluster_id,
      zt.zone_n desc,
      pg_catalog.array_position(array['iktidar', 'bagimsiz', 'muhalefet'], zt.zone)
  ),
  category_rank as (
    select
      c.cluster_id,
      c.bias_key,
      pg_catalog.row_number() over (
        partition by c.cluster_id
        order by
          c.n desc,
          -- BIAS_KEYS order, copied verbatim from blindspot.ts. Ties break
          -- here — tests/migrations/zone-parity.test.ts enforces this
          -- array literal equals BIAS_KEYS.
          pg_catalog.array_position(
            array[
              'pro_government', 'gov_leaning', 'state_media', 'center',
              'opposition_leaning', 'opposition', 'nationalist',
              'islamist_conservative', 'pro_kurdish', 'international'
            ],
            c.bias_key
          )
      ) as rn
    from counts c
    join dominant d
      on d.cluster_id = c.cluster_id and c.zone = d.dominant_zone
  ),
  verdicts as (
    select
      d.cluster_id,
      -- BLINDSPOT.minSources = 5, BLINDSPOT.dominantShare = 0.8.
      (
        t.total >= 5
        and d.zone_n::numeric / nullif(t.total, 0) >= 0.8
      ) as is_blindspot,
      cr.bias_key as dominant_category
    from dominant d
    join totals t on t.cluster_id = d.cluster_id
    left join category_rank cr
      on cr.cluster_id = d.cluster_id and cr.rn = 1
  )
  update public.clusters c
  set
    is_blindspot = v.is_blindspot,
    blindspot_side = case when v.is_blindspot then v.dominant_category else null end
  from verdicts v
  where c.id = v.cluster_id
    and (
      c.is_blindspot is distinct from v.is_blindspot
      or c.blindspot_side is distinct from
         case when v.is_blindspot then v.dominant_category else null end
    );

  get diagnostics v_changed = row_count;

  -- Clusters with zero counted bias keys (empty bias_distribution, or only
  -- legacy keys like 'independent') never appear in `verdicts` above since
  -- it derives from an inner lateral join filtered to the 10 known keys.
  -- Under the contract, total = 0 is not a blindspot, so clear any stale
  -- flag left over from a prior rule.
  with zero_count as (
    select c.id
    from public.clusters c
    where c.is_blindspot
      and not exists (
        select 1
        from pg_catalog.jsonb_each_text(c.bias_distribution) e
        where e.key in (
          'pro_government', 'gov_leaning', 'state_media', 'center',
          'opposition_leaning', 'opposition', 'nationalist',
          'islamist_conservative', 'pro_kurdish', 'international'
        )
      )
  )
  update public.clusters c
  set is_blindspot = false, blindspot_side = null
  from zero_count z
  where c.id = z.id;

  get diagnostics v_changed_zero = row_count;
  return v_changed + v_changed_zero;
end;
$$;

comment on function public.recompute_blindspot_flags() is
  'Re-derives clusters.is_blindspot / blindspot_side for every cluster from '
  'bias_distribution under the contract in '
  'supabase/functions/_shared/cluster/blindspot.ts (BLINDSPOT.minSources = '
  '5, BLINDSPOT.dominantShare = 0.8). Only touches rows whose flags '
  'actually change; returns that count. Re-run after any contract change '
  '(and redeploy cluster-consumer, which bundles the same module) — see '
  'docs/migration-guide.md.';

-- Supabase auto-grants EXECUTE to anon + authenticated on function
-- creation; name them explicitly in the revoke (revoking from public alone
-- leaves the role-direct grants and the RPC stays exposed via PostgREST).
revoke execute on function public.recompute_blindspot_flags()
  from anon, authenticated, public;
grant execute on function public.recompute_blindspot_flags() to service_role;

-- One-time backfill under the contract. Re-run manually
-- (`select public.recompute_blindspot_flags();`) any time BLINDSPOT's
-- thresholds or BIAS_TO_ZONE change in the future.
select public.recompute_blindspot_flags();

commit;
