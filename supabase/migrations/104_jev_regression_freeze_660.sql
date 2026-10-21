-- 104_jev_regression_freeze_660.sql
--
-- Carries out the 088 "runbook freeze" that was never run.
--
-- 088 shipped the code side (JEV_REGRESSION_ITEM_LIMIT = 700 per kind and
-- JEV_REGRESSION_CONCURRENCY = 32 in supabase/functions/_shared/jev.ts) and
-- seeded the regression:regression_articles budget at 1.2M tokens for "660
-- frozen articles". The freeze itself, the step that turns every jev_gold_set
-- article into a jev_regression_items row, was never done. Prod still replays
-- 180 items (120 articles + 60 pairs), i.e. the manual
-- jev_regression_freeze(120, 60). docs/migration-guide.md assumes every gold
-- article is already frozen; this file makes that true.
--
-- What it does, in order (one transaction, additive, idempotent):
--   1. takes 066's advisory lock key ('jev_regression_freeze'), so it
--      serializes with the /admin "Seti dondur" button (jev_regression_freeze()).
--      With lock_timeout 5s it fails fast if a freeze is mid-flight.
--   2. inserts EVERY gold article that has no item yet, in gold order
--      (added_at, article_id) so new ids follow added_at. The insert and its
--      state expression are 066 section 5a, copied: state is the snapshot
--      {title, description clamped to 600}, in_gold = true.
--   3. runs 066's documented upgrade path verbatim: a frozen article that is
--      in jev_gold_set but still in_gold = false is flipped to true. It never
--      inserts or deletes.
--   4. guards: raises (and rolls everything back) if the article item count is
--      above 700, or if any gold-set article still lacks an in_gold item.
--      700 is hand-duplicated from JEV_REGRESSION_ITEM_LIMIT
--      (tests/migrations/104-jev-regression-freeze-660.test.ts pins the
--      equality). Above it, fetchRegressionItems("article", 700) orders by id
--      and cuts the tail, so the newest gold rows would silently drop out of
--      the replay.
--   5. the schema_migrations ledger row.
--
-- No pair is touched, nothing is deleted or dropped, no grant changes. Pairs
-- stay at the 60 already frozen. Existing item rows are never refreshed except
-- for the in_gold flag in step 3.
--
-- Prod pre-checks, read-only, run 2026-10-21 22:40 UTC:
--   F1  select kind, count(*), count(*) filter (where in_gold)
--         from jev_regression_items group by 1
--       -> article 120 (all in_gold), pair 60 (none in_gold). No random
--          (in_gold = false) article rows exist, so nothing competes for the
--          700 cap.
--   F2  jev_gold_set joined to articles = 660 (300 originals + 360 opus_seed
--       from 076), jev_gold_set total = 660. 540 gold articles are not yet
--       frozen. 0 frozen articles are gold-but-in_gold=false, so step 3 is a
--       no-op on prod today; it is kept so the file is correct on any copy of
--       the schema where it is not.
--       Expected insert: 540 rows -> 660 gold articles + 60 pairs = 720 items.
--   F3  Why there was no 2026-10-18 regression run:
--       - cron.job_run_details: jev-regression-weekly 'succeeded' on
--         2026-10-18 04:20:02Z (runid 328614, 0.4 s) and on 2026-10-11
--         04:20:00Z (runid 303252). 'succeeded' only proves net.http_post
--         queued the poke.
--       - jev_regression_runs: newest row is id 6 (2026-10-11 04:20Z, ok,
--         items 180). Nothing was written on 10-18.
--       - jev_shadow_runs: ZERO rows in 2026-10-18 04:15Z..05:00Z. In fact no
--         jev_shadow_runs row at all between 2026-10-17 11:20Z and
--         2026-10-18 07:00Z: every jev-shadow tick, whatever its mode, opened
--         no run, although each cron row says 'succeeded'.
--       - jev-shadow was healthy at 145 runs/day through 10-11, then fell to
--         133 / 86 / 65 / 49 / 33 / 27 / 27 / 26 on 10-12..10-19 and was
--         still intermittent on 10-21 (the window of the pg_net response-log
--         bloat incident that 100 guards against). In the same
--         2026-10-17 20:00Z..10-18 07:00Z
--         window 15 other cron jobs failed (articles-vacuum,
--         cluster-topics-refresh, blindspot-recall-veto, the drains,
--         jev-signals-nightly, jev-unlink-triage, prune-nightly, ...).
--       - Conclusion: a cron 'succeeded' with no runs row means jev-shadow
--         threw before startRun (finding 1a, fixed by the jev-hardening item),
--         and the trigger was the DB overload of 10-12..10-21, not anything
--         specific to regression mode (the same gap hit every mode).
--         net._http_response for 10-18 no longer exists (TTL plus the
--         truncate), so the exact HTTP status cannot be recovered.
--
-- Cost of a replay after this file: 660 article items + the 60 pairs = about
-- 720 calls and about 0.8M tokens (660 x ~1,221 input tokens plus the pairs),
-- inside the 1.2M regression:regression_articles allowance 088 seeded.
--
-- First 660-article replay: the next jev-regression-weekly run, Sunday
-- 2026-10-25 04:20 UTC (or a manual select public.jev_regression_trigger();).
-- Runs 5 and 6 (2026-10-04, 2026-10-11) replayed 180 items; they are not
-- same-set with a 720-item replay and do not count toward the JEV-B
-- precondition (docs/jev-pack-slim.md). Do NOT press "Seti dondur" in /admin
-- while that precondition is being collected: with no arguments it tops pairs
-- up to 100, which changes the set. jev-shadow must be writing runs again
-- before 04:20 UTC on the 25th (see jev_shadow_runs).
--
-- Verification (expect: article n = gold = 660 plus any pre-existing random
-- rows, pair = 60; the second query 0):
--   select kind, count(*) n, count(*) filter (where in_gold) gold from public.jev_regression_items group by kind order by kind;
--   select count(*) from public.jev_gold_set g where not exists (select 1 from public.jev_regression_items i where i.kind='article' and i.subject_id=g.article_id::text and i.in_gold);
--
-- Re-applying is a no-op: 0 rows inserted (on conflict do nothing), 0 rows
-- flipped, guards pass, the ledger insert is on conflict do nothing.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- 1. Serialize with jev_regression_freeze() (the /admin "Seti dondur" button).
do $lock$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('jev_regression_freeze'));
end
$lock$;

