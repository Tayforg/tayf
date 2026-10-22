// supabase/functions/_shared/image-url.ts
//
// ONE source of truth for "is this a usable image URL, and what is its
// canonical spelling". Pure and import-free so the exact same function runs
// in the Deno Edge Functions (ingest, image-consumer) and in Next (re-exported
// from `src/lib/images/image-url.ts`), which is what lets render-time
// normalisation heal rows already stored with a bad spelling -- no backfill.
//
// Two real-world defects it fixes:
//
//   1. A doubled leading path slash, e.g. haber7's
//      `https://i12.haber7.net//fotogaleri/x.jpg`. The upstream CDN 404s for
//      it behind the Next optimizer, while `/fotogaleri/x.jpg` works.
//   2. Protocol-relative values (`//cdn.example/a.jpg`) that a bare
//      `new URL(...)` rejects and an `<img>` would resolve against the page.
//
// Deliberately NOT done: URL re-serialisation. `new URL(u).toString()` would
// lowercase hosts, percent-encode characters and add a trailing slash,
// silently changing keys that other code (credit lookup, dedupe, DB rows)
// compares by string identity. A clean input is returned `===` unchanged.
// Only the LEADING run of slashes in the path is collapsed; a mid-path `//`
// (e.g. `.../resize/1280x720//haber/x.jpg`) is significant to some CDNs and
// is kept, as are the query string and hash, byte for byte.

const LEADING_PATH_SLASHES = /^(https?:\/\/[^\/?#]+)\/{2,}/i;

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

  if (LEADING_PATH_SLASHES.test(s)) return s.replace(LEADING_PATH_SLASHES, "$1/");
  return s;
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
