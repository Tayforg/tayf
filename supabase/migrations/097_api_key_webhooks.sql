-- 097_api_key_webhooks.sql
--
-- newsroom-alerts (b2b-5): signed webhook subscriptions and their delivery
-- queue for the keyed alert feed (GET /api/v1/alerts/blindspots).
--
--   public.api_key_webhooks            one row per API key (url + signing secret)
--   public.api_key_webhook_deliveries  one row per (key, alert): the durable queue
--   public.api_webhook_claim()         atomic claim for /api/cron/alerts-webhooks
--   pg_cron api-webhook-deliveries-retention   daily, deletes rows older than 30 days
--
-- ADDITIVE ONLY. No existing table, column, policy, function or cron job is
-- altered or removed. Safe to re-apply: `create table if not exists`,
-- `create index if not exists`, `create or replace function`, the cron job is
-- unscheduled-then-scheduled by name, ledger insert `on conflict do nothing`.
--
-- Idempotency is the unique (key_id, alert_id) constraint: the cron enqueues
-- with `on conflict do nothing`, so an alert is queued at most once per key
-- no matter how many ticks see it. The payload is stored once, so every retry
-- of a delivery sends identical bytes.
--
-- SHELL: service_role only. RLS enabled with zero policies; `revoke all ...
-- from anon, authenticated, public` (Supabase's default ACL would otherwise
-- grant them everything on a new table, the leak 091 and 095 cleaned up);
-- the PG17 MAINTAIN revoke behind a server_version_num guard (095); then
-- explicit grants to service_role, plus the bigserial sequence (as in 069).
-- Nothing here is publicly readable: the secret column must never leave the
-- server.

begin;

-- ===========================================================================
-- 1. Subscriptions
-- ===========================================================================

create table if not exists public.api_key_webhooks (
  key_id bigint primary key references public.api_keys (id) on delete cascade,
  url text not null check (url ~ '^https://' and length(url) <= 2048),
  secret text not null check (secret ~ '^whsec_[0-9a-f]{64}$'),
  enabled boolean not null default true,
  fail_streak int not null default 0,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_status int,
  disabled_reason text check (disabled_reason is null or length(disabled_reason) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.api_key_webhooks is
  'Signed alert webhook per API key (migration 097). secret is the HMAC key, '
  'shown once at registration and never selected by any admin reader. '
  'service_role only.';

-- ===========================================================================
-- 2. Delivery queue
-- ===========================================================================

create table if not exists public.api_key_webhook_deliveries (
  id bigserial primary key,
  key_id bigint not null references public.api_keys (id) on delete cascade,
  alert_id text not null check (alert_id ~ '^(blindspot|one_zone_silent):[0-9a-f-]{36}$'),
  payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'delivered', 'failed')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  last_status int,
  last_error text check (last_error is null or length(last_error) <= 300),
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  constraint api_key_webhook_deliveries_key_alert_uq unique (key_id, alert_id)
);

comment on table public.api_key_webhook_deliveries is
  'Durable webhook queue (migration 097). unique (key_id, alert_id) is the '
  'idempotency guarantee; payload is stored once so retries resend identical '
  'bytes. Deleted after 30 days by api-webhook-deliveries-retention.';

create index if not exists api_key_webhook_deliveries_due_idx
  on public.api_key_webhook_deliveries (next_attempt_at)
  where status in ('pending', 'sending');

create index if not exists api_key_webhook_deliveries_created_idx
  on public.api_key_webhook_deliveries (created_at);

-- ===========================================================================
-- 3. Atomic claim
-- ===========================================================================

create or replace function public.api_webhook_claim(
  p_limit int default 20,
  p_stale interval default '5 minutes'
)
returns table (
  id bigint,
  key_id bigint,
  alert_id text,
  payload jsonb,
  attempts int,
  url text,
  secret text
)
language plpgsql
security definer
set search_path = ''
as $fn$
#variable_conflict use_column
begin
  return query
  with claimed as (
    update public.api_key_webhook_deliveries as u
       set status = 'sending',
           claimed_at = pg_catalog.now(),
           attempts = u.attempts + 1
     where u.id in (
       select d.id
         from public.api_key_webhook_deliveries as d
         join public.api_key_webhooks as w
           on w.key_id = d.key_id and w.enabled
         join public.api_keys as k
           on k.id = d.key_id and k.revoked_at is null
        where (d.status = 'pending' and d.next_attempt_at <= pg_catalog.now())
           or (d.status = 'sending' and d.claimed_at < pg_catalog.now() - p_stale)
        order by d.next_attempt_at
        limit least(greatest(coalesce(p_limit, 20), 1), 50)
          for update of d skip locked
     )
    returning u.id, u.key_id, u.alert_id, u.payload, u.attempts
  )
  select c.id, c.key_id, c.alert_id, c.payload, c.attempts, w.url, w.secret
    from claimed as c
    join public.api_key_webhooks as w on w.key_id = c.key_id
   order by c.id;
end;
$fn$;

comment on function public.api_webhook_claim(int, interval) is
  'Claims up to p_limit (1..50, default 20) due webhook deliveries for '
  '/api/cron/alerts-webhooks (migration 097): pending rows whose '
  'next_attempt_at has passed, plus sending rows abandoned longer than '
  'p_stale. Only enabled webhooks on non-revoked keys. FOR UPDATE OF d SKIP '
  'LOCKED makes overlapping ticks safe. service_role only.';

-- ===========================================================================
-- 4. RLS + grants (service_role only)
-- ===========================================================================

alter table public.api_key_webhooks enable row level security;
alter table public.api_key_webhook_deliveries enable row level security;

revoke all on public.api_key_webhooks from anon, authenticated, public;
revoke all on public.api_key_webhook_deliveries from anon, authenticated, public;

-- PG17 added MAINTAIN, which Supabase's default ACL also grants to
-- anon/authenticated; it does not exist before PG17, so guard (see 095).
do $maint$
begin
  if pg_catalog.current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on public.api_key_webhooks from anon, authenticated';
    execute 'revoke maintain on public.api_key_webhook_deliveries from anon, authenticated';
  end if;
end
$maint$;

grant select, insert, update, delete on public.api_key_webhooks to service_role;
grant select, insert, update, delete on public.api_key_webhook_deliveries to service_role;

-- bigserial needs the sequence too (as in 069 / 061).
revoke all on sequence public.api_key_webhook_deliveries_id_seq from anon, authenticated, public;
grant usage, select on sequence public.api_key_webhook_deliveries_id_seq to service_role;

revoke all on function public.api_webhook_claim(int, interval) from public, anon, authenticated;
grant execute on function public.api_webhook_claim(int, interval) to service_role;

-- ===========================================================================
-- 5. Retention: 30 days, daily 03:37 UTC
-- ===========================================================================

do $cron$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron not installed - skipping api-webhook-deliveries-retention schedule (097)';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'api-webhook-deliveries-retention') then
    perform cron.unschedule('api-webhook-deliveries-retention');
  end if;
  perform cron.schedule('api-webhook-deliveries-retention', '37 3 * * *',
    $sql$ delete from public.api_key_webhook_deliveries where created_at < now() - interval '30 days'; $sql$);
end
$cron$;

insert into supabase_migrations.schema_migrations (version, name)
  values ('097', '097_api_key_webhooks')
  on conflict do nothing;

commit;
