-- 059_kap_fetch_state.sql
--
-- SEC-07 follow-up: a persisted circuit breaker for the kap-ingest Edge
-- Function. fetchWithRetry (_shared/kap.ts) already backs off 429/503 with
-- jitter and gives up immediately, no retry, on 403 -- but that decision
-- lives only in the current invocation's memory. pg_cron's kap-drain pokes
-- the function every few minutes, so a real block (403) or a sustained
-- rate limit (429 surviving the retry ladder) got replayed against
-- kap.org.tr forever, cold start after cold start. This single-row table
-- lets runCycle record "blocked until <ts>" once and every following tick
-- returns early and logs once instead of hammering a blocking origin.
--
-- Never trips on a 5xx or a thrown network/timeout error -- those are
-- transient and must keep being retried on the function's normal schedule
-- (see isBreakerTripStatus in _shared/kap.ts, the single definition of
-- which statuses count as "the origin told us to stop").
--
-- Additive, single-row (id fixed at 1). RLS enabled with no policies at
-- all and an explicit revoke from anon/authenticated/public, same shell as
-- 041/057 -- PostgREST can't expose this even by accident. service_role
-- only ever needs to read and update the one row; it is seeded once by
-- this migration and never inserted again.

begin;

create table if not exists public.kap_fetch_state (
  id smallint primary key default 1 check (id = 1),
  blocked_until timestamptz,
  last_status integer,
  last_error text,
  updated_at timestamptz not null default now()
);

comment on table public.kap_fetch_state is
  'Single-row circuit-breaker state for the kap-ingest Edge Function '
  '(SEC-07 follow-up). blocked_until is set only after fetchWithRetry''s '
  'retry ladder exhausts on a definitive 403 or 429 from kap.org.tr, never '
  'on a 5xx or a network/timeout error. runCycle reads this row first and '
  'returns { skipped: true, reason: "kap_blocked" } early while '
  'blocked_until is in the future; /admin/ekonomi surfaces the row via the '
  'kap-breaker-badge component and the clear_kap_breaker admin action '
  'resets it.';

comment on column public.kap_fetch_state.blocked_until is
  'Null when the breaker is closed. Set to now() + 6h when the retry '
  'ladder exhausts on a final 403/429; cleared (set null) by the '
  'clear_kap_breaker admin action. A successful fetch never sets this '
  'column -- it only clears last_error/last_status (see '
  'clearBreakerError in kap-ingest/index.ts).';

comment on column public.kap_fetch_state.last_status is
  'HTTP status from the most recent breaker-relevant outcome kap-ingest '
  'recorded here: the tripping 403/429 alongside blocked_until, or 200 '
  'once a fetch succeeds again. Diagnostic only -- no query path reads it '
  'besides the admin badge.';

comment on column public.kap_fetch_state.last_error is
  'Message from the most recent breaker trip. Cleared (set null) by the '
  'next successful fetch or by the clear_kap_breaker admin action.';

insert into public.kap_fetch_state (id) values (1) on conflict do nothing;

alter table public.kap_fetch_state enable row level security;

revoke all on public.kap_fetch_state from anon, authenticated, public;
grant select, update on public.kap_fetch_state to service_role;

-- Record this migration in the ledger from inside the file itself, same
-- precedent as 055/058: the orchestrator applies this file directly
-- (e.g. `psql -f`), not necessarily via `supabase db push`.
insert into supabase_migrations.schema_migrations (version, name)
  values ('059', '059_kap_fetch_state')
  on conflict do nothing;

commit;
