import { NextResponse } from "next/server";

import {
  apiBadRequest,
  apiError,
  apiNotFound,
  apiServerError,
  apiUnauthorized,
  withApiErrors,
} from "@/lib/api/errors";
import { hasAdminSession } from "@/lib/admin/session";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import { createServerClient } from "@/lib/supabase/server";

/**
 * POST /api/admin/api-keys/revoke — revoke one v1 API key.
 *
 * Same order and the SAME named bucket as POST /api/admin/api-keys
 * (`createRateLimiter` keys its internal map by name+client, so two
 * modules calling `createRateLimiter("admin-api-keys", ...)` share one
 * limiter, exactly like the create route above).
 */
const adminApiKeysLimit = createRateLimiter("admin-api-keys", {
  capacity: 20,
  refillPerSecond: 0.2,
});

export const POST = withApiErrors(async (request: Request) => {
  if (!(await hasAdminSession())) {
    return apiUnauthorized();
  }

  const rl = adminApiKeysLimit(clientKey(request));
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

  const rawId = (body as Record<string, unknown>).id;
  if (typeof rawId !== "number" || !Number.isInteger(rawId)) {
    return apiBadRequest("Invalid id");
  }

  // Computed app-side (not read back from the DB round trip) — same
  // discipline as the create route's created_at, and matches
  // src/app/api/admin/corrections/[id]/route.ts's PATCH handler, which
  // echoes the LOCALLY validated value rather than the fixture/DB's
  // returned row.
  const revokedAt = new Date().toISOString();

  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("api_keys")
    .update({ revoked_at: revokedAt })
    .eq("id", rawId)
    .is("revoked_at", null)
    .select("id")
    .maybeSingle();

  if (error) return apiServerError(error);
  if (!data) return apiNotFound("API key not found");

  return NextResponse.json(
    { ok: true, id: rawId, revoked_at: revokedAt },
    { status: 200 },
  );
});
