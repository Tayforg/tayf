// Builds the source of the offline-reading service worker served at /sw.js.
//
// Shape of the output: '"use strict";' + 'const CONFIG = <json>;' + a small
// CONTRACT constant + a hand-written plain-JS runtime. Deliberately NOT in the
// output: a build id, a Date, anything from process.env. The bytes only change
// when SW_VERSION, the config or this runtime change, so browsers reinstall
// the worker (and skipWaiting()/clients.claim() fire) only on a real version
// bump -- not on every deploy.
//
// The runtime cannot import sw-policy.ts (it ships as one string), so each
// pure helper is re-declared below as a top-level `function` with the SAME
// name as its twin in sw-policy.ts. tests/pwa/sw-worker.test.ts evaluates this
// source in a node:vm context, where top-level function declarations become
// context globals, and runs both implementations against one case table. Do
// not generate the runtime from fn.toString(): production minification
// rewrites function bodies and the identifiers they close over.
//
// Rules for editing RUNTIME: no backticks, no "${", no URLs (not even in
// comments), no eval, no new Function, no importScripts; ES2017 syntax only
// (no ?. / ??, no optional catch binding), tests/guards/service-worker.test.ts
// enforces the first group. The site CSP doubles as this worker's CSP and
// already allows same-origin fetch.

import { CLUSTER_ID_RE, HEADER_CACHED_AT, HEADER_TITLE } from "./sw-contract";
import {
  COPIED_PAGE_HEADERS,
  FALLBACK_TITLE,
  PAGE_PATH_PATTERN,
  SW_CONFIG,
  TITLE_MAX_CHARS,
  type SwConfig,
} from "./sw-policy";

export interface BuildOptions {
  /** Emit the kill-switch worker: purge every "tayf-" cache and unregister. No fetch handler. */
  kill?: boolean;
  config?: Partial<SwConfig>;
}

