/**
 * Admin-gated POST that revokes a Yelpaze report share link (migration
 * 069, B9). Same order as ./share/route.ts and the corrections template:
 * hasAdminSession() FIRST, then the rate limiter, then the body.
 *
 * Shares the "admin-rapor-share" bucket with ./share/route.ts.
 *
 * NEVER log the token — see src/lib/reports/share.ts's header comment.
 */
import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import {
  apiBadRequest,
  apiError,
  apiUnauthorized,
  withApiErrors,
} from "@/lib/api/errors";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import { hasAdminSession } from "@/lib/admin/session";
import { isShareToken, revokeShareLink } from "@/lib/reports/share";

const adminRaporShareLimit = createRateLimiter("admin-rapor-share", {
  capacity: 20,
  refillPerSecond: 0.2,
});

export const POST = withApiErrors(async (request: Request) => {
  if (!(await hasAdminSession())) {
    return apiUnauthorized();
  }

  const rl = adminRaporShareLimit(clientKey(request));
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

  const token = (body as Record<string, unknown>).token;
  if (!isShareToken(token)) {
    return apiBadRequest("Invalid token");
  }

  const supabase = createServerClient();
  const revoked = await revokeShareLink(supabase, token);

  return NextResponse.json({ ok: true, revoked }, { status: 200 });
});
