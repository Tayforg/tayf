# Kapsama karnesi (source-karne)

Neutral card on `/source/[slug]`, directly under the Etiket kartı. It shows how
an outlet's clustered stories behave over the last 30 days. Every number
carries its n and window. Migration `096_source_karne.sql`; reader
`src/lib/sources/karne.ts`; UI `src/components/source/source-karne.tsx`.

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
  (index `idx_articles_source_published`, 044). Bounds are stored in the row.
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
- The zone map in 096 is the 8th SQL copy of `BIAS_TO_ZONE`; the migration test
  pins it against `src/lib/bias/config.ts`.

## Refresh

`public.source_karne_refresh(p_days default 30)` (SECURITY DEFINER,
`search_path = ''`, service_role only) recomputes one row per active source, one
statement per source, and deletes rows of inactive/removed sources. An advisory
lock makes an overlapping run a no-op (returns 0). pg_cron job
`source-karne-refresh` runs daily at `41 0 * * *` (03:41 Istanbul, low traffic; a full pass scans ~1–9 s per source, so it is kept off peak). The table has RLS on, no
policies and no anon/authenticated grants; the reader uses the service role and
a cached (`"use cache"`, `cacheLife("hours")`, tag `sources`) PK lookup wrapped
in `attemptCached` / `resolveCachedOrRetry`, so it never throws.

## Deploy

1. Apply migration 096 (additive; creates table, function and cron job).
2. Backfill is NOT in the migration: Step 0 EXPLAIN on production measured up
   to 8.6 s for the heaviest single source (cumhuriyet), above the 3 s cut-off.
   Run once, as a separate step with a raised timeout:
   `set statement_timeout = '10min'; select public.source_karne_refresh(30);`
   (or wait for the first cron tick, within 6 hours). Until then the card
   renders nothing (no row gives `null`).
3. Ship the Vercel deploy after the table is populated.
4. Check: `select count(*) from source_karne_30d` equals the number of active
   sources, and spot-check one outlet against a manual SELECT.

Step 0 numbers (prod, 2026-09-29, `explain (analyze, buffers)`): haberler-com
4,044 ms; haber7 867 ms; cumhuriyet 8,575 ms (also recorded in the migration
header).
