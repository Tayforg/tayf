-- 151 cluster_attach_probe (hunt-25 W3): local PG15 dry-run. Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55731 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55731 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/151-cluster-attach-probe-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql PGHOST=/tmp PGPORT=55731 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/151-cluster-attach-probe)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh
--
-- (\ir paths below are relative to this file.) Every check is a DO block or a pg_temp function
-- that raises on mismatch, so a clean run ending in "DRYRUN 151 OK" is the pass. Every scenario
-- that writes sits inside begin ... rollback.
--
-- Order: the stubs (a pgmq schema whose send writes to a table and can be made to raise; the
-- production body of enqueue_cluster_work and its trigger), the post-117 privilege state with
-- Supabase's default privileges on top (so 151's new objects start out exposed and its revokes
-- have something to undo), 151 applied, 151 applied AGAIN, then the scenarios.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Prelude A: a pgmq stand-in (no extension is installed locally). -------------------------------
create schema pgmq;
create table pgmq.stub_queues (queue_name text primary key);
create table pgmq.stub_sent (id bigserial primary key, queue_name text not null, message jsonb not null);

create function pgmq.list_queues()
returns table (queue_name text, is_partitioned boolean, is_unlogged boolean, created_at timestamptz)
language sql as $$ select q.queue_name, false, false, now() from pgmq.stub_queues q $$;

-- Like pgmq.create: the live table q_<name> (identity key, so the sequence is q_<name>_msg_id_seq)
-- and the archive a_<name>.
create function pgmq.create(queue_name text) returns void language plpgsql as $$
begin
  insert into pgmq.stub_queues values (queue_name) on conflict do nothing;
  execute format(
    'create table if not exists pgmq.%I (msg_id bigint generated always as identity primary key, read_ct integer not null default 0, enqueued_at timestamptz not null default now(), vt timestamptz not null default now(), message jsonb, headers jsonb)',
    'q_' || queue_name);
  execute format(
    'create table if not exists pgmq.%I (msg_id bigint primary key, read_ct integer not null default 0, enqueued_at timestamptz not null default now(), archived_at timestamptz not null default now(), vt timestamptz not null default now(), message jsonb, headers jsonb)',
    'a_' || queue_name);
end $$;

-- send records the message; with the session setting pgmq.stub_fail = 'on' it raises (stub_fail).
create function pgmq.send(queue_name text, msg jsonb, delay integer default 0) returns bigint language plpgsql as $$
declare v bigint;
begin
  if coalesce(current_setting('pgmq.stub_fail', true), '') = 'on' then
    raise exception 'pgmq stub: send failed (stub_fail)';
  end if;
  insert into pgmq.stub_sent (queue_name, message) values (queue_name, msg) returning id into v;
  return v;
end $$;

select pgmq.create('cluster_work');
select pgmq.create('image_backfill');

-- Prelude B: 025's function and trigger exactly as production has them (read with
-- pg_get_functiondef / pg_get_triggerdef on 2026-11-02). Production's body is 025's body without
-- its comments: md5(prosrc) 858efd334d1586fdf340af3835c2ca9f, length 237.
create or replace function public.enqueue_cluster_work()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if NEW.category is null or NEW.category not in ('politika', 'son_dakika') then
    return NEW;
  end if;

  perform pgmq.send(
    'cluster_work',
    pg_catalog.jsonb_build_object('article_id', NEW.id)
  );

  return NEW;
end;
$function$;
alter function public.enqueue_cluster_work() owner to postgres;
revoke execute on function public.enqueue_cluster_work() from anon, authenticated, public;
create trigger articles_cluster_enqueue after insert on public.articles for each row
  when (new.category = any (array['politika'::text, 'son_dakika'::text])) execute function enqueue_cluster_work();

-- The md5 gate: the dry-run copy IS the production body.
do $$
declare v_md5 text; v_len int; v_def text;
begin
  select md5(prosrc), length(prosrc) into v_md5, v_len from pg_proc where oid = 'public.enqueue_cluster_work()'::regprocedure;
  if v_md5 <> '858efd334d1586fdf340af3835c2ca9f' or v_len <> 237 then
    raise exception 'the local enqueue_cluster_work body differs from production (md5 gate): % / %', v_md5, v_len;
  end if;
  select pg_get_triggerdef(oid) into v_def from pg_trigger where tgname = 'articles_cluster_enqueue' and not tgisinternal;
  if v_def <> 'CREATE TRIGGER articles_cluster_enqueue AFTER INSERT ON public.articles FOR EACH ROW WHEN ((new.category = ANY (ARRAY[''politika''::text, ''son_dakika''::text]))) EXECUTE FUNCTION enqueue_cluster_work()' then
    raise exception 'the local trigger differs from production: %', v_def;
  end if;
