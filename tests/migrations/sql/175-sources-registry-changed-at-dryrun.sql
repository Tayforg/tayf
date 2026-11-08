-- 175 sources_registry_changed_at (sources.registry_changed_at, stamped by a BEFORE UPDATE trigger when one of 15 registry
-- columns changes, never by the fetch_* columns ingest writes): local PG15 dry-run.
-- Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55575 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55575 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/175-sources-registry-changed-at-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql PGHOST=/tmp PGPORT=55575 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/175-sources-registry-changed-at)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh
--
-- (\ir paths below are relative to this file.) Every check is a DO block that raises on mismatch, so a clean run ending
-- in "DRYRUN 175 OK" is the pass. The database this leaves behind holds no sources rows.
--
-- Order: production's public.sources before 175 (the columns the stub lacks, with production's types, defaults and NOT
-- NULLs: 27 columns, read 2026-11-08), a check that the prelude has exactly production's column list, three rows that
-- exist BEFORE 175, then 175 TWICE. After the first apply every pre-existing row must read a time between two clock reads
-- taken around the apply (the fast default), after the second apply no stamp may have moved, and the column, the
-- function's search_path and ACL (the stub's default privileges hand anon and authenticated EXECUTE on a new function, so
-- the revoke is exercised), the trigger's type and WHEN text are read back. Last, one UPDATE per registry column (must
-- move that row's stamp and not its neighbour's) and one per ignored column (must move nothing).

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Prelude: production's public.sources before 175. ---------------------------------------------------------
alter table public.sources add column if not exists logo_url text;
alter table public.sources add column if not exists created_at timestamptz not null default now();
alter table public.sources add column if not exists tradition text not null default 'mainstream';
alter table public.sources add column if not exists source_type text not null default 'general';
alter table public.sources add column if not exists fetch_etag text;
alter table public.sources add column if not exists fetch_last_modified text;
alter table public.sources add column if not exists fetch_body_hash text;
alter table public.sources add column if not exists fetch_last_status integer;
alter table public.sources add column if not exists fetch_last_at timestamptz;
alter table public.sources add column if not exists image_allowed boolean not null default true;
alter table public.sources add column if not exists excerpt_allowed boolean not null default true;
alter table public.sources add column if not exists zone_rationale text;
alter table public.sources add column if not exists zone_rationale_at timestamptz;
alter table public.sources add column if not exists trustee_since date;
alter table public.sources add column if not exists trustee_note text;
alter table public.sources add column if not exists fetch_fail_streak integer not null default 0;
alter table public.sources add column if not exists fetch_quarantined_until timestamptz;
alter table public.sources add column if not exists fetch_newest_item_at timestamptz;
alter table public.sources add column if not exists fetch_items_count integer;
-- the stub leaves these nullable; production has them NOT NULL
alter table public.sources alter column name set not null;
alter table public.sources alter column slug set not null;
alter table public.sources alter column url set not null;
alter table public.sources alter column rss_url set not null;
alter table public.sources alter column bias set not null;
alter table public.sources alter column active set not null;
alter table public.sources alter column kind set not null;

do $$
declare have text[]; want text[];
begin
  select array_agg(column_name::text order by column_name) into have
    from information_schema.columns where table_schema = 'public' and table_name = 'sources';
  want := array[
    'id', 'name', 'slug', 'url', 'rss_url', 'bias', 'logo_url', 'active', 'created_at', 'tradition', 'source_type', 'kind',
    'fetch_etag', 'fetch_last_modified', 'fetch_body_hash', 'fetch_last_status', 'fetch_last_at', 'image_allowed',
    'excerpt_allowed', 'zone_rationale', 'zone_rationale_at', 'trustee_since', 'trustee_note', 'fetch_fail_streak',
    'fetch_quarantined_until', 'fetch_newest_item_at', 'fetch_items_count'
  ];
  select array_agg(c order by c) into want from unnest(want) c;
  if have is distinct from want then
    raise exception 'prelude: sources columns are % , production has %', have, want;
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sources' and column_name = 'registry_changed_at') then
    raise exception 'prelude: registry_changed_at exists before 175';
  end if;
end $$;

