-- 088_jev_spend_ledger.sql  (JEV-A: spend ledger + KAP sampling support + 073 compatibility)
--
-- SQL half of JEV-A. The Deno half (_shared/jev.ts + jev-shadow/index.ts) writes
-- jev_shadow_runs.stage_tokens and stamps jev_answer.question_hash / .pack.
-- DEPENDS ON 073 (wave 1). Order: 073 -> 088 -> deploy jev-shadow -> deploy Vercel.
-- No question-set bump. No reader path touched. No DROP of any table/column.
begin;
set local lock_timeout = '5s';

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'jev_alerts' and column_name = 'resolved_at')
     or not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public' and p.proname = 'jev_alerts_auto_resolve') then
    raise exception '088 requires 073 (jev_alerts.resolved_at + jev_alerts_auto_resolve) to be applied first';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Per-stage spend ledger on the run row.
-- ---------------------------------------------------------------------------
alter table public.jev_shadow_runs
  add column if not exists stage_tokens jsonb not null default '{}'::jsonb;
comment on column public.jev_shadow_runs.stage_tokens is
  '{"<stage>": {"calls": n, "tokens": n}} written at every recordTokens checkpoint and at finishRun (088). '
  'Keys: StageName in shadow mode, "<mode>:<stage>" in audit/regression mode. Pre-088 rows carry ''{}'' '
  'and are reported as stage ''unattributed'' by jev_budget_daily().';

-- ---------------------------------------------------------------------------
-- 2. Monthly cap also counts live cluster-consumer pair_marginal calls
--    (run_id null; one row per call today -- 1,092 rows / 460,478 tokens in Sep 2026).
-- ---------------------------------------------------------------------------
create or replace function public.jev_shadow_month_usage(p_cap bigint default 500000000)
returns table (runs bigint, calls bigint, input_tokens bigint, cap bigint, exceeded boolean)
language sql
stable
security definer
set search_path = ''
as $fn$
  with m as (
    select (pg_catalog.date_trunc('month', (pg_catalog.now() at time zone 'utc')) at time zone 'utc') as start_at
  ),
  r as (
    select pg_catalog.count(*)::bigint as n_runs,
           coalesce(pg_catalog.sum(x.calls), 0)::bigint as n_calls,
           coalesce(pg_catalog.sum(x.input_tokens), 0)::bigint as n_tokens
      from public.jev_shadow_runs x, m
     where x.started_at >= m.start_at
  ),
  live as (
    select pg_catalog.count(*)::bigint as n_calls,
           coalesce(pg_catalog.sum(p.input_tokens), 0)::bigint as n_tokens
      from public.jev_shadow_predictions p, m
     where p.task = 'pair_marginal' and p.run_id is null and p.created_at >= m.start_at
  )
  select r.n_runs, r.n_calls + live.n_calls, r.n_tokens + live.n_tokens, p_cap,
         (r.n_tokens + live.n_tokens) >= p_cap
    from r, live;
$fn$;
comment on function public.jev_shadow_month_usage(bigint) is
  'Month-to-date Jev spend (UTC month): every jev_shadow_runs row plus live cluster-consumer pair_marginal '
  'calls (run_id null, one row per call) (088). Default cap hand-duplicated against '
  'JEV_MONTHLY_TOKEN_CAP_DEFAULT (JEV-A16). Side scripts that bypass jev-shadow (the 2026-09-21 topic7 '
  'backfill, 6,328,716 tokens) stay invisible here -- run any future re-score through a jev-shadow mode.';

-- ---------------------------------------------------------------------------
-- 3. Per-stage daily allowances (alert line, not a hard stop).
-- ---------------------------------------------------------------------------
create table if not exists public.jev_stage_budgets (
  stage        text primary key,
  daily_tokens bigint not null check (daily_tokens > 0),
  note         text
);
comment on table public.jev_stage_budgets is
  'Daily token allowance per jev-shadow stage (088). Crossing it raises one jev_alerts row (kind stage_budget); '
  'the monthly cap stays the only hard stop. Seeded at ~1.5x the measured 22-27 Sep 2026 per-stage mean '
  '(per-call dedupe). Retune by UPDATE; later specs raise ''articles'' when their prompt cost lands.';
