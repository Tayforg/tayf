-- 063_jev_now_package.sql
--
-- "Jev şimdi" paketi (2026-09-21) — the measurement half of the Jev testing
-- period. 061 made Jev answer the questions the live pipeline already
-- answers and stored both answers side by side, but an agreement rate is
-- not an accuracy rate (061's own note, and jev-shadow-section.tsx's
-- "AGREEMENT IS NOT ACCURACY"). This file adds the human ground truth that
-- turns agreement into accuracy, plus the volume the two pair questions
-- need to say anything about clustering.
--
-- What lands here:
--   1. public.jev_gold_set / public.jev_gold_labels — a stratified,
--      two-labeler gold set. service_role-only (RLS on, no policies,
--      explicit revoke from anon/authenticated/public + sequence grants —
--      the same shell as 041/057/059/060/061). The only read/write surface
--      is the cookie-gated /admin/jev-altin page, through the three
--      SECURITY DEFINER functions below.
--   2. public.jev_gold_seed / jev_gold_next / jev_gold_scorecard — seed the
--      sample, serve one labeler its next unlabelled article, and compute
--      the scorecard in SQL (inter-labeler agreement, Jev accuracy vs gold
--      at two thresholds, feed-label accuracy vs gold, Jev topic accuracy
--      vs gold). The arithmetic lives here so /admin never pulls the label
--      table to divide two numbers.
--   3. The 'jev-cluster-audit' cron (03:55 UTC daily) which pokes the SAME
--      jev-shadow function with body {"mode":"audit"} — a run that asks
--      ONLY the two pair questions: up to 500 precision pairs
--      (pair_negative), and up to (qualifying clusters x
--      JEV_AUDIT_PAIRS_PER_CLUSTER) recall pairs (pair_positive) — ~313
--      at current cluster volume, bounded by cluster count and size
--      rather than by JEV_AUDIT_PAIR_COUNT — so cluster precision and
--      recall get a statistically useful daily sample the 10-minute
--      shadow run should not pay for.
--   4. jev_shadow_month_usage's default cap raised 3e8 -> 5e8 input tokens
--      (~$21 at the gateway market rate observed 2026-09-20). Measured
--      production burn at the */10 cadence (~149k input tokens/tick) is
--      ~648M tokens/30-day month -- about 130% of the 5e8 cap, reached
--      around day 23. 5e8 is a deliberate ~3-week ceiling, not a month
--      of headroom; the new ticker_relevance / neutral_pick stages add
--      ~0 to steady-state burn once their backlog drains.
--      JEV_MONTHLY_TOKEN_CAP_DEFAULT in supabase/functions/_shared/jev.ts
--      is the hand-duplicated twin; tests/migrations/jev-shadow-parity.test.ts
--      (JEV-A16) is the only thing keeping them equal.
--
-- Additive only: no existing table, column, constraint, policy, index,
-- trigger or cron job is dropped or altered. jev_shadow_month_usage is
-- CREATE OR REPLACEd with an unchanged signature (bigint), which preserves
-- ownership and ACLs; the grants are re-issued below regardless. The
-- jev_shadow_predictions.task COMMENT is re-issued with the three new task
-- names — a comment is not a schema change and leaves the (deliberately
-- CHECK-free) task vocabulary open. Safe to re-apply.
--
-- Kill switches (no migration, no deploy):
--   update cron.job set active = false where jobname = 'jev-cluster-audit';
--   update cron.job set active = false where jobname = 'jev-shadow';
--   supabase secrets set JEV_DISABLED=1   -- both modes 200 {skipped:true}

begin;

-- ---------------------------------------------------------------------------
-- 1. Gold set — the stratified sample two people label independently.
-- ---------------------------------------------------------------------------

create table if not exists public.jev_gold_set (
  article_id uuid primary key references public.articles(id) on delete cascade,
  stratum text not null,
  position int not null,
  added_at timestamptz not null default now()
);

comment on table public.jev_gold_set is
  'The Jev gold sample (migration 063): articles drawn stratified by feed '
  'category from the set that already carries a task=''politics'' row in '
  'jev_shadow_predictions, so every gold row is guaranteed to have a Jev '
  'answer to score against. service_role-only; nothing published anywhere. '
  'Seeded by public.jev_gold_seed(), served one row at a time by '
  'public.jev_gold_next(), scored by public.jev_gold_scorecard().';

