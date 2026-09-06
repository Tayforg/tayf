# API Reference

## HTTP Endpoints

### `GET /api/health`

Health check. Returns subsystem status for database, environment, ingestion freshness, clustering freshness, and queue depth.

Two-tier response. Anonymous callers (no `Authorization` header) get only `{ "status", "timestamp" }` and are rate-limited (5-token bucket, 1 token/sec refill; the limiter is process-local, so the cap applies per serverless instance, not globally). Callers presenting `Authorization: Bearer <CRON_SECRET>` get the full per-check breakdown and bypass the rate limit; the bearer gate is the shared `requireCronBearer` helper (`src/lib/api/bearer.ts`) — case-insensitive scheme, constant-time compare, FAIL-CLOSED 503 when `CRON_SECRET` is unset/empty, 401 on a mismatched token.

**Response** `200 | 503` (bearer-authenticated):
```json
{
  "status": "healthy" | "degraded" | "unhealthy",
  "timestamp": "2026-04-16T12:00:00.000Z",
  "checks": {
    "database": { "ok": true, "latencyMs": 42 },
    "env": { "ok": true, "missing": [] },
    "ingestion": { "ok": true, "lastArticleAgeSec": 120 },
    "clustering": { "ok": true, "lastClusterAgeSec": 300 },
    "queues": { "ok": true, "metrics": [{ "queue": "cluster_work", "queueLength": 0, "oldestMsgAgeSec": null }, { "queue": "image_backfill", "queueLength": 0, "oldestMsgAgeSec": null }] }
  }
}
```

- `unhealthy` (503): database or env failure
- `degraded` (200): ingestion stale (>10 min since last article), clustering stale (>15 min), queue alarm (per-queue depth bound — `cluster_work` >500, `image_backfill` >100 — or oldest message >30 min), or a malformed `worker_metrics` row (NULL / non-numeric `queue_length`)
- `401`: `Authorization` header present but token mismatch
- `503` + error envelope: `Authorization` header present but `CRON_SECRET` not configured (FAIL-CLOSED)
- `429`: anonymous rate limit exhausted
- Each subsystem check has a 2s timeout

---

### `GET /api/metrics`

Live counts for articles, clusters, and sources.

**Headers**: `Authorization: Bearer <CRON_SECRET>` (required — same shared `requireCronBearer` gate as `/api/cron/headline`: 503 FAIL-CLOSED when `CRON_SECRET` is unset/empty, 401 on a mismatched token). Auth-gated operational data is served with `Cache-Control: no-store`.

**Response** `200`:
```json
{
  "timestamp": "...",
  "articles": { "total": 22000, "last24h": 850, "lastHour": 42, "politicsNullImage": 250, "politicsTotal": 12500, "withImage": 20500, "politicsImageMissingRatio": 0.02 },
  "clusters": { "total": 1200, "multiArticle": 980, "blindspots": 12, "avgArticlesPerCluster": 18.33, "avgArticlesPerMultiCluster": 22.22, "neutralizedEligible": 700, "neutralized": 665, "neutralizedRatio": 0.95, "oldestPendingNeutralAgeSec": 480 },
  "sources": { "total": 144, "active": 140 }
}
```

- `politicsImageMissingRatio`: `politicsNullImage / politicsTotal` (politics tier = `politika` + `son_dakika`), 2 decimals; 0 when `politicsTotal` is 0
- `avgArticlesPerCluster` averages over ALL clusters (singletons included); `avgArticlesPerMultiCluster` averages only over multi-article clusters — `(total articles - singleton clusters) / multiArticle`, 2 decimals, 0 when `multiArticle` is 0
- `neutralizedRatio`: `neutralized / neutralizedEligible`, 2 decimals; `oldestPendingNeutralAgeSec` is null when no eligible cluster is awaiting a neutral headline

---

### `GET /api/admin`

Admin statistics. Not rate-limited (read-only).

