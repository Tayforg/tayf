import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { checkDbThrottle, THROTTLE_POLICY } from "@/lib/api/db-throttle";
import {
  apiBadRequest,
  apiServerError,
  apiTooManyRequests,
  withApiErrors,
} from "@/lib/api/errors";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import {
  FRAMING_SESSION_COOKIE,
  FRAMING_SESSION_MAX_AGE_SECONDS,
  hashSessionId,
  isFramingVote,
  normalizeTally,
} from "@/lib/game/framing";
import { mintSignedSession, readSignedSessionCookie } from "@/lib/game/framing-session";

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
 * Every 400 below fires BEFORE any Supabase call, and so does the in-memory
 * limiter. The fleet-wide DB throttles (migration 118's api_throttle, see
 * THROTTLE_POLICY in src/lib/api/db-throttle.ts) run right AFTER validation,
 * so a malformed request never spends a database round-trip: `cerceve:vote`
 * then `cerceve:art:<article>` (per headline) for a request that carries a
 * verified session, `cerceve:mint` for one that would mint a new session. All
 * fail OPEN (a throttle outage never takes the game down).
 *
 * The in-memory burst limiter is the ONLY 429 of this route. A full DB bucket
 * skips the write and answers the normal 200 `{ ok: false, totals }`: the
 * crowd tally is the game's payoff, a 429 would drop it for every honest
 * player behind a shared address, and it would tell a script exactly when to
 * switch IP (the same stance as /api/oyun and the /api/corrections honeypot).
 */
const cercevePostLimit = createRateLimiter("oyun-cerceve-post", {
  capacity: 30,
  refillPerSecond: 0.5,
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every response, success or error, always carries Cache-Control: no-store
// (shared contract section 2). apiBadRequest/apiServerError don't set it
// themselves (src/lib/api/errors.ts is shared by every other route, out of
// this pack's file set), so every return in this handler is wrapped.
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
    return noStore(apiTooManyRequests(rl.retryAfterMs));
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

  // A vote is COUNTED only when the request carries a `tayf_cerceve_sid`
  // cookie this server SIGNED (framing-session.ts). A request without one
  // has no trustworthy session identity: hashing a freshly minted id would
  // make `unique (article_id, session_hash)` a no-op (a fresh hash every
  // time never collides), and trusting a client-chosen id would let anyone
  // pick a new hash per vote. So an absent, unsigned (legacy or forged),
  // tampered or foreign-signed cookie is replaced by a freshly minted signed
  // one and the vote is left uncounted. The legitimate client always calls
  // GET .../cerceve/next first (framing-game.tsx's drawHeadline), which
  // mints the cookie, so no real player loses a vote; the cookie minted
  // below makes the NEXT request from that client count. `ok` reflects
  // whether this specific request was recorded.
  //
  // Signing alone does not stop a client that simply discards its cookie and
  // takes a new one per vote, so both branches are capped per client by the
  // DB throttle: NEW sessions (`cerceve:mint`) and counted votes
  // (`cerceve:vote` overall, `cerceve:art:<article>` per headline, sequential
  // like /api/oyun so the per-headline check is spent only when the hourly one
  // allowed). A throttled mint is not an error: the tally is still returned,
  // but no cookie is issued and the vote stays uncounted. A throttled vote is
  // not an error either: the upsert is skipped and the tally is still revealed.
  const verifiedId = await readSignedSessionCookie(request);
  let fresh: Awaited<ReturnType<typeof mintSignedSession>> | null = null;
  let recordVote = false;

  if (verifiedId !== null) {
    const hourly = await checkDbThrottle({ ...THROTTLE_POLICY.cerceveVote, clientKey: key });
    let throttledBucket: string | null = hourly.allowed ? null : THROTTLE_POLICY.cerceveVote.bucket;
    if (hourly.allowed) {
      const perHeadline = await checkDbThrottle({
        bucket: `${THROTTLE_POLICY.cerceveArticlePrefix}${articleId.toLowerCase()}`,
        clientKey: key,
        limit: THROTTLE_POLICY.cerceveArticleLimit,
        windowSeconds: THROTTLE_POLICY.cerceveArticleWindowSeconds,
      });
      if (!perHeadline.allowed) throttledBucket = "cerceve:art";
    }
    if (throttledBucket === null) {
      recordVote = true;
    } else {
      // Bucket PREFIX only: never the client key, its digest or the article id.
      console.warn("[oyun/cerceve] vote not recorded: throttled", { bucket: throttledBucket });
    }
  } else {
    const t = await checkDbThrottle({ ...THROTTLE_POLICY.cerceveMint, clientKey: key });
    if (t.allowed) fresh = await mintSignedSession();
  }

  const supabase = createServerClient();

  if (verifiedId !== null && recordVote) {
    const sessionHash = await hashSessionId(verifiedId);
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
    { ok: recordVote, totals },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );

  if (fresh !== null) {
    res.cookies.set(FRAMING_SESSION_COOKIE, fresh.cookieValue, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: FRAMING_SESSION_MAX_AGE_SECONDS,
      secure: process.env.NODE_ENV === "production",
    });
  }

  return noStore(res);
});
