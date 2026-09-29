-- 098_story_threads.sql
--
-- "Gelisen hikaye" (developing story) threads: an editor-curated chain of
-- clusters that belong to one running story, rendered day by day at
-- /hikaye/[slug]. A nightly job only PROPOSES cluster pairs; an admin
-- approves them, titles the thread and presses Yayinla. NOTHING IS EVER
-- AUTO-PUBLISHED: no function in this file writes story_threads.status, and
-- a new thread from story_thread_approve_candidate() is a title-less,
-- slug-less draft (the story_threads_publishable CHECK also forbids
-- publishing one).
--
-- DEFINITIONS (pinned; mirrored in src/lib/story-threads/config.ts and
-- docs/story-threads.md, parity-tested by tests/migrations/098-story-threads.test.ts)
--   * Base set: clusters with first_published in the last p_days days
--     (default 14, clamped 1..30), NOT archived, article_count >= 3.
--   * Signal: pg_trgm is not installed and articles.entities is empty, so the
--     link signal is an IDF-weighted overlap of TITLE LEXEMES (turkish
--     stemmer over title_tr_neutral || title_tr), plus time adjacency and
--     topic7. No trigram signal, no entity signal.
--   * Terms: lexemes of length >= 4, not purely numeric. Document frequency
--     df over the base set; a term is DISTINCTIVE when 2 <= df <=
--     greatest(3, floor(0.02 * base size)) (the DF cap drops generic words
--     such as "ozel"). Per cluster keep the 5 rarest distinctive terms
--     (ties by lexeme), idf = ln(base size / df).
--   * Pair: two clusters sharing >= 2 kept terms, first_published <= 72 h
--     apart. jac = shared idf / (idf sum of A + idf sum of B - shared idf).
--   * confidence = 0.60 * jac + 0.25 * (1 - hours/72) + 0.15 * topic
--     (topic = 1 same topic7, 0 different, 0.5 unknown). Proposed at >= 0.40,
--     at most 500 rows per run, best first.
--   * A pair is skipped when BOTH clusters already sit in a thread.
--   * Re-runs only refresh PENDING rows (confidence, terms, last_seen_at).
--     Rejected and approved pairs are never reopened. Pending/rejected rows
--     not seen for 30 days are deleted.
--
-- STEP 0 MEASUREMENTS (production, 2026-09-29, read-only SELECT of the
-- candidate query with v_since = now() - 14 days, single request incl. HTTP):
--   runtime        : < 1 s (0.6 s wall clock, limit was 30 s)
--   base size      : 1,390 clusters
--   pairs <= 72 h  : 618 (2+ shared terms); 476 at confidence >= 0.40
--                    (74 at >= 0.70, 144 at 0.55-0.70, 258 at 0.40-0.55)
--   top 20 by conf : 3 look like false merges (recurring headlines:
--                    "New York borsasi dususle acildi" 24 h apart, the daily
--                    "Son dakika depremler" page 25 vs 24 Eylul, and the
--                    Anadolu vs Avrupa Otoyolu toll pair); about 8 more are
--                    near-duplicate clusters of the SAME event at 0-1 h apart
--                    (not developments; the admin rejects or ignores them).
--                    Thresholds were NOT tuned; the admin queue is the filter.
--
-- Additive only: three new tables, two new functions, one cron job. Nothing
-- existing is altered. The zone bar on the public page reuses the app-side
-- BIAS_TO_ZONE; no zone map is copied here.
--
-- GRANTS
--   * story_threads, story_thread_members: SELECT for anon/authenticated,
--     limited by RLS policies to PUBLISHED threads. service_role: full DML.
--   * story_thread_candidates: service_role only (RLS on, no policy, no
--     anon/authenticated grant).
--   * Supabase default grants (incl. write grants, cf. 091/095) are revoked
--     first; INSERT/UPDATE/DELETE/TRUNCATE/MAINTAIN are never granted to
--     anon or authenticated.
--   * Both functions: execute for service_role only.
--
-- ROLLBACK (manual; nothing depends on these objects):
--   begin;
--   select cron.unschedule('story-thread-candidates');
--   drop function if exists public.story_thread_approve_candidate(bigint);
--   drop function if exists public.story_thread_candidates_refresh(integer);
--   drop table if exists public.story_thread_candidates;
--   drop table if exists public.story_thread_members;
--   drop table if exists public.story_threads;
--   delete from supabase_migrations.schema_migrations where version = '098';
--   commit;
-- Soft kill without a rollback: set STORY_THREADS=off (hides the cluster-page
-- link); unpublish threads from /admin/hikayeler.

begin;

-- 1. Tables ---------------------------------------------------------------------

create table if not exists public.story_threads (
  id uuid primary key default gen_random_uuid(),
  slug text unique check (slug is null or (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 3 and 80)),
  title_tr text check (title_tr is null or char_length(btrim(title_tr)) between 8 and 140),
  status text not null default 'draft' check (status in ('draft','published')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), published_at timestamptz,
  constraint story_threads_publishable check (status <> 'published' or (slug is not null and title_tr is not null and published_at is not null)));

