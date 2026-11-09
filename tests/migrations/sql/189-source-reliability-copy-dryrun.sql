-- 189 source_reliability_copy_any_cluster (n_wire_copy counts every cluster of the source whose deduped member shares its
-- content_hash with another NON-aggregator source's deduped member, no wire gate): local PG15 dry-run. Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55589 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55589 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/189-source-reliability-copy-dryrun.sql
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh    (TAYF_LIVE_ONLY=189 runs just this one)
--
-- (\ir paths below are relative to this file.) Every check is a DO block that raises on mismatch, so a clean run ending
-- in "DRYRUN 189 OK" is the pass. The fixture rows carry the slug prefix d189- and are deleted at the end.
--
-- Order: the stub lacks articles.content_hash and clusters.bias_distribution (111 reads both), so they are added. Then 111
-- is applied from its own file, and its function body is checked against the md5 production holds
-- (761dacdf55be8a0d632a04df034fdec9, length 4586, read on 2026-11-09). The fixture is built, 111's function runs for every
-- fixture source and the rows are snapshotted. Then 189 is applied TWICE and the function runs again: n_wire_copy must equal an
-- independent formulation (row_number instead of distinct on) for every source, the other columns must equal the snapshot,
-- and the grants, the attributes and the ledger row are checked. Last, 111's function body is re-applied (the rollback of 189's
-- header: the old counts come back) and 189 once more.
--
-- Fixture, source S (outlet), window 30 days. hN = a content hash, hours are the article's age:
--   C1  S h1, A h1                          a pair (no 3-member floor): 189 counts it, 111 does not
--   C2  S h2, AG h2 (aggregator)            only an aggregator partner: not counted
--   C3  S h3a, A h3, B h3                   S differs: not counted
--   C4  S s4e h4e (20 h) and h4 (5 h), A B D share h4   deduped to S's EARLIEST article (h4e): not counted either way
--   C5  S A B D share h5                    a wire cluster: counted by both
--   C6  S NULL, A NULL                      NULL hashes never match
--   C7  one 40-day-old S article            outside the window: not in n_clusters
--   C8  S A AG share h8                     counted (A is not an aggregator), both versions
--   C9  S h9, A h9, B D N AG2 all differ    6 members, 5 distinct hashes: not wire, so only 189 counts it
--   C10 S h10, N h10 (niche)                a niche partner counts
--   C16 S AG AG2 share h16                  a wire cluster where S's only matching partners are aggregators: 111 counts it,
--                                           189 does not
--   C17 S h17, Z h17 (Z inactive, outlet)   a pair with an inactive partner: the rule has no active filter, 189 counts it
-- Aggregators' own rows: C14 AG2 h14 + A h14 (an aggregator's own share counts a non-aggregator partner), C15 AG2 AG share
-- h15 (aggregator and aggregator: not counted). C1 and C5 carry bias_distribution {pro_government 2, center 1, opposition 2}.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- 0. Columns 111 reads that the stub does not have. ---------------------------------------------------------------------
alter table public.articles add column if not exists content_hash text;
alter table public.clusters add column if not exists bias_distribution jsonb;

-- 1. 111 as production has it. --------------------------------------------------------------------------------------------
\ir ../../../supabase/migrations/111_source_reliability.sql

do $$
declare v_fn regprocedure := 'public.source_reliability_refresh_source(uuid,integer)'::regprocedure;
begin
  if (select md5(prosrc) from pg_proc where oid = v_fn) <> '761dacdf55be8a0d632a04df034fdec9' then
    raise exception '111 function body md5 differs from the production md5 (761dacdf...): the dry-run would not model production';
  end if;
  if (select length(prosrc) from pg_proc where oid = v_fn) <> 4586 then
    raise exception '111 function body length differs from production (4586)';
  end if;
end $$;

-- 2. Fixture. -------------------------------------------------------------------------------------------------------------
insert into public.sources (slug, name, bias, kind, active) values
  ('d189-s',   'S',   'pro_government', 'outlet',     true),
  ('d189-a',   'A',   'center',         'outlet',     true),
  ('d189-b',   'B',   'opposition',     'outlet',     true),
  ('d189-d',   'D',   'state_media',    'wire',       true),
  ('d189-n',   'N',   'center',         'niche',      true),
  ('d189-ag',  'AG',  'center',         'aggregator', true),
  ('d189-ag2', 'AG2', 'center',         'aggregator', true),
  ('d189-z',   'Z',   'center',         'outlet',     false);

create function pg_temp.mk(p_cluster text, p_source text, p_hash text, p_hours_ago numeric, p_label text default '')
returns void language plpgsql as $$
declare
  v_c uuid := md5('cluster:' || p_cluster)::uuid;
  v_s uuid := (select id from public.sources where slug = 'd189-' || p_source);
  v_a uuid := md5('article:' || p_cluster || ':' || p_source || ':' || p_label)::uuid;
