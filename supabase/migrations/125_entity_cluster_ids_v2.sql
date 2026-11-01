-- 125_entity_cluster_ids_v2.sql
--
-- Precise entity hubs (roadmap G2, /gundem/[key]). Migration 123's
-- entity_cluster_ids lists every cluster whose STEMMED tsquery matches the
-- entity label, and the Turkish stemmer collapses unrelated words into one
-- lexeme. This v2 keeps that tsquery as a recall prefilter on the GIN index
-- and ANDs a regex guard on the folded text, so a hub lists only stories that
-- literally name the entity. 123 is not edited: the app falls back to it on
-- PGRST202 until 125 is applied.
--
-- The collisions (production QA, 2026-10-31, v1 = 123):
--
--   DEVA        234 matches, 11 real: "devam" and "devamı" stem to the same
--               lexeme as "deva". "Görüşmeler devam ediyor" is not DEVA.
--   İYİ Parti    70 matches, 36 real: "iyi" stems to "i", so the query is
--               'i' & 'parti' and matches any story that says "iyi" somewhere
--               and "parti" somewhere else ("Bu iyi bir parti oldu").
--   Dolar        52 matches, 44 real, plus 7 domuz stories in the top 20:
--               "dolar" and "domuz" both stem to "do".
--   Zelenski      8 vs 24: the label spells one of four spellings in the news
--               (Zelenski, Zelenskiy, Zelensky, Zelenskyy).
--   AK Parti    247 matches and 93 AKP clusters missing: the label never says
--               "AKP", the abbreviation most headlines use.
--   Borsa        8 vs 34: the label "Borsa İstanbul" needs both words, and
--               the stems of "borsa", "borsada" and "borsası" all differ.
--
-- Fresh table, read-only against production, 2026-11-01, default 14-day window
-- (live clusters: not archived, article_count >= 2, merged_into is null).
-- v1_total = 123's match count; v1_literal = the part of it that literally
-- names the entity; v2_total = this function's match count; ceiling = every
-- live cluster whose text literally matches the patterns, whatever the
-- prefilter says. v2 rows are 100% literal by construction.
--
--   key        v1_total  v1_literal  v2_total  ceiling  v2 recall
--   deva            234          11        11       11       100%
--   iyi-parti        70          36        36       38        95%
--   dolar            52          44        44       63        70%
--   akp             247         242       322      331        97%
--   zelenski          8           8        24       24       100%
--   borsa             8           8        33       34        97%
--   erdogan         422         420       420      420       100%
--   chp             194         194       194      194       100%
--
-- The same measurement over all 62 curated entities: v2_total >= v1_literal
-- for every one, and the only recall below 90% are dolar (70%: the misses are
-- "dolarlık" and "Dolar/TL", words the stemmer leaves whole, which a stemmed
-- prefilter cannot reach), tcmb (71%: "Merkez Bankasına" is stored as
-- 'banka', the bare form is queried as 'bankas') and asgari-ucret (5 of 6).
-- Borsa was 15 of 34 until the app added the suffixed spellings "borsada"
-- and "borsası" to p_queries: the stems of "borsa", "borsada" and "borsası"
-- are bor, borsa and borsas.
--
-- Two steps, one WHERE:
--
--   1. Recall. c.search_tsv @@ websearch_to_tsquery('turkish', p_queries
--      joined with ' or '), the very column and GIN index of 123/083. p_queries
--      are the Turkish lexeme spellings of EVERY curated form (AK Parti and
--      AKP; four spellings of Zelenski), built by src/lib/entities/entity-hub.ts
--      from src/lib/trends/rising-entities.ts. At most the first 12 are used,
--      mirroring ENTITY_HUB_MAX_TERMS.
--   2. Precision. The title, neutral title and summary are folded exactly like
--      migration 112, lower(translate(text, FOLD_FROM, FOLD_TO)), and must match
--      ANY of p_patterns (first 12, empty strings removed) with the ~ regex
--      operator. The two steps are ANDed, so the guard can only remove rows.
--
-- Pattern rule (built in TypeScript from curated forms only, never from
-- request input). Fold each surface form, split it into words on [^a-z0-9]+,
-- join them with \s+:
--   * a single-word form becomes \m<w>\M, or \m<w> for a hubMatch 'prefix'
--     entity whose word takes suffixes (dolara, borsada, faizi, meclisin);
--   * a multi-word form becomes \m<w1>\s+<w2> with NO trailing \M: the last
--     word may take a suffix (AK Partili, İYİ Partili, Merkez Bankasının,
--     asgari ücrete) and the words being adjacent already keeps it precise;
--   * an apostrophe suffix (DEVA'nın, Erdoğan'ın) still meets \M, because the
--     apostrophe is not a word character.
-- Examples: deva = \mdeva\M, AK Parti = \mak\s+parti, AKP = \makp\M. Empty or
-- null p_patterns return zero rows by construction (an empty array matches
-- nothing and a null one makes the predicate null), and an empty string inside
-- the array is removed first, because the empty regex matches everything. A
-- malformed regex raises an error; the caller only sends curated patterns.
--
-- Order: first_published desc, then id. The window stays on updated_at (14
-- days by default, never wider than 30; the application never passes p_since,
-- so no clock is read in app code). The cards print the first_published age
-- (src/components/story/cluster-card.tsx) and the page note says "en yeni 20
-- tanesi listeleniyor", so 123's updated_at order made the printed ages read
-- 9, 3, 4, 4 and 11 hours. Changing the card instead would make hub cards
-- disagree with the home and search cards.
--
-- EXPLAIN (analyze, buffers) of the inline SELECT with its order by and limit
-- (production, read-only, 2026-11-01), literal arrays as the app sends them:
--
--   Erdoğan  420 clusters   99.9 ms cold / 28.8 ms warm
--     Bitmap Index Scan on clusters_search_tsv_live_idx (3,703 candidate
--     rows), BitmapAnd with idx_clusters_updated_at, Bitmap Heap Scan with the
--     regex as Filter (2 rows removed), WindowAgg over the 420 survivors,
--     top-N heapsort.
--   DEVA      11 clusters   26.4 ms cold / 17.7 ms warm
--     Bitmap Index Scan on clusters_search_tsv_idx (14,865 candidate rows)
--     and on idx_clusters_active_updated_at, BitmapAnd, Bitmap Heap Scan with
--     the regex as Filter (223 stemmer collisions removed), WindowAgg,
--     quicksort of 11 rows.
--
-- The GIN index does the work and the regex only ever runs on rows it already
-- returned (hundreds, not the table). No new index is needed.
--
-- Access: SECURITY DEFINER with an empty search_path, so every relation and
-- function is schema-qualified. Execute is revoked from public, anon and
-- authenticated and granted to service_role only; the Next.js server calls it
-- through createReaderClient() (service key, 4 s statement cap). It takes no
-- table grants and the anon key cannot reach it (tests/guards/anon-surface).
--
-- Additive only: one new function (create or replace), no DDL on any existing
-- object, ledger insert is on conflict do nothing. Safe to apply twice. 123
-- stays untouched and stays the app's PGRST202 fallback.
--
-- Rollback (the app then falls back to 123 on its own):
--   drop function public.entity_cluster_ids_v2(text[], text[], timestamptz, integer);
--   delete from supabase_migrations.schema_migrations where version='125';

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
    and pg_catalog.lower(pg_catalog.translate(coalesce(c.title_tr, '') || ' ' || coalesce(c.title_tr_neutral, '') || ' ' || coalesce(c.summary_tr, ''), 'İIıŞşĞğÜüÖöÇçÂâÎîÛû', 'iiissgguuooccaaiiuu')) ~ any (pg_catalog.array_remove(p_patterns[1:12], ''))
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
  'service_role only.';

revoke all on function public.entity_cluster_ids_v2(text[], text[], timestamptz, integer) from public, anon, authenticated;
grant execute on function public.entity_cluster_ids_v2(text[], text[], timestamptz, integer) to service_role;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('125', '125_entity_cluster_ids_v2')
  on conflict do nothing;

commit;
