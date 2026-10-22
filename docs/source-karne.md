# Kapsama karnesi (source-karne)

Neutral card on `/source/[slug]`, directly under the Etiket kartı. It shows how
an outlet's clustered stories behave over the last 30 days. Every number
carries its n and window. Migrations `096_source_karne.sql` (table, first
refresh) and `106_source_karne_resilient.sql` (batched refresh, covering
indexes); reader `src/lib/sources/karne.ts`; UI
`src/components/source/source-karne.tsx`.

## Metrics

1. Share of the outlet's stories that also have other sources, against the
   share Tayf could not match to another source.
2. Zones of the other sources on its multi-source stories (shown only when
   there are at least 10 multi-source stories).
3. How often the outlet sits in a public blindspot
   (`is_blindspot AND NOT blindspot_recall_veto`, the 071 veto).

Below 20 clustered stories the card shows an "insufficient" state instead.

Deliberately NOT shown: clickbait (precision gate closed), headline edits
(056 counsel gate), first-mover counts, any list of "skipped" stories. The copy
never says a source "did not write" or "ignored" anything.

## Definitions

- **Window:** `articles.published_at >= now() - 30 days`
  (served by `idx_articles_source_published_inc_id`, 106; 044's
  `idx_articles_source_published` lacks `id`). Bounds are stored in the row.
- **Story:** a distinct cluster holding at least one article from the source
  published in the window. Non-politics articles are never clustered, so they
  drop out (stated in the card footnote).
- `own_vote` = 1 if `sources.kind in ('outlet','wire')`, else 0.
  `own_zone` = `BIAS_TO_ZONE[sources.bias]`.
- Per cluster, zone counts come from `clusters.bias_distribution` (distinct
  voting sources). `others_z = greatest(z - (zone = own_zone ? own_vote : 0), 0)`.
- `n_multi` = clusters with `others_i + others_b + others_m >= 1`;
  `n_solo = n_clusters - n_multi`.
- `co_<zone>` = multi clusters with `others_zone >= 1`. A story can count in
  several zones, so the shares do not sum to 100%.
- `n_blindspot` = clusters with `is_blindspot AND NOT blindspot_recall_veto`;
  `n_blindspot_same_side` = the subset where `zone(blindspot_side) = own_zone`.

## Caveats

- Unmatched does not mean other outlets did not cover the event: other
  languages and matching errors are not covered by the clusterer.
