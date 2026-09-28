-- 073_jev_pipeline_lifecycle.sql
--
-- "jev-pipeline" (2026-09-28): three independent fixes to the shadow
-- pipeline's operator-facing surfaces, none of which touch a reader path.
--
--   1. /konu window -- cluster_topics_refresh() (067) is untouched; only the
--      cron job's argument changes, from the default 2h to 36h, plus a
--      one-off 7-day catch-up so the hub fills up immediately instead of
--      waiting for the next 36h's worth of ticks to accumulate labels. p90
--      prediction lag measured 15.3h (2026-09-28 read-only check), so 36h
--      gives more than 2x headroom even if the newest-first pager (the
--      companion jev-shadow/index.ts change in this same PR) regresses.
--      The function is idempotent (`is distinct from`) and makes zero
--      gateway calls (067's own header), so widening its window costs one
--      extra scan, not one extra Jev call.
--   2. jev_alerts lifecycle -- alerts have never auto-cleared (065's
--      standing note). This migration adds resolved_at/resolved_reason and
--      a function, jev_alerts_auto_resolve(), that closes an alert once the
--      condition that raised it demonstrably passed: a KAP-canary alert
--      raised under a question set that no longer runs, or whose
--      disagreement rate has recovered on the next two comparable days; a
--      source-drift alert whose source stayed clean (not flagged, drift
--      score < 2.5) for the two UTC days right after the alert. Nothing is
--      ever deleted and acknowledged_at is never touched by this function.
--   3. jev_source_drift_compute() drops the sensational_mean term from its
--      drift_score (the 2026-09-20 eval measured 20% precision on that
--      signal) and now requires 2 CONSECUTIVE flagged UTC days before
--      raising a source_drift alert at all -- both without changing
--      source_drift_daily's stored row shape (sensational_mean is still
--      computed and stored, for the record).
--
-- Additive only: the one and only ALTER TABLE is on public.jev_alerts (two
-- nullable columns). No DROP, no TRUNCATE, no DELETE, no other ALTER TABLE.
-- Every SECURITY DEFINER function here sets search_path = ''.
--
-- Kill switches (no migration needed):
--   update cron.job set active = false where jobname = 'cluster-topics-refresh';
--   update cron.job set active = false where jobname = 'jev-signals-nightly';

begin;

-- ---------------------------------------------------------------------------
-- 1. /konu window: reschedule cluster-topics-refresh at 36h, then backfill
--    the 7-day hub window once so the change is visible immediately. The
--    function body from 067 is untouched.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron not installed — skipping cluster-topics-refresh reschedule (073)';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'cluster-topics-refresh') then
    perform cron.unschedule('cluster-topics-refresh');
  end if;

  perform cron.schedule(
    'cluster-topics-refresh',
    '3-59/10 * * * *',
    $sql$ select public.cluster_topics_refresh(interval '36 hours'); $sql$
  );
end
$$;

-- One-off: refill the 7-day /konu hub window now, rather than waiting for
-- the widened cron window to accumulate labels tick by tick.
select public.cluster_topics_refresh(interval '7 days');

-- ---------------------------------------------------------------------------
-- 2. jev_alerts lifecycle columns.
-- ---------------------------------------------------------------------------

alter table public.jev_alerts
  add column if not exists resolved_at timestamptz,
  add column if not exists resolved_reason text;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'jev_alerts_resolved_reason_check'
  ) then
    alter table public.jev_alerts
      add constraint jev_alerts_resolved_reason_check
      check (
        (resolved_at is null and resolved_reason is null)
        or (resolved_at is not null and resolved_reason in (
          'question_set_changed', 'agreement_recovered', 'drift_quiet'
        ))
      );
  end if;
end
$$;

