/**
 * Admin-gated POST that (re-)seeds the Jev altın küme
 * (public.jev_gold_seed(), migration 063). Idempotent: it tops each
 * category quota back up to the SQL function's own default rather than
 * duplicating rows, so the button is safe to press again.
 *
 * The request body is optional and ignored — the per-category count
 * (38) is the SQL default and the single source of truth, exactly like
 * jev_shadow_month_usage's cap default (see the shared contract, section C).
 *
 * Same gate ordering as every other admin mutation route: hasAdminSession()
 * first, then the rate limiter, then the body.
 */
import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { apiError, apiServerError, apiUnauthorized, withApiErrors } from "@/lib/api/errors";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import { hasAdminSession } from "@/lib/admin/session";

// Each call is a 30-day scan over jev_shadow_predictions, so this bucket
// is deliberately small: 3 tokens, refilling at 1 per ~100s.
const jevGoldSeedLimit = createRateLimiter("admin-jev-gold-seed", {
  capacity: 3,
  refillPerSecond: 0.01,
});

export const POST = withApiErrors(async (request: Request) => {
  if (!(await hasAdminSession())) {
    return apiUnauthorized();
  }

  const rl = jevGoldSeedLimit(clientKey(request));
  if (!rl.allowed) {
    return apiError(429, "Too many requests", {
      details: { retryAfterMs: rl.retryAfterMs },
    });
  }

  // Body is optional and ignored — swallow a malformed one rather than
  // 400ing, since nothing here is read from it.
  try {
    await request.json();
  } catch {
    // no-op: body optional and ignored
  }

  const supabase = createServerClient();
  const { data, error } = await supabase.rpc("jev_gold_seed");

  if (error) {
    return apiServerError(error);
  }

  return NextResponse.json({ ok: true, inserted: Number(data ?? 0) }, { status: 200 });
});
