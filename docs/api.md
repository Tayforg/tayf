# API Reference

## HTTP Endpoints

**Host.** Call `https://www.tayfhaber.com`. The apex host `tayfhaber.com` redirects to it (a `307` today, planned to become a `308`), and HTTP clients drop the `Authorization` header when a redirect crosses hosts, so a keyed `/api/v1` call sent to the apex comes back `401`. Every example below uses the `www.` host.

**Unsupported methods.** The public read-only JSON endpoints (`/api/sources`, `/api/sources/{slug}`, `/api/timeline/head`, `/api/oembed`) answer `POST`, `PUT`, `PATCH` and `DELETE` with a JSON `405` (`{"error":"Method not allowed"}`, `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store`) and `Allow: GET, HEAD, OPTIONS`. `OPTIONS` on them is a bodyless `204` with the same `Allow` header; `/api/oembed` also sends `Access-Control-Allow-Origin: *` on both. The keyed `/api/v1` routes keep their own `405` and `OPTIONS` shape described in that section.

**Encoded slashes.** A static endpoint followed by an encoded `/` or `\` (`/rss.xml%2F`, `/api/health%5C`) is answered `404` by the edge middleware (the not-found page) instead of a server error; the bare path is untouched.

### `GET /api/health`

Health check. Returns subsystem status for database, the homepage read path, environment, ingestion freshness, clustering freshness, and queue depth.

Two-tier response. Anonymous callers (no `Authorization` header) get only `{ "status", "timestamp" }` and are rate-limited (5-token bucket, 1 token/sec refill; the limiter is process-local, so the cap applies per serverless instance, not globally). Callers presenting `Authorization: Bearer <CRON_SECRET>` get the full per-check breakdown and bypass the rate limit; the bearer gate is the shared `requireCronBearer` helper (`src/lib/api/bearer.ts`) — case-insensitive scheme, constant-time compare, FAIL-CLOSED 503 when `CRON_SECRET` is unset/empty, 401 on a mismatched token.

**Response** `200 | 503` (bearer-authenticated):
```json
{
  "status": "healthy" | "degraded" | "unhealthy",
  "timestamp": "2026-04-16T12:00:00.000Z",
  "checks": {
    "database": { "ok": true, "latencyMs": 42 },
    "readPath": { "ok": true, "latencyMs": 310 },
    "env": { "ok": true, "missing": [] },
    "ingestion": { "ok": true, "lastArticleAgeSec": 120 },
    "clustering": { "ok": true, "lastClusterAgeSec": 300 },
    "queues": { "ok": true, "metrics": [{ "queue": "cluster_work", "queueLength": 0, "oldestMsgAgeSec": null }, { "queue": "image_backfill", "queueLength": 0, "oldestMsgAgeSec": null }] }
  }
}
```

- `unhealthy` (503): database or env failure, or a **read-path error** (`checks.readPath.error` present: the probe errored, was aborted, or timed out at 2s)
- `degraded` (200): the read path **succeeded but took longer than 1500 ms** (`readPath.ok` false, no `error`), ingestion stale (>10 min since last article), clustering stale (>15 min), queue alarm (per-queue depth bound — `cluster_work` >500, `image_backfill` >100 — or oldest message >30 min), or a malformed `worker_metrics` row (NULL / non-numeric `queue_length`)
- `401`: `Authorization` header present but token mismatch
- `503` + error envelope: `Authorization` header present but `CRON_SECRET` not configured (FAIL-CLOSED)
- `429`: anonymous rate limit exhausted. Canonical error envelope `{ "error": "Too many requests", "details": { "retryAfterMs": 640 } }` with `Retry-After: <whole seconds, >= 1>` and `Cache-Control: no-store`
- Each subsystem check has a 2s timeout
- `readPath` (cold-read resilience) runs the homepage's real read — live multi-source `clusters` with the `cluster_articles -> articles -> sources` embed, newest 20 — for **both anonymous and bearer callers**, concurrently with the `database` probe. The one-row `database` probe stays green on a cold cache (Supabase Micro: 256 MB `shared_buffers` vs a 5 GB database) while this read blows through PostgREST's 8 s `statement_timeout`; `readPath` is what turns that outage into a 503. `latencyMs` appears only in the bearer body; anonymous callers still get exactly `{ "status", "timestamp" }`.

---

### `GET /api/metrics`

Live counts for articles, clusters, and sources.

**Headers**: `Authorization: Bearer <CRON_SECRET>` (required — same shared `requireCronBearer` gate as `/api/cron/headline`: 503 FAIL-CLOSED when `CRON_SECRET` is unset/empty, 401 on a mismatched token). Auth-gated operational data is served with `Cache-Control: no-store`.

**Response** `200`:
```json
{
  "timestamp": "...",
  "articles": { "total": 22000, "last24h": 850, "lastHour": 42, "politicsNullImage": 250, "politicsTotal": 12500, "withImage": 20500, "politicsImageMissingRatio": 0.02 },
  "clusters": { "total": 1200, "multiArticle": 980, "blindspots": 12, "avgArticlesPerCluster": 18.33, "avgArticlesPerMultiCluster": 22.22, "neutralizedEligible": 700, "neutralized": 665, "neutralizedRatio": 0.95, "oldestPendingNeutralAgeSec": 480, "quality": { "takenAt": "2026-09-08T03:00:00.000Z", "singletonRate": 0.25, "clusterCount": 80, "blindspotFlipRate": 0.0 } },
  "sources": { "total": 144, "active": 140 },
  "ingest": { "rowErrorsLastHour": 0 }
}
```

- `politicsImageMissingRatio`: `politicsNullImage / politicsTotal` (politics tier = `politika` + `son_dakika`), 2 decimals; 0 when `politicsTotal` is 0
- `avgArticlesPerCluster` averages over ALL clusters (singletons included); `avgArticlesPerMultiCluster` averages only over multi-article clusters — `(total articles - singleton clusters) / multiArticle`, 2 decimals, 0 when `multiArticle` is 0
- `neutralizedRatio`: `neutralized / neutralizedEligible`, 2 decimals; `oldestPendingNeutralAgeSec` is null when no eligible cluster is awaiting a neutral headline
- `quality` (migration 039): summary of the latest `cluster_quality_snapshots` row (written by `node scripts/audit-clusters.mjs --json --persist`) — `null` before the first audit run, or during a partially-applied 039 migration window
- Planner estimates: `articles.total` and `articles.withImage` are read with `Prefer: count=planned` (Postgres statistics estimate, typically within a few %, refreshed by autovacuum ANALYZE), so `avgArticlesPerCluster` and `avgArticlesPerMultiCluster` (which use `articles.total`) are approximate. All other counts (`last24h`, `lastHour`, `politics*`, `clusters.total`/`multiArticle`/`blindspots`, `sources.*`) are exact. `neutralizedEligible` and `neutralized` are exact, served by `headline_neutral_counts()` (migration 083) in a single scan; an RPC failure returns 503 with `details.queries: ["headlineNeutralCounts"]`
- `clusters.blindspots`: the raw count of `clusters` rows with `is_blindspot = true` (exact, no other filter). It is an internal gauge, **not** the public "Kör nokta" claim: it ignores the recall veto (`blindspot_recall_veto`, set by either the `jev_recall` or the `sibling_headline` rule), archived and merged status, the 24 h feed delay and the `/blindspots` quality filters, so it is higher than the number of cards on `/blindspots`. Use `GET /api/v1/clusters` or `GET /api/v1/alerts/blindspots` for the public claim
- `ingest.rowErrorsLastHour` (migration 039): `sum(row_errors)` over `ingest_cycles` rows finished in the last hour; `0` when the table is empty or not yet migrated

---

### `GET /api/admin`

Admin statistics. Not rate-limited (read-only). `articles`, `clusters` and `missingImages` are planner estimates (`Prefer: count=planned`); `sources` is exact. The admin UI marks the estimated tiles with `≈`.

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
| `set_source_rights` | `slug`, `image_allowed?`, `excerpt_allowed?` | Set per-source rights flags (BL-13) |
| `delete_source` | `id` | Delete source and its articles |

`set_source_rights` (BL-13): operator toggle for outlets that have asked Tayf not to use their photos or excerpted text. At least one of `image_allowed` / `excerpt_allowed` is required, both must be booleans when present, and only those two columns on `sources` are ever written. `404` when `slug` does not match an existing source. These flags are read-side gates consumed elsewhere (hero/card image selection, summary attribution) — this action only writes them.

```bash
curl -sS -X POST https://www.tayfhaber.com/api/admin \
  -H "Cookie: admin_session=<admin session cookie value>" \
  -H "Content-Type: application/json" \
  -d '{"action":"set_source_rights","slug":"example-outlet","image_allowed":false}'