**Response** `200`:
```json
{
  "articles": 22000,
  "sources": 144,
  "clusters": 1200,
  "missingImages": 150,
  "sourcesList": [{ "id": "...", "name": "Sabah", "slug": "sabah", "url": "...", "rss_url": "...", "bias": "pro_government", "active": true }]
}
```

---

### `POST /api/admin`

Admin actions. Rate limited: 20-token bucket, 0.2 tokens/sec refill.

**Actions** (via `body.action`):

| Action | Body fields | Description |
|---|---|---|
| `ingest` | — | Trigger RSS ingest (skips if worker active) |
| `backfill_images` | — | Fetch og:image for imageless articles |
| `nuke_articles` | — | Delete all articles + clusters |
| `nuke_clusters` | — | Delete all clusters (articles preserved) |
| `toggle_source` | `slug`, `active` | Enable/disable a source |
| `add_source` | `name`, `slug`, `url`, `rss_url`, `bias` | Add new source |
| `update_source` | `id`, + optional fields | Update source fields |
| `delete_source` | `id` | Delete source and its articles |

---

### `GET /api/cron/headline`

LLM-generates neutral Turkish headlines (`title_tr_neutral`) for clusters that still lack one. This is the **only** Vercel cron in the worker-stream architecture: ingestion, cluster fan-out, and og:image backfill all run on `pg_cron` schedules (`ingest-drain`, `cluster-drain`, `image-drain`) that `net.http_post` directly into the Supabase Edge Functions. The legacy `/api/cron/ingest` and `/api/cron/backfill-images` routes have been removed.

**Headers**: `Authorization: Bearer <CRON_SECRET>` (required — the route is FAIL-CLOSED on a missing or empty `CRON_SECRET` in the runtime environment and returns 503 on every invocation in that case).

The bearer gate is the shared `requireCronBearer` helper (`src/lib/api/bearer.ts`): the scheme is matched case-insensitively and the token is compared with `crypto.timingSafeEqual`. Vercel cron supplies this header automatically when scheduled via `vercel.json` / `vercel.ts`.

**Rate limit**: 5-token bucket, 1 token / 60 seconds refill. The cron itself ticks every 5 minutes so this exists mainly to absorb ad-hoc `curl` floods with a valid secret. Per-cycle wall budget: `maxDuration = 60s`.

**Response** `200` — success envelope (work was done):
```json
{
  "success": true,
  "rewrote": 3,
  "skipped": 1,
  "errored": 0,
  "perCluster": {
    "<cluster_id>": { "status": "rewrote" },
    "<cluster_id>": { "status": "skipped" },
    "<cluster_id>": { "status": "errored", "error": "rewriteClusterHeadline failed" }
  },
  "timestamp": "2026-06-07T12:00:00.000Z"
}
```

**Response** `200` — soft no-op when `ANTHROPIC_API_KEY` is unset (the cron keeps firing every 5 minutes; dropping the key into env vars heals on the next tick without a manual kick):
```json
{ "skipped": true, "reason": "LLM API key not set", "timestamp": "..." }
```

**Response** `200` — no candidates this tick:
```json
{ "success": true, "rewrote": 0, "skipped": 0, "errored": 0, "reason": "no candidates", "timestamp": "..." }
```

**Response** `401`: missing / wrong bearer.
**Response** `429`: rate limit exhausted; envelope includes `details.retryAfterMs`.
**Response** `503`: `CRON_SECRET` not configured in the runtime environment (FAIL-CLOSED).

Per-cluster errors in the success envelope are coarse-tagged (`"rewriteClusterHeadline failed"`, `"member-fetch-failed"`) — raw `err.message` is logged server-side / to Sentry, never embedded in the response body.

---

### `POST /api/newsletter`

Newsletter email signup.

**Rate limit**: 5-token bucket, 1 token/30s refill.

**Body**: `{ "email": "user@example.com" }`

**Response**: `{ "success": true }` (also returns success for duplicates to avoid email enumeration)

---

### `GET /rss.xml`

RSS 2.0 feed of the top 30 politics clusters. Cached 5 minutes.

---

## Core Library Functions

### `getPoliticsClusters()`