comment on column public.jev_gold_set.stratum is
  'The articles.category the row was drawn under (politika, dunya, ekonomi, '
  'spor, yasam, teknoloji, genel, son_dakika). Kept denormalised so the '
  'per-category quota in jev_gold_seed stays correct even if '
  'articles.category is later corrected — the quota that was actually drawn '
  'is the one that matters for weighting the sample.';

comment on column public.jev_gold_set.position is
  'Stable labeling order, assigned once at seed time and never renumbered. '
  'jev_gold_next() serves the lowest unlabelled position, so both labelers '
  'walk the same sequence and the double-labelled prefix grows from the '
  'front — the scorecard becomes readable long before the set is finished.';

create index if not exists jev_gold_set_position_idx
  on public.jev_gold_set (position);

create index if not exists jev_gold_set_stratum_idx
  on public.jev_gold_set (stratum);

-- ---------------------------------------------------------------------------
-- 2. Labels — one row per (article, labeler). The ground truth.
-- ---------------------------------------------------------------------------

create table if not exists public.jev_gold_labels (
  id bigserial primary key,
  article_id uuid not null
    references public.jev_gold_set(article_id) on delete cascade,
  labeler smallint not null check (labeler in (1, 2)),
  is_politics boolean not null,
  topic text not null
    check (topic in ('politika', 'dunya', 'ekonomi', 'spor', 'yasam', 'teknoloji', 'genel')),
  note text,
  created_at timestamptz not null default now(),
  unique (article_id, labeler)
);

comment on table public.jev_gold_labels is
  'Human labels for the Jev gold set (migration 063). Exactly two labelers '
  '(1 and 2) label independently; a row is GOLD only where both agree on '
  'BOTH fields — disagreement is excluded from every accuracy figure rather '
  'than adjudicated, so the gold standard is never a single person''s call. '
  'unique (article_id, labeler) is also the idempotency key the admin route '
  'upserts against, so re-saving a label corrects it instead of 23505-ing. '
  'Written only by POST /api/admin/jev-gold/label behind hasAdminSession(). '
  'HAZARD: article_id references public.jev_gold_set(article_id) on delete '
  'cascade, which itself references public.articles(id) on delete cascade '
  '-- these rows, the most expensive asset this migration creates, cascade '
  'away silently the moment their article is deleted. The admin '
  '"nuke_articles" action (src/app/api/admin/route.ts) deletes every row of '
  'public.articles; export public.jev_gold_labels (and jev_gold_set) before '
  'ANY bulk article deletion.';

comment on column public.jev_gold_labels.topic is
  'The feed taxonomy, NOT Jev''s 3-way taxonomy. jev_gold_scorecard() maps '
  'politika->politics, ekonomi->economy, dunya->null (excluded as ambiguous '
  'from jev_topic''s n, not scored as wrong) and everything else->other '
  'before comparing against jev_shadow_predictions.jev_choice for '
  'task=''topic'', mirroring topicBaseline() in '
  'supabase/functions/_shared/jev.ts, which also returns null for dunya.';

comment on column public.jev_gold_labels.labeler is
  'Which of the two humans wrote this row. Carried in the request BODY of '
  'POST /api/admin/jev-gold/label and validated there; the jev_labeler '
  'cookie is a UI convenience only and is never an authorization signal '
  '(hasAdminSession() is the only gate).';

create index if not exists jev_gold_labels_article_idx
  on public.jev_gold_labels (article_id);

create index if not exists jev_gold_labels_labeler_idx
  on public.jev_gold_labels (labeler);

-- ---------------------------------------------------------------------------
-- 3. RLS + grants — service_role only, same shell as 061.
-- ---------------------------------------------------------------------------

alter table public.jev_gold_set enable row level security;
alter table public.jev_gold_labels enable row level security;

revoke all on public.jev_gold_set from anon, authenticated, public;
revoke all on public.jev_gold_labels from anon, authenticated, public;

grant select, insert on public.jev_gold_set to service_role;
grant select, insert, update on public.jev_gold_labels to service_role;

