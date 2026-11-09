import { NextResponse } from "next/server";

import { buildAlertRss, toV1AlertRecord } from "@/lib/alerts/alert-feed";
import { getAlertItems } from "@/lib/alerts/alert-query";
import { apiBadRequest, apiServerError, withApiErrors } from "@/lib/api/errors";
import {
  apiV1Headers,
  methodNotAllowed,
  requireApiKey,
  withApiV1Headers,
} from "@/lib/api/keys";
import { parseLimit, parseSince } from "@/lib/api/v1-clusters";
import { getZoneFeedHealth } from "@/lib/clusters/feed-health";
import { registryEnvelope } from "@/lib/sources/registry";

/**
 * GET /api/v1/alerts/blindspots — keyed alert feed, JSON or RSS.
 *
 * Two alert types (blindspot, one_zone_silent) defined in
 * src/lib/alerts/alert-query.ts. Auth is the same Bearer-only `requireApiKey`
 * as every v1 route; there is deliberately NO `?key=` parameter (a key in a
 * URL ends up in logs and referrers). RSS is chosen by `?format=rss`, or by
 * an `Accept: application/rss+xml` header when `format` is absent.
 *
 * The JSON envelope always carries `truncated`: true when the one_zone_silent
 * candidate pull hit its row cap, so older alerts of a long `since` window
 * may be missing (see SILENT_CANDIDATE_LIMIT). RSS output has no such field.
 */
export const GET = withApiErrors(async (request: Request) => {
  const auth = await requireApiKey(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);

  const formatRaw = url.searchParams.get("format");
  if (formatRaw !== null && formatRaw !== "json" && formatRaw !== "rss") {
    return withApiV1Headers(apiBadRequest("Invalid format"), auth.tier);
  }
  const sinceResult = parseSince(url.searchParams.get("since"));
  if ("error" in sinceResult) {
    return withApiV1Headers(apiBadRequest(sinceResult.error), auth.tier);
  }
  const limitResult = parseLimit(url.searchParams.get("limit"));
  if (typeof limitResult !== "number") {
    return withApiV1Headers(apiBadRequest(limitResult.error), auth.tier);
  }

  const wantsRss =
    formatRaw === "rss" ||
    (formatRaw === null &&
      (request.headers.get("accept") ?? "").toLowerCase().includes("application/rss+xml"));

  const { since } = sinceResult;

  let alerts;
  let truncated: boolean;
  try {
    const health = await getZoneFeedHealth();
    const result = await getAlertItems({ sinceIso: since, limit: limitResult, health });
    alerts = result.items.map(toV1AlertRecord);
    truncated = result.truncated;
  } catch (err) {
    return withApiV1Headers(apiServerError(err), auth.tier);
  }

  if (wantsRss) {
    return new NextResponse(buildAlertRss(alerts), {
      status: 200,
      headers: {
        ...apiV1Headers(auth.tier),
        "Content-Type": "application/rss+xml; charset=utf-8",
        Vary: "Origin, Authorization, Accept",
      },
    });
  }

  return NextResponse.json(registryEnvelope({ since, count: alerts.length, truncated, alerts }), {
    headers: { ...apiV1Headers(auth.tier), Vary: "Origin, Authorization, Accept" },
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
