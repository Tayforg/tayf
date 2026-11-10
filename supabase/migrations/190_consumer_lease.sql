-- 190_consumer_lease.sql
--
-- A TTL lease row and two RPCs over it, so two cluster consumers in different isolates never read
-- cluster_work at the same time (h106-attachdesign-1, hunt 106, follow-up of h101-e2elatency-1 and
-- h102-pollregression-1). One table and two functions added. No change to an existing table, column, index,
-- trigger, queue, cron job, GUC or function.
--
-- WHY (evidence: production, read-only, 2026-11-10 17:50Z, pgmq.a_cluster_work of the last 6 h, read time = vt - 60 s)
--   * n = 701 messages: enqueue-to-read wait p50 54.8 s, p90 59.3 s, p99 62.1 s; 21.4 % under 10 s; max read_ct 1
--     (no backlog, no retry). It is the phase lock h101-e2elatency-1 measured: cron-drain starts the consumer at
--     about :02 of every minute, ingest-drain (every third minute) inserts at about :04-:12 and the messages wait
--     for the NEXT minute's consumer. #252 tried to wait inside the consumer (a long poll) and held pg_net's batch
--     open: pg_net 0.20.0 starts the next batch only after the previous request ended, so ingest-drain started up
--     to 19 s late and attach time did not move (h102, #253 set POLL_ENABLED = false; its comment asks for exactly
--     this follow-up: respond first, or a separate trigger).
--   * The design: after its enqueue is done, ingest POSTs {"trigger":"ingest"} to cluster-consumer from
--     EdgeRuntime.waitUntil (never awaited in its response path, the #252 failure mode), behind the secret
--     CLUSTER_KICK=on. The kicked consumer and the cron one run in different isolates; drainInFlight is per
--     isolate only, so a second reader on cluster_work would score the same story's messages in parallel and open
--     twins. Something outside the isolates has to serialise them.
--   * PostgREST cannot hold a session advisory lock (every RPC is its own transaction on a pooled connection,
--     the lock would be released or leaked with the connection), and pg_advisory_xact_lock ends with the call.
--     A row with an expiry does: it survives the call, and a consumer that dies is only blocking until its TTL.
--
-- WHAT CHANGES
--   public.consumer_leases (name text primary key, holder text not null, acquired_at timestamptz not null default
--   clock_timestamp(), expires_at timestamptz not null). Row level security ON, no policy, everything revoked from
--   public, anon and authenticated: only the two SECURITY DEFINER functions below (and the table owner) touch it.
--
--   public.consumer_lease_acquire(p_name text, p_holder text, p_ttl_seconds int) returns boolean
--     SECURITY DEFINER, search_path = '' (every identifier schema-qualified; pg_catalog functions resolve
--     regardless). The TTL is clamped to 5..120 s with least(greatest(p_ttl_seconds, 5), 120): a null or negative
--     TTL is the 5 s floor, so a lease can neither be made permanent nor expire before the caller starts to work.
--     ONE statement, insert ... on conflict (name) do update ... where l.expires_at <= clock_timestamp() or
--     l.holder = excluded.holder, returning true. A free name inserts; a name held by someone else is taken over
--     only once expired; the same holder renews (the consumer renews at every read-loop turn); a held, unexpired
--     lease of another holder matches the WHERE clause on neither side, writes nothing and returns no row, so the
--     coalesce answers false. There is no select-then-write window: the conflict arbiter serialises two
--     simultaneous callers on the row lock, and the loser re-evaluates the WHERE clause against the winner's row.
--     Time is clock_timestamp(), never now(): now() is the transaction start, and a retried or long statement
--     would compare against a stale clock. acquired_at is kept on a live renewal and reset on a takeover.
--
--   public.consumer_lease_release(p_name text, p_holder text) returns boolean
--     SECURITY DEFINER, search_path = ''. Deletes the row only when the holder matches (a consumer whose lease
--     expired and was taken over cannot release its successor's lease) and answers whether a row was deleted.
--
--   EXECUTE on both: revoked from public, anon and authenticated, granted to service_role only (029's and 188's
--   grants; a Supabase project's default privileges would otherwise give anon and authenticated EXECUTE on a new
--   public function). `notify pgrst, 'reload schema'` makes PostgREST see the functions at once.
--
-- CONSUMER BEHAVIOUR THIS SUPPORTS (supabase/functions/cluster-consumer/index.ts, _shared/lease.ts, _shared/kick.ts)
--   cron trigger  acquire once (ttl 45 s); busy answers {ok:true,busy:true,reason:'lease'} before any read; an RPC
--                 that is missing (PGRST202 / 42883) FAILS OPEN (today's drain), and so does any other error
--                 while CLUSTER_KICK is not 'on'; with CLUSTER_KICK=on any other error answers 503
--                 lease-unavailable (reason lease-error) and reads nothing, the next minute retries;
--   kick trigger  queue depth first (0: leave without the lease), then wait up to 10 s in steps of 400 ms for the
--                 lease, re-checking the depth on every failed try; an RPC error FAILS CLOSED;
--   both          renew at every read-loop turn (ttl min(45, 55 - seconds since the drain started), floor 5: a
--                 renewal never pushes expires_at past drain start + 55 s, so the row a killed drain leaves has
--                 expired when the next minute's cron drain starts); a false answer sets lease_lost and stops
--                 the reads; release in the handler's finally; CLUSTER_LEASE=off skips every lease call.
--
-- DEPLOY ORDER (nothing breaks in the wrong order, but this is the order that never logs a failure)
--   apply 190 (`supabase db push` or post the SQL; not applied by the PR), deploy cluster-consumer
--   (`supabase functions deploy cluster-consumer --no-verify-jwt`), deploy ingest (`supabase functions deploy
--   ingest --no-verify-jwt`), then the operator runs `supabase secrets set CLUSTER_KICK=on`. Until that last
--   step the system ships dark: ingest never kicks, and the cron consumer spends one lease RPC at the start, one
--   per read-loop turn and one at the end. A consumer deployed BEFORE 190 gets PGRST202 on the cron path and
--   drains exactly as before (one warning per minute); the kick path would fail closed, but nothing kicks yet.
--
-- ROLLBACK
--   supabase secrets unset CLUSTER_KICK        (first: stops the kicks at the source; no redeploy needed)
--   drop function public.consumer_lease_acquire(text, text, int);
--   drop function public.consumer_lease_release(text, text);
--   drop table public.consumer_leases;
--   delete from supabase_migrations.schema_migrations where version = '190';
--   notify pgrst, 'reload schema';
--   The deployed cluster-consumer then fails open on the cron path (PGRST202, one warning per minute) and drains
--   as before; redeploying the previous consumer removes the warning. Nothing depends on 190 but the lease.

begin;

create table if not exists public.consumer_leases (
  name text primary key,
  holder text not null,
  acquired_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null
);

comment on table public.consumer_leases is
  'TTL lease rows that serialise Edge Function consumers across isolates (migration 190, h106-attachdesign-1): '
  'one row per lease name (today only cluster-consumer), holder = the invocation that holds it, expires_at = when '
  'it may be taken over. Written only through consumer_lease_acquire / consumer_lease_release (SECURITY DEFINER, '
  'service_role only). A row of a consumer that died stays until its expiry and is then taken over; a clean '
  'release deletes it.';

alter table public.consumer_leases enable row level security;

-- Supabase default privileges hand new tables to anon and authenticated (with write privileges): strip them. No
-- policy exists, so row level security would refuse them anyway; the revoke makes the refusal a permission error.
revoke all on public.consumer_leases from public, anon, authenticated;

create or replace function public.consumer_lease_acquire(p_name text, p_holder text, p_ttl_seconds int)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_got boolean;
begin
  insert into public.consumer_leases as l (name, holder, acquired_at, expires_at)
  values (
    p_name,
    p_holder,
    clock_timestamp(),
    clock_timestamp() + make_interval(secs => least(greatest(p_ttl_seconds, 5), 120))
  )
  on conflict (name) do update
    set holder = excluded.holder,
        acquired_at = case when l.holder = excluded.holder and l.expires_at > clock_timestamp()
                           then l.acquired_at else excluded.acquired_at end,
        expires_at = excluded.expires_at
    where l.expires_at <= clock_timestamp() or l.holder = excluded.holder
  returning true into v_got;
  return coalesce(v_got, false);
end
$$;

create or replace function public.consumer_lease_release(p_name text, p_holder text)
returns boolean
language sql security definer set search_path = ''
as $$
  with gone as (
    delete from public.consumer_leases l
     where l.name = p_name and l.holder = p_holder
    returning 1
  )
  select exists (select 1 from gone);
$$;

-- service_role only: REVOKE names every role, because revoking from public alone leaves the role-direct grants
-- that a Supabase project's default privileges add, and the RPCs would stay reachable through PostgREST.
revoke all on function public.consumer_lease_acquire(text, text, int) from public, anon, authenticated;
grant execute on function public.consumer_lease_acquire(text, text, int) to service_role;
revoke all on function public.consumer_lease_release(text, text) from public, anon, authenticated;
grant execute on function public.consumer_lease_release(text, text) to service_role;

insert into supabase_migrations.schema_migrations (version, name)
  values ('190', '190_consumer_lease')
  on conflict do nothing;

notify pgrst, 'reload schema';

commit;
