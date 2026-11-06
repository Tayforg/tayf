-- 169_neutral_title_repick_gate_fail.sql
--
-- Neutral-title re-pick: a stamped extractive title that FAILS THE LENGTH OR '?' GATE is offered again as soon as the
-- cluster has grown by one member since the stamp. One function re-created (public.neutral_title_repick_candidates(text,
-- integer)); the body is 162's with one extra branch in the outer WHERE and nothing else. No table, column, index,
-- trigger or data change, no backfill, no UPDATE, no EXTRACTIVE_MODEL_ID bump (the v6 heal is running).
-- (h54-editorial-2, hunt 54, 2026-11-06)
-- tests/migrations/169-repick-gate-fail.test.ts pins all of it.
--
-- WHY
--   An extractive title is picked when a cluster first reaches 2 members, with the floor: when no member passes
--   isAcceptableNeutral the pick is still the best member, however long it is and whether or not it is a question.
--   The re-pick (155, 162) then offers the stamped cluster again only after a model change, a NULL stamp, growth by
--   half (n + greatest(3, ceil(n / 2)), which is 5 members for a stamp of 2) or an outlet edit of the stored title. A
--   cluster stamped at 2 whose stored title fails the gate and then gains a clean member is none of those: the title is
--   still a member's own text (so 162's stale branch does not apply), the model is current and the count is 3 or 4.
--   Re-checked read-only on production, 2026-11-06 18:48-18:53Z (all extractive-v6, all stamped 2):
--     d096acf8  203 characters, article_count 3: the haberler-com quote "Cumhurbaşkanı Erdoğan: "Azerbaycan'la
--               ilişkilerimiz, klasik diplomatik ... ürünüdür"", next to a bare quote ('"İKİ ÜLKENİN BAĞI KOPMAZ"') and
--               AA's own wording, which passes the gate.
--     442e0395  167 characters, article_count 4: Hürriyet's "... 100 bin dolar rüşvet verilen kutu içindeki atkıları
--               ağustosta değil ekimde kendi kredi kartımla aldım". GET /cluster/442e0395-... answers 200, index,follow,
--               with that text in <title> and og:title: an unproven bribery stated as fact about the opposition leader,
--               in the first person.
--     e0750c57  129 characters, article_count 3: yeni-safak's "... sert tepki: Türkiye'de aslan kesilenler İsrail
--               karşısında kağıttan kaplan", next to en-politik's "Erdoğan'dan basın özgürlüğü kuruluşlarına tepki".
--   The v6 heal does not cover them: they already carry v6. A replay of the real pickNeutralTitle (Node 24) on the current
--   members, fresh and with { incumbent: stored }, gives the member that passes the gate for each (AA's wording for
--   d096acf8, A Haber's "Emir Sarıgül'ün üçüncü ifadesi ortaya çıktı: ..." for 442e0395, en-politik's for e0750c57), so a
--   single re-offer heals each. src/lib/clusters/neutral-title.test.ts pins those three picks.
--   Scope. 34 v6 titles in 7 days are over 110 characters or contain a '?' (the finding's count, 18:48Z); 5 of them had grown
--   since the stamp and all 5 sat below the growth bar. Re-measured at about 19:08Z (active, no LLM title, at least 2 members,
--   updated in 7 days): 42 such titles (9 over 110 characters, 35 with a '?', none under 20), 6 of them grown past their
--   stamp, none past the growth bar. The six are the three above and f19d276c, 7324209f and 012deab8, three titles that hold
--   a question. For those three the replay of pickNeutralTitle returns null (no member passes the gate), so the cron keeps
--   the stored title and stamps the count: they leave the set after one tick and come back only after further growth.
--
-- THE RULE
--   The new branch, after 162's last one:
--     or (w.title_neutral_member_count is not null
--         and w.article_count > w.title_neutral_member_count
--         and (char_length(w.title_tr_neutral) > 110
--              or char_length(btrim(w.title_tr_neutral)) < 20
--              or strpos(w.title_tr_neutral, '?') > 0))
--   written with pg_catalog.-qualified function names like the rest of 162's text. 110 and 20 are ACCEPT_MAX_LEN and
--   ACCEPT_MIN_LEN in src/lib/clusters/neutral-title.ts (isAcceptableNeutral trims first, then rejects a title longer
--   than 110 or shorter than 20 characters, then any '?'); tests/migrations/169-repick-gate-fail.test.ts reads both
--   constants from that file and fails when they drift from these literals. The gate's other defects (shouting, an
--   English headline, a leading "İşte", unbalanced double quotes) are NOT part of the branch: they are not on the
--   record for the live clusters and widening the branch is a separate decision.
--   Only a STAMPED cluster that has GROWN is offered (article_count strictly greater than the stamp). The headline cron
--   already stamps title_neutral_member_count = article_count after every pick, a kept title included, and it re-picks
--   with { incumbent }, where a gate-failing incumbent is not protected (pickNeutralTitle returns the best member that
--   passes). So there is no loop: a title that still fails after the pick (no member passes) comes back only after
--   further growth, one re-pick per new member, inside the same 20-per-tick budget as the other branches. The cron needs
--   no change; its RE-PICK comment now names this branch.
--
-- STEP 0 -- the body this migration starts from (production, read-only, 2026-11-06)
--   select md5(p.prosrc), length(p.prosrc), p.proconfig::text, p.proacl::text, p.prosecdef, p.provolatile
--     from pg_proc p where p.proname = 'neutral_title_repick_candidates';
--   -> md5 bb64fbb5bd16d32f659fb9d22889a166, length 2418, prosecdef t, provolatile s, proconfig {search_path=""},
--      proacl {postgres=X/postgres,service_role=X/postgres}.
--   That md5 equals the md5 of 162's body (the text between the dollar-quote markers in
--   162_neutral_title_stale_edit_repick.sql), so production runs 162's body and no later migration redefines the function.
--   tests/migrations/169-repick-gate-fail.test.ts recomputes the md5 of 162's body, and the dry-run script refuses a
--   baseline whose md5 differs. If a later release changes prosrc, compare again before applying.
--
-- THE COST
--   EXPLAIN (ANALYZE, BUFFERS, TIMING OFF) of each body as a plain SELECT in a READ ONLY transaction on production,
--   2026-11-06 ~19:10Z (p_model 'extractive-v6', p_limit clamped to 50): 162's body 1,157 ms (cold), then 133 and 150 ms
--   warm; 169's body 136, 136 and 150 ms warm. The new branch is a few comparisons on the at most 5000 rows of the window
--   after the sort; the stale CTE is still computed once. Planning time 4.6-6 ms for both.
--
-- RELEASE ORDER. APPLY 169 any time; no app deploy is needed. The cron needs no change, and the picker already returns a
--   member's wording for a gate-failing incumbent (since h42-titles-1), so the order against any deploy does not matter.
--
-- VERIFY (read-only, after applying):
--   1. select md5(prosrc), length(prosrc) from pg_proc where oid = 'public.neutral_title_repick_candidates(text, integer)'::regprocedure;
--      -> c5a3b354ff0f51ef77fae5b3fbf11b0a, 2745 (was bb64fbb5bd16d32f659fb9d22889a166, 2418); prosrc contains 'char_length'.
--   2. select has_function_privilege('anon', 'public.neutral_title_repick_candidates(text, integer)', 'execute'),
--             has_function_privilege('authenticated', 'public.neutral_title_repick_candidates(text, integer)', 'execute'),
--             has_function_privilege('service_role', 'public.neutral_title_repick_candidates(text, integer)', 'execute');
--      -> f, f, t.
--   3. select version, name from supabase_migrations.schema_migrations where version = '169';
--   4. The clusters the new branch offers and 162 did not (6 when this was written, 2026-11-06 ~19:08Z, among them
--      d096acf8, 442e0395 and e0750c57; each leaves the set once the cron stamps it):
--      select c.id, c.article_count, c.title_neutral_member_count, char_length(c.title_tr_neutral)
--        from public.clusters c
--       where not c.is_archived and c.title_neutral_at is null and c.title_tr_neutral is not null
--         and c.article_count >= 2 and c.updated_at > pg_catalog.now() - interval '14 days'
--         and c.title_neutral_member_count is not null and c.article_count > c.title_neutral_member_count
--         and (char_length(c.title_tr_neutral) > 110 or char_length(btrim(c.title_tr_neutral)) < 20
--              or strpos(c.title_tr_neutral, '?') > 0);
--   5. Within two headline cron ticks (10 minutes), GET https://www.tayfhaber.com/cluster/d096acf8-690a-4c46-bdd0-b2f2263ef3d7
--      shows AA's "Cumhurbaşkanı Erdoğan: Azerbaycan'la ilişkilerimiz klasik diplomatik temasların çok ötesindedir" in <title>
--      and the H1 (page cache: allow the ISR window); 442e0395 shows A Haber's wording instead of the Hürriyet text.
--
-- Safe to re-apply: create or replace function, comment, revoke/grant restated, ledger insert `on conflict do
-- nothing`. Nothing is written to public tables.
--
-- ROLLBACK (the previous rule is 162's; re-run its function and drop the ledger row):
--   re-run section 1 of 162_neutral_title_stale_edit_repick.sql (its create or replace function, comment, revoke and grant),
--   then delete from supabase_migrations.schema_migrations where version = '169';
--   That restores md5 bb64fbb5bd16d32f659fb9d22889a166. The ACL does not change in either direction.
--
-- See tests/migrations/169-repick-gate-fail.test.ts.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. The candidates: 162's four branches plus the gate-fail branch. Everything else is 162's, byte for byte.
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
  '20 characters, or it holds a question mark). Newest first, p_limit clamped to 1..50. Read-only; the '
  'headline cron stamps the rows. service_role only. Migrations 141, 155, 162, 169.';

revoke all on function public.neutral_title_repick_candidates(text, integer) from public, anon, authenticated;
grant execute on function public.neutral_title_repick_candidates(text, integer) to service_role;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('169', '169_neutral_title_repick_gate_fail')
  on conflict do nothing;

commit;
