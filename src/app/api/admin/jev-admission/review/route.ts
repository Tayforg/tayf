/**
 * Admin-gated POST for a single Jev politics-admission review verdict
 * (migration 089, "ADMIT").
 *
 * Shaped exactly like src/app/api/admin/jev-shadow/review/route.ts: the
 * admin session (src/lib/admin/session.ts, hasAdminSession) is the only
 * gate — there is no other authorization check in front of this route, so
 * it MUST run before rate limiting and before the request body is ever
 * read.
 *
 * jev_politics_admissions is service_role-only (migration 089, RLS on, no
 * policies), and the /admin page that renders the review queue is
 * cookie-gated and dynamic (never cached), so there is no revalidateTag
 * here.
 */
import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import {
  apiBadRequest,
  apiNotFound,
  apiServerError,
  apiUnauthorized,
  apiError,
  withApiErrors,
} from "@/lib/api/errors";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import { hasAdminSession } from "@/lib/admin/session";
import { JEV_ADMISSION_VERDICTS, type JevAdmissionVerdict } from "@/lib/admin/jev-admission";

// Same shape as the other mutating admin routes: a 20-token bucket
// refilling at 0.2 tokens/sec.
const jevAdmissionReviewLimit = createRateLimiter("admin-jev-admission", {
  capacity: 20,
  refillPerSecond: 0.2,
});

const ARTICLE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isAdmissionVerdict(value: unknown): value is JevAdmissionVerdict {
  return typeof value === "string" && (JEV_ADMISSION_VERDICTS as readonly string[]).includes(value);
}

export const POST = withApiErrors(async (request: Request) => {
  if (!(await hasAdminSession())) {
    return apiUnauthorized();
  }

  const rl = jevAdmissionReviewLimit(clientKey(request));
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

  const { article_id, verdict } = body as Record<string, unknown>;

  if (typeof article_id !== "string" || !ARTICLE_ID_RE.test(article_id)) {
    return apiBadRequest("Invalid article id");
  }
  if (!isAdmissionVerdict(verdict)) {
    return apiBadRequest("Invalid verdict");
  }

  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("jev_politics_admissions")
    .update({ review_verdict: verdict, reviewed_at: new Date().toISOString() })
    .eq("article_id", article_id)
    .is("rolled_back_at", null)
    .select("article_id")
    .maybeSingle();

  if (error) {
    return apiServerError(error);
  }
  if (!data) {
    return apiNotFound("Admission claim not found");
  }

  return NextResponse.json({ ok: true }, { status: 200 });
});
