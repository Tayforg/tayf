// The /_next/image host allowlist (api-1) and its render-side twin.
//
// `/_next/image?url=<anything>` is an open proxy whenever `images.remotePatterns`
// is a catch-all, which is what next.config.ts used to say (`hostname: "**"`
// over https AND http). It now reads IMAGE_REMOTE_PATTERNS from here: an
// https-only list generated from the hosts the site really renders
// (scripts/gen-image-hosts.mjs -> ./remote-image-hosts.data.ts), plus the one
// hand-written, path-restricted Google S2 favicon entry behind every source
// logo.
//
// Two consumers must agree on what is allowed, which is why this file exists
// next to the list instead of inside next.config.ts:
//
//   1. Next's optimizer answers 400 for a URL that matches no pattern.
//   2. next/image THROWS in dev for an unlisted host (shared/lib/image-loader),
//      so a render boundary cannot just hand it an unlisted URL and rely on
//      `onError`. Every boundary filters with `isAllowedRemoteImageUrl` first;
//      an unlisted image then falls through the normal chain (next candidate,
//      logo tier, placeholder; the /source thumbnail's neutral block).
//
// remote-image-hosts.test.ts proves `isAllowedRemoteImageUrl` equals Next's own
// `hasRemoteMatch` over IMAGE_REMOTE_PATTERNS for every generated entry, with
// and without a query string.
//
// Query strings (h30-abuse-4). Next matches `search` too, and a pattern without
// one matches ANY query, so `/_next/image?url=<allowed host>/a.jpg?cb=N` was a
// fresh origin fetch + transform + cache write per N. Every generated group now
// says `search: ""` (no query string at all) except the QUERY_HOSTS families,
// whose images genuinely carry one (resizer URLs such as tmgrup's `?u=<origin>`).
//
// Fragments (h30-abuse-4 follow-up). Next compares `URL.search`, which is "" for
// `#N`, so a fragment passes every pattern above, and the optimizer then hashes
// the URL WITH its fragment into its cache key: `?url=<allowed>/a.jpg%23N` was a
// fresh origin fetch + transform + cache write per N for the same bytes (fetch()
// drops the fragment). remotePatterns cannot express "no hash", so
// src/middleware.ts (gate 10) answers any /_next/image whose `url` contains a
// '#' with a 400, and `isAllowedRemoteImageUrl` refuses a '#' too, which makes
// it the ONE deliberate deviation from Next's matcher: the render side never
// emits a URL the edge would refuse.
//
// Constraints on this file:
//   - RELATIVE imports only: next.config.ts loads it, and the config loader
//     cannot resolve the '@/' alias.
//   - No `node:` imports: it ships to the client (via ClusterCardImage).
//   - Pure data and string logic; nothing here may fetch or log.
//
// Redirects are not re-checked by the optimizer: a listed host that
// open-redirects can still be followed (`images.maximumRedirects` bounds it).
// That is why gstatic.com, the Google S2 301 target, is deliberately NOT listed.
import type { RemotePattern } from "next/dist/shared/lib/image-config";

import { GENERATED_IMAGE_HOSTS } from "./remote-image-hosts.data";

/**
 * Next validates `images.remotePatterns` with `.max(50)` and an error under
 * `images` is fatal (next/dist/server/config-schema.js, server/config.js), so
 * ~170 generated hosts cannot be one pattern each. Members are packed into
 * picomatch brace groups (`**.{a.net,b.com}`), sized so the generated part
 * stays within this many patterns however long the list grows.
 */
const MAX_GENERATED_PATTERNS = 36;

const WILDCARD_PREFIX = "**.";

/** Only this path of the Google S2 favicon service is ever proxied. */
const GOOGLE_S2_PATHNAME = "/s2/favicons";
const GOOGLE_S2_HOSTS = ["www.google.com", "google.com"] as const;

