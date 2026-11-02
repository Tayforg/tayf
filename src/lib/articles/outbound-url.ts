// Render-time cleanup of the publisher url behind an outbound link
// (hunt 24, h24-feeds-3).
//
// `articles.url` is stored exactly as the feed gave it, and it is the
// on_conflict key of the ingest upsert, so it is NEVER rewritten: changing the
// stored format would re-insert every item still in the feed. Two defects live
// in it, and both are fixed here, in the href the reader gets:
//   - Diken's RSS carries a literal '&#038;' between the query params
//     ("?utm_source=rss&#038;utm_medium=rss"). The browser reads the '#' as the
//     start of a fragment, so the link's query becomes 'utm_source=rss&' and the
//     rest a fragment ('038;utm_medium=rss').
//   - Evrensel (and others) tag every link with utm_* params, which shows up as
//     the publisher's own RSS traffic in their analytics.
//
// Pure string operations, no URL re-serialisation: the path, the surviving
// params (byte for byte) and a real fragment are returned exactly as stored.
// Never throws; a value that is not an http(s) url is returned unchanged, so
// the href safety checks of the callers stay in charge of it.

const ENTITY_AMP = ["&#038;", "&#38;", "&amp;"] as const;

/** A query segment that is tracking, not content: `utm_*`, `fbclid`, `gclid`
 * (the key is the text before the first '=', compared case-insensitively). */
function isTrackingSegment(segment: string): boolean {
  const eq = segment.indexOf("=");
  const key = (eq === -1 ? segment : segment.slice(0, eq)).toLowerCase();
  return key.startsWith("utm_") || key === "fbclid" || key === "gclid";
}

/**
 * The href for an article's stored `url`:
 *   - '&#038;', '&#38;' and '&amp;' in the query become '&';
 *   - empty segments and utm_*, fbclid and gclid params are dropped;
 *   - everything else (path, other params, a real '#fragment') is kept as is;
 *   - a '?' left with no params is removed.
 * A value that is not a string, is not a parseable absolute http(s) url, or has
 * no query is returned unchanged.
 */
export function cleanOutboundUrl(url: string): string {
  if (typeof url !== "string") return url;
  try {
    const protocol = new URL(url).protocol;
    if (protocol !== "http:" && protocol !== "https:") return url;
  } catch {
    return url;
  }

  const q = url.indexOf("?");
  if (q === -1) return url;
  // A '?' after a '#' belongs to the fragment, not to a query.
  const hash = url.indexOf("#");
  if (hash !== -1 && hash < q) return url;

  const prefix = url.slice(0, q);
  let rest = url.slice(q + 1);
  // Decode first: '&#038;' contains a '#', which must not be taken for the
  // start of a fragment.
  for (const entity of ENTITY_AMP) rest = rest.replaceAll(entity, "&");

  const h = rest.indexOf("#");
  const query = h === -1 ? rest : rest.slice(0, h);
  const fragment = h === -1 ? "" : rest.slice(h);

  const kept: string[] = [];
  for (const segment of query.split("&")) {
    if (segment === "" || isTrackingSegment(segment)) continue;
    kept.push(segment);
  }
  return prefix + (kept.length > 0 ? "?" + kept.join("&") : "") + fragment;
}
