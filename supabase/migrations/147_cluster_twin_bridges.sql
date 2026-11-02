-- 147_cluster_twin_bridges.sql
--
-- The evidence log for twin clusters (h19-recall-3), SHADOW MODE: public.cluster_twin_bridges
-- gets one row per (article, cluster pair) for every article that scores >= 0.55 against
-- a cluster other than the one it was placed in. Nothing reads it automatically and
-- nothing merges: a human still merges in /admin/birlestir. Service role only; nothing
-- is readable or writable from the browser.
--
-- WHY (evidence: production, read-only, 2026-11-02)
--   * cluster_merge_log has 0 rows ever, cluster_merge_dismissals 0, and no cluster has
--     merged_into set: twin clusters are never repaired. Live twins on 2026-11-02:
--     8ab93bbd [18] and 2c9941bd [10] (Antalya-Alanya otoyolu, created 36 minutes apart),
--     9b7c7c35 [24], d1db4922 [12] and dcdf1c8e (Erdogan's Seoul trip).
--   * The consumer already sees each of these as a multi-candidate decision (rankCandidates
--     in context-select.ts) and throws the information away. The hunter's bridge replay
--     (24 h, repo scorer) shows what it would have told us: 2c9941bd vs 8ab93bbd has 5
--     articles of EACH cluster scoring >= 0.55 against the other (best 0.997), 9b7c7c35 vs
--     dcdf1c8e has 11 articles at >= 0.55, while the Duzce / Bolu pile-ups (two different
--     accidents) bridge through one article only (and are stopped by the incident veto
--     anyway) and the two Yayman statements score 0.415. A rule of ">= 1 bridge at 0.40"
--     would over-merge; ">= 2 articles from >= 2 sources at >= 0.55" fires on 31 same-story
--     and 14 ambiguous pairs and on 0 of 20 different-story pairs.
--   * The verdict is twinMergeDecision() (supabase/functions/_shared/cluster/twin-merge.ts):
--     >= 2 distinct articles from >= 2 distinct sources, never when the subject or
--     incident veto fires or a cluster_merge_dismissals row exists, target = the larger
--     cluster, merged size <= 60. It is computed by the operator's query in
--     docs/ops-heartbeat.md ("Twin bridges (147, shadow)") and compared with the
--     /admin/birlestir decisions for 48 h before anyone proposes an automatic merge (that
--     would need a 'twin' origin in 099's check constraint, which is out of scope).
--
-- WHAT CHANGES (pinned by tests/migrations/147-cluster-twin-bridges.test.ts)
--   1. public.cluster_twin_bridges (article_id uuid not null, cluster_a uuid not null,
--      cluster_b uuid not null, score real not null, seen_at timestamptz not null default
--      now(), primary key (article_id, cluster_a, cluster_b), constraint
--      cluster_twin_bridges_ordered check (cluster_a < cluster_b)). The pair is stored
--      ordered, so (a, b) and (b, a) are one row: the writer orders the two cluster ids
--      before the insert (uuid order is the byte order of the lower-case hex text, so a
--      plain string comparison of two canonical uuids orders them the same way). A
--      re-delivered message or a second consumer run inserts the same key and
--      on conflict do nothing keeps the first record.
--      There is deliberately NO foreign key: clusters are merged away (merged_cluster_map,
--      116) and the evidence row must survive that, and a foreign key on article_id would
--      add a referential check (and a cascade) to every article delete; article deletes are not
--      slowed by this table.
--   2. An index on seen_at (the 48 h operator query and any future prune read the newest
--      rows; no ORCHESTRATOR PRE-BUILD step as in 101/127: the table is new and empty).
--   3. RLS on, no policy. Every privilege of anon, authenticated and public is revoked, the
--      Supabase default grants of service_role are replaced by select + insert (no update,
--      delete, truncate, references, trigger; on conflict do nothing needs only insert), plus
--      the PG17-guarded MAINTAIN revoke (131's block, as in 136 and 140). Nothing is granted
--      to anon or authenticated, so tests/guards/anon-surface.test.ts is unaffected.
--   4. notify pgrst 'reload schema' (the Edge Function writes through PostgREST) and the
--      ledger row in the 095 pattern.
--   No function, no cron job, no data rewrite.
--
-- RETENTION
--   Volume: rows/day is about sum(a2b55 + b2a55) over the 24 h bridge.json of the hunter's
--   replay: 149 rows over its 252 labelled pairs (113 same-story, 36 ambiguous, 0 different-
--   story). The consumer writes at most 3 pairs per article (the cap of at most 3 pairs per
--   article keeps a busy story from fanning out), so the table grows by a few hundred rows a
--   day, roughly 25 kB/day with the primary key and the seen_at index, under 10 MB a year.
--   That is why this migration adds no prune job. A prune cron (delete from
--   public.cluster_twin_bridges where seen_at < now() - interval '30 days') is a founder
--   decision and would need `grant delete` on the table to service_role (or a SECURITY
--   DEFINER function); it is deliberately not part of this change.
--
-- STEP 0 (production, read-only, 2026-11-02, via SELECT only; nothing was applied)
--   a) Version 147 is free:
--      select count(*) from supabase_migrations.schema_migrations where version = '147'
--      -> 0 (the ledger ends ... 143, 144, 145 among the numbered versions).
--   b) select to_regclass('public.cluster_twin_bridges') -> null (the table does not exist).
--   c) select count(*) from public.cluster_merge_log -> 0 and
--      select count(*) from public.cluster_merge_dismissals -> 0 (nothing was ever merged or
--      dismissed). Production runs PostgreSQL 17.6.
--   d) The four fixture pairs of tests/functions/_shared/twin-merge.test.ts (cluster ids, seed
--      titles, article_count) were read by primary key from public.clusters.
--
-- DRY RUNS (x2) (local PG15, throwaway cluster scratchpad/pg-aw-w2 on port 55462, 2026-11-02;
-- the shared stub schema (jevtest/qa/stub.sql: roles anon, authenticated, service_role,
-- supabase_migrations.schema_migrations, public.sources/articles) plus, added in a scratch
-- setup and not in this file: usage on schema public for the three roles, default privileges
-- that mimic Supabase's pre-117 (all on tables and sequences to anon, authenticated,
-- service_role), and `alter role service_role bypassrls` as Supabase has it). Each run was
-- psql -v ON_ERROR_STOP=1 -f 147_cluster_twin_bridges.sql:
--   run 1   BEGIN, SET, CREATE TABLE, CREATE INDEX, COMMENT, ALTER TABLE, REVOKE,
--           REVOKE, GRANT, DO, NOTIFY, INSERT 0 1, COMMIT
--   run 2   the same statements, no error; notices `relation "cluster_twin_bridges" already
--           exists, skipping` and `relation "cluster_twin_bridges_seen_at_idx" already
--           exists, skipping`; the ledger insert is INSERT 0 0
--   After   ledger 145, 147 (147_cluster_twin_bridges); columns article_id uuid not null,
--           cluster_a uuid not null, cluster_b uuid not null, score real not null, seen_at
--           timestamptz not null default now(); constraints cluster_twin_bridges_pkey
--           PRIMARY KEY (article_id, cluster_a, cluster_b) and cluster_twin_bridges_ordered
--           CHECK (cluster_a < cluster_b), nothing else (no foreign key); indexes
--           cluster_twin_bridges_pkey and cluster_twin_bridges_seen_at_idx; relrowsecurity t,
--           no policy; relacl {postgres=arwdDxt/postgres,service_role=ar/postgres}.
--   Grants  has_table_privilege: anon and authenticated false for select, insert, update,
--           delete, truncate, references and trigger; service_role true for select and
--           insert only. As anon and as authenticated: select and insert both fail with
--           `permission denied for table cluster_twin_bridges`. As service_role: insert ...
--           on conflict do nothing -> INSERT 0 1, the same (article, pair) again with
--           another score -> INSERT 0 0 (the first row stays: 0.83); update, delete and
--           truncate fail with `permission denied for table cluster_twin_bridges`;
--           cluster_a > cluster_b (2c9941bd / 8ab93bbd swapped) and cluster_a = cluster_b
--           both fail with `violates check constraint "cluster_twin_bridges_ordered"`.
--   The PG17 branch of the MAINTAIN block cannot run on PG15 (the guard skips it); it is
--   131's / 140's block, which the test pins character for character, and 140 is live on
--   PG 17.6.
--   Test counts: tests/migrations/147-cluster-twin-bridges.test.ts passes statically (20);
--   with TAYF_PSQL pointing at this database its live block passes too (32 of 32).
--
-- DEPLOY: APPLY 147, THEN DEPLOY THE EDGE FUNCTION
--   1. Apply this file (docs/migration-guide.md, operator). It takes no lock on an existing
--      table (the new table has no foreign key); lock_timeout = '5s' bounds the catalog locks.
--   2. Deploy cluster-consumer (supabase functions deploy cluster-consumer --no-verify-jwt).
--      Deploying the function BEFORE the migration is safe: the bridge write is best-effort
--      and fire-and-forget, a missing table makes it warn and the clustering is unaffected.
--   3. After 48 h run the query in docs/ops-heartbeat.md ("Twin bridges (147, shadow)").
--
-- VERIFY (read-only):
--   select to_regclass('public.cluster_twin_bridges');                    -- expect the table
--   select relrowsecurity from pg_class where oid = 'public.cluster_twin_bridges'::regclass;  -- t
--   select has_table_privilege('anon', 'public.cluster_twin_bridges', 'select'),
--          has_table_privilege('authenticated', 'public.cluster_twin_bridges', 'insert'),
--          has_table_privilege('service_role', 'public.cluster_twin_bridges', 'insert'),
--          has_table_privilege('service_role', 'public.cluster_twin_bridges', 'update');
--      -- expect f, f, t, f
--   select count(*), min(seen_at), max(seen_at) from public.cluster_twin_bridges;
--      -- after the function deploy: a few hundred rows a day
--
-- ROLLBACK (nothing else depends on 147; run by the operator)
--   drop table public.cluster_twin_bridges;
--   delete from supabase_migrations.schema_migrations where version = '147';   -- ledger row 147
--   The consumer tolerates the missing table (the write is best-effort); revert the function
--   only if you want the warning gone.
--
-- Additive. Safe to re-apply (create table / index if not exists, ledger insert on conflict
-- do nothing; the revokes, the grant and the RLS switch are idempotent). One transaction;
-- no ALTER of an existing object, no data rewrite, no CONCURRENTLY step, no function, no
-- grant to anon or authenticated.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. public.cluster_twin_bridges: one row per article x ordered cluster pair.
-- ---------------------------------------------------------------------------

