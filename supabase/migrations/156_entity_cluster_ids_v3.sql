-- 156_entity_cluster_ids_v3.sql
--
-- Entity hubs match on the first line of the summary only (h34-reader-5, hunt 34, 2026-11-05). One function
-- re-created (public.entity_cluster_ids_v2(text[], text[], timestamptz, integer)); its body is 125's byte for
-- byte except for one term: the summary now contributes the text before its first newline,
-- pg_catalog.split_part(coalesce(c.summary_tr, ''), E'\n', 1), instead of the whole summary_tr. No table,
-- column, index, trigger or data change, no backfill, no UPDATE. tests/migrations/156-entity-cluster-ids-v3.test.ts
-- pins all of it, including "the body is 125's with that single substitution".
--
-- WHY
--   125 runs the entity regex over title_tr || title_tr_neutral || summary_tr. summary_tr is the seed article's
--   description verbatim, and Milliyet and Posta paste OTHER stories' headlines under it, one per line, with no
--   "Son dakika" marker. d91ab2f1-a095-4213-b228-ae5391f7272c (Cumhurbaşkanı Erdoğan Güney Kore'deki temaslarının
--   ardından yurda döndü) stores two real sentences and then
--     "Ankara'da kritik güvenlik zirvesi! Bakan Çiftçi, İtalyan mevkidaşı ile bir araya geldi"
--     "Dünyanın gözü ABD'den gelen sonuçlarda! İşte ABD'deki seçim hezimetinin nedeni! Trump..."
--   and its only "Trump" is in that last line, so /gundem/trump listed it (card 4 of 20 when found, rank 14 in the
--   replay below). summary_tr keeps storing the raw description (cluster-consumer summaryFallback), so
--   the teaser strip in the app (description-clean.ts stripTrailingTeasers, used by the consumer's clustering
--   text and by summary-tidy.ts for display) does not reach the hub regex; this migration is what keeps teasers
--   out of hub membership, for stored and new rows alike, without rewriting any of them.
--
-- THE RULE
--   A hub regex sees the title, the neutral title and the FIRST LINE of the summary. split_part(x, E'\n', 1) is x
--   itself when it has no newline, '' for an empty or null summary (coalesce) and for a summary that starts with a
--   newline. A name in a title always matches, whatever the summary looks like. The prefilter (the stemmed
--   tsquery on search_tsv), the 083 partial-index predicate (not is_archived, article_count >= 2, merged_into is
--   null), the 14/30-day window on updated_at, the order (first_published desc, id), the 1..50 limit clamp and the
--   total are 125's. Only the regex text changes, so the function can only REMOVE rows the old text matched or ADD
--   rows an exclude-lookahead of aym/tcmb/meclis used to veto through a later summary line.
--
-- STEP 0 -- the body this migration starts from (production, read-only, 2026-11-05)
--   select md5(prosrc), prosecdef, provolatile, proconfig, proacl::text, obj_description(oid, 'pg_proc')
--     from pg_proc where oid = 'public.entity_cluster_ids_v2(text[], text[], timestamptz, integer)'::regprocedure;
--   -> md5 ae077ee865f8fb2058593fe6df41ccfb (851 characters), prosecdef t, provolatile s, proconfig {search_path=""},
--      proacl {postgres=X/postgres,service_role=X/postgres}, comment = 125's text.
--   md5 of the text between the $fn$ markers of 125_entity_cluster_ids_v2.sql: ae077ee865f8fb2058593fe6df41ccfb.
--   They are equal: production still runs 125's body (no later migration redefines the function), so this file is
--   built on the current body. If a later release changes prosrc, compare again before applying.
--
-- REPLAY (production, read-only, 2026-11-05 ~04:30Z; the 14-day window did not time out)
--   For each of the 62 hub keys of src/lib/trends/rising-entities.ts, with the exact p_queries and p_patterns
--   the app builds (entityHubQueries / entityHubPatterns), ONE select per key over the live clusters the
--   prefilter returns (the 125 window of 14 days): the folded text of 125 against the folded text of this file,
--   side by side, plus the real entity_cluster_ids_v2(..., null, 50) call as a check. For all 62 keys the
--   function's `total` equals the inline old count and its 50 ids are all in the inline old set, so the inline old
--   predicate is the function. Counts are the full 14-day match sets, not the top 20.
--     keys with no change (40): chp hdp iyi-parti yrp deva aym yargitay danistay ysk tcmb tuik bddk spk msb tsk
--       diyanet meb rtuk mit imamoglu kilicdaroglu mansur-yavas simsek yerlikaya babacan davutoglu aksener demirtas
--       ocalan putin gazze pkk nato yunanistan almanya cin enflasyon faiz dolar borsa
--     key            old -> new   removed   added
--     erdogan        410 -> 403      7        0
--     abd            392 -> 386      6        0
--     akp            309 -> 307      2        0
--     trump          185 -> 181      4        0
--     disisleri      187 -> 185      2        0
--     meclis         244 -> 242      2        0
--     mhp            103 -> 101      2        0
--     afad            24 ->  20      4        0
--     rusya           72 ->  70      2        0
--     iran           155 -> 152      3        0
--     ozgur-ozel     114 -> 113      1        0
--     bahceli         76 ->  75      1        0
--     fidan           54 ->  53      1        0
--     netanyahu      111 -> 110      1        0
--     israil         215 -> 214      1        0
--     ukrayna         60 ->  59      1        0
--     dem             48 ->  47      1        0
--     zelenski        19 ->  18      1        0
--     suriye          22 ->  21      1        0
--     asgari-ucret    13 ->  12      1        0
--     feto             5 ->   4      1        0
--     hamas            1 ->   0      1        0
--   46 (key, cluster) removals over 22 keys and 35 distinct clusters, 0 additions anywhere. No removed cluster has
--   a title (title_tr or title_tr_neutral) that matches the hub's own patterns, and none names the entity when read
--   by hand: the entity was in a later summary line only. 11 of the 46 are pasted headlines or tickers (d91ab2f1
--   under trump and abd, ab24d85a under abd and iran, 4c8e7533 under erdogan, zelenski and rusya, 0b9102f8 under
--   erdogan, 9e83921e under mhp, 1e6da42b under feto, 4ca344b8 under trump); the other 35 name the entity in a
--   real later sentence of the story or of its excerpt (AFAD in "ekipleri sevk edildi", a party in a body
--   paragraph), which is the price of a first-line rule. d91ab2f1 leaves /gundem/trump (14th of 185) and
--   /gundem/abd and keeps /gundem/erdogan (title) and /gundem/akp (the real first sentence names AK Parti).
--
-- DEPLOY
--   Apply order is free and the app needs no deploy for this file. The other half of the fix, stripTrailingTeasers in
--   supabase/functions/_shared/cluster/description-clean.ts, reaches the clustering fingerprint and entities only after
--   `npx supabase functions deploy cluster-consumer --no-verify-jwt` (cluster-consumer is the only function that imports
--   description-clean; ingest has its own cleaner in _shared/rss/normalize.ts and needs no redeploy).
--
-- ROLLBACK (the app does not care which of the two bodies is live)
--   Re-run the `create or replace function public.entity_cluster_ids_v2` statement of 125_entity_cluster_ids_v2.sql
--   (the bare summary_tr term), then
--   delete from supabase_migrations.schema_migrations where version='156';
--
-- Access is 125's: SECURITY DEFINER, empty search_path (every relation and function schema-qualified), execute
-- revoked from public, anon and authenticated and granted to service_role only. No table grant. The statements
-- below repeat the comment, the revoke and the grant of 125 so the file stands on its own.

