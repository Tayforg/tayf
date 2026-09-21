/**
 * Admin-gated POST that pokes the jev-shadow Edge Function in
 * mode: "regression" via the SECURITY DEFINER RPC
 * public.jev_regression_trigger() (migration 066, shared_contract §D2).
 *
 * jev_regression_trigger() is fire-and-forget: net.http_post returns a
 * pg_net request id immediately, and the real HTTP response lands later
 * in net._http_response (shared_contract, "ON-DEMAND TRIGGER IS
 * FIRE-AND-FORGET"). A non-null request_id means QUEUED, never SUCCEEDED
 * — that's why the button's Turkish copy says "tetiklendi" (triggered),
 * not "çalıştı" (ran).
 *
 * The RPC also returns null for three different, deliberately
 * indistinguishable reasons (pg_net absent, Vault secrets absent, a run
 * already in flight) — collapsing all three into a plain
 * `{ ok: true, request_id: null }` SUCCESS response (never an error
 * status) is intentional: the button must never leak infrastructure
 * state to the browser.
 *
 * Same gate ordering and rate-limit shape as
 * .../jev-regression/freeze/route.ts, with its own bucket: run spends
 * real gateway tokens once it lands, so a stray double-click matters.
 */
import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { apiError, apiServerError, apiUnauthorized, withApiErrors } from "@/lib/api/errors";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import { hasAdminSession } from "@/lib/admin/session";

const jevRegressionRunLimit = createRateLimiter("admin-jev-regression-run", {
  capacity: 3,
  refillPerSecond: 0.01,
});

/**
 * Contract D2's coercion rule, pure, module-private: null/undefined
 * stays null; otherwise Number(data), and a non-finite result is also
 * null (never NaN reaching JSON.stringify).
 */
function coerceRequestId(data: unknown): number | null {
  if (data === null || data === undefined) return null;
  const n = Number(data);
  return Number.isFinite(n) ? n : null;
}

export const POST = withApiErrors(async (request: Request) => {
  if (!(await hasAdminSession())) {
    return apiUnauthorized();
  }

  const rl = jevRegressionRunLimit(clientKey(request));
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
  const { data, error } = await supabase.rpc("jev_regression_trigger");

  if (error) {
    return apiServerError(error);
  }

  return NextResponse.json({ ok: true, request_id: coerceRequestId(data) }, { status: 200 });
});
