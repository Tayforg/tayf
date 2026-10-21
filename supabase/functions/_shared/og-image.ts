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
//   - extractHeroImageFromHtml(html)        → pure regex extractor (testable)
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

import { normalizeImageUrl } from "./image-url.ts";
import { safeFetch, SafeFetchError } from "./safe-fetch.ts";

const OG_IMAGE_REGEX =
  /<meta\s+(?:[^>]*?\s+)?property=["']og:image["']\s+content=["']([^"']+)["']/i;
const OG_IMAGE_REGEX_ALT =
  /content=["']([^"']+)["']\s+(?:[^>]*?\s+)?property=["']og:image["']/i;

const TWITTER_IMAGE_REGEX =
  /<meta\s+(?:[^>]*?\s+)?name=["']twitter:image["']\s+content=["']([^"']+)["']/i;
const TWITTER_IMAGE_REGEX_ALT =
  /content=["']([^"']+)["']\s+(?:[^>]*?\s+)?name=["']twitter:image["']/i;
const ITEMPROP_IMAGE_REGEX =
  /<meta\s+(?:[^>]*?\s+)?itemprop=["']image["']\s+content=["']([^"']+)["']/i;
const LINK_IMAGE_SRC_REGEX =
  /<link\s+(?:[^>]*?\s+)?rel=["']image_src["']\s+href=["']([^"']+)["']/i;
const JSONLD_IMAGE_STRING_REGEX = /"image"\s*:\s*"(https?:[^"]+)"/i;
const JSONLD_IMAGE_URL_REGEX =
  /"image"\s*:\s*\{[^}]*?"url"\s*:\s*"(https?:[^"]+)"/i;
const JSONLD_IMAGE_CONTENTURL_REGEX =
  /"image"\s*:\s*\{[^}]*?"contentUrl"\s*:\s*"(https?:[^"]+)"/i;

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

export interface FetchOgImageOptions {
  readonly timeoutMs?: number;
}

/**
 * Validate that a URL looks like a real content image — not a favicon, logo,
 * pixel tracker, spacer, or a data: URI. Same rule set as the Node helper so
 * all three call sites agree.
 */
export function isValidImageUrl(url: unknown): url is string {
  if (!url || typeof url !== "string") return false;
  if (url.length < 10) return false;
  if (url.startsWith("data:")) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  if (/favicon|icon|logo|pixel|tracker|1x1|spacer/i.test(url)) return false;
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
    const match = result.body.match(OG_IMAGE_REGEX) ||
      result.body.match(OG_IMAGE_REGEX_ALT);
    return match?.[1] ? normalizeImageUrl(match[1]) : null;
  } catch (err) {
    // SafeFetchError is the SSRF-policy violation path; AbortError surfaces
    // as a generic Error on timeout. Both collapse to null per the contract.
    if (err instanceof SafeFetchError) return null;
    return null;
  }
}

/**
 * Run the ordered set of hero-image regexes over an HTML blob and return the
 * first match that survives `normalizeImageUrl` and `isValidImageUrl`
 * (returned in its normalised spelling). Exported for unit testing.
 */
export function extractHeroImageFromHtml(html: string): string | null {
  if (!html) return null;
  const extractors: Array<(h: string) => string | undefined> = [
    (h) => h.match(OG_IMAGE_REGEX)?.[1] ?? h.match(OG_IMAGE_REGEX_ALT)?.[1],
    (h) =>
      h.match(TWITTER_IMAGE_REGEX)?.[1] ??
        h.match(TWITTER_IMAGE_REGEX_ALT)?.[1],
    (h) => h.match(ITEMPROP_IMAGE_REGEX)?.[1],
    (h) => h.match(LINK_IMAGE_SRC_REGEX)?.[1],
    (h) => h.match(JSONLD_IMAGE_CONTENTURL_REGEX)?.[1],
    (h) => h.match(JSONLD_IMAGE_URL_REGEX)?.[1],
    (h) => h.match(JSONLD_IMAGE_STRING_REGEX)?.[1],
  ];
  for (const extract of extractors) {
    // ingest-hygiene: repair (`https://h//x`, `//host/x`) before validating,
    // and return the repaired value.
    const candidate = normalizeImageUrl(extract(html));
    if (candidate && isValidImageUrl(candidate)) return candidate;
  }
  return null;
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
      shouldStopReading: (html) => {
        if (!html.includes("</head>")) return false;
        return OG_IMAGE_REGEX.test(html) || OG_IMAGE_REGEX_ALT.test(html);
      },
    });
    if (result.status < 200 || result.status >= 300) return null;
    return extractHeroImageFromHtml(result.body);
  } catch (err) {
    if (err instanceof SafeFetchError) return null;
    return null;
  }
}