begin;

set local lock_timeout = '5s';

create or replace function public.entity_cluster_ids_v2(
  p_queries text[],
  p_patterns text[],
  p_since timestamptz default null,
  p_limit integer default 20
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
    and pg_catalog.lower(pg_catalog.translate(coalesce(c.title_tr, '') || ' ' || coalesce(c.title_tr_neutral, '') || ' ' || pg_catalog.split_part(coalesce(c.summary_tr, ''), E'\n', 1), 'İIıŞşĞğÜüÖöÇçÂâÎîÛû', 'iiissgguuooccaaiiuu')) ~ any (pg_catalog.array_remove(p_patterns[1:12], ''))
    and not c.is_archived      -- literal copy of the 083 partial-index predicate
    and c.article_count >= 2
    and c.merged_into is null
    and c.updated_at >= greatest(coalesce(p_since, pg_catalog.now() - interval '14 days'), pg_catalog.now() - interval '30 days')
  order by c.first_published desc, c.id
  limit greatest(1, least(coalesce(p_limit, 20), 50));
$fn$;

comment on function public.entity_cluster_ids_v2(text[], text[], timestamptz, integer) is
  'Precise newest-first cluster ids for a curated entity (migration 125, roadmap G2). '
  'Caller: src/lib/entities/entity-hub-query.ts for /gundem/[key], which builds '
  'p_queries (Turkish lexeme spellings of every curated form, a stemmed websearch '
  'tsquery on search_tsv, the recall prefilter) and p_patterns (PostgreSQL '
  'word-boundary regexes run on the folded title, neutral title and summary, the '
  'precision guard) from rising-entities.ts and never passes p_since. Both are '
  'ANDed; only the first 12 elements of each are used; empty or null p_patterns '
  'return zero rows by construction. Windowed on clusters.updated_at (default 14 '
  'days, never wider than 30), ordered by first_published desc then id, excluding '
  'archived and merged-away clusters. Returns (id, total): total is the full match '
  'count before the LIMIT (p_limit clamped to 1..50, default 20). Migration 123 '
  'entity_cluster_ids stays as the fallback while 125 is unapplied. '
  'Migration 156 (h34-reader-5): the summary contributes only the text before its '
  'first newline (split_part), so a related-news headline pasted under the article '
  'does not list it under an entity it does not name. '
  'service_role only.';

revoke all on function public.entity_cluster_ids_v2(text[], text[], timestamptz, integer) from public, anon, authenticated;
grant execute on function public.entity_cluster_ids_v2(text[], text[], timestamptz, integer) to service_role;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('156', '156_entity_cluster_ids_v3')
  on conflict do nothing;

commit;