# -> 200 {"slug":"example-outlet","image_allowed":false,"excerpt_allowed":true}
```

**Response** `400`: invalid `slug`, no flag provided, or a non-boolean flag value.
**Response** `404`: no source with that `slug`.

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

**Rate limit**: 5-token bucket, 1 token/30s refill. A refused request is `429` with the canonical envelope (`details.retryAfterMs`), `Retry-After` (whole seconds, >= 1) and `Cache-Control: no-store`.

**Body**: `{ "email": "user@example.com" }`

**Response**: `{ "success": true }` (also returns success for duplicates to avoid email enumeration)

---

### `GET /api/newsletter/confirm?token=<uuid>`

The double-opt-in link in the confirmation e-mail. **It never writes.** Mail scanners and link prefetchers follow every GET link in a message, and the old GET that confirmed on sight let any of them subscribe a reader who never clicked.

- `200` `text/html`: a same-origin page ("Tayf bültenine aboneliğini onaylıyor musun?") with a `<form method="post" action="/api/newsletter/confirm">` carrying the token in a hidden field. Headers: `Cache-Control: no-store`, `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer`.
- `302` to `/?bulten=gecersiz`: the token is missing or is not a UUID.
- No database call on either path.

### `POST /api/newsletter/confirm`

What the page's form submits. The token is read from the urlencoded form body (`token=`), falling back to the `?token=` query string; it must be a UUID. Never logged.

**Rate limit**: 10-token bucket, 1 token / 6 s refill, per client IP (the 11th rapid POST is `429`, with `Retry-After` and `Cache-Control: no-store`).

The update is `set confirmed_at = now() where confirm_token = $1 and confirmed_at is null`, so re-submitting the form (or following the e-mail link twice) never moves an existing `confirmed_at`. When it matches nothing, one plain select tells an already-confirmed address from an unknown token.

**Response** (always a `303` redirect back to the site): `/?bulten=onaylandi` when the address is confirmed (now, or already), `/?bulten=gecersiz` for an unknown token, a malformed or absent token, or a database error.

### `GET /api/newsletter/unsubscribe?token=<uuid>` and `POST`

The same two-step shape: GET renders the "Tayf bülteninden ayrılmak istiyor musun?" page (no database call, `302 /?bulten=gecersiz` for a bad token); POST deletes the row and redirects `303` to `/?bulten=ayrildi` (or `gecersiz`). An RFC 8058 one-click POST (`List-Unsubscribe=One-Click`, token in the query string) answers `200 {"success": true}` instead. **Rate limit**: 10-token bucket, 1 token / 6 s, `429` as above.

---

### `POST /api/corrections`

Reader-submitted correction or objection, from the `/metodoloji#duzeltme` form.

**Rate limit**: 5-token bucket, 5/hour refill.

**Body**: `{ "url": "https://...", "message": "...", "email"?: "...", "clusterId"?: "uuid", "website"?: "" }`

- `url`: absolute `http(s)` URL, ≤ 512 chars.
- `message`: 10–2000 chars.
- `email`: optional, ≤ 254 chars, simple regex.
- `clusterId`: optional uuid.
- `website`: honeypot — non-empty returns `200 {ok:true}` without inserting.

**Response** `201`: `{ "ok": true }`
**Response** `400`: validation failure.
**Response** `429`: rate limit exhausted.

Rows are inserted into `public.corrections` (service-role only, no PostgREST access for anon/authenticated) and reviewed in `/admin`.

---

### `GET /api/oyun/cerceve/next` and `POST /api/oyun/cerceve`

The Çerçeve ("Framing") game: one political headline at a time, outlet hidden, an anonymous crowd vote.

**Session cookie**: `tayf_cerceve_sid` (HttpOnly, SameSite=Lax, 30 days) is `<32-hex id>.<base64url HMAC-SHA256 signature>`. The server signs the id; a vote is **counted only when the signature verifies**, so a client cannot *choose* its own session id. Only `sha256("tayf-cerceve:" + id)` reaches the database; the id and the signature never do.

**What this does and does not guarantee.** Signing stops clients picking ids, and `unique (article_id, session_hash)` dedupes votes per session. It does not stop a client from discarding its cookie and being issued a new session, which is a new slot per vote, and the cookie carries no expiry of its own (the 30 days are enforced by the browser), so one address can hold many valid ones. That is bounded by fleet-wide, per-IP DB throttles (`api_throttle`, migration 118; the key is an HMAC of the IP, never the IP): new sessions are capped at **20 per hour** (`cerceve:mint`), counted votes at **200 per hour** in total (`cerceve:vote`) and at **2 per day on any one headline** (`cerceve:art:<article id>`). The per-headline bucket is what bounds a crowd split: one address can add at most 2 votes a day to a given headline. All fail open when the throttle is unavailable. This bounds vote stuffing from one address; it does **not** prevent it from many addresses.

- Key: `FRAMING_SESSION_SECRET` (>= 16 characters, optional) if set, otherwise derived from `ADMIN_SESSION_SECRET` as `HMAC-SHA256(ADMIN_SESSION_SECRET, "tayf-cerceve-v1")`. No new required variable. Rotating either secret invalidates every issued cookie.
- With no usable secret nothing verifies: `GET .../next` still draws, `POST` answers `{ "ok": false, ... }` and never records, and one `[oyun/cerceve] session signing unavailable` warning is logged per process.
- An absent, unsigned (the pre-signing format), tampered or foreign-signed cookie is replaced by a freshly minted signed one; that request's vote is not counted (`ok: false`) and the next one is.
- When the `cerceve:mint` bucket is full, no cookie is issued: `GET .../next` still returns its headline (a draw is never refused) and `POST` still answers `200 { "ok": false, "totals": ... }`; the vote is not counted. The next request from that client without a cookie tries again once the window frees.
- When `cerceve:vote` or the headline's `cerceve:art:` bucket is full, the vote is not written but the response is the normal `200 { "ok": false, "totals": ... }` with `Cache-Control: no-store`, no `Retry-After` and no `429`: the crowd tally is still revealed, a script learns nothing about when to switch address, and an honest player behind a shared address (office, school, mobile carrier) does not lose the reveal.

