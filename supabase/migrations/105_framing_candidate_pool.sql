-- 105_framing_candidate_pool.sql
--
-- Take the Çerçeve draw off the cold-read path: GET /api/oyun/cerceve/next
-- must answer in about 3 s, and a DB timeout must be a retryable 503, never
-- a 500 at 8.1 s.
--
-- EVIDENCE. 072 made framing_next_headline index-driven (task, created_at
-- desc), but every draw still reads jev_shadow_predictions and then the
-- articles heap. Production runs on Supabase Micro compute: 256 MB
-- shared_buffers against a 5.2 GB database, so those pages are usually not
-- cached. 072 measured 2,077 ms fully cold (8.2k heap blocks). In api-1,
-- 14 of 27 draws returned 500 at ~8.1 s, i.e. PostgREST's 8 s
-- statement_timeout. The route only needs a few hundred candidate headlines;
-- the cost is finding them, not choosing among them.
--
-- DESIGN. The cold scan moves to a background job:
--   1. public.framing_candidate_pool(article_id, title, published_at,
--      refreshed_at) holds the FULL eligible set. It is deliberately small
--      (a few thousand rows, one narrow row each) and has no payload columns.
--   2. public.framing_candidate_pool_refresh() recomputes that set with
--      072's eligibility verbatim (politics prediction >= 0.7 inside a 54 h
--      window, article published in the last 48 h, active non-wire outlet),
--      with now() replaced by one statement-stable v_now. It deletes rows that
--      are no longer eligible and upserts the rest. pg_cron runs it every
--      5 min with a 2 min statement_timeout, so the cold scan happens there
--      and never in a request. A transaction advisory lock makes overlapping
--      runs a no-op.
--   3. public.framing_next_headline(text) keeps its name, argument, return
--      shape, STABLE/SECURITY DEFINER/search_path and grants. It reads only the
--      pool and framing_votes. The pool holds NO session anti-join and NO
--      newest-300 cut, so per-session exclusion and the newest-300 window are
--      still computed at draw time, exactly as in 072. `tallied` and the final
--      select are 072 verbatim. The route is unchanged by this file.
--
-- SEMANTIC DELTAS against 072 (the only two):
--   * Staleness. A new politics prediction, or a change to a source's
--     active/kind flag, reaches the draw within 5 min (the next refresh)
--     instead of immediately. A headline from a source deactivated or
--     re-classified as wire can be drawn for up to 5 min after the change.
--   * The 48 h window is re-checked at draw time on the pool row's
--     published_at, so a stalled refresh job can never serve a headline older
--     than 48 h; the pool simply drains and the draw returns zero rows (the
--     route answers `{article_id: null}`, the game's empty-pool state).
--   Everything else is unchanged, including the isGameEligibleTitle PII
--   filter, which still runs in the route (this SQL cannot apply it).
--
-- ACCESS. The table is owner-only: RLS enabled with no policy, every default
-- Supabase grant revoked (cf. 091/095, plus the PG17 MAINTAIN guard), nothing
-- granted back. Only the two SECURITY DEFINER functions touch it; both are
-- revoked from anon/authenticated/public and executable by service_role only.
--
-- ROLLBACK. Re-apply 072's function body (it `create or replace`s the same
-- signature and reads jev_shadow_predictions directly), then unschedule the
-- job: select cron.unschedule('framing-candidate-pool-refresh'). The table
-- and refresh function are then inert and can stay or be dropped by hand.
--
-- Additive and re-runnable: create ... if not exists, create or replace
-- function, unschedule-then-schedule, upsert-based population, ledger insert
-- `on conflict do nothing`. The final populate is bounded by 072's recent
-- window index scan (about 2.1 s cold). No PII change: the draw still only
-- ever receives a session hash.

begin;

-- 1. Table ---------------------------------------------------------------------

create table if not exists public.framing_candidate_pool (
  article_id   uuid primary key references public.articles(id) on delete cascade,
  title        text,
  published_at timestamptz not null,
  refreshed_at timestamptz not null default now()
);

create index if not exists framing_candidate_pool_published_idx
  on public.framing_candidate_pool (published_at desc);

comment on table public.framing_candidate_pool is
  'Precomputed Çerçeve candidate set (migration 105): every article that '
  'satisfies framing_next_headline''s eligibility (politics shadow prediction '
  '>= 0.7, published in the last 48h, active non-wire outlet), refreshed every '
  '5 min by framing_candidate_pool_refresh(). Owner-only; read through the '
  'SECURITY DEFINER draw function.';

alter table public.framing_candidate_pool enable row level security;

-- Supabase default privileges hand new tables to anon/authenticated (incl.
-- write grants, cf. 091/095): strip them. Nothing is granted back; only the
-- owner-run SECURITY DEFINER functions below touch this table.
revoke all on public.framing_candidate_pool from anon, authenticated, public;

-- PG17 added the MAINTAIN privilege; it does not exist before PG17 (revoking
-- it would be a syntax error), so guard.
do $maint$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on public.framing_candidate_pool from anon, authenticated';
  end if;
