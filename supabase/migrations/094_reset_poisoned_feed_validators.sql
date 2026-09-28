-- 094_reset_poisoned_feed_validators.sql
--
-- silent-feeds: reset the stored fetch validators (fetch_etag,
-- fetch_last_modified, fetch_body_hash) of six sources whose feeds were
-- answered with 304 / a body-hash hit while their current items were never
-- stored. Data-only, no schema change beyond one backup table.
--
-- APPLY AFTER the fixed `ingest` Edge Function is deployed
-- (supabase functions deploy ingest --no-verify-jwt). If applied before, the
-- old code can poison the validators again on the very next starved cycle.
-- Then redeploy ingest once more (or wait for the warm instances to recycle):
-- a warm instance keeps sending the old ETag from its in-memory cache even
-- after the database columns were nulled.
--
-- Evidence (prod read-only, 2026-09-29 ~00:15 UTC, docs/feed-registry-2026-09.md
-- section 3, "Root cause (2026-09-29)"):
--   * Stored fetch_etag / fetch_last_modified equalled the live feed's
--     validators, and the stored body hash equalled the sha256 of the live
--     body, for all six sources: yes.
--   * The server answered 304 to the stored validators (all four sources that
--     send validators): yes.
--   * Current feed items missing from public.articles: iklim-haber 10/10,
--     newslab-turkey 12/12, turkiye-haber-ajansi 20/20, platform-24 4/18,
--     investing-com-tr 2/10, journo 2/10. Nothing stored under another
--     source_id (not a registry problem).
--   * Ingest regime: 34 of 114 cycles in the last 6 h ended at the 49.5 s
--     deadline, each with row errors or skipped rows.
--
-- Root cause: ingest saved a fetched feed's fresh validators BEFORE its rows
-- were upserted. When the cycle deadline, a row error or a skipped batch then
-- lost some of the feed's rows, the validators still said "seen": the next
-- cycle got a 304 (or the body-hash short-circuit) and the rows were never
-- offered again until the outlet changed the feed. Slow niche/wire feeds get
-- one shot per change, so they lost the most. Fixed in the same PR
-- (supabase/functions/ingest/index.ts): validators are committed only after
-- all of a source's rows were upserted, deduped or skipped as already stored.
--
-- Properties:
--   * additive + data-only: one new backup table, one UPDATE.
--   * backup-in-same-statement: the UPDATE joins the RETURNING rows of the
--     backup INSERT, so a row cannot change unless its backup was written.
--   * only fetch_etag, fetch_last_modified and fetch_body_hash are set to
--     null. rss_url, active, bias, kind, streak and quarantine are untouched
--     (the http:// rss_urls of platform-24 and turkiye-haber-ajansi work via
--     redirect and stay as they are).
--   * idempotent: a re-run conflicts on the backup insert and resets nothing.
--
-- Verify (expect each source: new_articles >= 1 and validators_back true
-- within about 15-30 min):
--   select s.slug, s.fetch_last_status,
--          s.fetch_etag is not null or s.fetch_body_hash is not null as validators_back,
--          count(a.id) filter (where a.created_at > b.backed_up_at) new_articles
--     from public.sources s
--     join public.sources_fetch_state_backup_094 b on b.id = s.id
--     left join public.articles a on a.source_id = s.id
--    group by 1, 2, 3;
--
-- Manual rollback:
--   update public.sources s
--      set fetch_etag = b.old_fetch_etag,
--          fetch_last_modified = b.old_fetch_last_modified,
--          fetch_body_hash = b.old_fetch_body_hash
--     from public.sources_fetch_state_backup_094 b
--    where b.id = s.id;
begin;

create table if not exists public.sources_fetch_state_backup_094 (
  id                      uuid primary key,   -- = sources.id, no FK (audit row outlives a delete)
  slug                    text not null,
  old_fetch_etag          text,
  old_fetch_last_modified text,
  old_fetch_body_hash     text,
  backed_up_at            timestamptz not null default now()
);
alter table public.sources_fetch_state_backup_094 enable row level security;
revoke all on public.sources_fetch_state_backup_094 from anon, authenticated, public;
grant select, insert on public.sources_fetch_state_backup_094 to service_role;
comment on table public.sources_fetch_state_backup_094 is
  'One-off backup of sources fetch validators before the 094 reset (docs/feed-registry-2026-09.md §3). RLS on, no policies; service_role only.';

do $$
declare
  v_reset integer;
  r record;
begin
  with v(slug) as (
    values ('iklim-haber'), ('investing-com-tr'), ('newslab-turkey'), ('platform-24'), ('turkiye-haber-ajansi'), ('journo')
  ),
  backup as (
    insert into public.sources_fetch_state_backup_094 (id, slug, old_fetch_etag, old_fetch_last_modified, old_fetch_body_hash)
    select s.id, s.slug, s.fetch_etag, s.fetch_last_modified, s.fetch_body_hash
      from public.sources s
      join v on v.slug = s.slug
     where (s.fetch_etag is not null or s.fetch_last_modified is not null or s.fetch_body_hash is not null)
    on conflict (id) do nothing
    returning id
  )
  update public.sources s
     set fetch_etag          = null,
         fetch_last_modified = null,
         fetch_body_hash     = null
    from backup b
   where s.id = b.id;
  get diagnostics v_reset = row_count;

  for r in select b.slug from public.sources_fetch_state_backup_094 b order by b.slug loop
    raise notice '094 validator reset: %', r.slug;
  end loop;
  raise notice '094 validator reset: % source(s) reset this run', v_reset;
end $$;

insert into supabase_migrations.schema_migrations (version, name)
  values ('094', '094_reset_poisoned_feed_validators')
  on conflict do nothing;

commit;
