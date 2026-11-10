-- 190 consumer_lease (the TTL lease table public.consumer_leases and consumer_lease_acquire / consumer_lease_release,
-- SECURITY DEFINER, service_role only): local PG15 dry-run. Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55590 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55590 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/190-consumer-lease-dryrun.sql
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh    (TAYF_LIVE_ONLY=190 runs just this one)
--
-- (\ir paths below are relative to this file.) Every check is a DO block that raises on mismatch, so a clean run
-- ending in "DRYRUN 190 OK" is the pass. The stub's default privileges grant anon, authenticated and service_role
-- everything on every new table and function (as a Supabase project does), so the revokes of 190 are doing real work
-- here: a missing one shows up as an anon call that succeeds.
--
-- What is exercised (the semantics of the finding, h106-attachdesign-1):
--   * takeover only after expiry: a lease held by A and not expired is refused to B (false, the row untouched); once
--     expires_at has passed B takes it (true, holder B, acquired_at reset); the boundary expires_at = a past
--     clock_timestamp() counts as expired (<=);
--   * same-holder renew: A acquiring again keeps acquired_at, moves expires_at forward and answers true; after a
--     takeover A's renewal answers false;
--   * release only by the holder: B cannot release A's lease (false, the row stays), A can (true, the row is gone), a
--     second release and an unknown name answer false;
--   * the TTL clamp 5..120 s over a grid (0, 1, -100, null -> 5; 6, 45, 119, 120 untouched; 121 and 999999 -> 120);
--   * a null name or holder raises not_null_violation (a programming error is an error, never a quiet "busy");
--   * the ACLs against real roles: service_role may call both functions, anon and authenticated get
--     insufficient_privilege on the functions AND on the table (select and insert); row level security is on with no
--     policy and not forced;
--   * the attributes (SECURITY DEFINER, search_path = '', volatile, plpgsql / sql, boolean results, argument names),
--     the body fingerprints of the header of docs/migration-guide.md section 190, the ledger row written once after
--     two applications, and the rollback of 190's header followed by a re-apply that restores the same bodies.
-- Two sessions racing for one free name cannot be shown with a single psql session; the guarantee is the ON CONFLICT
-- arbiter (one statement, no select-then-write), which tests/migrations/190-consumer-lease.test.ts pins in the text.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- 1. Before: none of the objects exist. -----------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.consumer_leases') is not null then
    raise exception 'public.consumer_leases exists before 190 (production has none)';
  end if;
  if exists (select 1 from pg_proc where proname in ('consumer_lease_acquire', 'consumer_lease_release')) then
    raise exception 'a consumer_lease_* function exists before 190 (production has none)';
  end if;
end $$;

-- 2. Apply 190 TWICE (one transaction each; create ... if not exists, create or replace, ledger on conflict do nothing).
\ir ../../../supabase/migrations/190_consumer_lease.sql
\ir ../../../supabase/migrations/190_consumer_lease.sql

-- 3. The table, its security switch and its privileges. -----------------------------------------------------------
do $$
declare
  c record;
  cols text;
begin
  select string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' not null' else '' end,
                    ', ' order by a.attnum)
    into cols
    from pg_attribute a
   where a.attrelid = 'public.consumer_leases'::regclass and a.attnum > 0 and not a.attisdropped;
  if cols is distinct from 'name text not null, holder text not null, acquired_at timestamp with time zone not null, expires_at timestamp with time zone not null' then
    raise exception 'consumer_leases columns are: %', cols;
  end if;
  if not exists (
    select 1 from pg_index i where i.indrelid = 'public.consumer_leases'::regclass and i.indisprimary
       and (select string_agg(a.attname, ',') from pg_attribute a where a.attrelid = i.indrelid and a.attnum = any (i.indkey)) = 'name'
  ) then
    raise exception 'consumer_leases must have its primary key on name';
  end if;
  if pg_get_expr((select d.adbin from pg_attrdef d where d.adrelid = 'public.consumer_leases'::regclass
                   and d.adnum = (select attnum from pg_attribute where attrelid = 'public.consumer_leases'::regclass and attname = 'acquired_at')),
                 'public.consumer_leases'::regclass) <> 'clock_timestamp()' then
    raise exception 'acquired_at must default to clock_timestamp()';
  end if;

  select relrowsecurity as rls, relforcerowsecurity as forced, relacl::text as acl into c from pg_class where oid = 'public.consumer_leases'::regclass;
  if not c.rls then raise exception 'row level security must be ON for consumer_leases'; end if;
  if c.forced then raise exception 'row level security must not be FORCED (the SECURITY DEFINER owner has to write)'; end if;
  if exists (select 1 from pg_policy where polrelid = 'public.consumer_leases'::regclass) then
    raise exception 'consumer_leases must have no policy';
  end if;
  if exists (select 1 from pg_class cl, aclexplode(cl.relacl) a where cl.oid = 'public.consumer_leases'::regclass and a.grantee = 0) then
    raise exception 'consumer_leases has a PUBLIC privilege';
  end if;
  foreach cols in array array['anon', 'authenticated'] loop
    if has_table_privilege(cols, 'public.consumer_leases', 'select, insert, update, delete, truncate, references, trigger') then
      raise exception '% holds a privilege on consumer_leases', cols;
    end if;
  end loop;
  if (select count(*) from supabase_migrations.schema_migrations where version = '190' and name = '190_consumer_lease') <> 1 then
    raise exception 'ledger row 190 must exist exactly once after two applications';
  end if;
