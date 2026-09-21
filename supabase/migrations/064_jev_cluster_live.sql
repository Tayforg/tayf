-- 064_jev_cluster_live.sql
--
-- "Jev canlı küme" paketi (2026-09-21) — the third Jev migration. 061 made
-- Jev answer the questions the live pipeline already answers and stored both
-- answers side by side; 063 added human ground truth and the nightly audit.
-- This file is the first one that lets a Jev answer CHANGE something, and it
-- does so on the narrowest possible surface: the two score bands where the
-- ensemble clusterer is already admitting it is unsure.
--
-- What lands here:
--   1. public.clusters gains two additive columns —
--      blindspot_recall_suspect (boolean, default false) and
--      blindspot_recall_checked_at (timestamptz, null) — written ONLY by the
--      jev-shadow Edge Function's new 'blindspot_recall' stage. No reader
--      surface reads them: /blindspots is untouched by this migration, and
--      src/lib/clusters/blindspots-query.ts recomputes is_blindspot live
--      from members anyway. They exist so /admin can list clusters whose
--      "kör nokta" verdict Jev thinks is a clustering miss rather than an
--      editorial silence.
--   2. public.jev_unlink_candidates — the outlier-ejection queue. One row
--      per (cluster, article) pair Jev scored below 0.35 on the
--      'cluster_member' question. service_role-only (RLS on, no policies,
--      explicit revoke from anon/authenticated/public + sequence grants —
--      the same shell as 041/057/059/060/061/063). Nothing is ever unlinked
--      automatically: a human presses "Ayır" on /admin.
--   3. public.cluster_unlink_article(uuid, uuid) — the SECURITY DEFINER RPC
--      that performs that unlink. It is the mirror image of
--      public.cluster_link_atomic (migration 027): same per-cluster
--      advisory lock, same "recompute under the lock" discipline,
--      same "clusters.updated_at is stamped server-side" rule. Unlike the
--      link RPC it recomputes bias_distribution / is_blindspot /
--      blindspot_side / first_published IN SQL rather than trusting a
--      caller-supplied snapshot, because its caller is a Next.js admin
--      route that has no cluster context loaded. Those SQL copies of the
--      bias->zone map and the blindspot rule are hand-duplicated from
--      supabase/functions/_shared/cluster/blindspot.ts exactly the way
--      migrations 023/031/032/034 already duplicate them, and
--      tests/migrations/zone-parity.test.ts is extended to pin this file
--      too (it fails on any undeclared fifth copy).
--   4. The jev_shadow_predictions.task / subject_id COMMENTs gain the two
--      new task names ('pair_marginal', 'blindspot_recall'). The task
--      column is deliberately CHECK-free, so a new shadow question still
--      needs no migration; only the comment (and its parity test) moves.
--
-- A cluster is NEVER deleted by this migration's code path. If the last
-- member is unlinked the cluster row survives with article_count = 0 —
-- existing singleton semantics, and the only behaviour the reader queries
-- (which all filter on article_count) already handle.
--
-- No new cron job: the 'blindspot_recall' stage rides the existing
-- 'jev-shadow' */10 cron (migration 061), and the live marginal
-- verification rides the existing 'cluster-drain' cron. Nothing here
-- schedules anything.
--
-- Additive only: no existing table, column, constraint, policy, index,
-- trigger or cron job is dropped or altered. The two ALTER TABLEs on
-- public.clusters are `add column if not exists` with a constant DEFAULT,
-- which Postgres 11+ applies as a catalog-only change (no table rewrite,
-- no long ACCESS EXCLUSIVE hold) even at the ~170k-row production size.
-- Safe to re-apply.
--
-- Kill switches (no migration, no deploy):
--   supabase secrets unset JEV_LIVE_PAIRS      -- live marginal verification off
--   supabase secrets set JEV_DISABLED=1        -- the whole jev-shadow run off
--   update cron.job set active = false where jobname = 'jev-shadow';
--   update cron.job set active = false where jobname = 'jev-cluster-audit';

