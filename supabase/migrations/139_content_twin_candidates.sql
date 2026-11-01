-- 139_content_twin_candidates.sql
--
-- WHY (hunt 12, finding h12-cluster-4, 2026-11-01). Split stories stay live and
-- nothing offers them to the founder: `select count(*) from cluster_merge_log`
-- is 0 (ever). The /admin/birlestir queue is fed by story_thread_candidates at
-- confidence >= 0.9 and by Jev recall; migration 120's "Olası ikiz kümeler" only
-- sees same-source twins that share a source_article_key. A story that two
-- DIFFERENT outlets opened as two clusters reaches neither list. Live, unmerged
-- examples on 2026-11-01: f4c68960[34] + 112a68bd[10] (Zelenski arrives in
-- Istanbul, 24 min apart), 144cfc04[29] + c5627cb9[22] + 9e83921e[4] (Bahçeli's
-- "100 il" proposal), 71800f1c[13] + 4e57766e[10] (new SPK chairman),
-- 8ab93bbd[18] + 2c9941bd[7] (Antalya-Alanya motorway). Coverage counts and
-- blindspot flags on those indexable pages are computed per split cluster.
--
-- This migration adds ONE read-only function, public.admin_content_twin_pairs(),
-- the cheap first stage of a detector. It never merges anything: the founder
-- presses Birleştir per pair on /admin/birlestir, which POSTs the existing
-- /api/admin/cluster-merge flow (action 'merge', origin 'manual', logged "Elle",
-- cluster_merge_atomic from migration 099). The second stage runs in the app:
-- src/lib/admin/content-twins.ts re-scores each returned pair with the clustering
-- ensemble (scripts/lib/cluster, the byte-parity mirror of the consumer's scorer;
-- scripts/lib/content-twin-rescore.mjs) and lists only pairs at or above
-- MATCH_THRESHOLD. Ingest and clustering behaviour do not change.
--
--   public.admin_content_twin_pairs(p_hours integer default 48,
--                                   p_limit integer default 50)
--     returns table (cluster_a uuid, cluster_b uuid, title_a text, title_b text,
--                    summary_a text, summary_b text, published_a timestamptz,
--                    published_b timestamptz, article_count_a integer,
--                    article_count_b integer, shared_stems integer,
--                    jaccard numeric)
--   * live = clusters with first_published in [now() - p_hours, now()], not
--     archived, merged_into null and article_count >= 2, materialised once;
--     p_hours is clamped to 1..168 and p_limit to 1..100 (NULL means 48 and 50),
--     whatever the caller sends. (first_published, not created_at: the only
--     indexed time column, idx_clusters_first_published.)
--   * stems of a cluster = the distinct first 5 characters of every word of
--     tayf_search_fold(title_tr) (migration 129) that has at least 4 characters,
--     minus a literal array of 25 generic stems (below). Stems, not words, so
--     Belediyesi / Belediyesine / Belediyede are one.
--   * a pair joins two clusters on an equal stem with id_b > id_a (cluster_a <
--     cluster_b) AND first_published at most 6 hours apart, inside the join
--     (before the aggregation), and is kept when it shares at least 3 stems and
--     shared / (n_a + n_b - shared) >= 0.5.
--   * summary_a / summary_b are left(summary_tr, 600): the scorer reads them.
--   * order: Jaccard desc, then the newer first_published of the pair desc, then
--     the ids; then limit.
--   * LANGUAGE sql, STABLE, SECURITY DEFINER, search_path '' (every relation and
--     function is schema-qualified), service_role only: the admin page reads
--     through the service-role client. anon, authenticated and PUBLIC are revoked
--     (tests/guards/anon-surface.test.ts scans migrations from 116 on).
-- No table, no column, no index, no data written, no other grant.
--
-- WHY THESE NUMBERS (the spec said: start at 4 shared stems / Jaccard 0.6 and, if
-- a labelled merge pair fails that stage, fall back to migration 126's 3 / 0.5).
-- Stage-one numbers for the six labelled MERGE pairs of the finding (title stems
-- after the generic list; tests/lib/admin/content-twins.test.ts holds them as
-- executable fixtures, KNOWN_MISSES included):
--
--   pair                     shared  Jaccard  hours apart  ensemble alone
--   f4c68960 + 112a68bd         3     0.375       0.5          0.46  (would list)
--   144cfc04 + c5627cb9         2     0.182      13.9          0.35
--   144cfc04 + 9e83921e         0     0.000      15.7          0.21
--   c5627cb9 + 9e83921e         0     0.000       1.9          0.41  (would list)
--   71800f1c + 4e57766e         2     0.133       0.0          0.53  (would list)
--   8ab93bbd + 2c9941bd         6     0.500       0.05         0.41  (lists)
--
-- At 4 / 0.6 none of the six is a candidate, so the 126 fallback (3 / 0.5) is used;
-- it lets exactly one through (8ab93bbd + 2c9941bd, on the boundary: 6 shared of
-- 12). The other five are NOT fixed by tuning (the scorer and these constants are
-- fixed by the spec): 144cfc04 is a different story by title and 13.9 and 15.7
-- hours away from its siblings (outside the 6 hour window); cluster 9e83921e was
-- seeded by an unrelated article (an age-verification scam story whose summary
-- carries a Bahçeli link blurb), so its title shares nothing with the Bahçeli
-- clusters it really belongs with; 71800f1c / 4e57766e pair a decree headline with
-- a "Muhsin Atcı kimdir" explainer. Title stems cannot see those. Read-only prod
-- dry run of this body (2026-11-01, 48 hours, limit 100) through the same
-- re-scorer, to size the trade-off:
--
--   shared >= / Jaccard >=   SQL candidates   pass the re-scorer   labelled pairs listed
--          4 / 0.60                 9                 7                   0 of 6
--          3 / 0.50 (this file)    27                13                   1 of 6
--          3 / 0.34                60                18                   2 of 6
--          2 / 0.25               100 (cap)          24                   2 of 6
--
-- Looser stage-one numbers add candidates faster than they add the missed
-- labelled pairs, and the re-scorer is the precision gate; a change of those
-- constants is a one-line edit here plus CONTENT_TWIN in src/lib/admin/
-- content-twins.ts (the migration test pins the two together).
--
-- HAND CHECK (read-only, 2026-11-01) of 20 pairs that pass the re-scorer at 3 / 0.5: all
-- 13 from the 48 hour run and 7 picked across the score range from the 7 day run
-- (limit 100 reached, 44 pass). Two titles and three headlines per side were read for
-- each. 18 of 20 are real twins of one story (Bakırköy 39 arrests x3, the Antalya-Alanya
-- motorway, Rubio on the Black Sea grain ceasefire, Kurum on COP31, the Tavşanlı Höyük
-- paw print, the AYM civil servant pay ruling, the Spain train accident condolences ...);
-- the two that are not: Türk Dünyası Diyalog Forumu panels on two different topics
-- (score 0.81), and Bakan Kurum's versus Bakan Bolat's meeting with Mayor Tugay (0.52).
-- Borderline but counted as twins: the Hakkari martyr condolence messages (0.88) and the
-- Siber Güvenlik Kurulu "will convene" versus "convened" (0.57). The 7 day run also shows
-- a five-way split of the Mustafa Sarıgül story. Merging stays the founder's call.
--
-- GENERIC STEMS (25, literal array in the body; CONTENT_TWIN_GENERIC_STEMS in
-- content-twins.ts is the twin). Start: acikl dakik canli haber gunde video izle
-- yeni bugun icin sonra olara kadar nasil nedir. Refined with a read-only top-40
-- stem frequency query over the live clusters of the last 7 days (1,992 clusters):
--   bakan 249, cumhu 193, baska 174, erdog 149, yeni 143, icin 142, parti 129,
--   turki 127, acikl 119, secim 102, mesaj 88, israi 82, turk 78, oldu 77,
--   ekim 77, beled 74, dakik 69, etti 69, istan 67, ozel 66, karar 64, gorus 64,
--   ankar 61, devle 56, bayra 54, zirve 53, sorus 51, dunya 51, basla 50,
--   tutuk 50, trump 50, ozgur 48, iddia 47, milyo 46, mecli 43, katil 43,
--   genel 43, bakir 43, topla 43, iran 42.
-- Added (role titles and filler verbs that occur in 2 to 12 percent of titles and
-- say nothing about which story it is): bakan cumhu baska oldu etti ekim mesaj
-- gorus basla genel. Left out ON PURPOSE: every named entity (erdog, israi,
-- turki, turk, istan, ozel, ankar, trump, ozgur, bakir, iran), and topical words
-- (parti, secim, karar, beled, sorus, tutuk, dunya, zirve, iddia, mecli): two
-- titles sharing those ARE evidence for one story. The list stays at 25 entries.
--
-- STEP 0 (production, 2026-11-01, read-only SELECTs through the management API;
-- PostgreSQL 17.6; no secrets)
--   (a) supabase_migrations.schema_migrations: the newest version is 137
--       (137_source_items_7d); 138 and 139 are not recorded, so 139 is free.
--       (138, saved_clusters_v2 with the blindspot veto, is another item of the
--       same wave and does not touch this function.)
--   (b) public.clusters columns the body reads: id uuid, title_tr text NOT NULL,
--       summary_tr text NOT NULL, article_count integer NOT NULL,
--       first_published timestamptz NOT NULL, is_archived boolean NOT NULL,
--       merged_into uuid NULL. The declared result types match exactly.
--   (c) Indexes: idx_clusters_first_published btree (first_published desc) serves
--       the live window. reltuples(clusters) = 259,427; live clusters
--       (first_published >= now() - 48 hours, not archived, merged_into null,
--       article_count >= 2) = 452; over 7 days 1,992.
--   (d) tayf_search_fold(text) exists (migration 129), immutable, executable by
--       service_role; this function is SECURITY DEFINER so it runs as the owner.
--   (e) EXPLAIN (ANALYZE, BUFFERS) of the body as a plain SELECT with the literals
--       48 and 100, four runs: Planning Time 2.8 to 2.9 ms; Execution Time 60.0 ms
--       on the first (cold: 652 shared buffers, all hits) then 43.0, 43.1 and 42.8
--       ms (503 shared buffers hit). Plan: Bitmap Heap Scan on clusters through
--       BitmapAnd of idx_clusters_first_published (17 buffers, 2,835 entries) and
--       idx_clusters_active_updated_at; 452 live rows; the stems CTE yields 3,485
--       stems; 149 pairs share >= 3 stems, 27 survive the Jaccard filter. With
--       p_hours = 168 and p_limit = 100: 186 to 200 ms, 100 rows. The planner
--       estimates the stems CTE at 281,588 rows (a function scan has no
--       statistics) against 3,485 real ones; it still picks sort-merge joins that
--       touch a few hundred rows, and the shape does not depend on that estimate
--       staying lucky: every input is bounded by the live window (at most 168
--       hours). Target under 1 s warm: met by 20x.
--   (f) NO NEW INDEX. The 101/127 ORCHESTRATOR PRE-BUILD pattern (CREATE INDEX
--       CONCURRENTLY in the header, an invalid-index guard, then create index if
--       not exists) is for a new index on a large table; this function reads
--       clusters through the existing first_published index and adds none.
--
-- DRY RUNS x2 (local PostgreSQL 15.12, two throwaway clusters one after the other, port
-- 55539, data dirs scratchpad/pg-139-a and pg-139-b; the QA stub.sql, then
-- tests/migrations/sql/139-content-twin-candidates-dryrun.sql, which adds what the stub
-- lacks (clusters.merged_into and summary_tr, idx_clusters_first_published, migration
-- 129's tayf_search_fold copied verbatim, the Supabase default privileges), applies THIS
-- file twice and asserts everything below). Both runs end with "DRYRUN 139 OK":
--   * apply 1: BEGIN, CREATE FUNCTION, COMMENT, REVOKE, GRANT, INSERT 0 1, COMMIT.
--     apply 2: the same with INSERT 0 0 (the ledger row exists). No error either time.
--   * end state: one ledger row '139'; one function, SECURITY DEFINER, STABLE, proconfig
--     {"search_path=\"\""}; grantees postgres and service_role only (no PUBLIC);
--     has_function_privilege false for anon, false for authenticated, true for
--     service_role. Called as anon or authenticated the function fails with
--     insufficient_privilege; as service_role it returns 0 rows on the empty table.
--   * fixture (rolled back): of 7 clusters only the live pair qualifies (archived,
--     merged, single-article, 7 h away and another story are out); a cluster exactly 6 h
--     away joins (the window is inclusive); p_hours 0 clamps to 1, p_limit 0 to 1, NULL
--     to 48 and 50.
--   * load (rolled back): 2,000 clusters over 48 hours with a skewed vocabulary plus 40
--     planted twins = 2,040 live clusters. Run A: 43 pairs returned, 40 of them planted;
--     EXPLAIN (ANALYZE, BUFFERS) of the body with the literals 48 and 100, three runs:
--     Execution Time 117.6, 116.5 and 117.6 ms. Run B: 44 pairs, 41 planted (the planted
--     rows are an arbitrary 40 by id, so a random pair can join them); 124.2, 121.7 and
--     120.1 ms. This is the pessimistic case: the skewed vocabulary makes the stem
--     self-join read 1.19 million candidate rows (138,339 inside the 6 hour window)
--     before the 3-stem filter; production has 452 live clusters and ran in 43 ms.
--   * tests/migrations/139-content-twin-candidates.test.ts with TAYF_PSQL pointed at that
--     database: 39 passed (20 static, 19 live on rolled-back fixtures, the labelled
--     production pairs included: the SQL candidates equal isContentTwinCandidate over
--     every pair of 16 clusters). Mutating the applied function (not this file) fails a
--     live test each: either window bound at 7 h, Jaccard 0.4, shared >= 2, the first or
--     the sixteenth generic stem dropped, merged_into not checked, article_count >= 1, a 200
--     row clamp, summary cut at 500, a 3 letter token, a 6 letter stem, the Jaccard or
--     the newest-first order reversed, the id tie-break reversed. This file re-applied
--     afterwards: 39 of 39.
--   * both clusters were stopped afterwards.
--
-- ROLLBACK (nothing depends on this until the admin page is deployed; the page
-- shows "Veri okunamadı (139 uygulanmamış olabilir)." without the function):
--   1. Redeploy the previous app (the page then never calls the function).
--   2. drop function public.admin_content_twin_pairs(integer, integer);
--   3. delete from supabase_migrations.schema_migrations where version = '139';
--
-- DEPLOY ORDER. Free: the page tolerates the missing function (a sentence, not an
-- error page), and the function is unused until the page ships.
--
-- Safe to re-apply: create or replace function, comment on, revoke and grant are
-- idempotent; the ledger insert is `on conflict do nothing`.
--
-- See tests/migrations/139-content-twin-candidates.test.ts,
-- tests/lib/admin/content-twins.test.ts and
-- tests/guards/admin-content-twins-readonly.test.ts.

begin;

create or replace function public.admin_content_twin_pairs(p_hours integer default 48, p_limit integer default 50)
returns table (
  cluster_a uuid,
  cluster_b uuid,
  title_a text,
  title_b text,
  summary_a text,
  summary_b text,
  published_a timestamptz,
  published_b timestamptz,
  article_count_a integer,
  article_count_b integer,
  shared_stems integer,
  jaccard numeric
)
language sql stable security definer set search_path = ''
as $fn$
  with p as (
    select pg_catalog.now() as t_end,
           pg_catalog.now() - (least(greatest(coalesce(p_hours, 48), 1), 168) * interval '1 hour') as t_start,
           least(greatest(coalesce(p_limit, 50), 1), 100) as lim
  ),
  live as materialized (
    select c.id, c.title_tr, pg_catalog.left(c.summary_tr, 600) as summary, c.first_published, c.article_count
      from public.clusters c, p
     where c.first_published >= p.t_start
       and c.first_published <= p.t_end
       and not coalesce(c.is_archived, false)
       and c.merged_into is null
       and c.article_count >= 2
  ),
  stems as (
    select l.id, l.first_published, s.stem
      from live l
     cross join lateral (
       select distinct pg_catalog.left(w.word, 5) as stem
         from pg_catalog.regexp_split_to_table(
                public.tayf_search_fold(coalesce(l.title_tr, '')), '[^a-z0-9]+') as w(word)
        where pg_catalog.length(w.word) >= 4
     ) s
     where s.stem <> all (array[
             'acikl', 'dakik', 'canli', 'haber', 'gunde', 'video', 'izle', 'yeni', 'bugun', 'icin',
             'sonra', 'olara', 'kadar', 'nasil', 'nedir', 'bakan', 'cumhu', 'baska', 'oldu', 'etti',
             'ekim', 'mesaj', 'gorus', 'basla', 'genel']::text[])
  ),
  nstem as (
    select id, pg_catalog.count(*)::integer as n from stems group by id
  ),
  pairs as (
    select sa.id as a, sb.id as b, pg_catalog.count(*)::integer as shared
      from stems sa
      join stems sb
        on sb.stem = sa.stem
       and sb.id > sa.id
       and sb.first_published between sa.first_published - interval '6 hours'
                                  and sa.first_published + interval '6 hours'
     group by sa.id, sb.id
    having pg_catalog.count(*) >= 3
  )
  select pa.a as cluster_a,
         pa.b as cluster_b,
         la.title_tr as title_a,
         lb.title_tr as title_b,
         la.summary as summary_a,
         lb.summary as summary_b,
         la.first_published as published_a,
         lb.first_published as published_b,
         la.article_count as article_count_a,
         lb.article_count as article_count_b,
         pa.shared as shared_stems,
         pg_catalog.round(pa.shared::numeric / (na.n + nb.n - pa.shared), 4) as jaccard
    from pairs pa
    join nstem na on na.id = pa.a
    join nstem nb on nb.id = pa.b
    join live la on la.id = pa.a
    join live lb on lb.id = pa.b
   where pa.shared::numeric / (na.n + nb.n - pa.shared) >= 0.5
   order by pa.shared::numeric / (na.n + nb.n - pa.shared) desc,
            greatest(la.first_published, lb.first_published) desc,
            pa.a,
            pa.b
   limit (select lim from p)
$fn$;

comment on function public.admin_content_twin_pairs(integer, integer) is
  'Read-only first stage of the content-twin detector: live clusters opened at most '
  '6 hours apart whose seed titles share >= 3 word stems at a Jaccard >= 0.5 (generic '
  'stems excluded), with the summaries the app re-scores them with. p_hours is '
  'clamped to 1..168, p_limit to 1..100. Feeds Olası içerik ikizleri on '
  '/admin/birlestir, which never merges on its own. service_role only. Migration 139.';

revoke all on function public.admin_content_twin_pairs(integer, integer) from public, anon, authenticated;
grant execute on function public.admin_content_twin_pairs(integer, integer) to service_role;

insert into supabase_migrations.schema_migrations (version, name)
  values ('139', '139_content_twin_candidates')
  on conflict do nothing;

commit;
