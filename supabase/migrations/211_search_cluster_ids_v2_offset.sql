-- 211_search_cluster_ids_v2_offset.sql
--
-- Search stops at 24 results with no next page (h170-roadmap-1, hunt 170, 2026-11-13). GET /?q=enflasyon and /?q=asgari%20%C3%BCcret list the 24 best
-- archive matches under "en ilgili 24 sonuç" and offer no way past them, because the archive RPC has no offset. One function CREATED,
-- public.search_cluster_ids_v2(p_variants text[], p_folded text, p_limit integer default 12, p_offset integer default 0): its body is the body of
-- public.search_cluster_ids(text[], text, integer) that production runs (migration 204's, md5 pinned below) with ONE changed line, the last one: the limit
-- clause is followed by an OFFSET read from the new last argument p_offset. The argument defaults to 0, so a call that leaves it out, or passes 0 or NULL,
-- returns what search_cluster_ids returns for the same first three arguments. search_cluster_ids itself is not touched, dropped or replaced: it is the
-- read of page 1 of every search and the app's fallback chain. No table, column, index, trigger, cron job or data change, no backfill, no UPDATE.
-- tests/migrations/211-search-cluster-ids-v2-offset.test.ts pins all of it, including "the body is 204's with that single line changed".
--
-- WHY
--   search_cluster_ids ends in `limit greatest(1, least(coalesce(p_limit, 12), 50))` and takes no offset; the app asks it for SEARCH_LIMIT = 24 rows
--   (src/lib/clusters/search-query.ts). Live GET /?q=enflasyon and /?q=asgari%20%C3%BCcret each show exactly 24 /cluster/ links, the heading "Arşivden: en ilgili 24
--   sonuç", and no "Sonraki" link; read-only, search_cluster_ids(array['enflasyon'], 'enflasyon', 50) returns 50 rows, so at least 26 more ranked matches exist past
--   the 24 shown, and 204's header records deprem 440, emekli maaşı 89 and Erdoğan 1000 scored candidates. The same offset recipe shipped for hubs
--   (migration 199 and /gundem/<key>?sayfa=N). The app now pages the archive: ?arsiv=N, 4 pages of 24 = the 96 best matches; page 1 is read from
--   search_cluster_ids exactly as today and pages 2 to 4 from v2 (src/lib/clusters/search-query.ts, src/app/page.tsx).
--
-- THE RULE
--   v2 is the live function plus `offset greatest(0, least(coalesce(p_offset, 0), 72))` on the last line, which now reads
--   `limit greatest(1, least(coalesce(p_limit, 12), 50)) offset greatest(0, least(coalesce(p_offset, 0), 72));`. Everything else is the live body byte for
--   byte: the three arms (variants, folded, stem-fold), the 166 guard, 172's exempt-word tier, 196's inflection roots, 204's compounds, 194's ORDER BY
--   (ending in article_count desc, updated_at desc, id: a total order, so two pages never share a row), the 1000 most recently updated candidates scored,
--   and the 1..50 limit clamp. The ranking is not changed, and there is no date sort. The offset is clamped to 0..72: 4 pages of 24, the last page starts
--   at 72 (ARCHIVE_MAX_PAGE in src/lib/seo/home-canonical.ts); the app never asks for a later page, so a clamped offset is never answered for a page that
--   was not asked for. The app sends p_limit 24 and the typed call's p_variants and p_folded of page 1, so page N is rows 24 * (N - 1) + 1 to 24 * N of the
--   very ranking page 1 is the top of. Cost: every page scores the same candidates as page 1 (the offset applies after the sort), measured below.
--
-- STEP 0 -- the body this migration starts from (production, read-only, 2026-11-13 about 02:00Z)
--   select md5(p.prosrc), length(p.prosrc), p.proacl::text, p.prosecdef, p.provolatile from pg_proc p where p.proname = 'search_cluster_ids' and length(p.prosrc) = 22892;
--   -> 32b42ca06d6b0c2a3ba8bf1264d353f7, 22892, proacl {postgres=X/postgres,service_role=X/postgres}, prosecdef t, provolatile s, arguments (p_variants text[], p_folded text,
--      p_limit integer default 12). pg_get_functiondef returned the body, and its text between the dollar quotes equals the text between the dollar quotes of
--      204_search_single_letter_compounds.sql, character for character: this file is built on the current one. There is no search_cluster_ids_v2 yet.
--      If a later release changes search_cluster_ids, compare again before applying.
--
-- REPLAY (production, SELECT only through a read-only transaction, 2026-11-13 about 02:15-02:20Z; this file's body inlined as plain SELECTs with p_variants and
-- p_folded replaced by the literals the app sends for the query, p_limit 24 and p_offset 0, 24, 48 and 72, and the live function called in the same statement
-- (one now()), comments stripped from the inline copies)
--   query       live rows  page 1 (offset 0) = live top 24, same order | page 2 = live rows 25-48 | page 3 first 2 = live rows 49-50 | pages disjoint
--   enflasyon   50 (of 50)  yes (also equals search_cluster_ids(..., 24))      | yes                  | yes                              | yes: 4 x 24 rows, 96 distinct ids, no overlap
--   deprem      50 (of 50)  yes (also equals search_cluster_ids(..., 24))      | yes                  | yes                              | yes: 4 x 24 rows, 96 distinct ids, no overlap
--   Page 1 is the live function's 24 ids in the live function's order; pages are disjoint and consecutive. The pages of enflasyon are 24 rows each at offsets 0, 24, 48 and 72.
--
-- COST (EXPLAIN (ANALYZE), the inline body of enflasyon, production, 2026-11-13): offset 0 19.8 and 23.0 ms, offset 72 20.7 and 19.9 ms execution time (planning 8.8 to 10.4 ms).
-- A later page costs what page 1 costs, a few tens of milliseconds, and the app adds at most 3 cache entries per query (pages 2 to 4, one cache function with the page in its key).
--
-- DEPLOY
--   APPLY 211 FIRST, THEN DEPLOY the app (docs/migration-guide.md: an RPC the app calls is applied before the deploy). The reverse order is safe but degraded:
--   the app reads page 1 with search_cluster_ids exactly as today, and a later page with v2 (p_offset = (page - 1) * 24, p_limit 24, page 1's typed p_variants and
--   p_folded, one call, no sibling and no locative call). On PGRST202 (v2 is not in the schema cache, i.e. 211 unapplied) a later page resolves to an
--   "unavailable" state: the page says "Bu sayfa şu an gösterilemiyor." with a link to page 1 and nothing throws; page 1 is unaffected, only later pages degrade.
--   Page 1 of a search whose typed call filled its page shows a "Sonraki sonuçlar" link in the meantime and it leads there. The unavailable page is cached for a
--   few minutes only, so a page heals soon after 211 is applied.
--
-- VERIFY (read-only, after applying)
--   select md5(prosrc), length(prosrc) from pg_proc where oid = 'public.search_cluster_ids_v2(text[], text, integer, integer)'::regprocedure;
--   -> c91d45d81b53a71b007aa6de2d1a5ed7, 22945 (this file's body; search_cluster_ids stays 32b42ca06d6b0c2a3ba8bf1264d353f7, 22892)
--   select has_function_privilege('anon', 'public.search_cluster_ids_v2(text[], text, integer, integer)', 'execute'),
--          has_function_privilege('authenticated', 'public.search_cluster_ids_v2(text[], text, integer, integer)', 'execute'),
--          has_function_privilege('service_role', 'public.search_cluster_ids_v2(text[], text, integer, integer)', 'execute');
--   -> false, false, true
--   one statement (one now()): with v0 as (select array_agg(id order by ord) a from public.search_cluster_ids_v2(array['enflasyon'], 'enflasyon', 24, 0) with ordinality t(id, ord)),
--     v1 as (select array_agg(id order by ord) a from public.search_cluster_ids_v2(array['enflasyon'], 'enflasyon', 24, 24) with ordinality t(id, ord)),
--     l as (select id, ord from public.search_cluster_ids(array['enflasyon'], 'enflasyon', 50) with ordinality t(id, ord))
--     select (select a from v0) = (select array_agg(id order by ord) from l where ord <= 24),
--            (select a from v1) = (select array_agg(id order by ord) from l where ord between 25 and 48);
--   -> true, true: the rows of offsets 0 and 24 are rows 1-24 and 25-48 of the live function, same ids, same order. Then, one request per second and after the
--   cache entry is rebuilt: GET /?q=enflasyon shows "Sonraki sonuçlar"; GET /?q=enflasyon&arsiv=2 lists 24 /cluster/ ids disjoint from page 1; &arsiv=abc and &arsiv=9
--   answer 200; GET / is unchanged.
--
-- ROLLBACK (the app does not care whether v2 exists)
--   drop function public.search_cluster_ids_v2(text[], text, integer, integer);
--   delete from supabase_migrations.schema_migrations where version = '211';
--   notify pgrst, 'reload schema';
--   The later pages fall back to the "unavailable" state on PGRST202 by themselves. search_cluster_ids is not part of this migration and is not touched by the rollback.
--
-- NUMBER
--   197 is held on hunt-129-db197 and 202 on hunt-141-db202; the checkout ends at 210. 211 is the next free number, and the chain keeps its deliberate gaps at 197 and 202
--   (no guard requires a contiguous chain).
--
-- Access is the live function's: SECURITY DEFINER, empty search_path (every relation and function in the body is schema-qualified), execute revoked from public, anon and
-- authenticated and granted to service_role only. No table grant, and no anon RPC (so no ops_health_report identity is needed). The statements below repeat the comment, the
-- revoke and the grant of 204 for the new signature so the file stands on its own. Safe to re-apply: create or replace function, the comment, the grant, and the ledger insert
-- `on conflict do nothing`. Nothing is dropped, altered, updated or deleted.

begin;

set local lock_timeout = '5s';

create or replace function public.search_cluster_ids_v2(p_variants text[], p_folded text, p_limit integer default 12, p_offset integer default 0)
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
  limit greatest(1, least(coalesce(p_limit, 12), 50)) offset greatest(0, least(coalesce(p_offset, 0), 72));
$fn$;

comment on function public.search_cluster_ids_v2(text[], text, integer, integer) is
  'Ranked, ASCII-folded archive search, one page at a time (migration 211, h170-roadmap-1). Same as '
  'search_cluster_ids (migration 204, the live body: the three arms, the 166 guard, the 172 tier, the '
  '194 ranking, the 1000 scored candidates, the 1..50 limit clamp) plus p_offset integer default 0, '
  'applied after the limit and clamped to 0..72 (null reads as 0): p_offset 0 returns the same ids in '
  'the same order as search_cluster_ids, p_offset 24 with p_limit 24 the next 24, up to 4 pages of 24 '
  '(the 96 best matches). The ranking, the candidates and the guard are not changed; a page costs what '
  'page 1 costs. Caller: src/lib/clusters/search-query.ts for /?q=...&arsiv=N (page 2 and later; page 1 '
  'reads search_cluster_ids), which treats PGRST202 as "page not available yet". Returns ids ONLY. '
  'service_role only.';

revoke all on function public.search_cluster_ids_v2(text[], text, integer, integer) from public, anon, authenticated;
grant execute on function public.search_cluster_ids_v2(text[], text, integer, integer) to service_role;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name) values ('211', '211_search_cluster_ids_v2_offset') on conflict do nothing;

commit;
