-- 209_neutral_title_repick_loaded_cased.sql
--
-- Neutral-title re-pick: a stored title that carries one outlet's partisan epithet, and a stored title an İşçi Haber headline lost its
-- capitals in, are offered again. One function re-created (public.neutral_title_repick_candidates(text, integer)); the body is 208's
-- with TWO added branches at the end of the outer WHERE (no stamp condition, like 184's SHOUT branch and 208's). No table, column, index,
-- trigger or data change, no backfill, no UPDATE, no EXTRACTIVE_MODEL_ID bump (the v6 heal is running), no LLM, no cron change. The app
-- change that goes with it is neutral-title.ts: three loaded rules (the label 'katil' for a party or a state, 'ihale rantı', 'rant kapısı'; on
-- the headline's own words), and an ordinal ('111.', '13.') that is no sentence end for the capital evidence. The cron heals the clusters
-- through its normal re-pick ({ incumbent, floor } for a stored title that fails the gate, since 184); nothing here writes to clusters.
-- (h168-titles-1 and h168-titles-2, hunt 168, 2026-11-12. Both specs re-create this one function, so ONE migration carries both
-- branches: a second one would have to copy the first's body.)
-- tests/migrations/209-repick-loaded-cased.test.ts pins all of it.
--
-- WHY
--   (A) 49facb31-1ba4-4816-a679-e6bff7a03c4f (12 members when the finding was read, 13 at the replay; the home page's top story: 11 sources,
--   İktidar 38 / Bağımsız 50 / Muhalefet 12)
--   is served with Star's "Trump, katillere desteğiyle övündü: Bu iş bittiğinde İsrail'e gidip başbakan olabilirim" as its h1; Gazete
--   Oksijen and Karar write "Trump: Bu iş bittiğinde İsrail'e gidip başbakan olabilirim", AA the same behind "ABD Başkanı Trump:".
--   8ab79860-9f6e-414d-acdf-082dc7ff4194 (4 members) is served with Akşam's "Şerbetli tatlıya tuzlu fatura. İBB yönetimine ihale rantı
--   tepkisi". The loaded lexicon charged neither (the h54 epithet rule is 'Katil|Soykırımcı|İşgalci <Capital>' and 'katil israil|netanyahu';
--   there is no 'rant' rule), so the h42 'loaded' incumbent switch kept them, and both rows sit at or near their stamp (11 of 12, 3 of 4),
--   so only growth (+3 at least, or half) offered them again. neutral-title.ts now charges them; this function offers them.
--   (B) İşçi Haber's machine-cased titles stored before #290 stay on live h1s because nothing re-offers them: 3039d877 "Bakan Bayraktar'dan
--   libya ve venezuela mesajı", 0834c3ba "... Hakan Fidan çöp31 zirvesini değerlendirdi" (six outlets write COP31), 609f9e22 "...
--   Pezeşkiyan'dan çöp31 temasları açıklaması", 4797e4f6 "Bakan kurum: ...", ecbc23a0 "Bakan memişoğlu: ...", 3175d6f7 "Dışişleri
--   bakanlığından ...", 8541cbe6 "İranlı bakandan batı basınına ...", 588c58ce "Bakan bak, Kktc ... ataoğlu", 2040cdf1 "... undp Başkanı de
--   croo ...", 37915ace "Cevdet yılmaz COP31 ...". The picker recases such a title from its siblings (#290, h164-titles-2); the rows
--   are stamped at their own count, v6, in no stale set. The same code read an ordinal as a sentence end ('111. Dönem'), so 9df76d26's
--   re-pick came out half-recased ("Cumhurbaşkanı Erdoğan 111. dönem Kaymakamlar Kurası'nda"; twelve siblings write '111. Dönem') and
--   2490109a's floor pick turned "13. yargı paketi ..." into the worse "13. yargı Paketi ...": fixed in caseEvidence (neutral-title.ts).
--
-- THE RULE (two branches, no stamp condition: a stored title that fails what the picker now knows is a defect at any stamp)
--   (A) the stored title, cut at a speaker's opening quote ("<speaker>: '" ... what follows is the speaker's own words, as
--   neutral-title.ts' ownWordsFolded cuts it; 208's teaser rule cuts the same way), matches one of four patterns on the text AS WRITTEN,
--   never on public.tayf_search_fold (it folds 'ı' to 'i' and would read 'katılanlara' as 'katilanlara'):
--     katil(ler) + a case suffix (e, i, in, ini, ine, lere, leri, lerin, lerine) + a space run + 'destek' or 'desteğ-'
--     katil + a space run + rejim | devlet | ordu | hükümet | siyonist
--     ihale + a space run + 'rant'
--     rant + a space run + 'kapıs' / 'kapis'
--   with a capital K, İ/i and D allowed where the word opens ([Kk], [İi], [Dd]). The first pattern differs from the spec's by one letter:
--   'desteğiyle' is the very word of 49facb31's title, and 'destek' does not match it ('ğ' is not 'k'), so the class is [kğ]. The left edge is
--   a character that is neither a letter nor a digit, the Turkish letters spelled out in the class so it never depends on the database
--   locale (TypeScript's L). Each is a SUBSET of the loadedPenalty verdict, never wider: a title the SQL offers and the picker does not
--   change would be re-picked, kept, stamped and offered again on the next tick.
--   (B) the stored title is the wording of an İşçi Haber member (a member of the last fifteen days whose btrim(title) equals the stored
--   title's: the slug is LOWERCASE_PRONE_SOURCE_SLUGS, pinned by the test) and one of its lower-case words (at least two characters,
--   lower-case letters and digits only, never behind an apostrophe) has the same tayf_search_fold as a word that another member's title
--   writes with a capital: not the title's first word, not behind a token that ends in '.', ':', '!', '?' or '…' (an ordinal of one to
--   three digits and a dot is no end: '111. Dönem', '13. Yargı'), at most one to three spaces apart so the lookbehind stays bounded. A letters-
--   and-digits code folds equal ('çöp31' and 'COP31' both fold to 'cop31'), so codes are covered. Six guards keep SQL inside what the
--   picker does (h169 review, db-209-B: the first form counted every distinct title, quoted spans included, and offered 8f09d48c's İşçi Haber
--   title "Cumhurbaşkanı Erdoğan: Gazze barış anlaşması uygulanmıyor" at five, six and seven members, where the re-pick keeps it: offered,
--   kept, stamped, offered again on every tick):
--     1. a title that is Title Case (at least four words of three letters or more, at least 80% of them with a capital: neutral-title.ts'
--        caseEvidence reads it as capitalising common nouns) adds no capital;
--     2. a cluster of five members or more asks two other titles for the word (LENIENT_MIN_TITLES), and the support counts distinct FOLD
--        KEYS (the house fold with every run of characters outside a-z and 0-9 as one space), not titles: the same title written twice, with
--        other capitals or other marks, counts once;
--     3. a title that holds a quotation mark (" “ ” « » anywhere, or an opening ' or ‘ at the start or after a space) is no evidence:
--        TypeScript reads no capital inside a quoted span, and the copy of a fold twin it keeps (usableItems, newest first) may be the quoted one;
--        an apostrophe inside a word is not a quote;
--     4. a title with no lower-case letter, or with three shouted words in a row (SHOUT_RUN = 3 words of SHOUT_MIN_LETTERS = 3 letters or more;
--        here a token of three characters or more with no lower-case letter before an apostrophe, a superset of TypeScript's: a bare number
--        counts), is no evidence: its case is lost;
--     5. a title whose fold key is that of a title excluded by 3 or 4, or the stored title's own key, is dropped (8f09d48c's AA title is the
--        twin of ajans-haber's quoted one, and a title that is the stored one with other capitals is the stored title to usableItems);
--     6. the veto: a word that any member of another outlet than İşçi Haber writes in lower case, not as the first token of its title (a
--        character and then one to three spaces, a hyphen, a dash or a slash before it), is dropped. TypeScript's case-trusted sibling that
--        writes the word in lower case vetoes the recasing; the veto reads every such member, quoted or shouted ones included, which only
--        makes the SQL narrower.
--   The check on the İşçi Haber member comes first, as one hashed set of the outlet's last fifteen days (cluster and title: about five thousand
--   rows, an index-only scan and one probe each), so the word scan runs only on the clusters that pass it. The title is read to its first
--   thousand characters on both sides (EVIDENCE_MAX_CHARS). Every regular expression is linear: one class under +, bounded repeats, a lookbehind
--   of one to three spaces, a shouted word is one class under {3,} behind a space-edge lookbehind.
--   Everything else is 208's byte for byte: the three CTE joins, the quote-aware stale key, the 7-day window of article_title_versions, the 14-day
--   window and the newest 5000 of the outer select, the model, NULL-stamp, growth, gate-fail, young, shout, placeholder and teaser branches, the
--   order and the 1..50 limit clamp.
--   Not offered, by design: a stored title that is no İşçi Haber member's text (9df76d26's is a re-pick's own recasing: it is recased when the
--   cluster grows, and the ordinal fix no longer half-recases it), the five İşçi Haber rows the picker keeps (8e179d37, 0792bdea, 688af268,
--   f53a766f, 829ef5cc: 0792bdea and 829ef5cc would be offered without the Title Case and the two-title guards: their capitals come from
--   "Siyasilerden 10 Kasım Atatürk'ü Anma Günü Mesajları" and onedio's Title Case title), and 8541cbe6 ("İranlı bakandan batı basınına
--   soykırım eleştirisi", two members): its one sibling quotes a span (AA's "sessiz soykırımına"), so guard 3 takes it out although the picker
--   would recase 'batı'. That is the price of guard 3, a recall loss of one row of fifteen that the first form offered; the row is recased when
--   the cluster grows (stamped at 2 members, offered again at 3). Not mirrored, because the replay shows no row that needs it: the picker's
--   trusted-twin rule (a case-trusted member wrote exactly the stored casing) as such. A member of another outlet that wrote exactly the stored
--   title writes its lower-case words, so the veto drops them, and a trusted copy with other capitals is the stored title's twin (guard 5).
--   A row the veto and the guards still let through and the picker keeps is the residue below (0 measured).
--
-- STEP 0 -- the body this migration starts from (production, read-only, 2026-11-12 ~23:00Z)
--   select md5(p.prosrc), length(p.prosrc), p.proconfig::text, p.proacl::text, p.prosecdef, p.provolatile
--     from pg_proc p where p.proname = 'neutral_title_repick_candidates';
--   -> md5 5105bed7a553b41a8c7b30855af4aecc, length 6937, prosecdef t, provolatile s, proconfig {search_path=""},
--      proacl {postgres=X/postgres,service_role=X/postgres}.
--   That md5 equals the md5 of 208's body (the text between the dollar-quote markers in 208_neutral_title_repick_generic.sql), so production
--   runs 208's body and no later migration redefines the function. tests/migrations/209-repick-loaded-cased.test.ts recomputes the md5 of
--   208's body. If a later release changes prosrc, compare again before applying and do not apply on a mismatch.
--
-- REPLAY (production, read-only: 2026-11-12 ~23:20Z for the first form, 2026-11-13 ~00:45Z for the form after the h169 review below; the
--   headline cron's own call: the stored title as the incumbent, { floor } when it fails the gate, the members flagged opinion, english and
--   caseUnreliable as the cron flags them, the new picker)
--   (1) The SQL equals the port. The regular expressions of branch B (the quote, lower-case-letter, shouted-run, fold key, veto, capital-
--       word, lower-word and Title Case regular expressions of this file) run in Postgres on 234 titles (every stored and member title of the
--       fixtures plus the shapes of the test) give the same flags, keys and words as the port in the test: 0 disagreements. The first form,
--       on the 1,408 clusters (not archived, no LLM title, at least 2 members, updated in the last 6 days), offered 15 rows that 208's body
--       does not (A 2, B 13), and the port gave the same 2 and the same 13: 0 disagreements.
--   (2) The whole function over its own window (14 days, p_limit lifted): 208's body offers 2 rows (1c7c34ba, 3a6fde82); the first form of 209
--       offered 19 (the 17 new: A 2 and B 15); the body of this file offers 18: the 16 new are A 2 and B 14. The one row of the first form
--       that is gone is 8541cbe6 (guard 3, see 'Not offered'); every other row is offered as before. The two beyond the 6-day set are
--       ad976c62 and cdc9adfb.
--   (3) The TypeScript re-pick of the 16 (members read on production 2026-11-13, newest first) changes all 16 and keeps none (the residue,
--       limit 3: 0). The two rows of 208 stay kept by the picker (1c7c34ba, 3a6fde82: 208's, not this migration's).
--       Each of the 16, stored -> picked:
--         49facb31  "Trump, katillere desteğiyle övündü: Bu iş bittiğinde İsrail'e gidip başbakan olabilirim" -> "Trump'tan İsrail çıkışı: “Bu iş bittiğinde gidip başbakan olabilirim”"
--         8ab79860  "Şerbetli tatlıya tuzlu fatura. İBB yönetimine ihale rantı tepkisi" -> "İBB Meclisi'nde Sayıştay'ın ihalelerdeki tespitlerine ilişkin soru önergesi"
--         3039d877  "Bakan Bayraktar'dan libya ve venezuela mesajı" -> "Bakan Bayraktar'dan Libya ve Venezuela ile enerji işbirliği mesajı"
--         0834c3ba  "Dışişleri Bakanı Hakan Fidan çöp31 zirvesini değerlendirdi" -> "Dışişleri Bakanı Fidan'dan COP31 Liderler Zirvesi'ne dair paylaşım"
--         609f9e22  "İran Cumhurbaşkanı Pezeşkiyan'dan çöp31 temasları açıklaması" -> "İran Cumhurbaşkanı Pezeşkiyan'dan COP31 temasları açıklaması"
--         4797e4f6  "Bakan kurum: Tarihte bugün hiç olmadığımız kadar birbirimize ihtiyaç duyuyoruz" -> "Bakan Kurum: Bugün hiç olmadığımız kadar birbirimize ihtiyaç duyuyoruz"
--         ecbc23a0  "Bakan memişoğlu: Bilgi ve tecrübeyi iş birliğine dönüştüreceğiz" -> "Bakan Memişoğlu: Bilgi ve tecrübeyi iş birliğine dönüştüreceğiz"
--         3175d6f7  "Dışişleri bakanlığından Mısır'daki kazaya taziye" -> "Dışişleri Bakanlığından Mısır'a tren kazası için taziye mesajı"
--         588c58ce  "Bakan bak, Kktc başbakan yardımcısı ataoğlu ile görüştü" -> "Bakan Bak, KKTC Başbakan Yardımcısı Ataoğlu ile görüştü"
--         2040cdf1  "Emine Erdoğan, undp Başkanı de croo ile bir araya geldi" -> "Emine Erdoğan, undp Başkanı De Croo ile bir araya geldi"
--         37915ace  "Cevdet yılmaz COP31 zirvesinde diplomatik temaslarda bulundu" -> "Cevdet Yılmaz COP31 zirvesinde diplomatik temaslarda bulundu"
--         441ea6a3  "Slovenya Cumhurbaşkanı pirc Musar'dan Çevre uyarısı" -> "Slovenya Cumhurbaşkanı Pirc Musar'dan Çevre uyarısı"
--         2490109a  "13. yargı paketi ne zaman çıkıyor? Detaylar belli oldu" -> "13. Yargı Paketi ne zaman çıkıyor? Detaylar belli oldu"
--         23b4563e  "Kabine toplantısı sona erdi: Cumhurbaşkanı Erdoğan açıklamaları başladı" -> "Kabine Toplantısı sona erdi: Cumhurbaşkanı Erdoğan açıklamaları başladı"
--         ad976c62  "Cumhurbaşkanı yardımcısı Yılmaz'dan dış politika vurgusu" -> "Cumhurbaşkanı Yardımcısı Yılmaz: Türkiye, krizlerin çözümünde aktif rol üstleniyor"
--         cdc9adfb  "İngiltere'de palestine action yasak kararı tartışılıyor" -> "İngiltere'de Palestine Action yasak kararı tartışılıyor"
--       None is worse: no pick carries an epithet, a lost capital or the half-recased ordinal; 37915ace keeps its COP31; 2040cdf1 keeps its
--       lower-case 'undp' (the picker restores 'De Croo' only); 2490109a still asks (every member asks, so the floor answers; the '?' branch of
--       169 is not this one's business); 23b4563e takes the capitals its siblings write ('Kabine Toplantısı').
--   (4) The picker over the 4-day dump of 1,059 clusters read on 2026-11-12 (the stored title as the incumbent, { floor } when it fails the
--       gate): the picker of this file changes the same 34 stored titles as the picker before the h169 review, and none differs: the review's
--       recasing of a flagged stored title in place (neutral-title.ts, recasedFlaggedIncumbent) changes no row of it. The first form measured
--       on the 6-day dump (1,408 clusters, the old picker of main against the new one): the first pick ({ floor }) changes 2 rows, both
--       ordinals (2490109a, 9df76d26: "Cumhurbaşkanı Erdoğan 111. dönem ..." -> "... 111. Dönem ..."); the cron's re-pick changes 5: 49facb31,
--       8ab79860, 2490109a, 441ea6a3 ("pirc" -> "Pirc": a Title Case-looking run of names no longer blocks the recasing of the stored title's own
--       twin) and 9df76d26 (not offered by this function: it is recased when the cluster grows). The loaded lexicon changes the verdict on 2 stored
--       titles of the 1,408 (15 charged before, 17 after: 49facb31 and 8ab79860) and on no first pick.
--
-- THE RESIDUE
--   0 of 16 (limit 3): every row the branches offer is one the picker changes, so none is offered again after the cron has written its pick
--   (the production replay above). The test sweeps the fixtures of h168-casing, h164-casing and h164-generic with every İşçi Haber member
--   title substituted in turn as the stored title: 25 substitutions, 19 offered by the SQL, 0 kept by the picker (limit 3). The first form
--   of B left the 8f09d48c shape in it (an İşçi Haber title the SQL offered at five, six and seven members and the picker kept); the
--   guards and the recasing of a flagged stored title in place (a row the picker can recase leaves the set, whichever title is the best
--   candidate) close it. A title the picker keeps (a cluster whose every member carries the epithet, a recasing that cannot be done) would be
--   offered on every tick until the cluster is 14 days old: 208's reasoning, no stamp condition, the cost of one slot and one stamp write per
--   tick. The fixtures pin that no fixture cluster is such a row.
--
-- THE COST
--   EXPLAIN (ANALYZE, BUFFERS, TIMING OFF) of each body as a plain SELECT in a READ ONLY transaction on production, 2026-11-13 ~00:50Z
--   (p_model 'extractive-v6', p_limit 50), three runs each, warm: 208's body 255.1, 252.7 and 259.8 ms (shared hit 23,864), the first form of
--   209 350.3, 351.1 and 359.5 ms (shared hit 46,968), the body of this file 403.5, 388.6 and 399.1 ms (shared hit 47,909), planning 5.2-5.6,
--   7.2-7.9 and 8.2-8.7 ms; the first call on cold buffers is slower (208 958.6 ms, the first form 1.9 s, this body 455.3 ms). The review's
--   guards add about 45 ms to the first form. The first measurement (2026-11-12, 208 at 251.0, 286.0 and 286.0 ms, the first form at 350.9,
--   356.0 and 367.5 ms) had branch A alone add about 25 ms (276.1, 287.5, 279.4) and branch B alone about 75 ms (344.9, 327.4, 324.9). A first
--   form of B, which probed cluster_articles, articles and sources once per cluster, took 1.6-4.0 s; the hashed set of the outlet's last
--   fifteen days costs one index-only scan. The headline cron calls the function every 5 minutes.
--
-- THE DRAIN
--   The cron re-pick takes at most 20 rows a tick, under 40 s into the run and inside what is left of the 50-write budget, newest first. The
--   16 clusters leave in a tick or two: for each, the cron writes a member's own wording (or the recased stored title) and the stamp, and the
--   stored title no longer matches. A cluster that grows leaves it the same way.
--
-- RELEASE ORDER. DEPLOY the app FIRST (neutral-title.ts: the three loaded rules and the ordinal fix), THEN APPLY 209. Applied before the deploy,
--   the cron's old picker finds the stored titles protected, keeps them, stamps, and these branches (no stamp condition) offer the 16 clusters
--   again on every tick, 16 of the 20 slots, until the deploy. The migration is not applied by the PR.
--
-- VERIFY (read-only, after applying):
--   1. select md5(prosrc), length(prosrc) from pg_proc where oid = 'public.neutral_title_repick_candidates(text, integer)'::regprocedure;
--      -> cf7458daa1b7b96e750c5583693e2608, 11078 (was 5105bed7a553b41a8c7b30855af4aecc, 6937); prosrc contains 'isci-haber' and 'katil'.
--   2. select has_function_privilege('anon', 'public.neutral_title_repick_candidates(text, integer)', 'execute'),
--             has_function_privilege('authenticated', 'public.neutral_title_repick_candidates(text, integer)', 'execute'),
--             has_function_privilege('service_role', 'public.neutral_title_repick_candidates(text, integer)', 'execute');
--      -> f, f, t.
--   3. select version, name from supabase_migrations.schema_migrations where version = '209';
--   4. select id from public.neutral_title_repick_candidates('extractive-v6', 50);
--      -> includes 49facb31-1ba4-4816-a679-e6bff7a03c4f, 8ab79860-9f6e-414d-acdf-082dc7ff4194, 3039d877-3c4a-4132-8ff9-766faf030cc3 and
--      0834c3ba-8291-4bac-8d8e-9a81cbbcf364 (until the cron re-picks them).
--   5. After the next headline cron ticks (GET, read-only): https://www.tayfhaber.com/cluster/49facb31-1ba4-4816-a679-e6bff7a03c4f: the h1 has
--      no 'katillere'; https://www.tayfhaber.com/cluster/3039d877-3c4a-4132-8ff9-766faf030cc3 shows 'Libya ve Venezuela' and
--      https://www.tayfhaber.com/cluster/0834c3ba-8291-4bac-8d8e-9a81cbbcf364 shows 'COP31' (after ISR revalidates).
--
-- Safe to re-apply: create or replace function, comment, revoke/grant restated, ledger insert `on conflict do nothing`. Nothing is written
-- to public tables.
--
-- ROLLBACK (the previous rule is 208's; re-run its function and drop the ledger row):
--   re-run section 1 of 208_neutral_title_repick_generic.sql (its create or replace function, comment, revoke and grant), then remove the ledger
--   row: delete from supabase_migrations.schema_migrations where version = '209'; That restores md5 5105bed7a553b41a8c7b30855af4aecc. The ACL
--   does not change in either direction. The app change is harmless without 209 (the picker then re-picks on growth only, as before).
--
-- See tests/migrations/209-repick-loaded-cased.test.ts.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. The candidates: 208's body, plus two branches at the end of the outer WHERE. Everything else is 208's, byte for byte.
-- ---------------------------------------------------------------------------

create or replace function public.neutral_title_repick_candidates(p_model text, p_limit integer default 20)
returns table (id uuid, title_tr_neutral text, article_count integer, title_neutral_member_count smallint)
language sql
stable
security definer
set search_path = ''
as $fn$
  with stale as (
    select e.cluster_id
      from (
        select distinct ca.cluster_id,
               pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(public.tayf_search_fold(v.old_title), pg_catalog.chr(1), '', 'g'), '(?<![a-z0-9])[''‘’"“”«»]|[''‘’"“”«»](?![a-z0-9])', pg_catalog.chr(1), 'g'), '[^a-z0-9' || pg_catalog.chr(1) || ']+', '', 'g'), '^' || pg_catalog.chr(1) || '+|' || pg_catalog.chr(1) || '+$', '', 'g') as fo
          from public.article_title_versions v
          join public.cluster_articles ca on ca.article_id = v.article_id
         where v.seen_at > pg_catalog.now() - interval '7 days'
      ) e
      join public.clusters c on c.id = e.cluster_id
     where not c.is_archived
       and c.title_neutral_at is null
       and c.title_tr_neutral is not null
       and pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(public.tayf_search_fold(c.title_tr_neutral), pg_catalog.chr(1), '', 'g'), '(?<![a-z0-9])[''‘’"“”«»]|[''‘’"“”«»](?![a-z0-9])', pg_catalog.chr(1), 'g'), '[^a-z0-9' || pg_catalog.chr(1) || ']+', '', 'g'), '^' || pg_catalog.chr(1) || '+|' || pg_catalog.chr(1) || '+$', '', 'g') <> ''
       and pg_catalog.strpos(e.fo, pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(public.tayf_search_fold(c.title_tr_neutral), pg_catalog.chr(1), '', 'g'), '(?<![a-z0-9])[''‘’"“”«»]|[''‘’"“”«»](?![a-z0-9])', pg_catalog.chr(1), 'g'), '[^a-z0-9' || pg_catalog.chr(1) || ']+', '', 'g'), '^' || pg_catalog.chr(1) || '+|' || pg_catalog.chr(1) || '+$', '', 'g')) > 0
       and not exists (
         select 1
           from public.cluster_articles ca2
           join public.articles a2 on a2.id = ca2.article_id
          where ca2.cluster_id = c.id
            and (
              pg_catalog.strpos(pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(public.tayf_search_fold(a2.title), pg_catalog.chr(1), '', 'g'), '(?<![a-z0-9])[''‘’"“”«»]|[''‘’"“”«»](?![a-z0-9])', pg_catalog.chr(1), 'g'), '[^a-z0-9' || pg_catalog.chr(1) || ']+', '', 'g'), '^' || pg_catalog.chr(1) || '+|' || pg_catalog.chr(1) || '+$', '', 'g'), pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(public.tayf_search_fold(c.title_tr_neutral), pg_catalog.chr(1), '', 'g'), '(?<![a-z0-9])[''‘’"“”«»]|[''‘’"“”«»](?![a-z0-9])', pg_catalog.chr(1), 'g'), '[^a-z0-9' || pg_catalog.chr(1) || ']+', '', 'g'), '^' || pg_catalog.chr(1) || '+|' || pg_catalog.chr(1) || '+$', '', 'g')) > 0
              or pg_catalog.strpos(pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(public.tayf_search_fold(pg_catalog.replace(a2.title, 'Başkan Erdoğan', 'Cumhurbaşkanı Erdoğan')), pg_catalog.chr(1), '', 'g'), '(?<![a-z0-9])[''‘’"“”«»]|[''‘’"“”«»](?![a-z0-9])', pg_catalog.chr(1), 'g'), '[^a-z0-9' || pg_catalog.chr(1) || ']+', '', 'g'), '^' || pg_catalog.chr(1) || '+|' || pg_catalog.chr(1) || '+$', '', 'g'), pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(public.tayf_search_fold(c.title_tr_neutral), pg_catalog.chr(1), '', 'g'), '(?<![a-z0-9])[''‘’"“”«»]|[''‘’"“”«»](?![a-z0-9])', pg_catalog.chr(1), 'g'), '[^a-z0-9' || pg_catalog.chr(1) || ']+', '', 'g'), '^' || pg_catalog.chr(1) || '+|' || pg_catalog.chr(1) || '+$', '', 'g')) > 0
            )
       )
  )
  select w.id, w.title_tr_neutral, w.article_count, w.title_neutral_member_count
    from (
      select c.id, c.title_tr_neutral, c.article_count, c.title_neutral_member_count,
             c.title_neutral_model, c.updated_at
        from public.clusters c
       where c.is_archived = false
         and c.title_neutral_at is null
         and c.title_tr_neutral is not null
         and c.article_count >= 2
         and c.updated_at > pg_catalog.now() - interval '14 days'
       order by c.updated_at desc
       limit 5000
    ) w
   where w.title_neutral_model is distinct from p_model
      or w.title_neutral_member_count is null
      or w.article_count >= w.title_neutral_member_count + greatest(3, ceil(w.title_neutral_member_count * 0.5))
      or w.id in (select cluster_id from stale)
      or (w.title_neutral_member_count is not null
          and w.article_count > w.title_neutral_member_count
          and (pg_catalog.char_length(w.title_tr_neutral) > 110
               or pg_catalog.char_length(pg_catalog.btrim(w.title_tr_neutral)) < 20
               or pg_catalog.strpos(w.title_tr_neutral, '?') > 0))
      or (w.title_neutral_member_count is not null
          and w.title_neutral_member_count <= 2
          and w.article_count >= 3
          and w.article_count > w.title_neutral_member_count)
      or (w.title_tr_neutral ~ '[A-ZÇĞİÖŞÜ]'
          and w.title_tr_neutral !~ '[a-zçğıöşüâîû]')
      or (pg_catalog.strpos(w.title_tr_neutral, '?') = 0
          and pg_catalog.strpos(w.title_tr_neutral, pg_catalog.chr(775)) = 0
          and (case
                 when public.tayf_search_fold(w.title_tr_neutral) ~ '(?:aciklama(?:lar)?|mesajlar)[^a-z0-9]*$'
                 then public.tayf_search_fold(pg_catalog.regexp_replace(w.title_tr_neutral, '^.*\. ', '')) ~ '^[^a-z0-9:]*(?:[a-z0-9]{1,40}[^a-z0-9:]+){0,3}(?:[a-z0-9]{1,40}[^a-z0-9:]+(?:dan|den|tan|ten|ndan|nden)|[a-z0-9]{1,40}(?:dan|den|tan|ten))[^a-z0-9:]+(?:(?:onemli|son[^a-z0-9:]+dakika|yeni|kritik)[^a-z0-9:]+)?(?:aciklama(?:lar)?|mesajlar)[^a-z0-9:]*$'
                   and public.tayf_search_fold(w.title_tr_neutral) !~ '(?<![a-z0-9])(?:[a-z0-9]{0,40}(?:(?:(?<=[cfhkpst])t|(?<![cfhkpst])d)[iu](?:m|k|niz|nuz|lar|ler|r)?|m[iu]s(?:t[iu]r?|lar|ler|[iu]m|[iu]z|s[iu]n|s[iu]n[iu]z)?|[iu]yor(?:um|sun|uz|sunuz|lar|du|mus)?|[ae]c[ae]k(?:t[iu]r|lar|ler|sin|siniz)?|[ae]c[ae]g(?:im|iz)|m[ae]li(?:d[iu]r|lar|ler)?|[ae]bilir(?:ler|lar)?)|var|yok|degil|vardir|yoktur|degildir|idi|imis)(?![a-z0-9])'
                 else false
               end
               or case
                 when public.tayf_search_fold(w.title_tr_neutral) ~ '(?:^|[^a-z0-9])(?:ne|neler|kimler|hangi|neden)(?:[^a-z0-9]|$)'
                 then public.tayf_search_fold(pg_catalog.regexp_replace(pg_catalog.regexp_replace(w.title_tr_neutral, ':\s*["“''‘«].*$', ''), '[!?]|\.\s', ':', 'g')) ~ '(?:^|[^a-z0-9])(?:ne[^a-z0-9]+oldu|neler[^a-z0-9]+(?:oldu|var))(?:[^a-z0-9]|$)|(?:^|[^a-z0-9])kimler[^a-z0-9:]+var[^a-z0-9]*(?::|$)|(?:^|:)(?![^:]*(?<![a-z0-9])[a-z0-9]{0,40}(?:d[iu]g|t[iu]g|[ae]c[ae]g)[iu]n[iu](?![a-z0-9]))[^:]*(?<![a-z0-9])hangi[^a-z0-9:]+[a-z0-9]{1,40}[^a-z0-9:]+ne(?:[^a-z0-9]|$)|(?:^|[^a-z0-9])neden(?![^a-z0-9:]+ol)(?:[^a-z0-9:]+[a-z0-9]{1,40}){0,4}[^a-z0-9:]+[a-z0-9]{0,40}m[ae]d[iu][^a-z0-9]*(?::|$)'
                 else false
               end))
      or pg_catalog.regexp_replace(w.title_tr_neutral, ':\s*["“''‘«].*$', '') ~ '(?:^|[^[:alnum:]çğıöşüâîûÇĞİÖŞÜÂÎÛ])(?:[Kk]atil(?:ler)?(?:e|i|in|ini|ine|lere|leri|lerin|lerine)?[[:space:]]+[Dd]este[kğ]|[Kk]atil[[:space:]]+(?:rejim|devlet|ordu|hükümet|siyonist)|[İi]hale[[:space:]]+rant|rant[[:space:]]+kap[ıi]s)'
      or ((w.id, pg_catalog.btrim(w.title_tr_neutral)) in (
            select ci.cluster_id, pg_catalog.btrim(ai.title)
              from public.sources si
              join public.articles ai on ai.source_id = si.id
              join public.cluster_articles ci on ci.article_id = ai.id
             where si.slug = 'isci-haber'
               and ai.published_at > pg_catalog.now() - interval '15 days')
          and exists (
            select 1
              from (select public.tayf_search_fold((lm.m)[1]) as f
                      from pg_catalog.regexp_matches(pg_catalog.left(w.title_tr_neutral, 1000), '(?:^|[^[:alnum:]çğıöşüâîûÇĞİÖŞÜÂÎÛ''’])([a-zçğıöşüâîû][a-zçğıöşüâîû0-9]+)(?![[:alnum:]çğıöşüâîûÇĞİÖŞÜÂÎÛ])', 'g') lm(m)) lw
              join (select cx.f, pg_catalog.count(distinct cx.k) as n
                      from (select kx.k, public.tayf_search_fold((cm.m)[1]) as f
                              from (select ky.t, ky.k, pg_catalog.bool_or(ky.x) over (partition by ky.k) as xk
                                      from (select lt.t,
                                                   pg_catalog.btrim(pg_catalog.regexp_replace(public.tayf_search_fold(lt.t), '[^a-z0-9]+', ' ', 'g')) as k,
                                                   (lt.t ~ '["“”«»]|(?:^|[[:space:]])[''‘]'
                                                    or lt.t !~ '[a-zçğıöşüâîû]'
                                                    or lt.t ~ '(?<![^[:space:]])[^[:space:]a-zçğıöşüâîû''’ʼ‘]{3,}(?:[''’ʼ‘][^[:space:]]*)?(?:[[:space:]]+[^[:space:]a-zçğıöşüâîû''’ʼ‘]{3,}(?:[''’ʼ‘][^[:space:]]*)?){2}(?![^[:space:]])') as x
                                              from public.cluster_articles cj
                                              join public.articles aj on aj.id = cj.article_id
                                             cross join lateral (select pg_catalog.left(aj.title, 1000) as t) lt
                                             where cj.cluster_id = w.id) ky) kx
                             cross join lateral (select pg_catalog.count(*) as longs,
                                                        pg_catalog.count(*) filter (where (lg.m)[1] ~ '^[A-ZÇĞİÖŞÜÂÎÛ]') as caps
                                                   from pg_catalog.regexp_matches(kx.t, '(?:^|[^[:alnum:]çğıöşüâîûÇĞİÖŞÜÂÎÛ''’])([[:alpha:]çğıöşüâîûÇĞİÖŞÜÂÎÛ]{3,})(?![[:alnum:]çğıöşüâîûÇĞİÖŞÜÂÎÛ])', 'g') lg(m)) tc
                             cross join lateral pg_catalog.regexp_matches(kx.t, '(?<=(?:[^[:space:].:!?…]|(?:^|[[:space:]])[0-9]{1,3}\.)[[:space:]]{1,3})([A-ZÇĞİÖŞÜÂÎÛ][[:alnum:]çğıöşüâîûÇĞİÖŞÜÂÎÛ]+)', 'g') cm(m)
                             where not kx.xk
                               and kx.k <> pg_catalog.btrim(pg_catalog.regexp_replace(public.tayf_search_fold(pg_catalog.left(w.title_tr_neutral, 1000)), '[^a-z0-9]+', ' ', 'g'))
                               and not (tc.longs >= 4 and tc.caps * 5 >= tc.longs * 4)) cx
                     group by cx.f) cw
                on cw.f = lw.f
             where cw.n >= case when (select pg_catalog.count(*) from public.cluster_articles ck where ck.cluster_id = w.id) >= 5
                                then 2 else 1 end
               and not exists (
                 select 1
                   from public.cluster_articles cv
                   join public.articles av on av.id = cv.article_id
                   join public.sources sv on sv.id = av.source_id
                  cross join lateral pg_catalog.regexp_matches(pg_catalog.left(av.title, 1000), '(?<=[^[:space:]](?:[[:space:]]{1,3}|[-–—/]))([a-zçğıöşüâîû][a-zçğıöşüâîû0-9]+)(?![[:alnum:]çğıöşüâîûÇĞİÖŞÜÂÎÛ])', 'g') vm(m)
                  where cv.cluster_id = w.id
                    and sv.slug <> 'isci-haber'
                    and public.tayf_search_fold((vm.m)[1]) = lw.f)))
   order by w.updated_at desc
   limit least(greatest(coalesce(p_limit, 20), 1), 50);