-- Three sources that exist BEFORE 175, the way production's 144 do. -----------------------------------------
insert into public.sources (id, slug, name, bias, url, rss_url, kind, created_at) values
  ('00000000-0000-4000-8000-0000000000a1', 'dry-old-1', 'Old 1', 'center', 'https://one.example', 'https://one.example/rss', 'outlet', timestamptz '2026-04-06 14:20:11.360187+00'),
  ('00000000-0000-4000-8000-0000000000a2', 'dry-old-2', 'Old 2', 'center', 'https://two.example', 'https://two.example/rss', 'wire', timestamptz '2026-04-06 14:20:11.360187+00'),
  ('00000000-0000-4000-8000-0000000000a3', 'dry-old-3', 'Old 3', 'opposition_leaning', 'https://three.example', 'https://three.example/rss', 'aggregator', timestamptz '2026-04-06 14:20:11.360187+00');

-- 175, first apply, between two clock reads. ------------------------------------------------------------------
select clock_timestamp() as t0 \gset
\ir ../../../supabase/migrations/175_sources_registry_changed_at.sql
select clock_timestamp() as t1 \gset
create temp table dry_clock as select :'t0'::timestamptz as t0, :'t1'::timestamptz as t1;
create temp table dry_first as select slug, registry_changed_at from public.sources;

do $$
declare c record; k record; n integer;
begin
  select * into k from dry_clock;

  -- the column
  select data_type, is_nullable, column_default into c from information_schema.columns
   where table_schema = 'public' and table_name = 'sources' and column_name = 'registry_changed_at';
  if c.data_type <> 'timestamp with time zone' or c.is_nullable <> 'NO' or c.column_default <> 'now()' then
    raise exception 'column: %, %, %', c.data_type, c.is_nullable, c.column_default;
  end if;
  select count(*) into n from information_schema.columns where table_schema = 'public' and table_name = 'sources';
  if n <> 28 then raise exception 'column: sources has % columns, expected 28', n; end if;

  -- the fast default: every pre-existing row reads one time, inside the apply
  select count(*) into n from public.sources;
  if n <> 3 then raise exception 'stamps: % rows', n; end if;
  select count(distinct registry_changed_at) into n from public.sources;
  if n <> 1 then raise exception 'stamps: % distinct values over the pre-existing rows, expected 1', n; end if;
  if exists (select 1 from public.sources where registry_changed_at < k.t0 or registry_changed_at > k.t1) then
    raise exception 'stamps: a pre-existing row is outside [%, %]', k.t0, k.t1;
  end if;
  -- the old rows did not keep their created_at (that is the bug this migration answers)
  if exists (select 1 from public.sources where registry_changed_at <= created_at) then
    raise exception 'stamps: a pre-existing row still reads its created_at';
  end if;
end $$;

-- 175, second apply: nothing moves, nothing is duplicated. --------------------------------------------------
\ir ../../../supabase/migrations/175_sources_registry_changed_at.sql

do $$
declare n integer;
begin
  select count(*) into n from public.sources s join dry_first f using (slug)
   where s.registry_changed_at is distinct from f.registry_changed_at;
  if n <> 0 then raise exception 're-apply: % stamps moved', n; end if;
  select count(*) into n from pg_trigger where tgrelid = 'public.sources'::regclass and tgname = 'sources_registry_changed_at_trg' and not tgisinternal;
  if n <> 1 then raise exception 're-apply: % triggers named sources_registry_changed_at_trg', n; end if;
  select count(*) into n from pg_proc where proname = 'sources_touch_registry_changed_at' and pronamespace = 'public'::regnamespace;
  if n <> 1 then raise exception 're-apply: % functions', n; end if;
  select count(*) into n from supabase_migrations.schema_migrations where version = '175';
  if n <> 1 then raise exception 're-apply: % ledger rows for 175', n; end if;
  select count(*) into n from pg_trigger where tgrelid = 'public.sources'::regclass and not tgisinternal;
  if n <> 1 then raise exception 're-apply: % user triggers on sources (the stub has none, 175 adds one)', n; end if;
end $$;