begin
  if v_s is null then raise exception 'unknown fixture source %', p_source; end if;
  insert into public.clusters (id, title_tr) values (v_c, p_cluster) on conflict do nothing;
  insert into public.articles (id, source_id, title, published_at, url, content_hash)
    values (v_a, v_s, p_cluster || '/' || p_source, now() - (p_hours_ago || ' hours')::interval,
            'https://example.invalid/' || v_a, p_hash);
  insert into public.cluster_articles (cluster_id, article_id) values (v_c, v_a);
end $$;

select pg_temp.mk('C1', 's', 'h1', 10);   select pg_temp.mk('C1', 'a', 'h1', 9);
select pg_temp.mk('C2', 's', 'h2', 10);   select pg_temp.mk('C2', 'ag', 'h2', 9);
select pg_temp.mk('C3', 's', 'h3a', 10);  select pg_temp.mk('C3', 'a', 'h3', 9);   select pg_temp.mk('C3', 'b', 'h3', 8);
select pg_temp.mk('C4', 's', 'h4e', 20, 'early');  select pg_temp.mk('C4', 's', 'h4', 5, 'late');
select pg_temp.mk('C4', 'a', 'h4', 10);   select pg_temp.mk('C4', 'b', 'h4', 9);   select pg_temp.mk('C4', 'd', 'h4', 8);
select pg_temp.mk('C5', 's', 'h5', 10);   select pg_temp.mk('C5', 'a', 'h5', 9);   select pg_temp.mk('C5', 'b', 'h5', 8);   select pg_temp.mk('C5', 'd', 'h5', 7);
select pg_temp.mk('C6', 's', null, 10);   select pg_temp.mk('C6', 'a', null, 9);
select pg_temp.mk('C7', 's', 'h7', 40 * 24); select pg_temp.mk('C7', 'a', 'h7', 40 * 24 - 1);
select pg_temp.mk('C8', 's', 'h8', 10);   select pg_temp.mk('C8', 'a', 'h8', 9);   select pg_temp.mk('C8', 'ag', 'h8', 8);
select pg_temp.mk('C9', 's', 'h9', 10);   select pg_temp.mk('C9', 'a', 'h9', 9);   select pg_temp.mk('C9', 'b', 'h9b', 8);
select pg_temp.mk('C9', 'd', 'h9c', 7);   select pg_temp.mk('C9', 'n', 'h9d', 6);  select pg_temp.mk('C9', 'ag2', 'h9e', 5);
select pg_temp.mk('C10', 's', 'h10', 10); select pg_temp.mk('C10', 'n', 'h10', 9);
select pg_temp.mk('C14', 'ag2', 'h14', 10); select pg_temp.mk('C14', 'a', 'h14', 9);
select pg_temp.mk('C15', 'ag2', 'h15', 10); select pg_temp.mk('C15', 'ag', 'h15', 9);
select pg_temp.mk('C16', 's', 'h16', 10); select pg_temp.mk('C16', 'ag', 'h16', 9); select pg_temp.mk('C16', 'ag2', 'h16', 8);
-- C17 pairs S with Z, an inactive outlet (the function must also refuse to refresh Z itself, checked below).
select pg_temp.mk('C17', 'z', 'h17', 10); select pg_temp.mk('C17', 's', 'h17', 9);

update public.clusters set bias_distribution = '{"pro_government": 2, "center": 1, "opposition": 2}'::jsonb
 where title_tr in ('C1', 'C5');

create function pg_temp.refresh_all() returns void language plpgsql as $$
declare r record;
begin
  for r in select id from public.sources where slug like 'd189-%' and active order by slug loop
    perform public.source_reliability_refresh_source(r.id, 30);
  end loop;
end $$;

create function pg_temp.eq(p_what text, p_got anyelement, p_want anyelement) returns void language plpgsql as $$
begin
  if p_got is distinct from p_want then
    raise exception '% : got %, want %', p_what, p_got, p_want;
  end if;
end $$;

-- 3. 111 runs: the gated counts, snapshotted. -------------------------------------------------------------------------------
select pg_temp.refresh_all();

create temp table snap111 as
  select s.slug, r.window_days, r.n_articles, r.active_days, r.n_clusters, r.n_wire_copy, r.zone_mix
    from public.source_reliability_30d r join public.sources s on s.id = r.source_id
   where s.slug like 'd189-%';

