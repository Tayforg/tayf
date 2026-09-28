-- 090_topic7_v2_groundwork.sql  (topic7 v2, part 7a -- no question text change here)
--
-- Measurement + labeling groundwork for topic7 v2 (data-7, revised by the Jev lead):
--   1. jev_url_section_topic(url): the outlet's own URL section -> topic7 label (yardstick only).
--   2. jev_topic7_yardstick_daily + nightly refresh: per (UTC day, topic7 question key) regex-feed
--      agreement, section agreement, p>=0.8 share, genel/politika/dunya shares. A live 168 h scan
--      measured 12.1 s on prod (2026-09-28) -- over PostgREST's 8 s -- so /admin reads a rollup.
--   3. (deferred to T7b) topic7-fingerprint pin for /konu labels -- to be added additively as a
--      NEW function, never by dropping 067's overload.
--   4. jev_shadow_queue: topic7 disagreements are stratified -- every row whose outlet section is
--      known and disagrees with Jev, plus a deterministic ~5% hash sample of section-less rows.
--      This file is the single owner of jev_shadow_queue among the 2026-09-28 Jev specs.
--   5. jev_gold_next_prioritized (076): topic7 disagreement (provisional label vs stored Jev
--      topic7) now also ranks first, so the held-out adjudication pass reaches those rows first.
--   6. jev_gold_topic7_scorecard(): dev (opus_seed) vs held-out (original 304) composition and
--      final-label provenance (human agreed > human single > provisional).
-- DEPENDS ON 067, 076, 088 (jev_stage_budgets is not touched here).
begin;

-- 1 -------------------------------------------------------------------------
create or replace function public.jev_url_section_topic(p_url text)
returns text
language sql
immutable
set search_path = ''
as $fn$
  with s(seg) as (
    select pg_catalog.lower((pg_catalog.regexp_match(p_url, '^https?://[^/]+/(?:tr/|video/|haber/)?([a-z0-9-]+)/'))[1])
  )
  select case
    when seg = any (array['dunya','world','dis-haber','dunya-haberleri','middle-east']) then 'dunya'
    when seg = any (array['siyaset','politika','politics']) then 'politika'
    when seg = any (array['ekonomi','finans','sektorler','business','sirketler','kuresel-ekonomi','ekonomi-haberleri']) then 'ekonomi'
    when seg = any (array['spor','milli-takim','sporarena','super-lig','spor-haberleri','sports']) then 'spor'
    when seg = any (array['teknoloji','bilim-teknoloji']) then 'teknoloji'
    when seg = any (array['yasam','magazin','kultur-sanat','saglik','egitim','kultur','astroloji','kelebek',
                          'gurme','seyahat','hayat','tv-rehberi','venus','mor-papatya']) then 'yasam'
    when seg = any (array['3-sayfa','3sayfa','asayis']) then 'genel'
    else null
  end
  from s
$fn$;
comment on function public.jev_url_section_topic(text) is
  'The outlet''s own URL section mapped to the topic7 vocabulary, or null when ambiguous (gundem, guncel, '
  'turkiye, haber, none). A yardstick only (090): never written to any article or cluster row.';
revoke all on function public.jev_url_section_topic(text) from anon, authenticated, public;
grant execute on function public.jev_url_section_topic(text) to service_role;

-- 2 -------------------------------------------------------------------------
create table if not exists public.jev_topic7_yardstick_daily (
  day            date    not null,
  question_key   text    not null,   -- jev_answer.question_hash, or 'qs:' || question_set for pre-088 rows
  question_set   text,
  n              integer not null,
  feed_n         integer not null,
  feed_agree     integer not null,
  section_n      integer not null,
  section_agree  integer not null,
  p080_n         integer not null,
  genel_n        integer not null,
  politika_n     integer not null,
  dunya_n        integer not null,
  computed_at    timestamptz not null default now(),
  primary key (day, question_key)
);
comment on table public.jev_topic7_yardstick_daily is
  'Nightly topic7 yardsticks per (UTC day, topic7 question key) (090). feed_* = agreement with the regex '
  'articles.category (legacy, ~53% accurate on Opus gold); section_* = agreement with the outlet URL section '
  '(jev_url_section_topic, sectioned rows only). service_role-only.';
alter table public.jev_topic7_yardstick_daily enable row level security;
revoke all on public.jev_topic7_yardstick_daily from anon, authenticated, public;
grant select, insert, update on public.jev_topic7_yardstick_daily to service_role;

create or replace function public.jev_topic7_yardstick_refresh(p_days integer default 2)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_days integer := greatest(1, least(coalesce(p_days, 2), 31));
  v_to   timestamptz := (((pg_catalog.now() at time zone 'utc')::date)::timestamp at time zone 'utc');
  v_from timestamptz := v_to - pg_catalog.make_interval(days => v_days);
  v_n    integer;
