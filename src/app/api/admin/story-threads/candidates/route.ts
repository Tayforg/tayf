/**
 * Admin-gated POST that approves or rejects one proposed story-thread pair
 * (migration 098). Same order as the other mutating admin routes: admin
 * session first (401 before the body is read), then the rate limit (429),
 * then JSON parsing (400).
 *
 * Approve goes through the SECURITY DEFINER rpc story_thread_approve_candidate,
 * which joins both clusters into one DRAFT thread under an advisory lock.
 * Nothing here can publish: publishing is a separate, explicit call to
 * /api/admin/story-threads/thread.
 */
import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
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

const candidatesLimit = createRateLimiter("admin-story-thread-candidates", {
  capacity: 60,
  refillPerSecond: 1,
});

export const POST = withApiErrors(async (request: Request) => {
  if (!(await hasAdminSession())) {
    return apiUnauthorized();
  }

  const rl = candidatesLimit(clientKey(request));
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
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return apiBadRequest("Invalid request body");
  }

  const { id, action } = body as Record<string, unknown>;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    return apiBadRequest("Invalid candidate id");
  }
  if (action !== "approve" && action !== "reject") {
    return apiBadRequest("Invalid action");
  }

  const supabase = createServerClient();

  if (action === "approve") {
    const { data, error } = await supabase.rpc("story_thread_approve_candidate", {
      p_candidate_id: id,
    });
    if (error) {
      const msg = String(error.message ?? "");
      if (msg.includes("not_pending")) return apiNotFound("Candidate not found");
      if (msg.includes("story_thread_conflict")) {
        return apiError(409, "Clusters belong to different threads");
      }
      return apiServerError(error);
    }
    revalidateTag("story-threads", "max");
    return NextResponse.json({ ok: true, threadId: data }, { status: 200 });
  }

  const { data, error } = await supabase
    .from("story_thread_candidates")
    .update({ status: "rejected", reviewed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (error) {
    return apiServerError(error);
  }
  if (data === null) {
    return apiNotFound("Candidate not found");
  }
  return NextResponse.json({ ok: true }, { status: 200 });
});