/**
 * Generator-form entries whose images legitimately carry a query string; every
 * other generated host allows NO query at all (see the header). A query URL on
 * any other host is rejected here AND by Next, so a `?cb=N` variant is a 400
 * instead of an origin fetch, and the render side shows its placeholder.
 *
 * Hand-written on purpose: the generated data file is NOT regenerated for this
 * (no host-list churn). Derived from production `articles.image_url`
 * (scripts/gen-image-hosts.mjs --print-sql, statement 3/3), https rows published
 * in the 7 days before 2026-11-04 (62,413 rows, 2,921 = 4.68% with a `?`).
 * Rule: an entry joins when it has n_query >= 3 in the window. Per entry,
 * n = its images, n_query = those with a `?`, share = n_query / n:
 *
 *   **.tmgrup.com.tr                 n 2471  n_query 2140  share 86.6%  (`?u=<origin>` resizer)
 *   **.anlatilaninotesi.com.tr       n  498  n_query  418  share 83.9%
 *   d341l694dl30ad.cloudfront.net    n  293  n_query  293  share 100%
 *   **.indyturk.com                  n  289  n_query   45  share 15.6%
 *   **.sozcucdn.com                  n 1940  n_query   20  share  1.0%  (`?w=..&amp;h=..&mode=crop`)
 *   **.ekonomim.com                  n 1345  n_query    4  share  0.3%
 *
 * Below the rule, so not listed: d2udx5iz3h7s4h.cloudfront.net (no rows in the
 * window; 15 of 15 over 30 days carried a query, last seen 2026-10-18).
 *
 * **.ntv.com.tr is deliberately NOT in the set either, although it is not a
 * small case: 44 of 44 NTV rows in the 30 days to 2026-11-12 carry the resizer
 * query `?width=930&format=webp` (the 7-day window above caught only n 5,
 * n_query 1, because the feed produced rows on 3 of 30 days). The query is
 * dropped by normalizeImageUrl (supabase/functions/_shared/image-url.ts,
 * `dropNtvResizerQuery`), for images.ntv.com.tr only and only when every key is
 * width / height / format / quality, because the file is served without it
 * (HEAD 200 image/jpeg). So NTV is handled by normalisation, not by this set: a
 * `?cb=N` variant on that host stays refused here and by Next (h164-heroimg-2).
 *
 * Re-measure monthly with the runbook in scripts/gen-image-hosts.mjs and update
 * this set (and these numbers). remote-image-hosts.test.ts and
 * tests/guards/image-remote-patterns.test.ts pin that it is a small, non-empty
 * subset of GENERATED_IMAGE_HOSTS.
 */
export const QUERY_HOSTS: ReadonlySet<string> = new Set([
  "**.anlatilaninotesi.com.tr",
  "**.ekonomim.com",
  "**.indyturk.com",
  "**.sozcucdn.com",
  "**.tmgrup.com.tr",
  "d341l694dl30ad.cloudfront.net",
]);

export interface HttpsRemotePattern {
  protocol: "https";
  hostname: string;
  port: "";
  pathname?: string;
  /** `""` = the URL must have no query string. Absent = any query string. */
  search?: "";
}

interface PatternOptions {
  pathname?: string;
  search?: "";
}

const httpsPattern = (hostname: string, opts: PatternOptions = {}): HttpsRemotePattern => ({
  protocol: "https",
  hostname,
  port: "",
  ...(opts.pathname === undefined ? {} : { pathname: opts.pathname }),
  ...(opts.search === undefined ? {} : { search: opts.search }),
});

/** Brace-packs `members` (already stripped of any `**.`) `size` per group. */
function packGroups(
  members: readonly string[],
  size: number,
  wildcard: boolean,
  opts: PatternOptions,
): HttpsRemotePattern[] {
  const out: HttpsRemotePattern[] = [];
  for (let i = 0; i < members.length; i += size) {
    const group = members.slice(i, i + size);
    const prefix = wildcard ? WILDCARD_PREFIX : "";
    out.push(
      httpsPattern(
        group.length === 1 ? `${prefix}${group[0] ?? ""}` : `${prefix}{${group.join(",")}}`,
        opts,
      ),
    );
  }
  return out;
}

/**
 * Packs generator entries (`**.domain` wildcards and exact hosts) into
 * https-only remote patterns, `groupSize` members per pattern. Wildcards and
 * exact hosts are grouped separately; a one-member group is emitted plain,
 * because picomatch reads a single-item `{x}` as literal braces.
 *
 * Every group gets `search: ""` (no query string) except groups made only of
 * `queryHosts` members, which are packed on their own and carry no `search` key
 * (Next then accepts any query). A group never mixes the two kinds.
 */
