// Canonical, pure caching rules for the offline-reading service worker.
//
// No DOM / ServiceWorker globals: every function here takes plain data, so it
// is unit-testable in Node. The worker itself (sw-source.ts) cannot import
// this module -- it ships as a plain-JS string served from /sw.js -- so the
// runtime there re-declares each helper under the SAME name, and
// tests/pwa/sw-worker.test.ts runs both implementations against one case
// table (parity). Change a rule here and the parity test fails until the
// runtime string is changed to match.
//
// Cache policy in one paragraph: HTML is cached ONLY for an explicit
// allowlist (/cluster/<uuid> and the /offline shell). Next 16 PPR stamps
// "private, no-cache, no-store" on every dynamic response, cluster pages
// included, so honouring no-store for HTML would make offline reading a
// no-op; those two targets are public, first-party and cookie-free, and the
// copy lives on the reader's own device (not a shared cache), so no-store is
// tolerated for them. /_next/static responses with no-store are still
// rejected. Everything else (status, type, redirect, origin, Set-Cookie)
// applies to every target.
//
// A 200 is not proof of a story: PPR flushes the status before the page body
// runs, so the cluster route also answers 200 for its error and not-found
// shells. Anything written to a cache must additionally pass isStoryHtml.

import {
  CACHE_NAMES,
  CACHE_PREFIX,
  HEADER_CACHED_AT,
  HEADER_TITLE,
  OFFLINE_PATH,
  SW_URL,
  SW_VERSION,
  SYNC_MAX_IDS,
  clusterPath,
  type SwMessage,
} from "./sw-contract";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface SwConfig {
  version: string;
  caches: typeof CACHE_NAMES;
  cachePrefix: string;
  offlinePath: string;
  swUrl: string;
  navTimeoutMs: number;
  pinTimeoutMs: number;
  pagesMaxEntries: number;
  pagesMaxAgeMs: number;
  staticMaxEntries: number;
  savedMaxEntries: number;
  shellMaxAssets: number;
  shellMaxAgeMs: number;
  syncWarmMax: number;
  /** A pin that stored nothing is not retried by sync for this long (failure marker in the meta cache). */
  warmRetryMs: number;
  syncMaxIds: number;
}

export const SW_CONFIG: SwConfig = {
  version: SW_VERSION,
  caches: CACHE_NAMES,
  cachePrefix: CACHE_PREFIX,
  offlinePath: OFFLINE_PATH,
  swUrl: SW_URL,
  navTimeoutMs: 3000,
  pinTimeoutMs: 10000,
  pagesMaxEntries: 60,
  pagesMaxAgeMs: 14 * DAY_MS,
  staticMaxEntries: 300,
  savedMaxEntries: 100,
  shellMaxAssets: 60,
  shellMaxAgeMs: 7 * DAY_MS,
  syncWarmMax: 3,
  warmRetryMs: 12 * HOUR_MS,
  syncMaxIds: SYNC_MAX_IDS,
};

/** Shown when a saved page has no usable title. */
export const FALLBACK_TITLE = "Kaydedilen hik\u00e2ye";

/** Longest title we store (characters, after trimming). */
export const TITLE_MAX_CHARS = 200;

/** Source of the allowlisted page pattern: /cluster/<uuid> with an optional trailing slash. */
export const PAGE_PATH_PATTERN =
  "^/cluster/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/?$";

/** Response headers kept on a cached page. CSP is kept on purpose: never serve a CSP-less document. */
export const COPIED_PAGE_HEADERS = [
  "content-type",
  "content-security-policy",
  "x-frame-options",
  "x-content-type-options",
  "referrer-policy",
  "permissions-policy",
] as const;

export type RequestKind = "bypass" | "navigate" | "static";
export type CacheTarget = "static" | "page" | "shell";

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** True for paths the worker must never touch (no respondWith, no cache). */
export function isBypassedPath(pathname: string): boolean {
  const p = String(pathname).toLowerCase();
  for (const root of ["/api", "/embed", "/_vercel"]) {
    if (p === root || p.startsWith(root + "/")) return true;
  }
  if (p.startsWith("/admin")) return true;
  if (p === "/sw.js") return true;
  if ((p === "/_next" || p.startsWith("/_next/")) && !p.startsWith("/_next/static/")) return true;
  return false;
}

