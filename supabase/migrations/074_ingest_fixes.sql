-- 074_ingest_fixes.sql
--
-- ingest-fixes: CNN Türk timestamps, headline write-back, feed quarantine
-- + chunked pre-filter (see supabase/functions/ingest/index.ts,
-- supabase/functions/_shared/rss/normalize.ts,
-- supabase/functions/_shared/rss/quarantine.ts for the TypeScript half).
--
-- Evidence (read-only, production, 2026-09-28):
--   - All 1,985 future-dated articles in the last 7 days come from
--     cnn-turk. Mean skew +2.84h, max +2h53m (072's own header) --
--     consistent with an Istanbul wall-clock time labelled UTC, read in the
--     UTC Deno runtime, minus a ~10 min ingest delay. Turkey has been fixed
--     at UTC+3, no DST, since 2016.
--   - Of 852 articles edited in the last 7 days, all 852 still show the
--     pre-edit title (319 are cluster members) -- ingest never writes
--     new_title back (056:36-40).
--   - Word-Jaccard bands over 1,261 edits: <0.2 246 (~20%, URL reuse),
--     0.2-0.5 380, 0.5-0.8 362, >=0.8 273.
--   - 902/902 ingest cycles hit the 50s deadline; 3,984-5,050 row_errors/day
--     are repeat 23505s. 23 dead feeds (14x403, 6x404, 2x status 0, 1x530),
--     dead since 8 Sep, cost ~11,000 failed fetches/day.
--
-- Decision for (b) -- write-back at ingest, not a read-time overlay: write
-- the outlet's CURRENT headline into articles.title (and into
-- clusters.title_tr where the cluster inherited exactly the old headline),
-- guarded by word-Jaccard(old, new) >= 0.2 (below that is URL reuse -- a
-- different story recycled onto the same url -- and writing it back would
-- put an unrelated headline into a cluster about a different event). History
-- stays in article_title_versions (unchanged, RLS with no select policy).
-- The 056 counsel gate is about storing AND LATER DISPLAYING a removed
-- headline -- publishing edit history. Showing what the outlet shows NOW
-- publishes no history; the status quo (still showing a headline the
-- outlet removed, possibly under a 5651 order) is the riskier state. An
-- overlay would need a ledger join in every read path (cluster detail, home
-- bundles, search, RSS, API v1, OG/kart, framing game, archive export) plus
-- a new service-role read path over the ledger -- closer to the counsel
-- line, not further from it. Write-back fixes every surface at once,
-- including clusters.search_tsv (a generated column). content_hash is NOT
-- rehashed: no (source_id, content_hash) 23505 risk, wire detection
-- unchanged. This deviates from the roadmap's original "overlay" sketch for
-- the reasons above.

begin;

-- ---------------------------------------------------------------------------
-- (1) Feed quarantine columns on `sources`.
-- ---------------------------------------------------------------------------

alter table public.sources
  add column if not exists fetch_fail_streak integer not null default 0,
  add column if not exists fetch_quarantined_until timestamptz;

comment on column public.sources.fetch_fail_streak is
  'Consecutive ingest fetch failures for this source (migration 074). '
  'Reset to 0 on the first success (2xx parse or 304/body-hash match). '
  'sources is public-read per 017 -- neither value here is a secret.';

comment on column public.sources.fetch_quarantined_until is
  'Set once fetch_fail_streak crosses 20: an escalating backoff (1h, then '
  '6h, then 24h) during which the ingest function skips fetching this '
  'source entirely. NULL means not quarantined. See '
  'supabase/functions/_shared/rss/quarantine.ts for the state machine.';

-- ---------------------------------------------------------------------------
-- (2) ingest_cycles telemetry column.
-- ---------------------------------------------------------------------------

alter table public.ingest_cycles
  add column if not exists prefilter_errors integer not null default 0;

comment on column public.ingest_cycles.prefilter_errors is
  'Count of failed (source_id, content_hash) pre-filter chunk lookups this '
  'cycle (migration 074) -- a failing chunk degrades only itself (its rows '
  'are kept, not dropped) rather than failing the whole cycle.';

