-- 168 framing_draw_one_per_event (a Cerceve session meets each story once): local PG15 dry-run. Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55568 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55568 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/168-framing-draw-one-per-event-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql PGHOST=/tmp PGPORT=55568 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/168-framing-draw-one-per-event)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh    (TAYF_LIVE_ONLY=168 runs just this one)
--
-- (\ir paths below are relative to this file.) Every check is a DO block or a pg_temp function that raises on
-- mismatch, so a clean run ending in "DRYRUN 168 OK" is the pass. Every scenario that writes sits inside begin ...
-- rollback, so the database this leaves behind has 168 applied and holds no fixture rows.
--
-- Why it exists. 168's JS test (tests/migrations/168-framing-draw-one-per-event.test.ts) reads the SQL as text;
-- this runs the SHIPPED function in PostgreSQL: that the baseline (production's 105 body) really serves a sibling of
-- an event the session has voted on, that 168 never does, that identical text is excluded across clusters and for an
-- unclustered article, that a voted article which aged out of the pool still counts, and that every event has the
-- same chance whatever its number of copies, and that the session_hash index exists exactly once after two applies.
--
-- Order: the state 168 sits on (articles / clusters / cluster_articles from the stub; framing_votes of 068 and the
-- pool table of 105), the draw as production has it before 168 (105 section 3, byte for byte, md5 pinned, with its
-- revoke and grant), the bug on that baseline, then 168 TWICE, the new fingerprint and attributes, and the scenarios.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Prelude: the state 168 sits on. ---------------------------------------------------------------------------
-- 068 section 1 and 2: the votes table (service_role insert / select only).
create table public.framing_votes (
  id bigserial primary key,
  article_id uuid not null references public.articles(id) on delete cascade,
  vote text not null check (vote in ('iktidar', 'muhalefet', 'none')),
  session_hash text not null check (char_length(session_hash) between 32 and 128),
  created_at timestamptz not null default now(),
  unique (article_id, session_hash)
);
create index framing_votes_created_at_idx on public.framing_votes (created_at desc);
alter table public.framing_votes enable row level security;
revoke all on public.framing_votes from anon, authenticated, public;
grant select, insert on public.framing_votes to service_role;

-- 105 section 1: the pool table, owner-only.
create table public.framing_candidate_pool (
  article_id   uuid primary key references public.articles(id) on delete cascade,
  title        text,
  published_at timestamptz not null,
  refreshed_at timestamptz not null default now()
);
create index framing_candidate_pool_published_idx on public.framing_candidate_pool (published_at desc);
alter table public.framing_candidate_pool enable row level security;
revoke all on public.framing_candidate_pool from anon, authenticated, public;

-- Production's idx_cluster_articles_article_cluster (the stub carries only the primary key).
create index idx_cluster_articles_article_cluster on public.cluster_articles (article_id, cluster_id);

-- 105 section 3, byte for byte: production's draw (md5(prosrc) 21a64cbe..., length 1137).
create or replace function public.framing_next_headline(p_session_hash text)
returns table (
  article_id uuid,
  title text
)
language sql
stable
security definer
set search_path = ''
as $fn$
  with eligible as (
    -- A few thousand narrow rows plus framing_votes: no predictions scan, no
    -- articles heap. The 48 h re-check keeps a stalled refresh job from ever
    -- serving a stale headline; the anti-join and the newest-300 cut are 072's.
    select
      p.article_id as candidate_id,
      p.title      as candidate_title
    from public.framing_candidate_pool p
    where p.published_at >= now() - interval '48 hours'
      and not exists (select 1 from public.framing_votes v where v.article_id = p.article_id and v.session_hash = p_session_hash)
    order by p.published_at desc
    limit 300
  ),
  tallied as (
    select
      e.candidate_id,
      e.candidate_title,
      count(v.id) as vote_count
    from eligible e
    left join public.framing_votes v on v.article_id = e.candidate_id
    group by e.candidate_id, e.candidate_title
  )
  select
    t.candidate_id,
    t.candidate_title
  from tallied t
  -- false sorts before true: everything under 5 votes comes first, random
  -- within that band, so coverage spreads instead of concentrating.
  order by (t.vote_count >= 5) asc, random()
  limit 1;
$fn$;
revoke all on function public.framing_next_headline(text) from anon, authenticated, public;
grant execute on function public.framing_next_headline(text) to service_role;

-- Fixture helpers (session-local). Article n has uuid 00000000-0000-0000-0000-<n, 12 digits>; cluster n has c0000000-....
create function pg_temp.au(n int) returns uuid language sql immutable as
  $f$ select ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $f$;
create function pg_temp.cu(n int) returns uuid language sql immutable as
  $f$ select ('c0000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $f$;
-- One article: in articles, optionally in a cluster (cluster_n null = unclustered), optionally in the pool.
create function pg_temp.fx_article(n int, p_title text, cluster_n int, age interval default interval '1 hour', in_pool boolean default true)
returns void language plpgsql as $f$
begin
  insert into public.sources (id, slug, name, active, kind)
    values ('00000000-0000-0000-0000-00000000f001', 'fx-outlet', 'fx', true, 'outlet') on conflict do nothing;
  insert into public.articles (id, source_id, title, published_at)
    values (pg_temp.au(n), '00000000-0000-0000-0000-00000000f001', p_title, now() - age);
  if cluster_n is not null then
    insert into public.clusters (id) values (pg_temp.cu(cluster_n)) on conflict do nothing;
    insert into public.cluster_articles (cluster_id, article_id) values (pg_temp.cu(cluster_n), pg_temp.au(n));
  end if;
  if in_pool then
    insert into public.framing_candidate_pool (article_id, title, published_at) values (pg_temp.au(n), p_title, now() - age);
  end if;
end
$f$;
create function pg_temp.fx_vote(hash text, n int) returns void language sql as
  $f$ insert into public.framing_votes (article_id, vote, session_hash) values (pg_temp.au(n), 'none', hash) $f$;
-- n draws for one session, as the article numbers they returned (0 = no row).
create function pg_temp.draws(hash text, n int) returns int[] language plpgsql as $f$
declare out int[] := '{}'; a uuid; i int;
begin
  for i in 1..n loop
    select f.article_id into a from public.framing_next_headline(hash) f;
    out := out || coalesce(right(a::text, 12)::int, 0);
  end loop;
  return out;
end
$f$;
-- n draws, each from its own fresh session.
create function pg_temp.fresh_draws(n int) returns int[] language plpgsql as $f$
declare out int[] := '{}'; a uuid; i int;
begin
  for i in 1..n loop
    select f.article_id into a from public.framing_next_headline('fresh-' || i) f;
    out := out || coalesce(right(a::text, 12)::int, 0);
  end loop;
  return out;
end
$f$;
-- the fixture of the defect: event 1 has five copies (articles 1..5), event 2 one (article 6)
create function pg_temp.load_story() returns void language plpgsql as $f$
begin
  perform pg_temp.fx_article(1, 'Story A copy 1', 1);
  perform pg_temp.fx_article(2, 'Story A copy 2', 1);
  perform pg_temp.fx_article(3, 'Story A copy 3', 1);
  perform pg_temp.fx_article(4, 'Story A copy 4', 1);
  perform pg_temp.fx_article(5, 'Story A copy 5', 1);
  perform pg_temp.fx_article(6, 'Story B', 2);
end
$f$;

-- Baseline: this is production's function (md5(prosrc) read on production on 2026-11-06) with its ACL
-- (owner + service_role, nobody else). -----------------------------------------------------------------------
create temp table before_168 as
  select md5(prosrc) as m, length(prosrc) as len,
         (select string_agg(case when a.grantee = 0 then 'public' else a.grantee::regrole::text end || ':' || a.privilege_type,
                            ',' order by case when a.grantee = 0 then 'public' else a.grantee::regrole::text end)
            from aclexplode(p.proacl) a) as grants,
         proconfig::text as cfg, provolatile, prosecdef, proretset, proowner::regrole::text as owner,
         pg_get_function_result(oid) as res, pg_get_function_arguments(oid) as args, prolang
    from pg_proc p where oid = 'public.framing_next_headline(text)'::regprocedure;

do $$
declare b record;
begin
  select * into b from before_168;
  if b.m <> '21a64cbeecb880d83d988fb0e9bbe42b' or b.len <> 1137 then
    raise exception 'baseline: the prelude function is not production''s (md5 %, length %)', b.m, b.len;
  end if;
  if b.grants not like '%service_role:EXECUTE%' or b.grants like '%anon%' or b.grants like '%authenticated%' or b.grants like '%public%' then
    raise exception 'baseline: unexpected grants %', b.grants;
  end if;
  if not b.prosecdef or b.provolatile <> 's' or b.cfg is distinct from '{"search_path=\"\""}' or not b.proretset then
    raise exception 'baseline: unexpected attributes (secdef %, volatile %, config %)', b.prosecdef, b.provolatile, b.cfg;
  end if;
end $$;

-- The index is 168's own: it must not be in the prelude. ------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'framing_votes_session_hash_article_idx') then
    raise exception 'baseline: the session_hash index must not exist before 168';
  end if;
  if (select count(*) from pg_indexes where schemaname = 'public' and tablename = 'framing_votes') <> 3 then
    raise exception 'baseline: framing_votes should have exactly its three 068 indexes';
  end if;
end $$;

-- The bug, on the old function: a session that voted on one copy of a story is served the other copies. ----------
begin;
select pg_temp.load_story();
do $$
declare hash text := repeat('b', 64); d int[]; siblings int;
begin
  perform pg_temp.fx_vote(hash, 1);
  d := pg_temp.draws(hash, 300);
  select count(*) into siblings from unnest(d) x where x between 2 and 5;
  -- four unvoted siblings against one other story: about 80 % of the draws are siblings of the voted article
  if siblings < 150 then
    raise exception 'baseline: the old function should serve siblings of a voted story most of the time, got % of 300', siblings;
  end if;
  if exists (select 1 from unnest(d) x where x = 1) then
    raise exception 'baseline: the old function must still never return the voted article itself';
  end if;
end $$;
rollback;

-- 168, TWICE (safe to re-apply). ------------------------------------------------------------------------------
\ir ../../../supabase/migrations/168_framing_draw_one_per_event.sql
create temp table after_168_first as
  select md5(prosrc) as m, proacl::text as acl from pg_proc where oid = 'public.framing_next_headline(text)'::regprocedure;
\ir ../../../supabase/migrations/168_framing_draw_one_per_event.sql

-- 1. The function: new body, everything else as before. -----------------------------------------------------------
do $$
declare a record; b record; f record;
begin
  select * into b from before_168;
  select md5(prosrc) as m, length(prosrc) as len,
         (select string_agg(case when x.grantee = 0 then 'public' else x.grantee::regrole::text end || ':' || x.privilege_type,
                            ',' order by case when x.grantee = 0 then 'public' else x.grantee::regrole::text end)
            from aclexplode(p.proacl) x) as grants,
         proconfig::text as cfg, provolatile, prosecdef, proretset, proowner::regrole::text as owner,
         pg_get_function_result(oid) as res, pg_get_function_arguments(oid) as args, prolang
    into a from pg_proc p where oid = 'public.framing_next_headline(text)'::regprocedure;

  if a.m <> '56fd752b4bd8f15bd843c24d5769548c' or a.len <> 3616 then
    raise exception '168: unexpected body (md5 %, length %)', a.m, a.len;
  end if;
  if a.m = b.m then raise exception '168: the body did not change'; end if;
  if a.grants is distinct from b.grants then raise exception '168: grants changed: % -> %', b.grants, a.grants; end if;
  if a.cfg is distinct from b.cfg or a.provolatile <> b.provolatile or a.prosecdef <> b.prosecdef or a.proretset <> b.proretset
     or a.owner <> b.owner or a.res <> b.res or a.args <> b.args or a.prolang <> b.prolang then
    raise exception '168: an attribute other than the body changed';
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'framing_next_headline') <> 1 then
    raise exception '168: more than one framing_next_headline overload';
  end if;
  -- the second apply left the first apply's result
  select * into f from after_168_first;
  if f.m <> a.m then raise exception '168: the second apply changed the body'; end if;
  if has_function_privilege('anon', 'public.framing_next_headline(text)', 'execute')
     or has_function_privilege('authenticated', 'public.framing_next_headline(text)', 'execute')
     or not has_function_privilege('service_role', 'public.framing_next_headline(text)', 'execute') then
    raise exception '168: execute privileges are not service_role only';
  end if;
  if obj_description('public.framing_next_headline(text)'::regprocedure, 'pg_proc') not like '%168%' then
    raise exception '168: the function comment does not name 168';
  end if;
  -- 168 records its own ledger row, once even though it was applied twice
  if (select count(*) from supabase_migrations.schema_migrations where version = '168') <> 1
     or (select name from supabase_migrations.schema_migrations where version = '168') <> '168_framing_draw_one_per_event' then
    raise exception '168: the ledger row is not exactly one row named 168_framing_draw_one_per_event';
  end if;
  -- the index: created by 168, once although 168 was applied twice, on (session_hash, article_id); nothing else was added
  if (select count(*) from pg_indexes where schemaname = 'public' and indexname = 'framing_votes_session_hash_article_idx'
        and tablename = 'framing_votes' and indexdef like '%(session_hash, article_id)%') <> 1 then
    raise exception '168: the session_hash index is not exactly one index on (session_hash, article_id)';
  end if;
  if (select count(*) from pg_indexes where schemaname = 'public' and tablename = 'framing_votes') <> 4 then
    raise exception '168: framing_votes should have its three 068 indexes plus the new one, nothing more';
  end if;
  -- the tables are untouched: still owner-only (pool) and still empty
  if has_table_privilege('anon', 'public.framing_candidate_pool', 'select') or exists (select 1 from public.framing_candidate_pool)
     or exists (select 1 from public.framing_votes) then
    raise exception '168: a table changed';
  end if;
end $$;

-- 2. The fix: the same fixture, the same vote. ----------------------------------------------------------------------
begin;
select pg_temp.load_story();
do $$
declare hash text := repeat('b', 64); d int[];
begin
  perform pg_temp.fx_vote(hash, 1);
  d := pg_temp.draws(hash, 300);
  -- the only other event is article 6: never a copy of the voted story, never the voted article
  if exists (select 1 from unnest(d) x where x <> 6) then
    raise exception '168: a voted story came back: %', d;
  end if;
  -- another session is not affected by this one's vote
  if not exists (select 1 from unnest(pg_temp.fresh_draws(200)) x where x between 1 and 5) then
    raise exception '168: a different session should still get the story';
  end if;
  -- once the other event is voted on too, nothing is left
  perform pg_temp.fx_vote(hash, 6);
  if exists (select 1 from unnest(pg_temp.draws(hash, 30)) x where x <> 0) then
    raise exception '168: with every event voted on the draw should return no row';
  end if;
end $$;
rollback;

-- 3. Every event has the same chance: five copies against one is about 50 / 50 (the old function gave 83 / 17). -----
begin;
select pg_temp.load_story();
do $$
declare d int[] := pg_temp.fresh_draws(800); a int;
begin
  select count(*) into a from unnest(d) x where x between 1 and 5;
  if a < 320 or a > 480 then
    raise exception '168: the five-copy story should be drawn about half the time, got % of 800', a;
  end if;
end $$;
rollback;

-- 4. Identical text: another cluster, no cluster, other case and spacing. ---------------------------------------------
begin;
select pg_temp.fx_article(1, 'Same  Headline', 1);
select pg_temp.fx_article(2, 'same headline', 2);
select pg_temp.fx_article(3, E'SAME\theadline', null);
select pg_temp.fx_article(4, 'Something else', 3);
do $$
declare hash text := repeat('c', 64); d int[];
begin
  perform pg_temp.fx_vote(hash, 1);
  d := pg_temp.draws(hash, 200);
  if exists (select 1 from unnest(d) x where x <> 4) then
    raise exception '168: the same text came back under another cluster or none: %', d;
  end if;
end $$;
rollback;

-- 5. A voted article that has aged out of the pool still excludes its cluster and its text. ---------------------------
begin;
select pg_temp.fx_article(1, 'Aged out story', 1, interval '60 hours', false);
select pg_temp.fx_article(2, 'A sibling in the same cluster', 1);
select pg_temp.fx_article(3, 'aged   OUT story', 2);
select pg_temp.fx_article(4, 'Unrelated', 3);
do $$
declare hash text := repeat('d', 64); d int[];
begin
  perform pg_temp.fx_vote(hash, 1);
  d := pg_temp.draws(hash, 200);
  if exists (select 1 from unnest(d) x where x <> 4) then
    raise exception '168: an aged-out voted article stopped excluding its cluster or text: %', d;
  end if;
end $$;
rollback;

-- 6. A null pool title is not swallowed by the voted-title exclusion. -------------------------------------------------
begin;
select pg_temp.fx_article(1, 'Voted story', 1);
select pg_temp.fx_article(2, 'Untitled in the pool', null);
update public.framing_candidate_pool set title = null where article_id = pg_temp.au(2);
do $$
declare hash text := repeat('e', 64); d int[];
begin
  perform pg_temp.fx_vote(hash, 1);
  d := pg_temp.draws(hash, 50);
  if exists (select 1 from unnest(d) x where x <> 2) then
    raise exception '168: the null-title row should be the only draw, got %', d;
  end if;
end $$;
rollback;

-- 7. Nothing was left behind by the scenarios above. ---------------------------------------------------------------
do $$
begin
  if exists (select 1 from public.framing_candidate_pool) or exists (select 1 from public.framing_votes)
     or exists (select 1 from public.articles) or exists (select 1 from public.sources) or exists (select 1 from public.clusters) then
    raise exception 'a rolled-back fixture survived';
  end if;
end $$;

select 'DRYRUN 168 OK';
