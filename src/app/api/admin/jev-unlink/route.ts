/**
 * Admin-gated POST for one outlier-ejection queue decision (migration 064,
 * pack A, shared_contract §I).
 *
 * Shaped exactly like src/app/api/admin/jev-shadow/review/route.ts: the
 * admin session (src/lib/admin/session.ts, hasAdminSession) is the ONLY
 * gate in front of an RPC that mutates cluster membership — there is no
 * second authorization check, so hasAdminSession() MUST run before rate
 * limiting and before the request body is ever read. Asserted directly in
 * tests/api/admin-jev-unlink.test.ts with a Request whose `.json()` throws
 * unconditionally.
 *
 * "unlink" removes the article from its cluster via the SECURITY DEFINER
 * RPC public.cluster_unlink_article (src/lib/admin/jev-cluster.ts owns
 * every Supabase call this route makes) and revalidates every cached
 * surface that can show cluster membership: "clusters",
 * "clusters-politics" and `cluster-detail:<clusterId>`. "keep" only marks
 * the candidate row decided and revalidates nothing — nothing reader-
 * facing changed. Admin routes run in-process and revalidate directly via
 * next/cache; they never POST /api/revalidate, which exists for the Deno
 * Edge Function caller.
 */
import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
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
import { keepClusterArticle, unlinkClusterArticle } from "@/lib/admin/jev-cluster";

// Same shape as the other mutating admin routes (src/app/api/admin/
// corrections/[id]/route.ts, src/app/api/admin/jev-shadow/review/route.ts):
// a 20-token bucket refilling at 0.2 tokens/sec.
const adminJevUnlinkLimit = createRateLimiter("admin-jev-unlink", {
  capacity: 20,
  refillPerSecond: 0.2,
});

type JevUnlinkDecision = "unlink" | "keep";

function isJevUnlinkDecision(value: unknown): value is JevUnlinkDecision {
  return value === "unlink" || value === "keep";
}

export const POST = withApiErrors(async (request: Request) => {
  if (!(await hasAdminSession())) {
    return apiUnauthorized();
  }

  const rl = adminJevUnlinkLimit(clientKey(request));
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

  const { id, decision } = body as Record<string, unknown>;

  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    return apiBadRequest("Invalid candidate id");
  }

  if (!isJevUnlinkDecision(decision)) {
    return apiBadRequest("Invalid decision");
  }

  if (decision === "unlink") {
    const result = await unlinkClusterArticle(id);
    if (!result.ok) {
      if (result.reason === "not-found") {
        return apiNotFound("Candidate not found");
      }
      return apiServerError(new Error("jev-unlink: cluster_unlink_article failed"));
    }

    // Every cached surface that can show this cluster's membership.
    revalidateTag("clusters", "max");
    revalidateTag("clusters-politics", "max");
    revalidateTag(`cluster-detail:${result.clusterId}`, "max");

    return NextResponse.json(
      { ok: true, article_count: result.articleCount },
      { status: 200 },
    );
  }

  const result = await keepClusterArticle(id);
  if (!result.ok) {
    if (result.reason === "not-found") {
      return apiNotFound("Candidate not found");
    }
    return apiServerError(new Error("jev-unlink: keep failed"));
  }

  return NextResponse.json({ ok: true }, { status: 200 });
});
