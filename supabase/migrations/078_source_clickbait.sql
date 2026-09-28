-- 078_source_clickbait.sql
--
-- Per-outlet "tık tuzağı karnesi" (clickbait scorecard), reported in
-- terciles (Düşük / Orta / Yüksek), for /sources, /source/[slug] and the
-- new admin page /admin/tik-tuzagi.
--
-- SIGNAL (decision 1): this rolls up Jev task = 'clickbait' ("does this
-- headline deliberately withhold the key fact to force a click?"), NOT
-- 'sensational' (a 0-3 wording-intensity score, JEV_SCORE_TASKS in
-- supabase/functions/_shared/jev.ts). The 2026-09-20 limits test rejected
-- 'sensational' at ~20% precision and the research report (item 5) already
-- dropped sensational_mean for the same reason. 'clickbait' scored Spearman
-- 0.76 / 85% accuracy against Opus gold, but its ECE (0.12-0.15) means it is
-- usable only as a RANKING (terciles), never as a headline count or a
-- percentage — no per-headline label and no example headline is ever
-- surfaced publicly.
--
-- FLAG THRESHOLD (decision 2): jev_prob >= 0.7, pre-registered, driving both
-- this rollup's n_flag and the Step-0 (TypeScript-side) precision sample so
-- the threshold can never be moved after the fact to fit a result.
--
-- QUESTION-SET VERSION (decision 3): only '2026-09-24.1'
-- (CLICKBAIT_QUESTION_SETS in src/lib/sources/clickbait.ts, the current
-- JEV_QUESTION_SET_VERSION) is ever aggregated together. A parity test
-- (tests/migrations/078-source-clickbait.test.ts) pins this against
-- JEV_QUESTION_SET_VERSION and against a sha256 of
-- buildArticleCall(...).questions, so a silent Jev wording bump can't
-- silently widen what counts as "the same measurement" — the runbook
-- (docs/clickbait-karne.md) spells out append-vs-replace when it bumps.
--
-- ELIGIBILITY (decision 4): only active sources of the voting kinds (outlet,
-- wire — src/lib/bias/config.ts's VOTING_SOURCE_KINDS) with n >= 300
-- headlines in the 30-day window count; terciles are only computed with >=
-- 9 qualifying outlets (source_clickbait_30d's caller enforces this, not
-- this migration — the SQL function is a plain aggregate + HAVING).
-- Production measured ~5.9k clickbait rows/day across ~100 sources
-- (22,031 rows for question_set '2026-09-24.1' between 2026-09-24 23:20 and
-- 2026-09-28 18:50, i.e. ~4 days) — see the version inventory below.
--
-- ROLLUP, NOT QUERY-TIME (decision 5): jev_answer is a wide jsonb and
-- question_set lives inside it, so any 30-day aggregate over
-- jev_shadow_predictions needs a heap scan per matching row (072's own
-- header measured 8.2k heap blocks / 2.1s cold for 54h of ONE task; a 15-day
-- multi-task scan is "single-digit seconds" per 065's own note). Measured
-- against PRODUCTION on 2026-09-28 (read-only EXPLAIN, no rows written):
--
--   explain (analyze, buffers)
--   select a.source_id, count(*),
--          count(*) filter (where p.jev_prob >= 0.7),
--          avg(p.jev_prob)
--   from public.jev_shadow_predictions p
--   join public.articles a on a.id = p.article_id
--   where p.task = 'clickbait'
--     and p.created_at > now() - interval '30 days'
--     and p.jev_answer->>'question_set' = '2026-09-24.1'
--   group by 1;
--
--   GroupAggregate (actual time=15125.663..15132.678 rows=73 loops=1)
--   Buffers: shared hit=78883 read=46076 written=2   (~124,959 total blocks)
--   Bitmap Heap Scan on jev_shadow_predictions: actual 5937.175..7297.960 ms,
--     rows=22031, Rows Removed by Filter=28350, Heap Blocks: exact=36734
--   Planning Time: 268.282 ms
--   Execution Time: 15133.321 ms
--
-- 15.1s cold, well past PostgREST's 8s statement_timeout, for a WINDOW that
-- (at the time of measurement) only covered ~4 days of the current question
-- set — a true 30-day window across multiple sources would be worse. Hence
-- a rollup table (source_clickbait_daily) written by a cron job and read at
-- request time by a plain indexed aggregate.
--
-- Version inventory at time of writing (read-only, task = 'clickbait'):
--   2026-09-20.1: 3,539 rows   2026-09-21.1: 5,673 rows
--   2026-09-21.2:   420 rows   2026-09-21.3: 18,718 rows
--   2026-09-24.1: 22,031 rows (current version; min 2026-09-24 23:20:07,
--                              max 2026-09-28 18:50:18 at measurement time)
-- Duplicate check (one row per article per version, 30-day window):
--   count(*) - count(distinct (article_id, question_set)) = 0.
-- Eligible-outlet count under the '2026-09-24.1' window at measurement time:
--   24 outlets already clear n >= 300 (>= CLICKBAIT_MIN_OUTLETS = 9 gate).
-- cron.job at measurement time has no job at minute :19 (jev-shadow runs
-- */10, cluster-topics-refresh 3-59/10, blindspot-recall-veto 7-59/10,
-- articles-vacuum */30) — free for source-clickbait-rollup below.
--
-- KILL SWITCH:
--   update cron.job set active = false where jobname = 'source-clickbait-rollup';
--
-- PUBLIC GATE lives in TypeScript (src/lib/sources/clickbait.ts,
-- CLICKBAIT_PRECISION_CHECK / isClickbaitPublic), not in this migration —
-- this migration only ever computes and stores the rollup; it never decides
-- whether it is shown to a reader.
--
-- Additive-only: one new table, one new index, two new functions (or
-- replace, both re-callable), grants/revokes, a pg_cron guard block, a
-- one-off backfill SELECT, and the ledger insert. No existing table,
-- column, index, policy, trigger, function or cron job is dropped or
-- altered beyond `enable row level security` on the new table. Safe to
-- re-apply (`create table if not exists`, `create or replace function`,
-- `on conflict do nothing` throughout).

begin;

create table if not exists public.source_clickbait_daily (
  source_id    uuid not null references public.sources(id) on delete cascade,
  day          date not null,
  question_set text not null,
  n            integer not null check (n >= 0),
  n_flag       integer not null check (n_flag >= 0),
  prob_sum     numeric(12,3) not null default 0 check (prob_sum >= 0),
  computed_at  timestamptz not null default now(),
  primary key (source_id, day, question_set),
  check (n_flag <= n)
);

create index if not exists source_clickbait_daily_day_idx
  on public.source_clickbait_daily (day desc);

comment on table public.source_clickbait_daily is
  '078: one row per (source, UTC day the prediction was WRITTEN, question_set) '
  'clickbait rollup. Read-only to service_role; written only by '
  'public.source_clickbait_rollup(). Never joined at reader request time '
  'without going through public.source_clickbait_30d (which filters '
  'active/voting-kind sources and the n >= p_min_n floor).';

alter table public.source_clickbait_daily enable row level security;
revoke all on public.source_clickbait_daily from anon, authenticated, public;
grant select on public.source_clickbait_daily to service_role;

create or replace function public.source_clickbait_rollup(
  p_from date default null,
  p_to   date default null
) returns integer
language plpgsql volatile security definer set search_path = ''
as $fn$
declare
  v_to   date := coalesce(p_to, (now() at time zone 'utc')::date);
  v_from date := coalesce(p_from, (now() at time zone 'utc')::date - 1);
  v_rows integer := 0;
begin
  if v_from > v_to then return 0; end if;
  if v_to - v_from > 40 then v_from := v_to - 40; end if;
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('source_clickbait_rollup')::bigint) then
    return 0;
  end if;

  insert into public.source_clickbait_daily as d
    (source_id, day, question_set, n, n_flag, prob_sum, computed_at)
  select a.source_id,
         (l.created_at at time zone 'utc')::date,
         l.question_set,
         count(*)::integer,
         (count(*) filter (where l.jev_prob >= 0.7))::integer,
         coalesce(sum(l.jev_prob), 0)::numeric(12,3),
         now()
    from (
      select distinct on (p.article_id, p.jev_answer ->> 'question_set')
             p.article_id,
             p.jev_answer ->> 'question_set' as question_set,
             p.jev_prob,
             p.created_at
        from public.jev_shadow_predictions p
       where p.task = 'clickbait'
         and p.created_at >= (v_from::timestamp at time zone 'utc')
         and p.created_at <  ((v_to + 1)::timestamp at time zone 'utc')
         and p.article_id is not null
         and p.jev_prob is not null
       order by p.article_id, p.jev_answer ->> 'question_set', p.created_at desc
    ) l
    join public.articles a on a.id = l.article_id
   where l.question_set is not null
     and a.source_id is not null
   group by a.source_id, (l.created_at at time zone 'utc')::date, l.question_set
  on conflict (source_id, day, question_set) do update
     set n = excluded.n,
         n_flag = excluded.n_flag,
         prob_sum = excluded.prob_sum,
         computed_at = excluded.computed_at
   where (d.n, d.n_flag, d.prob_sum) is distinct from (excluded.n, excluded.n_flag, excluded.prob_sum);

  get diagnostics v_rows = row_count;
  return v_rows;
end
$fn$;

comment on function public.source_clickbait_rollup(date, date) is
  '078: upserts source_clickbait_daily for [p_from, p_to] (default: '
  'yesterday..today UTC), clamped to a 40-day span. task = ''clickbait'' '
  'only. distinct on (article_id, question_set) keeps one row per article '
  'per version even if a future writer ever double-writes. Guarded by an '
  'advisory xact lock so overlapping cron ticks never race. Kill switch: '
  'update cron.job set active = false where jobname = ''source-clickbait-rollup''. '
  'STALENESS NOTE: a row is bucketed by the UTC day of its LATEST '
  'jev_shadow_predictions.created_at for that (article, question_set), not '
  'the article''s original day. If an article is ever rescored (a second '
  'prediction written on a later UTC day), the count moves to the new '
  'day''s row on the next run that covers it, but the OLD day''s row is '
  'never revisited unless that earlier range is explicitly re-passed to '
  'this function again -- it is left stale (too high) until then. Low risk '
  'today since clickbait predictions are not currently rescored; re-pass '
  'the old day''s range by hand if rescoring is ever introduced.';

create or replace function public.source_clickbait_30d(
  p_question_sets text[],
  p_days  integer default 30,
  p_min_n integer default 300
) returns table (
  source_id uuid, source_slug text, source_name text, source_bias text, source_kind text,
  n_total bigint, n_flagged bigint, mean_prob numeric, first_day date, last_day date
)
language sql stable security definer set search_path = ''
as $fn$
  select s.id, s.slug, s.name, s.bias, coalesce(s.kind, 'outlet'),
         sum(d.n)::bigint, sum(d.n_flag)::bigint,
         round(sum(d.prob_sum) / nullif(sum(d.n), 0), 4),
         min(d.day), max(d.day)
    from public.source_clickbait_daily d
    join public.sources s on s.id = d.source_id
   where d.question_set = any (coalesce(p_question_sets, array[]::text[]))
     and d.day > (now() at time zone 'utc')::date - least(greatest(coalesce(p_days, 30), 1), 60)
     and s.active
     and coalesce(s.kind, 'outlet') in ('outlet', 'wire')
   group by s.id, s.slug, s.name, s.bias, s.kind
  having sum(d.n) >= greatest(coalesce(p_min_n, 300), 1)
   order by s.slug;
$fn$;

comment on function public.source_clickbait_30d(text[], integer, integer) is
  '078: per-outlet clickbait rollup over the last p_days days (clamped 1-60), '
  'restricted to p_question_sets, active sources of voting kind (outlet, '
  'wire), with at least p_min_n total headlines. Reads only '
  'source_clickbait_daily -- never touches jev_shadow_predictions -- so it '
  'stays well under PostgREST''s statement_timeout regardless of table age.';

revoke all on function public.source_clickbait_rollup(date, date) from public, anon, authenticated;
grant execute on function public.source_clickbait_rollup(date, date) to service_role;
revoke all on function public.source_clickbait_30d(text[], integer, integer) from public, anon, authenticated;
grant execute on function public.source_clickbait_30d(text[], integer, integer) to service_role;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron not installed — skipping source-clickbait-rollup schedule (078)'; return;
  end if;
  if exists (select 1 from cron.job where jobname = 'source-clickbait-rollup') then
    perform cron.unschedule('source-clickbait-rollup');
  end if;
  perform cron.schedule('source-clickbait-rollup', '19 * * * *',
    $sql$ select public.source_clickbait_rollup(); $sql$);   -- :19 is free (071's header)
end $$;

-- One-off backfill: populate the rollup for the full 30-day window so the
-- karne has data immediately after this migration applies, rather than
-- waiting up to an hour for the first cron tick. Gated on the table still
-- being empty so a re-apply (operator re-running this file by hand, or a
-- migration-runner retry after a transient failure) never re-pays the
-- ~15s-cold cost measured in this file's header inside the same DDL
-- transaction -- the cron tick at :19 will backfill from here anyway.
do $$
begin
  if not exists (select 1 from public.source_clickbait_daily limit 1) then
    perform public.source_clickbait_rollup((now() at time zone 'utc')::date - 30, (now() at time zone 'utc')::date);
  end if;
end $$;

insert into supabase_migrations.schema_migrations (version, name)
  values ('078', '078_source_clickbait')
  on conflict do nothing;

commit;
