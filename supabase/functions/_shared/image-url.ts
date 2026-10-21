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
