-- 148_blindspot_unclustered_siblings.sql
--
-- Blindspot sibling veto, second candidate arm: voting-source articles that sit
-- in NO cluster. 126's veto only counted siblings in live clusters, and the
-- clusterer admits only politika/son_dakika articles, so a story the silent side
-- ran under dunya, genel, yasam, ekonomi ... could never withdraw a false "kor
-- nokta" badge. Change nothing else: this file is 126's function body (piece (c))
-- plus one UNION ALL arm in the scand CTE, the function comment, the grants and
-- the ledger row.
--
-- WHY (production, read-only, 2026-11-02). Cluster bdbf9948-e7b6-46f1-91d7-
-- cc588516f9ea ("Yapmayanin hesabi kapatilacak: Sosyal medyada yeni donem yarin
-- basliyor") has is_blindspot = true, blindspot_recall_veto = false and
-- bias_distribution pro_government 3 + gov_leaning 2: five voting members (star,
-- haber-global, yeni-safak, istiklal, aksam), all category politika. The page
-- shows "kor nokta (Muhalefet)". Yet opposition voting outlets ran the same story
-- the same morning with near-identical headlines and are in no cluster
-- (cluster_articles count 0): cumhuriyet ca13efe9 (dunya), birgun d4121d30
-- (dunya), yenicag 16b6ec7f (genel), evrensel 5599ab56 (yasam). Over the last 96
-- hours voting-source articles were 6,391 politika/son_dakika against 19,132 in
-- other categories: 75 percent of voting coverage was out of reach of the veto.
-- Real headlines through siblingTitlesMatch (the TypeScript twin of the rule):
-- cumhuriyet, evrensel and yenicag each match a member title (3 muhalefet
-- sources, so 5/(5+3) = 0.625 < 0.8); birgun's shorter headline shares at most 4
-- stems with a member (Jaccard 0.364) and does not match. The test pins this.
--
-- THE ARM. scand was
--     articles a join cluster_articles ca join clusters c2 (live, young)
-- and is now that UNION ALL
--     select a.id as cluster_id, a.id as article_id, a.source_id, a.published_at,
--            a.title
--       from public.articles a join public.sources s on s.id = a.source_id
--      where a.published_at >= greatest(min(wart.published_at) - 24 hours,
--                                       now() - v_scope - 48 hours)
--        and a.published_at <= least(max(wart.published_at) + 24 hours, now())
--                                                       -- arm 1's bounds, cut by the clock
--        and s.kind in ('outlet','wire')                 -- VOTING_SOURCE_KINDS
--        and coalesce(a.category, '') not in ('politika','son_dakika')
-- The article id is the pseudo cluster id: it can never equal a real cluster id,
-- so the pair test st.cluster_id <> w.cluster_id stays true, and the per-article
-- token count (count(*) over (partition by cluster_id, article_id)) counts that
-- article alone. There is no anti-join: gate-category articles are already
-- covered by arm 1 (and are excluded here), and a rare clustered article outside
-- the gate (Jev admission) only adds a duplicate pair, which the DISTINCT in
-- sibling absorbs (the dry-run pins that: scenario I). NULL category counts as
-- outside the gate. The 24 h window, minShared 3, Jaccard 0.5, the voting-kind
-- filter, the wmem "source already counted" exclusion, the frozen/sibling_headline
-- logic, the zmap copy and the UPDATE are 126's text verbatim (arm 1 too, bounds
-- included; only arm 2's window is cut by the clock, see BOUNDS): the test deletes
-- the new arm and requires the remaining body to equal 126's. The reason value
-- stays 'sibling_headline' (no UI contract change).
--
-- md5(prosrc) of public.blindspot_recall_veto_refresh BEFORE this migration:
--   2904bdbadff34838259ffb901807cc33   (9162 characters, identity arguments
--   "p_since interval, p_min_prob numeric"). Read on production on 2026-11-02 and
--   equal to the md5 of the text between the dollar-quote markers of 126's
--   function (144 changed only the cron schedule); the test pins that equality.
--   (126's own header quotes ee3a003f..., the md5 of 071's body BEFORE 126.)
--
-- PERF. Read-only EXPLAIN (ANALYZE, BUFFERS) on production, 2026-11-02 10:3x UTC,
-- of this migration's CTE chain run as a plain SELECT (v_since 26 hours, v_min
-- 0.85, v_scope 48 hours, no lock, the UPDATE replaced by a count over verdict):
--   148 chain: cold 5.59 s (shared hit 108,339 read 9,952; temp read 3,746
--              written 5,194), warm 1.28 s.
--   126 chain: warm 0.50 s (498 and 520 ms, run after the 148 chain, so warm);
--              144 measured its cold run at 3.46 s.
-- Cold is under the 10 s bar (cron every 20 minutes since 144, ops threshold 30
-- minutes), so the specified arm ships without an article-level prefilter. Where
-- the cold time goes: the Jev matched arm (jev_shadow_predictions bitmap scan,
-- 2.7 s of the 5.6 s) and scand (about 1.7 s, dominated by arm 1's parallel
-- sequential scan of cluster_articles). The new arm itself reads 17,897 articles
-- through idx_articles_published_at in 40 ms and adds 13,129 rows to scand (5,783
-- -> 18,912 titles; 140,677 (article, stem) rows hash-joined against the 1,116
-- member stems). The planner estimates 5,356 rows for scand (actual 18,912) and
-- still picks the same shape. The cron's own runs cost about 5.2 s mean on 144's
-- measurements; the warm delta of this arm is about 0.8 s per run (estimate).
--
-- IMPACT. Read-only, same chain, 2026-11-02: the default cron scope (p_since 26
-- hours) newly vetoes ONE blindspot that 126 leaves public, 07f6d2d0-1fbd-409c-
-- b9d4-ff06798bb317 (veto total 158 against 157 for 126; 165 clusters scored).
-- Hand check against the pair listing: its five members (cumhuriyet, sozcu,
-- odatv, dokuz8-haber, yenicag) tell Imamoglu's "Milyonlarin sesi oldunuz"
-- message to the farmer Emine Tegin; the counted siblings (birgun 58a754aa,
-- evrensel 9bb83d50, karar f8336999, all category genel or yasam, none in a
-- cluster) carry the same message: same event, 0 false vetoes of 1. The tally
-- goes from 4 muhalefet + 1 bagimsiz (0.80) to 6 + 2 (0.75); karar, a bagimsiz
-- source, is what tips it. bdbf9948 is
-- still inside the 48 hour creation scope (created 2026-10-31 12:25, scope ends
-- 2026-11-02 12:25 UTC) but NOT in the cron's win set: win needs updated_at or
-- blindspot_recall_checked_at within p_since (26 hours) and its values are
-- 2026-10-31 13:13 and 2026-11-01 00:00. So the cron will not re-score it. A
-- one-off select public.blindspot_recall_veto_refresh(interval '72 hours') after
-- this migration would newly veto 07f6d2d0, bdbf9948 and 7b66bbcf (126 at 72
-- hours vetoes none of the three; simulated read-only in 3.2 s wall; all three
-- hand-checked as the same event: the 15-yas sosyal medya duzenlemesi from 1
-- Kasim, and the "merkezi alt sinir" academic promotion rule). That call is a
-- production write and the founder's call: this migration does NOT backfill and
-- never re-scores outside the cron's own scope.
--
-- BOUNDS (review of this migration, read-only on production, 2026-11-02). Arm 1's
-- window is min/max of the member publication times, 24 h each side, and that is
-- safe there because arm 1 only returns members of RECENT clusters. Arm 2 returns
-- every voting-source article of its window, and a member date is feed data:
-- ingest's parseDate clamps only FUTURE dates, so an outlet can publish an RSS
-- pubDate years in the past and the clusterer admits the row. Members of clusters
-- created in the last 30 days include 2022-01-13 and 2022-01-14 rows (lag 1751
-- days, clusters 7462b5b8 and 35ddca6c, created 2026-10-30) and 21 members lag by
-- more than 3 days; none is in a blindspot today. Once one lands in a blindspot
-- created inside the 48 h scope, the unclamped arm would read every outlet/wire
-- non-politika article since that date: EXPLAIN on production shows a sequential
-- scan of about 1.06 million articles (against about 26,000 for a normal 96 h
-- window), then 7-8 million (article, stem) rows through DISTINCT, a window count
-- and a hash join before the 24 h pair filter discards anything (scand is
-- materialized, no predicate is pushed down), under the advisory lock, in a
-- SECURITY DEFINER run that has no statement timeout and competes with reader
-- paths that have 5 s. It would last as long as the cluster stays in scope, up to
-- 48 hours.
-- Fix, two layers:
--   (1) arm 2's window is cut by the clock: lower bound greatest(min(member) - 24 h,
--       now() - v_scope - 48 hours), upper bound least(max(member) + 24 h, now()).
--       96 hours back for the default scope (the 48 h creation scope plus 48 h for a
--       member published before its cluster existed); a manual call with a longer
--       p_since moves the bound with v_scope, not with member data. A misdated
--       member can pair only with articles within 24 h of ITS date, which the clock
--       cut excludes: the verdict of every other blindspot is unchanged (the
--       dry-run pins it: scenario P, a 2022 member with two 2022 loose siblings,
--       does not veto; scenario Q, a member 90 hours old still does, one 110 hours
--       old does not). Read-only on production with a 2022 member in the wart set:
--       the clamped arm returns 19,187 rows.
--   (2) the cron command becomes
--         set local statement_timeout = '120s'; select public.blindspot_recall_veto_refresh();
--       so a pathological run fails fast instead of holding the database for
--       minutes. 120 s is ten times the worst observed run (13.70 s, 144). The
--       timeout is in the command and not in the function: a SET on the function
--       does not reach the statement that is already running (measured on PG15:
--       a function with set statement_timeout = '300ms' slept its full 1.5 s),
--       while pg_cron on production runs jobs through libpq (cron.use_background_
--       workers = off, pg_cron 1.6.4, PostgreSQL 17.6) as one simple-query string,
--       where the timeout applies to each statement separately (PG15: set local
--       statement_timeout = '300ms'; select pg_sleep(1.5); is cancelled after
--       0.3 s). One timed-out run is a failed run: it shows in cron_failed_runs_30m
--       and, like any failed run since 144, trips blindspot_veto_cron_min.
-- Found by job name through cron.alter_job (command only, schedule and active flag
-- untouched, as 144 does); no pg_cron or no job: a notice and a skip.
--
-- Known limit (unchanged from 126). Title overlap cannot tell two events with
-- the same wording; the error direction is "badge hidden", never "badge
-- invented". Thresholds are 126's and were not tuned.
--
-- DRY-RUN (2026-11-02, local PostgreSQL 15.12, two throwaway clusters on ports
-- 55561 and 55562 with the QA stub schema; tests/migrations/sql/148-blindspot-
-- unclustered-siblings-dryrun.sql, psql -v ON_ERROR_STOP=1, servers stopped and
-- data directories deleted afterwards): 064, 071, 098, 099 and 126 applied, 16
-- blindspot scenarios seeded, the refresh run under 126 (only the clustered-sibling
-- scenario vetoes), then 148 applied TWICE and the refresh run again, then the cron
-- job checked on a stub pg_cron (no schema; schema without the job; the veto job next
-- to an unrelated one, applied twice: only the command changes). Both clusters
-- printed DRYRUN 148 OK. The review scenarios failed before the fix (7 changed rows
-- where 5 were expected: WP and WQ2 vetoed). Scenarios: A the bdbf9948 shape (5 iktidar
-- members, 2 unclustered muhalefet outlets in dunya) vetoes with reason
-- sibling_headline; B the same with category politika or son_dakika does not;
-- C aggregator or niche sources do not; D a source that is already a member is
-- not counted; E 25 h apart does not, E2 23 h apart does; F two shared stems does
-- not; G a second refresh returns 0; H 126's clustered sibling still vetoes; I a
-- clustered non-gate article in both arms counts once; K NULL category counts; N
-- wire sources vote; P a member dated 2022-01-13 with two 2022 loose siblings does
-- not veto and leaves arm 2 at 16 rows where the unbounded window reads 416; Q a member
-- 90 hours old still vetoes, one 110 hours old does not; then the veto clears when the
-- loose evidence is deleted.
-- A mutant of this file with the arm removed fails the same script (0 rows
-- changed where 4 were expected).
--
-- DEPLOY ORDER: none. The app never selects blindspot_veto_reason and the reader
-- paths already apply the veto; apply with `supabase db push`, no deploy, no index,
-- no data write. The function swap takes no table lock; the cron change is one
-- cron.alter_job of the command (schedule unchanged, the next run uses it).
--
-- ROLLBACK: re-apply piece (c) of 126_blindspot_sibling_veto.sql (the create or
-- replace function block, then its comment, revoke and grant: function, comment,
-- revoke, grant; skip the column, constraint, backfill and ledger pieces). Vetoes
-- found through unclustered siblings stay stored (reason sibling_headline) until
-- the next run recomputes them inside the 48 hour scope, and clear there once the
-- evidence is gone; older ones stay frozen like any 126 veto. Put the cron command
-- back: select cron.alter_job((select jobid from cron.job where jobname =
-- 'blindspot-recall-veto'), command := 'select public.blindspot_recall_veto_refresh();');
-- Then delete from supabase_migrations.schema_migrations where version = '148';

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
  pairs as (
      select w.cluster_id as w_cluster, st.source_id as s_source
        from wtok w join stok st on st.tok = w.tok
       where st.cluster_id <> w.cluster_id
         and st.article_id <> w.article_id
         and st.published_at between w.published_at - interval '24 hours'
                                 and w.published_at + interval '24 hours'
       group by w.cluster_id, w.article_id, w.ntok, st.cluster_id, st.article_id, st.source_id, st.ntok
      having pg_catalog.count(*) >= 3                                          -- SIBLING_VETO.minShared
         and pg_catalog.count(*)::numeric / (w.ntok + st.ntok - pg_catalog.count(*)) >= 0.5),   -- SIBLING_VETO.minJaccard
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
  'Recomputes clusters.blindspot_recall_veto and blindspot_veto_reason (migrations 071, 126 and 148) for '
  'blindspots updated or recall-checked within p_since (capped at 30 days) plus every currently vetoed '
  'row. Veto evidence: Jev blindspot_recall matches (jev_recall) or voting sources of near-identical '
  'sibling articles within 24 h (sibling_headline): articles of live sibling clusters, or unclustered '
  'voting-source articles outside politika and son_dakika (148); searched for clusters created within '
  'greatest(48 hours, p_since), frozen after that. Returns the number of rows whose verdict changed. '
  'Never writes is_blindspot, blindspot_side or updated_at. service_role only; scheduled as '
  'blindspot-recall-veto by 071.';

