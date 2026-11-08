// supabase/functions/_shared/rss/host-owner.ts
//
// Which active source owns a link host (h63-clusterintegrity-2).
//
// The ingest upsert is `onConflict: "url"` with `ignoreDuplicates`, so a URL
// belongs to whichever source polls it first. On 2026-11-06 haberler.com's feed
// began to carry the sondakika.com stream: 2,014 rows labelled "Haberler.com"
// linked to sondakika.com within three days, 100 visible clusters showed the
// wrong source, and Son Dakika fell from ~95 items a day to none, with every
// fetch still answering 200. Nothing compared an item's link host with the
// sources before the row was pushed.
//
// These helpers are that comparison, pure and dependency-free:
//
//   * `hostKey`           a URL's comparable host.
//   * `buildHostOwners`   host -> owning source, for hosts claimed by exactly
//                         one active source. A host two sources claim (an
//                         outlet's Turkish and English feeds on one domain) is
//                         left OUT: an ambiguous host never causes a skip.
//   * `foreignHostOwner`  the owner when an item's host belongs to a DIFFERENT
//                         source, else null.
//
// The match is exact on the host (`www.` and a trailing root dot aside). `m.haberler.com` is not
// `haberler.com`: a subdomain is not proof of ownership, and a source that
// publishes on its own subdomains must not lose them.

/** A source reduced to what the host comparison needs. */
export interface HostSource {
  id: string;
  slug: string;
  url?: string | null;
}

/** The source that owns a host. */
export interface HostOwner {
  id: string;
  slug: string;
}

/**
 * The comparable host of an absolute http(s) URL: the lowercase hostname with
 * one leading `www.` and one trailing root dot removed (`sondakika.com.` is the
 * same host as `sondakika.com`: an absolute DNS name). Null for anything else
 * (not a string, empty, unparseable, another scheme, or no host left once the
 * `www.` and the root dot are removed). The port, path, query and userinfo are
 * not part of the host.
 */
export function hostKey(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  const text = url.trim();
  if (text === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  // `URL` already lowercases the hostname; the explicit call keeps the contract
  // independent of the runtime.
  const host = parsed.hostname.toLowerCase();
  // `www.` goes first so a hostname that is only `www.` (or only `.`) leaves no key.
  const noWww = host.startsWith("www.") ? host.slice(4) : host;
  const bare = noWww.endsWith(".") ? noWww.slice(0, -1) : noWww;
  return bare === "" ? null : bare;
}

/**
 * Host -> owning source, holding only hosts claimed by exactly ONE of the given
 * sources. Pass every ACTIVE source, not just the ones fetched this cycle: a
 * quarantined source still owns its host. A source whose url does not parse
 * claims nothing.
 */
export function buildHostOwners(sources: readonly HostSource[]): Map<string, HostOwner> {
  const owners = new Map<string, HostOwner>();
  const ambiguous = new Set<string>();
  for (const source of sources) {
    const host = hostKey(source.url);
    if (host === null) continue;
    if (ambiguous.has(host)) continue;
    if (owners.has(host)) {
      owners.delete(host);
      ambiguous.add(host);
      continue;
    }
    owners.set(host, { id: source.id, slug: source.slug });
  }
  return owners;
}

/**
 * The owner of the item's host when that owner is a DIFFERENT source than
 * `sourceId`; null when the item is on the source's own host, on a host no
 * single source owns, or when the URL does not parse. Exact host match only.
 */
export function foreignHostOwner(
  itemUrl: string | null | undefined,
  sourceId: string,
  owners: ReadonlyMap<string, HostOwner>,
): HostOwner | null {
  if (owners.size === 0) return null;
  const host = hostKey(itemUrl);
  if (host === null) return null;
  const owner = owners.get(host);
  if (owner === undefined || owner.id === sourceId) return null;
  return owner;
}
