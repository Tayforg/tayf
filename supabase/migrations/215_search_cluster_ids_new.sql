-- 215_search_cluster_ids_new.sql
--
-- Search archive: an "En yeni" (newest first) order, ?sirala=yeni (h191, hunt 191 on hunt 190's search lens, 2026-11-15). One function CREATED,
-- public.search_cluster_ids_new(p_variants text[], p_folded text, p_limit integer default 24, p_offset integer default 0): the newest clusters whose DISPLAY
-- TITLE literally holds the query, newest first, one page of at most 24 per call. Its body is the body of public.search_cluster_ids(text[], text, integer)
-- that production runs (migration 204's, md5 pinned below), whose candidate chain is kept character for character, with FIVE edits: `kept` is NOT MATERIALIZED,
-- `top` keeps the newest 150 survivors instead of 1000, two comment lines that named the 1000, `hits` is MATERIALIZED (the final ORDER BY must not be served from
-- idx_clusters_updated_at), and the final select (the literal-title filter, the date order and the limit and offset clamps) instead of 194's score. search_cluster_ids and search_cluster_ids_v2 (211) are not touched, dropped or replaced: the app still reads
-- the ranked order from them. No table, column, index, trigger, cron job or data change, no backfill, no UPDATE.
-- tests/migrations/215-search-cluster-ids-new.test.ts pins all of it, including "the body is 204's with those edits and nothing else".
--
-- WHY
--   The archive search ranks: literal-title tier, relevance, recency and corroboration over the 1000 newest candidates (194's ORDER BY). For most queries the rank
--   blends recency well, but for the hottest entity queries same-day stories fall off page 1 or beyond the 96 the four pages reach (hunt 190, read-only: Bakan has 43
--   stories updated in 24 h, 11 on page 1, 13 unreachable; Erdoğan has 16, 7 on page 1, 2 unreachable), and docs/FEATURE_ROADMAP.md records "there is still no date
--   sort". An app-side re-sort of the ranked top 96 would cost four ranked calls (about 100-145 ms each cold) and still could not reach a same-day story beyond rank
--   96. This function reads the newest stories directly, for one reader who asked for them, at a fraction of a ranked page's cost (COST below). It is read only when
--   the reader chooses "En yeni": GET /?q=...&sirala=yeni (src/lib/clusters/search-query.ts, every archive page 1 to 4; "En alakalı", the default, is untouched).
--
-- THE RULE
--   The candidates are the live function's: the three arms (the variants arm, the folded arm, 186's stem-fold arm), the 166 guard, 172's words and 194's literal tier
--   (lw and lit_d), all copied verbatim. `kept` is NOT MATERIALIZED, as h190 measured it, so the guard is applied to the candidates `top` asks for, newest first, and
--   the scan stops once `top` has its 150 survivors (the 150 newest survivors; 204 and 211 keep and score 1000). The final select keeps a row when lit_d holds (the query
--   has words and EVERY word, as a word-start prefix, starts a word of the display title: the neutral title when it has text, else the original one, the text on the card),
--   or when lw is empty. lw is empty for an alias or `or` query (AKP / AK Parti, afyon, urfa), a negated phrase, which the ranked order gives no literal tier either; a
--   plain `where h.lit_d` would list NO row for AKP, and the app's toggle would show a search with results as empty. The filter is what stops a loose summary-only match
--   from winning on freshness ('New York borsası yükselişle açıldı' for 'faiz kararı'). The order is updated_at desc, id (a total order: two pages never share a row), the
--   limit is least(greatest(coalesce(p_limit, 24), 1), 24), the offset greatest(0, least(coalesce(p_offset, 0), 72)): 4 pages of 24, the last starts at 72
--   (ARCHIVE_MAX_PAGE in src/lib/seo/home-canonical.ts). The list is the literal-title matches among the newest 150 survivors of the 166 guard, so it is often shorter than 96 rows
--   for an ordinary term (measured read-only 2026-11-15: tutuklandı 65, Trump 93, dolar 82, enflasyon 69, borsa 51), pages 3 and 4 can be short or empty (the app shows
--   'Bu sayfada sonuç yok.' for an empty page and no next link on a short one), and the ranked order still reaches 96. `hits` is MATERIALIZED: it joins public.clusters, and the
--   function is never inlined (SECURITY DEFINER, a set clause), so it is planned with p_limit and p_offset unbound; without the fence the planner walks idx_clusters_updated_at in recency
--   order for the final ORDER BY and stops only after offset+limit literal rows, which timed out (57014, 6 s cap) for Trump at offset 72 and for 'faiz kararı' at offset 0. hits is at most 150 rows.
--
-- STEP 0 -- the bodies this migration starts from (production, read-only, 2026-11-15)
--   select md5(p.prosrc), length(p.prosrc), p.proacl::text, p.prosecdef, p.provolatile from pg_proc p where p.proname = 'search_cluster_ids' and length(p.prosrc) = 22892;
--   -> 32b42ca06d6b0c2a3ba8bf1264d353f7, 22892, proacl {postgres=X/postgres,service_role=X/postgres}, prosecdef t, provolatile s, arguments (p_variants text[], p_folded text,
--      p_limit integer default 12). Its text equals the text between the dollar quotes of 204_search_single_letter_compounds.sql, character for character: this file is
--      built on the current one. search_cluster_ids_v2 (211): c91d45d81b53a71b007aa6de2d1a5ed7, 22945, the same proacl. The ledger holds 204 to 214 and 211 and 214 among them.
--      There is no search_cluster_ids_new yet. If a later release changes search_cluster_ids, compare again before applying.
--
-- REPLAY (production, SELECT only through a read-only transaction, 2026-11-15; this file's body inlined as plain SELECTs with p_variants and p_folded replaced by the
-- literals the app sends for the query, p_limit 24 and p_offset 0, 24, 48 and 72; the independent list is the same candidate predicate, the three arms and the 166 guard
-- UNBOUNDED, a hand-written display-title word-start test, order by updated_at desc, id)
--   query    rows (offset 0) | the first 24 ids equal the newest 24 literal matches | newest of the 24     | oldest of the 24
--   Erdoğan  24              | yes                                                  | 2026-11-15 04:43 UTC  | 2026-11-13 15:39 UTC
--   seçim    24              | yes                                                  | 2026-11-14 12:49 UTC  | 2026-11-10 07:25 UTC
--   Trump    24              | yes                                                  | 2026-11-14 17:46 UTC  | 2026-11-09 07:16 UTC
--   deprem   24              | yes                                                  | 2026-11-11 13:31 UTC  | 2026-10-23 14:46 UTC
--   Pages 1 to 4 (offsets 0, 24, 48, 72) of Erdoğan and of deprem are 4 x 24 rows, 96 distinct ids, equal to the newest 96 literal matches in order. Erdoğan: 17 stories
--   updated in the last 24 h hold the word in the title; page 1 of this order lists all 17, page 1 of the ranked order 7. The alias query (akp or "ak parti") lists 4 x 24 rows,
--   96 distinct ids, where a plain `where h.lit_d` listed 0 and the negated phrase (iran -"israil saldirisi") 0 (read-only, the same inline body with both tails).
--   The 96 holds for Erdoğan and deprem, not for every term (THE RULE above). The fence changes the plan, not the rows: the id lists of the materialized generic plan and of the
--   constant-limit plain body are identical for Trump at offsets 0 and 72, 'faiz kararı' at offset 0 and deprem at offset 48 (same count and md5), so the replay above stands.
--
-- COST (EXPLAIN (ANALYZE, BUFFERS) of the DEPLOYED shape, production, read-only, 2026-11-15, warm runs: set local plan_cache_mode = force_generic_plan; prepare s(text[], text, int, int)
-- as <this body with p_variants, p_folded, p_limit and p_offset replaced by $1 to $4>; explain (analyze, buffers) execute s(...), at offsets 0 and 72). The function is SECURITY DEFINER with a
-- set clause, so it is never inlined and is planned with p_limit and p_offset unbound: the earlier constant-limit EXPLAIN of the inline body did not describe the deployed plan, because
-- it was planned with the limit and offset as literals, a different plan from the one the function runs. The ranked page is search_cluster_ids at p_limit 24, what page 1 of every
-- search calls today; its figures are unchanged.
--   term     offset 0                 offset 72                buffers  ranked page 1
--   Erdoğan  65.2 ms (run 2)          55.2 and 63.7 ms         12,532   126.1 and 144.2 ms, 15,895
--   seçim    36.9 ms (run 2)          38.9 and 39.4 ms          6,308   142.0 and 144.0 ms, 13,103
--   Trump    28.1 and 31.4 ms         27.0 and 27.4 ms          4,424   112.5 and 121.1 ms,  7,787
--   deprem   25.8 and 26.5 ms         21.1 and 24.9 ms          2,025    44.1 and 45.0 ms,   3,156
--   A page costs about 0.2 to 0.6 times the ranked page in time and 0.5 to 0.8 times in buffers (it scores nothing and keeps 150 rows instead of 1000), and a later page costs what
--   page 1 costs (the offset applies after the sort). The first run on each term was cold (Erdoğan 141.5 ms with 84 buffers read, seçim 123.3 ms with 739 read; Trump and deprem had no cold
--   outlier): the warm runs above are the measure of record, as in h190. The app adds at most 4 cache entries per query, only for a reader who uses the toggle.
--
-- DEPLOY
--   APPLY 215 FIRST, THEN DEPLOY the app (docs/migration-guide.md: an RPC the app calls is applied before the deploy). The reverse order is safe but degraded: the app calls the
--   function for ?sirala=yeni, PostgREST answers PGRST202 (not in the schema cache, i.e. 215 unapplied) or any other error, and THAT request is answered in the ranked order (page 1 as
--   the ranked page 1, a later page as the ranked later page), one log line without the query, memoised for a few minutes only, so a page heals soon after 215 is applied. The
--   default order, "En alakalı", never calls this function.
--
-- VERIFY (read-only, after applying)
--   select md5(prosrc), length(prosrc) from pg_proc where oid = 'public.search_cluster_ids_new(text[], text, integer, integer)'::regprocedure;
--   -> c500964284801f3c83be9f4b73ec398a, 23628 (this file's body; search_cluster_ids stays 32b42ca06d6b0c2a3ba8bf1264d353f7, 22892 and search_cluster_ids_v2 c91d45d81b53a71b007aa6de2d1a5ed7, 22945)
--   select has_function_privilege('anon', 'public.search_cluster_ids_new(text[], text, integer, integer)', 'execute'),
--          has_function_privilege('authenticated', 'public.search_cluster_ids_new(text[], text, integer, integer)', 'execute'),
--          has_function_privilege('service_role', 'public.search_cluster_ids_new(text[], text, integer, integer)', 'execute');
--   -> false, false, true
--   select count(*) = 24 as full_page, bool_and(a.updated_at <= a.prev) as newest_first,
--          bool_and(strpos(' ' || regexp_replace(a.f, '[^a-z0-9]+', ' ', 'g'), ' depr') > 0) as literal_titles
--     from (select c.updated_at, lag(c.updated_at, 1, 'infinity'::timestamptz) over (order by x.ord) as prev,
--                  public.tayf_search_fold(coalesce(nullif(btrim(c.title_tr_neutral), ''), c.title_tr)) as f
--             from public.search_cluster_ids_new(array['deprem'], 'deprem', 24, 0) with ordinality x(id, ord) join public.clusters c on c.id = x.id) a;
--   -> true, true, true. Then, one request per second and after the cache entry is rebuilt: GET /?q=deprem&sirala=yeni lists 24 /cluster/ links newest first under "Arşivden: en yeni
--   24 sonuç" with "Sırala: En alakalı · En yeni" above them and "En yeni" the current one; &arsiv=2 lists 24 more; GET /?q=deprem is the ranked page it was; &sirala=other is ranked.
--
-- ROLLBACK (the app does not care whether the function exists)
--   drop function public.search_cluster_ids_new(text[], text, integer, integer);
--   delete from supabase_migrations.schema_migrations where version = '215';
--   notify pgrst, 'reload schema';
--   ?sirala=yeni then falls back to the ranked order on PGRST202 by itself. search_cluster_ids and search_cluster_ids_v2 are not part of this migration and are not touched.
--
-- NUMBER
--   197 is held on hunt-129-db197 and 202 on hunt-141-db202; the checkout ends at 214. 215 is the next free number, and the chain keeps its deliberate gaps at 197 and 202
--   (no guard requires a contiguous chain).
--
-- Access is 211's: SECURITY DEFINER, empty search_path (every relation and function in the body is schema-qualified), execute revoked from public, anon and authenticated and
-- granted to service_role only. No table grant, and no anon RPC (so no ops_health_report identity is needed). Safe to re-apply: create or replace function, the comment, the
-- grant, and the ledger insert `on conflict do nothing`. Nothing is dropped, altered, updated or deleted.

begin;

set local lock_timeout = '5s';

create or replace function public.search_cluster_ids_new(p_variants text[], p_folded text, p_limit integer default 24, p_offset integer default 0)
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
  ), kept as not materialized (
    -- 215: NOT MATERIALIZED, as the h190 measurement ran it: the guard below is applied to the candidates `top` asks for, newest first, and the
    -- scan stops once `top` has its 150 survivors, so only as many candidates as that takes are guarded, not the whole candidate set.
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
    -- `top` stops after 150 survivors (215; 204 and 211 stop after 1000). r is the primary-key read of the cluster, fenced with
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
    -- 215: the newest-candidate cap: only the 150 most recently updated survivors are kept (204 and 211 keep 1000 and score them).
    select k.id from kept k order by k.updated_at desc, k.id limit 150
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
  ), hits as materialized (
    -- 215: MATERIALIZED, a fence: hits joins public.clusters, so without it the planner (the function is not inlined and is planned with p_limit and p_offset unbound)
    -- can walk idx_clusters_updated_at in recency order for the final ORDER BY and stop only after offset+limit literal rows, which times out on a sparse query or a
    -- later page. hits is at most 150 rows.
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
  from hits h
  -- 215. The newest literal-title matches, newest first, one page of at most 24 rows (4 pages of 24: the offset is clamped to 0..72, the app's
  -- ARCHIVE_MAX_PAGE). lit_d is 194's literal tier: the query has words (lw is not empty) and EVERY word, as a word-start prefix, starts a word of
  -- the DISPLAY title (the neutral title when it has text, else the original one: what a reader sees on the card), inflection tolerant and order-free.
  -- Keeping only those rows is what stops a loose summary-only match from winning on freshness ('New York borsası yükselişle açıldı' for 'faiz kararı').
  -- A query with no literal tier (lw is empty: an alias or `or` query such as AKP / AK Parti, a negated phrase, see lw above) has no word to require,
  -- and the ranked order gives such a query no tier either: every kept row passes, so the page lists its newest rows instead of none.
  -- The order is a total order (updated_at desc, then the id), so two pages never share a row. Not read here: lit_ok, 194's score, article_count.
  -- The candidates are the newest 150 survivors of the 166 guard (top), so the list is the literal matches among them: often fewer than 96 rows for an
  -- ordinary term (Trump 93, dolar 82, tutuklandı 65), so pages 3 and 4 can be short or empty (the app handles both). p_limit is read once, clamped to 1..24 (null reads 24), p_offset once, clamped to 0..72 (null reads 0).
  where h.lit_d or not exists (select 1 from lw)
  order by h.updated_at desc, h.id
  limit least(greatest(coalesce(p_limit, 24), 1), 24) offset greatest(0, least(coalesce(p_offset, 0), 72));
$fn$;

comment on function public.search_cluster_ids_new(text[], text, integer, integer) is
  'Newest-first archive search, one page at a time (migration 215, h191). The newest clusters whose display title '
  'literally holds the query (lit_d of 194, or every kept row when the query has no literal tier: an alias, an or, a '
  'negated phrase), newest first: order by updated_at desc, id. Candidates are search_cluster_ids'' (migration 204: '
  'the three arms, the 166 guard, 172''s words), cut to the newest 150 survivors, kept NOT MATERIALIZED. '
  'p_limit is clamped to 1..24 (null reads 24), p_offset to 0..72 (null reads 0): 4 pages of 24. Same attributes '
  'as search_cluster_ids_v2. Caller: src/lib/clusters/search-query.ts for /?q=...&sirala=yeni (every archive page), '
  'which answers a request in the ranked order on PGRST202 or any error. Returns ids ONLY. service_role only.';

revoke all on function public.search_cluster_ids_new(text[], text, integer, integer) from public, anon, authenticated;
grant execute on function public.search_cluster_ids_new(text[], text, integer, integer) to service_role;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name) values ('215', '215_search_cluster_ids_new') on conflict do nothing;

commit;