-- 2. Freeze every gold article that has no item yet (066 section 5a).
insert into public.jev_regression_items (kind, subject_id, state, in_gold)
select 'article', a.id::text,
       jsonb_build_object('title', a.title,
                          'description', left(coalesce(a.description, ''), 600)),
       true
  from public.jev_gold_set g
  join public.articles a on a.id = g.article_id
 order by g.added_at, g.article_id
on conflict (kind, subject_id) do nothing;

-- 3. 066 upgrade path: a frozen article that later entered jev_gold_set.
update public.jev_regression_items i
set in_gold = true
from public.jev_gold_set g
where i.kind = 'article'
  and i.subject_id = g.article_id::text
  and not i.in_gold;

-- 4. Guards. Either one rolls the whole migration back.
do $guard$
declare
  v_articles int;
  v_unfrozen int;
begin
  select count(*)::int into v_articles
    from public.jev_regression_items i
   where i.kind = 'article';
  if v_articles > 700 then
    raise exception '104: % article items in jev_regression_items exceed 700 (JEV_REGRESSION_ITEM_LIMIT); fetchRegressionItems would cut the newest gold rows out of every replay', v_articles;
  end if;

  select count(*)::int into v_unfrozen
    from public.jev_gold_set g
   where not exists (
     select 1
       from public.jev_regression_items i
      where i.kind = 'article'
        and i.subject_id = g.article_id::text
        and i.in_gold
   );
  if v_unfrozen > 0 then
    raise exception '104: % jev_gold_set article(s) still have no in_gold regression item', v_unfrozen;
  end if;

  raise notice '104: % article items frozen, every jev_gold_set article has an in_gold item', v_articles;
end
$guard$;

-- 5. Ledger.
insert into supabase_migrations.schema_migrations (version, name)
  values ('104', '104_jev_regression_freeze_660')
  on conflict do nothing;

commit;