-- The function and the trigger as read back. -----------------------------------------------------------------
do $$
declare p record; t record; terms integer;
begin
  select proconfig as cfg, prosecdef, proowner, proacl, oid into p
    from pg_proc where oid = 'public.sources_touch_registry_changed_at()'::regprocedure;
  if p.cfg is distinct from array['search_path=""']::text[] then raise exception 'function: proconfig %', p.cfg; end if;
  if p.prosecdef then raise exception 'function: is SECURITY DEFINER'; end if;
  if has_function_privilege('anon', p.oid, 'execute') then raise exception 'function: anon can execute'; end if;
  if has_function_privilege('authenticated', p.oid, 'execute') then raise exception 'function: authenticated can execute'; end if;
  if exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) then
    raise exception 'function: PUBLIC can execute';
  end if;

  select tgenabled, tgtype, pg_get_triggerdef(oid) as def into t
    from pg_trigger where tgrelid = 'public.sources'::regclass and tgname = 'sources_registry_changed_at_trg';
  if t.tgenabled <> 'O' then raise exception 'trigger: tgenabled %', t.tgenabled; end if;
  -- 1 row + 2 before + 16 update, no insert, delete or truncate
  if t.tgtype <> 19 then raise exception 'trigger: tgtype %', t.tgtype; end if;
  if t.def not like '%BEFORE UPDATE ON public.sources FOR EACH ROW WHEN%' then raise exception 'trigger: %', t.def; end if;
  if t.def like '%fetch_%' then raise exception 'trigger: the definition names a fetch_ column: %', t.def; end if;
  terms := (length(t.def) - length(replace(t.def, 'IS DISTINCT FROM', ''))) / length('IS DISTINCT FROM');
  if terms <> 15 then raise exception 'trigger: % IS DISTINCT FROM terms, expected 15', terms; end if;
end $$;

-- One UPDATE per column. A registry column moves the updated row's stamp and not its neighbour's; every column a job
-- writes (the nine fetch_*, plus created_at and zone_rationale_at) moves nothing. ---------------------------------
create temp table dry_changes (ord serial, kind text, col text, expr text);
insert into dry_changes (kind, col, expr) values
  ('registry', 'name', $e$name = coalesce(name, '') || ' x'$e$),
  ('registry', 'slug', $e$slug = coalesce(slug, '') || '-x'$e$),
  ('registry', 'url', $e$url = coalesce(url, '') || 'x'$e$),
  ('registry', 'rss_url', $e$rss_url = coalesce(rss_url, '') || 'x'$e$),
  ('registry', 'bias', $e$bias = case when bias = 'center' then 'opposition' else 'center' end$e$),
  ('registry', 'kind', $e$kind = case when kind = 'outlet' then 'wire' else 'outlet' end$e$),
  ('registry', 'active', $e$active = not active$e$),
  ('registry', 'logo_url', $e$logo_url = coalesce(logo_url, '') || 'x'$e$),
  ('registry', 'tradition', $e$tradition = tradition || 'x'$e$),
  ('registry', 'source_type', $e$source_type = source_type || 'x'$e$),
  ('registry', 'image_allowed', $e$image_allowed = not image_allowed$e$),
  ('registry', 'excerpt_allowed', $e$excerpt_allowed = not excerpt_allowed$e$),
  ('registry', 'zone_rationale', $e$zone_rationale = coalesce(zone_rationale, '') || 'x'$e$),
  ('registry', 'trustee_since', $e$trustee_since = coalesce(trustee_since, date '2026-01-01') + 1$e$),
  ('registry', 'trustee_note', $e$trustee_note = coalesce(trustee_note, '') || 'x'$e$),
  ('ignored', 'fetch_etag', $e$fetch_etag = coalesce(fetch_etag, '') || 'x'$e$),
  ('ignored', 'fetch_last_modified', $e$fetch_last_modified = coalesce(fetch_last_modified, '') || 'x'$e$),
  ('ignored', 'fetch_body_hash', $e$fetch_body_hash = coalesce(fetch_body_hash, '') || 'x'$e$),
  ('ignored', 'fetch_last_status', $e$fetch_last_status = coalesce(fetch_last_status, 0) + 1$e$),
  ('ignored', 'fetch_last_at', $e$fetch_last_at = clock_timestamp()$e$),
  ('ignored', 'fetch_fail_streak', $e$fetch_fail_streak = fetch_fail_streak + 1$e$),
  ('ignored', 'fetch_quarantined_until', $e$fetch_quarantined_until = clock_timestamp() + interval '1 hour'$e$),
  ('ignored', 'fetch_newest_item_at', $e$fetch_newest_item_at = clock_timestamp()$e$),
  ('ignored', 'fetch_items_count', $e$fetch_items_count = coalesce(fetch_items_count, 0) + 1$e$),
  ('ignored', 'created_at', $e$created_at = created_at + interval '1 day'$e$),
  ('ignored', 'zone_rationale_at', $e$zone_rationale_at = clock_timestamp()$e$);

