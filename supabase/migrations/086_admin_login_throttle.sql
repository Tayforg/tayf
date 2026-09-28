-- 086_admin_login_throttle.sql
--
-- Finding: src/lib/rate-limit.ts:29 keeps its buckets in a module-level Map.
-- Its own module doc says this is "intentionally process-local" and
-- inadequate on Vercel serverless, where every invocation can land on a
-- fresh instance with an empty Map. src/app/admin/login/actions.ts:17-20 is
-- the ONLY throttle in front of checkAdminPassword (src/lib/admin/
-- session.ts:120-125), an scrypt + timingSafeEqual compare against the
-- single shared ADMIN_PASSWORD. The throttle is keyed on clientKey(), which
-- is per IP (see rate-limit.ts's own "OPEN VERIFICATION ITEM" about which
-- Vercel headers are actually set), so rotating IPs bypasses even the
-- single-instance limiter, and a fresh instance resets it to zero.
--
-- This migration adds a second, DB-backed layer that holds across every
-- Vercel instance because it lives in Postgres, not process memory. It sits
-- behind the existing in-memory limiter (cheap first filter against a
-- single-instance flood) and in front of the 250ms sleep + checkAdminPassword
-- (unchanged; the constant-time compare is untouched).
--
-- Thresholds, sized for one human admin and mirroring the existing
-- in-memory capacity of 5:
--   * per client key: 5 attempts / 15 minutes
--   * globally:       50 attempts / 15 minutes -- caps distributed brute
--     force of the one shared password at ~4,800 guesses/day regardless of
--     how many IPs the attacker rotates through.
--   * rows are retained for 1 day and swept inline on every call (no
--     pg_cron job -- login attempts are infrequent enough that piggybacking
--     the delete on the next call is sufficient).
--
-- Blocked attempts are NOT recorded (see the guard below): only successful
-- (allowed) attempts are inserted. This means a lockout always ends exactly
-- `c_window` after the OLDEST counted attempt, no matter how many more
-- times the attacker retries while blocked -- retrying can never extend or
-- refresh the lockout, so it never becomes permanent.
--
-- Fail-closed is implemented in application code (src/lib/admin/
-- login-throttle.ts), not here: any Supabase/network error, a 3s timeout, a
-- missing/short ADMIN_SESSION_SECRET, or a malformed RPC row all deny the
-- login attempt with a generic message. The next attempt simply retries the
-- RPC, so a transient DB hiccup can never lock the admin out permanently.
--
-- Privacy (KVKK): the raw client IP and the password are never stored or
-- logged. Only a keyed HMAC-SHA256 digest of the client key is written:
--   key_hash = HMAC-SHA256(subkey, clientKey)
--   subkey   = HMAC-SHA256(ADMIN_SESSION_SECRET, 'tayf/admin-login-throttle/v1')
-- The domain-separation label keeps this digest unrelated to (and
-- non-invertible from) the session-cookie HMAC that also derives from
-- ADMIN_SESSION_SECRET (src/lib/admin/session.ts).
--
-- Escape hatch for the operator, if the throttle ever needs a manual reset
-- (e.g. after rotating ADMIN_PASSWORD following a suspected leak):
--   delete from public.admin_login_attempts;
--
-- Additive only: one new table, two new indexes, RLS enabled with no
-- policies (service_role only, via REVOKE/GRANT), and one new SECURITY
-- DEFINER function. No existing table, column, index, policy or function is
-- touched. Safe to re-apply (`create table if not exists`, `create index if
-- not exists`, `create or replace function`, ledger insert `on conflict do
-- nothing`).
--
-- Apply before the Vercel deploy that ships src/lib/admin/login-throttle.ts
-- and the updated src/app/admin/login/actions.ts -- those modules call
-- public.admin_login_throttle(text) and will fail closed (safely) until
-- this migration has run.

begin;
set local lock_timeout = '5s';

create table if not exists public.admin_login_attempts (
  id bigint generated always as identity primary key,
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  attempted_at timestamptz not null default now()
);

create index if not exists admin_login_attempts_key_time_idx
  on public.admin_login_attempts (key_hash, attempted_at desc);

create index if not exists admin_login_attempts_time_idx
  on public.admin_login_attempts (attempted_at);

alter table public.admin_login_attempts enable row level security;

revoke all on public.admin_login_attempts from anon, authenticated, public, service_role;

comment on table public.admin_login_attempts is
  'HMAC-hashed client key + timestamp only (no raw IP, no password); '
  'written/read only by admin_login_throttle(); 1-day retention swept '
  'inline by that function; migration 086.';

create or replace function public.admin_login_throttle(p_key_hash text)
returns table (allowed boolean, retry_after_seconds integer)
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  c_window    constant interval := interval '15 minutes';
  c_per_key   constant integer  := 5;
  c_global    constant integer  := 50;
  c_retention constant interval := interval '1 day';
  v_now       timestamptz := pg_catalog.now();
  v_key_n integer;
  v_key_first timestamptz;
  v_all_n integer;
  v_all_first timestamptz;
  v_retry integer := 0;
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'admin_login_throttle: invalid key' using errcode = '22023';
  end if;

  -- Serialise check-then-insert across concurrent Vercel instances so two
  -- simultaneous requests can never both observe "under the cap" and both
  -- insert, pushing the count past c_per_key / c_global.
  perform pg_catalog.pg_advisory_xact_lock(86086086);

  delete from public.admin_login_attempts a where a.attempted_at < v_now - c_retention;

  select pg_catalog.count(*)::integer, pg_catalog.min(a.attempted_at)
    into v_key_n, v_key_first
    from public.admin_login_attempts a
    where a.key_hash = p_key_hash and a.attempted_at > v_now - c_window;

  select pg_catalog.count(*)::integer, pg_catalog.min(a.attempted_at)
    into v_all_n, v_all_first
    from public.admin_login_attempts a
    where a.attempted_at > v_now - c_window;

  if v_key_n >= c_per_key then
    v_retry := greatest(v_retry, pg_catalog.ceil(extract(epoch from (v_key_first + c_window - v_now)))::integer);
  end if;

  if v_all_n >= c_global then
    v_retry := greatest(v_retry, pg_catalog.ceil(extract(epoch from (v_all_first + c_window - v_now)))::integer);
  end if;

  if v_key_n >= c_per_key or v_all_n >= c_global then
    -- Blocked attempts are NOT recorded: the lockout always ends c_window
    -- after the oldest counted attempt, however many more times the
    -- caller retries while blocked.
    allowed := false;
    retry_after_seconds := greatest(v_retry, 1);
    return next;
    return;
  end if;

  insert into public.admin_login_attempts (key_hash, attempted_at) values (p_key_hash, v_now);
  allowed := true;
  retry_after_seconds := 0;
  return next;
end
$fn$;

comment on function public.admin_login_throttle(text) is
  'Records one allowed admin-login attempt atomically (per-key + global '
  'sliding-window counters over the last 15 minutes) and returns whether '
  'this attempt is allowed and, if not, how many seconds until the oldest '
  'counted attempt ages out. 5 attempts per key, 50 globally, per 15 '
  'minutes. Blocked attempts are never recorded. service_role only; '
  'migration 086.';

revoke all on function public.admin_login_throttle(text) from anon, authenticated, public;
grant execute on function public.admin_login_throttle(text) to service_role;

insert into supabase_migrations.schema_migrations (version, name)
  values ('086', '086_admin_login_throttle')
  on conflict do nothing;

commit;
