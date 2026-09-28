-- 076_jev_gold_provisional.sql
--
-- Gold seed: the gold set (migration 063) has 304 rows and 0 human labels.
-- Two people double-labeling 304 rows each is the plan; 360 of those
-- answers already exist for free -- platform-7 paid for them from Opus in
-- the 2026-09-20 limits rig (platform-7 calls them "Opus labels";
-- LIMITS-REPORT.md calls them "hand-labelled" -- neither name changes what
-- they are: a MODEL's answer, never a human's). This migration:
--
--   1. Adds public.jev_gold_provisional_labels, a NEW table for labeler 0
--      (CHECK labeler = 0) that stores those 360 Opus labels plus each
--      row's Jev reference answer from the same rig
--      (accuracy_t1.json['en'], title-only, English instructions,
--      2026-09-20). Provisional labels never touch jev_gold_labels (whose
--      CHECK stays (1, 2)) and are never read by jev_gold_scorecard() --
--      the human-only karne can never mix in a model label.
--   2. Adds public.jev_gold_import_provisional(), a SECURITY DEFINER
--      loader the operator runs once (via the committed
--      scripts/sql/jev-gold-opus-seed.sql, never by this migration) that
--      joins the 360 articles into jev_gold_set under stratum
--      'opus_seed' (so the existing labeling route can write real human
--      labels for them through the jev_gold_labels FK, exactly like any
--      other gold row) and records the provisional label + reference
--      probability for each.
--   3. Adds public.jev_gold_next_prioritized(), "Anlaşmazlıklar önce": it
--      re-implements jev_gold_next()'s one-row-per-call contract but
--      orders disagreement rows (provisional label vs Jev reference/live
--      answer, at JEV_PROVISIONAL_THRESHOLD = 0.5) first, then the
--      original 304 gold rows, then provisional-agreement rows last. One
--      human adjudicating ~54 disagreements replaces 2x304 blind passes.
--   4. Adds public.jev_gold_provisional_scorecard(), a second jsonb
--      karne scoped entirely to the provisional labels + their human
--      adjudication outcome -- again, never merged into
--      jev_gold_scorecard()'s output.
--
-- Provenance, stored verbatim as label_source (never presented as human
-- labels anywhere in the UI): 'opus-2026-09-20'.
--
-- Step 0 read-only counts (sbq.py, 2026-09-28, against prod):
--   select (select count(*) from jev_gold_set) as gold_set_n,
--          (select count(*) from jev_gold_labels) as gold_labels_n;
--   -> gold_set_n = 304, gold_labels_n = 0 (matches the brief).
--
--   Against the 360 Opus-labelled article ids:
--   select count(*) from articles where id = any(ids)              -> 360
--   select count(*) from jev_gold_set where article_id = any(ids)  -> 4
--   select count(distinct subject_id) from jev_shadow_predictions
--     where task = 'politics' and subject_id = any(ids::text[])    -> 30
--   All three match the idea's expectations (360 / 4 / ~30) exactly.
--
-- Runbook (operator, at deploy -- this migration alone changes nothing
-- visible; the seed is a separate, explicit step):
--   1. Apply this migration (076) the normal way.
--   2. Run scripts/sql/jev-gold-opus-seed.sql ONCE, as postgres:
--        psql "$DATABASE_URL" -f scripts/sql/jev-gold-opus-seed.sql
--      It is idempotent (both inserts below are ON CONFLICT DO NOTHING);
--      re-running it is harmless. It is NOT under supabase/, so
--      `supabase db reset` (which only replays ./seed.sql) never applies
--      it automatically.
--   3. Deploy the Vercel build. /admin/jev-altin falls back to the
--      un-prioritized queue (getJevGoldNext) if this migration or the
--      seed have not landed yet -- labeling never breaks either way.
--   4. Expect: provisional_n ~360, disagree_n ~54 from
--      jev_gold_provisional_scorecard() after the seed runs.
--
-- Additive only: no existing table, column, function signature, or grant
-- is dropped or altered. jev_gold_labels, jev_gold_set, jev_gold_seed(),
-- jev_gold_next() and jev_gold_scorecard() are all untouched -- this file
-- does not even CREATE OR REPLACE any of them.

begin;