**Rate limits** (`429` with `Retry-After` and `Cache-Control: no-store`): `GET .../next` 60-token bucket, 0.5 token/s; `POST` 30-token bucket, 0.5 token/s. These in-memory burst limits are the only `429`s of the Çerçeve routes. Fleet-wide, per client (`api_throttle`, fail open, never a `429`): new sessions 20/hour (`GET .../next` and `POST` without a verified cookie; a full bucket withholds the cookie), counted votes 200/hour and 2/day per headline (`POST` with a verified cookie; a full bucket skips the write and answers `200 { "ok": false, ... }`).

---

### `GET /rss.xml`

RSS 2.0 feed of the top 30 politics clusters. Cached 5 minutes.

---

### Topic and blindspot RSS feeds

Three more RSS 2.0 feeds, all `GET`, unkeyed, `Content-Type: application/rss+xml; charset=utf-8`:

| URL | Content |
| --- | --- |
| `/rss/{topic}.xml` | the first page of the `/konu/{topic}` hub. `{topic}` is one of `dunya`, `ekonomi`, `spor`, `yasam`, `teknoloji`, `genel`. Clusters of that topic updated in the last 7 days with at least two articles, newest first. Item `link`s carry `utm_source=rss&utm_medium=feed&utm_campaign=konu_{topic}`. |
| `/rss/kor-noktalar.xml` | the blindspots feed (the `/blindspots` page). Item `link`s carry `utm_campaign=kor_nokta`; each description starts with `Kör nokta: ağırlıkla {zone} kaynakları (%N).` |
| `/blindspots/rss.xml` | the same feed as `/rss/kor-noktalar.xml`, produced by the same code; only the `atom:link rel="self"` URL differs. |

Every item has the headline as `title`, the cluster page as `link` (with the UTM parameters above), the plain `/cluster/{id}` URL as `guid`, the cluster's `first_published` as `pubDate`, and a description such as `7 kaynak · İktidar 4, Bağımsız 2, Muhalefet 1`. The UTM parameters are never part of the `guid`, so a feed reader does not see old items as new.

- **Item cap**: 30 per feed.
- **Cache**: `Cache-Control: public, max-age=300, s-maxage=300` on a `200` (5 minutes; unlike `/rss.xml` there is no `stale-while-revalidate`).
- **`503`**: the read failed (database error or timeout). The body is the plain text `Service unavailable` with `Retry-After: 300` and `Cache-Control: no-store`, never a `200` with an empty feed that a reader would take as "the publisher deleted everything". `/rss.xml` answers a read failure the same way. A read that succeeded but found no matching cluster is a normal `200` feed with no items.
- **`404`**: `/rss/{topic}.xml` with a topic that is not listed above (including `politika`, which the site redirects but has no feed of its own: use `/rss.xml`), or a name that does not end in `.xml`. Plain text `Not found` (`Content-Type: text/plain; charset=utf-8`); the handler sets no `Cache-Control`.
- **`400`**: a malformed percent-encoding in the topic segment (`/rss/%ff.xml`). The edge middleware answers it before the route runs: plain text `Bad request: malformed URL encoding`, `Content-Type: text/plain; charset=utf-8`, `Cache-Control: no-store`, `X-Robots-Tag: noindex`. `/blindspots/rss.xml` has no dynamic segment, so it has no such case.

The feeds are never prerendered at build time, so a build-time outage cannot be baked into them.

---

### `GET /embed/cluster/{id}`

The live "Yelpaze kutusu": a self-contained, **script-less** HTML document (no JavaScript, no external resource, no cookie) that shows how media zones covered one cluster -- a "TAYF" brand line, an optional "Kör nokta" ribbon, the headline (two lines max), a three-segment İktidar / Bağımsız / Muhalefet bar with a percent legend and the source count, and a "tayfhaber.com'da oku" link (`target=_blank rel=noopener`, UTM-tagged `utm_source=embed&utm_medium=iframe`). It is designed to be put in someone else's `<iframe>` at 560 x 200 (down to 320 wide) in light and dark colour schemes.

It is a **route handler**, not a page: `app/layout.tsx` always renders the site chrome, so a chrome-less page is impossible without moving every route. The kart and rozet routes are the precedent.

`id` is a cluster UUID, validated before any read.

| Status | Meaning | `Cache-Control` |
| --- | --- | --- |
| `200` | the widget | `public, s-maxage=300, stale-while-revalidate=600` |
| `308` | the cluster was merged; `Location: /embed/cluster/{survivor}` (relative) | `public, s-maxage=300` |
| `400` | malformed percent-encoding in the id (`/embed/cluster/%ff`), answered by the edge middleware before the route runs: `text/plain; charset=utf-8` body `Bad request: malformed URL encoding`, `X-Robots-Tag: noindex` | `no-store` |
| `404` | malformed id (not a UUID) or unknown cluster; tiny noindex HTML ("Haber bulunamadı") | `public, s-maxage=300` |
| `503` | the read failed (sustained outage); noindex HTML ("Şu anda yüklenemiyor"), `Retry-After: 60` | `no-store` |

A read failure is a `503`, never a cacheable `404`, so an outage cannot unpublish a real story from every embedding page. Every response carries `X-Robots-Tag: noindex` and the document has `<meta name="robots" content="noindex,nofollow">`; `/robots.txt` disallows `/embed/` in every group.

The headline goes through the same KVKK private-individual filter as the kart route (`isGameEligibleTitle`); a rejected title is replaced by the generic "Bu haberin medya yelpazesi".

**Framing policy (security-sensitive).** The rest of the site is not frameable by third parties (CSP `frame-ancestors 'self'` plus `X-Frame-Options: SAMEORIGIN`). `/embed/cluster/{id}` is the single exception (every other `/embed/...` path keeps the site policy and answers a script-less 404) and gets its own header rule (`src/lib/security/headers.ts`, wired into `next.config.ts`, guarded by `tests/guards/frame-headers.test.ts`):

```
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors *
```

There is no `script-src`, so nothing can execute even if the markup were ever injected, and there is no `X-Frame-Options` header on those paths. The copy-paste snippet adds `sandbox="allow-popups allow-popups-to-escape-sandbox"` (no scripts, no same-origin) as defence in depth.

Snippet (the "Gömme kodu" chip on the cluster page copies this; the older "Sitene ekle" chip still copies the static `<a><img>` rozet badge):

```html
<iframe src="https://www.tayfhaber.com/embed/cluster/{id}" width="560" height="200" title="Tayf yelpazesi: bu haberi hangi medya bölgeleri yazdı" loading="lazy" style="border:0;max-width:100%" sandbox="allow-popups allow-popups-to-escape-sandbox"></iframe>
```

---

### `GET /api/oembed`

