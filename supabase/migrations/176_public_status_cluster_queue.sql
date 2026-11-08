-- 176_public_status_cluster_queue.sql
--
-- h71-transparency-3 (hunt 71, 2026-11-08). /durum's "Kümeleme" step, and /api/health's clustering check, measured how long it
-- has been since the newest clusters.updated_at, not how far clustering lags. A night with nothing to cluster aged that value
-- past the 45-minute warn line twice on 2026-11-08 and turned the whole public verdict "Gecikmeli". This migration re-creates
-- public.public_status_snapshot() with 110's body VERBATIM plus three numbers in its clustering object, queue_depth and
-- queue_oldest_sec, read from pgmq.q_cluster_work with the expressions of ops row 18 (queue_lag, migration 150), and
-- queue_poison_recent, the messages archived as poison in the last hour, read from pgmq.a_cluster_work with ops row 18's
-- poison expression (migration 167; 1 h window here, 24 h there). The page (src/lib/status/verdict.ts) then decides the
-- Kümeleme level from the queue and keeps the update age as plain text, and /api/health waives its 15-minute rule while
-- cluster_work is empty. Read-only function, additive: no table, column, grant,
-- cron job or data change, and the RPC's signature and return type stay as they are.
--
-- WHY (evidence: production, read-only SELECTs, 2026-11-08 12:2x-12:4x UTC)
--   * The metric. 110's clustering block returns max(clusters.updated_at) over the last 6 hours. verdict.ts turned an age over
--     45 minutes into Gecikmeli and over 90 into Sorunlu (STATUS_CLUSTER_WARN_MIN / STATUS_CLUSTER_FAIL_MIN), and
--     overallVerdict counts clustering at full rank, so one idle stretch made the whole page amber. A cluster is only touched
--     when a clusterable article (politika or son_dakika) arrives, and createCluster stamps updated_at = the first article's
--     published_at (supabase/functions/cluster-consumer/index.ts, createCluster), so an idle pipeline and a stuck consumer
--     read the same. The verdict.ts header said these were "the SAME thresholds the ops heartbeat pages on": ops has no
--     cluster-freshness row. Its clustering signal is row 18 queue_lag (150): warn when the oldest VISIBLE cluster_work
--     message is over 300 s, fail over 900 s.
--   * The replay. Gaps over 45 minutes between distinct articles.created_at of clustered articles, last 7 days:
--       2026-11-07 23:54:04 -> 2026-11-08 00:45:07 UTC (51 min)   about 6 minutes of amber at 00:40-00:46
--       2026-11-08 01:27:04 -> 2026-11-08 02:33:04 UTC (66 min)   about 21 minutes of amber at 02:12-02:33
--     No gap over 90 minutes. In the second window 26 articles were ingested and none was politika or son_dakika, so
--     clustering had nothing to do; the only cluster stamped there, ed2bc9ab, was created at 02:33:06 with updated_at 02:30:26
--     (its published_at), so max(updated_at) stayed at 01:27 until then. /api/health applies a 15-minute rule to the same
--     input (STALE_CLUSTERING_THRESHOLD_SEC) and said degraded on every such quarter hour.
--   * The cluster_work queue is the right signal. Over the last 48 hours (pgmq.a_cluster_work, archived_at in range, 3,016
--     messages) the wait from enqueued_at to archived_at had p95 63.7 s, p99 71.2 s, max 83.4 s, and none over 300 s or 900 s,
--     so ops row 18's wait line is far above normal and a STALLED consumer still crosses it: a consumer that is not
--     reading leaves visible messages behind, an idle night leaves none. A consumer that reads and FAILS every message is
--     a different outage, see the next bullet.
--   * The failing consumer (review finding, 2026-11-08). cluster-consumer catches a processArticle error, leaves the
--     message for VT_SECONDS = 60, and archives it only when read_ct > MAX_READS = 3, that is on its 4th read
--     (supabase/functions/cluster-consumer/index.ts, the catch path at about line 3420), about 3-7 minutes after enqueue;
--     cluster-drain runs every minute on prod. So with a consumer that fails every message the queue stays short and no
--     visible message ages past about 7 minutes: a simulation of the vt and the one-minute drain at about 78 messages an
--     hour put the oldest visible wait at a maximum near 418 s, over 300 s in 16-22% of samples and never over 900 s,
--     and at 10 messages an hour over 300 s in 3.5% of samples. The wait line alone would read Normal most of the time
--     during that outage and could never reach Sorunlu, where the 45/90 rule it replaces reached Gecikmeli at 45 minutes
--     and Sorunlu at 90. Ops row 18 does catch it, through its other two lines: depth > 300 and q_poison >= 1 (messages
--     archived with read_ct > 3). This migration therefore exposes queue_poison_recent, and the page applies the depth
--     and poison lines of row 18 next to the wait line.
--
-- WHAT CHANGES (pinned by tests/migrations/176-public-status-cluster-queue.test.ts and src/lib/status/verdict.test.ts)
--   1. public.public_status_snapshot() is re-created with the same signature and attributes (jsonb, plpgsql, stable, security
--      definer, set search_path = ''). The body is 110's text line for line (the ingest, labelling and feeds sections and
--      the clustering max(updated_at) read are untouched) with three additions:
--        a. v_qdepth bigint, v_qoldest numeric, v_qpoison bigint: declared without defaults, so they are null unless the
--           read below sets them.
--        b. Inside the clustering block, after the max(updated_at) read, a NESTED begin ... exception block: when
--           pg_catalog.to_regclass('pgmq.q_cluster_work') AND pg_catalog.to_regclass('pgmq.a_cluster_work') are both not
--           null it EXECUTEs one statement into v_qdepth, v_qoldest, v_qpoison, the three scalars of ops row 18: count(*)
--           of pgmq.q_cluster_work; coalesce(extract(epoch from now() - min(enqueued_at)), 0) over the messages with
--           vt <= now() (the oldest VISIBLE message: one being processed is not waiting); and the poison count,
--           count(*) of pgmq.a_cluster_work where archived_at >= now() - interval '1 hour' and read_ct > 3 (ops row 18's
--           expression of migration 167 with a 1 h window instead of 24 h). The nested handler sets all three back to
--           null, so a failing queue read (a permission change, a renamed queue) never turns the section into
--           ok = false ("Bilinmiyor", which the verdict ranks as late); it only makes the page use its fallback rule.
--           Without pgmq, or without either table, all three stay null as well.
--        c. 'queue_depth', 'queue_oldest_sec' and 'queue_poison_recent' in the clustering object, after 'ok' and
--           'last_at'. Every existing key stays, in the same order.
--   2. Privileges as in 110 and nothing else: revoke all from public, anon, authenticated; grant execute to service_role.
--      CREATE OR REPLACE keeps the ACL; the two statements are repeated so the file stands alone. The function comment is
--      extended with the 176 note and still says safe aggregates only.
--   3. set local lock_timeout = '5s' first (the function is replaced under a lock that /durum's reader also takes), so a
--      conflict fails the apply fast. The ledger row in the 095 pattern. No notify pgrst: nothing PostgREST caches changes.
--
-- HOW THE PAGE USES IT (src/lib/status/verdict.ts; the thresholds are ops row 18 and are repeated here so the two stay
--   in step, pinned by the test)
--   STATUS_CLUSTER_QUEUE_WARN_SEC = 300
--   STATUS_CLUSTER_QUEUE_FAIL_SEC = 900
--   STATUS_CLUSTER_QUEUE_DEPTH_WARN = 300
--   When queue_oldest_sec is a number the Kümeleme level starts from the wait: ok, gecikmeli (> 300 s) or sorunlu (> 900 s),
--   strict. It is then raised to at least gecikmeli when queue_poison_recent >= 1 or queue_depth > 300 (ops row 18's other two
--   lines), and a higher level is never lowered (sorunlu stays sorunlu). The age of the last cluster update is information
--   only. When queue_oldest_sec is absent or null (a database before 176, or a failed queue read) the old 45/90 updated_at
--   rule applies unchanged. The allow-list parser keeps only the three new numbers (a finite number >= 0 for the wait, a
--   non-negative integer for the other two; present but invalid becomes null) and still drops every other key.
--
-- STEP 0 (production, read-only, 2026-11-08, SELECT only; nothing was applied)
--   * The function today: md5(pg_get_functiondef('public.public_status_snapshot()'::regprocedure)) =
--     2c8180061e9107f5e8d99c318418877a, 2825 characters, prosecdef = true, provolatile = 's', proconfig {search_path=""}, owner postgres, ACL
--     {postgres=X/postgres,service_role=X/postgres}. The body is identical to 110's: the text between the $function$ tags equals
--     the text between 110's $fn$ tags (2661 characters, body md5 b019f06ff93a91bd5154d37dc10efa50), and the md5 of the
--     whole definition is reproduced from 110's body in tests/migrations/176-public-status-cluster-queue.test.ts. So 176
--     copies 110, which is also what production runs; there is no drift to carry.
--   * pgmq.q_cluster_work exists with columns msg_id bigint, read_ct integer, enqueued_at timestamptz, vt timestamptz,
--     message jsonb, headers jsonb. The queue read touches enqueued_at and vt only, never message, msg_id, headers or
--     read_ct. pgmq.a_cluster_work is read for archived_at and read_ct only, through archived_at_idx_cluster_work.
--   * The poison count as a plain select (explain analyze, prod, read-only, 2026-11-08 12:xx UTC): Index Scan using
--     archived_at_idx_cluster_work, Execution Time 0.5-0.9 ms over the 116 messages archived in the last hour; poison
--     (read_ct > 3) in that hour: 0. It adds well under a millisecond to 110's 3.5 ms.
--   * The queue read as a plain select: Execution Time 0.136 ms (explain analyze, the queue empty, as it is on a quiet
--     night), next to the 3.5 ms of database time 110 measured for its four sections: the < 2 s warm budget of 110 stands.
--     Right now (12:32 UTC) depth 0 and oldest 0 s.
--   * Services: the app reads this function through the service-role reader client with a 4 s cap; the function runs as
--     its owner (security definer), as ops_health_report() does when it reads the same table in row 18.
--
-- REPLAY (read-only on production; the baseline before 176 and the check after it)
--   with ev as (select distinct a.created_at t from articles a join cluster_articles ca on ca.article_id = a.id
--                where a.created_at >= now() - interval '7 days'),
--        g as (select t, lag(t) over (order by t) prev from ev)
--   select prev, t from g where t - prev > interval '45 minutes'
--     -> 2026-11-07 23:54:04.856446+00 / 2026-11-08 00:45:07.106368+00 and 2026-11-08 01:27:04.467008+00 / 2026-11-08 02:33:04.080594+00
--   select count(*), count(*) filter (where category in ('politika', 'son_dakika')) from articles
--    where created_at > '2026-11-08 01:27:04.467008+00' and created_at < '2026-11-08 02:33:04.080594+00'  ->  26, 0
--   After 176 and the deploy, the same night would read: clustering {ok true, last_at 01:27, queue_depth 0, queue_oldest_sec 0,
--   queue_poison_recent 0} -> Kümeleme Normal, verdict Çalışıyor (the unit test replays the 02:30 UTC document through the
--   parser and the view). The same document with queue_poison_recent 2 reads Gecikmeli.
--
-- DRY RUN (local PG15, throwaway data dir, loopback only; never production; re-run for the poison count)
--   PostgreSQL 15.12. Order: the repo's tests/migrations/sql/stub.sql, a minimal jev_shadow_runs, 110 from its own file,
--   fixtures (three active voting sources, two fresh articles, clusters updated 63 minutes ago, 2 hours in the future and
--   2 days ago, one jev run), 110's document saved as the baseline, then 176 applied TWICE with no pgmq schema, then a stub
--   pgmq.q_cluster_work with production's six columns and, later, a stub pgmq.a_cluster_work with its seven columns
--   (msg_id, read_ct, enqueued_at, archived_at, vt, message, headers) and archived_at_idx_cluster_work. Every check is a DO
--   block that raises on a mismatch; the run ends with DRYRUN 176 OK. Both applies exit 0, and the ledger holds exactly one
--   '176' row. Clustering objects below are (queue_depth, queue_oldest_sec, queue_poison_recent).
--   Baseline (110)  clustering {"ok": true, "last_at": T}
--   a.  no pgmq                          (null, null, null), keys present
--   a2. q_cluster_work only, no archive  (null, null, null)   (the guard needs both tables; ok stays true)
--   b.  empty queue, empty archive       (0, 0, 0)            (numbers, not null)
--   c.  three visible messages waiting 400 s, 100 s and 10 s: (3, 400.000140, 0)
--   d.  plus one in flight (vt 30 s ahead) enqueued 1000 s ago: (4, 400.000645, 0)   (in flight counts in the depth, not the wait)
--   e.  every message in flight: (2, 0, 0)
--   f.  enqueued_at renamed (the queue read fails): ok true, last_at intact, (null, null, null)   (clustering is NOT turned into ok = false)
--   g.  clusters.updated_at renamed (the cluster read fails): ok false, last_at null, all three null, ingest, labelling and feeds still ok
--   h.  one visible message waiting 20 minutes: (1, 1200.000085, 0)                (the page reads Sorunlu for it)
--   i.  poison: archive rows read_ct 4 and 4 archived 10 min ago, read_ct 3 archived 10 min ago (the boundary), read_ct 5
--       archived 61 min ago (outside the window), read_ct 9 archived 59 min ago: (0, 0, 3)   (the page reads Gecikmeli for it)
--   k.  only read_ct 3, 1 and 0 rows in the window: queue_poison_recent 0     (read_ct > 3, not >= 3)
--   l.  archived_at renamed (the archive read fails): ok true, last_at intact, (null, null, null)
--   m.  explain of the poison count with seq scans disabled uses archived_at_idx_cluster_work
--   The document minus generated_at and the three new keys equals 110's baseline on the same fixtures; the top-level keys are
--   clustering, feeds, generated_at, ingest, labelling; the clustering keys are last_at, ok, queue_depth, queue_oldest_sec,
--   queue_poison_recent.
--   Privileges: prosecdef t, provolatile s, proconfig {search_path=""}, ACL {postgres=X/postgres,service_role=X/postgres},
--   return type jsonb, one overload. has_function_privilege: anon f, authenticated f, service_role t. As role anon and as role
--   authenticated the call is refused with insufficient_privilege; as service_role it returns the document. A scan of the
--   whole document for the queue names, pgmq, a message body or header, msg_id and any uuid, with a message carrying an article
--   id and a secret in the queue and in the archive, found nothing. The migration created 0 tables.
--
-- DEPLOY: APPLY 176 FIRST, THEN DEPLOY THE APP (Vercel). No Edge Function deploy, no cron change.
--   The old app with the new function drops the three new keys in its allow-list parser and behaves as before. The new app
--   with the old function finds no queue number and uses the 45/90 rule (the page footnote already describes the queue rule,
--   so the order matters for the wording only). /api/health reads worker_metrics, not this function: its change is
--   independent. Apply with the usual path (supabase db push, or post the SQL). The file is one transaction and it is
--   safe to re-apply (create or replace, and the ledger insert is on conflict do nothing).
--
-- VERIFY (read-only, after applying):
--   select public_status_snapshot() -> 'clustering'
--     -> {"ok": true, "last_at": "...", "queue_depth": <n>, "queue_oldest_sec": <s>, "queue_poison_recent": <p>}
--        (all three keys present, numbers, 0, 0 and 0 when idle and healthy; queue_poison_recent is 0 on prod today)
--   select prosecdef, provolatile, proconfig, has_function_privilege('anon', oid, 'execute'),
--     has_function_privilege('authenticated', oid, 'execute'), has_function_privilege('service_role', oid, 'execute')
--     from pg_proc where oid = 'public.public_status_snapshot()'::regprocedure  -> t, s, {search_path=""}, f, f, t
--   select version, name from supabase_migrations.schema_migrations where version = '176'  -> one row.
--   After the deploy and the one-minute cache window, /durum at night stays Normal while the queue is empty and nothing was
--   archived as poison in the last hour, and GET /api/health (bearer) reports clustering {ok: true, idle: true} instead of
--   degraded.
--
-- OUT OF SCOPE
--   * createCluster still writes updated_at = the article's published_at (cluster-consumer). It is a separate observation:
--     it makes updated_at a poor "last processed" stamp for anything that wants one, and it is left as it is here.
--   * ops_health_report() is not touched (row 18 already carries the queue rule). No retention, no cron job, no data.
--
-- KNOWN LIMITS
--   * The queue rule watches messages that are IN the queue. It cannot see articles that were stored but never enqueued
--     (an enqueue-side failure in ingest): the queue stays empty and the page reads Normal for clustering, where the old
--     rule would have gone amber after 45 minutes. Ingest freshness (rows 3-4 of ops, the page's "Haber toplama" cards)
--     still covers a dead ingest, but not that case. A "clusterable articles with no cluster for N minutes" probe would,
--     and is a separate change.
--   * The oldest-message wait counts visible messages only (vt <= now()). A batch the consumer has read and is processing
--     reads as 0 s. A consumer that CATCHES an error on every message does not leave them in the queue to age: caught errors are
--     archived on the 4th read (read_ct > MAX_READS = 3, cluster-consumer index.ts:3420), about 3-7 minutes after enqueue, so
--     they never age past 900 s (the wait peaks near 7 minutes). queue_poison_recent is what surfaces that outage: it counts
--     the messages archived with read_ct > 3 in the last hour, and one is enough for Gecikmeli. An invocation that dies before
--     its catch (a crash or an Edge Function timeout) re-exposes its messages when vt expires; the wait line sees those age.
--   * The poison window is 1 hour here and 24 hours in ops row 18: the page recovers within the hour once the consumer works
--     again, while ops keeps warning for a day.
--
-- ROLLBACK (not expected to be needed; the app falls back to the 45/90 rule without the queue numbers, so no app change is
--   needed first). In one transaction, re-create 110's function (the text below is 110's, production's today) and delete the
--   ledger row. The ACL is untouched either way.
--     begin;
--     create or replace function public.public_status_snapshot()
--     returns jsonb
--     language plpgsql
--     stable
--     security definer
--     set search_path = ''
--     as $fn$
--     declare
--       v_now timestamptz := pg_catalog.now();
--       v_since timestamptz := pg_catalog.now() - interval '6 hours';
--       v_ingest jsonb; v_ingest_ok boolean := true;
--       v_cluster timestamptz; v_cluster_ok boolean := true;
--       v_label timestamptz; v_label_ok boolean := true; v_paused boolean := false;
--       v_active integer; v_silent integer; v_feeds_ok boolean := true;
--     begin
--       begin  -- ingest: ops check 4 basis (active voting sources, articles.created_at), grouped by bias
--         select coalesce(pg_catalog.jsonb_object_agg(t.bias, t.last_at), '{}'::jsonb) into v_ingest
--           from (select s.bias, pg_catalog.max(a.created_at) as last_at
--                   from public.articles a join public.sources s on s.id = a.source_id
--                  where s.active and s.kind in ('outlet', 'wire')
--                    and a.created_at >= v_since and a.created_at <= v_now
--                  group by s.bias) t;
--       exception when others then v_ingest := '{}'::jsonb; v_ingest_ok := false; end;
--       begin
--         select pg_catalog.max(c.updated_at) into v_cluster from public.clusters c
--          where c.updated_at >= v_since and c.updated_at <= v_now;
--       exception when others then v_cluster := null; v_cluster_ok := false; end;
--       begin  -- labelling: ops check 5 basis (108)
--         select pg_catalog.max(r.finished_at) into v_label from public.jev_shadow_runs r
--          where r.started_at >= v_since and (r.status in ('ok', 'budget_exceeded') or r.calls > 0);
--         if pg_catalog.to_regclass('cron.job') is not null then
--           execute $q$ select coalesce(pg_catalog.bool_and(not j.active), false) from cron.job j where j.jobname = 'jev-shadow' $q$ into v_paused;
--         end if;
--       exception when others then v_label := null; v_label_ok := false; v_paused := false; end;
--       begin  -- feeds: all active sources, same 72 h yield window as /kaynaklar/durum
--         select pg_catalog.count(*)::int,
--                (pg_catalog.count(*) filter (where not exists (select 1 from public.articles a
--                   where a.source_id = s.id and a.published_at >= v_now - interval '72 hours' and a.published_at <= v_now)))::int
--           into v_active, v_silent from public.sources s where s.active;
--       exception when others then v_active := null; v_silent := null; v_feeds_ok := false; end;
--       return pg_catalog.jsonb_build_object(
--         'generated_at', v_now,
--         'ingest', pg_catalog.jsonb_build_object('ok', v_ingest_ok, 'last_by_bias', v_ingest),
--         'clustering', pg_catalog.jsonb_build_object('ok', v_cluster_ok, 'last_at', v_cluster),
--         'labelling', pg_catalog.jsonb_build_object('ok', v_label_ok, 'last_at', v_label, 'paused', v_paused),
--         'feeds', pg_catalog.jsonb_build_object('ok', v_feeds_ok, 'active', v_active, 'silent', v_silent));
--     end
--     $fn$;
--     delete from supabase_migrations.schema_migrations where version = '176';
--     commit;
begin;

set local lock_timeout = '5s';

create or replace function public.public_status_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_now timestamptz := pg_catalog.now();
  v_since timestamptz := pg_catalog.now() - interval '6 hours';
  v_ingest jsonb; v_ingest_ok boolean := true;
  v_cluster timestamptz; v_cluster_ok boolean := true;
  v_qdepth bigint; v_qoldest numeric; v_qpoison bigint;  -- 176: cluster_work depth, oldest visible wait, poison of the last hour; null until read
  v_label timestamptz; v_label_ok boolean := true; v_paused boolean := false;
  v_active integer; v_silent integer; v_feeds_ok boolean := true;
begin
  begin  -- ingest: ops check 4 basis (active voting sources, articles.created_at), grouped by bias
    select coalesce(pg_catalog.jsonb_object_agg(t.bias, t.last_at), '{}'::jsonb) into v_ingest
      from (select s.bias, pg_catalog.max(a.created_at) as last_at
              from public.articles a join public.sources s on s.id = a.source_id
             where s.active and s.kind in ('outlet', 'wire')
               and a.created_at >= v_since and a.created_at <= v_now
             group by s.bias) t;
  exception when others then v_ingest := '{}'::jsonb; v_ingest_ok := false; end;
  begin
    select pg_catalog.max(c.updated_at) into v_cluster from public.clusters c
     where c.updated_at >= v_since and c.updated_at <= v_now;
    begin  -- 176: cluster_work lag and poison, ops row 18 (migrations 150, 167). A failed read leaves all three null (the page
           -- then uses its 45/90 updated_at rule) and never turns this section into ok = false.
      if pg_catalog.to_regclass('pgmq.q_cluster_work') is not null and pg_catalog.to_regclass('pgmq.a_cluster_work') is not null then
        execute $q$
          select (select pg_catalog.count(*) from pgmq.q_cluster_work),
                 (select coalesce(extract(epoch from pg_catalog.now() - pg_catalog.min(m.enqueued_at)), 0) from pgmq.q_cluster_work m where m.vt <= pg_catalog.now()),
                 (select pg_catalog.count(*) from pgmq.a_cluster_work a where a.archived_at >= pg_catalog.now() - interval '1 hour' and a.read_ct > 3)
        $q$ into v_qdepth, v_qoldest, v_qpoison;
      end if;
    exception when others then v_qdepth := null; v_qoldest := null; v_qpoison := null; end;
  exception when others then v_cluster := null; v_cluster_ok := false; end;
  begin  -- labelling: ops check 5 basis (108)
    select pg_catalog.max(r.finished_at) into v_label from public.jev_shadow_runs r
     where r.started_at >= v_since and (r.status in ('ok', 'budget_exceeded') or r.calls > 0);
    if pg_catalog.to_regclass('cron.job') is not null then
      execute $q$ select coalesce(pg_catalog.bool_and(not j.active), false) from cron.job j where j.jobname = 'jev-shadow' $q$ into v_paused;
    end if;
  exception when others then v_label := null; v_label_ok := false; v_paused := false; end;
  begin  -- feeds: all active sources, same 72 h yield window as /kaynaklar/durum
    select pg_catalog.count(*)::int,
           (pg_catalog.count(*) filter (where not exists (select 1 from public.articles a
              where a.source_id = s.id and a.published_at >= v_now - interval '72 hours' and a.published_at <= v_now)))::int
      into v_active, v_silent from public.sources s where s.active;
  exception when others then v_active := null; v_silent := null; v_feeds_ok := false; end;
  return pg_catalog.jsonb_build_object(
    'generated_at', v_now,
    'ingest', pg_catalog.jsonb_build_object('ok', v_ingest_ok, 'last_by_bias', v_ingest),
    'clustering', pg_catalog.jsonb_build_object('ok', v_cluster_ok, 'last_at', v_cluster, 'queue_depth', v_qdepth, 'queue_oldest_sec', v_qoldest, 'queue_poison_recent', v_qpoison),
    'labelling', pg_catalog.jsonb_build_object('ok', v_label_ok, 'last_at', v_label, 'paused', v_paused),
    'feeds', pg_catalog.jsonb_build_object('ok', v_feeds_ok, 'active', v_active, 'silent', v_silent));
end
$fn$;

comment on function public.public_status_snapshot() is
  'Safe aggregates only (timestamps, counts, booleans): no job names, error text, URLs or ids. Read by /durum through the service-role reader client. service_role only. Migration 110. The clustering object gained queue_depth, queue_oldest_sec (cluster_work depth and the wait of its oldest visible message, ops row 18) and queue_poison_recent (messages archived with read_ct > 3 in the last hour) in migration 176.';

revoke all on function public.public_status_snapshot() from public, anon, authenticated;
grant execute on function public.public_status_snapshot() to service_role;

insert into supabase_migrations.schema_migrations (version, name)
  values ('176', '176_public_status_cluster_queue')
  on conflict do nothing;

commit;
