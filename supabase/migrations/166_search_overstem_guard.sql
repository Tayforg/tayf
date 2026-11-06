-- 166_search_overstem_guard.sql
--
-- Archive search stops filling its result with stem collisions. One function replaced, with the same signature:
-- public.search_cluster_ids(p_variants text[], p_folded text, p_limit integer default 12). The body is 129's body plus
-- one guard and nothing else: a typed word whose Turkish stem over-cuts it must also show up, by its first letters, at
-- a word start in the title, the summary or the neutral title of every row that is kept. A word that is a root plus a
-- case or plural suffix (irakta, kirada, zamlar) is not guarded. No table, column, index, trigger, cron job, grant or
-- data change; 083's two-argument function (the PGRST202 fallback of src/lib/clusters/search-query.ts) is not
-- touched; no app change (h50-search-1, hunt 50, 2026-11-06).
--
-- WHY (evidence: production, read-only, 2026-11-06 12:30-13:40Z)
--   * The Turkish snowball stemmer cuts some words to two or three letters: ts_lexize('turkish_stem', ...) gives
--     burdur -> bur, ersan/ersin -> er, ilhan -> ilha, tarla -> tar, putin -> put, iran -> ira, seçim -> seç, and for
--     Iğdır igdir -> igi, ığdır -> ık, iğdir -> ik (the three spellings turkishQueryVariants sends). Every row that holds
--     ANY word with that stem is a candidate of 129's cand CTE, and 129's literal word-start tier (weight 2.0) only
--     RE-ORDERS: LIMIT 24 is then filled from the stem-only tail.
--   * /?q=burdur: 24 results, 14 of them Bursa, Bulgaristan and "burun buruna" stories. ersan: 22 of 24 were "erken
--     seçim" and "sona erdi" rows. ilhan: 11 of 24 were İlham Aliyev and "ilham olacak". ığdır: 14 of 24 were an
--     emekli zam, a Babacan fon and a Bitcoin story. tarla: 18 of 24 were Tarım ve Orman Bakanlığı.
--
-- WHAT
--   The guard words. The folded query (p_folded) is cut on whitespace into tokens, then each token on [^a-z0-9] into
--   words (a token starting with '-' is a negation and is left out). A word is GUARDED when
--       length(stem) < length(word)  and  length(stem) <= 4  and  it is not EXEMPT,
--       stem = (ts_lexize(turkish_stem, word))[1]
--   i.e. its stem over-cuts it. Its prefix is  pre = left(word, least(length(word), greatest(4, length(stem) + 1))):
--   one letter past the stem, at least four letters (burdur -> burd, ersan -> ersa, ilhan -> ilhan, igdir -> igdi,
--   putin -> puti, iran -> iran, seçim -> seci). A word with a longer stem (şişli, sancaktepe, enflasyon, imamoğlu) or
--   no stem at all (a stop word) is not guarded, so a query without a guarded word runs exactly as 129 does. The
--   guard words are a SET (select distinct): a word typed several times is one guard row.
--   The EXEMPTION (inflected roots). A word is EXEMPT, and so not guarded, when its stem has 3 or 4 letters, the FOLDED
--   stem is the start of the word, what is left of the word is a Turkish case, plural or relative suffix, and a
--   3-letter stem is followed by a suffix of 3 or more letters:
--       irakta = irak + ta     kirada = kira + da     natonun = nato + nun     faize = faiz + e
--       okulda = okul + da     zamlar = zam + lar     ilaci = ilaç + i (folded stem ilac)     atesi = ates + i
--   The word IS the root and the suffix is grammar, so demanding 'irakt' of a row that says "Irak'ta" (which the
--   fold turns into 'irak ta') emptied the archive for ordinary apostrophe-less queries. With the exemption left out
--   the result counts fell from 24 to 0 for irakta, 0 for kirada, 1 for natonun, 14 for faize and 19 for zamlar.
--   The stem MUST be folded before it is compared with the ASCII word: ts_lexize returns 'ilaç' for ilaci and 'seç'
--   for secim. The suffix list is one constant pattern (no backslash),
--   y?[ae] | n[ae] | y?[iu] | n?[iu]n | [dt][ae](n|ki)? | n[dt][ae](n|ki)? | y?l[ae] | l[ae]r[a-z]*, applied to the
--   folded tail of the word and nothing else. A 3-letter stem needs 3 or more suffix letters because tarla
--   (tar + la) and putin (put + in) are exactly the junk the guard exists for. A stem that is the whole word is
--   not accepted (measured on production: bakam 465 -> 680 ms, and 2 junk standalone 'tar' rows in tarla).
--   The guard is OFF (an empty guard set) when a token is `or` (the alias expansion of search-aliases.ts joins the
--   spellings of an alias with ' or ', and a disjunct need not hold every word) and when the query holds a negated
--   phrase (-"), whose later words are not required by the row.
--   The row check. A candidate is kept when, for EVERY guard prefix, the folded text of its title, or the folded text
--   of its summary plus its neutral title, has the prefix at a WORD START: strpos(' ' || text, ' ' || pre) > 0, or,
--   when the prefix occurs but not after a space (a quote, a hyphen, a bracket), the same test on the text with every
--   run of non-[a-z0-9] turned into one space. That is 129's folded text (title_tr_neutral || ' ' || title_tr || ' ' ||
--   summary_tr) with the same regexp_replace as the literal tier, taken in two pieces (the pieces are joined by a
--   space and a prefix holds no space, so a word start in the joined text is a word start in one piece; the fold is
--   character-wise, so the fold of summary || ' ' || neutral is the two folds joined): the test equals the one-string
--   form of the prototype, which the test file models over 4000 random texts. No user text reaches a regex; the
--   patterns are constants and `pre` only ever goes through strpos.
--   Where it sits. `kept` stands between `cand` and `top`, and `top` reads it: the 1000 most recently updated rows
--   that SURVIVE the guard are scored, so the junk no longer eats the slots (ığdır has 1,357 candidates and 29 real
--   ones; a guard after the cap would drop the real ones older than the 1000th candidate). `kept` walks the candidates
--   newest first (a sorted subquery, offset 0 keeps it whole) and `top` stops after 1000 survivors. When survivors are
--   plentiful (bakan: 6,319 candidates) the walk stops early; when few survive it visits every candidate (bakam: stem
--   'baka', 6,319 candidates, no row has a word starting 'bakam'; ayse: stem 'a', 3,577 candidates), because the
--   1000th survivor never comes. The cluster is read by primary key in a fenced subquery (r, offset 0): without the
--   fence a LOCAL dry-run planned the lookup as a Seq Scan, because regexp_split_to_table makes the planner expect
--   108,900 guard rows and a first-row cost then favours the scan; with it the plan does not depend on that estimate.
--   The scoring, the order by and the limit are 129's, byte for byte.
--   BOUNDED WORK. 129's bound is kept: at most 1000 rows are scored. The guard adds the rows it has to read to find
--   1000 survivors, each a primary-key read plus at most two folds per candidate, whatever the number of guard words:
--   one fold of the title (lateral subquery a) and, only when some guard prefix is not in the title, one fold of the
--   summary plus the neutral title (lateral subquery b). Every guard prefix is then compared with those two values; no
--   fold sits inside a subquery that reads the guard set, which would run once per (candidate, guard row). A query
--   with few survivors reads ALL its candidates, however broad: burdur keeps 32 of 335 and then scores 32 instead of
--   335, which pays for it; bakam and ayse (a broad stem and a rare prefix) keep almost none and cost 2.9x and 1.9x of
--   129 (cost table: the known worst case, above the 1.3x gate, far under the statement timeout). That is a deliberate
--   recall choice: a cap on the candidates would drop older real rows (the ığdır argument above), and skipping the
--   guard for a one-letter stem would let ayse -> 'a' back in, which is the junk the guard exists for.
--   KNOWN LIMITS. (1) The 1000-row cap itself is unchanged. (2) An OR query ('ersan or burdur', an alias) is not
--   guarded: it runs as 129. (3) Only over-cut stems are guarded; a word whose stem is long is a stem match as before.
--   (4) A word that the folded arm and the variants arm match by stem but that only occurs mid-word in a row
--   (Akburdan for burdur) is dropped, which is the intent. (5) A stem of 3 letters or fewer followed by a 2-letter
--   suffix stays guarded: yolda (yol + da), evde (ev + de) and zamla (za + la) demand their own prefix of a row, so
--   yolda loses 2 of 129's 24; tarla (tar + la) shows why the line cannot move: the same shape is the Tarım ve Orman
--   junk. (6) The few-survivor worst case of the cost table (bakam, ayse) is slower than 129 by design.
--
-- PRODUCTION FINGERPRINT THE REPLACE WAS BASED ON (read-only, 2026-11-06, pg_get_functiondef + pg_proc)
--   public.search_cluster_ids(text[], text, integer): LANGUAGE sql, STABLE, SECURITY DEFINER, SET search_path TO '',
--   returns TABLE(id uuid), owner postgres, the other overload is 083's search_cluster_ids(text[], integer).
--   md5(prosrc) = cb7fee8680c50e8f20bafab3e29fef39 (length 3426), which is the md5 of the text between the $fn$
--   markers of 129 section 3 (the test recomputes it). proacl = {postgres=X/postgres,service_role=X/postgres}.
--   new md5(prosrc): d7f4b4223730e06db8479f42776d8040 (length 9680)
--
-- REPLAY (production, SELECT only through sbq.py, 2026-11-06; the 129 body and this file's body run inline with
--   literal arguments, exactly as src/lib/clusters/search-query.ts builds them for the typed query)
--   typed       candidates -> kept     top 24 (129 -> 166)
--   burdur           335 ->   32       24 -> 24, 14 Bursa/Bulgaristan rows gone, Burdur rows first
--   ersan            531 ->    3       24 ->  3 (the Ersan rows only; the 22 erken secim / sona erdi rows gone)
--   ilhan             95 ->   26       24 -> 24, 11 Ilham rows gone
--   tarla            322 ->   11       24 -> 11 (18 Tarım ve Orman Bakanı rows gone)
--   ığdır (3 spellings) 1,357 -> 29    24 -> 24, 14 unrelated rows gone (Babacan fon, emekli zam, Bitcoin ...)
--   igdir (ASCII)     29 ->   29       identical
--   iran           1,995 -> 1,932      identical top 24 (the 63 dropped rows are Irak matches)
--   seçim          1,604 -> 1,593      identical top 24
--   şişli             34 ->   34       identical (not guarded)
--   sancaktepe        12 ->   12       identical (not guarded)
--   putin            130 ->  130       identical (guarded, every row has Putin)
--   akp or "ak parti" 2,748 -> 2,748   identical (OR: guard off)
--   chp 4,699, meclis 2,533, enflasyon 173, istanbul 2,978, ankara 2,249, imamoğlu 577, erdoğan 3,790:
--                     unchanged, identical top 24 (not guarded)
--   The inflected roots (the exemption; the guard set is empty, so the body runs as 129 does):
--   irakta         exempt (irak + ta)      24 -> 24, identical to 129 (this file without the exemption: 0 results)
--   kirada         exempt (kira + da)      24 -> 24, identical to 129 (without the exemption: 0)
--   natonun        exempt (nato + nun)     24 -> 24, identical to 129 (without the exemption: 1)
--   faize          exempt (faiz + e)       24 -> 24, identical to 129 (without the exemption: 14)
--   okulda         exempt (okul + da)      24 -> 24, identical to 129
--   zamlar         exempt (zam + lar)      24 -> 24, identical to 129 (without the exemption: 19)
--   karsta, ilaci, atesi: exempt (kars + ta, ilaç + i, ates + i), identical to 129 (without the exemption: 0, 19, 6)
--   yolda          guarded (yol + da)      24 -> 24, loses 2 of 129's 24 (the known limit (5))
--   The queries above that the exemption does not touch (burdur, tarla, ersan, ilhan, ığdır, iran, seçim, putin) return
--   the same top 24 as before the exemption. For burdur, ersan, ilhan, tarla, ığdır, iran and seçim the kept count
--   equals the number of candidates whose folded title || summary has a word starting with pre under the prototype's
--   one-string formula, counted as hits in the title plus further hits in the summary (32 = 10 + 22, 3 = 2 + 1,
--   26 = 13 + 13, 11 = 4 + 7, 29 = 13 + 16, 1,932 = 1,420 + 512, 1,593 = 1,139 + 454), so the kept set holds every row
--   where the typed word starts a word.
--
-- COST (production, EXPLAIN (ANALYZE), the 129 body inline vs this body inline, medians of 5 to 9 runs, ms, 2026-11-06)
--   iran        127.8 -> 165.1  (1.29x)  guarded, 1,995 candidates
--   seçim       128.7 -> 164.7  (1.28x)  guarded, 1,604 candidates
--   bakan       155.9 -> 194.0  (1.24x)  6,319 candidates, the guard stops after about 1000 survivors
--   dolar        82.1 ->  91.8  (1.12x)
--   putin        17.3 ->  22.3  (1.29x)  130 candidates, an absolute +5 ms
--   burdur       41.8 ->  30.4  (0.73x)  ersan 66.9 -> 42.0 (0.63x)   ığdır 125.4 -> 106.2 (0.85x)   tarla 41.5 -> 27.5 (0.66x)
--   ilhan        13.1 ->  12.1  şişli 5.6 -> 6.0   chp 147.1 -> 147.2   '-qwxz' (30.5k rows) 382.4 -> 382.7 (1.00x)
--   irakta       37.5 ->  29.4  kirada 10.6 -> 13.6   zamlar 17.2 -> 17.6   (exempt: the guard set is empty, 129's cost)
--   The gate of h50-search-1 is 1.3x on iran, seçim and bakan; all three pass. The queries the guard does not touch keep
--   their plan. The local dry-run (12,000 synthetic clusters) prints the same comparison for iran, seçim, bakan,
--   irakta, kirada and zamlar, and fails if the guard is run over every candidate or if a repeated word costs more than
--   1.3x the query with each distinct word once.
--   WORST CASE, above the 1.3x gate (few survivors, broad stem: every candidate is visited, almost none is kept):
--   bakam       152.3 -> 444.4  (2.92x)  stem 'baka', 6,319 candidates          ayse 145.3 -> 268.4 (1.85x)  stem 'a', 3,577 candidates
--   Both stay far under the statement timeout; the dry-run prints the bakam case as a few-survivor notice, never a failure.
--   Repeated words (SEC-h50-1), 129 -> the first draft of this file (one correlated fold per guard row) -> this body:
--   bakan bakan bakan bakan bakam -x17    163.0 -> 1,200 -> 445   a 6-term query that fits MAX_SEARCH_TERMS; -xN busts the cache
--   bakan,bakan,...,bakan,bakam (comma form, 9 x bakan)   196.1 -> 1,159 -> 301
--   bakan bakan bakan bakan bakan bakada  163.6 -> 1,386 -> 209
--   A repeated word is now one guard row and each candidate folds at most twice, so these cost what the single rare word
--   costs (bakam alone: 444 ms).
--
-- LEDGER: this file records version 166 in supabase_migrations.schema_migrations itself, idempotently (the 095
-- pattern: insert ... on conflict do nothing, last statement before commit), so applying it by posting the SQL
-- (management API or psql) leaves `supabase migration list` correct; `supabase db push` records the same row.
-- Re-applying is harmless (create or replace, and the ledger insert does nothing the second time).
--
-- VERIFY (read-only, after applying)
--   1. select md5(p.prosrc), length(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
--      expect d7f4b4223730e06db8479f42776d8040, 9680.
--   2. select pg_catalog.has_function_privilege('anon', 'public.search_cluster_ids(text[], text, integer)', 'execute'), pg_catalog.has_function_privilege('service_role', 'public.search_cluster_ids(text[], text, integer)', 'execute');
--      expect false, true.
--   3. select count(*) from public.search_cluster_ids(array['burdur'], 'burdur', 24);  expect 24, all with Burdur;
--      array['ersan'] -> about 3; array['iran'] -> 24 (unchanged); array['irakta'] -> 24 (the Irak stories, as 129).
--   4. explain (analyze) select * from public.search_cluster_ids(array['iran'], 'iran', 24); expect about 165 ms
--      (129: about 130 ms).
--   5. GET /?q=burdur and /?q=ersan show no Bursa and no erken-seçim cards; /?q=şişli is unchanged;
--      /?q=irakta and /?q=kirada show their Irak and Kira stories (they were empty in the first draft).
--
-- ROLLBACK (nothing depends on 166; one transaction): re-run ONLY the function statement of section 3 of
-- 129_search_fold_rank.sql (the original body, md5 cb7fee8680c50e8f20bafab3e29fef39), then
--   delete from supabase_migrations.schema_migrations where version = '166';
--   notify pgrst, 'reload schema';
-- 083's search_cluster_ids(text[], integer) and the app's PGRST202 fallback are not involved.
--
-- See tests/migrations/166-search-overstem-guard.test.ts and tests/migrations/sql/166-search-overstem-guard-dryrun.sql.

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
  ), g as (
    -- 166 guard, step 2: the words whose stem over-cuts them. Each token is cut into [a-z0-9]
    -- words; a word is guarded when the turkish stem is shorter than the word and at most 4
    -- characters long (burdur -> bur, ersan -> er, ilhan -> ilha, igdir -> igi). pre is the
    -- prefix a row must show at a word start: one letter past the stem, at least 4 letters.
    -- A word is EXEMPT (not guarded) when its 3-4 letter stem is its own root, i.e. the word is
    -- the stem plus a Turkish case or plural suffix: irakta -> irak + ta, kirada -> kira + da,
    -- natonun -> nato + nun, faize -> faiz + e, zamlar -> zam + lar. Such a word is the root
    -- itself, and guarding it would demand 'irakt' of rows that say "Irak'ta". The stem is
    -- FOLDED before it is compared with the (ASCII) word: ts_lexize gives 'ilaç' for ilaci and
    -- 'seç' for secim. A 3-letter stem needs a suffix of 3 or more letters, so tarla (tar + la)
    -- and putin (put + in) stay guarded. The pattern is a constant with no backslash; the folded
    -- tail of the word is its only subject. select distinct: a word typed several times is one
    -- guard row, not one per copy.
    -- The guard set is empty (nothing is checked, 129's behaviour) when a token is `or`
    -- (the alias expansion joins its spellings with ' or ') or the query holds a negated
    -- phrase (-"), whose later words are not required.
    select distinct pg_catalog.left(x.w, least(pg_catalog.length(x.w), greatest(4, pg_catalog.length(x.st) + 1))) as pre
    from (
      select s.w, (pg_catalog.ts_lexize('pg_catalog.turkish_stem'::pg_catalog.regdictionary, s.w))[1] as st
      from g0
      cross join lateral pg_catalog.regexp_split_to_table(g0.tok, '[^a-z0-9]+') as s(w)
      where s.w <> ''
    ) x
    where x.st is not null
      and pg_catalog.length(x.st) < pg_catalog.length(x.w)
      and pg_catalog.length(x.st) <= 4
      and not (pg_catalog.length(x.st) between 3 and 4
               and pg_catalog.left(x.w, pg_catalog.length(x.st)) = public.tayf_search_fold(x.st)
               and (pg_catalog.length(x.st) = 4 or pg_catalog.length(x.w) - pg_catalog.length(x.st) >= 3)
               and pg_catalog.substr(x.w, pg_catalog.length(x.st) + 1) ~ '^(y?[ae]|n[ae]|y?[iu]|n?[iu]n|[dt][ae](n|ki)?|n[dt][ae](n|ki)?|y?l[ae]|l[ae]r[a-z]*)$')
      and not exists (select 1 from g0 where pg_catalog.regexp_replace(g0.tok, '[^a-z0-9]+', '', 'g') = 'or')
      and not exists (select 1 from f0 where pg_catalog.strpos(f0.ff, '-"') > 0)
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
  'two-argument function for src/lib/clusters/search-query.ts) with the over-stem '
  'guard of migration 166. Candidates: live clusters matching search_tsv '
  '(p_variants, the en_US spellings of 083) or the folded index (p_folded = '
  'foldTr(query), phrase-free), as two separate index scans. Guard (166): a typed '
  'word whose turkish stem over-cuts it (stem shorter than the word and at most 4 '
  'characters: burdur -> bur) must also appear, by its first letters, at a word '
  'start in the title or summary; a word that is its 3-4 letter root plus a case '
  'or plural suffix (irakta -> irak + ta, kirada, zamlar) is not guarded; the guard '
  'is skipped for queries with an OR or a negated phrase. The 1000 most recently '
  'updated survivors are scored. Order: literal word-start title hits first '
  '(weight 2.0), then title relevance (1.0) plus recency (0.5, 7-day scale); '
  'article_count only breaks ties. Returns ids ONLY. service_role only.';

revoke all on function public.search_cluster_ids(text[], text, integer) from public, anon, authenticated;
grant execute on function public.search_cluster_ids(text[], text, integer) to service_role;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('166', '166_search_overstem_guard')
  on conflict do nothing;

commit;
