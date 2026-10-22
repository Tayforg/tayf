// Render-side image URL helpers.
//
//  - `normalizeImageUrl` is re-exported from the Deno/Next shared module so
//    ingest and render agree on one spelling (precedent: src/lib/bias/config.ts
//    re-exporting supabase/functions/_shared/cluster/*). Applying it at render
//    heals rows already stored as `https://h//x.jpg`, `//cdn/x.jpg` or posta's
//    glued `<id1>.jpg<id2>.jpg` last segment (rewritten to the real second
//    image) -- no backfill.
//  - `isOptimizableImageUrl` is the same shared module's animated-GIF guard
//    (gif-filter / http-1): a 22 MB placeholder GIF passes through
//    /_next/image unmodified, so every render boundary filters with it.
//  - `firstPartyLogoUrl` routes Google S2 favicons through our own image
//    optimizer.
export {
  isOptimizableImageUrl,
  normalizeImageUrl,
} from "../../../supabase/functions/_shared/image-url";

// Widths present in next.config.ts `images.imageSizes`. /_next/image rejects
// any other `w`, and `q=75` is in `images.qualities`.
const LOGO_WIDTHS: ReadonlySet<number> = new Set([32, 48, 64, 96, 128]);
const DEFAULT_LOGO_WIDTH = 64;

/**
 * Source logos are stored as Google S2 favicon URLs
 * (`https://www.google.com/s2/favicons?domain=...&sz=64`). Rendered raw, every
 * visitor's browser hits google.com for ~44 logos on the home page. Routing
 * them through `/_next/image` makes them first-party: fetched once by the
 * optimizer (the 301 to gstatic is within `maximumRedirects`' default of 3),
 * then served from our cache at the requested size. The remotePatterns
 * wildcard in next.config already allows google.com, so no config change.
 *
 * Only an exact google.com / www.google.com host with the exact
 * `/s2/favicons` path is rewritten -- `google.com.evil.tld` and other google
 * paths are returned untouched. Null/empty -> null; an unparseable string is
 * returned as-is.
 */
export function firstPartyLogoUrl(
  u: string | null | undefined,
  width: number = DEFAULT_LOGO_WIDTH,
): string | null {
  if (!u) return null;
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return u;
  }
  const isGoogle =
    parsed.hostname === "www.google.com" || parsed.hostname === "google.com";
  if (!isGoogle || parsed.pathname !== "/s2/favicons") return u;
  const w = LOGO_WIDTHS.has(width) ? width : DEFAULT_LOGO_WIDTH;
  return `/_next/image?url=${encodeURIComponent(u)}&w=${w}&q=75`;
}
