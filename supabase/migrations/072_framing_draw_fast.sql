-- 072_framing_draw_fast.sql
--
-- Fix the Çerçeve draw timeout, which is why framing_votes has 0 rows.
--
-- 068's framing_next_headline started from `articles` (48 h window) and
-- checked each row with EXISTS against jev_shadow_predictions for
-- task = 'politics' AND jev_prob >= 0.7. No (article_id, task) index
-- exists, so the planner answered the EXISTS with a hash semi-join fed by a
-- bitmap heap scan over EVERY politics prediction ever written. Those rows
-- are wide (jev_answer jsonb), so the scan costs roughly one heap block per
-- row. In production it took 18,093 ms cold (38,541 blocks read), against
-- PostgREST's 8 s statement_timeout. GET /api/oyun/cerceve/next therefore
-- returned 500 on every call. That cost grows with the table's lifetime,
-- not with traffic.
--
-- This migration re-creates the SAME function: same name, argument,
-- `returns table (article_id uuid, title text)`, STABLE, SECURITY DEFINER,
-- search_path = '', and the same grants. It now drives the draw from
-- jev_shadow_predictions through the existing
-- jev_shadow_predictions_task_created_idx (task, created_at desc). The
-- candidate set is bounded by the recent window, never by the table's age.
-- The route (src/app/api/oyun/cerceve/next/route.ts) is unchanged.
--
-- Eligibility semantics are unchanged. The 48 h `articles.published_at`
-- filter, the active non-wire outlet filter, the not-voted-by-this-session
-- anti-join, the newest-300 pool and the "<5 votes first, random within
-- the band" order are copied verbatim from 068. The predictions window is
-- only an index-driven PRE-filter, and it is a superset of 068's set for
-- this reason: a prediction is written after its article is ingested, so
-- created_at >= published_at, and every article published in the last 48 h
-- has its politics prediction inside the window. The window is 54 h, not
-- 48 h: some outlets stamp published_at up to ~3 h in the future (a
-- UTC/+03 skew; 33 such rows measured, max +2h53m). For those articles
-- created_at can precede published_at, and 6 h of margin covers twice the
-- observed skew.
--
-- Measured against production on 2026-09-28 (read-only, pure-SELECT copies
-- of both bodies):
--   068 body: 2,634 eligible headlines, 18,093 ms cold (prior measurement)
--   072 body: 2,634 eligible headlines (set difference 0 both ways);
--             243 ms mostly warm, 2,077 ms fully cold (8.2k heap blocks)
--
-- The CTE is MATERIALIZED on purpose. Inlined, the planner is free to turn
-- it back into the 068 shape, a semi-join probed per article. Materialized,
-- the bounded index range scan runs exactly once.
--
-- Additive only: no table, column, index, policy, trigger or cron job is
-- touched; one function body is replaced in place. Safe to re-apply
-- (`create or replace function`, ledger insert `on conflict do nothing`).
-- No PII change: the function still only ever receives a session hash.

begin;

create or replace function public.framing_next_headline(p_session_hash text)
returns table (
  article_id uuid,
  title text
)
language sql
stable
security definer
set search_path = ''
as $fn$
  with recent_politics as materialized (
    -- Index range scan on (task, created_at desc). DISTINCT keeps the 068
    -- EXISTS semantics (one candidate per article) even if a future writer
    -- ever stores more than one politics row per article.
    select distinct p.article_id as candidate_id
    from public.jev_shadow_predictions p
    where p.task = 'politics'
      and p.created_at >= now() - interval '54 hours'
      and p.jev_prob >= 0.7
      and p.article_id is not null
  ),
  eligible as (
    select
      a.id    as candidate_id,
      a.title as candidate_title
    from recent_politics rp
    join public.articles a on a.id = rp.candidate_id
    join public.sources s on s.id = a.source_id
    where a.published_at >= now() - interval '48 hours'
      and s.active
      -- Normalised the same way src/lib/sources/kind.ts's sourceKindOf does:
      -- a null kind means "outlet", never "wire".
      and coalesce(s.kind, 'outlet') <> 'wire'
      and not exists (select 1 from public.framing_votes v where v.article_id = a.id and v.session_hash = p_session_hash)
    order by a.published_at desc
    limit 300
  ),
  tallied as (
    select
      e.candidate_id,
      e.candidate_title,
      count(v.id) as vote_count
    from eligible e
    left join public.framing_votes v on v.article_id = e.candidate_id
    group by e.candidate_id, e.candidate_title
  )
  select
    t.candidate_id,
    t.candidate_title
  from tallied t
  -- false sorts before true: everything under 5 votes comes first, random
  -- within that band, so coverage spreads instead of concentrating.
  order by (t.vote_count >= 5) asc, random()
  limit 1;
$fn$;

comment on function public.framing_next_headline(text) is
  'One eligible headline for /oyun''s Çerçeve mode (migration 068, rewritten '
  'for speed in 072): published in the last 48h, active non-wire outlet, '
  'carrying a task=''politics'' shadow prediction >= 0.7, not already voted '
  'on by this session, preferring headlines with fewer than 5 votes, random '
  'within that band. Returns zero rows when nothing qualifies. 072 drives '
  'the draw from jev_shadow_predictions (task, created_at desc) over a 54h '
  'window (48h + 6h published_at skew margin) instead of probing every '
  'politics prediction per article, which timed out at 18s. The caller MUST '
  'still apply src/lib/game/pii-filter.ts''s isGameEligibleTitle -- this '
  'function cannot, and a private individual''s name reaching the game is a '
  'KVKK problem, not a cosmetic one.';

-- `create or replace` keeps the existing ACL, but re-assert 068's grants so
-- this file is correct on its own.
revoke all on function public.framing_next_headline(text) from anon, authenticated, public;
grant execute on function public.framing_next_headline(text) to service_role;

insert into supabase_migrations.schema_migrations (version, name)
  values ('072', '072_framing_draw_fast')
  on conflict do nothing;

commit;
