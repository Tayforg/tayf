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
// `hasRemoteMatch` over IMAGE_REMOTE_PATTERNS for every generated entry.
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

export interface HttpsRemotePattern {
  protocol: "https";
  hostname: string;
  port: "";
  pathname?: string;
}

const httpsPattern = (hostname: string, pathname?: string): HttpsRemotePattern =>
  pathname === undefined
    ? { protocol: "https", hostname, port: "" }
    : { protocol: "https", hostname, port: "", pathname };

/**
 * Packs generator entries (`**.domain` wildcards and exact hosts) into
 * https-only remote patterns, `groupSize` members per pattern. Wildcards and
 * exact hosts are grouped separately; a one-member group is emitted plain,
 * because picomatch reads a single-item `{x}` as literal braces.
 */
export function packHostPatterns(
  entries: readonly string[],
  groupSize: number,
): HttpsRemotePattern[] {
  const size = Math.max(1, Math.floor(groupSize));
  const wildcards = entries.filter((e) => e.startsWith(WILDCARD_PREFIX)).map((e) => e.slice(3));
  const exact = entries.filter((e) => !e.startsWith(WILDCARD_PREFIX));
  const out: HttpsRemotePattern[] = [];
  for (let i = 0; i < wildcards.length; i += size) {
    const group = wildcards.slice(i, i + size);
    out.push(
      httpsPattern(group.length === 1 ? `**.${group[0]}` : `**.{${group.join(",")}}`),
    );
  }
  for (let i = 0; i < exact.length; i += size) {
    const group = exact.slice(i, i + size);
    out.push(httpsPattern(group.length === 1 ? (group[0] ?? "") : `{${group.join(",")}}`));
  }
  return out;
}

/**
 * `images.remotePatterns` for next.config.ts. https only, no port, and no
 * catch-all: generated hosts (see the header) plus the Google S2 favicon path.
 */
export const IMAGE_REMOTE_PATTERNS = [
  ...packHostPatterns(
    GENERATED_IMAGE_HOSTS,
    Math.ceil(GENERATED_IMAGE_HOSTS.length / MAX_GENERATED_PATTERNS),
  ),
  ...GOOGLE_S2_HOSTS.map((host) => httpsPattern(host, GOOGLE_S2_PATHNAME)),
] satisfies RemotePattern[];

// Precomputed once. `**.x.com` matches any subdomain of x.com, never the apex.
const EXACT_HOSTS: ReadonlySet<string> = new Set(
  GENERATED_IMAGE_HOSTS.filter((e) => !e.startsWith(WILDCARD_PREFIX)),
);
const WILDCARD_SUFFIXES: readonly string[] = GENERATED_IMAGE_HOSTS.filter((e) =>
  e.startsWith(WILDCARD_PREFIX),
).map((e) => e.slice(2)); // keeps the leading dot: ".x.com"
const PATH_RESTRICTED_HOSTS: ReadonlySet<string> = new Set(GOOGLE_S2_HOSTS);

/**
 * True when `/_next/image` is configured to fetch `u`: an https URL on the
 * default port whose host is an exact entry, a subdomain of a `**.` entry, or a
 * Google S2 host with exactly the `/s2/favicons` path. Mirrors Next's matcher
 * (hostname and pathname; the query string is not matched) and never throws.
 */
export function isAllowedRemoteImageUrl(u: string): boolean {
  if (typeof u !== "string") return false;
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
  if (EXACT_HOSTS.has(host)) return true;
  for (const suffix of WILDCARD_SUFFIXES) {
    if (host.length > suffix.length && host.endsWith(suffix)) return true;
  }
  return false;
}