-- ---------------------------------------------------------------------------
-- 1. Provisional labels -- labeler 0 ONLY, a separate table from the human
--    jev_gold_labels so the human-only scorecard can never mix in a model
--    label and the route/types/attention tile keep their existing 1|2
--    contract untouched.
-- ---------------------------------------------------------------------------

create table if not exists public.jev_gold_provisional_labels (
  article_id uuid primary key
    references public.jev_gold_set(article_id) on delete cascade,
  labeler smallint not null default 0 check (labeler = 0),
  label_source text not null,
  is_politics boolean not null,
  topic text not null
    check (topic in ('politika', 'dunya', 'ekonomi', 'spor', 'yasam', 'teknoloji', 'genel')),
  note text,
  ref_jev_prob numeric(4,3) check (ref_jev_prob is null or (ref_jev_prob >= 0 and ref_jev_prob <= 1)),
  ref_jev_source text,
  created_at timestamptz not null default now()
);

comment on table public.jev_gold_provisional_labels is
  'Provisional MODEL labels (labeler 0) for the Jev gold set (migration '
  '076): the 360 Opus labels paid for in the 2026-09-20 limits rig, '
  'label_source ''opus-2026-09-20''. Never a human label, never gold, and '
  'never read by public.jev_gold_scorecard() -- the human-only karne stays '
  'human-only. Read by public.jev_gold_next_prioritized() (to order the '
  'queue "disagreements first") and public.jev_gold_provisional_scorecard() '
  '(a separate, clearly-labelled karne). ref_jev_prob/ref_jev_source carry '
  'the same rig''s Jev reference answer (title-only, English instructions, '
  'accuracy_t1.json[''en'']) so a live jev_shadow_predictions answer can '
  'override it without a second table.';

comment on column public.jev_gold_provisional_labels.labeler is
  'Always 0 -- CHECK-enforced. Distinguishes this table''s rows from '
  'jev_gold_labels'' human labelers 1 and 2; never conflated in any query.';

comment on column public.jev_gold_provisional_labels.ref_jev_prob is
  'Jev''s politics probability for this article from the 2026-09-20 limits '
  'rig (title-only, English instructions, t1, en) -- a REFERENCE answer, '
  'superseded by a live public.jev_shadow_predictions row when one exists '
  '(see jev_gold_next_prioritized and jev_gold_provisional_scorecard). Null '
  'when the rig had no answer for this id.';

alter table public.jev_gold_provisional_labels enable row level security;

revoke all on public.jev_gold_provisional_labels from anon, authenticated, public;
grant select on public.jev_gold_provisional_labels to service_role;

-- ---------------------------------------------------------------------------
-- 2. Import -- SECURITY DEFINER loader, run once by the operator via
--    scripts/sql/jev-gold-opus-seed.sql. Joins the 360 articles into
--    jev_gold_set (stratum 'opus_seed') and writes their provisional
--    labels. Same advisory-lock key as jev_gold_seed() (063): both
--    functions assign jev_gold_set.position by max()+n with no unique
--    index backing it, so they must never race each other.
-- ---------------------------------------------------------------------------

create or replace function public.jev_gold_import_provisional(
  p_rows jsonb, p_label_source text, p_stratum text default 'opus_seed')
returns table (set_inserted integer, labels_inserted integer, missing_articles integer)
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_source  text := nullif(btrim(coalesce(p_label_source, '')), '');
  v_set     integer := 0;
  v_labels  integer := 0;
  v_missing integer := 0;