-- ---------------------------------------------------------------------------
-- (3) ingest_set_source_fetch_state: same name/arg/return, now also carries
-- the two quarantine columns. least(NULL, x) = x, so a bare
-- `least(r.fetch_quarantined_until, ...)` would silently un-quarantine every
-- row whose payload omits the key (a pre-074 build) -- the CASE below only
-- clamps when the caller actually sent a value.
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
         fetch_last_at = r.fetch_last_at,
         fetch_fail_streak = greatest(coalesce(r.fetch_fail_streak, s.fetch_fail_streak), 0),
         fetch_quarantined_until = case
           when r.fetch_quarantined_until is null then null
           else least(r.fetch_quarantined_until, pg_catalog.now() + interval '25 hours')
         end
    from pg_catalog.jsonb_to_recordset(p_rows) as r(
           id uuid,
           fetch_etag text,
           fetch_last_modified text,
           fetch_body_hash text,
           fetch_last_status int,
           fetch_last_at timestamptz,
           fetch_fail_streak int,
           fetch_quarantined_until timestamptz
         )
   where s.id = r.id;
  get diagnostics v_changed = row_count;
  return v_changed;
end;
$$;

comment on function public.ingest_set_source_fetch_state(jsonb) is
  'Batched writer for sources.fetch_* called by the ingest Edge Function '
  '(migration 041, extended in 074 with the two feed-quarantine columns): '
  'one UPDATE ... FROM jsonb_to_recordset per flush. p_rows: [{id, '
  'fetch_etag, fetch_last_modified, fetch_body_hash, fetch_last_status, '
  'fetch_last_at, fetch_fail_streak, fetch_quarantined_until}]. A row that '
  'omits fetch_fail_streak/fetch_quarantined_until (a pre-074 caller) '
  'keeps the stored value via coalesce -- and the CASE around '
  'fetch_quarantined_until specifically avoids `least(null, x) = x`, which '
  'would otherwise un-quarantine every healthy feed on a partial payload. '
  'Returns rows updated.';

revoke execute on function public.ingest_set_source_fetch_state(jsonb)
  from anon, authenticated, public;