begin
  insert into public.jev_topic7_yardstick_daily as y
    (day, question_key, question_set, n, feed_n, feed_agree, section_n, section_agree, p080_n,
     genel_n, politika_n, dunya_n, computed_at)
  select (p.created_at at time zone 'utc')::date,
         coalesce(p.jev_answer ->> 'question_hash', 'qs:' || coalesce(p.jev_answer ->> 'question_set', '')),
         pg_catalog.max(p.jev_answer ->> 'question_set'),
         pg_catalog.count(*)::int,
         (pg_catalog.count(*) filter (where p.agree is not null))::int,
         (pg_catalog.count(*) filter (where p.agree))::int,
         (pg_catalog.count(*) filter (where public.jev_url_section_topic(a.url) is not null))::int,
         (pg_catalog.count(*) filter (where public.jev_url_section_topic(a.url) = p.jev_choice))::int,
         (pg_catalog.count(*) filter (where
             pg_catalog.jsonb_typeof(p.jev_answer -> 'answer' -> 'probabilities' -> p.jev_choice) = 'number'
             and (p.jev_answer -> 'answer' -> 'probabilities' ->> p.jev_choice)::numeric >= 0.8))::int,
         (pg_catalog.count(*) filter (where p.jev_choice = 'genel'))::int,
         (pg_catalog.count(*) filter (where p.jev_choice = 'politika'))::int,
         (pg_catalog.count(*) filter (where p.jev_choice = 'dunya'))::int,
         pg_catalog.now()
    from public.jev_shadow_predictions p
    join public.articles a on a.id = p.article_id
   where p.task = 'topic7'
     and p.jev_choice is not null
     and p.created_at >= v_from and p.created_at < v_to
   group by 1, 2
  on conflict (day, question_key) do update set
    question_set = excluded.question_set, n = excluded.n, feed_n = excluded.feed_n,
    feed_agree = excluded.feed_agree, section_n = excluded.section_n, section_agree = excluded.section_agree,
    p080_n = excluded.p080_n, genel_n = excluded.genel_n, politika_n = excluded.politika_n,
    dunya_n = excluded.dunya_n, computed_at = pg_catalog.now();
  get diagnostics v_n = row_count;
  return v_n;
end
$fn$;
revoke all on function public.jev_topic7_yardstick_refresh(integer) from anon, authenticated, public;
grant execute on function public.jev_topic7_yardstick_refresh(integer) to service_role;

create or replace function public.jev_topic7_yardsticks(p_days integer default 7)
returns table (question_key text, question_set text, n bigint, feed_agree numeric, section_n bigint,
               section_agree numeric, p080_share numeric, genel_share numeric, politika_share numeric,
               dunya_share numeric)
language sql
stable
security definer
set search_path = ''
as $fn$
  select y.question_key, pg_catalog.max(y.question_set),
         pg_catalog.sum(y.n)::bigint,
         pg_catalog.round(pg_catalog.sum(y.feed_agree)::numeric / nullif(pg_catalog.sum(y.feed_n), 0), 3),
         pg_catalog.sum(y.section_n)::bigint,
         pg_catalog.round(pg_catalog.sum(y.section_agree)::numeric / nullif(pg_catalog.sum(y.section_n), 0), 3),
         pg_catalog.round(pg_catalog.sum(y.p080_n)::numeric / nullif(pg_catalog.sum(y.n), 0), 3),
         pg_catalog.round(pg_catalog.sum(y.genel_n)::numeric / nullif(pg_catalog.sum(y.n), 0), 3),
         pg_catalog.round(pg_catalog.sum(y.politika_n)::numeric / nullif(pg_catalog.sum(y.n), 0), 3),
         pg_catalog.round(pg_catalog.sum(y.dunya_n)::numeric / nullif(pg_catalog.sum(y.n), 0), 3)
    from public.jev_topic7_yardstick_daily y
   where y.day >= (pg_catalog.now() at time zone 'utc')::date - greatest(1, least(coalesce(p_days, 7), 62))
   group by y.question_key
   order by pg_catalog.max(y.question_set), y.question_key;
$fn$;
revoke all on function public.jev_topic7_yardsticks(integer) from anon, authenticated, public;
grant execute on function public.jev_topic7_yardsticks(integer) to service_role;