export function classifyRequest(
  req: { method: string; url: string; mode: string; cache?: string; hasRange?: boolean },
  origin: string,
): RequestKind {
  if (req.method !== "GET") return "bypass";
  const u = parseUrl(req.url);
  if (u === null || u.origin !== origin) return "bypass";
  if (isBypassedPath(u.pathname)) return "bypass";
  if (req.hasRange) return "bypass";
  if (req.cache === "only-if-cached" && req.mode !== "same-origin") return "bypass";
  if (u.pathname.startsWith("/_next/static/")) return "static";
  if (req.mode === "navigate") return "navigate";
  // RSC ?_rsc fetches, /_next/image, other hosts' fonts and analytics never get respondWith.
  return "bypass";
}

/** Cache key for an allowlisted page: query and hash dropped, id lower-cased. Null when not allowlisted. */
export function pageCacheKey(url: string, origin: string): string | null {
  const u = parseUrl(url);
  if (u === null || u.origin !== origin) return null;
  const m = new RegExp(PAGE_PATH_PATTERN, "i").exec(u.pathname);
  if (m === null) return null;
  return origin + "/cluster/" + (m[1] as string).toLowerCase();
}

export function isCacheableResponse(
  res: {
    status: number;
    type: string;
    redirected: boolean;
    url: string;
    headers: { get(n: string): string | null };
  },
  origin: string,
  target: CacheTarget,
): boolean {
  if (res.status !== 200) return false;
  if (res.type !== "basic") return false;
  if (res.redirected) return false;
  if (!res.url) return false;
  const u = parseUrl(res.url);
  if (u === null || u.origin !== origin) return false;
  // Browsers hide Set-Cookie from scripts (it is a forbidden response header),
  // so in a real worker this is always null; it is meaningful in Node tests.
  if (res.headers.get("set-cookie") !== null) return false;
  const cacheControl = (res.headers.get("cache-control") ?? "").toLowerCase();
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  if (target === "static") return !cacheControl.includes("no-store");
  if (target === "page") {
    return contentType.startsWith("text/html") && pageCacheKey(res.url, origin) !== null;
  }
  return contentType.startsWith("text/html") && u.pathname === OFFLINE_PATH;
}

/** Keys to delete so at most maxEntries remain: the oldest overflow. */
export function planTrim(keysOldestFirst: readonly string[], maxEntries: number): string[] {
  if (!(maxEntries >= 0)) return [];
  const overflow = keysOldestFirst.length - maxEntries;
  return overflow > 0 ? keysOldestFirst.slice(0, overflow) : [];
}

/** A missing or unparseable stamp counts as expired. Exactly maxAgeMs old is still fresh. */
export function isExpired(cachedAt: string | null, nowMs: number, maxAgeMs: number): boolean {
  if (cachedAt === null) return true;
  const t = Date.parse(cachedAt);
  if (!Number.isFinite(t)) return true;
  return nowMs - t > maxAgeMs;
}

/** Cache names this worker owns (CACHE_PREFIX) and no longer needs. Foreign caches are never listed. */
export function cachesToDelete(existing: readonly string[], keep: readonly string[]): string[] {
  return existing.filter((name) => name.startsWith(CACHE_PREFIX) && !keep.includes(name));
}