do $$
declare r record; moved_a boolean; moved_b boolean; old_stamp constant timestamptz := timestamptz '2020-01-01 00:00:00+00';
begin
  for r in select * from dry_changes order by ord loop
    -- a write of the stamp alone does not fire the trigger, so this puts both rows back to the old value
    update public.sources set registry_changed_at = old_stamp;
    execute format('update public.sources set %s where id = %L', r.expr, '00000000-0000-4000-8000-0000000000a1');
    select registry_changed_at > old_stamp into moved_a from public.sources where id = '00000000-0000-4000-8000-0000000000a1';
    select registry_changed_at > old_stamp into moved_b from public.sources where id = '00000000-0000-4000-8000-0000000000a2';
    if r.kind = 'registry' and not (moved_a and not moved_b) then
      raise exception 'registry column %: moved row a = %, row b = % (expected true, false)', r.col, moved_a, moved_b;
    end if;
    if r.kind = 'ignored' and (moved_a or moved_b) then
      raise exception 'ignored column %: moved row a = %, row b = % (expected false, false)', r.col, moved_a, moved_b;
    end if;
  end loop;
end $$;

-- ingest's statement: all nine fetch_* columns on every row at once. ------------------------------------------
do $$
declare old_stamp constant timestamptz := timestamptz '2020-01-01 00:00:00+00'; n integer;
begin
  update public.sources set registry_changed_at = old_stamp;
  update public.sources set
    fetch_etag = 'e', fetch_last_modified = 'm', fetch_body_hash = 'h', fetch_last_status = 200, fetch_last_at = clock_timestamp(),
    fetch_fail_streak = 0, fetch_quarantined_until = null, fetch_newest_item_at = clock_timestamp(), fetch_items_count = 40;
  select count(*) into n from public.sources where registry_changed_at > old_stamp;
  if n <> 0 then raise exception 'ingest-shaped update moved % stamps', n; end if;
  -- an update that carries a registry change next to the fetch_* columns does move that row
  update public.sources set kind = 'niche', fetch_fail_streak = 1, fetch_last_at = clock_timestamp() where id = '00000000-0000-4000-8000-0000000000a3';
  select count(*) into n from public.sources where registry_changed_at > old_stamp;
  if n <> 1 then raise exception 'mixed update moved % stamps, expected 1', n; end if;
  -- an update that writes the same values moves nothing
  update public.sources set registry_changed_at = old_stamp;
  update public.sources set kind = kind, name = name, active = active, trustee_since = trustee_since;
  select count(*) into n from public.sources where registry_changed_at > old_stamp;
  if n <> 0 then raise exception 'no-op update moved % stamps', n; end if;
end $$;

-- A row inserted after 175 gets its own insert time, not the migration's. -------------------------------------
insert into public.sources (id, slug, name, bias, url, rss_url) values
  ('00000000-0000-4000-8000-0000000000b1', 'dry-new', 'New', 'center', 'https://new.example', 'https://new.example/rss');
do $$
declare k record; s timestamptz;
begin
  select * into k from dry_clock;
  select registry_changed_at into s from public.sources where id = '00000000-0000-4000-8000-0000000000b1';
  if s <= k.t1 then raise exception 'insert: stamp % is not after the apply (%)', s, k.t1; end if;
end $$;

-- The dry run leaves no sources rows behind. -------------------------------------------------------------------
delete from public.sources;
do $$
begin
  if (select count(*) from public.sources) <> 0 then
    raise exception 'the dry run left sources rows behind';
  end if;
end $$;

select 'DRYRUN 175 OK';
