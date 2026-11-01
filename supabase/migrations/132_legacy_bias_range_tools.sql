-- 132_legacy_bias_range_tools.sql
--
-- Operator tools for the legacy "Kör nokta" flags: three service_role-only
-- functions that re-derive clusters.bias_distribution from the voting members and
-- withdraw the blindspot flags that fail the current rule, one updated_at window
-- of at most 31 days per call, dry run by default. Applying this file writes
-- nothing to any table but the ledger: it backfills nothing. The repair is run by
-- an operator, window by window, with scripts/recompute-legacy-bias.mjs (see
-- docs/migration-guide.md), dry run first.
--
-- WHY (h10-data-1, hunt 10, 2026-11-01)
--   034 split sources into voting kinds (outlet, wire) and non-voting kinds
--   (aggregator, niche) and re-derived clusters.bias_distribution for the last
--   48 hours only (034 section 5, recompute_bias_distribution(now() - 48 h)).
--   Every older cluster still stores the aggregator and niche votes it was
--   counted with, and 032 derived is_blindspot from that stored distribution. So a
--   cluster can wear a public "Kör nokta" badge while the page itself lists its
--   aggregator and niche members as "spektruma sayılmaz":
--     /cluster/861b4249-f553-41b7-be98-45544008b1bc shows "Kör nokta", "Spektrum 5
--     kaynaktan oluşturuldu" and "Denge puanı 46/100" next to "Toplayıcı / niş
--     kaynaklar 1 kaynak · spektruma sayılmaz Haberler.com Toplayıcı";
--     /cluster/95420045-9a07-4117-858e-a1fdad7bb1dc shows "Merkez %80 Muhalefet %20
--     Spektrum 5 kaynaktan oluşturuldu" while listing F5 Haber (Toplayıcı) and
--     Dünya (Niş) as "spektruma sayılmaz".
--   The same stored fields feed the /hafta archives, the v1 API, the OG images and
--   the embeds. Measured read-only on production (STEP 0): of the 444 flagged
--   clusters with updated_at before 2026-09-05, 330 store a distribution that
--   differs from their voters' and 215 fail the rule (none is archived, none is
--   recall-vetoed; the newest false flag was updated 2026-09-04 13:55:01Z).
--   Why not just run public.recompute_blindspot_flags() (032): it would also
--   newly flag the 153 older clusters that pass the rule but carry no flag. They
--   were never recall-checked (071, 126), so they are counted for a human and
--   never set. Why not a data migration: the distribution of 66,494 old clusters
--   differs from their voters' (57,278 of them go to all zeros because every
--   member is an aggregator or niche source; 9,368 have article_count >= 2), and
--   a repair of that size is run, watched and verified by an operator, window by
--   window, not inside a deploy.
--
-- WHAT CHANGES (pinned by tests/migrations/132-legacy-bias-range-tools.test.ts
-- and tests/migrations/zone-parity.test.ts)
--   1. public.legacy_bias_voter_dists(p_from, p_to) returns table(cluster_id,
--      stored, dist, is_blindspot, rule_ok): language sql, STABLE, security
--      definer, search_path ''. READ ONLY. For the clusters with updated_at in
--      [p_from, least(p_to, p_from + 31 days)) it rebuilds the ten-key
--      distribution from the voting members (cluster_articles -> articles ->
--      sources, kind in ('outlet', 'wire'), one vote per article, left join so a
--      cluster without voters gets all zeros: 034's CTE and 064's counting) and
--      applies the contract of supabase/functions/_shared/cluster/blindspot.ts
--      (zone CASE of 032, at least 5 voters, dominant zone share at least 0.8) to
--      it. rule_ok is never null.
--   2. public.recompute_bias_distribution_range(p_from, p_to, p_dry_run default
--      true) returns table(scanned, would_change, changed): plpgsql, volatile,
--      security definer, search_path '', lock_timeout 5 s. One UPDATE, inside
--      `if not v_dry_run`, setting bias_distribution only, only where it differs.
--   3. public.clear_false_blindspots_range(p_from, p_to, p_dry_run default true)
--      returns table(would_clear, would_newly_flag, cleared): same attributes. One
--      UPDATE, inside `if not v_dry_run`, setting is_blindspot = false and
--      blindspot_side = null, only where the flag is set and the rule fails.
--   4. revoke all from public, anon, authenticated; grant execute to service_role,
--      a comment on each function, the ledger row.
--   Write surface of the whole file: exactly two `set` clauses on data
--   (bias_distribution = d.dist; is_blindspot = false, blindspot_side = null). So
--   the tools never write updated_at (the home feed order and the /api/health
--   liveness signal; public.clusters has no trigger, STEP 0), never set
--   is_blindspot to true and never touch blindspot_recall_veto or
--   blindspot_veto_reason (126's refresh clears a stale veto by itself). This
--   file creates no table, index or trigger, drops nothing, alters nothing and
--   schedules nothing. It starts with set local lock_timeout = '5s'.
--
-- HOW A CALL BEHAVES
--   * Dry run by default: p_dry_run omitted, true or NULL (coalesce(p_dry_run,
--     true)) only counts. p_dry_run => false writes.
--   * p_from or p_to NULL, or p_to <= p_from: errcode 22023. The window is clamped
--     to least(p_to, p_from + 31 days); the operator script steps by 7 days.
--   * One 132 call at a time: pg_try_advisory_xact_lock(hashtext('132_legacy_
--     bias_range_tools')); a second caller gets errcode 55P03 at once.
--   * The clear tool evaluates the rule on the voter-derived distribution, which is
--     the stored one once the recompute has run for the window, so its dry run shows
--     the real 215 before anything is written. Run recompute, then clear, per window
--     (the script does).
--   * Race with the live consumer. cluster_link_atomic and cluster_unlink_article
--     take the per-cluster advisory lock and then stamp updated_at = now() on the
--     cluster row. Both UPDATEs repeat the window on the target row (c.updated_at
--     >= p_from and c.updated_at < v_to): if a link commits while the UPDATE waits
--     for that row, the recheck (EvalPlanQual) sees the new updated_at, which is
--     outside the window, and skips the row, so a fresh distribution is never
--     overwritten with the snapshot the call started from. The count of changed rows
--     can therefore be lower than would_change. A deadlock with a concurrent merge
--     (099) would abort one side with 40P01; rerun the window. lock_timeout 5 s
--     bounds any wait (55P03).
--   * No statement_timeout is set: a function-level SET cannot re-arm a timer that
--     is already running. PostgREST connects as authenticator, whose
--     statement_timeout is 8 s (063), so each call is bounded by 8 s. A call that
--     needs longer fails with 57014, the whole call rolls back and nothing
--     changes; rerun that window with --days 1. The dry run touches the same pages
--     and warms them: see STEP 0, e).
--   * A SQL function plans with its parameters (no value sniffing) and estimates
--     the window at 0.5% of the table. An earlier draft joined the window CTE
--     inside the votes CTE, so the generic plan rescanned that CTE once per
--     cluster: 4,110 ms for 13,720 clusters on a local scratch table, against 93 ms
--     for the final text (the test pins that votes does not mention the window).
--
-- STEP 0 (production, read-only, 2026-11-01, via SELECT only; nothing was applied)
--   Every statement ran with SBQ_TIMEOUT=60 python3 .../sbq.py -e "...".
--   a) select count(*) from supabase_migrations.schema_migrations where version = '132';
--      0. Version 132 is free (the newest three-digit version is 131).
--      select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--       where n.nspname = 'public' and p.proname in ('legacy_bias_voter_dists',
--       'recompute_bias_distribution_range', 'clear_false_blindspots_range');
--      0: none of the three names exists.
--   b) select count(*) from pg_trigger where tgrelid = 'public.clusters'::regclass
--       and not tgisinternal;
--      0. Nothing fires on an UPDATE of clusters, so updated_at stays as it is.
--   c) select min(updated_at), count(*), count(*) filter (where updated_at <
--      '2026-09-05') from public.clusters;
--      2009-01-08 10:13:50+00, 259,124 and 182,778. By month of updated_at: 183
--      clusters before 2026-04-01 (a few from 2009 on), then 27,878 (April),
--      26,536, 45,772, 38,469, 38,267 and 5,673 (1 to 4 September). The live range
--      starts on 2026-04-01; the script allows at most 200 windows, so start there.
--   d) The helper body inlined as a SELECT with literal bounds (the text between the
--      fn quotes below, p_from and p_to replaced by timestamptz literals), final
--      select count(*) as scanned, count(*) filter (where stored is distinct from
--      dist) as would_change, count(*) filter (where is_blindspot and not rule_ok)
--      as would_clear, count(*) filter (where not is_blindspot and rule_ok) as
--      would_newly_flag, per month (about 20 s a month, cold):
--        updated_at in            scanned  would_change  would_clear  would_newly_flag
--        before 2026-04-01            183            22            0                 0
--        2026-04                   27,878         9,743           56                25
--        2026-05                   26,536         8,983           40                27
--        2026-06                   45,772        17,908           50                45
--        2026-07                   38,469        15,060           40                30
--        2026-08                   38,267        12,815           25                24
--        2026-09-01 to 09-04        5,673         1,963            4                 2
--        total                    182,778        66,494          215               153
--      would_go_to_zero_total (voter total 0 while the stored distribution counts
--      something): 22 + 7,808 + 7,158 + 15,533 + 13,451 + 11,529 + 1,777 = 57,278;
--      clear_with_zero_total (a flag on a cluster with no voter at all): 0.
--      Flagged clusters in the range: 444 (116 + 94 + 102 + 80 + 46 + 6), of which
--      330 store a distribution that differs from the voters' and 229 stay flagged
--      after the repair. With article_count >= 2 (what the lists show) 9,368
--      distributions change, 3,301 of them with article_count >= 5; the votes
--      counted in those clusters fall from 63,510 to 49,926.
--      215 and 153 are the numbers of the finding (the 330 is its stored-vs-voter
--      mismatch among flagged clusters); the 66,494 is the number of rows the
--      recompute rewrites, nearly all of them singleton aggregator clusters no list
--      shows.
--   e) EXPLAIN ANALYZE, as EXPLAIN (ANALYZE, BUFFERS) EXECUTE of the helper body prepared with
--      plan_cache_mode = force_generic_plan (the way a SQL function plans), SELECT
--      only, final select count(*) with the rule_ok and stored-vs-dist filters (a
--      bare count(*) lets the planner drop the verdict joins). The busiest 7-day
--      window, 2026-04-22 to 2026-04-29: 13,720 clusters (would_change 4,256,
--      would_clear 29, would_newly_flag 13), nested loops with primary-key probes
--      (index only scan on cluster_articles_pkey, articles_pkey, sources_pkey).
--      Cold (first touch, 14,899 buffers read): 4,929 ms. Warm: 458 ms and 442 ms
--      (2,344 ms once other scans had evicted part of the pages). Another busy
--      window, 2026-06-10 to 2026-06-17 (10,235 clusters), cold: 3,101 ms. One
--      evaluation fits 8 s, cold or warm; an apply call evaluates the helper twice
--      and then updates, so run the dry run of a window first (it warms the pages)
--      and apply in a quiet window. A local apply of 13,720 changing rows took 243
--      ms (no prod indexes or bloat: only indicative).
--
-- DRY RUNS (×2) (local PG15.12, throwaway cluster, 2026-11-01; the shared stub
-- schema plus, added in a scratch setup and not in this file: default privileges
-- that mimic Supabase's (alter default privileges in schema public grant execute
-- on functions to anon, authenticated, so every function is born executable by
-- both). This file was applied twice in a row, each with psql -v ON_ERROR_STOP=1 -f:
--   run 1   BEGIN, SET, then three times CREATE FUNCTION, COMMENT, REVOKE, GRANT,
--           then INSERT 0 1, COMMIT
--   run 2   the same statements, no error, no notice; the ledger insert is INSERT 0 0
--   After   ledger 132 (132_legacy_bias_range_tools). md5(prosrc), length, security
--           definer, volatility, proconfig, acl:
--             legacy_bias_voter_dists            2e2c9e272fe04735769844b7d0f0cd07  4642  t  s
--               {"search_path=\"\""}                      {postgres=X/postgres,service_role=X/postgres}
--             recompute_bias_distribution_range  2b09fbec3ab93e80e4e0d595e9897be8  2042  t  v
--               {"search_path=\"\"",lock_timeout=5s}      {postgres=X/postgres,service_role=X/postgres}
--             clear_false_blindspots_range       7bea8bfa8764b7ef203b3c1991fea975  2184  t  v
--               {"search_path=\"\"",lock_timeout=5s}      {postgres=X/postgres,service_role=X/postgres}
--           (the texts between the fn quotes of this file; the test recomputes the md5
--           and the length). The mimicked default privileges had granted execute to
--           anon and authenticated on creation; the revoke stripped them.
--           has_function_privilege execute: anon f, authenticated f, service_role t,
--           for all three.
--   Scenario (rolled-back transactions; the TAYF_PSQL block of the test runs the
--           same cases). Sources: five pro_government outlets (S0 to S4), two
--           opposition outlets (S5, S7), one pro_government aggregator (S6); one
--           article per source. Clusters, each with its own updated_at in June 2026
--           unless noted: L1 = 4 outlets + the aggregator, stored {pro_government:5},
--           flagged (the false flag); L2 = 4 outlets + 1 opposition, stored correct,
--           flagged (4 of 5 is exactly 0.8, stays); L3 = 5 outlets, stored correct,
--           not flagged (would newly flag); L4 = like L1 but updated_at 2026-10-01
--           (outside the window); L5 = no members, stored {pro_government:5},
--           flagged (zero total); L6 = 5 outlets + 2 opposition, stored correct, not
--           flagged (5 of 7 is 0.714).
--           Window 2026-06-01 .. 2026-07-01. 2-argument calls (the default): recompute
--           (5, 2, 0), clear (2, 1, 0); with p_dry_run => null the same; md5 of
--           string_agg(row(c.*)::text) over all clusters identical before and after.
--           Apply: recompute (5, 2, 2), clear (2, 1, 2). L1: ten keys, pro_government
--           4, the rest 0, is_blindspot f, side null. L5: ten zeros, f, null. L2 stays
--           flagged, side pro_government. L3 stays f. L4 byte-identical. Every
--           cluster's updated_at unchanged. A second apply: recompute (5, 0, 0), clear
--           (0, 1, 0). From 2026-06-01 to 2026-12-31 the call is clamped to 31 days
--           (L4 not scanned, byte-identical after an apply); from 2026-05-01 it scans
--           nothing. An inverted, empty or NULL window raises 22023 in both writers
--           even with p_dry_run => false, and writes nothing.
--           Mutation checks (each applied to the database only): a writer that ignores
--           p_dry_run (6 live tests fail), a clear without `not d.rule_ok` (4 fail), a
--           recompute that also writes updated_at (6 fail), an aggregator added to the
--           voting kinds (6 fail), a share of 0.7 instead of 0.8 (6 fail), a minimum
--           of 4 voters (6 fail), a strict > 0.8 (6 fail), a clear that leaves
--           blindspot_side set (2 fail); with the original functions back all 20 pass.
--           Ten mutations of this file (clear window dropped, dry run not the default,
--           a flag set from the rule, an extra grant, search_path removed, a top-level
--           select, no clamp, a share of 0.85, votes joining the window CTE, a veto
--           column written) each fail 1 to 4 of the static tests.
--   Agreement with production's rule: 3,000 random clusters (0 to 12 member articles
--           from 40 sources of ten biases and the four kinds, a dominant zone of
--           random purity, 559 of them passing the rule, 552 of those with 5 to 8
--           voters) were counted by the helper, then recomputed by 064's
--           cluster_unlink_article(cluster, null) (its function block loaded in the
--           scratch database): 0 distributions and 0 flags differed.
--   Concurrency (two psql sessions on a committed scratch fixture, then removed):
--           (1) A holds the advisory key for 4 s; B starts a dry run of each writer 1 s
--           later and gets errcode 55P03 at once ("another 132 tool call holds the
--           lock"); after A rolled back, B's dry run returned 2, 2, 0.
--           (2) A stamps updated_at = now() and a new distribution on L1 and holds the
--           row for 4 s; B's apply 1 s later waits, then returns recompute (2, 2, 1) and
--           clear (1, 0, 1): L1 keeps A's distribution and its flag (skipped on the
--           recheck), L5 is repaired.
--   Rollback rehearsed: the three drop statements and the ledger delete (below), then
--           this file twice more: INSERT 0 1, then INSERT 0 0; md5(prosrc) as above.
--
-- DEPLOY: APPLY 132 ONLY (no app or edge deploy)
--   Apply this file (additive; nothing in the app calls the functions). Nothing
--   changes until an operator runs scripts/recompute-legacy-bias.mjs: dry run over
--   2026-04-01 .. 2026-09-05 first, compare its TOTAL line with the table in STEP 0 d),
--   snapshot the rows that will change, then --apply in a quiet window, then re-run the
--   dry run (every would_change and would_clear must be 0). The runbook is the 132
--   section of docs/migration-guide.md.
--   Expected effects: the "Kör nokta" badge goes from 215 old clusters; the bias bars
--   of about 66k old clusters stop counting aggregator and niche votes (the 9,368 with
--   article_count >= 2 are visible, and closed /hafta weeks for April to September
--   shift slightly); the cached pages show it when their cacheLife expires (no
--   revalidation is triggered). The 153 clusters that would newly flag are listed for
--   the founder and never flagged by the tools.
--   Known limit: the tools do not recompute blindspot_side of a flag that stays (about
--   21 of the 229 surviving flags in the range store a side that is not the top category
--   of the voter distribution, measured against the global top key); that needs a third
--   set clause and is left to a follow-up.
--
-- VERIFY (read-only)
--   select p.proname, md5(p.prosrc), length(p.prosrc), p.prosecdef, p.provolatile
--     from pg_proc p where p.oid in (
--       'public.legacy_bias_voter_dists(timestamptz, timestamptz)'::regprocedure,
--       'public.recompute_bias_distribution_range(timestamptz, timestamptz, boolean)'::regprocedure,
--       'public.clear_false_blindspots_range(timestamptz, timestamptz, boolean)'::regprocedure)
--     order by 1;
--       -- expect, in this order:
--       --   clear_false_blindspots_range       7bea8bfa8764b7ef203b3c1991fea975, 2184, t, v
--       --   legacy_bias_voter_dists            2e2c9e272fe04735769844b7d0f0cd07, 4642, t, s
--       --   recompute_bias_distribution_range  2b09fbec3ab93e80e4e0d595e9897be8, 2042, t, v
--   select has_function_privilege('anon', '<signature>', 'execute'),
--          has_function_privilege('authenticated', '<signature>', 'execute'),
--          has_function_privilege('service_role', '<signature>', 'execute');
--       -- for each of the three signatures: expect f, f, t
--   select count(*) from supabase_migrations.schema_migrations where version = '132';  -- 1
--
-- ROLLBACK (nothing depends on 132; the data a --apply wrote is not undone by it)
--     drop function if exists public.recompute_bias_distribution_range(timestamptz, timestamptz, boolean);
--     drop function if exists public.clear_false_blindspots_range(timestamptz, timestamptz, boolean);
--     drop function if exists public.legacy_bias_voter_dists(timestamptz, timestamptz);
--     delete from supabase_migrations.schema_migrations where version = '132';
--   Rows repaired by --apply keep their repaired values. Restore them from the CSV
--   snapshot the runbook takes before --apply (id, bias_distribution, is_blindspot,
--   blindspot_side), with a one-off update from that file.
--
-- Additive. Safe to re-apply (create or replace function, ledger insert on conflict
-- do nothing). One transaction; the only lock of note is the catalog lock create or
-- replace function takes on these three functions, bounded by lock_timeout = 5 s: on
-- 55P03 nothing is recorded, re-apply. No CONCURRENTLY step, no cron change, no new
-- table, no table grant.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- legacy_bias_voter_dists: the read-only core. For every cluster whose
-- updated_at falls in [p_from, least(p_to, p_from + 31 days)) it re-derives the
-- bias distribution from the VOTING members (outlet and wire), exactly the way
-- 034 and 064 count it, and answers whether that distribution passes the
-- blindspot rule. Writes nothing. STABLE: one snapshot per statement.
-- ---------------------------------------------------------------------------