do $$
begin
  perform pg_temp.eq('111 rows (7 active sources, Z inactive)', (select count(*)::int from snap111), 7);
  perform pg_temp.eq('111 S n_clusters (C7 is outside the window)', (select n_clusters from snap111 where slug = 'd189-s'), 11);
  perform pg_temp.eq('111 S n_wire_copy (gated: C5, C8, C16)', (select n_wire_copy from snap111 where slug = 'd189-s'), 3);
  perform pg_temp.eq('111 AG2 n_wire_copy (gated: C16 only)', (select n_wire_copy from snap111 where slug = 'd189-ag2'), 1);
end $$;

-- 4. 189 applied TWICE. ------------------------------------------------------------------------------------------------------
create temp table batch111 as
  select md5(prosrc) as m from pg_proc where oid = 'public.source_karne_refresh_batch(integer,integer,integer)'::regprocedure;
\ir ../../../supabase/migrations/189_source_reliability_copy_any_cluster.sql
\ir ../../../supabase/migrations/189_source_reliability_copy_any_cluster.sql

do $$
declare v_fn regprocedure := 'public.source_reliability_refresh_source(uuid,integer)'::regprocedure;
begin
  perform pg_temp.eq('one function of that name', (select count(*)::int from pg_proc where proname = 'source_reliability_refresh_source'), 1);
  perform pg_temp.eq('security definer', (select prosecdef from pg_proc where oid = v_fn), true);
  perform pg_temp.eq('search_path is empty', (select proconfig::text from pg_proc where oid = v_fn), '{"search_path=\"\""}');
  perform pg_temp.eq('returns boolean', (select prorettype::regtype::text from pg_proc where oid = v_fn), 'boolean');
  if (select md5(prosrc) from pg_proc where oid = v_fn) = '761dacdf55be8a0d632a04df034fdec9' then
    raise exception '189 left 111 body in place';
  end if;
  perform pg_temp.eq('anon cannot execute', has_function_privilege('anon', v_fn, 'execute'), false);
  perform pg_temp.eq('authenticated cannot execute', has_function_privilege('authenticated', v_fn, 'execute'), false);
  perform pg_temp.eq('service_role can execute', has_function_privilege('service_role', v_fn, 'execute'), true);
  perform pg_temp.eq('ledger row 189 once', (select count(*)::int from supabase_migrations.schema_migrations where version = '189'), 1);
  perform pg_temp.eq('the batch function is untouched', (select md5(prosrc) from pg_proc where oid = 'public.source_karne_refresh_batch(integer,integer,integer)'::regprocedure), (select m from batch111));
end $$;

-- 5. The new counts. ---------------------------------------------------------------------------------------------------------
select pg_temp.refresh_all();

do $$
declare
  r record;
  v_independent int;
