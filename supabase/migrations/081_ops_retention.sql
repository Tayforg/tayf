-- 081_ops_retention.sql
--
-- ops-retention: a daily Jev rollup (so the /admin 7-day agreement read
-- stops scanning jev_shadow_predictions) plus retention of SYSTEM exhaust
-- (cron.job_run_details, net._http_response). jev_shadow_predictions and
-- every other product table are DELIBERATELY untouched -- see the
-- product-safety contract enforced by tests/migrations/081-ops-retention.test.ts.
--
-- Step 0 measurements, re-run 2026-09-28 (the planner's 2026-09-27 numbers
-- above are stale by about one day of growth):
--
--   public.jev_shadow_predictions : 413 MB (433,479,680 bytes), 401,277 rows,
--     spanning 2026-09-20 through 2026-09-28 (today, partial day). Growth is
--     ~53 MB/day (433,479,680 bytes / ~8.13 days since 2026-09-20 15:30) --
--     close to the planner's ~50 MB/day estimate. last_autovacuum
--     2026-09-27 13:21 UTC. Nothing prunes it; this migration doesn't either.
--   cron.job_run_details : 211 MB (221,323,264 bytes), 258,310 rows back to
--     2026-06-10 17:03 UTC. 212,628 of those rows (82%) are already older
--     than the 14-day keep window. last_autovacuum: never run (null) --
--     pg_stat_all_tables.n_live_tup reads 0 as a result; the row count above
--     is a real count(*), not the (stale) stat estimate.
--   net._http_response : 178 MB (186,580,992 bytes) for only 838 live rows,
--     all created within the last 6 hours (pg_net's own TTL already keeps
--     this table tiny) -- the 178 MB is dead-tuple bloat. last_autovacuum
--     2026-08-05 10:11 UTC.
--   Whole DB: 3,021 MB.
--   Privileges: current_user = postgres, has DELETE on both
--     cron.job_run_details and net._http_response (both owned by
--     supabase_admin) -- so ops_exhaust_prune's net branch is NOT
--     runtime-skipped here. The has_table_privilege() guard stays in the
--     function anyway, for environments where the migrating role differs
--     from the pg_cron scheduling role.
--   question_set breakdown (jev_answer->>'question_set'): five distinct
--     values in the sampled window (e.g. '2026-09-24.1' with 175,372 rows,
--     '2026-09-21.3' with 158,792, down to '2026-09-21.2' with 3,421) --
--     these are per-batch identifiers, not a small fixed vocabulary, so the
--     daily rollup's cardinality is bounded by (day x task x question_set)
--     as designed, not assumed to be "~20 tasks x 1-2 sets".
--   jev_shadow_agreement(168) (EXPLAIN ANALYZE, warm cache here): 1.13 s
--     wall (buffers: 7,476 hit / 2,321 read), well under PostgREST's 8 s
--     statement_timeout on this measurement, but rising with the table (see
--     growth above) -- the rollup exists so that trend line is flat instead
--     of tracking the raw table's size.
--
-- Expected savings (recomputed from the numbers above, not the planner's):
--   cron.job_run_details: the first 04:40 UTC prune deletes ~212,628 rows
--     (~211 MB x 212,628/258,310 = ~174 MB made reusable; the file itself
--     shrinks only after a manual VACUUM FULL). Steady state after that is
--     the remaining ~45,682 rows (~39 MB), roughly today's 14-day trailing
--     window at the observed ~3,300 rows/day, and ~2.8 MB/day of unbounded
--     growth stops accumulating.
--   net._http_response: the 3-day guard deletes ~0 rows (every measured row
--     is <6h old) by design -- it is a guard against pg_net TTL regressing,
--     not today's fix. The 178 MB of bloat is reclaimable only via a manual
--     `VACUUM FULL net._http_response` (needs table-owner privileges; run
--     it in the 04:30 UTC lull -- see docs/migration-guide.md).
--   jev_shadow_predictions: untouched, still ~413 MB and growing ~53 MB/day.
--     The new jev_shadow_daily rollup is bounded by day x task x
--     question_set; even with the wider-than-expected question_set
--     cardinality above, it stays multiple orders of magnitude smaller than
--     the raw table growth (single-digit MB/yr in the shape of tasks this
--     app runs).
--   Net effect: ~174 MB reused immediately (cron), + ~178 MB reclaimable via
--     one manual VACUUM FULL (net) = ~352 MB, ~11.6% of the 3,021 MB DB.
--     /admin's 7-day agreement read moves from a ~1.1 s (and rising) raw
--     scan to a rollup read over complete days plus one day of raw rows.
--
-- One transaction, additive only: no existing table, column, function or
-- cron job is altered or dropped. SECURITY DEFINER functions use
-- `set search_path = ''`, are revoked from anon/authenticated/public, and
-- granted to service_role only -- same shell as 061/071/072. Safe to
-- re-apply (`create table if not exists`, `create or replace function`,
-- idempotent cron reschedule, ledger insert `on conflict do nothing`).
--
-- VACUUM is deliberately NOT scheduled here: VACUUM cannot run inside a
-- transaction block (this migration is one `begin`/`commit`), and
-- VACUUM FULL takes an ACCESS EXCLUSIVE lock -- both stay manual operator
-- steps in docs/migration-guide.md. `pg_net.ttl` is not touched either:
-- ALTER SYSTEM is not permitted on Supabase.

begin;

-- Belt-and-suspenders for the step-5 backfill below: a long-tail scan over
-- jev_shadow_predictions should fail fast with a clear Postgres error
-- instead of an ambiguous client-side (SQL editor / pooler) timeout. 5 min
-- is generous headroom over the ~1.13 s measured jev_shadow_agreement(168)
-- scan on a comparably-sized table (see Step 0 above); if this trips, use
-- the "backfill line removed, run separately" fallback documented in
-- docs/migration-guide.md ("081 — Jev günlük özet ..." section).
set local statement_timeout = '5min';

-- ---------------------------------------------------------------------------
-- 1. Daily rollup (one row per UTC day x task x question_set)
-- ---------------------------------------------------------------------------

create table if not exists public.jev_shadow_daily (
  day               date        not null,
  task              text        not null,
  question_set      text        not null default '',
  n                 bigint      not null default 0,
  comparable        bigint      not null default 0,   -- agree is not null
  agreed            bigint      not null default 0,
  undecided         bigint      not null default 0,   -- agree is null
  prob_n            bigint      not null default 0,
  prob_sum          numeric     not null default 0,
  latency_ms_sum    bigint      not null default 0,
  latency_ms_p50    integer,
  latency_ms_p95    integer,
  input_tokens_sum  bigint      not null default 0,   -- call-level count repeated per row (061): NOT spend; spend = jev_shadow_runs
  refreshed_at      timestamptz not null default now(),
  primary key (day, task, question_set)
);

alter table public.jev_shadow_daily enable row level security;

revoke all on public.jev_shadow_daily from anon, authenticated, public;
grant select, insert, update on public.jev_shadow_daily to service_role;

comment on table public.jev_shadow_daily is
  'One row per (UTC day, task, question_set) rollup of public.jev_shadow_predictions '
  '(migration 081). Populated by public.jev_shadow_daily_refresh(), scheduled nightly '
  'at 00:20 UTC to roll up the last 2 complete days. Exists so '
  'public.jev_shadow_agreement_rollup() can answer a multi-day /admin window without '
  'scanning jev_shadow_predictions, which grows ~50 MB/day and is never pruned. '
  'input_tokens_sum repeats the call-level jev_shadow_predictions.input_tokens per row '
  '(same caveat as 061) -- it is NOT spend; spend is jev_shadow_runs.input_tokens. '
  'service_role-only, RLS on, no policies -- same shell as jev_shadow_predictions.';

comment on column public.jev_shadow_daily.question_set is
  'coalesce(jev_answer->>''question_set'', ''''). Observed values (2026-09-28) are '
  'per-batch identifiers (e.g. ''2026-09-24.1''), not a small fixed vocabulary -- the '
  'primary key is (day, task, question_set) specifically because this column''s '
  'cardinality is not assumed to be small.';

-- ---------------------------------------------------------------------------
-- jev_shadow_daily_refresh: nightly rollup of complete UTC days.
-- ---------------------------------------------------------------------------

create or replace function public.jev_shadow_daily_refresh(p_days integer default 2)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_days  integer     := greatest(1, least(coalesce(p_days, 2), 400));
  v_today date        := (pg_catalog.now() at time zone 'utc')::date;
  v_from  timestamptz := ((v_today - v_days)::timestamp at time zone 'utc');
  v_to    timestamptz := (v_today::timestamp at time zone 'utc');   -- complete days only
  v_n     integer     := 0;
begin
  insert into public.jev_shadow_daily as d (day, task, question_set, n, comparable, agreed, undecided,
         prob_n, prob_sum, latency_ms_sum, latency_ms_p50, latency_ms_p95, input_tokens_sum, refreshed_at)
  select (p.created_at at time zone 'utc')::date, p.task, coalesce(p.jev_answer ->> 'question_set', ''),
         count(*), count(*) filter (where p.agree is not null), count(*) filter (where p.agree),
         count(*) filter (where p.agree is null), count(p.jev_prob), coalesce(sum(p.jev_prob), 0),
         coalesce(sum(p.latency_ms), 0),
         percentile_disc(0.5)  within group (order by p.latency_ms),
         percentile_disc(0.95) within group (order by p.latency_ms),
         coalesce(sum(p.input_tokens), 0), pg_catalog.now()
    from public.jev_shadow_predictions p
   where p.created_at >= v_from and p.created_at < v_to
   group by 1, 2, 3
  on conflict (day, task, question_set) do update
     set n = excluded.n, comparable = excluded.comparable, agreed = excluded.agreed,
         undecided = excluded.undecided, prob_n = excluded.prob_n, prob_sum = excluded.prob_sum,
         latency_ms_sum = excluded.latency_ms_sum, latency_ms_p50 = excluded.latency_ms_p50,
         latency_ms_p95 = excluded.latency_ms_p95, input_tokens_sum = excluded.input_tokens_sum,
         refreshed_at = excluded.refreshed_at;
  get diagnostics v_n = row_count;
  return v_n;
end
$fn$;

comment on function public.jev_shadow_daily_refresh(integer) is
  'Rolls up complete UTC days (created_at < today) of jev_shadow_predictions into '
  'jev_shadow_daily, upserting on (day, task, question_set) so a re-run is idempotent '
  '(migration 081). p_days (clamped 1..400) counts back from today; the nightly '
  'schedule uses 2 (covers a late-arriving previous day), the one-off backfill in this '
  'migration uses 400 (covers the table''s full history since 2026-09-20). Never rolls '
  'up today itself -- the admin read gets today''s tail from raw jev_shadow_predictions '
  'rows via jev_shadow_agreement_rollup(), not from this table.';

-- ---------------------------------------------------------------------------
-- 2. Admin read: complete days from the rollup + raw rows only for the
--    uncovered tail (today, or since the last rolled day)
-- ---------------------------------------------------------------------------

create or replace function public.jev_shadow_agreement_rollup(p_days integer default 7)
returns table (task text, total bigint, agreed bigint, undecided bigint)
language sql
stable
security definer
set search_path = ''
as $fn$
  with b as (
    select (now() at time zone 'utc')::date as today,
           greatest(1, least(coalesce(p_days, 7), 366)) as days
  ),
  w as (
    select b.today - (b.days - 1) as win_start,
           least(b.today, greatest(b.today - (b.days - 1),
                 coalesce((select max(d.day) + 1 from public.jev_shadow_daily d), b.today - (b.days - 1)))) as live_start
      from b
  ),
  hist as (
    select d.task, sum(d.comparable) as total, sum(d.agreed) as agreed, sum(d.undecided) as undecided
      from public.jev_shadow_daily d, w
     where d.day >= w.win_start and d.day < w.live_start
     group by d.task
  ),
  live as (
    select p.task, count(*) filter (where p.agree is not null) as total,
           count(*) filter (where p.agree) as agreed, count(*) filter (where p.agree is null) as undecided
      from public.jev_shadow_predictions p, w
     where p.created_at >= (w.live_start::timestamp at time zone 'utc')
     group by p.task
  )
  select u.task, sum(u.total)::bigint, sum(u.agreed)::bigint, sum(u.undecided)::bigint
    from (select * from hist union all select * from live) u
   group by u.task
   order by u.task;
$fn$;

comment on function public.jev_shadow_agreement_rollup(integer) is
  'Per-task agreement over the last p_days (clamped 1..366): complete UTC days come '
  'from jev_shadow_daily, the uncovered tail (today, or since the last rolled day if '
  'the nightly refresh has fallen behind) comes from a raw jev_shadow_predictions scan '
  'bounded to that tail only (migration 081). Same output shape as '
  'jev_shadow_agreement(p_hours) so src/lib/admin/jev-shadow-status.ts can swap the '
  '168h caller for this with no change to the row shape. The window is p_days complete '
  '*calendar* days plus today, not a rolling p_days*24 hour window -- see the header '
  'comment on the 7-day call site.';

-- ---------------------------------------------------------------------------
-- 3. Retention of SYSTEM exhaust only
-- ---------------------------------------------------------------------------

create or replace function public.ops_exhaust_prune(
  p_cron_keep   interval default interval '14 days',
  p_net_keep    interval default interval '3 days',
  p_batch       integer  default 20000,
  p_max_batches integer  default 50
)
returns table (cron_deleted bigint, net_deleted bigint)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_cron_keep interval := greatest(coalesce(p_cron_keep, interval '14 days'), interval '7 days'); -- floor: a bad arg can never wipe recent history
  v_net_keep  interval := greatest(coalesce(p_net_keep,  interval '3 days'),  interval '1 day');
  v_batch     integer  := greatest(1, least(coalesce(p_batch, 20000), 100000));
  v_max       integer  := greatest(1, least(coalesce(p_max_batches, 50), 500));
  v_max_runid bigint;
  v_n         bigint;
  v_i         integer := 0;
begin
  cron_deleted := 0;
  net_deleted  := 0;

  if pg_catalog.to_regclass('cron.job_run_details') is not null then
    -- runid is assigned at start and increases monotonically: one scan finds the cut, then PK-range batches
    select max(r.runid) into v_max_runid
      from cron.job_run_details r
     where r.start_time < pg_catalog.now() - v_cron_keep;
    if v_max_runid is not null then
      loop
        delete from cron.job_run_details d
         where d.runid in (select r.runid from cron.job_run_details r
                            where r.runid <= v_max_runid order by r.runid limit v_batch);
        get diagnostics v_n = row_count;
        cron_deleted := cron_deleted + v_n;
        v_i := v_i + 1;
        exit when v_n < v_batch or v_i >= v_max;
      end loop;
    end if;
  end if;

  if pg_catalog.to_regclass('net._http_response') is not null
     and pg_catalog.has_table_privilege('net._http_response', 'DELETE') then
    delete from net._http_response h
     where h.created < pg_catalog.now() - v_net_keep;
    get diagnostics v_n = row_count;
    net_deleted := v_n;
  end if;

  return next;
end
$fn$;

comment on function public.ops_exhaust_prune(interval, interval, integer, integer) is
  'Deletes SYSTEM exhaust rows only -- cron.job_run_details older than p_cron_keep '
  '(floored at 7 days) and net._http_response older than p_net_keep (floored at 1 day, '
  'skipped entirely if the migrating role lacks DELETE on net._http_response). '
  'Migration 081. NEVER touches jev_shadow_predictions or any public.* table -- see '
  'the product-safety contract in tests/migrations/081-ops-retention.test.ts. Batches '
  'the cron delete (p_batch rows/txn, up to p_max_batches iterations) via a PK-range '
  'scan on cron.job_run_details.runid, which is monotonically increasing. DELETE makes '
  'space reusable inside the table; a manual full-table compaction pass is required '
  'to shrink the file on disk (see docs/migration-guide.md). Scheduled nightly at 04:40 UTC with no '
  'arguments (the defaults above); the operator kill switch is '
  '`update cron.job set active=false where jobname=''ops-exhaust-prune'';`.';

revoke all on function public.jev_shadow_daily_refresh(integer) from anon, authenticated, public;
revoke all on function public.jev_shadow_agreement_rollup(integer) from anon, authenticated, public;
revoke all on function public.ops_exhaust_prune(interval, interval, integer, integer) from anon, authenticated, public;

grant execute on function public.jev_shadow_daily_refresh(integer) to service_role;
grant execute on function public.jev_shadow_agreement_rollup(integer) to service_role;
grant execute on function public.ops_exhaust_prune(interval, interval, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Schedules (SQL-only jobs; pg_net not needed)
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron not installed — skipping 081 schedules (jev-shadow-daily, ops-exhaust-prune)';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'jev-shadow-daily') then
    perform cron.unschedule('jev-shadow-daily');
  end if;
  perform cron.schedule('jev-shadow-daily', '20 0 * * *', $sql$ select public.jev_shadow_daily_refresh(2); $sql$);

  if exists (select 1 from cron.job where jobname = 'ops-exhaust-prune') then
    perform cron.unschedule('ops-exhaust-prune');
  end if;
  perform cron.schedule('ops-exhaust-prune', '40 4 * * *', $sql$ select * from public.ops_exhaust_prune(); $sql$);
end
$$;

-- ---------------------------------------------------------------------------
-- 5. One-off backfill of every complete day (the table starts 2026-09-20;
--    one seq scan of jev_shadow_predictions)
-- ---------------------------------------------------------------------------

select public.jev_shadow_daily_refresh(400);

insert into supabase_migrations.schema_migrations (version, name)
  values ('081', '081_ops_retention') on conflict do nothing;

commit;
