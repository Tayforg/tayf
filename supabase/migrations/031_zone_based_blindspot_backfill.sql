-- 031: Recompute clusters.is_blindspot / blindspot_side under the new
-- zone-based rule (see supabase/functions/_shared/cluster/blindspot.ts).
--
-- Old rule: "exactly one of the 10 bias categories non-zero" — fired on
-- 1-2 source clusters (noise badges on the homepage) and missed
-- multi-category single-zone clusters (pro_government + gov_leaning +
-- state_media = 100% iktidar but 3 categories → not flagged).
--
-- New rule: total sources >= 5 AND exactly one Medya DNA zone has coverage.
-- blindspot_side stays a bias *category* (the dominant one) for UI compat.
--
-- The zone mapping MUST mirror BIAS_TO_ZONE in blindspot.ts /
-- src/lib/bias/config.ts:
--   iktidar   : pro_government, gov_leaning, state_media,
--               islamist_conservative, nationalist
--   bagimsiz  : center, international, pro_kurdish
--   muhalefet : opposition_leaning, opposition
--
-- Plain UPDATE — no trigger stamps clusters.updated_at, so the /api/health
-- liveness signal is not perturbed.

with tallies as (
  select
    c.id,
    coalesce(sum(v.n), 0) as total,
    coalesce(sum(v.n) filter (where v.k in
      ('pro_government','gov_leaning','state_media',
       'islamist_conservative','nationalist')), 0) as iktidar,
    coalesce(sum(v.n) filter (where v.k in
      ('center','international','pro_kurdish')), 0) as bagimsiz,
    coalesce(sum(v.n) filter (where v.k in
      ('opposition_leaning','opposition')), 0) as muhalefet,
    -- Dominant category overall; when the cluster is single-zone this is by
    -- construction a member of that zone. Ties break alphabetically for
    -- determinism.
    (
      select e.key
      from jsonb_each_text(c.bias_distribution) e
      where (e.value)::int > 0
      order by (e.value)::int desc, e.key
      limit 1
    ) as dominant_category
  from clusters c
  cross join lateral (
    select e.key as k, (e.value)::int as n
    from jsonb_each_text(c.bias_distribution) e
    -- Only the 10 known categories count toward the tally; legacy keys from
    -- the pre-taxonomy default ('independent') are ignored.
    where e.key in
      ('pro_government','gov_leaning','state_media','islamist_conservative',
       'nationalist','center','international','pro_kurdish',
       'opposition_leaning','opposition')
  ) v
  group by c.id
),
verdicts as (
  select
    id,
    (
      total >= 5
      and ((iktidar > 0)::int + (bagimsiz > 0)::int + (muhalefet > 0)::int) = 1
    ) as is_blindspot,
    dominant_category
  from tallies
)
update clusters c
set
  is_blindspot = v.is_blindspot,
  blindspot_side = case when v.is_blindspot then v.dominant_category else null end
from verdicts v
where c.id = v.id
  and (
    c.is_blindspot is distinct from v.is_blindspot
    or c.blindspot_side is distinct from
       case when v.is_blindspot then v.dominant_category else null end
  );