begin
  -- Hand-computed expectations (see the header).
  perform pg_temp.eq('189 S n_clusters', (select n_clusters from public.source_reliability_30d where source_id = (select id from public.sources where slug = 'd189-s')), 11);
  perform pg_temp.eq('189 S n_wire_copy (C1, C5, C8, C9, C10, C17)', (select n_wire_copy from public.source_reliability_30d where source_id = (select id from public.sources where slug = 'd189-s')), 6);
  perform pg_temp.eq('189 AG n_wire_copy (C2, C8, C16: the partner S or A is not an aggregator; C15 is aggregator only)', (select n_wire_copy from public.source_reliability_30d where source_id = (select id from public.sources where slug = 'd189-ag')), 3);
  perform pg_temp.eq('189 AG2 n_wire_copy (C14, C16: its own share counts non-aggregator partners)', (select n_wire_copy from public.source_reliability_30d where source_id = (select id from public.sources where slug = 'd189-ag2')), 2);

  -- Every source: n_wire_copy equals an independent formulation (row_number, not distinct on).
  for r in select s.id, s.slug, w.window_start, w.n_wire_copy, w.n_clusters
             from public.sources s join public.source_reliability_30d w on w.source_id = s.id
            where s.slug like 'd189-%' loop
    with dedup as (
      select q.cluster_id, q.source_id, q.content_hash
        from (select ca.cluster_id, a.source_id, a.content_hash,
                     row_number() over (partition by ca.cluster_id, a.source_id order by a.published_at, a.id) rn
                from public.cluster_articles ca join public.articles a on a.id = ca.article_id) q
       where q.rn = 1),
    own as (select distinct ca.cluster_id from public.articles a join public.cluster_articles ca on ca.article_id = a.id
             where a.source_id = r.id and a.published_at >= r.window_start)
    select count(*)::int into v_independent
      from dedup o join own on own.cluster_id = o.cluster_id
     where o.source_id = r.id and o.content_hash is not null
       and exists (select 1 from dedup y join public.sources ys on ys.id = y.source_id
                    where y.cluster_id = o.cluster_id and y.source_id <> r.id
                      and y.content_hash = o.content_hash and ys.kind <> 'aggregator');
    perform pg_temp.eq('independent n_wire_copy of ' || r.slug, r.n_wire_copy, v_independent);
    if r.n_wire_copy > r.n_clusters then
      raise exception '% breaks n_wire_copy <= n_clusters (% > %)', r.slug, r.n_wire_copy, r.n_clusters;
    end if;
  end loop;

  -- Everything but n_wire_copy is exactly what 111 wrote.
  if exists (select 1 from snap111 o
              join public.sources s on s.slug = o.slug
              join public.source_reliability_30d n on n.source_id = s.id
             where (o.window_days, o.n_articles, o.active_days, o.n_clusters, o.zone_mix::text)
                   is distinct from (n.window_days, n.n_articles, n.active_days, n.n_clusters, n.zone_mix::text)) then
    raise exception '189 changed a column other than n_wire_copy';
  end if;
  perform pg_temp.eq('S zone_mix (C1 and C5 share the triple)', (select zone_mix::text from public.source_reliability_30d where source_id = (select id from public.sources where slug = 'd189-s')), '[[2, 1, 2, 2]]');
  perform pg_temp.eq('S n_articles (C7 is outside the window)', (select n_articles from public.source_reliability_30d where source_id = (select id from public.sources where slug = 'd189-s')), 12);

  -- 111 never counted more than the cluster size allowed; 189 counts at least what the gate counted, except where a
  -- cluster's only matching partners are aggregators (C16 for S).
  perform pg_temp.eq('S: 189 count minus 111 count (+C1 +C9 +C10 +C17, -C16)', (select n.n_wire_copy - o.n_wire_copy
     from snap111 o join public.sources s on s.slug = o.slug join public.source_reliability_30d n on n.source_id = s.id where o.slug = 'd189-s'), 3);

  -- The inactive source and an unknown id are refused and write nothing.
  perform pg_temp.eq('inactive source', public.source_reliability_refresh_source((select id from public.sources where slug = 'd189-z'), 30), false);
  perform pg_temp.eq('unknown id', public.source_reliability_refresh_source(md5('nobody')::uuid, 30), false);
  perform pg_temp.eq('no row for the inactive source', (select count(*)::int from public.source_reliability_30d where source_id = (select id from public.sources where slug = 'd189-z')), 0);
end $$;

-- 6. The rollback of the header: 111's function body comes back, the old counts with it, then 189 once more. ----------------
\ir ../../../supabase/migrations/111_source_reliability.sql
delete from supabase_migrations.schema_migrations where version = '189';

do $$
begin
  perform pg_temp.eq('111 re-applied: its md5 is back', (select md5(prosrc) from pg_proc where oid = 'public.source_reliability_refresh_source(uuid,integer)'::regprocedure), '761dacdf55be8a0d632a04df034fdec9');
  perform pg_temp.eq('rollback removed ledger row 189', (select count(*)::int from supabase_migrations.schema_migrations where version = '189'), 0);
  -- database-L1: the rollback restores 111's comment on function too (create or replace alone keeps 189's comment).
  perform pg_temp.eq('111 re-applied: its function comment is back (detectWireRedistribution parity)', (select position('detectWireRedistribution parity' in obj_description('public.source_reliability_refresh_source(uuid,integer)'::regprocedure, 'pg_proc')) > 0), true);
end $$;

select pg_temp.refresh_all();

do $$
begin
  perform pg_temp.eq('rolled back: S back to the gated count', (select n_wire_copy from public.source_reliability_30d where source_id = (select id from public.sources where slug = 'd189-s')), 3);
end $$;

\ir ../../../supabase/migrations/189_source_reliability_copy_any_cluster.sql
select pg_temp.refresh_all();

do $$
begin
  perform pg_temp.eq('189 re-applied after the rollback: S counts every cluster again', (select n_wire_copy from public.source_reliability_30d where source_id = (select id from public.sources where slug = 'd189-s')), 6);
  perform pg_temp.eq('189 body md5 after apply (pinned: the value to read on production after the apply)', (select md5(prosrc) from pg_proc where oid = 'public.source_reliability_refresh_source(uuid,integer)'::regprocedure), 'c23aa161f55921967e997578b2be16da');
end $$;

-- 7. Clean up the fixture. -------------------------------------------------------------------------------------------------
delete from public.source_reliability_30d where source_id in (select id from public.sources where slug like 'd189-%');
delete from public.cluster_articles where cluster_id in (select id from public.clusters where title_tr ~ '^C[0-9]+$');
delete from public.articles where source_id in (select id from public.sources where slug like 'd189-%');
delete from public.clusters where title_tr ~ '^C[0-9]+$';
delete from public.sources where slug like 'd189-%';

select 'DRYRUN 189 OK';
