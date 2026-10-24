import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import {
  apiBadRequest,
  apiNotFound,
  apiTooManyRequests,
  apiServerError,
  withApiErrors,
} from "@/lib/api/errors";
import { checkDbThrottle, THROTTLE_POLICY } from "@/lib/api/db-throttle";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import { ZONE_META, zoneOf } from "@/lib/bias/config";
import type { BiasCategory, MediaDnaZone } from "@/types";

/**
 * POST /api/oyun — records one anonymous zone-guess from the /oyun game
 * (U-03: the first external inter-rater check on Tayf's 118 bias labels).
 *
 * THE CORE RULE: `correct` is computed SERVER-SIDE from the article's real
 * source bias (one `articles` select joining `sources(bias)`) and NEVER
 * trusted from the request body — a client that posts `correct: true`
 * alongside a wrong guess must still get `correct: false` recorded. A
 * `sourceId` that doesn't match the article's actual `source_id` is
 * rejected outright (400) rather than recorded against the wrong outlet,
 * since a mismatch means a tampered or stale client.
 *
 * No PII in the row: the `zone_guesses` insert (migration 057) carries only
 * (article_id, source_id, guessed_zone, correct) — no session id, ip, user
 * agent or any other identifier is read or stored there. No cookies are set.
 * The throttle below (migration 118) keeps a separate, short-lived record:
 * only an HMAC-SHA256 digest of the client key (the IP, never the
 * User-Agent), never the raw IP, in a table nobody but the throttle function
 * can read, swept after at most a day. Nothing links that digest to a guess.
 *
 * ABUSE BRAKES, outermost first:
 *   1. The in-memory limiter below (40 requests/hour per client, per
 *      instance): a cheap first filter. It is process-local, so on Vercel it
 *      bounds one instance, not the fleet, and rotating IPs defeats it.
 *   2. The DB throttle (src/lib/api/db-throttle.ts, migration 118): holds
 *      across every instance. 40 recorded guesses/hour per client and 3 per
 *      outlet per day per client. It fails OPEN (an unavailable throttle
 *      never blocks the game).
 * A guess over either DB limit is DROPPED SILENTLY: the response is
 * byte-identical to a recorded one, so a forger cannot tell it from a
 * success (and the honest player, who never reaches 3/outlet/day, is not
 * affected). Together with AGREEMENT_MIN_GUESSES (src/lib/game/agreement.ts)
 * this raises the cost of skewing an outlet's published "okur tahmini"; it
 * does not make it poison-proof, which is why n is always shown.
 *
 * The handler reads the request body, so Next treats it as dynamic; it is never part of any
 * static/prerender path so it's always evaluated per-request.
 */
// 40-token bucket refilling at 40/hour: roughly two full 10-round games
// plus slack. First filter only: process-local (see ABUSE BRAKES above); the
// fleet-wide cap is the DB throttle.
const oyunPostLimit = createRateLimiter("oyun-post", {
  capacity: 40,
  refillPerSecond: 40 / 3600,
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Derived from ZONE_META's keys (not a hand-written literal) so a future
// zone change can't drift the request validator out of sync with the app.
const VALID_ZONES = new Set(Object.keys(ZONE_META) as MediaDnaZone[]);

interface ArticleLookupRow {
  id: string;
  source_id: string;
  sources: { bias: BiasCategory } | null;
}

export const POST = withApiErrors(async (request: Request) => {
  const key = clientKey(request);
  const rl = oyunPostLimit(key);
  if (!rl.allowed) {
    // The client never reads this response (fire-and-forget `.catch(() =>
    // {})` in zone-guess-game.tsx), so a rejected guess is otherwise
    // invisible. Log only a boolean for whether the bucket resolved to the
    // shared "anon" fallback -- never the key itself, which would put a
    // reader identifier (an IP, per clientKey's resolution order) in the
    // logs and break this route's no-PII contract.
    console.warn("[oyun] guess rejected: rate limited", {
      retryAfterMs: rl.retryAfterMs,
      anonKey: key === "anon",
    });
    return apiTooManyRequests(rl.retryAfterMs);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiBadRequest("Invalid JSON body");
  }

  if (typeof body !== "object" || body === null) {
    return apiBadRequest("Invalid request body");
  }
  const b = body as Record<string, unknown>;

  const articleId = typeof b.articleId === "string" ? b.articleId.trim() : "";
  if (!UUID_RE.test(articleId)) {
    return apiBadRequest("Invalid articleId");
  }

  const sourceId = typeof b.sourceId === "string" ? b.sourceId.trim() : "";
  if (!UUID_RE.test(sourceId)) {
    return apiBadRequest("Invalid sourceId");
  }

  const guessedZoneRaw =
    typeof b.guessedZone === "string" ? b.guessedZone.trim() : "";
  if (!VALID_ZONES.has(guessedZoneRaw as MediaDnaZone)) {
    return apiBadRequest("Invalid guessedZone");
  }
  const guessedZone = guessedZoneRaw as MediaDnaZone;

  const supabase = createServerClient();

  const { data: article, error: selectError } = await supabase
    .from("articles")
    .select("id, source_id, sources(bias)")
    .eq("id", articleId)
    .returns<ArticleLookupRow[]>()
    .maybeSingle();

  if (selectError) {
    return apiServerError(selectError);
  }

  if (!article) {
    return apiNotFound("Article not found");
  }

  // A sourceId that doesn't match the article's real source_id means a
  // tampered or stale client — reject rather than record a guess against
  // the wrong outlet.
  if (article.source_id !== sourceId) {
    return apiBadRequest("sourceId does not match article");
  }

  const bias = article.sources?.bias;
  if (!bias) {
    // Data-integrity guard: every article.source_id is a not-null FK into
    // sources, so this should be unreachable in production. Fail loudly
    // (500) rather than silently recording a guess with no ground truth.
    return apiServerError(new Error(`article ${articleId} has no source bias`));
  }

  const zone = zoneOf(bias);
  const correct = zone === guessedZone;

  // Fleet-wide DB throttle (migration 118), sequential: the per-outlet check
  // is only spent when the per-client hourly bucket allowed. Both fail open.
  // A throttled guess skips the insert and still gets the normal 200 below.
  const hourly = await checkDbThrottle({
    ...THROTTLE_POLICY.oyunAll,
    clientKey: key,
  });
  let throttledBucket: string | null = hourly.allowed ? null : THROTTLE_POLICY.oyunAll.bucket;
  if (hourly.allowed) {
    const perOutlet = await checkDbThrottle({
      bucket: `${THROTTLE_POLICY.oyunSourcePrefix}${sourceId.toLowerCase()}`,
      clientKey: key,
      limit: THROTTLE_POLICY.oyunSourceLimit,
      windowSeconds: THROTTLE_POLICY.oyunSourceWindowSeconds,
    });
    if (!perOutlet.allowed) throttledBucket = "oyun:src";
  }

  if (throttledBucket !== null) {
    // Bucket PREFIX only: never the client key, its digest or the outlet id.
    console.warn("[oyun] guess not recorded: throttled", { bucket: throttledBucket });
  }

  const { error: insertError } =
    throttledBucket === null
      ? await supabase.from("zone_guesses").insert({
          article_id: articleId,
          source_id: sourceId,
          guessed_zone: guessedZone,
          correct,
        })
      : { error: null };

  if (insertError) {
    return apiServerError(insertError);
  }

  // Returning the truth is fine — the client already had it for the
  // reveal. What matters is that the DB row was computed from the DB, not
  // from the client's claim.
  return NextResponse.json(
    { ok: true, correct, zone },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
});
