-- 172_search_exempt_word_tier.sql
--
-- Archive search ranks the real rows of a name-shaped word above its stem collisions. One function replaced, with the
-- same signature: public.search_cluster_ids(p_variants text[], p_folded text, p_limit integer default 12). The body is
-- 166's body plus ONE ranking tier and nothing else: the words that 166 EXEMPTS from its over-stem guard (a 3-4 letter
-- root plus a case or plural suffix: miller = mil + ler, bartin = bart + in, saniye = sani + ye, and 166's own irakta
-- and zamlar) put the rows whose text really holds the typed word, at a word start, ahead of the rows that only share
-- its stem. Rows are re-ordered, never dropped: recall is 166's. No table, column, index, trigger, cron job, grant or
-- data change; 083's two-argument function (the PGRST202 fallback of src/lib/clusters/search-query.ts) is not touched;
-- no app change (h58-postship-1, hunt 58, 2026-11-07).
--
-- WHY (evidence: production, read-only, 2026-11-07)
--   * 166 exempts a word when ts_lexize gives it a 3-4 letter stem that starts the word and what is left is a case or
--     plural suffix (irakta = irak + ta), because guarding such a word emptied the archive. The same shape fits names:
--     miller = mil + ler, bartin = bart + in, saniye = sani + ye (ts_lexize: 'mil', 'bart', 'sani'). Their guard set is empty, so every row with
--     ANY word of that stem is a candidate, and 129's literal tier (weight 2.0) only RE-ORDERS: LIMIT 24 is filled from
--     the stem-only tail.
--   * miller (['miller'], 'miller'): 18 rows, 15 of them Milli Enerji, '70 mil teklifi', Mili Egitim and similar. Only
--     fb8e464a (rank 1), 767ba64a (rank 16) and ed35845e (rank 18) hold 'miller': the real rows sit at ranks 16 and 18.
--   * bartın (['bartın', 'bartin'], 'bartin'): the archive has 18 Bartın stories. 166's top 24 shows 16 of them (ranks
--     27 and 32 are cut) and 8 stem collisions in their place: Belgian De Wever stories (bart), Ronen Bar (bar) and
--     others. The folded 'bartin' is exempt (bart + in), and the variants arm stems 'bartın' to 'bar' and is never
--     guarded: the guard reads p_folded only (166_search_overstem_guard.sql, the g0 and g steps).
--   * saniye (sani + ye): 9 of the 24 rows are Al Sani.
--   * Ordering alone fixes it. A tier simulation on the RPC output at limit 50 put the real miller rows at ranks 1-3, all
--     18 Bartın rows in the top 24, and only rows with the word in the top 24 of saniye; the replay below runs this body.
--
-- WHAT
--   gx and ge. 166's g step is cut in three CTEs without changing its result. gx keeps the word split, the stem, the
--   over-cut test (stem shorter than the word and at most 4 letters), the exemption predicate (now the column ex) and
--   both switches. g (the guard set) reads the rows with ex false, exactly as 166. ge (new) reads the rows with ex true:
--   the distinct folded words that 166 exempts. The exemption has one text and one constant pattern (no backslash),
--   read by g and ge alike. ge is empty under the same two switches that empty g: an `or` token (the alias expansion
--   of search-aliases.ts) and a negated phrase (-").
--   lit_ok, in hits. True when every ge word starts a word of the cluster text, and true when ge is empty. The text is
--   the title, the neutral title and the summary with the apostrophes (U+0027 and U+2019) deleted, then folded: a title
--   with Irak'ta, Miller'in or Bartin'da counts. A word start is ' ' || text searched for ' ' || word; strpos only, no
--   user text reaches a regex. The cheap probe runs on the folded text and the exact test (every run of non-[a-z0-9]
--   turned into one space) only where the word occurs but not after a space (a quote, a hyphen), the 166 idiom, so a
--   row that only holds the stem never reaches the regexp. The word holds no space, so a word start of the joined
--   text is a word start of one piece: lateral a holds the title and neutral title (their fold is ftitle, folded once,
--   apostrophes deleted from it) and lateral b the summary, folded only for a hit whose title does not already hold
--   every exempt word, and never when ge is empty (a plain query costs what it cost).
--   ORDER BY. It starts with (case when lit_ok then 0 else 1 end). After it come 166's score expression,
--   article_count desc, updated_at desc and id, and the same limit clause, byte for byte. The tier RE-ORDERs and is
--   never a filter: rows are never dropped, the 1000-row cap and the guard are 166's, and a query with no exempt word
--   has every row in the same tier, so its list is 166's. The guard, cand, kept and top text is 166's, unchanged.
--
-- KNOWN LIMITS
--   (1) The tier re-orders, it does not remove: stem-collision rows still fill the tail when fewer real rows exist
--       (miller keeps 15 after its 3). (2) 166's 1000-row candidate cap is unchanged: a real row older than the
--       1000th kept candidate is not seen. (3) hamidi is out of scope: its stem is not over-cut ('hamidi', 166's known
--       limit 3) and its rows hold "Hamid'i". (4) The 4-letter prefix floor of the guard is out of scope: raising it
--       would cut inflected short-stem queries (the sub-claim about seniz); the name is rare.
--   (5) REJECTED: a row-dropping rule (drop a row that lacks the exempt word's own prefix). Replayed on production it
--       regresses the inflected roots that 166 documents: natonun 24 -> 1, atesi 24 -> 6, faize 24 -> 14, ilaci 24 -> 19,
--       zamlar 24 -> 19. The tier keeps all those rows and only fixes their order.
--   (6) The tier applies to every exempt word, 166's inflected roots included: for irakta, natonun, faize, karsta, ilaci
--       and atesi the rows with a word STARTING with the typed form come first. The test is a word-start prefix after
--       the apostrophes are deleted, so irakta also lifts Irak'tan / Irak’tan rows (iraktan) and iranda lifts
--       İran'dan rows, while an Irak story with no such word (Irak Başbakanı) ranks below them. A row that holds the
--       word only in its summary now beats a row that holds the stem in its title.
--   (7) Cost of the tier: the summary is folded for each hit whose title lacks an exempt word; translate() dominates
--       (about 30 microseconds for an average summary). A query with 1000 hits and few real rows pays about 30 ms.
--
-- PRODUCTION FINGERPRINT THE REPLACE WAS BASED ON (read-only, 2026-11-07, pg_proc)
--   public.search_cluster_ids(text[], text, integer): LANGUAGE sql, STABLE, SECURITY DEFINER, SET search_path TO '',
--   returns TABLE(id uuid), owner postgres, the other overload is 083's search_cluster_ids(text[], integer).
--   md5(prosrc) = d7f4b4223730e06db8479f42776d8040 (length 9680), which is the body of 166_search_overstem_guard.sql
--   (the test recomputes it). proacl = {postgres=X/postgres,service_role=X/postgres}.
--   new md5(prosrc): 192218b7b6a56b3c8fcc48d5e0610a2c (length 12913)
--
-- REPLAY (production, SELECT only through sbq.py, 2026-11-07; 166's body and this file's body run inline with literal
--   arguments, exactly as src/lib/clusters/search-query.ts builds them, in ONE statement so now() is shared, p_limit 50,
--   the RPC's own cap, so rows 25-50 can be seen; the app sends p_limit 24 (SEARCH_LIMIT, src/lib/clusters/search-query.ts),
--   the top 24 shown). The cap of 50 is lifted inline (1000) for the partition check of the exempt queries.
--   typed            rows 166 -> 172     real rows in the top 24 (the typed word at a word start), 166 -> 172
--   miller              18 -> 18         3 -> 3 of 3: their ranks 1, 16, 18 -> 1, 2, 3 (fb8e464a, 767ba64a, ed35845e); the 15 others keep 166's order
--   bartın (2 spellings) 32 -> 32        16 -> 18 of 18: ranks 1-10, 15, 18, 21-24, 27, 32 -> 1-18; out of the top 24: 36266e30 (De Wever) and 311d8ad0 (Ronen Bar)
--   bartin (ASCII)      23 -> 23         18 of 18 first of 23 (166: ranks 1-10, 15, 16, 18-23)
--   saniye              50 -> 50         15 -> 24 of 24 carry saniye, the 9 Al Sani rows leave the top 24; uncapped 91 rows, same set
--   zamlar              50 -> 50         8 -> 16; uncapped 128 rows, same set
--   irakta              50 -> 50         6 -> 24; uncapped 220 rows, same set
--   kirada              50 -> 50         no row holds a word starting kirada: one tier, identical top 24 (uncapped 74 rows)
--   natonun             50 -> 50         3 -> 24; uncapped 692 rows, same set
--   faize               50 -> 50         9 -> 14; uncapped 118 rows, same set
--   okulda              50 -> 50         24 -> 24, identical top 24; uncapped 666 rows, same set
--   karsta              50 -> 50         6 -> 13; uncapped 90 rows, same set
--   ilaci               50 -> 50         15 -> 19; uncapped 90 rows, same set
--   atesi               50 -> 50         4 -> 6; uncapped 165 rows, same set
--   For every row above 172's uncapped list equals 166's uncapped list stably partitioned by the tier (the rows with the
--   word, in 166's order, then the rest), the same ids; where 166 returns fewer than 50 rows the ids are the same
--   (in this 50-row replay; the app's 24-row page still changes for an exempt query with more than 24 rows, e.g. bartın).
--   No exempt word (the guard or the stem decides; one tier): identical top 24 AND identical 50-row list
--   burdur 33 rows, ersan 3, ilhan 26, tarla 11, ığdır / iğdır / igdir 29 (the three spellings), iran 50, seçim 50, şişli 34,
--   sancaktepe 12, putin 50, akp ("akp or ak parti") 50, "ak parti" 50, chp 50, meclis 50, enflasyon 50, istanbul 50,
--   ankara 50, imamoğlu 50, erdoğan 50: identical top 24 for every one of them.
--
-- COST (production, EXPLAIN (ANALYZE, BUFFERS), the 166 body inline vs this body inline, alternated in one session, warm,
--   medians of 5 runs, ms, 2026-11-07; the gate is 1.3x)
--   miller       4.49 ->   5.41  (1.20x)   18 hits
--   bartin       5.93 ->   6.92  (1.17x)
--   saniye      12.99 ->  14.58  (1.12x)
--   zamlar      17.87 ->  21.07  (1.18x)   128 hits
--   irakta      29.86 ->  33.34  (1.12x)   220 hits
--   kirada      11.78 ->  14.17  (1.20x)   exempt, but no row holds the word: every hit folds its summary
--   iran       169.56 -> 152.26  (0.90x)   seçim 167.79 -> 152.09 (0.91x)   burdur 35.08 -> 31.26 (0.89x)
--   erdoğan    150.42 -> 131.36  (0.87x)   şişli 5.93 -> 5.75 (0.97x)   (no exempt word: ge is empty, the tier costs nothing)
--   iran and seçim stay within 1.3x of 166 (they are faster: 166 evaluated ts_lexize twice in g). The first draft folded
--   title + neutral title + summary of EVERY hit (one more fold per hit): miller 3.95 -> 6.53 ms (1.67x), zamlar
--   17.55 -> 30.69 (1.75x). Folding the title once (ftitle, shared) and the summary only for a hit whose title lacks the
--   word brought it to the table above. translate() is the cost: 1000 average summaries fold in about 28 ms.
--
-- LEDGER: this file records version 172 in supabase_migrations.schema_migrations itself, idempotently (the 095
-- pattern: insert ... on conflict do nothing, last statement before commit), so applying it by posting the SQL
-- (management API or psql) leaves `supabase migration list` correct; `supabase db push` records the same row.
-- Re-applying is harmless (create or replace, and the ledger insert does nothing the second time).
--
-- VERIFY (read-only, after applying)
--   1. select md5(p.prosrc), length(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
--      expect 192218b7b6a56b3c8fcc48d5e0610a2c, 12913.
--   2. select pg_catalog.has_function_privilege('anon', 'public.search_cluster_ids(text[], text, integer)', 'execute'), pg_catalog.has_function_privilege('service_role', 'public.search_cluster_ids(text[], text, integer)', 'execute');
--      expect false, true.
--   3. select count(*) from public.search_cluster_ids(array['miller'], 'miller', 24);  expect 18, the three rows that hold
--      miller first; array['bartın','bartin'] with 'bartin' -> the 18 Bartın rows are the first 18 of 24, and no De Wever
--      row is among them; array['saniye'] with 'saniye' -> 24 rows that all hold saniye; array['burdur'] -> 33 rows,
--      unchanged; array['iran'] -> the same top 24 as before.
--   4. explain (analyze) select * from public.search_cluster_ids(array['iran'], 'iran', 24); expect about 150 ms
--      (166: about 170 ms).
--   5. GET /?q=miller shows the Miller stories first; /?q=bartın has no De Wever card in its first 18; /?q=iran,
--      /?q=seçim and /?q=şişli are unchanged.
--
-- ROLLBACK (nothing depends on 172; one transaction): re-run the function statement AND the `comment on function
--   public.search_cluster_ids(text[], text, integer)` statement of 166_search_overstem_guard.sql (lines 317-330; create
--   or replace keeps 172's comment otherwise) (the 166 body, md5 d7f4b4223730e06db8479f42776d8040), then
--   delete from supabase_migrations.schema_migrations where version = '172';
--   notify pgrst, 'reload schema';
-- 083's search_cluster_ids(text[], integer) and the app's PGRST202 fallback are not involved.
--
-- See tests/migrations/172-search-exempt-word-tier.test.ts and tests/migrations/sql/172-search-exempt-word-tier-dryrun.sql.

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
  'guard of migration 166 and the exempt-word tier of migration 172. Candidates: live '
  'clusters matching search_tsv (p_variants, the en_US spellings of 083) or the folded '
  'index (p_folded = foldTr(query), phrase-free), as two separate index scans. Guard '
  '(166): a typed word whose turkish stem over-cuts it (stem shorter than the word and '
  'at most 4 characters: burdur -> bur) must also appear, by its first letters, at a '
  'word start in the title or summary; a word that is its 3-4 letter root plus a case '
  'or plural suffix (irakta -> irak + ta, kirada, zamlar, miller -> mil + ler) is '
  'exempt and not guarded; the guard is skipped for queries with an OR or a negated '
  'phrase. Tier (172): the exempt words only RE-ORDER: a row whose title, neutral title '
  'or summary has every exempt word at a word start (apostrophes deleted) ranks above a '
  'row that holds only the stem (bartin: Bartin before Bart De Wever); no row is '
  'dropped, and a query without an exempt word is in one tier. The 1000 most recently '
  'updated survivors are scored. Order: tier first, then literal word-start title hits '
  '(weight 2.0), then title relevance (1.0) plus recency (0.5, 7-day scale); '
  'article_count only breaks ties. Returns ids ONLY. service_role only.';

revoke all on function public.search_cluster_ids(text[], text, integer) from public, anon, authenticated;
grant execute on function public.search_cluster_ids(text[], text, integer) to service_role;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('172', '172_search_exempt_word_tier')
  on conflict do nothing;

commit;
