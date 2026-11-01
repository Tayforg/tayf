-- 140_cluster_skip_log.sql
--
-- An audit trail for the cluster consumer's same-source-duplicate skip (h14-cluster-1,
-- the hotfix for #152's twin prevention). public.cluster_skip_log gets one row per
-- article the consumer skips instead of clustering: which article, which cluster
-- held its source, the match score, and the evidence that justified the skip.
-- Service role only; nothing is readable or writable from the browser.
--
-- WHY (evidence: production, read-only, 2026-11-01)
--   * #152 (18c54bc, deployed 17:40 UTC) made clusterArticle skip an article, instead of
--     opening a twin cluster, whenever the best cluster at MATCH_THRESHOLD or better
--     already holds the article's source. A skip is persisted nowhere: the article row is
--     untouched, there is no cluster_articles row, and the enqueue trigger (025) fires on
--     INSERT only, so a skipped article never comes back and never reaches a cluster page,
--     feed, search or RSS. The only trace was one function log line.
--   * That log shows exactly three skips since the deploy (query_logs):
--       17:46:02 article 312bce42-3145-47aa-84e7-35224a0b3935 cluster 609bdf18-a857-4ee1-
--                908a-bdd70ec4737e matchScore 0.849
--       18:19:03 article 11862382-c507-420f-99b2-937d379b811f cluster e952ca96-28e3-4c02-
--                a36c-999c88badfaf matchScore 0.406
--       18:22:02 article f4b82ef9-5044-4c28-bb04-e0a30379b032 cluster 609bdf18 matchScore 0.833
--     Two of the three were wrong. 312bce42 ("Muhbir filminin konusu ne? ...") and
--     f4b82ef9 ("Eller Yukarı filminin konusu ne? ...") are cumhuriyet film-plot articles
--     about two different films; cluster 609bdf18 is "Suikast Treni filminin konusu
--     nedir? ..." (cnn-turk 15:52, cumhuriyet 17:19). Cumhuriyet's shared description
--     template ("... filmi televizyon ekranlarında izleyicisiyle buluşmaya hazırlanıyor
--     ... İşte ayrıntılar...") drove the MinHash lane to 0.856 / 0.850; the headline lane
--     does not fire (4 shared stems, Jaccard 0.57 / 0.50). Both articles have no
--     cluster_articles row (select article_id from cluster_articles where article_id in
--     (the three ids) -> no rows). Before the deploy every "filminin konusu ne" article of Oct 25-31 got
--     a cluster (2/2, 3/3, 3/3, 4/4, 5/5, 3/3, 2/2); on 2026-11-01 only 2 of 4.
--   * The third skip (aksam 11862382 against the 38-article Seul cluster e952ca96) is a
--     same-trip duplicate by content, but nothing ties its headline to the aksam member
--     ("Seul'den davet: Başkan Erdoğan, Güney Kore'ye gidecek"): 4 shared stems of 12,
--     Jaccard 0.33, 7.25 hours apart (the lane window is 6). With the evidence gate it
--     opens a cluster again, as it did before #152.
--   The consumer change (supabase/functions/cluster-consumer/index.ts) takes the skip only
--   on strong evidence and writes every skip it still takes to this table, so a wrong
--   skip is visible in SQL and the article can be re-enqueued.
--
-- WHAT CHANGES (pinned by tests/migrations/140-cluster-skip-log.test.ts and
-- tests/guards/cluster-skip-evidence.test.ts)
--   1. public.cluster_skip_log (article_id uuid primary key references public.articles(id)
--      on delete cascade, cluster_id uuid not null, score real, reason text not null,
--      created_at timestamptz not null default now()). One row per article: the consumer
--      writes it with upsert ... on conflict (article_id) do nothing, so a re-delivered
--      message does not change the first record. There is deliberately NO foreign key on
--      cluster_id: clusters are merged away (merged_cluster_map, 116), and the audit row
--      must survive that. reason is 'same-source-duplicate/<evidence>' with evidence one
--      of fingerprint, exact-title, headline-lane.
--   2. An index on created_at (the operator reads the newest rows; no ORCHESTRATOR
--      PRE-BUILD step as in 101/127: the table is new and tiny, 136's reasoning).
--   3. RLS on, no policy. Every privilege of anon, authenticated and public is revoked, the
--      Supabase default grants of service_role are replaced by select + insert (no update,
--      delete, truncate, references, trigger), plus the PG17-guarded MAINTAIN revoke
--      (131's block, as in 136). Nothing is granted to anon or authenticated, so
--      tests/guards/anon-surface.test.ts is unaffected.
--   4. notify pgrst 'reload schema' (the Edge Function writes through PostgREST) and the
--      ledger row in the 095 pattern.
--   No function, no cron job, no data rewrite, no retention job: the volume is a few rows
--   a day (3 in the first six hours after #152; an estimated 2-10 a day), and the rows are
--   the evidence for the next review. The cascade removes a row when its article is
--   deleted.
--
-- STEP 0 (production, read-only, 2026-11-01, via SELECT only; nothing was applied)
--   a) Version 140 is free and 139 is applied:
--      select version from supabase_migrations.schema_migrations where version in
--      ('139','140') -> '139' only.
--   b) select to_regclass('public.cluster_skip_log') -> null (the table does not exist).
--   c) The three articles above and the members of clusters 609bdf18 and e952ca96 were read
--      by primary key (the public news text is the fixture of the h14-cluster-1 describe in
--      tests/functions/cluster-consumer.test.ts).
--
-- DRY RUNS (×2) (local PG15.12, throwaway cluster scratchpad/pg-al-w1 on port 55451,
-- 2026-11-01; the shared stub schema (jevtest/qa/stub.sql: roles anon, authenticated,
-- service_role, supabase_migrations.schema_migrations, public.sources/articles) plus,
-- added in a scratch setup and not in this file: usage on schema public for the three
-- roles, default privileges that mimic Supabase's pre-117 (all on tables and sequences
-- to anon, authenticated, service_role), the ledger row '139', two articles, and
-- `alter role service_role bypassrls` as Supabase has it). Each run was
-- psql -v ON_ERROR_STOP=1 -f 140_cluster_skip_log.sql:
--   run 1   BEGIN, SET, CREATE TABLE, CREATE INDEX, COMMENT, ALTER TABLE, REVOKE,
--           REVOKE, GRANT, DO, NOTIFY, INSERT 0 1, COMMIT
--   run 2   the same statements, no error; notices `relation "cluster_skip_log" already
--           exists, skipping` and `relation "cluster_skip_log_created_at_idx" already
--           exists, skipping`; the ledger insert is INSERT 0 0
--   After   ledger 139, 140 (140_cluster_skip_log); columns article_id uuid not null,
--           cluster_id uuid not null, score real, reason text not null, created_at
--           timestamptz not null default now(); constraints cluster_skip_log_pkey
--           (article_id) and cluster_skip_log_article_id_fkey FOREIGN KEY (article_id)
--           REFERENCES articles(id) ON DELETE CASCADE, nothing else (cluster_id is
--           not null and has no other constraint); indexes cluster_skip_log_pkey and
--           cluster_skip_log_created_at_idx; relrowsecurity t, no policy; relacl
--           {postgres=arwdDxt/postgres,service_role=ar/postgres}.
--   Grants  has_table_privilege: anon and authenticated false for select, insert, update,
--           delete, truncate, references and trigger; service_role true for select and
--           insert only. As anon and as authenticated: select, insert and insert ... on
--           conflict do nothing all fail with `permission denied for table
--           cluster_skip_log`. As service_role: insert ... on conflict (article_id) do
--           nothing -> INSERT 0 1, the same article again with another score and reason
--           -> INSERT 0 0 (the first row stays: 0.87, exact-title); a cluster_id that
--           matches no cluster is accepted (no foreign key); a null cluster_id is
--           refused (not-null violation); update, delete and truncate fail with
--           `permission denied for table cluster_skip_log`.
--   Cascade two rows, remove one article: DELETE 1, one row left (the other article's).
--   The PG17 branch of the MAINTAIN block cannot run on PG15 (the guard skips it); it is
--   131's / 136's block, which the test pins character for character, and 136 is live on
--   PG 17.6.
--   Test counts: tests/migrations/140-cluster-skip-log.test.ts passes statically; with
--   TAYF_PSQL pointing at this database its live block passes too (see the file).
--
-- DEPLOY: APPLY 140, THEN DEPLOY THE EDGE FUNCTION
--   1. Apply this file (docs/migration-guide.md, operator). It takes a brief SHARE ROW
--      EXCLUSIVE lock on public.articles (the foreign key) under lock_timeout = '5s': if
--      the table is busy the statement fails fast and rolls back; run it again.
--   2. Deploy cluster-consumer: supabase functions deploy cluster-consumer --no-verify-jwt.
--      Deploying the function BEFORE the migration is safe: the skip-log write is
--      best-effort, a missing table makes it warn once per isolate
--      (`[cluster-consumer] cluster_skip_log insert failed, continuing: ...`) and the
--      skips still happen.
--   3. Optional, with the user's approval and not part of this change: re-enqueue
--      312bce42 and f4b82ef9 through the public pgmq wrapper (029) so they get clusters.
--
-- VERIFY (read-only):
--   select to_regclass('public.cluster_skip_log');                       -- expect the table
--   select relrowsecurity from pg_class where oid = 'public.cluster_skip_log'::regclass;  -- t
--   select has_table_privilege('anon', 'public.cluster_skip_log', 'select'),
--          has_table_privilege('authenticated', 'public.cluster_skip_log', 'insert'),
--          has_table_privilege('service_role', 'public.cluster_skip_log', 'insert'),
--          has_table_privilege('service_role', 'public.cluster_skip_log', 'update');
--      -- expect f, f, t, f
--   select article_id, cluster_id, score, reason, created_at from public.cluster_skip_log
--    order by created_at desc limit 20;
--      -- after the function deploy: one row per live skip, reason
--      -- same-source-duplicate/{fingerprint,exact-title,headline-lane}; an article that
--      -- was dropped wrongly shows up here with its cluster id and score
--
-- ROLLBACK (nothing else depends on 140; run by the operator)
--   drop table public.cluster_skip_log;
--   delete from supabase_migrations.schema_migrations where version = '140';   -- ledger row 140
--   The consumer tolerates the missing table (one warning per isolate); revert the function
--   only if you want the warning gone.
--
-- Additive. Safe to re-apply (create table / index if not exists, ledger insert on conflict
-- do nothing; the revokes, the grant and the RLS switch are idempotent). One transaction;
-- no ALTER of an existing object, no data rewrite. The only lock of note is the brief SHARE
-- ROW EXCLUSIVE on public.articles that the new foreign key takes (bounded by lock_timeout).
-- No CONCURRENTLY step, no function, no grant to anon or authenticated.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. public.cluster_skip_log: one row per article the consumer skipped.
-- ---------------------------------------------------------------------------

create table if not exists public.cluster_skip_log (
  article_id uuid primary key references public.articles(id) on delete cascade,
  cluster_id uuid not null,   -- no FK: a cluster can be merged away, the audit row must survive
  score real,
  reason text not null,
  created_at timestamptz not null default now()
);

create index if not exists cluster_skip_log_created_at_idx
  on public.cluster_skip_log (created_at);

comment on table public.cluster_skip_log is
  'One row per article the cluster consumer skipped as a same-source duplicate '
  'instead of clustering it (cluster-consumer, h14-cluster-1): the cluster that '
  'held the article''s source, the match score, and reason = '
  '''same-source-duplicate/<evidence>'' with evidence fingerprint, exact-title or '
  'headline-lane. Written best-effort by the Edge Function (service role, upsert '
  'on conflict do nothing); never in a dry run. cluster_id has no foreign key so '
  'the row survives a cluster merge. service_role only (migration 140).';

alter table public.cluster_skip_log enable row level security;

-- Supabase default privileges hand new tables to anon/authenticated (incl.
-- write privileges, cf. 091/095) and to service_role (all): strip them, then
-- give service_role back exactly what the Edge Function and the operator need.
revoke all on public.cluster_skip_log from anon, authenticated, public;
revoke all on public.cluster_skip_log from service_role;
grant select, insert on public.cluster_skip_log to service_role;

-- PG17 added the MAINTAIN privilege; it does not exist before PG17 (revoking it
-- would be a syntax error), so guard.
do $maint$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on public.cluster_skip_log from anon, authenticated';
  end if;
end
$maint$;

-- 2. Schema cache and ledger ----------------------------------------------------

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('140', '140_cluster_skip_log')
  on conflict do nothing;

commit;
