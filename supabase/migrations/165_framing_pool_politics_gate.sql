-- 165_framing_pool_politics_gate.sql
--
-- The Çerçeve candidate pool admits political headlines from outlets that are not English only, as the daily
-- set already does. One function replaced, with the same signature: public.framing_candidate_pool_refresh().
-- Its body is production's (130's, which is 105's plus the upsert guard) with three conditions added to the
-- `fresh` WHERE. No table, column, index, trigger, cron job or data change by this file: the next scheduled
-- refresh (every 5 min, cron job framing-candidate-pool-refresh) removes the rows that no longer qualify through
-- the `gone` delete that is already in the body (h48-stories-1 PART A, hunt 48, 2026-11-06).
--
-- WHY (evidence: production, read-only, 2026-11-06 ~10:05Z)
--   * 105's `fresh` CTE filters only jev_prob >= 0.7 (task politics), a 48 h window, s.active and
--     coalesce(s.kind, 'outlet') <> 'wire'. The route doc (src/app/api/oyun/cerceve/next/route.ts) promises "one
--     political headline at a time", and src/lib/game/daily-set.ts gates exactly three more things with
--     isPoliticsMember, kind === 'outlet' and ENGLISH_SOURCE_SLUGS. The pool had none of them.
--   * The pool held 5,809 rows (the full 48 h set). 3,220 of them would be dropped by the new conditions and
--     2,589 stay (55.4 % dropped):
--       politics gate  2,331 rows not isPoliticsMember: dunya 986, genel 772, ekonomi 321, yasam 196,
--                      teknoloji 50, spor 6 (no pool row has politics_admitted_at set outside politika /
--                      son_dakika today: the admission path is inert, so the OR branch drops nothing yet);
--       outlet only    1,435 rows from non-outlet sources: aggregator 1,046, niche 389 (wire was already out);
--       English        197 rows: a-news 74, trt-world 47, daily-sabah 46, hurriyet-daily-news 29, mfa-turkey 1.
--     Only-this-gate counts: politics only 1,589, outlet only 866, English only 22.
--   * The new `fresh` evaluated inline on the live tables: 2,578 rows, none of them missing from the pool;
--     the unchanged `fresh` gives 5,786 (23 pool rows are about to age out of the 48 h window).
--   * framing_votes has 0 rows, so no vote tally is affected.
--
-- WHAT CHANGES (the three conditions, all in the WHERE of `fresh`)
--   1. `and coalesce(s.kind, 'outlet') = 'outlet'`, replacing `<> 'wire'`. A null kind is still an outlet
--      (src/lib/sources/kind.ts sourceKindOf); wire, niche and aggregator are out.
--   2. `and (a.category in ('politika', 'son_dakika') or a.politics_admitted_at is not null)`: isPoliticsMember
--      (supabase/functions/_shared/cluster/politics-admission.ts). The category literal is POLITICS_CATEGORIES.
--      The parentheses are load-bearing: a bare OR would make every admitted article bypass every other condition.
--   3. `and s.slug not in ('a-news', 'daily-sabah', 'hurriyet-daily-news', 'mfa-turkey', 'trt-world',
--      'turkiye-today')`: ENGLISH_SOURCE_SLUGS (src/lib/sources/source-language.ts). That set has SIX slugs:
--      h43-sources-2 added mfa-turkey to the five of h17-a11y-2, so the literal carries six. (mfa-turkey is kind
--      niche, so gate 1 drops it as well; it stays in the list so that the literal equals the set.) sources.slug
--      is NOT NULL in production, so NOT IN cannot swallow a row through a null.
--   Everything else is production's text: the signature, language plpgsql, SECURITY DEFINER, set search_path = '',
--   the transaction advisory lock, the statement-stable v_now, recent_politics, the `gone` delete CTE and the
--   upsert with 130's guard. tests/migrations/165-framing-pool-politics-gate.test.ts derives the expected body
--   from 130's text (taking the three conditions out again must give 130's body), derives 130's from 105's, pins
--   the category and slug literals to the TypeScript constants, and recomputes the md5 below.
--   EXECUTE: 105's revoke and grant, statement for statement (revoked from anon, authenticated and public;
--   granted to service_role only). Both are no-ops on production, where the ACL already is the one below.
--
-- PRODUCTION FINGERPRINT THE REPLACE WAS BASED ON (read-only, 2026-11-06, pg_get_functiondef + pg_proc)
--   public.framing_candidate_pool_refresh(): LANGUAGE plpgsql, VOLATILE, SECURITY DEFINER, proconfig
--   {search_path=""}, returns integer, owner postgres, the only overload.
--   md5(prosrc) = 9d57360d0dc610c8c2d3c1d97ca6fc75 (length 2093), which is the md5 of the text between the $fn$
--   markers of 130 section 4, the latest migration that defines it (the test recomputes it). The production
--   definition printed by pg_get_functiondef equals that text.
--   proacl = {postgres=X/postgres,service_role=X/postgres}
--   new md5(prosrc): eca2c0c86cd141e01a6f4b141fa8b977 (length 3022)
--
-- NOT TOUCHED: the pool table, framing_next_headline (the draw), the cron job, the PII filter (src/lib/game/
-- pii-filter.ts is a separate, founder-owned list), the daily set (it gates the same three things in TypeScript).
--
-- AFTER DEPLOY plus one refresh (5 min): the pool holds 0 rows whose article is neither politika / son_dakika nor
-- politics_admitted_at, 0 rows from a non-outlet source and 0 from an English slug; about 2.6k rows remain.
-- If the pool is empty the draw returns zero rows and the route answers {article_id: null}, the game's existing
-- empty-pool state.
--
-- LEDGER: this file records version 165 in supabase_migrations.schema_migrations itself, idempotently (the 095
-- pattern: insert ... on conflict do nothing, last statement before commit), so applying it by posting the
-- SQL (management API or psql) leaves `supabase migration list` correct; `supabase db push` records the same
-- row. Re-applying is harmless (create or replace, and the ledger insert does nothing the second time).
--
-- ROLLBACK (nothing depends on 165; one transaction): re-run ONLY 130 section 4's
-- "create or replace function public.framing_candidate_pool_refresh()" statement (the original body, md5
-- 9d57360d0dc610c8c2d3c1d97ca6fc75); its revoke and grant are unchanged. The next refresh refills the pool.
-- Then delete the ledger row 165.

