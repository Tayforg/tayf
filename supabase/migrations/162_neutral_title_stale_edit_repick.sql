-- 162_neutral_title_stale_edit_repick.sql
--
-- Neutral-title re-pick: a stamped extractive title is offered again when the outlet has since edited it away.
-- One function re-created (public.neutral_title_repick_candidates(text, integer)); the body is 155's with one
-- extra branch, `or w.id in (select cluster_id from stale)`, and the CTE that computes that set once. No table,
-- column, index, trigger or data change, no backfill, no UPDATE (h42-titles-1, hunt 42, 2026-11-05; the key
-- and the residue below are the h42 review's fixes sec-db-1 / correctness-1).
-- tests/migrations/162-stale-edit-repick.test.ts pins all of it.
--
-- WHY
--   apply_article_title_edits (074, lines 203-262) rewrites articles.title when an outlet edits a headline and states
--   that it NEVER sets clusters.title_tr_neutral; 074's header gives the aim as "stop showing a headline the outlet
--   removed", possibly under a Law 5651 order. The cluster's neutral title was never revisited: the re-pick (155) offers
--   a stamped cluster only after a model change, a NULL stamp or growth (n + greatest(3, ceil(n / 2))), and a cluster that
--   already carries the current model does not grow when an outlet edits a headline.
--   Cluster 31fde7d7 (title_tr_neutral "Denizli'de çöp kamyonu sürücüsü, sıkışan temizlikçinin ölümü üzerine gözaltına alındı",
--   extractive-v6, stamped 2 of 2) had both members (haberler-com, son-dakika) edited to "Denizli'de direk ile çöp kamyonu
--   arasına sıkışan temizlik işçisi hayatını kaybetti" (article_title_versions id 722175 holds the stored text as old_title).
--   /cluster/31fde7d7-... showed the detention claim in <title> and in the H1 (23 occurrences), on a workplace death. Same
--   pattern: 5893d4e5 (odatv), 620362a3 (cumhuriyet: "2 kişi toprak altında kaldı"; the members now report a death), 38610f3f.
--   Prevalence on 2026-11-05 (folded substring match, clusters with a member published in the last 48 h): 24 of 597 clusters.
--   The stale set below, read-only on production the same day, returns 59 clusters (61 rows before the IN dedupes two
--   clusters that two old titles each match) for the last 7 days of edits, and all 59 sit inside the function's 14-day window.
--
--   The new branch: the cluster is active, has no LLM title, has a stored title, that stored title is contained in an
--   old_title that article_title_versions recorded in the last 7 days for one of its articles, AND no current member
--   title contains it. "Contained" is judged on a KEY, key(x) = regexp_replace(tayf_search_fold(x), '[^a-z0-9]+', '', 'g'):
--   the house fold of migration 129 and then every character outside [a-z0-9] removed (the alphabet of 129's literal
--   tier), so case, Turkish letters, quotes, apostrophes and separators do not matter. A stored title whose key is empty
--   is never stale. The anti join also accepts the legacy wording, key(replace(member, 'Başkan Erdoğan',
--   'Cumhurbaşkanı Erdoğan')): extractive v1 to v5 stored "Cumhurbaşkanı Erdoğan ..." for a member's "Başkan Erdoğan ..."
--   (cc01f26a), a form incumbentIsMemberTitle accepts too.
--   The cron needs no change: it already re-picks each candidate with { incumbent } (src/lib/clusters/neutral-title.ts),
--   and since h42-titles-1 pickNeutralTitle no longer protects an incumbent that no member carries
--   (incumbentIsMemberTitle), whether or not that stored title passes the gate: it returns a member's own cleaned wording
--   (the floor first pick for a stored title that fails the gate, the best member that passes the gate and is no more
--   loaded, framed or Title Case for one that passes it). The new title is a member title, so the cluster leaves the set.
--
--   Why a key and not the plain fold. The first version compared tayf_search_fold(x) as it was, which keeps quotes and
--   apostrophes as typed, while the picker's own member test (incumbentIsMemberTitle) is blind to them. Five live
--   clusters (read-only, 2026-11-05) therefore stayed in the set after the picker had done all it could: 38721672 (stored
--   with straight quotes around "Türk Yüzyılı", the member has curly ones), a6874bad (a curly apostrophe against a
--   straight one), cc01f26a (the legacy wording above), and 502e3032 and c2e4a77c (a stored question: it fails the gate and
--   the picker answered null). The cron writes only the stamp (writeExtractive leaves updated_at alone) and the CTE
--   ignores stamps, so each of the five was offered, re-written and stamped on every 5-minute tick until its old_title
--   was 7 days old. The key removes the first three from the set; the picker answering a stored title that fails the gate
--   with the floor pick turns the last two into a member's wording. With the key the set swaps three clusters for three:
--   38721672, a6874bad and cc01f26a leave, and 38610f3f, bbe26fe7 and c526f480 (edited titles the plain fold missed
--   because the punctuation differed) enter; the count is 59 either way.
--
-- RESIDUE. The branch does not promise that a row leaves the set after one pick. A stale row is re-offered, and stamped
--   without a change, on every 5-minute tick until its old_title is 7 days old when
--     (a) its members give no usable title (every member title is blank or a placeholder: pickNeutralTitle returns null);
--     (b) its stored title passes the gate when no member does (the picker keeps it: it never replaces a title that passes
--         with a floor title that fails, such as a 193-character quote or a question): fd5896d8 is the one such cluster
--         among the 97 whose stored title no member carries in the 14-day replay;
--     (c) its stored title is a member's CLEANED form that is not a substring of any member's key, because cleanHeadline
--         removed words from the middle (a mid-title "son dakika"): the picker counts it as a member title and keeps it,
--         the key cannot find it. 0670a048 and 8088059e are the two of 3,884 clusters of the 14-day replay; neither
--         was in the stale set that day.
--   Each such row costs one re-pick and one stamp per tick, not an unbounded loop, and the model-heal rows share the
--   same 20-per-tick budget.
--
-- THE COST
--   EXPLAIN (ANALYZE, BUFFERS) of the body below as a plain SELECT in a READ ONLY transaction on production, 2026-11-05,
--   after the key (p_model 'extractive-v6', p_limit 1000 clamped to 50): the stale set is one hashed subplan evaluated
--   once (4,747 article_title_versions rows through article_title_versions_seen_at_idx, 1,292 distinct (cluster, old
--   title key) pairs, 147 survive the strpos, 61 survive the anti join, 59 clusters): 163-166 ms warm (three runs, 25,774
--   buffer hits, no reads), against 94-101 ms for the first version's plain fold: the regexp_replace costs about 65 ms.
--   A cold run could not be repeated: the verification queries had read the same pages seconds before. The plan is the
--   same plan on the same pages as the first version's cold run, which read 2,174 pages and took 1.54 s, so a cold
--   execution is that run plus the regexp work. The 5000-row window and everything else are unchanged. Measured the same
--   evening: the model branch offered 0 clusters (the v6 heal had finished), the growth and NULL-stamp branches 0, and
--   the 59 stale clusters 59 of the 3,878 in the window, newest first, 20 per 5-minute tick.
--
-- STEP 0 -- the body this migration starts from (production, read-only, 2026-11-05)
--   select md5(prosrc), length(prosrc), prosecdef, provolatile, proconfig, proacl::text, obj_description(oid, 'pg_proc')
--     from pg_proc where oid = 'public.neutral_title_repick_candidates(text, integer)'::regprocedure;
--   -> md5 e0d9b88645ff3d4952fb44d02b38ee98, length 839, prosecdef t, provolatile s, proconfig {search_path=""},
--      proacl {postgres=X/postgres,service_role=X/postgres}, comment = 155's text ("... Migrations 141, 155.").
--   md5 of the function body text (between the dollar-quote markers) in 155_neutral_title_repick_growth.sql: e0d9b88645ff3d4952fb44d02b38ee98.
--   They are equal: production runs 155's body (no later migration redefines the function), so this file is built on
--   the current body. tests/migrations/162-stale-edit-repick.test.ts recomputes the md5 of 155's body. If a later release
--   changes prosrc, compare again before applying.
--
-- RELEASE ORDER. Apply 162 AFTER the Vercel deploy that carries the picker change (incumbentIsMemberTitle and the stale
--   re-pick): the headline cron is a Vercel route, so no function deploy is needed, but the order matters. The app does not
--   need 162 to run (the function exists either way). With 162 applied BEFORE the new picker, the cron would re-pick each
--   stale cluster, get its stale title back unchanged and stamp it, and the stale set does not look at the stamps, so the
--   same 20 newest rows would be offered on every 5-minute tick and crowd the model-heal rows out of the budget until the
--   deploy lands.
--
-- VERIFY (read-only, after applying):
--   1. select md5(prosrc), length(prosrc) from pg_proc where oid = 'public.neutral_title_repick_candidates(text, integer)'::regprocedure;
--      -> bb64fbb5bd16d32f659fb9d22889a166, 2418 (was e0d9b88645ff3d4952fb44d02b38ee98, 839); prosrc contains 'article_title_versions'.
--   2. select has_function_privilege('anon', 'public.neutral_title_repick_candidates(text, integer)', 'execute'),
--             has_function_privilege('authenticated', 'public.neutral_title_repick_candidates(text, integer)', 'execute'),
--             has_function_privilege('service_role', 'public.neutral_title_repick_candidates(text, integer)', 'execute');
--      -> f, f, t.
--   3. select version, name from supabase_migrations.schema_migrations where version = '162';
--   4. The stale set, on the same key as the function (59 clusters when this was written, 2026-11-05; the cron re-picks 20 per
--      tick and the set shrinks to the RESIDUE above as it does):
--      with e as (select distinct ca.cluster_id, pg_catalog.regexp_replace(public.tayf_search_fold(v.old_title), '[^a-z0-9]+', '', 'g') fo
--                   from public.article_title_versions v join public.cluster_articles ca on ca.article_id = v.article_id
--                  where v.seen_at > pg_catalog.now() - interval '7 days')
--      select count(distinct e.cluster_id) from e join public.clusters c on c.id = e.cluster_id
--       where not c.is_archived and c.title_neutral_at is null and c.title_tr_neutral is not null
--         and pg_catalog.regexp_replace(public.tayf_search_fold(c.title_tr_neutral), '[^a-z0-9]+', '', 'g') <> ''
--         and pg_catalog.strpos(e.fo, pg_catalog.regexp_replace(public.tayf_search_fold(c.title_tr_neutral), '[^a-z0-9]+', '', 'g')) > 0
--         and not exists (select 1 from public.cluster_articles ca2 join public.articles a2 on a2.id = ca2.article_id
--                          where ca2.cluster_id = c.id
--                            and (pg_catalog.strpos(pg_catalog.regexp_replace(public.tayf_search_fold(a2.title), '[^a-z0-9]+', '', 'g'),
--                                                   pg_catalog.regexp_replace(public.tayf_search_fold(c.title_tr_neutral), '[^a-z0-9]+', '', 'g')) > 0
--                                 or pg_catalog.strpos(pg_catalog.regexp_replace(public.tayf_search_fold(pg_catalog.replace(a2.title, 'Başkan Erdoğan', 'Cumhurbaşkanı Erdoğan')), '[^a-z0-9]+', '', 'g'),
--                                                      pg_catalog.regexp_replace(public.tayf_search_fold(c.title_tr_neutral), '[^a-z0-9]+', '', 'g')) > 0));
--   5. GET https://www.tayfhaber.com/cluster/31fde7d7-548c-42b2-8f5e-7d293510f329 shows "...temizlik işçisi hayatını kaybetti" in <title> and the H1
--      (page cache: allow the ISR window).
--
-- Safe to re-apply: create or replace function, comment, revoke/grant restated, ledger insert `on conflict do
-- nothing`. Nothing is written to public tables.
--
-- ROLLBACK (the previous rule is 155's; re-run its function and drop the ledger row):
--   re-run section 1 of 155_neutral_title_repick_growth.sql (its create or replace function, comment, revoke and grant), then
--   delete from supabase_migrations.schema_migrations where version = '162';
--   That restores md5 e0d9b88645ff3d4952fb44d02b38ee98. The ACL does not change in either direction.
--
-- See tests/migrations/162-stale-edit-repick.test.ts.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. The candidates: 155's three branches plus the stale-edit branch. Everything else is 155's.
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
   order by w.updated_at desc
   limit least(greatest(coalesce(p_limit, 20), 1), 50);
$fn$;

comment on function public.neutral_title_repick_candidates(text, integer) is
  'Extractive neutral titles worth re-picking: active clusters of the last 14 days (newest 5000 '
  'walked on clusters_neutral_repick_idx) with no LLM title, picked by another model than p_model, '
  'never stamped, grown by half (at least +3) over the article_count they were picked at, or whose '
  'stored title an outlet has since edited away (contained in an old_title that article_title_versions '
  'recorded in the last 7 days, and in no current member title). Newest first, '
  'p_limit clamped to 1..50. Read-only; the headline cron stamps the rows. service_role only. Migrations 141, 155, 162.';

revoke all on function public.neutral_title_repick_candidates(text, integer) from public, anon, authenticated;
grant execute on function public.neutral_title_repick_candidates(text, integer) to service_role;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('162', '162_neutral_title_stale_edit_repick')
  on conflict do nothing;

commit;
