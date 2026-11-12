-- 204_search_single_letter_compounds.sql
--
-- A query with a single-letter hyphen compound (e-devlet, e-okul, e-ticaret, e-imza, e-spor, e-nabız) finds the clusters whose text holds the
-- compound, not the clusters that hold its two halves. One function replaced, additive otherwise: public.search_cluster_ids(p_variants text[],
-- p_folded text, p_limit integer default 12), the same signature. The body is 196's body (the live one: 198 replaced only the helper) with THREE
-- edits: (1) the f CTE gets a column cmp; (2) the q CTE's qf becomes `qf && cmp` and the qs CTE (the stem arm's query) is built from the
-- compound-free query and then `&& cmp`; (3) the lw CTE (the literal tier) ignores one-letter words, of a compound query only. The variants arm, the guard, 172's tier, 194's
-- ORDER BY, the 1000-row cap, the limit, the grants and the helper are 196's and 198's, byte for byte. No table, column, index, trigger, cron job or
-- data change; 083's two-argument function (the PGRST202 fallback of src/lib/clusters/search-query.ts) and public.tayf_ascii_inflection_expand are
-- not touched. h144-search-2 (hunt 144, 2026-11-12). This file takes the number 204: 197 is held on another branch (hunt-129-db197), 202 is
-- reserved on a held branch and 203 is the price_at worker of the same batch. No app change.
--
-- WHY (evidence: production, read-only, 2026-11-12 about 03:45-04:35Z, the live pg_get_functiondef and the checkout at bdba237)
--   * websearch_to_tsquery('turkish','e-okul') is 'e-okul' <-> 'e' <-> 'okul' (a phrase of the compound and its two halves) and to_tsvector('turkish',
--     'e-Okul sistemi MEB''e') holds 'e', 'e-okul' and 'okul': the parser stores the compound AND its halves, and 'e' once more for every apostrophe
--     dative (MEB'e = meb + e). The variants arm reads that phrase and is right. The folded arm and the stem arm are not:
--     196's f CTE turns the hyphen between two letters into a space for the folded arm (regexp_replace(f0.ff, '"|(?<=[a-z0-9])-(?=[a-z0-9])', ' '),
--     which is right for iran-israil and chp-mhp) so 'e-okul' reads 'e okul' and qf is e & okul; qs is derived from qf's text, so the stem arm reads the
--     same two words. Any cluster with MEB'e and okul in it is a candidate. The literal tier has the same flaw: its prefix of the word e is the single
--     letter e (lw cuts a word to itself up to 4 letters), which starts any word of a display title that begins with e.
--   * GET /?q=e-okul says 'en ilgili 24 sonuç' and its first three cards are 1da586db (an Italian school-threat story, 'e-postayla ... okul tehdidine'),
--     b468056d ('300 okul tahliye edildi') and c859c91b ('okulların onarılması'); GET /?q=e-imza says 'en ilgili 24 sonuç' although no story holds the word.
--   * True matches (live clusters with article_count >= 2, search_tsv @@ websearch_to_tsquery('turkish', ...)): e-okul 10, e-devlet 56, e-ticaret 5,
--     e-nabız 5, e-imza 0, e-spor 0. The candidates of 196 on the same arguments: e-okul 74, e-devlet 234, e-ticaret 55, e-imza 48, e-nabız 6, e-spor 29.
--   * '''e-okul'''::tsquery is one lexeme, and (e & okul) && '''e-okul'''::tsquery returns exactly the 10 clusters. to_tsquery('simple', '''e-okul''') is a
--     phrase again, so the tsquery input cast is the right tool: nothing that parses text may touch the compound.
--   * The stemmer rewrites some compounds and the parser splits others, so the lexeme is read from to_tsvector, not from the typed text (evidence, local
--     PostgreSQL 15 and production): to_tsvector('turkish', 'e-nabiz') holds 'e-nap' (the cast 'e-nabiz' finds 0 of the 5 e-Nabız clusters, the stored lexeme
--     5), 'e-okulu' is stored as 'e-okul' (the cast finds 0 of 10, the stored lexeme 10), and F-16 and S-400 are not compound lexemes at all (the parser reads f
--     and -16, s and -400: 17 and 34 clusters hold the phrase, 0 hold a 'f-16' lexeme), so a literal cast would empty the folded and stem arms of f-16 and s-400.
--
-- WHAT
--   (1) f CTE: a column cmp tsquery. It is the AND of the compound lexemes of the folded query, null when there is none. A compound is a match of the
--       constant pattern '(?:^|[^a-z0-9])([a-z]-[a-z0-9]{2,})' (regexp_matches, flag g) over f0.ff: one letter at a word start, a hyphen, at least two letters or
--       digits. Its lexeme is the entry of to_tsvector('turkish', <the match>) that holds a hyphen after its first character (the stored lexeme: e-okul,
--       e-nap), distinct, sorted, joined with ' & ' inside quotes and read through the tsquery input cast ('''' || lexeme || '''', never to_tsquery,
--       plainto_tsquery or websearch_to_tsquery, which parse the hyphen back into a phrase). A match without such a lexeme (f-16, s-400, a digit tail: the
--       parser keeps f and -16 apart) gives no cmp. The pattern is a constant and the query is only ever its subject; the pattern is linear (one unbounded
--       quantifier, on a character class, nothing after it that the class can also match: CodeQL js/redos); nothing is dynamic SQL. The lexemes come out of
--       to_tsvector, so they hold no quote and no backslash, and the quoting is safe (the dry-run asserts it with a quote in the input).
--   (2) q CTE: qf is `case when f.cmp is null then y.b else y.b && f.cmp end`, where y.b is 196's qf expression (the websearch query of the folded text,
--       with the plainto_tsquery fallback when it holds '<'), exposed as a new column qb; the column cmp rides along. The folded arm and the ORDER BY read
--       qf. qs is built from qb, the query WITHOUT the compound (196's text), and only then `&& cmp` (folded with tayf_search_fold, a no-op on [a-z0-9-]) when
--       cmp is not null: qs is built from qb, because to_tsquery('simple', ...) over a text that held 'e-okul' parses the hyphen into a phrase, and the helper
--       reads its argument back through to_tsquery as well. An empty qb still gives a null qs. qf and qs never contain '<' (cmp is one quoted lexeme): the
--       folded arm is an expression index, and a phrase query makes Postgres recompute the fold and to_tsvector over every candidate row. qv (search_tsv) is
--       unchanged: its phrase is already right.
--   (3) lw CTE: `and (pg_catalog.length(s.w) >= 2 or (select f.cmp from f) is null)`, so a one-letter word is not a literal-tier prefix when the query holds
--       a compound (cmp is not null: the word e of e-okul), and stays one when it does not (cmp is null: s-400, u-19, f-35 and every query with no compound
--       lexeme keep 196's literal tier, so their ids AND their order are 196's). A first version of this file applied the condition to every query and moved
--       the order of s-400 on production (see REPLAY); the review of h145 scoped it (f is an earlier CTE of the same WITH, one row).
--   Everything else is 196's text byte for byte (the test derives 204's body from 196's: only the f, q, qs and lw CTEs differ, by exactly these statements).
--   The function keeps 196's attributes: language sql, stable, SECURITY DEFINER, set search_path = '', and its grants (revoke from public, anon and
--   authenticated, grant to service_role), the comment (extended), the ledger row (version '204', on conflict do nothing) and the notify. There is no index change: the folded arm
--   keeps its expression, and the && adds one lexeme that the index already stores.
--
-- BASE
--   The base is 196's body (md5 c384c1f3a0dc337e5243b5a3e55985c0, length 19562; the test recomputes it). It is the body production runs (STEP 0): 198
--   replaced only tayf_ascii_inflection_expand, whose body production runs as md5 e282da4628010153155d3bd8986db77f, length 5133. This file is complete on
--   its own: it replaces whichever body is installed with the one below, and it needs no object that 196 did not already need (tayf_search_fold of 129,
--   tayf_search_stem_fold and clusters_search_stemfold_live_idx of 186, tayf_ascii_inflection_expand of 196 and 198). The proacl of search_cluster_ids stays
--   {postgres=X/postgres,service_role=X/postgres}. Application: no deploy order.
--
-- STEP 0 (read-only, production, 2026-11-12 about 04:15Z)
--   select p.oid::regprocedure::text, md5(p.prosrc), length(p.prosrc), p.proacl::text, p.prosecdef, p.provolatile, p.proparallel
--     from pg_proc p where p.proname in ('search_cluster_ids', 'tayf_search_stem_fold', 'tayf_search_fold', 'tayf_ascii_inflection_expand')
--   -> search_cluster_ids(text[],text,integer) c384c1f3a0dc337e5243b5a3e55985c0, 19562, {postgres=X/postgres,service_role=X/postgres}, t, s, u: the body of
--      196 in the repository, md5 and length equal. tayf_ascii_inflection_expand(tsquery) e282da4628010153155d3bd8986db77f, 5133 (198's; not touched).
--      search_cluster_ids(text[],integer) aabf54347c8f929090419335d5d48f19 (083's, not touched). tayf_search_stem_fold(tsvector)
--      709be5df31d85ac692729f673e7e7900 and tayf_search_fold(text) 77a0656fab6d06f5fb86f75afdfb6391 (the two helpers the arms read; not touched). The
--      ledger holds 196, 198, 199, 200 and 201 and no 202, 203 or 204.
--
-- REPLAY (production, SELECT only through sbq.py in a read-only transaction, 2026-11-12 about 04:20-04:35Z)
--   196's body and this file's body ran inline as plain SELECTs (comments stripped, p_variants and p_folded replaced by the literals that
--   src/lib/clusters/search-query.ts builds with canonicalSearchQuery, expandAliasQuery, turkishQueryVariants, foldTr and, where the app makes one, the sibling
--   call; p_limit removed, so every scored candidate up to the 1000-row cap, in rank order; the first 24 is the page). The two bodies of a query and the
--   live function ran in ONE statement (one now()). Control: the first 24 of 196's inline body equal the live function's top 24 for all 31 calls.
--   query (typed)        candidates 196 -> 204   true matches (search_tsv phrase)   result
--   e-okul                   74 -> 10                 10                  the id set IS the true set; no id added, 64 left
--   e-okulu                  74 -> 10                 10                  (a suffix on the compound: the stored lexeme e-okul)
--   e-devlet                234 -> 56                 56                  the id set IS the true set; every row holds the lexeme e-devlet
--   e-ticaret                55 -> 5                   5                  the id set IS the true set
--   e-imza                   48 -> 0                   0                  /?q=e-imza gives 'sonuç bulunamadı'
--   e-nabız                   6 -> 5                   5                  the id set IS the true set (the stored lexeme e-nap)
--   e-nabiz (ASCII)           6 -> 5                   5 (of e-nabız)     the variants arm cannot find it from ASCII; the stored lexeme does
--   e-spor                   29 -> 0                   0                  no story holds e-spor
--   First check: the new id set of every compound above EQUALS its true set, is contained in 196's set (cmp only narrows; no id is added), and every row
--   holds the stored compound lexeme. The first three cards of e-okul were 1da586db, b468056d and c859c91b; the 10 rows now are MEB exam and school stories
--   (LGS, YKS, bursluluk, the last week before the summer break) whose title or summary holds e-Okul. The 5 e-nabız rows are the e-Nabız stories.
--   Controls, the regression list of the spec (the id set AND the order of the whole uncapped list, so the top 24 too): f-16 18 -> 18, iran-israil 464,
--   chp-mhp 151, okul 672, devlet 1000 and s-400 37 -> 37 are identical. s-400 is identical because edit 3 applies only to a compound query (f.cmp is not
--   null): a letter-digit query has no compound lexeme, so its literal tier is 196's and, with cmp null, so is every other arm (qf and qs read the same text as
--   196's). A first version of this file dropped the one-letter word from the literal tier of EVERY query; on the same replay that kept the id set of s-400 and
--   moved its order: one row that holds only 400 and has no word starting with s ('Fransa'da liselilerin eylemlerine polis müdahalesi: 400'den fazla gözaltı')
--   took the tier, so it moved from rank 27 to rank 9, the 18 rows between shifted down by one (19 of 37 positions changed, 18 stayed), and one row left the top 24
--   (rank 24 to 25, an Erdoğan 'Orta Doğu için kalıcı barış çağrısı' story). The same replay with edit 3 applied only when the query has a compound (this file)
--   keeps s-400 identical and gives the compound queries the same ids and order as the table above.
--   The ordinary queries, every id set AND order identical (the first 24 too): Erdoğan 1000, İmamoğlu'nun 606, TCMB 21, deprem 440, emekli maaşı 89, asgari ücret
--   zammı 0 (and its sibling call 7), istanbulda 1000, ankara'dan 1000, kurti 5, yorgun 6, mardin kaza 0, Anayasa Mahkemesi 180 (sibling 28), MEB'e 202, 2026
--   1000. okul -e-okul (a negated compound) keeps its 662 ids and changes its order (qf gains the compound conjunct in ts_rank_cd; KNOWN LIMITS 2).
--   The plan and the timing of the same calls, EXPLAIN (ANALYZE), are in COST.
--
-- COST (EXPLAIN (ANALYZE), 196's body against 204's, inline, the same arguments, alternated, one warm-up each, medians of 5, production, 2026-11-12
--   about 04:30Z). The plans are 196's: the three index scans (clusters_search_tsv_live_idx, clusters_search_fold_live_idx, clusters_search_stemfold_live_idx),
--   the primary key for the scored rows, no Seq Scan on clusters. The compound extraction runs once per call (the f CTE has one row) and costs microseconds.
--   deprem 43.40 -> 43.58 ms (1.00x), okul 66.56 -> 67.32 ms (1.01x): a query without a compound costs what it cost. A compound query costs less, because
--   it scores fewer rows: e-okul 11.94 -> 5.69 ms (0.48x, 74 -> 10 candidates), e-devlet 28.32 -> 11.30 ms (0.40x, 234 -> 56). The local dry-run
--   (PostgreSQL 15, 8,000 synthetic clusters) bounds the same ratios at 1.5x and measured 0.99x for deprem, okul and imamoglu. The production timings above
--   were taken before the h145 review scoped edit 3 (the lw condition reads the one-row f CTE, `(select f.cmp from f)`, once per lw word: an InitPlan on one
--   row); the local dry-run asserts its 1.5x bound on the final text.
--
-- KNOWN LIMITS
--   (1) A cluster that writes the word with a space ('e devlet', 'e okul') or another dash (en dash, non-breaking hyphen) no longer matches an e-devlet
--       query through the folded or the stem arm: the compound lexeme is required. The variants arm (the phrase) is unchanged and was already strict.
--       That is the point of the change.
--   (2) A negated compound (-e-okul) and a hyphen chain (a-b-cd): the pattern takes the compound out of the query wherever a letter, a hyphen and two characters
--       follow a non-alphanumeric character (a hyphen counts), so 'okul -e-okul' gets cmp 'e-okul' and a contradictory qf (okul & !e & e-okul), and a-b-cd
--       gets 'b-cd', which no vector stores. The folded and the stem arm then return nothing for such a query and the variants arm answers (okul without the
--       phrase e-okul), which is what the reader asked for. Replay: okul -e-okul keeps all 662 ids and changes the order only. An alias or an or query
--       (e-okul or e-devlet) ANDs its compounds in cmp: the variants arm answers the or, and the folded and stem arms are narrower than before.
--   (3) A digit tail has no lexeme (f-16, s-400, b-52: the parser splits the letter from the number), so such a query keeps 196's arms AND, because edit 3
--       applies only when cmp is not null, 196's literal tier: s-400, u-19 and f-35 keep their ids and their order (see REPLAY). The one-letter word is dropped
--       from the literal tier of a compound query only. A query that mixes a compound and a letter-digit word (e-okul s-400) has a cmp, so it drops both
--       one-letter words (e and s) from its literal tier: only the ORDER of such a query can differ from 196's, never the id set.
--   (4) The stem arm's compound is the stem of the ASCII compound, folded: an ASCII spelling that the stemmer treats differently from the Turkish one (a
--       compound with a suffix after a Turkish letter) may miss in the stem arm; the folded arm, which compares ASCII with ASCII, still finds it.
--
-- LEDGER: this file records version 204 in supabase_migrations.schema_migrations itself, idempotently (the 095 pattern: insert ...
-- on conflict do nothing, last statement before commit), so applying it by posting the SQL (management API or psql) leaves
-- `supabase migration list` correct; `supabase db push` records the same row. Re-applying is harmless (create or replace function,
-- and the ledger insert does nothing the second time).
--
-- VERIFY (read-only, after applying)
--   1. select md5(p.prosrc), length(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
--      expect 32b42ca06d6b0c2a3ba8bf1264d353f7, 22892.
--   2. select p.prosecdef, p.provolatile, pg_catalog.has_function_privilege('anon', p.oid, 'execute'), pg_catalog.has_function_privilege('authenticated', p.oid, 'execute'), pg_catalog.has_function_privilege('service_role', p.oid, 'execute'), p.proacl::text from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
--      expect t, s, false, false, true, {postgres=X/postgres,service_role=X/postgres}.
--   3. select version, name from supabase_migrations.schema_migrations where version = '204'; expect one row.
--   4. the helper is untouched: md5(prosrc) of public.tayf_ascii_inflection_expand(tsquery) is still e282da4628010153155d3bd8986db77f, length 5133.
--   5. the id sets: select count(*) from public.search_cluster_ids(array['e-okul'], 'e-okul', 50) expects 10 (the count moves with the data) and equals the count
--      of clusters with search_tsv @@ websearch_to_tsquery('turkish', 'e-okul'); array['e-imza'] with 'e-imza' expects 0; array['e-devlet'] with 'e-devlet'
--      expects only clusters that hold the lexeme (search_tsv @@ '''e-devlet'''::tsquery).
--   6. GET /?q=e-imza (one request per second, after the cache entry is rebuilt) prints "sonuç bulunamadı"; /?q=e-okul lists the e-Okul stories only (every card
--      mentions e-Okul); /?q=e-nabiz and /?q=e-nabız list the same 5 stories; /?q=okul, /?q=deprem, /?q=erdogan and /?q=f-16 are unchanged; explain (analyze) of the
--      body for deprem stays within +20% of 196's (about 43 ms) and uses the three indexes.
--
-- Safe to re-apply: create or replace function (twice), the comment, the grant, the ledger insert `on conflict do nothing`. Nothing is dropped, altered,
-- updated or deleted.
--
-- ROLLBACK (the data shape does not change; the app does not depend on 204): re-run the function statement AND the
--   `comment on function public.search_cluster_ids(text[], text, integer)` statement of 196_search_ascii_inflection_roots.sql (restores md5(prosrc)
--   c384c1f3a0dc337e5243b5a3e55985c0, length 19562), then
--     delete from supabase_migrations.schema_migrations where version = '204';
--     notify pgrst, 'reload schema';
--   in that order. 083's two-argument function, the helper of 196 and 198 and the app's PGRST202 fallback are not involved.
--
-- See tests/migrations/204-search-single-letter-compounds.test.ts and tests/migrations/sql/204-search-single-letter-compounds-dryrun.sql.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Ranked, folded archive search: 196's body (the live one) with three edits: the compound lexemes (f, q, qs) and the literal tier of a compound query (lw).
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
    -- 204: cmp is the AND of the single-letter hyphen compounds of the folded query (e-okul, e-devlet, e-imza: one letter at a word
    -- start, a hyphen, at least two letters or digits), as tsquery lexemes, and null when there is none. A lexeme is the one the
    -- turkish config STORES for that token: to_tsvector of the compound, the entry with a hyphen after its first character. The
    -- stemmer rewrites some compounds (e-nabiz is stored as e-nap, e-okulu as e-okul), and the parser splits a letter-digit one
    -- (F-16 is f and -16, so it has no lexeme and cmp is null: such a query keeps 196's text). The lexemes are read through the
    -- tsquery INPUT cast of a quoted lexeme, never to_tsquery, plainto_tsquery or websearch_to_tsquery, which parse the hyphen back
    -- into a phrase ('e-okul' <-> 'e' <-> 'okul'). The pattern is a constant and the query is only ever its subject; the lexemes
    -- come out of to_tsvector, so they hold no quote and no backslash, and the quoting is safe (the dry-run asserts it).
    select pg_catalog.regexp_replace(f0.ff, '"|(?<=[a-z0-9])-(?=[a-z0-9])', ' ', 'g') as s,
           pg_catalog.btrim(pg_catalog.regexp_replace(f0.ff, '[^a-z0-9]+', ' ', 'g')) as lit,
           (select pg_catalog.string_agg('''' || u.lexeme || '''', ' & ' order by u.lexeme)::pg_catalog.tsquery
              from (select distinct c.lexeme
                      from pg_catalog.regexp_matches(f0.ff, '(?:^|[^a-z0-9])([a-z]-[a-z0-9]{2,})', 'g') as x(m)
                     cross join lateral pg_catalog.unnest(pg_catalog.to_tsvector('pg_catalog.turkish'::pg_catalog.regconfig, x.m[1])) as c(lexeme, positions, weights)
                     where pg_catalog.strpos(c.lexeme, '-') > 1) u) as cmp
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
           -- 204: qf is that expression ANDed with the compound (f.cmp), so e-okul needs the stored lexeme e-okul as well as e and okul,
           -- and no longer matches MEB'e okul. cmp is one quoted lexeme, so qf still holds no phrase operator. qb is the expression
           -- WITHOUT the compound (196's qf, unchanged): qs is built from it. cmp is null for a query without a compound, and qf is 196's.
           case when f.cmp is null then y.b else y.b && f.cmp end as qf,
           y.b as qb,
           f.cmp,
           f.lit
    from f
    cross join lateral (select pg_catalog.websearch_to_tsquery('pg_catalog.turkish'::pg_catalog.regconfig, f.s) as w) x
    cross join lateral (select case when pg_catalog.strpos(x.w::pg_catalog.text, '<') > 0
                                    then pg_catalog.plainto_tsquery('pg_catalog.turkish'::pg_catalog.regconfig, f.s)
                                    else x.w end as b) y
  ), qs as (
    -- 186: the stem arm's query. qf is the turkish stem of the ASCII-folded query (siginak, yurt disi,
    -- guvenlik). The stored stems keep their Turkish letters and the stemmer cannot inflect the ASCII
    -- spelling, so the folded arm of 129 misses the inflected rows (the Turkish word for a shelter, in
    -- its accusative, is stored as the stem 'siginak' with Turkish letters, while the ASCII spelling of
    -- the same inflected word is left whole). The third arm therefore reads the stored stems FOLDED to
    -- ASCII, and the query is folded the same way: qf's text form, folded, read as a simple query.
    -- qf never holds a phrase operator (the q step), so the text is only quoted lexemes and & | ! ( ).
    -- An empty qf (only stop words, or nothing) gives null, and a null query matches no row.
    -- 196: the stemmer cannot strip a suffix from an ASCII word either (maasi, siginagi, maaslari, cocugu and guvenligi stay whole),
    -- so the stem query of an ASCII-typed inflected word never meets the stored Turkish stem (maas, siginak, cocuk, guvenlik).
    -- public.tayf_ascii_inflection_expand ORs each ASCII lexeme with the roots its ending can only mean (a closed list of three
    -- rules, 4 letters or more: maasi -> maas, siginagi -> siginag and siginak, maaslari -> maas), so the stem arm finds what
    -- the Turkish spelling finds. The arms before it, the guard, the tiers and the ORDER BY read nothing of qs.
    -- 204: qs is built from qb, the query WITHOUT the single-letter compound (196's text), and only then ANDed with the compound,
    -- folded, as one quoted lexeme cast to a tsquery. A to_tsquery('simple', ...) over a text that held 'e-okul' would parse the hyphen
    -- into a phrase again, and so would the helper, which reads its argument back through to_tsquery. A query without a compound
    -- (cmp is null) gets 196's qs; an empty qb still gives null.
    select case when pg_catalog.numnode(q.qb) = 0
                then null
                else (select case when q.cmp is null
                                  then t.s
                                  else t.s && public.tayf_search_fold(q.cmp::pg_catalog.text)::pg_catalog.tsquery end
                        from (select public.tayf_ascii_inflection_expand(pg_catalog.to_tsquery('pg_catalog.simple'::pg_catalog.regconfig, public.tayf_search_fold(q.qb::pg_catalog.text))) as s) t) end as qs
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
    -- 204: a one-letter word of a COMPOUND query is not a prefix (length(s.w) >= 2 or cmp is null). The prefix of the word e of e-okul (or of an
    -- apostrophe dative, MEB'e) is the single letter e, which starts any display-title word that begins with e, so the tier rewarded the wrong stories.
    -- A query with no compound lexeme (cmp is null: s-400, f-16, a plain query) keeps its one-letter words, as under 196.
    select distinct pg_catalog.left(s.w, greatest(least(pg_catalog.length(s.w), 4), pg_catalog.length(s.w) - 2)) as pre
    from g0
    cross join lateral pg_catalog.regexp_split_to_table(g0.tok, '[^a-z0-9]+') as s(w)
    where s.w <> ''
      and (pg_catalog.length(s.w) >= 2 or (select f.cmp from f) is null)
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
  'display-title ranking of migration 194, the ASCII inflection roots of migration 196 and the single-letter compounds of migration 204. Candidates: '
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
  'alias, OR or negated-phrase query; 204: a one-letter word of a compound query is not a prefix), title relevance (0.3, ts_rank_cd saturating at 0.2), recency '
  '(1.0, 14-day scale) and corroboration (0.15 * ln(least(article_count, 50))); '
  'article_count only breaks ties. The score is a function of p_folded and the title, '
  'so a Turkish query and its ASCII fold rank a shared candidate alike. Ranking never '
  'changes recall: the id set is 186''s, plus (196) the roots. Stem arm (196): the stem lexemes of the ASCII-folded '
  'query are ORed with closed suffix-strip roots (public.tayf_ascii_inflection_expand: maasi -> maas, siginagi -> '
  'siginag and siginak, maaslari -> maas), so an ASCII-typed inflected word finds what its Turkish spelling '
  'finds. Single-letter compounds (204): a query with a single-letter hyphen compound (e-okul, e-devlet, e-ticaret, '
  'e-imza, e-spor, e-nabiz) must find the compound itself in the folded arm and in the stem arm (the AND of the '
  'compound lexeme the turkish config stores for it, one quoted lexeme read through the tsquery input cast), not its '
  'halves e and okul, which matched every apostrophe dative (MEB''e okul); the variants arm is unchanged (its phrase is '
  'already right). Returns ids ONLY. service_role only.';

revoke all on function public.search_cluster_ids(text[], text, integer) from public, anon, authenticated;
grant execute on function public.search_cluster_ids(text[], text, integer) to service_role;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('204', '204_search_single_letter_compounds')
  on conflict do nothing;

commit;
