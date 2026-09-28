-- 089_jev_politics_admission.sql  (data-6, revised by the Jev lead 2026-09-28)
--
-- Jev politics admission for the clusterer. Inert until cluster-consumer runs with
-- JEV_POLITICS_ADMISSION=shadow|live. Candidates are pinned by per-task QUESTION
-- FINGERPRINTS (jev_answer.question_hash, stamped by JEV-A/088 code), never by the
-- registry-global question_set, so unrelated bumps (JEV-B) do not pause admission and
-- a topic7 text change (topic7 v2) drops candidates to shadow until re-audited.
-- DEPENDS ON 088 being deployed in code (question_hash stamps) -- the SQL itself only
-- needs 061/063/064. APPLY TO PROD BEFORE MERGING TO MAIN: the app and the consumer
-- select articles.politics_admitted_at (PostgREST 400 otherwise -- the 071 lesson).
begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Stamp read by the three 60%-politics read paths (live mode only).
--    NOTE: articles has "public read articles" (anon, qual true) + table-level anon
--    SELECT, so this column is publicly readable. Accepted and documented (it only
--    says "Jev admitted this article into political clustering"); /api/v1 never
--    serialises it.
-- ---------------------------------------------------------------------------
alter table public.articles add column if not exists politics_admitted_at timestamptz;
comment on column public.articles.politics_admitted_at is
  'Set by public.jev_politics_admission_claim() for LIVE claims only (089): Jev judged this non-politika '
  'article domestic politics (politics p >= 0.9 AND topic7 = politika from the same call, under a live-pinned '
  'question fingerprint pair) and it was enqueued on cluster_work. Read paths count a member with this stamp as a '
  'politics member. Cleared by jev_politics_admission_rollback(). Publicly readable (anon table grant).';

-- ---------------------------------------------------------------------------
-- 2. One row per claimed article (shadow or live).
-- ---------------------------------------------------------------------------
create table if not exists public.jev_politics_admissions (
  article_id              uuid primary key references public.articles(id) on delete cascade,
  mode                    text not null check (mode in ('shadow', 'live')),
  politics_prediction_id  bigint references public.jev_shadow_predictions(id) on delete set null,
  politics_p              numeric not null,
  topic7_p                numeric,
  politics_hash           text not null,
  topic7_hash             text not null,
  call_id                 text,
  category                text not null,
  source_id               uuid,
  published_at            timestamptz not null,
  ingested_at             timestamptz not null,
  scored_at               timestamptz not null,
  claimed_at              timestamptz not null default now(),
  outcome                 text check (outcome in ('matched', 'created', 'would_match', 'would_create',
                                                  'disabled', 'rejected', 'not_found')),
  cluster_id              uuid references public.clusters(id) on delete set null,
  cluster_seeded_by_admission boolean,
  ensemble_score          real,
  cluster_sources_before  integer,
  blindspot_before        boolean,
  blindspot_after         boolean,
  zone_added              boolean,
  decided_at              timestamptz,
  review_verdict          text check (review_verdict in ('domestic', 'policy_adjacent', 'foreign',
                                                         'not_politics', 'unsure')),
  reviewed_at             timestamptz,
  rolled_back_at          timestamptz
);
comment on table public.jev_politics_admissions is
  'Politics-admission claims (089). mode shadow = dry-run through the real clusterArticle, nothing written '
  'except this row; mode live = articles.politics_admitted_at stamped and the article clustered. '
  'review_verdict rubric: domestic | policy_adjacent (siyasete komşu / yerel yönetim) | foreign | '
  'not_politics | unsure; politics-relevant = domestic + policy_adjacent. service_role-only.';
create index if not exists jev_politics_admissions_claimed_idx
  on public.jev_politics_admissions (claimed_at desc);
create index if not exists jev_politics_admissions_cluster_idx
  on public.jev_politics_admissions (cluster_id) where cluster_id is not null;
alter table public.jev_politics_admissions enable row level security;
revoke all on public.jev_politics_admissions from anon, authenticated, public;
grant select, insert, update on public.jev_politics_admissions to service_role;

