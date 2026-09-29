# newsroom-alerts

Keyed alert feed plus signed webhooks (b2b-5, migration 097).

## Surfaces

| Surface | File |
|---|---|
| `GET /api/v1/alerts/blindspots` (JSON or RSS) | `src/app/api/v1/alerts/blindspots/route.ts` |
| Rules and RSS copy (pure) | `src/lib/alerts/alert-feed.ts` |
| Item source (blindspots + silent query) | `src/lib/alerts/alert-query.ts` |
| SSRF guard | `src/lib/alerts/webhook-url.ts` |
| Signing | `src/lib/alerts/webhook-sign.ts` |
| Delivery, classification, backoff | `src/lib/alerts/webhook-deliver.ts` |
| Push cron `*/10 * * * *` | `src/app/api/cron/alerts-webhooks/route.ts` |
| Admin API | `src/app/api/admin/api-keys/webhook/route.ts` |
| Admin page | `src/app/admin/(protected)/api-webhooks/page.tsx` |
| Schema | `supabase/migrations/097_api_key_webhooks.sql` |

Public contract: `docs/api.md` (section `GET /api/v1/alerts/blindspots`), `/gelistirici` and `openapi.json` (both generated from `src/lib/api/v1-docs.ts`).

## Rules

- **blindspot**: `getBlindspots()` as is (recall veto, live contract of at least 5 voting sources and 80% in one zone, 24h delay, feed-health suppression), capped at 30, kept when `cluster.updated_at >= since`. Counts come from the cluster's `bias_distribution` tally.
- **one_zone_silent**: one lean query (below) then `oneZoneSilentOf`: voting total at least `BLINDSPOT.minSources` (5) and EXACTLY one zone at zero. `SILENT_MIN_AGE_H = 6`. Dropped when that zone's feeds are degraded; with health unknown the pull feed fails open like the site, the push cron fails closed.
- "Silent" always means "Tayf could not match a story from that zone". Copy never says a zone "did not write" and never uses accusatory wording (a test pins it).

## Push semantics

1. Enabled webhooks on non-revoked keys (max 20; more is logged). None: `{skipped:'no webhooks'}` before any other query.
2. Health unknown: `{skipped:'feed health unknown'}` (fail closed).
3. Blindspot rows are re-read fresh; only `is_blindspot` true, veto false, suspect false, checked_at set and not archived are pushed.
4. Enqueue per webhook, only items with `updated_at >= webhook.created_at`, via `upsert(..., {onConflict:'key_id,alert_id', ignoreDuplicates:true})`. The payload is stored once, so every retry sends identical bytes and the same `X-Tayf-Delivery`.
5. `api_webhook_claim(p_limit := 20)`, deliver with concurrency 4 and a 5 s timeout, fresh timestamp and signature per attempt.
6. Success: `delivered`, streak reset. Retryable failure: `pending` with backoff of 1, 5, 15, 60 minutes, `failed` at 5 attempts. Any failure bumps `fail_streak`; the 20th consecutive one sets `enabled=false, disabled_reason='too_many_failures'`.

Logs carry counts only, never a URL path, secret, header or body.

## SSRF layers

1. `validateWebhookUrlSyntax`: https, no userinfo, no IP literal (decimal/hex forms are normalised by WHATWG URL first), port empty or 443, dotted host, no `localhost` or `.local/.internal/.lan/.home.arpa/.localhost`, no fragment, at most 2048 chars.
2. `assertPublicHost` at registration: every resolved address must be public, and the name must resolve.
3. `pinnedLookup` at connect time (`https.request({ lookup })`): resolves again and refuses any blocked address, closing the DNS-rebinding gap between 2 and delivery. Both `options.all` shapes are supported.

`isBlockedAddress` uses two `node:net` BlockLists (IPv4 and IPv6 kept apart, because Node matches an IPv4 address against IPv4-mapped IPv6 subnets in a mixed list). It blocks the spec's IPv4 and IPv6 ranges, every IPv4-mapped (`::ffff:0:0/96`) and IPv4-compatible (`::/96`) literal, plus NAT64 `64:ff9b::/96` and 6to4 `2002::/16` (both embed an IPv4 address). Unparseable input is blocked.

## Verification record

Local PG15 (throwaway cluster, stub.sql + 061 + 069 + 097, applied twice; second run is all `already exists, skipping`):

- claim 1 returned 2 rows (attempts 1); immediate second claim returned 0.
- `claimed_at` set 10 minutes back: both rows re-claimed (attempts 2).
- duplicate `(key_id, alert_id)` insert: `unique_violation`.
- revoked key: claim 0. Disabled webhook: claim 0.
- `anon` cannot execute the claim function; only `postgres` and `service_role` hold table privileges; RLS on for both tables.
- bad url or secret: check violation (23514).
- The pg_cron branch is skipped locally (extension absent) and is covered by the static test only.

### EXPLAIN of the silent candidate query (production, read-only, 2026-09-29)

```
explain (analyze, buffers) select id, title_tr, title_tr_neutral, bias_distribution,
  article_count, first_published, updated_at from public.clusters
 where is_archived = false and is_blindspot = false and blindspot_recall_veto = false
   and article_count >= 5 and updated_at >= now() - interval '24 hours'
   and first_published <= now() - interval '6 hours'
 order by updated_at desc limit 200;
```

| window | execution | plan |
|---|---|---|
| since = 24h (default) | 7.7 ms, 43 rows | BitmapAnd of `idx_clusters_active_updated_at` and `clusters_neutral_eligible_idx`, quicksort |
| since = 7 days (max) | 24.2 ms, 200 rows | same shape, 350 candidate rows before the limit |

Target was under 200 ms using `idx_clusters_active_updated_at`: met with wide margin, and the plan does use that index (the second bitmap is planner-chosen, not required).

## Operating notes

- Kill switch: `ALERT_WEBHOOKS_DISABLED=1`.
- A disabled webhook is re-armed by registering the address again (new secret, streak reset).
- Deleting a webhook also deletes its unsent queue rows, so a later different URL never receives old payloads.
- Deliveries are kept 30 days (`api-webhook-deliveries-retention`, 03:37 UTC).