$fn$;

comment on function public.neutral_title_repick_candidates(text, integer) is
  'Extractive neutral titles worth re-picking: active clusters of the last 14 days (newest 5000 '
  'walked on clusters_neutral_repick_idx) with no LLM title, picked by another model than p_model, '
  'never stamped, grown by half (at least +3) over the article_count they were picked at, or whose '
  'stored title an outlet has since edited away (contained in an old_title that article_title_versions '
  'recorded in the last 7 days, and in no current member title; titles are compared on a key that keeps '
  'a quotation mark outside a word, so a member that writes a span in quotes does not carry it bare), or '
  'stamped and grown by at least one member while the stored title fails the acceptance gate on length or a '
  'question mark (over 110 or under 20 characters, or it holds a question mark), or stamped at 2 or fewer '
  'members that has grown to 3 or more, or whose stored title holds letters and no lower case (all capitals; '
  'the headline cron then re-picks with the floor and sentence-cases it), or whose stored title, with no '
  'question mark and no combining dot above, is a placeholder that names a speaker and no statement (up to four '
  'name tokens, the ablative, then aciklama, aciklamalar or mesajlar, alone or after the last sentence break, '
  'with no colon and no verb-like word in the title) or a teaser that asks without a question mark (ne oldu, '
  'neler oldu, neler var, a clause that ends kimler var, hangi X ne without a reported answer, or neden and a '
  'negative past at the end of a clause, neden ol excepted; a clause ends at a colon, an exclamation or question '
  'mark and a sentence break), at any stamp, or whose stored title (cut at a speaker''s opening quote) carries a partisan epithet '
  'the loaded lexicon now charges (the label katil for a party or a state: katillere destek, katil rejim; ihale rantı; rant kapısı), '
  'or is the headline of an İşçi Haber member (machine-cased) and holds a lower-case word that the title of another member writes with a '
  'capital (not as its first word, not behind a sentence end, an ordinal of one to three digits and a dot excepted; two such titles when the '
  'cluster has five members or more, counted by fold key; a title that is Title Case, holds a quotation mark, has no lower-case letter or a '
  'run of three shouted words, or is a fold twin of one of those or of the stored title, adds no capital; a word that a member of another '
  'outlet writes in lower case is left alone), at any stamp. Newest first, p_limit clamped to '
  '1..50. Read-only; the headline cron stamps the rows. service_role only. Migrations 141, 155, 162, 169, 184, 200, 208, 209.';

revoke all on function public.neutral_title_repick_candidates(text, integer) from public, anon, authenticated;
grant execute on function public.neutral_title_repick_candidates(text, integer) to service_role;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('209', '209_neutral_title_repick_loaded_cased')
  on conflict do nothing;

commit;
