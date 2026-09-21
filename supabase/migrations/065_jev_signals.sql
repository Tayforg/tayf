-- 065_jev_signals.sql
--
-- "Sinyaller" paketi (2026-09-21). Four zero-cost measurements built on the
-- predictions 061/063 already write. Nothing here makes a single gateway
-- call: every number below is computed in SQL from rows that exist.
--
-- What lands here:
--   1. public.source_drift_daily -- per-source, per-day label distribution
--      against that source's trailing 14-day baseline. "This outlet's feed
--      changed shape" is the signal; it is NOT a bias judgement and it is
--      NOT reader-facing.
--   2. public.jev_alerts -- one row per (kind, day, subject) the operator
--      should look at. Acknowledged from /admin, never auto-cleared.
--   3. public.jev_source_drift_compute() / public.jev_kap_canary_compute()
--      -- the two nightly writers.
--   4. public.jev_kap_canary_status() -- the STABLE, write-free twin of the
--      canary arithmetic. /admin/ekonomi renders from this one: a page
--      render must never insert an alert row as a side effect.
--   5. public.kap_disclosure_signals_for(bigint[]) -- materiality level +
--      class agreement for a bounded batch of disclosure indexes. A
--      SECURITY DEFINER function rather than a view on purpose: a view over
--      the service_role-only jev_shadow_predictions table would need
--      security_invoker = false to be readable, which is exactly the
--      "accidental public read surface" shape this codebase refuses.
--   6. The 'jev-signals-nightly' pg_cron job at 04:05 UTC. SQL-ONLY (the
--      043_reader_data_purge_cron.sql shape): no Edge Function, no pg_net,
--      no Vault bearer, because the job body never leaves Postgres.
--
-- AGREEMENT IS NOT ACCURACY (061's standing note) applies here too: the KAP
-- canary measures disagreement with the KAP-declared class, which is the
-- baseline, not ground truth. A rising disagreement rate means "look", not
-- "Jev is wrong" and not "KAP is wrong".
--
-- Additive only: no existing table, column, constraint, policy, index,
-- trigger, function or cron job is altered or dropped. Safe to re-apply
-- (create table if not exists, create index if not exists, create or
-- replace function, idempotent cron reschedule, ledger insert on conflict
-- do nothing).
--
-- Kill switch (no migration, no deploy):
--   update cron.job set active = false where jobname = 'jev-signals-nightly';

begin;

-- ---------------------------------------------------------------------------
-- 1. Per-source daily drift.
-- ---------------------------------------------------------------------------

create table if not exists public.source_drift_daily (
  source_id uuid not null references public.sources(id) on delete cascade,
  day date not null,
  n int not null default 0,
  politics_share numeric(4,3),
  clickbait_mean numeric(4,3),
  sensational_mean numeric(4,3),
  topic_mix jsonb,
  baseline jsonb,
  drift_score numeric(6,2),
  flagged boolean not null default false,
  computed_at timestamptz not null default now(),
  primary key (source_id, day)
);

comment on table public.source_drift_daily is
  'One row per (active source, UTC day) with at least 20 task=''politics'' '
  'shadow predictions that day, written by public.jev_source_drift_compute() '
  '(migration 065). Measures how far a source''s DAILY label distribution '
  'sits from its own trailing 14-day baseline -- a feed-shape change '
  'detector, not a bias verdict. service_role-only; no page outside the '
  'cookie-gated /admin reads it. The primary key leads with source_id, so it '
  'also serves the on delete cascade FK back to public.sources and no extra '
  'FK index is needed.';

comment on column public.source_drift_daily.day is
  'The UTC day the underlying predictions were WRITTEN (task=''politics'' '
  'p.created_at), not the archive''s publication day -- deliberately so, '
  'since drift is a shadow-prediction-throughput measure, not an archive '
  'concept. A jev-shadow pause or catch-up run concentrates a backlog of '
  'predictions into one day bucket and can inflate that day''s n and topic '
  'mix; an operator seeing every source flag together on one day should '
  'read that as a pipeline-pause artefact, not real fleet-wide drift.';

comment on column public.source_drift_daily.n is
  'Count of task=''politics'' predictions for this source on this day with a '
  'non-null jev_prob. The gate is n >= 20: below that a day''s share is '
  'noise, and the row is simply not written.';

comment on column public.source_drift_daily.politics_share is
  'Share of the day''s politics predictions with jev_prob >= 0.700. The 0.7 '
  'cut is the stricter of the two thresholds 063''s scorecard reports, '
  'chosen here because drift wants a confident-positive rate, not a '
  'coin-flip rate.';

comment on column public.source_drift_daily.sensational_mean is
  'Mean task=''sensational'' jev_prob divided by 3.0. That question is a '
  '4-level score question (JEV_QUESTION_REGISTRY.sensational.criteria has '
  'four entries in supabase/functions/_shared/jev.ts), so the raw score runs '
  '0..3 and the divisor is levels - 1 = 3. tests/migrations/'
  'jev-signals-parity.test.ts pins the two together.';

comment on column public.source_drift_daily.topic_mix is
  'jsonb object of task=''topic'' jev_choice -> share of that day''s topic '
  'answers, rounded to 3 places. Recorded for the operator''s eye only: it '
  'is NOT one of the three scalar measures the drift score is taken over, '
  'because a distribution distance needs a baseline shape this table does '
  'not yet carry.';

comment on column public.source_drift_daily.baseline is
  'The trailing 14-day window [day-14, day) this row was scored against: '
  '{n, days, politics_share, politics_sd, clickbait_mean, clickbait_sd, '
  'sensational_mean, sensational_sd}. `n` is the politics-prediction count '
  'over the whole window and must be >= 60 for the row to be written at all; '
  'each *_sd is the sample standard deviation of the DAILY values in the '
  'window (null for a single-day window, stored as 0).';

comment on column public.source_drift_daily.drift_score is
  'max over the three scalar measures of |day - baseline| / '
  'greatest(baseline_sd, 0.05). The 0.05 floor is what stops a source whose '
  'baseline happened to be perfectly flat from scoring an infinite drift on '
  'a one-article wobble.';

comment on column public.source_drift_daily.flagged is
  'drift_score >= 3 OR |politics_share - baseline politics_share| >= 0.250. '
  'The second clause is an absolute-magnitude backstop: a source can move a '
  'quarter of its feed in or out of politics with a wide enough baseline sd '
  'to keep the z-like score under 3.';

create index if not exists source_drift_daily_day_idx
  on public.source_drift_daily (day desc);

-- The /admin "Kaynak sapması" section only ever wants flagged rows, newest
-- first, bounded to the last 7 days. Partial so it stays small no matter how
-- many unflagged rows accumulate.
create index if not exists source_drift_daily_flagged_idx
  on public.source_drift_daily (day desc)
  where flagged;

-- ---------------------------------------------------------------------------
-- 2. Alerts.
-- ---------------------------------------------------------------------------

create table if not exists public.jev_alerts (
  id bigserial primary key,
  kind text not null
    check (kind in ('source_drift', 'kap_class_canary')),
  day date not null,
  subject text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  unique (kind, day, subject)
);

comment on table public.jev_alerts is
  'Operator alerts raised by the nightly signal functions (migration 065). '
  'unique (kind, day, subject) is also the idempotency key both writers '
  'insert against with ON CONFLICT DO NOTHING, so a re-run of a day -- a '
  'manual backfill, a cron redelivery -- never duplicates an alert and never '
  'resurrects one the operator already acknowledged. service_role-only. '
  'Acknowledged only by POST /api/admin/jev-alerts/ack behind '
  'hasAdminSession(); nothing ever deletes a row here.';

comment on column public.jev_alerts.kind is
  'source_drift (one source''s day drifted from its own 14-day baseline) | '
  'kap_class_canary (the day''s kap_class disagreement rate crossed 10%). '
  'The literal list is duplicated as JEV_ALERT_KINDS in '
  'src/lib/admin/jev-signals.ts and pinned against this CHECK by '
  'tests/migrations/jev-signals-parity.test.ts. Unlike '
  'jev_shadow_predictions.task this IS a CHECK constraint: an alert kind the '
  '/admin UI has no Turkish label for would render as a raw identifier to '
  'the one person who has to act on it.';

comment on column public.jev_alerts.subject is
  'What the alert is about, as text: sources.id::text for source_drift, the '
  'day itself (p_day::text) for kap_class_canary. Deliberately text and '
  'deliberately not a foreign key -- an alert about a source must survive '
  'that source being deleted, because the deletion may be the very thing '
  'worth looking at.';

comment on column public.jev_alerts.acknowledged_at is
  'Null means the alert is still in the /admin queue. Set once, never '
  'cleared; the ack route writes it only where acknowledged_at is null, so '
  'a double-click cannot rewrite the original acknowledgement time.';

-- The /admin queue: unacknowledged only, newest first. Partial so the index
-- shrinks back down as the operator works through the queue.
create index if not exists jev_alerts_unacked_idx
  on public.jev_alerts (created_at desc)
  where acknowledged_at is null;

create index if not exists jev_alerts_kind_day_idx
  on public.jev_alerts (kind, day desc);

-- ---------------------------------------------------------------------------
-- 3. RLS + grants -- service_role only, the same shell as 059/060/061/063.
-- ---------------------------------------------------------------------------

alter table public.source_drift_daily enable row level security;
alter table public.jev_alerts enable row level security;

revoke all on public.source_drift_daily from anon, authenticated, public;
revoke all on public.jev_alerts from anon, authenticated, public;

-- source_drift_daily needs update for the per-day upsert; jev_alerts needs
-- update for the /admin acknowledgement. Neither grants delete.
grant select, insert, update on public.source_drift_daily to service_role;
grant select, insert, update on public.jev_alerts to service_role;

-- bigserial needs its sequence granted separately (061's precedent).
revoke all on sequence public.jev_alerts_id_seq from anon, authenticated, public;
grant usage, select on sequence public.jev_alerts_id_seq to service_role;

-- ---------------------------------------------------------------------------
-- 4. P9 -- per-source feed drift. Zero gateway calls.
-- ---------------------------------------------------------------------------
--
-- Bounding, in order, because this runs over ~15 days of predictions:
--   * every scan is bounded by a half-open created_at range, served by
--     jev_shadow_predictions_task_created_idx (task, created_at desc) with
--     an IN list of at most four tasks;
--   * articles is joined by primary key, never scanned;
--   * the baseline is aggregated per (source, day) once and then reduced,
--     so stddev_samp sees 14 values per source, not 14 days of rows.
-- At 5k articles/day this touches roughly 225k prediction rows and finishes
-- in single-digit seconds. It runs from pg_cron, not PostgREST, so the 8s
-- authenticator statement_timeout does not apply -- but the shape is kept
-- inside it anyway so an operator can call it by hand from the SQL editor.
--
-- The two data-modifying CTEs (upserted, alerted) both read `scored`.
-- Postgres executes a data-modifying WITH clause exactly once and always to
-- completion, whether or not the primary query reads its output, so
-- `alerted` runs even though the final select only counts `upserted` and
-- `scored`.
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
      -- gated above), so greatest() can never return null. The clickbait and
      -- sensational terms are additionally count-gated at >= 20 same-task
      -- predictions that day: a thin term (e.g. 1 clickbait row alongside 25
      -- politics rows) contributes NULL and is dropped, rather than swinging
      -- the score off a single-row mean.
      round(
        greatest(
          abs(da.politics_share - ba.base_politics_share)
            / greatest(coalesce(ba.sd_politics_share, 0), 0.05),
          case when da.clickbait_n >= 20 then
            abs(da.clickbait_mean - ba.base_clickbait_mean)
              / greatest(coalesce(ba.sd_clickbait_mean, 0), 0.05)
          end,
          case when da.sensational_n >= 20 then
            abs(da.sensational_mean - ba.base_sensational_mean)
              / greatest(coalesce(ba.sd_sensational_mean, 0), 0.05)
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
  alerted as (
    insert into public.jev_alerts (kind, day, subject, payload)
    select
      'source_drift',
      p_day,
      x.source_id::text,
      jsonb_build_object(
        'source_slug', x.source_slug,
        'source_name', x.source_name,
        'n', x.day_n,
        'drift_score', x.drift_score,
        'politics_share', x.politics_share,
        'baseline_politics_share', x.base_politics_share,
        'clickbait_mean', x.clickbait_mean,
        'baseline_clickbait_mean', x.base_clickbait_mean,
        'sensational_mean', x.sensational_mean,
        'baseline_sensational_mean', x.base_sensational_mean,
        'topic_mix', x.topic_mix
      )
    from scored x
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
  'trailing 14-day baseline carries >= 60 politics predictions, and inserts '
  'a jev_alerts row of kind ''source_drift'' for each flagged source. '
  'Returns (rows_computed, rows_flagged). Idempotent per day: the upsert '
  'rewrites the day''s row and the alert insert is ON CONFLICT DO NOTHING, '
  'so re-running never duplicates an alert or un-acknowledges one. Makes '
  'zero gateway calls -- every number comes from rows 061/063 already wrote.';

-- ---------------------------------------------------------------------------
-- 5. P11 -- KAP class canary. Write-free twin first, then the writer.
-- ---------------------------------------------------------------------------

-- STABLE and write-free on purpose: /admin/ekonomi renders the canary status
-- line from this function, and a page render must never insert an alert row
-- as a side effect of being looked at.
create or replace function public.jev_kap_canary_status(
  p_day date default ((now() at time zone 'utc')::date - 1)
)
returns table (
  kap_n bigint,
  disagreements bigint,
  disagreement_rate numeric,
  over_threshold boolean
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select
    count(*) filter (where p.agree is not null)::bigint as kap_n,
    count(*) filter (where p.agree = false)::bigint     as disagreements,
    round(
      count(*) filter (where p.agree = false)::numeric
        / nullif(count(*) filter (where p.agree is not null), 0),
      3
    ) as disagreement_rate,
    (
      count(*) filter (where p.agree is not null) >= 10
      and coalesce(
        count(*) filter (where p.agree = false)::numeric
          / nullif(count(*) filter (where p.agree is not null), 0),
        0
      ) >= 0.10
    ) as over_threshold
  from public.jev_shadow_predictions p
  where p.task = 'kap_class'
    and p.created_at >= (p_day::timestamp at time zone 'utc')
    and p.created_at <  ((p_day + 1)::timestamp at time zone 'utc');
$fn$;

comment on function public.jev_kap_canary_status(date) is
  'Write-free KAP class canary reading for p_day (default: yesterday, UTC). '
  'The denominator is comparable rows only (agree is not null) -- 061''s '
  'standing rule that an agreement rate is never taken over count(*). '
  'over_threshold is true when kap_n >= 10 AND the disagreement rate is >= '
  '0.10; it says an alert is WARRANTED, not that one exists (the writer '
  'below inserts ON CONFLICT DO NOTHING). Called by /admin/ekonomi; '
  'public.jev_kap_canary_compute() calls it so the arithmetic lives once.';

create or replace function public.jev_kap_canary_compute(
  p_day date default ((now() at time zone 'utc')::date - 1)
)
returns table (
  kap_n bigint,
  disagreements bigint,
  disagreement_rate numeric,
  over_threshold boolean
)
language sql
volatile
security definer
set search_path = ''
as $fn$
  with status_row as materialized (
    select s.kap_n, s.disagreements, s.disagreement_rate, s.over_threshold
    from public.jev_kap_canary_status(p_day) s
  ),
  sample_rows as materialized (
    select coalesce(
             jsonb_agg(to_jsonb(x.subject_id) order by x.subject_id),
             '[]'::jsonb
           ) as examples
    from (
      select p.subject_id
      from public.jev_shadow_predictions p
      where p.task = 'kap_class'
        and p.agree = false
        and p.created_at >= (p_day::timestamp at time zone 'utc')
        and p.created_at <  ((p_day + 1)::timestamp at time zone 'utc')
      -- subject_id is text, so this is an ARBITRARY lexicographic sample of
      -- at most five disagreements, not the numerically lowest five.
      order by p.subject_id
      limit 5
    ) x
  ),
  alerted as (
    insert into public.jev_alerts (kind, day, subject, payload)
    select
      'kap_class_canary',
      p_day,
      p_day::text,
      jsonb_build_object(
        'n', r.kap_n,
        'disagreements', r.disagreements,
        'rate', r.disagreement_rate,
        'examples', e.examples
      )
    from status_row r
    cross join sample_rows e
    where r.over_threshold
    on conflict (kind, day, subject) do nothing
    returning 1
  )
  select r.kap_n, r.disagreements, r.disagreement_rate, r.over_threshold
  from status_row r;
$fn$;

comment on function public.jev_kap_canary_compute(date) is
  'Raises a jev_alerts row of kind ''kap_class_canary'' when p_day (default: '
  'yesterday, UTC) carried >= 10 comparable task=''kap_class'' predictions '
  'and at least 10% of them disagreed with the KAP-declared class. payload '
  'carries {n, disagreements, rate, examples} where examples is up to five '
  'disclosure_index values (jev_shadow_predictions.subject_id for a KAP '
  'task IS kap_disclosures.disclosure_index, as text). subject is the day '
  'itself, so at most one canary alert can ever exist per day. Returns the '
  'same shape as jev_kap_canary_status(), whose arithmetic it reuses.';

-- ---------------------------------------------------------------------------
-- 6. P11 -- materiality for a bounded batch of disclosures.
-- ---------------------------------------------------------------------------
--
-- A SECURITY DEFINER function, NOT a view: a view over the service_role-only
-- jev_shadow_predictions table would have to be created with
-- security_invoker = false to be readable at all, which silently turns the
-- view into a read surface on a table this codebase keeps locked down. A
-- function has an explicit, revocable ACL and a bounded input.
--
-- Input is clamped to the first 200 indexes. Each element does two index
-- lookups against the unique (task, subject_id) constraint from 061, so the
-- worst case is 400 index probes -- comfortably inside PostgREST's 8s
-- statement_timeout, which DOES apply here (this is called per admin page
-- render, unlike the nightly functions above).
create or replace function public.kap_disclosure_signals_for(
  p_indexes bigint[]
)
returns table (
  disclosure_index bigint,
  materiality numeric,
  materiality_level text,
  class_agree boolean,
  question_set text
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select
    d.idx as disclosure_index,
    m.jev_prob as materiality,
    case
      when m.jev_prob is null then null
      when m.jev_prob < 1 then 'düşük'
      when m.jev_prob < 2 then 'orta'
      else 'yüksek'
    end as materiality_level,
    c.agree as class_agree,
    coalesce(
      m.jev_answer ->> 'question_set',
      c.jev_answer ->> 'question_set'
    ) as question_set
  from unnest((coalesce(p_indexes, '{}'::bigint[]))[1:200]) as d(idx)
  left join public.jev_shadow_predictions m
    on m.task = 'kap_materiality'
   and m.subject_id = d.idx::text
  left join public.jev_shadow_predictions c
    on c.task = 'kap_class'
   and c.subject_id = d.idx::text;
$fn$;

comment on function public.kap_disclosure_signals_for(bigint[]) is
  'Jev materiality level and class agreement for up to 200 '
  'kap_disclosures.disclosure_index values, one output row per input index '
  '(nulls when that disclosure has no shadow prediction yet). materiality is '
  'the raw task=''kap_materiality'' jev_prob, a 4-level score running 0..3 '
  '(JEV_QUESTION_REGISTRY.kap_materiality.criteria has four entries in '
  'supabase/functions/_shared/jev.ts); materiality_level cuts it at '
  '''düşük'' (< 1), ''orta'' (< 2), ''yüksek'' (>= 2). question_set is the '
  'stamp the prediction was made under, so a level rendered from a retired '
  'question set is identifiable. Read only by the cookie-gated '
  '/admin/ekonomi page -- /ekonomi is unchanged and shows no model-derived '
  'label to any reader.';

-- ---------------------------------------------------------------------------
-- 7. Function ACLs (a table-level revoke does not cover functions).
-- ---------------------------------------------------------------------------

revoke all on function public.jev_source_drift_compute(date) from anon, authenticated, public;
revoke all on function public.jev_kap_canary_compute(date) from anon, authenticated, public;
revoke all on function public.jev_kap_canary_status(date) from anon, authenticated, public;
revoke all on function public.kap_disclosure_signals_for(bigint[]) from anon, authenticated, public;

grant execute on function public.jev_source_drift_compute(date) to service_role;
grant execute on function public.jev_kap_canary_compute(date) to service_role;
grant execute on function public.jev_kap_canary_status(date) to service_role;
grant execute on function public.kap_disclosure_signals_for(bigint[]) to service_role;

-- ---------------------------------------------------------------------------
-- 8. Schedule -- 04:05 UTC nightly, SQL-ONLY.
--
--    This is the 043_reader_data_purge_cron.sql shape, not 060/061/063's:
--    the job body calls two SQL functions and never leaves Postgres, so it
--    guards on pg_cron alone -- no pg_net extension check, no Vault secret
--    check, no bearer, no Edge Function, no HTTP. The trade-off is that a
--    failure surfaces only in cron.job_run_details, never in Sentry (which
--    is wired into the Deno Edge Functions, not into Postgres).
--
--    04:05 UTC is a free slot: kap-corrections-daily 03:15, archive-export
--    03:40, jev-cluster-audit 03:55, prune-nightly 04:10, alias-prune 04:20,
--    bars-5m-prune 04:25, reader-data-purge 04:40. source_drift_daily.day is
--    the UTC day the underlying PREDICTIONS WERE WRITTEN, not the archive's
--    publication day (jev-shadow's 24h-lookback article stage means
--    predictions written on day D cover articles published on D and D-1), so
--    the 04:05 slot is chosen for contention reasons alone, not to sit after
--    a feed the archive has already frozen.
--
--    Kill switch (no migration needed):
--      update cron.job set active = false where jobname = 'jev-signals-nightly';
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron not installed — skipping jev-signals-nightly schedule (065_jev_signals.sql). Expected on local Postgres; apply on a project that has it.';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'jev-signals-nightly') then
    perform cron.unschedule('jev-signals-nightly');
  end if;

  perform cron.schedule('jev-signals-nightly', '05 4 * * *', $sql$
    select public.jev_source_drift_compute();
    select public.jev_kap_canary_compute();
  $sql$);
end
$$;

insert into supabase_migrations.schema_migrations (version, name)
  values ('065', '065_jev_signals')
  on conflict do nothing;

commit;
