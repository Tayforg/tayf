import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { apiBadRequest, apiError, apiServerError, withApiErrors } from "@/lib/api/errors";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import {
  FRAMING_SESSION_COOKIE,
  FRAMING_SESSION_MAX_AGE_SECONDS,
  hashSessionId,
  isFramingVote,
  newSessionId,
  normalizeTally,
  readSessionCookie,
} from "@/lib/game/framing";

/**
 * POST /api/oyun/cerceve — records one anonymous Çerçeve ("Framing") vote
 * (R10) and returns the crowd's tally for that headline.
 *
 * THE CORE RULE here mirrors /api/oyun's: the response body carries the
 * CROWD's tally and NEVER the model's own framing call — this route does
 * not, and must not, read the shadow-prediction table.
 *
 * Body is snake_case ({ article_id, vote }), DELIBERATELY different from
 * /api/oyun's camelCase body: the sibling GET (next/route.ts) returns
 * snake_case straight off the `framing_next_headline` RPC row, so this
 * route stays internally consistent with its own GET sibling rather than
 * matching a different feature's casing.
 *
 * Every 400 below fires BEFORE any Supabase call.
 */
const cercevePostLimit = createRateLimiter("oyun-cerceve-post", {
  capacity: 30,
  refillPerSecond: 0.5,
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every response, success or error, always carries Cache-Control: no-store
// (shared contract section 2). apiBadRequest/apiError/apiServerError don't
// set it themselves (src/lib/api/errors.ts is shared by every other route,
// out of this pack's file set), so every return in this handler is wrapped.
const noStore = (res: Response): Response => {
  res.headers.set("Cache-Control", "no-store");
  return res;
};

export const POST = withApiErrors(async (request: Request) => {
  const key = clientKey(request);
  const rl = cercevePostLimit(key);
  if (!rl.allowed) {
    console.warn("[oyun/cerceve] vote rejected: rate limited", {
      retryAfterMs: rl.retryAfterMs,
      anonKey: key === "anon",
    });
    return noStore(
      apiError(429, "Too many requests", {
        details: { retryAfterMs: rl.retryAfterMs },
      }),
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(apiBadRequest("Invalid JSON body"));
  }

  if (typeof body !== "object" || body === null) {
    return noStore(apiBadRequest("Invalid request body"));
  }
  const b = body as Record<string, unknown>;

  const articleId = typeof b.article_id === "string" ? b.article_id.trim() : "";
  if (!UUID_RE.test(articleId)) {
    return noStore(apiBadRequest("Invalid article_id"));
  }

  if (!isFramingVote(b.vote)) {
    return noStore(apiBadRequest("Invalid vote"));
  }
  const vote = b.vote;

  // A request that never carries a pre-existing `tayf_cerceve_sid` cookie
  // has no stable session identity yet — hashing a freshly minted id would
  // make `unique (article_id, session_hash)` a no-op (a fresh hash every
  // time never collides), so a vote is COUNTED only when the cookie already
  // existed. The legitimate client always calls GET .../cerceve/next first
  // (framing-game.tsx's drawHeadline), which mints the cookie, so no real
  // player loses a vote — only a cookie-less first hit is left uncounted,
  // and the cookie minted below makes the NEXT request from that client
  // count. `ok` reflects whether this specific request was recorded.
  const existingRaw = readSessionCookie(request);
  const raw = existingRaw ?? newSessionId();
  const minted = existingRaw === null;
  const sessionHash = await hashSessionId(raw);

  const supabase = createServerClient();

  if (!minted) {
    const { error: upsertError } = await supabase.from("framing_votes").upsert(
      { article_id: articleId, vote, session_hash: sessionHash },
      { onConflict: "article_id,session_hash", ignoreDuplicates: true },
    );

    if (upsertError) {
      // 23503 = foreign key violation: a well-formed but non-existent
      // article_id. That's a client mistake, not a server fault.
      if ((upsertError as { code?: string }).code === "23503") {
        return noStore(apiBadRequest("Invalid article_id"));
      }
      return noStore(apiServerError(upsertError));
    }
  }

  const { data, error: totalsError } = await supabase.rpc("framing_vote_totals", {
    p_article_id: articleId,
  });

  if (totalsError) {
    return noStore(apiServerError(totalsError));
  }

  const row = Array.isArray(data) ? data[0] : data;
  const totals = normalizeTally(row);

  const res = NextResponse.json(
    { ok: !minted, totals },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );

  if (minted) {
    res.cookies.set(FRAMING_SESSION_COOKIE, raw, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: FRAMING_SESSION_MAX_AGE_SECONDS,
      secure: process.env.NODE_ENV === "production",
    });
  }

  return noStore(res);
});