grant execute on function public.ingest_set_source_fetch_state(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- (4) title_word_jaccard: the ONLY place the headline-edit eligibility gate
-- lives (TS sends every same-source title change; this function decides
-- whether it's a real edit or URL-reuse-onto-a-different-story).
-- ---------------------------------------------------------------------------

create or replace function public.title_word_jaccard(p_a text, p_b text)
returns numeric
language sql
immutable
parallel safe
set search_path = ''
as $$
  with tokens_a as (
    select distinct t as tok
    from pg_catalog.regexp_split_to_table(
      pg_catalog.lower(pg_catalog.translate(
        coalesce(p_a, ''), 'İIıÇŞĞÜÖÂÎÛ', 'iiiçşğüöâîû'
      )),
      '[[:space:][:punct:]“”‘’«»…–—]+'
    ) as t
    where t <> ''
  ),
  tokens_b as (
    select distinct t as tok
    from pg_catalog.regexp_split_to_table(
      pg_catalog.lower(pg_catalog.translate(
        coalesce(p_b, ''), 'İIıÇŞĞÜÖÂÎÛ', 'iiiçşğüöâîû'
      )),
      '[[:space:][:punct:]“”‘’«»…–—]+'
    ) as t
    where t <> ''
  ),
  inter as (select count(*) as n from tokens_a a join tokens_b b on a.tok = b.tok),
  uni as (
    select count(*) as n from (
      select tok from tokens_a
      union
      select tok from tokens_b
    ) u
  )
  select case when (select n from uni) = 0 then 0
         else round((select n from inter)::numeric / (select n from uni)::numeric, 3)
  end;
$$;

comment on function public.title_word_jaccard(text, text) is
  'Word-Jaccard similarity (0..1, rounded to 3dp) between two Turkish '
  'headlines, case/diacritic-normalised (translate() is needed because '
  'lower() is a no-op on non-ASCII under a C ctype) and tokenised on '
  'whitespace/punctuation. The ONLY eligibility gate for the '
  'apply_article_title_edits headline write-back below -- migration 074 '
  'evidence: ~20% of edits are <0.2 (URL reuse: a different story on a '
  'recycled url), which must never overwrite a cluster''s current headline.';

revoke execute on function public.title_word_jaccard(text, text)
  from anon, authenticated, public;
grant execute on function public.title_word_jaccard(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- (5) apply_article_title_edits: the write-back RPC the ingest function
-- calls from recordTitleVersions, independent of whether the article upsert
-- itself inserted anything (covers the A -> B -> A oscillation case, where
-- the ledger dedupes on (article_id, new_title_hash) but the outlet's
-- CURRENT headline still needs writing back every time it changes).
-- ---------------------------------------------------------------------------

create or replace function public.apply_article_title_edits(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with input as (
    select r.article_id, r.old_title, r.new_title
    from pg_catalog.jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb))
      as r(article_id uuid, old_title text, new_title text)
    where r.article_id is not null
      and r.old_title is not null
      and btrim(coalesce(r.new_title, '')) <> ''
      and length(r.new_title) <= 1000
      and r.new_title <> r.old_title
    limit 500
  ),
  eligible as (
    select i.article_id, i.old_title, i.new_title
    from input i
    where public.title_word_jaccard(i.old_title, i.new_title) >= 0.2
  ),
  upd_articles as (
    update public.articles a
       set title = e.new_title
      from eligible e
     where a.id = e.article_id
       and a.title = e.old_title
    returning a.id, e.old_title, e.new_title
  ),
  upd_clusters as (
    update public.clusters c
       set title_tr = u.new_title
      from upd_articles u
      join public.cluster_articles ca on ca.article_id = u.id
     where c.id = ca.cluster_id
       and c.title_tr = u.old_title
    returning c.id
  )
  select count(*) into v_count from upd_articles;
  return v_count;
end;
$$;

comment on function public.apply_article_title_edits(jsonb) is
  'Writes the outlet''s CURRENT headline back into articles.title (and, '
  'where a cluster inherited exactly the old headline, clusters.title_tr) '
  '-- migration 074 decision (b): showing what the outlet shows NOW '
  'publishes no edit history, unlike the removed 056 overlay sketch, which '
  'would have stored AND LATER DISPLAYED a removed headline (the actual '
  '056:13-21 counsel gate). Guarded by title_word_jaccard >= 0.2 so '
  'URL-reuse (a different story on a recycled url, ~20%% of edits) never '
  'overwrites an unrelated cluster''s headline. The optimistic '
  '`a.title = e.old_title` guard makes stale/concurrent edits no-ops. '
  'Caps p_rows at 500 rows/call. NEVER sets updated_at, content_hash or '
  'title_tr_neutral. Returns the count of articles actually updated.';

revoke execute on function public.apply_article_title_edits(jsonb)
  from anon, authenticated, public;
grant execute on function public.apply_article_title_edits(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- (6) One-off backfill: apply the same eligibility over every article's
-- latest recorded title-version edit, once, via a direct statement (not the
-- 500-row-capped RPC above).
-- ---------------------------------------------------------------------------

do $$
declare
  v_articles integer;
  v_clusters integer;
begin
  with latest as (
    select distinct on (v.article_id)
      v.article_id, v.old_title, v.new_title
    from public.article_title_versions v
    order by v.article_id, v.seen_at desc, v.id desc
  ),
  input as (
    select l.article_id, l.old_title, l.new_title
    from latest l
    where l.article_id is not null
      and l.old_title is not null
      and btrim(coalesce(l.new_title, '')) <> ''
      and length(l.new_title) <= 1000
      and l.new_title <> l.old_title
  ),
  eligible as (
    select i.article_id, i.old_title, i.new_title
    from input i
    where public.title_word_jaccard(i.old_title, i.new_title) >= 0.2
  ),
  upd_articles as (
    update public.articles a
       set title = e.new_title
      from eligible e
     where a.id = e.article_id
       and a.title = e.old_title
    returning a.id, e.old_title, e.new_title
  ),
  upd_clusters as (
    update public.clusters c
       set title_tr = u.new_title
      from upd_articles u
      join public.cluster_articles ca on ca.article_id = u.id
     where c.id = ca.cluster_id
       and c.title_tr = u.old_title
    returning c.id
  )
  select
    (select count(*) from upd_articles),
    (select count(distinct id) from upd_clusters)
  into v_articles, v_clusters;

  raise notice '074 headline write-back backfill: % article(s), % cluster title(s)',
    coalesce(v_articles, 0), coalesce(v_clusters, 0);
end $$;

-- ---------------------------------------------------------------------------
-- (7) Future-dated published_at fix: cnn-turk's Istanbul-wall-clock-as-UTC
-- mislabel (forward rule 3 mirrored backwards) plus a generic
-- "clamp to created_at" fallback for any other future-dated row.
-- ---------------------------------------------------------------------------

create table if not exists public.articles_published_at_backup_074 (
  article_id uuid primary key,
  old_published_at timestamptz not null,
  fixed_at timestamptz not null default now()
);

alter table public.articles_published_at_backup_074 enable row level security;

revoke all on public.articles_published_at_backup_074 from anon, authenticated, public;
grant select, insert on public.articles_published_at_backup_074 to service_role;

comment on table public.articles_published_at_backup_074 is
  'One-off backup of articles.published_at before the migration 074 '
  'future-dated timestamp fix, for one-time auditability -- not an '
  'ongoing ledger. RLS enabled, no policies; service_role only.';

do $$
declare
  r record;
  v_tickers integer;
  v_clusters integer;
begin
  insert into public.articles_published_at_backup_074 (article_id, old_published_at)
  select a.id, a.published_at
  from public.articles a
  where a.published_at > a.created_at + interval '5 minutes'
  on conflict do nothing;

  update public.articles a
     set published_at = case
           when s.slug = 'cnn-turk' then least(a.published_at - interval '3 hours', a.created_at)
           else a.created_at
         end
    from public.sources s, public.articles_published_at_backup_074 b
   where b.article_id = a.id
     and s.id = a.source_id
     and a.published_at > a.created_at + interval '5 minutes';

  update public.article_tickers t
     set published_at = a.published_at
    from public.articles_published_at_backup_074 b
    join public.articles a on a.id = b.article_id
   where t.article_id = b.article_id
     and t.published_at is distinct from a.published_at;
  get diagnostics v_tickers = row_count;

  with mins as (
    select ca.cluster_id, min(a.published_at) as min_published_at
    from public.articles_published_at_backup_074 b
    join public.articles a on a.id = b.article_id
    join public.cluster_articles ca on ca.article_id = a.id
    group by ca.cluster_id
  )
  update public.clusters c
     set first_published = m.min_published_at
    from mins m
   where c.id = m.cluster_id
     and c.first_published > m.min_published_at;
  get diagnostics v_clusters = row_count;

  for r in
    select s.slug, count(*) as n
    from public.articles_published_at_backup_074 b
    join public.articles a on a.id = b.article_id
    join public.sources s on s.id = a.source_id
    group by s.slug
    order by s.slug
  loop
    raise notice '074 published_at fix: % -> % row(s)', r.slug, r.n;
  end loop;

  raise notice '074 published_at fix: % article_tickers row(s) synced', v_tickers;
  raise notice '074 published_at fix: % cluster first_published row(s) lowered', v_clusters;
end $$;

-- ---------------------------------------------------------------------------
-- (8) Ledger.
-- ---------------------------------------------------------------------------

insert into supabase_migrations.schema_migrations (version, name)
  values ('074', '074_ingest_fixes')
  on conflict do nothing;

commit;
