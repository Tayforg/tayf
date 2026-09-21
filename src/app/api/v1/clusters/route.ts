import { NextResponse } from "next/server";

import { apiBadRequest, apiServerError, withApiErrors } from "@/lib/api/errors";
import { apiV1Headers, requireApiKey, withApiV1Headers } from "@/lib/api/keys";
import {
  V1_CLUSTER_SELECT,
  fetchTopic7,
  isPoliticsMajority,
  parseLimit,
  parseSince,
  toV1ClusterRecord,
  type V1ClusterRow,
} from "@/lib/api/v1-clusters";
import { createServerClient } from "@/lib/supabase/server";
import { registryEnvelope } from "@/lib/sources/registry";

/**
 * GET /api/v1/clusters — keyed public API, cluster list.
 *
 * Candidate-row discipline mirrors src/lib/clusters/politics-query.ts's
 * CANDIDATE_LIMIT: we cannot filter the >=60% politics-majority rule in
 * PostgREST (it needs the joined member rows), so we over-fetch
 * `limit * 3` candidates (capped at 300) ordered by recency, filter in
 * JS, then slice to the caller's requested `limit`. Never an unbounded
 * scan.
 */
const CANDIDATE_MULTIPLIER = 3;
const CANDIDATE_CAP = 300;

export const GET = withApiErrors(async (request: Request) => {
  const auth = await requireApiKey(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const sinceResult = parseSince(url.searchParams.get("since"));
  if ("error" in sinceResult) {
    return withApiV1Headers(apiBadRequest(sinceResult.error), auth.tier);
  }
  const limitResult = parseLimit(url.searchParams.get("limit"));
  if (typeof limitResult !== "number") {
    return withApiV1Headers(apiBadRequest(limitResult.error), auth.tier);
  }

  const { since } = sinceResult;
  const limit = limitResult;
  const candidateLimit = Math.min(limit * CANDIDATE_MULTIPLIER, CANDIDATE_CAP);

  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("clusters")
    .select(V1_CLUSTER_SELECT)
    .eq("is_archived", false)
    .gte("updated_at", since)
    .order("updated_at", { ascending: false })
    .limit(candidateLimit)
    .returns<V1ClusterRow[]>();

  if (error) return withApiV1Headers(apiServerError(error), auth.tier);

  const rows = (data ?? []).filter(isPoliticsMajority).slice(0, limit);
  const topic7Map = await fetchTopic7(supabase, rows.map((r) => r.id));
  const clusters = rows.map((r) => toV1ClusterRecord(r, topic7Map.get(r.id) ?? null));

  return NextResponse.json(
    registryEnvelope({ since, count: clusters.length, clusters }),
    { headers: apiV1Headers(auth.tier) },
  );
});

export const OPTIONS = withApiErrors(async () =>
  new NextResponse(null, { status: 204, headers: apiV1Headers("free") }),
);