-- ---------------------------------------------------------------------------
-- 3. Claim (called by cluster-consumer at the top of every drain when the flag is on).
--    p_live_pins / p_shadow_pins: jsonb arrays of {"politics": "<fp>", "topic7": "<fp>"}.
--    Effective row mode: live only when p_mode = 'live' AND the pair is in p_live_pins;
--    otherwise shadow (pair must be in one of the two lists).
-- ---------------------------------------------------------------------------
create or replace function public.jev_politics_admission_claim(
  p_mode                text,
  p_live_pins           jsonb    default '[]'::jsonb,
  p_shadow_pins         jsonb    default '[]'::jsonb,
  p_min_politics        numeric  default 0.9,
  p_topic7              text     default 'politika',
  p_excluded_categories text[]   default array['politika', 'son_dakika', 'dunya'],
  p_max_age             interval default interval '6 hours',
  p_lookback            interval default interval '90 minutes',
  p_limit               integer  default 20
)
returns table (claimed integer, enqueued integer, live integer)
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  r      record;
  v_n    integer := 0;
  v_live integer := 0;
begin
  if p_mode is null or p_mode not in ('shadow', 'live') then
    raise exception 'jev_politics_admission_claim: mode must be shadow or live' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'jev_politics_admission_claim: p_limit out of range' using errcode = '22023';
  end if;
  if p_min_politics is null or p_min_politics < 0.5 or p_min_politics > 1 then
    raise exception 'jev_politics_admission_claim: p_min_politics out of range' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(coalesce(p_live_pins, 'null'::jsonb)) <> 'array'
     or pg_catalog.jsonb_typeof(coalesce(p_shadow_pins, 'null'::jsonb)) <> 'array' then
    raise exception 'jev_politics_admission_claim: pins must be jsonb arrays' using errcode = '22023';
  end if;

  for r in
    with cand as (
      select p.article_id, p.id as prediction_id, p.jev_prob as politics_p,
             case when pg_catalog.jsonb_typeof(t.jev_answer -> 'answer' -> 'probabilities' -> p_topic7) = 'number'
                  then (t.jev_answer -> 'answer' -> 'probabilities' ->> p_topic7)::numeric end as topic7_p,
             (p.jev_answer ->> 'question_hash') as politics_hash,
             (t.jev_answer ->> 'question_hash') as topic7_hash,
             (p.jev_answer ->> 'call_id') as call_id,
             a.category, a.source_id, a.published_at, a.created_at as ingested_at, p.created_at as scored_at
        from public.jev_shadow_predictions p
        join public.jev_shadow_predictions t
          on t.task = 'topic7' and t.subject_id = p.subject_id
        join public.articles a on a.id = p.article_id
       where p.task = 'politics'
         and p.created_at >= pg_catalog.now() - p_lookback
         and p.jev_prob >= p_min_politics
         and t.jev_choice = p_topic7
         and (p.jev_answer ->> 'call_id') is not null
         and (t.jev_answer ->> 'call_id') = (p.jev_answer ->> 'call_id')   -- same packed call
         and (p.jev_answer ->> 'question_hash') is not null
         and (t.jev_answer ->> 'question_hash') is not null
         and a.category is not null
         and not (a.category = any (p_excluded_categories))
         and least(a.published_at, a.created_at) >= pg_catalog.now() - p_max_age
         and not exists (select 1 from public.cluster_articles ca where ca.article_id = a.id)
    ),
    pinned as (
      select c.*,
             exists (select 1 from pg_catalog.jsonb_array_elements(p_live_pins) e
                      where e ->> 'politics' = c.politics_hash and e ->> 'topic7' = c.topic7_hash) as in_live,
             exists (select 1 from pg_catalog.jsonb_array_elements(p_shadow_pins) e
                      where e ->> 'politics' = c.politics_hash and e ->> 'topic7' = c.topic7_hash) as in_shadow
        from cand c
    ),
    moded as (
      select pn.*, case when p_mode = 'live' and pn.in_live then 'live' else 'shadow' end as eff_mode
        from pinned pn
       where pn.in_live or pn.in_shadow
    )
    select m.*
      from moded m
     where not exists (
             select 1 from public.jev_politics_admissions x
              where x.article_id = m.article_id
                and (x.mode = 'live' or x.mode = m.eff_mode or x.rolled_back_at is not null))
     order by m.scored_at desc
     limit p_limit
  loop
    insert into public.jev_politics_admissions as j
      (article_id, mode, politics_prediction_id, politics_p, topic7_p, politics_hash, topic7_hash, call_id,
       category, source_id, published_at, ingested_at, scored_at)
    values
      (r.article_id, r.eff_mode, r.prediction_id, r.politics_p, r.topic7_p, r.politics_hash, r.topic7_hash,
       r.call_id, r.category, r.source_id, r.published_at, r.ingested_at, r.scored_at)
    on conflict (article_id) do update
      set mode = 'live', claimed_at = pg_catalog.now(), outcome = null, cluster_id = null,
          cluster_seeded_by_admission = null, ensemble_score = null, cluster_sources_before = null,
          blindspot_before = null, blindspot_after = null, zone_added = null, decided_at = null
      where j.mode = 'shadow' and excluded.mode = 'live';
    if not found then
      continue;
    end if;

    if r.eff_mode = 'live' then
      update public.articles a set politics_admitted_at = pg_catalog.now()
       where a.id = r.article_id and a.politics_admitted_at is null;
      v_live := v_live + 1;
    end if;

    perform pgmq.send('cluster_work',
      pg_catalog.jsonb_build_object('article_id', r.article_id, 'admit', r.eff_mode));
    v_n := v_n + 1;
  end loop;

  return query select v_n, v_n, v_live;
