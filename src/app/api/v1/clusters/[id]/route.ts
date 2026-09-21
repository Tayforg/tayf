import { NextResponse } from "next/server";

import { apiBadRequest, apiNotFound, apiServerError, withApiErrors } from "@/lib/api/errors";
import { apiV1Headers, requireApiKey, withApiV1Headers } from "@/lib/api/keys";
import {
  V1_CLUSTER_SELECT,
  fetchTopic7,
  toV1ClusterRecord,
  type V1ClusterRow,
} from "@/lib/api/v1-clusters";
import { createServerClient } from "@/lib/supabase/server";
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

  const supabase = createServerClient();
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
  if (!data) return withApiV1Headers(apiNotFound("Cluster not found"), auth.tier);

  const topic7Map = await fetchTopic7(supabase, [data.id]);
  const cluster = toV1ClusterRecord(data, topic7Map.get(data.id) ?? null);

  return NextResponse.json(registryEnvelope({ cluster }), {
    headers: apiV1Headers(auth.tier),
  });
});

export const OPTIONS = withApiErrors(async () =>
  new NextResponse(null, { status: 204, headers: apiV1Headers("free") }),
);