comment on column public.jev_alerts.resolved_at is
  'Null means the condition that raised this alert has not (yet) been '
  'demonstrated to have passed. Set once by jev_alerts_auto_resolve(), '
  'never cleared, and orthogonal to acknowledged_at: an operator can '
  'acknowledge an alert that later auto-resolves, or vice versa. Nothing '
  'ever deletes a jev_alerts row -- this column replaces "delete the row" '
  'with "mark why it no longer needs attention".';

comment on column public.jev_alerts.resolved_reason is
  'One of question_set_changed | agreement_recovered | drift_quiet -- the '
  'literal list is duplicated as JEV_ALERT_RESOLVED_REASONS in '
  'src/lib/admin/jev-signals.ts and pinned against this CHECK by '
  'tests/migrations/073-jev-pipeline-lifecycle.test.ts. Null exactly when '
  'resolved_at is null (see jev_alerts_resolved_reason_check).';

create index if not exists jev_alerts_open_idx
  on public.jev_alerts (created_at desc)
  where acknowledged_at is null and resolved_at is null;

-- Deliberately keeping 065's jev_alerts_unacked_idx (acknowledged_at is
-- null, no resolved_at predicate) alongside this one rather than dropping
-- it here: this migration's own header promises no DROP of any kind, and
-- the table is tiny today (~13 rows) so the redundancy costs nothing
-- observable yet. The status page's open-alerts read
-- (src/lib/admin/jev-signals.ts) now matches jev_alerts_open_idx above;
-- the ack route (POST /api/admin/jev-alerts/ack) updates by primary key
-- and doesn't need either index. Once jev_alerts_open_idx is confirmed as
-- the only read path that benefits, drop jev_alerts_unacked_idx in a
-- dedicated later migration.

comment on table public.jev_alerts is
  'Operator alerts raised by the nightly signal functions (migration 065). '
  'unique (kind, day, subject) is also the idempotency key both writers '
  'insert against with ON CONFLICT DO NOTHING, so a re-run of a day -- a '
  'manual backfill, a cron redelivery -- never duplicates an alert and '
  'never resurrects one the operator already acknowledged. service_role- '
  'only. Acknowledged only by POST /api/admin/jev-alerts/ack behind '
  'hasAdminSession(). As of migration 073, an alert can also auto-resolve '
  '(resolved_at/resolved_reason, written only by '
  'jev_alerts_auto_resolve()) once the condition that raised it '
  'demonstrably passed -- but nothing ever deletes a row here, '
  'acknowledged and resolved are both permanent, independent, additive '
  'facts about a row that always exists.';

-- ---------------------------------------------------------------------------
-- 3. Redefine jev_source_drift_compute(): drop the rejected sensational
--    signal from drift_score, and require 2 consecutive flagged UTC days
--    before an alert is raised at all. Copied verbatim from 065 lines
--    234-466 with exactly three edits, marked "073:" below.
-- ---------------------------------------------------------------------------