end $$;

-- 4. The functions: attributes, fingerprints, ACLs. ------------------------------------------------------------------
do $$
declare
  a pg_proc%rowtype;
  r pg_proc%rowtype;
begin
  select * into a from pg_proc where oid = 'public.consumer_lease_acquire(text,text,integer)'::regprocedure;
  select * into r from pg_proc where oid = 'public.consumer_lease_release(text,text)'::regprocedure;
  if (select count(*) from pg_proc where proname = 'consumer_lease_acquire') <> 1 or (select count(*) from pg_proc where proname = 'consumer_lease_release') <> 1 then
    raise exception '190 must leave exactly one of each function';
  end if;

  if not a.prosecdef or not r.prosecdef then raise exception '190 functions must be SECURITY DEFINER'; end if;
  if a.proconfig is distinct from array['search_path=""'] or r.proconfig is distinct from array['search_path=""'] then
    raise exception 'proconfig is % / %, expected {search_path=""}', a.proconfig, r.proconfig;
  end if;
  if a.provolatile <> 'v' or r.provolatile <> 'v' then raise exception '190 functions must be volatile (they write)'; end if;
  if (select l.lanname from pg_language l where l.oid = a.prolang) <> 'plpgsql' then raise exception 'acquire must be plpgsql'; end if;
  if (select l.lanname from pg_language l where l.oid = r.prolang) <> 'sql' then raise exception 'release must be sql'; end if;
  if pg_get_function_result(a.oid) <> 'boolean' or pg_get_function_result(r.oid) <> 'boolean' then
    raise exception 'both functions return boolean';
  end if;
  if pg_get_function_arguments(a.oid) <> 'p_name text, p_holder text, p_ttl_seconds integer' then
    raise exception 'acquire arguments are %', pg_get_function_arguments(a.oid);
  end if;
  if pg_get_function_arguments(r.oid) <> 'p_name text, p_holder text' then
    raise exception 'release arguments are %', pg_get_function_arguments(r.oid);
  end if;
  if a.proowner <> (select proowner from pg_proc where oid = 'public.consumer_lease_release(text,text)'::regprocedure) then
    raise exception 'the two functions have different owners';
  end if;
  if a.proowner <> (select relowner from pg_class where oid = 'public.consumer_leases'::regclass) then
    raise exception 'the functions must be owned by the table owner (RLS does not apply to it)';
  end if;
  -- Fingerprints of the bodies, as printed in docs/migration-guide.md section 190 (recomputed here, never typed twice).
  if md5(a.prosrc) <> 'd097cca98ee4fc1991a0c17bd23677cb' or length(a.prosrc) <> 683 then
    raise exception 'acquire body fingerprint is % / %', md5(a.prosrc), length(a.prosrc);
  end if;
  if md5(r.prosrc) <> 'bf73840bcd754136bb0eb8fb98aff06a' or length(r.prosrc) <> 168 then
    raise exception 'release body fingerprint is % / %', md5(r.prosrc), length(r.prosrc);
  end if;
end $$;

do $$
declare
  acl_a text := (select proacl::text from pg_proc where oid = 'public.consumer_lease_acquire(text,text,integer)'::regprocedure);
  acl_r text := (select proacl::text from pg_proc where oid = 'public.consumer_lease_release(text,text)'::regprocedure);
  sig text;