create or replace function public.legacy_bias_voter_dists(p_from timestamptz, p_to timestamptz)
returns table(cluster_id uuid, stored jsonb, dist jsonb, is_blindspot boolean, rule_ok boolean)
language sql
stable
security definer
-- Empty search_path + schema-qualified identifiers so a session role with
-- CREATE on pg_temp cannot shadow an unqualified call inside this SECURITY
-- DEFINER body (the hardening 025/027/064/121/128 carry).
set search_path = ''
as $fn$
  -- The clusters of the window. updated_at is the only filter, so the planner
  -- uses idx_clusters_updated_at; the 31-day clamp bounds what one call reads
  -- even if a caller passes a huge p_to.
  with win as (
    select c.id as id,
           c.bias_distribution as stored,
           coalesce(c.is_blindspot, false) as is_blindspot
      from public.clusters c
     where c.updated_at >= p_from
       and c.updated_at < least(p_to, p_from + interval '31 days')
  ),
  -- 034's votes: one vote per member article, voting source kinds only
  -- (supabase/functions/_shared/cluster/source-kind.ts VOTING_SOURCE_KINDS).
  votes as (
    select ca.cluster_id as cluster_id, s.bias as bias
      from public.cluster_articles ca
      join public.articles a on a.id = ca.article_id
      join public.sources s on s.id = a.source_id
     where s.kind in ('outlet', 'wire')
  ),
  -- 034's dists: the left join gives a cluster without voting members the
  -- all-zero distribution; all ten keys are always present. Key list = BIAS_KEYS
  -- in blindspot.ts order; zone-parity.test.ts enforces it against the key
  -- literals below.
  dists as (
    select w.id as id,
           w.stored as stored,
           w.is_blindspot as is_blindspot,
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
      from win w
      left join votes v on v.cluster_id = w.id
     group by w.id, w.stored, w.is_blindspot
  ),
  -- Zone tally over the freshly built distribution. Zone CASE copied verbatim
  -- from BIAS_TO_ZONE in supabase/functions/_shared/cluster/blindspot.ts (the
  -- same copy 032 and 064 carry). Keep in sync: zone-parity.test.ts enforces it.
  counts as (
    select d.id as id,
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
      from dists d
     cross join lateral pg_catalog.jsonb_each_text(d.dist) as e(bias_key, bias_count)
     where e.bias_key in (
             'pro_government', 'gov_leaning', 'state_media', 'center',
             'opposition_leaning', 'opposition', 'nationalist',
             'islamist_conservative', 'pro_kurdish', 'international'
           )
       and (e.bias_count)::int > 0
  ),
  zone_totals as (
    select c.id as id, c.zone as zone, pg_catalog.sum(c.n)::int as zone_n
      from counts c
     group by c.id, c.zone
  ),
  verdicts as (
    select z.id as id,
           pg_catalog.sum(z.zone_n)::int as total,
           pg_catalog.max(z.zone_n)::int as top_n
      from zone_totals z
     group by z.id
  )
  -- The contract in blindspot.ts (and 064's cluster_unlink_article): at least
  -- BLINDSPOT.minSources = 5 voting articles and the dominant zone holds at least
  -- BLINDSPOT.dominantShare = 0.8 of them. Never null: no voters means no flag.
  select d.id as cluster_id,
         d.stored as stored,
         d.dist as dist,
         d.is_blindspot as is_blindspot,
         coalesce(t.total >= 5 and t.top_n::numeric / nullif(t.total, 0) >= 0.8, false) as rule_ok
    from dists d
    left join verdicts t on t.id = d.id
$fn$;

comment on function public.legacy_bias_voter_dists(timestamptz, timestamptz) is
  'Read-only (migration 132, h10-data-1). For each cluster with updated_at in [p_from, least(p_to, p_from + 31 days)): '
  'stored = clusters.bias_distribution, dist = the distribution re-derived from the voting members only '
  '(sources.kind outlet or wire, one vote per article, ten keys, zeros included), is_blindspot = the stored flag, '
  'rule_ok = whether dist passes the contract (at least 5 voters, dominant zone share at least 0.8). '
  'Writes nothing. Used by recompute_bias_distribution_range and clear_false_blindspots_range and by the operator snapshot in docs/migration-guide.md. '
  'service_role only.';

revoke all on function public.legacy_bias_voter_dists(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.legacy_bias_voter_dists(timestamptz, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- recompute_bias_distribution_range: 034's backfill for a window of any age.
-- Dry run by default: writes only when called with p_dry_run => false.
-- VOLATILE (the default) on purpose: every statement must see what the
-- previous lock holder committed.
-- ---------------------------------------------------------------------------

create or replace function public.recompute_bias_distribution_range(
  p_from timestamptz,
  p_to timestamptz,
  p_dry_run boolean default true
)
returns table(scanned integer, would_change integer, changed integer)
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $fn$
declare
  v_dry_run boolean := coalesce(p_dry_run, true);
  v_to timestamptz;
begin
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception using
      errcode = '22023',
      message = '132 recompute_bias_distribution_range: p_from and p_to are required and p_to must be after p_from';
  end if;

  -- One call never reads or writes more than 31 days.
  v_to := least(p_to, p_from + interval '31 days');

  -- One 132 tool at a time (the two writers share the key). Advisory locks do
  -- not wait here: a second operator gets 55P03 at once instead of queueing.
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('132_legacy_bias_range_tools')) then
    raise exception using
      errcode = '55P03',
      message = '132 recompute_bias_distribution_range: another 132 tool call holds the lock; wait for it and retry';
  end if;

  select pg_catalog.count(*)::integer,
         (pg_catalog.count(*) filter (where d.stored is distinct from d.dist))::integer
    into scanned, would_change
    from public.legacy_bias_voter_dists(p_from, v_to) d;

  changed := 0;

  if not v_dry_run then
    -- Plain UPDATE, only rows that differ, bias_distribution only: updated_at is
    -- NOT written (it is the home feed order and the /api/health liveness signal;
    -- clusters has no trigger). The WHERE repeats the window on the TARGET row:
    -- if cluster_link_atomic commits a link to one of these clusters while this
    -- statement waits for its row lock, the recheck (EvalPlanQual) sees the new
    -- updated_at = now(), which is outside the window, and skips the row. The
    -- consumer's fresh distribution is never overwritten with this snapshot.
    update public.clusters c
       set bias_distribution = d.dist
      from public.legacy_bias_voter_dists(p_from, v_to) d
     where c.id = d.cluster_id
       and c.updated_at >= p_from
       and c.updated_at < v_to
       and c.bias_distribution is distinct from d.dist;
    get diagnostics changed = row_count;
  end if;

  return next;
end;
$fn$;

comment on function public.recompute_bias_distribution_range(timestamptz, timestamptz, boolean) is
  'Operator tool (migration 132, h10-data-1). Re-derives clusters.bias_distribution from the voting members '
  '(outlet, wire) for clusters with updated_at in [p_from, least(p_to, p_from + 31 days)), the way 034 did for the last 48 hours. '
  'Dry run by default: p_dry_run true or null only counts (scanned, would_change); p_dry_run => false writes the rows that differ and returns changed. '
  'Never writes updated_at. Raises 22023 for a null or inverted window, 55P03 while another 132 tool call runs. '
  'Run clear_false_blindspots_range after it for the same window. service_role only.';

revoke all on function public.recompute_bias_distribution_range(timestamptz, timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.recompute_bias_distribution_range(timestamptz, timestamptz, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- clear_false_blindspots_range: withdraw the Kör nokta flags that fail the rule.
-- Only ever clears; never sets a flag.
-- ---------------------------------------------------------------------------

create or replace function public.clear_false_blindspots_range(
  p_from timestamptz,
  p_to timestamptz,
  p_dry_run boolean default true
)
returns table(would_clear integer, would_newly_flag integer, cleared integer)
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $fn$
declare
  v_dry_run boolean := coalesce(p_dry_run, true);
  v_to timestamptz;
begin
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception using
      errcode = '22023',
      message = '132 clear_false_blindspots_range: p_from and p_to are required and p_to must be after p_from';
  end if;

  -- One call never reads or writes more than 31 days.
  v_to := least(p_to, p_from + interval '31 days');

  -- Same advisory key as recompute_bias_distribution_range: one 132 tool at a time.
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('132_legacy_bias_range_tools')) then
    raise exception using
      errcode = '55P03',
      message = '132 clear_false_blindspots_range: another 132 tool call holds the lock; wait for it and retry';
  end if;

  -- The rule is evaluated on the voter-derived distribution, which is the stored
  -- one once recompute_bias_distribution_range has run for the window, so a dry
  -- run shows the real number before anything is written. would_newly_flag
  -- counts clusters that pass the rule but carry no flag: they were never
  -- recall-checked (071, 126), so they are reported for a human and never set.
  select (pg_catalog.count(*) filter (where d.is_blindspot and not d.rule_ok))::integer,
         (pg_catalog.count(*) filter (where not d.is_blindspot and d.rule_ok))::integer
    into would_clear, would_newly_flag
    from public.legacy_bias_voter_dists(p_from, v_to) d;

  cleared := 0;

  if not v_dry_run then
    -- Clears the flag and its side, nothing else: updated_at and the recall-veto
    -- columns are untouched (126 refreshes a stale veto by itself). The WHERE
    -- repeats the window on the TARGET row, so the recheck (EvalPlanQual) skips a
    -- cluster that cluster_link_atomic re-stamped while this statement waited.
    update public.clusters c
       set is_blindspot = false, blindspot_side = null
      from public.legacy_bias_voter_dists(p_from, v_to) d
     where c.id = d.cluster_id
       and c.updated_at >= p_from
       and c.updated_at < v_to
       and c.is_blindspot
       and not d.rule_ok;
    get diagnostics cleared = row_count;
  end if;

  return next;
end;
$fn$;

comment on function public.clear_false_blindspots_range(timestamptz, timestamptz, boolean) is
  'Operator tool (migration 132, h10-data-1). Withdraws the Kör nokta flag (is_blindspot = false, blindspot_side = null) '
  'from clusters with updated_at in [p_from, least(p_to, p_from + 31 days)) whose voting members no longer satisfy the contract '
  '(at least 5 voters, dominant zone share at least 0.8). Dry run by default: counts would_clear and would_newly_flag '
  '(clusters that pass the rule but are not flagged; reported only, this tool never sets is_blindspot to true). '
  'p_dry_run => false clears and returns cleared. Never writes updated_at or the recall-veto columns. '
  'Raises 22023 for a null or inverted window, 55P03 while another 132 tool call runs. service_role only.';

revoke all on function public.clear_false_blindspots_range(timestamptz, timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.clear_false_blindspots_range(timestamptz, timestamptz, boolean) to service_role;

-- Ledger ---------------------------------------------------------------------------

insert into supabase_migrations.schema_migrations (version, name)
  values ('132', '132_legacy_bias_range_tools')
  on conflict do nothing;

commit;
