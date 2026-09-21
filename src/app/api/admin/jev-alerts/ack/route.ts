/**
 * Admin-gated POST that acknowledges one Jev-signals alert.
 *
 * Shaped exactly like src/app/api/admin/jev-shadow/review/route.ts: the
 * admin session (src/lib/admin/session.ts, hasAdminSession) is the only
 * gate in front of this route, so it MUST run before rate limiting and
 * before the request body is ever read -- there is no other authorization
 * check, and reading the body first would let an unauthenticated caller
 * spend server work (JSON parsing) before being turned away.
 *
 * jev_alerts is service_role-only (migration 065, RLS on, no policies) and
 * the /admin page that renders the alert list is cookie-gated and dynamic
 * (never cached), so there is no revalidateTag here.
 */
import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import {
  apiBadRequest,
  apiNotFound,
  apiError,
  apiServerError,
  apiUnauthorized,
  withApiErrors,
} from "@/lib/api/errors";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import { hasAdminSession } from "@/lib/admin/session";

// Same shape as the other mutating admin routes (src/app/api/admin/
// jev-shadow/review/route.ts): a 20-token bucket refilling at 0.2 tokens/sec.
const jevAlertsLimit = createRateLimiter("admin-jev-alerts", {
  capacity: 20,
  refillPerSecond: 0.2,
});

export const POST = withApiErrors(async (request: Request) => {
  if (!(await hasAdminSession())) {
    return apiUnauthorized();
  }

  const rl = jevAlertsLimit(clientKey(request));
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

  const { id } = body as Record<string, unknown>;

  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    return apiBadRequest("Invalid alert id");
  }

  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("jev_alerts")
    .update({ acknowledged_at: new Date().toISOString() })
    .eq("id", id)
    .is("acknowledged_at", null)
    .select("id")
    .maybeSingle();

  if (error) {
    return apiServerError(error);
  }
  if (data === null) {
    return apiNotFound("Alert not found");
  }

  return NextResponse.json({ ok: true }, { status: 200 });
});