-- bigserial needs its sequence granted separately (061's precedent).
revoke all on sequence public.jev_gold_labels_id_seq from anon, authenticated, public;
grant usage, select on sequence public.jev_gold_labels_id_seq to service_role;

-- ---------------------------------------------------------------------------
-- 4. Seed — stratified draw, idempotent, bounded.
-- ---------------------------------------------------------------------------

-- Drives from jev_shadow_predictions (task='politics', last 30 days) and
-- joins articles by primary key, NOT the mirror-image "scan every article
-- and probe predictions" plan: this function is reached over PostgREST,
-- where the authenticator role's statement_timeout is 8s, and the
-- articles-side scan is the exact shape that has already timed out twice in
-- this codebase (jev-shadow/index.ts fetchPairCandidates, and DB-02 in
-- src/lib/finance/queries.ts). subject_id = articles.id::text for every
-- article task; article_id is the indexed, typed mirror of it (061).
--
-- Idempotent: rows already in the set count against the per-category quota
-- and are excluded from the draw, so calling this twice on a full set
-- inserts 0 and calling it after a week of new articles tops each category
-- back up to p_per_category.
create or replace function public.jev_gold_seed(p_per_category int default 38)
returns integer
language sql
volatile
security definer
set search_path = ''
as $fn$
  -- Transaction-scoped advisory lock, first statement: serializes concurrent
  -- seeds so two callers under read-committed can never read the same
  -- max(position) and assign overlapping positions (jev_gold_set.position
  -- has no unique index -- see the column comment). LANGUAGE SQL has no
  -- `perform`; a SQL-language function may hold several semicolon-separated
  -- statements and returns only the last one's value, so this lock-only
  -- select's result is simply discarded.
  select pg_advisory_xact_lock(hashtext('jev_gold_seed'));

  with quota as (
    select least(greatest(coalesce(p_per_category, 0), 0), 500) as per_category
  ),
  existing as (
    select g.stratum, count(*)::int as n
    from public.jev_gold_set g
    group by g.stratum
  ),
  -- Bounds the driver BEFORE the join + random() window: row_number() over
  -- (order by random()) is volatile, so no index can supply that ordering
  -- and without this cap Postgres must materialize and sort every
  -- jev_shadow_predictions row in the 30-day window -- exactly the 8s
  -- PostgREST statement_timeout exposure this function is built to avoid.
  -- 20000 is far above the quota's actual max draw (8 categories x 500
  -- clamped per_category = 4000), so it never changes which rows are
  -- eligible to compete for a slot -- but it is a recency bound, not a
  -- uniform one: `order by created_at desc limit 20000` draws from the most
  -- recent predictions in a high-volume month rather than uniformly across
  -- the full 30 days. Raise this limit deliberately if that skew matters.
  preds as (
    select p.article_id
    from public.jev_shadow_predictions p
    where p.task = 'politics'
      and p.created_at >= now() - interval '30 days'
    order by p.created_at desc
    limit 20000
  ),
  candidates as (
    select
      a.id,
      a.category,
      row_number() over (partition by a.category order by random()) as rn
    from preds p
    join public.articles a on a.id = p.article_id
    where a.category is not null
      and not exists (
        select 1 from public.jev_gold_set g where g.article_id = a.id
      )
  ),
  picked as (
    select c.id, c.category, c.rn
    from candidates c
    cross join quota q
    left join existing e on e.stratum = c.category
    where c.rn <= greatest(0, q.per_category - coalesce(e.n, 0))
  ),
  numbered as (
    select
      k.id,
      k.category,
      (select coalesce(max(g.position), 0) from public.jev_gold_set g)
        + (row_number() over (order by k.category, k.rn))::int as next_position
    from picked k
  ),
  ins as (
    insert into public.jev_gold_set (article_id, stratum, position)
    select n.id, n.category, n.next_position
    from numbered n
    on conflict (article_id) do nothing
    returning 1
  )
  select coalesce(count(*), 0)::int from ins;
$fn$;

comment on function public.jev_gold_seed(int) is
  'Tops the gold set up to p_per_category rows per feed category (default '
  '38 x 8 categories = 304), drawing only from articles that already have a '
  'task=''politics'' jev_shadow_predictions row in the last 30 days so every '
  'gold row is scoreable. Returns the number of rows inserted. Idempotent: '
  'existing rows count against the quota and are never re-drawn. The '
  'driving preds CTE bounds itself to the 20000 most recent matching '
  'predictions (created_at desc) before the random() window, to keep the '
  'volatile ordering from forcing a full-window sort under PostgREST''s 8s '
  'statement_timeout; on a high-volume month this trades a small recency '
  'skew (the draw favours the most recent predictions over a uniform slice '
  'of the 30-day window) for that bound — raise the limit if that skew '
  'matters more than the timeout risk.';