end;
$fn$;
comment on function public.jev_politics_admission_claim(text, jsonb, jsonb, numeric, text, text[], interval, interval, integer) is
  'Claims fresh (least(published_at, created_at) >= now - p_max_age) non-excluded articles whose politics '
  'prediction (p >= p_min_politics, created within p_lookback) and topic7 = p_topic7 answer come from the same '
  'packed call under a pinned (politics, topic7) question-fingerprint pair; inserts jev_politics_admissions, '
  'stamps articles.politics_admitted_at for live rows, and pgmq.sends {article_id, admit} to cluster_work. '
  'Idempotent per (article, mode); a shadow row upgrades to live once. Never claims a rolled-back article (089).';

do $$ begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'postgres') then
    alter function public.jev_politics_admission_claim(text, jsonb, jsonb, numeric, text, text[], interval, interval, integer) owner to postgres;
  end if;
end $$;
revoke all on function public.jev_politics_admission_claim(text, jsonb, jsonb, numeric, text, text[], interval, interval, integer) from anon, authenticated, public;
grant execute on function public.jev_politics_admission_claim(text, jsonb, jsonb, numeric, text, text[], interval, interval, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Record the consumer's routing outcome for a claim.
-- ---------------------------------------------------------------------------
create or replace function public.jev_politics_admission_record(
  p_article_id uuid, p_outcome text, p_cluster_id uuid default null, p_score real default null,
  p_sources_before integer default null, p_blindspot_before boolean default null,
  p_blindspot_after boolean default null, p_zone_added boolean default null,
  p_cluster_seeded_by_admission boolean default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare v_n integer;
begin
  if p_outcome is null or p_outcome not in ('matched', 'created', 'would_match', 'would_create',
                                            'disabled', 'rejected', 'not_found') then
    raise exception 'jev_politics_admission_record: bad outcome' using errcode = '22023';
  end if;
  update public.jev_politics_admissions j
     set outcome = p_outcome, cluster_id = p_cluster_id, ensemble_score = p_score,
         cluster_sources_before = p_sources_before, blindspot_before = p_blindspot_before,
         blindspot_after = p_blindspot_after, zone_added = p_zone_added,
         cluster_seeded_by_admission = p_cluster_seeded_by_admission, decided_at = pg_catalog.now()
   where j.article_id = p_article_id and j.rolled_back_at is null;
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$fn$;
revoke all on function public.jev_politics_admission_record(uuid, text, uuid, real, integer, boolean, boolean, boolean, boolean) from anon, authenticated, public;
grant execute on function public.jev_politics_admission_record(uuid, text, uuid, real, integer, boolean, boolean, boolean, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Stats for the admin card and the promotion gates (G1-G6).
--    No bias->zone CASE here (the admin maps with BIAS_TO_ZONE; zone-parity untouched).
-- ---------------------------------------------------------------------------
create or replace function public.jev_politics_admission_stats(p_hours integer default 48)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  with b as (
    select greatest(1, least(coalesce(p_hours, 48), 720)) as hours
  ),
  adm as (
    select j.*, s.bias as source_bias, s.kind as source_kind
      from public.jev_politics_admissions j
      left join public.sources s on s.id = j.source_id
     cross join b
     where j.claimed_at >= pg_catalog.now() - pg_catalog.make_interval(hours => b.hours)
  ),
  fresh as (   -- G1, article side: ingested 1-6 h ago, scored within 60 min of ingest?
    select a.id, (p.created_at is not null and p.created_at <= a.created_at + interval '60 minutes') as fast
      from public.articles a
      left join public.jev_shadow_predictions p on p.task = 'politics' and p.subject_id = a.id::text
     where a.created_at >= pg_catalog.now() - interval '6 hours'
       and a.created_at <  pg_catalog.now() - interval '1 hour'
       and a.category is not null
  ),
  seeded as (  -- clusters an admission created (live only)
    select distinct j.cluster_id from public.jev_politics_admissions j
     where j.outcome = 'created' and j.cluster_id is not null and j.rolled_back_at is null
  ),
  base as (
    select s.bias from public.articles a join public.sources s on s.id = a.source_id
     where a.created_at >= pg_catalog.now() - pg_catalog.make_interval(hours => least(coalesce(p_hours, 48), 48))
       and a.category in ('politika', 'son_dakika') and s.kind in ('outlet', 'wire')
  )
  select pg_catalog.jsonb_build_object(
    'hours', (select b.hours from b),
    'claims', (select pg_catalog.count(*) from adm),
    'claims_shadow', (select pg_catalog.count(*) from adm where adm.mode = 'shadow'),
    'claims_live', (select pg_catalog.count(*) from adm where adm.mode = 'live'),
    'claims_per_day', (select pg_catalog.round(pg_catalog.count(*) * 24.0 / (select b.hours from b), 1) from adm),
    'by_category', coalesce((select pg_catalog.jsonb_object_agg(x.category, x.n) from
        (select adm.category, pg_catalog.count(*) as n from adm group by adm.category) x), '{}'::jsonb),
    'by_pin', coalesce((select pg_catalog.jsonb_object_agg(x.k, x.n) from
        (select adm.politics_hash || '/' || adm.topic7_hash as k, pg_catalog.count(*) as n from adm group by 1) x), '{}'::jsonb),
    'outcomes', coalesce((select pg_catalog.jsonb_object_agg(coalesce(x.outcome, 'undecided'), x.n) from
        (select adm.outcome, pg_catalog.count(*) as n from adm group by adm.outcome) x), '{}'::jsonb),
    'decided', (select pg_catalog.count(*) from adm where adm.outcome is not null),
    'stuck', (select pg_catalog.count(*) from adm
               where adm.outcome is null and adm.claimed_at < pg_catalog.now() - interval '15 minutes'),
    'join_existing', (select pg_catalog.count(*) from adm
               where adm.outcome in ('matched', 'would_match') and coalesce(adm.cluster_seeded_by_admission, false) = false),
    'join_admission_seeded', (select pg_catalog.count(*) from adm
               where adm.outcome = 'matched' and adm.cluster_seeded_by_admission),
    'joined_multi_source', (select pg_catalog.count(*) from adm
               where adm.outcome in ('matched', 'would_match') and coalesce(adm.cluster_seeded_by_admission, false) = false
                 and adm.cluster_sources_before >= 2),
    'zone_added_existing', (select pg_catalog.count(*) from adm
               where adm.zone_added and coalesce(adm.cluster_seeded_by_admission, false) = false),
    'blindspot_withdrawn', (select pg_catalog.count(*) from adm where adm.blindspot_before and not adm.blindspot_after),
    'blindspot_created', (select pg_catalog.count(*) from adm where not adm.blindspot_before and adm.blindspot_after),
    'clusters_touched', (select pg_catalog.count(distinct adm.cluster_id) from adm where adm.outcome in ('matched', 'would_match')),
    'reviews', coalesce((select pg_catalog.jsonb_object_agg(x.review_verdict, x.n) from
        (select adm.review_verdict, pg_catalog.count(*) as n from adm where adm.review_verdict is not null
          group by adm.review_verdict) x), '{}'::jsonb),
    'claim_lag_p50_min', (select pg_catalog.round((percentile_cont(0.5) within group
        (order by extract(epoch from (adm.claimed_at - adm.ingested_at)) / 60.0))::numeric, 1) from adm),
    'fresh_ingested', (select pg_catalog.count(*) from fresh),
    'fresh_scored_60m_share', (select pg_catalog.round(avg(fresh.fast::int)::numeric, 3) from fresh),
    'seeded_clusters', (select pg_catalog.count(*) from seeded),
    'seeded_politika_members', (select pg_catalog.count(*) from public.cluster_articles ca
        join seeded sd on sd.cluster_id = ca.cluster_id
        join public.articles a on a.id = ca.article_id
       where a.category in ('politika', 'son_dakika')),
    'seeded_unlink_candidates', (select pg_catalog.count(*) from public.jev_unlink_candidates u
        join seeded sd on sd.cluster_id = u.cluster_id),
    'admitted_in_unlink', (select pg_catalog.count(*) from public.jev_unlink_candidates u
        join adm on adm.article_id = u.article_id and adm.cluster_id = u.cluster_id
       where adm.outcome = 'matched'),
    'admitted_bias', coalesce((select pg_catalog.jsonb_object_agg(x.source_bias, x.n) from
        (select adm.source_bias, pg_catalog.count(*) as n from adm
          where adm.source_bias is not null and adm.source_kind in ('outlet', 'wire') group by adm.source_bias) x), '{}'::jsonb),
    'baseline_bias', coalesce((select pg_catalog.jsonb_object_agg(x.bias, x.n) from
        (select base.bias, pg_catalog.count(*) as n from base where base.bias is not null group by base.bias) x), '{}'::jsonb)
  );
$fn$;
revoke all on function public.jev_politics_admission_stats(integer) from anon, authenticated, public;
grant execute on function public.jev_politics_admission_stats(integer) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Hard rollback: unset JEV_POLITICS_ADMISSION first; run with p_dry_run => true, then false.
-- ---------------------------------------------------------------------------
create or replace function public.jev_politics_admission_rollback(p_since timestamptz, p_dry_run boolean default true)
returns table (admissions integer, memberships integer, clusters_emptied integer)
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare r record; v_adm integer := 0; v_mem integer := 0; v_empty integer := 0; v_left integer;
begin
  if p_since is null then
    raise exception 'jev_politics_admission_rollback: p_since is required' using errcode = '22023';
  end if;
  select pg_catalog.count(*)::int into v_adm from public.jev_politics_admissions j
   where j.mode = 'live' and j.rolled_back_at is null and j.claimed_at >= p_since;
  for r in
    select ca.cluster_id, ca.article_id
      from public.jev_politics_admissions j
      join public.cluster_articles ca on ca.article_id = j.article_id
     where j.mode = 'live' and j.rolled_back_at is null and j.claimed_at >= p_since
     order by j.claimed_at
  loop
    v_mem := v_mem + 1;
    if not p_dry_run then
      v_left := public.cluster_unlink_article(r.cluster_id, r.article_id);  -- 064: recompute under the link lock
      if v_left = 0 then v_empty := v_empty + 1; end if;
    end if;
  end loop;
  if not p_dry_run then
    update public.articles a set politics_admitted_at = null
      from public.jev_politics_admissions j
     where j.article_id = a.id and j.mode = 'live' and j.rolled_back_at is null and j.claimed_at >= p_since;
    update public.jev_politics_admissions j set rolled_back_at = pg_catalog.now()
     where j.mode = 'live' and j.rolled_back_at is null and j.claimed_at >= p_since;
  end if;
  return query select v_adm, v_mem, v_empty;
end;
$fn$;
revoke all on function public.jev_politics_admission_rollback(timestamptz, boolean) from anon, authenticated, public;
grant execute on function public.jev_politics_admission_rollback(timestamptz, boolean) to service_role;

insert into supabase_migrations.schema_migrations (version, name)
  values ('089', '089_jev_politics_admission') on conflict do nothing;

commit;