- Aggregators (`kind = 'aggregator'`) do not vote, so their own vote is 0
  (nothing is subtracted from their clusters' zone counts).
- `bias_distribution` is a denormalised snapshot maintained by the cluster
  worker; a stale cluster shows up as stale here until the next refresh.
- The zone map in 096 is the 8th SQL copy of `BIAS_TO_ZONE`; 106 repeats it
  (own-zone lookup and `zmap` CTE inside `source_karne_refresh_source`). The
  migration tests pin both against `src/lib/bias/config.ts`.
- A card whose `computed_at` is older than 48 hours (`KARNE_STALE_AFTER_HOURS`)
  is marked stale, see "Stale banner".

## Refresh

Why batches: production runs on Supabase Micro compute (256 MB
`shared_buffers` against a multi-GB database), so reads are cold. 096 refreshed
all 118 active sources in ONE `source_karne_refresh()` call under one
`statement_timeout = '15min'`; that call last succeeded on 2026-10-12 (2 m 47 s)
and then hit the 15 min budget on 9 consecutive nights (2026-10-13 to
2026-10-21), always inside the `with zmap(...` statement. A per-source
exception block cannot fix a budget that covers the whole call, so 106 bounds
the work per cron run instead.

Functions (all SECURITY DEFINER, `search_path = ''`, execute for service_role
only):

- `source_karne_refresh_source(p_source_id, p_days default 30) returns boolean`:
  096's per-source statement, verbatim except `v_src.id` is `p_source_id`.
  Returns `false` for a missing or inactive source, `true` after the upsert.
  Takes no lock.
- `source_karne_refresh_batch(p_days default 30, p_limit default 10,
  p_budget_ms default 120000) returns integer`: the scheduled path. Takes the
  advisory xact lock on `hashtext('source_karne_refresh')` (an overlapping run
  returns 0), then walks active sources whose row is missing or older than
  20 hours, `order by computed_at asc nulls first, id`, until `p_limit`
  (clamped 1..200) sources are done or `clock_timestamp()` passes the budget
  (clamped 1000..600000 ms). Each source runs in its own
  `begin ... exception when others` block: a failure is `raise log`ged and
  skipped and does not count toward the limit. Afterwards it deletes rows of
  inactive/removed sources. Returns the number of sources refreshed.
- `source_karne_refresh(p_days default 30) returns integer`: same signature as
  096, now a MANUAL full pass through `source_karne_refresh_source` with the
  same per-source isolation. It is not scheduled and must not be run on a cold
  production database.

pg_cron job `source-karne-refresh` runs `*/15 * * * *` with
`set statement_timeout = '5min'; select public.source_karne_refresh_batch(30, 10, 120000);`
(the timeout is set in the cron command itself because a function-level `SET`
does not re-arm the caller's running timer). Each source is therefore
recomputed about once a day (every ~20 hours), up to 10 sources per run; a
full catch-up of an empty table takes 12 runs, about 3 hours. A statement
timeout (query cancel) is not caught by `exception when others`, so a single
source that exceeds the 5 minute cron timeout would still abort and roll back
that run; look for repeated failed `source-karne-refresh` rows in
`cron.job_run_details` and for `source_karne_refresh_batch: source ... failed`
lines in the Postgres log.

Covering indexes (106): `idx_articles_source_published_inc_id` on
`articles (source_id, published_at desc) include (id)` and
`idx_cluster_articles_article_cluster` on `cluster_articles (article_id,
cluster_id)`. Step 0 EXPLAINs on production showed the `mine` CTE paying one
`articles` heap fetch per in-window article (only to read `id`) plus a
`cluster_articles` heap fetch for `cluster_id`; for the largest source
(haberler-com) the planner even walked the global `idx_articles_published_at`
over all sources and filtered `source_id` row by row. With the covering indexes
both joins are index-only scans, as long as the visibility maps are fresh: the
`articles` map is kept fresh by 045's `*/30` vacuum; `cluster_articles` has no
dedicated job, so an occasional `vacuum (analyze) public.cluster_articles` keeps
its map fresh (the table is 19 MB). The remaining per-cluster cost is one
`clusters` heap fetch per distinct cluster (wide `bias_distribution`), which is
what the batch bound absorbs.

The table has RLS on, no policies and no anon/authenticated grants; the reader
uses the service role and a cached (`"use cache"`, `cacheLife("hours")`, tag
`sources`) PK lookup wrapped in `attemptCached` / `resolveCachedOrRetry`, so it
never throws.

## Stale banner

`getSourceKarne` returns the validated row plus `{ isStale, ageDays }`
(`SourceKarneRead`). `karneFreshness(computedAt, nowMs)` is pure: stale means
`computed_at` is more than 48 hours (`KARNE_STALE_AFTER_HOURS`) old, `ageDays`
is the whole number of days, a future or unparseable timestamp is never stale.
The only clock read is inside the `"use cache"` helper `getKarneFreshnessCached`
(`cacheLife("hours")`), so it also covers the live-retry path and never reads an
uncached `Date.now()` during prerender. A stale card replaces its subtitle with
`Son hesaplama N gün önce — veriler güncel değil` in amber; the numbers below
are unchanged. `toSourceKarne` and the v1 profile payload do not carry the
freshness fields.

## Deploy

1. (Operator, before the migration) pre-build both indexes outside a
   transaction so applying 106 does not block ingest writes on `articles`:

   ```sql
   create index concurrently if not exists idx_articles_source_published_inc_id
     on public.articles (source_id, published_at desc) include (id);
   create index concurrently if not exists idx_cluster_articles_article_cluster
     on public.cluster_articles (article_id, cluster_id);
   ```

   106 uses plain `create index if not exists`, which is then a no-op. If
   they are not pre-built, 106 builds them under a lock that blocks writes for
   the duration of the build.
2. Apply migration 106 (additive: two indexes, three functions, a comment fix,
   a re-pointed cron job). It does NOT backfill and does not call
   `source_karne_refresh()`.
3. Do not run the old monolithic backfill. The first cron ticks fill and refresh
   the table in batches of 10 (about 3 hours for a full catch-up). Until a
   source has a row, its card renders nothing; a row older than 48 hours renders
   the stale banner.
4. Ship the Vercel deploy with the `SourceKarneRead` change (stale banner); it is
   safe before or after the migration.
5. Check: `select count(*) from source_karne_30d` approaches the number of
   active sources within a few hours; `select max(computed_at) from
   source_karne_30d` stays within ~20 hours of now; recent
   `cron.job_run_details` rows for `source-karne-refresh` are `succeeded`;
   spot-check one outlet against a manual SELECT. After the indexes exist,
   `explain` the `mine` CTE for one source and confirm `Index Only Scan` on
   both new indexes.

Step 0 numbers: 096 (prod, 2026-09-29, `explain (analyze, buffers)`):
haberler-com 4,044 ms; haber7 867 ms; cumhuriyet 8,575 ms. 106 (prod,
2026-10-22, read-only, `explain` without `analyze`): see the 106 migration
header for the cron history, table and index sizes and the plans.