-- ---------------------------------------------------------------------------
-- 5. Next — one unlabelled article for one labeler, plus progress.
-- ---------------------------------------------------------------------------

-- ALWAYS returns exactly one row. When the labeler has finished the set,
-- article_id/title/... come back NULL and total/done still read — the admin
-- page needs the progress line even on the "done" screen, and a zero-row
-- result would force a second round trip to get it.
--
-- `position` is legal as a table column name but NOT as a RETURNS TABLE
-- output name (Postgres 15: "syntax error at or near position" — the
-- parameter list parser treats it as the POSITION(x IN y) keyword). The
-- output column is therefore `gold_position`; the table column keeps its
-- name and every reference to it below is table-qualified.
create or replace function public.jev_gold_next(p_labeler smallint)
returns table (
  article_id uuid,
  title text,
  description text,
  category text,
  source_slug text,
  gold_position int,
  total bigint,
  done bigint
)
language sql
stable
security definer
set search_path = ''
as $fn$
  with counts as (
    select
      (select count(*) from public.jev_gold_set)::bigint as total_n,
      (select count(*) from public.jev_gold_labels l where l.labeler = p_labeler)::bigint as done_n
  ),
  nxt as (
    select g.article_id as id, g.position as pos
    from public.jev_gold_set g
    where not exists (
      select 1
      from public.jev_gold_labels l
      where l.article_id = g.article_id
        and l.labeler = p_labeler
    )
    order by g.position
    limit 1
  )
  select
    n.id,
    a.title,
    a.description,
    a.category,
    s.slug,
    n.pos,
    c.total_n,
    c.done_n
  from counts c
  left join nxt n on true
  left join public.articles a on a.id = n.id
  left join public.sources s on s.id = a.source_id;
$fn$;

comment on function public.jev_gold_next(smallint) is
  'The lowest-position gold article p_labeler has not labelled yet, plus '
  'that labeler''s progress (done of total). Always returns exactly one '
  'row; article_id is NULL when the labeler has finished the set.';

-- ---------------------------------------------------------------------------
-- 6. Scorecard — one jsonb, all the arithmetic, n on every figure.
-- ---------------------------------------------------------------------------