create or replace function public.jev_source_drift_compute(
  p_day date default ((now() at time zone 'utc')::date - 1)
)
returns table (
  rows_computed bigint,
  rows_flagged bigint
)
language sql
volatile
security definer
set search_path = ''
as $fn$
  with day_rows as materialized (
    select
      a.source_id  as src,
      p.task       as task,
      p.jev_prob   as prob,
      p.jev_choice as choice
    from public.jev_shadow_predictions p
    join public.articles a on a.id = p.article_id
    where p.task in ('politics', 'clickbait', 'sensational', 'topic')
      and p.created_at >= (p_day::timestamp at time zone 'utc')
      and p.created_at <  ((p_day + 1)::timestamp at time zone 'utc')
      and a.source_id is not null
  ),
  day_agg as (
    select
      d.src,
      count(*) filter (where d.task = 'politics' and d.prob is not null)::int
        as politics_n,
      count(*) filter (where d.task = 'clickbait' and d.prob is not null)::int
        as clickbait_n,
      count(*) filter (where d.task = 'sensational' and d.prob is not null)::int
        as sensational_n,
      round(
        avg((case when d.prob >= 0.700 then 1 else 0 end)::numeric)
          filter (where d.task = 'politics' and d.prob is not null),
        3
      ) as politics_share,
      round(
        avg(d.prob) filter (where d.task = 'clickbait' and d.prob is not null),
        3
      ) as clickbait_mean,
      round(
        (avg(d.prob) filter (where d.task = 'sensational' and d.prob is not null)) / 3.0,
        3
      ) as sensational_mean
    from day_rows d
    group by d.src
  ),
  topic_counts as (
    select d.src, d.choice as choice, count(*)::numeric as c
    from day_rows d
    where d.task = 'topic' and d.choice is not null
    group by d.src, d.choice
  ),
  topic_totals as (
    select t.src, sum(t.c) as total_c
    from topic_counts t
    group by t.src
  ),
  topic_mix as (
    select
      t.src,
      jsonb_object_agg(t.choice, round(t.c / tt.total_c, 3)) as mix
    from topic_counts t
    join topic_totals tt on tt.src = t.src
    group by t.src
  ),
  base_rows as materialized (
    select
      a.source_id as src,
      p.task      as task,
      p.jev_prob  as prob,
      ((p.created_at at time zone 'utc')::date) as obs_day
    from public.jev_shadow_predictions p
    join public.articles a on a.id = p.article_id
    where p.task in ('politics', 'clickbait', 'sensational')
      and p.created_at >= ((p_day - 14)::timestamp at time zone 'utc')
      and p.created_at <  (p_day::timestamp at time zone 'utc')
      and a.source_id is not null
      and p.jev_prob is not null
  ),
  base_daily as (
    select
      b.src,
      b.obs_day,
      count(*) filter (where b.task = 'politics')::int as politics_n,
      avg((case when b.prob >= 0.700 then 1 else 0 end)::numeric)
        filter (where b.task = 'politics') as politics_share,
      avg(b.prob) filter (where b.task = 'clickbait')   as clickbait_mean,
      (avg(b.prob) filter (where b.task = 'sensational')) / 3.0
        as sensational_mean
    from base_rows b
    group by b.src, b.obs_day
  ),
  base_agg as (
    select
      d.src,
      sum(d.politics_n)::bigint       as base_n,
      count(*) filter (where d.politics_n > 0)::int as base_days,
      avg(d.politics_share)           as base_politics_share,
      stddev_samp(d.politics_share)   as sd_politics_share,
      avg(d.clickbait_mean)           as base_clickbait_mean,
      stddev_samp(d.clickbait_mean)   as sd_clickbait_mean,
      avg(d.sensational_mean)         as base_sensational_mean,
      stddev_samp(d.sensational_mean) as sd_sensational_mean
    from base_daily d
    group by d.src
  ),
  computed as materialized (
    select
      s.id                as source_id,
      s.slug              as source_slug,
      s.name              as source_name,
      da.politics_n       as day_n,
      da.politics_share   as politics_share,
      da.clickbait_mean   as clickbait_mean,
      da.sensational_mean as sensational_mean,
      coalesce(tm.mix, '{}'::jsonb) as topic_mix,
      ba.base_n           as base_n,
      ba.base_days        as base_days,
      round(ba.base_politics_share, 3)              as base_politics_share,
      round(ba.base_clickbait_mean, 3)              as base_clickbait_mean,
      round(ba.base_sensational_mean, 3)            as base_sensational_mean,
      round(coalesce(ba.sd_politics_share, 0), 4)   as sd_politics_share,
      round(coalesce(ba.sd_clickbait_mean, 0), 4)   as sd_clickbait_mean,
      round(coalesce(ba.sd_sensational_mean, 0), 4) as sd_sensational_mean,
      -- greatest() ignores null arguments. politics is always non-null here
      -- (day_agg.politics_n >= 20 and base_agg.base_n >= 60 are already
      -- gated above), so greatest() can never return null. The clickbait
      -- term is additionally count-gated at >= 20 same-task predictions
      -- that day: a thin term (e.g. 1 clickbait row alongside 25 politics
      -- rows) contributes NULL and is dropped, rather than swinging the
      -- score off a single-row mean.
      -- 073 (a): the sensational term is deleted here -- the 2026-09-20
      -- eval measured 20% precision for sensational_mean as a drift
      -- signal. sensational_mean itself is still computed above and still
      -- stored in the row and in baseline, for the record only.
      round(
        greatest(
          abs(da.politics_share - ba.base_politics_share)
            / greatest(coalesce(ba.sd_politics_share, 0), 0.05),
          case when da.clickbait_n >= 20 then
            abs(da.clickbait_mean - ba.base_clickbait_mean)
              / greatest(coalesce(ba.sd_clickbait_mean, 0), 0.05)
          end
        ),
        2
      ) as drift_score
    from day_agg da
    join public.sources s on s.id = da.src and s.active
    join base_agg ba on ba.src = da.src
    left join topic_mix tm on tm.src = da.src
    where da.politics_n >= 20
      and ba.base_n >= 60
  ),
  scored as materialized (
    select
      c.*,
      (
        coalesce(c.drift_score, 0) >= 3
        or coalesce(abs(c.politics_share - c.base_politics_share), 0) >= 0.250
      ) as flagged
    from computed c
  ),
  upserted as (
    insert into public.source_drift_daily (
      source_id, day, n, politics_share, clickbait_mean, sensational_mean,
      topic_mix, baseline, drift_score, flagged, computed_at
    )
    select
      x.source_id,
      p_day,
      x.day_n,
      x.politics_share,
      x.clickbait_mean,
      x.sensational_mean,
      x.topic_mix,
      jsonb_build_object(
        'n', x.base_n,
        'days', x.base_days,
        'politics_share', x.base_politics_share,
        'politics_sd', x.sd_politics_share,
        'clickbait_mean', x.base_clickbait_mean,
        'clickbait_sd', x.sd_clickbait_mean,
        'sensational_mean', x.base_sensational_mean,
        'sensational_sd', x.sd_sensational_mean
      ),
      x.drift_score,
      x.flagged,
      now()
    from scored x
    on conflict (source_id, day) do update set
      n                = excluded.n,
      politics_share   = excluded.politics_share,
      clickbait_mean   = excluded.clickbait_mean,
      sensational_mean = excluded.sensational_mean,
      topic_mix        = excluded.topic_mix,
      baseline         = excluded.baseline,
      drift_score      = excluded.drift_score,
      flagged          = excluded.flagged,
      computed_at      = now()
    returning 1
  ),
  -- 073 (b): an alert now needs the source flagged on p_day AND on p_day -
  -- 1 -- two consecutive flagged UTC days -- not a single noisy day.
  alerted as (
    insert into public.jev_alerts (kind, day, subject, payload)
    select
      'source_drift',
      p_day,
      x.source_id::text,
      -- 073 (c): the two sensational_* keys are dropped; two new keys
      -- record the consecutive-day evidence the alert now requires.
      jsonb_build_object(
        'source_slug', x.source_slug,
        'source_name', x.source_name,
        'n', x.day_n,
        'drift_score', x.drift_score,
        'politics_share', x.politics_share,
        'baseline_politics_share', x.base_politics_share,
        'clickbait_mean', x.clickbait_mean,
        'baseline_clickbait_mean', x.base_clickbait_mean,
        'topic_mix', x.topic_mix,
        'previous_day_drift_score', prev.drift_score,
        'consecutive_days', 2
      )
    from scored x
    join public.source_drift_daily prev
      on prev.source_id = x.source_id
      and prev.day = p_day - 1
      and prev.flagged
    where x.flagged
    on conflict (kind, day, subject) do nothing
    returning 1
  )
  select
    (select count(*) from upserted)::bigint as rows_computed,
    (select count(*) from scored sc where sc.flagged)::bigint as rows_flagged;