end $$;

-- Prelude C: the post-117 privilege state (nothing for anon/authenticated on what exists; service_role
-- keeps its table grants), then Supabase's default privileges for what is created next, in public AND,
-- as a worst case, in pgmq, so the revokes of 151 have something to undo. -----------------------------
grant usage on schema public to anon, authenticated, service_role;
revoke all on all tables in schema public from anon, authenticated, public;
revoke all on all sequences in schema public from anon, authenticated, public;
grant all on all tables in schema public to service_role;
grant usage on schema pgmq to service_role;
alter role service_role bypassrls;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema pgmq grant all on tables to anon, authenticated, public;
alter default privileges in schema pgmq grant all on sequences to anon, authenticated, public;
-- The control queue: created AFTER those defaults, so it is exposed exactly like a queue 151 creates
-- before its revokes. Check 5 asserts that the control IS exposed (the stub models the risk) and that
-- cluster_attach is not.
select pgmq.create('acl_control');
insert into supabase_migrations.schema_migrations (version, name)
  values ('150', '150_ops_queue_and_cron_liveness') on conflict do nothing;

-- Sources and the helper the scenarios use. ------------------------------------------------------
insert into public.sources (id, slug, name, kind) values
  ('d1510000-0000-0000-0000-000000000001', 'dry-outlet', 'Dry outlet', 'outlet'),
  ('d1510000-0000-0000-0000-000000000002', 'dry-wire', 'Dry wire', 'wire'),
  ('d1510000-0000-0000-0000-000000000003', 'dry-agg', 'Dry aggregator', 'aggregator'),
  ('d1510000-0000-0000-0000-000000000004', 'dry-niche', 'Dry niche', 'niche');

-- True when `stmt`, run as `role`, fails with permission denied.
create function pg_temp.denied(role_name text, stmt text) returns boolean language plpgsql as $$
declare v boolean := false;
begin
  execute format('set local role %I', role_name);
  begin
    execute stmt;
  exception when insufficient_privilege then
    v := sqlerrm like 'permission denied%';
  end;
  reset role;
  return v;
end $$;

create function pg_temp.sent(q text) returns bigint language sql as $$
  select count(*) from pgmq.stub_sent where queue_name = q $$;

-- ===== 151 applied (apply 1) ======================================================================
\echo ===== 151 apply 1
\ir ../../../supabase/migrations/151_cluster_attach_probe.sql
\echo ===== 151 apply 1 done

-- ===== 151 applied AGAIN (apply 2): no error, notices only, the ledger insert is INSERT 0 0 ========
\echo ===== 151 apply 2
\ir ../../../supabase/migrations/151_cluster_attach_probe.sql
\echo ===== 151 apply 2 done

-- ===== After: shape, grants, ledger ================================================================
\echo ===== after
select 'ledger', string_agg(version || ' ' || name, ' | ' order by version) from supabase_migrations.schema_migrations where version in ('150', '151');
select 'columns', string_agg(column_name || ' ' || data_type || ' ' || is_nullable, ', ' order by ordinal_position)
  from information_schema.columns where table_schema = 'public' and table_name = 'cluster_attach_shadow';
select 'constraints', string_agg(conname || ' ' || pg_get_constraintdef(oid), ' ; ' order by conname)
  from pg_constraint where conrelid = 'public.cluster_attach_shadow'::regclass;
select 'indexes', string_agg(indexname, ', ' order by indexname) from pg_indexes where tablename = 'cluster_attach_shadow';
select 'rls', relrowsecurity, (select count(*) from pg_policies where tablename = 'cluster_attach_shadow') as policies,
  relacl from pg_class where oid = 'public.cluster_attach_shadow'::regclass;
select 'queue acl', c.relname, coalesce(c.relacl::text, '(none)') from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'pgmq' and c.relname in ('q_cluster_attach', 'a_cluster_attach', 'q_cluster_attach_msg_id_seq') order by 2;
select 'function', p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner), coalesce(p.proacl::text, '(none)')
  from pg_proc p where p.oid = 'public.enqueue_cluster_attach_probe()'::regprocedure;
select 'trigger', pg_get_triggerdef(oid) from pg_trigger where tgname = 'articles_cluster_attach_probe' and not tgisinternal;