begin
  if acl_a is null or acl_r is null then raise exception '190 has a default ACL (NULL): PUBLIC could execute it'; end if;
  if exists (
    select 1 from pg_proc p, aclexplode(p.proacl) x
     where p.proname in ('consumer_lease_acquire', 'consumer_lease_release') and x.grantee = 0
  ) then
    raise exception '190 is executable by PUBLIC';
  end if;
  foreach sig in array array['public.consumer_lease_acquire(text,text,integer)', 'public.consumer_lease_release(text,text)'] loop
    if not has_function_privilege('service_role', sig, 'execute') then raise exception 'service_role cannot execute %', sig; end if;
    if has_function_privilege('anon', sig, 'execute') then raise exception 'anon can execute %', sig; end if;
    if has_function_privilege('authenticated', sig, 'execute') then raise exception 'authenticated can execute %', sig; end if;
  end loop;
end $$;

-- anon and authenticated really are refused, on the functions and on the table (the stub's default privileges would
-- have granted them everything).
do $$
declare
  who text;
begin
  foreach who in array array['anon', 'authenticated'] loop
    execute format('set local role %I', who);
    begin
      perform public.consumer_lease_acquire('x', 'h', 5);
      raise exception '% called consumer_lease_acquire', who;
    exception when insufficient_privilege then
      null;
    end;
    begin
      perform public.consumer_lease_release('x', 'h');
      raise exception '% called consumer_lease_release', who;
    exception when insufficient_privilege then
      null;
    end;
    begin
      perform * from public.consumer_leases;
      raise exception '% selected from consumer_leases', who;
    exception when insufficient_privilege then
      null;
    end;
    begin
      insert into public.consumer_leases (name, holder, expires_at) values ('x', 'h', clock_timestamp() + interval '1 hour');
      raise exception '% inserted into consumer_leases', who;
    exception when insufficient_privilege then
      null;
    end;
    reset role;
  end loop;
end $$;

-- 5. Semantics, called as service_role (the role the Edge Function uses), read back as the table owner. ---------------
do $$
declare
  ok boolean;
  r1 public.consumer_leases%rowtype;
  r2 public.consumer_leases%rowtype;
