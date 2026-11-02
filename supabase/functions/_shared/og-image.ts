// supabase/functions/_shared/og-image.ts
//
// SSRF-safe og:image extractor for the image-backfill Edge Function. Ported
// from the legacy Node helpers with the audit T3 P1-5 SSRF guard wired in:
// every outbound HTTP fetch goes through
// `safeFetch` (DNS-resolve + RFC1918 / 169.254 / loopback / ULA block +
// manual redirect handling + 50 KB body cap).
//
// Surface mirrors the Node helper one-to-one:
//   - fetchOgImage(url, opts?)              → primary 50 KB <head>-bound path
//   - extractHeroImageFromHtml(html)        → pure extractor (testable)
//   - extractOgImage(html)                  → og:image only, not validated
//   - fetchHeroImage(url, slug, opts?)      → extended-window fetch for the
//                                              three audit-flagged sources
//                                              (haberler-com, trt-haber,
//                                              anadolu-ajansi)
//   - isValidImageUrl(url)                  → favicon/logo/data: filter
//
// Contract:
//   - Never throws. Any SafeFetchError, timeout, parse failure, or oversized
//     body collapses to a null return. The image-consumer treats null as
//     "no image found" and moves on.
//   - All fetches respect a per-request AbortSignal timeout (default 8s).
//   - All fetches are GET-only, follow at most 3 redirects, and reject any
//     hop whose target resolves to a private IP.

import {
  isOptimizableImageUrl,
  isPlaceholderImageUrl,
  normalizeImageUrl,
} from "./image-url.ts";
import { safeFetch, SafeFetchError } from "./safe-fetch.ts";

// hunt-26 security-3: the page is untrusted (any feed-supplied article URL), so
// nothing here may backtrack. The <meta>/<link> image candidates come from a
// tag tokenizer (TAG_START finds a tag name; one monotonic `>` cursor bounds the
// tag) plus a hand-written attribute scanner. There is deliberately no regex
// over attribute text: the former multi-attribute regexes (a whitespace run,
// then an optional lazy attribute gap) cost 1.4-2.9 s on a 1.6 KB page.
const TAG_START = /<(meta|link)(?=\s)/gi;
// A real <meta>/<link> is a few hundred chars; longer is not an image tag.
const MAX_TAG_CHARS = 2_000;
// Starts may overlap (`<meta a=<meta a=...`), so the sum of tag lengths can
// exceed the page. This caps the attribute-scan work for the whole page; a real
// page (non-overlapping tags, <= 200 KB) never gets near it.
const MAX_SCAN_CHARS = 1_000_000;

// JSON-LD gaps are bounded: `[^}]*?` was unbounded and rescanned the rest of the
// page from every `"image":{` start.
const JSONLD_IMAGE_STRING_REGEX = /"image"\s*:\s*"(https?:[^"]+)"/i;
const JSONLD_IMAGE_URL_REGEX =
  /"image"\s*:\s*\{[^}]{0,500}?"url"\s*:\s*"(https?:[^"]+)"/i;
const JSONLD_IMAGE_CONTENTURL_REGEX =
  /"image"\s*:\s*\{[^}]{0,500}?"contentUrl"\s*:\s*"(https?:[^"]+)"/i;

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 50_000;
// Extended-window budget for fetchHeroImage. aa.com.tr's Next.js build places
// og:image meta tags in <body> past the first </head>, so the stock 50 KB
// head-only budget is too tight. 200 KB stays well under the per-invocation
// memory budget.
const HERO_MAX_HTML_BYTES = 200_000;

const HERO_IMAGE_SOURCES = new Set([
  "haberler-com",
  "trt-haber",
  "anadolu-ajansi",
]);

const DEFAULT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; Tayf/1.0; +https://tayf.app)",
  Accept: "text/html",
};

const CH_EQ = 0x3d; // =
const CH_SLASH = 0x2f; // /
const CH_LT = 0x3c; // <
const CH_DQUOTE = 0x22; // "
const CH_SQUOTE = 0x27; // '

