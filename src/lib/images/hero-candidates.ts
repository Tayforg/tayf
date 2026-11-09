// Server-side trim of a story's hero image candidates (h99-clientjs-1).
//
// A story card and the cluster hero hand their image URLs to ClusterCardImage,
// a client component, so every URL passed is serialised into the RSC payload
// of the page. They used to pass EVERY member's image_url: up to 44 on the home
// page, plus a credits map of all of them on /cluster/<id>. ClusterCardImage
// normalises, drops unusable URLs and de-duplicates them again on the client,
// and its fallback chain never walks that far, so most of those bytes could
// never be shown.
//
// `pickHeroCandidates` applies the same three steps as ClusterCardImage, in the
// same order, on the server (normalise, keep only an optimizable URL on the
// /_next/image allowlist, de-duplicate with the first spelling winning) and
// then keeps the first `cap`. The unusable ones are dropped BEFORE the cap, so
// they never take a slot. ClusterCardImage keeps its own filtering as defence
// in depth; on this function's output it is a no-op.
//
// Why 8 and not 4: the mobile banner and the cluster hero both pass
// `minIntrinsicWidth={320}` and skip a candidate that loads narrower than that
// (an outlet shipping a 150x84 og:image), so the chain needs some depth to
// reach a photo that is big enough. Measured on 2026-11-09, capping at 8 saved
// 2.5 KB br9 of the home HTML, 6 saved 3.1 KB, 4 saved 3.8 KB.
//
// A plain module (no 'use client'): Server Components import it, and a function
// imported from a client module would arrive as a client reference.
import { isOptimizableImageUrl, normalizeImageUrl } from "./image-url";
import { isAllowedRemoteImageUrl } from "./remote-image-hosts";

/** How many hero candidates a card or the cluster hero sends to the client. */
export const HERO_CANDIDATE_CAP = 8;

/**
 * The first `cap` usable, distinct, normalised image URLs of `urls`, in input
 * order. Usable means what ClusterCardImage accepts: a URL `normalizeImageUrl`
 * can repair that is not an animated GIF and sits on a host `/_next/image` may
 * fetch. `null`, `undefined`, the empty string and anything unusable are
 * skipped without using a slot. A `cap` of 0 (or below, or NaN) gives `[]`.
 */
export function pickHeroCandidates(
  urls: ReadonlyArray<string | null | undefined>,
  cap: number = HERO_CANDIDATE_CAP,
): string[] {
  const picked: string[] = [];
  if (!(cap > 0)) return picked;
  const seen = new Set<string>();
  for (const url of urls) {
    const normalized = normalizeImageUrl(url);
    if (normalized === null || seen.has(normalized)) continue;
    if (!isOptimizableImageUrl(normalized) || !isAllowedRemoteImageUrl(normalized)) {
      continue;
    }
    seen.add(normalized);
    picked.push(normalized);
    // Stop at the cap rather than normalising a 10,000-member cluster in full.
    if (picked.length >= cap) break;
  }
  return picked;
}
