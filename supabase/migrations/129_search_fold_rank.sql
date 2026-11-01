-- 129_search_fold_rank.sql
--
-- Turkish ASCII fold and a ranked archive search. One new immutable function
-- (tayf_search_fold), one partial GIN index over the folded text
-- (clusters_search_fold_live_idx) and a new three-argument search_cluster_ids
-- that matches either index and ranks its hits. Additive, one transaction, no
-- table or column change, no data written. The app (src/lib/clusters/
-- search-query.ts) calls the new function and falls back to 083's two-argument
-- one on PGRST202, so the deploy order is free.
--
-- WHY (hunt 9, 2026-11-01). On production the stored lexemes keep their Turkish
-- letters (search_tsv is to_tsvector('turkish', ...) under the en_US lower()),
-- so a reader typing ASCII found nothing: `sisli`, `cumhurbaskani`, `imamoglu`
-- and `ozel` each returned 0 rows (STEP 0, item 3). The archive was also
-- ordered by article_count alone: `borsa` (Turkish stem `bor`) listed Ayhan
-- Bora Kaplan and Saniye Bora Fici among the top 12 for Borsa Istanbul news,
-- and `istanbul` put 360 to 790 hour old stories above that day's.
--
-- WHAT
--   tayf_search_fold(text)  the house fold of migrations 112/125/126
--       (translate(text, FROM || chr(775), TO), then lower), with ONE change:
--       the lower() runs under `collate "C"`. The 112/125/126 expressions call
--       a plain lower(), which follows the database locale (en_US.UTF-8) and so
--       is not honestly IMMUTABLE; under the C collation lower() touches ASCII
--       A-Z only, which is also all that is left after the translate (every
--       Turkish capital was already mapped to an ASCII lower-case letter).
--       FROM = RISING_FOLD_FROM, TO = RISING_FOLD_TO (src/lib/trends/
--       rising-entities.ts); chr(775) is U+0307 (the combining dot above of a
--       decomposed I), which translate() deletes because TO is one character
--       shorter. TypeScript twin: foldTr() in src/lib/clusters/turkish-query.ts;
--       tests/migrations/129-search-fold-rank.test.ts pins the parity.
--       LANGUAGE sql, IMMUTABLE, PARALLEL SAFE, search_path '', NOT security
--       definer (an index expression runs as the writer).
--   clusters_search_fold_live_idx  gin (to_tsvector('turkish', tayf_search_fold(
--       title_tr_neutral || ' ' || title_tr || ' ' || summary_tr))) where not
--       is_archived and article_count >= 2. The same three columns as
--       search_tsv (035), the same literal live predicate as 083's
--       clusters_search_tsv_live_idx.
--   search_cluster_ids(p_variants text[], p_folded text, p_limit integer
--       default 12)  candidates are the live rows that match either index: the OR
--       of the three 083 variant queries (p_variants, the en_US spellings) against
--       search_tsv, or the folded query (p_folded) against the folded index. The
--       two arms are separate index scans joined by UNION, the folded query never
--       holds a phrase operator, and only the 1000 most recently updated
--       candidates are scored (BOUNDED WORK below). The two-argument function of
--       083 is NOT touched or dropped: it is the PGRST202 fallback and the
--       rollback target.
--
-- RANKING. Named weights, one score, higher first:
--     score = W_REL * ts_rank_cd(to_tsvector(folded title), folded query, 32)
--           + W_LIT * (folded title has the query as a word-start literal)
--           + W_REC * 1 / (1 + age / 7 days)
--     W_REL=1.0, W_LIT=2.0, W_REC=0.5, recency scale 7 days (604800 s).
--   ts_rank_cd with normalisation 32 is rank / (rank + 1), so it stays below 1;
--   recency is at most W_REC. W_REL + W_REC therefore cannot reach 1.5, and
--   W_LIT = 2.0 is larger: every literal-title hit outranks every non-literal
--   row, whatever its relevance or age. That is what separates borsa from Bora
--   without touching the text-search configuration. article_count only breaks
--   exact ties (then updated_at desc, then id).
--   The literal tier: lit = the folded query with every run of non [a-z0-9]
--   characters turned into one space, trimmed; the folded title gets the same
--   treatment; a hit is literal when strpos(' ' || title, ' ' || lit) > 0, i.e.
--   a title word STARTS with the query (borsa matches Borsa and Borsasi, not
--   Bora). No user text ever reaches a regex: the regexp_replace patterns are
--   constants and the comparison is strpos.
--
-- BOUNDED WORK (review of hunt 9, 2026-11-01). The home search (/?q=) is
-- anonymous and has no rate limit, and it calls this function with the
-- service-role client, so what one call costs is what an unauthenticated reader
-- can make the primary database spend. The first draft of 129 OR-ed the two arms
-- into one bitmap scan and scored every hit. Median milliseconds on the local seed
-- of the LOCAL PROOF below (30,521 live rows; five runs for 083 and the first
-- draft, seven for this file), limit 50:
--
--   query (typed as shown)                          hits   083   first draft   this file
--   istanbul                                       2,071   0.7        22.9        13.4
--   cumhurbaskani                                  2,855   0.1*       32.6        13.2
--   cumhurbaskani or istanbul or ozel or imamoglu  6,543   0.7*       76.6        15.5
--   15 common words joined by "or"                16,461   5.3       233.0        27.2
--   -qwxz (every live row)                        30,521   7.1       306.9        28.9
--   "haber gundem"                                   271   0.1        13.7         3.9
--   8 quoted two-word phrases joined by "or"       1,321   3.7        62.6        22.3
--   cumhurbaşkanı or özel or imamoğlu or şişli     4,904   1.6           -        16.0
--   * 083 returns no row for most of an ASCII query, which is the bug 129 fixes,
--     so its time says little; the last row, typed with Turkish letters, is the
--     like-for-like one. "hits" = candidates of this file (before the cap).
--
-- Three causes, three bounds:
--   1. Phrase recheck. A phrase tsquery (a quoted query, or a hyphenated word:
--      websearch_to_tsquery('turkish', 'e-posta') is 'e-pos' <-> 'e' <-> 'pos')
--      makes GIN hand back candidates that must be rechecked, and for the folded
--      EXPRESSION index the recheck recomputes the fold and to_tsvector over the
--      whole text of every candidate row. The eight-phrase query sent 1,321
--      candidates through it. So qf is phrase-free: double quotes and a hyphen
--      between two letters or digits become spaces before websearch_to_tsquery,
--      and if any phrase operator is still left (a_b, x--y and c++-dev still
--      parse into one) qf switches to plainto_tsquery, which is all AND. The folded arm keeps
--      websearch's `or` and `-word`; only that fallback loses them. The GIN match
--      of the folded arm is then exact and never rechecked.
--   2. One OR across both arms. A bitmap heap scan rechecks the WHOLE OR clause
--      for the tuples its bitmap marks for recheck, and that mark is per page, so
--      a phrase in the variants arm (a quoted query keeps its phrase there, as in
--      083) still makes Postgres recompute the folded expression for every
--      candidate it rechecks. Observed locally, variants arm = the eight phrases,
--      folded arm phrase-free and contributing 0 candidates: the single OR scan
--      took 20.6 ms (430 rows removed by index recheck), the same two arms joined
--      by UNION took 1.7 ms. The arms are therefore two selects joined by UNION:
--      each is its own bitmap scan with its own recheck, and the variants arm
--      rechecks a stored tsvector only.
--   3. Scoring every hit. ts_rank_cd, the fold and regexp_replace ran for each hit
--      (about 14 microseconds), so a query that matched every live row spent 300
--      ms. The candidates are cut to the 1000 most recently updated ones
--      (updated_at desc, id) BEFORE scoring, so the scoring cost is bounded by
--      1000 rows whatever the query matches. Results do not change while a query
--      has 1000 hits or fewer. For a broader query the top 24 are picked among its
--      1000 newest hits. On production 'istanbul' has 2,903 live hits via
--      search_tsv (read-only, 2026-11-01): the 24th newest was updated 21.4 hours
--      ago and the 1000th newest 721.5 hours ago. The price of the bound: for a
--      query that broad, a hit older than the cutoff (here a month), even one with
--      the query in its title, can no longer outrank fresher ones. Locally the
--      first 50 ids are identical, in order, between the first draft and this
--      file for istanbul (2,071 candidates), cumhurbaskani (2,855) and ozel
--      (1,942), which are over the cap, and for borsa, sisli, imamoglu, bora,
--      erdogan, "deprem enflasyon", "enflasyon or deprem" and "ankara -haber".
--   NOT done: a per-IP limiter on the search path. src/lib/rate-limit.ts says it
--   is process-local, so on serverless instances it would not bound anything
--   across the fleet, and the page would need a "too many requests" state. The
--   bound above sits in the database, where it holds for every instance. A
--   request-rate cap for `/` with a q parameter belongs to the platform (a Vercel
--   Firewall rate-limit rule), which is an operator step, not part of this file.
--
-- STEP 0 -- read-only measurements on production (2026-11-01, PostgreSQL 17.6,
-- datcollate en_US.UTF-8, via the management API). Every number is observed.
--
--   1. WRITER ROLES of public.clusters, the roles that must be allowed to run
--      tayf_search_fold. Postgres ACL-checks every function in an index
--      expression when an INSERT or UPDATE forms index tuples (ExecInitFunc,
--      ACL_EXECUTE), so a role that writes clusters without EXECUTE would fail
--      with 42501 on every write to a live row. pg_stat_statements (track =
--      top) joined to pg_roles, statements matching insert into / update /
--      delete from public.clusters:
--          service_role  3 statements  46,526 calls
--          postgres     15 statements      17 calls
--      Table privileges (information_schema.role_table_grants): INSERT, UPDATE,
--      DELETE and TRUNCATE are held by postgres (the owner) and service_role
--      only; anon and authenticated hold none (117). The 9 functions that write
--      clusters (apply_article_title_edits, blindspot_recall_veto_refresh,
--      cluster_merge_atomic, cluster_topics_refresh, cluster_unlink_article,
--      delete_source, prune_singleton_clusters, recompute_bias_distribution,
--      recompute_blindspot_flags) are SECURITY DEFINER owned by postgres, and
--      all 36 pg_cron jobs run as postgres. supabase_admin is a superuser and
--      skips ACL checks. RESULT: the writers are postgres, service_role and
--      supabase_admin, so EXECUTE for service_role (the owner already has it)
--      is enough and no other role is granted anything. OK.
--
--   2. BASELINE, 083's two-argument body for 'istanbul' (literals), limit 12:
--        Limit  (cost=121.56..121.59 rows=12) (actual time=72.884..72.889 rows=12)
--          ->  Sort  (Sort Key: c.article_count DESC, c.updated_at DESC, c.id)
--                ->  Bitmap Heap Scan on clusters c  (actual rows=2903)
--                      Heap Blocks: exact=2727  Buffers: shared hit=409 read=2385
--                      ->  Bitmap Index Scan on clusters_search_tsv_live_idx (rows=2925)
--        Execution Time: 73.047 ms (partly cold). 2,903 live clusters match.
--
--   3. MATCH COUNTS over the 30,753 live clusters (not archived, article_count
--      >= 2), the fold inlined as lower(translate(...) collate "C") (the
--      function does not exist on production yet), against search_tsv today:
--          sisli            0 today  ->     25 folded
--          cumhurbaskani    0 today  ->  4,092 folded
--          imamoglu         0 today  ->    535 folded
--          ozel             0 today  ->  2,825 folded
--          istanbul     2,903 today  ->  2,902 folded (129 ORs both indexes)
--
--   4. COST WITHOUT THE INDEX. The ranked top 24 for 'istanbul' with the fold
--      inlined: a BitmapAnd of idx_clusters_active_updated_at and
--      clusters_active_updated_idx, then a Filter that folds and to_tsvector()s
--      every live row (the seq-scan equivalent):
--        Limit  (cost=11723.52..11723.58 rows=24) (actual time=5509.935..5509.947 rows=24)
--          ->  Bitmap Heap Scan on clusters c  (Rows Removed by Filter: 27850, rows=2903)
--                Buffers: shared hit=26764 read=5420
--        Execution Time: 5510.424 ms.
--      5.5 s against the reader client's 4 s cap: the index is not optional,
--      hence the pre-build below.
--
--   5. RANKED TOP 24, fold inlined. 'istanbul': the top 12 were updated 1.8,
--      2.7, 3.3, 3.8, 3.9, 4.2, 16.7, 16.9, 18.0, 18.6, 19.0 and 19.4 hours ago
--      (12 of 12 inside 24 h). 083's order (article_count desc) had two stories
--      under 24 h old in its top 12 (18.8 h and 22.2 h); the others were 362 to
--      790 hours old. 'borsa': 143 hits, 52 literal-title (a title word starts
--      with borsa) and 91 not. Lowest literal score 2.022, highest non-literal
--      0.402, so every literal row ranks above every other row. 11 hits carry
--      the word Bora; 1 of them is also a literal row (a title with both Bora and
--      Borsasi), the other 10 rank after all 52. 083's top 12 for 'borsa' held two
--      Bora rows (Ayhan Bora Kaplan, Saniye Bora Fici) and mostly off-topic
--      stories; the new top 24 are all literal Borsa titles.
--      These two lists were taken before the 1000-candidate cap (BOUNDED WORK);
--      the 'istanbul' rows (1.8 to 19.4 hours old) lie far inside it, and 'borsa'
--      has 143 hits, under it.
--
-- LOCAL PROOF (PostgreSQL 15.12, throwaway cluster, initdb --locale=en_US.UTF-8
-- -E UTF8; stub.sql, then a scratch seed kept outside the repo; 035 and 083
-- applied for real, plus the two updated_at partial indexes production has (014,
-- 037)). The seed: 120,000 clusters, 30,521 live (production 30,753), a 77 MB
-- heap (production 423 MB), average live summary 364 characters (production about
-- 385), common words (Istanbul, Cumhurbaskani, Ozel, Haber, Gundem ...) at about
-- their production shares, Borsa, Bora, Sisli and Imamoglu titles at about their
-- production counts, vacuumed and analyzed. The numbers are warm and the heap is
-- smaller than production's, so a cold production read will add heap reads that
-- the 083 baseline also pays (Step 0 item 2); the scoring cost is capped.
--   Fold parity in SQL: tayf_search_fold('İSTANBUL ŞİŞLİ') = 'istanbul sisli'.
--   Match counts, all candidates (before the cap), 083 first, 129 second:
--       sisli 0 -> 40, cumhurbaskani 0 -> 2,855, imamoglu 0 -> 356,
--       ozel 0 -> 1,942, erdogan 0 -> 249, istanbul 2,071 -> 2,071, borsa 100 -> 100.
--   Timings: the table under BOUNDED WORK. The slowest 129 call there is 29 ms
--       (every live row matching), against the 150 ms target.
--   Plan, this file, '-qwxz' (30,521 candidates), taken with auto_explain inside
--       the function: Limit -> Sort (top-N heapsort) -> Nested Loop over a Limit
--       of 1000 on Sort (updated_at desc, id) on HashAggregate on Append of
--       two Bitmap Heap Scans, one over a Bitmap Index Scan on
--       clusters_search_tsv_live_idx and one over clusters_search_fold_live_idx
--       (30,521 rows each), then 1000 clusters_pkey lookups. No Seq Scan, no
--       Filter, no "Rows Removed by Index Recheck".
--   Ranking: 'borsa' has 43 live literal-title hits; the first 50 ids are those 43
--       at ranks 1 to 43 and the rest, the first non-literal one at rank 44.
--   Apply #1 (ledger had no row 129): BEGIN, SET, SET, DO, CREATE FUNCTION,
--       COMMENT, REVOKE, GRANT, CREATE INDEX, CREATE FUNCTION, COMMENT, REVOKE,
--       GRANT, NOTIFY, INSERT 0 1, COMMIT. Apply #2: the same, with NOTICE
--       relation "clusters_search_fold_live_idx" already exists, skipping, then
--       NOTIFY, INSERT 0 0, COMMIT; one ledger row for 129.
--   Rehearsals: (a) with the three pre-build steps below run verbatim from this
--       header (a script cut them out of the file), the function transaction and
--       the CONCURRENTLY build went through, the invalid-index check returned 0
--       rows and apply printed the "already exists, skipping" notice and INSERT
--       0 1. (b) With the index forced to indisvalid = false (local superuser),
--       apply stopped in step 0 with "129: invalid index left by an aborted CREATE
--       INDEX CONCURRENTLY: clusters_search_fold_live_idx. Run drop index
--       concurrently <name>, then rebuild it ...", the transaction rolled back (0
--       ledger rows for 129, no three-argument function) and the check query
--       returned the index; restored, apply went through. (c) The ROLLBACK block
--       below, run statement by statement, left only 083's
--       search_cluster_ids(text[], integer), no index and no ledger row.
--   Grants: as service_role, update public.clusters set title_tr = title_tr, the
--       value-changing set title_tr = title_tr || ' x' and set article_count =
--       article_count + 1, updated_at = now() on a live row all succeeded, and
--       search_cluster_ids returned rows. As anon, select public.tayf_search_fold
--       ('x') failed with "permission denied for function tayf_search_fold" and
--       search_cluster_ids with "permission denied for function
--       search_cluster_ids". has_function_privilege is false for anon and
--       authenticated and true for service_role and postgres on both functions;
--       PUBLIC holds nothing. A scratch writer role with UPDATE on clusters but
--       WITHOUT execute on the fold failed with the same error on set
--       article_count = article_count + 1 and on set updated_at = now() of a live
--       row (see WRITE COST), and succeeded on a no-op title_tr = title_tr (HOT:
--       no index tuple, the fold is never evaluated) and on an archived row
--       (outside the partial predicate). The no-op case does not exercise the ACL,
--       which is why STEP 0 item 1 checks the writer roles instead of trusting it.
--   PostgreSQL 17 (production) pins search_path to pg_catalog, pg_temp during
--       maintenance operations (REINDEX, ANALYZE, VACUUM, CREATE INDEX); every
--       name in the fold is schema-qualified and the function sets its own
--       search_path = '', so index maintenance resolves nothing differently.
--   No table is created, so there is no default-grant revoke and no PG17-guarded
--       MAINTAIN block here; anon and authenticated hold no table grants (117).
--
-- ORCHESTRATOR PRE-BUILD (run each step standalone, outside a transaction block, before applying 129)
-- Build the index with CREATE INDEX CONCURRENTLY so inserts into clusters keep
-- flowing; 129 then sees it and its own `create index if not exists` does
-- nothing. The index expression needs the function, so run the steps in this
-- order, in psql autocommit as postgres through a direct connection (run
-- `set statement_timeout = 0` first if the session has one):
--
-- (1) the function, one short transaction (create, revoke, grant):
--
--   begin;
--   create or replace function public.tayf_search_fold(p_text text)
--   returns text
--   language sql
--   immutable
--   parallel safe
--   set search_path = ''
--   as $fn$
--     select pg_catalog.lower(pg_catalog.translate(p_text, 'İIıŞşĞğÜüÖöÇçÂâÎîÛû' || pg_catalog.chr(775), 'iiissgguuooccaaiiuu') collate pg_catalog."C")
--   $fn$;
--   revoke all on function public.tayf_search_fold(text) from public, anon, authenticated;
--   grant execute on function public.tayf_search_fold(text) to service_role;
--   commit;
--
-- (2) the index, one statement, autocommit:
--
--   create index concurrently if not exists clusters_search_fold_live_idx on public.clusters using gin (
--       pg_catalog.to_tsvector('pg_catalog.turkish'::pg_catalog.regconfig, public.tayf_search_fold(coalesce(title_tr_neutral, '') || ' ' || coalesce(title_tr, '') || ' ' || coalesce(summary_tr, ''))))
--       where not is_archived and article_count >= 2;
--
-- (3) the invalid-index check (expect 0 rows). A failed or cancelled CONCURRENTLY
--     build leaves an INVALID index behind and `create index if not exists`
--     would then skip it silently:
--
--   select c.relname from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid = i.indexrelid where c.relname = 'clusters_search_fold_live_idx' and not i.indisvalid;
--
-- 129 itself re-checks (indisvalid = false) and aborts with a message telling
-- you to `drop index concurrently clusters_search_fold_live_idx` and rebuild.
--
-- If the pre-build is skipped, 129 builds the index inside its transaction. That
-- scans the heap of public.clusters under a SHARE lock that blocks writes to
-- clusters, so 129 starts with `set local lock_timeout = '5s'` and
-- `set local statement_timeout = '60s'`: a build that cannot finish in 60 s
-- aborts the whole migration with 57014 (query_canceled) instead of blocking
-- ingest, and nothing is recorded in the ledger. Build it concurrently and
-- re-apply. A 55P03 (the 5 s lock_timeout) only means the table was busy; re-apply.
--
-- WRITE COST. The index holds the live rows only (30,753 on production), but it
-- is maintained on EVERY non-HOT update of a live cluster, not only when title_tr,
-- title_neutral or summary_tr change. A heap-only (HOT) update is impossible when
-- a column that any index uses changes: article_count is in this index's
-- predicate, and updated_at is the key of idx_clusters_active_updated_at (014)
-- and clusters_active_updated_idx (037). The cluster consumer's routine
-- article_count and updated_at bumps are therefore non-HOT: they write a tuple
-- into every index of the table, and for this one they evaluate the fold and
-- to_tsvector over title and summary and insert the lexemes into the GIN. Proof:
-- a role with UPDATE on public.clusters and no EXECUTE on tayf_search_fold got
-- "permission denied for function tayf_search_fold" for both `set article_count =
-- article_count + 1` and `set updated_at = now()` on a live row (local PG15).
-- Measured cost, local seed, 3,000 live rows `set article_count = article_count +
-- 1` in one statement, median of four runs: 152 ms with the index, 31 ms without,
-- about 40 microseconds more per updated row. service_role is the busiest writer
-- (46,526 calls in STEP 0 item 1), so take the baseline in VERIFY 8 BEFORE the
-- pre-build and compare after. If the consumer's drain time or the mean time of
-- its update statements rises by more than a small constant per row, run the
-- ROLLBACK block below: the app falls back to 083 by itself.
--
-- VERIFY (read-only, after applying):
--   1. select p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid) from pg_catalog.pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('search_cluster_ids', 'tayf_search_fold') order by 1, 2;
--      expect tayf_search_fold(p_text text), search_cluster_ids(p_variants text[], p_limit integer) (083, untouched) and search_cluster_ids(p_variants text[], p_folded text, p_limit integer).
--   2. select pg_catalog.has_function_privilege('anon', 'public.tayf_search_fold(text)', 'execute'), pg_catalog.has_function_privilege('authenticated', 'public.tayf_search_fold(text)', 'execute'), pg_catalog.has_function_privilege('service_role', 'public.tayf_search_fold(text)', 'execute');
--      expect false, false, true. Same for search_cluster_ids(text[], text, integer).
--   3. select count(*) from public.search_cluster_ids(array['sisli'], 'sisli', 24);
--      expect more than 0 (it was 0). Likewise cumhurbaskani, imamoglu, ozel.
--   4. explain (analyze, buffers) of the function body for 'istanbul' with the
--      literals inlined (or auto_explain with log_nested_statements): expect two
--      Bitmap Index Scans, one on clusters_search_tsv_live_idx and one on
--      clusters_search_fold_live_idx, each under its own Bitmap Heap Scan below a
--      HashAggregate and a Limit of 1000, no Seq Scan, no Filter that folds
--      rows and no "Rows Removed by Index Recheck" on the folded arm; execution
--      well under 150 ms warm. Run it also for a quoted query ("haber gundem"),
--      which must stay as cheap.
--   5. select * from public.search_cluster_ids(array['borsa'], 'borsa', 24);
--      the clusters whose title starts a word with borsa come first (join to
--      clusters and look at title_tr).
--   6. A live-cluster write by service_role succeeds (no 42501): the cluster
--      consumer's next drain is the real test; the log shows no
--      `permission denied for function tayf_search_fold`.
--   7. The index is valid: the invalid-index check above returns 0 rows.
--   8. Write cost (record the baseline BEFORE the pre-build, compare a day after):
--      select left(query, 70) as q, calls, round(mean_exec_time::numeric, 3) as mean_ms from pg_stat_statements where query ilike 'update %clusters%' order by calls desc limit 10;
--      together with the cluster consumer's drain time for the same backlog. The
--      local measurement is about 40 microseconds more per updated live row; a
--      several-fold rise of the article_count/updated_at updates, or a backlog
--      that keeps growing, is the cue for the ROLLBACK block.
--
-- Safe to re-apply: create or replace function, create index if not exists,
-- ledger insert `on conflict do nothing`. Nothing is dropped, altered, updated or
-- deleted. No table is created, so there is nothing to revoke from
-- anon/authenticated and no MAINTAIN block to repeat (095 covered the tables).
--
-- ROLLBACK (the data shape does not change; the app falls back by itself on PGRST202):
--   drop function if exists public.search_cluster_ids(text[], text, integer);
--   drop index concurrently if exists clusters_search_fold_live_idx;
--   drop function if exists public.tayf_search_fold(text);
--   delete from supabase_migrations.schema_migrations where version = '129';
--   notify pgrst, 'reload schema';
-- Run the index drop outside a transaction block. The fold function drop must come
-- after it (the index depends on it). 083's search_cluster_ids(text[], integer)
-- serves the app again once the three-argument one is gone.
--
-- See tests/migrations/129-search-fold-rank.test.ts.

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
     and c.relname = 'clusters_search_fold_live_idx'
     and i.indisvalid = false;
  if v_bad is not null then
    raise exception '129: invalid index left by an aborted CREATE INDEX CONCURRENTLY: %. Run drop index concurrently <name>, then rebuild it (see the ORCHESTRATOR PRE-BUILD block in the header of 129_search_fold_rank.sql).', v_bad;
  end if;