-- ===== Checks that raise ===========================================================================
-- 1. Idempotence: one ledger row, one trigger, one function, one index after two applies; the
--    queue exists once.
do $$
begin
  if (select count(*) from supabase_migrations.schema_migrations where version = '151') <> 1 then raise exception 'ledger 151 is not exactly one row'; end if;
  if (select count(*) from pg_trigger where tgname = 'articles_cluster_attach_probe' and not tgisinternal) <> 1 then raise exception 'trigger count'; end if;
  if (select count(*) from pg_proc where proname = 'enqueue_cluster_attach_probe') <> 1 then raise exception 'function count'; end if;
  if (select count(*) from pg_indexes where tablename = 'cluster_attach_shadow' and indexname = 'cluster_attach_shadow_created_at_idx') <> 1 then raise exception 'index count'; end if;
  if (select count(*) from pgmq.list_queues() q where q.queue_name = 'cluster_attach') <> 1 then raise exception 'queue count'; end if;
end $$;

-- 2. 025 is untouched: the same body (md5 gate again) and the same trigger.
do $$
declare v_md5 text; v_def text;
begin
  select md5(prosrc) into v_md5 from pg_proc where oid = 'public.enqueue_cluster_work()'::regprocedure;
  if v_md5 <> '858efd334d1586fdf340af3835c2ca9f' then raise exception '151 changed enqueue_cluster_work: %', v_md5; end if;
  select pg_get_triggerdef(oid) into v_def from pg_trigger where tgname = 'articles_cluster_enqueue' and not tgisinternal;
  if v_def <> 'CREATE TRIGGER articles_cluster_enqueue AFTER INSERT ON public.articles FOR EACH ROW WHEN ((new.category = ANY (ARRAY[''politika''::text, ''son_dakika''::text]))) EXECUTE FUNCTION enqueue_cluster_work()' then
    raise exception '151 changed the politika trigger: %', v_def;
  end if;
end $$;

-- 3. The new trigger and function.
do $$
declare v_def text; v_conf text[]; v_owner text; v_secdef boolean;
begin
  select pg_get_triggerdef(oid) into v_def from pg_trigger where tgname = 'articles_cluster_attach_probe' and not tgisinternal;
  if v_def <> 'CREATE TRIGGER articles_cluster_attach_probe AFTER INSERT ON public.articles FOR EACH ROW WHEN ((new.category = ANY (ARRAY[''genel''::text, ''ekonomi''::text, ''dunya''::text, ''yasam''::text, ''teknoloji''::text]))) EXECUTE FUNCTION enqueue_cluster_attach_probe()' then
    raise exception 'trigger definition: %', v_def;
  end if;
  select prosecdef, proconfig, pg_get_userbyid(proowner) into v_secdef, v_conf, v_owner from pg_proc where oid = 'public.enqueue_cluster_attach_probe()'::regprocedure;
  if not v_secdef then raise exception 'function is not security definer'; end if;
  if v_conf is distinct from array['search_path=""'] then raise exception 'search_path: %', v_conf; end if;
  if v_owner <> 'postgres' then raise exception 'owner: %', v_owner; end if;
  if has_function_privilege('anon', 'public.enqueue_cluster_attach_probe()', 'execute')
     or has_function_privilege('authenticated', 'public.enqueue_cluster_attach_probe()', 'execute') then
    raise exception 'a client role can execute the trigger function';
  end if;
  if exists (select 1 from pg_proc p, aclexplode(p.proacl) a where p.oid = 'public.enqueue_cluster_attach_probe()'::regprocedure and a.grantee = 0) then
    raise exception 'PUBLIC can execute the trigger function';
  end if;
end $$;

-- 4. The table: grants (service_role select + insert only), RLS, no policy, and the denials.
do $$
declare p text;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.cluster_attach_shadow'::regclass) then raise exception 'RLS is off'; end if;
  if (select count(*) from pg_policies where tablename = 'cluster_attach_shadow') <> 0 then raise exception 'a policy exists'; end if;
  foreach p in array array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'] loop
    if has_table_privilege('anon', 'public.cluster_attach_shadow', p) then raise exception 'anon has % on the table', p; end if;
    if has_table_privilege('authenticated', 'public.cluster_attach_shadow', p) then raise exception 'authenticated has % on the table', p; end if;
    if has_table_privilege('service_role', 'public.cluster_attach_shadow', p) <> (p in ('select', 'insert')) then
      raise exception 'service_role privilege % is wrong', p;
    end if;
  end loop;
  if exists (select 1 from pg_class c, aclexplode(c.relacl) a where c.oid = 'public.cluster_attach_shadow'::regclass and a.grantee = 0) then
    raise exception 'PUBLIC has a privilege on the table';
  end if;
