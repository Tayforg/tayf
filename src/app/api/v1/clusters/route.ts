import { NextResponse } from "next/server";

import { apiBadRequest, apiServerError, withApiErrors } from "@/lib/api/errors";
import {
  apiV1Headers,
  methodNotAllowed,
  requireApiKey,
  withApiV1Headers,
} from "@/lib/api/keys";
import {
  V1_CLUSTER_SELECT,
  decodeV1Cursor,
  encodeV1Cursor,
  isPoliticsMajority,
  parseLimit,
  parseSince,
  toV1ClusterRecord,
  type V1ClusterRow,
  type V1Cursor,
} from "@/lib/api/v1-clusters";
import { createReaderClient } from "@/lib/supabase/server";
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
 *
 * ARTICLE FLOOR: a one-article "cluster" is a single headline, not a
 * comparison, so the candidate query floors `article_count` at 2, the same
 * floor the home feed, timeline, hubs and /hafta apply. Without it singletons
 * took ~70% of the default 150 candidates and the window covered only the
 * newest ~7 h of a 24 h `since`. The floor is part of the query, so paging is
 * unchanged. GET /api/v1/clusters/{id} does not apply it.
 *
 * KEYSET PAGING: candidates are ordered (updated_at desc, id desc) and
 * `?before=<next_cursor>` continues strictly after the cursor row (see
 * v1-clusters.ts). `next_cursor` is:
 *   - the last RETURNED row, when the politics filter left more rows than
 *     `limit` (the unreturned ones are re-scanned by the next page);
 *   - otherwise the last SCANNED candidate, when the scan hit its candidate
 *     limit (the window held fewer politics rows than `limit`, but the table
 *     may hold more behind it);
 *   - otherwise null: the scan reached the end of the data.
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

  // A blank `before` is "no cursor", like a blank `since` or `limit`.
  const beforeRaw = url.searchParams.get("before")?.trim() ?? "";
  let cursor: V1Cursor | null = null;
  if (beforeRaw !== "") {
    cursor = decodeV1Cursor(beforeRaw);
    if (cursor === null) {
      return withApiV1Headers(apiBadRequest("Invalid cursor"), auth.tier);
    }
  }

  const { since } = sinceResult;
  const limit = limitResult;
  const candidateLimit = Math.min(limit * CANDIDATE_MULTIPLIER, CANDIDATE_CAP);

  const supabase = createReaderClient();
  let query = supabase
    .from("clusters")
    .select(V1_CLUSTER_SELECT)
    .eq("is_archived", false)
    .gte("article_count", 2)
    .gte("updated_at", since)
    .order("updated_at", { ascending: false })
    .order("id", { ascending: false });
  if (cursor !== null) {
    // Both values passed decodeV1Cursor's closed shapes (an ISO timestamp and
    // a UUID), so neither can carry quotes, commas or parentheses.
    query = query.or(
      `updated_at.lt."${cursor.u}",and(updated_at.eq."${cursor.u}",id.lt."${cursor.i}")`,
    );
  }
  const { data, error, status } = await query.limit(candidateLimit).returns<V1ClusterRow[]>();

  // `status` rides along so apiServerError can classify a gateway answer
  // (502/503/504) that carries no PostgREST code: a database outage is a 503
  // + Retry-After: 30, any other read error stays the sanitised 500.
  if (error) return withApiV1Headers(apiServerError({ ...error, status }), auth.tier);

  const scanned = data ?? [];
  const politics = scanned.filter(isPoliticsMajority);
  const rows = politics.slice(0, limit);

  let nextCursor: string | null = null;
  if (politics.length > limit) {
    const lastReturned = rows[rows.length - 1]!;
    nextCursor = encodeV1Cursor({ u: lastReturned.updated_at, i: lastReturned.id });
  } else if (scanned.length >= candidateLimit) {
    const lastScanned = scanned[scanned.length - 1]!;
    nextCursor = encodeV1Cursor({ u: lastScanned.updated_at, i: lastScanned.id });
  }

  const clusters = rows.map((r) => toV1ClusterRecord(r));

  return NextResponse.json(
    registryEnvelope({ since, count: clusters.length, next_cursor: nextCursor, clusters }),
    { headers: apiV1Headers(auth.tier) },
  );
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