begin;

-- DB-04: bound the ALTER TABLEs' ACCESS EXCLUSIVE lock below (held until
-- COMMIT, across both index builds that follow on a ~170k-row table under
-- live cluster-consumer writes) instead of letting it queue indefinitely
-- behind an in-flight read -- same precedent as 058_finance_hardening.sql's
-- `set local lock_timeout = '5s';`.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. clusters: two additive columns for the blindspot recall check.
-- ---------------------------------------------------------------------------

alter table public.clusters
  add column if not exists blindspot_recall_suspect boolean not null default false;

alter table public.clusters
  add column if not exists blindspot_recall_checked_at timestamptz;

comment on column public.clusters.blindspot_recall_suspect is
  'True when the jev-shadow ''blindspot_recall'' stage (migration 064) found '
  'at least one article from the SILENT media zone that Jev says reports the '
  'same event as this cluster — i.e. the "kör nokta" verdict is more likely a '
  'clustering miss than an editorial silence. Shadow signal only: no reader '
  'surface reads this column, /blindspots is unchanged, and nothing '
  'automatically clears the is_blindspot flag. Surfaced on /admin under '
  '"Şüpheli kör noktalar" so a human can look.';

comment on column public.clusters.blindspot_recall_checked_at is
  'When the ''blindspot_recall'' stage last examined this cluster (migration '
  '064). Written on every check, suspect or not. The per-day anti-join key '
  'lives in jev_shadow_predictions (task ''blindspot_recall'', subject_id '
  '"<clusterId>:<YYYY-MM-DD>"), not here — this column is for the admin '
  'listing and for spotting a stage that has silently stopped running.';

-- Serves the stage''s driver query: recently-updated blindspot clusters.
create index if not exists clusters_blindspot_recall_idx
  on public.clusters (updated_at desc)
  where is_blindspot;

-- Serves /admin''s "Şüpheli kör noktalar" listing (last 7 days).
create index if not exists clusters_blindspot_suspect_idx
  on public.clusters (blindspot_recall_checked_at desc)
  where blindspot_recall_suspect;

-- ---------------------------------------------------------------------------
-- 2. The outlier-ejection queue.
-- ---------------------------------------------------------------------------

