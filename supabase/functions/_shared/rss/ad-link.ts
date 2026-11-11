// supabase/functions/_shared/rss/ad-link.ts
//
// Ad click-tracker links are not stories (h130-feeds-2).
//
// On 2026-11-11 Habertürk's feed carried
// `https://pubads.g.doubleclick.net/gampad/clk?id=...&iu=/31903365` as an item.
// It was stored as a normal "Son haberler" card on /source/haberturk, and every
// reader click on it registered a paid ad click. Nothing inspected an item's link
// host: the foreign-host filter (host-owner.ts) only knows the hosts of
// registered active sources.
//
// Pure and import-free, so it loads under Deno and vitest alike. Every check
// PARSES the url and compares the hostname: exactly, or as a subdomain at a '.'
// boundary. Never a substring or a regex over the raw url (a lookalike such as
// `doubleclick.net.example.com` or `notdoubleclick.net` must not match, and an ad
// host in a path, query or userinfo must not match either: CodeQL
// js/incomplete-url-substring-sanitization, js/incomplete-hostname-regexp).

/**
 * Hosts whose links are ad click-trackers or paid-content widgets, never news.
 * A link on one of these hosts or on any subdomain of one is dropped at
 * ingest (`isAdClickLink`).
 */
export const AD_CLICK_HOSTS = [
  "doubleclick.net",
  "googleadservices.com",
  "googlesyndication.com",
  "adnxs.com",
  "taboola.com",
  "outbrain.com",
] as const;

/**
 * True when `url` parses as an http(s) url and its hostname (lowercased, with
 * ONE trailing root dot removed) equals a host of `AD_CLICK_HOSTS` or ends with
 * '.' + one of them. False for anything else, including a non-string, an
 * unparseable value (no scheme, protocol-relative, free text) and any other
 * scheme. The port, path, query, fragment and userinfo are not part of the host.
 */
export function isAdClickLink(url: string): boolean {
  if (typeof url !== "string") return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  // `URL` already lowercases the hostname; the explicit call keeps the contract
  // independent of the runtime.
  let host = parsed.hostname.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  for (const adHost of AD_CLICK_HOSTS) {
    if (host === adHost || host.endsWith("." + adHost)) return true;
  }
  return false;
}

/**
 * LOG-ONLY companion of `isAdClickLink`: is an item's host off its source's
 * home? Ingest counts these per source so staging hosts (Bloomberg HT's
 * `bbstagedesktop.ciner.com.tr`) and video hosts (`youtu.be`) become visible
 * before any rule is set; nothing is dropped on this answer.
 *
 * All three hosts are comparable host keys (`hostKey` of host-owner.ts: lowercase,
 * one leading `www.` and one trailing root dot removed). An item is NOT off-host
 * when its host is the source's own host or a subdomain of it ('.' boundary),
 * or is exactly the host of a registered source (`registeredHosts`; a subdomain
 * of a registered host is not proof of ownership, the same rule as host-owner.ts).
 * A null `itemHost` (an unreadable url) is not off-host: there is nothing to say.
 */
export function isOffHostItem(
  itemHost: string | null,
  ownHost: string,
  registeredHosts: ReadonlySet<string>,
): boolean {
  if (itemHost === null) return false;
  if (itemHost === ownHost || itemHost.endsWith("." + ownHost)) return false;
  return !registeredHosts.has(itemHost);
}
