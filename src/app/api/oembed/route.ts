import { getClusterDetailOrThrow, type ClusterDetail } from "@/lib/clusters/cluster-detail-query";
import { safeEmbedTitle } from "@/lib/embed/embed-html";
import {
  EMBED_DEFAULT_HEIGHT,
  EMBED_DEFAULT_WIDTH,
  EMBED_MAX_HEIGHT,
  EMBED_MAX_WIDTH,
  EMBED_MIN_HEIGHT,
  EMBED_MIN_WIDTH,
  buildIframeSnippet,
  clampEmbedSize,
  parseClusterUrl,
} from "@/lib/embed/embed-snippet";
import { siteUrl } from "@/lib/site-url";

// oEmbed 1.0 (https://oembed.com) provider for Tayf cluster URLs, JSON only.
//
// SSRF: the `url` parameter is only PARSED (parseClusterUrl: https, an
// allowlisted host, no userinfo/port, exactly /cluster/<uuid>) and only the
// extracted uuid is used -- the given URL is never requested, and nothing in
// the response is derived from it except that uuid. The uuid reaches the DB
// through the same cached, 4 s capped reader as the cluster page.
//
// Every response -- including errors -- is JSON with
// `Access-Control-Allow-Origin: *` so a browser-side consumer can read the
// failure too. Status order: 501 (format) -> 400 (url missing) -> 404 (url
// not ours) -> 503 (read failed) -> 404 (no such cluster) -> 200.

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
};

const CACHE_NEGATIVE = "public, s-maxage=300";
const CACHE_OK = "public, s-maxage=3600, stale-while-revalidate=86400";
/** Title when the cluster headline fails the private-individual filter. */
const FALLBACK_TITLE = "Tayf haberi";

function json(body: unknown, status: number, cacheControl: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, "cache-control": cacheControl },
  });
}

export function OPTIONS(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-max-age": "86400",
    },
  });
}

export async function GET(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;

  const format = params.get("format");
  if (format !== null && format !== "json") {
    return json({ error: "Only format=json is supported" }, 501, CACHE_NEGATIVE);
  }

  const url = params.get("url");
  if (!url) return json({ error: "Missing url parameter" }, 400, CACHE_NEGATIVE);

  const origin = siteUrl();
  // The site's own host is accepted too, but only over https (a localhost or
  // plain-http site URL must not widen the allowlist).
  let extraHost: string | null = null;
  try {
    const own = new URL(origin);
    if (own.protocol === "https:") extraHost = own.host;
  } catch {
    extraHost = null;
  }
  const id = parseClusterUrl(url, extraHost);
  if (!id) return json({ error: "Not found" }, 404, CACHE_NEGATIVE);

  let detail: ClusterDetail | null;
  try {
    detail = await getClusterDetailOrThrow(id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[oembed] ${id} failed: ${message}`);
    return json({ error: "Service unavailable" }, 503, "no-store");
  }
  if (!detail) return json({ error: "Not found" }, 404, CACHE_NEGATIVE);

  // A merged-away cluster is embedded as its survivor: the iframe points
  // straight at it instead of at a 308. (No second read: only the parsed
  // uuid ever hits the DB.)
  const targetId = detail.cluster.merged_into ?? id;

  const width = clampEmbedSize(params.get("maxwidth"), EMBED_DEFAULT_WIDTH, EMBED_MIN_WIDTH, EMBED_MAX_WIDTH);
  const height = clampEmbedSize(params.get("maxheight"), EMBED_DEFAULT_HEIGHT, EMBED_MIN_HEIGHT, EMBED_MAX_HEIGHT);
  const html = buildIframeSnippet(origin, targetId, width, height);
  if (!html) return json({ error: "Not found" }, 404, CACHE_NEGATIVE);

  return json(
    {
      version: "1.0",
      type: "rich",
      provider_name: "Tayf",
      provider_url: origin,
      title: safeEmbedTitle(detail.cluster.title_tr, FALLBACK_TITLE),
      html,
      width,
      height,
      cache_age: 3600,
    },
    200,
    CACHE_OK,
  );
}
