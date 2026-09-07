-- 039_quality_telemetry.sql
--
-- Two small telemetry tables plus one additive column, backing the daily
-- cluster-quality audit and per-cycle ingest health:
--
--   * public.cluster_quality_snapshots -- one row per
--     `node scripts/audit-clusters.mjs --json --persist` run (see
--     .github/workflows/cluster-audit.yml, scheduled 03:00 UTC daily). The
--     flat columns mirror computeReport()'s return value in
--     scripts/lib/audit/report.mjs 1:1 so they can be queried/plotted
--     without unpacking `report`, which holds the full JSON. GET
--     /api/metrics reads the latest row for `clusters.quality`.
--   * public.ingest_cycles -- one row per `ingest` Edge Function invocation
--     (supabase/functions/ingest/index.ts), written best-effort at the end
--     of every cycle (success or failure) from the existing in-memory
--     `stats` object. GET /api/metrics sums `row_errors` over the last hour
--     for `ingest.rowErrorsLastHour` (0 when the table is empty).
--   * `articles.canonical_url` -- nullable, additive. The RSS normaliser
--     (supabase/functions/_shared/rss/normalize.ts's `canonicalizeUrl`) has
--     always computed a canonical form internally (host lowercased/www
--     stripped, tracking params removed, source-specific section-prefix
--     rules applied); this column just persists it instead of discarding
--     it after use. `url` remains the unique de-dup key -- this is purely
--     additive telemetry/analysis surface, not a behaviour change.
--
-- Both new tables follow the 030/032/033 pattern: RLS enabled, no
-- policies, and an explicit revoke from anon/authenticated so PostgREST
-- can't expose them even by accident -- every reader/writer here is either
-- service_role (the audit script, the ingest function) or a Next.js route
-- using the service-role client server-side.

begin;

-- ---------------------------------------------------------------------------
-- 1) cluster_quality_snapshots -- one row per audit-clusters.mjs run.
-- ---------------------------------------------------------------------------

create table public.cluster_quality_snapshots (
  id bigint generated always as identity primary key,
  taken_at timestamptz not null default now(),
  window_hours int not null,
  article_count int,
  cluster_count int,
  singleton_rate numeric(6,4),
  size_histogram jsonb,
  source_diversity jsonb,
  precision_probe_count int,
  recall_probe_count int,
  blindspot_flip_rate numeric(6,4),
  report jsonb
);

comment on table public.cluster_quality_snapshots is
  'One row per `node scripts/audit-clusters.mjs --json --persist` run '
  '(.github/workflows/cluster-audit.yml, daily 03:00 UTC + manual '
  'dispatch). `report` holds the full computeReport() JSON from '
  'scripts/lib/audit/report.mjs; the flat columns are a queryable subset '
  'of the same shape. GET /api/metrics reads the latest row for '
  'clusters.quality.';

create index cluster_quality_snapshots_taken_at_idx
  on public.cluster_quality_snapshots (taken_at desc);

alter table public.cluster_quality_snapshots enable row level security;

revoke all on public.cluster_quality_snapshots from anon, authenticated;
grant all on public.cluster_quality_snapshots to service_role;

-- ---------------------------------------------------------------------------
-- 2) ingest_cycles -- one row per `ingest` Edge Function invocation.
-- ---------------------------------------------------------------------------

create table public.ingest_cycles (
  id bigint generated always as identity primary key,
  started_at timestamptz not null,
  finished_at timestamptz not null default now(),
  fetched int,
  inserted int,
  row_errors int,
  failed int,
  duration_ms int
);

comment on table public.ingest_cycles is
  'One row per ingest Edge Function cycle (supabase/functions/ingest/'
  'index.ts), written best-effort (errors logged and swallowed, never '
  'fail the cycle) at cycle end on both the success and the failure path, '
  'from the in-memory stats object. GET /api/metrics sums row_errors over '
  'rows finished in the last hour for ingest.rowErrorsLastHour (0 when '
  'the table is empty).';

-- Descending index on finished_at: both the /api/metrics "last hour" sum
-- and a manual "most recent cycles" query filter/order on this column.
create index ingest_cycles_finished_at_idx
  on public.ingest_cycles (finished_at desc);

alter table public.ingest_cycles enable row level security;

revoke all on public.ingest_cycles from anon, authenticated;
grant all on public.ingest_cycles to service_role;

-- ---------------------------------------------------------------------------
-- 3) articles.canonical_url -- nullable, additive.
-- ---------------------------------------------------------------------------

alter table public.articles
  add column if not exists canonical_url text null;

comment on column public.articles.canonical_url is
  'Canonical form of `url` from rss/normalize.ts''s canonicalizeUrl() '
  '(host lowercased, leading www. stripped, tracking params removed, '
  'source-specific section-prefix rules applied). Nullable/additive -- '
  'rows ingested before this migration keep it null; `url` remains the '
  'unique de-dup key and this column is not read by any existing query.';

commit;