create table if not exists public.story_thread_members (
  thread_id uuid not null references public.story_threads(id) on delete cascade,
  cluster_id uuid not null references public.clusters(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (thread_id, cluster_id), constraint story_thread_members_cluster_once unique (cluster_id));

create table if not exists public.story_thread_candidates (
  id bigint generated always as identity primary key,
  cluster_a uuid not null references public.clusters(id) on delete cascade,
  cluster_b uuid not null references public.clusters(id) on delete cascade,
  confidence numeric(4,3) not null check (confidence between 0 and 1),
  shared_terms text[] not null default '{}', hours_apart numeric(6,1) not null check (hours_apart >= 0), same_topic boolean,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  thread_id uuid references public.story_threads(id) on delete set null,
  proposed_at timestamptz not null default now(), last_seen_at timestamptz not null default now(), reviewed_at timestamptz,
  constraint story_thread_candidates_ordered check (cluster_a < cluster_b),
  constraint story_thread_candidates_pair unique (cluster_a, cluster_b));

create index if not exists story_thread_candidates_pending_idx on public.story_thread_candidates (confidence desc) where status = 'pending';
create index if not exists story_thread_candidates_cluster_b_idx on public.story_thread_candidates (cluster_b);
create index if not exists story_thread_candidates_thread_idx on public.story_thread_candidates (thread_id) where thread_id is not null;

comment on table public.story_threads is
  'Editor-curated "Gelisen hikaye" threads (migration 098). Public read only when status = published.';
comment on table public.story_thread_members is
  'Cluster membership of a thread; a cluster belongs to at most one thread.';
comment on table public.story_thread_candidates is
  'Nightly proposed cluster pairs awaiting admin review. service_role only.';

-- 2. RLS and grants -----------------------------------------------------------------

alter table public.story_threads enable row level security;
alter table public.story_thread_members enable row level security;
alter table public.story_thread_candidates enable row level security;

-- Supabase default privileges hand new tables to anon/authenticated (incl.
-- write grants, cf. 091/095): strip them, then grant back only what is meant.
revoke all on public.story_threads, public.story_thread_members, public.story_thread_candidates from anon, authenticated, public;

-- PG17 added the MAINTAIN privilege; it does not exist before PG17 (revoking
-- it would be a syntax error), so guard.
do $maint$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on public.story_threads, public.story_thread_members, public.story_thread_candidates from anon, authenticated';
  end if;
end
$maint$;

grant select on public.story_threads, public.story_thread_members to anon, authenticated;
grant select, insert, update, delete on public.story_threads, public.story_thread_members, public.story_thread_candidates to service_role;

drop policy if exists "public read published story_threads" on public.story_threads;
create policy "public read published story_threads" on public.story_threads
  for select to anon, authenticated using (status = 'published');

drop policy if exists "public read published story_thread_members" on public.story_thread_members;
create policy "public read published story_thread_members" on public.story_thread_members
  for select to anon, authenticated using (exists (select 1 from public.story_threads t where t.id = story_thread_members.thread_id and t.status = 'published'));

-- 3. Candidate refresh ---------------------------------------------------------------

create or replace function public.story_thread_candidates_refresh(
  p_days integer default 14
) returns integer
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_days  integer := least(greatest(coalesce(p_days, 14), 1), 30);
  v_now   timestamptz := pg_catalog.now();
  v_since timestamptz;
  v_n     integer := 0;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtext('story_thread_candidates_refresh')::bigint
  ) then
    return 0;
  end if;

  v_since := v_now - pg_catalog.make_interval(days => v_days);

  delete from public.story_thread_candidates
   where status <> 'approved' and last_seen_at < v_now - interval '30 days';

  with base as (select c.id, c.first_published, c.topic7,
      pg_catalog.to_tsvector('pg_catalog.turkish'::regconfig, coalesce(c.title_tr_neutral,'') || ' ' || coalesce(c.title_tr,'')) tv
    from public.clusters c where c.first_published >= v_since and c.is_archived = false and c.article_count >= 3),
  nb as (select greatest(count(*),1)::numeric n from base),
  terms as (select b.id, t.lex from base b cross join lateral pg_catalog.unnest(pg_catalog.tsvector_to_array(b.tv)) t(lex)
    where pg_catalog.char_length(t.lex) >= 4 and t.lex !~ '^[0-9]+$'),
  df as (select lex, count(*)::numeric n from terms group by lex),
  ranked as (select t.id, t.lex, pg_catalog.ln(nb.n / d.n) idf, row_number() over (partition by t.id order by d.n, t.lex) rk
    from terms t join df d using (lex) cross join nb where d.n >= 2 and d.n <= greatest(3, pg_catalog.floor(nb.n * 0.02))),
  top_terms as (select id, lex, idf from ranked where rk <= 5),
  tot as (select id, sum(idf) s from top_terms group by id),
  pairs as (select a.id ca, b.id cb, sum(a.idf) shared_idf, array_agg(a.lex order by a.idf desc, a.lex) terms
    from top_terms a join top_terms b on b.lex = a.lex and a.id < b.id group by a.id, b.id having count(*) >= 2),
  scored as (select p.ca, p.cb, p.terms,
      round((abs(extract(epoch from (ba.first_published - bb.first_published))) / 3600.0)::numeric, 1) hours,
      case when ba.topic7 is null or bb.topic7 is null then null else ba.topic7 = bb.topic7 end same_topic,
      p.shared_idf / nullif(ta.s + tb.s - p.shared_idf, 0) jac
    from pairs p join base ba on ba.id = p.ca join base bb on bb.id = p.cb join tot ta on ta.id = p.ca join tot tb on tb.id = p.cb),
  final as (select ca, cb, terms, hours, same_topic,
      round((0.60 * coalesce(jac,0) + 0.25 * greatest(0, 1 - hours / 72.0)
        + 0.15 * case when same_topic is null then 0.5 when same_topic then 1 else 0 end)::numeric, 3) conf
    from scored where hours <= 72)
  insert into public.story_thread_candidates as s (cluster_a, cluster_b, confidence, shared_terms, hours_apart, same_topic, proposed_at, last_seen_at)
  select f.ca, f.cb, f.conf, f.terms, f.hours, f.same_topic, v_now, v_now from final f
   where f.conf >= 0.40
     and not (exists (select 1 from public.story_thread_members m where m.cluster_id = f.ca)
          and exists (select 1 from public.story_thread_members m where m.cluster_id = f.cb))
   order by f.conf desc, f.ca, f.cb limit 500
  on conflict (cluster_a, cluster_b) do update set confidence = excluded.confidence, shared_terms = excluded.shared_terms,
    hours_apart = excluded.hours_apart, same_topic = excluded.same_topic, last_seen_at = excluded.last_seen_at
   where s.status = 'pending';

  get diagnostics v_n = row_count;
  return v_n;
