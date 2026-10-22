// supabase/functions/_shared/image-url.ts
//
// ONE source of truth for "is this a usable image URL, and what is its
// canonical spelling". Pure and import-free so the exact same function runs
// in the Deno Edge Functions (ingest, image-consumer) and in Next (re-exported
// from `src/lib/images/image-url.ts`), which is what lets render-time
// normalisation heal rows already stored with a bad spelling -- no backfill.
//
// Three real-world defects it fixes:
//
//   1. A doubled leading path slash, e.g. haber7's
//      `https://i12.haber7.net//fotogaleri/x.jpg`. The upstream CDN 404s for
//      it behind the Next optimizer, while `/fotogaleri/x.jpg` works.
//   2. Protocol-relative values (`//cdn.example/a.jpg`) that a bare
//      `new URL(...)` rejects and an `<img>` would resolve against the page.
//   3. Two glued Mongo ObjectIds as the last path segment, e.g. posta's
//      `.../0x0/627e113be4bfdc26aca117f5.jpg6acfb319b65de53ef53b8d3c.jpg`
//      (posta, 2026-10-22: 1,231 rows in 7 days). The publisher writes that
//      string itself in the feed's <img src>; the CDN 404s for it. The first
//      id is a constant placeholder asset, the second is the real image, so
//      the last segment is rewritten to `/<second id>.<second ext>`.
//
// Deliberately NOT done: URL re-serialisation. `new URL(u).toString()` would
// lowercase hosts, percent-encode characters and add a trailing slash,
// silently changing keys that other code (credit lookup, dedupe, DB rows)
// compares by string identity. A clean input is returned `===` unchanged.
// Only the LEADING run of slashes in the path is collapsed; a mid-path `//`
// (e.g. `.../resize/1280x720//haber/x.jpg`) is significant to some CDNs and
// is kept, as are the query string and hash, byte for byte.

const LEADING_PATH_SLASHES = /^(https?:\/\/[^\/?#]+)\/{2,}/i;

// `/<24 hex>.<ext><24 hex>.<ext>` as the LAST path segment (anchored with `$`,
// so it is applied to the path only, never to a query or hash).
const JOINED_OBJECT_ID_SEGMENT =
  /\/([0-9a-f]{24})\.(jpe?g|png|webp)([0-9a-f]{24})\.(jpe?g|png|webp)$/i;

// Scheme + authority prefix; a match must start after it so the host is never
// rewritten (`https://<id>.jpg<id>.jpg` has a `/` right before the "first id").
const AUTHORITY_PREFIX = /^(?:[a-z][a-z0-9+.-]*:)?\/\/[^\/]*/i;

/**
 * Heal a URL whose last path segment is two glued Mongo ObjectIds
 * (`/<id1>.<ext1><id2>.<ext2>`, posta) by keeping the SECOND id and extension:
 * `/<id2>.<ext2>`. HEAD-verified 2026-10-22: the joined URL is a 404, `<id1>`
 * is one constant 1,650-byte placeholder image, `<id2>` is the real article
 * image.
 *
 * Only the path (before the first `?` / `#`) is inspected and rewritten; the
 * query and hash are kept byte for byte, the host is never touched, and hex /
 * extension case is preserved. A string that is not that exact shape is
 * returned `===` unchanged. `null` is reserved for a recognised joined shape
 * with no verified-resolvable half; every shape handled today (posta) has one,
 * so the function is currently total.
 */
export function repairJoinedImageSegment(u: string): string | null {
  const cut = u.search(/[?#]/);
  const path = cut === -1 ? u : u.slice(0, cut);
  const m = JOINED_OBJECT_ID_SEGMENT.exec(path);
  if (!m) return u;
  const authorityEnd = AUTHORITY_PREFIX.exec(path)?.[0].length ?? 0;
  if (m.index < authorityEnd) return u;
  const tail = cut === -1 ? "" : u.slice(cut);
  return `${path.slice(0, m.index)}/${m[3]}.${m[4]}${tail}`;
}

export function normalizeImageUrl(u: string | null | undefined): string | null {
  if (typeof u !== "string") return null;
  let s = u.trim();
  if (!s) return null;
  if (s.startsWith("//")) s = "https:" + s;

  let parsed: URL;
  try {
    parsed = new URL(s);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  // Order matters: collapse the leading slashes first so a URL carrying both
  // defects heals in a single call.
  if (LEADING_PATH_SLASHES.test(s)) s = s.replace(LEADING_PATH_SLASHES, "$1/");
  return repairJoinedImageSegment(s);
}

/**
 * Whether `u` may be handed to `next/image` / an `<img>` as a story image.
 *
 * False for an animated GIF (path ending in `.gif`, case-insensitive; the
 * query string and fragment are ignored, so `a.gif?x=1` is out but
 * `img?format=gif` and `a.gifv` are not) and for null / undefined / empty
 * input.
 *
 * Why: haber7 and elips-haber advertise a 22.3 MB animated placeholder GIF
 * as their feed image. `/_next/image` passes animated GIFs through
 * UNMODIFIED (it never re-encodes them), so every card that picks one ships
 * 22 MB to the browser. The filter therefore sits at ingest, at each
 * server-side query boundary (so the URL never reaches the RSC/HTML payload)
 * and in `ClusterCardImage` as defence in depth.
 *
 * Deliberately a pure string check: it does not normalise or parse, so the
 * verdict is the same for `//cdn/a.gif`, `https://h//a.gif` and
 * `https://h/a.gif`.
 */
export function isOptimizableImageUrl(u: string | null | undefined): boolean {
  if (typeof u !== "string") return false;
  const s = u.trim();
  if (!s) return false;
  const path = s.split(/[?#]/, 1)[0] ?? "";
  return !path.toLowerCase().endsWith(".gif");
}
