-- 216_search_cluster_ids_new_content_words.sql
--
-- Search archive, the "En yeni" (newest first) order, ?sirala=yeni (h192, hunt 192 on h191's search_cluster_ids_new, 2026-11-15). ONE function REPLACED, nothing created:
-- public.search_cluster_ids_new(p_variants text[], p_folded text, p_limit integer default 24, p_offset integer default 0), the function 215_search_cluster_ids_new.sql created, by
-- create or replace (same signature, same attributes, same grants). Its body is 215's body, which production runs (md5 pinned below), with edits ONLY in the lw CTE, a new sw CTE
-- put before it, and the lit_d expression of hits (the comment lines before it are new too), plus the function comment. `kept` stays NOT MATERIALIZED, `hits` stays
-- MATERIALIZED, `top` keeps the newest 150 survivors, the arms, the 166 guard and 172's words are untouched, and so is the final select. search_cluster_ids and
-- search_cluster_ids_v2 (the ranked order) are not touched, dropped or replaced. No table, column, index, trigger, cron job or data change, no backfill, no UPDATE, no LLM spend.
-- The app is NOT changed: the same call (src/lib/clusters/search-query.ts, fetchSearchNewest and typedSearchArguments), no deploy. tests/migrations/216-search-cluster-ids-new-content-words.test.ts
-- pins all of it, including "the body is 215's with those edits and nothing else" (the three unchanged spans by md5 and length).
--
-- WHY
--   215's "En yeni" order keeps a row only when EVERY typed word, as a word-start prefix, starts a word of the display title (lit_d). That is the right filter for a content word
--   (it is what stops a loose summary-only match from winning on freshness), but it asks for two things a reader does not mean. (1) A word that carries no content: a Turkish stop word
--   (ile, için, ve, ne ...) must stand in the headline. Production, read-only, 2026-11-15: GET /?q=iran+ile+abd&sirala=yeni lists 6 cards ('Arşivden: 6 sonuç'), every headline holds
--   the standalone word 'ile', while the same query ranked lists 24 and 'iran abd' in this order lists 56 over three pages. (2) An inflected typed word must meet its own
--   form only (194's cut keeps all but the last two letters): 'zamlar' needs a title word that starts with 'zaml', so 'Akaryakıta zam geldi' is missing (5 cards, ranked 24, and 'zam' in this order
--   85). The short, complete-looking list is the defect; this migration makes the list the one the reader meant.
--
-- THE RULE (four edits, in this order)
--   1. sw (new CTE): the STOP WORDS of the typed query. The words of p_variants[1] (the first typed spelling, the Turkish-lettered lower-cased query the app sends:
--      turkishQueryVariants, t.toLocaleLowerCase('tr')), split on [^[:alnum:]]+ (which splits on the Turkish letters too under the en_US.UTF-8 collation: read-only on production, 'iran ile abd,
--      için; zamlar-ı şeker çay' gives iran|ile|abd|için|zamlar|ı|şeker|çay, the same as [[:space:][:punct:]]+), for which pg_catalog.ts_lexize('pg_catalog.turkish_stem', w) = '{}', each folded by
--      public.tayf_search_fold. Read from p_variants[1], not from p_folded: ts_lexize gives '{}' for ile, için, ve, ne (and bu, da, de, ama, gibi, daha, çok, en), but the stemmer reads the ASCII
--      fold 'icin' as {iç}, a content word, so the stop word için cannot be told from p_folded. bir is {bir}, on (ten) is {on}, mi {mi}: content words, still required.
--   2. lw drops the words present in sw, EXCEPT when that would leave no word at all (bool_and over the words): a query made only of stop words (ile ve, ile için) keeps 215's behaviour and requires
--      them. lw stays EMPTY for an `or`, alias or negated-phrase query, exactly as under 215 (its switches are unchanged), so such a query keeps the `every kept row passes` rule.
--   3. lw gets a second column, pre2: the word's FOLDED turkish stem (the stem of the folded word, as gx reads it), only when the stem is a proper prefix of the word AND (it has 5 letters
--      or more, OR it has 3 to 4 letters and the rest of the word is a case or plural suffix: gx's own `ex` test, the same suffix pattern, and a 3-letter stem needs a suffix of 3 or more
--      letters); otherwise null. zamlar -> pre 'zaml', pre2 'zam' (zam + lar); vergiler -> pre2 'vergi'; kararnamelerinin -> pre2 'kararname'; iran -> stem 'ira' (3 letters, the rest 'n' is no
--      suffix) -> pre2 null; tarla -> stem 'tar' + 'la' (2 letters) -> null; zaman -> 'zama' + 'n' -> null. A blanket stem prefix would let 'Irak' and 'irade' pass for 'iran' (below), so it is conservative.
--   4. lit_d: `exists (select 1 from lw) and not exists (select 1 from lw where strpos(dn.n, ' ' || lw.pre) = 0 and (lw.pre2 is null or <pre2 is not met>))`: a kept word is met by a display-title word
--      that starts with pre (194's cut, unchanged) OR is met through pre2; every kept word is still required. A pre2 of 5 letters or more is met as before, by a title word that starts with it (the not-met test is
--      `strpos(dn.n, ' ' || lw.pre2) = 0`). A pre2 of 3-4 letters is met ONLY by a title word that is the stem itself or the stem plus a case, plural or possessive tail (an allow-list: the rest of the title word after the
--      stem must match the constant ^(l[ae]r)?(s?[iu]|s?[iu]n)?(y?[ae]|n[ae]|y?[iu]|n?[iu]n|[dt][ae](n|ki)?|n[dt][ae](n|ki)?|y?l[ae]|ki)?$ , or, for a stem that ends in a consonant, the stem plus that consonant
--      doubled and such a tail: zam + mı = zammı, hak + kı = hakkı), because the bare word-start test met every longer word: kaza met kazandı and Kazakistan, yasa met yaşam and yaşandı (audited short-stem cases: kazalar,
--      yasalar and haklar, REPLAY below). The title words are the words of dn.n and the stem never enters a pattern. The allow-list narrows the short stems; it leaves residual homographs ('hakkında' for haklar, 'yaşatan' for yasalar).
--   The candidates do not change: websearch_to_tsquery already drops a stop word from the arms (it is no lexeme), so the three arms, the 166 guard and `top` are the same rows; only the final
--   literal-title filter widens. The new rows are titles that hold every content word of the query, as the word or a form built on it; for a short stem the residual homographs measured under REPLAY
--   ('hakkında' for haklar, 'yaşatan' for yasalar) are the exception, not the rule.
--
-- STEP 0 -- the bodies this migration starts from (production, read-only, 2026-11-15)
--   select p.proname, md5(p.prosrc), length(p.prosrc), p.proacl::text, p.prosecdef, p.provolatile, pg_get_function_arguments(p.oid) from pg_proc p where p.proname in ('search_cluster_ids_new', 'search_cluster_ids', 'search_cluster_ids_v2');
--   -> search_cluster_ids_new: c500964284801f3c83be9f4b73ec398a, 23628, proacl {postgres=X/postgres,service_role=X/postgres}, prosecdef t, provolatile s, arguments (p_variants text[], p_folded text, p_limit integer
--      default 24, p_offset integer default 0), search_path "" : the text between the dollar quotes of 215_search_cluster_ids_new.sql, character for character (this file is built on the current one).
--      search_cluster_ids: 32b42ca06d6b0c2a3ba8bf1264d353f7, 22892 (204's); search_cluster_ids_v2: c91d45d81b53a71b007aa6de2d1a5ed7, 22945 (211's); the same proacl. The ledger holds 204 to 215.
--      If a later release changes search_cluster_ids_new, compare again before applying: this file replaces it whole.
--
-- REPLAY (production, SELECT only through a read-only transaction, 2026-11-15, re-measured with the short-stem allow-list in lit_d; this file's body inlined as plain SELECTs with p_variants and p_folded replaced by the literals the app sends for the
-- query, p_limit 24 and p_offset 0, 24, 48 and 72, against the live search_cluster_ids_new (215) called with the same literals)
--   query                  rows per page (offsets 0 / 24 / 48 / 72), 215 live -> this file | total  | its stem-form query, 215 live
--   iran ile abd           6 / 0 / 0 / 0   -> 24 / 24 / 8 / 0                                | 6 -> 56 | iran abd 56 (24 / 24 / 8 / 0)
--   zamlar                 5 / 0 / 0 / 0   -> 24 / 24 / 24 / 13                              | 5 -> 85 | zam 85 (24 / 24 / 24 / 13)
--   vergiler               7 / 0 / 0 / 0   -> 24 / 24 / 4 / 0                                | 7 -> 52 | vergi 52 (24 / 24 / 4 / 0)
--   kararnamelerinin       0 / 0 / 0 / 0   -> 8 / 0 / 0 / 0                                  | 0 -> 8  | kararname 8
--   deprem için bakan      2 / 0 / 0 / 0   -> 7 / 0 / 0 / 0                                  | 2 -> 7  | deprem bakan 16 (see the limit below)
--   faiz ve enflasyon      0 / 0 / 0 / 0   -> 1 / 0 / 0 / 0                                  | 0 -> 1  | faiz enflasyon 1
--   kazalar                4 / 0 / 0 / 0   -> 24 / 15 / 0 / 0                                | 4 -> 39 | kaza 84 (24 / 24 / 24 / 12)
--   yasalar                0 / 0 / 0 / 0   -> 9 / 0 / 0 / 0                                  | 0 -> 9  | yasa 41 (24 / 17 / 0 / 0)
--   haklar                 13 / 0 / 0 / 0  -> 24 / 9 / 0 / 0                                 | 13 -> 33| hak 44 (24 / 20 / 0 / 0)
--   Five of the first six reach their stem-form query's count exactly (iran abd 56, zam 85, vergi 52, kararname 8, faiz enflasyon 1); the sixth, deprem için bakan, rises from 2 to 7 and stops there. The three short-stem rows
--   (kazalar, yasalar, haklar) do not, and should not: their bare stem lists the homographs itself under 215's word-start test (kaza 84 holds the kazandı and Kazakistan titles, yasa 41 the yaşam ones, hak 44 the hakim and hakem ones).
--   LIMIT, not edited here: the 166 guard (`g`, step 2 of 166, copied verbatim from 204) still wants the folded word 'icin' at a word start in the title or the summary of every candidate, because
--   the stemmer reads the ASCII fold 'icin' as the stem iç (4 letters or fewer, no suffix: guarded), unlike ile, ve and ne, which are '{}' for the ASCII fold too. So için, unlike ile and ve,
--   still has to appear somewhere in the story: the 7 rows of 'deprem için bakan' are exactly the 'deprem bakan' rows that hold 'icin' at a word start in the title or in the summary (checked read-only),
--   the other 9 of the 16 hold it nowhere. Changing the guard is a separate decision (it is in the ranked functions too).
--   REGRESSION: for deprem, Erdoğan, Trump, seçim, enflasyon, iran and akp (the alias query, `akp or "ak parti"`) the first 24 ids of this body equal the live search_cluster_ids_new's, the same ids in
--   the same order (24 rows each, no id in one and not the other): none of them has a stop word or a widening stem.
--   IRAK FOR IRAN (the guard of rule 3): 'iran' lists 96 rows over the four pages, every display title holds a word that starts with 'iran' and none is an Irak title (production has one 30-day cluster
--   with Irak in the title and iran in the summary, and it holds iran in the title too). A blanket stem prefix would have been wrong: of the candidates of 'iran' (stem 'ira') in the last 120 days, 12 have
--   a title word that starts with 'ira' and none with 'iran' (irade ×7, Irak ×5: 'Trump'tan Irak'tan çekilme sonrası "Irak" mesajı', 'Irak'tan Hürmüz hamlesi ...'); with pre2 null for iran they stay out.
--   The local fixture seeds exactly that row (an 'Irak ...' title whose summary holds 'İran'); a mutated lw with `length(x.st) >= 3` for the 5-letter rule fails the test, so the guard is pinned.
--   PART 3 (the stem prefix) is KEPT, with the short-stem allow-list of rule 4. Its audit on production, rows that 216 lists and 215 did not, over four pages, for twelve inflected queries (the numbers the bare word-start test gave, none of the
--   twelve changes): zamlar +80, vergiler +45, bakanlar +39, seçimler +56, belediyeler +62, depremler +30, faizler +38, öğrenciler +29, grevler +24 (215 listed none), tutuklamalar +9, kararnameler +7, yaptırımlar +15; none of the 215
--   rows leaves except by the 96-row window (seçimler 5 and depremler 13 are older than the 96th newest row: the list is newest first and capped at four pages). For a stem of 5 letters or more the added rows hold a title word
--   that starts with the stem (a word-start prefix, as the ranked order's); for a 3-4 letter stem (zamlar, faizler, grevler, kazalar, yasalar, haklar) they hold the stem or the stem plus a case, plural or possessive tail. The
--   three added zamlar titles that hold a zaman word ('ne zaman', 'yakın zamanda') hold 'zam' as well.
--   SHORT STEMS (audited title by title: kazalar, yasalar and haklar). With the bare word-start test for a short pre2 (this file's first body) the same replay listed kazalar 75, yasalar 28 and haklar 44 rows; the allow-list lists 39, 9 and 33
--   (36, 19 and 11 rows fewer, none added). The 36 dropped for kazalar hold kazandı (27 titles: 'MasterChef Türkiye'de dokunulmazlığı Mavi takım kazandı', 'ABD ara seçimlerinde ... sandalye kazandı'), kazan, kazanmıştır or Kazakistan
--   ('Cumhurbaşkanı Erdoğan, Kazakistan Cumhurbaşkanı Tokayev ile görüştü'); the 19 for yasalar hold yaşam or yaşandı ('... Sağlıklı Yaşam Merkezi açıldı'); the 11 for haklar hold hakim or hakem ('... hakim karşısında'). The 35 rows kazalar
--   gains are accident stories (kaza, kazada, kazası, kazasında, kazanın). The residual homographs, which a test on the tail cannot tell from a form of the stem (they ARE the stem plus a tail): yasalar keeps 1 of its 9 rows, 'Ersoy, eski
--   reçeteleri yaşatan restoranları lezzet noktası listesine aldı' (yaşatan = yasa + tan), and haklar keeps 4 of its 33 rows whose only matching word is 'hakkında' or 'hakkındaki' (about; hak + kı + nda: 'Özgür Özel'den Emir Sarıgül hakkında
--   1 milyon TL'lik dava'), and a fifth that holds it next to 'hak ihlalleri'; the others read as the word (hak ihlali, hakkı, hak sahipleri). So the allow-list narrows the short stems and does not clear haklar.
--
-- COST (EXPLAIN (ANALYZE, BUFFERS) of the DEPLOYED shape, production, read-only, 2026-11-15, re-measured with the short-stem allow-list, warm: set local plan_cache_mode = force_generic_plan; prepare s(text[], text, int, int) as <body with p_variants,
-- p_folded, p_limit and p_offset replaced by $1 to $4>; explain (analyze, buffers) execute s(...), at offsets 0 and 72, three alternating runs of 215's body and this file's, one call each; the function is
-- SECURITY DEFINER with a set clause, so it is never inlined and is planned with p_limit and p_offset unbound, the lesson of 215, and `hits` stays MATERIALIZED)
--   term     offset  215 min / median (ms)   216 min / median (ms)   ratio min, median   buffers (hit) 215 = 216
--   Erdoğan  0       54.5 / 56.6              52.2 / 53.6              0.96, 0.95          12,094
--   Erdoğan  72      51.0 / 52.5              51.3 / 52.1              1.01, 0.99          12,094
--   seçim    0       36.2 / 38.0              36.8 / 37.3              1.02, 0.98           6,269
--   seçim    72      36.9 / 46.8 (one 61.6 ms outlier)   37.3 / 37.4   1.01, 0.80           6,269
--   Trump    0       28.2 / 30.2              27.7 / 27.9              0.98, 0.92           4,394
--   Trump    72      27.5 / 27.8              27.7 / 28.0              1.01, 1.01           4,394
--   deprem   0       18.9 / 19.1              19.1 / 19.5              1.01, 1.02           2,065-2,067
--   deprem   72      18.7 / 18.7              19.2 / 19.6              1.03, 1.04           2,067
--   Within +4% of 215 for every term (largest min-of-three ratio 1.03), the same buffers (the sw CTE and the window in lw are a handful of rows; the buffer counts differ by at most 2 hits). The first run of each series is a cold run of 215 (486 ms for
--   Erdoğan, 59.8 deprem, 56.9 seçim, 51.8 Trump at offset 0), which the min and the median absorb. The queries this file changes: iran ile abd 36.4-38.4 ms (5,546 buffers) against 215's 36.8-38.2, deprem için bakan 14.5-14.9 ms (637) against 14.1-15.5,
--   faiz kararı 10.0-10.5 ms (498 buffers against 511-515; the fence keeps it far from the 6 s cap): the same. The short stems pay for the allow-list (the display title of each of the at most 150 rows is split into words once per short pre2): zamlar 22.7 / 22.9 ms
--   at offset 0 and 23.2 / 23.8 at 72 against 215's 20.8 / 21.0 (ratio 1.09 and 1.12 on the min; 1,113 buffers both), kazalar 29.7 / 30.4 and 29.8 / 30.0 against 215's 29.6 / 34.9 and 27.0 / 27.0 (ratio 1.00 and 1.10; 2,545 buffers):
--   about 2 to 3 ms, so a short-stem query is up to +12% of 215. 215's own header table (Erdoğan 65.2 ms, seçim 36.9, Trump 28.1, deprem 25.8) was measured earlier the same day and is not directly comparable; the alternating A/B above is the
--   comparison of record. Calling the deployed function (explain analyze select * from public.search_cluster_ids_new(...)) adds the function-call overhead to both: the live 215 takes 26-27 ms for deprem.
--
-- LIMITS (unchanged by this file)
--   The list is still the literal-title matches among the newest 150 survivors of the 166 guard, newest first, at most four pages of 24 (96 rows); pages 3 and 4 can be short or empty. The ASCII spelling
--   of a stop word (icin) is not a stop word (rule 1), so a reader who types without Turkish letters keeps 215's strict answer for için, as for any content word; ile, ve and ne are the same in both spellings.
--   A typed word that the stemmer reads as a content word (bir, on, mi) is required. A pre2 of 3-4 letters (zamlar, kazalar, yasalar, haklar) is met only by a title word that is the stem or the stem plus a case, plural or possessive
--   tail, so kazandı, Kazakistan, yaşam and zaman no longer pass for kazalar, yasalar and zamlar; the residual homographs are the stem plus a real tail: 'hakkında' (hak + kı + nda, about) for haklar and 'yaşatan' (yasa + tan) for yasalar
--   (measured above: 4 of haklar's 33 rows and 1 of yasalar's 9 hold only that word). A pre2 of 5 letters or more is still met by any title word that starts with it, for a candidate that holds the stem in its title or its summary
--   (the ranked order's looseness).
--
-- DEPLOY
--   APPLY 216 ONLY: no deploy, no deploy-order constraint (docs/migration-guide.md): the app calls the same function with the same arguments and reads the same column, and the replacement is a create or
--   replace in one transaction, so a request in flight sees 215's body or 216's, never a mixture. The operator applies it (supabase db push, or post the SQL); the PR applies nothing. Until it is applied,
--   ?sirala=yeni keeps 215's strict answer.
--
-- VERIFY (read-only, after applying)
--   select md5(prosrc), length(prosrc) from pg_proc where oid = 'public.search_cluster_ids_new(text[], text, integer, integer)'::regprocedure;
--   -> 1132c3307c6acca7b1acd3c563f1b92b, 29853 (this file's body; search_cluster_ids stays 32b42ca06d6b0c2a3ba8bf1264d353f7, 22892 and search_cluster_ids_v2 c91d45d81b53a71b007aa6de2d1a5ed7, 22945)
--   select has_function_privilege('anon', 'public.search_cluster_ids_new(text[], text, integer, integer)', 'execute'),
--          has_function_privilege('authenticated', 'public.search_cluster_ids_new(text[], text, integer, integer)', 'execute'),
--          has_function_privilege('service_role', 'public.search_cluster_ids_new(text[], text, integer, integer)', 'execute');
--   -> false, false, true
--   select count(*) = 24 as full_page, bool_and(a.updated_at <= a.prev) as newest_first,
--          bool_and(strpos(a.n, ' iran') > 0 and strpos(a.n, ' abd') > 0) as every_word
--     from (select c.updated_at, lag(c.updated_at, 1, 'infinity'::timestamptz) over (order by x.ord) as prev,
--                  ' ' || regexp_replace(public.tayf_search_fold(coalesce(nullif(btrim(c.title_tr_neutral), ''), c.title_tr)), '[^a-z0-9]+', ' ', 'g') as n
--             from public.search_cluster_ids_new(array['iran ile abd'], 'iran ile abd', 24, 0) with ordinality x(id, ord) join public.clusters c on c.id = x.id) a;
--   -> true, true, true (215 returned 6 rows: false). Then GET /?q=iran+ile+abd&sirala=yeni lists a full page of /cluster/ links under "Arşivden: en yeni 24 sonuç" (the cache entry is rebuilt after its
--   TTL), GET /?q=zamlar&sirala=yeni lists the stories whose headline holds 'zam', and GET /?q=iran&sirala=yeni and GET /?q=deprem&sirala=yeni are the pages they were.
--
-- ROLLBACK (the app does not care which of the two bodies runs)
--   re-apply supabase/migrations/215_search_cluster_ids_new.sql (its create or replace puts 215's body, comment and grants back; its ledger insert is `on conflict do nothing`), then
--   delete from supabase_migrations.schema_migrations where version = '216';
--   notify pgrst, 'reload schema';
--   ?sirala=yeni is then 215's strict answer again. search_cluster_ids and search_cluster_ids_v2 are not part of this migration and are not touched.
--
-- NUMBER
--   197 is held on hunt-129-db197 and 202 on hunt-141-db202; the checkout ends at 215. 216 is the next free number, and the chain keeps its deliberate gaps at 197 and 202
--   (no guard requires a contiguous chain).
--
-- Access is 215's: SECURITY DEFINER, empty search_path (every relation and function in the body is schema-qualified), execute revoked from public, anon and authenticated and
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
  ), sw as (
    -- 216: the STOP WORDS of the typed query, which lw below does not require in the title. They are the words of p_variants[1] (the first typed spelling: the Turkish-lettered,
    -- lower-cased query the app sends, turkishQueryVariants, t.toLocaleLowerCase('tr')) that the turkish stemmer reads as a stop word, ts_lexize('pg_catalog.turkish_stem', w) = '{}'
    -- (ile, için, ve, ne, bu, da, de, ama, gibi, daha, çok, en ...), each folded like the words of lw. They are read from p_variants[1], NOT from p_folded: the ASCII fold of
    -- için is 'icin', which the stemmer reads as {iç}, so a stop word cannot be told from a content word there. The words are the runs of letters and digits ([^[:alnum:]]+
    -- splits on the Turkish letters too under the en_US.UTF-8 collation, checked read-only on production). The pattern is a constant with no backslash; the words only go into
    -- ts_lexize and tayf_search_fold, never into a pattern. The same words as the websearch query already drops from the candidate arms (a stop word is no lexeme), so the
    -- candidates do not change: only the literal-title filter at the end does. Empty for a null or empty p_variants[1].
    select distinct public.tayf_search_fold(s.w) as w
    from pg_catalog.regexp_split_to_table(coalesce(p_variants[1], ''), '[^[:alnum:]]+') as s(w)
    where s.w <> ''
      and pg_catalog.ts_lexize('pg_catalog.turkish_stem'::pg_catalog.regdictionary, s.w) = '{}'::pg_catalog.text[]
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
    -- 216: lw now has two columns. pre is 194's cut, unchanged. pre2 is the word's FOLDED turkish stem (the stem of the folded word, as gx reads it), only when it is a conservative
    -- stem: a proper prefix of the word and either 5 letters or more, or 3 to 4 letters and the rest of the word is a Turkish case or plural suffix (gx's own `ex` test, the same
    -- suffix pattern, and a 3-letter stem needs a suffix of 3 or more letters): zamlar -> zam (zam + lar), vergiler -> vergi, kararnamelerinin -> kararname; iran -> ira is NOT
    -- (the stem is 3 letters and the rest, 'n', is no suffix), nor zaman -> zama, tarla -> tar (tar + la, a 2-letter suffix), so a title word like Irak never meets iran. lit_d
    -- accepts a title word that starts with pre OR with pre2. The stop words (sw) are dropped, EXCEPT when that would leave no word at all (bool_and over the rows): a query
    -- made only of stop words (ile ve) keeps 215's behaviour and requires them. lw stays EMPTY for an `or`, alias or negated-phrase query, as under 215 (the switches below are
    -- unchanged), so such a query keeps the `every kept row passes` rule. The suffix pattern is a constant with no backslash; the words only go through left(), substr(), strpos()
    -- and a pattern match whose subject is the word's own tail, never into a pattern.
    select distinct t.pre, t.pre2
    from (
      select pg_catalog.left(x.w, greatest(least(pg_catalog.length(x.w), 4), pg_catalog.length(x.w) - 2)) as pre,
             case when x.st is not null
                       and pg_catalog.length(x.st) < pg_catalog.length(x.w)
                       and pg_catalog.left(x.w, pg_catalog.length(x.st)) = public.tayf_search_fold(x.st)
                       and (pg_catalog.length(x.st) >= 5
                            or (pg_catalog.length(x.st) between 3 and 4
                                and (pg_catalog.length(x.st) = 4 or pg_catalog.length(x.w) - pg_catalog.length(x.st) >= 3)
                                and pg_catalog.substr(x.w, pg_catalog.length(x.st) + 1) ~ '^(y?[ae]|n[ae]|y?[iu]|n?[iu]n|[dt][ae](n|ki)?|n[dt][ae](n|ki)?|y?l[ae]|l[ae]r[a-z]*)$'))
                  then public.tayf_search_fold(x.st) end as pre2,
             x.stop,
             pg_catalog.bool_and(x.stop) over () as all_stop
      from (
        select s.w, (pg_catalog.ts_lexize('pg_catalog.turkish_stem'::pg_catalog.regdictionary, s.w))[1] as st,
               exists (select 1 from sw where sw.w = s.w) as stop
        from g0
        cross join lateral pg_catalog.regexp_split_to_table(g0.tok, '[^a-z0-9]+') as s(w)
        where s.w <> ''
          and (pg_catalog.length(s.w) >= 2 or (select f.cmp from f) is null)
          and not exists (select 1 from g0 o where pg_catalog.regexp_replace(o.tok, '[^a-z0-9]+', '', 'g') = 'or')
          and not exists (select 1 from f0 where pg_catalog.strpos(f0.ff, '-"') > 0)
      ) x
    ) t
    where not t.stop or t.all_stop
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
           -- 216 lit_d: a word of lw is met by a display-title word that starts with pre (194's cut) OR, when the word has a conservative stem (pre2, see lw), by a title word built on pre2:
           -- zamlar meets 'zam', vergiler 'vergi', kararnamelerinin 'kararname'. iran has no pre2, so Irak never meets it. Every kept word is still required (the stop words are not in lw, see sw).
           -- A 5+ letter pre2 is still a word-start prefix (strpos). A 3-4 letter pre2 is met only by a title word equal to the stem or the stem plus a case, plural or possessive tail: the
           -- allow-list pattern below is a constant with no backslash, its only subject is the title word's own tail (the stem never enters a pattern), and its second branch is the doubled
           -- consonant (zam + mı = zammı, hak + kı = hakkı). A bare word-start test would meet any longer word (kaza meets kazandı and Kazakistan, yasa meets yaşam and yaşandı; audited on
           -- production for kazalar, yasalar and haklar). The title words are the words of dn.n, split on its single spaces.
           (exists (select 1 from lw) and not exists (select 1 from lw where pg_catalog.strpos(dn.n, ' ' || lw.pre) = 0
             and (lw.pre2 is null
                  or case when pg_catalog.length(lw.pre2) >= 5 then pg_catalog.strpos(dn.n, ' ' || lw.pre2) = 0
                          else not exists (select 1 from pg_catalog.regexp_split_to_table(dn.n, ' ') as tw(x)
                                            where tw.x = lw.pre2
                                               or (pg_catalog.left(tw.x, pg_catalog.length(lw.pre2)) = lw.pre2
                                                   and (pg_catalog.substr(tw.x, pg_catalog.length(lw.pre2) + 1) ~ '^(l[ae]r)?(s?[iu]|s?[iu]n)?(y?[ae]|n[ae]|y?[iu]|n?[iu]n|[dt][ae](n|ki)?|n[dt][ae](n|ki)?|y?l[ae]|ki)?$'
                                                        or (pg_catalog.right(lw.pre2, 1) !~ '[aeiou]' and pg_catalog.length(tw.x) > pg_catalog.length(lw.pre2) + 1
                                                            and pg_catalog.substr(tw.x, pg_catalog.length(lw.pre2) + 1, 1) = pg_catalog.right(lw.pre2, 1)
                                                            and pg_catalog.substr(tw.x, pg_catalog.length(lw.pre2) + 2) ~ '^(l[ae]r)?(s?[iu]|s?[iu]n)?(y?[ae]|n[ae]|y?[iu]|n?[iu]n|[dt][ae](n|ki)?|n[dt][ae](n|ki)?|y?l[ae]|ki)?$'))))
                     end))) as lit_d
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
  'Newest-first archive search, one page at a time (migration 215, h191; 216, h192). The newest clusters whose display title '
  'literally holds the query (lit_d of 194, or every kept row when the query has no literal tier: an alias, an or, a '
  'negated phrase), newest first: order by updated_at desc, id. 216: the Turkish stop words of the query (ile, için, ve ...; '
  'read from p_variants[1] with ts_lexize) are not required in the title unless the query is made of them only, and a typed '
  'inflected word also accepts the title word built on its conservative stem (zamlar: zam; a 3-4 letter stem only as the stem or the stem plus a case or plural tail, so kazandı is not kazalar; never iran: ira). Candidates are '
  'search_cluster_ids'' (migration 204: the three arms, the 166 guard, 172''s words), cut to the newest 150 survivors, kept '
  'NOT MATERIALIZED. p_limit is clamped to 1..24 (null reads 24), p_offset to 0..72 (null reads 0): 4 pages of 24. Same '
  'attributes as search_cluster_ids_v2. Caller: src/lib/clusters/search-query.ts for /?q=...&sirala=yeni (every archive page), '
  'which answers a request in the ranked order on PGRST202 or any error. Returns ids ONLY. service_role only.';

revoke all on function public.search_cluster_ids_new(text[], text, integer, integer) from public, anon, authenticated;
grant execute on function public.search_cluster_ids_new(text[], text, integer, integer) to service_role;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name) values ('216', '216_search_cluster_ids_new_content_words') on conflict do nothing;

commit;
