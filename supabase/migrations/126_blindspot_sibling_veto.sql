-- 126_blindspot_sibling_veto.sql
--
-- Blindspot sibling veto: stop showing a public "kor nokta" badge when a live,
-- near-identical sibling cluster, created within the same 24 hours, carries
-- the silent side.
--
-- WHY. Migration 071 withdraws a blindspot only when Jev's blindspot_recall
-- stage matched silent-side articles to it. Jev can only match the candidates
-- it was shown, and 102 prunes old prediction rows, so a twin cluster that
-- tells the same story under near-identical headlines can slip through.
-- Production, read-only, 2026-11-01:
--   * 112a68bd-68d3-4bc8-ab0b-6d12b37762b8 shows "Kor nokta: iktidar agirlikli"
--     (7 gov_leaning, 1 pro_government, 1 opposition_leaning) while eight
--     sibling clusters, among them f4c68960 and 923ec64a, carry the bagimsiz
--     and muhalefet coverage of the same Erdogan-Zelenski meeting ("Ukrayna
--     Devlet Baskani Zelenski Istanbul'a geldi"): 22 voting sources that are
--     not members of 112a68bd.
--   * 7 of the 19 public blindspots created in the last 48 hours are flagged
--     blindspot_recall_suspect. The sibling rule below would withdraw 6 of the
--     19 (5 of them are among the 7 suspects); over 7 days 16 of 61.
--
-- THE RULE. A cluster is vetoed when
--   (a) its live bias_distribution passes the BLINDSPOT contract (>= 5 voting
--       sources, dominant zone >= 0.8), and
--   (b) after adding the voting (outlet/wire) sources that are NOT yet members
--       and that either Jev matched at p >= 0.85 (071) or published a
--       near-identical sibling article, the dominant share drops below 0.8.
-- A sibling article pairs with a member article when
--   * the articles were published at most 24 hours apart,
--   * the titles share at least 3 stems and have a Jaccard index >= 0.5,
--     where a stem is a title word of >= 4 letters folded to ASCII (the
--     translate() strings of migrations 074/112/125), lower-cased and cut to
--     5 characters (src/lib/clusters/sibling-veto.ts is the TypeScript twin),
--   * the sibling cluster is live (not archived, not merged) and was created
--     at most 24 hours before the scope below starts,
--   * the sibling article sits in a DIFFERENT cluster.
-- The scope of the search is the blindspots created in the last
-- greatest(48 hours, p_since). A veto found by the sibling rule is stored in
-- the new column clusters.blindspot_veto_reason ('sibling_headline'; Jev wins
-- when both apply: 'jev_recall') and is FROZEN once the cluster is older than
-- the scope: the evidence is not recomputed (the cron would otherwise flap as
-- siblings age out of the 72 hour candidate window, and the cost stays
-- bounded). A frozen veto still clears when the live contract stops holding
-- (is_blindspot turned false, fewer than 5 voters, share below 0.8).
--
-- What this migration does (additive only):
--   1. clusters.blindspot_veto_reason text with a CHECK that allows only
--      'jev_recall' and 'sibling_headline'. Added NOT VALID and validated in a
--      LATER, separate statement (099's pattern, split): an inline CHECK on ADD
--      COLUMN scans the 398 MB table under ACCESS EXCLUSIVE (measured 345 ms
--      against 0.4 ms for 4M scratch rows), and VALIDATE inside the ADD COLUMN
--      transaction would keep that lock for the whole scan, because Postgres
--      holds it until commit. VALIDATE CONSTRAINT on its own takes SHARE UPDATE
--      EXCLUSIVE and blocks neither reads nor writes.
--   2. CREATE OR REPLACE of public.blindspot_recall_veto_refresh(interval,
--      numeric): same signature and defaults, so the 071 cron job
--      'blindspot-recall-veto' (7-59/10), the grants and 071's comment on the
--      function carry over. Nothing here touches cron.
--   3. A one-off backfill, blindspot_recall_veto_refresh(interval '7 days'):
--      sets the reason on every existing veto and finds sibling vetoes up to a
--      week back, 112a68bd (created 10-30, already outside 48 hours) included.
--      It runs outside any explicit transaction block (its UPDATE takes row
--      locks only), and it fails the migration rather than silently doing
--      nothing: see TRANSACTIONS.
--
-- TRANSACTIONS. ALTER TABLE ... ADD COLUMN takes ACCESS EXCLUSIVE on
-- public.clusters and holds it until its transaction commits; lock_timeout only
-- limits the wait for the lock, never how long it is held. Reads of clusters
-- (home, cluster pages, cluster-consumer, the crons) carry a 4 s reader timeout,
-- so anything slow in that transaction would turn into errors on production.
-- The file therefore runs as short pieces:
--   (a) begin; set local lock_timeout '5s'; add column; add constraint NOT
--       VALID; comment on column; commit;                (milliseconds)
--   (b) alter table ... validate constraint ...;         (SHARE UPDATE EXCLUSIVE)
--   (c) begin; create or replace function; comment; revoke; grant; commit;
--   (d) the 7-day backfill in a DO block, then the schema_migrations insert.
-- Every piece is idempotent, so a failed run can simply be applied again. The
-- function returns 0 without working while another session holds its advisory
-- lock (the 10-minute cron does for about a second); the DO block takes the
-- same lock first (it is re-entrant inside one session), retries for up to 30 s
-- and raises if it never gets it, so the ledger row is only written after a
-- backfill that really ran. Do not wrap the file in an outer transaction.
--
-- What it never does: write is_blindspot, blindspot_side or updated_at. The
-- UPDATE sets blindspot_recall_veto, blindspot_recall_veto_at and
-- blindspot_veto_reason only, and only when the verdict changed (a second run
-- returns 0). Read paths already treat `is_blindspot AND NOT
-- blindspot_recall_veto` as the public claim (src/lib/clusters/recall-veto.ts),
-- so nothing in the app changes. No grant is made to anon or authenticated
-- (117 closed their table grants; the new column is not readable by them).
--
-- Plan shape (production, read-only EXPLAIN ANALYZE of the verdict CTEs without
-- the UPDATE, 2026-11-01). The first drafts read 10.0 s and 3.5 s: a hash
-- anti-join over all 357k cluster_articles x 1.4M articles because the planner
-- guessed 20k pairs (199 real), and a parallel sequential scan of clusters for
-- created_at (no index). The member-source exclusion therefore reads a small
-- set derived from the scope (wmem), the sibling candidates are fetched from
-- the articles side (idx_articles_published_at, bounded by the members'
-- publication times plus 24 hours: the exact set the pair condition allows),
-- and the pairs carry source_id. Result (the migration's own CTE text, run as a
-- SELECT): 48 hour scope 0.47-0.48 s warm, 3.3 s on the first, cold run (the
-- cron runs every 10 minutes, so it is warm); 7 day scope 5.8 s (one-off).
--
-- md5(prosrc) of public.blindspot_recall_veto_refresh BEFORE this migration:
--   ee3a003fa0225da3bbb22a3fbb7da1b0   (3518 characters, identity arguments
--   "p_since interval, p_min_prob numeric"). Read on production on 2026-11-01
--   and equal to the md5 of 071's function body applied on a local PG15 (and to
--   the md5 of the text between the dollar-quote markers of 071; the test pins that).
--
-- Readers (rg -n is_blindspot src supabase/functions, 2026-11-01). Every public
-- surface applies the veto: applyRecallVeto in politics-query, cluster-detail-
-- query, v1-clusters and weekly-query; .eq("blindspot_recall_veto", false) in
-- blindspots-query and alert-query; social/select.ts and cron/alerts-webhooks;
-- migration 106 (source_karne) uses is_blindspot and not blindspot_recall_veto.
-- Nothing selects blindspot_veto_reason. Not veto-aware, read-only findings and
-- NOT changed here: (1) saved_clusters_v2 (124) returns c.is_blindspot, so a
-- vetoed story still shows the "Kor nokta" pill on /saved; (2) jev-shadow
-- fetchBlindspotClusters reads is_blindspot=true by design (it feeds the recall
-- stage itself); (3) /api/metrics counts is_blindspot (an internal gauge).
--
-- Known limit. Title overlap cannot tell two events with the same wording: the
-- production simulation lists "Emine Erdogan'dan 29 Ekim mesaji" against
-- "Cumhurbaskani Erdogan'dan 29 Ekim mesaji" (a different statement) and two
-- "Tugay'i kabul etti" meetings with different ministers. Those withdraw a
-- genuine blindspot; the error direction is "badge hidden", never "badge
-- invented". Thresholds are the specified ones and were not tuned.
--
-- DEPLOY ORDER: none. The app never selects blindspot_veto_reason, so the app
-- and this migration can ship in either order. Apply with `supabase db push`.
-- The backfill statement takes about 6 to 10 s; it holds row locks only, no
-- table lock on clusters (see TRANSACTIONS).
--
-- ROLLBACK: re-apply the `create or replace function` block of
-- 071_blindspot_recall_veto.sql (function, comment, revoke, grant; skip its cron
-- and backfill sections: the job is untouched). Vetoes keep working with
-- Jev-only evidence; sibling vetoes clear on the next run. The column may stay
-- (nullable, unread). To drop it: alter table public.clusters drop constraint
-- if exists clusters_blindspot_veto_reason_check, drop column if exists
-- blindspot_veto_reason; then delete from supabase_migrations.schema_migrations
-- where version = '126';

begin;

set local lock_timeout = '5s';

alter table public.clusters
  add column if not exists blindspot_veto_reason text;

do $guard$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
     where conname = 'clusters_blindspot_veto_reason_check'
       and conrelid = 'public.clusters'::regclass
  ) then
    alter table public.clusters
      add constraint clusters_blindspot_veto_reason_check
      check (blindspot_veto_reason in ('jev_recall', 'sibling_headline')) not valid;
  end if;
