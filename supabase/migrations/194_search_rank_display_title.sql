-- 194_search_rank_display_title.sql
--
-- Archive search ranks on the title a reader sees, and stops rewarding repetition. ONE function is replaced, with the same signature:
-- public.search_cluster_ids(p_variants text[], p_folded text, p_limit integer default 12). The body is 186's body with a new
-- ORDER BY and what it reads: a new CTE (lw, the typed words as word-start prefixes), two new columns of hits (dfold and lit_d)
-- with their two laterals. The candidates (the variants arm, the folded arm, 186's stem-fold arm), 166's guard, 172's lit_ok tier,
-- the 1000-row cap, the limit, the grants and the id set of every query are 186's, byte for byte. No table, column, index, trigger,
-- cron job or data change; 083's two-argument function (the PGRST202 fallback of src/lib/clusters/search-query.ts) is not touched;
-- no app change (h116-search-1, hunt 116, 2026-11-11). This file takes the number 194: 191 is reserved and not applied, 192 and 193
-- are applied.
--
-- WHY (evidence: production, read-only, 2026-11-11 05:59-06:09Z, the live pg_get_functiondef and the checkout at 6c49f9c)
--   * GET /?q=emekli%20maaşı (the query "emekli maaşı") shows "en ilgili 24 sonuç", all archive rows. Slots 16-24 hold 7 stories that are 103-198 days old with
--     2-5 sources (38a4e019 197 d, d81a0476 110 d, b4a6af9f "Atama ve görevden alma kararları" 103 d, which has no 'emekli' in its
--     display title). A SQL search of clusters updated in the last 14 days with at least 3 articles and a folded title matching
--     'emekli maas' finds 17 stories; 7 of them are missing from the 24, all 2-8 days old with 3-9 sources (fb3eb5fa 9, 3ef4c966 7,
--     7e642fbc, e548b72b, aef19bf3 4 each, 68b223a8 and 93de7c0a 3 each). Their titles use the plural, maaşları / maaşlarına.
--   * GET /?q=deprem: all 24 rows are archive rows, 0 in the feed. 15 are the daily SEO cluster "Depremler. Deprem mi oldu? <tarih>"
--     or similar boilerplate; rows 16, 17 and 19 are 165, 166 and 201 days old. Rows 1-2 are the Orban and Hegseth stories, whose
--     display titles have no 'deprem' (only the hidden title_tr holds "siyasi deprem!" and "İran savaşı depremi"). Missing from the
--     list: a6874bad "Ege Denizi'nde 4,7 büyüklüğünde deprem" (10 sources, 12 d), 186b2212 (10, 12 d), 7cd89244 (13, 15 d), ce9d2fa5
--     (6, 6 d), 31b0354f (6, 16 d), 9a4f9d57 (5, 11 d).
--   * The code (186's final ORDER BY): the lit_ok tier, then 1.0 * ts_rank_cd(to_tsvector('turkish', ftitle), qf, 32) + 2.0 * [the
--     typed folded phrase starts a word of ' ' || ftitle with its non-[a-z0-9] runs turned into spaces] + 0.5 / (1 + age / 7 d).
--     Two defects. (1) ftitle is the fold of title_tr_neutral || ' ' || title_tr, so the hidden outlet headline counts in the
--     literal tier, and the phrase is the TYPED surface form, a word-start prefix: 'emekli maasi' never meets 'emekli maaslari'.
--     A 165-day-old Muğla boilerplate scores 2.0 + 0.375 + 0.020, the 10-source Ege story of 12 days 2.0 + 0.091 + 0.184.
--     (2) ts_rank_cd rewards a word repeated in one title, which is what the boilerplate titles do.
--   * Distinct from h96-search-1 / h96-search-2 (zero-result and ASCII recall) and h96-rejected-5 (the 24 cap): the page is full
--     here and only its ORDER is wrong. 194 merges the hunter's search-1 (literal tier), search-2 (ts_rank_cd repetition) and the RPC
--     half of search-3 (the hidden original headline).
--
-- WHAT
--   Same candidates, new order. lw (new CTE between top and hits): the [a-z0-9] words of the g0 tokens (166's whitespace tokens of the
--   folded query, negated ones left out), each cut to the prefix left(w, greatest(least(length(w), 4), length(w) - 2)) and kept
--   distinct: maasi -> maas, emekli -> emek, imamoglu -> imamog, deprem -> depr, ozel -> ozel. A Turkish suffix after the root still
--   starts with the prefix (maaslari, imamoglunun), so inflection never decides the tier. lw is empty when a g0 token, stripped of
--   its non-[a-z0-9] characters, is 'or', or when the query holds a negated phrase (-"): 166's two switches, as in gx, so an alias,
--   OR or negated-phrase query gets no literal tier, as under 186 (a word typed only inside an exclusion never lifts a row).
--   hits gains two columns: dfold, the DISPLAY title folded once per row (lateral d: coalesce(nullif(btrim(title_tr_neutral), ''),
--   title_tr), the text a reader sees on the card; the hidden outlet headline is not in it), and lit_d: lw is not empty and EVERY
--   lw prefix starts a word of the display title (lateral dn: ' ' || the [a-z0-9] words of dfold; a word start is ' ' || prefix).
--   lit_d is order-free, needs every word, and reads the display title only. lit_ok and ftitle are untouched: 172's tier still reads
--   the folded neutral || original title, and is still the first ORDER BY key.
--   rel_d = least(ts_rank_cd(to_tsvector('pg_catalog.turkish', dfold), qf, 32), 0.2) / 0.2: relevance of the display title,
--   saturating at 0.2: under normalization 32 one hit gives about 0.09 (+0.14 after the 0.3 weight), two give 0.17 (+0.25), three or
--   more the cap 0.2 (+0.30), so repetition is capped at about +0.16 (about 2 days of recency for a fresh story, more for an older
--   one) instead of growing without limit.
--   The ORDER BY: (case when lit_ok then 0 else 1 end), then
--       2.0 * lit_d + 0.3 * rel_d + 1.0 / (1.0 + age / 14 days) + 0.15 * ln(least(greatest(article_count, 1), 50)) desc,
--   then article_count desc, updated_at desc, id. 14 days = 1209600 s. The limit stays greatest(1, least(coalesce(p_limit, 12), 50)).
--   The old weights 1.0 * rel + 2.0 * literal + 0.5 / (1 + age / 7 d) become 2.0 * literal + 0.3 * rel (saturating) + 1.0 on a
--   14-day scale + a corroboration term; with them a story with the typed words in its title and 9 sources from last week
--   (2.0 + 0.3 + 0.74 + 0.33) outranks a 197-day-old story with the same words and 2 sources (2.0 + 0.3 + 0.07 + 0.10), and
--   a row without the words in its display title can never outrun one with them on recency or corroboration alone (the largest
--   non-literal sum is about 1.0 + 0.3 + 0.59 = 1.9 < 2.0).
--   The parity property: the score is a function of p_folded and the title only (lw reads g0, rel_d reads qf, both from p_folded; p_variants never
--   enters it), so a Turkish query and its ASCII fold, sent with the same p_folded, score a shared candidate the same way and order
--   it the same way. Ranking never changes recall: every call returns the same id set as 186 (the candidates, the guard, the
--   1000-row cap and the limit are untouched, and only the order of the survivors changes).
--   Patterns stay constants: the words go only through left() and strpos(), never into a regex pattern; the three regexp calls the
--   file adds have the constant pattern '[^a-z0-9]+', and the old ORDER BY's regexp call over h.ftitle is gone.
--
-- BASE
--   The base is 186's body (md5 973e3707e98448b0385bd0402c039df3, length 14850; the test recomputes it). It is the body production runs (STEP 0).
--   This file is complete on its own: it replaces whichever body is installed with the one below, and it needs no object that 186
--   created beyond what its own candidates read (tayf_search_fold of 129, tayf_search_stem_fold and clusters_search_stemfold_live_idx
--   of 186), so apply 186 first; 191 (reserved, not applied) and 192 / 193 are unrelated. Application: no app change, no deploy
--   order. The proacl of the function stays {postgres=X/postgres,service_role=X/postgres}.
--
-- STEP 0 (read-only, production, 2026-11-11 about 06:15Z)
--   select md5(prosrc), length(prosrc), proacl::text, prosecdef, provolatile, proconfig::text from pg_proc
--    where oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure
--   -> 973e3707e98448b0385bd0402c039df3, 14850, {postgres=X/postgres,service_role=X/postgres}, t, s, {search_path=""}: the body of
--   186 in the repository, md5 and length equal. clusters.title_tr is NOT NULL and title_tr_neutral is nullable on production, so
--   coalesce(nullif(btrim(title_tr_neutral), ''), title_tr) is never null.
--
-- REPLAY (production, SELECT only through sbq.py in a read-only transaction, 2026-11-11 about 06:25-06:45Z)
--   The two bodies ran inline as plain SELECTs, with literal arguments exactly as src/lib/clusters/search-query.ts builds them
--   (turkishQueryVariants, foldTr, the alias expansion; one typed call, p_limit 24 = SEARCH_LIMIT), 186's body and this file's body in
--   the same session. First check, every query: 186's inline top 24 equals the top 24 of the live RPC itself (same ids, same order).
--   Second check, every query: with the limit clause removed (every scored candidate, up to the 1000-row cap), the id set of 186's
--   body and of 194's body is IDENTICAL (counts below). The new top 24 equals, id for id and order for order, the scratch prototype
--   ('new2' of the adjudicator's replay script) on the same data for emekli maaşı, deprem, İmamoğlu, Hegseth, seçim sonucu, Özgür Özel.
--   query (typed)        candidates  shared of 24   median age (d)    rows > 60 d    median articles
--   emekli maaşı           89 = 89       15          9.25 -> 6.70       8 -> 0           3 -> 3
--   deprem                435 = 435      11         16.50 -> 11.80      3 -> 0           2 -> 6
--   asgari ücret           41 = 41       23         14.85 -> 14.85      7 -> 7          2.5 -> 2
--   İmamoğlu              600 = 600      19          2.75 -> 2.90       0 -> 0           3 -> 3
--   imamoglu              600 = 600      19          2.75 -> 2.90       0 -> 0           3 -> 3
--   Merkez Bankası         67 = 67       22         55.10 -> 73.75     11 -> 13          3 -> 3
--   enflasyon             176 = 176      17         32.90 -> 29.45      4 -> 4          3.5 -> 5
--   Gazze                 481 = 481      22          4.00 -> 4.00       0 -> 0           3 -> 3
--   akp (alias)          1000 = 1000     11          0.90 -> 1.30       0 -> 0           2 -> 5
--   akp or "ak parti"    1000 = 1000     11          0.90 -> 1.30       0 -> 0           2 -> 5
--   seçim sonucu          264 = 264      10          6.95 -> 6.85       3 -> 0           3 -> 3
--   Hegseth                65 = 65       21          0.95 -> 1.35       0 -> 0           3 -> 3
--   Özgür Özel           1000 = 1000     15          2.90 -> 4.05       0 -> 0           4 -> 9
--   (the akp alias and the raw OR query have no literal tier and no lw row, so their order is recency and corroboration only; the
--   1000 is the scoring cap of both bodies.)
--   Acceptance targets of the spec against the measurements above:
--   * emekli maaşı: 6 of the 7 missing stories are in the new top 24 (aef19bf3 at 6, fb3eb5fa 7, 68b223a8 8, 7e642fbc 12, e548b72b
--     17, 93de7c0a 22; 3ef4c966, whose title has no 'emekli maaşı', is not): target at least 5 MET; rows older than 60 d 8 -> 0, the
--     oldest row of the page is 22.8 d: target 0 MET.
--   * deprem: a6874bad (7), 186b2212 (8), 9a4f9d57 (10), 31b0354f (16), 7cd89244 (9) and ce9d2fa5 (4) are all in the new top 24:
--     target MET. "Depremler. / deprem mi oldu" rows 15 -> 4 (target at most 6) MET. The top 3 carry 'deprem' in the display title
--     (Beykoz "istifa depremi", Bakan Çiftçi "Deprem bölgesindeki", "deprem davalarına"): MET. The Orban and Hegseth rows left
--     the page; rows older than 60 d 3 -> 0.
--   * seçim sonucu: rows older than 60 d 3 -> 0: target MET.
--   * İmamoğlu and imamoglu: the same list in the same order (50 of 50 shared at p_limit 50, before and after): target MET. Parity
--     also holds for asgari ücret / asgari ucret, Merkez Bankası / merkez bankasi, Özgür Özel / ozgur ozel and Gazze / gazze (the
--     identical list), and for emekli maaşı / emekli maasi, whose candidates differ (the variants arm stems 'maaşı' and 'maasi'
--     apart: 186's recall, unchanged) while the 26 shared ids of the top 50 come in the same relative order.
--   * Hegseth, İmamoğlu, Özgür Özel: 21, 19 and 15 of 24 ids shared with today (target at least 15 MET). Median age no worse than
--     +1 d: Hegseth +0.40 d and İmamoğlu +0.15 d MET; Özgür Özel +1.15 d (2.90 -> 4.05 d) is 0.15 d OVER the target. The new list is the
--     spec's own prototype's list on the same data (checked above), so this is the spec'd ORDER BY on today's data (stories with more
--     sources now outrank fresher ones: median articles 4 -> 9), not an implementation difference; the weights were not tuned.
--   * Merkez Bankası (no target in the spec): median age 55.10 -> 73.75 d. The pool is only 67 stories and few are fresh; the old
--     top 24 led with 'ECB başkanlığı seçiminin ...' (1.8 d) and 'Yeni dönemin ilk gününde Karahan'dan Meclis'e sunum' (37 d),
--     whose display titles do not hold the phrase, so they lost the hidden-headline tier and the rows with the phrase moved up.
--   EXPLAIN ANALYZE, see COST. After deploy: GET /?q=emekli%20maaşı and /?q=deprem at one request per second should agree with the
--   replay above (the pages are cached per query key; the ids move as clusters update).
--
-- COST (EXPLAIN (ANALYZE), 186's body against 194's, inline, the SAME arguments, alternated, one warm-up each, medians of 5, ms,
--   production, 2026-11-11 about 06:40Z; the spec's gate is +20%). The new body measured 0.84x to 0.96x of 186's on every query,
--   far inside the gate (the ORDER BY folds the display title once per scored row, at most 1000, in two laterals):
--   deprem 49.40 -> 41.26 (0.84x)   emekli maaşı 12.40 -> 11.39 (0.92x)   asgari ücret 7.46 -> 7.02 (0.94x)
--   İmamoğlu 67.80 -> 59.01 (0.87x)   imamoglu 66.46 -> 57.68 (0.87x)   Merkez Bankası 9.40 -> 9.00 (0.96x)
--   enflasyon 20.96 -> 18.23 (0.87x)   Gazze 55.39 -> 47.61 (0.86x)   akp (alias) 141.98 -> 125.07 (0.88x)
--   The plans are 186's (the three index scans under one HashAggregate); only the sort key expression changed.
--
-- KNOWN LIMITS
--   (1) The literal tier is a 4-letter-or-longer word-start prefix: 'deprem' (prefix 'depr') also meets a title that starts a word
--       with 'depr' (a 'depresyon' headline whose summary mentions a deprem). It never changes the id set, and only a candidate
--       can be tiered. (2) A candidate that holds the words only in its summary, or only in the hidden original headline (the
--       Orban story), gets no literal tier and ranks by relevance, recency and corroboration below the rows that carry them in the
--       shown title; it is still returned. That is the point of the change. (3) lw mirrors both of gx's switches (a token `or`, and
--       a negated phrase -"), so such a query gets no literal tier and is ordered by relevance, recency and corroboration, as under
--       186, whose contiguous typed string no candidate can hold. Without the second switch the words after the first of a negated
--       phrase would be required in the display title, and a row holding them would gain +2.0 from a word the reader excluded. (4) The corroboration term is the cluster's article_count: a long-running story with many outlets keeps
--       a lead over a fresher two-outlet story that holds the same words (Özgür Özel +1.15 d above, median articles 4 -> 9; iran
--       3 -> 8). (5) 172's lit_ok tier is untouched and still the first key. (6) The 1000-row candidate cap is 185's.
--
-- LEDGER: this file records version 194 in supabase_migrations.schema_migrations itself, idempotently (the 095 pattern: insert ...
-- on conflict do nothing, last statement before commit), so applying it by posting the SQL (management API or psql) leaves
-- `supabase migration list` correct; `supabase db push` records the same row. Re-applying is harmless (create or replace function,
-- and the ledger insert does nothing the second time).
--
-- VERIFY (read-only, after applying)
--   1. select md5(p.prosrc), length(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
--      expect 53eddcee85dc444ef0e24ad7087f5b00, 18894.
--   2. select p.prosecdef, p.provolatile, pg_catalog.has_function_privilege('anon', p.oid, 'execute'), pg_catalog.has_function_privilege('authenticated', p.oid, 'execute'), pg_catalog.has_function_privilege('service_role', p.oid, 'execute'), p.proacl::text from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
--      expect t, s, false, false, true, {postgres=X/postgres,service_role=X/postgres}.
--   3. select version, name from supabase_migrations.schema_migrations where version = '194'; expect one row.
--   4. the id set is unchanged: 186's body and this body, run inline with the limit clause removed for array['deprem'] / 'deprem',
--      return the same ids (435 each on 2026-11-11; the count moves with the data).
--   5. GET /?q=emekli%20maaşı and /?q=deprem (one request per second): no row older than 60 days on the first, the six stories named
--      in REPLAY on the second, the daily "Depremler. Deprem mi oldu?" rows at most 4 of 24; /?q=İmamoğlu and /?q=imamoglu list the
--      same stories in the same order; explain (analyze) of the body for deprem stays within +20% of 186's (about 49 ms).
--
-- Safe to re-apply: create or replace function, ledger insert `on conflict do nothing`. Nothing is dropped, altered, updated or
-- deleted.
--
-- ROLLBACK (the data shape does not change; the app does not depend on 194): re-run the function statement AND the
--   `comment on function public.search_cluster_ids(text[], text, integer)` statement of 186_search_stem_fold_arm.sql (restores
--   md5(prosrc) 973e3707e98448b0385bd0402c039df3, length 14850), then
--     delete from supabase_migrations.schema_migrations where version = '194';
--     notify pgrst, 'reload schema';
--   186's helper, index and arms are not involved; 083's search_cluster_ids(text[], integer) and the app's PGRST202 fallback are not
--   involved.
--
-- See tests/migrations/194-search-rank-display-title.test.ts and tests/migrations/sql/194-search-rank-display-title-dryrun.sql.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Ranked, folded archive search: 186's body with a new ORDER BY (lw, two hits columns and their laterals, the final select).
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
  ), lw as (
    -- 194: the words of the typed query as word-start prefixes, for the literal tier of the ORDER BY (lit_d). The
    -- [a-z0-9] words of the folded query tokens (g0, 166's whitespace tokens without the negated ones), each cut to
    -- left(w, greatest(least(length(w), 4), length(w) - 2)): the word itself up to 4 letters, else all but its last
    -- two. A Turkish suffix after the root then still starts with the prefix: maasi (5) is maas and meets maaslari,
    -- emekli (6) is emek, imamoglu (8) is imamog and meets imamoglunun, ozel (4) stays ozel. select distinct: a
    -- word typed twice is one row. lw is EMPTY when a token is `or` (166's own switch: the alias expansion joins
    -- its spellings with ' or ') OR when the query holds a negated phrase (-"), gx's second switch, so an alias, an OR or a
    -- negated-phrase query gets no literal tier, as under 186. Without the second switch the words after the first of a negated
    -- phrase (iran -"israil saldirisi" leaves saldiri) would be required in the title, and a row holding them would gain +2.0
    -- from a word the reader excluded. The patterns are constants with no backslash; the words only go through left() and
    -- strpos(), never into a regex pattern.
    select distinct pg_catalog.left(s.w, greatest(least(pg_catalog.length(s.w), 4), pg_catalog.length(s.w) - 2)) as pre
    from g0
    cross join lateral pg_catalog.regexp_split_to_table(g0.tok, '[^a-z0-9]+') as s(w)
    where s.w <> ''
      and not exists (select 1 from g0 o where pg_catalog.regexp_replace(o.tok, '[^a-z0-9]+', '', 'g') = 'or')
      and not exists (select 1 from f0 where pg_catalog.strpos(f0.ff, '-"') > 0)
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
           not exists (select 1 from ge where not ((pg_catalog.strpos(' ' || a.t, ' ' || ge.w) > 0 or (pg_catalog.strpos(a.t, ge.w) > 0 and pg_catalog.strpos(' ' || pg_catalog.regexp_replace(a.t, '[^a-z0-9]+', ' ', 'g'), ' ' || ge.w) > 0)) or (pg_catalog.strpos(' ' || b.s, ' ' || ge.w) > 0 or (pg_catalog.strpos(b.s, ge.w) > 0 and pg_catalog.strpos(' ' || pg_catalog.regexp_replace(b.s, '[^a-z0-9]+', ' ', 'g'), ' ' || ge.w) > 0)))) as lit_ok,
           -- 194: dfold is the DISPLAY title folded once per row (lateral d below): the neutral title when it has text,
           -- else the original one, which is the text a reader sees on the card. ftitle (with the hidden outlet headline)
           -- stays what lit_ok reads; the ORDER BY no longer reads it.
           d.f as dfold,
           -- 194 lit_d, the literal tier of the ORDER BY: lw is not empty and EVERY lw prefix starts a word of the display
           -- title (dn.n, a word start is ' ' || prefix). Order-free, needs every word, reads the display title only, and
           -- depends on p_folded and the title alone, so a Turkish query and its ASCII fold score a shared row alike.
           (exists (select 1 from lw) and not exists (select 1 from lw where pg_catalog.strpos(dn.n, ' ' || lw.pre) = 0)) as lit_d
    from top t
    join public.clusters c on c.id = t.id
    cross join lateral (select public.tayf_search_fold(coalesce(c.title_tr_neutral, '') || ' ' || coalesce(c.title_tr, '')) as f offset 0) a0
    cross join lateral (select case when exists (select 1 from ge) then pg_catalog.replace(pg_catalog.replace(a0.f, pg_catalog.chr(39), ''), pg_catalog.chr(8217), '') else '' end as t offset 0) a
    cross join lateral (
      select case when exists (select 1 from ge where not (pg_catalog.strpos(' ' || a.t, ' ' || ge.w) > 0 or (pg_catalog.strpos(a.t, ge.w) > 0 and pg_catalog.strpos(' ' || pg_catalog.regexp_replace(a.t, '[^a-z0-9]+', ' ', 'g'), ' ' || ge.w) > 0)))
                  then public.tayf_search_fold(pg_catalog.replace(pg_catalog.replace(coalesce(c.summary_tr, ''), pg_catalog.chr(39), ''), pg_catalog.chr(8217), ''))
                  else '' end as s
      offset 0) b
    -- 194: d folds the display title ONCE per row; dn turns that fold into [a-z0-9] words with a leading space (the 166
    -- idiom), so a word start is ' ' || prefix searched in it. Fenced with offset 0 like a0, a and b.
    cross join lateral (select public.tayf_search_fold(coalesce(nullif(pg_catalog.btrim(c.title_tr_neutral), ''), c.title_tr)) as f offset 0) d
    cross join lateral (select ' ' || pg_catalog.regexp_replace(d.f, '[^a-z0-9]+', ' ', 'g') as n offset 0) dn
  )
  select h.id
  from hits h cross join q
  -- 194 ORDER BY. Key 1 is 172's lit_ok tier, as before. Key 2, one score, all on the display title and the story:
  --   2.0 * lit_d                              every typed word, as a word-start prefix, is in the display title (inflection
  --                                            tolerant, order-free); 186 compared the typed phrase over neutral || original
  --   0.3 * rel_d                              ts_rank_cd of the folded display title, saturating at 0.2 (rel_d = least(r, 0.2) / 0.2),
  --                                            so a word repeated in one title ('Depremler. Deprem mi oldu?') buys at most about +0.16 (one hit +0.14, two +0.25, three or more +0.30)
  --   1.0 / (1 + age / 14 days)                recency; 14 days = 1209600 s
  --   0.15 * ln(least(greatest(count, 1), 50)) corroboration: more outlets, more weight, capped at 50
  -- then article_count, updated_at, id as ties. The weights never touch the candidates, the 166 guard, the 172 tier,
  -- the 1000-row cap or the limit: the id set of a call is 186's.
  order by (case when h.lit_ok then 0 else 1 end),
         2.0 * h.lit_d::pg_catalog.int4
         + 0.3 * (least(pg_catalog.ts_rank_cd(pg_catalog.to_tsvector('pg_catalog.turkish'::pg_catalog.regconfig, h.dfold), q.qf, 32)::pg_catalog.float8, 0.2) / 0.2)
         + 1.0 / (1.0 + extract(epoch from (pg_catalog.now() - h.updated_at))::pg_catalog.float8 / 1209600.0)
         + 0.15 * pg_catalog.ln(least(greatest(h.article_count, 1), 50)::pg_catalog.float8) desc,
         h.article_count desc, h.updated_at desc, h.id
  limit greatest(1, least(coalesce(p_limit, 12), 50));
$fn$;

comment on function public.search_cluster_ids(text[], text, integer) is
  'Ranked, ASCII-folded archive search (migration 129; supersedes 083''s '
  'two-argument function for src/lib/clusters/search-query.ts) with the over-stem '
  'guard of migration 166, the exempt-word tier of migration 172, the sibling '
  'variants of migration 185, the stem-fold arm of migration 186 and the '
  'display-title ranking of migration 194. Candidates: '
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
  'updated survivors are scored. Order (194): the tier first, then one score on the '
  'DISPLAY title (the neutral title, else the original one; the hidden outlet headline '
  'does not count): a literal tier (weight 2.0: every typed word, cut to a word-start '
  'prefix that tolerates a suffix, starts a word of the display title; none for an '
  'alias, OR or negated-phrase query), title relevance (0.3, ts_rank_cd saturating at 0.2), recency '
  '(1.0, 14-day scale) and corroboration (0.15 * ln(least(article_count, 50))); '
  'article_count only breaks ties. The score is a function of p_folded and the title, '
  'so a Turkish query and its ASCII fold rank a shared candidate alike. Ranking never '
  'changes recall: the id set is 186''s. Returns ids ONLY. service_role only.';

revoke all on function public.search_cluster_ids(text[], text, integer) from public, anon, authenticated;
grant execute on function public.search_cluster_ids(text[], text, integer) to service_role;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('194', '194_search_rank_display_title')
  on conflict do nothing;

commit;
