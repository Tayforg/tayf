-- 121_cluster_link_recompute.sql
--
-- cluster_link_atomic stops trusting the caller's aggregates. Since 027 the
-- function locks the cluster, inserts the member and recounts article_count, but
-- it writes bias_distribution, is_blindspot, blindspot_side and first_published
-- exactly as the cluster-consumer Edge Function sent them, and the consumer
-- builds them from a member snapshot it reads BEFORE the lock
-- (supabase/functions/cluster-consumer/index.ts, addArticle). Two links into one
-- cluster at the same time therefore both write a snapshot that lacks the
-- other's article, and the later writer erases the earlier writer's vote.
-- 121 recomputes the aggregates inside the lock by delegating to
-- cluster_unlink_article(cluster, null) (064), the canonical SQL recompute that
-- 099 already uses for the same purpose.
--
-- WHY (evidence: production, read-only, 2026-10-24 16:40 UTC)
--   The lost update is visible in the data. Of 9,205 live clusters (not
--   archived, not merged, at least two members, updated in the last 30 days),
--   exactly two carry a stored bias_distribution that differs from the
--   distribution recomputed from their own members (the DRIFT QUERY below):
--     52823177-3a62-4b56-8312-18cd3f07b53e  stored   center 1, gov_leaning 1,
--                                                    opposition_leaning 1
--                                           members  center 2, gov_leaning 1,
--                                                    opposition_leaning 1
--     e0c1324a-c47e-4952-beed-c37f858a15e3  stored   opposition_leaning 3
--                                           members  opposition 1,
--                                                    opposition_leaning 3
--   In both the stored distribution is missing one member's vote while
--   article_count (which 027 recounts under the lock) is right. That is the
--   signature of two concurrent links: A reads members [m1], B reads members
--   [m1], A links a2 and writes {m1, a2}, B waits on the lock, links b2 and
--   writes {m1, b2}: a2's vote is gone. The next link would recompute from a
--   fresh snapshot and repair it, but a cluster that stops receiving links keeps
--   the wrong distribution for good. A wrong distribution decides is_blindspot
--   and what the bias bar shows, so a lost vote can hide a blindspot or invent
--   one.
--   Why the fix lives in SQL and not in the consumer: the consumer cannot read
--   the members under the lock (that is a separate round trip, and the gap
--   between the read and the RPC is the bug), so only the function can see the
--   committed state of the transaction that held the lock before it. A SQL-only
--   change also fixes every consumer version already deployed, and this wave does
--   not touch supabase/functions.
--   Why delegate to cluster_unlink_article instead of copying its formula: it is
--   the counting definition production already runs for unlink and merge (064,
--   099): one vote per ARTICLE, voting source kinds outlet and wire only, ten
--   keys with zeros, blindspot at five voting articles and a 0.8 zone share
--   (BLINDSPOT in supabase/functions/_shared/cluster/blindspot.ts, pinned by
--   tests/migrations/zone-parity.test.ts). Nothing about what counts changes, and
--   there is no second copy of the formula to keep in sync. The consumer's own
--   count is also per article (buildBiasDistribution over votingBiasKeys).
--
-- WHAT CHANGES (pinned by tests/migrations/121-cluster-link-recompute.test.ts)
--   1. public.cluster_link_atomic(uuid, uuid, jsonb, boolean, text, timestamptz)
--      is re-created with create or replace function. There is NO drop function:
--      a drop strips the grants and breaks consumer calls that are in flight,
--      while create or replace keeps the function's OID and its ACL. Signature,
--      language plpgsql, security definer, set search_path = '' and VOLATILE (the
--      default) are 027's: every statement has to see the insert that the
--      previous holder of the lock committed, so the function must not be
--      stable or immutable.
--   2. The body: 027's advisory lock, byte for byte; then a row lock on the
--      cluster (perform 1 from public.clusters c where c.id = p_cluster_id for
--      update); then 027's idempotent insert and get diagnostics, byte for byte;
--      then perform public.cluster_unlink_article(p_cluster_id, null); then
--      return v_inserted_rows > 0. The null article id deletes nothing and
--      matches no jev_unlink_candidates row, so the call is a pure recompute
--      (article_count, bias_distribution, is_blindspot, blindspot_side,
--      first_published = min(member published_at), updated_at = now(); the last
--      one is still the /api/health liveness signal). The recompute takes the
--      advisory lock a second time, which the same transaction already holds.
--      Lock order is advisory lock first, then FOR UPDATE on clusters, the order
--      099's merge takes, so the two cannot deadlock.
--   3. The four aggregate parameters stay in the signature and are deliberately
--      not read: the Edge Function keeps sending them and they are ignored. A
--      comment in the body says so; the test pins that the body contains none
--      of the four names and no update of clusters.
--   4. The function comment is rewritten for 121; revoke execute from anon,
--      authenticated and public, grant execute to service_role (the same single
--      grant as 027); the ledger row in the 095 pattern.
--   This file creates no table, adds no grant other than that one, deletes
--   nothing, schedules nothing and backfills nothing. It starts with set local
--   lock_timeout = '5s'.
--
-- STEP 0 (production, read-only, 2026-10-24 16:40 UTC, via SELECT only; nothing
-- was applied)
--   a) Version 121 is free: the ledger holds '119' and '120' as its newest
--      three-digit versions and no '121' or '122' (the 2026... timestamp
--      versions in the same list are the dashboard's own).
--   b) The deployed bodies, compared by md5(prosrc) with the text between the
--      function quotes of the migration files:
--        cluster_unlink_article(uuid, uuid): 7068567690bc483ee0941c47a503428f
--          (5,899 characters) = the text between the two fn quotes of
--          064_jev_cluster_live.sql. Match.
--        ops_health_report(): c99eb293f647eb4706c420e1613020f7 (17,050
--          characters) = 119's. Match.
--        cluster_link_atomic(...): 4e49f91c587689f631e1f1742a56f15d (801
--          characters). 027's text between its two dollar quotes is
--          55ffcfb19969b99c930571ef6489bffe (1,748 characters), so the raw md5
--          DIFFERS. The difference is comments only: after removing the
--          -- comments and collapsing whitespace both texts are the same 684
--          characters, md5 abb89ca8afb3aa7934da99cee72944dc. The deployed
--          function is 027's executable text with its comments stripped (it was
--          evidently applied from a comment-free copy), so there is no unknown
--          logic and nothing that 121 or its rollback would lose. The statement order, the
--          lock, the insert and the final update are 027's.
--      All three: security definer, volatile, proconfig search_path = "", acl
--      {postgres=X/postgres, service_role=X/postgres} (service_role only).
--   c) cron.job: 'ingest-drain' is active, schedule '*/3 * * * *' (not needed by
--      121; recorded because 122 depends on it). The command column was not
--      selected.
--   d) (122's gap baseline is in 122_ops_ingest_gaps.sql.)
--   e) The DRIFT QUERY below returns 2 rows (the two clusters under WHY).
--
-- DRY RUNS (×2) (local PG15.12, throwaway cluster, 2026-10-24; the shared stub
-- schema plus, added in a scratch setup and not in this file: default privileges
-- that mimic Supabase's and a revoke that mimics 117 (anon and authenticated hold
-- no table privilege), the sources fetch_* columns, articles.created_at,
-- clusters.merged_into, ingest_cycles per 039). 027, the jev_unlink_candidates
-- table and cluster_unlink_article of 064, 114, 115 and 119 were applied first,
-- then this file twice in a row, each with psql -v ON_ERROR_STOP=1 -f:
--   run 1   BEGIN, SET, CREATE FUNCTION, COMMENT, REVOKE, GRANT, INSERT 0 1, COMMIT
--   run 2   the same statements, no error, no notice; the ledger insert is INSERT 0 0
--   After   ledger 114, 115, 119, 121; md5(prosrc) of cluster_link_atomic is
--           fb81251b45dd50907160832f6f84db0c (2,006 characters, the text between
--           the two dollar quotes of this file).
--   Grants  has_function_privilege execute is false for anon and authenticated
--           and true for service_role (acl {postgres=X/postgres,
--           service_role=X/postgres}); security definer, volatile,
--           search_path = "". The mimicked default privileges had granted execute
--           to anon and authenticated on creation, as Supabase does; 027's revoke
--           had stripped them and 121 keeps them stripped.
--   Fixtures (the TAYF_PSQL block of the test, inside rolled-back transactions)
--           (a) two voting members (outlet center, outlet opposition), then an
--           aggregator article linked with p_bias_distribution {"center":99},
--           p_is_blindspot true, p_blindspot_side 'center' and
--           p_first_published 2100-01-01: returns true, article_count 3, all ten
--           keys present with center 1, opposition 1 and the rest 0 (the starting
--           aggregate {"center":7} is healed on the first link), is_blindspot
--           false, blindspot_side null, first_published = the earliest member,
--           updated_at stamped. (b) the same call again returns false and every
--           aggregate is unchanged whatever the caller passes. (c) three
--           pro_government + two gov_leaning voting articles: four links give no
--           blindspot, the fifth gives is_blindspot true and blindspot_side
--           'pro_government'. (d) two articles of one source both count
--           (center 2): the article-level definition is kept.
--           Mutation check: with 027's body re-applied 7 live tests fail (the
--           ledger/prosrc probe and every assertion of (a)-(d) that depends on
--           the recompute), with 121 re-applied they pass.
--   Concurrent replay (two psql sessions on the committed scratch fixture:
--           cluster c1 with member a1 (center), articles a2 (opposition) and a3
--           (pro_government); A links a2 in an open transaction with the
--           consumer's snapshot {center 1, opposition 1} and holds the lock for
--           3 s; B starts 1 s later and links a3 with the snapshot
--           {center 1, pro_government 1}, which does not contain a2):
--             027's body:  B blocks until A commits, then writes its stale
--                          snapshot. Result: article_count 3, distribution
--                          center 1, pro_government 1 (a2's opposition vote lost).
--             121:         B blocks until A commits (A committed at :12.218, B
--                          returned at :12.220), then recomputes. Result:
--                          article_count 3, distribution center 1, opposition 1,
--                          pro_government 1 (both counted).
--   Drift rehearsal  with the cluster's distribution made stale on purpose, the
--           DRIFT QUERY returned that cluster (1 row); select
--           public.cluster_unlink_article(id, null) returned its article_count
--           (3) and the query then returned 0 rows.
--   Rollback rehearsed: 027's create or replace block re-applied with its
--           comment, revoke and grant (md5(prosrc) back to
--           55ffcfb19969b99c930571ef6489bffe, 1,748 characters; anon and
--           authenticated still cannot execute), ledger row 121 removed (DELETE 1),
--           then this file twice more: INSERT 0 1, then INSERT 0 0.
--
-- DEPLOY: APPLY 121 ONLY, NOTHING TO DEPLOY
--   Apply this file. Every link from the next call on recomputes under the lock.
--   The cluster-consumer Edge Function needs no change and no redeploy: it keeps
--   building and sending its four aggregates, which are now ignored. Its member
--   snapshot read in addArticle becomes dead weight and can be removed in a later,
--   separate change (this migration works with both the old and the new
--   consumer). The cost of a link is one extra member join (the same rows the
--   consumer already read) plus the row lock on the cluster; links to different
--   clusters still run in parallel.
--   Verify (read-only):
--     select md5(prosrc), length(prosrc), prosecdef, provolatile, proconfig
--       from pg_proc
--      where oid = 'public.cluster_link_atomic(uuid,uuid,jsonb,boolean,text,timestamptz)'::regprocedure;
--       -- expect fb81251b45dd50907160832f6f84db0c, 2006, t, v, {"search_path=\"\""}
--     select has_function_privilege('anon', 'public.cluster_link_atomic(uuid,uuid,jsonb,boolean,text,timestamptz)', 'execute'),
--            has_function_privilege('authenticated', 'public.cluster_link_atomic(uuid,uuid,jsonb,boolean,text,timestamptz)', 'execute'),
--            has_function_privilege('service_role', 'public.cluster_link_atomic(uuid,uuid,jsonb,boolean,text,timestamptz)', 'execute');
--       -- expect f, f, t
--   The two drifted clusters are NOT repaired by the apply (nothing backfills):
--   they heal on their next link, or by the optional repair below.
--
-- DRIFT QUERY (read-only; rows = live clusters whose stored distribution differs
-- from the one recomputed from their members, non-zero keys compared)
--   with live as (select c.id, c.bias_distribution from public.clusters c where not c.is_archived and c.merged_into is null and c.article_count >= 2 and c.updated_at >= now() - interval '30 days'),
--   votes as (select l.id, s.bias, count(*)::int n from live l join public.cluster_articles ca on ca.cluster_id = l.id join public.articles a on a.id = ca.article_id join public.sources s on s.id = a.source_id where s.kind in ('outlet','wire') group by l.id, s.bias),
--   rec as (select l.id, coalesce(jsonb_object_agg(v.bias, v.n) filter (where v.bias is not null), '{}'::jsonb) d from live l left join votes v on v.id = l.id group by l.id),
--   sto as (select l.id, coalesce((select jsonb_object_agg(e.key, (e.value)::int) from jsonb_each_text(l.bias_distribution) e where (e.value)::int > 0), '{}'::jsonb) d from live l)
--   select sto.id, sto.d stored_nonzero, rec.d recomputed_nonzero from sto join rec using (id) where sto.d <> rec.d order by 1;
--   OPTIONAL OPERATOR REPAIR, not run by us and not part of this file: for each
--   id the query returns, run select public.cluster_unlink_article(id, null);
--   (service_role). It recomputes that cluster from its members. Note that it
--   stamps updated_at = now(); if the old value matters, read it first and restore
--   it afterwards the way 099 does for a merge:
--   update public.clusters set updated_at = '<the value read before>' where id = '<id>';
--
-- ROLLBACK (nothing else depends on 121)
--   re-apply the create or replace function block of 027_cluster_link_atomic.sql
--     for cluster_link_atomic (from "create function" to the end of its grant
--     statement, with "create function" written as "create or replace function";
--     do not run its "drop function if exists" line), with its comment, revoke and
--     grant;
--   then remove ledger row 121 (run by the operator):
--     delete from supabase_migrations.schema_migrations where version = '121';
--   The clusters written while 121 was live keep their correct aggregates.
--
-- Additive. Safe to re-apply (create or replace function, ledger insert on
-- conflict do nothing). One transaction; the only lock of note is the catalog
-- lock create or replace function takes on this one function, bounded by
-- lock_timeout = 5 s: on 55P03 nothing is recorded, re-apply. No CONCURRENTLY
-- step, no cron change, no new table, no new grant.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- cluster_link_atomic: 027's lock and insert, then the aggregates are
-- recomputed from the member rows under the lock. create or replace keeps the
-- function's OID and therefore its grants, and keeps in-flight consumer calls
-- working; the signature is unchanged. VOLATILE (the default) on purpose: every
-- statement has to see the insert the previous lock holder committed.
-- ---------------------------------------------------------------------------

create or replace function public.cluster_link_atomic(
  p_cluster_id uuid,
  p_article_id uuid,
  p_bias_distribution jsonb,
  p_is_blindspot boolean,
  p_blindspot_side text,
  p_first_published timestamptz
) returns boolean
language plpgsql
security definer
-- Mirror the Round-6 P1 hardening on the migration-025 trigger
-- functions: empty search_path + schema-qualified identifiers so a
-- session role with CREATE on pg_temp cannot shadow an unqualified
-- call inside this SECURITY DEFINER body.
set search_path = ''
as $$
declare
  v_inserted_rows int;
begin
  -- p_bias_distribution, p_is_blindspot, p_blindspot_side and
  -- p_first_published are kept for signature compatibility (the
  -- cluster-consumer Edge Function still sends them) and are deliberately
  -- not read: the caller built them from a member snapshot it read BEFORE this
  -- lock, so a concurrent link made them stale and the later writer erased the
  -- earlier writer's vote. The aggregates are recomputed below from the rows.

  -- Per-cluster serialization (027, unchanged). `hashtext` is stable enough
  -- that two requests for the same cluster_id always collide on the same lock
  -- key, and collisions between different cluster_ids only cost a transient
  -- wait, never correctness. cluster_unlink_article (064) and cluster_merge
  -- (099) take the same key.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_cluster_id::text)
  );

  -- Row lock on the cluster, taken after the advisory lock like 099's merge
  -- (advisory locks first, then FOR UPDATE), so the two cannot deadlock.
  perform 1 from public.clusters c where c.id = p_cluster_id for update;

  -- Idempotent link insert. ON CONFLICT DO NOTHING leans on the
  -- (cluster_id, article_id) PRIMARY KEY from migration 003.
  insert into public.cluster_articles (cluster_id, article_id)
       values (p_cluster_id, p_article_id)
  on conflict do nothing;
  get diagnostics v_inserted_rows = row_count;

  -- The canonical recompute (064): article_count, bias_distribution over the
  -- voting kinds (one vote per article), is_blindspot / blindspot_side,
  -- first_published = min(member published_at), and updated_at = now(), which
  -- is the /api/health liveness signal. The null article id deletes nothing and
  -- matches no jev_unlink_candidates row; 099 calls it the same way. It takes
  -- the advisory lock again, which the same transaction already holds.
  perform public.cluster_unlink_article(p_cluster_id, null);

  return v_inserted_rows > 0;