begin
  -- a free name inserts, for the clamped ttl
  set local role service_role;
  ok := public.consumer_lease_acquire('cluster-consumer', 'A', 45);
  reset role;
  if ok is distinct from true then raise exception 'a free name must be acquired'; end if;
  select * into r1 from public.consumer_leases where name = 'cluster-consumer';
  if r1.holder <> 'A' then raise exception 'holder is %', r1.holder; end if;
  if abs(extract(epoch from (r1.expires_at - r1.acquired_at)) - 45) > 0.5 then
    raise exception 'ttl 45 gave a lease of % s', extract(epoch from (r1.expires_at - r1.acquired_at));
  end if;

  -- BUSY: another holder is refused while the lease has not expired, and the row is not touched
  set local role service_role;
  ok := public.consumer_lease_acquire('cluster-consumer', 'B', 45);
  reset role;
  if ok is distinct from false then raise exception 'B must be refused while A holds an unexpired lease (got %)', ok; end if;
  select * into r2 from public.consumer_leases where name = 'cluster-consumer';
  if r2 is distinct from r1 then raise exception 'a refused acquire changed the row: % -> %', r1, r2; end if;

  -- RENEW: the same holder acquires again: true, acquired_at kept, expires_at moved forward
  set local role service_role;
  ok := public.consumer_lease_acquire('cluster-consumer', 'A', 45);
  reset role;
  if ok is distinct from true then raise exception 'A must be able to renew its own lease'; end if;
  select * into r2 from public.consumer_leases where name = 'cluster-consumer';
  if r2.holder <> 'A' then raise exception 'renew changed the holder to %', r2.holder; end if;
  if r2.acquired_at <> r1.acquired_at then raise exception 'a live renewal must keep acquired_at (% -> %)', r1.acquired_at, r2.acquired_at; end if;
  if not (r2.expires_at > r1.expires_at) then raise exception 'a renewal must move expires_at forward (% -> %)', r1.expires_at, r2.expires_at; end if;

  -- a renewal with a shorter ttl is a renewal too (the expiry is the new one, not the later of the two)
  set local role service_role;
  ok := public.consumer_lease_acquire('cluster-consumer', 'A', 10);
  reset role;
  select * into r2 from public.consumer_leases where name = 'cluster-consumer';
  if ok is distinct from true or abs(extract(epoch from (r2.expires_at - clock_timestamp())) - 10) > 1 then
    raise exception 'a renewal with ttl 10 must set a 10 s expiry (got %)', r2.expires_at - clock_timestamp();
  end if;

  -- TAKEOVER only after expiry: still refused 1 s before, granted the moment it has passed
  update public.consumer_leases set expires_at = clock_timestamp() + interval '1 second' where name = 'cluster-consumer';
  set local role service_role;
  ok := public.consumer_lease_acquire('cluster-consumer', 'B', 45);
  reset role;
  if ok is distinct from false then raise exception 'B took a lease that had one second left'; end if;

  update public.consumer_leases set expires_at = clock_timestamp() where name = 'cluster-consumer';
  select * into r1 from public.consumer_leases where name = 'cluster-consumer';
  set local role service_role;
  ok := public.consumer_lease_acquire('cluster-consumer', 'B', 45);
  reset role;
  if ok is distinct from true then raise exception 'B must take over a lease whose expires_at has passed (the boundary counts as expired)'; end if;
  select * into r2 from public.consumer_leases where name = 'cluster-consumer';
  if r2.holder <> 'B' then raise exception 'takeover left holder %', r2.holder; end if;
  if not (r2.acquired_at > r1.acquired_at) then raise exception 'a takeover must reset acquired_at (% -> %)', r1.acquired_at, r2.acquired_at; end if;
  if abs(extract(epoch from (r2.expires_at - r2.acquired_at)) - 45) > 0.5 then raise exception 'takeover ttl is wrong'; end if;

  -- the previous holder's renewal is refused after a takeover, and so is a renewal after its own expiry by a later holder
  set local role service_role;
  ok := public.consumer_lease_acquire('cluster-consumer', 'A', 45);
  reset role;
  if ok is distinct from false then raise exception 'A must not be able to renew after B took over'; end if;
  select * into r1 from public.consumer_leases where name = 'cluster-consumer';
  if r1.holder <> 'B' then raise exception 'A''s refused renewal changed the holder to %', r1.holder; end if;

  -- a holder renewing AFTER its own lease expired (nobody took it) gets a fresh acquired_at: it is a new acquisition
  update public.consumer_leases set expires_at = clock_timestamp() - interval '1 second' where name = 'cluster-consumer';
  select * into r1 from public.consumer_leases where name = 'cluster-consumer';
  set local role service_role;
  ok := public.consumer_lease_acquire('cluster-consumer', 'B', 45);
  reset role;
  select * into r2 from public.consumer_leases where name = 'cluster-consumer';
  if ok is distinct from true or not (r2.acquired_at > r1.acquired_at) then
    raise exception 'a renewal after the holder''s own expiry must count as a new acquisition';
  end if;

  -- leases are per name: another name is independent
  set local role service_role;
  ok := public.consumer_lease_acquire('image-consumer', 'C', 45);
  reset role;
  if ok is distinct from true then raise exception 'a different lease name must be free'; end if;
  if (select count(*) from public.consumer_leases) <> 2 then raise exception 'expected 2 lease rows'; end if;
end $$;

do $$
declare
  ok boolean;
begin
  -- RELEASE only by the holder (state from the block above: cluster-consumer held by B, image-consumer by C)
  set local role service_role;
  ok := public.consumer_lease_release('cluster-consumer', 'A');
  reset role;
  if ok is distinct from false then raise exception 'A released a lease B holds'; end if;
  if not exists (select 1 from public.consumer_leases where name = 'cluster-consumer' and holder = 'B') then
    raise exception 'a refused release removed or changed the row';
  end if;

  set local role service_role;
  ok := public.consumer_lease_release('cluster-consumer', 'B');
  reset role;
  if ok is distinct from true then raise exception 'the holder must be able to release'; end if;
  if exists (select 1 from public.consumer_leases where name = 'cluster-consumer') then raise exception 'the release left the row behind'; end if;
  if not exists (select 1 from public.consumer_leases where name = 'image-consumer') then raise exception 'the release touched another lease'; end if;

  set local role service_role;
  ok := public.consumer_lease_release('cluster-consumer', 'B');
  reset role;
  if ok is distinct from false then raise exception 'a second release must answer false'; end if;
  set local role service_role;
  ok := public.consumer_lease_release('no-such-lease', 'B');
  reset role;
  if ok is distinct from false then raise exception 'releasing an unknown name must answer false'; end if;

  -- after a release the name is free again for anybody
  set local role service_role;
  ok := public.consumer_lease_acquire('cluster-consumer', 'D', 45);
  reset role;
  if ok is distinct from true then raise exception 'a released lease must be free'; end if;

  -- an expired lease can be released by its holder too (the row is simply deleted)
  update public.consumer_leases set expires_at = clock_timestamp() - interval '5 seconds' where name = 'cluster-consumer';
  set local role service_role;
  ok := public.consumer_lease_release('cluster-consumer', 'D');
  reset role;
  if ok is distinct from true then raise exception 'the holder of an expired lease must still be able to release it'; end if;
  delete from public.consumer_leases;