begin;

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
      -- 165: outlets only. Wire was already out; niche and aggregator sources
      -- are out as well, as in the daily set (daily-set.ts: kind === 'outlet').
      and coalesce(s.kind, 'outlet') = 'outlet'
      -- 165: political headlines only, the same test as isPoliticsMember
      -- (supabase/functions/_shared/cluster/politics-admission.ts): the
      -- article's own category is one of POLITICS_CATEGORIES, or the
      -- admission path stamped politics_admitted_at. The parentheses matter:
      -- without them the OR would swallow the other conditions.
      and (a.category in ('politika', 'son_dakika') or a.politics_admitted_at is not null)
      -- 165: no English-language outlet, the same list as ENGLISH_SOURCE_SLUGS
      -- (src/lib/sources/source-language.ts). A tests/migrations check keeps
      -- this literal and that set equal.
      and s.slug not in ('a-news', 'daily-sabah', 'hurriyet-daily-news', 'mfa-turkey', 'trt-world', 'turkiye-today')
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
    refreshed_at = excluded.refreshed_at
  -- Rewrite a row only when something it stores changed. Without this every
  -- tick rewrote all ~5.3k rows just to move refreshed_at.
  where (framing_candidate_pool.title, framing_candidate_pool.published_at) is distinct from (excluded.title, excluded.published_at);

  return (select count(*)::int from public.framing_candidate_pool);
end
$fn$;

comment on function public.framing_candidate_pool_refresh() is
  'Recomputes public.framing_candidate_pool (migration 105, upsert guard in 130, '
  'politics / outlet / English gates in 165): 072''s eligibility (politics '
  'prediction >= 0.7 inside a 54h window, published in the last 48h, active) '
  'restricted to political headlines (category politika or son_dakika, or '
  'politics_admitted_at set) from outlet sources (not wire, niche or '
  'aggregator) that are not English-language outlets, without the per-session '
  'anti-join or the newest-300 cut. Deletes rows that are no longer eligible, '
  'upserts the rest (rewriting only rows whose title or published_at changed), '
  'and returns the pool size (0 if another run holds the advisory lock). '
  'service_role only; scheduled every 5 min as framing-candidate-pool-refresh.';

-- 105's grants for this function, unchanged (130 re-asserted them the same way).
revoke all on function public.framing_candidate_pool_refresh() from anon, authenticated, public;
grant execute on function public.framing_candidate_pool_refresh() to service_role;

insert into supabase_migrations.schema_migrations (version, name)
  values ('165', '165_framing_pool_politics_gate')
  on conflict do nothing;

commit;