begin
  if v_source is null then raise exception 'jev_gold_import_provisional: p_label_source is required'; end if;
  if coalesce(p_stratum, '') !~ '^[a-z0-9_]{1,40}$' then raise exception 'jev_gold_import_provisional: bad p_stratum'; end if;
  if p_rows is null or pg_catalog.jsonb_typeof(p_rows) <> 'array' then
    raise exception 'jev_gold_import_provisional: p_rows must be a jsonb array';
  end if;
  if pg_catalog.jsonb_array_length(p_rows) > 2000 then
    raise exception 'jev_gold_import_provisional: at most 2000 rows per call';
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_to_recordset(p_rows)
      as r(article_id uuid, is_politics boolean, topic text, note text, ref_jev_prob numeric, ref_jev_source text)
     where r.article_id is null or r.is_politics is null or r.topic is null
        or r.topic not in ('politika', 'dunya', 'ekonomi', 'spor', 'yasam', 'teknoloji', 'genel')
        or (r.ref_jev_prob is not null and (r.ref_jev_prob < 0 or r.ref_jev_prob > 1))
  ) then
    raise exception 'jev_gold_import_provisional: invalid row(s)';
  end if;

  -- Same key as jev_gold_seed (063): positions are max+n with no unique index.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('jev_gold_seed'));

  with src as (
    select distinct r.article_id
      from pg_catalog.jsonb_to_recordset(p_rows) as r(article_id uuid)
  ),
  eligible as (
    select s.article_id
      from src s
      join public.articles a on a.id = s.article_id
     where not exists (select 1 from public.jev_gold_set g where g.article_id = s.article_id)
  ),
  numbered as (
    select e.article_id,
           (select coalesce(max(g.position), 0) from public.jev_gold_set g)
             + (row_number() over (order by e.article_id))::int as next_position
      from eligible e
  )
  insert into public.jev_gold_set (article_id, stratum, position)
  select n.article_id, p_stratum, n.next_position from numbered n
  on conflict (article_id) do nothing;
  get diagnostics v_set = row_count;

  with src as (
    select distinct on (r.article_id)
           r.article_id, r.is_politics, r.topic, r.note, r.ref_jev_prob, r.ref_jev_source
      from pg_catalog.jsonb_to_recordset(p_rows)
        as r(article_id uuid, is_politics boolean, topic text, note text, ref_jev_prob numeric, ref_jev_source text)
     order by r.article_id
  )
  insert into public.jev_gold_provisional_labels
    (article_id, labeler, label_source, is_politics, topic, note, ref_jev_prob, ref_jev_source)
  select s.article_id, 0, v_source, s.is_politics, s.topic,
         nullif(left(coalesce(s.note, ''), 300), ''),
         round(s.ref_jev_prob, 3),
         nullif(left(coalesce(s.ref_jev_source, ''), 120), '')
    from src s
    join public.jev_gold_set g on g.article_id = s.article_id
  on conflict (article_id) do nothing;
  get diagnostics v_labels = row_count;

  select count(*)::int into v_missing
    from (select distinct r.article_id from pg_catalog.jsonb_to_recordset(p_rows) as r(article_id uuid)) s
   where not exists (select 1 from public.articles a where a.id = s.article_id);

  set_inserted := v_set; labels_inserted := v_labels; missing_articles := v_missing;
  return next;
end
$fn$;

comment on function public.jev_gold_import_provisional(jsonb, text, text) is
  'One-shot loader for the Opus provisional labels (migration 076), run by '
  'the operator ONCE via scripts/sql/jev-gold-opus-seed.sql (never by app '
  'code, never by CI). Joins missing articles into jev_gold_set under '
  'p_stratum (default ''opus_seed'') and writes each row''s provisional '
  'label into jev_gold_provisional_labels. Idempotent: both inserts are ON '
  'CONFLICT DO NOTHING, so re-running reports 0/0 aside from any newly '
  'missing article. Capped at 2000 rows/call; validates every row before '
  'writing anything. Takes the SAME advisory-lock key as jev_gold_seed() '
  '(063, hashtext(''jev_gold_seed'')) because both assign jev_gold_set.position '
  'via max()+n with no unique index -- they must never run concurrently.';

