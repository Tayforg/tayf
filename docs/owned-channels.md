# Owned channels: per-topic RSS, /hafta permalinks, and the auto-poster

This is the operator runbook for the "owned-channels" pack: six per-topic
RSS feeds plus `/rss/kor-noktalar.xml`, ISO-week permalinks under
`/hafta/[hafta]`, and a Telegram + Bluesky auto-poster gated by migration
079's `social_posts` ledger.

## 1. Environment variables

Names only — no values, no secrets, ever, in this file or in a commit.

| Variable | Required for | Notes |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Telegram posting | From BotFather |
| `TELEGRAM_CHANNEL_ID` | Telegram posting | The public channel the bot admins |
| `BLUESKY_HANDLE` | Bluesky posting | e.g. `tayf.bsky.social` |
| `BLUESKY_APP_PASSWORD` | Bluesky posting | An **app password**, never the account password |
| `BLUESKY_SERVICE_URL` | optional | Must start with `https://`; defaults to `https://bsky.social` |
| `SOCIAL_POST_DRY_RUN` | testing | `1` = compute previews, post nothing |
| `SOCIAL_POST_DISABLED` | kill switch | `1` = the cron is a no-op |
| `CRON_SECRET` | already exists | Same bearer secret every `/api/cron/*` route uses |

A channel is only "configured" once BOTH of its variables are set
(`readSocialConfig` in `src/lib/social/config.ts`). Setting only one of a
pair leaves that channel off — never a half-broken attempt to post.

## 2. Founder account setup

### Telegram
1. Message `@BotFather` on Telegram, `/newbot`, follow the prompts to get
   a bot token.
2. Add the bot as an **admin** of the public channel it will post to (it
   needs "Post Messages" permission).
3. Get the channel's numeric id or its `@channelusername` — either works
   as `TELEGRAM_CHANNEL_ID`.
4. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHANNEL_ID` in the deploy
   environment.

### Bluesky
1. Log into the Tayf Bluesky account.
2. Settings → Privacy and Security → App Passwords → Add App Password.
   Never reuse the account's real password here.
3. Set `BLUESKY_HANDLE` (the account handle) and `BLUESKY_APP_PASSWORD`
   (the app password just created).

## 3. The gates, caps and copy

Every gate in `src/lib/social/select.ts` is **fail-closed** — the
opposite of the site's read paths, which fail open so a transient
Supabase blip never empties `/blindspots`. Posting is a one-way public
action; an unknown state must never be waved through.

Blindspot posting requires ALL of:
- `getZoneFeedHealth()` is non-null (unknown health = no blindspot posts
  this tick at all).
- `!shouldSuppressBlindspot(dominantZone, health)` — the opposite pole's
  feeds must not be degraded.
- The cluster row is **re-read fresh** immediately before the claim:
  `is_blindspot = true`, `blindspot_recall_veto = false`,
  `blindspot_recall_suspect = false`, `blindspot_recall_checked_at` set,
  `is_archived = false`. The 5-minute-cached bundle is never trusted alone.
- `first_published` within 72h (the `/blindspots` 24h delay already
  applies upstream).
- `effectiveArticleCount >= 5` and not a wire redistribution.
- `isGameEligibleTitle(title)` passes — the same KVKK gate `/kart` uses.
  A neutral title can still name a private individual.
- The cluster hasn't already been posted to that channel.

Top-story posting requires: not a blindspot, `sources.length >= 10`,
`effectiveArticleCount >= 10`, `>= 2` Medya DNA zones covered,
`first_published` within 6h, the eligible-title gate, not already posted,
and no top story posted on that channel in the last 3h.

Per tick, per channel: at most 2 blindspots + 1 top story. Per channel,
per 24h: at most `SOCIAL_DAILY_CAP` (8) posts — enforced twice, once in
`select.ts`'s per-tick cap and again, authoritatively, by migration 079's
`social_post_claim` (`p_daily_cap`).

Copy rule: blindspot text always says "az ya da hiç haber yok", never
"görmezden geldi" — absence can be a clustering split, not proven neglect.

## 4. Dry-run procedure

1. Set `SOCIAL_POST_DRY_RUN=1` alongside a configured channel's env vars.
2. Call `GET /api/cron/social` with `Authorization: Bearer $CRON_SECRET`.
3. The response is `{ dryRun: true, previews: [{channel, kind, clusterId,
   text}] }` — zero Supabase RPC calls, zero outbound `fetch` calls, the
   ledger is untouched.
4. Read the previews; when satisfied, unset `SOCIAL_POST_DRY_RUN` (or set
   it to anything other than `1`) to go live.

## 5. Kill switches

- `SOCIAL_POST_DISABLED=1` — the cron returns `{skipped: true, reason:
  "disabled"}` immediately, before any Supabase read.
- Unset both channels' env vars — the cron logs
  `[social] no channels configured; nothing posted` and returns
  `{skipped: true, reason: "no channels configured"}`.
- Set `p_daily_cap` lower via a future migration if 8/day/channel proves
  too high — `social_post_claim`'s own count check is the authoritative
  cap regardless of what the route computes.

## 6. Ledger queries (read-only, service_role)

```sql
-- Everything posted to a channel in the last 24h
select channel, kind, cluster_id, status, created_at, finished_at
from public.social_posts
where channel = 'telegram'
  and created_at > now() - interval '24 hours'
order by created_at desc;

-- Failures, to see why a post didn't go out
select cluster_id, error, finished_at
from public.social_posts
where status = 'failed'
order by finished_at desc
limit 20;
```

**A `status = 'failed'` row is a permanently lost slot for that (channel,
cluster) pair** — `social_post_claim`'s `unique (channel, cluster_id)`
constraint forbids re-claiming it, and nothing ever retries a failed row
(079's own column comment: "never retried automatically"). During a
Telegram/Bluesky outage this reads as gaps in that channel's coverage for
the clusters that failed during the outage, not delayed catch-up posts
once the channel recovers — expect that, don't wait for it to self-heal.

`social_posts` has no anon/authenticated/public grant at any layer;
`service_role` gets `SELECT` only (no direct insert/update — every write
goes through `social_post_claim` / `social_post_finish`).

## 7. RSS feed URLs and permalink format

- `/rss/dunya.xml`, `/rss/ekonomi.xml`, `/rss/spor.xml`, `/rss/yasam.xml`,
  `/rss/teknoloji.xml`, `/rss/genel.xml` — one feed per topic hub, linked
  from `/konu/[slug]` (an `alternates.types` tag plus a visible "RSS"
  link).
- `/rss/kor-noktalar.xml` — the same list as `/blindspots` (24h delay,
  recall veto, live contract, feed-health suppression), linked from
  `/blindspots`.
- `/hafta/2026-W39` — ISO-week permalink into the weekly archive.
  `2026-W38` is the earliest week (`/hafta` shipped 2026-09-19); `/hafta`
  itself stays the rolling trailing-7-day page with canonical `/hafta`.
