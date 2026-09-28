-- 093_feed_registry_repoint.sql
--
-- Repoint the RSS feed URL of sources whose old feed is dead or moved and
-- whose replacement was verified. Evidence and the full worklist (including
-- every outlet where NO working feed exists) are in
-- docs/feed-registry-2026-09.md.
--
-- Evidence summary (prod read-only, 2026-09-28 ~23:10 UTC): 118 active
-- sources, 28 quarantined, 28 with fetch_fail_streak >= 5, 39 with no
-- article in 72 h. Of those 39 worklist rows, 9 have a verified replacement
-- (HTTP 200 with both the browser and the ingest UA, parses through the
-- repo's own fetchFeed + normalizeArticles, newest item within 48 h, https,
-- unique across sources.rss_url). Verified from a residential network: a
-- datacenter IP can still be blocked, so check the post-apply query in the doc.
--
-- Properties:
--   * additive + data-only: one new backup table, one UPDATE; no app or edge
--     dependency, safe to apply at any time.
--   * backup-in-same-statement: the UPDATE joins the RETURNING rows of the
--     backup INSERT, so a row cannot change unless its backup row was written
--     in that same statement.
--   * never deactivates, deletes or relabels: active, bias, kind, url, name
--     and slug are untouched. Only rss_url and the fetch-state columns change
--     (streak / quarantine / etag / last_modified / body_hash are reset so the
--     new URL is never sent the old feed's validators).
--   * idempotent: the match requires rss_url = old_rss_url, so a re-run, or a
--     row an admin already edited, is a no-op.
--
-- Manual rollback:
--   update public.sources s set rss_url = b.old_rss_url
--     from public.sources_rss_backup_093 b
--    where b.id = s.id and s.rss_url = b.new_rss_url;
begin;

create table if not exists public.sources_rss_backup_093 (
  id           uuid primary key,          -- = sources.id (no FK: the audit row must outlive a later delete)
  old_rss_url  text not null,
  new_rss_url  text not null,
  backed_up_at timestamptz not null default now()
);
alter table public.sources_rss_backup_093 enable row level security;
revoke all on public.sources_rss_backup_093 from anon, authenticated, public;
grant select, insert on public.sources_rss_backup_093 to service_role;
comment on table public.sources_rss_backup_093 is
  'One-off backup of sources.rss_url before the migration 093 feed repoint (docs/feed-registry-2026-09.md). RLS on, no policies; service_role only.';

do $$
declare
  v_repointed integer;
  r record;
begin
  with v(slug, old_rss_url, new_rss_url) as (
    values
      ('ajans-haber', 'https://www.ajanshaber.com/rss', 'https://ajanshaber.com.tr/rss.xml'),
      ('hurriyet-daily-news', 'https://www.hurriyetdailynews.com/rss', 'https://www.hurriyetdailynews.com/rss/news'),
      ('mfa-turkey', 'https://www.mfa.gov.tr/rss.en.mfa', 'https://www.mfa.gov.tr/en.rss.mfa?ad9093da-8e71-4678-a1b6-05f297baadc4'),
      ('milat', 'http://www.milatgazetesi.com/rss.php', 'https://www.milatgazetesi.com/rss'),
      ('muhalif', 'https://www.muhalif.com.tr/rss/genel-0', 'https://www.muhalif.com.tr/rss/news'),
      ('posta', 'http://www.posta.com.tr/xml/rss/rss_3_0.xml', 'https://www.posta.com.tr/rss/anasayfa.xml'),
      ('trt-world', 'https://www.trtworld.com/news/rss', 'https://www.trtworld.com/feed/rss.xml'),
      ('turkiye-gazetesi', 'https://www.turkiyegazetesi.com.tr/rss/rss.xml', 'https://www.turkiyegazetesi.com.tr/rss'),
      ('yeni-mesaj', 'http://www.yenimesaj.com.tr/rss.php', 'https://www.yenimesaj.com.tr/rss.xml')
  ),
  backup as (
    insert into public.sources_rss_backup_093 (id, old_rss_url, new_rss_url)
    select s.id, s.rss_url, v.new_rss_url
      from public.sources s
      join v on v.slug = s.slug and s.rss_url = v.old_rss_url
    on conflict (id) do nothing
    returning id, old_rss_url, new_rss_url
  )
  update public.sources s
     set rss_url                 = b.new_rss_url,
         fetch_fail_streak       = 0,
         fetch_quarantined_until = null,
         fetch_etag              = null,
         fetch_last_modified     = null,
         fetch_body_hash         = null
    from backup b
   where s.id = b.id
     and s.rss_url = b.old_rss_url;
  get diagnostics v_repointed = row_count;

  for r in select s.slug, b.new_rss_url from public.sources_rss_backup_093 b join public.sources s on s.id = b.id order by s.slug loop
    raise notice '093 feed repoint: % -> %', r.slug, r.new_rss_url;
  end loop;
  raise notice '093 feed repoint: % source(s) repointed this run', v_repointed;
end $$;

insert into supabase_migrations.schema_migrations (version, name)
  values ('093', '093_feed_registry_repoint')
  on conflict do nothing;

commit;