revoke all on function public.blindspot_recall_veto_refresh(interval, numeric) from public, anon, authenticated;
grant execute on function public.blindspot_recall_veto_refresh(interval, numeric) to service_role;

-- A pathological run must fail fast, not hold the database: the cron command gets a per-statement
-- timeout (120 s, ten times the worst observed run). Found by job name, command only; no pg_cron
-- or no job: a notice and a skip (local/CI databases), as in 144. The timeout lives in the cron
-- command because a SET on the function does not reach the statement that is already running
-- (measured on PG15: a function with set statement_timeout = '300ms' slept its full 1.5 s).
do $veto_timeout$
declare
  v_job bigint;
begin
  if to_regclass('cron.job') is null then
    raise notice '148: pg_cron not installed, skipping';
    return;
  end if;

  select jobid into v_job from cron.job where jobname = 'blindspot-recall-veto';
  if v_job is null then
    raise notice '148: blindspot-recall-veto not scheduled, skipping';
  else
    perform cron.alter_job(
      job_id  := v_job,
      command := 'set local statement_timeout = ''120s''; select public.blindspot_recall_veto_refresh();');
  end if;
end
$veto_timeout$;

insert into supabase_migrations.schema_migrations (version, name)
  values ('148', '148_blindspot_unclustered_siblings')
  on conflict do nothing;

commit;
