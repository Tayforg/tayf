import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import {
  apiBadRequest,
  apiNotFound,
  apiError,
  apiServerError,
  withApiErrors,
} from "@/lib/api/errors";
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
 * No PII: the `zone_guesses` insert (migration 057) carries only
 * (article_id, source_id, guessed_zone, correct) — no session id, ip, user
 * agent or any other identifier is read or stored. No cookies are set.
 *
 * The handler reads the request body, so Next treats it as dynamic; it is never part of any
 * static/prerender path so it's always evaluated per-request.
 */
// 40-token bucket refilling at 40/hour: roughly two full 10-round games
// plus slack. NOTE: this limiter (src/lib/rate-limit.ts) is process-local,
// so on Vercel it bounds a single instance, not the fleet — acceptable for
// a game. The defence against a coordinated, distributed guessing effort
// skewing an outlet's score is publishing per-day counts alongside any
// aggregate figure, which is a later decision, not this limiter's job.
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
    return apiError(429, "Too many requests", {
      details: { retryAfterMs: rl.retryAfterMs },
    });
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

  const { error: insertError } = await supabase.from("zone_guesses").insert({
    article_id: articleId,
    source_id: sourceId,
    guessed_zone: guessedZone,
    correct,
  });

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