/** Same set as the regex `\s` class, so TAG_START and the scanner agree. */
function isBlank(c: number): boolean {
  return (
    c === 0x20 ||
    (c >= 0x09 && c <= 0x0d) ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** ASCII-only lower-casing (`String.prototype.toLowerCase` maps e.g. U+212A). */
function asciiLower(s: string): string {
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c >= 0x41 && c <= 0x5a) break;
    i++;
  }
  if (i === s.length) return s;
  let out = s.slice(0, i);
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 0x41 && c <= 0x5a ? String.fromCharCode(c + 0x20) : s[i];
  }
  return out;
}

/**
 * Attributes of one tag, read from `html[from, to)` (the text between the tag
 * name and the closing `>`). Hand-written scanner, linear in `to - from`, no
 * regex: names are the run up to a blank, `=` or `/`; a value is `"..."`,
 * `'...'` or an unquoted run up to a blank. Names are ASCII-lower-cased and the
 * first occurrence of a name wins. An unterminated quote ends the tag, and so
 * does a `<` where an attribute name would start (a missing `>` must not let
 * one tag swallow the next).
 */
function parseTagAttributes(
  html: string,
  from: number,
  to: number,
): Map<string, string> {
  const attrs = new Map<string, string>();
  let i = from;
  while (i < to) {
    while (i < to && isBlank(html.charCodeAt(i))) i++;
    if (i >= to) break;
    const first = html.charCodeAt(i);
    if (first === CH_LT) break;
    if (first === CH_EQ || first === CH_SLASH) {
      i++;
      continue;
    }
    const nameStart = i;
    while (i < to) {
      const c = html.charCodeAt(i);
      if (isBlank(c) || c === CH_EQ || c === CH_SLASH) break;
      i++;
    }
    const name = asciiLower(html.slice(nameStart, i));

    let j = i;
    while (j < to && isBlank(html.charCodeAt(j))) j++;
    let value = "";
    if (j < to && html.charCodeAt(j) === CH_EQ) {
      j++;
      while (j < to && isBlank(html.charCodeAt(j))) j++;
      if (j < to) {
        const q = html.charCodeAt(j);
        if (q === CH_DQUOTE || q === CH_SQUOTE) {
          let k = j + 1;
          while (k < to && html.charCodeAt(k) !== q) k++;
          if (k >= to) return attrs; // unterminated quote ends the tag
          value = html.slice(j + 1, k);
          j = k + 1;
        } else {
          let k = j;
          while (k < to && !isBlank(html.charCodeAt(k))) k++;
          value = html.slice(j, k);
          j = k;
        }
      }
      i = j;
    }
    if (!attrs.has(name)) attrs.set(name, value);
  }
  return attrs;
}

interface ImageTagCandidates {
  og: string | null;
  twitter: string | null;
  itemprop: string | null;
  imageSrc: string | null;
}

