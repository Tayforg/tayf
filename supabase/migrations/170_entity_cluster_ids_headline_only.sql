-- 170_entity_cluster_ids_headline_only.sql
--
-- /gundem/akp lists clusters that name the party only as an epithet in the summary lead (h56-entities-2, hunt 56,
-- 2026-11-06). One function CREATED, public.entity_cluster_ids_v3(text[], text[], timestamptz, integer, boolean): its body
-- is 156's entity_cluster_ids_v2 body (production's, md5 pinned below) with ONE changed expression. The text the hub regex
-- runs on is now a CASE on the new argument p_headline_only: the title and the neutral title alone (title_tr and
-- title_tr_neutral) when it is true, 156's exact expression (those two plus the first line of the summary) otherwise. The
-- argument defaults to false, so a four-argument call and a NULL flag behave like v2. entity_cluster_ids_v2 is not touched,
-- dropped or replaced: it stays the app's fallback while 170 is unapplied. No table, column, index, trigger or data change,
-- no backfill, no UPDATE. tests/migrations/170-entity-cluster-ids-headline-only.test.ts pins all of it, including "the body
-- is 156's with that single substitution".
--
-- WHY
--   156 made the hub regex see the title, the neutral title and the FIRST LINE of the summary. For most hubs that lead is
--   evidence: the summary is the seed article's description, and a lead that says "CHP lideri Özel" or "MHP lideri Bahçeli"
--   is about the party. For akp it is mostly an epithet. Read-only replay, 14-day window, live clusters, with the app's exact
--   p_queries and p_patterns for akp (2026-11-06 ~21:27Z): 308 candidates by the prefilter, 303 match the lead mode (v2), 174
--   name the party in a headline (title_tr or title_tr_neutral), 129 only in the lead. A hand label of 30 random lead-only
--   rows: 3 are clearly about the party (Yayman: "Cumhurbaşkanımızı bir kez daha Başkan yapacağız", Bülent Turan on AK Parti's
--   internal debate, an ANK-AR poll), 10 are borderline (the party is a participant: a vote on the Mekke Anlaşması, a
--   pension plan "AK Parti" is drafting, the Fatma Betül Sayan Kaya fon case) and 17 are not (a former MP's epithet: the Ertan Aydın fon stories; "AK Parti Samsun
--   Milletvekili Mehmet Muş başkanlığında" in the Plan ve Bütçe Komisyonu; a minister at an AK Parti ilçe başkanlığı; an
--   accident with a "vali ve AK Parti milletvekili"). Visible page-1 cards of the old list that are not about the party:
--   0f16f0f5 (Bakan Bayraktar, Milli Enerji 2040), 8bc853c6 (Adalet Bakanı Gürlek in Mardin), cef0db8b (Ağrı Adalet
--   İlkokulu açılışı), fffc451b (Kültür ve Turizm Bakanlığı 2027 bütçesi) and 7c57724b (Emine Erdoğan). The hub's bias bar
--   is summed over these, so each one weighs on the bar. This is not h34-reader-5, which was the teaser lines after the
--   first newline and is fixed by 156: these epithets are in the lead sentence itself.
--
-- THE RULE
--   With p_headline_only = true the hub regex sees title_tr || ' ' || title_tr_neutral, folded exactly like migration 112
--   (lower(translate(...)) with the same two literals as 156). The prefilter (the stemmed tsquery on search_tsv), the 083
--   partial-index predicate (not is_archived, article_count >= 2, merged_into is null), the 14/30-day window on updated_at,
--   the order (first_published desc, id), the 1..50 limit clamp and the total are 156's. For akp's patterns (plain
--   word-boundary regexes, no whole-text lookahead) the headline text is a prefix of the lead text, so the headline matches
--   are a subset of the lead matches and `total` can only fall. The 1..50 page is then filled with older headline matches
--   that were below the lead mode's page. A hub whose patterns carry an excludes lookahead (erdogan, meclis, aym, tcmb)
--   could GAIN a match in headline mode when the veto cue is only in the lead, which is another reason the flag is set for
--   akp alone. A NULL flag takes the else branch.
--
-- WHY ONLY akp
--   The app (src/lib/trends/rising-entities.ts, RisingHubSpec.headlineOnly) sets the flag for akp alone. The same replay on
--   chp: 152 rows, 94 in a headline, 58 lead-only; mhp: 100, 51, 49. A hand read of 12 random lead-only rows each shows they
--   are the story of the party: chp's are the split to Yeni Parti ("chp'den ayrılarak"), the kayyum chair and Kılıçdaroğlu;
--   mhp's are "MHP lideri Devlet Bahçeli" and his statements, the party's leader being the story. The country and person hubs
--   (abd, iran, israil, erdogan, ozgur-ozel, ukrayna ...) were not touched either: a lead that names a country or a person
--   is that story's subject far more often than a party epithet is. They keep 156's lead mode.
--
-- NAME
--   156_entity_cluster_ids_v3.sql is named v3 but re-creates entity_cluster_ids_v2 (its ledger row is
--   '156_entity_cluster_ids_v3'). A search of every migration on 2026-11-06 finds no object named entity_cluster_ids_v3, and
--   production has none (STEP 0), so the name is free.
--
-- STEP 0 -- the body this migration starts from (production, read-only, 2026-11-06 ~21:10Z)
--   select proname, md5(prosrc), length(prosrc), proconfig::text, proacl::text, prosecdef, provolatile
--     from pg_proc where pronamespace = 'public'::regnamespace and proname like 'entity_cluster_ids%';
--   -> entity_cluster_ids    md5 09d046087512c7927f498b1b0175cfcc, 872 characters (123, untouched)
--   -> entity_cluster_ids_v2 md5 81be59e839f81c6e738e32a658c2a8eb, 884 characters, prosecdef t, provolatile s,
--      proconfig {search_path=""}, proacl {postgres=X/postgres,service_role=X/postgres}, arguments
--      (p_queries text[], p_patterns text[], p_since timestamptz default null, p_limit integer default 20).
--   There is no entity_cluster_ids_v3. The md5 of the text between the dollar quotes of 156_entity_cluster_ids_v3.sql is
--   81be59e839f81c6e738e32a658c2a8eb, 884 characters: it equals the md5 of 156's body, so production still runs 156's body
--   and this file is built on the current one. If a later release changes prosrc, compare again before applying.
--
-- REPLAY (production, read-only, 2026-11-06 ~21:27Z; the 14-day window did not time out)
--   akp, the app's exact p_queries (ak parti, akp, ak partili, ak partimize) and p_patterns (\mak\s+parti, \makp\M), the
--   fold of this file in both branches side by side:
--     candidates 308 | lead mode (v2) 303 | headline mode 174 | removed 129 | added 0
--   The 129 removed rows are the ones the lead named and no headline did. The newest 20 of them include 0f16f0f5, 8bc853c6,
--   7c57724b, cef0db8b, fffc451b, the Fatma Betül Sayan Kaya fon stories (a4d5f338, 433dab56, 3adf1891) and the SONAR poll
--   d77c3949 (a loss: its lead says "AK Parti", its headline does not). The new top 20 by first_published is all headline:
--   12 are the party or its leaders acting or being polled, 8 are an AK Parti officer or MP in a headline about something
--   else (a committee, COP31), 0 are an epithet-only row. EXPLAIN ANALYZE, BUFFERS as a plain SELECT, same plan for v2's
--   body and this body (BitmapAnd of idx_clusters_active_updated_at and clusters_search_tsv_idx, 454 buffers): v2 29.5 ms,
--   this body with the flag false 29.5 to 30.3 ms, with the flag true 20.2 ms (less text to fold). Planning 4.7 to 5.0 ms.
--
-- DEPLOY
--   Migration first, then the app. The app (src/lib/entities/entity-hub-query.ts) calls entity_cluster_ids_v3 with
--   p_headline_only (true for akp, false for every other hub), and on PGRST202 (function not in the schema cache, i.e. 170
--   unapplied) retries the four-argument entity_cluster_ids_v2, and on PGRST202 again falls back to 123's
--   entity_cluster_ids. So an app deployed first keeps working on v2, with the lead still counting for akp; no hub breaks.
--   The cache key of a hub read includes the flag.
--
-- VERIFY (read-only, after applying)
--   select md5(prosrc), length(prosrc) from pg_proc where oid = 'public.entity_cluster_ids_v3(text[], text[], timestamptz, integer, boolean)'::regprocedure;
--   -> bc1ea39f547ca8d6810833f12c7bd983, 1117 (this file's body; v2 stays 81be59e839f81c6e738e32a658c2a8eb, 884)
--   select has_function_privilege('anon', 'public.entity_cluster_ids_v3(text[], text[], timestamptz, integer, boolean)', 'execute'),
--          has_function_privilege('authenticated', 'public.entity_cluster_ids_v3(text[], text[], timestamptz, integer, boolean)', 'execute'),
--          has_function_privilege('service_role', 'public.entity_cluster_ids_v3(text[], text[], timestamptz, integer, boolean)', 'execute');
--   -> false, false, true
--   select max(total) from public.entity_cluster_ids_v3(array['ak parti', 'akp', 'ak partili', 'ak partimize'], array['\mak\s+parti', '\makp\M'], null, 50, true);
--   -> about 174 (the same call with false, or v2 with the first four arguments, about 303; count(*) would print 50, the limit
--   clamp); GET /gundem/akp then shows "Son 14 günde ~174 küme" and no 0f16f0f5, cef0db8b or fffc451b.
--
-- ROLLBACK (the app does not care whether v3 exists)
--   drop function public.entity_cluster_ids_v3(text[], text[], timestamptz, integer, boolean);
--   delete from supabase_migrations.schema_migrations where version = '170';
--   The app falls back to v2 on PGRST202 by itself. v2 is not part of this migration and is not touched by the rollback.
--
-- Access is 125's and 156's: SECURITY DEFINER, empty search_path (every relation and function schema-qualified), execute
-- revoked from public, anon and authenticated and granted to service_role only. No table grant. The statements below repeat
-- the comment, the revoke and the grant of 156 for the new signature so the file stands on its own.

begin;

set local lock_timeout = '5s';

create or replace function public.entity_cluster_ids_v3(
  p_queries text[],
  p_patterns text[],
  p_since timestamptz default null,
  p_limit integer default 20,
  p_headline_only boolean default false
)
returns table (id uuid, total bigint)
language sql
stable
security definer
set search_path = ''
as $fn$
  select c.id, (pg_catalog.count(*) over ())::bigint
  from public.clusters c
  where c.search_tsv @@ pg_catalog.websearch_to_tsquery('pg_catalog.turkish'::pg_catalog.regconfig, pg_catalog.array_to_string(p_queries[1:12], ' or '))
    and (case when p_headline_only
              then pg_catalog.lower(pg_catalog.translate(coalesce(c.title_tr, '') || ' ' || coalesce(c.title_tr_neutral, ''), 'İIıŞşĞğÜüÖöÇçÂâÎîÛû', 'iiissgguuooccaaiiuu'))
              else pg_catalog.lower(pg_catalog.translate(coalesce(c.title_tr, '') || ' ' || coalesce(c.title_tr_neutral, '') || ' ' || pg_catalog.split_part(coalesce(c.summary_tr, ''), E'\n', 1), 'İIıŞşĞğÜüÖöÇçÂâÎîÛû', 'iiissgguuooccaaiiuu'))
         end) ~ any (pg_catalog.array_remove(p_patterns[1:12], ''))
    and not c.is_archived      -- literal copy of the 083 partial-index predicate
    and c.article_count >= 2
    and c.merged_into is null
    and c.updated_at >= greatest(coalesce(p_since, pg_catalog.now() - interval '14 days'), pg_catalog.now() - interval '30 days')
  order by c.first_published desc, c.id
  limit greatest(1, least(coalesce(p_limit, 20), 50));
$fn$;

comment on function public.entity_cluster_ids_v3(text[], text[], timestamptz, integer, boolean) is
  'Precise newest-first cluster ids for a curated entity hub, with a per-hub headline-only switch '
  '(migration 170, h56-entities-2). Same as entity_cluster_ids_v2 (migrations 125 and 156) plus '
  'p_headline_only boolean default false: when true the regex guard in p_patterns runs on title_tr and '
  'title_tr_neutral only, so a party named only as an epithet in the summary lead does not list the '
  'cluster (set for akp alone); when false or null it runs on the title, the neutral title and the '
  'first line of the summary, exactly as v2 does. Caller: src/lib/entities/entity-hub-query.ts for '
  '/gundem/[key], which falls back to entity_cluster_ids_v2 on PGRST202. p_queries (stemmed '
  'websearch tsquery on search_tsv, the recall prefilter) and p_patterns (PostgreSQL word-boundary '
  'regexes on the folded text) are ANDed; only the first 12 elements of each are used; empty or null '
  'p_patterns return zero rows by construction. Windowed on clusters.updated_at (default 14 days, '
  'never wider than 30), ordered by first_published desc then id, excluding archived and merged-away '
  'clusters. Returns (id, total): total is the full match count before the LIMIT (p_limit clamped to '
  '1..50, default 20). service_role only.';

revoke all on function public.entity_cluster_ids_v3(text[], text[], timestamptz, integer, boolean) from public, anon, authenticated;
grant execute on function public.entity_cluster_ids_v3(text[], text[], timestamptz, integer, boolean) to service_role;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name) values ('170', '170_entity_cluster_ids_headline_only') on conflict do nothing;

commit;