// One pass, so "&amp;lt;" decodes to the text "&lt;" and never to "<".
function decodeEntities(s: string): string {
  return s.replace(
    /&(amp|lt|gt|quot|#x27|#39);|&#(\d+);|&#x([0-9a-f]+);/gi,
    (_match: string, named?: string, dec?: string, hex?: string) => {
      if (named !== undefined) {
        switch (named.toLowerCase()) {
          case "amp":
            return "&";
          case "lt":
            return "<";
          case "gt":
            return ">";
          case "quot":
            return '"';
          default:
            return "'";
        }
      }
      const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex as string, 16);
      if (!(cp > 0) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "\ufffd";
      return String.fromCodePoint(cp);
    },
  );
}

const META_TAG_RE = /<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const ATTR_RE = /\s(property|name|content)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const TITLE_TAG_RE = /<title\b[^>]*>([\s\S]*?)<\/title>/gi;

/** Content of the first <meta> whose property/name is `property` (attribute order and quote style agnostic). */
function ogContent(html: string, property: string): string | null {
  for (const tag of html.match(META_TAG_RE) ?? []) {
    let prop: string | null = null;
    let content: string | null = null;
    for (const m of tag.matchAll(ATTR_RE)) {
      const attr = (m[1] as string).toLowerCase();
      const value = m[2] ?? m[3] ?? "";
      if (attr === "content") content = value;
      else if (prop === null) prop = value.toLowerCase();
    }
    if (prop === property && content !== null) return content;
  }
  return null;
}

function ogTitle(html: string): string | null {
  return ogContent(html, "og:title");
}

/**
 * True when a cluster response body is a real story. The cluster route answers HTTP 200 for failures too
 * (PPR has flushed the status before the page body runs): ./error.tsx on a read failure and the notFound() /
 * permanentRedirect() shells for a missing or merged cluster. Only generateMetadata's success path sets
 * og:type=article; every shell inherits the layout's og:type=website. Storing a shell would overwrite a good
 * saved copy, so every write requires this positive signal.
 */
export function isStoryHtml(html: string): boolean {
  const type = ogContent(html, "og:type");
  return type !== null && type.trim().toLowerCase() === "article";
}

function cleanTitle(raw: string): string {
  let t = decodeEntities(raw).trim();
  t = t.replace(/\s*\u2014\s*Tayf$/, "").trim();
  if (t.length > TITLE_MAX_CHARS) {
    t = t.slice(0, TITLE_MAX_CHARS);
    const last = t.charCodeAt(t.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) t = t.slice(0, -1);
    t = t.trim();
  }
  return t;
}

/** Story title from a rendered page: og:title, else the LAST <title> (streamed metadata lands in the body). */
export function extractTitle(html: string): string {
  const og = ogTitle(html);
  if (og !== null) {
    const t = cleanTitle(og);
    if (t !== "") return t;
  }
  let last: string | null = null;
  for (const m of html.matchAll(TITLE_TAG_RE)) last = m[1] ?? "";
  if (last !== null) {
    const t = cleanTitle(last);
    if (t !== "") return t;
  }
  return FALLBACK_TITLE;
}

/** Same-origin /_next/static asset URLs referenced by a page, absolute, query kept (skew-protection ?dpl=). */
export function extractShellAssets(html: string, origin: string, max: number): string[] {
  const out: string[] = [];
  if (!(max > 0)) return out;
  const seen = new Set<string>();
  const re = /(?:src|href)="(\/_next\/static\/[^"#]+)"/g;
  for (const m of html.matchAll(re)) {
    const abs = parseUrl(origin + (m[1] as string).replace(/&amp;/g, "&"));
    // `new URL` collapses "..": reject anything that stops being a same-origin static asset.
    if (abs === null || abs.origin !== origin || !abs.pathname.startsWith("/_next/static/")) continue;
    const url = abs.href;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= max) break;
  }
  return out;
}

/** Validates a page -> worker message. The worker builds URLs itself from the id and never trusts a URL. */
export function parseMessage(data: unknown, maxIds: number): SwMessage | null {
  try {
    if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
    const d = data as Record<string, unknown>;
    const type = d.type;
    if (type === "tayf:pin" || type === "tayf:unpin") {
      const id = d.id;
      if (typeof id !== "string" || clusterPath(id) === null) return null;
      return { type, id: id.toLowerCase() };
    }
    if (type === "tayf:sync") {
      const ids = d.ids;
      if (!Array.isArray(ids)) return null;
      const seen = new Set<string>();
      const valid: string[] = [];
      for (const id of ids) {
        if (typeof id !== "string" || clusterPath(id) === null) continue;
        const lower = id.toLowerCase();
        if (seen.has(lower)) continue;
        seen.add(lower);
        valid.push(lower);
      }
      return { type, ids: maxIds > 0 ? valid.slice(-maxIds) : [] };
    }
    return null;
  } catch {
    return null;
  }
}

/** Headers for a page we store: a fixed allowlist, so Content-Encoding/Length, Vary and Set-Cookie never leak in. */
export function buildStoredHeaders(
  src: { get(n: string): string | null },
  nowIso: string,
  title?: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of COPIED_PAGE_HEADERS) {
    const v = src.get(name);
    if (v !== null && v !== "") out[name] = v;
  }
  out[HEADER_CACHED_AT] = nowIso;
  if (title !== undefined) {
    try {
      out[HEADER_TITLE] = encodeURIComponent(title);
    } catch {
      // A lone surrogate makes encodeURIComponent throw; a title-less entry is fine.
    }
  }
  return out;
}