/** JSON that is also safe as a JS literal, with every non-ASCII code unit escaped (charset-proof, no U+2028/9 trap). */
function toJs(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

const KILL_RUNTIME = String.raw`
self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (names) {
        return Promise.all(
          names
            .filter(function (name) {
              return name.startsWith(CONFIG.cachePrefix);
            })
            .map(function (name) {
              return caches.delete(name);
            })
        );
      })
      .catch(function () {})
      .then(function () {
        return self.registration.unregister();
      })
  );
});
`;

const RUNTIME = String.raw`
const ID_RE = new RegExp(CONTRACT.idPattern, "i");
const PAGE_RE = new RegExp(CONTRACT.pagePattern, "i");
const ORIGIN = self.location.origin;
const OFFLINE_URL = ORIGIN + CONFIG.offlinePath;

function noop() {}

function parseUrl(url) {
  try {
    return new URL(url);
  } catch (e) {
    return null;
  }
}

function clusterPath(id) {
  return typeof id === "string" && ID_RE.test(id) ? "/cluster/" + id.toLowerCase() : null;
}

function isBypassedPath(pathname) {
  const p = String(pathname).toLowerCase();
  const roots = ["/api", "/embed", "/_vercel"];
  for (let i = 0; i < roots.length; i++) {
    if (p === roots[i] || p.startsWith(roots[i] + "/")) return true;
  }
  if (p.startsWith("/admin")) return true;
  if (p === "/sw.js") return true;
  if ((p === "/_next" || p.startsWith("/_next/")) && !p.startsWith("/_next/static/")) return true;
  return false;
}

function classifyRequest(req, origin) {
  if (req.method !== "GET") return "bypass";
  const u = parseUrl(req.url);
  if (u === null || u.origin !== origin) return "bypass";
  if (isBypassedPath(u.pathname)) return "bypass";
  if (req.hasRange) return "bypass";
  if (req.cache === "only-if-cached" && req.mode !== "same-origin") return "bypass";
  if (u.pathname.startsWith("/_next/static/")) return "static";
  if (req.mode === "navigate") return "navigate";
  return "bypass";
}

function pageCacheKey(url, origin) {
  const u = parseUrl(url);
  if (u === null || u.origin !== origin) return null;
  const m = PAGE_RE.exec(u.pathname);
  if (m === null) return null;
  return origin + "/cluster/" + m[1].toLowerCase();
}

function isCacheableResponse(res, origin, target) {
  if (res.status !== 200) return false;
  if (res.type !== "basic") return false;
  if (res.redirected) return false;
  if (!res.url) return false;
  const u = parseUrl(res.url);
  if (u === null || u.origin !== origin) return false;
  if (res.headers.get("set-cookie") !== null) return false;
  const cacheControl = (res.headers.get("cache-control") || "").toLowerCase();
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  if (target === "static") return cacheControl.indexOf("no-store") === -1;
  if (target === "page") {
    return contentType.indexOf("text/html") === 0 && pageCacheKey(res.url, origin) !== null;
  }
  return contentType.indexOf("text/html") === 0 && u.pathname === CONFIG.offlinePath;
}

function planTrim(keysOldestFirst, maxEntries) {
  if (!(maxEntries >= 0)) return [];
  const overflow = keysOldestFirst.length - maxEntries;
  return overflow > 0 ? keysOldestFirst.slice(0, overflow) : [];
}

function isExpired(cachedAt, nowMs, maxAgeMs) {
  if (cachedAt === null) return true;
  const t = Date.parse(cachedAt);
  if (!Number.isFinite(t)) return true;
  return nowMs - t > maxAgeMs;
}

function cachesToDelete(existing, keep) {
  return existing.filter(function (name) {
    return name.startsWith(CONFIG.cachePrefix) && keep.indexOf(name) === -1;
  });
}

function decodeEntities(s) {
  return s.replace(
    /&(amp|lt|gt|quot|#x27|#39);|&#(\d+);|&#x([0-9a-f]+);/gi,
    function (match, named, dec, hex) {
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
      const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
      if (!(cp > 0) || cp > 1114111 || (cp >= 55296 && cp <= 57343)) return "\ufffd";
      return String.fromCodePoint(cp);
    }
  );
}

function ogContent(html, property) {
  const tags = html.match(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi) || [];
  for (let i = 0; i < tags.length; i++) {
    const re = /\s(property|name|content)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    let prop = null;
    let content = null;
    let m;
    while ((m = re.exec(tags[i])) !== null) {
      const attr = m[1].toLowerCase();
      const value = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : "";
      if (attr === "content") content = value;
      else if (prop === null) prop = value.toLowerCase();
    }
    if (prop === property && content !== null) return content;
  }
  return null;
}

function ogTitle(html) {
  return ogContent(html, "og:title");
}

function isStoryHtml(html) {
  const type = ogContent(html, "og:type");
  return type !== null && type.trim().toLowerCase() === "article";
}

function cleanTitle(raw) {
  let t = decodeEntities(raw).trim();
  t = t.replace(/\s*\u2014\s*Tayf$/, "").trim();
  if (t.length > CONTRACT.titleMaxChars) {
    t = t.slice(0, CONTRACT.titleMaxChars);
    const last = t.charCodeAt(t.length - 1);
    if (last >= 55296 && last <= 56319) t = t.slice(0, -1);
    t = t.trim();
  }
  return t;
}

function extractTitle(html) {
  const og = ogTitle(html);
  if (og !== null) {
    const t = cleanTitle(og);
    if (t !== "") return t;
  }
  const re = /<title\b[^>]*>([\s\S]*?)<\/title>/gi;
  let last = null;
  let m;
  while ((m = re.exec(html)) !== null) last = m[1] !== undefined ? m[1] : "";
  if (last !== null) {
    const t = cleanTitle(last);
    if (t !== "") return t;
  }
  return CONTRACT.fallbackTitle;
}

function extractShellAssets(html, origin, max) {
  const out = [];
  if (!(max > 0)) return out;
  const seen = new Set();
  const re = /(?:src|href)="(\/_next\/static\/[^"#]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const abs = parseUrl(origin + m[1].replace(/&amp;/g, "&"));
    if (abs === null || abs.origin !== origin || !abs.pathname.startsWith("/_next/static/")) continue;
    const url = abs.href;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= max) break;
  }
  return out;
}

function parseMessage(data, maxIds) {
  try {
    if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
    const type = data.type;
    if (type === "tayf:pin" || type === "tayf:unpin") {
      const id = data.id;
      if (typeof id !== "string" || clusterPath(id) === null) return null;
      return { type: type, id: id.toLowerCase() };
    }
    if (type === "tayf:sync") {
      const ids = data.ids;
      if (!Array.isArray(ids)) return null;
      const seen = new Set();
      const valid = [];
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        if (typeof id !== "string" || clusterPath(id) === null) continue;
        const lower = id.toLowerCase();
        if (seen.has(lower)) continue;
        seen.add(lower);
        valid.push(lower);
      }
      return { type: type, ids: maxIds > 0 ? valid.slice(-maxIds) : [] };
    }
    return null;
  } catch (e) {
    return null;
  }
}

function buildStoredHeaders(src, nowIso, title) {
  const out = {};
  for (let i = 0; i < CONTRACT.copiedHeaders.length; i++) {
    const name = CONTRACT.copiedHeaders[i];
    const v = src.get(name);
    if (v !== null && v !== "") out[name] = v;
  }
  out[CONTRACT.headerCachedAt] = nowIso;
  if (title !== undefined) {
    try {
      out[CONTRACT.headerTitle] = encodeURIComponent(title);
    } catch (e) {}
  }
  return out;
}

// ---- runtime glue (no pure-policy twin below this line) ----

function stamp() {
  return new Date().toISOString();
}

function describeRequest(request) {
  return {
    method: request.method,
    url: request.url,
    mode: request.mode,
    cache: request.cache,
    hasRange: request.headers.has("range"),
  };
}

function decodeBody(buf) {
  return new TextDecoder("utf-8").decode(buf);
}

function storedResponse(buf, sourceHeaders, title) {
  return new Response(buf, { status: 200, headers: buildStoredHeaders(sourceHeaders, stamp(), title) });
}

async function trimCache(cache, maxEntries) {
  const keys = await cache.keys();
  const doomed = planTrim(
    keys.map(function (r) {
      return r.url;
    }),
    maxEntries
  );
  await Promise.all(
    doomed.map(function (url) {
      return cache.delete(url);
    })
  );
}

async function offlineFallback() {
  try {
    const shell = await caches.open(CONFIG.caches.shell);
    const hit = await shell.match(OFFLINE_URL, { ignoreVary: true });
    if (hit) return hit;
  } catch (e) {}
  return Response.error();
}

async function matchStatic(url) {
  const names = [CONFIG.caches.static, CONFIG.caches.shell];
  for (let i = 0; i < names.length; i++) {
    const cache = await caches.open(names[i]);
    const hit = await cache.match(url, { ignoreVary: true });
    if (hit) return hit;
  }
  return null;
}

async function storeStatic(url, res) {
  const cache = await caches.open(CONFIG.caches.static);
  await cache.put(url, res);
  await trimCache(cache, CONFIG.staticMaxEntries);
}

async function handleStatic(event) {
  const request = event.request;
  let hit = null;
  try {
    hit = await matchStatic(request.url);
  } catch (e) {
    return fetch(request);
  }
  if (hit) return hit;
  const res = await fetch(request);
  try {
    if (isCacheableResponse(res, ORIGIN, "static")) {
      event.waitUntil(storeStatic(request.url, res.clone()).catch(noop));
    }
  } catch (e) {}
  return res;
}

function settleWithin(promise, ms) {
  return new Promise(function (resolve) {
    const timer = setTimeout(function () {
      resolve({ kind: "timeout" });
    }, ms);
    promise.then(
      function (response) {
        clearTimeout(timer);
        resolve({ kind: "response", response: response });
      },
      function () {
        clearTimeout(timer);
        resolve({ kind: "error" });
      }
    );
  });
}

async function lookupCached(key) {
  try {
    const saved = await caches.open(CONFIG.caches.saved);
    const pinned = await saved.match(key, { ignoreVary: true });
    if (pinned) return pinned;
    const pages = await caches.open(CONFIG.caches.pages);
    const hit = await pages.match(key, { ignoreVary: true });
    if (!hit) return null;
    if (isExpired(hit.headers.get(CONTRACT.headerCachedAt), Date.now(), CONFIG.pagesMaxAgeMs)) {
      await pages.delete(key);
      return null;
    }
    return hit;
  } catch (e) {
    return null;
  }
}

async function storePage(key, res) {
  const buf = await res.arrayBuffer();
  const html = decodeBody(buf);
  // The route answers 200 for its error and not-found shells too, so the status proves nothing:
  // only a real story (og:type article) may be stored, and anything else leaves every copy untouched.
  if (!isStoryHtml(html)) return;
  const saved = await caches.open(CONFIG.caches.saved);
  const pinned = await saved.match(key, { ignoreVary: true });
  if (pinned) {
    await saved.put(key, storedResponse(buf, res.headers, extractTitle(html)));
    return;
  }
  const pages = await caches.open(CONFIG.caches.pages);
  await pages.put(key, storedResponse(buf, res.headers));
  await trimCache(pages, CONFIG.pagesMaxEntries);
}

function startWriteBack(key, res) {
  try {
    if (!isCacheableResponse(res, ORIGIN, "page")) return Promise.resolve();
    return storePage(key, res.clone()).catch(noop);
  } catch (e) {
    return Promise.resolve();
  }
}

async function handleCluster(event, key) {
  let network;
  try {
    network = Promise.resolve(fetch(event.request));
  } catch (e) {
    network = Promise.reject(e);
  }
  event.waitUntil(
    network.then(function (res) {
      return startWriteBack(key, res);
    }, noop)
  );
  const outcome = await settleWithin(network, CONFIG.navTimeoutMs);
  if (outcome.kind === "response") {
    if (outcome.response.status < 500) return outcome.response;
    const cached = await lookupCached(key);
    return cached || outcome.response;
  }
  const cached = await lookupCached(key);
  if (outcome.kind === "error") return cached || offlineFallback();
  if (cached) return cached;
  try {
    return await network;
  } catch (e) {
    return offlineFallback();
  }
}

async function handleNavigate(event) {
  let key = null;
  try {
    key = pageCacheKey(event.request.url, ORIGIN);
  } catch (e) {
    key = null;
  }
  if (key !== null) return handleCluster(event, key);
  try {
    return await fetch(event.request);
  } catch (e) {
    return offlineFallback();
  }
}

async function precacheShell() {
  const res = await fetch(OFFLINE_URL, { cache: "no-cache" });
  if (!isCacheableResponse(res, ORIGIN, "shell")) throw new Error("offline shell is not cacheable");
  const html = await res.text();
  const assets = extractShellAssets(html, ORIGIN, CONFIG.shellMaxAssets);
  const cache = await caches.open(CONFIG.caches.shell);
  await Promise.allSettled(
    assets.map(function (url) {
      return fetch(url).then(function (asset) {
        if (!isCacheableResponse(asset, ORIGIN, "static")) throw new Error("asset is not cacheable");
        return cache.put(url, asset.clone());
      });
    })
  );
  await cache.put(OFFLINE_URL, new Response(html, { status: 200, headers: buildStoredHeaders(res.headers, stamp()) }));
  const keep = new Set(assets);
  keep.add(OFFLINE_URL);
  const keys = await cache.keys();
  await Promise.all(
    keys
      .filter(function (r) {
        return !keep.has(r.url);
      })
      .map(function (r) {
        return cache.delete(r.url);
      })
  );
}

// Failure markers live in their own cache (key = cluster url, value = a cached-at stamp): the saved cache
// is the offline reading list and must hold stories only. Every helper is best effort and never throws.
async function openMeta(create) {
  if (!create && !(await caches.has(CONFIG.caches.meta))) return null;
  return caches.open(CONFIG.caches.meta);
}

async function markMiss(key) {
  try {
    const meta = await openMeta(true);
    const headers = {};
    headers[CONTRACT.headerCachedAt] = stamp();
    await meta.put(key, new Response(null, { status: 200, headers: headers }));
  } catch (e) {}
}

async function clearMiss(key) {
  try {
    const meta = await openMeta(false);
    if (meta !== null) await meta.delete(key);
  } catch (e) {}
}

async function recentlyMissed(key) {
  try {
    const meta = await openMeta(false);
    if (meta === null) return false;
    const hit = await meta.match(key, { ignoreVary: true });
    if (!hit) return false;
    return !isExpired(hit.headers.get(CONTRACT.headerCachedAt), Date.now(), CONFIG.warmRetryMs);
  } catch (e) {
    return false;
  }
}

async function pruneMisses(wanted) {
  try {
    const meta = await openMeta(false);
    if (meta === null) return;
    const marks = await meta.keys();
    for (let i = 0; i < marks.length; i++) {
      if (!wanted.has(marks[i].url)) await meta.delete(marks[i].url);
    }
  } catch (e) {}
}

// Resolves true when a story was stored. A network failure rejects and leaves no marker (offline costs the
// server nothing); any answer that stored nothing (redirect, 404, 5xx, error or not-found shell) is marked so
// sync does not render that cluster again on every page load.
async function pinCluster(id) {
  const path = clusterPath(id);
  if (path === null) return false;
  const key = pageCacheKey(ORIGIN + path, ORIGIN);
  if (key === null) return false;
  const init = { credentials: "same-origin", headers: { accept: "text/html" } };
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    init.signal = AbortSignal.timeout(CONFIG.pinTimeoutMs);
  }
  const res = await fetch(key, init);
  let stored = false;
  if (isCacheableResponse(res, ORIGIN, "page")) {
    const buf = await res.arrayBuffer();
    const html = decodeBody(buf);
    if (isStoryHtml(html)) {
      const saved = await caches.open(CONFIG.caches.saved);
      await saved.put(key, storedResponse(buf, res.headers, extractTitle(html)));
      await trimCache(saved, CONFIG.savedMaxEntries);
      stored = true;
    }
  }
  if (stored) await clearMiss(key);
  else await markMiss(key);
  return stored;
}

async function unpinCluster(id) {
  const path = clusterPath(id);
  if (path === null) return;
  const saved = await caches.open(CONFIG.caches.saved);
  await saved.delete(ORIGIN + path);
  await clearMiss(ORIGIN + path);
}

async function syncSaved(allIds) {
  // Ids arrive oldest bookmark first. Only the newest savedMaxEntries are kept offline: a longer wanted set
  // can never fit, and each warm would evict an older copy that the next sync then warms again.
  const ids = CONFIG.savedMaxEntries > 0 ? allIds.slice(-CONFIG.savedMaxEntries) : [];
  const saved = await caches.open(CONFIG.caches.saved);
  const wanted = new Set();
  for (let i = 0; i < ids.length; i++) {
    const path = clusterPath(ids[i]);
    if (path !== null) wanted.add(ORIGIN + path);
  }
  const have = new Set();
  const existing = await saved.keys();
  for (let i = 0; i < existing.length; i++) {
    const url = existing[i].url;
    if (wanted.has(url)) have.add(url);
    else await saved.delete(url);
  }
  await pruneMisses(wanted);
  // One at a time and capped: each warm renders a cluster page on the server. Newest bookmark first, and an id
  // that failed recently is skipped without using a slot, so dead ids cannot starve the live ones.
  let attempts = 0;
  for (let i = ids.length - 1; i >= 0 && attempts < CONFIG.syncWarmMax; i--) {
    const path = clusterPath(ids[i]);
    if (path === null || have.has(ORIGIN + path)) continue;
    if (await recentlyMissed(ORIGIN + path)) continue;
    attempts++;
    try {
      await pinCluster(ids[i]);
    } catch (e) {}
  }
  try {
    const shell = await caches.open(CONFIG.caches.shell);
    const entry = await shell.match(OFFLINE_URL, { ignoreVary: true });
    if (!entry || isExpired(entry.headers.get(CONTRACT.headerCachedAt), Date.now(), CONFIG.shellMaxAgeMs)) {
      await precacheShell();
    }
  } catch (e) {}
}

async function handleMessage(msg) {
  if (msg === null) return;
  if (msg.type === "tayf:pin") return pinCluster(msg.id);
  if (msg.type === "tayf:unpin") return unpinCluster(msg.id);
  if (msg.type === "tayf:sync") return syncSaved(msg.ids);
}

self.addEventListener("install", function (event) {
  event.waitUntil(
    precacheShell().then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    (async function () {
      try {
        const doomed = cachesToDelete(await caches.keys(), Object.values(CONFIG.caches));
        await Promise.all(
          doomed.map(function (name) {
            return caches.delete(name);
          })
        );
      } catch (e) {}
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", function (event) {
  let kind = "bypass";
  try {
    kind = classifyRequest(describeRequest(event.request), ORIGIN);
  } catch (e) {
    return;
  }
  if (kind === "bypass") return;
  event.respondWith(kind === "static" ? handleStatic(event) : handleNavigate(event));
});

self.addEventListener("message", function (event) {
  let msg = null;
  try {
    msg = parseMessage(event.data, CONFIG.syncMaxIds);
  } catch (e) {
    msg = null;
  }
  if (msg === null) return;
  event.waitUntil(handleMessage(msg).catch(noop));
});
`;

export function buildServiceWorkerSource(opts: BuildOptions = {}): string {
  const config: SwConfig = { ...SW_CONFIG, ...opts.config };

  if (opts.kill) {
    const killConfig = { version: config.version, cachePrefix: config.cachePrefix };
    return `"use strict";\nconst CONFIG = ${toJs(killConfig)};\n${KILL_RUNTIME}`;
  }

  const contract = {
    headerCachedAt: HEADER_CACHED_AT,
    headerTitle: HEADER_TITLE,
    copiedHeaders: [...COPIED_PAGE_HEADERS],
    idPattern: CLUSTER_ID_RE.source,
    pagePattern: PAGE_PATH_PATTERN,
    fallbackTitle: FALLBACK_TITLE,
    titleMaxChars: TITLE_MAX_CHARS,
  };
  return `"use strict";\nconst CONFIG = ${toJs(config)};\nconst CONTRACT = ${toJs(contract)};\n${RUNTIME}`;
}
