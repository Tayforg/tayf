-- 180_blindspot_sibling_rare_tier.sql
--
-- Blindspot sibling veto, second evidence tier: two titles that share fewer stems than
-- 148's Jaccard 0.5 still count as the same story when at least two of the shared stems
-- are RARE in the member article's own search window. Change nothing else: this file is
-- 148's function body plus two CTEs (wdf, wlim), two joins, one GROUP BY column and a wider
-- HAVING in the pairs CTE, the function comment, the grants and the ledger row. No cron
-- change (the command 148 set, with statement_timeout = '120s', stays), no data write, no
-- backfill.
--
-- WHY (production, read-only, 2026-11-08; finding h85-blindspotprecision-1, adjudicated the
-- same day). The 148 pair rule (3 shared stems and Jaccard >= 0.5) misses the same story run
-- under a different headline, so a public "kor nokta" claim stands while the silent zone ran
-- the event:
--   * 30b3b262-01db-4463-8580-dbaad0f321f4 ("Ruhsatli silah sahiplerine yeni zorunluluk",
--     celik kasa sarti): is_blindspot = true, blindspot_recall_veto = false, past the 24 h
--     delay; /cluster/30b3b262 renders "Kor nokta" and "Bagimsiz 0 manset ... bu tarafta
--     sessizlik". Muhalefet elips-haber (05:11), yenicag (09:31) and cumhuriyet (11:13) and
--     Bagimsiz on-haber ran the story in genel, all in no cluster. Best pairs sit below
--     the rule: cumhuriyet 6 shared stems / Jaccard 0.43, elips-haber 6 / 0.40.
--   * f1837ee1-37e0-4830-86e9-9db22797f301 ("Bakan Bayraktar: 2040'ta enerjide bagimsiz
--     olacagiz", Milli Enerji 2040): /cluster/f1837ee1 renders "Spektruma sayilan
--     Muhalefet kaynaklarindan bu kumede haber yok (kor nokta)" while indyturk, haberport,
--     haberet and dw-turkce (Bagimsiz) and bha (Muhalefet) ran it.
--   * Not reachable by any title rule: 23132be4 ("Fransa'da genel grev", generic wording,
--     best pairs 3 shared stems / 0.33).
-- The finding's read-only replica of the 148 rule over the 52 public unvetoed claims first
-- published 2026-11-01 to 2026-11-07 left every one standing (it agrees with the stored
-- flags). Its trials of plain looser thresholds on the same 52: Jaccard >= 0.3 with 2 outlets
-- per zone flips about 22; 5 shared stems with Jaccard >= 0.4 flips 4, one of them a
-- different event (bb8f5ea3, Goktas and Kacir announcing different flood aid).
--
-- THE TIER. A stem pair is the strict tier (126) when it shares >= 3 stems with Jaccard
-- >= 0.5. It is the rare tier (180) when it shares >= 3 stems, Jaccard >= 0.3 and at least 2
-- of the shared stems are rare in the MEMBER's window. The window belongs to each member
-- article of the blindspot, never to the run: it is the voting-source (outlet, wire)
-- candidate articles of scand published within 24 hours either side of that member, which is
-- exactly the pool a pair can be drawn from. A stem's document frequency is the number of
-- distinct such articles whose title holds it (wdf, one row per member article and stem); it
-- is rare when that is at most 0.25 percent of the distinct articles of the same window (wlim,
-- one line per member article). A stem that names the event (kasa, ruhsa, selde) is rare; one
-- that does not (bakan, milyon, lira, yeni) is not, which is why bb8f5ea3 (5 shared stems,
-- Jaccard 0.36, only selde rare) stays public. Neither CTE reads p_since, v_scope or any other
-- cluster's member dates, so under 180, as under 148, a pair's verdict is a function of the
-- two titles and of the member's own window. (The first draft of 180 used ONE line per run,
-- 0.25 percent of the whole of scand: a 16 day call raised it from 45 to 315 and one old-dated
-- scoped member could stretch it for every other cluster; review findings DB-1 and DB-2. Its
-- base also counted aggregator and niche articles that the /metodoloji sentence does not
-- name, twin-parity-1: wdf and wlim are restricted to the voting kinds.) All comparisons are
-- inclusive; the TypeScript twin is siblingTitlesMatchRare in src/lib/clusters/sibling-veto.ts,
-- and the test pins every literal here to SIBLING_VETO. The reason value stays
-- 'sibling_headline' (no UI contract change); the verdict, freeze, wmem exclusion and UPDATE
-- are 148's text verbatim: the test deletes the two CTEs, the two joins and the group column,
-- neutralises the HAVING and requires the rest of the body to equal 148's.
--   wdf   = per (member article w, stem): count(distinct st.article_id) over the voting stok rows
--           with st.published_at within 24 hours of w.published_at
--   wlim  = per member article: 0.0025 * the distinct voting scand articles within 24 hours of it
--           (a RANGE window over the candidates and the members; no members x scand join)
--   pairs = ... join wdf on (article, stem) join wlim on article ... group by ..., wlim.lim
--           having count(*) >= 3
--           and (jaccard >= 0.5 or (jaccard >= 0.3
--                and count(*) filter (where wdf.df <= wlim.lim) >= 2))
--   wdf and wlim are MATERIALIZED (see PERF).
--
-- md5(prosrc) of public.blindspot_recall_veto_refresh BEFORE this migration:
--   088ed2ba0ac5b70682065346955a137e   (10855 characters, identity arguments
--   "p_since interval, p_min_prob numeric"). Read on production on 2026-11-08 and equal to
--   the md5 of the text between the dollar-quote markers of 148's function (144 and 148
--   changed the cron command only after 126's body); the test pins that equality.
--
-- PERF. Read-only EXPLAIN (ANALYZE, BUFFERS, TIMING OFF) on production, 2026-11-09 00:3x UTC,
-- of this migration's CTE chain run as a plain SELECT (v_since 26 hours, v_min 0.85,
-- v_scope 48 hours, no lock, the UPDATE replaced by a count over verdict), the cron's scope
-- (118 scoped member articles, about 18,000 candidate articles, 14 live blindspots):
--   180 chain: first run (cold) 3.02 s execution (shared hit 109,995 read 3,478; temp read
--              6,203 written 6,947), warm 1.67 s and 1.91 s (read 0).
--   148 chain: warm 1.13 s twice (run right after the first 180 run, so warm).
-- Cold is far under the 10 s bar (the cron runs every 20 minutes under a 120 s timeout). The
-- delta is about 0.5 to 0.8 s warm: wdf joins the 887 member stems against stok once more, and
-- wlim is one sort and window over the candidates. Both CTEs are MATERIALIZED on purpose: left
-- inlined, the planner puts wlim's window (a sort over the candidates, no Materialize node above
-- it) on the inner side of a nested loop whose outer side it estimates at one row (wart is a CTE
-- it cannot size; it is 887), and the pairs step was cancelled at 8.4 s by the 8 s cap of a
-- read-only probe; materialized, pairs alone runs in 1.9 s. Per-member lines on that data run
-- from 14.9 to 31.5 (6,000 to 12,600 voting candidates within 24 hours), where the first draft's
-- scope-wide line had been 45.17 (18,069 titles). A chain over a 16 day scope does not fit the
-- 8 s cap either (148 does not), so the IMPACT replay below ran per day of cluster creation.
--
-- IMPACT. Read-only replay on production, 2026-11-09 00:36 to 00:45 UTC, of this migration's own
-- CTE chain and of 148's, each as a plain SELECT, the UPDATE replaced by a verdict listing, v_min
-- 0.85. The chain was split by day of cluster creation (statement cap; one slice was halved after
-- a timeout, none failed). With v_since 16 days (v_scope 16 days) it scored the 198 live blindspots
-- created since 2026-10-24: 148 vetoes 88, 180 vetoes 98. Clusters whose public verdict flips
-- (not vetoed under 148, vetoed under 180), 11 of 198:
--   30b3b262 same event   cumhuriyet, elips-haber (Muhalefet): "Silah ruhsatinda celik kasa sarti"
--   f1837ee1 same event   indyturk, haberport, haberet, dw-turkce (Bagimsiz), bha (Muhalefet):
--                         Milli Enerji 2040
--   9baf5dae same event   sozcu, agos (Muhalefet), indyturk, medyascope, dokuz8-haber (Bagimsiz):
--                         the IBB hearing day
--   df635766 same event   haberport: Inan's "demir yumruk" speech (4 shared stems, Jaccard 0.31)
--   5e7c6a11 same event   yenicag: Bakan Ciftci inspecting the Ulus demolition area
--   4658a1be same event   odatv (Muhalefet), karar (Bagimsiz): Levent Inanir on Julide Kural and
--                         his uncle Kadir Inanir
--   61906acf same event   yenicag, birgun (Muhalefet), on-haber, gazete-oksijen (Bagimsiz): the
--                         YENI Parti spokesman on Merrill Lynch
--   406770cf SAME STORY   haber7 (Iktidar): a column on the Fatma Betul Sayan Kaya fund dispute
--                         against a member item on a ministry "iptal" application; the pair shares
--                         the name only (4 shared stems, Jaccard 0.33). Not the same news item.
--   991f5b9c SAME STORY   odatv (Muhalefet): one quote of Minister Arakci against another (4 shared
--                         stems, Jaccard 0.31). Not the same news item.
--   87bcc51b DIFFERENT    yenicag (Tunus FTA), haberport (KKTC): Minister Bolat's other meetings
--                         under the same "Bakan Bolat ... mutabik" wording; the "badge hidden"
--                         error direction that 126 and 148 already accept
--   4c8e7533 DIFFERENT    abc-haber (Bagimsiz): Minister Fidan's talks with Rubio against a member
--                         item on his talks with the Mexican foreign minister (4 shared stems,
--                         Jaccard 0.44, 2 rare)
-- bb8f5ea3 and 23132be4 do not flip (both stay public under 148 and under 180). 7 of 11 flips are
-- the same event, 2 the same story but another news item, 2 a different event.
-- One cluster goes the other way: 48e267ee (Fidan in KKTC, created 2026-11-06) is vetoed under
-- 148 (15 of 19 voters in the dominant zone, 0.789) and not under 180. sabah (Iktidar) matches a
-- member through "Cumhurbaskani Tufan Erhurman" (4 and 5 shared stems, Jaccard 0.33; the sabah
-- item is Minister Kacir's reception by Erhurman, a different event), and that one voter of the
-- dominant zone lifts the share to 16 of 20 = 0.80, so the veto no longer holds. The cause is the
-- share test of 126/148 (a voter counts in whichever zone it sits), not the title rule; it makes
-- that one claim public again after the founder step below (see there).
-- Window sensitivity. A member's line no longer depends on p_since, on v_scope or on the other
-- scoped clusters: each cluster gets the same verdict from the cron's scope and from a 16 day
-- call. Measured on the same replay with v_since 26 hours (v_scope 48 hours): 14 live blindspots
-- (created since 2026-11-07), one slice, 3 flips (5e7c6a11, 991f5b9c, df635766, all three also in
-- the 11 above), 0 reverse; each of the 14 gets the same verdict under v_since 26 hours as under
-- v_since 16 days (0 of 14 differ, under 148 and under 180). The cron's scope only misses the
-- clusters older than 48 hours, which 180 never re-scores (see FOUNDER STEP). The one dependence
-- left is 148's own clock cut: the unclustered arm reads nothing older than now() - v_scope
-- - 48 hours, so a member published more than 72 hours before the run sees a clipped window
-- under the cron's scope, in its pairs and in its line alike.
--
-- Known limit. Title overlap cannot tell two events with the same wording; the error
-- direction is "badge hidden" (87bcc51b and 4c8e7533 above; 126 listed "Tugay'i kabul etti"
-- meetings with different ministers), with the one exception IMPACT records (48e267ee: a
-- different-event voter of the dominant zone lifts a share back to 0.8, which is the share
-- test and not the title rule). Generic wording shares no rare stem and stays out of reach of
-- any title rule: 23132be4 ("Fransa genel grev") keeps its public claim. Thresholds are the
-- specified ones (3, 0.3, 2, 0.25 percent) and were tuned only on the 52 claims above.
--
-- DRY-RUN (2026-11-09, local PostgreSQL 15.12, two throwaway clusters through
-- tests/migrations/sql/run-live.sh, servers stopped and data directories deleted afterwards;
-- CI's live-db job runs the same script as Phase A on postgres:15):
-- tests/migrations/sql/180-blindspot-sibling-rare-tier-dryrun.sql, psql -v ON_ERROR_STOP=1.
-- It runs 148's own dry-run first (064, 071, 098, 099, 126, 148 and scenarios A-Q), seeds the
-- window (2,000 filler titles plus the common words), runs the refresh under 148 (R1 stays
-- public: that is the bug), applies 180 TWICE and runs it again. Both clusters printed
-- DRYRUN 180 OK. Scenarios: R1 the 30b3b262 shape (5 iktidar and 1 muhalefet member, two
-- unclustered muhalefet outlets in genel, 6 and 5 shared stems, Jaccard 0.43 and 0.36) vetoes
-- with reason sibling_headline; R2 the Goktas / Kacir shape (5 shared stems, one rare) does
-- not; R3 the same R1 after twelve titles make kasa, celik, ruhsa and sarti common clears the
-- veto; 148's scenarios A-Q keep their outcomes; a second refresh returns 0. Two mutants of the
-- function are run inside the script: without the Jaccard >= 0.3 branch R1 stays public, and
-- without the rare-stem count R2 is vetoed (each half of the HAVING is load-bearing). R4 is the
-- scope test: an R1-shaped blindspot whose event stems have df 8 against the member's line of
-- about 5.4, with 1,500 filler titles dated 60 to 90 hours ago outside its +-24 h window and an
-- unrelated scoped blindspot holding a member published 80 hours ago. The scope-wide line would
-- rise to about 9.2 and veto it (the script failed with exactly that against the first draft);
-- it stays public under refresh() and under refresh(interval '16 days'). R5, the same shape with
-- stems of df 3, is vetoed under both calls (the control). Only the R4 and R5 verdicts are
-- asserted after the 16 day call: it may legitimately re-score 148's older scenarios.
--
-- DEPLOY ORDER: none. The app never selects blindspot_veto_reason and the reader paths
-- already apply the veto; apply with `supabase db push`. The /metodoloji sentence needs a
-- Vercel deploy; ship it after the apply so the page describes a rule that is live. No index,
-- no table lock, no data write.
--
-- FOUNDER STEP (a production write, not part of this migration; this migration does NOT backfill
-- and never re-scores outside the cron's own scope, 26 hours): after any change to the sibling
-- rule, run blindspot_recall_veto_refresh(interval '16 days') once under
-- set local statement_timeout = '120s' (begin; set local statement_timeout = '120s';
-- select public.blindspot_recall_veto_refresh(interval '16 days'); commit;). It re-scores the
-- existing public claims with the same rule the cron applies (the verdict of a cluster is the
-- same from either scope; see the window sensitivity under IMPACT), over 198 blindspots instead
-- of 14: the 11 flips listed there (2 of them the same story but another news item, 2 a
-- different event) and, in the other direction, 48e267ee, whose veto the call lifts. A cluster
-- older than the cron's scope keeps a stored sibling_headline veto frozen until a call like this
-- one recomputes it. Re-scoring is the follow-up h85-blindspotprecision-2.
--
-- ROLLBACK: re-apply 148's function block (the create or replace function statement of
-- 148_blindspot_unclustered_siblings.sql, then its function, comment, revoke and grant; skip
-- 148's cron do block and its ledger insert: the cron command is untouched by 180). Vetoes found
-- through the rare tier stay stored (reason sibling_headline) until the next run recomputes them
-- inside the 48 hour scope, and clear there once the evidence is gone; older ones stay frozen
-- like any 126 veto. Then delete from supabase_migrations.schema_migrations where version = '180';

begin;

create or replace function public.blindspot_recall_veto_refresh(
  p_since    interval default interval '26 hours',
  p_min_prob numeric  default 0.85
) returns integer
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_since   interval := least(coalesce(p_since, interval '26 hours'), interval '30 days');
  v_min     numeric  := greatest(coalesce(p_min_prob, 0.85), 0.5);
  v_scope   interval := greatest(interval '48 hours', v_since);   -- sibling search scope; SIBLING_VETO.scopeHours
  v_updated integer  := 0;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('blindspot_recall_veto_refresh')::bigint) then
    return 0;
  end if;

  with zmap(bias_key, zone) as (values   -- verbatim BIAS_TO_ZONE (032); parity-tested
      ('pro_government','iktidar'),('gov_leaning','iktidar'),('state_media','iktidar'),
      ('islamist_conservative','iktidar'),('nationalist','iktidar'),
      ('center','bagimsiz'),('international','bagimsiz'),('pro_kurdish','bagimsiz'),
      ('opposition_leaning','muhalefet'),('opposition','muhalefet')),
  win as (
      select c.id, c.bias_distribution, c.is_blindspot from public.clusters c
       where c.is_blindspot
         and (c.updated_at >= pg_catalog.now() - v_since
              or c.blindspot_recall_checked_at >= pg_catalog.now() - v_since)
      union
      select c.id, c.bias_distribution, c.is_blindspot from public.clusters c
       where c.blindspot_recall_veto),                 -- lets stale vetoes clear
  base as (
      select w.id as cluster_id, z.zone, (e.value)::int as n
        from win w cross join lateral pg_catalog.jsonb_each_text(w.bias_distribution) e
        join zmap z on z.bias_key = e.key
       where e.value ~ '^[0-9]+$'),                    -- a malformed count never aborts the run
  matched as (
      select distinct p.cluster_id, s.id as source_id, z.zone
        from public.jev_shadow_predictions p
        join win w            on w.id = p.cluster_id
        join public.articles a on a.id = p.article_id
        join public.sources  s on s.id = a.source_id
        join zmap z            on z.bias_key = s.bias
       where p.task = 'blindspot_recall' and p.article_id is not null
         and p.jev_prob >= v_min
         and s.kind in ('outlet','wire')              -- VOTING_SOURCE_KINDS; parity-tested
         and not exists (select 1 from public.cluster_articles ca
                           join public.articles a2 on a2.id = ca.article_id
                          where ca.cluster_id = p.cluster_id and a2.source_id = s.id)),
  live as (select cluster_id, max(zn) dom_n, sum(zn) tot
             from (select cluster_id, zone, sum(n) zn from base group by 1,2) t group by 1),
  -- Sibling search. Scope: blindspots created within v_scope. Their members, tokenised.
  sib_scope as (
      select w.id as cluster_id
        from win w join public.clusters c on c.id = w.id
       where w.is_blindspot
         and c.created_at >= pg_catalog.now() - v_scope),
  wart as materialized (
      select sc.cluster_id, a.id as article_id, a.source_id, a.published_at, a.title
        from sib_scope sc
        join public.cluster_articles ca on ca.cluster_id = sc.cluster_id
        join public.articles a          on a.id = ca.article_id),
  wmem as (select distinct cluster_id, source_id from wart),   -- sources already counted per cluster
  wtok as (
      select t.cluster_id, t.article_id, t.source_id, t.published_at, t.tok,
             pg_catalog.count(*) over (partition by t.cluster_id, t.article_id) as ntok
        from (select distinct a.cluster_id, a.article_id, a.source_id, a.published_at,
                     pg_catalog.left(x, 5) as tok
                from wart a
               cross join lateral pg_catalog.regexp_split_to_table(
                     pg_catalog.lower(pg_catalog.translate(coalesce(a.title, ''), 'İIıŞşĞğÜüÖöÇçÂâÎîÛû', 'iiissgguuooccaaiiuu')),
                     '[^a-z0-9]+') x
               where pg_catalog.length(x) >= 4) t),
  -- Sibling candidates: articles of live clusters created within v_scope plus 24 hours, plus (148)
  -- unclustered voting-source articles outside the gate categories, fetched from the articles side
  -- and bounded by the members' publication times plus or minus 24 hours (the pair condition
  -- below allows no other article).
  scand as materialized (
      select c2.id as cluster_id, a.id as article_id, a.source_id, a.published_at, a.title
        from public.articles a
        join public.cluster_articles ca on ca.article_id = a.id
        join public.clusters c2         on c2.id = ca.cluster_id
       where a.published_at >= (select pg_catalog.min(published_at) from wart) - interval '24 hours'
         and a.published_at <= (select pg_catalog.max(published_at) from wart) + interval '24 hours'
         and c2.created_at >= pg_catalog.now() - v_scope - interval '24 hours'
         and not coalesce(c2.is_archived, false)
         and c2.merged_into is null
      union all
      -- 148: unclustered candidates. Only politika/son_dakika articles are ever clustered, so an
      -- outlet/wire article filed under any other category sits in no cluster and the arm above
      -- cannot see it. Its own id is the pseudo cluster id: it never equals a real cluster id,
      -- so the pair test st.cluster_id <> w.cluster_id holds and ntok counts that article alone.
      -- Gate-category articles are covered by the arm above; a rare clustered article outside
      -- the gate only adds a duplicate pair, which the DISTINCT in sibling absorbs.
      -- Unlike the arm above, this one reads EVERY voting-source article of its window, so the
      -- window is also cut by the clock: a member date is feed data (ingest clamps only future
      -- dates, a 2022 pubDate gets in) and must not stretch the read to years of coverage.
      select a.id as cluster_id, a.id as article_id, a.source_id, a.published_at, a.title
        from public.articles a
        join public.sources s on s.id = a.source_id
       where a.published_at >= greatest((select pg_catalog.min(published_at) from wart) - interval '24 hours',
                                        pg_catalog.now() - v_scope - interval '48 hours')
         and a.published_at <= least((select pg_catalog.max(published_at) from wart) + interval '24 hours',
                                     pg_catalog.now())
         and s.kind in ('outlet','wire')                  -- VOTING_SOURCE_KINDS; parity-tested
         and coalesce(a.category, '') not in ('politika','son_dakika')),   -- POLITICS_CATEGORIES; parity-tested
  stok as (
      select t.cluster_id, t.article_id, t.source_id, t.published_at, t.tok,
             pg_catalog.count(*) over (partition by t.cluster_id, t.article_id) as ntok
        from (select distinct a.cluster_id, a.article_id, a.source_id, a.published_at,
                     pg_catalog.left(x, 5) as tok
                from scand a
               cross join lateral pg_catalog.regexp_split_to_table(
                     pg_catalog.lower(pg_catalog.translate(coalesce(a.title, ''), 'İIıŞşĞğÜüÖöÇçÂâÎîÛû', 'iiissgguuooccaaiiuu')),
                     '[^a-z0-9]+') x
               where pg_catalog.length(x) >= 4) t),
  -- 180 rare tier. The line belongs to each MEMBER article's own pair window, never to the scope: a pair
  -- may only form between a member and a candidate published within 24 hours of it, so that pool is the
  -- "search window" of that member. SIBLING_VETO.windowHours either side of w.published_at, voting
  -- sources only (the pool /metodoloji names; the sibling CTE below drops every other kind anyway).
  -- wdf is the document frequency of each member stem: the number of distinct candidate articles in the
  -- member's window whose title holds it (a stem counts once per article). wlim is the member's rare
  -- line, SIBLING_VETO.rareMaxDocShare (0.25 percent) of the distinct candidate articles in that window,
  -- a RANGE window over one ordered list of the candidates and the members (no members x scand join).
  -- Neither reads p_since, v_scope or any other cluster's member dates, so a pair's verdict is a function
  -- of the two titles and the member's window alone, as it was under 148. Both are MATERIALIZED: left
  -- inlined, the plan runs wlim's window on the inner side of a nested loop with a one-row outer
  -- estimate (wart is a CTE the planner cannot size) and no Materialize above it, and the pairs step
  -- ran past the 8 s cap of a read-only probe on production (see PERF).
  wdf as materialized (select w.article_id, w.tok, pg_catalog.count(distinct st.article_id) as df
            from wtok w join stok st on st.tok = w.tok
                                    and st.published_at between w.published_at - interval '24 hours'
                                                            and w.published_at + interval '24 hours'
                        join public.sources s on s.id = st.source_id
           where s.kind in ('outlet','wire')              -- VOTING_SOURCE_KINDS; parity-tested
           group by w.article_id, w.tok),
  wlim as materialized (select article_id, 0.0025 * n as lim           -- SIBLING_VETO.rareMaxDocShare
             from (select article_id, is_member,
                          pg_catalog.count(*) filter (where not is_member)
                            over (order by published_at
                                  range between interval '24 hours' preceding and interval '24 hours' following) as n
                     from (select distinct c.article_id, c.published_at, false as is_member
                             from scand c join public.sources s on s.id = c.source_id
                            where s.kind in ('outlet','wire')   -- VOTING_SOURCE_KINDS; parity-tested
                           union all
                           select distinct article_id, published_at, true from wart) u) t
            where is_member),
  pairs as (
      select w.cluster_id as w_cluster, st.source_id as s_source
        from wtok w join stok st on st.tok = w.tok
                    join wdf on wdf.article_id = w.article_id and wdf.tok = w.tok   -- 180: df of the shared stem in the member's window
                    join wlim on wlim.article_id = w.article_id                     -- 180: the member's rare line
       where st.cluster_id <> w.cluster_id
         and st.article_id <> w.article_id
         and st.published_at between w.published_at - interval '24 hours'
                                 and w.published_at + interval '24 hours'
       group by w.cluster_id, w.article_id, w.ntok, st.cluster_id, st.article_id, st.source_id, st.ntok, wlim.lim
      having pg_catalog.count(*) >= 3                                          -- SIBLING_VETO.minShared and looseMinShared (one gate for both tiers)
         and (pg_catalog.count(*)::numeric / (w.ntok + st.ntok - pg_catalog.count(*)) >= 0.5   -- strict tier (126): SIBLING_VETO.minJaccard
              or (pg_catalog.count(*)::numeric / (w.ntok + st.ntok - pg_catalog.count(*)) >= 0.3   -- rare tier (180): SIBLING_VETO.looseMinJaccard
                  and pg_catalog.count(*) filter (where wdf.df <= wlim.lim) >= 2))),   -- rareMinShared stems with df <= the member's line
  sibling as (
      select distinct p.w_cluster as cluster_id, s.id as source_id, z.zone
        from pairs p
        join public.sources s on s.id = p.s_source
        join zmap z           on z.bias_key = s.bias
       where s.kind in ('outlet','wire')              -- VOTING_SOURCE_KINDS; parity-tested
         and not exists (select 1 from wmem wm
                          where wm.cluster_id = p.w_cluster and wm.source_id = s.id)),
  voters_all as (select cluster_id, source_id, zone from matched
                 union
                 select cluster_id, source_id, zone from sibling),
  adj_jev as (select cluster_id, max(zn) dom_n, sum(zn) tot
                from (select cluster_id, zone, sum(n) zn
                        from (select cluster_id, zone, n from base
                              union all select cluster_id, zone, 1 from matched) u
                       group by 1,2) t group by 1),
  adj_all as (select cluster_id, max(zn) dom_n, sum(zn) tot
                from (select cluster_id, zone, sum(n) zn
                        from (select cluster_id, zone, n from base
                              union all select cluster_id, zone, 1 from voters_all) u
                       group by 1,2) t group by 1),
  frozen as (
      select c.id as cluster_id
        from win w join public.clusters c on c.id = w.id
       where c.created_at < pg_catalog.now() - v_scope
         and c.blindspot_veto_reason = 'sibling_headline'),
  scored as (
      select w.id as cluster_id,
             coalesce(w.is_blindspot
                      and l.tot >= 5                                     -- BLINDSPOT.minSources
                      and l.dom_n::numeric / nullif(l.tot, 0) >= 0.8, false) as live_ok,   -- BLINDSPOT.dominantShare
             coalesce(aj.dom_n::numeric / nullif(aj.tot, 0) < 0.8, false) as shrunk_jev,
             coalesce(aa.dom_n::numeric / nullif(aa.tot, 0) < 0.8, false) as shrunk_all,
             (fz.cluster_id is not null) as is_frozen
        from win w left join live l     on l.cluster_id = w.id
                   left join adj_jev aj on aj.cluster_id = w.id
                   left join adj_all aa on aa.cluster_id = w.id
                   left join frozen fz  on fz.cluster_id = w.id),
  verdict as (
      select t.cluster_id,
             (t.veto_jev or t.veto_sib) as veto,
             case when t.veto_jev then 'jev_recall'
                  when t.veto_sib then 'sibling_headline' end as reason
        from (select s.cluster_id,
                     (s.live_ok and s.shrunk_jev)                       as veto_jev,
                     (s.live_ok and (s.shrunk_all or s.is_frozen))      as veto_sib
                from scored s) t)
  update public.clusters c
     set blindspot_recall_veto    = v.veto,
         blindspot_recall_veto_at = case when v.veto then coalesce(c.blindspot_recall_veto_at, pg_catalog.now()) end,
         blindspot_veto_reason    = v.reason
    from verdict v
   where c.id = v.cluster_id
     and (c.blindspot_recall_veto is distinct from v.veto
          or c.blindspot_veto_reason is distinct from v.reason);

  get diagnostics v_updated = row_count;
  return v_updated;
end
$fn$;

comment on function public.blindspot_recall_veto_refresh(interval, numeric) is
  'Recomputes clusters.blindspot_recall_veto and blindspot_veto_reason (migrations 071, 126, 148 and 180) for '
  'blindspots updated or recall-checked within p_since (capped at 30 days) plus every currently vetoed '
  'row. Veto evidence: Jev blindspot_recall matches (jev_recall) or voting sources of near-identical '
  'sibling articles within 24 h (sibling_headline): articles of live sibling clusters, or unclustered '
  'voting-source articles outside politika and son_dakika (148). Two titles are siblings when they share '
  'at least 3 stems with Jaccard >= 0.5, or (180, rare tier) Jaccard >= 0.3 and at least 2 shared stems '
  'whose document frequency in the window is at most 0.25 percent of its distinct candidate articles. '
  'Searched for clusters created within greatest(48 hours, p_since), frozen after that. Known limit: '
  'generic wording shares no rare stem and is out of reach (migration 180 header). Returns the number '
  'of rows whose verdict changed. Never writes is_blindspot, blindspot_side or updated_at. service_role '
  'only; scheduled as blindspot-recall-veto by 071.';

revoke all on function public.blindspot_recall_veto_refresh(interval, numeric) from public, anon, authenticated;
grant execute on function public.blindspot_recall_veto_refresh(interval, numeric) to service_role;

insert into supabase_migrations.schema_migrations (version, name)
  values ('180', '180_blindspot_sibling_rare_tier')
  on conflict do nothing;

commit;