-- Every rate is null when its n is 0; the caller renders "henüz yok" below
-- n = 30 because a rate over a handful of rows is noise, not a measurement.
-- GOLD = rows where both labelers agree on BOTH fields. Disagreements are
-- excluded, never adjudicated.
create or replace function public.jev_gold_scorecard()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  with labeled as (
    select l.labeler, count(*)::bigint as n
    from public.jev_gold_labels l
    group by l.labeler
  ),
  pair_rows as (
    select
      l1.article_id  as article_id,
      l1.is_politics as pol1,
      l2.is_politics as pol2,
      l1.topic       as topic1,
      l2.topic       as topic2
    from public.jev_gold_labels l1
    join public.jev_gold_labels l2
      on l2.article_id = l1.article_id
     and l2.labeler = 2
    where l1.labeler = 1
  ),
  dbl as (
    select
      count(*)::bigint                                   as n,
      count(*) filter (where b.pol1 = b.pol2)::bigint     as politics_agree,
      count(*) filter (where b.topic1 = b.topic2)::bigint as topic_agree
    from pair_rows b
  ),
  gold as (
    select
      b.article_id,
      b.pol1 as is_politics,
      case
        when b.topic1 = 'politika' then 'politics'
        when b.topic1 = 'ekonomi'  then 'economy'
        when b.topic1 = 'dunya'    then null
        else 'other'
      end as topic3
    from pair_rows b
    where b.pol1 = b.pol2
      and b.topic1 = b.topic2
  ),
  jev_pol_rows as (
    select g.is_politics, p.jev_prob
    from gold g
    join public.jev_shadow_predictions p
      on p.task = 'politics'
     and p.subject_id = g.article_id::text
    where p.jev_prob is not null
  ),
  jev_pol as (
    select
      count(*)::bigint as n,
      count(*) filter (where (r.jev_prob >= 0.5) = r.is_politics)::bigint as c50,
      count(*) filter (where (r.jev_prob >= 0.7) = r.is_politics)::bigint as c70
    from jev_pol_rows r
  ),
  feed_rows as (
    select
      g.is_politics,
      (a.category in ('politika', 'son_dakika')) as feed_politics
    from gold g
    join public.articles a on a.id = g.article_id
  ),
  feed as (
    select
      count(*)::bigint as n,
      count(*) filter (where r.feed_politics = r.is_politics)::bigint as c
    from feed_rows r
  ),
  topic_rows as (
    select g.topic3, p.jev_choice
    from gold g
    join public.jev_shadow_predictions p
      on p.task = 'topic'
     and p.subject_id = g.article_id::text
    where p.jev_choice is not null
      and g.topic3 is not null
  ),
  jev_topic as (
    select
      count(*)::bigint as n,
      count(*) filter (where r.jev_choice = r.topic3)::bigint as c
    from topic_rows r
  )
  select jsonb_build_object(
    'labeled',
      coalesce((select jsonb_object_agg(l.labeler::text, l.n) from labeled l), '{}'::jsonb),
    'double_labeled', jsonb_build_object(
      'n', d.n,
      'politics_agree', d.politics_agree,
      'politics_rate', case when d.n > 0 then round(d.politics_agree::numeric / d.n, 3) end,
      'topic_agree', d.topic_agree,
      'topic_rate', case when d.n > 0 then round(d.topic_agree::numeric / d.n, 3) end
    ),
    'gold_n', (select count(*)::bigint from gold),
    'jev_politics_050', jsonb_build_object(
      'n', jp.n,
      'correct', jp.c50,
      'rate', case when jp.n > 0 then round(jp.c50::numeric / jp.n, 3) end
    ),
    'jev_politics_070', jsonb_build_object(
      'n', jp.n,
      'correct', jp.c70,
      'rate', case when jp.n > 0 then round(jp.c70::numeric / jp.n, 3) end
    ),
    'feed_politics', jsonb_build_object(
      'n', f.n,
      'correct', f.c,
      'rate', case when f.n > 0 then round(f.c::numeric / f.n, 3) end
    ),
    'jev_topic', jsonb_build_object(
      'n', jt.n,
      'correct', jt.c,
      'rate', case when jt.n > 0 then round(jt.c::numeric / jt.n, 3) end
    )
  )
  from dbl d, jev_pol jp, feed f, jev_topic jt;
$fn$;

comment on function public.jev_gold_scorecard() is
  'One jsonb with every Jev gold figure and the n behind each one: '
  'per-labeler label counts, inter-labeler agreement on is_politics and on '
  'topic over double-labelled rows, the gold row count, Jev politics '
  'accuracy at jev_prob >= 0.5 and >= 0.7, feed-label (category in '
  'politika/son_dakika) accuracy, and Jev 3-way topic accuracy. Every rate '
  'is null when its n is 0. Rates below n = 30 are noise — the /admin page '
  'renders "henüz yok" instead.';

-- ---------------------------------------------------------------------------
-- 7. Monthly cap raised 3e8 -> 5e8 (same signature, CREATE OR REPLACE).
-- ---------------------------------------------------------------------------

