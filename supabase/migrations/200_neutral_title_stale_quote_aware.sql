-- 200_neutral_title_stale_quote_aware.sql
--
-- Neutral-title re-pick: the stale-title check reads quotation marks. One function re-created
-- (public.neutral_title_repick_candidates(text, integer)); the body is 184's with ONE change, the key the stale CTE compares
-- titles on (seven expressions, below). No table, column, index, trigger or data change, no backfill, no UPDATE, no
-- EXTRACTIVE_MODEL_ID bump, no LLM, no cron change. The app change that goes with it is neutral-title.ts: memberKey keeps a
-- quote mark outside a word as a sentinel (incumbentIsMemberTitle) and 'şaibe' joins the loaded-word list. The cron heals
-- the cluster through its normal re-pick; nothing here writes to clusters.
-- (h140-seo-1, hunt 140, 2026-11-12)
-- tests/migrations/200-stale-quote-aware.test.ts pins all of it.
--
-- WHY
--   bffb0a3f-a552-45d6-a2fd-a2f69050c73b serves the partisan label 'şaibeli' as its neutral headline, in the h1, <title>,
--   og:title, the JSON-LD headline and the /rss.xml item title: "CHP'nin şaibeli kurultay davası 18 Kasım'a ertelendi" (read on
--   production, 2026-11-12 01:15-01:22Z; clusters row: title_neutral_model extractive-v6, title_neutral_at null,
--   title_neutral_member_count 25, article_count 36). It is Akşam's own headline for 33 minutes (article_title_versions rows
--   823303, seen 2026-11-11 11:45:10Z, and 823721, seen 12:18:05Z, which changed it to "... davasında karar"); Akşam then edited it
--   away. Of the 36 current member titles none carries the served string bare. Milliyet, Yeni Şafak, Posta and haberler-com write
--   'şaibeli kurultay' in scare quotes, Star writes 'şaibeli 38.Kurultay', and haber-global and dokuz8 carry the clean "CHP'nin
--   kurultay davası 18 Kasım'a ertelendi".
--   162's stale branch (a stored title contained in an old_title of the last 7 days and in no current member title) exists for
--   exactly this, and it did not fire: the key it compares on, regexp_replace(tayf_search_fold(x), '[^a-z0-9]+', '', 'g'), removes
--   every quotation mark (tayf_search_fold keeps them; the strip drops them), so "CHP'nin 'şaibeli kurultay' davası ..." counted
--   as carrying "CHP'nin şaibeli kurultay davası ...". The TypeScript twin of the check, incumbentIsMemberTitle, had the same blind
--   spot (memberKey removed every non-letter), so even an offered cluster would have been kept by the cron's pick. This is not
--   the v6 heal: the cluster is stamped v6 and is otherwise offered again at about 38 members (25 + greatest(3, 13)).
--
-- THE RULE
--   The key becomes quote-aware, in the SQL spelling of memberKey (neutral-title.ts), four steps after the fold:
--     (a) any chr(1) in the folded text is removed (no title can forge the sentinel);
--     (b) every quotation mark  '  ‘  ’  "  “  ”  «  »  that does NOT sit between two letters or digits becomes chr(1):
--         '(?<![a-z0-9])[''‘’"“”«»]|[''‘’"“”«»](?![a-z0-9])'. The in-word apostrophe of "CHP'nin", "Kasım’a" and
--         "Erdoğan’dan" is not a mark and is dropped by (c) as before; the rule is marksOutsideWords / isWordCharAt, on the
--         folded text, so the word characters are [a-z0-9];
--     (c) every character outside [a-z0-9] and chr(1) is removed;
--     (d) the chr(1) at the two ends of the key are removed ('^' || chr(1) || '+|' || chr(1) || '+$').
--   (d) is the one step the TypeScript key needs beyond the three the finding lists: quotes that wrap the whole title say
--   nothing about a span inside it, and the pinned h94 test "a stored first-person title that carries quotes ... is kept" stores
--   '"Diplomatik çözüm için çalışıyoruz"' against the bare member. The sentinel is chr(1), not '|' (a member title can hold a
--   literal pipe: the finding's sweep read 9df76d26 as a hit for that reason). Applied, in the stale CTE, to all SEVEN key
--   expressions of 184 (the finding counts six): v.old_title, c.title_tr_neutral four times (the non-empty test, the containment
--   in the old title, and the containment in each member title and in its 'Başkan Erdoğan' rewrite) and a2.title twice (plain and
--   with the 'Başkan Erdoğan' replace). Both sides of every comparison use it, so a member that quotes a span no longer carries a
--   stored title that writes the span bare; everything the old key made equal stays equal (case, separators, curly against
--   straight quotes, a stray leading quote dropped, a wrapped title, an in-word apostrophe).
--   Everything else is 184's byte for byte: the three CTE joins, the 7-day window of article_title_versions, the 14-day window and
--   the newest 5000 of the outer select, the model, NULL-stamp, growth, gate-fail, young and shout branches, the order and the
--   1..50 limit clamp.
--
--   THERE IS NO NEW LOOP. A cluster leaves the stale set when its stored title is carried by a member (the cron writes a member's
--   own wording, so it is) or no longer sits in an old_title of the last 7 days. bffb0a3f: the cron's pick is the clean member
--   title (the TypeScript key reads the quote marks too, and 'şaibe' is a loaded word), and the new stored title is in no old_title.
--   The residue is the one 162's review fix named for its own key: a stored title that cleanHeadline made out of a member (its
--   branch 2 of incumbentIsMemberTitle) and whose quote marks sit differently in the member could be stale here and carried there;
--   the replay below finds none.
--
-- STEP 0 -- the body this migration starts from (production, read-only, 2026-11-12 ~01:30Z)
--   select md5(p.prosrc), length(p.prosrc), p.proconfig::text, p.proacl::text, p.prosecdef, p.provolatile
--     from pg_proc p where p.proname = 'neutral_title_repick_candidates';
--   -> md5 f53e452579b59bffc6fbc0f547c852e8, length 3040, prosecdef t, provolatile s, proconfig {search_path=""},
--      proacl {postgres=X/postgres,service_role=X/postgres}.
--   That md5 equals the md5 of 184's body (the text between the dollar-quote markers in
--   184_neutral_title_repick_young_and_shout.sql), so production runs 184's body and no later migration redefines the function.
--   tests/migrations/200-stale-quote-aware.test.ts recomputes the md5 of 184's body. If a later release changes prosrc, compare
--   again before applying.
--
-- REPLAY (production, read-only, 2026-11-12 ~01:45Z; both bodies as plain SELECTs with p_model 'extractive-v6', p_limit 50)
--   (1) The six-day sweep: 1,356 clusters (not archived, no LLM title, at least 2 members, updated in the last 6 days), the stored
--       title judged against every member title (and its 'Başkan Erdoğan' rewrite) with the old key and with this file's key:
--       1,356 carry it under the old key; ONE stops carrying it under the new key, bffb0a3f. The same count without step (d). No
--       cluster that the old key judged stale is carried now.
--   (2) The whole function over its own windows (14 days of clusters, 7 days of title versions): 184's body offers 0 rows, 200's
--       body offers 1, bffb0a3f-a552-45d6-a2fd-a2f69050c73b (article_count 36, stamp 25). Nothing else changes.
--   (3) A replay of the TypeScript side over the 286 stored-title / member-title fixtures of the repo (the 150-cluster re-pick
--       replay and the h34, h35, h42 and h94 fixtures): incumbentIsMemberTitle, pickNeutralTitle and loadedPenalty agree with the
--       old code on every one.
--
-- THE COST
--   EXPLAIN (ANALYZE, BUFFERS, TIMING OFF) of each body as a plain SELECT in a READ ONLY transaction on production, 2026-11-12
--   ~01:50Z (p_model 'extractive-v6', p_limit 50), three runs each: 184's body 130, 136 and 132 ms, 200's body 141, 147 and 154 ms
--   (planning 5 to 7 ms). The key is computed for the rows the stale CTE already reads; the cost of the new one is the lookaround
--   regex and the trim.
--
-- RELEASE ORDER. DEPLOY the app FIRST (neutral-title.ts: the quote-aware memberKey and the 'şaibe' entry), THEN APPLY 200. Applied
--   before the deploy, the cron's old memberKey would find bffb0a3f's stored title still carried by the scare-quoted members, keep
--   it, and stamp the count, and this branch (no stamp condition) would offer the cluster again on every tick, one slot of 20, until
--   the deploy. DEADLINE: the stale branch reads article_title_versions.seen_at over 7 days and the edit was 2026-11-11 12:18Z, so
--   200 must be applied before 2026-11-18 12:18Z for this cluster to heal; after that it heals only at about 38 members. The
--   migration is not applied by the PR.
--
-- VERIFY (read-only, after applying):
--   1. select md5(prosrc), length(prosrc) from pg_proc where oid = 'public.neutral_title_repick_candidates(text, integer)'::regprocedure;
--      -> e007128d452df4902001859882d322b8, 5028 (was f53e452579b59bffc6fbc0f547c852e8, 3040); prosrc contains pg_catalog.chr(1).
--   2. select has_function_privilege('anon', 'public.neutral_title_repick_candidates(text, integer)', 'execute'),
--             has_function_privilege('authenticated', 'public.neutral_title_repick_candidates(text, integer)', 'execute'),
--             has_function_privilege('service_role', 'public.neutral_title_repick_candidates(text, integer)', 'execute');
--      -> f, f, t.
--   3. select version, name from supabase_migrations.schema_migrations where version = '200';
--   4. select id from public.neutral_title_repick_candidates('extractive-v6', 50);
--      -> includes bffb0a3f-a552-45d6-a2fd-a2f69050c73b (until the cron re-picks it).
--   5. After the next headline cron tick: select title_tr_neutral from public.clusters
--      where id = 'bffb0a3f-a552-45d6-a2fd-a2f69050c73b'; -> no 'şaibe' in it (a member's own wording, e.g. "CHP'nin kurultay
--      davası 18 Kasım'a ertelendi"). Then GET https://www.tayfhaber.com/cluster/bffb0a3f-a552-45d6-a2fd-a2f69050c73b (h1,
--      og:title, JSON-LD headline) and https://www.tayfhaber.com/rss.xml once ISR revalidates.
--
-- Safe to re-apply: create or replace function, comment, revoke/grant restated, ledger insert `on conflict do
-- nothing`. Nothing is written to public tables.
--
-- ROLLBACK (the previous rule is 184's; re-run its function and drop the ledger row):
--   re-run section 1 of 184_neutral_title_repick_young_and_shout.sql (its create or replace function, comment, revoke and grant),
--   then remove the ledger row: delete from supabase_migrations.schema_migrations where version = '200';
--   That restores md5 f53e452579b59bffc6fbc0f547c852e8. The ACL does not change in either direction. The app change is harmless
--   without 200 (it only makes the TypeScript check stricter about quoted spans, and 'şaibe' a loaded word).
--
-- See tests/migrations/200-stale-quote-aware.test.ts.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. The candidates: 184's seven branches, the stale CTE on a quote-aware key. Everything else is 184's, byte for byte.
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
  'the headline cron then re-picks with the floor and sentence-cases it). Newest first, p_limit clamped to '
  '1..50. Read-only; the headline cron stamps the rows. service_role only. Migrations 141, 155, 162, 169, 184, 200.';

revoke all on function public.neutral_title_repick_candidates(text, integer) from public, anon, authenticated;
grant execute on function public.neutral_title_repick_candidates(text, integer) to service_role;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('200', '200_neutral_title_stale_quote_aware')
  on conflict do nothing;

commit;
