-- 128_delete_source_recompute.sql
--
-- delete_source: delete a source AND recompute the clusters it leaves behind.
-- POST /api/admin {action: "delete_source"} used to be a bare
-- `.from("sources").delete().eq("id", id)`. The foreign keys cascade
-- (sources -> articles -> cluster_articles, confdeltype 'c', see STEP 0), so
-- the source's articles vanished from every cluster they sat in, but nothing
-- recomputed those clusters: article_count, bias_distribution, is_blindspot,
-- blindspot_side and first_published kept describing members that no longer
-- exist, and no cache was revalidated. 128 adds a SECURITY DEFINER function that
-- deletes the source and then recomputes every affected cluster by calling 064's
-- cluster_unlink_article(cluster, null), the canonical recompute that 121
-- (cluster_link_atomic) and 099 (cluster_merge_atomic) already use. The route
-- calls it as an RPC and revalidates the returned cluster ids.
--
-- WHY (h8-admin-1, hunt 8, 2026-11-01)
--   A source delete is rare and deliberate (an outlet removed from the registry),
--   but when it happens every cluster it touched is wrong in a way readers see:
--   a "kör nokta" (blindspot) verdict that rested on the deleted outlet stays
--   on, the bias bar still counts its votes, article_count is too high and
--   first_published can point at an article that no longer exists. Nothing
--   repairs it: the next link into the cluster would, but a cluster that stops
--   receiving links keeps the stale numbers for good.
--   Why in SQL and not in the route: the delete and the recompute must be one
--   transaction, under the same per-cluster advisory lock cluster_link_atomic
--   and cluster_unlink_article take (key hashtext(cluster_id::text)), so a
--   concurrent link cannot interleave between them. A route doing delete, then N
--   RPC calls over HTTP, would not be atomic and would race the consumer.
--   Why delegate to cluster_unlink_article instead of copying its formula: it is
--   the counting definition production already runs (one vote per article,
--   voting source kinds outlet and wire only, ten keys with zeros, blindspot at
--   five voting articles and a 0.8 zone share); no second copy to keep in sync,
--   and zone-parity.test.ts keeps counting exactly the copies it knows.
--   Why updated_at is RESTORED: cluster_unlink_article ends with
--   updated_at = now(), and updated_at is what the home feed sorts its
--   candidate window by (politics-query: is_archived = false, article_count >= 2,
--   order by updated_at desc, limit 200), as do the blindspot, near-blindspot and
--   topic lists, the headline-pick cron and /api/v1/clusters' `updated since`
--   filter. A source delete is not news, exactly like the merge 099 handles in its
--   step 10 ("A merge is not news: restore updated_at"). Measured in production
--   (read-only, 2026-11-01): the largest source under the 2000 cap sits in 1,996
--   clusters, 1,201 of them active with article_count >= 2; one delete would have
--   moved all of them to updated_at = now(), filled the 200-row window with old
--   stories (which then decay on first_published in scoring) and pushed the
--   genuinely fresh clusters out of the home feed until each got another article.
--   So the function snapshots updated_at after taking the advisory locks, lets the
--   recompute stamp, and writes the snapshot back. The restore only sets a value a
--   row already had, so MAX(updated_at), which /api/health reads, never rises.
--   Trade-off, accepted: a consumer polling /api/v1/clusters for `updated since`
--   does not see the recomputed aggregates of these clusters (the route revalidates
--   every cache tag, so readers of the site do).
--
-- WHAT CHANGES (pinned by tests/migrations/128-delete-source-recompute.test.ts)
--   1. public.delete_source(p_source_id uuid) returns uuid[] is created with
--      create or replace function: language plpgsql, security definer,
--      set search_path = '', volatile. Every catalog call is pg_catalog-
--      qualified, every relation public-qualified.
--   2. Body, in this order: (i) row lock on the source (select ... for update);
--      (ii) not found -> return null; (iii) collect the distinct clusters its
--      articles sit in, sorted by id; (iv) refuse more than 2000 clusters with
--      errcode 54000; (v) take the per-cluster advisory locks in that id order;
--      (vi) snapshot those clusters' updated_at; (vii) the ONE delete, on
--      public.sources (the foreign keys cascade it to articles and
--      cluster_articles); (viii) cluster_unlink_article(cluster, null) for each
--      collected cluster; (ix) RESTORE updated_at from the snapshot (the one
--      update: it sets updated_at and nothing else); (x) return the ids.
--   3. revoke all from public, anon, authenticated; grant execute to
--      service_role (the only caller is POST /api/admin behind
--      hasAdminSession()); a comment on the function; the ledger row.
--   This file creates no table, no index and no trigger, drops nothing, alters
--   nothing, schedules nothing and backfills nothing. It starts with set local
--   lock_timeout = '5s'. Empty clusters (article_count 0) are NOT deleted or
--   archived here: the singleton semantics of 064 apply (the row survives with
--   its old first_published) and the existing prune handles them.
--
-- RETURN CONTRACT
--   NULL     no such source (nothing was changed). The route answers 404.
--   '{}'     the source was deleted and sat in no cluster.
--   {ids}    the source was deleted; these clusters (sorted, distinct) were
--            recomputed. The route revalidates the cluster-list tags and
--            cluster-detail:<id> for each.
--   errors   54000 (program_limit_exceeded) when more than 2000 clusters are
--            affected; 23503 if a future foreign key to sources or articles is
--            ON DELETE RESTRICT / NO ACTION; anything else is a failure. Any
--            error rolls the whole call back: no partial delete.
--
-- LOCK ORDER (why this cannot deadlock with cluster_link_atomic or cluster_merge)
--   The source row first (FOR UPDATE), then the advisory locks in uuid order,
--   then, inside the delete, the cascade's row locks on articles and
--   cluster_articles, then clusters' row locks inside cluster_unlink_article.
--   - cluster_link_atomic (027, 121) and cluster_unlink_article (064) take one
--     advisory lock and then touch cluster rows; cluster_merge_atomic (099) takes
--     two advisory locks in least/greatest uuid order and then FOR UPDATE on
--     clusters. delete_source takes its advisory locks in the same sorted uuid
--     order, which is the global order the merge already uses, and every function
--     takes advisory locks before any cluster row lock, so there is no cycle.
--   - FOR UPDATE on the source row conflicts with the FOR KEY SHARE an article
--     INSERT takes on its source (the foreign key check), so a new article for
--     the source waits until this transaction commits and then fails its foreign
--     key (the ingest handles that). Nothing can add articles to the source
--     while it is being deleted.
--   - Known residual race (documented, not closed): an EXISTING article of the
--     source that cluster_link_atomic links into a cluster outside the collected
--     set between the collection query and the cascade. The cascade then waits
--     for that link to commit, removes the new cluster_articles row, and that
--     cluster is not recomputed. The window is the few milliseconds between two
--     statements and needs an article to be clustered the moment its source is
--     deleted; the effect is one stale cluster until its next link. Closing it
--     would need a second collection after the delete, which the cascade makes
--     unobservable.
--
-- THE 2000 CAP (lock table, statement_timeout)
--   pg_advisory_xact_lock locks live in the shared lock table until commit, so
--   one call holds one slot per affected cluster. Production has
--   max_locks_per_transaction = 64 and max_connections = 60 (no prepared
--   transactions): about 3,840 slots in the whole instance, so 2000 locks is
--   already over half of it. 2000 is the ceiling this migration accepts; a
--   source above it is refused with 54000 BEFORE anything is locked or deleted,
--   and the operator deactivates the source (update_source active = false or
--   toggle_source) or deletes it in SQL in batches.
--   statement_timeout: PostgREST connects as authenticator, whose
--   statement_timeout is 8 s (see 063), and a function-level SET cannot re-arm
--   a timer that is already running, so the call is bounded by 8 s. A delete
--   that needs longer (the cascade of a big source, then up to 2000 recomputes;
--   one recompute's vote query measured 0.74 ms for a 19-member cluster in
--   production, EXPLAIN ANALYZE) fails with 57014, the whole transaction rolls
--   back and nothing changes. That is the safe failure; the route answers 500.
--   The cap is a conservative bound, not a promise that 2000 clusters fit in 8 s.
--   A refused call is cheap: the collection query for the busiest source (67,079
--   clusters) ran in 1.0 s in production (EXPLAIN ANALYZE, SELECT only), and the
--   call stops there, before any advisory lock is taken or any row deleted.
--
-- STEP 0 (production, read-only, 2026-11-01, via SELECT only; nothing was applied)
--   a) Every foreign key referencing public.sources or public.articles:
--        select conname, conrelid::regclass, confrelid::regclass, confdeltype
--          from pg_constraint where contype = 'f'
--           and confrelid in ('public.sources'::regclass, 'public.articles'::regclass);
--      20 rows. confdeltype is 'c' (cascade) for 19 of them: article_tickers,
--      article_title_versions, cluster_articles, framing_candidate_pool,
--      framing_votes, jev_gold_set, jev_politics_admissions,
--      jev_shadow_predictions, jev_unlink_candidates, legal_notice_articles and
--      zone_guesses (article_id), and article_title_versions, articles,
--      source_clickbait_daily, source_drift_daily, source_karne_30d,
--      source_reliability_30d, story_stances and zone_guesses (source_id). The
--      twentieth, source_zone_history_source_id_fkey, is 'n' (set null).
--      No row is 'a' (no action) or 'r' (restrict), so today the delete cannot
--      raise 23503. The route still maps 23503 to 409 for a future restrict key.
--   b) The largest number of distinct clusters a source touches:
--        select a.source_id, count(distinct ca.cluster_id)
--          from public.cluster_articles ca join public.articles a on a.id = ca.article_id
--         group by 1 order by 2 desc limit 5;
--      67,079 (9236e05a), 14,056 (85c2fda2), 10,010 (0d4ef059), 9,954 (0b2d8a03),
--      9,063 (bacd122c). Of 144 sources, 111 sit in at least one cluster; the
--      median is 1,993 clusters, 57 are within the 2000 cap and 54 are above it.
--      So the cap refuses the 54 busiest sources: for those the answer is
--      deactivate, or delete in SQL in batches (the query ran in 6 s).
--   c) md5(prosrc) of cluster_unlink_article(uuid, uuid) is
--      7068567690bc483ee0941c47a503428f (5,899 characters), the text between the
--      two fn quotes of 064_jev_cluster_live.sql (tests/migrations/128 recomputes
--      it from the file). security definer, volatile, search_path = "".
--   d) Version 128 is free in supabase_migrations.schema_migrations (the newest
--      three-digit versions are 120 to 126). 127 belongs to another change of the
--      same wave; 128 does not depend on it.
--   e) pg_trigger on sources, articles and cluster_articles: the two
--      sources_zone_history triggers, articles_cluster_enqueue,
--      articles_image_enqueue and articles_resolve_tickers; none fires on delete
--      in a way that touches clusters.
--
-- DRY RUNS (×2) (local PG15.12, throwaway cluster, 2026-11-01; the shared stub
-- schema plus, added in a scratch setup and not in this file: default privileges
-- that mimic Supabase's (execute on functions granted to anon and authenticated
-- on creation), articles_source_id_fkey and cluster_articles_article_id_fkey
-- recreated ON DELETE CASCADE as in production (STEP 0 a), a minimal
-- jev_unlink_candidates table, and 064's cluster_unlink_article block with its
-- revoke and grant: md5(prosrc) 7068567690bc483ee0941c47a503428f, 5,899
-- characters, identical to production). This file was then applied twice in a
-- row, each with psql -v ON_ERROR_STOP=1 -f:
--   run 1   BEGIN, SET, CREATE FUNCTION, COMMENT, REVOKE, GRANT, INSERT 0 1, COMMIT
--   run 2   the same statements, no error, no notice; the ledger insert is INSERT 0 0
--   After   ledger 128 (128_delete_source_recompute); md5(prosrc) of delete_source
--           5aa70873992b1a3ef97b0221584bf8b6 (4,116 characters, the text between the
--           two fn quotes of this file; the test recomputes it); security definer,
--           volatile, proconfig {"search_path=\"\""}; acl {postgres=X/postgres,
--           service_role=X/postgres}. The mimicked default privileges had granted
--           execute to anon and authenticated on creation; the revoke stripped them.
--           has_function_privilege execute: anon f, authenticated f, service_role t.
--   Scenario (rolled-back transactions; the TAYF_PSQL block of the test runs the
--           same cases):
--           (a) S1 (outlet, pro_government) with articles S1a, S1b, S1c; S2 (outlet,
--           opposition) with S2a, S2b. C1 = S1a, S1b, S2a (stale: pro_government 2,
--           opposition 1, article_count 3), C2 = S1c, C3 = S2b.
--           The fixtures carry old updated_at values on purpose: C1 and C3
--           2000-01-01 00:00:00, C2 2001-02-03 04:05:06 (a different value, so the
--           restore is shown to put each row's own value back).
--           select public.delete_source(S1) returned {C1,C2} in uuid order. Then C1:
--           article_count 1, all ten keys present (opposition 1, the rest 0),
--           is_blindspot f, first_published = S2a's, updated_at still 2000-01-01
--           00:00:00 (not stamped). C2: article_count 0, all ten keys 0, the row
--           kept, first_published unchanged, updated_at still 2001-02-03 04:05:06.
--           C3: untouched (its one-key distribution and updated_at as before). S1's
--           articles 0, S1 row 0, S2 row 1, all three cluster rows kept.
--           delete_source(random uuid) returned NULL; a second delete_source(S1)
--           returned NULL; a source in no cluster returned {} and was deleted.
--           (b) five voting articles (three pro_government, two gov_leaning) seed a
--           blindspot (article_count 5, is_blindspot t, side pro_government);
--           delete_source of the fifth source returned that cluster and left
--           article_count 4, is_blindspot f, blindspot_side null.
--           (c) cap: a source in 2001 clusters raised SQLSTATE 54000
--           ("128 delete_source: 2001 clusters affected (cap 2000); deactivate the
--           source instead or delete it in SQL") and nothing changed (source 1,
--           articles 2001, links 2001); with 2000 clusters (each with its own
--           distinct updated_at) the call returned 2000 recomputed ids in 162 ms
--           (one-article clusters, laptop, snapshot and restore included), all 2000
--           updated_at values were back unchanged (2000 equal, 0 different), and 2000
--           advisory locks were held until commit.
--           Mutation check 1: with a body that only deletes the source and returns {},
--           8 live tests fail (the probe of the function text, the uuid-order
--           return, C1, C2, the NULL return, the {} return, the blindspot flip and
--           the cap); with 128 re-applied they pass.
--           Mutation check 2: the real body minus the restoring update leaves the
--           recomputed aggregates right but fails the two live tests that read
--           updated_at (C1 and C2: the clusters carry now()); with the update
--           back they pass.
--   Concurrency (two psql sessions on a committed scratch fixture):
--           (1) A holds the cluster's advisory lock for 3 s in an open transaction
--           (cluster_unlink_article, the key cluster_link_atomic takes, which stamps
--           updated_at); B starts delete_source 1 s later and blocks until A commits
--           (A committed at :24.481, B returned at :24.484), then recomputes:
--           article_count 1, opposition 1, and updated_at is A's committed stamp
--           (the snapshot is taken after the lock), not B's now().
--           (2) While delete_source is open in a transaction, an
--           INSERT of an article for that source waits (:33.754 to :35.030) and then
--           fails with 23503 on articles_source_id_fkey: the FOR UPDATE on the source
--           row blocks new articles.
--   Rollback rehearsed: drop function if exists public.delete_source(uuid), ledger
--           row 128 removed (DELETE 1), then this file twice more: INSERT 0 1, then
--           INSERT 0 0; md5(prosrc) 5aa70873..., anon and authenticated still
--           cannot execute.
--
-- DEPLOY: APPLY 128, THEN DEPLOY THE ROUTE
--   Apply this file (additive; the old route keeps working until the new one is
--   deployed, because it does not call the function). Then deploy the app: the
--   route calls rpc('delete_source') and revalidates the returned cluster ids.
--   No Edge Function changes. Order matters only one way: the route must not be
--   deployed before 128 is applied, or delete_source would answer with a missing
--   function error (500).
--   Not repaired by the apply: sources deleted earlier through the bare delete
--   left stale clusters. The optional operator repair is select
--   public.cluster_unlink_article(id, null) per cluster (service_role). It stamps
--   updated_at = now(), which reorders the home feed: read the clusters'
--   updated_at first and write it back afterwards, as delete_source does.
--
-- VERIFY (read-only)
--   select md5(prosrc), length(prosrc), prosecdef, provolatile, proconfig
--     from pg_proc where oid = 'public.delete_source(uuid)'::regprocedure;
--       -- expect 5aa70873992b1a3ef97b0221584bf8b6, 4116, t, v, {"search_path=\"\""}
--   select has_function_privilege('anon', 'public.delete_source(uuid)', 'execute'),
--          has_function_privilege('authenticated', 'public.delete_source(uuid)', 'execute'),
--          has_function_privilege('service_role', 'public.delete_source(uuid)', 'execute');
--       -- expect f, f, t
--
-- ROLLBACK (nothing depends on 128 once the route is reverted)
--   deploy the previous route first (it does not use the function), then run:
--     drop function if exists public.delete_source(uuid);
--     delete from supabase_migrations.schema_migrations where version = '128';
--   Clusters recomputed while 128 was live keep their correct aggregates.
--
-- Additive. Safe to re-apply (create or replace function, ledger insert on
-- conflict do nothing). One transaction; the only lock of note is the catalog
-- lock create or replace function takes on this one function, bounded by
-- lock_timeout = 5 s: on 55P03 nothing is recorded, re-apply. No CONCURRENTLY
-- step, no cron change, no new table, no table grant.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- delete_source: delete the source, recompute the clusters it leaves behind.
-- VOLATILE (the default) on purpose: every statement must see what the
-- previous lock holder committed.
-- ---------------------------------------------------------------------------

create or replace function public.delete_source(p_source_id uuid)
returns uuid[]
language plpgsql
security definer
-- Empty search_path + schema-qualified identifiers so a session role with
-- CREATE on pg_temp cannot shadow an unqualified call inside this SECURITY
-- DEFINER body (the hardening 025/027/064/121 carry).
set search_path = ''
as $fn$
declare
  v_ids uuid[];
  v_cid uuid;
  v_snap_ids uuid[];
  v_snap_at timestamptz[];
begin
  -- FOR UPDATE on the source row: a new article for this source takes FOR KEY
  -- SHARE on it (the foreign key check) and waits until we commit, so nothing
  -- can add articles to the source while it is being deleted.
  perform 1 from public.sources s where s.id = p_source_id for update;
  if not found then
    return null;
  end if;

  -- The clusters this source sits in, collected BEFORE the delete (the cascade
  -- removes the rows that say so), distinct and sorted by id: the same ascending
  -- uuid order 099 takes its advisory locks in, so two callers cannot lock the
  -- same pair in opposite orders.
  select coalesce(
           pg_catalog.array_agg(x.cluster_id order by x.cluster_id),
           '{}'::uuid[]
         )
    into v_ids
    from (
      select distinct ca.cluster_id
        from public.cluster_articles ca
        join public.articles a on a.id = ca.article_id
       where a.source_id = p_source_id
    ) x;

  -- Advisory xact locks accumulate in the shared lock table until commit (one
  -- slot each), so the number of clusters is capped. Refused before anything is
  -- locked or deleted; the caller deactivates the source instead.
  if pg_catalog.cardinality(v_ids) > 2000 then
    raise exception using
      errcode = '54000',
      message = '128 delete_source: ' || pg_catalog.cardinality(v_ids)::text
        || ' clusters affected (cap 2000); deactivate the source instead or delete it in SQL';
  end if;

  -- Per-cluster serialization, the key cluster_link_atomic (027, 121),
  -- cluster_unlink_article (064) and cluster_merge_atomic (099) take, in the
  -- sorted uuid order of v_ids. Taken before the delete so a concurrent link
  -- into an affected cluster finishes first and the recompute below sees it.
  foreach v_cid in array v_ids loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(v_cid::text));
  end loop;

  -- Remember each affected cluster's updated_at. Taken after the advisory locks
  -- (a link that was in flight has committed and stamped its own updated_at, which
  -- is the value to keep) and before the recompute below re-stamps it. Ids and
  -- timestamps come from the same query, so the two arrays always line up.
  select pg_catalog.array_agg(c.id order by c.id),
         pg_catalog.array_agg(c.updated_at order by c.id)
    into v_snap_ids, v_snap_at
    from public.clusters c
   where c.id = any (v_ids);

  -- The one delete. The foreign keys cascade it: articles, then cluster_articles
  -- and the per-article tables (STEP 0 a).
  delete from public.sources s where s.id = p_source_id;

  -- Recompute every affected cluster from its surviving members: article_count,
  -- bias_distribution, is_blindspot / blindspot_side, first_published. The null
  -- article id deletes nothing and matches no jev_unlink_candidates row, so this
  -- is a pure recompute (121 and 099 call it the same way). A cluster left with
  -- no member keeps its row with article_count 0 and its old first_published; it
  -- is never archived or deleted here. The recompute stamps updated_at = now(),
  -- which the next statement takes back.
  foreach v_cid in array v_ids loop
    perform public.cluster_unlink_article(v_cid, null);
  end loop;

  -- A source delete is not news: restore updated_at (the recompute stamped now()),
  -- as 099 cluster_merge_atomic does in its step 10. updated_at orders the home
  -- feed's candidate window and the topic, blindspot and near-blindspot lists and
  -- feeds /api/v1/clusters' `updated since` filter; without this a source that
  -- sits in a thousand clusters would move all of them to the top at once and push
  -- the genuinely fresh stories out of the 200-row candidate window. The restore
  -- only sets updated_at back to a value it already had, so MAX(updated_at), which
  -- /api/health reads, never rises.
  update public.clusters c
     set updated_at = v_snap_at[s.n::int]
    from pg_catalog.unnest(v_snap_ids) with ordinality as s(cid, n)
   where c.id = s.cid;

  return v_ids;
