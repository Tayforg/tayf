/**
 * Admin-gated POST for the bulk "Kalsın" decision (migration 075).
 *
 * Mirrors src/app/api/admin/jev-unlink/route.ts's gate order: hasAdminSession()
 * is the ONLY gate in front of a write, so it MUST run before rate limiting
 * and before the request body is ever read. Asserted directly in
 * tests/api/admin-jev-unlink-bulk.test.ts with a Request whose `.json()`
 * throws unconditionally.
 *
 * Bulk unlink is deliberately unsupported here — the only accepted
 * `decision` is "keep". src/lib/admin/jev-cluster.ts's keepClusterArticles
 * enforces the band 'review' restriction server-side (`.eq("band", "review")`
 * in the update itself, not just in the UI), so even a forged id list for a
 * 'likely_unlink' row cannot be bulk-kept. No RPC call, no revalidateTag —
 * nothing reader-facing changes when a candidate is marked kept.
 */
import { NextResponse } from "next/server";
import { apiBadRequest, apiError, apiServerError, apiUnauthorized, withApiErrors } from "@/lib/api/errors";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import { hasAdminSession } from "@/lib/admin/session";
import { keepClusterArticles } from "@/lib/admin/jev-cluster";
import { parseBulkKeepIds } from "@/lib/admin/jev-unlink-triage";

// Deliberately tighter than the single-decision route's 20/0.2 bucket — a
// bulk request can touch up to JEV_UNLINK_BULK_MAX (50) rows at once.
const adminJevUnlinkBulkLimit = createRateLimiter("admin-jev-unlink-bulk", {
  capacity: 10,
  refillPerSecond: 0.1,
});

export const POST = withApiErrors(async (request: Request) => {
  if (!(await hasAdminSession())) {
    return apiUnauthorized();
  }

  const rl = adminJevUnlinkBulkLimit(clientKey(request));
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

  const { ids, decision } = body as Record<string, unknown>;

  if (decision !== "keep") {
    return apiBadRequest("Invalid decision");
  }

  const parsedIds = parseBulkKeepIds(ids);
  if (parsedIds === null) {
    return apiBadRequest("Invalid ids");
  }

  const result = await keepClusterArticles(parsedIds);
  if (!result.ok) {
    return apiServerError(new Error("jev-unlink/bulk: keepClusterArticles failed"));
  }

  return NextResponse.json(
    { ok: true, kept: result.kept, skipped: result.skipped },
    { status: 200 },
  );
});
