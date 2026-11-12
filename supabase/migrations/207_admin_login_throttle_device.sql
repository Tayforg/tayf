-- 207_admin_login_throttle_device.sql
--
-- Finding (hunt 156): admin_login_throttle(text) from migration 086 denies on
-- two counters, a per-key cap (5 / 15 min) and a global cap (50 / 15 min). The
-- global counter is shared by every caller of /admin/login, and a denial does
-- not look at the password. While that counter stays full, the owner is
-- refused too, from a new browser, after the 24 h session cookie has expired,
-- or when logging back in after an incident. The documented reset (delete the
-- rows) only helps until the counter fills again.
--
-- The global cap is not removed: it still bounds distributed guessing of the
-- one shared ADMIN_PASSWORD for every caller that has not proved the password.
--
-- This migration adds the DB half of the OWASP "device cookie" pattern:
--   * a browser that has logged in with the CURRENT password receives a signed
--     `admin_device` cookie (src/lib/admin/session.ts: HttpOnly, SameSite,
--     Secure in production, 30 days, signed with a key derived from
--     ADMIN_SESSION_SECRET under its own domain label and bound to
--     ADMIN_PASSWORD, so rotating either one invalidates every device cookie);
--   * when /admin/login receives a valid device cookie, the attempt is counted
--     HERE, per device (5 attempts / 15 minutes), and is never refused by the
--     global cap. Its row still lands in admin_login_attempts, so it still
--     counts toward the global 50 that admin_login_throttle(text) checks for
--     callers without a device cookie;
--   * a missing, forged, expired or mismatched cookie is not a device: the app
--     falls back to admin_login_throttle(text) unchanged (per client key plus
--     the global cap).
-- A device cookie can only be obtained by presenting the correct password, so
-- the per-device cap protects the owner's own browser, not an anonymous caller.
--
-- admin_login_throttle_device(text) is 086's function with the global count
-- removed and nothing else changed:
--   * same 64-hex key check (errcode 22023);
--   * same advisory lock id (86086086), so the two functions serialise with
--     each other and the check-then-insert stays atomic;
--   * same 1-day retention sweep on the same table;
--   * per-key count over 15 minutes, cap 5, retry_after_seconds from the oldest
--     counted attempt;
--   * blocked attempts are NOT recorded, so a lockout always ends 15 minutes
--     after the oldest counted attempt and retrying never extends it.
--
-- Privacy (KVKK): only a keyed digest is stored, never the device id itself:
--   key_hash = HMAC-SHA256(subkey, 'device:' || device_id)
--   subkey   = HMAC-SHA256(ADMIN_SESSION_SECRET, 'tayf/admin-login-throttle/v1')
-- (src/lib/admin/login-throttle.ts). The 'device:' prefix keeps these digests
-- apart from the per-IP ones that 086 stores in the same table.
--
-- Escape hatch for the operator, unchanged from 086, if the throttle ever
-- needs a manual reset (for example after rotating ADMIN_PASSWORD):
--   delete from public.admin_login_attempts;
--
-- Additive only: one new SECURITY DEFINER function. No table, column, index,
-- policy, default privilege or existing function is touched; 086 is not edited.
-- service_role is the only role that can execute it, so the anon allowlist in
-- ops_health_report() row 17 does not change. Safe to re-apply (`create or
-- replace function`, ledger insert `on conflict do nothing`).
--
-- Apply before the Vercel deploy that ships the device-cookie code. Until this
-- migration has run, the device RPC returns an error, the app treats that as
-- "unavailable" and uses the 086 path, so the order is safe either way, but the
-- device cookie has no effect before it is applied.

begin;
set local lock_timeout = '5s';

create or replace function public.admin_login_throttle_device(p_key_hash text)
returns table (allowed boolean, retry_after_seconds integer)
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  c_window    constant interval := interval '15 minutes';
  c_per_key   constant integer  := 5;
  c_retention constant interval := interval '1 day';
  v_now       timestamptz := pg_catalog.now();
  v_key_n integer;
  v_key_first timestamptz;
  v_retry integer := 0;
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'admin_login_throttle_device: invalid key' using errcode = '22023';
  end if;

  -- Same lock id as admin_login_throttle(text): serialises check-then-insert
  -- across concurrent Vercel instances, and across the two functions.
  perform pg_catalog.pg_advisory_xact_lock(86086086);

  delete from public.admin_login_attempts a where a.attempted_at < v_now - c_retention;

  select pg_catalog.count(*)::integer, pg_catalog.min(a.attempted_at)
    into v_key_n, v_key_first
    from public.admin_login_attempts a
    where a.key_hash = p_key_hash and a.attempted_at > v_now - c_window;

  if v_key_n >= c_per_key then
    v_retry := greatest(v_retry, pg_catalog.ceil(extract(epoch from (v_key_first + c_window - v_now)))::integer);
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

comment on function public.admin_login_throttle_device(text) is
  'Per-device variant of admin_login_throttle(text): records one allowed '
  'admin-login attempt atomically for a device key (5 attempts per 15 '
  'minutes, sliding window) and reports whether this attempt is allowed and, '
  'if not, how many seconds until the oldest counted attempt ages out. It has '
  'no global counter; the app calls it only for a browser that carries a '
  'valid signed device cookie and falls back to admin_login_throttle(text) '
  'otherwise. Blocked attempts are never recorded. service_role only; '
  'migration 207.';

revoke all on function public.admin_login_throttle_device(text) from anon, authenticated, public;
grant execute on function public.admin_login_throttle_device(text) to service_role;

insert into supabase_migrations.schema_migrations (version, name)
  values ('207', '207_admin_login_throttle_device')
  on conflict do nothing;

commit;
