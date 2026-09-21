import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { apiError, apiServerError, withApiErrors } from "@/lib/api/errors";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import { isGameEligibleTitle } from "@/lib/game/pii-filter";
import {
  FRAMING_SESSION_COOKIE,
  FRAMING_SESSION_MAX_AGE_SECONDS,
  hashSessionId,
  newSessionId,
  readSessionCookie,
} from "@/lib/game/framing";

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
 * COOKIE: `tayf_cerceve_sid` holds a random, opaque 32-hex id, minted here
 * only when absent or malformed. The raw value is never logged, never
 * returned in a body, and never reaches the database — only its sha256
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
    return noStore(
      apiError(429, "Too many requests", {
        details: { retryAfterMs: rl.retryAfterMs },
      }),
    );
  }

  const existingRaw = readSessionCookie(request);
  const raw = existingRaw ?? newSessionId();
  const minted = existingRaw === null;
  const sessionHash = await hashSessionId(raw);

  const supabase = createServerClient();

  let articleId: string | null = null;
  let title: string | null = null;

  for (let attempt = 0; attempt < MAX_DRAW_ATTEMPTS; attempt++) {
    const { data, error } = await supabase.rpc("framing_next_headline", {
      p_session_hash: sessionHash,
    });

    if (error) {
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
