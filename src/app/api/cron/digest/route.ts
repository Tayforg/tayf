import { connection, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { requireCronBearer } from "@/lib/api/bearer";
import { substepErrorsInit, withCronOutcome } from "@/lib/ops/cron-route-outcome";
import { apiTooManyRequests, apiServerError, withApiErrors } from "@/lib/api/errors";
import { POSTGREST_MAX_ROWS, readAllPages } from "@/lib/db/paging";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import { isMailConfigured, sendBatch, type SendEmailResult } from "@/lib/email/resend";
import { siteUrl } from "@/lib/site-url";
import { getWeeklyDigestClusters } from "@/lib/clusters/politics-query";
import { nonVotingOutsideZone } from "@/lib/bias/zone-summary";
import { getBlindspots, type BlindspotBundle } from "@/lib/clusters/blindspots-query";
import { getRssSummaryMembers } from "@/lib/clusters/rss-summary-attribution";
import { captureServerException } from "@/lib/sentry/server";
import {
  resolveSummaryAttribution,
  summaryLabel,
  type SummaryAttribution,
  type SummaryMember,
} from "@/lib/clusters/summary-attribution";
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

// Same rationale, for the other secret this route can't function without:
// a missing RESEND_API_KEY is otherwise only visible per-request (a
// {skipped:true} body on every invocation), so surface it once at
// module-load too.
if (process.env.NODE_ENV === "production" && !isMailConfigured()) {
  console.warn(
    "[digest-cron] RESEND_API_KEY is not set; digests are disabled",
  );
}

/**
 * Vercel cron — weekly newsletter digest.
 *
 * Runs Saturday 09:00 TRT and again on Sunday 09:00 TRT (see `vercel.ts`:
 * `0 6 * * 6,0`). Picks the top 5 politics clusters first published in the last
 * 7 days, by article count, and the most lopsided blindspot, renders one HTML
 * email per due subscriber (confirmed, last mailed more than 5 days 18 hours ago,
 * see RESEND_INTERVAL_MS), and sends them via Resend, paced to its 2 requests per
 * second (`sendBatch`). `last_sent_at` is stamped only for subscribers whose send
 * actually succeeded, each one as soon as its own send resolves, so a Resend outage
 * or a missing API key leaves them due again.
 *
 * SUNDAY RETRY TICK: Saturday does the send; Sunday is the retry for whatever
 * Saturday could not finish: a send Resend still rejected after its own bounded
 * 429 retries, or rows left over once the send-time budget ran out
 * (SEND_START_DEADLINE_MS, SEND_HARD_DEADLINE_MS; the deferred rows go first, see
 * the due ordering below). Sunday also mails whoever confirmed after Saturday's
 * tick. It is the same route with the same bearer auth. Saturday's stamp is 24 h old
 * on Sunday, far inside RESEND_INTERVAL_MS, so Sunday's due list is the unstamped
 * rows and nobody Saturday stamped. A row Sunday itself mailed rejoins Saturday's
 * cohort: RESEND_INTERVAL_MS is 6 h short of the 6 days from a Sunday tick to the
 * next Saturday's, so it is due again then whatever the seconds of jitter between
 * the two ticks' clock reads. Whatever Sunday cannot send waits for the next
 * Saturday, which is when it would be due again anyway.
 *
 * AT-LEAST-ONCE, NOT EXACTLY-ONCE: the stamp is the only thing that keeps Sunday's
 * tick from mailing a subscriber again, and it is written after Resend has answered,
 * so a mail Resend accepted whose stamp was never written can go out a second time on
 * Sunday. That happens when (1) a send is in flight when the platform kills the
 * function (at most the 5 in-flight sends of one chunk: every finished send is
 * already stamped), (2) a fetch hits its 8 s timeout after Resend had accepted the
 * message, or (3) the stamp itself fails twice (counted in `substepErrors`).
 *
 * AUTH: gated by `requireCronBearer` — same fail-closed 503 / 401 contract
 * as `/api/cron/headline`.
 *
 * SUB-STEP FAILURES (W3): two Supabase failures are swallowed and leave the run at
 * 200: the `last_sent_at` write after a successful send (the subscriber would be
 * mailed again next tick) and a failed rights-gated summary member lookup (the
 * summaries are hidden, fail closed, but the mail goes out degraded). Each is
 * counted in `substepErrors`; the final body carries the count and the internal
 * `x-cron-substep-errors` header makes withCronOutcome record 599
 * (src/lib/ops/cron-route-outcome.ts). A Resend send that fails is a vendor
 * failure and is NOT counted.
 */

export const maxDuration = 60;

// The digest ticks once a week; this guards against accidental floods if
// the endpoint is hit ad-hoc with a valid secret (same pattern as the
// headline cron's rate limiter).
const digestLimit = createRateLimiter("cron-digest", {
  capacity: 3,
  refillPerSecond: 1 / 3600,
});

// Bounds one cron tick's work. The subscriber list is small today; this keeps
// the read — and the sequential last_sent_at updates below — well inside the
// 60s ceiling if it grows. PostgREST returns at most 1,000 rows per response
// whatever `.limit()` asks for, so the list is read in pages of
// POSTGREST_MAX_ROWS (SUBSCRIBER_MAX_PAGES requests at most).
const SUBSCRIBER_FETCH_LIMIT = 5000;
const SUBSCRIBER_MAX_PAGES = SUBSCRIBER_FETCH_LIMIT / POSTGREST_MAX_ROWS;

// Send in chunks of SEND_CHUNK rows. Every delivered mail is stamped as soon as its
// own send resolves (sendBatch's onResult), not when the chunk ends, so if the
// invocation is killed (maxDuration) the rows at risk of a second mail on Sunday are
// only the sends in flight at that moment, never a whole chunk. The chunk exists to
// bound one sendBatch call and the check against SEND_START_DEADLINE_MS between them.
const SEND_CHUNK = 25;

// h87-newsletter-2: sendBatch spaces its starts 500 ms apart (Resend's 2 requests
// per second), so one chunk takes about SEND_CHUNK / 2 = 12.5 s and a tick sends
// roughly 75 mails. No chunk is started once this much of the 60 s maxDuration
// has gone (counted from the start of the request, content reads included), so
// the tick ends on its own: the rows it did not reach are reported as `deferred`
// and stay due. A chunk that has started can still run long (429 sleeps, a slow
// Resend), which is what SEND_HARD_DEADLINE_MS is for; this check only decides
// whether another chunk is worth starting.
const SEND_START_DEADLINE_MS = 35_000;

// SEC-digest-double-send-1: past this much of the request, no Resend attempt, slot wait
// or 429 sleep starts (sendBatch's deadlineAt, the same instant for every chunk). A
// request already in flight is cut off by the 8 s fetch timeout, so the last send settles
// by about 53 s, inside maxDuration 60. The rows never attempted are `deferred`.
const SEND_HARD_DEADLINE_MS = 45_000;

// A subscriber is "due" once their last digest is at least this old: 5 days 18 hours.
// Far past the 24 h between the Saturday and Sunday ticks, so a Saturday stamp is never
// due on Sunday; and 6 h short of the 6 days from a Sunday tick to the next Saturday's,
// so a row Sunday mailed (a 429 retry, a deferred row, a subscriber confirmed after
// Saturday's tick) is due again that Saturday whatever the seconds of jitter between
// the two ticks' clock reads. Exactly 6 days made that a coin flip.
const RESEND_INTERVAL_MS = (6 * 24 - 6) * 60 * 60 * 1000;

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

function lastSentMs(row: Pick<SubscriberRow, "last_sent_at">): number {
  return row.last_sent_at ? new Date(row.last_sent_at).getTime() : 0;
}

// `result.error` (below) is Resend's raw HTTP response body, not a string
// we control — a validation error can echo the submitted `to` address back
// in its message. Strip anything email-shaped before it ever reaches
// `console.error` so a subscriber address can't leak through this path.
function redactEmails(s: string): string {
  return s.replace(/[^\s@"'<>()]+@[^\s@"'<>()]+/g, "[e-posta gizlendi]");
}

// h87-newsletter-1: a summary and its heading travel together. `summary` is the
// attribution's text ("" when the rights gate hid it) and `summaryLabel` is the
// cluster page's own `summaryLabel(attribution)`, never a string of this route's
// own. No text means no label, so a hidden excerpt leaves no orphan heading.
function summaryFields(
  attribution: SummaryAttribution | null,
): Pick<DigestClusterItem, "summary" | "summaryLabel"> {
  return {
    summary: attribution?.text ?? "",
    summaryLabel: attribution && attribution.text ? summaryLabel(attribution) : null,
  };
}

function toClusterItem(
  bundle: {
    cluster: { id: string; title_tr: string; bias_distribution: DigestClusterItem["biasDistribution"] };
    articles: unknown[];
  },
  attribution: SummaryAttribution | null,
): DigestClusterItem {
  return {
    id: bundle.cluster.id,
    title: bundle.cluster.title_tr,
    ...summaryFields(attribution),
    articleCount: bundle.articles.length,
    biasDistribution: bundle.cluster.bias_distribution,
  };
}

function toBlindspotItem(
  bundle: BlindspotBundle,
  attribution: SummaryAttribution | null,
): DigestBlindspotItem {
  return {
    id: bundle.cluster.id,
    title: bundle.cluster.title_tr,
    ...summaryFields(attribution),
    biasDistribution: bundle.cluster.bias_distribution,
    dominantZone: bundle.dominantZone,
    dominantPct: bundle.dominantPct,
    // h57-outbound-1: the same count /blindspots qualifies its chip with
    // (`bundle.sources` is already de-duplicated per source).
    nonVotingOutside: nonVotingOutsideZone(bundle.sources, bundle.dominantZone),
    // h108-sharesurfaces-1: the silent zones Jev's recall stage matched with this
    // event; the mail then says "Kümede sadece X", as /blindspots does. A bundle
    // cached before the field existed has none (`?.length ?? 0`, today's line).
    recallMatchedCount: bundle.recallMatchedZones?.length ?? 0,
  };
}

// BL-13 rights gate: clusters.summary_tr is the seed article's raw RSS
// description — one outlet's words, not Tayf's. rss.xml and the cluster
// detail page never render it verbatim; they run it through
// resolveSummaryAttribution's member-aware / degraded / fail-closed
// dispatch (see summary-attribution.ts). The digest email reuses the exact
// same pipeline instead of a third, ungated path — `membersByCluster` is
// looked up once per cron tick via getRssSummaryMembers, bounded to the
// clusters this email actually sends. `lookupFailed` must be threaded
// through: a missing `members` entry alone doesn't tell you whether that
// cluster has no attributable members (safe to degrade) or the whole
// lookup errored (must hide the excerpt, never render summary_tr raw).
function resolveSummary(
  bundle: { cluster: { id: string; summary_tr: string }; isWireRedistribution?: boolean },
  membersByCluster: Record<string, SummaryMember[]>,
  lookupFailed: boolean,
): SummaryAttribution | null {
  const summary = bundle.cluster.summary_tr;
  const wire = { isWireRedistribution: bundle.isWireRedistribution === true };
  const members = membersByCluster[bundle.cluster.id];
  return resolveSummaryAttribution({ summary, members, lookupFailed, wire });
}

// withCronOutcome is the outermost wrapper: each authenticated run is recorded in
// public.ops_cron_route_runs (ops_health_report row 15, migration 136).
export const GET = withCronOutcome("digest", withApiErrors(async (request: Request) => {
  // Next.js 16 cacheComponents prerenders GET handlers at build time;
  // `await connection()` defers `request.headers` access until an actual
  // request lands. See src/app/api/cron/headline/route.ts for the same
  // pattern + link.
  await connection();
  const handlerStartMs = Date.now();

  const auth = requireCronBearer(request);
  if (!auth.ok) {
    return auth.response;
  }

  const rl = digestLimit(clientKey(request));
  if (!rl.allowed) {
    return apiTooManyRequests(rl.retryAfterMs);
  }

  // Fail closed, same rule as the footer form and POST /api/newsletter: no
  // Resend key means no promise this route can keep, so it stops here —
  // before ever touching Supabase — rather than reporting a fake
  // {sent: 0, skipped: 0} that reads as "ran fine, nobody was due".
  if (!isMailConfigured()) {
    return NextResponse.json({
      skipped: true,
      reason: "RESEND_API_KEY not set",
      sent: 0,
    });
  }

  const supabase = createServerClient();

  // Confirmed subscribers only; the "due" window (RESEND_INTERVAL_MS) is applied
  // in JS below rather than a `.or()` PostgREST filter, keeping the query a
  // single trackable predicate.
  let subscriberRows: SubscriberRow[];
  try {
    ({ rows: subscriberRows } = await readAllPages(
      (from, to) =>
        supabase
          .from("newsletter_subscribers")
          .select("id, email, unsubscribe_token, last_sent_at")
          .not("confirmed_at", "is", null)
          // Unique per row, so a page boundary can neither skip nor repeat a subscriber.
          .order("id", { ascending: true })
          .range(from, to)
          .returns<SubscriberRow[]>(),
      { label: "digest subscribers", maxPages: SUBSCRIBER_MAX_PAGES },
    ));
  } catch (err) {
    // A failed page discards the earlier ones: a half-read list would mail some
    // subscribers and silently skip the rest. Same 500 path as a single-query error.
    return apiServerError(err);
  }

  const nowMs = Date.now();
  const due = subscriberRows.filter((row) => isDue(row, nowMs));
  // Never-sent first, then the longest wait (a stable sort, so ties keep the id
  // order the read gave). A tick that runs out of send time, or that Resend's rate
  // limit slows, leaves the end of this list unsent; the next tick must start
  // with exactly those rows, or the same first rows would be mailed every week
  // and the last ones never.
  due.sort((a, b) => lastSentMs(a) - lastSentMs(b));

  if (due.length === 0) {
    return NextResponse.json({ sent: 0, skipped: 0 });
  }

  // Fetch the digest content once — identical for every subscriber except
  // the per-subscriber unsubscribe link.
  // "batch": a weekly job must not abort at the 4 s user-facing reader cap
  // on a cold database -- the 8 s statement_timeout would have let it finish,
  // and a failed run means no mail until the Sunday retry tick, and none at all
  // if that one fails too until next Saturday.
  // h71-timebounds-1: the stories come from the trailing week itself
  // (first_published inside the last 7 days, biggest article_count first), not
  // from the home feed's pool of the most recently updated clusters, which
  // reaches back about 25 hours and could never hold Monday's story.
  const [weekClusters, blindspotResult] = await Promise.all([
    getWeeklyDigestClusters({ nowMs: Date.now(), profile: "batch" }),
    getBlindspots({ profile: "batch" }),
  ]);

  // Already ordered article_count desc, id asc by the reader: the route only cuts.
  const topClusterBundles = weekClusters.slice(0, TOP_CLUSTER_COUNT);

  const topBlindspotBundle = blindspotResult.bundles[0] ?? null;

  // BL-13: resolve the rights-gated attribution once, for exactly the
  // clusters this tick's email will render.
  const attributionClusterIds = topClusterBundles.map((b) => b.cluster.id);
  if (
    topBlindspotBundle &&
    topBlindspotBundle.cluster.summary_tr.trim().length > 0
  ) {
    attributionClusterIds.push(topBlindspotBundle.cluster.id);
  }
  const { members: membersByCluster, lookupFailed: memberLookupFailed } =
    await getRssSummaryMembers(attributionClusterIds, { profile: "batch" });
  // Swallowed database failures of this run (see SUB-STEP FAILURES above).
  let substepErrors = 0;
  if (memberLookupFailed) {
    // Fail closed: resolveSummary hides every excerpt, so the mail goes out without
    // summaries. That is a degraded run to report, not a reason to stop the send.
    console.warn("[digest-cron] summary member lookup failed; summaries are hidden");
    substepErrors++;
  }

  const topClusters = topClusterBundles.map((bundle) =>
    toClusterItem(bundle, resolveSummary(bundle, membersByCluster, memberLookupFailed)),
  );

  const topBlindspot = topBlindspotBundle
    ? toBlindspotItem(
        topBlindspotBundle,
        resolveSummary(topBlindspotBundle, membersByCluster, memberLookupFailed),
      )
    : null;

  const origin = siteUrl();

  function toEmail(row: SubscriberRow) {
    // Built once per row and reused for both the visible footer link
    // (buildDigestHtml) and the RFC 2369/8058 headers below, so the two
    // never drift apart. The link now lands on the confirm page (a GET
    // that renders a form) rather than unsubscribing outright — see
    // src/app/api/newsletter/unsubscribe/route.ts.
    const unsubscribeUrl = `${origin}/api/newsletter/unsubscribe?token=${encodeURIComponent(row.unsubscribe_token)}`;
    return {
      to: row.email,
      subject: DIGEST_SUBJECT,
      html: buildDigestHtml({
        clusters: topClusters,
        blindspot: topBlindspot,
        siteUrl: origin,
        unsubscribeUrl,
      }),
      // RFC 2369/8058: lets mail clients render a native "Unsubscribe"
      // action and lets providers send the POST directly (One-Click),
      // without a human ever loading the confirm page.
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    };
  }

  let sent = 0;
  let skipped = 0;
  // Due rows this tick did not attempt (see SEND_START_DEADLINE_MS, SEND_HARD_DEADLINE_MS).
  let deferred = 0;
  const sentAtIso = new Date(nowMs).toISOString();
  const hardDeadlineAt = handlerStartMs + SEND_HARD_DEADLINE_MS;

  // One row's outcome, applied as soon as its send resolves (sendBatch's onResult) so a
  // platform kill loses at most the sends in flight. The stamps are per-row `.eq("id", …)`
  // updates (same tradeoff as the headline cron): a failed write stays isolated to its own
  // subscriber instead of risking a bulk `.in()` update silently mismatching on a stale id.
  async function handleResult(row: SubscriberRow, result: SendEmailResult | undefined): Promise<void> {
    if (result && "deferred" in result) {
      // Never attempted: the deadline passed first. Nothing was sent, so there is
      // nothing to stamp and no failure to log; the row stays due.
      deferred++;
      return;
    }
    if (result && "ok" in result && result.ok) {
      sent++;
      // This write is the only record that stops the Sunday tick from mailing the
      // subscriber again, so a failed one gets one immediate retry before it counts
      // as a sub-step error.
      const stamp = () =>
        supabase
          .from("newsletter_subscribers")
          .update({ last_sent_at: sentAtIso })
          .eq("id", row.id);
      let { error: updateError } = await stamp();
      if (updateError) ({ error: updateError } = await stamp());
      if (updateError) {
        console.error("[digest-cron] last_sent_at update failed", row.id, updateError);
        captureServerException(
          new Error(redactEmails(updateError.message).slice(0, 300)),
          { subscriberId: row.id, code: updateError.code },
        );
        substepErrors++;
      }
      return;
    }
    // Missing API key (`skipped: true`) or a failed send (`ok: false`, which for a 429
    // means Resend's bounded retries were all rate limited too, and for a fetch abort
    // that it hit its 8 s timeout) both leave `last_sent_at` untouched: the subscriber
    // is still due on the Sunday retry tick (or, past it, next Saturday) instead of
    // silently losing a week.
    skipped++;
    if (result && "error" in result) {
      // Subscriber addresses must never reach Vercel function logs
      // (tests/guards/no-pii-logging.test.ts enforces this repo-wide).
      // `row.id` is a random uuid — an opaque identifier with no PII, and the same
      // key an operator needs to find the row for a DSAR. Do NOT hash it: hashing a
      // uuid adds no privacy and only breaks log <-> row correlation. `result.error`
      // is redacted (see `redactEmails` above) and capped because it's Resend's raw
      // response body — not under Tayf's control, and not guaranteed free of the
      // address that failed to send.
      const safeError = redactEmails(result.error).slice(0, 300);
      console.error("[digest-cron] send failed", row.id, safeError);
      captureServerException(new Error(safeError), {
        subscriberId: row.id,
      });
    }
  }

  // Chunked send (see SEND_CHUNK). Within a chunk each row is handled, stamped included,
  // the moment its own send resolves; the chunk loop itself only decides whether another
  // chunk may start.
  for (let start = 0; start < due.length; start += SEND_CHUNK) {
    if (Date.now() - handlerStartMs >= SEND_START_DEADLINE_MS) {
      // Adds to the rows a started chunk deferred at the hard deadline: not a reset.
      deferred += due.length - start;
      break;
    }
    const rows = due.slice(start, start + SEND_CHUNK);
    const handled = new Set<number>();
    const results = await sendBatch(rows.map(toEmail), 5, {
      deadlineAt: hardDeadlineAt,
      onResult: async (i, result) => {
        handled.add(i);
        await handleResult(rows[i]!, result);
      },
    });

    // The real sendBatch has reported every attempted item through onResult by now, so
    // this handles only what it skipped at the deadline before the item started. A
    // sendBatch that does not call onResult (a test double) gets every result handled here.
    for (let i = 0; i < rows.length; i++) {
      if (!handled.has(i)) await handleResult(rows[i]!, results[i]);
    }
  }

  if (skipped > 0) {
    console.warn("[digest-cron] send failures", { sent, skipped });
  }
  if (deferred > 0) {
    console.warn("[digest-cron] send budget spent; rows deferred to the next tick", { sent, deferred });
  }

  return NextResponse.json(
    { sent, skipped, substepErrors, ...(deferred > 0 ? { deferred } : {}) },
    substepErrorsInit(substepErrors),
  );
}));
