-- 083_reader_query_rpcs.sql
--
-- reader-queries pack. Two ids-first RPCs so PostgREST never runs a lateral
-- embed (cluster_articles -> articles -> sources) for a candidate row that
-- gets discarded by a later ORDER BY / LIMIT — the embed is the expensive
-- part, and it should only ever run for rows we're actually going to render.
--
-- Audit numbers (2026-09-28, from the reader-queries planner + this
-- migration's own Step 0 re-measurement against production, read-only):
--
--   Q1  live2 (not archived, article_count>=2)          = 20,159
--       eligible3 (article_count>=3)                     = 10,633
--       neutral3 (article_count>=3 and title_neutral_at) = 0
--       total clusters                                   = 207,103
--       -> live2 < 120,000: the CONCURRENTLY pre-step below is OPTIONAL,
--          not required, for this migration to apply safely in-transaction.
--
--   Q2  websearch_to_tsquery('turkish', 'IŞIK')  -> 'işik'
--       websearch_to_tsquery('turkish', 'Işık')  -> 'işık'
--       websearch_to_tsquery('turkish', 'ışık')  -> 'ışık'
--       Three DISTINCT lexeme spellings for the same word, because
--       Postgres's `lower()` (used by `to_tsvector`/`websearch_to_tsquery`
--       to fold case before stemming) runs under the DATABASE's collation
--       (en_US.UTF-8), not a Turkish one: en_US lower() maps both ASCII 'I'
--       and dotted 'İ' to dotted 'i', never to Turkish dotless 'ı' — so the
--       SAME reader-typed word can be stored under any of three spellings
--       depending on how the ingested title happened to be cased. A search
--       that only tries one spelling silently misses the other two.
--
--   Q3  single-variant search (`ışık` only), live2 filter: 42 rows
--   Q4  three-variant OR'd search: 57 rows (57 >= 42 — the multi-variant
--       search finds a strict superset, exactly the fix this RPC encodes).
--
--   Q5  EXPLAIN (analyze, buffers) — single-variant search 'istanbul',
--       ordered/limited exactly as the RPC below: 457 ms, 2,072 buffer
--       reads (cold). Confirms the existing `clusters_search_tsv_idx` GIN
--       index (49 MB, Q9) already serves a single-variant lookup
--       reasonably — the audit's multi-second/timeout numbers came from
--       running the embed BEFORE the sort/limit on top of this, not from
--       the tsvector lookup itself.
--
--   Q6  EXPLAIN (analyze, buffers) — the OLD two-exact-count shape
--       (status.ts pre-F1): 5,539 ms, 8,837+10,888 buffers for ONE of the
--       two counts. Matches the audit's ~1.75s mean across ~5.6k calls/day
--       (this single EXPLAIN ran cold; production sees a mix of cached and
--       cold buffers). headline_neutral_counts() below computes both
--       counts in ONE scan instead of two.
--
--   Q7  EXPLAIN (analyze, buffers) — the blindspot Step-A candidate shape
--       (id-only, same filters as blindspots-query.ts's fetchCandidateIds):
--       9.7 ms, 676 buffers. Confirms the lean id-only select the D1 fix
--       introduced is cheap on the existing indexes — no new index is
--       needed for it.
--
--   Q8  pg_stat_statements 'before' baseline for the two queryids the
--       post-deploy check will re-measure: queryid 7388368522911941400 ->
--       195 calls, mean 6 ms; queryid 7027585472307139250 -> 160 calls,
--       mean 527 ms.
--
--   Q9  clusters_search_tsv_idx size: 49 MB.
--
-- Decision rules (all passed — nothing stopped this migration):
--   - Q2 returned three DISTINCT lexemes: PASS.
--   - Q4 (57) >= Q3 (42): PASS.
--   - live2 (20,159) <= 120,000: the CONCURRENTLY pre-step is OPTIONAL.
--
-- Why ids-first: `search_cluster_ids` / the blindspot Step-A candidate
-- select (blindspots-query.ts, not this file) return ONLY `id`, sorted and
-- limited entirely inside Postgres. The caller (search-query.ts /
-- blindspots-query.ts) then runs a SEPARATE, second `.in('id', ids)` embed
-- select for just the winning ids. This is the opposite of the old shape,
-- which ran the embed as part of the SAME statement as the filter/sort, so
-- PostgREST had no way to avoid embedding a row that the final LIMIT would
-- then throw away.
--
-- Why the query variants are OR'd (`search_cluster_ids`): see Q2 above —
-- the same Turkish word can be stored as any of up to 3 lexeme spellings
-- depending on the casing of the article title that first produced it.
-- `turkishQueryVariants()` (src/lib/clusters/turkish-query.ts) derives
-- those same three candidate spellings from the reader's typed query using
-- Turkish casing round-trips; the caller passes them here as `p_variants`
-- and this function OR's their `websearch_to_tsquery('turkish', ...)`
-- results together so a query for 'IŞIK' matches a title stored under any
-- of the three spellings.
--
-- Lock note: `CREATE INDEX` (not CONCURRENTLY) inside this transaction
-- takes a SHARE lock on `clusters`. A SHARE lock blocks concurrent WRITES
-- (cluster-consumer's drain, which INSERTs/UPDATEs clusters) for the
-- duration of the index build, but does NOT block concurrent READS (every
-- reader-facing select in this pack). With live2 well under the
-- 120,000-row CONCURRENTLY threshold, the index build is expected to
-- complete in well under a second — see the optional pre-step below for
-- deployments that want to avoid even that brief write-lock window (e.g.
-- if this is ever re-applied against a much larger `clusters` table).
--
-- Optional pre-step (run off-peak, OUTSIDE a transaction, only if `live2`
-- from Q1 above is large enough that a SHARE lock during business hours is
-- undesirable):
--
--   create index concurrently if not exists clusters_search_tsv_live_idx
--     on public.clusters using gin (search_tsv)
--     where not is_archived and article_count >= 2;
--   create index concurrently if not exists clusters_neutral_eligible_idx
--     on public.clusters (title_neutral_at)
--     where article_count >= 3;
--
-- The `IF NOT EXISTS` clauses inside the transaction below then skip both
-- index creations (they're no-ops if the CONCURRENTLY pre-step already
-- built them), so running this migration after the pre-step is always
-- safe.
--
-- Additive only: no DROP, no ALTER TABLE, no TRUNCATE, no
-- UPDATE/DELETE on any existing row. Both new functions are `create or
-- replace` and the ledger insert is `on conflict do nothing` — safe to
-- re-apply.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '5min';

-- Mirrors the read-path predicate every caller of `search_cluster_ids`
-- already applies (`.eq('is_archived', false).gte('article_count', 2)` in
-- search-query.ts) — kept as a LITERAL copy so the partial index can only
-- ever serve rows the RPC's WHERE clause would also accept.
create index if not exists clusters_search_tsv_live_idx
  on public.clusters using gin (search_tsv)
  where not is_archived and article_count >= 2;

-- Mirrors `headline_neutral_counts()`'s own `article_count >= 3` floor
-- (HEADLINE_MIN_ARTICLE_COUNT, src/lib/headline/prompt.ts).
create index if not exists clusters_neutral_eligible_idx
  on public.clusters (title_neutral_at)
  where article_count >= 3;

-- Ids-first archive search (reader-queries C1 / search-query.ts). Returns
-- ONLY matching ids, ranked and capped entirely in Postgres — the caller
-- runs a separate `.in('id', ids)` embed select for just those ids, so no
-- lateral join ever runs for a candidate the final LIMIT would discard.
create or replace function public.search_cluster_ids(p_variants text[], p_limit integer default 12)
returns table (id uuid)
language sql
stable
security definer
set search_path = ''
as $fn$
  select c.id
  from public.clusters c
  where c.search_tsv @@ (
          select pg_catalog.websearch_to_tsquery('pg_catalog.turkish'::pg_catalog.regconfig, coalesce(p_variants[1], ''))
              || pg_catalog.websearch_to_tsquery('pg_catalog.turkish'::pg_catalog.regconfig, coalesce(p_variants[2], p_variants[1], ''))
              || pg_catalog.websearch_to_tsquery('pg_catalog.turkish'::pg_catalog.regconfig, coalesce(p_variants[3], p_variants[1], ''))
        )
    and not c.is_archived      -- literal copy of the partial-index predicate
    and c.article_count >= 2
  order by c.article_count desc, c.updated_at desc, c.id
  limit greatest(1, least(coalesce(p_limit, 12), 50));
$fn$;

comment on function public.search_cluster_ids(text[], integer) is
  'Ids-first archive full-text search (migration 083, reader-queries C1). '
  'Caller: src/lib/clusters/search-query.ts, which derives p_variants from '
  'src/lib/clusters/turkish-query.ts''s turkishQueryVariants() to cover the '
  'up-to-3 lexeme spellings a Turkish "I" can take under the database''s '
  'en_US.UTF-8 collation. Returns ids ONLY -- the caller runs a separate '
  '.in(''id'', ids) embed select for just the winning ids, so the '
  'cluster_articles -> articles -> sources lateral join never runs for a '
  'candidate this LIMIT would discard (the 8s-timeout shape this migration '
  'replaces). service_role only.';

-- Single-scan replacement for status.ts's old two `count: "exact", head:
-- true` aggregates (reader-queries F1). article_count >= 3 is a literal
-- copy of HEADLINE_MIN_ARTICLE_COUNT (src/lib/headline/prompt.ts) --
-- tests/migrations/083-reader-query-rpcs.test.ts parses that constant out
-- of prompt.ts and asserts the two agree, so a future change to the
-- constant can't silently drift from this function.
create or replace function public.headline_neutral_counts()
returns table (eligible bigint, neutralized bigint)
language sql
stable
security definer
set search_path = ''
as $fn$
  select pg_catalog.count(*)::bigint,
         (pg_catalog.count(*) filter (where c.title_neutral_at is not null))::bigint
  from public.clusters c
  where c.article_count >= 3;   -- = HEADLINE_MIN_ARTICLE_COUNT (src/lib/headline/prompt.ts)
$fn$;

comment on function public.headline_neutral_counts() is
  'Single-scan (eligible, neutralized) pair for the neutralizer-honesty '
  'gate (migration 083, reader-queries F1). Caller: '
  'src/lib/headline/status.ts''s getNeutralizedStatus(). Replaces two '
  'sequential `count: "exact", head: true` aggregates over `clusters` '
  '(measured ~1.75s mean, ~5.6k calls/day in production) with one scan. '
  'service_role only.';

revoke all on function public.search_cluster_ids(text[], integer) from anon, authenticated, public;
grant execute on function public.search_cluster_ids(text[], integer) to service_role;

revoke all on function public.headline_neutral_counts() from anon, authenticated, public;
grant execute on function public.headline_neutral_counts() to service_role;

insert into supabase_migrations.schema_migrations (version, name)
  values ('083', '083_reader_query_rpcs')
  on conflict do nothing;

commit;
