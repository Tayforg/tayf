import { NextResponse } from "next/server";

import {
  apiBadRequest,
  apiError,
  apiServerError,
  apiUnauthorized,
  withApiErrors,
} from "@/lib/api/errors";
import {
  generateApiKey,
  hashApiKey,
  isApiTier,
  normalizeKeyLabel,
} from "@/lib/api/keys";
import { hasAdminSession } from "@/lib/admin/session";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import { createServerClient } from "@/lib/supabase/server";

/**
 * POST /api/admin/api-keys — issue a new v1 API key.
 *
 * hasAdminSession() runs FIRST, before the rate limiter and before the
 * body is ever read (src/app/api/admin/corrections/[id]/route.ts is the
 * house template for this order). The plaintext key is generated here,
 * returned in the 201 body, and NEVER stored or logged again — only its
 * sha256 hash is written to `api_keys.key_hash`.
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

  const label = normalizeKeyLabel((body as Record<string, unknown>).label);
  if (label === null) {
    return apiBadRequest("Invalid label");
  }
  const tierRaw = (body as Record<string, unknown>).tier;
  if (!isApiTier(tierRaw)) {
    return apiBadRequest("Invalid tier");
  }
  const tier = tierRaw;

  const apiKey = generateApiKey();
  const keyHash = hashApiKey(apiKey);
  // Written explicitly (rather than relying on the row's DB default) so
  // the 201 body's created_at is guaranteed to match the row we just
  // wrote, with no second read required.
  const createdAt = new Date().toISOString();

  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("api_keys")
    .insert({ key_hash: keyHash, label, tier, created_at: createdAt })
    .select("id")
    .single();

  if (error) return apiServerError(error);

  // api_key is returned HERE AND NOWHERE ELSE, EVER — never logged, never
  // stored again, never re-derivable from the hash.
  return NextResponse.json(
    {
      ok: true,
      id: (data as { id: number | string }).id,
      api_key: apiKey,
      label,
      tier,
      created_at: createdAt,
    },
    { status: 201 },
  );
});
