-- 099_cluster_merge.sql
--
-- WHY
--   Two clusters for one story split its coverage and produce false
--   blindspots (a 5-source pile on one side in cluster A, the other side's
--   coverage sitting in cluster B). The 071 recall veto hides the false claim
--   but leaves the split in place. This migration adds a MERGE: the members of
--   a source cluster move into a target cluster, the target's aggregates are
--   recomputed, and the source is archived with a pointer (merged_into) so old
--   links keep working (308 in middleware, 301 in the keyed API).
--
-- RECOMPUTE DECISION
--   027 cluster_link_atomic takes a caller-supplied distribution and has no SQL
--   recompute. The canonical SQL recompute already exists:
--   public.cluster_unlink_article(cluster, article) from 064. It takes the same
--   per-cluster advisory lock as 027, deletes the member (a null article id
--   matches no row, which is fine) and recomputes article_count,
--   bias_distribution (voting source kinds only), the blindspot flag and side
--   (the contract in supabase/functions/_shared/cluster/blindspot.ts) and
--   first_published, stamping updated_at. The merge calls it with a null
--   article id on both clusters, so it is a pure recompute: no new formula and
--   no new zone-map copy lives in this file (tests/migrations/zone-parity.test.ts
--   would fail on one).
--
-- WHAT A MERGE DOES (cluster_merge_atomic, service_role only)
--   * Validates, takes a global merge lock and both per-cluster locks (fixed
--     order), locks both rows.
--   * Copies the source's members to the target (duplicates skipped), deletes
--     them from the source.
--   * Moves dependents: fact-check links, pending Jev unlink candidates, the
--     story-thread membership; drops pending thread candidates naming the
--     source; re-points clusters already merged into the source (flat chains).
--   * Recomputes both clusters, then RESTORES updated_at: the target gets
--     greatest(old target, old source), the source keeps its old value. A merge
--     is not news, and updated_at feeds the home feed. /api/health reads
--     MAX(updated_at), which never decreases here.
--   * Archives the source (is_archived, merged_into = target).
--   * Writes one cluster_merge_log row (audit; not written for a re-sweep).
--   * Idempotent: repeating the call after a completed merge is a no-op
--     (resweep = true); a re-sweep that finds late-arriving members of the
--     source moves them without a new log row.
--
-- TABLES (both service_role only; RLS on, no policies)
--   * cluster_merge_log: audit trail of merges.
--   * cluster_merge_dismissals: pairs an admin decided NOT to merge (owned here,
--     written by the admin surface).
--
-- DEPLOY ORDER
--   1. Apply this migration (additive; the app tolerates its absence: the API
--      lookup fails soft to 404, the page select is only extended in step 2).
--   2. Deploy the app (reads clusters.merged_into, middleware gate).
--   3. Enable the admin merge surface.
--   No Edge Function change, no cluster-consumer change.
--
-- ROLLBACK (manual; revert the app first):
--   begin;
--   drop function if exists public.cluster_merge_atomic(uuid, uuid, text, text);
--   drop table if exists public.cluster_merge_dismissals;
--   drop table if exists public.cluster_merge_log;
--   drop index if exists public.clusters_merged_into_idx;
--   alter table public.clusters drop constraint if exists clusters_merged_into_not_self;
--   alter table public.clusters drop column if exists merged_into;
--   delete from supabase_migrations.schema_migrations where version = '099';
--   commit;
--   (Archived source clusters stay archived; un-archive by hand if wanted.)

begin;

set local lock_timeout = '5s';

-- 1. clusters.merged_into ----------------------------------------------------------

alter table public.clusters add column if not exists merged_into uuid references public.clusters(id) on delete set null;

do $guard$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
     where conname = 'clusters_merged_into_not_self'
       and conrelid = 'public.clusters'::regclass
  ) then
    alter table public.clusters
      add constraint clusters_merged_into_not_self check (merged_into is null or merged_into <> id);
  end if;
end
$guard$;

create index if not exists clusters_merged_into_idx on public.clusters (merged_into) where merged_into is not null;

comment on column public.clusters.merged_into is
  'Set on an archived cluster whose members were merged into the referenced cluster (migration 099). Never points at another merged cluster: chains are flattened at merge time.';

-- 2. cluster_merge_log --------------------------------------------------------------

create table if not exists public.cluster_merge_log (
  id bigint generated always as identity primary key,
  source_id uuid not null references public.clusters(id) on delete cascade,
  target_id uuid not null references public.clusters(id) on delete cascade,
  actor text not null check (char_length(btrim(actor)) between 1 and 64),
  origin text not null check (origin in ('manual', 'thread', 'recall')),
  source_count_before int not null,
  target_count_before int not null,
  moved int not null,
  duplicates int not null,
  target_count_after int not null,
  target_bias_before jsonb not null,
  target_bias_after jsonb not null,
  target_blindspot_before boolean not null,
  target_blindspot_after boolean not null,
  created_at timestamptz not null default now()
);

