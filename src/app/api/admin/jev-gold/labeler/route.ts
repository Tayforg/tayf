/**
 * Admin-gated POST that sets the `jev_labeler` cookie — the 1/2 switch on
 * /admin/jev-altin. This is a UI convenience ONLY (shared contract,
 * section E): the cookie is not an authorization signal or an identity
 * claim, hasAdminSession() is still the only gate, and /api/admin/jev-gold/
 * label reads `labeler` from its request BODY, never from this cookie.
 *
 * Same gate ordering as every other admin mutation route: hasAdminSession()
 * first, then the rate limiter, then the body. This route touches no
 * database at all — it only validates and writes a cookie.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { apiBadRequest, apiError, apiUnauthorized, withApiErrors } from "@/lib/api/errors";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import { hasAdminSession } from "@/lib/admin/session";
import { isJevLabeler, JEV_LABELER_COOKIE, JEV_LABELER_COOKIE_MAX_AGE } from "@/lib/admin/jev-gold";

// Same shape as the other low-frequency admin mutation routes (e.g.
// corrections/[id]): a 20-token bucket refilling at 0.2 tokens/sec. This
// route is only hit once per labeler switch, not once per save.
const jevGoldLabelerLimit = createRateLimiter("admin-jev-gold-labeler", {
  capacity: 20,
  refillPerSecond: 0.2,
});

export const POST = withApiErrors(async (request: Request) => {
  if (!(await hasAdminSession())) {
    return apiUnauthorized();
  }

  const rl = jevGoldLabelerLimit(clientKey(request));
  if (!rl.allowed) {
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

  const { labeler } = body as Record<string, unknown>;
  if (!isJevLabeler(labeler)) {
    return apiBadRequest("Invalid labeler");
  }

  const store = await cookies();
  store.set(JEV_LABELER_COOKIE, String(labeler), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: JEV_LABELER_COOKIE_MAX_AGE,
  });

  return NextResponse.json({ ok: true, labeler }, { status: 200 });
});