end
$fn$;

comment on function public.story_thread_candidates_refresh(integer) is
  'Proposes cluster pairs for story threads over the last p_days days '
  '(clamped 1..30) by IDF-weighted title-lexeme overlap + time adjacency + '
  'topic7. Never publishes anything. Returns rows inserted/refreshed (0 if '
  'another run holds the advisory lock). service_role only; scheduled '
  'nightly as story-thread-candidates.';

revoke all on function public.story_thread_candidates_refresh(integer) from public, anon, authenticated;
grant execute on function public.story_thread_candidates_refresh(integer) to service_role;

-- 4. Approve -------------------------------------------------------------------------

create or replace function public.story_thread_approve_candidate(
  p_candidate_id bigint
) returns uuid
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_c public.story_thread_candidates%rowtype;
  v_ta uuid;
  v_tb uuid;
  v_t  uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('story_threads_write')::bigint);

  select * into v_c from public.story_thread_candidates where id = p_candidate_id for update;
  if not found or v_c.status <> 'pending' then
    raise exception 'story_thread_candidate_not_pending';
  end if;

  select thread_id into v_ta from public.story_thread_members where cluster_id = v_c.cluster_a;
  select thread_id into v_tb from public.story_thread_members where cluster_id = v_c.cluster_b;
  if v_ta is not null and v_tb is not null and v_ta <> v_tb then
    raise exception 'story_thread_conflict';
  end if;

  v_t := coalesce(v_ta, v_tb);
  if v_t is null then
    -- A new thread is always a title-less, slug-less DRAFT.
    insert into public.story_threads default values returning id into v_t;
  end if;

  insert into public.story_thread_members (thread_id, cluster_id)
    values (v_t, v_c.cluster_a), (v_t, v_c.cluster_b)
    on conflict do nothing;

  update public.story_threads set updated_at = pg_catalog.now() where id = v_t;

  update public.story_thread_candidates
     set status = 'approved', thread_id = v_t, reviewed_at = pg_catalog.now()
   where id = v_c.id;

  return v_t;
end
$fn$;

comment on function public.story_thread_approve_candidate(bigint) is
  'Approves one pending candidate: joins both clusters into one draft thread '
  '(creating it when neither has one). Raises story_thread_candidate_not_pending '
  'or story_thread_conflict. service_role only.';

revoke all on function public.story_thread_approve_candidate(bigint) from public, anon, authenticated;
grant execute on function public.story_thread_approve_candidate(bigint) to service_role;

-- 5. Schedule ------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron not installed — skipping story-thread-candidates schedule (098)';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'story-thread-candidates') then
    perform cron.unschedule('story-thread-candidates');
  end if;
  perform cron.schedule('story-thread-candidates', '53 1 * * *',  -- daily 04:53 TRT, a free slot
    $sql$ set statement_timeout = '5min'; select public.story_thread_candidates_refresh(); $sql$);
end $$;

insert into supabase_migrations.schema_migrations (version, name)
  values ('098', '098_story_threads')
  on conflict do nothing;

commit;
