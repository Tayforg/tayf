import type { VercelConfig } from "@vercel/config/v1";

/**
 * Vercel project configuration (replaces `vercel.json`).
 *
 * Docs: https://vercel.com/docs/project-configuration/vercel-ts
 *
 * CRONS
 * -----
 * Ingestion, clustering and image backfill now run as an event-driven
 * stream out of Supabase: a pg_cron job pokes the `ingest` Edge Function,
 * an `AFTER INSERT ON articles` trigger fans work onto the `pgmq` queues
 * `cluster_work` and `image_backfill` (a second, probe trigger feeds the
 * shadow-only `cluster_attach` queue, migration 151), and `pg_cron` drains
 * them into the co-located `cluster-consumer` and `image-consumer` Edge
 * Functions. None of those steps live on Vercel anymore.
 *
 * The Vercel crons are the neutral-headline rewriter and four app routes
 * (digest, fact-checks, social, alerts-webhooks):
 *
 *   - `/api/cron/headline` — Walks clusters that still lack
 *     `title_tr_neutral` and asks the headline LLM for a tarafsız başlık.
 *     Stateless and bounded (5 clusters per tick) so LLM spend stays
 *     predictable and a transient upstream 5xx never blows a whole
 *     batch. Fail-closed against a missing `CRON_SECRET`. See
 *     `src/app/api/cron/headline/route.ts`.
 *
 *   - `/api/cron/digest` — Weekly newsletter: top 5 politics clusters +
 *     the most lopsided blindspot, mailed to confirmed subscribers due
 *     for a resend (never sent, or last sent more than 5 days 18 hours ago).
 *     Fires Saturday 09:00 TRT (06:00 UTC) and again Sunday 09:00 TRT:
 *     Saturday sends, Sunday retries only what Saturday could not (a send
 *     Resend kept rate limiting, or rows left over once the send-time budget
 *     ran out). Delivery is at-least-once: Saturday's stamps keep the Sunday
 *     run from mailing most subscribers twice, but a mail Resend accepted
 *     whose stamp was never written (a send in flight at a platform kill, a
 *     fetch that timed out after Resend accepted it, a stamp that failed
 *     twice) can be mailed again by Sunday's tick. Same route, same bearer.
 *     Fail-closed against a missing `CRON_SECRET`. See
 *     `src/app/api/cron/digest/route.ts`.
 *
 *   - `/api/cron/fact-checks` — "Bu konuda doğrulama": fetches Teyit,
 *     Doğruluk Payı and Malumatfuruş's RSS feeds, upserts new fact-check
 *     articles (migration 080), and links them to recent clusters via a
 *     pure keyword matcher (`src/lib/fact-checks/match.ts`). Headline +
 *     link only, never a verdict or description. Fail-closed against a
 *     missing `CRON_SECRET`. See `src/app/api/cron/fact-checks/route.ts`.
 *
 *   - `/api/cron/social` — Owned-channels auto-poster (Telegram +
 *     Bluesky): posts at most 2 blindspots and 1 top story per channel
 *     per tick, gated by migration 079's `social_posts` ledger
 *     (claim-before-post, unique (channel, cluster_id), 8/day cap per
 *     channel). Every ten-minute-scale window between 08:00 and 23:40
 *     TRT (05:00-20:40 UTC), every 20 minutes — proven safe on this plan
 *     by the existing 5-minute headline cron (Hobby would reject a
 *     sub-daily cron at deploy). No-op (disabled or unconfigured) when
 *     `SOCIAL_POST_DISABLED=1` or no channel env vars are set.
 *     Fail-closed against a missing `CRON_SECRET`. See
 *     `src/app/api/cron/social/route.ts` and `docs/owned-channels.md`.
 *
 *   - `/api/cron/alerts-webhooks` — newsroom-alerts: signed webhook push
 *     of the keyed alert feed (`/api/v1/alerts/blindspots`), every 10
 *     minutes. Loads enabled webhooks on live API keys (migration 097) and,
 *     with none registered, returns `{skipped:'no webhooks'}` before any
 *     other query. Fails CLOSED when feed health is unknown, re-reads
 *     blindspot rows fresh (veto / suspect / unchecked / archived never
 *     push), enqueues idempotently (unique key_id + alert_id), then delivers
 *     with HMAC-SHA256 signatures, no redirect following and an SSRF-pinned
 *     connect. `ALERT_WEBHOOKS_DISABLED=1` turns it off. Fail-closed against
 *     a missing `CRON_SECRET`. See `src/app/api/cron/alerts-webhooks/route.ts`
 *     and `docs/newsroom-alerts.md`.
 *
 * Full architecture in `docs/adr/001-worker-stream-system.md`; operator
 * cutover steps in `docs/migration-guide.md`.
 *
 * REGION
 * ------
 * Supabase lives in `eu-west-2` (London) -- confirmed live via
 * `select inet_server_addr()` returning a `2a05:d01c::/32` address, AWS's
 * eu-west-2 range (audit fix A, 2026-09-28). Every DB round trip from the
 * default `iad1` (Washington, D.C.) region currently crosses the Atlantic
 * twice per request. A single Vercel region is allowed on every plan
 * (including Hobby), so pinning to `lhr1` (London) removes that hop with
 * no plan upgrade required.
 */
const config: VercelConfig = {
  regions: ["lhr1"],
  crons: [
    { path: "/api/cron/headline", schedule: "*/5 * * * *" },
    { path: "/api/cron/digest", schedule: "0 6 * * 6,0" },
    { path: "/api/cron/fact-checks", schedule: "23 * * * *" },
    { path: "/api/cron/social", schedule: "*/20 5-20 * * *" },
    { path: "/api/cron/alerts-webhooks", schedule: "*/10 * * * *" },
  ],
};

export default config;
