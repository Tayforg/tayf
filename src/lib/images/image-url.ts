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
//  - `isPlaceholderImageUrl` (db-4) is the same module's publisher-logo /
//    'son dakika' stand-in check: such a URL is never a hero, card or thumb.
//  - `firstPartyLogoUrl` routes Google S2 favicons through our own image
//    optimizer.
//  - `optimizedThumbUrl` / `optimizedThumbSrcSet` (perf-2) do the same for
//    article thumbnails that are rendered with a plain `<img>`.
import {
  isOptimizableImageUrl,
  isPlaceholderImageUrl,
  normalizeImageUrl,
} from "../../../supabase/functions/_shared/image-url";

export { isOptimizableImageUrl, isPlaceholderImageUrl, normalizeImageUrl };

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

/**
 * Mirrors next.config.ts `images.imageSizes`; /_next/image rejects any other
 * `w` with a 400. A parity test reads next.config.ts, so the two cannot drift.
 */
export const OPTIMIZER_IMAGE_SIZES = [32, 48, 64, 96, 128, 160, 256, 320] as const;

/** 1x / 2x / 3x of the 80 px /source thumbnail slot. */
export const THUMB_WIDTHS = [128, 160, 256] as const;

const THUMB_QUALITY = 75;

/**
 * `/_next/image` URL for an article thumbnail at one optimizer width, or null
 * when the image must not be rendered: `width` is not in OPTIMIZER_IMAGE_SIZES,
 * or the URL is unusable (not absolute http(s)), an animated GIF, or a
 * publisher placeholder.
 *
 * The string is exactly what `next/image`'s default loader builds
 * (`url=<encoded src>&w=<width>&q=75`), so a plain `<img>` using it shares the
 * optimizer's cache with every `<Image>` on the site. The source is
 * normalised first, so a stored `https://h//x.jpg` or `//cdn/x.jpg` resolves.
 */
export function optimizedThumbUrl(
  u: string | null | undefined,
  width: number,
): string | null {
  if (!(OPTIMIZER_IMAGE_SIZES as readonly number[]).includes(width)) return null;
  const normalized = normalizeImageUrl(u);
  if (normalized === null) return null;
  if (!isOptimizableImageUrl(normalized) || isPlaceholderImageUrl(normalized)) return null;
  return `/_next/image?url=${encodeURIComponent(normalized)}&w=${width}&q=${THUMB_QUALITY}`;
}

/**
 * `src` (the smallest width) and `srcSet` (`<url> 128w, <url> 160w, <url> 256w`)
 * for an `<img>` thumbnail, or null under the same rules as `optimizedThumbUrl`.
 * Pair it with a `sizes` that matches the slot.
 */
export function optimizedThumbSrcSet(
  u: string | null | undefined,
): { src: string; srcSet: string } | null {
  const urls: string[] = [];
  for (const w of THUMB_WIDTHS) {
    const url = optimizedThumbUrl(u, w);
    if (url === null) return null;
    urls.push(url);
  }
  const src = urls[0];
  if (src === undefined) return null;
  const srcSet = urls.map((url, i) => `${url} ${THUMB_WIDTHS[i]}w`).join(", ");
  return { src, srcSet };
}
