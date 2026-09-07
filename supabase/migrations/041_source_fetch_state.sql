-- 041_source_fetch_state.sql
--
-- Persist RSS conditional-fetch state on `sources` so the `ingest` Edge
-- Function survives a cold start without re-fetching and re-parsing every
-- feed. `conditionalCache` (supabase/functions/ingest/index.ts) is a
-- module-scope Map that only survives while an Edge Function instance
-- stays warm between pg_cron's 3-minute pokes -- a cold start wipes it, so
-- most cycles were fetching all ~118 feeds and parsing ~5,300 items when
-- only ~5-30 articles per run were ever actually new. These five columns
-- let the function hydrate that Map from the database at cycle start
-- instead of starting cold every time, and add a body-hash fallback for
-- feeds that reissue byte-identical XML without changing ETag /
-- Last-Modified.
--
-- Additive, nullable, no backfill needed. `sources` is already publicly
-- readable (017_rls_policies.sql) and none of these five values are
-- secrets (they're either RSS response headers or a hash of public feed
-- content), so no RLS change.

begin;

alter table public.sources
  add column if not exists fetch_etag text,
  add column if not exists fetch_last_modified text,
  add column if not exists fetch_body_hash text,
  add column if not exists fetch_last_status int,
  add column if not exists fetch_last_at timestamptz;

comment on column public.sources.fetch_etag is
  'Last ETag response header seen for this source''s rss_url. Hydrates '
  'the ingest function''s in-memory conditionalCache at cycle start and '
  'is sent back as If-None-Match on the next fetch.';

comment on column public.sources.fetch_last_modified is
  'Last Last-Modified response header seen for this source''s rss_url. '
  'Sent back as If-Modified-Since on the next fetch. See fetch_etag.';

comment on column public.sources.fetch_body_hash is
  'SHA-256 hex digest of the last successfully fetched (2xx) feed body. '
  'A feed that reissues byte-identical XML without changing ETag / '
  'Last-Modified is caught by a matching hash here and treated exactly '
  'like an HTTP 304: normalize/upsert is skipped for that source.';

comment on column public.sources.fetch_last_status is
  'HTTP status from the most recent ingest fetch attempt for this source '
  '(200, 304, 404, ... or 0 for a network/timeout error). Diagnostic '
  'only -- not read by any query path.';

comment on column public.sources.fetch_last_at is
  'Timestamp of the most recent ingest fetch attempt for this source, '
  'success or failure. Diagnostic only -- surfaces sources that stopped '
  'being polled.';

-- ---------------------------------------------------------------------------
-- Batched writer for the five columns above. The ingest function cannot use
-- a PostgREST upsert here: that is INSERT ... ON CONFLICT (id) DO UPDATE,
-- and Postgres checks `sources`' NOT NULL columns (name, slug, url, rss_url,
-- bias) on the proposed row BEFORE the conflict arbiter, so an id + five
-- column payload fails with 23502 every time. A plain UPDATE ... FROM
-- jsonb_to_recordset touches exactly these five columns in one round trip.
-- Same shell as 034/037: SECURITY DEFINER, empty search_path, service_role
-- only.
-- ---------------------------------------------------------------------------

create or replace function public.ingest_set_source_fetch_state(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed integer;
begin
  update public.sources s
     set fetch_etag = r.fetch_etag,
         fetch_last_modified = r.fetch_last_modified,
         fetch_body_hash = r.fetch_body_hash,
         fetch_last_status = r.fetch_last_status,
         fetch_last_at = r.fetch_last_at
    from pg_catalog.jsonb_to_recordset(p_rows) as r(
           id uuid,
           fetch_etag text,
           fetch_last_modified text,
           fetch_body_hash text,
           fetch_last_status int,
           fetch_last_at timestamptz
         )
   where s.id = r.id;
  get diagnostics v_changed = row_count;
  return v_changed;
end;
$$;

comment on function public.ingest_set_source_fetch_state(jsonb) is
  'Batched writer for sources.fetch_* called by the ingest Edge Function: '
  'one UPDATE ... FROM jsonb_to_recordset per flush, touching only the five '
  'fetch-state columns. p_rows: [{id, fetch_etag, fetch_last_modified, '
  'fetch_body_hash, fetch_last_status, fetch_last_at}]. Returns rows updated.';

-- Supabase auto-grants EXECUTE to anon + authenticated on function
-- creation; name them explicitly in the revoke (034's pattern).
revoke execute on function public.ingest_set_source_fetch_state(jsonb)
  from anon, authenticated, public;
grant execute on function public.ingest_set_source_fetch_state(jsonb) to service_role;

commit;