create table if not exists public.jev_unlink_candidates (
  id bigserial primary key,
  cluster_id uuid not null references public.clusters(id) on delete cascade,
  article_id uuid not null references public.articles(id) on delete cascade,
  jev_prob numeric(4,3) not null,
  source_task text not null check (source_task in ('cluster_member', 'audit')),
  status text not null default 'pending' check (status in ('pending', 'unlinked', 'kept')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (cluster_id, article_id)
);

comment on table public.jev_unlink_candidates is
  'Cluster members Jev scored as NOT belonging to their cluster (migration '
  '064). Written by the jev-shadow Edge Function whenever a '
  'task=''cluster_member'' prediction comes back below 0.35, and decided by a '
  'human on /admin ("Küme dışı adaylar") through POST /api/admin/jev-unlink. '
  'Nothing is ever unlinked automatically. unique (cluster_id, article_id) is '
  'the idempotency key the writer upserts against with ignoreDuplicates, so a '
  're-ask of the same member never resurrects a row a human already decided. '
  'service_role-only; nothing published anywhere.';

comment on column public.jev_unlink_candidates.jev_prob is
  'The Jev probability that this article DOES report the cluster''s event — '
  'so LOW is suspicious. Copied from jev_shadow_predictions.jev_prob at '
  'emit time; the prediction row remains the audit trail.';

comment on column public.jev_unlink_candidates.source_task is
  'Which shadow question produced this candidate. ''cluster_member'' is the '
  'only value written by migration 064''s code. ''audit'' is reserved for a '
  'later pass over the nightly pair_positive recall sample and is accepted by '
  'the CHECK today so adding it needs no migration.';

comment on column public.jev_unlink_candidates.status is
  'pending -> a human has not decided. unlinked -> '
  'public.cluster_unlink_article() removed the membership row (it sets this, '
  'inside the same transaction as the delete). kept -> a human pressed '
  '"Kalsın"; the row stays for measurement and never reappears in the queue.';

create index if not exists jev_unlink_candidates_pending_idx
  on public.jev_unlink_candidates (jev_prob, created_at desc)
  where status = 'pending';

-- FK index: article_id is `on delete cascade` against a table the admin
-- "nuke_articles" action truncates wholesale; without this the RI trigger
-- sequentially scans this table per deleted row (the 061 lesson).
create index if not exists jev_unlink_candidates_article_idx
  on public.jev_unlink_candidates (article_id);

-- ---------------------------------------------------------------------------
-- 3. RLS + grants — service_role only, same shell as 061/063.
-- ---------------------------------------------------------------------------

alter table public.jev_unlink_candidates enable row level security;

revoke all on public.jev_unlink_candidates from anon, authenticated, public;

grant select, insert, update on public.jev_unlink_candidates to service_role;

revoke all on sequence public.jev_unlink_candidates_id_seq from anon, authenticated, public;
grant usage, select on sequence public.jev_unlink_candidates_id_seq to service_role;

-- ---------------------------------------------------------------------------
-- 4. The unlink RPC — the mirror image of cluster_link_atomic (027).
--
-- Contract:
--   * pg_advisory_xact_lock(hashtext(cluster_id::text)) FIRST — the SAME key
--     cluster_link_atomic takes, so a concurrent cluster-consumer link and an
--     admin unlink on one cluster serialize against each other instead of
--     racing on article_count.
--   * DELETE the membership row (0 rows deleted is fine — the recompute still
--     runs, the "Round-6 P1" discipline from 027: never short-circuit on an
--     idempotency guess and leave the aggregates stale).
--   * Recount members under the lock, recompute bias_distribution from
--     VOTING source kinds only (outlet, wire — see
--     supabase/functions/_shared/cluster/source-kind.ts, same filter
--     public.recompute_bias_distribution uses), re-derive is_blindspot /
--     blindspot_side under the contract in
--     supabase/functions/_shared/cluster/blindspot.ts (minSources 5,
--     dominantShare 0.8), re-derive first_published from the surviving
--     members, stamp updated_at = now().
--   * Mark the queue row decided, in the same transaction.
--   * Return the new article_count.
--
-- A cluster that drops to 0 members KEEPS its row (existing singleton
-- semantics) and keeps its old first_published; this function never deletes
-- a cluster.
-- ---------------------------------------------------------------------------

create or replace function public.cluster_unlink_article(
  p_cluster_id uuid,
  p_article_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_count integer;
  v_dist jsonb;
  v_total integer;
  v_zone_n integer;
  v_dominant_zone text;
  v_dominant_category text;
  v_is_blindspot boolean;
  v_first_published timestamptz;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_cluster_id::text));

  delete from public.cluster_articles ca
   where ca.cluster_id = p_cluster_id
     and ca.article_id = p_article_id;

  select pg_catalog.count(*)::int
    into v_count
    from public.cluster_articles ca
   where ca.cluster_id = p_cluster_id;

  -- bias_distribution over the surviving members, voting kinds only. Key
  -- list = BIAS_KEYS in blindspot.ts order; tests/migrations/zone-parity.test.ts
  -- enforces the array literal further down against the same contract.
  with votes as (
    select s.bias as bias_key
      from public.cluster_articles ca
      join public.articles a on a.id = ca.article_id
      join public.sources s on s.id = a.source_id
     where ca.cluster_id = p_cluster_id
       and s.kind in ('outlet', 'wire')
  )
  select pg_catalog.jsonb_build_object(
    'pro_government',        pg_catalog.count(v.bias_key) filter (where v.bias_key = 'pro_government'),
    'gov_leaning',           pg_catalog.count(v.bias_key) filter (where v.bias_key = 'gov_leaning'),
    'state_media',           pg_catalog.count(v.bias_key) filter (where v.bias_key = 'state_media'),
    'center',                pg_catalog.count(v.bias_key) filter (where v.bias_key = 'center'),
    'opposition_leaning',    pg_catalog.count(v.bias_key) filter (where v.bias_key = 'opposition_leaning'),
    'opposition',            pg_catalog.count(v.bias_key) filter (where v.bias_key = 'opposition'),
    'nationalist',           pg_catalog.count(v.bias_key) filter (where v.bias_key = 'nationalist'),
    'islamist_conservative', pg_catalog.count(v.bias_key) filter (where v.bias_key = 'islamist_conservative'),
    'pro_kurdish',           pg_catalog.count(v.bias_key) filter (where v.bias_key = 'pro_kurdish'),
    'international',         pg_catalog.count(v.bias_key) filter (where v.bias_key = 'international')
  )
    into v_dist
    from votes v;

  -- Zone tally over the freshly built distribution. Zone CASE copied
  -- verbatim from BIAS_TO_ZONE in
  -- supabase/functions/_shared/cluster/blindspot.ts (the same copy
  -- migration 032 carries). Keep in sync — zone-parity.test.ts enforces it.
  with counts as (
    select
      e.bias_key as bias_key,
      (e.bias_count)::int as n,
      case e.bias_key
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
    from pg_catalog.jsonb_each_text(v_dist) as e(bias_key, bias_count)
    where e.bias_key in (
      'pro_government', 'gov_leaning', 'state_media', 'center',
      'opposition_leaning', 'opposition', 'nationalist',
      'islamist_conservative', 'pro_kurdish', 'international'
    )
      and (e.bias_count)::int > 0
  ),
  totals as (
    select coalesce(pg_catalog.sum(c.n), 0)::int as total_n
      from counts c
  ),
  zone_totals as (
    select c.zone as zone, pg_catalog.sum(c.n)::int as zone_n
      from counts c
     group by c.zone
  ),
  dominant as (
    -- Ties break by ZONE_KEYS order, mirroring tallyZones()''s iteration
    -- order in blindspot.ts (only reachable when the share cannot reach 0.8).
    select zt.zone as dominant_zone, zt.zone_n as zone_n
      from zone_totals zt
     order by
       zt.zone_n desc,
       pg_catalog.array_position(array['iktidar', 'bagimsiz', 'muhalefet'], zt.zone)
     limit 1
  ),
  category_rank as (
    select
      c.bias_key as bias_key,
      pg_catalog.row_number() over (
        order by
          c.n desc,
          -- BIAS_KEYS order, copied verbatim from blindspot.ts.
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
    join dominant d on c.zone = d.dominant_zone
  )
  select
    t.total_n,
    d.zone_n,
    d.dominant_zone,
    (select cr.bias_key from category_rank cr where cr.rn = 1)
    into v_total, v_zone_n, v_dominant_zone, v_dominant_category
    from totals t
    left join dominant d on true;

  -- BLINDSPOT.minSources = 5, BLINDSPOT.dominantShare = 0.8.
  v_is_blindspot := coalesce(v_total, 0) >= 5
    and v_dominant_zone is not null
    and coalesce(v_zone_n, 0)::numeric / nullif(v_total, 0) >= 0.8;

  if v_count > 0 then
    select pg_catalog.min(a.published_at)
      into v_first_published
      from public.cluster_articles ca
      join public.articles a on a.id = ca.article_id
     where ca.cluster_id = p_cluster_id;
  end if;

  update public.clusters c
     set article_count   = v_count,
         bias_distribution = v_dist,
         is_blindspot    = v_is_blindspot,
         blindspot_side  = case when v_is_blindspot then v_dominant_category else null end,
         first_published = coalesce(v_first_published, c.first_published),
         updated_at      = pg_catalog.now()
   where c.id = p_cluster_id;

  update public.jev_unlink_candidates u
     set status = 'unlinked',
         decided_at = pg_catalog.now()
   where u.cluster_id = p_cluster_id
     and u.article_id = p_article_id
     and u.status = 'pending';

  return v_count;
end;
$fn$;

comment on function public.cluster_unlink_article(uuid, uuid) is
  'Removes one article from one cluster under the SAME per-cluster advisory '
  'lock public.cluster_link_atomic takes, then recomputes article_count, '
  'bias_distribution (voting source kinds only), is_blindspot / '
  'blindspot_side (the contract in '
  'supabase/functions/_shared/cluster/blindspot.ts) and first_published from '
  'the surviving members, stamps updated_at = now(), and marks the matching '
  'public.jev_unlink_candidates row ''unlinked''. Returns the new '
  'article_count. NEVER deletes a cluster: a cluster whose last member is '
  'removed survives with article_count = 0. Called only by POST '
  '/api/admin/jev-unlink behind hasAdminSession().';

-- Supabase auto-grants EXECUTE to anon + authenticated on function creation;
-- name them explicitly in the revoke (revoking from public alone leaves the
-- role-direct grants and the RPC stays exposed via PostgREST).
revoke all on function public.cluster_unlink_article(uuid, uuid) from anon, authenticated, public;
grant execute on function public.cluster_unlink_article(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5. The task vocabulary gains two names (comment only — task is
--    deliberately CHECK-free so a new shadow question needs no migration).
-- ---------------------------------------------------------------------------

comment on column public.jev_shadow_predictions.task is
  'Question id: politics | topic | opinion | clickbait | framing | '
  'sensational | cluster_member | pair_negative | pair_positive | '
  'ticker_relevance | neutral_pick | kap_class | kap_materiality | '
  'title_meaning | title_edit_kind | pair_marginal | blindspot_recall. The '
  'vocabulary lives in supabase/functions/_shared/jev.ts (JEV_TASKS) and is '
  'parity-tested against this comment in '
  'tests/migrations/jev-shadow-parity.test.ts. Deliberately NOT a CHECK '
  'constraint: adding a shadow question must not require a migration during '
  'the testing period. Added by 064: pair_marginal (the LIVE marginal-band '
  'verification the cluster-consumer Edge Function asks before joining or '
  'creating a cluster — the only Jev task whose answer can change what a '
  'reader sees, and the only one written with run_id null, since it is not '
  'produced by a jev-shadow run), blindspot_recall (did the SILENT media '
  'zone actually publish this event — baseline ''false'', i.e. the system '
  'says the zone is silent).';

comment on column public.jev_shadow_predictions.subject_id is
  'Stable text key of the thing judged: articles.id for article tasks, '
  '"<clusterId>:<articleId>" for cluster_member, "<idA>:<idB>" with the two '
  'uuids sorted lexicographically for pair_negative and pair_positive (so '
  'the same unordered pair can never be scored twice under one task), '
  'kap_disclosures.disclosure_index for KAP tasks, '
  'article_title_versions.id::text for title tasks, "<articleId>:<TICKER>" '
  'for ticker_relevance, clusters.id for neutral_pick, and — added by 064 — '
  '"<articleId>:<clusterId>" (UNSORTED, article first) for pair_marginal, '
  'plus TWO shapes for blindspot_recall: "<clusterId>:<articleId>" for a '
  'candidate headline and "<clusterId>:<YYYY-MM-DD>" for the per-day marker '
  'row that makes the stage''s anti-join hold even when a cluster had zero '
  'candidates that day.';

insert into supabase_migrations.schema_migrations (version, name)
  values ('064', '064_jev_cluster_live')
  on conflict do nothing;

commit;