/** An attribute value only counts as a candidate when it is not blank. */
function usable(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

/** `value` equals the lower-case literal `lit`, ignoring ASCII case. */
function isValueIgnoringCase(value: string | undefined, lit: string): boolean {
  return value !== undefined && value.length === lit.length &&
    asciiLower(value) === lit;
}

/**
 * One pass over the <meta>/<link> tags of `html`. Per kind the candidate is the
 * first tag in document order with a non-blank value. With `ogOnly` the pass
 * stops at the first og:image.
 *
 * Cost: TAG_START is linear; `nextGt` only moves forward (`indexOf` runs again
 * only once the cursor is behind the current start, and no `>` at all ends the
 * pass), so the `>` search is O(n) for the whole page; each parsed tag is at
 * most MAX_TAG_CHARS and the total is capped by MAX_SCAN_CHARS.
 */
function scanImageTags(html: string, ogOnly: boolean): ImageTagCandidates {
  const found: ImageTagCandidates = {
    og: null,
    twitter: null,
    itemprop: null,
    imageSrc: null,
  };
  let nextGt = -1;
  let budget = MAX_SCAN_CHARS;
  for (const m of html.matchAll(TAG_START)) {
    const start = m.index ?? 0;
    if (nextGt < start) {
      nextGt = html.indexOf(">", start);
      if (nextGt === -1) break; // no `>` anywhere after this start
    }
    const length = nextGt - start;
    if (length > MAX_TAG_CHARS) continue;
    budget -= length;
    if (budget < 0) break;

    const tagName = m[1] ?? "";
    const attrs = parseTagAttributes(html, start + 1 + tagName.length, nextGt);
    if (asciiLower(tagName) === "meta") {
      const content = attrs.get("content");
      if (!usable(content)) continue;
      if (found.og === null && isValueIgnoringCase(attrs.get("property"), "og:image")) {
        found.og = content;
        if (ogOnly) return found;
      }
      if (
        found.twitter === null &&
        isValueIgnoringCase(attrs.get("name"), "twitter:image")
      ) {
        found.twitter = content;
      }
      if (
        found.itemprop === null &&
        isValueIgnoringCase(attrs.get("itemprop"), "image")
      ) {
        found.itemprop = content;
      }
    } else if (found.imageSrc === null) {
      const href = attrs.get("href");
      if (usable(href) && isValueIgnoringCase(attrs.get("rel"), "image_src")) {
        found.imageSrc = href;
      }
    }
    if (
      found.og !== null && found.twitter !== null &&
      found.itemprop !== null && found.imageSrc !== null
    ) {
      break;
    }
  }
  return found;
}

/**
 * The og:image URL of an HTML blob (normalised, NOT validated: no favicon /
 * placeholder / gif filter), or null. This is what `fetchOgImage` returns and
 * what the early-stop probe of `fetchHeroImage` looks for. Linear in the input.
 */
export function extractOgImage(html: string): string | null {
  if (!html) return null;
  return normalizeImageUrl(scanImageTags(html, true).og);
}

export interface FetchOgImageOptions {
  readonly timeoutMs?: number;
}

/**
 * Validate that a URL looks like a real content image — not a favicon, logo,
 * pixel tracker, spacer, or a data: URI. Same rule set as the Node helper so
 * all three call sites agree.
 *
 * gif-filter (http-1): an animated GIF is rejected too. haber7 and
 * elips-haber advertise a 22.3 MB placeholder GIF that /_next/image passes
 * through unmodified. This is also the image-consumer gate
 * (image-consumer/index.ts), so a GIF returned by `fetchOgImage` is recorded
 * as `not-found` and capped by the existing attempts logic.
 *
 * db-4 ingest half: a publisher logo card or 'son dakika' stand-in
 * (isPlaceholderImageUrl) is rejected too. extractHeroImageFromHtml therefore
 * falls through to twitter:image, itemprop and the other candidates, and the
 * image-consumer gate never stores a placeholder og:image; the consumer counts
 * it as an attempt, so the row parks after 5 and cannot loop.
 */
export function isValidImageUrl(url: unknown): url is string {
  if (!url || typeof url !== "string") return false;
  if (url.length < 10) return false;
  if (url.startsWith("data:")) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  if (/favicon|icon|logo|pixel|tracker|1x1|spacer/i.test(url)) return false;
  if (!isOptimizableImageUrl(url)) return false;
  if (isPlaceholderImageUrl(url)) return false;
  return true;
}

/**
 * Fetch the first 50 KB of an article URL (stopping early at `</head>`) and
 * return the og:image URL, or null if none is advertised. Never throws — any
 * network/timeout/SSRF/parse failure returns null and is silently dropped.
 */
export async function fetchOgImage(
  url: string,
  opts: FetchOgImageOptions = {},
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const result = await safeFetch(url, {
      headers: DEFAULT_HEADERS,
      timeoutMs,
      maxBytes: MAX_HTML_BYTES,
      shouldStopReading: (html) => html.includes("</head>"),
    });
    if (result.status < 200 || result.status >= 300) return null;
    return extractOgImage(result.body);
  } catch (err) {
    // SafeFetchError is the SSRF-policy violation path; AbortError surfaces
    // as a generic Error on timeout. Both collapse to null per the contract.
    if (err instanceof SafeFetchError) return null;
    return null;
  }
}

/**
 * Run the ordered set of hero-image extractors over an HTML blob and return the
 * first match that survives `normalizeImageUrl` and `isValidImageUrl`
 * (returned in its normalised spelling). Exported for unit testing.
 */
