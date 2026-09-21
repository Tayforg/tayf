-- 067_cluster_topics.sql
--
-- PACK C — "Konu" (B4): a real topic axis on clusters, and the FIRST
-- reader-facing use of TypeSafe Jev output anywhere in Tayf.
--
-- Everything before this migration kept Jev in shadow mode: migration 061's
-- three tables are service_role-only, and /admin is the single read surface.
-- This file crosses that line for exactly one field — a topic label on a
-- cluster — so the gates are deliberately stricter than anything the shadow
-- pipeline applies to itself:
--
--   * Only predictions whose own choice probability is >= 0.800 count as
--     evidence at all. A cluster member Jev is unsure about is not a vote,
--     it is silence. (The 2026-09-20 limits test scored 90.3% at this gate
--     for this question text asked TITLE-ONLY as one of SIX packed
--     questions. This pack sends title+description as one of SEVEN,
--     alongside the 3-way `topic` question; T8 measured a 10.0% answer-flip
--     rate for title+description on topic and T7 caps the safe pack at six
--     questions, so the drift of the shipped configuration has NOT been
--     measured. 0.800 is a confidence gate, not an accuracy claim.)
--   * A multi-member cluster needs >= 2 confident members AND >= 60% of
--     them agreeing on the same label. A 1-1 split labels nothing.
--   * A single-member cluster needs that one member at >= 0.900.
--   * Anything else writes topic7 = null. Null is the honest answer and is
--     rewritten on every pass, so a label never outlives its evidence.
--
-- Zero gateway calls: this is pure SQL over rows the jev-shadow Edge
-- Function already wrote and already paid for. The only cost this package
-- adds at the gateway is one extra question on the existing per-article
-- call (roughly +325 input tokens/article, measured post-deploy: 1265 avg
-- vs 941 pre-deploy; about 58M tokens/month at ~6,000 articles/day against
-- the 5e8 JEV_MONTHLY_TOKEN_CAP_DEFAULT cap -- ~12% of the cap, still
-- comfortable headroom, worth re-measuring once several days of ticks have
-- accumulated).
--
-- Additive only: two nullable columns, one integer column with a default,
-- one NOT VALID check constraint, one partial index, one new function, one
-- new cron job. No existing column, constraint, index, trigger, function or
-- job is altered or dropped. Safe to re-apply.
--
-- Deliberately NOT written by this migration: clusters.updated_at. That
-- column is the /api/health liveness signal (migration 027's
-- cluster_link_atomic stamps it with now() on every member write) and the
-- home feed's freshness input. cluster_topics_refresh() touches topic7,
-- topic7_p and topic7_n only, and its UPDATE carries an `is distinct from`
-- guard so a tick that changes nothing writes nothing.
--
-- Kill switch (no migration needed):
--   update cron.job set active = false where jobname = 'cluster-topics-refresh';
-- Followed by, if labels must disappear from the site immediately:
--   update public.clusters set topic7 = null, topic7_p = null, topic7_n = 0
--    where topic7 is not null;

begin;

-- ---------------------------------------------------------------------------
-- 1. Columns on public.clusters (additive)
-- ---------------------------------------------------------------------------

alter table public.clusters add column if not exists topic7 text;
alter table public.clusters add column if not exists topic7_p numeric(4,3);
alter table public.clusters add column if not exists topic7_n integer not null default 0;

comment on column public.clusters.topic7 is
  'Reader-facing topic label for /konu/<slug>, one of politika | dunya | '
  'ekonomi | spor | yasam | teknoloji | genel, or null when the cluster''s '
  'members did not clear the confidence + majority gates in '
  'public.cluster_topics_refresh(). Derived from jev_shadow_predictions '
  'rows with task = ''topic7'' (migration 061''s table, written by the '
  'jev-shadow Edge Function); the question text and the 7-label vocabulary '
  'live in supabase/functions/_shared/jev.ts (JEV_QUESTION_REGISTRY.topic7, '
  'JEV_TOPIC7_CHOICES). Rewritten on every refresh pass, including back to '
  'null — never sticky. politika is stored but has no hub page: /konu/politika '
  'permanently redirects to the home feed, which already IS the politics feed.';

comment on column public.clusters.topic7_p is
  'Mean Jev probability of the members that voted for the winning topic7 '
  'label, rounded to 3 decimals. Null exactly when topic7 is null. This is '
  'a confidence figure for the LABEL, not an accuracy claim about the '
  'classifier — see docs/metodoloji copy and the /konu page note.';

comment on column public.clusters.topic7_n is
  'How many of the cluster''s members had a topic7 prediction at or above '
  'the 0.800 confidence gate at the last refresh — i.e. the denominator the '
  'majority share was computed over, across ALL labels, not just the winner. '
  'Zero means no member cleared the gate (topic7 is then null). Kept even '
  'when topic7 is null so an operator can tell "no evidence" apart from '
  '"evidence, but split".';