end $$;

-- 5. The queue's tables and sequence carry nothing for anon, authenticated or PUBLIC.
do $$
declare rel text; p text;
begin
  foreach rel in array array['pgmq.q_cluster_attach', 'pgmq.a_cluster_attach'] loop
    foreach p in array array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'] loop
      if has_table_privilege('anon', rel, p) or has_table_privilege('authenticated', rel, p) then
        raise exception '% grants % to a client role', rel, p;
      end if;
    end loop;
    if exists (select 1 from pg_class c, aclexplode(c.relacl) a where c.oid = rel::regclass and a.grantee = 0) then
      raise exception '% grants a privilege to PUBLIC', rel;
    end if;
  end loop;
  if has_sequence_privilege('anon', 'pgmq.q_cluster_attach_msg_id_seq', 'usage') or has_sequence_privilege('authenticated', 'pgmq.q_cluster_attach_msg_id_seq', 'usage') then
    raise exception 'the queue sequence is usable by a client role';
  end if;
  -- the control: a queue created after the worst-case default privileges IS exposed, so the stub does model the risk
  if not has_table_privilege('anon', 'pgmq.q_acl_control', 'select') or not has_table_privilege('authenticated', 'pgmq.a_acl_control', 'insert')
     or not has_sequence_privilege('anon', 'pgmq.q_acl_control_msg_id_seq', 'usage') then
    raise exception 'control: the default privileges of the stub did not apply';
  end if;
end $$;

-- ===== Scenarios (each inside begin ... rollback) ==================================================

-- S1. A politika insert enqueues exactly one cluster_work {article_id} and nothing on cluster_attach.
begin;
insert into public.articles (id, source_id, title, category) values
  ('a1510000-0000-0000-0000-000000000001', 'd1510000-0000-0000-0000-000000000001', 'politika outlet', 'politika');
do $$
begin
  if pg_temp.sent('cluster_work') <> 1 then raise exception 'S1: cluster_work count %', pg_temp.sent('cluster_work'); end if;
  if pg_temp.sent('cluster_attach') <> 0 then raise exception 'S1: cluster_attach count %', pg_temp.sent('cluster_attach'); end if;
  if (select message from pgmq.stub_sent where queue_name = 'cluster_work') <> '{"article_id": "a1510000-0000-0000-0000-000000000001"}'::jsonb then
    raise exception 'S1: cluster_work payload %', (select message from pgmq.stub_sent where queue_name = 'cluster_work');
  end if;
end $$;
rollback;