end;
$fn$;

comment on function public.delete_source(uuid) is
  'Deletes a source and recomputes the clusters it leaves behind (migrations 128, h8-admin-1). '
  'Locks the source row (FOR UPDATE), collects the distinct clusters its articles sit in (sorted by id), '
  'refuses more than 2000 with errcode 54000, takes pg_advisory_xact_lock(hashtext(cluster_id::text)) for each in id order, '
  'deletes the source (the foreign keys cascade to articles and cluster_articles), then calls '
  'cluster_unlink_article(cluster_id, null) for each to recompute article_count, bias_distribution, is_blindspot, '
  'blindspot_side and first_published, then restores updated_at (a source delete is not news; updated_at feeds the home feed). '
  'A cluster left empty keeps its row with article_count 0; '
  'none is archived or deleted. Returns the recomputed cluster ids, an empty array if the source sat in no cluster, '
  'or null if there is no such source. Called only by POST /api/admin behind hasAdminSession(). service_role only.';

-- Supabase auto-grants EXECUTE to anon + authenticated on function creation;
-- name them explicitly (revoking from public alone leaves the role-direct
-- grants and the RPC stays exposed through PostgREST).
revoke all on function public.delete_source(uuid) from public, anon, authenticated;
grant execute on function public.delete_source(uuid) to service_role;

-- Ledger ---------------------------------------------------------------------------

insert into supabase_migrations.schema_migrations (version, name)
  values ('128', '128_delete_source_recompute')
  on conflict do nothing;

commit;
