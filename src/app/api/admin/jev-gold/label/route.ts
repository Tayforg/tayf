/**
 * Admin-gated POST that records (or corrects) one labeler's judgement on
 * one article of the Jev altın küme (migration 063).
 *
 * Shaped exactly like src/app/api/admin/jev-shadow/review/route.ts: the
 * admin session (src/lib/admin/session.ts, hasAdminSession) is the ONLY
 * gate — there is no other authorization check in front of this route, so
 * it MUST run before rate limiting and before the request body is ever
 * read. `labeler` is taken from the request BODY, never from the
 * `jev_labeler` cookie — that cookie is a UI convenience only, set by the
 * sibling /labeler route, and is never treated as an identity or
 * authorization signal here (shared contract, section E).
 *
 * Re-saving a label for the same (article_id, labeler) pair is expected —
 * a labeler correcting themselves mid-session — so this upserts on
 * (article_id, labeler) rather than inserting, and a re-save never 23505s.
 */
import { NextResponse } from "next/server";
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
import { isJevLabeler, isJevGoldTopic, JEV_GOLD_NOTE_MAX_LENGTH } from "@/lib/admin/jev-gold";

// A labeling session is hundreds of rapid saves (one per reviewed
// article), unlike the 20/0.2 buckets on the other admin mutation routes
// — a 12/min ceiling there would throttle the operator mid-session, so
// this bucket is deliberately much larger.
const jevGoldLabelLimit = createRateLimiter("admin-jev-gold-label", {
  capacity: 60,
  refillPerSecond: 1,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST = withApiErrors(async (request: Request) => {
  if (!(await hasAdminSession())) {
    return apiUnauthorized();
  }

  const rl = jevGoldLabelLimit(clientKey(request));
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

  const { article_id, labeler, is_politics, topic, note } = body as Record<string, unknown>;

  if (typeof article_id !== "string" || !UUID_RE.test(article_id)) {
    return apiBadRequest("Invalid article id");
  }
  if (!isJevLabeler(labeler)) {
    return apiBadRequest("Invalid labeler");
  }
  if (typeof is_politics !== "boolean") {
    return apiBadRequest("Invalid is_politics");
  }
  if (!isJevGoldTopic(topic)) {
    return apiBadRequest("Invalid topic");
  }
  if (note !== undefined && note !== null && (typeof note !== "string" || note.length > JEV_GOLD_NOTE_MAX_LENGTH)) {
    return apiBadRequest("Invalid note");
  }
  const clampedNote = typeof note === "string" ? note : null;

  const supabase = createServerClient();
  const { error } = await supabase
    .from("jev_gold_labels")
    .upsert(
      {
        article_id,
        labeler,
        is_politics,
        topic,
        note: clampedNote,
      },
      { onConflict: "article_id,labeler" },
    );

  if (error) {
    // Postgres FK violation — article_id doesn't exist in jev_gold_set
    // (e.g. it was never seeded, or the id was never a valid gold row).
    if (error.code === "23503") {
      return apiNotFound("Gold article not found");
    }
    return apiServerError(error);
  }

  return NextResponse.json({ ok: true }, { status: 200 });
});
