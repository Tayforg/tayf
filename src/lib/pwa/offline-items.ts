// Reads the stories the service worker saved for offline reading
// (cache "tayf-saved-v1", one entry per bookmarked cluster). Client-safe; used
// by the /offline page. Total: any cache error degrades to an empty list.
import { CACHE_NAMES, HEADER_CACHED_AT, HEADER_TITLE, clusterPath } from "./sw-contract";

export interface OfflineItem {
  id: string;
  href: string;
  title: string;
  /** When the worker stored the copy; null when the stamp is missing or unparseable. */
  cachedAt: string | null;
}

export interface HeadersLike {
  get(name: string): string | null;
}

export interface CacheLike {
  keys(): Promise<ReadonlyArray<Request>>;
  match(request: Request): Promise<{ headers: HeadersLike } | undefined>;
}

export interface CacheStorageLike {
  has(name: string): Promise<boolean>;
  open(name: string): Promise<CacheLike>;
}

const FALLBACK_TITLE = "Kaydedilen hikâye";
const MAX_TITLE_CHARS = 200;
const CLUSTER_PATH_RE = /^\/cluster\/([^/]+)$/;

function decodeTitle(header: string | null): string {
  if (!header) return FALLBACK_TITLE;
  let decoded: string;
  try {
    decoded = decodeURIComponent(header);
  } catch {
    return FALLBACK_TITLE;
  }
  // Array.from counts code points, so the cap never splits a surrogate pair.
  const capped = Array.from(decoded.trim()).slice(0, MAX_TITLE_CHARS).join("").trim();
  return capped === "" ? FALLBACK_TITLE : capped;
}

/** Maps one saved cache entry to a list item; null for anything that is not /cluster/<uuid>. */
export function toOfflineItem(url: string, headers: HeadersLike): OfflineItem | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const segment = CLUSTER_PATH_RE.exec(pathname)?.[1];
  if (segment === undefined) return null;
  const href = clusterPath(segment);
  if (href === null) return null;

  const stamp = headers.get(HEADER_CACHED_AT);
  return {
    id: segment.toLowerCase(),
    href,
    title: decodeTitle(headers.get(HEADER_TITLE)),
    cachedAt: stamp !== null && !Number.isNaN(Date.parse(stamp)) ? stamp : null,
  };
}

/** Newest copy first, undated copies last; ties keep their input order. */
export function sortOfflineItems(items: readonly OfflineItem[]): OfflineItem[] {
  const time = (item: OfflineItem) => (item.cachedAt === null ? null : Date.parse(item.cachedAt));
  return [...items].sort((a, b) => {
    const ta = time(a);
    const tb = time(b);
    if (ta === tb) return 0;
    if (ta === null) return 1;
    if (tb === null) return -1;
    return tb - ta;
  });
}

/**
 * `null` = this browser has no Cache Storage (unsupported). `[]` = nothing saved
 * (or the cache could not be read). Uses `has` so merely visiting /offline never
 * creates the cache.
 */
export async function readOfflineItems(
  cs: CacheStorageLike | undefined,
): Promise<OfflineItem[] | null> {
  if (cs === undefined) return null;
  try {
    if (!(await cs.has(CACHE_NAMES.saved))) return [];
    const cache = await cs.open(CACHE_NAMES.saved);
    const requests = await cache.keys();
    const found = await Promise.all(
      requests.map(async (request) => {
        const response = await cache.match(request);
        return response ? toOfflineItem(request.url, response.headers) : null;
      }),
    );
    return sortOfflineItems(found.filter((item): item is OfflineItem => item !== null));
  } catch {
    return [];
  }
}
