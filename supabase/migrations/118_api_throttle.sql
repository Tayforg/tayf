-- 118_api_throttle.sql
--
-- Finding (web-2 medium, web-3 low): POST /api/oyun and POST /api/corrections
-- are anonymous, unauthenticated writes whose only throttle is the
-- module-level Map in src/lib/rate-limit.ts. That limiter is process-local:
-- on Vercel serverless every instance starts with an empty Map and a cold
-- start resets it, so the effective cap is "per instance", not per client.
-- Rotating IPs also defeats it. Two concrete consequences:
--   * /oyun guesses feed the per-outlet "okur tahmini" figure (U-03). One
--     scripted client could stuff zone_guesses for a single outlet and move
--     that published share (web-3).
--   * /api/corrections lets one client fill the admin review queue (web-2).
--
-- This migration adds a generic, DB-backed sliding-window counter that holds
-- across every instance because it lives in Postgres. It sits BEHIND the
-- existing in-memory limiter (kept as the cheap first filter against a
-- single-instance flood) and in front of the insert.
--
-- Interface: public.api_throttle(p_bucket, p_key_hash, p_limit,
-- p_window_seconds) returns (allowed, retry_after_seconds). One call counts
-- the hits for (bucket, key_hash) inside the window and, if under the limit,
-- records one more. Blocked hits are NOT recorded (see the guard below), so a
-- lockout always ends exactly p_window_seconds after the OLDEST counted hit,
-- no matter how often a blocked client retries: retrying can never extend or
-- refresh the lockout.
--
-- Thresholds (chosen by the callers, validated here: limit 1..1000, window
-- 1..86400 seconds; the bucket is a short lowercase token):
--   * oyun:all                  40 hits / 1 hour  per client (any outlet)
--   * oyun:src:<source uuid>     3 hits / 1 day   per client, per outlet
--   * corrections:all            5 hits / 1 hour  per client
-- Together with AGREEMENT_MIN_GUESSES = 100 (src/lib/game/agreement.ts), one
-- client needs roughly 34 days from one IP (3/day), or ~34 distinct IPs, to
-- fill the publication threshold for one outlet alone. This raises the bar;
-- it is not poison-proof, which is why the share is always shown with its n.
--
-- Concurrency: the check-then-insert is serialised with a transaction-level
-- advisory lock keyed on hashtextextended(bucket || ':' || key_hash), so two
-- simultaneous requests from the SAME client can never both observe "under
-- the limit" and both insert, while unrelated clients never wait on each
-- other (086 used one global lock; that would serialise every reader here).
--
-- Retention: rows older than 1 day are swept inline, at most 500 per call
-- (bounded work per request; each call inserts at most one row, so the sweep
-- always outpaces growth). The sweep skips rows another sweep holds, so two
-- concurrent sweeps can neither block nor deadlock each other. No pg_cron.
-- The largest window (86400 s) equals the retention, so a row still inside
-- any window is never swept.
--
-- Privacy (KVKK): the raw client IP is never stored or logged. Only a keyed
-- HMAC-SHA256 digest is written:
--   key_hash = HMAC-SHA256(subkey, clientKey)
--   subkey   = HMAC-SHA256(ADMIN_SESSION_SECRET, 'tayf/api-throttle/v1')
-- computed in src/lib/api/db-throttle.ts. The domain-separation label keeps
-- this digest unrelated to the admin-login digest (086) and to the session
-- cookie HMAC that also derive from ADMIN_SESSION_SECRET. The client key is
-- the IP ONLY: the User-Agent is deliberately not mixed in, because it is
-- attacker-controlled and would let one IP mint unlimited buckets. The table
-- holds (bucket, digest, timestamp) for at most a day.
--
-- Fail-open lives in the app, not here: a missing/short secret, an RPC error,
-- a 3 s timeout, or a malformed row all ALLOW the request (the callers are a
-- game and a feedback form, which must not go down because the throttle did).
-- This function itself raises 22023 on any invalid argument.
--
-- Privileges: the table is service-internal. RLS is on with no policies, and
-- every table, sequence and (PG17) MAINTAIN grant is revoked from anon,
-- authenticated and public, per the 091/095 convention (Supabase default
-- privileges would otherwise hand a new table to anon/authenticated). The
-- function is SECURITY DEFINER with an empty search_path and is executable by
-- service_role only; nothing is publicly readable.
--
-- Operator reset, if a bucket ever needs clearing by hand (as postgres):
--   delete from public.api_throttle_hits;
--
-- Additive only: one new table, two new indexes, one new SECURITY DEFINER
-- function. No existing table, column, index, policy or function is touched.
-- Safe to re-apply (`create table if not exists`, `create index if not
-- exists`, `create or replace function`, idempotent revokes, ledger insert
-- `on conflict do nothing`).
--
-- Deploy order: apply this migration BEFORE the Vercel deploy that ships
-- src/lib/api/db-throttle.ts and the updated /api/oyun and /api/corrections
-- routes. Until it has run those routes simply fail open (RPC error ->
-- degraded -> allowed), so the order is safe either way. Make sure
-- ADMIN_SESSION_SECRET (>= 16 characters) is set in the Vercel environment;
-- without it the DB throttle is skipped (fail-open) and only the in-memory
-- limiter applies.

