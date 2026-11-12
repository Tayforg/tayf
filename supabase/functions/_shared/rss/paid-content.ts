// supabase/functions/_shared/rss/paid-content.ts
//
// Paid advertorials and press releases are not news (h148-sources-1).
//
// Publishers put sponsored pieces in their normal RSS feeds under a url section:
// `/advertorial/` (Posta, CNN Türk, Dünya, Türkiye Gazetesi) and
// `/tanitim-bulteni/` (Halk TV). They were stored as stories: a Dünya advertorial
// matched the alias 'garanti bbva' and showed on /ekonomi/GARAN as Garanti BBVA
// news, and a Halk TV press release headed /source/halk-tv's 'Son haberler' for
// weeks because that feed is quarantined and the item never aged out.
//
// Pure and import-free, so it loads under Deno and vitest alike, and the Next
// read filters re-use it (re-exported from `src/lib/finance/ticker-relevance.ts`).
// The check PARSES the url and compares WHOLE path segments, the first or the
// second one: `/tr/advertorial/x` is paid, `/haber/advertorial-ajansi-kuruldu-1`
// (a segment that merely starts with the name), a query or fragment mention, a
// host label and a third-or-deeper segment are not. Never a substring or a regex
// over the raw url (CodeQL js/incomplete-url-substring-sanitization, js/redos).

/**
 * Url path sections that mark paid content. Lowercase and bare: a path segment
 * is lowercased (and percent-decoded) before it is compared with these.
 */
export const PAID_CONTENT_SEGMENTS = ["advertorial", "tanitim-bulteni"] as const;

/** How many leading path segments are looked at: the first and the second. */
const PAID_CONTENT_SEGMENT_DEPTH = 2;

/** `decodeURIComponent` that keeps the raw part when it is malformed ('%', '%E0%A4%A'). */
function decodeSegment(part: string): string {
  if (!part.includes("%")) return part;
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

function isPaidSegment(rawPart: string): boolean {
  const part = decodeSegment(rawPart).toLowerCase();
  for (const segment of PAID_CONTENT_SEGMENTS) {
    if (part === segment) return true;
  }
  return false;
}

/**
 * True when `url` parses as an absolute http(s) url and one of the first two
 * non-empty parts of its path is exactly a `PAID_CONTENT_SEGMENTS` entry
 * (case-insensitive, after a safe percent-decode). False for anything else,
 * including a non-string, an unparseable value (no scheme, a relative or
 * protocol-relative path, free text, the empty string) and any other scheme.
 * The host, query, fragment and userinfo are not part of the path.
 *
 * Linear in the path: it stops after the second non-empty part, and empty
 * parts (a trailing or doubled slash) are skipped without being counted.
 */
export function isPaidContentUrl(url: unknown): boolean {
  if (typeof url !== "string") return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

  const path = parsed.pathname;
  let seen = 0;
  let start = 0;
  while (start <= path.length && seen < PAID_CONTENT_SEGMENT_DEPTH) {
    let end = path.indexOf("/", start);
    if (end === -1) end = path.length;
    if (end > start) {
      if (isPaidSegment(path.slice(start, end))) return true;
      seen++;
    }
    start = end + 1;
  }
  return false;
}
