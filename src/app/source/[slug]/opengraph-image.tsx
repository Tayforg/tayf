// seo-9: /source/[slug] no longer sets its own openGraph.images, so Next's
// file-convention wiring picks up whichever sibling opengraph-image.tsx it
// finds. Re-exporting the root's generated 1200x630 Tayf card here (rather
// than leaving it to inherit from the nearest ancestor segment) makes that
// deterministic instead of relying on Next's segment-resolution order.
//
// h30-abuse-5: the card does not depend on the slug, so it is the same bytes
// for every source; but the root route sends next/og's default
// `public, max-age=0, must-revalidate`, which makes a shared cache revalidate
// on every request and lets a flood of /source/<anything>/opengraph-image
// URLs each render a PNG. src/middleware.ts now 404s an unknown slug before it
// gets here; for a real one this wrapper sets a day-long shared cache (a week
// of stale-while-revalidate) on the response instead.
import RootImage, { alt, size, contentType } from "../../opengraph-image";

export { alt, size, contentType };

export const SOURCE_OG_CACHE_HEADERS = {
  "cache-control": "public, s-maxage=86400, stale-while-revalidate=604800",
};

export default async function Image() {
  const res = await RootImage();
  res.headers.set("cache-control", SOURCE_OG_CACHE_HEADERS["cache-control"]);
  return res;
}