export function packHostPatterns(
  entries: readonly string[],
  groupSize: number,
  queryHosts: ReadonlySet<string> = new Set(),
): HttpsRemotePattern[] {
  const size = Math.max(1, Math.floor(groupSize));
  const NO_QUERY: PatternOptions = { search: "" };
  const wildcardsOf = (list: readonly string[]) =>
    list.filter((e) => e.startsWith(WILDCARD_PREFIX)).map((e) => e.slice(WILDCARD_PREFIX.length));
  const exactOf = (list: readonly string[]) => list.filter((e) => !e.startsWith(WILDCARD_PREFIX));
  const plain = entries.filter((e) => !queryHosts.has(e));
  const withQuery = entries.filter((e) => queryHosts.has(e));
  return [
    ...packGroups(wildcardsOf(plain), size, true, NO_QUERY),
    ...packGroups(wildcardsOf(withQuery), size, true, {}),
    ...packGroups(exactOf(plain), size, false, NO_QUERY),
    ...packGroups(exactOf(withQuery), size, false, {}),
  ];
}

/**
 * `images.remotePatterns` for next.config.ts. https only, no port, and no
 * catch-all: generated hosts (see the header; no query string except on
 * QUERY_HOSTS) plus the Google S2 favicon path (whose URL IS a query, so it
 * carries no `search`).
 */
export const IMAGE_REMOTE_PATTERNS = [
  ...packHostPatterns(
    GENERATED_IMAGE_HOSTS,
    Math.ceil(GENERATED_IMAGE_HOSTS.length / MAX_GENERATED_PATTERNS),
    QUERY_HOSTS,
  ),
  ...GOOGLE_S2_HOSTS.map((host) => httpsPattern(host, { pathname: GOOGLE_S2_PATHNAME })),
] satisfies RemotePattern[];

// Precomputed once. `**.x.com` matches any subdomain of x.com, never the apex.
const EXACT_HOSTS: ReadonlySet<string> = new Set(
  GENERATED_IMAGE_HOSTS.filter((e) => !e.startsWith(WILDCARD_PREFIX)),
);
const WILDCARD_ENTRIES: readonly { entry: string; suffix: string }[] = GENERATED_IMAGE_HOSTS.filter(
  (e) => e.startsWith(WILDCARD_PREFIX),
).map((entry) => ({ entry, suffix: entry.slice(2) })); // suffix keeps the leading dot: ".x.com"
const PATH_RESTRICTED_HOSTS: ReadonlySet<string> = new Set(GOOGLE_S2_HOSTS);

/**
 * True when `/_next/image` is configured to fetch `u`: an https URL on the
 * default port whose host is an exact entry, a subdomain of a `**.` entry, or a
 * Google S2 host with exactly the `/s2/favicons` path, and which carries no
 * query string unless the entry that matched is in QUERY_HOSTS (the S2 URL is
 * the one exception: its query is the request). Mirrors Next's matcher
 * (hostname, pathname and `search`; an empty `?` has `search === ""`) with one
 * addition: a URL containing '#' is refused, because src/middleware.ts (gate 10)
 * 400s it in front of the optimizer (Next's matcher cannot see a fragment). An
 * encoded `%23` is a path character and stays allowed. Never throws.
 */
export function isAllowedRemoteImageUrl(u: string): boolean {
  if (typeof u !== "string") return false;
  // On the raw string, not `url.hash`: a bare trailing `#` has `hash === ""`, and
  // the edge gate looks for the character.
  if (u.includes("#")) return false;
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port !== "") return false;
  const host = url.hostname;
  // Next's glob refuses a leading dot (`(?!\.)`); an empty host never matches.
  if (host === "" || host.startsWith(".")) return false;
  if (PATH_RESTRICTED_HOSTS.has(host)) return url.pathname === GOOGLE_S2_PATHNAME;
  const hasQuery = url.search !== "";
  // Patterns are OR-ed by Next, so any one matching entry that permits the
  // query is enough (a host that two entries cover is allowed by either).
  if (EXACT_HOSTS.has(host) && (!hasQuery || QUERY_HOSTS.has(host))) return true;
  for (const { entry, suffix } of WILDCARD_ENTRIES) {
    if (
      host.length > suffix.length &&
      host.endsWith(suffix) &&
      (!hasQuery || QUERY_HOSTS.has(entry))
    ) {
      return true;
    }
  }
  return false;
}
