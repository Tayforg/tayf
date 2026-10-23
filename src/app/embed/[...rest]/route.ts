import { renderEmbedMessageHtml } from "@/lib/embed/embed-html";

// /embed/<anything that is not cluster/<id>> -- the script-less 404.
//
// Defence in depth: the frame policy in src/lib/security/headers.ts already
// leaves every /embed/... path other than /embed/cluster/:id on the site
// policy, but without this catch-all those paths would fall through to the
// app-wide not-found page, a ~40 KB document with 20 scripts. This handler
// makes sure no HTML other than the widget shell is ever served under /embed/.
// A static segment beats a catch-all, so /embed/cluster/<id> still reaches
// the widget route in ./cluster/[id]/route.ts.
//
// Nothing is exported besides GET (no `dynamic`/`revalidate` under
// cacheComponents; freshness is expressed through Cache-Control).

// Mirrors NOT_FOUND_HEADERS in ../cluster/[id]/route.ts.
const NOT_FOUND_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "public, s-maxage=300",
  "x-robots-tag": "noindex",
};

export async function GET(): Promise<Response> {
  return new Response(renderEmbedMessageHtml("Haber bulunamadı"), {
    status: 404,
    headers: NOT_FOUND_HEADERS,
  });
}