-- ---------------------------------------------------------------------------
-- 3. Prioritized next -- "Anlaşmazlıklar önce": 0 = provisional vs Jev
--    disagree (p >= JEV_PROVISIONAL_THRESHOLD), 1 = original gold row (no
--    provisional label), 2 = provisional agree / no Jev answer to compare.
-- ---------------------------------------------------------------------------

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
    select pl.article_id, pl.is_politics, coalesce(live.jev_prob, pl.ref_jev_prob) as jev_p
      from public.jev_gold_provisional_labels pl
      left join lateral (
        select p.jev_prob from public.jev_shadow_predictions p
         where p.task = 'politics' and p.subject_id = pl.article_id::text and p.jev_prob is not null
         limit 1
      ) live on true
  ),
  ranked as (
    select g.article_id, g.position as pos,
           case
             when pv.article_id is not null and pv.jev_p is not null
                  and (pv.jev_p >= 0.5) <> pv.is_politics then 0
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
  '"Anlaşmazlıklar önce" (migration 076): like jev_gold_next() (063) -- one '
  'row per call, article fields null when the labeler has finished -- but '
  'orders the queue priority (0 = provisional label vs Jev disagree at '
  '>= 0.5), position (1 = the original gold row, no provisional label), '
  'position (2 = provisional label and Jev agree, or no Jev answer to '
  'compare), then position. gold_position (not position -- see 063''s '
  'RETURNS TABLE lesson) plus disagree_total/disagree_done let the caller '
  'show adjudication progress on the ~54-row disagreement subset '
  'separately from the full-set progress.';

-- ---------------------------------------------------------------------------
-- 4. Provisional scorecard -- entirely separate from jev_gold_scorecard();
--    never merges a model label into the human-only karne.
-- ---------------------------------------------------------------------------

create or replace function public.jev_gold_provisional_scorecard()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  with prov as (
    select pl.article_id, pl.is_politics,
           coalesce(live.jev_prob, pl.ref_jev_prob) as jev_p,
           case when live.jev_prob is not null then 'live' when pl.ref_jev_prob is not null then 'ref' end as jev_src
      from public.jev_gold_provisional_labels pl
      left join lateral (
        select p.jev_prob from public.jev_shadow_predictions p
         where p.task = 'politics' and p.subject_id = pl.article_id::text and p.jev_prob is not null
         limit 1
      ) live on true
  ),
  human as (
    select distinct on (l.article_id) l.article_id, l.is_politics
      from public.jev_gold_labels l
     order by l.article_id, l.labeler
  ),
  j as (
    select pv.article_id, pv.is_politics, pv.jev_p, pv.jev_src, h.is_politics as human_pol,
           (pv.jev_p is not null and (pv.jev_p >= 0.5) <> pv.is_politics) as disagree
      from prov pv left join human h on h.article_id = pv.article_id
  )
  select jsonb_build_object(
    'provisional_n', count(*),
    'jev_n', count(*) filter (where j.jev_p is not null),
    'jev_live_n', count(*) filter (where j.jev_src = 'live'),
    'jev_agree_n', count(*) filter (where j.jev_p is not null and not j.disagree),
    'disagree_n', count(*) filter (where j.disagree),
    'adjudicated_n', count(*) filter (where j.disagree and j.human_pol is not null),
    'human_sided_jev', count(*) filter (where j.disagree and j.human_pol = (j.jev_p >= 0.5)),
    'human_sided_provisional', count(*) filter (where j.disagree and j.human_pol = j.is_politics),
    'human_n', count(*) filter (where j.human_pol is not null),
    'provisional_vs_human_agree', count(*) filter (where j.human_pol = j.is_politics),
    'jev_vs_human_n', count(*) filter (where j.human_pol is not null and j.jev_p is not null),
    'jev_vs_human_agree', count(*) filter (where j.human_pol is not null and j.jev_p is not null and (j.jev_p >= 0.5) = j.human_pol)
  ) from j;
$fn$;

comment on function public.jev_gold_provisional_scorecard() is
  'A second, entirely separate karne (migration 076) scoped to the 360 '
  'Opus provisional labels: how many have a Jev answer (live prediction '
  'preferred over the 2026-09-20 rig''s reference), how many disagree at '
  '0.5, how many of those disagreements a human has since adjudicated '
  '(via the ordinary jev_gold_labels write path) and which side -- Jev or '
  'the provisional label -- the human agreed with. NEVER merged into '
  'public.jev_gold_scorecard(), which this migration does not redefine.';

revoke all on function public.jev_gold_import_provisional(jsonb, text, text) from anon, authenticated, public;
revoke all on function public.jev_gold_next_prioritized(smallint) from anon, authenticated, public;
revoke all on function public.jev_gold_provisional_scorecard() from anon, authenticated, public;
grant execute on function public.jev_gold_import_provisional(jsonb, text, text) to service_role;
grant execute on function public.jev_gold_next_prioritized(smallint) to service_role;
grant execute on function public.jev_gold_provisional_scorecard() to service_role;

insert into supabase_migrations.schema_migrations (version, name)
  values ('076', '076_jev_gold_provisional') on conflict do nothing;
commit;