[oEmbed 1.0](https://oembed.com) provider for cluster URLs, JSON only. Public, unkeyed, CORS-open.

| Parameter | Meaning |
| --- | --- |
| `url` | **required.** `https://www.tayfhaber.com/cluster/{uuid}` (or the apex host `tayfhaber.com`, or the site's own host when `NEXT_PUBLIC_SITE_URL` is https). A query string, hash and one trailing slash are ignored. |
| `format` | optional. Only `json` is supported; anything else (including `xml`) is `501`. |
| `maxwidth` | optional integer, clamped to 120-560 (default 560). Anything that is not 1-5 plain digits falls back to the default. |
| `maxheight` | optional integer, clamped to 120-240 (default 200), same parsing. |

**Response** `200`:

```json
{
  "version": "1.0",
  "type": "rich",
  "provider_name": "Tayf",
  "provider_url": "https://www.tayfhaber.com",
  "title": "...",
  "html": "<iframe src=\"https://www.tayfhaber.com/embed/cluster/{id}\" width=\"560\" height=\"200\" ... sandbox=\"allow-popups allow-popups-to-escape-sandbox\"></iframe>",
  "width": 560,
  "height": 200,
  "cache_age": 3600
}
```

`Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400`. A cluster that was merged into another is embedded as its survivor. `title` uses the same KVKK filter as the widget; a rejected title becomes `"Tayf haberi"`.

Status order (first match wins):

1. `501` -- `format` is present and not `json`.
2. `400` -- `url` is missing or empty.
3. `404` -- `url` is not a Tayf cluster URL (wrong scheme/host/port/path, userinfo, non-uuid id, longer than 2048 characters).
4. `503` -- the cluster read failed (`Cache-Control: no-store`).
5. `404` -- no such cluster (`Cache-Control: public, s-maxage=300`).

**SSRF.** The endpoint never requests the given `url`. It is only parsed; the extracted UUID is the only thing that reaches the database, through the same cached, 4 s capped reader as the cluster page.

Every response, success or error, is `application/json; charset=utf-8` with `Access-Control-Allow-Origin: *`; `OPTIONS` answers `204` with the same header. Cluster pages emit `<link rel="alternate" type="application/json+oembed">` from `generateMetadata` (`src/app/cluster/[id]/page.tsx`; the href comes from `oembedDiscoveryHref` in `src/lib/embed/embed-snippet.ts`). `WordPress`, `Iframely` and `Embedly` are in the `htmlLimitedBots` list, so they receive it in `<head>`.

---

### `GET /api/sources`

The public, unkeyed source registry: every **active** source, ordered by name, as JSON. This is the surface `/llms.txt` points crawlers at, and the shape `GET /api/v1/sources` reuses.

**Response** `200`:

```json
{
  "licence": "CC BY-SA 4.0 — Tayf'a göre",
  "attribution": "https://www.tayfhaber.com/metodoloji",
  "methodology": "https://www.tayfhaber.com/metodoloji",
  "generated_at": "2026-11-01T09:00:00.000Z",
  "count": 118,
  "sources": [
    {
      "slug": "ornek-gazete",
      "name": "Örnek Gazete",
      "url": "https://ornek-gazete.example",
      "bias": "opposition_leaning",
      "bias_label": "Muhalefete Meyilli",
      "zone": "muhalefet",
      "zone_label": "Muhalefet",
      "kind": "outlet",
      "owner_group": null,
      "owner_group_label": null,
      "factuality": null,
      "trustee_since": null,
      "trustee_note": null,
      "rationale": null,
      "rationale_at": null,
      "active": true
    }
  ]
}
```

(The record above is illustrative.) Every field is present on every record. Data that has not been entered is an explicit `null`, never omitted and never filled in by a model: `owner_group` / `owner_group_label` / `factuality` (hand-tagged, so most sources have none), `trustee_since` (ISO `yyyy-mm-dd`) / `trustee_note` (the dated public source for it), `rationale` / `rationale_at` (the operator's written reason for the bias label). `bias` is one of the ten bias categories, `zone` one of `iktidar`, `bagimsiz`, `muhalefet`, `kind` one of `outlet`, `aggregator`, `wire`, `niche`. The feed URL (`rss_url`) is never exposed.

| Status | Meaning | `Cache-Control` |
| --- | --- | --- |
| `200` | the registry | `public, s-maxage=3600, stale-while-revalidate=86400` |
| `429` | the per-client limiter is empty: `{"error":"Too many requests","details":{"retryAfterMs":...}}` with `Retry-After` (whole seconds, at least 1) | `no-store` |
| `500` | the registry could not be read: `{"error":"Internal server error","details":{"request_id":"..."}}`. A sustained read failure is a `500`, never a `200` with an empty `sources` list that a CDN would then hold for an hour | not set |

Rate limit: a 60-token bucket per client, refilling one token per second (about 60 requests per minute sustained; in-memory, so per server instance); the bucket is shared with `GET /api/sources/{slug}`. The query string is never read, so a cache-busting `?cb=<random>` neither mints a cache entry nor costs a database read. The response is not CORS-enabled for browsers by this route; use the keyed `/api/v1/sources` for that.

---

### `GET /api/sources/{slug}`

One source's registry record, its bias-change history and the aggregate reader agreement from `/oyun`.

`{slug}` must match `^[a-z0-9][a-z0-9-]{0,63}$` (lowercase letters, digits and hyphens, at most 64 characters), the `slug` of a record in `GET /api/sources`.

**Response** `200`:

```json
{
  "licence": "CC BY-SA 4.0 — Tayf'a göre",
  "attribution": "https://www.tayfhaber.com/metodoloji",
  "methodology": "https://www.tayfhaber.com/metodoloji",
  "generated_at": "2026-11-01T09:00:00.000Z",
  "source": { "slug": "ornek-gazete", "...": "RegistryRecord, as above" },
  "zone_history": [
    {
      "old_bias": "center",
      "new_bias": "opposition_leaning",
      "reason": null,
      "rater": null,
      "changed_at": "2026-05-14T08:30:00.000Z"
    }
  ],
  "reader_agreement": { "n": 214, "share": 0.633 }
}
```

- `zone_history` is newest first, capped at the 50 most recent changes. `old_bias` is `null` for the first recorded label; `reason` and `rater` are `null` for a change made outside the `set_source_bias` function.
- `reader_agreement` is how often readers of `/oyun` guessed the zone Tayf assigned ("okur tahmini": agreement with Tayf, not accuracy). `share` is rounded to three decimals. It is `null` below 100 guesses, and also when the count could not be read.

| Status | Meaning | `Cache-Control` |
| --- | --- | --- |
| `200` | the record | `public, s-maxage=3600, stale-while-revalidate=300` |
| `400` | `{"error":"Invalid slug"}`: the slug does not match the pattern | not set |
| `400` | `{"error":"Bad request: malformed URL encoding"}`: a malformed percent-encoding in the slug (`/api/sources/%ff`). Answered by the edge middleware before the route runs, so it neither touches the registry nor spends a rate-limit token. `Content-Type: application/json; charset=utf-8` | `no-store` |
| `404` | `{"error":"Source not found"}`: no active source has that slug (an unknown slug and a deactivated one look the same) | `public, s-maxage=300` |
| `429` | same limiter and body as `GET /api/sources`; `Retry-After`, `no-store` | `no-store` |
| `500` | the registry or the history could not be read | not set |

The `stale-while-revalidate` window is only 300 s, much shorter than the list's, so a retracted rationale or corrected bias cannot be served from a stale CDN copy for a day. The handler checks the rate limit first, then the slug shape, then the registry, so an `Invalid slug` request also costs one token. The query string is never read.

---

## /api/v1 (keyed)

Pack E / B11 — a keyed, rate-limited public API for third-party consumers
who want cluster/source data without scraping the site. `GET /api/sources`
stays free and unkeyed (see above); everything under `/api/v1/*` requires
a Bearer API key.

**API keys**: format `tayf_<40 hex chars>` (45 chars total, e.g.
`tayf_1a2b3c...`). Issued from `/admin` (POST /api/admin/api-keys below);
the plaintext key is shown **exactly once**, at creation. Tayf's database
stores only the key's sha256 hash — there is no way to recover a lost key;
revoke it and issue a new one.

**Auth header**: `Authorization: Bearer tayf_<40 hex>` on every `/api/v1/*`
request (case-insensitive `Bearer` scheme).

**Tiers and limits**:

| Tier | Per-minute | Per-day |
|---|---|---|
| `free` | 60 | 2,000 |
| `partner` | 600 | 50,000 |

The per-minute limiter is **process-local** (an in-memory token bucket per
serverless instance — see `src/lib/rate-limit.ts`), so the advertised
per-minute ceiling is a per-replica figure, not a hard global cap. The
**per-day** limit is durable (`api_key_usage_daily`, incremented server-side
on every accepted call) and holds across replicas — it is the only number
callers should treat as a hard global ceiling.

**A refused per-minute request costs no daily quota.** The daily counter is
incremented by the `api_key_touch` database call, so the per-minute bucket
(keyed by the key's sha256, never by IP) is charged *before* that call for any
key this instance has already seen: a `429 key_minute` makes no database round
trip and leaves the day's count untouched. The instance remembers a key's tier
in a process-local memo (at most 5,000 keys, oldest evicted; only keys the
database vouched for are stored, so made-up keys cannot grow it). The first
request for a key the instance has not seen is touched first, because the tier
is only known once the database answers, and charged right after. A key whose
tier changed is charged to its new tier's bucket after the touch; a key the
database reports unknown or revoked is dropped from the memo.

Two **per-source-IP** limiters sit in front of the per-key ones (same
process-local caveat). Which one applies depends on what the caller
presents:

| Caller | Limiter | Burst | Sustained |
|---|---|---|---|
| no key, malformed key, or a well-formed key that is unknown/revoked | `api-v1-anon` | 30 | 60/min (1 token/s) |
| a syntactically valid key (checked **before** any database call) | `api-v1-keyed-ip` | 120 | 600/min (10 tokens/s) |

A **valid** key is never charged to the anonymous bucket: a `partner`
consumer behind a shared egress IP is bounded by its own 600/min key bucket
(and the 600/min keyed-IP ceiling), not by the 60/min anonymous floor. The
keyed-IP ceiling exists so a flood of made-up well-formed keys cannot turn
into unbounded `api_key_touch` database calls: once it is spent the request is
refused `429 ip_floor` without touching the database. A single IP is
therefore still capped at roughly 600/min on a keyed path, which is the
`partner` per-minute figure, so the 600/min tier ceiling is reachable from one
host.

**Response codes** (canonical `{error, code?, details?}` envelope on every
non-2xx):
- `301`: (`GET /api/v1/clusters/[id]` only) the cluster was merged into
  another; `Location` points to the surviving cluster.
- `400`: a request that is malformed in one of two ways.
  - A parameter failed validation (for example `Invalid since`,
    `Invalid limit`, `Invalid cursor`, `Invalid cluster id`, `Invalid slug`,
    `Invalid format`; the endpoint sections below say which). The key was
    already resolved, so the response carries `X-Tayf-Tier`.
  - A **malformed percent-encoding** in the path segment of
    `/api/v1/clusters/{id}` or `/api/v1/sources/{slug}/profile` (for example
    `/api/v1/clusters/%ff`) is rejected by the edge middleware, before any key
    check and before the route runs:
    `{"error":"Bad request: malformed URL encoding"}`. No key is read and
    nothing is charged (neither an IP limiter nor the daily quota). It carries
    the CORS and `Cache-Control: private, no-store` headers below but no
    `X-Tayf-Tier`, because no key was resolved. The same string is the `400`
    body of `GET /api/sources/{slug}`, and a `text/plain` `400` for
    `/embed/cluster/{id}` and `/rss/{topic}.xml`.
- `401`: missing/malformed `Authorization` header, or a well-formed key
  whose hash is not on file. Carries `WWW-Authenticate`:
  `Bearer realm="tayf-api"` when **no** `Authorization` header was sent, and
  `Bearer realm="tayf-api", error="invalid_token"` when one was sent and is
  malformed or unknown.
- `403`: a well-formed, previously-valid key that has been revoked.
- `404`: (`GET /api/v1/clusters/[id]`, `.../sources/{slug}/profile`) unknown
  id/slug — and **any unknown `/api/v1/*` path** (JSON `{"error":"Not found"}`
  with CORS headers, from the `src/app/api/v1/[...path]/route.ts` catch-all;
  keyless, no database call, no rate-limit charge). It applies to every method
  and includes the bare `/api/v1` itself, which `src/app/api/v1/route.ts`
  answers with the same handlers (a required catch-all does not match the
  root).
- `405`: any method other than `GET`, `HEAD` and `OPTIONS` on a real route
  (`{"error":"Method not allowed"}`) with `Allow: GET, HEAD, OPTIONS` and the
  CORS headers. No key is needed and nothing is charged.
- `429`: a limit was exceeded. Always carries `Retry-After` (whole seconds,
  `max(1, ceil(details.retryAfterMs / 1000))`), `details.retryAfterMs`
  (milliseconds) and a `code` naming the limit:

  | `code` | `error` | Meaning |
  |---|---|---|
  | `ip_floor` | `Too many requests` | per-source-IP limiter (anonymous 30 / 60 per min, or keyed-IP 120 / 600 per min) |
  | `key_minute` | `Too many requests` | the key's per-minute bucket (tier-specific); refused before the database, so it costs no daily quota |
  | `key_day` | `Daily limit exceeded` | the key's durable daily cap; `retryAfterMs` is milliseconds until the next UTC midnight |

  `X-Tayf-Tier` is present on `key_minute` / `key_day` (the key was resolved)
  and absent on `ip_floor` (the caller may be unidentified).
- `500`: unexpected server error (never echoes a raw Supabase error).
  `X-Tayf-Tier` is present when the failure happened after the key was
  resolved (a route's own query) and absent when it happened while resolving
  the key (the key lookup or the usage count failed).

**Headers on every `/api/v1` response** (success, error and refusal alike;
the one exception is the `200` of `GET /api/v1/openapi.json`, which is public
and sends its own, shorter set shown in its section):
```
Cache-Control: private, no-store
Content-Type: application/json; charset=utf-8
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, OPTIONS
Access-Control-Allow-Headers: Authorization, Content-Type
Access-Control-Max-Age: 86400
Access-Control-Expose-Headers: X-Tayf-Tier, Retry-After
Vary: Origin, Authorization
```
`Access-Control-Expose-Headers` is what lets browser code read `X-Tayf-Tier`
and `Retry-After` cross-origin; without it `fetch()` hides both. Per-response
extras: `Retry-After` on every `429`, `WWW-Authenticate` on every `401`,
`Allow` on every `405`.

**`X-Tayf-Tier: free | partner`** is the one header that is not on every
response, because the tier is only known once the key has been resolved:

| `X-Tayf-Tier` | Responses |
|---|---|
| present (the key's tier) | every `2xx`; every `301` / `400` / `404` / `500` a route returns after the key was resolved; the `429`s with `code` `key_minute` and `key_day` |
| absent | `401`; `403`; `429` `ip_floor`; a `500` raised while resolving the key; `405`; the unknown-path `404` from the catch-all; the edge-middleware `400` for a malformed URL encoding |
| fixed `free` | the `OPTIONS` preflight `204`: no key is read, so the value says nothing about the caller |

`GET /api/v1/openapi.json` is keyless and carries no `X-Tayf-Tier`. An
exception that escapes a handler altogether is answered by the shared error
wrapper as a bare `500` envelope without any of the headers above; the routes
catch their expected failures first, so that is the exception.

CORS is GET-from-anywhere (this is a read-only public API — any origin may
call it from the browser as long as it presents a valid key). Every
`/api/v1/*` route also answers `OPTIONS` with a bare `204` carrying the
same CORS headers.

**Envelope**: every response body is wrapped by the same
`registryEnvelope()` `/api/sources` uses — `licence` (`CC BY-SA 4.0 —
Tayf'a göre`), `attribution`, `methodology`, `generated_at` — plus the
endpoint's own payload keys.

---

### `GET /api/v1/clusters`

**Query params**: `since` (ISO 8601 timestamp, default 24h ago, clamped to
at most 7 days ago; a date that does not exist on the calendar, e.g.
`2026-02-30`, returns `400`), `limit` (integer 1–100, default 50), `before` (optional
pagination cursor: the `next_cursor` of the previous response, sent unchanged;
see *Paging* below).

**Response** `200`:
```json
{
  "licence": "CC BY-SA 4.0 — Tayf'a göre",
  "attribution": "...",
  "methodology": "...",
  "generated_at": "2026-09-21T12:00:00.000Z",
  "since": "2026-09-20T12:00:00.000Z",
  "count": 12,
  "next_cursor": "eyJ1IjoiMjAyNi0wOS0yMFQxMTozMDowMC4xMjM0NTYrMDA6MDAiLCJpIjoiYzExMTExMTEtMTExMS0xMTExLTExMTEtMTExMTExMTExMTExIn0",
  "clusters": [
    {
      "id": "...",
      "title": "...",
      "url": "https://www.tayfhaber.com/cluster/...",
      "first_published": "...",
      "updated_at": "...",
      "article_count": 6,
      "bias_distribution": { "pro_government": 2, "opposition": 4 },
      "is_blindspot": false,
      "blindspot_side": null,
      "topic7": null,
      "sources": [{ "slug": "sabah", "zone": "iktidar" }, { "slug": "birgun", "zone": "muhalefet" }]
    }
  ]
}
```

Only clusters whose members are ≥60% `politika`/`son_dakika` are returned
(same majority rule the home feed uses). Per member, only `{slug, zone}` is
ever surfaced — no article title, URL, image or description is present
anywhere in the payload; the only URL in a cluster record is Tayf's own
`/cluster/<id>` link. `topic7` is nullable: the `clusters.topic7` column
exists in production, so a `null` means no topic has been assigned to that
cluster. The column is probed once per server process; if the probe ever
fails (e.g. the column is absent on a preview deploy) the field degrades to
`null` for the remaining lifetime of that process rather than erroring.

`is_blindspot` and `blindspot_side` carry the public "Kör nokta" claim,
`is_blindspot AND NOT blindspot_recall_veto`. When a cluster's stored flag is
set but a veto withdrew it, the record reports `is_blindspot: false` and
`blindspot_side: null`. Two rules set the veto: Jev's `blindspot_recall` stage
(`jev_recall`, migration 071) and a near-identically titled sibling cluster that
carries the silent side (`sibling_headline`, migration 126); the reason is not
exposed. The `/blindspots` page adds filters that this endpoint does not: the
24 h delay after `first_published`, the content-quality filters and the
feed-health suppression, so a record can say `is_blindspot: true` for a cluster
the page does not (yet) list. `blindspot_side` is the category of the side that
*covered* the story, not the silent side.

**Paging** (keyset): clusters are ordered `updated_at` descending, then `id`
descending. `next_cursor` is always present: send it back as `?before=` (with
the same `since` and `limit`) to get the clusters strictly after the last one
of this page, with no overlap even when several clusters share an `updated_at`.
Each page is filtered from at most 300 candidates (`limit` × 3, capped at 300),
so a page can hold **fewer than `limit`** clusters and still carry a
`next_cursor`: keep following it until `next_cursor` is `null`, which means the
list is finished. The cursor is opaque (base64url, at most 200 characters) and
carries the last row's `updated_at` verbatim, microseconds included.

**Response** `400`: invalid `since` (not ISO 8601, or a date that does not
exist such as `2026-02-30`) or `limit` (outside
1–100), or a `before` that is not a cursor this API issued (`{"error":
"Invalid cursor"}`). A blank `before=` is treated as absent.

---

### `GET /api/v1/clusters/[id]`

**Response** `200`: `{ ...envelope, "cluster": <same shape as above> }`.
**Response** `400`: `id` is not a UUID (`Invalid cluster id`), or the id has a
malformed percent-encoding (the edge-middleware `400` described under
*Response codes*).
**Response** `301`: the cluster was merged into another one. `Location` is
`/api/v1/clusters/<surviving id>` and the body is `{ "error": "Cluster merged",
"details": { "merged_into": "<surviving id>" } }`.
**Response** `404`: unknown id, or the cluster is archived without a merge target.

---

### `GET /api/v1/sources`

Identical record shape to `GET /api/sources` above (reuses the same
`toRegistryRecord` mapper and the same explicit column list — never
`rss_url`, never `*`). Only active sources are returned.

**Response** `200`: `{ ...envelope, "count": 118, "sources": [RegistryRecord, ...] }`.

---

### `GET /api/v1/sources/{slug}/profile`

Keyed mirror of the "Kapsama karnesi" card on a source page: how the
outlet's clustered stories behaved over the last 30 days. `{slug}` is the
slug from `GET /api/v1/sources` (lowercase letters, digits, hyphens, at
most 64 characters). Only active sources resolve.

**Response** `200`:

```json
{
  "...envelope": "...",
  "source": { "slug": "sabah", "name": "Sabah", "zone": "iktidar", "...": "RegistryRecord" },
  "profile": {
    "window_days": 30,
    "window_start": "2026-08-30T00:00:00.000Z",
    "window_end": "2026-09-29T00:00:00.000Z",
    "computed_at": "2026-09-29T03:00:00.000Z",
    "n_clusters": 40,
    "min_clusters": 20,
    "sufficient": true,
    "n_multi": 25,
    "n_solo": 15,
    "min_multi_for_zones": 10,
    "co_covering_zones": { "iktidar": 10, "bagimsiz": 5, "muhalefet": 20 },
    "public_blindspot_appearances": 3,
    "public_blindspot_same_side": 1
  }
}
```

Null and threshold rules (same as the site):

- Fewer than 20 clustered stories (`sufficient: false`): only the window
  fields and `n_clusters` are set; `n_multi`, `n_solo`, `co_covering_zones`
  and both blindspot fields are `null`.
- 20 or more stories but fewer than 10 multi-source stories:
  `co_covering_zones` is `null`, the rest is present.
- `profile` itself is `null` when the source has no computed row yet (or the
  row fails validation). The status is still `200`.
- `co_covering_zones` counts stories per zone; one story can count in
  several zones, so the values do not sum to `n_multi`.
- No clickbait score and no headline-edit data are exposed.

The numbers are recomputed once a day; `computed_at` is the time of the
last refresh.

**Response** `400`: slug is malformed (`Invalid slug`, no database query is
made), or it has a malformed percent-encoding (the edge-middleware `400`
described under *Response codes*).
**Response** `404`: unknown or inactive source.

---

### `GET /api/v1/kap/pickup`

Keyed mirror of the "Medyada yankı" panel on `/ekonomi/[ticker]`: for each
KAP disclosure of a ticker, how much (and which zone of) press coverage
appeared in the **48 hours after filing**. Never queries
`disclosure_coverage` (an unbounded count against it timed out at 60s in
production) — this endpoint is always ticker- and time-bounded on
`kap_disclosures` / `article_tickers` directly.

**Query params**:
- `ticker` (required): 2–6 uppercase alphanumeric characters (case-insensitive
  on input, normalized to upper). Invalid/missing -> `400`.
- `since` (optional ISO 8601 timestamp): default 30 days ago. A future
  timestamp is rejected (`400`); a timestamp older than 90 days ago is
  silently clamped to 90 days ago. A date that does not exist on the
  calendar (e.g. `2026-02-30`) returns `400`.
- `limit` (optional integer, 1–100, default 50): caps the number of
  disclosures returned (most recent first).

**Response** `200`:
```json
{
  "licence": "CC BY-SA 4.0 — Tayf'a göre",
  "attribution": "...", "methodology": "...", "generated_at": "...",
  "ticker": "THYAO", "window_hours": 48,
  "since": "…", "until": "…",
  "relevance_filter": { "task": "ticker_relevance", "min_prob": 0.2, "applied": true },
  "truncated": false,
  "capped": false, "total_disclosures": 12,
  "totals": {
    "disclosures": 12, "picked_up": 9, "pickup_rate": 0.75,
    "median_first_lag_minutes": 184, "outlets": 14,
    "zones": { "iktidar": 5, "bagimsiz": 6, "muhalefet": 3 }
  },
  "count": 12,
  "disclosures": [
    {
      "disclosure_index": 1234567, "disclosed_at": "…", "subject": "…",
      "disclosure_class": "ODA",
      "kap_url": "https://www.kap.org.tr/tr/Bildirim/1234567",
      "articles": 4, "outlets": 3, "first_lag_minutes": 95,
      "zones": { "iktidar": 1, "bagimsiz": 2, "muhalefet": 0 },
      "sources": [{ "slug": "sabah", "zone": "iktidar" }],
      "window_complete": true, "overlapping_disclosures": 0
    }
  ]
}
```

Notes:
- **Window rule**: each disclosure counts every mention published in its
  own `[filed_at, filed_at + 48h)` window. A mention strictly before its
  disclosure is never pickup. When two disclosures of the same ticker fall
  within 48h of each other, the same article counts toward both —
  `overlapping_disclosures` on each record makes that visible instead of
  silently deduping it away.
- **Relevance filter**: mentions Jev's `ticker_relevance` shadow model
  scored below 0.2 are excluded (a documented false-positive band — e.g. a
  political-party story matching a same-named ticker). Unscored mentions
  are always kept. If the relevance lookup itself fails, the endpoint fails
  open (`relevance_filter.applied: false`) rather than 500ing.
- **`truncated`**: the news-mention read hit its page bound (5 pages of 1,000
  rows), so `articles`, `outlets` and `zones` may undercount.
- **`capped`**: the disclosure list reached `limit`, so older disclosures in
  the window are not in `disclosures` (the `totals` cover only the listed
  ones). Raise `limit` (up to 100) or narrow `since` to see them.
- **`total_disclosures`**: the number of the ticker's disclosures in the whole
  window, however many `disclosures` lists. `null` when that count failed (the
  endpoint still answers rather than 500ing); compare it with `count` to see
  how many are missing.
- **`outlets` vs `articles`**: `articles` counts every matching mention,
  including aggregator/KAP-bot republication; `outlets` and `zones` count
  only distinct, classified, voting-eligible news sources — that is the
  headline number, not `articles`.
- No article title, URL, or id is ever present in the response — only
  disclosure metadata and per-source `{slug, zone}` pairs.
- Both `free` and `partner` tiers may call this endpoint; responses are
  uncached (`private, no-store`).

**Response** `400`: invalid/missing `ticker`, invalid `since` (not ISO 8601,
a date that does not exist such as `2026-02-30`, or in the future), or `limit`
outside 1–100.

### `GET /api/v1/alerts/blindspots`

Keyed alert feed (newsroom-alerts, b2b-5), JSON or RSS. Bearer auth only
(there is **no** `?key=` parameter); the same anonymous floor, per-minute
and per-day metering as every other `/api/v1` route.

**Query params**:
- `since` (optional ISO 8601): a lower bound on `alert_at` (not `updated_at`),
  the moment the alert qualified. Default now minus 24h, clamped to 7 days. A
  date that does not exist on the calendar (e.g. `2026-02-30`) returns `400`.
  `alert_at` is:
  - `blindspot`: `max(updated_at, first_published + 24h)`, because a blindspot
    is only listed 24h after the cluster began (`BLINDSPOT.feedDelayHours`);
  - `one_zone_silent`: `max(updated_at, first_published + 6h)`, because a
    cluster must be 6h old before a zone may be called silent
    (`SILENT_MIN_AGE_H`).
  A cluster's `updated_at` usually precedes the moment its alert first
  appears, so `since` on `updated_at` alone would miss it.
- `limit` (optional integer, 1-100, default 50). Blindspots are capped at 30
  before the merge, the same cap as `/blindspots`, so the list holds at most
  30 `blindspot` alerts however large `limit` is.
- `format` (optional): `json` or `rss`. Anything else -> `400 Invalid format`.
  When absent, RSS is served if `Accept` includes `application/rss+xml`,
  otherwise JSON. RSS responses carry
  `Content-Type: application/rss+xml; charset=utf-8` and
  `Vary: Origin, Authorization, Accept`.

**Two alert types**, merged newest first (`alert_at` descending, ties by
`cluster_id` ascending):
- `blindspot`: exactly the `/blindspots` page rule: the public claim
  `is_blindspot AND NOT blindspot_recall_veto` (both vetoes applied: a Jev
  `blindspot_recall` match at p >= 0.85 that pulls the dominant share under
  80%, and a near-identically titled sibling cluster within 24h that does the
  same), at least 5 voting sources with 80% or more in one zone, 24h delay,
  suppressed when the silent pole zone's feeds are degraded, capped at 30.
- `one_zone_silent`: at least 5 voting sources, exactly one zone at zero,
  cluster first published at least 6h ago, vetoed by neither rule
  (`blindspot_recall_veto` false), not archived. Dropped
  when the silent zone's feeds are degraded; when feed health cannot be read
  the pull feed fails open (the push webhook fails closed).

"Silent" means **Tayf could not match a story from that zone**, never that
the zone chose not to cover it. The copy avoids accusatory wording.

**Response** `200` (JSON):
```json
{
  "licence": "...", "attribution": "...", "methodology": "...", "generated_at": "...",
  "since": "2026-09-28T12:00:00.000Z",
  "count": 1,
  "alerts": [{
    "id": "one_zone_silent:<cluster uuid>",
    "type": "one_zone_silent",
    "cluster_id": "<cluster uuid>",
    "title": "...",
    "url": "https://.../cluster/<cluster uuid>",
    "first_published": "...", "updated_at": "...", "alert_at": "...",
    "source_count": 5,
    "zone_counts": { "iktidar": 3, "bagimsiz": 2, "muhalefet": 0 },
    "dominant_zone": null,
    "silent_zones": ["muhalefet"]
  }]
}
```
`dominant_zone` is set for `blindspot` only. `updated_at` is the cluster's own
last update; `alert_at` is the moment the alert qualified (formulas above) and
is what `since` and the ordering use. If a cluster is updated after it became
an alert, its `alert_at` moves forward and the record is returned again by a
later `since`, so de-duplicate on `id`. A poller that sends `since` = the time
of its last poll sees each alert once when it becomes eligible, and again only
when the cluster changes. For RSS, item `guid` is the bare cluster URL, the
item `pubDate` is `alert_at`, and `link` carries
`utm_source=api&utm_medium=alerts&utm_campaign=alerts`.

#### Signed webhooks (optional, per key)

An operator registers one https address per API key at `/admin/api-webhooks`
(`POST /api/admin/api-keys/webhook`, below). The secret is shown once. Every
new alert is then POSTed as JSON `{ "event": "tayf.alert", "alert": {...},
"licence": "...", "attribution": "..." }` (`alert` is the same record as the
feed). Only alerts whose `alert_at` is at or after the webhook's creation
are sent, and each `alert.id` at most once per key.

Headers: `X-Tayf-Event`, `X-Tayf-Delivery` (delivery id, identical on every
retry), `X-Tayf-Timestamp` (unix seconds, fresh per attempt),
`X-Tayf-Signature`.

Signature: HMAC-SHA256, keyed with the webhook secret, over the timestamp,
then a full stop, then the exact raw request body; hex-encoded and prefixed
with `sha256=`. Recompute it over the raw bytes, compare in constant time and
reject timestamps more than 5 minutes (300 s) from your clock (replay window;
snippet in `docs/newsroom-alerts.md`).

Delivery: https and port 443 only, no redirect following (3xx = failed), 5 s
timeout, responses are read to at most 4 KB and discarded. 2xx succeeds;
5xx, 408, 429, timeouts and network errors retry after 1, 5, 15 and 60
minutes (5 attempts total); other 4xx fail at once. 20 consecutive failures
disable the webhook. Destinations resolving to private, loopback,
link-local or otherwise non-public addresses are refused at registration and
again at connect time. The queue ticks every 10 minutes
(`/api/cron/alerts-webhooks`); set `ALERT_WEBHOOKS_DISABLED=1` to stop it.

### `GET /api/v1/openapi.json`

Static OpenAPI 3.1 description of the whole `/api/v1` surface, generated
from `src/lib/api/v1-docs.ts`'s `V1_ENDPOINTS` by
`src/lib/api/openapi.ts`'s `buildOpenApiDocument()`. No auth required, no
request state read (no headers/cookies/`Date`), so it prerenders as static
output. `tests/api/v1-openapi-contract.test.ts` fails the build's test
suite if a v1 route handler is added/changed without a matching entry
here, or if this document describes an operation with no real handler.

**Response** `200`:
```json
{
  "openapi": "3.1.0",
  "info": { "title": "Tayf API", "version": "1", "license": { "name": "CC BY-SA 4.0 — Tayf'a göre" } },
  "servers": [{ "url": "https://www.tayfhaber.com" }],
  "paths": { "/api/v1/clusters": { "get": { "...": "..." } } }
}
```
**Headers**: `Content-Type: application/json; charset=utf-8`,
`Cache-Control: public, max-age=3600, s-maxage=86400`,
`Access-Control-Allow-Origin: *`,
`Access-Control-Expose-Headers: X-Tayf-Tier, Retry-After`.

`OPTIONS /api/v1/openapi.json` is the same keyless preflight as every other
`/api/v1` route: a bodyless `204` carrying the full CORS set of the shared
headers above with `X-Tayf-Tier: free`, so a browser can fetch the contract
file cross-origin. (Next's automatic `OPTIONS` used to advertise `POST`, `PUT`,
`PATCH` and `DELETE` here and sent no CORS headers.)

Human-readable developer docs (quick-start code samples, the plan table,
error reference) live at [`/gelistirici`](/gelistirici) — both are driven
off the same `V1_ENDPOINTS`/`API_PLANS` module so they cannot silently
drift from each other or from the route handlers.

#### Talep ölçümü (b2b-1 eşiği)

Post-launch go/no-go: the b2b-1 kill threshold is real demand, defined as
**>= 10 keys issued in the trailing 30 days AND >= 3 of those keys active
on 7+ distinct days within that window**. Below that, kill the surface
rather than keep maintaining it.

```sql
select count(*) from api_keys where created_at > now() - interval '30 days';

select count(*) from (
  select key_id from api_key_usage_daily
  where day > current_date - 30
  group by key_id
  having count(*) >= 7
) t;
```

---

### `POST /api/admin/api-keys`

Admin-gated (`hasAdminSession()`, checked before the rate limiter and
before the body is read). Rate limited: 20-token bucket, 0.2 tokens/sec
refill (shared with the revoke route below — both are the same named
bucket).

**Body**: `{ "label": "partner-x", "tier": "free" | "partner" }`
- `label`: 1–64 chars after trim, no control characters.
- `tier`: `"free"` or `"partner"`.

**Response** `201`:
```json
{ "ok": true, "id": 3, "api_key": "tayf_1a2b3c...", "label": "partner-x", "tier": "free", "created_at": "2026-09-21T12:00:00.000Z" }
```
`api_key` is the plaintext key — it appears in **this response and
nowhere else, ever**. Only its sha256 hash is written to `api_keys`.

**Response** `400`: invalid `label` or `tier`.
**Response** `401`: no admin session.
**Response** `429`: rate limit exhausted.

---

### `POST /api/admin/api-keys/revoke`

Same admin gate + same rate-limit bucket as the create route above.

**Body**: `{ "id": 3 }`

**Response** `200`: `{ "ok": true, "id": 3, "revoked_at": "2026-09-21T12:05:00.000Z" }`
**Response** `400`: `id` is not a number.
**Response** `401`: no admin session.
**Response** `404`: no key with that id, or it was already revoked.

---

### `POST /api/admin/api-keys/webhook` and `DELETE`

Admin-session only (`401` otherwise), rate-limited by the shared
`admin-api-keys` limiter. Body `{ "keyId": <int>, "url": "https://..." }`
(`DELETE` needs only `keyId`).

- `POST` validates the URL (https, no userinfo, no IP literal, port 443, a
  dotted public-looking host, at most 2048 chars, no fragment) and resolves
  it: every address must be public. Any URL failure is a generic
  `400 Invalid webhook URL`, never a reason. An unknown or revoked key is
  `404`. Success: `200 { ok, key_id, host, secret }`; the secret
  (`whsec_` plus 64 hex) is returned once, replaces any previous secret and
  resets `fail_streak`.
- `DELETE` removes the webhook row and its unsent queue rows.

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

### `formatTurkishTimeAgo(dateISO, opts?)`

```typescript
// src/lib/time.ts
function formatTurkishTimeAgo(
  dateISO: string,
  opts?: { absoluteAfterMs?: number; now?: number },
): string
```

Returns Turkish relative time: `"az önce"`, `"5 dakika önce"`, `"2 saat önce"`, `"3 gün önce"`, etc. Once the delta reaches `opts.absoluteAfterMs` (default `ABSOLUTE_AFTER_MS`, 48 hours), it stops climbing and instead returns an absolute date via `formatTurkishDate(dateISO)` — a two-week-old cluster should read as a dated event, not "14 gün önce". `opts.now` defaults to `Date.now()` and exists so callers/tests can pin the "current" instant without faking global timers.

---

### `formatTurkishDate(dateISO)`

```typescript
// src/lib/time.ts
function formatTurkishDate(dateISO: string): string
```

Absolute Turkish date, e.g. `"2 Eylül 2026"`. The `Intl.DateTimeFormat` timezone is pinned to `Europe/Istanbul` — this helper runs in both server components (UTC on Vercel) and client components (the visitor's local zone), and an unpinned formatter would render a different calendar day server- vs. client-side for any timestamp near local midnight, causing a hydration mismatch. Returns `""` for an unparseable input, same guard as `formatTurkishTimeAgo`.

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