create index if not exists cluster_merge_log_created_idx on public.cluster_merge_log (created_at desc);
create index if not exists cluster_merge_log_source_idx on public.cluster_merge_log (source_id);
create index if not exists cluster_merge_log_target_idx on public.cluster_merge_log (target_id);

comment on table public.cluster_merge_log is
  'Audit trail of cluster merges (migration 099). One row per completed merge; a re-sweep of an already merged source writes none. service_role only.';

-- 3. cluster_merge_dismissals -------------------------------------------------------

create table if not exists public.cluster_merge_dismissals (
  cluster_a uuid not null references public.clusters(id) on delete cascade,
  cluster_b uuid not null references public.clusters(id) on delete cascade,
  origin text not null check (origin in ('thread', 'recall')),
  actor text not null check (char_length(btrim(actor)) between 1 and 64),
  created_at timestamptz default now(),
  primary key (cluster_a, cluster_b),
  constraint cluster_merge_dismissals_ordered check (cluster_a < cluster_b)
);

create index if not exists cluster_merge_dismissals_b_idx on public.cluster_merge_dismissals (cluster_b);

comment on table public.cluster_merge_dismissals is
  'Cluster pairs an admin decided not to merge (migration 099), stored with cluster_a < cluster_b. service_role only.';

-- 4. RLS and grants -------------------------------------------------------------------

alter table public.cluster_merge_log enable row level security;
alter table public.cluster_merge_dismissals enable row level security;

-- Supabase default privileges hand new tables to anon/authenticated (incl.
-- write grants, cf. 091/095): strip them; nothing here is publicly readable.
revoke all on public.cluster_merge_log from anon, authenticated, public;
revoke all on public.cluster_merge_dismissals from anon, authenticated, public;

-- PG17 added MAINTAIN; it does not exist before PG17, so guard.
do $maint$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on public.cluster_merge_log, public.cluster_merge_dismissals from anon, authenticated';
  end if;
end
$maint$;

grant select on public.cluster_merge_log to service_role;
grant select, insert on public.cluster_merge_dismissals to service_role;

-- 5. The merge function ---------------------------------------------------------------