create or replace function public.jev_shadow_month_usage(
  p_cap bigint default 500000000
)
returns table (
  runs bigint,
  calls bigint,
  input_tokens bigint,
  cap bigint,
  exceeded boolean
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select
    count(*)::bigint                                   as runs,
    coalesce(sum(r.calls), 0)::bigint                  as calls,
    coalesce(sum(r.input_tokens), 0)::bigint           as input_tokens,
    p_cap                                              as cap,
    coalesce(sum(r.input_tokens), 0)::bigint >= p_cap  as exceeded
  from public.jev_shadow_runs r
  where r.started_at >= (date_trunc('month', (now() at time zone 'utc')) at time zone 'utc');
$fn$;

comment on function public.jev_shadow_month_usage(bigint) is
  'Month-to-date (UTC) jev-shadow spend. Reads jev_shadow_runs, never '
  'jev_shadow_predictions (whose input_tokens column repeats the call-level '
  'count on every row of a multi-question call). The default cap was raised '
  'from 3e8 to 5e8 input tokens (~$21 at the gateway market rate observed '
  '2026-09-20) by migration 063, to cover the nightly jev-cluster-audit run '
  'and the ticker_relevance / neutral_pick shadow stages. The Edge Function '
  'refuses to make any call while exceeded is true. NOTE for operators: an '
  'explicit JEV_MONTHLY_TOKEN_CAP Edge secret overrides this default for the '
  'function but NOT for the /admin budget line, which always reads this '
  'default — unset the secret after applying 063.';

revoke all on function public.jev_shadow_month_usage(bigint) from anon, authenticated, public;
revoke all on function public.jev_gold_seed(int) from anon, authenticated, public;
revoke all on function public.jev_gold_next(smallint) from anon, authenticated, public;
revoke all on function public.jev_gold_scorecard() from anon, authenticated, public;

grant execute on function public.jev_shadow_month_usage(bigint) to service_role;
grant execute on function public.jev_gold_seed(int) to service_role;
grant execute on function public.jev_gold_next(smallint) to service_role;
grant execute on function public.jev_gold_scorecard() to service_role;

-- ---------------------------------------------------------------------------
-- 8. The task vocabulary gains three names (comment only — task is
--    deliberately CHECK-free so a new shadow question needs no migration).
-- ---------------------------------------------------------------------------

comment on column public.jev_shadow_predictions.task is
  'Question id: politics | topic | opinion | clickbait | framing | '
  'sensational | cluster_member | pair_negative | pair_positive | '
  'ticker_relevance | neutral_pick | kap_class | kap_materiality | '
  'title_meaning | title_edit_kind. The vocabulary lives in '
  'supabase/functions/_shared/jev.ts (JEV_TASKS) and is parity-tested '
  'against this comment in tests/migrations/jev-shadow-parity.test.ts. '
  'Deliberately NOT a CHECK constraint: adding a shadow question must not '
  'require a migration during the testing period. Added by 063: '
  'pair_positive (two headlines the clusterer DID put together — recall, '
  'baseline ''true''), ticker_relevance (does this article_tickers match '
  'actually concern the company — baseline ''true''), neutral_pick (which '
  'member headline Jev would choose as the neutral title, against the '
  'extractive-v1 pick).';

comment on column public.jev_shadow_predictions.subject_id is
  'Stable text key of the thing judged: articles.id for article tasks, '
  '"<clusterId>:<articleId>" for cluster_member, "<idA>:<idB>" with the two '
  'uuids sorted lexicographically for pair_negative and pair_positive (so '
  'the same unordered pair can never be scored twice under one task), '
  'kap_disclosures.disclosure_index for KAP tasks, '
  'article_title_versions.id::text for title tasks, and — added by 063 — '
  '"<articleId>:<TICKER>" for ticker_relevance and clusters.id for '
  'neutral_pick (one pick per cluster, ever).';

-- ---------------------------------------------------------------------------
-- 9. Schedule — the nightly cluster audit. Same do-block shape as 061's
--    jev-shadow job (which mirrors 060/058): idempotent reschedule, skipped
--    with a NOTICE when pg_cron/pg_net or the Vault bearer are absent,
--    secrets read from Vault at run time and never baked into this file.
--
--    03:55 UTC is deliberately off the */10 grid the jev-shadow job runs
--    on (minutes 00/10/20/30/40/50), so the audit never starts inside a
--    shadow run's 60s window. It is also clear of archive-export (03:40),
--    kap-corrections-daily (03:15) and the even-minute kap-drain (*/2).
--
--    Kill switch (no migration needed):
--      update cron.job set active = false where jobname = 'jev-cluster-audit';
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_net')
  then
    raise notice 'pg_cron/pg_net missing — skipping jev-cluster-audit schedule (063_jev_now_package.sql).';
    return;
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'service_role_key')
     or not exists (select 1 from vault.decrypted_secrets where name = 'functions_base_url')
  then
    raise notice 'Vault secrets missing — skipping jev-cluster-audit schedule (063). See 038.';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'jev-cluster-audit') then
    perform cron.unschedule('jev-cluster-audit');
  end if;

  perform cron.schedule('jev-cluster-audit', '55 3 * * *', $sql$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_base_url') || '/jev-shadow',
      headers := jsonb_build_object('Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
      body := '{"mode":"audit"}'::jsonb,
      timeout_milliseconds := 60000)
  $sql$);
end
$$;

insert into supabase_migrations.schema_migrations (version, name)
  values ('063', '063_jev_now_package')
  on conflict do nothing;

commit;