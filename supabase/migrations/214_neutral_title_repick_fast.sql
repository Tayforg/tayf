-- 214_neutral_title_repick_fast.sql
--
-- Neutral-title re-pick candidates: the same function, the same rules, the same candidate set in the same order, read through one window and one
-- set of index probes instead of a hashed IN over a whole outlet and a clusters probe per stale pair. One function re-created
-- (public.neutral_title_repick_candidates(text, integer)); 209's body is the base and every predicate of 208 and 209 is kept. No table,
-- column, index, trigger or data change, no backfill, no UPDATE, no cron change, no EXTRACTIVE_MODEL_ID bump (the v6 heal is running),
-- no LLM, no app change, no Deno change. (h189-repick-timeout, hunt 189, 2026-11-15.)
-- tests/migrations/214-repick-fast.test.ts pins all of it.
--
-- WHY
--   The headline cron calls the function every 5 minutes through PostgREST, under the service's 8 s statement_timeout. Since 209
--   (applied about 2026-11-13 00:30Z) some of those calls are cancelled: the route logs "[headline-cron] repick-candidates { code: 57014,
--   message: canceling statement due to statement timeout }" (Vercel, 2026-11-15 02:00Z) and ops_cron_route_runs records 599.
--   ops_cron_route_runs, route headline, 4 days to 2026-11-15 ~02:30Z: 1,152 runs, p50 3,826 ms, p90 6,022, p99 8,162, max 8,774, and 11
--   ended 599 after 8.13-8.77 s (11-13: 5, 11-14: 4, 11-15 by 02:00Z: 1, and one on 11-11 before 209; it was 0-1 a day). They fall on
--   :00, :05 (2), :15 (5), :35, :45 and :50: five of the eleven on the :15 tick.
--   pg_stat_statements (since 2026-11-01 22:50Z): the PostgREST call of this function, 3,763 calls, mean 2,133 ms, max 7,907 ms,
--   20,357 buffer hits and 2,478 reads per call. The same body warm, as a plain SELECT, is 357-420 ms: what times out is the COLD call.
--   The database (PostgreSQL 17.6, shared_buffers 256 MB, effective_cache_size 768 MB) holds articles 1.2 GB and clusters 412 MB; between
--   two 5-minute calls the pages the function reads fall out of the cache, and a cold call reads 5-11 thousand pages one random read
--   at a time (0.55-0.6 ms each: 3.6-4.6 s after a heavy read of other data, 6.3-7.1 s after a read that evicts everything; the 8 s cancel
--   needs a little contention on top of that). The pages, not the CPU, are the cost.
--   (Pre-existing, not touched here: the planner statistics of clusters and articles are three weeks old, last autoanalyze 2026-10-21
--   and 2026-10-23, so the window's row estimate is 45 against 3,366 actual; the body below pins what each set reads, not how the sets
--   are joined; see the paragraph of THE RULE that starts "Everything else".)
--
-- STEP 0 -- the body this migration starts from (production, read-only, 2026-11-15 ~02:10Z)
--   select md5(prosrc), length(prosrc), prosecdef, provolatile, proconfig::text, proacl::text
--     from pg_proc where oid = 'public.neutral_title_repick_candidates(text,integer)'::regprocedure;
--   -> md5 cf7458daa1b7b96e750c5583693e2608, length 11078, prosecdef t, provolatile s, proconfig {search_path=""},
--      proacl {postgres=X/postgres,service_role=X/postgres}.
--   That md5 equals the md5 of 209's body (the text between the dollar-quote markers in 209_neutral_title_repick_loaded_cased.sql), so
--   production runs 209's body and no later migration redefines the function. tests/migrations/214-repick-fast.test.ts recomputes it.
--   If a later release changes prosrc, compare again before applying and do not apply on a mismatch.
--
-- WHERE THE COST WAS (209's body as a plain SELECT, p_model 'extractive-v6', p_limit 50, EXPLAIN (ANALYZE, BUFFERS) on production,
--   read-only, 2026-11-15 ~02:10Z: 429 ms, 46,244 hits and 27 reads on the first run, 3,366 window rows, 1 row offered)
--   - the window, 3,366 rows of clusters_neutral_repick_idx: 13 ms, 3,337 hits;
--   - SubPlan 1, 208's stale rule: 136 ms, 19,938 hits: each of the 4,302 version rows of 7 days probed into cluster_articles on its own
--     (13,993 hits, 1,087 rows found), then 1,003 clusters_pkey probes (4,009 hits, the stored title's key computed three times each),
--     then 60 clusters through the member check (1,372 hits);
--   - SubPlan 2, 209's hashed IN over isci-haber's last 15 days: 54 ms, 20,018 hits: 5,199 articles read with their titles (3,921 hits)
--     and 5,199 cluster_articles probes (16,095 hits), of which 621 find a cluster;
--   - SubPlan 4, branch B's word scan: 114 clusters at 0.59 ms, 67 ms, 2,951 hits;
--   - the rest of the OR chain over the 3,366 stored titles is CPU only: the placeholder and teaser rule 126-163 ms (two tayf_search_fold
--     calls per title at 13 us each), branch A 58 ms. Each arm alone (arm or random() < 0): stale 119-143 ms, placeholder/teaser 126-163,
--     A 58-59, B 125-127 with 23k hits, the cheap arms 12-16.
--   Cold (the same body right after a heavy read of other tables, 4 runs): 6,572-7,125 ms and 11,262-11,818 reads. Of one 6.55 s run's
--   10,282 reads: the window 2,135, the stale rule 2,862 (clusters_pkey 601, cluster_articles 1,811), the isci hashed IN 4,501 (3,387 of
--   them the 5,199 titles), the word scan 784. Which sub-plan was the cost: branch B's hashed IN (209's addition: 4,501 reads, 20,018
--   hits, 54 ms) and the stale rule's single probes (208's: 2,862 reads, 19,938 hits, 136 ms); the biggest CPU item is the double fold
--   of the placeholder and teaser rule.
--
-- THE RULE (nothing is added or dropped: the same predicates, evaluated once and over small sets)
--   1. `w` is the 14-day window of 208/209 (not archived, never LLM-titled, a neutral title, at least 2 members, updated in the last 14
--      days, newest 5000 on clusters_neutral_repick_idx), a materialized CTE read once, that also carries the house fold of the stored
--      title (tayf_search_fold, computed once per row: it is SET search_path = '' and so never inlined, 13 us a call). The placeholder
--      and teaser rules read that fold, where 209 computed it twice per row.
--   2. `ver` (the title versions seen in the last 7 days) and `isci` (the ids only of the isci-haber articles of the last 15 days, from
--      the covering index idx_articles_source_published_inc_id: an index-only scan, no title fetched, where 209 fetched 5,199 titles)
--      are probed into cluster_articles by ONE `= ANY (array)` index scan (`mem`): PostgreSQL walks the sorted array through the index
--      once instead of descending once per key. Production, warm: 8,640 distinct ids, 1,453 rows, 38 ms and 12.4k hits, where 209's
--      4,302 + 5,199 single probes took about 110 ms and 30k hits.
--   3. The stale rule (208/200) is the same three conditions and the same key (quotation marks outside a word kept, every other mark
--      dropped; the Başkan Erdoğan spelling): the pairs (cluster, old title) of `mem` joined to `w` IN MEMORY (209 probed clusters_pkey
--      once per pair and computed the stored title's key three times), the stored key taken from w.f and computed once per pair (an
--      `offset 0` lateral stops the planner from inlining it into every use), the member check unchanged.
--   4. The isci-haber rule (209's B): `bcand` is the window's clusters that have an isci-haber member (an id of `isci`, a row of `mem`)
--      whose btrim(title) equals the stored title's, the title read by primary key only for those members; the word scan, which is 209's
--      text byte for byte, runs only on those clusters (114 of 3,366 on production).
--   5. Branch A (the loaded epithet) tests three literal substrings of the title as written ('atil', 'hale', 'rant': every alternative of
--      its regular expression holds one of them, so a title with none cannot match) before the unchanged expression.
--   6. Order and tie-break: w.updated_at desc, w.id as the tie-break. 209 had no tie-break (equal updated_at came back in the plan's
--      order); on production the 3,366 window rows have 3,366 distinct updated_at, so the order does not change.
--   Everything else is 209's byte for byte: the window and its 5000 cap, the model, NULL-stamp, growth, gate-fail, young and shout
--   arms, the word scan, the 1..50 limit clamp. Every one of 209's SQL string literals is in the new body and the only new ones are the
--   three prefilters (the test pins both). Each set is a materialized CTE, so what each set reads and how often it is read does not
--   depend on a row estimate; the join method BETWEEN the sets still does: the planner sees mem at 10 rows against about 1,453 actual
--   (the length of an InitPlan array is always guessed as 10) and w at 44-45 against 3,366. Production, read-only, 2026-11-15: EXPLAIN
--   shows hash joins between the CTE scans and no seq scan, and the plain SELECT runs 244-246 ms warm; with enable_hashjoin and
--   enable_mergejoin set off for the test only it runs about 2.3 s warm (2,266 and 2,294 ms in two runs). A plan flip after a future
--   ANALYZE of clusters and articles would therefore add about 2 s to a cold call: re-check with EXPLAIN after that ANALYZE.
--   Not done, on purpose: a covering partial index on clusters. The window's 3,366 heap rows are 2,135 of a cold call's reads, but the
--   rows of the window are rows UPDATED in the last 14 days, on pages that autovacuum (last run on clusters 2026-09-28) has not marked
--   all-visible, so an index-only scan would still visit the heap; EXPLAIN on production cannot show otherwise without the index, so
--   none is built (an index would be its own CONCURRENTLY migration). The same stale visibility map is why `mem` reads the heap for 1,328
--   of its 1,453 rows: a lower autovacuum_vacuum_scale_factor on cluster_articles would help, and is the operator's call, not this file's.
--
-- THE COST (the plain SELECT of each body on production, read-only, 2026-11-15 ~02:20-02:50Z, p_model 'extractive-v6', p_limit 50,
--   old and new alternating)
--   warm, EXPLAIN (ANALYZE, BUFFERS): 209's body 364.6, 361.5, 360.0 and 368.1 ms (shared hit 46,272); this body 249.7, 260.5, 250.7 and
--     251.7 ms (shared hit 21,972); planning 8.0-8.2 ms against 7.5-7.9. With TIMING OFF: 209's 364.2, 357.0 and 366.3 ms; this body's
--     255.4, 306.8 and 282.4 ms; 208's body 243.0 ms.
--   cold, right after a heavy read of other tables (4 runs each, alternating): 209's body 7,125, 6,999, 6,572 and 7,106 ms (reads 11,669,
--     11,818, 11,262 and 11,661); this body 4,199, 4,385, 4,376 and 4,299 ms (reads 8,539, 8,759, 8,755 and 8,688). The first call after
--     an idle spell was 209's body at 4,469 ms and 5,594 reads.
--   where this body spends its time (warm, timing on): the window 55 ms with its folds, the one array scan of cluster_articles 43 ms
--     (building the array of 8,640 ids 18 ms of it), the stale pairs and keys about 50 ms, the isci clusters 7 ms, the filter and the word
--     scan (114 clusters at 0.54 ms) about 110 ms. Cold, the array scan is the largest piece (3,373-3,586 reads, about 1,300 of them heap
--     fetches for rows on pages vacuum has not marked all-visible) next to the window's 2.2k.
--   So 209's body to this body: 360 -> 250 ms warm (-30%), 46.3k -> 22.0k buffer hits (-52%), 6.6-7.1 -> 4.2-4.4 s cold (-38%),
--     11.3-11.8k -> 8.5-8.8k reads (-25%). It does not reach 1 s cold: the window's 3,366 heap rows and the membership reads of recent rows
--     are what is left, and both are pages the cache does not hold. 209's cold run sits 0.9-1.4 s under the 8 s cancel; this body is
--     under half of it.
--
-- PARITY (production, read-only: 209's body and this body as plain SELECTs in ONE statement, the same now(), p_limit lifted to 500, ids and
--   order compared at three different times, each time twice: p_model 'extractive-v6' (the rules decide) and a model nobody stamped (every
--   window row is offered, so the first 500 of the window's order are compared))
--   2026-11-15 02:50:18Z: 1 and 1 rows (1c7c34ba), identical; the other model 500 and 500, identical.
--   2026-11-15 02:51:51Z: the same.
--   2026-11-15 02:53:48Z, and 02:57:01Z after the 02:55 cron tick: the same, both times.
--   The sets behind the rules, on the same data (distinct clusters of the window): the stale rule before its member check 43 and 43
--   (identical sets), with the member check turned the other way 43 and 43 (identical), the stale rule whole 0 and 0; the clusters whose
--   stored title is an isci-haber member's text (209's hashed IN against `bcand`) 114 and 114 (identical). Branch A's prefilter against
--   209's expression: 22,000 stored titles of production (0 true, 0 disagreements) and 13 titles written to hit and to miss every
--   alternative (7 true, 0 disagreements). Production offers one row today (1c7c34ba, the placeholder and teaser rule), so the rules that
--   offer nothing there are compared on the live fixtures of the test: hand-built shapes, the window and cap boundaries, and four seeded
--   random populations of 160 clusters in which each of the four rules offers rows on its own (17 live tests).
--
-- RELEASE ORDER. There is no deploy-order constraint: the change is one SQL function and nothing in the app, the cron or the Edge
--   Functions reads anything but the rows it returns. Apply it when convenient (`supabase db push`, or post the SQL); the headline cron's
--   next tick uses it. The migration is not applied by the PR.
--
-- VERIFY (read-only, after applying):
--   1. select md5(prosrc), length(prosrc) from pg_proc where oid = 'public.neutral_title_repick_candidates(text, integer)'::regprocedure;
--      -> 6ec3157704dee41e96daf0d744c35b7a, 10484 (was cf7458daa1b7b96e750c5583693e2608, 11078); prosrc contains 'materialized' and 'isci-haber'.
--   2. select has_function_privilege('anon', 'public.neutral_title_repick_candidates(text, integer)', 'execute'),
--             has_function_privilege('authenticated', 'public.neutral_title_repick_candidates(text, integer)', 'execute'),
--             has_function_privilege('service_role', 'public.neutral_title_repick_candidates(text, integer)', 'execute');
--      -> f, f, t.
--   3. select version, name from supabase_migrations.schema_migrations where version = '214';
--   4. select id from public.neutral_title_repick_candidates('extractive-v6', 50);  -> the rows 209's body offers (compare with the
--      plain SELECT of 209's body, which is in the 209 file between the dollar-quote markers, with p_model and p_limit filled in).
--   5. After a day: select count(*) filter (where status = 599), count(*), max(duration_ms) from public.ops_cron_route_runs
--      where route = 'headline' and ran_at > now() - interval '24 hours'; and the pg_stat_statements row of the call (mean_exec_time,
--      shared_blks_read / calls) against the numbers above (2,133 ms, 2,478 reads).
--
-- Safe to re-apply: create or replace function, comment, revoke/grant restated, ledger insert `on conflict do nothing`. Nothing is written
-- to public tables.
--
-- ROLLBACK (the previous body is 209's; re-run its function and drop the ledger row):
--   re-run the create or replace function, the comment, the revoke and the grant of 209_neutral_title_repick_loaded_cased.sql, then
--   remove the ledger row: delete from supabase_migrations.schema_migrations where version = '214'; That restores md5
--   cf7458daa1b7b96e750c5583693e2608. The ACL does not change in either direction.
--
-- See tests/migrations/214-repick-fast.test.ts.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. The candidates: 209's rules, read through one window and one set of index probes. Same signature, return type, volatility,
--    SECURITY DEFINER and empty search_path.
-- ---------------------------------------------------------------------------

create or replace function public.neutral_title_repick_candidates(p_model text, p_limit integer default 20)
returns table (id uuid, title_tr_neutral text, article_count integer, title_neutral_member_count smallint)
language sql
stable
security definer
set search_path = ''
as $fn$
  with w as materialized (
    select c.id, c.title_tr_neutral, c.article_count, c.title_neutral_member_count,
           c.title_neutral_model, c.updated_at,
           public.tayf_search_fold(c.title_tr_neutral) as f
      from public.clusters c
     where c.is_archived = false
       and c.title_neutral_at is null
       and c.title_tr_neutral is not null
       and c.article_count >= 2
       and c.updated_at > pg_catalog.now() - interval '14 days'
     order by c.updated_at desc
     limit 5000
  ),
  ver as materialized (
    select v.article_id, v.old_title
      from public.article_title_versions v
     where v.seen_at > pg_catalog.now() - interval '7 days'
  ),
  isci as materialized (
    select ai.id
      from public.sources si
      join public.articles ai on ai.source_id = si.id
     where si.slug = 'isci-haber'
       and ai.published_at > pg_catalog.now() - interval '15 days'
  ),
  mem as materialized (
    select ca.cluster_id, ca.article_id
      from public.cluster_articles ca
     where ca.article_id = any (array(select x.article_id from ver x union select y.id from isci y))
  ),
  stale as materialized (
    select p.cluster_id
      from (
        select distinct m.cluster_id, ver.old_title
          from ver
          join mem m on m.article_id = ver.article_id
      ) p
      join w on w.id = p.cluster_id
      cross join lateral (
        select pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(w.f, pg_catalog.chr(1), '', 'g'), '(?<![a-z0-9])[''‘’"“”«»]|[''‘’"“”«»](?![a-z0-9])', pg_catalog.chr(1), 'g'), '[^a-z0-9' || pg_catalog.chr(1) || ']+', '', 'g'), '^' || pg_catalog.chr(1) || '+|' || pg_catalog.chr(1) || '+$', '', 'g') as sk,
               pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(public.tayf_search_fold(p.old_title), pg_catalog.chr(1), '', 'g'), '(?<![a-z0-9])[''‘’"“”«»]|[''‘’"“”«»](?![a-z0-9])', pg_catalog.chr(1), 'g'), '[^a-z0-9' || pg_catalog.chr(1) || ']+', '', 'g'), '^' || pg_catalog.chr(1) || '+|' || pg_catalog.chr(1) || '+$', '', 'g') as fo
        offset 0
      ) k
     where k.sk <> ''
       and pg_catalog.strpos(k.fo, k.sk) > 0
       and not exists (
         select 1
           from public.cluster_articles ca2
           join public.articles a2 on a2.id = ca2.article_id
          where ca2.cluster_id = p.cluster_id
            and (
              pg_catalog.strpos(pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(public.tayf_search_fold(a2.title), pg_catalog.chr(1), '', 'g'), '(?<![a-z0-9])[''‘’"“”«»]|[''‘’"“”«»](?![a-z0-9])', pg_catalog.chr(1), 'g'), '[^a-z0-9' || pg_catalog.chr(1) || ']+', '', 'g'), '^' || pg_catalog.chr(1) || '+|' || pg_catalog.chr(1) || '+$', '', 'g'), k.sk) > 0
              or pg_catalog.strpos(pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(public.tayf_search_fold(pg_catalog.replace(a2.title, 'Başkan Erdoğan', 'Cumhurbaşkanı Erdoğan')), pg_catalog.chr(1), '', 'g'), '(?<![a-z0-9])[''‘’"“”«»]|[''‘’"“”«»](?![a-z0-9])', pg_catalog.chr(1), 'g'), '[^a-z0-9' || pg_catalog.chr(1) || ']+', '', 'g'), '^' || pg_catalog.chr(1) || '+|' || pg_catalog.chr(1) || '+$', '', 'g'), k.sk) > 0
            )
       )
  ),
  bcand as materialized (
    select distinct m.cluster_id
      from mem m
      join isci i on i.id = m.article_id
      join w on w.id = m.cluster_id
      join public.articles ab on ab.id = m.article_id
     where pg_catalog.btrim(ab.title) = pg_catalog.btrim(w.title_tr_neutral)
  )
  select w.id, w.title_tr_neutral, w.article_count, w.title_neutral_member_count
    from w
   where w.title_neutral_model is distinct from p_model
      or w.title_neutral_member_count is null
      or w.article_count >= w.title_neutral_member_count + greatest(3, ceil(w.title_neutral_member_count * 0.5))
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
      or ((pg_catalog.strpos(w.title_tr_neutral, 'atil') > 0
           or pg_catalog.strpos(w.title_tr_neutral, 'hale') > 0
           or pg_catalog.strpos(w.title_tr_neutral, 'rant') > 0)
          and pg_catalog.regexp_replace(w.title_tr_neutral, ':\s*["“''‘«].*$', '') ~ '(?:^|[^[:alnum:]çğıöşüâîûÇĞİÖŞÜÂÎÛ])(?:[Kk]atil(?:ler)?(?:e|i|in|ini|ine|lere|leri|lerin|lerine)?[[:space:]]+[Dd]este[kğ]|[Kk]atil[[:space:]]+(?:rejim|devlet|ordu|hükümet|siyonist)|[İi]hale[[:space:]]+rant|rant[[:space:]]+kap[ıi]s)')
      or (pg_catalog.strpos(w.title_tr_neutral, '?') = 0
          and pg_catalog.strpos(w.title_tr_neutral, pg_catalog.chr(775)) = 0
          and (case
                 when w.f ~ '(?:aciklama(?:lar)?|mesajlar)[^a-z0-9]*$'
                 then public.tayf_search_fold(pg_catalog.regexp_replace(w.title_tr_neutral, '^.*\. ', '')) ~ '^[^a-z0-9:]*(?:[a-z0-9]{1,40}[^a-z0-9:]+){0,3}(?:[a-z0-9]{1,40}[^a-z0-9:]+(?:dan|den|tan|ten|ndan|nden)|[a-z0-9]{1,40}(?:dan|den|tan|ten))[^a-z0-9:]+(?:(?:onemli|son[^a-z0-9:]+dakika|yeni|kritik)[^a-z0-9:]+)?(?:aciklama(?:lar)?|mesajlar)[^a-z0-9:]*$'
                   and w.f !~ '(?<![a-z0-9])(?:[a-z0-9]{0,40}(?:(?:(?<=[cfhkpst])t|(?<![cfhkpst])d)[iu](?:m|k|niz|nuz|lar|ler|r)?|m[iu]s(?:t[iu]r?|lar|ler|[iu]m|[iu]z|s[iu]n|s[iu]n[iu]z)?|[iu]yor(?:um|sun|uz|sunuz|lar|du|mus)?|[ae]c[ae]k(?:t[iu]r|lar|ler|sin|siniz)?|[ae]c[ae]g(?:im|iz)|m[ae]li(?:d[iu]r|lar|ler)?|[ae]bilir(?:ler|lar)?)|var|yok|degil|vardir|yoktur|degildir|idi|imis)(?![a-z0-9])'
                 else false
               end
               or case
                 when w.f ~ '(?:^|[^a-z0-9])(?:ne|neler|kimler|hangi|neden)(?:[^a-z0-9]|$)'
                 then public.tayf_search_fold(pg_catalog.regexp_replace(pg_catalog.regexp_replace(w.title_tr_neutral, ':\s*["“''‘«].*$', ''), '[!?]|\.\s', ':', 'g')) ~ '(?:^|[^a-z0-9])(?:ne[^a-z0-9]+oldu|neler[^a-z0-9]+(?:oldu|var))(?:[^a-z0-9]|$)|(?:^|[^a-z0-9])kimler[^a-z0-9:]+var[^a-z0-9]*(?::|$)|(?:^|:)(?![^:]*(?<![a-z0-9])[a-z0-9]{0,40}(?:d[iu]g|t[iu]g|[ae]c[ae]g)[iu]n[iu](?![a-z0-9]))[^:]*(?<![a-z0-9])hangi[^a-z0-9:]+[a-z0-9]{1,40}[^a-z0-9:]+ne(?:[^a-z0-9]|$)|(?:^|[^a-z0-9])neden(?![^a-z0-9:]+ol)(?:[^a-z0-9:]+[a-z0-9]{1,40}){0,4}[^a-z0-9:]+[a-z0-9]{0,40}m[ae]d[iu][^a-z0-9]*(?::|$)'
                 else false
               end))
      or w.id in (select s.cluster_id from stale s)
      or (w.id in (select b.cluster_id from bcand b)
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
   order by w.updated_at desc, w.id
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
  '1..50. Read-only; the headline cron stamps the rows. service_role only. Migrations 141, 155, 162, 169, 184, 200, 208, 209, 214.';

revoke all on function public.neutral_title_repick_candidates(text, integer) from public, anon, authenticated;
grant execute on function public.neutral_title_repick_candidates(text, integer) to service_role;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('214', '214_neutral_title_repick_fast')
  on conflict do nothing;

commit;
