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
 * an `AFTER INSERT ON articles` trigger fans work onto two `pgmq` queues
 * (`cluster_work`, `image_backfill`), and `pg_cron` drains them into the
 * co-located `cluster-consumer` and `image-consumer` Edge Functions. None
 * of those steps live on Vercel anymore.
 *
 * The single remaining Vercel cron is the neutral-headline rewriter:
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
 *     for a resend (never sent, or last sent 6+ days ago). Fires
 *     Saturday 09:00 TRT (06:00 UTC). Fail-closed against a missing
 *     `CRON_SECRET`. See `src/app/api/cron/digest/route.ts`.
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
 * Full architecture in `docs/adr/001-worker-stream-system.md`; operator
 * cutover steps in `docs/migration-guide.md`.
 */
const config: VercelConfig = {
  crons: [
    { path: "/api/cron/headline", schedule: "*/5 * * * *" },
    { path: "/api/cron/digest", schedule: "0 6 * * 6" },
    { path: "/api/cron/fact-checks", schedule: "23 * * * *" },
    { path: "/api/cron/social", schedule: "*/20 5-20 * * *" },
  ],
};

export default config;
