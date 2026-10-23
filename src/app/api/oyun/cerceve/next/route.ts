import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import {
  apiError,
  apiServerError,
  apiTooManyRequests,
  withApiErrors,
} from "@/lib/api/errors";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import { isGameEligibleTitle } from "@/lib/game/pii-filter";
import {
  FRAMING_SESSION_COOKIE,
  FRAMING_SESSION_MAX_AGE_SECONDS,
  hashSessionId,
} from "@/lib/game/framing";
import { mintSignedSession, readSignedSessionCookie } from "@/lib/game/framing-session";

/**
 * GET /api/oyun/cerceve/next — draws one headline for the Çerçeve
 * ("Framing") mode (R10): outlet hidden, one political headline at a
 * time, drawn server-side via `framing_next_headline` (migration 068).
 *
 * WHY THE PII FILTER RUNS HERE, NOT IN SQL: `isGameEligibleTitle`
 * (pii-filter.ts) applies Turkish-locale-aware lowercasing plus a
 * diacritic-folded second pass, rules that cannot be faithfully
 * re-derived inside a SQL function without creating a second, drifting
 * copy of a rule whose failure mode is a KVKK problem. So this route
 * discards any RPC row the filter rejects and re-draws (up to 3 times)
 * rather than trusting the RPC's own candidate pool to already be clean.
 *
 * COOKIE: `tayf_cerceve_sid` is `<random 32-hex id>.<hmac>` (see
 * framing-session.ts), minted here only when absent, unsigned or failing
 * verification. The cookie is never logged, never returned in a body, and
 * never reaches the database — only the sha256 of the id part
 * (`hashSessionId`) is sent to `framing_next_headline`, so the one
 * identifier this route ever hands the RPC is a hash, never an IP, never
 * a raw cookie.
 */
const cerceveNextLimit = createRateLimiter("oyun-cerceve-next", {
  capacity: 60,
  refillPerSecond: 0.5,
});

interface CerceveHeadlineRow {
  article_id: string;
  title: string;
}

const MAX_DRAW_ATTEMPTS = 3;

/**
 * Wall-clock budget for the WHOLE draw, PII redraws included. The RPC reads
 * a small precomputed pool (migration 105) and normally answers in tens of
 * ms; on Supabase Micro compute a cold read can still stall until
 * PostgREST's 8 s statement_timeout. Failing at 3 s keeps the route well
 * under the client's 8 s fetch timeout (framing-game.tsx), so the client
 * gets a retryable 503 instead of aborting its own fetch.
 */
const DRAW_TIMEOUT_MS = 3000;
const RETRY_AFTER_SECONDS = 5;

/**
 * True for a draw that ran out of time rather than failed: Postgres'
 * `57014` (query_canceled, i.e. statement_timeout), or the abort of our own
 * `AbortSignal.timeout` deadline. postgrest-js surfaces an aborted fetch as
 * `error.message = "AbortError: ..."` / `"TimeoutError: ..."` with
 * `code: ""`; a rejection carries the same text in `message`/`name`.
 */
function isDrawTimeout(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const err = e as { code?: unknown; message?: unknown; name?: unknown };
  if (err.code === "57014") return true;
  const abortLike = /\b(AbortError|TimeoutError)\b|abort/i;
  return (
    (typeof err.message === "string" && abortLike.test(err.message)) ||
    (typeof err.name === "string" && abortLike.test(err.name))
  );
}

// Every response, success or error, always carries Cache-Control: no-store
// (shared contract section 2). apiError/apiServerError don't set it
// themselves (src/lib/api/errors.ts is shared by every other route, out of
// this pack's file set), so every return in this handler is wrapped.
const noStore = (res: Response): Response => {
  res.headers.set("Cache-Control", "no-store");
  return res;
};

export const GET = withApiErrors(async (request: Request) => {
  const key = clientKey(request);
  const rl = cerceveNextLimit(key);
  if (!rl.allowed) {
    console.warn("[oyun/cerceve] draw rejected: rate limited", {
      retryAfterMs: rl.retryAfterMs,
      anonKey: key === "anon",
    });
    return noStore(apiTooManyRequests(rl.retryAfterMs));
  }

  let sessionId = await readSignedSessionCookie(request);
  let freshCookieValue: string | null = null;
  if (sessionId === null) {
    const fresh = await mintSignedSession();
    sessionId = fresh.id;
    freshCookieValue = fresh.cookieValue;
  }
  const sessionHash = await hashSessionId(sessionId);

  const supabase = createServerClient();

  let articleId: string | null = null;
  let title: string | null = null;

  // One deadline for the whole draw loop, so PII redraws share the budget
  // instead of each getting a fresh 3 s.
  const deadline = AbortSignal.timeout(DRAW_TIMEOUT_MS);

  for (let attempt = 0; attempt < MAX_DRAW_ATTEMPTS; attempt++) {
    let data: unknown;
    let error: unknown;
    try {
      ({ data, error } = await supabase
        .rpc("framing_next_headline", { p_session_hash: sessionHash })
        .abortSignal(deadline));
    } catch (e) {
      data = null;
      error = e;
    }

    if (error) {
      if (isDrawTimeout(error)) {
        // Never log the session hash, the raw cookie or the title.
        console.warn("[oyun/cerceve] draw timed out", {
          code: (error as { code?: unknown }).code ?? null,
        });
        // Retryable, not an application error. No cookie is set: the client
        // retries with the same (or no) cookie and mints on success.
        const res = noStore(
          apiError(503, "Service unavailable", {
            details: { retryAfterMs: RETRY_AFTER_SECONDS * 1000 },
          }),
        );
        res.headers.set("Retry-After", String(RETRY_AFTER_SECONDS));
        return res;
      }
      return noStore(apiServerError(error));
    }

    const row = (Array.isArray(data) ? data[0] : data) as
      | CerceveHeadlineRow
      | null
      | undefined;

    if (!row) {
      // Nothing eligible left to draw — stop immediately rather than
      // burning the remaining attempts.
      break;
    }

    if (!isGameEligibleTitle(row.title)) {
      // Discard and redraw. Never log the rejected title.
      continue;
    }

    articleId = row.article_id;
    title = row.title;
    break;
  }

  const res = NextResponse.json(
    { article_id: articleId, title },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );

  if (freshCookieValue !== null) {
    res.cookies.set(FRAMING_SESSION_COOKIE, freshCookieValue, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: FRAMING_SESSION_MAX_AGE_SECONDS,
      secure: process.env.NODE_ENV === "production",
    });
  }

  return noStore(res);
});
