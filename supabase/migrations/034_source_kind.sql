-- 034_source_kind.sql
--
-- Adds `sources.kind` — one of 'outlet' | 'aggregator' | 'wire' | 'niche' —
-- so aggregator portals (Haberler.com, Onedio, …) and niche sector feeds
-- (sports, finance, institutional) can remain cluster members (they still
-- count toward article_count / "N kaynak" and the cluster page's member
-- list) while being excluded from every VOTE-derived computation: the
-- bias_distribution jsonb, blindspot/surprise detection, and the
-- trends_daily_bias_counts view. Only 'outlet' and 'wire' vote.
--
-- Contract: supabase/functions/_shared/cluster/source-kind.ts defines
-- SOURCE_KINDS (the four values) and VOTING_SOURCE_KINDS (outlet, wire) —
-- the single source of truth this migration's CHECK constraint and `kind
-- in (...)` filters below must mirror. tests/migrations/zone-parity.test.ts
-- enforces that mirror (the CHECK list, every voting filter, the
-- trends-view zone CASE, and parity against supabase/seed_sources.sql's
-- (slug, kind) pairs) and fails the build the moment any of them drift.
--
-- DEPLOY ORDER (reversed vs. migration 032 — read this before applying):
--   1. Apply this migration FIRST (`supabase db push` or
--      `psql -f supabase/migrations/034_source_kind.sql`).
--   2. THEN redeploy the cluster-consumer Edge Function — the new build
--      selects `sources.kind` in getSourceLookup, so if it reached
--      production before this migration every drain invocation would fail
--      with an undefined-column error on that select. Reversed from 032
--      (function-first, migration-second was safe there because 032 only
--      added a function, never a column an existing SELECT depended on).
--   3. THEN re-run both recompute functions (public.recompute_bias_
--      distribution(now() - interval '48 hours') and public.
--      recompute_blindspot_flags()) — see docs/migration-guide.md, section
--      "Source kinds (034)", for the full runbook including why step 3 is
--      needed even though step 6 below already ran it once during this
--      migration.

begin;

-- ---------------------------------------------------------------------------
-- 1) Column + constraint (idempotent — safe to re-run this migration file).
-- ---------------------------------------------------------------------------

alter table public.sources
  add column if not exists kind text not null default 'outlet';

alter table public.sources drop constraint if exists sources_kind_check;
alter table public.sources add constraint sources_kind_check
  check (kind in ('outlet', 'aggregator', 'wire', 'niche'));

comment on column public.sources.kind is
  'outlet | aggregator | wire | niche. Only outlet and wire vote (bias_distribution, '
  'blindspot/surprise, trends_daily_bias_counts). Contract: '
  'supabase/functions/_shared/cluster/source-kind.ts; seed: supabase/seed_sources.sql.';

-- ---------------------------------------------------------------------------
-- 2) Seeded rows by slug. One UPDATE ... FROM (VALUES ...) so the parity
-- test can parse (slug, kind) pairs directly — deliberately NOT an `in
-- (...)` list (tests/migrations/zone-parity.test.ts classifies every
-- `in (...)` list in this file as either the CHECK constraint or a voting
-- filter, so a plain slug list here would be misclassified as a third
-- kind of list and fail that test).
--
-- 38 rows below; every other seeded source keeps the 'outlet' default.
-- This list MUST equal the non-outlet rows of supabase/seed_sources.sql —
-- the parity test checks both directions of that equality.
-- ---------------------------------------------------------------------------

update public.sources s
   set kind = v.kind
  from (values
    ('haberler-com', 'aggregator'), ('onedio', 'aggregator'), ('f5-haber', 'aggregator'),
    ('ajans-haber', 'aggregator'), ('haber3', 'aggregator'), ('son-dakika', 'aggregator'),
    ('beyaz-gazete', 'aggregator'),
    ('anadolu-ajansi', 'wire'), ('dha', 'wire'), ('iha', 'wire'), ('turkiye-haber-ajansi', 'wire'),
    ('mezopotamya-ajansi', 'wire'), ('bha', 'wire'),
    ('a-spor', 'niche'), ('fotomac', 'niche'), ('fanatik', 'niche'), ('ntv-spor', 'niche'),
    ('ajansspor', 'niche'), ('fotospor', 'niche'), ('kontraspor', 'niche'),
    ('bigpara', 'niche'), ('bloomberg-ht', 'niche'), ('finansal-gundem', 'niche'),
    ('investing-com-tr', 'niche'), ('paraanaliz', 'niche'), ('eko-seyir', 'niche'),
    ('ekonomim', 'niche'), ('dunya', 'niche'),
    ('tobb', 'niche'), ('mfa-turkey', 'niche'), ('diyanet-haber', 'niche'), ('kamudanhaber', 'niche'),
    ('hukuki-haber', 'niche'), ('iklim-haber', 'niche'), ('isci-haber', 'niche'),
    ('journo', 'niche'), ('newslab-turkey', 'niche'), ('platform-24', 'niche')
  ) as v(slug, kind)
 where s.slug = v.slug
   and s.kind is distinct from v.kind;

-- ---------------------------------------------------------------------------
-- 3) Recreate trends_daily_bias_counts with kind filtering. Body is
-- migration 023's, byte-for-byte on the zone CASE (parity test parses and
-- deep-equals it against BIAS_TO_ZONE in
-- supabase/functions/_shared/cluster/blindspot.ts — untouched by this
-- migration), schema-qualified, plus `where s.kind in ('outlet', 'wire')`
-- inserted between the join and the group by. Same three output columns
-- (day, zone, count), so `create or replace view` is legal here and /trends
-- needs no code change.
-- ---------------------------------------------------------------------------

create or replace view public.trends_daily_bias_counts as
select
  -- Truncate to UTC day so the key matches the `YYYY-MM-DD` slice used by
  -- the TS bucket builder. timestamptz → (utc) timestamp → date.
  (date_trunc('day', a.created_at at time zone 'utc'))::date as day,
  case s.bias
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
  end as zone,
  count(*)::int as count
from public.articles a
join public.sources s on s.id = a.source_id
where s.kind in ('outlet', 'wire')
group by 1, 2;

comment on view public.trends_daily_bias_counts is
  'Daily article counts per Medya DNA zone. Powers /trends. Keep zone '
  'mapping in sync with BIAS_TO_ZONE in src/lib/bias/config.ts. Only '
  'voting source kinds (outlet, wire) are counted — see migration 034 / '
  'source-kind.ts.';

grant select on public.trends_daily_bias_counts to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4) Re-runnable backfill function. Mirrors 031's CTE-UPDATE shape and
-- 032's function shell: SECURITY DEFINER, empty search_path, plain UPDATE
-- guarded by `is distinct from` so clusters.updated_at (the /api/health
-- liveness signal) is untouched, only rows that actually change get
-- written, and the row count is returned.
--
-- Per-article counting (not distinct source) to match the consumer's
-- addArticleToCluster / buildBiasDistribution, which tallies one vote per
-- member article. All 10 bias keys are always present (defaulting to 0)
-- so the jsonb shape stays canonical even for a cluster with zero voting
-- members after this backfill.
-- ---------------------------------------------------------------------------

create or replace function public.recompute_bias_distribution(p_since timestamptz)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed integer;
begin
  with votes as (
    select ca.cluster_id, s.bias
    from public.cluster_articles ca
    join public.clusters c on c.id = ca.cluster_id
    join public.articles a on a.id = ca.article_id
    join public.sources s on s.id = a.source_id
    where c.updated_at >= p_since
      and s.kind in ('outlet', 'wire')
  ),
  dists as (
    select
      c.id as cluster_id,
      -- Key list = BIAS_KEYS in blindspot.ts order; zone-parity.test.ts
      -- enforces it against jsonb_build_object's key literals below.
      pg_catalog.jsonb_build_object(
        'pro_government',        pg_catalog.count(v.bias) filter (where v.bias = 'pro_government'),
        'gov_leaning',           pg_catalog.count(v.bias) filter (where v.bias = 'gov_leaning'),
        'state_media',           pg_catalog.count(v.bias) filter (where v.bias = 'state_media'),
        'center',                pg_catalog.count(v.bias) filter (where v.bias = 'center'),
        'opposition_leaning',    pg_catalog.count(v.bias) filter (where v.bias = 'opposition_leaning'),
        'opposition',            pg_catalog.count(v.bias) filter (where v.bias = 'opposition'),
        'nationalist',           pg_catalog.count(v.bias) filter (where v.bias = 'nationalist'),
        'islamist_conservative', pg_catalog.count(v.bias) filter (where v.bias = 'islamist_conservative'),
        'pro_kurdish',           pg_catalog.count(v.bias) filter (where v.bias = 'pro_kurdish'),
        'international',         pg_catalog.count(v.bias) filter (where v.bias = 'international')
      ) as dist
    from public.clusters c
    left join votes v on v.cluster_id = c.id
    where c.updated_at >= p_since
    group by c.id
  )
  update public.clusters c
     set bias_distribution = d.dist
    from dists d
   where c.id = d.cluster_id
     and c.bias_distribution is distinct from d.dist;
  get diagnostics v_changed = row_count;
  return v_changed;
end;
$$;

comment on function public.recompute_bias_distribution(timestamptz) is
  'Re-derives clusters.bias_distribution from member articles whose source kind votes '
  '(outlet, wire — see supabase/functions/_shared/cluster/source-kind.ts) for clusters '
  'with updated_at >= p_since. Plain UPDATE, only rows that change, updated_at untouched. '
  'Call public.recompute_blindspot_flags() afterwards so the flags follow. Re-run after '
  'redeploying cluster-consumer — see docs/migration-guide.md.';

-- Supabase auto-grants EXECUTE to anon + authenticated on function
-- creation; name them explicitly in the revoke (revoking from public alone
-- leaves the role-direct grants and the RPC stays exposed via PostgREST).
revoke execute on function public.recompute_bias_distribution(timestamptz)
  from anon, authenticated, public;
grant execute on function public.recompute_bias_distribution(timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- 5) One-time backfill + flags recompute, in this order: bias_distribution
-- first (so the jsonb reflects voting-only members), then
-- recompute_blindspot_flags() so is_blindspot / blindspot_side are
-- re-derived from the just-updated distribution.
--
-- Scale note: production carries ~170k clusters; a 48h window is a few
-- thousand rows, fine as a single UPDATE. A full rebuild —
-- `select public.recompute_bias_distribution('1970-01-01');` — is possible
-- but should be run off-peak given the row count.
-- ---------------------------------------------------------------------------

select public.recompute_bias_distribution(pg_catalog.now() - interval '48 hours');
select public.recompute_blindspot_flags();

commit;
