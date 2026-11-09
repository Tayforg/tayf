-- 184_neutral_title_repick_young_and_shout.sql
--
-- Neutral-title re-pick: two kinds of stamped extractive title that the re-pick never offered again are offered. (1) A cluster
-- stamped at 2 or fewer members that has grown to 3 or more (a stamp of 2 used to wait for 5 members). (2) A stored title in
-- capitals only (letters and no lower case), whatever its stamp. One function re-created
-- (public.neutral_title_repick_candidates(text, integer)); the body is 169's with two extra branches at the end of the outer
-- WHERE and nothing else. No table, column, index, trigger or data change, no backfill, no UPDATE, no EXTRACTIVE_MODEL_ID bump,
-- no LLM. The headline cron changes with it (see RELEASE ORDER): it passes { floor } when the stored title fails the gate.
-- (h94-neutraltitles-1, hunt 94, 2026-11-09)
-- tests/migrations/184-repick-young-shout.test.ts pins all of it.
--
-- WHY
--   An extractive title is picked when a cluster first reaches 2 members. The re-pick (141, 155, 162, 169) offers the stamped
--   cluster again only after a model change, a NULL stamp, growth by half (n + greatest(3, ceil(n / 2)), which is 5 members for a
--   stamp of 2), an outlet edit of the stored title, or, since 169, growth by one member while the stored title fails the
--   length or '?' gate. Two kinds of live title are none of those.
--   Re-checked read-only on production, 2026-11-09 04:15-04:50Z (all extractive-v6, no LLM title, not archived, updated in 14 days):
--   (1) YOUNG. 209 clusters were stamped at 2 members and had 3 or 4 (210 at 04:41Z: 142 with 3, 68 with 4; the growth bar for a stamp of
--       2 is 5 members). A replay of the real pickNeutralTitle (Node 24) on the current members with
--       { incumbent: stored } over all of them: one re-offer changes 23 titles, 8 of which drop loaded or framing words, e.g.
--         f771e177  'İşgalci İsrail'in koalisyon kabusu: Hükümeti kurma görevi için tarih belli oldu'
--                   -> 'İsrail'de hükümet kurma görevinin verileceği tarih açıklandı'
--         15b4041e  '... AKP'li Belediye Başkanı'ndan Vali'ye zehir zemberek açıklama'
--                   -> 'AK Partili başkan ‘bürokrasinin sorumsuzluğu’nu topa tuttu: Bakan gelecekti, vali engelledi'
--         d9236903  'Trump'ın servetinde seçim darbesi: Şirket hisseleri ve kripto paraları çakıldı' -> 'Trump'ın serveti seçim yenilgisiyle eridi'
--         459a7b61  'Cumhurbaşkanı Erdoğan'dan Azerbaycan'da önemli açıklamalar' (a content-free H1, served 200 index,follow)
--                   -> 'Cumhurbaşkanı Erdoğan: Bakü'nün sevinci Ankara'nın sevincidir'
--       and 8ea9e45f regains the hedge ('... azalması bekleniyor'). The 23 are listed with their replacements in the PR.
--   (2) SHOUT. 2 titles are in capitals only. 09f152ec 'NEV'İN MİRASI GÜNDEM OLDU' (turkiye-gazetesi's wording; posta's other
--       member holds a '?') and fe2c6725 'PENDİK VERGİ DAİRESİ MÜDÜRLÜĞÜ PENDİK VERGİ DAİRESİ' (both members shout): stamp 2,
--       2 members, v6, served 200 index,follow with that text in the H1 and <title>. isAcceptableNeutral rejects shouting, so no
--       member passes the gate, and the re-pick ran without { floor }: pickNeutralTitle returns null for both, the cron keeps
--       the stored title and stamps the count, and neither growth rule can offer a cluster whose stamp equals its count.
--       neutral-title.ts cites 'Nev'in mirası gündem oldu' as the fixed form; with { incumbent, floor: true } the pick is that
--       title and 'Pendik vergi dairesi müdürlüğü pendik vergi dairesi'.
--
-- THE RULE
--   Two branches, after 169's last one:
--     or (w.title_neutral_member_count is not null
--         and w.title_neutral_member_count <= 2
--         and w.article_count >= 3
--         and w.article_count > w.title_neutral_member_count)
--     or (w.title_tr_neutral ~ '[A-ZÇĞİÖŞÜ]'
--         and w.title_tr_neutral !~ '[a-zçğıöşüâîû]')
--   YOUNG: stamped at 2 or fewer, three or more members now, and grown past the stamp. A stamp above 2 keeps the old rule (the
--   growth bar), so a title stamped at 3 with 4 members is not offered. SHOUT: it holds a capital letter and no lower-case letter,
--   i.e. letters and no lower case. The classes are explicit Turkish ones, not [[:lower:]] / [[:upper:]], which depend on the
--   database's locale (and so on the collation the cluster was built with); the lower-case class carries the dotless i and the
--   circumflexed vowels, so 'KARŞI ÇIKTI ı' and 'HAYATÎ âlem' are not shouting. A title with no letters ('12345 6789') does not match.
--
--   THERE IS NO LOOP, branch by branch.
--   YOUNG: the headline cron stamps title_neutral_member_count = article_count (3 or more here) after every pick, a kept title
--   included, so the cluster leaves the branch on the next tick and comes back only through the growth bar of 155.
--   SHOUT: the cron now re-picks with { floor } whenever the stored title itself fails the gate, and a shouting title always does.
--   The pick is then a member's own wording, sentence-cased when it shouts (sentenceCaseShout), which holds a lower-case letter and
--   so no longer matches the branch. A stored title that passes the gate is picked without the floor, exactly as before (the
--   margin rules of hunt 16). The one RESIDUE: a shouting stored title whose cluster has no usable member title at all (every member
--   generic or gone): the pick is null, the row is stamped and kept, and, because this branch has no stamp condition, it is offered
--   again on every tick until it leaves the 14-day window. Zero such rows today (2 shouting titles in the window, both healed by
--   the replay); each costs one slot of the 20 per tick and one UPDATE of unchanged values.
--
--   WHAT THE FLOOR ALSO CHANGES. { floor } applies to every stored title that fails the gate, not only the shouting ones: a stored
--   question or a title over 110 characters that no member beats used to be kept (the pick was null, 169's header names
--   f19d276c, 7324209f and 012deab8) and now gets the floor pick, a statement without a hard defect before a question. 0 rows of
--   169's branch were waiting when this was written (read-only, 04:50Z); the route test pins the case.
--
-- STEP 0 -- the body this migration starts from (production, read-only, 2026-11-09 ~04:20Z)
--   select md5(p.prosrc), length(p.prosrc), p.proconfig::text, p.proacl::text, p.prosecdef, p.provolatile
--     from pg_proc p where p.proname = 'neutral_title_repick_candidates';
--   -> md5 c5a3b354ff0f51ef77fae5b3fbf11b0a, length 2745, prosecdef t, provolatile s, proconfig {search_path=""},
--      proacl {postgres=X/postgres,service_role=X/postgres}.
--   That md5 equals the md5 of 169's body (the text between the dollar-quote markers in
--   169_neutral_title_repick_gate_fail.sql), so production runs 169's body and no later migration redefines the function.
--   tests/migrations/184-repick-young-shout.test.ts recomputes the md5 of 169's body, and the dry-run script refuses a baseline
--   whose md5 differs. If a later release changes prosrc, compare again before applying.
--
-- THE COST
--   EXPLAIN (ANALYZE, BUFFERS, TIMING OFF) of each body as a plain SELECT in a READ ONLY transaction on production, 2026-11-09
--   ~04:50Z (p_model 'extractive-v6', p_limit 50): 169's body 3,608 ms (cold), then 153 and 129 ms warm, 0 rows; 184's body 169 ms
--   (cold), then 128 and 122 ms warm, 50 rows (212 candidates, see below). Planning time 4.7-18.7 ms. The two branches are a few
--   comparisons and two regular-expression tests on the at most 5000 rows of the window after the sort; the stale CTE is still
--   computed once.
--
-- THE DRAIN
--   212 clusters are offered at once (210 young plus the 2 shouting ones). The cron takes REPICK_BATCH = 20 per tick, newest
--   first, inside its 50-write budget, so the set drains in about 11 ticks (an hour at the 5-minute cadence). Nothing else
--   changes: no write budget, no deadline, no batch constant.
--
-- RELEASE ORDER. DEPLOY the app (the cron route passes { floor }) FIRST, THEN APPLY 184. The young branch heals with either cron,
--   but the shout branch needs the new one: applied before the deploy, the old cron would pick null for the 2 shouting rows, stamp
--   them unchanged and be offered them again on every tick until the deploy. The migration is not applied by the PR.
--
-- VERIFY (read-only, after applying):
--   1. select md5(prosrc), length(prosrc) from pg_proc where oid = 'public.neutral_title_repick_candidates(text, integer)'::regprocedure;
--      -> f53e452579b59bffc6fbc0f547c852e8, 3040 (was c5a3b354ff0f51ef77fae5b3fbf11b0a, 2745); prosrc contains '[A-ZÇĞİÖŞÜ]'.
--   2. select has_function_privilege('anon', 'public.neutral_title_repick_candidates(text, integer)', 'execute'),
--             has_function_privilege('authenticated', 'public.neutral_title_repick_candidates(text, integer)', 'execute'),
--             has_function_privilege('service_role', 'public.neutral_title_repick_candidates(text, integer)', 'execute');
--      -> f, f, t.
--   3. select version, name from supabase_migrations.schema_migrations where version = '184';
--   4. The clusters the new branches offer and 169 did not (212 when this was written, 2026-11-09 ~04:41Z; each leaves the set once
--      the cron stamps it, or, for a shouting title, once it is sentence-cased):
--      select c.id, c.article_count, c.title_neutral_member_count, c.title_tr_neutral
--        from public.clusters c
--       where not c.is_archived and c.title_neutral_at is null and c.title_tr_neutral is not null
--         and c.article_count >= 2 and c.updated_at > pg_catalog.now() - interval '14 days'
--         and ((c.title_neutral_member_count is not null and c.title_neutral_member_count <= 2
--               and c.article_count >= 3 and c.article_count > c.title_neutral_member_count)
--              or (c.title_tr_neutral ~ '[A-ZÇĞİÖŞÜ]' and c.title_tr_neutral !~ '[a-zçğıöşüâîû]'));
--   5. Within the drain (about an hour), GET https://www.tayfhaber.com/cluster/09f152ec-863f-490e-9723-d42f19e7faa9 shows
--      'Nev'in mirası gündem oldu' in <title> and the H1 (page cache: allow the ISR window); 459a7b61 and f771e177 show a member's
--      own wording instead of 'önemli açıklamalar' and 'İşgalci İsrail'in koalisyon kabusu'.
--
-- Safe to re-apply: create or replace function, comment, revoke/grant restated, ledger insert `on conflict do
-- nothing`. Nothing is written to public tables.
--
-- ROLLBACK (the previous rule is 169's; re-run its function and drop the ledger row):
--   re-run section 1 of 169_neutral_title_repick_gate_fail.sql (its create or replace function, comment, revoke and grant),
--   then delete from supabase_migrations.schema_migrations where version = '184';
--   That restores md5 c5a3b354ff0f51ef77fae5b3fbf11b0a. The ACL does not change in either direction. The cron change is harmless
--   without 184 (a stored title that fails the gate gets the floor, the rest is picked as before).
--
-- See tests/migrations/184-repick-young-shout.test.ts.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. The candidates: 169's five branches plus the young and the shout branch. Everything else is 169's, byte for byte.
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
               pg_catalog.regexp_replace(public.tayf_search_fold(v.old_title), '[^a-z0-9]+', '', 'g') as fo
          from public.article_title_versions v
          join public.cluster_articles ca on ca.article_id = v.article_id
         where v.seen_at > pg_catalog.now() - interval '7 days'
      ) e
      join public.clusters c on c.id = e.cluster_id
     where not c.is_archived
       and c.title_neutral_at is null
       and c.title_tr_neutral is not null
       and pg_catalog.regexp_replace(public.tayf_search_fold(c.title_tr_neutral), '[^a-z0-9]+', '', 'g') <> ''
       and pg_catalog.strpos(e.fo, pg_catalog.regexp_replace(public.tayf_search_fold(c.title_tr_neutral), '[^a-z0-9]+', '', 'g')) > 0
       and not exists (
         select 1
           from public.cluster_articles ca2
           join public.articles a2 on a2.id = ca2.article_id
          where ca2.cluster_id = c.id
            and (
              pg_catalog.strpos(pg_catalog.regexp_replace(public.tayf_search_fold(a2.title), '[^a-z0-9]+', '', 'g'), pg_catalog.regexp_replace(public.tayf_search_fold(c.title_tr_neutral), '[^a-z0-9]+', '', 'g')) > 0
              or pg_catalog.strpos(pg_catalog.regexp_replace(public.tayf_search_fold(pg_catalog.replace(a2.title, 'Başkan Erdoğan', 'Cumhurbaşkanı Erdoğan')), '[^a-z0-9]+', '', 'g'), pg_catalog.regexp_replace(public.tayf_search_fold(c.title_tr_neutral), '[^a-z0-9]+', '', 'g')) > 0
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
   order by w.updated_at desc
   limit least(greatest(coalesce(p_limit, 20), 1), 50);
$fn$;

comment on function public.neutral_title_repick_candidates(text, integer) is
  'Extractive neutral titles worth re-picking: active clusters of the last 14 days (newest 5000 '
  'walked on clusters_neutral_repick_idx) with no LLM title, picked by another model than p_model, '
  'never stamped, grown by half (at least +3) over the article_count they were picked at, or whose '
  'stored title an outlet has since edited away (contained in an old_title that article_title_versions '
  'recorded in the last 7 days, and in no current member title), or stamped and grown by at least one '
  'member while the stored title fails the acceptance gate on length or a question mark (over 110 or under '
  '20 characters, or it holds a question mark), or stamped at 2 or fewer members that has grown to 3 or more, '
  'or whose stored title holds letters and no lower case (all capitals; the headline cron then re-picks with '
  'the floor and sentence-cases it). Newest first, p_limit clamped to 1..50. Read-only; the '
  'headline cron stamps the rows. service_role only. Migrations 141, 155, 162, 169, 184.';

revoke all on function public.neutral_title_repick_candidates(text, integer) from public, anon, authenticated;
grant execute on function public.neutral_title_repick_candidates(text, integer) to service_role;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('184', '184_neutral_title_repick_young_and_shout')
  on conflict do nothing;

commit;