-- Vocabulary guard. NOT VALID (migration 026''s precedent): every existing
-- row has topic7 null, so there is nothing to scan, and new writes are still
-- checked. cluster_topics_refresh() also filters the choice list in its own
-- WHERE clause, so an out-of-vocabulary answer from a future question-set
-- version is ignored rather than raising and killing the whole refresh —
-- this constraint is the second line of defence, not the first.
do $$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conrelid = 'public.clusters'::regclass
       and conname = 'clusters_topic7_check'
  ) then
    alter table public.clusters
      add constraint clusters_topic7_check
      check (
        topic7 is null
        or topic7 in ('politika', 'dunya', 'ekonomi', 'spor', 'yasam', 'teknoloji', 'genel')
      )
      not valid;
  end if;
end
$$;

-- Validate immediately: every existing row has topic7 null (see the
-- rationale above), so this scan is free, and leaving convalidated = false
-- indefinitely is not the point of NOT VALID here (it was only ever about
-- not taking a validate lock against pre-existing non-null data, which does
-- not exist). Safe to re-apply — validating an already-valid constraint is
-- a no-op.
alter table public.clusters validate constraint clusters_topic7_check;

-- ---------------------------------------------------------------------------
-- 2. Index — exactly the /konu/<slug> hub query
-- ---------------------------------------------------------------------------
--
-- src/lib/clusters/topic-query.ts issues:
--   .eq("is_archived", false).eq("topic7", <slug>)
--   .gte("updated_at", <7 days ago>).order("updated_at", desc)
--   .order("id", desc).range(...)
-- The partial predicate is implied by that query (topic7 = <slug> implies
-- topic7 is not null), so the index is usable for every hub page and stays
-- small: only labelled, live clusters are in it. The second sort key
-- (clusters.id desc) is a pagination tiebreak against rows that share an
-- updated_at timestamp (stamped by cluster_link_atomic); it is not part of
-- this index -- the planner walks the index in updated_at order and
-- finishes with an incremental sort on id.
create index if not exists clusters_topic7_updated_idx
  on public.clusters (topic7, updated_at desc)
  where topic7 is not null and is_archived = false;

-- ---------------------------------------------------------------------------
-- 3. The aggregation — SECURITY DEFINER, search_path = '' (AGENTS.md)
-- ---------------------------------------------------------------------------

create or replace function public.cluster_topics_refresh(
  p_since interval default interval '2 hours'
)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  -- Clamped so an operator backfill (`select public.cluster_topics_refresh(
  -- interval '30 days')`) is the widest pass this function will ever make,
  -- and a fat-fingered '10 years' cannot turn a 10-minute cron tick into a
  -- full-table sweep.
  v_since   interval := least(
                          coalesce(p_since, interval '2 hours'),
                          interval '30 days'
                        );
  v_updated integer  := 0;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('cluster_topics_refresh')::bigint) then
    raise notice 'cluster_topics_refresh: another pass holds the lock, skipping this run';
    return 0;
  end if;

  with windowed as (
    -- The only chunking mechanism, per the package spec: the clusters
    -- window. This query has no is_archived predicate, so migration 037's
    -- clusters_active_updated_idx (partial, where is_archived = false) does
    -- not apply; it is served by migration 003's unconditional
    -- idx_clusters_updated_at (updated_at desc) instead.
    select c.id             as cluster_id,
           c.article_count  as member_total
      from public.clusters c
     where c.updated_at >= pg_catalog.now() - v_since
  ),
  confident as (
    -- One row per (cluster, member) prediction that cleared the gate.
    -- Bound by the (article_id) partial index on jev_shadow_predictions and
    -- the (cluster_id, article_id) primary key on cluster_articles.
    select w.cluster_id,
           p.jev_choice as topic_choice,
           pr.member_p  as member_p
      from windowed w
      join public.cluster_articles ca
        on ca.cluster_id = w.cluster_id
      join public.jev_shadow_predictions p
        on p.article_id = ca.article_id
     cross join lateral (
       -- SQL does not define AND-conjunct evaluation order: a sibling guard
       -- ("is this a JSON number?") and the ::numeric cast it protects are
       -- NOT guaranteed to run guard-first when written as two AND
       -- conjuncts -- a plan change (ANALYZE, a new index, a PostgreSQL
       -- major upgrade) can put the cast first and raise 22P02 on a
       -- malformed or absent probabilities value. Per the Postgres docs,
       -- "if it is essential to force evaluation order, a CASE construct
       -- can be used" -- so the guard and the cast are one indivisible CASE
       -- expression here, not two AND conjuncts.
       select case
                when pg_catalog.jsonb_typeof(
                       p.jev_answer -> 'answer' -> 'probabilities' -> p.jev_choice
                     ) = 'number'
                then (p.jev_answer -> 'answer' -> 'probabilities' ->> p.jev_choice)::numeric
                else null
              end as member_p
     ) pr
     where p.task = 'topic7'
       and p.jev_choice is not null
       -- Vocabulary filter: ignore, never raise. A future question set that
       -- returns an unknown label must not take the refresh down.
       and p.jev_choice in ('politika', 'dunya', 'ekonomi', 'spor', 'yasam', 'teknoloji', 'genel')
       and pr.member_p >= 0.800
       and pr.member_p <= 1
  ),
  tallies as (
    select cluster_id,
           topic_choice,
           pg_catalog.count(*)::integer as vote_n,
           pg_catalog.avg(member_p)     as mean_p
      from confident
     group by cluster_id, topic_choice
  ),
  totals as (
    select cluster_id,
           pg_catalog.sum(vote_n)::integer as confident_n
      from tallies
     group by cluster_id
  ),
  leaders as (
    -- Deterministic winner: most votes, then highest mean probability, then
    -- alphabetical. The 60% majority gate below means a genuine tie never
    -- produces a label anyway; the ordering exists so the same input always
    -- yields the same output.
    select distinct on (t.cluster_id)
           t.cluster_id,
           t.topic_choice,
           t.vote_n,
           t.mean_p,
           x.confident_n
      from tallies t
      join totals x
        on x.cluster_id = t.cluster_id
     order by t.cluster_id, t.vote_n desc, t.mean_p desc, t.topic_choice asc
  ),
  decided as (
    select w.cluster_id,
           case
             when l.topic_choice is null then null
             when l.confident_n >= 2
              and (l.vote_n)::numeric / l.confident_n >= 0.600 then l.topic_choice
             -- Single-member cluster: one confident member at >= 0.900.
             -- confident_n = 1 is required as well as member_total = 1, so a
             -- stale article_count can never let a split vote through this
             -- branch.
             when w.member_total = 1
              and l.confident_n = 1
              and l.mean_p >= 0.900 then l.topic_choice
             else null
           end as topic_choice,
           case
             when l.topic_choice is null then null
             when l.confident_n >= 2
              and (l.vote_n)::numeric / l.confident_n >= 0.600 then pg_catalog.round(l.mean_p, 3)
             when w.member_total = 1
              and l.confident_n = 1
              and l.mean_p >= 0.900 then pg_catalog.round(l.mean_p, 3)
             else null
           end as topic_p,
           coalesce(l.confident_n, 0) as confident_n
      from windowed w
      left join leaders l
        on l.cluster_id = w.cluster_id
  ),
  applied as (
    update public.clusters c
       set topic7   = d.topic_choice,
           topic7_p = d.topic_p,
           topic7_n = d.confident_n
      from decided d
     where c.id = d.cluster_id
       -- No-op guard: a steady-state tick writes zero rows, so this function
       -- cannot churn the table, cannot bloat it, and cannot look like
       -- pipeline activity to anything watching write volume.
       and (c.topic7   is distinct from d.topic_choice
         or c.topic7_p is distinct from d.topic_p
         or c.topic7_n is distinct from d.confident_n)
    returning 1 as applied_flag
  )
  select pg_catalog.count(*)::integer
    into v_updated
    from applied;

  return v_updated;