end
$maint$;

-- 2. Refresh function ----------------------------------------------------------

create or replace function public.framing_candidate_pool_refresh()
returns integer
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_now timestamptz;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtext('framing_candidate_pool_refresh')::bigint
  ) then
    return 0;
  end if;

  v_now := pg_catalog.now();

  with recent_politics as materialized (
    -- 072's index range scan on (task, created_at desc), with v_now for now().
    -- DISTINCT keeps one candidate per article.
    select distinct p.article_id as candidate_id
    from public.jev_shadow_predictions p
    where p.task = 'politics'
      and p.created_at >= v_now - interval '54 hours'
      and p.jev_prob >= 0.7
      and p.article_id is not null
  ),
  fresh as materialized (
    -- The FULL eligible set: no per-session anti-join and no newest-300 cut,
    -- both of which the draw still applies per request.
    select
      a.id           as article_id,
      a.title        as title,
      a.published_at as published_at
    from recent_politics rp
    join public.articles a on a.id = rp.candidate_id
    join public.sources s on s.id = a.source_id
    where a.published_at >= v_now - interval '48 hours'
      and s.active
      -- Normalised the same way src/lib/sources/kind.ts's sourceKindOf does:
      -- a null kind means "outlet", never "wire".
      and coalesce(s.kind, 'outlet') <> 'wire'
  ),
  gone as (
    delete from public.framing_candidate_pool c
    where not exists (select 1 from fresh f where f.article_id = c.article_id)
  )
  insert into public.framing_candidate_pool (article_id, title, published_at, refreshed_at)
  select f.article_id, f.title, f.published_at, v_now
  from fresh f
  on conflict (article_id) do update set
    title        = excluded.title,
    published_at = excluded.published_at,
    refreshed_at = excluded.refreshed_at;

  return (select count(*)::int from public.framing_candidate_pool);
end
$fn$;

comment on function public.framing_candidate_pool_refresh() is
  'Recomputes public.framing_candidate_pool (migration 105): 072''s eligibility '
  '(politics prediction >= 0.7 inside a 54h window, published in the last 48h, '
  'active non-wire outlet) without the per-session anti-join or the newest-300 '
  'cut. Deletes rows that are no longer eligible, upserts the rest, and returns '
  'the pool size (0 if another run holds the advisory lock). service_role only; '
  'scheduled every 5 min as framing-candidate-pool-refresh.';

revoke all on function public.framing_candidate_pool_refresh() from anon, authenticated, public;
grant execute on function public.framing_candidate_pool_refresh() to service_role;

-- 3. Draw function -------------------------------------------------------------

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
  with eligible as (
    -- A few thousand narrow rows plus framing_votes: no predictions scan, no
    -- articles heap. The 48 h re-check keeps a stalled refresh job from ever
    -- serving a stale headline; the anti-join and the newest-300 cut are 072's.
    select
      p.article_id as candidate_id,
      p.title      as candidate_title
    from public.framing_candidate_pool p
    where p.published_at >= now() - interval '48 hours'
      and not exists (select 1 from public.framing_votes v where v.article_id = p.article_id and v.session_hash = p_session_hash)
    order by p.published_at desc
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
  'for speed in 072, moved onto a precomputed pool in 105): drawn from '
  'framing_candidate_pool (published in the last 48h, active non-wire outlet, '
  'carrying a task=''politics'' shadow prediction >= 0.7, refreshed every 5 min), '
  'newest 300 not already voted on by this session, preferring headlines with '
  'fewer than 5 votes, random within that band. Returns zero rows when nothing '
  'qualifies. The caller MUST still apply src/lib/game/pii-filter.ts''s '
  'isGameEligibleTitle -- this function cannot, and a private individual''s '
  'name reaching the game is a KVKK problem, not a cosmetic one.';

-- `create or replace` keeps the existing ACL, but re-assert 068's grants so
-- this file is correct on its own.
revoke all on function public.framing_next_headline(text) from anon, authenticated, public;
grant execute on function public.framing_next_headline(text) to service_role;

-- 4. Schedule ------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron not installed — skipping framing-candidate-pool-refresh schedule (105)';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'framing-candidate-pool-refresh') then
    perform cron.unschedule('framing-candidate-pool-refresh');
  end if;
  perform cron.schedule('framing-candidate-pool-refresh', '*/5 * * * *',
    $sql$ set statement_timeout = '2min'; select public.framing_candidate_pool_refresh(); $sql$);
end $$;

-- 5. Populate once -------------------------------------------------------------
-- Bounded by 072's recent-window index scan (about 2.1 s fully cold). If the
-- cron job happens to hold the advisory lock this returns 0 and that run
-- populates the pool instead.

set local statement_timeout = '120s';
select public.framing_candidate_pool_refresh();

insert into supabase_migrations.schema_migrations (version, name)
  values ('105', '105_framing_candidate_pool')
  on conflict do nothing;

commit;
