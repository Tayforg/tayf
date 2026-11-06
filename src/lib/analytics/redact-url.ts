// h53-privacy-1: keep reader-typed text out of Vercel Web Analytics.
//
// The analytics script builds every beacon url (pageview and custom event) from
// location.href. It clears the query only when the registered path differs from
// the pathname, and the Next wrapper registers the pathname alone, so
// /?q=Ahmet%20Y%C4%B1lmaz went to Vercel verbatim, as did the follow keywords
// on /takip. The script posts whatever url `beforeSend` returns, so this is the
// one place to fix it.
//
// Allowlist, not deny-list: a new free-text parameter (a filter, a name, a
// query) is redacted by default. Only the utm_* attribution params survive, so
// share and embed links still show where a visit came from.
//
// Total on purpose. The fragment is always dropped. A url that does not parse
// (relative, malformed) is cut at the first "?" or "#" instead of passing the
// query through. Pure, regex-free, no imports (bundled into the browser).

/** Query parameters that may reach Web Analytics: attribution only, never free text. */
export const ANALYTICS_QUERY_ALLOWLIST = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
] as const;

const ALLOWED: ReadonlySet<string> = new Set(ANALYTICS_QUERY_ALLOWLIST);

/** The string up to (not including) its first "?" or "#". */
function cutAtQueryOrHash(url: string): string {
  const query = url.indexOf("?");
  const hash = url.indexOf("#");
  const cut = query === -1 ? hash : hash === -1 ? query : Math.min(query, hash);
  return cut === -1 ? url : url.slice(0, cut);
}

/**
 * Returns `url` with the hash removed and every query parameter dropped except
 * the allowlisted utm_* ones. Never throws; on a parse failure the query and
 * hash are cut off.
 */
export function redactAnalyticsUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const kept: Array<[string, string]> = [];
    for (const [key, value] of parsed.searchParams) {
      if (ALLOWED.has(key)) kept.push([key, value]);
    }
    parsed.search = "";
    for (const [key, value] of kept) parsed.searchParams.append(key, value);
    parsed.hash = "";
    parsed.pathname = redactCapabilityPath(parsed.pathname);
    return parsed.href;
  } catch {
    return redactCapabilityPath(cutAtQueryOrHash(url));
  }
}

// /rapor/<32-hex> (src/app/rapor/[token]/page.tsx) is a capability URL: the
// token is the only credential, so the segment after /rapor/ never leaves the
// browser in a beacon, whatever it looks like. One literal plus one negated
// class, nothing nested: linear in the input.
const RAPOR_TOKEN_SEGMENT = /\/rapor\/[^/?#]+/;

function redactCapabilityPath(path: string): string {
  return path.replace(RAPOR_TOKEN_SEGMENT, "/rapor/[token]");
}

/**
 * `beforeSend` step: the same event with a redacted `url`. An event without a
 * string `url` comes back untouched, and so does one whose url needs no change
 * (identity, not a copy). The event it was given is never mutated.
 */
export function redactAnalyticsEvent<E>(event: E): E {
  if (typeof event !== "object" || event === null) return event;
  const url = (event as { url?: unknown }).url;
  if (typeof url !== "string") return event;
  const redacted = redactAnalyticsUrl(url);
  return redacted === url ? event : { ...event, url: redacted };
}
