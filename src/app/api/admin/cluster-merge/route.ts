/**
 * Admin-gated POST for the /admin/birlestir merge queue (migration 099).
 * Same order as the other mutating admin routes: admin session first (401
 * before the body is read), then the rate limit (429), then JSON parsing and
 * validation (400).
 *
 * action "merge" runs src/lib/clusters/merge.ts (the SECURITY DEFINER rpc under
 * the per-cluster advisory lock) and revalidates every tag it reports.
 * action "dismiss" records "Farklı hikaye" in cluster_merge_dismissals only. It
 * NEVER touches story_thread_candidates.status: a pair can be different events
 * and still a valid thread development.
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
import { mergeClusters, mergeRevalidationTags } from "@/lib/clusters/merge";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const clusterMergeLimit = createRateLimiter("admin-cluster-merge", {
  capacity: 20,
  refillPerSecond: 0.2,
});

const ACTOR = "admin";

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export const POST = withApiErrors(async (request: Request) => {
  if (!(await hasAdminSession())) {
    return apiUnauthorized();
  }

  const rl = clusterMergeLimit(clientKey(request));
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

  const b = body as Record<string, unknown>;
  if (b.action !== "merge" && b.action !== "dismiss") {
    return apiBadRequest("Invalid action");
  }

  if (b.action === "merge") {
    if (!isUuid(b.source) || !isUuid(b.target)) return apiBadRequest("Invalid cluster id");
    const source = b.source.toLowerCase();
    const target = b.target.toLowerCase();
    if (source === target) return apiBadRequest("Source and target must differ");
    const origin = b.origin;
    if (origin !== "manual" && origin !== "thread" && origin !== "recall") {
      return apiBadRequest("Invalid origin");
    }

    const result = await mergeClusters({ source, target, actor: ACTOR, origin });
    if (!result.ok) {
      switch (result.reason) {
        case "invalid":
          return apiBadRequest("Invalid merge");
        case "not-found":
          return apiNotFound("Cluster not found");
        case "conflict":
          return apiError(409, "Cluster already merged or archived");
        default:
          return apiError(500, "Merge failed");
      }
    }

    for (const tag of mergeRevalidationTags(source, target)) {
      revalidateTag(tag, "max");
    }
    return NextResponse.json(
      {
        ok: true,
        target,
        moved: result.outcome.moved,
        target_count_after: result.outcome.targetCountAfter,
      },
      { status: 200 },
    );
  }

  if (!isUuid(b.a) || !isUuid(b.b)) return apiBadRequest("Invalid cluster id");
  const x = b.a.toLowerCase();
  const y = b.b.toLowerCase();
  if (x === y) return apiBadRequest("Clusters must differ");
  if (b.origin !== "thread" && b.origin !== "recall") {
    return apiBadRequest("Invalid origin");
  }

  const [clusterA, clusterB] = x < y ? [x, y] : [y, x];
  const supabase = createServerClient();
  const { error } = await supabase.from("cluster_merge_dismissals").upsert(
    { cluster_a: clusterA, cluster_b: clusterB, origin: b.origin, actor: ACTOR },
    { onConflict: "cluster_a,cluster_b", ignoreDuplicates: true },
  );
  if (error) {
    return apiServerError(error);
  }
  return NextResponse.json({ ok: true }, { status: 200 });
});
