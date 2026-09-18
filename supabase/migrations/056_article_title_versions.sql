-- 056_article_title_versions.sql
--
-- U-07 headline archaeology, COLLECTION HALF ONLY. A re-polled RSS item
-- whose title changed gets a different content_hash (strictFingerprint(
-- title, description), supabase/functions/_shared/rss/normalize.ts), so it
-- survives both intra-cycle and cross-cycle content-hash dedupe, reaches the
-- batched upsert, and is silently dropped by
-- `.upsert(chunk, { onConflict: "url", ignoreDuplicates: true })`
-- (supabase/functions/ingest/index.ts) -- the old title is lost with no
-- trace. This table records that delta going forward. The upsert-drop
-- behaviour itself is unchanged; we only observe it.
--
-- This migration ships NOTHING for reading the data back: no select policy,
-- no page, no API route. That is deliberate, not an oversight. If an outlet
-- removed a story to comply with a court order or a KVKK right-to-be-
-- forgotten request, storing AND LATER DISPLAYING the removed headline
-- republishes exactly what was ordered removed and invites the same order
-- against Tayf's own URL (Law 5651 Art. 9 exposure -- see the research
-- note). Collect silently, publish nothing. The moment anyone proposes a
-- "değişen manşetler" page, that is a counsel question first, not an
-- engineering task.
--
-- RLS: enabled, zero policies, explicit revoke from anon/authenticated --
-- same discipline as ingest_cycles / cluster_quality_snapshots (migration
-- 039). Only service_role (the ingest Edge Function) ever touches this
-- table, and it only ever inserts.
--
-- Retention: NOT covered by migration 037's archival rules or 043's
-- purge_reader_data() -- this table carries no reader PII so 043 doesn't
-- apply, but it grows unbounded (order a few hundred thousand rows/month
-- per U-07's own volume estimate). Not urgent at today's volume, but the
-- retention window is a founder/legal decision (">=2 years pending
-- counsel" per the research note), not an engineering guess -- flag it
-- again before this table is a year old.
--
-- Dedupe: the ingest cycle runs every 3 minutes, so without a dedupe key a
-- headline that changes once and then stays changed would otherwise be
-- re-recorded every cycle it remains in the feed (ingest never writes the
-- new title to `articles`, so the "change" never clears). We dedupe on
-- (article_id, new_title_hash) -- an md5 of new_title, not a raw unique
-- index on new_title, since an unbounded title could exceed the ~2704-byte
-- btree limit. Accepted trade-off: an A -> B -> A -> B headline oscillation
-- records B only once, ever, not once per distinct occurrence.

begin;

create table public.article_title_versions (
  id bigint generated always as identity primary key,
  article_id uuid not null references public.articles(id) on delete cascade,
  source_id uuid not null references public.sources(id) on delete cascade,
  old_title text not null,
  new_title text not null,
  new_title_hash text generated always as (md5(new_title)) stored,
  seen_at timestamptz not null default now()
);

-- Backs the upsert's onConflict target in recordTitleVersions
-- (supabase/functions/ingest/index.ts): one row per (article, new title),
-- ever -- see the dedupe note above.
create unique index article_title_versions_dedupe_idx
  on public.article_title_versions (article_id, new_title_hash);

comment on table public.article_title_versions is
  'One row per detected headline change on a re-polled RSS item '
  '(supabase/functions/ingest/index.ts, recordTitleVersions). Collection '
  'only -- RLS enabled with NO select policy, nothing here is published '
  'anywhere in the app. See migration 056 header for the Law 5651 Art. 9 '
  'rationale before ever proposing a public read path.';

comment on column public.article_title_versions.old_title is
  'The title stored on `articles` before this cycle''s (silently dropped) '
  'upsert would have overwritten it.';

comment on column public.article_title_versions.new_title is
  'The title the re-polled feed item carried this cycle -- never written '
  'to `articles` (the upsert''s `ignoreDuplicates: true` on `url` keeps '
  'the original row as-is).';

-- Descending index on seen_at: mirrors ingest_cycles_finished_at_idx /
-- cluster_quality_snapshots_taken_at_idx (migration 039) -- the natural
-- "most recent changes" query shape for a service_role operator.
create index article_title_versions_seen_at_idx
  on public.article_title_versions (seen_at desc);

create index article_title_versions_article_id_idx
  on public.article_title_versions (article_id);

create index article_title_versions_source_id_idx
  on public.article_title_versions (source_id);

alter table public.article_title_versions enable row level security;

-- Deliberately no policy: RLS enabled + zero policies means PostgREST
-- (anon/authenticated) sees nothing at all, by default-deny, even before
-- the explicit revoke below. The revoke is defense in depth against a
-- future `grant` landing without a matching policy.
revoke all on public.article_title_versions from anon, authenticated;
grant all on public.article_title_versions to service_role;

commit;
