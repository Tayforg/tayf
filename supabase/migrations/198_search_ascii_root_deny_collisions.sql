-- 198_search_ascii_root_deny_collisions.sql
--
-- 196's ASCII suffix-strip roots no longer turn a base-form word or a name into another word. ONE function is replaced: the helper
-- public.tayf_ascii_inflection_expand(tsquery) of 196, same signature, same attributes, same grants. Its text is 196's byte for byte, comments included,
-- except ONE literal: the closed deny set of roots (ilisk, turk and sevk of 196, now also mart, york, kurt, kara, bask, topl and kars). search_cluster_ids is NOT
-- redefined: it calls the helper by name, so its md5 stays c384c1f3a0dc337e5243b5a3e55985c0 (length 19562). No table, column, index, trigger, cron job or data change; the
-- three arms, 166's guard, 172's tier, 194's ORDER BY, the 1000-row cap and the app are not touched (h130-searchpost-1, hunt 131, 2026-11-11).
-- This file takes the number 198: 197 is reserved for a held migration of another branch and is not in this chain, 191 is reserved and not applied, 192 to 196 are
-- applied. The gap at 197 is deliberate and harmless: no guard requires a contiguous chain (tests/migrations/live-harness.test.ts pins the manifest, the dry-runs and the
-- runner, not a number sequence; the chain already has gaps at 010 and 082), and this file needs nothing from 197. Apply 198 after 196; the order against 197 does not matter.
--
-- WHY (evidence: production, read-only, 2026-11-11; the finding was measured about 16:56-17:03Z, and the live helper was re-read for this change: it is 196's, md5(prosrc) bcd7b393693a64a5f6123b0ebd855e3d, length 5077)
--   * 196 (the stem-fold arm ORs every [a-z] lexeme of the stem query with the closed roots its ending can only mean) shipped in #267 the same day. A base-form word or a
--     name that ends like an inflection reaches, through R1 (consonant + i/u, with the soft-letter copy g, b, d -> k, p, t) or R2 (vowel + s + i/u), the stem of a DIFFERENT, more
--     frequent word. The live helper on the live stem query, tayf_ascii_inflection_expand(to_tsquery('simple', tayf_search_fold(websearch_to_tsquery('turkish', w)::text))), prints:
--       mardin -> 'mardi' | 'mard' | 'mart'      yorgun -> 'yorgu' | 'yorg' | 'york'     kurti -> 'kurti' | 'kurt'
--       karasu -> 'karasu' | 'karas' | 'kara'    baski and baskı -> 'baski' | 'bask'      toplu -> 'toplu' | 'topl'
--       karsi and karşı -> 'karsi' | 'kars'
--     The query is built from p_folded, so the Turkish spelling widens too (baskı, karşı).
--   * Live stem-fold counts (the index predicate: tayf_search_stem_fold(search_tsv), not archived, article_count >= 2), 2026-11-11, measured again for this change and equal
--     to the finding's: mardi 56 / mart 153, yorgu 6 / york 268, kurti 5 / kurt 147, karasu 27 / kara 53, baski 200 / bask 150, toplu 169 / topl 238, karsi 1,427 / kars 90.
--     In five of the seven the root has more rows than the word (mart 153, york 268, kurt 147, kara 53, topl 238 against 56, 6, 5, 27, 169); in two it has fewer (bask 150 against baski 200,
--     kars 90 against karsi 1,427), and the 150 and the 90 rows are not about the typed word all the same (bask is the stem of baskın, the raid; kars is the province). What makes the root
--     wrong is that it is the stem of a lemma of its own, not its count.
--   * What the live function returned (search_cluster_ids(array[q], fold(q), 24), the finding; the replay below re-measures it): 'mardin kaza' returned only 64a92b61 'Eylem Tok,
--     avukatı aracılığıyla mektup gönderdi' (190 d old; no 'mardin' in its title or summary); 'mardin saldırı' returned 59cd0882 and a1cb2b80, neither with 'mardin'; 'mardin depremi'
--     had 366d9913 'İstanbul'da kiralık sosyal konut…' at rank 3. 'kurti': ranks 1-6 were Kurtulmuş, Kürt meselesi, TCDD Genel Müdürü Kurt, Kürtlerin, dört kurt and Kurtlar Vadisi;
--     the Kosova Kurti story is rank 7. 'karasu': ranks 1-2 were 'karaya oturdu' and 'Zeydan Karalar'. 'baskı': ranks 4, 9, 11 and 12 were baskın (raid) rows. 'toplu': rank 1 was
--     '100'den fazla sivil toplum…' and rank 3 '…Konseyi Toplantısı'.
--   * The live pages (GET, the finding): /?q=mardin%20kaza (200) printed 'Arşivden: 1 sonuç' with the Eylem Tok row; /?q=yorgun (200) listed 'New York Times…', 'New York senatörü…'
--     and 'New York Eyalet Senatosu…' among its first 7 rows. No earlier finding covers this; 196 shipped today in #267.
--
-- WHAT
--   public.tayf_ascii_inflection_expand(p tsquery) returns tsquery, create or replace. LANGUAGE plpgsql, IMMUTABLE, STRICT, PARALLEL SAFE, SET search_path = '', not security
--   definer, service_role only (the revoke and the grant are issued again; the proacl is the same). The text is 196's byte for byte, comments included, except ONE literal in the
--   keep loop: array['ilisk', 'turk', 'sevk']::pg_catalog.text[] becomes array['ilisk', 'turk', 'sevk', 'mart', 'york', 'kurt', 'kara', 'bask', 'topl', 'kars']::pg_catalog.text[].
--   The rule: a root is denied when a base-form word or a name reaches, through R1/R2, the stem of a DIFFERENT, more frequent lemma (mardin->mart, yorgun->york, kurti->kurt,
--   karasu->kara, baskı->bask, toplu->topl, karşı->kars). 'More frequent' is the idea's wording; the replay reads it as 'a lemma of its own with stored stems of its own', because two of the
--   seven roots have fewer rows than the word (bask 150 against baski 200, kars 90 against karsi 1,427) and are still all wrong (WHY). The closed deny set is now ilisk, turk, sevk, mart, york, kurt, kara, bask, topl and kars.
--   It is read for the root of every rule (196's design), so the plural-possessive forms of a denied root lose it too (KNOWN LIMITS 2).
--   Roots considered and NOT denied, with the reason for each: tokat (tokadi is its real inflection), tehdit (tehdidi is wanted), part (196 KNOWN LIMITS 2, bounded by the AND),
--   kent (no page change measured).
--   search_cluster_ids is NOT redefined: the helper is called by name, and every other character of the function, the three arms, 166's guard, 172's tier, 194's ORDER BY, the
--   1000-row cap and the limit stay as 196 has them (md5(prosrc) c384c1f3a0dc337e5243b5a3e55985c0, length 19562). Denying a root only ever REMOVES stem-arm candidates: no row
--   of the other two arms leaves, and no word without a denied root changes.
--   Pinned output (the dry-run and the live block check the text, through the app's pipeline: websearch_to_tsquery('turkish'), the fold, the helper): mardin gives 'mardi' | 'mard',
--   yorgun gives 'yorgu' | 'yorg', kurti gives 'kurti', karasu gives 'karasu' | 'karas', baski gives 'baski', baskı gives 'baski', toplu gives 'toplu', karsi gives 'karsi',
--   mardin kaza gives ( 'mardi' | 'mard' ) & 'kaz', karşı çıktı gives 'karsi' & 'cik'. Every 196 pin is unchanged: emekli & maasi gives ( 'emekli' | 'emekl' ) & ( 'maasi' | 'maas' ),
--   siginagi gives 'siginagi' | 'siginag' | 'siginak', maaslari gives 'maaslari' | 'maaslar' | 'maas', sevgi gives 'sevgi' | 'sevg', and iliski, turku, zammi, hakki are unchanged;
--   tokadi still carries tokat ('tokadi' | 'tokad' | 'tokat'), tehdidi still carries tehdit ('tehdidi' | 'tehdid' | 'tehdit') and parti still carries part ('parti' | 'part').
--
-- BASE
--   196's helper (md5 bcd7b393693a64a5f6123b0ebd855e3d, length 5077; the test recomputes it from 196's file). It is the helper production runs (STEP 0). 196's search_cluster_ids
--   (md5 c384c1f3a0dc337e5243b5a3e55985c0, length 19562) is the function production runs and stays. This file is complete on its own: it replaces whichever helper text is installed with the
--   one below and needs no object that 196 did not already need (the helper is read by search_cluster_ids, which is built on 194's body), so apply 196 first. Application: no
--   deploy order. The proacl of the helper stays {postgres=X/postgres,service_role=X/postgres}.
--
-- STEP 0 (read-only, production, 2026-11-11, sbq.py, a READ ONLY transaction)
--   select p.oid::regprocedure::text, md5(p.prosrc), length(p.prosrc), p.provolatile, p.proparallel, p.proisstrict, p.proacl::text from pg_proc p where p.proname in ('search_cluster_ids', 'tayf_ascii_inflection_expand')
--   -> search_cluster_ids(text[],text,integer) c384c1f3a0dc337e5243b5a3e55985c0, 19562, s, u, false (196's body: md5 and length equal); search_cluster_ids(text[],integer) aabf54347c8f929090419335d5d48f19 (083's, not touched);
--      tayf_ascii_inflection_expand(tsquery) bcd7b393693a64a5f6123b0ebd855e3d, 5077, i, s, true, {postgres=X/postgres,service_role=X/postgres}.
--   select version, name from supabase_migrations.schema_migrations where version in ('190', '191', '192', '193', '194', '195', '196', '197', '198')
--   -> 190, 192, 193, 194, 195 and '196' (196_search_ascii_inflection_roots) are applied; 191, 197 and 198 are not.
--
-- REPLAY (production, SELECT only through sbq.py in a READ ONLY transaction, 2026-11-11; 196's own method)
--   196's search_cluster_ids body ran inline as a plain SELECT in ONE statement per query (one now()): as it is (the live helper, which is 196's), with the qs CTE's
--   else-branch replaced by the to_tsquery literal that 198's helper prints on a local PostgreSQL 15 for production's own qs text (198's helper is not on production), and once more with the literal of 196's own helper text
--   (the method check). The arguments are
--   exactly what src/lib/clusters/search-query.ts builds (canonicalSearchQuery, the alias expansion, turkishQueryVariants, foldTr; p_limit removed, so every scored candidate up to the 1000-row
--   cap, in rank order; the first 24 is the page). Per query: the candidate count, the rows of the first 24 that do not hold the typed word (a folded word-start test on title, neutral title and summary), and
--   the overlap of the two pages.
--   Method checks, all 53 calls: the live helper's text on production's own stem query equals the text 196's helper prints on the local PostgreSQL 15, and the inline body run with that literal returns
--   the ids of the inline body run with the live helper (both asserted by the script), so the 198 column is what the installed 198 helper would give.
--   Collisions (the typed call): candidates 196 -> 198; of the page's rows, those that lack the typed word (a word-start test on the folded title, neutral title and summary with the app's Turkish suffix tails), 196 -> 198; rows shared by the two pages.
--     mardin kaza           1 -> 0     lack  1 of  1 -> 0 of  0    shared  0   (196: only 64a92b61, 190 d old; 198: "sonuç bulunamadı")
--     mardin saldırı        2 -> 0     lack  2 of  2 -> 0 of  0    shared  0   (196: 59cd0882 and a1cb2b80)
--     mardin belediyesi     7 -> 4     lack  3 of  7 -> 0 of  4    shared  4
--     mardin depremi        3 -> 2     lack  1 of  3 -> 0 of  2    shared  2   (196 rank 3: 366d9913, the İstanbul konut story, 138 d old)
--     mardin              209 -> 56    lack  0 of 24 -> 0 of 24    shared 24   (the 153 mart rows sit below the page; the page is the same)
--     yorgun              274 -> 6     lack 22 of 24 -> 0 of  6    shared  2   (196: 22 rows about New York and the like; the 198 rows hold yorgun, yorgunuz)
--     kurti               152 -> 5     lack 22 of 24 -> 0 of  5    shared  2   (198: the Kosova Kurti stories are ranks 1-3 of 5)
--     karasu               83 -> 32    lack 12 of 24 -> 4 of 24    shared 12   (the 4 hold karası, the stem karas, KNOWN LIMITS 6; ranks 1-6 of 198 are Karasu rows)
--     baskı               345 -> 200   lack  3 of 24 -> 0 of 24    shared 13   (the 3 were baskın rows)
--     baski               345 -> 200   lack  3 of 24 -> 0 of 24    shared 13
--     baskı altında        36 -> 25    lack  1 of 24 -> 0 of 24    shared 16
--     toplu               404 -> 169   lack  6 of 24 -> 0 of 24    shared 17   (the 6 were toplum / Toplantısı rows)
--     karşı çıktı         116 -> 109   lack  2 of 24 -> 0 of 24    shared 22   (the 2 were Kars'ta sular çekildi rows)
--     karsi cikti         116 -> 109   lack  2 of 24 -> 0 of 24    shared 22
--   No Mart, New York, Kurtulmuş / Kürt / Kurtlar, karaya / Karalar, baskın, toplum / Toplantısı or Kars-province row is left in these pages unless it holds the typed word, except the four karası rows
--   of karasu. The page the app builds for mardin belediyesi (the typed call, then the sibling call mardin belediye, whose 23 candidates held the mart rows) was 24 rows under 196 and is 6 rows under 198.
--   Controls: every call below returns the SAME ids in the SAME order under both helpers (36 of the 53 calls): emekli maasi and emekli maaşı 89, siginagi and sığınağı 15, maaslari and maaşları 158,
--   cocugu and çocuğu 896, guvenligi and güvenliği 1000 (the cap), secim sonuclari and seçim sonuçları 264, asgari ucret zammi 0 and asgari ucret zam 7, vergisi 33, cezasi 249, kitabi 85,
--   hakki and hakkı 200, iliski 568, turku 21, sevgi 49, tehdidi 538, tokadi 82, parti 1000, kenti 138, akp 1000, deprem 438, iran 1000, secim 1000, erdogan 1000, imamoglu and imamoğlu 603, burdur 34,
--   miller 18, karaları 53. The pages the app builds with a sibling call are the same rows in the same order: emekli maasi 24 rows, asgari ucret zammi 7 rows (typed 0 + the sibling's 7), vergisi, cezasi,
--   hakki and hakkı 24 rows each. Every 198 id set is contained in 196's (53 of 53).
--   Cost of the closed list (KNOWN LIMITS 2), 196 -> 198: kurtlari 147 -> 1 and karalari 53 -> 0 (the ASCII plural-possessive no longer reaches kurt and kara; live: of the 147 kurt stem rows 89 hold Kürt and
--   58 hold kurt); the Turkish spellings keep their pages: kurtları 147 -> 58 with the same top 24 (the 89 rows that leave hold Kürt, whose stem folds to kurt: the collision again), karaları 53 -> 53.
--
-- COST
--   The helper runs once per search_cluster_ids call (inside an InitPlan: the stem query does not depend on a row) and costs microseconds. 198 makes the deny array ten entries long instead of three, and each kept root
--   is compared with it once. Measured locally (PostgreSQL 15, 2026-11-11, 10,000 calls each with a changing argument so nothing is folded away, a four-word query with three expandable words, alternated, two runs of each): 196's
--   text 245.5 and 254.0 ms, 198's text 241.4 and 257.2 ms, about 25 microseconds per call either way (the to_tsquery alone about 1). The plans are 194's and 196's, unchanged: the function body is not touched (three index scans,
--   no Seq Scan). What can change is the number of rows SCORED, and only downwards: a denied root removes candidates (yorgun 274 -> 6, kurti 152 -> 5, toplu 404 -> 169, mardin kaza 1 -> 0), never adds one.
--
-- KNOWN LIMITS
--   (1) The list is closed on purpose: a root is added only with a live count, as 196 says and as NO_SIBLING_TERMS of turkish-query.ts does. Further base-form words may
--       collide the same way; each needs its own count. The ten roots are not a proof that no other exists: they are the ones measured (see (6) for the -su names that were not).
--   (2) The deny set is read for the root of EVERY rule, as in 196 (an ASCII turkleri does not gain turk). So the plural-possessive form (R3) of a denied root loses it too: kurtlari
--       (kurt 147 live stem rows) and karalari (kara 53) no longer reach their stem from the ASCII spelling, and the replay shows both (196 -> 198). The Turkish spellings kurtları and karaları still find
--       them: the variants arm reads the Turkish stemmer's stem of the Turkish spelling (kurt, kara). Both are rare queries; the closed list is the cheaper side of the trade, and a rule that denied only
--       R1 and R2 would be a different helper text, which this file does not ship (the spec: one literal).
--   (3) A data rule was tried first and does not hold. The idea: skip the roots of a lexeme that is itself a stored stem with at least N live rows ('expand only when the lexeme is not itself a
--       common stored stem'). The live counts (2026-11-11): the colliding lexemes have mardi 56, yorgu 6, kurti 5, karasu 27, baski 200, toplu 169 and karsi 1,427 stored rows. The lexemes that must
--       expand: sonuclari, which must expand, has 20 stored rows (196's own count), tehdidi 122 and tokadi 4, while maasi, siginagi, maaslari, cocugu, guvenligi, vergisi, cezasi and kitabi have 0
--       (an ASCII word is almost never stored as written). To drop kurti (5) and yorgu (6) the threshold must be 5 or less, and to keep sonuclari (20) and tehdidi (122) it must be above 122: no threshold
--       separates them. A ratio does not either: the root has more rows than the lexeme in the wanted cases (tehdit 445 against tehdidi 122, maas 158 against maasi 0) and in the collisions (kurt 147
--       against kurti 5). And a rule that reads a table cannot be IMMUTABLE: the helper would become STABLE with a table read, and this file keeps 196's attributes.
--   (4) parti has the root 'part' (104 live stories carry that stem against 5,488 for parti): the AND with the other words bounds it, and the akp page did not change in 196's replay. tokadi
--       carries tokat (78 live rows, tokadi 4) and is the real inflection of the slap, tehdidi carries tehdit (445 against 122) and is wanted, and the helper gives kenti the root kent (458 live rows against 5), but the app's stem query
--       for the typed kenti is ke, so the replay measured no page change (138 -> 138). None of the three is denied.
--   (5) Everything else of 196's KNOWN LIMITS stands: the roots are closed rules, the roots are applied to every lexeme (a Turkish spelling widens too), junk roots cost a GIN key, a negated word excludes its roots,
--       and the widening costs scoring work in proportion (the 1000-row cap bounds it). 198 only removes roots, so it can only lower that cost.
--   (6) One collision is left on purpose: karasu keeps its root karas (R1; 5 live stem rows against karasu 27). Four of the five hold 'karası' (the stem karas: 'yüz karası', 'ana karası'), and they sit in the 198 page of
--       karasu below the Karasu rows (ranks 1-6 are Karasu rows). The spec's deny set is the seven roots above. karas is also the right root of a real inflection: the ASCII karasi (karası) prints 'karasi' | 'karas', and denying it
--       would cut that widening (the same trade-off as tokat). The other -su names reach roots of their own the same way (sarisu gives 'sarisu' | 'saris' | 'sari', akarsu 'akars', ilisu 'ilis'); no live count was taken for them,
--       and the app's own sibling rule already says the -su ending is a compound name, not a possessive (turkish-query.ts, rule A). A rule that left -su out of R2 would be a different helper text, and each root needs its own count.
--
-- LEDGER: this file records version 198 in supabase_migrations.schema_migrations itself, idempotently (the 095 pattern: insert ... on conflict do nothing, last statement before commit), so applying it by
-- posting the SQL (management API or psql) leaves `supabase migration list` correct; `supabase db push` records the same row. Re-applying is harmless (create or replace function, and the ledger insert
-- does nothing the second time). It writes no row for 197 or 191.
--
-- VERIFY (read-only, after applying)
--   1. select md5(p.prosrc), length(p.prosrc), p.provolatile, p.proparallel, p.proisstrict, p.prosecdef, pg_catalog.has_function_privilege('anon', p.oid, 'execute'), pg_catalog.has_function_privilege('authenticated', p.oid, 'execute'), pg_catalog.has_function_privilege('service_role', p.oid, 'execute'), p.proacl::text from pg_catalog.pg_proc p where p.oid = 'public.tayf_ascii_inflection_expand(tsquery)'::regprocedure;
--      expect e282da4628010153155d3bd8986db77f, 5133, i, s, true, false, false, false, true, {postgres=X/postgres,service_role=X/postgres}.
--   2. select md5(p.prosrc), length(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
--      expect c384c1f3a0dc337e5243b5a3e55985c0, 19562 (unchanged: 198 does not touch it).
--   3. select version, name from supabase_migrations.schema_migrations where version = '198'; expect one row, and one row for '196'.
--   4. select public.tayf_ascii_inflection_expand(pg_catalog.to_tsquery('pg_catalog.simple', 'mardi'))::text, public.tayf_ascii_inflection_expand(pg_catalog.to_tsquery('pg_catalog.simple', 'maasi'))::text;
--      expect 'mardi' | 'mard' and 'maasi' | 'maas'. Also karsi, kurti, baski, toplu give themselves alone, and yorgu gives 'yorgu' | 'yorg'.
--   5. the id sets: select count(*) from public.search_cluster_ids(array['mardin kaza'], 'mardin kaza', 24) expects 0 (it was 1; the count moves with the data), and
--      array['siginagi'] with 'siginagi' still returns the ids of array['sığınağı', 'siğinaği'] with 'siginagi'.
--   6. GET (searches are cached per query key, so check after the cache entry is rebuilt, one request per second): /?q=mardin%20kaza prints sonuç bulunamadı; /?q=Kurti has the Kosova stories in its
--      first 3; /?q=karasu shows 5 Karasu rows in its first 5; /?q=yorgun lists no New York row; /?q=emekli%20maasi, /?q=siginagi and /?q=maaslari still list the same stories as their Turkish spellings.
--
-- Safe to re-apply: create or replace function, the comment, the grants, the ledger insert `on conflict do nothing`. Nothing is dropped, altered, updated or deleted.
--
-- ROLLBACK (the data shape does not change; the app does not depend on 198): re-run the helper statement AND the `comment on function public.tayf_ascii_inflection_expand(tsquery)` statement of
--   196_search_ascii_inflection_roots.sql (restores md5(prosrc) bcd7b393693a64a5f6123b0ebd855e3d, length 5077), then
--     delete from supabase_migrations.schema_migrations where version = '198';
--     notify pgrst, 'reload schema';
--   Nothing is dropped: the helper stays, because search_cluster_ids (196's, which this file does not touch) calls it. Dropping it would break every search.
--
-- See tests/migrations/198-search-ascii-root-deny-collisions.test.ts and tests/migrations/sql/198-search-ascii-root-deny-collisions-dryrun.sql.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- The helper: 196's text byte for byte, with ONE literal changed (the closed deny set of the keep loop).
-- ---------------------------------------------------------------------------

create or replace function public.tayf_ascii_inflection_expand(p tsquery)
returns tsquery
language plpgsql
immutable
strict
parallel safe
set search_path = ''
as $fn$
declare
  v_txt   pg_catalog.text := p::pg_catalog.text;
  v_out   pg_catalog.text := v_txt;
  v_q     pg_catalog.text := pg_catalog.chr(39);
  v_lex   pg_catalog.text;
  v_roots pg_catalog.text[];
  v_keep  pg_catalog.text[];
  v_root  pg_catalog.text;
  v_alt   pg_catalog.text;
  v_any   pg_catalog.bool := false;
begin
  -- A tsquery prints a quote inside a lexeme as two quotes ('a.com/x''maasi'), and prints two adjacent quotes nowhere else. So two
  -- adjacent quotes mean that some lexeme holds an apostrophe (a URL or file token: a.com/x'maasi), and the [a-z] pattern below
  -- could match INSIDE that lexeme: the rewritten text would not parse back (ERROR 42601 in to_tsquery) and the typed call would
  -- raise, where 194's answers with no rows. Such a query is returned as it is. Nothing is lost: the stem arm's phrase for a URL
  -- token never matches the position-less stem-fold vectors anyway. No EXCEPTION block here (it would make the function
  -- PARALLEL UNSAFE) and no ts_rewrite (it re-sorts the operands and drops a ':*' flag).
  if pg_catalog.strpos(v_txt, v_q || v_q) > 0 then
    return p;
  end if;
  -- Every distinct quoted lexeme made only of [a-z] (the text of a tsquery is quoted lexemes and the operators & | ! <-> ( )).
  -- The order by makes the result a function of the argument alone (IMMUTABLE). Both patterns are constants: a lexeme is only
  -- ever the SUBJECT of a match, never part of a pattern, and nothing here is dynamic SQL.
  for v_lex in
    select distinct x.m[1]
    from pg_catalog.regexp_matches(v_txt, '''([a-z]+)''', 'g') as x(m)
    order by 1
  loop
    -- a lexeme with a suffix (':*' or a weight) cannot be wrapped in a group: leave it whole
    continue when pg_catalog.strpos(v_txt, v_q || v_lex || v_q || ':') > 0;
    v_roots := '{}'::pg_catalog.text[];
    -- R1, consonant + i/u (the possessive or accusative: maasi, siginagi, cocugu, guvenligi, kitabi): drop the vowel. When the
    -- root ends in g, b or d it is also tried with the soft letter hardened to k, p or t (siginag -> siginak, kitab -> kitap).
    -- A root that ends in a DOUBLED consonant (zamm, hakk, hiss, hatt, sirr, redd: the GEMINATE_ROOTS of src/lib/clusters/turkish-query.ts)
    -- is skipped, with its softened copy: the stemmer leaves zammi, hakki and hissi whole (their stored stem is the word itself), so
    -- such a root is the stem of ANOTHER word (hakkinda -> hakk, zammina -> zamm) and would pull its rows in (and push the real ones
    -- past the 1000-row cap).
    if v_lex ~ '^[a-z]{3,}[b-df-hj-np-tv-z][iu]$' then
      v_root := pg_catalog.left(v_lex, -1);
      if pg_catalog.right(v_root, 1) <> pg_catalog.substr(v_root, pg_catalog.length(v_root) - 1, 1) then
        v_roots := v_roots || v_root;
        v_alt := case pg_catalog.right(v_root, 1) when 'g' then 'k' when 'b' then 'p' when 'd' then 't' else null end;
        if v_alt is not null then
          v_roots := v_roots || (pg_catalog.left(v_root, -1) || v_alt);
        end if;
      end if;
    end if;
    -- R2, vowel + s + i/u (vergisi, cezasi, belediyesi, maasi): drop the possessive -si / -su.
    if v_lex ~ '^[a-z]{2,}[aeiou]s[iu]$' then
      v_roots := v_roots || pg_catalog.left(v_lex, -2);
    end if;
    -- R3, plural + possessive (maaslari, sonuclari; maaslarin): drop -lari / -leri / -laru / -leru, or -larin / -lerin.
    if v_lex ~ '^[a-z]{3,}l[ae]r[iu]$' then
      v_roots := v_roots || pg_catalog.left(v_lex, -4);
    end if;
    if v_lex ~ '^[a-z]{3,}l[ae]r[iu]n$' then
      v_roots := v_roots || pg_catalog.left(v_lex, -5);
    end if;
    -- keep a root only when it is 4 letters or longer and differs from the lexeme, once, in the order found, and is not on a
    -- closed deny set: roots that are the stem of another frequent word (ilisk of ilişkin, turk of türk, sevk of sevk), which iliski,
    -- turku and the soft letter of sevgi would reach. Mirrors NO_SIBLING_TERMS of turkish-query.ts; a root is added to the set only
    -- with a live count (production, 2026-11-11: hakk 1,828 stem rows against hakki 197, ilisk 3,734 against iliski 566, turk 1,349
    -- against turku 21, sevk 452 against sevgi 49).
    v_keep := '{}'::pg_catalog.text[];
    foreach v_root in array v_roots loop
      if pg_catalog.length(v_root) >= 4 and v_root <> v_lex and not (v_root = any (v_keep))
         and not (v_root = any (array['ilisk', 'turk', 'sevk', 'mart', 'york', 'kurt', 'kara', 'bask', 'topl', 'kars']::pg_catalog.text[])) then
        v_keep := v_keep || v_root;
      end if;
    end loop;
    if pg_catalog.cardinality(v_keep) > 0 then
      v_any := true;
      -- the exact quoted token (quotes included) becomes ( 'L' | 'root' | ... )
      v_out := pg_catalog.replace(
        v_out,
        v_q || v_lex || v_q,
        '( ' || v_q || v_lex || v_q || ' | '
          || (select pg_catalog.string_agg(v_q || u.r || v_q, ' | ' order by u.o) from pg_catalog.unnest(v_keep) with ordinality as u(r, o))
          || ' )');
    end if;
  end loop;
  if not v_any then
    return p;
  end if;
  return pg_catalog.to_tsquery('pg_catalog.simple'::pg_catalog.regconfig, v_out);
end
$fn$;

comment on function public.tayf_ascii_inflection_expand(tsquery) is
  'ASCII inflection roots (migration 196, deny set extended by 198): ORs each lexeme made only of [a-z] in a tsquery with the closed suffix-strip '
  'roots its ending can only mean (R1 consonant + i/u, R2 vowel + s + i/u, R3 plural + possessive; a root of 4 letters '
  'or more that differs from the lexeme; a final g, b or d is also tried as k, p or t): maasi -> maasi | maas, '
  'siginagi -> siginagi | siginag | siginak, maaslari -> maaslari | maaslar | maas. The Turkish stemmer cannot strip a '
  'suffix from an ASCII word, so search_cluster_ids (the stem-fold arm of migration 186) uses it on its stem query. '
  'A root that ends in a doubled consonant (zamm, hakk, hiss: the stem of another word) and the roots of a closed deny '
  'set are never added: ilisk, turk, sevk (196) and mart, york, kurt, kara, bask, topl, kars (198), each the stem of a different, '
  'more frequent word that a base-form word or a name reaches (mardin -> mart, yorgun -> york, kurti -> kurt, karasu -> kara, '
  'baski -> bask, toplu -> topl, karsi -> kars). Returns the argument unchanged when no lexeme has a root, when the query '
  'text holds two adjacent quotes (a lexeme with an apostrophe inside it, a URL token: the rewrite would not parse), '
  'and null for null. IMMUTABLE, STRICT, PARALLEL SAFE. service_role only.';

revoke all on function public.tayf_ascii_inflection_expand(tsquery) from public, anon, authenticated;
grant execute on function public.tayf_ascii_inflection_expand(tsquery) to service_role;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('198', '198_search_ascii_root_deny_collisions')
  on conflict do nothing;

commit;
