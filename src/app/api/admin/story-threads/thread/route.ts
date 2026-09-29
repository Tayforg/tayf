/**
 * Admin-gated POST that edits one story thread (migration 098): rename,
 * publish, unpublish, remove a member cluster. Same gate order as the other
 * mutating admin routes (401 before the body, then 429, then 400).
 *
 * Publishing is only ever done here, by an admin: it needs a valid title and
 * at least STORY_THREAD_MIN_PUBLISH_MEMBERS member clusters. The slug is
 * generated once and never changes afterwards (published URLs stay stable
 * across unpublish/republish and renames). Every mutation revalidates the
 * "story-threads" cache tag.
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
import {
  STORY_THREAD_MIN_PUBLISH_MEMBERS,
  threadSlug,
  validateThreadTitle,
} from "@/lib/story-threads/config";

const threadLimit = createRateLimiter("admin-story-threads", {
  capacity: 60,
  refillPerSecond: 1,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS = ["rename", "publish", "unpublish", "remove_member"] as const;
type Action = (typeof ACTIONS)[number];

interface ThreadRow {
  id: string;
  slug: string | null;
  title_tr: string | null;
  status: string;
  published_at: string | null;
}

export const POST = withApiErrors(async (request: Request) => {
  if (!(await hasAdminSession())) {
    return apiUnauthorized();
  }

  const rl = threadLimit(clientKey(request));
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

  const { threadId, action, title, clusterId } = body as Record<string, unknown>;
  if (typeof threadId !== "string" || !UUID_RE.test(threadId)) {
    return apiBadRequest("Invalid thread id");
  }
  if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action)) {
    return apiBadRequest("Invalid action");
  }
  const act = action as Action;

  let newTitle: string | null = null;
  if (act === "rename") {
    newTitle = validateThreadTitle(title);
    if (newTitle === null) return apiBadRequest("Invalid title");
  }
  if (act === "remove_member" && (typeof clusterId !== "string" || !UUID_RE.test(clusterId))) {
    return apiBadRequest("Invalid cluster id");
  }

  const supabase = createServerClient();

  const { data: raw, error: loadErr } = await supabase
    .from("story_threads")
    .select("id, slug, title_tr, status, published_at")
    .eq("id", threadId)
    .maybeSingle();
  if (loadErr) return apiServerError(loadErr);
  if (!raw) return apiNotFound("Thread not found");
  const thread = raw as unknown as ThreadRow;

  const now = new Date().toISOString();

  if (act === "rename") {
    const { error } = await supabase
      .from("story_threads")
      .update({ title_tr: newTitle, updated_at: now })
      .eq("id", threadId);
    if (error) return apiServerError(error);
  } else if (act === "publish") {
    const currentTitle = typeof thread.title_tr === "string" ? thread.title_tr.trim() : "";
    if (currentTitle === "") return apiError(409, "Thread needs a title");

    const { data: mem, error: memErr } = await supabase
      .from("story_thread_members")
      .select("cluster_id")
      .eq("thread_id", threadId)
      .limit(100);
    if (memErr) return apiServerError(memErr);
    if ((Array.isArray(mem) ? mem.length : 0) < STORY_THREAD_MIN_PUBLISH_MEMBERS) {
      return apiError(409, "Thread needs at least 3 clusters");
    }

    const { error } = await supabase
      .from("story_threads")
      .update({
        status: "published",
        slug: thread.slug ?? threadSlug(currentTitle, threadId),
        published_at: thread.published_at ?? now,
        updated_at: now,
      })
      .eq("id", threadId);
    if (error) {
      if ((error as { code?: string }).code === "23505") {
        return apiError(409, "Slug already taken");
      }
      return apiServerError(error);
    }
  } else if (act === "unpublish") {
    const { error } = await supabase
      .from("story_threads")
      .update({ status: "draft", updated_at: now })
      .eq("id", threadId);
    if (error) return apiServerError(error);
  } else {
    if (thread.status === "published") {
      return apiError(409, "Unpublish the thread before removing clusters");
    }
    const { error } = await supabase
      .from("story_thread_members")
      .delete()
      .eq("thread_id", threadId)
      .eq("cluster_id", clusterId as string);
    if (error) return apiServerError(error);
  }

  revalidateTag("story-threads", "max");
  return NextResponse.json({ ok: true }, { status: 200 });
});
