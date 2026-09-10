/**
 * Admin-gated PATCH/DELETE for a single correction row.
 *
 * This is the DSAR/erasure tool for reader-filed corrections
 * (see supabase/migrations/042_corrections_status.sql for the
 * status vocabulary and the nightly purge job it schedules): an operator
 * moves a bildirim through open -> reviewed/dismissed, or deletes it
 * outright when a reader asks for their submission to be removed. The
 * admin session (src/lib/admin/session.ts:150, hasAdminSession) is the
 * only gate — there is no other authorization check in front of this
 * route, so it MUST run before rate limiting and before the request body
 * is ever read.
 *
 * PRIVACY: a correction row can carry a reader's email and free-text
 * message. Neither this route nor anything it calls may emit either
 * value — no console.* call of any kind lives in this file, and no
 * response body, error detail, or log line below includes `email` or
 * `message`. Success responses only ever echo back `id`/`status`, which
 * this route already validated against a fixed allow-list.
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
import { isCorrectionStatus } from "@/lib/corrections/status";

// Same shape as the other mutating admin routes (src/app/api/admin/
// route.ts): a 20-token bucket refilling at 0.2 tokens/sec.
const adminCorrectionsLimit = createRateLimiter("admin-corrections", {
  capacity: 20,
  refillPerSecond: 0.2,
});

// Copied from src/app/api/corrections/route.ts (not exported from there —
// that route owns the public-facing POST, this one is admin-only).
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const PATCH = withApiErrors(
  async (request: Request, ctx: RouteContext) => {
    if (!(await hasAdminSession())) {
      return apiUnauthorized();
    }

    const rl = adminCorrectionsLimit(clientKey(request));
    if (!rl.allowed) {
      return apiError(429, "Too many requests", {
        details: { retryAfterMs: rl.retryAfterMs },
      });
    }

    const { id } = await ctx.params;
    if (!UUID_RE.test(id)) {
      return apiBadRequest("Invalid correction id");
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

    const status = (body as Record<string, unknown>).status;
    if (!isCorrectionStatus(status)) {
      return apiBadRequest("Invalid status");
    }

    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("corrections")
      .update({
        status,
        reviewed_at: status === "open" ? null : new Date().toISOString(),
      })
      .eq("id", id)
      .select("id")
      .maybeSingle();

    if (error) {
      return apiServerError(error);
    }
    if (data === null) {
      return apiNotFound("Correction not found");
    }

    return NextResponse.json({ ok: true, status }, { status: 200 });
  },
);

export const DELETE = withApiErrors(
  async (request: Request, ctx: RouteContext) => {
    if (!(await hasAdminSession())) {
      return apiUnauthorized();
    }

    const rl = adminCorrectionsLimit(clientKey(request));
    if (!rl.allowed) {
      return apiError(429, "Too many requests", {
        details: { retryAfterMs: rl.retryAfterMs },
      });
    }

    const { id } = await ctx.params;
    if (!UUID_RE.test(id)) {
      return apiBadRequest("Invalid correction id");
    }

    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("corrections")
      .delete()
      .eq("id", id)
      .select("id")
      .maybeSingle();

    if (error) {
      return apiServerError(error);
    }
    if (data === null) {
      return apiNotFound("Correction not found");
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  },
);
