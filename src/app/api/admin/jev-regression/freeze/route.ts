/**
 * Admin-gated POST that idempotently tops up the frozen Jev regression set
 * (public.jev_regression_freeze(), migration 066, shared_contract §D1).
 *
 * Copied structure from src/app/api/admin/jev-gold/seed/route.ts: the
 * request body is optional and ignored — the per-kind size (400
 * articles / 100 pairs) is the SQL default and the single source of
 * truth, so the RPC is called with NO arguments.
 *
 * Same gate ordering as every other admin mutation route: hasAdminSession()
 * first, then the rate limiter, then the body.
 *
 * This bucket is deliberately small: freeze is a 30-day-ish scan under
 * PostgREST's 8s statement_timeout (shared_contract, "FREEZE RPC UNDER
 * THE 8s POSTGREST TIMEOUT"), so 3 tokens refilling at 1 per ~100s keeps
 * an impatient double-click from stacking concurrent scans.
 */
import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { apiError, apiServerError, apiUnauthorized, withApiErrors } from "@/lib/api/errors";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import { hasAdminSession } from "@/lib/admin/session";

const jevRegressionFreezeLimit = createRateLimiter("admin-jev-regression-freeze", {
  capacity: 3,
  refillPerSecond: 0.01,
});

interface JevRegressionFreezeRow {
  articles_inserted?: unknown;
  pairs_inserted?: unknown;
}

export const POST = withApiErrors(async (request: Request) => {
  if (!(await hasAdminSession())) {
    return apiUnauthorized();
  }

  const rl = jevRegressionFreezeLimit(clientKey(request));
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
  const { data, error } = await supabase.rpc("jev_regression_freeze");

  if (error) {
    return apiServerError(error);
  }

  // The RPC returns a TABLE, so PostgREST yields a one-row array.
  const row = (Array.isArray(data) ? data[0] : data) as JevRegressionFreezeRow | null | undefined;

  return NextResponse.json(
    {
      ok: true,
      articles: Number(row?.articles_inserted ?? 0),
      pairs: Number(row?.pairs_inserted ?? 0),
    },
    { status: 200 },
  );
});
