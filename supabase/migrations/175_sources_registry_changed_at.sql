-- 175_sources_registry_changed_at.sql
-- h69-jsonld-1 (hunt 69). public.sources gets registry_changed_at, a stamp that moves when a registry column changes, so the
-- /sources Dataset JSON-LD can state a dateModified that is not months too early.
--
-- WHY
--   /sources prints a Dataset block whose description promises "yanlılık kategorisi, tür (outlet/aggregator/wire/niche),
--   hak bayrakları ve kayyum durumu". Its dateModified is the latest of every active source's created_at and
--   zone_rationale_at and the newest source_zone_history row. Re-verified on 2026-11-08 (~10:25 UTC, one GET plus read-only
--   SQL): the page says "dateModified":"2026-04-06T14:20:11.360Z"; max(sources.created_at) is 2026-04-06 14:20:11.360187+00
--   over 144 rows, count(zone_rationale_at is not null) is 0 and source_zone_history is empty (sources_zone_history_insert_trg
--   was created after all 144 rows existed, so no origin row was ever written, and no bias UPDATE has happened since).
--   The registry changed after that date: 034_source_kind (ledger version 20260906221636, 2026-09-06) set kind on 38
--   rows, and 055_source_zone_registry section 5 (trustee dates "verified 2026-09-18") set trustee_since on 3 rows. None of
--   created_at, zone_rationale_at or the history moves for kind, kayyum status, rights flags, name, URL or active, and
--   sources has no updated_at. The stated date is about five months early, and src/app/sources/page.tsx's own comment
--   calls a too-early date worse than none.
--
-- WHAT CHANGES (one column, one trigger function, one trigger; no data is written)
--   1. alter table public.sources add column if not exists registry_changed_at timestamptz not null default now().
--      now() is STABLE, so Postgres evaluates it once at ALTER time and stores it as a fast default: no table rewrite,
--      no row is updated. Every row that exists when 175 runs reads the migration's transaction time until its first
--      registry edit, and a row inserted later gets its own insert time. The column comment says so.
--   2. public.sources_touch_registry_changed_at(): a trigger function, language plpgsql, set search_path = '', NOT SECURITY
--      DEFINER (it only assigns a column of NEW and reads no table). It sets new.registry_changed_at := pg_catalog.now()
--      and returns new. Revoked from public, anon and authenticated (Supabase grants EXECUTE to anon and authenticated at
--      creation; 055 and 151 name all of them the same way).
--   3. sources_registry_changed_at_trg: BEFORE UPDATE FOR EACH ROW on public.sources, WHEN old.c is distinct from new.c for
--      exactly these 15 columns, OR-ed: name, slug, url, rss_url, bias, kind, active, logo_url, tradition, source_type,
--      image_allowed, excerpt_allowed, zone_rationale, trustee_since, trustee_note. IS DISTINCT FROM is null-safe (null to
--      a value and a value to null both count) and a write of a column's own value does not. The clause names no fetch_*
--      column and not registry_changed_at itself, so a write of the stamp alone is kept as written.
--   4. set local lock_timeout = '5s' first, so a conflicting lock on sources (the ALTER and the trigger DDL take heavy
--      ones) fails the apply fast instead of queueing every reader of sources behind it. notify pgrst, 'reload schema'
--      (a new column on a table the app reads through PostgREST). The ledger row in the 095 pattern.
--
-- STEP 0 (read-only, production, 2026-11-08): what the WHEN clause must leave out
--   information_schema.columns of public.sources, 27 columns before 175: id, name, slug, url, rss_url, bias, logo_url,
--   active, created_at, tradition, source_type, kind, fetch_etag, fetch_last_modified, fetch_body_hash, fetch_last_status,
--   fetch_last_at, image_allowed, excerpt_allowed, zone_rationale, zone_rationale_at, trustee_since, trustee_note,
--   fetch_fail_streak, fetch_quarantined_until, fetch_newest_item_at, fetch_items_count. RLS on; relacl
--   {postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres} (a new column keeps the table's ACL). PostgreSQL 17.6.
--   Triggers on public.sources before 175 (pg_trigger, not internal): sources_zone_history_insert_trg (AFTER INSERT) and
--   sources_zone_history_trg (AFTER UPDATE OF bias, WHEN old.bias is distinct from new.bias), both enabled, both running
--   sources_record_zone_history(). 175 adds a BEFORE trigger beside them; they do not interact (a bias change fires both).
--   Columns written by automated jobs, all of them (pg_proc scan of every non-system schema for update, insert or delete
--   on sources, cron.job commands mentioning sources, and a grep of supabase/functions, src and scripts):
--     * ingest_set_source_fetch_state(jsonb) (041, 074, 119; called by the ingest Edge Function through
--       supabase.rpc("ingest_set_source_fetch_state") every few minutes, one UPDATE ... FROM jsonb_to_recordset per flush
--       over every active feed): fetch_etag, fetch_last_modified, fetch_body_hash, fetch_last_status, fetch_last_at,
--       fetch_fail_streak, fetch_quarantined_until, fetch_newest_item_at, fetch_items_count. These nine are the whole set of
--       high-frequency columns; the clause leaves every one out.
--     * set_source_bias(text, text, text, text) (055): writes bias only, and only on a deliberate relabel with a reason.
--       It is a registry change, so bias IS in the clause.
--     * delete_source(uuid) (128): deletes a row, which fires no UPDATE trigger (see KNOWN LIMIT).
--     * No cron.job command mentions sources, and no Edge Function, script or other function updates the table. The Edge
--       Functions cluster-consumer, image-consumer, jev-shadow and ingest only SELECT from it.
--   Columns written by people (the admin route src/app/api/admin/route.ts): update_source (name, slug, url, rss_url, kind,
--   active), toggle (active), add_source (an INSERT), set_source_rights (image_allowed, excerpt_allowed),
--   set_source_registry (zone_rationale with zone_rationale_at, trustee_since, trustee_note). logo_url is set by migration
--   011 and tradition and source_type were added by 152; no job or route writes them since. All are in the clause except
--   zone_rationale_at, which the route always writes together with zone_rationale; the page still reads
--   zone_rationale_at as one more input.
--   Left out on purpose: id (never changes), created_at, zone_rationale_at, registry_changed_at, and the nine fetch_*
--   columns above.
--
-- REPLAY (read-only on production, 2026-11-08, before 175)
--   select max(created_at), count(*) filter (where kind <> 'outlet'), count(*) filter (where trustee_since is not null)
--     from public.sources   ->  2026-04-06 14:20:11.360187+00, 38, 3
--   curl -s https://www.tayfhaber.com/sources | grep -o '"dateModified":"[^"]*"'   ->  "dateModified":"2026-04-06T14:20:11.360Z"
--   After 175 and the deploy: select max(registry_changed_at) from public.sources is the apply time, the same curl prints
--   it (after the 1 h source-directory cache window), and it moves again at the next kind, rights, trustee, name, URL or
--   active edit but not at the next ingest cycle.
--
-- DRY RUN (local PG15, tests/migrations/sql/175-sources-registry-changed-at-dryrun.sql): builds production's 27-column
--   sources on the stub (the columns the stub lacks, with production's types and defaults), inserts three rows, applies 175
--   twice, checks the stamps (every pre-existing row reads a time between the two clocks around the first apply, and the
--   second apply moves none), the column, the function's search_path and ACL (the stub's default privileges hand anon,
--   authenticated and service_role EXECUTE, so the revoke is exercised), the trigger's type and WHEN text, and one change
--   per registry column and per ignored column. It ends with DRYRUN 175 OK. The live vitest block runs on the database it
--   leaves behind (live-manifest.txt).
--
-- DEPLOY: APPLY 175 FIRST, THEN DEPLOY THE APP (Vercel). 175 is additive and nothing in the old app reads the column.
--   The new /sources page reads sources.registry_changed_at; before 175 that read errors and the page omits dateModified
--   (it never falls back to the old, too-early value), and the page caches a read for source-directory (1 h), so
--   deploying first leaves the date out for up to an hour. No Edge Function deploy, no cron change.
--   Apply with the usual path (supabase db push, or post the SQL); the file is one transaction and safe to re-apply (the
--   column is `if not exists`, so a re-apply does not move any stamp; the function is replaced; the trigger is dropped and
--   created again).
--
-- VERIFY (read-only, after applying):
--   select column_name, data_type, is_nullable, column_default from information_schema.columns
--     where table_schema = 'public' and table_name = 'sources' and column_name = 'registry_changed_at'
--     -> timestamp with time zone, NO, now();
--   select min(registry_changed_at), max(registry_changed_at), count(*) from public.sources  -> one value (the apply time), 144;
--   select tgenabled, tgtype, pg_get_triggerdef(oid) from pg_trigger where tgrelid = 'public.sources'::regclass
--     and tgname = 'sources_registry_changed_at_trg'  -> O, 19, a definition with 15 "IS DISTINCT FROM" terms and no fetch_;
--   select proconfig = array['search_path=""'], prosecdef, has_function_privilege('anon', oid, 'execute'),
--     has_function_privilege('authenticated', oid, 'execute')
--     from pg_proc where oid = 'public.sources_touch_registry_changed_at()'::regprocedure  -> t, f, f, f;
--   select version, name from supabase_migrations.schema_migrations where version = '175'  -> one row.
--   After an ingest cycle (five minutes) max(registry_changed_at) is unchanged. After the deploy and the cache window,
--   curl -s https://www.tayfhaber.com/sources | grep -o '"dateModified":"[^"]*"' prints that max.
--
-- OUT OF SCOPE: source_zone_history is not backfilled. It is append-only and holds no origin rows for the 144 sources;
--   inserting them would be a founder decision, and this stamp does not need them. No UPDATE of existing rows: the fast
--   default is the only value the old rows get. The Dataset description text and src/lib/seo/json-ld.ts are unchanged.
--
-- KNOWN LIMIT: dateModified starts at the apply time, not at the real last edit (2026-09-18): every old row reads the
--   migration's transaction time, so it is an upper bound that is never too early. A delete_source removes the row and
--   stamps nothing; if that row held the newest stamp the page steps back to the next newest one, which is never older
--   than the apply time while one pre-175 row remains. TRUNCATE and a bulk copy that bypasses UPDATE are not stamped.
--
-- ROLLBACK (not expected to be needed): nothing reads the column except the new page, which voids dateModified when the
--   read fails, so roll the app back first or accept the missing date. Then, in one transaction:
--     drop trigger if exists sources_registry_changed_at_trg on public.sources;
--     drop function if exists public.sources_touch_registry_changed_at();
--     alter table public.sources drop column if exists registry_changed_at;
--     notify pgrst, 'reload schema';
--     delete from supabase_migrations.schema_migrations where version = '175';
--   The sources_zone_history_* triggers, the data and the ACL are untouched in either direction.
begin;

set local lock_timeout = '5s';

alter table public.sources
  add column if not exists registry_changed_at timestamptz not null default now();

comment on column public.sources.registry_changed_at is
  'Last time a registry column of this source changed: name, slug, url, rss_url, bias, kind, active, logo_url, tradition, '
  'source_type, image_allowed, excerpt_allowed, zone_rationale, trustee_since or trustee_note. Stamped by the BEFORE UPDATE '
  'trigger sources_registry_changed_at_trg; the fetch_* columns that ingest writes every few minutes never move it, so the '
  '/sources Dataset JSON-LD dateModified follows the registry and not the ingest. Added by migration 175 with default now(), '
  'a STABLE default that Postgres stores as a fast default with no table rewrite: every row that existed then reads the '
  'migration''s transaction time until its first registry edit, and a new row gets its own insert time.';

create or replace function public.sources_touch_registry_changed_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.registry_changed_at := pg_catalog.now();
  return new;
end;
$$;

-- EXECUTE is auto-granted to anon and authenticated at creation on Supabase, so a PUBLIC-only revoke would leave those
-- role-direct entries standing. Name all three, as 055 does for sources_record_zone_history().
revoke all on function public.sources_touch_registry_changed_at() from public, anon, authenticated;

drop trigger if exists sources_registry_changed_at_trg on public.sources;
create trigger sources_registry_changed_at_trg
  before update on public.sources
  for each row
  when (
    old.name is distinct from new.name
    or old.slug is distinct from new.slug
    or old.url is distinct from new.url
    or old.rss_url is distinct from new.rss_url
    or old.bias is distinct from new.bias
    or old.kind is distinct from new.kind
    or old.active is distinct from new.active
    or old.logo_url is distinct from new.logo_url
    or old.tradition is distinct from new.tradition
    or old.source_type is distinct from new.source_type
    or old.image_allowed is distinct from new.image_allowed
    or old.excerpt_allowed is distinct from new.excerpt_allowed
    or old.zone_rationale is distinct from new.zone_rationale
    or old.trustee_since is distinct from new.trustee_since
    or old.trustee_note is distinct from new.trustee_note
  )
  execute function public.sources_touch_registry_changed_at();

comment on trigger sources_registry_changed_at_trg on public.sources is
  'Stamps sources.registry_changed_at with now() when one of the 15 registry columns changes (is distinct from: null-safe, '
  'and a write of a column''s own value does not count). The WHEN clause names no fetch_* column, because ingest writes '
  'those every few minutes. See migration 175.';

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name) values ('175', '175_sources_registry_changed_at') on conflict do nothing;

commit;
