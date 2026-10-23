import { getClusterDetailOrThrow, type ClusterDetail } from "@/lib/clusters/cluster-detail-query";
import { buildEmbedModel, renderEmbedHtml, renderEmbedMessageHtml } from "@/lib/embed/embed-html";
import { siteUrl } from "@/lib/site-url";

// /embed/cluster/<uuid> -- the frameable "Yelpaze kutusu". A ROUTE HANDLER
// that returns a complete, script-less HTML document (same precedent as the
// kart and rozet routes): app/layout.tsx always renders Header, Footer,
// KbdShortcuts and Analytics, so a page.tsx here could not be chrome-less.
//
// This is the one place the site may be framed by third parties; the
// relaxed frame policy for exactly /embed/cluster/:id lives in src/lib/security/headers.ts
// (CSP without script-src, `frame-ancestors *`, no X-Frame-Options). No
// cookie is ever set, and nothing is exported besides GET -- no
// `dynamic`/`revalidate` under cacheComponents: freshness is expressed
// through Cache-Control.
//
// The id is validated BEFORE any read so a malformed path never becomes part
// of a cache key. The read is `getClusterDetailOrThrow` (the cluster page's
// own cached, 4 s capped reader): a sustained outage must answer 503, not a
// cacheable 404 that would unpublish a real story from every embedding page.

interface RouteContext {
  params: Promise<{ id: string }>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HTML_TYPE = "text/html; charset=utf-8";
const NOT_FOUND_HEADERS = {
  "content-type": HTML_TYPE,
  "cache-control": "public, s-maxage=300",
  "x-robots-tag": "noindex",
};
const UNAVAILABLE_HEADERS = {
  "content-type": HTML_TYPE,
  "cache-control": "no-store",
  "retry-after": "60",
  "x-robots-tag": "noindex",
};
const OK_HEADERS = {
  "content-type": HTML_TYPE,
  "cache-control": "public, s-maxage=300, stale-while-revalidate=600",
  "x-robots-tag": "noindex",
};

function notFound(): Response {
  return new Response(renderEmbedMessageHtml("Haber bulunamadı"), {
    status: 404,
    headers: NOT_FOUND_HEADERS,
  });
}

export async function GET(_req: Request, { params }: RouteContext): Promise<Response> {
  const { id: rawId } = await params;
  if (!UUID_RE.test(rawId)) return notFound();
  // Lower-case so one cluster is one cache key, however the link was typed.
  const id = rawId.toLowerCase();

  let detail: ClusterDetail | null;
  try {
    detail = await getClusterDetailOrThrow(id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[embed] ${id} failed: ${message}`);
    return new Response(renderEmbedMessageHtml("Şu anda yüklenemiyor"), {
      status: 503,
      headers: UNAVAILABLE_HEADERS,
    });
  }
  if (!detail) return notFound();

  // A merged-away cluster hands its readers to the survivor (relative
  // Location: valid HTTP, and it keeps the embed on whatever host framed it).
  const mergedInto = detail.cluster.merged_into;
  if (mergedInto) {
    return new Response(null, {
      status: 308,
      headers: {
        location: `/embed/cluster/${mergedInto}`,
        "cache-control": "public, s-maxage=300",
      },
    });
  }

  return new Response(renderEmbedHtml(buildEmbedModel(detail, siteUrl())), {
    status: 200,
    headers: OK_HEADERS,
  });
}