begin;
set local lock_timeout = '5s';

create table if not exists public.api_throttle_hits (
  id bigint generated always as identity primary key,
  bucket text not null check (bucket ~ '^[a-z0-9:_-]{1,80}$'),
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  hit_at timestamptz not null default now()
);

create index if not exists api_throttle_hits_bucket_key_time_idx
  on public.api_throttle_hits (bucket, key_hash, hit_at desc);

create index if not exists api_throttle_hits_time_idx
  on public.api_throttle_hits (hit_at);

alter table public.api_throttle_hits enable row level security;

-- Supabase default privileges hand new tables to anon/authenticated (incl.
-- write grants, cf. 091/095): strip them. Nothing here is publicly readable,
-- and service_role reaches the table only through the SECURITY DEFINER
-- function below.
revoke all on public.api_throttle_hits from anon, authenticated, public, service_role;

-- The identity column owns a sequence; default privileges grant that too.
do $seq$
declare
  v_seq text := pg_catalog.pg_get_serial_sequence('public.api_throttle_hits', 'id');
begin
  if v_seq is not null then
    execute pg_catalog.format('revoke all on sequence %s from anon, authenticated, public', v_seq);
  end if;
end
$seq$;

-- PG17 added MAINTAIN; it does not exist before PG17, so guard.
do $maint$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on public.api_throttle_hits from anon, authenticated';
  end if;
end
$maint$;

comment on table public.api_throttle_hits is
  'HMAC-hashed client key + bucket + timestamp only (no raw IP, no user '
  'agent); written/read only by api_throttle(); 1-day retention swept '
  'inline by that function; migration 118.';

create or replace function public.api_throttle(
  p_bucket text,
  p_key_hash text,
  p_limit integer,
  p_window_seconds integer
)
returns table (allowed boolean, retry_after_seconds integer)
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  c_retention constant interval := interval '1 day';
  c_sweep     constant integer  := 500;
  v_window    interval;
  v_now       timestamptz;
  v_n         integer;
  v_first     timestamptz;
begin
  if p_bucket is null or p_bucket !~ '^[a-z0-9:_-]{1,80}$' then
    raise exception 'api_throttle: invalid bucket' using errcode = '22023';
  end if;
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'api_throttle: invalid key' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'api_throttle: invalid limit' using errcode = '22023';
  end if;
  if p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'api_throttle: invalid window' using errcode = '22023';
  end if;

  v_window := pg_catalog.make_interval(secs => p_window_seconds::double precision);

  -- Serialise check-then-insert PER (bucket, key): two simultaneous requests
  -- from one client can never both observe "under the limit" and both
  -- insert, pushing the count past p_limit. Other clients are unaffected.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_bucket || ':' || p_key_hash, 118)
  );

  -- Read the clock AFTER the lock: a request that waited for it must not
  -- stamp (or measure the window from) a time before its predecessor's hit.
  v_now := pg_catalog.clock_timestamp();

  -- Bounded retention sweep (see header). skip locked: never wait on, or
  -- deadlock with, a concurrent sweep touching the same rows.
  delete from public.api_throttle_hits
    where id in (
      select t.id
        from public.api_throttle_hits t
        where t.hit_at < v_now - c_retention
        limit c_sweep
        for update skip locked
    );

  select pg_catalog.count(*)::integer, pg_catalog.min(h.hit_at)
    into v_n, v_first
    from public.api_throttle_hits h
    where h.bucket = p_bucket
      and h.key_hash = p_key_hash
      and h.hit_at > v_now - v_window;

  if v_n >= p_limit then
    -- Blocked hits are NOT recorded: the lockout always ends v_window after
    -- the oldest counted hit, however many more times the caller retries
    -- while blocked.
    allowed := false;
    retry_after_seconds := greatest(
      1,
      pg_catalog.ceil(extract(epoch from (v_first + v_window - v_now)))::integer
    );
    return next;
    return;
  end if;

  insert into public.api_throttle_hits (bucket, key_hash, hit_at)
    values (p_bucket, p_key_hash, v_now);
  allowed := true;
  retry_after_seconds := 0;
  return next;
end
$fn$;

comment on function public.api_throttle(text, text, integer, integer) is
  'Records one allowed hit atomically for (bucket, key_hash) and returns '
  'whether it is allowed under p_limit hits per p_window_seconds sliding '
  'window and, if not, how many seconds until the oldest counted hit ages '
  'out. Blocked hits are never recorded. Raises 22023 on invalid arguments. '
  'Sweeps up to 500 rows older than 1 day per call. service_role only; '
  'migration 118.';

revoke all on function public.api_throttle(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.api_throttle(text, text, integer, integer) to service_role;

insert into supabase_migrations.schema_migrations (version, name)
  values ('118', '118_api_throttle')
  on conflict do nothing;

commit;