end;
$$;

comment on function public.cluster_link_atomic(
  uuid, uuid, jsonb, boolean, text, timestamptz
) is
  'Atomic per-cluster cluster_articles insert + clusters recompute (migrations 027, 121). '
  'Serialized via pg_advisory_xact_lock(hashtext(cluster_id::text)) and a row lock on the cluster. '
  'Inserts the link (idempotent on the primary key), then recomputes article_count, bias_distribution, '
  'is_blindspot, blindspot_side and first_published from the member rows by calling '
  'cluster_unlink_article(cluster_id, null) under the same lock. Since 121 the four aggregate '
  'arguments are ignored (kept for signature compatibility; the Edge Function still sends them), so '
  'concurrent links can no longer overwrite each other''s votes with a stale snapshot. '
  'Returns true if a new link was inserted, false if the article was already a member. '
  'Sets clusters.updated_at to now(), the /api/health liveness signal, not member published_at. '
  'service_role only.';

revoke execute on function public.cluster_link_atomic(uuid, uuid, jsonb, boolean, text, timestamptz)
  from anon, authenticated, public;
grant execute on function public.cluster_link_atomic(uuid, uuid, jsonb, boolean, text, timestamptz)
  to service_role;

-- Ledger ---------------------------------------------------------------------------

insert into supabase_migrations.schema_migrations (version, name)
  values ('121', '121_cluster_link_recompute')
  on conflict do nothing;

commit;
