-- 208_neutral_title_repick_generic.sql
--
-- Neutral-title re-pick: a stored title that the new generic and teaser rules reject is offered again. One function re-created
-- (public.neutral_title_repick_candidates(text, integer)); the body is 200's with ONE added branch at the end of the outer WHERE
-- (no stamp condition, like 184's SHOUT branch). No table, column, index, trigger or data change, no backfill, no UPDATE, no
-- EXTRACTIVE_MODEL_ID bump (the v6 heal is running), no LLM, no cron change. The app change that goes with it is neutral-title.ts:
-- isGenericTitle knows "<kişi>'den açıklamalar" and isAcceptableNeutral rejects a teaser (isQuestionTeaser). The cron heals the
-- clusters through its normal re-pick (it passes { floor } for a stored title that fails the gate, since 184); nothing here
-- writes to clusters.
-- (h164-titles-1, hunt 164, 2026-11-12; narrowed by its review, h165: the placeholder is a speaker's line behind a label, never behind a
-- sentence or a topic; 'neden ol-' and a reported answer are no teaser; a title with the combining dot above is left alone)
-- tests/migrations/208-repick-generic.test.ts pins all of it.
--
-- WHY
--   Two clusters of the day's speeches are served with a title that names the speaker and nothing they said: 67695cbd-c276-4bc1-9cbe-
--   37e9ee78ed33 (27 members) "MHP Lideri Bahçeli'den açıklamalar" and 298bbb75-6af2-48db-b6c5-8b29f25f2438 (22 members)
--   "Cumhurbaşkanı Erdoğan'dan açıklamalar", in the h1, <title>, og:title and index,follow (read on production 2026-11-12 18:10-18:20Z;
--   clusters rows: title_neutral_model extractive-v6, title_neutral_at null, stamps 27 and 18). 298bbb75's members include
--   "Cumhurbaşkanı Erdoğan: Cumhuriyet'i yeniden cumhurla buluşturduk" (trt-haber). The same shape: 9df76d26 (18), ece7ef31 (6),
--   32a3e53c (4), df08098c (4), 404dda61 (3). And three teasers that ask without a '?': fd7428e8 (5) "Tera'nın patronu Emre Tezmen YENİ
--   Parti ile neden görüşmedi" while four members state that he refused, 9d5ad97a (5) "... oy oranı ne oldu: Birinci sıra dikkat
--   çekti" and 1c7c34ba (2) "...: Listede kimler var".
--   isGenericTitle did not know the shape ('açıklamalar' is not filler) and isAcceptableNeutral rejected a '?' only, so the picker
--   protects such a stored title (neutral-title.ts, the incumbent branch) and the re-pick never offered it: every one of these is
--   stamped at its own count or below the growth bar, v6, and in no stale set. 208 makes the new rules (isGenericTitle's
--   ABLATIVE_STATEMENT and isQuestionTeaser) reject them, and this function offers them.
--
-- THE RULE
--   One branch, no stamp condition (a stored title that fails the gate is a defect at any stamp, as 184's all-capitals title is):
--     pg_catalog.strpos(w.title_tr_neutral, '?') = 0
--     and pg_catalog.strpos(w.title_tr_neutral, pg_catalog.chr(775)) = 0
--     and ( <the generic rule> or <the teaser rule> )
--   The second line keeps out a title with the combining dot above (U+0307): the SQL fold deletes it ("gi" || U+0307 || "tmedi" reads
--   "gitmedi", a teaser) while the TypeScript fold turns it into a word break ("gi tmedi", no teaser), so the gate would accept a title
--   the SQL offers and the cron would be offered it on every tick. Such a title keeps the status quo.
--   Both rules run over public.tayf_search_fold(...) (129's house fold: Turkish capitals and diacritics folded to ASCII, lower case;
--   it keeps every other character), so their regular expressions are the TypeScript ones of neutral-title.ts with ' ' read as
--   "a run of characters outside [a-z0-9]" (what the TypeScript fold collapses to one space). Each is a SUBSET of the TypeScript
--   verdict, never wider: a title the SQL offers and TypeScript accepts would be re-picked, kept as the incumbent, stamped and offered
--   again on the next tick.
--     generic: the speaker's line behind a label or a name, never behind a sentence. The text after the last '. ' (the whole title when
--       it has none) is up to three name or title tokens, the ablative (a token of its own, dan|den|tan|ten|ndan|nden, or glued to the
--       last token), optionally onemli | son dakika | yeni | kritik, then aciklama | aciklamalar | mesajlar as the whole rest of it, with
--       no ':' in it (TypeScript: a ':' after the last '. ' makes the line a statement under a topic, "Hürmüz Boğazı'nda tanker olayı:
--       UKMTO'dan açıklama"). And no token of the whole title may look like a finite verb (a superset of finite-verb.ts's endings, with
--       its voicing rule and no stem length): "Azil süreci başladı. Trump'tan açıklama" says what happened. TypeScript reads five tokens
--       in front and asks hasFiniteVerb of the text before the line, which SQL cannot, so SQL reads three and refuses any verb-like
--       token. An event label in front is allowed ("COP31 Zirvesi. Bakan Kurum'dan açıklamalar"). Anchored, every repeat bounded.
--     teaser: tested on the title cut at a speaker's opening quote ("<speaker>: '" ...; what follows is the speaker's own words), with
--       '!', '?' and '. ' turned into ':' first (a clause ends at all four, as in TypeScript): 'ne oldu', 'neler oldu' and 'neler var'
--       anywhere as whole words; and per clause (the ':' splits clauses) 'kimler var' ending the clause, 'hangi <word> ne' unless the
--       clause also holds a nominalised reported answer (a word ending -dığını, -tığını, -acağını, -eceğini: "hangi ilde ne
--       yapılacağını açıkladı"), and 'neden' + up to four words + a negative past (-m[ae]d[iu]) ending the clause, unless 'neden' is
--       followed by a word that starts with 'ol' ("kazaya neden olan sürücü tutuklanmadı": causative, no question).
--   Two cheap prefilters (CASE ... WHEN) keep the regular expressions off the titles that cannot match: the generic rule needs a
--   title that ends in aciklama(lar) | mesajlar, the teaser rule a whole word ne | neler | kimler | hangi | neden. Each is a
--   superset of what its rule matches, so the verdicts are the rules' own (the test runs the port with and without).
--   A title with a '?' is not this branch's: it already fails the gate, and the existing gate-fail branch (169) offers it once it
--   has grown; the three live clusters whose only fault is a '?' after 'ne oldu' (0670a048, 71c5a3dc, 757af5cf) stay with it.
--   Everything else is 200's byte for byte: the three CTE joins, the quote-aware stale key, the 7-day window of
--   article_title_versions, the 14-day window and the newest 5000 of the outer select, the model, NULL-stamp, growth, gate-fail,
--   young and shout branches, the order and the 1..50 limit clamp.
--
-- STEP 0 -- the body this migration starts from (production, read-only, 2026-11-12 ~19:05Z)
--   select md5(p.prosrc), length(p.prosrc), p.proconfig::text, p.proacl::text, p.prosecdef, p.provolatile
--     from pg_proc p where p.proname = 'neutral_title_repick_candidates';
--   -> md5 e007128d452df4902001859882d322b8, length 5028, prosecdef t, provolatile s, proconfig {search_path=""},
--      proacl {postgres=X/postgres,service_role=X/postgres}.
--   That md5 equals the md5 of 200's body (the text between the dollar-quote markers in 200_neutral_title_stale_quote_aware.sql), so
--   production runs 200's body and no later migration redefines the function. tests/migrations/208-repick-generic.test.ts recomputes
--   the md5 of 200's body. If a later release changes prosrc, compare again before applying. The dry-run refuses on a mismatch.
--
-- REPLAY (production, read-only, 2026-11-12 ~20:00Z, re-measured after the h165 review)
--   (1) SQL is a subset of the TypeScript rules, and the teaser rule is equal. 3,516 clusters (not archived, no LLM title, at least 2
--       members, updated in the last 14 days): the generic rule of SQL matches 7 stored titles and TypeScript's isGenericTitle verdict
--       (isAblativeStatementTitle) the same 7, the teaser rule 8 and isQuestionTeaser the same 8; the branch (the two rules without a
--       '?' in the title) run on production offers 12 of the 15, the other 3 hold a '?' and stay with 169's branch. On the 15,364
--       distinct cleaned titles of the 17,098 members of those clusters (the rules over a table of the titles, in a local PostgreSQL
--       15.12 with 129's fold; its verdict on the stored titles equals production's): the teaser rule matches 21 and isQuestionTeaser
--       the same 21 (0 disagreements); the generic rule matches 26 and TypeScript 35: every one of SQL's is TypeScript's (0 the other
--       way), and the 9 only TypeScript reads have four or more words in front of the speaker ("Kıbrıs'taki üçlü görüşmeye Dışişleri'nden
--       açıklama").
--   (2) The whole function over its own windows (14 days of clusters, 7 days of title versions, p_limit lifted to 5000): 200's body
--       offers 1 row, a young-branch cluster (0fece7dd); 208's body offers the same plus 12: 67695cbd (stamp 27 of 27), 298bbb75 (18 of
--       22), 9df76d26 (16 of 18), ece7ef31 (4 of 6), 32a3e53c (3 of 4), df08098c (3 of 4), 404dda61 (3 of 3), fd7428e8 (3 of 5), 9d5ad97a
--       (5 of 5), 1c7c34ba (2 of 2), 5ca6f9a3 (5 of 7, "... Hangi parti ne oy verdi") and 3a6fde82 (4 of 4, "Aliyev Ankara'ya neden
--       gelmedi: ..."). dd5535a7, "Bahçeli ile Kol Kola Yürümüştü: Dervişoğlu'ndan Açıklama", which the first version of the branch
--       offered, is not: a ':' in front of the speaker's line makes it a statement under a topic.
--   (3) The TypeScript re-pick of those 12 (the cron's call: the stored title as the incumbent, { floor } because it fails the gate,
--       the members flagged opinion, english and caseUnreliable as the cron flags them): 10 are replaced by a member's own wording and
--       none of the 10 matches a rule again, among them 67695cbd -> "MHP lideri Bahçeli: Türkiye'ye parmak sallamak Avrupa'nın harcı
--       değil", fd7428e8 -> "Tera Yatırım'ın patronu Emre Tezmen, Yeni Parti’nin görüşme talebini reddetti", 9d5ad97a -> "Son seçim
--       anketinde ezber bozan sonuç. Birinci sıra şaşırttı" and 5ca6f9a3 -> "Mekke Anlaşması Meclis’te kabul edildi"; 2 stay (below).
--
-- THE RESIDUE
--   A cluster whose every member is generic or a teaser has no member to pick, the floor returns a title that still matches, the cron
--   stamps it, and with no stamp condition the branch offers it again on every tick until the title changes or the cluster is 14
--   days old. Measured on the 12: 2, 1c7c34ba (both members ask) and 3a6fde82 (all four members ask), against 3 as the limit above
--   which the branch would have to carry "and w.article_count > coalesce(w.title_neutral_member_count, 0)". It does not: that
--   condition would hide 67695cbd (stamped 27 of 27), the cluster of the finding. The residue costs two of the 20 slots of a tick and
--   one stamp write each, until their titles change or they age out. With the three '?' clusters (0670a048, 71c5a3dc, 757af5cf), two
--   of which (71c5a3dc, 757af5cf: every member asks) stay after a pick, it would have been 4; they are left to 169's branch (above).
--
-- THE COST
--   EXPLAIN (ANALYZE, BUFFERS, TIMING OFF) of each body as a plain SELECT in a READ ONLY transaction on production, 2026-11-12
--   ~20:00Z (p_model 'extractive-v6', p_limit 50), three runs each: 200's body 164.8 (the first run, cold), 130.6 and 136.4 ms, 208's
--   body 254.3, 266.4 and 254.0 ms (planning 5 ms both). The headline cron calls it every 5 minutes. Without the two CASE prefilters
--   the first form of the branch took 2,094 ms (the generic regular expression, a bounded repeat inside a bounded repeat, costs 0.28
--   ms a row); with them the rules run only on the rows that pass a prefilter, two tayf_search_fold calls and two cheap scans a row.
--
-- THE DRAIN
--   The cron re-pick takes at most 20 rows a tick, under 40 s into the run and inside what is left of the 50-write budget, newest
--   first. The 12 clusters leave in a tick or two: for each, the cron writes a member's own wording and the stamp (title_neutral_
--   member_count = article_count), and the stored title no longer matches. A cluster that grows leaves it the same way. No loop for
--   the 10; the 2 of THE RESIDUE are the known remainder.
--
-- RELEASE ORDER. DEPLOY the app FIRST (neutral-title.ts: the generic pattern, the teaser rules and the gate), THEN APPLY 208. Applied
--   before the deploy, the cron's old picker finds the stored titles acceptable and protected, keeps them, stamps, and this
--   branch (no stamp condition) offers the 12 clusters again on every tick, 12 of the 20 slots, until the deploy. The migration is
--   not applied by the PR.
--
-- VERIFY (read-only, after applying):
--   1. select md5(prosrc), length(prosrc) from pg_proc where oid = 'public.neutral_title_repick_candidates(text, integer)'::regprocedure;
--      -> 5105bed7a553b41a8c7b30855af4aecc, 6937 (was e007128d452df4902001859882d322b8, 5028); prosrc contains 'kimler' and 'aciklama'.
--   2. select has_function_privilege('anon', 'public.neutral_title_repick_candidates(text, integer)', 'execute'),
--             has_function_privilege('authenticated', 'public.neutral_title_repick_candidates(text, integer)', 'execute'),
--             has_function_privilege('service_role', 'public.neutral_title_repick_candidates(text, integer)', 'execute');
--      -> f, f, t.
--   3. select version, name from supabase_migrations.schema_migrations where version = '208';
--   4. select id from public.neutral_title_repick_candidates('extractive-v6', 50);
--      -> includes 67695cbd-c276-4bc1-9cbe-37e9ee78ed33 and 298bbb75-6af2-48db-b6c5-8b29f25f2438 (until the cron re-picks them).
--   5. After the next headline cron ticks (GET, read-only): https://www.tayfhaber.com/cluster/67695cbd-c276-4bc1-9cbe-37e9ee78ed33 and
--      https://www.tayfhaber.com/cluster/298bbb75-6af2-48db-b6c5-8b29f25f2438: the h1 no longer ends in 'açıklamalar' (after ISR
--      revalidates); https://www.tayfhaber.com/cluster/fd7428e8-aa57-4fad-ac21-1d222cbf8e51 shows a statement ("... talebini reddetti").
--
-- Safe to re-apply: create or replace function, comment, revoke/grant restated, ledger insert `on conflict do
-- nothing`. Nothing is written to public tables.
--
-- ROLLBACK (the previous rule is 200's; re-run its function and drop the ledger row):
--   re-run section 1 of 200_neutral_title_stale_quote_aware.sql (its create or replace function, comment, revoke and grant), then
--   remove the ledger row: delete from supabase_migrations.schema_migrations where version = '208';
--   That restores md5 e007128d452df4902001859882d322b8. The ACL does not change in either direction. The app change is harmless
--   without 208 (the gate then rejects what the cron is offered by the other branches, as before).
--
-- See tests/migrations/208-repick-generic.test.ts.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. The candidates: 200's body, plus one branch at the end of the outer WHERE. Everything else is 200's, byte for byte.
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
  'mark and a sentence break), at any stamp. Newest first, p_limit clamped to '
  '1..50. Read-only; the headline cron stamps the rows. service_role only. Migrations 141, 155, 162, 169, 184, 200, 208.';

revoke all on function public.neutral_title_repick_candidates(text, integer) from public, anon, authenticated;
grant execute on function public.neutral_title_repick_candidates(text, integer) to service_role;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('208', '208_neutral_title_repick_generic')
  on conflict do nothing;

commit;
