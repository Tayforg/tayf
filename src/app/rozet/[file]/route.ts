import { getClusterDetailOrThrow } from "@/lib/clusters/cluster-detail-query";
import { zoneCountsOf } from "@/lib/bias/zone-summary";
import { renderSpectrumBadgeSvg } from "@/lib/cards/badge-svg";

// /rozet/<uuid>.svg — embeddable "Yelpaze rozeti". `file` is parsed by a
// fully anchored regex plus a strict UUID check before any DB access (same
// parse-guard idea as sitemaps/[file]). The SVG carries only counts and
// fixed strings, never cluster titles or outlet names.
//
// "Not found" and "unavailable" are different answers: the throwing reader
// resolves null only for an absent cluster (a 404 shared caches may keep for
// 5 minutes) and REJECTS on a sustained database outage (a 503 that is never
// cached, so the badge heals the moment the database does).

interface RouteContext {
  params: Promise<{ file: string }>;
}

const FILE_RE = /^([0-9a-f-]{36})\.svg$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const NOT_FOUND_HEADERS = { "cache-control": "public, s-maxage=300" };
const UNAVAILABLE_HEADERS = { "cache-control": "no-store", "retry-after": "60" };
const OK_HEADERS = {
  "content-type": "image/svg+xml; charset=utf-8",
  "cache-control": "public, s-maxage=600, stale-while-revalidate=86400",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
  "x-robots-tag": "noindex",
};

export async function GET(_req: Request, { params }: RouteContext): Promise<Response> {
  const { file } = await params;
  const id = FILE_RE.exec(file)?.[1];
  if (!id || !UUID_RE.test(id)) {
    return new Response("Not found", { status: 404, headers: NOT_FOUND_HEADERS });
  }

  let detail: Awaited<ReturnType<typeof getClusterDetailOrThrow>>;
  try {
    detail = await getClusterDetailOrThrow(id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[rozet] ${id} failed: ${message}`);
    return new Response("Service unavailable", { status: 503, headers: UNAVAILABLE_HEADERS });
  }
  if (!detail) {
    return new Response("Not found", { status: 404, headers: NOT_FOUND_HEADERS });
  }

  const svg = renderSpectrumBadgeSvg({
    zones: zoneCountsOf(detail.cluster.bias_distribution),
    sourceCount: detail.wire.effectiveArticleCount,
  });
  return new Response(svg, { status: 200, headers: OK_HEADERS });
}
