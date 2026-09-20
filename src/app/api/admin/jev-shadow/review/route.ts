/**
 * Admin-gated POST for a single Jev-shadow disagreement review.
 *
 * Shaped exactly like src/app/api/admin/corrections/[id]/route.ts's PATCH:
 * the admin session (src/lib/admin/session.ts, hasAdminSession) is the
 * only gate — there is no other authorization check in front of this
 * route, so it MUST run before rate limiting and before the request body
 * is ever read.
 *
 * Nothing this route touches is reader-facing: jev_shadow_reviews is
 * service_role-only (migration 061, RLS on, no policies) and the /admin
 * page that renders the disagreement queue is cookie-gated and dynamic
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
// corrections/[id]/route.ts): a 20-token bucket refilling at 0.2 tokens/sec.
const jevReviewLimit = createRateLimiter("admin-jev-shadow", {
  capacity: 20,
  refillPerSecond: 0.2,
});

const JEV_REVIEW_VERDICTS = ["jev", "baseline", "both", "neither", "unsure"] as const;
type JevReviewVerdict = (typeof JEV_REVIEW_VERDICTS)[number];

function isJevReviewVerdict(value: unknown): value is JevReviewVerdict {
  return (
    typeof value === "string" &&
    (JEV_REVIEW_VERDICTS as readonly string[]).includes(value)
  );
}

const NOTE_MAX_LENGTH = 500;

export const POST = withApiErrors(async (request: Request) => {
  if (!(await hasAdminSession())) {
    return apiUnauthorized();
  }

  const rl = jevReviewLimit(clientKey(request));
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

  const { prediction_id, verdict, note } = body as Record<string, unknown>;

  if (
    typeof prediction_id !== "number" ||
    !Number.isSafeInteger(prediction_id) ||
    prediction_id <= 0
  ) {
    return apiBadRequest("Invalid prediction id");
  }

  if (!isJevReviewVerdict(verdict)) {
    return apiBadRequest("Invalid verdict");
  }

  if (note !== undefined && typeof note !== "string") {
    return apiBadRequest("Invalid note");
  }
  const clampedNote = typeof note === "string" ? note.slice(0, NOTE_MAX_LENGTH) : null;

  const supabase = createServerClient();
  const { error } = await supabase
    .from("jev_shadow_reviews")
    .insert({
      prediction_id,
      verdict,
      reviewer: "admin",
      note: clampedNote,
    })
    .select("id")
    .maybeSingle();

  if (error) {
    // Postgres FK violation — the prediction row doesn't exist (e.g. it
    // was purged, or the id was never a valid prediction id).
    if (error.code === "23503") {
      return apiNotFound("Prediction not found");
    }
    return apiServerError(error);
  }

  return NextResponse.json({ ok: true }, { status: 200 });
});