$fn$;

comment on function public.jev_source_drift_compute(date) is
  'Computes one source_drift_daily row per active source with >= 20 '
  'task=''politics'' predictions on p_day (default: yesterday, UTC) whose '
  'daily label mix drifted from its own trailing-14-day baseline. A row is '
  'flagged when drift_score >= 3 or |politics_share delta| >= 0.250; '
  'drift_score (migration 073) is the greatest of the politics and '
  'clickbait z-like terms only -- the sensational term was dropped after '
  'the 2026-09-20 eval measured 20% precision for it, though '
  'sensational_mean itself is still stored on the row and in baseline, for '
  'the record. A jev_alerts row of kind ''source_drift'' is raised '
  '(migration 073) only when the source was ALSO flagged on p_day - 1 -- '
  'two consecutive flagged UTC days -- one noisy day no longer alerts on '
  'its own. NOTE: the first nightly run after this migration compares '
  'against a p_day - 1 row that may have been computed under the OLD '
  '(sensational-inclusive) score -- accepted, since the comparison is on '
  '`flagged`, a boolean, not on the score value itself.';

-- ---------------------------------------------------------------------------
-- 4. jev_alerts_auto_resolve(): closes alerts whose raising condition has
--    demonstrably passed. Never writes acknowledged_at, never deletes.
-- ---------------------------------------------------------------------------