end
$guard$;

comment on column public.clusters.blindspot_veto_reason is
  'Why blindspot_recall_veto is set (migration 126): jev_recall when Jev blindspot_recall matches '
  'drop the dominant zone below BLINDSPOT.dominantShare, sibling_headline when voting sources of a '
  'near-identical sibling cluster (title stems, 24 h) do. Null exactly when blindspot_recall_veto is '
  'false. Sibling evidence is frozen once the cluster is older than the refresh scope. Maintained by '
  'blindspot_recall_veto_refresh(); no reader selects it.';

commit;

-- Piece (b): SHARE UPDATE EXCLUSIVE only. It runs outside any transaction block
-- we open, so the ACCESS EXCLUSIVE lock of the ALTER above is already released.
alter table public.clusters validate constraint clusters_blindspot_veto_reason_check;

-- Piece (c): the function swap. No lock on clusters is taken.
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
  -- Sibling candidates: articles of live clusters created within v_scope plus 24 hours, fetched
  -- from the articles side and bounded by the members' publication times plus or minus 24 hours
  -- (the pair condition below allows no other article).
  scand as materialized (
      select c2.id as cluster_id, a.id as article_id, a.source_id, a.published_at, a.title
        from public.articles a
        join public.cluster_articles ca on ca.article_id = a.id
        join public.clusters c2         on c2.id = ca.cluster_id
       where a.published_at >= (select pg_catalog.min(published_at) from wart) - interval '24 hours'
         and a.published_at <= (select pg_catalog.max(published_at) from wart) + interval '24 hours'
         and c2.created_at >= pg_catalog.now() - v_scope - interval '24 hours'
         and not coalesce(c2.is_archived, false)
         and c2.merged_into is null),
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
  'Recomputes clusters.blindspot_recall_veto and blindspot_veto_reason (migrations 071 and 126) for '
  'blindspots updated or recall-checked within p_since (capped at 30 days) plus every currently vetoed '
  'row. Veto evidence: Jev blindspot_recall matches (jev_recall) or voting sources of near-identical '
  'sibling clusters within 24 h (sibling_headline; searched for clusters created within '
  'greatest(48 hours, p_since), frozen after that). Returns the number of rows whose verdict changed. '
  'Never writes is_blindspot, blindspot_side or updated_at. service_role only; scheduled as '
  'blindspot-recall-veto by 071.';