```typescript
// src/lib/clusters/politics-query.ts
async function getPoliticsClusters(): Promise<PoliticsClustersResult>
```

Cached entry point for the home feed. Returns ranked `ClusterBundle[]` with:
- Politics-majority filter (≥60% politika/son_dakika)
- Same-source dedupe (earliest article per source kept)
- Wire redistribution detection (≥50% shared content_hash → collapsed)
- Source fairness cap (each source ≤10% of cluster article count)
- Importance ranking (article count, zone diversity, time decay, dominance penalty, velocity)

Cache: `cluster-feed` profile (5 min revalidate), tag `clusters-politics`.

---

### `getClusterDetail(id)`

```typescript
// src/lib/clusters/cluster-detail-query.ts
async function getClusterDetail(id: string): Promise<ClusterDetail | null>
```

Returns full cluster detail with members and all 144 sources. Two parallel PostgREST round-trips. Returns `null` if cluster not found.

Cache: `cluster-feed` profile, tag `cluster-detail:{id}`.

**Return shape**:
```typescript
interface ClusterDetail {
  cluster: { id, title_tr, summary_tr, article_count, bias_distribution, is_blindspot, ... };
  members: Array<{ source: Source; article: { id, title, url, published_at, image_url } }>;
  allSources: Source[];  // all 144, for MediaDna grid
}
```

---

### `detectCrossSpectrum(memberSources, threshold?)`

```typescript
// src/lib/bias/cross-spectrum.ts
function detectCrossSpectrum(
  memberSources: Source[],
  dominantThreshold?: number  // default 0.65
): CrossSpectrumResult
```

Finds the dominant Medya DNA zone and any members from the opposite zone ("surprises").

**Guards**: ≥5 sources, ≥0.65 dominant share, ≥3 absolute margin between dominant and opposite zone.

```typescript
interface CrossSpectrumResult {
  dominantZone: MediaDnaZone | null;
  dominantPct: number;            // 0..1
  surpriseOutlets: Source[];      // opposite-zone members
  blindspotCandidate: boolean;    // true when dominantPct ≥ BLINDSPOT.dominantShare (0.8)
}
```

---

### `summarizeSurprises(result, clusterTitle, max?)`

```typescript
function summarizeSurprises(result: CrossSpectrumResult, clusterTitle: string, max?: number): string[]
```

Renders Turkish blurbs like: `⚡ Sözcü (muhalefet) bu iktidara yakın habere yer verdi: "Headline"`. Returns `[]` when nothing to show.

---

### `fetchFeed(source, opts)`

```typescript
// supabase/functions/_shared/rss/fetcher.ts (Deno)
async function fetchFeed(source: Source, opts?: FetchOpts): Promise<FetchResult>
```

Fetches a single RSS feed with charset-aware decoding (iso-8859-9 / windows-1254 / UTF-8 via XML declaration sniff) and per-source header overrides. Lives in the `ingest` Edge Function. The cycle drives parallel calls itself via a bounded worker pool.

---

### `normalizeItem(source, item)`

```typescript
// supabase/functions/_shared/rss/normalize.ts (Deno)
function normalizeItem(source: Source, item: RawFeedItem): NormalizedArticle | null
```