-- 4 -------------------------------------------------------------------------
create or replace function public.jev_shadow_queue(p_limit integer default 30)
returns table (id bigint, task text, subject_type text, subject_id text, state_preview text,
               baseline_answer text, jev_prob numeric, jev_choice text, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $fn$
  select p.id, p.task, p.subject_type, p.subject_id,
         coalesce(p.jev_answer ->> 'state_preview', '') as state_preview,
         p.baseline_answer, p.jev_prob, p.jev_choice, p.created_at
    from public.jev_shadow_predictions p
    left join public.articles a on p.task = 'topic7' and a.id = p.article_id
   where p.agree = false
     and not exists (select 1 from public.jev_shadow_reviews r where r.prediction_id = p.id)
     and (
       p.task <> 'topic7'
       or (public.jev_url_section_topic(a.url) is not null
           and public.jev_url_section_topic(a.url) <> p.jev_choice)
       or (public.jev_url_section_topic(a.url) is null
           and pg_catalog.abs(pg_catalog.hashtext(p.id::text)) % 20 = 0)   -- ~5% deterministic sample
     )
   order by p.created_at desc
   limit greatest(1, least(p_limit, 200));
$fn$;
comment on function public.jev_shadow_queue(integer) is
  'Unreviewed disagreements, newest first (090). topic7 rows are stratified: all whose outlet URL section is '
  'known and disagrees with Jev, plus a deterministic ~5% (hashtext(id) % 20 = 0) sample of section-less rows, '
  'so reviews still reach the gundem/section-less cases. Every other task unchanged from 061.';
revoke all on function public.jev_shadow_queue(integer) from anon, authenticated, public;
grant execute on function public.jev_shadow_queue(integer) to service_role;

-- 5 -------------------------------------------------------------------------
create or replace function public.jev_gold_next_prioritized(p_labeler smallint)
returns table (
  article_id uuid, title text, description text, category text, source_slug text,
  gold_position int, total bigint, done bigint,
  priority text, disagree_total bigint, disagree_done bigint
)
language sql
stable
security definer
set search_path = ''
as $fn$
  with prov as (
    select pl.article_id, pl.is_politics, pl.topic,
           coalesce(live.jev_prob, pl.ref_jev_prob) as jev_p,
           t7.jev_choice as jev_topic7
      from public.jev_gold_provisional_labels pl
      left join lateral (
        select p.jev_prob from public.jev_shadow_predictions p
         where p.task = 'politics' and p.subject_id = pl.article_id::text and p.jev_prob is not null
         limit 1
      ) live on true
      left join lateral (   -- 090: stored topic7 answer (UNIQUE (task, subject_id) -> at most one)
        select p.jev_choice from public.jev_shadow_predictions p
         where p.task = 'topic7' and p.subject_id = pl.article_id::text and p.jev_choice is not null
         limit 1
      ) t7 on true
  ),
  ranked as (
    select g.article_id, g.position as pos,
           case
             when pv.article_id is not null
                  and ((pv.jev_p is not null and (pv.jev_p >= 0.5) <> pv.is_politics)
                    or (pv.jev_topic7 is not null and pv.jev_topic7 <> pv.topic)) then 0   -- 090: topic7 too
             when pv.article_id is null then 1
             else 2
           end as prio
      from public.jev_gold_set g
      left join prov pv on pv.article_id = g.article_id
  ),
  mine as (select l.article_id from public.jev_gold_labels l where l.labeler = p_labeler),
  counts as (
    select (select count(*) from public.jev_gold_set)::bigint as total_n,
           (select count(*) from mine)::bigint as done_n,
           (select count(*) from ranked r where r.prio = 0)::bigint as dis_total,
           (select count(*) from ranked r join mine m on m.article_id = r.article_id where r.prio = 0)::bigint as dis_done
  ),
  nxt as (
    select r.article_id as id, r.pos, r.prio
      from ranked r
     where not exists (select 1 from mine m where m.article_id = r.article_id)
     order by r.prio, r.pos, r.article_id
     limit 1
  )
  select n.id, a.title, a.description, a.category, s.slug, n.pos, c.total_n, c.done_n,
         case n.prio when 0 then 'disagreement' when 1 then 'gold' when 2 then 'provisional' end,
         c.dis_total, c.dis_done
    from counts c
    left join nxt n on true
    left join public.articles a on a.id = n.id
    left join public.sources s on s.id = a.source_id;
$fn$;
comment on function public.jev_gold_next_prioritized(smallint) is
  '076 "Anlaşmazlıklar önce", amended by 090: priority 0 is now a politics disagreement (provisional label vs '
  'Jev at 0.5) OR a topic7 disagreement (provisional topic vs the stored Jev topic7 choice). Contract unchanged.';
revoke all on function public.jev_gold_next_prioritized(smallint) from anon, authenticated, public;
grant execute on function public.jev_gold_next_prioritized(smallint) to service_role;

-- 6 -------------------------------------------------------------------------
create or replace function public.jev_gold_topic7_scorecard()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  with h as (
    select l.article_id,
           pg_catalog.count(*) as n_labels,
           pg_catalog.count(distinct l.topic) as n_topics,
           pg_catalog.min(l.topic) filter (where l.labeler = 1) as t1,
           pg_catalog.min(l.topic) as tmin
      from public.jev_gold_labels l
     group by l.article_id
  ),
  g as (
    select gs.article_id,
           case when gs.stratum = 'opus_seed' then 'dev' else 'heldout' end as split,
           pl.topic as prov_topic, pl.label_source,
           case when h.n_labels >= 2 and h.n_topics = 1 then h.tmin
                when h.n_labels >= 1 then coalesce(h.t1, h.tmin) end as human_topic,
           case when h.n_labels >= 2 and h.n_topics = 1 then 'human_agreed'
                when h.n_labels >= 1 then 'human_single'
                when pl.topic is not null then 'provisional'
                else 'none' end as final_source,
           t7.jev_choice as stored_choice,
           coalesce(t7.jev_answer ->> 'question_hash', 'qs:' || coalesce(t7.jev_answer ->> 'question_set', '')) as stored_key
      from public.jev_gold_set gs
      left join public.jev_gold_provisional_labels pl on pl.article_id = gs.article_id
      left join h on h.article_id = gs.article_id
      left join public.jev_shadow_predictions t7
        on t7.task = 'topic7' and t7.subject_id = gs.article_id::text and t7.jev_choice is not null
  ),
  f as (
    select g.*, coalesce(g.human_topic, g.prov_topic) as final_topic from g
  )
  select pg_catalog.jsonb_build_object(
    'by_split', coalesce((select pg_catalog.jsonb_object_agg(x.split, x.o) from (
        select f.split, pg_catalog.jsonb_build_object(
                 'n', pg_catalog.count(*),
                 'final_by_source', (select pg_catalog.jsonb_object_agg(y.final_source, y.c) from
                    (select f2.final_source, pg_catalog.count(*) c from f f2 where f2.split = f.split group by 1) y),
                 'prov_vs_human_n', pg_catalog.count(*) filter (where f.prov_topic is not null and f.human_topic is not null),
                 'prov_vs_human_agree', pg_catalog.count(*) filter (where f.prov_topic is not null and f.prov_topic = f.human_topic)
               ) as o
          from f group by f.split) x), '{}'::jsonb),
    'stored_vs_final', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'split', x.split, 'stored_key', x.stored_key, 'n', x.n, 'correct', x.c)) from (
        select f.split, f.stored_key, pg_catalog.count(*) as n,
               pg_catalog.count(*) filter (where f.stored_choice = f.final_topic) as c
          from f where f.stored_choice is not null and f.final_topic is not null
         group by 1, 2) x), '[]'::jsonb),
    'note', 'stored_vs_final scores the ONE stored topic7 row per article (UNIQUE task, subject_id): for the '
            'original gold that is question set 2026-09-21.3 (v1). Current-text accuracy comes from the weekly '
            'regression replay (computeRegressionGold().topic7 / .provisional), not from this function.'
  );
