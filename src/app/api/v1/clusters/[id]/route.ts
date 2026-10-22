import { NextResponse } from "next/server";

import { apiBadRequest, apiError, apiNotFound, apiServerError, withApiErrors } from "@/lib/api/errors";
import {
  apiV1Headers,
  methodNotAllowed,
  requireApiKey,
  withApiV1Headers,
} from "@/lib/api/keys";
import {
  V1_CLUSTER_SELECT,
  fetchTopic7,
  toV1ClusterRecord,
  type V1ClusterRow,
} from "@/lib/api/v1-clusters";
import { createReaderClient } from "@/lib/supabase/server";
import { registryEnvelope } from "@/lib/sources/registry";

// Duplicated locally rather than imported — same pattern every other
// admin/API route in this codebase uses for its own UUID gate (see e.g.
// src/app/api/admin/corrections/[id]/route.ts).
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** GET /api/v1/clusters/[id] — keyed public API, single-cluster read. */
export const GET = withApiErrors(async (request: Request, ctx: RouteContext) => {
  const auth = await requireApiKey(request);
  if (!auth.ok) return auth.response;

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return withApiV1Headers(apiBadRequest("Invalid cluster id"), auth.tier);
  }

  const supabase = createReaderClient();
  const { data, error } = await supabase
    .from("clusters")
    .select(V1_CLUSTER_SELECT)
    .eq("id", id)
    // Archived clusters are excluded from every reader-facing surface;
    // this keyed API is no exception (see politics-query.ts's identical
    // gate on the home feed).
    .eq("is_archived", false)
    .maybeSingle<V1ClusterRow>();

  if (error) return withApiV1Headers(apiServerError(error), auth.tier);
  if (!data) {
    // Miss path only (the hot path above is one query): an archived cluster
    // may have been merged into another (migration 099). A lookup error, e.g.
    // the column not existing yet, stays a plain 404 -- EXCEPT a timeout
    // (the 4 s reader cap aborts with an `AbortError: ...` message): that
    // says nothing about whether the cluster exists, so it is the generic 500,
    // never a 404 a client would cache or act on.
    const { data: mergedRow, error: mergedError } = await supabase
      .from("clusters")
      .select("merged_into")
      .eq("id", id)
      .maybeSingle<{ merged_into: string | null }>();
    if (mergedError?.message.startsWith("AbortError")) {
      return withApiV1Headers(apiServerError(mergedError), auth.tier);
    }
    const mergedInto = mergedError ? null : mergedRow?.merged_into;
    if (typeof mergedInto === "string" && UUID_RE.test(mergedInto)) {
      const target = mergedInto.toLowerCase();
      const res = withApiV1Headers(
        apiError(301, "Cluster merged", { details: { merged_into: target } }),
        auth.tier,
      );
      res.headers.set("Location", `/api/v1/clusters/${target}`);
      return res;
    }
    return withApiV1Headers(apiNotFound("Cluster not found"), auth.tier);
  }

  const topic7Map = await fetchTopic7(supabase, [data.id]);
  const cluster = toV1ClusterRecord(data, topic7Map.get(data.id) ?? null);

  return NextResponse.json(registryEnvelope({ cluster }), {
    headers: apiV1Headers(auth.tier),
  });
});

export const OPTIONS = withApiErrors(async () =>
  new NextResponse(null, { status: 204, headers: apiV1Headers("free") }),
);

// Every other method gets the JSON 405 envelope with an `Allow` header (and
// CORS) rather than Next's bodyless default. HEAD is derived from GET by Next.
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
