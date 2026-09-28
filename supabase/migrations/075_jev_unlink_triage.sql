-- 075_jev_unlink_triage.sql
--
-- Goal: unstick public.jev_unlink_candidates. data-8 and platform-2 measured
-- 382 rows pending, 0 EVER decided, and roughly 55 new rows a day
-- (2026-09-28). By jev_prob: below 0.1 = 57, 0.1-0.2 = 120, 0.2-0.35 = 205.
-- A human cannot triage 55 rows/day with no ordering and no signal beyond a
-- bare probability, so nothing gets decided and the queue only grows.
--
-- What this migration does:
--   1. Bands every pending candidate 'likely_unlink' (word-Jaccard between
--      the article title and the cluster's display title < 0.2, AND
--      jev_prob < 0.1) or 'review' (everything else). 'likely_unlink' rows
--      sort first on /admin. Read-only production measurement on
--      2026-09-28: of the 57 pending candidates with jev_prob < 0.1, 21
--      band 'likely_unlink' (word-Jaccard computed against both title_tr
--      and title_tr_neutral, max of the two, inlined SELECT, no prod
--      function). Eyeballing the lowest 10 by Jaccard: 9 of 10 were
--      genuine cross-topic mis-merges (Trump/Iran vs. Erdogan/sanctions,
--      Fidan/Egypt vs. Fidan/Bosnia, etc.) — matching data-8's finding.
--      Guard inputs measured the same day: 2,685 pair_positive predictions
--      at jev_prob >= 0.5 in the last 7 days; of the clusters behind the
--      57 pending p < 0.1 candidates, 8 have article_count < 4 (five at 2,
--      three at 3) and would therefore be guarded off by
--      JEV_UNLINK_DRYRUN_MIN_CLUSTER regardless of anything else.
--   2. Runs a DRY RUN of a guarded auto-unlink (p < 0.1 plus guards: cluster
--      size >= 4, not the cluster's earliest member, no pair_positive >=
--      0.5 link to another member, article title not token-identical to
--      the cluster title) hourly via pg_cron, logging what it WOULD do to
--      a new table, public.jev_unlink_dryrun. This NEVER changes cluster
--      membership: no INSERT/UPDATE/DELETE touches public.clusters,
--      public.cluster_articles or public.jev_unlink_candidates.status in
--      this file. The only UPDATE here sets jev_unlink_candidates.band and
--      title_jaccard (triage bookkeeping only); the only INSERT into
--      application tables is into jev_unlink_dryrun. Deciding to unlink
--      still requires a human pressing "Ayır", which still calls the
--      migration-064 RPC public.cluster_unlink_article — untouched here.
--   3. A bulk "Kalsın" for band 'review' rows only, enforced server-side
--      (src/lib/admin/jev-cluster.ts's keepClusterArticles), never for
--      'likely_unlink' rows — those still require one-by-one review.
--
-- Explicitly rejected (do not build): platform-2's proposal to
-- auto-dismiss candidates whose minhash similarity is >= 0.5. Templated
-- headlines ("Fidan X ile görüştü" for two entirely different X's) score
-- high on any bag-of-words / minhash text-similarity measure while being
-- exactly the mis-merges this queue exists to catch; auto-dismissing on
-- minhash would bury them, not resolve them. Word-Jaccard against the
-- cluster's OWN display title (not against other candidate headlines) is a
-- much narrower, cluster-specific signal and still only feeds a *display*
-- band and a *dry-run* log, never an automatic decision.
--
-- Deploy order: apply this migration BEFORE the Vercel deploy that ships
-- the /admin triage UI and the bulk-keep route — the UI reads
-- jev_unlink_candidates.band/title_jaccard and public.jev_unlink_dryrun,
-- both of which must already exist.
--
-- Kill switch (no migration, no deploy):
--   update cron.job set active = false where jobname = 'jev-unlink-triage';
-- That stops both the banding pass and the dry-run log; it does not affect
-- the existing 'jev-shadow' cron (migration 061) that still writes new
-- jev_unlink_candidates rows.
--
-- Additive only: two ALTER TABLE ADD COLUMN blocks (both `if not exists`),
-- one new table, one new index on the existing table, three new functions,
-- one cron job (guarded by pg_cron presence). Nothing is dropped, altered
-- destructively, or truncated. Safe to re-apply.

begin;

set local lock_timeout = '5s';

alter table public.jev_unlink_candidates
  add column if not exists title_jaccard numeric(4,3),
  add column if not exists band text check (band in ('likely_unlink', 'review')),
  add column if not exists triaged_at timestamptz;

comment on column public.jev_unlink_candidates.title_jaccard is
  'Word-Jaccard similarity between the candidate article''s title and the '
  'cluster''s display title (max of title_tr and title_tr_neutral), computed '
  'by public.jev_title_jaccard (migration 075). Null when either title '
  'tokenizes to zero words.';

comment on column public.jev_unlink_candidates.band is
  '''likely_unlink'' when title_jaccard < 0.2 AND jev_prob < 0.1 (migration '
  '075) -- these sort first on /admin ''Küme dışı adaylar''. ''review'' '
  'otherwise. Null until public.jev_unlink_triage_refresh has processed the '
  'row. Never set by anything other than that function; the bulk "Kalsın" '
  'route only ever touches ''review''-band rows.';

comment on column public.jev_unlink_candidates.triaged_at is
  'When public.jev_unlink_triage_refresh (migration 075) last computed '
  'title_jaccard/band for this row. Null means not yet triaged.';

create index if not exists jev_unlink_candidates_band_idx
  on public.jev_unlink_candidates (band, jev_prob)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- The dry-run log: what a guarded auto-unlink WOULD do. Evaluation only --
-- no foreign process ever reads `would_unlink` to change membership.
-- ---------------------------------------------------------------------------

create table if not exists public.jev_unlink_dryrun (
  candidate_id bigint primary key
    references public.jev_unlink_candidates(id) on delete cascade,
  cluster_id uuid not null,
  article_id uuid not null,
  jev_prob numeric(4,3) not null,
  title_jaccard numeric(4,3),
  cluster_size integer not null,
  would_unlink boolean not null,
  skip_reasons text[] not null default '{}'::text[]
    check (skip_reasons <@ array['not_member', 'small_cluster', 'earliest_member', 'pair_positive', 'title_match']::text[]),
  policy text not null default 'p<0.1+guards/v1',
  first_evaluated_at timestamptz not null default now(),
  changed_at timestamptz not null default now()
);

comment on table public.jev_unlink_dryrun is
  'DRY-RUN log of the guarded auto-unlink evaluation (migration 075, policy '
  '''p<0.1+guards/v1''): for every pending candidate with jev_prob < 0.1, '
  'records whether the guards (cluster size >= 4, not the earliest member, '
  'no pair_positive >= 0.5 link to another member, article title not '
  'token-identical to the cluster title) would have allowed an unlink, and '
  'which guards blocked it when they did not. This table is written by '
  'public.jev_unlink_triage_refresh and read ONLY by /admin''s dry-run '
  'block; nothing consumes would_unlink to actually change cluster '
  'membership. A candidate remains here even after a human decides it, so '
  'the dry-run''s predictions can be compared against real decisions.';

create index if not exists jev_unlink_dryrun_first_evaluated_idx
  on public.jev_unlink_dryrun (first_evaluated_at desc);

alter table public.jev_unlink_dryrun enable row level security;
revoke all on public.jev_unlink_dryrun from anon, authenticated, public;
grant select on public.jev_unlink_dryrun to service_role;

-- ---------------------------------------------------------------------------
-- Tokenizer + Jaccard, hand-copied here from the Step 0 read-only SELECT so
-- the SQL literal this file's own static test parses IS the definition.
-- ---------------------------------------------------------------------------

create or replace function public.jev_title_tokens(p_title text)
returns text[]
language sql
immutable
set search_path = ''
as $fn$
  select coalesce(array_agg(distinct t.tok order by t.tok), '{}'::text[])
    from regexp_split_to_table(
           regexp_replace(
             lower(translate(coalesce(p_title, ''), 'İIıŞşĞğÜüÖöÇçÂâÎîÛû', 'iiissgguuooccaaiiuu')),
             '[''’‘`´][a-z]*', '', 'g'),
           '[^a-z0-9]+') as t(tok)
   where length(t.tok) >= 2
     and t.tok !~ '^[0-9]+$'
     and t.tok <> all (array['ve', 'ile', 'bir', 'bu', 'da', 'de', 'ki', 'mi', 'mu', 'icin',
                             'ama', 'gibi', 'olarak', 'son', 'dakika', 'haber', 'video', 'flas', 'canli', 'izle']::text[]);
$fn$;

comment on function public.jev_title_tokens(text) is
  'Word-Jaccard tokenizer for migration 075''s triage band and dry-run '
  'guards: lowercases, folds Turkish diacritics, strips possessive suffix '
  'fragments after an apostrophe, splits on non-alphanumerics, and drops '
  'tokens shorter than 2 chars, pure-digit tokens, and a small Turkish '
  'stopword list. IMMUTABLE, service_role only.';

create or replace function public.jev_title_jaccard(p_a text, p_b text)
returns numeric
language sql
immutable
set search_path = ''
as $fn$
  with a as (select public.jev_title_tokens(p_a) as t),
       b as (select public.jev_title_tokens(p_b) as t)
  select case
           when cardinality(a.t) = 0 or cardinality(b.t) = 0 then null
           else round(
             (select count(*) from (select unnest(a.t) intersect select unnest(b.t)) i)::numeric
             / (select count(*) from (select unnest(a.t) union select unnest(b.t)) u), 3)
         end
    from a, b;
$fn$;

comment on function public.jev_title_jaccard(text, text) is
  'Word-Jaccard similarity of two titles'' token sets (migration 075). Null '
  'when either side tokenizes to zero words. IMMUTABLE, service_role only.';

-- ---------------------------------------------------------------------------
-- The refresh function: (a) bands untriaged pending candidates once, then
-- (b) writes the dry-run evaluation for every pending p < 0.1 candidate.
-- NEVER changes cluster membership and NEVER writes
-- jev_unlink_candidates.status/decided_at.
-- ---------------------------------------------------------------------------

create or replace function public.jev_unlink_triage_refresh(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_limit   integer := least(greatest(coalesce(p_limit, 500), 1), 2000);
  v_triaged integer := 0;
  v_logged  integer := 0;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('jev_unlink_triage_refresh')::bigint) then
    return 0;
  end if;

  -- (a) band each pending, untriaged candidate once
  with todo as (
    select u.id, u.jev_prob,
           public.jev_title_jaccard(a.title, c.title_tr)         as j_title,
           public.jev_title_jaccard(a.title, c.title_tr_neutral) as j_neutral
      from public.jev_unlink_candidates u
      join public.articles a on a.id = u.article_id
      join public.clusters c on c.id = u.cluster_id
     where u.status = 'pending' and u.triaged_at is null
     order by u.id
     limit v_limit
  ),
  scored as (
    select t.id, t.jev_prob,
           case when t.j_title is null and t.j_neutral is null then null
                else greatest(coalesce(t.j_title, 0), coalesce(t.j_neutral, 0)) end as jac
      from todo t
  )
  update public.jev_unlink_candidates u
     set title_jaccard = s.jac,
         band          = case when s.jac is not null and s.jac < 0.2 and s.jev_prob < 0.1
                              then 'likely_unlink' else 'review' end,
         triaged_at    = pg_catalog.now()
    from scored s
   where u.id = s.id;
  get diagnostics v_triaged = row_count;

  -- (b) DRY RUN: what a guarded auto-unlink WOULD do. Evaluation only.
  with cand as (
    select u.id, u.cluster_id, u.article_id, u.jev_prob, u.title_jaccard,
           c.article_count, c.title_tr, c.title_tr_neutral, a.title,
           least(a.published_at, a.created_at) as t0
      from public.jev_unlink_candidates u
      join public.clusters c on c.id = u.cluster_id
      join public.articles a on a.id = u.article_id
     where u.status = 'pending' and u.jev_prob < 0.1
     order by u.id
     limit v_limit
  ),
  checks as (
    select k.*,
           exists (select 1 from public.cluster_articles ca
                    where ca.cluster_id = k.cluster_id and ca.article_id = k.article_id) as is_member,
           coalesce(k.article_count, 0) >= 4 as big_enough,
           exists (select 1 from public.cluster_articles ca
                     join public.articles m on m.id = ca.article_id
                    where ca.cluster_id = k.cluster_id and ca.article_id <> k.article_id
                      and least(m.published_at, m.created_at) < k.t0) as has_earlier,
           exists (select 1 from public.cluster_articles ca
                     join public.jev_shadow_predictions p
                       on p.task = 'pair_positive'
                      and p.subject_id in (ca.article_id::text || ':' || k.article_id::text,
                                           k.article_id::text || ':' || ca.article_id::text)
                    where ca.cluster_id = k.cluster_id and ca.article_id <> k.article_id
                      and p.jev_prob >= 0.5) as pair_positive_link,
           (cardinality(public.jev_title_tokens(k.title)) > 0
            and (public.jev_title_tokens(k.title) = public.jev_title_tokens(k.title_tr)
                 or public.jev_title_tokens(k.title) = public.jev_title_tokens(k.title_tr_neutral))) as title_match
      from cand k
  ),
  verdict as (
    select ch.id, ch.cluster_id, ch.article_id, ch.jev_prob, ch.title_jaccard, ch.article_count,
           array_remove(array[
             case when not ch.is_member then 'not_member' end,
             case when not ch.big_enough then 'small_cluster' end,
             case when not ch.has_earlier then 'earliest_member' end,
             case when ch.pair_positive_link then 'pair_positive' end,
             case when coalesce(ch.title_match, false) then 'title_match' end
           ]::text[], null) as reasons
      from checks ch
  )
  insert into public.jev_unlink_dryrun as d
    (candidate_id, cluster_id, article_id, jev_prob, title_jaccard, cluster_size, would_unlink, skip_reasons)
  select v.id, v.cluster_id, v.article_id, v.jev_prob, v.title_jaccard,
         coalesce(v.article_count, 0), cardinality(v.reasons) = 0, v.reasons
    from verdict v
  on conflict (candidate_id) do update
     set would_unlink  = excluded.would_unlink,
         skip_reasons  = excluded.skip_reasons,
         cluster_size  = excluded.cluster_size,
         title_jaccard = excluded.title_jaccard,
         changed_at    = pg_catalog.now()
   where (d.would_unlink, d.skip_reasons, d.cluster_size, d.title_jaccard)
         is distinct from
         (excluded.would_unlink, excluded.skip_reasons, excluded.cluster_size, excluded.title_jaccard);
  get diagnostics v_logged = row_count;

  return v_triaged + v_logged;
end
$fn$;

comment on function public.jev_unlink_triage_refresh(integer) is
  'Migration 075: (a) bands untriaged pending jev_unlink_candidates rows '
  '(title_jaccard/band/triaged_at only), then (b) DRY-RUN evaluates the '
  'guarded auto-unlink rule for every pending jev_prob < 0.1 candidate into '
  'public.jev_unlink_dryrun. NEVER changes cluster_articles, clusters, or '
  'jev_unlink_candidates.status/decided_at -- an unlink still requires a '
  'human decision on /admin. Scheduled hourly via pg_cron; also callable '
  'manually with a larger p_limit for a backfill. Serialises concurrent '
  'runs with a transaction advisory lock.';

revoke all on function public.jev_title_tokens(text) from public, anon, authenticated;
revoke all on function public.jev_title_jaccard(text, text) from public, anon, authenticated;
revoke all on function public.jev_unlink_triage_refresh(integer) from public, anon, authenticated;
grant execute on function public.jev_title_tokens(text) to service_role;
grant execute on function public.jev_title_jaccard(text, text) to service_role;
grant execute on function public.jev_unlink_triage_refresh(integer) to service_role;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron not installed; skipping jev-unlink-triage schedule (075)';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'jev-unlink-triage') then
    perform cron.unschedule('jev-unlink-triage');
  end if;
  perform cron.schedule('jev-unlink-triage', '43 * * * *',
    $sql$ select public.jev_unlink_triage_refresh(); $sql$);
end $$;

select public.jev_unlink_triage_refresh(2000);   -- one-off backfill (the ~382 pending rows)

insert into supabase_migrations.schema_migrations (version, name)
  values ('075', '075_jev_unlink_triage') on conflict do nothing;
commit;