end $$;

-- 6. The TTL clamp over a grid: 5..120 s. -----------------------------------------------------------------------------
do $$
declare
  g record;
  r public.consumer_leases%rowtype;
  ok boolean;
  n int := 0;
begin
  for g in
    select * from (values
      (1,    0,  5),   -- 0: the floor
      (2,    1,  5),
      (3, -100,  5),   -- negative
      (4, null,  5),   -- null: greatest() ignores it, so the floor
      (5,    4,  5),
      (6,    5,  5),
      (7,    6,  6),
      (8,   45, 45),   -- what the consumer asks for
      (9,  119, 119),
      (10, 120, 120),
      (11, 121, 120),
      (12, 999999, 120),
      (13, 2147483647, 120)
    ) as v(case_no, ttl, want)
    order by case_no
  loop
    set local role service_role;
    ok := public.consumer_lease_acquire('clamp-' || g.case_no, 'H', g.ttl);
    reset role;
    if ok is distinct from true then raise exception 'case %: acquire answered %', g.case_no, ok; end if;
    select * into r from public.consumer_leases where name = 'clamp-' || g.case_no;
    if abs(extract(epoch from (r.expires_at - r.acquired_at)) - g.want) > 0.5 then
      raise exception 'case %: ttl % gave % s, wanted %', g.case_no, g.ttl, extract(epoch from (r.expires_at - r.acquired_at)), g.want;
    end if;
    n := n + 1;
  end loop;
  if n <> 13 then raise exception 'the clamp grid ran % cases', n; end if;
  delete from public.consumer_leases;
end $$;

-- 7. A null name or holder is an error, not a quiet 'busy'. --------------------------------------------------------------
do $$
begin
  begin
    perform public.consumer_lease_acquire(null, 'h', 45);
    raise exception 'a null name was accepted';
  exception when not_null_violation then
    null;
  end;
  begin
    perform public.consumer_lease_acquire('n', null, 45);
    raise exception 'a null holder was accepted';
  exception when not_null_violation then
    null;
  end;
  if exists (select 1 from public.consumer_leases) then raise exception 'a refused call left a row behind'; end if;
end $$;

-- 8. Rollback of the header, then re-apply. ----------------------------------------------------------------------------
begin;
drop function public.consumer_lease_acquire(text, text, int);
drop function public.consumer_lease_release(text, text);
drop table public.consumer_leases;
delete from supabase_migrations.schema_migrations where version = '190';
notify pgrst, 'reload schema';
commit;

do $$
begin
  if to_regclass('public.consumer_leases') is not null then raise exception 'the rollback left consumer_leases behind'; end if;
  if exists (select 1 from pg_proc where proname in ('consumer_lease_acquire', 'consumer_lease_release')) then
    raise exception 'the rollback left a consumer_lease_* function behind';
  end if;
  if exists (select 1 from supabase_migrations.schema_migrations where version = '190') then
    raise exception 'the rollback left ledger row 190 behind';
  end if;
end $$;

\ir ../../../supabase/migrations/190_consumer_lease.sql

do $$
begin
  if (select md5(prosrc) from pg_proc where oid = 'public.consumer_lease_acquire(text,text,integer)'::regprocedure) <> 'd097cca98ee4fc1991a0c17bd23677cb' then
    raise exception 're-applying 190 after the rollback changed the acquire body';
  end if;
  if (select md5(prosrc) from pg_proc where oid = 'public.consumer_lease_release(text,text)'::regprocedure) <> 'bf73840bcd754136bb0eb8fb98aff06a' then
    raise exception 're-applying 190 after the rollback changed the release body';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.consumer_leases'::regclass) then
    raise exception 're-applying 190 after the rollback lost row level security';
  end if;
  if has_table_privilege('anon', 'public.consumer_leases', 'select') or has_function_privilege('anon', 'public.consumer_lease_acquire(text,text,integer)', 'execute') then
    raise exception 're-applying 190 after the rollback left anon with a privilege';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '190') <> 1 then
    raise exception 'ledger row 190 must be back exactly once';
  end if;
end $$;

select 'DRYRUN 190 OK';