insert into public.jev_stage_budgets (stage, daily_tokens, note) values
  ('articles',                      11000000, 'measured 7.33M/day = 6,008 calls x 1,221 (22-27 Sep)'),
  ('clusters',                        800000, 'measured 0.39M/day'),
  ('blindspot_recall',                100000, 'measured 0.02M/day'),
  ('pairs',                           700000, 'shadow pair_negative, measured ~0.47M/day'),
  ('kap',                             800000, 'sampled: ~943 tokens/disclosure; 678-disclosure day ~0.64M'),
  ('title_versions',                  200000, 'measured 0.08M/day'),
  ('tickers',                         200000, 'measured 0.07M/day'),
  ('audit:pairs',                     150000, 'nightly audit, measured ~0.08M'),
  ('audit:audit_pairs',               150000, 'nightly audit, measured ~0.07M'),
  ('regression:regression_articles', 1200000, '660 frozen articles x ~1,221 after the 088 runbook freeze'),
  ('regression:regression_pairs',     100000, '60 frozen pairs, ~0.01M'),
  ('live_pair_marginal',              150000, 'cluster-consumer live path, measured ~0.066M/day')
on conflict (stage) do nothing;
alter table public.jev_stage_budgets enable row level security;
revoke all on public.jev_stage_budgets from anon, authenticated, public;
grant select, insert, update on public.jev_stage_budgets to service_role;

create or replace function public.jev_budget_daily(p_days integer default 14)
returns table (day date, stage text, calls bigint, tokens bigint, allowance bigint)
language sql
stable
security definer
set search_path = ''
as $fn$
  with w as (
    select ((pg_catalog.now() at time zone 'utc')::date - least(greatest(coalesce(p_days, 14), 1), 62) + 1) as d0
  ),
  staged as (
    select (r.started_at at time zone 'utc')::date as d, e.key as st,
           coalesce((e.value ->> 'calls')::bigint, 0) as c,
           coalesce((e.value ->> 'tokens')::bigint, 0) as t
      from public.jev_shadow_runs r
     cross join w
     cross join lateral pg_catalog.jsonb_each(r.stage_tokens) e
     where r.started_at >= (w.d0::timestamp at time zone 'utc')
  ),
  legacy as (
    select (r.started_at at time zone 'utc')::date as d, 'unattributed'::text as st,
           coalesce(r.calls, 0)::bigint as c, coalesce(r.input_tokens, 0)::bigint as t
      from public.jev_shadow_runs r
     cross join w
     where r.started_at >= (w.d0::timestamp at time zone 'utc')
       and r.stage_tokens = '{}'::jsonb
  ),
  live as (
    select (p.created_at at time zone 'utc')::date as d, 'live_pair_marginal'::text as st,
           1::bigint as c, coalesce(p.input_tokens, 0)::bigint as t
      from public.jev_shadow_predictions p
     cross join w
     where p.task = 'pair_marginal' and p.run_id is null
       and p.created_at >= (w.d0::timestamp at time zone 'utc')
  ),
  u as (select * from staged union all select * from legacy union all select * from live)
  select u.d, u.st, pg_catalog.sum(u.c)::bigint, pg_catalog.sum(u.t)::bigint, b.daily_tokens
    from u
    left join public.jev_stage_budgets b on b.stage = u.st
   group by u.d, u.st, b.daily_tokens
   order by u.d desc, pg_catalog.sum(u.t) desc;