create table if not exists public.cluster_twin_bridges (
  article_id uuid not null,   -- no FK: the row must survive a merge and must not slow article deletes
  cluster_a uuid not null,    -- the smaller of the two cluster ids (no FK, same reason)
  cluster_b uuid not null,    -- the larger of the two cluster ids
  score real not null,        -- the article's best ensemble score against the other cluster, >= 0.55
  seen_at timestamptz not null default now(),
  primary key (article_id, cluster_a, cluster_b),
  constraint cluster_twin_bridges_ordered check (cluster_a < cluster_b)
);

create index if not exists cluster_twin_bridges_seen_at_idx
  on public.cluster_twin_bridges (seen_at);

comment on table public.cluster_twin_bridges is
  'Shadow evidence for twin clusters (h19-recall-3): one row per article that '
  'scored >= 0.55 against a cluster other than its own, keyed by (article, '
  'ordered cluster pair) with cluster_a < cluster_b. Written best-effort by the '
  'cluster consumer (service role, insert on conflict do nothing); read only by '
  'the operator query in docs/ops-heartbeat.md. Nothing merges automatically: '
  'merges stay manual in /admin/birlestir. No foreign keys, so a row survives a '
  'cluster merge. service_role only (migration 147).';

alter table public.cluster_twin_bridges enable row level security;

-- Supabase default privileges hand new tables to anon/authenticated (incl.
-- write privileges, cf. 091/095) and to service_role (all): strip them, then
-- give service_role back exactly what the Edge Function and the operator need.
revoke all on public.cluster_twin_bridges from anon, authenticated, public;
revoke all on public.cluster_twin_bridges from service_role;
grant select, insert on public.cluster_twin_bridges to service_role;

-- PG17 added the MAINTAIN privilege; it does not exist before PG17 (revoking it
-- would be a syntax error), so guard.
do $maint$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on public.cluster_twin_bridges from anon, authenticated';
  end if;
end
$maint$;

-- 2. Schema cache and ledger ----------------------------------------------------

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('147', '147_cluster_twin_bridges')
  on conflict do nothing;

commit;