-- S1b. son_dakika too (025's path, unchanged).
begin;
insert into public.articles (id, source_id, title, category) values
  ('a1510000-0000-0000-0000-000000000002', 'd1510000-0000-0000-0000-000000000001', 'son dakika outlet', 'son_dakika');
do $$
begin
  if pg_temp.sent('cluster_work') <> 1 or pg_temp.sent('cluster_attach') <> 0 then raise exception 'S1b: counts % / %', pg_temp.sent('cluster_work'), pg_temp.sent('cluster_attach'); end if;
end $$;
rollback;

-- S2. A genel / outlet insert enqueues exactly one cluster_attach {article_id, admit: 'attach'} and nothing on cluster_work.
begin;
insert into public.articles (id, source_id, title, category) values
  ('a1510000-0000-0000-0000-000000000003', 'd1510000-0000-0000-0000-000000000001', 'genel outlet', 'genel');
do $$
begin
  if pg_temp.sent('cluster_attach') <> 1 then raise exception 'S2: cluster_attach count %', pg_temp.sent('cluster_attach'); end if;
  if pg_temp.sent('cluster_work') <> 0 then raise exception 'S2: cluster_work count %', pg_temp.sent('cluster_work'); end if;
  if (select message from pgmq.stub_sent where queue_name = 'cluster_attach') <> '{"admit": "attach", "article_id": "a1510000-0000-0000-0000-000000000003"}'::jsonb then
    raise exception 'S2: cluster_attach payload %', (select message from pgmq.stub_sent where queue_name = 'cluster_attach');
  end if;
end $$;
rollback;

-- S2b. A wire source and the other four categories enqueue as well.
begin;
insert into public.articles (id, source_id, title, category) values
  (gen_random_uuid(), 'd1510000-0000-0000-0000-000000000002', 'genel wire', 'genel'),
  (gen_random_uuid(), 'd1510000-0000-0000-0000-000000000001', 'ekonomi outlet', 'ekonomi'),
  (gen_random_uuid(), 'd1510000-0000-0000-0000-000000000001', 'dunya outlet', 'dunya'),
  (gen_random_uuid(), 'd1510000-0000-0000-0000-000000000001', 'yasam outlet', 'yasam'),
  (gen_random_uuid(), 'd1510000-0000-0000-0000-000000000001', 'teknoloji outlet', 'teknoloji');
do $$
begin
  if pg_temp.sent('cluster_attach') <> 5 or pg_temp.sent('cluster_work') <> 0 then raise exception 'S2b: counts % / %', pg_temp.sent('cluster_attach'), pg_temp.sent('cluster_work'); end if;
end $$;
rollback;

-- S3. genel / aggregator, genel / niche, spor / outlet, null-category and null-source inserts enqueue nothing.
begin;
insert into public.articles (id, source_id, title, category) values
  (gen_random_uuid(), 'd1510000-0000-0000-0000-000000000003', 'genel aggregator', 'genel'),
  (gen_random_uuid(), 'd1510000-0000-0000-0000-000000000004', 'genel niche', 'genel'),
  (gen_random_uuid(), 'd1510000-0000-0000-0000-000000000001', 'spor outlet', 'spor'),
  (gen_random_uuid(), 'd1510000-0000-0000-0000-000000000001', 'null category outlet', null),
  (gen_random_uuid(), null, 'genel without a source', 'genel');
do $$
begin
  if (select count(*) from pgmq.stub_sent) <> 0 then raise exception 'S3: % message(s) were enqueued', (select count(*) from pgmq.stub_sent); end if;
end $$;
rollback;

-- S4. With the queue send stubbed to raise (stub_fail), the insert still commits (WARNING only), nothing is enqueued.
begin;
set local pgmq.stub_fail = 'on';
insert into public.articles (id, source_id, title, category) values
  ('a1510000-0000-0000-0000-000000000004', 'd1510000-0000-0000-0000-000000000001', 'send fails', 'genel');
do $$
begin
  if (select count(*) from public.articles where id = 'a1510000-0000-0000-0000-000000000004') <> 1 then raise exception 'S4: the insert did not commit'; end if;
  if (select count(*) from pgmq.stub_sent) <> 0 then raise exception 'S4: a message was recorded'; end if;
end $$;
commit;
-- (the row above was really committed: remove it)
delete from public.articles where id = 'a1510000-0000-0000-0000-000000000004';

-- S4b. The definer path: an insert by service_role (no usage on pgmq assumed beyond the grant) still enqueues.
begin;
revoke usage on schema pgmq from service_role;
set local role service_role;
insert into public.articles (id, source_id, title, category) values
  ('a1510000-0000-0000-0000-000000000005', 'd1510000-0000-0000-0000-000000000001', 'inserted by service_role', 'genel');
reset role;
do $$
begin
  if pg_temp.sent('cluster_attach') <> 1 then raise exception 'S4b: cluster_attach count %', pg_temp.sent('cluster_attach'); end if;
end $$;
rollback;

-- S5. anon / authenticated are denied select and insert on cluster_attach_shadow and execute on the function;
--     service_role may select and insert (on conflict do nothing keeps the first row) but not update, delete, truncate.
begin;
insert into public.articles (id, source_id, title, category) values
  ('a1510000-0000-0000-0000-000000000006', 'd1510000-0000-0000-0000-000000000001', 'shadow row', 'genel');
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if not pg_temp.denied(r, 'select count(*) from public.cluster_attach_shadow') then raise exception 'S5: % can select (no permission denied)', r; end if;
    if not pg_temp.denied(r, $q$insert into public.cluster_attach_shadow (article_id, cluster_id, score, lane, mode) values ('a1510000-0000-0000-0000-000000000006', 'c1510000-0000-0000-0000-000000000001', 1, 'exact-title', 'shadow')$q$) then
      raise exception 'S5: % can insert (no permission denied)', r;
    end if;
    if not pg_temp.denied(r, $q$insert into public.cluster_attach_shadow (article_id, cluster_id, score, lane, mode) values ('a1510000-0000-0000-0000-000000000006', 'c1510000-0000-0000-0000-000000000001', 1, 'exact-title', 'shadow') on conflict (article_id) do nothing$q$) then
      raise exception 'S5: % can upsert (no permission denied)', r;
    end if;
    if not pg_temp.denied(r, 'select public.enqueue_cluster_attach_probe()') then raise exception 'S5: % can execute the function (no permission denied)', r; end if;
  end loop;
end $$;
set local role service_role;
insert into public.cluster_attach_shadow (article_id, cluster_id, score, lane, mode)
  values ('a1510000-0000-0000-0000-000000000006', 'c1510000-0000-0000-0000-0000000000ff', 0.92, 'headline', 'shadow') on conflict (article_id) do nothing;
insert into public.cluster_attach_shadow (article_id, cluster_id, score, lane, mode)
  values ('a1510000-0000-0000-0000-000000000006', 'c1510000-0000-0000-0000-000000000001', 1, 'exact-title', 'live') on conflict (article_id) do nothing;
reset role;
do $$
begin
  if (select count(*) from public.cluster_attach_shadow) <> 1 then raise exception 'S5: row count'; end if;
  if (select lane || ' ' || mode from public.cluster_attach_shadow) <> 'headline shadow' then raise exception 'S5: the first row did not stay'; end if;
  -- a cluster id that matches no cluster is accepted (no foreign key on cluster_id)
  if pg_temp.denied('service_role', 'update public.cluster_attach_shadow set score = 0') = false then raise exception 'S5: service_role can update'; end if;
  if pg_temp.denied('service_role', 'delete from public.cluster_attach_shadow') = false then raise exception 'S5: service_role can delete'; end if;
  if pg_temp.denied('service_role', 'truncate public.cluster_attach_shadow') = false then raise exception 'S5: service_role can truncate'; end if;
end $$;
rollback;

-- S6. The check constraints and the not-null columns; deleting the article cascades.
begin;
insert into public.articles (id, source_id, title, category) values
  ('a1510000-0000-0000-0000-000000000007', 'd1510000-0000-0000-0000-000000000001', 'one', 'genel'),
  ('a1510000-0000-0000-0000-000000000008', 'd1510000-0000-0000-0000-000000000001', 'two', 'genel');
do $$
declare bad text;
begin
  foreach bad in array array[
    $q$'a1510000-0000-0000-0000-000000000007', 'c1510000-0000-0000-0000-000000000001', 1, 'tfidf', 'shadow'$q$,
    $q$'a1510000-0000-0000-0000-000000000007', 'c1510000-0000-0000-0000-000000000001', 1, 'headline', 'dry'$q$,
    $q$'a1510000-0000-0000-0000-000000000007', null, 1, 'headline', 'shadow'$q$,
    $q$'a1510000-0000-0000-0000-000000000007', 'c1510000-0000-0000-0000-000000000001', null, 'headline', 'shadow'$q$
  ] loop
    begin
      execute 'insert into public.cluster_attach_shadow (article_id, cluster_id, score, lane, mode) values (' || bad || ')';
      raise exception 'S6: the insert (%) was accepted', bad;
    exception when check_violation or not_null_violation then null;
    end;
  end loop;
end $$;
insert into public.cluster_attach_shadow (article_id, cluster_id, score, lane, mode) values
  ('a1510000-0000-0000-0000-000000000007', 'c1510000-0000-0000-0000-000000000001', 1, 'headline', 'shadow'),
  ('a1510000-0000-0000-0000-000000000008', 'c1510000-0000-0000-0000-000000000001', 1, 'headline', 'shadow');
delete from public.articles where id = 'a1510000-0000-0000-0000-000000000007';
do $$
begin
  if (select count(*) from public.cluster_attach_shadow) <> 1 then raise exception 'S6: the cascade did not remove exactly one row'; end if;
  if (select article_id from public.cluster_attach_shadow) <> 'a1510000-0000-0000-0000-000000000008' then raise exception 'S6: the wrong row survived'; end if;
end $$;
rollback;

-- Nothing the scenarios did is left behind (the queue stub is empty, no article of a1510000 remains).
do $$
begin
  if (select count(*) from pgmq.stub_sent) <> 0 then raise exception 'residue: stub_sent'; end if;
  if (select count(*) from public.articles where id::text like 'a1510000-%') <> 0 then raise exception 'residue: articles'; end if;
  if (select count(*) from public.cluster_attach_shadow) <> 0 then raise exception 'residue: cluster_attach_shadow'; end if;
end $$;

\echo DRYRUN 151 OK
