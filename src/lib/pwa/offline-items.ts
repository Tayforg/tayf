// Reads the stories the service worker saved for offline reading
// (cache "tayf-saved-v1", one entry per bookmarked cluster). Client-safe; used
// by the /offline page and the cluster error boundary. Total: any cache error
// degrades to an empty list / no copy.
import {
  CACHE_NAMES,
  HEADER_CACHED_AT,
  HEADER_TITLE,
  STORED_COPY_PARAM,
  clusterPath,
} from "./sw-contract";
import { SW_CONFIG, isExpired } from "./sw-policy";

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
  match(request: Request | string): Promise<{ headers: HeadersLike } | undefined>;
}

export interface CacheStorageLike {
  has(name: string): Promise<boolean>;
  open(name: string): Promise<CacheLike>;
}

/** The one write the page makes into Cache Storage: a put of a prepared Response. */
export interface PutCacheLike {
  put(request: Request | string, response: Response): Promise<void>;
}

export interface PutCacheStorageLike {
  open(name: string): Promise<PutCacheLike>;
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

  return {
    id: segment.toLowerCase(),
    href,
    title: decodeTitle(headers.get(HEADER_TITLE)),
    cachedAt: parseableStamp(headers.get(HEADER_CACHED_AT)),
  };
}

/** The worker's cached-at stamp when it parses as a date, else null. */
function parseableStamp(stamp: string | null): string | null {
  return stamp !== null && !Number.isNaN(Date.parse(stamp)) ? stamp : null;
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

export interface StoredCopy {
  /** Same-origin link the service worker answers from Cache Storage: /cluster/<id>?kopya=1. */
  href: string;
  /** When the worker stored the copy; null when the stamp is missing or unparseable. */
  cachedAt: string | null;
}

/**
 * The copy of one story this device could show right now, or null. Mirrors the worker's own lookup (saved copy
 * first, never expiring; then a pages copy, only inside the 14-day window), so a link is only offered when the
 * worker will actually serve it. Both caches are asked for with `has` before either is opened, so this never
 * creates one; any cache error, an invalid id or a missing CacheStorage is simply "no copy".
 */
export async function findStoredCopy(
  cs: CacheStorageLike | undefined,
  origin: string,
  clusterId: string,
  nowMs: number,
): Promise<StoredCopy | null> {
  if (cs === undefined) return null;
  const path = clusterPath(clusterId);
  if (path === null) return null;
  try {
    const hasSaved = await cs.has(CACHE_NAMES.saved);
    const hasPages = await cs.has(CACHE_NAMES.pages);
    const key = origin + path;
    const lookups = [
      { name: CACHE_NAMES.saved, exists: hasSaved, expires: false },
      { name: CACHE_NAMES.pages, exists: hasPages, expires: true },
    ];
    for (const { name, exists, expires } of lookups) {
      if (!exists) continue;
      const hit = await (await cs.open(name)).match(key);
      if (!hit) continue;
      const stamp = hit.headers.get(HEADER_CACHED_AT);
      if (expires && isExpired(stamp, nowMs, SW_CONFIG.pagesMaxAgeMs)) continue;
      return { href: `${path}?${STORED_COPY_PARAM}=1`, cachedAt: parseableStamp(stamp) };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Leaves the one-shot "the reader clicked Kayıtlı kopyayı aç" mark the worker looks for before it answers
 * /cluster/<id>?kopya=1 from storage (key = the normalized cluster url, value = empty body + a cached-at stamp).
 * Only code on this origin can write it, which is the point: another site cannot unlock the stored-first answer,
 * and a reload (no mark any more) takes the normal network-first path. Never throws; with no CacheStorage or an
 * invalid id it does nothing, and a failed write simply means the worker answers network-first.
 */
export async function markStoredCopyOpen(
  cs: PutCacheStorageLike | undefined,
  origin: string,
  clusterId: string,
  nowMs: number,
): Promise<void> {
  if (cs === undefined) return;
  const path = clusterPath(clusterId);
  if (path === null) return;
  try {
    await (
      await cs.open(CACHE_NAMES.openCopy)
    ).put(
      origin + path,
      new Response(null, { status: 200, headers: { [HEADER_CACHED_AT]: new Date(nowMs).toISOString() } }),
    );
  } catch {
    // best effort: without the mark the worker answers network-first, which is always safe
  }
}
