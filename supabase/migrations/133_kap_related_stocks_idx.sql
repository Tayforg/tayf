-- 133_kap_related_stocks_idx.sql
--
-- One GIN index on public.kap_disclosures (related_stocks). Additive, one
-- transaction, no route change here (the readers change in the same release),
-- nothing granted, no data written. No new table, so no revoke block.
--
-- WHY (hunt 11, finding h11-finance-1, 2026-11-01). KAP tags a notice for a
-- ticker in one of two columns: stock_codes (the issuer, indexed by
-- kap_disclosures_stock_codes_idx since 049) and related_stocks (a share the
-- notice names without being filed by it: Borsa Istanbul's "Pay Islem Sirasi
-- Kapatma / Acma" trading halts, SPK trading bans, "Pay Alim Satim Bildirimi"
-- insider trades). Every per-ticker reader filtered stock_codes alone, so
-- 556 of 8,098 disclosures in 30 days (6.9 %) never reached /ekonomi/<ticker>:
-- disclosure 1688666 (28.10 09:38, halt of TRHOL, related_stocks {TRHOL}) is
-- why /ekonomi/TRHOL showed "192,00 son islem 27.10.2026" with no word about it.
--
-- The readers (src/lib/finance/disclosure-filter.ts, used by queries.ts and
-- kap-pickup-query.ts and the /ekonomi/[ticker] existence probe) now send ONE
-- PostgREST filter, which PostgREST compiles to
--     (stock_codes @> '{T}' OR related_stocks @> '{T}')
--       AND (subject IS NULL OR subject NOT ILIKE '%Devre Kesici%')
-- Without an index on related_stocks that OR cannot become a BitmapOr: the
-- planner has to scan. 133 is therefore a prerequisite of the code change.
--
-- DEPLOY ORDER (a hard, blocking requirement, not a preference): run the
-- ORCHESTRATOR PRE-BUILD below, run the invalid-index check, apply 133 and
-- confirm indisvalid = true BEFORE MERGING the PR that ships the readers.
-- Vercel deploys on merge, so there is no window between merge and release in
-- which to apply it afterwards. State this as a blocking step in the PR body.
-- Why it cannot be done later (read-only EXPLAIN on production, 2026-11-01,
-- before 133 exists; nothing was executed):
--   * The existence probe in src/app/ekonomi/[ticker]/page.tsx
--     (kap_disclosures ... .or(tickerDisclosureOr(t)).limit(1), no published_at
--     bound) for a well-formed code with no bist_companies row plans as
--     Limit -> Seq Scan on kap_disclosures (cost 28,886, 215 MB, 208k rows).
--     Any anonymous visitor reaches it: /ekonomi/ZZZQ1, /ekonomi/ZZZQ2, ... pass
--     the middleware shape check, are uncached, and each forces a full scan of a
--     table about the size of the 256 MB shared_buffers of the Micro tier, which
--     pushes the hot pages out. READER_TIMEOUT_MS (4 s) only aborts the client
--     fetch; the query keeps running server-side until PostgREST's 8 s
--     statement_timeout.
--   * The per-ticker list for a rare ticker (fetchRecentDisclosures, no date
--     bound) walks kap_disclosures_published_idx backward and filters every row.
--   Before this change the same reads were served by the GIN index on stock_codes.
-- The other readers changed in the same release (fetchTickerPage's list and
-- count, fetchTickerPickup, /api/v1/kap/pickup with `since` clamped to 90
-- days) are bounded by published_at and use kap_disclosures_published_idx, so
-- they do not need 133 to stay cheap. The probe and fetchRecentDisclosures do.
-- Keeping the old indexed `stock_codes @> T` probe as a first step would not
-- help: an unknown code matches neither column, so the related_stocks probe
-- still runs. The index is the fix, so it lands first.
--
-- The contract is pinned by tests/migrations/133-kap-related-stocks-idx.test.ts
-- (it reads disclosure-filter.ts and checks the column it filters on) and
-- tests/guards/kap-related-stocks.test.ts (no `.contains("stock_codes", ..)`
-- reader may come back).
--
-- STEP 0 -- read-only measurements on production (2026-11-01, PostgreSQL 17).
--
--   1. Related-only share over the last 30 days:
--        count(*) filter (where stock_codes = '{}' and related_stocks <> '{}')
--        = 556 of count(*) = 8,098 (6.9 %). The hunt's earlier read of the same
--        window was 560 of 8,121; the window slides. In the hunt's 560 the
--        subjects were 336 "Pay Alim Satim Bildirimi", 37 "Temerrut Islemi", 23
--        BISTECH announcements, 18 KAP announcements, ...
--
--   2. Halt wording. The subject of both ends of a halt is the same,
--      "Pay Islem Sirasi Kapatma / Acma"; only the summary tells them apart
--      (100+ notices since 2024): "Pay Sirasinin Isleme Kapatilmasi" (46),
--      "Pay Siralarinin Isleme Kapatilmasi" (10) and "Pay Sirasinin Gecici Olarak
--      Isleme Kapatilmasi" (1) close; "Pay Sirasinin Isleme Acilmasi" (54) and
--      "Pay Siralarinin Isleme Acilmasi" (2) reopen; one filing says "Kapatilmasi
--      ve Acilmasi" (1, not a halt). 1688666 (TRHOL) and 1688651 (TERA), both
--      28.10 and both closings, have stock_codes '{}'.
--      (The real texts carry the Turkish letters; they are ASCII-folded here only
--      so this header stays plain.)
--
--   3. ISMEN, last 30 days, stock_codes OR related_stocks: 104 disclosures, 102
--      without circuit-breaker notices (stock_codes alone: 95 and 93; 9 are
--      related_stocks-only). The page lists the newest 60.
--
--   4. pg_indexes for public.kap_disclosures (3 indexes):
--        kap_disclosures_pkey            btree (disclosure_index), unique
--        kap_disclosures_published_idx   btree (published_at desc)
--        kap_disclosures_stock_codes_idx gin (stock_codes)
--      Nothing indexes related_stocks, and the new name is free.
--
--   5. Size: pg_total_relation_size(public.kap_disclosures) = 215 MB (198 MB
--      heap), 208,743 rows, 67,419 of them with a non-empty related_stocks.
--
--   6. select version from supabase_migrations.schema_migrations where version
--      = '133'  ->  0 rows. (The ledger is supabase_migrations.schema_migrations.)
--
-- LOCAL PROOF (PostgreSQL 15.12, throwaway cluster on 127.0.0.1; stub.sql, then
-- the kap_disclosures DDL and its indexes copied from 049 (subject_idx dropped:
-- production has none), then 50,003 seeded rows: 6.8 % related-only, 31.7 % with
-- a non-empty related_stocks, 730 days of published_at, ~626 tickers plus the
-- TRHOL / TERA halts of Step 0).
--   Query shapes (as PostgREST sends them): (a) fetchRecentDisclosures(40,
--   'TRHOL'), no date bound, order by published_at desc limit 40; (b) the
--   existence probe for an unknown ticker, limit 1; (c) the 30-day list of
--   fetchTickerPage.
--   BEFORE 133: (a) Seq Scan on kap_disclosures, Rows Removed by Filter: 50001,
--       Buffers: shared hit=1001, 14.8 ms. (b) Seq Scan, Rows Removed by Filter:
--       50003, 15.0 ms. (c) Bitmap Heap Scan on kap_disclosures_published_idx
--       with Rows Removed by Filter: 2147 of 2149 candidates, 1.5 ms (it only
--       stays cheap because the date bound is selective; with enable_seqscan =
--       off it picks the same plan, there is no OR index to use).
--   AFTER 133, default planner AND enable_seqscan = off give the same plan for
--       (a), (b) and (c): BitmapOr over Bitmap Index Scan on
--       kap_disclosures_stock_codes_idx (stock_codes @> '{TRHOL}') and Bitmap
--       Index Scan on kap_disclosures_related_stocks_idx (related_stocks @>
--       '{TRHOL}'), then Bitmap Heap Scan (Heap Blocks: exact=1) with the
--       breaker clause as the Filter; (a) 0.046 ms, buffers 10 (against 1,004);
--       (b) 0.016 ms, buffers 6; (c) 0.040 ms.
--   Sizes: related_stocks index 184 kB at 50,003 rows (544 kB at 208,003
--       rows, the production row count), stock_codes index 1,280 kB. Build time
--       18.7 ms (50,003 rows) and 77 ms (208,003 rows) locally, on a table
--       without production's raw jsonb weight, so expect seconds, not
--       milliseconds, there.
--   Apply #1 (ledger had no row 133): BEGIN, SET, SET, DO, CREATE INDEX, INSERT
--       0 1, COMMIT. Apply #2: NOTICE relation "kap_disclosures_related_stocks_idx"
--       already exists, skipping, CREATE INDEX, INSERT 0 0, COMMIT; one ledger
--       row for 133.
--   Rehearsals: with the index forced to indisvalid = false (local superuser),
--       the invalid-index check below returned the index name and apply stopped
--       in step 0 with "133: invalid index left by an aborted CREATE INDEX
--       CONCURRENTLY: kap_disclosures_related_stocks_idx. Run drop index
--       concurrently <name>, then rebuild it ...", and the ledger stayed
--       untouched (0 rows for 133); restored, apply went through. With the
--       index dropped and rebuilt by the ORCHESTRATOR PRE-BUILD statement below
--       (taken verbatim from this file, autocommit), the invalid-index check
--       returned 0 rows and apply printed the "already exists, skipping" notice
--       and INSERT 0 1. anon and authenticated hold no grants on kap_disclosures
--       before or after.
--
-- ORCHESTRATOR PRE-BUILD (run standalone, outside a transaction, before applying 133)
-- Build the index with CREATE INDEX CONCURRENTLY so KAP ingest keeps writing
-- kap_disclosures; 133 then sees it and its own `create index if not exists`
-- does nothing. Run it once, in psql autocommit (not inside begin/commit):
--
--   create index concurrently if not exists kap_disclosures_related_stocks_idx on public.kap_disclosures using gin (related_stocks);
--
-- A failed or cancelled CONCURRENTLY build leaves an INVALID index behind, and
-- `create index if not exists` would then skip it silently. Check before
-- applying (expect 0 rows):
--
--   select c.relname from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid = i.indexrelid where c.relname in ('kap_disclosures_related_stocks_idx') and not i.indisvalid;
--
-- 133 itself re-checks (indisvalid = false) and aborts with a message telling
-- you to `drop index concurrently <name>` and rebuild.
--
-- If the pre-build was skipped, 133 builds the index inside its transaction.
-- That scans the whole 215 MB table under a SHARE lock that blocks writes to
-- kap_disclosures, so 133 starts with `set local lock_timeout = '5s'` and `set
-- local statement_timeout = '60s'`: a skipped pre-build that cannot finish in
-- 60 s aborts the whole migration with 57014 (query_canceled) instead of
-- blocking ingest, and nothing is recorded in the ledger. Build it concurrently
-- and re-apply. A 55P03 (the 5 s lock_timeout) only means the table was busy;
-- re-apply.
--
-- Write cost: related_stocks is on the insert path of kap-ingest. A GIN index on
-- a column that is an empty array for two thirds of the rows adds nothing for
-- those rows, and the table takes a few hundred inserts a day.
--
-- VERIFY (read-only, after applying):
--   1. explain (analyze, buffers) select disclosure_index from public.kap_disclosures where ((stock_codes @> '{TRHOL}' or related_stocks @> '{TRHOL}') and (subject is null or subject not ilike '%Devre Kesici%')) order by published_at desc limit 40;
--      expect a BitmapOr over kap_disclosures_stock_codes_idx and
--      kap_disclosures_related_stocks_idx, no Seq Scan, buffers in the tens.
--   2. select indexrelid::regclass, indisvalid from pg_index where indexrelid = 'public.kap_disclosures_related_stocks_idx'::regclass;
--      expect indisvalid = true. This is the merge gate: do not merge the PR
--      until this returns a row with indisvalid = true.
--   3. https://www.tayfhaber.com/ekonomi/TRHOL shows "Islem sirasi kapatildi"
--      next to "son islem" (the Turkish wording is in the page) once the
--      readers ship.
--
-- Safe to re-apply: create index if not exists, ledger insert `on conflict do
-- nothing`. Additive: nothing is dropped, granted, analyzed or written, and no
-- grants are touched (anon and authenticated have no table grants since 117).
--
-- ROLLBACK (nothing here changes data shape; roll the readers back first, or
-- the OR filter falls back to scanning):
--   drop index concurrently if exists kap_disclosures_related_stocks_idx;
--   delete from supabase_migrations.schema_migrations where version = '133';
--
-- See tests/migrations/133-kap-related-stocks-idx.test.ts.

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
     and c.relname in ('kap_disclosures_related_stocks_idx')
     and i.indisvalid = false;
  if v_bad is not null then
    raise exception '133: invalid index left by an aborted CREATE INDEX CONCURRENTLY: %. Run drop index concurrently <name>, then rebuild it (see the ORCHESTRATOR PRE-BUILD block in the header of 133_kap_related_stocks_idx.sql).', v_bad;
  end if;
end
$guard$;

-- ---------------------------------------------------------------------------
-- The per-ticker KAP readers match
--   stock_codes @> '{T}' OR related_stocks @> '{T}'
-- (src/lib/finance/disclosure-filter.ts). stock_codes has had its GIN index
-- since 049; related_stocks had none, so the OR could not become a BitmapOr.
-- ---------------------------------------------------------------------------

create index if not exists kap_disclosures_related_stocks_idx on public.kap_disclosures using gin (related_stocks);

insert into supabase_migrations.schema_migrations (version, name)
  values ('133', '133_kap_related_stocks_idx')
  on conflict do nothing;

commit;
