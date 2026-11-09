-- 186_search_stem_fold_arm.sql
--
-- Diacritic-less archive search finds the inflected headlines. Three things, all additive: a new helper function
-- public.tayf_search_stem_fold(tsvector), a new partial GIN index clusters_search_stemfold_live_idx over it, and
-- public.search_cluster_ids(p_variants text[], p_folded text, p_limit integer default 12) replaced with the same
-- signature. The body is 185's body plus ONE CTE (qs, the stem arm's query) and ONE UNION arm in cand (the third arm,
-- the stem-fold match); the variants arm, the folded arm, 166's guard, 172's tier, the 1000-row cap and the ORDER BY are
-- 185's, byte for byte. No table, column, trigger, cron job or data change; 083's two-argument function (the PGRST202
-- fallback of src/lib/clusters/search-query.ts) is not touched; no app change (h96-search-2, hunt 96, 2026-11-09).
-- This file takes the number 186 (184 is another branch's; 185 is h96-search-1's variants change).
--
-- WHY (evidence: production, read-only, 2026-11-09)
--   * The folded arm of 129 stems ASCII text, and the Turkish stemmer cannot inflect ASCII: ts_lexize('turkish_stem')
--     gives guvenligi -> guvenligi but güvenliği -> güvenlik, siginagi -> siginagı but sığınağı -> sığınak, cocugu ->
--     cocugu but çocuğu -> çocuk. The stored stems keep their Turkish letters, so an ASCII query meets only the headlines
--     that carry the base form.
--   * The uncapped union of both candidate arms (search_tsv and 129's folded expression), live clusters, the Turkish
--     spelling against the ASCII one: sığınak 14 vs siginak 6, yurt dışı 215 vs yurt disi 69, iç savaş 64 vs ic savas 24,
--     hırsızlık 38 vs hirsizlik 25, güvenlik 1501 vs guvenlik 1134, çocuk 872 vs cocuk 734. Live: /?q=siginak said "6 sonuç
--     bulundu" and /?q=sığınak "14 sonuç bulundu". A reader on a phone keyboard types ASCII, and loses 16 to 68% of the stories.
--   * Folding the STORED stems and matching them with the folded query's stem found exactly the Turkish-spelling counts
--     (siginak 14, yurt disi 215, ic savas 64, hirsizlik 38, guvenlik 1501, cocuk 872). Without an index that match is
--     a sequential scan with a per-row expression (the inline form timed out, 57014), so the fix needs an index.
--
-- WHAT
--   public.tayf_search_stem_fold(p tsvector) returns tsvector. LANGUAGE sql, IMMUTABLE, PARALLEL SAFE, SET search_path = '',
--   not security definer (the index expression runs as the writer, like 129's fold). It folds the whole vector ONCE: the
--   lexemes of tsvector_to_array(p) are joined with chr(1), folded with one call of 129's fold, split on chr(1) again,
--   de-duplicated and rebuilt with array_to_tsvector: the stored stems of a row, folded to ASCII and de-duplicated, without
--   positions (GIN does not store them). The fold is character-wise, so folding the joined text is folding each lexeme, and no
--   lexeme holds chr(1). A first body folded every lexeme twice (once to test it for emptiness, once to keep it): about 6x
--   slower on production (WRITE COST), the same vector on every live row. An empty folded
--   lexeme (a lexeme made only of U+0307, which the fold deletes) is left out: array_to_tsvector rejects an empty string,
--   and an error in an index expression would stop every UPDATE of that cluster. Execute for service_role only, like the
--   fold: every role that writes public.clusters evaluates it (STEP 0, item 3).
--   clusters_search_stemfold_live_idx: create index ... using gin (public.tayf_search_stem_fold(search_tsv)) where not
--   is_archived and article_count >= 2, the literal live predicate of 083 and 129.
--   qs (new CTE after q): the turkish stem query qf of the folded query, read as text and folded the same way, as a 'simple'
--   query: to_tsquery('simple', tayf_search_fold(qf::text)); null when qf is empty (numnode(qf) = 0), and a null query
--   matches no row. qf never holds a phrase operator by 129's rule, so its text is only quoted lexemes and & | ! ( ).
--   cand's third arm: select c.id, c.updated_at from public.clusters c where public.tayf_search_stem_fold(c.search_tsv) @@
--   (select qs from qs) and not c.is_archived and c.article_count >= 2. The predicate is copied literally from the index so
--   the planner uses it (the plan below shows the Bitmap Index Scan). The union is the same set as before plus the rows of
--   the third arm; 166's guard, kept, top (1000 rows) and the ORDER BY run on it unchanged, and a Turkish-typed query
--   gets no new row (its stems are the stored stems: arm 3 is a subset of arm 1 for sığınak, yurt dışı, iç savaş, hırsızlık,
--   güvenlik, çocuk on production).
--
-- BASE AND ORDER
--   The base is 185's body (md5 b8d0aa3035e001d17750d94f5a08c9c2, length 13324; the test recomputes it), which is not on
--   production yet: production runs 172's body (md5 192218b7b6a56b3c8fcc48d5e0610a2c, length 12913). Apply 185 first, then
--   the pre-build below, then 186. This file is complete on its own: it replaces whichever body is installed with the one
--   below, which reads six variants as 185 does. No app change and no app deploy order: the app already sends p_folded.
--
-- STEP 0 (read-only measurements on production, 2026-11-09, PostgreSQL 17.6)
--   1. select md5(prosrc), length(prosrc), proacl from pg_proc where oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure
--      -> 192218b7b6a56b3c8fcc48d5e0610a2c, 12913, {postgres=X/postgres,service_role=X/postgres}: the body of 172.
--   2. Existing indexes of public.clusters: clusters_search_tsv_live_idx 8,224,768 bytes (8032 kB), clusters_search_fold_live_idx
--      9,969,664 bytes (9736 kB), clusters_search_tsv_idx 49 MB (083's full index, 3,979 scans: still read by other queries,
--      so it is not a candidate to drop on this evidence). Live rows (not is_archived and article_count >= 2): 32,552 of
--      265,592 (12.3%). pg_database_size 7,114,640,531 bytes (6785 MB, 94.7% of 7 GiB); the table 432 MB, its indexes 120 MB.
--   3. The roles with INSERT or UPDATE on public.clusters are postgres and service_role; both can execute tayf_search_fold
--      (proacl {postgres=X/postgres,service_role=X/postgres}, provolatile i), so both can execute the helper.
--   4. A sample of 2,092 live rows (those whose id sorts below 10000000-0000-0000-0000-000000000000): 69,006 lexemes of search_tsv, 68,907 after folding and
--      de-duplication (0.9986: folding merges 99 pairs), no row folds to an empty vector.
--
-- INDEX SIZE (the decision: the database is near its 7 GiB quota)
--   Estimate: about 7 MB when built, growing to 8 to 9 MB with the churn its siblings have (clusters_search_tsv_live_idx is
--   8.0 MB, 129's folded index 9.5 MB), that is 0.1% of the database; the 383 MB of headroom to 7 GiB become about 375 MB. Basis: the 32,556 live
--   clusters of production copied (read-only) into a throwaway local PostgreSQL 15: the new index built fresh is 6,938,624
--   bytes, the same data's REINDEXed search_tsv live index 7,069,696 and folded index 7,430,144 (production's grown ones are
--   8,224,768 and 9,969,664: 1.16x and 1.34x). The folded lexemes are 99.86% of the original ones. The in-transaction build
--   (a skipped pre-build) took 0.9 s there with the fold-once helper (3.0 s with the first body) and holds a SHARE lock on
--   public.clusters for that time: about 4 s on production by the estimate of WRITE COST (about 14 s with the first body).
--   CREATE INDEX CONCURRENTLY needs no extra disk beyond the index itself.
--
-- ORCHESTRATOR PRE-BUILD (run each step standalone, outside a transaction block, before applying 186)
-- Build the index with CREATE INDEX CONCURRENTLY so inserts into clusters keep flowing; 186 then sees it and its own
-- `create index if not exists` does nothing. The index expression needs the helper, so run the steps in this order, in psql
-- autocommit as postgres through a direct connection (run `set statement_timeout = 0` first if the session has one):
--
-- (1) the helper, one short transaction (create, revoke, grant):
--
--   begin;
--   create or replace function public.tayf_search_stem_fold(p tsvector)
--   returns tsvector
--   language sql
--   immutable
--   parallel safe
--   set search_path = ''
--   as $fn$
--     select pg_catalog.array_to_tsvector(array(
--       select distinct x
--       from pg_catalog.unnest(pg_catalog.string_to_array(public.tayf_search_fold(pg_catalog.array_to_string(pg_catalog.tsvector_to_array(p), pg_catalog.chr(1))), pg_catalog.chr(1))) as x
--       where x <> ''))
--   $fn$;
--   revoke all on function public.tayf_search_stem_fold(tsvector) from public, anon, authenticated;
--   grant execute on function public.tayf_search_stem_fold(tsvector) to service_role;
--   commit;
--
-- (2) the index, one statement, autocommit:
--
--   create index concurrently if not exists clusters_search_stemfold_live_idx on public.clusters using gin (public.tayf_search_stem_fold(search_tsv)) where not is_archived and article_count >= 2;
--
-- (3) the invalid-index check (expect 0 rows). A failed or cancelled CONCURRENTLY build leaves an INVALID index behind and
--     `create index if not exists` would then skip it silently:
--
--   select c.relname from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid = i.indexrelid where c.relname = 'clusters_search_stemfold_live_idx' and not i.indisvalid;
--
-- 186 itself re-checks (indisvalid = false) and aborts with a message telling you to `drop index concurrently
-- clusters_search_stemfold_live_idx` and rebuild. If the pre-build is skipped, 186 builds the index inside its transaction
-- (about 4 s on production by the estimate of WRITE COST, 0.9 s locally on the real rows, a SHARE lock on public.clusters
-- meanwhile), so it starts with `set local lock_timeout = '5s'`
-- and `set local statement_timeout = '60s'`: a build that cannot finish in 60 s aborts the whole migration with 57014
-- (query_canceled), and nothing is recorded in the ledger. A 55P03 (the 5 s lock_timeout) only means the table was busy;
-- re-apply.
--
-- WRITE COST. The index holds the live rows only (32,564), but like 129's it is maintained on EVERY non-HOT update of a live
-- cluster (article_count is in its predicate, updated_at is a key of the btree indexes of 014 and 037), and the helper folds
-- the lexemes of the row's search_tsv (about 33 per row). Measured on production, read-only (the helper's body inline over
-- every live row, 16 id-range slices, SELECT only, 2026-11-09): the scan alone 0.37 s, the first body (a fold per lexeme,
-- twice) 12.4 s, the fold-once body of this file 2.4 s. That is fold work of about 370 microseconds per row against about
-- 63 microseconds, and the two bodies return the same vector on all 32,564 live rows (0 differ, 0 fold to an empty vector,
-- 1,061,044 lexemes become 1,059,209). The rest of the write cost is the SQL-function call with its SET clause and the GIN
-- insertion of the row's entries, which production cannot show before the index exists. Measured locally (PostgreSQL 15,
-- the real live rows, three search indexes plus this one, 3,000 rows `set article_count = article_count + 1` per
-- rolled-back sub-transaction, the three configurations alternating, median of 9): 281 ms without the index, 422 ms with it
-- on this helper, 625 ms on the first body, i.e. about 47 microseconds more per updated live row (115 with the first body),
-- 16 of them the inline fold. Production's database is about 4 times slower than that machine on this work (the inline
-- fold takes 2.0 s there against 0.51 s here), so the estimate for production is about 190 microseconds more per updated live
-- row (the 63 measured, the other 125 scaled 4x from the local run), against about 540 for the first body. The same scaling
-- puts the in-transaction build of a skipped pre-build at about 4 s (2.0 s of fold, 0.7 s of function calls, 1.0 s of GIN
-- build) and about 14 s with the first body, both far inside the 60 s statement_timeout. 129's fold index measured about 40
-- microseconds on its synthetic rows. Take the baseline of VERIFY 7 BEFORE the pre-build and compare after a day.
-- If the cluster consumer's drain time or the mean time of its update statements rises by more than a small constant per
-- row, run the ROLLBACK block: the app keeps working on 185's body.
--
-- KNOWN LIMITS
--   (1) A base-form ASCII query only: an inflected ASCII word ('guvenligi', 'siginagi') is not a stem, so its query stem is
--       not the stored stem and it still matches what it matched. Typing 'guvenlik' now finds the 'güvenliği' headlines;
--       typing 'guvenligi' does not. (2) A folded stem can collide with another stem: 'bürün-' (stem bür) folds onto 'bur',
--       the stem of burdur, so burdur has 342 candidates instead of 341 before 166's guard; the guard removes that row and the
--       list is unchanged (34 rows). The alias query 'akp' (akp or ak parti) gets 4 extra weak candidates: 'Ağı' is stored as
--       the stem 'ak', which the unquoted folded side 'ak & parti' matches next to 'Parti'; none of them is in its top 50.
--       (3) The 1000-row candidate cap is 185's: an ASCII query now has more candidates, so a very broad one can reach the cap
--       sooner. (4) The helper is evaluated on every non-HOT update of a live cluster (WRITE COST). (5) The arm adds no
--       tier: 172's exempt-word tier reads p_folded, and a row found only by the stem arm ranks by the score expression.
--
-- REPLAY (production, SELECT only through sbq.py inside a read-only transaction, 2026-11-09). Arms 1 and 2 ran as they are
--   (their indexes exist). Arm 3 has no index on production yet, so its ids were computed in 16 id-range slices with the helper's
--   expression inline (the helper is not created); the ranked body of 185 and the body of 186 then ran inline with literal
--   arguments, exactly as src/lib/clusters/search-query.ts builds them, in ONE statement per query, with arm 3 of 186 read as
--   `c.id = any(<those ids>)`. p_limit 50 is the RPC's own cap; the app sends 24 (SEARCH_LIMIT), so the top 24 is the page.
--   Uncapped candidates, arm 1 / arm 2 / arm 3, and the union of arms 1 and 2 -> the union of all three:
--   siginak          0 /    6 /   14       6 ->   14      (sığınak: 14 / 6 / 14, 14 -> 14)
--   yurt disi        0 /   69 /  215      69 ->  215      (yurt dışı: 215 / 69 / 215)
--   ic savas         0 /   24 /   64      24 ->   64      (iç savaş: 64 / 24 / 64)
--   hirsizlik        0 /   25 /   38      25 ->   38      (hırsızlık: 38 / 25 / 38)
--   guvenlik         0 / 1134 / 1501    1134 -> 1501      (güvenlik: 1501 / 1134 / 1501)
--   cocuk            0 /  734 /  872     734 ->  872      (çocuk: 872 / 734 / 872)
--   Every ASCII count now equals its Turkish twin's, and a Turkish-typed query gains no candidate.
--   Ranked, 185's body -> 186's body, rows at p_limit 50: siginak 6 -> 14, hirsizlik 25 -> 38, yurt disi 50 -> 50 (26 of the
--   top 50 are new) and ic savas 24 -> 50 (uncapped 69 -> 215 and 24 -> 64); guvenlik and cocuk keep the same 50 rows (the new
--   candidates rank below the 50th).
--   Controls: identical top 24 AND identical 50-row list for sığınak 14, yurt dışı, iç savaş, hırsızlık, güvenlik, çocuk,
--   burdur 34 (arm 3 adds one candidate, the guard removes it), miller 18, bartın 32, bartin 23, şişli 35, sisli 35, erdogan
--   (3862 candidates in each arm, the same set), iran, seçim, akp (4 weak extra candidates, none in the top 50), elektrik
--   zammı 9 and trafik cezası 38 (185's sibling queries). iran, seçim, istanbul, imamoğlu and chp add no candidate to the
--   union of arms 1 and 2 at all, so their lists are identical by construction.
--
-- COST (EXPLAIN (ANALYZE, BUFFERS), 185's body inline vs this body inline, the SAME arguments, alternated, warm, medians of 5,
--   ms; the gate is 1.3x). Production cannot show the arm before the index exists, so this is the throwaway local PostgreSQL 15
--   (a laptop, about 4x faster than production's database) holding the 32,556 real live clusters, the index built, the plan
--   checked: every body shows `Bitmap Index Scan on clusters_search_stemfold_live_idx` under its own Bitmap Heap Scan, next to
--   the scans of clusters_search_tsv_live_idx and clusters_search_fold_live_idx, under one HashAggregate.
--   no new candidate:   iran 36.45 -> 39.18 (1.07x)   erdogan 29.74 -> 31.69 (1.07x)   seçim 38.88 -> 38.85 (1.00x)
--                       akp 34.13 -> 34.86 (1.02x)   istanbul 31.72 -> 32.51 (1.02x)   burdur 7.09 -> 6.95 (0.98x)
--                       miller 1.10 -> 1.12 (1.02x)  güvenlik 27.44 -> 29.09 (1.06x)   çocuk 23.37 -> 23.43 (1.00x)
--                       yurt dışı 9.07 -> 9.42 (1.04x)  sığınak 0.79 -> 0.76 (0.96x)   iç savaş 2.23 -> 2.31 (1.03x)
--                       hırsızlık 1.46 -> 1.49 (1.02x)
--   guvenlik (ASCII) gains 367 candidates (1134 -> 1501) but both counts are over the 1000 rows that are scored: 26.09 -> 28.98 (1.11x)
--   worst case, -qwxz (a pure negation: every live row matches, in every arm): 78.49 -> 99.89 (1.27x)
--   queries that now find rows (the growth is the work for those rows, and the ASCII query costs what its Turkish twin costs):
--                       siginak 0.50 -> 0.78 (1.56x, 14 hits where 185 had 6; sığınak is 0.76)
--                       yurt disi 3.26 -> 9.39 (2.88x, 215 where 69; yurt dışı is 9.07 to 9.42)
--                       ic savas 1.05 -> 2.22 (64 where 24; iç savaş 2.23 to 2.31)   hirsizlik 1.04 -> 1.46 (38 where 25; 1.46 to 1.49)
--   The gate holds for every query that gains no row (1.00x to 1.11x, and 1.27x for the pure negation). After applying, repeat
--   it on production (VERIFY 5).
--
-- LEDGER: this file records version 186 in supabase_migrations.schema_migrations itself, idempotently (the 095
-- pattern: insert ... on conflict do nothing, last statement before commit), so applying it by posting the SQL
-- (management API or psql) leaves `supabase migration list` correct; `supabase db push` records the same row.
-- Re-applying is harmless (create or replace function, create index if not exists, and the ledger insert does nothing
-- the second time).
--
-- VERIFY (read-only, after applying)
--   1. select md5(p.prosrc), length(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
--      expect 973e3707e98448b0385bd0402c039df3, 14850.
--   2. select p.provolatile, p.proparallel, p.prosecdef, pg_catalog.has_function_privilege('anon', p.oid, 'execute'), pg_catalog.has_function_privilege('authenticated', p.oid, 'execute'), pg_catalog.has_function_privilege('service_role', p.oid, 'execute') from pg_catalog.pg_proc p where p.oid = 'public.tayf_search_stem_fold(tsvector)'::regprocedure;
--      expect i, s, false, false, false, true. The same two privilege checks for search_cluster_ids(text[], text, integer): false, true.
--   3. select i.indisvalid, pg_catalog.pg_size_pretty(pg_catalog.pg_relation_size(i.indexrelid)) from pg_catalog.pg_index i where i.indexrelid = 'public.clusters_search_stemfold_live_idx'::regclass;
--      expect true and about 7 MB.
--   4. select count(*) from public.clusters c where public.tayf_search_stem_fold(c.search_tsv) @@ pg_catalog.to_tsquery('pg_catalog.simple', 'siginak') and not c.is_archived and c.article_count >= 2;
--      expect about 14 (was 6 through arms 1 and 2), and with 'yurt & dis' about 215 (was 69).
--      select count(*) from public.search_cluster_ids(array['siginak'], 'siginak', 24); expect about 14 (the Turkish spelling sığınak gives the same).
--   5. explain (analyze, buffers) of the function body for iran, siginak and erdogan with the literals inlined (or auto_explain
--      with log_nested_statements): expect a Bitmap Index Scan on clusters_search_stemfold_live_idx under its own Bitmap
--      Heap Scan, next to the scans of the other two indexes, no Seq Scan, and execution within 1.3x of 185's body (about
--      150 ms warm for iran on production).
--   6. select count(*) from public.search_cluster_ids(array['burdur'], 'burdur', 50); expect the same count as before (34 on the day
--      of the replay): the 166 guard is intact. array['miller'] 18, array['bartın', 'bartin'] with 'bartin' 32.
--   7. Write cost: record the baseline BEFORE the pre-build, compare a day after:
--      select left(query, 70) as q, calls, round(mean_exec_time::numeric, 3) as mean_ms from pg_stat_statements where query ilike 'update %clusters%' order by calls desc limit 10;
--      together with the cluster consumer's drain time for the same backlog; a live-cluster write by service_role succeeds
--      (no 42501: `permission denied for function`).
--   8. GET /?q=siginak shows the same stories as /?q=sığınak (about 14, was 6); /?q=burdur, /?q=iran and /?q=erdogan are unchanged.
--
-- Safe to re-apply: create or replace function, create index if not exists, ledger insert `on conflict do nothing`. Nothing
-- is dropped, altered, updated or deleted.
--
-- ROLLBACK (the data shape does not change; the app does not depend on 186). One transaction for the function, then the index
-- outside a transaction block, then the helper:
--   1. re-run the function statement AND the `comment on function public.search_cluster_ids(text[], text, integer)` statement
--      of 185_search_sibling_variants.sql (the 185 body, md5 b8d0aa3035e001d17750d94f5a08c9c2; if 185 was never applied, those
--      of 172_search_exempt_word_tier.sql: md5 192218b7b6a56b3c8fcc48d5e0610a2c; create or replace keeps 186's comment otherwise);
--   2. drop index concurrently if exists public.clusters_search_stemfold_live_idx;   (outside a transaction block)
--   3. drop function if exists public.tayf_search_stem_fold(tsvector);   (after the index: the index depends on it)
--   4. delete from supabase_migrations.schema_migrations where version = '186';
--      notify pgrst, 'reload schema';
-- 083's search_cluster_ids(text[], integer) and the app's PGRST202 fallback are not involved.
--
-- See tests/migrations/186-search-stem-fold-arm.test.ts and tests/migrations/sql/186-search-stem-fold-arm-dryrun.sql.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 0. Guard: a cancelled CREATE INDEX CONCURRENTLY leaves an INVALID index that
--    `create index if not exists` would silently accept.
-- ---------------------------------------------------------------------------

do $guard$
declare
  v_bad text;
begin
  select pg_catalog.string_agg(c.relname::text, ', ' order by c.relname)
    into v_bad
    from pg_catalog.pg_index i
    join pg_catalog.pg_class c on c.oid = i.indexrelid
   where c.relnamespace = 'public'::regnamespace
     and c.relname = 'clusters_search_stemfold_live_idx'
     and i.indisvalid = false;
  if v_bad is not null then
    raise exception '186: invalid index left by an aborted CREATE INDEX CONCURRENTLY: %. Run drop index concurrently <name>, then rebuild it (see the ORCHESTRATOR PRE-BUILD block in the header of 186_search_stem_fold_arm.sql).', v_bad;
  end if;
end
$guard$;

-- ---------------------------------------------------------------------------
-- 1. The helper. IMMUTABLE and NOT security definer on purpose: an index
--    expression may only call an immutable function, and the function must run
--    as the writer. search_path is pinned to '' and every name is qualified.
-- ---------------------------------------------------------------------------

create or replace function public.tayf_search_stem_fold(p tsvector)
returns tsvector
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select pg_catalog.array_to_tsvector(array(
    select distinct x
    from pg_catalog.unnest(pg_catalog.string_to_array(public.tayf_search_fold(pg_catalog.array_to_string(pg_catalog.tsvector_to_array(p), pg_catalog.chr(1))), pg_catalog.chr(1))) as x
    where x <> ''))
$fn$;

comment on function public.tayf_search_stem_fold(tsvector) is
  'The stored stems of a search_tsv folded to ASCII (migration 186): the lexemes '
  'of the tsvector go through tayf_search_fold (129), duplicates and empty results '
  'are dropped, positions are not kept. Backs clusters_search_stemfold_live_idx and '
  'the third candidate arm of search_cluster_ids, so an ASCII-typed base form '
  '(siginak) finds the inflected Turkish headlines (the stored stem keeps its '
  'Turkish letters). Immutable, not security definer; execute for service_role only '
  '(every role that writes public.clusters evaluates it through the index expression).';

revoke all on function public.tayf_search_stem_fold(tsvector) from public, anon, authenticated;
grant execute on function public.tayf_search_stem_fold(tsvector) to service_role;

-- ---------------------------------------------------------------------------
-- 2. The stem-fold index. Partial on the literal live predicate of 083 and 129,
--    so it only ever holds the rows the RPC's WHERE clause can accept.
-- ---------------------------------------------------------------------------

create index if not exists clusters_search_stemfold_live_idx on public.clusters using gin (
    public.tayf_search_stem_fold(search_tsv))
    where not is_archived and article_count >= 2;

-- ---------------------------------------------------------------------------
-- 3. Ranked, folded archive search: 185's body plus the qs CTE and the third arm.
-- ---------------------------------------------------------------------------

create or replace function public.search_cluster_ids(p_variants text[], p_folded text, p_limit integer default 12)
returns table (id uuid)
language sql
stable
security definer
set search_path = ''
as $fn$
  with f0 as (
    select public.tayf_search_fold(coalesce(p_folded, '')) as ff
  ), g0 as (
    -- 166 guard, step 1: the whitespace tokens of the folded query, leaving out '' and every
    -- token websearch reads as a negation (a leading '-'). The pattern is a constant, and has no
    -- backslash, so it reads the same under any standard_conforming_strings setting.
    select t.tok
    from f0
    cross join lateral pg_catalog.regexp_split_to_table(f0.ff, '[[:space:]]+') as t(tok)
    where t.tok <> '' and pg_catalog.left(t.tok, 1) <> '-'
  ), gx as (
    -- 172: the over-cut words of the folded query, each with 166's exemption flag, evaluated ONCE.
    -- 166's g step in three CTEs: gx keeps its word split, its stem, its over-cut test and its two
    -- switches; g (the guard set, 166's result) reads the rows with ex false; ge (new in 172) reads
    -- the rows with ex true. The folded query is cut into whitespace tokens (g0), each token into
    -- [a-z0-9] words; a word is over-cut when the turkish stem is shorter than the word and at most
    -- 4 characters long (burdur -> bur, ersan -> er, ilhan -> ilha, miller -> mil).
    -- ex: the word is EXEMPT (not guarded) when its 3-4 letter stem is its own root, i.e. the word is
    -- the stem plus a Turkish case or plural suffix: irakta -> irak + ta, kirada -> kira + da,
    -- natonun -> nato + nun, faize -> faiz + e, zamlar -> zam + lar, and the name-shaped miller ->
    -- mil + ler, bartin -> bart + in, saniye -> sani + ye. The stem is FOLDED before it is compared
    -- with the (ASCII) word: ts_lexize gives 'ilaç' for ilaci and 'seç' for secim. A 3-letter stem
    -- needs a suffix of 3 or more letters, so tarla (tar + la) and putin (put + in) stay guarded.
    -- The pattern is a constant with no backslash; the folded tail of the word is its only subject.
    -- Both sets are empty (nothing is checked and nothing is tiered: 166's and 129's behaviour) when
    -- a token is `or` (the alias expansion joins its spellings with ' or ') or the query holds a
    -- negated phrase (-"), whose later words are not required.
    select x.w, x.st,
           (pg_catalog.length(x.st) between 3 and 4
            and pg_catalog.left(x.w, pg_catalog.length(x.st)) = public.tayf_search_fold(x.st)
            and (pg_catalog.length(x.st) = 4 or pg_catalog.length(x.w) - pg_catalog.length(x.st) >= 3)
            and pg_catalog.substr(x.w, pg_catalog.length(x.st) + 1) ~ '^(y?[ae]|n[ae]|y?[iu]|n?[iu]n|[dt][ae](n|ki)?|n[dt][ae](n|ki)?|y?l[ae]|l[ae]r[a-z]*)$') as ex
    from (
      select s.w, (pg_catalog.ts_lexize('pg_catalog.turkish_stem'::pg_catalog.regdictionary, s.w))[1] as st
      from g0
      cross join lateral pg_catalog.regexp_split_to_table(g0.tok, '[^a-z0-9]+') as s(w)
      where s.w <> ''
    ) x
    where x.st is not null
      and pg_catalog.length(x.st) < pg_catalog.length(x.w)
      and pg_catalog.length(x.st) <= 4
      and not exists (select 1 from g0 where pg_catalog.regexp_replace(g0.tok, '[^a-z0-9]+', '', 'g') = 'or')
      and not exists (select 1 from f0 where pg_catalog.strpos(f0.ff, '-"') > 0)
  ), g as (
    -- 166 guard, step 2 (the result is unchanged): the prefixes a kept row must show at a word
    -- start, one letter past the stem, at least 4 letters (burdur -> burd, ersan -> ersa,
    -- ilhan -> ilhan, igdir -> igdi). select distinct: a word typed several times is one guard
    -- row, not one per copy.
    select distinct pg_catalog.left(x.w, least(pg_catalog.length(x.w), greatest(4, pg_catalog.length(x.st) + 1))) as pre
    from gx x
    where not x.ex
  ), ge as (
    -- 172: the EXEMPT words as folded [a-z0-9] words (miller, bartin, saniye, irakta, zamlar ...).
    -- They guard nothing (no row is dropped for them); hits uses them to RE-ORDER the result.
    -- select distinct: a word typed several times is one row.
    select distinct x.w
    from gx x
    where x.ex
  ), f as (
    -- s: the folded query for the folded arm, with the two phrase makers
    -- (a double quote, a hyphen between two letters or digits) turned into
    -- spaces. lit: the same query reduced to [a-z0-9] words for the literal tier.
    -- The patterns are constants; the query is only ever the subject.
    select pg_catalog.regexp_replace(f0.ff, '"|(?<=[a-z0-9])-(?=[a-z0-9])', ' ', 'g') as s,
           pg_catalog.btrim(pg_catalog.regexp_replace(f0.ff, '[^a-z0-9]+', ' ', 'g')) as lit
    from f0
  ), q as (
    select pg_catalog.websearch_to_tsquery('pg_catalog.turkish'::pg_catalog.regconfig, coalesce(p_variants[1], ''))
              || pg_catalog.websearch_to_tsquery('pg_catalog.turkish'::pg_catalog.regconfig, coalesce(p_variants[2], p_variants[1], ''))
              || pg_catalog.websearch_to_tsquery('pg_catalog.turkish'::pg_catalog.regconfig, coalesce(p_variants[3], p_variants[1], ''))
              || pg_catalog.websearch_to_tsquery('pg_catalog.turkish'::pg_catalog.regconfig, coalesce(p_variants[4], p_variants[1], ''))
              || pg_catalog.websearch_to_tsquery('pg_catalog.turkish'::pg_catalog.regconfig, coalesce(p_variants[5], p_variants[1], ''))
              || pg_catalog.websearch_to_tsquery('pg_catalog.turkish'::pg_catalog.regconfig, coalesce(p_variants[6], p_variants[1], '')) as qv,
           -- qf never holds a phrase operator (<->): the folded arm is an
           -- expression index, and a phrase query makes Postgres recompute the
           -- fold and to_tsvector over the full text of every candidate row. A
           -- leftover phrase (a_b, x--y) falls back to plainto_tsquery (all AND).
           case when pg_catalog.strpos(x.w::pg_catalog.text, '<') > 0
                then pg_catalog.plainto_tsquery('pg_catalog.turkish'::pg_catalog.regconfig, f.s)
                else x.w end as qf,
           f.lit
    from f
    cross join lateral (select pg_catalog.websearch_to_tsquery('pg_catalog.turkish'::pg_catalog.regconfig, f.s) as w) x
  ), qs as (
    -- 186: the stem arm's query. qf is the turkish stem of the ASCII-folded query (siginak, yurt disi,
    -- guvenlik). The stored stems keep their Turkish letters and the stemmer cannot inflect the ASCII
    -- spelling, so the folded arm of 129 misses the inflected rows (the Turkish word for a shelter, in
    -- its accusative, is stored as the stem 'siginak' with Turkish letters, while the ASCII spelling of
    -- the same inflected word is left whole). The third arm therefore reads the stored stems FOLDED to
    -- ASCII, and the query is folded the same way: qf's text form, folded, read as a simple query.
    -- qf never holds a phrase operator (the q step), so the text is only quoted lexemes and & | ! ( ).
    -- An empty qf (only stop words, or nothing) gives null, and a null query matches no row.
    select case when pg_catalog.numnode(q.qf) = 0
                then null
                else pg_catalog.to_tsquery('pg_catalog.simple'::pg_catalog.regconfig, public.tayf_search_fold(q.qf::pg_catalog.text)) end as qs
    from q
  ), cand as (
    -- Three independent arms (the third is 186's), so a phrase in the variants arm (a quoted query)
    -- rechecks search_tsv only, never the folded expression.
    select c.id, c.updated_at
    from public.clusters c
    where c.search_tsv @@ (select qv from q)
      and not c.is_archived      -- literal copy of the partial-index predicate
      and c.article_count >= 2
    union
    select c.id, c.updated_at
    from public.clusters c
    where pg_catalog.to_tsvector('pg_catalog.turkish'::pg_catalog.regconfig, public.tayf_search_fold(coalesce(c.title_tr_neutral, '') || ' ' || coalesce(c.title_tr, '') || ' ' || coalesce(c.summary_tr, ''))) @@ (select qf from q)
      and not c.is_archived      -- literal copy of the partial-index predicate
      and c.article_count >= 2
    union
    -- 186: the stored stems folded to ASCII, matched with the folded query stem. Index:
    -- clusters_search_stemfold_live_idx. The predicate below is a literal copy of its predicate.
    select c.id, c.updated_at
    from public.clusters c
    where public.tayf_search_stem_fold(c.search_tsv) @@ (select qs from qs)
      and not c.is_archived      -- literal copy of the partial-index predicate
      and c.article_count >= 2
  ), kept as (
    -- 166 guard, step 3: a candidate stays when, for EVERY guard prefix, the folded text of its
    -- title, or the folded text of its summary plus its neutral title, has that prefix at a word
    -- start. A word start is ' ' || text searched for ' ' || pre. A prefix found only after
    -- punctuation ("Burdur", Ankara-Burdur) is caught by the exact test: the text with every
    -- non-[a-z0-9] run turned into one space (the strpos probe first, so the regexp runs only
    -- where the prefix occurs at all). The three texts are the three columns of 129's folded text
    -- (title_tr_neutral || ' ' || title_tr || ' ' || summary_tr); a word start in the joined text
    -- is a word start in one of them because they are joined by a space, and a prefix holds no
    -- space, so summary || ' ' || neutral folded as one string gives the same answer as each
    -- folded alone (tayf_search_fold is character-wise: translate + lower).
    -- Folds per candidate: a folds the title ONCE, and b folds the summary plus the neutral title
    -- ONCE, and only when some prefix is not already in the title. Every guard prefix is then
    -- tested against those two values, so the number of guard words (a typed word repeated, or
    -- many different ones) adds comparisons, never folds. No fold sits inside a subquery that
    -- reads g, which would run once per (candidate, guard row). Each lateral subquery is fenced
    -- with offset 0 so it stays a unit of its own.
    -- The candidates are visited newest first (the sorted subquery; offset 0 keeps it whole) and
    -- `top` stops after 1000 survivors. r is the primary-key read of the cluster, fenced with
    -- offset 0 so that its plan never depends on how many guard words the planner expects. With
    -- an empty guard set the first test is true, OR stops there and the cluster is never read.
    select k.id, k.updated_at
    from (select s.id, s.updated_at from cand s order by s.updated_at desc, s.id offset 0) k
    where not exists (select 1 from g)
       or exists (
            select 1
            from (select c.title_tr, c.summary_tr, c.title_tr_neutral from public.clusters c where c.id = k.id offset 0) r
            cross join lateral (select public.tayf_search_fold(coalesce(r.title_tr, '')) as t offset 0) a
            cross join lateral (
              select case when exists (select 1 from g where not (pg_catalog.strpos(' ' || a.t, ' ' || g.pre) > 0 or (pg_catalog.strpos(a.t, g.pre) > 0 and pg_catalog.strpos(' ' || pg_catalog.regexp_replace(a.t, '[^a-z0-9]+', ' ', 'g'), ' ' || g.pre) > 0)))
                          then public.tayf_search_fold(coalesce(r.summary_tr, '') || ' ' || coalesce(r.title_tr_neutral, ''))
                          else '' end as s
              offset 0) b
            where not exists (select 1 from g where not (pg_catalog.strpos(' ' || a.t, ' ' || g.pre) > 0 or (pg_catalog.strpos(a.t, g.pre) > 0 and pg_catalog.strpos(' ' || pg_catalog.regexp_replace(a.t, '[^a-z0-9]+', ' ', 'g'), ' ' || g.pre) > 0)) and not (pg_catalog.strpos(' ' || b.s, ' ' || g.pre) > 0 or (pg_catalog.strpos(b.s, g.pre) > 0 and pg_catalog.strpos(' ' || pg_catalog.regexp_replace(b.s, '[^a-z0-9]+', ' ', 'g'), ' ' || g.pre) > 0)))
          )
  ), top as (
    -- Candidate cap: only the 1000 most recently updated hits are scored.
    select k.id from kept k order by k.updated_at desc, k.id limit 1000
  ), hits as (
    -- 172 tier. lit_ok: every exempt word of the query (ge) starts a word of the cluster text, or ge
    -- is empty. The text is the title, the neutral title and the summary with apostrophes deleted
    -- (a title with Irak'ta, Miller'in or Bartin'da counts) and folded. A word start is ' ' || text
    -- searched for ' ' || word; the probe runs on the folded text itself, and only when the word
    -- occurs at all but not after a space (a quote, a hyphen, a bracket) is the exact test run, on
    -- the text with every run of non-[a-z0-9] turned into one space (the 166 idiom), so a row that
    -- only holds the stem never reaches the regexp. The word holds no space, so a word start of
    -- the joined text is a word start of one piece: a is the title and neutral title (their fold is
    -- ftitle, folded once, and the apostrophes are deleted from it), b the summary, folded only
    -- for a hit whose title does not already hold every exempt word, and never when ge is empty.
    -- lit_ok is the first ORDER BY key and is never a filter: no row leaves the result for it.
    -- No user text reaches a regex; the words only go through strpos.
    select c.id, c.updated_at, c.article_count,
           a0.f as ftitle,
           not exists (select 1 from ge where not ((pg_catalog.strpos(' ' || a.t, ' ' || ge.w) > 0 or (pg_catalog.strpos(a.t, ge.w) > 0 and pg_catalog.strpos(' ' || pg_catalog.regexp_replace(a.t, '[^a-z0-9]+', ' ', 'g'), ' ' || ge.w) > 0)) or (pg_catalog.strpos(' ' || b.s, ' ' || ge.w) > 0 or (pg_catalog.strpos(b.s, ge.w) > 0 and pg_catalog.strpos(' ' || pg_catalog.regexp_replace(b.s, '[^a-z0-9]+', ' ', 'g'), ' ' || ge.w) > 0)))) as lit_ok
    from top t
    join public.clusters c on c.id = t.id
    cross join lateral (select public.tayf_search_fold(coalesce(c.title_tr_neutral, '') || ' ' || coalesce(c.title_tr, '')) as f offset 0) a0
    cross join lateral (select case when exists (select 1 from ge) then pg_catalog.replace(pg_catalog.replace(a0.f, pg_catalog.chr(39), ''), pg_catalog.chr(8217), '') else '' end as t offset 0) a
    cross join lateral (
      select case when exists (select 1 from ge where not (pg_catalog.strpos(' ' || a.t, ' ' || ge.w) > 0 or (pg_catalog.strpos(a.t, ge.w) > 0 and pg_catalog.strpos(' ' || pg_catalog.regexp_replace(a.t, '[^a-z0-9]+', ' ', 'g'), ' ' || ge.w) > 0)))
                  then public.tayf_search_fold(pg_catalog.replace(pg_catalog.replace(coalesce(c.summary_tr, ''), pg_catalog.chr(39), ''), pg_catalog.chr(8217), ''))
                  else '' end as s
      offset 0) b
  )
  select h.id
  from hits h cross join q
  order by (case when h.lit_ok then 0 else 1 end),
         1.0 * pg_catalog.ts_rank_cd(pg_catalog.to_tsvector('pg_catalog.turkish'::pg_catalog.regconfig, h.ftitle), q.qf, 32)::pg_catalog.float8
         + 2.0 * (case when q.lit <> '' and pg_catalog.strpos(' ' || pg_catalog.regexp_replace(h.ftitle, '[^a-z0-9]+', ' ', 'g'), ' ' || q.lit) > 0 then 1 else 0 end)
         + 0.5 / (1.0 + extract(epoch from (pg_catalog.now() - h.updated_at))::pg_catalog.float8 / 604800.0) desc,
         h.article_count desc, h.updated_at desc, h.id
  limit greatest(1, least(coalesce(p_limit, 12), 50));
$fn$;

comment on function public.search_cluster_ids(text[], text, integer) is
  'Ranked, ASCII-folded archive search (migration 129; supersedes 083''s '
  'two-argument function for src/lib/clusters/search-query.ts) with the over-stem '
  'guard of migration 166, the exempt-word tier of migration 172, the sibling '
  'variants of migration 185 and the stem-fold arm of migration 186. Candidates: '
  'live clusters matching search_tsv (p_variants: up to six en_US spellings of 083, '
  'ORed; a missing one repeats the first; the app sends at most three per call), the '
  'folded index (p_folded = '
  'foldTr(query), phrase-free) or the stem-fold index (186: the stored stems folded '
  'to ASCII, so an ASCII-typed base form finds the inflected Turkish headlines: '
  'siginak finds siginagi), as three separate index scans. Guard (166): a typed word '
  'whose turkish stem over-cuts it (stem shorter than the word and at most 4 '
  'characters: burdur -> bur) must also appear, by its first letters, at a word start '
  'in the title or summary; a word that is its 3-4 letter root plus a case or plural '
  'suffix (irakta -> irak + ta, kirada, zamlar, miller -> mil + ler) is exempt and not '
  'guarded; the guard is skipped for queries with an OR or a negated phrase, and reads '
  'p_folded only. Tier (172): the exempt words only RE-ORDER: a row whose title, '
  'neutral title or summary has every exempt word at a word start (apostrophes '
  'deleted) ranks above a row that holds only the stem (bartin: Bartin before Bart De '
  'Wever); no row is dropped, and a query without an exempt word is in one tier. '
  'Siblings (185): when the typed call leaves the page short, the app asks a second '
  'call for the root spellings of a possessive or doubled-stem term (zammi -> zam, '
  'vergisi -> vergi) and appends its new ids. The 1000 most recently '
  'updated survivors are scored. Order: tier first, then literal word-start title '
  'hits (weight 2.0), then title relevance (1.0) plus recency (0.5, 7-day scale); '
  'article_count only breaks ties. Returns ids ONLY. service_role only.';

revoke all on function public.search_cluster_ids(text[], text, integer) from public, anon, authenticated;
grant execute on function public.search_cluster_ids(text[], text, integer) to service_role;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('186', '186_search_stem_fold_arm')
  on conflict do nothing;

commit;