export function extractHeroImageFromHtml(html: string): string | null {
  if (!html) return null;
  const tags = scanImageTags(html, false);
  const extractors: Array<() => string | null | undefined> = [
    () => tags.og,
    () => tags.twitter,
    () => tags.itemprop,
    () => tags.imageSrc,
    () => html.match(JSONLD_IMAGE_CONTENTURL_REGEX)?.[1],
    () => html.match(JSONLD_IMAGE_URL_REGEX)?.[1],
    () => html.match(JSONLD_IMAGE_STRING_REGEX)?.[1],
  ];
  for (const extract of extractors) {
    // ingest-hygiene: repair (`https://h//x`, `//host/x`) before validating,
    // and return the repaired value.
    const candidate = normalizeImageUrl(extract());
    if (candidate && isValidImageUrl(candidate)) return candidate;
  }
  return null;
}

const HEAD_CLOSE = "</head>";

/**
 * Early-stop probe for fetchHeroImage: "stop reading once the document head has
 * closed AND an og:image candidate is in the text read so far".
 *
 * safeFetch calls the probe with the WHOLE accumulated body after EVERY network
 * chunk, so a probe that scans the body is quadratic in the number of chunks. A
 * hostile article page (200 KB of overlapping `<meta a<meta a...` groups, which
 * use up the scanner's whole MAX_SCAN_CHARS budget) served in one-segment chunks
 * cost 920 ms of CPU at 1,460 bytes per chunk and 6.7 s at 200 bytes, from ONE
 * article; an image-consumer message holds 20 of them. The probe is therefore
 * amortised, and keeps one closure of state per fetch:
 *
 *   - '</head>' is searched in the new tail only (plus the 6 units that could
 *     complete a marker split across two chunks);
 *   - once the head is closed, the og:image scan runs on the first call and
 *     then only when the text has at least doubled since the previous scan, so
 *     the scans over a body of n units read at most about 2n units in total
 *     (geometric series), and the number of scans is logarithmic in the number
 *     of chunks;
 *   - a positive answer is final.
 *
 * Behaviour matches the stateless probe where it matters: an og:image inside
 * the head (the common case) stops the read at the very chunk that completes
 * '</head>'; one in <body> past the first '</head>' (aa.com.tr) is still picked
 * up, at most about twice as far into the page as before. The probe expects a
 * growing text, as safeFetch passes it; handed a shorter string it starts over.
 */
export function createHeroStopProbe(): (accumulated: string) => boolean {
  let seenLength = 0; // length at the previous call
  let headClosed = false;
  let scannedLength = 0; // length at the last og:image scan; 0 = none yet
  let found = false;
  return (accumulated) => {
    if (found) return true;
    if (accumulated.length < seenLength) {
      seenLength = 0;
      headClosed = false;
      scannedLength = 0;
    }
    if (!headClosed) {
      const from = Math.max(0, seenLength - (HEAD_CLOSE.length - 1));
      headClosed = accumulated.indexOf(HEAD_CLOSE, from) !== -1;
    }
    seenLength = accumulated.length;
    if (!headClosed) return false;
    if (scannedLength !== 0 && accumulated.length < scannedLength * 2) {
      return false;
    }
    scannedLength = accumulated.length;
    found = extractOgImage(accumulated) !== null;
    return found;
  };
}

/**
 * Source-aware hero-image fetcher. For the three audit-flagged slugs this
 * reads the full 200 KB budget (no </head> short-circuit) and runs the
 * extended extractor set. For every other slug it delegates straight to
 * fetchOgImage so existing behaviour is untouched.
 */
export async function fetchHeroImage(
  url: string,
  sourceSlug: string | null | undefined,
  opts: FetchOgImageOptions = {},
): Promise<string | null> {
  if (!sourceSlug || !HERO_IMAGE_SOURCES.has(sourceSlug)) {
    return fetchOgImage(url, opts);
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const result = await safeFetch(url, {
      headers: DEFAULT_HEADERS,
      timeoutMs,
      maxBytes: HERO_MAX_HTML_BYTES,
      // Optimisation: stop once we've seen </head> AND a validating og:image
      // candidate — keeps the common case as fast as fetchOgImage.
      shouldStopReading: createHeroStopProbe(),
    });
    if (result.status < 200 || result.status >= 300) return null;
    return extractHeroImageFromHtml(result.body);
  } catch (err) {
    if (err instanceof SafeFetchError) return null;
    return null;
  }
}