$fn$;
comment on function public.jev_gold_topic7_scorecard() is
  'topic7 gold bookkeeping (090): dev (stratum opus_seed) vs held-out (original strata) composition, final-label '
  'provenance (human_agreed > human_single > provisional), provisional-vs-human agreement, and the stored '
  '(v1) prediction vs final label. Never merged into jev_gold_scorecard().';
revoke all on function public.jev_gold_topic7_scorecard() from anon, authenticated, public;
grant execute on function public.jev_gold_topic7_scorecard() to service_role;

-- Fix-pass note (090 review): a prod EXPLAIN ANALYZE of jev_topic7_yardstick_refresh's SELECT
-- (read-only, inlined since 090 isn't applied yet) showed the planner picking
-- jev_shadow_predictions_created_idx (created_at desc, INCLUDE task/agree) and filtering
-- task = 'topic7' afterward -- discarding ~87% of scanned rows -- instead of seeking directly via
-- the existing jev_shadow_predictions_task_created_idx (task, created_at desc) from 061. That cost
-- a live day ~1.14s against a stated 0.44s baseline. Not user-facing (nightly cron, p_days=2, no 2s
-- gate applies here -- only jev_shadow_queue has that gate) so this is not a ship-blocker, but stale
-- planner statistics on a fast-growing table are the most likely cause, so refresh them once here
-- rather than carry a mis-costed plan into the new nightly cadence below.
analyze public.jev_shadow_predictions;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron not installed -- skipping jev-topic7-yardsticks schedule (090)';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'jev-topic7-yardsticks') then
    perform cron.unschedule('jev-topic7-yardsticks');
  end if;
  perform cron.schedule('jev-topic7-yardsticks', '25 0 * * *', $sql$ select public.jev_topic7_yardstick_refresh(2); $sql$);
end $$;

insert into supabase_migrations.schema_migrations (version, name)
  values ('090', '090_topic7_v2_groundwork') on conflict do nothing;

commit;