revoke all on function public.blindspot_recall_veto_refresh(interval, numeric) from public, anon, authenticated;
grant execute on function public.blindspot_recall_veto_refresh(interval, numeric) to service_role;

commit;

-- Piece (d): one-off backfill, outside any explicit transaction block (row locks
-- only). The function returns 0 when another session holds its advisory lock, so
-- take that lock here first, wait for the cron run to finish, and fail rather
-- than record the migration with the backfill undone.
do $backfill$
declare
  v_key  bigint  := pg_catalog.hashtext('blindspot_recall_veto_refresh')::bigint;
  v_wait integer := 0;
  v_rows integer;
begin
  while not pg_catalog.pg_try_advisory_xact_lock(v_key) loop
    v_wait := v_wait + 1;
    if v_wait > 30 then
      raise exception '126 backfill: blindspot_recall_veto_refresh stayed locked by another session for 30 s; apply this migration again';
    end if;
    perform pg_catalog.pg_sleep(1);
  end loop;

  v_rows := public.blindspot_recall_veto_refresh(interval '7 days');   -- reasons and sibling vetoes
  raise notice '126 backfill: % cluster verdict(s) changed', v_rows;
end
$backfill$;

insert into supabase_migrations.schema_migrations (version, name)
  values ('126', '126_blindspot_sibling_veto') on conflict do nothing;