Normalizes one raw RSS item: URL canonicalization, HTML entity decoding, og:image extraction, sha1-of-shingles `content_hash` (40-char hex; sha256 was retired in migration 016 and locked out by migration 026's CHECK constraint), keyword-based category classification. Returns `null` if the item cannot be hashed even with the URL fallback.

---

### `fetchHeroImage(url)` / `fetchOgImage(url)`

```typescript
// supabase/functions/_shared/og-image.ts (Deno)
async function fetchHeroImage(articleUrl: string): Promise<string | null>
async function fetchOgImage(articleUrl: string): Promise<string | null>
```

Resolve the cover image for an article URL. Used by the `image-consumer` Edge Function. Reads only the first 50KB up to `</head>` and routes every outbound fetch through `_shared/safe-fetch.ts`, which DNS-resolves the host and rejects RFC1918, loopback, link-local, ULA, CGNAT, and IPv6 documentation prefixes (audit T3 SSRF allowlist).

---

### `createRateLimiter(name, opts)`

```typescript
// src/lib/rate-limit.ts
function createRateLimiter(name: string, opts: {
  capacity: number;
  refillPerSecond: number;
}): (key: string) => { allowed: boolean; retryAfterMs: number }
```

In-memory token-bucket rate limiter. Idle buckets evicted after 10 minutes.

```typescript
const limiter = createRateLimiter("my-route", { capacity: 5, refillPerSecond: 0.1 });
const result = limiter(clientKey(request));
if (!result.allowed) return apiError(429, "Too many requests");
```

---

### `zoneOf(bias)`

```typescript
// src/lib/bias/config.ts
function zoneOf(bias: BiasCategory): MediaDnaZone
```

Maps any of the 10 bias categories to one of `"iktidar" | "bagimsiz" | "muhalefet"`.

---

### `getSourceMetadata(slug)`

```typescript
// src/lib/sources/factuality.ts
function getSourceMetadata(slug: string): SourceFactualityMetadata | null
```

Returns hand-tagged `{ factuality: "high"|"mixed"|"low"|null, ownership: string|null }` for known slugs. Returns `null` for untagged sources.

---

### `formatTurkishTimeAgo(dateISO)`

```typescript
// src/lib/time.ts
function formatTurkishTimeAgo(dateISO: string): string
```

Returns Turkish relative time: `"az önce"`, `"5 dakika önce"`, `"2 saat önce"`, `"3 gün önce"`, etc.

---

## Error Handling

All API routes use `withApiErrors()` to catch thrown errors and return consistent JSON:

```typescript
interface ApiError {
  error: string;
  code?: string;
  details?: Record<string, unknown>;
}
```

Helper functions: `apiError(status, message)`, `apiUnauthorized()`, `apiBadRequest(reason)`, `apiNotFound()`, `apiServerError(err)`.

---

## Core Types

```typescript
// src/types/index.ts

type BiasCategory =
  | "pro_government" | "gov_leaning" | "state_media"
  | "islamist_conservative" | "center" | "international"
  | "pro_kurdish" | "opposition_leaning" | "opposition" | "nationalist";

type MediaDnaZone = "iktidar" | "bagimsiz" | "muhalefet";

type NewsCategory =
  | "son_dakika" | "politika" | "dunya" | "ekonomi"
  | "spor" | "teknoloji" | "yasam" | "genel";

type BiasDistribution = Record<BiasCategory, number>;

interface Source {
  id: string;
  name: string;
  slug: string;
  url: string;
  rss_url: string;
  bias: BiasCategory;
  logo_url: string | null;
  active: boolean;
}

interface Article {
  id: string;
  source_id: string;
  title: string;
  description: string | null;
  url: string;
  image_url: string | null;
  published_at: string;
  content_hash: string;
  category: NewsCategory;
  created_at: string;
}
```

---

## Key Components

### `<ClusterCard>`
Server Component. Renders a cluster preview card with hero image, bias spectrum, and member article list. Props: `cluster`, `articles`, `sources`, `index`, `isAging`.

### `<BiasSpectrum distribution compact?>`
Renders a horizontal bar chart of bias distribution. `compact` mode collapses 10 categories into 3 zones.

### `<ClusterStance members>`
Groups cluster members by Medya DNA zone with source chips linking to original articles.

### `<MediaDna sources highlightSlugs?>`
Client Component. Displays all 144 sources grouped by zone. Toggle between showing only cluster participants vs. full directory.

### `<SourceChips slug>`
Server Component. Renders factuality + ownership chips for tagged sources. No-ops for unknown slugs.

### `<ClusterCardImage src srcs? logoSrc?>`
Client Component. Multi-tier image fallback: article images → source logo → gray placeholder. Walks an array of candidates on error.

### `<SearchBar>`
Client Component. Debounced (300ms) URL-driven search with `/` keyboard shortcut.
