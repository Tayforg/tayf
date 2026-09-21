/**
 * Admin-gated POST that mints a self-serve Yelpaze report share link
 * (migration 069, B9). Same shape as
 * src/app/api/admin/corrections/[id]/route.ts: the admin session
 * (src/lib/admin/session.ts, hasAdminSession) is the only gate, so it MUST
 * run before rate limiting and before the request body is ever read.
 *
 * Shares one rate-limit bucket name ("admin-rapor-share") with
 * ./revoke/route.ts — the same pattern as the two /api/sources routes
 * sharing "sources-json" (src/lib/rate-limit.ts buckets are keyed by name,
 * so two `createRateLimiter` calls with the same name draw from the same
 * pool regardless of which module created them).
 *
 * NEVER log the returned token — see src/lib/reports/share.ts's header
 * comment for the full capability-URL posture.
 */
import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import {
  apiBadRequest,
  apiError,
  apiNotFound,
  apiServerError,
  apiUnauthorized,
  withApiErrors,
} from "@/lib/api/errors";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import { hasAdminSession } from "@/lib/admin/session";
import { createShareLink, normalizeShareDays, shareUrl } from "@/lib/reports/share";

const adminRaporShareLimit = createRateLimiter("admin-rapor-share", {
  capacity: 20,
  refillPerSecond: 0.2,
});

// Copied from src/app/api/admin/corrections/[id]/route.ts (not exported
// from there — that route is admin-only too, but keeping each route
// self-contained avoids a shared-file dependency across pack workers).
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  const clusterId = (body as Record<string, unknown>).cluster_id;
  if (typeof clusterId !== "string" || !UUID_RE.test(clusterId)) {
    return apiBadRequest("Invalid cluster_id");
  }

  const days = normalizeShareDays((body as Record<string, unknown>).days);
  if (days === null) {
    return apiBadRequest("Invalid days");
  }

  const supabase = createServerClient();

  const { data: cluster, error: clusterError } = await supabase
    .from("clusters")
    .select("id")
    .eq("id", clusterId)
    .maybeSingle();
  if (clusterError) {
    return apiServerError(clusterError);
  }
  if (!cluster) {
    return apiNotFound("Cluster not found");
  }

  const link = await createShareLink(supabase, clusterId, days);
  if (!link) {
    return apiServerError(new Error("createShareLink returned null"));
  }

  return NextResponse.json(
    {
      ok: true,
      token: link.token,
      url: shareUrl(link.token),
      expires_at: link.expires_at,
    },
    { status: 201 },
  );
});
