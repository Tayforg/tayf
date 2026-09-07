import { connection, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { requireCronBearer } from "@/lib/api/bearer";
import { apiError, apiServerError, withApiErrors } from "@/lib/api/errors";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import { sendBatch } from "@/lib/email/resend";
import { siteUrl } from "@/lib/site-url";
import { getPoliticsClusters } from "@/lib/clusters/politics-query";
import { getBlindspots, type BlindspotBundle } from "@/lib/clusters/blindspots-query";
import {
  buildDigestHtml,
  type DigestBlindspotItem,
  type DigestClusterItem,
} from "@/lib/digest/template";

// Boot-time guard, same rationale as the headline cron: a missing
// CRON_SECRET is otherwise only visible per-request (503 on every
// invocation), so surface it once at module-load.
if (process.env.NODE_ENV === "production" && !process.env.CRON_SECRET) {
  console.warn(
    "[digest-cron] CRON_SECRET is not set; route will fail-closed with 503 on every invocation",
  );
}

/**
 * Vercel cron — weekly newsletter digest.
 *
 * Runs Saturday 09:00 TRT (see `vercel.ts`). Picks the top 5 politics
 * clusters by article count and the most lopsided blindspot, renders one
 * HTML email per due subscriber (confirmed, not sent to in the last 6
 * days), and sends the batch via Resend. `last_sent_at` is stamped only
 * for subscribers whose send actually succeeded, so a Resend outage or a
 * missing API key leaves them due again on the next tick instead of
 * silently skipping a week.
 *
 * AUTH: gated by `requireCronBearer` — same fail-closed 503 / 401 contract
 * as `/api/cron/headline`.
 */

export const maxDuration = 60;

// The digest ticks once a week; this guards against accidental floods if
// the endpoint is hit ad-hoc with a valid secret (same pattern as the
// headline cron's rate limiter).
const digestLimit = createRateLimiter("cron-digest", {
  capacity: 3,
  refillPerSecond: 1 / 3600,
});

// Bounds one cron tick's work. The subscriber list is small today; this
// keeps the query — and the sequential last_sent_at updates below — well
// inside the 60s ceiling if it grows before pagination is added.
const SUBSCRIBER_FETCH_LIMIT = 5000;

// Send + stamp in small chunks rather than one giant sendBatch: if the
// invocation is killed mid-run (maxDuration), only the in-flight chunk's
// subscribers risk a duplicate send on the next tick, not the whole batch.
const SEND_CHUNK = 25;

// A subscriber is "due" once their last digest is at least this old.
const RESEND_INTERVAL_MS = 6 * 24 * 60 * 60 * 1000;

const TOP_CLUSTER_COUNT = 5;

const DIGEST_SUBJECT = "Tayf Haftalık Bülteni";

interface SubscriberRow {
  id: string;
  email: string;
  unsubscribe_token: string;
  last_sent_at: string | null;
}

function isDue(row: Pick<SubscriberRow, "last_sent_at">, nowMs: number): boolean {
  if (!row.last_sent_at) return true;
  return nowMs - new Date(row.last_sent_at).getTime() >= RESEND_INTERVAL_MS;
}

function toClusterItem(bundle: {
  cluster: { id: string; title_tr: string; summary_tr: string; bias_distribution: DigestClusterItem["biasDistribution"] };
  articles: unknown[];
}): DigestClusterItem {
  return {
    id: bundle.cluster.id,
    title: bundle.cluster.title_tr,
    summary: bundle.cluster.summary_tr,
    articleCount: bundle.articles.length,
    biasDistribution: bundle.cluster.bias_distribution,
  };
}

function toBlindspotItem(bundle: BlindspotBundle): DigestBlindspotItem {
  return {
    id: bundle.cluster.id,
    title: bundle.cluster.title_tr,
    summary: bundle.cluster.summary_tr,
    biasDistribution: bundle.cluster.bias_distribution,
    dominantZone: bundle.dominantZone,
    dominantPct: bundle.dominantPct,
  };
}

export const GET = withApiErrors(async (request: Request) => {
  // Next.js 16 cacheComponents prerenders GET handlers at build time;
  // `await connection()` defers `request.headers` access until an actual
  // request lands. See src/app/api/cron/headline/route.ts for the same
  // pattern + link.
  await connection();

  const auth = requireCronBearer(request);
  if (!auth.ok) {
    return auth.response;
  }

  const rl = digestLimit(clientKey(request));
  if (!rl.allowed) {
    return apiError(429, "Too many requests", {
      details: { retryAfterMs: rl.retryAfterMs },
    });
  }

  const supabase = createServerClient();

  // Confirmed subscribers only; the 6-day "due" window is applied in JS
  // below rather than a `.or()` PostgREST filter, keeping the query a
  // single trackable predicate.
  const { data: subscriberRows, error: subscriberError } = await supabase
    .from("newsletter_subscribers")
    .select("id, email, unsubscribe_token, last_sent_at")
    .not("confirmed_at", "is", null)
    .limit(SUBSCRIBER_FETCH_LIMIT)
    .returns<SubscriberRow[]>();

  if (subscriberError) {
    return apiServerError(subscriberError);
  }

  const nowMs = Date.now();
  const due = (subscriberRows ?? []).filter((row) => isDue(row, nowMs));

  if (due.length === 0) {
    return NextResponse.json({ sent: 0, skipped: 0 });
  }

  // Fetch the digest content once — identical for every subscriber except
  // the per-subscriber unsubscribe link.
  const [politicsResult, blindspotResult] = await Promise.all([
    getPoliticsClusters(),
    getBlindspots(),
  ]);

  const topClusters = [...politicsResult.bundles]
    .sort((a, b) => b.cluster.article_count - a.cluster.article_count)
    .slice(0, TOP_CLUSTER_COUNT)
    .map(toClusterItem);

  const topBlindspot = blindspotResult.bundles[0]
    ? toBlindspotItem(blindspotResult.bundles[0])
    : null;

  const origin = siteUrl();

  function toEmail(row: SubscriberRow) {
    return {
      to: row.email,
      subject: DIGEST_SUBJECT,
      html: buildDigestHtml({
        clusters: topClusters,
        blindspot: topBlindspot,
        siteUrl: origin,
        unsubscribeUrl: `${origin}/api/newsletter/unsubscribe?token=${encodeURIComponent(row.unsubscribe_token)}`,
      }),
    };
  }

  let sent = 0;
  let skipped = 0;
  const sentAtIso = new Date(nowMs).toISOString();

  // Chunked send + stamp (see SEND_CHUNK): each chunk's successful rows are
  // stamped before moving to the next, so a mid-run timeout only risks
  // re-sending the chunk in flight, not the whole due list.
  for (let start = 0; start < due.length; start += SEND_CHUNK) {
    const rows = due.slice(start, start + SEND_CHUNK);
    const results = await sendBatch(rows.map(toEmail), 5);

    // Sequential updates (same tradeoff as the headline cron): a per-row
    // `.eq("id", …)` update keeps a failed write isolated to its own
    // subscriber instead of risking a bulk `.in()` update silently
    // mismatching due to a stale id.
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const result = results[i];
      if (result && "ok" in result && result.ok) {
        sent++;
        const { error: updateError } = await supabase
          .from("newsletter_subscribers")
          .update({ last_sent_at: sentAtIso })
          .eq("id", row.id);
        if (updateError) {
          console.error("[digest-cron] last_sent_at update failed", row.id, updateError);
        }
      } else {
        // Missing API key (`skipped: true`) or a failed send (`ok: false`)
        // both leave `last_sent_at` untouched so the subscriber is due
        // again on the next tick instead of silently losing a week.
        skipped++;
        if (result && "error" in result) {
          console.error("[digest-cron] send failed", row.email, result.error);
        }
      }
    }
  }

  return NextResponse.json({ sent, skipped });
});
