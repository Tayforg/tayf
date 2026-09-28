-- 079_social_posts.sql
--
-- The owned-channels auto-poster (Telegram + Bluesky) posts blindspots and
-- top stories automatically. `social_posts` is its ledger and the ONLY
-- place that decides whether a (channel, cluster) pair has already been
-- posted.
--
-- IDEMPOTENCY DESIGN: claim before post, never post before claim.
-- `social_post_claim` is the single writer of new rows and is the ONLY
-- function the cron route calls before it actually posts anything. It
-- INSERTs with `on conflict (channel, cluster_id) do nothing` inside a
-- transaction that also holds a per-channel advisory lock
-- (`pg_advisory_xact_lock`), so two concurrent cron invocations (a retry
-- racing the original tick, or two overlapping crons) cannot both claim
-- the same pair: the unique constraint makes a double post structurally
-- impossible, and the advisory lock makes the daily-cap COUNT the second
-- claimant reads already include the first claimant's fresh row (avoiding
-- a race where both readers see the cap as not-yet-reached). The caller
-- only posts to Telegram/Bluesky AFTER it holds a non-null claim id
-- returned by this function — never before.
--
-- KILL SWITCHES: none live in this migration (they are pure env vars —
-- SOCIAL_POST_DISABLED / SOCIAL_POST_DRY_RUN, read by
-- src/lib/social/config.ts). The ONE database-side kill switch this
-- migration does add is `p_daily_cap`, an argument to `social_post_claim`
-- (default 8): once a channel has `p_daily_cap` pending/posted rows in the
-- trailing 24h, every further claim on that channel returns null for the
-- rest of the window, regardless of how many times the cron fires.
--
-- ADDITIVE ONLY: one new table, two new indexes, two new SECURITY DEFINER
-- functions, RLS enabled with no policies (service_role bypasses RLS by
-- design; no anon/authenticated/public grant exists at any layer). No
-- existing table, column, index, policy, trigger, or cron job is touched.
-- Safe to re-apply: `create table if not exists`, `create index if not
-- exists`, `create or replace function`, and the ledger insert's `on
-- conflict do nothing`.

begin;

create table if not exists public.social_posts (
  id          bigserial primary key,
  channel     text not null check (channel in ('telegram', 'bluesky')),
  kind        text not null check (kind in ('blindspot', 'top_story')),
  cluster_id  uuid not null references public.clusters(id) on delete cascade,
  status      text not null default 'pending' check (status in ('pending', 'posted', 'failed')),
  body        text not null check (char_length(body) between 1 and 4096),
  external_id text check (external_id is null or char_length(external_id) <= 300),
  error       text check (error is null or char_length(error) <= 500),
  created_at  timestamptz not null default now(),
  finished_at timestamptz,
  unique (channel, cluster_id)
);

create index if not exists social_posts_channel_created_idx on public.social_posts (channel, created_at desc);
create index if not exists social_posts_cluster_idx on public.social_posts (cluster_id);  -- FK cascade needs its own index

comment on table public.social_posts is
  'Ledger for the owned-channels auto-poster (Telegram + Bluesky). One row '
  'per (channel, cluster) pair -- the unique constraint makes a double post '
  'structurally impossible. Rows are inserted only by social_post_claim '
  '(claim-before-post) and transitioned only by social_post_finish. No '
  'anon/authenticated/public access at any layer; service_role reads '
  'directly and writes only through the two SECURITY DEFINER functions '
  'below (no table-level insert/update grant, even to service_role).';

comment on column public.social_posts.status is
  'pending: claimed, not yet posted. posted: the channel API call '
  'succeeded and external_id is set. failed: the channel API call failed; '
  'never retried automatically (a fresh claim needs a different cluster '
  'or channel, the unique constraint forbids re-claiming this pair).';

alter table public.social_posts enable row level security;
revoke all on public.social_posts from anon, authenticated, public;
grant select on public.social_posts to service_role;
revoke all on sequence public.social_posts_id_seq from anon, authenticated, public;
-- no sequence grant: every insert happens inside the definer function

create or replace function public.social_post_claim(
  p_channel     text,
  p_kind        text,
  p_cluster_id  uuid,
  p_body        text,
  p_daily_cap   integer default 8
) returns bigint
language plpgsql volatile security definer set search_path = ''
as $fn$
declare
  v_id     bigint;
  v_recent integer;
begin
  if p_channel is null or p_cluster_id is null or p_body is null then
    return null;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('social_post_claim:' || p_channel)::bigint);
  select count(*)::integer into v_recent
    from public.social_posts s
   where s.channel = p_channel
     and s.created_at > now() - interval '24 hours'
     and s.status in ('pending', 'posted');
  if v_recent >= greatest(coalesce(p_daily_cap, 8), 0) then
    return null;
  end if;
  insert into public.social_posts (channel, kind, cluster_id, body)
  values (p_channel, p_kind, p_cluster_id, p_body)
  on conflict (channel, cluster_id) do nothing
  returning id into v_id;
  return v_id;
end
$fn$;

comment on function public.social_post_claim(text, text, uuid, text, integer) is
  'Claim-before-post: takes a per-channel advisory lock, checks the '
  'trailing-24h daily cap, then inserts with on conflict (channel, '
  'cluster_id) do nothing. Returns the new row id, or null if the cap was '
  'hit or the pair was already claimed. Callers MUST NOT post to a '
  'channel before this returns a non-null id.';

create or replace function public.social_post_finish(
  p_id          bigint,
  p_status      text,
  p_external_id text default null,
  p_error       text default null
) returns boolean
language plpgsql volatile security definer set search_path = ''
as $fn$
begin
  if p_status is null or p_status not in ('posted', 'failed') then
    return false;
  end if;
  update public.social_posts s
     set status = p_status,
         external_id = left(p_external_id, 300),
         error = left(p_error, 500),
         finished_at = now()
   where s.id = p_id
     and s.status = 'pending';
  return found;
end
$fn$;

comment on function public.social_post_finish(bigint, text, text, text) is
  'Transitions a claimed row from pending to posted/failed. Only ever '
  'touches a row still in pending -- a second finish call on the same id '
  'is a no-op (returns false), which keeps this idempotent against a retry '
  'racing itself.';

revoke all on function public.social_post_claim(text, text, uuid, text, integer) from anon, authenticated, public;
revoke all on function public.social_post_finish(bigint, text, text, text) from anon, authenticated, public;
grant execute on function public.social_post_claim(text, text, uuid, text, integer) to service_role;
grant execute on function public.social_post_finish(bigint, text, text, text) to service_role;

insert into supabase_migrations.schema_migrations (version, name)
  values ('079', '079_social_posts')
  on conflict do nothing;

commit;