create or replace function public.jev_alerts_auto_resolve(
  p_day date default ((pg_catalog.now() at time zone 'utc')::date - 1)
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_current_qs text;
  v_rows integer;
  v_total integer := 0;
begin
  select p.jev_answer ->> 'question_set'
    into v_current_qs
    from public.jev_shadow_predictions p
   where p.task = 'kap_class'
     and p.created_at < ((p_day + 1)::timestamp at time zone 'utc')
   order by p.created_at desc
   limit 1;

  -- (a) canary raised under a question set that no longer runs.
  if v_current_qs is not null then
    with alert_qs as (
      select
        a.id,
        coalesce(
          a.payload ->> 'question_set',
          (
            select p.jev_answer ->> 'question_set'
              from public.jev_shadow_predictions p
             where p.task = 'kap_class'
               and p.created_at >= (a.day::timestamp at time zone 'utc')
               and p.created_at < ((a.day + 1)::timestamp at time zone 'utc')
             group by 1
             order by pg_catalog.count(*) desc, 1
             limit 1
          )
        ) as qs
      from public.jev_alerts a
      where a.kind = 'kap_class_canary'
        and a.acknowledged_at is null
        and a.resolved_at is null
        and a.day <= p_day
    )
    update public.jev_alerts a
       set resolved_at = pg_catalog.now(),
           resolved_reason = 'question_set_changed'
      from alert_qs q
     where a.id = q.id
       and q.qs is not null
       and q.qs <> v_current_qs;
    get diagnostics v_rows = row_count;
    v_total := v_total + v_rows;
  end if;

  -- (b) agreement recovered: the 2 most recent comparable days (kap_n >=
  -- 10) in [p_day-6, p_day] are both under threshold and both after the
  -- alert day (weekend-safe: KAP is quiet on Sat/Sun).
  with recent as (
    select d.day, s.kap_n, s.over_threshold
      from (select (p_day - g)::date as day from pg_catalog.generate_series(0, 6) g) d
      cross join lateral public.jev_kap_canary_status(d.day) s
     where s.kap_n >= 10
     order by d.day desc
     limit 2
  ),
  verdict as (
    select
      pg_catalog.count(*) = 2
        and coalesce(pg_catalog.bool_and(not r.over_threshold), false) as ok,
      pg_catalog.min(r.day) as oldest
    from recent r
  )
  update public.jev_alerts a
     set resolved_at = pg_catalog.now(),
         resolved_reason = 'agreement_recovered'
    from verdict v
   where v.ok
     and a.kind = 'kap_class_canary'
     and a.acknowledged_at is null
     and a.resolved_at is null
     and a.day < v.oldest;
  get diagnostics v_rows = row_count;
  v_total := v_total + v_rows;

  -- (c) drift quiet for the 2 UTC days after the alert day, and the
  -- nightly job actually ran on day+2.
  update public.jev_alerts a
     set resolved_at = pg_catalog.now(),
         resolved_reason = 'drift_quiet'
   where a.kind = 'source_drift'
     and a.acknowledged_at is null
     and a.resolved_at is null
     and a.day + 2 <= p_day
     and exists (
       -- Proof the nightly job ran (for this source) on day+1 -- without
       -- this, a skipped/failed run on day+1 makes the NOT EXISTS clean
       -- check below vacuously true for that day, silently treating
       -- "unknown" as "quiet".
       select 1 from public.source_drift_daily d1
        where d1.source_id::text = a.subject
          and d1.day = a.day + 1
     )
     and exists (
       select 1 from public.source_drift_daily d2
        where d2.day = a.day + 2
     )
     and not exists (
       select 1 from public.source_drift_daily d
        where d.source_id::text = a.subject
          and d.day > a.day
          and d.day <= a.day + 2
          and (d.flagged or coalesce(d.drift_score, 0) >= 2.5)
     );
  get diagnostics v_rows = row_count;
  v_total := v_total + v_rows;

  return v_total;
end
$fn$;

revoke all on function public.jev_alerts_auto_resolve(date) from anon, authenticated, public;
grant execute on function public.jev_alerts_auto_resolve(date) to service_role;

comment on function public.jev_alerts_auto_resolve(date) is
  'Closes jev_alerts rows (resolved_at/resolved_reason) whose raising '
  'condition has demonstrably passed, for p_day (default: yesterday, '
  'UTC): (a) a kap_class_canary alert raised under a question set that no '
  'longer runs (resolved_reason = question_set_changed); (b) a '
  'kap_class_canary alert whose disagreement rate recovered on the next '
  'two comparable (kap_n >= 10) days (agreement_recovered); (c) a '
  'source_drift alert whose source stayed clean (not flagged, drift_score '
  '< 2.5) for the two UTC days right after the alert day, once the '
  'nightly job has actually run on day+2 (drift_quiet). Never writes '
  'acknowledged_at and never deletes a row -- resolved is an independent, '
  'permanent fact layered on top of the existing acknowledge workflow. '
  'subject is compared as text (d.source_id::text = a.subject), never '
  'cast to uuid, because subject is TEXT and a malformed value must never '
  'abort this job. Called nightly by the jev-signals-nightly cron job '
  '(migration 065, rescheduled by 073) and once, one-off, by this '
  'migration itself.';

-- ---------------------------------------------------------------------------
-- 5. Reschedule jev-signals-nightly to also run auto-resolve.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron not installed — skipping jev-signals-nightly reschedule (073)';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'jev-signals-nightly') then
    perform cron.unschedule('jev-signals-nightly');
  end if;

  perform cron.schedule('jev-signals-nightly', '05 4 * * *', $sql$
    select public.jev_source_drift_compute();
    select public.jev_kap_canary_compute();
    select public.jev_alerts_auto_resolve();
  $sql$);
end
$$;

-- ---------------------------------------------------------------------------
-- 6. One-off: resolve the currently stale alerts with the same logic.
--    p_day = TODAY on purpose, so today's kap_class rows count as a
--    comparable day (26-27 Sep are a weekend and likely have kap_n < 10).
-- ---------------------------------------------------------------------------

do $$
declare
  v integer;
begin
  v := public.jev_alerts_auto_resolve((pg_catalog.now() at time zone 'utc')::date);
  raise notice '073: auto-resolved % stale jev_alerts row(s)', v;
end
$$;

insert into supabase_migrations.schema_migrations (version, name)
  values ('073', '073_jev_pipeline_lifecycle')
  on conflict do nothing;

commit;
