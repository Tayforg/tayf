-- 102_jev_shadow_retention.sql
--
-- Bounded, exemption-safe retention for public.jev_shadow_predictions, which
-- reached 2.2 GB / 1,962,216 rows (about 78 MB and 68k rows per day) with
-- nothing ever deleting from it. One additive piece set, one transaction:
--   1. a partial index on jev_politics_admissions.politics_prediction_id
--      (the FK column of 089's ON DELETE SET NULL);
--   2. public.jev_shadow_prune(p_keep, p_batch, p_max_batches), a
--      SECURITY DEFINER, service_role-only nightly prune;
--   3. the pg_cron job 'jev-shadow-prune' at 04:50 UTC.
-- Source: the 2026-10-21 incident doc, finding 4 (growth and retention).
--
-- ===========================================================================
-- THE DELETION IS IRREVERSIBLE.
-- ===========================================================================
-- There is no soft delete, no archive table and no undo: a pruned row is gone
-- and only the rollups below keep its aggregate. Take a pg_dump of the table
-- (or rely on the Supabase point-in-time backup) before tightening the keep
-- window below its default. The function has no code path that deletes
-- anything except public.jev_shadow_predictions, and it never deletes a row
-- that any exemption below protects.
--
-- RETENTION POLICY
--   * Default keep is 45 days: a row is eligible once it is older than
--     now() - 45 days. The first row is from 2026-09-20 15:30 UTC, so no row
--     qualifies before about 2026-11-04 and the first nightly run that can
--     delete anything is 2026-11-05 04:50 UTC. Until then the job is a no-op
--     ('ok: nothing older than cutoff').
--   * The founder can tighten to 21-30 days by rescheduling with an argument:
--       select cron.unschedule('jev-shadow-prune');
--       select cron.schedule('jev-shadow-prune', '50 4 * * *',
--         $$ set statement_timeout = '10min'; select * from public.jev_shadow_prune(interval '30 days'); $$);
--   * The 21 days floor is hard: greatest(p_keep, interval '21 days') inside
--     the function, so no argument (null, zero, negative, '1 day') can go
--     below it. Batch size is clamped to 1000..50000 and batches to 1..200.
--   * Today (2026-10-21) 611,085 rows are older than 21 days (R3). Tightening
--     to 21 days would therefore delete up to about 596k of them (611,085 minus
--     the 14,858 exempt-task rows) over at least two nights: a default run
--     scans at most 20 windows of 20000 ids, so 400k rows per night.
--   * Space is reused in place by autovacuum; the file does not shrink, and no
--     VACUUM FULL is needed (steady state stops growing). The autovacuum
--     reloptions for this table are NOT set here: migration 101 owns them.
--   * The whole prune is ONE transaction (a plpgsql function cannot commit
--     between batches). At most p_batch x p_max_batches rows are removed per
--     run (default 400k, about 450 MB of dead tuples and WAL), so a catch-up
--     night is heavy but bounded; steady state is about 68k rows per night.
--   * Kill switch (no deploy):
--       update cron.job set active = false where jobname = 'jev-shadow-prune';
--     Re-applying this migration re-enables the job (idempotent reschedule,
--     the same behaviour as 081/100). Manual one-off:
--       select * from public.jev_shadow_prune(interval '60 days', 1000, 1);
--
-- WHAT IS NEVER DELETED (exemptions, all inside the delete's own predicate)
--   (a) rows with a jev_shadow_reviews row. 061's FK is ON DELETE CASCADE, so
--       a naive delete would destroy the founder's verdicts.
--   (b) rows referenced by jev_politics_admissions.politics_prediction_id
--       (089's FK is ON DELETE SET NULL; harmless, but the link is kept).
--   (c) rows of a gold-set article: g.article_id = p.article_id OR
--       g.article_id::text = p.subject_id (two NOT EXISTS, so each can be an
--       anti-join). The gold scorecard (063) and 076 read politics/topic rows
--       of gold articles at any age.
--   (d) rows whose subject_id is a frozen jev_regression_items.subject_id.
--   (e) any other foreign key to the table: none exists (R1 below), so none.
--   (f) tasks pair_marginal, blindspot_recall, ticker_relevance, kap_class,
--       kap_materiality and pair_positive: low volume (14,858 of the 611,085
--       rows older than 21 days = 2.4%, R3) and reader- or spend-facing:
--       pair_marginal feeds the month cap (jev_shadow_month_usage) and the
--       62-day jev_budget_daily; blindspot_recall keeps an old veto from
--       silently clearing; ticker_relevance and the KAP pickup are fail-open;
--       kap_class feeds jev_alerts_auto_resolve; kap_materiality is KAP-side.
--       pair_positive is an ADDITION to the five tasks in the brief: 075's
--       unlink-triage dry run uses a pair_positive >= 0.5 link as a guard for
--       pending candidates of any age (382 pending, 0 ever decided on
--       2026-09-28); without these rows an old pending candidate would flip
--       to would_unlink = true. It costs 0.7 percentage points of the old rows.
--   (g) the row's article (via cluster_articles) or its cluster_id belongs to
--       a cluster that is still live (clusters.updated_at >= cutoff). This
--       protects cluster_topics_refresh votes (067, p_since <= 30 days),
--       cluster_framing_receipt (068), headline_llm_eligible (069) and the
--       cluster-stage anti-join, which would otherwise re-ask and re-pay.
--   (h) a row is deleted only when its UTC day and task are already in
--       jev_shadow_daily (the 081 rollup). Together with the 'skipped: rollup
--       behind' guard this means a day is never deleted before it has been
--       rolled up, even if the nightly rollup missed a day in the middle.
--
-- THE ROLLUPS KEEP THE AGGREGATES
--   081 jev_shadow_daily (per day x task x question_set), 078
--   source_clickbait_daily (per source x day x question_set), 090
--   jev_topic7_yardstick_daily (per day x question key) and 065
--   source_drift_daily (per source x day). Only jev_shadow_daily is enforced
--   in SQL (the guard and exemption (h)); the other three are an operator
--   check before the first prune:
--     select 'jev_shadow_daily' t, max(day) from public.jev_shadow_daily
--     union all select 'source_clickbait_daily', max(day) from public.source_clickbait_daily
--     union all select 'jev_topic7_yardstick_daily', max(day) from public.jev_topic7_yardstick_daily
--     union all select 'source_drift_daily', max(day) from public.source_drift_daily;
--   Found while writing this (read-only, 2026-10-21): jev_topic7_yardstick_daily
--   stops at 2026-10-16 although topic7 predictions exist for 10-17 to 10-20
--   (about 4k per day); its nightly job (jev-topic7-yardsticks, 00:25) failed
--   on 2026-10-20 and 2026-10-21 with 'canceling statement due to statement
--   timeout' (the incident's slow database). Back-fill it with
--   public.jev_topic7_yardstick_refresh(10) well before 2026-11-05.
--
-- AFTER ANY PRUNE, NEVER re-apply 081. Its last statement is the one-off
-- backfill select public.jev_shadow_daily_refresh(400), which upserts every
-- complete day from the raw table; after a prune the days near the cutoff are
-- partial, so it would overwrite the preserved history with smaller numbers.
-- The same applies to every rollup refresh: never run one with a window
-- longer than the keep window. MAX SAFE WINDOW (keep_days = the p_keep in
-- days: 45 by default, never below 21; today_utc = the current UTC date):
--   * public.jev_shadow_daily_refresh(p_days):    p_days <= keep_days - 1
--     (44 at the default, 20 at the floor; the nightly job uses 2).
--   * public.source_clickbait_rollup(p_from, p_to): p_from >= today_utc -
--     (keep_days - 1); the function's own 40-day span clamp is therefore safe
--     only while keep_days >= 41 (nightly default: yesterday..today).
--   * public.jev_topic7_yardstick_refresh(p_days): p_days <= keep_days - 1
--     (its own clamp is 31; nightly 2).
--   * public.jev_source_drift_compute(p_day): reads p_day - 14 days through
--     p_day, so p_day >= today_utc - (keep_days - 15): the last 30 days at
--     the default, the last 6 days at the floor (nightly: yesterday).
--
-- WHY NOT PARTITIONING (incident doc, finding 4): every unique constraint on
-- a partitioned table must include the partition key. That breaks the
-- ON CONFLICT (task, subject_id) idempotency key the Edge Function upserts
-- against and the one-stored-row-per-article invariant, and it breaks the
-- jev_shadow_reviews -> jev_shadow_predictions(id) foreign key. A bounded
-- nightly delete gets the same steady state without any of that.
--
-- HOW THE SCAN STAYS BOUNDED. v_hi is the id of the newest row older than the
-- cutoff (one probe of the created_at index). The loop then walks an id
-- keyset (081's runid pattern): each pass locates a window of at most p_batch
-- ids above v_lo, older than the cutoff and NOT in the exempt-task list, then
-- deletes the non-exempt rows of that window and advances v_lo. Skipping the
-- exempt tasks in the locator matters: those rows never go away, so without
-- it they would pile up at the low ids and eat the whole batch budget after
-- a year of accumulation. The other exemptions (a)-(d), (g), (h) are applied
-- by the delete itself; they stay small (reviews, gold, regression, live
-- clusters). Ids and created_at can interleave by a few seconds around the
-- boundary (created_at is the transaction start, the id is taken at insert),
-- so a row right at the edge may wait for the next night's run.
--
-- R1-R6: READ-ONLY CHECKS ON PRODUCTION, 2026-10-21 (about 22:45 UTC)
--   R1 foreign keys referencing jev_shadow_predictions: exactly two.
--        jev_shadow_reviews.prediction_id    jev_shadow_reviews_prediction_id_fkey
--          ... ON DELETE CASCADE   (indexed: jev_shadow_reviews_prediction_idx)
--        jev_politics_admissions.politics_prediction_id
--          jev_politics_admissions_politics_prediction_id_fkey ... ON DELETE SET NULL
--          (NOT indexed before this migration: every deleted prediction fires
--          the set-null trigger, which would seq scan the admissions table.
--          Index created in section 1; the table has 0 rows today, so a plain
--          in-transaction CREATE INDEX is instant and no CONCURRENTLY pre-build
--          is needed.)
--        No other FK, so exemption (e) is empty.
--   R2 rollups (min..max day, rows) and their refresh jobs (all active):
--        jev_shadow_daily            2026-09-20 .. 2026-10-20   533   jev-shadow-daily 20 0 * * *
--        source_clickbait_daily      2026-09-20 .. 2026-10-21  2720   source-clickbait-rollup 19 * * * *
--        jev_topic7_yardstick_daily  2026-09-21 .. 2026-10-16    25   jev-topic7-yardsticks 25 0 * * * (FAILING, see above)
--        source_drift_daily          2026-09-21 .. 2026-10-20  1348   jev-signals-nightly 05 4 * * *
--        No cron job is named jev-shadow-prune, and 04:50 is free (04:05
--        jev-signals-nightly, 04:10 prune-nightly, 04:15 jev-budget-nightly,
--        04:20 alias-prune, 04:25 bars-5m-prune, 04:40 ops-exhaust-prune and
--        reader-data-purge).
--   R3 rows older than 21 days by task (611,085 in total): opinion, clickbait,
--      topic7, framing, topic, sensational, politics 77,882 each (545,174);
--      pair_negative 34,496; cluster_member 9,356; pair_positive 4,479;
--      kap_materiality 3,114; title_edit_kind 2,496; title_meaning 2,496;
--      kap_class 2,463; neutral_pick 2,209; ticker_relevance 1,769;
--      pair_marginal 1,738; blindspot_recall 1,295. Table total 1,962,216 rows,
--      min(created_at) 2026-09-20 15:30:55 UTC. Exempt tasks (f): 14,858 =
--      2.4% of the old rows (1.7% without pair_positive; under the 5% limit).
--   R4 exempt-set sizes: jev_shadow_reviews 3; jev_politics_admissions 0
--      (0 with a politics_prediction_id); jev_gold_set 660;
--      jev_regression_items 180. All tiny.
--   R5 subject_type = 'article' rows with article_id null: 0 (so exemption (c)'s
--      article_id comparison and subject_id comparison agree for article tasks).
--   R6 longest look-back of every reader, and how it is covered:
--      * jev_source_drift_compute (065/073): the day plus a 14-day baseline,
--        15 days, under the floor.
--      * jev_gold_seed (063) and the jev_regression_freeze 5b/5c pools (066):
--        30 days, but both cap at the 20,000 most recent rows (politics is
--        about 8k rows per day, pair_negative about 2.7k), so the cap, not
--        the window, binds at any keep >= 21 days. Gold scorecard and 076
--        provisional labels read gold articles' rows at any age: (c);
--        076 falls back to ref_jev_prob when a row is missing anyway.
--      * jev_shadow_month_usage (088/061): month to date, pair_marginal rows
--        with run_id null: (f).
--      * jev_budget_daily (088): up to 62 days of pair_marginal rows: (f).
--      * jev_alerts_auto_resolve (073/088): kap_class rows on the alert day
--        and the newest kap_class row: (f).
--      * blindspot_recall_veto_refresh (071): every currently vetoed cluster
--        at any age (blindspot_recall rows): (f).
--      * ticker relevance and KAP pickup (src/lib/finance/ticker-relevance.ts,
--        kap-pickup.ts, kap-pickup-query.ts): fail-open on a missing row, and
--        ticker_relevance is exempt anyway: (f).
--      * framing_next_headline (068/072): 54 hours. cluster_framing_receipt
--        (068, src/lib/clusters/framing-receipt.ts) reads all framing rows of
--        one cluster at any age: (g) while the cluster is live. ACCEPTABLE
--        beyond that: for a cluster idle longer than the keep window the
--        receipt reports scored = 0, which fails closed (below
--        FRAMING_RECEIPT_PUBLIC_MIN_SCORED the receipt is simply not shown).
--      * Gunun Tayfi (src/lib/game/daily-query.ts): the Istanbul day before
--        the puzzle, replay limited to 7 days (DAILY_REPLAY_DAYS): at most
--        about 9 days.
--      * admin: jev-shadow-status.ts (24 h raw plus a 7-day read through the
--        jev_shadow_agreement_rollup, 168 h raw only as a fallback; 2-day
--        jev_budget_daily), merge-queue.ts (7 days, MERGE_RECALL_WINDOW_DAYS),
--        jev-cluster.ts (7-day blindspot suspects plus vetoed clusters:
--        blindspot_recall, (f)). jev_shadow_queue lists unreviewed
--        disagreements newest first (limit <= 200): older ones fall off the
--        queue, ACCEPTABLE because it is a newest-first triage list and the
--        agreement rate lives on in the rollup.
--      * cluster_topics_refresh (067): rows of members of clusters updated in
--        the last p_since (cron 2 hours, hard clamp 30 days): (g) covers any
--        p_since <= keep.
--      * headline_llm_eligible (069): members of clusters being headlined,
--        fail-safe to the free extractive path: (g).
--      * jev_unlink_triage_refresh (075): pair_positive guard of pending
--        candidates of any age: (f) via pair_positive.
--      * source_karne_refresh (096) and the story threads (098): do not read
--        jev_shadow_predictions at all (grep of both files).
--      * archive-export (supabase/functions/archive-export): exports the
--        previous UTC day nightly (idempotent per day); ACCEPTABLE because a
--        manual backfill POST {"day": ...} older than the keep window would
--        export that day without its labels, so do not backfill past keep.
--      * the jev-shadow Edge Function and 078/090 rollups: the fetch window is
--        24 hours; the re-ask anti-join for cluster-stage tasks is (g).
--
-- DRY RUN: before tightening the keep window, run this read-only SELECT in the
-- SQL editor. It carries the same predicates as the delete (a test pins the
-- two to the same text) and counts, per task, the rows a prune with that
-- cutoff would remove. Change the interval in the first line (21 days or more).
-- DRY-RUN BEGIN
-- with k as (select pg_catalog.now() - interval '30 days' as cutoff)
-- select p.task, count(*) as would_delete
--   from public.jev_shadow_predictions p, k
--  where p.created_at < k.cutoff
--    and p.task not in ('pair_marginal', 'blindspot_recall', 'ticker_relevance', 'kap_class', 'kap_materiality', 'pair_positive')
--    and not exists (select 1 from public.jev_shadow_reviews r where r.prediction_id = p.id)
--    and not exists (select 1 from public.jev_politics_admissions a where a.politics_prediction_id = p.id)
--    and not exists (select 1 from public.jev_gold_set g where g.article_id = p.article_id)
--    and not exists (select 1 from public.jev_gold_set g where g.article_id::text = p.subject_id)
--    and not exists (select 1 from public.jev_regression_items i where i.subject_id = p.subject_id)
--    and not exists (select 1 from public.cluster_articles ca join public.clusters c on c.id = ca.cluster_id where ca.article_id = p.article_id and c.updated_at >= k.cutoff)
--    and not exists (select 1 from public.clusters c where c.id = p.cluster_id and c.updated_at >= k.cutoff)
--    and exists (select 1 from public.jev_shadow_daily d where d.day = (p.created_at at time zone 'utc')::date and d.task = p.task)
--  group by 1
--  order by 2 desc;
-- DRY-RUN END
--
-- LOCAL PROOF (throwaway PostgreSQL 15.12 on port 54402, 2026-10-21; the prune
-- was never run against production)
--   Setup: the shared stub schema, the real 061 (predictions and reviews with
--   their real foreign keys), the real 066 (regression items), the real 081
--   (jev_shadow_daily), a minimal jev_gold_set and a minimal
--   jev_politics_admissions with their real foreign keys. 102 applied twice:
--   both exit 0, the second only adds an 'index already exists, skipping'
--   notice, one ledger row. Without pg_cron the schedule block raises a notice
--   and skips; it was exercised separately against a stand-in cron schema
--   (verbatim DO block, two runs: exactly one job, '50 4 * * *', the
--   statement_timeout command).
--   Seed (9,220 rows, 9,070 older than 21 days): 6,500 plain old rows; 2,500
--   old pair_marginal rows at the LOWEST ids; old rows with a review (2, one
--   reviewed twice), an admission (2), a gold article by article_id (2) and
--   by text subject_id only (1), a regression subject (2), each exempt task
--   (6), a live cluster by article (1) and by cluster_id (1), an unrolled
--   task (1); stale-cluster rows (2) and 50 rows 21 days 1 hour old (all
--   deletable); 50 rows 20 days 23 hours old and 100 rows 5 days old (young).
--   Results (jev_shadow_prune(interval '1 day'): the keep is floored to 21 days):
--     * the floored cutoff is now() - 21 days; the default (45 days) and
--       null both return 'ok: nothing older than cutoff' and delete nothing;
--     * p_batch 1000 / p_max_batches 1 deletes exactly 1000 and reports
--       'ok: batch cap reached'; p_batch 5 is clamped up to 1000 and
--       p_max_batches 0 up to 1; a negative keep is floored too;
--     * the 2,500 old pair_marginal rows at the lowest ids did not starve the
--       window (they are skipped by the locator, not counted against it);
--     * a full run (p_batch 1000) then deleted the remaining 3,552 rows in 4
--       windows; a second run deleted 0;
--     * gone: 6,500 plain + 2 stale-cluster + 50 rows 21 days 1 hour old =
--       6,552, and nothing else. Every exempt class survived, as did the
--       young rows and the one unrolled-task row;
--     * jev_shadow_reviews unchanged (same ids), politics_prediction_id
--       unchanged on every admission, gold and regression sets untouched;
--     * an empty jev_shadow_daily, and one whose newest day is older than the
--       cutoff day, return 'skipped: rollup behind' and delete 0; a rollup
--       that reaches the cutoff day but not that row's (day, task) deletes 0
--       (exemption h); once the (day, task) is rolled up the row goes;
--     * a held session advisory lock returns 'skipped: busy', cutoff null;
--     * anon and authenticated get 'permission denied for function'; the ACL
--       is {postgres, service_role}; the set-null path uses the new index.
--   Scale check on the same instance: 402,668 rows (472 MB), 280,919 older
--   than 21 days; one default run deleted 232,001 rows in 13 windows in about
--   1 second (warm cache), 18.5k live-cluster survivors stayed, the next run
--   deleted 0 in 0.15 s.
--
-- Safe to re-apply: create index if not exists, create or replace function,
-- idempotent cron reschedule, ledger insert on conflict do nothing. Deploy
-- order: apply this migration; before 2026-11-05 back-fill
-- jev_topic7_yardstick_daily (see above). Nothing else to do.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Index on the foreign key of 089's ON DELETE SET NULL
-- ---------------------------------------------------------------------------
-- Without it, every deleted prediction fires the set-null trigger, which seq
-- scans jev_politics_admissions once per deleted row. Partial: the column is
-- null for every shadow-mode claim whose prediction was already set null.

create index if not exists jev_politics_admissions_prediction_idx
  on public.jev_politics_admissions (politics_prediction_id)
  where politics_prediction_id is not null;

-- ---------------------------------------------------------------------------
-- 2. The prune
-- ---------------------------------------------------------------------------

create or replace function public.jev_shadow_prune(
  p_keep        interval default interval '45 days',
  p_batch       int      default 20000,
  p_max_batches int      default 20
)
returns table (deleted bigint, batches int, cutoff timestamptz, note text)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_keep    interval := greatest(coalesce(p_keep, interval '45 days'), interval '21 days');
  v_batch   int      := greatest(1000, least(coalesce(p_batch, 20000), 50000));
  v_max     int      := greatest(1, least(coalesce(p_max_batches, 20), 200));
  v_rolled  date;
  v_hi      bigint;
  v_lo      bigint   := 0;
  v_win_max bigint;
  v_win_n   int;
  v_n       bigint;
begin
  deleted := 0;
  batches := 0;

  -- One prune at a time: a second caller (a manual run racing the 04:50 job)
  -- steps aside. xact-scoped, so it is released at commit or error.
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('jev_shadow_prune', 0)) then
    note := 'skipped: busy';
    return next;
    return;
  end if;

  cutoff := pg_catalog.now() - v_keep;

  -- A day is never deleted before it has been rolled up: the newest rolled-up
  -- day must reach the cutoff's UTC day. (Exemption (h) below also checks each
  -- row's own day and task, which covers a gap in the middle of the history.)
  select pg_catalog.max(d.day) into v_rolled from public.jev_shadow_daily d;
  if v_rolled is null or v_rolled < (cutoff at time zone 'utc')::date then
    note := 'skipped: rollup behind';
    return next;
    return;
  end if;

  -- Scope: the newest row older than the cutoff (created_at index probe). The
  -- id tie-break matters: one gateway call inserts several rows in a single
  -- statement, all with the same created_at, and without it v_hi could land on
  -- the first row of such a group and strand the rest until the next night.
  select p.id into v_hi
    from public.jev_shadow_predictions p
   where p.created_at < cutoff
   order by p.created_at desc, p.id desc
   limit 1;
  if v_hi is null then
    note := 'ok: nothing older than cutoff';
    return next;
    return;
  end if;

  loop
    -- Locate the next window of at most v_batch candidate ids above v_lo.
    select pg_catalog.max(w.id), pg_catalog.count(*) into v_win_max, v_win_n
      from (select p.id
              from public.jev_shadow_predictions p
             where p.id > v_lo and p.id <= v_hi
               and p.created_at < cutoff
               and p.task not in ('pair_marginal', 'blindspot_recall', 'ticker_relevance', 'kap_class', 'kap_materiality', 'pair_positive')
             order by p.id
             limit v_batch) w;
    exit when v_win_n = 0;

    -- Delete the non-exempt rows of that window. Every exemption lives here.
    delete from public.jev_shadow_predictions p
     where p.id > v_lo and p.id <= v_win_max
       and p.created_at < cutoff
       and p.task not in ('pair_marginal', 'blindspot_recall', 'ticker_relevance', 'kap_class', 'kap_materiality', 'pair_positive')
       and not exists (select 1 from public.jev_shadow_reviews r where r.prediction_id = p.id)
       and not exists (select 1 from public.jev_politics_admissions a where a.politics_prediction_id = p.id)
       and not exists (select 1 from public.jev_gold_set g where g.article_id = p.article_id)
       and not exists (select 1 from public.jev_gold_set g where g.article_id::text = p.subject_id)
       and not exists (select 1 from public.jev_regression_items i where i.subject_id = p.subject_id)
       and not exists (select 1 from public.cluster_articles ca join public.clusters c on c.id = ca.cluster_id where ca.article_id = p.article_id and c.updated_at >= cutoff)
       and not exists (select 1 from public.clusters c where c.id = p.cluster_id and c.updated_at >= cutoff)
       and exists (select 1 from public.jev_shadow_daily d where d.day = (p.created_at at time zone 'utc')::date and d.task = p.task);
    get diagnostics v_n = row_count;

    deleted := deleted + v_n;
    batches := batches + 1;
    v_lo := v_win_max;

    exit when v_win_n < v_batch;
    if batches >= v_max then
      note := 'ok: batch cap reached';
      exit;
    end if;
  end loop;

  if note is null then
    note := 'ok';
  end if;
  return next;
end
$fn$;

comment on function public.jev_shadow_prune(interval, integer, integer) is
  'IRREVERSIBLE nightly prune of public.jev_shadow_predictions (migration 102). Deletes rows older '
  'than p_keep (default 45 days, hard floor 21 days; batch clamped 1000..50000, batches 1..200) '
  'in id-keyset batches, in one transaction, and never deletes: rows with a jev_shadow_reviews row, '
  'rows referenced by jev_politics_admissions, gold-set or regression-set subjects, the tasks '
  'pair_marginal, blindspot_recall, ticker_relevance, kap_class, kap_materiality and pair_positive, '
  'rows of a still-live cluster, or rows whose UTC day and task are not yet in jev_shadow_daily. '
  'Returns (deleted, batches, cutoff, note); note is ok, ok: nothing older than cutoff, ok: batch cap '
  'reached, skipped: busy or skipped: rollup behind. Scheduled daily 04:50 UTC as jev-shadow-prune. '
  'Kill switch: update cron.job set active = false where jobname = ''jev-shadow-prune''. After a '
  'prune never re-apply 081 or run a rollup refresh wider than the keep window (see the migration '
  'header). service_role only.';

revoke all on function public.jev_shadow_prune(interval, integer, integer) from public, anon, authenticated;
grant execute on function public.jev_shadow_prune(interval, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Schedule (SQL-only job; pg_net not needed)
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron not installed; skipping jev-shadow-prune schedule (102)';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'jev-shadow-prune') then
    perform cron.unschedule('jev-shadow-prune');
  end if;
  perform cron.schedule('jev-shadow-prune', '50 4 * * *',
    $sql$ set statement_timeout = '10min'; select * from public.jev_shadow_prune(); $sql$);
end
$$;

insert into supabase_migrations.schema_migrations (version, name)
  values ('102', '102_jev_shadow_retention')
  on conflict do nothing;

commit;