end
$guard$;

-- ---------------------------------------------------------------------------
-- 1. The fold. IMMUTABLE and NOT security definer on purpose: an index
--    expression may only call an immutable function, and the function must run
--    as the writer. search_path is pinned to '' and every name is qualified.
-- ---------------------------------------------------------------------------

create or replace function public.tayf_search_fold(p_text text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select pg_catalog.lower(pg_catalog.translate(p_text, 'İIıŞşĞğÜüÖöÇçÂâÎîÛû' || pg_catalog.chr(775), 'iiissgguuooccaaiiuu') collate pg_catalog."C")
$fn$;

comment on function public.tayf_search_fold(text) is
  'ASCII fold for archive search (migration 129): translate the Turkish and '
  'circumflex letters of migrations 112/125/126 to ASCII and delete U+0307, '
  'then lower() under the C collation so only A-Z is touched and the result '
  'does not depend on the database locale. Backs clusters_search_fold_live_idx '
  'and search_cluster_ids. TypeScript twin: foldTr() in '
  'src/lib/clusters/turkish-query.ts. Immutable, not security definer; '
  'execute for service_role only (every role that writes public.clusters '
  'evaluates it through the index expression).';

revoke all on function public.tayf_search_fold(text) from public, anon, authenticated;
grant execute on function public.tayf_search_fold(text) to service_role;

-- ---------------------------------------------------------------------------
-- 2. The folded index. Partial on the literal live predicate of 083, so it
--    only ever holds the rows the RPC's WHERE clause can accept.
-- ---------------------------------------------------------------------------

create index if not exists clusters_search_fold_live_idx on public.clusters using gin (
    pg_catalog.to_tsvector('pg_catalog.turkish'::pg_catalog.regconfig, public.tayf_search_fold(coalesce(title_tr_neutral, '') || ' ' || coalesce(title_tr, '') || ' ' || coalesce(summary_tr, ''))))
    where not is_archived and article_count >= 2;

-- ---------------------------------------------------------------------------
-- 3. Ranked, folded archive search. New signature (p_folded added): 083's
--    two-argument function stays in place for the PGRST202 fallback.
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
              || pg_catalog.websearch_to_tsquery('pg_catalog.turkish'::pg_catalog.regconfig, coalesce(p_variants[3], p_variants[1], '')) as qv,
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
  ), cand as (
    -- Two independent arms, so a phrase in the variants arm (a quoted query)
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
  ), top as (
    -- Candidate cap: only the 1000 most recently updated hits are scored.
    select k.id from cand k order by k.updated_at desc, k.id limit 1000
  ), hits as (
    select c.id, c.updated_at, c.article_count,
           public.tayf_search_fold(coalesce(c.title_tr_neutral, '') || ' ' || coalesce(c.title_tr, '')) as ftitle
    from top t
    join public.clusters c on c.id = t.id
  )
  select h.id
  from hits h cross join q
  order by 1.0 * pg_catalog.ts_rank_cd(pg_catalog.to_tsvector('pg_catalog.turkish'::pg_catalog.regconfig, h.ftitle), q.qf, 32)::pg_catalog.float8
         + 2.0 * (case when q.lit <> '' and pg_catalog.strpos(' ' || pg_catalog.regexp_replace(h.ftitle, '[^a-z0-9]+', ' ', 'g'), ' ' || q.lit) > 0 then 1 else 0 end)
         + 0.5 / (1.0 + extract(epoch from (pg_catalog.now() - h.updated_at))::pg_catalog.float8 / 604800.0) desc,
         h.article_count desc, h.updated_at desc, h.id
  limit greatest(1, least(coalesce(p_limit, 12), 50));
$fn$;

comment on function public.search_cluster_ids(text[], text, integer) is
  'Ranked, ASCII-folded archive search (migration 129; supersedes 083''s '
  'two-argument function for src/lib/clusters/search-query.ts). Candidates: '
  'live clusters matching search_tsv (p_variants, the en_US spellings of 083) '
  'or the folded index (p_folded = foldTr(query), phrase-free), as two '
  'separate index scans; the 1000 most recently updated candidates are '
  'scored. Order: literal word-start title hits first (weight 2.0), then '
  'title relevance (1.0) plus recency (0.5, 7-day scale); article_count only '
  'breaks ties. Returns ids ONLY. service_role only.';

revoke all on function public.search_cluster_ids(text[], text, integer) from public, anon, authenticated;
grant execute on function public.search_cluster_ids(text[], text, integer) to service_role;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('129', '129_search_fold_rank')
  on conflict do nothing;

commit;