end
$fn$;

comment on function public.cluster_topics_refresh(interval) is
  'Recomputes clusters.topic7 / topic7_p / topic7_n for every cluster '
  'updated within p_since (default 2 hours, clamped to 30 days), from '
  'jev_shadow_predictions rows with task = ''topic7''. A member counts as '
  'evidence only when its own choice probability is >= 0.800; a label is '
  'written when >= 60% of >= 2 confident members agree, or when a '
  'single-member cluster has its one confident member at >= 0.900; '
  'otherwise topic7 is set back to null. Returns the number of cluster rows '
  'actually changed (the UPDATE is guarded with IS DISTINCT FROM, so a tick '
  'that changes nothing returns 0). Never writes clusters.updated_at — that '
  'column is the /api/health liveness signal (migration 027). Makes zero '
  'gateway calls.';

revoke all on function public.cluster_topics_refresh(interval) from anon, authenticated, public;
grant execute on function public.cluster_topics_refresh(interval) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Schedule — SQL-only, no pg_net, no Vault
-- ---------------------------------------------------------------------------
--
-- Same shape as migration 043's reader-data-purge job: the whole body runs
-- inside Postgres, so unlike 061's jev-shadow poke there is nothing to call
-- out to and no secret to read. Guard on pg_cron with a NOTICE (never an
-- exception) so the file still applies on local Postgres, then
-- unschedule-by-name-if-exists before rescheduling, so re-applying converges
-- to one job.
--
-- '3-59/10 * * * *' fires at :03, :13, :23, :33, :43, :53 — three minutes
-- behind the '*/10' jev-shadow tick from migration 061, so each pass reads
-- predictions the shadow run has already committed instead of racing it.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    raise notice
      'pg_cron not installed — skipping cluster-topics-refresh schedule (067_cluster_topics.sql). '
      'Expected on local Postgres; apply on a project that has it.';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'cluster-topics-refresh') then
    perform cron.unschedule('cluster-topics-refresh');
  end if;

  perform cron.schedule(
    'cluster-topics-refresh',
    '3-59/10 * * * *',
    $sql$
      select public.cluster_topics_refresh();
    $sql$
  );
end
$$;

insert into supabase_migrations.schema_migrations (version, name)
  values ('067', '067_cluster_topics')
  on conflict do nothing;

commit;