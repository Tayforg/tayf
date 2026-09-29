import { NextResponse } from "next/server";

import { buildAlertRss, toV1AlertRecord } from "@/lib/alerts/alert-feed";
import { getAlertItems } from "@/lib/alerts/alert-query";
import { apiBadRequest, apiServerError, withApiErrors } from "@/lib/api/errors";
import { apiV1Headers, requireApiKey, withApiV1Headers } from "@/lib/api/keys";
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
  try {
    const health = await getZoneFeedHealth();
    const items = await getAlertItems({ sinceIso: since, limit: limitResult, health });
    alerts = items.map(toV1AlertRecord);
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

  return NextResponse.json(registryEnvelope({ since, count: alerts.length, alerts }), {
    headers: { ...apiV1Headers(auth.tier), Vary: "Origin, Authorization, Accept" },
  });
});

export const OPTIONS = withApiErrors(async () =>
  new NextResponse(null, { status: 204, headers: apiV1Headers("free") }),
);
