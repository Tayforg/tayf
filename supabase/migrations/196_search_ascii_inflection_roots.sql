-- 196_search_ascii_inflection_roots.sql
--
-- A diacritic-less search finds the inflected headlines of a word, not only its base form. Two functions, both additive: a new
-- helper public.tayf_ascii_inflection_expand(tsquery), and public.search_cluster_ids(p_variants text[], p_folded text, p_limit
-- integer default 12) replaced with the same signature. The body is 194's body with ONE CTE changed (qs, the stem-fold arm's query:
-- its else branch is passed through the helper). The variants arm, the folded arm, the stem-fold index and its predicate, 166's
-- guard, 172's tier, 194's ORDER BY, the 1000-row cap, the limit and the grants are 194's, byte for byte. No table, column, index,
-- trigger, cron job or data change; 083's two-argument function (the PGRST202 fallback of src/lib/clusters/search-query.ts) is not
-- touched. The app change of the same hunt (the sibling call folds the sibling) is a separate commit and has no deploy order
-- (h124-postship-1, hunt 125, 2026-11-11). This file takes the number 196: 191 is reserved and not applied, 192 to 195 are applied.
--
-- WHY (evidence: production, read-only, 2026-11-11 about 11:20-11:55Z, the live pg_get_functiondef and the checkout at 4086333)
--   * 186's stem-fold arm reads the stored stems folded to ASCII and matches them with the stem of the ASCII-folded query, and that
--     stem comes from the Turkish stemmer, which cannot strip a suffix from an ASCII word either. ts_lexize('turkish_stem') leaves
--     maasi, siginagi, cocugu, guvenligi and maaslari whole (siginagi becomes siginagı), while the Turkish spellings stem to maaş,
--     sığınak, çocuk, güvenlik. The stored stems folded are maas, siginak, cocuk, guvenlik, so the ASCII word meets only the headlines
--     that carry its base form. 186 (h96-search-2) covered a bare ASCII base form (siginak); an ASCII word WITH a suffix was left.
--   * The top 24 of the ASCII query against the top 24 of its Turkish spelling (the same p_folded, so the same order), 194's body:
--     emekli maasi 15 of 24 shared (6 of the ASCII rows were 60 to 198 days old, the Turkish page had none), maaslari 11 of 24,
--     cocugu 11 of 24, guvenligi 15 of 24, secim sonuclari 17 of 24, and siginagi returned 8 rows against 15. The hunt's control, baskani, shared 23 of 24.
--   * Read-only feasibility: a stem-fold query that ORs closed suffix-strip roots covers the Turkish candidates exactly:
--     emekli & (maasi | maas) 89 of 89, siginagi | siginag | siginak 15 of 15, guvenligi | guvenlig | guvenlik all of them,
--     maaslari | maas 157 of 157.
--
-- WHAT
--   public.tayf_ascii_inflection_expand(p tsquery) returns tsquery. LANGUAGE plpgsql, IMMUTABLE, STRICT, PARALLEL SAFE, SET
--   search_path = '', not security definer. A query whose text holds two adjacent quotes is returned unchanged before anything else
--   (below). For each distinct quoted lexeme of p::text that is made only of [a-z] (a constant pattern, regexp_matches over
--   '([a-z]+)'; the lexeme is only ever the SUBJECT of a match, never part of a pattern, and nothing is dynamic SQL) it computes
--   closed roots, keeps a root only when it is at least 4 letters long, differs from the lexeme and is not on a closed deny set
--   (ilisk, turk and sevk: roots that are the stem of another frequent word), and replaces the exact quoted token 'L' with
--   ( 'L' | 'root1' | ... ), then reads the text back with to_tsquery('simple', ...).
--   It returns p unchanged when no lexeme has a root, and null for null.
--     R1 consonant + i/u, lexeme ~ '^[a-z]{3,}[b-df-hj-np-tv-z][iu]$': left(lexeme, -1). When that root ends in g, b or d, a copy
--        with the final letter softened to k, p or t is added too (siginagi -> siginag and siginak, kitabi -> kitab and kitap).
--        A root that ends in a doubled consonant is skipped, and so is its softened copy: zamm, hakk, hiss, hatt, sirr and redd (the
--        GEMINATE_ROOTS of src/lib/clusters/turkish-query.ts). The stemmer leaves zammi, hakki and hissi whole, so their stored stem is the
--        word itself and such a root is never the stem of the lexeme but of ANOTHER word (hakkinda -> hakk, zammina -> zamm).
--     R2 vowel + s + i/u, lexeme ~ '^[a-z]{2,}[aeiou]s[iu]$': left(lexeme, -2) (vergisi -> vergi, cezasi -> ceza).
--     R3 plural + possessive: '^[a-z]{3,}l[ae]r[iu]$' gives left(lexeme, -4), '^[a-z]{3,}l[ae]r[iu]n$' gives left(lexeme, -5)
--        (maaslari -> maas, maaslarin -> maas).
--     Deny set (closed; a root is added to it only with a live count, as NO_SIBLING_TERMS of turkish-query.ts is): ilisk (the stem of
--        ilişkin; reached from iliski), turk (the stem of türk; from turku) and sevk (a stem of its own; the soft letter of sevgi). It is read for
--        the root of every rule, so an ASCII turkleri or sevkleri (R3) does not gain turk or sevk either. The root sevg of sevgi stays: it matches
--        no stored stem.
--     Two adjacent quotes: a tsquery prints a quote inside a lexeme as two quotes ('a.com/x''maasi') and prints two adjacent quotes nowhere
--        else, so the test strpos(text, two quotes) > 0 catches every lexeme with an apostrophe in it (a URL or file token). The [a-z] pattern
--        would match INSIDE such a lexeme, and the rewritten text would not parse back (ERROR 42601 in to_tsquery, where 194's function
--        answers a.com/x'maasi with no rows). The query is returned as it is; nothing is lost, because the stem arm's phrase for such a token
--        never matches the position-less stem-fold vectors. There is no EXCEPTION block (it would make the function PARALLEL UNSAFE) and no
--        ts_rewrite (it re-sorts the operands and drops a ':*' flag).
--   Pinned output (the dry-run and the live block check the text): emekli & maasi gives ( 'emekli' | 'emekl' ) & ( 'maasi' | 'maas' ),
--   siginagi gives 'siginagi' | 'siginag' | 'siginak', maaslari gives 'maaslari' | 'maaslar' | 'maas', sevgi gives 'sevgi' | 'sevg'; zam, iran, secim, kari
--   ('kar' is shorter than 4), erdogan, a digit lexeme and null are unchanged, and so are zammi, hakki, hissi, hatti (geminate roots) and iliski, turku (deny set). A lexeme that carries a suffix marker (maasi:*) is
--   left whole: a group cannot take one. The lexemes are visited in sorted order, so the text depends on the argument alone.
--   search_cluster_ids: ONE CTE changes, qs. qs was to_tsquery('simple', tayf_search_fold(qf::text)), null when numnode(qf) = 0; the else
--   branch is now tayf_ascii_inflection_expand(that). Everything after it (the third arm of cand, which is a literal copy of
--   clusters_search_stemfold_live_idx's predicate, kept, top, lw, hits and the ORDER BY) is 194's text; the ORDER BY reads q.qf, not qs,
--   so equal candidate sets rank alike. The roots only ever add stem-arm candidates: no row of the other two arms leaves.
--
-- BASE
--   The base is 194's body (md5 53eddcee85dc444ef0e24ad7087f5b00, length 18894; the test recomputes it). It is the body production
--   runs (STEP 0). This file is complete on its own: it replaces whichever body is installed with the one below, and it needs no
--   object that 194 did not already need (tayf_search_fold of 129, tayf_search_stem_fold and clusters_search_stemfold_live_idx of
--   186), so apply 194 first; 191 (reserved, not applied) and 192, 193, 195 are unrelated. Application: no deploy order. The proacl of
--   search_cluster_ids stays {postgres=X/postgres,service_role=X/postgres}, and the helper gets the same one.
--
-- STEP 0 (read-only, production, 2026-11-11 about 11:30Z)
--   select p.oid::regprocedure::text, md5(p.prosrc), length(p.prosrc), p.proacl::text, p.prosecdef, p.provolatile, p.proconfig::text
--     from pg_proc p where p.proname in ('search_cluster_ids', 'tayf_search_stem_fold', 'tayf_search_fold', 'tayf_ascii_inflection_expand')
--   -> search_cluster_ids(text[],text,integer) 53eddcee85dc444ef0e24ad7087f5b00, 18894, {postgres=X/postgres,service_role=X/postgres}, t, s,
--      {search_path=""}: the body of 194 in the repository, md5 and length equal. search_cluster_ids(text[],integer) aabf54347c8f929090419335d5d48f19
--      (083's, not touched). tayf_search_stem_fold(tsvector) 709be5df31d85ac692729f673e7e7900 and tayf_search_fold(text) 77a0656fab6d06f5fb86f75afdfb6391
--      (the two helpers the third arm reads; not touched). No tayf_ascii_inflection_expand yet.
--
-- REPLAY (production, SELECT only through sbq.py in a read-only transaction, 2026-11-11 about 12:25-12:30Z, after the review fixes: the geminate
--   skip, the deny set and the doubled-quote guard)
--   194's body and this file's body ran inline as plain SELECTs, with literal arguments exactly as src/lib/clusters/search-query.ts builds them
--   (canonicalSearchQuery, the alias expansion, turkishQueryVariants, foldTr, the sibling call with the sibling's own p_folded; p_limit removed, so every
--   scored candidate up to the 1000-row cap, in rank order; the first 24 is the page). The two bodies of one query ran in ONE statement (one now()). The helper
--   is not on production, so its text was computed by the helper itself on a local PostgreSQL 15 from production's own qs text and pasted into the inline body
--   as a to_tsquery literal.
--   query (typed)        candidates 194 -> 196   Turkish spelling       candidates 194 -> 196   page shared ASCII / Turkish, before -> after
--   emekli maasi              40 -> 89           emekli maaşı               89 -> 89              15 -> 24
--   siginagi                   8 -> 15           sığınağı                   15 -> 15               8 -> 15 (rows 8 -> 15)
--   maaslari                  24 -> 157          maaşları                  156 -> 157             11 -> 24
--   cocugu                   161 -> 894          çocuğu                    894 -> 894             11 -> 24
--   guvenligi                480 -> 1000 (cap)   güvenliği                1000 -> 1000             15 -> 24
--   secim sonuclari           97 -> 264          seçim sonuçları           264 -> 264             17 -> 24
--   imamoglu                 603 -> 603          imamoğlu                  603 -> 603             24 -> 24
--   ozgur ozel              1000 -> 1000         özgür özel               1000 -> 1000             24 -> 24
--   First check, every pair above: the candidate set of 196's ASCII query EQUALS the set of 196's Turkish spelling (the third arm is built from
--   p_folded, which is the same for both), and no Turkish spelling loses an id. Second: the new top 24 of emekli maasi has 0 rows older than 60 days
--   and its oldest row is 23.0 days (194: 6 rows older than 60 days, the oldest 198.2 days; median age 9.48 -> 6.96 days), the same page as
--   emekli maaşı. siginagi returns 15 rows, as sığınağı does.
--   Controls (the id sets of the typed call, 194 against 196, identical unless noted, and the top 24 in the same order): secim 1000, iran 1000, erdogan 1000,
--   deprem 438, burdur 34, miller 18, yurt disi 218, siginak 15, trafik cezasi and cezası 18, iran -"israil saldirisi" 1000.
--   Roots that are the stem of another word (the review fix; the stemmer leaves hakkı, ilişki, türkü whole, hakkında stems to hakk and ilişkin to ilisk):
--   hakkı and hakki 197 -> 197, umut hakkı and umut hakki 5 -> 5, ilişki and iliski 566 -> 566, sevgi 49 -> 49, turku and türkü 21 -> 21, each with 194's
--   id set AND its page order. Without the geminate skip and the deny set the stem arm of hakki held 1,996 candidates (the review's reproduction, read-only,
--   the same day: hakki 197 stem rows against hakk 1,828) and the 1000-row cap kept only 109 of the 197 real rows. The typed call of elektrik zammı,
--   elektrik zammi, dogal gaz zammi, doğal gaz zammı and asgari ucret zammi is 0 -> 0 (the one story whose stem is zamm is not returned any more), and the
--   page the app builds is the sibling call's, the same rows in the same order under both bodies: elektrik zammı 9 rows, doğal gaz zammı 4, umut hakkı 7
--   (typed 5 + the sibling's 2), trafik cezası 24 (typed 18 + the sibling's); hakkı and hakki fill the page with the typed call.
--   akp (the alias) and the raw akp or "ak parti" query: 1000 -> 1000 and the top 24 identical, but 2 ids change at the 1000-row cap: 'parti' has the
--   root 'part', and two newer stories with the stems ak and part (Erdoğan headlines) now take the place of two older ones (KNOWN LIMITS 2).
--   guvenligi loses 166 of its 480 old ids for the same reason (the cap now holds the 1000 most recent of 1500+, as the Turkish spelling has always
--   done), and none of the top 24 of the Turkish spelling moves.
--   The pages the app builds (the typed call, then the sibling call when the page is short): asgari ucret zammi 0 -> 7 rows and dogal gaz zammi
--   0 -> 4 rows (Part A of the hunt: the sibling folds the sibling; this file does not change them: both bodies return the same 7 and 4 rows).
--   a.com/x'maasi and x.com/a'kitabi (an apostrophe inside a URL token, as the app sends them): 194 answers with 0 rows; the installed function does the
--   same on the local dry-run (the fuzz block), where the unguarded helper raised 42601.
--
-- COST (EXPLAIN (ANALYZE), 194's body against 196's, inline, the SAME arguments, alternated, one warm-up each, production, 2026-11-11 about
--   11:40-11:55Z; the spec's gates are +20% and, for guvenligi, p95 of 20 calls within 1.5x of 194). The helper runs once per call (it sits inside an InitPlan: the
--   stem query does not depend on a row) and costs microseconds; the plans are 194's (the three index scans under one HashAggregate, no Seq
--   Scan, clusters_search_stemfold_live_idx used by the third arm for guvenligi). What grows is the number of rows SCORED, because the id set grows
--   (the scoring cap is 1000 rows):
--   (a) the SAME arguments, the id set does not change (so the scored rows do not change either; medians of 5): deprem 45.20 -> 44.99 ms (1.00x),
--       imamoglu 60.94 -> 60.77 (1.00x), emekli maaşı (a Turkish spelling, 89 ids both ways) 15.48 -> 15.30 (0.99x).
--   (b) the SAME arguments, the id set GROWS to the Turkish spelling's, so the scored rows grow with it (medians of 5; guvenligi of 20 runs):
--       guvenligi 49.22 -> 98.81 ms (2.01x; p95 55.22 -> 109.33, 1.98x: 479 candidates become the 1000-row cap), cocugu 21.12 -> 88.40 (4.19x: 161 -> 893),
--       maaslari 7.11 -> 19.80 (2.79x: 24 -> 157), secim sonuclari 18.63 -> 44.17 (2.37x: 97 -> 264), emekli maasi 9.72 -> 14.58 (1.50x: 40 -> 89),
--       siginagi 5.49 -> 6.48 (1.18x: 8 -> 15). The +20% gate and the 1.5x p95 gate of the spec, read as 194's body and 196's body on the same
--       arguments, are therefore NOT met by a widening query: it scores more rows by design, which is the fix.
--   (c) EQUAL RECALL, the like-for-like comparison: 196 on the ASCII spelling against 194 on its Turkish spelling (the same p_folded, the same id set, so
--       the same scored rows; alternated, medians of 5, guvenligi p95 of 20 runs): guvenligi 98.28 vs 98.17 ms (1.00x; p95 124.61 vs 111.46, 1.12x), cocugu
--       86.40 vs 86.92 (0.99x), maaslari 19.80 vs 19.35 (1.02x), secim sonuclari 40.72 vs 41.03 (0.99x), emekli maasi 14.74 vs 14.79 (1.00x), siginagi
--       6.04 vs 6.20 (0.97x). Within the gates: 196 on the ASCII spelling costs what 194 already cost on the Turkish spelling of the same word.
--   (d) the helper alone, locally (PostgreSQL 15, 10,000 calls with a changing argument so that nothing is folded away): about 25 microseconds per call for a
--       four-word query with three expandable words, against about 1 microsecond for the to_tsquery alone (re-measured after the review fixes); it runs once per search_cluster_ids call.
--
-- KNOWN LIMITS
--   (1) The list is closed on purpose: the possessive and accusative ending after a consonant (R1), the possessive after a vowel (R2) and the plural
--       possessive (R3). Other cases (maasta, siginaga, maaslarda) are not covered; a rule is added only with the live counts that justify it. A
--       root of 3 letters (maa, kar, gaz) is never used.
--   (2) The roots are applied to every lexeme of the stem query, which is built from p_folded, so a Turkish spelling widens too, by the same roots:
--       maaşları gains 1 (the singular 'maaş'). A common word can carry a root that is another stem: parti has the root 'part' (104 live
--       stories have that stem). The AND with the other words of the query bounds it, and the page of akp is unchanged, but it is a widening that the
--       spec accepted and the replay measured (the akp row above). Two kinds of root are NOT added, because the replay showed what they cost: (a) a root that
--       ends in a doubled consonant (the geminate skip: zamm, hakk, hiss, hatt, sirr, redd) and (b) the three roots of a closed deny set (ilisk, turk, sevk).
--       The stemmer leaves hakkı, ilişki, türkü, zammı whole, so those words are stored as themselves, while the roots are the stems of other words;
--       live stem-fold counts (index predicate, 2026-11-11): hakki 197 against hakk 1,828, iliski 566 against ilisk 3,734, turku 21 against turk 1,349,
--       sevgi 49 against sevk 452, zammi 20 against zamm 15. The unrelated rows would enter the candidates, take the +2.0 literal tier (lw cuts hakkı to
--       the prefix hakk, which hakkında meets at a word start) and, newer, push the real rows past the 1000-row cap. The deny set is closed on purpose,
--       like NO_SIBLING_TERMS: a root is added only with a live count. It is read for the root of every rule, so an ASCII turkleri or sevkleri (R3) does
--       not gain turk or sevk either; the Turkish spelling of the same word is not affected. A data-only rule (expand only a lexeme that is not a stored
--       stem) does not separate the cases: sonuclari, which must expand, has 20 stored rows and turku 21. The root sevg of sevgi stays (0 live rows).
--   (3) Some roots are junk and match no stem (vergis, imamogl, verk): they cost one more key in the GIN lookup and add nothing.
--   (4) A negated word excludes its roots too: maaslari -memur is ( 'maaslari' | 'maaslar' | 'maas' ) & !'memur', and -maasi excludes the stem
--       maas, which is what -maaşı excludes.
--   (5) The widening is the point, and it costs scoring work in proportion (COST): a query whose set grows from 161 to 893 candidates scores 893 rows
--       instead of 161. The 1000-row cap, which is 185's, still bounds it.
--   (6) Ranking is untouched: the score reads p_folded and the title, so the Turkish spelling and the ASCII spelling of one word order a shared
--       candidate the same way (194's parity property), and now find the same candidates.
--
-- LEDGER: this file records version 196 in supabase_migrations.schema_migrations itself, idempotently (the 095 pattern: insert ...
-- on conflict do nothing, last statement before commit), so applying it by posting the SQL (management API or psql) leaves
-- `supabase migration list` correct; `supabase db push` records the same row. Re-applying is harmless (create or replace function,
-- and the ledger insert does nothing the second time).
--
-- VERIFY (read-only, after applying)
--   1. select md5(p.prosrc), length(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
--      expect c384c1f3a0dc337e5243b5a3e55985c0, 19562.
--   2. select md5(p.prosrc), length(p.prosrc), p.provolatile, p.proparallel, p.proisstrict, p.prosecdef, pg_catalog.has_function_privilege('anon', p.oid, 'execute'), pg_catalog.has_function_privilege('authenticated', p.oid, 'execute'), pg_catalog.has_function_privilege('service_role', p.oid, 'execute'), p.proacl::text from pg_catalog.pg_proc p where p.oid = 'public.tayf_ascii_inflection_expand(tsquery)'::regprocedure;
--      expect bcd7b393693a64a5f6123b0ebd855e3d, 5077, i, s, true, false, false, false, true, {postgres=X/postgres,service_role=X/postgres}.
--   3. select p.prosecdef, p.provolatile, pg_catalog.has_function_privilege('anon', p.oid, 'execute'), pg_catalog.has_function_privilege('authenticated', p.oid, 'execute'), pg_catalog.has_function_privilege('service_role', p.oid, 'execute'), p.proacl::text from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
--      expect t, s, false, false, true, {postgres=X/postgres,service_role=X/postgres}.
--   4. select version, name from supabase_migrations.schema_migrations where version = '196'; expect one row.
--   5. select public.tayf_ascii_inflection_expand(pg_catalog.to_tsquery('pg_catalog.simple', 'emekli & maasi'))::text;
--      expect ( 'emekli' | 'emekl' ) & ( 'maasi' | 'maas' ).
--   6. the id set: select count(*) from public.search_cluster_ids(array['siginagi'], 'siginagi', 24) expects 15 (it was 8; the count moves with the data) and
--      equals the count for array['sığınağı', 'siğinaği'] with 'siginagi'; array['emekli maasi'] with 'emekli maasi' returns the ids of the Turkish spelling.
--   7. GET /?q=emekli%20maasi, /?q=siginagi and /?q=maaslari (one request per second) list the same stories as /?q=emekli%20maaşı, /?q=sığınağı and
--      /?q=maaşları, and the first has no row older than 60 days; /?q=secim, /?q=iran and /?q=erdogan are unchanged; explain (analyze) of the body for deprem
--      stays within +20% of 194's (about 45 ms) and for guvenligi uses clusters_search_stemfold_live_idx.
--
-- Safe to re-apply: create or replace function (twice), the two comments, the grants, ledger insert `on conflict do nothing`. Nothing is dropped,
-- altered, updated or deleted.
--
-- ROLLBACK (the data shape does not change; the app does not depend on 196): re-run the function statement AND the
--   `comment on function public.search_cluster_ids(text[], text, integer)` statement of 194_search_rank_display_title.sql (restores
--   md5(prosrc) 53eddcee85dc444ef0e24ad7087f5b00, length 18894), then
--     drop function if exists public.tayf_ascii_inflection_expand(tsquery);
--     delete from supabase_migrations.schema_migrations where version = '196';
--     notify pgrst, 'reload schema';
--   in that order (the helper goes after the function that calls it). 186's helper and index and 083's search_cluster_ids(text[], integer) and the
--   app's PGRST202 fallback are not involved.
--
-- See tests/migrations/196-search-ascii-inflection-roots.test.ts and tests/migrations/sql/196-search-ascii-inflection-roots-dryrun.sql.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- The helper: closed ASCII suffix-strip roots for the stem arm's query. Created first: search_cluster_ids reads it.
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
         and not (v_root = any (array['ilisk', 'turk', 'sevk']::pg_catalog.text[])) then
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
  'ASCII inflection roots (migration 196): ORs each lexeme made only of [a-z] in a tsquery with the closed suffix-strip '
  'roots its ending can only mean (R1 consonant + i/u, R2 vowel + s + i/u, R3 plural + possessive; a root of 4 letters '
  'or more that differs from the lexeme; a final g, b or d is also tried as k, p or t): maasi -> maasi | maas, '
  'siginagi -> siginagi | siginag | siginak, maaslari -> maaslari | maaslar | maas. The Turkish stemmer cannot strip a '
  'suffix from an ASCII word, so search_cluster_ids (the stem-fold arm of migration 186) uses it on its stem query. '
  'A root that ends in a doubled consonant (zamm, hakk, hiss: the stem of another word) and the roots of a closed deny '
  'set (ilisk, turk, sevk) are never added. Returns the argument unchanged when no lexeme has a root, when the query '
  'text holds two adjacent quotes (a lexeme with an apostrophe inside it, a URL token: the rewrite would not parse), '
  'and null for null. IMMUTABLE, STRICT, PARALLEL SAFE. service_role only.';

revoke all on function public.tayf_ascii_inflection_expand(tsquery) from public, anon, authenticated;
grant execute on function public.tayf_ascii_inflection_expand(tsquery) to service_role;

-- ---------------------------------------------------------------------------
-- Ranked, folded archive search: 194's body with the qs CTE (the stem arm's query) passed through the helper.
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
    -- 196: the stemmer cannot strip a suffix from an ASCII word either (maasi, siginagi, maaslari, cocugu and guvenligi stay whole),
    -- so the stem query of an ASCII-typed inflected word never meets the stored Turkish stem (maas, siginak, cocuk, guvenlik).
    -- public.tayf_ascii_inflection_expand ORs each ASCII lexeme with the roots its ending can only mean (a closed list of three
    -- rules, 4 letters or more: maasi -> maas, siginagi -> siginag and siginak, maaslari -> maas), so the stem arm finds what
    -- the Turkish spelling finds. The arms before it, the guard, the tiers and the ORDER BY read nothing of qs.
    select case when pg_catalog.numnode(q.qf) = 0
                then null
                else public.tayf_ascii_inflection_expand(pg_catalog.to_tsquery('pg_catalog.simple'::pg_catalog.regconfig, public.tayf_search_fold(q.qf::pg_catalog.text))) end as qs
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
  'display-title ranking of migration 194 and the ASCII inflection roots of migration 196. Candidates: '
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
  'changes recall: the id set is 186''s, plus (196) the roots. Stem arm (196): the stem lexemes of the ASCII-folded '
  'query are ORed with closed suffix-strip roots (public.tayf_ascii_inflection_expand: maasi -> maas, siginagi -> '
  'siginag and siginak, maaslari -> maas), so an ASCII-typed inflected word finds what its Turkish spelling '
  'finds. Returns ids ONLY. service_role only.';

revoke all on function public.search_cluster_ids(text[], text, integer) from public, anon, authenticated;
grant execute on function public.search_cluster_ids(text[], text, integer) to service_role;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('196', '196_search_ascii_inflection_roots')
  on conflict do nothing;

commit;
