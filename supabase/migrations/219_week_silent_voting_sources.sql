-- 219_week_silent_voting_sources.sql
--
-- /hafta/<week> prints zone shares (Iktidar %45 -> %52 from one week to the next) with no note that the feed set changed
-- (h207-weekly-1, hunt 207, 2026-11-22). One function CREATED, public.week_silent_voting_sources(p_from timestamptz, p_to timestamptz,
-- p_min integer default 100) returns table(slug, name, bias): the active voting sources (kind outlet or wire, the two kinds of
-- isVotingKind, src/lib/sources/kind.ts) that published NO article in [p_from, p_to) although they published at least p_min articles in
-- the 28 days around it. The archive page of a CLOSED week names them and says its zone shares are not one-to-one comparable with the
-- weeks around it (src/lib/weekly/week-archive.ts getWeekSilentVotingSources, src/lib/weekly/week-copy.ts silentSourcesCaveat), in the
-- wording /trends already uses for the same effect (h90-trends-2). Read-only (language sql, stable, security invoker): no table, column,
-- index, trigger, cron job or data change, no backfill, no UPDATE. The counts and the zone shares on the page are not changed: copy only.
-- tests/migrations/219-week-silent-voting-sources.test.ts pins all of it.
--
-- WHY (production, read-only, 2026-11-22): GET /hafta/2026-W46 printed "Iktidar 3.264 kaynak kaydi %52 ... Bagimsiz 1.345 %21 ...
-- Muhalefet 1.700 %27" and nothing about the feed set. Five voting outlets have delivered nothing since 15-25 Oct: gazete-pencere (last
-- article 2026-10-15), halk-tv (10-16), benguturk (10-23), arti-gercek (10-23) and medya-gazete (10-25); in ISO W42 they had 394, 323, 859,
-- 324 and 145 articles, in W46 none. The feed set churns elsewhere too (gercek-gundem and internet-haber went dark on 22-23 Sep; posta,
-- milliyet, muhalif and about ten others started on 26-28 Sep; en-son-haber (first article 2026-04-06) went dark after 2026-07-15 and resumed on 2026-11-19), so a week-over-week share move on the
-- archive's Onceki/Sonraki navigation mixes feed changes with editorial ones. /trends discloses its own dark sources through
-- darkVotingSourcesInWindow (the feed-status classifier of the LIVE window); a closed week has no live feed status, and the only record
-- of "this source delivered nothing that week" is the articles table itself, which is what this function reads.
--
-- THE RULE
--   A source is listed when ALL of these hold: it is active; its kind is outlet or wire (the voting kinds: an aggregator or a niche
--   source never moves the zone shares); it has no article with published_at in [p_from, p_to); and it has at least p_min articles with
--   published_at in [p_from - 28 days, least(p_to + 28 days, now())). The upper edge is capped at now() because the future holds no
--   articles: for a week less than 28 days old the look-ahead is whatever has been delivered so far. The default p_min is 100 (a source
--   with 100 articles in the 63 days around a week is a regular deliverer: the smallest of the five outlets above, medya-gazete, had 145
--   articles in W42 alone).
--   Both probes are index-only reads on idx_articles_source_published (source_id, published_at desc; 137), and the materiality probe is
--   bounded: `limit p_min` stops the scan at p_min index entries, so a source with 50,000 articles costs the same as one with 100. The
--   silent probe is an existence check, one entry. Every relation is schema-qualified; the function is SECURITY INVOKER with an empty
--   search_path (the reader is service_role, which has table access), so it grants nothing it did not already have.
--
-- STEP 0 (production, read-only, 2026-11-22): there is no week_silent_voting_sources in pg_proc yet; sources.bias is text, sources.kind is
--   text (outlet 92 active, wire 4 active, aggregator 7, niche 15), articles.source_id and articles.published_at are indexed by
--   idx_articles_source_published and its covering twin idx_articles_source_published_inc_id (106).
--
-- REPLAY (production, read-only, 2026-11-22 about 12:47 UTC; this body inline as a plain SELECT with the week's bounds, Istanbul Monday
-- 00:00 to the next Monday 00:00 as UTC instants, p_min 100; the lists are slugs). The lists can shift: the look-ahead edge is capped at
-- now(), so a week less than 28 days old keeps growing its window until the cap stops binding (W46 ends 2026-11-15 and its window ends at
-- now() until 2026-12-13), and a source that resumes or is deactivated leaves the list.
--   W39 (9): dikgazete, milli-gazete, milliyet, muhalif, ntv, posta, sputnik-turkce, yeni-akit, yeni-mesaj
--   W41 (2): gercek-gundem, internet-haber
--   W42 (2): gercek-gundem, internet-haber
--   W43 (5): en-son-haber, gazete-pencere, gercek-gundem, halk-tv, internet-haber
--   W46 (6): arti-gercek, benguturk, en-son-haber, gazete-pencere, halk-tv, medya-gazete
--   The five dark outlets of the finding are all on W46 (en-son-haber is the sixth: it has been dark since 2026-07-15 and resumed on 2026-11-19, so it delivered nothing in
--   W46 and 100 or more since; the same resumption alone puts it on W43 to W45 through the +28-day look-ahead (0 articles in W43's
--   look-back)). The idea file (ideas/h207-weekly-1.json) expected 14 for W39 and 4 for W43 (without gercek-gundem); the
--   rule as written returns 9 and 5. gercek-gundem has 125 articles from 2026-09-20 21:00Z to its last one on 09-22 18:14Z, inside W43's
--   look-back (it starts 2026-09-20 21:00Z), and widening or narrowing the filter does not give 14 for W39 (without the kind filter 10,
--   bloomberg-ht being a niche source). The function body is the idea file's, unchanged.
--   A source that STARTED after the week (posta, milliyet, muhalif on W39) is listed too: it delivered nothing that week and delivered
--   regularly right after it, which is the same "the feed set differs from the weeks around it" fact the sentence states.
--
-- COST (EXPLAIN ANALYZE of the inline body for W46, custom plan, production, 2026-11-22): Execution Time: 98.7 ms, Planning Time: 2.5 ms
-- (buffers: shared hit 4650, read 112). Both probes are Index Only Scan using idx_articles_source_published (96 materiality probes,
-- about 80 entries each, one existence probe per source that passed it, 75). EXPLAIN (GENERIC_PLAN) with $1 to $3 for the arguments, the
-- plan a non-inlined call is planned with, is the same shape on idx_articles_source_published_inc_id (the covering twin, 106). Under the
-- 500 ms budget, and answered once per closed week per cache lifetime (hours), at most one entry per week key.
--
-- DEPLOY
--   Apply 219 first, then deploy the app (docs/migration-guide.md: an RPC the app calls is applied before the deploy). The reverse order is
--   safe: until 219 is applied PostgREST answers PGRST202 for week_silent_voting_sources, src/lib/weekly/week-archive.ts treats that as
--   "unknown" (null, not logged), the page prints no extra sentence and no error, and that state is cached for minutes only, so the
--   sentence appears within minutes of applying 219.
--
-- VERIFY (read-only, after applying)
--   select md5(prosrc), length(prosrc) from pg_proc where oid = 'public.week_silent_voting_sources(timestamptz, timestamptz, integer)'::regprocedure;
--   -> 6d3b91f8b8ea8e978656efc8ff20a288, 569 (this file's body)
--   select has_function_privilege('anon', 'public.week_silent_voting_sources(timestamptz, timestamptz, integer)', 'execute'),
--          has_function_privilege('authenticated', 'public.week_silent_voting_sources(timestamptz, timestamptz, integer)', 'execute'),
--          has_function_privilege('service_role', 'public.week_silent_voting_sources(timestamptz, timestamptz, integer)', 'execute');
--   -> false, false, true
--   select slug from public.week_silent_voting_sources('2026-11-08T21:00:00Z', '2026-11-15T21:00:00Z');
--   -> the six slugs of W46 above (the list can only have grown or shrunk by sources that resumed or started since 2026-11-22).
--   Then GET /hafta/2026-W46 contains "spektrum kaynağı hiç veri vermedi" and the names Gazete Pencere, Halk TV, Bengütürk, Artı Gerçek and
--   Medya Gazete; GET /hafta/<the current ISO week> does not contain it.
--
-- ROLLBACK (the app does not care whether week_silent_voting_sources exists)
--   drop function public.week_silent_voting_sources(timestamptz, timestamptz, integer);
--   delete from supabase_migrations.schema_migrations where version = '219';
--   notify pgrst, 'reload schema';
--   The page falls back to no sentence on PGRST202 by itself; nothing else depends on the function.
--
-- NUMBER
--   197 and 202 are reserved (held by migrations of other branches) and 218 is taken by another worker in the same tree: 219 is the next
--   free number, and the chain has deliberate gaps (no guard requires a contiguous chain).
--
-- Access: SECURITY INVOKER, empty search_path, execute revoked from public, anon and authenticated and granted to service_role only. No
-- table grant, and not one of the seven allowlisted anon RPCs (tests/guards/anon-surface.test.ts).

begin;

set local lock_timeout = '5s';

create or replace function public.week_silent_voting_sources(
  p_from timestamptz,
  p_to timestamptz,
  p_min integer default 100
)
returns table(slug text, name text, bias text)
language sql
stable
security invoker
set search_path = ''
as $fn$
  select s.slug, s.name, s.bias
  from public.sources s
  where s.active
    and s.kind in ('outlet', 'wire')
    and not exists (
      select 1 from public.articles a
      where a.source_id = s.id and a.published_at >= p_from and a.published_at < p_to
    )
    and (
      select count(*) from (
        select 1 from public.articles a
        where a.source_id = s.id
          and a.published_at >= p_from - interval '28 days'
          and a.published_at < least(p_to + interval '28 days', now())
        limit p_min
      ) x
    ) >= p_min
  order by s.slug;
$fn$;

comment on function public.week_silent_voting_sources(timestamptz, timestamptz, integer) is
  'Active voting sources (kind outlet or wire) with no article in [p_from, p_to) that published at least p_min articles '
  'in the 28 days around it (the look-ahead ends at now()), ordered by slug '
  '(migration 219, h207-weekly-1). Caller: src/lib/weekly/week-archive.ts getWeekSilentVotingSources, for the sentence '
  'on a closed /hafta/<week> that says its zone shares are not comparable with the weeks around it; '
  'it treats PGRST202 as "unknown". service_role only.';

revoke all on function public.week_silent_voting_sources(timestamptz, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.week_silent_voting_sources(timestamptz, timestamptz, integer) to service_role;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name) values ('219', '219_week_silent_voting_sources') on conflict do nothing;

commit;