$fn$;
comment on function public.jev_budget_daily(integer) is
  'Per-UTC-day, per-stage Jev spend for the last p_days (1..62) days (088): runs.stage_tokens, '
  '''unattributed'' for pre-088 run rows, ''live_pair_marginal'' for cluster-consumer calls; allowance from '
  'jev_stage_budgets (null when none). Per day, sum(tokens) = sum(jev_shadow_runs.input_tokens) + live.';

-- ---------------------------------------------------------------------------
-- 4. jev_alerts: new kind 'stage_budget' and new resolved_reason 'under_allowance'.
--    073's resolved_reason CHECK allows only its three reasons; without this
--    widening the first auto-resolve UPDATE below aborts the whole nightly call.
-- ---------------------------------------------------------------------------
alter table public.jev_alerts drop constraint if exists jev_alerts_kind_check;
alter table public.jev_alerts add constraint jev_alerts_kind_check
  check (kind in ('source_drift', 'kap_class_canary', 'stage_budget'));

alter table public.jev_alerts drop constraint if exists jev_alerts_resolved_reason_check;
alter table public.jev_alerts add constraint jev_alerts_resolved_reason_check
  check (
    (resolved_at is null and resolved_reason is null)
    or (resolved_at is not null and resolved_reason in (
      'question_set_changed', 'agreement_recovered', 'drift_quiet', 'under_allowance'
    ))
  );

comment on column public.jev_alerts.resolved_reason is
  'One of question_set_changed | agreement_recovered | drift_quiet | under_allowance (088 added the last, written '
  'by jev_stage_budget_compute()). question_set_changed now means the kap_class QUESTION TEXT changed (088). '
  'Duplicated as JEV_ALERT_RESOLVED_REASONS in src/lib/admin/jev-signals.ts and pinned by '
  'tests/migrations/088-jev-spend-ledger.test.ts. Null exactly when resolved_at is null.';

create or replace function public.jev_stage_budget_compute(
  p_day date default ((pg_catalog.now() at time zone 'utc')::date - 1)
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_days     integer := greatest(((pg_catalog.now() at time zone 'utc')::date - p_day) + 1, 1);
  v_inserted integer := 0;
begin
  with d as (
    select b.stage, b.tokens, b.calls, b.allowance
      from public.jev_budget_daily(v_days) b
     where b.day = p_day and b.allowance is not null
  ),
  ins as (
    insert into public.jev_alerts (kind, day, subject, payload)
    select 'stage_budget', p_day, d.stage,
           pg_catalog.jsonb_build_object('tokens', d.tokens, 'calls', d.calls, 'allowance', d.allowance,
                                         'ratio', pg_catalog.round(d.tokens::numeric / d.allowance, 2))
      from d
     where d.tokens > d.allowance
    on conflict (kind, day, subject) do nothing
    returning 1
  )
  select pg_catalog.count(*)::integer into v_inserted from ins;

  -- An open stage_budget alert closes once its stage is at/under allowance on a
  -- later day (a zero-spend day counts as under).
  update public.jev_alerts a
     set resolved_at = pg_catalog.now(), resolved_reason = 'under_allowance'
   where a.kind = 'stage_budget'
     and a.resolved_at is null
     and a.acknowledged_at is null
     and a.day < p_day
     and coalesce((select b.tokens from public.jev_budget_daily(v_days) b
                    where b.day = p_day and b.stage = a.subject), 0)
         <= coalesce((select s.daily_tokens from public.jev_stage_budgets s where s.stage = a.subject), 0);

  return v_inserted;
end
$fn$;
comment on function public.jev_stage_budget_compute(date) is
  'Raises one jev_alerts row (kind stage_budget, subject = stage) per stage whose p_day spend exceeded '
  'jev_stage_budgets.daily_tokens; resolves earlier open ones (under_allowance) that came back under. '
  'Idempotent (ON CONFLICT DO NOTHING). Cron jev-budget-nightly 04:15 UTC (088).';

-- ---------------------------------------------------------------------------
-- 5. jev_alerts_auto_resolve(): 073's body verbatim except step (a), which now
--    keys on the kap_class QUESTION TEXT (jev_answer.question_hash, stamped by
--    JEV-A code) instead of the registry-global question_set. A question-set
--    bump that leaves kap_class untouched (JEV-B, topic7 v2) no longer closes
--    open canaries. Rows without a hash (pre-088) never satisfy step (a); they
--    can still close through step (b) agreement_recovered.
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
  v_current_hash text;
  v_rows integer;
  v_total integer := 0;
begin
  select p.jev_answer ->> 'question_hash'
    into v_current_hash
    from public.jev_shadow_predictions p
   where p.task = 'kap_class'
     and p.created_at < ((p_day + 1)::timestamp at time zone 'utc')
   order by p.created_at desc
   limit 1;

  -- (a) canary raised under a kap_class question text that no longer runs.
  if v_current_hash is not null then
    with alert_hash as (
      select
        a.id,
        coalesce(
          a.payload ->> 'question_hash',
          (
            select p.jev_answer ->> 'question_hash'
              from public.jev_shadow_predictions p
             where p.task = 'kap_class'
               and p.created_at >= (a.day::timestamp at time zone 'utc')
               and p.created_at < ((a.day + 1)::timestamp at time zone 'utc')
             group by 1
             order by pg_catalog.count(*) desc, 1
             limit 1
          )
        ) as qh
      from public.jev_alerts a
      where a.kind = 'kap_class_canary'
        and a.acknowledged_at is null
        and a.resolved_at is null
        and a.day <= p_day
    )
    update public.jev_alerts a
       set resolved_at = pg_catalog.now(),
           resolved_reason = 'question_set_changed'
      from alert_hash q
     where a.id = q.id
       and q.qh is not null
       and q.qh <> v_current_hash;
    get diagnostics v_rows = row_count;
    v_total := v_total + v_rows;
  end if;

  -- (b) agreement recovered (073 verbatim).
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

  -- (c) drift quiet (073 verbatim; 088 restores the day+1 existence guard).
  update public.jev_alerts a
     set resolved_at = pg_catalog.now(),
         resolved_reason = 'drift_quiet'
   where a.kind = 'source_drift'
     and a.acknowledged_at is null
     and a.resolved_at is null
     and a.day + 2 <= p_day
     and exists (
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
comment on function public.jev_alerts_auto_resolve(date) is
  '073 lifecycle, amended by 088: step (a) closes a kap_class_canary alert only when the kap_class QUESTION '
  'TEXT changed (jev_answer.question_hash of the alert day vs the latest kap_class row), not on any '
  'registry-wide question_set bump. Steps (b) agreement_recovered and (c) drift_quiet unchanged. Never writes '
  'acknowledged_at, never deletes. stage_budget alerts resolve in jev_stage_budget_compute().';

-- ---------------------------------------------------------------------------
-- 6. ACLs
-- ---------------------------------------------------------------------------
revoke all on function public.jev_shadow_month_usage(bigint)   from public, anon, authenticated;
revoke all on function public.jev_budget_daily(integer)        from public, anon, authenticated;
revoke all on function public.jev_stage_budget_compute(date)   from public, anon, authenticated;
revoke all on function public.jev_alerts_auto_resolve(date)    from public, anon, authenticated;
grant execute on function public.jev_shadow_month_usage(bigint) to service_role;
grant execute on function public.jev_budget_daily(integer)      to service_role;
grant execute on function public.jev_stage_budget_compute(date) to service_role;
grant execute on function public.jev_alerts_auto_resolve(date)  to service_role;

-- ---------------------------------------------------------------------------
-- 7. Nightly budget check (after 073's jev-signals-nightly at 04:05).
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron not installed -- skipping jev-budget-nightly schedule (088)';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'jev-budget-nightly') then
    perform cron.unschedule('jev-budget-nightly');
  end if;
  perform cron.schedule('jev-budget-nightly', '15 4 * * *', $sql$ select public.jev_stage_budget_compute(); $sql$);
end $$;

insert into supabase_migrations.schema_migrations (version, name)
  values ('088', '088_jev_spend_ledger') on conflict do nothing;

commit;