create or replace function public.cluster_merge_atomic(
  p_source uuid,
  p_target uuid,
  p_actor text,
  p_origin text default 'manual'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_src public.clusters%rowtype;
  v_tgt public.clusters%rowtype;
  v_resweep boolean;
  v_src_count integer;
  v_tgt_count integer;
  v_moved integer := 0;
  v_dups integer := 0;
  v_after_count integer;
  v_after_bias jsonb;
  v_after_blind boolean;
  v_log_id bigint := null;
begin
  -- 1. Validate.
  if p_source is null or p_target is null then
    raise exception 'cluster_merge_not_found';
  end if;
  if p_source = p_target then
    raise exception 'cluster_merge_self';
  end if;
  if p_actor is null or pg_catalog.char_length(pg_catalog.btrim(p_actor)) not between 1 and 64 then
    raise exception 'cluster_merge_bad_actor';
  end if;
  if p_origin is null or p_origin not in ('manual', 'thread', 'recall') then
    raise exception 'cluster_merge_bad_origin';
  end if;

  -- 2. Locks: one global merge lock (merges never overlap), then the
  -- per-cluster locks (the 027/064 key) in a fixed order.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cluster_merge')::bigint);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(least(p_source, p_target)::text));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(greatest(p_source, p_target)::text));

  -- 3. Lock both rows.
  select * into v_src from public.clusters where id = p_source for update;
  if not found then
    raise exception 'cluster_merge_not_found';
  end if;
  select * into v_tgt from public.clusters where id = p_target for update;
  if not found then
    raise exception 'cluster_merge_not_found';
  end if;

  -- 4. Target checks.
  if v_tgt.merged_into is not null then
    raise exception 'cluster_merge_target_merged';
  end if;
  if v_tgt.is_archived then
    raise exception 'cluster_merge_target_archived';
  end if;

  -- 5. Source checks.
  if v_src.merged_into is not null and v_src.merged_into <> p_target then
    raise exception 'cluster_merge_source_merged';
  end if;
  v_resweep := coalesce(v_src.merged_into = p_target, false);

  -- 6. Counts (real membership, not the denormalised column).
  select pg_catalog.count(*)::int into v_src_count
    from public.cluster_articles ca where ca.cluster_id = p_source;
  select pg_catalog.count(*)::int into v_tgt_count
    from public.cluster_articles ca where ca.cluster_id = p_target;

  if v_resweep and v_src_count = 0 then
    return pg_catalog.jsonb_build_object(
      'log_id', null,
      'resweep', true,
      'moved', 0,
      'duplicates', 0,
      'source_count_before', 0,
      'target_count_before', v_tgt_count,
      'target_count_after', v_tgt_count,
      'target_blindspot_before', v_tgt.is_blindspot,
      'target_blindspot_after', v_tgt.is_blindspot
    );
  end if;

  -- 7. Move the members.
  insert into public.cluster_articles (cluster_id, article_id)
  select p_target, ca.article_id
    from public.cluster_articles ca
   where ca.cluster_id = p_source
  on conflict do nothing;
  get diagnostics v_moved = row_count;
  v_dups := v_src_count - v_moved;

  delete from public.cluster_articles ca where ca.cluster_id = p_source;

  -- 8. Dependents.
  insert into public.cluster_fact_checks
    (cluster_id, fact_check_id, score, matched_terms, method, is_published, decided_by, created_at)
  select p_target, f.fact_check_id, f.score, f.matched_terms, f.method, f.is_published, f.decided_by, f.created_at
    from public.cluster_fact_checks f
   where f.cluster_id = p_source
  on conflict (cluster_id, fact_check_id) do nothing;
  delete from public.cluster_fact_checks f where f.cluster_id = p_source;

  update public.jev_unlink_candidates u
     set cluster_id = p_target
   where u.cluster_id = p_source
     and u.status = 'pending'
     and not exists (
       select 1 from public.jev_unlink_candidates t
        where t.cluster_id = p_target and t.article_id = u.article_id
     );

  -- Same lock 098's writers take, so a thread approval cannot interleave.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('story_threads_write')::bigint);
  if exists (select 1 from public.story_thread_members m where m.cluster_id = p_source) then
    if exists (select 1 from public.story_thread_members m where m.cluster_id = p_target) then
      delete from public.story_thread_members m where m.cluster_id = p_source;
    else
      update public.story_thread_members m set cluster_id = p_target where m.cluster_id = p_source;
    end if;
  end if;

  delete from public.story_thread_candidates c
   where c.status = 'pending'
     and (c.cluster_a = p_source or c.cluster_b = p_source);

  -- Flatten chains: anything merged into the source now points at the target.
  update public.clusters c set merged_into = p_target where c.merged_into = p_source;

  -- 9. Recompute both clusters with the canonical SQL (064).
  perform public.cluster_unlink_article(p_target, null::uuid);
  perform public.cluster_unlink_article(p_source, null::uuid);

  -- 10. A merge is not news: restore updated_at (the recompute stamped now()).
  update public.clusters c
     set updated_at = greatest(v_tgt.updated_at, v_src.updated_at)
   where c.id = p_target;
  update public.clusters c
     set is_archived = true,
         merged_into = p_target,
         updated_at = v_src.updated_at
   where c.id = p_source;

  -- 11. After-state and audit row.
  select c.article_count, c.bias_distribution, c.is_blindspot
    into v_after_count, v_after_bias, v_after_blind
    from public.clusters c
   where c.id = p_target;

  if not v_resweep then
    insert into public.cluster_merge_log (
      source_id, target_id, actor, origin,
      source_count_before, target_count_before, moved, duplicates, target_count_after,
      target_bias_before, target_bias_after, target_blindspot_before, target_blindspot_after
    ) values (
      p_source, p_target, pg_catalog.btrim(p_actor), p_origin,
      v_src_count, v_tgt_count, v_moved, v_dups, v_after_count,
      coalesce(v_tgt.bias_distribution, '{}'::jsonb), coalesce(v_after_bias, '{}'::jsonb),
      coalesce(v_tgt.is_blindspot, false), coalesce(v_after_blind, false)
    )
    returning id into v_log_id;
  end if;

  -- 12. Outcome.
  return pg_catalog.jsonb_build_object(
    'log_id', v_log_id,
    'resweep', v_resweep,
    'moved', v_moved,
    'duplicates', v_dups,
    'source_count_before', v_src_count,
    'target_count_before', v_tgt_count,
    'target_count_after', v_after_count,
    'target_blindspot_before', coalesce(v_tgt.is_blindspot, false),
    'target_blindspot_after', coalesce(v_after_blind, false)
  );
end;
$fn$;

comment on function public.cluster_merge_atomic(uuid, uuid, text, text) is
  'Merges cluster p_source into p_target (migration 099): moves members, fact-check links, pending unlink candidates and the thread membership, recomputes both clusters through cluster_unlink_article, archives the source with merged_into, logs the merge. Idempotent (resweep). Raises cluster_merge_self, cluster_merge_not_found, cluster_merge_target_archived, cluster_merge_target_merged, cluster_merge_source_merged, cluster_merge_bad_actor, cluster_merge_bad_origin. service_role only.';

revoke all on function public.cluster_merge_atomic(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.cluster_merge_atomic(uuid, uuid, text, text) to service_role;

insert into supabase_migrations.schema_migrations (version, name)
  values ('099', '099_cluster_merge')
  on conflict do nothing;

commit;
