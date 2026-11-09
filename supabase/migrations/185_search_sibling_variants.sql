-- 185_search_sibling_variants.sql
--
-- Archive search finds the headline form of everyday nouns. One function replaced, with the same signature:
-- public.search_cluster_ids(p_variants text[], p_folded text, p_limit integer default 12). The body is 172's body
-- byte for byte except ONE expression: the variants query q.qv, which ORed p_variants[1..3], now ORs p_variants[1..6].
-- The app (src/lib/clusters/turkish-query.ts searchSiblingQuery, search-query.ts) asks twice when a term is a possessive
-- or a doubled-stem form: the typed spellings first (at most three variants), and only when that call leaves slots of the
-- page empty a SECOND call with the root's spellings (at most three), whose new ids are appended after the typed ones:
-- 'elektrik zammı', then 'elektrik zam'. The app never sends more than three variants in one call, so the feature works
-- on 172's body as it is and this file is OPTIONAL for it (see DEPLOY ORDER); it stays in the series because 186's body is
-- built on it. No table, column, index, trigger, cron job, grant or data change; 083's two-argument function (the
-- PGRST202 fallback of src/lib/clusters/search-query.ts) is not touched; p_folded, 166's guard and 172's tier are
-- untouched (h96-search-1, hunt 96, 2026-11-09). This file takes the number 185 (184 is another branch's).
--
-- WHY (evidence: production, read-only, 2026-11-09)
--   * The Turkish snowball stemmer (ts_lexize('turkish_stem')) gives two shapes of everyday noun their own lexeme.
--     Doubled consonant: zam -> zam but zammı -> zammı and zammına -> zamm. Possessive after a vowel: vergi -> vergi but
--     vergisi -> vergis (vergisinde -> vergi); ceza -> ceza but cezası -> cezas; soruşturma -> soruşturma but
--     soruşturması -> soruşturmas; belediye -> beledi but belediyesi -> belediyes. The lexeme a reader's word makes is not
--     the lexeme the headline's word makes, so the two never meet.
--   * public.search_cluster_ids(array[q], tayf_search_fold(q), 50), the typed form against the stem-aligned form:
--     elektrik zammı 0 vs 9, emlak vergisi 0 vs 2, doğal gaz zammı 0 vs 4, asgari ücret zammı 0 vs 6, trafik cezası 18
--     vs 34, gelir vergisi 7 vs 21. Live: /?q=elektrik%20zamm%C4%B1 said "sonuç bulunamadı" and /?q=elektrik%20zam said
--     "9 sonuç bulundu". A typed headline word is the commonest way to ask for these stories.
--   * The folded arm cannot repair it: it stems the ASCII-folded text, and the stemmer treats 'zammi' and 'vergisi' the
--     same way. The reader's typed words are the wrong stem; the fix is to ask for the root as well.
--   * The root must NOT be ORed into the typed call. A first cut sent typed and sibling spellings as one p_variants (up to
--     six): the body ORs the variants with equal rank, so on production (read-only, 2026-11-09) search_cluster_ids(
--     array['karasu', 'kara'], 'karasu', 24) returned 13 Karasu rows and 11 unrelated ones (Karayolları snow work, Sayan
--     Kaya, the FATF reaction) where array['karasu'] returns 24 Karasu rows, and 'kayısı' (typed call: 2 rows, 1 real hit)
--     became 24 rows with no hit once its root 'kayı' was ORed in. The app therefore asks for the root in a second call
--     that can only fill empty slots (h96-search-1, CORR-2).
--
-- WHAT
--   App (no database change needed for it to start working, see DEPLOY ORDER). searchSiblingQuery(q) returns null when the
--   query uses websearch syntax (hasSearchOperator: a double quote, a leading '-', a standalone `or`, so alias
--   expansions never get a sibling) or when no term changes. Otherwise each term is rewritten by two narrow rules:
--   (A) a possessive after a vowel, the -sı / -si ending only, /^(\p{L}{2,}[aeıioöuü])s[ıi]$/u, becomes the captured root
--   (vergisi -> vergi, cezası -> ceza, soruşturması -> soruşturma, belediyesi -> belediye); a -su / -sü word is a compound
--   name (Karasu, Sarısu, Ilısu, Akarsu) and gets none, and the fruit 'kayısı' (root 'kayı' is unrelated) is on a small
--   folded deny set checked before the rule; (B) a CLOSED allowlist of doubled stems
--   (GEMINATE_ROOTS: zamm, hakk, aff, hiss, hatt, sırr, redd) plus one of ı i u ü becomes the root (zammı -> zam, hakkı ->
--   hak, affı -> af, reddi -> ret). The allowlist is closed on purpose: a general doubled-consonant rule turns 'messi'
--   into 'mes'. The term count never changes, so the 6-term and 64-character bound holds. fetchSearchClusters makes the
--   typed call as it always did (p_variants: at most 3 typed spellings, p_folded: the typed words); when the query has a
--   sibling and that call returned fewer than 24 (SEARCH_LIMIT) ids it makes a second call with p_variants = the sibling's
--   spellings (at most 3) and the same p_folded, then appends the second call's ids that are not already present after
--   the typed ids, up to 24. A full typed page is never touched, the cache key stays canonical, and a database without
--   the three-argument function (PGRST202) takes both calls on 083's two-argument one.
--   Database (this file). No current caller sends more than three variants, so this body and 172's give the same ids for
--   every call the app makes; the change is spare capacity for a caller that wants six spellings in one call. q.qv is
--       websearch_to_tsquery(turkish, coalesce(p_variants[1], ''))
--    || websearch_to_tsquery(turkish, coalesce(p_variants[2], p_variants[1], ''))
--    || websearch_to_tsquery(turkish, coalesce(p_variants[3], p_variants[1], ''))
--    || websearch_to_tsquery(turkish, coalesce(p_variants[4], p_variants[1], ''))
--    || websearch_to_tsquery(turkish, coalesce(p_variants[5], p_variants[1], ''))
--    || websearch_to_tsquery(turkish, coalesce(p_variants[6], p_variants[1], '')).
--   A missing element falls back to the first spelling, and ORing the first spelling with itself changes nothing, so a
--   call with at most three variants is 172's call (the plan and the rows). Everything else in the body, comments
--   included, is 172's: the guard (g0, gx, g), the exempt-word tier (ge, hits, lit_ok), cand, kept, top and the ORDER
--   BY. 166's over-stem guard reads p_folded only, so a sibling spelling is never guarded and never tiered; the typed
--   words are.
--
-- DEPLOY ORDER. The app can ship first, and this file is OPTIONAL for it. 172's body reads p_variants[1..3] and ignores
--   the rest, and the app never sends more than three variants in one call (the typed call and the sibling call carry at
--   most three each), so every cited query already works on 172: 'elektrik zammı' sends 'elektrik zammı', 'elektrik zammi'
--   and then, in a second call, 'elektrik zam'. Applied at any time, before or after the app, this file changes nothing the
--   app can observe. It is applied before 186 because 186's function is built on this body (186 replaces whichever body is
--   installed, so skipping 185 is possible but leaves 186's md5 chain without its recorded predecessor).
--
-- KNOWN LIMITS
--   (1) Two shapes only. 'vergisinde', 'zammına' and every other suffix are not rewritten: a rule is added only with the
--       live counts that justify it. (2) Rule A also fits a word whose root really ends in 's' ('tesisi' is tesis + i, and
--       becomes 'tesi'): the sibling is only a second call that fills empty slots after the typed rows, so nothing the
--       reader asked for is lost (a 'tesisi' typed page fills the 24 and no second call is made on production). (3) 'hakkı' is also a
--       first name: its sibling adds the 'hak' stories (the typed 'hakkı' rows stay). (4) Inside ONE call the function cannot tell typed
--       from sibling spellings, and 172's tier reads p_folded only (it re-orders for an exempt over-cut word such as
--       'miller', nothing else): on 172 and 185 a sibling-only row ranks level with the typed rows, by the score
--       expression, unless the word is an exempt over-cut word. That is why the app never merges the two spellings into
--       one call: it asks the typed call first and appends the sibling's new ids after it. (5) The 1000-row candidate cap is 172's: a sibling widens the candidate set, so a
--       very broad query can reach it sooner. (6) An alias query ('akp vergisi') gets no sibling: its variants query has
--       an `or` and a quote. (7) A query typed with websearch syntax is the reader's own.
--
-- PRODUCTION FINGERPRINT THE REPLACE WAS BASED ON (read-only, 2026-11-09, pg_proc)
--   public.search_cluster_ids(text[], text, integer): LANGUAGE sql, STABLE, SECURITY DEFINER, SET search_path TO '',
--   returns TABLE(id uuid), owner postgres. md5(prosrc) = 192218b7b6a56b3c8fcc48d5e0610a2c (length 12913), which is the
--   body of 172_search_exempt_word_tier.sql (the test recomputes it). proacl = {postgres=X/postgres,service_role=X/postgres}.
--   new md5(prosrc): b8d0aa3035e001d17750d94f5a08c9c2 (length 13324)
--
-- REPLAY (production, SELECT only through sbq.py inside a read-only transaction, 2026-11-09; BODY replay of the first cut,
--   which sent the typed and the sibling spellings as ONE p_variants: 172's body and this file's body run inline with
--   literal arguments in ONE statement so now() is shared, p_limit 50, the RPC's own cap; the app sends 24 (SEARCH_LIMIT),
--   so the top 24 is the page. The shipped app shape is two calls and is replayed in its own block below.)
--   typed            rows 172 -> 185    (172 with the typed spellings; 185 with the first cut's merged spellings)
--   elektrik zammı        0 -> 9        p_variants [elektrik zammı, elektrik zammi, elektrik zam], p_folded 'elektrik zammi'
--   emlak vergisi         0 -> 2        [emlak vergisi, emlak vergi]
--   doğal gaz zammı       0 -> 4
--   asgari ücret zammı    0 -> 6
--   gelir vergisi         7 -> 22       (the stem-aligned form had 21 on the day of the finding)
--   trafik cezası        18 -> 38       (34 on the day of the finding)
--   Single terms: zammı 20 -> 50, vergisi 31 -> 50, aşısı 6 -> 50, ekonomisi 27 -> 50, hissi 2 -> 29, reddi 15 -> 17; hakkı,
--   affı, sırrı, hattı, cezası, belediyesi, üniversitesi and tesisi keep the same top 24 (their typed rows already fill it).
--   Controls with no sibling (the arguments are identical, so is the list): identical top 24 AND identical 50-row list
--   for burdur 34 rows, miller 18, bartın 32, bartin 23, şişli 35, iran, seçim, erdoğan, akp (alias), istanbul, imamoğlu
--   and chp (50 rows each); messi (a doubled consonant that is not listed) 1 row, unchanged.
--   Body only: 172's body and this body with the SAME arguments (the app's new ones) return the same ids in the same
--   order for every query above, the six cited ones included, because the sibling is within the first three variants
--   there. The one exception is sırrı: typed spellings sırrı and sirri plus the sibling's sır and sir are FOUR variants, and
--   only this body reads the fourth (same top 24, one more row of 50). A query with three typed spellings has no match
--   on production to replay ('ısıtma zammı', 'ırkçılık cezası': 0 rows either way); a direct call with a fourth variant
--   shows the difference: select count(*) from search_cluster_ids(array['zzqx1', 'zzqx2', 'zzqx3', 'elektrik zam'],
--   'zzqx1', 50) is 0 on 172's body and 9 on this one. The dry-run
--   (tests/migrations/sql/185-search-sibling-variants-dryrun.sql) proves the same on a fixture.
--   APP SHAPE, as shipped (the live 172 body, SELECT only, 2026-11-09, p_limit 24 per call: the typed call, then the
--   sibling call only when the typed one returned fewer than 24 ids, its new ids appended after the typed ones):
--   elektrik zammı 0 + 9 = 9 rows (two calls)   emlak vergisi 0 + 2 = 2   doğal gaz zammı 0 + 4 = 4   asgari ücret zammı
--   0 + 6 = 6   gelir vergisi 7 + 15 = 22   trafik cezası 18 + 6 = 24 (the page is full). No sibling, one call: karasu 24 rows
--   (the merged first cut gave 13 Karasu rows and 11 unrelated), kayısı 2 rows (1 real hit; the merged first cut gave 24
--   rows and none), sarısu and ılısu 0 rows; vergisi and cezası fill the page with typed rows, so no second call is made.
--
-- COST (production, EXPLAIN (ANALYZE), 172's body inline vs this body inline, alternated in one session, warm, medians
--   of 5 runs, ms, 2026-11-09; the gate is 1.3x)
--   same arguments, so the body alone:   trafik cezası 4.05 -> 4.25 (1.05x)   iran 152.87 -> 152.01 (0.99x)
--                                        elektrik zammı 1.22 -> 1.33 (1.09x)
--   sibling arguments (6 variants):      trafik cezası 6.26 -> 6.49 (1.04x)   gelir vergisi 4.37 -> 4.39 (1.00x)
--   end to end (172 with the typed arguments, 185 with the first cut's merged arguments, the cost of the extra rows):
--                                        iran 152.32 -> 152.55 (1.00x)   erdoğan 138.50 -> 148.16 (1.07x)
--                                        trafik cezası 4.01 -> 6.37 (1.59x, +2.4 ms: 38 hits where 172 had 18)
--                                        elektrik zammı 1.24 -> 3.19 (+1.9 ms: 9 hits where 172 had 0)
--   The three extra tsquery terms cost what the three copies of the first spelling cost: GIN merges equal entries. The
--   only growth is the work for rows the typed query could not find, which is the point. The shipped app shape pays the
--   same database work as two separate typed-size calls (the sibling call is one more PostgREST round trip and runs only
--   when the typed page is short); a query without a sibling makes the one call it always made.
--
-- LEDGER: this file records version 185 in supabase_migrations.schema_migrations itself, idempotently (the 095
-- pattern: insert ... on conflict do nothing, last statement before commit), so applying it by posting the SQL
-- (management API or psql) leaves `supabase migration list` correct; `supabase db push` records the same row.
-- Re-applying is harmless (create or replace, and the ledger insert does nothing the second time).
--
-- VERIFY (read-only, after applying)
--   1. select md5(p.prosrc), length(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
--      expect b8d0aa3035e001d17750d94f5a08c9c2, 13324.
--   2. select pg_catalog.has_function_privilege('anon', 'public.search_cluster_ids(text[], text, integer)', 'execute'), pg_catalog.has_function_privilege('service_role', 'public.search_cluster_ids(text[], text, integer)', 'execute');
--      expect false, true.
--   3. select count(*) from public.search_cluster_ids(array['zzqx1', 'zzqx2', 'zzqx3', 'elektrik zam'], 'zzqx1', 50);
--      expect more than 0 (about 9; 172 gives 0, because it ignores the fourth variant).
--      select count(*) from public.search_cluster_ids(array['elektrik zammı', 'elektrik zammi', 'elektrik zam'], 'elektrik zammi', 50); expect the same count.
--   4. select count(*) from public.search_cluster_ids(array['burdur'], 'burdur', 24); expect 24 with the same ids as before (a query with one spelling is 172's).
--   5. explain (analyze) select * from public.search_cluster_ids(array['iran'], 'iran', 24); expect about 150 ms (172: about 150 ms).
--   6. GET /?q=elektrik%20zamm%C4%B1 and /?q=emlak%20vergisi show results (before: "sonuç bulunamadı"); /?q=iran and /?q=burdur are unchanged.
--
-- ROLLBACK. If 186 is applied, run 186's ROLLBACK first (the function, then `drop index concurrently` of
--   clusters_search_stemfold_live_idx, then drop the helper): 186's body contains 185's change, and re-running 172's body
--   from here alone would silently drop 186's third arm while the index and its helper stay behind and keep costing a
--   write on every live-cluster update. Then, in one transaction: re-run the function statement AND the `comment on function
--   public.search_cluster_ids(text[], text, integer)` statement of 172_search_exempt_word_tier.sql (the 172 body, md5
--   192218b7b6a56b3c8fcc48d5e0610a2c; create or replace keeps 185's comment otherwise), then
--   delete from supabase_migrations.schema_migrations where version = '185';
--   notify pgrst, 'reload schema';
-- 083's search_cluster_ids(text[], integer) and the app's PGRST202 fallback are not involved. The app keeps working on
-- 172's body: every call it makes carries at most three variants.
--
-- See tests/migrations/185-search-sibling-variants.test.ts and tests/migrations/sql/185-search-sibling-variants-dryrun.sql.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

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
  'guard of migration 166, the exempt-word tier of migration 172 and the sibling '
  'variants of migration 185. Candidates: live clusters matching search_tsv '
  '(p_variants: up to six en_US spellings of 083, ORed; a missing one repeats the '
  'first; the app sends at most three per call) or the folded index (p_folded = foldTr(query), phrase-free), as two '
  'separate index scans. Guard (166): a typed word whose turkish stem over-cuts it '
  '(stem shorter than the word and at most 4 characters: burdur -> bur) must also '
  'appear, by its first letters, at a word start in the title or summary; a word that '
  'is its 3-4 letter root plus a case or plural suffix (irakta -> irak + ta, kirada, '
  'zamlar, miller -> mil + ler) is exempt and not guarded; the guard is skipped for '
  'queries with an OR or a negated phrase, and reads p_folded only. Tier (172): the '
  'exempt words only RE-ORDER: a row whose title, neutral title or summary has every '
  'exempt word at a word start (apostrophes deleted) ranks above a row that holds only '
  'the stem (bartin: Bartin before Bart De Wever); no row is dropped, and a query '
  'without an exempt word is in one tier. Siblings (185): when the typed call leaves '
  'the page short, the app asks a second call for the root spellings of a possessive '
  'or doubled-stem term (zammi -> zam, vergisi -> vergi) and appends its new ids, so '
  'the headline form of the noun is found. The 1000 most recently '
  'updated survivors are scored. Order: tier first, then literal word-start title '
  'hits (weight 2.0), then title relevance (1.0) plus recency (0.5, 7-day scale); '
  'article_count only breaks ties. Returns ids ONLY. service_role only.';

revoke all on function public.search_cluster_ids(text[], text, integer) from public, anon, authenticated;
grant execute on function public.search_cluster_ids(text[], text, integer) to service_role;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('185', '185_search_sibling_variants')
  on conflict do nothing;

commit;
